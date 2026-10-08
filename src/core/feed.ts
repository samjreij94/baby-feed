/** Pure breast-timer operations + derived views. No I/O; `now` is always passed in. */
import type { ActiveFeedView, BreastFeed, Feed, LastFeedInfo, Segment, Side, SideMs } from './types';

export const opposite = (s: Side): Side => (s === 'L' ? 'R' : 'L');
export const feedStart = (f: Feed): number => (f.kind === 'breast' ? f.startedAt : f.at);

/** Side of the last segment (open or closed). */
export function lastSegmentSide(f: BreastFeed): Side | null {
  return f.segments.length ? f.segments[f.segments.length - 1]!.side : null;
}

function closeOpen(segments: Segment[], at: number): Segment[] {
  return segments.map((s) => (s.endedAt === null ? { ...s, endedAt: Math.max(at, s.startedAt) } : s));
}

/** Fields of a new running feed (EntryBase is added by the store). */
export function startFields(side: Side, at: number): Pick<BreastFeed, 'kind' | 'startedAt' | 'endedAt' | 'segments' | 'pausedAt' | 'status'> {
  return { kind: 'breast', startedAt: at, endedAt: null, segments: [{ side, startedAt: at, endedAt: null }], pausedAt: null, status: 'running' };
}

/** Running: close current segment, open one on the other side. Paused: resume on the other side. */
export function switchSide(f: BreastFeed, at: number): BreastFeed {
  if (f.status === 'ended') return f;
  const side = opposite(lastSegmentSide(f) ?? 'R');
  return { ...f, segments: [...closeOpen(f.segments, at), { side, startedAt: at, endedAt: null }], pausedAt: null, status: 'running' };
}

/** Close the current segment; status paused. No-op unless running. */
export function pause(f: BreastFeed, at: number): BreastFeed {
  if (f.status !== 'running') return f;
  return { ...f, segments: closeOpen(f.segments, at), pausedAt: at, status: 'paused' };
}

/** Open a new segment on the same side as the last one. No-op unless paused. */
export function resume(f: BreastFeed, at: number): BreastFeed {
  if (f.status !== 'paused') return f;
  const side = lastSegmentSide(f) ?? 'L';
  return { ...f, segments: [...f.segments, { side, startedAt: at, endedAt: null }], pausedAt: null, status: 'running' };
}

/**
 * Close everything. Ending while paused uses pausedAt as endedAt (the feed really stopped at the pause).
 * endedAt is never before the last segment's start (a feed started on a phone whose clock is slightly ahead),
 * so the result always validates.
 */
export function end(f: BreastFeed, at: number): BreastFeed {
  if (f.status === 'ended') return f;
  const endedAt = f.status === 'paused' && f.pausedAt !== null ? f.pausedAt : Math.max(at, f.segments.at(-1)?.startedAt ?? at);
  return { ...f, segments: closeOpen(f.segments, endedAt), endedAt, pausedAt: null, status: 'ended' };
}

/** Nursing ms per side; open segment counted up to `now`. */
export function sideMs(f: BreastFeed, now: number): SideMs {
  const out: SideMs = { L: 0, R: 0 };
  for (const s of f.segments) out[s.side] += Math.max(0, (s.endedAt ?? now) - s.startedAt);
  return out;
}

export function nursingMs(f: BreastFeed, now: number): number {
  const m = sideMs(f, now);
  return m.L + m.R;
}

const live = <T extends { deleted: boolean }>(xs: readonly T[]) => xs.filter((x) => !x.deleted);

export function activeFeedView(feeds: readonly Feed[], now: number): ActiveFeedView {
  const act = live(feeds)
    .filter((f): f is BreastFeed => f.kind === 'breast' && f.status !== 'ended')
    .sort((a, b) => b.startedAt - a.startedAt);
  const feed = act[0] ?? null;
  if (!feed) return { feed: null, status: null, currentSide: null, elapsedMs: 0, sideMs: { L: 0, R: 0 }, segmentElapsedMs: 0, others: [] };
  const open = feed.segments.find((s) => s.endedAt === null);
  const sm = sideMs(feed, now);
  return {
    feed,
    status: feed.status,
    currentSide: lastSegmentSide(feed),
    elapsedMs: sm.L + sm.R,
    sideMs: sm,
    segmentElapsedMs: open ? Math.max(0, now - open.startedAt) : 0,
    others: act.slice(1),
  };
}

/** SPEC §3.2: next side = opposite of the last segment's side of the most recent breast feed. */
export function lastFeedInfo(feeds: readonly Feed[], now: number): LastFeedInfo {
  const sorted = live(feeds).sort((a, b) => feedStart(b) - feedStart(a));
  const feed = sorted[0] ?? null;
  const lastBreast = (sorted.find((f) => f.kind === 'breast') as BreastFeed | undefined) ?? null;
  const lastSide = lastBreast ? lastSegmentSide(lastBreast) : null;
  return {
    feed,
    startedAt: feed ? feedStart(feed) : null,
    sinceMs: feed ? Math.max(0, now - feedStart(feed)) : null,
    lastBreast,
    lastSide,
    nextSide: lastSide ? opposite(lastSide) : null,
  };
}

/** Validation for stored/received breast feeds. Returns an error string or null. */
export function validateBreast(f: Pick<BreastFeed, 'startedAt' | 'endedAt' | 'segments' | 'status' | 'pausedAt'>): string | null {
  if (!f.segments.length) return 'no segments';
  let prev = -Infinity;
  f.segments.forEach((s, i) => {
    if (s.side !== 'L' && s.side !== 'R') prev = NaN;
    if (s.startedAt < prev) prev = NaN;
    if (s.endedAt === null && (i !== f.segments.length - 1 || f.status !== 'running')) prev = NaN;
    if (s.endedAt !== null && s.endedAt < s.startedAt) prev = NaN;
    if (!Number.isNaN(prev)) prev = s.endedAt ?? s.startedAt;
  });
  if (Number.isNaN(prev)) return 'bad segments';
  if (f.segments[0]!.startedAt < f.startedAt) return 'segment before start';
  if (f.status === 'ended' && (f.endedAt === null || f.endedAt < prev)) return 'bad endedAt';
  if (f.status !== 'ended' && f.endedAt !== null) return 'endedAt on active feed';
  if (f.status === 'paused' && f.pausedAt === null) return 'paused without pausedAt';
  return null;
}

/** Bottle amounts: > 0 and a multiple of 0.25 oz. */
export function validAmountOz(oz: number): boolean {
  return Number.isFinite(oz) && oz > 0 && oz <= 20 && Math.abs(oz * 4 - Math.round(oz * 4)) < 1e-9;
}

/**
 * UI adapter: the ONLY UI module that imports src/core (Dealer's public API, SPEC.md). It maps core hooks/views
 * onto the UI view-models in ./types. No business logic here — shape mapping and display formatting only.
 * Signatures match src/core/index.ts + hooks.ts (Dealer's core). The only UI module that imports src/core.
 */
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ActiveFeedExistsError,
  computeMetrics,
  NetworkError,
  parseInvite,
  readInviteFromLocation,
  sideMs,
  CoreProvider,
  useActiveFeed,
  useCore,
  useCoreReady,
  useFeedActions,
  useFeeds,
  useHousehold,
  useLastFeed,
  useMetrics,
  useNaraImport,
  useNow,
  useSync,
  type BreastFeed,
  type BreastPatch,
  type FeedCore,
  type EntryPatch,
  type Feed,
  type Member,
  type Metrics,
  type Side as CoreSide,
} from '../core';
import { dateKey, dayOfMonth, fmtAmount, fmtMin, fmtMinShort, initials, longDayLabel, weekdayInitial } from './format';
import { groupHistory } from './history';
import { MAX_GAP_MIN, rangeDayCount, summarizeAllTime } from './metrics';
import { clearLegacyBabyName, loadLegacyBabyName } from './prefs';
import { MILK_NAME, SIDE_NAME, type NaraVM, type ActiveFeedVM, type ChartDayVM, type ChartRange, type ChartsVM, type EntryDraft, type HistoryDayVM, type HistoryEntryVM, type HomeVM, type HouseholdVM, type PersonVM, type RangeDays, type Side, type SyncVM, type Units } from './types';

const MIN = 60_000;
const feedStart = (f: Feed) => (f.kind === 'breast' ? f.startedAt : f.at);

/* ---------- people ---------- */
export function personVM(m: Member, meId: string | null, members: readonly Member[]): PersonVM {
  const idx = members.findIndex((x) => x.id === m.id);
  // Prefer the member's CURRENT name (renames sync); fall back to the name snapshot on the entry.
  const name = (idx >= 0 ? members[idx]!.name : m.name) || '?';
  return { id: m.id, name, initials: initials(name), tone: ((idx >= 0 ? idx : 3) % 4) as PersonVM['tone'], isMe: m.id === meId };
}

/* ---------- feed → row ---------- */
/** Collapses consecutive same-side segments: L,L,R → ['L','R']. */
export function sideSequence(f: BreastFeed): Side[] {
  const seq: Side[] = [];
  for (const s of f.segments) if (seq[seq.length - 1] !== s.side) seq.push(s.side);
  return seq;
}

export function feedToDraft(f: Feed, now: number): EntryDraft {
  if (f.kind === 'bottle') return { kind: 'bottle', id: f.id, at: f.at, amountOz: f.amountOz, milk: f.milk ?? 'breast' };
  const ms = sideMs(f, now);
  return { kind: 'breast', id: f.id, startedAt: f.startedAt, first: f.segments[0]?.side ?? 'L', minutes: { L: Math.round(ms.L / MIN), R: Math.round(ms.R / MIN) } };
}

export function feedToRow(f: Feed, meId: string | null, members: readonly Member[], units: Units, now: number): HistoryEntryVM {
  const by = personVM(f.loggedBy, meId, members);
  if (f.kind === 'bottle') {
    return {
      id: f.id, kind: 'bottle', at: f.at, title: 'Bottle', detail: [fmtAmount(f.amountOz, units), f.milk ? MILK_NAME[f.milk] : null].filter(Boolean).join(' · '),
      duration: '', side: null, sides: [], amountOz: f.amountOz, nursingMin: 0, running: false, by, draft: feedToDraft(f, now),
    };
  }
  const ms = sideMs(f, now);
  const seq = sideSequence(f);
  const totalMin = (ms.L + ms.R) / MIN;
  const parts = (['L', 'R'] as const).filter((s) => ms[s] > 0).map((s) => `${s} ${fmtMinShort(ms[s] / MIN)}`);
  return {
    id: f.id, kind: 'breast', at: f.startedAt,
    title: seq.map((s) => SIDE_NAME[s]).join(' → ') || 'Breastfeed',
    detail: f.status === 'ended' ? parts.join(' · ') : f.status === 'paused' ? 'Paused' : 'In progress',
    duration: fmtMin(totalMin), side: seq[seq.length - 1] ?? null, sides: seq, amountOz: null, nursingMin: totalMin, running: f.status !== 'ended', by, draft: feedToDraft(f, now),
  };
}

/** Edit draft → closed segments laid out contiguously from startedAt, first side first (zero-minute side dropped). */
export function draftToBreastSegments(d: Extract<EntryDraft, { kind: 'breast' }>) {
  const other: CoreSide = d.first === 'L' ? 'R' : 'L';
  const segs: Array<{ side: CoreSide; startedAt: number; endedAt: number }> = [];
  let t = d.startedAt;
  for (const side of [d.first, other] as const) {
    const ms = Math.round(d.minutes[side] * MIN);
    if (ms > 0) { segs.push({ side, startedAt: t, endedAt: t + ms }); t += ms; }
  }
  return { segments: segs, endedAt: t };
}

/* ---------- charts ---------- */
/** Gaps longer than this are "nothing was logged", not a feeding gap (defined in ./metrics, shared with All-time). */
export { MAX_GAP_MIN };
/** Mean minutes between consecutive feed starts, per local day (a gap belongs to the later feed's day). */
export function dailyGaps(starts: readonly number[], dayKeys: readonly string[]): Map<string, number | null> {
  const sorted = [...starts].sort((a, b) => a - b);
  const acc = new Map<string, number[]>(dayKeys.map((k) => [k, []]));
  for (let i = 1; i < sorted.length; i++) {
    const gap = (sorted[i]! - sorted[i - 1]!) / MIN;
    if (gap <= MAX_GAP_MIN) acc.get(dateKey(sorted[i]!))?.push(gap);
  }
  return new Map([...acc].map(([k, v]) => [k, v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null]));
}

export function buildChartsVM(m: Metrics, feedStarts: readonly number[], range: RangeDays): ChartsVM {
  const gaps = dailyGaps(feedStarts, m.days.map((d) => d.date));
  const days: ChartDayVM[] = m.days.map((d) => ({
    key: d.date,
    tick: range === 7 ? weekdayInitial(d.date) : dayOfMonth(d.date),
    label: longDayLabel(d.date),
    leftMin: d.minutesBySide.L,
    rightMin: d.minutesBySide.R,
    nursingMin: d.breastMinutes,
    feeds: d.feeds,
    bottleOz: d.bottleOz,
    avgGapMin: gaps.get(d.date) ?? null,
  }));
  const { L, R } = m.totals.minutesBySide;
  const tot = L + R;
  return {
    range,
    bucket: 'day',
    days,
    split: { L: tot ? L / tot : 0, R: tot ? R / tot : 0, leftMin: L, rightMin: R },
    avg: { feedsPerDay: m.perDayAvg.feeds, nursingMinPerDay: m.perDayAvg.breastMinutes, bottleOzPerDay: m.perDayAvg.bottleOz, gapMin: m.avgGapMinutes, feedMin: m.avgFeedMinutes },
    hasData: m.totals.feeds > 0,
  };
}

/* ---------- core provider (tests / dev demo) ---------- */
export function CoreScope({ core, children }: { core: FeedCore; children: ReactNode }) {
  return createElement(CoreProvider, { core } as Parameters<typeof CoreProvider>[0], children);
}

/* ---------- ready gate (PPL gateActions pattern) ----------
 * Identity and a running timer come from the localStorage mirror instantly; full history arrives when IndexedDB
 * has loaded (useCoreReady). Every UI write goes through this gate, which checks the LIVE core status at call time.
 */
export const NOT_READY_MSG = 'Still loading your feeds — try again in a moment.';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsyncFn = (...args: any[]) => Promise<any>;
export function gateActions<T extends Record<string, AnyAsyncFn>>(blocked: () => boolean, actions: T): T {
  const out: Record<string, AnyAsyncFn> = {};
  for (const [name, fn] of Object.entries(actions)) {
    out[name] = (...args: unknown[]) => {
      if (blocked()) {
        console.warn(`[baby-feed] ignored "${name}": core not ready`);
        return Promise.reject(new Error(NOT_READY_MSG));
      }
      return fn(...args);
    };
  }
  return out as T;
}
/** Network failures read as a calm sentence; core's own validation messages pass through unchanged. */
async function friendly<T>(p: Promise<T>): Promise<T> {
  try { return await p; } catch (e) {
    if (e instanceof NetworkError) throw new Error('Can’t reach the sync server. Check your connection and try again.');
    throw e;
  }
}
function useBlocked(): () => boolean {
  const core = useCore();
  return () => !core.getSnapshot().ready;
}

/* ---------- hooks for screens ---------- */
/** false until IndexedDB has loaded (identity + running timer are already available from the mirror). */
export const useReady = (): boolean => useCoreReady();
/** Core-clock now (device clock + server offset), re-rendering every intervalMs. */
export const useClock = (intervalMs: number): number => useNow(intervalMs);

/*
 * Baby name = core's synced household name (both phones read it; '' = not set). Until the one-time migration below
 * has run, the old device-local name is shown as a fallback.
 */
function useBabyName(): string | null {
  const h = useHousehold();
  const [legacy] = useState(loadLegacyBabyName);
  return h.babyName.trim() || (legacy && loadLegacyBabyName()) || null;
}

/**
 * One-time hand-over of the old device-local baby name to core. Waits for core to load and, in a household, for a
 * sync in this session (so a name the other phone already set is pulled first and wins). Core empty -> upload ours;
 * either way the local copy is then dropped. Mount once (App).
 */
export function useBabyNameMigration() {
  const h = useHousehold();
  const ready = useCoreReady();
  const sync = useSync();
  const syncedAtMount = useRef(sync.lastSyncedAt);
  const done = useRef(false);
  const synced = sync.lastSyncedAt !== null && sync.lastSyncedAt !== syncedAtMount.current;
  const canDecide = ready && (h.status === 'none' || (synced && !!h.me));
  useEffect(() => {
    if (done.current || !canDecide) return;
    const legacy = loadLegacyBabyName();
    done.current = true;
    if (!legacy) return;
    void (async () => {
      try {
        if (!h.babyName.trim()) await h.setBabyName(legacy);
        clearLegacyBabyName();
      } catch (e) {
        done.current = false; // keep the local copy; try again on the next render
        console.warn('[ui] baby name migration', e);
      }
    })();
  }, [canDecide, h]);
}

export function useHouseholdVM() {
  const h = useHousehold();
  const blocked = useBlocked();
  const babyName = useBabyName();
  const meId = h.me?.id ?? null;
  const vm: HouseholdVM = {
    status: h.status,
    me: h.me ? personVM(h.me, meId, h.members) : null,
    members: h.members.map((m) => personVM(m, meId, h.members)),
    code: h.inviteCode,
    link: h.inviteLink,
    babyName,
  };
  const actions = gateActions(blocked, {
    // Core keeps a name set before the household exists and uploads it on create (on join only if the household has none).
    create: async (myName: string, baby: string | null) => { if (baby?.trim()) await h.setBabyName(baby); await friendly(h.createHousehold(myName.trim())); },
    // Core's own messages ('That invite code is not valid' / 'Invite code not recognised') are shown inline as-is.
    join: async (code: string, myName: string, baby: string | null) => { if (baby?.trim()) await h.setBabyName(baby); await friendly(h.joinHousehold(code.trim(), myName.trim())); },
    setMyName: (n: string) => h.setMe(n.trim()).then(() => undefined),
    setBabyName: async (n: string | null) => { await h.setBabyName(n?.trim() ?? ''); clearLegacyBabyName(); },
    leave: () => h.leave(),
  });
  return [vm, actions] as const;
}

/** Validates a typed code or invite link. */
export const isValidJoin = (codeOrLink: string) => parseInvite(codeOrLink) !== null;
/** Invite code from `#join=CODE` (core's link format) or `?join=CODE` on app open. */
export function readJoinFromUrl(loc: { search: string; hash: string } = location): string | null {
  const q = new URLSearchParams(loc.search).get('join');
  if (q) return parseInvite(q);
  return readInviteFromLocation(loc);
}

export function useHomeVM(units: Units): HomeVM {
  const last = useLastFeed();
  const h = useHousehold();
  const m = useMetrics(7);
  const babyName = useBabyName();
  const f = last.feed;
  const today = m.days[m.days.length - 1];
  let lastSummary: string | null = null;
  if (f?.kind === 'bottle') lastSummary = `Bottle · ${fmtAmount(f.amountOz, units)}`;
  else if (f) { const ms = sideMs(f, (last.startedAt ?? 0) + (last.sinceMs ?? 0)); lastSummary = `${sideSequence(f).map((s) => SIDE_NAME[s]).join(' → ')} · ${fmtMin((ms.L + ms.R) / MIN)}`; }
  return {
    babyName,
    hasFeeds: !!f,
    lastFedAt: last.startedAt,
    sinceMs: last.sinceMs,
    lastKind: f?.kind ?? null,
    lastSummary,
    lastBy: f ? personVM(f.loggedBy, h.me?.id ?? null, h.members) : null,
    lastSide: last.lastSide,
    nextSide: last.nextSide,
    today: { feeds: today?.feeds ?? 0, nursingMin: today?.breastMinutes ?? 0, bottleOz: today?.bottleOz ?? 0 },
  };
}

export function useActiveFeedVM(): ActiveFeedVM | null {
  const a = useActiveFeed();
  const h = useHousehold();
  if (!a.feed || !a.status || a.status === 'ended') return null;
  const meId = h.me?.id ?? null;
  const o = a.others[0];
  return {
    id: a.feed.id,
    status: a.status,
    currentSide: a.currentSide ?? 'L',
    startedAt: a.feed.startedAt,
    elapsedMs: a.elapsedMs,
    sideMs: a.sideMs,
    segmentElapsedMs: a.segmentElapsedMs,
    startedBy: personVM(a.feed.loggedBy, meId, h.members),
    startedByOther: meId !== null && a.feed.loggedBy.id !== meId,
    conflict: o ? { id: o.id, by: personVM(o.loggedBy, meId, h.members), startedAt: o.startedAt } : null,
  };
}

export function useHistoryVM(units: Units): HistoryDayVM[] {
  const feeds = useFeeds();
  const h = useHousehold();
  const now = useNow(60_000);
  const meId = h.me?.id ?? null;
  const members = h.members;
  return useMemo(() => groupHistory(feeds.map((f) => feedToRow(f, meId, members, units, now)), now, units), [feeds, meId, members, units, now]);
}

const fmtShortDate = (t: number, year = false) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });

/**
 * All-time charts: core's computeMetrics (core day attribution: a feed counts on the local day it started) over
 * first-feed-day → today, then regrouped by ./metrics (daily ≤ 31 days, Mon-start weeks, months > 26 weeks).
 * Week/month bars are DAILY AVERAGES for that bucket; "/ day" stats divide totals by the days in the range.
 */
export function buildAllTimeChartsVM(feeds: readonly Feed[], now: number): ChartsVM {
  const live = feeds.filter((f) => !f.deleted);
  const starts = live.map(feedStart).filter((t) => t <= now);
  const first = starts.length ? starts.reduce((a, b) => (b < a ? b : a)) : null;
  const n = rangeDayCount(first, now);
  const m = n ? computeMetrics(live, n, now) : null;
  const s = summarizeAllTime(m?.days ?? [], starts);
  const what = s.bucket === 'week' ? 'week' : s.bucket === 'month' ? 'month' : 'day';
  const days: ChartDayVM[] = s.bars.map((b) => ({
    key: b.key,
    tick: b.tick,
    label: b.bucket === 'day' ? b.label : `${b.label}${b.partial ? ` (partial, ${b.days} ${b.days === 1 ? 'day' : 'days'})` : ''}, daily average`,
    leftMin: b.leftMin,
    rightMin: b.rightMin,
    nursingMin: b.nursingMin,
    feeds: b.feeds,
    bottleOz: b.bottleOz,
    avgGapMin: b.avgGapMin,
    partial: b.partial,
  }));
  let partialNote: string | null = null;
  if (s.partialBars.length) {
    const parts = s.partialBars.map((b) => `${b === s.bars[s.bars.length - 1] ? `this ${what} so far` : b === s.bars[0] ? `first ${what}` : b.label}: ${b.days} ${b.days === 1 ? 'day' : 'days'}`);
    partialNote = `Faded bars are partial ${what}s, averaged over the days they cover (${parts.join(', ')}).`;
  }
  const firstDay = m?.days[0]?.dayStart ?? null;
  const sameYear = firstDay !== null && new Date(firstDay).getFullYear() === new Date(now).getFullYear();
  return {
    range: 'all',
    bucket: s.bucket,
    days,
    split: s.split,
    avg: { feedsPerDay: s.perDay.feeds, nursingMinPerDay: s.perDay.nursingMin, bottleOzPerDay: s.perDay.bottleOz, gapMin: s.avgGapMin, feedMin: m?.avgFeedMinutes ?? null },
    hasData: s.totals.feeds > 0,
    allTime: {
      rangeText: firstDay === null ? 'No feeds yet' : `${fmtShortDate(firstDay, !sameYear)} – ${fmtShortDate(now, true)} · ${n} ${n === 1 ? 'day' : 'days'}`,
      barCaption: s.bucket === 'day' ? 'One bar per day' : `Each bar is the daily average for that ${what}${s.bucket === 'week' ? ' (Mon–Sun)' : ''}`,
      partialNote,
    },
  };
}

export function useChartsVM(range: ChartRange): ChartsVM {
  const all = range === 'all';
  const days = all ? 7 : range;
  const m = useMetrics(days);
  // One extra day so the first day's first gap has a predecessor.
  const recent = useFeeds({ days: days + 1 });
  const everything = useFeeds();
  const now = useNow(60_000);
  return useMemo(
    () => (all ? buildAllTimeChartsVM(everything, now) : buildChartsVM(m, recent.map(feedStart), range)),
    [all, everything, now, m, recent, range],
  );
}

export function useSyncVM(): SyncVM & { syncNow: () => Promise<void> } {
  const s = useSync();
  const text = s.state === 'syncing' ? 'Syncing…' : s.state === 'offline' ? 'Offline — changes will sync later' : s.state === 'error' ? (s.error ?? 'Sync problem') : s.lastSyncedAt ? 'Up to date' : 'Not synced yet';
  return { state: s.state, text, pending: s.pending, syncNow: s.syncNow };
}

/** Thrown by startFeed when the other phone already has a feed running (UI opens that timer instead). */
export class FeedAlreadyRunning extends Error {}

export function useActions() {
  const a = useActiveFeed();
  const fa = useFeedActions();
  const core = useCore();
  const blocked = useBlocked();
  return gateActions(blocked, {
    startFeed: async (side: Side) => {
      try { await a.startBreast(side); } catch (e) { if (e instanceof ActiveFeedExistsError) throw new FeedAlreadyRunning(e.message); throw e; }
    },
    switchSide: async () => { await a.switchSide(); },
    pause: async () => { await a.pause(); },
    resume: async () => { await a.resume(); },
    endFeed: async () => { await a.end(); },
    /**
     * End a feed that is running but is NOT the active one (both phones started a feed; SPEC: "UI may offer
     * end/discard"). Core's end() only targets the newest feed and BreastPatch has no `status`, so this mirrors
     * feed.end() through editEntry (which validates). TODO(Dealer): replace with a core end(id) when available.
     */
    endOtherFeed: async (id: string) => {
      if (id === a.feed?.id) { await a.end(); return; }
      const f = a.others.find((o) => o.id === id);
      if (!f) return;
      const endedAt = f.status === 'paused' && f.pausedAt !== null ? f.pausedAt : Math.max(core.now(), ...f.segments.map((s) => s.startedAt));
      const segments = f.segments.map((s) => (s.endedAt === null ? { ...s, endedAt } : s));
      await fa.editEntry(id, { endedAt, segments, status: 'ended', pausedAt: null } as BreastPatch);
    },
    /** Discard the active feed, or (conflict) another running feed by id. */
    discardFeed: async (id: string) => { if (id === a.feed?.id) await a.discard(); else await fa.deleteEntry(id); },
    deleteEntry: (id: string) => fa.deleteEntry(id),
    /** Create (no id) or update an entry from the bottle/edit/add sheet. */
    saveDraft: async (d: EntryDraft, original?: EntryDraft) => {
      if (d.kind === 'bottle') {
        if (d.id) {
          const patch: EntryPatch = { at: d.at, amountOz: d.amountOz, milk: d.milk };
          await fa.editEntry(d.id, patch);
        } else await fa.addBottle({ amountOz: d.amountOz, at: d.at, milk: d.milk });
        return;
      }
      const { segments, endedAt } = draftToBreastSegments(d);
      if (!segments.length) throw new Error('Add at least one minute on a side.');
      if (d.id) {
        const o = original?.kind === 'breast' ? original : null;
        const unchanged = o && o.startedAt === d.startedAt && o.first === d.first && o.minutes.L === d.minutes.L && o.minutes.R === d.minutes.R;
        if (!unchanged) await fa.editEntry(d.id, { startedAt: d.startedAt, endedAt, segments });
      } else await fa.addManualBreast({ start: d.startedAt, end: endedAt, segments });
    },
  });
}

/* ---------- Nara import ---------- */
const NARA_TYPE_LABEL: Record<string, string> = { invalid: 'Unreadable feed rows', duplicate: 'Duplicate rows' };

export function useNaraImportVM(): NaraVM {
  const n = useNaraImport();
  const h = useHousehold();
  const blocked = useBlocked();
  const meId = h.me?.id ?? null;
  const members = h.members.map((m) => personVM(m, meId, h.members));
  const p = n.preview;
  const preview: NaraVM['preview'] = useMemo(() => p
    ? {
        totalRows: p.totalRows,
        imported: p.imported,
        feedsToImport: p.imported.breast + p.imported.bottle + p.imported.combo,
        from: p.dateRange?.from ?? null,
        to: p.dateRange?.to ?? null,
        leftHours: p.totals.leftSec / 3600,
        rightHours: p.totals.rightSec / 3600,
        bottleOz: p.totals.bottleOz,
        skipped: Object.entries(p.skipped).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ label: NARA_TYPE_LABEL[type] ?? type, count })),
        caregivers: p.caregivers.map((name) => ({ name, suggestedId: h.members.find((m) => m.name.trim().toLowerCase() === name.trim().toLowerCase())?.id ?? meId })),
        warnings: p.warnings,
      }
    : null, [p, h.members, meId]);
  const gated = gateActions(blocked, {
    parseFile: (f: File) => n.parseFile(f),
    confirm: async (map: Record<string, string>) => {
      const byId = new Map(h.members.map((m) => [m.id, m]));
      const caregiverMap: Record<string, Member> = {};
      for (const [name, id] of Object.entries(map)) { const m = byId.get(id); if (m) caregiverMap[name] = { id: m.id, name: m.name }; }
      await n.confirm(caregiverMap);
    },
  });
  return { status: n.status, error: n.error, preview, result: n.result, members, ...gated, reset: n.reset };
}

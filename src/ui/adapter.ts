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
  startOfLocalDay,
  startOfLocalWeek,
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
  type FeedCore,
  type EntryPatch,
  type Feed,
  type Member,
  type Metrics,
  type MetricsBucket,
  type MetricsOptions,
  type Side as CoreSide,
} from '../core';
import { dayOfMonth, fmtAmount, fmtMin, fmtMinShort, initials, longDayLabel, weekdayInitial } from './format';
import { groupHistory } from './history';
import { barTick, chooseBucket, MAX_GAP_MIN, type Bucket } from './metrics';
import { clearLegacyBabyName, loadLegacyBabyName } from './prefs';
import { MILK_NAME, SIDE_NAME, type NaraVM, type ActiveFeedVM, type ChartDayVM, type ChartRange, type ChartsVM, type EntryDraft, type HistoryDayVM, type HistoryEntryVM, type HomeVM, type HouseholdVM, type PersonVM, type Side, type SyncVM, type Units } from './types';

const MIN = 60_000;

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

/* ---------- charts (numbers: core computeMetrics/useMetrics) ---------- */
/** Gaps longer than this are "nothing was logged" / a long night, not a feeding gap (one rule for every range). */
export { MAX_GAP_MIN };
/** Options for every chart range: core drops gaps > 12h from the headline and per-bar average gap. */
export const chartMetricsOptions = (bucket: Bucket): MetricsOptions => ({ bucket, maxGapMinutes: MAX_GAP_MIN });

const DAY_MS = 86_400_000;
/** All-time bucket for a range from the first feed's day to `now` (≤31 days daily, ≤26 Mon-start weeks weekly, else monthly). */
export function allTimeBucket(firstFeedAt: number | null, now: number): Bucket {
  if (firstFeedAt === null) return 'day';
  const first = startOfLocalDay(Math.min(firstFeedAt, now));
  const days = Math.round((startOfLocalDay(now) - first) / DAY_MS) + 1; // round absorbs DST's 23h/25h days
  const weeks = Math.round((startOfLocalWeek(now) - startOfLocalWeek(first)) / (7 * DAY_MS)) + 1;
  return chooseBucket(days, weeks);
}

const fmtShortDate = (t: number, year = false) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}) });
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`;

/**
 * Charts view-model from core metrics. 7/14/30: `m` = computeMetrics(feeds, n, now, chartMetricsOptions('day')).
 * All: `m` = computeMetrics(feeds, 'all', now, chartMetricsOptions(allTimeBucket(...))); week/month bars are core's
 * per-day averages for that bucket, partial ones faded; "/ day" stats = totals ÷ days in the range.
 */
export function buildChartsVM(m: Metrics, range: ChartRange): ChartsVM {
  const all = range === 'all';
  const bucket = m.bucket;
  const multiYear = m.from !== null && m.to !== null && new Date(m.from).getFullYear() !== new Date(m.to - 1).getFullYear();
  const what = bucket;
  const bar = (b: MetricsBucket): ChartDayVM => ({
    key: b.key,
    tick: !all ? (range === 7 ? weekdayInitial(b.key) : dayOfMonth(b.key)) : barTick(bucket, b.start, multiYear),
    label: !all ? longDayLabel(b.key) : bucket === 'day' ? b.label : `${b.label}${b.partial ? ` (partial, ${plural(b.days, 'day')})` : ''}, daily average`,
    leftMin: b.perDayAvg.minutesBySide.L,
    rightMin: b.perDayAvg.minutesBySide.R,
    nursingMin: b.perDayAvg.breastMinutes,
    feeds: b.perDayAvg.feeds,
    bottleOz: b.perDayAvg.bottleOz,
    avgGapMin: b.avgGapMinutes,
    ...(all ? { partial: b.partial } : {}),
  });
  const { L, R } = m.totals.minutesBySide;
  const tot = L + R;
  const vm: ChartsVM = {
    range,
    bucket,
    days: m.buckets.map(bar),
    split: { L: tot ? L / tot : 0, R: tot ? R / tot : 0, leftMin: L, rightMin: R },
    avg: { feedsPerDay: m.perDayAvg.feeds, nursingMinPerDay: m.perDayAvg.breastMinutes, bottleOzPerDay: m.perDayAvg.bottleOz, gapMin: m.avgGapMinutes, feedMin: m.avgFeedMinutes },
    hasData: m.totals.feeds > 0,
  };
  if (!all) return vm;
  const bars = m.buckets;
  const partials = bucket === 'day' ? [] : bars.filter((b) => b.partial);
  let partialNote: string | null = null;
  if (partials.length) {
    const parts = partials.map((b) => `${b === bars[bars.length - 1] ? `this ${what} so far` : b === bars[0] ? `first ${what}` : b.label}: ${plural(b.days, 'day')}`);
    partialNote = `Faded bars are partial ${what}s, averaged over the days they cover (${parts.join(', ')}).`;
  }
  const now = m.to === null ? 0 : m.to - 1;
  const sameYear = m.from !== null && new Date(m.from).getFullYear() === new Date(now).getFullYear();
  vm.allTime = {
    rangeText: m.from === null ? 'No feeds yet' : `${fmtShortDate(m.from, !sameYear)} – ${fmtShortDate(now, true)} · ${plural(m.rangeDays, 'day')}`,
    barCaption: bucket === 'day' ? 'One bar per day' : `Each bar is the daily average for that ${what}${bucket === 'week' ? ' (Mon–Sun)' : ''}`,
    partialNote,
  };
  return vm;
}

/** All-time charts straight from feeds (pure; what useChartsVM('all') computes). */
export function buildAllTimeChartsVM(feeds: readonly Feed[], now: number): ChartsVM {
  const first = computeMetrics(feeds, 0, now).firstFeedAt;
  return buildChartsVM(computeMetrics(feeds, 'all', now, chartMetricsOptions(allTimeBucket(first, now))), 'all');
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
  const [syncedAtMount] = useState(sync.lastSyncedAt);
  const done = useRef(false);
  const synced = sync.lastSyncedAt !== null && sync.lastSyncedAt !== syncedAtMount;
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

export function useChartsVM(range: ChartRange): ChartsVM {
  const all = range === 'all';
  // Daily range (also gives firstFeedAt, which is not range-limited, for the All bucket choice).
  const daily = useMetrics(all ? 1 : range, chartMetricsOptions('day'));
  const now = useNow(60_000);
  const bucket = all ? allTimeBucket(daily.firstFeedAt, now) : 'day';
  const allTime = useMetrics(all ? 'all' : 0, chartMetricsOptions(bucket)); // range 0 = nothing to compute
  return useMemo(() => buildChartsVM(all ? allTime : daily, range), [all, allTime, daily, range]);
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
  const blocked = useBlocked();
  return gateActions(blocked, {
    startFeed: async (side: Side) => {
      try { await a.startBreast(side); } catch (e) { if (e instanceof ActiveFeedExistsError) throw new FeedAlreadyRunning(e.message); throw e; }
    },
    switchSide: async () => { await a.switchSide(); },
    pause: async () => { await a.pause(); },
    resume: async () => { await a.resume(); },
    endFeed: async () => { await a.end(); },
    /** End a feed by id: the active one, or (both phones started) the other phone's running/paused feed. */
    endOtherFeed: async (id: string) => { await a.end(id); },
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

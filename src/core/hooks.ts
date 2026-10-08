/** React bindings. Wrap the app in <CoreProvider core={getCore()}> (optional: hooks default to getCore()). */
import { createContext, createElement, useCallback, useRef, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { activeFeedView, feedStart, lastFeedInfo } from './feed';
import { computeMetrics } from './metrics';
import { getCore, type CoreSnapshot, type FeedCore } from './store';
import type { ImportResult, Member, ActiveFeedView, BreastFeed, Feed, FeedRange, HouseholdView, LastFeedInfo, Metrics, MetricsOptions, MetricsRange, Side, SyncView } from './types';

const Ctx = createContext<FeedCore | null>(null);

export function CoreProvider({ core, children }: { core: FeedCore; children: ReactNode }) {
  return createElement(Ctx.Provider, { value: core }, children);
}

export function useCore(): FeedCore {
  return useContext(Ctx) ?? getCore();
}

export function useSnapshot(): CoreSnapshot {
  const core = useCore();
  return useSyncExternalStore(core.subscribe, core.getSnapshot, core.getSnapshot);
}

/** Core-clock "now" that re-renders every intervalMs (default 1000). */
export function useNow(intervalMs = 1000): number {
  const core = useCore();
  const [now, setNow] = useState(() => core.now());
  useEffect(() => {
    const t = setInterval(() => setNow(core.now()), intervalMs);
    return () => clearInterval(t);
  }, [core, intervalMs]);
  return now;
}

/** Non-deleted feeds (breast + bottle), newest start first, optionally limited to a range. */
export function useFeeds(range?: FeedRange): Feed[] {
  const { feeds } = useSnapshot();
  const core = useCore();
  const key = range ? JSON.stringify(range) : '';
  return useMemo(() => {
    const range = key ? (JSON.parse(key) as FeedRange) : undefined;
    if (!range) return feeds;
    const now = core.now();
    const from = 'days' in range ? now - range.days * 86_400_000 : range.from;
    const to = 'days' in range ? Infinity : (range.to ?? Infinity);
    return feeds.filter((f) => feedStart(f) >= from && feedStart(f) < to);
  }, [feeds, key, core]);
}

export interface ActiveFeedHook extends ActiveFeedView {
  startBreast(side: Side, opts?: { startedAt?: number }): Promise<BreastFeed>;
  switchSide(): Promise<BreastFeed | null>;
  pause(): Promise<BreastFeed | null>;
  resume(): Promise<BreastFeed | null>;
  /** End the active feed, or (with an id) another running/paused feed — e.g. the other phone's in a conflict. */
  end(id?: string): Promise<BreastFeed | null>;
  discard(): Promise<void>;
}

/** The running/paused breast feed with live-ticking elapsed times (1 s) + timer actions. */
export function useActiveFeed(): ActiveFeedHook {
  const core = useCore();
  const { feeds } = useSnapshot();
  const now = useNow(1000);
  const view = useMemo(() => activeFeedView(feeds, Math.max(now, core.now())), [feeds, now, core]);
  return {
    ...view,
    startBreast: (side, opts) => core.startBreast(side, opts),
    switchSide: () => core.switchSide(),
    pause: () => core.pause(),
    resume: () => core.resume(),
    end: (id) => core.end(id),
    discard: () => core.discardActive(),
  };
}

/** Last feed, time since it started (ticks every 10 s), last side and next-side suggestion. */
export function useLastFeed(): LastFeedInfo {
  const core = useCore();
  const { feeds } = useSnapshot();
  const now = useNow(10_000);
  return useMemo(() => lastFeedInfo(feeds, Math.max(now, core.now())), [feeds, now, core]);
}

/**
 * Chart metrics (see computeMetrics). Recomputes on data change and every minute.
 *   useMetrics(7)                                         // original form: today + previous 6 local days
 *   useMetrics('all', { bucket: 'week', maxGapMinutes: 720 })
 *   useMetrics({ from, to }, { bucket: 'month' })
 */
export function useMetrics(range: MetricsRange, opts?: MetricsOptions): Metrics {
  const { feeds } = useSnapshot();
  const now = useNow(60_000);
  const key = JSON.stringify([range, opts?.bucket ?? null, opts?.maxGapMinutes ?? null]);
  return useMemo(() => {
    const [r, bucket, maxGapMinutes] = JSON.parse(key) as [MetricsRange, MetricsOptions['bucket'] | null, number | null];
    return computeMetrics(feeds, r, now, { ...(bucket ? { bucket } : {}), ...(maxGapMinutes !== null ? { maxGapMinutes } : {}) });
  }, [feeds, key, now]);
}

export function useHousehold(): HouseholdView {
  const core = useCore();
  const s = useSnapshot();
  return {
    status: s.householdId ? 'joined' : 'none',
    householdId: s.householdId,
    members: s.members,
    me: s.me,
    inviteCode: core.inviteCode,
    inviteLink: core.inviteLink,
    babyName: s.babyName,
    setMe: (name) => core.setMe(name),
    setBabyName: (name) => core.setBabyName(name),
    createHousehold: (name) => core.createHousehold(name),
    joinHousehold: (code, name) => core.joinHousehold(code, name),
    leave: () => core.leave(),
  };
}

export function useSync(): SyncView {
  const core = useCore();
  const { sync } = useSnapshot();
  return { ...sync, syncNow: () => core.syncNow() };
}

/** Context-bound feed actions (same as the top-level addBottle/addManualBreast/editEntry/deleteEntry, but honour <CoreProvider>). */
export function useFeedActions() {
  const core = useCore();
  return useMemo(
    () => ({
      addBottle: core.addBottle.bind(core),
      addManualBreast: core.addManualBreast.bind(core),
      editEntry: core.editEntry.bind(core),
      deleteEntry: core.deleteEntry.bind(core),
      importEntries: core.importEntries.bind(core),
    }),
    [core],
  );
}

/** false until persisted data has loaded from IndexedDB (identity + running timer are available earlier via the mirror). */
export function useCoreReady(): boolean {
  return useSnapshot().ready;
}

// ── Nara import ──────────────────────────────────────────

type NaraModule = typeof import('./import/nara');
type NaraParsed = Awaited<ReturnType<NaraModule['parseNaraCsv']>>;
export type NaraImportPreview = NaraParsed['preview'];
export type NaraImportStatus = 'idle' | 'parsing' | 'ready' | 'importing' | 'done' | 'error';

export interface NaraImportHook {
  status: NaraImportStatus;
  /** From parseNaraCsv (counts, date range, caregivers found, …) once status is 'ready'. */
  preview: NaraImportPreview | null;
  error: string | null;
  result: ImportResult | null;
  /** Read + parse a Nara Baby CSV export (module loaded lazily). */
  parseFile(file: File): Promise<void>;
  /** Import the parsed entries; caregiverMap (Nara caregiver name → Member) re-parses with that mapping first. */
  confirm(caregiverMap?: Record<string, Member>): Promise<void>;
  reset(): void;
}

/** Nara Baby CSV import flow: parseFile → (preview) → confirm → result. Never touches existing local entries. */
export function useNaraImport(): NaraImportHook {
  const core = useCore();
  const [state, setState] = useState<{ status: NaraImportStatus; preview: NaraImportPreview | null; error: string | null; result: ImportResult | null }>({
    status: 'idle',
    preview: null,
    error: null,
    result: null,
  });
  const parsed = useRef<{ text: string; entries: NaraParsed['entries'] } | null>(null);

  const parse = useCallback(
    async (text: string, caregiverMap?: Record<string, Member>) => {
      const { parseNaraCsv } = await import('./import/nara');
      const s = core.getSnapshot();
      return parseNaraCsv(text, { me: s.me, members: s.members, caregiverMap, deviceId: core.deviceId, householdId: s.householdId });
    },
    [core],
  );

  const fail = (e: unknown) => setState((st) => ({ ...st, status: 'error', error: e instanceof Error ? e.message : String(e) }));

  const parseFile = useCallback(
    async (file: File) => {
      setState({ status: 'parsing', preview: null, error: null, result: null });
      try {
        await core.ready;
        const text = await file.text();
        const r = await parse(text);
        parsed.current = { text, entries: r.entries };
        setState({ status: 'ready', preview: r.preview, error: null, result: null });
      } catch (e) {
        parsed.current = null;
        fail(e);
      }
    },
    [core, parse],
  );

  const confirm = useCallback(
    async (caregiverMap?: Record<string, Member>) => {
      const p = parsed.current;
      if (!p) return fail(new Error('Nothing to import — choose a file first'));
      setState((st) => ({ ...st, status: 'importing', error: null }));
      try {
        const entries = caregiverMap ? (await parse(p.text, caregiverMap)).entries : p.entries;
        const result = await core.importEntries(entries);
        setState((st) => ({ ...st, status: 'done', result }));
      } catch (e) {
        fail(e);
      }
    },
    [core, parse],
  );

  const reset = useCallback(() => {
    parsed.current = null;
    setState({ status: 'idle', preview: null, error: null, result: null });
  }, []);

  return { ...state, parseFile, confirm, reset };
}

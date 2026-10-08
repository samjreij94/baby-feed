/** React bindings. Wrap the app in <CoreProvider core={getCore()}> (optional: hooks default to getCore()). */
import { createContext, createElement, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { activeFeedView, feedStart, lastFeedInfo } from './feed';
import { computeMetrics } from './metrics';
import { getCore, type CoreSnapshot, type FeedCore } from './store';
import type { ActiveFeedView, BreastFeed, Feed, FeedRange, HouseholdView, LastFeedInfo, Metrics, Side, SyncView } from './types';

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
  end(): Promise<BreastFeed | null>;
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
    end: () => core.end(),
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

/** Chart metrics for the last rangeDays local days (7/14/30). Recomputes on data change and every minute. */
export function useMetrics(rangeDays: number): Metrics {
  const { feeds } = useSnapshot();
  const now = useNow(60_000);
  return useMemo(() => computeMetrics(feeds, rangeDays, now), [feeds, rangeDays, now]);
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
    setMe: (name) => core.setMe(name),
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
    }),
    [core],
  );
}

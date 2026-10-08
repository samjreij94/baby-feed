/**
 * Pure chart metrics (SPEC §3.3). Device local time.
 * Attribution: a feed belongs entirely to the local day it STARTED on (a feed crossing midnight counts for the start day).
 * Running/paused feeds count in feeds/gaps; their open segment counts up to `now`; they're excluded from avgFeedMinutes.
 */
import { feedStart, sideMs } from './feed';
import type { DayMetrics, Feed, Metrics } from './types';

const MIN = 60_000;

export function localDateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function startOfLocalDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight `n` calendar days before the day containing t (DST-safe). */
export function addLocalDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** Range = today plus the previous rangeDays-1 local calendar days. */
export function computeMetrics(feeds: readonly Feed[], rangeDays: number, now: number): Metrics {
  const today = startOfLocalDay(now);
  const first = addLocalDays(today, -(rangeDays - 1));
  const rangeEnd = addLocalDays(today, 1);
  const days: DayMetrics[] = [];
  const index = new Map<string, DayMetrics>();
  for (let i = 0; i < rangeDays; i++) {
    const dayStart = addLocalDays(first, i);
    const d: DayMetrics = {
      date: localDateKey(dayStart),
      dayStart,
      breastMinutes: 0,
      minutesBySide: { L: 0, R: 0 },
      feeds: 0,
      breastFeeds: 0,
      bottleFeeds: 0,
      bottleOz: 0,
      bottleOzByMilk: { breast: 0, formula: 0, unspecified: 0 },
    };
    days.push(d);
    index.set(d.date, d);
  }

  const inRange = feeds.filter((f) => !f.deleted && feedStart(f) >= first && feedStart(f) < rangeEnd);
  const lengths: number[] = [];
  for (const f of inRange) {
    const d = index.get(localDateKey(feedStart(f)))!;
    d.feeds++;
    if (f.kind === 'breast') {
      d.breastFeeds++;
      const sm = sideMs(f, now);
      d.minutesBySide.L += sm.L / MIN;
      d.minutesBySide.R += sm.R / MIN;
      d.breastMinutes += (sm.L + sm.R) / MIN;
      if (f.status === 'ended') lengths.push((sm.L + sm.R) / MIN);
    } else {
      d.bottleFeeds++;
      d.bottleOz += f.amountOz;
      d.bottleOzByMilk[f.milk ?? 'unspecified'] += f.amountOz;
    }
  }
  for (const d of days) {
    d.breastMinutes = round1(d.breastMinutes);
    d.minutesBySide = { L: round1(d.minutesBySide.L), R: round1(d.minutesBySide.R) };
  }

  const sum = (k: (d: DayMetrics) => number) => days.reduce((a, d) => a + k(d), 0);
  const totals = {
    breastMinutes: round1(sum((d) => d.breastMinutes)),
    minutesBySide: { L: round1(sum((d) => d.minutesBySide.L)), R: round1(sum((d) => d.minutesBySide.R)) },
    feeds: sum((d) => d.feeds),
    breastFeeds: sum((d) => d.breastFeeds),
    bottleFeeds: sum((d) => d.bottleFeeds),
    bottleOz: sum((d) => d.bottleOz),
  };

  const starts = inRange.map(feedStart).sort((a, b) => a - b);
  let avgGapMinutes: number | null = null;
  if (starts.length >= 2) avgGapMinutes = round1((starts[starts.length - 1]! - starts[0]!) / (starts.length - 1) / MIN);
  const avgFeedMinutes = lengths.length ? round1(lengths.reduce((a, b) => a + b, 0) / lengths.length) : null;

  return {
    rangeDays,
    days,
    totals,
    perDayAvg: {
      breastMinutes: round1(totals.breastMinutes / rangeDays),
      feeds: round1(totals.feeds / rangeDays),
      bottleOz: round1(totals.bottleOz / rangeDays),
    },
    avgGapMinutes,
    avgFeedMinutes,
  };
}

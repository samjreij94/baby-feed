/**
 * Pure chart metrics (SPEC §3.3). Device local time (JS Date local methods — no explicit timezone; on the phones
 * that is America/Chicago; tests pin TZ). Weeks start Monday 00:00 local.
 * Attribution: a feed belongs entirely to the local day it STARTED on (a feed crossing midnight counts for the start day).
 * Running/paused feeds count in feeds/gaps; their open segment counts up to `now`; they're excluded from avgFeedMinutes.
 */
import { feedStart, sideMs } from './feed';
import type { DayMetrics, Feed, Metrics, MetricsBucket, MetricsBucketKind, MetricsOptions, MetricsRange, MetricsTotals } from './types';

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
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Monday 00:00 local of the week containing t. */
export function startOfLocalWeek(t: number): number {
  const d = startOfLocalDay(t);
  return addLocalDays(d, -((new Date(d).getDay() + 6) % 7));
}

/** 1st of the month 00:00 local, for the month containing t. */
export function startOfLocalMonth(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function nextLocalMonth(monthStart: number): number {
  const d = new Date(monthStart);
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
}

/** Resolve a MetricsRange to [first local midnight, exclusive end) plus the feed-start filter bounds. */
function resolveRange(range: MetricsRange, now: number, firstFeedAt: number | null) {
  const today = startOfLocalDay(now);
  const endOfToday = addLocalDays(today, 1);
  if (typeof range === 'number' || (typeof range === 'object' && 'days' in range)) {
    const n = Math.max(0, Math.floor(typeof range === 'number' ? range : range.days));
    const first = addLocalDays(today, -(n - 1));
    return n ? { first, end: endOfToday, lo: first, hi: endOfToday } : null;
  }
  if (range === 'all') {
    if (firstFeedAt === null) return null;
    const first = startOfLocalDay(Math.min(firstFeedAt, now));
    return { first, end: endOfToday, lo: first, hi: endOfToday };
  }
  const hi = range.to ?? endOfToday;
  if (!(hi > range.from)) return null;
  return { first: startOfLocalDay(range.from), end: addLocalDays(startOfLocalDay(hi - 1), 1), lo: range.from, hi };
}

const emptyDay = (dayStart: number): DayMetrics => ({
  date: localDateKey(dayStart),
  dayStart,
  breastMinutes: 0,
  minutesBySide: { L: 0, R: 0 },
  feeds: 0,
  breastFeeds: 0,
  bottleFeeds: 0,
  bottleOz: 0,
  bottleOzByMilk: { breast: 0, formula: 0, unspecified: 0 },
});

function sumDays(days: readonly DayMetrics[]): MetricsTotals {
  const sum = (k: (d: DayMetrics) => number) => days.reduce((a, d) => a + k(d), 0);
  return {
    breastMinutes: round1(sum((d) => d.breastMinutes)),
    minutesBySide: { L: round1(sum((d) => d.minutesBySide.L)), R: round1(sum((d) => d.minutesBySide.R)) },
    feeds: sum((d) => d.feeds),
    breastFeeds: sum((d) => d.breastFeeds),
    bottleFeeds: sum((d) => d.bottleFeeds),
    bottleOz: sum((d) => d.bottleOz),
  };
}

const mean = (xs: readonly number[]) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const fmt = (t: number, o: Intl.DateTimeFormatOptions) => new Date(t).toLocaleDateString('en-US', o);

/**
 * Chart metrics over a range of local calendar days.
 *
 *   computeMetrics(feeds, 7, now)                                     // original form (= { days: 7 })
 *   computeMetrics(feeds, 'all', now, { bucket: 'week', maxGapMinutes: 720 })
 *   computeMetrics(feeds, { from, to }, now, { bucket: 'month' })
 *
 * Gaps are start-to-start. Headline `avgGapMinutes`: consecutive feeds that both start in range (original rule).
 * Bucket `avgGapMinutes`: gaps whose LATER feed starts in the bucket (the earlier feed may be before the range).
 * With `maxGapMinutes` unset every gap counts (original behaviour); set it (UI: 720) to leave overnight/logging
 * holes longer than that out of both.
 */
export function computeMetrics(feeds: readonly Feed[], range: MetricsRange, now: number, opts: MetricsOptions = {}): Metrics {
  const bucket: MetricsBucketKind = opts.bucket ?? 'day';
  const maxGap = opts.maxGapMinutes ?? null;
  const live = feeds.filter((f) => !f.deleted);
  const allStarts = live.map(feedStart).sort((a, b) => a - b);
  const firstFeedAt = allStarts.length ? allStarts[0]! : null;
  const r = resolveRange(range, now, firstFeedAt);

  const days: DayMetrics[] = [];
  const index = new Map<string, DayMetrics>();
  if (r) {
    for (let t = r.first; t < r.end; t = addLocalDays(t, 1)) {
      const d = emptyDay(t);
      days.push(d);
      index.set(d.date, d);
    }
  }
  const inRange = r ? live.filter((f) => feedStart(f) >= r.lo && feedStart(f) < r.hi) : [];
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
  const rangeDays = days.length;
  const totals = sumDays(days);

  // Headline gap: between consecutive feeds that both start in range (original rule), optionally capped.
  const starts = inRange.map(feedStart).sort((a, b) => a - b);
  let avgGapMinutes: number | null;
  if (maxGap === null) {
    avgGapMinutes = starts.length >= 2 ? round1((starts[starts.length - 1]! - starts[0]!) / (starts.length - 1) / MIN) : null;
  } else {
    const kept: number[] = [];
    for (let i = 1; i < starts.length; i++) {
      const min = (starts[i]! - starts[i - 1]!) / MIN;
      if (min <= maxGap) kept.push(min);
    }
    avgGapMinutes = mean(kept);
  }
  // Bucket gaps: tagged with the LATER feed's start; its predecessor may be before the range (so the first day of
  // a range still gets its first gap), same cap.
  const gaps: Array<{ at: number; min: number }> = [];
  if (r) {
    for (let i = 1; i < allStarts.length; i++) {
      const at = allStarts[i]!;
      if (at < r.lo || at >= r.hi) continue;
      const min = (at - allStarts[i - 1]!) / MIN;
      if (maxGap === null || min <= maxGap) gaps.push({ at, min });
    }
  }
  const avgFeedMinutes = lengths.length ? round1(lengths.reduce((a, b) => a + b, 0) / lengths.length) : null;

  // Buckets
  const keyFn = bucket === 'day' ? (t: number) => t : bucket === 'week' ? startOfLocalWeek : startOfLocalMonth;
  const nextFn = bucket === 'day' ? (t: number) => addLocalDays(t, 1) : bucket === 'week' ? (t: number) => addLocalDays(t, 7) : nextLocalMonth;
  const groups = new Map<number, DayMetrics[]>();
  for (const d of days) {
    const k = keyFn(d.dayStart);
    const g = groups.get(k);
    if (g) g.push(d);
    else groups.set(k, [d]);
  }
  const multiYear = r ? new Date(r.first).getFullYear() !== new Date(r.end - 1).getFullYear() : false;
  const buckets: MetricsBucket[] = [...groups].map(([start, ds]) => {
    const end = nextFn(start);
    const n = ds.length;
    const fullDays = bucket === 'day' ? 1 : bucket === 'week' ? 7 : new Date(new Date(start).getFullYear(), new Date(start).getMonth() + 1, 0).getDate();
    const t = sumDays(ds);
    const label =
      bucket === 'day'
        ? fmt(start, { weekday: 'short', month: 'short', day: 'numeric', ...(multiYear ? { year: 'numeric' } : {}) })
        : bucket === 'week'
          ? `Week of ${fmt(start, { month: 'short', day: 'numeric', ...(multiYear ? { year: 'numeric' } : {}) })}`
          : fmt(start, { month: 'long', year: 'numeric' });
    return {
      kind: bucket,
      start,
      end,
      key: localDateKey(start),
      label,
      days: n,
      fullDays,
      partial: n < fullDays,
      totals: t,
      perDayAvg: {
        breastMinutes: round1(t.breastMinutes / n),
        minutesBySide: { L: round1(t.minutesBySide.L / n), R: round1(t.minutesBySide.R / n) },
        feeds: round1(t.feeds / n),
        bottleOz: round2(t.bottleOz / n),
      },
      avgGapMinutes: mean(gaps.filter((g) => g.at >= start && g.at < end).map((g) => g.min)),
    };
  });

  return {
    rangeDays,
    from: r ? r.first : null,
    to: r ? r.end : null,
    days,
    totals,
    perDayAvg: rangeDays
      ? { breastMinutes: round1(totals.breastMinutes / rangeDays), feeds: round1(totals.feeds / rangeDays), bottleOz: round1(totals.bottleOz / rangeDays) }
      : { breastMinutes: 0, feeds: 0, bottleOz: 0 },
    avgGapMinutes,
    avgFeedMinutes,
    firstFeedAt,
    bucket,
    buckets,
    maxGapMinutes: maxGap,
  };
}

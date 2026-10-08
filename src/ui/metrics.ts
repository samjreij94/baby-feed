/**
 * All-time chart aggregation (pure; no core import — the adapter feeds it core's per-day metrics).
 *
 * Day attribution is core's: a feed belongs to the local day it STARTED (core computeMetrics does this; we only
 * regroup its days). Range = first logged feed's local day → today, inclusive.
 *
 * Buckets: ≤ 31 days → one bar per day; otherwise Monday-start local weeks; more than 26 weeks → calendar months.
 * Week/month bars show the DAILY AVERAGE for that bucket (bucket total ÷ days of the bucket inside the range),
 * so bars stay comparable with each other and with the "/ day" stats. A partial first/last bucket is averaged
 * over the days it actually covers and flagged `partial` (drawn lighter, explained in a note).
 */

export const MIN = 60_000;
/** Gaps longer than this are treated as logging holes, not feeding intervals (same rule as the daily gap line). */
export const MAX_GAP_MIN = 12 * 60;
export const DAILY_MAX_DAYS = 31;
export const WEEKLY_MAX_WEEKS = 26;

export type Bucket = 'day' | 'week' | 'month';

/** Structural subset of core's DayMetrics. */
export interface DayIn {
  date: string; // YYYY-MM-DD local
  dayStart: number; // local midnight
  minutesBySide: { L: number; R: number };
  breastMinutes: number;
  feeds: number;
  bottleOz: number;
}

export interface BucketBar {
  key: string;
  /** Short axis tick: "8" (day), "Jun 15" (week), "Jun" (month). */
  tick: string;
  /** Full label: "Thu, Oct 8" / "Week of Jun 15" / "June 2026". */
  label: string;
  bucket: Bucket;
  /** Days of this bucket inside the range (the divisor for its averages). */
  days: number;
  /** Calendar length of the bucket (1, 7 or days-in-month). */
  fullDays: number;
  partial: boolean;
  /** Daily averages within the bucket (for 'day' buckets these are simply that day's values). */
  leftMin: number;
  rightMin: number;
  nursingMin: number;
  feeds: number;
  bottleOz: number;
  /** Mean of capped gaps whose later feed falls in this bucket; null if none. */
  avgGapMin: number | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

export function keyOf(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function localMidnight(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** Local midnight n calendar days later (DST-safe: calendar arithmetic, never 24h multiples). */
export function plusDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** Monday 00:00 local of the week containing t. */
export function weekStart(t: number): number {
  const d = new Date(localMidnight(t));
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  return plusDays(d.getTime(), -dow);
}
export function monthStart(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}
const daysInMonth = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };

/** Calendar days from the first feed's day through today, inclusive (0 when there are no feeds). */
export function rangeDayCount(firstFeedAt: number | null, now: number): number {
  if (firstFeedAt === null) return 0;
  const a = localMidnight(Math.min(firstFeedAt, now));
  const b = localMidnight(now);
  return Math.round((b - a) / 86_400_000) + 1; // round absorbs the ±1h of DST days
}

/** Number of Monday-start weeks touched by [firstDay, lastDay]. */
export function weekCount(firstDay: number, lastDay: number): number {
  return Math.round((weekStart(lastDay) - weekStart(firstDay)) / (7 * 86_400_000)) + 1;
}

export function chooseBucket(firstDay: number, lastDay: number): Bucket {
  const n = Math.round((localMidnight(lastDay) - localMidnight(firstDay)) / 86_400_000) + 1;
  if (n <= DAILY_MAX_DAYS) return 'day';
  return weekCount(firstDay, lastDay) > WEEKLY_MAX_WEEKS ? 'month' : 'week';
}

/** Consecutive start-to-start gaps ≤ MAX_GAP_MIN, each tagged with the later feed's start. */
export function cappedGaps(starts: readonly number[]): { at: number; min: number }[] {
  const s = [...starts].sort((a, b) => a - b);
  const out: { at: number; min: number }[] = [];
  for (let i = 1; i < s.length; i++) {
    const g = (s[i]! - s[i - 1]!) / MIN;
    if (g <= MAX_GAP_MIN) out.push({ at: s[i]!, min: g });
  }
  return out;
}
const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const fmtMonthDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtMonthDayYear = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Group contiguous days (oldest → newest, as core returns them) into bars.
 * `starts` = feed start times (for per-bucket gaps); only gaps whose later feed is inside the range count.
 */
export function bucketDays(days: readonly DayIn[], bucket: Bucket, starts: readonly number[] = []): BucketBar[] {
  if (!days.length) return [];
  const keyFn = bucket === 'day' ? (t: number) => t : bucket === 'week' ? weekStart : monthStart;
  const groups = new Map<number, DayIn[]>();
  for (const d of days) {
    const k = keyFn(d.dayStart);
    const g = groups.get(k);
    if (g) g.push(d); else groups.set(k, [d]);
  }
  const gapsBy = new Map<number, number[]>();
  const first = days[0]!.dayStart;
  const end = plusDays(days[days.length - 1]!.dayStart, 1);
  for (const g of cappedGaps(starts)) {
    if (g.at < first || g.at >= end) continue;
    const k = keyFn(localMidnight(g.at));
    const arr = gapsBy.get(k);
    if (arr) arr.push(g.min); else gapsBy.set(k, [g.min]);
  }
  const multiYear = new Date(first).getFullYear() !== new Date(end - 1).getFullYear();
  return [...groups].map(([k, ds]) => {
    const n = ds.length;
    const fullDays = bucket === 'day' ? 1 : bucket === 'week' ? 7 : daysInMonth(k);
    const sum = (f: (d: DayIn) => number) => ds.reduce((a, d) => a + f(d), 0);
    const avg = (f: (d: DayIn) => number) => sum(f) / n;
    const date = new Date(k);
    const mon = date.toLocaleDateString('en-US', { month: 'short' });
    const tick = bucket === 'day' ? String(date.getDate()) : bucket === 'week' ? fmtMonthDay(k) : multiYear && date.getMonth() === 0 ? `${mon} \u2019${String(date.getFullYear()).slice(2)}` : mon;
    const label = bucket === 'day'
      ? date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
      : bucket === 'week' ? `Week of ${multiYear ? fmtMonthDayYear(k) : fmtMonthDay(k)}` : date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const g = mean(gapsBy.get(k) ?? []);
    return {
      key: keyOf(k),
      tick,
      label,
      bucket,
      days: n,
      fullDays,
      partial: n < fullDays,
      leftMin: round1(avg((d) => d.minutesBySide.L)),
      rightMin: round1(avg((d) => d.minutesBySide.R)),
      nursingMin: round1(avg((d) => d.breastMinutes)),
      feeds: round1(avg((d) => d.feeds)),
      bottleOz: round2(avg((d) => d.bottleOz)),
      avgGapMin: g === null ? null : round1(g),
    };
  });
}

export interface AllTimeSummary {
  bucket: Bucket;
  bars: BucketBar[];
  /** Days in range (first feed's day → today, inclusive): the divisor for every "/ day" figure. */
  rangeDays: number;
  firstDay: string | null;
  totals: { leftMin: number; rightMin: number; nursingMin: number; feeds: number; bottleOz: number };
  perDay: { feeds: number; nursingMin: number; bottleOz: number };
  split: { L: number; R: number; leftMin: number; rightMin: number };
  /** Mean of all capped gaps between feeds in range; null if fewer than 2 feeds / no gap ≤ 12h. */
  avgGapMin: number | null;
  /** Bars that cover only part of their week/month. */
  partialBars: BucketBar[];
}

/** Everything the All-time charts need, from core's per-day metrics over the whole range plus feed starts. */
export function summarizeAllTime(days: readonly DayIn[], starts: readonly number[]): AllTimeSummary {
  const n = days.length;
  const bucket: Bucket = n ? chooseBucket(days[0]!.dayStart, days[n - 1]!.dayStart) : 'day';
  const bars = bucketDays(days, bucket, starts);
  const sum = (f: (d: DayIn) => number) => days.reduce((a, d) => a + f(d), 0);
  const leftMin = round1(sum((d) => d.minutesBySide.L));
  const rightMin = round1(sum((d) => d.minutesBySide.R));
  const totals = { leftMin, rightMin, nursingMin: round1(sum((d) => d.breastMinutes)), feeds: sum((d) => d.feeds), bottleOz: round2(sum((d) => d.bottleOz)) };
  const side = leftMin + rightMin;
  const inRange = n ? starts.filter((t) => t >= days[0]!.dayStart && t < plusDays(days[n - 1]!.dayStart, 1)) : [];
  const g = mean(cappedGaps(inRange).map((x) => x.min));
  return {
    bucket,
    bars,
    rangeDays: n,
    firstDay: n ? days[0]!.date : null,
    totals,
    perDay: n ? { feeds: round1(totals.feeds / n), nursingMin: round1(totals.nursingMin / n), bottleOz: round1(totals.bottleOz / n) } : { feeds: 0, nursingMin: 0, bottleOz: 0 },
    split: { L: side ? leftMin / side : 0, R: side ? rightMin / side : 0, leftMin, rightMin },
    avgGapMin: g === null ? null : round1(g),
    partialBars: bucket === 'day' ? [] : bars.filter((b) => b.partial),
  };
}

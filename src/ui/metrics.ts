/**
 * Chart bucket choice + axis-tick formatting (pure; no core import). The numbers themselves come from core's
 * computeMetrics/useMetrics (days, buckets, per-day averages, gaps) via the adapter.
 *
 * All-time bucket rule: ≤ 31 days → one bar per day; otherwise Monday-start local weeks; more than 26 weeks →
 * calendar months. Week/month bars show core's per-day average for that bucket (bucket total ÷ days of the bucket
 * inside the range); a partial first/last bucket is drawn lighter and explained in a note.
 */

/** Gaps longer than this are logging holes / long nights, not feeding intervals. Passed to core for every range. */
export const MAX_GAP_MIN = 12 * 60;
export const DAILY_MAX_DAYS = 31;
export const WEEKLY_MAX_WEEKS = 26;

export type Bucket = 'day' | 'week' | 'month';

/** dayCount = local calendar days in the range (inclusive); weekCount = Monday-start weeks it touches. */
export function chooseBucket(dayCount: number, weekCount: number): Bucket {
  if (dayCount <= DAILY_MAX_DAYS) return 'day';
  return weekCount > WEEKLY_MAX_WEEKS ? 'month' : 'week';
}

const fmtMonthDay = (t: number) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Short axis tick for an All-time bar starting at `start`: "8" (day), "Jun 15" (week), "Jun" / "Jan ’27" (month). */
export function barTick(bucket: Bucket, start: number, multiYear: boolean): string {
  const d = new Date(start);
  if (bucket === 'day') return String(d.getDate());
  if (bucket === 'week') return fmtMonthDay(start);
  const mon = d.toLocaleDateString('en-US', { month: 'short' });
  return multiYear && d.getMonth() === 0 ? `${mon} \u2019${String(d.getFullYear()).slice(2)}` : mon;
}

/** Groups history rows by local day (newest first) with per-day totals. No core imports. */
import { dateKey, dayLabel, fmtAmount, fmtMinShort, plural } from './format';
import type { HistoryDayVM, HistoryEntryVM, Units } from './types';

export function daySummary(entries: readonly HistoryEntryVM[], units: Units): string {
  const min = entries.reduce((a, e) => a + e.nursingMin, 0);
  const oz = entries.reduce((a, e) => a + (e.amountOz ?? 0), 0);
  const parts = [plural(entries.length, 'feed')];
  if (min > 0) parts.push(fmtMinShort(min));
  if (oz > 0) parts.push(fmtAmount(oz, units));
  return parts.join(' · ');
}

export function groupHistory(entries: readonly HistoryEntryVM[], now: number, units: Units = 'oz'): HistoryDayVM[] {
  const sorted = [...entries].sort((a, b) => b.at - a.at);
  const groups = new Map<string, HistoryEntryVM[]>();
  for (const e of sorted) {
    const k = dateKey(e.at);
    const g = groups.get(k);
    if (g) g.push(e);
    else groups.set(k, [e]);
  }
  return [...groups].map(([key, list]) => ({ key, label: dayLabel(key, now), summary: daySummary(list, units), entries: list }));
}

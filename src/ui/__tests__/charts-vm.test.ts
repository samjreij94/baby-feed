import { describe, expect, it } from 'vitest';
import { computeMetrics } from '../../core/metrics';
import type { BottleFeed, BreastFeed, Feed } from '../../core/types';
import { buildChartsVM, dailyGaps } from '../adapter';
import { niceMax, niceMinutes } from '../../components/Charts';

const MIN = 60_000;
const NOW = new Date(2026, 9, 8, 13, 0).getTime();
const at = (dayOffset: number, h: number, m = 0) => new Date(2026, 9, 8 + dayOffset, h, m).getTime();
const base = { householdId: null, deleted: false, loggedBy: { id: 'k', name: 'Karyn' }, deviceId: 'd' };
let n = 0;
const breast = (start: number, l: number, r: number): BreastFeed => ({
  ...base, id: `b${n++}`, createdAt: start, updatedAt: start, kind: 'breast', startedAt: start, endedAt: start + (l + r) * MIN, pausedAt: null, status: 'ended',
  segments: [{ side: 'L', startedAt: start, endedAt: start + l * MIN }, ...(r ? [{ side: 'R' as const, startedAt: start + l * MIN, endedAt: start + (l + r) * MIN }] : [])],
});
const bottle = (t: number, oz: number): BottleFeed => ({ ...base, id: `o${n++}`, createdAt: t, updatedAt: t, kind: 'bottle', at: t, amountOz: oz, milk: 'formula' });

const feeds: Feed[] = [
  breast(at(0, 1), 10, 5), breast(at(0, 4), 0, 12), bottle(at(0, 7), 3), // today: gaps 180, 180
  breast(at(-1, 2), 8, 8), breast(at(-1, 5), 6, 0), // yesterday: gap 180
  breast(at(-9, 2), 20, 20), // outside a 7-day range
];

describe('chart view-models', () => {
  const m = computeMetrics(feeds, 7, NOW);
  const starts = feeds.map((f) => (f.kind === 'breast' ? f.startedAt : f.at));
  const vm = buildChartsVM(m, starts, 7);

  it('one bar per day, oldest → newest, today last', () => {
    expect(vm.days).toHaveLength(7);
    expect(vm.days.at(-1)!.key).toBe('2026-10-08');
    expect(vm.days.at(-1)!.tick).toBe('T'); // Thursday
  });

  it('per-day nursing minutes, side split, feeds and bottle oz', () => {
    const today = vm.days.at(-1)!;
    expect(today).toMatchObject({ leftMin: 10, rightMin: 17, nursingMin: 27, feeds: 3, bottleOz: 3 });
    expect(vm.days.at(-2)!).toMatchObject({ leftMin: 14, rightMin: 8, feeds: 2, bottleOz: 0 });
    expect(vm.days[0]!).toMatchObject({ nursingMin: 0, feeds: 0 });
  });

  it('left/right share over the range sums to 1', () => {
    expect(vm.split.leftMin).toBe(24);
    expect(vm.split.rightMin).toBe(25);
    expect(vm.split.L + vm.split.R).toBeCloseTo(1);
    expect(vm.split.L).toBeCloseTo(24 / 49);
  });

  it('averages per day and average gap', () => {
    expect(vm.avg.feedsPerDay).toBe(0.7); // 5 / 7
    expect(vm.avg.bottleOzPerDay).toBe(0.4);
    expect(vm.avg.gapMin).toBe(m.avgGapMinutes);
    expect(vm.hasData).toBe(true);
  });

  it('daily average gap: attributed to the later feed’s day; > 12h logging holes ignored; null with no gaps', () => {
    expect(vm.days.at(-1)!.avgGapMin).toBe(180); // 20h hole (yesterday 05:00 → today 01:00) ignored
    expect(vm.days.at(-2)!.avgGapMin).toBe(180); // 8-day hole from the old feed ignored
    expect(dailyGaps([at(-1, 22), at(0, 1)], ['2026-10-08']).get('2026-10-08')).toBe(180); // overnight gap counts for the later day
    expect(vm.days[0]!.avgGapMin).toBeNull();
    const g = dailyGaps([at(0, 1), at(0, 3)], ['2026-10-08']);
    expect(g.get('2026-10-08')).toBe(120);
  });

  it('empty range → hasData false, split 0/0', () => {
    const e = buildChartsVM(computeMetrics([], 14, NOW), [], 14);
    expect(e.hasData).toBe(false);
    expect(e.split).toMatchObject({ L: 0, R: 0 });
    expect(e.days).toHaveLength(14);
    expect(e.days.at(-1)!.tick).toBe('8');
  });

  it('axis maxima are friendly', () => {
    expect(niceMax(8.3)).toBe(10);
    expect(niceMax(14.3)).toBe(20);
    expect(niceMinutes(27)).toBe(30);
    expect(niceMinutes(130)).toBe(180);
  });
});

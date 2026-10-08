/** All-time charts: bucketing, DST/month boundaries, partial buckets, hand-computed averages, empty + single feed. */
process.env.TZ = 'America/Chicago'; // week/DST assertions are local-time (US DST ends Sun Nov 1, 2026)
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CoreProvider, computeMetrics, FeedCore, type BottleFeed, type BreastFeed, type Feed } from '../../core';
import { ChartsScreen } from '../../screens/ChartsScreen';
import { buildAllTimeChartsVM, buildChartsVM } from '../adapter';
import { bucketDays, cappedGaps, chooseBucket, rangeDayCount, summarizeAllTime, weekCount, weekStart } from '../metrics';

const MIN = 60_000;
const T = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const base = { householdId: null, deleted: false, loggedBy: { id: 'k', name: 'Karyn' }, deviceId: 'd' };
let n = 0;
const breast = (start: number, l: number, r: number): BreastFeed => ({
  ...base, id: `b${n++}`, createdAt: start, updatedAt: start, kind: 'breast', startedAt: start, endedAt: start + (l + r) * MIN, pausedAt: null, status: 'ended',
  segments: [...(l ? [{ side: 'L' as const, startedAt: start, endedAt: start + l * MIN }] : []), ...(r ? [{ side: 'R' as const, startedAt: start + l * MIN, endedAt: start + (l + r) * MIN }] : [])],
});
const bottle = (t: number, oz: number): BottleFeed => ({ ...base, id: `o${n++}`, createdAt: t, updatedAt: t, kind: 'bottle', at: t, amountOz: oz, milk: 'formula' });
const start = (f: Feed) => (f.kind === 'breast' ? f.startedAt : f.at);
/** core per-day metrics from the first feed's day through `now` (exactly what the adapter does). */
const daysFor = (feeds: Feed[], now: number) => computeMetrics(feeds, rangeDayCount(Math.min(...feeds.map(start)), now), now).days;

describe('bucket choice by range length', () => {
  it('daily up to 31 days, then Mon-start weeks, months beyond 26 weeks', () => {
    expect(chooseBucket(T(2026, 10, 8), T(2026, 10, 8))).toBe('day'); // 1 day
    expect(chooseBucket(T(2026, 9, 8), T(2026, 10, 8))).toBe('day'); // 31 days
    expect(chooseBucket(T(2026, 9, 7), T(2026, 10, 8))).toBe('week'); // 32 days
    expect(weekCount(T(2026, 6, 15), T(2026, 12, 13))).toBe(26); // Mon Jun 15 … Sun Dec 13
    expect(chooseBucket(T(2026, 6, 15), T(2026, 12, 13))).toBe('week');
    expect(chooseBucket(T(2026, 6, 15), T(2026, 12, 14))).toBe('month'); // 27th week
    expect(chooseBucket(T(2026, 6, 17), T(2026, 10, 8))).toBe('week'); // Josephine: 114 days, 17 weeks
  });

  it('range day count is inclusive and DST-proof', () => {
    expect(rangeDayCount(null, T(2026, 10, 8))).toBe(0);
    expect(rangeDayCount(T(2026, 10, 8, 3), T(2026, 10, 8, 23))).toBe(1);
    expect(rangeDayCount(T(2026, 10, 31, 22), T(2026, 11, 2, 1))).toBe(3); // spans the 25h day (Nov 1)
    expect(rangeDayCount(T(2026, 3, 7, 12), T(2026, 3, 9, 12))).toBe(3); // spans the 23h day (Mar 8)
    expect(rangeDayCount(T(2026, 6, 17, 8), T(2026, 10, 8, 13))).toBe(114);
  });
});

describe('week boundaries across the DST change (Sun Nov 1, 2026)', () => {
  it('weeks start Monday 00:00 local on both sides of the change', () => {
    expect(weekStart(T(2026, 11, 1, 12))).toBe(T(2026, 10, 26));
    expect(weekStart(T(2026, 11, 1, 23, 59))).toBe(T(2026, 10, 26));
    expect(weekStart(T(2026, 11, 2, 0, 30))).toBe(T(2026, 11, 2));
    expect(T(2026, 11, 2) - T(2026, 10, 26)).toBe(7 * 86_400_000 + 3_600_000); // the 169-hour week
  });

  it('feeds either side of midnight Sun→Mon land in the right week; partial edges flagged', () => {
    const now = T(2026, 11, 10, 12);
    const feeds = [breast(T(2026, 10, 20, 9), 10, 10), breast(T(2026, 11, 1, 23, 30), 6, 0), breast(T(2026, 11, 2, 0, 15), 0, 8), bottle(T(2026, 11, 10, 8), 4)];
    const bars = bucketDays(daysFor(feeds, now), 'week', feeds.map(start));
    expect(bars.map((b) => [b.key, b.days, b.partial])).toEqual([
      ['2026-10-19', 6, true], // Tue Oct 20 – Sun Oct 25
      ['2026-10-26', 7, false], // incl. Sun Nov 1 (25h)
      ['2026-11-02', 7, false],
      ['2026-11-09', 2, true], // Mon Nov 9 – today
    ]);
    expect(bars[1]).toMatchObject({ tick: 'Oct 26', label: 'Week of Oct 26', leftMin: round1(6 / 7), feeds: round1(1 / 7) });
    expect(bars[2]).toMatchObject({ rightMin: round1(8 / 7), feeds: round1(1 / 7), avgGapMin: 45 }); // 23:30 → 00:15 gap counts in the later week
    expect(bars[3]).toMatchObject({ bottleOz: 2, feeds: 0.5 });
  });
});

const round1 = (x: number) => Math.round(x * 10) / 10;

describe('month boundaries', () => {
  it('calendar months with honest partial first/last months', () => {
    const now = T(2026, 8, 3, 12);
    const feeds = [breast(T(2026, 6, 17, 8), 14, 14), breast(T(2026, 6, 30, 23, 50), 31, 0), breast(T(2026, 7, 1, 0, 5), 0, 31), bottle(T(2026, 8, 3, 9), 3)];
    const bars = bucketDays(daysFor(feeds, now), 'month', feeds.map(start));
    expect(bars.map((b) => [b.key, b.tick, b.label, b.days, b.fullDays, b.partial])).toEqual([
      ['2026-06-01', 'Jun', 'June 2026', 14, 30, true], // Jun 17–30
      ['2026-07-01', 'Jul', 'July 2026', 31, 31, false],
      ['2026-08-01', 'Aug', 'August 2026', 3, 31, true],
    ]);
    // Jun 30 23:50 feed (crosses midnight) counts for June — core's start-day rule
    expect(bars[0]).toMatchObject({ leftMin: round1((14 + 31) / 14), rightMin: 1, feeds: round1(2 / 14) });
    expect(bars[1]).toMatchObject({ rightMin: 1, leftMin: 0, feeds: round1(1 / 31) });
    expect(bars[2]).toMatchObject({ bottleOz: 1, feeds: round1(1 / 3) });
  });
});

describe('hand-computed averages (All-time view-model on the real core metrics)', () => {
  // Range Wed Jun 17 → Wed Jul 22, 2026 = 14 + 22 = 36 days → weekly bars (6 weeks: Jun 15 … Jul 20).
  const now = T(2026, 7, 22, 15);
  const feeds = [
    breast(T(2026, 6, 17, 8), 10, 20), bottle(T(2026, 6, 17, 11), 3), // gap 180
    breast(T(2026, 7, 22, 9), 5, 5), // gap from Jun 17 11:00 ≫ 12h → left out
    bottle(T(2026, 7, 22, 12), 2.5), // gap 180
    bottle(T(2026, 7, 22, 14), 1), // gap 120
  ];
  const vm = buildAllTimeChartsVM(feeds, now);

  it('per-day = totals ÷ 36 days; L/R over the whole range; capped gap mean', () => {
    expect(vm).toMatchObject({ range: 'all', bucket: 'week', hasData: true });
    expect(vm.avg.feedsPerDay).toBe(round1(5 / 36)); // 0.1
    expect(vm.avg.nursingMinPerDay).toBe(round1(40 / 36)); // 1.1
    expect(vm.avg.bottleOzPerDay).toBe(round1(6.5 / 36)); // 0.2
    expect(vm.split).toEqual({ L: 15 / 40, R: 25 / 40, leftMin: 15, rightMin: 25 });
    expect(vm.avg.gapMin).toBe(160); // (180 + 180 + 120) / 3
    expect(vm.avg.feedMin).toBe(20); // (30 + 10) / 2 ended breast feeds
  });

  it('weekly bars are daily averages over the days each week covers', () => {
    expect(vm.days.map((d) => d.key)).toEqual(['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20']);
    expect(vm.days[0]).toMatchObject({ partial: true, nursingMin: 6, leftMin: 2, rightMin: 4, feeds: 0.4, bottleOz: 0.6, avgGapMin: 180 }); // ÷ 5 days
    expect(vm.days[1]).toMatchObject({ partial: false, nursingMin: 0, feeds: 0, avgGapMin: null });
    expect(vm.days[5]).toMatchObject({ partial: true, nursingMin: 3.3, feeds: 1, bottleOz: 1.17, avgGapMin: 150 }); // ÷ 3 days
    expect(vm.days[0]!.label).toBe('Week of Jun 15 (partial, 5 days), daily average');
    expect(vm.days[0]!.tick).toBe('Jun 15');
    expect(vm.allTime).toEqual({
      rangeText: 'Jun 17 – Jul 22, 2026 · 36 days',
      barCaption: 'Each bar is the daily average for that week (Mon–Sun)',
      partialNote: 'Faded bars are partial weeks, averaged over the days they cover (first week: 5 days, this week so far: 3 days).',
    });
  });

  it('bar averages × days add back up to the range totals', () => {
    const s = summarizeAllTime(daysFor(feeds, now), feeds.map(start));
    expect(s.rangeDays).toBe(36);
    const feedsBack = s.bars.reduce((a, b) => a + b.feeds * b.days, 0);
    expect(feedsBack).toBeCloseTo(5, 5);
    expect(s.totals).toEqual({ leftMin: 15, rightMin: 25, nursingMin: 40, feeds: 5, bottleOz: 6.5 });
  });

  it('gap rule: start-to-start, gaps over 12h dropped', () => {
    expect(cappedGaps([T(2026, 1, 1, 0), T(2026, 1, 1, 12), T(2026, 1, 2, 0, 1)]).map((g) => g.min)).toEqual([720]);
  });
});

describe('edge cases', () => {
  it('empty: no bars, zero averages, no gap', () => {
    const vm = buildAllTimeChartsVM([], T(2026, 10, 8, 12));
    expect(vm).toMatchObject({ range: 'all', bucket: 'day', days: [], hasData: false, avg: { feedsPerDay: 0, nursingMinPerDay: 0, bottleOzPerDay: 0, gapMin: null, feedMin: null } });
    expect(vm.allTime!.rangeText).toBe('No feeds yet');
  });

  it('a single feed today: one daily bar, per-day = that feed, no gap', () => {
    const now = T(2026, 10, 8, 12);
    const vm = buildAllTimeChartsVM([breast(T(2026, 10, 8, 7), 12, 8)], now);
    expect(vm.bucket).toBe('day');
    expect(vm.days).toHaveLength(1);
    expect(vm.days[0]).toMatchObject({ key: '2026-10-08', tick: '8', nursingMin: 20, feeds: 1 });
    expect(vm.avg).toMatchObject({ feedsPerDay: 1, nursingMinPerDay: 20, gapMin: null });
    expect(vm.allTime).toMatchObject({ rangeText: 'Oct 8 – Oct 8, 2026 · 1 day', barCaption: 'One bar per day', partialNote: null });
  });

  it('deleted feeds are ignored (also for the first-feed date)', () => {
    const now = T(2026, 10, 8, 12);
    const gone = { ...breast(T(2026, 6, 1, 7), 10, 10), deleted: true };
    const vm = buildAllTimeChartsVM([gone, bottle(T(2026, 10, 7, 9), 3)], now);
    expect(vm.allTime!.rangeText).toBe('Oct 7 – Oct 8, 2026 · 2 days');
    expect(vm.avg.bottleOzPerDay).toBe(1.5);
  });

  it('7/14/30 view-models are unchanged (daily bars from core metrics, no allTime block)', () => {
    const now = T(2026, 10, 8, 13);
    const feeds = [breast(T(2026, 10, 8, 1), 10, 5), breast(T(2026, 10, 8, 4), 0, 12)];
    const vm = buildChartsVM(computeMetrics(feeds, 7, now), feeds.map(start), 7);
    expect(vm.bucket).toBe('day');
    expect(vm.allTime).toBeUndefined();
    expect(vm.days).toHaveLength(7);
    expect(vm.days.at(-1)).toMatchObject({ tick: 'T', nursingMin: 27, feeds: 2, avgGapMin: 180 });
  });
});

describe('Charts screen: All option', () => {
  beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });

  it('defaults to 7 days; All shows the range note + "per week" captions and is remembered', async () => {
    const core = new FeedCore({ storage: 'memory', mirror: false, autoSync: false });
    await core.ready;
    const today = new Date(); today.setHours(9, 0, 0, 0);
    const day = 86_400_000;
    await core.importEntries([breast(today.getTime() - 60 * day, 10, 10), breast(today.getTime() - 2 * day, 5, 5), bottle(today.getTime(), 3)]);
    const ui = () => render(<CoreProvider core={core}><ChartsScreen units="oz" /></CoreProvider>);
    const { unmount } = ui();
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('all-time-note')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'All' })); });
    expect(screen.getByTestId('all-time-note')).toHaveTextContent(/61 days/);
    expect(screen.getByTestId('all-time-note')).toHaveTextContent(/daily average for that week/);
    expect(screen.getAllByText('Per week · daily average').length).toBe(3);
    expect(localStorage.getItem('bf.ui.chartRange.v1')).toBe('all');
    unmount();
    ui();
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    core.dispose();
  });

  it('All with no feeds shows a calm empty state and no charts', async () => {
    localStorage.setItem('bf.ui.chartRange.v1', 'all');
    const core = new FeedCore({ storage: 'memory', mirror: false, autoSync: false });
    await core.ready;
    render(<CoreProvider core={core}><ChartsScreen units="oz" /></CoreProvider>);
    expect(screen.getByText(/Charts start from your first feed/)).toBeInTheDocument();
    expect(screen.queryByText('Feeds per day')).toBeNull();
    core.dispose();
  });
});

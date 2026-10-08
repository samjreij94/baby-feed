import { beforeAll, describe, expect, it } from 'vitest';
import { computeMetrics, localDateKey } from '../metrics';
import type { BottleFeed, BreastFeed, Feed, Segment } from '../types';

// Device local time = America/Chicago for these tests (Node honours TZ changes at runtime).
beforeAll(() => {
  (globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'America/Chicago';
});

const MIN = 60_000;
const base = { householdId: 'h', createdAt: 0, updatedAt: 0, deleted: false, loggedBy: { id: 'm', name: 'Samir' }, deviceId: 'd' };
let n = 0;
const breast = (segs: Array<[('L' | 'R'), number, number | null]>, status: BreastFeed['status'] = 'ended'): BreastFeed => {
  const segments: Segment[] = segs.map(([side, s, e]) => ({ side, startedAt: s, endedAt: e }));
  return { ...base, id: `b${n++}`, kind: 'breast', startedAt: segments[0]!.startedAt, endedAt: status === 'ended' ? segments.at(-1)!.endedAt : null, segments, pausedAt: null, status };
};
const bottle = (at: number, amountOz: number, milk?: BottleFeed['milk']): BottleFeed => ({ ...base, id: `o${n++}`, kind: 'bottle', at, amountOz, ...(milk ? { milk } : {}) });
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('metrics', () => {
  it('TZ is America/Chicago', () => {
    expect(new Date(local(2026, 7, 1)).getTimezoneOffset()).toBe(300); // CDT
    expect(new Date(local(2026, 12, 1)).getTimezoneOffset()).toBe(360); // CST
  });

  it('7/14/30-day ranges end today and exclude older feeds', () => {
    const now = local(2026, 10, 8, 15);
    const feeds: Feed[] = [bottle(local(2026, 10, 8, 9), 2), bottle(local(2026, 10, 2, 9), 3), bottle(local(2026, 9, 25, 9), 4), bottle(local(2026, 9, 8, 9), 5)];
    const m7 = computeMetrics(feeds, 7, now);
    const m14 = computeMetrics(feeds, 14, now);
    const m30 = computeMetrics(feeds, 30, now);
    expect(m7.days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']);
    expect([m7.totals.bottleOz, m14.totals.bottleOz, m30.totals.bottleOz]).toEqual([5, 9, 9]);
    expect(m30.days).toHaveLength(30);
    expect(m30.days[0]!.date).toBe('2026-09-09');
    expect(computeMetrics(feeds, 31, now).totals.bottleOz).toBe(14);
  });

  it('a feed crossing midnight counts entirely on its start day', () => {
    const s = local(2026, 10, 7, 23, 50);
    const f = breast([['L', s, s + 15 * MIN], ['R', s + 15 * MIN, s + 30 * MIN]]);
    const m = computeMetrics([f], 7, local(2026, 10, 8, 12));
    const d7 = m.days.find((d) => d.date === '2026-10-07')!;
    expect(d7).toMatchObject({ breastMinutes: 30, minutesBySide: { L: 15, R: 15 }, feeds: 1, breastFeeds: 1 });
    expect(m.days.find((d) => d.date === '2026-10-08')!.breastMinutes).toBe(0);
  });

  it('DST fall-back day (Nov 1 2026) is one 25-hour bucket; spring-forward (Mar 8) is 23 hours', () => {
    const now = local(2026, 11, 3, 12);
    const late = local(2026, 11, 1, 23, 30); // 25h after local midnight
    const m = computeMetrics([bottle(late, 1), bottle(local(2026, 11, 1, 1, 30), 2)], 7, now);
    const i = m.days.findIndex((d) => d.date === '2026-11-01');
    expect(m.days[i + 1]!.dayStart - m.days[i]!.dayStart).toBe(25 * 60 * MIN);
    expect(m.days[i]!.bottleOz).toBe(3);
    expect(m.days.map((d) => d.date)).toEqual(['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
    const spring = computeMetrics([], 7, local(2026, 3, 10, 12));
    const j = spring.days.findIndex((d) => d.date === '2026-03-08');
    expect(spring.days[j + 1]!.dayStart - spring.days[j]!.dayStart).toBe(23 * 60 * MIN);
    expect(localDateKey(local(2026, 3, 8, 23, 59))).toBe('2026-03-08');
  });

  it('gaps (start to start), average feed length, per-day averages', () => {
    const t = local(2026, 10, 8, 6);
    const feeds: Feed[] = [
      breast([['L', t, t + 10 * MIN]]),
      bottle(t + 120 * MIN, 3),
      breast([['R', t + 300 * MIN, t + 320 * MIN]]),
    ];
    const m = computeMetrics(feeds, 7, local(2026, 10, 8, 20));
    expect(m.avgGapMinutes).toBe(150);
    expect(m.avgFeedMinutes).toBe(15);
    expect(m.totals).toMatchObject({ feeds: 3, breastFeeds: 2, bottleFeeds: 1, breastMinutes: 30, minutesBySide: { L: 10, R: 20 } });
    expect(m.perDayAvg.feeds).toBe(0.4);
    expect(computeMetrics([feeds[0]!], 7, t + 60 * MIN).avgGapMinutes).toBeNull();
  });

  it('running feeds count up to now but not in average length; deleted feeds ignored', () => {
    const t = local(2026, 10, 8, 10);
    const running = breast([['L', t, t + 5 * MIN], ['R', t + 5 * MIN, null]], 'running');
    const gone = { ...breast([['L', t - 60 * MIN, t - 40 * MIN]]), deleted: true };
    const m = computeMetrics([running, gone], 7, t + 12 * MIN);
    expect(m.totals.breastMinutes).toBe(12);
    expect(m.totals.minutesBySide).toEqual({ L: 5, R: 7 });
    expect(m.avgFeedMinutes).toBeNull();
    expect(m.totals.feeds).toBe(1);
  });

  it('bottle oz by milk type', () => {
    const t = local(2026, 10, 8, 8);
    const m = computeMetrics([bottle(t, 2, 'breast'), bottle(t + MIN, 3.5, 'formula'), bottle(t + 2 * MIN, 1.25)], 7, t + 3 * MIN);
    const d = m.days.at(-1)!;
    expect(d.bottleOz).toBe(6.75);
    expect(d.bottleOzByMilk).toEqual({ breast: 2, formula: 3.5, unspecified: 1.25 });
  });
});

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

  describe('ranges, buckets, maxGapMinutes (added)', () => {
    it("'all' runs from the first live feed's day through today; firstFeedAt ignores deleted feeds", () => {
      const now = local(2026, 10, 8, 15);
      const gone = { ...bottle(local(2026, 9, 1, 9), 9), deleted: true };
      const feeds: Feed[] = [gone, bottle(local(2026, 10, 3, 22), 2), bottle(local(2026, 10, 8, 7), 3)];
      const m = computeMetrics(feeds, 'all', now);
      expect(m.firstFeedAt).toBe(local(2026, 10, 3, 22));
      expect(m.rangeDays).toBe(6);
      expect(m.days[0]!.date).toBe('2026-10-03');
      expect(m.days.at(-1)!.date).toBe('2026-10-08');
      expect([m.from, m.to]).toEqual([local(2026, 10, 3), local(2026, 10, 9)]);
      expect(m.totals.bottleOz).toBe(5);
      expect(m.perDayAvg.bottleOz).toBe(0.8);
      // firstFeedAt is overall, also on a numeric range
      expect(computeMetrics(feeds, 1, now).firstFeedAt).toBe(local(2026, 10, 3, 22));
    });

    it("'all' with no feeds: no days, null gap, zero averages", () => {
      const m = computeMetrics([], 'all', local(2026, 10, 8, 15), { bucket: 'week' });
      expect(m).toMatchObject({ rangeDays: 0, days: [], buckets: [], firstFeedAt: null, from: null, to: null, avgGapMinutes: null });
      expect(m.perDayAvg).toEqual({ breastMinutes: 0, feeds: 0, bottleOz: 0 });
    });

    it('{ from, to } counts feeds with from ≤ start < to; days are the local days touched; to defaults to today', () => {
      const now = local(2026, 10, 8, 15);
      const feeds: Feed[] = [bottle(local(2026, 10, 1, 8), 1), bottle(local(2026, 10, 2, 8), 2), bottle(local(2026, 10, 4, 8), 4)];
      const m = computeMetrics(feeds, { from: local(2026, 10, 2), to: local(2026, 10, 4) }, now);
      expect(m.days.map((d) => d.date)).toEqual(['2026-10-02', '2026-10-03']);
      expect(m.totals.bottleOz).toBe(2);
      const open = computeMetrics(feeds, { from: local(2026, 10, 2) }, now);
      expect(open.days.at(-1)!.date).toBe('2026-10-08');
      expect(open.totals.bottleOz).toBe(6);
      // numeric and { days } forms are identical
      expect(computeMetrics(feeds, { days: 7 }, now)).toEqual(computeMetrics(feeds, 7, now));
    });

    it('week buckets start Monday; partial first/last weeks; totals + per-day averages per bucket', () => {
      // Thu Oct 1 … Thu Oct 15 2026 → weeks of Mon Sep 28 (4 days: Thu–Sun), Oct 5 (7), Oct 12 (4: Mon–Thu)
      const now = local(2026, 10, 15, 20);
      const feeds: Feed[] = [
        bottle(local(2026, 10, 1, 8), 2),
        breast([['L', local(2026, 10, 4, 9), local(2026, 10, 4, 9, 10)], ['R', local(2026, 10, 4, 9, 10), local(2026, 10, 4, 9, 30)]]),
        bottle(local(2026, 10, 5, 8), 3.5),
        bottle(local(2026, 10, 11, 23, 59), 1.5),
        bottle(local(2026, 10, 12, 0, 30), 1),
      ];
      const m = computeMetrics(feeds, 'all', now, { bucket: 'week' });
      expect(m.bucket).toBe('week');
      expect(m.buckets.map((b) => [b.key, b.days, b.fullDays, b.partial])).toEqual([
        ['2026-09-28', 4, 7, true],
        ['2026-10-05', 7, 7, false],
        ['2026-10-12', 4, 7, true],
      ]);
      const [w1, w2, w3] = m.buckets;
      expect(new Date(w1!.start).getDay()).toBe(1); // Monday
      expect(w1!.end).toBe(w2!.start);
      expect(w1!.label).toBe('Week of Sep 28');
      expect(w1!.totals).toEqual({ breastMinutes: 30, minutesBySide: { L: 10, R: 20 }, feeds: 2, breastFeeds: 1, bottleFeeds: 1, bottleOz: 2 });
      expect(w1!.perDayAvg).toEqual({ breastMinutes: 7.5, minutesBySide: { L: 2.5, R: 5 }, feeds: 0.5, bottleOz: 0.5 });
      expect(w2!.totals.bottleOz).toBe(5); // Sun 23:59 belongs to the week of Oct 5
      expect(w2!.perDayAvg.bottleOz).toBe(0.71);
      expect(w3!.totals.bottleOz).toBe(1); // Mon 00:30 starts the next week
      // bucket totals add up to the range totals
      expect(m.buckets.reduce((a, b) => a + b.totals.feeds, 0)).toBe(m.totals.feeds);
    });

    it('month buckets are calendar months; day buckets mirror days and are never partial', () => {
      const now = local(2026, 11, 10, 12);
      const feeds: Feed[] = [bottle(local(2026, 9, 20, 8), 2), bottle(local(2026, 10, 31, 23), 3), bottle(local(2026, 11, 1, 1), 4)];
      const m = computeMetrics(feeds, 'all', now, { bucket: 'month' });
      expect(m.buckets.map((b) => [b.label, b.days, b.fullDays, b.partial, b.totals.bottleOz])).toEqual([
        ['September 2026', 11, 30, true, 2],
        ['October 2026', 31, 31, false, 3],
        ['November 2026', 10, 30, true, 4],
      ]);
      const d = computeMetrics(feeds, 7, now);
      expect(d.bucket).toBe('day');
      expect(d.buckets).toHaveLength(7);
      expect(d.buckets.every((b) => b.days === 1 && b.fullDays === 1 && !b.partial)).toBe(true);
      expect(d.buckets.at(-1)!.label).toBe('Tue, Nov 10');
      expect(d.buckets.map((b) => b.key)).toEqual(d.days.map((x) => x.date));
    });

    it('maxGapMinutes leaves long gaps out of the headline; omitted keeps every gap (old behaviour)', () => {
      const t = local(2026, 10, 7, 20);
      // gaps: 180 (20:00→23:00), 900 overnight (23:00→14:00, > 720), 120 (14:00→16:00)
      const feeds: Feed[] = [bottle(t, 2), bottle(t + 180 * MIN, 2), bottle(t + 1080 * MIN, 2), bottle(t + 1200 * MIN, 2)];
      const now = t + 1300 * MIN;
      expect(computeMetrics(feeds, 7, now).avgGapMinutes).toBe(400); // (180 + 900 + 120) / 3
      const capped = computeMetrics(feeds, 7, now, { maxGapMinutes: 720 });
      expect(capped.avgGapMinutes).toBe(150); // (180 + 120) / 2
      expect(capped.maxGapMinutes).toBe(720);
      expect(computeMetrics(feeds, 7, now).maxGapMinutes).toBeNull();
      // only gaps > max are dropped (720 itself counts)
      expect(computeMetrics([bottle(t, 1), bottle(t + 720 * MIN, 1)], 7, now, { maxGapMinutes: 720 }).avgGapMinutes).toBe(720);
      // every gap too long → null
      expect(computeMetrics([bottle(t, 1), bottle(t + 721 * MIN, 1)], 7, now, { maxGapMinutes: 720 }).avgGapMinutes).toBeNull();
    });

    it("bucket gaps belong to the later feed's bucket; its predecessor may be before the range", () => {
      const now = local(2026, 10, 8, 12);
      const feeds: Feed[] = [bottle(local(2026, 10, 7, 23), 1), bottle(local(2026, 10, 8, 2), 1), bottle(local(2026, 10, 8, 5), 1)];
      const m = computeMetrics(feeds, 1, now, { maxGapMinutes: 720 });
      expect(m.buckets[0]!.avgGapMinutes).toBe(180); // 23:00→02:00 and 02:00→05:00
      expect(m.avgGapMinutes).toBe(180); // headline: in-range pair only (02:00→05:00)
      expect(computeMetrics(feeds, 2, now, { maxGapMinutes: 720 }).buckets[0]!.avgGapMinutes).toBeNull();
    });
  });
});

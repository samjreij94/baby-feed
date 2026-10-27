import { describe, expect, it } from 'vitest';
import {
  ageInDays, formatAge, formatWeight, G_PER_LB, gramsToLbOz, kgToGrams, lbOzToGrams, ordinal, validGrams, whoKg, whoLine, whoPercentile, whoZ,
  WHO_MAX_DAYS, WHO_PERCENTILES,
} from '../weight';
import { WHO_SOURCE, WHO_WFA_GIRLS_DAYS } from '../who-wfa-girls';
import { WHO_WFA_BOYS_DAYS } from '../who-wfa-boys';

describe('units', () => {
  it('lb/oz ↔ grams', () => {
    expect(lbOzToGrams(1, 0)).toBe(454);
    expect(lbOzToGrams(7, 4)).toBe(3289); // 7.25 lb
    expect(lbOzToGrams(0, 16)).toBe(Math.round(G_PER_LB));
    expect(gramsToLbOz(3289)).toEqual({ lb: 7, oz: 4 });
    expect(gramsToLbOz(lbOzToGrams(8, 3.5))).toEqual({ lb: 8, oz: 3.5 });
  });

  it('round-trips every 0.1 oz from 4 lb to 35 lb', () => {
    for (let tenth = 4 * 160; tenth <= 35 * 160; tenth++) {
      const lb = Math.floor(tenth / 160);
      const oz = (tenth - lb * 160) / 10;
      expect(gramsToLbOz(lbOzToGrams(lb, oz))).toEqual({ lb, oz });
    }
  });

  it('carries 15.96 oz into the next pound', () => {
    expect(gramsToLbOz(lbOzToGrams(7, 15.96))).toEqual({ lb: 8, oz: 0 });
  });

  it('kg', () => {
    expect(kgToGrams(3.295)).toBe(3295);
    expect(formatWeight(3290, 'kg')).toBe('3.29 kg');
    expect(formatWeight(3289, 'lb')).toBe('7 lb 4 oz');
    expect(formatWeight(lbOzToGrams(8, 3.5), 'lb')).toBe('8 lb 3.5 oz');
  });

  it('validGrams', () => {
    expect(validGrams(3500)).toBe(true);
    expect(validGrams(99)).toBe(false);
    expect(validGrams(30_001)).toBe(false);
    expect(validGrams(NaN)).toBe(false);
    expect(validGrams('3500')).toBe(false);
  });
});

describe('age', () => {
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
  it('counts calendar days from the birth date (DST-safe, time of day ignored)', () => {
    expect(ageInDays('2026-06-15', at(2026, 6, 15, 0))).toBe(0);
    expect(ageInDays('2026-06-15', at(2026, 6, 15, 23))).toBe(0);
    expect(ageInDays('2026-06-15', at(2026, 6, 16, 1))).toBe(1);
    expect(ageInDays('2026-06-15', at(2026, 11, 2))).toBe(140); // crosses the US DST change
    expect(ageInDays('2026-06-15', at(2026, 6, 14))).toBe(-1);
  });
  it('formatAge', () => {
    expect(formatAge(0)).toBe('0 days');
    expect(formatAge(1)).toBe('1 day');
    expect(formatAge(20)).toBe('2 wk');
    expect(formatAge(140)).toBe('4 mo 2 wk');
    expect(formatAge(400)).toBe('13 mo');
    expect(formatAge(-3)).toBe('before birth');
  });
  it('ordinal', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 50, 97].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '50th', '97th']);
  });
});

describe('WHO weight-for-age, girls (source: who.int)', () => {
  it('cites who.int and covers days 0..730', () => {
    expect(WHO_SOURCE.url).toMatch(/^https:\/\/www\.who\.int\//);
    expect(WHO_WFA_GIRLS_DAYS).toHaveLength(731);
    expect(WHO_MAX_DAYS).toBe(730);
    expect(WHO_PERCENTILES).toEqual([3, 15, 50, 85, 97]);
  });

  it('matches the published daily table at day 0 (P3 2.44 · P15 2.779 · P50 3.232 · P85 3.729 · P97 4.166)', () => {
    expect([3, 15, 50, 85, 97].map((p) => whoKg(p as 3, 0))).toEqual([2.44, 2.779, 3.232, 3.729, 4.166]);
    expect(WHO_WFA_GIRLS_DAYS[0]!.slice(5)).toEqual([0.3809, 3.2322, 0.14171]); // L, M, S
  });

  // WHO's monthly table (tab_wfa_girls_p_0_5.xlsx), rounded to 0.1 kg: P3 / P15 / P50 / P85 / P97
  it.each([
    [0, [2.4, 2.8, 3.2, 3.7, 4.2]],
    [1, [3.2, 3.6, 4.2, 4.8, 5.4]],
    [6, [5.8, 6.4, 7.3, 8.3, 9.2]],
    [12, [7.1, 7.9, 8.9, 10.2, 11.3]],
    [18, [8.2, 9.0, 10.2, 11.6, 13.0]],
    [24, [9.2, 10.1, 11.5, 13.1, 14.6]],
  ])('agrees with the published monthly table at month %i', (month, expected) => {
    const day = Math.round(month * 30.4375);
    const got = WHO_PERCENTILES.map((p) => whoKg(p, day));
    got.forEach((v, i) => expect(Math.abs(v - expected[i]!)).toBeLessThanOrEqual(0.051));
  });

  it('percentile lines never cross and rise with age on every day', () => {
    for (let d = 0; d <= WHO_MAX_DAYS; d++) {
      const row = WHO_WFA_GIRLS_DAYS[d]!;
      for (let i = 0; i < 4; i++) expect(row[i]!).toBeLessThan(row[i + 1]!);
    }
    for (const p of WHO_PERCENTILES) {
      const line = whoLine(p);
      expect(line[0]!.months).toBe(0);
      expect(line[line.length - 1]!.months).toBeCloseTo(24, 1);
      for (let i = 1; i < line.length; i++) expect(line[i]!.kg).toBeGreaterThan(line[i - 1]!.kg);
    }
  });

  it('interpolates fractional days between published rows and clamps outside the table', () => {
    expect(whoKg(50, 0.5)).toBeCloseTo((WHO_WFA_GIRLS_DAYS[0]![2]! + WHO_WFA_GIRLS_DAYS[1]![2]!) / 2, 6);
    expect(whoKg(50, -5)).toBe(whoKg(50, 0));
    expect(whoKg(50, 9999)).toBe(whoKg(50, 730));
  });

  it('LMS percentile reproduces the published percentile lines (to the table’s rounding)', () => {
    for (const d of [0, 30, 100, 182, 365, 540, 730]) {
      WHO_PERCENTILES.forEach((p, i) => {
        const kg = WHO_WFA_GIRLS_DAYS[d]![i]!;
        expect(Math.abs(whoPercentile(kg * 1000, d)! - p)).toBeLessThan(0.6);
      });
    }
    expect(whoZ(WHO_WFA_GIRLS_DAYS[200]![6]!, 200)).toBeCloseTo(0, 6); // weight = M → z = 0
    expect(whoPercentile(3232, 0)).toBeCloseTo(50, 0);
    expect(whoPercentile(3500, 800)).toBeNull(); // beyond 24 months
    expect(whoPercentile(3500, -1)).toBeNull();
  });
});

describe('WHO weight-for-age, boys (source: who.int)', () => {
  it('covers days 0..730 with the published day-0 and day-730 rows', () => {
    expect(WHO_WFA_BOYS_DAYS).toHaveLength(731);
    expect(WHO_WFA_BOYS_DAYS[0]).toEqual([2.507, 2.865, 3.346, 3.878, 4.35, 0.3487, 3.3464, 0.14602]);
    expect(WHO_WFA_BOYS_DAYS[730]).toEqual([9.802, 10.793, 12.148, 13.677, 15.065, -0.0136, 12.1482, 0.11425]);
    expect(WHO_PERCENTILES.map((p) => whoKg(p, 0, 'boys'))).toEqual([2.507, 2.865, 3.346, 3.878, 4.35]);
  });

  // WHO's monthly table (tab_wfa_boys_p_0_5.xlsx), rounded to 0.1 kg: P3 / P15 / P50 / P85 / P97
  it.each([
    [0, [2.5, 2.9, 3.3, 3.9, 4.3]],
    [1, [3.4, 3.9, 4.5, 5.1, 5.7]],
    [6, [6.4, 7.1, 7.9, 8.9, 9.7]],
    [12, [7.8, 8.6, 9.6, 10.8, 11.8]],
    [18, [8.9, 9.7, 10.9, 12.3, 13.5]],
    [24, [9.8, 10.8, 12.2, 13.7, 15.1]],
  ])('agrees with the published monthly table at month %i', (month, expected) => {
    const day = Math.round(month * 30.4375);
    WHO_PERCENTILES.forEach((p, i) => expect(Math.abs(whoKg(p, day, 'boys') - expected[i]!)).toBeLessThanOrEqual(0.06)); // month 24 sits half a day past the last daily row
  });

  it('percentile lines never cross; boys run heavier than girls at the median every day', () => {
    for (let d = 0; d <= WHO_MAX_DAYS; d++) {
      const row = WHO_WFA_BOYS_DAYS[d]!;
      for (let i = 0; i < 4; i++) expect(row[i]!).toBeLessThan(row[i + 1]!);
      expect(whoKg(50, d, 'boys')).toBeGreaterThan(whoKg(50, d, 'girls'));
    }
    for (const p of WHO_PERCENTILES) {
      const line = whoLine(p, 7, 'boys');
      expect(line[0]!.kg).toBe(WHO_WFA_BOYS_DAYS[0]![WHO_PERCENTILES.indexOf(p)]);
      expect(line[line.length - 1]!.months).toBeCloseTo(24, 1);
      for (let i = 1; i < line.length; i++) expect(line[i]!.kg).toBeGreaterThan(line[i - 1]!.kg);
    }
  });

  it('LMS percentile reproduces the boys percentile lines and follows the selected sex', () => {
    for (const d of [0, 30, 100, 182, 365, 540, 730]) {
      WHO_PERCENTILES.forEach((p, i) => {
        expect(Math.abs(whoPercentile(WHO_WFA_BOYS_DAYS[d]![i]! * 1000, d, 'boys')! - p)).toBeLessThan(0.6);
      });
    }
    expect(whoPercentile(3346.4, 0, 'boys')).toBeCloseTo(50, 0);
    expect(whoZ(WHO_WFA_BOYS_DAYS[200]![6]!, 200, 'boys')).toBeCloseTo(0, 6);
    // the same 7 kg baby at 6 months ranks higher against girls than boys
    const day = Math.round(6 * 30.4375);
    expect(whoPercentile(7000, day, 'girls')!).toBeGreaterThan(whoPercentile(7000, day, 'boys')!);
    expect(whoPercentile(7000, day)).toBe(whoPercentile(7000, day, 'girls')); // default is girls
    expect(whoPercentile(3500, 800, 'boys')).toBeNull();
  });
});

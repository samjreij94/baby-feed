/** Nara importer tests. All fixtures are SYNTHETIC (made-up caregivers, keys and times). */
import { describe, expect, it } from 'vitest';
import type { BottleFeed, BreastFeed, Feed, Member } from '../../types';
import { ML_PER_FLOZ, naraEntryId, naraEpochMs, naraSegments, parseNaraCsv, type NaraParseOptions } from '../nara';

// Subset of the real Nara header (column order doesn't matter to the importer).
const HEADER = [
  'Type',
  'Profile Name',
  'Start Date/time',
  'Start Date/time (Epoch)',
  'Created By Caregiver',
  'Last Updated By Caregiver',
  'Note',
  'Time Zone',
  '[Bottle Feed] Type',
  '[Bottle Feed] Breast Milk Volume',
  '[Bottle Feed] Breast Milk Volume Unit',
  '[Bottle Feed] Formula Name',
  '[Bottle Feed] Formula Volume',
  '[Bottle Feed] Formula Volume Unit',
  '[Bottle Feed] Volume',
  '[Bottle Feed] Volume Unit',
  '[Breastfeed] Begin Side',
  '[Breastfeed] End Side',
  '[Breastfeed] Left Duration (Seconds)',
  '[Breastfeed] Right Duration (Seconds)',
  '[Diaper] Type',
  '[Combo Feed] Begin Side',
  '[Combo Feed] End Side',
  '[Combo Feed] Left Duration (Seconds)',
  '[Combo Feed] Right Duration (Seconds)',
  '[Combo Feed] Type',
  '[Combo Feed] Breast Milk Volume',
  '[Combo Feed] Breast Milk Volume Unit',
  '[Combo Feed] Formula Volume',
  '[Combo Feed] Formula Volume Unit',
  '[Combo Feed] Volume',
  '[Combo Feed] Volume Unit',
  '_familyKey',
  '_profileKey',
  '_activityKey',
];

type Row = Record<string, string | number>;
const q = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
function csv(rows: Row[], o: { bom?: boolean; crlf?: boolean; header?: string[] } = {}): string {
  const h = o.header ?? HEADER;
  const nl = o.crlf ? '\r\n' : '\n';
  const lines = [h.map(q).join(','), ...rows.map((r) => h.map((c) => q(String(r[c] ?? ''))).join(','))];
  return (o.bom ? '\uFEFF' : '') + lines.join(nl) + nl;
}

const T0 = 1_750_000_000_000; // synthetic, ms
const ALEX: Member = { id: 'm-alex', name: 'Alex' };
const BLAKE: Member = { id: 'm-blake', name: 'Blake' };
const OPTS: NaraParseOptions = { me: ALEX, members: [ALEX, BLAKE], deviceId: 'dev-1', householdId: 'hh-1', now: T0 + 86_400_000 };

const breast = (key: string, begin: string, end: string, l: number | string, r: number | string, extra: Row = {}): Row => ({
  Type: 'Breastfeed',
  'Start Date/time (Epoch)': T0,
  'Created By Caregiver': 'Alex',
  'Time Zone': 'America/Chicago',
  '[Breastfeed] Begin Side': begin,
  '[Breastfeed] End Side': end,
  '[Breastfeed] Left Duration (Seconds)': l,
  '[Breastfeed] Right Duration (Seconds)': r,
  _activityKey: key,
  ...extra,
});
const bottle = (key: string, extra: Row): Row => ({
  Type: 'Bottle Feed',
  'Start Date/time (Epoch)': T0,
  'Created By Caregiver': 'Alex',
  _activityKey: key,
  ...extra,
});

const parse = (rows: Row[], opts = OPTS, fmt?: Parameters<typeof csv>[1]) => parseNaraCsv(csv(rows, fmt), opts);
const one = <T extends Feed>(rows: Row[]) => {
  const r = parse(rows);
  expect(r.entries).toHaveLength(1);
  return r.entries[0] as Feed as T;
};
const sideSec = (f: BreastFeed, side: 'L' | 'R') => f.segments.filter((s) => s.side === side).reduce((a, s) => a + (s.endedAt! - s.startedAt), 0) / 1000;
const segs = (f: BreastFeed) => f.segments.map((s) => [s.side, s.startedAt - T0, s.endedAt! - T0]);

describe('naraEntryId', () => {
  it('is a deterministic v5 UUID per key', () => {
    const a = naraEntryId('synthetic-key-1');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(naraEntryId('synthetic-key-1')).toBe(a);
    expect(naraEntryId('synthetic-key-2')).not.toBe(a);
    expect(naraEntryId('synthetic-key-1#breast')).not.toBe(a);
  });
});

describe('CSV shape', () => {
  const rows = [breast('k-a', 'LEFT', 'LEFT', 300, ''), { ...breast('k-b', 'RIGHT', 'RIGHT', '', 120), Note: 'first line\nsecond, "quoted" line' }];

  it('handles BOM + CRLF + a quoted multi-line note', () => {
    const r = parse(rows, OPTS, { bom: true, crlf: true });
    expect(r.preview.totalRows).toBe(2);
    expect(r.preview.imported.breast).toBe(2);
    expect((r.entries[1] as BreastFeed).note).toBe('first line\nsecond, "quoted" line');
    expect(r.preview.warnings).toEqual([]);
  });

  it('ignores blank lines and reads columns by name, in any order', () => {
    const header = [...HEADER].reverse();
    const text = csv(rows, { header }).replace('\n', '\n\n');
    const r = parseNaraCsv(text, OPTS);
    expect(r.preview.totalRows).toBe(2);
    expect(r.entries.map((e) => e.externalId)).toEqual(['k-a', 'k-b']);
  });

  it('throws on a file that is not a Nara export', () => {
    expect(() => parseNaraCsv('date,amount\n2026-01-01,4\n', OPTS)).toThrow(/Nara Baby export.*Type/);
    expect(() => parseNaraCsv('', OPTS)).toThrow(/Nara Baby export/);
  });
});

describe('breastfeed segments', () => {
  it('begin L, end R: L then R with exact per-side seconds', () => {
    const f = one<BreastFeed>([breast('k1', 'LEFT', 'RIGHT', 600, 420)]);
    expect(segs(f)).toEqual([
      ['L', 0, 600_000],
      ['R', 600_000, 1_020_000],
    ]);
    expect(f.startedAt).toBe(T0);
    expect(f.endedAt).toBe(T0 + 1_020_000);
    expect(f.status).toBe('ended');
    expect(f.pausedAt).toBeNull();
  });

  it('begin R, end L: R then L', () => {
    const f = one<BreastFeed>([breast('k1', 'RIGHT', 'LEFT', 200, 500)]);
    expect(segs(f)).toEqual([
      ['R', 0, 500_000],
      ['L', 500_000, 700_000],
    ]);
  });

  it('begin == end with both sides: begin side split in halves around the other (L, R, L)', () => {
    const f = one<BreastFeed>([breast('k1', 'LEFT', 'LEFT', 301, 100)]);
    expect(segs(f)).toEqual([
      ['L', 0, 150_500],
      ['R', 150_500, 250_500],
      ['L', 250_500, 401_000],
    ]);
    expect(sideSec(f, 'L')).toBe(301);
    expect(sideSec(f, 'R')).toBe(100);
  });

  it('same for R, R, and odd-ms halves still sum exactly', () => {
    const f = one<BreastFeed>([breast('k1', 'RIGHT', 'RIGHT', 60, 0.001)]);
    expect(f.segments.map((s) => s.side)).toEqual(['R', 'L', 'R']);
    expect(sideSec(f, 'R')).toBe(0.001);
    expect(sideSec(f, 'L')).toBe(60);
  });

  it('only one side has time: one segment (even if begin side is the other one)', () => {
    expect(segs(one<BreastFeed>([breast('k1', 'LEFT', 'LEFT', 480, '')]))).toEqual([['L', 0, 480_000]]);
    expect(segs(one<BreastFeed>([breast('k2', 'RIGHT', 'LEFT', 0, 90)]))).toEqual([['R', 0, 90_000]]);
    expect(segs(one<BreastFeed>([breast('k3', 'LEFT', 'RIGHT', '', 90)]))).toEqual([['R', 0, 90_000]]);
  });

  it("ignores Nara's '.nonTimer' end-side suffix", () => {
    const f = one<BreastFeed>([breast('k1', 'LEFT', 'RIGHT.nonTimer', 100, 50)]);
    expect(f.segments.map((s) => s.side)).toEqual(['L', 'R']);
    const g = one<BreastFeed>([breast('k2', 'LEFT', 'LEFT.nonTimer', 100, 50)]);
    expect(g.segments.map((s) => s.side)).toEqual(['L', 'R', 'L']);
  });

  it('zero total duration: imported with endedAt = startedAt and a warning', () => {
    const r = parse([breast('k1', 'RIGHT', 'RIGHT', 0, '')]);
    const f = r.entries[0] as BreastFeed;
    expect(f.endedAt).toBe(T0);
    expect(segs(f)).toEqual([['R', 0, 0]]);
    expect(r.preview.imported.breast).toBe(1);
    expect(r.preview.warnings.join()).toMatch(/1 × breastfeed\(s\) with zero duration/);
  });

  it('fractional seconds are kept to the ms', () => {
    expect(naraSegments(T0, 'L', 'R', 1.2345, 2).map((s) => s.endedAt! - s.startedAt)).toEqual([1235, 2000]);
  });

  it('preview totals equal the CSV sums', () => {
    const r = parse([breast('k1', 'LEFT', 'RIGHT', 600, 420), breast('k2', 'RIGHT', 'RIGHT', 33, 900), breast('k3', 'LEFT', 'LEFT', 75, '')]);
    expect(r.preview.totals.leftSec).toBe(600 + 33 + 75);
    expect(r.preview.totals.rightSec).toBe(420 + 900);
  });
});

describe('bottle feeds', () => {
  it('FLOZ breast milk volume → milk breast', () => {
    const b = one<BottleFeed>([bottle('b1', { '[Bottle Feed] Type': 'Breast Milk', '[Bottle Feed] Breast Milk Volume': 3.5, '[Bottle Feed] Breast Milk Volume Unit': 'FLOZ' })]);
    expect(b).toMatchObject({ kind: 'bottle', at: T0, amountOz: 3.5, milk: 'breast' });
    expect(b.note).toBeUndefined();
  });

  it('formula volume → milk formula', () => {
    const b = one<BottleFeed>([bottle('b1', { '[Bottle Feed] Type': 'Formula', '[Bottle Feed] Formula Volume': 2, '[Bottle Feed] Formula Volume Unit': 'FLOZ' })]);
    expect(b).toMatchObject({ amountOz: 2, milk: 'formula' });
  });

  it('generic Volume uses [Bottle Feed] Type for milk, or leaves it undefined', () => {
    const r = parse([
      bottle('b1', { '[Bottle Feed] Type': 'Formula', '[Bottle Feed] Volume': 4, '[Bottle Feed] Volume Unit': 'FLOZ' }),
      bottle('b2', { '[Bottle Feed] Volume': 5, '[Bottle Feed] Volume Unit': 'FLOZ' }),
    ]);
    expect((r.entries[0] as BottleFeed).milk).toBe('formula');
    expect(r.entries[1]).toMatchObject({ amountOz: 5 });
    expect('milk' in r.entries[1]!).toBe(false);
  });

  it('ML converts to oz (29.5735 mL/oz); exact conversions keep no note', () => {
    const b = one<BottleFeed>([bottle('b1', { '[Bottle Feed] Breast Milk Volume': ML_PER_FLOZ * 3, '[Bottle Feed] Breast Milk Volume Unit': 'ML' })]);
    expect(b.amountOz).toBe(3);
    expect(b.note).toBeUndefined();
  });

  it('appends the original to an existing note when rounding moves it > 0.05 oz', () => {
    const b = one<BottleFeed>([bottle('b1', { '[Bottle Feed] Breast Milk Volume': 120, '[Bottle Feed] Breast Milk Volume Unit': 'ML', Note: 'synthetic note' })]); // 4.0577 → 4
    expect(b.amountOz).toBe(4);
    expect(b.note).toBe('synthetic note · Nara: 120 mL');
  });

  it('rounds to 0.25 oz; > 0.05 oz change warns and keeps the original in the note', () => {
    const r = parse([
      bottle('b1', { '[Bottle Feed] Breast Milk Volume': 100, '[Bottle Feed] Breast Milk Volume Unit': 'ML' }), // 3.3814 oz → 3.5
      bottle('b2', { '[Bottle Feed] Breast Milk Volume': 118, '[Bottle Feed] Breast Milk Volume Unit': 'ml', Note: 'synthetic note' }), // 3.990 → 4 (within 0.05)
      bottle('b3', { '[Bottle Feed] Formula Volume': 0.1, '[Bottle Feed] Formula Volume Unit': 'FLOZ' }), // → min 0.25
    ]);
    const [a, b, c] = r.entries as BottleFeed[];
    expect(a!.amountOz).toBe(3.5);
    expect(a!.note).toBe('Nara: 100 mL');
    expect(b!.amountOz).toBe(4);
    expect(b!.note).toBe('synthetic note');
    expect(c!.amountOz).toBe(0.25);
    expect(c!.note).toBe('Nara: 0.1 fl oz');
    expect(r.preview.totals.bottleOz).toBe(7.75);
    expect(r.preview.warnings.some((w) => w.startsWith('2 × bottle amount(s) rounded'))).toBe(true);
  });

  it('both breast milk and formula → two bottles with suffixed ids', () => {
    const r = parse([
      bottle('b1', {
        '[Bottle Feed] Breast Milk Volume': 2,
        '[Bottle Feed] Breast Milk Volume Unit': 'FLOZ',
        '[Bottle Feed] Formula Volume': 1.5,
        '[Bottle Feed] Formula Volume Unit': 'FLOZ',
        '[Bottle Feed] Volume': 3.5,
        '[Bottle Feed] Volume Unit': 'FLOZ',
      }),
    ]);
    expect(r.preview.imported.bottle).toBe(1);
    expect(r.entries.map((e) => [e.id, (e as BottleFeed).milk, (e as BottleFeed).amountOz, e.externalId])).toEqual([
      [naraEntryId('b1#breast'), 'breast', 2, 'b1'],
      [naraEntryId('b1#formula'), 'formula', 1.5, 'b1'],
    ]);
  });

  it('missing unit assumes fl oz (warning); unknown unit or no volume skips the row', () => {
    const r = parse([
      bottle('b1', { '[Bottle Feed] Volume': 2 }),
      bottle('b2', { '[Bottle Feed] Volume': 2, '[Bottle Feed] Volume Unit': 'CUPS' }),
      bottle('b3', { '[Bottle Feed] Volume Unit': 'FLOZ' }),
    ]);
    expect(r.entries.map((e) => e.externalId)).toEqual(['b1']);
    expect(r.preview.skipped.invalid).toBe(2);
    const w = r.preview.warnings.join('\n');
    expect(w).toMatch(/1 × volume\(s\) without a unit/);
    expect(w).toMatch(/1 × feed row\(s\) skipped: unknown volume unit/);
    expect(w).toMatch(/1 × bottle row\(s\) skipped: no volume/);
  });
});

describe('combo feeds', () => {
  const combo = (extra: Row): Row => ({
    Type: 'Combo Feed',
    'Start Date/time (Epoch)': T0,
    'Created By Caregiver': 'Blake',
    '[Combo Feed] Begin Side': 'LEFT',
    '[Combo Feed] End Side': 'RIGHT',
    '[Combo Feed] Left Duration (Seconds)': 400,
    '[Combo Feed] Right Duration (Seconds)': 200,
    _activityKey: 'c1',
    ...extra,
  });

  it('splits into a breast feed and a bottle at the end of the breast part', () => {
    const r = parse([combo({ '[Combo Feed] Type': 'Formula', '[Combo Feed] Volume': 1.5, '[Combo Feed] Volume Unit': 'FLOZ' })]);
    expect(r.preview.imported).toEqual({ breast: 0, bottle: 0, combo: 1 });
    const [f, b] = r.entries as [BreastFeed, BottleFeed];
    expect(f.id).toBe(naraEntryId('c1#breast'));
    expect(segs(f)).toEqual([
      ['L', 0, 400_000],
      ['R', 400_000, 600_000],
    ]);
    expect(b).toMatchObject({ id: naraEntryId('c1#bottle'), kind: 'bottle', at: T0 + 600_000, amountOz: 1.5, milk: 'formula', externalId: 'c1' });
    expect(f.loggedBy).toEqual(BLAKE);
    expect(r.preview.totals).toEqual({ leftSec: 400, rightSec: 200, bottleOz: 1.5 });
  });

  it('a combo with no bottle volume imports the breast part only (warning)', () => {
    const r = parse([combo({ '[Combo Feed] Volume Unit': 'FLOZ' })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.kind).toBe('breast');
    expect(r.preview.imported.combo).toBe(1);
    expect(r.preview.warnings.join()).toMatch(/combo feed\(s\) without a bottle volume/);
  });

  it('a combo with no breast time imports the bottle at the start', () => {
    const r = parse([combo({ '[Combo Feed] Left Duration (Seconds)': '', '[Combo Feed] Right Duration (Seconds)': '', '[Combo Feed] Breast Milk Volume': 2, '[Combo Feed] Breast Milk Volume Unit': 'FLOZ' })]);
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ kind: 'bottle', at: T0, milk: 'breast', id: naraEntryId('c1#bottle') });
  });
});

describe('row handling', () => {
  it('counts byType and skips non-feed types without parsing them', () => {
    const r = parse([
      breast('k1', 'LEFT', 'LEFT', 60, ''),
      { Type: 'Diaper', 'Start Date/time (Epoch)': T0, '[Diaper] Type': 'Wet', _activityKey: 'd1' },
      { Type: 'Diaper', _activityKey: '' },
      { Type: 'Sleep', _activityKey: 's1' },
      { Type: 'Pump', _activityKey: 'p1' },
      { Type: 'Growth', _activityKey: 'g1' },
      { Type: 'Something New', _activityKey: 'x1' },
      { Type: '', _activityKey: 'x2' },
    ]);
    expect(r.preview.totalRows).toBe(8);
    expect(r.preview.byType).toEqual({ Breastfeed: 1, Diaper: 2, Sleep: 1, Pump: 1, Growth: 1, 'Something New': 1, '(no type)': 1 });
    expect(r.preview.skipped).toEqual({ Diaper: 2, Sleep: 1, Pump: 1, Growth: 1, 'Something New': 1, '(no type)': 1 });
    expect(r.preview.imported).toEqual({ breast: 1, bottle: 0, combo: 0 });
    expect(r.preview.warnings).toEqual([]);
  });

  it('maps caregivers: caregiverMap → case-insensitive member name → me', () => {
    const CASEY: Member = { id: 'm-casey', name: 'Casey' };
    const rows = [
      breast('k1', 'LEFT', 'LEFT', 60, '', { 'Created By Caregiver': 'blake' }),
      breast('k2', 'LEFT', 'LEFT', 60, '', { 'Created By Caregiver': 'Grandparent' }),
      breast('k3', 'LEFT', 'LEFT', 60, '', { 'Created By Caregiver': 'Nanny' }),
      breast('k4', 'LEFT', 'LEFT', 60, '', { 'Created By Caregiver': '' }),
    ];
    const r = parse(rows, { ...OPTS, caregiverMap: { grandparent: CASEY } });
    expect(r.entries.map((e) => e.loggedBy.id)).toEqual(['m-blake', 'm-casey', 'm-alex', 'm-alex']);
    expect(r.preview.caregivers).toEqual(['blake', 'Grandparent', 'Nanny']);
    expect(r.preview.warnings.join()).toMatch(/caregiver "Nanny" not matched/);
  });

  it('without `me`, unmatched caregivers get a stable placeholder member', () => {
    const r = parse([breast('k1', 'LEFT', 'LEFT', 60, '', { 'Created By Caregiver': 'Nanny' })], { ...OPTS, me: null });
    expect(r.entries[0]!.loggedBy).toEqual({ id: naraEntryId('caregiver:nanny'), name: 'Nanny' });
  });

  it('sets the entry base fields (deterministic id, nara source, versions = start epoch)', () => {
    const f = one<BreastFeed>([breast('k1', 'LEFT', 'LEFT', 60, '')]);
    expect(f).toMatchObject({
      id: naraEntryId('k1'),
      source: 'nara',
      externalId: 'k1',
      createdAt: T0,
      updatedAt: T0,
      deleted: false,
      deviceId: 'dev-1',
      householdId: 'hh-1',
      loggedBy: ALEX,
    });
  });

  it('re-parsing gives identical ids (independent of device / me)', () => {
    const rows = [breast('k1', 'LEFT', 'RIGHT', 60, 30), bottle('b1', { '[Bottle Feed] Volume': 2, '[Bottle Feed] Volume Unit': 'FLOZ' })];
    const a = parse(rows).entries.map((e) => e.id);
    const b = parse(rows, { ...OPTS, me: BLAKE, deviceId: 'dev-2', householdId: null }).entries.map((e) => e.id);
    expect(b).toEqual(a);
    expect(a).toEqual([naraEntryId('k1'), naraEntryId('b1')]);
  });

  it('dedupes repeated _activityKey rows (first kept)', () => {
    const r = parse([breast('k1', 'LEFT', 'LEFT', 60, ''), breast('k1', 'RIGHT', 'RIGHT', '', 999), breast('k2', 'LEFT', 'LEFT', 10, '')]);
    expect(r.entries.map((e) => e.externalId)).toEqual(['k1', 'k2']);
    expect((r.entries[0] as BreastFeed).segments[0]!.side).toBe('L');
    expect(r.preview.skipped.duplicate).toBe(1);
    expect(r.preview.imported.breast).toBe(2);
  });

  it('detects seconds vs ms epochs; Time Zone does not shift the epoch', () => {
    const r = parse([
      breast('k1', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': T0 / 1000, 'Time Zone': 'America/Denver' }),
      breast('k2', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': T0 + 1234 }),
    ]);
    expect(r.entries.map((e) => (e as BreastFeed).startedAt)).toEqual([T0, T0 + 1234]);
    expect(r.preview.dateRange).toEqual({ from: T0, to: T0 + 1234 });
    expect(naraEpochMs('1750000000.5', T0 * 2)).toBe(T0 + 500);
  });

  it('skips malformed rows with a warning: missing key, bad/missing/future time, bad duration', () => {
    const r = parse([
      breast('', 'LEFT', 'LEFT', 60, ''),
      breast('k2', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': 'not-a-time' }),
      breast('k3', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': '' }),
      breast('k4', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': T0 + 30 * 86_400_000 }),
      breast('k5', 'LEFT', 'LEFT', 'abc', ''),
      breast('k6', 'LEFT', 'LEFT', -5, ''),
      breast('ok', 'LEFT', 'LEFT', 60, ''),
    ]);
    expect(r.entries.map((e) => e.externalId)).toEqual(['ok']);
    expect(r.preview.skipped.invalid).toBe(6);
    expect(r.preview.imported.breast).toBe(1);
    const w = r.preview.warnings.join('\n');
    expect(w).toMatch(/1 × feed row\(s\) skipped: missing _activityKey \(row 2\)/);
    expect(w).toMatch(/3 × feed row\(s\) skipped: missing or invalid start time \(rows 3, 4, 5\)/);
    expect(w).toMatch(/2 × feed row\(s\) skipped: invalid duration/);
  });

  it('a skipped malformed key does not block a later valid row with the same key', () => {
    const r = parse([breast('k1', 'LEFT', 'LEFT', 60, '', { 'Start Date/time (Epoch)': 'x' }), breast('k1', 'LEFT', 'LEFT', 60, '')]);
    expect(r.entries).toHaveLength(1);
    expect(r.preview.skipped).toEqual({ invalid: 1 });
  });

  it('parses ~2,000 rows well under a second', () => {
    const rows: Row[] = [];
    for (let i = 0; i < 2000; i++) {
      rows.push(i % 3 ? breast(`k${i}`, 'LEFT', 'RIGHT', 300 + i, 200, { 'Start Date/time (Epoch)': T0 - i * 3_600_000 }) : { Type: 'Diaper', _activityKey: `d${i}` });
    }
    const text = csv(rows);
    const t = performance.now();
    const r = parseNaraCsv(text, OPTS);
    expect(performance.now() - t).toBeLessThan(500);
    expect(r.preview.totalRows).toBe(2000);
  });
});

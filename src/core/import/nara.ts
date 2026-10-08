/**
 * Nara Baby CSV importer (pure: no I/O, no store access). Lazy-loaded by useNaraImport().
 *
 * Decisions (see also the tests in __tests__/nara.test.ts):
 * - Time: 'Start Date/time (Epoch)' is the source of truth (seconds or ms auto-detected: < 1e11 ⇒ seconds).
 *   'Time Zone' is ignored — an epoch is absolute; display uses the device's local time like any entry.
 * - Breastfeed segments start at the row start: begin side first, then the other side. If begin === end side and
 *   both sides have time, the begin side is split in two halves around the other side (L, R, L). One side with
 *   time ⇒ one segment. Zero total ⇒ imported with a zero-length segment on the begin side (warning).
 *   Per-side ms = round(seconds × 1000) exactly, so per-side seconds match the CSV. Nara's '.nonTimer' side
 *   suffix (manual entry) is ignored.
 * - Bottle volumes: '[…] Breast Milk Volume' / '[…] Formula Volume' / '[…] Volume', each with its unit
 *   (FLOZ/OZ or ML; 1 fl oz = 29.5735 mL; missing unit ⇒ fl oz + warning). Rounded to the nearest 0.25 oz
 *   (minimum 0.25). When rounding moves the amount by > 0.05 oz, the original "Nara: <value> <unit>" is appended
 *   to the note and a warning is counted. If a row has BOTH breast milk and formula amounts it becomes TWO
 *   bottles (ids from key+'#breast' / key+'#formula'). Otherwise milk comes from the populated field, else
 *   from '[…] Type' (Breast Milk ⇒ 'breast', Formula ⇒ 'formula'), else undefined.
 * - Combo Feed: breast part id = naraEntryId(key+'#breast'), bottle part id = naraEntryId(key+'#bottle')
 *   (or '#bottle#breast' / '#bottle#formula' if it has both milks). The bottle sits at the END of the breast part.
 *   A combo with no bottle volume imports only the breast part (warning); one with no breast time only the bottle.
 * - Versions: createdAt = updatedAt = the row's start epoch, so any real edit/delete made in the app later
 *   (updatedAt = now) always wins LWW, and re-importing can never overwrite an edit or resurrect a tombstone.
 *   externalId = Nara's _activityKey on every part (parts share it; ids differ by suffix).
 * - loggedBy: 'Created By Caregiver' → caregiverMap (exact, then case-insensitive key) → member with the same
 *   name (case-insensitive) → opts.me → (no me) a stable placeholder member {id: naraEntryId('caregiver:'+name), name}.
 * - Rows: blank lines ignored; duplicate _activityKey feed rows keep the first (skipped.duplicate); feed rows with a
 *   missing key, bad time, bad duration or unusable volume are skipped (skipped.invalid). Every non-feed type
 *   (Diaper, Sleep, Pump, Growth, Vaccine, Profile, …) is only counted in skipped[type].
 * - Throws an Error if the header lacks Type / Start Date/time (Epoch) / _activityKey (not a Nara export).
 */
import type { BottleFeed, BreastFeed, Feed, Member, MemberRef, MilkType, Segment, Side } from '../types';
import { parseCsv } from './csv';
import { uuidV5 } from './uuid';

export interface NaraParseOptions {
  /** This device's member; fallback for unmatched caregivers. */
  me: Member | null;
  members: Member[];
  /** Nara caregiver name → household member. */
  caregiverMap?: Record<string, Member>;
  deviceId: string;
  householdId: string | null;
  /** Clock for the "start time in the future" sanity check (default Date.now()). */
  now?: number;
}

export interface NaraPreview {
  /** Non-blank data rows (header excluded). */
  totalRows: number;
  /** Rows per Nara 'Type' value (all rows). */
  byType: Record<string, number>;
  /** Source rows imported (a combo row counts once in `combo`, even though it yields 2 entries). */
  imported: { breast: number; bottle: number; combo: number };
  /** Rows not imported: non-feed types by Nara type name, plus 'invalid' and 'duplicate' feed rows. */
  skipped: Record<string, number>;
  /** Min/max start time of the produced entries. */
  dateRange: { from: number; to: number } | null;
  /** Distinct 'Created By Caregiver' values on imported rows, sorted. */
  caregivers: string[];
  /** Over all produced entries (combo parts included). bottleOz is the rounded amount actually imported. */
  totals: { leftSec: number; rightSec: number; bottleOz: number };
  /** Aggregated, human-readable ("3 bottle amounts …"). Up to 5 example row numbers each (header = row 1). */
  warnings: string[];
}

export type NaraFeed = Feed & { source: 'nara'; externalId: string };

/** Fixed namespace for Nara-derived ids. Never change it: ids must be stable across app versions and phones. */
export const NARA_NAMESPACE = '5b15a863-7373-4dfd-bd96-dddf31f36774';

/** Deterministic entry id for a Nara _activityKey (or a suffixed variant, e.g. key+'#breast'). */
export function naraEntryId(activityKey: string): string {
  return uuidV5(activityKey, NARA_NAMESPACE);
}

export const ML_PER_FLOZ = 29.5735;
const MAX_BOTTLE_OZ = 20;
const MIN_EPOCH_MS = Date.UTC(2000, 0, 1);
const FUTURE_SLACK_MS = 48 * 3600_000;

const C = {
  type: 'Type',
  epoch: 'Start Date/time (Epoch)',
  created: 'Created By Caregiver',
  note: 'Note',
  key: '_activityKey',
} as const;

type FeedType = 'breast' | 'bottle' | 'combo';
const FEED_TYPES: Record<string, FeedType> = { breastfeed: 'breast', 'bottle feed': 'bottle', 'combo feed': 'combo' };

const normType = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();

class Warnings {
  private m = new Map<string, number[]>();
  add(msg: string, row: number) {
    const rows = this.m.get(msg);
    if (rows) rows.push(row);
    else this.m.set(msg, [row]);
  }
  list(): string[] {
    return [...this.m].map(([msg, rows]) => {
      const ex = rows.slice(0, 5).join(', ') + (rows.length > 5 ? ', …' : '');
      return `${rows.length} × ${msg} (row${rows.length > 1 ? 's' : ''} ${ex})`;
    });
  }
}

/** Number from a CSV cell: '' ⇒ null, unparsable ⇒ NaN. Accepts a decimal comma. */
function num(s: string | undefined): number | null {
  const t = (s ?? '').trim();
  if (!t) return null;
  const v = Number(t.includes('.') ? t : t.replace(',', '.'));
  return Number.isFinite(v) ? v : NaN;
}

function parseSide(s: string | undefined): Side | null {
  const t = (s ?? '').trim().toUpperCase();
  if (t.startsWith('L')) return 'L';
  if (t.startsWith('R')) return 'R';
  return null;
}

/** Epoch cell → ms, or null if missing/invalid. < 1e11 ⇒ seconds. */
export function naraEpochMs(s: string | undefined, now: number): number | null {
  const v = num(s);
  if (v === null || Number.isNaN(v) || v <= 0) return null;
  const ms = Math.round(v < 1e11 ? v * 1000 : v);
  if (ms < MIN_EPOCH_MS || ms > now + FUTURE_SLACK_MS) return null;
  return ms;
}

/**
 * Segments for one breastfeed (exported for tests). Durations in seconds (≥ 0).
 * Returns closed segments starting at `start`; the last segment's endedAt = start + total.
 */
export function naraSegments(start: number, begin: Side | null, end: Side | null, leftSec: number, rightSec: number): Segment[] {
  const ms: Record<Side, number> = { L: Math.round(leftSec * 1000), R: Math.round(rightSec * 1000) };
  const b: Side = begin ?? (end && ms[end] > 0 && ms[end === 'L' ? 'R' : 'L'] === 0 ? end : ms.L > 0 || ms.R === 0 ? 'L' : 'R');
  const o: Side = b === 'L' ? 'R' : 'L';
  const parts: Array<[Side, number]> = [];
  if (ms[b] > 0 && ms[o] > 0) {
    if (end === b) {
      const first = Math.floor(ms[b] / 2);
      parts.push([b, first], [o, ms[o]], [b, ms[b] - first]);
    } else parts.push([b, ms[b]], [o, ms[o]]);
  } else if (ms[b] > 0) parts.push([b, ms[b]]);
  else if (ms[o] > 0) parts.push([o, ms[o]]);
  else parts.push([b, 0]);
  let t = start;
  return parts.map(([side, d]) => {
    const seg = { side, startedAt: t, endedAt: t + d };
    t += d;
    return seg;
  });
}

interface BottlePart {
  oz: number; // precise
  milk: MilkType | undefined;
  raw: string; // "4 FLOZ" for the precision note
  suffix: '' | '#breast' | '#formula';
}

type VolResult = { oz: number; raw: string } | null | 'bad-unit';

function volume(value: string | undefined, unit: string | undefined, w: Warnings, row: number): VolResult {
  const v = num(value);
  if (v === null || v === 0) return null;
  if (Number.isNaN(v) || v < 0) return 'bad-unit';
  const u = (unit ?? '').trim().toUpperCase().replace(/[\s.]/g, '');
  if (u === 'ML') return { oz: v / ML_PER_FLOZ, raw: `${v} mL` };
  if (u === 'FLOZ' || u === 'OZ') return { oz: v, raw: `${v} fl oz` };
  if (u === '') {
    w.add('volume(s) without a unit, assumed fl oz', row);
    return { oz: v, raw: `${v} fl oz` };
  }
  return 'bad-unit';
}

/** Bottle parts of a Bottle Feed / Combo Feed row. 'bad' = unusable volume (unknown unit / negative). */
function bottleParts(get: (col: string) => string | undefined, prefix: string, w: Warnings, row: number): BottlePart[] | 'bad' {
  const bm = volume(get(`${prefix}Breast Milk Volume`), get(`${prefix}Breast Milk Volume Unit`), w, row);
  const f = volume(get(`${prefix}Formula Volume`), get(`${prefix}Formula Volume Unit`), w, row);
  const tot = volume(get(`${prefix}Volume`), get(`${prefix}Volume Unit`), w, row);
  if (bm === 'bad-unit' || f === 'bad-unit' || tot === 'bad-unit') return 'bad';
  if (bm && f)
    return [
      { ...bm, milk: 'breast', suffix: '#breast' },
      { ...f, milk: 'formula', suffix: '#formula' },
    ];
  if (bm) return [{ ...bm, milk: 'breast', suffix: '' }];
  if (f) return [{ ...f, milk: 'formula', suffix: '' }];
  if (tot) {
    const t = normType(get(`${prefix}Type`) ?? '');
    const milk: MilkType | undefined = t.startsWith('breast') ? 'breast' : t.startsWith('formula') ? 'formula' : undefined;
    return [{ ...tot, milk, suffix: '' }];
  }
  return [];
}

const roundQuarter = (oz: number) => Math.max(0.25, Math.round(oz * 4) / 4);

export function parseNaraCsv(text: string, opts: NaraParseOptions): { preview: NaraPreview; entries: NaraFeed[] } {
  const now = opts.now ?? Date.now();
  const rows = parseCsv(text);
  const header = (rows[0] ?? []).map((h) => h.trim());
  const idx = new Map<string, number>();
  header.forEach((h, i) => {
    if (!idx.has(h)) idx.set(h, i);
    const lc = h.toLowerCase();
    if (!idx.has(lc)) idx.set(lc, i);
  });
  for (const col of [C.type, C.epoch, C.key]) {
    if (!idx.has(col) && !idx.has(col.toLowerCase())) throw new Error(`This doesn't look like a Nara Baby export (missing column "${col}")`);
  }
  const colIdx = (col: string) => idx.get(col) ?? idx.get(col.toLowerCase());

  const w = new Warnings();
  const byType: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  const imported = { breast: 0, bottle: 0, combo: 0 };
  const entries: NaraFeed[] = [];
  const seen = new Set<string>();
  const caregivers = new Set<string>();
  const totals = { leftMs: 0, rightMs: 0, bottleOz: 0 };
  let totalRows = 0;
  let from = Infinity;
  let to = -Infinity;
  const skip = (k: string) => (skipped[k] = (skipped[k] ?? 0) + 1);

  // caregiver → MemberRef (cached)
  const members = opts.members ?? [];
  const mapLc = new Map(Object.entries(opts.caregiverMap ?? {}).map(([k, v]) => [k.trim().toLowerCase(), v]));
  const who = new Map<string, MemberRef>();
  const resolve = (name: string, row: number): MemberRef => {
    let m = who.get(name);
    if (m) return m;
    const lc = name.toLowerCase();
    const hit = opts.caregiverMap?.[name] ?? mapLc.get(lc) ?? (lc ? members.find((x) => x.name.trim().toLowerCase() === lc) : undefined);
    if (hit) m = { id: hit.id, name: hit.name };
    else {
      if (name) w.add(`caregiver "${name}" not matched to a household member`, row);
      m = opts.me ? { id: opts.me.id, name: opts.me.name } : { id: naraEntryId(`caregiver:${lc}`), name: name || 'Nara' };
    }
    who.set(name, m);
    return m;
  };

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r]!;
    if (cells.length === 1 && cells[0]!.trim() === '') continue; // blank line
    totalRows++;
    const rowNo = r + 1;
    const get = (col: string): string | undefined => {
      const i = colIdx(col);
      return i === undefined ? undefined : cells[i];
    };
    const typeRaw = (get(C.type) ?? '').trim() || '(no type)';
    byType[typeRaw] = (byType[typeRaw] ?? 0) + 1;
    const ft = FEED_TYPES[normType(typeRaw)];
    if (!ft) {
      skip(typeRaw);
      continue;
    }
    if (cells.length !== header.length) w.add(`feed row(s) with ${cells.length} columns instead of ${header.length} (parsed anyway)`, rowNo);

    const key = (get(C.key) ?? '').trim();
    if (!key) {
      skip('invalid');
      w.add('feed row(s) skipped: missing _activityKey', rowNo);
      continue;
    }
    if (seen.has(key)) {
      skip('duplicate');
      w.add('duplicate _activityKey row(s) skipped (first kept)', rowNo);
      continue;
    }
    const start = naraEpochMs(get(C.epoch), now);
    if (start === null) {
      skip('invalid');
      w.add('feed row(s) skipped: missing or invalid start time', rowNo);
      continue;
    }

    // ── parse parts first, only emit if the row is valid ──
    const prefix = ft === 'breast' ? '[Breastfeed] ' : ft === 'combo' ? '[Combo Feed] ' : '[Bottle Feed] ';
    let segments: Segment[] | null = null;
    let breastMs = 0;
    if (ft !== 'bottle') {
      const l = num(get(`${prefix}Left Duration (Seconds)`));
      const rt = num(get(`${prefix}Right Duration (Seconds)`));
      if ((l !== null && (Number.isNaN(l) || l < 0)) || (rt !== null && (Number.isNaN(rt) || rt < 0))) {
        skip('invalid');
        w.add('feed row(s) skipped: invalid duration', rowNo);
        continue;
      }
      const begin = parseSide(get(`${prefix}Begin Side`));
      const end = parseSide(get(`${prefix}End Side`));
      if ((l ?? 0) + (rt ?? 0) > 0 || ft === 'breast') {
        if (ft === 'breast' && (l ?? 0) + (rt ?? 0) === 0) w.add('breastfeed(s) with zero duration (imported, endedAt = startedAt)', rowNo);
        if (!begin && !end && (l ?? 0) > 0 && (rt ?? 0) > 0) w.add('breastfeed(s) without side order (assumed left first)', rowNo);
        segments = naraSegments(start, begin, end, l ?? 0, rt ?? 0);
        breastMs = segments[segments.length - 1]!.endedAt! - start;
      }
    }
    let bottles: BottlePart[] = [];
    if (ft !== 'breast') {
      const p = bottleParts(get, prefix, w, rowNo);
      if (p === 'bad') {
        skip('invalid');
        w.add('feed row(s) skipped: unknown volume unit or negative volume', rowNo);
        continue;
      }
      const tooBig = p.filter((b) => roundQuarter(b.oz) > MAX_BOTTLE_OZ);
      if (tooBig.length) w.add(`bottle amount(s) over ${MAX_BOTTLE_OZ} oz skipped`, rowNo);
      bottles = p.filter((b) => roundQuarter(b.oz) <= MAX_BOTTLE_OZ);
      if (!bottles.length && !tooBig.length) {
        if (ft === 'bottle') w.add('bottle row(s) skipped: no volume', rowNo);
        else w.add('combo feed(s) without a bottle volume (breast part only)', rowNo);
      }
    }
    if (!segments && !bottles.length) {
      skip('invalid');
      if (ft === 'combo') w.add('combo feed(s) skipped: no breast time and no bottle volume', rowNo);
      continue;
    }

    seen.add(key);
    const caregiver = (get(C.created) ?? '').trim();
    if (caregiver) caregivers.add(caregiver);
    const base = {
      householdId: opts.householdId,
      createdAt: start,
      updatedAt: start,
      deleted: false,
      loggedBy: resolve(caregiver, rowNo),
      deviceId: opts.deviceId,
      source: 'nara' as const,
      externalId: key,
    };
    const note = (get(C.note) ?? '').trim() || undefined;
    const span = (t: number) => {
      if (t < from) from = t;
      if (t > to) to = t;
    };

    if (segments) {
      const id = naraEntryId(ft === 'combo' ? `${key}#breast` : key);
      const fe: BreastFeed & { source: 'nara'; externalId: string } = {
        ...base,
        id,
        kind: 'breast',
        startedAt: start,
        endedAt: start + breastMs,
        segments,
        pausedAt: null,
        status: 'ended',
        ...(note ? { note } : {}),
      };
      for (const s of segments) {
        const d = s.endedAt! - s.startedAt;
        if (s.side === 'L') totals.leftMs += d;
        else totals.rightMs += d;
      }
      entries.push(fe);
      span(start);
    }
    const at = start + breastMs;
    for (const b of bottles) {
      const oz = roundQuarter(b.oz);
      let bNote = ft === 'bottle' ? note : undefined;
      if (Math.abs(oz - b.oz) > 0.05) {
        w.add('bottle amount(s) rounded to the nearest 0.25 oz by more than 0.05 oz (original kept in the note)', rowNo);
        bNote = [bNote, `Nara: ${b.raw}`].filter(Boolean).join(' · ');
      }
      const idKey = ft === 'combo' ? `${key}#bottle${b.suffix}` : `${key}${b.suffix}`;
      const be: BottleFeed & { source: 'nara'; externalId: string } = {
        ...base,
        id: naraEntryId(idKey),
        kind: 'bottle',
        at,
        amountOz: oz,
        ...(b.milk ? { milk: b.milk } : {}),
        ...(bNote ? { note: bNote } : {}),
      };
      totals.bottleOz += oz;
      entries.push(be);
      span(at);
    }
    imported[ft]++;
  }

  return {
    preview: {
      totalRows,
      byType,
      imported,
      skipped,
      dateRange: entries.length ? { from, to } : null,
      caregivers: [...caregivers].sort((a, b) => a.localeCompare(b)),
      totals: { leftSec: totals.leftMs / 1000, rightSec: totals.rightMs / 1000, bottleOz: totals.bottleOz },
      warnings: w.list(),
    },
    entries,
  };
}

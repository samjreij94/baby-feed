/**
 * Validate the Nara importer against a REAL export, locally. Prints aggregates only (never rows, notes or keys).
 *   npx vite-node scripts/validate-nara.ts /path/to/nara-export.csv
 * Never commit the export itself (.gitignore excludes *.csv).
 */
import { readFileSync } from 'node:fs';
import { parseCsv } from '../src/core/import/csv';
import { ML_PER_FLOZ, parseNaraCsv } from '../src/core/import/nara';
import type { Member } from '../src/core/types';

const path = process.argv[2];
if (!path) {
  console.error('usage: vite-node scripts/validate-nara.ts <nara-export.csv>');
  process.exit(2);
}
const text = readFileSync(path, 'utf8');
// Household members = the caregivers found in the file (no names hard-coded here).
const found = parseNaraCsv(text, { me: null, members: [], deviceId: 'validate-device', householdId: null }).preview.caregivers;
const members: Member[] = found.map((name, i) => ({ id: `member-${i}`, name }));
const me: Member = members[0] ?? { id: 'member-me', name: 'Me' };
const opts = { me, members, deviceId: 'validate-device', householdId: null };

const t0 = performance.now();
const a = parseNaraCsv(text, opts);
const ms = performance.now() - t0;
const b = parseNaraCsv(text, { ...opts, deviceId: 'other-device', me: members[1] ?? me });
const p = a.preview;

// ── independent sums straight from the CSV columns ──
const rows = parseCsv(text);
const hdr = rows[0]!.map((h) => h.trim());
const col = (name: string) => hdr.indexOf(name);
const n = (s: string | undefined) => (s && s.trim() ? Number(s) : 0);
const toOz = (v: string | undefined, u: string | undefined) => (u?.trim().toUpperCase() === 'ML' ? n(v) / ML_PER_FLOZ : n(v));
let csvL = 0, csvR = 0, csvOz = 0;
for (const r of rows.slice(1)) {
  const t = r[col('Type')]?.trim();
  for (const pre of t === 'Breastfeed' ? ['[Breastfeed] '] : t === 'Combo Feed' ? ['[Combo Feed] '] : []) {
    csvL += n(r[col(`${pre}Left Duration (Seconds)`)]);
    csvR += n(r[col(`${pre}Right Duration (Seconds)`)]);
  }
  for (const pre of t === 'Bottle Feed' ? ['[Bottle Feed] '] : t === 'Combo Feed' ? ['[Combo Feed] '] : []) {
    const bm = toOz(r[col(`${pre}Breast Milk Volume`)], r[col(`${pre}Breast Milk Volume Unit`)]);
    const f = toOz(r[col(`${pre}Formula Volume`)], r[col(`${pre}Formula Volume Unit`)]);
    csvOz += bm || f ? bm + f : toOz(r[col(`${pre}Volume`)], r[col(`${pre}Volume Unit`)]);
  }
}

// ── sums from the produced entries ──
let segL = 0, segR = 0, entOz = 0, breastEntries = 0, bottleEntries = 0;
for (const e of a.entries) {
  if (e.kind === 'breast') {
    breastEntries++;
    for (const s of e.segments) {
      if (s.side === 'L') segL += s.endedAt! - s.startedAt;
      else segR += s.endedAt! - s.startedAt;
    }
  } else {
    bottleEntries++;
    entOz += e.amountOz;
  }
}
segL /= 1000;
segR /= 1000;

const fmt = (t: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }).format(t) + ' CT';
const ids = (x: typeof a) => x.entries.map((e) => e.id).join();
const uniq = new Set(a.entries.map((e) => e.id)).size;
const ok = (c: boolean) => (c ? 'OK ' : 'FAIL');

console.log(`parse time: ${ms.toFixed(1)} ms`);
console.log(`rows: ${p.totalRows}`);
console.log('by type:', JSON.stringify(p.byType));
console.log('imported rows:', JSON.stringify(p.imported), `→ entries: ${a.entries.length} (breast ${breastEntries}, bottle ${bottleEntries})`);
console.log('skipped:', JSON.stringify(p.skipped));
console.log('date range:', p.dateRange ? `${fmt(p.dateRange.from)} → ${fmt(p.dateRange.to)}` : 'none');
console.log('caregivers:', p.caregivers.join(', '));
console.log(`left  sec: CSV ${csvL}  segments ${segL}  preview ${p.totals.leftSec}  ${ok(csvL === segL && segL === p.totals.leftSec)}`);
console.log(`right sec: CSV ${csvR}  segments ${segR}  preview ${p.totals.rightSec}  ${ok(csvR === segR && segR === p.totals.rightSec)}`);
console.log(`bottle oz: CSV ${+csvOz.toFixed(4)}  entries (rounded) ${entOz}  preview ${p.totals.bottleOz}  diff ${+(entOz - csvOz).toFixed(4)}`);
console.log(`expected counts 846/88/1: ${ok(p.imported.breast === 846 && p.imported.bottle === 88 && p.imported.combo === 1)}`);
console.log(`ids identical on re-parse (different device/me): ${ok(ids(a) === ids(b))}; unique ids: ${ok(uniq === a.entries.length)} (${uniq})`);
console.log(`warnings (${p.warnings.length}):`);
for (const x of p.warnings) console.log('  -', x.replace(/ \(rows? .*\)$/, '')); // counts only, no row numbers

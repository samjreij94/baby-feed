/**
 * Weight helpers (pure): unit conversion, validation, age, and WHO weight-for-age (girls) lookups.
 * Weights are stored as integer grams; lb/oz and kg are only input/display conversions.
 */
import { WHO_PERCENTILES, WHO_WFA_GIRLS_DAYS, type WhoPercentile } from './who-wfa-girls';

export const G_PER_LB = 453.59237;
export const G_PER_OZ = G_PER_LB / 16; // 28.349523125
export const MIN_GRAMS = 100;
export const MAX_GRAMS = 30_000;
export const DAYS_PER_MONTH = 30.4375; // 365.25 / 12 (WHO's month length)
/** The WHO tables used here cover completed days 0..730 (24 months). */
export const WHO_MAX_DAYS = WHO_WFA_GIRLS_DAYS.length - 1;
export const WHO_MAX_MONTHS = 24;

export const validGrams = (g: unknown): g is number => typeof g === 'number' && Number.isFinite(g) && g >= MIN_GRAMS && g <= MAX_GRAMS;

export const lbOzToGrams = (lb: number, oz: number): number => Math.round(lb * G_PER_LB + oz * G_PER_OZ);
export const kgToGrams = (kg: number): number => Math.round(kg * 1000);
export const gramsToKg = (g: number): number => g / 1000;

/** Grams → whole pounds + ounces rounded to 0.1 (15.96 oz carries into the next pound). */
export function gramsToLbOz(g: number): { lb: number; oz: number } {
  const totalOz = Math.round((g / G_PER_OZ) * 10) / 10;
  const lb = Math.floor(totalOz / 16);
  const oz = Math.round((totalOz - lb * 16) * 10) / 10;
  return { lb, oz };
}

/** "7 lb 4.5 oz" / "3.29 kg". */
export function formatWeight(g: number, unit: 'lb' | 'kg'): string {
  if (unit === 'kg') return `${(Math.round(g / 10) / 100).toFixed(2)} kg`;
  const { lb, oz } = gramsToLbOz(g);
  return `${lb} lb ${Number.isInteger(oz) ? oz : oz.toFixed(1)} oz`;
}

/** Parses a local date key "YYYY-MM-DD" to local midnight. */
export function parseDateKey(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!).getTime();
}

/** Completed calendar days between birth (local date key) and `at` (DST-safe). Negative before birth. */
export function ageInDays(born: string, at: number): number {
  const b = parseDateKey(born);
  const d = new Date(at);
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const bd = new Date(b);
  return Math.round((a - Date.UTC(bd.getFullYear(), bd.getMonth(), bd.getDate())) / 86_400_000);
}
export const daysToMonths = (days: number): number => days / DAYS_PER_MONTH;

/** "3 days", "5 wk", "4 mo", "4 mo 2 wk" — a short human age. */
export function formatAge(days: number): string {
  if (days < 0) return 'before birth';
  if (days < 14) return days === 1 ? '1 day' : `${days} days`;
  if (days < 61) return `${Math.floor(days / 7)} wk`;
  const mo = Math.floor(days / DAYS_PER_MONTH);
  const wk = Math.floor((days - mo * DAYS_PER_MONTH) / 7);
  return wk > 0 && mo < 12 ? `${mo} mo ${wk} wk` : `${mo} mo`;
}

const COL: Record<WhoPercentile, number> = { 3: 0, 15: 1, 50: 2, 85: 3, 97: 4 };

/** WHO percentile weight (kg) at an age in days (fractional days interpolate between two published rows). */
export function whoKg(p: WhoPercentile, days: number): number {
  const d = Math.min(Math.max(days, 0), WHO_MAX_DAYS);
  const i = Math.floor(d);
  const a = WHO_WFA_GIRLS_DAYS[i]![COL[p]]!;
  const b = WHO_WFA_GIRLS_DAYS[Math.min(i + 1, WHO_MAX_DAYS)]![COL[p]]!;
  return a + (b - a) * (d - i);
}

/** One reference line: points every `stepDays` from day 0 to day 730 (always ends on the last published day). */
export function whoLine(p: WhoPercentile, stepDays = 7): Array<{ months: number; kg: number }> {
  const out: Array<{ months: number; kg: number }> = [];
  for (let d = 0; d < WHO_MAX_DAYS; d += stepDays) out.push({ months: daysToMonths(d), kg: whoKg(p, d) });
  out.push({ months: daysToMonths(WHO_MAX_DAYS), kg: whoKg(p, WHO_MAX_DAYS) });
  return out;
}

function normCdf(z: number): number {
  // Abramowitz & Stegun 7.1.26 erf approximation (|err| < 1.5e-7)
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** WHO z-score of a weight (kg) at an age, by the LMS method. null outside 0..24 months. */
export function whoZ(kg: number, days: number): number | null {
  if (!(days >= 0 && days <= WHO_MAX_DAYS)) return null;
  const i = Math.round(days);
  const [, , , , , L, M, S] = WHO_WFA_GIRLS_DAYS[i]!;
  return L === 0 ? Math.log(kg / M) / S : (Math.pow(kg / M, L) - 1) / (L * S);
}

/** Estimated WHO percentile (0..100) of a weight at an age; null outside 0..24 months. */
export function whoPercentile(grams: number, days: number): number | null {
  const z = whoZ(grams / 1000, days);
  return z === null ? null : normCdf(z) * 100;
}

export function ordinal(n: number): string {
  const v = n % 100;
  const s = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

export { WHO_PERCENTILES };
export type { WhoPercentile };

/** Device-local UI preferences (night mode, units). Not synced; no core imports. */
import { useCallback, useState } from 'react';
import type { ChartRange, Prefs, WeightUnit, WhoSex } from './types';

const KEY = 'bf.ui.prefs.v1';
export const DEFAULT_PREFS: Prefs = { night: 'auto', units: 'oz' };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      night: raw.night === 'on' || raw.night === 'off' ? raw.night : 'auto',
      // v1 is oz-only (Dealer's call); ml display code stays for later but isn't selectable.
      units: 'oz',
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);
  return [prefs, update] as const;
}

/*
 * Baby name: synced by core now (useHousehold().babyName / setBabyName, a household record both phones read).
 * This device-local key is only the old pre-sync copy: shown as a fallback until useBabyNameMigration() has handed
 * it to core, then removed (keeping it would resurrect a name the other phone cleared).
 */
const BABY_KEY = 'bf.ui.baby.v1';
export const DEMO_BABY = { name: 'Josephine', born: '2026-06-15' } as const;
export const loadLegacyBabyName = (): string | null => { try { return localStorage.getItem(BABY_KEY)?.trim() || null; } catch { return null; } };
export const clearLegacyBabyName = () => { try { localStorage.removeItem(BABY_KEY); } catch { /* private mode */ } };

/* Charts range (7 / 14 / 30 / All): device-local, remembered across tabs and launches. ?range=7|14|30|all overrides. */
const RANGE_KEY = 'bf.ui.chartRange.v1';
export function parseChartRange(v: string | null | undefined): ChartRange | null {
  if (v === 'all') return 'all';
  const n = Number(v);
  return n === 7 || n === 14 || n === 30 ? n : null;
}
export function loadChartRange(): ChartRange {
  const fromUrl = typeof location === 'undefined' ? null : parseChartRange(new URLSearchParams(location.search).get('range'));
  if (fromUrl) return fromUrl;
  try { return parseChartRange(localStorage.getItem(RANGE_KEY)) ?? 7; } catch { return 7; }
}
export function useChartRange() {
  const [range, setRange] = useState<ChartRange>(loadChartRange);
  const save = useCallback((r: ChartRange) => {
    setRange(r);
    try { localStorage.setItem(RANGE_KEY, String(r)); } catch { /* private mode */ }
  }, []);
  return [range, save] as const;
}

/* Weight unit (lb/oz or kg): device-local like the other display units. */
const WEIGHT_UNIT_KEY = 'bf.ui.weightUnit.v1';
export function loadWeightUnit(): WeightUnit {
  try { return localStorage.getItem(WEIGHT_UNIT_KEY) === 'kg' ? 'kg' : 'lb'; } catch { return 'lb'; }
}
export function useWeightUnit() {
  const [unit, setUnit] = useState<WeightUnit>(loadWeightUnit);
  const save = useCallback((u: WeightUnit) => {
    setUnit(u);
    try { localStorage.setItem(WEIGHT_UNIT_KEY, u); } catch { /* private mode */ }
  }, []);
  return [unit, save] as const;
}

/* Which WHO standard the weight chart shows (and percentile estimates use). Defaults to girls (Josephine). Device-local. */
const SEX_KEY = 'bf.ui.whoSex.v1';
export function loadWhoSex(): WhoSex {
  try { return localStorage.getItem(SEX_KEY) === 'boys' ? 'boys' : 'girls'; } catch { return 'girls'; }
}
export function useWhoSex() {
  const [sex, setSex] = useState<WhoSex>(loadWhoSex);
  const save = useCallback((s: WhoSex) => {
    setSex(s);
    try { localStorage.setItem(SEX_KEY, s); } catch { /* private mode */ }
  }, []);
  return [sex, save] as const;
}

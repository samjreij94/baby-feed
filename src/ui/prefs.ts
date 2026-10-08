/** Device-local UI preferences (night mode, units). Not synced; no core imports. */
import { useCallback, useEffect, useState } from 'react';
import type { ChartRange, Prefs } from './types';

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

/* Baby name: device-local until core has a synced household profile (asked Dealer). */
const BABY_KEY = 'bf.ui.baby.v1';
const babyListeners = new Set<(v: string | null) => void>();
export const DEMO_BABY = { name: 'Josephine', born: '2026-06-15' } as const;
export const saveBabyName = (n: string | null) => { try { if (n) localStorage.setItem(BABY_KEY, n); else localStorage.removeItem(BABY_KEY); } catch { /* private mode */ } };
export const loadBabyName = (): string | null => { try { return localStorage.getItem(BABY_KEY) || null; } catch { return null; } };
export function useBabyName() {
  const [name, setName] = useState<string | null>(loadBabyName);
  useEffect(() => { babyListeners.add(setName); return () => { babyListeners.delete(setName); }; }, []);
  const save = useCallback((v: string | null) => {
    const clean = v?.trim() || null;
    try { if (clean) localStorage.setItem(BABY_KEY, clean); else localStorage.removeItem(BABY_KEY); } catch { /* private mode */ }
    babyListeners.forEach((l) => l(clean));
  }, []);
  return [name, save] as const;
}

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

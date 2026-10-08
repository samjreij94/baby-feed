/** Night mode: auto between 20:00 and 07:00 local, or forced on/off. No core imports. */
import { useEffect, useState } from 'react';
import type { NightPref } from './types';

export const NIGHT_START_HOUR = 20;
export const NIGHT_END_HOUR = 7;
export const THEME_COLOR = { day: '#f7f2ec', night: '#15100b' } as const;

export const isNightHour = (d: Date) => d.getHours() >= NIGHT_START_HOUR || d.getHours() < NIGHT_END_HOUR;

export function resolveNight(pref: NightPref, d: Date): boolean {
  if (pref === 'on') return true;
  if (pref === 'off') return false;
  return isNightHour(d);
}

/** Applies data-theme on <html> and the theme-color meta; re-checks every minute while on Auto. */
export function useTheme(pref: NightPref): boolean {
  const [night, setNight] = useState(() => resolveNight(pref, new Date()));
  useEffect(() => {
    const check = () => setNight(resolveNight(pref, new Date()));
    check();
    if (pref !== 'auto') return;
    const id = window.setInterval(check, 60_000);
    const onVis = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [pref]);
  useEffect(() => {
    const theme = night ? 'night' : 'day';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.background = THEME_COLOR[theme];
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', THEME_COLOR[theme]));
  }, [night]);
  return night;
}

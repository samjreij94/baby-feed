import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNightHour, resolveNight, THEME_COLOR, useTheme } from '../theme';
import { loadPrefs } from '../prefs';

const h = (hour: number, min = 0) => new Date(2026, 9, 8, hour, min);

describe('night mode', () => {
  afterEach(() => vi.useRealTimers());

  it('auto: on from 20:00 until 06:59, off from 07:00 until 19:59', () => {
    expect(isNightHour(h(19, 59))).toBe(false);
    expect(isNightHour(h(20, 0))).toBe(true);
    expect(isNightHour(h(23, 30))).toBe(true);
    expect(isNightHour(h(0, 0))).toBe(true);
    expect(isNightHour(h(3, 12))).toBe(true);
    expect(isNightHour(h(6, 59))).toBe(true);
    expect(isNightHour(h(7, 0))).toBe(false);
    expect(isNightHour(h(13, 0))).toBe(false);
  });

  it('manual On / Off override the clock', () => {
    expect(resolveNight('on', h(13))).toBe(true);
    expect(resolveNight('off', h(3))).toBe(false);
    expect(resolveNight('auto', h(3))).toBe(true);
    expect(resolveNight('auto', h(13))).toBe(false);
  });

  it('useTheme sets data-theme + theme-color and flips automatically at 20:00', () => {
    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
    vi.useFakeTimers();
    vi.setSystemTime(h(19, 59));
    const { result } = renderHook(() => useTheme('auto'));
    expect(result.current).toBe(false);
    expect(document.documentElement.dataset.theme).toBe('day');
    expect(meta.content).toBe(THEME_COLOR.day);
    vi.setSystemTime(h(20, 0));
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(document.documentElement.dataset.theme).toBe('night');
    expect(meta.content).toBe(THEME_COLOR.night);
    meta.remove();
  });

  it('night preference persists and defaults to Auto', () => {
    localStorage.removeItem('bf.ui.prefs.v1');
    expect(loadPrefs()).toEqual({ night: 'auto', units: 'oz' });
    localStorage.setItem('bf.ui.prefs.v1', JSON.stringify({ night: 'on', units: 'ml' }));
    expect(loadPrefs()).toEqual({ night: 'on', units: 'oz' }); // oz-only in v1
    localStorage.setItem('bf.ui.prefs.v1', '{bad');
    expect(loadPrefs().night).toBe('auto');
  });
});

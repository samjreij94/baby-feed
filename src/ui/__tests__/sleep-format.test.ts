import { describe, expect, it } from 'vitest';
import { fmtAgoPhrase, fmtCountdown, minutesToTimeInput, remoteSleepLine, timeInputToMinutes } from '../sleep/format';
import type { SleepSession } from '../../core';

const T0 = new Date(2026, 10, 20, 20, 0, 0).getTime();

describe('sleep display helpers', () => {
  it('formats remaining time as m:ss, flooring seconds and clamping to a cap', () => {
    expect(fmtCountdown(4 * 60_000 + 12_000)).toBe('4:12');
    expect(fmtCountdown(0)).toBe('0:00');
    expect(fmtCountdown(250)).toBe('0:00'); // floor, not ceil
    expect(fmtCountdown(60 * 60_000 + 1, 60 * 60_000)).toBe('60:00');
    expect(fmtCountdown(3 * 60_000 + 5_000, 3 * 60_000)).toBe('3:00');
    expect(fmtCountdown(60 * 60_000 + 1)).toBe('60:00');
  });

  it('converts morning cutoff minutes to a time input and back', () => {
    expect(minutesToTimeInput(360)).toBe('06:00');
    expect(timeInputToMinutes('06:00')).toBe(360);
    expect(timeInputToMinutes('24:00')).toBeNull();
  });

  it('describes the other parent’s latest event', () => {
    const session = {
      id: 's1',
      kind: 'sleep_session',
      type: 'night',
      startedAt: T0,
      putDownAt: T0,
      asleepAt: null,
      endedAt: null,
      events: [{
        id: 'e1', kind: 'cry_start', at: T0, loggedBy: { id: 'karyn', name: 'Karyn' }, deviceId: 'dev-k',
      }],
      householdId: 'h', createdAt: T0, updatedAt: T0, deleted: false,
      loggedBy: { id: 'samir', name: 'Samir' }, deviceId: 'dev-s',
    } as SleepSession;
    expect(remoteSleepLine(session, 'samir', 'dev-s', T0 + 2 * 60_000)).toBe('Karyn started the crying timer 2 min ago');
    expect(remoteSleepLine(session, 'karyn', 'dev-k', T0 + 2 * 60_000)).toBeNull();
    expect(fmtAgoPhrase(30_000)).toBe('just now');
  });
});

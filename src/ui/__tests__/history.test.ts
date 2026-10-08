import { describe, expect, it } from 'vitest';
import { groupHistory } from '../history';
import type { HistoryEntryVM, PersonVM } from '../types';

const by: PersonVM = { id: 'm', name: 'Karyn', initials: 'K', tone: 1, isMe: false };
const NOW = new Date(2026, 9, 8, 13, 5).getTime();
const t = (dayOffset: number, h: number, m = 0) => new Date(2026, 9, 8 + dayOffset, h, m).getTime();
const breast = (at: number, min: number): HistoryEntryVM => ({
  id: `b${at}`, kind: 'breast', at, title: 'Left', detail: '', duration: '', side: 'L', sides: ['L'], amountOz: null, nursingMin: min, running: false, by,
  draft: { kind: 'breast', startedAt: at, first: 'L', minutes: { L: min, R: 0 } },
});
const bottle = (at: number, oz: number): HistoryEntryVM => ({
  id: `o${at}`, kind: 'bottle', at, title: 'Bottle', detail: '', duration: '', side: null, sides: [], amountOz: oz, nursingMin: 0, running: false, by,
  draft: { kind: 'bottle', at, amountOz: oz, milk: 'breast' },
});

describe('groupHistory', () => {
  const entries = [breast(t(-1, 23, 50), 20), bottle(t(0, 9), 3.5), breast(t(0, 0, 10), 15), breast(t(0, 12), 12.4), breast(t(-5, 8), 10)];
  const days = groupHistory(entries, NOW);

  it('groups by local day, newest day first, newest entry first', () => {
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Sat, Oct 3']);
    expect(days[0]!.entries.map((e) => e.at)).toEqual([t(0, 12), t(0, 9), t(0, 0, 10)]);
  });

  it('a feed just after midnight belongs to that day; 23:50 stays on the previous day', () => {
    expect(days[0]!.entries.some((e) => e.at === t(0, 0, 10))).toBe(true);
    expect(days[1]!.entries.map((e) => e.at)).toEqual([t(-1, 23, 50)]);
  });

  it('day headers carry totals (feeds · nursing · bottle)', () => {
    expect(days[0]!.summary).toBe('3 feeds · 27m · 3.5 oz');
    expect(days[1]!.summary).toBe('1 feed · 20m');
    expect(groupHistory([bottle(t(0, 9), 3.5)], NOW, 'ml')[0]!.summary).toBe('1 feed · 105 ml');
  });

  it('keys are YYYY-MM-DD and a different year shows the year', () => {
    expect(days[0]!.key).toBe('2026-10-08');
    const old = groupHistory([breast(new Date(2025, 11, 30, 8).getTime(), 5)], NOW);
    expect(old[0]!.label).toMatch(/2025/);
  });

  it('empty input → no groups', () => expect(groupHistory([], NOW)).toEqual([]));
});

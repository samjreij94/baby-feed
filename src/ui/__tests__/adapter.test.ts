import { describe, expect, it } from 'vitest';
import type { BreastFeed, Member } from '../../core/types';
import { draftToBreastSegments, feedToRow, personVM, readJoinFromUrl } from '../adapter';

const MIN = 60_000;
const members: Member[] = [{ id: 's', name: 'Samir' }, { id: 'k', name: 'Karyn' }];
const T = new Date(2026, 9, 8, 3, 0).getTime();
const f: BreastFeed = {
  id: 'f', householdId: 'h', createdAt: T, updatedAt: T, deleted: false, loggedBy: { id: 'k', name: 'Karyn (old name)' }, deviceId: 'd',
  kind: 'breast', startedAt: T, endedAt: T + 20 * MIN, pausedAt: null, status: 'ended',
  segments: [{ side: 'L', startedAt: T, endedAt: T + 8 * MIN }, { side: 'R', startedAt: T + 9 * MIN, endedAt: T + 15 * MIN }, { side: 'R', startedAt: T + 16 * MIN, endedAt: T + 20 * MIN }],
};

describe('adapter mapping', () => {
  it('breast row: collapsed side sequence, per-side detail, current member name, initials chip', () => {
    const r = feedToRow(f, 's', members, 'oz', T + 30 * MIN);
    expect(r.title).toBe('Left → Right');
    expect(r.detail).toBe('L 8m · R 10m');
    expect(r.duration).toBe('18\u00a0min');
    expect(r.sides).toEqual(['L', 'R']);
    expect(r.by).toMatchObject({ name: 'Karyn', initials: 'K', isMe: false, tone: 1 });
    expect(r.draft).toEqual({ kind: 'breast', id: 'f', startedAt: T, first: 'L', minutes: { L: 8, R: 10 } });
  });

  it('person chip falls back to the logged name for removed members', () => {
    expect(personVM({ id: 'x', name: 'Grandma Lou' }, 's', members)).toMatchObject({ name: 'Grandma Lou', initials: 'GL', tone: 3 });
  });

  it('edit draft → contiguous segments, first side first, zero-minute side dropped', () => {
    expect(draftToBreastSegments({ kind: 'breast', startedAt: T, first: 'R', minutes: { L: 5, R: 10 } })).toEqual({
      segments: [{ side: 'R', startedAt: T, endedAt: T + 10 * MIN }, { side: 'L', startedAt: T + 10 * MIN, endedAt: T + 15 * MIN }],
      endedAt: T + 15 * MIN,
    });
    expect(draftToBreastSegments({ kind: 'breast', startedAt: T, first: 'L', minutes: { L: 0, R: 7 } }).segments).toHaveLength(1);
  });

  it('reads invite codes from ?join= and #join=', () => {
    const code = 'K7Q29XMBK7Q29XMBK7Q29XMBK7Q29XMB';
    expect(readJoinFromUrl({ search: `?join=${code}`, hash: '' })).toBe(code);
    expect(readJoinFromUrl({ search: '', hash: `#join=${code.toLowerCase()}` })).toBe(code);
    expect(readJoinFromUrl({ search: '?join=nope', hash: '' })).toBeNull();
    expect(readJoinFromUrl({ search: '', hash: '' })).toBeNull();
  });
});

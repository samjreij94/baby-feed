import { describe, expect, it } from 'vitest';
import { compareVersion, lww, mergeInto, nextUpdatedAt } from '../merge';
import type { BottleFeed, Entry } from '../types';

const bottle = (updatedAt: number, deviceId: string, patch: Partial<BottleFeed> = {}): BottleFeed => ({
  id: 'b1', householdId: 'h', createdAt: 1, updatedAt, deleted: false, loggedBy: { id: 'm', name: 'Samir' }, deviceId,
  kind: 'bottle', at: 1, amountOz: 2, ...patch,
});

describe('LWW merge', () => {
  it('newer updatedAt wins regardless of order', () => {
    const a = bottle(10, 'a', { amountOz: 2 });
    const b = bottle(20, 'a', { amountOz: 3 });
    expect(lww(a, b)).toBe(b);
    expect(lww(b, a)).toBe(b);
  });

  it('equal updatedAt: higher deviceId wins (deterministic on both sides)', () => {
    const a = bottle(10, 'dev-a', { amountOz: 2 });
    const z = bottle(10, 'dev-z', { amountOz: 4 });
    expect(lww(a, z)).toBe(z);
    expect(lww(z, a)).toBe(z);
    expect(compareVersion(a, a)).toBe(0);
  });

  it('a tombstone beats an older edit; an older tombstone loses to a newer edit', () => {
    const edit = bottle(10, 'a', { amountOz: 5 });
    const del = bottle(11, 'b', { deleted: true });
    expect(lww(edit, del).deleted).toBe(true);
    const oldDel = bottle(9, 'b', { deleted: true });
    expect(lww(edit, oldDel).deleted).toBe(false);
    expect(lww(oldDel, edit).deleted).toBe(false);
  });

  it('is idempotent and order-independent (out-of-order delivery converges)', () => {
    const v = [bottle(1, 'a'), bottle(3, 'b', { amountOz: 3 }), bottle(2, 'c', { deleted: true }), bottle(3, 'a', { amountOz: 9 })];
    const perms = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
    const results = perms.map((p) => {
      const m = new Map<string, Entry>();
      mergeInto(m, p.map((i) => v[i]!));
      const again = mergeInto(m, p.map((i) => v[i]!)); // re-apply
      expect(again).toEqual([]);
      return m.get('b1');
    });
    for (const r of results) expect(r).toEqual(v[1]); // (3,'b') > (3,'a')
  });

  it('nextUpdatedAt always beats the edited version even with a slow clock', () => {
    expect(nextUpdatedAt(undefined, 50)).toBe(50);
    expect(nextUpdatedAt(100, 50)).toBe(101);
    expect(nextUpdatedAt(100, 500)).toBe(500);
  });
});

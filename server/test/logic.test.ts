import { describe, expect, it } from 'vitest';
import { Household, householdIdFromHash, LIMITS, MemoryHouseholdStorage, sha256Hex, timingSafeEqual, validateEntry } from '../src/logic.ts';
import type { BottleFeed, BreastFeed, Entry } from '../../src/core/types.ts';

const HH = 'h'.repeat(32);
const NOW = 1_790_000_000_000;
const base = { householdId: HH, createdAt: NOW, updatedAt: NOW, deleted: false, loggedBy: { id: 'member-1', name: 'Samir' }, deviceId: 'dev-a' };
const bottle = (id: string, p: Partial<BottleFeed> = {}): BottleFeed => ({ ...base, id, kind: 'bottle', at: NOW, amountOz: 2, ...p });
const breast = (id: string, p: Partial<BreastFeed> = {}): BreastFeed => ({
  ...base, id, kind: 'breast', startedAt: NOW, endedAt: null, segments: [{ side: 'L', startedAt: NOW, endedAt: null }], pausedAt: null, status: 'running', ...p,
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function hh(pageSize?: number) {
  const store = new MemoryHouseholdStorage();
  const h = new Household(store, pageSize);
  h.init('hash', NOW);
  return { h, store };
}

describe('secrets', () => {
  it('hash → householdId, constant-time compare', async () => {
    const hash = await sha256Hex('ABC');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(householdIdFromHash(hash)).toBe(hash.slice(0, 32));
    expect(timingSafeEqual('abcd', 'abcd')).toBe(true);
    expect(timingSafeEqual('abcd', 'abce')).toBe(false);
    expect(timingSafeEqual('abcd', 'abc')).toBe(false);
  });

  it('init once, authorize by hash', () => {
    const { h } = hh();
    expect(h.init('other', NOW)).toBe(false);
    expect(h.authorize('hash')).toBe(true);
    expect(h.authorize('nope')).toBe(false);
    expect(new Household(new MemoryHouseholdStorage()).authorize('hash')).toBe(false);
  });
});

describe('validation', () => {
  it('accepts valid entries of every kind', () => {
    expect(validateEntry(bottle(id(1), { milk: 'formula', note: 'hi', source: 'nara', externalId: 'k1' }), HH, NOW)).toBeNull();
    expect(validateEntry(breast(id(2)), HH, NOW)).toBeNull();
    expect(validateEntry({ ...base, id: id(3), kind: 'member', name: 'Karyn' }, HH, NOW)).toBeNull();
  });

  it.each([
    ['householdId mismatch', { householdId: 'x'.repeat(32) }],
    ['bad id', { id: 'a b' }],
    ['bad amountOz', { amountOz: 1.1 }],
    ['bad amountOz', { amountOz: 0 }],
    ['bad milk', { milk: 'juice' }],
    ['bad kind', { kind: 'diaper' }],
    ['updatedAt in the future', { updatedAt: NOW + LIMITS.maxFutureMs + 1 }],
    ['bad loggedBy', { loggedBy: { id: 'x' } }],
    ['bad deleted', { deleted: 'no' }],
    ['entry too large', { note: 'x'.repeat(900), externalId: undefined, loggedBy: { id: 'm'.repeat(64), name: 'n' }, extra: 'y'.repeat(8000) }],
    ['bad note', { note: 'x'.repeat(LIMITS.maxNote + 1) }],
    ['bad source', { source: 'csv' }],
    ['bad externalId', { externalId: 'x'.repeat(129) }],
  ])('rejects: %s', (reason, patch) => {
    expect(validateEntry({ ...bottle(id(9)), ...patch }, HH, NOW)).toBe(reason);
  });

  it('rejects inconsistent breast feeds', () => {
    expect(validateEntry(breast(id(1), { status: 'ended' }), HH, NOW)).toBe('bad segments'); // open segment on ended feed
    expect(validateEntry(breast(id(1), { segments: [{ side: 'X' as 'L', startedAt: NOW, endedAt: null }] }), HH, NOW)).toBe('bad segment');
    expect(validateEntry(breast(id(1), { status: 'paused', segments: [{ side: 'L', startedAt: NOW, endedAt: NOW + 1 }] }), HH, NOW)).toBe('paused without pausedAt');
    expect(validateEntry('nope', HH, NOW)).toBe('not an object');
  });
});

describe('sync', () => {
  it('stores latest version per id with LWW (updatedAt, then deviceId)', () => {
    const { h, store } = hh();
    const r1 = h.sync(HH, { since: null, changes: [bottle(id(1), { amountOz: 2, updatedAt: NOW + 10 })] }, NOW);
    expect(r1.status).toBe(200);
    h.sync(HH, { since: null, changes: [bottle(id(1), { amountOz: 9, updatedAt: NOW + 5 })] }, NOW); // older: ignored
    expect(store.since(0, 10)[0]!.entry).toMatchObject({ amountOz: 2 });
    h.sync(HH, { since: null, changes: [bottle(id(1), { amountOz: 3, updatedAt: NOW + 10, deviceId: 'dev-z' })] }, NOW); // tie → higher deviceId
    expect(store.since(0, 10)[0]!.entry).toMatchObject({ amountOz: 3 });
    h.sync(HH, { since: null, changes: [bottle(id(1), { deleted: true, updatedAt: NOW + 11 })] }, NOW);
    expect(store.since(0, 10)[0]!.entry.deleted).toBe(true);
    h.sync(HH, { since: null, changes: [bottle(id(1), { amountOz: 4, updatedAt: NOW + 10, deviceId: 'zzz' })] }, NOW); // older edit can't resurrect
    expect(store.since(0, 10)[0]!.entry.deleted).toBe(true);
    expect(store.size).toBe(1);
  });

  it('cursor + paging: monotonic seq, hasMore, only newer rows after cursor', () => {
    const { h } = hh(3);
    const changes = Array.from({ length: 7 }, (_, i) => bottle(id(i)));
    const r = h.sync(HH, { since: null, changes }, NOW);
    if (r.status !== 200) throw new Error();
    expect(r.body).toMatchObject({ hasMore: true, cursor: '3', serverNow: NOW, rejected: [] });
    expect(r.body.changes).toHaveLength(3);
    const all: Entry[] = [...r.body.changes];
    let cursor = r.body.cursor;
    for (;;) {
      const p = h.sync(HH, { since: cursor, changes: [] }, NOW);
      if (p.status !== 200) throw new Error();
      all.push(...p.body.changes);
      cursor = p.body.cursor;
      if (!p.body.hasMore) break;
    }
    expect(all.map((e) => e.id)).toEqual(changes.map((e) => e.id));
    expect(cursor).toBe('7');
    // an update moves the row past the cursor
    h.sync(HH, { since: cursor, changes: [bottle(id(2), { amountOz: 5, updatedAt: NOW + 1 })] }, NOW);
    const after = h.sync(HH, { since: cursor, changes: [] }, NOW);
    if (after.status !== 200) throw new Error();
    expect(after.body.changes.map((e) => e.id)).toEqual([id(2)]);
    expect(after.body.cursor).toBe('8');
    const empty = h.sync(HH, { since: '8', changes: [] }, NOW);
    expect(empty.status === 200 && empty.body.cursor).toBe('8');
  });

  it('reports rejected entries and keeps the valid ones', () => {
    const { h, store } = hh();
    const r = h.sync(HH, { since: null, changes: [bottle(id(1)), bottle(id(2), { householdId: 'other' }), { junk: true }] }, NOW);
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body.rejected).toEqual([{ id: id(2), reason: 'householdId mismatch' }, { id: '?', reason: 'bad id' }]);
    expect(store.size).toBe(1);
  });

  it('rejects bad requests', () => {
    const { h } = hh();
    expect(h.sync(HH, { since: 'abc' }, NOW).status).toBe(400);
    expect(h.sync(HH, { changes: {} }, NOW).status).toBe(400);
    expect(h.sync(HH, [], NOW).status).toBe(400);
    expect(h.sync(HH, { changes: Array.from({ length: LIMITS.maxChangesPerRequest + 1 }, (_, i) => bottle(id(i))) }, NOW).status).toBe(413);
  });

  it('members() lists live member entries', () => {
    const { h } = hh();
    h.sync(HH, { changes: [{ ...base, id: id(1), kind: 'member', name: 'Samir' }, { ...base, id: id(2), kind: 'member', name: 'Gone', deleted: true }] }, NOW);
    expect(h.members()).toEqual([{ id: id(1), name: 'Samir' }]);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryServer, device, fakeClock, MIN } from './helpers';

const devices: Array<ReturnType<typeof device>> = [];
afterEach(() => { for (const d of devices.splice(0)) d.core.dispose(); });

async function pair() {
  const clock = fakeClock();
  const server = createMemoryServer({ now: clock.now });
  const mk = (n: string) => { const d = device(n, clock.now, server); devices.push(d); return d; };
  const a = mk('a'); const b = mk('b');
  await a.core.createHousehold('Samir');
  await b.core.joinHousehold(a.core.inviteLink!, 'Karyn');
  await a.core.syncNow();
  return { clock, server, a, b };
}

describe('weights (additive kind)', () => {
  it('add / edit / delete, newest first, validation', async () => {
    const { a, clock } = await pair();
    const w1 = await a.core.addWeight({ grams: 3400, at: clock.now() - 10 * MIN });
    const w2 = await a.core.addWeight({ grams: 3500.4, at: clock.now() });
    expect(a.core.getSnapshot().weights.map((w) => w.grams)).toEqual([3500, 3400]);
    await a.core.editWeight(w1.id, { grams: 3450, note: 'clinic' });
    expect(a.core.getSnapshot().weights.find((w) => w.id === w1.id)).toMatchObject({ grams: 3450, note: 'clinic' });
    await expect(a.core.addWeight({ grams: 50 })).rejects.toThrow(/Weight must be/);
    await expect(a.core.editWeight(w2.id, { grams: 40_000 })).rejects.toThrow(/Weight must be/);
    await expect(a.core.editWeight('nope', { grams: 3000 })).rejects.toThrow(/No weight/);
    await a.core.deleteEntry(w2.id);
    expect(a.core.getSnapshot().weights.map((w) => w.id)).toEqual([w1.id]);
  });

  it('syncs between two phones like feeds: add, edit, delete', async () => {
    const { a, b, clock } = await pair();
    const w = await a.core.addWeight({ grams: 3300, at: clock.now() });
    await a.core.syncNow(); await b.core.syncNow();
    expect(b.core.getSnapshot().weights).toMatchObject([{ id: w.id, grams: 3300, loggedBy: { name: 'Samir' } }]);
    clock.advance(MIN);
    await b.core.editWeight(w.id, { grams: 3320 });
    await b.core.syncNow(); await a.core.syncNow();
    expect(a.core.getSnapshot().weights[0]!.grams).toBe(3320);
    clock.advance(MIN);
    await a.core.deleteEntry(w.id);
    await a.core.syncNow(); await b.core.syncNow();
    expect(b.core.getSnapshot().weights).toEqual([]);
  });

  it('weights never touch feeds: counts and contents are identical before and after', async () => {
    const { a, b, server, clock } = await pair();
    await a.core.addBottle({ amountOz: 3 });
    await a.core.addManualBreast({ start: clock.now() - 30 * MIN, end: clock.now() - 20 * MIN, side: 'L' });
    await a.core.syncNow(); await b.core.syncNow();
    const feedsBefore = JSON.stringify(a.core.getSnapshot().feeds);
    const feedsOnB = JSON.stringify(b.core.getSnapshot().feeds);
    const rowsBefore = [...server.stores.values()].flatMap((s) => s.store.since(0, 1000)).filter((r) => r.entry.kind !== 'weight').map((r) => JSON.stringify(r));

    const w = await b.core.addWeight({ grams: 3700 });
    clock.advance(MIN);
    await b.core.editWeight(w.id, { grams: 3710 });
    await b.core.deleteEntry(w.id);
    await b.core.syncNow(); await a.core.syncNow();

    expect(JSON.stringify(a.core.getSnapshot().feeds)).toBe(feedsBefore);
    expect(JSON.stringify(b.core.getSnapshot().feeds)).toBe(feedsOnB);
    const rowsAfter = [...server.stores.values()].flatMap((s) => s.store.since(0, 1000)).filter((r) => r.entry.kind !== 'weight').map((r) => JSON.stringify(r));
    expect(rowsAfter).toEqual(rowsBefore);
    expect(a.core.getSnapshot().sync.error).toBeNull();
  });

  it('survives an app restart (persisted + mirrored)', async () => {
    const { a } = await pair();
    const w = await a.core.addWeight({ grams: 3600 });
    const core = a.reload();
    await core.syncNow();
    expect(core.getSnapshot().weights.map((x) => x.id)).toEqual([w.id]);
  });

  it('an older client (feeds-only snapshot) is unaffected by weight rows in the sync stream', async () => {
    const { a, b } = await pair();
    await a.core.addBottle({ amountOz: 2 });
    await a.core.addWeight({ grams: 3500 });
    await a.core.syncNow(); await b.core.syncNow();
    // an old client only reads feeds + members from the snapshot; both are exactly what they were without weights
    expect(b.core.getSnapshot().feeds).toHaveLength(1);
    expect(b.core.getSnapshot().members.map((m) => m.name).sort()).toEqual(['Karyn', 'Samir']);
  });
});

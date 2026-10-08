import { afterEach, describe, expect, it } from 'vitest';
import { activeFeedView } from '../feed';
import { createMemoryServer, device, fakeClock, MIN } from './helpers';

const devices: Array<ReturnType<typeof device>> = [];
function setup() {
  const clock = fakeClock();
  const server = createMemoryServer({ now: clock.now });
  const mk = (name: string) => {
    const d = device(name, clock.now, server);
    devices.push(d);
    return d;
  };
  return { clock, server, a: mk('a'), b: mk('b'), mk };
}
afterEach(() => {
  for (const d of devices.splice(0)) d.core.dispose();
});

async function pair() {
  const s = setup();
  await s.a.core.createHousehold('Samir');
  await s.b.core.joinHousehold(s.a.core.inviteLink!, 'Karyn');
  await s.a.core.syncNow();
  return s;
}

describe('household', () => {
  it('create + join by link; members visible on both; invite code grouped', async () => {
    const { a, b } = await pair();
    expect(a.core.getSnapshot().householdId).toBe(b.core.getSnapshot().householdId);
    expect(a.core.inviteCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(a.core.inviteLink).toMatch(/^https?:\/\/.+#join=[0-9A-Z]{32}$/);
    const names = (d: typeof a) => d.core.getSnapshot().members.map((m) => m.name).sort();
    expect(names(a)).toEqual(['Karyn', 'Samir']);
    expect(names(b)).toEqual(['Karyn', 'Samir']);
    expect(b.core.getSnapshot().me?.name).toBe('Karyn');
  });

  it('join with a bad code fails; a wrong-but-valid code is not recognised', async () => {
    const { b } = setup();
    await expect(b.core.joinHousehold('nope', 'Karyn')).rejects.toThrow(/not valid/);
    await expect(b.core.joinHousehold('0'.repeat(32), 'Karyn')).rejects.toThrow(/not recognised/);
    expect(b.core.getSnapshot().householdId).toBeNull();
  });

  it('entries logged before joining get the householdId and are uploaded', async () => {
    const s = setup();
    await s.a.core.createHousehold('Samir');
    await s.b.core.setMe('Karyn');
    const pre = await s.b.core.addBottle({ amountOz: 2 });
    expect(pre.householdId).toBeNull();
    await s.b.core.joinHousehold(s.a.core.inviteCode!, 'Karyn');
    expect(s.b.core.getSnapshot().feeds[0]!.householdId).toBe(s.a.core.householdId);
    expect(s.b.core.getSnapshot().sync.pending).toBe(0);
    await s.a.core.syncNow();
    expect(s.a.core.getSnapshot().feeds.map((f) => f.id)).toEqual([pre.id]);
  });

  it('re-joining with the same name adopts the existing member (no duplicate)', async () => {
    const { a, mk } = await pair();
    const c = mk('c'); // Karyn reinstalled
    await c.core.joinHousehold(a.core.inviteCode!, 'karyn');
    await a.core.syncNow();
    expect(a.core.getSnapshot().members).toHaveLength(2);
  });

  it('leave keeps local data and stops syncing', async () => {
    const { a } = await pair();
    await a.core.addBottle({ amountOz: 1 });
    await a.core.leave();
    expect(a.core.getSnapshot()).toMatchObject({ householdId: null, secret: null });
    expect(a.core.inviteCode).toBeNull();
    expect(a.core.getSnapshot().feeds).toHaveLength(1);
  });
});

describe('outbox + sync', () => {
  it('queues offline, then flushes; outbox cleared only after ack; cursor advances', async () => {
    const { a, b } = await pair();
    a.setOffline(true);
    await a.core.addBottle({ amountOz: 2 });
    await a.core.addBottle({ amountOz: 3 });
    await a.core.syncNow();
    expect(a.core.getSnapshot().sync).toMatchObject({ state: 'offline', pending: 2 });
    await a.core.flush();
    expect(a.storage.map.has(`o:${a.core.getSnapshot().feeds[0]!.id}`)).toBe(true); // outbox persisted
    const cursorBefore = (a.storage.map.get('meta') as { cursor: string }).cursor;

    a.setOffline(false);
    await a.core.syncNow();
    expect(a.core.getSnapshot().sync).toMatchObject({ state: 'idle', pending: 0, error: null });
    expect([...a.storage.map.keys()].some((k) => k.startsWith('o:'))).toBe(false);
    const cursorAfter = (a.storage.map.get('meta') as { cursor: string }).cursor;
    expect(Number(cursorAfter)).toBeGreaterThan(Number(cursorBefore));

    await b.core.syncNow();
    expect(b.core.getSnapshot().feeds.map((f) => (f.kind === 'bottle' ? f.amountOz : 0)).sort()).toEqual([2, 3]);
  });

  it('an entry edited while its upload is in flight stays in the outbox', async () => {
    const { a, server } = await pair();
    const f = await a.core.addBottle({ amountOz: 2 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = server.fetch;
    let first = true;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (first) {
        first = false;
        await gate;
      }
      return orig(i, init);
    }) as typeof fetch;
    const p = a.core.syncNow();
    await new Promise((r) => setTimeout(r, 0));
    await a.core.editEntry(f.id, { amountOz: 4 });
    release();
    await p; // loops again because of the newer version
    server.fetch = orig;
    expect(a.core.getSnapshot().sync.pending).toBe(0);
    const row = server.stores.get(a.core.householdId!)!.store.since(0, 100).find((r) => r.entry.id === f.id)!;
    expect(row.entry).toMatchObject({ amountOz: 4 });
  });

  it('a running feed propagates live: start on A, B sees it; switch on B, A sees it', async () => {
    const { a, b, clock } = await pair();
    const f = await a.core.startBreast('L');
    await a.core.syncNow();
    await b.core.syncNow();
    let vb = activeFeedView(b.core.getSnapshot().feeds, b.core.now());
    expect(vb.feed?.id).toBe(f.id);
    expect(vb.currentSide).toBe('L');
    clock.advance(5 * MIN);
    vb = activeFeedView(b.core.getSnapshot().feeds, b.core.now());
    expect(vb.elapsedMs).toBe(5 * MIN);

    await b.core.switchSide();
    await b.core.syncNow();
    await a.core.syncNow();
    const va = activeFeedView(a.core.getSnapshot().feeds, a.core.now());
    expect(va.currentSide).toBe('R');
    expect(va.feed?.segments).toHaveLength(2);

    clock.advance(2 * MIN);
    await a.core.end();
    await a.core.syncNow();
    await b.core.syncNow();
    expect(activeFeedView(b.core.getSnapshot().feeds, b.core.now()).feed).toBeNull();
    expect(b.core.getSnapshot().feeds[0]).toMatchObject({ status: 'ended' });
  });

  it('concurrent offline edits converge by LWW; deletes propagate', async () => {
    const { a, b, clock } = await pair();
    const f = await a.core.addBottle({ amountOz: 2 });
    const g = await a.core.addBottle({ amountOz: 1 });
    await a.core.syncNow();
    await b.core.syncNow();
    b.setOffline(true);
    clock.advance(1000);
    await a.core.editEntry(f.id, { amountOz: 3 });
    clock.advance(1000);
    await b.core.editEntry(f.id, { amountOz: 5 }); // later edit wins
    await b.core.deleteEntry(g.id);
    await a.core.syncNow();
    await b.core.syncNow(); // offline
    expect(b.core.getSnapshot().sync.state).toBe('offline');
    b.setOffline(false);
    await b.core.syncNow();
    await a.core.syncNow();
    for (const d of [a, b]) {
      const feeds = d.core.getSnapshot().feeds;
      expect(feeds.map((x) => x.id)).toEqual([f.id]);
      expect(feeds[0]).toMatchObject({ amountOz: 5 });
    }
  });

  it('two feeds started concurrently are both kept (newest active, other in others)', async () => {
    const { a, b, clock } = await pair();
    a.setOffline(true);
    b.setOffline(true);
    await a.core.startBreast('L');
    clock.advance(1000);
    const fb = await b.core.startBreast('R');
    a.setOffline(false);
    b.setOffline(false);
    await a.core.syncNow();
    await b.core.syncNow();
    await a.core.syncNow();
    const v = activeFeedView(a.core.getSnapshot().feeds, a.core.now());
    expect(v.feed?.id).toBe(fb.id);
    expect(v.others).toHaveLength(1);
  });

  it('pages through many changes with hasMore', async () => {
    const clock = fakeClock();
    const server = createMemoryServer({ now: clock.now, pageSize: 3 });
    const a = device('a', clock.now, server);
    const b = device('b', clock.now, server);
    devices.push(a, b);
    await a.core.createHousehold('Samir');
    for (let i = 0; i < 7; i++) await a.core.addBottle({ amountOz: 1 + i / 4, at: clock.now() - i * MIN });
    await a.core.syncNow();
    await b.core.joinHousehold(a.core.inviteCode!, 'Karyn');
    expect(b.core.getSnapshot().feeds).toHaveLength(7);
  });

  it('serverNow sets the clock offset used for timer display', async () => {
    const devClock = fakeClock();
    const serverClock = () => devClock.now() + 90_000; // phone is 90 s behind the server
    const server = createMemoryServer({ now: serverClock });
    const a = device('a', devClock.now, server);
    devices.push(a);
    await a.core.createHousehold('Samir');
    expect(a.core.getSnapshot().sync.clockOffsetMs).toBe(90_000);
    expect(a.core.now()).toBe(serverClock());
  });

  it('401 from the server puts sync into error', async () => {
    const { a, server } = await pair();
    server.stores.get(a.core.householdId!)!.store.setMeta({ secretHash: 'x'.repeat(64), createdAt: 0, seq: 0 });
    await a.core.syncNow();
    expect(a.core.getSnapshot().sync).toMatchObject({ state: 'error', error: expect.stringMatching(/no longer valid/) });
  });
});

describe('importEntries', () => {
  it('adds only new ids, keeps local edits and tombstones, stamps household, syncs', async () => {
    const { a, b } = await pair();
    const existing = await a.core.addBottle({ amountOz: 2 });
    const dead = await a.core.addBottle({ amountOz: 1 });
    await a.core.deleteEntry(dead.id);
    const mk = (id: string, i: number) => ({
      ...existing,
      id,
      householdId: null,
      source: 'nara' as const,
      externalId: `nara-${i}`,
      at: existing.at - i * MIN,
      amountOz: 3,
      deviceId: 'nara-import',
      updatedAt: 1,
      createdAt: 1,
    });
    const batch = [mk(existing.id, 0), mk(dead.id, 1), ...Array.from({ length: 1000 }, (_, i) => mk(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, i + 2))];
    const t0 = performance.now();
    const r = await a.core.importEntries(batch);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(r).toEqual({ added: 1000, skippedExisting: 1, skippedDeleted: 1, invalid: 0 });
    expect(a.core.getSnapshot().feeds.find((f) => f.id === existing.id)).toMatchObject({ amountOz: 2 });
    expect(a.core.getSnapshot().feeds.every((f) => f.householdId === a.core.householdId)).toBe(true);
    expect(await a.core.importEntries(batch)).toMatchObject({ added: 0, skippedExisting: 1001 });
    await a.core.syncNow();
    expect(a.core.getSnapshot().sync.pending).toBe(0);
    await b.core.syncNow();
    expect(b.core.getSnapshot().feeds).toHaveLength(1001);
    expect(await b.core.importEntries(batch)).toMatchObject({ added: 0 }); // idempotent on the other phone
  });
});

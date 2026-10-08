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

  it('end(id) ends the OTHER running feed (not the active one) and it syncs', async () => {
    const { a, b, clock } = await pair();
    a.setOffline(true);
    b.setOffline(true);
    const fa = await a.core.startBreast('L');
    clock.advance(1000);
    const fb = await b.core.startBreast('R');
    a.setOffline(false);
    b.setOffline(false);
    await a.core.syncNow();
    await b.core.syncNow();
    await a.core.syncNow();
    clock.advance(4 * MIN);
    // On A the newest (B's) feed is active; A ends its own feed, which is in others.
    expect(activeFeedView(a.core.getSnapshot().feeds, a.core.now()).others.map((f) => f.id)).toEqual([fa.id]);
    const ended = (await a.core.end(fa.id))!;
    expect(ended).toMatchObject({ id: fa.id, status: 'ended', endedAt: a.core.now(), pausedAt: null });
    expect(ended.segments.at(-1)!.endedAt).toBe(a.core.now());
    expect(await a.core.end(fa.id)).toBeNull(); // already ended
    expect(await a.core.end('nope-0000')).toBeNull();
    await a.core.syncNow();
    await b.core.syncNow();
    const vb = activeFeedView(b.core.getSnapshot().feeds, b.core.now());
    expect(vb.feed?.id).toBe(fb.id);
    expect(vb.others).toEqual([]);
    expect(b.core.getSnapshot().feeds.find((f) => f.id === fa.id)).toMatchObject({ status: 'ended' });
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

describe('baby name (household record)', () => {
  it('phone B sees the name phone A set; B renames, A sees it; a clear syncs too', async () => {
    const { a, b } = await pair();
    expect(b.core.getSnapshot().babyName).toBe('');
    await a.core.setBabyName('  Josephine ');
    expect(a.core.getSnapshot().babyName).toBe('Josephine');
    await a.core.syncNow();
    await b.core.syncNow();
    expect(b.core.getSnapshot().babyName).toBe('Josephine');
    const rec = b.core.allEntries().find((e) => e.kind === 'household')!;
    expect(rec).toMatchObject({ id: a.core.householdId, householdId: a.core.householdId, babyName: 'Josephine', loggedBy: { name: 'Samir' } });
    expect(b.core.getSnapshot().feeds).toEqual([]); // not a feed

    await b.core.setBabyName('Josie');
    await b.core.syncNow();
    await a.core.syncNow();
    expect(a.core.getSnapshot().babyName).toBe('Josie');

    await a.core.setBabyName('   ');
    await a.core.syncNow();
    await b.core.syncNow();
    expect(a.core.getSnapshot().babyName).toBe('');
    expect(b.core.getSnapshot().babyName).toBe('');
    expect(b.core.getSnapshot().sync).toMatchObject({ pending: 0, error: null });
  });

  it('a name set before creating the household is uploaded on create', async () => {
    const s = setup();
    await s.a.core.setMe('Samir');
    await s.a.core.setBabyName('Josephine');
    expect(s.a.core.getSnapshot()).toMatchObject({ householdId: null, babyName: 'Josephine' });
    await s.a.core.createHousehold('Samir');
    await s.b.core.joinHousehold(s.a.core.inviteCode!, 'Karyn');
    expect(s.b.core.getSnapshot().babyName).toBe('Josephine');
  });

  it("on join the household's name wins over the joining phone's pending one; it's uploaded only if the household has none", async () => {
    const s = setup();
    await s.a.core.createHousehold('Samir');
    await s.a.core.setBabyName('Josephine');
    await s.a.core.syncNow();
    await s.b.core.setMe('Karyn');
    await s.b.core.setBabyName('Jo');
    await s.b.core.joinHousehold(s.a.core.inviteCode!, 'Karyn');
    expect(s.b.core.getSnapshot().babyName).toBe('Josephine');
    await s.a.core.syncNow();
    expect(s.a.core.getSnapshot().babyName).toBe('Josephine');

    const t = setup();
    await t.a.core.createHousehold('Samir'); // no name yet
    await t.b.core.setMe('Karyn');
    await t.b.core.setBabyName('Jo');
    await t.b.core.joinHousehold(t.a.core.inviteCode!, 'Karyn');
    await t.a.core.syncNow();
    expect(t.a.core.getSnapshot().babyName).toBe('Jo');
  });

  it('survives a restart and is kept locally after leave()', async () => {
    const { a, b } = await pair();
    await a.core.setBabyName('Josephine');
    await a.core.syncNow();
    await b.core.syncNow();
    await b.core.flush();
    await b.reload().ready;
    expect(b.core.getSnapshot().babyName).toBe('Josephine');
    await b.core.leave();
    expect(b.core.getSnapshot()).toMatchObject({ householdId: null, babyName: 'Josephine' });
  });
});

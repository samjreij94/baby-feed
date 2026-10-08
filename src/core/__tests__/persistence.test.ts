import { afterEach, describe, expect, it } from 'vitest';
import { activeFeedView } from '../feed';
import { FeedCore } from '../store';
import { createMemoryStorage } from '../storage';
import { device, fakeClock, memoryKv, MIN } from './helpers';

const cores: FeedCore[] = [];
afterEach(() => {
  for (const c of cores.splice(0)) c.dispose();
});

describe('persistence', () => {
  it('survives reload: identity, feeds and a running timer', async () => {
    const clock = fakeClock();
    const d = device('a', clock.now);
    await d.core.setMe('Samir');
    await d.core.addBottle({ amountOz: 2 });
    const f = await d.core.startBreast('L');
    await d.core.flush();
    clock.advance(3 * MIN);
    const c2 = d.reload();
    cores.push(c2);
    await c2.ready;
    const v = activeFeedView(c2.getSnapshot().feeds, c2.now());
    expect(v.feed?.id).toBe(f.id);
    expect(v.elapsedMs).toBe(3 * MIN);
    expect(c2.getSnapshot().me?.name).toBe('Samir');
    expect(c2.getSnapshot().feeds).toHaveLength(2);
    expect(c2.deviceId).toBe('dev-a');
  });

  it('localStorage mirror covers a lost IndexedDB write (app killed right after a tap)', async () => {
    const clock = fakeClock();
    const storage = createMemoryStorage();
    const kv = memoryKv();
    const opts = { clock: clock.now, storage, mirror: kv, autoSync: false } as const;
    const c1 = new FeedCore(opts);
    cores.push(c1);
    await c1.setMe('Karyn');
    await c1.startBreast('R');
    await c1.flush();
    storage.fail = true; // IndexedDB writes now fail (simulates the kill before the async write)
    clock.advance(MIN);
    await c1.switchSide();
    await c1.flush().catch(() => undefined);
    c1.dispose();
    storage.fail = false;

    // the mirror is readable synchronously, before IndexedDB loads
    const c2 = new FeedCore(opts);
    cores.push(c2);
    expect(c2.getSnapshot().ready).toBe(false);
    expect(activeFeedView(c2.getSnapshot().feeds, c2.now()).currentSide).toBe('L');
    expect(c2.getSnapshot().me?.name).toBe('Karyn');
    await c2.ready;
    const v = activeFeedView(c2.getSnapshot().feeds, c2.now());
    expect(v.feed?.segments.map((s) => s.side)).toEqual(['R', 'L']);
    expect(c2.deviceId).toBe(c1.deviceId);
    expect(c2.getSnapshot().sync.pending).toBeGreaterThan(0); // re-queued for upload
  });

  it('works with real (fake-)IndexedDB', async () => {
    const clock = fakeClock();
    const opts = { clock: clock.now, storage: 'idb', dbName: 'bf-test-idb', mirror: false, autoSync: false } as const;
    const c1 = new FeedCore(opts);
    cores.push(c1);
    await c1.setMe('Samir');
    await c1.addBottle({ amountOz: 4.5, milk: 'formula' });
    await c1.flush();
    const c2 = new FeedCore(opts);
    cores.push(c2);
    await c2.ready;
    expect(c2.getSnapshot().feeds[0]).toMatchObject({ amountOz: 4.5, milk: 'formula' });
    expect(c2.getSnapshot().sync.pending).toBe(2); // member + bottle, not yet in a household
  });
});

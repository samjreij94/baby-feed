import { afterEach, describe, expect, it } from 'vitest';
import { createMemoryServer, device, fakeClock, MIN } from './helpers';

const devices: Array<ReturnType<typeof device>> = [];
afterEach(() => { for (const d of devices.splice(0)) d.core.dispose(); });

const activeOf = (d: ReturnType<typeof device>) => d.core.getSnapshot().feeds.find((x) => x.kind === 'breast' && x.status !== 'ended') as import('../index').BreastFeed | undefined;

async function pair() {
  const clock = fakeClock();
  const server = createMemoryServer({ now: clock.now });
  const mk = (n: string) => { const d = device(n, clock.now, server); devices.push(d); return d; };
  const a = mk('a'); const b = mk('b');
  await a.core.createHousehold('Samir');
  await b.core.joinHousehold(a.core.inviteLink!, 'Karyn');
  await a.core.syncNow();
  return { clock, a, b };
}

describe('backdating a breastfeeding start', () => {
  it('start earlier: the first segment starts at the adjusted time', async () => {
    const { a, clock } = await pair();
    const f = await a.core.startBreast('L', { startedAt: clock.now() - 7 * MIN });
    expect(f.startedAt).toBe(clock.now() - 7 * MIN);
    expect(activeOf(a)?.segments[0]!.startedAt).toBe(clock.now() - 7 * MIN);
  });

  it('edit the start of a running timer; syncs to the other phone; rejects too-far-back', async () => {
    const { a, b, clock } = await pair();
    await a.core.startBreast('L');
    clock.advance(2 * MIN);
    const before = activeOf(a)!;
    const after = await a.core.setActiveStart(clock.now() - 12 * MIN);
    expect(after!.startedAt).toBe(clock.now() - 12 * MIN);
    expect(after!.segments[0]!.startedAt).toBe(clock.now() - 12 * MIN);
    expect(after!.id).toBe(before.id);
    await a.core.syncNow(); await b.core.syncNow();
    const onB = b.core.getSnapshot().feeds.find((x) => x.id === before.id)!;
    expect(onB.kind === 'breast' && onB.startedAt).toBe(clock.now() - 12 * MIN);
    await expect(a.core.setActiveStart(clock.now() - 25 * 3_600_000)).rejects.toThrow(/24 hours/);
    const fut = await a.core.setActiveStart(clock.now() + 5 * MIN); // clamped, never in the future
    expect(fut!.startedAt).toBe(clock.now());
  });

  it('does nothing without a running feed', async () => {
    const { a, clock } = await pair();
    expect(await a.core.setActiveStart(clock.now() - MIN)).toBeNull();
  });
});

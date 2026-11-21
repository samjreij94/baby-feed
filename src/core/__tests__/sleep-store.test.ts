process.env.TZ = 'America/Chicago';

import { afterEach, describe, expect, it } from 'vitest';
import { SLEEP_PLAN_ID, nightNumber, timerState } from '../sleep';
import { createMemoryServer, device, fakeClock, MIN } from './helpers';

const devices: Array<ReturnType<typeof device>> = [];
afterEach(() => {
  for (const d of devices.splice(0)) d.core.dispose();
});

async function pair() {
  const clock = fakeClock(new Date(2026, 10, 20, 20, 0, 0).getTime());
  const server = createMemoryServer({ now: clock.now });
  const mk = (n: string) => {
    const d = device(n, clock.now, server);
    devices.push(d);
    return d;
  };
  const a = mk('a');
  const b = mk('b');
  await a.core.createHousehold('Samir');
  await b.core.joinHousehold(a.core.inviteLink!, 'Karyn');
  await a.core.syncNow();
  return { clock, server, a, b };
}

describe('sleep store + sync', () => {
  it('starts a session, persists a default plan, and records events', async () => {
    const { a, clock } = await pair();
    const s = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    expect(s.type).toBe('night');
    expect(s.putDownAt).toBe(clock.now());
    const plan = a.core.getSnapshot().sleepPlan;
    expect(plan?.id).toBe(SLEEP_PLAN_ID);
    expect(plan?.startDate).toBe('2026-11-20');
    expect(plan?.intervals[0]).toEqual({ night: 1, firstMin: 3, secondMin: 5, laterMin: 10 });
    expect(a.core.getSnapshot().sleepSessions.map((x) => x.id)).toEqual([s.id]);

    await a.core.addSleepEvent(s.id, 'cry_start');
    clock.advance(2 * MIN);
    await a.core.addSleepEvent(s.id, 'cry_stop');
    const cur = a.core.getSnapshot().sleepSessions[0]!;
    expect(cur.events.map((e) => e.kind)).toEqual(['cry_start', 'cry_stop']);
    expect(timerState(cur, plan!, clock.now()).phase).toBe('quiet');
    expect(timerState(cur, plan!, clock.now()).checkIndex).toBe(1);
  });

  it('markAsleep / end / override / discard; morning wake auto-ends', async () => {
    const { a, clock } = await pair();
    const s = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    clock.advance(15 * MIN);
    const slept = await a.core.markAsleep(s.id);
    expect(slept.asleepAt).toBe(clock.now());
    expect(slept.events.some((e) => e.kind === 'asleep')).toBe(true);

    const ended = await a.core.endSleepSession(s.id);
    expect(ended.endedAt).toBe(clock.now());
    expect(await a.core.markAsleep(s.id)).toBe(ended); // no-op
    expect(await a.core.addSleepEvent(s.id, 'note', { text: 'late' })).toEqual(ended);

    const s2 = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    await a.core.setNightNumberOverride(s2.id, 5);
    expect(nightNumber(a.core.getSnapshot().sleepSessions.find((x) => x.id === s2.id)!, a.core.getSnapshot().sleepPlan!)).toBe(5);
    await a.core.setNightNumberOverride(s2.id, null);
    expect(a.core.getSnapshot().sleepSessions.find((x) => x.id === s2.id)!.nightNumberOverride).toBeNull();
    await a.core.discardSleepSession(s2.id);
    expect(a.core.getSnapshot().sleepSessions.find((x) => x.id === s2.id)).toBeUndefined();

    const s3 = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    await a.core.markAsleep(s3.id);
    clock.set(new Date(2026, 10, 21, 6, 30).getTime());
    const morning = await a.core.addSleepEvent(s3.id, 'cry_start');
    expect(morning.endedAt).toBe(clock.now());
  });

  it('syncs plan + session events between two phones; concurrent events are unioned', async () => {
    const { a, b, clock } = await pair();
    const s = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    await a.core.syncNow();
    await b.core.syncNow();
    expect(b.core.getSnapshot().sleepPlan?.startDate).toBe('2026-11-20');
    expect(b.core.getSnapshot().sleepSessions[0]!.id).toBe(s.id);

    clock.advance(MIN);
    await a.core.addSleepEvent(s.id, 'cry_start');
    b.setOffline(true);
    clock.advance(MIN);
    await b.core.addSleepEvent(s.id, 'note', { text: 'patting' });
    b.setOffline(false);
    await a.core.syncNow();
    await b.core.syncNow();
    await a.core.syncNow();
    const kindsA = a.core.getSnapshot().sleepSessions[0]!.events.filter((e) => !e.deleted).map((e) => e.kind).sort();
    const kindsB = b.core.getSnapshot().sleepSessions[0]!.events.filter((e) => !e.deleted).map((e) => e.kind).sort();
    expect(kindsA).toEqual(['cry_start', 'note']);
    expect(kindsB).toEqual(['cry_start', 'note']);
  });

  it('does not change existing feeds or weights', async () => {
    const { a, b, clock } = await pair();
    await a.core.addBottle({ amountOz: 3 });
    await a.core.addManualBreast({ start: clock.now() - 30 * MIN, end: clock.now() - 20 * MIN, side: 'L' });
    await a.core.addWeight({ grams: 3400 });
    await a.core.syncNow();
    await b.core.syncNow();
    const feedsBefore = JSON.stringify(a.core.getSnapshot().feeds);
    const weightsBefore = JSON.stringify(a.core.getSnapshot().weights);
    await b.core.startSleepSession({ type: 'nap', putDownAt: clock.now() });
    await b.core.setSleepPlan({ wakeCutoffMinutes: 330 });
    await b.core.syncNow();
    await a.core.syncNow();
    expect(JSON.stringify(a.core.getSnapshot().feeds)).toBe(feedsBefore);
    expect(JSON.stringify(a.core.getSnapshot().weights)).toBe(weightsBefore);
    expect(a.core.getSnapshot().sleepSessions).toHaveLength(1);
    expect(a.core.getSnapshot().sleepPlan?.wakeCutoffMinutes).toBe(330);
  });

  it('open sessions survive an app restart via the mirror', async () => {
    const { a, clock } = await pair();
    const s = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    await a.core.addSleepEvent(s.id, 'cry_start');
    const core = a.reload();
    await core.ready;
    const snap = core.getSnapshot();
    expect(snap.sleepSessions[0]!.id).toBe(s.id);
    expect(snap.sleepSessions[0]!.events[0]!.kind).toBe('cry_start');
    expect(snap.sleepPlan?.id).toBe(SLEEP_PLAN_ID);
  });

  it('plan reset keeps start date and cutoff; event tombstones hide from the timer', async () => {
    const { a, clock } = await pair();
    await a.core.setSleepPlan({ startDate: '2026-11-18', wakeCutoffMinutes: 390, intervals: a.core.getSnapshot().sleepPlan?.intervals });
    // no plan yet until setSleepPlan — setSleepPlan creates one
    const plan = await a.core.setSleepPlan({ startDate: '2026-11-18', wakeCutoffMinutes: 390 });
    expect(plan.startDate).toBe('2026-11-18');
    const reset = await a.core.resetSleepIntervals();
    expect(reset.startDate).toBe('2026-11-18');
    expect(reset.wakeCutoffMinutes).toBe(390);
    expect(reset.intervals[0]!.firstMin).toBe(3);

    const s = await a.core.startSleepSession({ type: 'night', putDownAt: clock.now() });
    const ev = (await a.core.addSleepEvent(s.id, 'cry_start')).events[0]!;
    await a.core.deleteSleepEvent(s.id, ev.id);
    const cur = a.core.getSnapshot().sleepSessions[0]!;
    expect(cur.events[0]!.deleted).toBe(true);
    expect(timerState(cur, reset, clock.now()).phase).toBe('quiet');
  });
});

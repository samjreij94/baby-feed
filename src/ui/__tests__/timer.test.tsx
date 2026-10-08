import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useActions, useActiveFeedVM } from '../adapter';
import { fakeClock, MIN, testCore, wrapper } from './helpers';

/** Timer math through the adapter on Dealer's real core (start → switch → pause → resume → end). */
function setup() {
  const clock = fakeClock();
  const { core } = testCore({ clock: clock.now });
  const hook = renderHook(() => ({ vm: useActiveFeedVM(), act: useActions() }), { wrapper: wrapper(core) });
  return { clock, core, hook };
}

describe('live timer view-model (switch-side math)', () => {
  it('tracks per-side time across switch, pause and resume; pauses are excluded', async () => {
    const { clock, core, hook } = setup();
    await act(async () => { await core.setMe('Samir'); });
    await act(async () => { await hook.result.current.act.startFeed('L'); });
    expect(hook.result.current.vm).toMatchObject({ status: 'running', currentSide: 'L', startedByOther: false });
    clock.advance(5 * MIN);
    await act(async () => { await hook.result.current.act.switchSide(); }); // L 5
    clock.advance(3 * MIN);
    await act(async () => { await hook.result.current.act.pause(); }); // R 3
    expect(hook.result.current.vm?.status).toBe('paused');
    clock.advance(2 * MIN); // paused: not counted
    await act(async () => { await hook.result.current.act.resume(); }); // resumes on R
    clock.advance(1 * MIN);
    await act(async () => { await hook.result.current.act.switchSide(); }); // R +1 → L
    const vm = hook.result.current.vm!;
    expect(vm.currentSide).toBe('L');
    expect(vm.sideMs).toEqual({ L: 5 * MIN, R: 4 * MIN });
    expect(vm.elapsedMs).toBe(9 * MIN);
    expect(vm.segmentElapsedMs).toBe(0);
    await act(async () => { await hook.result.current.act.endFeed(); });
    expect(hook.result.current.vm).toBeNull();
    const saved = core.getSnapshot().feeds[0]!;
    expect(saved.kind === 'breast' && saved.segments.map((s) => s.side)).toEqual(['L', 'R', 'R', 'L']);
  });

  it('switch while paused resumes on the other side; end while paused ends at the pause', async () => {
    const { clock, core, hook } = setup();
    await act(async () => { await core.setMe('Karyn'); await hook.result.current.act.startFeed('R'); });
    clock.advance(4 * MIN);
    await act(async () => { await hook.result.current.act.pause(); });
    clock.advance(2 * MIN);
    await act(async () => { await hook.result.current.act.switchSide(); });
    expect(hook.result.current.vm).toMatchObject({ status: 'running', currentSide: 'L', sideMs: { L: 0, R: 4 * MIN } });
    clock.advance(3 * MIN);
    await act(async () => { await hook.result.current.act.pause(); });
    const pausedAt = clock.now();
    clock.advance(20 * MIN);
    await act(async () => { await hook.result.current.act.endFeed(); });
    const f = core.getSnapshot().feeds[0]!;
    expect(f.kind === 'breast' && f.endedAt).toBe(pausedAt);
  });

  it('discard removes the running feed', async () => {
    const { core, hook } = setup();
    await act(async () => { await core.setMe('Samir'); await hook.result.current.act.startFeed('L'); });
    const id = hook.result.current.vm!.id;
    await act(async () => { await hook.result.current.act.discardFeed(id); });
    expect(hook.result.current.vm).toBeNull();
    expect(core.getSnapshot().feeds).toHaveLength(0);
  });
});

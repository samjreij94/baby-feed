import { describe, expect, it } from 'vitest';
import * as F from '../feed';
import { ActiveFeedExistsError, FeedCore } from '../store';
import type { BreastFeed } from '../types';
import { fakeClock, MIN } from './helpers';

function setup() {
  const c = fakeClock();
  const core = new FeedCore({ clock: c.now, deviceId: 'dev-a', storage: 'memory', mirror: false, autoSync: false });
  return { c, core };
}

describe('breast timer segments', () => {
  it('start opens one running segment', async () => {
    const { core } = setup();
    await core.setMe('Samir');
    const f = await core.startBreast('L');
    expect(f).toMatchObject({ status: 'running', endedAt: null, pausedAt: null });
    expect(f.segments).toEqual([{ side: 'L', startedAt: f.startedAt, endedAt: null }]);
    await expect(core.startBreast('R')).rejects.toBeInstanceOf(ActiveFeedExistsError);
  });

  it('switch closes the current segment and opens the other side', async () => {
    const { core, c } = setup();
    await core.setMe('Samir');
    await core.startBreast('L');
    c.advance(4 * MIN);
    const f = (await core.switchSide())!;
    expect(f.segments.map((s) => [s.side, s.endedAt === null])).toEqual([['L', false], ['R', true]]);
    c.advance(MIN);
    expect(F.sideMs(f, c.now())).toEqual({ L: 4 * MIN, R: MIN });
  });

  it('pause closes the segment; resume reopens the same side', async () => {
    const { core, c } = setup();
    await core.setMe('Samir');
    await core.startBreast('R');
    c.advance(2 * MIN);
    let f = (await core.pause())!;
    expect(f.status).toBe('paused');
    expect(f.pausedAt).toBe(c.now());
    c.advance(10 * MIN);
    expect(F.nursingMs(f, c.now())).toBe(2 * MIN); // pause excluded
    f = (await core.resume())!;
    expect(f.status).toBe('running');
    expect(f.segments.at(-1)).toMatchObject({ side: 'R', endedAt: null });
  });

  it('switch while paused resumes on the other side', async () => {
    const { core, c } = setup();
    await core.setMe('Samir');
    await core.startBreast('L');
    c.advance(MIN);
    await core.pause();
    c.advance(MIN);
    const f = (await core.switchSide())!;
    expect(f.status).toBe('running');
    expect(f.segments.map((s) => s.side)).toEqual(['L', 'R']);
    expect(f.segments[1]!.startedAt).toBe(c.now());
  });

  it('end while paused uses pausedAt; per-side ms after a full sequence', async () => {
    const { core, c } = setup();
    await core.setMe('Samir');
    await core.startBreast('L');
    c.advance(6 * MIN);
    await core.switchSide();
    c.advance(4 * MIN);
    const pausedAt = c.now();
    await core.pause();
    c.advance(30 * MIN);
    const f = (await core.end())!;
    expect(f.status).toBe('ended');
    expect(f.endedAt).toBe(pausedAt);
    expect(F.sideMs(f, c.now())).toEqual({ L: 6 * MIN, R: 4 * MIN });
    expect(F.validateBreast(f)).toBeNull();
    expect(core.getSnapshot().feeds[0]).toEqual(f);
  });

  it('pure ops are no-ops in the wrong state', () => {
    const f = { ...F.startFields('L', 0) } as BreastFeed;
    expect(F.resume(f, 5)).toBe(f);
    const ended = F.end(f, 5);
    expect(F.switchSide(ended, 6)).toBe(ended);
    expect(F.pause(ended, 6)).toBe(ended);
  });

  it('manual add with segments, and validation', async () => {
    const { core, c } = setup();
    await core.setMe('Karyn');
    const s = c.now() - 60 * MIN;
    const f = await core.addManualBreast({
      start: s,
      end: s + 25 * MIN,
      segments: [
        { side: 'L', startedAt: s, endedAt: s + 10 * MIN },
        { side: 'R', startedAt: s + 12 * MIN, endedAt: s + 25 * MIN },
      ],
    });
    expect(F.sideMs(f, c.now())).toEqual({ L: 10 * MIN, R: 13 * MIN });
    expect(f.loggedBy.name).toBe('Karyn');
    await expect(core.addManualBreast({ start: s, end: s + MIN })).rejects.toThrow(/segments or side/);
    await expect(
      core.addManualBreast({ start: s, end: s + 5 * MIN, segments: [{ side: 'L', startedAt: s, endedAt: s + 9 * MIN }] }),
    ).rejects.toThrow(/Invalid/);
  });

  it('edits bump updatedAt, validate, and discard tombstones the active feed', async () => {
    const { core, c } = setup();
    await core.setMe('Samir');
    const b = await core.addBottle({ amountOz: 2 });
    c.advance(1000);
    const e = await core.editEntry(b.id, { amountOz: 3.25, milk: 'breast' });
    expect(e).toMatchObject({ amountOz: 3.25, milk: 'breast' });
    expect(e.updatedAt).toBeGreaterThan(b.updatedAt);
    await expect(core.editEntry(b.id, { amountOz: 1.1 })).rejects.toThrow(/0.25/);
    await expect(core.addBottle({ amountOz: 0 })).rejects.toThrow();

    const run = await core.startBreast('L');
    await core.editEntry(run.id, { note: 'sleepy' });
    await core.discardActive();
    expect(core.getSnapshot().feeds.map((f) => f.id)).toEqual([b.id]);
    expect(core.allEntries().find((x) => x.id === run.id)?.deleted).toBe(true);
  });
});

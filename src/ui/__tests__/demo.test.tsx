import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useActiveFeedVM, useHouseholdVM } from '../adapter';
import { seedFeeds, seedHousehold, simulateRemoteFeed } from '../demo';
import { MIN, testCore, wrapper } from './helpers';

describe('staging demo harness (real core + in-browser server)', () => {
  beforeEach(() => localStorage.clear());

  it('seed: ~30 days, both parents, valid amounts, newest feed recent', () => {
    const now = new Date(2026, 9, 8, 13, 5).getTime();
    const feeds = seedFeeds(now, { id: 'k', name: 'Karyn' }, { id: 's', name: 'Samir' });
    const starts = feeds.map((f) => (f.kind === 'breast' ? f.startedAt : f.at));
    expect((now - Math.min(...starts)) / (24 * 60 * MIN)).toBeGreaterThan(29);
    expect(now - Math.max(...starts)).toBeLessThanOrEqual(150 * MIN);
    expect(new Set(feeds.map((f) => f.loggedBy.name))).toEqual(new Set(['Samir', 'Karyn']));
    for (const f of feeds) if (f.kind === 'bottle') expect((f.amountOz * 4) % 1).toBe(0);
    expect(feeds.length / 30).toBeGreaterThan(6);
  });

  it('create household → other phone joins → history imported and synced', async () => {
    const { core, server } = testCore();
    await core.createHousehold('Samir');
    await seedHousehold(core, server);
    const s = core.getSnapshot();
    expect(s.members.map((m) => m.name).sort()).toEqual(['Karyn', 'Samir']);
    expect(s.feeds.length).toBeGreaterThan(200);
    expect(s.sync.pending).toBe(0);
    expect(core.inviteCode).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
  });

  it('other parent starts a feed on their phone → this phone shows it with the banner flag', async () => {
    const { core, server } = testCore();
    await core.createHousehold('Samir');
    const { result } = renderHook(() => ({ a: useActiveFeedVM(), h: useHouseholdVM()[0] }), { wrapper: wrapper(core) });
    await act(async () => { await simulateRemoteFeed(core, server); });
    await waitFor(() => expect(result.current.a).not.toBeNull());
    expect(result.current.a).toMatchObject({ startedByOther: true, currentSide: 'R', status: 'running' });
    expect(result.current.a!.startedBy.name).toBe('Karyn');
    expect(Math.round(result.current.a!.sideMs.L / 1000)).toBe(270);
    expect(result.current.h.members).toHaveLength(2);
  });
});

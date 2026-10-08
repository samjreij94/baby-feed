import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as F from './feed';
import { CoreProvider, FeedCore, useActiveFeed, useLastFeed } from './index';
import { formatInviteCode, generateInviteCode, inviteLink, parseInvite } from './invite';
import { compareVersion, lww, nextUpdatedAt } from './merge';
import { computeMetrics } from './metrics';
import type { BreastFeed } from './types';

const MIN = 60_000;

function mkCore(start = new Date(2026, 9, 8, 12, 0).getTime()) {
  let t = start;
  const core = new FeedCore({ clock: () => t, deviceId: 'dev-a', appUrl: 'https://samjreij94.github.io/baby-feed/', storage: 'memory', mirror: false, autoSync: false });
  return { core, advance: (ms: number) => (t += ms), now: () => t };
}

describe('breast timer (smoke)', () => {
  it('start → switch → pause → resume → end records per-side segments', async () => {
    const { core, advance } = mkCore();
    await core.setMe('Samir');
    await core.startBreast('L');
    advance(5 * MIN);
    await core.switchSide();
    advance(3 * MIN);
    await core.pause();
    advance(10 * MIN);
    await core.resume();
    advance(2 * MIN);
    const f = (await core.end())!;
    expect(f.status).toBe('ended');
    expect(f.segments.map((s) => s.side)).toEqual(['L', 'R', 'R']);
    expect(F.sideMs(f, 0)).toEqual({ L: 5 * MIN, R: 5 * MIN });
    expect(f.loggedBy.name).toBe('Samir');
    expect(F.validateBreast(f)).toBeNull();
    expect(F.lastFeedInfo([f], f.endedAt!)).toMatchObject({ lastSide: 'R', nextSide: 'L' });
  });

  it('ending while paused uses pausedAt', () => {
    const base = { ...F.startFields('L', 0) } as BreastFeed;
    const ended = F.end(F.pause(base, 4 * MIN), 30 * MIN);
    expect(ended.endedAt).toBe(4 * MIN);
  });
});

describe('metrics (smoke)', () => {
  it('attributes a feed crossing midnight to its start day', async () => {
    const { core, now } = mkCore(new Date(2026, 9, 8, 23, 50).getTime());
    await core.setMe('Karyn');
    await core.addManualBreast({ start: now(), end: now() + 20 * MIN, side: 'L' });
    await core.addBottle({ amountOz: 2.5, milk: 'formula', at: now() + 30 * MIN });
    const m = computeMetrics(core.getSnapshot().feeds, 7, now() + 60 * MIN);
    const oct8 = m.days.find((d) => d.date === '2026-10-08')!;
    const oct9 = m.days.find((d) => d.date === '2026-10-09')!;
    expect(oct8.breastMinutes).toBe(20);
    expect(oct9.bottleOz).toBe(2.5);
    expect(m.avgGapMinutes).toBe(30);
    expect(m.days).toHaveLength(7);
  });
});

describe('LWW + invite (smoke)', () => {
  it('newer updatedAt wins, deviceId breaks ties', () => {
    const a = { updatedAt: 5, deviceId: 'a' };
    expect(compareVersion({ updatedAt: 5, deviceId: 'b' }, a)).toBeGreaterThan(0);
    expect(lww({ id: 'x', updatedAt: 6, deviceId: 'a' } as never, { id: 'x', updatedAt: 5, deviceId: 'z' } as never)).toMatchObject({ updatedAt: 6 });
    expect(nextUpdatedAt(100, 50)).toBe(101);
  });

  it('invite codes round-trip through grouped form and links', () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(32);
    expect(parseInvite(formatInviteCode(code).toLowerCase())).toBe(code);
    expect(parseInvite(inviteLink('https://samjreij94.github.io/baby-feed/', code))).toBe(code);
    expect(parseInvite('nope')).toBeNull();
  });
});

function Timer() {
  const a = useActiveFeed();
  const last = useLastFeed();
  return (
    <div>
      <span data-testid="side">{a.currentSide ?? '-'}</span>
      <span data-testid="next">{last.nextSide ?? '-'}</span>
    </div>
  );
}

describe('hooks (smoke)', () => {
  it('useActiveFeed reflects a running feed', async () => {
    const { core } = mkCore();
    await core.setMe('Samir');
    render(
      <CoreProvider core={core}>
        <Timer />
      </CoreProvider>,
    );
    expect(screen.getByTestId('side')).toHaveTextContent('-');
    await act(() => core.startBreast('R').then(() => undefined));
    expect(screen.getByTestId('side')).toHaveTextContent('R');
    expect(screen.getByTestId('next')).toHaveTextContent('L');
  });
});

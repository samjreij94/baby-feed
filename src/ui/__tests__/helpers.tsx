import type { ReactNode } from 'react';
import { CoreProvider, FeedCore } from '../../core';
import { createDemoServer, DEMO_API } from '../demo';

export const MIN = 60_000;
export function fakeClock(start = new Date(2026, 9, 9, 3, 0).getTime()) {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v), advance: (ms: number) => (t += ms) };
}

/** A test phone on Dealer's real core: memory storage, no mirror, manual sync, shared in-memory demo server. */
export function testCore(opts: { clock?: () => number; server?: ReturnType<typeof createDemoServer>; deviceId?: string } = {}) {
  const server = opts.server ?? createDemoServer(null);
  const core = new FeedCore({ storage: 'memory', mirror: false, autoSync: false, fetch: server.fetch, apiBaseUrl: DEMO_API, deviceId: opts.deviceId ?? 'dev-test', clock: opts.clock });
  return { core, server };
}

export const wrapper = (core: FeedCore) => ({ children }: { children: ReactNode }) => <CoreProvider core={core}>{children}</CoreProvider>;

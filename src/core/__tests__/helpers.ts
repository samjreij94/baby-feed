import { createMemoryServer } from '../../../server/src/app.ts';
import { FeedCore, type CoreOptions } from '../store';
import { createMemoryStorage, type SyncKv } from '../storage';

export const MIN = 60_000;

export function fakeClock(start = new Date(2026, 9, 8, 12, 0).getTime()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

export function memoryKv(): SyncKv & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A "phone": core + its own storage/mirror, optionally behind a switchable network. */
export function device(name: string, clock: () => number, server?: ReturnType<typeof createMemoryServer>, extra: CoreOptions = {}) {
  const storage = createMemoryStorage();
  const kv = memoryKv();
  let offline = false;
  const fetchImpl = async (input: string, init?: RequestInit) => {
    if (offline) throw new TypeError('Failed to fetch');
    if (!server) throw new TypeError('no server');
    return server.fetch(input, init);
  };
  const make = () =>
    new FeedCore({ clock, deviceId: `dev-${name}`, storage, mirror: kv, autoSync: false, fetch: fetchImpl, apiBaseUrl: 'http://test', ...extra });
  const d = {
    core: make(),
    storage,
    kv,
    setOffline: (v: boolean) => (offline = v),
    /** Simulate an app restart on the same phone. */
    reload: () => {
      d.core.dispose();
      d.core = make();
      return d.core;
    },
  };
  return d;
}

export { createMemoryServer };

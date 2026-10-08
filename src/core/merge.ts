/** Last-write-wins merge (SPEC §5): compare (updatedAt, deviceId) lexicographically. Same rule on client and server. */
import type { Entry } from './types';

/** >0 if a is newer than b, <0 if older, 0 if the same version. */
export function compareVersion(a: Pick<Entry, 'updatedAt' | 'deviceId'>, b: Pick<Entry, 'updatedAt' | 'deviceId'>): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
  return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
}

/** Returns the winner of local vs incoming (local kept on ties). */
export function lww<T extends Entry>(local: T | undefined, incoming: T): T {
  if (!local) return incoming;
  return compareVersion(incoming, local) > 0 ? incoming : local;
}

/** Merge a batch into a map by id; returns the ids whose stored version changed. */
export function mergeInto(store: Map<string, Entry>, incoming: readonly Entry[]): string[] {
  const changed: string[] = [];
  for (const e of incoming) {
    const cur = store.get(e.id);
    const win = lww(cur, e);
    if (win !== cur) {
      store.set(e.id, win);
      changed.push(e.id);
    }
  }
  return changed;
}

/** updatedAt for a new local version: strictly after the version being edited, even if this device's clock is behind. */
export function nextUpdatedAt(prev: number | undefined, now: number): number {
  return prev === undefined ? now : Math.max(now, prev + 1);
}

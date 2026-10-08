/**
 * Persistence behind a tiny key-value interface (the UI never touches this).
 * Production: IndexedDB via idb-keyval (DB `baby-feed`, store `kv`). Tests: memory adapter.
 *
 * Keys:  `meta` → PersistedMeta · `e:<id>` → Entry · `o:<id>` → 1 (outbox membership)
 *
 * Plus a synchronous localStorage MIRROR (`baby-feed:v1:mirror`) of the meta (identity, household) and of the
 * active feeds + locally-written entries whose IndexedDB write hasn't been confirmed yet, so a tap survives
 * iOS killing the app right after it. On load the newer version (LWW) wins.
 */
import { createStore, delMany, entries as idbEntries, setMany } from 'idb-keyval';
import type { Entry, Member } from './types';

export interface KvStorage {
  getAll(): Promise<Array<[string, unknown]>>;
  setMany(pairs: Array<[string, unknown]>): Promise<void>;
  delMany(keys: string[]): Promise<void>;
}

export interface PersistedMeta {
  deviceId: string;
  me: Member | null;
  householdId: string | null;
  secret: string | null;
  cursor: string | null;
  clockOffsetMs: number;
  lastSyncedAt: number | null;
}

export const KEY = {
  meta: 'meta',
  entry: (id: string) => `e:${id}`,
  outbox: (id: string) => `o:${id}`,
} as const;

export function createIdbStorage(dbName = 'baby-feed', storeName = 'kv'): KvStorage {
  const store = createStore(dbName, storeName);
  return {
    getAll: () => idbEntries(store) as Promise<Array<[string, unknown]>>,
    setMany: (pairs) => setMany(pairs, store),
    delMany: (keys) => delMany(keys, store),
  };
}

/** In-memory adapter (values deep-cloned like IndexedDB). `fail` makes writes reject (tests). */
export function createMemoryStorage(): KvStorage & { map: Map<string, unknown>; fail: boolean } {
  const map = new Map<string, unknown>();
  const s = {
    map,
    fail: false,
    getAll: async () => structuredClone([...map.entries()]),
    setMany: async (pairs: Array<[string, unknown]>) => {
      if (s.fail) throw new Error('storage write failed');
      for (const [k, v] of pairs) map.set(k, structuredClone(v));
    },
    delMany: async (keys: string[]) => {
      if (s.fail) throw new Error('storage write failed');
      for (const k of keys) map.delete(k);
    },
  };
  return s;
}

/** The `localStorage` shape. */
export interface SyncKv {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface MirrorData {
  v: 1;
  meta: PersistedMeta;
  entries: Entry[];
}

export class Mirror {
  private readonly kv: SyncKv | null;
  readonly key: string;
  constructor(kv: SyncKv | null, key = 'baby-feed:v1:mirror') {
    this.kv = kv;
    this.key = key;
  }

  read(): MirrorData | null {
    if (!this.kv) return null;
    try {
      const raw = this.kv.getItem(this.key);
      const d = raw ? (JSON.parse(raw) as MirrorData) : null;
      return d && d.v === 1 && d.meta ? d : null;
    } catch {
      return null;
    }
  }

  write(meta: PersistedMeta, entries: Entry[]): void {
    if (!this.kv) return;
    try {
      this.kv.setItem(this.key, JSON.stringify({ v: 1, meta, entries } satisfies MirrorData));
    } catch {
      try {
        this.kv.setItem(this.key, JSON.stringify({ v: 1, meta, entries: [] } satisfies MirrorData)); // quota: keep identity at least
      } catch {
        /* ignore */
      }
    }
  }

  clear(): void {
    this.kv?.removeItem(this.key);
  }
}

export function defaultSyncKv(): SyncKv | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

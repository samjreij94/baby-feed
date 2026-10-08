/**
 * Pure household sync logic (no Workers imports) — used by the Durable Object, the in-process
 * fake server in the client tests, and server unit tests. See SPEC.md §4–6.
 */
import { validAmountOz, validateBreast } from '../../src/core/feed.ts';
import { compareVersion } from '../../src/core/merge.ts';
import type { Entry, Member, SyncResponse } from '../../src/core/types.ts';

export const LIMITS = {
  /** Max entries per sync request (client sends ≤ this). */
  maxChangesPerRequest: 500,
  /** Max entries per response page. */
  pageSize: 500,
  /** Max serialized size of one entry. */
  maxEntryBytes: 8 * 1024,
  /** Max request body. */
  maxBodyBytes: 256 * 1024,
  /** updatedAt may be at most this far in the future (server clock). */
  maxFutureMs: 24 * 3600_000,
  maxNote: 1000,
  maxName: 60,
  maxSegments: 200,
} as const;

// ── secrets ──
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** householdId = first 128 bits of SHA-256(secret), hex. Also the Durable Object name. */
export function householdIdFromHash(hash: string): string {
  return hash.slice(0, 32);
}

/** Constant-time string compare (equal-length hex). */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// ── validation ──
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const isStr = (x: unknown, max: number, min = 1): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** Returns a reason string if the entry is invalid for this household, else null. */
export function validateEntry(e: unknown, householdId: string, now: number): string | null {
  if (!isObj(e)) return 'not an object';
  if (!isStr(e.id, 64) || !ID_RE.test(e.id)) return 'bad id';
  if (e.householdId !== householdId) return 'householdId mismatch';
  if (!isNum(e.createdAt) || !isNum(e.updatedAt)) return 'bad timestamps';
  if (e.updatedAt > now + LIMITS.maxFutureMs) return 'updatedAt in the future';
  if (typeof e.deleted !== 'boolean') return 'bad deleted';
  if (!isObj(e.loggedBy) || !isStr(e.loggedBy.id, 64) || !isStr(e.loggedBy.name, LIMITS.maxName)) return 'bad loggedBy';
  if (!isStr(e.deviceId, 64)) return 'bad deviceId';
  if (e.note !== undefined && !isStr(e.note, LIMITS.maxNote, 0)) return 'bad note';
  if (e.source !== undefined && e.source !== 'app' && e.source !== 'nara') return 'bad source';
  if (e.externalId !== undefined && !isStr(e.externalId, 128)) return 'bad externalId';
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(e)).length;
  } catch {
    return 'not serializable';
  }
  if (size > LIMITS.maxEntryBytes) return 'entry too large';
  switch (e.kind) {
    case 'member':
      return isStr(e.name, LIMITS.maxName) ? null : 'bad name';
    case 'household':
      // One profile record per household: its id IS the householdId. '' = name cleared.
      if (e.id !== householdId) return 'household id mismatch';
      return isStr(e.babyName, LIMITS.maxName, 0) ? null : 'bad babyName';
    case 'bottle':
      if (!isNum(e.at)) return 'bad at';
      if (typeof e.amountOz !== 'number' || !validAmountOz(e.amountOz)) return 'bad amountOz';
      if (e.milk !== undefined && e.milk !== 'breast' && e.milk !== 'formula') return 'bad milk';
      return null;
    case 'breast': {
      if (!isNum(e.startedAt)) return 'bad startedAt';
      if (e.endedAt !== null && !isNum(e.endedAt)) return 'bad endedAt';
      if (e.pausedAt !== null && !isNum(e.pausedAt)) return 'bad pausedAt';
      if (e.status !== 'running' && e.status !== 'paused' && e.status !== 'ended') return 'bad status';
      if (!Array.isArray(e.segments) || e.segments.length > LIMITS.maxSegments) return 'bad segments';
      for (const s of e.segments as unknown[]) {
        if (!isObj(s) || (s.side !== 'L' && s.side !== 'R') || !isNum(s.startedAt) || (s.endedAt !== null && !isNum(s.endedAt))) return 'bad segment';
      }
      return validateBreast(e as never);
    }
    default:
      return 'bad kind';
  }
}

// ── storage abstraction ──
export interface HouseholdMeta {
  secretHash: string;
  createdAt: number;
  /** Last assigned sequence number. */
  seq: number;
}

export interface StoredVersion {
  updatedAt: number;
  deviceId: string;
}

/** Synchronous storage (DO SQLite is synchronous; tests use memory). One row per entry id = latest version. */
export interface HouseholdStorage {
  getMeta(): HouseholdMeta | null;
  setMeta(meta: HouseholdMeta): void;
  getVersion(id: string): StoredVersion | null;
  put(entry: Entry, seq: number): void;
  /** Rows with seq > after, ascending, at most limit. */
  since(after: number, limit: number): Array<{ seq: number; entry: Entry }>;
  members(): Member[];
}

export class MemoryHouseholdStorage implements HouseholdStorage {
  private meta: HouseholdMeta | null = null;
  private rows = new Map<string, { seq: number; json: string }>();
  getMeta() {
    return this.meta ? { ...this.meta } : null;
  }
  setMeta(m: HouseholdMeta) {
    this.meta = { ...m };
  }
  getVersion(id: string) {
    const r = this.rows.get(id);
    if (!r) return null;
    const e = JSON.parse(r.json) as Entry;
    return { updatedAt: e.updatedAt, deviceId: e.deviceId };
  }
  put(entry: Entry, seq: number) {
    this.rows.set(entry.id, { seq, json: JSON.stringify(entry) });
  }
  since(after: number, limit: number) {
    return [...this.rows.values()]
      .filter((r) => r.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
      .map((r) => ({ seq: r.seq, entry: JSON.parse(r.json) as Entry }));
  }
  members() {
    return [...this.rows.values()]
      .map((r) => JSON.parse(r.json) as Entry)
      .filter((e) => e.kind === 'member' && !e.deleted)
      .map((e) => ({ id: e.id, name: (e as { name: string }).name }));
  }
  get size() {
    return this.rows.size;
  }
}

export type SyncResult = { status: 200; body: SyncResponse } | { status: 400 | 401 | 413; body: { error: string } };

/** One household's state machine over a HouseholdStorage. */
export class Household {
  private readonly store: HouseholdStorage;
  private readonly pageSize: number;
  constructor(store: HouseholdStorage, pageSize: number = LIMITS.pageSize) {
    this.store = store;
    this.pageSize = pageSize;
  }

  /** Initialize a new household. false if it already exists. */
  init(secretHash: string, now: number): boolean {
    if (this.store.getMeta()) return false;
    this.store.setMeta({ secretHash, createdAt: now, seq: 0 });
    return true;
  }

  authorize(secretHash: string): boolean {
    const meta = this.store.getMeta();
    return !!meta && timingSafeEqual(meta.secretHash, secretHash);
  }

  members(): Member[] {
    return this.store.members();
  }

  /** Apply `changes` with LWW and return rows after `since`. Caller has authorized. */
  sync(householdId: string, body: unknown, now: number): SyncResult {
    const meta = this.store.getMeta();
    if (!meta) return { status: 401, body: { error: 'Unknown household' } };
    if (!isObj(body)) return { status: 400, body: { error: 'Body must be an object' } };
    const { since, changes } = body;
    if (since !== null && since !== undefined && !(typeof since === 'string' && /^\d{1,15}$/.test(since))) {
      return { status: 400, body: { error: 'Bad cursor' } };
    }
    if (changes !== undefined && !Array.isArray(changes)) return { status: 400, body: { error: 'changes must be an array' } };
    const list = (changes ?? []) as unknown[];
    if (list.length > LIMITS.maxChangesPerRequest) return { status: 413, body: { error: `Max ${LIMITS.maxChangesPerRequest} changes per request` } };

    const rejected: SyncResponse['rejected'] = [];
    let seq = meta.seq;
    for (const raw of list) {
      const reason = validateEntry(raw, householdId, now);
      if (reason) {
        rejected.push({ id: isObj(raw) && typeof raw.id === 'string' ? raw.id.slice(0, 64) : '?', reason });
        continue;
      }
      const e = raw as Entry;
      const cur = this.store.getVersion(e.id);
      if (cur && compareVersion(e, cur) <= 0) continue; // older or same version: ignore
      this.store.put(e, ++seq);
    }
    if (seq !== meta.seq) this.store.setMeta({ ...meta, seq });

    const after = since ? Number(since) : 0;
    const rows = this.store.since(after, this.pageSize + 1);
    const hasMore = rows.length > this.pageSize;
    const page = rows.slice(0, this.pageSize);
    const cursor = String(page.length ? page[page.length - 1]!.seq : Math.min(after, seq));
    return { status: 200, body: { changes: page.map((r) => r.entry), cursor, hasMore, serverNow: now, rejected } };
  }
}

/** The RPC surface the router calls (Durable Object stub in prod, in-process object in tests). */
export interface HouseholdApi {
  create(secretHash: string): Promise<boolean>;
  join(secretHash: string): Promise<{ ok: true; members: Member[] } | { ok: false }>;
  sync(secretHash: string, householdId: string, body: unknown): Promise<SyncResult>;
}

/** Wrap a Household as a HouseholdApi (shared by the DO and the in-memory server). */
export function householdApi(h: Household, now: () => number): HouseholdApi {
  return {
    create: async (hash) => h.init(hash, now()),
    join: async (hash) => (h.authorize(hash) ? { ok: true, members: h.members() } : { ok: false }),
    sync: async (hash, id, body) => (h.authorize(hash) ? h.sync(id, body, now()) : { status: 401, body: { error: 'Invalid household code' } }),
  };
}

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
    case 'weight':
      // Additive kind: grams in 100..30000 (mirrors MIN_GRAMS/MAX_GRAMS in src/core/weight.ts).
      if (!isNum(e.at)) return 'bad at';
      if (typeof e.grams !== 'number' || !Number.isFinite(e.grams) || e.grams < 100 || e.grams > 30_000) return 'bad grams';
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
  /** Live (not deleted) breast feeds whose status is 'running'. */
  runningBreasts(): BreastFeedLike[];
  /** Web-push subscriptions (separate table; never touches entries). */
  putSub(sub: PushSub): void;
  delSub(endpoint: string): void;
  subs(): PushSub[];
  /** Last reminder number already sent per feed id. */
  getAlertN(feedId: string): number;
  setAlertN(feedId: string, n: number): void;
}

export interface BreastFeedLike {
  id: string;
  status: string;
  loggedBy: { id: string };
  segments: Array<{ startedAt: number; endedAt: number | null }>;
}

export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  /** Member (parent) who owns this device; reminders go to the phone of whoever started the feed. */
  memberId: string;
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
  runningBreasts() {
    return [...this.rows.values()]
      .map((r) => JSON.parse(r.json) as Entry)
      .filter((e) => e.kind === 'breast' && !e.deleted && (e as unknown as BreastFeedLike).status === 'running') as unknown as BreastFeedLike[];
  }
  private pushSubs = new Map<string, PushSub>();
  private alertN = new Map<string, number>();
  putSub(sub: PushSub) {
    this.pushSubs.set(sub.endpoint, { ...sub });
  }
  delSub(endpoint: string) {
    this.pushSubs.delete(endpoint);
  }
  subs() {
    return [...this.pushSubs.values()].map((s) => ({ ...s }));
  }
  getAlertN(feedId: string) {
    return this.alertN.get(feedId) ?? 0;
  }
  setAlertN(feedId: string, n: number) {
    this.alertN.set(feedId, n);
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

  // ── push reminders (additive: own tables, never touches entries) ──
  addSub(raw: unknown): boolean {
    const sub = validPushSub(raw);
    if (!sub) return false;
    this.store.putSub(sub);
    return true;
  }
  removeSub(endpoint: string): void {
    this.store.delSub(endpoint);
  }
  hasSubs(): boolean {
    return this.store.subs().length > 0;
  }

  /** When the next reminder is due (epoch ms), or null if there is nothing to remind about. */
  nextAlertAt(now: number): number | null {
    if (!this.hasSubs()) return null;
    let next: number | null = null;
    for (const f of this.store.runningBreasts()) {
      const e = nursingMs(f, now);
      // Overdue (e.g. the start time was moved earlier) -> `at` is in the past and fires right away.
      const n = this.store.getAlertN(f.id) + 1;
      if (n > MAX_ALERTS) continue;
      const at = now + (n * ALERT_EVERY_MS - e);
      if (next === null || at < next) next = at;
    }
    return next;
  }

  /** Send every reminder that is due and return the next alarm time (or null). */
  async runAlerts(now: number, send: PushSender): Promise<number | null> {
    for (const f of this.store.runningBreasts()) {
      const n = Math.min(Math.floor(nursingMs(f, now) / ALERT_EVERY_MS), MAX_ALERTS + 1);
      if (n < 1 || n <= this.store.getAlertN(f.id)) continue;
      this.store.setAlertN(f.id, n);
      if (n > MAX_ALERTS) continue; // already way past: don't start buzzing now
      const all = this.store.subs();
      const mine = all.filter((s) => s.memberId === f.loggedBy.id);
      for (const sub of mine.length ? mine : all) {
        if ((await send(sub)) === 'gone') this.store.delSub(sub.endpoint);
      }
    }
    return this.nextAlertAt(now);
  }
}

// ── "Still feeding?" reminders ──
/** A running breastfeeding timer gets a reminder at 15 min of nursing time, then every 15 min after. */
export const ALERT_EVERY_MS = 15 * 60_000;
/** Stop reminding after this many (2 h) so a forgotten timer doesn't buzz all night. */
export const MAX_ALERTS = 8;

/** Nursing time so far (sum of segments, the open one up to `now`; pauses excluded). */
export function nursingMs(f: BreastFeedLike, now: number): number {
  let t = 0;
  for (const s of f.segments) t += Math.max(0, (s.endedAt ?? now) - s.startedAt);
  return t;
}

/** Returns true when the push was delivered or should simply be retried later; 'gone' = subscription expired (delete it). */
export type PushSender = (sub: PushSub) => Promise<'ok' | 'gone' | 'fail'>;

export function validPushSub(x: unknown): PushSub | null {
  if (!isObj(x)) return null;
  const { endpoint, p256dh, auth, memberId } = x;
  if (typeof endpoint !== 'string' || endpoint.length > 1024 || !isPushEndpoint(endpoint)) return null;
  if (typeof p256dh !== 'string' || p256dh.length > 256 || typeof auth !== 'string' || auth.length > 128) return null;
  if (typeof memberId !== 'string' || memberId.length > 64) return null;
  return { endpoint, p256dh, auth, memberId };
}

/** Only real browser push services (the Worker fetches this URL, so never an arbitrary host). */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname;
  return (
    h === 'fcm.googleapis.com' ||
    h.endsWith('.push.apple.com') || h === 'push.apple.com' ||
    h.endsWith('.push.services.mozilla.com') ||
    h.endsWith('.notify.windows.com')
  );
}

/** The RPC surface the router calls (Durable Object stub in prod, in-process object in tests). */
export interface HouseholdApi {
  create(secretHash: string): Promise<boolean>;
  join(secretHash: string): Promise<{ ok: true; members: Member[] } | { ok: false }>;
  sync(secretHash: string, householdId: string, body: unknown): Promise<SyncResult>;
  pushSubscribe(secretHash: string, sub: unknown): Promise<boolean>;
  pushUnsubscribe(secretHash: string, endpoint: string): Promise<boolean>;
}

/** Wrap a Household as a HouseholdApi (shared by the DO and the in-memory server). */
export function householdApi(h: Household, now: () => number): HouseholdApi {
  return {
    create: async (hash) => h.init(hash, now()),
    join: async (hash) => (h.authorize(hash) ? { ok: true, members: h.members() } : { ok: false }),
    sync: async (hash, id, body) => (h.authorize(hash) ? h.sync(id, body, now()) : { status: 401, body: { error: 'Invalid household code' } }),
    pushSubscribe: async (hash, sub) => (h.authorize(hash) ? h.addSub(sub) : false),
    pushUnsubscribe: async (hash, endpoint) => (h.authorize(hash) ? (h.removeSub(endpoint), true) : false),
  };
}

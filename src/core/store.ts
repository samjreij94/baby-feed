/**
 * FeedCore — the single store the hooks read from: entries + identity + household, persisted in IndexedDB
 * (with a synchronous localStorage mirror), and synced through an outbox (SPEC §5).
 */
import { createApiClient, HttpError, NetworkError, type ApiClient, type FetchLike } from './api';
import * as F from './feed';
import { formatInviteCode, inviteLink, parseInvite } from './invite';
import { compareVersion, nextUpdatedAt } from './merge';
import { createIdbStorage, createMemoryStorage, defaultSyncKv, KEY, Mirror, type KvStorage, type PersistedMeta, type SyncKv } from './storage';
import type {
  AddBottleInput,
  AddManualBreastInput,
  BottleFeed,
  BreastFeed,
  Entry,
  EntryBase,
  EntryPatch,
  Feed,
  ImportResult,
  Member,
  MemberEntry,
  Side,
  SyncResponse,
  SyncState,
} from './types';

/** Kept for compatibility; nothing throws it any more. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented`);
    this.name = 'NotImplementedError';
  }
}

export class ActiveFeedExistsError extends Error {
  constructor() {
    super('A breast feed is already running — switch side, pause or end it first');
    this.name = 'ActiveFeedExistsError';
  }
}

export interface CoreSnapshot {
  /** Non-deleted feeds, newest start first. */
  feeds: Feed[];
  members: Member[];
  me: Member | null;
  householdId: string | null;
  /** Ungrouped secret, null when no household. */
  secret: string | null;
  sync: { state: SyncState; lastSyncedAt: number | null; pending: number; error: string | null; clockOffsetMs: number };
  /** false until IndexedDB has loaded (the mirror is shown before that). */
  ready: boolean;
}

export interface CoreOptions {
  /** Defaults to Date.now. Tests inject a fake clock. */
  clock?: () => number;
  /** Force a device id (else persisted/generated). */
  deviceId?: string;
  /** App URL used for invite links. Default: location.origin + import.meta.env.BASE_URL. */
  appUrl?: string;
  /** Sync server base URL. Default: VITE_API_BASE_URL or http://localhost:8787. */
  apiBaseUrl?: string;
  /** Persistence: 'idb' (default when indexedDB exists), 'memory', or a custom KvStorage. */
  storage?: KvStorage | 'idb' | 'memory';
  /** IndexedDB database name (default 'baby-feed'). */
  dbName?: string;
  /** Synchronous mirror: a localStorage-like object, true (localStorage; default with idb), or false. */
  mirror?: SyncKv | boolean;
  /** localStorage key of the mirror. */
  mirrorKey?: string;
  /** fetch implementation (tests: in-process server). */
  fetch?: FetchLike;
  /** Poll/visibility/online scheduling (default true in a browser). Tests call syncNow() themselves. */
  autoSync?: boolean;
  /** Poll interval while visible (default 4000 ms). */
  pollMs?: number;
  /** Delay before syncing after a local change (default 300 ms). */
  debounceMs?: number;
}

export function defaultApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
}

const MAX_OFFSET_MS = 24 * 3600_000;
const versionKey = (e: Entry) => `${e.updatedAt}|${e.deviceId}`;
const isActiveBreast = (e: Entry): e is BreastFeed => e.kind === 'breast' && !e.deleted && e.status !== 'ended';

export class FeedCore {
  private entries = new Map<string, Entry>();
  private outbox = new Set<string>();
  private listeners = new Set<() => void>();
  private snap: CoreSnapshot;
  private meta: PersistedMeta;
  readonly appUrl: string;
  readonly apiBaseUrl: string;
  private readonly clock: () => number;
  private readonly storage: KvStorage;
  private readonly mirror: Mirror;
  private readonly api: ApiClient;
  private readonly opts: CoreOptions;
  private isReady = false;
  /** Resolves when persisted state has loaded. Every action awaits it. */
  readonly ready: Promise<void>;

  // persistence bookkeeping
  private dirtyEntries = new Set<string>();
  private dirtyOutbox = new Set<string>();
  private metaDirty = false;
  /** Locally written entries not yet confirmed in IndexedDB (mirrored). */
  private localUnflushed = new Set<string>();
  private flushing: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  // sync bookkeeping
  private syncState: SyncState = 'idle';
  private syncError: string | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private failures = 0;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private disposers: Array<() => void> = [];
  private disposed = false;

  constructor(opts: CoreOptions = {}) {
    this.opts = opts;
    this.clock = opts.clock ?? Date.now;
    this.appUrl = opts.appUrl ?? (typeof location !== 'undefined' ? location.origin + import.meta.env.BASE_URL : 'http://localhost:5173/baby-feed/');
    this.apiBaseUrl = (opts.apiBaseUrl ?? defaultApiBaseUrl()).replace(/\/+$/, '');
    this.api = createApiClient(this.apiBaseUrl, opts.fetch);

    const useIdb = opts.storage === 'idb' || (opts.storage === undefined && typeof indexedDB !== 'undefined');
    this.storage =
      typeof opts.storage === 'object' ? opts.storage : useIdb ? createIdbStorage(opts.dbName) : createMemoryStorage();
    const mirrorKv = opts.mirror === false ? null : typeof opts.mirror === 'object' ? opts.mirror : opts.mirror === true || useIdb ? defaultSyncKv() : null;
    this.mirror = new Mirror(mirrorKv, opts.mirrorKey);

    // 1) synchronous: mirror → immediate snapshot (identity + running timer survive a kill)
    const m = this.mirror.read();
    this.meta = m?.meta ?? { deviceId: '', me: null, householdId: null, secret: null, cursor: null, clockOffsetMs: 0, lastSyncedAt: null };
    if (opts.deviceId) this.meta.deviceId = opts.deviceId;
    for (const e of m?.entries ?? []) this.entries.set(e.id, e);
    this.snap = this.buildSnapshot();

    // 2) async: IndexedDB
    this.ready = this.load(m?.entries ?? []).catch((err) => {
      console.error('[core] load failed', err);
      this.isReady = true;
      this.emit();
    });
  }

  private async load(mirrorEntries: Entry[]): Promise<void> {
    const rows = await this.storage.getAll();
    let idbMeta: PersistedMeta | undefined;
    const loaded = new Map<string, Entry>();
    for (const [k, v] of rows) {
      if (k === KEY.meta) idbMeta = v as PersistedMeta;
      else if (k.startsWith('e:')) loaded.set(k.slice(2), v as Entry);
      else if (k.startsWith('o:')) this.outbox.add(k.slice(2));
    }
    const mirrorMeta = this.mirror.read()?.meta;
    this.meta = { ...(idbMeta ?? this.meta), ...(mirrorMeta ?? {}) };
    if (this.opts.deviceId) this.meta.deviceId = this.opts.deviceId;
    if (!this.meta.deviceId) this.meta.deviceId = crypto.randomUUID();
    if (!idbMeta || JSON.stringify(idbMeta) !== JSON.stringify(this.meta)) this.metaDirty = true;

    for (const [id, e] of loaded) this.entries.set(id, e);
    for (const me of mirrorEntries) {
      const idb = loaded.get(me.id);
      if (!idb || compareVersion(me, idb) > 0) {
        this.entries.set(me.id, me); // mirror is newer: IndexedDB write was lost
        this.dirtyEntries.add(me.id);
        this.localUnflushed.add(me.id);
        if (me.deviceId === this.meta.deviceId) this.markOutbox(me.id, true);
      } else this.entries.set(me.id, idb);
    }
    for (const id of this.outbox) if (!this.entries.has(id)) this.markOutbox(id, false);
    this.isReady = true;
    this.writeMirror();
    this.emit();
    if (this.dirtyEntries.size || this.dirtyOutbox.size || this.metaDirty) await this.flush();
    if (this.opts.autoSync ?? typeof window !== 'undefined') this.startAutoSync();
  }

  get deviceId(): string {
    return this.meta.deviceId;
  }
  get householdId(): string | null {
    return this.meta.householdId;
  }

  // ── clock ──
  /** Core clock: device clock + estimated server offset (SPEC §5). Use for all displays of elapsed time. */
  now(): number {
    return this.clock() + this.meta.clockOffsetMs;
  }

  // ── subscription (useSyncExternalStore) ──
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): CoreSnapshot => this.snap;

  private emit() {
    this.snap = this.buildSnapshot();
    for (const l of this.listeners) l();
  }

  private buildSnapshot(): CoreSnapshot {
    const all = [...this.entries.values()].filter((e) => !e.deleted);
    const feeds = all.filter((e): e is Feed => e.kind !== 'member').sort((a, b) => F.feedStart(b) - F.feedStart(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const members = all
      .filter((e): e is MemberEntry => e.kind === 'member')
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((m) => ({ id: m.id, name: m.name }));
    const meId = this.meta.me?.id;
    const me = meId ? (members.find((m) => m.id === meId) ?? this.meta.me) : null;
    return {
      feeds,
      members,
      me,
      householdId: this.meta.householdId,
      secret: this.meta.secret,
      sync: {
        state: this.syncState,
        lastSyncedAt: this.meta.lastSyncedAt,
        pending: this.outbox.size,
        error: this.syncError,
        clockOffsetMs: this.meta.clockOffsetMs,
      },
      ready: this.isReady,
    };
  }

  get inviteCode(): string | null {
    return this.meta.secret ? formatInviteCode(this.meta.secret) : null;
  }
  get inviteLink(): string | null {
    return this.meta.secret ? inviteLink(this.appUrl, this.meta.secret) : null;
  }

  /** All entries incl. tombstones and members (debug/tests). */
  allEntries(): Entry[] {
    return [...this.entries.values()];
  }

  // ── persistence ──
  private markOutbox(id: string, present: boolean) {
    if (present) this.outbox.add(id);
    else this.outbox.delete(id);
    this.dirtyOutbox.add(id);
  }

  private setMeta(patch: Partial<PersistedMeta>) {
    this.meta = { ...this.meta, ...patch };
    this.metaDirty = true;
    this.writeMirror();
  }

  private writeMirror() {
    const ids = new Set(this.localUnflushed);
    for (const e of this.entries.values()) if (isActiveBreast(e)) ids.add(e.id);
    const list = [...ids].map((id) => this.entries.get(id)).filter((e): e is Entry => !!e);
    this.mirror.write(this.meta, list);
  }

  private scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((err) => console.error('[core] flush failed', err));
    }, 0);
  }

  /** Write pending changes to IndexedDB now (called on pagehide / hidden too). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    while (this.flushing) await this.flushing.catch(() => undefined);
    if (!this.dirtyEntries.size && !this.dirtyOutbox.size && !this.metaDirty) return;
    const ids = [...this.dirtyEntries];
    const ob = [...this.dirtyOutbox];
    const metaDirty = this.metaDirty;
    this.dirtyEntries.clear();
    this.dirtyOutbox.clear();
    this.metaDirty = false;
    const written = new Map(ids.map((id) => [id, this.entries.get(id)] as const));
    const sets: Array<[string, unknown]> = [];
    const dels: string[] = [];
    for (const [id, e] of written) if (e) sets.push([KEY.entry(id), e]);
    for (const id of ob) {
      if (this.outbox.has(id)) sets.push([KEY.outbox(id), 1]);
      else dels.push(KEY.outbox(id));
    }
    if (metaDirty) sets.push([KEY.meta, this.meta]);
    const run = (async () => {
      if (sets.length) await this.storage.setMany(sets);
      if (dels.length) await this.storage.delMany(dels);
    })();
    this.flushing = run;
    try {
      await run;
      let mirrorChanged = false;
      for (const [id, e] of written) {
        if (this.entries.get(id) === e && this.localUnflushed.delete(id)) mirrorChanged = true;
      }
      if (mirrorChanged) this.writeMirror();
    } catch (err) {
      for (const id of ids) this.dirtyEntries.add(id);
      for (const id of ob) this.dirtyOutbox.add(id);
      if (metaDirty) this.metaDirty = true;
      throw err;
    } finally {
      this.flushing = null;
    }
  }

  // ── writes ──
  private requireMe(): Member {
    const me = this.snap.me;
    if (!me) throw new Error('Set the device member first (useHousehold().setMe / createHousehold / joinHousehold)');
    return me;
  }

  private base(now: number): EntryBase {
    return {
      id: crypto.randomUUID(),
      householdId: this.meta.householdId,
      createdAt: now,
      updatedAt: now,
      deleted: false,
      loggedBy: this.requireMe(),
      deviceId: this.deviceId,
    };
  }

  /** Store a new LOCAL version: bumps updatedAt/deviceId, persists (mirror now, IndexedDB soon), enqueues for sync. */
  private put<T extends Entry>(e: T, prev?: Entry): T {
    const v = { ...e, updatedAt: nextUpdatedAt(prev?.updatedAt, this.now()), deviceId: this.deviceId } as T;
    this.entries.set(v.id, v);
    this.dirtyEntries.add(v.id);
    this.localUnflushed.add(v.id);
    this.markOutbox(v.id, true);
    this.writeMirror();
    this.emit();
    this.scheduleFlush();
    this.scheduleSoonSync();
    return v;
  }

  private active(): BreastFeed | null {
    return F.activeFeedView(this.snap.feeds, this.now()).feed;
  }

  private async updateActive(op: (f: BreastFeed, at: number) => BreastFeed): Promise<BreastFeed | null> {
    await this.ready;
    const cur = this.active();
    if (!cur) return null;
    const next = op(cur, this.now());
    return next === cur ? cur : this.put(next, cur);
  }

  async startBreast(side: Side, opts: { startedAt?: number } = {}): Promise<BreastFeed> {
    await this.ready;
    if (this.active()) throw new ActiveFeedExistsError();
    const now = this.now();
    return this.put({ ...this.base(now), ...F.startFields(side, opts.startedAt ?? now) });
  }
  switchSide() {
    return this.updateActive(F.switchSide);
  }
  pause() {
    return this.updateActive(F.pause);
  }
  resume() {
    return this.updateActive(F.resume);
  }
  end() {
    return this.updateActive(F.end);
  }
  /** Delete (tombstone) the active feed — "started by mistake". */
  async discardActive(): Promise<void> {
    await this.ready;
    const cur = this.active();
    if (cur) await this.deleteEntry(cur.id);
  }

  async addBottle(input: AddBottleInput): Promise<BottleFeed> {
    await this.ready;
    if (!F.validAmountOz(input.amountOz)) throw new Error('amountOz must be > 0 in 0.25 oz steps');
    const now = this.now();
    const e: BottleFeed = { ...this.base(now), kind: 'bottle', at: input.at ?? now, amountOz: input.amountOz };
    if (input.milk) e.milk = input.milk;
    if (input.note) e.note = input.note;
    return this.put(e);
  }

  async addManualBreast(input: AddManualBreastInput): Promise<BreastFeed> {
    await this.ready;
    const segments = input.segments ?? (input.side ? [{ side: input.side, startedAt: input.start, endedAt: input.end }] : null);
    if (!segments) throw new Error('addManualBreast needs segments or side');
    if (input.end < input.start) throw new Error('end before start');
    const e: BreastFeed = {
      ...this.base(this.now()),
      kind: 'breast',
      startedAt: input.start,
      endedAt: input.end,
      segments: segments.map((s) => ({ side: s.side, startedAt: s.startedAt, endedAt: s.endedAt })),
      pausedAt: null,
      status: 'ended',
    };
    if (input.note) e.note = input.note;
    const err = F.validateBreast(e) ?? (segments.some((s) => s.endedAt > input.end) ? 'segment after end' : null);
    if (err) throw new Error(`Invalid breast feed: ${err}`);
    return this.put(e);
  }

  async editEntry(id: string, patch: EntryPatch): Promise<Feed> {
    await this.ready;
    const cur = this.entries.get(id);
    if (!cur || cur.deleted || cur.kind === 'member') throw new Error(`No feed ${id}`);
    const next = { ...cur, ...patch } as Feed;
    if (next.kind === 'breast') {
      const err = F.validateBreast(next);
      if (err) throw new Error(`Invalid breast feed: ${err}`);
    } else if (!F.validAmountOz(next.amountOz)) throw new Error('amountOz must be > 0 in 0.25 oz steps');
    return this.put(next, cur);
  }

  async deleteEntry(id: string): Promise<void> {
    await this.ready;
    const cur = this.entries.get(id);
    if (!cur || cur.deleted) return;
    this.put({ ...cur, deleted: true }, cur);
  }

  /**
   * Bulk insert (Nara import). Only ids that don't exist locally are added (never overwrites a local edit,
   * never resurrects a tombstone). Stamps householdId when joined, queues for sync, persists in one batch.
   * Versions (updatedAt/deviceId) are kept as given, so deterministic ids make re-imports idempotent on either phone.
   */
  async importEntries(entries: Feed[]): Promise<ImportResult> {
    await this.ready;
    const r: ImportResult = { added: 0, skippedExisting: 0, skippedDeleted: 0, invalid: 0 };
    for (const raw of entries) {
      const cur = this.entries.get(raw.id);
      if (cur) {
        if (cur.deleted) r.skippedDeleted++;
        else r.skippedExisting++;
        continue;
      }
      const e = { ...raw, householdId: this.meta.householdId ?? raw.householdId ?? null, deviceId: raw.deviceId || this.deviceId } as Feed;
      const bad =
        !e.id || !Number.isFinite(e.updatedAt) || !e.loggedBy
          ? 'bad base'
          : e.kind === 'breast'
            ? F.validateBreast(e)
            : e.kind === 'bottle'
              ? F.validAmountOz(e.amountOz)
                ? null
                : 'bad amount'
              : 'bad kind';
      if (bad) {
        r.invalid++;
        continue;
      }
      this.entries.set(e.id, e);
      this.dirtyEntries.add(e.id);
      this.markOutbox(e.id, true);
      r.added++;
    }
    if (r.added) {
      this.emit();
      await this.flush();
      this.scheduleSoonSync();
    }
    return r;
  }

  // ── household ──
  async setMe(name: string): Promise<Member> {
    await this.ready;
    const trimmed = name.trim().slice(0, 60);
    if (!trimmed) throw new Error('Name required');
    const id = this.meta.me?.id ?? crypto.randomUUID();
    const self: Member = { id, name: trimmed };
    this.setMeta({ me: self });
    const prev = this.entries.get(id);
    if (prev?.kind === 'member' && prev.name === trimmed && !prev.deleted) {
      this.emit();
      return self;
    }
    const now = this.now();
    const m: MemberEntry =
      prev?.kind === 'member'
        ? { ...prev, name: trimmed, deleted: false, loggedBy: self }
        : { id, householdId: this.meta.householdId, createdAt: now, updatedAt: now, deleted: false, loggedBy: self, deviceId: this.deviceId, kind: 'member', name: trimmed };
    this.put(m, prev);
    return self;
  }

  /** Stamp local entries that have no household yet with householdId (no version bump: they were never synced). */
  private adoptHousehold(householdId: string, secret: string) {
    this.setMeta({ householdId, secret, cursor: null });
    for (const e of this.entries.values()) {
      if (e.householdId === null) {
        const v = { ...e, householdId };
        this.entries.set(e.id, v);
        this.dirtyEntries.add(e.id);
        this.localUnflushed.add(e.id);
        this.markOutbox(e.id, true);
      }
    }
    this.syncError = null;
    this.failures = 0;
    this.writeMirror();
    this.emit();
  }

  async createHousehold(myName: string): Promise<void> {
    await this.ready;
    if (this.meta.householdId) throw new Error('Already in a household — leave it first');
    await this.setMe(myName);
    const res = await this.api.createHousehold();
    this.adoptHousehold(res.householdId, res.secret);
    await this.flush();
    this.reschedule();
    await this.syncNow();
  }

  async joinHousehold(codeOrLink: string, myName: string): Promise<void> {
    await this.ready;
    const code = parseInvite(codeOrLink);
    if (!code) throw new Error('That invite code is not valid');
    if (this.meta.householdId && this.meta.secret === code) return;
    if (this.meta.householdId) throw new Error('Already in a household — leave it first');
    let res;
    try {
      res = await this.api.joinHousehold(code);
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw new Error('Invite code not recognised');
      throw e;
    }
    // Re-joining (e.g. reinstall): adopt the existing member with the same name instead of creating a duplicate.
    if (!this.meta.me) {
      const same = res.members.find((m) => m.name.trim().toLowerCase() === myName.trim().toLowerCase());
      if (same) this.setMeta({ me: { id: same.id, name: same.name } });
    }
    await this.setMe(myName);
    this.adoptHousehold(res.householdId, code);
    await this.flush();
    this.reschedule();
    await this.syncNow();
  }

  /** Forget the household on this device. Local data is kept; the server is untouched. */
  async leave(): Promise<void> {
    await this.ready;
    this.setMeta({ householdId: null, secret: null, cursor: null, lastSyncedAt: null });
    this.syncState = 'idle';
    this.syncError = null;
    this.clearTimers();
    this.emit();
    await this.flush();
  }

  // ── sync ──
  private setSync(state: SyncState, error: string | null = this.syncError) {
    this.syncState = state;
    this.syncError = error;
    this.emit();
  }

  /** Run a sync round now (pushes the outbox, pulls changes). Never throws; see useSync().state/error. */
  async syncNow(): Promise<void> {
    await this.ready;
    if (!this.meta.householdId || !this.meta.secret || this.disposed) return;
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        for (let i = 0; i < 50; i++) {
          this.syncAgain = false;
          const more = await this.syncOnce();
          if (more === null) break;
          if (!more && !this.syncAgain) break;
        }
      } finally {
        this.syncing = null;
        this.reschedule();
      }
    })();
    return this.syncing;
  }

  /** One request. true = call again (more pages / more outbox), false = done, null = failed. */
  private async syncOnce(): Promise<boolean | null> {
    const hh = this.meta.householdId;
    const secret = this.meta.secret;
    if (!hh || !secret) return null;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      this.failures++;
      this.setSync('offline', null);
      return null;
    }
    // Outbox entries from another household (left + joined elsewhere) can never be uploaded: drop them.
    for (const id of [...this.outbox]) {
      const e = this.entries.get(id);
      if (!e || (e.householdId !== hh && e.householdId !== null)) this.markOutbox(id, false);
    }
    // ≤500 entries and ≤192 KB per request (server caps: 500 / 256 KB)
    const changes: Entry[] = [];
    let bytes = 0;
    for (const id of this.outbox) {
      const e = this.entries.get(id)!;
      if (e.householdId !== hh) continue;
      const size = JSON.stringify(e).length + 1;
      if (changes.length >= 500 || (changes.length && bytes + size > 192 * 1024)) break;
      changes.push(e);
      bytes += size;
    }
    const sent = new Map(changes.map((e) => [e.id, versionKey(e)] as const));
    this.setSync('syncing');
    const t0 = this.clock();
    let res: SyncResponse;
    try {
      res = await this.api.sync(secret, { since: this.meta.cursor, changes, deviceId: this.deviceId });
    } catch (e) {
      this.failures++;
      if (e instanceof NetworkError) this.setSync('offline', null);
      else if (e instanceof HttpError && e.status === 401) this.setSync('error', 'This household code is no longer valid');
      else this.setSync('error', e instanceof Error ? e.message : String(e));
      return null;
    }
    if (this.meta.householdId !== hh) return null; // left during the request
    const t1 = this.clock();

    // clock offset (SPEC §5)
    const sample = res.serverNow - (t0 + t1) / 2;
    if (Number.isFinite(sample)) {
      const prev = this.meta.clockOffsetMs;
      let next = this.meta.lastSyncedAt === null || Math.abs(sample - prev) > 5000 ? sample : prev + (sample - prev) * 0.5;
      next = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, Math.round(next)));
      this.meta.clockOffsetMs = next;
    }

    // apply remote (LWW)
    for (const inc of res.changes) {
      const cur = this.entries.get(inc.id);
      if (cur && compareVersion(inc, cur) <= 0) continue;
      this.entries.set(inc.id, inc);
      this.dirtyEntries.add(inc.id);
      if (this.outbox.has(inc.id)) this.markOutbox(inc.id, false); // our pending version lost
    }
    // ack: only versions that are still the latest local ones
    for (const [id, ver] of sent) {
      const cur = this.entries.get(id);
      if (this.outbox.has(id) && cur && versionKey(cur) === ver) this.markOutbox(id, false);
    }
    let error: string | null = null;
    if (res.rejected.length) {
      for (const r of res.rejected) {
        if (this.outbox.has(r.id) && sent.has(r.id)) this.markOutbox(r.id, false);
      }
      error = `${res.rejected.length} change(s) rejected by the server: ${res.rejected[0]!.reason}`;
      console.warn('[core] rejected', res.rejected);
    }
    // persist entries before advancing the cursor
    await this.flush();
    this.setMeta({ cursor: res.cursor, lastSyncedAt: this.now() });
    this.failures = 0;
    this.setSync('idle', error);
    await this.flush();
    const sendable = [...this.outbox].some((id) => this.entries.get(id)?.householdId === hh);
    return res.hasMore || sendable;
  }

  // ── scheduling ──
  private visible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  private clearTimers() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = this.debounceTimer = null;
  }

  private autoSync = false;

  /** Next poll: pollMs while visible, exponential backoff with jitter after failures; nothing when hidden/no household. */
  private reschedule() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (!this.autoSync || this.disposed || !this.meta.householdId || !this.visible()) return;
    const poll = this.opts.pollMs ?? 4000;
    const delay = this.failures ? Math.min(60_000, 5000 * 2 ** (this.failures - 1)) * (0.8 + Math.random() * 0.4) : poll;
    this.pollTimer = setTimeout(() => void this.syncNow(), delay);
  }

  private scheduleSoonSync() {
    if (!this.autoSync || !this.meta.householdId) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.syncNow();
    }, this.opts.debounceMs ?? 300);
  }

  /** Start polling + visibility/online/pagehide listeners (done automatically in the browser). */
  startAutoSync() {
    if (this.autoSync || this.disposed) return;
    this.autoSync = true;
    const on = (target: EventTarget | undefined, ev: string, fn: () => void) => {
      if (!target) return;
      target.addEventListener(ev, fn);
      this.disposers.push(() => target.removeEventListener(ev, fn));
    };
    const doc = typeof document !== 'undefined' ? document : undefined;
    const win = typeof window !== 'undefined' ? window : undefined;
    on(doc, 'visibilitychange', () => {
      if (this.visible()) {
        this.failures = 0;
        void this.syncNow();
      } else {
        this.clearTimers();
        this.writeMirror();
        void this.flush().catch(() => undefined);
      }
    });
    on(win, 'pagehide', () => {
      this.writeMirror();
      void this.flush().catch(() => undefined);
    });
    on(win, 'online', () => {
      this.failures = 0;
      void this.syncNow();
    });
    on(win, 'offline', () => {
      if (this.meta.householdId) this.setSync('offline', null);
    });
    void this.syncNow();
  }

  /** Stop timers and listeners (tests / hot reload). */
  dispose() {
    this.disposed = true;
    this.clearTimers();
    for (const d of this.disposers.splice(0)) d();
  }
}

let singleton: FeedCore | null = null;
/** The app-wide core (created lazily; IndexedDB + localStorage mirror + auto sync). */
export function getCore(): FeedCore {
  return (singleton ??= new FeedCore());
}

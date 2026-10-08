/**
 * FeedCore — the single store the hooks read from.
 * PHASE 1: in-memory only (feeds + timer actions work; IndexedDB persistence, outbox and sync arrive in phase 2
 * behind the same API). Household/sync actions throw NotImplementedError for now.
 */
import * as F from './feed';
import { formatInviteCode, inviteLink } from './invite';
import { nextUpdatedAt } from './merge';
import type {
  AddBottleInput,
  AddManualBreastInput,
  BottleFeed,
  BreastFeed,
  Entry,
  EntryBase,
  EntryPatch,
  Feed,
  Member,
  MemberEntry,
  Side,
  SyncState,
} from './types';

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (core phase 2)`);
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
}

export interface CoreOptions {
  /** Defaults to Date.now. Tests inject a fake clock. */
  clock?: () => number;
  deviceId?: string;
  /** App URL used for invite links. Default: location.origin + import.meta.env.BASE_URL. */
  appUrl?: string;
  /** Sync server base URL. Default: VITE_API_BASE_URL or http://localhost:8787. */
  apiBaseUrl?: string;
}

export function defaultApiBaseUrl(): string {
  return (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
}

export class FeedCore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private snap: CoreSnapshot;
  private clockOffsetMs = 0;
  private meId: string | null = null;
  readonly deviceId: string;
  readonly appUrl: string;
  readonly apiBaseUrl: string;
  private readonly clock: () => number;
  householdId: string | null = null;
  private secret: string | null = null;

  constructor(opts: CoreOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.deviceId = opts.deviceId ?? crypto.randomUUID();
    this.appUrl = opts.appUrl ?? (typeof location !== 'undefined' ? location.origin + import.meta.env.BASE_URL : 'http://localhost:5173/baby-feed/');
    this.apiBaseUrl = (opts.apiBaseUrl ?? defaultApiBaseUrl()).replace(/\/+$/, '');
    this.snap = this.buildSnapshot();
  }

  // ── clock ──
  /** Core clock: device clock + estimated server offset (SPEC §5). Use for all displays of elapsed time. */
  now(): number {
    return this.clock() + this.clockOffsetMs;
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
    const feeds = all.filter((e): e is Feed => e.kind !== 'member').sort((a, b) => F.feedStart(b) - F.feedStart(a));
    const members = all.filter((e): e is MemberEntry => e.kind === 'member').map((m) => ({ id: m.id, name: m.name }));
    const me = this.meId ? (members.find((m) => m.id === this.meId) ?? null) : null;
    return {
      feeds,
      members,
      me,
      householdId: this.householdId,
      secret: this.secret,
      sync: { state: 'idle', lastSyncedAt: null, pending: 0, error: null, clockOffsetMs: this.clockOffsetMs },
    };
  }

  get inviteCode(): string | null {
    return this.secret ? formatInviteCode(this.secret) : null;
  }
  get inviteLink(): string | null {
    return this.secret ? inviteLink(this.appUrl, this.secret) : null;
  }

  // ── writes ──
  private requireMe(): Member {
    const me = this.snap.me;
    if (!me) throw new Error('Set the device member first (useHousehold().setMe / createHousehold / joinHousehold)');
    return me;
  }

  private base(now: number): EntryBase {
    return { id: crypto.randomUUID(), householdId: this.householdId, createdAt: now, updatedAt: now, deleted: false, loggedBy: this.requireMe(), deviceId: this.deviceId };
  }

  /** Store a new local version (bumps updatedAt/deviceId). Phase 2: also persists + enqueues in the outbox. */
  private put<T extends Entry>(e: T, prev?: Entry): T {
    const v = { ...e, updatedAt: nextUpdatedAt(prev?.updatedAt, this.now()), deviceId: this.deviceId } as T;
    this.entries.set(v.id, v);
    this.emit();
    return v;
  }

  private active(): BreastFeed | null {
    return F.activeFeedView(this.snap.feeds, this.now()).feed;
  }

  private updateActive(op: (f: BreastFeed, at: number) => BreastFeed): BreastFeed | null {
    const cur = this.active();
    if (!cur) return null;
    const next = op(cur, this.now());
    return next === cur ? cur : this.put(next, cur);
  }

  async startBreast(side: Side, opts: { startedAt?: number } = {}): Promise<BreastFeed> {
    if (this.active()) throw new ActiveFeedExistsError();
    const now = this.now();
    return this.put({ ...this.base(now), ...F.startFields(side, opts.startedAt ?? now) });
  }
  async switchSide() {
    return this.updateActive(F.switchSide);
  }
  async pause() {
    return this.updateActive(F.pause);
  }
  async resume() {
    return this.updateActive(F.resume);
  }
  async end() {
    return this.updateActive(F.end);
  }
  /** Delete (tombstone) the active feed — "started by mistake". */
  async discardActive(): Promise<void> {
    const cur = this.active();
    if (cur) await this.deleteEntry(cur.id);
  }

  async addBottle(input: AddBottleInput): Promise<BottleFeed> {
    if (!F.validAmountOz(input.amountOz)) throw new Error('amountOz must be > 0 in 0.25 oz steps');
    const now = this.now();
    const e: BottleFeed = { ...this.base(now), kind: 'bottle', at: input.at ?? now, amountOz: input.amountOz };
    if (input.milk) e.milk = input.milk;
    if (input.note) e.note = input.note;
    return this.put(e);
  }

  async addManualBreast(input: AddManualBreastInput): Promise<BreastFeed> {
    const segments = input.segments ?? (input.side ? [{ side: input.side, startedAt: input.start, endedAt: input.end }] : null);
    if (!segments) throw new Error('addManualBreast needs segments or side');
    const e: BreastFeed = { ...this.base(this.now()), kind: 'breast', startedAt: input.start, endedAt: input.end, segments, pausedAt: null, status: 'ended' };
    if (input.note) e.note = input.note;
    const err = F.validateBreast(e);
    if (err) throw new Error(`Invalid breast feed: ${err}`);
    return this.put(e);
  }

  async editEntry(id: string, patch: EntryPatch): Promise<Feed> {
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
    const cur = this.entries.get(id);
    if (!cur || cur.deleted) return;
    this.put({ ...cur, deleted: true }, cur);
  }

  // ── household ──
  async setMe(name: string): Promise<Member> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('Name required');
    const now = this.now();
    const prev = this.meId ? this.entries.get(this.meId) : undefined;
    const id = this.meId ?? crypto.randomUUID();
    this.meId = id;
    const self: Member = { id, name: trimmed };
    const m: MemberEntry = prev?.kind === 'member'
      ? { ...prev, name: trimmed, loggedBy: self }
      : { id, householdId: this.householdId, createdAt: now, updatedAt: now, deleted: false, loggedBy: self, deviceId: this.deviceId, kind: 'member', name: trimmed };
    this.put(m, prev);
    return self;
  }
  async createHousehold(_myName: string): Promise<void> {
    throw new NotImplementedError('createHousehold');
  }
  async joinHousehold(_codeOrLink: string, _myName: string): Promise<void> {
    throw new NotImplementedError('joinHousehold');
  }
  async leave(): Promise<void> {
    this.householdId = null;
    this.secret = null;
    this.emit();
  }
  async syncNow(): Promise<void> {
    /* phase 2 */
  }
}

let singleton: FeedCore | null = null;
/** The app-wide core (created lazily). */
export function getCore(): FeedCore {
  return (singleton ??= new FeedCore());
}

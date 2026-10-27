/**
 * Baby Feed sync server — Cloudflare Worker + one Durable Object per household (SQLite storage).
 * Routing/validation/LWW live in app.ts + logic.ts (pure, unit-tested); this file is the Workers glue.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Entry, Member } from '../../src/core/types.ts';
import { sendPush, type VapidEnv } from './vapid.ts';
import { handleRequest } from './app.ts';
import { createRateLimiter } from './http.ts';
import { Household, householdApi, type BreastFeedLike, type HouseholdApi, type HouseholdMeta, type HouseholdStorage, type PushSub, type SyncResult } from './logic.ts';

export interface Env extends VapidEnv {
  HOUSEHOLDS: DurableObjectNamespace<HouseholdDO>;
  /** Comma-separated browser origins allowed (CORS). "*" = any. Requests without Origin are allowed. */
  ALLOWED_ORIGINS?: string;
}

const rateLimit = createRateLimiter();

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env, {
      rateLimit,
      households: (id) => env.HOUSEHOLDS.get(env.HOUSEHOLDS.idFromName(id)) as unknown as HouseholdApi,
    });
  },
} satisfies ExportedHandler<Env>;

class SqlHouseholdStorage implements HouseholdStorage {
  private sql: SqlStorage;
  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY, seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, device_id TEXT NOT NULL,
      kind TEXT NOT NULL, deleted INTEGER NOT NULL, json TEXT NOT NULL)`);
    sql.exec(`CREATE INDEX IF NOT EXISTS entries_seq ON entries(seq)`);
    // Additive tables for "Still feeding?" web-push reminders (entries are never touched).
    sql.exec(`CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, member_id TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS push_alerts (feed_id TEXT PRIMARY KEY, n INTEGER NOT NULL)`);
  }
  runningBreasts(): BreastFeedLike[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM entries WHERE kind = 'breast' AND deleted = 0 AND json_extract(json, '$.status') = 'running'`)
      .toArray()
      .map((r) => JSON.parse(r.json) as BreastFeedLike);
  }
  putSub(s: PushSub): void {
    this.sql.exec(
      `INSERT INTO push_subs (endpoint, p256dh, auth, member_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, member_id = excluded.member_id`,
      s.endpoint, s.p256dh, s.auth, s.memberId,
    );
  }
  delSub(endpoint: string): void {
    this.sql.exec(`DELETE FROM push_subs WHERE endpoint = ?`, endpoint);
  }
  subs(): PushSub[] {
    return this.sql
      .exec<{ endpoint: string; p256dh: string; auth: string; member_id: string }>(`SELECT endpoint, p256dh, auth, member_id FROM push_subs`)
      .toArray()
      .map((r) => ({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth, memberId: r.member_id }));
  }
  getAlertN(feedId: string): number {
    const rows = this.sql.exec<{ n: number }>(`SELECT n FROM push_alerts WHERE feed_id = ?`, feedId).toArray();
    return rows.length ? rows[0]!.n : 0;
  }
  setAlertN(feedId: string, n: number): void {
    this.sql.exec(`INSERT INTO push_alerts (feed_id, n) VALUES (?, ?) ON CONFLICT(feed_id) DO UPDATE SET n = excluded.n`, feedId, n);
  }
  getMeta(): HouseholdMeta | null {
    const rows = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'meta'`).toArray();
    return rows.length ? (JSON.parse(rows[0]!.v) as HouseholdMeta) : null;
  }
  setMeta(meta: HouseholdMeta): void {
    this.sql.exec(`INSERT INTO meta (k, v) VALUES ('meta', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, JSON.stringify(meta));
  }
  getVersion(id: string) {
    const rows = this.sql.exec<{ updated_at: number; device_id: string }>(`SELECT updated_at, device_id FROM entries WHERE id = ?`, id).toArray();
    return rows.length ? { updatedAt: rows[0]!.updated_at, deviceId: rows[0]!.device_id } : null;
  }
  put(e: Entry, seq: number): void {
    this.sql.exec(
      `INSERT INTO entries (id, seq, updated_at, device_id, kind, deleted, json) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, device_id = excluded.device_id,
       kind = excluded.kind, deleted = excluded.deleted, json = excluded.json`,
      e.id, seq, e.updatedAt, e.deviceId, e.kind, e.deleted ? 1 : 0, JSON.stringify(e),
    );
  }
  since(after: number, limit: number) {
    return this.sql
      .exec<{ seq: number; json: string }>(`SELECT seq, json FROM entries WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit)
      .toArray()
      .map((r) => ({ seq: r.seq, entry: JSON.parse(r.json) as Entry }));
  }
  members(): Member[] {
    return this.sql
      .exec<{ json: string }>(`SELECT json FROM entries WHERE kind = 'member' AND deleted = 0`)
      .toArray()
      .map((r) => {
        const m = JSON.parse(r.json) as { id: string; name: string };
        return { id: m.id, name: m.name };
      });
  }
}

/** One instance per household (name = householdId). RPC methods = HouseholdApi. */
export class HouseholdDO extends DurableObject<Env> implements HouseholdApi {
  private api: HouseholdApi;
  private household: Household;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.household = new Household(new SqlHouseholdStorage(ctx.storage.sql));
    this.api = householdApi(this.household, () => Date.now());
  }

  create(secretHash: string): Promise<boolean> {
    return this.api.create(secretHash);
  }
  join(secretHash: string): Promise<{ ok: true; members: Member[] } | { ok: false }> {
    return this.api.join(secretHash);
  }
  async sync(secretHash: string, householdId: string, body: unknown): Promise<SyncResult> {
    const r = await this.api.sync(secretHash, householdId, body);
    // A timer may have started / paused / resumed / ended: re-plan the next "Still feeding?" reminder.
    const changed = typeof body === 'object' && body !== null && Array.isArray((body as { changes?: unknown }).changes) && (body as { changes: unknown[] }).changes.length > 0;
    if (r.status === 200 && changed) await this.schedule();
    return r;
  }
  async pushSubscribe(secretHash: string, sub: unknown): Promise<boolean> {
    const ok = await this.api.pushSubscribe(secretHash, sub);
    if (ok) await this.schedule();
    return ok;
  }
  async pushUnsubscribe(secretHash: string, endpoint: string): Promise<boolean> {
    const ok = await this.api.pushUnsubscribe(secretHash, endpoint);
    if (ok) await this.schedule();
    return ok;
  }

  private async schedule(): Promise<void> {
    const at = this.household.nextAlertAt(Date.now());
    if (at === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 1000));
  }

  /** Alarm: send due "Still feeding?" reminders, then arm the next one. */
  async alarm(): Promise<void> {
    const next = await this.household.runAlerts(Date.now(), (sub) => sendPush(sub, this.env));
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}

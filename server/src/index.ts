/**
 * Baby Feed sync server — Cloudflare Worker + one Durable Object per household (SQLite storage).
 * Routing/validation/LWW live in app.ts + logic.ts (pure, unit-tested); this file is the Workers glue.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Entry, Member } from '../../src/core/types.ts';
import { handleRequest } from './app.ts';
import { createRateLimiter } from './http.ts';
import { Household, householdApi, type HouseholdApi, type HouseholdMeta, type HouseholdStorage, type SyncResult } from './logic.ts';

export interface Env {
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.api = householdApi(new Household(new SqlHouseholdStorage(ctx.storage.sql)), () => Date.now());
  }

  create(secretHash: string): Promise<boolean> {
    return this.api.create(secretHash);
  }
  join(secretHash: string): Promise<{ ok: true; members: Member[] } | { ok: false }> {
    return this.api.join(secretHash);
  }
  sync(secretHash: string, householdId: string, body: unknown): Promise<SyncResult> {
    return this.api.sync(secretHash, householdId, body);
  }
}

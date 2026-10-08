/**
 * DEV-ONLY DEMO HARNESS — runs the UI on the real core with an in-browser sync server instead of the Worker,
 * plus seeded history and a simulated second phone. Loaded by src/main.tsx only when import.meta.env.DEV and
 * ?demo is in the URL (dynamic import, so it is tree-shaken out of `vite build`). Also used by UI tests.
 *
 *   - Server: Dealer's pure router + Household logic (server/src) over localStorage, so it survives reloads and two
 *     tabs share it (open a second tab with ?demo&phone=2 to act as the other parent).
 *   - Seed: after the household is created, the "other phone" joins and ~30 days of feeds from both parents are
 *     imported through core.importEntries (they sync like any entry). Baby defaults to Josephine.
 *   - ?demo=remote — the other parent starts a breast feed on their phone; it reaches this phone via /api/sync.
 *   - ?demo=fresh  — no seeded history.   ?demo=reset — wipe the demo database + server first.
 */
import { FeedCore, type BreastFeed, type Entry, type Feed, type Member, type Side } from '../core';
import { handleRequest, type AppDeps } from '../../server/src/app.ts';
import { Household, householdApi, type HouseholdMeta, type HouseholdStorage } from '../../server/src/logic.ts';

import { DEMO_BABY, clearLegacyBabyName } from './prefs';

const MIN = 60_000;
export const DEMO_API = 'https://demo-sync.invalid';
const SRV_KEY = (id: string) => `bf.demo.srv.${id}`;
const SEEDED_KEY = (id: string) => `bf.demo.seeded.${id}`;

const params = () => new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
const phone = () => params().get('phone') ?? '1';
const dbName = () => `baby-feed-demo-${phone()}`;
const mirrorKey = () => `baby-feed-demo-${phone()}:mirror`;

/* ---------- in-browser sync server (localStorage-backed) ---------- */
class LocalHouseholdStorage implements HouseholdStorage {
  private meta: HouseholdMeta | null;
  private rows: Record<string, { seq: number; json: string }>;
  private dirty = false;
  private readonly key: string;
  private readonly kv: Storage | null;
  constructor(key: string, kv: Storage | null) {
    this.key = key;
    this.kv = kv;
    const raw = kv?.getItem(key);
    const v = raw ? (JSON.parse(raw) as { meta: HouseholdMeta | null; rows: Record<string, { seq: number; json: string }> }) : null;
    this.meta = v?.meta ?? null;
    this.rows = v?.rows ?? {};
  }
  getMeta() { return this.meta ? { ...this.meta } : null; }
  setMeta(m: HouseholdMeta) { this.meta = { ...m }; this.dirty = true; }
  getVersion(id: string) {
    const r = this.rows[id];
    if (!r) return null;
    const e = JSON.parse(r.json) as Entry;
    return { updatedAt: e.updatedAt, deviceId: e.deviceId };
  }
  put(entry: Entry, seq: number) { this.rows[entry.id] = { seq, json: JSON.stringify(entry) }; this.dirty = true; }
  since(after: number, limit: number) {
    return Object.values(this.rows).filter((r) => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map((r) => ({ seq: r.seq, entry: JSON.parse(r.json) as Entry }));
  }
  members() {
    return Object.values(this.rows).map((r) => JSON.parse(r.json) as Entry).filter((e) => e.kind === 'member' && !e.deleted).map((e) => ({ id: e.id, name: (e as { name: string }).name }));
  }
  flush() { if (this.dirty) { try { this.kv?.setItem(this.key, JSON.stringify({ meta: this.meta, rows: this.rows })); } catch { /* quota */ } this.dirty = false; } }
}

/** fetch() for FeedCore that hits Dealer's router in-process. State is re-read from storage per request (multi-tab safe). */
export function createDemoServer(kv: Storage | null = typeof localStorage === 'undefined' ? null : localStorage) {
  const memory = new Map<string, LocalHouseholdStorage>();
  let touched: LocalHouseholdStorage[] = [];
  const deps: AppDeps = {
    rateLimit: () => true,
    households(id) {
      const store = kv ? new LocalHouseholdStorage(SRV_KEY(id), kv) : (memory.get(id) ?? memory.set(id, new LocalHouseholdStorage(SRV_KEY(id), null)).get(id)!);
      touched.push(store);
      return householdApi(new Household(store), Date.now);
    },
  };
  let down = false;
  return {
    setDown(v: boolean) { down = v; },
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      if (down) throw new TypeError('Failed to fetch');
      touched = [];
      const res = await handleRequest(new Request(input, init), { ALLOWED_ORIGINS: '*' }, deps);
      touched.forEach((s) => s.flush());
      return res;
    },
  };
}

/* ---------- seed data ---------- */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const uuid = () => crypto.randomUUID();

/**
 * ~30 days of realistic newborn feeds ending recently: breast feeds every ~2–3 h (longer at night), mostly
 * alternating sides, ~70% two-sided; evening bottles (2–4.5 oz). `nurser` logs most breast feeds; `helper`
 * most bottles and some night feeds. Deterministic for a given seed.
 */
export function seedFeeds(now: number, nurser: Member, helper: Member, deviceId = 'demo-seed', seed = 42): Feed[] {
  const r = mulberry32(seed);
  const between = (a: number, b: number) => a + r() * (b - a);
  const d0 = new Date(now); d0.setHours(0, 0, 0, 0); d0.setDate(d0.getDate() - 29);
  let t = d0.getTime() + 50 * MIN;
  const stop = now - 100 * MIN;
  let lastSide = 'R' as Side;
  const out: Feed[] = [];
  const base = (at: number, by: Member, upd: number) => ({ id: uuid(), householdId: null, createdAt: at, updatedAt: upd, deleted: false, deviceId, loggedBy: { id: by.id, name: by.name } });
  const breast = (s: number, first: Side, a: number, b: number, by: Member): BreastFeed => {
    const segs: BreastFeed['segments'] = [{ side: first, startedAt: s, endedAt: s + a }];
    let end = s + a;
    if (b > 0) { const s2 = end + Math.round(between(0.5, 2) * MIN); segs.push({ side: first === 'L' ? 'R' : 'L', startedAt: s2, endedAt: s2 + b }); end = s2 + b; }
    lastSide = segs[segs.length - 1]!.side;
    return { ...base(s, by, end), kind: 'breast', startedAt: s, endedAt: end, segments: segs, pausedAt: null, status: 'ended' };
  };
  while (t < stop) {
    const h = new Date(t).getHours();
    if (r() < (h >= 18 && h < 22 ? 0.4 : 0.12)) {
      out.push({ ...base(t, r() < 0.7 ? helper : nurser, t + 2 * MIN), kind: 'bottle', at: t, amountOz: Math.round(between(2, 4.5) * 4) / 4, milk: r() < 0.7 ? 'breast' : 'formula' });
      t += between(2.2, 3.2) * 60 * MIN;
    } else {
      const first: Side = r() < 0.85 ? (lastSide === 'L' ? 'R' : 'L') : lastSide;
      const by = r() < (h < 6 || h >= 23 ? 0.6 : 0.85) ? nurser : helper;
      out.push(breast(t, first, Math.round(between(8, 16) * MIN), r() < 0.7 ? Math.round(between(5, 12) * MIN) : 0, by));
      t += (h < 6 ? between(2.4, 3.8) : between(1.6, 3.2)) * 60 * MIN;
    }
  }
  const last = out[out.length - 1];
  if (!last || now - (last.kind === 'breast' ? last.startedAt : last.at) > 150 * MIN) {
    out.push(breast(now - 95 * MIN, lastSide === 'L' ? 'R' : 'L', 11 * MIN, 7 * MIN, nurser));
  }
  return out;
}

/* ---------- the other parent's phone ---------- */
export const otherName = (me: Member | null) => (me?.name.toLowerCase() === 'karyn' ? 'Samir' : 'Karyn');

/** A second FeedCore (memory storage) that joins this household through the same server. */
export async function joinOtherPhone(core: FeedCore, server: ReturnType<typeof createDemoServer>): Promise<FeedCore> {
  const s = core.getSnapshot();
  if (!s.secret) throw new Error('No household yet');
  const other = new FeedCore({ storage: 'memory', mirror: false, autoSync: false, fetch: server.fetch, apiBaseUrl: DEMO_API, deviceId: `demo-other-phone-${phone()}` });
  await other.ready;
  await other.joinHousehold(s.secret, otherName(s.me));
  return other;
}

/** Seed once per household (unless ?demo=fresh): the other phone joins, then history is imported. */
export async function seedHousehold(core: FeedCore, server: ReturnType<typeof createDemoServer>, now = Date.now()): Promise<void> {
  const s = core.getSnapshot();
  if (!s.householdId || !s.me) return;
  const kv = typeof localStorage === 'undefined' ? null : localStorage;
  if (kv?.getItem(SEEDED_KEY(s.householdId))) return;
  kv?.setItem(SEEDED_KEY(s.householdId), '1');
  const other = await joinOtherPhone(core, server);
  const otherMe = other.getSnapshot().me!;
  const meIsKaryn = s.me.name.toLowerCase() === 'karyn';
  const [nurser, helper] = meIsKaryn ? [s.me, otherMe] : [otherMe, s.me];
  await core.importEntries(seedFeeds(now, nurser, helper));
  other.dispose();
  await core.syncNow();
}

/** The other parent starts a feed on their phone (L for 4.5 min, now on R for 2.5 min); this phone pulls it. */
export async function simulateRemoteFeed(core: FeedCore, server: ReturnType<typeof createDemoServer>, now = Date.now()): Promise<void> {
  await core.syncNow().catch(() => {});
  if (core.getSnapshot().feeds.some((f) => f.kind === 'breast' && f.status !== 'ended')) return;
  const other = await joinOtherPhone(core, server);
  const by = other.getSnapshot().me!;
  const s = now - 7 * MIN;
  const sw = now - 2.5 * MIN;
  const feed: BreastFeed = {
    id: uuid(), householdId: other.householdId, createdAt: s, updatedAt: sw, deleted: false, deviceId: other.deviceId, loggedBy: by,
    kind: 'breast', startedAt: s, endedAt: null, pausedAt: null, status: 'running',
    segments: [{ side: 'L', startedAt: s, endedAt: sw }, { side: 'R', startedAt: sw, endedAt: null }],
  };
  await other.importEntries([feed]);
  await other.syncNow();
  other.dispose();
  await core.syncNow();
}

async function deleteDb(name: string) {
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}

/** Boot the staging core: real FeedCore + demo server + seed + optional remote feed. */
export async function bootDemoCore(): Promise<FeedCore> {
  const demo = params().getAll('demo');
  if (demo.includes('reset')) {
    await deleteDb(dbName());
    for (const k of Object.keys(localStorage)) if (k.startsWith('bf.demo.') || k.startsWith('baby-feed-demo')) localStorage.removeItem(k);
    clearLegacyBabyName();
  }
  const server = createDemoServer();
  const core = new FeedCore({ fetch: server.fetch, apiBaseUrl: DEMO_API, dbName: dbName(), mirrorKey: mirrorKey() });
  await core.ready;
  // Demo default baby (only when this device hasn't named one); core keeps it and uploads it on create.
  if (!demo.includes('fresh') && !core.getSnapshot().babyName) await core.setBabyName(DEMO_BABY.name);
  let busy = false;
  const onChange = async () => {
    if (busy || !core.householdId || !core.getSnapshot().me) return;
    busy = true;
    try {
      if (!demo.includes('fresh')) await seedHousehold(core, server);
      if (demo.includes('remote')) await simulateRemoteFeed(core, server);
    } catch (e) { console.warn('[demo]', e); }
    // keep `busy` true: seeding/remote run once per page load
  };
  core.subscribe(() => void onChange());
  void onChange();
  return core;
}

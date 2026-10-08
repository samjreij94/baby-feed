/**
 * Router (pure Fetch API — runs in the Worker, in Node tests and as the in-process fake server).
 *   POST /api/households        -> { householdId, secret }                 (rate limited: create)
 *   POST /api/households/join   Bearer secret -> { householdId, members }  (rate limited: join; 401 unknown)
 *   POST /api/sync              Bearer secret, SyncRequest -> SyncResponse (401 bad secret)
 *   GET  /health                -> "ok"
 */
import { generateInviteCode, isValidInviteCode, normalizeInviteCode } from '../../src/core/invite.ts';
import { clientIp, corsHeaders, createRateLimiter, json, originAllowed, tooMany, type HttpEnv, type RateLimiter } from './http.ts';
import { Household, householdApi, householdIdFromHash, LIMITS, MemoryHouseholdStorage, sha256Hex, type HouseholdApi } from './logic.ts';

export interface AppDeps {
  households(householdId: string): HouseholdApi;
  rateLimit: RateLimiter;
}

function bearer(req: Request): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  return m ? m[1]!.trim() : null;
}

async function readBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413 }> {
  const len = Number(req.headers.get('Content-Length') ?? '0');
  if (len > LIMITS.maxBodyBytes) return { ok: false, status: 413 };
  const text = await req.text();
  if (text.length > LIMITS.maxBodyBytes) return { ok: false, status: 413 };
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400 };
  }
}

async function resolveSecret(raw: string | null) {
  const secret = raw ? normalizeInviteCode(raw) : '';
  if (!isValidInviteCode(secret)) return null;
  const hash = await sha256Hex(secret);
  return { secret, hash, householdId: householdIdFromHash(hash) };
}

export async function handleRequest(req: Request, env: HttpEnv, deps: AppDeps): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req, env) });
  if (path === '/health' || path === '/') return new Response('ok', { headers: corsHeaders(req, env) });
  if (!originAllowed(req, env)) return json(req, env, { error: 'Origin not allowed' }, 403);
  if (req.method !== 'POST') return json(req, env, { error: 'Not found' }, 404);

  if (path === '/api/households') {
    if (!deps.rateLimit('create', clientIp(req))) return tooMany(req, env);
    for (let i = 0; i < 4; i++) {
      const secret = generateInviteCode();
      const hash = await sha256Hex(secret);
      const householdId = householdIdFromHash(hash);
      if (await deps.households(householdId).create(hash)) return json(req, env, { householdId, secret });
    }
    return json(req, env, { error: 'Could not create household' }, 503);
  }

  if (path === '/api/households/join') {
    if (!deps.rateLimit('join', clientIp(req))) return tooMany(req, env);
    let raw = bearer(req);
    if (!raw) {
      const body = await readBody(req);
      if (body.ok && typeof (body.value as { secret?: unknown }).secret === 'string') raw = (body.value as { secret: string }).secret;
    }
    const s = await resolveSecret(raw);
    if (!s) return json(req, env, { error: 'Invalid household code' }, 401);
    const r = await deps.households(s.householdId).join(s.hash);
    if (!r.ok) return json(req, env, { error: 'Invalid household code' }, 401);
    return json(req, env, { householdId: s.householdId, members: r.members });
  }

  if (path === '/api/sync') {
    if (!deps.rateLimit('sync', clientIp(req))) return tooMany(req, env);
    const s = await resolveSecret(bearer(req));
    if (!s) return json(req, env, { error: 'Invalid household code' }, 401);
    const body = await readBody(req);
    if (!body.ok) return json(req, env, { error: body.status === 413 ? 'Payload too large' : 'Bad JSON' }, body.status);
    const r = await deps.households(s.householdId).sync(s.hash, s.householdId, body.value);
    return json(req, env, r.body, r.status);
  }

  return json(req, env, { error: 'Not found' }, 404);
}

/** In-process server (memory storage) for tests and local mocks: same router + same Household logic. */
export function createMemoryServer(opts: { now?: () => number; env?: HttpEnv; pageSize?: number; rateLimit?: RateLimiter } = {}) {
  const now = opts.now ?? Date.now;
  const stores = new Map<string, { store: MemoryHouseholdStorage; api: HouseholdApi }>();
  const deps: AppDeps = {
    rateLimit: opts.rateLimit ?? createRateLimiter(),
    households(id) {
      let h = stores.get(id);
      if (!h) {
        const store = new MemoryHouseholdStorage();
        h = { store, api: householdApi(new Household(store, opts.pageSize), now) };
        stores.set(id, h);
      }
      return h.api;
    },
  };
  const env = opts.env ?? { ALLOWED_ORIGINS: '*' };
  let down = false;
  return {
    stores,
    /** Simulate the network being unreachable (fetch rejects). */
    setDown(v: boolean) {
      down = v;
    },
    handle: (req: Request) => handleRequest(req, env, deps),
    /** A fetch implementation hitting this server. */
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (down) throw new TypeError('Failed to fetch');
      // In-process: no network to abort. Drop the signal — under jsdom it's jsdom's AbortSignal, which Node's
      // (undici) Request constructor rejects on Node 20. An already-aborted signal still fails like fetch would.
      const { signal, ...rest } = init ?? {};
      if (signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      return handleRequest(new Request(input, rest), env, deps);
    }) as typeof fetch,
  };
}

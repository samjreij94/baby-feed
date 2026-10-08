import { describe, expect, it } from 'vitest';
import { createMemoryServer } from '../src/app.ts';
import { createRateLimiter, RATE_LIMITS } from '../src/http.ts';
import type { BottleFeed } from '../../src/core/types.ts';

const ORIGINS = 'https://samjreij94.github.io,http://localhost:5173';
const B = 'http://worker.test';
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(B + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

function srv() {
  return createMemoryServer({ env: { ALLOWED_ORIGINS: ORIGINS } });
}

async function create(s: ReturnType<typeof srv>, ip = '1.1.1.1') {
  const r = await s.handle(post('/api/households', {}, { 'CF-Connecting-IP': ip }));
  expect(r.status).toBe(200);
  return (await r.json()) as { householdId: string; secret: string };
}

describe('router', () => {
  it('health, preflight, CORS allow-list, unknown origin 403', async () => {
    const s = srv();
    expect(await (await s.handle(new Request(B + '/health'))).text()).toBe('ok');
    const pre = await s.handle(new Request(B + '/api/sync', { method: 'OPTIONS', headers: { Origin: 'https://samjreij94.github.io' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('https://samjreij94.github.io');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toMatch(/Authorization/);
    const bad = await s.handle(post('/api/households', {}, { Origin: 'https://evil.example' }));
    expect(bad.status).toBe(403);
    expect((await s.handle(new Request(B + '/api/nope', { method: 'POST' }))).status).toBe(404);
  });

  it('create → join (Bearer or body) → members; secret hashed in storage', async () => {
    const s = srv();
    const { householdId, secret } = await create(s);
    expect(secret).toMatch(/^[0-9A-Z]{32}$/);
    expect(householdId).toMatch(/^[0-9a-f]{32}$/);
    const meta = s.stores.get(householdId)!.store.getMeta()!;
    expect(meta.secretHash).not.toContain(secret);
    expect(meta.secretHash).toHaveLength(64);

    const grouped = secret.match(/.{4}/g)!.join('-').toLowerCase();
    const j = await s.handle(post('/api/households/join', {}, { Authorization: `Bearer ${grouped}` }));
    expect(j.status).toBe(200);
    expect(await j.json()).toEqual({ householdId, members: [] });
    const j2 = await s.handle(post('/api/households/join', { secret }));
    expect(j2.status).toBe(200);
  });

  it('auth failures are 401', async () => {
    const s = srv();
    const { secret } = await create(s);
    const wrong = (secret[0] === 'A' ? 'B' : 'A') + secret.slice(1);
    expect((await s.handle(post('/api/households/join', {}, { Authorization: `Bearer ${wrong}` }))).status).toBe(401);
    expect((await s.handle(post('/api/households/join', {}, { Authorization: 'Bearer short' }))).status).toBe(401);
    expect((await s.handle(post('/api/households/join', {}))).status).toBe(401);
    expect((await s.handle(post('/api/sync', { since: null, changes: [] }, { Authorization: `Bearer ${wrong}` }))).status).toBe(401);
    expect((await s.handle(post('/api/sync', { since: null, changes: [] }))).status).toBe(401);
  });

  it('sync round trip + householdId mismatch rejected + payload caps', async () => {
    const s = srv();
    const { householdId, secret } = await create(s);
    const auth = { Authorization: `Bearer ${secret}` };
    const now = Date.now();
    const e: BottleFeed = {
      id: '11111111-1111-4111-8111-111111111111', householdId, createdAt: now, updatedAt: now, deleted: false,
      loggedBy: { id: 'm1', name: 'Samir' }, deviceId: 'dev-a', kind: 'bottle', at: now, amountOz: 2.5,
    };
    const r = await s.handle(post('/api/sync', { since: null, changes: [e, { ...e, id: '22222222-2222-4222-8222-222222222222', householdId: 'f'.repeat(32) }], deviceId: 'dev-a' }, auth));
    expect(r.status).toBe(200);
    const body = (await r.json()) as { changes: unknown[]; cursor: string; rejected: Array<{ reason: string }>; serverNow: number };
    expect(body.changes).toEqual([e]);
    expect(body.cursor).toBe('1');
    expect(body.rejected[0]!.reason).toBe('householdId mismatch');
    expect(Math.abs(body.serverNow - Date.now())).toBeLessThan(5000);

    expect((await s.handle(post('/api/sync', '{bad json', auth))).status).toBe(400);
    expect((await s.handle(post('/api/sync', { since: null, changes: [], pad: 'x'.repeat(300 * 1024) }, auth))).status).toBe(413);
  });

  it('per-IP rate limits on create and join → 429 with Retry-After', async () => {
    const s = srv();
    for (let i = 0; i < RATE_LIMITS.create; i++) await create(s, '9.9.9.9');
    const r = await s.handle(post('/api/households', {}, { 'CF-Connecting-IP': '9.9.9.9' }));
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('60');
    await create(s, '8.8.8.8'); // other IP fine

    let last = 0;
    for (let i = 0; i <= RATE_LIMITS.join; i++) {
      last = (await s.handle(post('/api/households/join', {}, { 'CF-Connecting-IP': '7.7.7.7', Authorization: 'Bearer x' }))).status;
    }
    expect(last).toBe(429);
  });

  it('rate limiter window resets', () => {
    const rl = createRateLimiter({ create: 1, join: 1, sync: 1 });
    expect(rl('create', 'ip', 0)).toBe(true);
    expect(rl('create', 'ip', 1)).toBe(false);
    expect(rl('create', 'ip', 60_001)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { createMemoryServer } from '../src/app.ts';
import { ALERT_EVERY_MS, Household, isPushEndpoint, MAX_ALERTS, MemoryHouseholdStorage, nursingMs, type PushSub } from '../src/logic.ts';
import { fromB64u, sendPush, vapidAuthHeader } from '../src/vapid.ts';

const MIN = 60_000;
const sub = (memberId = 'm1', n = 1): PushSub => ({ endpoint: `https://web.push.apple.com/abc${n}`, p256dh: 'p', auth: 'a', memberId });
const T0 = 1_800_000_000_000;

function feed(id: string, startedAt: number, opts: { status?: string; by?: string; segments?: Array<{ startedAt: number; endedAt: number | null }> } = {}) {
  return {
    id, kind: 'breast', householdId: 'h', createdAt: startedAt, updatedAt: startedAt, deleted: false, deviceId: 'dev-1234',
    loggedBy: { id: opts.by ?? 'm1', name: 'Mom' }, startedAt, endedAt: null, pausedAt: null,
    status: opts.status ?? 'running', segments: opts.segments ?? [{ side: 'L', startedAt, endedAt: null }],
  };
}

function setup() {
  const store = new MemoryHouseholdStorage();
  const h = new Household(store);
  h.init('hash', T0);
  return { store, h };
}
const put = (store: MemoryHouseholdStorage, e: ReturnType<typeof feed>, seq = 1) => store.put(e as never, seq);

describe('still-feeding reminders', () => {
  it('nursingMs sums segments, open one up to now, pauses excluded', () => {
    expect(nursingMs({ id: 'x', status: 'running', loggedBy: { id: 'm' }, segments: [{ startedAt: 0, endedAt: 5 * MIN }, { startedAt: 10 * MIN, endedAt: null }] }, 12 * MIN)).toBe(7 * MIN);
  });

  it('no subscriptions -> no alarm', () => {
    const { store, h } = setup();
    put(store, feed('feed-0001', T0));
    expect(h.nextAlertAt(T0 + MIN)).toBeNull();
  });

  it('schedules at 15 min of nursing, then every 15 min; nothing to send before', async () => {
    const { store, h } = setup();
    h.addSub(sub());
    put(store, feed('feed-0001', T0));
    expect(h.nextAlertAt(T0 + 2 * MIN)).toBe(T0 + 15 * MIN);
    const sent: string[] = [];
    const send = async (s: PushSub) => (sent.push(s.endpoint), 'ok' as const);
    expect(await h.runAlerts(T0 + 14 * MIN, send)).toBe(T0 + 15 * MIN);
    expect(sent).toHaveLength(0);
    expect(await h.runAlerts(T0 + 15 * MIN + 500, send)).toBe(T0 + 30 * MIN);
    expect(sent).toHaveLength(1);
    // alarm re-fire before the next threshold doesn't double send
    await h.runAlerts(T0 + 16 * MIN, send);
    expect(sent).toHaveLength(1);
    expect(await h.runAlerts(T0 + 30 * MIN, send)).toBe(T0 + 45 * MIN);
    expect(sent).toHaveLength(2);
  });

  it('a backdated / edited start moves the reminder (alarm follows the adjusted start)', () => {
    const { store, h } = setup();
    h.addSub(sub());
    put(store, feed('feed-0001', T0));
    expect(h.nextAlertAt(T0 + 2 * MIN)).toBe(T0 + 15 * MIN);
    // forgot to start the timer: edited to have begun 10 min earlier
    put(store, feed('feed-0001', T0 - 10 * MIN), 2);
    expect(h.nextAlertAt(T0 + 2 * MIN)).toBe(T0 + 5 * MIN);
  });

  it('paused / ended / deleted feeds never alert; pause shifts the schedule', () => {
    const { store, h } = setup();
    h.addSub(sub());
    put(store, feed('feed-0001', T0, { status: 'paused', segments: [{ startedAt: T0, endedAt: T0 + 5 * MIN }] }));
    expect(h.nextAlertAt(T0 + 60 * MIN)).toBeNull();
    // resumed at +20: 5 min already nursed -> 10 more
    put(store, feed('feed-0001', T0, { segments: [{ startedAt: T0, endedAt: T0 + 5 * MIN }, { startedAt: T0 + 20 * MIN, endedAt: null }] }), 2);
    expect(h.nextAlertAt(T0 + 20 * MIN)).toBe(T0 + 30 * MIN);
  });

  it('goes to the phone of whoever started the feed (falls back to all); drops dead subscriptions', async () => {
    const { store, h } = setup();
    h.addSub(sub('m1', 1));
    h.addSub(sub('m2', 2));
    put(store, feed('feed-0001', T0, { by: 'm2' }));
    const sent: string[] = [];
    await h.runAlerts(T0 + 15 * MIN, async (s) => (sent.push(s.endpoint), 'gone'));
    expect(sent).toEqual(['https://web.push.apple.com/abc2']);
    expect(store.subs().map((s) => s.endpoint)).toEqual(['https://web.push.apple.com/abc1']);
    put(store, feed('feed-0001', T0, { by: 'm2', status: 'ended' }), 2);
    put(store, feed('feed-0002', T0 + 100 * MIN, { by: 'nobody' }), 3);
    sent.length = 0;
    await h.runAlerts(T0 + 115 * MIN, async (s) => (sent.push(s.endpoint), 'ok'));
    expect(sent).toEqual(['https://web.push.apple.com/abc1']);
  });

  it('caps reminders and does not start buzzing for a long-forgotten timer', async () => {
    const { store, h } = setup();
    h.addSub(sub());
    put(store, feed('feed-0001', T0));
    let n = 0;
    const send = async () => (n++, 'ok' as const);
    await h.runAlerts(T0 + 10 * 60 * MIN, send); // 10 h in, first look
    expect(n).toBe(0);
    expect(h.nextAlertAt(T0 + 10 * 60 * MIN)).toBeNull();
    const s2 = setup();
    s2.h.addSub(sub());
    put(s2.store, feed('feed-0001', T0));
    for (let i = 1; i <= MAX_ALERTS + 3; i++) await s2.h.runAlerts(T0 + i * ALERT_EVERY_MS, async () => (n++, 'ok'));
    expect(n).toBe(MAX_ALERTS);
  });

  it('only accepts real push-service endpoints', () => {
    expect(isPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/x')).toBe(true);
    expect(isPushEndpoint('http://web.push.apple.com/x')).toBe(false);
    expect(isPushEndpoint('https://evil.example/x')).toBe(false);
    expect(isPushEndpoint('https://web.push.apple.com.evil.example/x')).toBe(false);
  });
});

describe('VAPID', () => {
  it('signs a verifiable ES256 JWT and sends an empty authorized push', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey('jwk', kp.privateKey)) as JsonWebKey;
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
    const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const env = { VAPID_PUBLIC: b64(raw), VAPID_PRIVATE: jwk.d! };
    const hdr = await vapidAuthHeader('https://web.push.apple.com/abc', env, T0);
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=(.+)$/.exec(hdr)!;
    expect(m[4]).toBe(env.VAPID_PUBLIC);
    expect(JSON.parse(atob(m[2]!.replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ aud: 'https://web.push.apple.com' });
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, kp.publicKey, fromB64u(m[3]!), new TextEncoder().encode(`${m[1]}.${m[2]}`));
    expect(ok).toBe(true);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const mk = (status: number) => async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(null, { status }));
    expect(await sendPush(sub(), env, mk(201))).toBe('ok');
    expect(await sendPush(sub(), env, mk(410))).toBe('gone');
    expect(await sendPush(sub(), env, mk(500))).toBe('fail');
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toMatch(/^vapid t=/);
    expect(await sendPush(sub(), {}, mk(201))).toBe('fail'); // not configured
  });
});

describe('push routes', () => {
  it('key / subscribe / unsubscribe need the household code and validate input', async () => {
    const s = createMemoryServer({ env: { ALLOWED_ORIGINS: '*', VAPID_PUBLIC: 'PUBKEY' } });
    const post = (path: string, body: unknown, secret?: string) =>
      s.handle(new Request('http://w.test' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) }));
    const { secret } = (await (await post('/api/households', {})).json()) as { secret: string };
    expect((await post('/api/push/key', {})).status).toBe(401);
    expect(await (await post('/api/push/key', {}, secret)).json()).toEqual({ publicKey: 'PUBKEY' });
    const good = { endpoint: 'https://web.push.apple.com/zzz', p256dh: 'p', auth: 'a', memberId: 'm1' };
    expect((await post('/api/push/subscribe', good)).status).toBe(401);
    expect((await post('/api/push/subscribe', { ...good, endpoint: 'https://evil.example/x' }, secret)).status).toBe(400);
    expect((await post('/api/push/subscribe', good, secret)).status).toBe(200);
    expect((await post('/api/push/unsubscribe', { endpoint: good.endpoint }, secret)).status).toBe(200);
  });
});

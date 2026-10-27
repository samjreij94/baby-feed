/**
 * Minimal Web Push sender (RFC 8030 + VAPID RFC 8292), payload-less: the service worker shows a fixed
 * "Still feeding?" notification on every push, so nothing needs encrypting. WebCrypto only (Workers / Node).
 */
import type { PushSub } from './logic.ts';

export interface VapidEnv {
  /** Uncompressed P-256 public key, base64url (65 bytes). */
  VAPID_PUBLIC?: string;
  /** P-256 private scalar d, base64url (32 bytes). Worker secret. */
  VAPID_PRIVATE?: string;
}

const b64u = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const fromB64u = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const utf8 = (s: string) => new TextEncoder().encode(s);

async function importKey(env: Required<VapidEnv>): Promise<CryptoKey> {
  const pub = fromB64u(env.VAPID_PUBLIC);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC must be an uncompressed P-256 point');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), d: env.VAPID_PRIVATE, ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** `Authorization` header value for a push to `endpoint`'s origin. */
export async function vapidAuthHeader(endpoint: string, env: VapidEnv, now = Date.now()): Promise<string> {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) throw new Error('VAPID keys not configured');
  const key = await importKey(env as Required<VapidEnv>);
  const aud = new URL(endpoint).origin;
  const head = b64u(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(utf8(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://samjreij94.github.io/baby-feed/' })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(`${head}.${body}`)));
  return `vapid t=${head}.${body}.${b64u(sig)}, k=${env.VAPID_PUBLIC}`;
}

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Sends one empty push. 404/410 = the subscription is gone (user removed the app / revoked permission). */
export async function sendPush(sub: PushSub, env: VapidEnv, fetchImpl: PushFetch = fetch): Promise<'ok' | 'gone' | 'fail'> {
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: { Authorization: await vapidAuthHeader(sub.endpoint, env), TTL: '600', Urgency: 'high', 'Content-Length': '0' },
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

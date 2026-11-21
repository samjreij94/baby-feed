/**
 * Minimal Web Push sender (RFC 8030 + VAPID RFC 8292). Payload-less pushes stay supported (the SW shows
 * "Still feeding?"). Optional JSON payloads are encrypted with aes128gcm (RFC 8291 / 8188) so the SW can
 * distinguish sleep check-ins. WebCrypto only (Workers / Node).
 */
import type { PushPayload, PushSub } from './logic.ts';

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

const concat = (...parts: Array<Uint8Array | number[]>): Uint8Array => {
  const chunks = parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
};

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(salt.length ? salt : new Uint8Array(32), ikm);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, len: number): Promise<Uint8Array> {
  const t = await hmacSha256(prk, concat(info, [1]));
  return t.slice(0, len);
}

/** RFC 8291 / 8188: encrypt `plaintext` for `sub.p256dh` + `sub.auth`. */
export async function encryptWebPush(sub: PushSub, plaintext: Uint8Array): Promise<Uint8Array> {
  const uaPub = fromB64u(sub.p256dh);
  const auth = fromB64u(sub.auth);
  if (uaPub.length !== 65 || uaPub[0] !== 4 || auth.length < 16) throw new Error('bad subscription keys');
  const as = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as never, as.privateKey, 256));
  const ikm = await hkdfExpand(
    await hkdfExtract(auth, secret),
    concat(utf8('WebPush: info'), [0], uaPub, asPub),
    32,
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, concat(utf8('Content-Encoding: aes128gcm'), [0]), 16);
  const nonce = await hkdfExpand(prk, concat(utf8('Content-Encoding: nonce'), [0]), 12);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, [2])));
  const header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPub, 21);
  return concat(header, ciphertext);
}

export async function decryptWebPushWithUa(uaPrivate: CryptoKey, uaPub: Uint8Array, auth: Uint8Array, body: Uint8Array): Promise<Uint8Array> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPub = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asPubKey = await crypto.subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asPubKey } as never, uaPrivate, 256));
  const ikm = await hkdfExpand(await hkdfExtract(auth, secret), concat(utf8('WebPush: info'), [0], uaPub, asPub), 32);
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, concat(utf8('Content-Encoding: aes128gcm'), [0]), 16);
  const nonce = await hkdfExpand(prk, concat(utf8('Content-Encoding: nonce'), [0]), 12);
  const key = await crypto.subtle.importKey('raw', cek as BufferSource, { name: 'AES-GCM' }, false, ['decrypt']);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext as BufferSource));
  if (padded.length < 1 || padded[padded.length - 1] !== 2) throw new Error('bad padding');
  return padded.slice(0, -1);
}

/** Sends one push (empty, or an encrypted JSON payload). 404/410 = the subscription is gone. */
export async function sendPush(sub: PushSub, env: VapidEnv, fetchImpl: PushFetch = fetch, payload?: PushPayload): Promise<'ok' | 'gone' | 'fail'> {
  try {
    const headers: Record<string, string> = { Authorization: await vapidAuthHeader(sub.endpoint, env), TTL: '600', Urgency: 'high' };
    let body: Uint8Array | undefined;
    if (payload) {
      body = await encryptWebPush(sub, utf8(JSON.stringify(payload)));
      headers['Content-Encoding'] = 'aes128gcm';
      headers['Content-Type'] = 'application/octet-stream';
    } else {
      headers['Content-Length'] = '0';
    }
    const res = await fetchImpl(sub.endpoint, { method: 'POST', headers, body: body as BufferSource | undefined });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

/**
 * "Still feeding?" reminders: Web Push subscription helpers (device-local state; no core imports).
 * Background alerts come from the sync worker (Durable Object alarm -> web push) so they arrive even when the
 * phone has suspended the app; the in-app prompt (StillFeedingPrompt) covers the foreground.
 */
export interface PushCtx {
  apiBase: string;
  /** Household invite code (the sync bearer secret). */
  code: string;
  memberId: string;
}

export type ReminderSupport = 'ok' | 'needs-install' | 'unsupported';
export type ReminderState = 'on' | 'off' | 'denied' | 'needs-install' | 'unsupported';

const ASKED_KEY = 'bf.ui.remindersAsked.v1';
const OFF_KEY = 'bf.ui.remindersOff.v1';

export const isStandalone = (): boolean =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as unknown as { standalone?: boolean }).standalone === true);
const isIos = (): boolean => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function reminderSupport(): ReminderSupport {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return 'unsupported';
  // iOS only exposes Push/Notification to web apps added to the Home Screen.
  if (isIos() && !isStandalone()) return 'needs-install';
  return 'PushManager' in window && 'Notification' in window ? 'ok' : 'unsupported';
}

export async function reminderState(): Promise<ReminderState> {
  const sup = reminderSupport();
  if (sup !== 'ok') return sup;
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || localStorage.getItem(OFF_KEY) === '1') return 'off';
  try {
    const reg = await navigator.serviceWorker.ready;
    return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

const b64uToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64u = (buf: ArrayBuffer | null): string =>
  buf ? btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '';

async function post(ctx: PushCtx, path: string, body: unknown): Promise<Response> {
  return fetch(`${ctx.apiBase.replace(/\/+$/, '')}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.code}` },
    body: JSON.stringify(body),
  });
}

/** Subscribe this device and register it with the worker. MUST run from a user gesture (iOS prompts then). */
export async function enableReminders(ctx: PushCtx): Promise<ReminderState> {
  const sup = reminderSupport();
  if (sup !== 'ok') return sup;
  try { localStorage.setItem(ASKED_KEY, '1'); } catch { /* private mode */ }
  const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.ready;
  const keyRes = await post(ctx, '/api/push/key', {});
  if (!keyRes.ok) throw new Error('Reminders aren’t available right now.');
  const { publicKey } = (await keyRes.json()) as { publicKey: string };
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) });
  const res = await post(ctx, '/api/push/subscribe', {
    endpoint: sub.endpoint, p256dh: bytesToB64u(sub.getKey('p256dh')), auth: bytesToB64u(sub.getKey('auth')), memberId: ctx.memberId,
  });
  if (!res.ok) throw new Error('Couldn’t turn on reminders. Try again.');
  try { localStorage.removeItem(OFF_KEY); } catch { /* private mode */ }
  return 'on';
}

export async function disableReminders(ctx: PushCtx): Promise<ReminderState> {
  try { localStorage.setItem(OFF_KEY, '1'); } catch { /* private mode */ }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await post(ctx, '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
      await sub.unsubscribe();
    }
  } catch { /* nothing to undo */ }
  return 'off';
}

/** Re-register on launch (a refreshed subscription / new member id); silent, never prompts. */
export async function refreshReminders(ctx: PushCtx): Promise<void> {
  try {
    if (reminderSupport() !== 'ok' || Notification.permission !== 'granted' || localStorage.getItem(OFF_KEY) === '1') return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await post(ctx, '/api/push/subscribe', { endpoint: sub.endpoint, p256dh: bytesToB64u(sub.getKey('p256dh')), auth: bytesToB64u(sub.getKey('auth')), memberId: ctx.memberId });
  } catch { /* offline: next launch */ }
}

/** First timer start: ask once (inside the tap), so the very first feed can already remind. */
export const shouldAskOnStart = (): boolean => {
  try { return reminderSupport() === 'ok' && Notification.permission === 'default' && localStorage.getItem(ASKED_KEY) !== '1'; } catch { return false; }
};

export async function showTestNotification(): Promise<void> {
  const reg = await navigator.serviceWorker.ready;
  await reg.showNotification('Still feeding?', { body: 'This is how the 15-minute check-in will look.', tag: 'bf-still-feeding-test', icon: 'icons/icon-192.png' });
}

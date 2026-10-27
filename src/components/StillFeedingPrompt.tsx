import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmtClock } from '../ui/format';

/** Nursing-time interval between "Still feeding?" check-ins (matches the worker's push reminders). */
export const CHECK_IN_MS = 15 * 60_000;
const key = (id: string) => `bf.ui.checkin.${id}`;
const read = (id: string): number => { try { return Number(localStorage.getItem(key(id))) || 0; } catch { return 0; } };
const write = (id: string, n: number) => { try { localStorage.setItem(key(id), String(n)); } catch { /* private mode */ } };

const SKIP_KEY = 'bf.ui.checkin.skipNext';
/** Call right when starting a backdated feed so the check-in doesn't fire the instant it begins. */
export const skipNextCheckIn = () => { try { localStorage.setItem(SKIP_KEY, String(Date.now())); } catch { /* private mode */ } };
/** Call after the start time of a running feed is edited: check-ins resume at the next 15-min mark. */
export const ackCheckIn = (feedId: string, elapsedMs: number) => {
  write(feedId, Math.floor(elapsedMs / CHECK_IN_MS));
  window.dispatchEvent(new CustomEvent('bf-checkin', { detail: feedId }));
};
const takeSkip = (): boolean => {
  try {
    const t = Number(localStorage.getItem(SKIP_KEY)) || 0;
    localStorage.removeItem(SKIP_KEY);
    return Date.now() - t < 30_000;
  } catch { return false; }
};

/**
 * In-app check-in: when a running breastfeeding timer passes 15 min (then every 15 min after) ask
 * "Still feeding?". Keep going snoozes until the next 15-min mark; Stop & save ends the feed.
 * Elapsed comes from the feed's (possibly adjusted) start. Background alerts are web push from the worker.
 */
export function StillFeedingPrompt({ feedId, running, elapsedMs, onStop }: { feedId: string | null; running: boolean; elapsedMs: number; onStop: () => void }) {
  const n = Math.floor(elapsedMs / CHECK_IN_MS);
  const [acked, setAcked] = useState(0);
  const seen = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (feedId && seen.current !== feedId) {
      seen.current = feedId;
      const have = read(feedId);
      const skip = takeSkip();
      const a = skip ? Math.max(have, n) : have;
      if (skip) write(feedId, a);
      setAcked(a);
    }
    if (!feedId) seen.current = null;
  }, [feedId]);
  useEffect(() => {
    const on = (e: Event) => { if (feedId && (e as CustomEvent).detail === feedId) setAcked(read(feedId)); };
    window.addEventListener('bf-checkin', on);
    return () => window.removeEventListener('bf-checkin', on);
  }, [feedId]);
  // Clear stale notifications once the user is back looking at the app.
  useEffect(() => {
    if (!feedId || !running || n < 1 || n <= acked) return;
    void navigator.serviceWorker?.getRegistration().then((r) => r?.getNotifications({ tag: 'bf-still-feeding' }).then((l) => l.forEach((x) => x.close()))).catch(() => undefined);
  }, [feedId, running, n, acked]);
  if (!feedId || !running || n < 1 || n <= acked) return null;
  return (
    <div className="dialog-backdrop" role="alertdialog" aria-modal="true" aria-label="Still feeding?" data-testid="still-feeding">
      <div className="dialog">
        <h3>Still feeding?</h3>
        <div className="dim">The timer has been running for <b className="num">{fmtClock(elapsedMs)}</b>. Keep going, or stop and save this feed.</div>
        <div className="actions">
          <button type="button" className="btn" onClick={() => { write(feedId, n); setAcked(n); }} autoFocus>Keep going</button>
          <button type="button" className="btn btn-primary" onClick={() => { write(feedId, n); setAcked(n); onStop(); }}>Stop &amp; save</button>
        </div>
      </div>
    </div>
  );
}

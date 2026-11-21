/**
 * Sleep-training display helpers only (formatting and copy).
 * Night number, intervals, and countdown come from Dealer's §8c
 * `timerState` / `nightNumber` / `sleepTrend` via `src/core`. Do not
 * reimplement that math here.
 */
import type { SleepEvent, SleepEventKind, SleepSession } from '../../core';

/**
 * Remaining wait as "4:12". Floors whole seconds and clamps to `capMs` (the
 * check interval or nap cap) so a slightly stale clock can never show more
 * than the plan allows (e.g. 60:01).
 */
export function fmtCountdown(ms: number, capMs?: number): string {
  const cap = capMs != null && Number.isFinite(capMs) ? Math.max(0, capMs) : Infinity;
  const x = Math.min(cap, Math.max(0, ms));
  const s = Math.floor(x / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtAgoPhrase(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 min ago';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m ago` : `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function minutesToTimeInput(minutes: number): string {
  const m = Math.max(0, Math.min(1439, Math.floor(minutes)));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

export function timeInputToMinutes(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]) * 60 + Number(m[2]);
  if (!Number.isFinite(n) || n < 0 || n > 1439) return null;
  return n;
}

const EVENT_VERB: Record<SleepEventKind, string> = {
  cry_start: 'started the crying timer',
  cry_stop: 'stopped the crying timer',
  check_start: 'went in for a check',
  check_end: 'finished a check',
  asleep: 'marked her asleep',
  night_waking: 'logged a night waking',
  planned_night_feed: 'logged a planned feed',
  note: 'added a note',
};

function liveEvents(session: SleepSession): SleepEvent[] {
  return (session.events ?? []).filter((e) => !e.deleted).slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** Banner copy when the other parent (or this parent on another phone) last acted. */
export function remoteSleepLine(
  session: SleepSession | null,
  meId: string | null,
  deviceId: string,
  now: number,
): string | null {
  if (!session) return null;
  const events = liveEvents(session);
  const last = events[events.length - 1];
  const who = last?.loggedBy ?? session.loggedBy;
  const dev = last?.deviceId ?? session.deviceId;
  const at = last?.at ?? session.putDownAt ?? session.startedAt;
  const otherPerson = meId !== null && who.id !== meId;
  const otherDevice = dev !== deviceId;
  if (!otherPerson && !otherDevice) return null;
  const name = otherPerson ? who.name : 'You';
  const device = !otherPerson && otherDevice ? ' on another phone' : '';
  const verb = last ? EVENT_VERB[last.kind] : session.type === 'nap' ? 'started a nap' : 'started bedtime';
  return `${name} ${verb}${device} ${fmtAgoPhrase(now - at)}`;
}

export const FERBER_RULES = [
  'Put her down awake, in a dark, boring room.',
  'Checks are brief: 1–2 min, lights off, pat or shush, don’t pick up.',
  'Each check waits a little longer, then stays at that night’s last time.',
  'Stopping the crying timer resets the wait, but keeps the same check.',
  'Naps use the same intervals, capped at 60 minutes.',
  'A waking at or after the morning cutoff ends the night.',
  'Both of you follow the same plan.',
] as const;

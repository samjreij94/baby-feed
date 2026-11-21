/**
 * Sleep Training (Ferber check-and-console) — pure helpers (SPEC §8c).
 * Device local time = JS Date local methods (phones: America/Chicago; tests pin TZ).
 */
import { addLocalDays, localDateKey, startOfLocalDay } from './metrics';
import { compareVersion } from './merge';
import type {
  EpochMs,
  SleepEndReason,
  SleepEvent,
  SleepEventKind,
  SleepIntervalRow,
  SleepPlan,
  SleepPlanPatch,
  SleepSession,
  SleepSessionMetrics,
  SleepTimerPhase,
  SleepTimerState,
  SleepTrend,
} from './types';
import { SLEEP_PLAN_ID } from './types';

export { SLEEP_PLAN_ID };

export const DEFAULT_WAKE_CUTOFF_MINUTES = 360;
export const NAP_CAP_MS = 60 * 60_000;
export const MAX_SLEEP_EVENTS = 200;
export const MAX_SLEEP_SESSION_BYTES = 32 * 1024;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const MAX_NOTE = 1000;
const MAX_INTERVAL_MIN = 180;
const EVENT_KINDS: ReadonlySet<SleepEventKind> = new Set([
  'cry_start',
  'cry_stop',
  'check_start',
  'check_end',
  'night_waking',
  'planned_night_feed',
  'note',
  'asleep',
]);
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;

export function defaultSleepIntervals(): SleepIntervalRow[] {
  return [
    { night: 1, firstMin: 3, secondMin: 5, laterMin: 10 },
    { night: 2, firstMin: 5, secondMin: 10, laterMin: 12 },
    { night: 3, firstMin: 10, secondMin: 12, laterMin: 15 },
    { night: 4, firstMin: 12, secondMin: 15, laterMin: 17 },
    { night: 5, firstMin: 15, secondMin: 17, laterMin: 20 },
    { night: 6, firstMin: 17, secondMin: 20, laterMin: 25 },
    { night: 7, firstMin: 20, secondMin: 25, laterMin: 30 },
  ];
}

export function defaultSleepPlanFields(startDate: string): Pick<SleepPlan, 'startDate' | 'wakeCutoffMinutes' | 'intervals'> {
  return {
    startDate,
    wakeCutoffMinutes: DEFAULT_WAKE_CUTOFF_MINUTES,
    intervals: defaultSleepIntervals(),
  };
}

/** A non-persisted default plan (startDate = local today of `now`). */
export function unsavedDefaultPlan(now: EpochMs): SleepPlan {
  return {
    id: SLEEP_PLAN_ID,
    householdId: null,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    loggedBy: { id: 'local', name: '' },
    deviceId: 'local',
    kind: 'sleep_plan',
    ...defaultSleepPlanFields(localDateKey(now)),
  };
}

export function effectivePlan(plan: SleepPlan | null | undefined, now: EpochMs): SleepPlan {
  if (plan && !plan.deleted) return plan;
  return unsavedDefaultPlan(now);
}

function parseLocalDate(date: string): number {
  const m = DATE_RE.exec(date);
  if (!m) return NaN;
  return new Date(Number(m[0].slice(0, 4)), Number(m[0].slice(5, 7)) - 1, Number(m[0].slice(8, 10))).getTime();
}

/** Calendar days from `from` to `to` (`YYYY-MM-DD`), signed. DST-safe (UTC day counts). */
export function calendarDays(from: string, to: string): number {
  const a = DATE_RE.exec(from);
  const b = DATE_RE.exec(to);
  if (!a || !b) return NaN;
  const av = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const bv = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.round((bv - av) / 86_400_000);
}

export function sessionNightDate(session: SleepSession, plan: SleepPlan): string {
  const t = session.putDownAt ?? session.startedAt;
  const d = new Date(t);
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60 + d.getMilliseconds() / 60_000;
  const cutoff = Number.isFinite(plan.wakeCutoffMinutes) ? plan.wakeCutoffMinutes : DEFAULT_WAKE_CUTOFF_MINUTES;
  if (minutes < cutoff) return localDateKey(addLocalDays(startOfLocalDay(t), -1));
  return localDateKey(t);
}

export function sessionAttributionDate(session: SleepSession, plan: SleepPlan): string {
  return session.type === 'nap' ? localDateKey(session.startedAt) : sessionNightDate(session, plan);
}

export function nightNumber(session: SleepSession, plan: SleepPlan): number {
  const over = session.nightNumberOverride;
  if (typeof over === 'number' && Number.isFinite(over) && over >= 1) return Math.floor(over);
  if (!plan.startDate || !DATE_RE.test(plan.startDate)) return 1;
  const date = sessionAttributionDate(session, plan);
  const days = calendarDays(plan.startDate, date);
  if (!Number.isFinite(days)) return 1;
  return Math.max(1, 1 + days);
}

export function wakeCutoffAt(plan: SleepPlan, nightDate: string): EpochMs {
  const start = parseLocalDate(nightDate);
  const morning = new Date(addLocalDays(startOfLocalDay(start), 1));
  const cutoff = Number.isFinite(plan.wakeCutoffMinutes) ? plan.wakeCutoffMinutes : DEFAULT_WAKE_CUTOFF_MINUTES;
  morning.setHours(Math.floor(cutoff / 60), cutoff % 60, 0, 0);
  return morning.getTime();
}

export function isMorningWake(plan: SleepPlan, session: SleepSession, at: EpochMs): boolean {
  if (session.type !== 'night') return false;
  return at >= wakeCutoffAt(plan, sessionNightDate(session, plan));
}

export function intervalForCheck(plan: SleepPlan, night: number, checkIndex: number): number {
  const rows = plan.intervals?.length ? plan.intervals : defaultSleepIntervals();
  const n = Math.max(1, Math.min(7, Math.floor(night) || 1));
  const row = rows.find((r) => r.night === n) ?? rows[rows.length - 1] ?? defaultSleepIntervals()[6]!;
  const mins = checkIndex <= 1 ? row.firstMin : checkIndex === 2 ? row.secondMin : row.laterMin;
  return Math.max(0, mins) * 60_000;
}

const KIND_ORDER: Record<SleepEventKind, number> = {
  night_waking: 0,
  cry_start: 1,
  cry_stop: 2,
  check_start: 3,
  check_end: 4,
  asleep: 5,
  planned_night_feed: 6,
  note: 7,
};

function eventOrder(a: SleepEvent, b: SleepEvent): number {
  if (a.at !== b.at) return a.at - b.at;
  const ka = KIND_ORDER[a.kind] ?? 50;
  const kb = KIND_ORDER[b.kind] ?? 50;
  if (ka !== kb) return ka - kb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function liveEvents(session: SleepSession, now: EpochMs, endedAt: EpochMs | null): SleepEvent[] {
  const end = endedAt ?? Infinity;
  return session.events
    .filter((e) => !e.deleted && Number.isFinite(e.at) && e.at <= now && e.at <= end && e.at >= session.startedAt)
    .slice()
    .sort(eventOrder);
}

interface Walk {
  checkIndex: number;
  crying: boolean;
  cryStartedAt: EpochMs | null;
  inCheck: boolean;
  wasCrying: boolean;
  asleep: boolean;
  attemptStartedAt: EpochMs | null;
  endedAt: EpochMs | null;
  endReason: SleepEndReason | null;
  appliedFirstAsleep: boolean;
  checks: number;
  wakings: number;
  pendingWake: boolean;
  cryingMs: number;
  cryStretchStart: EpochMs | null;
}

function closeCry(w: Walk, at: EpochMs): void {
  if (w.cryStretchStart != null) {
    w.cryingMs += Math.max(0, at - w.cryStretchStart);
    w.cryStretchStart = null;
  }
  w.crying = false;
  w.cryStartedAt = null;
}

function startCry(w: Walk, at: EpochMs): void {
  if (w.crying) return;
  w.crying = true;
  w.cryStartedAt = at;
  w.cryStretchStart = at;
}

function applyAsleep(w: Walk, at: EpochMs): void {
  closeCry(w, at);
  w.inCheck = false;
  w.wasCrying = false;
  w.asleep = true;
  w.appliedFirstAsleep = true;
  w.pendingWake = false;
}

function applyWake(w: Walk, at: EpochMs, implicitCry: boolean, morning: boolean): void {
  if (morning) {
    closeCry(w, at);
    w.endedAt = at;
    w.endReason = 'morning';
    w.asleep = false;
    w.inCheck = false;
    w.pendingWake = false;
    return;
  }
  closeCry(w, at);
  w.asleep = false;
  w.checkIndex = 1;
  w.inCheck = false;
  w.wasCrying = false;
  w.attemptStartedAt = at;
  w.wakings += 1;
  w.pendingWake = true;
  if (implicitCry) {
    startCry(w, at);
    w.pendingWake = true; // cry_start in the same instant shouldn't add another waking
  }
}

function walkSession(session: SleepSession, plan: SleepPlan, now: EpochMs): Walk {
  const w: Walk = {
    checkIndex: 1,
    crying: false,
    cryStartedAt: null,
    inCheck: false,
    wasCrying: false,
    asleep: false,
    attemptStartedAt: session.putDownAt,
    endedAt: session.endedAt != null && session.endedAt <= now ? session.endedAt : null,
    endReason: session.endedAt != null && session.endedAt <= now ? 'manual' : null,
    appliedFirstAsleep: false,
    checks: 0,
    wakings: 0,
    pendingWake: false,
    cryingMs: 0,
    cryStretchStart: null,
  };
  const firstAsleep = session.asleepAt;
  const events = liveEvents(session, now, w.endedAt);

  for (const ev of events) {
    if (w.endedAt != null && ev.at > w.endedAt) break;
    // Apply first asleep at its timestamp, but not at the same instant as this event
    // (the event itself — usually `asleep` — handles that instant).
    if (!w.appliedFirstAsleep && firstAsleep != null && firstAsleep < ev.at) {
      applyAsleep(w, firstAsleep);
    }

    switch (ev.kind) {
      case 'night_waking': {
        if (w.endedAt) break;
        if (w.asleep) {
          applyWake(w, ev.at, false, isMorningWake(plan, session, ev.at));
        }
        // Already woken (e.g. a same-instant cry_start was sorted first): don't recount or stop a new cry.
        break;
      }
      case 'cry_start': {
        if (w.asleep) {
          applyWake(w, ev.at, true, isMorningWake(plan, session, ev.at));
          break;
        }
        if (w.pendingWake && ev.at === (w.attemptStartedAt ?? ev.at)) {
          // same-instant cry after an explicit night_waking: start crying, don't count again
          w.pendingWake = false;
          if (!w.endedAt) startCry(w, ev.at);
          break;
        }
        w.pendingWake = false;
        if (!w.inCheck && !w.endedAt) startCry(w, ev.at);
        break;
      }
      case 'cry_stop': {
        w.pendingWake = false;
        closeCry(w, ev.at);
        break;
      }
      case 'check_start': {
        w.pendingWake = false;
        if (!w.inCheck && !w.endedAt) {
          w.wasCrying = w.crying;
          closeCry(w, ev.at);
          w.inCheck = true;
        }
        break;
      }
      case 'check_end': {
        w.pendingWake = false;
        if (w.inCheck && !w.endedAt) {
          w.inCheck = false;
          w.checkIndex += 1;
          w.checks += 1;
          if (w.wasCrying) startCry(w, ev.at);
          w.wasCrying = false;
        }
        break;
      }
      case 'asleep': {
        w.pendingWake = false;
        applyAsleep(w, ev.at);
        break;
      }
      case 'planned_night_feed':
      case 'note':
        w.pendingWake = false;
        break;
    }
    if (w.endedAt != null && w.endReason === 'morning') break;
  }

  if (!w.appliedFirstAsleep && firstAsleep != null && firstAsleep <= now && (w.endedAt == null || firstAsleep <= w.endedAt)) {
    applyAsleep(w, firstAsleep);
  }

  // Close an open cry stretch at min(now, endedAt) for metrics.
  const closeAt = w.endedAt != null && w.endedAt <= now ? w.endedAt : now;
  if (w.cryStretchStart != null) {
    w.cryingMs += Math.max(0, closeAt - w.cryStretchStart);
    // keep cryStretchStart so timer can still see an open cry (we'll not use cryingMs for that)
  }

  if (session.deleted) {
    w.endedAt = w.endedAt ?? now;
    w.endReason = w.endReason ?? 'manual';
  }
  return w;
}

export function timerState(session: SleepSession, plan: SleepPlan, now: EpochMs): SleepTimerState {
  const w = walkSession(session, plan, now);
  const night = nightNumber(session, plan);

  let phase: SleepTimerPhase;
  if (w.endedAt != null && w.endedAt <= now) phase = 'ended';
  else if (w.asleep) phase = 'asleep';
  else if (
    session.type === 'nap' &&
    !w.asleep &&
    w.attemptStartedAt != null &&
    now - w.attemptStartedAt >= NAP_CAP_MS
  ) {
    phase = 'nap_capped';
  } else if (session.putDownAt == null) phase = 'pre_putdown';
  else if (w.inCheck) phase = 'checking';
  else if (w.crying) phase = 'crying';
  else phase = 'quiet';

  const inWaitCycle = phase === 'quiet' || phase === 'crying' || phase === 'checking';
  const intervalMs = inWaitCycle ? intervalForCheck(plan, night, w.checkIndex) : 0;
  const accumulating = phase === 'crying' && w.cryStartedAt != null;
  const elapsedMs = accumulating ? Math.max(0, now - w.cryStartedAt!) : 0;
  const remainingMs = accumulating ? Math.max(0, intervalMs - elapsedMs) : 0;
  const dueAt = accumulating ? w.cryStartedAt! + intervalMs : null;

  const napAttempt =
    session.type === 'nap' && w.attemptStartedAt != null && phase !== 'asleep' && phase !== 'ended' && phase !== 'pre_putdown';
  const napCapDueAt = napAttempt ? w.attemptStartedAt! + NAP_CAP_MS : null;

  let endReason: SleepEndReason | null = null;
  if (phase === 'ended') endReason = w.endReason ?? 'manual';

  return {
    phase,
    nightNumber: night,
    checkIndex: w.checkIndex,
    intervalMs,
    elapsedMs,
    remainingMs,
    dueAt,
    cryStartedAt: accumulating ? w.cryStartedAt : null,
    attemptStartedAt: w.attemptStartedAt,
    napCapDueAt,
    endReason,
    crying: phase === 'crying',
  };
}

export function sessionMetrics(session: SleepSession, plan: SleepPlan, now: EpochMs): SleepSessionMetrics {
  const w = walkSession(session, plan, now);
  const night = nightNumber(session, plan);
  const timeToAsleepMs =
    session.putDownAt != null && session.asleepAt != null ? Math.max(0, session.asleepAt - session.putDownAt) : null;
  return {
    sessionId: session.id,
    type: session.type,
    nightNumber: night,
    date: sessionAttributionDate(session, plan),
    startedAt: session.startedAt,
    putDownAt: session.putDownAt,
    asleepAt: session.asleepAt,
    endedAt: session.endedAt,
    timeToAsleepMs,
    cryingMs: w.cryingMs,
    checks: w.checks,
    wakings: w.wakings,
  };
}

export function sleepTrend(sessions: readonly SleepSession[], plan: SleepPlan, now: EpochMs): SleepTrend {
  const live = sessions.filter((s) => !s.deleted).map((s) => sessionMetrics(s, plan, now));
  const nights = live
    .filter((s) => s.type === 'night')
    .sort((a, b) => a.nightNumber - b.nightNumber || a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : 1));
  const naps = live
    .filter((s) => s.type === 'nap')
    .sort((a, b) => a.startedAt - b.startedAt || (a.sessionId < b.sessionId ? -1 : 1));
  return { nights, naps };
}

export function mergeSleepEvents(a: readonly SleepEvent[], b: readonly SleepEvent[]): SleepEvent[] {
  const map = new Map<string, SleepEvent>();
  for (const ev of [...a, ...b]) {
    const cur = map.get(ev.id);
    if (!cur) {
      map.set(ev.id, { ...ev });
      continue;
    }
    map.set(ev.id, { ...cur, deleted: !!(cur.deleted || ev.deleted) });
  }
  return [...map.values()].sort((x, y) => x.at - y.at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

function earlier(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function hasOverride(s: SleepSession): boolean {
  return Object.prototype.hasOwnProperty.call(s, 'nightNumberOverride');
}

function eventsEqual(a: readonly SleepEvent[], b: readonly SleepEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.kind !== y.kind || x.at !== y.at || !!x.deleted !== !!y.deleted || (x.text ?? '') !== (y.text ?? '')) {
      return false;
    }
  }
  return true;
}

/** True when two sessions have the same user-visible payload (ignores updatedAt / deviceId / loggedBy). */
export function sleepContentEqual(a: SleepSession, b: SleepSession): boolean {
  return (
    a.deleted === b.deleted &&
    a.type === b.type &&
    a.startedAt === b.startedAt &&
    a.putDownAt === b.putDownAt &&
    a.asleepAt === b.asleepAt &&
    a.endedAt === b.endedAt &&
    // missing / undefined = auto; explicit null is a clear
    (hasOverride(a) && a.nightNumberOverride !== undefined ? a.nightNumberOverride : undefined) ===
      (hasOverride(b) && b.nightNumberOverride !== undefined ? b.nightNumberOverride : undefined) &&
    (a.note ?? '') === (b.note ?? '') &&
    eventsEqual(a.events, b.events)
  );
}

export function mergeSleepSession(a: SleepSession, b: SleepSession): SleepSession {
  const newer = compareVersion(b, a) > 0 ? b : a;
  const older = newer === a ? b : a;
  const events = mergeSleepEvents(a.events, b.events);
  let nightNumberOverride: number | null | undefined;
  if (hasOverride(newer)) nightNumberOverride = newer.nightNumberOverride;
  else if (hasOverride(older)) nightNumberOverride = older.nightNumberOverride;

  const merged: SleepSession = {
    ...newer,
    kind: 'sleep_session',
    type: older.type ?? newer.type,
    startedAt: earlier(a.startedAt, b.startedAt) ?? newer.startedAt,
    putDownAt: earlier(a.putDownAt, b.putDownAt),
    asleepAt: earlier(a.asleepAt, b.asleepAt),
    endedAt: earlier(a.endedAt, b.endedAt),
    events,
    note: newer.note ?? older.note,
  };
  if (nightNumberOverride === undefined) delete merged.nightNumberOverride;
  else merged.nightNumberOverride = nightNumberOverride;

  if (sleepContentEqual(merged, newer)) return merged;
  return { ...merged, updatedAt: Math.max(a.updatedAt, b.updatedAt) + 1, deviceId: b.deviceId };
}

export function isOpenSleepSession(e: { kind: string; deleted: boolean; endedAt?: EpochMs | null }): e is SleepSession {
  return e.kind === 'sleep_session' && !e.deleted && (e as SleepSession).endedAt == null;
}

export function activeSleepView(
  sessions: readonly SleepSession[],
  plan: SleepPlan,
  now: EpochMs,
): { session: SleepSession | null; others: SleepSession[]; timer: SleepTimerState | null } {
  const open = sessions
    .filter((s) => isOpenSleepSession(s))
    .sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const session = open[0] ?? null;
  return {
    session,
    others: open.slice(1),
    timer: session ? timerState(session, plan, now) : null,
  };
}

// ── validation (client + server) ──

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown, max: number, min = 0): x is string => typeof x === 'string' && x.length >= min && x.length <= max;

export function validSleepEvent(x: unknown): string | null {
  if (!isObj(x)) return 'bad event';
  if (!isStr(x.id, 64, 8) || !ID_RE.test(x.id)) return 'bad event id';
  if (!EVENT_KINDS.has(x.kind as SleepEventKind)) return 'bad event kind';
  if (!isNum(x.at) || x.at < 0) return 'bad event at';
  if (!isObj(x.loggedBy) || !isStr(x.loggedBy.id, 64, 1) || !isStr(x.loggedBy.name, 60, 1)) return 'bad event loggedBy';
  if (!isStr(x.deviceId, 64, 1)) return 'bad event deviceId';
  if (x.deleted !== undefined && typeof x.deleted !== 'boolean') return 'bad event deleted';
  if (x.text !== undefined && !isStr(x.text, MAX_NOTE, 0)) return 'bad event text';
  if (x.kind === 'note' && !isStr(x.text, MAX_NOTE, 1)) return 'note requires text';
  return null;
}

export function validSleepIntervals(rows: unknown): string | null {
  if (!Array.isArray(rows) || rows.length !== 7) return 'bad intervals';
  const nights = new Set<number>();
  for (const r of rows) {
    if (!isObj(r)) return 'bad interval row';
    if (!isNum(r.night) || !Number.isInteger(r.night) || r.night < 1 || r.night > 7) return 'bad interval night';
    if (nights.has(r.night)) return 'duplicate interval night';
    nights.add(r.night);
    for (const k of ['firstMin', 'secondMin', 'laterMin'] as const) {
      const v = r[k];
      if (!isNum(v) || v < 0 || v > MAX_INTERVAL_MIN) return 'bad interval minutes';
    }
  }
  for (let n = 1; n <= 7; n++) if (!nights.has(n)) return 'missing interval night';
  return null;
}

export function validSleepPlanFields(e: Record<string, unknown>): string | null {
  if (e.id !== SLEEP_PLAN_ID) return 'sleep plan id mismatch';
  if (!isStr(e.startDate, 10, 10) || !DATE_RE.test(e.startDate)) return 'bad startDate';
  if (!isNum(e.wakeCutoffMinutes) || !Number.isInteger(e.wakeCutoffMinutes) || e.wakeCutoffMinutes < 0 || e.wakeCutoffMinutes > 1439) {
    return 'bad wakeCutoffMinutes';
  }
  return validSleepIntervals(e.intervals);
}

export function validSleepSessionFields(e: Record<string, unknown>): string | null {
  if (e.type !== 'night' && e.type !== 'nap') return 'bad sleep type';
  if (!isNum(e.startedAt) || e.startedAt < 0) return 'bad startedAt';
  if (e.putDownAt !== null && (!isNum(e.putDownAt) || e.putDownAt < 0)) return 'bad putDownAt';
  if (e.asleepAt !== null && (!isNum(e.asleepAt) || e.asleepAt < 0)) return 'bad asleepAt';
  if (e.endedAt !== null && (!isNum(e.endedAt) || e.endedAt < 0)) return 'bad endedAt';
  if (e.nightNumberOverride !== undefined && e.nightNumberOverride !== null) {
    if (!isNum(e.nightNumberOverride) || !Number.isInteger(e.nightNumberOverride) || e.nightNumberOverride < 1) {
      return 'bad nightNumberOverride';
    }
  }
  if (!Array.isArray(e.events)) return 'bad events';
  if (e.events.length > MAX_SLEEP_EVENTS) return 'too many events';
  for (const ev of e.events) {
    const err = validSleepEvent(ev);
    if (err) return err;
  }
  return null;
}

/** Normalize a plan patch against current/default values; returns a reason if invalid. */
export function normalizePlanPatch(
  cur: Pick<SleepPlan, 'startDate' | 'wakeCutoffMinutes' | 'intervals'> | null,
  patch: SleepPlanPatch,
  today: string,
): { ok: true; fields: Pick<SleepPlan, 'startDate' | 'wakeCutoffMinutes' | 'intervals'> } | { ok: false; reason: string } {
  const fields = {
    startDate: patch.startDate ?? cur?.startDate ?? today,
    wakeCutoffMinutes: patch.wakeCutoffMinutes ?? cur?.wakeCutoffMinutes ?? DEFAULT_WAKE_CUTOFF_MINUTES,
    intervals: patch.intervals ? patch.intervals.map((r) => ({ ...r })) : (cur?.intervals ?? defaultSleepIntervals()).map((r) => ({ ...r })),
  };
  const reason = validSleepPlanFields({ id: SLEEP_PLAN_ID, ...fields });
  if (reason) return { ok: false, reason };
  return { ok: true, fields };
}

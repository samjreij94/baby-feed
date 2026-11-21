process.env.TZ = 'America/Chicago';

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WAKE_CUTOFF_MINUTES,
  NAP_CAP_MS,
  calendarDays,
  defaultSleepPlanFields,
  intervalForCheck,
  isMorningWake,
  mergeSleepEvents,
  mergeSleepSession,
  nightNumber,
  sessionAttributionDate,
  sessionMetrics,
  sessionNightDate,
  sleepTrend,
  timerState,
  unsavedDefaultPlan,
  wakeCutoffAt,
} from '../sleep';
import type { MemberRef, SleepEvent, SleepEventKind, SleepPlan, SleepSession } from '../types';
import { SLEEP_PLAN_ID } from '../types';

const MIN = 60_000;
const who: MemberRef = { id: 'samir', name: 'Samir' };

/** Friday Nov 20, 2026 8:00 PM CST. */
const T0 = new Date(2026, 10, 20, 20, 0, 0, 0).getTime();

function plan(startDate = '2026-11-20', wakeCutoffMinutes = DEFAULT_WAKE_CUTOFF_MINUTES): SleepPlan {
  return {
    id: SLEEP_PLAN_ID,
    householdId: 'h',
    createdAt: T0,
    updatedAt: T0,
    deleted: false,
    loggedBy: who,
    deviceId: 'dev-a',
    kind: 'sleep_plan',
    ...defaultSleepPlanFields(startDate),
    wakeCutoffMinutes,
  };
}

function ev(kind: SleepEventKind, at: number, extra: Partial<SleepEvent> = {}): SleepEvent {
  return {
    id: extra.id ?? `${kind}-${at}`,
    kind,
    at,
    loggedBy: extra.loggedBy ?? who,
    deviceId: extra.deviceId ?? 'dev-a',
    deleted: extra.deleted,
    text: extra.text,
  };
}

function session(extra: Partial<SleepSession> = {}): SleepSession {
  return {
    id: extra.id ?? 'ses-1',
    householdId: 'h',
    createdAt: extra.startedAt ?? T0,
    updatedAt: extra.updatedAt ?? T0,
    deleted: extra.deleted ?? false,
    loggedBy: who,
    deviceId: extra.deviceId ?? 'dev-a',
    kind: 'sleep_session',
    type: extra.type ?? 'night',
    startedAt: extra.startedAt ?? T0,
    putDownAt: extra.putDownAt === undefined ? T0 : extra.putDownAt,
    asleepAt: extra.asleepAt ?? null,
    endedAt: extra.endedAt ?? null,
    events: extra.events ?? [],
    note: extra.note,
    nightNumberOverride: extra.nightNumberOverride,
  };
}

describe('night numbering', () => {
  it('TZ is America/Chicago', () => {
    expect(new Date(T0).getHours()).toBe(20);
    expect(sessionNightDate(session(), plan())).toBe('2026-11-20');
  });

  it('Night 1 on the plan start evening; increments by calendar day', () => {
    const p = plan('2026-11-20');
    expect(nightNumber(session({ startedAt: T0, putDownAt: T0 }), p)).toBe(1);
    const satEve = new Date(2026, 10, 21, 20, 0).getTime();
    expect(nightNumber(session({ startedAt: satEve, putDownAt: satEve }), p)).toBe(2);
    const weekLater = new Date(2026, 10, 26, 21, 0).getTime();
    expect(nightNumber(session({ startedAt: weekLater, putDownAt: weekLater }), p)).toBe(7);
    const n8 = new Date(2026, 10, 27, 21, 0).getTime();
    expect(nightNumber(session({ startedAt: n8, putDownAt: n8 }), p)).toBe(8);
  });

  it('a start after midnight but before the cutoff belongs to last night', () => {
    const p = plan('2026-11-20');
    const sat1am = new Date(2026, 10, 21, 1, 0).getTime();
    expect(sessionNightDate(session({ startedAt: sat1am, putDownAt: sat1am }), p)).toBe('2026-11-20');
    expect(nightNumber(session({ startedAt: sat1am, putDownAt: sat1am }), p)).toBe(1);
    const sat7am = new Date(2026, 10, 21, 7, 0).getTime();
    expect(sessionNightDate(session({ startedAt: sat7am, putDownAt: sat7am }), p)).toBe('2026-11-21');
    expect(nightNumber(session({ startedAt: sat7am, putDownAt: sat7am }), p)).toBe(2);
  });

  it('naps use the calendar date of startedAt (even before the cutoff)', () => {
    const p = plan('2026-11-20');
    const sat1am = new Date(2026, 10, 21, 1, 0).getTime();
    const nap = session({ type: 'nap', startedAt: sat1am, putDownAt: sat1am });
    expect(sessionAttributionDate(nap, p)).toBe('2026-11-21');
    expect(nightNumber(nap, p)).toBe(2);
  });

  it('override wins; sessions before the plan start clamp to 1; missing startDate is 1', () => {
    const p = plan('2026-11-20');
    expect(nightNumber(session({ nightNumberOverride: 4 }), p)).toBe(4);
    expect(nightNumber(session({ nightNumberOverride: 4.9 }), p)).toBe(4);
    const thu = new Date(2026, 10, 19, 20, 0).getTime();
    expect(nightNumber(session({ startedAt: thu, putDownAt: thu }), p)).toBe(1);
    expect(nightNumber(session(), { ...p, startDate: '' })).toBe(1);
  });

  it('wakeCutoffAt is 6:00 local the next morning; isMorningWake is at-or-after and night-only', () => {
    const p = plan('2026-11-20');
    const s = session();
    const cutoff = wakeCutoffAt(p, '2026-11-20');
    expect(new Date(cutoff).getHours()).toBe(6);
    expect(new Date(cutoff).getDate()).toBe(21);
    const friNight = new Date(2026, 10, 20, 23, 0).getTime();
    const sat5 = new Date(2026, 10, 21, 5, 59).getTime();
    const sat6 = new Date(2026, 10, 21, 6, 0).getTime();
    const sat630 = new Date(2026, 10, 21, 6, 30).getTime();
    expect(isMorningWake(p, s, friNight)).toBe(false);
    expect(isMorningWake(p, s, sat5)).toBe(false);
    expect(isMorningWake(p, s, sat6)).toBe(true);
    expect(isMorningWake(p, s, sat630)).toBe(true);
    expect(isMorningWake(p, session({ type: 'nap' }), sat630)).toBe(false);
  });

  it('calendarDays is DST-safe', () => {
    // US DST ends Sun Nov 1, 2026 — 25-hour day should still count as 1 calendar day.
    expect(calendarDays('2026-10-31', '2026-11-01')).toBe(1);
    expect(calendarDays('2026-11-01', '2026-10-31')).toBe(-1);
    expect(calendarDays('2026-11-20', '2026-11-20')).toBe(0);
  });
});

describe('intervalForCheck / N7+', () => {
  it('picks 1st / 2nd / later and uses the N7+ row for night 7 and after', () => {
    const p = plan();
    expect(intervalForCheck(p, 1, 1)).toBe(3 * MIN);
    expect(intervalForCheck(p, 1, 2)).toBe(5 * MIN);
    expect(intervalForCheck(p, 1, 3)).toBe(10 * MIN);
    expect(intervalForCheck(p, 1, 9)).toBe(10 * MIN);
    expect(intervalForCheck(p, 2, 1)).toBe(5 * MIN);
    expect(intervalForCheck(p, 2, 2)).toBe(10 * MIN);
    expect(intervalForCheck(p, 2, 3)).toBe(12 * MIN);
    expect(intervalForCheck(p, 7, 1)).toBe(20 * MIN);
    expect(intervalForCheck(p, 7, 2)).toBe(25 * MIN);
    expect(intervalForCheck(p, 7, 3)).toBe(30 * MIN);
    expect(intervalForCheck(p, 8, 1)).toBe(20 * MIN);
    expect(intervalForCheck(p, 12, 3)).toBe(30 * MIN);
  });
});

describe('timerState', () => {
  const p = plan();

  it('put-down with no events is quiet, check 1, no dueAt', () => {
    const st = timerState(session(), p, T0);
    expect(st).toMatchObject({
      phase: 'quiet',
      nightNumber: 1,
      checkIndex: 1,
      intervalMs: 3 * MIN,
      elapsedMs: 0,
      remainingMs: 0,
      dueAt: null,
      crying: false,
    });
  });

  it('before put-down is pre_putdown', () => {
    const st = timerState(session({ putDownAt: null }), p, T0);
    expect(st.phase).toBe('pre_putdown');
    expect(st.intervalMs).toBe(0);
  });

  it('worked example: cry stop resets the same check; next interval starts at check_end', () => {
    // T+0 put-down; T+0:30 cry; T+1:30 stop; T+2:00 cry; check  T+5:00..T+5:20 (still crying)
    const events = [
      ev('cry_start', T0 + 0.5 * MIN),
      ev('cry_stop', T0 + 1.5 * MIN),
      ev('cry_start', T0 + 2 * MIN),
      ev('check_start', T0 + 5 * MIN),
      ev('check_end', T0 + 5.2 * MIN * 10 / 10), // T+5:20 = 5 * MIN + 20_000
    ];
    // 5.2 * MIN = 5*60000 + 0.2*60000 = 5 min + 12 sec. Wrong.
    events[4] = ev('check_end', T0 + 5 * MIN + 20_000);
    const s = session({ events });

    let st = timerState(s, p, T0 + 0.5 * MIN);
    expect(st.phase).toBe('crying');
    expect(st.checkIndex).toBe(1);
    expect(st.dueAt).toBe(T0 + 0.5 * MIN + 3 * MIN); // T+3:30
    expect(st.elapsedMs).toBe(0);
    expect(st.remainingMs).toBe(3 * MIN);

    st = timerState(s, p, T0 + 1 * MIN);
    expect(st.elapsedMs).toBe(0.5 * MIN);
    expect(st.remainingMs).toBe(2.5 * MIN);

    st = timerState(s, p, T0 + 1.5 * MIN);
    expect(st.phase).toBe('quiet');
    expect(st.checkIndex).toBe(1);
    expect(st.dueAt).toBeNull();
    expect(st.elapsedMs).toBe(0);

    st = timerState(s, p, T0 + 2 * MIN);
    expect(st.phase).toBe('crying');
    expect(st.checkIndex).toBe(1);
    expect(st.dueAt).toBe(T0 + 5 * MIN); // full 3 min from T+2:00
    expect(st.remainingMs).toBe(3 * MIN);

    st = timerState(s, p, T0 + 5 * MIN);
    expect(st.phase).toBe('checking');
    expect(st.checkIndex).toBe(1);
    expect(st.dueAt).toBeNull();

    st = timerState(s, p, T0 + 5 * MIN + 20_000);
    expect(st.phase).toBe('crying');
    expect(st.checkIndex).toBe(2);
    expect(st.intervalMs).toBe(5 * MIN);
    expect(st.dueAt).toBe(T0 + 5 * MIN + 20_000 + 5 * MIN); // T+10:20
    expect(st.cryStartedAt).toBe(T0 + 5 * MIN + 20_000);
  });

  it('a cry_stop before the interval elapses resets; the next cry restarts the same check from the full interval', () => {
    const s = session({
      events: [ev('cry_start', T0 + MIN), ev('cry_stop', T0 + 2 * MIN), ev('cry_start', T0 + 4 * MIN)],
    });
    const mid = timerState(s, p, T0 + 1.5 * MIN);
    expect(mid.phase).toBe('crying');
    expect(mid.checkIndex).toBe(1);
    expect(mid.dueAt).toBe(T0 + 4 * MIN);
    const after = timerState(s, p, T0 + 4 * MIN);
    expect(after.checkIndex).toBe(1);
    expect(after.intervalMs).toBe(3 * MIN);
    expect(after.dueAt).toBe(T0 + 7 * MIN);
    expect(after.elapsedMs).toBe(0);
  });

  it('duplicate cry_start is a no-op; unpaired check_end does not increment', () => {
    const s = session({
      events: [ev('cry_start', T0 + MIN), ev('cry_start', T0 + 2 * MIN, { id: 'dup' }), ev('check_end', T0 + 3 * MIN)],
    });
    const st = timerState(s, p, T0 + 3 * MIN);
    expect(st.phase).toBe('crying');
    expect(st.checkIndex).toBe(1);
    expect(st.cryStartedAt).toBe(T0 + MIN);
    expect(st.dueAt).toBe(T0 + 4 * MIN);
  });

  it('an early check (no preceding cry) still advances the index on check_end', () => {
    const s = session({
      events: [ev('check_start', T0 + MIN), ev('check_end', T0 + 2 * MIN)],
    });
    const st = timerState(s, p, T0 + 2 * MIN);
    expect(st.phase).toBe('quiet');
    expect(st.checkIndex).toBe(2);
    expect(st.intervalMs).toBe(5 * MIN);
    expect(st.dueAt).toBeNull();
  });

  it('marking asleep ends the wait; a waking before the cutoff restarts check 1', () => {
    const sat3 = new Date(2026, 10, 21, 3, 0).getTime();
    const s = session({
      asleepAt: T0 + 20 * MIN,
      events: [
        ev('cry_start', T0 + MIN),
        ev('asleep', T0 + 20 * MIN),
        ev('cry_start', sat3),
      ],
    });
    const sleeping = timerState(s, p, T0 + 30 * MIN);
    expect(sleeping.phase).toBe('asleep');
    expect(sleeping.dueAt).toBeNull();
    expect(sleeping.crying).toBe(false);

    const waking = timerState(s, p, sat3 + MIN);
    expect(waking.phase).toBe('crying');
    expect(waking.checkIndex).toBe(1);
    expect(waking.intervalMs).toBe(3 * MIN);
    expect(waking.attemptStartedAt).toBe(sat3);
    expect(waking.dueAt).toBe(sat3 + 3 * MIN);
    expect(waking.endReason).toBeNull();
  });

  it('a waking at or after the 6 AM cutoff ends the session (morning)', () => {
    const sat6 = new Date(2026, 10, 21, 6, 0).getTime();
    const sat630 = new Date(2026, 10, 21, 6, 30).getTime();
    const s = session({
      asleepAt: T0 + 20 * MIN,
      events: [ev('asleep', T0 + 20 * MIN), ev('cry_start', sat630)],
    });
    const st = timerState(s, p, sat630);
    expect(st.phase).toBe('ended');
    expect(st.endReason).toBe('morning');
    expect(st.dueAt).toBeNull();
    expect(st.crying).toBe(false);

    const atCutoff = session({
      asleepAt: T0 + 20 * MIN,
      events: [ev('asleep', T0 + 20 * MIN), ev('night_waking', sat6)],
    });
    expect(timerState(atCutoff, p, sat6).endReason).toBe('morning');
    expect(timerState(atCutoff, p, sat6).phase).toBe('ended');
  });

  it('an explicit night_waking before cutoff plus a same-instant cry_start is one restart, not two', () => {
    const sat3 = new Date(2026, 10, 21, 3, 0).getTime();
    const s = session({
      asleepAt: T0 + 10 * MIN,
      events: [ev('asleep', T0 + 10 * MIN), ev('night_waking', sat3), ev('cry_start', sat3, { id: 'cry' })],
    });
    const st = timerState(s, p, sat3 + 30_000);
    expect(st.phase).toBe('crying');
    expect(st.checkIndex).toBe(1);
    expect(st.cryStartedAt).toBe(sat3);
    expect(sessionMetrics(s, p, sat3 + 30_000).wakings).toBe(1);
  });

  it('a night waking without a prior asleep still resets to check 1 before the cutoff', () => {
    const sat2 = new Date(2026, 10, 21, 2, 0).getTime();
    const s = session({
      events: [
        ev('cry_start', T0),
        ev('check_start', T0 + 3 * MIN),
        ev('check_end', T0 + 3 * MIN + 20_000),
        ev('cry_stop', T0 + 4 * MIN),
        ev('night_waking', sat2),
      ],
    });
    const st = timerState(s, p, sat2);
    expect(st.phase).toBe('quiet');
    expect(st.checkIndex).toBe(1);
    expect(st.intervalMs).toBe(3 * MIN);
    expect(st.attemptStartedAt).toBe(sat2);
    expect(st.endReason).toBeNull();
    expect(st.crying).toBe(false);
    // Never marked asleep: a waking is not a metrics night-waking.
    expect(sessionMetrics(s, p, sat2).wakings).toBe(0);
    expect(sessionMetrics(s, p, sat2).checks).toBe(1);
  });

  it('a night waking without a prior asleep ends the night at or after the cutoff', () => {
    const sat610 = new Date(2026, 10, 21, 6, 10).getTime();
    const s = session({
      events: [
        ev('cry_start', T0),
        ev('check_start', T0 + 3 * MIN),
        ev('check_end', T0 + 3 * MIN + 20_000),
        ev('cry_stop', T0 + 4 * MIN),
        ev('night_waking', sat610),
      ],
    });
    const st = timerState(s, p, sat610);
    expect(st.phase).toBe('ended');
    expect(st.endReason).toBe('morning');
    expect(st.crying).toBe(false);
    expect(st.dueAt).toBeNull();
  });

  it('cry_stop at the same millisecond as check_end is not overridden, in either id order, and survives merge', () => {
    const at = T0 + 3 * MIN;
    const base = [
      ev('cry_start', T0),
      ev('check_start', T0 + 2 * MIN),
    ];
    const stopFirst = session({
      events: [...base, ev('cry_stop', at, { id: 'aaa-stop' }), ev('check_end', at, { id: 'zzz-end' })],
    });
    const endFirst = session({
      events: [...base, ev('check_end', at, { id: 'aaa-end' }), ev('cry_stop', at, { id: 'zzz-stop' })],
    });
    for (const s of [stopFirst, endFirst]) {
      const st = timerState(s, p, at);
      expect(st.phase, s.events.map((e) => e.id).join(',')).toBe('quiet');
      expect(st.crying).toBe(false);
      expect(st.checkIndex).toBe(2);
      expect(st.dueAt).toBeNull();
    }
    const merged = mergeSleepSession(stopFirst, { ...endFirst, events: [ev('cry_stop', at, { id: 'aaa-stop' }), ev('check_end', at, { id: 'zzz-end' })] });
    const walked = mergeSleepEvents(stopFirst.events, endFirst.events);
    expect(walked.filter((e) => e.at === at).map((e) => e.id)).toEqual(['aaa-end', 'aaa-stop', 'zzz-end', 'zzz-stop'].sort());
    // Same walk on both devices after union: quiet, check #2.
    const a = session({ events: walked, updatedAt: T0 + 1, deviceId: 'dev-a' });
    const b = session({ events: walked.slice().reverse(), updatedAt: T0 + 1, deviceId: 'dev-b' });
    const once = timerState(a, p, at);
    const twice = timerState(mergeSleepSession(a, b), p, at);
    expect(once.phase).toBe('quiet');
    expect(twice.phase).toBe('quiet');
    expect(once.checkIndex).toBe(2);
    expect(twice.checkIndex).toBe(2);
    expect(merged).toBeTruthy();
  });

  it('nap 60-minute cap: in-progress attempt caps; a later waking starts a new cap', () => {
    const nap = session({ type: 'nap', startedAt: T0, putDownAt: T0, events: [ev('cry_start', T0 + MIN)] });
    const mid = timerState(nap, p, T0 + 10 * MIN);
    expect(mid.phase).toBe('crying');
    expect(mid.napCapDueAt).toBe(T0 + NAP_CAP_MS);

    const capped = timerState(nap, p, T0 + NAP_CAP_MS);
    expect(capped.phase).toBe('nap_capped');
    expect(capped.dueAt).toBeNull();
    expect(capped.intervalMs).toBe(0);
    expect(capped.napCapDueAt).toBe(T0 + NAP_CAP_MS);

    const fell = session({
      type: 'nap',
      startedAt: T0,
      putDownAt: T0,
      asleepAt: T0 + 20 * MIN,
      events: [ev('asleep', T0 + 20 * MIN)],
    });
    expect(timerState(fell, p, T0 + NAP_CAP_MS).phase).toBe('asleep');
    expect(timerState(fell, p, T0 + NAP_CAP_MS).napCapDueAt).toBeNull();

    const woke = session({
      type: 'nap',
      startedAt: T0,
      putDownAt: T0,
      asleepAt: T0 + 20 * MIN,
      events: [ev('asleep', T0 + 20 * MIN), ev('cry_start', T0 + 40 * MIN)],
    });
    const after = timerState(woke, p, T0 + 41 * MIN);
    expect(after.phase).toBe('crying');
    expect(after.attemptStartedAt).toBe(T0 + 40 * MIN);
    expect(after.napCapDueAt).toBe(T0 + 40 * MIN + NAP_CAP_MS);
    expect(timerState(woke, p, T0 + 40 * MIN + NAP_CAP_MS).phase).toBe('nap_capped');
  });

  it('N7+ uses the 20/25/30 table', () => {
    const n8start = new Date(2026, 10, 27, 20, 0).getTime();
    const s = session({
      startedAt: n8start,
      putDownAt: n8start,
      events: [ev('cry_start', n8start + MIN)],
    });
    const st = timerState(s, plan('2026-11-20'), n8start + MIN);
    expect(st.nightNumber).toBe(8);
    expect(st.intervalMs).toBe(20 * MIN);
    expect(st.dueAt).toBe(n8start + MIN + 20 * MIN);
  });

  it('planned_night_feed and note do not affect the timer; deleted events are ignored', () => {
    const s = session({
      events: [
        ev('cry_start', T0 + MIN),
        ev('note', T0 + 2 * MIN, { text: 'shushing' }),
        ev('planned_night_feed', T0 + 3 * MIN),
        ev('cry_stop', T0 + 4 * MIN, { deleted: true, id: 'ghost-stop' }),
      ],
    });
    const st = timerState(s, p, T0 + 4 * MIN);
    expect(st.phase).toBe('crying');
    expect(st.cryStartedAt).toBe(T0 + MIN);
    expect(st.checkIndex).toBe(1);
  });

  it('a manual end is ended/manual; events after endedAt are ignored', () => {
    const s = session({
      endedAt: T0 + 10 * MIN,
      events: [ev('cry_start', T0 + MIN), ev('cry_start', T0 + 11 * MIN, { id: 'late' })],
    });
    const st = timerState(s, p, T0 + 12 * MIN);
    expect(st.phase).toBe('ended');
    expect(st.endReason).toBe('manual');
    expect(st.crying).toBe(false);
  });
});

describe('merge', () => {
  it('unions events by id and tombstones win', () => {
    const a = [ev('cry_start', T0 + MIN, { id: 'c1', deviceId: 'dev-a' })];
    const b = [
      ev('cry_start', T0 + MIN, { id: 'c1', deviceId: 'dev-a' }),
      ev('cry_stop', T0 + 2 * MIN, { id: 'c2', deviceId: 'dev-b' }),
    ];
    const u = mergeSleepEvents(a, b);
    expect(u.map((e) => e.id)).toEqual(['c1', 'c2']);
    const tomb = mergeSleepEvents(
      [ev('cry_start', T0, { id: 'x' })],
      [ev('cry_start', T0, { id: 'x', deleted: true })],
    );
    expect(tomb).toHaveLength(1);
    expect(tomb[0]!.deleted).toBe(true);
  });

  it('two devices adding different events produce a union and bump updatedAt', () => {
    const a = session({
      updatedAt: T0 + 1,
      deviceId: 'dev-a',
      events: [ev('cry_start', T0 + MIN, { id: 'a1', deviceId: 'dev-a' })],
    });
    const b = session({
      updatedAt: T0 + 2,
      deviceId: 'dev-b',
      events: [ev('cry_stop', T0 + 2 * MIN, { id: 'b1', deviceId: 'dev-b' })],
    });
    const m = mergeSleepSession(a, b);
    expect(m.events.map((e) => e.id).sort()).toEqual(['a1', 'b1']);
    expect(m.updatedAt).toBe(T0 + 3); // max+1 because union added a's event
    expect(m.deviceId).toBe('dev-b');
  });

  it('first-write-wins on putDownAt/asleepAt/endedAt; override is kept when the newer record omitted it', () => {
    const a = session({
      updatedAt: T0 + 1,
      deviceId: 'dev-a',
      putDownAt: T0,
      asleepAt: T0 + 10 * MIN,
      nightNumberOverride: 3,
      events: [],
    });
    const b = session({
      updatedAt: T0 + 5,
      deviceId: 'dev-b',
      putDownAt: T0 + MIN,
      asleepAt: null,
      endedAt: T0 + 20 * MIN,
      events: [ev('note', T0 + 2 * MIN, { id: 'n', text: 'hi' })],
    });
    // b is newer and omitted nightNumberOverride
    delete (b as { nightNumberOverride?: number }).nightNumberOverride;
    const m = mergeSleepSession(a, b);
    expect(m.putDownAt).toBe(T0); // earlier
    expect(m.asleepAt).toBe(T0 + 10 * MIN);
    expect(m.endedAt).toBe(T0 + 20 * MIN);
    expect(m.nightNumberOverride).toBe(3);
    expect(m.events).toHaveLength(1);
  });

  it('an explicit null override on the newer record clears it', () => {
    const a = session({ updatedAt: T0 + 1, nightNumberOverride: 3, events: [] });
    const b = session({ updatedAt: T0 + 2, nightNumberOverride: null, events: [] });
    const m = mergeSleepSession(a, b);
    expect(m.nightNumberOverride).toBeNull();
  });

  it('identical union (already equal to the winner) does not bump the version', () => {
    const events = [ev('cry_start', T0 + MIN, { id: 'c1' })];
    const a = session({ updatedAt: T0 + 5, deviceId: 'dev-b', events });
    const b = session({ updatedAt: T0 + 5, deviceId: 'dev-b', events });
    const m = mergeSleepSession(a, b);
    expect(m.updatedAt).toBe(T0 + 5);
    expect(m.deviceId).toBe('dev-b');
  });
});

describe('metrics + trend', () => {
  const p = plan();

  it('time to fall asleep, crying minutes, checks, wakings', () => {
    const sat3 = new Date(2026, 10, 21, 3, 0).getTime();
    const s = session({
      putDownAt: T0,
      asleepAt: T0 + 12 * MIN,
      events: [
        ev('cry_start', T0 + MIN),
        ev('check_start', T0 + 4 * MIN),
        ev('check_end', T0 + 4 * MIN + 20_000),
        ev('asleep', T0 + 12 * MIN),
        ev('night_waking', sat3),
        ev('cry_start', sat3, { id: 'cry-wake' }),
        ev('cry_stop', sat3 + 2 * MIN),
        ev('asleep', sat3 + 5 * MIN, { id: 'asleep2' }),
      ],
    });
    const now = sat3 + 10 * MIN;
    const m = sessionMetrics(s, p, now);
    expect(m.timeToAsleepMs).toBe(12 * MIN);
    expect(m.checks).toBe(1);
    expect(m.wakings).toBe(1);
    // crying: T+1..T+4 (3 min) + T+4:20..T+12 (7:40) + sat3..sat3+2 (2 min)
    const first = 3 * MIN;
    const second = T0 + 12 * MIN - (T0 + 4 * MIN + 20_000);
    const third = 2 * MIN;
    expect(m.cryingMs).toBe(first + second + third);
    expect(m.date).toBe('2026-11-20');
    expect(m.nightNumber).toBe(1);
  });

  it('an ended night still counts cries and checks up to endedAt', () => {
    // History walks the session after Morning (end) has set endedAt. Events at
    // or before that timestamp must still contribute; only later ones are ignored.
    const endedAt = T0 + 8 * 60 * MIN;
    const s = session({
      putDownAt: T0,
      asleepAt: T0 + 4 * MIN,
      endedAt,
      events: [
        ev('cry_start', T0),
        ev('check_start', T0 + 3 * MIN),
        ev('check_end', T0 + 3 * MIN + 30_000),
        ev('asleep', T0 + 4 * MIN),
        ev('cry_start', endedAt + MIN, { id: 'after-end' }),
        ev('check_start', endedAt + 2 * MIN, { id: 'after-check' }),
        ev('check_end', endedAt + 3 * MIN, { id: 'after-end-check' }),
      ],
    });
    const m = sessionMetrics(s, p, endedAt + 10 * MIN);
    expect(m.checks).toBe(1);
    expect(m.wakings).toBe(0);
    expect(m.timeToAsleepMs).toBe(4 * MIN);
    // crying: T0..T+3 (check start) + T+3:30..T+4 (resume after check until asleep)
    expect(m.cryingMs).toBe(3 * MIN + 30_000);
    const st = timerState(s, p, endedAt + 10 * MIN);
    expect(st.phase).toBe('ended');
    expect(st.endReason).toBe('manual');
  });

  it('open cry counts up to now; trend splits nights and naps and sorts', () => {
    const p0 = plan('2026-11-20');
    const n1 = session({ id: 'n1', events: [ev('cry_start', T0 + MIN)] });
    const napT = new Date(2026, 10, 21, 13, 0).getTime();
    const nap = session({ id: 'nap1', type: 'nap', startedAt: napT, putDownAt: napT, events: [] });
    const n2t = new Date(2026, 10, 21, 20, 0).getTime();
    const n2 = session({ id: 'n2', startedAt: n2t, putDownAt: n2t, asleepAt: n2t + 8 * MIN, events: [] });
    const trend = sleepTrend([n2, nap, n1], p0, n2t + 10 * MIN);
    expect(trend.nights.map((x) => x.sessionId)).toEqual(['n1', 'n2']);
    expect(trend.nights.map((x) => x.nightNumber)).toEqual([1, 2]);
    expect(trend.naps.map((x) => x.sessionId)).toEqual(['nap1']);
    expect(sessionMetrics(n1, p0, T0 + 4 * MIN).cryingMs).toBe(3 * MIN);
  });
});

describe('defaults', () => {
  it('unsavedDefaultPlan uses today and the published table', () => {
    const d = unsavedDefaultPlan(T0);
    expect(d.startDate).toBe('2026-11-20');
    expect(d.wakeCutoffMinutes).toBe(360);
    expect(d.intervals).toHaveLength(7);
    expect(d.intervals[0]).toEqual({ night: 1, firstMin: 3, secondMin: 5, laterMin: 10 });
    expect(d.intervals[6]).toEqual({ night: 7, firstMin: 20, secondMin: 25, laterMin: 30 });
  });
});

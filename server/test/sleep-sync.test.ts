import { describe, expect, it } from 'vitest';
import { defaultSleepPlanFields, SLEEP_PLAN_ID } from '../../src/core/sleep.ts';
import type { SleepPlan, SleepSession } from '../../src/core/types.ts';
import { Household, LIMITS, MemoryHouseholdStorage, validateEntry } from '../src/logic.ts';

const HH = 'h'.repeat(32);
const NOW = new Date(2026, 10, 20, 20, 0, 0).getTime();
const base = { householdId: HH, createdAt: NOW, updatedAt: NOW, deleted: false, loggedBy: { id: 'member-1', name: 'Samir' }, deviceId: 'dev-a' };
const ev = (kind: SleepSession['events'][number]['kind'], at: number, id: string) => ({
  id, kind, at, loggedBy: base.loggedBy, deviceId: 'dev-a',
});
const session = (p: Partial<SleepSession> = {}): SleepSession => ({
  ...base,
  id: p.id ?? 'sess-00000001',
  kind: 'sleep_session',
  type: 'night',
  startedAt: NOW,
  putDownAt: NOW,
  asleepAt: null,
  endedAt: null,
  events: [],
  ...p,
});
const plan = (p: Partial<SleepPlan> = {}): SleepPlan => ({
  ...base,
  id: SLEEP_PLAN_ID,
  kind: 'sleep_plan',
  ...defaultSleepPlanFields('2026-11-20'),
  ...p,
});

function hh() {
  const store = new MemoryHouseholdStorage();
  const h = new Household(store);
  h.init('hash', NOW);
  return { h, store };
}

describe('sleep kinds (additive validation + sync)', () => {
  it('accepts a valid plan and session', () => {
    expect(validateEntry(plan(), HH, NOW)).toBeNull();
    expect(validateEntry(session({ events: [ev('cry_start', NOW, 'event-001')] }), HH, NOW)).toBeNull();
    expect(validateEntry(session({ type: 'nap' }), HH, NOW)).toBeNull();
  });

  it('rejects bad plan / session fields individually', () => {
    expect(validateEntry(plan({ id: 'not-plan' }), HH, NOW)).toBe('sleep plan id mismatch');
    expect(validateEntry(plan({ startDate: '11/20/2026' }), HH, NOW)).toBe('bad startDate');
    expect(validateEntry(plan({ wakeCutoffMinutes: 2000 }), HH, NOW)).toBe('bad wakeCutoffMinutes');
    expect(validateEntry(plan({ intervals: [] }), HH, NOW)).toBe('bad intervals');
    expect(validateEntry(session({ type: 'dusk' as 'night' }), HH, NOW)).toBe('bad sleep type');
    expect(validateEntry(session({ events: [ev('yawn' as 'note', NOW, 'event-001')] }), HH, NOW)).toBe('bad event kind');
    expect(validateEntry(session({ events: [ev('note', NOW, 'event-001')] }), HH, NOW)).toBe('note requires text');
  });

  it('syncs new kinds and union-merges session events from two devices', () => {
    const { h } = hh();
    const p = plan();
    const sA = session({ events: [ev('cry_start', NOW, 'event-aaa1')], updatedAt: NOW, deviceId: 'dev-a' });
    expect(h.sync(HH, { changes: [p, sA] }, NOW).status).toBe(200);
    const sB = session({ events: [ev('note', NOW + 1000, 'event-bbb1',)], updatedAt: NOW + 1, deviceId: 'dev-b' });
    // fix note text
    sB.events[0] = { ...sB.events[0]!, text: 'shushing' };
    const r = h.sync(HH, { since: '0', changes: [sB] }, NOW + 2);
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    const stored = r.body.changes.find((e) => e.kind === 'sleep_session') as SleepSession;
    expect(stored.events.map((e) => e.id).sort()).toEqual(['event-aaa1', 'event-bbb1']);
    expect(stored.updatedAt).toBeGreaterThan(sB.updatedAt); // bumped
    // plan is still there
    expect(r.body.changes.some((e) => e.kind === 'sleep_plan')).toBe(true);
  });

  it('a rejected sleep row does not apply, and other kinds in the batch still do', () => {
    const { h } = hh();
    const ok = { ...base, id: 'bottle-00001', kind: 'bottle' as const, at: NOW, amountOz: 2 };
    const bad = session({ type: 'dusk' as 'night' });
    const r = h.sync(HH, { changes: [ok, bad] }, NOW);
    expect(r.status).toBe(200);
    if (r.status !== 200) return;
    expect(r.body.rejected).toEqual([{ id: bad.id, reason: 'bad sleep type' }]);
    expect(r.body.changes.map((e) => e.kind)).toEqual(['bottle']);
  });

  it('sleep_session may be larger than 8 KB (up to 32 KB); other kinds stay at 8 KB', () => {
    const events = Array.from({ length: 80 }, (_, i) => ({
      ...ev('note', NOW + i, `event-${String(i).padStart(4, '0')}`),
      text: 'x'.repeat(200),
    }));
    const big = session({ events });
    const size = new TextEncoder().encode(JSON.stringify(big)).length;
    expect(size).toBeGreaterThan(LIMITS.maxEntryBytes);
    expect(size).toBeLessThan(LIMITS.maxSleepSessionBytes);
    expect(validateEntry(big, HH, NOW)).toBeNull();
  });
});

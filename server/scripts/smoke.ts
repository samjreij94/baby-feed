/**
 * End-to-end smoke against a running `wrangler dev` (default http://localhost:8787), using the REAL client
 * core (two simulated phones, memory storage). Run from the repo root:
 *   SYNC_URL=http://localhost:8787 npx vite-node server/scripts/smoke.ts
 */
import { activeFeedView } from '../../src/core/feed';
import { FeedCore } from '../../src/core/store';

const BASE = process.env.SYNC_URL ?? 'http://localhost:8787';
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:5173';
let failed = false;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed = true;
};
setTimeout(() => {
  console.error('SMOKE FAIL: timeout');
  process.exit(1);
}, 60_000).unref();

function phone(name: string) {
  let offline = false;
  const core = new FeedCore({
    deviceId: `smoke-${name}-${Math.random().toString(36).slice(2, 8)}`,
    storage: 'memory',
    mirror: false,
    autoSync: false,
    apiBaseUrl: BASE,
    appUrl: 'http://localhost:5173/baby-feed/',
    fetch: (input, init) => {
      if (offline) return Promise.reject(new TypeError('Failed to fetch (simulated offline)'));
      return fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Origin: ORIGIN } });
    },
  });
  return { core, setOffline: (v: boolean) => (offline = v) };
}
const view = (c: FeedCore) => activeFeedView(c.getSnapshot().feeds, c.now());

// 0) origin + auth guards
const evil = await fetch(`${BASE}/api/households`, { method: 'POST', headers: { Origin: 'https://evil.example' } });
ok(evil.status === 403, `disallowed Origin → ${evil.status}`);
const cors = await fetch(`${BASE}/api/sync`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
ok(cors.headers.get('access-control-allow-origin') === ORIGIN, `CORS preflight allows ${ORIGIN}`);

const A = phone('A');
const B = phone('B');

// 1) A creates, B joins with the grouped code
await A.core.createHousehold('Samir');
const code = A.core.inviteCode!;
ok(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/.test(code), `A created household ${A.core.householdId} (code ${code.slice(0, 4)}-…)`);
await B.core.joinHousehold(code, 'Karyn');
ok(B.core.householdId === A.core.householdId, 'B joined with the code');
await A.core.syncNow();
ok(A.core.getSnapshot().members.length === 2 && B.core.getSnapshot().members.length === 2, 'both phones see Samir + Karyn');

// 2) A starts a breast feed → B sees it running after one poll
const f = await A.core.startBreast('L');
await A.core.syncNow();
await B.core.syncNow();
ok(view(B.core).feed?.id === f.id && view(B.core).status === 'running' && view(B.core).currentSide === 'L', 'B sees A’s running feed (L) after one poll');

// 3) B switches side → A sees it
await new Promise((r) => setTimeout(r, 1100));
await B.core.switchSide();
await B.core.syncNow();
await A.core.syncNow();
ok(view(A.core).currentSide === 'R' && view(A.core).feed?.segments.length === 2, 'A sees B’s switch to R');
await A.core.end();
await A.core.syncNow();
await B.core.syncNow();
ok(view(B.core).feed === null && B.core.getSnapshot().feeds[0]?.kind === 'breast', 'end propagates (no active feed on B)');

// 4) both log + edit while B is offline, then converge
const bottle = await A.core.addBottle({ amountOz: 2 });
await A.core.syncNow();
await B.core.syncNow();
B.setOffline(true);
await A.core.editEntry(bottle.id, { amountOz: 3 });
await new Promise((r) => setTimeout(r, 20));
await B.core.editEntry(bottle.id, { amountOz: 4.5, milk: 'formula' }); // later edit → wins
await B.core.addBottle({ amountOz: 1.25 });
await A.core.addBottle({ amountOz: 2.75, milk: 'breast' });
await A.core.syncNow();
await B.core.syncNow();
ok(B.core.getSnapshot().sync.state === 'offline' && B.core.getSnapshot().sync.pending >= 2, `B offline with ${B.core.getSnapshot().sync.pending} pending`);
B.setOffline(false);
await B.core.syncNow();
await A.core.syncNow();
const sig = (c: FeedCore) =>
  JSON.stringify(c.getSnapshot().feeds.map((x) => [x.id, x.updatedAt, x.kind === 'bottle' ? x.amountOz : x.status]).sort());
if (sig(A.core) !== sig(B.core)) console.log(sig(A.core), '\n', sig(B.core));
ok(sig(A.core) === sig(B.core) && A.core.getSnapshot().feeds.length === 4, `converged: ${A.core.getSnapshot().feeds.length} feeds identical on both`);
const merged = A.core.getSnapshot().feeds.find((x) => x.id === bottle.id);
ok(merged?.kind === 'bottle' && merged.amountOz === 4.5, 'LWW kept the later edit (4.5 oz formula)');

// 5) delete propagates
await B.core.deleteEntry(bottle.id);
await B.core.syncNow();
await A.core.syncNow();
ok(!A.core.getSnapshot().feeds.some((x) => x.id === bottle.id), 'delete on B propagates to A');
ok(A.core.getSnapshot().sync.pending === 0 && B.core.getSnapshot().sync.pending === 0, 'outboxes empty');

// 6) bad secret → 401
const bad = await fetch(`${BASE}/api/sync`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${'Z'.repeat(32)}`, Origin: ORIGIN },
  body: JSON.stringify({ since: null, changes: [] }),
});
ok(bad.status === 401, `bad secret → ${bad.status}`);
const badJoin = await fetch(`${BASE}/api/households/join`, { method: 'POST', headers: { Authorization: `Bearer ${'Z'.repeat(32)}`, Origin: ORIGIN } });
ok(badJoin.status === 401, `bad join code → ${badJoin.status}`);
ok(Math.abs(A.core.getSnapshot().sync.clockOffsetMs) < 2000, `clock offset ${A.core.getSnapshot().sync.clockOffsetMs} ms`);

console.log(failed ? 'SMOKE FAIL' : 'SMOKE OK');
process.exit(failed ? 1 : 0);

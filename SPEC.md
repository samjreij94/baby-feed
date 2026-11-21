# Baby Feed — data + sync contract (v1)

Feeding tracker (breast + bottle) shared by two parents' iPhones, with an additive Sleep Training
(Ferber check-and-console) tracker (§8c). Local-first: every action works offline and syncs through a tiny
Cloudflare Worker. **Normative types: `src/core/types.ts`. Public API: `src/core/index.ts`.**
The UI imports only from `src/core`.

Status: phase 2 — IndexedDB persistence + localStorage mirror, outbox sync client, Cloudflare Worker server
(`server/`) all implemented and tested. Phase-1 names/signatures unchanged; additions are marked *(added)*.
§8c Sleep Training is specified; core/server implementation follows this contract.

### Decisions (v1)
- `nextSide` is always the opposite of the last segment's side (no heuristics).
- Two concurrently running feeds (both phones started one offline) are **both kept**; the newest is
  `useActiveFeed().feed`, the rest are in `.others`. Core never auto-ends one; the UI may offer end/discard.
- Member names are free text (≤60 chars). Re-joining with an existing member's name adopts that member.
- Bottle amounts are **oz only** (0.25 steps).

## 1. Entities

Every synced record (`Entry`) has:

| field | type | notes |
| --- | --- | --- |
| `id` | UUID v4 | created on the device, permanent |
| `householdId` | `string \| null` | null until the device creates/joins a household; then stamped on all local entries |
| `createdAt` | ms epoch | core clock (§5) |
| `updatedAt` | ms epoch | core clock; LWW version; strictly increases per entry (§5) |
| `deleted` | boolean | tombstone; synced, never hard-deleted; hidden from hooks/metrics |
| `loggedBy` | `{id, name}` | member who created it (name snapshot) |
| `deviceId` | string | install-random UUID that wrote this version (LWW tie-break) |
| `source?` | `'app' \| 'nara'` | *(added)* origin; absent = app |
| `externalId?` | string ≤128 | *(added)* id in the source system (Nara `_activityKey`) |

`kind` discriminates:

```ts
type Side = 'L' | 'R';
interface Segment { side: Side; startedAt: number; endedAt: number | null } // null = open (running)

interface BreastFeed extends EntryBase {
  kind: 'breast';
  startedAt: number;            // = first segment start; day attribution uses this
  endedAt: number | null;       // null while running/paused
  segments: Segment[];          // ordered, non-overlapping; ≤1 open segment (last, only when running)
  pausedAt: number | null;      // when the current pause began
  status: 'running' | 'paused' | 'ended';
  note?: string;
}
interface BottleFeed extends EntryBase {
  kind: 'bottle'; at: number; amountOz: number /* >0, 0.25 steps, ≤20 */; milk?: 'breast' | 'formula'; note?: string;
}
interface MemberEntry extends EntryBase { kind: 'member'; name: string } // id = member id; renames sync
interface HouseholdEntry extends EntryBase { kind: 'household'; babyName: string } // (added) id = householdId
type Feed = BreastFeed | BottleFeed;
interface WeightEntry extends EntryBase { kind: 'weight'; at: number; grams: number /* integer-ish, 100..30000 */; note?: string } // (added)
interface SleepSession extends EntryBase { kind: 'sleep_session'; /* full type in §8c */ type: 'night' | 'nap'; startedAt: number; putDownAt: number | null; asleepAt: number | null; endedAt: number | null; nightNumberOverride?: number; events: SleepEvent[]; note?: string } // (added)
interface SleepPlan extends EntryBase { kind: 'sleep_plan'; /* full type in §8c */ startDate: string; wakeCutoffMinutes: number; intervals: SleepIntervalRow[] } // (added)
type Entry = Feed | MemberEntry | HouseholdEntry | WeightEntry | SleepSession | SleepPlan;
```

### Household profile / baby name *(added)*
One `HouseholdEntry` per household, `id === householdId` (32 hex, can't collide with a UUID), synced with the same
LWW + outbox as every entry, so a rename on either phone reaches the other within a poll.
- `useHousehold().babyName: string` ('' = not set) and `setBabyName(name)` — **any member** can call it. Trimmed,
  ≤60 chars. `''`/whitespace **clears** it; the clear is a normal newer version, so it syncs and a later rename
  still wins (nothing gets stuck).
- Before a household exists the name is kept on the device (`meta.babyName`) and shown. `createHousehold` uploads
  it. `joinHousehold` pulls first: the household's name wins; the joining phone's pending name is uploaded only
  if the household has none. `leave()` keeps the last name locally.
- Server: validated as `kind 'household'`, `id === householdId`, `babyName` string 0–60. Stored as an ordinary
  entry row (no schema change). **The deployed Worker must be redeployed** before phones can sync it (the old
  build rejects the kind as `bad kind`; the rest of a batch still applies).

### Members
A device picks its member at setup (`setMe(name)`, or the `myName` arg of create/join). Members are synced
`MemberEntry` records, so the household's member list = all member entries (initially "Samir" and "Karyn").
Each device has exactly one `me`. `loggedBy` stores `{id, name}` so old entries still display a name.

## 2. Breast timer state machine
A running timer is just a `BreastFeed` with `status !== 'ended'`; every action writes a new version, so it syncs
like any other entry (the other phone sees it within one poll, ~4 s).

| action | from | effect |
| --- | --- | --- |
| `startBreast(side)` | no active feed | new feed, one open segment on `side`. Throws `ActiveFeedExistsError` if one is active. Optional `{startedAt}` to backdate. |
| `switchSide()` | running | close the open segment, open one on the other side |
| `switchSide()` | paused | resume on the **other** side |
| `pause()` | running | close the open segment, `pausedAt = now`, status paused |
| `resume()` | paused | open a new segment on the **same** side as the last one |
| `end()` | running | close the open segment, `endedAt = now` (never before the open segment's start) |
| `end()` | paused | `endedAt = pausedAt` (the feed really stopped at the pause) |
| `end(id)` *(added)* | running/paused feed `id` | same transition for that feed (e.g. the other phone's feed in `others`); null if no such unended feed |
| `discard()` | running/paused | tombstone the feed (started by mistake) |

Per-side minutes = sum of segment durations per side (open segment counted to now). **Nursing time** = L + R
(pauses excluded). Wall duration = `endedAt - startedAt` (includes pauses; not used by metrics).

Two phones starting a feed at once (offline) can produce two active feeds: the newest by `startedAt` is the
active one; others are in `useActiveFeed().others` so the UI can offer to end/discard them.

## 3. Derived info

### 3.1 Last feed
`lastFeed.feed` = most recent non-deleted feed by start (`startedAt` / `at`), **including a running one**.
`sinceMs` = now − its start. `lastBreast` = most recent breast feed (bottles skipped). `lastSide` = side of the
**last segment** of `lastBreast` (for a running feed: the current side).

### 3.2 Next side suggestion
`nextSide = opposite(lastSide)`, null when there is no breast feed yet. Deliberately simple: no "short feed →
same side" heuristic in v1 (open question).

### 3.3 Metrics (`computeMetrics(feeds, range, now, opts?)` / `useMetrics(range, opts?)` — pure, device local time)
Device local time = JS `Date` local methods (no explicit timezone; the phones are America/Chicago; tests pin TZ).
- `range: MetricsRange`:
  - `number` or `{ days }` — today + the previous `n − 1` local calendar days (original form, 7/14/30). DST-safe.
  - `{ from, to? }` — feeds with `from ≤ start < to`; `to` defaults to the end of today. Days = every local
    calendar day touched by `[from, to)`.
  - `'all'` — first live feed's local day through today (no feeds → no days, zero averages).
- `opts.bucket: 'day' | 'week' | 'month'` (default `'day'`) groups `days` into `buckets`. Weeks start **Monday
  00:00 local**; months are calendar months.
- `opts.maxGapMinutes` — gaps longer than this are excluded from `avgGapMinutes` (headline and per bucket). The UI
  passes 720 (12 h) so overnight / logging holes don't inflate it. **Omitted = every gap counts** (original rule).
- **A feed is attributed entirely to the local day it started on** (a 23:50–00:10 feed counts 20 min on the start day).
- Per day: `breastMinutes`, `minutesBySide {L,R}` (minutes, 0.1 precision), `feeds` (breast + bottle),
  `breastFeeds`, `bottleFeeds`, `bottleOz`, `bottleOzByMilk {breast, formula, unspecified}`.
- `totals`, `perDayAvg` (totals ÷ rangeDays, empty days included), `rangeDays = days.length`, `from`/`to`
  (first local midnight / exclusive end).
- `avgGapMinutes`: mean start-to-start gap between consecutive feeds (breast + bottle) that both start in range,
  gaps > `maxGapMinutes` dropped when set; null if no counted gap.
- `avgFeedMinutes`: mean nursing minutes of **ended** breast feeds in range; null if none.
- `firstFeedAt` *(added)*: start of the earliest live feed overall (not range-limited); null if none.
- `bucket`, `maxGapMinutes` (echo; null = uncapped) and `buckets` *(added)*, oldest → newest, each:
  `{ kind, start, end, key, label, days, fullDays, partial, totals, perDayAvg: {breastMinutes, minutesBySide,
  feeds, bottleOz}, avgGapMinutes }`. `days` = days of the bucket inside the range (the divisor), `partial` =
  `days < fullDays` (never for 'day'). Bucket gaps are tagged with the LATER feed's start (its predecessor may be
  before the range). Labels: `Thu, Oct 8` / `Week of Oct 5` / `October 2026` (year added to day/week labels
  when the range spans years).
- Running/paused feeds count in feeds/gaps and their open segment counts up to `now`; excluded from `avgFeedMinutes`.

## 4. Household + invite
- Create: `POST /api/households` → `{householdId, secret}`.
- The **invite code is the secret**: 160 random bits = 32 Crockford base32 chars (`0-9A-Z` minus I L O U).
  Display grouped in 4s: `K7Q2-9XMB-…` (8 groups). Input is normalized (case-insensitive, dashes/spaces ignored,
  I/L→1, O→0).
- **Invite link**: `${appUrl}#join=<code>` with the ungrouped code, e.g.
  `https://samjreij94.github.io/baby-feed/#join=K7Q29XMB…`. The hash never reaches a server.
  `readInviteFromLocation()` returns the code when the app is opened from a link (UI then asks for "your name" and calls `joinHousehold`).
- `householdId` = first 16 bytes of SHA-256(secret) as hex, so the server can route any secret to its Durable
  Object; the DO stores only SHA-256(secret) and checks it in constant time.
- Join: `POST /api/households/join` with `Authorization: Bearer <secret>` (a JSON body `{secret}` also works)
  → `{householdId, members: Member[]}`; **401** for an unknown/malformed code. Then a full pull (`since: null`).
- Local entries created before create/join are stamped with the `householdId` and pushed (so either phone can
  start offline). `leave()` only forgets the household locally.
- Auth for every later call: `Authorization: Bearer <secret>`. No accounts.

## 5. Sync protocol
**Local-first.** IndexedDB (idb-keyval, DB `baby-feed`, store `kv`) holds `meta` (deviceId, me, householdId,
secret, cursor, clockOffsetMs, lastSyncedAt), `e:<id>` entries and `o:<id>` outbox markers (latest local version
per id only, so repeated timer edits coalesce). Writes are batched (setTimeout 0) and flushed on
`pagehide`/hidden. A **synchronous localStorage mirror** (`baby-feed:v1:mirror`) holds the meta + running/paused
feeds + locally written entries not yet confirmed in IndexedDB; it is read synchronously at startup (so identity
and a running timer show before IndexedDB loads — `snapshot.ready` / `useCoreReady()` turn true after) and merged
by LWW (mirror-only local versions are re-queued). The cursor is persisted only after the pulled entries are.

`POST /api/sync` (Bearer secret):
```ts
request:  { since: string | null, changes: Entry[] /* ≤500 and ≤192 KB from the client */, deviceId: string }
response: { changes: Entry[], cursor: string, hasMore: boolean, serverNow: number,
            rejected: { id: string, reason: string }[] }
```
- Server applies each change with **LWW** and assigns a monotonic sequence number to every stored version that
  wins. The response contains every row with seq > `since` (may echo our own writes; harmless), max 500 per page;
  `hasMore` → call again immediately. `cursor` is opaque (the last seq).
- Outbox items are removed only after a 200 response whose request contained them (and whose version is still
  the latest local one). Rejected items are dropped from the outbox and reported in `useSync().error`.
- **LWW rule (client and server identical):** compare `(updatedAt, deviceId)` lexicographically; greater wins;
  equal = same version. Per entry, whole-record (no field merge). Tombstones are ordinary versions, so a delete
  wins over an older edit and loses to a newer one. **Exception *(added)*:** `sleep_session` union-merges
  events and applies the scalar-field rules in §8c (so two phones logging the same night cannot drop events).
  `sleep_plan` stays whole-record LWW.
- **updatedAt** = `max(coreNow, previous.updatedAt + 1)`, so an edit always beats the version it was made from,
  even if this phone's clock is behind. LWW therefore runs on (offset-corrected) device clocks; acceptable for two
  users editing rarely-overlapping records.
- **Clock skew:** each sync estimates `offset = serverNow − (t0 + t1)/2` (t0/t1 = request send/receive device
  times), smoothed and clamped to ±24 h, persisted. Core clock = `Date.now() + offset` and is used for every
  timestamp the core writes and for live timer display (`useActiveFeed`, `useLastFeed`). Result: a feed Karyn
  starts shows the same elapsed time on Samir's phone even if their clocks differ. Offline/never-synced: offset 0
  (or last known).
- **Polling:** every 4 s while `document.visibilityState === 'visible'` and online; immediately (debounced 300 ms)
  after any local change; once on `visibilitychange → visible` and on `online`. Stops when hidden. On errors,
  exponential backoff 5 s → 60 s with ±20 % jitter. 401 on sync = code no longer valid → `state 'error'`.
  A request loops (up to 50 rounds) while `hasMore` or the outbox still has entries (e.g. after a big import).
- `useSync().state`: `'idle'` (up to date or no household) | `'syncing'` | `'offline'` (navigator offline or
  network failure; outbox keeps growing) | `'error'` (server rejected / auth). `pending` = outbox size.

## 6. Server (`server/`)
Cloudflare Worker + **one Durable Object per household** (SQLite-backed storage, `new_sqlite_classes`), patterned
on `/workspace/poker-coach/server`:
- Routes: `POST /api/households`, `POST /api/households/join`, `POST /api/sync`, `GET /health`, CORS preflight.
- DO name = `householdId`. Tables: `meta(secret_hash, created_at, seq)`, `entries(id PK, seq, updated_at,
  device_id, deleted, json)` + index on seq. Validation: JSON shape, `householdId` matches, kind-specific checks,
  size limit (~8 KB per entry, 500 per request, 256 KB body).
- CORS allow-list `ALLOWED_ORIGINS` in `wrangler.jsonc`: `https://samjreij94.github.io` + localhost/127.0.0.1 on
  5173 (vite dev) and 4173 (vite preview). Requests without Origin allowed (curl/tests). Headers allowed:
  `Content-Type, Authorization`.
- Best-effort per-IP fixed-window rate limit (per isolate): create 10/min, join 30/min, sync 300/min; 429 + `Retry-After: 60`.
- Code layout: `server/src/logic.ts` (pure: validation, LWW, cursor paging, `Household` over a `HouseholdStorage`),
  `server/src/app.ts` (pure Fetch-API router + `createMemoryServer()` used by the client tests),
  `server/src/index.ts` (Worker + `HouseholdDO` with a SQLite `HouseholdStorage`; RPC methods create/join/sync).
- Validation per entry: id `[A-Za-z0-9-]{8,64}`, matching householdId, finite timestamps, `updatedAt` ≤ server
  now + 24 h, loggedBy/deviceId strings, note ≤1000, source/externalId, kind-specific checks (segments
  consistent with status, amountOz 0.25 steps ≤20, milk enum, member name ≤60, household record id =
  householdId and babyName 0–60, plus the additive `sleep_session` / `sleep_plan` checks in §8c), ≤8 KB
  serialized (32 KB for `sleep_session`, which may hold up to 200 events). Invalid
  entries are returned in `rejected` (the rest of the batch is applied). Body ≤256 KB (413), ≤500 changes (413).
- No secrets in logs.

## 7. Config, local dev, deploy
- App: `VITE_API_BASE_URL` (no trailing slash). Default `http://localhost:8787` (wrangler dev). Prod value set
  at build time once the Worker URL exists (e.g. `https://baby-feed-sync.<account>.workers.dev`).
- Local end-to-end: `cd server && npm run dev` (`wrangler dev --local --port 8787`, Node 22 at
  `~/.local/node-v22.23.3-linux-x64/bin`), `npm run dev` for the app, two browser profiles = two phones.
  `npm --prefix server run smoke` runs two simulated phones (real core) against the running server.
- Deploy steps live in `server/README.md` (needs a Cloudflare API token; not available yet).
- App deploy: `npm run deploy` (gh-pages, base `/baby-feed/`) to `samjreij94/baby-feed` — not pushed yet.

## 8. Additive API (phase 2)
- `useCoreReady(): boolean` — IndexedDB loaded (snapshot `ready`).
- `useFeedActions()` also has `importEntries`.
- `FeedCore`: `ready: Promise<void>`, `flush()`, `syncNow()`, `startAutoSync()`, `dispose()`, `allEntries()`,
  `importEntries()`. `CoreOptions`: `storage ('idb'|'memory'|KvStorage)`, `dbName`, `mirror`, `mirrorKey`,
  `fetch`, `autoSync`, `pollMs`, `debounceMs`. Tests: `new FeedCore({ storage: 'memory', mirror: false, autoSync: false })`.
- Exports: `createMemoryStorage`, `createIdbStorage`, `NetworkError`, `HttpError`, types `ImportResult`,
  `NaraImportHook`, `NaraImportPreview`, `NaraImportStatus`.
- `JoinHouseholdResponse.members`.
- `useHousehold().babyName` / `setBabyName(name)`; `snapshot.babyName`; `FeedCore.setBabyName()` (§1).
- `useActiveFeed().end(id?)` / `FeedCore.end(id?)` (§2).
- `computeMetrics`/`useMetrics` range + options, `startOfLocalWeek`, `startOfLocalMonth` (§3.3).

## 8b. Weight (additive)
- New `kind: 'weight'` (`WeightEntry`, §1). Same LWW/tombstone sync as feeds; the server's `entries` table stores any
  kind in its `json` column, so there is **no schema change or migration**. `validateEntry` accepts `weight` with numeric
  `at` and `grams` 100..30000; a bad weight is rejected individually (`rejected[]`) without affecting the rest of a batch.
- Deploy order: **Worker first, then the app** (an older worker would reject `weight` as `bad kind`). Older cached
  clients ignore unknown kinds, so feeds keep working on phones that have not updated.
- Weights are stored as grams; lb/oz and kg are display/input conversions only (`src/core/weight.ts`). Weights are
  never part of `feeds`, `useMetrics`, or Nara import. `CoreSnapshot.weights` (non-deleted, newest first).
- API: `useWeights()`, `useWeightActions()` → `addWeight({grams, at?, note?})`, `editWeight(id, {grams?, at?, note?})`,
  `deleteEntry(id)` (tombstone, same as feeds). `FeedCore.addWeight/editWeight`.
- Growth data: `src/core/who-wfa-girls.ts` and `src/core/who-wfa-boys.ts` = WHO Child Growth Standards weight-for-age, girls / boys, days 0–730 (percentile
  3/15/50/85/97 and L/M/S), copied verbatim from WHO's published expanded tables
  (https://www.who.int/tools/child-growth-standards/standards/weight-for-age). Percentile of a logged weight is
  estimated with the LMS formula `z = ((w/M)^L − 1)/(L·S)`, labelled "est." in the UI.
  A Girls/Boys toggle on the Weight screen (device-local pref `bf.ui.whoSex.v1`, default girls) picks the standard for the
  chart lines, the percentile estimates and the citation text; it never changes stored data.

## 9. Nara import
Pure parser `src/core/import/nara.ts` (separate module, lazy-loaded): `parseNaraCsv(text, {me, members,
caregiverMap?, deviceId, householdId}) → {preview, entries: Feed[]}` with deterministic ids (UUID v5 of Nara's
`_activityKey`), `source: 'nara'`, `externalId`.

- `importEntries(entries: Feed[]): Promise<{added, skippedExisting, skippedDeleted, invalid}>` — inserts only ids
  not present locally (never overwrites a local edit, never resurrects a tombstone), stamps the current
  `householdId` when joined, keeps the given version (`updatedAt`/`deviceId`), validates (invalid → `invalid`),
  queues everything in the outbox, persists in ONE IndexedDB batch (1,000 entries ≪ 1 s), then syncs in
  ≤500-entry / ≤192 KB requests. Re-importing on either phone is idempotent (same ids → `skippedExisting`).
- `useNaraImport()` → `{status: 'idle'|'parsing'|'ready'|'importing'|'done'|'error', preview, error, result,
  parseFile(file), confirm(caregiverMap?), reset()}`. `parseFile` reads + parses (dynamic `import('./import/nara')`,
  so it's a separate chunk); `confirm(map)` re-parses with the caregiver → member map if given, then
  `importEntries`; `result` is the ImportResult.

## 8c. Sleep Training (Ferber check-and-console, additive)

A night/nap check-and-console tracker shared by both phones. **Additive only:** new kinds `sleep_session` and
`sleep_plan`. Existing entries, feeds, weights, household and member records are never deleted, rewritten, or
re-keyed. Sleep data is not part of `feeds`, `useMetrics`, or Nara import. Older cached clients ignore unknown
kinds (snapshot hooks only list kinds they know), so feeds keep working on phones that have not updated. An
older Worker rejects the new kinds as `bad kind` (the rest of a batch still applies) — **deploy the Worker
first, then the app**, same order as §8b, using the README backup / `--verify` steps. Do not deploy to
production until QC passes.

Normative implementation: `src/core/sleep.ts` (pure: timer, merge, night number, metrics). Store/hooks in
`src/core/store.ts` / `src/core/hooks.ts`. Server validation + merge + alarm scheduling in `server/src/logic.ts`
(the DO already re-plans its alarm after every sync with changes; extend `nextAlertAt` / `runAlerts`). The UI
imports only from `src/core`.

### 8c.1 `SleepPlan` (synced settings)

One record per household, `id === 'sleep-plan'` (`SLEEP_PLAN_ID`; matches the existing id regex, cannot collide
with a UUID). Same LWW + outbox as any entry (whole-record, like `HouseholdEntry`). Created on first
`setSleepPlan` / first `startSleepSession` if none exists; until then hooks expose the defaults below without
writing.

```ts
interface SleepIntervalRow { night: number; firstMin: number; secondMin: number; laterMin: number }
interface SleepPlan extends EntryBase {
  kind: 'sleep_plan';
  startDate: string;            // 'YYYY-MM-DD' local; Night 1 begins this evening
  wakeCutoffMinutes: number;    // minutes from local midnight; default 360 (6:00 AM)
  intervals: SleepIntervalRow[]; // exactly 7 rows, nights 1–7; row 7 is N7+
}
```

Default interval table (minutes, 1st / 2nd / each later check), editable:

| Night | 1st | 2nd | later |
| --- | --- | --- | --- |
| N1 | 3 | 5 | 10 |
| N2 | 5 | 10 | 12 |
| N3 | 10 | 12 | 15 |
| N4 | 12 | 15 | 17 |
| N5 | 15 | 17 | 20 |
| N6 | 17 | 20 | 25 |
| N7+ | 20 | 25 | 30 |

`DEFAULT_WAKE_CUTOFF_MINUTES = 360`. `NAP_CAP_MS = 60 * 60_000` (fixed in v1, not a plan field). Validation:
`startDate` `YYYY-MM-DD`, `wakeCutoffMinutes` integer 0–1439, `intervals` length 7 with `night` 1–7 unique,
each minute value finite and in 0–180. A bad plan is rejected individually (`rejected[]`).

Device local time = JS `Date` local methods (no explicit timezone; the phones are America/Chicago; tests pin
TZ), same as §3.3. Helpers reuse `localDateKey` / `startOfLocalDay` / `addLocalDays`.

### 8c.2 `SleepSession` + events

```ts
type SleepSessionType = 'night' | 'nap';
type SleepEventKind =
  | 'cry_start' | 'cry_stop' | 'check_start' | 'check_end'
  | 'night_waking' | 'planned_night_feed' | 'note' | 'asleep';

interface SleepEvent {
  id: UUID;                     // created on the device; permanent
  kind: SleepEventKind;
  at: EpochMs;                  // core clock
  loggedBy: MemberRef;          // author snapshot
  deviceId: string;             // install that created this event
  deleted?: boolean;            // event tombstone; hidden from timer/metrics
  text?: string;                // required for `note`, optional otherwise; ≤1000
}

interface SleepSession extends EntryBase {
  kind: 'sleep_session';
  type: SleepSessionType;
  startedAt: EpochMs;
  putDownAt: EpochMs | null;    // in the crib; time-to-asleep starts here
  asleepAt: EpochMs | null;     // FIRST sleep only (for metrics); later falls-asleep are `asleep` events
  endedAt: EpochMs | null;      // null while the session is open
  nightNumberOverride?: number; // if set (≥1), used instead of the date-computed night number
  events: SleepEvent[];         // append-only log; union-merged (§8c.3)
  note?: string;
}
```

`asleep` is a first-class event so a later resettling after a night waking has a log entry; the first `asleep`
also sets `asleepAt` if it is still null. `planned_night_feed` and `note` are informational and do not affect
`timerState`. Max 200 events (`MAX_SLEEP_EVENTS`). Serialized size ≤32 KB for this kind only (`LIMITS.maxEntryBytes`
stays 8 KB for every other kind). Session tombstones use `deleted` on the entry, same as feeds (`deleteEntry` /
`discardSleepSession`).

### 8c.3 Merge (exception to whole-record LWW)

Two phones will log events on the same session at once, so a whole-record LWW would drop events. Client and
server use the same `mergeSleepSession(a, b)` (and `mergeSleepEvents`):

- **Events:** union by `id`. An event payload is immutable after create. If the same id appears on both sides,
  `deleted` is `true` if either copy is tombstoned; other fields come from either copy (they were identical at
  create). Sort the result by `(at, id)`. Events are never removed from the array (tombstones stay).
- **Scalars:** `startedAt` / `putDownAt` / `asleepAt` / `endedAt` — earliest non-null wins (first write of that
  instant). `type` — first non-missing wins (it should not change). `nightNumberOverride` — if the
  LWW-newer record has the property present (including an explicit `null` used to clear it), take
  the newer value; if the newer record omitted the property, keep the older override. Implementation must
  **spread** the previous session when appending events so an event-only write cannot drop an override.
  `note` — LWW (newer record).
- **EntryBase / tombstone:** `deleted`, `loggedBy`, `updatedAt`, `deviceId` start from the LWW-newer record
  (`compareVersion`, §5). A later edit still beats an older tombstone; a later tombstone still beats an older
  edit.
- **Version bump:** if the merged payload is not equal to the LWW winner (the loser contributed events or a
  first-write scalar), set `updatedAt = max(a.updatedAt, b.updatedAt) + 1` and `deviceId` to the incoming
  writer's, then assign a new server seq. This is required so a client that already has the winner's version
  tuple still pulls the extra events. If the merge equals the winner, keep the winner's version (normal LWW).

`sleep_plan` is whole-record LWW (settings are edited rarely). Open sleep sessions and the plan are included in
the synchronous localStorage mirror, like running/paused feeds, so a mid-night reload still shows the timer
before IndexedDB finishes.

### 8c.4 Night number and the 6:00 AM cutoff

`nightNumber(session, plan): number`

- If `session.nightNumberOverride` is a finite number ≥ 1, use `Math.floor` of that (no upper clamp in display;
  plan intervals above 7 use the N7+ row).
- Otherwise, take an attribution date `YYYY-MM-DD`:
  - **Nap:** local calendar date of `startedAt`.
  - **Night:** local calendar date of `putDownAt ?? startedAt`, **minus one day if the local clock at that
    instant is before `wakeCutoffMinutes`** (a 1:00 AM start belongs to last night). That date is the
    "evening date" of the night (`sessionNightDate`).
- `nightNumber = max(1, 1 + calendarDays(plan.startDate, attributionDate))`. If the plan has no `startDate`
  yet, return 1. Sessions before the plan start also clamp to 1.

`wakeCutoffAt(plan, nightDate)` = local midnight of `nightDate + 1 day`, plus `wakeCutoffMinutes` (DST-safe via
`addLocalDays`). For a Friday-night session the cutoff is Saturday 06:00 local (with the default).

`isMorningWake(plan, session, at)` is true only for `type === 'night'` when `at >= wakeCutoffAt(plan,
sessionNightDate(session, plan))`. A waking **before** the cutoff is a night waking (restart the sequence at
the first check). A waking **at or after** the cutoff ends the session (`endReason: 'morning'`). Naps never
auto-end at the cutoff.

The first session of a new plan, if no plan row exists yet, persists a plan with `startDate` equal to that
session's attribution date and the default table / cutoff.

### 8c.5 `timerState(session, plan, now)` — pure, testable

```ts
type SleepTimerPhase =
  | 'pre_putdown'  // started, not yet put down
  | 'quiet'        // in the crib, not crying, not in a check, not asleep
  | 'crying'       // wait is accumulating
  | 'checking'     // parent in the room (check_start without check_end)
  | 'asleep'
  | 'nap_capped'   // nap attempt reached 60 min without falling asleep
  | 'ended';

type SleepEndReason = 'manual' | 'morning';

interface SleepTimerState {
  phase: SleepTimerPhase;
  nightNumber: number;
  checkIndex: number;          // 1-based: 1 before the first check, 2 after first check_end, …
  intervalMs: number;          // target wait for checkIndex from the plan table (0 when not in a wait cycle)
  elapsedMs: number;           // wait accumulated in the current continuous cry; 0 when not crying
  remainingMs: number;         // max(0, intervalMs - elapsedMs) when crying, else 0
  dueAt: EpochMs | null;       // cryStartedAt + intervalMs when accumulating, else null
  cryStartedAt: EpochMs | null;
  attemptStartedAt: EpochMs | null; // put-down, or the last night waking / implicit wake
  napCapDueAt: EpochMs | null;      // attemptStartedAt + NAP_CAP_MS for an in-progress nap; else null
  endReason: SleepEndReason | null;
  crying: boolean;             // phase === 'crying'
}
```

`intervalForCheck(plan, nightNumber, checkIndex)`: pick the row `min(nightNumber, 7)`; index 1 → `firstMin`,
2 → `secondMin`, 3+ → `laterMin`; return minutes × 60_000.

Walk the session in this exact order (ignore `event.deleted`, ignore `at > now` or `at` after `endedAt`, sort
by `(at, id)`):

1. Start from `putDownAt` / `asleepAt` / `endedAt` on the session. `checkIndex = 1`, not crying, not in a check,
   not asleep, `attemptStartedAt = putDownAt`. If `asleepAt != null` and no later waking has been walked yet,
   treat her as asleep from `asleepAt` (the first `asleep` event, if present, coincides with this).
2. **`night_waking`**, or **`cry_start` while currently asleep** (implicit waking): if `isMorningWake` at
   `event.at`, the session ends at that instant (`phase: 'ended'`, `endReason: 'morning'`). Otherwise clear
   asleep, `checkIndex = 1`, not in a check, not crying yet, `attemptStartedAt = event.at`. A `cry_start` that
   was the implicit wake then also begins crying (step 3) in the same instant.
3. **`cry_start`** (and not already crying, and not `inCheck`): `crying = true`, `cryStartedAt = event.at`.
   Duplicate `cry_start` while already crying is a no-op (keep the original `cryStartedAt`).
4. **`cry_stop`:** `crying = false`, `cryStartedAt = null`. The wait **resets**. `checkIndex` is unchanged: the
   next `cry_start` restarts the **same** check from its **full** interval.
5. **`check_start`:** if not already `inCheck`, enter `checking`, remember `wasCrying` at this instant, then
   `crying = false`, `cryStartedAt = null`. (The parent is in the room; the wait does not run.) An extra
   `check_start` while already checking is a no-op. A `check_start` with no preceding cry is allowed (early
   peek) and still completes a check on `check_end`.
6. **`check_end`:** if `inCheck`, leave the check and increment `checkIndex` by 1 (the next interval). **The
   next interval starts at `check_end`.** If `wasCrying` (she was crying when the check began, and no `cry_stop`
   happened during the check), set `crying = true` and `cryStartedAt = event.at` so the new interval begins
   accumulating immediately. If she was quiet, stay quiet until the next `cry_start`, which then uses the new
   (full) interval. A `check_end` without a matching `check_start` is a no-op (do not increment).
7. **`asleep`:** `asleep = true`, not crying, not in a check, `cryStartedAt = null`.
8. **`planned_night_feed`** and **`note`:** no timer effect.
9. After the walk, if `session.endedAt != null` and `session.endedAt <= now`, `phase = 'ended'` and
   `endReason = 'morning'` if that `endedAt` matches a morning wake, else `'manual'`.

Then pick `phase` at `now` (first match): `ended` → `asleep` → (`nap` and not asleep and `attemptStartedAt` set
and `now - attemptStartedAt >= NAP_CAP_MS` → `nap_capped`) → no `putDownAt` → `checking` → `crying` → `quiet`.

While `phase === 'crying'`, `elapsedMs = now - cryStartedAt`, `remainingMs = max(0, intervalMs - elapsedMs)`,
`dueAt = cryStartedAt + intervalMs` (may be in the past if the parent hasn't opened the door yet). In every
other phase `elapsedMs = remainingMs = 0` and `dueAt = null`. The wait **only** accumulates during one
continuous cry; quiet gaps are not summed, and a `cry_stop` before `dueAt` wipes the elapsed time.

The 60-minute nap cap is per settling **attempt** (from `putDownAt`, or from a later waking on a nap), wall
clock, and does not auto-write `endedAt`. `napCapDueAt` is set whenever a nap attempt is in progress and she is
not asleep; once capped, `dueAt` stays null (no more check-in wait). A subsequent nap waking starts a new
60-minute attempt.

**Worked example (Night 1 = 3/5/10).** Start + put-down at T+0 → `quiet`, `checkIndex = 1`, `intervalMs = 3 min`,
`dueAt = null`. `cry_start` at T+0:30 → `crying`, `dueAt = T+3:30`. `cry_stop` at T+1:30 → `quiet`, same
`checkIndex`, `dueAt = null`. `cry_start` at T+2:00 → `crying`, `dueAt = T+5:00` (full 3 min restarts).
`check_start` at T+5:00, `check_end` at T+5:20 (still crying) → `crying`, `checkIndex = 2`, `intervalMs = 5 min`,
`dueAt = T+10:20` (starts at `check_end`). Mark asleep at T+12:00 → `asleep`. `cry_start` at 3:00 AM (before
cutoff) → implicit night waking, `checkIndex = 1`, 3 min wait. `cry_start` at 6:30 AM after she had been asleep
→ `ended`, `endReason: 'morning'`.

### 8c.6 Metrics

Pure `sessionMetrics(session, plan, now)` and `sleepTrend(sessions, plan, now)`:

```ts
interface SleepSessionMetrics {
  sessionId: UUID;
  type: SleepSessionType;
  nightNumber: number;
  date: string;                 // attribution date, 'YYYY-MM-DD'
  startedAt: EpochMs;
  putDownAt: EpochMs | null;
  asleepAt: EpochMs | null;
  endedAt: EpochMs | null;
  timeToAsleepMs: number | null; // putDownAt → first asleepAt; null if not yet asleep
  cryingMs: number;              // sum of continuous cry stretches (open cry to min(now, endedAt))
  checks: number;                // completed checks = number of effective check_end events
  wakings: number;               // night wakings after first sleep (explicit + implicit, de-duped)
}
interface SleepTrend {
  nights: SleepSessionMetrics[]; // type 'night', oldest nightNumber then startedAt
  naps: SleepSessionMetrics[];   // oldest first
}
```

Crying stretches use the same rules as the timer: a stretch starts at `cry_start` (or at `check_end` when the
wait resumes immediately) and ends at `cry_stop`, `check_start`, `asleep`, or the session end / `now`. Time
in the room during a check is **not** crying. Wakings: count `night_waking` events after `asleepAt`, plus
`cry_start` events that occurred while she was asleep, without double-counting a `night_waking` and a
`cry_start` at the same instant (same `at`, or a `cry_start` with no non-wake event in between). Trend is the
per-session lists — the UI can plot time-to-asleep, crying minutes, checks and wakings against `nightNumber`.

Deleted sessions and deleted events are excluded. An open session still reports live `cryingMs` up to `now`.

### 8c.7 Web push (optional, same DO alarm pattern)

Reuses the existing `push_subs` table and Settings "reminders" subscription (same VAPID, same
`/api/push/subscribe`). Both phones should buzz, so a due sleep alert is sent to **every** household
subscription, not only the member who started the session (unlike "Still feeding?", which targets the feeder).

- Extend `Household.nextAlertAt` / `runAlerts` (and the DO `schedule()` already called after a sync with
  changes) so the next alarm is the **minimum** of the existing still-feeding reminder times and every open
  session's `timerState(...).dueAt` (and, if desired, `napCapDueAt`). If that minimum is `null`,
  `deleteAlarm()` — this is how a `cry_stop` (or `asleep` / `end` / morning end) **cancels** a pending check-in
  push. A later `cry_start` reschedules from the new `dueAt`.
- Dedup with an additive `sleep_alerts` table (do not touch `entries`): key `(session_id, check_index,
  cry_started_at)` so a reset + new cry of the same check can notify again, but a repeated alarm does not.
  After sending, store the key; 404/410 still deletes the subscription.
- **Payload.** Today's "Still feeding?" pushes are payload-less and `public/push-sw.js` always shows that copy.
  Sleep alerts need a different title, so the Worker gains a small encrypted payload (`aes128gcm`)
  `{ type: 'still_feeding' | 'sleep_check' | 'sleep_nap_cap', sessionId?: string }`. The service worker
  branches on `event.data`; a missing/unknown type keeps the current "Still feeding?" notification (old SW
  also ignores the payload and may briefly show the feeding copy for a sleep alert until that phone updates).
  Suggested copy: "Time to check in" / "The wait is over. Look in, comfort briefly, then leave." Tag
  `bf-sleep-check`. The in-app UI can also prompt from `timerState.dueAt` while foregrounded, the same way
  `StillFeedingPrompt` covers a running feed.

### 8c.8 API surface (Graphics)

Types and pure functions are exported from `src/core` (`src/core/sleep.ts` + `types.ts`). Hooks tick on the
core clock (`useNow`).

```ts
// Pure
timerState(session, plan, now): SleepTimerState
nightNumber(session, plan): number
sessionNightDate(session, plan): string
wakeCutoffAt(plan, nightDate): EpochMs
isMorningWake(plan, session, at): boolean
intervalForCheck(plan, nightNumber, checkIndex): number
sessionMetrics(session, plan, now): SleepSessionMetrics
sleepTrend(sessions, plan, now): SleepTrend
mergeSleepSession(a, b): SleepSession
mergeSleepEvents(a, b): SleepEvent[]
defaultSleepIntervals(): SleepIntervalRow[]
defaultSleepPlanFields(startDate: string): Pick<SleepPlan, 'startDate' | 'wakeCutoffMinutes' | 'intervals'>

// Store (also on FeedCore)
startSleepSession(input: { type: SleepSessionType; startedAt?: EpochMs; putDownAt?: EpochMs }): Promise<SleepSession>
setPutDown(id: string, at?: EpochMs): Promise<SleepSession>
markAsleep(id: string, at?: EpochMs): Promise<SleepSession>          // first write sets asleepAt; always appends `asleep`
endSleepSession(id: string, at?: EpochMs): Promise<SleepSession>
discardSleepSession(id: string): Promise<void>                       // tombstone the session
addSleepEvent(id: string, kind: SleepEventKind, opts?: { at?: EpochMs; text?: string }): Promise<SleepSession>
deleteSleepEvent(sessionId: string, eventId: string): Promise<SleepSession> // event tombstone
setNightNumberOverride(id: string, n: number | null): Promise<SleepSession> // null clears
editSleepSession(id: string, patch: Partial<Pick<SleepSession, 'startedAt' | 'putDownAt' | 'asleepAt' | 'endedAt' | 'type' | 'note' | 'nightNumberOverride'>>): Promise<SleepSession>
setSleepPlan(patch: Partial<Pick<SleepPlan, 'startDate' | 'wakeCutoffMinutes' | 'intervals'>>): Promise<SleepPlan>
resetSleepIntervals(): Promise<SleepPlan>                            // default table, keeps startDate/cutoff

// Hooks
useSleepPlan(): {
  plan: SleepPlan;               // stored record, or a non-persisted default (startDate = today) if none
  saved: boolean;
  setPlan(patch): Promise<SleepPlan>;
  resetIntervals(): Promise<SleepPlan>;
}
useSleepSessions(range?: FeedRange): SleepSession[]   // non-deleted, newest startedAt first
useActiveSleepSession(): {
  session: SleepSession | null;  // newest open session (endedAt == null); others[] if two phones started one
  others: SleepSession[];
  timer: SleepTimerState | null; // timerState(session, plan, now), ticks every 1 s
  startSleepSession, setPutDown, markAsleep, endSleepSession, discardSleepSession,
  addSleepEvent, deleteSleepEvent, setNightNumberOverride;
}
useSleepTimer(sessionId: string, intervalMs?: number): SleepTimerState | null
useSleepMetrics(range?: FeedRange): { sessions: SleepSessionMetrics[]; trend: SleepTrend }
```

Action rules: timestamps use the core clock; `at` defaults to `now` and must not be in the future.
`addSleepEvent('cry_start' | 'night_waking')` after she is asleep, when `isMorningWake` is true, also writes
`endedAt = at`. `markAsleep` / `setPutDown` / `endSleepSession` are no-ops (return the current row) when the
session is already ended or missing. Two concurrently open sessions (both phones started one offline) are both
kept; the newest by `startedAt` is `useActiveSleepSession().session`, the rest are in `.others`, matching
`useActiveFeed`. `deleteEntry(id)` tombstones a session or plan like any other entry (the plan can be recreated).

`CoreSnapshot` gains `sleepSessions: SleepSession[]` (non-deleted, newest first) and `sleepPlan: SleepPlan | null`
(the stored record only; hooks fill in defaults).

Suggested UI actions (layout is up to Graphics): Start night / Start nap, Put down, Crying / Stopped crying,
Check in / I'm leaving, She's asleep, Night waking, Planned feed, Note, End; show `nightNumber` (editable
override), `checkIndex`, countdown from `remainingMs`, and the §8c.6 trend. Plan settings: start date, 6:00 AM
cutoff, editable interval table, reset to defaults. Reminders reuse the existing Settings toggle.

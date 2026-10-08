# Baby Feed — data + sync contract (v1)

Feedings-only tracker (breast + bottle) shared by two parents' iPhones. Local-first: every action works offline
and syncs through a tiny Cloudflare Worker. **Normative types: `src/core/types.ts`. Public API: `src/core/index.ts`.**
The UI imports only from `src/core`.

Status: phase 2 — IndexedDB persistence + localStorage mirror, outbox sync client, Cloudflare Worker server
(`server/`) all implemented and tested. Phase-1 names/signatures unchanged; additions are marked *(added)*.

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
type Feed = BreastFeed | BottleFeed;
type Entry = Feed | MemberEntry;
```

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
| `end()` | running | close the open segment, `endedAt = now` |
| `end()` | paused | `endedAt = pausedAt` (the feed really stopped at the pause) |
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

### 3.3 Metrics (`computeMetrics(feeds, rangeDays, now)` — pure, device local time)
- Range = today + the previous `rangeDays − 1` local calendar days (7/14/30). DST-safe.
- **A feed is attributed entirely to the local day it started on** (a 23:50–00:10 feed counts 20 min on the start day).
- Per day: `breastMinutes`, `minutesBySide {L,R}` (minutes, 0.1 precision), `feeds` (breast + bottle),
  `breastFeeds`, `bottleFeeds`, `bottleOz`, `bottleOzByMilk {breast, formula, unspecified}`.
- `totals`, `perDayAvg` (totals ÷ rangeDays, empty days included).
- `avgGapMinutes`: mean start-to-start gap between consecutive feeds (breast + bottle) in range; null if < 2.
- `avgFeedMinutes`: mean nursing minutes of **ended** breast feeds in range; null if none.
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
  wins over an older edit and loses to a newer one.
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
  consistent with status, amountOz 0.25 steps ≤20, milk enum, member name ≤60), ≤8 KB serialized. Invalid
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

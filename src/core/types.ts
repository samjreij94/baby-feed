/**
 * Baby Feed — core data model + public contract types.
 * See SPEC.md for the normative description (sync, LWW, clock rules).
 * All timestamps are ms since epoch, written with the core clock (device clock + server offset, see SPEC §5).
 */

export type UUID = string;
export type EpochMs = number;
export type Side = 'L' | 'R';

/** A household member (a parent). Samir / Karyn initially; name is editable. */
export interface Member {
  id: UUID;
  name: string;
}

/** Who logged / last edited an entry: member id + name snapshot (display falls back to this if the member is renamed/removed). */
export type MemberRef = Member;

/** Fields shared by every synced entity. */
export interface EntryBase {
  /** UUID v4, generated on the device that created the entry. Never changes. */
  id: UUID;
  /** Household the entry belongs to; null until this device creates/joins a household (then stamped on all local entries). */
  householdId: string | null;
  /** Creation time (core clock). */
  createdAt: EpochMs;
  /** Last modification time (core clock) — the LWW version together with deviceId. Monotonic per entry (see SPEC §5). */
  updatedAt: EpochMs;
  /** Tombstone. Deleted entries are kept (and synced) with deleted: true; hidden from all hooks/metrics. */
  deleted: boolean;
  /** Member who created the entry. */
  loggedBy: MemberRef;
  /** Device that wrote this version (LWW tie-break). Random UUID per install. */
  deviceId: string;
  /** Where the entry came from. Absent = 'app'. */
  source?: 'app' | 'nara';
  /** Id in the source system (e.g. Nara's _activityKey), ≤128 chars. */
  externalId?: string;
}

/** One continuous stretch on one side. endedAt null = currently open (the feed is running on this side). */
export interface Segment {
  side: Side;
  startedAt: EpochMs;
  endedAt: EpochMs | null;
}

export type BreastStatus = 'running' | 'paused' | 'ended';

export interface BreastFeed extends EntryBase {
  kind: 'breast';
  /** Start of the feed (= first segment start). Day attribution uses this. */
  startedAt: EpochMs;
  /** null while running/paused. */
  endedAt: EpochMs | null;
  /** Ordered, non-overlapping. At most one open segment (the last), only when status === 'running'. */
  segments: Segment[];
  /** Set while paused (when the pause began), else null. */
  pausedAt: EpochMs | null;
  status: BreastStatus;
  note?: string;
}

export type MilkType = 'breast' | 'formula';

export interface BottleFeed extends EntryBase {
  kind: 'bottle';
  /** When the bottle was given. */
  at: EpochMs;
  /** Ounces, > 0, multiple of 0.25. */
  amountOz: number;
  milk?: MilkType;
  note?: string;
}

/** Household member record — synced like a feed so renames propagate. */
export interface MemberEntry extends EntryBase {
  kind: 'member';
  /** `id` is the member id. */
  name: string;
}

/**
 * *(added)* Household profile — ONE record per household, synced like any entry (LWW, outbox) so every phone
 * shows the same baby name. `id === householdId` (32 hex chars, so it never collides with a UUID feed/member id).
 */
export interface HouseholdEntry extends EntryBase {
  kind: 'household';
  /** Baby's name, trimmed, ≤60 chars. '' = cleared (a clear syncs like any other rename). */
  babyName: string;
}

export type Feed = BreastFeed | BottleFeed;
/** Everything that travels over /api/sync. */
export type Entry = Feed | MemberEntry | HouseholdEntry;

/** Start time of any feed (breast: startedAt, bottle: at). */
export type FeedStart = EpochMs;

// ── Derived ──────────────────────────────────────────────

export interface SideMs {
  L: number;
  R: number;
}

export interface LastFeedInfo {
  /** Most recent non-deleted feed by start time (includes a running/paused feed). null = no feeds yet. */
  feed: Feed | null;
  /** Start time of that feed. */
  startedAt: EpochMs | null;
  /** now - startedAt (live in useLastFeed). */
  sinceMs: number | null;
  /** Most recent breast feed (bottles skipped). */
  lastBreast: BreastFeed | null;
  /** Side of the LAST segment of the most recent breast feed. */
  lastSide: Side | null;
  /** Suggested side for the next breast feed: opposite of lastSide (SPEC §3.2). null if no breast feed yet. */
  nextSide: Side | null;
}

export interface ActiveFeedView {
  /** The running or paused breast feed, or null. If several exist (two phones started at once), the newest by startedAt. */
  feed: BreastFeed | null;
  status: BreastStatus | null;
  /** Side of the open segment (running) or the side that resume() will use (paused). */
  currentSide: Side | null;
  /** Nursing time so far (sum of segments, open segment up to now; pauses excluded). */
  elapsedMs: number;
  /** Nursing time per side. */
  sideMs: SideMs;
  /** Time in the current open segment (0 when paused). */
  segmentElapsedMs: number;
  /** Other running/paused feeds (conflict, normally empty). */
  others: BreastFeed[];
}

// ── Metrics ──────────────────────────────────────────────

export type RangeDays = 7 | 14 | 30;

export interface DayMetrics {
  /** Local calendar date 'YYYY-MM-DD'. */
  date: string;
  /** Local midnight at the start of the day. */
  dayStart: EpochMs;
  /** Nursing minutes of breast feeds STARTED this day (pauses excluded). */
  breastMinutes: number;
  minutesBySide: SideMs; // minutes, not ms
  /** Breast + bottle feeds started this day. */
  feeds: number;
  breastFeeds: number;
  bottleFeeds: number;
  bottleOz: number;
  bottleOzByMilk: { breast: number; formula: number; unspecified: number };
}

export type MetricsBucketKind = 'day' | 'week' | 'month';

/**
 * Metrics range *(extended)*:
 * - `number` / `{ days }`: today + the previous n−1 local calendar days (original form; 7/14/30).
 * - `{ from, to? }`: feeds with `from ≤ start < to`; `to` defaults to the end of today. Days = every local calendar
 *   day touched by [from, to).
 * - `'all'`: the first live feed's local day through today (no feeds → no days).
 */
export type MetricsRange = number | { days: number } | { from: EpochMs; to?: EpochMs } | 'all';

export interface MetricsOptions {
  /** Grouping of `buckets` (default 'day'). Weeks start Monday 00:00 local; months are calendar months. */
  bucket?: MetricsBucketKind;
  /**
   * Gaps longer than this (minutes) are left out of `avgGapMinutes` (overnight / logging holes). The UI passes 720.
   * Omitted = every gap counts (original behaviour).
   */
  maxGapMinutes?: number;
}

export interface MetricsTotals {
  breastMinutes: number;
  minutesBySide: SideMs;
  feeds: number;
  breastFeeds: number;
  bottleFeeds: number;
  bottleOz: number;
}

export interface MetricsBucket {
  kind: MetricsBucketKind;
  /** Local midnight at the bucket's calendar start (day / Monday / 1st of month) — may be before the range. */
  start: EpochMs;
  /** Local midnight after the bucket's calendar end (exclusive). */
  end: EpochMs;
  /** 'YYYY-MM-DD' of `start`. */
  key: string;
  /** 'Thu, Oct 8' (day) · 'Week of Oct 5' (week; year added when the range spans years) · 'October 2026' (month). */
  label: string;
  /** Days of this bucket inside the range (the divisor for perDayAvg). */
  days: number;
  /** Calendar length of the bucket: 1, 7 or days in the month. */
  fullDays: number;
  /** days < fullDays (first/last week or month cut by the range). Always false for 'day'. */
  partial: boolean;
  totals: MetricsTotals;
  /** totals ÷ days (minutes and feeds 0.1 precision, oz 0.01). */
  perDayAvg: { breastMinutes: number; minutesBySide: SideMs; feeds: number; bottleOz: number };
  /** Mean gap whose LATER feed starts in this bucket (maxGapMinutes applied); null if none. */
  avgGapMinutes: number | null;
}

export interface Metrics {
  /** Number of days in the range (= days.length). */
  rangeDays: number;
  /** Resolved range: local midnight of the first day … exclusive end (null/null for 'all' with no feeds). */
  from: EpochMs | null;
  to: EpochMs | null;
  /** Oldest → newest, one per local calendar day in the range (for numeric/{days} ranges the last one is today). */
  days: DayMetrics[];
  totals: MetricsTotals;
  /** Per-day averages over the whole range (divide totals by rangeDays; 0 when there are no days). */
  perDayAvg: { breastMinutes: number; feeds: number; bottleOz: number };
  /**
   * Mean minutes between consecutive feed starts (breast + bottle) in range; gaps > maxGapMinutes excluded when
   * that option is set. null if there is no (counted) gap.
   */
  avgGapMinutes: number | null;
  /** Mean nursing minutes of ENDED breast feeds in range; null if none. */
  avgFeedMinutes: number | null;
  /** *(added)* Start of the earliest live feed overall (not limited to the range); null when there are no feeds. */
  firstFeedAt: EpochMs | null;
  /** *(added)* Grouping used for `buckets`. */
  bucket: MetricsBucketKind;
  /** *(added)* Days grouped by `bucket`, oldest → newest. */
  buckets: MetricsBucket[];
  /** *(added)* The maxGapMinutes applied, or null (all gaps counted). */
  maxGapMinutes: number | null;
}

// ── Inputs ───────────────────────────────────────────────

export interface AddBottleInput {
  amountOz: number;
  /** Default: now. */
  at?: EpochMs;
  milk?: MilkType;
  note?: string;
}

export interface AddManualBreastInput {
  start: EpochMs;
  end: EpochMs;
  /** Explicit segments (must lie within [start, end], closed, non-overlapping). If omitted, `side` is required → one segment start..end. */
  segments?: Array<{ side: Side; startedAt: EpochMs; endedAt: EpochMs }>;
  side?: Side;
  note?: string;
}

export type BreastPatch = Partial<Pick<BreastFeed, 'startedAt' | 'endedAt' | 'segments' | 'note'>>;
export type BottlePatch = Partial<Pick<BottleFeed, 'at' | 'amountOz' | 'milk' | 'note'>>;
export type EntryPatch = BreastPatch | BottlePatch;

/** Result of FeedCore.importEntries. */
export interface ImportResult {
  added: number;
  /** Id already exists locally (never overwritten, so a local edit wins). */
  skippedExisting: number;
  /** Id exists locally as a tombstone (never resurrected). */
  skippedDeleted: number;
  /** Failed validation (additive field). */
  invalid: number;
}

export type FeedRange = { days: number } | { from: EpochMs; to?: EpochMs };

// ── Household / sync ─────────────────────────────────────

export type HouseholdStatus = 'none' | 'joined';

export interface HouseholdView {
  status: HouseholdStatus;
  householdId: string | null;
  /** All members (from MemberEntry records), me included. */
  members: Member[];
  /** This device's member; null until setMe/createHousehold/joinHousehold. */
  me: Member | null;
  /** Grouped display form, e.g. 'K7Q2-9XMB-…' (8 groups of 4). null when status 'none'. */
  inviteCode: string | null;
  /** `${appUrl}#join=<code>` (ungrouped). null when status 'none'. */
  inviteLink: string | null;
  /**
   * *(added)* Baby's name from the synced household record ('' = not set / cleared). Before a household exists it's
   * this device's pending value, uploaded on createHousehold (or on join if the household has no name yet).
   */
  babyName: string;
  /** *(added)* Any member can set it; trimmed, ≤60 chars; '' (or whitespace) clears it on both phones. */
  setBabyName(name: string): Promise<void>;
  /** Set/rename this device's member (works before a household exists). */
  setMe(name: string): Promise<Member>;
  /** POST /api/households; stamps local entries with the householdId and pushes them. */
  createHousehold(myName: string): Promise<void>;
  /** Accepts a raw/grouped code or a full invite link. POST /api/households/join then full pull. */
  joinHousehold(codeOrLink: string, myName: string): Promise<void>;
  /** Forget the household on this device (local data kept, householdId cleared; server untouched). */
  leave(): Promise<void>;
}

export type SyncState = 'idle' | 'syncing' | 'offline' | 'error';

export interface SyncView {
  state: SyncState;
  lastSyncedAt: EpochMs | null;
  /** Number of entries waiting in the outbox. */
  pending: number;
  /** Human-readable last error when state === 'error'. */
  error: string | null;
  /** Estimated server clock offset in ms (serverNow - deviceNow). */
  clockOffsetMs: number;
  syncNow(): Promise<void>;
}

// ── Wire protocol (/api) ─────────────────────────────────

export interface CreateHouseholdResponse {
  householdId: string;
  /** The invite code / auth secret (ungrouped, 32 Crockford base32 chars = 160 bits). */
  secret: string;
}

/** Join sends the secret as `Authorization: Bearer <secret>`; a JSON body {secret} is also accepted. */
export interface JoinHouseholdRequest {
  secret: string;
}
export interface JoinHouseholdResponse {
  householdId: string;
  /** Current (non-deleted) members of the household. */
  members: Member[];
}

export interface SyncRequest {
  /** Opaque cursor from the previous response; null = full pull. */
  since: string | null;
  /** Local changes (outbox), latest version per id. Max 500 per request. */
  changes: Entry[];
  deviceId: string;
}

export interface SyncResponse {
  /** Server rows changed after `since` (winning versions, may include echoes of our own writes). */
  changes: Entry[];
  cursor: string;
  /** More pages available — call again immediately with the new cursor. */
  hasMore: boolean;
  serverNow: EpochMs;
  /** Ids from the request that failed validation (not stored). */
  rejected: Array<{ id: string; reason: string }>;
}

export interface ApiError {
  error: string;
}


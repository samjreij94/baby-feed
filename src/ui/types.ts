/**
 * UI view-models. Screens/components only ever see these shapes (never core types).
 * adapter.ts maps core (or the staging mock) onto them.
 */
export type Side = 'L' | 'R';
export type Milk = 'breast' | 'formula';
export type FeedKind = 'breast' | 'bottle';
export type Units = 'oz' | 'ml';
export type NightPref = 'auto' | 'on' | 'off';
export type RangeDays = 7 | 14 | 30;
/** Charts range toggle: rolling 7/14/30 days (core metrics) or everything since the first feed (UI-aggregated). */
export type ChartRange = RangeDays | 'all';
export type ChartBucket = 'day' | 'week' | 'month';

export const SIDE_NAME: Record<Side, string> = { L: 'Left', R: 'Right' };
export const MILK_NAME: Record<Milk, string> = { breast: 'Breast milk', formula: 'Formula' };

/** A household member as shown in chips. `tone` picks a stable chip colour. */
export interface PersonVM {
  id: string;
  name: string;
  initials: string;
  tone: 0 | 1 | 2 | 3;
  isMe: boolean;
}

export interface HomeVM {
  babyName: string | null;
  hasFeeds: boolean;
  /** Start of the most recent feed (ms) — "Last fed X ago" counts from here. */
  lastFedAt: number | null;
  /** Core-clock ms since that start (ticks every 10 s). */
  sinceMs: number | null;
  lastKind: FeedKind | null;
  /** e.g. "Left → Right · 18 min" or "Bottle · 3.5 oz". */
  lastSummary: string | null;
  lastBy: PersonVM | null;
  lastSide: Side | null;
  nextSide: Side | null;
  today: { feeds: number; nursingMin: number; bottleOz: number };
}

export interface ActiveFeedVM {
  id: string;
  status: 'running' | 'paused';
  currentSide: Side;
  startedAt: number;
  elapsedMs: number;
  sideMs: { L: number; R: number };
  segmentElapsedMs: number;
  startedBy: PersonVM;
  /** True when the feed was started on the other parent's phone. */
  startedByOther: boolean;
  /** Another running feed exists (both phones started at once). */
  conflict: { id: string; by: PersonVM; startedAt: number } | null;
}

/** Editable form of an entry (also used for "add past feed"). */
export type EntryDraft =
  | { kind: 'bottle'; id?: string; at: number; amountOz: number; milk: Milk }
  | { kind: 'breast'; id?: string; startedAt: number; first: Side; minutes: { L: number; R: number } };

export interface HistoryEntryVM {
  id: string;
  kind: FeedKind;
  /** Feed start (ms). */
  at: number;
  /** "Left → Right", "Left", "Bottle". */
  title: string;
  /** "L 9m · R 7m" / "3.5 oz · Formula". */
  detail: string;
  /** "16 min" for breast, "" for bottle. */
  duration: string;
  side: Side | null;
  /** Sides in order, collapsed (['L','R'] for Left → Right). Empty for bottles. */
  sides: Side[];
  amountOz: number | null;
  nursingMin: number;
  running: boolean;
  by: PersonVM;
  draft: EntryDraft;
}

export interface HistoryDayVM {
  key: string; // YYYY-MM-DD
  label: string; // Today / Yesterday / Mon, Oct 5
  summary: string; // "8 feeds · 1h 42m · 6 oz"
  entries: HistoryEntryVM[];
}

export interface ChartDayVM {
  key: string;
  /** Axis label: "M", "5" ... */
  tick: string;
  /** Long label for a11y: "Mon, Oct 5". */
  label: string;
  leftMin: number;
  rightMin: number;
  nursingMin: number;
  feeds: number;
  bottleOz: number;
  /** Mean minutes between consecutive feed starts that day; null if < 2 feeds. */
  avgGapMin: number | null;
  /** All-time week/month bar covering only part of its week/month (drawn lighter). */
  partial?: boolean;
}

export interface ChartsVM {
  range: ChartRange;
  /** What one bar is. Always 'day' for 7/14/30. */
  bucket: ChartBucket;
  /** One entry per bar (a day, or for All-time a week/month whose values are DAILY AVERAGES). */
  days: ChartDayVM[];
  /** All-time only: "Jun 17 – Oct 8, 2026 · 114 days", bar caption, and a partial-bucket note. */
  allTime?: { rangeText: string; barCaption: string; partialNote: string | null };
  /** Left vs right share of nursing time across the range, 0..1 (sum 1, or 0/0 with no data). */
  split: { L: number; R: number; leftMin: number; rightMin: number };
  avg: { feedsPerDay: number; nursingMinPerDay: number; bottleOzPerDay: number; gapMin: number | null; feedMin: number | null };
  hasData: boolean;
}

export interface HouseholdVM {
  status: 'none' | 'joined';
  me: PersonVM | null;
  members: PersonVM[];
  /** Grouped display code. */
  code: string | null;
  link: string | null;
  babyName: string | null;
}

export interface SyncVM {
  state: 'idle' | 'syncing' | 'offline' | 'error';
  text: string;
  pending: number;
}

export interface Prefs {
  night: NightPref;
  units: Units;
}

export interface NaraPreviewVM {
  totalRows: number;
  imported: { breast: number; bottle: number; combo: number };
  feedsToImport: number;
  from: number | null;
  to: number | null;
  leftHours: number;
  rightHours: number;
  bottleOz: number;
  /** Rows not imported (non-feed types etc.), largest first. */
  skipped: { label: string; count: number }[];
  /** Nara caregiver names + the member we'd map them to by default. */
  caregivers: { name: string; suggestedId: string | null }[];
  warnings: string[];
}

export interface NaraVM {
  status: 'idle' | 'parsing' | 'ready' | 'importing' | 'done' | 'error';
  error: string | null;
  preview: NaraPreviewVM | null;
  result: { added: number; skippedExisting: number; skippedDeleted: number; invalid: number } | null;
  members: PersonVM[];
  parseFile(file: File): Promise<void>;
  /** caregiver name → member id */
  confirm(map: Record<string, string>): Promise<void>;
  reset(): void;
}

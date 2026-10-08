/**
 * Public core API — the UI imports ONLY from here (`import { useActiveFeed } from '../core'`).
 * Contract: SPEC.md. Persistence: IndexedDB + localStorage mirror. Sync: outbox + polling (SPEC §5).
 */
import { getCore } from './store';
import type { AddBottleInput, AddManualBreastInput, BottleFeed, BreastFeed, EntryPatch, Feed, ImportResult } from './types';

export type * from './types';
export { FeedCore, getCore, ActiveFeedExistsError, NotImplementedError, defaultApiBaseUrl, type CoreSnapshot, type CoreOptions } from './store';
export { CoreProvider, useCore, useNow, useFeeds, useActiveFeed, useLastFeed, useMetrics, useHousehold, useSync, useFeedActions, useCoreReady, useNaraImport, type ActiveFeedHook, type NaraImportHook, type NaraImportPreview, type NaraImportStatus } from './hooks';
export { opposite, feedStart, sideMs, nursingMs, lastFeedInfo, activeFeedView, validAmountOz } from './feed';
export { computeMetrics, localDateKey, startOfLocalDay } from './metrics';
export { parseInvite, formatInviteCode, readInviteFromLocation } from './invite';
export { createMemoryStorage, createIdbStorage, type KvStorage, type SyncKv } from './storage';
export { NetworkError, HttpError, type FetchLike } from './api';

/** Log a bottle. amountOz > 0 in 0.25 steps; `at` defaults to now. */
export const addBottle = (input: AddBottleInput): Promise<BottleFeed> => getCore().addBottle(input);
/** Add a past breast feed: {start, end, side} or {start, end, segments}. Status 'ended'. */
export const addManualBreast = (input: AddManualBreastInput): Promise<BreastFeed> => getCore().addManualBreast(input);
/** Edit a feed (breast: startedAt/endedAt/segments/note; bottle: at/amountOz/milk/note). Validates; bumps updatedAt. */
export const editEntry = (id: string, patch: EntryPatch): Promise<Feed> => getCore().editEntry(id, patch);
/** Tombstone a feed (deleted: true; syncs; hidden everywhere). */
export const deleteEntry = (id: string): Promise<void> => getCore().deleteEntry(id);
/** Bulk-insert feeds (Nara import): only new ids; never overwrites edits or resurrects tombstones; syncs like any entry. */
export const importEntries = (entries: Feed[]): Promise<ImportResult> => getCore().importEntries(entries);

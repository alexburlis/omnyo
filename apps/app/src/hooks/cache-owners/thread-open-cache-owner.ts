import type { QueryClient } from "@tanstack/react-query";
import { timelineRowSchema } from "@omnyo/server-contract";
import type {
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
  TimelinePaginationCursor,
  TimelineRow,
  TimelineTurnSummaryDetailsResponse,
} from "@omnyo/server-contract";
import { z } from "zod";
import { areTimelineHistorySnapshotsCompatible } from "@omnyo/client-core";
import { getMediaQuerySnapshot } from "@omnyo/shared-ui/hooks/use-media-query";
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { getLocalStorage } from "@/lib/browser-storage";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { selectTimelineCacheEvictions } from "./thread-timeline-retention-policy";
import {
  allThreadDetailBootstrapQueryKeyPrefix,
  allThreadPluginBootstrapQueryKeyPrefix,
  allThreadTimelineQueryKeyPrefix,
  allThreadTimelineTurnSummaryDetailsQueryKeyPrefix,
  threadDetailBootstrapQueryKey,
  threadPluginBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
  threadTimelineQueryKeyPrefix,
  threadTimelineTurnSummaryDetailsQueryKey,
  threadTimelineTurnSummaryDetailsQueryKeyPrefix,
  type ThreadTimelineTurnSummaryDetailsQueryIdentity,
} from "../queries/query-keys";

export const THREAD_OPEN_CACHE_GC_MS = 60 * 60_000;

export const THREAD_OPEN_CACHE_MAX_THREADS = 20;

export const COARSE_POINTER_THREAD_OPEN_CACHE_MAX_THREADS = 8;

export const THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES = 128 * 1024;

export const THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES = 1024 * 1024;

export const THREAD_TIMELINE_DISPLAY_CACHE_MAX_AGE_MS = 24 * 60 * 60_000;

export const THREAD_TIMELINE_DEFER_CONTENT = "false";

export const THREAD_TIMELINE_PAGE_CACHE_MAX_PAGES = 5;

export const THREAD_TIMELINE_PAGE_CACHE_MAX_BYTES = 512 * 1024;

export const THREAD_TIMELINE_DETAIL_CACHE_MAX_BYTES_PER_QUERY = 16 * 1024;

export const THREAD_TIMELINE_DETAIL_CACHE_MAX_BYTES_PER_THREAD = 128 * 1024;

export const THREAD_TIMELINE_DETAIL_CACHE_MAX_QUERIES_PER_THREAD = 8;

const DISPLAY_CACHE_STORAGE_KEY = "omnyo.threadTimelineDisplay.v1";

const DISPLAY_CACHE_VERSION = 2;

const persistedDisplayRecordSchema = z
  .object({
    origin: z.string().min(1),
    runtimeId: z.string().min(1),
    threadId: z.string().min(1),
    historySnapshot: z.string().min(1),
    surfaceKey: z.string().min(1),
    contextBoundarySeq: z.number().int().nonnegative().nullable(),
    savedAt: z.number().int().nonnegative(),
    accessedAt: z.number().int().nonnegative(),
    rows: z.array(timelineRowSchema),
  })
  .strict();

const persistedDisplayCacheSchema = z
  .object({
    version: z.literal(DISPLAY_CACHE_VERSION),
    runtimeId: z.string().min(1).nullable(),
    records: z.array(persistedDisplayRecordSchema),
  })
  .strict();

type PersistedDisplayRecord = z.infer<typeof persistedDisplayRecordSchema>;

type PersistedDisplayCache = z.infer<typeof persistedDisplayCacheSchema>;

export interface PersistedThreadTimelineDisplay {
  contextBoundarySeq: number | null;
  historySnapshot: string;
  rows: TimelineRow[];
  surfaceKey: string;
}

export interface ThreadTimelineVisitedPage {
  rows: TimelineRow[];
  olderCursor: TimelinePaginationCursor | null;
}

export interface ThreadTimelineHistoryGeneration {
  readonly value: symbol;
}

export interface ThreadTimelineVisitedPages {
  historySnapshot?: string;
  latestWindowEndSequence: number | null;
  pages: ThreadTimelineVisitedPage[];
  surfaceKey: string;
}

interface ThreadTimelineVisitedPagesCacheEntry extends ThreadTimelineVisitedPages {
  accessedAt: number;
  bytes: number;
  historyGeneration: ThreadTimelineHistoryGeneration;
}

interface CompletedThreadTimelineDetailCacheEntry {
  accessedAt: number;
  bytes: number;
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity;
  response: TimelineTurnSummaryDetailsResponse;
}

const threadOpenCacheTouchesByClient = new WeakMap<QueryClient, Set<string>>();

const threadOpenPreloadTargetsByClient = new WeakMap<
  QueryClient,
  ReadonlySet<string>
>();

export function hasThreadOpenDisplay(
  queryClient: QueryClient,
  projectId: string,
  threadId: string,
): boolean {
  const bootstrap = queryClient.getQueryState<ThreadWithIncludesResponse>(
    threadDetailBootstrapQueryKey(threadId),
  );

  const timeline = queryClient.getQueryState<ThreadTimelineResponse>(
    threadTimelineQueryKey(threadId),
  );

  if (
    bootstrap?.data?.id !== threadId ||
    bootstrap.data.projectId !== projectId ||
    [bootstrap.error, timeline?.error].some(
      (error) => error instanceof OmnyoHttpError && error.status === 404,
    )
  )
    return false;

  const runtimeId =
    queryClient.getQueryData<string>(threadOpenRuntimeIdentityQueryKey()) ??
    getThreadOpenRuntimeId(queryClient);

  const knownRuntimeId = getThreadOpenRuntimeId(queryClient);

  if (
    runtimeId === undefined ||
    (knownRuntimeId !== undefined && knownRuntimeId !== runtimeId) ||
    !isThreadTimelineForRuntimeCurrent(queryClient, threadId, runtimeId)
  )
    return false;

  return timeline?.data?.runtimeId === runtimeId;
}

const visitedPagesByClient = new WeakMap<
  QueryClient,
  Map<string, ThreadTimelineVisitedPagesCacheEntry>
>();

const completedDetailsByClient = new WeakMap<
  QueryClient,
  Map<string, Map<string, CompletedThreadTimelineDetailCacheEntry>>
>();

const timelineRuntimeIdsByClient = new WeakMap<
  QueryClient,
  Map<string, string>
>();

const historyGenerationsByClient = new WeakMap<
  QueryClient,
  Map<string, ThreadTimelineHistoryGeneration>
>();

const runtimeIdsByClient = new WeakMap<QueryClient, string>();

const runtimeChangedClients = new WeakSet<QueryClient>();

interface LatestTimelineBudgetEntry {
  response: ThreadTimelineResponse;
  bytes: number;
}

export interface ThreadOpenBudgetEvent {
  kind: "cold" | "activate";
  threadId: string;
  sequence: number;
}

interface ThreadOpenBudgetOwner {
  entries: Map<string, LatestTimelineBudgetEntry>;
  cold: Map<string, number>;
  listeners: Set<(event: ThreadOpenBudgetEvent) => void>;
}

const latestBudgetsByClient = new WeakMap<QueryClient, ThreadOpenBudgetOwner>();

const historySnapshotsByClient = new WeakMap<
  QueryClient,
  Map<string, string | undefined>
>();

export function admitThreadTimelineHistory(
  queryClient: QueryClient,
  threadId: string,
  response: ThreadTimelineResponse,
): void {
  let snapshots = historySnapshotsByClient.get(queryClient);

  if (!snapshots) {
    snapshots = new Map();
    historySnapshotsByClient.set(queryClient, snapshots);
  }

  const snapshot = response.timelinePage.historySnapshot;

  if (
    snapshots.has(threadId) &&
    !areTimelineHistorySnapshotsCompatible(snapshots.get(threadId), snapshot)
  ) {
    purgeThreadOpenHistoryCache(queryClient, threadId);
  }

  rememberBounded(queryClient, snapshots, threadId, snapshot);
}

function enforceThreadTimelineBudget(
  queryClient: QueryClient,
  owner: ThreadOpenBudgetOwner,
): void {
  const retained = threadOpenPreloadTargetsByClient.get(queryClient);

  const evictions = selectTimelineCacheEvictions(
    [...owner.entries].map(([threadId, entry]) => ({
      threadId,
      bytes: entry.bytes,
      active: isThreadOpenCacheActive(queryClient, threadId),
      retained: retained?.has(threadId) === true,
    })),
  );

  for (const threadId of evictions) {
    const entry = owner.entries.get(threadId);

    if (!entry) continue;
    owner.cold.set(threadId, entry.response.maxSeq);
    owner.entries.delete(threadId);

    for (const listener of owner.listeners)
      listener({ kind: "cold", threadId, sequence: entry.response.maxSeq });
    queryClient.removeQueries({
      queryKey: threadTimelineQueryKey(threadId),
      exact: true,
      type: "inactive",
    });
  }
}

function latestTimelineBudget(queryClient: QueryClient): ThreadOpenBudgetOwner {
  const previous = latestBudgetsByClient.get(queryClient);

  if (previous) return previous;

  const owner: ThreadOpenBudgetOwner = {
    entries: new Map(),
    cold: new Map(),
    listeners: new Set(),
  };

  latestBudgetsByClient.set(queryClient, owner);

  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== allThreadTimelineQueryKeyPrefix()[0])
      return;
    const parsedThreadId = z.string().safeParse(event.query.queryKey[1]);

    if (!parsedThreadId.success) return;
    const threadId = parsedThreadId.data;

    if (event.type === "removed") {
      owner.entries.delete(threadId);

      return;
    }

    if (event.type === "updated" && event.action.type === "success") {
      const response = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey(threadId),
      );

      if (response && owner.entries.get(threadId)?.response !== response) {
        admitThreadTimelineHistory(queryClient, threadId, response);
        owner.entries.delete(threadId);
        owner.entries.set(threadId, {
          response,
          bytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
        });
      }
    }

    if (
      event.type !== "observerResultsUpdated" &&
      event.type !== "observerOptionsUpdated"
    )
      enforceThreadTimelineBudget(queryClient, owner);
  });

  for (const query of queryClient.getQueryCache().getAll()) {
    if (query.queryKey[0] !== allThreadTimelineQueryKeyPrefix()[0]) continue;
    const id = z.string().safeParse(query.queryKey[1]);

    if (!id.success) continue;

    const response = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(id.data),
    );

    if (!response) continue;
    admitThreadTimelineHistory(queryClient, id.data, response);
    owner.entries.set(id.data, {
      response,
      bytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
    });
  }

  enforceThreadTimelineBudget(queryClient, owner);

  return owner;
}

export function subscribeThreadOpenBudget(
  queryClient: QueryClient,
  listener: (event: ThreadOpenBudgetEvent) => void,
): () => void {
  const owner = latestTimelineBudget(queryClient);
  owner.listeners.add(listener);

  return () => {
    owner.listeners.delete(listener);
  };
}

export function isThreadOpenBudgetCold(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  return latestBudgetsByClient.get(queryClient)?.cold.has(threadId) ?? false;
}

export function activateThreadOpenCache(
  queryClient: QueryClient,
  threadId: string,
  sequence = Infinity,
): void {
  const owner = latestTimelineBudget(queryClient);
  const coldSequence = owner.cold.get(threadId);

  if (coldSequence === undefined || sequence <= coldSequence) return;
  owner.cold.delete(threadId);

  for (const listener of owner.listeners)
    listener({ kind: "activate", threadId, sequence });
}

interface PendingDisplayWrite {
  cancel: () => void;
  origin: string;
  threadId: string;
  writeMarker: object;
}

const pendingDisplayWrites = new Map<string, PendingDisplayWrite>();

let activeDisplayTargetCount = 0;

function resolveThreadOpenCacheMaxThreads(): number {
  return getMediaQuerySnapshot(POINTER_COARSE_QUERY)
    ? COARSE_POINTER_THREAD_OPEN_CACHE_MAX_THREADS
    : THREAD_OPEN_CACHE_MAX_THREADS;
}

function rememberBounded<T>(
  queryClient: QueryClient,
  entries: Map<string, T>,
  key: string,
  value: T,
): void {
  entries.delete(key);
  entries.set(key, value);

  const retained = threadOpenPreloadTargetsByClient.get(queryClient);
  const maxEntries = resolveThreadOpenCacheMaxThreads() + (retained?.size ?? 0);

  for (const candidate of entries.keys()) {
    if (entries.size <= maxEntries) break;

    if (!retained?.has(candidate)) entries.delete(candidate);
  }
}

function createThreadTimelineHistoryGeneration(): ThreadTimelineHistoryGeneration {
  return { value: Symbol() };
}

function historyGenerationsForClient(
  queryClient: QueryClient,
): Map<string, ThreadTimelineHistoryGeneration> {
  let generations = historyGenerationsByClient.get(queryClient);

  if (!generations) {
    generations = new Map();
    historyGenerationsByClient.set(queryClient, generations);
  }

  return generations;
}

export function getThreadTimelineHistoryGeneration(
  queryClient: QueryClient,
  threadId: string,
): ThreadTimelineHistoryGeneration {
  const generations = historyGenerationsForClient(queryClient);
  const current = generations.get(threadId);

  if (current) {
    rememberBounded(queryClient, generations, threadId, current);

    return current;
  }

  const generation = createThreadTimelineHistoryGeneration();
  rememberBounded(queryClient, generations, threadId, generation);

  return generation;
}

function advanceThreadTimelineHistoryGeneration(
  queryClient: QueryClient,
  threadId: string,
): void {
  rememberBounded(
    queryClient,
    historyGenerationsForClient(queryClient),
    threadId,
    createThreadTimelineHistoryGeneration(),
  );
}

export function getThreadTimelineRuntimeId(
  queryClient: QueryClient,
  threadId: string,
): string | undefined {
  return timelineRuntimeIdsByClient.get(queryClient)?.get(threadId);
}

export function isThreadTimelineForRuntimeCurrent(
  queryClient: QueryClient,
  threadId: string,
  runtimeId?: string,
): boolean {
  const timelineRuntimeId = getThreadTimelineRuntimeId(queryClient, threadId);
  const knownRuntimeId = getThreadOpenRuntimeId(queryClient);

  if (runtimeId !== undefined) {
    return (
      timelineRuntimeId === runtimeId ||
      (timelineRuntimeId === undefined &&
        !runtimeChangedClients.has(queryClient))
    );
  }

  return (
    !runtimeChangedClients.has(queryClient) &&
    (timelineRuntimeId === undefined ||
      knownRuntimeId === undefined ||
      timelineRuntimeId === knownRuntimeId)
  );
}

export function rememberThreadTimelineRuntimeId(
  queryClient: QueryClient,
  threadId: string,
  runtimeId: string,
): void {
  let runtimeIds = timelineRuntimeIdsByClient.get(queryClient);

  if (!runtimeIds) {
    runtimeIds = new Map();
    timelineRuntimeIdsByClient.set(queryClient, runtimeIds);
  }

  rememberBounded(queryClient, runtimeIds, threadId, runtimeId);
}

export function rememberThreadOpenRuntimeId(
  queryClient: QueryClient,
  runtimeId: string,
): void {
  if (!runtimeIdsByClient.has(queryClient)) {
    runtimeIdsByClient.set(queryClient, runtimeId);
  }
}

export function getThreadOpenRuntimeId(
  queryClient: QueryClient,
): string | undefined {
  return runtimeIdsByClient.get(queryClient);
}

function utf8Bytes(
  value:
    | PersistedDisplayCache
    | PersistedDisplayRecord[]
    | TimelineRow[]
    | ThreadTimelineVisitedPage
    | TimelineTurnSummaryDetailsResponse,
): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function persistedDisplayScope(
  origin: string,
  runtimeId: string,
  threadId: string,
) {
  return `${origin}\u0000${runtimeId}\u0000${threadId}`;
}

let decodedDisplayCache: {
  serialized: string;
  cache: PersistedDisplayCache;
} | null = null;

const displayRecordBytes = new WeakMap<PersistedDisplayRecord, number>();

function readDisplayCache(): PersistedDisplayCache {
  const storage = getLocalStorage();

  if (!storage) {
    return { version: DISPLAY_CACHE_VERSION, runtimeId: null, records: [] };
  }

  try {
    const serialized = storage.getItem(DISPLAY_CACHE_STORAGE_KEY);

    if (!serialized) {
      return { version: DISPLAY_CACHE_VERSION, runtimeId: null, records: [] };
    }

    if (decodedDisplayCache?.serialized === serialized) {
      return decodedDisplayCache.cache;
    }

    const parsed = persistedDisplayCacheSchema.safeParse(
      JSON.parse(serialized),
    );

    if (!parsed.success) {
      storage.removeItem(DISPLAY_CACHE_STORAGE_KEY);

      return { version: DISPLAY_CACHE_VERSION, runtimeId: null, records: [] };
    }

    decodedDisplayCache = { serialized, cache: parsed.data };

    return parsed.data;
  } catch {
    return { version: DISPLAY_CACHE_VERSION, runtimeId: null, records: [] };
  }
}

function writeDisplayCache(cache: PersistedDisplayCache): void {
  const storage = getLocalStorage();

  if (!storage) return;

  try {
    const serialized = JSON.stringify(cache);
    storage.setItem(DISPLAY_CACHE_STORAGE_KEY, serialized);
    decodedDisplayCache = { serialized, cache };
  } catch {
    return;
  }
}

function persistedDisplayRecordBytes(record: PersistedDisplayRecord): number {
  const cached = displayRecordBytes.get(record);

  if (cached !== undefined) return cached;
  const bytes = utf8Bytes([record]) - 2;
  displayRecordBytes.set(record, bytes);

  return bytes;
}

function cacheForRuntime(
  runtimeId: string,
  now = Date.now(),
): PersistedDisplayCache {
  const cache = readDisplayCache();

  return {
    version: DISPLAY_CACHE_VERSION,
    runtimeId,
    records: cache.records.filter(
      (record) =>
        now - record.savedAt <= THREAD_TIMELINE_DISPLAY_CACHE_MAX_AGE_MS,
    ),
  };
}

function persistDisplayRecords(
  runtimeId: string,
  records: PersistedDisplayRecord[],
  now = Date.now(),
): void {
  const maxThreads =
    resolveThreadOpenCacheMaxThreads() + activeDisplayTargetCount;

  const ordered = [...records]
    .filter(
      (record) =>
        now - record.savedAt <= THREAD_TIMELINE_DISPLAY_CACHE_MAX_AGE_MS,
    )
    .sort((left, right) => right.accessedAt - left.accessedAt)
    .slice(0, maxThreads);

  let totalBytes =
    utf8Bytes({ version: DISPLAY_CACHE_VERSION, runtimeId, records: [] }) +
    Math.max(0, ordered.length - 1) +
    ordered.reduce(
      (sum, record) => sum + persistedDisplayRecordBytes(record),
      0,
    );

  while (
    ordered.length > 1 &&
    totalBytes > THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES
  ) {
    const removed = ordered.pop();

    if (removed) totalBytes -= persistedDisplayRecordBytes(removed) + 1;
  }

  if (totalBytes > THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES) {
    return;
  }

  writeDisplayCache({
    version: DISPLAY_CACHE_VERSION,
    runtimeId,
    records: ordered,
  });
}

function removePersistedDisplayRecord(origin: string, threadId: string): void {
  cancelPendingDisplayWrites(threadId, origin);

  const runtimeId = readDisplayCache().runtimeId;

  if (runtimeId === null) return;
  const cache = cacheForRuntime(runtimeId);
  persistDisplayRecords(
    runtimeId,
    cache.records.filter(
      (record) => record.origin !== origin || record.threadId !== threadId,
    ),
  );
}

function cancelAllPendingDisplayWrites(): void {
  for (const pending of pendingDisplayWrites.values()) {
    pending.cancel();
  }

  pendingDisplayWrites.clear();
}

function cancelPendingDisplayWrites(threadId: string, origin?: string): void {
  for (const [scope, pending] of pendingDisplayWrites) {
    if (
      pending.threadId !== threadId ||
      (origin !== undefined && pending.origin !== origin)
    ) {
      continue;
    }

    pending.cancel();
    pendingDisplayWrites.delete(scope);
  }
}

function isCompletedDisplayRow(row: TimelineRow): boolean {
  if ("contentDeferred" in row && row.contentDeferred === true) return false;

  switch (row.kind) {
    case "conversation":
      return row.role === "assistant" || row.turnRequest.status === "accepted";
    case "system":
      return row.status === "completed";
    case "work":
      return row.status === "completed";
    case "turn":
      return (
        row.status === "completed" &&
        (row.children === null || row.children.every(isCompletedDisplayRow))
      );
    default:
      return false;
  }
}

function selectPersistedDisplayRows(
  rows: readonly TimelineRow[],
  maxBytes = THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES,
): TimelineRow[] {
  const retained: TimelineRow[] = [];
  let retainedBytes = 2;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];

    if (!row || !isCompletedDisplayRow(row)) continue;
    const rowBytes = utf8Bytes([row]) - 2;
    const separatorBytes = retained.length === 0 ? 0 : 1;
    const candidateBytes = retainedBytes + rowBytes + separatorBytes;

    if (candidateBytes > maxBytes) {
      break;
    }

    retained.push(row);
    retainedBytes = candidateBytes;
  }

  return retained.reverse();
}

export function readPersistedThreadTimelineDisplay({
  origin,
  runtimeId,
  threadId,
}: {
  origin: string;
  runtimeId: string;
  threadId: string;
}): PersistedThreadTimelineDisplay | null {
  const cache = cacheForRuntime(runtimeId);

  const record = cache.records.find(
    (candidate) =>
      candidate.origin === origin && candidate.threadId === threadId,
  );

  if (!record) {
    if (cache.runtimeId !== readDisplayCache().runtimeId) {
      writeDisplayCache(cache);
    }

    return null;
  }

  const accessedAt = Date.now();
  const nextRecord = { ...record, accessedAt };
  persistDisplayRecords(
    runtimeId,
    [nextRecord, ...cache.records.filter((candidate) => candidate !== record)],
    accessedAt,
  );

  return displayFromRecord(record);
}

function displayFromRecord(
  record: PersistedDisplayRecord,
): PersistedThreadTimelineDisplay {
  return {
    contextBoundarySeq: record.contextBoundarySeq,
    historySnapshot: record.historySnapshot,
    rows: record.rows,
    surfaceKey: record.surfaceKey,
  };
}

export function peekPersistedThreadTimelineDisplay({
  origin,
  threadId,
}: {
  origin: string;
  threadId: string;
}): PersistedThreadTimelineDisplay | null {
  const now = Date.now();

  const record = readDisplayCache().records.find(
    (candidate) =>
      candidate.origin === origin &&
      candidate.threadId === threadId &&
      now - candidate.savedAt <= THREAD_TIMELINE_DISPLAY_CACHE_MAX_AGE_MS,
  );

  return record ? displayFromRecord(record) : null;
}

export function hasPersistedThreadTimelineDisplay(threadId: string): boolean {
  return (
    typeof window !== "undefined" &&
    peekPersistedThreadTimelineDisplay({
      origin: window.location.origin,
      threadId,
    }) !== null
  );
}

export function schedulePersistedThreadTimelineDisplay({
  origin,
  response,
  runtimeId,
  surfaceKey,
  threadId,
  queryClient,
}: {
  origin: string;
  response: ThreadTimelineResponse;
  runtimeId: string;
  surfaceKey: string;
  threadId: string;
  queryClient?: QueryClient;
}): void {
  const historySnapshot = response.timelinePage.historySnapshot;

  if (!historySnapshot) return;

  const targetCount = queryClient
    ? (threadOpenPreloadTargetsByClient.get(queryClient)?.size ?? 1)
    : 1;

  const now = Date.now();

  const emptyRecord: PersistedDisplayRecord = {
    origin,
    runtimeId,
    threadId,
    historySnapshot,
    surfaceKey,
    contextBoundarySeq: response.contextBoundarySeq,
    savedAt: now,
    accessedAt: now,
    rows: [],
  };

  const recordBytes = utf8Bytes([emptyRecord]) - 2;

  const envelopeBytes = utf8Bytes({
    version: DISPLAY_CACHE_VERSION,
    runtimeId,
    records: [],
  });

  const distributedRowBytes =
    Math.floor(
      (THREAD_TIMELINE_DISPLAY_CACHE_MAX_TOTAL_BYTES - envelopeBytes) /
        Math.max(1, targetCount),
    ) -
    recordBytes +
    1;

  const rows = selectPersistedDisplayRows(
    response.rows,
    Math.min(
      THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES,
      distributedRowBytes,
    ),
  );

  if (rows.length === 0) return;

  const scope = persistedDisplayScope(origin, runtimeId, threadId);
  pendingDisplayWrites.get(scope)?.cancel();
  const writeMarker = {};

  const callback = () => {
    if (pendingDisplayWrites.get(scope)?.writeMarker !== writeMarker) return;
    pendingDisplayWrites.delete(scope);

    const persistedRuntime = readDisplayCache().runtimeId;

    if (
      persistedRuntime !== runtimeId &&
      (queryClient === undefined ||
        getThreadOpenRuntimeId(queryClient) !== runtimeId)
    )
      return;
    const cache = cacheForRuntime(runtimeId);

    if (cache.runtimeId !== runtimeId) return;
    const now = Date.now();

    const record: PersistedDisplayRecord = {
      origin,
      runtimeId,
      threadId,
      historySnapshot,
      surfaceKey,
      contextBoundarySeq: response.contextBoundarySeq,
      savedAt: now,
      accessedAt: now,
      rows,
    };

    persistDisplayRecords(
      runtimeId,
      [
        record,
        ...cache.records.filter(
          (candidate) =>
            candidate.origin !== origin || candidate.threadId !== threadId,
        ),
      ],
      now,
    );
  };

  let cancel: () => void;

  if (window.requestIdleCallback) {
    const idleCallbackId = window.requestIdleCallback(callback, {
      timeout: 250,
    });

    cancel = () => window.cancelIdleCallback(idleCallbackId);
  } else {
    const timeoutId = window.setTimeout(callback, 0);
    cancel = () => window.clearTimeout(timeoutId);
  }

  pendingDisplayWrites.set(scope, { cancel, origin, threadId, writeMarker });

  while (
    pendingDisplayWrites.size >
    resolveThreadOpenCacheMaxThreads() + activeDisplayTargetCount
  ) {
    const oldest = pendingDisplayWrites.entries().next().value;

    if (!oldest) break;
    oldest[1].cancel();
    pendingDisplayWrites.delete(oldest[0]);
  }
}

export function discardPersistedThreadTimelineDisplayIfChanged({
  origin,
  response,
  runtimeId,
  surfaceKey,
  threadId,
}: {
  origin: string;
  response: ThreadTimelineResponse;
  runtimeId: string;
  surfaceKey: string;
  threadId: string;
}): boolean {
  const cache = cacheForRuntime(runtimeId);

  const record = cache.records.find(
    (candidate) =>
      candidate.origin === origin && candidate.threadId === threadId,
  );

  if (
    !record ||
    (record.historySnapshot === response.timelinePage.historySnapshot &&
      record.surfaceKey === surfaceKey &&
      record.contextBoundarySeq === response.contextBoundarySeq)
  ) {
    return false;
  }

  removePersistedDisplayRecord(origin, threadId);

  return true;
}

export function clearPersistedThreadTimelineDisplays(): void {
  cancelAllPendingDisplayWrites();
  const storage = getLocalStorage();

  try {
    storage?.removeItem(DISPLAY_CACHE_STORAGE_KEY);
  } catch {
    return;
  }
}

export function clearPersistedThreadTimelineDisplay({
  origin,
  threadId,
}: {
  origin: string;
  threadId: string;
}): void {
  removePersistedDisplayRecord(origin, threadId);
}

function isThreadOpenCacheActive(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  const queryCache = queryClient.getQueryCache();

  return (
    queryCache
      .get(
        queryClient.defaultQueryOptions({
          queryKey: threadTimelineQueryKey(threadId),
        }).queryHash,
      )
      ?.isActive() === true ||
    queryCache
      .get(
        queryClient.defaultQueryOptions({
          queryKey: threadDetailBootstrapQueryKey(threadId),
        }).queryHash,
      )
      ?.isActive() === true
  );
}

function removeThreadOpenMemoryCaches(
  queryClient: QueryClient,
  threadId: string,
): void {
  visitedPagesByClient.get(queryClient)?.delete(threadId);
  completedDetailsByClient.get(queryClient)?.delete(threadId);
}

function evictThreadOpenCache(
  queryClient: QueryClient,
  touched: Set<string>,
): void {
  const retained = threadOpenPreloadTargetsByClient.get(queryClient);
  const maxThreads = resolveThreadOpenCacheMaxThreads() + (retained?.size ?? 0);

  for (const threadId of touched) {
    if (touched.size <= maxThreads) return;

    if (retained?.has(threadId)) continue;

    if (isThreadOpenCacheActive(queryClient, threadId)) continue;
    queryClient.removeQueries({
      queryKey: threadTimelineQueryKeyPrefix(threadId),
      type: "inactive",
    });
    queryClient.removeQueries({
      queryKey: threadDetailBootstrapQueryKey(threadId),
      exact: true,
      type: "inactive",
    });
    queryClient.removeQueries({
      queryKey: threadPluginBootstrapQueryKey(threadId),
      exact: true,
      type: "inactive",
    });
    queryClient.removeQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(threadId),
      type: "inactive",
    });
    removeThreadOpenMemoryCaches(queryClient, threadId);
    touched.delete(threadId);
  }
}

export function retainThreadOpenPreloadTargets(
  queryClient: QueryClient,
  threadIds: ReadonlySet<string>,
): void {
  activeDisplayTargetCount = threadIds.size;
  threadOpenPreloadTargetsByClient.set(queryClient, threadIds);
  const budget = latestTimelineBudget(queryClient);

  for (const threadId of budget.cold.keys())
    if (!threadIds.has(threadId)) budget.cold.delete(threadId);
  enforceThreadTimelineBudget(queryClient, budget);
  const touched = threadOpenCacheTouchesByClient.get(queryClient);

  if (touched) evictThreadOpenCache(queryClient, touched);
}

export function touchThreadOpenCache(
  queryClient: QueryClient,
  threadId: string,
): void {
  const budget = latestTimelineBudget(queryClient);
  const latest = budget.entries.get(threadId);

  if (latest) {
    budget.entries.delete(threadId);
    budget.entries.set(threadId, latest);
  }

  let touched = threadOpenCacheTouchesByClient.get(queryClient);

  if (touched === undefined) {
    touched = new Set();
    threadOpenCacheTouchesByClient.set(queryClient, touched);
  }

  touched.delete(threadId);
  touched.add(threadId);
  evictThreadOpenCache(queryClient, touched);

  for (const entries of [
    visitedPagesByClient.get(queryClient),
    completedDetailsByClient.get(queryClient),
  ]) {
    if (!entries) continue;

    for (const candidate of entries.keys()) {
      if (entries.size <= resolveThreadOpenCacheMaxThreads()) break;

      if (!isThreadOpenCacheActive(queryClient, candidate)) {
        entries.delete(candidate);
      }
    }
  }
}

export function normalizeThreadTimelineVisitedPages(
  pages: readonly ThreadTimelineVisitedPage[],
): { bytes: number; pages: ThreadTimelineVisitedPage[] } | null {
  const retained: ThreadTimelineVisitedPage[] = [];
  let bytes = 0;

  for (const page of pages.slice(0, THREAD_TIMELINE_PAGE_CACHE_MAX_PAGES)) {
    const pageBytes = utf8Bytes(page);

    if (
      retained.length === 0 &&
      pageBytes > THREAD_TIMELINE_PAGE_CACHE_MAX_BYTES
    ) {
      return null;
    }

    if (bytes + pageBytes > THREAD_TIMELINE_PAGE_CACHE_MAX_BYTES) break;
    retained.push({ rows: [...page.rows], olderCursor: page.olderCursor });
    bytes += pageBytes;
  }

  return retained.length === 0 ? null : { bytes, pages: retained };
}

export function rememberThreadTimelineVisitedPages(
  queryClient: QueryClient,
  threadId: string,
  pages: ThreadTimelineVisitedPages & {
    historyGeneration: ThreadTimelineHistoryGeneration;
  },
): void {
  if (
    getThreadTimelineHistoryGeneration(queryClient, threadId) !==
    pages.historyGeneration
  ) {
    return;
  }

  const normalized = normalizeThreadTimelineVisitedPages(pages.pages);
  let entries = visitedPagesByClient.get(queryClient);

  if (!entries) {
    entries = new Map();
    visitedPagesByClient.set(queryClient, entries);
  }

  if (!normalized) {
    entries.delete(threadId);

    return;
  }

  entries.delete(threadId);
  entries.set(threadId, {
    ...pages,
    pages: normalized.pages,
    accessedAt: Date.now(),
    bytes: normalized.bytes,
    historyGeneration: pages.historyGeneration,
  });
  touchThreadOpenCache(queryClient, threadId);
}

export function restoreThreadTimelineVisitedPages(
  queryClient: QueryClient,
  threadId: string,
  { surfaceKey }: { surfaceKey: string },
): ThreadTimelineVisitedPages | null {
  const entries = visitedPagesByClient.get(queryClient);
  const entry = entries?.get(threadId);

  if (!entry) return null;

  if (
    Date.now() - entry.accessedAt > THREAD_OPEN_CACHE_GC_MS ||
    entry.surfaceKey !== surfaceKey ||
    entry.historyGeneration !==
      getThreadTimelineHistoryGeneration(queryClient, threadId)
  ) {
    entries?.delete(threadId);

    return null;
  }

  entries?.delete(threadId);
  entries?.set(threadId, { ...entry, accessedAt: Date.now() });

  return {
    historySnapshot: entry.historySnapshot,
    latestWindowEndSequence: entry.latestWindowEndSequence,
    pages: entry.pages,
    surfaceKey: entry.surfaceKey,
  };
}

function detailIdentityKey(
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
): string {
  return JSON.stringify([
    identity.turnId,
    identity.sourceSeqStart,
    identity.sourceSeqEnd,
    identity.itemId,
  ]);
}

function isCompletedDetailRow(row: TimelineRow): boolean {
  if ("contentDeferred" in row && row.contentDeferred === true) return false;

  switch (row.kind) {
    case "conversation":
      return row.turnRequest === null;
    case "system":
    case "work":
      return row.status === "completed";
    case "turn":
      return (
        row.status === "completed" &&
        (row.children === null || row.children.every(isCompletedDetailRow))
      );
    default:
      return false;
  }
}

function isCompletedImmutableDetailResponse(
  response: TimelineTurnSummaryDetailsResponse,
): boolean {
  return response.rows.length > 0 && response.rows.every(isCompletedDetailRow);
}

function detailEntriesForThread(
  queryClient: QueryClient,
  threadId: string,
  create: boolean,
): Map<string, CompletedThreadTimelineDetailCacheEntry> | undefined {
  let byThread = completedDetailsByClient.get(queryClient);

  if (!byThread && create) {
    byThread = new Map();
    completedDetailsByClient.set(queryClient, byThread);
  }

  let entries = byThread?.get(threadId);

  if (!entries && create) {
    entries = new Map();
    byThread?.set(threadId, entries);
  }

  return entries;
}

export function rememberCompletedThreadTimelineDetails({
  identity,
  queryClient,
  response,
}: {
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity;
  queryClient: QueryClient;
  response: TimelineTurnSummaryDetailsResponse;
}): void {
  if (!isCompletedImmutableDetailResponse(response)) return;
  const bytes = utf8Bytes(response);

  if (bytes > THREAD_TIMELINE_DETAIL_CACHE_MAX_BYTES_PER_QUERY) return;
  const entries = detailEntriesForThread(queryClient, identity.threadId, true);

  if (!entries) return;
  const key = detailIdentityKey(identity);
  entries.delete(key);
  entries.set(key, { accessedAt: Date.now(), bytes, identity, response });

  let totalBytes = Array.from(entries.values()).reduce(
    (total, entry) => total + entry.bytes,
    0,
  );

  while (
    entries.size > THREAD_TIMELINE_DETAIL_CACHE_MAX_QUERIES_PER_THREAD ||
    totalBytes > THREAD_TIMELINE_DETAIL_CACHE_MAX_BYTES_PER_THREAD
  ) {
    const oldestEntry = entries.entries().next().value;

    if (!oldestEntry || oldestEntry[0] === key) break;
    const [oldestKey, oldest] = oldestEntry;
    totalBytes -= oldest.bytes;
    entries.delete(oldestKey);
    queryClient.removeQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKey(oldest.identity),
      exact: true,
      type: "inactive",
    });
  }
}

export function getCompletedThreadTimelineDetails({
  identity,
  queryClient,
}: {
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity;
  queryClient: QueryClient;
}): {
  dataUpdatedAt: number;
  response: TimelineTurnSummaryDetailsResponse;
} | null {
  const entries = detailEntriesForThread(queryClient, identity.threadId, false);
  const key = detailIdentityKey(identity);
  const entry = entries?.get(key);

  if (!entry) return null;

  if (Date.now() - entry.accessedAt > THREAD_OPEN_CACHE_GC_MS) {
    entries?.delete(key);

    return null;
  }

  entries?.delete(key);
  entries?.set(key, { ...entry, accessedAt: Date.now() });

  return { dataUpdatedAt: entry.accessedAt, response: entry.response };
}

export function purgeThreadOpenHistoryCache(
  queryClient: QueryClient,
  threadId: string,
  {
    removeTimeline = false,
    retainPersistedDisplay = false,
  }: { removeTimeline?: boolean; retainPersistedDisplay?: boolean } = {},
): void {
  advanceThreadTimelineHistoryGeneration(queryClient, threadId);
  removeThreadOpenMemoryCaches(queryClient, threadId);
  cancelPendingDisplayWrites(threadId);

  if (
    !retainPersistedDisplay &&
    getLocalStorage() &&
    typeof window !== "undefined"
  ) {
    clearPersistedThreadTimelineDisplay({
      origin: window.location.origin,
      threadId,
    });
  }

  queryClient.removeQueries({
    queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(threadId),
  });

  if (removeTimeline) {
    timelineRuntimeIdsByClient.get(queryClient)?.delete(threadId);
    queryClient.removeQueries({
      queryKey: threadTimelineQueryKeyPrefix(threadId),
    });
    queryClient.removeQueries({
      queryKey: threadDetailBootstrapQueryKey(threadId),
      exact: true,
    });
    queryClient.removeQueries({
      queryKey: threadPluginBootstrapQueryKey(threadId),
      exact: true,
    });
  }
}

export function clearThreadOpenCachesForRuntimeChange(
  queryClient: QueryClient,
  runtimeId: string,
): void {
  if (runtimeIdsByClient.get(queryClient) === runtimeId) return;

  runtimeIdsByClient.set(queryClient, runtimeId);
  runtimeChangedClients.add(queryClient);
  historySnapshotsByClient.delete(queryClient);
  const budget = latestBudgetsByClient.get(queryClient);

  if (budget) {
    budget.entries.clear();
    const cold = [...budget.cold.keys()];
    budget.cold.clear();

    for (const threadId of cold)
      for (const listener of budget.listeners)
        listener({ kind: "activate", threadId, sequence: Infinity });
  }

  threadOpenCacheTouchesByClient.delete(queryClient);
  visitedPagesByClient.delete(queryClient);
  completedDetailsByClient.delete(queryClient);
  historyGenerationsByClient.delete(queryClient);
  cancelAllPendingDisplayWrites();
  void queryClient.resetQueries({
    queryKey: allThreadTimelineQueryKeyPrefix(),
  });
  void queryClient.resetQueries({
    queryKey: allThreadDetailBootstrapQueryKeyPrefix(),
  });
  void queryClient.resetQueries({
    queryKey: allThreadPluginBootstrapQueryKeyPrefix(),
  });
  void queryClient.resetQueries({
    queryKey: allThreadTimelineTurnSummaryDetailsQueryKeyPrefix(),
  });
}

export function forgetThreadOpenCache(
  queryClient: QueryClient,
  threadId: string,
): void {
  threadOpenCacheTouchesByClient.get(queryClient)?.delete(threadId);
  purgeThreadOpenHistoryCache(queryClient, threadId, { removeTimeline: true });
  queryClient.removeQueries({
    queryKey: threadDetailBootstrapQueryKey(threadId),
    exact: true,
  });
  queryClient.removeQueries({
    queryKey: threadPluginBootstrapQueryKey(threadId),
    exact: true,
  });
}

export function prewarmThreadOlderPage(
  queryClient: QueryClient,
  threadId: string,
  latest: ThreadTimelineResponse,
  signal: AbortSignal,
): Promise<void> {
  const cursor = latest.timelinePage.olderCursor;

  if (cursor === null || signal.aborted) return Promise.resolve();
  const queryKey = ["threadTimelineOlderPrewarm", threadId];

  const cancel = () => {
    void queryClient.cancelQueries({ queryKey, exact: true });
  };

  signal.addEventListener("abort", cancel, { once: true });

  return queryClient
    .prefetchQuery({
      queryKey,
      queryFn: async ({ signal: requestSignal }) => {
        await sdk.threads.timeline({
          threadId,
          beforeAnchorSeq: String(cursor.anchorSeq),
          beforeAnchorId: cursor.anchorId,
          segmentLimit: String(latest.timelinePage.segmentLimit),
          runtimeIdentity: "server-v1",
          deferContent: THREAD_TIMELINE_DEFER_CONTENT,
          priority: "background",
          signal: requestSignal,
        });

        return null;
      },
      staleTime: 0,
      gcTime: 0,
      retry: false,
    })
    .finally(() => signal.removeEventListener("abort", cancel));
}

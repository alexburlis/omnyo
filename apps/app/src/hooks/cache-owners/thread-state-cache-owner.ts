import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { ThreadListEntry, ThreadWithRuntime } from "@omnyo/domain";
import type { ThreadArchiveAllResponse } from "@omnyo/server-contract";
import {
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadQueryKey,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
} from "../queries/query-keys";
import { patchCachedQueryData } from "./cache-effect-utils";
import { removeEnvironmentScopedQueries } from "./environment-cache-effects";
import {
  invalidateThreadDeleteQueries,
  invalidateThreadListMembershipQueries,
  invalidateThreadListQueries,
  removeThreadScopedQueries,
} from "./mutation-cache-effects";
import {
  applyToCachedThreadListsAndSidebarNavigation,
  applyToCachedSidebarNavigationThreads,
  listSidebarNavigationThreads,
  getCachedSidebarNavigationThreads,
  restoreCachedSidebarNavigation,
  snapshotCachedSidebarNavigation,
  type CachedSidebarNavigationSnapshot,
} from "./query-cache";
import {
  applyToCachedThreadLists,
  getCachedThreadLists,
  iterateThreadListCacheEntries,
  restoreCachedThreadLists,
  restoreRemovedThreadEntries,
  type CachedThreadListSnapshot,
} from "./thread-list-cache-data";
import {
  getCachedLiveThreadIdsMatching,
  getCachedThreadDetailListEntry,
  getCachedThreadSnapshots,
  insertArchivedEntriesIntoCachedLists,
  optimisticallyArchiveThreads,
  prependToFirstPage,
  removeLiveThreadsFromCachedLists,
  removeThreadsFromCachedArchivedLists,
  type CachedThreadSnapshot,
} from "./thread-archive-cache";
import {
  applyThreadPatches,
  holdPendingThreadPatches,
  type ThreadMetadataPatch,
} from "./pending-thread-patches";

import {
  holdPendingThreadArchives,
  holdPendingThreadUnarchives,
} from "./pending-thread-membership";
import {
  predictInboxSnapshot,
  readPredictedInboxSnapshot,
  type InboxPrediction,
} from "./inbox-snapshot-cache-owner";
import {
  archiveInboxThreads,
  captureInboxRows,
  hasInboxRows,
  removeInboxThreads,
  restoreInboxRows,
  retitleInboxThread,
  shelveInboxThread,
  type InboxPredict,
  type InboxRows,
} from "@/lib/inbox-predictions";

interface ThreadIdCacheArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface ThreadRuntimeCacheArgs {
  queryClient: QueryClient;
  thread: ThreadWithRuntime;
}

interface ThreadPinSuccessArgs extends ThreadRuntimeCacheArgs {
  pinSortKey: string | null;
}

interface BeginThreadPinTransactionArgs extends ThreadIdCacheArgs {
  pinnedAt: number;
}

interface BeginThreadReadStateTransactionArgs extends ThreadIdCacheArgs {
  lastReadAt: number | null;
}

interface BeginThreadMetadataTransactionArgs extends ThreadIdCacheArgs {
  groupId?: string | null;
  parentThreadId?: string | null;
  sectionId?: string | null;
  title?: string | null;
}

interface ThreadMetadataUpdate {
  threadId: string;
  groupId?: string | null;
  parentThreadId?: string | null;
  sectionId?: string | null;
  title?: string | null;
  pinnedAt?: number | null;
  shelvedAt?: number | null;
}

interface BeginThreadShelfTransactionArgs extends ThreadIdCacheArgs {
  shelvedAt: number | null;
}

interface BeginThreadMetadataBatchTransactionArgs {
  queryClient: QueryClient;
  updates: readonly ThreadMetadataUpdate[];
}

interface RollbackThreadListMutationTransactionArgs extends ThreadIdCacheArgs {
  transaction: ThreadListMutationTransaction | undefined;
}

interface ArchiveThreadAndChildrenTransactionArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface ArchiveMatchingThreadsTransactionArgs {
  matchesThread: (thread: ThreadListEntry) => boolean;
  queryClient: QueryClient;
}

interface RollbackArchiveThreadsTransactionArgs {
  queryClient: QueryClient;
  transaction: ArchiveThreadsTransaction | undefined;
}

interface SettleArchiveThreadsTransactionArgs {
  queryClient: QueryClient;
  response: ThreadArchiveAllResponse | undefined;
  transaction: ArchiveThreadsTransaction | undefined;
}

interface RollbackDeleteThreadTransactionArgs {
  queryClient: QueryClient;
  transaction: DeleteThreadTransaction | undefined;
}

interface SettleDeleteThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: DeleteThreadTransaction | undefined;
}

export interface ThreadListMutationTransaction {
  inboxPrediction: InboxPrediction | null;
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThread: ThreadWithRuntime | undefined;
  previousThreadLists: CachedThreadListSnapshot;
  releasePendingPatches: () => void;
}

export interface ThreadMetadataBatchTransaction {
  inboxPrediction: InboxPrediction | null;
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThreads: ReadonlyMap<string, ThreadWithRuntime | undefined>;
  previousThreadLists: CachedThreadListSnapshot;
  releasePendingPatches: () => void;
}

export interface ArchiveThreadsTransaction {
  inboxPrediction: InboxPrediction;
  releasePendingArchives: () => void;
  archivedThreadIds: string[];
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThreadLists: CachedThreadListSnapshot;
  previousThreads: CachedThreadSnapshot[];
}

export interface DeleteThreadTransaction {
  environmentId: string | null | undefined;
  inboxPrediction: InboxPrediction;
  threadIds: string[];
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
  previousThreads: CachedThreadSnapshot[];
  previousThreadLists: CachedThreadListSnapshot;
}

function predictInboxChange(
  queryClient: QueryClient,
  predict: InboxPredict | null,
): InboxPrediction | null {
  return predict === null ? null : predictInboxSnapshot(queryClient, predict);
}

function settlingWith(
  release: () => void,
  inboxPrediction: InboxPrediction | null,
): () => void {
  return () => {
    release();
    inboxPrediction?.settle();
  };
}

function removeThreadFromLists(queryClient: QueryClient, id: string): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.filter((thread) => thread.id !== id),
  );
}

function updateThreadInLists({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  const updateThread = (list: ThreadListEntry[]) =>
    list.map((candidate) =>
      candidate.id === thread.id ? { ...candidate, ...thread } : candidate,
    );

  applyToCachedThreadListsAndSidebarNavigation(queryClient, updateThread);
}

function updateThreadPinStateInLists({
  pinSortKey,
  queryClient,
  thread,
}: ThreadPinSuccessArgs): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.map((candidate) =>
      candidate.id === thread.id
        ? { ...candidate, ...thread, pinSortKey }
        : candidate,
    ),
  );
}

function getOptimisticLastReadAt(
  thread: Pick<ThreadWithRuntime, "latestAttentionAt">,
  lastReadAt: number | null,
): number | null {
  if (lastReadAt === null) {
    return null;
  }

  return Math.max(lastReadAt, thread.latestAttentionAt);
}

export function applyThreadUpdateResult({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  invalidateThreadListQueries({ queryClient });
}

interface OptimisticThreadFieldTransactionArgs extends ThreadIdCacheArgs {
  patch?: Partial<ThreadWithRuntime>;
  patchThread?: (thread: ThreadWithRuntime) => ThreadWithRuntime;
  applyToLists: (queryClient: QueryClient, threadId: string) => void;
  predictInbox?: () => InboxPredict | null;
  holdPending?: () => () => void;
}

async function runOptimisticThreadFieldTransaction({
  applyToLists,
  patch,
  patchThread,
  predictInbox,
  holdPending,
  queryClient,
  threadId,
}: OptimisticThreadFieldTransactionArgs): Promise<ThreadListMutationTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );

  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);

  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
    (thread) => {
      if (!thread) {
        return thread;
      }

      if (patchThread) {
        return patchThread(thread);
      }

      return {
        ...thread,
        ...(patch ?? {}),
      };
    },
  );
  applyToLists(queryClient, threadId);

  const inboxPrediction = predictInboxChange(
    queryClient,
    predictInbox?.() ?? null,
  );

  return {
    inboxPrediction,
    previousSidebarNavigation,
    previousThread,
    previousThreadLists,
    releasePendingPatches: settlingWith(
      holdPending?.() ?? (() => {}),
      inboxPrediction,
    ),
  };
}

async function beginHeldThreadPatchTransaction({
  patch,
  queryClient,
  threadId,
}: ThreadIdCacheArgs & {
  patch: ThreadMetadataPatch;
}): Promise<ThreadListMutationTransaction> {
  const patches = new Map([[threadId, patch]]);

  const transaction = await runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient) => applyThreadPatches(queryClient, patches),
    predictInbox: () => inboxPatchPrediction(patches),
    queryClient,
    threadId,
  });

  return {
    ...transaction,
    releasePendingPatches: settlingWith(
      holdPendingThreadPatches(queryClient, patches),
      transaction.inboxPrediction,
    ),
  };
}

function inboxPatchPrediction(
  patches: ReadonlyMap<string, ThreadMetadataPatch>,
): InboxPredict | null {
  const changes = [...patches].filter(
    ([, patch]) =>
      typeof patch.title === "string" || patch.shelvedAt !== undefined,
  );

  if (changes.length === 0) return null;

  return (snapshot) =>
    changes.reduce((current, [threadId, patch]) => {
      const titled =
        typeof patch.title === "string"
          ? retitleInboxThread(current, threadId, patch.title)
          : current;

      return patch.shelvedAt === undefined
        ? titled
        : shelveInboxThread(titled, threadId, patch.shelvedAt !== null);
    }, snapshot);
}

export function settleThreadPatchTransaction(
  transaction: ThreadListMutationTransaction | undefined,
): void {
  transaction?.releasePendingPatches();
}

export function beginPinThreadTransaction({
  pinnedAt,
  queryClient,
  threadId,
}: BeginThreadPinTransactionArgs): Promise<ThreadListMutationTransaction> {
  return beginHeldThreadPatchTransaction({
    patch: { pinnedAt, pinSortKey: null },
    queryClient,
    threadId,
  });
}

export function beginUnpinThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<ThreadListMutationTransaction> {
  return beginHeldThreadPatchTransaction({
    patch: { pinnedAt: null, pinSortKey: null },
    queryClient,
    threadId,
  });
}

export async function beginThreadReadStateTransaction({
  lastReadAt,
  queryClient,
  threadId,
}: BeginThreadReadStateTransactionArgs): Promise<ThreadReadStateTransaction> {
  const interruptedQueryKeys = [
    threadQueryKey(threadId),
    threadsQueryKey(),
    sidebarNavigationQueryKey(),
  ].flatMap((queryKey) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey })
      .filter((query) => query.state.fetchStatus !== "idle")
      .map((query) => query.queryKey),
  );

  const transaction = await runOptimisticThreadFieldTransaction({
    applyToLists: (queryClient, threadId) =>
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
        list.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                lastReadAt: getOptimisticLastReadAt(thread, lastReadAt),
              }
            : thread,
        ),
      ),
    patchThread: (thread) => ({
      ...thread,
      lastReadAt: getOptimisticLastReadAt(thread, lastReadAt),
    }),
    queryClient,
    threadId,
  });

  return { ...transaction, lastReadAt, interruptedQueryKeys };
}

export interface ThreadReadStateTransaction extends ThreadListMutationTransaction {
  lastReadAt: number | null;
  interruptedQueryKeys: QueryKey[];
}

export function settleThreadReadStateTransaction({
  queryClient,
  transaction,
}: {
  queryClient: QueryClient;
  transaction: ThreadReadStateTransaction | undefined;
}): void {
  for (const queryKey of transaction?.interruptedQueryKeys ?? []) {
    void queryClient.invalidateQueries(
      { exact: true, queryKey },
      { cancelRefetch: false },
    );
  }
}

export function rollbackThreadReadStateTransaction({
  queryClient,
  threadId,
  transaction,
}: ThreadIdCacheArgs & {
  transaction: ThreadReadStateTransaction | undefined;
}): void {
  if (!transaction) return;
  const { lastReadAt } = transaction;

  function restore<
    T extends Pick<
      ThreadWithRuntime,
      "id" | "lastReadAt" | "latestAttentionAt"
    >,
  >(
    current: T,
    previous:
      | Pick<ThreadWithRuntime, "lastReadAt" | "latestAttentionAt">
      | undefined,
  ): T {
    return current.id === threadId &&
      previous &&
      current.lastReadAt === getOptimisticLastReadAt(previous, lastReadAt)
      ? { ...current, lastReadAt: previous.lastReadAt }
      : current;
  }

  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
    (current) => current && restore(current, transaction.previousThread),
  );

  for (const snapshot of transaction.previousThreadLists) {
    const previous = [...iterateThreadListCacheEntries(snapshot.data)].find(
      (thread) => thread.id === threadId,
    );

    applyToCachedThreadLists(queryClient, {
      queryKey: snapshot.queryKey,
      mapper: (list) => list.map((thread) => restore(thread, previous)),
    });
  }

  const previous = transaction.previousSidebarNavigation
    ? listSidebarNavigationThreads(transaction.previousSidebarNavigation).find(
        (thread) => thread.id === threadId,
      )
    : undefined;

  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: (list) => list.map((thread) => restore(thread, previous)),
  });
}

function findThreadMetadataInCache(
  queryClient: QueryClient,
  threadId: string,
): Pick<ThreadWithRuntime, "parentThreadId" | "sectionId"> | undefined {
  const thread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );

  if (thread) return thread;

  const sidebarThread = getCachedSidebarNavigationThreads(queryClient).find(
    (entry) => entry.id === threadId,
  );

  if (sidebarThread) return sidebarThread;

  for (const { data } of getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  })) {
    for (const entry of iterateThreadListCacheEntries(data)) {
      if (entry.id === threadId) return entry;
    }
  }

  return undefined;
}

function resolveThreadMetadataPatch({
  groupId,
  pinnedAt,
  parentThreadId,
  sectionId,
  shelvedAt,
  queryClient,
  threadId,
  title,
}: ThreadMetadataUpdate & {
  queryClient: QueryClient;
}): ThreadMetadataPatch {
  if (parentThreadId === null && sectionId === undefined) {
    const thread = findThreadMetadataInCache(queryClient, threadId);

    if (thread?.parentThreadId) {
      const parent = findThreadMetadataInCache(
        queryClient,
        thread.parentThreadId,
      );

      if (parent) {
        sectionId = parent.sectionId;
      } else {
        parentThreadId = undefined;
      }
    }
  }

  return {
    ...(pinnedAt !== undefined ? { pinnedAt, pinSortKey: null } : {}),
    ...(shelvedAt !== undefined ? { shelvedAt, shelfSortKey: null } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(sectionId !== undefined ? { sectionId } : {}),
    ...(groupId !== undefined ? { groupId } : {}),
    ...(parentThreadId !== undefined ? { parentThreadId } : {}),
  };
}

export function beginThreadMetadataTransaction({
  groupId,
  parentThreadId,
  sectionId,
  queryClient,
  threadId,
  title,
}: BeginThreadMetadataTransactionArgs): Promise<ThreadListMutationTransaction> {
  const patch = resolveThreadMetadataPatch({
    groupId,
    parentThreadId,
    queryClient,
    sectionId,
    threadId,
    title,
  });

  return beginHeldThreadPatchTransaction({ patch, queryClient, threadId });
}

export function beginThreadMetadataBatchTransaction(
  args: BeginThreadMetadataBatchTransactionArgs,
): Promise<ThreadMetadataBatchTransaction> {
  return runThreadMetadataBatchTransaction({ ...args, afterPatches: () => {} });
}

async function runThreadMetadataBatchTransaction({
  afterPatches,
  queryClient,
  updates,
}: BeginThreadMetadataBatchTransactionArgs & {
  afterPatches: () => void;
}): Promise<ThreadMetadataBatchTransaction> {
  const threadIds = [...new Set(updates.map((update) => update.threadId))];
  await Promise.all([
    ...threadIds.map((threadId) =>
      queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    ),
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);

  const previousThreads = new Map(
    threadIds.map((threadId) => [
      threadId,
      queryClient.getQueryData<ThreadWithRuntime>(threadQueryKey(threadId)),
    ]),
  );

  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);

  const patches = new Map<string, ThreadMetadataPatch>();

  for (const update of updates) {
    patches.set(update.threadId, {
      ...patches.get(update.threadId),
      ...resolveThreadMetadataPatch({ ...update, queryClient }),
    });
  }

  applyThreadPatches(queryClient, patches);
  afterPatches();

  const inboxPrediction = predictInboxChange(
    queryClient,
    inboxPatchPrediction(patches),
  );

  return {
    inboxPrediction,
    previousSidebarNavigation,
    previousThreads,
    previousThreadLists,
    releasePendingPatches: settlingWith(
      holdPendingThreadPatches(queryClient, patches),
      inboxPrediction,
    ),
  };
}

export function rollbackThreadMetadataBatchTransaction({
  queryClient,
  transaction,
}: {
  queryClient: QueryClient;
  transaction: ThreadMetadataBatchTransaction | undefined;
}): void {
  if (!transaction) return;
  transaction.inboxPrediction?.discard();

  for (const [threadId, thread] of transaction.previousThreads) {
    queryClient.setQueryData(threadQueryKey(threadId), thread);
  }

  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
}

export function applyThreadMetadataBatchResult({
  queryClient,
  threads,
}: {
  queryClient: QueryClient;
  threads: readonly ThreadWithRuntime[];
}): void {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));

  for (const thread of threads) {
    queryClient.setQueryData(threadQueryKey(thread.id), thread);
  }

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.map((thread) => {
      const result = threadsById.get(thread.id);

      return result ? { ...thread, ...result } : thread;
    }),
  );
  invalidateThreadListQueries({ queryClient });
}

export function invalidateThreadMetadataBatch({
  queryClient,
  threadIds,
}: {
  queryClient: QueryClient;
  threadIds: readonly string[];
}): void {
  for (const threadId of threadIds) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });
  }

  invalidateThreadListQueries({ queryClient });
}

export function rollbackThreadListMutationTransaction({
  queryClient,
  threadId,
  transaction,
}: RollbackThreadListMutationTransactionArgs): void {
  if (!transaction) {
    return;
  }

  transaction.inboxPrediction?.discard();
  transaction.releasePendingPatches();
  queryClient.setQueryData(
    threadQueryKey(threadId),
    transaction.previousThread,
  );
  restoreCachedThreadLists(queryClient, transaction.previousThreadLists);
  restoreCachedSidebarNavigation(
    queryClient,
    transaction.previousSidebarNavigation,
  );
}

export function applyThreadPinStateResult({
  pinSortKey,
  queryClient,
  thread,
}: ThreadPinSuccessArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  updateThreadPinStateInLists({ queryClient, thread, pinSortKey });
}

export function applyThreadOrderResult({
  queryClient,
  orderedRoots,
}: {
  queryClient: QueryClient;
  orderedRoots: readonly ThreadListEntry[];
}): void {
  const rootsById = new Map(orderedRoots.map((thread) => [thread.id, thread]));
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.map((thread) => {
      const result = rootsById.get(thread.id);

      return result ? { ...thread, ...result } : thread;
    }),
  );
}

export function settleThreadListMembershipMutation({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadListMembershipQueries({ queryClient, threadId });
}

const archivedListEntries = new WeakMap<
  QueryClient,
  Map<string, ThreadListEntry>
>();

function rememberArchivedListEntries(
  queryClient: QueryClient,
  threadIds: readonly string[],
): ThreadListEntry[] {
  const wanted = new Set(threadIds);
  const found = new Map<string, ThreadListEntry>();
  const remembered = archivedListEntries.get(queryClient) ?? new Map();
  archivedListEntries.set(queryClient, remembered);

  for (const entry of [
    ...getCachedSidebarNavigationThreads(queryClient),
    ...getCachedThreadLists(queryClient, {
      queryKey: threadsQueryKey(),
    }).flatMap(({ data }) => [...iterateThreadListCacheEntries(data)]),
  ]) {
    if (wanted.has(entry.id) && !found.has(entry.id))
      found.set(entry.id, entry);
  }

  for (const [threadId, entry] of found) remembered.set(threadId, entry);

  return [...found.values()];
}

const archivedInboxRows = new WeakMap<QueryClient, Map<string, InboxRows>>();

function rememberArchivedInboxRows(
  queryClient: QueryClient,
  threadIds: readonly string[],
): void {
  const snapshot = readPredictedInboxSnapshot(queryClient);

  if (snapshot === undefined) return;
  const remembered = archivedInboxRows.get(queryClient) ?? new Map();
  archivedInboxRows.set(queryClient, remembered);

  for (const threadId of threadIds) {
    const rows = captureInboxRows(snapshot, [threadId]);

    if (hasInboxRows(rows)) remembered.set(threadId, rows);
  }
}

function takeArchivedInboxRows(
  queryClient: QueryClient,
  threadId: string,
): InboxRows | undefined {
  const remembered = archivedInboxRows.get(queryClient);
  const rows = remembered?.get(threadId);
  remembered?.delete(threadId);

  return rows;
}

function takeArchivedListEntry(
  queryClient: QueryClient,
  threadId: string,
): ThreadListEntry | undefined {
  const remembered = archivedListEntries.get(queryClient);
  const entry = remembered?.get(threadId);
  remembered?.delete(threadId);

  return entry;
}

export function beginUnarchiveThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<ThreadListMutationTransaction> {
  let restoredEntry: ThreadListEntry | undefined;

  return runOptimisticThreadFieldTransaction({
    holdPending: () =>
      holdPendingThreadUnarchives(
        queryClient,
        restoredEntry === undefined ? [] : [restoredEntry],
      ),
    applyToLists: (queryClient, threadId) => {
      const remembered = takeArchivedListEntry(queryClient, threadId);

      const thread =
        getCachedThreadLists(queryClient, {
          queryKey: threadsQueryKey(),
        })
          .flatMap(({ data }) => [...iterateThreadListCacheEntries(data)])
          .find((candidate) => candidate.id === threadId) ??
        getCachedSidebarNavigationThreads(queryClient).find(
          (candidate) => candidate.id === threadId,
        ) ??
        remembered ??
        getCachedThreadDetailListEntry(queryClient, threadId);

      removeThreadFromLists(queryClient, threadId);

      if (!thread) return;
      const restored = { ...thread, archivedAt: null };
      restoredEntry = restored;
      applyToCachedSidebarNavigationThreads({
        queryClient,
        mapper: (list, projectId) =>
          projectId === thread.projectId ? [...list, restored] : list,
      });
    },
    patch: { archivedAt: null },
    predictInbox: () => {
      const rows = takeArchivedInboxRows(queryClient, threadId);

      return rows === undefined
        ? null
        : (snapshot) => restoreInboxRows(snapshot, rows);
    },
    queryClient,
    threadId,
  });
}

export async function settleUnarchiveThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: ThreadIdCacheArgs & {
  transaction: ThreadListMutationTransaction | undefined;
}): Promise<void> {
  try {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
      queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
      queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
    ]);
  } finally {
    settleThreadPatchTransaction(transaction);
    settleThreadListMembershipMutation({ queryClient, threadId });
  }
}

async function beginArchiveMatchingThreadsTransaction({
  matchesThread,
  queryClient,
}: ArchiveMatchingThreadsTransactionArgs): Promise<ArchiveThreadsTransaction> {
  const archivedThreadIds = getCachedLiveThreadIdsMatching({
    matchesThread,
    queryClient,
  });

  await Promise.all(
    archivedThreadIds.map((threadId) =>
      queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    ),
  );

  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);

  const previousThreads = getCachedThreadSnapshots({
    queryClient,
    threadIds: archivedThreadIds,
  });

  const archivedAt = Date.now();

  const archivedEntries = rememberArchivedListEntries(
    queryClient,
    archivedThreadIds,
  ).map((entry) => ({ ...entry, archivedAt }));

  rememberArchivedInboxRows(queryClient, archivedThreadIds);
  optimisticallyArchiveThreads({
    archivedAt,
    queryClient,
    threadIds: archivedThreadIds,
  });
  removeLiveThreadsFromCachedLists({
    matchesThread,
    queryClient,
  });
  insertArchivedEntriesIntoCachedLists({
    entries: archivedEntries,
    queryClient,
  });

  const inboxPrediction = predictInboxSnapshot(queryClient, (snapshot) =>
    archiveInboxThreads(snapshot, archivedThreadIds),
  );

  return {
    inboxPrediction,
    releasePendingArchives: settlingWith(
      holdPendingThreadArchives(
        queryClient,
        archivedThreadIds,
        archivedEntries,
      ),
      inboxPrediction,
    ),
    archivedThreadIds,
    previousSidebarNavigation,
    previousThreadLists,
    previousThreads,
  };
}

function getCachedThreadEntries(queryClient: QueryClient): ThreadListEntry[] {
  return [
    ...getCachedSidebarNavigationThreads(queryClient),
    ...getCachedThreadLists(queryClient, {
      queryKey: threadsQueryKey(),
    }).flatMap(({ data }) => [...iterateThreadListCacheEntries(data)]),
  ];
}

export function getCachedThreadTreeIds({
  queryClient,
  matchesRoot,
}: {
  queryClient: QueryClient;
  matchesRoot: (thread: ThreadListEntry) => boolean;
}): Set<string> {
  const threads = getCachedThreadEntries(queryClient);
  const childrenByParent = new Map<string, string[]>();
  const threadIds = new Set<string>();

  for (const thread of threads) {
    if (matchesRoot(thread)) threadIds.add(thread.id);

    if (thread.parentThreadId !== null) {
      const children = childrenByParent.get(thread.parentThreadId) ?? [];
      children.push(thread.id);
      childrenByParent.set(thread.parentThreadId, children);
    }
  }

  for (const threadId of threadIds) {
    for (const childId of childrenByParent.get(threadId) ?? [])
      threadIds.add(childId);
  }

  return threadIds;
}

function getCachedThreadFamilyIds(
  queryClient: QueryClient,
  threadId: string,
): Set<string> {
  const parentIds = new Map(
    getCachedThreadEntries(queryClient).map((thread) => [
      thread.id,
      thread.parentThreadId,
    ]),
  );

  const lineage = new Set([threadId]);
  let rootId = threadId;

  for (
    let parentId = parentIds.get(rootId);
    parentId != null && !lineage.has(parentId);
    parentId = parentIds.get(rootId)
  ) {
    lineage.add(parentId);
    rootId = parentId;
  }

  const familyIds = getCachedThreadTreeIds({
    queryClient,
    matchesRoot: (thread) => thread.id === rootId,
  });

  familyIds.add(threadId);

  return familyIds;
}

function markShelvedRootRead(queryClient: QueryClient, rootId: string): void {
  const readAt = Date.now();

  const markRead = <T extends ThreadWithRuntime>(thread: T): T => ({
    ...thread,
    lastReadAt: getOptimisticLastReadAt(thread, readAt),
  });

  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(rootId),
    (thread) => thread && markRead(thread),
  );
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.some((thread) => thread.id === rootId)
      ? list.map((thread) => (thread.id === rootId ? markRead(thread) : thread))
      : list,
  );
}

function getCachedFamilyEntries(
  queryClient: QueryClient,
  rootId: string,
  familyIds: ReadonlySet<string>,
): ThreadListEntry[] {
  const entries = new Map<string, ThreadListEntry>();

  for (const entry of getCachedThreadEntries(queryClient)) {
    if (
      familyIds.has(entry.id) &&
      entry.archivedAt === null &&
      !entries.has(entry.id)
    )
      entries.set(entry.id, entry);
  }

  return [...entries.values()].sort((left, right) =>
    left.id === rootId
      ? -1
      : right.id === rootId
        ? 1
        : right.id < left.id
          ? -1
          : right.id > left.id
            ? 1
            : 0,
  );
}

function moveFamilyToShelvedList(
  queryClient: QueryClient,
  entries: readonly ThreadListEntry[],
): void {
  for (const { queryKey, data } of getCachedThreadLists(queryClient, {
    queryKey: shelvedThreadsListQueryKey(),
  })) {
    const present = new Set(
      [...iterateThreadListCacheEntries(data)].map(({ id }) => id),
    );

    const missing = entries.filter((entry) => !present.has(entry.id));

    if (missing.length > 0)
      patchCachedQueryData(
        queryClient,
        queryKey,
        prependToFirstPage(data, missing),
      );
  }
}

function moveFamilyToSidebarNavigation(
  queryClient: QueryClient,
  entries: readonly ThreadListEntry[],
): void {
  const present = new Set(
    getCachedSidebarNavigationThreads(queryClient).map(({ id }) => id),
  );

  const missing = entries.filter((entry) => !present.has(entry.id));

  if (missing.length === 0) return;
  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: (list, projectId) => {
      const added = missing.filter((entry) => entry.projectId === projectId);

      return added.length === 0 ? list : [...list, ...added];
    },
  });
}

export function beginThreadShelfTransaction({
  queryClient,
  shelvedAt,
  threadId,
}: BeginThreadShelfTransactionArgs) {
  const familyIds = getCachedThreadFamilyIds(queryClient, threadId);

  return runThreadMetadataBatchTransaction({
    afterPatches: () => {
      if (shelvedAt !== null) markShelvedRootRead(queryClient, threadId);
      const entries = getCachedFamilyEntries(queryClient, threadId, familyIds);

      if (shelvedAt === null)
        moveFamilyToSidebarNavigation(queryClient, entries);
      else moveFamilyToShelvedList(queryClient, entries);
    },
    queryClient,
    updates: [...familyIds].map((familyThreadId) => ({
      threadId: familyThreadId,
      shelvedAt,
    })),
  });
}

export async function beginArchiveThreadAndChildrenTransaction({
  queryClient,
  threadId,
}: ArchiveThreadAndChildrenTransactionArgs): Promise<ArchiveThreadsTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);

  const threadIds = getCachedThreadTreeIds({
    queryClient,
    matchesRoot: (thread) => thread.id === threadId,
  });

  return beginArchiveMatchingThreadsTransaction({
    queryClient,
    matchesThread: (thread) => threadIds.has(thread.id),
  });
}

export async function beginArchiveEnvironmentThreadsTransaction({
  queryClient,
  environmentId,
}: {
  queryClient: QueryClient;
  environmentId: string;
}): Promise<ArchiveThreadsTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);

  const threadIds = getCachedThreadTreeIds({
    queryClient,
    matchesRoot: (thread) =>
      thread.environmentId === environmentId && thread.archivedAt === null,
  });

  return beginArchiveMatchingThreadsTransaction({
    queryClient,
    matchesThread: (thread) => threadIds.has(thread.id),
  });
}

function restoreThreadListMembership({
  queryClient,
  threadIds,
  previousThreadLists,
  previousSidebarNavigation,
}: {
  queryClient: QueryClient;
  threadIds: ReadonlySet<string>;
  previousThreadLists: CachedThreadListSnapshot;
  previousSidebarNavigation: CachedSidebarNavigationSnapshot;
}): void {
  restoreCachedThreadLists(queryClient, previousThreadLists, threadIds);

  if (!previousSidebarNavigation) return;

  const previousProjects = [
    previousSidebarNavigation.personalProject,
    ...previousSidebarNavigation.projects,
  ];

  applyToCachedSidebarNavigationThreads({
    queryClient,
    mapper: (list, projectId) =>
      restoreRemovedThreadEntries(
        list,
        previousProjects.find((project) => project.id === projectId)?.threads ??
          [],
        threadIds,
      ),
  });
}

export function rollbackArchiveThreadsTransaction({
  queryClient,
  transaction,
}: RollbackArchiveThreadsTransactionArgs): void {
  if (!transaction) {
    return;
  }

  transaction.inboxPrediction.discard();
  transaction.releasePendingArchives();
  removeThreadsFromCachedArchivedLists({
    queryClient,
    threadIds: new Set(transaction.archivedThreadIds),
  });

  restoreThreadListMembership({
    queryClient,
    threadIds: new Set(transaction.archivedThreadIds),
    previousThreadLists: transaction.previousThreadLists,
    previousSidebarNavigation: transaction.previousSidebarNavigation,
  });

  for (const snapshot of transaction.previousThreads) {
    queryClient.setQueryData(threadQueryKey(snapshot.id), snapshot.thread);
  }
}

export async function settleArchiveThreadsTransaction({
  queryClient,
  response,
  transaction,
}: SettleArchiveThreadsTransactionArgs): Promise<void> {
  const queryKeys = [
    threadsQueryKey(),
    sidebarNavigationQueryKey(),
    threadSearchQueryKeyPrefix(),
    ...(
      response?.archivedThreadIds ??
      transaction?.archivedThreadIds ??
      []
    ).map(threadQueryKey),
  ];

  try {
    await Promise.all(
      queryKeys.map((queryKey) => queryClient.cancelQueries({ queryKey })),
    );
    await Promise.all(
      queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  } finally {
    transaction?.releasePendingArchives();
  }
}

export async function beginDeleteThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<DeleteThreadTransaction> {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
    queryClient.cancelQueries({ queryKey: sidebarNavigationQueryKey() }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadWithRuntime>(
    threadQueryKey(threadId),
  );

  const previousThreadLists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previousSidebarNavigation =
    snapshotCachedSidebarNavigation(queryClient);

  const threadIds = [
    ...getCachedThreadTreeIds({
      queryClient,
      matchesRoot: (thread) => thread.id === threadId,
    }),
  ];

  if (!threadIds.includes(threadId)) threadIds.push(threadId);
  await Promise.all(
    threadIds.map((id) =>
      queryClient.cancelQueries({ queryKey: threadQueryKey(id) }),
    ),
  );
  const previousThreads = getCachedThreadSnapshots({ queryClient, threadIds });
  const environmentId = previousThread?.environmentId;

  for (const id of threadIds)
    removeThreadScopedQueries({ queryClient, threadId: id });
  removeEnvironmentScopedQueries({ environmentId, queryClient });
  const removedIds = new Set(threadIds);
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (list) =>
    list.filter((thread) => !removedIds.has(thread.id)),
  );

  return {
    environmentId,
    inboxPrediction: predictInboxSnapshot(queryClient, (snapshot) =>
      removeInboxThreads(snapshot, threadIds),
    ),
    threadIds,
    previousSidebarNavigation,
    previousThreads,
    previousThreadLists,
  };
}

export function rollbackDeleteThreadTransaction({
  queryClient,
  transaction,
}: RollbackDeleteThreadTransactionArgs): void {
  if (!transaction) return;
  transaction.inboxPrediction.discard();

  for (const snapshot of transaction.previousThreads)
    queryClient.setQueryData(threadQueryKey(snapshot.id), snapshot.thread);
  restoreThreadListMembership({
    queryClient,
    threadIds: new Set(transaction.threadIds),
    previousThreadLists: transaction.previousThreadLists,
    previousSidebarNavigation: transaction.previousSidebarNavigation,
  });
}

export function settleDeleteThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: SettleDeleteThreadTransactionArgs): void {
  transaction?.inboxPrediction.settle();

  for (const id of transaction?.threadIds ?? [threadId])
    removeThreadScopedQueries({ queryClient, threadId: id });
  removeEnvironmentScopedQueries({
    environmentId: transaction?.environmentId,
    queryClient,
  });
  invalidateThreadDeleteQueries({ queryClient });
}

export function applyThreadReadStateResult({
  queryClient,
  thread,
}: ThreadRuntimeCacheArgs): void {
  queryClient.setQueryData<ThreadWithRuntime>(
    threadQueryKey(thread.id),
    thread,
  );
  updateThreadInLists({ queryClient, thread });
}

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import type {
  ClientTurnRequestId,
  Environment,
  Host,
  PromptHistoryEntry,
  ResolvedThreadExecutionOptions,
  ThreadListEntry,
  ThreadQueuedMessage,
  ThreadRuntimeState,
  ThreadStatus,
  ThreadWithRuntime,
} from "@omnyo/domain";
import type {
  CreateQueuedMessageRequest,
  PromptHistoryResponse,
  SendMessageResponse,
  SendQueuedMessageResponse,
  SendQueuedMessageMode,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  ThreadSearchResponse,
  ThreadTimelineResponse,
  SystemAppUpdateStatus,
  TimelineRow,
  TimelineUserConversationRow,
  UpdateQueuedMessageRequest,
} from "@omnyo/server-contract";
import type { AppCreateThreadRequest } from "@omnyo/client-core";
import { buildOptimisticUserMessageRow } from "./optimistic-user-message";
import {
  confirmPendingQueuedMessageRemoval,
  mergePendingComposerQueuedMessages,
  releasePendingComposerQueuedMessage,
  releasePendingQueuedMessageRemoval,
  retainPendingComposerQueuedMessage,
  retainPendingComposerThreadState,
  retainPendingQueuedMessageRemoval,
  settlePendingComposerThreadState,
} from "./pending-composer-cache-owner";
import {
  acceptPendingSentMessage,
  addPendingSentMessage,
  removePendingSentMessage,
} from "./pending-sent-messages";
import { prependPromptHistoryEntry } from "@/lib/prompt-history";
import { readCachedThreadDispatchWait } from "./dispatch-readiness-cache-owner";
import {
  localQueuedMessageWork,
  withLocalThreadWork,
  type LocalQueuedMessage,
} from "./local-thread-work";
import { carryQueuedMessageRenderKey } from "./queued-message-render-keys";
import {
  applyQueuedMessageReorder,
  collectLeadQueuedMessageGroupIds,
  preserveLeadQueuedMessageGroupAfterReorder,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import type {
  EditMessageMutationRequest,
  SendThreadMessageMutationRequest,
} from "../mutations/mutation-request-types";
import {
  optimisticallyInsertThread,
  applyToCachedThreadListsAndSidebarNavigation,
  getCachedSidebarNavigationThreads,
  updateCachedThread,
} from "./query-cache";
import {
  predictInboxSnapshot,
  type InboxPrediction,
} from "./inbox-snapshot-cache-owner";
import {
  scheduleInboxSend,
  startInboxTurn,
  stopInboxTurn,
} from "@/lib/inbox-predictions";
import {
  getCachedThreadLists,
  iterateThreadListCacheEntries,
} from "./thread-list-cache-data";
import {
  environmentQueryKey,
  hostsQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKeyPrefix,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  systemAppUpdateQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKeyPrefix,
  threadsQueryKey,
  threadTimelineQueryKeyPrefix,
  threadTimelineTurnSummaryDetailsQueryKeyPrefix,
} from "../queries/query-keys";
import { threadDefaultExecutionOptionsQueryKey } from "../queries/thread-default-execution-options-query";
import {
  invalidateProjectPromptHistoryQueries,
  invalidateThreadAcceptedMessageQueriesWithoutRealtime,
  invalidateThreadQueuedMessageListQuery,
  invalidateThreadQueueQueries,
  markThreadAcceptedMessageQueriesStale,
  invalidateThreadQueuedMessageSendQueries,
  invalidateThreadListMembershipQueries,
  refetchThreadListsAfterComposerThreadCreate,
} from "./mutation-cache-effects";

interface ThreadIdCacheArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface PrefetchThreadQueuedMessagesArgs extends ThreadIdCacheArgs {
  load: (signal: AbortSignal) => Promise<ThreadQueuedMessageListResponse>;
}

type ThreadBannerActivityKind = "goal" | "plan";

interface BeginCreateThreadTransactionArgs {
  queryClient: QueryClient;
}

interface CreateThreadSuccessArgs {
  queryClient: QueryClient;
  request: AppCreateThreadRequest;
  thread: ThreadResponse;
}

interface SendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
}

interface CreateQueuedMessageRequestWithThreadId extends CreateQueuedMessageRequest {
  id: string;
}

interface CreateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId;
}

interface UpdateQueuedMessageRequestWithThreadId extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface UpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
}

interface RollbackUpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
  transaction: UpdateQueuedMessageTransaction | undefined;
}

interface RemoveQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendQueuedMessageRequest extends RemoveQueuedMessageRequest {
  mode: SendQueuedMessageMode;
  requestId?: ClientTurnRequestId;
}

interface RemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
}

interface SendQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
}

interface RollbackSendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
  transaction: SendThreadMessageTransaction | undefined;
}

interface RollbackCreateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId;
  transaction: CreateQueuedMessageTransaction | undefined;
}

interface RollbackRemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessageSendResultArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
  result: Exclude<SendQueuedMessageResponse, { delivery: "already-sent" }>;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplySendThreadMessageSuccessArgs {
  queryClient: QueryClient;
  realtimeConnected: boolean;
  request: SendThreadMessageMutationRequest;
  result: SendMessageResponse;
  transaction: SendThreadMessageTransaction | undefined;
}

interface QueuedMessageSuccessArgs {
  queryClient: QueryClient;
  queuedMessage: ThreadQueuedMessage;
  threadId: string;
  transaction: CreateQueuedMessageTransaction | undefined;
}

interface ReorderQueuedMessageRequest extends QueuedMessageReorderRequest {
  id: string;
}

interface SetQueuedMessageGroupBoundaryRequest {
  groupBoundaryQueuedMessageId: string;
  id: string;
}

interface ReorderQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
}

interface SetQueuedMessageGroupBoundaryTransactionArgs {
  queryClient: QueryClient;
  request: SetQueuedMessageGroupBoundaryRequest;
}

interface RollbackQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
  transaction: ReorderQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessagesResultArgs {
  queryClient: QueryClient;
  queuedMessages: ThreadQueuedMessageListResponse;
  request: Pick<ReorderQueuedMessageRequest, "id">;
}

interface RollbackStopThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: StopThreadTransaction | undefined;
}

interface BuildAcceptedPromptHistoryEntryArgs {
  createdAt: number;
  input: PromptHistoryEntry["input"];
}

interface BuildOptimisticQueuedMessageParams {
  createdAt: number;
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId & { sendAt?: number };
  waitingOn?: NonNullable<ThreadQueuedMessage["waitingOn"]>;
}

interface SendThreadMessageAcceptedTurnTransaction {
  kind: "accepted-turn";
  optimisticCreatedAt: number;
  optimisticRowId: string;
  optimisticThreadDataUpdateCount: number | null;
  previousThread: ThreadResponse | undefined;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
  inboxPrediction: InboxPrediction;
}

interface SendThreadMessageQueuedTransaction {
  kind: "queued-message";
  inboxPrediction: InboxPrediction | null;
  optimisticCreatedAt: number;
  optimisticQueuedMessageId: string;
  previousThreadDataUpdateCount: number | null;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
}

export type SendThreadMessageTransaction =
  | SendThreadMessageAcceptedTurnTransaction
  | SendThreadMessageQueuedTransaction;

export interface ReorderQueuedMessageTransaction {
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
}

export interface CreateQueuedMessageTransaction {
  optimisticCreatedAt: number;
  optimisticQueuedMessageId: string;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
}

export interface UpdateQueuedMessageTransaction {
  optimisticUpdatedAt: number | null;
  previousQueuedMessage: ThreadQueuedMessage | undefined;
}

export interface RemoveQueuedMessageTransaction {
  pendingStatusToken: string | null;
  inboxPrediction: InboxPrediction | null;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
  optimisticCreatedAt: number | null;
  optimisticQueueDataUpdateCount: number;
  optimisticRowIds: readonly string[];
  optimisticThreadDataUpdateCount: number | null;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  previousThread: ThreadResponse | undefined;
  removedQueuedMessageIds: readonly string[];
}

export interface StopThreadTransaction {
  previousThread: ThreadResponse | undefined;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
  inboxPrediction: InboxPrediction;
  optimisticThreadDataUpdateCount: number | null;
}

interface TimelineSnapshot {
  queryKey: QueryKey;
  previous: ThreadTimelineResponse;
  optimisticDataUpdateCount: number;
}

export interface EditMessageTransaction {
  inboxPrediction: InboxPrediction | null;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
  optimisticThreadDataUpdateCount: number | null;
  pendingStatusToken: string | null;
  previousThread: ThreadResponse | undefined;
  timelineSnapshots: readonly TimelineSnapshot[];
}

interface EditMessageTransactionArgs {
  queryClient: QueryClient;
  request: EditMessageMutationRequest & { messageId: string };
}

interface SettleEditMessageTransactionArgs {
  queryClient: QueryClient;
  threadId: string;
  transaction: EditMessageTransaction | undefined;
}

function buildAcceptedPromptHistoryEntry({
  createdAt,
  input,
}: BuildAcceptedPromptHistoryEntryArgs): PromptHistoryEntry {
  return {
    id: `optimistic-prompt-history:${nanoid()}`,
    createdAt,
    input,
  };
}

function buildQueuedPromptHistoryEntry(
  queuedMessage: ThreadQueuedMessage,
): PromptHistoryEntry {
  return {
    id: `queued-message:${queuedMessage.id}`,
    createdAt: queuedMessage.createdAt,
    input: queuedMessage.content,
  };
}

function applyQueuedMessageGroupBoundary({
  groupBoundaryQueuedMessageId,
  queuedMessages,
}: {
  groupBoundaryQueuedMessageId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
}): ThreadQueuedMessage[] {
  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === groupBoundaryQueuedMessageId,
  );

  if (boundaryIndex === -1) return [...queuedMessages];

  return queuedMessages.map((queuedMessage, index) => ({
    ...queuedMessage,
    groupWithNext: index < boundaryIndex,
  }));
}

function queuedMessageSendGroup(
  queuedMessages: readonly ThreadQueuedMessage[] | undefined,
  queuedMessageId: string,
): ThreadQueuedMessage[] {
  if (!queuedMessages) return [];

  const queuedMessageIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === queuedMessageId,
  );

  if (queuedMessageIndex === -1) return [];

  if (queuedMessageIndex !== 0) return [queuedMessages[queuedMessageIndex]!];

  const group: ThreadQueuedMessage[] = [];

  for (const queuedMessage of queuedMessages) {
    group.push(queuedMessage);

    if (!queuedMessage.groupWithNext) break;
  }

  return group;
}

function removeQueuedMessagesAndRepairGroupEdges(
  queuedMessages: ThreadQueuedMessageListResponse | undefined,
  removeIds: ReadonlySet<string>,
): ThreadQueuedMessageListResponse | undefined {
  if (!queuedMessages) return queuedMessages;

  return queuedMessages.flatMap((queuedMessage, index) => {
    if (removeIds.has(queuedMessage.id)) return [];
    const nextQueuedMessage = queuedMessages[index + 1];

    if (
      nextQueuedMessage &&
      removeIds.has(nextQueuedMessage.id) &&
      queuedMessage.groupWithNext
    ) {
      return [{ ...queuedMessage, groupWithNext: false }];
    }

    return [queuedMessage];
  });
}

function getCachedDefaultExecutionOptions(
  queryClient: QueryClient,
  threadId: string,
): ResolvedThreadExecutionOptions | null | undefined {
  return queryClient.getQueryData<ResolvedThreadExecutionOptions | null>(
    threadDefaultExecutionOptionsQueryKey(threadId),
  );
}

function buildOptimisticQueuedMessage({
  createdAt,
  queryClient,
  request,
  waitingOn,
}: BuildOptimisticQueuedMessageParams): ThreadQueuedMessage {
  const defaultExecutionOptions = getCachedDefaultExecutionOptions(
    queryClient,
    request.id,
  );

  const scheduledSendAt =
    request.sendAt !== undefined && request.sendAt > createdAt
      ? request.sendAt
      : null;

  return {
    id: `optimistic-queued-${nanoid()}`,
    origin: null,
    originPluginId: null,
    initiator: "user",
    senderThreadId: null,
    threadId: request.id,
    content: request.input,
    model: request.model ?? defaultExecutionOptions?.model ?? "pending",
    reasoningLevel:
      request.reasoningLevel ??
      defaultExecutionOptions?.reasoningLevel ??
      "medium",
    permissionMode:
      request.permissionMode ??
      defaultExecutionOptions?.permissionMode ??
      "auto",
    serviceTier:
      request.serviceTier ?? defaultExecutionOptions?.serviceTier ?? "default",
    groupWithNext: false,
    sendAt: scheduledSendAt,
    waitingOn:
      waitingOn ?? (scheduledSendAt === null ? null : { kind: "time" }),
    failureReason: null,
    payload: { kind: "inline" },
    editable: true,
    createdAt,
    updatedAt: createdAt,
  };
}

function insertOptimisticQueuedMessage({
  queryClient,
  request,
  waitingOn,
}: {
  queryClient: QueryClient;
  request: CreateQueuedMessageRequestWithThreadId & { sendAt?: number };
  waitingOn?: NonNullable<ThreadQueuedMessage["waitingOn"]>;
}): CreateQueuedMessageTransaction {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const optimisticCreatedAt = Date.now();

  const optimisticQueuedMessage = buildOptimisticQueuedMessage({
    createdAt: optimisticCreatedAt,
    queryClient,
    request,
    waitingOn,
  });

  beginComposerThreadState(
    queryClient,
    request.id,
    optimisticQueuedMessage.id,
    "queued",
    optimisticQueuedMessage,
  );

  retainPendingComposerQueuedMessage(
    queryClient,
    request.id,
    optimisticQueuedMessage,
  );

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) => [
      ...(currentQueuedMessages ?? []),
      optimisticQueuedMessage,
    ],
  );

  return {
    optimisticCreatedAt,
    optimisticQueuedMessageId: optimisticQueuedMessage.id,
    listRollback: applyOptimisticThreadListState(
      queryClient,
      request.id,
      (thread) =>
        withLocalThreadWork({ ...thread, queuedWork: "waiting" }, [
          localQueuedMessageWork(thread, optimisticQueuedMessage),
        ]),
    ),
  };
}

function cancelComposerThreadStateReads(
  queryClient: QueryClient,
  threadId: string,
): void {
  for (const queryKey of [
    sidebarNavigationQueryKey(),
    threadsQueryKey(),
    threadQueryKey(threadId),
    threadDetailBootstrapQueryKey(threadId),
  ])
    void queryClient.cancelQueries({ queryKey });
}

function beginComposerThreadState(
  queryClient: QueryClient,
  threadId: string,
  token: string,
  kind: "active" | "queued",
  queuedMessage: LocalQueuedMessage | null = null,
): void {
  cancelComposerThreadStateReads(queryClient, threadId);
  retainPendingComposerThreadState(
    queryClient,
    threadId,
    token,
    kind,
    queryClient.getQueryData<ThreadResponse>(threadQueryKey(threadId)) ??
      getCachedSidebarNavigationThreads(queryClient).find(
        (thread) => thread.id === threadId,
      ),
    queuedMessage,
  );
}

function settleComposerThreadState(
  queryClient: QueryClient,
  threadId: string,
  token: string,
  outcome: "sent" | "queued" | "failed",
): void {
  cancelComposerThreadStateReads(queryClient, threadId);

  const restore = settlePendingComposerThreadState(
    queryClient,
    threadId,
    token,
    outcome,
  );

  if (restore !== null) {
    applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
      threads.map((thread) =>
        thread.id === threadId && thread.updatedAt <= restore.updatedAt
          ? { ...thread, ...restore }
          : thread,
      ),
    );
    updateCachedThread(queryClient, threadId, (thread) =>
      thread.updatedAt <= restore.updatedAt
        ? { ...thread, ...restore }
        : thread,
    );
  }

  for (const queryKey of [
    sidebarNavigationQueryKey(),
    threadsQueryKey(),
    threadQueryKey(threadId),
  ]) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

function applyOptimisticThreadListState(
  queryClient: QueryClient,
  threadId: string,
  update: (thread: ThreadListEntry) => ThreadListEntry,
): ReadonlyMap<ThreadListEntry, ThreadListEntry> {
  const lists = getCachedThreadLists(queryClient, {
    queryKey: threadsQueryKey(),
  });

  const previous = lists.map(({ queryKey, data }) => ({
    queryKey,
    thread: [...iterateThreadListCacheEntries(data)].find(
      (thread) => thread.id === threadId,
    ),
  }));

  const previousSidebar = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => (thread.id === threadId ? update(thread) : thread)),
  );
  const rollback = new Map<ThreadListEntry, ThreadListEntry>();

  for (const snapshot of previous) {
    const current = getCachedThreadLists(queryClient, {
      queryKey: snapshot.queryKey,
    }).find((entry) => entry.queryKey === snapshot.queryKey);

    const thread =
      current === undefined
        ? undefined
        : [...iterateThreadListCacheEntries(current.data)].find(
            (entry) => entry.id === threadId,
          );

    if (thread !== undefined && snapshot.thread !== undefined)
      rollback.set(thread, snapshot.thread);
  }

  const currentSidebar = getCachedSidebarNavigationThreads(queryClient).find(
    (thread) => thread.id === threadId,
  );

  if (currentSidebar !== undefined && previousSidebar !== undefined)
    rollback.set(currentSidebar, previousSidebar);

  return rollback;
}

function restoreOptimisticThreadLists(
  queryClient: QueryClient,
  rollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>,
  project: (thread: ThreadListEntry) => ThreadListEntry = (thread) => thread,
): void {
  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => {
      const previous = rollback.get(thread);

      return previous === undefined ? thread : project(previous);
    }),
  );
}

function restoreQueuedMessageSnapshotIfUnchanged({
  optimisticQueueDataUpdateCount,
  previousQueuedMessages,
  queryClient,
  threadId,
}: {
  optimisticQueueDataUpdateCount: number;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  queryClient: QueryClient;
  threadId: string;
}): boolean {
  const queryKey = threadQueuedMessagesQueryKey(threadId);

  if (
    queryClient.getQueryState(queryKey)?.dataUpdateCount !==
    optimisticQueueDataUpdateCount
  ) {
    return false;
  }

  const restored = previousQueuedMessages ?? [];
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(queryKey, restored);

  updateCachedQueuedWork(queryClient, threadId);

  return true;
}

function queuedWorkOf(
  messages: readonly ThreadQueuedMessage[],
): ThreadListEntry["queuedWork"] {
  return messages.some((message) => message.failureReason !== null)
    ? "failed"
    : messages.length > 0
      ? "waiting"
      : "none";
}

function workMentions(
  thread: ThreadListEntry,
  ids: ReadonlySet<string>,
): boolean {
  return (
    thread.work !== null &&
    (thread.work.activity.some((activity) => ids.has(activity.id)) ||
      thread.work.waits.some((wait) => ids.has(wait.id)))
  );
}

function withQueuedMessageWork(
  thread: ThreadListEntry,
  messages: readonly ThreadQueuedMessage[],
  removedIds: ReadonlySet<string>,
): ThreadListEntry {
  const next: ThreadListEntry = {
    ...thread,
    queuedWork: queuedWorkOf(messages),
    work:
      thread.work === null
        ? null
        : {
            ...thread.work,
            activity: thread.work.activity.filter(
              (activity) => !removedIds.has(activity.id),
            ),
            waits: thread.work.waits.filter((wait) => !removedIds.has(wait.id)),
          },
  };

  return withLocalThreadWork(
    next,
    messages.map((message) => localQueuedMessageWork(next, message)),
  );
}

function updateCachedQueuedWork(
  queryClient: QueryClient,
  threadId: string,
  removedIds: ReadonlySet<string> = new Set(),
): void {
  const messages = queryClient.getQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
  );

  if (messages === undefined) return;

  const queuedWork = queuedWorkOf(messages);

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) =>
      thread.id === threadId &&
      (thread.queuedWork !== queuedWork || workMentions(thread, removedIds))
        ? withQueuedMessageWork(thread, messages, removedIds)
        : thread,
    ),
  );
}

function removeOptimisticQueuedMessage(
  queryClient: QueryClient,
  threadId: string,
  optimisticQueuedMessageId: string,
): boolean {
  releasePendingComposerQueuedMessage(
    queryClient,
    threadId,
    optimisticQueuedMessageId,
  );
  let removed = false;
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) return currentQueuedMessages;

      const nextQueuedMessages = currentQueuedMessages.filter(
        (queuedMessage) => queuedMessage.id !== optimisticQueuedMessageId,
      );

      removed = nextQueuedMessages.length !== currentQueuedMessages.length;

      return removed ? nextQueuedMessages : currentQueuedMessages;
    },
  );

  if (removed)
    updateCachedQueuedWork(
      queryClient,
      threadId,
      new Set([optimisticQueuedMessageId]),
    );

  return removed;
}

function reconcileAuthoritativeQueuedMessage({
  insertWhenMissing,
  optimisticQueuedMessageId,
  queryClient,
  queuedMessage,
  threadId,
}: {
  insertWhenMissing: boolean;
  optimisticQueuedMessageId: string | null;
  queryClient: QueryClient;
  queuedMessage: ThreadQueuedMessage;
  threadId: string;
}): void {
  if (optimisticQueuedMessageId !== null)
    releasePendingComposerQueuedMessage(
      queryClient,
      threadId,
      optimisticQueuedMessageId,
    );
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) {
        return insertWhenMissing ? [queuedMessage] : currentQueuedMessages;
      }

      const authoritativeIndex = currentQueuedMessages.findIndex(
        (currentQueuedMessage) => currentQueuedMessage.id === queuedMessage.id,
      );

      if (authoritativeIndex !== -1) {
        const nextQueuedMessages = currentQueuedMessages.filter(
          (message) => message.id !== optimisticQueuedMessageId,
        );

        const index = nextQueuedMessages.findIndex(
          (message) => message.id === queuedMessage.id,
        );

        nextQueuedMessages[index] = queuedMessage;

        return nextQueuedMessages;
      }

      const optimisticIndex =
        optimisticQueuedMessageId === null
          ? -1
          : currentQueuedMessages.findIndex(
              (currentQueuedMessage) =>
                currentQueuedMessage.id === optimisticQueuedMessageId,
            );

      if (optimisticIndex !== -1 && optimisticQueuedMessageId !== null) {
        carryQueuedMessageRenderKey(
          queryClient,
          optimisticQueuedMessageId,
          queuedMessage.id,
        );
        const nextQueuedMessages = [...currentQueuedMessages];
        nextQueuedMessages[optimisticIndex] = queuedMessage;

        return nextQueuedMessages;
      }

      return insertWhenMissing
        ? [...currentQueuedMessages, queuedMessage]
        : currentQueuedMessages;
    },
  );
}

function removeCachedQueuedMessage({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): RemoveQueuedMessageTransaction {
  const queryKey = threadQueuedMessagesQueryKey(request.id);

  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  const removedIds = new Set([request.queuedMessageId]);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      removeQueuedMessagesAndRepairGroupEdges(
        currentQueuedMessages,
        removedIds,
      ),
  );

  const remaining =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  return {
    pendingStatusToken: null,
    inboxPrediction: null,
    listRollback:
      remaining === undefined
        ? new Map()
        : applyOptimisticThreadListState(queryClient, request.id, (thread) =>
            withQueuedMessageWork(thread, remaining, removedIds),
          ),
    optimisticCreatedAt: null,
    optimisticQueueDataUpdateCount:
      queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0,
    optimisticRowIds: [],
    optimisticThreadDataUpdateCount: null,
    previousQueuedMessages,
    previousThread: undefined,
    removedQueuedMessageIds: [],
  };
}

function prependProjectPromptHistory(
  queryClient: QueryClient,
  projectId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    projectPromptHistoryQueryKey(projectId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function prependThreadPromptHistory(
  queryClient: QueryClient,
  threadId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    threadPromptHistoryQueryKey(threadId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function hasUnmanagedCheckoutIntent(request: AppCreateThreadRequest): boolean {
  return (
    request.environment.type === "host" &&
    request.environment.workspace.type === "unmanaged" &&
    request.environment.workspace.branch !== undefined
  );
}

export function predictCachedThreadSendWait(
  queryClient: QueryClient,
  request: Pick<SendThreadMessageMutationRequest, "id" | "mode" | "sendAt">,
): NonNullable<ThreadQueuedMessage["waitingOn"]> | undefined {
  return optimisticSendWait(
    queryClient,
    request,
    queryClient.getQueryData<ThreadResponse>(threadQueryKey(request.id)),
  );
}

function cachedThreadHost(
  queryClient: QueryClient,
  thread: ThreadWithRuntime | undefined,
): Host | undefined {
  if (thread?.environmentId == null) return undefined;

  const hostId = queryClient.getQueryData<Pick<Environment, "hostId">>(
    environmentQueryKey(thread.environmentId),
  )?.hostId;

  if (hostId === undefined) return undefined;

  return queryClient
    .getQueryData<Host[]>(hostsQueryKey())
    ?.find((host) => host.id === hostId);
}

function isMachineWaitingForExecution(host: Host): boolean {
  return (
    host.lifecycle.suspendedAt !== null ||
    host.lifecycle.phase === "suspending" ||
    host.lifecycle.phase === "suspended" ||
    host.lifecycle.phase === "resuming"
  );
}

function optimisticSendWait(
  queryClient: QueryClient,
  request: Pick<
    SendThreadMessageMutationRequest,
    "id" | "mode" | "sendAt" | "sendNow" | "expectedPluginWait"
  >,
  thread: ThreadWithRuntime | undefined,
): NonNullable<ThreadQueuedMessage["waitingOn"]> | undefined {
  const sendNow = request.sendNow === true;

  if (!sendNow && request.expectedPluginWait !== undefined)
    return request.expectedPluginWait;

  const resting =
    thread === undefined ||
    thread.status === "idle" ||
    thread.status === "pending" ||
    thread.status === "error";

  if (
    resting &&
    queryClient.getQueryData<SystemAppUpdateStatus>(systemAppUpdateQueryKey())
      ?.newTurnsPausedForUpdate === true
  )
    return { kind: "server-update" };

  if (!sendNow && request.sendAt !== undefined && request.sendAt > Date.now())
    return { kind: "time" };

  if (thread?.status === "stopping") return { kind: "stopping" };

  const host = cachedThreadHost(queryClient, thread);

  if (host !== undefined && isMachineWaitingForExecution(host))
    return { kind: "host-offline", hostName: host.name };

  if (resting && host?.availability === "away")
    return { kind: "host-away", hostName: host.name };

  if (
    host?.status === "disconnected" &&
    (resting || request.mode === "queue-if-active")
  )
    return { kind: "host-offline", hostName: host.name };

  if (thread?.status === "active" || thread?.status === "starting")
    return request.mode === "queue-if-active"
      ? { kind: "thread-busy" }
      : undefined;

  if (sendNow) return undefined;

  return readCachedThreadDispatchWait({ queryClient, threadId: request.id });
}

function applyOptimisticAcceptedTurnThreadState({
  queryClient,
  threadId,
}: {
  queryClient: QueryClient;
  threadId: string;
}): ReadonlyMap<ThreadListEntry, ThreadListEntry> {
  applyOptimisticAcceptedTurnDetailState({ queryClient, threadId });

  return applyOptimisticAcceptedTurnListState({ queryClient, threadId });
}

function withAcceptedTurnStatus<
  T extends { status: ThreadStatus; runtime: ThreadRuntimeState },
>(thread: T): T {
  return {
    ...thread,
    status: "active",
    runtime: {
      ...thread.runtime,
      displayStatus:
        thread.runtime.displayStatus === "waiting-for-host"
          ? "waiting-for-host"
          : "active",
    },
  };
}

function applyOptimisticAcceptedTurnDetailState({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  updateCachedThread(queryClient, threadId, (thread) =>
    withLocalThreadWork(withAcceptedTurnStatus(thread)),
  );
}

function applyOptimisticAcceptedTurnListState({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): ReadonlyMap<ThreadListEntry, ThreadListEntry> {
  const queuedWork =
    (queryClient.getQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(threadId),
    )?.length ?? 0) > 0
      ? "waiting"
      : "none";

  return applyOptimisticThreadListState(queryClient, threadId, (thread) =>
    withLocalThreadWork({ ...withAcceptedTurnStatus(thread), queuedWork }),
  );
}

function isRestingThreadStatus(status: ThreadStatus): boolean {
  return status === "idle" || status === "pending" || status === "error";
}

function restoreOptimisticThreadSnapshotIfUnchanged({
  optimisticThreadDataUpdateCount,
  previousThread,
  queryClient,
  threadId,
}: {
  optimisticThreadDataUpdateCount: number | null;
  previousThread: ThreadResponse | undefined;
  queryClient: QueryClient;
  threadId: string;
}): boolean {
  if (
    optimisticThreadDataUpdateCount === null ||
    previousThread === undefined ||
    queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount !==
      optimisticThreadDataUpdateCount
  ) {
    return false;
  }

  queryClient.setQueryData<ThreadResponse>(
    threadQueryKey(threadId),
    previousThread,
  );

  return true;
}

function removePendingSentMessages(
  queryClient: QueryClient,
  threadId: string,
  rowIds: readonly string[],
): void {
  for (const rowId of rowIds)
    removePendingSentMessage(queryClient, threadId, rowId);
}

function applyOptimisticStopRequest({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): ReadonlyMap<ThreadListEntry, ThreadListEntry> {
  updateCachedThread(queryClient, threadId, (thread) =>
    withLocalThreadWork({
      ...thread,
      status: "stopping",
      runtime: { ...thread.runtime, displayStatus: "stopping" },
    }),
  );

  return applyOptimisticThreadListState(queryClient, threadId, (thread) =>
    withLocalThreadWork({
      ...thread,
      status: "stopping",
      runtime: { ...thread.runtime, displayStatus: "stopping" },
    }),
  );
}

function clearThreadBannerActivity(
  thread: ThreadListEntry,
  threadId: string,
  kind: ThreadBannerActivityKind,
): ThreadListEntry {
  if (thread.id !== threadId) {
    return thread;
  }

  return {
    ...thread,
    activity: {
      ...thread.activity,
      ...(kind === "plan"
        ? { activePlanModeCount: 0 }
        : { activeGoalCount: 0 }),
    },
  };
}

function applyAuthoritativeThreadBannerCancellation({
  kind,
  queryClient,
  threadId,
}: ThreadIdCacheArgs & { kind: ThreadBannerActivityKind }): void {
  for (const [
    queryKey,
    timeline,
  ] of queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  })) {
    if (!timeline) {
      continue;
    }

    queryClient.setQueryData<ThreadTimelineResponse>(queryKey, {
      ...timeline,
      ...(kind === "plan" ? { activePromptMode: null } : { goal: null }),
    });
  }

  applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
    threads.map((thread) => clearThreadBannerActivity(thread, threadId, kind)),
  );

  queryClient.setQueriesData<ThreadSearchResponse>(
    { queryKey: threadSearchQueryKeyPrefix() },
    (response) => {
      if (!response) {
        return response;
      }

      const mapGroup = (group: ThreadSearchResponse["active"]) => ({
        ...group,
        results: group.results.map((result) => ({
          ...result,
          thread: clearThreadBannerActivity(result.thread, threadId, kind),
        })),
      });

      return {
        active: mapGroup(response.active),
        archived: mapGroup(response.archived),
      };
    },
  );
}

export function applyThreadPlanCancellationResult(
  args: ThreadIdCacheArgs,
): void {
  applyAuthoritativeThreadBannerCancellation({ ...args, kind: "plan" });
}

export function applyThreadGoalClearResult(args: ThreadIdCacheArgs): void {
  applyAuthoritativeThreadBannerCancellation({ ...args, kind: "goal" });
}

export async function beginCreateThreadTransaction({
  queryClient,
}: BeginCreateThreadTransactionArgs): Promise<void> {
  await queryClient.cancelQueries({ queryKey: threadsQueryKey() });
}

export function prefetchThreadQueuedMessages({
  load,
  queryClient,
  threadId,
}: PrefetchThreadQueuedMessagesArgs): Promise<void> {
  return queryClient.prefetchQuery<ThreadQueuedMessageListResponse>({
    queryKey: threadQueuedMessagesQueryKey(threadId),
    queryFn: async ({ signal }) =>
      mergePendingComposerQueuedMessages(
        queryClient,
        threadId,
        await load(signal),
      ),
  });
}

export function applyCreateThreadResult({
  queryClient,
  request,
  thread,
}: CreateThreadSuccessArgs): void {
  queryClient.setQueryData<ThreadResponse>(threadQueryKey(thread.id), thread);

  const environmentId =
    request.environment.type === "reuse"
      ? request.environment.environmentId
      : thread.environmentId;

  const cachedHostId =
    environmentId === null
      ? null
      : (queryClient.getQueryData<Environment>(
          environmentQueryKey(environmentId),
        )?.hostId ?? null);

  const selectedHostId =
    request.environment.type === "provider" &&
    request.environment.machine?.type === "existing"
      ? request.environment.machine.hostId
      : request.environment.type === "host"
        ? (request.environment.hostId ?? null)
        : null;

  optimisticallyInsertThread(
    queryClient,
    thread,
    cachedHostId ?? selectedHostId,
  );

  if (request.input.length > 0) {
    prependProjectPromptHistory(
      queryClient,
      request.projectId,
      buildAcceptedPromptHistoryEntry({
        createdAt: thread.createdAt,
        input: request.input,
      }),
    );
  }

  invalidateProjectPromptHistoryQueries({
    queryClient,
    projectId: request.projectId,
  });

  if (hasUnmanagedCheckoutIntent(request)) {
    queryClient.invalidateQueries({
      queryKey: projectSourceBranchesQueryKeyPrefix(request.projectId),
    });
  }

  refetchThreadListsAfterComposerThreadCreate({ queryClient });
}

export async function beginSendThreadMessageTransaction({
  queryClient,
  request,
}: SendThreadMessageTransactionArgs): Promise<SendThreadMessageTransaction> {
  const readsCancelled = Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(request.id) }),
    queryClient.cancelQueries({
      queryKey: threadQueuedMessagesQueryKey(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineQueryKeyPrefix(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(request.id),
    }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );

  const waitingOn = optimisticSendWait(queryClient, request, previousThread);

  if (waitingOn !== undefined) {
    await readsCancelled;

    const transaction = insertOptimisticQueuedMessage({
      queryClient,
      request,
      waitingOn,
    });

    const { sendAt } = request;

    return {
      kind: "queued-message",
      inboxPrediction:
        waitingOn.kind === "time" && sendAt !== undefined
          ? predictInboxSnapshot(queryClient, (snapshot) =>
              scheduleInboxSend(snapshot, request.id, sendAt),
            )
          : null,
      previousThreadDataUpdateCount:
        queryClient.getQueryState(threadQueryKey(request.id))
          ?.dataUpdateCount ?? null,
      ...transaction,
    };
  }

  const optimisticCreatedAt = Date.now();

  const optimisticRow = buildOptimisticUserMessageRow({
    clientRequestId: request.requestId ?? null,
    createdAt: optimisticCreatedAt,
    input: request.input,
    mode: request.mode,
    threadId: request.id,
    threadStatus: previousThread?.status ?? null,
  });

  beginComposerThreadState(queryClient, request.id, optimisticRow.id, "active");

  const listRollback = applyOptimisticAcceptedTurnListState({
    queryClient,
    threadId: request.id,
  });

  await readsCancelled;
  applyOptimisticAcceptedTurnDetailState({ queryClient, threadId: request.id });
  addPendingSentMessage(queryClient, request.id, optimisticRow);

  return {
    kind: "accepted-turn",
    inboxPrediction: predictInboxSnapshot(queryClient, (snapshot) =>
      startInboxTurn(snapshot, request.id),
    ),
    previousThread,
    listRollback,
    optimisticCreatedAt,
    optimisticRowId: optimisticRow.id,
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
      null,
  };
}

export function rollbackSendThreadMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackSendThreadMessageTransactionArgs): void {
  transaction?.inboxPrediction?.discard();

  if (transaction?.kind === "queued-message") {
    removeOptimisticQueuedMessage(
      queryClient,
      request.id,
      transaction.optimisticQueuedMessageId,
    );

    const hasQueuedMessages =
      (queryClient.getQueryData<ThreadQueuedMessageListResponse>(
        threadQueuedMessagesQueryKey(request.id),
      )?.length ?? 0) > 0;

    restoreOptimisticThreadLists(
      queryClient,
      transaction.listRollback,
      (thread) => ({
        ...thread,
        queuedWork: hasQueuedMessages ? "waiting" : "none",
      }),
    );

    settleComposerThreadState(
      queryClient,
      request.id,
      transaction.optimisticQueuedMessageId,
      "failed",
    );

    return;
  }

  if (transaction?.kind !== "accepted-turn") {
    return;
  }

  restoreOptimisticThreadLists(queryClient, transaction.listRollback);

  removePendingSentMessage(
    queryClient,
    request.id,
    transaction.optimisticRowId,
  );
  restoreOptimisticThreadSnapshotIfUnchanged({
    optimisticThreadDataUpdateCount:
      transaction.optimisticThreadDataUpdateCount,
    previousThread: transaction.previousThread,
    queryClient,
    threadId: request.id,
  });
  settleComposerThreadState(
    queryClient,
    request.id,
    transaction.optimisticRowId,
    "failed",
  );
}

export function applySendThreadMessageSuccess({
  queryClient,
  realtimeConnected,
  request,
  result,
  transaction,
}: ApplySendThreadMessageSuccessArgs): void {
  if (transaction?.kind === "accepted-turn")
    acceptPendingSentMessage(
      queryClient,
      request.id,
      transaction.optimisticRowId,
    );
  const optimisticCreatedAt = transaction?.optimisticCreatedAt ?? Date.now();

  if (result.delivery === "queued" && transaction?.kind === "accepted-turn")
    transaction.inboxPrediction.discard();
  else transaction?.inboxPrediction?.settle();

  if (result.delivery === "queued") {
    const optimisticTimelineRowRemoved =
      transaction?.kind === "accepted-turn"
        ? removePendingSentMessage(
            queryClient,
            request.id,
            transaction.optimisticRowId,
          )
        : false;

    reconcileAuthoritativeQueuedMessage({
      insertWhenMissing:
        transaction === undefined || optimisticTimelineRowRemoved,
      optimisticQueuedMessageId:
        transaction?.kind === "queued-message"
          ? transaction.optimisticQueuedMessageId
          : null,
      queryClient,
      queuedMessage: result.queuedMessage,
      threadId: request.id,
    });

    if (transaction?.kind === "accepted-turn" && optimisticTimelineRowRemoved) {
      restoreOptimisticThreadLists(
        queryClient,
        transaction.listRollback,
        (thread) => ({ ...thread, queuedWork: "waiting" }),
      );
      restoreOptimisticThreadSnapshotIfUnchanged({
        optimisticThreadDataUpdateCount:
          transaction.optimisticThreadDataUpdateCount,
        previousThread: transaction.previousThread,
        queryClient,
        threadId: request.id,
      });
    }

    prependThreadPromptHistory(
      queryClient,
      request.id,
      buildAcceptedPromptHistoryEntry({
        createdAt: optimisticCreatedAt,
        input: request.input,
      }),
    );
    invalidateThreadQueueQueries({ queryClient, threadId: request.id });

    if (transaction !== undefined)
      settleComposerThreadState(
        queryClient,
        request.id,
        transaction.kind === "accepted-turn"
          ? transaction.optimisticRowId
          : transaction.optimisticQueuedMessageId,
        result.delivery,
      );

    return;
  }

  if (transaction?.kind === "queued-message") {
    const optimisticQueuedMessageRemoved = removeOptimisticQueuedMessage(
      queryClient,
      request.id,
      transaction.optimisticQueuedMessageId,
    );

    if (optimisticQueuedMessageRemoved) {
      if (
        queryClient.getQueryState(threadQueryKey(request.id))
          ?.dataUpdateCount === transaction.previousThreadDataUpdateCount
      )
        applyOptimisticAcceptedTurnThreadState({
          queryClient,
          threadId: request.id,
        });
    }

    invalidateThreadQueuedMessageListQuery({
      queryClient,
      threadId: request.id,
    });
    void queryClient.invalidateQueries({
      queryKey: threadTimelineQueryKeyPrefix(request.id),
    });
  }

  prependThreadPromptHistory(
    queryClient,
    request.id,
    buildAcceptedPromptHistoryEntry({
      createdAt: optimisticCreatedAt,
      input: request.input,
    }),
  );

  const applyAcceptedMessageQueries = realtimeConnected
    ? markThreadAcceptedMessageQueriesStale
    : invalidateThreadAcceptedMessageQueriesWithoutRealtime;

  applyAcceptedMessageQueries({
    queryClient,
    threadId: request.id,
  });

  if (transaction !== undefined)
    settleComposerThreadState(
      queryClient,
      request.id,
      transaction.kind === "accepted-turn"
        ? transaction.optimisticRowId
        : transaction.optimisticQueuedMessageId,
      result.delivery === "stored" || result.delivery === "waiting"
        ? "sent"
        : result.delivery,
    );
}

export async function beginCreateQueuedMessageTransaction({
  queryClient,
  request,
}: CreateQueuedMessageTransactionArgs): Promise<CreateQueuedMessageTransaction> {
  await queryClient.cancelQueries({
    queryKey: threadQueuedMessagesQueryKey(request.id),
  });

  return insertOptimisticQueuedMessage({ queryClient, request });
}

export function rollbackCreateQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackCreateQueuedMessageTransactionArgs): void {
  if (!transaction) {
    return;
  }

  restoreOptimisticThreadLists(queryClient, transaction.listRollback);

  removeOptimisticQueuedMessage(
    queryClient,
    request.id,
    transaction.optimisticQueuedMessageId,
  );
  settleComposerThreadState(
    queryClient,
    request.id,
    transaction.optimisticQueuedMessageId,
    "failed",
  );
}

export function applyQueuedMessageCreateResult({
  queryClient,
  queuedMessage,
  threadId,
  transaction,
}: QueuedMessageSuccessArgs): void {
  if (transaction !== undefined)
    releasePendingComposerQueuedMessage(
      queryClient,
      threadId,
      transaction.optimisticQueuedMessageId,
    );
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) {
        return [queuedMessage];
      }

      if (
        currentQueuedMessages.some(
          (currentQueuedMessage) =>
            currentQueuedMessage.id === queuedMessage.id,
        )
      ) {
        return transaction === undefined
          ? currentQueuedMessages
          : currentQueuedMessages.filter(
              (message) => message.id !== transaction.optimisticQueuedMessageId,
            );
      }

      const optimisticQueuedMessageId =
        transaction?.optimisticQueuedMessageId ?? null;

      if (optimisticQueuedMessageId !== null) {
        const optimisticIndex = currentQueuedMessages.findIndex(
          (currentQueuedMessage) =>
            currentQueuedMessage.id === optimisticQueuedMessageId,
        );

        if (optimisticIndex !== -1) {
          carryQueuedMessageRenderKey(
            queryClient,
            optimisticQueuedMessageId,
            queuedMessage.id,
          );
          const nextQueuedMessages = [...currentQueuedMessages];
          nextQueuedMessages[optimisticIndex] = queuedMessage;

          return nextQueuedMessages;
        }
      }

      return [...currentQueuedMessages, queuedMessage];
    },
  );
  prependThreadPromptHistory(
    queryClient,
    threadId,
    buildQueuedPromptHistoryEntry(queuedMessage),
  );
  invalidateThreadQueueQueries({ queryClient, threadId });

  if (transaction !== undefined)
    settleComposerThreadState(
      queryClient,
      threadId,
      transaction.optimisticQueuedMessageId,
      "queued",
    );
}

export async function beginUpdateQueuedMessageTransaction({
  queryClient,
  request,
}: UpdateQueuedMessageTransactionArgs): Promise<UpdateQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  await queryClient.cancelQueries({ queryKey });

  const previousQueuedMessage = queryClient
    .getQueryData<ThreadQueuedMessageListResponse>(queryKey)
    ?.find((queuedMessage) => queuedMessage.id === request.queuedMessageId);

  const optimisticUpdatedAt = previousQueuedMessage
    ? Math.max(Date.now(), previousQueuedMessage.updatedAt + 1)
    : null;

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((queuedMessage) =>
        queuedMessage.id === request.queuedMessageId
          ? {
              ...queuedMessage,
              content: request.input,
              model: request.model ?? queuedMessage.model,
              serviceTier: request.serviceTier ?? queuedMessage.serviceTier,
              reasoningLevel:
                request.reasoningLevel ?? queuedMessage.reasoningLevel,
              permissionMode:
                request.permissionMode ?? queuedMessage.permissionMode,
              updatedAt: optimisticUpdatedAt ?? queuedMessage.updatedAt,
            }
          : queuedMessage,
      ),
  );

  return { optimisticUpdatedAt, previousQueuedMessage };
}

export function rollbackUpdateQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackUpdateQueuedMessageTransactionArgs): void {
  const previousQueuedMessage = transaction?.previousQueuedMessage;
  const optimisticUpdatedAt = transaction?.optimisticUpdatedAt;

  if (
    previousQueuedMessage !== undefined &&
    optimisticUpdatedAt !== null &&
    optimisticUpdatedAt !== undefined
  ) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      (currentQueuedMessages) =>
        currentQueuedMessages?.map((queuedMessage) =>
          queuedMessage.id === request.queuedMessageId &&
          queuedMessage.updatedAt === optimisticUpdatedAt
            ? {
                ...queuedMessage,
                content: previousQueuedMessage.content,
                updatedAt: previousQueuedMessage.updatedAt,
              }
            : queuedMessage,
        ),
    );
  }

  invalidateThreadQueueQueries({ queryClient, threadId: request.id });
}

export function applyQueuedMessageUpdateResult({
  queryClient,
  queuedMessage,
  threadId,
}: Omit<QueuedMessageSuccessArgs, "transaction">): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((currentQueuedMessage) =>
        currentQueuedMessage.id === queuedMessage.id
          ? queuedMessage
          : currentQueuedMessage,
      ) ?? [queuedMessage],
  );
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginRemoveQueuedMessageTransaction({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  await queryClient.cancelQueries({
    queryKey: threadQueuedMessagesQueryKey(request.id),
  });

  return removeCachedQueuedMessage({ queryClient, request });
}

function isPlainUserQueuedMessage(message: ThreadQueuedMessage): boolean {
  return (
    message.payload.kind === "inline" &&
    message.initiator === "user" &&
    message.senderThreadId === null &&
    message.messageSource === undefined
  );
}

function beginAcceptedQueuedMessageSend({
  previousQueuedMessages,
  previousThread,
  queryClient,
  request,
  sentGroup,
}: {
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  previousThread: ThreadResponse;
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
  sentGroup: readonly ThreadQueuedMessage[];
}): RemoveQueuedMessageTransaction {
  const queueKey = threadQueuedMessagesQueryKey(request.id);
  const removedIds = new Set(sentGroup.map((message) => message.id));
  const resting = isRestingThreadStatus(previousThread.status);
  const pendingStatusToken = nanoid();
  const optimisticCreatedAt = Date.now();

  retainPendingQueuedMessageRemoval(queryClient, request.id, removedIds);
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queueKey,
    (currentQueuedMessages) =>
      removeQueuedMessagesAndRepairGroupEdges(
        currentQueuedMessages,
        removedIds,
      ),
  );

  const remaining =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queueKey) ?? [];

  beginComposerThreadState(
    queryClient,
    request.id,
    pendingStatusToken,
    "active",
  );

  const listRollback = applyOptimisticThreadListState(
    queryClient,
    request.id,
    (thread) =>
      withQueuedMessageWork(
        resting ? withAcceptedTurnStatus(thread) : thread,
        remaining,
        removedIds,
      ),
  );

  if (resting)
    applyOptimisticAcceptedTurnDetailState({
      queryClient,
      threadId: request.id,
    });

  const { requestId } = request;

  const optimisticRows =
    requestId !== undefined && sentGroup.every(isPlainUserQueuedMessage)
      ? sentGroup.map((message): TimelineUserConversationRow => {
          const row = buildOptimisticUserMessageRow({
            clientRequestId: requestId,
            createdAt: optimisticCreatedAt,
            input: message.content,
            mode: request.mode,
            threadId: request.id,
            threadStatus: previousThread.status,
          });

          return {
            ...row,
            turnRequest: {
              ...row.turnRequest,
              isGrouped: sentGroup.length > 1,
            },
          };
        })
      : [];

  for (const row of optimisticRows) {
    addPendingSentMessage(queryClient, request.id, row);
  }

  return {
    pendingStatusToken,
    inboxPrediction: resting
      ? predictInboxSnapshot(queryClient, (snapshot) =>
          startInboxTurn(snapshot, request.id),
        )
      : null,
    listRollback,
    optimisticCreatedAt,
    optimisticQueueDataUpdateCount:
      queryClient.getQueryState(queueKey)?.dataUpdateCount ?? 0,
    optimisticRowIds: optimisticRows.map((row) => row.id),
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
      null,
    previousQueuedMessages,
    previousThread,
    removedQueuedMessageIds: [...removedIds],
  };
}

export async function beginSendQueuedMessageTransaction({
  queryClient,
  request,
}: SendQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  const readsCancelled = Promise.all([
    queryClient.cancelQueries({
      queryKey: threadQueuedMessagesQueryKey(request.id),
    }),
    queryClient.cancelQueries({ queryKey: threadQueryKey(request.id) }),
    queryClient.cancelQueries({
      queryKey: threadTimelineQueryKeyPrefix(request.id),
    }),
    queryClient.cancelQueries({
      queryKey: threadTimelineTurnSummaryDetailsQueryKeyPrefix(request.id),
    }),
  ]);

  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
    );

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );

  const sentGroup = queuedMessageSendGroup(
    previousQueuedMessages,
    request.queuedMessageId,
  );

  if (
    previousThread !== undefined &&
    sentGroup.length > 0 &&
    optimisticSendWait(
      queryClient,
      { id: request.id, mode: request.mode, sendNow: true },
      previousThread,
    ) === undefined
  ) {
    const transaction = beginAcceptedQueuedMessageSend({
      previousQueuedMessages,
      previousThread,
      queryClient,
      request,
      sentGroup,
    });

    await readsCancelled;

    return transaction;
  }

  await readsCancelled;

  const pendingStatusToken = nanoid();

  const dispatchingMessage = {
    id: request.queuedMessageId,
    sendAt: null,
    waitingOn: null,
  };

  beginComposerThreadState(
    queryClient,
    request.id,
    pendingStatusToken,
    "queued",
    dispatchingMessage,
  );

  const listRollback = applyOptimisticThreadListState(
    queryClient,
    request.id,
    (thread) =>
      withLocalThreadWork({ ...thread, queuedWork: "waiting" }, [
        localQueuedMessageWork(thread, dispatchingMessage),
      ]),
  );

  return {
    pendingStatusToken,
    inboxPrediction: null,
    listRollback,
    optimisticCreatedAt: Date.now(),
    optimisticQueueDataUpdateCount:
      queryClient.getQueryState(threadQueuedMessagesQueryKey(request.id))
        ?.dataUpdateCount ?? 0,
    optimisticRowIds: [],
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
      null,
    previousQueuedMessages:
      queryClient.getQueryData<ThreadQueuedMessageListResponse>(
        threadQueuedMessagesQueryKey(request.id),
      ),
    previousThread,
    removedQueuedMessageIds: [],
  };
}

export function rollbackRemoveQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackRemoveQueuedMessageTransactionArgs): void {
  if (!transaction) {
    return;
  }

  transaction.inboxPrediction?.discard();
  releasePendingQueuedMessageRemoval(
    queryClient,
    request.id,
    transaction.removedQueuedMessageIds,
  );
  removePendingSentMessages(
    queryClient,
    request.id,
    transaction.optimisticRowIds,
  );
  restoreOptimisticThreadLists(queryClient, transaction.listRollback);

  const queueRestored = restoreQueuedMessageSnapshotIfUnchanged({
    optimisticQueueDataUpdateCount: transaction.optimisticQueueDataUpdateCount,
    previousQueuedMessages: transaction.previousQueuedMessages,
    queryClient,
    threadId: request.id,
  });

  if (!queueRestored) {
    invalidateThreadQueueQueries({ queryClient, threadId: request.id });
  }

  if (transaction.removedQueuedMessageIds.length > 0)
    restoreOptimisticThreadSnapshotIfUnchanged({
      optimisticThreadDataUpdateCount:
        transaction.optimisticThreadDataUpdateCount,
      previousThread: transaction.previousThread,
      queryClient,
      threadId: request.id,
    });

  if (transaction.pendingStatusToken !== null)
    settleComposerThreadState(
      queryClient,
      request.id,
      transaction.pendingStatusToken,
      "failed",
    );
}

export function settleQueuedMessageAlreadySent({
  queryClient,
  request,
  transaction,
}: RollbackRemoveQueuedMessageTransactionArgs): void {
  rollbackRemoveQueuedMessageTransaction({ queryClient, request, transaction });
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(request.id),
    (messages) =>
      removeQueuedMessagesAndRepairGroupEdges(
        messages,
        new Set([request.queuedMessageId]),
      ),
  );
  invalidateThreadQueuedMessageSendQueries({
    queryClient,
    threadId: request.id,
  });
}

export function applyQueuedMessageSendResult({
  queryClient,
  request,
  result,
  transaction,
}: ApplyQueuedMessageSendResultArgs): void {
  const accepted =
    transaction !== undefined && transaction.removedQueuedMessageIds.length > 0;

  if (result.delivery === "queued") {
    if (transaction !== undefined) {
      restoreOptimisticThreadLists(queryClient, transaction.listRollback);
    }

    if (accepted) {
      transaction.inboxPrediction?.discard();
      releasePendingQueuedMessageRemoval(
        queryClient,
        request.id,
        transaction.removedQueuedMessageIds,
      );
      removePendingSentMessages(
        queryClient,
        request.id,
        transaction.optimisticRowIds,
      );
      restoreQueuedMessageSnapshotIfUnchanged({
        optimisticQueueDataUpdateCount:
          transaction.optimisticQueueDataUpdateCount,
        previousQueuedMessages: transaction.previousQueuedMessages,
        queryClient,
        threadId: request.id,
      });
      restoreOptimisticThreadSnapshotIfUnchanged({
        optimisticThreadDataUpdateCount:
          transaction.optimisticThreadDataUpdateCount,
        previousThread: transaction.previousThread,
        queryClient,
        threadId: request.id,
      });
    }

    reconcileAuthoritativeQueuedMessage({
      insertWhenMissing:
        transaction === undefined ||
        accepted ||
        queryClient.getQueryState(threadQueuedMessagesQueryKey(request.id))
          ?.dataUpdateCount === transaction.optimisticQueueDataUpdateCount,
      optimisticQueuedMessageId: null,
      queryClient,
      queuedMessage: result.queuedMessage,
      threadId: request.id,
    });
  } else if (transaction !== undefined) {
    const sendIds = new Set([request.queuedMessageId]);

    releasePendingQueuedMessageRemoval(
      queryClient,
      request.id,
      transaction.removedQueuedMessageIds,
    );
    transaction.inboxPrediction?.settle();
    confirmPendingQueuedMessageRemoval(queryClient, request.id, sendIds);

    for (const rowId of transaction.optimisticRowIds)
      acceptPendingSentMessage(queryClient, request.id, rowId);

    const currentQueue =
      queryClient.getQueryData<ThreadQueuedMessageListResponse>(
        threadQueuedMessagesQueryKey(request.id),
      );

    const hasPendingMessage = currentQueue?.some((message) =>
      sendIds.has(message.id),
    );

    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      (messages) => removeQueuedMessagesAndRepairGroupEdges(messages, sendIds),
    );

    if (hasPendingMessage) {
      if (
        queryClient.getQueryState(threadQueryKey(request.id))
          ?.dataUpdateCount === transaction.optimisticThreadDataUpdateCount
      )
        applyOptimisticAcceptedTurnThreadState({
          queryClient,
          threadId: request.id,
        });
    }
  }

  invalidateThreadQueuedMessageSendQueries({
    queryClient,
    threadId: request.id,
  });

  if (transaction?.pendingStatusToken)
    settleComposerThreadState(
      queryClient,
      request.id,
      transaction.pendingStatusToken,
      result.delivery === "stored" || result.delivery === "waiting"
        ? "sent"
        : result.delivery,
    );
}

export async function beginReorderQueuedMessageTransaction({
  queryClient,
  request,
}: ReorderQueuedMessageTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);

  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) return currentQueuedMessages;

      const originalLeadGroupIds = collectLeadQueuedMessageGroupIds(
        currentQueuedMessages,
      );

      const reordered = applyQueuedMessageReorder({
        queuedMessages: currentQueuedMessages,
        request,
      });

      return request.groupBoundaryQueuedMessageId !== undefined
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: reordered,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : preserveLeadQueuedMessageGroupAfterReorder({
            queuedMessages: reordered,
            originalLeadGroupIds,
          });
    },
  );

  await queryClient.cancelQueries({ queryKey });

  return { previousQueuedMessages };
}

export function rollbackReorderQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackQueuedMessageTransactionArgs): void {
  if (transaction?.previousQueuedMessages !== undefined) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      transaction.previousQueuedMessages,
    );
  }

  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export function applyQueuedMessagesResult({
  queryClient,
  queuedMessages,
  request,
}: ApplyQueuedMessagesResultArgs): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(request.id),
    queuedMessages,
  );
  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export async function beginSetQueuedMessageGroupBoundaryTransaction({
  queryClient,
  request,
}: SetQueuedMessageGroupBoundaryTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);

  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: currentQueuedMessages,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : currentQueuedMessages,
  );

  await queryClient.cancelQueries({ queryKey });

  return { previousQueuedMessages };
}

export function applyQueuedMessageDeleteResult({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginStopThreadTransaction({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): Promise<StopThreadTransaction> {
  cancelComposerThreadStateReads(queryClient, threadId);
  await Promise.all([
    queryClient.cancelQueries({ queryKey: threadQueryKey(threadId) }),
    queryClient.cancelQueries({ queryKey: threadsQueryKey() }),
  ]);

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );

  const listRollback = applyOptimisticStopRequest({
    queryClient,
    threadId,
  });

  return {
    previousThread,
    listRollback,
    inboxPrediction: predictInboxSnapshot(queryClient, (snapshot) =>
      stopInboxTurn(snapshot, threadId),
    ),
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount ??
      null,
  };
}

export function rollbackStopThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: RollbackStopThreadTransactionArgs): void {
  if (!transaction) {
    return;
  }

  transaction.inboxPrediction.discard();

  if (
    !restoreOptimisticThreadSnapshotIfUnchanged({
      optimisticThreadDataUpdateCount:
        transaction.optimisticThreadDataUpdateCount,
      previousThread: transaction.previousThread,
      queryClient,
      threadId,
    })
  )
    void queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) });

  restoreOptimisticThreadLists(queryClient, transaction.listRollback);
}

export function settleStopThreadTransaction({
  queryClient,
  threadId,
  transaction,
}: ThreadIdCacheArgs & {
  transaction: StopThreadTransaction | undefined;
}): void {
  transaction?.inboxPrediction.settle();
  invalidateThreadListMembershipQueries({ queryClient, threadId });
}

function replaceTimelineMessage(
  rows: readonly TimelineRow[],
  messageId: string,
  replacement: Pick<
    TimelineUserConversationRow,
    "attachments" | "mentions" | "text"
  >,
): TimelineRow[] | null {
  let changed = false;

  const next = rows.map((row): TimelineRow => {
    if (
      row.id === messageId &&
      row.kind === "conversation" &&
      row.role === "user"
    ) {
      changed = true;

      return { ...row, ...replacement };
    }

    if (row.kind === "turn" && row.children !== null) {
      const children = replaceTimelineMessage(
        row.children,
        messageId,
        replacement,
      );

      if (children !== null) {
        changed = true;

        return { ...row, children };
      }
    }

    return row;
  });

  return changed ? next : null;
}

export function beginEditMessageTransaction({
  queryClient,
  request,
}: EditMessageTransactionArgs): EditMessageTransaction {
  for (const queryKey of [
    threadTimelineQueryKeyPrefix(request.id),
    threadTimelineTurnSummaryDetailsQueryKeyPrefix(request.id),
  ])
    void queryClient.cancelQueries({ queryKey });

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );

  const edited = buildOptimisticUserMessageRow({
    clientRequestId: null,
    createdAt: Date.now(),
    input: request.input,
    mode: "start",
    threadId: request.id,
    threadStatus: previousThread?.status ?? null,
  });

  const timelineSnapshots: TimelineSnapshot[] = [];

  for (const [
    queryKey,
    timeline,
  ] of queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(request.id),
  })) {
    const rows =
      timeline === undefined
        ? null
        : replaceTimelineMessage(timeline.rows, request.messageId, {
            attachments: edited.attachments,
            mentions: edited.mentions,
            text: edited.text,
          });

    if (timeline === undefined || rows === null) continue;

    queryClient.setQueryData<ThreadTimelineResponse>(queryKey, {
      ...timeline,
      rows,
    });
    timelineSnapshots.push({
      queryKey,
      previous: timeline,
      optimisticDataUpdateCount:
        queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0,
    });
  }

  const startsTurn =
    previousThread !== undefined &&
    optimisticSendWait(
      queryClient,
      { id: request.id, mode: "start", sendNow: true },
      previousThread,
    ) === undefined;

  if (!startsTurn)
    return {
      inboxPrediction: null,
      listRollback: new Map(),
      optimisticThreadDataUpdateCount: null,
      pendingStatusToken: null,
      previousThread,
      timelineSnapshots,
    };

  const pendingStatusToken = nanoid();
  beginComposerThreadState(
    queryClient,
    request.id,
    pendingStatusToken,
    "active",
  );

  const listRollback = applyOptimisticAcceptedTurnThreadState({
    queryClient,
    threadId: request.id,
  });

  return {
    inboxPrediction: isRestingThreadStatus(previousThread.status)
      ? predictInboxSnapshot(queryClient, (snapshot) =>
          startInboxTurn(snapshot, request.id),
        )
      : null,
    listRollback,
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(request.id))?.dataUpdateCount ??
      null,
    pendingStatusToken,
    previousThread,
    timelineSnapshots,
  };
}

export function rollbackEditMessageTransaction({
  queryClient,
  threadId,
  transaction,
}: SettleEditMessageTransactionArgs): void {
  if (transaction === undefined) return;

  transaction.inboxPrediction?.discard();

  let timelineRestored = true;

  for (const snapshot of transaction.timelineSnapshots) {
    if (
      queryClient.getQueryState(snapshot.queryKey)?.dataUpdateCount ===
      snapshot.optimisticDataUpdateCount
    )
      queryClient.setQueryData(snapshot.queryKey, snapshot.previous);
    else timelineRestored = false;
  }

  if (!timelineRestored)
    void queryClient.invalidateQueries({
      queryKey: threadTimelineQueryKeyPrefix(threadId),
    });

  if (transaction.pendingStatusToken === null) return;

  restoreOptimisticThreadLists(queryClient, transaction.listRollback);
  restoreOptimisticThreadSnapshotIfUnchanged({
    optimisticThreadDataUpdateCount:
      transaction.optimisticThreadDataUpdateCount,
    previousThread: transaction.previousThread,
    queryClient,
    threadId,
  });
  settleComposerThreadState(
    queryClient,
    threadId,
    transaction.pendingStatusToken,
    "failed",
  );
}

export function applyEditMessageResult({
  queryClient,
  threadId,
  transaction,
}: SettleEditMessageTransactionArgs): void {
  transaction?.inboxPrediction?.settle();

  if (transaction?.pendingStatusToken)
    settleComposerThreadState(
      queryClient,
      threadId,
      transaction.pendingStatusToken,
      "sent",
    );
}

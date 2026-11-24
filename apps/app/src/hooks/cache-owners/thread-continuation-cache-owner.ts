import type { QueryClient } from "@tanstack/react-query";
import type { ThreadListEntry } from "@omnyo/domain";
import type {
  ThreadContinueResponse,
  ThreadContinueState,
  ThreadResponse,
} from "@omnyo/server-contract";
import { startInboxTurn } from "@/lib/inbox-predictions";
import {
  sidebarNavigationQueryKey,
  threadContinuationsQueryKey,
  threadDetailBootstrapQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";
import {
  predictInboxSnapshot,
  type InboxPrediction,
} from "./inbox-snapshot-cache-owner";
import { withLocalThreadWork } from "./local-thread-work";
import {
  retainPendingComposerThreadState,
  settlePendingComposerThreadState,
} from "./pending-composer-cache-owner";
import {
  applyToCachedThreadListsAndSidebarNavigation,
  getCachedSidebarNavigationThreads,
  updateCachedThread,
} from "./query-cache";
import { predictCachedThreadSendWait } from "./thread-runtime-cache-owner";
import {
  projectCachedThreadListEntries,
  restoreCachedThreadListEntries,
} from "./thread-answer-cache-owner";

export function threadContinuationQueryKey(threadId: string) {
  return [...threadContinuationsQueryKey(), threadId];
}

export async function invalidateThreadContinuation(
  queryClient: QueryClient,
  threadId: string,
): Promise<void> {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: threadContinuationsQueryKey() }),
    queryClient.invalidateQueries({ queryKey: threadQueryKey(threadId) }),
  ]);
}

export interface ContinueThreadTransaction {
  threadId: string;
  token: string;
  previousThread: ThreadResponse | undefined;
  optimisticThreadDataUpdateCount: number | null;
  listRollback: ReadonlyMap<ThreadListEntry, ThreadListEntry>;
  inboxPrediction: InboxPrediction;
}

const STARTS_TURN: ReadonlySet<ThreadContinueState["action"]> = new Set([
  "retry",
  "continue",
]);

let nextContinueToken = 0;

function threadStatusReads(threadId: string) {
  return [
    sidebarNavigationQueryKey(),
    threadsQueryKey(),
    threadQueryKey(threadId),
    threadDetailBootstrapQueryKey(threadId),
  ];
}

function runningThread<T extends ThreadResponse | ThreadListEntry>(
  thread: T,
): T {
  return withLocalThreadWork({
    ...thread,
    status: "active",
    runtime: {
      ...thread.runtime,
      displayStatus:
        thread.runtime.displayStatus === "waiting-for-host"
          ? "waiting-for-host"
          : "active",
    },
  });
}

function predictsContinuedTurn(
  queryClient: QueryClient,
  threadId: string,
): boolean {
  const state = queryClient.getQueryData<ThreadContinueState>(
    threadContinuationQueryKey(threadId),
  );

  return (
    state !== undefined &&
    state.available &&
    !state.pending &&
    STARTS_TURN.has(state.action) &&
    predictCachedThreadSendWait(queryClient, { id: threadId, mode: "auto" }) ===
      undefined
  );
}

export async function beginContinueThreadTransaction(
  queryClient: QueryClient,
  threadId: string,
): Promise<ContinueThreadTransaction | null> {
  if (!predictsContinuedTurn(queryClient, threadId)) return null;

  await Promise.all(
    threadStatusReads(threadId).map((queryKey) =>
      queryClient.cancelQueries({ queryKey }),
    ),
  );

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );

  nextContinueToken += 1;
  const token = `continue:${threadId}:${nextContinueToken}`;

  retainPendingComposerThreadState(
    queryClient,
    threadId,
    token,
    "active",
    previousThread ??
      getCachedSidebarNavigationThreads(queryClient).find(
        (thread) => thread.id === threadId,
      ),
  );

  const listRollback = projectCachedThreadListEntries(
    queryClient,
    threadId,
    runningThread,
  );

  updateCachedThread(queryClient, threadId, runningThread);

  return {
    threadId,
    token,
    previousThread,
    optimisticThreadDataUpdateCount:
      queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount ??
      null,
    listRollback,
    inboxPrediction: predictInboxSnapshot(queryClient, (snapshot) =>
      startInboxTurn(snapshot, threadId, { clearsFailure: true }),
    ),
  };
}

function settleComposerToken(
  queryClient: QueryClient,
  { threadId, token }: ContinueThreadTransaction,
  outcome: "sent" | "queued" | "failed",
): void {
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

  for (const queryKey of threadStatusReads(threadId))
    void queryClient.invalidateQueries({ queryKey });
}

function revertContinueThreadTransaction(
  queryClient: QueryClient,
  transaction: ContinueThreadTransaction,
  outcome: "queued" | "failed",
): void {
  const { threadId } = transaction;
  transaction.inboxPrediction.discard();

  for (const queryKey of threadStatusReads(threadId))
    void queryClient.cancelQueries({ queryKey });

  restoreCachedThreadListEntries(queryClient, transaction.listRollback);

  if (
    transaction.previousThread !== undefined &&
    transaction.optimisticThreadDataUpdateCount !== null &&
    queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount ===
      transaction.optimisticThreadDataUpdateCount
  )
    queryClient.setQueryData<ThreadResponse>(
      threadQueryKey(threadId),
      transaction.previousThread,
    );

  settleComposerToken(queryClient, transaction, outcome);
}

export function rollbackContinueThreadTransaction(
  queryClient: QueryClient,
  transaction: ContinueThreadTransaction | null | undefined,
): void {
  if (transaction)
    revertContinueThreadTransaction(queryClient, transaction, "failed");
}

export function settleContinueThreadTransaction(
  queryClient: QueryClient,
  transaction: ContinueThreadTransaction | null | undefined,
  outcome: ThreadContinueResponse["outcome"],
): void {
  if (!transaction) return;

  switch (outcome) {
    case "sent":
      transaction.inboxPrediction.settle();
      settleComposerToken(queryClient, transaction, "sent");

      return;
    case "queued":
      revertContinueThreadTransaction(queryClient, transaction, "queued");

      return;
    case "pending":
    case "blocked":
      revertContinueThreadTransaction(queryClient, transaction, "failed");
  }
}

import type { QueryClient } from "@tanstack/react-query";
import {
  type QueuedMessageWork,
  type ThreadListEntry,
  type ThreadRuntimeState,
  type ThreadStatus,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import type {
  ThreadQueuedMessageListResponse,
  ThreadResponse,
} from "@omnyo/server-contract";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { queueInboxSend } from "@/lib/inbox-predictions";
import { predictInboxSnapshot } from "./inbox-snapshot-cache-owner";
import {
  applyOptimisticThreadListState,
  restoreOptimisticThreadLists,
} from "./thread-list-optimism";
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
import {
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  threadQueuedMessagesQueryKey,
  threadQueryKey,
  threadsQueryKey,
} from "../queries/query-keys";

export interface OutboxThreadPrediction {
  settle: () => void;
  discard: () => void;
}

interface OutboxWorkThread {
  id: string;
  status: ThreadStatus;
  runtime: ThreadRuntimeState;
  work?: ThreadWorkSummary | null;
}

export function beginOutboxThreadMessageTransaction({
  queryClient,
  threadId,
  submissionId,
  connected,
}: {
  queryClient: QueryClient;
  threadId: string;
  submissionId: string;
  connected: boolean;
}): OutboxThreadPrediction {
  const token = `outbox:${submissionId}`;

  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );

  const thread =
    previousThread ??
    getCachedSidebarNavigationThreads(queryClient).find(
      (current) => current.id === threadId,
    );

  const reason = connected
    ? "Sending message"
    : "Waiting for a connection to send your message.";

  const fact: QueuedMessageWork = {
    kind: "wait",
    wait: {
      id: token,
      reason,
      actor: { kind: "external", id: null, label: "Message delivery" },
    },
  };

  for (const queryKey of [
    sidebarNavigationQueryKey(),
    threadsQueryKey(),
    threadQueryKey(threadId),
    threadDetailBootstrapQueryKey(threadId),
  ])
    void queryClient.cancelQueries({ queryKey });
  retainPendingComposerThreadState(
    queryClient,
    threadId,
    token,
    "queued",
    thread,
    null,
    fact,
  );

  const rollback = applyOptimisticThreadListState(
    queryClient,
    threadId,
    (current) =>
      withLocalThreadWork<ThreadListEntry>(
        { ...current, queuedWork: "waiting" },
        [fact],
        { preserveFailures: true },
      ),
  );

  updateCachedThread(queryClient, threadId, (current) =>
    withLocalThreadWork(current, [fact], { preserveFailures: true }),
  );

  const dataUpdateCount = queryClient.getQueryState(
    threadQueryKey(threadId),
  )?.dataUpdateCount;

  const inboxPrediction = predictInboxSnapshot(queryClient, (snapshot) =>
    queueInboxSend(
      snapshot,
      threadId,
      reason,
      thread === undefined
        ? undefined
        : {
            projectId: thread.projectId,
            title: getThreadDisplayTitle(thread),
            shelved: thread.shelvedAt !== null,
            sortAt: Date.now(),
          },
    ),
  );

  let finished = false;

  const refresh = () => {
    for (const queryKey of [
      sidebarNavigationQueryKey(),
      threadsQueryKey(),
      threadQueryKey(threadId),
      threadQueuedMessagesQueryKey(threadId),
    ])
      void queryClient.invalidateQueries({ queryKey });
  };

  const withoutLocalWork = <T extends OutboxWorkThread>(current: T): T => {
    const work = current.work;

    if (
      work == null ||
      ![...work.activity, ...work.waits].some((item) => item.id === token)
    )
      return current;

    const projected = withLocalThreadWork(
      {
        ...current,
        work: {
          ...work,
          activity: work.activity.filter((item) => item.id !== token),
          waits: work.waits.filter((item) => item.id !== token),
        },
      },
      [],
      { preserveFailures: true },
    );

    return "queuedWork" in projected
      ? {
          ...projected,
          queuedWork:
            projected.work.activity.some((item) => item.kind === "queue") ||
            projected.work.waits.some((item) =>
              item.id.startsWith("outbox:"),
            ) ||
            (queryClient.getQueryData<ThreadQueuedMessageListResponse>(
              threadQueuedMessagesQueryKey(threadId),
            )?.length ?? 0) > 0
              ? "waiting"
              : "none",
        }
      : projected;
  };

  return {
    settle() {
      if (finished) return;
      finished = true;
      settlePendingComposerThreadState(queryClient, threadId, token, "queued");
      inboxPrediction.settle();
      refresh();
    },
    discard() {
      if (finished) return;
      finished = true;
      settlePendingComposerThreadState(queryClient, threadId, token, "failed");
      inboxPrediction.discard();
      restoreOptimisticThreadLists(queryClient, rollback);
      applyToCachedThreadListsAndSidebarNavigation(queryClient, (threads) =>
        threads.map((current) =>
          current.id === threadId ? withoutLocalWork(current) : current,
        ),
      );

      if (
        previousThread !== undefined &&
        queryClient.getQueryState(threadQueryKey(threadId))?.dataUpdateCount ===
          dataUpdateCount
      )
        queryClient.setQueryData(threadQueryKey(threadId), previousThread);
      else updateCachedThread(queryClient, threadId, withoutLocalWork);
      refresh();
    },
  };
}

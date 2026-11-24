import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import type { ThreadListEntry } from "@omnyo/domain";
import type {
  ThreadArchiveAllResponse,
  ThreadResponse,
  UpdateThreadRequest,
} from "@omnyo/server-contract";
import { sdk } from "@/lib/sdk";
import type { LifecycleErrorOperation } from "@/lib/lifecycle-errors";
import {
  applyThreadPinStateResult,
  applyThreadReadStateResult,
  applyThreadUpdateResult,
  beginArchiveThreadAndChildrenTransaction,
  beginDeleteThreadTransaction,
  beginPinThreadTransaction,
  beginThreadReadStateTransaction,
  beginThreadMetadataTransaction,
  beginUnarchiveThreadTransaction,
  beginUnpinThreadTransaction,
  getCachedThreadTreeIds,
  rollbackArchiveThreadsTransaction,
  rollbackDeleteThreadTransaction,
  rollbackThreadListMutationTransaction,
  rollbackThreadReadStateTransaction,
  type ThreadReadStateTransaction,
  settleArchiveThreadsTransaction,
  settleDeleteThreadTransaction,
  settleThreadListMembershipMutation,
  settleThreadReadStateTransaction,
  settleThreadPatchTransaction,
  type ArchiveThreadsTransaction,
  type DeleteThreadTransaction,
  type ThreadListMutationTransaction,
} from "../cache-owners/thread-state-cache-owner";

interface ThreadMutationRequest {
  id: string;
}

type UpdateThreadMutationRequest = ThreadMutationRequest & UpdateThreadRequest;

interface UpdateThreadMutationOptions {
  errorMessage?: string | undefined;
  lifecycleOperation?: LifecycleErrorOperation | undefined;
  showErrorToast?: boolean;
}

interface ArchiveThreadAndChildrenMutationRequest {
  id: string;
  childThreadsConfirmed: boolean;
  onOptimistic?: (archivedThreadIds: readonly string[]) => void;
}

export class ArchiveThreadConfirmationRequired extends Error {
  constructor(readonly childThreadCount: number) {
    super("Archiving child threads requires confirmation");
  }
}

interface DeleteThreadMutationRequest {
  id: string;
  childThreadsConfirmed: boolean;
  onOptimistic?: () => void;
}

interface CachedChildThreadCounts {
  childThreadCount: number;
  unarchivedDescendantCount: number;
}

function readCachedLiveThreadTree(
  queryClient: QueryClient,
  matchesRoot: (entry: ThreadListEntry) => boolean,
): ThreadListEntry[] {
  const entries = new Map<string, ThreadListEntry>();

  const treeIds = getCachedThreadTreeIds({
    queryClient,
    matchesRoot: (entry) => {
      entries.set(entry.id, entry);

      return matchesRoot(entry);
    },
  });

  return [...treeIds].flatMap((id) => {
    const entry = entries.get(id);

    return entry === undefined || entry.deletedAt !== null ? [] : [entry];
  });
}

export function readCachedChildThreadCounts(
  queryClient: QueryClient,
  threadId: string,
): CachedChildThreadCounts {
  const descendants = readCachedLiveThreadTree(
    queryClient,
    (entry) => entry.id === threadId,
  ).filter((entry) => entry.id !== threadId);

  return {
    childThreadCount: descendants.filter(
      (entry) => entry.parentThreadId === threadId,
    ).length,
    unarchivedDescendantCount: descendants.filter(
      (entry) => entry.archivedAt === null,
    ).length,
  };
}

export function readCachedEnvironmentArchiveIds(
  queryClient: QueryClient,
  environmentId: string,
): string[] {
  return readCachedLiveThreadTree(
    queryClient,
    (entry) =>
      entry.environmentId === environmentId && entry.archivedAt === null,
  )
    .filter((entry) => entry.archivedAt === null)
    .map((entry) => entry.id);
}

interface ThreadReadMutationInput {
  signal?: AbortSignal;
  threadId: string;
}

export function useUpdateThread(options?: UpdateThreadMutationOptions) {
  const queryClient = useQueryClient();

  return useMutation<
    ThreadResponse,
    Error,
    UpdateThreadMutationRequest,
    ThreadListMutationTransaction | undefined
  >({
    meta: {
      errorMessage: options?.errorMessage ?? "Failed to update thread.",
      showErrorToast: options?.showErrorToast ?? true,
      ...(options?.lifecycleOperation
        ? { lifecycleOperation: options.lifecycleOperation }
        : {}),
    },
    mutationFn: ({ id, ...request }: UpdateThreadMutationRequest) =>
      sdk.threads.update({ threadId: id, ...request }),
    onMutate: ({
      groupId,
      parentThreadId,
      sectionId,
      id,
      title,
    }): Promise<ThreadListMutationTransaction | undefined> | undefined => {
      if (
        title === undefined &&
        sectionId === undefined &&
        groupId === undefined &&
        parentThreadId === undefined
      ) {
        return undefined;
      }

      return beginThreadMetadataTransaction({
        groupId,
        parentThreadId,
        sectionId,
        queryClient,
        threadId: id,
        title,
      });
    },
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadUpdateResult({ queryClient, thread });
    },
    onSettled: (_data, _error, _variables, context) => {
      settleThreadPatchTransaction(context);
    },
  });
}

export function usePinThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to pin thread.",
    },
    mutationFn: ({ id }: ThreadMutationRequest) =>
      sdk.threads.pin({ threadId: id }),
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginPinThreadTransaction({
        pinnedAt: Date.now(),
        queryClient,
        threadId: id,
      }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadPinStateResult({ queryClient, thread, pinSortKey: null });
    },
    onSettled: (_data, _error, variables, context) => {
      settleThreadPatchTransaction(context);
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useUnpinThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to unpin thread.",
    },
    mutationFn: ({ id }: ThreadMutationRequest) =>
      sdk.threads.unpin({ threadId: id }),
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginUnpinThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadPinStateResult({ queryClient, thread, pinSortKey: null });
    },
    onSettled: (_data, _error, variables, context) => {
      settleThreadPatchTransaction(context);
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useArchiveThreadAndChildren() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to archive thread and its child threads.",
      lifecycleOperation: "archive_thread",
      showErrorToast: false,
    },
    mutationFn: async ({
      id,
      childThreadsConfirmed,
    }: ArchiveThreadAndChildrenMutationRequest): Promise<ThreadArchiveAllResponse> => {
      if (!childThreadsConfirmed) {
        const summary = await sdk.threads.childSummary({ threadId: id });

        if (summary.unarchivedDescendantCount > 0) {
          throw new ArchiveThreadConfirmationRequired(
            summary.unarchivedDescendantCount,
          );
        }
      }

      return sdk.threads.archiveAll({ threadId: id });
    },
    onMutate: async ({
      id,
      onOptimistic,
    }): Promise<ArchiveThreadsTransaction> => {
      const transaction = await beginArchiveThreadAndChildrenTransaction({
        queryClient,
        threadId: id,
      });

      try {
        onOptimistic?.(transaction.archivedThreadIds);
      } catch (error) {
        rollbackArchiveThreadsTransaction({ queryClient, transaction });
        throw error;
      }

      return transaction;
    },
    onError: (_error, _variables, context) => {
      rollbackArchiveThreadsTransaction({ queryClient, transaction: context });
    },
    onSettled: (data, _error, _variables, context) => {
      settleArchiveThreadsTransaction({
        queryClient,
        response: data,
        transaction: context,
      });
    },
  });
}

export function useUnarchiveThread() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: ["unarchive-thread"],
    meta: {
      errorMessage: "Failed to unarchive thread.",
    },
    mutationFn: async ({ id }: ThreadMutationRequest) => {
      await sdk.threads.unarchive({ threadId: id });
    },
    onMutate: async ({ id }): Promise<ThreadListMutationTransaction> =>
      beginUnarchiveThreadTransaction({ queryClient, threadId: id }),
    onError: (_error, variables, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
    onSettled: (_data, _error, variables, context) => {
      settleThreadPatchTransaction(context);
      settleThreadListMembershipMutation({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

interface UnarchiveThreadsInOrderArgs {
  queryClient: QueryClient;
  threadIds: readonly string[];
  beforeRequest?: Promise<readonly string[] | null>;
}

export async function unarchiveThreadsInOrder({
  queryClient,
  threadIds,
  beforeRequest,
}: UnarchiveThreadsInOrderArgs): Promise<void> {
  const steps: {
    threadId: string;
    transaction: ThreadListMutationTransaction;
  }[] = [];

  for (const threadId of threadIds) {
    steps.push({
      threadId,
      transaction: await beginUnarchiveThreadTransaction({
        queryClient,
        threadId,
      }),
    });
  }

  let sent = 0;
  let confirmedIds: readonly string[] = threadIds;

  try {
    if (beforeRequest !== undefined) {
      const result = await beforeRequest;

      if (result === null) return;
      confirmedIds = result;

      for (const threadId of confirmedIds) {
        const transaction = await beginUnarchiveThreadTransaction({
          queryClient,
          threadId,
        });

        if (steps.some((step) => step.threadId === threadId)) {
          settleThreadPatchTransaction(transaction);
        } else {
          steps.push({ threadId, transaction });
        }
      }

      steps.sort(
        (left, right) =>
          confirmedIds.indexOf(left.threadId) -
          confirmedIds.indexOf(right.threadId),
      );
    }

    for (const { threadId } of steps) {
      if (!confirmedIds.includes(threadId)) {
        sent += 1;
        continue;
      }

      await sdk.threads.unarchive({ threadId });
      sent += 1;
    }
  } catch (error) {
    for (const { threadId, transaction } of steps.slice(sent).reverse())
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId,
        transaction,
      });
    throw error;
  } finally {
    for (const { threadId, transaction } of steps) {
      settleThreadPatchTransaction(transaction);
      settleThreadListMembershipMutation({ queryClient, threadId });
    }
  }
}

export function useRestoreThreadEnvironment() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to restore workspace.",
    },
    mutationFn: ({ id }: ThreadMutationRequest): Promise<ThreadResponse> =>
      sdk.threads.restoreEnvironment({ threadId: id }),
    onSuccess: (thread) => {
      applyThreadUpdateResult({ queryClient, thread });
    },
  });
}

export function useDeleteThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to delete thread.",
    },
    mutationFn: async ({
      childThreadsConfirmed,
      id,
    }: DeleteThreadMutationRequest) => {
      await sdk.threads.delete({ childThreadsConfirmed, threadId: id });
    },
    onMutate: async ({
      id,
      onOptimistic,
    }): Promise<DeleteThreadTransaction> => {
      onOptimistic?.();

      return beginDeleteThreadTransaction({ queryClient, threadId: id });
    },
    onError: (_error, _variables, context) => {
      rollbackDeleteThreadTransaction({
        queryClient,
        transaction: context,
      });
    },
    onSettled: (_data, _error, variables, context) => {
      settleDeleteThreadTransaction({
        queryClient,
        threadId: variables.id,
        transaction: context,
      });
    },
  });
}

export function useMarkThreadRead() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread read.",
      showErrorToast: false,
    },
    mutationFn: (input: ThreadReadMutationInput) => sdk.threads.markRead(input),
    onMutate: (input): Promise<ThreadReadStateTransaction> =>
      beginThreadReadStateTransaction({
        lastReadAt: Date.now(),
        queryClient,
        threadId: input.threadId,
      }),
    onError: (_error, input, context) => {
      rollbackThreadReadStateTransaction({
        queryClient,
        threadId: input.threadId,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadReadStateResult({ queryClient, thread });
    },
    onSettled: (_data, _error, _input, transaction) => {
      settleThreadReadStateTransaction({ queryClient, transaction });
    },
  });
}

export function useMarkThreadUnread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to mark thread unread.",
      showErrorToast: false,
    },
    mutationFn: (input: ThreadReadMutationInput) =>
      sdk.threads.markUnread(input),
    onMutate: (input): Promise<ThreadReadStateTransaction> =>
      beginThreadReadStateTransaction({
        lastReadAt: null,
        queryClient,
        threadId: input.threadId,
      }),
    onError: (_error, input, context) => {
      rollbackThreadListMutationTransaction({
        queryClient,
        threadId: input.threadId,
        transaction: context,
      });
    },
    onSuccess: (thread) => {
      applyThreadReadStateResult({ queryClient, thread });
    },
    onSettled: (_data, _error, _input, transaction) => {
      settleThreadReadStateTransaction({ queryClient, transaction });
    },
  });
}

export interface ThreadAutoCompactionMutationInput {
  threadId: string;
  enabled: boolean;
}

export function useSetThreadAutoCompaction() {
  return useMutation({
    meta: {
      errorMessage: "Failed to change automatic compaction.",
    },
    mutationFn: (input: ThreadAutoCompactionMutationInput) =>
      sdk.threads.experimental_setAutoCompaction(input),
  });
}

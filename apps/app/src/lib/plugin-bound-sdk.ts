import type { InboxActRequest, InboxActResult } from "@omnyo/domain";
import type {
  OmnyoSdkAreas,
  ThreadForkArgs,
  ThreadMutationResult,
  PluginThreadMetadataListArgs,
  ThreadPluginMetadataArgs,
  ThreadPluginMetadataUpdateArgs,
  ThreadSpawnArgs,
  ThreadUpdateArgs,
} from "@omnyo/sdk";
import type { QueryClient } from "@tanstack/react-query";
import type { experimental_PluginBrowserSdk } from "@omnyo/plugin-sdk";
import {
  beginEnvironmentNameUpdateTransaction,
  completeEnvironmentNameUpdateTransaction,
  rollbackEnvironmentNameUpdateTransaction,
} from "@/hooks/cache-owners/environment-workspace-cache-owner";
import {
  predictInboxSnapshot,
  readPredictedInboxSnapshot,
} from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import {
  captureInboxRows,
  inboxActThreadIds,
  predictInboxAct,
  restoreInboxRows,
  startInboxTurn,
  withInboxEntry,
  type InboxPredict,
  type InboxRows,
} from "@/lib/inbox-predictions";
import {
  applyThreadMetadataBatchResult,
  applyThreadOrderResult,
  beginArchiveEnvironmentThreadsTransaction,
  beginArchiveThreadAndChildrenTransaction,
  rollbackArchiveThreadsTransaction,
  settleArchiveThreadsTransaction,
  beginThreadMetadataBatchTransaction,
  beginThreadShelfTransaction,
  beginUnarchiveThreadTransaction,
  rollbackThreadListMutationTransaction,
  settleThreadListMembershipMutation,
  settleThreadPatchTransaction,
  invalidateThreadMetadataBatch,
  rollbackThreadMetadataBatchTransaction,
  applyThreadReadStateResult,
  beginThreadReadStateTransaction,
  rollbackThreadReadStateTransaction,
  settleThreadReadStateTransaction,
  type ArchiveThreadsTransaction,
  type ThreadListMutationTransaction,
} from "@/hooks/cache-owners/thread-state-cache-owner";

import {
  runThreadMessageSend,
  runThreadQueuedMessageCreate,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  applySidebarSectionCreateResult,
  beginSidebarGroupTransaction,
} from "@/hooks/cache-owners/sidebar-group-cache-owner";

interface PendingThreadMutation {
  args: ThreadUpdateArgs;
  operation: "update" | "pin" | "unpin";
  reject: (reason: unknown) => void;
  resolve: (thread: ThreadMutationResult) => void;
}

function hasThreadMetadataUpdate(args: ThreadUpdateArgs): boolean {
  return (
    args.title !== undefined ||
    args.sectionId !== undefined ||
    args.groupId !== undefined ||
    args.parentThreadId !== undefined
  );
}

function createOptimisticThreadMutationBatcher(
  sdk: OmnyoSdkAreas,
  queryClient: QueryClient,
): Pick<OmnyoSdkAreas["threads"], "update" | "pin" | "unpin"> {
  let pending: PendingThreadMutation[] = [];
  let scheduled = false;

  const flush = async () => {
    const batch = pending;
    pending = [];
    scheduled = false;
    let transaction;

    try {
      transaction = await beginThreadMetadataBatchTransaction({
        queryClient,
        updates: batch.map(({ args, operation }) => ({
          threadId: args.threadId,
          title: args.title,
          sectionId: args.sectionId,
          groupId: args.groupId,
          parentThreadId: args.parentThreadId,
          ...(operation === "pin"
            ? { pinnedAt: Date.now() }
            : operation === "unpin"
              ? { pinnedAt: null }
              : {}),
        })),
      });
    } catch (error) {
      for (const request of batch) request.reject(error);

      return;
    }

    const previousByThread = new Map<string, Promise<ThreadMutationResult>>();

    const results = await Promise.allSettled(
      batch.map(({ args, operation }) => {
        const request = (
          previousByThread.get(args.threadId) ?? Promise.resolve()
        ).then(() =>
          operation === "update"
            ? sdk.threads.update(args)
            : sdk.threads[operation]({ threadId: args.threadId }),
        );

        previousByThread.set(args.threadId, request);

        return request;
      }),
    );

    transaction.releasePendingPatches();

    const fulfilledThreads = results.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );

    if (fulfilledThreads.length === results.length) {
      applyThreadMetadataBatchResult({
        queryClient,
        threads: fulfilledThreads,
      });
    } else {
      rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
      invalidateThreadMetadataBatch({
        queryClient,
        threadIds: batch.map(({ args }) => args.threadId),
      });
    }

    results.forEach((result, index) => {
      const request = batch[index];

      if (!request) return;

      if (result.status === "fulfilled") request.resolve(result.value);
      else request.reject(result.reason);
    });
  };

  const enqueue = (
    operation: PendingThreadMutation["operation"],
    args: ThreadUpdateArgs,
  ) =>
    new Promise<ThreadMutationResult>((resolve, reject) => {
      pending.push({ operation, args, reject, resolve });

      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => void flush());
    });

  return {
    update: (args) =>
      hasThreadMetadataUpdate(args)
        ? enqueue("update", args)
        : sdk.threads.update(args),
    pin: (args) => enqueue("pin", args),
    unpin: (args) => enqueue("unpin", args),
  };
}

async function withOptimisticReadState(
  queryClient: QueryClient,
  threadId: string,
  lastReadAt: number | null,
  request: () => ReturnType<OmnyoSdkAreas["threads"]["markRead"]>,
): ReturnType<OmnyoSdkAreas["threads"]["markRead"]> {
  const transaction = await beginThreadReadStateTransaction({
    lastReadAt,
    queryClient,
    threadId,
  });

  try {
    const thread = await request();
    applyThreadReadStateResult({ queryClient, thread });

    return thread;
  } catch (error) {
    rollbackThreadReadStateTransaction({ queryClient, threadId, transaction });
    throw error;
  } finally {
    settleThreadReadStateTransaction({ queryClient, transaction });
  }
}

interface ThreadShelfMutationArgs {
  queryClient: QueryClient;
  threadId: string;
  shelvedAt: number | null;
  request: () => Promise<ThreadMutationResult>;
  onOptimistic?: () => void;
}

export async function runThreadShelfMutation({
  onOptimistic,
  queryClient,
  request,
  shelvedAt,
  threadId,
}: ThreadShelfMutationArgs): Promise<ThreadMutationResult> {
  const transaction = await beginThreadShelfTransaction({
    queryClient,
    shelvedAt,
    threadId,
  });

  try {
    onOptimistic?.();
    const thread = await request();
    applyThreadMetadataBatchResult({ queryClient, threads: [thread] });

    return thread;
  } catch (error) {
    rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
    throw error;
  } finally {
    transaction.releasePendingPatches();
    settleThreadListMembershipMutation({ queryClient, threadId });
  }
}

interface InboxMoveThreadTransaction {
  rollback: () => void;
  settle: () => void;
}

const NO_THREAD_TRANSACTION: InboxMoveThreadTransaction = {
  rollback: () => {},
  settle: () => {},
};

async function beginInboxArchiveThreadTransaction(
  queryClient: QueryClient,
  rootIds: readonly string[],
): Promise<InboxMoveThreadTransaction> {
  const transactions: ArchiveThreadsTransaction[] = [];

  for (const threadId of rootIds)
    transactions.push(
      await beginArchiveThreadAndChildrenTransaction({ queryClient, threadId }),
    );

  return {
    rollback: () => {
      for (const transaction of transactions.slice().reverse())
        rollbackArchiveThreadsTransaction({ queryClient, transaction });
    },
    settle: () => {
      for (const transaction of transactions)
        void settleArchiveThreadsTransaction({
          queryClient,
          response: undefined,
          transaction,
        });
    },
  };
}

async function beginInboxShelfThreadTransaction(
  queryClient: QueryClient,
  threadId: string,
  shelved: boolean,
): Promise<InboxMoveThreadTransaction> {
  const transaction = await beginThreadShelfTransaction({
    queryClient,
    shelvedAt: shelved ? Date.now() : null,
    threadId,
  });

  return {
    rollback: () =>
      rollbackThreadMetadataBatchTransaction({ queryClient, transaction }),
    settle: () => {
      transaction.releasePendingPatches();
      settleThreadListMembershipMutation({ queryClient, threadId });
    },
  };
}

async function beginInboxUnarchiveThreadTransaction(
  queryClient: QueryClient,
  rootIds: readonly string[],
): Promise<InboxMoveThreadTransaction> {
  const transactions: {
    threadId: string;
    transaction: ThreadListMutationTransaction;
  }[] = [];

  for (const threadId of rootIds)
    transactions.push({
      threadId,
      transaction: await beginUnarchiveThreadTransaction({
        queryClient,
        threadId,
      }),
    });

  return {
    rollback: () => {
      for (const { threadId, transaction } of transactions.slice().reverse())
        rollbackThreadListMutationTransaction({
          queryClient,
          threadId,
          transaction,
        });
    },
    settle: () => {
      for (const { threadId, transaction } of transactions) {
        transaction.releasePendingPatches();
        settleThreadListMembershipMutation({ queryClient, threadId });
      }
    },
  };
}

function beginInboxActThreadTransaction(
  queryClient: QueryClient,
  request: InboxActRequest,
): Promise<InboxMoveThreadTransaction> {
  switch (request.action) {
    case "archive":
      return beginInboxArchiveThreadTransaction(queryClient, [
        request.threadId,
      ]);
    case "archive-runs":
      return beginInboxArchiveThreadTransaction(queryClient, request.threadIds);
    case "shelf":
      return beginInboxShelfThreadTransaction(
        queryClient,
        request.threadId,
        request.shelved,
      );
    default:
      return Promise.resolve(NO_THREAD_TRANSACTION);
  }
}

function beginInboxUndoThreadTransaction(
  queryClient: QueryClient,
  request: InboxActRequest,
): Promise<InboxMoveThreadTransaction> {
  switch (request.action) {
    case "archive":
      return beginInboxUnarchiveThreadTransaction(queryClient, [
        request.threadId,
      ]);
    case "archive-runs":
      return beginInboxUnarchiveThreadTransaction(
        queryClient,
        request.threadIds,
      );
    case "shelf":
      return beginInboxShelfThreadTransaction(
        queryClient,
        request.threadId,
        !request.shelved,
      );
    default:
      return Promise.resolve(NO_THREAD_TRANSACTION);
  }
}

interface RememberedInboxMove {
  request: InboxActRequest;
  rows: InboxRows;
}

const INBOX_MOVE_MEMORY = 20;

const rememberedInboxMoves = new WeakMap<
  QueryClient,
  Map<string, RememberedInboxMove>
>();

function rememberInboxMove(
  queryClient: QueryClient,
  moveId: string,
  move: RememberedInboxMove,
): void {
  const moves = rememberedInboxMoves.get(queryClient) ?? new Map();
  rememberedInboxMoves.set(queryClient, moves);
  moves.delete(moveId);
  moves.set(moveId, move);

  for (const key of moves.keys()) {
    if (moves.size <= INBOX_MOVE_MEMORY) break;
    moves.delete(key);
  }
}

function recallInboxMove(
  queryClient: QueryClient,
  moveId: string,
): RememberedInboxMove | undefined {
  return rememberedInboxMoves.get(queryClient)?.get(moveId);
}

function withActResult(
  predict: InboxPredict,
  result: InboxActResult,
): InboxPredict {
  const { entry } = result;

  return entry === null
    ? predict
    : (snapshot) => withInboxEntry(predict(snapshot), entry.threadId, entry);
}

async function runPredictedInboxMove({
  predict,
  queryClient,
  send,
  threadTransaction,
}: {
  predict: InboxPredict;
  queryClient: QueryClient;
  send: () => Promise<InboxActResult>;
  threadTransaction: InboxMoveThreadTransaction;
}): Promise<InboxActResult> {
  const prediction = predictInboxSnapshot(queryClient, predict);

  try {
    const result = await send();
    prediction.replace(withActResult(predict, result));
    prediction.settle();
    threadTransaction.settle();

    return result;
  } catch (error) {
    prediction.discard();
    threadTransaction.rollback();
    threadTransaction.settle();
    throw error;
  }
}

export async function runInboxAct({
  queryClient,
  request,
  send,
}: {
  queryClient: QueryClient;
  request: InboxActRequest;
  send: () => Promise<InboxActResult>;
}): Promise<InboxActResult> {
  const before = readPredictedInboxSnapshot(queryClient);

  const rows =
    before === undefined
      ? null
      : captureInboxRows(before, inboxActThreadIds(request));

  const threadTransaction = await beginInboxActThreadTransaction(
    queryClient,
    request,
  );

  const result = await runPredictedInboxMove({
    predict: (snapshot) => predictInboxAct(snapshot, request),
    queryClient,
    send,
    threadTransaction,
  });

  if (result.moveId !== null && rows !== null)
    rememberInboxMove(queryClient, result.moveId, { request, rows });

  return result;
}

export async function runInboxUndo({
  moveId,
  queryClient,
  send,
}: {
  moveId: string;
  queryClient: QueryClient;
  send: () => Promise<InboxActResult>;
}): Promise<InboxActResult> {
  const move = recallInboxMove(queryClient, moveId);

  if (move === undefined) return send();

  const threadTransaction = await beginInboxUndoThreadTransaction(
    queryClient,
    move.request,
  );

  return runPredictedInboxMove({
    predict: (snapshot) => restoreInboxRows(snapshot, move.rows),
    queryClient,
    send,
    threadTransaction,
  });
}

export async function runThreadRetry<Result>({
  queryClient,
  send,
  threadId,
}: {
  queryClient: QueryClient;
  send: () => Promise<Result>;
  threadId: string;
}): Promise<Result> {
  const prediction = predictInboxSnapshot(queryClient, (snapshot) =>
    startInboxTurn(snapshot, threadId, { clearsFailure: true }),
  );

  try {
    const result = await send();
    prediction.settle();

    return result;
  } catch (error) {
    prediction.discard();
    throw error;
  }
}

function withPluginThreadAttribution<
  TArgs extends ThreadForkArgs | ThreadSpawnArgs,
>(args: TArgs, pluginId: string): TArgs {
  const attribution: Pick<ThreadSpawnArgs, "origin" | "originPluginId"> =
    args.pluginMetadata !== undefined
      ? { origin: "plugin", originPluginId: pluginId }
      : args.origin === undefined || args.origin === "plugin"
        ? { origin: "plugin", originPluginId: args.originPluginId ?? pluginId }
        : { origin: args.origin };

  return { ...args, ...attribution };
}

export function bindSdkToPlugin(
  sdk: OmnyoSdkAreas,
  pluginId: string,
  queryClient: QueryClient,
): experimental_PluginBrowserSdk {
  const threadMutations = createOptimisticThreadMutationBatcher(
    sdk,
    queryClient,
  );

  return {
    ...sdk,
    experimental_inbox: {
      ...sdk.experimental_inbox,
      act(args) {
        return runInboxAct({
          queryClient,
          request: args.request,
          send: () => sdk.experimental_inbox.act(args),
        });
      },
      undo(args) {
        return runInboxUndo({
          moveId: args.moveId,
          queryClient,
          send: () => sdk.experimental_inbox.undo(args),
        });
      },
    },
    environments: {
      ...sdk.environments,
      async archiveThreads(args) {
        const transaction = await beginArchiveEnvironmentThreadsTransaction({
          environmentId: args.environmentId,
          queryClient,
        });

        let response:
          | Awaited<ReturnType<typeof sdk.environments.archiveThreads>>
          | undefined;

        try {
          response = await sdk.environments.archiveThreads(args);

          return response;
        } catch (error) {
          rollbackArchiveThreadsTransaction({ queryClient, transaction });
          throw error;
        } finally {
          settleArchiveThreadsTransaction({
            queryClient,
            response,
            transaction,
          });
        }
      },
      async update(args) {
        const transaction =
          args.name === undefined
            ? undefined
            : await beginEnvironmentNameUpdateTransaction({
                environmentId: args.environmentId,
                name: args.name,
                queryClient,
              });

        try {
          const environment = await sdk.environments.update(args);
          completeEnvironmentNameUpdateTransaction({
            environment,
            queryClient,
            transaction,
          });

          return environment;
        } catch (error) {
          rollbackEnvironmentNameUpdateTransaction({
            queryClient,
            transaction,
          });
          throw error;
        }
      },
    },
    projects: {
      ...sdk.projects,
      async update(args) {
        const transaction =
          args.name === undefined
            ? undefined
            : await beginSidebarGroupTransaction({
                queryClient,
                mutation: {
                  kind: "project",
                  id: args.projectId,
                  name: args.name,
                },
              });

        try {
          return await sdk.projects.update(args);
        } catch (error) {
          transaction?.rollback();
          throw error;
        } finally {
          transaction?.settle();
        }
      },
      async delete(args) {
        const transaction = await beginSidebarGroupTransaction({
          queryClient,
          mutation: { kind: "project", id: args.projectId, name: null },
        });

        try {
          return await sdk.projects.delete(args);
        } catch (error) {
          transaction.rollback();
          throw error;
        } finally {
          transaction.settle();
        }
      },
    },
    hosts: {
      ...sdk.hosts,
      async update(args) {
        const transaction =
          args.name === undefined
            ? undefined
            : await beginSidebarGroupTransaction({
                queryClient,
                mutation: { kind: "host", id: args.hostId, name: args.name },
              });

        try {
          return await sdk.hosts.update(args);
        } catch (error) {
          transaction?.rollback();
          throw error;
        } finally {
          transaction?.settle();
        }
      },
    },
    threadSections: {
      ...sdk.threadSections,
      async create(args) {
        const section = await sdk.threadSections.create(args);
        applySidebarSectionCreateResult({ queryClient, section });

        return section;
      },
      async update(args) {
        const transaction = await beginSidebarGroupTransaction({
          queryClient,
          mutation: { kind: "section", id: args.id, name: args.name },
        });

        try {
          return await sdk.threadSections.update(args);
        } catch (error) {
          transaction.rollback();
          throw error;
        } finally {
          transaction.settle();
        }
      },
      async delete(args) {
        const transaction = await beginSidebarGroupTransaction({
          queryClient,
          mutation: { kind: "section", id: args.id, name: null },
        });

        try {
          return await sdk.threadSections.delete(args);
        } catch (error) {
          transaction.rollback();
          throw error;
        } finally {
          transaction.settle();
        }
      },
    },
    threads: {
      ...sdk.threads,
      send({ threadId, ...request }) {
        return runThreadMessageSend({
          queryClient,
          request: {
            ...request,
            id: threadId,
            messageSource: { kind: "plugin", pluginId },
          },
          transport: (args) => sdk.threads.send(args),
        });
      },
      queuedMessages: {
        ...sdk.threads.queuedMessages,
        create({ threadId, ...request }) {
          return runThreadQueuedMessageCreate({
            queryClient,
            request: {
              ...request,
              id: threadId,
              messageSource: { kind: "plugin", pluginId },
            },
            transport: (args) => sdk.threads.queuedMessages.create(args),
          });
        },
      },
      ...threadMutations,
      retry(args) {
        return runThreadRetry({
          queryClient,
          send: () => sdk.threads.retry(args),
          threadId: args.threadId,
        });
      },
      markRead(args) {
        return withOptimisticReadState(
          queryClient,
          args.threadId,
          Date.now(),
          () => sdk.threads.markRead(args),
        );
      },
      markUnread(args) {
        return withOptimisticReadState(queryClient, args.threadId, null, () =>
          sdk.threads.markUnread(args),
        );
      },
      async reorderPinned(args) {
        const orderedRoots = await sdk.threads.reorderPinned(args);
        applyThreadOrderResult({ queryClient, orderedRoots });

        return orderedRoots;
      },
      async experimental_reorderShelved(args) {
        const orderedRoots =
          await sdk.threads.experimental_reorderShelved(args);

        applyThreadOrderResult({ queryClient, orderedRoots });

        return orderedRoots;
      },
      shelve(args) {
        return runThreadShelfMutation({
          queryClient,
          threadId: args.threadId,
          shelvedAt: Date.now(),
          request: () => sdk.threads.shelve(args),
        });
      },
      unshelve(args) {
        return runThreadShelfMutation({
          queryClient,
          threadId: args.threadId,
          shelvedAt: null,
          request: () => sdk.threads.unshelve(args),
        });
      },
      async unarchive(args) {
        const transaction = await beginUnarchiveThreadTransaction({
          queryClient,
          threadId: args.threadId,
        });

        try {
          return await sdk.threads.unarchive(args);
        } catch (error) {
          rollbackThreadListMutationTransaction({
            queryClient,
            threadId: args.threadId,
            transaction,
          });
          throw error;
        } finally {
          settleThreadPatchTransaction(transaction);
          settleThreadListMembershipMutation({
            queryClient,
            threadId: args.threadId,
          });
        }
      },
      getPluginMetadata(
        args: Omit<ThreadPluginMetadataArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.getPluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      experimental_listPluginMetadata(
        args: Omit<PluginThreadMetadataListArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.experimental_listPluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      updatePluginMetadata(
        args: Omit<ThreadPluginMetadataUpdateArgs, "pluginId"> & {
          pluginId?: string;
        },
      ) {
        return sdk.threads.updatePluginMetadata({
          ...args,
          pluginId: args.pluginId ?? pluginId,
        });
      },
      fork(args: ThreadForkArgs) {
        return sdk.threads.fork(withPluginThreadAttribution(args, pluginId));
      },
      spawn(args: ThreadSpawnArgs) {
        return sdk.threads.spawn(withPluginThreadAttribution(args, pluginId));
      },
    },
  };
}

const boundSdkByQueryClient = new WeakMap<
  QueryClient,
  WeakMap<OmnyoSdkAreas, Map<string, experimental_PluginBrowserSdk>>
>();

export function getPluginBoundSdk(
  sdk: OmnyoSdkAreas,
  pluginId: string,
  queryClient: QueryClient,
): experimental_PluginBrowserSdk {
  let bySdk = boundSdkByQueryClient.get(queryClient);

  if (bySdk === undefined) {
    bySdk = new WeakMap();
    boundSdkByQueryClient.set(queryClient, bySdk);
  }

  let byPlugin = bySdk.get(sdk);

  if (byPlugin === undefined) {
    byPlugin = new Map();
    bySdk.set(sdk, byPlugin);
  }

  let bound = byPlugin.get(pluginId);

  if (bound === undefined) {
    bound = bindSdkToPlugin(sdk, pluginId, queryClient);
    byPlugin.set(pluginId, bound);
  }

  return bound;
}

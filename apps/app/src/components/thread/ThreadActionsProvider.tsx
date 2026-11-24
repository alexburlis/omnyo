import { flushSync } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useSetAtom, useStore } from "jotai";
import { appToast } from "@/components/ui/app-toast";
import {
  closePanesForThreadsAtom,
  splitLayoutAtom,
  maximizedPaneIdAtom,
  type ClosePanesForThreadsResult,
} from "@/lib/split-layout/atoms";
import type { Thread } from "@omnyo/domain";
import {
  ArchiveThreadConfirmationRequired,
  readCachedChildThreadCounts,
  readCachedEnvironmentArchiveIds,
  unarchiveThreadsInOrder,
  useArchiveThreadAndChildren,
  useDeleteThread,
  useMarkThreadRead,
  useMarkThreadUnread,
  usePinThread,
  useUnarchiveThread,
  useUnpinThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { sdk } from "@/lib/sdk";
import { startShelfMoveTiming } from "@/lib/web-error-reporting";
import { beginThreadShelfTransaction } from "@/hooks/cache-owners/thread-state-cache-owner";
import {
  getPluginBoundSdk,
  runThreadShelfMutation,
} from "@/lib/plugin-bound-sdk";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { useDialogState } from "@omnyo/shared-ui/use-dialog-state";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import {
  describeThreadAction,
  getThreadDisplayTitle,
} from "@/lib/thread-title";
import {
  ThreadRenameDialog,
  type ThreadRenameDialogPayload,
  type ThreadRenameDialogTarget,
} from "@/components/dialogs/ThreadRenameDialog";
import {
  ThreadDeleteDialog,
  type ThreadDeleteDialogTarget,
} from "@/components/dialogs/ThreadDeleteDialog";
import {
  ThreadArchiveDialog,
  type ThreadArchiveDialogTarget,
} from "@/components/dialogs/ThreadArchiveDialog";
import { getThreadExitNavigation } from "./thread-exit-navigation";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import { ArchivedThreadToastDescription } from "@/components/thread/ArchivedThreadToastDescription";
import { destroyPersistedBrowserViewsForThread } from "@/components/secondary-panel/browserViewVisibilityCoordinator";
import { getThreadReadToggleAction } from "@omnyo/client-core";
import { getRootComposeRoutePath, getThreadRoutePath } from "@/lib/route-paths";
import { getDesktopBrowserApi } from "@/lib/omnyo-desktop";
import {
  useImmediateRouteNavigate,
  useRouteNavigate,
} from "@/components/ui/app-route-anchor";
import {
  lookupCachedThread,
  resolveThread,
} from "@/lib/thread-cache-resolution";
import {
  trackActionOutcome,
  type ActionOutcome,
  type HistoryEntry,
} from "@/lib/action-history";
import { useActionHistory } from "@/components/layout/ActionHistoryProvider";
import { CORE_THREAD_ACTIONS } from "@/lib/thread-actions/core-thread-actions";
import { ThreadActionCollectors } from "@/lib/thread-actions/thread-action-registry";
import {
  ThreadActionsContext,
  type ThreadActionsContextValue,
  type ThreadRef,
} from "@/lib/thread-actions/thread-actions-context";

interface ThreadActionsProviderProps {
  children: ReactNode;
}

interface ArchiveThreadActionRequest {
  childThreadsConfirmed: boolean;
  closeDialog?: () => void;
  thread: Thread;
}

interface DeleteThreadActionRequest {
  childThreadsConfirmed: boolean;
  closeDialog: () => void;
  thread: Thread;
}

interface ThreadActionContext {
  childThreadCount: number;
}

interface ThreadExit {
  destination: string | null;
  leave: () => void;
  previousRoute: string;
  restore: () => void;
}

interface ThreadsExit {
  destination: string | null;
  previousRoute: string;
  restore: () => void;
}

interface EnvironmentArchive {
  archivedThreadIds: readonly string[];
  destination: string | null;
  previousRoute: string;
}

interface PendingEnvironmentArchive {
  exit: ThreadsExit;
  undoRequested: boolean;
  archived: Promise<EnvironmentArchive>;
  threadIds: readonly string[];
}

interface PendingThreadArchive {
  archived: ActionOutcome<readonly string[]>;
  threadIds: readonly string[];
  undoRequested: boolean;
  exit: ThreadExit;
}

interface PendingThreadShelve {
  exit: ThreadExit;
  shelved: ActionOutcome<boolean>;
}

const UNDO_TOAST_DURATION_MS = 10_000;

const INSTANT_TOAST_CLASS_NAME = "omnyo-instant-toast";

function deleteDialogTarget(
  thread: Thread,
  childThreadCount: number,
  childSummaryLoaded = false,
): ThreadDeleteDialogTarget {
  return childThreadCount > 0
    ? { thread, childThreadCount, childSummaryLoaded }
    : { thread, childSummaryLoaded };
}

export function ThreadActionsProvider({
  children,
}: ThreadActionsProviderProps) {
  const confirmThreadArchive =
    useSystemConfig().data?.generalSettings.confirmThreadArchive ?? true;

  const history = useActionHistory();
  const navigate = useRouteNavigate();
  const navigateImmediately = useImmediateRouteNavigate();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const pendingArchivesRef = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const location = useLocation();
  const viewedRoute = `${location.pathname}${location.search}${location.hash}`;
  const viewedRouteRef = useRef(viewedRoute);
  useEffect(() => {
    viewedRouteRef.current = viewedRoute;
  }, [viewedRoute]);
  const { threadId: viewedThreadId } = useRouteState();
  const viewedThreadIdRef = useRef(viewedThreadId);
  useEffect(() => {
    viewedThreadIdRef.current = viewedThreadId;
  }, [viewedThreadId]);
  const store = useStore();
  const closePanesForThreads = useSetAtom(closePanesForThreadsAtom);
  const archiveThreadAndChildrenMutation = useArchiveThreadAndChildren();
  const unarchiveThreadMutation = useUnarchiveThread();
  const markThreadRead = useMarkThreadRead();
  const markThreadUnread = useMarkThreadUnread();
  const pinThread = usePinThread();
  const unpinThread = useUnpinThread();
  const deleteThread = useDeleteThread();
  const updateThread = useUpdateThread();
  const inlineRenameThread = useUpdateThread({ showErrorToast: false });
  const threadActionContextAbortRef = useRef<AbortController | null>(null);

  const { mutateAsync: archiveThreadAndChildrenMutateAsync } =
    archiveThreadAndChildrenMutation;

  const { mutate: unarchiveMutate } = unarchiveThreadMutation;
  const { mutate: markReadMutate } = markThreadRead;
  const { mutate: markUnreadMutate } = markThreadUnread;
  const { mutate: pinMutate } = pinThread;
  const { mutate: unpinMutate } = unpinThread;
  const { mutateAsync: deleteMutateAsync } = deleteThread;
  const { mutateAsync: updateMutateAsync } = updateThread;
  const { mutateAsync: inlineRenameMutateAsync } = inlineRenameThread;

  const renameDialog = useDialogState<ThreadRenameDialogTarget>();
  const deleteDialog = useDialogState<ThreadDeleteDialogTarget>();
  const archiveDialog = useDialogState<ThreadArchiveDialogTarget>();

  const { onClose: closeRenameDialog, onOpen: openRenameDialog } = renameDialog;

  const {
    onClose: closeDeleteDialog,
    onOpen: openDeleteDialog,
    setTarget: setDeleteDialogTarget,
  } = deleteDialog;

  const { onClose: closeArchiveDialog, onOpen: openArchiveDialog } =
    archiveDialog;

  useEffect(() => {
    return () => {
      threadActionContextAbortRef.current?.abort();
      threadActionContextAbortRef.current = null;
    };
  }, []);

  const syncNavigationAfterClose = useCallback(
    (result: ClosePanesForThreadsResult, navigateAway: () => void) => {
      if (result.removedAny && result.focusedRoute !== null) {
        if (result.focusedRoute.threadId !== viewedThreadIdRef.current) {
          navigate(getThreadRoutePath(result.focusedRoute), { replace: true });
        }

        return;
      }

      navigateAway();
    },
    [navigate],
  );

  const requestRename = useCallback(
    (thread: Thread) => {
      openRenameDialog({
        id: thread.id,
        currentTitle: getThreadDisplayTitle(thread),
      });
    },
    [openRenameDialog],
  );

  const recordRename = useCallback(
    (previous: Thread | null, title: string, renaming: Promise<unknown>) => {
      const renamed = trackActionOutcome(renaming.then(() => true));

      if (previous === null || previous.title === title) return;
      const previousTitle = previous.title;

      const entry: HistoryEntry = {
        label: describeThreadAction("Rename", previous),
        undo: async () => {
          const applied =
            renamed.current === undefined
              ? await renamed.settled
              : renamed.current;

          if (applied === null) return;
          await inlineRenameMutateAsync({
            id: previous.id,
            title: previousTitle,
          });
        },
        redo: async () => {
          await inlineRenameMutateAsync({ id: previous.id, title });
        },
      };

      history.record(entry);
      void renamed.settled.then((applied) => {
        if (applied === null) history.forget(entry);
      });
    },
    [history, inlineRenameMutateAsync],
  );

  const renameThreadAsync = useCallback(
    async (threadId: string, title: string) => {
      const previous = lookupCachedThread(queryClient, threadId);
      const renaming = inlineRenameMutateAsync({ id: threadId, title });
      recordRename(previous, title, renaming);
      await renaming;
    },
    [inlineRenameMutateAsync, queryClient, recordRename],
  );

  const submitRename = useCallback(
    (threadId: string, payload: ThreadRenameDialogPayload) => {
      const previous = lookupCachedThread(queryClient, threadId);
      const renaming = updateMutateAsync({ id: threadId, ...payload });
      closeRenameDialog();
      recordRename(previous, payload.title, renaming);
    },
    [closeRenameDialog, queryClient, recordRename, updateMutateAsync],
  );

  const loadThreadActionContext = useCallback(
    async (
      thread: Thread,
      signal: AbortSignal,
    ): Promise<ThreadActionContext | null> => {
      try {
        const childSummary = await sdk.threads.childSummary({
          signal,
          threadId: thread.id,
        });

        if (signal.aborted) return null;

        return {
          childThreadCount: childSummary?.nonDeletedChildCount ?? 0,
        };
      } catch (error) {
        if (signal.aborted) return null;
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to check thread state",
        });

        return null;
      }
    },
    [],
  );

  const claimThreadActionContextAbortController =
    useCallback((): AbortController => {
      threadActionContextAbortRef.current?.abort();
      const controller = new AbortController();
      threadActionContextAbortRef.current = controller;

      return controller;
    }, []);

  const beginThreadExit = useCallback(
    (thread: ThreadRef): ThreadExit => {
      const { familyIds, destination: nextRoute } = getThreadExitNavigation(
        queryClient,
        thread,
      );

      const previousRoute = viewedRouteRef.current;

      const destination = familyIds.includes(viewedThreadIdRef.current ?? "")
        ? (nextRoute ?? getRootComposeRoutePath())
        : null;

      const previousLayout = store.get(splitLayoutAtom);
      const previousMaximizedPaneId = store.get(maximizedPaneIdAtom);

      let optimisticLayout = previousLayout;

      return {
        destination,
        previousRoute,
        leave: () => {
          flushSync(() => {
            closePanesForThreads(familyIds);
            optimisticLayout = store.get(splitLayoutAtom);

            if (
              destination !== null &&
              viewedRouteRef.current === previousRoute
            ) {
              if (nextRoute === null) setRootComposeProjectId(thread.projectId);
              viewedRouteRef.current = destination;
              navigateImmediately(destination);
            }
          });
        },
        restore: () => {
          if (
            previousLayout !== optimisticLayout &&
            store.get(splitLayoutAtom) === optimisticLayout
          ) {
            store.set(splitLayoutAtom, previousLayout);
            store.set(maximizedPaneIdAtom, previousMaximizedPaneId);
          }

          if (destination !== null && viewedRouteRef.current === destination) {
            viewedRouteRef.current = previousRoute;
            navigateImmediately(previousRoute);
          }
        },
      };
    },
    [
      closePanesForThreads,
      navigateImmediately,
      queryClient,
      setRootComposeProjectId,
      store,
    ],
  );

  const performDelete = useCallback(
    ({
      childThreadsConfirmed,
      closeDialog,
      thread,
    }: DeleteThreadActionRequest) => {
      threadActionContextAbortRef.current?.abort();
      threadActionContextAbortRef.current = null;
      const exit = beginThreadExit(thread);
      closeDialog();
      void deleteMutateAsync({
        id: thread.id,
        childThreadsConfirmed,
        onOptimistic: exit.leave,
      }).then(
        () => {
          destroyPersistedBrowserViewsForThread({
            desktopBrowser: getDesktopBrowserApi(),
            threadId: thread.id,
          });
        },
        () => {
          exit.restore();
        },
      );
    },
    [beginThreadExit, deleteMutateAsync],
  );

  const requestDelete = useCallback(
    (thread: Thread) => {
      const { childThreadCount } = readCachedChildThreadCounts(
        queryClient,
        thread.id,
      );

      openDeleteDialog(deleteDialogTarget(thread, childThreadCount));
      const controller = claimThreadActionContextAbortController();

      void loadThreadActionContext(thread, controller.signal).then(
        (context) => {
          if (controller.signal.aborted) return;

          if (context === null) {
            setDeleteDialogTarget((current) =>
              current?.thread.id === thread.id ? null : current,
            );

            return;
          }

          if (threadActionContextAbortRef.current === controller) {
            threadActionContextAbortRef.current = null;
          }

          setDeleteDialogTarget((current) =>
            current?.thread.id === thread.id
              ? deleteDialogTarget(
                  current.thread,
                  context.childThreadCount,
                  true,
                )
              : current,
          );
        },
      );
    },
    [
      claimThreadActionContextAbortController,
      loadThreadActionContext,
      openDeleteDialog,
      queryClient,
      setDeleteDialogTarget,
    ],
  );

  const confirmDelete = useCallback(
    (target: ThreadDeleteDialogTarget) => {
      if (!target.childSummaryLoaded) return;
      performDelete({
        childThreadsConfirmed: target.childThreadCount !== undefined,
        closeDialog: closeDeleteDialog,
        thread: target.thread,
      });
    },
    [closeDeleteDialog, performDelete],
  );

  const unarchiveThreadAction = useCallback(
    (thread: Thread) => {
      unarchiveMutate({ id: thread.id });
    },
    [unarchiveMutate],
  );

  const { mutateAsync: archiveEnvironmentMutateAsync } = useMutation({
    meta: { lifecycleOperation: "archive_thread", showErrorToast: false },
    mutationFn: (environmentId: string) =>
      getPluginBoundSdk(
        sdk,
        "thread-list",
        queryClient,
      ).environments.archiveThreads({ environmentId }),
  });

  const leaveThreads = useCallback(
    (threadIds: readonly string[]): ThreadsExit => {
      const previousRoute = viewedRouteRef.current;
      const previousLayout = store.get(splitLayoutAtom);
      const previousMaximizedPaneId = store.get(maximizedPaneIdAtom);
      const viewedThreadId = viewedThreadIdRef.current;

      const displaced =
        viewedThreadId !== undefined && threadIds.includes(viewedThreadId);

      const closeResult = closePanesForThreads(threadIds);
      const optimisticLayout = store.get(splitLayoutAtom);
      syncNavigationAfterClose(closeResult, () => {
        if (displaced) navigate(getRootComposeRoutePath());
      });

      const destination = displaced
        ? closeResult.focusedRoute !== null
          ? getThreadRoutePath(closeResult.focusedRoute)
          : getRootComposeRoutePath()
        : null;

      if (destination !== null) viewedRouteRef.current = destination;

      return {
        destination,
        previousRoute,
        restore: () => {
          if (
            previousLayout !== optimisticLayout &&
            store.get(splitLayoutAtom) === optimisticLayout
          ) {
            store.set(splitLayoutAtom, previousLayout);
            store.set(maximizedPaneIdAtom, previousMaximizedPaneId);
          }

          if (destination !== null && viewedRouteRef.current === destination) {
            viewedRouteRef.current = previousRoute;
            navigate(previousRoute);
          }
        },
      };
    },
    [closePanesForThreads, navigate, store, syncNavigationAfterClose],
  );

  const archiveEnvironment = useCallback(
    (environmentId: string): PendingEnvironmentArchive => {
      const threadIds = readCachedEnvironmentArchiveIds(
        queryClient,
        environmentId,
      );

      const exit = leaveThreads(threadIds);

      const archived = archiveEnvironmentMutateAsync(environmentId).then(
        (response): EnvironmentArchive => {
          const lateThreadIds = response.archivedThreadIds.filter(
            (threadId) => !threadIds.includes(threadId),
          );

          const lateExit =
            lateThreadIds.length === 0 || pending.undoRequested
              ? null
              : leaveThreads(lateThreadIds);

          const displacing =
            exit.destination === null && lateExit !== null ? lateExit : exit;

          return {
            archivedThreadIds: response.archivedThreadIds,
            destination: displacing.destination,
            previousRoute: displacing.previousRoute,
          };
        },
        (error: unknown) => {
          exit.restore();
          throw error;
        },
      );

      const pending: PendingEnvironmentArchive = {
        archived,
        threadIds,
        exit,
        undoRequested: false,
      };

      return pending;
    },
    [archiveEnvironmentMutateAsync, leaveThreads, queryClient],
  );

  const restoreEnvironmentArchive = useCallback(
    async (
      { archivedThreadIds, destination, previousRoute }: EnvironmentArchive,
      beforeRequest?: Promise<readonly string[] | null>,
    ) => {
      const restoring = unarchiveThreadsInOrder({
        queryClient,
        threadIds: [...archivedThreadIds].reverse(),
        beforeRequest,
      });

      if (destination !== null && viewedRouteRef.current === destination) {
        viewedRouteRef.current = previousRoute;
        navigate(previousRoute);
      }

      await restoring;
    },
    [navigate, queryClient],
  );

  const archiveEnvironmentThreads = useCallback(
    async (environmentId: string) => {
      const keyboardRevision = history.keyboardRevision;
      const toastId = `environment-archived-${environmentId}`;
      const first = archiveEnvironment(environmentId);
      let latestPending = first;
      let latest = trackActionOutcome(first.archived);
      const announced: { entry: HistoryEntry | null } = { entry: null };

      const announce = (count: number) => {
        const entry: HistoryEntry = {
          label: count === 1 ? "Archive 1 chat" : `Archive ${count} chats`,
          undo: async () => {
            latestPending.undoRequested = true;
            const archive = latest.current;

            if (archive === null) return;
            await restoreEnvironmentArchive(
              archive ?? {
                archivedThreadIds: latestPending.threadIds,
                ...latestPending.exit,
              },
              latest.settled.then((result) =>
                result === null
                  ? null
                  : [...result.archivedThreadIds].reverse(),
              ),
            );
          },
          redo: async () => {
            const again = archiveEnvironment(environmentId);
            latestPending = again;
            latest = trackActionOutcome(again.archived);
            await again.archived;
          },
        };

        announced.entry = entry;
        history.record(entry, keyboardRevision);
        appToast.success(count === 1 ? "Thread archived" : "Threads archived", {
          className: INSTANT_TOAST_CLASS_NAME,
          description: `Archived ${count} ${count === 1 ? "thread" : "threads"}`,
          undo: () => {
            history.undoEntry(entry).catch((error: unknown) => {
              showMutationErrorToast({
                error,
                fallbackMessage: "Failed to restore archived threads",
              });
            });
          },
          duration: UNDO_TOAST_DURATION_MS,
          id: toastId,
        });
      };

      if (first.threadIds.length > 0) announce(first.threadIds.length);

      try {
        const archive = await first.archived;

        if (announced.entry === null && archive.archivedThreadIds.length > 0)
          announce(archive.archivedThreadIds.length);
      } catch (error) {
        if (announced.entry !== null) {
          history.forget(announced.entry);
          appToast.dismiss(toastId);
        }

        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to archive environment threads",
        });
        throw error;
      }
    },
    [archiveEnvironment, history, restoreEnvironmentArchive],
  );

  const archiveThreadFamily = useCallback(
    async (
      thread: ThreadRef,
      childThreadsConfirmed: boolean,
      exit: ThreadExit,
      announce?: (archivedThreadIds: readonly string[]) => void,
      isUndoRequested?: () => boolean,
    ): Promise<readonly string[]> => {
      try {
        const response = await archiveThreadAndChildrenMutateAsync({
          id: thread.id,
          childThreadsConfirmed,
          onOptimistic: (archivedThreadIds) => {
            exit.leave();
            announce?.(archivedThreadIds);
          },
        });

        if (!isUndoRequested?.())
          closePanesForThreads(response.archivedThreadIds);

        return response.archivedThreadIds;
      } catch (error) {
        exit.restore();
        throw error;
      }
    },
    [archiveThreadAndChildrenMutateAsync, closePanesForThreads],
  );

  const unarchiveThreadFamily = useCallback(
    async (
      thread: ThreadRef,
      archivedThreadIds: readonly string[],
      exit: ThreadExit,
      beforeRequest?: Promise<readonly string[] | null>,
    ) => {
      const shouldReturnToThread =
        exit.destination !== null &&
        viewedRouteRef.current === exit.destination;

      const restoring = unarchiveThreadsInOrder({
        queryClient,
        threadIds: [...archivedThreadIds].reverse(),
        beforeRequest,
      });

      if (shouldReturnToThread)
        navigateImmediately(
          getThreadRoutePath({
            projectId: thread.projectId,
            threadId: thread.id,
          }),
        );

      await restoring;
    },
    [navigateImmediately, queryClient],
  );

  const performArchive = useCallback(
    ({
      childThreadsConfirmed,
      closeDialog,
      thread,
    }: ArchiveThreadActionRequest) => {
      if (pendingArchivesRef.current.has(thread.id)) return;

      if (!childThreadsConfirmed) {
        const { unarchivedDescendantCount } = readCachedChildThreadCounts(
          queryClient,
          thread.id,
        );

        if (unarchivedDescendantCount > 0) {
          openArchiveDialog({
            thread,
            childThreadCount: unarchivedDescendantCount,
          });

          return;
        }
      }

      pendingArchivesRef.current.add(thread.id);
      const keyboardRevision = history.keyboardRevision;
      const exit = beginThreadExit(thread);
      const toastId = `thread-archived-${thread.id}`;
      closeDialog?.();

      const pending: { latest: PendingThreadArchive | null } = { latest: null };

      const entry: HistoryEntry = {
        label: describeThreadAction("Archive", thread),
        undo: async () => {
          const latest = pending.latest;

          if (latest === null) return;

          latest.undoRequested = true;

          if (latest.archived.current === null) return;
          await unarchiveThreadFamily(
            thread,
            latest.archived.current ?? latest.threadIds,
            latest.exit,
            latest.archived.settled.then((ids) =>
              ids === null ? null : [...ids].reverse(),
            ),
          );
        },
        redo: async () => {
          const redoExit = beginThreadExit(thread);

          const archiving = archiveThreadFamily(
            thread,
            true,
            redoExit,
            (ids) => {
              if (pending.latest !== null) pending.latest.threadIds = ids;
            },
            () => pending.latest?.undoRequested ?? false,
          );

          pending.latest = {
            archived: trackActionOutcome(archiving),
            threadIds: [thread.id],
            undoRequested: false,
            exit: redoExit,
          };
          await archiving;
        },
      };

      const announce = (archivedThreadIds: readonly string[]) => {
        if (pending.latest !== null)
          pending.latest.threadIds = archivedThreadIds;
        history.record(entry, keyboardRevision);
        appToast.success("Thread archived", {
          className: INSTANT_TOAST_CLASS_NAME,
          description: (
            <ArchivedThreadToastDescription
              archivedThreadCount={archivedThreadIds.length}
              threadTitle={getThreadDisplayTitle(thread)}
              onOpenThread={() => {
                navigateImmediately(
                  getThreadRoutePath({
                    projectId: thread.projectId,
                    threadId: thread.id,
                  }),
                );
                appToast.dismiss(toastId);
              }}
            />
          ),
          undo: () => {
            history.undoEntry(entry).catch((error: unknown) => {
              showMutationErrorToast({
                error,
                fallbackMessage: "Failed to unarchive thread.",
              });
            });
          },
          duration: UNDO_TOAST_DURATION_MS,
          id: toastId,
        });
      };

      const archiving = archiveThreadFamily(
        thread,
        childThreadsConfirmed,
        exit,
        announce,
        () => pending.latest?.undoRequested ?? false,
      );

      pending.latest = {
        archived: trackActionOutcome(archiving),
        threadIds: [thread.id],
        undoRequested: false,
        exit,
      };
      archiving.then(
        () => {
          pendingArchivesRef.current.delete(thread.id);
        },
        (error: unknown) => {
          pendingArchivesRef.current.delete(thread.id);
          history.forget(entry);
          appToast.dismiss(toastId);

          if (error instanceof ArchiveThreadConfirmationRequired) {
            openArchiveDialog({
              thread,
              childThreadCount: error.childThreadCount,
            });

            return;
          }

          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to archive thread and its child threads",
            lifecycleOperation: "archive_thread",
          });
        },
      );
    },
    [
      archiveThreadFamily,
      beginThreadExit,
      history,
      openArchiveDialog,
      navigateImmediately,
      queryClient,
      unarchiveThreadFamily,
    ],
  );

  const archiveThreadAsync = useCallback(
    async (thread: ThreadRef) => {
      if (pendingArchivesRef.current.has(thread.id)) return;
      pendingArchivesRef.current.add(thread.id);

      try {
        await archiveThreadFamily(thread, true, beginThreadExit(thread));
      } finally {
        pendingArchivesRef.current.delete(thread.id);
      }
    },
    [archiveThreadFamily, beginThreadExit],
  );

  const shelveThread = useCallback(
    async (
      thread: ThreadRef,
      exit: ThreadExit,
      announce?: () => void,
      timing?: ReturnType<typeof startShelfMoveTiming>,
    ): Promise<void> => {
      try {
        await runThreadShelfMutation({
          queryClient,
          threadId: thread.id,
          shelvedAt: Date.now(),
          request: () => {
            timing?.requestStarted();

            const request = sdk.threads.shelve({
              threadId: thread.id,
              experimental_onServerTiming: timing?.responseTiming,
            });

            return timing === undefined
              ? request
              : request.finally(() => timing.requestSettled());
          },
          onOptimistic: () => {
            timing?.optimisticStarted();
            exit.leave();
            announce?.();
          },
        });
        timing?.finish("saved");
      } catch (error) {
        exit.restore();
        timing?.finish("failed");
        throw error;
      }
    },
    [queryClient],
  );

  const unshelveThread = useCallback(
    async (
      thread: ThreadRef,
      exit: ThreadExit,
      beforeRequest?: Promise<boolean | null>,
    ) => {
      const shouldReturn =
        exit.destination !== null &&
        viewedRouteRef.current === exit.destination;

      const unshelving = (async () => {
        if (beforeRequest !== undefined) {
          const transaction = await beginThreadShelfTransaction({
            queryClient,
            threadId: thread.id,
            shelvedAt: null,
          });

          const accepted = await beforeRequest;
          transaction.releasePendingPatches();

          if (accepted === null) return;
        }

        await runThreadShelfMutation({
          queryClient,
          threadId: thread.id,
          shelvedAt: null,
          request: () => sdk.threads.unshelve({ threadId: thread.id }),
        });
      })();

      if (shouldReturn) navigateImmediately(exit.previousRoute);
      await unshelving;
    },
    [navigateImmediately, queryClient],
  );

  const requestShelve = useCallback(
    (thread: ThreadRef) => {
      const timing = startShelfMoveTiming();

      const label = describeThreadAction(
        "Shelve",
        lookupCachedThread(queryClient, thread.id),
      );

      const toastId = `thread-shelved-${thread.id}`;
      const pending: { latest: PendingThreadShelve | null } = { latest: null };

      const entry: HistoryEntry = {
        label,
        undo: async () => {
          const latest = pending.latest;

          if (latest === null) return;

          if (latest.shelved.current === null) return;
          await unshelveThread(thread, latest.exit, latest.shelved.settled);
        },
        redo: async () => {
          const timing = startShelfMoveTiming();
          const redoExit = beginThreadExit(thread);
          const shelving = shelveThread(thread, redoExit, undefined, timing);
          pending.latest = {
            exit: redoExit,
            shelved: trackActionOutcome(shelving.then(() => true)),
          };
          await shelving;
        },
      };

      const exit = beginThreadExit(thread);

      const shelving = shelveThread(
        thread,
        exit,
        () => {
          history.record(entry);
          appToast.success("Shelved", {
            className: INSTANT_TOAST_CLASS_NAME,
            undo: () => {
              history.undoEntry(entry).catch((error: unknown) => {
                showMutationErrorToast({
                  error,
                  fallbackMessage: "Failed to unshelve thread.",
                });
              });
            },
            duration: UNDO_TOAST_DURATION_MS,
            id: toastId,
          });
        },
        timing,
      );

      pending.latest = {
        exit,
        shelved: trackActionOutcome(shelving.then(() => true)),
      };
      shelving.catch((error: unknown) => {
        history.forget(entry);
        appToast.dismiss(toastId);
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to shelve thread.",
        });
      });
    },
    [beginThreadExit, history, queryClient, shelveThread, unshelveThread],
  );

  const requestArchive = useCallback(
    (thread: Thread) => {
      performArchive({
        thread,
        childThreadsConfirmed: !confirmThreadArchive,
      });
    },
    [confirmThreadArchive, performArchive],
  );

  const confirmArchive = useCallback(
    (target: ThreadArchiveDialogTarget) => {
      performArchive({
        childThreadsConfirmed: true,
        closeDialog: closeArchiveDialog,
        thread: target.thread,
      });
    },
    [closeArchiveDialog, performArchive],
  );

  const toggleRead = useCallback(
    (thread: Thread) => {
      if (getThreadReadToggleAction(thread) === "mark_unread") {
        markUnreadMutate(
          { threadId: thread.id },
          {
            onError: (error) => {
              showMutationErrorToast({
                error,
                fallbackMessage: "Failed to mark thread unread",
              });
            },
          },
        );

        return;
      }

      markReadMutate(
        { threadId: thread.id },
        {
          onError: (error) => {
            showMutationErrorToast({
              error,
              fallbackMessage: "Failed to mark thread read",
            });
          },
        },
      );
    },
    [markReadMutate, markUnreadMutate],
  );

  const togglePin = useCallback(
    (thread: Thread) => {
      if (thread.pinnedAt !== null) {
        unpinMutate({ id: thread.id });

        return;
      }

      pinMutate({ id: thread.id });
    },
    [pinMutate, unpinMutate],
  );

  const value = useMemo<ThreadActionsContextValue>(
    () => ({
      archiveEnvironmentThreads,
      archiveThreadAsync,
      renameThreadAsync,
      requestRename,
      requestArchive,
      requestShelve,
      requestDelete,
      unarchiveThread: unarchiveThreadAction,
      togglePin,
      toggleRead,
    }),
    [
      archiveEnvironmentThreads,
      archiveThreadAsync,
      renameThreadAsync,
      requestArchive,
      requestRename,
      requestDelete,
      requestShelve,
      togglePin,
      toggleRead,
      unarchiveThreadAction,
    ],
  );

  const requestRenameById = (threadId: string) => {
    resolveThread(queryClient, threadId).then(
      (thread) => window.setTimeout(() => requestRename(thread), 0),
      (error: unknown) =>
        showMutationErrorToast({
          error,
          fallbackMessage: "Failed to rename thread.",
        }),
    );
  };

  return (
    <ThreadActionsContext.Provider value={value}>
      <ThreadActionCollectors
        coreRegistrations={CORE_THREAD_ACTIONS}
        requestRename={requestRenameById}
      />
      {children}
      <ThreadRenameDialog
        target={renameDialog.target}
        onOpenChange={renameDialog.onOpenChange}
        onRename={submitRename}
      />
      <ThreadDeleteDialog
        target={deleteDialog.target}
        onOpenChange={deleteDialog.onOpenChange}
        onDelete={confirmDelete}
      />
      <ThreadArchiveDialog
        target={archiveDialog.target}
        onOpenChange={archiveDialog.onOpenChange}
        onArchive={confirmArchive}
      />
    </ThreadActionsContext.Provider>
  );
}

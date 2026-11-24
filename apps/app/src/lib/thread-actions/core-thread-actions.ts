import { useLayoutEffect, useMemo, useRef } from "react";
import { useAtomValue } from "jotai";
import { useQueryClient } from "@tanstack/react-query";
import {
  experimental_THREAD_ACTION_GROUPS as GROUPS,
  type PluginThreadAction,
  type PluginThreadActionItemInput,
  type PluginThreadActionRegistration,
  type PluginThreadActionTarget,
} from "@omnyo/plugin-sdk";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { useThreadActions } from "@/lib/thread-actions/thread-actions-context";
import { useActionHistory } from "@/components/layout/ActionHistoryProvider";
import { useRouteState } from "@/hooks/useRouteState";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { showMutationErrorToast } from "@/lib/mutation-errors";
import {
  lookupCachedThread,
  resolveThread,
} from "@/lib/thread-cache-resolution";
import { getThreadRoutePath } from "@/lib/route-paths";
import { countPanes, listPanes } from "@/lib/split-layout";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { canonicalAppOrigin } from "@/lib/canonical-app-origin";
import { describeThreadAction } from "@/lib/thread-title";
import { trackActionOutcome, type HistoryEntry } from "@/lib/action-history";
import {
  getThreadLifecycle,
  type ThreadLifecycle,
} from "@/lib/thread-lifecycle";
import type { PluginThreadGroupActions } from "@omnyo/plugin-sdk";
import type { ThreadGroupResponse } from "@omnyo/server-contract";
import { listSidebarNavigationThreads } from "@/hooks/cache-owners/query-cache";
import { useImmediateSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useThreadGroupActions } from "@/hooks/useThreadGroupActions";

const NO_GROUP_CHOICE = "omnyo--no-group";

interface ThreadGroupMenuData {
  actions: PluginThreadGroupActions;
  groupIdByThread: ReadonlyMap<string, string | null>;
  groups: readonly ThreadGroupResponse[];
}

function useThreadGroupMenuData(): ThreadGroupMenuData {
  const { data } = useImmediateSidebarNavigation();
  const actions = useThreadGroupActions();

  return useMemo(
    () => ({
      actions,
      groupIdByThread: new Map(
        (data === undefined ? [] : listSidebarNavigationThreads(data)).map(
          (thread) => [thread.id, thread.groupId],
        ),
      ),
      groups: data?.groups ?? [],
    }),
    [actions, data],
  );
}

function coreThreadAction<Data>(
  registration: PluginThreadActionRegistration<Data>,
): PluginThreadActionRegistration<unknown> {
  return registration;
}

export function getThreadUrl(thread: PluginThreadActionTarget): string {
  return new URL(
    getThreadRoutePath({ projectId: thread.projectId, threadId: thread.id }),
    canonicalAppOrigin(),
  ).toString();
}

interface SplitAvailability {
  available: boolean;
  focusedThreadId: string | null;
  otherPaneThreadIds: ReadonlySet<string>;
}

function useSplitAvailability(): SplitAvailability {
  const isCompact = useIsCompactViewport();
  const layout = useAtomValue(splitLayoutAtom);
  const { threadId } = useRouteState();

  const panes =
    layout !== null && countPanes(layout.root) > 1
      ? listPanes(layout.root)
      : [];

  const focusedPane = panes.find(
    (pane) => pane.paneId === layout?.focusedPaneId,
  );

  const focusedThreadId =
    panes.length === 0
      ? (threadId ?? null)
      : focusedPane?.content.kind === "thread"
        ? focusedPane.content.threadId
        : null;

  const otherPaneThreadIdsKey = panes
    .flatMap((pane) =>
      pane !== focusedPane && pane.content.kind === "thread"
        ? [pane.content.threadId]
        : [],
    )
    .join("\n");

  return useMemo(
    () => ({
      available: !isCompact,
      focusedThreadId,
      otherPaneThreadIds: new Set(
        otherPaneThreadIdsKey === "" ? [] : otherPaneThreadIdsKey.split("\n"),
      ),
    }),
    [focusedThreadId, isCompact, otherPaneThreadIdsKey],
  );
}

function afterMenuCloses(run: () => void): void {
  window.setTimeout(run, 0);
}

interface ThreadHistoryStep {
  apply: () => Promise<unknown>;
  failureMessage: string;
  revert: () => Promise<unknown>;
  threadId: string;
  verb: string;
}

type RunThreadStep = (step: ThreadHistoryStep) => Promise<void>;

function useRunThreadStep(): RunThreadStep {
  const history = useActionHistory();
  const queryClient = useQueryClient();

  return useMemo(
    () =>
      async ({ apply, failureMessage, revert, threadId, verb }) => {
        const label = describeThreadAction(
          verb,
          lookupCachedThread(queryClient, threadId),
        );

        const applying = apply();
        const applied = trackActionOutcome(applying.then(() => true));

        const entry: HistoryEntry = {
          label,
          undo: async () => {
            const result =
              applied.current === undefined
                ? await applied.settled
                : applied.current;

            if (result !== null) await revert();
          },
          redo: async () => {
            await apply();
          },
        };

        history.record(entry);

        try {
          await applying;
        } catch (error) {
          history.forget(entry);
          showMutationErrorToast({ error, fallbackMessage: failureMessage });
        }
      },
    [history, queryClient],
  );
}

interface LifecycleHandlers {
  archive: (threadId: string) => Promise<void>;
  archiveQuietly: (thread: PluginThreadActionTarget) => Promise<void>;
  requestDelete: (threadId: string) => Promise<void>;
  runStep: RunThreadStep;
  shelve: (thread: PluginThreadActionTarget) => void;
}

function useLifecycleHandlers(): LifecycleHandlers {
  const actions = useThreadActions();
  const queryClient = useQueryClient();
  const runStep = useRunThreadStep();
  const latest = useRef(actions);
  useLayoutEffect(() => {
    latest.current = actions;
  });

  return useMemo(
    () => ({
      runStep,
      archiveQuietly: (thread: PluginThreadActionTarget) =>
        latest.current.archiveThreadAsync(thread),
      archive: async (threadId: string) => {
        try {
          latest.current.requestArchive(
            lookupCachedThread(queryClient, threadId) ??
              (await resolveThread(queryClient, threadId)),
          );
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to archive thread.",
          });
        }
      },
      requestDelete: async (threadId: string) => {
        try {
          latest.current.requestDelete(
            await resolveThread(queryClient, threadId),
          );
        } catch (error) {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to delete thread.",
          });
        }
      },
      shelve: (thread: PluginThreadActionTarget) => {
        latest.current.requestShelve(thread);
      },
    }),
    [queryClient, runStep],
  );
}

const SHELF_ITEMS: Record<
  ThreadLifecycle,
  | ((
      input: PluginThreadActionItemInput<LifecycleHandlers>,
    ) => PluginThreadAction)
  | null
> = {
  active: ({ thread, data }) => ({
    label: "Shelve",
    icon: "Bookshelf",
    run: () => data.shelve(thread),
  }),
  shelved: ({ thread, sdk, data }) => ({
    label: "Unshelve",
    icon: "BookUpload",
    run: () =>
      data.runStep({
        verb: "Unshelve",
        threadId: thread.id,
        apply: () => sdk.threads.unshelve({ threadId: thread.id }),
        revert: () => sdk.threads.shelve({ threadId: thread.id }),
        failureMessage: "Failed to unshelve thread.",
      }),
  }),
  archived: null,
};

export const CORE_THREAD_ACTIONS: readonly PluginThreadActionRegistration<unknown>[] =
  [
    coreThreadAction({
      id: "moveToGroup",
      group: GROUPS.organize,
      order: 45,
      title: "Move to group",
      icon: "Folder",
      useData: useThreadGroupMenuData,
      item: ({ thread, data }) => {
        if (thread.parentThreadId !== null || thread.archivedAt !== null) {
          return null;
        }

        const groups = data.groups.filter(
          (group) => group.projectId === thread.projectId,
        );

        if (groups.length === 0) return null;
        const current = data.groupIdByThread.get(thread.id) ?? null;

        return {
          label: "Move to group",
          icon: "Folder",
          choices: {
            items: [
              ...groups.map((group) => ({
                id: group.id,
                label: group.name,
                selected: group.id === current,
                disabled: group.id === current,
              })),
              ...(current === null
                ? []
                : [{ id: NO_GROUP_CHOICE, label: "No group" }]),
            ],
          },
          run: ({ value }) => {
            if (value === undefined || value === null) return;

            return data.actions
              .move(thread.id, value === NO_GROUP_CHOICE ? null : value)
              .catch(() => undefined);
          },
        };
      },
    }),
    coreThreadAction({
      id: "split",
      group: GROUPS.open,
      order: 10,
      title: "Open in split",
      icon: "Columns2",
      useData: useSplitAvailability,
      item: ({ thread, data, navigate }) =>
        !data.available || data.focusedThreadId === thread.id
          ? null
          : {
              label: data.otherPaneThreadIds.has(thread.id)
                ? "Focus split"
                : "Open in split",
              icon: "Columns2",
              run: () => navigate.toThread(thread.id, { split: true }),
            },
    }),
    coreThreadAction({
      id: "newThreadInEnvironment",
      group: GROUPS.open,
      order: 20,
      title: "New thread in environment",
      icon: "MessageSquarePlus",
      item: ({ thread, navigate }) => {
        const environment = thread.environment;

        if (environment === null || environment.path === null) {
          return null;
        }

        return {
          label: "New thread in environment",
          icon: "MessageSquarePlus",
          run: () =>
            navigate.toCompose({
              projectId: thread.projectId,
              environmentId: environment.id,
              placement: {
                sectionId: thread.sectionId,
                pinned: thread.pinnedAt !== null,
              },
              focusPrompt: true,
            }),
        };
      },
    }),
    coreThreadAction({
      id: "copyLink",
      group: GROUPS.open,
      order: 30,
      title: "Copy thread link",
      icon: "Link",
      item: ({ thread }) => ({
        label: "Copy link",
        icon: "Link",
        run: () =>
          copyToClipboardWithToast(getThreadUrl(thread), {
            successMessage: "Thread link copied",
            errorMessage: "Failed to copy thread link",
          }).then(() => undefined),
      }),
    }),
    coreThreadAction({
      id: "read",
      group: GROUPS.organize,
      order: 30,
      title: "Mark read / unread",
      icon: "MailOpen",
      useData: useRunThreadStep,
      item: ({ thread, sdk, data: runStep }) => ({
        label: thread.isUnread ? "Mark read" : "Mark unread",
        icon: thread.isUnread ? "MailOpen" : "Mail",
        run: () => {
          const target = { threadId: thread.id };
          const markRead = () => sdk.threads.markRead(target);
          const markUnread = () => sdk.threads.markUnread(target);

          return runStep(
            thread.isUnread
              ? {
                  verb: "Mark read",
                  threadId: thread.id,
                  apply: markRead,
                  revert: markUnread,
                  failureMessage: "Failed to mark thread read",
                }
              : {
                  verb: "Mark unread",
                  threadId: thread.id,
                  apply: markUnread,
                  revert: markRead,
                  failureMessage: "Failed to mark thread unread",
                },
          );
        },
      }),
    }),
    coreThreadAction({
      id: "pin",
      group: GROUPS.organize,
      order: 20,
      title: "Pin",
      icon: "Pin",
      useData: useRunThreadStep,
      item: ({ thread, sdk, data: runStep }) => {
        const isPinned = thread.pinnedAt !== null;

        return {
          label: isPinned ? "Unpin" : "Pin",
          icon: isPinned ? "PinOff" : "Pin",
          run: () => {
            const target = { threadId: thread.id };
            const pin = () => sdk.threads.pin(target);
            const unpin = () => sdk.threads.unpin(target);

            return runStep(
              isPinned
                ? {
                    verb: "Unpin",
                    threadId: thread.id,
                    apply: unpin,
                    revert: pin,
                    failureMessage: "Failed to unpin thread.",
                  }
                : {
                    verb: "Pin",
                    threadId: thread.id,
                    apply: pin,
                    revert: unpin,
                    failureMessage: "Failed to pin thread.",
                  },
            );
          },
        };
      },
    }),
    coreThreadAction({
      id: "shelve",
      group: GROUPS.lifecycle,
      order: 10,
      title: "Shelve",
      icon: "Bookshelf",
      useData: useLifecycleHandlers,
      item: (input) =>
        input.thread.parentThreadId === null
          ? (SHELF_ITEMS[getThreadLifecycle(input.thread)]?.(input) ?? null)
          : null,
    }),
    coreThreadAction({
      id: "rename",
      group: GROUPS.organize,
      order: 10,
      title: "Rename",
      icon: "Edit",
      item: ({ thread }) => ({
        label: "Rename",
        icon: "Edit",
        run: ({ requestRename }) => requestRename(thread.id),
      }),
    }),
    coreThreadAction({
      id: "archive",
      group: GROUPS.lifecycle,
      order: 20,
      title: "Archive",
      icon: "Archive",
      useData: useLifecycleHandlers,
      item: ({ thread, data, sdk }) => {
        const isArchived = thread.archivedAt !== null;

        return {
          label: isArchived ? "Unarchive" : "Archive",
          icon: isArchived ? "ArchiveRestore" : "Archive",
          run: async () => {
            if (!isArchived) {
              await data.archive(thread.id);

              return;
            }

            await data.runStep({
              verb: "Unarchive",
              threadId: thread.id,
              apply: () => sdk.threads.unarchive({ threadId: thread.id }),
              revert: () => data.archiveQuietly(thread),
              failureMessage: "Failed to unarchive thread.",
            });
          },
        };
      },
    }),
    coreThreadAction({
      id: "delete",
      group: GROUPS.lifecycle,
      order: 30,
      title: "Delete",
      icon: "Trash2",
      useData: useLifecycleHandlers,
      item: ({ thread, data }) => ({
        label: "Delete",
        icon: "Trash2",
        variant: "destructive",
        run: () => afterMenuCloses(() => void data.requestDelete(thread.id)),
      }),
    }),
  ];

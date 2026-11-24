import { useMemo } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { suggestThreadGroupName, type ThreadListEntry } from "@omnyo/domain";
import type { PluginThreadGroupActions } from "@omnyo/plugin-sdk";
import type {
  SidebarBootstrapResponse,
  ThreadGroupResponse,
} from "@omnyo/server-contract";
import { appToast } from "@/components/ui/app-toast";
import {
  findSidebarNavigationThreadPlaceholder,
  getCachedSidebarNavigationThreads,
} from "@/hooks/cache-owners/query-cache";
import {
  applyThreadMetadataBatchResult,
  beginThreadMetadataBatchTransaction,
  rollbackThreadMetadataBatchTransaction,
} from "@/hooks/cache-owners/thread-state-cache-owner";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { setChatSelection } from "@/lib/chat-selection";
import { sdk } from "@/lib/sdk";

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chatCount(count: number): string {
  return `${count} chat${count === 1 ? "" : "s"}`;
}

function readCachedGroups(queryClient: QueryClient): ThreadGroupResponse[] {
  return (
    queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    )?.groups ?? []
  );
}

function updateCachedGroups(
  queryClient: QueryClient,
  update: (groups: ThreadGroupResponse[]) => ThreadGroupResponse[],
): void {
  queryClient.setQueryData<SidebarBootstrapResponse>(
    sidebarNavigationQueryKey(),
    (current) =>
      current ? { ...current, groups: update(current.groups) } : current,
  );
}

function groupableChats(
  queryClient: QueryClient,
  threadIds: readonly string[],
): ThreadListEntry[] {
  const chats = threadIds.flatMap((threadId) => {
    const chat = findSidebarNavigationThreadPlaceholder(queryClient, threadId);

    return chat !== undefined &&
      chat.parentThreadId === null &&
      chat.archivedAt === null
      ? [chat]
      : [];
  });

  const projectId = chats[0]?.projectId;

  return chats.filter((chat) => chat.projectId === projectId);
}

export function createThreadGroupActions(
  queryClient: QueryClient,
): PluginThreadGroupActions {
  const createGroup = async (name: string, threadIds: readonly string[]) => {
    const created = await sdk.threadGroups.create({
      name,
      threadIds: [...threadIds],
    });

    updateCachedGroups(queryClient, (groups) => [
      ...groups.filter((group) => group.id !== created.group.id),
      created.group,
    ]);

    const transaction = await beginThreadMetadataBatchTransaction({
      queryClient,
      updates: created.threadIds.map((threadId) => ({
        threadId,
        groupId: created.group.id,
      })),
    });

    transaction.releasePendingPatches();

    return created;
  };

  const removeGroup = async (groupId: string) => {
    const group =
      readCachedGroups(queryClient).find((entry) => entry.id === groupId) ??
      null;

    const memberIds = getCachedSidebarNavigationThreads(queryClient)
      .filter((chat) => chat.groupId === groupId)
      .map((chat) => chat.id);

    updateCachedGroups(queryClient, (groups) =>
      groups.filter((entry) => entry.id !== groupId),
    );

    const transaction = await beginThreadMetadataBatchTransaction({
      queryClient,
      updates: memberIds.map((threadId) => ({ threadId, groupId: null })),
    });

    try {
      await sdk.threadGroups.delete({ id: groupId });
    } catch (error) {
      rollbackThreadMetadataBatchTransaction({ queryClient, transaction });

      if (group) {
        updateCachedGroups(queryClient, (groups) => [...groups, group]);
      }

      throw error;
    } finally {
      transaction.releasePendingPatches();
    }

    return { group, memberIds };
  };

  const showUndoFailure = (title: string) => (error: unknown) => {
    appToast.error(title, { description: errorDescription(error) });
  };

  return {
    async group(threadIds) {
      const members = groupableChats(queryClient, threadIds);

      if (members.length === 0) {
        if (threadIds.length > 0) {
          appToast.warning("Couldn't group these chats", {
            description: "Sub-chats stay with the chat they belong to.",
          });
        }

        return null;
      }

      const name = suggestThreadGroupName(
        members.map((chat) => chat.title ?? chat.titleFallback ?? ""),
      );

      try {
        const created = await createGroup(
          name,
          members.map((chat) => chat.id),
        );

        setChatSelection([]);

        const leftOut = threadIds.length - created.threadIds.length;

        appToast.success(
          `Grouped ${chatCount(created.threadIds.length)} as “${created.group.name}”`,
          {
            ...(leftOut > 0
              ? {
                  description: `Left out ${chatCount(leftOut)} from another project or under another chat.`,
                }
              : {}),
            undo: () =>
              void removeGroup(created.group.id).catch(
                showUndoFailure("Couldn't undo the group"),
              ),
          },
        );

        return created.group.id;
      } catch (error) {
        appToast.error("Couldn't group chats", {
          description: errorDescription(error),
        });
        throw error;
      }
    },

    async rename(groupId, name) {
      const trimmed = name.trim();

      const previous = readCachedGroups(queryClient).find(
        (group) => group.id === groupId,
      );

      if (trimmed.length === 0 || previous?.name === trimmed) return;

      updateCachedGroups(queryClient, (groups) =>
        groups.map((group) =>
          group.id === groupId ? { ...group, name: trimmed } : group,
        ),
      );

      try {
        await sdk.threadGroups.update({ id: groupId, name: trimmed });
      } catch (error) {
        if (previous) {
          updateCachedGroups(queryClient, (groups) =>
            groups.map((group) =>
              group.id === groupId ? { ...group, name: previous.name } : group,
            ),
          );
        }

        appToast.error("Couldn't rename the group", {
          description: errorDescription(error),
        });
        throw error;
      }
    },

    async ungroup(groupId) {
      try {
        const { group, memberIds } = await removeGroup(groupId);

        appToast.success(group ? `Ungrouped “${group.name}”` : "Ungrouped", {
          ...(group && memberIds.length > 0
            ? {
                undo: () =>
                  void createGroup(group.name, memberIds).catch(
                    showUndoFailure("Couldn't restore the group"),
                  ),
              }
            : {}),
        });
      } catch (error) {
        appToast.error("Couldn't ungroup", {
          description: errorDescription(error),
        });
        throw error;
      }
    },

    async move(threadId, groupId) {
      const transaction = await beginThreadMetadataBatchTransaction({
        queryClient,
        updates: [{ threadId, groupId }],
      });

      try {
        const thread = await sdk.threads.update({ threadId, groupId });
        applyThreadMetadataBatchResult({ queryClient, threads: [thread] });
      } catch (error) {
        rollbackThreadMetadataBatchTransaction({ queryClient, transaction });
        appToast.error("Couldn't move the chat", {
          description: errorDescription(error),
        });
        throw error;
      } finally {
        transaction.releasePendingPatches();
      }
    },
  };
}

export function useThreadGroupActions(): PluginThreadGroupActions {
  const queryClient = useQueryClient();

  return useMemo(() => createThreadGroupActions(queryClient), [queryClient]);
}

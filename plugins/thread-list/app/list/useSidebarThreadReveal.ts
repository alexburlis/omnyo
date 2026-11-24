import { useEffect, useMemo, useRef } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { NO_MACHINE_GROUP_KEY } from "../model/machine-thread-groups.js";
import { buildPinnedSidebarState } from "../model/pinned-sidebar-threads.js";
import {
  CHRONOLOGICAL_CONTAINER_ID,
  resolveSidebarProjectId,
} from "../model/project-thread-groups.js";
import { sectionKeyForThreadSection } from "../model/section-keys.js";
import type { CollapsibleSidebarSectionId } from "../model/sidebar-section-id.js";
import { experimental_useAppContext } from "@omnyo/plugin-sdk/app";
import type { OrganizationMode as SidebarOrganizationMode } from "../../shared/preferences.js";
import { useSidebarData } from "../model/use-sidebar-data.js";
import {
  revealChatGroupIdsAtom,
  revealEnvironmentIdsAtom,
  revealMachineKeysAtom,
  revealProjectIdsAtom,
  revealSidebarSectionIdsAtom,
  revealThreadSectionKeysAtom,
  sidebarOrganizationModeAtom,
} from "../preferences/atoms.js";
import { usePreferencesReady } from "../preferences/PreferencesSync.js";

interface ThreadSidebarExpansionArgs {
  organizationMode: SidebarOrganizationMode;
  isPinned: boolean;
  thread: SidebarThread;
  sidebarProjectId: string;
  personalProjectId: string | null;
}

interface ThreadSidebarExpansion {
  sectionKey?: string;
  machineKey?: string;
  projectId?: string;
  sidebarSectionId?: CollapsibleSidebarSectionId;
}

export function getThreadSidebarExpansion({
  organizationMode,
  isPinned,
  thread,
  sidebarProjectId,
  personalProjectId,
}: ThreadSidebarExpansionArgs): ThreadSidebarExpansion {
  if (isPinned) {
    return { sidebarSectionId: "pinned" };
  }

  if (organizationMode === "machine") {
    return {
      machineKey: thread.host?.id ?? NO_MACHINE_GROUP_KEY,
    };
  }

  if (organizationMode === "chronological") {
    const sectionKey = sectionKeyForThreadSection(
      CHRONOLOGICAL_CONTAINER_ID,
      thread.sectionId,
    );

    return sectionKey ? { sectionKey } : { sidebarSectionId: "threads" };
  }

  if (sidebarProjectId === personalProjectId) {
    return { sidebarSectionId: "threads" };
  }

  return { projectId: sidebarProjectId };
}

export function useSidebarThreadReveal(): void {
  const { threadId: routedThreadId } = experimental_useAppContext();
  const { status, projects, personalProject } = useSidebarData();
  const preferencesReady = usePreferencesReady();

  const threads = useMemo<SidebarThread[]>(
    () => projects.flatMap((project) => project.threads),
    [projects],
  );

  useSidebarThreadRevealCore({
    selectedThreadId: routedThreadId ?? undefined,
    threads,
    threadsReady: status === "ready",
    preferencesReady,
    personalProjectId: personalProject?.id ?? null,
  });
}

export interface SidebarThreadRevealInputs {
  selectedThreadId: string | undefined;
  threads: readonly SidebarThread[];
  threadsReady: boolean;
  preferencesReady: boolean;
  personalProjectId: string | null;
}

export function useSidebarThreadRevealCore({
  selectedThreadId,
  threads,
  threadsReady,
  preferencesReady,
  personalProjectId,
}: SidebarThreadRevealInputs): void {
  const organizationMode = useAtomValue(sidebarOrganizationModeAtom);
  const revealEnvironmentIds = useSetAtom(revealEnvironmentIdsAtom);
  const revealProjectIds = useSetAtom(revealProjectIdsAtom);
  const revealMachineKeys = useSetAtom(revealMachineKeysAtom);
  const revealThreadSectionKeys = useSetAtom(revealThreadSectionKeysAtom);
  const revealSidebarSectionIds = useSetAtom(revealSidebarSectionIdsAtom);
  const revealChatGroupIds = useSetAtom(revealChatGroupIdsAtom);

  const threadById = useMemo(
    () => new Map(threads.map((thread) => [thread.id, thread])),
    [threads],
  );

  const effectivePinnedThreadIds = useMemo(
    () => buildPinnedSidebarState({ threads }).effectivePinnedThreadIds,
    [threads],
  );

  const previousThreadId = useRef<string | undefined>(undefined);
  const pendingNavigation = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!preferencesReady || !threadsReady) {
      return;
    }

    if (previousThreadId.current !== selectedThreadId) {
      previousThreadId.current = selectedThreadId;
      pendingNavigation.current = selectedThreadId;
    }

    const revealIds = new Set<string>();
    const navigationRevealId = pendingNavigation.current;

    if (navigationRevealId && threadById.has(navigationRevealId)) {
      revealIds.add(navigationRevealId);
      pendingNavigation.current = undefined;
    }

    for (const threadId of revealIds) {
      const thread = threadById.get(threadId);

      if (!thread || thread.isHidden) {
        continue;
      }

      const environmentIdsToExpand = new Set<string>();
      let currentThread: SidebarThread | undefined = thread;
      let remainingHops = threadById.size;

      while (currentThread && remainingHops > 0) {
        const environmentId = currentThread.environment?.id ?? null;

        if (environmentId !== null) {
          environmentIdsToExpand.add(environmentId);
        }

        const parentThreadId = currentThread.parentThreadId;

        if (parentThreadId === null) {
          break;
        }

        const parentThread = threadById.get(parentThreadId);

        if (!parentThread) {
          break;
        }

        currentThread = parentThread;
        remainingHops -= 1;
      }

      revealEnvironmentIds(environmentIdsToExpand);

      const chatGroupId = currentThread?.experimental_groupId ?? null;

      if (chatGroupId !== null && currentThread?.parentThreadId === null) {
        revealChatGroupIds(new Set([chatGroupId]));
      }

      const isPinned = effectivePinnedThreadIds.has(thread.id);

      const expansion = getThreadSidebarExpansion({
        organizationMode,
        isPinned,
        thread,
        sidebarProjectId: resolveSidebarProjectId(thread, threadById),
        personalProjectId,
      });

      if (expansion.machineKey) {
        revealMachineKeys(new Set([expansion.machineKey]));
      }

      if (expansion.sectionKey) {
        revealThreadSectionKeys(new Set([expansion.sectionKey]));
      }

      if (expansion.projectId) {
        revealProjectIds(new Set([expansion.projectId]));
      }

      if (expansion.sidebarSectionId) {
        revealSidebarSectionIds(new Set([expansion.sidebarSectionId]));
      }
    }
  }, [
    selectedThreadId,
    threadsReady,
    preferencesReady,
    personalProjectId,
    organizationMode,
    threadById,
    effectivePinnedThreadIds,
    revealEnvironmentIds,
    revealProjectIds,
    revealMachineKeys,
    revealThreadSectionKeys,
    revealSidebarSectionIds,
    revealChatGroupIds,
  ]);
}

import { useCallback, useMemo } from "react";
import { useStore } from "jotai";
import {
  PERSONAL_PROJECT_ID,
  type Host,
  type ThreadListEntry,
  type ThreadPullRequest,
} from "@omnyo/domain";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import type {
  PluginSdkApp,
  PluginSidebarProject,
  PluginSidebarSection,
  PluginSidebarThreadGroup,
  PluginSidebarThread,
  PluginSidebarThreadActions,
  PluginSidebarThreadDraftState,
  PluginSidebarPullRequest,
  PluginSidebarThreadPullRequestState,
  PluginSidebarThreadRowStatus,
  PluginSidebarThreadShortcut,
  PluginSidebarThreadsState,
} from "@omnyo/plugin-sdk";
import { useSidebarThreadShortcut as useHostSidebarThreadShortcut } from "@/components/sidebar/sidebarThreadShortcuts";
import {
  useThreadTitleMentionResources,
  type ThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import {
  usePromptDraftHasInput,
  usePromptDraftInputThreadIds,
} from "@/hooks/usePromptDraftStorage";
import {
  usePluginThreadRowStatus,
  usePluginThreadRowStatuses,
} from "./plugin-thread-row-status";
import { usePluginThreadRowSubtitles } from "./plugin-thread-row-subtitle";
import { getThreadConversationCollapsedAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { useThreadActions } from "@/lib/thread-actions/thread-actions-context";
import {
  getEnvironmentPullRequestFromResponse,
  useEnvironmentPullRequest,
} from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import {
  useArchivedThreads,
  useShelvedThreads,
} from "@/hooks/queries/thread-queries";
import { useImmediateSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  usePinThread,
  useUnpinThread,
  useUpdateThread,
} from "@/hooks/mutations/thread-state-mutations";
import { useRouteNavigate } from "@/components/ui/app-route-anchor";
import {
  toPendingSidebarThread,
  toPluginSidebarThread,
} from "./plugin-sidebar-threads";
import { getThreadLifecycle, type ThreadLifecycle } from "./thread-lifecycle";
import {
  getPendingChatSnapshot,
  isPendingChatId,
  usePendingChats,
  type PendingChatSnapshot,
} from "./pending-chat-creations";
import {
  useSidebarThreadEntries,
  useSidebarThreadEntryById,
} from "./sidebar-thread-entries";
import { useSetRootComposeProjectId } from "./root-compose-selection";
import { openThreadInSplit } from "./split-layout/openThreadInSplit";
import {
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
  getSettingsProjectRoutePath,
  getThreadRoutePath,
} from "./route-paths";

const EMPTY_THREADS: readonly PluginSidebarThread[] = [];

const EMPTY_PROJECTS: readonly PluginSidebarProject[] = [];

const EMPTY_SECTIONS: readonly PluginSidebarSection[] = [];

const EMPTY_GROUPS: readonly PluginSidebarThreadGroup[] = [];

const EMPTY_HOST_NAMES: ReadonlyMap<string, string> = new Map();

const hostNamesByHosts = new WeakMap<
  readonly Host[],
  ReadonlyMap<string, string>
>();

function hostNamesFor(
  hosts: readonly Host[] | undefined,
): ReadonlyMap<string, string> {
  if (hosts === undefined) return EMPTY_HOST_NAMES;
  const cached = hostNamesByHosts.get(hosts);

  if (cached !== undefined) return cached;
  const names = new Map(hosts.map((host) => [host.id, host.name] as const));
  hostNamesByHosts.set(hosts, names);

  return names;
}

const pluginSidebarThreadByEntry = new WeakMap<
  ThreadListEntry,
  {
    hostNamesById: ReadonlyMap<string, string>;
    titleResources: ThreadTitleMentionResources;
    subtitle: string | null;
    thread: PluginSidebarThread;
  }
>();

function hasSameLookupFields(
  previous: PluginSidebarThread,
  next: PluginSidebarThread,
): boolean {
  return (
    previous.displayTitle === next.displayTitle &&
    previous.experimental_subtitle === next.experimental_subtitle &&
    previous.host?.name === next.host?.name
  );
}

function toPluginSidebarThreadCached(
  entry: ThreadListEntry,
  hostNamesById: ReadonlyMap<string, string>,
  titleResources: ThreadTitleMentionResources,
  subtitle: string | null,
): PluginSidebarThread {
  const cached = pluginSidebarThreadByEntry.get(entry);

  if (
    cached !== undefined &&
    cached.hostNamesById === hostNamesById &&
    cached.titleResources === titleResources &&
    cached.subtitle === subtitle
  ) {
    return cached.thread;
  }

  const next = {
    ...toPluginSidebarThread(entry, hostNamesById, titleResources),
    experimental_subtitle: subtitle,
  };

  const thread =
    cached !== undefined && hasSameLookupFields(cached.thread, next)
      ? cached.thread
      : next;

  pluginSidebarThreadByEntry.set(entry, {
    hostNamesById,
    titleResources,
    subtitle,
    thread,
  });

  return thread;
}

type SidebarProjection = Pick<
  PluginSidebarThreadsState,
  "threads" | "projects" | "sections" | "experimental_groups"
>;

type PagedThreads = ReturnType<typeof useArchivedThreads>["data"];

type PagedLifecycleState = PluginSidebarThreadsState["experimental_archived"];

interface SidebarSources {
  requested: Readonly<Record<ThreadLifecycle, boolean>>;
  archived: PagedThreads;
  shelved: PagedThreads;
}

interface CachedSidebarProjection {
  archived: PagedThreads;
  shelved: PagedThreads;
  hostNamesById: ReadonlyMap<string, string>;
  titleResources: ThreadTitleMentionResources;
  subtitles: ReadonlyMap<string, string>;
  projection: SidebarProjection;
}

const sidebarProjectionsByPayload = new WeakMap<
  NonNullable<ReturnType<typeof useImmediateSidebarNavigation>["data"]>,
  Map<string, CachedSidebarProjection>
>();

function sidebarProjectionFor(
  data: NonNullable<ReturnType<typeof useImmediateSidebarNavigation>["data"]>,
  sources: SidebarSources,
  hostNamesById: ReadonlyMap<string, string>,
  titleResources: ThreadTitleMentionResources,
  subtitles: ReadonlyMap<string, string>,
): SidebarProjection {
  const { requested } = sources;

  const selectionKey = [
    requested.active,
    requested.archived,
    requested.shelved,
  ].join();

  let selections = sidebarProjectionsByPayload.get(data);
  const cached = selections?.get(selectionKey);

  if (
    cached !== undefined &&
    cached.archived === sources.archived &&
    cached.shelved === sources.shelved &&
    cached.hostNamesById === hostNamesById &&
    cached.titleResources === titleResources &&
    cached.subtitles === subtitles
  ) {
    return cached.projection;
  }

  const allProjects = [...data.projects, data.personalProject];
  const pooled = new Map<string, ThreadListEntry>();

  for (const thread of [
    ...(sources.archived?.pages.flat() ?? []),
    ...(sources.shelved?.pages.flat() ?? []),
    ...allProjects.flatMap((project) => project.threads),
  ]) {
    pooled.set(thread.id, thread);
  }

  const selected = [...pooled.values()].filter(
    (thread) => requested[getThreadLifecycle(thread)],
  );

  const projection: SidebarProjection = {
    threads: selected.map((thread) =>
      toPluginSidebarThreadCached(
        thread,
        hostNamesById,
        titleResources,
        subtitles.get(thread.id) ?? null,
      ),
    ),
    projects: allProjects.map((project) => ({
      id: project.id,
      name: project.name,
      isPersonal: project.id === PERSONAL_PROJECT_ID,
      href: getProjectComposeRoutePath(project.id),
      settingsHref: getSettingsProjectRoutePath(project.id),
    })),
    sections: data.sections,
    experimental_groups: data.groups,
  };

  if (selections === undefined) {
    selections = new Map();
    sidebarProjectionsByPayload.set(data, selections);
  }

  selections.set(selectionKey, {
    archived: sources.archived,
    shelved: sources.shelved,
    hostNamesById,
    titleResources,
    subtitles,
    projection,
  });

  return projection;
}

const EMPTY_PENDING_CHATS: readonly PendingChatSnapshot[] = [];

const threadsWithPending = new WeakMap<
  readonly PluginSidebarThread[],
  WeakMap<readonly PendingChatSnapshot[], readonly PluginSidebarThread[]>
>();

function withPendingThreads(
  threads: readonly PluginSidebarThread[],
  chats: readonly PendingChatSnapshot[],
): readonly PluginSidebarThread[] {
  if (chats.length === 0) return threads;
  let byPending = threadsWithPending.get(threads);
  const cached = byPending?.get(chats);

  if (cached !== undefined) return cached;

  const pending: PluginSidebarThread[] = [];
  const parentById = new Map<string, string>();

  for (const chat of chats) {
    const row = toPendingSidebarThread(chat);
    const handoff = chat.handoff;

    if (handoff === null || chat.status === "failed") {
      if (row !== null) pending.push(row);
      continue;
    }

    const source = threads.find(
      (thread) =>
        thread.id === handoff.sourceThreadId &&
        !thread.isHidden &&
        !thread.isArchived,
    );

    const target =
      chat.realThreadId === null
        ? row
        : threads.find((thread) => thread.id === chat.realThreadId);

    if (source === undefined || target == null) {
      if (row !== null) pending.push(row);
      continue;
    }

    if (row !== null) {
      pending.push({
        ...row,
        title: source.title,
        titleFallback: source.titleFallback,
        displayTitle: source.displayTitle,
        sectionId: row.sectionId ?? source.sectionId,
        originKind: "handoff",
        sourceThreadId: source.id,
      });
    }

    if (source.parentThreadId === target.id) continue;

    for (const thread of threads) {
      if (thread.projectId !== source.projectId || thread.id === target.id)
        continue;

      if (
        thread.id === source.id ||
        thread.parentThreadId === source.id ||
        (chat.realThreadId === null &&
          thread.originKind === "handoff" &&
          thread.sourceThreadId === source.id &&
          !handoff.previousHandoffIds.has(thread.id))
      ) {
        parentById.set(thread.id, target.id);
      }
    }
  }

  const grouped =
    parentById.size === 0
      ? threads
      : threads.map((thread) => {
          const parentThreadId = parentById.get(thread.id);

          return parentThreadId === undefined ||
            parentThreadId === thread.parentThreadId
            ? thread
            : { ...thread, parentThreadId };
        });

  const merged = pending.length === 0 ? grouped : [...pending, ...grouped];

  if (byPending === undefined) {
    byPending = new WeakMap();
    threadsWithPending.set(threads, byPending);
  }

  byPending.set(chats, merged);

  return merged;
}

function usePagedLifecycleState(
  query: ReturnType<typeof useArchivedThreads>,
  requested: boolean,
): PagedLifecycleState {
  const fetchQueryPage = query.fetchNextPage;

  const fetchNextPage = useCallback(async () => {
    await fetchQueryPage();
  }, [fetchQueryPage]);

  return useMemo<PagedLifecycleState>(
    () =>
      requested
        ? {
            status:
              query.data !== undefined
                ? "ready"
                : query.isLoadingError
                  ? "error"
                  : "loading",
            hasNextPage: query.hasNextPage,
            isFetchingNextPage: query.isFetchingNextPage,
            isFetchNextPageError: query.isFetchNextPageError,
            fetchNextPage,
          }
        : null,
    [
      requested,
      query.data,
      query.isLoadingError,
      query.hasNextPage,
      query.isFetchingNextPage,
      query.isFetchNextPageError,
      fetchNextPage,
    ],
  );
}

function pagedLifecycleStatus(
  states: readonly PagedLifecycleState[],
): PluginSidebarThreadsState["status"] {
  const requested = states.filter((state) => state !== null);

  if (requested.some((state) => state.status === "error")) return "error";

  return requested.some((state) => state.status === "loading")
    ? "loading"
    : "ready";
}

export function useSidebarThreads(
  options?: Parameters<PluginSdkApp["experimental_useSidebarThreads"]>[0],
): PluginSidebarThreadsState {
  const subtitles = usePluginThreadRowSubtitles();
  const lifecycles = options?.experimental_lifecycles;
  const active = !lifecycles?.length || lifecycles.includes("active");
  const includeArchived = lifecycles?.includes("archived") ?? false;
  const includeShelved = lifecycles?.includes("shelved") ?? false;
  const archived = useArchivedThreads({}, { enabled: includeArchived });
  const shelved = useShelvedThreads({ enabled: includeShelved });
  const archiveState = usePagedLifecycleState(archived, includeArchived);
  const shelfState = usePagedLifecycleState(shelved, includeShelved);
  const query = useImmediateSidebarNavigation();
  const data = query.data;
  const { data: hosts } = useHosts();
  const hostNamesById = hostNamesFor(hosts);
  const titleResources = useThreadTitleMentionResources();
  const archivedData = includeArchived ? archived.data : undefined;
  const shelvedData = includeShelved ? shelved.data : undefined;
  const pendingChats = usePendingChats();
  const selectedPendingChats = active ? pendingChats : EMPTY_PENDING_CHATS;

  return useMemo<PluginSidebarThreadsState>(() => {
    if (data === undefined) {
      return {
        experimental_archived: archiveState,
        experimental_shelved: shelfState,
        status: query.isError ? "error" : "loading",
        threads: EMPTY_THREADS,
        experimental_hosts: hosts ?? [],
        projects: EMPTY_PROJECTS,
        sections: EMPTY_SECTIONS,
        experimental_groups: EMPTY_GROUPS,
      };
    }

    const projection = sidebarProjectionFor(
      data,
      {
        requested: {
          active,
          archived: includeArchived,
          shelved: includeShelved,
        },
        archived: archivedData,
        shelved: shelvedData,
      },
      hostNamesById,
      titleResources,
      subtitles,
    );

    return {
      experimental_archived: archiveState,
      experimental_shelved: shelfState,
      status: active
        ? "ready"
        : pagedLifecycleStatus([archiveState, shelfState]),
      threads: withPendingThreads(projection.threads, selectedPendingChats),
      experimental_hosts: hosts ?? [],
      projects: projection.projects,
      sections: projection.sections,
      experimental_groups: projection.experimental_groups ?? EMPTY_GROUPS,
    };
  }, [
    data,
    hostNamesById,
    hosts,
    query.isError,
    titleResources,
    subtitles,
    active,
    includeArchived,
    includeShelved,
    archivedData,
    shelvedData,
    archiveState,
    shelfState,
    selectedPendingChats,
  ]);
}

export function useSidebarThreadEntry(
  threadId: string,
): ThreadListEntry | null {
  return useSidebarThreadEntryById(threadId);
}

export function useSidebarThreadActions(): PluginSidebarThreadActions {
  const navigate = useRouteNavigate();
  const store = useStore();
  const isCompact = useIsCompactViewport();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const hostActions = useThreadActions();
  const entriesById = useSidebarThreadEntries();
  const { mutateAsync: pinThreadAsync } = usePinThread();
  const { mutateAsync: unpinThreadAsync } = useUnpinThread();
  const { mutateAsync: updateThreadAsync } = useUpdateThread();

  const requireEntry = useCallback(
    (threadId: string): ThreadListEntry => {
      const entry = entriesById.get(threadId);

      if (entry === undefined) {
        throw new Error(`Unknown thread: ${threadId}`);
      }

      return entry;
    },
    [entriesById],
  );

  return useMemo<PluginSidebarThreadActions>(
    () => ({
      open(threadId, options) {
        const pending = isPendingChatId(threadId)
          ? getPendingChatSnapshot(threadId)
          : null;

        if (pending !== null) {
          navigate(
            getThreadRoutePath({ projectId: pending.projectId, threadId }),
          );

          return;
        }

        const entry = entriesById.get(threadId);

        if (entry === undefined) return;
        const { projectId } = entry;

        if (options?.split) {
          store.set(getThreadConversationCollapsedAtom(threadId), false);
          openThreadInSplit({
            store,
            navigate,
            projectId,
            threadId,
            isCompact,
          });

          return;
        }

        store.set(getThreadConversationCollapsedAtom(threadId), false);
        navigate(getThreadRoutePath({ projectId, threadId }));
      },
      openNewThread(options) {
        const projectId = options?.projectId;

        if (projectId !== undefined) {
          setRootComposeProjectId(projectId);
        }

        const state = {
          placement: options?.experimental_placement ?? {
            sectionId: options?.sectionId ?? null,
            pinned: false,
          },
          ...(options?.focusPrompt ? { focusPrompt: true } : {}),
          ...(options?.sectionId !== undefined
            ? { sectionId: options.sectionId }
            : {}),
          ...(options?.environmentId !== undefined
            ? { reuseEnvironmentId: options.environmentId }
            : {}),
          ...(typeof options?.hostId === "string" &&
          options.hostId.trim().length > 0
            ? { newEnvironmentHostId: options.hostId.trim() }
            : {}),
        };

        navigate(
          getRootComposeRoutePath(),
          Object.keys(state).length > 0 ? { state } : undefined,
        );
      },
      async setPinned(threadId, pinned) {
        const entry = requireEntry(threadId);

        if ((entry.pinnedAt !== null) === pinned) return;

        if (pinned) {
          await pinThreadAsync({ id: threadId });
        } else {
          await unpinThreadAsync({ id: threadId });
        }
      },
      async setRead(threadId, read) {
        const entry = requireEntry(threadId);
        const isRead = (entry.lastReadAt ?? 0) >= entry.latestAttentionAt;

        if (isRead === read) return;
        hostActions.toggleRead(entry);
      },
      async rename(threadId, title) {
        await updateThreadAsync({ id: threadId, title });
      },
      archive(threadId) {
        hostActions.requestArchive(requireEntry(threadId));
      },
      experimental_archiveEnvironmentThreads(environmentId) {
        return hostActions.archiveEnvironmentThreads(environmentId);
      },
      requestDelete(threadId) {
        hostActions.requestDelete(requireEntry(threadId));
      },
    }),
    [
      entriesById,
      hostActions,
      isCompact,
      navigate,
      pinThreadAsync,
      requireEntry,
      setRootComposeProjectId,
      store,
      unpinThreadAsync,
      updateThreadAsync,
    ],
  );
}

const NO_DRAFT: PluginSidebarThreadDraftState = Object.freeze({
  hasUnsubmittedDraft: false,
});

const HAS_DRAFT: PluginSidebarThreadDraftState = Object.freeze({
  hasUnsubmittedDraft: true,
});

const EMPTY_DRAFT_IDS: ReadonlySet<string> = new Set();

export function useSidebarThreadDraft(
  threadId: string,
): PluginSidebarThreadDraftState {
  const entry = useSidebarThreadEntry(threadId);

  const hasDraft = usePromptDraftHasInput({
    kind: "thread",
    projectId: entry?.projectId ?? "",
    threadId,
  });

  return entry !== null && hasDraft ? HAS_DRAFT : NO_DRAFT;
}

export function useSidebarThreadDraftIds(): ReadonlySet<string> {
  const entries = useSidebarThreadEntries();
  const refs = useMemo(() => [...entries.values()], [entries]);
  const ids = usePromptDraftInputThreadIds(refs);

  return ids.size === 0 ? EMPTY_DRAFT_IDS : ids;
}

export function useSidebarThreadRowStatus(
  threadId: string,
): PluginSidebarThreadRowStatus | null {
  return usePluginThreadRowStatus(threadId);
}

export function useSidebarThreadRowStatuses(): ReadonlyMap<
  string,
  PluginSidebarThreadRowStatus
> {
  return usePluginThreadRowStatuses();
}

export function useSidebarThreadShortcut(
  threadId: string,
): PluginSidebarThreadShortcut | null {
  return useHostSidebarThreadShortcut(threadId) ?? null;
}

export function toPluginSidebarPullRequest(
  pullRequest: ThreadPullRequest,
): PluginSidebarPullRequest {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    attention: pullRequest.attention,
    experimental_autoMerge: pullRequest.autoMerge,
    experimental_inMergeQueue: pullRequest.inMergeQueue,
    experimental_checks: { state: pullRequest.checks.state },
    experimental_review: { state: pullRequest.review.state },
    experimental_mergeability: { state: pullRequest.mergeability.state },
  };
}

export function useSidebarThreadPullRequest(
  threadId: string,
): PluginSidebarThreadPullRequestState {
  const entry = useSidebarThreadEntry(threadId);
  const environmentId = entry?.environmentId ?? null;
  const query = useEnvironmentPullRequest(environmentId);
  const pullRequest = getEnvironmentPullRequestFromResponse(query.data);

  return useMemo<PluginSidebarThreadPullRequestState>(
    () => ({
      isLoading: environmentId !== null && query.isPending,
      pullRequest:
        pullRequest === null ? null : toPluginSidebarPullRequest(pullRequest),
    }),
    [environmentId, pullRequest, query.isPending],
  );
}

import { usePublishVisiblePanel } from "@/lib/visible-app-context";
import { blocksTurn } from "@/components/thread/pending-interactions/interaction-request";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { useSidebarThreadEntry } from "@/lib/plugin-sidebar-hooks";
import { useQueryClient } from "@tanstack/react-query";
import {
  hasPersistedThreadTimelineDisplay,
  hasThreadOpenDisplay,
} from "@/hooks/cache-owners/thread-open-cache-owner";
import { useLatestRef } from "@/hooks/useLatestRef";
import {
  focusThreadViewScope,
  keepThreadView,
  releaseThreadViewScope,
  resolveThreadViewIntent,
  showThreadView,
  THREAD_VIEW_INTENT_DELAY_MS,
  useKeptThreadViews,
  useStableThreadViewOrder,
} from "@/lib/kept-thread-views";
import {
  ThreadInitialLoad,
  useThreadInitialLoadPending,
} from "@/components/thread/ThreadInitialLoad";
import { getPanelTabHistoryKey } from "@/components/secondary-panel/recentlyClosedPanelTabs";
import type { ThreadTimelineAddToChatHandler } from "@/components/thread/timeline";
import { createCoreComposerActions } from "@/lib/plugin-composer-handle";
import {
  Activity,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { nanoid } from "nanoid";
import { useSystemProviderInfo } from "@/hooks/queries/system-queries";
import { useImmediateRouteNavigate } from "@/components/ui/app-route-anchor";
import { useAtom, useSetAtom } from "jotai";
import { useDesktopBrowserReveal } from "@/lib/use-desktop-browser-reveal";
import { atomWithStorage } from "jotai/utils";
import {
  isRunningThreadRuntimeDisplayStatus,
  type ThreadTimelineEditMessageHandler,
  type ThreadTimelineEditMessageTarget,
  type ThreadTimelineInlineMessageEditor,
  type ThreadTimelineForkMessageHandler,
  type ThreadTimelineLinkHandler,
  type ThreadTimelineLocalFileLink,
  type ThreadTimelineLocalFileLinkHandler,
  type TimelineTitleActionResolver,
  useThreadTimelineController,
} from "@/components/thread/timeline";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";
import {
  defaultAppSettings,
  resolveEnvironmentMergeBaseBranch,
  type ThreadListEntry,
  type ThreadWithRuntime,
} from "@omnyo/domain";
import type {
  PullRequestMergeMethod,
  TerminalSession,
  TimelineRow,
} from "@omnyo/server-contract";
import type { WorkspaceOpenTarget } from "@omnyo/host-daemon-contract";
import { appToast } from "@/components/ui/app-toast";
import { OmnyoHttpError } from "@/lib/sdk";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { ThreadSecondaryPanel as ThreadSecondaryPanelTab } from "@/lib/thread-secondary-panel";
import {
  PluginDetailPanelContext,
  usePluginDetailPanelState,
} from "@/components/plugin/plugin-detail-navigation";
import { useForkThreadFromMessage } from "@/hooks/useForkThreadFromMessage";
import { isThreadForkable } from "@omnyo/client-core";
import { useRequestEnvironmentAction } from "../../hooks/mutations/environment-mutations";
import {
  useMarkThreadRead,
  useUpdateThread,
} from "../../hooks/mutations/thread-state-mutations";
import {
  useCreateThreadQueuedMessage,
  useEditThreadMessage,
  useSendThreadMessage,
} from "../../hooks/mutations/thread-runtime-mutations";
import { useUpdateEnvironment } from "../../hooks/mutations/environment-mutations";
import {
  useEnvironment,
  getEnvironmentPullRequestFromResponse,
  useEnvironmentPullRequest,
  useEnvironmentWorkStatus,
} from "../../hooks/queries/environment-queries";
import {
  useChildThreadPendingAttention,
  type ChildThreadPendingAttentionSource,
} from "../../hooks/queries/child-thread-pending-interactions";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  useChildThreads,
  useProjectThreadSubset,
  useThread,
  useThreadDetailBootstrap,
  useThreadPluginBootstrap,
  useThreadPendingInteractions,
  useThreads,
  useThreadStorageLocation,
  type ProjectThreadSubsetFilters,
} from "../../hooks/queries/thread-queries";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { subscribeComposerFocusRequests } from "@/lib/composer-focus-requests";
import { ThreadGitActionDialog } from "@/components/dialogs/ThreadGitActionDialog";
import { PageShell } from "@/components/ui/page-shell.js";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";
import { RouteLoadingSkeleton } from "@/components/ui/route-loading-skeleton";
import { ThreadTimelineLoadingSkeleton } from "@/components/thread/timeline/ThreadTimelineLoadingSkeleton";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import type { PluginThreadActionsInlineItem } from "@omnyo/plugin-sdk";
import { ThreadActionsMenu } from "@/components/thread/ThreadActionsMenu";
import { toThreadActionTarget } from "@/lib/thread-actions/thread-action-target";
import { Button } from "@omnyo/shared-ui/button";
import { ThreadOwnerRecovery } from "@/components/thread/ThreadOwnerRecovery";
import { COARSE_POINTER_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PluginThreadHeaderActions } from "@/components/plugin/PluginThreadHeaderActions";
import { ThreadLineageControl } from "@/components/thread/ThreadLineageControl";
import {
  buildThreadHeaderMenuItems,
  THREAD_HEADER_ACTIONS_GROUP,
} from "./thread-header-menu-items";
import { ThreadWorkspaceOpenButton } from "@/components/thread/ThreadWorkspaceOpenButton";
import {
  formatEnvironmentDisplay,
  type EnvironmentDisplayHostContext,
} from "@omnyo/core-ui";
import { assertNever } from "@omnyo/thread-view";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useLocalOpenTargets } from "@/hooks/useLocalOpenTargets";
import { selectHosts, useHosts } from "@/hooks/queries/host-queries";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import { useThreadTerminals } from "@/hooks/queries/thread-terminal-queries";
import { usePanelBrowser } from "@/components/secondary-panel/usePanelBrowser";
import { usePanelPluginPanels } from "@/components/secondary-panel/usePanelPluginPanels";
import { usePanelFiles } from "@/components/secondary-panel/usePanelFiles";
import { usePanelTerminals } from "@/components/secondary-panel/usePanelTerminals";
import {
  findEnvironmentDisplayProvider,
  getEnvironmentWorkspaceSummaryDisplay,
  isHostAmbiguous,
} from "@/lib/environment-workspace-display";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import { formatWorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import {
  getAbsoluteDirname,
  isAbsoluteFilePathWithinRoot,
  resolveAbsoluteFilePath,
} from "@/lib/absolute-file-path";
import { getGitStatusDisplay } from "@/components/workspace/workspace-status";
import {
  selectWorkspaceChangedFilesSection,
  type WorkspaceChangedFileSelection,
} from "@/components/workspace/workspace-change-summary";
import { FloatingThreadGoal } from "@/components/promptbox/banner/ThreadGoalCard";
import {
  activeTurnStartedAt,
  type ComposerWorkingState,
} from "@/components/promptbox/ComposerWorkingTab";
import {
  ThreadCompanionHost,
  ThreadPaneTopOverlay,
} from "@/components/thread-companion/ThreadCompanions";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { hasThreadProvisioningFailure } from "@/lib/thread-provisioning-failure";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import { promptInputToDraft, type PromptDraftState } from "@omnyo/client-core";
import { createLocalStorageEnumStorage } from "@/lib/browser-storage";
import {
  getProjectComposeRoutePath,
  getThreadRoutePath,
  type ThreadRoutePathArgs,
} from "@/lib/route-paths";
import { useGitDiffPanel } from "@/components/secondary-panel/git-diff/useGitDiffPanel";
import {
  createGitDiffFixedTabDestination,
  GIT_DIFF_FIXED_TAB_REFERENCE,
} from "@/components/secondary-panel/git-diff/git-diff-fixed-tab-navigation";
import {
  createThreadInfoFixedTabDestination,
  THREAD_INFO_FIXED_TAB_REFERENCE,
} from "@/components/secondary-panel/thread-info-fixed-tab-navigation";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import {
  buildThreadGit,
  ThreadGitProvider,
  type ThreadGitContextValue,
  type ThreadMergeBaseConfig,
} from "./ThreadGitContext";
import { isPendingChatId } from "@/lib/pending-chat-creations";
import { PendingChatRoute } from "./PendingChatRoute";
import {
  ThreadDetailPromptArea,
  type ThreadDetailSentMessageEdit,
} from "./ThreadDetailPromptArea";
import {
  isThreadDisplayStatusBannerActive,
  type ThreadPromptParentThreadSection,
  type ThreadPromptChildThreadsSection,
} from "@/components/promptbox/banner/ThreadPromptContextBanner";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
  type ThreadSecondaryPanelFileOpenOptions,
} from "./useThreadSecondaryPanelVisibility";
import {
  ThreadTimelineSurface,
  type HostConnectionNotice,
} from "@/components/thread/timeline/ThreadTimelineSurface";
import { summarizeLiveActivity } from "@/components/thread/timeline/live-activity";
import {
  shouldLoadThreadStorageFileList,
  useThreadStorageViewer,
} from "@/components/secondary-panel/useThreadStorageViewer";
import {
  getThreadConversationCollapsedAtom,
  widenSecondaryPanelForPreviewAtom,
} from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import {
  LazyBrowserTabDeck,
  LazyHostFilePreviewTabContent,
  LazyNewTabPage,
  LazyThreadStorageFilePreviewTabContent,
  LazyAttachmentFilePreviewTabContent,
  LazyThreadTerminalPanel,
  LazyWorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import {
  SIDE_CHAT_PLUGIN_ID,
  SIDE_CHAT_PLUGIN_PANEL_ACTION_ID,
} from "@/lib/side-chat-plugin";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import {
  PluginPanelTabContent,
  usePluginPanelActions,
} from "@/components/plugin/PluginPanelActions";
import { createFileOpenerOriginalTab } from "@/components/plugin/file-opener-tabs";
import { PluginThreadPanelNavigationProvider } from "@/components/plugin/plugin-thread-panel-navigation";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import {
  AttachmentOpenerContext,
  type OpenAttachmentRequest,
} from "@/components/secondary-panel/AttachmentOpenerContext";
import { usePluginSlots } from "@/lib/plugin-slots";
import { getFileExtension } from "@/lib/plugin-slot-resolvers";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  getOmnyoDesktopInfo,
  isDesktopBrowserAvailable,
} from "@/lib/omnyo-desktop";
import { UrlOpenRoutingProvider } from "@/lib/url-open-routing";
import {
  AppNavigationHostProvider,
  type AppFixedTabOpenIntent,
} from "@/lib/app-navigation-host";
import { openAppFixedTabFromDestinations } from "@/lib/app-fixed-tab-navigation";
import { getFileBasename } from "@/lib/live-file-navigation";
import { getFilePreviewLineRangeStart } from "@omnyo/client-core";
import { getBrowserUrlHost } from "@/lib/browser-url";
import {
  useThreadStorageBrowser,
  type ThreadStoragePathSelectHandler,
} from "@/components/secondary-panel/useThreadStorageBrowser";
import {
  useThreadFileTabs,
  type FileSearchSelection,
} from "@/components/secondary-panel/useThreadFileTabs";
import { isSecondaryFileTab } from "@omnyo/client-core";
import { useThreadOpenFileSignal } from "@/components/secondary-panel/useThreadOpenFileSignal";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import type {
  SecondaryPanelFixedTab,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import { useEnvironmentMergeBase } from "@/components/secondary-panel/git-diff/useEnvironmentMergeBase";
import { useThreadGitActions } from "./useThreadGitActions";
import { useThreadReadTracking } from "@/hooks/useThreadReadTracking";
import { useThreadUnreadDividerState } from "./useThreadUnreadDividerState";
import {
  buildTerminalSyncedSecondaryFileTabs,
  syncTerminalTabsInFixedPanelState,
} from "@/components/secondary-panel/terminalPanelTabs";
import {
  buildOpenInEditorHandler,
  resolveEnvironmentOpenContext,
  resolveWorkspaceChangedFileOpenTarget,
  resolveThreadWorkspaceOpenPath,
} from "./threadWorkspaceOpenPath";
import {
  resolveThreadLocalFileLink,
  type ThreadLocalFileLinkResolution,
} from "@/lib/thread-local-file-links";
import {
  MarkdownLocalFileContextMenuContext,
  MarkdownLocalFileOpenTargetsContext,
  type MarkdownLinkRouting,
  type MarkdownLocalFileContextMenuItem,
  type MarkdownLocalFileLinkRouting,
} from "@/components/ui/markdown-link-routing";
import {
  useFixedPanelTabsStorageMaintenance,
  useReconciledFixedPanelTabsState,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import {
  createGitDiffFixedPanelTab,
  createThreadInfoFixedPanelTab,
  type SecondaryFileFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import { resolveGitDiffTabStatus } from "@/components/secondary-panel/gitDiffTabEligibility";
import { isRootThread } from "./threadParentSelectorOptions";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
  useToggleThreadSecondaryPanelSelection,
} from "./threadSecondaryPanelSelection";
import { useRouteState } from "@/hooks/useRouteState";
import { useAppCommandHandler } from "@/components/commands/AppCommandProvider";
import { useWindowRightPanel } from "@/components/layout/WindowRightPanelToggle";
import { usePaneContext } from "./PaneContext";
import { ThreadArchiveCommandHandler } from "./ThreadArchiveCommandHandler";
import { ThreadCopyLinkCommandHandler } from "./ThreadCopyLinkCommandHandler";
import { ThreadShelveCommandHandler } from "./ThreadShelveCommandHandler";

const EMPTY_PARENT_THREADS: readonly ThreadListEntry[] = [];

const EMPTY_CHILD_THREAD_ITEMS: readonly ChildThreadPendingAttentionSource[] =
  [];

const EMPTY_PROJECT_THREAD_SUBSET_FILTERS =
  {} satisfies ProjectThreadSubsetFilters;

const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];

const DEFAULT_PULL_REQUEST_MERGE_METHOD: PullRequestMergeMethod = "merge";

const PULL_REQUEST_MERGE_METHOD_STORAGE_KEY = "omnyo.pullRequest.mergeMethod";

function isPullRequestMergeMethod(
  value: string,
): value is PullRequestMergeMethod {
  return value === "merge" || value === "squash" || value === "rebase";
}

const pullRequestMergeMethodAtom = atomWithStorage<PullRequestMergeMethod>(
  PULL_REQUEST_MERGE_METHOD_STORAGE_KEY,
  DEFAULT_PULL_REQUEST_MERGE_METHOD,
  createLocalStorageEnumStorage<PullRequestMergeMethod>(
    isPullRequestMergeMethod,
  ),
  { getOnInit: true },
);

type MergeBasePickerOpenChangeHandler = NonNullable<
  ThreadMergeBaseConfig["onPickerOpenChange"]
>;

type SecondaryPanelChangeHandler = (panel: ThreadSecondaryPanelTab) => void;

type OpenInEditorHandler = NonNullable<
  ReturnType<typeof buildOpenInEditorHandler>
>;

type OpenFilePreviewHandler = (relativePath: string) => void;

interface SentMessageEditSession {
  draft: PromptDraftState;
  operationId: string;
  target: ThreadTimelineEditMessageTarget;
  threadId: string;
}

function hasTimelineRowId(
  rows: readonly TimelineRow[],
  rowId: string,
): boolean {
  return rows.some(
    (row) =>
      row.id === rowId ||
      (row.kind === "turn" &&
        row.children !== null &&
        hasTimelineRowId(row.children, rowId)),
  );
}

function getPullRequestMergeLoadingTitle(
  method: PullRequestMergeMethod,
): string {
  switch (method) {
    case "merge":
      return "Merging pull request";
    case "squash":
      return "Squash merging pull request";
    case "rebase":
      return "Rebase merging pull request";
  }
}

interface ThreadDetailViewPageProps {
  surface: "page";
}

interface ThreadDetailViewPaneProps extends ThreadRoutePathArgs {
  surface: "pane";
  timelineEnabled: boolean;
}

type ThreadDetailViewProps =
  | ThreadDetailViewPageProps
  | ThreadDetailViewPaneProps;

interface BuildMarkdownPreviewLinkRoutingArgs {
  baseDir: string | undefined;
  onOpenLink: ThreadTimelineLinkHandler;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler;
  rootPath: string | null | undefined;
}

interface ResolveHostFilePreviewLinkRootPathArgs {
  baseDir: string | undefined;
  threadStorageRootPath: string | null;
  workspaceRootPath: string | null;
}

function buildHostConnectionNotice(
  thread: ThreadWithRuntime,
  hostName: string | null,
): HostConnectionNotice | null {
  if (thread.runtime.displayStatus !== "waiting-for-host") {
    return null;
  }

  return { label: `${hostName ?? "Host"} disconnected` };
}

function buildMarkdownPreviewLinkRouting({
  baseDir,
  onOpenLink,
  onOpenLocalFileLink,
  rootPath,
}: BuildMarkdownPreviewLinkRoutingArgs): MarkdownLinkRouting {
  if (rootPath === null || rootPath === undefined) {
    return {
      onOpenLink,
    };
  }

  const localFileRouting: MarkdownLocalFileLinkRouting = {
    absoluteLinks: {
      kind: "contained",
      rootPath,
    },
    onOpenLink: onOpenLocalFileLink,
  };

  if (baseDir !== undefined) {
    localFileRouting.relativeLinks = {
      baseDir,
      rootPath,
    };
  }

  return {
    localFile: localFileRouting,
    onOpenLink,
  };
}

function buildOpenTargetMenuItemLabel(target: WorkspaceOpenTarget): string {
  return `Open in ${target.label}`;
}

function resolveHostFilePreviewLinkRootPath({
  baseDir,
  threadStorageRootPath,
  workspaceRootPath,
}: ResolveHostFilePreviewLinkRootPathArgs): string | null {
  if (baseDir === undefined) {
    return null;
  }

  if (
    workspaceRootPath !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: baseDir,
      rootPath: workspaceRootPath,
    })
  ) {
    return workspaceRootPath;
  }

  if (
    threadStorageRootPath !== null &&
    isAbsoluteFilePathWithinRoot({
      candidatePath: baseDir,
      rootPath: threadStorageRootPath,
    })
  ) {
    return threadStorageRootPath;
  }

  return null;
}

function ThreadDetailNotFound() {
  return (
    <PageShell contentClassName="min-h-full items-center justify-center">
      <p className="py-12 text-center text-sm text-destructive">Not found</p>
    </PageShell>
  );
}

function useThreadViewIntent(currentThreadId: string, isFocused: boolean) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!isFocused) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingThreadId: string | null = null;
    let preparedThreadId: string | null = null;

    const handleIntent = (event: PointerEvent | FocusEvent) => {
      if (
        ("pointerType" in event &&
          (event.pointerType === "touch" ||
            (event.type === "pointerdown" &&
              (!event.isPrimary || event.button !== 0)))) ||
        !(event.target instanceof Element)
      )
        return;

      const threadId =
        event.target
          .closest<HTMLElement>("[data-sidebar-thread-id]")
          ?.getAttribute("data-sidebar-thread-id") ?? null;

      const immediate = event.type !== "pointerover";

      if (threadId === pendingThreadId) {
        if (!immediate || preparedThreadId === threadId) return;
      } else {
        pendingThreadId = threadId;
        preparedThreadId = null;
      }

      if (timer !== null) clearTimeout(timer);
      timer = null;

      if (threadId === null || threadId === currentThreadId) return;

      const prepare = () => {
        timer = null;

        const view = resolveThreadViewIntent(queryClient, threadId);

        if (view !== null) {
          preparedThreadId = threadId;
          keepThreadView(view);
        }
      };

      if (immediate) prepare();
      else timer = setTimeout(prepare, THREAD_VIEW_INTENT_DELAY_MS);
    };

    document.addEventListener("pointerover", handleIntent, {
      passive: true,
    });

    document.addEventListener("focusin", handleIntent);
    document.addEventListener("pointerdown", handleIntent, {
      passive: true,
    });

    return () => {
      document.removeEventListener("pointerover", handleIntent);
      document.removeEventListener("focusin", handleIntent);
      document.removeEventListener("pointerdown", handleIntent);

      if (timer !== null) clearTimeout(timer);
    };
  }, [currentThreadId, isFocused, queryClient]);
}

const KeptThreadDetailView = memo(function KeptThreadDetailView(
  props: ThreadRoutePathArgs & { timelineEnabled: boolean },
) {
  return <LoadingThreadDetailView {...props} />;
});

function KeptThreadDetailViews({
  projectId,
  threadId,
  timelineEnabled,
}: ThreadRoutePathArgs & { timelineEnabled: boolean }) {
  const { paneId, isFocused } = usePaneContext();

  const current = useMemo(
    () => ({ projectId, threadId }),
    [projectId, threadId],
  );

  const kept = useKeptThreadViews(paneId, current);
  const views = useStableThreadViewOrder(kept);

  useThreadViewIntent(threadId, isFocused);
  useEffect(() => {
    showThreadView(paneId, current);
  }, [current, paneId]);
  useEffect(() => {
    if (isFocused) focusThreadViewScope(paneId);
  }, [isFocused, paneId]);
  useEffect(() => () => releaseThreadViewScope(paneId), [paneId]);

  return views.map((view) => (
    <Activity
      key={view.threadId}
      mode={view.threadId === threadId ? "visible" : "hidden"}
    >
      <KeptThreadDetailView
        projectId={view.projectId}
        threadId={view.threadId}
        timelineEnabled={timelineEnabled}
      />
    </Activity>
  ));
}

function RoutedThreadDetailView() {
  const { projectId, threadId } = useRouteState();

  if (!projectId || !threadId) {
    return <ThreadDetailNotFound />;
  }

  if (isPendingChatId(threadId))
    return <PendingChatRoute projectId={projectId} threadId={threadId} />;

  return (
    <KeptThreadDetailViews
      projectId={projectId}
      threadId={threadId}
      timelineEnabled
    />
  );
}

export function ThreadDetailView(props: ThreadDetailViewProps) {
  if (props.surface === "pane") {
    if (isPendingChatId(props.threadId))
      return (
        <PendingChatRoute
          projectId={props.projectId}
          threadId={props.threadId}
        />
      );

    return (
      <KeptThreadDetailViews
        projectId={props.projectId}
        threadId={props.threadId}
        timelineEnabled={props.timelineEnabled}
      />
    );
  }

  return <RoutedThreadDetailView />;
}

function LoadingThreadDetailView(
  props: ThreadRoutePathArgs & { timelineEnabled: boolean },
) {
  const { isBoundedPane } = usePaneContext();
  const queryClient = useQueryClient();

  return (
    <ThreadInitialLoad
      key={props.threadId}
      threadId={props.threadId}
      initiallyReady={
        hasThreadOpenDisplay(queryClient, props.projectId, props.threadId) ||
        (props.timelineEnabled &&
          hasPersistedThreadTimelineDisplay(props.threadId))
      }
      fallback={
        <RouteLoadingSkeleton isBoundedPane={isBoundedPane}>
          <ThreadTimelineLoadingSkeleton />
        </RouteLoadingSkeleton>
      }
    >
      <ThreadDetailViewInternal {...props} />
    </ThreadInitialLoad>
  );
}

function ThreadDetailViewInternal(
  props: ThreadRoutePathArgs & { timelineEnabled: boolean },
) {
  const { projectId, threadId, timelineEnabled } = props;

  const {
    isFocused,
    isMaximized: isPaneMaximized,
    navigateInPane,
    onRequestClose,
    isBoundedPane,
  } = usePaneContext();

  const navigate = useImmediateRouteNavigate();
  useFixedPanelTabsStorageMaintenance();
  const systemConfigQuery = useSystemConfig();
  const pluginFrontendsSettled = usePluginFrontendsSettled();
  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId);
  useThreadPluginBootstrap(threadId);

  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;

  const {
    data: thread,
    isFetching,
    isLoading: threadIsLoading,
    isLoadingError,
    isPlaceholderData,
    error,
  } = useThread(threadId, {
    enabled: hasThreadDetailBootstrapSettled,
    refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(
      threadDetailBootstrapQuery,
    )
      ? false
      : "always",
  });

  const confirmedThreadNotFound =
    (threadDetailBootstrapQuery.error instanceof OmnyoHttpError &&
      threadDetailBootstrapQuery.error.status === 404) ||
    (error instanceof OmnyoHttpError && error.status === 404);

  const environmentQuery = useEnvironment(thread?.environmentId, {
    enabled: Boolean(thread?.environmentId),
    staleTime: 5_000,
  });

  const environment = environmentQuery.data;

  const hostLifecycle =
    environment === undefined || environment.hostLifecycle === "active"
      ? null
      : environment.hostLifecycle;

  const executionUnavailable =
    hostLifecycle !== null || environment?.status === "destroyed";

  const gitDiffTabStatus = resolveGitDiffTabStatus({
    environmentId: thread?.environmentId ?? null,
    environmentIsGitRepo: environment?.isGitRepo,
    environmentLoadFailed: environmentQuery.isError,
    environmentOwnsPath: environment?.managed,
    hasResolvedThread: thread !== undefined,
    threadArchived: thread?.archivedAt != null || executionUnavailable,
  });

  const threadFixedViewTabs = useMemo(
    () => [
      createThreadInfoFixedPanelTab(),
      ...(gitDiffTabStatus === "ineligible"
        ? []
        : [createGitDiffFixedPanelTab()]),
    ],
    [gitDiffTabStatus],
  );

  const fixedPanelTabsState = useReconciledFixedPanelTabsState({
    fixedTabs: threadFixedViewTabs,
    isAuthoritative:
      gitDiffTabStatus === "eligible" || gitDiffTabStatus === "ineligible",
    panelStateId: threadId,
    syncThreadId: threadId,
  });

  const isPersistedSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;

  const activeFixedSecondaryTab = getActiveFixedSecondaryTab({
    fixedPanelTabsState,
  });

  const openFixedSecondaryTab = isPersistedSecondaryPanelOpen
    ? activeFixedSecondaryTab
    : null;

  const activeFixedSecondaryTabId = activeFixedSecondaryTab?.id ?? null;
  const renderSecondaryPanelAsDrawer = useIsCompactViewport();

  const secondaryPanelDrawerVisibility =
    useThreadSecondaryPanelDrawerVisibility({
      isCompactViewport: renderSecondaryPanelAsDrawer,
      threadId,
    });

  const pluginDetails = usePluginDetailPanelState(
    threadId,
    isFocused,
    getPanelTabHistoryKey({
      environmentId: thread?.environmentId,
      fileOwnerThreadId: threadId ?? null,
      panelStateId: threadId ?? null,
    }),
  );

  const isWorkspacePanelOpen = renderSecondaryPanelAsDrawer
    ? secondaryPanelDrawerVisibility.isDrawerVisible
    : isPersistedSecondaryPanelOpen;

  const isSecondaryPanelOpen =
    isWorkspacePanelOpen || pluginDetails.activePluginId !== null;

  usePublishVisiblePanel({
    tab:
      pluginDetails.activePluginId === null
        ? activeFixedSecondaryTab
        : {
            kind: "marketplace-plugin-detail",
            id: pluginDetails.activePluginId,
          },
    isOpen: isSecondaryPanelOpen,
    isFocused,
  });

  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    threadId,
    threadId,
  );

  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    threadId,
    threadId,
  );

  const setThreadSecondaryPanel = useSetThreadSecondaryPanelSelection(
    threadId,
    threadId,
  );

  const toggleDefaultPersistedSecondaryPanel =
    useToggleThreadSecondaryPanelSelection(threadId, threadId);

  const threadQueryState = useConnectionAwareQueryState({
    hasResolvedData: thread !== undefined,
    isFetching: threadDetailBootstrapQuery.isFetching || isFetching,
    isLoadingError,
    isRecoverableLoadingError: isTransientReadError(error),
  });

  const threadOriginKind = thread?.originKind ?? null;

  const threadSourceThreadId =
    thread?.sourceThreadId ??
    (thread && threadOriginKind ? thread.parentThreadId : null);

  const ownerThreadId =
    thread?.parentThreadId ?? thread?.lifecycleOwnerThreadId;

  const ownerThreadQuery = useThread(ownerThreadId ?? "");
  const ownerThread = ownerThreadQuery.data;
  const parentThread = thread?.parentThreadId ? ownerThread : undefined;
  const { data: sourceThread } = useThread(threadSourceThreadId ?? "");

  const pendingInteractionsQuery = useThreadPendingInteractions(
    thread?.id ?? "",
    {
      enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    },
  );

  const pendingInteractions = pendingInteractionsQuery.data ?? [];
  const hasPendingInteraction = pendingInteractions.some(blocksTurn);

  const unreadDividerState = useThreadUnreadDividerState({
    routeThreadId: threadId,
    thread,
  });

  const [hasRequestedMergeBaseOptions, setHasRequestedMergeBaseOptions] =
    useState(false);

  const [shouldAutoFocusNewTab, setShouldAutoFocusNewTab] = useState(false);

  const handleNewTabAutoFocusHandled = useCallback(
    () => setShouldAutoFocusNewTab(false),
    [],
  );

  const shouldLoadThreadStorageFiles = shouldLoadThreadStorageFileList({
    hasThread: thread !== undefined,
    isSecondaryPanelOpen,
    secondaryTabs: fixedPanelTabsState.secondary.tabs,
  });

  const { threadStorageFiles, threadStorageFilesError } =
    useThreadStorageViewer({
      fileListEnabled: shouldLoadThreadStorageFiles,
      threadId,
    });

  const threadStorageLocationQuery = useThreadStorageLocation(threadId, {
    enabled: Boolean(thread?.environmentId),
  });

  const threadStorageRootPath =
    threadStorageLocationQuery.data?.storageRootPath ?? null;

  const terminalsListQuery = useThreadTerminals(threadId, {
    enabled: isSecondaryPanelOpen,
  });

  const {
    activeBrowserTab,
    activeHostFileLineRange,
    activeHostFilePath,
    activeStorageFilePath,
    activeWorkspaceFilePath,
    browserTabs,
    clearActiveFileTabs,
    activateTab,
    closeTab,
    openTab,
    openPluginPanel,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId: threadId,
    syncThreadId: threadId,
    environmentId: thread?.environmentId,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
    storageFiles: threadStorageFiles,
    terminalSessions: terminalsListQuery.data?.sessions,
  });

  const panelBrowser = usePanelBrowser({
    available: isDesktopBrowserAvailable(),
    browserTabs,
    isFocused,
    openTab,
    reveal: secondaryPanelDrawerVisibility.openDrawer,
  });

  const openBrowser = panelBrowser.open;
  const openBrowserUrl = panelBrowser.openUrl;

  const pluginPanelActions = usePluginPanelActions({
    openPluginPanel,
    threadId,
  });

  const {
    fileOpeners: pluginFileOpeners,
    threadPanelActions: pluginThreadPanelActions,
  } = usePluginSlots();

  useThreadOpenFileSignal({
    threadId,
    environmentId: thread?.environmentId,
    openTab,
  });
  const browserDeckThreadId = thread?.id ?? null;
  const browserDeckEnvironmentId = thread?.environmentId ?? null;

  const renderBrowserDeck = useCallback(
    ({
      canHandleBrowserCommands,
      canShowNativeBrowserView,
      onNativeFocus,
      activeBrowserTabId = activeBrowserTab?.id ?? null,
    }: {
      canHandleBrowserCommands?: boolean;
      canShowNativeBrowserView: boolean;
      onNativeFocus?: () => void;
      activeBrowserTabId?: string | null;
    }) => {
      if (browserDeckThreadId === null) {
        return null;
      }

      return (
        <LazyBrowserTabDeck
          browserTabs={browserTabs}
          activeBrowserTabId={activeBrowserTabId}
          addressFocusRequest={panelBrowser.addressFocusRequest}
          onAddressFocusRequestConsumed={
            panelBrowser.handleAddressFocusRequestConsumed
          }
          environmentId={browserDeckEnvironmentId}
          canShowNativeBrowserView={canShowNativeBrowserView}
          canHandleBrowserCommands={canHandleBrowserCommands}
          onNativeFocus={onNativeFocus}
          threadId={browserDeckThreadId}
          onUpdate={updateBrowserTab}
        />
      );
    },
    [
      activeBrowserTab?.id,
      panelBrowser.addressFocusRequest,
      browserTabs,
      browserDeckEnvironmentId,
      browserDeckThreadId,
      panelBrowser.handleAddressFocusRequestConsumed,
      updateBrowserTab,
    ],
  );

  const panelFiles = usePanelFiles({
    available: true,
    openTab,
    reveal: secondaryPanelDrawerVisibility.openDrawer,
    scope: {
      threadId: thread?.id ?? null,
      environmentId: thread?.environmentId ?? null,
      hostId: environment?.hostId ?? null,
    },
  });

  const openLiveFilePreview = panelFiles.openFilePreview;

  const openNewTab = useCallback(() => {
    openTab({ kind: "new-tab" });
  }, [openTab]);

  const isThreadRoot = isRootThread(thread);

  const [
    parentThreadsRequestedForThreadId,
    setParentThreadsRequestedForThreadId,
  ] = useState<string | null>(null);

  const shouldLoadParentThreads =
    threadQueryState.status === "ready" &&
    isThreadRoot &&
    parentThreadsRequestedForThreadId === thread?.id;

  const parentThreadSubsetQuery = useProjectThreadSubset({
    enabled: shouldLoadParentThreads,
    filters: EMPTY_PROJECT_THREAD_SUBSET_FILTERS,
    projectId,
  });

  const childThreadSubsetQuery = useChildThreads({
    enabled: threadQueryState.status === "ready" && Boolean(thread?.id),
    parentThreadId: thread?.id,
  });

  const handoffThreadsQuery = useThreads(
    {
      archived: false,
      originKind: "handoff",
      ...(thread
        ? { projectId: thread.projectId, sourceThreadId: thread.id }
        : {}),
    },
    { enabled: threadQueryState.status === "ready" },
  );

  const parentThreads = useMemo(
    () =>
      shouldLoadParentThreads
        ? (parentThreadSubsetQuery.data ?? EMPTY_PARENT_THREADS)
        : EMPTY_PARENT_THREADS,
    [parentThreadSubsetQuery.data, shouldLoadParentThreads],
  );

  const handleParentSelectorOpenChange = useCallback(
    (open: boolean) => {
      if (open && thread?.id) {
        setParentThreadsRequestedForThreadId(thread.id);
      }
    },
    [thread?.id],
  );

  const handleRetryParentThreads = parentThreadSubsetQuery.retry;

  const {
    activePromptMode,
    activeThinking,
    activeWorkflows,
    activeBackgroundCommands,
    contextBoundarySeq,
    contextWindowUsage,
    goal,
    providerCommands,
    sessionOptions,
    hasPagedHistory,
    hasOlderTimelineRows,
    isCatchingUpTimeline,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    modelFallback,
    pendingTodos,
    timelineError,
    timelineLoading,
    isReadOnlyDisplay,
    timelineRows,
    threadNotFound,
  } = useThreadTimelineController({
    threadId,
    enabled: timelineEnabled,
    notFound: confirmedThreadNotFound,
  });

  const completionWork = useSidebarThreadEntry(threadId)?.work ?? undefined;

  const completion =
    !isReadOnlyDisplay &&
    !isRunningThreadRuntimeDisplayStatus(
      thread?.runtime.displayStatus ?? "idle",
    )
      ? completionWork
      : undefined;

  const sendMessage = useSendThreadMessage();
  const editMessage = useEditThreadMessage();
  const createQueuedMessage = useCreateThreadQueuedMessage();
  const requestEnvironmentAction = useRequestEnvironmentAction();

  const [pullRequestMergeMethod, setPullRequestMergeMethod] = useAtom(
    pullRequestMergeMethodAtom,
  );

  const markThreadRead = useMarkThreadRead();
  const updateEnvironment = useUpdateEnvironment();

  const updateThread = useUpdateThread({
    errorMessage: "Failed to assign parent thread.",
  });

  const loadedTerminalSessions = terminalsListQuery.data?.sessions;
  const terminalSessions = loadedTerminalSessions ?? EMPTY_TERMINAL_SESSIONS;

  const terminalsById = useMemo(
    () => new Map(terminalSessions.map((session) => [session.id, session])),
    [terminalSessions],
  );

  const syncedOrderedSecondaryFileTabs = useMemo(
    () =>
      loadedTerminalSessions === undefined
        ? orderedSecondaryFileTabs
        : buildTerminalSyncedSecondaryFileTabs({
            orderedTabs: orderedSecondaryFileTabs,
            terminalSessions: loadedTerminalSessions,
          }),
    [loadedTerminalSessions, orderedSecondaryFileTabs],
  );

  useEffect(() => {
    if (terminalsListQuery.data === undefined) {
      return;
    }

    updateFixedPanelTabsState((state) =>
      syncTerminalTabsInFixedPanelState({
        state,
        terminalSessions,
      }),
    );
  }, [terminalSessions, terminalsListQuery.data, updateFixedPanelTabsState]);

  const hostsQuery = useHosts({
    enabled:
      thread?.environmentId !== null && thread?.environmentId !== undefined,
  });

  const connectedHostIds = useMemo(
    () =>
      new Set(
        (hostsQuery.data ?? [])
          .filter((host) => host.status === "connected")
          .map((host) => host.id),
      ),
    [hostsQuery.data],
  );

  const resolvedThreadEnvironmentHost = useMemo(() => {
    const hosts = hostsQuery.data ?? [];
    const environmentHostId = environment?.hostId;

    if (!environmentHostId) return null;

    return hosts.find((host) => host.id === environmentHostId) ?? null;
  }, [environment?.hostId, hostsQuery.data]);

  const hasMultipleMachines =
    selectHosts(hostsQuery.data, "persistent").length > 1;

  const threadEnvironmentHost = isHostAmbiguous(
    hasMultipleMachines,
    resolvedThreadEnvironmentHost?.type ?? null,
  )
    ? resolvedThreadEnvironmentHost
    : null;

  const hostConnectionNotice = useMemo(
    () =>
      thread
        ? buildHostConnectionNotice(thread, threadEnvironmentHost?.name ?? null)
        : null,
    [thread, threadEnvironmentHost],
  );

  const forkThreadFromMessage = useForkThreadFromMessage({
    navigateInPane,
    sourceThread: thread ?? null,
  });

  const handleForkMessage = useCallback<ThreadTimelineForkMessageHandler>(
    (target) => {
      void forkThreadFromMessage(target);
    },
    [forkThreadFromMessage],
  );

  const threadProviderInfo = useSystemProviderInfo(
    thread?.environmentId
      ? {
          enabled: true,
          environmentId: thread.environmentId,
          providerId: thread.providerId,
        }
      : {
          enabled: thread !== undefined,
          providerId: thread?.providerId,
        },
  );

  const threadProviderPluginId = threadProviderInfo?.pluginId ?? null;

  const threadProviderContextValue = useMemo(
    () => ({
      providerId: thread?.providerId ?? null,
      pluginId: threadProviderPluginId,
    }),
    [thread?.providerId, threadProviderPluginId],
  );

  const isForkAvailable = isThreadForkable(
    thread ?? null,
    threadProviderInfo?.capabilities.supportsFork ?? false,
  );

  const dismissCompactKeyboard = useCallback(() => {
    if (!renderSecondaryPanelAsDrawer) {
      return;
    }

    const activeElement = document.activeElement;

    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
  }, [renderSecondaryPanelAsDrawer]);

  const selectionPromptDraftProjectId = thread?.projectId ?? projectId;
  const selectionPromptDraftThreadId = thread?.id ?? "";

  const selectionPromptDraft = useMemo(
    () =>
      getPromptDraftAccessor({
        kind: "thread",
        projectId: selectionPromptDraftProjectId,
        threadId: selectionPromptDraftThreadId,
      }),
    [selectionPromptDraftProjectId, selectionPromptDraftThreadId],
  );

  const [composerFocusRequestNonce, setComposerFocusRequestNonce] = useState(0);

  const [sentMessageEditSession, setSentMessageEditSession] =
    useState<SentMessageEditSession | null>(null);

  const [sentMessageEditHostElement, setSentMessageEditHostElement] =
    useState<HTMLDivElement | null>(null);

  const activeSentMessageEditSession =
    sentMessageEditSession?.threadId === thread?.id
      ? sentMessageEditSession
      : null;

  const canEditSentMessages =
    thread !== undefined &&
    (threadProviderInfo?.capabilities.supportsSessionRewind ?? false) &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    !hasPendingInteraction &&
    sentMessageEditSession === null &&
    !sendMessage.isPending &&
    !createQueuedMessage.isPending &&
    !editMessage.isPending &&
    !(timelineLoading && timelineRows.length === 0) &&
    activeWorkflows.length === 0 &&
    thread.activeBackgroundAgentCount === 0 &&
    activeBackgroundCommands.length === 0;

  const sentMessageEditEntryRef = useRef({ canEditSentMessages, thread });
  sentMessageEditEntryRef.current = { canEditSentMessages, thread };

  const handleEditSentMessage = useCallback<ThreadTimelineEditMessageHandler>(
    (target: ThreadTimelineEditMessageTarget) => {
      const current = sentMessageEditEntryRef.current;

      if (!current.thread || !current.canEditSentMessages) {
        return;
      }

      const editDraft = promptInputToDraft(target.input);
      setSentMessageEditHostElement(null);
      setSentMessageEditSession({
        draft: editDraft,
        operationId: nanoid(),
        target,
        threadId: current.thread.id,
      });
    },
    [],
  );

  const sentMessageEditThreadId = sentMessageEditSession?.threadId ?? null;

  const sentMessageEditTargetMessageId =
    sentMessageEditSession?.target.messageId ?? null;

  const currentThreadId = thread?.id ?? null;

  const sentMessageEditTargetStillPresent =
    sentMessageEditThreadId === currentThreadId &&
    sentMessageEditTargetMessageId !== null
      ? hasTimelineRowId(timelineRows, sentMessageEditTargetMessageId)
      : true;

  const shouldDiscardMissingSentMessageEdit =
    sentMessageEditThreadId !== null &&
    sentMessageEditThreadId === currentThreadId &&
    !timelineLoading &&
    !sentMessageEditTargetStillPresent;

  useEffect(() => {
    if (!shouldDiscardMissingSentMessageEdit) {
      return;
    }

    setSentMessageEditHostElement(null);
    setSentMessageEditSession(null);
    appToast.warning("The message being edited is no longer available.");
  }, [shouldDiscardMissingSentMessageEdit]);

  const activeSentMessageEditOperationId =
    activeSentMessageEditSession?.operationId ?? null;

  const updateSentMessageEditDraft = useCallback(
    (update: (current: PromptDraftState) => PromptDraftState) => {
      setSentMessageEditSession((current) =>
        current?.operationId === activeSentMessageEditOperationId
          ? { ...current, draft: update(current.draft) }
          : current,
      );
    },
    [activeSentMessageEditOperationId],
  );

  const closeSentMessageEdit = useCallback((operationId: string) => {
    setSentMessageEditSession((current) =>
      current?.operationId === operationId ? null : current,
    );
  }, []);

  const cancelSentMessageEdit = useCallback(() => {
    if (!activeSentMessageEditSession) {
      return;
    }

    closeSentMessageEdit(activeSentMessageEditSession.operationId);
  }, [activeSentMessageEditSession, closeSentMessageEdit]);

  const submitSentMessageEdit = useCallback<
    ThreadDetailSentMessageEdit["onSubmit"]
  >(
    (target) => {
      if (!activeSentMessageEditSession) {
        return;
      }

      const session = activeSentMessageEditSession;
      const execution = target.execution;
      closeSentMessageEdit(session.operationId);
      void editMessage
        .mutateAsync({
          id: session.threadId,
          messageId: session.target.messageId,
          operationId: session.operationId,
          expectedRequestSequence: session.target.expectedRequestSequence,
          input: target.input,
          ...(execution
            ? {
                model: execution.model,
                permissionMode: execution.permissionMode,
                reasoningLevel: execution.reasoningLevel,
                executionInputSources: execution.executionInputSources,
                ...(execution.supportsServiceTier && execution.serviceTier
                  ? { serviceTier: execution.serviceTier }
                  : {}),
              }
            : {}),
        })
        .catch((error) => {
          setSentMessageEditSession((current) => current ?? session);
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to edit the message",
            lifecycleOperation: "edit_message",
          });
        });
    },
    [activeSentMessageEditSession, closeSentMessageEdit, editMessage],
  );

  const activeSentMessageEditTargetMessageId =
    activeSentMessageEditSession?.target.messageId ?? null;

  const inlineMessageEditor = useMemo<
    ThreadTimelineInlineMessageEditor | undefined
  >(
    () =>
      activeSentMessageEditTargetMessageId !== null
        ? {
            messageId: activeSentMessageEditTargetMessageId,
            onHostElementChange: setSentMessageEditHostElement,
          }
        : undefined,
    [activeSentMessageEditTargetMessageId],
  );

  const sentMessageEdit = useMemo<ThreadDetailSentMessageEdit | undefined>(
    () =>
      activeSentMessageEditSession
        ? {
            draft: activeSentMessageEditSession.draft,
            hostElement: sentMessageEditHostElement,
            isSubmitting: editMessage.isPending,
            operationId: activeSentMessageEditSession.operationId,
            onCancel: cancelSentMessageEdit,
            onSubmit: submitSentMessageEdit,
            updateDraft: updateSentMessageEditDraft,
          }
        : undefined,
    [
      activeSentMessageEditSession,
      cancelSentMessageEdit,
      editMessage.isPending,
      sentMessageEditHostElement,
      submitSentMessageEdit,
      updateSentMessageEditDraft,
    ],
  );

  useEffect(
    () =>
      subscribeComposerFocusRequests(selectionPromptDraft.storageKey, () =>
        setComposerFocusRequestNonce((nonce) => nonce + 1),
      ),
    [selectionPromptDraft.storageKey],
  );

  const composerActions = useMemo(
    () =>
      createCoreComposerActions({
        ...selectionPromptDraft,
        focus: () => setComposerFocusRequestNonce((nonce) => nonce + 1),
      }),
    [selectionPromptDraft],
  );

  const handleSelectionAddToChat = useCallback<ThreadTimelineAddToChatHandler>(
    (text, attachments, mentions) => {
      dismissCompactKeyboard();
      composerActions.addQuote(text, attachments, mentions);
      composerActions.focus();
    },
    [composerActions, dismissCompactKeyboard],
  );

  const canUseGitUi = !executionUnavailable && gitDiffTabStatus === "eligible";

  const canCreateTerminal =
    !executionUnavailable &&
    thread?.environmentId !== null &&
    thread?.environmentId !== undefined &&
    environment?.status === "ready" &&
    connectedHostIds.has(environment.hostId);

  const { providers: registeredEnvironmentProviders } =
    useSystemEnvironmentProviders();

  const environmentMergeBaseBranch =
    resolveEnvironmentMergeBaseBranch(environment);

  const {
    clearPendingGitDiffIntent,
    closeThreadSecondaryPanel,
    isLoadingMergeBaseBranchOptions,
    mergeBaseBranchOptions,
    mergeBaseRemoteBranchOptions,
    openCommitDiff: openPersistedCommitDiff,
    openDiffFile: openPersistedDiffFile,
    openThreadDiffPanel: openPersistedDiffPanel,
    pendingGitDiffCommitSha,
    pendingGitDiffScrollPath,
    requestedMergeBaseBranch,
    selectedMergeBaseBranch,
    selectedMergeBaseBranchRef,
    setMergeBaseBranchSearchQuery,
    setSelectedMergeBaseBranch,
  } = useGitDiffPanel({
    activeSecondaryTab: openFixedSecondaryTab,
    clearActiveFileTabs,
    defaultMergeBaseBranch: environmentMergeBaseBranch,
    environmentId: canUseGitUi
      ? (thread?.environmentId ?? undefined)
      : undefined,
    mergeBaseBranchOptionsEnabled: hasRequestedMergeBaseOptions,
    setThreadSecondaryPanel,
    threadId,
  });

  const {
    closePanel: closeWorkspacePanel,
    openCommitDiff: openGitDiffCommitDestination,
    openCompactDrawer,
    openDiffFile: openGitDiffFileDestination,
    openDiffPanel: openGitDiffDestination,
    openHostFile,
    openPanel: openFixedViewDestination,
    openStorageFile,
    openWorkspaceFile,
    togglePanel: toggleWorkspacePanel,
  } = useThreadSecondaryPanelVisibility({
    closePersistedPanel: closeThreadSecondaryPanel,
    drawerVisibility: secondaryPanelDrawerVisibility,
    isPersistedOpen: isPersistedSecondaryPanelOpen,
    isCompactViewport: renderSecondaryPanelAsDrawer,
    openPersistedCommitDiff,
    openPersistedDiffFile,
    openPersistedDiffPanel,
    openPersistedHostFile: panelFiles.openHostFile,
    openPersistedPanel: setThreadSecondaryPanel,
    openPersistedStorageFile: panelFiles.openStorageFile,
    openPersistedWorkspaceFile: panelFiles.openWorkspaceFile,
    togglePersistedPanel: toggleDefaultPersistedSecondaryPanel,
  });

  const dismissPluginDetails = pluginDetails.dismiss;

  const closeSecondaryPanel = useCallback(() => {
    dismissPluginDetails();
    closeWorkspacePanel();
  }, [dismissPluginDetails, closeWorkspacePanel]);

  const toggleSecondaryPanel = useCallback(() => {
    if (pluginDetails.activePluginId !== null) closeSecondaryPanel();
    else toggleWorkspacePanel();
  }, [pluginDetails.activePluginId, closeSecondaryPanel, toggleWorkspacePanel]);

  const fixedTabDestinations = useMemo(
    () => [
      createThreadInfoFixedTabDestination(() =>
        openFixedViewDestination("thread-info"),
      ),
      createGitDiffFixedTabDestination({
        eligible: canUseGitUi,
        openCommit: openGitDiffCommitDestination,
        openFile: openGitDiffFileDestination,
        openOrdinary: openGitDiffDestination,
      }),
    ],
    [
      canUseGitUi,
      openFixedViewDestination,
      openGitDiffCommitDestination,
      openGitDiffDestination,
      openGitDiffFileDestination,
    ],
  );

  const openFixedTab = useCallback(
    (intent: AppFixedTabOpenIntent): boolean =>
      openAppFixedTabFromDestinations(fixedTabDestinations, intent),
    [fixedTabDestinations],
  );

  const openSecondaryPanel = useCallback(
    (panel: ThreadSecondaryPanelTab) =>
      openFixedTab({
        surface: { kind: "current" },
        tab:
          panel === "git-diff"
            ? GIT_DIFF_FIXED_TAB_REFERENCE
            : THREAD_INFO_FIXED_TAB_REFERENCE,
      }),
    [openFixedTab],
  );

  const openSecondaryPanelDiffPanel = useCallback(
    () =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
      }),
    [openFixedTab],
  );

  const openSecondaryPanelDiffFile = useCallback(
    (path: string) =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
        target: { kind: "file", path },
      }),
    [openFixedTab],
  );

  const openSecondaryPanelCommitDiff = useCallback(
    (sha: string) =>
      openFixedTab({
        surface: { kind: "current" },
        tab: GIT_DIFF_FIXED_TAB_REFERENCE,
        target: { kind: "commit", sha },
      }),
    [openFixedTab],
  );

  const handleOpenTimelinePluginPanel = usePanelPluginPanels({
    actions: pluginThreadPanelActions,
    isFocused,
    openPluginPanel,
    reveal: openCompactDrawer,
    slot: "threadPanelAction",
  });

  const handleSelectFileSearchResult = useCallback(
    (selection: FileSearchSelection) => {
      selectFileSearchResult(selection);
      openCompactDrawer();
    },
    [openCompactDrawer, selectFileSearchResult],
  );

  const handleActivateFileTab = useCallback(
    (tabId: string) => {
      activateTab(tabId);
      openCompactDrawer();
    },
    [activateTab, openCompactDrawer],
  );

  const widenPanelForPreview = useSetAtom(widenSecondaryPanelForPreviewAtom);

  const handleRevealBrowserTab = useCallback(
    (tabId: string) => {
      handleActivateFileTab(tabId);
      widenPanelForPreview();
    },
    [handleActivateFileTab, widenPanelForPreview],
  );

  useDesktopBrowserReveal({
    threadId,
    isFocused,
    browserTabs,
    activateTab: handleRevealBrowserTab,
  });

  const handleSelectStorageBrowserPath =
    useCallback<ThreadStoragePathSelectHandler>(
      (path) => {
        openStorageFile({
          lineRange: null,
          path,
        });
      },
      [openStorageFile],
    );

  const storageBrowserController = useThreadStorageBrowser({
    files: threadStorageFiles?.files,
    onSelectPath: handleSelectStorageBrowserPath,
    selectedPath: activeStorageFilePath,
    threadId,
  });

  const [storedConversationCollapsed, setStoredConversationCollapsed] = useAtom(
    getThreadConversationCollapsedAtom(threadId),
  );

  const isConversationCollapsed = storedConversationCollapsed;

  const toggleConversationCollapse = useCallback(() => {
    setStoredConversationCollapsed((collapsed) => !collapsed);
  }, [setStoredConversationCollapsed]);

  useEffect(() => {
    setHasRequestedMergeBaseOptions(false);
  }, [thread?.environmentId]);

  const handleMergeBasePickerOpenChange =
    useCallback<MergeBasePickerOpenChangeHandler>((open) => {
      if (open) {
        setHasRequestedMergeBaseOptions(true);
      }
    }, []);

  const handleSecondaryPanelChange = useCallback<SecondaryPanelChangeHandler>(
    (panel) => {
      clearActiveFileTabs();
      openSecondaryPanel(panel);
    },
    [clearActiveFileTabs, openSecondaryPanel],
  );

  const secondaryPanelFixedTabs = useMemo<readonly SecondaryPanelFixedTab[]>(
    () =>
      threadFixedViewTabs.map((tab) =>
        tab.kind === "thread-info"
          ? {
              ariaLabel: "Show thread info panel",
              label: "Info",
              leadingVisual: <Icon name="Info" />,
              onSelect: () => handleSecondaryPanelChange("thread-info"),
              tab,
              title: "Thread info",
            }
          : {
              ariaLabel: "Show diff panel",
              label: "Diff",
              leadingVisual: <Icon name="FileDiff" />,
              onSelect: () => handleSecondaryPanelChange("git-diff"),
              tab,
              title: "Diff",
            },
      ),
    [handleSecondaryPanelChange, threadFixedViewTabs],
  );

  const openAttachment = useCallback(
    (attachment: OpenAttachmentRequest) => {
      openTab({ kind: "attachment-file-preview", ...attachment });
      openCompactDrawer();
    },
    [openCompactDrawer, openTab],
  );

  const navigateInPaneRef = useLatestRef(navigateInPane);

  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        const targetProjectId = resource.projectId ?? projectId;

        if (!targetProjectId) return null;

        return () =>
          navigateInPaneRef.current({
            projectId: targetProjectId,
            threadId: resource.threadId,
          });
      }

      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }

      if (resource.kind === "attachment") {
        const attachmentProjectId = projectId;

        if (!attachmentProjectId) return null;

        return () =>
          openAttachment({
            name: resource.label,
            path: resource.path,
            projectId: attachmentProjectId,
          });
      }

      if (resource.kind !== "path" || resource.entryKind !== "file") {
        return null;
      }

      if (resource.source === "thread-storage") {
        return () =>
          openStorageFile({
            lineRange: null,
            path: resource.path,
          });
      }

      if (!thread?.environmentId) return null;

      return () =>
        openWorkspaceFile({
          lineRange: null,
          path: resource.path,
          source: { kind: "working-tree" },
          statusLabel: null,
        });
    },
    [
      openAttachment,
      navigate,
      navigateInPaneRef,
      openStorageFile,
      openWorkspaceFile,
      projectId,
      thread?.environmentId,
    ],
  );

  const handleOpenNewTab = useCallback(() => {
    openNewTab();
    openCompactDrawer();
    setShouldAutoFocusNewTab(true);
  }, [openCompactDrawer, openNewTab]);

  useAppCommandHandler("panel.newTab", () => {
    if (!isFocused) return false;
    handleOpenNewTab();

    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocused || !reopenClosedTab(pluginDetails)) return false;
    openCompactDrawer();

    return true;
  });
  useAppCommandHandler("file.quickOpen", () => {
    if (!isFocused) return false;
    handleOpenNewTab();

    return true;
  });
  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const desktopInfo = getOmnyoDesktopInfo();

    if (
      desktopInfo === null ||
      desktopInfo.onAppCommand !== undefined ||
      desktopInfo.onOpenNewTab === undefined
    ) {
      return;
    }

    return desktopInfo.onOpenNewTab(handleOpenNewTab);
  }, [handleOpenNewTab, isFocused]);

  const acceptsThreadTerminal = useCallback(
    (session: TerminalSession) => session.threadId === threadId,
    [threadId],
  );

  const terminals = usePanelTerminals({
    panelStateId: threadId,
    syncThreadId: threadId,
    createTarget:
      canCreateTerminal && threadId !== undefined
        ? { kind: "thread", threadId }
        : null,
    isFocused,
    acceptsSession: acceptsThreadTerminal,
    tabsCarryTarget: false,
    reveal: openCompactDrawer,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
  });

  const appNavigationCapabilities = useMemo(
    () => ({
      openFilePreview: openLiveFilePreview,
      openFixedTab,
      openTerminal: terminals.open,
    }),
    [openLiveFilePreview, openFixedTab, terminals.open],
  );

  const handleCloseWindowRequest = useCallback(() => {
    if (pluginDetails.activePluginId !== null) {
      pluginDetails.close(pluginDetails.activePluginId);

      return true;
    }

    if (!isSecondaryPanelOpen) {
      return false;
    }

    if (
      activeFixedSecondaryTab !== null &&
      isSecondaryFileTab(activeFixedSecondaryTab)
    ) {
      if (activeFixedSecondaryTab.kind === "terminal") {
        terminals.close(activeFixedSecondaryTab.terminalId);
      } else {
        closeTab(activeFixedSecondaryTab.id);
      }

      return true;
    }

    closeSecondaryPanel();

    return true;
  }, [
    activeFixedSecondaryTab,
    closeSecondaryPanel,
    closeTab,
    isSecondaryPanelOpen,
    pluginDetails,
    terminals,
  ]);

  useAppCommandHandler("panel.toggle", () => {
    if (!isFocused) return false;
    toggleSecondaryPanel();

    return true;
  });
  useWindowRightPanel({ isOpen: isSecondaryPanelOpen, enabled: isFocused });
  useAppCommandHandler("panel.fullScreen.toggle", () => {
    if (
      !isFocused ||
      !isSecondaryPanelOpen ||
      renderSecondaryPanelAsDrawer ||
      isPaneMaximized
    ) {
      return false;
    }

    toggleConversationCollapse();

    return true;
  });
  useAppCommandHandler("panel.close", () => {
    if (!isFocused) return false;

    return handleCloseWindowRequest();
  });
  useAppCommandHandler("diff.toggle", () => {
    if (!isFocused || !canUseGitUi) {
      return false;
    }

    if (isSecondaryPanelOpen && activeFixedSecondaryTab?.kind === "git-diff") {
      closeSecondaryPanel();
    } else {
      openSecondaryPanelDiffPanel();
    }

    return true;
  });
  useEffect(() => {
    if (!isFocused) {
      return;
    }

    const desktopInfo = getOmnyoDesktopInfo();

    if (
      desktopInfo === null ||
      desktopInfo.onCloseWindowRequest === undefined
    ) {
      return;
    }

    return desktopInfo.onCloseWindowRequest(handleCloseWindowRequest);
  }, [handleCloseWindowRequest, isFocused]);

  const handleChangedFileClick = useCallback(
    (selection: WorkspaceChangedFileSelection) => {
      const openTarget = resolveWorkspaceChangedFileOpenTarget(selection);

      if (openTarget.kind === "preview") {
        openWorkspaceFile({
          lineRange: null,
          path: selection.file.path,
          source: openTarget.source,
          statusLabel: openTarget.statusLabel,
        });

        return;
      }

      openSecondaryPanelDiffFile(selection.file.path);
    },
    [openSecondaryPanelDiffFile, openWorkspaceFile],
  );

  const workStatusQuery = useEnvironmentWorkStatus(
    thread?.environmentId,
    requestedMergeBaseBranch,
    {
      enabled: canUseGitUi && environment !== undefined,
    },
  );

  const workspaceStatusError = workStatusQuery.error;

  const workStatusResponse = workStatusQuery.data;

  const workspaceStatus =
    workStatusResponse?.outcome === "available"
      ? workStatusResponse.workspace
      : undefined;

  const workspaceUnavailable =
    workStatusResponse?.outcome === "unavailable"
      ? workStatusResponse.failure
      : undefined;

  const pullRequestQuery = useEnvironmentPullRequest(thread?.environmentId, {
    enabled: canUseGitUi && environment !== undefined,
  });

  const pullRequest = getEnvironmentPullRequestFromResponse(
    pullRequestQuery.data,
  );

  const requestEnvironmentActionAsync = requestEnvironmentAction.mutateAsync;

  const handlePullRequestReady = useCallback(async () => {
    const environmentId = thread?.environmentId;

    if (!environmentId) {
      return;
    }

    const toastId = appToast.loading("Marking pull request ready");

    try {
      const response = await requestEnvironmentActionAsync({
        id: environmentId,
        action: "pull_request_ready",
      });

      if (response.action !== "pull_request_ready") {
        throw new Error("Expected pull request ready action response.");
      }

      appToast.success(response.message, { id: toastId });
    } catch (error) {
      appToast.error("Failed to update pull request", {
        id: toastId,
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Pull request was not updated",
        }),
      });
    }
  }, [requestEnvironmentActionAsync, thread?.environmentId]);

  const handlePullRequestDraft = useCallback(async () => {
    const environmentId = thread?.environmentId;

    if (!environmentId) {
      return;
    }

    const toastId = appToast.loading("Converting pull request to draft");

    try {
      const response = await requestEnvironmentActionAsync({
        id: environmentId,
        action: "pull_request_draft",
      });

      if (response.action !== "pull_request_draft") {
        throw new Error("Expected pull request draft action response.");
      }

      appToast.success(response.message, { id: toastId });
    } catch (error) {
      appToast.error("Failed to update pull request", {
        id: toastId,
        description: getMutationErrorMessage({
          error,
          fallbackMessage: "Pull request was not updated",
        }),
      });
    }
  }, [requestEnvironmentActionAsync, thread?.environmentId]);

  const handlePullRequestMerge = useCallback(
    async (method: PullRequestMergeMethod) => {
      const environmentId = thread?.environmentId;

      if (!environmentId) {
        return;
      }

      setPullRequestMergeMethod(method);
      const toastId = appToast.loading(getPullRequestMergeLoadingTitle(method));

      try {
        const response = await requestEnvironmentActionAsync({
          id: environmentId,
          action: "pull_request_merge",
          options: { method },
        });

        if (response.action !== "pull_request_merge") {
          throw new Error("Expected pull request merge action response.");
        }

        appToast.success(response.message, { id: toastId });
      } catch (error) {
        appToast.error("Failed to merge pull request", {
          id: toastId,
          description: getMutationErrorMessage({
            error,
            fallbackMessage: "Pull request was not merged",
          }),
        });
      }
    },
    [
      requestEnvironmentActionAsync,
      setPullRequestMergeMethod,
      thread?.environmentId,
    ],
  );

  const workspaceBranch = workspaceStatus?.branch;

  const workspaceChangedFilesSection = useMemo(
    () => selectWorkspaceChangedFilesSection(workspaceStatus),
    [workspaceStatus],
  );

  const workingTreeChangedFilesSection = useMemo(() => {
    if (
      workspaceChangedFilesSection === null ||
      workspaceChangedFilesSection.kind === "committed"
    ) {
      return null;
    }

    return workspaceChangedFilesSection;
  }, [workspaceChangedFilesSection]);

  const { isLocalDaemonHost } = useHostDaemon();

  const threadEnvironmentIsLocal = environment
    ? isLocalDaemonHost(environment.hostId)
    : false;

  const removedEnvironmentHostName =
    environment !== undefined && environment.hostLifecycle !== "active"
      ? (threadDetailBootstrapQuery.data?.environmentHostName ?? null)
      : null;

  const environmentDisplayHostContext = useMemo<EnvironmentDisplayHostContext>(
    () => ({
      locality: threadEnvironmentIsLocal ? "local" : "remote",
      identity: threadEnvironmentHost
        ? {
            name: threadEnvironmentHost.name,
            connected: threadEnvironmentHost.status === "connected",
          }
        : removedEnvironmentHostName
          ? {
              name: removedEnvironmentHostName,
              connected: false,
            }
          : null,
    }),
    [
      removedEnvironmentHostName,
      threadEnvironmentIsLocal,
      threadEnvironmentHost,
    ],
  );

  const workspacePreviewRootPath = environment?.path ?? null;

  const threadOpenContext = executionUnavailable
    ? null
    : resolveEnvironmentOpenContext({
        environment,
        serverOrigin: window.location.origin,
        threadEnvironmentIsLocal,
      });

  const {
    canOpenPreferredDirectoryTarget,
    canOpenPreferredFileTarget,
    directoryOpenTargets,
    fileOpenTargets,
    openPathInDirectoryTarget,
    openPathInFileTarget,
    openPathInPreferredDirectoryTarget,
    openPathInPreferredFileTarget,
    preferredDirectoryTarget,
  } = useLocalOpenTargets({
    enabled: threadOpenContext !== null,
    ...(threadOpenContext ? { openContext: threadOpenContext } : {}),
  });

  const parentThreadSection: ThreadPromptParentThreadSection | null =
    useMemo(() => {
      const relatedThreadId =
        threadOriginKind !== null
          ? threadSourceThreadId
          : thread?.parentThreadId;

      if (!thread || !relatedThreadId) return null;
      const relationship = threadOriginKind ?? "parent";

      const relatedThread =
        relationship === "parent" ? parentThread : sourceThread;

      const href = getThreadRoutePath({
        projectId: relatedThread?.projectId ?? thread.projectId,
        threadId: relatedThreadId,
      });

      if (relatedThread === undefined) {
        return {
          parentThreadTitle: relatedThreadId.slice(0, 8),
          href,
          relationship,
        };
      }

      if (
        (relatedThread.archivedAt !== null && relationship !== "handoff") ||
        relatedThread.deletedAt !== null ||
        (relationship !== "parent" &&
          relatedThread.projectId !== thread.projectId)
      ) {
        return null;
      }

      return {
        parentThreadTitle: getThreadDisplayTitle(relatedThread),
        href,
        relationship,
      };
    }, [
      parentThread,
      sourceThread,
      thread,
      threadOriginKind,
      threadSourceThreadId,
    ]);

  const continuationDestinations = useMemo(
    () =>
      (handoffThreadsQuery.data ?? [])
        .filter(
          (entry) => entry.archivedAt === null && entry.deletedAt === null,
        )
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((entry) => ({
          title: getThreadDisplayTitle(entry),
          href: getThreadRoutePath({
            projectId: entry.projectId,
            threadId: entry.id,
          }),
        })),
    [handoffThreadsQuery.data],
  );

  const childThreadsSection: ThreadPromptChildThreadsSection | null =
    useMemo(() => {
      const list = childThreadSubsetQuery.data ?? [];

      const activeItems = list
        .filter(
          (entry) =>
            entry.originKind === null &&
            (isThreadDisplayStatusBannerActive(entry.runtime.displayStatus) ||
              entry.hasPendingInteraction),
        )
        .map((entry) => ({
          id: entry.id,
          title: getThreadDisplayTitle(entry),
          href: getThreadRoutePath({
            projectId: entry.projectId,
            threadId: entry.id,
          }),
          hasPendingInteraction: entry.hasPendingInteraction,
        }))
        .sort((left, right) =>
          left.hasPendingInteraction === right.hasPendingInteraction
            ? 0
            : left.hasPendingInteraction
              ? -1
              : 1,
        );

      if (activeItems.length === 0) return null;

      return { items: activeItems };
    }, [childThreadSubsetQuery.data]);

  const childPendingInteractions = useChildThreadPendingAttention(
    childThreadsSection?.items ?? EMPTY_CHILD_THREAD_ITEMS,
  );

  const isThreadTimelinePending = timelineLoading && timelineRows.length === 0;
  useThreadReadTracking({
    markThreadRead,
    thread: timelineEnabled ? thread : undefined,
  });

  const {
    effectiveMergeBaseBranch,
    handleMergeBaseBranchChange,
    showBranchComparisonUi,
    showMergeBase,
  } = useEnvironmentMergeBase({
    environment,
    selectedMergeBaseBranch,
    setSelectedMergeBaseBranch,
    thread,
    updateEnvironment,
    workspaceStatus,
  });

  const gitActions = useThreadGitActions({
    environment,
    thread,
    workspaceStatus,
  });

  const showGitChanges =
    systemConfigQuery.data?.generalSettings.showGitChanges ?? false;

  const threadGitPhase =
    !showGitChanges || thread?.archivedAt != null || executionUnavailable
      ? "off"
      : gitDiffTabStatus === "loading" ||
          (canUseGitUi && workStatusQuery.isLoading)
        ? "loading"
        : canUseGitUi
          ? "ready"
          : "off";

  const openThreadGitActionDialog = gitActions.threadGitActionDialog.onOpen;

  const threadGit = useMemo(
    () =>
      buildThreadGit({
        phase: threadGitPhase,
        workspaceStatus,
        pullRequest,
        pullRequestHandlers: {
          isPending: requestEnvironmentAction.isPending,
          mergeMethod: pullRequestMergeMethod,
          onMarkReady: handlePullRequestReady,
          onMerge: handlePullRequestMerge,
          onConvertToDraft: handlePullRequestDraft,
        },
        onCommit: gitActions.canCommit
          ? () => openThreadGitActionDialog({ kind: "commit" })
          : null,
        onOpenChangedFile: handleChangedFileClick,
        onOpenDiffPanel: openSecondaryPanelDiffPanel,
      }),
    [
      gitActions.canCommit,
      handleChangedFileClick,
      handlePullRequestDraft,
      handlePullRequestMerge,
      handlePullRequestReady,
      openSecondaryPanelDiffPanel,
      openThreadGitActionDialog,
      pullRequest,
      pullRequestMergeMethod,
      requestEnvironmentAction.isPending,
      threadGitPhase,
      workspaceStatus,
    ],
  );

  const threadMergeBase = useMemo<ThreadMergeBaseConfig | null>(
    () =>
      threadGit?.status === "ready" && showMergeBase && effectiveMergeBaseBranch
        ? {
            branch: effectiveMergeBaseBranch,
            branchRef: selectedMergeBaseBranchRef,
            options: mergeBaseBranchOptions,
            remoteOptions: mergeBaseRemoteBranchOptions,
            optionsLoading: isLoadingMergeBaseBranchOptions,
            onChange: handleMergeBaseBranchChange,
            onPickerOpenChange: handleMergeBasePickerOpenChange,
            onSearchQueryChange: setMergeBaseBranchSearchQuery,
          }
        : null,
    [
      effectiveMergeBaseBranch,
      handleMergeBaseBranchChange,
      handleMergeBasePickerOpenChange,
      isLoadingMergeBaseBranchOptions,
      mergeBaseBranchOptions,
      mergeBaseRemoteBranchOptions,
      selectedMergeBaseBranchRef,
      setMergeBaseBranchSearchQuery,
      showMergeBase,
      threadGit?.status,
    ],
  );

  const threadGitContextValue = useMemo<ThreadGitContextValue>(
    () => ({ git: threadGit, mergeBase: threadMergeBase }),
    [threadGit, threadMergeBase],
  );

  const parentThreadId = thread?.parentThreadId;

  const parentThreadDisplayName =
    parentThread?.title && parentThread.title.trim().length > 0
      ? parentThread.title
      : parentThreadId;

  const handleAssignParent = useCallback(
    (nextParentThreadId: string | null) => {
      if (!thread || updateThread.isPending) {
        return;
      }

      updateThread.mutate({
        id: thread.id,
        parentThreadId: nextParentThreadId,
      });
    },
    [thread, updateThread],
  );

  const handleTimelineLocalFileLinkResolution = useCallback(
    (
      resolution: ThreadLocalFileLinkResolution,
      options?: ThreadSecondaryPanelFileOpenOptions,
    ) => {
      if (resolution.kind === "app-route") {
        return false;
      }

      if (resolution.kind === "error") {
        appToast.error("Failed to open file locally", {
          description: resolution.description,
        });

        return true;
      }

      if (resolution.kind === "open-in-target") {
        void openPathInFileTarget({
          lineNumber: getFilePreviewLineRangeStart({
            lineRange: resolution.request.lineRange,
          }),
          path: resolution.request.path,
          rememberTarget: false,
          targetId: resolution.request.targetId,
        });

        return true;
      }

      if (resolution.kind === "open-workspace-path") {
        openWorkspaceFile(
          {
            lineRange: resolution.request.lineRange,
            path: resolution.request.relativePath,
            source: { kind: "working-tree" },
            statusLabel: null,
          },
          options,
        );

        return true;
      }

      if (resolution.kind === "open-thread-storage-path") {
        openStorageFile(
          {
            lineRange: resolution.request.lineRange,
            path: resolution.request.relativePath,
          },
          options,
        );

        return true;
      }

      openHostFile(
        {
          lineRange: resolution.request.lineRange,
          path: resolution.request.path,
        },
        options,
      );

      return true;
    },
    [openHostFile, openPathInFileTarget, openStorageFile, openWorkspaceFile],
  );

  const handleOpenTimelineLocalFileLink = useCallback(
    (
      link: ThreadTimelineLocalFileLink,
      options?: ThreadSecondaryPanelFileOpenOptions,
    ) => {
      return handleTimelineLocalFileLinkResolution(
        resolveThreadLocalFileLink({
          fileOpenTargetIds: fileOpenTargets.map((target) => target.id),
          hostFileLinksAvailable:
            thread?.environmentId !== null &&
            thread?.environmentId !== undefined,
          link,
          threadStorageRootPath,
          workspaceRootPath: workspacePreviewRootPath,
        }),
        options,
      );
    },
    [
      fileOpenTargets,
      handleTimelineLocalFileLinkResolution,
      thread?.environmentId,
      threadStorageRootPath,
      workspacePreviewRootPath,
    ],
  );

  const handleOpenTimelineLink = useCallback<ThreadTimelineLinkHandler>(
    ({ href }) => openBrowserUrl(href),
    [openBrowserUrl],
  );

  const handleTimelineTitleAction = useCallback<TimelineTitleActionResolver>(
    (action) => {
      switch (action.kind) {
        case "open-file-diff":
          return () => {
            openSecondaryPanelDiffFile(action.path);
          };

        case "open-plugin-side-chat":
          return () => {
            handleOpenTimelinePluginPanel({
              pluginId: SIDE_CHAT_PLUGIN_ID,
              actionId: SIDE_CHAT_PLUGIN_PANEL_ACTION_ID,
              params: { threadId: action.threadId, sourceThreadId: threadId },
            });
          };

        default:
          return assertNever(action);
      }
    },
    [openSecondaryPanelDiffFile, handleOpenTimelinePluginPanel, threadId],
  );

  const metadataStorage = useMemo(
    () =>
      resolvedThreadEnvironmentHost?.status === "connected"
        ? {
            controller: storageBrowserController,
            filesError: threadStorageFilesError,
          }
        : undefined,
    [
      resolvedThreadEnvironmentHost?.status,
      storageBrowserController,
      threadStorageFilesError,
    ],
  );

  const handleOpenFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: workspacePreviewRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      workspacePreviewRootPath,
    ],
  );

  const handleOpenStorageFileInEditor = useMemo(
    () =>
      buildOpenInEditorHandler({
        rootPath: threadStorageRootPath,
        canOpenPreferredTarget: canOpenPreferredFileTarget,
        openInPreferredTarget: openPathInPreferredFileTarget,
      }),
    [
      canOpenPreferredFileTarget,
      openPathInPreferredFileTarget,
      threadStorageRootPath,
    ],
  );

  const handleOpenHostFileInEditor = useMemo<
    OpenInEditorHandler | undefined
  >(() => {
    if (!canOpenPreferredFileTarget) {
      return undefined;
    }

    return (path) => {
      void openPathInPreferredFileTarget({
        lineNumber: getFilePreviewLineRangeStart({
          lineRange: activeHostFileLineRange,
        }),
        path,
      });
    };
  }, [
    activeHostFileLineRange,
    canOpenPreferredFileTarget,
    openPathInPreferredFileTarget,
  ]);

  const workspaceOpenPath = executionUnavailable
    ? null
    : resolveThreadWorkspaceOpenPath({
        canOpenWorkspace: canOpenPreferredDirectoryTarget,
        environment,
        hasWorkspaceOpenTargets: directoryOpenTargets.length > 0,
      });

  useAppCommandHandler("workspace.openPreferred", () => {
    if (!isFocused) return false;

    if (activeWorkspaceFilePath && handleOpenFileInEditor) {
      handleOpenFileInEditor(activeWorkspaceFilePath);

      return true;
    }

    if (activeHostFilePath && handleOpenHostFileInEditor) {
      handleOpenHostFileInEditor(activeHostFilePath);

      return true;
    }

    if (activeStorageFilePath && handleOpenStorageFileInEditor) {
      handleOpenStorageFileInEditor(activeStorageFilePath);

      return true;
    }

    if (workspaceOpenPath && preferredDirectoryTarget) {
      void openPathInPreferredDirectoryTarget({
        lineNumber: null,
        path: workspaceOpenPath,
      });

      return true;
    }

    return false;
  });

  const getLocalFileContextMenuItems = useCallback(
    (link: ThreadTimelineLocalFileLink) => {
      const extension = getFileExtension(link.path);

      const matching =
        extension === null
          ? []
          : pluginFileOpeners.filter((opener) =>
              opener.extensions.includes(extension),
            );

      const lineNumber = getFilePreviewLineRangeStart({
        lineRange: link.lineRange,
      });

      const openTargetItems = fileOpenTargets.map((target) => ({
        id: `open-target:${target.id}`,
        label: buildOpenTargetMenuItemLabel(target),
        onSelect: () => {
          void openPathInFileTarget({
            lineNumber,
            path: link.path,
            rememberTarget: false,
            targetId: target.id,
          });
        },
      }));

      const items: MarkdownLocalFileContextMenuItem[] = [];

      if (openTargetItems.length > 0) {
        items.push({
          id: "open-in",
          items: openTargetItems,
          label: "Open in",
          type: "submenu",
        });
      }

      if (matching.length > 0) {
        if (items.length > 0) {
          items.push({ id: "open-with-separator", type: "separator" });
        }

        items.push(
          {
            id: "builtin",
            label: "Open with built-in preview",
            onSelect: () => {
              handleOpenTimelineLocalFileLink(link, { viewer: "builtin" });
            },
          },
          ...matching.map((opener) => ({
            id: `${opener.pluginId}:${opener.id}`,
            label: `Open with ${opener.title}`,
            onSelect: () => {
              handleOpenTimelineLocalFileLink(link, {
                viewer: { pluginId: opener.pluginId, openerId: opener.id },
              });
            },
          })),
        );
      }

      if (items.length > 0) {
        items.push({ id: "copy-separator", type: "separator" });
      }

      items.push(
        {
          id: "copy-path",
          label: "Copy file path",
          onSelect: () => {
            void copyToClipboardWithToast(link.path, {
              successMessage: "File path copied",
              errorMessage: "Failed to copy file path",
            });
          },
        },
        {
          id: "copy-name",
          label: "Copy file name",
          onSelect: () => {
            void copyToClipboardWithToast(getFileBasename(link.path), {
              successMessage: "File name copied",
              errorMessage: "Failed to copy file name",
            });
          },
        },
      );

      return items;
    },
    [
      fileOpenTargets,
      handleOpenTimelineLocalFileLink,
      openPathInFileTarget,
      pluginFileOpeners,
    ],
  );

  const handleOpenFilePreview = useCallback<OpenFilePreviewHandler>(
    (relativePath) => {
      if (
        thread?.environmentId === null ||
        thread?.environmentId === undefined
      ) {
        return;
      }

      openLiveFilePreview({
        target: {
          kind: "workspace",
          environmentId: thread.environmentId,
          path: relativePath,
        },
        location: null,
      });
    },
    [openLiveFilePreview, thread?.environmentId],
  );

  useThreadInitialLoadPending(
    !hasThreadDetailBootstrapSettled ||
      threadIsLoading ||
      (isPlaceholderData && !error && !threadDetailBootstrapQuery.isError) ||
      (thread !== undefined &&
        !confirmedThreadNotFound &&
        isThreadTimelinePending &&
        !timelineError),
    true,
  );

  useThreadInitialLoadPending(
    !pluginFrontendsSettled ||
      pendingInteractionsQuery.isLoading ||
      environmentQuery.isLoading ||
      hostsQuery.isLoading ||
      childThreadSubsetQuery.isLoading ||
      (canUseGitUi && workStatusQuery.isLoading),
  );

  const timelineNotFound =
    timelineError instanceof OmnyoHttpError && timelineError.status === 404;

  if (threadNotFound || confirmedThreadNotFound || timelineNotFound) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">Not found</p>
      </PageShell>
    );
  }

  const isThreadBootstrapUnavailable =
    threadDetailBootstrapQuery.isError &&
    threadDetailBootstrapQuery.data === undefined &&
    (thread === undefined || isPlaceholderData);

  const hasCachedThreadSnapshot =
    thread?.id === threadId && thread.projectId === projectId;

  const showReadOnlyCachedTimeline =
    !hasCachedThreadSnapshot &&
    (!hasThreadDetailBootstrapSettled ||
      isThreadBootstrapUnavailable ||
      threadQueryState.status === "loading" ||
      (threadQueryState.status === "unavailable" &&
        !thread &&
        timelineRows.length > 0));

  if (showReadOnlyCachedTimeline) {
    return (
      <RouteLoadingSkeleton isBoundedPane={isBoundedPane}>
        {isThreadBootstrapUnavailable ||
        threadQueryState.status === "unavailable" ? (
          <p className="py-3 text-center text-sm text-destructive" role="alert">
            Failed to load thread.
          </p>
        ) : null}
        {timelineRows.length > 0 ? (
          <div
            className="flex h-full min-h-0 flex-col"
            data-cached-thread-timeline-display=""
          >
            <BottomAnchoredScrollBody
              footer={null}
              maxWidthClassName="max-w-none"
              contentClassName="px-0"
              animateFollowLatest
            >
              <ThreadTimelineSurface
                activeThinking={null}
                contextBoundarySeq={null}
                isThreadTimelinePending={false}
                timelineError={timelineError !== null}
                projectId={projectId}
                includePluginMessageActions={false}
                showOngoingIndicator={false}
                timelineRows={timelineRows}
                threadId={threadId}
                readOnly
                unreadDividerPlacement={null}
                workspaceRootPath={undefined}
              />
            </BottomAnchoredScrollBody>
          </div>
        ) : (
          <ThreadTimelineLoadingSkeleton />
        )}
      </RouteLoadingSkeleton>
    );
  }

  if (!thread || thread.projectId !== projectId) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          {error ? "Failed to load thread." : "Not found"}
        </p>
      </PageShell>
    );
  }

  const canAssignToParent = isThreadRoot;
  const canTakeOverThread = Boolean(thread.parentThreadId);

  const environmentProvisioningFailure =
    thread.status === "error" && thread.environmentId === null
      ? hasThreadProvisioningFailure(timelineRows)
      : false;

  const threadEnvironmentProviderLookup = findEnvironmentDisplayProvider(
    registeredEnvironmentProviders,
    environment?.environmentProviderId ?? null,
  );

  const threadEnvironmentDisplay = environment
    ? formatEnvironmentDisplay({
        environment,
        host: environmentDisplayHostContext,
        providerLookup: threadEnvironmentProviderLookup,
      })
    : undefined;

  const threadEnvironmentLabel = threadEnvironmentDisplay
    ? getEnvironmentWorkspaceSummaryDisplay({
        display: threadEnvironmentDisplay,
        providerLookup: threadEnvironmentProviderLookup,
        hasMultipleMachines,
        hostName: resolvedThreadEnvironmentHost?.name ?? null,
        hostType: resolvedThreadEnvironmentHost?.type ?? null,
      })?.label
    : undefined;

  const isThreadOnReusableEnvironment =
    !executionUnavailable &&
    environment !== undefined &&
    environment.status === "ready" &&
    environment.path !== null;

  const threadBranchName = workspaceBranch?.currentBranch ?? undefined;

  const threadCheckoutDisplay = workspaceStatus
    ? formatWorkspaceCheckoutDisplay({ checkout: workspaceStatus.checkout })
    : undefined;

  const isWorkspaceDeleted = environment?.status === "destroyed";

  const threadEnvironmentGoneStatus =
    hostLifecycle ??
    (environment?.status === "destroyed" ? environment.status : null);

  const threadGitStatusDisplay = getGitStatusDisplay(workspaceStatus, {
    mergeBaseBranch: effectiveMergeBaseBranch,
    showBranchComparison: showBranchComparisonUi,
    error: workspaceStatusError,
    workspaceUnavailable,
    workspaceDeleted: isWorkspaceDeleted,
  });

  const threadTitle = getThreadDisplayTitle(thread);

  const responsiveWorkspaceActions: PluginThreadActionsInlineItem[] =
    workspaceOpenPath && preferredDirectoryTarget
      ? [
          {
            key: "workspace/open",
            group: THREAD_HEADER_ACTIONS_GROUP,
            action: {
              icon: "FolderOpen",
              label: "Open workspace in…",
              detail: preferredDirectoryTarget.label,
              choices: {
                heading: "Open workspace in",
                items: [
                  preferredDirectoryTarget,
                  ...directoryOpenTargets.filter(
                    (target) => target.id !== preferredDirectoryTarget.id,
                  ),
                ].map((target) => ({
                  id: target.id,
                  label: target.label,
                  selected: target.id === preferredDirectoryTarget.id,
                })),
              },
              run: async ({ value }) => {
                if (value === undefined) return;

                if (value === preferredDirectoryTarget.id) {
                  await openPathInPreferredDirectoryTarget({
                    lineNumber: null,
                    path: workspaceOpenPath,
                  });

                  return;
                }

                await openPathInDirectoryTarget({
                  lineNumber: null,
                  path: workspaceOpenPath,
                  rememberTarget: true,
                  targetId: value,
                });
              },
            },
          },
        ]
      : [];

  const threadActionTarget = toThreadActionTarget(
    thread,
    isThreadOnReusableEnvironment && thread.environmentId !== null
      ? { id: thread.environmentId, path: environment.path }
      : null,
  );

  const workspaceOpenButton =
    workspaceOpenPath && preferredDirectoryTarget ? (
      <ThreadWorkspaceOpenButton
        preferredTarget={preferredDirectoryTarget}
        targets={directoryOpenTargets}
        onOpenPreferredTarget={async () => {
          await openPathInPreferredDirectoryTarget({
            lineNumber: null,
            path: workspaceOpenPath,
          });
        }}
        onOpenTarget={async (targetId) => {
          await openPathInDirectoryTarget({
            lineNumber: null,
            path: workspaceOpenPath,
            rememberTarget: true,
            targetId,
          });
        }}
      />
    ) : undefined;

  const timelineHeader = (
    <>
      <ThreadDetailHeader
        actionsMenu={({
          includeResponsiveActions,
          isCompactViewport,
          requestRename,
          onCloseAutoFocus,
        }) => (
          <ThreadActionsMenu
            thread={threadActionTarget}
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  triggerProps.className,
                  "rounded-md p-0",
                  "data-[state=open]:bg-state-active data-[state=open]:text-foreground",
                  HEADER_ICON_BUTTON_CLASS,
                )}
                aria-label="Thread actions"
                onClick={(event) => {
                  triggerProps.onClick?.(event);
                  event.stopPropagation();
                }}
              >
                <Icon
                  name="MoreHorizontal"
                  className={COARSE_POINTER_ICON_SIZE_CLASS}
                />
              </Button>
            )}
            inline={buildThreadHeaderMenuItems({
              threadId: thread.id,
              isCompactViewport,
              executionHost: resolvedThreadEnvironmentHost
                ? {
                    name: resolvedThreadEnvironmentHost.name,
                    connected:
                      resolvedThreadEnvironmentHost.status === "connected",
                  }
                : null,
              lineageSource: parentThreadSection,
              lineageDestinations: continuationDestinations,
              navigate,
              responsiveItems: includeResponsiveActions
                ? responsiveWorkspaceActions
                : [],
            })}
            requestRename={requestRename}
            onCloseAutoFocus={onCloseAutoFocus}
          />
        )}
        checkout={threadCheckoutDisplay}
        environmentLabel={threadEnvironmentLabel}
        isSecondaryPanelOpen={isSecondaryPanelOpen}
        onClosePane={onRequestClose ?? undefined}
        onToggleSecondaryPanel={toggleSecondaryPanel}
        pluginActions={
          <>
            <ThreadLineageControl
              source={parentThreadSection}
              destinations={continuationDestinations}
            />
            <PluginThreadHeaderActions
              threadId={thread.id}
              projectId={thread.projectId}
            />
          </>
        }
        threadId={thread.id}
        threadTitle={threadTitle}
        workspaceOpenButton={workspaceOpenButton}
      />
      <ThreadPaneTopOverlay
        goal={
          <FloatingThreadGoal
            key={thread.id}
            goal={goal}
            threadId={thread.id}
          />
        }
        goalShown={goal?.status === "active"}
      />
    </>
  );

  const ownerUnavailable =
    (ownerThreadQuery.error instanceof OmnyoHttpError &&
      ownerThreadQuery.error.status === 404) ||
    (ownerThread !== undefined &&
      (ownerThread.archivedAt !== null || ownerThread.deletedAt !== null));

  let ownerRecovery: ReactNode = null;

  if (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    ownerThreadId != null &&
    !ownerThreadQuery.isPlaceholderData
  ) {
    if (ownerUnavailable) {
      ownerRecovery = (
        <ThreadOwnerRecovery
          recovery={
            thread.parentThreadId !== null &&
            thread.lifecycleOwnerThreadId == null
              ? {
                  kind: "lost-parent",
                  pending: updateThread.isPending,
                  takeOver: () => handleAssignParent(null),
                }
              : { kind: "unavailable-workflow" }
          }
        />
      );
    } else if (ownerThread?.status === "error") {
      ownerRecovery = (
        <ThreadOwnerRecovery
          recovery={{
            kind: "failed",
            href: getThreadRoutePath({
              projectId: ownerThread.projectId,
              threadId: ownerThread.id,
            }),
            title: getThreadDisplayTitle(ownerThread),
          }}
        />
      );
    }
  }

  const showOngoingIndicator =
    thread.status !== "stopping" &&
    !hasPendingInteraction &&
    isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus) &&
    !isThreadTimelinePending;

  const composerLiveActivity = showOngoingIndicator
    ? summarizeLiveActivity({
        activeThinking,
        label: undefined,
        rows: timelineRows,
      })
    : null;

  const composerWorkingLabel =
    composerLiveActivity?.label ??
    (composerLiveActivity?.isThinking ? "Thinking" : "Working");

  const composerWorking: ComposerWorkingState | null =
    composerLiveActivity === null
      ? null
      : {
          label: composerWorkingLabel,
          detail: composerLiveActivity.detail ?? composerWorkingLabel,
          thinking: composerLiveActivity.isThinking,
          startedAt:
            composerLiveActivity.startedAt ?? activeTurnStartedAt(timelineRows),
        };

  const composerFooter = (
    <ThreadDetailPromptArea
      activeBackgroundAgentCount={thread.activeBackgroundAgentCount}
      contextWindowUsage={contextWindowUsage}
      canRestoreEnvironment={thread.canRestoreEnvironment}
      environmentGoneStatus={threadEnvironmentGoneStatus}
      environmentHostId={environment?.hostId}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      composerFocusRequestNonce={composerFocusRequestNonce}
      sendMessage={sendMessage}
      sentMessageEdit={sentMessageEdit}
      steerActiveThreadOnEnter={
        systemConfigQuery.data?.generalSettings.steerActiveThreadOnEnter ??
        defaultAppSettings.steerActiveThreadOnEnter
      }
      pendingInteractions={pendingInteractions}
      queuedMessageCount={thread.queuedMessageCount}
      pendingTodos={pendingTodos}
      activePromptMode={activePromptMode}
      providerCommands={providerCommands}
      sessionOptions={sessionOptions}
      modelFallback={modelFallback}
      activeWorkflows={activeWorkflows}
      activeBackgroundCommands={activeBackgroundCommands}
      ownerRecovery={ownerRecovery}
      parentThreadSection={parentThreadSection}
      childPendingInteractions={childPendingInteractions}
      childThreadsSection={childThreadsSection}
      thread={thread}
      working={composerWorking}
    />
  );

  const renderSecondaryTabContent = (
    tab: SecondaryFileFixedPanelTab,
  ): ReactNode => {
    switch (tab.kind) {
      case "browser":
        return null;
      case "terminal":
        return (
          <LazyThreadTerminalPanel
            autoFocus={
              tab.id === activeFixedSecondaryTabId &&
              tab.terminalId === terminals.autoFocusTerminalId
            }
            isPanelOpen={isSecondaryPanelOpen}
            isPanelPersistedOpen={isPersistedSecondaryPanelOpen}
            onAutoFocusHandled={terminals.handleAutoFocusHandled}
            onOpenLink={handleOpenTimelineLink}
            onSelectionAddToChat={handleSelectionAddToChat}
            target={{ kind: "thread", threadId: thread.id }}
            terminalId={tab.terminalId}
          />
        );
      case "new-tab":
        return (
          <LazyNewTabPage
            autoFocus={
              tab.id === activeFixedSecondaryTabId && shouldAutoFocusNewTab
            }
            projectId={projectId ?? undefined}
            environmentId={thread.environmentId ?? null}
            currentThreadId={thread.id}
            onAutoFocusHandled={handleNewTabAutoFocusHandled}
            onSelect={handleSelectFileSearchResult}
            onOpenBrowser={() => {
              activateTab(tab.id);
              openBrowser?.();
            }}
            onStartTerminal={
              canCreateTerminal
                ? () => {
                    activateTab(tab.id);
                    terminals.start();
                  }
                : undefined
            }
            pluginActions={pluginPanelActions}
          />
        );
      case "workspace-file-preview": {
        const copyPath = resolveAbsoluteFilePath({
          path: tab.path,
          rootPath: workspacePreviewRootPath,
        });

        return (
          <LazyWorkspaceFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            environmentId={tab.environmentId}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir: copyPath
                ? getAbsoluteDirname({ path: copyPath })
                : undefined,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: workspacePreviewRootPath,
            })}
            onOpenInEditor={handleOpenFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            source={tab.source}
            statusLabel={tab.statusLabel}
            threadId={thread.id}
          />
        );
      }

      case "host-file-preview": {
        const baseDir = getAbsoluteDirname({ path: tab.path });

        return (
          <LazyHostFilePreviewTabContent
            activePath={tab.path}
            copyPath={tab.path}
            environmentId={tab.environmentId}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: resolveHostFilePreviewLinkRootPath({
                baseDir,
                threadStorageRootPath,
                workspaceRootPath: workspacePreviewRootPath,
              }),
            })}
            onOpenInEditor={handleOpenHostFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            threadId={thread.id}
          />
        );
      }

      case "attachment-file-preview":
        return (
          <LazyAttachmentFilePreviewTabContent
            isPanelOpen={isSecondaryPanelOpen}
            name={tab.name}
            onSelectionAddToChat={handleSelectionAddToChat}
            path={tab.path}
            projectId={tab.projectId}
          />
        );
      case "thread-storage-file-preview": {
        const copyPath = resolveAbsoluteFilePath({
          path: tab.path,
          rootPath: threadStorageRootPath,
        });

        return (
          <LazyThreadStorageFilePreviewTabContent
            activePath={tab.path}
            copyPath={copyPath}
            isPanelOpen={isSecondaryPanelOpen}
            lineRange={tab.lineRange}
            markdownLinkRouting={buildMarkdownPreviewLinkRouting({
              baseDir: copyPath
                ? getAbsoluteDirname({ path: copyPath })
                : undefined,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              rootPath: threadStorageRootPath,
            })}
            onOpenInEditor={handleOpenStorageFileInEditor}
            onSelectionAddToChat={handleSelectionAddToChat}
            threadId={thread.id}
          />
        );
      }

      case "plugin-panel": {
        const originalTab = createFileOpenerOriginalTab(tab);

        const fileOpenerOriginal =
          originalTab === null
            ? undefined
            : renderSecondaryTabContent(originalTab);

        return (
          <ThreadTimelineNavigationProvider
            environmentId={thread.environmentId}
            onOpenLink={handleOpenTimelineLink}
            onOpenLocalFileLink={handleOpenTimelineLocalFileLink}
            resolveMentionLink={resolveMentionLink}
            threadId={thread.id}
            workspaceRootPath={environment?.path ?? undefined}
          >
            <PluginPanelTabContent
              tab={tab}
              context={{ kind: "thread", threadId: thread.id }}
              fileOpenerOriginal={fileOpenerOriginal}
            />
          </ThreadTimelineNavigationProvider>
        );
      }
    }
  };

  const filenameOfPanelTab = (path: string) => path.split("/").at(-1) ?? path;

  const panelTabs: readonly SecondaryPanelRenderableTab[] =
    syncedOrderedSecondaryFileTabs.map((tab): SecondaryPanelRenderableTab => {
      const pluginAction =
        tab.kind === "plugin-panel"
          ? pluginThreadPanelActions.find(
              (action) =>
                action.pluginId === tab.pluginId && action.id === tab.actionId,
            )
          : undefined;

      const shared = {
        contentFillsRegion:
          tab.kind === "plugin-panel" &&
          (tab.fileOpenerOwner !== undefined ||
            pluginAction?.layout === "flush"),
        onClose: () => closeTab(tab.id),
        renderContent: () => renderSecondaryTabContent(tab),
        tab,
      };

      switch (tab.kind) {
        case "browser": {
          const browserLabel =
            tab.title ?? (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");

          return {
            ...shared,
            label: browserLabel.length > 0 ? browserLabel : "Browser",
            leadingVisual: (
              <Icon
                name="Globe"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        }

        case "terminal": {
          const session = terminalsById.get(tab.terminalId);

          return {
            ...shared,
            label: session?.title ?? "Terminal",
            leadingVisual: (
              <Icon
                name="Terminal"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel:
              session === undefined || session.status === "running"
                ? null
                : session.status,
            onSelect: () => terminals.select(tab.terminalId),
            onClose: () => terminals.close(tab.terminalId),
          };
        }

        case "workspace-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: tab.statusLabel,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "host-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "thread-storage-file-preview":
          return {
            ...shared,
            label: filenameOfPanelTab(tab.path),
            isPinned: tab.isPinned,
            leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "attachment-file-preview":
          return {
            ...shared,
            label: tab.name,
            leadingVisual: <RightPanelFileTabIcon path={tab.name} />,
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "new-tab":
          return {
            ...shared,
            label: "New tab",
            leadingVisual: (
              <Icon
                name="NewTab"
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
                aria-hidden
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
        case "plugin-panel":
          return {
            ...shared,
            label: tab.title,
            leadingVisual: (
              <PluginItemIcon
                pluginId={tab.pluginId}
                icon={pluginAction?.icon ?? null}
                className={COARSE_POINTER_COMPACT_ICON_SIZE_CLASS}
              />
            ),
            statusLabel: null,
            onSelect: () => handleActivateFileTab(tab.id),
          };
      }
    });

  const threadDetailContent = (
    <MarkdownLocalFileContextMenuContext.Provider
      value={getLocalFileContextMenuItems}
    >
      <UrlOpenRoutingProvider openInAppBrowser={openBrowser}>
        <AppNavigationHostProvider capabilities={appNavigationCapabilities}>
          <ThreadDetailSecondaryContent
            footer={composerFooter}
            header={timelineHeader}
            isMetadataLoading={
              !hasThreadDetailBootstrapSettled || environmentQuery.isLoading
            }
            isSecondaryPanelOpen={isSecondaryPanelOpen}
            isConversationCollapsed={isConversationCollapsed}
            isBoundedPane={isBoundedPane}
            onToggleSecondaryPanel={toggleSecondaryPanel}
            onToggleConversationCollapse={toggleConversationCollapse}
            renderHostedPanel={(panel) => (
              <MarkdownLocalFileContextMenuContext.Provider
                value={getLocalFileContextMenuItems}
              >
                <MarkdownLocalFileOpenTargetsContext.Provider
                  value={fileOpenTargets}
                >
                  <UrlOpenRoutingProvider openInAppBrowser={openBrowser}>
                    {panel}
                  </UrlOpenRoutingProvider>
                </MarkdownLocalFileOpenTargetsContext.Provider>
              </MarkdownLocalFileContextMenuContext.Provider>
            )}
            metadata={{
              thread,
              projectId,
              parentThreadProjectId: parentThread?.projectId ?? null,
              parentThreadDisplayName: parentThreadDisplayName ?? null,
              parentThreads,
              canAssignToParent,
              canTakeOverThread,
              isLoadingParentThreads: parentThreadSubsetQuery.isLoading,
              isParentThreadsError: parentThreadSubsetQuery.isError,
              environment: environment ?? null,
              environmentProvisioningFailure,
              environmentDisplayHost: environmentDisplayHostContext,
              workspaceStatus,
              workspaceStatusError: workspaceStatusError ?? null,
              workspaceUnavailable,
              pullRequest,
              selectedMergeBaseBranch,
              mergeBaseBranchRef: selectedMergeBaseBranchRef,
              mergeBaseBranchOptions,
              mergeBaseRemoteBranchOptions,
              isLoadingMergeBaseBranchOptions,
              updateThreadPending:
                updateThread.isPending || updateEnvironment.isPending,
              storage: metadataStorage,
              onAssignParent: handleAssignParent,
              onParentSelectorOpenChange: handleParentSelectorOpenChange,
              onRetryParentThreads: handleRetryParentThreads,
              onMergeBaseBranchChange: handleMergeBaseBranchChange,
              onMergeBasePickerOpenChange: handleMergeBasePickerOpenChange,
              onMergeBaseBranchSearchQueryChange: setMergeBaseBranchSearchQuery,
              onChangedFileClick: canUseGitUi
                ? handleChangedFileClick
                : undefined,
              onCommitClick: canUseGitUi
                ? openSecondaryPanelCommitDiff
                : undefined,
              onOpenChangedFile: canUseGitUi
                ? handleOpenFilePreview
                : undefined,
            }}
            secondaryPanel={{
              canNavigateTabs: isFocused,
              activeTab: activeFixedSecondaryTab,
              canUseGitUi,
              gitDiffTabStatus,
              environmentId: thread.environmentId ?? undefined,
              workspaceRootPath: environment?.path,
              tabs: panelTabs,
              fixedTabs: secondaryPanelFixedTabs,
              splitPanelStateId: thread.id,
              renderBrowserDeck,
              isOpen: isSecondaryPanelOpen,
              showFullScreenShortcut: true,
              onClose: closeSecondaryPanel,
              onCollapse: closeSecondaryPanel,
              onClearPendingGitDiffIntent: clearPendingGitDiffIntent,
              onOpenFileInEditor: handleOpenFileInEditor,
              onTabReorder: reorderTab,
              onOpenNewTab: handleOpenNewTab,
              onRetryGitDiffEligibility: () => {
                void environmentQuery.refetch();
              },
              onOpenFilePreview: handleOpenFilePreview,
              onSelectionAddToChat: handleSelectionAddToChat,
              pendingGitDiffCommitSha,
              pendingGitDiffScrollPath,
              requestedMergeBaseBranch,
              onPanelFocus: touchFixedPanelTabsState,
            }}
            timeline={{
              completion,
              activeThinking,
              canSpawnChild: thread.canSpawnChild,
              contextBoundarySeq,
              hasPagedHistory,
              hasOlderTimelineRows,
              hostConnectionNotice,
              isCatchingUpTimeline,
              isLoadingOlderTimelineRows,
              isThreadTimelinePending,
              timelineError: Boolean(timelineError),
              onForkMessage: isForkAvailable ? handleForkMessage : undefined,
              onEditMessage: canEditSentMessages
                ? handleEditSentMessage
                : undefined,
              inlineMessageEditor,
              onMessageAddToChat: handleSelectionAddToChat,
              onSelectionAddToChat: handleSelectionAddToChat,
              onLoadOlderRows: loadOlderTimelineRows,
              onOpenLink: handleOpenTimelineLink,
              onOpenLocalFileLink: handleOpenTimelineLocalFileLink,
              onOpenPluginPanel: handleOpenTimelinePluginPanel,
              onTitleAction: handleTimelineTitleAction,
              projectId,
              resolveMentionLink,
              readOnly: isReadOnlyDisplay,
              showOngoingIndicator,
              timelineRows,
              isStopping: thread.status === "stopping",
              stoppingAnchorAt: thread.updatedAt,
              threadId: thread.id,
              threadRuntimeDisplayStatus: thread.runtime.displayStatus,
              unreadDividerAutoScroll: false,
              unreadDividerPlacement: unreadDividerState.placement,
              workspaceRootPath: environment?.path ?? undefined,
            }}
          />
          {canUseGitUi ? (
            <ThreadGitActionDialog
              target={gitActions.threadGitActionDialog.target}
              branchName={threadBranchName}
              gitStatusDisplay={threadGitStatusDisplay}
              changedFilesSection={workingTreeChangedFilesSection}
              onOpenChange={(open) => {
                if (!open) {
                  gitActions.threadGitActionDialog.onClose();
                }
              }}
              onCommit={gitActions.handleCommitThread}
            />
          ) : null}
        </AppNavigationHostProvider>
      </UrlOpenRoutingProvider>
    </MarkdownLocalFileContextMenuContext.Provider>
  );

  return (
    <ThreadGitProvider value={threadGitContextValue}>
      <ThreadArchiveCommandHandler thread={threadActionTarget} />
      <ThreadShelveCommandHandler thread={threadActionTarget} />
      <ThreadCopyLinkCommandHandler thread={threadActionTarget} />
      <ThreadProviderContext.Provider value={threadProviderContextValue}>
        <PluginThreadPanelNavigationProvider
          openThreadPanel={handleOpenTimelinePluginPanel}
        >
          <PluginDetailPanelContext.Provider value={pluginDetails}>
            <MarkdownLocalFileOpenTargetsContext.Provider
              value={fileOpenTargets}
            >
              <AttachmentOpenerContext.Provider value={openAttachment}>
                <ThreadCompanionHost
                  threadId={thread.id}
                  projectId={thread.projectId}
                  focused={isFocused}
                >
                  {threadDetailContent}
                </ThreadCompanionHost>
              </AttachmentOpenerContext.Provider>
            </MarkdownLocalFileOpenTargetsContext.Provider>
          </PluginDetailPanelContext.Provider>
        </PluginThreadPanelNavigationProvider>
      </ThreadProviderContext.Provider>
    </ThreadGitProvider>
  );
}

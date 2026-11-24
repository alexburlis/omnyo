import { usePublishVisiblePanel } from "@/lib/visible-app-context";
import { getPanelTabHistoryKey } from "@/components/secondary-panel/recentlyClosedPanelTabs";
import {
  appendQuoteAndAttachmentsToDraft,
  type PromptDraftState,
} from "@omnyo/client-core";
import type { ComposerAttachment } from "@omnyo/plugin-sdk";
import { appendComposerDraft } from "@omnyo/plugin-sdk/internal/composer-handle";
import {
  composerDraftFromPromptDraft,
  createCoreComposerActions,
} from "@/lib/plugin-composer-handle";

import { readThreadCreationPlacement } from "@/lib/thread-creation-placement";
import { useRootComposePlacement } from "@/lib/root-compose-selection";
import { useInitialPromptDraft } from "@/components/promptbox/mentions/initial-prompt-draft";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  findLocalPathProjectSourceForHost,
  type EnvironmentStatus,
} from "@omnyo/domain";
import type { TerminalSession } from "@omnyo/server-contract";
import {
  NewThreadComposer,
  type NewThreadComposerState,
} from "@/components/promptbox/NewThreadComposer";
import { useProviderCliGate } from "./new-chat/useProviderCliGate";
import { encodeReuseValue } from "@/components/pickers/environment-picker-value";
import { useProjectMachineSetup } from "./new-chat/useProjectMachineSetup";
import { HEADER_ICON_BUTTON_CLASS } from "@/components/layout/AppPageHeader";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { useWindowTitleBarHostsRightPanelToggle } from "@/components/layout/WindowRightPanelToggle";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appCommandTarget } from "@/lib/app-command-targets";
import type {
  SecondaryPanelPaneRenderContext,
  SecondaryPanelRenderableTab,
} from "@/components/secondary-panel/ThreadSecondaryPanel";
import {
  LazyBrowserTabDeck,
  preloadThreadSecondaryPanel,
} from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { EmptyStatePanel } from "@omnyo/shared-ui/empty-state";
import { Icon } from "@omnyo/shared-ui/icon";
import { PageShell } from "@/components/ui/page-shell.js";
import { Button } from "@omnyo/shared-ui/button";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { COARSE_POINTER_COMPACT_ICON_SIZE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { usePluginNewThreadPanelActions } from "@/components/plugin/PluginPanelActions";
import { PluginThreadPanelNavigationProvider } from "@/components/plugin/plugin-thread-panel-navigation";
import { usePluginSlots } from "@/lib/plugin-slots";
import { useHomeSendSubmission } from "./home-orientation/useHomeSendSubmission";
import { RootComposeStartingChats } from "./RootComposeStartingChats";
import {
  HomeGreeting,
  HomeStatusCards,
} from "./home-orientation/HomeOrientation";
import {
  HOME_COMPOSER_PANEL_CLASS,
  HOME_PROJECT_SHELF_CLASS,
  HOME_STAGE_BOTTOM_AREA_CLASS,
  HOME_STAGE_TOP_SPACER_CLASS,
  HOME_STAGE_WIDTH_CLASS,
} from "./home-orientation/home-stage";
import {
  useEnvironmentTerminals,
  useTerminals,
} from "@/hooks/queries/thread-terminal-queries";
import { usePanelBrowser } from "@/components/secondary-panel/usePanelBrowser";
import { usePanelPluginPanels } from "@/components/secondary-panel/usePanelPluginPanels";
import { usePanelFiles } from "@/components/secondary-panel/usePanelFiles";
import { usePanelTerminals } from "@/components/secondary-panel/usePanelTerminals";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import {
  requestComposerFocus,
  subscribeComposerFocusRequests,
} from "@/lib/composer-focus-requests";
import {
  AttachmentOpenerContext,
  type OpenAttachmentRequest,
} from "@/components/secondary-panel/AttachmentOpenerContext";
import { PluginComposerHostProvider } from "@/components/plugin/plugin-composer-host";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useQuickCreateProjectConfig } from "@/hooks/useQuickCreateProject";
import {
  readInitialPromptFromSearch,
  stripInitialPromptFromSearch,
} from "./root-compose-initial-prompt";
import { RootComposeIncomingPrompt } from "./RootComposeIncomingPrompt";
import {
  getThreadRoutePath,
  getProjectComposeRoutePath,
  getRootComposeRoutePath,
} from "@/lib/route-paths";
import { getBrowserUrlHost } from "@/lib/browser-url";
import { isDesktopBrowserAvailable } from "@/lib/omnyo-desktop";
import {
  useFixedPanelTabsState,
  useFixedPanelTabsStorageMaintenance,
  useTouchFixedPanelTabsState,
  useUpdateFixedPanelTabsState,
} from "@/lib/fixed-panel-tabs";
import type { MarkdownPreviewLinkHandler } from "@/components/ui/markdown-link";
import { UrlOpenRoutingProvider } from "@/lib/url-open-routing";
import {
  AppNavigationHostProvider,
  type AppFixedTabOpenIntent,
} from "@/lib/app-navigation-host";
import { openAppFixedTabFromDestinations } from "@/lib/app-fixed-tab-navigation";
import { useRootComposeProjectId } from "@/lib/root-compose-selection";
import {
  ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS,
  RootComposeSecondaryContent,
} from "./RootComposeSecondaryContent";
import {
  shouldLoadThreadStorageFileList,
  useThreadStorageViewer,
} from "@/components/secondary-panel/useThreadStorageViewer";
import {
  useThreadFileTabs,
  type FileSearchSelection,
} from "@/components/secondary-panel/useThreadFileTabs";
import { isSecondaryFileTab } from "@omnyo/client-core";
import { RightPanelFileTabIcon } from "@/components/secondary-panel/RightPanelFileTabIcon";
import {
  buildTerminalSyncedSecondaryFileTabs,
  syncTerminalTabsInFixedPanelState,
} from "@/components/secondary-panel/terminalPanelTabs";
import {
  getActiveFixedSecondaryTab,
  useSetThreadSecondaryPanelSelection,
} from "./thread-detail/threadSecondaryPanelSelection";
import {
  useThreadSecondaryPanelDrawerVisibility,
  useThreadSecondaryPanelVisibility,
} from "./thread-detail/useThreadSecondaryPanelVisibility";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import {
  useOptionalPaneContext,
  usePaneContext,
} from "./thread-detail/PaneContext";
import {
  PluginDetailPanelContext,
  usePluginDetailPanelState,
} from "@/components/plugin/plugin-detail-navigation";
import { RootComposePanelCommandHandlers } from "./RootComposePanelCommandHandlers";
import {
  ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
  RootComposePanelTabContent,
  type RootComposeTerminalTarget,
} from "./RootComposePanelTabContent";

const ROOT_COMPOSE_STAGE_CONTENT_CLASS = "min-h-full";

const EMPTY_TERMINAL_SESSIONS: readonly TerminalSession[] = [];

function readSectionIdFromLocationState(state: unknown): string | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }

  if (!("sectionId" in state) || typeof state.sectionId !== "string") {
    return null;
  }

  const sectionId = state.sectionId.trim();

  return sectionId.length > 0 ? sectionId : null;
}

type RootComposeSectionTarget =
  | { kind: "clear" }
  | { sectionId: string; kind: "set" };

export function readRootComposeSectionTargetFromLocationState(
  state: unknown,
): RootComposeSectionTarget | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }

  if ("sectionId" in state) {
    const sectionId = readSectionIdFromLocationState(state);

    return sectionId ? { sectionId, kind: "set" } : { kind: "clear" };
  }

  if ("focusPrompt" in state && state.focusPrompt === true) {
    return { kind: "clear" };
  }

  return null;
}

export function shouldStartComposingFromLocationState(state: unknown): boolean {
  if (typeof state !== "object" || state === null) {
    return false;
  }

  return "focusPrompt" in state && state.focusPrompt === true;
}

interface CanCreateRootComposeTerminalArgs {
  connectedHostIds: ReadonlySet<string>;
  environmentHostId: string | null | undefined;
  terminalTarget: RootComposeTerminalTarget | null;
  environmentStatus: EnvironmentStatus | undefined;
}

interface BuildRootComposeTerminalSessionsArgs {
  environmentTerminalSessions: readonly TerminalSession[] | undefined;
  globalTerminalSessions: readonly TerminalSession[] | undefined;
  terminalTarget: RootComposeTerminalTarget | null;
}

interface RootComposeRightPanelToggleProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function RootComposeRightPanelToggle({
  isOpen,
  onToggle,
}: RootComposeRightPanelToggleProps) {
  const shortcut = useAppCommandShortcut("panel.toggle");
  const rightPanelLabel = isOpen ? "Hide right panel" : "Show right panel";
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={`${HEADER_ICON_BUTTON_CLASS} relative`}
      {...appCommandTarget("panel.toggle")}
      aria-label={
        shortcut ? `${rightPanelLabel} (${shortcut.label})` : rightPanelLabel
      }
      aria-keyshortcuts={shortcut?.ariaKeyshortcuts}
      aria-expanded={isOpen}
      onPointerEnter={preloadThreadSecondaryPanel}
      onFocus={preloadThreadSecondaryPanel}
      onPointerDown={preloadThreadSecondaryPanel}
      onClick={onToggle}
    >
      <Icon name={rightPanelIconName} />
      <AppCommandShortcutHint
        shortcut={shortcut}
        className="absolute right-full mr-1"
      />
    </Button>
  );
}

function readReuseEnvironmentIdFromLocationState(
  state: unknown,
): string | null {
  if (!state || typeof state !== "object") return null;

  const candidate = (state as { reuseEnvironmentId?: unknown })
    .reuseEnvironmentId;

  if (typeof candidate === "string" && candidate.length > 0) return candidate;

  return null;
}

export function readNewEnvironmentHostIdFromLocationState(
  state: unknown,
): string | null {
  if (typeof state !== "object" || state === null) return null;

  if (!("newEnvironmentHostId" in state)) return null;
  const hostId = state.newEnvironmentHostId;

  return typeof hostId === "string" && hostId.trim().length > 0
    ? hostId.trim()
    : null;
}

export function readRootComposeEnvironmentTargetFromLocationState(
  state: unknown,
):
  | { kind: "reuse"; environmentId: string }
  | { kind: "host"; hostId: string }
  | null {
  const environmentId = readReuseEnvironmentIdFromLocationState(state);

  if (environmentId !== null) return { kind: "reuse", environmentId };
  const hostId = readNewEnvironmentHostIdFromLocationState(state);

  return hostId === null ? null : { kind: "host", hostId };
}

export function hasSingleUseRootComposeTargetState(state: unknown): boolean {
  return (
    readThreadCreationPlacement(state) !== null ||
    readRootComposeSectionTargetFromLocationState(state) !== null ||
    readRootComposeEnvironmentTargetFromLocationState(state) !== null
  );
}

export function readInitialPromptFromLocationState(
  state: unknown,
): string | null {
  if (!state || typeof state !== "object") return null;
  const candidate = (state as { initialPrompt?: unknown }).initialPrompt;

  if (typeof candidate === "string" && candidate.length > 0) return candidate;

  return null;
}

export function shouldReplaceInitialPromptFromLocationState(
  state: unknown,
): boolean {
  return (
    state !== null &&
    typeof state === "object" &&
    "replaceInitialPrompt" in state &&
    state.replaceInitialPrompt === true
  );
}

export function canCreateRootComposeTerminal({
  connectedHostIds,
  environmentHostId,
  terminalTarget,
  environmentStatus,
}: CanCreateRootComposeTerminalArgs): boolean {
  if (terminalTarget === null) {
    return false;
  }

  if (terminalTarget.kind === "environment") {
    return (
      environmentStatus === "ready" &&
      environmentHostId !== null &&
      environmentHostId !== undefined &&
      connectedHostIds.has(environmentHostId)
    );
  }

  return connectedHostIds.has(terminalTarget.hostId);
}

export function isRootComposeTerminalSession(
  session: TerminalSession,
  terminalTarget: RootComposeTerminalTarget,
): boolean {
  if (session.threadId !== null) return false;

  if (terminalTarget.kind === "environment") {
    return session.environmentId === terminalTarget.environmentId;
  }

  return (
    session.environmentId === null &&
    session.hostId === terminalTarget.hostId &&
    (terminalTarget.cwd === null || session.initialCwd === terminalTarget.cwd)
  );
}

export function buildRootComposeTerminalSessions({
  environmentTerminalSessions,
  globalTerminalSessions,
  terminalTarget,
}: BuildRootComposeTerminalSessionsArgs):
  | readonly TerminalSession[]
  | undefined {
  if (terminalTarget?.kind === "environment") {
    return environmentTerminalSessions;
  }

  if (terminalTarget?.kind === "host_path") {
    return globalTerminalSessions?.filter((session) =>
      isRootComposeTerminalSession(session, terminalTarget),
    );
  }

  return undefined;
}

export function RootComposeView() {
  const [rootComposeProjectId, setRootComposeProjectId] =
    useRootComposeProjectId();

  const { navigateInPane, isFocused, paneId } = usePaneContext();

  const { handleSubmit, sendSourceRef } = useHomeSendSubmission({
    projectId: rootComposeProjectId,
    isActiveSurface: isFocused,
    paneId,
    navigateInPane,
  });

  return (
    <NewThreadComposer
      projectId={rootComposeProjectId}
      onProjectChange={setRootComposeProjectId}
      draftStorage={{ kind: "new-thread" }}
      selectionScope="new-thread"
      preferReadyProviderWhenUnset
      onSubmit={handleSubmit}
    >
      {(composer) => (
        <RootComposeSurface
          composer={composer}
          rootComposeProjectId={rootComposeProjectId}
          setRootComposeProjectId={setRootComposeProjectId}
          sendSourceRef={sendSourceRef}
        />
      )}
    </NewThreadComposer>
  );
}

interface RootComposeSurfaceProps {
  composer: NewThreadComposerState;
  rootComposeProjectId: string;
  setRootComposeProjectId: (projectId: string) => void;
  sendSourceRef: RefObject<HTMLDivElement | null>;
}

function RootComposeSurface({
  composer,
  rootComposeProjectId,
  setRootComposeProjectId,
  sendSourceRef,
}: RootComposeSurfaceProps) {
  const paneContext = useOptionalPaneContext();
  const isFocusedPane = paneContext?.isFocused ?? true;
  const location = useLocation();
  const navigate = useNavigate();
  const [, setPlacement] = useRootComposePlacement();
  const isPointerCoarse = usePointerCoarse();
  const createProject = useQuickCreateProjectConfig("show-new-chat");
  const [projectShelf, setProjectShelf] = useState<HTMLDivElement | null>(null);

  const {
    projectId,
    isProjectless,
    projects,
    sidebarNavigationError,
    currentProject,
    projectSources,
    connectedHostIds,
    primaryHostId,
    parsedEnvironment,
    projectHostId: rootProjectHostId,
    panelThreadId: rootPanelThreadId,
    selectedProviderId,
    promptDraft,
    focusPromptBox,
    pluginComposerHost: sharedPluginComposerHost,
    textEffects: promptTextEffects,
    seedEnvironmentSelectionValue,
    hostSelectionReady,
    selectHostForNewEnvironment,
    setEnvironmentSelectionValue,
    renderPromptBox,
  } = composer;

  const rootPanelEnvironmentId =
    parsedEnvironment?.type === "reuse"
      ? parsedEnvironment.environmentId
      : null;

  const pluginComposerHost = useMemo(
    () => ({
      ...sharedPluginComposerHost,
      focus: () => requestComposerFocus(promptDraft.storageKey),
    }),
    [promptDraft.storageKey, sharedPluginComposerHost],
  );

  useEffect(() => {
    if (projectId === rootComposeProjectId) return;
    setRootComposeProjectId(projectId);
  }, [projectId, rootComposeProjectId, setRootComposeProjectId]);
  useEffect(
    () =>
      subscribeComposerFocusRequests(promptDraft.storageKey, () => {
        window.requestAnimationFrame(focusPromptBox);
      }),
    [focusPromptBox, promptDraft.storageKey],
  );

  const composerActions = useMemo(
    () => createCoreComposerActions(pluginComposerHost),
    [pluginComposerHost],
  );

  const handleRootPanelSelectionAddToChat = useCallback(
    (text: string, attachments?: readonly ComposerAttachment[]) => {
      composerActions.replace((current) =>
        appendQuoteAndAttachmentsToDraft(current, text, attachments ?? []),
      );
      composerActions.focus();
    },
    [composerActions],
  );

  const searchInitialPrompt = readInitialPromptFromSearch(location.search);
  const stateInitialPrompt = readInitialPromptFromLocationState(location.state);
  const searchInitialDraft = useInitialPromptDraft(searchInitialPrompt);
  const stateInitialDraft = useInitialPromptDraft(stateInitialPrompt);
  const setPromptDraft = composerActions.restoreDraft;
  const restorePromptDraftIfEmpty = promptDraft.restoreIfEmpty;

  const dismissSearchInitialPrompt = useCallback(() => {
    navigate(
      getRootComposeRoutePath() + stripInitialPromptFromSearch(location.search),
      { replace: true, state: location.state },
    );
  }, [location.search, location.state, navigate]);

  const applySearchInitialPrompt = useCallback(
    (draft: PromptDraftState) => {
      const incoming = composerDraftFromPromptDraft(draft);
      composerActions.replace((current) =>
        appendComposerDraft(current, incoming, true),
      );
      dismissSearchInitialPrompt();

      if (!isPointerCoarse) window.requestAnimationFrame(focusPromptBox);
    },
    [
      composerActions,
      dismissSearchInitialPrompt,
      focusPromptBox,
      isPointerCoarse,
    ],
  );

  const incomingPromptCard =
    searchInitialPrompt === null || searchInitialDraft === undefined ? null : (
      <RootComposeIncomingPrompt
        text={searchInitialDraft.text}
        onUse={() => applySearchInitialPrompt(searchInitialDraft)}
        onDismiss={dismissSearchInitialPrompt}
      />
    );

  useEffect(() => {
    if (stateInitialPrompt !== null && stateInitialDraft === undefined) return;

    const sectionTarget = readRootComposeSectionTargetFromLocationState(
      location.state,
    );

    const environmentTarget = readRootComposeEnvironmentTargetFromLocationState(
      location.state,
    );

    if (!hasSingleUseRootComposeTargetState(location.state)) return;

    if (environmentTarget?.kind === "host" && !hostSelectionReady) {
      return;
    }

    const targetPlacement = readThreadCreationPlacement(location.state);

    if (targetPlacement !== null) {
      setPlacement(targetPlacement);
    } else if (sectionTarget !== null || environmentTarget !== null) {
      setPlacement({
        sectionId:
          sectionTarget?.kind === "set" ? sectionTarget.sectionId : null,
        pinned: false,
      });
    }

    if (environmentTarget?.kind === "reuse") {
      seedEnvironmentSelectionValue(
        encodeReuseValue(environmentTarget.environmentId),
      );
    } else if (environmentTarget?.kind === "host") {
      selectHostForNewEnvironment(environmentTarget.hostId);
    }

    if (shouldStartComposingFromLocationState(location.state)) {
      window.requestAnimationFrame(focusPromptBox);
    }

    navigate(getRootComposeRoutePath() + location.search, {
      replace: true,
      state: null,
    });
  }, [
    focusPromptBox,
    location.search,
    location.state,
    hostSelectionReady,
    navigate,
    seedEnvironmentSelectionValue,
    selectHostForNewEnvironment,
    setPlacement,
    stateInitialPrompt,
    stateInitialDraft,
  ]);
  useEffect(() => {
    const initialPrompt = readInitialPromptFromLocationState(location.state);

    if (initialPrompt === null || stateInitialDraft === undefined) return;
    const nextDraft = stateInitialDraft;

    if (shouldReplaceInitialPromptFromLocationState(location.state)) {
      setPromptDraft(nextDraft);
    } else {
      restorePromptDraftIfEmpty(nextDraft);
    }

    navigate(getRootComposeRoutePath() + location.search, {
      replace: true,
      state: { focusPrompt: true },
    });
  }, [
    location.search,
    location.state,
    navigate,
    restorePromptDraftIfEmpty,
    setPromptDraft,
    stateInitialDraft,
  ]);

  const shouldFocusPrompt =
    typeof location.state === "object" &&
    location.state !== null &&
    "focusPrompt" in location.state &&
    location.state.focusPrompt === true;

  useEffect(() => {
    if (!shouldFocusPrompt || isPointerCoarse) return;
    const handle = window.requestAnimationFrame(focusPromptBox);

    return () => window.cancelAnimationFrame(handle);
  }, [focusPromptBox, isPointerCoarse, location.key, shouldFocusPrompt]);

  const providerCliGate = useProviderCliGate({
    hostId: rootProjectHostId,
    providerId: selectedProviderId,
  });

  useFixedPanelTabsStorageMaintenance();

  const fixedPanelTabsState = useFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );

  const isPersistedSecondaryPanelOpen = fixedPanelTabsState.secondary.isOpen;

  const activeFixedSecondaryTab = getActiveFixedSecondaryTab({
    fixedPanelTabsState,
  });

  const activeFixedSecondaryTabId = activeFixedSecondaryTab?.id ?? null;
  const isCompactViewport = useIsCompactViewport();

  const secondaryPanelDrawerVisibility =
    useThreadSecondaryPanelDrawerVisibility({
      isCompactViewport,
      threadId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    });

  const isWorkspacePanelOpen = isCompactViewport
    ? secondaryPanelDrawerVisibility.isDrawerVisible
    : isPersistedSecondaryPanelOpen;

  const pluginDetails = usePluginDetailPanelState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    isFocusedPane,
    getPanelTabHistoryKey({
      panelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
      environmentId: rootPanelEnvironmentId,
      fileOwnerThreadId: rootPanelThreadId,
      projectHostId: rootProjectHostId,
      projectId: isProjectless ? null : projectId,
    }),
  );

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
    isFocused: isFocusedPane,
  });

  const touchFixedPanelTabsState = useTouchFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );

  const updateFixedPanelTabsState = useUpdateFixedPanelTabsState(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );

  const setRootSecondaryPanel = useSetThreadSecondaryPanelSelection(
    ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    null,
  );

  const rootPanelEnvironmentQuery = useEnvironment(rootPanelEnvironmentId, {
    enabled: rootPanelEnvironmentId !== null,
    staleTime: 5_000,
  });

  const rootPanelEnvironment = rootPanelEnvironmentQuery.data;

  const rootPanelHostPathTerminalTarget =
    useMemo<RootComposeTerminalTarget | null>(() => {
      if (rootPanelEnvironmentId !== null) {
        return null;
      }

      const selectedHostId = rootProjectHostId;

      if (selectedHostId === null) {
        return null;
      }

      const source =
        findLocalPathProjectSourceForHost(projectSources, selectedHostId) ??
        projectSources.find((projectSource) => projectSource.isDefault) ??
        null;

      if (!source) {
        return {
          kind: "host_path",
          hostId: selectedHostId,
          cwd: null,
        };
      }

      return {
        kind: "host_path",
        hostId: source.hostId,
        cwd: source.path,
      };
    }, [projectSources, rootPanelEnvironmentId, rootProjectHostId]);

  const rootPanelTerminalTarget = useMemo<RootComposeTerminalTarget | null>(
    () =>
      rootPanelEnvironmentId !== null
        ? { kind: "environment", environmentId: rootPanelEnvironmentId }
        : rootPanelHostPathTerminalTarget,
    [rootPanelEnvironmentId, rootPanelHostPathTerminalTarget],
  );

  const { threadStorageFiles: rootThreadStorageFiles } = useThreadStorageViewer(
    {
      fileListEnabled: shouldLoadThreadStorageFileList({
        hasThread: rootPanelThreadId !== null,
        isSecondaryPanelOpen,
        secondaryTabs: fixedPanelTabsState.secondary.tabs,
      }),
      threadId: rootPanelThreadId ?? undefined,
    },
  );

  const environmentTerminalsListQuery = useEnvironmentTerminals(
    rootPanelEnvironmentId ?? "",
    {
      enabled:
        isSecondaryPanelOpen && rootPanelTerminalTarget?.kind === "environment",
    },
  );

  const globalTerminalsListQuery = useTerminals(
    rootPanelTerminalTarget?.kind === "host_path"
      ? {
          kind: "host_path",
          hostId: rootPanelTerminalTarget.hostId,
          ...(rootPanelTerminalTarget.cwd === null
            ? {}
            : { cwd: rootPanelTerminalTarget.cwd }),
        }
      : null,
    {
      enabled:
        isSecondaryPanelOpen && rootPanelTerminalTarget?.kind === "host_path",
    },
  );

  const loadedTerminalSessions = useMemo(
    () =>
      buildRootComposeTerminalSessions({
        environmentTerminalSessions:
          environmentTerminalsListQuery.data?.sessions,
        globalTerminalSessions: globalTerminalsListQuery.data?.sessions,
        terminalTarget: rootPanelTerminalTarget,
      }),
    [
      environmentTerminalsListQuery.data?.sessions,
      globalTerminalsListQuery.data?.sessions,
      rootPanelTerminalTarget,
    ],
  );

  const terminalSessions = loadedTerminalSessions ?? EMPTY_TERMINAL_SESSIONS;
  const terminalsListLoaded = loadedTerminalSessions !== undefined;

  const terminalsById = useMemo(
    () => new Map(terminalSessions.map((session) => [session.id, session])),
    [terminalSessions],
  );

  const [shouldAutoFocusNewTab, setShouldAutoFocusNewTab] = useState(false);

  const handleNewTabAutoFocusHandled = useCallback(
    () => setShouldAutoFocusNewTab(false),
    [],
  );

  const { newThreadPanelActions: rootPanelNewThreadPanelActions } =
    usePluginSlots();

  const {
    browserTabs,
    activateTab,
    closeTab,
    openPluginPanel,
    openTab,
    orderedSecondaryFileTabs,
    reopenClosedTab,
    reorderTab,
    selectFileSearchResult,
    updateBrowserTab,
  } = useThreadFileTabs({
    panelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    syncThreadId: null,
    environmentId: rootPanelEnvironmentId,
    fileOwnerThreadId: rootPanelThreadId,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
    preserveWorkspaceTabsAcrossContexts: true,
    projectHostId: rootProjectHostId,
    projectId: isProjectless ? null : projectId,
    storageFiles: rootThreadStorageFiles,
    terminalSessions: loadedTerminalSessions,
  });

  const panelBrowser = usePanelBrowser({
    available: isDesktopBrowserAvailable() && rootPanelThreadId !== null,
    browserTabs,
    isFocused: isFocusedPane,
    openTab,
    reveal: secondaryPanelDrawerVisibility.openDrawer,
  });

  const openBrowser = panelBrowser.open;
  const openBrowserUrl = panelBrowser.openUrl;

  const rootPluginPanelActions = usePluginNewThreadPanelActions({
    openPluginPanel,
    projectId: isProjectless ? null : projectId,
  });

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
    if (!terminalsListLoaded) {
      return;
    }

    updateFixedPanelTabsState((state) =>
      syncTerminalTabsInFixedPanelState({
        state,
        terminalSessions,
      }),
    );
  }, [terminalSessions, terminalsListLoaded, updateFixedPanelTabsState]);

  const canCreateRootTerminal = canCreateRootComposeTerminal({
    connectedHostIds,
    environmentHostId: rootPanelEnvironment?.hostId,
    terminalTarget: rootPanelTerminalTarget,
    environmentStatus: rootPanelEnvironment?.status,
  });

  const panelFiles = usePanelFiles({
    available: true,
    openTab,
    reveal: secondaryPanelDrawerVisibility.openDrawer,
    scope: {
      threadId: rootPanelThreadId,
      environmentId: rootPanelEnvironmentId,
      hostId: rootPanelEnvironment?.hostId ?? null,
    },
  });

  const openLiveFilePreview = panelFiles.openFilePreview;

  const closeRootSecondaryPanel = useCallback(() => {
    setRootSecondaryPanel(null);
  }, [setRootSecondaryPanel]);

  const toggleRootPersistedSecondaryPanel = useCallback(() => {
    if (isPersistedSecondaryPanelOpen) {
      closeRootSecondaryPanel();

      return;
    }

    openTab({ kind: "new-tab" });
  }, [closeRootSecondaryPanel, isPersistedSecondaryPanelOpen, openTab]);

  const {
    closePanel: closeWorkspacePanel,
    openCompactDrawer,
    openWorkspaceFile,
  } = useThreadSecondaryPanelVisibility({
    closePersistedPanel: closeRootSecondaryPanel,
    drawerVisibility: secondaryPanelDrawerVisibility,
    isCompactViewport,
    isPersistedOpen: isPersistedSecondaryPanelOpen,
    openPersistedCommitDiff: () => undefined,
    openPersistedDiffFile: () => undefined,
    openPersistedDiffPanel: () => undefined,
    openPersistedHostFile: panelFiles.openHostFile,
    openPersistedPanel: setRootSecondaryPanel,
    openPersistedStorageFile: panelFiles.openStorageFile,
    openPersistedWorkspaceFile: panelFiles.openWorkspaceFile,
    togglePersistedPanel: toggleRootPersistedSecondaryPanel,
  });

  const dismissPluginDetails = pluginDetails.dismiss;

  const handleOpenPluginPanel = usePanelPluginPanels({
    actions: rootPanelNewThreadPanelActions,
    isFocused: isFocusedPane,
    openPluginPanel,
    reveal: openCompactDrawer,
    slot: "experimental_newThreadPanelAction",
  });

  const closeSecondaryPanel = useCallback(() => {
    dismissPluginDetails();
    closeWorkspacePanel();
  }, [dismissPluginDetails, closeWorkspacePanel]);

  const openAttachment = useCallback(
    (attachment: OpenAttachmentRequest) => {
      openTab({ kind: "attachment-file-preview", ...attachment });
      openCompactDrawer();
    },
    [openCompactDrawer, openTab],
  );

  const resolveMentionLink = useCallback<PromptMentionLinkResolver>(
    (resource) => {
      if (resource.kind === "thread") {
        return () =>
          navigate(
            getThreadRoutePath({
              projectId: resource.projectId ?? projectId,
              threadId: resource.threadId,
            }),
          );
      }

      if (resource.kind === "project") {
        return () => navigate(getProjectComposeRoutePath(resource.projectId));
      }

      if (resource.kind !== "path" || resource.entryKind !== "file") {
        return null;
      }

      if (resource.source === "thread-storage") {
        if (rootPanelThreadId === null) {
          return null;
        }

        return () => {
          openLiveFilePreview({
            target: {
              kind: "thread-storage",
              threadId: rootPanelThreadId,
              path: resource.path,
            },
            location: null,
          });
        };
      }

      if (isProjectless) {
        return null;
      }

      if (rootPanelEnvironmentId === null) return null;

      return () => {
        openLiveFilePreview({
          target: {
            kind: "workspace",
            environmentId: rootPanelEnvironmentId,
            path: resource.path,
          },
          location: null,
        });
      };
    },
    [
      isProjectless,
      openLiveFilePreview,
      navigate,
      projectId,
      rootPanelEnvironmentId,
      rootPanelThreadId,
    ],
  );

  const renderBrowserDeck = useCallback(
    ({
      activeBrowserTabId,
      canHandleBrowserCommands,
      canShowNativeBrowserView,
      onNativeFocus,
    }: {
      activeBrowserTabId: string | null;
      canHandleBrowserCommands: boolean;
      canShowNativeBrowserView: boolean;
      onNativeFocus: () => void;
    }) => {
      if (rootPanelThreadId === null) {
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
          environmentId={rootPanelEnvironmentId}
          canShowNativeBrowserView={canShowNativeBrowserView}
          canHandleBrowserCommands={canHandleBrowserCommands}
          onNativeFocus={onNativeFocus}
          threadId={rootPanelThreadId}
          onUpdate={updateBrowserTab}
        />
      );
    },
    [
      panelBrowser.addressFocusRequest,
      browserTabs,
      panelBrowser.handleAddressFocusRequestConsumed,
      rootPanelEnvironmentId,
      rootPanelThreadId,
      updateBrowserTab,
    ],
  );

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

  const handleOpenNewTab = useCallback(() => {
    openTab({ kind: "new-tab" });
    openCompactDrawer();
    setShouldAutoFocusNewTab(true);
  }, [openCompactDrawer, openTab]);

  useAppCommandHandler("panel.newTab", () => {
    if (!isFocusedPane) return false;
    handleOpenNewTab();

    return true;
  });
  useAppCommandHandler("panel.reopenClosedTab", () => {
    if (!isFocusedPane || !reopenClosedTab(pluginDetails)) return false;
    openCompactDrawer();

    return true;
  });
  useAppCommandHandler("file.quickOpen", () => {
    if (!isFocusedPane) return false;
    handleOpenNewTab();

    return true;
  });

  const handleToggleSecondaryPanel = useCallback(() => {
    if (isSecondaryPanelOpen) {
      closeSecondaryPanel();

      return;
    }

    handleOpenNewTab();
  }, [closeSecondaryPanel, handleOpenNewTab, isSecondaryPanelOpen]);

  const acceptsRootTerminal = useCallback(
    (session: TerminalSession) =>
      rootPanelTerminalTarget !== null &&
      isRootComposeTerminalSession(session, rootPanelTerminalTarget),
    [rootPanelTerminalTarget],
  );

  const terminals = usePanelTerminals({
    panelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
    syncThreadId: null,
    createTarget: canCreateRootTerminal ? rootPanelTerminalTarget : null,
    isFocused: isFocusedPane,
    acceptsSession: acceptsRootTerminal,
    tabsCarryTarget: false,
    reveal: openCompactDrawer,
    onCloseLastTab: secondaryPanelDrawerVisibility.closeDrawer,
  });

  const appNavigationCapabilities = useMemo(
    () => ({
      openFilePreview: openLiveFilePreview,
      openFixedTab: (intent: AppFixedTabOpenIntent) =>
        openAppFixedTabFromDestinations([], intent),
      openTerminal: terminals.open,
    }),
    [openLiveFilePreview, terminals.open],
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

  const handleOpenPanelLink = useCallback<MarkdownPreviewLinkHandler>(
    ({ href }) => openBrowserUrl(href),
    [openBrowserUrl],
  );

  const renderRootPanelTabContent = useCallback(
    (
      tab: (typeof syncedOrderedSecondaryFileTabs)[number],
      pane: SecondaryPanelPaneRenderContext,
    ) => (
      <RootComposePanelTabContent
        activeTabId={activeFixedSecondaryTabId}
        canCreateTerminal={canCreateRootTerminal}
        currentProjectId={projectId}
        isPanelOpen={isSecondaryPanelOpen}
        isPanelPersistedOpen={isPersistedSecondaryPanelOpen}
        isProjectless={isProjectless}
        onActivateTab={activateTab}
        onAutoFocusNewTabHandled={handleNewTabAutoFocusHandled}
        onAutoFocusTerminalHandled={terminals.handleAutoFocusHandled}
        onOpenBrowser={openBrowser}
        onOpenPanelLink={handleOpenPanelLink}
        onSelectFileSearchResult={handleSelectFileSearchResult}
        onSelectionAddToChat={handleRootPanelSelectionAddToChat}
        onStartTerminal={terminals.start}
        pane={pane}
        primaryHostId={primaryHostId}
        pluginActions={rootPluginPanelActions}
        projectSources={projectSources}
        projects={projects}
        rootPanelEnvironmentId={rootPanelEnvironmentId}
        rootPanelThreadId={rootPanelThreadId}
        rootProjectHostId={rootProjectHostId}
        shouldAutoFocusNewTab={shouldAutoFocusNewTab}
        autoFocusTerminalId={terminals.autoFocusTerminalId}
        tab={tab}
        terminalTarget={rootPanelTerminalTarget}
      />
    ),
    [
      activateTab,
      activeFixedSecondaryTabId,
      canCreateRootTerminal,
      handleNewTabAutoFocusHandled,
      handleOpenPanelLink,
      handleRootPanelSelectionAddToChat,
      handleSelectFileSearchResult,
      isPersistedSecondaryPanelOpen,
      isProjectless,
      isSecondaryPanelOpen,
      openBrowser,
      projectId,
      primaryHostId,
      projectSources,
      projects,
      rootPanelEnvironmentId,
      rootPanelThreadId,
      rootPanelTerminalTarget,
      rootPluginPanelActions,
      rootProjectHostId,
      shouldAutoFocusNewTab,
      terminals.autoFocusTerminalId,
      terminals.handleAutoFocusHandled,
      terminals.start,
    ],
  );

  const panelTabs = useMemo<readonly SecondaryPanelRenderableTab[]>(() => {
    const filenameOf = (path: string) => path.split("/").at(-1) ?? path;

    const tabs = syncedOrderedSecondaryFileTabs.map(
      (tab): SecondaryPanelRenderableTab => {
        const pluginAction =
          tab.kind === "plugin-panel"
            ? rootPanelNewThreadPanelActions.find(
                (action) =>
                  action.pluginId === tab.pluginId &&
                  action.id === tab.actionId,
              )
            : undefined;

        const shared = {
          contentFillsRegion:
            tab.kind === "plugin-panel" &&
            (tab.fileOpenerOwner !== undefined ||
              pluginAction?.layout === "flush"),
          onClose: () => closeTab(tab.id),
          renderContent: (pane: SecondaryPanelPaneRenderContext) =>
            renderRootPanelTabContent(tab, pane),
          tab,
        };

        switch (tab.kind) {
          case "browser": {
            const browserLabel =
              tab.title ??
              (tab.url.length > 0 ? getBrowserUrlHost(tab.url) : "");

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
              label: filenameOf(tab.path),
              leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
              statusLabel: tab.statusLabel,
              onSelect: () => handleActivateFileTab(tab.id),
            };
          case "host-file-preview":
            return {
              ...shared,
              label: filenameOf(tab.path),
              leadingVisual: <RightPanelFileTabIcon path={tab.path} />,
              statusLabel: null,
              onSelect: () => handleActivateFileTab(tab.id),
            };
          case "thread-storage-file-preview":
            return {
              ...shared,
              label: filenameOf(tab.path),
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
      },
    );

    return tabs;
  }, [
    closeTab,
    handleActivateFileTab,
    renderRootPanelTabContent,
    rootPanelNewThreadPanelActions,
    syncedOrderedSecondaryFileTabs,
    terminals,
    terminalsById,
  ]);

  const rootPanelMetadataContent = useMemo(
    () => (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pt-1">
        <EmptyStatePanel className="rounded-lg">
          No thread details available.
        </EmptyStatePanel>
      </div>
    ),
    [],
  );

  const handleOpenFilePreview = useCallback(
    (relativePath: string) => {
      openWorkspaceFile({
        lineRange: null,
        path: relativePath,
        source: { kind: "working-tree" },
        statusLabel: null,
      });
    },
    [openWorkspaceFile],
  );

  const titleBarHostsRightPanelToggle =
    useWindowTitleBarHostsRightPanelToggle();

  const showPinnedToggle =
    !titleBarHostsRightPanelToggle &&
    (paneContext?.secondaryPanelHost ?? null) === null &&
    (!isSecondaryPanelOpen || isCompactViewport);

  const rootPanelToggle = showPinnedToggle ? (
    <div
      className={`fixed z-40 mt-(--omnyo-window-frame-top) mr-(--omnyo-window-frame-lip) ${ROOT_COMPOSE_PINNED_PANEL_TOGGLE_POSITION_CLASS} ${
        isSecondaryPanelOpen ? "pointer-events-none invisible" : ""
      }`}
    >
      <RootComposeRightPanelToggle
        isOpen={isSecondaryPanelOpen}
        onToggle={handleToggleSecondaryPanel}
      />
    </div>
  ) : null;

  const machineSetup = useProjectMachineSetup({
    projectId,
    currentProject,
    parsedEnvironment,
    setEnvironmentSelectionValue,
  });

  if (!projects && sidebarNavigationError) {
    return (
      <PageShell contentClassName="min-h-full items-center justify-center">
        <p className="py-12 text-center text-sm text-destructive">
          Failed to load projects.
        </p>
      </PageShell>
    );
  }

  const renderedPromptBox = renderPromptBox({
    id: "root-compose-prompt",
    autoFocus: providerCliGate.blockedReason === undefined,
    mentionMenuPlacement: isCompactViewport ? "top" : "bottom",
    banner: providerCliGate.banner,
    blockedReason: providerCliGate.blockedReason,
    resolveMentionLink,
    pluginComposerHost,
    textEffects: promptTextEffects,
    allowNoProject: true,
    createProject,
    onRequestMachineSetup: machineSetup.request,
    selectionLayout: isCompactViewport ? "footer" : "stage",
    projectShelf,
  });

  const promptBox = isCompactViewport ? (
    <>
      <RootComposeStartingChats projectId={projectId} />
      {incomingPromptCard}
      {renderedPromptBox}
    </>
  ) : (
    <div data-home-stage="" className="flex flex-1 flex-col">
      <div aria-hidden="true" className={HOME_STAGE_TOP_SPACER_CLASS} />
      <div
        className={`mx-auto flex w-full shrink-0 flex-col ${HOME_STAGE_WIDTH_CLASS}`}
      >
        <HomeGreeting layout="stage" />
        <RootComposeStartingChats projectId={projectId} />
        {incomingPromptCard}
        <div ref={sendSourceRef} className={HOME_COMPOSER_PANEL_CLASS}>
          {renderedPromptBox}
        </div>
        <div
          ref={setProjectShelf}
          data-home-project-shelf=""
          className={HOME_PROJECT_SHELF_CLASS}
        />
      </div>
      <div
        className={`mx-auto w-full ${HOME_STAGE_WIDTH_CLASS} ${HOME_STAGE_BOTTOM_AREA_CLASS}`}
      >
        <HomeStatusCards />
      </div>
    </div>
  );

  return (
    <PluginDetailPanelContext.Provider value={pluginDetails}>
      <RootComposePanelCommandHandlers
        isFocused={isFocusedPane}
        isOpen={isSecondaryPanelOpen}
        onClose={handleCloseWindowRequest}
        onToggle={handleToggleSecondaryPanel}
      />
      {machineSetup.dialog}
      {rootPanelToggle}
      <PluginComposerHostProvider value={pluginComposerHost}>
        <AttachmentOpenerContext.Provider value={openAttachment}>
          <UrlOpenRoutingProvider openInAppBrowser={openBrowser}>
            <AppNavigationHostProvider capabilities={appNavigationCapabilities}>
              <PluginThreadPanelNavigationProvider
                openThreadPanel={handleOpenPluginPanel}
              >
                <RootComposeSecondaryContent
                  contentClassName={ROOT_COMPOSE_STAGE_CONTENT_CLASS}
                  isCompactHomeLayout={isCompactViewport}
                  compactHomeIntro={<HomeGreeting layout="compact" />}
                  isSecondaryPanelOpen={isSecondaryPanelOpen}
                  onToggleSecondaryPanel={handleToggleSecondaryPanel}
                  secondaryPanel={{
                    activeTab: activeFixedSecondaryTab,
                    canUseGitUi: false,
                    environmentId: rootPanelEnvironmentId ?? undefined,
                    metadataContent: rootPanelMetadataContent,
                    workspaceRootPath:
                      rootPanelEnvironment?.path ??
                      (rootPanelTerminalTarget?.kind === "host_path"
                        ? (rootPanelTerminalTarget.cwd ?? undefined)
                        : undefined),
                    tabs: panelTabs,
                    splitPanelStateId: ROOT_COMPOSE_FIXED_PANEL_STATE_ID,
                    renderBrowserDeck,
                    isOpen: isSecondaryPanelOpen,
                    fixedTabs: [],
                    showConversationCollapseControl: false,
                    onClose: closeSecondaryPanel,
                    onCollapse: closeSecondaryPanel,
                    onTabReorder: reorderTab,
                    onOpenNewTab: handleOpenNewTab,
                    onOpenFilePreview: handleOpenFilePreview,
                    onSelectionAddToChat: handleRootPanelSelectionAddToChat,
                    onPanelFocus: touchFixedPanelTabsState,
                  }}
                >
                  {promptBox}
                </RootComposeSecondaryContent>
              </PluginThreadPanelNavigationProvider>
            </AppNavigationHostProvider>
          </UrlOpenRoutingProvider>
        </AttachmentOpenerContext.Provider>
      </PluginComposerHostProvider>
    </PluginDetailPanelContext.Provider>
  );
}

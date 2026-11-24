import { type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { atom, useAtom, useAtomValue, useStore } from "jotai";
import { atomWithStorage } from "jotai/utils";
import {
  Link,
  matchPath,
  Navigate,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type { ProjectResponse } from "@omnyo/server-contract";
import { Icon } from "@omnyo/shared-ui/icon";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { RESOURCE_ROUTE_LABEL_EVENT } from "@omnyo/shared-ui/resource-route-label";
import {
  SidebarProvider,
  SidebarTrigger,
  useIsSidebarFramed,
  useSidebar,
} from "@/components/ui/sidebar.js";
import {
  resolveThreadTitleDisplayText,
  ThreadTitleMentionResourcesProvider,
  useSidebarThreadTitleMentionResources,
} from "@/components/thread/ThreadTitleMentions";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appCommandTarget } from "@/lib/app-command-targets";
import { CommandPalette } from "@/components/commands/CommandPalette";
import { ThreadGroupCommandHandler } from "@/components/commands/ThreadGroupCommandHandler";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import {
  resolveAutomationBreadcrumbs,
  resolvePluginsWorkspaceHeaderMeta,
  resolveSkillsWorkspaceHeaderMeta,
  resolveToolsBreadcrumbs,
} from "@/components/tools/tools-navigation";
import { AppBreadcrumbs } from "./AppBreadcrumbs";
import { resourceRouteLabelAtom } from "./resourceRouteLabelAtom";
import { AppPageHeader, HEADER_ICON_BUTTON_CLASS } from "./AppPageHeader";
import { stripProjectThreads } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";
import { useActiveThreadPreloading } from "@/hooks/useActiveThreadPreloading";
import { useNonArchivedThreads } from "@/hooks/useNonArchivedThreads";
import { useThreadAttentionCache } from "@/hooks/queries/thread-attention";
import {
  didThreadDetailBootstrapRefreshAfterMount,
  useThread,
  useThreadDetailBootstrap,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useRouteState } from "@/hooks/useRouteState";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import {
  COMPACT_SHELF_HIDDEN_FIXED_CHROME_CLASS,
  usePanelShelfState,
} from "@/components/ui/secondary-panel-shelf-visibility";
import { ProjectPathDialog } from "@/components/dialogs/ProjectPathDialog";
import { ProjectActionsMenu } from "@/components/project/ProjectActionsMenu";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { PluginAppOverlays } from "@/components/plugin/PluginAppOverlays";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { usePluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import { createTabScopedStorage } from "@/lib/browser-storage";
import {
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
  CHROME_ROW_CLASS,
  getOmnyoDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
  MACOS_CHROME_CONTROL_AXIS_CLASS,
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS,
  MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS,
  MACOS_WINDOW_DRAG_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldReserveMacosTrafficLights,
  shouldUseMacosDesktopChrome,
} from "@/lib/omnyo-desktop";
import { useDesktopWindowState } from "@/hooks/useDesktopWindowState";
import { useDataDirectoryCommand } from "@/hooks/useDataDirectoryCommand";
import { useWindowReloadCommand } from "@/hooks/useWindowReloadCommand";
import { usePluginSafeModeCommands } from "@/hooks/usePluginSafeModeCommands";
import { usePluginCachePruneCommand } from "@/hooks/usePluginCachePruneCommand";
import { useServerDaemonLogsCommand } from "@/hooks/useServerDaemonLogsCommand";
import {
  APP_ROOT_ROUTE_PATH,
  getLegacyProjectComposeRoutePath,
  getSettingsProjectRoutePath,
  getSettingsRoutePath,
  getRootComposeRoutePath,
  getThreadRoutePath,
  isPluginsRoutePath,
  isProjectlessProjectId,
  isSkillsRoutePath,
  PLUGIN_PANEL_ROUTE_PATH,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { IframeDragGuardOverlay } from "@/lib/iframe-drag-guard";
import { dispatchBrowserViewBoundsSync } from "@/lib/browser-view-bounds-sync";
import { useFaviconBadge } from "@/lib/favicon-color-preference";
import { shouldShowFaviconAttentionDot } from "./faviconAttentionDot";
import { AppShellFrame } from "./AppShellFrame";
import { WindowRightPanelToggle } from "./WindowRightPanelToggle";
import {
  WindowTitleBarSlotsContext,
  type WindowTitleBarSlots,
} from "./window-title-bar-slots";
import { NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH } from "@/components/sidebar/navRailWidth";
import { SidebarHistoryNavigationControls } from "@/components/sidebar/SidebarHistoryNavigationControls";
import { ScopedProjectTitle } from "@/components/sidebar/ScopedProject";
import { TITLE_BAR_SEGMENT_CLASS } from "./title-bar-segment";
import { PluginTitleBarCenter } from "@/components/plugin/PluginTitleBarCenter";
import {
  hasOpenModal,
  useAppCommandHandler,
  useAppCommandShortcut,
  useIsAppCommandModifierHeld,
} from "@/components/commands/AppCommandProvider";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { useMobileVisualViewportHeight } from "./useMobileVisualViewportHeight";
import { isIOSWebKit } from "@/lib/ios-webkit";
import { wsManager } from "@/lib/ws";
import { useOpenThreadInLayout } from "@/views/thread-detail/useOpenThreadInLayout";
import { useDesktopOpenThread } from "@/hooks/useDesktopOpenThread";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { NewChatLauncherOverlay } from "@/components/new-chat-launcher/NewChatLauncherOverlay";
import {
  newChatLauncherAtom,
  openNewChatLauncher,
  resolveNewChatEntry,
} from "@/components/new-chat-launcher/new-chat-launcher";
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import {
  INBOX_SIDEBAR_SCOPE,
  useSetSidebarScope,
  useSidebarScope,
} from "@/components/sidebar/sidebarScope";
import { BackToAppCommandHandler } from "./BackToAppCommandHandler";
import { HistoryCommandHandlers } from "./HistoryCommandHandlers";
import { ActionHistoryProvider } from "./ActionHistoryProvider";
import { ActionHistoryCommandHandlers } from "./ActionHistoryCommandHandlers";
import { usePluginPageSidebar } from "./usePluginPageSidebar";

const SIDEBAR_WIDTH_KEY = "omnyo.sidebar.width";

const SIDEBAR_OPEN_KEY = "omnyo.sidebar.open";

const SIDEBAR_MIN_WIDTH = 240;

const SIDEBAR_MAX_WIDTH = 460;

const SIDEBAR_DEFAULT_WIDTH = 320;

function clampSidebarWidth(value: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

const sidebarWidthStorage = createTabScopedStorage<number>(
  {
    parse: (storedValue, initialValue) => {
      if (storedValue === null) {
        return initialValue;
      }

      const parsedValue = Number(storedValue);

      if (!Number.isFinite(parsedValue)) {
        return initialValue;
      }

      return clampSidebarWidth(parsedValue);
    },
    serialize: (value) => String(clampSidebarWidth(value)),
  },
  { persistInitialValue: true },
);

const sidebarWidthAtom = atomWithStorage<number>(
  SIDEBAR_WIDTH_KEY,
  SIDEBAR_DEFAULT_WIDTH,
  sidebarWidthStorage,
  { getOnInit: true },
);

const sidebarLiveWidthAtom = atom<number | null>(null);

const sidebarOpenStorage = createTabScopedStorage<boolean>(
  {
    parse: (storedValue, initialValue) => {
      if (storedValue === "true") return true;

      if (storedValue === "false") return false;

      return initialValue;
    },
    serialize: (value) => String(value),
  },
  { persistInitialValue: true },
);

const sidebarOpenAtom = atomWithStorage<boolean>(
  SIDEBAR_OPEN_KEY,
  true,
  sidebarOpenStorage,
  { getOnInit: true },
);

interface SidebarStateBridgeProps {
  framed: boolean;
  usesDesktopChrome: boolean;
  children: ReactNode;
}

const MACOS_TITLE_BAR_HEIGHT_CLASS =
  "[--omnyo-window-title-bar-height:calc(var(--omnyo-macos-traffic-light-axis)*2)]";

type SidebarResizeMouseEvent = ReactMouseEvent<HTMLDivElement>;

type SidebarOpenChangeHandler = (open: boolean) => void;

function SidebarStateBridge({
  framed,
  usesDesktopChrome,
  children,
}: SidebarStateBridgeProps) {
  const [appOpen, setAppOpen] = useAtom(sidebarOpenAtom);
  const [open, setOpen] = usePluginPageSidebar(appOpen, setAppOpen);
  const sidebarWidth = useAtomValue(sidebarWidthAtom);
  const sidebarLiveWidth = useAtomValue(sidebarLiveWidthAtom);
  const isCompactViewport = useIsCompactViewport();
  const { pathname, search, hash } = useLocation();
  const setSidebarScope = useSetSidebarScope();

  const [launchesIntoInbox] = useState(
    () =>
      isCompactViewport &&
      pathname === APP_ROOT_ROUTE_PATH &&
      search === "" &&
      hash === "",
  );

  useLayoutEffect(() => {
    if (launchesIntoInbox) setSidebarScope(INBOX_SIDEBAR_SCOPE);
  }, [launchesIntoInbox, setSidebarScope]);

  const handleOpenChange = useCallback<SidebarOpenChangeHandler>(
    (nextOpen) => {
      setOpen(nextOpen);
      window.requestAnimationFrame(dispatchBrowserViewBoundsSync);
    },
    [setOpen],
  );

  useAppCommandHandler("sidebar.toggle", () => {
    handleOpenChange(!open);

    return true;
  });

  return (
    <SidebarProvider
      width={`${sidebarLiveWidth ?? sidebarWidth}px`}
      collapsedRailWidth={NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH}
      framed={framed}
      className={usesDesktopChrome ? MACOS_TITLE_BAR_HEIGHT_CLASS : undefined}
      data-testid="app-layout-root"
      defaultOpenMobile={launchesIntoInbox}
      open={open}
      onOpenChange={handleOpenChange}
    >
      {children}
    </SidebarProvider>
  );
}

function resetSidebarResizeDocumentState(): void {
  document.body.classList.remove("sidebar-resizing");
}

interface WindowTitleBarSlotSetters {
  setPageTitle: (element: HTMLElement | null) => void;
  setPageActions: (element: HTMLElement | null) => void;
  setCompanionToolbar: (element: HTMLElement | null) => void;
}

interface SidebarTriggerOverlayProps {
  hostsPageChrome: boolean;
  reserveMacosTrafficLights: boolean;
  slotSetters: WindowTitleBarSlotSetters;
  usesDesktopChrome: boolean;
}

function TitleBarShortcutHints({
  sidebarShortcut,
}: {
  sidebarShortcut: ReturnType<typeof useAppCommandShortcut>;
}) {
  const back = useAppCommandShortcut("history.back");
  const forward = useAppCommandShortcut("history.forward");

  return (
    <span
      data-title-bar-shortcut-hints=""
      className="pointer-events-none absolute left-full ml-2 flex items-center gap-1"
    >
      <AppCommandShortcutHint shortcut={sidebarShortcut} />
      <AppCommandShortcutHint shortcut={back} />
      <AppCommandShortcutHint shortcut={forward} />
    </span>
  );
}

function SidebarTriggerOverlay({
  hostsPageChrome,
  reserveMacosTrafficLights,
  slotSetters,
  usesDesktopChrome,
}: SidebarTriggerOverlayProps) {
  const isCompactViewport = useIsCompactViewport();
  const { openMobile } = useSidebar();
  const isFramed = useIsSidebarFramed();

  const panelShelfState = usePanelShelfState({
    isCompactViewport,
    isSidebarDrawerOpen: openMobile,
  });

  const shortcut = useAppCommandShortcut("sidebar.toggle");
  const isShortcutModifierHeld = useIsAppCommandModifierHeld();

  const triggerProps = {
    "aria-label": shortcut
      ? `Toggle sidebar (${shortcut.label})`
      : "Toggle sidebar",
    "aria-keyshortcuts": shortcut?.ariaKeyshortcuts,
    ...appCommandTarget("sidebar.toggle"),
  };

  if (isFramed) {
    return (
      <div
        data-testid="app-window-title-bar"
        style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
        className={cn(
          "fixed top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] left-[env(safe-area-inset-left)]",
          "grid h-(--omnyo-window-title-bar-height) grid-cols-[minmax(min-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-3",
          reserveMacosTrafficLights
            ? "[--omnyo-macos-chrome-control-y:calc(var(--omnyo-macos-traffic-light-axis)_-_var(--omnyo-window-title-bar-height)/2)]"
            : "[--omnyo-macos-chrome-control-y:0px]",
          MACOS_WINDOW_DRAG_CLASS,
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center",
            reserveMacosTrafficLights
              ? MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS
              : BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
          )}
        >
          <div
            className={cn(
              "flex shrink-0 items-center gap-(--omnyo-chrome-control-gap)",
              MACOS_CHROME_CONTROL_NO_DRAG_CLASS,
            )}
          >
            <SidebarTrigger
              {...triggerProps}
              className={TITLE_BAR_SEGMENT_CLASS}
            />
            <SidebarHistoryNavigationControls showShortcutHints={false} />
            <TitleBarShortcutHints sidebarShortcut={shortcut} />
          </div>
          {hostsPageChrome ? (
            <div
              ref={slotSetters.setPageTitle}
              data-testid="app-title-bar-page-chrome"
              className={cn(
                "ml-3 flex min-w-0 flex-1 items-center [contain:inline-size]",
                MACOS_CHROME_CONTROL_AXIS_CLASS,
                isShortcutModifierHeld && "invisible",
              )}
            />
          ) : (
            <nav
              aria-label="Breadcrumb"
              data-testid="app-top-rail-breadcrumbs"
              className={cn(
                "ml-3 flex min-w-0 flex-1 items-center gap-1.5 [contain:inline-size]",
                MACOS_CHROME_CONTROL_AXIS_CLASS,
                isShortcutModifierHeld && "invisible",
              )}
            >
              <ScopedProjectTitle className="shrink-[2]" />
            </nav>
          )}
        </div>
        <div
          className={cn(
            "flex items-center gap-2",
            MACOS_CHROME_CONTROL_AXIS_CLASS,
          )}
        >
          <div
            ref={slotSetters.setCompanionToolbar}
            data-testid="app-title-bar-companion-toolbar"
            className={cn(
              "flex min-w-0 items-center gap-2 empty:hidden",
              MACOS_APP_REGION_NO_DRAG_CLASS,
            )}
          />
          <PluginTitleBarCenter />
        </div>
        <div className="col-start-3 flex min-w-0 items-center justify-end gap-1 pr-[calc(var(--omnyo-sidebar-rail-padding)_-_2px)]">
          {hostsPageChrome ? (
            <div
              className={cn(
                "flex items-center",
                MACOS_CHROME_CONTROL_AXIS_CLASS,
                isShortcutModifierHeld && "invisible",
              )}
            >
              <div
                ref={slotSetters.setPageActions}
                data-testid="app-title-bar-page-actions"
                className="peer flex items-center empty:hidden"
              />
              <span
                aria-hidden
                data-title-bar-divider=""
                className="mx-1.5 h-4 w-px bg-border peer-empty:hidden"
              />
            </div>
          ) : null}
          <div
            data-title-bar-view-toggles=""
            className={cn(
              "flex items-center gap-0.5 rounded-lg bg-surface-recessed p-0.5 empty:hidden",
              MACOS_CHROME_CONTROL_AXIS_CLASS,
            )}
          >
            <WindowRightPanelToggle className={MACOS_WINDOW_NO_DRAG_CLASS} />
          </div>
        </div>
      </div>
    );
  }

  if (usesDesktopChrome) {
    return (
      <div
        data-testid="app-desktop-sidebar-trigger"
        data-panel-shelf={panelShelfState}
        style={{ zIndex: APP_OVERLAY_LAYER.sidebarTrigger }}
        className={cn(
          "fixed top-0",
          COMPACT_SHELF_HIDDEN_FIXED_CHROME_CLASS,
          CHROME_ROW_CLASS,
          reserveMacosTrafficLights
            ? MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS
            : ["left-0", BROWSER_SIDEBAR_TRIGGER_INSET_CLASS],
          MACOS_WINDOW_DRAG_CLASS,
        )}
      >
        <SidebarTrigger
          className={MACOS_CHROME_CONTROL_NO_DRAG_CLASS}
          {...triggerProps}
        />
        <AppCommandShortcutHint
          shortcut={shortcut}
          className={cn(
            "absolute left-full ml-1",
            MACOS_CHROME_CONTROL_AXIS_CLASS,
          )}
        />
      </div>
    );
  }

  if (!isCompactViewport || openMobile) return null;

  return (
    <div
      data-testid="app-sidebar-trigger-overlay"
      data-panel-shelf={panelShelfState}
      style={{
        zIndex: isCompactViewport
          ? APP_OVERLAY_LAYER.compactSidebarTrigger
          : APP_OVERLAY_LAYER.sidebarTrigger,
      }}
      className={cn(
        "fixed top-[env(safe-area-inset-top)] left-[env(safe-area-inset-left)]",
        COMPACT_SHELF_HIDDEN_FIXED_CHROME_CLASS,
        CHROME_ROW_CLASS,
        BROWSER_SIDEBAR_TRIGGER_INSET_CLASS,
      )}
    >
      <SidebarTrigger {...triggerProps} />
      <AppCommandShortcutHint
        shortcut={shortcut}
        className="absolute left-full ml-1"
      />
    </div>
  );
}

const routeTitles: Record<string, { title: string }> = {
  "/": { title: "Omnyo" },
  "/settings": { title: "Settings" },
  "/automations": { title: "Automations" },
  "/skills": { title: "Skills" },
};

function resolveRouteTitle(pathname: string): { title: string } | undefined {
  if (matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname)) {
    return routeTitles[SETTINGS_ROUTE_PATH];
  }

  return routeTitles[pathname];
}

interface AppHeaderProps {
  usesProjectChromeStyle: boolean;
  usesDesktopChrome: boolean;
  projectId?: string;
  project?: ProjectResponse;
  meta: {
    title: string;
    breadcrumbs?: Array<{ label: string; to?: string }>;
  };
}

function AppHeader({
  usesProjectChromeStyle,
  usesDesktopChrome,
  projectId,
  project,
  meta,
}: AppHeaderProps) {
  const headerBreadcrumbs = meta.breadcrumbs;

  const headerTitle =
    headerBreadcrumbs || usesProjectChromeStyle ? undefined : meta.title;

  const hasCenterContent = Boolean(headerBreadcrumbs) || Boolean(headerTitle);

  const center = headerBreadcrumbs ? (
    <div className="min-w-0 flex-1">
      <AppBreadcrumbs
        breadcrumbs={headerBreadcrumbs}
        usesDesktopChrome={usesDesktopChrome}
      />
    </div>
  ) : hasCenterContent ? (
    <div className="min-w-0 flex-1">
      {headerTitle ? (
        <p className="truncate text-sm font-semibold">{headerTitle}</p>
      ) : null}
    </div>
  ) : null;

  const actions =
    usesProjectChromeStyle &&
    projectId &&
    !isProjectlessProjectId(projectId) ? (
      <>
        <Link
          to={getSettingsProjectRoutePath(projectId)}
          className={cn(
            HEADER_ICON_BUTTON_CLASS,
            "inline-flex items-center justify-center transition-colors",
            "text-muted-foreground hover:bg-state-hover hover:text-foreground",
          )}
          aria-label="Project settings"
        >
          <Icon name="Settings" />
        </Link>
        {project ? (
          <ProjectActionsMenu
            project={project}
            triggerClassName={HEADER_ICON_BUTTON_CLASS}
          />
        ) : null}
      </>
    ) : null;

  return <AppPageHeader center={center} actions={actions} />;
}

interface AppLayoutProps {
  children: ReactNode;
}

export function AppLayout({ children }: AppLayoutProps) {
  const quickCreateProject = useQuickCreateProjectController();
  const isCompactViewport = useIsCompactViewport();
  const store = useStore();
  const [contentShell, setContentShell] = useState<HTMLDivElement | null>(null);

  const restoreIOSViewportOnKeyboardDismissal = useMemo(
    () => isIOSWebKit(navigator),
    [],
  );

  useMobileVisualViewportHeight(
    contentShell,
    isCompactViewport || restoreIOSViewportOnKeyboardDismissal,
    restoreIOSViewportOnKeyboardDismissal,
    isCompactViewport ? "compact" : "framed",
  );
  const location = useLocation();

  const { projectId, threadId, isThreadView, isArchivedView, isRootView } =
    useRouteState();

  const [resourceRouteLabel, setResourceRouteLabel] = useAtom(
    resourceRouteLabelAtom,
  );

  useEffect(() => {
    setResourceRouteLabel(null);

    function handleResourceRouteLabel(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const detail = event.detail;

      if (
        typeof detail !== "object" ||
        detail === null ||
        !("label" in detail) ||
        (typeof detail.label !== "string" && detail.label !== null)
      ) {
        return;
      }

      setResourceRouteLabel(detail.label);
    }

    window.addEventListener(
      RESOURCE_ROUTE_LABEL_EVENT,
      handleResourceRouteLabel,
    );

    return () => {
      window.removeEventListener(
        RESOURCE_ROUTE_LABEL_EVENT,
        handleResourceRouteLabel,
      );
    };
  }, [location.pathname, setResourceRouteLabel]);
  const navigate = useNavigate();

  const { appRoutePath, settingsRoutePath, toolsBackRoutePath } =
    useAppSettingsRouteMemory();

  const setRootComposeProjectId = useSetRootComposeProjectId();
  const sidebarScope = useSidebarScope();
  const openThreadInLayout = useOpenThreadInLayout();
  useEffect(
    () =>
      wsManager.onThreadOpen((signal) => {
        if (signal.file !== null) return;

        openThreadInLayout(
          { projectId: signal.projectId, threadId: signal.threadId },
          signal.split,
        );
      }),
    [openThreadInLayout],
  );
  useAppCommandHandler("thread.new", () => {
    const entry = resolveNewChatEntry({
      launcher: store.get(newChatLauncherAtom),
      otherModalOpen: hasOpenModal(),
      compact: isCompactViewport,
      pathname: location.pathname,
      layout: store.get(splitLayoutAtom),
    });

    if (entry.kind === "ignore") return false;

    if (entry.kind !== "focus-launcher") {
      const newChatProjectId =
        sidebarScope.kind === "project" ? sidebarScope.projectId : projectId;

      if (newChatProjectId !== undefined) {
        setRootComposeProjectId(newChatProjectId);
      }
    }

    if (entry.kind === "show-page") {
      void navigate(getRootComposeRoutePath(), {
        state: { focusPrompt: true },
      });

      return true;
    }

    store.set(newChatLauncherAtom, openNewChatLauncher);

    return true;
  });
  useAppCommandHandler("settings.open", () => {
    void navigate(settingsRoutePath);

    return true;
  });
  useAppCommandHandler("settings.openServers", () => {
    void navigate(getSettingsRoutePath("machines"));

    return true;
  });
  useServerDaemonLogsCommand();
  useDataDirectoryCommand();
  useWindowReloadCommand();
  usePluginSafeModeCommands();
  usePluginCachePruneCommand();

  const archivedSectionId = isArchivedView
    ? new URLSearchParams(location.search).get("sectionId")
    : null;

  const navPanelChrome = usePluginNavPanelChrome();

  const isGlobalSettingsView =
    matchPath(`${SETTINGS_ROUTE_PATH}/*`, location.pathname) !== null;

  const isPluginsWorkspace = isPluginsRoutePath(location.pathname);
  const isSkillsWorkspace = isSkillsRoutePath(location.pathname);

  const backToAppRoutePath = isGlobalSettingsView
    ? appRoutePath
    : isPluginsWorkspace || isSkillsWorkspace
      ? toolsBackRoutePath
      : null;

  const pluginPanelMatch = matchPath(
    PLUGIN_PANEL_ROUTE_PATH,
    location.pathname,
  );

  const pluginPanelEntry = pluginPanelMatch
    ? navPanelChrome.find(
        (candidate) =>
          candidate.chrome.pluginId === pluginPanelMatch.params.pluginId &&
          candidate.chrome.path === pluginPanelMatch.params.panelPath,
      )
    : undefined;

  const pluginPanel = pluginPanelEntry?.panel ?? undefined;
  const sidebarNavigationQuery = useSidebarNavigation();

  const projects = useMemo(
    () => sidebarNavigationQuery.data?.projects.map(stripProjectThreads),
    [sidebarNavigationQuery.data],
  );

  const sidebarThreads = useMemo(() => {
    const sidebarNavigation = sidebarNavigationQuery.data;

    if (!sidebarNavigation) {
      return [];
    }

    return [
      ...sidebarNavigation.projects.flatMap((project) => project.threads),
      ...sidebarNavigation.personalProject.threads,
    ];
  }, [sidebarNavigationQuery.data]);

  const nonArchivedThreads = useNonArchivedThreads(sidebarThreads);
  useActiveThreadPreloading(nonArchivedThreads);
  useThreadAttentionCache();

  useDesktopOpenThread({
    threads: nonArchivedThreads,
    openThread: openThreadInLayout,
    navigate,
  });

  const titleMentionResources = useSidebarThreadTitleMentionResources(
    sidebarNavigationQuery.data,
  );

  const threadDetailBootstrapQuery = useThreadDetailBootstrap(threadId ?? "", {
    enabled: isThreadView && Boolean(threadId),
    timelinePrefetch: isThreadView && Boolean(threadId),
  });

  const hasThreadDetailBootstrapSettled =
    threadDetailBootstrapQuery.isSuccess || threadDetailBootstrapQuery.isError;

  const resolvedThreadProjectId = threadDetailBootstrapQuery.data?.projectId;

  const canonicalThreadRoutePath =
    isThreadView &&
    projectId !== undefined &&
    threadId !== undefined &&
    resolvedThreadProjectId !== undefined &&
    resolvedThreadProjectId !== projectId
      ? getThreadRoutePath({
          projectId: resolvedThreadProjectId,
          threadId,
        })
      : null;

  const [titleBarPageTitle, setTitleBarPageTitle] =
    useState<HTMLElement | null>(null);

  const [titleBarPageActions, setTitleBarPageActions] =
    useState<HTMLElement | null>(null);

  const [titleBarCompanionToolbar, setTitleBarCompanionToolbar] =
    useState<HTMLElement | null>(null);

  const titleBarSlots = useMemo<WindowTitleBarSlots>(
    () => ({
      pageTitle: titleBarPageTitle,
      pageActions: titleBarPageActions,
      companionToolbar: titleBarCompanionToolbar,
    }),
    [titleBarCompanionToolbar, titleBarPageActions, titleBarPageTitle],
  );

  const titleBarSlotSetters = useMemo<WindowTitleBarSlotSetters>(
    () => ({
      setPageTitle: setTitleBarPageTitle,
      setPageActions: setTitleBarPageActions,
      setCompanionToolbar: setTitleBarCompanionToolbar,
    }),
    [],
  );

  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const liveWidthRef = useRef(0);
  const animationFrameRef = useRef<number | null>(null);
  const showHeader = !isThreadView && !isRootView && pluginPanelMatch === null;
  const [desktopInfo] = useState(getOmnyoDesktopInfo);
  const desktopWindowState = useDesktopWindowState();
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);

  const reserveMacosTrafficLights = shouldReserveMacosTrafficLights({
    desktopInfo,
    windowState: desktopWindowState,
  });

  const project = projectId
    ? projects?.find((candidate) => candidate.id === projectId)
    : undefined;

  const archivedSectionName = archivedSectionId
    ? (sidebarNavigationQuery.data?.sections.find(
        (section) => section.id === archivedSectionId,
      )?.name ?? archivedSectionId)
    : null;

  const projectName = projectId ? project?.name : undefined;
  const projectLabel = projectName ?? (projectId ? projectId : undefined);

  const { data: thread } = useThread(threadId ?? "", {
    enabled:
      Boolean(threadId) && (!isThreadView || hasThreadDetailBootstrapSettled),
    refetchOnMount:
      isThreadView &&
      didThreadDetailBootstrapRefreshAfterMount(threadDetailBootstrapQuery)
        ? false
        : "always",
  });

  const threadDisplayTitle = thread
    ? resolveThreadTitleDisplayText(
        getThreadDisplayTitle(thread),
        titleMentionResources,
      )
    : threadId
      ? `Thread ${threadId.slice(0, 8)}`
      : "Thread";

  const toolsBreadcrumbs = resolveToolsBreadcrumbs(
    location.pathname,
    location.search,
    resourceRouteLabel,
  );

  const automationBreadcrumbs = resolveAutomationBreadcrumbs(
    location.pathname,
    resourceRouteLabel,
  );

  const documentTitleBreadcrumbs = toolsBreadcrumbs ?? automationBreadcrumbs;

  const resourceWorkspaceHeaderMeta =
    resolvePluginsWorkspaceHeaderMeta(location.pathname, location.search) ??
    resolveSkillsWorkspaceHeaderMeta(location.pathname);

  const meta =
    resourceWorkspaceHeaderMeta?.kind === "section-title"
      ? { title: resourceWorkspaceHeaderMeta.title }
      : resourceWorkspaceHeaderMeta?.kind === "breadcrumbs"
        ? {
            title: "",
            breadcrumbs: resourceWorkspaceHeaderMeta.breadcrumbs,
          }
        : automationBreadcrumbs !== null
          ? { title: "", breadcrumbs: automationBreadcrumbs }
          : isArchivedView && projectId
            ? isProjectlessProjectId(projectId)
              ? {
                  title: "",
                  breadcrumbs: [
                    { label: "Threads", to: getRootComposeRoutePath() },
                    ...(archivedSectionName
                      ? [{ label: archivedSectionName }]
                      : []),
                    { label: "Archived" },
                  ],
                }
              : {
                  title: "",
                  breadcrumbs: [
                    {
                      label: projectLabel ?? projectId,
                      to: getLegacyProjectComposeRoutePath(projectId),
                    },
                    { label: "Archived" },
                  ],
                }
            : projectId
              ? {
                  title: projectLabel ?? projectId,
                }
              : (resolveRouteTitle(location.pathname) ?? { title: "" });

  const documentTitle = (() => {
    if (isThreadView) {
      return threadDisplayTitle;
    }

    if (pluginPanel) {
      return pluginPanel.title;
    }

    if (documentTitleBreadcrumbs) {
      const sectionLabel = documentTitleBreadcrumbs[0]?.label ?? "Omnyo";
      const pageLabel = documentTitleBreadcrumbs.at(-1)?.label ?? sectionLabel;

      return pageLabel === sectionLabel
        ? sectionLabel
        : `${pageLabel} · ${sectionLabel}`;
    }

    if (isArchivedView && projectId) {
      if (isProjectlessProjectId(projectId)) {
        return archivedSectionName
          ? `${archivedSectionName} · Archived`
          : "Threads · Archived";
      }

      return `${projectLabel ?? projectId} · Archived`;
    }

    if (projectId) {
      return projectLabel ?? projectId;
    }

    const routeTitle = resolveRouteTitle(location.pathname)?.title;

    return routeTitle && routeTitle.length > 0 ? routeTitle : "Omnyo";
  })();

  const currentThreadPendingInteractionsQuery = useThreadPendingInteractions(
    threadId ?? "",
    { enabled: isThreadView && Boolean(threadId) },
  );

  const currentThreadHasPendingInteraction =
    (currentThreadPendingInteractionsQuery.data?.length ?? 0) > 0;

  const faviconBadge = shouldShowFaviconAttentionDot({
    currentThreadHasPendingInteraction,
    currentThreadId: threadId,
    isThreadView,
    sidebarThreads,
    thread,
  })
    ? "unread"
    : "none";

  useFaviconBadge(faviconBadge);

  const handleResizeMouseDown = useCallback(
    (event: SidebarResizeMouseEvent) => {
      event.preventDefault();
      setIsSidebarResizing(true);
      startXRef.current = event.clientX;
      startWidthRef.current = store.get(sidebarWidthAtom);
      liveWidthRef.current = startWidthRef.current;
      document.body.classList.add("sidebar-resizing");
    },
    [store],
  );

  const finishSidebarResize = useCallback(() => {
    if (animationFrameRef.current !== null) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }

    flushSync(() => {
      store.set(sidebarWidthAtom, liveWidthRef.current);
      store.set(sidebarLiveWidthAtom, null);
    });
    dispatchBrowserViewBoundsSync();
    setIsSidebarResizing(false);
    resetSidebarResizeDocumentState();
  }, [store]);

  useEffect(() => {
    if (!isSidebarResizing) return;

    const applyLiveWidth = () => {
      animationFrameRef.current = null;
      flushSync(() => {
        store.set(sidebarLiveWidthAtom, liveWidthRef.current);
      });
      dispatchBrowserViewBoundsSync();
    };

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - startXRef.current;
      liveWidthRef.current = clampSidebarWidth(startWidthRef.current + delta);

      if (animationFrameRef.current === null) {
        animationFrameRef.current =
          window.requestAnimationFrame(applyLiveWidth);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        finishSidebarResize();
      }
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", finishSidebarResize);
    window.addEventListener("blur", finishSidebarResize);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", finishSidebarResize);
      window.removeEventListener("blur", finishSidebarResize);
      window.removeEventListener("keydown", handleKeyDown);

      if (animationFrameRef.current !== null) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }

      store.set(sidebarLiveWidthAtom, null);
      resetSidebarResizeDocumentState();
    };
  }, [finishSidebarResize, isSidebarResizing, store]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.title = documentTitle;
  }, [documentTitle]);

  return (
    <SidebarThreadEntriesProvider navigation={sidebarNavigationQuery.data}>
      <TooltipProvider delayDuration={300} disableHoverableContent>
        <ProjectActionsProvider>
          <ThreadTitleMentionResourcesProvider {...titleMentionResources}>
            <ActionHistoryProvider>
              <ThreadActionsProvider>
                <SidebarStateBridge
                  framed
                  usesDesktopChrome={usesDesktopChrome}
                >
                  <WindowTitleBarSlotsContext.Provider value={titleBarSlots}>
                    {canonicalThreadRoutePath !== null ? (
                      <Navigate
                        to={{
                          pathname: canonicalThreadRoutePath,
                          search: location.search,
                          hash: location.hash,
                        }}
                        replace
                      />
                    ) : null}
                    {backToAppRoutePath !== null && !isSidebarResizing ? (
                      <BackToAppCommandHandler routePath={backToAppRoutePath} />
                    ) : null}
                    <HistoryCommandHandlers />
                    <ActionHistoryCommandHandlers />
                    <AppShellFrame
                      mode={
                        isGlobalSettingsView
                          ? "settings"
                          : isPluginsWorkspace
                            ? "plugins"
                            : isSkillsWorkspace
                              ? "skills"
                              : "app"
                      }
                      onResizeMouseDown={handleResizeMouseDown}
                      isResizing={isSidebarResizing}
                      settingsToggleRoutePath={
                        isGlobalSettingsView ? appRoutePath : settingsRoutePath
                      }
                    >
                      <div
                        ref={setContentShell}
                        data-testid="app-layout-content-shell"
                        data-app-content-shell=""
                        className="relative flex h-full min-h-0 min-w-0 w-full flex-col pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[var(--omnyo-safe-area-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] group-data-[framed]/sidebar-wrapper:pt-0 group-data-[framed]/sidebar-wrapper:pr-0 group-data-[framed]/sidebar-wrapper:pb-0 group-data-[framed]/sidebar-wrapper:pl-0"
                      >
                        {showHeader ? (
                          <AppHeader
                            usesDesktopChrome={usesDesktopChrome}
                            usesProjectChromeStyle={
                              isRootView || isArchivedView
                            }
                            projectId={projectId}
                            project={project}
                            meta={meta}
                          />
                        ) : null}
                        <main className="flex min-h-0 flex-1 flex-col p-4 md:p-5">
                          {children}
                        </main>
                      </div>
                    </AppShellFrame>
                    <SidebarTriggerOverlay
                      hostsPageChrome={
                        isThreadView || pluginPanelMatch !== null
                      }
                      reserveMacosTrafficLights={reserveMacosTrafficLights}
                      slotSetters={titleBarSlotSetters}
                      usesDesktopChrome={usesDesktopChrome}
                    />
                  </WindowTitleBarSlotsContext.Provider>
                </SidebarStateBridge>
                <PluginAppOverlays />
                <IframeDragGuardOverlay
                  active={isSidebarResizing}
                  cursor="col-resize"
                />
                <CommandPalette
                  threadId={threadId ?? null}
                  projectId={projectId ?? null}
                />
                <NewChatLauncherOverlay />
                <ThreadGroupCommandHandler />
                <NotificationCenter />
                <ProjectPathDialog
                  target={quickCreateProject.projectPathDialog.target}
                  pending={quickCreateProject.isCreating}
                  platform={quickCreateProject.platform}
                  hostId={quickCreateProject.hostId}
                  hostName={quickCreateProject.hostName}
                  hosts={quickCreateProject.hosts}
                  onOpenChange={
                    quickCreateProject.projectPathDialog.onOpenChange
                  }
                  onSubmit={quickCreateProject.submitProjectPath}
                />
              </ThreadActionsProvider>
            </ActionHistoryProvider>
          </ThreadTitleMentionResourcesProvider>
        </ProjectActionsProvider>
      </TooltipProvider>
    </SidebarThreadEntriesProvider>
  );
}

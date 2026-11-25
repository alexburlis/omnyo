import {
  createPluginPortalRetention,
  PluginPortalRetentionBoundary,
} from "./lib/plugin-portal-retention";
import { usePluginPageSession } from "./lib/plugin-session";
import { UsageCountNotice } from "./components/settings/UsagePrivacyControls";
import { PluginUpdateJobsHost } from "./components/plugin/PluginUpdateJobsHost";
import { LazyThreadDetailView } from "./views/thread-detail/LazyThreadDetailView";
import { LazyRootComposeView } from "./views/LazyRootComposeView";
import { useRouteState } from "./hooks/useRouteState";
import {
  Activity,
  Suspense,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { parseMessageLink } from "@omnyo/client-core";
import {
  UNSAFE_LocationContext as RouterLocationContext,
  matchPath,
  Navigate,
  Route,
  Routes,
  useLocation,
  useParams,
} from "react-router-dom";
import { AppLayout } from "./components/layout/AppLayout";
import { AuthCallbackView } from "./views/AuthCallbackView";
import { QuickCreateProjectProvider } from "./hooks/useQuickCreateProject";
import { RouteNavigationProvider } from "./components/ui/app-route-anchor";
import { RouteNavigationIndicator } from "./components/ui/route-navigation-indicator";
import { AppNavigationUrlHost } from "./lib/url-open-routing";
import { NativeShellReporter } from "./lib/native-shell";
import { UiPreferencesSync } from "@/lib/ui-preferences/UiPreferencesSync";
import { AppFileExternalNavigationHost } from "./components/plugin/AppFileExternalNavigationHost";
import { pluginDetailKeyFromRoute } from "./components/plugin/plugin-detail-key";
import { useAppTheme } from "./hooks/useAppTheme";
import { useFaviconColorSync } from "./lib/favicon-color-preference";
import { useDesktopThemeSync } from "./hooks/useDesktopThemeSync";
import { usePluginFrontendBoot } from "./hooks/usePluginFrontendBoot";
import { markRouteContentPainted } from "./lib/route-content-paint";
import { useRememberPluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import { useWebSocket } from "./hooks/useWebSocket";
import {
  AUTH_CALLBACK_ROUTE_PATH,
  LEGACY_AUTOMATION_DETAIL_ROUTE_PATH,
  LEGACY_AUTOMATIONS_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_BROWSE_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATION_EDIT_ROUTE_PATH,
  LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH,
  LEGACY_TOOLS_PREFIX_ROUTE_PATH,
  LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH,
  LEGACY_TOOLS_SPLAT_ROUTE_PATH,
  PROJECT_ARCHIVED_ROUTE_PATH,
  PROJECTLESS_ARCHIVED_ROUTE_PATH,
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
  LEGACY_PROJECT_SETTINGS_ROUTE_PATH,
  PLUGIN_DETAIL_ROUTE_PATH,
  PLUGINS_ROUTE_PATH,
  REGISTRY_SKILL_DETAIL_ROUTE_PATH,
  REGISTRY_SKILLS_ROUTE_PATH,
  SKILL_DETAIL_ROUTE_PATH,
  SKILLS_ROUTE_PATH,
  TOOLS_PLUGIN_BROWSE_ROUTE_PATH,
  TOOLS_PLUGIN_DETAIL_ROUTE_PATH,
  TOOLS_PLUGINS_ROUTE_PATH,
  TOOLS_REGISTRY_SKILL_DETAIL_ROUTE_PATH,
  TOOLS_REGISTRY_SKILLS_ROUTE_PATH,
  TOOLS_ROUTE_PATH,
  APP_ROOT_ROUTE_PATH,
  TOOLS_SKILL_DETAIL_ROUTE_PATH,
  TOOLS_SKILLS_ROUTE_PATH,
  getAutomationDetailRoutePath,
  getAutomationEditRoutePath,
  getAutomationsRoutePath,
  getPluginConfigurationRoutePath,
  getPluginPanelRoutePath,
  getPluginPanelRoutePluginId,
  SKILLS_PANEL,
  getSettingsRoutePath,
  getSettingsProjectRoutePath,
  isWorkspaceRoutePath,
} from "./lib/route-paths";
import { AppCommandProvider } from "./components/commands/AppCommandProvider";
import { AppCommandShortcutOverlay } from "./components/commands/AppCommandShortcutOverlay";
import { WindowFindHost } from "./components/layout/WindowFindHost";
import { DesktopZoomIndicator } from "./components/layout/DesktopZoomIndicator";
import { ProviderCliInstallLogDialogHost } from "./components/provider-cli/provider-cli-install";
import { TerminalCloseConfirmHost } from "./components/thread/terminal/terminal-close-guard";
import { ServerMoveOverlay } from "./components/machines/ServerMoveOverlay";
import { OnboardingGate } from "./components/onboarding/OnboardingGate";
import { AppUpdateHost } from "./components/app-update/AppUpdateHost";
import { DesktopUpdatePromptHost } from "./components/app-update/DesktopUpdatePromptHost";
import { PluginInstallJobsHost } from "./components/plugin/PluginInstallJobsHost";
import { RouteLoadingSkeleton } from "./components/ui/route-loading-skeleton";
import { defineSplit } from "./lib/define-split";
import { LazyPluginsView as PluginsView } from "./views/ToolsViewSplits";
import {
  preloadSettingsRoute,
  SettingsRoute,
} from "./views/settings-view-split";
import { settingsRoutePaths } from "./components/settings/settings-route";
import { ThreadTimelineLoadingSkeleton } from "./components/thread/timeline/ThreadTimelineLoadingSkeleton";
import { trackCriticalLoad, whenCriticalLoadsSettled } from "./lib/split-load";

const SplitWorkspaceRoute = defineSplit({
  id: "workspace-route",
  load: () =>
    import("./views/SplitWorkspaceRoute").then((module) => module.default),
  loading: () => null,
});

if (typeof window !== "undefined") {
  const settingsLoad = preloadSettingsRoute(window.location);

  if (settingsLoad !== undefined) void trackCriticalLoad(settingsLoad);
}

if (
  typeof window !== "undefined" &&
  isWorkspaceRoutePath(window.location.pathname)
) {
  void trackCriticalLoad(SplitWorkspaceRoute.preload());

  if (
    matchPath(
      { path: THREAD_DETAIL_ROUTE_PATH, end: false },
      window.location.pathname,
    ) ||
    matchPath(
      { path: PROJECTLESS_THREAD_DETAIL_ROUTE_PATH, end: false },
      window.location.pathname,
    )
  ) {
    void trackCriticalLoad(LazyThreadDetailView.preload());
  }
}

function NavigatePreservingLocation({ pathname }: { pathname: string }) {
  const location = useLocation();

  return (
    <Navigate
      to={{ pathname, search: location.search, hash: location.hash }}
      replace
    />
  );
}

function LegacyProjectSettingsRedirect() {
  const { projectId } = useParams<{ projectId: string }>();

  return (
    <NavigatePreservingLocation
      pathname={
        projectId
          ? getSettingsProjectRoutePath(projectId)
          : getSettingsRoutePath("projects")
      }
    />
  );
}

function LegacyAutomationDetailRedirect() {
  const location = useLocation();

  const { projectId, automationId } = useParams<{
    projectId?: string;
    automationId?: string;
  }>();

  if (!projectId || !automationId) {
    return <Navigate to={getAutomationsRoutePath()} replace />;
  }

  return (
    <Navigate
      to={
        location.pathname.endsWith("/edit")
          ? getAutomationEditRoutePath({ projectId, automationId })
          : getAutomationDetailRoutePath({ projectId, automationId })
      }
      replace
    />
  );
}

function LegacyAutomationCollectionRedirect() {
  const location = useLocation();

  const browse =
    location.pathname.endsWith("/browse") ||
    new URLSearchParams(location.search).get("view") === "browse";

  return (
    <Navigate
      to={
        browse
          ? `${getAutomationsRoutePath()}/browse`
          : getAutomationsRoutePath()
      }
      replace
    />
  );
}

function normalizeLegacyPluginSuffix(suffix: string): string {
  return matchPath("/browse", suffix) !== null ? "" : suffix;
}

export function LegacyPluginsPathRedirect() {
  const location = useLocation();

  const suffix = normalizeLegacyPluginSuffix(
    location.pathname.slice(TOOLS_PLUGINS_ROUTE_PATH.length),
  );

  return (
    <NavigatePreservingLocation pathname={`${PLUGINS_ROUTE_PATH}${suffix}`} />
  );
}

function skillsPanelPath(suffix: string): string {
  const root = getPluginPanelRoutePath(SKILLS_PANEL);

  const match = /^(?:\/)(library|installed|registry)(?:\/([^/]+))?\/?$/u.exec(
    suffix,
  );

  if (match === null) return root;
  const [, section, item] = match;

  if (section === "registry")
    return `${root}/marketplace${item ? `/${item}` : ""}`;

  return item ? `${root}/installed/${item}` : root;
}

export function LegacySkillsPathRedirect() {
  const { pathname } = useLocation();

  const prefix = pathname.startsWith(TOOLS_SKILLS_ROUTE_PATH)
    ? TOOLS_SKILLS_ROUTE_PATH
    : SKILLS_ROUTE_PATH;

  return (
    <NavigatePreservingLocation
      pathname={skillsPanelPath(pathname.slice(prefix.length))}
    />
  );
}

function LegacySkillMarketplaceRedirect() {
  return (
    <NavigatePreservingLocation
      pathname={getPluginPanelRoutePath({
        ...SKILLS_PANEL,
        subPath: "marketplace",
      })}
    />
  );
}

export function LegacyToolsPathRedirect() {
  const location = useLocation();
  const suffix = location.pathname.slice(LEGACY_TOOLS_PREFIX_ROUTE_PATH.length);

  const pathname = suffix.startsWith("/plugins")
    ? `${PLUGINS_ROUTE_PATH}${normalizeLegacyPluginSuffix(
        suffix.slice("/plugins".length),
      )}`
    : suffix.startsWith("/skills")
      ? skillsPanelPath(suffix.slice("/skills".length))
      : suffix === "" || suffix === "/"
        ? PLUGINS_ROUTE_PATH
        : `${TOOLS_ROUTE_PATH}${suffix}`;

  return <NavigatePreservingLocation pathname={pathname} />;
}

function hashTargetId(hash: string): string | null {
  if (hash.length <= 1) return null;

  try {
    return decodeURIComponent(hash.slice(1));
  } catch {
    return hash.slice(1);
  }
}

const HASH_NAVIGATION_WAIT_MS = 2_000;

export function HashNavigationScroll() {
  const location = useLocation();

  useEffect(() => {
    if (parseMessageLink(`${location.pathname}${location.hash}`) !== null) {
      return;
    }

    const targetId = hashTargetId(location.hash);

    if (targetId === null) return;

    const scrollToTarget = (): boolean => {
      const target = document.getElementById(targetId);

      if (target === null) return false;

      if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
        target.tabIndex = -1;
      }

      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "start", inline: "nearest" });

      return true;
    };

    if (scrollToTarget()) return;

    let observer: MutationObserver | null = null;
    let timeoutId: number | null = null;

    const stopWaiting = () => {
      observer?.disconnect();
      observer = null;

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    observer = new MutationObserver(() => {
      if (scrollToTarget()) stopWaiting();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    timeoutId = window.setTimeout(stopWaiting, HASH_NAVIGATION_WAIT_MS);

    return stopWaiting;
  }, [location.hash, location.key, location.pathname]);

  return null;
}

function WorkspaceRoutes({ children }: { children: ReactNode }) {
  const router = useContext(RouterLocationContext);
  const { location } = router;
  const workspace = isWorkspaceRoutePath(location.pathname);
  const [lastPanel, setLastPanel] = useState<typeof router | null>(null);
  const [retention] = useState(createPluginPortalRetention);
  const retainable = workspace || retention.canRetain();
  useLayoutEffect(() => {
    if (!workspace && !retainable) setLastPanel(null);

    if (workspace)
      setLastPanel(
        getPluginPanelRoutePluginId(location.pathname) ? router : null,
      );
  }, [router, location.pathname, workspace, retainable]);

  const panelLocation = workspace ? router : retainable ? lastPanel : null;

  return (
    <>
      {panelLocation && (
        <Activity mode={workspace ? "visible" : "hidden"}>
          <RouterLocationContext.Provider value={panelLocation}>
            <PluginPortalRetentionBoundary retention={retention}>
              <Routes>{children}</Routes>
            </PluginPortalRetentionBoundary>
          </RouterLocationContext.Provider>
        </Activity>
      )}
      {!workspace && <Routes>{children}</Routes>}
    </>
  );
}

export function AppRoutes() {
  const pluginSession = usePluginPageSession();
  const { isThreadView } = useRouteState();
  const isRootComposeView = useLocation().pathname === APP_ROOT_ROUTE_PATH;
  useEffect(() => {
    if (isThreadView) void trackCriticalLoad(LazyThreadDetailView.preload());
  }, [isThreadView]);
  useEffect(() => {
    if (isRootComposeView)
      void trackCriticalLoad(LazyRootComposeView.preload());
  }, [isRootComposeView]);

  return (
    <AppLayout>
      <Suspense fallback={null}>
        <WorkspaceRoutes key={pluginSession}>
          <Route
            path="/settings/usage"
            element={
              <Navigate
                to={getPluginConfigurationRoutePath({
                  pluginId: "omnyo--provider-usage",
                })}
                replace
              />
            }
          />
          {settingsRoutePaths.map((path) => (
            <Route key={path} path={path} element={<SettingsRoute />} />
          ))}
          <Route
            path={LEGACY_PROJECT_SETTINGS_ROUTE_PATH}
            element={<LegacyProjectSettingsRedirect />}
          />
          <Route
            path={PROJECT_ARCHIVED_ROUTE_PATH}
            element={<Navigate to={getSettingsRoutePath("archived")} replace />}
          />
          <Route
            path={PROJECTLESS_ARCHIVED_ROUTE_PATH}
            element={<Navigate to={getSettingsRoutePath("archived")} replace />}
          />
          <Route
            path={LEGACY_TOOLS_AUTOMATIONS_ROUTE_PATH}
            element={<LegacyAutomationCollectionRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_AUTOMATION_BROWSE_ROUTE_PATH}
            element={<LegacyAutomationCollectionRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_AUTOMATION_DETAIL_ROUTE_PATH}
            element={<LegacyAutomationDetailRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_AUTOMATION_EDIT_ROUTE_PATH}
            element={<LegacyAutomationDetailRedirect />}
          />
          <Route
            path={LEGACY_AUTOMATIONS_ROUTE_PATH}
            element={<LegacyAutomationCollectionRedirect />}
          />
          <Route
            path={LEGACY_AUTOMATION_DETAIL_ROUTE_PATH}
            element={<LegacyAutomationDetailRedirect />}
          />
          <Route
            path={TOOLS_ROUTE_PATH}
            element={
              <NavigatePreservingLocation pathname={PLUGINS_ROUTE_PATH} />
            }
          />
          <Route
            path={TOOLS_PLUGINS_ROUTE_PATH}
            element={<LegacyPluginsPathRedirect />}
          />
          <Route
            path={TOOLS_PLUGIN_BROWSE_ROUTE_PATH}
            element={<LegacyPluginsPathRedirect />}
          />
          <Route
            path={TOOLS_PLUGIN_DETAIL_ROUTE_PATH}
            element={<LegacyPluginsPathRedirect />}
          />
          <Route
            path={TOOLS_SKILLS_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={TOOLS_SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={TOOLS_REGISTRY_SKILLS_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={TOOLS_REGISTRY_SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_PREFIX_ROUTE_PATH}
            element={<LegacyToolsPathRedirect />}
          />
          <Route
            path={LEGACY_TOOLS_SPLAT_ROUTE_PATH}
            element={<LegacyToolsPathRedirect />}
          />
          <Route
            path={SKILLS_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={REGISTRY_SKILLS_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path={REGISTRY_SKILL_DETAIL_ROUTE_PATH}
            element={<LegacySkillsPathRedirect />}
          />
          <Route
            path="/plugins/skill-discovery/marketplace"
            element={<LegacySkillMarketplaceRedirect />}
          />
          <Route path={PLUGINS_ROUTE_PATH} element={<PluginsRoute />} />
          <Route path={PLUGIN_DETAIL_ROUTE_PATH} element={<PluginsRoute />} />
          <Route
            path="*"
            element={
              <Suspense
                fallback={
                  <RouteLoadingSkeleton isBoundedPane={false}>
                    {isThreadView ? <ThreadTimelineLoadingSkeleton /> : null}
                  </RouteLoadingSkeleton>
                }
              >
                <SplitWorkspaceRoute />
              </Suspense>
            }
          />
        </WorkspaceRoutes>
        <RouteContentPaintSignal />
      </Suspense>
    </AppLayout>
  );
}

function RouteContentPaintSignal() {
  useEffect(() => {
    void whenCriticalLoadsSettled().then(() => {
      markRouteContentPainted();
    });
  }, []);

  return null;
}

function PluginsRoute() {
  const { pluginId } = useParams<{ pluginId?: string }>();
  const { search } = useLocation();

  return (
    <PluginsView
      detailKey={
        pluginId === undefined
          ? undefined
          : pluginDetailKeyFromRoute(pluginId, search)
      }
    />
  );
}

export function App() {
  useWebSocket();
  useDesktopThemeSync();
  useAppTheme();
  useFaviconColorSync();
  usePluginFrontendBoot();
  useRememberPluginNavPanelChrome();

  return (
    <QuickCreateProjectProvider>
      <AppCommandProvider>
        <RouteNavigationProvider>
          <RouteNavigationIndicator />
          <AppNavigationUrlHost>
            <AppFileExternalNavigationHost>
              <HashNavigationScroll />
              <NativeShellReporter />
              <UiPreferencesSync />
              <UsageCountNotice />
              <Routes>
                <Route
                  path={AUTH_CALLBACK_ROUTE_PATH}
                  element={<AuthCallbackView />}
                />
                <Route
                  path="*"
                  element={
                    <OnboardingGate>
                      <AppRoutes />
                    </OnboardingGate>
                  }
                />
              </Routes>
              <WindowFindHost />
              <AppCommandShortcutOverlay />
              <DesktopZoomIndicator />
              <ProviderCliInstallLogDialogHost />
              <TerminalCloseConfirmHost />
              <ServerMoveOverlay />
              <AppUpdateHost />
              <DesktopUpdatePromptHost />
              <PluginInstallJobsHost />
              <PluginUpdateJobsHost />
            </AppFileExternalNavigationHost>
          </AppNavigationUrlHost>
        </RouteNavigationProvider>
      </AppCommandProvider>
    </QuickCreateProjectProvider>
  );
}

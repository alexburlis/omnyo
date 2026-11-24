import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "jotai";
import { matchPath, useLocation, useNavigate } from "react-router-dom";
import { z } from "zod";
import { installTestPluginRuntime } from "@omnyo/plugin-sdk/testing/app";
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import { AppShellFrame } from "@/components/layout/AppShellFrame";
import type { AppLayoutSidebarMode } from "@/components/layout/AppLayoutSidebar";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { useSidebarNavigation as useSidebarCatalog } from "@/hooks/queries/sidebar-navigation-query";
import { useRouteState } from "@/hooks/useRouteState";
import { QuickCreateProjectProvider } from "@/hooks/useQuickCreateProject";
import { collectPluginAppRegistrations } from "@/lib/plugin-app-definition";
import {
  removePluginSlotRegistrations,
  setPluginSlotRegistrations,
  type PluginRegistrationSet,
} from "@/lib/plugin-slots";
import {
  getRootComposeRoutePath,
  getSettingsRoutePath,
  getThreadRoutePath,
  isPluginsRoutePath,
  isSkillsRoutePath,
} from "@/lib/route-paths";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { SidebarThreadEntriesProvider } from "@/lib/sidebar-thread-entries";
import { loadPluginAppDefinition } from "../../../.ladle/plugin-app-module";
import { SettingsStoryFixtures } from "../../../.ladle/settings-story-fixtures";
import {
  SHELL_STORY_HOST_FILES,
  SHELL_STORY_HOSTS,
  SHELL_STORY_NAV_PANELS,
  SHELL_STORY_NAVIGATION,
  SHELL_STORY_OPEN_THREAD_ID,
  SHELL_STORY_PROJECT_FILE_IMAGES,
  SHELL_STORY_PROJECT_IDS,
  SHELL_STORY_SCOPED_PROJECT_ID,
  shellStoryResourcesOverview,
  shellStoryUsageSnapshot,
} from "../../../.ladle/sidebar-shell-fixtures";
import {
  installStoryHostFiles,
  installStoryPluginRpc,
  installStoryProjectFileImages,
  installStoryRealtimeConnected,
} from "../../../.ladle/story-shell-stubs";
import { NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH } from "./navRailWidth";
import {
  INBOX_SIDEBAR_SCOPE,
  sidebarScopeAtom,
  useSidebarScope,
  type SidebarScope,
} from "./sidebarScope";

installTestPluginRuntime();

const [threadListApp, accountUsageApp] = await Promise.all([
  loadPluginAppDefinition(
    import.meta.glob<unknown>("../../../../../plugins/thread-list/app.tsx"),
  ),
  loadPluginAppDefinition(
    import.meta.glob<unknown>("../../../../../plugins/account-usage/app.tsx"),
  ),
]);

export default { title: "sidebar/Shell" };

const PROJECT_ICON_CACHE_KEY_PREFIX = "omnyo.sidebar.project-icon:v2:";

const SETTINGS_ROUTE_PATH = getSettingsRoutePath();

const threadListPreferenceSchema = z.object({
  key: z.string(),
  value: z.unknown(),
});

function StoryPluginPage() {
  return (
    <main className="p-6 text-sm text-muted-foreground">
      Plugin page placeholder
    </main>
  );
}

function shellPluginRegistrations(): ReadonlyMap<
  string,
  PluginRegistrationSet
> {
  const threadList = collectPluginAppRegistrations(threadListApp);
  const accountUsage = collectPluginAppRegistrations(accountUsageApp);
  const navPanelPlugins = new Map<string, PluginRegistrationSet>();

  for (const panel of SHELL_STORY_NAV_PANELS) {
    const current =
      navPanelPlugins.get(panel.pluginId) ?? makePluginRegistrationSet();

    navPanelPlugins.set(panel.pluginId, {
      ...current,
      navPanels: [
        ...current.navPanels,
        {
          id: panel.id,
          title: panel.title,
          icon: panel.icon,
          path: panel.id,
          component: StoryPluginPage,
        },
      ],
    });
  }

  return new Map([
    [
      "thread-list",
      makePluginRegistrationSet({ threadLists: threadList.threadLists }),
    ],
    [
      "omnyo--account-usage",
      makePluginRegistrationSet({
        sidebarFooterCards: accountUsage.sidebarFooterCards,
        navPanels: accountUsage.navPanels,
      }),
    ],
    ...navPanelPlugins,
  ]);
}

function registerShellPlugins(): () => void {
  const registrations = shellPluginRegistrations();

  for (const [pluginId, registration] of registrations) {
    setPluginSlotRegistrations(pluginId, registration);
  }

  return () => {
    for (const pluginId of registrations.keys()) {
      removePluginSlotRegistrations(pluginId);
    }
  };
}

function installShellPluginRpc(): () => void {
  const threadListPreferences = new Map<string, unknown>();

  return installStoryPluginRpc({
    "thread-list": {
      listPreferences: () => ({
        preferences: Object.fromEntries(threadListPreferences),
      }),
      setPreference: (input) => {
        const { key, value } = threadListPreferenceSchema.parse(input);
        threadListPreferences.set(key, value);

        return { key, value };
      },
    },
    "omnyo--account-usage": {
      snapshot: () => shellStoryUsageSnapshot(Date.now()),
      refresh: () => shellStoryUsageSnapshot(Date.now()),
    },
    resources: {
      overview: () => shellStoryResourcesOverview(Date.now()),
    },
  });
}

function forgetFixtureProjectIcons(): void {
  for (const projectId of SHELL_STORY_PROJECT_IDS) {
    const prefix = `${PROJECT_ICON_CACHE_KEY_PREFIX}${projectId}:`;

    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith(prefix)) window.localStorage.removeItem(key);
    }
  }
}

interface ShellStoryFixturesProps {
  scope: SidebarScope;
  routePath: string;
  children: ReactNode;
}

function ShellStoryFixtures({
  scope,
  routePath,
  children,
}: ShellStoryFixturesProps) {
  const queryClient = useQueryClient();
  const store = useStore();
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const routedRef = useRef(false);

  useLayoutEffect(() => {
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      SHELL_STORY_NAVIGATION,
    );
    forgetFixtureProjectIcons();

    const restores = [
      installStoryRealtimeConnected(),
      installShellPluginRpc(),
      installStoryHostFiles(SHELL_STORY_HOST_FILES),
      installStoryProjectFileImages(SHELL_STORY_PROJECT_FILE_IMAGES),
      registerShellPlugins(),
    ];

    store.set(sidebarScopeAtom, scope);
    setReady(true);

    return () => {
      for (const restore of restores.reverse()) restore();
    };
  }, [queryClient, scope, store]);

  useEffect(() => {
    if (routedRef.current) return;
    routedRef.current = true;
    void navigate(routePath, { replace: true });
  }, [navigate, routePath]);

  return ready ? children : null;
}

function shellModeForPath(pathname: string): AppLayoutSidebarMode {
  if (matchPath(`${SETTINGS_ROUTE_PATH}/*`, pathname) !== null) {
    return "settings";
  }

  if (isPluginsRoutePath(pathname)) return "plugins";

  return isSkillsRoutePath(pathname) ? "skills" : "app";
}

function useScopeLabel(): string {
  const scope = useSidebarScope();
  const { data } = useSidebarCatalog();

  if (scope.kind === "inbox") return "Inbox";

  const project = [
    ...(data?.projects ?? []),
    ...(data === undefined ? [] : [data.personalProject]),
  ].find((candidate) => candidate.id === scope.projectId);

  return project?.name ?? scope.projectId;
}

function useOpenChatTitle(): string {
  const { threadId } = useRouteState();
  const { data } = useSidebarCatalog();

  if (threadId === undefined) return "New chat";

  const thread = [
    ...(data?.projects ?? []),
    ...(data === undefined ? [] : [data.personalProject]),
  ]
    .flatMap((project) => project.threads)
    .find((candidate) => candidate.id === threadId);

  return thread?.title ?? threadId;
}

function ShellStoryContent({ note }: { note: string }) {
  const scopeLabel = useScopeLabel();
  const title = useOpenChatTitle();

  return (
    <div
      data-app-content-shell=""
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-seam px-4">
        <SidebarTrigger />
        <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-3 p-5 text-sm text-muted-foreground">
        <p className="max-w-lg">{note}</p>
        <p data-testid="sidebar-shell-story-scope">
          List scope:{" "}
          <span className="font-medium text-foreground">{scopeLabel}</span>
        </p>
      </main>
    </div>
  );
}

function ScrollProjectRailToMiddle() {
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const projects = document.querySelector<HTMLElement>(
        '[data-testid="nav-rail-projects"]',
      );

      if (projects === null) return;
      projects.scrollTop = (projects.scrollHeight - projects.clientHeight) / 2;
    });

    return () => window.cancelAnimationFrame(frame);
  }, []);

  return null;
}

function SidebarShellStory({
  scope,
  routePath,
  note,
  children,
}: {
  scope: SidebarScope;
  routePath: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <SettingsStoryFixtures hosts={SHELL_STORY_HOSTS}>
      <ShellStoryFixtures scope={scope} routePath={routePath}>
        <QuickCreateProjectProvider>
          <ShellStoryFrame note={note}>{children}</ShellStoryFrame>
        </QuickCreateProjectProvider>
      </ShellStoryFixtures>
    </SettingsStoryFixtures>
  );
}

function ShellStoryFrame({
  note,
  children,
}: {
  note: string;
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const { data: navigation } = useSidebarCatalog();
  const { appRoutePath, settingsRoutePath } = useAppSettingsRouteMemory();
  const mode = shellModeForPath(pathname);

  return (
    <SidebarThreadEntriesProvider navigation={navigation}>
      <ProjectActionsProvider>
        <ActionHistoryProvider>
          <ThreadActionsProvider>
            <SidebarProvider
              collapsedRailWidth={NAV_RAIL_COLLAPSED_SIDEBAR_WIDTH}
              className="h-(--omnyo-shell-height) bg-background"
            >
              <AppShellFrame
                mode={mode}
                onResizeMouseDown={() => {}}
                isResizing={false}
                settingsToggleRoutePath={
                  mode === "settings" ? appRoutePath : settingsRoutePath
                }
              >
                <ShellStoryContent note={note} />
              </AppShellFrame>
              {children}
            </SidebarProvider>
          </ThreadActionsProvider>
        </ActionHistoryProvider>
      </ProjectActionsProvider>
    </SidebarThreadEntriesProvider>
  );
}

const PROJECT_SCOPE: SidebarScope = {
  kind: "project",
  projectId: SHELL_STORY_SCOPED_PROJECT_ID,
};

export function Inbox() {
  return (
    <SidebarShellStory
      scope={INBOX_SIDEBAR_SCOPE}
      routePath={getRootComposeRoutePath()}
      note="Inbox scope: the list shows every project. Click a project tile to scope the list to it, or the Inbox tile to return. At 390 wide, open the sidebar to see the drawer."
    />
  );
}

export function Project() {
  return (
    <SidebarShellStory
      scope={PROJECT_SCOPE}
      routePath={getThreadRoutePath({
        projectId: SHELL_STORY_SCOPED_PROJECT_ID,
        threadId: SHELL_STORY_OPEN_THREAD_ID,
      })}
      note="Project scope on an open chat: the list shows only omnyo-private. Sub-chats follow the bundled list's own collapse preference; Chat Topics starts them collapsed in the installed app."
    />
  );
}

export function Overflow() {
  return (
    <SidebarShellStory
      scope={INBOX_SIDEBAR_SCOPE}
      routePath={getRootComposeRoutePath()}
      note="View at 1440x700. The project list starts mid-scroll, so it fades at both edges above the separator; the projects and destinations scroll independently when their lists overflow."
    >
      <ScrollProjectRailToMiddle />
    </SidebarShellStory>
  );
}

// @vitest-environment jsdom
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { createStore, Provider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  MemoryRouter,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import {
  SidebarProvider,
  SidebarTrigger,
  useCloseMobileSidebar,
  useSidebar,
} from "@/components/ui/sidebar";
import { AppLayoutSidebar } from "@/components/layout/AppLayoutSidebar";
import {
  pluginNavPanelOrderAtom,
  pluginNavVisiblePanelKeysAtom,
} from "@/components/plugin/pluginNavSidebarAtoms";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { writeLastKnownPluginNavPanelChrome } from "@/lib/plugin-nav-panel-chrome";
import {
  AUTOMATIONS_PLUGIN_ID,
  getPluginPanelRoutePath,
  getThreadRoutePath,
  isPluginsRoutePath,
  NEEDS_YOU_PANEL,
  SETTINGS_ROUTE_PATH,
} from "@/lib/route-paths";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { SidebarUpdatesBadge } from "./SidebarUpdatesBadge";
import {
  AppNavRail,
  NavRailNewThreadButton,
  NavRailSettingsButton,
} from "./AppNavRail";
import { SidebarVisibilityCustomize } from "./SidebarVisibilityControls";
import { SidebarNavigationModelProvider } from "./SidebarNavigationModel";
import { useSidebarScopeFollowsLocation } from "./sidebarScope";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  railJump: (_index: number): boolean => false,
  onNavigate: vi.fn(),
  onNewChat: vi.fn(),
  navigate: (() => {}) as NavigateFunction,
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandRunner: () => ({
    dispatch: mocks.dispatch,
    isCommandAvailable: () => true,
  }),
  useIndexedAppCommandHandlers: (
    _commands: readonly string[],
    handler: (index: number) => boolean,
  ) => {
    mocks.railJump = handler;
  },
  useAppCommandShortcuts: () => new Map(),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    isAvailable: true,
    isCreating: false,
    openCreateDialog: vi.fn(),
  }),
}));

vi.mock("@/components/sidebar/AppSidebar", () => ({
  AppSidebar: ({
    renderRail,
    railFooter,
  }: {
    railFooter: ReactNode;
    renderRail: (customize: {
      isOpen: boolean;
      onOpenChange: () => void;
    }) => ReactNode;
  }) => (
    <>
      {renderRail({ isOpen: false, onOpenChange: () => {} })}
      {railFooter}
    </>
  ),
}));

vi.mock("@/components/settings/SettingsSidebar", () => ({
  SettingsSidebar: () => null,
}));

vi.mock("@/components/tools/ResourceSidebar", () => ({
  ResourceSidebar: () => null,
}));

vi.mock("@/hooks/useUpdateInventory", () => ({
  useUpdateInventory: () => ({
    appUpdateAvailable: true,
    desktopUpdateReady: false,
    machines: [],
    isLoading: false,
  }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: [] }),
}));

vi.mock("@/hooks/useMachineAttention", () => ({
  useMachineAttention: () => ({ label: null }),
}));

vi.mock("@/components/provider-cli/provider-cli-install", () => ({
  useProviderCliInstallRunner: () => ({ runningJobKey: null }),
}));

const CATALOG = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_one",
      name: "One",
      threads: [makeThreadListEntry({ id: "thr_one", projectId: "proj_one" })],
    }),
    makeProjectWithThreadsResponse({ id: "proj_empty", name: "Empty" }),
  ],
});

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({ data: CATALOG, isPlaceholderData: false }),
}));

vi.mock("@/hooks/queries/host-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/host-queries")>()),
  useHosts: () => ({ data: [] }),
}));

const resizeObservers: ControlledResizeObserver[] = [];

class ControlledResizeObserver {
  readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {}
}

function resizeRail(
  element: HTMLElement,
  metrics: { clientHeight?: number; scrollHeight?: number; scrollTop?: number },
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }

  act(() => {
    for (const observer of [...resizeObservers]) {
      observer.callback([], observer);
    }
  });
}

const THREAD_PATH = getThreadRoutePath({
  projectId: "proj_one",
  threadId: "thr_one",
});

const PROJECT_TILES = ["One", "Empty", "Personal", "Add project"];

const CANVAS_PATH = getPluginPanelRoutePath({ pluginId: "canvas", path: "p" });

const NEEDS_YOU_PATH = getPluginPanelRoutePath(NEEDS_YOU_PANEL);

function registerCanvas() {
  setPluginSlotRegistrations(
    "canvas",
    registrationSet({
      navPanels: [
        {
          id: "project-canvas",
          title: "Canvas",
          icon: "GridView",
          path: "p",
          component: () => null,
        },
      ],
    }),
  );
}

function registerNeedsYou() {
  setPluginSlotRegistrations(
    NEEDS_YOU_PANEL.pluginId,
    registrationSet({
      navPanels: [
        {
          id: NEEDS_YOU_PANEL.path,
          title: "Needs you",
          icon: "Circle",
          path: NEEDS_YOU_PANEL.path,
          component: () => null,
        },
      ],
      sidebarEntries: [
        {
          id: NEEDS_YOU_PANEL.pluginId,
          title: "Needs you",
          icon: "Circle",
          panel: NEEDS_YOU_PANEL.path,
          tooltip: "Needs you",
        },
      ],
    }),
  );
}

const ALL_KEYS = [
  "__core__/new-thread",
  "__core__/search-threads",
  "__core__/extensions",
  "__core__/skills",
  "garden/docs",
];

const DOCS_PATH = getPluginPanelRoutePath({ pluginId: "garden", path: "docs" });

const AUTOMATIONS_PLUGIN_PANEL_PATH = "automations";

function RailHarness({ useLayout = false }: { useLayout?: boolean }) {
  const closeMobileSidebar = useCloseMobileSidebar();
  const { isCompactViewport, open, openMobile } = useSidebar();
  const location = useLocation();
  const isSettings = location.pathname.startsWith(SETTINGS_ROUTE_PATH);
  const { appRoutePath, settingsRoutePath } = useAppSettingsRouteMemory();
  const settingsToggleRoutePath = isSettings ? appRoutePath : settingsRoutePath;
  const isAppMode = !isSettings && !isPluginsRoutePath(location.pathname);
  const [isCustomizing, setCustomizing] = useState(false);
  const navigate = useNavigate();

  useSidebarScopeFollowsLocation();

  useEffect(() => {
    mocks.navigate = navigate;
  }, [navigate]);

  return (
    <SidebarNavigationModelProvider
      onNavigate={mocks.onNavigate}
      onNewChat={mocks.onNewChat}
      splitEnabled={false}
    >
      {useLayout ? (
        <>
          <AppLayoutSidebar
            mode={isSettings ? "settings" : "app"}
            onResizeMouseDown={() => {}}
            isResizing={false}
            settingsToggleRoutePath={settingsToggleRoutePath}
          />
          <SidebarTrigger />
          <SidebarUpdatesBadge onNavigate={closeMobileSidebar} />
        </>
      ) : (
        <>
          <AppNavRail
            isAppMode={isAppMode}
            customize={{ isOpen: isCustomizing, onOpenChange: setCustomizing }}
          />
          <NavRailSettingsButton
            isSettingsActive={isSettings}
            settingsToggleRoutePath={settingsToggleRoutePath}
          />
        </>
      )}
      <NavRailNewThreadButton />
      <output data-testid="pathname">{location.pathname}</output>
      <output data-testid="thread-list-showing">
        {String(isCompactViewport ? openMobile : open)}
      </output>
    </SidebarNavigationModelProvider>
  );
}

function renderRail(
  initialPath: string,
  options: {
    visibleKeys?: string[];
    isCompactViewport?: boolean;
    isFramed?: boolean;
    useLayout?: boolean;
  } = {},
) {
  const store = createStore();

  if (options.visibleKeys) {
    store.set(pluginNavPanelOrderAtom, ALL_KEYS);
    store.set(pluginNavVisiblePanelKeysAtom, options.visibleKeys);
  }

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Provider store={store}>
        <MemoryRouter initialEntries={[initialPath]}>
          <CompactViewportOverrideProvider
            isCompactViewport={options.isCompactViewport ?? false}
          >
            <TooltipProvider>
              <SidebarProvider framed={options.isFramed ?? false}>
                <RailHarness useLayout={options.useLayout} />
              </SidebarProvider>
            </TooltipProvider>
          </CompactViewportOverrideProvider>
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
}

function rail(): HTMLElement {
  return screen.getByTestId("app-nav-rail");
}

function railButton(name: string): HTMLElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="app-nav-rail"] button, button[aria-label="Settings"]',
    ),
  ).find((candidate) => candidate.getAttribute("aria-label") === name);

  if (!button) throw new Error(`Expected a rail button named ${name}`);

  return button;
}

function railLabels(): (string | null)[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="app-nav-rail"] button, button[aria-label="Settings"]',
    ),
    (button) => button.getAttribute("aria-label"),
  );
}

function currentRailLabels(): (string | null)[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="app-nav-rail"] button[aria-current], button[aria-label="Settings"][aria-current="page"]',
    ),
    (button) => button.getAttribute("aria-label"),
  );
}

function pressedRailLabels(): (string | null)[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      '[data-testid="app-nav-rail"] button[aria-pressed="true"]',
    ),
    (button) => button.getAttribute("aria-label"),
  );
}

function railLabelsWith(destinations: string[]): string[] {
  return ["Inbox", ...PROJECT_TILES, "More", ...destinations, "Settings"];
}

function threadListShowing(): string | null {
  return screen.getByTestId("thread-list-showing").textContent;
}

function pathname(): string | null {
  return screen.getByTestId("pathname").textContent;
}

beforeAll(async () => {
  await SidebarVisibilityCustomize.preload();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginFrontendBootStateForTest();
  markPluginFrontendsSettled();
  window.localStorage.clear();
  setPluginSlotRegistrations(
    "garden",
    registrationSet({
      navPanels: [
        {
          id: "docs",
          title: "Docs",
          icon: "BookOpen",
          path: "docs",
          component: () => null,
        },
      ],
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resizeObservers.length = 0;
  resetPluginFrontendBootStateForTest();
  resetPluginSlotStoreForTest();
  window.localStorage.clear();
});

describe("AppNavRail", () => {
  it("opens Canvas from the single tile directly below Inbox", () => {
    registerCanvas();
    renderRail("/");

    expect(railLabels()).toEqual([
      "Inbox",
      "Canvas",
      ...PROJECT_TILES,
      "More",
      "Docs",
      "Skills",
      "Plugins",
      "Settings",
    ]);

    fireEvent.click(railButton("Canvas"));
    expect(pathname()).toBe(CANVAS_PATH);
    expect(currentRailLabels()).toContain("Canvas");
  });

  it.each(["/", SETTINGS_ROUTE_PATH])(
    "opens Needs you from Inbox when %s has no chat to restore",
    (path) => {
      registerNeedsYou();
      renderRail(path);

      fireEvent.click(railButton("Inbox"));
      expect(pathname()).toBe(NEEDS_YOU_PATH);
      expect(threadListShowing()).toBe("true");
    },
  );

  it.each(["/", SETTINGS_ROUTE_PATH])(
    "honors the first Inbox click from %s after delayed registration",
    (path) => {
      resetPluginFrontendBootStateForTest();
      renderRail(path);

      fireEvent.click(railButton("Inbox"));
      act(() => registerNeedsYou());

      expect(pathname()).toBe(NEEDS_YOU_PATH);
    },
  );

  it.each([THREAD_PATH, DOCS_PATH, SETTINGS_ROUTE_PATH, "/"])(
    "cancels pending Inbox navigation after navigating to %s",
    (path) => {
      resetPluginFrontendBootStateForTest();
      renderRail("/");
      fireEvent.click(railButton("Inbox"));

      act(() => {
        void mocks.navigate(path);
      });
      act(() => registerNeedsYou());

      expect(pathname()).toBe(path);
    },
  );

  it("cancels pending Inbox navigation when another scope is selected", () => {
    resetPluginFrontendBootStateForTest();
    renderRail("/");
    fireEvent.click(railButton("Inbox"));
    fireEvent.click(railButton("Empty"));
    act(() => registerNeedsYou());

    expect(pathname()).toBe("/");
    expect(pressedRailLabels()).toEqual(["Empty"]);
  });

  it("settles pending Inbox navigation without a disabled or unavailable panel", () => {
    resetPluginFrontendBootStateForTest();
    renderRail(SETTINGS_ROUTE_PATH);
    fireEvent.click(railButton("Inbox"));
    act(() => markPluginFrontendsSettled());

    expect(pathname()).toBe("/");
    act(() => registerNeedsYou());
    expect(pathname()).toBe("/");
  });

  it("does not open a late Inbox panel without an explicit selection", () => {
    resetPluginFrontendBootStateForTest();
    renderRail("/");
    act(() => registerNeedsYou());
    expect(pathname()).toBe("/");
  });

  it("closes the compact sidebar when pending Inbox navigation resolves", () => {
    resetPluginFrontendBootStateForTest();
    vi.useFakeTimers();
    renderRail("/", { isCompactViewport: true, useLayout: true });
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));
    fireEvent.click(railButton("Inbox"));
    expect(threadListShowing()).toBe("true");
    act(() => registerNeedsYou());
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));

    expect(pathname()).toBe(NEEDS_YOU_PATH);
    expect(threadListShowing()).toBe("false");
  });

  it("restores an existing chat immediately while Inbox registration is pending", () => {
    resetPluginFrontendBootStateForTest();
    renderRail(THREAD_PATH);
    fireEvent.click(railButton("Settings"));
    fireEvent.click(railButton("Inbox"));
    expect(pathname()).toBe(THREAD_PATH);

    act(() => registerNeedsYou());
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("uses the open chat and restores it from Canvas when Needs you is available", () => {
    registerCanvas();
    registerNeedsYou();
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Inbox"));
    expect(pathname()).toBe(THREAD_PATH);

    fireEvent.click(railButton("Canvas"));
    expect(pathname()).toBe(CANVAS_PATH);

    fireEvent.click(railButton("Inbox"));
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("jumps through Inbox and rendered projects using the same scope action", () => {
    renderRail(THREAD_PATH);

    act(() => {
      expect(mocks.railJump?.(2)).toBe(true);
    });
    expect(pressedRailLabels()).toEqual(["Empty"]);
    expect(pathname()).toBe(THREAD_PATH);
    act(() => {
      expect(mocks.railJump?.(0)).toBe(true);
    });
    expect(pressedRailLabels()).toEqual(["Inbox"]);
    act(() => {
      expect(mocks.railJump?.(3)).toBe(true);
    });
    expect(pressedRailLabels()).toEqual(["Personal"]);
    act(() => {
      expect(mocks.railJump?.(4)).toBe(false);
    });
    expect(mocks.onNewChat).not.toHaveBeenCalled();
  });

  it("uses rendered rail order after hiding a project", () => {
    renderRail(THREAD_PATH);
    fireEvent.contextMenu(railButton("One"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from rail" }));

    act(() => {
      expect(mocks.railJump?.(1)).toBe(true);
    });
    expect(pressedRailLabels()).toEqual(["Empty"]);
  });

  it("returns from settings and opens the list through a numbered project", () => {
    renderRail(SETTINGS_ROUTE_PATH);
    act(() => {
      expect(mocks.railJump?.(1)).toBe(true);
    });
    expect(pressedRailLabels()).toEqual(["One"]);
    expect(threadListShowing()).toBe("true");
    expect(pathname()).toBe("/");
  });

  it.each([{ isCompactViewport: true }, { isCompactViewport: false }])(
    "keeps live account usage out of the rail ($isCompactViewport)",
    ({ isCompactViewport }) => {
      setPluginSlotRegistrations(
        "omnyo--account-usage",
        registrationSet({
          sidebarFooterCards: [
            {
              id: "usage",
              component: () => (
                <span role="img" aria-label="Claude work 75% remaining" />
              ),
            },
          ],
        }),
      );
      renderRail(THREAD_PATH, { isCompactViewport });
      expect(
        within(rail()).queryByRole("img", {
          name: "Claude work 75% remaining",
        }),
      ).toBeNull();
      expect(railButton("Settings")).toBeDefined();
      expect(pathname()).toBe(THREAD_PATH);
    },
  );

  it("lists the Inbox, every project with Personal last, then destinations stacked up from the corner under More", () => {
    renderRail(THREAD_PATH);

    expect(railLabels()).toEqual(railLabelsWith(["Docs", "Skills", "Plugins"]));
    expect(
      within(screen.getByRole("group", { name: "Projects" }))
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(PROJECT_TILES);
    expect(pressedRailLabels()).toEqual(["Inbox"]);
    expect(currentRailLabels()).toEqual(["One"]);
  });

  it("marks the project of a project-scoped plugin page in the Inbox scope", () => {
    renderRail(
      getPluginPanelRoutePath({
        pluginId: "garden",
        path: "docs",
        subPath: "proj_empty/v/view_board",
      }),
    );

    expect(pressedRailLabels()).toEqual(["Inbox"]);
    expect(currentRailLabels()).toEqual(["Empty", "Docs"]);
    expect(
      railButton("Empty").querySelector<HTMLElement>("[data-rail-tile-pill]")
        ?.dataset.railTilePill,
    ).toBe("current");
  });

  it("scopes the list from the project tiles without leaving the chat", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Empty"));
    expect(pressedRailLabels()).toEqual(["Empty"]);
    expect(
      JSON.parse(window.localStorage.getItem("omnyo.sidebar.scope") ?? ""),
    ).toEqual({ kind: "project", projectId: "proj_empty" });
    expect(pathname()).toBe(THREAD_PATH);

    fireEvent.click(railButton("Inbox"));
    expect(pressedRailLabels()).toEqual(["Inbox"]);
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("keeps the list open when the selected tile is clicked again", () => {
    renderRail(THREAD_PATH);
    expect(threadListShowing()).toBe("true");

    fireEvent.click(railButton("Inbox"));
    fireEvent.click(railButton("Inbox"));
    expect(threadListShowing()).toBe("true");
    expect(pressedRailLabels()).toEqual(["Inbox"]);
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("returns the selected tile to the chat from a plugin panel without hiding the list", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Docs"));
    fireEvent.click(railButton("Inbox"));

    expect(pathname()).toBe(THREAD_PATH);
    expect(threadListShowing()).toBe("true");
  });

  it("keeps the compact drawer open when the selected tile is tapped again", () => {
    vi.useFakeTimers();
    renderRail(THREAD_PATH, { isCompactViewport: true, useLayout: true });
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));
    expect(threadListShowing()).toBe("true");

    fireEvent.click(railButton("Inbox"));
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));

    expect(threadListShowing()).toBe("true");
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("keeps the clicked project tile when it returns to the last chat from a project's plugin page", () => {
    window.localStorage.setItem(
      "omnyo.sidebar.scope",
      JSON.stringify({ kind: "project", projectId: "proj_one" }),
    );
    renderRail(THREAD_PATH);

    act(() => {
      void mocks.navigate(
        getPluginPanelRoutePath({
          pluginId: "garden",
          path: "docs",
          subPath: "proj_empty/v/view_board",
        }),
      );
    });
    expect(pressedRailLabels()).toEqual(["Empty"]);

    fireEvent.click(railButton("Personal"));

    expect(pathname()).toBe(THREAD_PATH);
    expect(pressedRailLabels()).toEqual(["Personal"]);
  });

  it("returns a project tile to the last chat from Settings", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Settings"));
    fireEvent.click(railButton("One"));

    expect(pathname()).toBe(THREAD_PATH);
    expect(pressedRailLabels()).toEqual(["One"]);
  });

  it("keeps visible destinations on the rail and hidden destinations in More when the rail is short", async () => {
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    renderRail(THREAD_PATH);

    resizeRail(screen.getByRole("navigation", { name: "Primary navigation" }), {
      clientHeight: 300,
    });

    expect(railLabels()).toEqual(railLabelsWith(["Docs", "Skills", "Plugins"]));

    fireEvent.keyDown(railButton("More"), { key: "Enter" });
    const menu = await screen.findByTestId("nav-rail-more-menu");

    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Search threads", "Customize rail"]);
  });

  it("separates and fades the project list only while it overflows", () => {
    vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
    renderRail(THREAD_PATH);
    const projects = screen.getByTestId("nav-rail-projects");

    const fades = () => ({
      top: projects.hasAttribute("data-fade-top"),
      bottom: projects.hasAttribute("data-fade-bottom"),
    });

    expect(screen.queryByTestId("nav-rail-separator")).toBeNull();
    expect(fades()).toEqual({ top: false, bottom: false });

    resizeRail(projects, {
      clientHeight: 120,
      scrollHeight: 400,
      scrollTop: 0,
    });
    expect(screen.getByTestId("nav-rail-separator")).toBeDefined();
    expect(fades()).toEqual({ top: false, bottom: true });

    Object.defineProperty(projects, "scrollTop", {
      configurable: true,
      value: 280,
    });
    fireEvent.scroll(projects);
    expect(fades()).toEqual({ top: true, bottom: false });

    resizeRail(projects, {
      clientHeight: 400,
      scrollHeight: 400,
      scrollTop: 0,
    });
    expect(screen.queryByTestId("nav-rail-separator")).toBeNull();
    expect(fades()).toEqual({ top: false, bottom: false });
  });

  it("moves the highlight to a plugin panel and to Settings as the route changes", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Docs"));
    expect(pathname()).toBe(DOCS_PATH);
    expect(currentRailLabels()).toEqual(["Docs"]);

    fireEvent.click(railButton("Settings"));
    expect(pathname()).toBe(SETTINGS_ROUTE_PATH);
    expect(currentRailLabels()).toEqual(["Settings"]);

    fireEvent.click(railButton("Plugins"));
    expect(currentRailLabels()).toEqual(["Plugins"]);
  });

  it("keeps a plugin panel highlighted on its nested routes", () => {
    renderRail(`${DOCS_PATH}/guides/getting-started.md`);

    expect(currentRailLabels()).toEqual(["Docs"]);
  });

  it("lists the Automations panel as a destination", () => {
    setPluginSlotRegistrations(
      AUTOMATIONS_PLUGIN_ID,
      registrationSet({
        navPanels: [
          {
            id: AUTOMATIONS_PLUGIN_PANEL_PATH,
            title: "Automations",
            icon: "Calendar",
            path: AUTOMATIONS_PLUGIN_PANEL_PATH,
            component: () => null,
          },
        ],
      }),
    );

    renderRail(THREAD_PATH);

    expect(railButton("Automations")).toBeDefined();
  });

  it("draws a remembered plugin panel before boot and keeps the same button when the plugin registers", () => {
    resetPluginSlotStoreForTest();
    resetPluginFrontendBootStateForTest();
    writeLastKnownPluginNavPanelChrome([
      {
        pluginId: "demo",
        id: "board",
        path: "board",
        title: "Demo board",
        icon: "columns",
      },
    ]);
    renderRail(THREAD_PATH);
    const remembered = railButton("Demo board");

    act(() => {
      setPluginSlotRegistrations(
        "demo",
        registrationSet({
          navPanels: [
            {
              id: "board",
              title: "Demo board",
              icon: "columns",
              path: "board",
              component: () => null,
            },
          ],
        }),
      );
      markPluginFrontendsSettled();
    });

    expect(railButton("Demo board")).toBe(remembered);
  });

  it("drops a remembered plugin panel that never registers once frontends have settled", () => {
    resetPluginSlotStoreForTest();
    resetPluginFrontendBootStateForTest();
    writeLastKnownPluginNavPanelChrome([
      {
        pluginId: "ghost",
        id: "board",
        path: "board",
        title: "Ghost board",
        icon: "columns",
      },
    ]);
    renderRail(THREAD_PATH);
    expect(railButton("Ghost board")).toBeDefined();

    act(() => markPluginFrontendsSettled());

    expect(railLabels()).not.toContain("Ghost board");
  });

  it("returns the Inbox to the last thread, skipping plugin panels and Settings visited since", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Docs"));
    fireEvent.click(railButton("Settings"));
    fireEvent.click(railButton("Inbox"));

    expect(pathname()).toBe(THREAD_PATH);
    expect(currentRailLabels()).toEqual(["One"]);
    expect(pressedRailLabels()).toEqual(["Inbox"]);
  });

  it("returns the Inbox to the last thread after settings navigation closes the compact sidebar", () => {
    vi.useFakeTimers();
    renderRail(THREAD_PATH, { isCompactViewport: true, useLayout: true });
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));

    fireEvent.click(
      screen.getByRole("link", { name: "Omnyo update available" }),
    );
    expect(pathname()).toBe(`${SETTINGS_ROUTE_PATH}/updates`);
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    act(() => vi.advanceTimersByTime(MOTION_DURATION_MS.drawer));
    fireEvent.click(railButton("Inbox"));

    expect(pathname()).toBe(THREAD_PATH);
    expect(currentRailLabels()).toEqual(["One"]);
  });

  it("sends the Inbox to a new thread when the session started outside the thread list", () => {
    renderRail(SETTINGS_ROUTE_PATH);

    expect(currentRailLabels()).toEqual(["Settings"]);
    fireEvent.click(railButton("Inbox"));

    expect(pathname()).toBe("/");
  });

  it("returns from Settings to the previous view on the second cog click", () => {
    renderRail(THREAD_PATH);
    fireEvent.click(railButton("Settings"));
    expect(pathname()).toBe(SETTINGS_ROUTE_PATH);
    fireEvent.click(railButton("Settings"));
    expect(pathname()).toBe(THREAD_PATH);
  });

  it("dismisses the drawer for a plugin panel but not for destinations that swap the list beside the rail", () => {
    renderRail(THREAD_PATH);

    fireEvent.click(railButton("Plugins"));
    fireEvent.click(railButton("Skills"));
    fireEvent.click(railButton("Settings"));
    fireEvent.click(railButton("Inbox"));
    fireEvent.click(railButton("Settings"));
    fireEvent.click(railButton("One"));
    expect(pathname()).toBe(THREAD_PATH);
    expect(mocks.onNavigate).not.toHaveBeenCalled();

    fireEvent.click(railButton("Docs"));
    expect(pathname()).toBe(DOCS_PATH);
    expect(mocks.onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not mount a plugin panel's sidebar accessory", () => {
    const accessoryMounted = vi.fn();
    setPluginSlotRegistrations(
      "garden",
      registrationSet({
        navPanels: [
          {
            id: "docs",
            title: "Docs",
            icon: "BookOpen",
            path: "docs",
            component: () => null,
            experimental_sidebarAccessory: () => {
              accessoryMounted();

              return <span>492/1</span>;
            },
          },
        ],
      }),
    );

    renderRail(THREAD_PATH);

    expect(railButton("Docs")).toBeDefined();
    expect(accessoryMounted).not.toHaveBeenCalled();
    expect(rail().textContent).not.toContain("492/1");
  });

  it("keeps hidden destinations out of the rail", () => {
    renderRail(THREAD_PATH, {
      visibleKeys: ["__core__/new-thread", "__core__/extensions"],
    });

    expect(railLabels()).toEqual(railLabelsWith(["Plugins"]));
  });

  it("keeps hidden destinations reachable from More", async () => {
    renderRail(THREAD_PATH);

    fireEvent.keyDown(railButton("More"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Search threads" }),
    );

    expect(mocks.dispatch).toHaveBeenCalledWith("thread.search", null);
  });

  it("opens the customize sheet from More on a compact viewport", async () => {
    renderRail(THREAD_PATH, { isCompactViewport: true });

    fireEvent.click(railButton("More"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize rail" }),
    );

    const editor = await screen.findByTestId("nav-rail-customize");

    const list = within(editor).getByRole("list", {
      name: "Sidebar navigation",
    });

    fireEvent.click(within(list).getByRole("checkbox", { name: /Skills/u }));
    expect(railLabels()).toEqual(railLabelsWith(["Docs", "Plugins"]));
  });

  it("customizes the rail from a popover beside it without leaving Settings", async () => {
    renderRail(THREAD_PATH);
    fireEvent.click(railButton("Settings"));

    fireEvent.keyDown(railButton("More"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize rail" }),
    );

    const editor = await screen.findByTestId("nav-rail-customize");
    expect(pathname()).toBe(SETTINGS_ROUTE_PATH);
    expect(currentRailLabels()).toEqual(["Settings"]);
    expect(rail().contains(editor)).toBe(false);

    const list = within(editor).getByRole("list", {
      name: "Rail destinations",
    });

    fireEvent.click(
      within(list).getByRole("switch", { name: "Show Skills in rail" }),
    );
    expect(railLabels()).toEqual(railLabelsWith(["Docs", "Plugins"]));
    fireEvent.click(within(list).getByText("Search threads"));
    expect(railLabels()).toEqual(
      railLabelsWith(["Docs", "Plugins", "Search threads"]),
    );

    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("nav-rail-customize")).toBeNull(),
    );
    expect(document.activeElement).toBe(railButton("More"));
    expect(pathname()).toBe(SETTINGS_ROUTE_PATH);
  });

  it("opens the customize popover beside the rail destinations, bottom-aligned so toggles do not move it", async () => {
    renderRail(THREAD_PATH);
    let destinationsTop = 500;
    vi.spyOn(
      screen.getByTestId("nav-rail-destinations"),
      "getBoundingClientRect",
    ).mockImplementation(
      () => new DOMRect(12, destinationsTop, 28, 640 - destinationsTop),
    );

    const viewport = [
      vi
        .spyOn(document.documentElement, "clientWidth", "get")
        .mockReturnValue(1280),
      vi
        .spyOn(document.documentElement, "clientHeight", "get")
        .mockReturnValue(800),
    ];

    try {
      fireEvent.keyDown(railButton("More"), { key: "Enter" });
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Customize rail" }),
      );
      const editor = await screen.findByTestId("nav-rail-customize");

      const wrapper = editor.closest<HTMLElement>(
        "[data-radix-popper-content-wrapper]",
      );

      if (!wrapper) throw new Error("Expected the popover position wrapper");
      await waitFor(() =>
        expect(wrapper.style.transform).toBe("translate(52px, 640px)"),
      );

      destinationsTop = 420;
      fireEvent.click(
        within(editor).getByRole("switch", {
          name: "Show Search threads in rail",
        }),
      );
      fireEvent(window, new Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(wrapper.style.transform).toBe("translate(52px, 640px)");
    } finally {
      for (const spy of viewport) spy.mockRestore();
    }
  });

  it("wiggles rail destinations while customizing and reorders them in the rail", async () => {
    renderRail(THREAD_PATH);

    fireEvent.keyDown(railButton("More"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize rail" }),
    );
    const editor = await screen.findByTestId("nav-rail-customize");

    expect(railButton("Docs").classList.contains("omnyo-rail-wiggle")).toBe(
      true,
    );
    expect(railButton("Plugins").classList.contains("omnyo-rail-wiggle")).toBe(
      true,
    );
    expect(railButton("More").classList.contains("omnyo-rail-wiggle")).toBe(
      false,
    );

    railButton("Docs").focus();
    fireEvent.click(railButton("Docs"));
    expect(pathname()).toBe(THREAD_PATH);
    expect(screen.getByTestId("nav-rail-customize")).toBe(editor);

    fireEvent.keyDown(railButton("Docs"), { key: "ArrowDown", altKey: true });
    expect(railLabels()).toEqual(railLabelsWith(["Skills", "Docs", "Plugins"]));
    expect(document.activeElement).toBe(railButton("Docs"));
    expect(
      within(editor)
        .getAllByRole("switch")
        .map((toggle) => toggle.getAttribute("aria-label")),
    ).toEqual([
      "Show Skills in rail",
      "Show Docs in rail",
      "Show Plugins in rail",
      "Show Search threads in rail",
    ]);

    fireEvent.click(within(editor).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByTestId("nav-rail-customize")).toBeNull(),
    );
    expect(railButton("Docs").classList.contains("omnyo-rail-wiggle")).toBe(
      false,
    );
    expect(railLabels()).toEqual(railLabelsWith(["Skills", "Docs", "Plugins"]));
  });

  it("opens the More menu beside the More button instead of at the top of the rail", async () => {
    renderRail(THREAD_PATH);
    vi.spyOn(railButton("Inbox"), "getBoundingClientRect").mockImplementation(
      () => new DOMRect(12, 40, 28, 28),
    );
    vi.spyOn(railButton("More"), "getBoundingClientRect").mockImplementation(
      () => new DOMRect(12, 200, 28, 28),
    );

    const viewport = [
      vi
        .spyOn(document.documentElement, "clientWidth", "get")
        .mockReturnValue(1280),
      vi
        .spyOn(document.documentElement, "clientHeight", "get")
        .mockReturnValue(800),
    ];

    try {
      fireEvent.keyDown(railButton("More"), { key: "Enter" });
      const menu = await screen.findByTestId("nav-rail-more-menu");

      const wrapper = menu.closest<HTMLElement>(
        "[data-radix-popper-content-wrapper]",
      );

      if (!wrapper) throw new Error("Expected the menu position wrapper");

      await waitFor(() =>
        expect(wrapper.style.transform).toBe("translate(52px, 200px)"),
      );
    } finally {
      for (const spy of viewport) spy.mockRestore();
    }
  });

  it("keeps the header New thread button when stored preferences leave New thread out", () => {
    renderRail(THREAD_PATH, { visibleKeys: ["__core__/extensions"] });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(mocks.onNewChat).toHaveBeenCalledTimes(1);
  });

  it("offers no New thread row in Customize rail", async () => {
    renderRail(THREAD_PATH);

    fireEvent.keyDown(railButton("More"), { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize rail" }),
    );

    const editor = await screen.findByTestId("nav-rail-customize");

    const list = within(editor).getByRole("list", {
      name: "Rail destinations",
    });

    expect(
      within(list)
        .getAllByRole("switch")
        .map((toggle) => toggle.getAttribute("aria-label")),
    ).toEqual([
      "Show Docs in rail",
      "Show Skills in rail",
      "Show Plugins in rail",
      "Show Search threads in rail",
    ]);
    expect(screen.getByRole("button", { name: "New thread" })).toBeDefined();
  });
});

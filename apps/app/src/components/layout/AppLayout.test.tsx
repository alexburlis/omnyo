// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderWithoutClient,
  screen,
  waitFor,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider, useAtomValue } from "jotai";
import { wsManager } from "@/lib/ws";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { defaultAppSettings } from "@omnyo/domain";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { createPortal } from "react-dom";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import {
  useEffect,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { AppLayout } from "./AppLayout";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  sidebarScopeAtom,
  useSidebarScope,
} from "@/components/sidebar/sidebarScope";
import { setCompactSecondaryPanelPresentation } from "@/components/ui/secondary-panel-shelf-visibility";
import { beginSplitDrag } from "@/lib/split-drag";

function render(ui: ReactNode) {
  const { wrapper } = createQueryClientTestHarness();

  return renderWithoutClient(ui, { wrapper });
}

const useThreadDetailBootstrapMock = vi.hoisted(() =>
  vi.fn(
    (): {
      data?: { projectId: string };
      isError: boolean;
      isSuccess: boolean;
    } => ({ isError: false, isSuccess: false }),
  ),
);

const SIDEBAR_WIDTH_STORAGE_KEY = "omnyo.sidebar.width";

const SIDEBAR_OPEN_STORAGE_KEY = "omnyo.sidebar.open";

const APP_ROUTE = "/projects/proj_one/threads/thr_one?message=12#event-12";

const SETTINGS_ROUTE = "/settings/providers/codex?tab=models#preferred";

const PLUGINS_ROUTE = "/plugins/ui-patterns?tab=settings#source";

const SECONDARY_ROUTES = [SETTINGS_ROUTE, PLUGINS_ROUTE];

vi.mock("./AppLayoutSidebar", async () => {
  const { Sidebar } = await vi.importActual<
    typeof import("@/components/ui/sidebar")
  >("@/components/ui/sidebar");

  return {
    AppLayoutSidebar: ({
      onResizeMouseDown,
    }: {
      onResizeMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
    }) => (
      <Sidebar>
        <div data-testid="sidebar-body">App sidebar</div>
        <div data-testid="resize-handle" onMouseDown={onResizeMouseDown} />
      </Sidebar>
    ),
  };
});

vi.mock("./AppFooter", () => ({
  AppFooter: ({
    isSettingsActive,
    settingsToggleRoutePath,
  }: {
    isSettingsActive: boolean;
    settingsToggleRoutePath: string;
  }) => (
    <footer
      data-testid="app-footer"
      data-settings-active={isSettingsActive}
      data-settings-route={settingsToggleRoutePath}
    />
  ),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      experiments: {},
      generalSettings: defaultAppSettings,
      keybindings: [
        {
          command: "app.back",
          desktopOnly: false,
          shortcut: {
            key: "Escape",
            mod: false,
            meta: false,
            control: false,
            alt: false,
            shift: false,
          },
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ],
    },
  }),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ hasDaemon: false }),
  useLocalHostDaemonAccess: () => ({ accessState: "unavailable" }),
}));

vi.mock("@/hooks/usePluginSafeModeCommands", () => ({
  usePluginSafeModeCommands: () => undefined,
}));

vi.mock("@/components/project/ProjectActionsProvider", () => ({
  ProjectActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => ({}));

vi.mock("@/components/thread/ThreadActionsProvider", () => ({
  ThreadActionsProvider: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/dialogs/ProjectPathDialog", () => ({
  ProjectPathDialog: () => null,
}));

vi.mock("./AppPageHeader", () => ({
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  AppPageHeader: () => <header />,
}));

vi.mock("@/lib/omnyo-desktop", () => ({
  BROWSER_SIDEBAR_TRIGGER_INSET_CLASS: "",
  CHROME_ROW_CLASS: "",
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  MACOS_APP_REGION_NO_DRAG_CLASS: "",
  MACOS_CHROME_CONTROL_AXIS_CLASS: "",
  MACOS_CHROME_CONTROL_NO_DRAG_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_OFFSET_CLASS: "",
  MACOS_TRAFFIC_LIGHT_RESERVE_PADDING_CLASS: "",
  MACOS_WINDOW_DRAG_CLASS: "",
  MACOS_WINDOW_NO_DRAG_CLASS: "",
  getOmnyoDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/lib/favicon-color-preference", () => ({
  useFaviconBadge: vi.fn(),
}));

vi.mock("@/hooks/useQuickCreateProject", () => ({
  useQuickCreateProjectController: () => ({
    hostId: null,
    hostName: null,
    isCreating: false,
    platform: "darwin",
    projectPathDialog: { onOpenChange: vi.fn(), target: null },
    submitProjectPath: vi.fn(),
  }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      orderedProjectIds: ["proj_personal"],
      sections: [
        { id: "sec_planning", name: "Planning" },
        { id: "sec_building", name: "Building" },
      ],
      personalProject: {
        id: "proj_personal",
        kind: "personal",
        name: "Personal",
        sources: [],
        threads: [],
        defaultExecutionOptions: null,
        createdAt: 1,
        updatedAt: 1,
      },
      projects: [],
    },
    isError: false,
    isSuccess: true,
  }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useArchivedThreads: () => ({ data: undefined }),
  useShelvedThreads: () => ({ data: undefined }),
  didThreadDetailBootstrapRefreshAfterMount: () => true,
  useThread: () => ({ data: undefined }),
  useThreadDetailBootstrap: useThreadDetailBootstrapMock,
  useThreadPendingInteractions: () => ({ data: undefined }),
}));

function widthVar(element: Element | null): string {
  if (!(element instanceof HTMLElement)) throw new Error("missing element");

  return element.style.getPropertyValue("--sidebar-width");
}

function getRoot(): HTMLElement {
  const root = document.querySelector('[data-testid="app-layout-root"]');

  if (!(root instanceof HTMLElement)) throw new Error("missing app root");

  return root;
}

function SplitLayoutState() {
  const layout = useAtomValue(splitLayoutAtom);

  return <div data-testid="split-layout">{JSON.stringify(layout)}</div>;
}

function RouteContent() {
  const location = useLocation();

  return (
    <>
      <div data-testid="location">
        {location.pathname}
        {location.search}
        {location.hash}
      </div>
      {SECONDARY_ROUTES.map((route) => (
        <Link key={route} to={route}>
          {route}
        </Link>
      ))}
    </>
  );
}

function layoutTree(initialPath: string, children: ReactNode) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <AppCommandProvider>
        <AppLayout>
          <RouteContent />
          {children}
        </AppLayout>
      </AppCommandProvider>
    </MemoryRouter>
  );
}

function renderLayout(initialPath = "/", children: ReactNode = null) {
  return render(layoutTree(initialPath, children));
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useThreadDetailBootstrapMock.mockReset();
  useThreadDetailBootstrapMock.mockReturnValue({
    isError: false,
    isSuccess: false,
  });
});

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  setCompactSecondaryPanelPresentation("closed");
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("thread-open focus", () => {
  it.each([APP_ROUTE, SETTINGS_ROUTE, PLUGINS_ROUTE])(
    "keeps the current route and split layout when a preview arrives on %s",
    (route) => {
      const subscribe = vi.spyOn(wsManager, "onThreadOpen");
      renderLayout(route, <SplitLayoutState />);
      const onThreadOpen = subscribe.mock.calls[0]?.[0];

      if (!onThreadOpen) throw new Error("missing thread-open listener");
      const layoutBefore = screen.getByTestId("split-layout").textContent;

      act(() => {
        onThreadOpen({
          type: "thread-open",
          projectId: "proj_other",
          threadId: "thr_other",
          split: "right",
          file: {
            source: "workspace",
            path: "preview.html",
            lineNumber: null,
          },
        });
      });

      expect(screen.getByTestId("location").textContent).toBe(route);
      expect(screen.getByTestId("split-layout").textContent).toBe(layoutBefore);
    },
  );

  it("navigates for an explicit thread open without a preview", () => {
    const subscribe = vi.spyOn(wsManager, "onThreadOpen");
    renderLayout(APP_ROUTE, <SplitLayoutState />);
    const onThreadOpen = subscribe.mock.calls[0]?.[0];

    if (!onThreadOpen) throw new Error("missing thread-open listener");

    act(() => {
      onThreadOpen({
        type: "thread-open",
        projectId: "proj_other",
        threadId: "thr_other",
        split: "replace",
        file: null,
      });
    });

    expect(screen.getByTestId("location").textContent).toBe(
      "/projects/proj_other/threads/thr_other",
    );
    expect(screen.getByTestId("split-layout").textContent).toContain(
      "thr_other",
    );
  });
});

describe("canonical thread routes", () => {
  it("keeps the layout mounted while redirecting to the thread's project route", async () => {
    let mounts = 0;

    function MountCounter() {
      useEffect(() => {
        mounts += 1;
      }, []);

      return null;
    }

    const view = renderLayout("/threads/thr_one", <MountCounter />);
    useThreadDetailBootstrapMock.mockReturnValue({
      data: { projectId: "proj_actual" },
      isError: false,
      isSuccess: true,
    });

    view.rerender(layoutTree("/threads/thr_one", <MountCounter />));

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(
        "/projects/proj_actual/threads/thr_one",
      ),
    );
    expect(mounts).toBe(1);
  });

  it.each([
    [
      "/threads/thr_one?message=12#event-12",
      "/projects/proj_actual/threads/thr_one?message=12#event-12",
    ],
    [
      "/projects/proj_wrong/threads/thr_one?panel=files#diff",
      "/projects/proj_actual/threads/thr_one?panel=files#diff",
    ],
  ])("redirects %s to the thread's project route", async (route, expected) => {
    useThreadDetailBootstrapMock.mockReturnValue({
      data: { projectId: "proj_actual" },
      isError: false,
      isSuccess: true,
    });

    renderLayout(route);

    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe(expected),
    );
  });

  it("keeps an already canonical thread route", () => {
    useThreadDetailBootstrapMock.mockReturnValue({
      data: { projectId: "proj_one" },
      isError: false,
      isSuccess: true,
    });

    renderLayout(APP_ROUTE);

    expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
  });
});

describe("mobile workspace sidebar access", () => {
  it.each([
    "/plugins",
    "/plugins/plugin-api-docs",
    "/plugins/plugin-api-docs/plugin-api",
    "/settings",
    "/skills",
  ])(
    "opens and collapses the sidebar on %s with a full detail panel",
    async (route) => {
      setCompactSecondaryPanelPresentation("full");
      render(
        <CompactViewportOverrideProvider isCompactViewport>
          <MemoryRouter initialEntries={[route]}>
            <AppCommandProvider>
              <AppLayout>
                <div>Workspace content</div>
              </AppLayout>
            </AppCommandProvider>
          </MemoryRouter>
        </CompactViewportOverrideProvider>,
      );
      const toggle = screen.getByRole("button", { name: /^Toggle sidebar/ });
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(toggle);
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /^Toggle sidebar/ }),
        ).toBeNull(),
      );
      fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: /^Toggle sidebar/ })
            .getAttribute("aria-expanded"),
        ).toBe("false"),
      );
      expect(getRoot().hasAttribute("inert")).toBe(false);
    },
  );
});

describe("phone launch", () => {
  const THREAD_ROUTE = "/projects/proj_one/threads/thr_one";

  function SidebarScopeProbe() {
    return <div data-testid="sidebar-scope">{useSidebarScope().kind}</div>;
  }

  function renderLaunch(route: string, isCompactViewport: boolean) {
    const store = createStore();
    store.set(sidebarScopeAtom, {
      kind: "project",
      projectId: "proj_personal",
    });

    return render(
      <JotaiProvider store={store}>
        <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
          {layoutTree(
            route,
            <>
              <SidebarScopeProbe />
              <Link to={THREAD_ROUTE}>Open thread</Link>
              <Link to="/">New chat</Link>
            </>,
          )}
        </CompactViewportOverrideProvider>
      </JotaiProvider>,
    );
  }

  function sidebarToggle() {
    return screen.getByRole("button", { name: /^Toggle sidebar/ });
  }

  it("opens the drawer on the Inbox from the first render at the bare root", () => {
    renderLaunch("/", true);

    expect(
      screen.getByTestId("sidebar-mobile-backdrop").getAttribute("data-state"),
    ).toBe("open");
    expect(
      screen.queryByRole("button", { name: /^Toggle sidebar/ }),
    ).toBeNull();
    expect(screen.getByTestId("sidebar-scope").textContent).toBe("inbox");
  });

  it.each(["/?initialPrompt=Hello", THREAD_ROUTE])(
    "keeps the drawer closed and the stored scope when launching at %s",
    (route) => {
      renderLaunch(route, true);

      expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
      expect(screen.getByTestId("sidebar-scope").textContent).toBe("project");
    },
  );

  it("leaves a desktop launch at the bare root unchanged", () => {
    renderLaunch("/", false);

    expect(screen.getByTestId("sidebar-scope").textContent).toBe("project");
    expect(
      document.querySelector(
        '[data-sidebar-mobile-backdrop][data-state="open"]',
      ),
    ).toBeNull();
  });

  it("keeps the drawer closed when New chat later returns to the root", async () => {
    renderLaunch("/", true);

    fireEvent.click(screen.getByTestId("sidebar-mobile-backdrop"));
    await waitFor(() =>
      expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false"),
    );

    fireEvent.click(screen.getByRole("link", { name: "Open thread" }));
    expect(screen.getByTestId("location").textContent).toBe(THREAD_ROUTE);
    fireEvent.click(screen.getByRole("link", { name: "New chat" }));
    expect(screen.getByTestId("location").textContent).toBe("/");

    expect(sidebarToggle().getAttribute("aria-expanded")).toBe("false");
    expect(
      screen.getByTestId("sidebar-mobile-backdrop").getAttribute("data-state"),
    ).toBe("closed");
  });
});

describe("AppLayout Back to app", () => {
  it.each(SECONDARY_ROUTES)(
    "keeps %s open when a split drag cancels sidebar reordering",
    (route) => {
      renderLayout(route);
      const originalElementsFromPoint = document.elementsFromPoint;
      document.elementsFromPoint = () => [];
      const onEnd = vi.fn();

      try {
        beginSplitDrag({
          ghostLabel: "Panel tab",
          cancelSidebarReorderOnEngage: true,
          shouldEngage: () => true,
          decide: () => null,
          onDrop: vi.fn(),
          onEnd,
        });
        fireEvent.pointerMove(window, { clientX: 500, clientY: 300 });
        expect(screen.getByTestId("location").textContent).toBe(route);
        expect(document.body.style.cursor).toBe("grabbing");

        fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
        expect(onEnd).toHaveBeenCalledWith({ dropped: false });
        expect(screen.getByTestId("location").textContent).toBe(route);

        fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
        expect(screen.getByTestId("location").textContent).toBe("/");
      } finally {
        fireEvent.pointerCancel(window);
        fireEvent.click(document.body);
        document.elementsFromPoint = originalElementsFromPoint;
      }
    },
  );

  it.each(SECONDARY_ROUTES)(
    "returns from %s with the remembered query and hash, then releases Escape",
    (route) => {
      renderLayout(APP_ROUTE);
      fireEvent.click(screen.getByRole("link", { name: route }));
      expect(screen.getByTestId("location").textContent).toBe(route);

      expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);

      expect(fireEvent.keyDown(document, { key: "Escape" })).toBe(true);
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
    },
  );

  it("returns from Settings to Plugins before returning to the core app", () => {
    renderLayout(APP_ROUTE);
    fireEvent.click(screen.getByRole("link", { name: PLUGINS_ROUTE }));
    fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(PLUGINS_ROUTE);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
  });

  it.each(SECONDARY_ROUTES)(
    "returns to the root when opened directly at %s",
    (route) => {
      renderLayout(route);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.getByTestId("location").textContent).toBe("/");
    },
  );

  it("closes a real popover on the first Escape and returns on the second", async () => {
    renderLayout(
      APP_ROUTE,
      <Popover>
        <PopoverTrigger>Open picker</PopoverTrigger>
        <PopoverContent aria-label="Test picker">
          <button type="button">Picker action</button>
        </PopoverContent>
      </Popover>,
    );
    fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));
    fireEvent.click(screen.getByRole("button", { name: "Open picker" }));
    const picker = screen.getByRole("dialog", { name: "Test picker" });

    fireEvent.keyDown(picker, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Test picker" })).toBeNull();
    });
    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
  });

  it("does not navigate while a modal is open even if it does not consume Escape", () => {
    renderLayout(
      SETTINGS_ROUTE,
      <div aria-modal="true" data-state="open" role="dialog">
        <button type="button">Modal action</button>
      </div>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Modal action" }), {
      key: "Escape",
    });

    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);
  });

  it("leaves Escape to a focused interaction that consumes it", () => {
    renderLayout(
      SETTINGS_ROUTE,
      <button
        type="button"
        onKeyDown={(event) => {
          if (event.key === "Escape") event.preventDefault();
        }}
      >
        Cancel editing
      </button>,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: "Cancel editing" }), {
      key: "Escape",
    });

    expect(screen.getByTestId("location").textContent).toBe(SETTINGS_ROUTE);
  });
});

describe("AppLayout sidebar state is scoped to this tab", () => {
  function sidebarRoot() {
    const gap = document.querySelector('[data-sidebar="gap"]');

    if (!gap?.parentElement) throw new Error("missing sidebar");

    return gap.parentElement;
  }

  function dispatchCrossTabWrite(key: string, newValue: string) {
    window.localStorage.setItem(key, newValue);
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue,
          storageArea: window.localStorage,
        }),
      );
    });
  }

  it("keeps this tab expanded when another tab collapses the sidebar", () => {
    renderLayout();
    expect(sidebarRoot().getAttribute("data-state")).toBe("expanded");

    dispatchCrossTabWrite(SIDEBAR_OPEN_STORAGE_KEY, "false");

    expect(sidebarRoot().getAttribute("data-state")).toBe("expanded");
  });

  it("keeps this tab's width when another tab resizes the sidebar", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "320");
    renderLayout();
    const gap = document.querySelector('[data-sidebar="gap"]');
    expect(widthVar(gap)).toBe("320px");

    dispatchCrossTabWrite(SIDEBAR_WIDTH_STORAGE_KEY, "420");

    expect(widthVar(gap)).toBe("320px");
  });
});

describe("AppLayout app footer", () => {
  it("renders the app footer inside the app root after the content, with the settings route", () => {
    renderLayout(APP_ROUTE);

    const root = getRoot();
    const footer = screen.getByTestId("app-footer");
    const inset = document.querySelector('[data-sidebar="inset"]');

    expect(root.contains(footer)).toBe(true);
    expect(inset?.contains(footer)).toBe(false);
    expect(
      (inset?.compareDocumentPosition(footer) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(footer.dataset.settingsActive).toBe("false");

    fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));

    expect(screen.getByTestId("app-footer").dataset.settingsActive).toBe(
      "true",
    );
  });
});

describe("AppLayout sidebar resize drag", () => {
  let frameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    frameCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frameCallbacks.push(cb);

      return frameCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  function flushFrames() {
    const callbacks = frameCallbacks;
    frameCallbacks = [];
    act(() => {
      for (const callback of callbacks) callback(0);
    });
  }

  it.each(SECONDARY_ROUTES)(
    "finishes resizing before Escape can leave %s",
    (route) => {
      renderLayout(APP_ROUTE);
      fireEvent.click(screen.getByRole("link", { name: route }));
      fireEvent.mouseDown(screen.getByTestId("resize-handle"), {
        clientX: 320,
      });
      expect(document.body.classList.contains("sidebar-resizing")).toBe(true);

      fireEvent.keyDown(document, { key: "Escape" });

      expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
      expect(screen.getByTestId("location").textContent).toBe(route);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.getByTestId("location").textContent).toBe(APP_ROUTE);
    },
  );

  it("writes the live width on the sidebar gap and panel only, never on the app root or body", () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, "320");
    renderLayout();

    const root = getRoot();
    const gap = document.querySelector('[data-sidebar="gap"]');
    const panel = document.querySelector('[data-sidebar="panel"]');
    expect(widthVar(gap)).toBe("320px");
    expect(widthVar(panel)).toBe("320px");
    expect(widthVar(root)).toBe("");
    const rootStyleBefore = root.getAttribute("style");

    const handle = document.querySelector('[data-testid="resize-handle"]');

    if (!handle) throw new Error("missing handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 320 });
    });
    act(() => {
      fireEvent.mouseMove(window, { clientX: 360 });
    });
    flushFrames();

    expect(widthVar(gap)).toBe("360px");
    expect(widthVar(panel)).toBe("360px");
    expect(widthVar(root)).toBe("");
    expect(root.getAttribute("style")).toBe(rootStyleBefore);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("320");

    act(() => {
      fireEvent.mouseUp(window);
    });

    expect(widthVar(gap)).toBe("360px");
    expect(widthVar(panel)).toBe("360px");
    expect(widthVar(root)).toBe("");
    expect(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe("360");
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
  });

  it("mounts the drag-guard overlay after the app root and gives it the resize cursor", () => {
    renderLayout();
    const root = getRoot();
    expect(
      document.querySelector('[data-testid="iframe-drag-guard-overlay"]'),
    ).toBeNull();

    const handle = document.querySelector('[data-testid="resize-handle"]');

    if (!handle) throw new Error("missing handle");
    act(() => {
      fireEvent.mouseDown(handle, { clientX: 320 });
    });

    const overlay = document.querySelector(
      '[data-testid="iframe-drag-guard-overlay"]',
    );

    if (!overlay) throw new Error("overlay did not mount");
    expect(overlay.className).toContain("cursor-col-resize");
    expect(
      root.compareDocumentPosition(overlay) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(root.contains(overlay)).toBe(false);

    act(() => {
      fireEvent.mouseUp(window);
    });
    expect(
      document.querySelector('[data-testid="iframe-drag-guard-overlay"]'),
    ).toBeNull();
  });
});

describe("AppLayout plugin overlay contexts", () => {
  beforeEach(() => {
    markPluginFrontendsSettled();
  });

  afterEach(() => {
    resetPluginFrontendBootStateForTest();
  });

  it.each([false, true])(
    "provides host tooltips to an overlay (portal: %s)",
    async (portaled) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

      function Overlay() {
        const content = (
          <Tooltip open>
            <TooltipTrigger>Overlay action</TooltipTrigger>
            <TooltipContent>Overlay tooltip</TooltipContent>
          </Tooltip>
        );

        return portaled ? createPortal(content, document.body) : content;
      }

      setPluginSlotRegistrations(
        "tooltip-overlay",
        makePluginRegistrationSet({
          appOverlays: [{ id: "tooltip", component: Overlay }],
        }),
      );

      renderLayout(
        "/",
        <Tooltip>
          <TooltipTrigger>Page action</TooltipTrigger>
          <TooltipContent>Page tooltip</TooltipContent>
        </Tooltip>,
      );

      expect(screen.getByRole("button", { name: "Page action" })).toBeDefined();

      const overlayHost = document.querySelector(
        "[data-omnyo-plugin-app-overlays]",
      );

      expect(overlayHost).not.toBeNull();
      expect(overlayHost?.parentElement).toBe(getRoot().parentElement);
      expect(getRoot().contains(overlayHost)).toBe(false);
      expect(errors).not.toHaveBeenCalled();
      expect(
        screen.getByRole("button", { name: "Overlay action" }),
      ).toBeDefined();
      expect(
        (await screen.findByRole("tooltip", { hidden: true })).textContent,
      ).toBe("Overlay tooltip");
      fireEvent.click(screen.getByRole("link", { name: SETTINGS_ROUTE }));
      expect(
        screen.getByRole("button", { name: "Overlay action" }),
      ).toBeDefined();
      expect(screen.getByRole("tooltip", { hidden: true }).textContent).toBe(
        "Overlay tooltip",
      );
      expect(errors).not.toHaveBeenCalled();
      expect(warnings).not.toHaveBeenCalled();
    },
  );
});

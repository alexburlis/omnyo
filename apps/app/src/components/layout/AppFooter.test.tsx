// @vitest-environment jsdom
import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Provider as JotaiProvider, createStore } from "jotai";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { PERSONAL_PROJECT_ID } from "@omnyo/domain";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import type {
  ExperimentalSidebarFooterCardProps,
  ExperimentalSidebarFooterDisclosureController,
} from "@omnyo/plugin-sdk";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { ProjectActionsProvider } from "@/components/project/ProjectActionsProvider";
import { LazySidebarFooterCustomize } from "@/components/sidebar/LazySidebarFooterCustomize";
import { sidebarFooterHiddenAtom } from "@/components/sidebar/sidebarFooterPreferences";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { QuickCreateProjectProvider } from "@/hooks/useQuickCreateProject";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { useAppSettingsRouteMemory } from "@/hooks/useAppSettingsRouteMemory";
import type { WebSocketConnectionStatus } from "@/lib/ws";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { makeProjectResponse } from "@/test/fixtures/projects";
import { AppShellFrame } from "./AppShellFrame";

const CONNECTED: WebSocketConnectionStatus = {
  state: "connected",
  host: "omnyo.example",
  since: null,
  failedAttempts: 0,
};

const connection = vi.hoisted(() => {
  const listeners = new Set<() => void>();

  return {
    status: null as WebSocketConnectionStatus | null,
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) listener();
    },
  };
});

function currentConnectionStatus(): WebSocketConnectionStatus {
  return connection.status ?? CONNECTED;
}

function getConnectionIndicator(): HTMLElement | null {
  return getAppFooter().querySelector<HTMLElement>("[data-connection-state]");
}

vi.mock("@/hooks/useServerConnectionState", async () => {
  const { useSyncExternalStore } = await import("react");

  return {
    useServerConnectionState: () =>
      useSyncExternalStore(connection.subscribe, () =>
        currentConnectionStatus(),
      ).state,
    useServerConnectionStatus: () =>
      useSyncExternalStore(connection.subscribe, () =>
        currentConnectionStatus(),
      ),
  };
});

vi.mock("@/components/sidebar/AppNavRail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/sidebar/AppNavRail")>();

  return {
    ...actual,
    AppNavRail: () => <nav aria-label="Primary navigation" />,
  };
});

const MOBILE_TOGGLE_SETTLE_MS = MOTION_DURATION_MS.drawer;

const limitsController: {
  current: ExperimentalSidebarFooterDisclosureController | null;
} = { current: null };

function UsageCard({
  experimental_placement,
}: ExperimentalSidebarFooterCardProps) {
  return <span>{`Usage in ${experimental_placement ?? "unknown"}`}</span>;
}

function UsageDisclosure({ dismiss }: { dismiss(): void }) {
  return (
    <div>
      <p>Five-hour limit details</p>
      <button type="button" onClick={dismiss}>
        Close details
      </button>
    </div>
  );
}

function registerFooterPlugins() {
  setPluginSlotRegistrations(
    "omnyo--account-usage",
    makePluginRegistrationSet({
      sidebarFooterCards: [{ id: "usage", component: UsageCard }],
    }),
  );
  setPluginSlotRegistrations(
    "usage-details",
    collectPluginAppRegistrations(
      definePluginApp((app) => {
        limitsController.current = app.experimental_sidebarFooter.register({
          kind: "disclosure",
          id: "limits",
          label: "Usage limits",
          icon: "ChartColumn",
          component: UsageDisclosure,
        });
      }),
    ),
  );
}

function LocationProbe() {
  const { pathname, search, hash } = useLocation();

  return (
    <output aria-label="Current path">{`${pathname}${search}${hash}`}</output>
  );
}

function RouteAwareShell() {
  const isSettingsActive = useLocation().pathname.startsWith("/settings");
  const { appRoutePath, settingsRoutePath } = useAppSettingsRouteMemory();

  return (
    <AppShellFrame
      mode={isSettingsActive ? "settings" : "app"}
      onResizeMouseDown={() => {}}
      isResizing={false}
      settingsToggleRoutePath={
        isSettingsActive ? appRoutePath : settingsRoutePath
      }
    >
      <div data-testid="route-content">
        <input aria-label="Message" />
      </div>
    </AppShellFrame>
  );
}

function renderShell({
  compact = false,
  initialPath = "/",
  store = createStore(),
}: {
  compact?: boolean;
  initialPath?: string;
  store?: ReturnType<typeof createStore>;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  queryClient.setQueryData(sidebarNavigationQueryKey(), {
    sections: [],
    personalProject: {
      ...makeProjectResponse({
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        name: "Personal",
      }),
      defaultExecutionOptions: null,
      threads: [],
    },
    projects: [],
  });

  const shell: ReactNode = (
    <SidebarProvider>
      <RouteAwareShell />
      <SidebarTrigger />
    </SidebarProvider>
  );

  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <LocationProbe />
      <JotaiProvider store={store}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider delayDuration={0}>
            <AppCommandProvider>
              <QuickCreateProjectProvider>
                <ProjectActionsProvider>
                  <ActionHistoryProvider>
                    <ThreadActionsProvider>
                      <CompactViewportOverrideProvider
                        isCompactViewport={compact}
                      >
                        {shell}
                      </CompactViewportOverrideProvider>
                    </ThreadActionsProvider>
                  </ActionHistoryProvider>
                </ProjectActionsProvider>
              </QuickCreateProjectProvider>
            </AppCommandProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </JotaiProvider>
    </MemoryRouter>,
  );
}

function getGear(): HTMLElement {
  return within(getAppFooter()).getByRole("button", { name: /^Settings/ });
}

async function openFooterMenu(): Promise<HTMLElement> {
  fireEvent.pointerDown(
    within(getAppFooter()).getByRole("button", { name: "More footer actions" }),
    {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    },
  );

  return screen.findByRole("menu");
}

function getAppFooter(): HTMLElement {
  const footer = document.querySelector("[data-app-footer]");

  if (!(footer instanceof HTMLElement)) throw new Error("missing app footer");

  return footer;
}

afterEach(() => {
  cleanup();
  limitsController.current = null;
  resetPluginSlotStoreForTest();
  connection.status = null;
  vi.useRealTimers();
  window.localStorage.clear();
});

describe("desktop app footer", () => {
  it("spans the window below the sidebar and content, with the settings gear in the rail corner", () => {
    registerFooterPlugins();
    renderShell();

    const footer = getAppFooter();
    const inset = document.querySelector('[data-sidebar="inset"]');
    const panel = document.querySelector('[data-sidebar="panel"]');

    expect(footer.tagName).toBe("FOOTER");
    expect(footer.className).toContain("inset-x-0");
    expect(panel?.contains(footer)).toBe(false);
    expect(inset?.contains(footer)).toBe(false);
    expect(
      (inset?.compareDocumentPosition(footer) ?? 0) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(document.querySelector('[data-sidebar="footer"]')).toBeNull();
    expect(screen.getByTestId("route-content")).toBeDefined();

    const start = within(footer).getByTestId("app-footer-start");
    const settingsCell = within(footer).getByTestId("app-footer-settings-cell");
    expect(footer.firstElementChild).toBe(start);
    expect(start.firstElementChild).toBe(settingsCell);
    expect(
      within(settingsCell).getByRole("button", { name: /^Settings/ }),
    ).toBeDefined();
    expect(panel?.querySelector('[aria-label^="Settings"]')).toBeNull();
  });

  it("orders usage cards first, then footer actions and a connection problem", () => {
    connection.status = {
      state: "reconnecting",
      host: "omnyo.example",
      since: Date.now() - 5_000,
      failedAttempts: 0,
    };
    registerFooterPlugins();
    renderShell();

    const footer = getAppFooter();
    const usage = within(footer).getByText("Usage in footer");
    const limits = within(footer).getByRole("button", { name: "Usage limits" });
    const bell = within(footer).getByRole("button", { name: "Notifications" });
    const indicator = getConnectionIndicator();

    expect(indicator?.getAttribute("aria-label")).toBe(
      "Reconnecting to omnyo.example",
    );

    if (indicator === null) throw new Error("missing connection indicator");

    for (const [before, after] of [
      [usage, limits],
      [limits, bell],
      [bell, indicator],
    ] as const) {
      expect(
        before.compareDocumentPosition(after) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    }
  });

  it("centers a live card on the footer only while it clears the readouts and the footer actions", () => {
    const resizeCallbacks = new Set<() => void>();

    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly #notify: () => void;

        constructor(callback: ResizeObserverCallback) {
          this.#notify = () => callback([], this as unknown as ResizeObserver);
        }

        observe() {
          resizeCallbacks.add(this.#notify);
        }

        unobserve() {}

        disconnect() {
          resizeCallbacks.delete(this.#notify);
        }
      },
    );
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    registerFooterPlugins();
    setPluginSlotRegistrations(
      "chat-topics",
      makePluginRegistrationSet({
        sidebarFooterCards: [
          {
            id: "live",
            component: () => <button type="button">3 running</button>,
          },
        ],
      }),
    );
    renderShell();

    const footer = getAppFooter();
    const live = within(footer).getByRole("button", { name: "3 running" });
    const region = live.closest("[data-footer-center]");

    const readouts = within(footer).getByRole("group", {
      name: "Live usage and resources",
    });

    const start = within(footer).getByTestId("app-footer-start");
    const end = within(footer).getByTestId("app-footer-end");

    if (region === null) throw new Error("missing footer center region");

    const boxes = new Map<Element, DOMRect>();

    const box = (left: number, width: number) =>
      ({
        x: left,
        y: 0,
        left,
        top: 0,
        width,
        height: 30,
        right: left + width,
        bottom: 30,
        toJSON: () => ({}),
      }) as DOMRect;

    const rects = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return boxes.get(this) ?? box(0, 0);
      });

    onTestFinished(() => rects.mockRestore());

    const placeAt = (barWidth: number, endWidth = 600) => {
      boxes.set(footer, box(0, barWidth));
      boxes.set(start, box(0, 76));
      boxes.set(region, box(0, 240));
      boxes.set(end, box(barWidth - 4 - endWidth, endWidth));
      act(() => {
        for (const notify of resizeCallbacks) notify();
      });

      return region.getAttribute("data-footer-center");
    };

    expect(placeAt(1600)).toBe("centered");
    expect(placeAt(1000)).toBe("inline");
    expect(placeAt(1600)).toBe("centered");
    expect(placeAt(1600, 700)).toBe("inline");
    expect(readouts.contains(live)).toBe(false);
    expect(end.contains(readouts)).toBe(true);
  });

  it("shows no connection indicator while connected", () => {
    renderShell();

    expect(getConnectionIndicator()).toBeNull();
    expect(within(getAppFooter()).getByRole("status").textContent).toBe("");
  });

  it("keeps the first connection attempt quiet for 1 s, then names it", () => {
    vi.useFakeTimers();
    connection.status = {
      state: "connecting",
      host: "omnyo.example",
      since: Date.now(),
      failedAttempts: 0,
    };
    renderShell();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(getConnectionIndicator()).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(getConnectionIndicator()?.getAttribute("aria-label")).toBe(
      "Connecting to omnyo.example",
    );
    expect(within(getAppFooter()).getByText("Connecting…")).toBeDefined();
    expect(within(getAppFooter()).getByRole("status").textContent).toBe(
      "Connecting to omnyo.example",
    );
  });

  it("never shows a reconnect that heals within 1 s", () => {
    vi.useFakeTimers();
    connection.status = {
      state: "reconnecting",
      host: "omnyo.example",
      since: Date.now(),
      failedAttempts: 0,
    };
    renderShell();

    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(getConnectionIndicator()).toBeNull();

    connection.status = null;
    act(() => {
      connection.notify();
      vi.advanceTimersByTime(1_000);
    });

    expect(getConnectionIndicator()).toBeNull();
    expect(within(getAppFooter()).getByRole("status").textContent).toBe("");
  });

  it("explains a lost connection at once with the server, outage length and failed attempts", async () => {
    connection.status = {
      state: "reconnecting",
      host: "omnyo.example",
      since: Date.now() - 125_000,
      failedAttempts: 3,
    };
    renderShell();

    const indicator = getConnectionIndicator();

    if (indicator === null) throw new Error("missing connection indicator");

    expect(indicator.getAttribute("aria-label")).toBe(
      "Can't connect to omnyo.example",
    );
    expect(
      within(indicator).getByText("Can't connect to the server"),
    ).toBeDefined();

    const detailsId = indicator.getAttribute("aria-describedby");

    expect(detailsId && document.getElementById(detailsId)?.textContent).toBe(
      "Disconnected for 2m. 3 failed attempts · retrying automatically",
    );

    fireEvent.pointerMove(indicator);
    const tooltip = await screen.findByRole("tooltip");
    expect(Array.from(tooltip.children, (line) => line.textContent)).toEqual([
      "Can't connect to omnyo.example",
      "Disconnected for 2m",
      "3 failed attempts · retrying automatically",
    ]);
  });

  it("toggles Settings from the cog and keeps footer actions in More", async () => {
    registerFooterPlugins();
    const appPath = "/?from=footer#compose";
    renderShell({ initialPath: appPath });
    const footer = getAppFooter();
    expect(
      within(footer).queryByRole("link", { name: "Mobile apps" }),
    ).toBeNull();
    const menu = await openFooterMenu();
    expect(
      within(menu).queryByRole("menuitem", { name: /^Settings/ }),
    ).toBeNull();
    expect(
      within(menu).queryByRole("menuitem", { name: "Mobile apps" }),
    ).toBeNull();

    for (const name of ["Report a bug", "Customize footer"])
      expect(within(menu).getByRole("menuitem", { name })).toBeDefined();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(getGear());
    await waitFor(() =>
      expect(screen.getByLabelText("Current path").textContent).toBe(
        "/settings",
      ),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(getGear().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(getGear());
    expect(screen.getByLabelText("Current path").textContent).toBe(appPath);
    expect(getGear().getAttribute("aria-pressed")).toBe("false");
  });

  it("opens footer actions from the keyboard", async () => {
    registerFooterPlugins();
    renderShell();

    const more = within(getAppFooter()).getByRole("button", {
      name: "More footer actions",
    });

    more.focus();
    fireEvent.keyDown(more, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Report a bug" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Report a bug" }),
    ).toBeDefined();
  });

  it("opens the in-app bug report dialog from Report a bug", async () => {
    registerFooterPlugins();
    renderShell();

    const menu = await openFooterMenu();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Report a bug" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Report a bug" }),
    ).toBeDefined();
    expect(screen.getByLabelText("What went wrong?")).toBeDefined();
  });

  it("keeps a pinned action in the footer and out of More", async () => {
    const store = createStore();

    store.set(sidebarFooterHiddenAtom, ["pinned:builtin:mobile"]);
    registerFooterPlugins();
    renderShell({ store });

    expect(
      within(getAppFooter()).getByRole("link", { name: "Mobile apps" }),
    ).toBeDefined();

    const menu = await openFooterMenu();

    expect(
      within(menu).queryByRole("menuitem", { name: "Mobile apps" }),
    ).toBeNull();
    expect(
      within(menu).getByRole("menuitem", { name: "Report a bug" }),
    ).toBeDefined();
  });

  it("keeps the settings gear when every footer item is hidden", () => {
    const store = createStore();
    store.set(sidebarFooterHiddenAtom, [
      "builtin:mobile",
      "plugin:usage-details/limits",
      "builtin:report-bug",
    ]);
    registerFooterPlugins();
    renderShell({ store });

    const footer = getAppFooter();
    expect(within(footer).queryByRole("button", { name: "Usage limits" })).toBe(
      null,
    );
    expect(
      within(footer).getByRole("button", { name: /^Settings/ }),
    ).toBeDefined();
  });

  it("opens a footer disclosure as a popover above the footer and returns focus on Escape", async () => {
    registerFooterPlugins();
    renderShell();

    const footer = getAppFooter();

    const trigger = within(footer).getByRole("button", {
      name: "Usage limits",
    });

    fireEvent.click(trigger);

    const details = await screen.findByText("Five-hour limit details");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(footer.contains(details)).toBe(false);
    expect(
      document.querySelector('[data-sidebar="panel"]')?.contains(details),
    ).toBe(false);
    expect(details.closest('[data-side="top"]')).not.toBeNull();

    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.queryByText("Five-hour limit details")).toBeNull(),
    );

    fireEvent.click(trigger);
    await screen.findByText("Five-hour limit details");
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() =>
      expect(screen.queryByText("Five-hour limit details")).toBeNull(),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("closes a disclosure on an outside click without moving focus back to the footer", async () => {
    registerFooterPlugins();
    renderShell();

    const trigger = within(getAppFooter()).getByRole("button", {
      name: "Usage limits",
    });

    fireEvent.click(trigger);
    await screen.findByText("Five-hour limit details");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.pointerDown(message, { button: 0, pointerType: "mouse" });
    message.focus();
    fireEvent.click(message, { button: 0 });

    await waitFor(() =>
      expect(screen.queryByText("Five-hour limit details")).toBeNull(),
    );
    expect(document.activeElement).toBe(message);
  });

  it("keeps focus in place when a plugin opens its disclosure", async () => {
    registerFooterPlugins();
    renderShell();

    const message = screen.getByRole("textbox", { name: "Message" });
    message.focus();

    act(() => limitsController.current?.open());

    await screen.findByText("Five-hour limit details");
    expect(document.activeElement).toBe(message);
    expect(
      within(getAppFooter())
        .getByRole("button", { name: "Usage limits" })
        .getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("opens Customize footer from More and cancels reordering before Escape closes it", async () => {
    await LazySidebarFooterCustomize.preload();
    registerFooterPlugins();
    renderShell();

    const footer = getAppFooter();

    const more = within(footer).getByRole("button", {
      name: "More footer actions",
    });

    fireEvent.pointerDown(more, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    const fallbacks: Element[] = [];

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;

          if (node.matches('[aria-label="Loading footer customization"]'))
            fallbacks.push(node);
          fallbacks.push(
            ...node.querySelectorAll(
              '[aria-label="Loading footer customization"]',
            ),
          );
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    onTestFinished(() => observer.disconnect());
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Customize footer" }),
    );

    expect(
      await screen.findByRole("group", { name: "Footer actions" }),
    ).toBeTruthy();
    const handle = screen.getByRole("button", { name: "Reorder Usage limits" });
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await waitFor(() =>
      expect(handle.getAttribute("aria-pressed")).toBe("true"),
    );
    fireEvent.keyDown(handle, { key: "Escape", code: "Escape" });
    expect(screen.getByRole("button", { name: "Done" })).toBeDefined();
    await waitFor(() =>
      expect(handle.getAttribute("aria-pressed")).not.toBe("true"),
    );
    expect(
      screen.queryByRole("status", { name: "Loading footer customization" }),
    ).toBeNull();
    expect(fallbacks).toEqual([]);
    const done = await screen.findByRole("button", { name: "Done" });
    expect(footer.contains(done)).toBe(false);
    expect(done.closest('[data-side="top"]')).not.toBeNull();
    expect(
      within(footer).getByRole("button", { name: "Usage limits" }),
    ).toBeDefined();

    fireEvent.keyDown(handle, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Done" })).toBeNull(),
    );
    expect(document.activeElement).toBe(more);
  });

  it("adds a folded action to the footer from Customize and keeps the pin", async () => {
    await LazySidebarFooterCustomize.preload();
    const store = createStore();

    store.set(sidebarFooterHiddenAtom, ["builtin:report-bug"]);
    registerFooterPlugins();
    renderShell({ store });

    const menu = await openFooterMenu();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Customize footer" }),
    );
    fireEvent.click(
      await screen.findByRole("switch", { name: "Show Mobile apps in footer" }),
    );

    await waitFor(() =>
      expect(store.get(sidebarFooterHiddenAtom)).toEqual([
        "builtin:report-bug",
        "pinned:builtin:mobile",
      ]),
    );
    expect(
      within(getAppFooter()).getByRole("link", { name: "Mobile apps" }),
    ).toBeDefined();

    fireEvent.click(
      await screen.findByRole("switch", {
        name: "Show Mobile apps in footer",
      }),
    );
    await waitFor(() =>
      expect(store.get(sidebarFooterHiddenAtom)).toEqual([
        "builtin:report-bug",
        "builtin:mobile",
      ]),
    );
    expect(
      within(getAppFooter()).queryByRole("link", { name: "Mobile apps" }),
    ).toBeNull();
  });
});

describe("compact app shell", () => {
  function openCompactDrawer(): HTMLElement {
    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));
    act(() => {
      vi.advanceTimersByTime(MOBILE_TOGGLE_SETTLE_MS);
    });

    const drawer = document.querySelector(
      '[data-sidebar="panel"][data-vaul-drawer-direction]',
    );

    if (!(drawer instanceof HTMLElement)) throw new Error("missing drawer");

    return drawer;
  }

  it("renders no app footer and keeps the drawer bottom rail and gear", () => {
    vi.useFakeTimers();
    registerFooterPlugins();
    renderShell({ compact: true });

    expect(document.querySelector("[data-app-footer]")).toBeNull();

    const drawer = openCompactDrawer();
    const bottomRail = within(drawer).getByTestId("sidebar-bottom-rail");

    expect(within(bottomRail).getByLabelText("Footer actions")).toBeDefined();
    expect(
      within(drawer).getByRole("button", { name: /^Settings/ }),
    ).toBeDefined();
    expect(
      within(bottomRail).queryByTestId("sidebar-native-server"),
    ).toBeNull();
    expect(document.querySelector("[data-app-footer]")).toBeNull();
  });
});

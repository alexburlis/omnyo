// @vitest-environment jsdom

import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createPortal } from "react-dom";
import { MemoryRouter, useLocation } from "react-router-dom";
import { useState } from "react";
import type { ExperimentalSidebarFooterCardProps } from "@omnyo/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActionsProvider } from "@/components/thread/ThreadActionsProvider";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import {
  experimental_useAppContext as useAppContext,
  experimental_useAppNavigate as useAppNavigate,
  useRpc,
  useSettings,
} from "@/lib/plugin-sdk-hooks";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";
import {
  PluginFooterCenterCards,
  PluginSidebarFooterCards,
} from "./PluginSidebarFooterCards";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { SidebarThreadEntriesTestProvider } from "@/test/sidebarThreadEntriesTestProvider";

vi.mock("@/components/sidebar/ResourcesRailWidget", () => ({
  ResourcesRailWidget: () => <span>Native Resources reading</span>,
}));

vi.mock("@/components/dialogs/ThreadDeleteDialog", () => ({
  ThreadDeleteDialog: () => null,
}));

vi.mock("@/components/dialogs/ThreadRenameDialog", () => ({
  ThreadRenameDialog: () => null,
}));

vi.mock("@/hooks/mutations/thread-state-mutations", () => {
  const mutation = () => ({
    isPending: false,
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
  });

  return {
    useArchiveThreadAndChildren: mutation,
    useDeleteThread: mutation,
    useMarkThreadRead: mutation,
    useMarkThreadUnread: mutation,
    usePinThread: mutation,
    useUnarchiveThread: mutation,
    useUnpinThread: mutation,
    useUpdateThread: mutation,
  };
});

vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: [] }),
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigation: () => ({
    data: {
      personalProject: { id: "personal", name: "Personal", threads: [] },
      projects: [],
    },
    isError: false,
  }),
}));

function LocationProbe() {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

function useSidebarThreadActions() {
  return pluginSdkAppImplementation.experimental_useSidebarThreadActions();
}

function PortaledProbe() {
  const context = useAppContext();
  const navigate = useAppNavigate();
  const rpc = useRpc();
  const settings = useSettings();
  const sidebarThreadActions = useSidebarThreadActions();
  const [rpcResult, setRpcResult] = useState("idle");

  return (
    <div>
      <div data-testid="footer card-context">
        {context.projectId}/{context.threadId}
      </div>
      <div data-testid="footer card-settings">
        {settings.isLoading ? "loading" : settings.values?.mode}
      </div>
      <div data-testid="footer card-rpc">{rpcResult}</div>
      <div data-testid="footer card-sidebar-actions">
        {typeof sidebarThreadActions.openNewThread}
      </div>
      <button
        type="button"
        onClick={() => {
          void rpc.call("ping").then((result) => setRpcResult(String(result)));
        }}
      >
        Call RPC
      </button>
      <button type="button" onClick={() => navigate.toCompose()}>
        Go home
      </button>
    </div>
  );
}

function PortaledOverlay() {
  return createPortal(<PortaledProbe />, document.body);
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PluginSidebarFooterCards", () => {
  it("keeps the native Resources reading until the Resources plugin registers its footer card", () => {
    const panel = {
      id: "resources",
      title: "Resources",
      icon: "Cpu" as const,
      path: "resources",
      component: () => null,
    };

    setPluginSlotRegistrations(
      "resources",
      registrationSet({ navPanels: [panel] }),
    );

    const view = render(
      <MemoryRouter>
        <PluginSidebarFooterCards placement="footer" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Native Resources reading")).toBeDefined();

    setPluginSlotRegistrations(
      "resources",
      registrationSet({
        navPanels: [panel],
        sidebarFooterCards: [
          { id: "footer", component: () => <span>Resources card</span> },
        ],
      }),
    );
    view.rerender(
      <MemoryRouter>
        <PluginSidebarFooterCards placement="footer" />
      </MemoryRouter>,
    );

    expect(screen.getByText("Resources card")).toBeDefined();
    expect(screen.queryByText("Native Resources reading")).toBeNull();
  });

  it("shows usage then Resources on the phone rail and keeps both out of the chat footer", () => {
    setPluginSlotRegistrations(
      "resources",
      registrationSet({
        sidebarFooterCards: [
          {
            id: "summary",
            component: () => <span>Resources reading</span>,
          },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "omnyo--account-usage",
      registrationSet({
        sidebarFooterCards: [
          { id: "usage", component: () => <span>Live account bars</span> },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "office",
      registrationSet({
        sidebarFooterCards: [
          { id: "summary", component: () => <span>Office summary</span> },
        ],
      }),
    );
    render(
      <MemoryRouter>
        <section aria-label="Phone status rows">
          <PluginSidebarFooterCards placement="status" />
        </section>
        <section aria-label="Chat footer">
          <PluginSidebarFooterCards />
        </section>
      </MemoryRouter>,
    );
    const status = screen.getByRole("region", { name: "Phone status rows" });
    const footer = screen.getByRole("region", { name: "Chat footer" });
    expect(
      Array.from(status.querySelectorAll("span"), (span) => span.textContent),
    ).toEqual(["Live account bars", "Resources reading"]);
    expect(within(footer).getByText("Office summary")).toBeDefined();
    expect(within(footer).queryByText("Live account bars")).toBeNull();
    expect(within(footer).queryByText("Resources reading")).toBeNull();
  });

  it("tells each card its placement, puts usage first in the app footer and keeps other cards out of that group", () => {
    function PlacementCard({
      label,
      experimental_placement,
    }: ExperimentalSidebarFooterCardProps & { label: string }) {
      return (
        <span>{`${label} in ${experimental_placement ?? "no placement"}`}</span>
      );
    }

    setPluginSlotRegistrations(
      "office",
      registrationSet({
        sidebarFooterCards: [
          {
            id: "summary",
            component: (props) => <PlacementCard label="Office" {...props} />,
          },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "omnyo--account-usage",
      registrationSet({
        sidebarFooterCards: [
          {
            id: "usage",
            component: (props) => <PlacementCard label="Usage" {...props} />,
          },
        ],
      }),
    );
    setPluginSlotRegistrations(
      "resources",
      registrationSet({
        sidebarFooterCards: [
          {
            id: "footer",
            component: (props) => (
              <PlacementCard label="Resources" {...props} />
            ),
          },
        ],
      }),
    );
    render(
      <MemoryRouter>
        <section aria-label="Phone status rows">
          <PluginSidebarFooterCards placement="status" />
        </section>
        <section aria-label="Sidebar footer">
          <PluginSidebarFooterCards placement="sidebar" />
        </section>
        <section aria-label="App footer">
          <PluginSidebarFooterCards placement="footer" />
          <PluginFooterCenterCards />
        </section>
      </MemoryRouter>,
    );

    const status = screen.getByRole("region", { name: "Phone status rows" });
    const sidebar = screen.getByRole("region", { name: "Sidebar footer" });
    const footer = screen.getByRole("region", { name: "App footer" });
    expect(within(status).getByText("Usage in footer")).toBeDefined();
    expect(within(status).getByText("Resources in footer")).toBeDefined();
    expect(within(status).queryByText("Office in footer")).toBeNull();
    expect(within(sidebar).getByText("Office in sidebar")).toBeDefined();
    expect(within(sidebar).queryByText(/^Resources/)).toBeNull();

    const group = within(footer).getByRole("group", {
      name: "Live usage and resources",
    });

    expect(
      Array.from(group.querySelectorAll("span"), (span) => span.textContent),
    ).toEqual(["Usage in footer", "Resources in footer"]);
    expect(within(group).getAllByRole("separator")).toHaveLength(1);
    expect(within(footer).getByText("Office in footer")).toBeDefined();
    expect(within(group).queryByText("Office in footer")).toBeNull();
  });

  it("does not render an existing footer card when another one registers", () => {
    const firstRender = vi.fn();

    function First() {
      firstRender();

      return <div>first footer card</div>;
    }

    function Second() {
      return <div>second footer card</div>;
    }

    setPluginSlotRegistrations(
      "first",
      registrationSet({
        sidebarFooterCards: [{ id: "first", component: First }],
      }),
    );
    render(
      <MemoryRouter>
        <PluginSidebarFooterCards />
      </MemoryRouter>,
    );

    expect(firstRender).toHaveBeenCalledTimes(1);
    act(() => {
      setPluginSlotRegistrations(
        "second",
        registrationSet({
          sidebarFooterCards: [{ id: "second", component: Second }],
        }),
      );
    });

    expect(screen.getByText("second footer card")).toBeDefined();
    expect(firstRender).toHaveBeenCalledTimes(1);
  });

  it("keeps sidebar thread actions available through a portal and route change", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);

      if (url.endsWith("/settings")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, values: { mode: "floating" } }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: "pong" }),
      };
    });

    vi.stubGlobal("fetch", fetchMock);
    setPluginSlotRegistrations(
      "office",
      registrationSet({
        sidebarFooterCards: [{ id: "widget", component: PortaledOverlay }],
      }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SidebarThreadEntriesTestProvider>
          <MemoryRouter initialEntries={["/projects/proj_1/threads/thr_1"]}>
            <RouteNavigationProvider>
              <ActionHistoryProvider>
                <ThreadActionsProvider>
                  <PluginSidebarFooterCards />
                  <LocationProbe />
                </ThreadActionsProvider>
              </ActionHistoryProvider>
            </RouteNavigationProvider>
          </MemoryRouter>
        </SidebarThreadEntriesTestProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByTestId("footer card-context").textContent).toBe(
      "proj_1/thr_1",
    );
    expect(await screen.findByText("floating")).toBeDefined();
    expect(screen.getByTestId("footer card-sidebar-actions").textContent).toBe(
      "function",
    );
    fireEvent.click(screen.getByRole("button", { name: "Call RPC" }));
    expect(await screen.findByText("pong")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/plugins/office/rpc/ping",
      expect.objectContaining({ method: "POST" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go home" }));
    expect(screen.getByTestId("location").textContent).toBe("/");
    expect(screen.getByTestId("footer card-rpc").textContent).toBe("pong");
    expect(screen.getByTestId("footer card-sidebar-actions").textContent).toBe(
      "function",
    );
  });

  it("hides a crashing footer card without unmounting additive siblings", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    function Crashes(): never {
      throw new Error("footer card crashed");
    }

    function Fine() {
      return <div>fine footer card</div>;
    }

    setPluginSlotRegistrations(
      "broken",
      registrationSet({
        sidebarFooterCards: [{ id: "broken", component: Crashes }],
      }),
    );
    setPluginSlotRegistrations(
      "fine",
      registrationSet({
        sidebarFooterCards: [{ id: "fine", component: Fine }],
      }),
    );

    render(
      <MemoryRouter>
        <PluginSidebarFooterCards />
      </MemoryRouter>,
    );

    expect(screen.getByText("fine footer card")).toBeDefined();
    expect(screen.queryByText("plugin broken crashed")).toBeNull();
  });
});

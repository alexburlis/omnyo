// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginThreadListProps } from "@omnyo/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import type { ResolvedReplacement } from "@/lib/plugin-slot-resolvers";
import type { PluginThreadListSlot } from "@/lib/plugin-slots";
import * as pluginFrontend from "@/lib/plugin-frontend-lazy";
import { PluginThreadList } from "./PluginThreadList";

const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/components/ui/app-toast", () => ({ appToast: toast }));

function pluginReplacement(
  component: (props: PluginThreadListProps) => React.ReactNode,
): ResolvedReplacement<PluginThreadListSlot> {
  return {
    kind: "plugin",
    registration: {
      pluginId: "demo",
      generation: 1,
      id: "list",
      title: "Demo list",
      component,
    },
  };
}

function renderList(replacement: ResolvedReplacement<PluginThreadListSlot>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });

  queryClient.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({ id: "proj_web", name: "Web" }),
      ],
    }),
  );

  return render(
    <JotaiProvider store={createStore()}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <SidebarProvider>
            <PluginThreadList replacement={replacement} onNavigate={() => {}} />
          </SidebarProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </JotaiProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetPluginFrontendBootStateForTest();
  toast.error.mockClear();
});

afterEach(() => {
  cleanup();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("PluginThreadList", () => {
  it("shows the loading placeholder until plugin frontends have booted, then the missing state", () => {
    const reconcile = vi
      .spyOn(pluginFrontend, "schedulePluginFrontendReconcile")
      .mockImplementation(() => {});

    const { container } = renderList({ kind: "owner" });
    expect(
      container.querySelector('[data-thread-list-placeholder="loading"]'),
    ).not.toBeNull();
    expect(screen.getByLabelText("Loading sidebar navigation")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();

    act(() => markPluginFrontendsSettled());

    expect(
      container.querySelector('[data-thread-list-placeholder="missing"]'),
    ).not.toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Thread list unavailable.",
    );
    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("renders the plugin list with the host props and no delegation component", () => {
    const seen: PluginThreadListProps[] = [];
    renderList(
      pluginReplacement((props) => {
        seen.push(props);

        return <div data-testid="plugin-list">plugin list</div>;
      }),
    );

    expect(screen.getByTestId("plugin-list")).toBeDefined();
    expect(seen[0]).toMatchObject({
      activeThreadId: null,
      activeProjectId: null,
      isCompactViewport: false,
      experimental_scope: { kind: "inbox" },
      searchQuery: "",
    });
    expect("Original" in (seen[0] ?? {})).toBe(false);
  });

  it("passes the stored project scope to the list", () => {
    localStorage.setItem(
      "omnyo.sidebar.scope",
      JSON.stringify({ kind: "project", projectId: "proj_web" }),
    );
    const seen: PluginThreadListProps[] = [];
    renderList(
      pluginReplacement((props) => {
        seen.push(props);

        return null;
      }),
    );

    expect(seen.at(-1)?.experimental_scope).toEqual({
      kind: "project",
      projectId: "proj_web",
    });
  });

  it("replaces a crashed list with the crashed placeholder and remounts on reload", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let shouldCrash = true;

    const { container } = renderList(
      pluginReplacement(() => {
        if (shouldCrash) throw new Error("boom");

        return <div data-testid="plugin-list">recovered</div>;
      }),
    );

    expect(
      container.querySelector('[data-thread-list-placeholder="crashed"]'),
    ).not.toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Demo list stopped working.",
    );
    expect(toast.error).toHaveBeenCalledTimes(1);

    shouldCrash = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    expect(screen.getByTestId("plugin-list").textContent).toBe("recovered");
    expect(
      container.querySelector("[data-thread-list-placeholder]"),
    ).toBeNull();
  });
});

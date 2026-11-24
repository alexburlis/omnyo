// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import type { ExperimentalSidebarFooterCardProps } from "@omnyo/plugin-sdk";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { SidebarFooterStateProvider } from "@/components/sidebar/SidebarFooterState";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { AppFooter } from "./AppFooter";

vi.mock("@/hooks/useServerConnectionState", () => {
  const status = {
    state: "connected",
    host: "omnyo.example",
    since: null,
    failedAttempts: 0,
  };

  return {
    useServerConnectionState: () => status.state,
    useServerConnectionStatus: () => status,
  };
});

vi.mock("@/components/sidebar/ResourcesRailWidget", () => ({
  ResourcesRailWidget: () => null,
}));

function TagCard({
  experimental_placement,
}: ExperimentalSidebarFooterCardProps) {
  return <span>{`Tags in ${experimental_placement ?? "unknown"}`}</span>;
}

function renderFooter() {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider delayDuration={0}>
          <AppCommandProvider>
            <CompactViewportOverrideProvider isCompactViewport={false}>
              <SidebarProvider width="460px">
                <SidebarFooterStateProvider>
                  <AppFooter
                    isSettingsActive={false}
                    settingsToggleRoutePath="/settings"
                  />
                </SidebarFooterStateProvider>
                <SidebarTrigger />
              </SidebarProvider>
            </CompactViewportOverrideProvider>
          </AppCommandProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  window.localStorage.clear();
});

describe("AppFooter sidebar cell", () => {
  it("puts the Chat Topics tag filter under the open sidebar, apart from the centre cards", () => {
    setPluginSlotRegistrations(
      "chat-topics",
      makePluginRegistrationSet({
        sidebarFooterCards: [
          {
            id: "live",
            component: () => <button type="button">3 running</button>,
          },
          { id: "tag-filter", component: TagCard },
        ],
      }),
    );
    renderFooter();

    const footer = screen.getByTestId("app-footer");
    const start = within(footer).getByTestId("app-footer-start");
    const cell = within(footer).getByTestId("app-footer-sidebar-cell");
    const tags = within(footer).getByText("Tags in footer");
    const live = within(footer).getByRole("button", { name: "3 running" });

    expect(start.style.width).toBe("calc(460px - env(safe-area-inset-left))");
    expect(cell.contains(tags)).toBe(true);
    expect(cell.getAttribute("data-footer-region")).toBe("sidebar");
    expect(live.closest("[data-footer-center]")).not.toBeNull();
    expect(tags.closest("[data-footer-center]")).toBeNull();
    expect(within(footer).getAllByText(/^Tags in /)).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Toggle Sidebar" }));

    expect(start.style.width).toBe("");
    expect(within(footer).queryByTestId("app-footer-sidebar-cell")).toBeNull();
    expect(within(footer).queryByText(/^Tags in /)).toBeNull();
  });
});

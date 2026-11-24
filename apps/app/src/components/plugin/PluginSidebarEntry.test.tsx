// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalSidebarEntryStatus } from "@omnyo/plugin-sdk/app";
import { createSidebarNavigationRows } from "@/components/sidebar/sidebarNavigationItems";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet as registrationSet } from "@/test/fixtures/plugins";
import { PluginSidebarEntry } from "./PluginSidebarEntry";
import { resetAllCrashedPluginSlotsForTest } from "./PluginSlotMount";

function Page() {
  return null;
}

const panel = {
  id: "home",
  title: "Chief",
  icon: "Diamond",
  path: "home",
  component: Page,
};

function register(
  pluginId: string,
  useStatus?: () => ExperimentalSidebarEntryStatus | null,
  panels = [panel],
  id = "row",
) {
  setPluginSlotRegistrations(
    pluginId,
    registrationSet({
      navPanels: panels,
      sidebarEntries: [
        {
          id,
          title: "Chief",
          icon: "Diamond",
          panel: "home",
          tooltip: "What your chats need from you, across all projects",
          ...(useStatus === undefined ? {} : { useStatus }),
        },
      ],
    }),
  );
}

function renderEntry(path = "/", scope: "inbox" | "project" = "inbox") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <SidebarProvider framed={false}>
          <PluginSidebarEntry scope={scope} />
        </SidebarProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  vi.restoreAllMocks();
});

describe("PluginSidebarEntry", () => {
  it("places Chief's Needs you entry under Inbox and keeps it out of project sidebars", () => {
    register("chief", undefined, [panel], "chief");
    const inbox = renderEntry();

    expect(
      screen
        .getByRole("group", { name: "Inbox" })
        .querySelector("a")
        ?.getAttribute("href"),
    ).toBe("/plugins/chief/home");

    inbox.unmount();
    renderEntry("/", "project");

    expect(screen.queryByRole("group", { name: "Inbox" })).toBeNull();
    expect(screen.queryByTestId("sidebar-entry")).toBeNull();
  });

  it("allows another plugin's sidebar entry in project scope", () => {
    register("chief", undefined, [panel], "chief");
    register("example");
    renderEntry("/", "project");

    expect(screen.getByTestId("sidebar-entry").getAttribute("href")).toBe(
      "/plugins/example/home",
    );
  });

  it("renders the label without a dot while idle or loading", () => {
    register("chief", () => null);
    renderEntry();

    const row = screen.getByTestId("sidebar-entry");

    expect(row.textContent).toBe("Chief");
    expect(row.getAttribute("href")).toBe("/plugins/chief/home");
    expect(screen.queryByTestId("sidebar-entry-dot")).toBeNull();
  });

  it("shows a toned dot and never a number", () => {
    register("chief", () => ({
      dot: "failed",
      tooltip: "3 to decide",
      state: null,
    }));
    renderEntry();

    expect(
      screen.getByTestId("sidebar-entry-dot").getAttribute("data-tone"),
    ).toBe("failed");
    expect(screen.getByTestId("sidebar-entry").textContent).not.toMatch(/\d/);
    expect(
      screen.getByTestId("sidebar-entry").getAttribute("aria-label"),
    ).toContain("3 to decide");
  });

  it("shows Paused before the dot and an error mark instead of it", () => {
    register("chief", () => ({
      dot: "attention",
      tooltip: null,
      state: "paused",
    }));
    renderEntry();
    expect(screen.getByTestId("sidebar-entry").textContent).toBe("ChiefPaused");
    expect(screen.getByTestId("sidebar-entry-dot")).toBeTruthy();
  });

  it("keeps the row with an error mark when the status hook throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    register("chief", () => {
      throw new Error("boom");
    });
    renderEntry();

    expect(screen.getByTestId("sidebar-entry-error")).toBeTruthy();
    expect(
      screen.getByTestId("sidebar-entry").getAttribute("aria-label"),
    ).toContain("isn't responding");
  });

  it("marks the row current while its page is open", () => {
    register("chief");
    renderEntry("/plugins/chief/home");
    expect(
      screen.getByTestId("sidebar-entry").getAttribute("aria-current"),
    ).toBe("page");
  });

  it("ignores an entry whose panel is not registered by the same plugin", () => {
    register("chief", undefined, []);
    renderEntry();
    expect(screen.queryByTestId("sidebar-entry")).toBeNull();
  });
});

describe("createSidebarNavigationRows", () => {
  it("gives a sidebar entry's page no rail row", () => {
    const rows = createSidebarNavigationRows([
      {
        chrome: {
          pluginId: "chief",
          id: "home",
          path: "home",
          title: "Chief",
          icon: "Diamond",
          sidebarEntry: true,
        },
        panel: null,
      },
      {
        chrome: {
          pluginId: "glance",
          id: "board",
          path: "board",
          title: "Board",
          icon: "Eye",
        },
        panel: null,
      },
    ]);

    const panels = rows.filter(
      (row) => row.action.kind === "open-plugin-panel",
    );

    expect(panels.map((row) => row.id)).toEqual(["board"]);
  });
});

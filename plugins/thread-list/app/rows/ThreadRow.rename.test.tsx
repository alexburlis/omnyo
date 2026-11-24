// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
} from "@omnyo/plugin-sdk/testing/app";
import { makeSidebarThread } from "../model/fixtures.js";
import { SidebarRenameProvider } from "./SidebarInlineRename.js";
import { ThreadRowNavigationProvider } from "./threadRowNavigation.js";
import { resetPreferencesSyncForTest } from "../preferences/preferences-sync.js";

installTestPluginRuntime();

const { ThreadRow, resetSidebarTitleDoubleClickForTest } =
  await import("./ThreadRow.js");

function renderThreadRow({
  sdk,
  isCompactViewport = false,
}: { sdk?: PluginSdkTestFakes; isCompactViewport?: boolean } = {}) {
  const thread = makeSidebarThread();

  function Harness() {
    return (
      <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
        <TooltipProvider>
          <ThreadRowNavigationProvider>
            <SidebarRenameProvider>
              <ThreadRow
                thread={thread}
                crossProjectId={null}
                isActive={false}
                options={{
                  kind: "default",
                  depth: 1,
                  isChild: false,
                  isCompact: false,
                }}
              />
            </SidebarRenameProvider>
          </ThreadRowNavigationProvider>
        </TooltipProvider>
      </CompactViewportOverrideProvider>
    );
  }

  return renderSlot(
    { component: Harness },
    {},
    { sidebarThreads: { threads: [thread], projects: [] }, sdk },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSidebarTitleDoubleClickForTest();
  resetPreferencesSyncForTest();
});

describe("ThreadRow inline rename", () => {
  it.each(["title", "row", "trailing space"])(
    "edits the row title inline after a double click on %s and commits on Enter",
    async (target) => {
      const slot = renderThreadRow({
        sdk: { threads: { update: vi.fn().mockResolvedValue({}) } },
      });

      const link = screen.getByRole("link", { name: "Open Thread" });
      const row = link.closest("[data-sidebar-rename-row]")!;
      fireEvent.doubleClick(
        target === "title"
          ? screen.getByText("Thread")
          : target === "row"
            ? row
            : row.querySelector("[data-sidebar-thread-trailing]")!,
      );
      const input = await screen.findByRole("textbox", { name: "Thread name" });
      expect(input).toHaveProperty("value", "Thread");

      fireEvent.change(input, { target: { value: "Renamed thread" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(slot.inspection.sdkCalls).toEqual([
          {
            method: "threads.update",
            args: [{ threadId: "thr_test", title: "Renamed thread" }],
          },
        ]);
      });
      await waitFor(() => {
        expect(
          screen.queryByRole("textbox", { name: "Thread name" }),
        ).toBeNull();
      });
      expect(screen.getByText("Thread")).not.toBeNull();
    },
  );

  it("opens the thread and then the rename dialog when the title is double-tapped on a compact viewport", async () => {
    const slot = renderThreadRow({
      isCompactViewport: true,
      sdk: { threads: { update: vi.fn().mockResolvedValue({}) } },
    });

    const link = screen.getByRole("link", { name: "Open Thread" });

    expect(fireEvent.click(link)).toBe(true);
    expect(fireEvent.click(link)).toBe(false);
    fireEvent.doubleClick(screen.getByText("Thread"));

    const dialog = await screen.findByRole("dialog");

    const input = await within(dialog).findByRole("textbox", {
      name: "Thread name",
    });

    expect(input).toHaveProperty("value", "Thread");
    expect(
      link.closest("[data-sidebar-rename-row]")!.querySelector("input"),
    ).toBeNull();

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rename thread" }),
    );

    await waitFor(() => {
      expect(slot.inspection.sdkCalls).toEqual([
        {
          method: "threads.update",
          args: [{ threadId: "thr_test", title: "Renamed thread" }],
        },
      ]);
    });
  });

  it("does not rename when a row action is double-clicked", () => {
    renderThreadRow();
    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Thread actions" }),
    );

    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
  });

  it("cancels a row double-click rename with Escape without saving", async () => {
    const slot = renderThreadRow();

    const row = screen
      .getByRole("link", { name: "Open Thread" })
      .closest("[data-sidebar-rename-row]")!;

    fireEvent.doubleClick(row);
    const input = await screen.findByRole("textbox", { name: "Thread name" });

    fireEvent.change(input, { target: { value: "Discard this" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Thread")).not.toBeNull();
    expect(slot.inspection.sdkCalls).toEqual([]);
  });
});

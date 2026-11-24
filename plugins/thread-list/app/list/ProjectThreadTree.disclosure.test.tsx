// @vitest-environment jsdom

import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { SidebarThread } from "../model/sidebar-thread.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import { makeSidebarThread } from "../model/fixtures.js";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";

installTestPluginRuntime();

const { ProjectThreadTree } = await import("./ProjectRow.js");

function Slot({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <ThreadRowNavigationProvider>
        <SidebarRenameProvider>{children}</SidebarRenameProvider>
      </ThreadRowNavigationProvider>
    </TooltipProvider>
  );
}

function makePlainThreads(count: number): SidebarThread[] {
  return Array.from({ length: count }, (_, index) =>
    makeSidebarThread({
      lastReadAt: 100,
      latestAttentionAt: 100,
      id: `thr_item_${index}`,
      title: `Thread ${index}`,
      titleFallback: `Thread ${index}`,
      createdAt: index,
      updatedAt: index,
    }),
  );
}

function renderThreadTree(
  threads: SidebarThread[],
  { selectedThreadId }: { selectedThreadId?: string } = {},
) {
  return renderSlot(
    { component: Slot },
    {
      children: (
        <ProjectThreadTree
          threadListState={{ status: "ready", threads }}
          compareThreads={() => 0}
          selectedThreadId={selectedThreadId}
          collapsedEnvironmentIds={new Set()}
          onToggleEnvironmentCollapsed={vi.fn()}
        />
      ),
    },
    { sidebarThreads: { threads } },
  );
}

describe("ProjectThreadTree without progressive disclosure", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the full list without a Show more control", () => {
    renderThreadTree(makePlainThreads(17));

    expect(screen.getByText("Thread 0")).not.toBeNull();
    expect(screen.getByText("Thread 5")).not.toBeNull();
    expect(screen.getByText("Thread 16")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
  });

  it("renders nested threads under their parent", () => {
    const threads = makePlainThreads(8);
    threads[7] = {
      ...threads[7],
      parentThreadId: threads[6].id,
      hasPendingInteraction: true,
    };
    renderThreadTree(threads);

    expect(screen.getByText("Thread 6")).not.toBeNull();
    expect(screen.getByText("Thread 7")).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Collapse Thread 6 threads" }),
    ).toBeNull();
  });

  it("keeps child chats visible whichever chat is open", () => {
    const threads = makePlainThreads(3);
    threads[1] = { ...threads[1], parentThreadId: threads[0].id };

    for (const selectedThreadId of [
      undefined,
      threads[0].id,
      threads[1].id,
      threads[2].id,
    ]) {
      renderThreadTree(threads, { selectedThreadId });
      expect(screen.getByText("Thread 1")).not.toBeNull();
      cleanup();
    }
  });

  it("shows the unavailable state instead of rows when threads cannot load", () => {
    renderSlot(
      { component: Slot },
      {
        children: (
          <ProjectThreadTree
            threadListState={{ status: "unavailable" }}
            compareThreads={() => 0}
            collapsedEnvironmentIds={new Set()}
            onToggleEnvironmentCollapsed={vi.fn()}
          />
        ),
      },
    );

    expect(screen.getByText("Couldn’t load threads")).not.toBeNull();
  });
});

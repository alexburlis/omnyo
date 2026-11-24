// @vitest-environment jsdom

import { act, cleanup } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Provider, createStore } from "jotai";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import { ThreadRowNavigationProvider } from "../rows/threadRowNavigation.js";
import { SidebarRenameProvider } from "../rows/SidebarInlineRename.js";
import { makeSidebarProject, makeSidebarThread } from "../model/fixtures.js";
import { buildShelfRootNodes } from "../model/sidebar-thread-lifecycle.js";

const dragEndHandlers: ((event: DragEndEvent) => void)[] = [];

vi.mock("@dnd-kit/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/core")>();

  return {
    ...actual,
    DndContext: (props: Parameters<typeof actual.DndContext>[0]) => {
      if (props.onDragEnd) dragEndHandlers.push(props.onDragEnd);

      return <actual.DndContext {...props} />;
    },
  };
});

installTestPluginRuntime();

const { ShelfThreadTree } = await import("./ShelfThreadTree.js");

const SHELF = [
  makeSidebarThread({
    id: "thr_keyed_late",
    title: "Keyed late",
    experimental_shelvedAt: 30,
    experimental_shelfSortKey: "V2",
  }),
  makeSidebarThread({
    id: "thr_keyed_early",
    title: "Keyed early",
    experimental_shelvedAt: 10,
    experimental_shelfSortKey: "V1",
  }),
  makeSidebarThread({
    id: "thr_just_shelved",
    title: "Just shelved",
    experimental_shelvedAt: 5,
    experimental_shelfSortKey: null,
  }),
];

function Harness({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <Provider store={createStore()}>
        <ThreadRowNavigationProvider>
          <SidebarRenameProvider>{children}</SidebarRenameProvider>
        </ThreadRowNavigationProvider>
      </Provider>
    </TooltipProvider>
  );
}

function renderShelf(onReorder = vi.fn()) {
  const { container } = renderSlot(
    { component: Harness },
    {
      children: (
        <ShelfThreadTree
          rootNodes={buildShelfRootNodes(SHELF)}
          collapsedEnvironmentIds={new Set()}
          onToggleEnvironmentCollapsed={vi.fn()}
          isReorderPending={false}
          onReorder={onReorder}
        />
      ),
    },
    {
      sidebarThreads: { threads: SHELF, projects: [makeSidebarProject()] },
    },
  );

  const rowIds = () =>
    Array.from(container.querySelectorAll("[data-sidebar-thread-id]"), (row) =>
      row.getAttribute("data-sidebar-thread-id"),
    );

  return { onReorder, rowIds };
}

function drop(activeId: string, overId: string) {
  const handleDragEnd = dragEndHandlers.at(-1);

  if (!handleDragEnd) throw new Error("Shelf rows are not draggable");

  act(() => {
    handleDragEnd({ active: { id: activeId }, over: { id: overId } } as never);
  });
}

describe("ShelfThreadTree", () => {
  afterEach(() => {
    cleanup();
    dragEndHandlers.length = 0;
  });

  it("lists a just-shelved chat first, then the owner's Shelf order", () => {
    const { rowIds } = renderShelf();

    expect(rowIds()).toEqual([
      "thr_just_shelved",
      "thr_keyed_early",
      "thr_keyed_late",
    ]);
  });

  it("moves a dropped row at once and asks for its new neighbors", () => {
    const { onReorder, rowIds } = renderShelf();

    drop("thr_keyed_late", "thr_just_shelved");

    expect(rowIds()).toEqual([
      "thr_keyed_late",
      "thr_just_shelved",
      "thr_keyed_early",
    ]);
    expect(onReorder).toHaveBeenCalledWith(
      {
        itemId: "thr_keyed_late",
        previousItemId: null,
        nextItemId: "thr_just_shelved",
      },
      { onSettled: expect.any(Function) },
    );

    act(() => {
      onReorder.mock.calls[0]?.[1].onSettled();
    });

    expect(rowIds()).toEqual([
      "thr_just_shelved",
      "thr_keyed_early",
      "thr_keyed_late",
    ]);
  });
});

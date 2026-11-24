// @vitest-environment jsdom

import type { ReactNode } from "react";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { afterEach, describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  withDisabledWorkflowsSdk,
} from "../model/fixtures.js";
import { preferencesReadyAtom } from "../preferences/preferences-sync.js";
import { sidebarOrganizationModeAtom } from "../preferences/atoms.js";

installTestPluginRuntime();

const { ProjectList } = await import("./ProjectList.js");

const { resetSidebarDataCacheForTest } =
  await import("../model/use-sidebar-data.js");

afterEach(() => {
  cleanup();
  resetSidebarDataCacheForTest();
});

function Harness({
  children,
  store,
}: {
  children: ReactNode;
  store: ReturnType<typeof createStore>;
}) {
  return (
    <TooltipProvider>
      <Provider store={store}>{children}</Provider>
    </TooltipProvider>
  );
}

function renderHandoffChain(activeThreadId: string | null = null) {
  const store = createStore();
  store.set(preferencesReadyAtom(), true);
  store.set(sidebarOrganizationModeAtom, "chronological");

  renderSlot(
    { component: Harness },
    {
      children: (
        <ProjectList activeThreadId={activeThreadId} scopeProjectId={null} />
      ),
      store,
    },
    {
      sidebarThreads: {
        threads: [
          makeSidebarThread({
            id: "thr_source",
            title: "Importer on Opus",
            createdAt: 1,
            updatedAt: 1,
          }),
          makeSidebarThread({
            id: "thr_unrelated",
            title: "Release notes",
            createdAt: 2,
            updatedAt: 2,
          }),
          makeSidebarThread({
            id: "thr_target",
            title: "Importer on Fable",
            originKind: "handoff",
            sourceThreadId: "thr_source",
            createdAt: 3,
            updatedAt: 3,
          }),
        ],
        projects: [makePluginProject()],
        sections: [],
      },
      sdk: withDisabledWorkflowsSdk({}),
    },
  );
}

function row(title: string): HTMLElement {
  const link = screen.getByRole("link", { name: `Open ${title}` });
  const container = link.closest<HTMLElement>("[data-sidebar-rename-row]");

  if (container === null) throw new Error(`No row for ${title}`);

  return container;
}

function isHighlighted(title: string): boolean {
  return row(title).getAttribute("data-sidebar-handoff-highlight") === "true";
}

function hasHandoffGlyph(title: string): boolean {
  return row(title).querySelector("[data-sidebar-thread-handoff]") !== null;
}

describe("handoff lineage in the sidebar", () => {
  it("keeps the source highlighted while viewing a handoff child after hover ends", async () => {
    renderHandoffChain("thr_target");
    await screen.findByRole("link", { name: "Open Importer on Fable" });
    expect(isHighlighted("Importer on Opus")).toBe(true);
    expect(isHighlighted("Importer on Fable")).toBe(false);
    expect(isHighlighted("Release notes")).toBe(false);
    fireEvent.pointerEnter(row("Importer on Fable"), { pointerType: "mouse" });
    fireEvent.pointerLeave(row("Importer on Fable"), { pointerType: "mouse" });
    expect(isHighlighted("Importer on Opus")).toBe(true);
  });

  it("groups the earlier chat under its continuation and highlights the other end on hover", async () => {
    renderHandoffChain();
    await screen.findByRole("link", { name: "Open Importer on Fable" });

    expect(hasHandoffGlyph("Importer on Opus")).toBe(true);
    expect(hasHandoffGlyph("Importer on Fable")).toBe(true);
    expect(hasHandoffGlyph("Release notes")).toBe(false);

    const order = () =>
      screen
        .getAllByRole("link", { name: /^Open / })
        .map((link) => link.getAttribute("aria-label"));

    const before = order();
    expect(before).toEqual([
      "Open Importer on Fable",
      "Open Importer on Opus",
      "Open Release notes",
    ]);
    expect(row("Importer on Fable").style.paddingLeft).toBe("8px");
    expect(row("Importer on Opus").style.paddingLeft).toBe("32px");
    expect(row("Release notes").style.paddingLeft).toBe("8px");

    fireEvent.pointerEnter(row("Importer on Fable"), { pointerType: "mouse" });

    expect(isHighlighted("Importer on Opus")).toBe(true);
    expect(isHighlighted("Importer on Fable")).toBe(false);
    expect(isHighlighted("Release notes")).toBe(false);
    expect(order()).toEqual(before);

    fireEvent.pointerLeave(row("Importer on Fable"), { pointerType: "mouse" });
    expect(isHighlighted("Importer on Opus")).toBe(false);

    fireEvent.pointerEnter(row("Importer on Opus"), { pointerType: "mouse" });
    expect(isHighlighted("Importer on Fable")).toBe(true);
    expect(isHighlighted("Release notes")).toBe(false);

    fireEvent.pointerLeave(row("Importer on Opus"), { pointerType: "mouse" });
    fireEvent.pointerEnter(row("Release notes"), { pointerType: "mouse" });
    expect(isHighlighted("Importer on Opus")).toBe(false);
    expect(isHighlighted("Importer on Fable")).toBe(false);
  });
});

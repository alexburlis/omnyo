import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Board, CanvasNode } from "../contract";
import { ProjectContentsTree, ProjectOutline } from "../components/project-outline";

afterEach(cleanup);

it("roves across views and expanded children without tabbing into closed sections", () => {
  const openView = vi.fn();
  render(
    <ProjectContentsTree>
      <div role="treeitem" tabIndex={-1} aria-label="Overview">
        <button type="button" tabIndex={-1} onClick={openView}>
          Overview
        </button>
      </div>
      <details role="treeitem" tabIndex={-1} aria-label="Deployment">
        <summary tabIndex={-1}>
          <button type="button" tabIndex={-1}>
            Deployment
          </button>
        </summary>
        <div role="group">
          <button role="treeitem" tabIndex={-1} type="button">
            Apps
          </button>
        </div>
      </details>
      <button role="treeitem" tabIndex={-1} type="button">
        Revenue
      </button>
    </ProjectContentsTree>,
  );
  const overview = screen.getByRole("treeitem", { name: "Overview" });
  const deployment = screen.getByRole("treeitem", { name: "Deployment" });
  const revenue = screen.getByRole("treeitem", { name: "Revenue" });
  overview.focus();
  expect(overview.tabIndex).toBe(0);
  fireEvent.keyDown(overview, { key: "Enter" });
  expect(openView).toHaveBeenCalledOnce();
  fireEvent.keyDown(overview, { key: "ArrowDown" });
  expect(document.activeElement).toBe(deployment);
  fireEvent.keyDown(deployment, { key: "ArrowDown" });
  expect(document.activeElement).toBe(revenue);
  fireEvent.keyDown(revenue, { key: "ArrowUp" });
  fireEvent.keyDown(deployment, { key: "ArrowRight" });
  expect(deployment).toHaveProperty("open", true);
  fireEvent.keyDown(deployment, { key: "ArrowRight" });
  const apps = screen.getByRole("treeitem", { name: "Apps" });
  expect(document.activeElement).toBe(apps);
  expect(overview.tabIndex).toBe(-1);
  expect(apps.tabIndex).toBe(0);
  fireEvent.keyDown(apps, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(deployment);
  fireEvent.keyDown(deployment, { key: "ArrowLeft" });
  expect(deployment).toHaveProperty("open", false);
  fireEvent.keyDown(deployment, { key: "End" });
  expect(document.activeElement).toBe(revenue);
  fireEvent.keyDown(revenue, { key: "Home" });
  expect(document.activeElement).toBe(overview);
});

it("activates a child treeitem with Space", () => {
  const select = vi.fn();
  render(
    <ProjectContentsTree>
      <button type="button" role="treeitem" tabIndex={-1} onClick={select}>
        Apps
      </button>
    </ProjectContentsTree>,
  );
  fireEvent.keyDown(screen.getByRole("treeitem"), { key: " " });
  expect(select).toHaveBeenCalledOnce();
});

function node(id: string): CanvasNode {
  return {
    id,
    kind: "note",
    order: 0,
    section: "Summary",
    title: id,
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: null,
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 1,
    updatedAt: 1,
  };
}

it("reuses composition reading order and scrolls the outline itself to a saved module", () => {
  const board: Board = {
    threadId: "section",
    revision: 1,
    seenRevision: 0,
    nodes: [node("one"), node("two")],
    sections: ["Summary"],
    edges: [],
    composition: {
      width: 1400,
      root: { flow: "column", children: [{ node: "two" }, { node: "one" }] },
    },
  };

  const view = (key: string) => (
    <ProjectOutline
      board={board}
      workspace={{ hostId: null, environmentId: null }}
      sources={[]}
      selected={null}
      onSelect={() => {}}
      anchor={{ kind: "node", id: "one", key }}
    >
      <h3>Chats</h3>
    </ProjectOutline>
  );

  const rendered = render(view("first"));
  const outline = rendered.container.querySelector<HTMLElement>(".cnv-project-outline");
  const cards = rendered.container.querySelectorAll<HTMLElement>("[data-node-id]");
  expect(Array.from(cards).map((card) => card.dataset.nodeId)).toEqual(["two", "one"]);
  const one = cards[1];

  if (!outline || !one) throw new Error("Outline module missing");
  vi.spyOn(outline, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 20, 300, 500));
  vi.spyOn(one, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 220, 300, 80));
  rendered.rerender(view("saved-view"));
  expect(outline.scrollTop).toBe(200);
  expect(screen.getByRole("heading", { name: "Chats" })).toBeTruthy();
});

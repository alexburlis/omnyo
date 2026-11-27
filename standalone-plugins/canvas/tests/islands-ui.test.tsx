import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Board, CanvasNode, Composition } from "../contract";
import { BoardCanvas } from "../components/board";
import { EditorWorkbench, type EditorActions } from "../components/editor";
import { frameDocument } from "../lib/frame-document";
import { Outline } from "../components/outline";
import { readRenderReports } from "../components/render-report";
import { islandGroups } from "../lib/composition";

const observed = new Map<Element, () => void>();

beforeEach(() => {
  class Pointer extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;

    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }

  vi.stubGlobal("PointerEvent", Pointer);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: () => void) {}
      observe(target: Element) {
        observed.set(target, this.callback);
      }
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  observed.clear();
  vi.unstubAllGlobals();
});

function node(id: string): CanvasNode {
  return {
    id,
    kind: "note",
    order: 1,
    section: "Work",
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
    updatedAt: 0,
  };
}

const composition: Composition = {
  width: 1200,
  root: {
    flow: "column",
    children: [
      {
        id: "islands",
        flow: "row",
        children: [
          {
            id: "discovery",
            flow: "bento",
            columns: 2,
            island: { title: "Discovery", question: "How do people find us?", accent: "blue" },
            children: [{ node: "clicks" }, { node: "trend" }],
          },
          {
            id: "business",
            flow: "column",
            island: { title: "Business", accent: "violet" },
            children: [{ node: "accounts" }],
          },
        ],
      },
    ],
  },
};

const board: Board = {
  threadId: "islands",
  revision: 3,
  seenRevision: 3,
  sections: ["Work"],
  nodes: ["clicks", "trend", "accounts"].map(node),
  edges: [],
  composition,
};

function setup() {
  const onSelectIsland = vi.fn();
  const onIslandMove = vi.fn();
  const onSelect = vi.fn();

  const { container } = render(
    <BoardCanvas
      board={board}
      baseline={3}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      selectedIsland="discovery"
      onSelect={onSelect}
      onSelectIsland={onSelectIsland}
      onMove={() => {}}
      onIslandMove={onIslandMove}
      onCommands={() => {}}
    />,
  );

  const surface = container.querySelector<HTMLElement>(".cnv-board");

  if (!surface) throw new Error("Missing board");
  vi.spyOn(surface, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 700));
  Object.defineProperties(surface, {
    clientWidth: { get: () => 1000 },
    clientHeight: { get: () => 700 },
  });
  act(() => observed.get(surface)?.());

  return { container, surface, onSelectIsland, onIslandMove, onSelect };
}

it("draws each island as a named, accented surface behind its modules", () => {
  const { container } = setup();
  const islands = Array.from(container.querySelectorAll<HTMLElement>(".cnv-island"));

  expect(islands.map((island) => island.dataset.islandId)).toEqual(["discovery", "business"]);
  expect(islands.map((island) => island.dataset.accent)).toEqual(["blue", "violet"]);
  expect(islands[0]?.dataset.selected).toBe("true");
  expect(islands[0]?.textContent).toContain("How do people find us?");
  expect(container.querySelector('[data-node-id="clicks"]')?.getAttribute("data-accent")).toBe(
    "blue",
  );
  expect(container.querySelector('[data-node-id="accounts"]')?.getAttribute("data-island")).toBe(
    "business",
  );
  expect(container.querySelectorAll(".cnv-minimap-island")).toHaveLength(2);
});

it("selects an island from its title and moves the whole island by dragging it", () => {
  const { container, surface, onSelectIsland, onIslandMove } = setup();
  const head = container.querySelector<HTMLElement>('[data-island-id="business"] .cnv-island-head');

  if (!head) throw new Error("Missing island title");
  const before = container.querySelector<HTMLElement>('[data-node-id="accounts"]')?.style.left;

  fireEvent.pointerDown(head, { button: 0, pointerId: 4, clientX: 500, clientY: 100 });
  expect(onSelectIsland).toHaveBeenCalledWith("business");
  fireEvent.pointerMove(surface, { pointerId: 4, clientX: 580, clientY: 140 });

  const during = container.querySelector<HTMLElement>('[data-node-id="accounts"]')?.style.left;

  expect(parseFloat(during ?? "0")).toBeGreaterThan(parseFloat(before ?? "0"));
  fireEvent.pointerUp(surface, { pointerId: 4, clientX: 580, clientY: 140 });

  const [id, offset] = onIslandMove.mock.calls[0] ?? [];

  expect(id).toBe("business");
  expect(offset.x).toBeGreaterThan(0);
  expect(offset.y).toBeGreaterThan(0);
});

it("turns island names into clickable map labels when zoomed out", () => {
  const { container, surface, onSelectIsland } = setup();
  const labels = container.querySelector<HTMLElement>(".cnv-island-labels");
  const world = container.querySelector<HTMLElement>(".cnv-world");

  fireEvent.wheel(surface, { deltaY: 400, ctrlKey: true, clientX: 500, clientY: 350 });
  fireEvent.wheel(surface, { deltaY: 400, ctrlKey: true, clientX: 500, clientY: 350 });

  expect(Number(world?.style.getPropertyValue("--cnv-zoom"))).toBeGreaterThan(0.15);
  expect(surface.dataset.detail).toBe("evidence");
  expect(labels?.dataset.visible).toBe("false");

  fireEvent.wheel(surface, { deltaY: 25, ctrlKey: true, clientX: 500, clientY: 350 });

  expect(Number(world?.style.getPropertyValue("--cnv-zoom"))).toBeGreaterThan(0.12);
  expect(surface.dataset.detail).toBe("overview");
  expect(labels?.dataset.visible).toBe("true");

  const label = Array.from(container.querySelectorAll<HTMLElement>(".cnv-island-label")).find(
    (entry) => entry.textContent?.includes("Business"),
  );

  if (!label) throw new Error("Missing overview label");
  expect(label.tabIndex).toBe(0);
  expect(container.querySelector(".cnv-island-label-question")).toBeNull();
  fireEvent.click(label);
  expect(onSelectIsland).toHaveBeenCalledWith("business");

  for (let step = 0; step < 8; step += 1)
    fireEvent.wheel(surface, { deltaY: -400, ctrlKey: true, clientX: 500, clientY: 350 });
  expect(labels?.dataset.visible).toBe("false");
});

it("turns modules into a bento of titles when zoomed far out, sized to stay readable", () => {
  const { container, surface } = setup();
  const clicks = () => container.querySelector<HTMLElement>('[data-node-id="clicks"]');

  expect(clicks()?.querySelector(".cnv-node-tile")).toBeNull();

  for (let step = 0; step < 14; step += 1)
    fireEvent.wheel(surface, { deltaY: 400, ctrlKey: true, clientX: 500, clientY: 350 });

  expect(surface.dataset.detail).toBe("map");
  expect(container.querySelector(".cnv-island-labels")?.getAttribute("data-visible")).toBe("true");
  expect(clicks()?.dataset.tile).toBe("true");
  expect(clicks()?.querySelector(".cnv-node-tile")?.textContent).toBe(
    board.nodes.find((node) => node.id === "clicks")?.title,
  );

  const world = container.querySelector<HTMLElement>(".cnv-world");
  const zoom = Number(world?.style.getPropertyValue("--cnv-zoom"));

  expect(zoom).toBeLessThanOrEqual(0.12);
  expect(zoom).toBeGreaterThanOrEqual(0.1);

  for (const label of Array.from(container.querySelectorAll<HTMLElement>(".cnv-island-label"))) {
    const size = parseFloat(label.style.getPropertyValue("--cnv-label-size"));

    expect(size).toBeGreaterThanOrEqual(11);
    expect(size).toBeLessThanOrEqual(16);
  }
});

it("groups the compact outline into island sections in reading order", () => {
  const { container } = render(
    <Outline
      board={board}
      baseline={3}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      onSelect={() => {}}
    />,
  );

  const sections = Array.from(container.querySelectorAll<HTMLElement>(".cnv-outline-island"));

  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
    "Discovery",
    "Business",
  ]);
  expect(sections[0]?.querySelectorAll(".cnv-node")).toHaveLength(2);
  expect(sections[0]?.textContent).toContain("How do people find us?");
});

it("reports a row module that leaves a large blank beside a taller neighbour", () => {
  const { container } = setup();
  const clicks = container.querySelector<HTMLElement>('[data-node-id="clicks"]');

  if (!clicks) throw new Error("Missing module");
  clicks.dataset.slackBlank = "260";
  clicks.dataset.slackRow = "420";

  const reports = readRenderReports(container, board, false);

  expect(reports.find((report) => report.nodeId === "clicks")?.issues).toContain(
    "Uneven row clicks: 260px blank below it. Stack a related module there, change spans or widths, or move it.",
  );
  expect(reports.find((report) => report.nodeId === "trend")?.issues ?? []).toEqual([]);
});

it("edits an island's name, question and accent through one arrangement change", async () => {
  const compose = vi.fn<(value: Composition) => Promise<void>>(async () => {});
  const island = islandGroups(composition.root).find((entry) => entry.id === "business");

  if (!island) throw new Error("Missing island");

  const actions: EditorActions = {
    readHistory: vi.fn(),
    loadHistory: vi.fn(),
    refreshHistory: vi.fn(),
    inspect: vi.fn(),
    edit: vi.fn(),
    verify: vi.fn(),
    undo: vi.fn(),
    redo: vi.fn(),
    duplicate: vi.fn(),
    compose,
    move: vi.fn(),
    reference: vi.fn(),
    pin: vi.fn(),
    hide: vi.fn(),
    resetPosition: vi.fn(),
    saveSource: vi.fn(),
    refreshSource: vi.fn(),
    pauseSource: vi.fn(),
    pushDataset: vi.fn(),
    addModule: vi.fn(),
  };

  render(
    <EditorWorkbench
      threadId="islands"
      mode="inspect"
      onMode={() => {}}
      onClose={() => {}}
      board={board}
      selectedNode={null}
      selectedIsland={island}
      sources={[]}
      history={null}
      busy={false}
      actions={actions}
    />,
  );

  fireEvent.change(screen.getByLabelText("Question it answers"), {
    target: { value: "Are accounts growing?" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Teal" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  });

  const sent = compose.mock.calls[0]?.[0];
  const updated = sent ? islandGroups(sent.root).find((entry) => entry.id === "business") : null;

  expect(updated?.island).toEqual({
    title: "Business",
    question: "Are accounts growing?",
    accent: "teal",
  });
  expect(updated?.children).toEqual(island.children);
});

it("hands the island accent to sandboxed HTML as the brand and first chart color", () => {
  const source = frameDocument(
    '<svg><rect class="canvas-bar"/></svg>',
    new Map([
      ["--primary", "oklch(0.8 0 0)"],
      ["--canvas-accent", "oklch(0.77 0.11 252)"],
    ]),
    "dark",
  );

  expect(source).toContain("--canvas-accent:oklch(0.77 0.11 252);");
  expect(source).toContain("--brand:var(--canvas-accent,var(--primary));");
  expect(source).toContain("--chart-1:var(--canvas-accent,var(--primary));");
});

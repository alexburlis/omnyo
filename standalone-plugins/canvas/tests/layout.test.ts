import { describe, expect, it } from "vitest";
import type { Board, CanvasNode } from "../contract.ts";
import {
  edgePath,
  fitViewport,
  layoutBoard,
  nodeChange,
  orderedNodes,
  nodeWidth,
  wideWidth,
  zoomAround,
  type Rect,
} from "../lib/layout.ts";

function node(id: string, section: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "note",
    order: 0,
    section,
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
    ...overrides,
  };
}

function board(nodes: CanvasNode[], sections: string[]): Board {
  return { threadId: "t", revision: 1, seenRevision: 0, sections, nodes, edges: [] };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe("board layout", () => {
  it("places sections left to right and never overlaps automatic nodes", () => {
    const nodes = [...["a", "b", "c", "d", "e"].map((id) => node(id, "One")), node("f", "Two")];

    const heights = new Map([
      ["a", 400],
      ["b", 120],
      ["c", 90],
      ["d", 300],
      ["e", 80],
    ]);

    const layout = layoutBoard(board(nodes, ["One", "Two"]), heights);
    const rects = [...layout.nodes.values()];

    for (const [index, rect] of rects.entries())
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);

    const [one, two] = layout.sections;

    expect(one?.rect.width).toBeGreaterThan(nodeWidth * 2);
    expect(two?.rect.x).toBeGreaterThan((one?.rect.x ?? 0) + (one?.rect.width ?? 0));
    expect(layout.nodes.get("f")?.x).toBeGreaterThan(two?.rect.x ?? 0);

    for (const id of ["a", "b", "c", "d", "e"]) {
      const rect = layout.nodes.get(id);

      expect(
        rect !== undefined &&
          one !== undefined &&
          rect.y + rect.height <= one.rect.y + one.rect.height,
      ).toBe(true);
    }
  });

  it("gives wide nodes the full row below every column", () => {
    const nodes = [
      ...["a", "b", "c", "d"].map((id) => node(id, "One")),
      node("shot", "One", { wide: true }),
      node("e", "One"),
    ];

    const heights = new Map([
      ["a", 300],
      ["b", 100],
      ["shot", 400],
    ]);

    const layout = layoutBoard(board(nodes, ["One"]), heights);
    const shot = layout.nodes.get("shot");
    const rects = [...layout.nodes.values()];

    for (const [index, rect] of rects.entries())
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);

    expect(shot?.width).toBe(wideWidth);
    expect(layout.sections[0]?.rect.width).toBeGreaterThanOrEqual(wideWidth);

    for (const id of ["a", "b", "c", "d"])
      expect((layout.nodes.get(id)?.y ?? 0) + (layout.nodes.get(id)?.height ?? 0)).toBeLessThan(
        shot?.y ?? 0,
      );
    expect(layout.nodes.get("e")?.y).toBeGreaterThan((shot?.y ?? 0) + (shot?.height ?? 0));
  });

  it("keeps a user-placed node where the user put it", () => {
    const layout = layoutBoard(
      board([node("a", "One"), node("b", "One", { position: { x: 900, y: 700 } })], ["One"]),
      new Map(),
    );

    expect(layout.nodes.get("b")).toMatchObject({ x: 900, y: 700 });
    expect(layout.bounds.x + layout.bounds.width).toBeGreaterThanOrEqual(900 + nodeWidth);
  });

  it("draws edges between existing nodes only", () => {
    const layout = layoutBoard(
      board([node("a", "One"), node("b", "Two")], ["One", "Two"]),
      new Map(),
    );

    expect(edgePath({ from: "a", to: "b", label: null }, layout)?.d).toMatch(/^M /u);
    expect(edgePath({ from: "a", to: "gone", label: null }, layout)).toBeNull();
  });

  it("zooms around the pointer and fits the board inside the viewport", () => {
    const zoomed = zoomAround({ x: 0, y: 0, zoom: 1 }, 2, 100, 50);

    expect(zoomed).toEqual({ zoom: 2, x: -100, y: -50 });

    const fitted = fitViewport({ x: 0, y: 0, width: 2000, height: 500 }, 1000, 600);

    expect(fitted.zoom).toBeCloseTo(0.46, 2);
    expect(fitted.x + 2000 * fitted.zoom).toBeLessThanOrEqual(1000);
  });

  it("marks nodes new or updated relative to the last seen revision", () => {
    expect(nodeChange({ createdRevision: 3, updatedRevision: 3 }, 2)).toBe("new");
    expect(nodeChange({ createdRevision: 1, updatedRevision: 3 }, 2)).toBe("updated");
    expect(nodeChange({ createdRevision: 1, updatedRevision: 2 }, 2)).toBeNull();
  });
});

describe("composed flow", () => {
  function composed(
    ids: string[],
    root: NonNullable<Board["composition"]>["root"],
    width = 984,
  ): Board {
    return {
      ...board(
        ids.map((id) => node(id, "One")),
        ["One"],
      ),
      composition: { width, root },
    };
  }

  it("allocates weighted widths through nested groups and flows later rows below the tallest content", () => {
    const input = composed(["a", "b", "c", "d"], {
      flow: "column",
      children: [
        {
          flow: "row",
          children: [
            { node: "a", weight: 2 },
            { flow: "column", children: [{ node: "b" }, { node: "c" }] },
          ],
        },
        { node: "d" },
      ],
    });

    const layout = layoutBoard(
      input,
      new Map([
        ["a", 100],
        ["b", 80],
        ["c", 60],
      ]),
    );

    expect(layout.nodes.get("a")).toEqual({ x: 0, y: 0, width: 640, height: 100 });
    expect(layout.nodes.get("b")).toEqual({ x: 664, y: 0, width: 320, height: 80 });
    expect(layout.nodes.get("c")?.y).toBe(104);
    expect(layout.nodes.get("d")?.y).toBe(188);
    expect(layout.sections).toEqual([]);

    const grown = layoutBoard(
      input,
      new Map([
        ["a", 500],
        ["b", 80],
        ["c", 60],
      ]),
    );

    expect(grown.nodes.get("d")?.y).toBe(524);
    expect(grown.nodes.get("a")?.width).toBe(640);
  });

  it("wraps at the requested minimum width and weights each completed row", () => {
    const input = composed(
      ["a", "b", "c", "d", "e"],
      {
        flow: "wrap",
        minWidth: 280,
        children: [
          { node: "a" },
          { node: "b" },
          { node: "c" },
          { node: "d", weight: 2 },
          { node: "e" },
        ],
      },
      900,
    );

    const layout = layoutBoard(input, new Map([["a", 200]]));
    expect(layout.nodes.get("a")?.width).toBe(284);
    expect(layout.nodes.get("c")?.x).toBe(616);
    expect(layout.nodes.get("d")).toMatchObject({ x: 0, y: 224, width: 584 });
    expect(layout.nodes.get("e")).toMatchObject({ x: 608, y: 224, width: 292 });
  });

  it("omits missing leaves and empty groups while appending every new node in reading order", () => {
    const input = composed(["a", "b", "c", "d"], {
      flow: "column",
      children: [
        { flow: "row", children: [{ node: "gone" }] },
        { flow: "row", children: [{ node: "d" }, { node: "a" }] },
      ],
    });

    expect(orderedNodes(input).map((entry) => entry.id)).toEqual(["d", "a", "b", "c"]);
    const layout = layoutBoard(input, new Map());
    expect([...layout.nodes.keys()]).toEqual(["d", "a", "b", "c"]);
    expect(layout.nodes.get("d")?.y).toBe(0);
    expect(layout.nodes.get("b")?.y).toBe(174);
    expect(layout.nodes.has("gone")).toBe(false);
  });

  it("reserves a moved node's slot and preserves its composed width after resetting", () => {
    const input = composed(["a", "b", "c"], {
      flow: "column",
      children: [
        { flow: "row", children: [{ node: "a", weight: 2 }, { node: "b" }] },
        { node: "c" },
      ],
    });

    input.nodes = input.nodes.map((entry) =>
      entry.id === "a" ? { ...entry, position: { x: 1400, y: 800 } } : entry,
    );
    const moved = layoutBoard(input, new Map([["a", 300]]));
    expect(moved.nodes.get("a")).toEqual({ x: 1400, y: 800, width: 640, height: 300 });
    expect(moved.nodes.get("c")?.y).toBe(324);
    expect(moved.bounds.width).toBe(2040);
    input.nodes = input.nodes.map((entry) => ({ ...entry, position: null }));
    const reset = layoutBoard(input, new Map([["a", 300]]));
    expect(reset.nodes.get("a")).toEqual({ x: 0, y: 0, width: 640, height: 300 });
    expect(reset.nodes.get("c")?.y).toBe(324);
  });

  it("keeps every width positive when gaps exceed a narrow row or nested group's width", () => {
    const input = composed(
      ["a", "b", "c", "d", "e", "f"],
      {
        flow: "row",
        gap: 120,
        children: [
          { node: "a" },
          { node: "b" },
          { node: "c" },
          { node: "d" },
          { node: "e" },
          { node: "f" },
        ],
      },
      480,
    );

    const layout = layoutBoard(input, new Map());
    expect(layout.nodes.get("a")?.width).toBe(40);
    expect(layout.nodes.get("f")?.x).toBe(440);
    input.composition = {
      width: 480,
      root: {
        flow: "row",
        gap: 120,
        children: [
          { node: "a", weight: 8 },
          {
            flow: "row",
            weight: 0.25,
            gap: 120,
            children: [
              { node: "b", weight: 8 },
              { node: "c", weight: 0.25 },
            ],
          },
        ],
      },
    };
    const nested = layoutBoard(input, new Map());

    for (const rect of nested.nodes.values()) {
      expect(Number.isFinite(rect.width)).toBe(true);
      expect(rect.width).toBeGreaterThan(0);
    }

    const rects = [...nested.nodes.values()];

    for (const [index, rect] of rects.entries())
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);
  });
});

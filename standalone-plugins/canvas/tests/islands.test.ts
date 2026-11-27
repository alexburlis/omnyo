import { describe, expect, it } from "vitest";
import {
  compositionSchema,
  composeInputSchema,
  flowIssues,
  type Board,
  type CanvasNode,
  type Composition,
  type FlowItem,
  type IslandGroup,
} from "../contract.ts";
import {
  assemble,
  compositionNotes,
  decompose,
  packBento,
  placeIsland,
  updateIsland,
} from "../lib/composition.ts";
import {
  islandHeaderGap,
  islandHeaderKey,
  islandPadding,
  layoutBoard,
  type Rect,
} from "../lib/layout.ts";

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "note",
    order: 0,
    section: "Main",
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

function board(
  ids: string[],
  composition: Composition,
  overrides: Record<string, Partial<CanvasNode>> = {},
): Board {
  return {
    threadId: "t",
    revision: 1,
    seenRevision: 0,
    sections: ["Main"],
    nodes: ids.map((id) => node(id, overrides[id])),
    edges: [],
    composition,
  };
}

function inside(inner: Rect, outer: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width + 0.001 &&
    inner.y + inner.height <= outer.y + outer.height + 0.001
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const discovery: IslandGroup = {
  id: "discovery",
  flow: "bento",
  columns: 3,
  island: { title: "Discovery", question: "How do people find us?", accent: "blue" },
  children: [
    { node: "clicks" },
    { node: "impressions" },
    { node: "ctr" },
    { node: "trend", span: 2 },
    { id: "trend-notes", flow: "column", children: [{ node: "reading" }, { node: "caveat" }] },
  ],
};

const browsing: IslandGroup = {
  id: "browsing",
  flow: "column",
  island: { title: "Browsing", question: "What happens after arrival?", accent: "teal" },
  children: [{ node: "views" }, { node: "depth" }],
};

const map: Composition = {
  width: 1600,
  root: {
    id: "map",
    flow: "column",
    children: [
      { node: "headline", emphasis: "lead" },
      { id: "islands", flow: "row", children: [{ ...discovery, weight: 2 }, browsing] },
      { node: "sources", emphasis: "quiet" },
    ],
  },
};

const ids = [
  "headline",
  "clicks",
  "impressions",
  "ctr",
  "trend",
  "reading",
  "caveat",
  "views",
  "depth",
  "sources",
];

describe("bento packing", () => {
  it("packs spans into aligned rows and lets the last module absorb unused tracks", () => {
    expect(packBento([1, 1, 1, 2, 1], 3)).toEqual([
      {
        slots: [
          { index: 0, track: 0, span: 1 },
          { index: 1, track: 1, span: 1 },
          { index: 2, track: 2, span: 1 },
        ],
        used: 3,
      },
      {
        slots: [
          { index: 3, track: 0, span: 2 },
          { index: 4, track: 2, span: 1 },
        ],
        used: 3,
      },
    ]);
    expect(packBento([2, 2], 3)).toEqual([
      { slots: [{ index: 0, track: 0, span: 3 }], used: 2 },
      { slots: [{ index: 1, track: 0, span: 3 }], used: 2 },
    ]);
    expect(packBento([3, 1], 2).map((row) => row.slots.map((slot) => slot.span))).toEqual([
      [2],
      [2],
    ]);
  });
});

describe("island layout", () => {
  const heights = new Map([
    ["headline", 80],
    ["clicks", 90],
    ["impressions", 90],
    ["ctr", 110],
    ["trend", 320],
    ["reading", 120],
    ["caveat", 60],
    ["views", 300],
    ["depth", 200],
    ["sources", 50],
    [islandHeaderKey("discovery"), 48],
  ]);

  it("wraps every member inside its island surface without overlaps", () => {
    const layout = layoutBoard(board(ids, map), heights);
    const frames = new Map(layout.islands.map((frame) => [frame.id, frame]));

    expect([...frames.keys()]).toEqual(["discovery", "browsing"]);
    expect(frames.get("discovery")?.accent).toBe("blue");

    for (const frame of layout.islands)
      for (const member of frame.members) {
        const rect = layout.nodes.get(member);

        expect(rect && inside(rect, frame.rect)).toBe(true);
      }

    expect(frames.get("discovery")?.members).toEqual([
      "clicks",
      "impressions",
      "ctr",
      "trend",
      "reading",
      "caveat",
    ]);

    const rects = [...layout.nodes.values()];

    for (const [index, rect] of rects.entries())
      for (const other of rects.slice(index + 1)) expect(overlaps(rect, other)).toBe(false);

    const [first, second] = layout.islands;

    expect(first && second && second.rect.x - (first.rect.x + first.rect.width)).toBeCloseTo(56);
  });

  it("aligns bento tracks across rows and stacks short modules beside a tall chart", () => {
    const layout = layoutBoard(board(ids, map), heights);
    const clicks = layout.nodes.get("clicks");
    const trend = layout.nodes.get("trend");
    const ctr = layout.nodes.get("ctr");
    const reading = layout.nodes.get("reading");
    const caveat = layout.nodes.get("caveat");

    expect(trend?.x).toBe(clicks?.x);
    expect(reading?.x).toBe(ctr?.x);
    expect(trend && clicks && ctr && trend.width).toBeCloseTo((clicks?.width ?? 0) * 2 + 20);
    expect(caveat?.y).toBe((reading?.y ?? 0) + 120 + 24);
  });

  it("starts island content below the measured header", () => {
    const layout = layoutBoard(board(ids, map), heights);
    const frame = layout.islands.find((entry) => entry.id === "discovery");
    const clicks = layout.nodes.get("clicks");

    expect(frame?.header).toBe(48 + islandHeaderGap);
    expect(clicks?.y).toBe((frame?.rect.y ?? 0) + islandPadding + 48 + islandHeaderGap);
  });

  it("collapses bento tracks on narrow widths while keeping reading order", () => {
    const narrow = layoutBoard(board(ids, { ...map, width: 600 }), heights);
    const clicks = narrow.nodes.get("clicks");
    const impressions = narrow.nodes.get("impressions");

    expect(impressions?.y).toBeGreaterThan(clicks?.y ?? 0);
    expect(impressions?.x).toBe(clicks?.x);
  });

  it("moves an offset island with its flowing members and leaves manual positions alone", () => {
    const moved = updateIsland(map, "discovery", { offset: { x: 400, y: -120 } });
    const before = layoutBoard(board(ids, map, { caveat: { position: { x: 9, y: 9 } } }), heights);
    const after = layoutBoard(board(ids, moved, { caveat: { position: { x: 9, y: 9 } } }), heights);
    const frameBefore = before.islands[0]?.rect;
    const frameAfter = after.islands[0]?.rect;

    expect((frameAfter?.x ?? 0) - (frameBefore?.x ?? 0)).toBe(400);
    expect((frameAfter?.y ?? 0) - (frameBefore?.y ?? 0)).toBe(-120);
    expect((after.nodes.get("clicks")?.x ?? 0) - (before.nodes.get("clicks")?.x ?? 0)).toBe(400);
    expect(after.nodes.get("caveat")).toMatchObject({ x: 9, y: 9 });
    expect(after.nodes.get("views")).toEqual(before.nodes.get("views"));
  });

  it("measures blank space beside short modules but not the sea between islands", () => {
    const layout = layoutBoard(board(ids, map), heights);

    expect(layout.slack.has("ctr")).toBe(false);
    expect(layout.slack.get("clicks")).toEqual({ blank: 20, row: 110 });
    expect(layout.slack.get("caveat")).toEqual({ blank: 116, row: 320 });
    expect(layout.slack.has("depth")).toBe(false);
    expect(layout.slack.has("views")).toBe(false);
  });

  it("drops archived members and islands that lose every module", () => {
    const remaining = board(["headline", "views", "depth", "sources"], map);
    const layout = layoutBoard(remaining, heights);

    expect(layout.islands.map((frame) => frame.id)).toEqual(["browsing"]);
  });
});

describe("history decomposition", () => {
  it("splits islands from the skeleton and reassembles the same composition", () => {
    const parts = decompose(map);

    expect([...parts.islands.keys()]).toEqual(["discovery", "browsing"]);
    expect(JSON.stringify(parts.skeleton)).toContain('{"island":"discovery"}');
    expect(assemble(parts.skeleton, parts.islands)).toEqual(compositionSchema.parse(map));
  });

  it("drops a placeholder whose island is missing instead of producing an invalid layout", () => {
    const parts = decompose(map);
    parts.islands.delete("browsing");
    const assembled = assemble(parts.skeleton, parts.islands);

    expect(assembled && JSON.stringify(assembled)).not.toContain("browsing");
    expect(assemble(null, new Map())).toBeNull();
  });
});

describe("local recomposition", () => {
  it("replaces one island in place without touching its neighbours", () => {
    const tightened: IslandGroup = {
      ...discovery,
      columns: 2,
      children: discovery.children.slice(0, 4),
    };

    const result = placeIsland(map, tightened);

    expect(result.inserted).toBe(false);
    expect(result.pulled).toEqual([]);
    expect(JSON.stringify(result.composition)).toContain('"columns":2');
    expect(decompose(result.composition).islands.get("browsing")).toEqual(
      decompose(map).islands.get("browsing"),
    );
  });

  it("pulls modules from other islands, drops emptied groups and inserts after an anchor", () => {
    const business: IslandGroup = {
      id: "business",
      flow: "column",
      island: { title: "Business", question: "Are accounts growing?" },
      children: [{ node: "views" }, { node: "depth" }],
    };

    const result = placeIsland(map, business, "islands");

    expect(result.pulled).toEqual([
      { node: "views", from: "island “Browsing”" },
      { node: "depth", from: "island “Browsing”" },
    ]);
    expect(result.dropped).toEqual(["Browsing"]);
    expect(result.inserted).toBe(true);

    const root = result.composition.root;

    const order =
      "flow" in root
        ? root.children.map((child: FlowItem) => ("node" in child ? child.node : child.id))
        : [];

    expect(order).toEqual(["headline", "islands", "business", "sources"]);
    expect(compositionSchema.safeParse(result.composition).success).toBe(true);
  });

  it("appends new islands to the root and rejects unknown anchors or plain-group ids", () => {
    const extra: IslandGroup = {
      id: "extra",
      flow: "column",
      island: { title: "Extra" },
      children: [{ node: "late" }],
    };

    const appended = placeIsland(map, extra);
    const root = appended.composition.root;

    expect("flow" in root && root.children.at(-1)).toEqual(extra);
    expect(() => placeIsland(map, extra, "nowhere")).toThrow("No group or island has id nowhere");
    expect(() => placeIsland(map, { ...extra, id: "islands" })).toThrow("belongs to a plain group");
  });
});

describe("structural validation", () => {
  it("rejects nested islands, anonymous islands, island roots and misplaced bento fields", () => {
    const nested: FlowItem = {
      id: "outer",
      flow: "column",
      island: { title: "Outer" },
      children: [
        { id: "inner", flow: "column", island: { title: "Inner" }, children: [{ node: "a" }] },
      ],
    };

    expect(flowIssues({ flow: "column", children: [nested] })).toContain(
      "Islands cannot contain other islands",
    );
    expect(
      flowIssues({
        flow: "column",
        children: [{ flow: "column", island: { title: "No id" }, children: [{ node: "a" }] }],
      }),
    ).toContain("An island needs a stable id");
    expect(
      flowIssues({
        id: "root",
        flow: "column",
        island: { title: "Root" },
        children: [{ node: "a" }],
      }),
    ).toContain("The root arranges islands; wrap islands in a root group");
    expect(flowIssues({ flow: "row", children: [{ node: "a", span: 2 }] })).toContain(
      "span applies only to children of a bento group",
    );
    expect(flowIssues({ flow: "bento", children: [{ node: "a", weight: 2 }] })).toContain(
      "Use span, not weight, for children of a bento group",
    );
    expect(flowIssues({ flow: "bento", columns: 2, children: [{ node: "a", span: 3 }] })).toContain(
      "A span of 3 exceeds its bento group's columns",
    );
    expect(flowIssues({ flow: "row", columns: 2, children: [{ node: "a" }] })).toContain(
      "columns applies only to bento groups",
    );
    expect(
      composeInputSchema.safeParse({
        composition: { width: 900, root: { flow: "column", children: [nested] } },
      }).success,
    ).toBe(false);
    expect(
      composeInputSchema.safeParse({
        island: { id: "solo", flow: "column", children: [{ node: "a" }] },
      }).success,
    ).toBe(false);
    expect(composeInputSchema.safeParse({ island: discovery }).success).toBe(true);
    expect(compositionSchema.safeParse({ ...map, width: 4000 }).success).toBe(true);
    expect(compositionSchema.safeParse({ ...map, width: 4001 }).success).toBe(false);
  });
});

describe("design notes", () => {
  it("flags single-module islands, missing questions, underfilled rows and repeated accents", () => {
    const notes = compositionNotes({
      width: 1400,
      root: {
        flow: "row",
        children: [
          {
            id: "a",
            flow: "column",
            island: { title: "Alpha", accent: "blue" },
            children: [{ node: "one" }],
          },
          {
            id: "b",
            flow: "bento",
            island: { title: "Beta", question: "Why?", accent: "blue" },
            children: [
              { node: "two", span: 2 },
              { node: "three", span: 2 },
            ],
          },
        ],
      },
    });

    expect(notes).toEqual([
      "The island “Alpha” holds one module. Merge it into a related island or drop the island wrapper.",
      "Give the island “Alpha” a question so readers know what it answers.",
      "Islands “Alpha” and “Beta” share the blue accent. Give each area its own accent or use neutral.",
      "In Beta, row 1 fills 2 of 3 columns, so its last module stretches. Adjust spans to choose the fill.",
      "In Beta, row 2 fills 2 of 3 columns, so its last module stretches. Adjust spans to choose the fill.",
    ]);
    expect(compositionNotes(map)).toEqual([]);
  });
});

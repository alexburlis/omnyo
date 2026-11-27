import { expect, it } from "vitest";
import type { ProjectView } from "../project-contract";
import {
  chatConnector,
  openChatCardRect,
  projectViewTarget,
  intersects,
  projectFit,
  unionRects,
  worldWindow,
} from "../components/project-geometry";

it("opens one tall section at its readable width from the top instead of shrinking it to a map", () => {
  const size = { width: 1370, height: 830 };
  const tall = { x: 100, y: 200, width: 2448, height: 6578 };

  expect(projectFit(tall, size).zoom).toBeLessThanOrEqual(0.12);
  const camera = projectFit(tall, size, true);

  expect(camera.zoom).toBeGreaterThan(0.12);
  expect(camera.zoom).toBeCloseTo((size.width - 96) / 2448);
  expect(camera.y + 200 * camera.zoom).toBeCloseTo(48);
  expect(camera.x + (100 + 1224) * camera.zoom).toBeCloseTo(size.width / 2);
});

it("fits a large project below the chat zoom floor while keeping its centre on screen", () => {
  const bounds = unionRects([
    { x: -4000, y: -1000, width: 1400, height: 800 },
    { x: 9000, y: 500, width: 1800, height: 1000 },
  ]);

  const size = { width: 1100, height: 800 };
  const camera = projectFit(bounds, size);
  const visible = worldWindow(camera, size);

  expect(camera.zoom).toBeLessThan(0.1);
  expect(camera.zoom).toBeGreaterThanOrEqual(0.02);
  expect(intersects(visible, { x: -4000, y: -1000, width: 1400, height: 800 })).toBe(true);
  expect(intersects(visible, { x: 9000, y: 500, width: 1800, height: 1000 })).toBe(true);
  const expanded = worldWindow({ x: 0, y: 0, zoom: 1 }, size, 1);

  expect(intersects(expanded, { x: 2100, y: 0, width: 100, height: 100 })).toBe(true);
  expect(intersects(expanded, { x: 2300, y: 0, width: 100, height: 100 })).toBe(false);
});

const sections = [{ id: "s", x: 1000, y: 2000 }];

const objectRect = { x: 150, y: 270, width: 300, height: 180 };

const geometry = new Map([
  [
    "s",
    {
      layer: {
        origin: { x: 100, y: 200 },
        layout: {
          nodes: new Map([["node", objectRect]]),
          islands: [{ id: "island", rect: objectRect }],
        },
      },
    },
  ],
]);

function view(anchorKind: ProjectView["anchorKind"], anchorId: string | null = null): ProjectView {
  return {
    id: "v",
    projectId: "p",
    title: "View",
    order: 0,
    anchorKind,
    anchorId,
    regionId: "s",
    rect: { x: -20, y: -30, width: 700, height: 500 },
    createdBy: "human",
    createdAt: 0,
  };
}

it.each(["node", "island"] as const)(
  "fits the current %s after section movement without trusting the stored rectangle",
  (kind) => {
    expect(projectViewTarget(view(kind, kind), sections, [], geometry)).toEqual({
      kind: "ready",
      rect: { x: 1050, y: 2070, width: 300, height: 180 },
    });
    const moved = [{ id: "s", x: -500, y: 600 }];
    expect(projectViewTarget(view(kind, kind), moved, [], geometry)).toEqual({
      kind: "ready",
      rect: { x: -450, y: 670, width: 300, height: 180 },
    });
  },
);

it("follows the chat's current section and card position with saved card-relative offsets", () => {
  const chats = [{ threadId: "chat", regionId: "other", x: 90, y: 160 }];
  const moved = [...sections, { id: "other", x: -2000, y: 4000 }];
  expect(projectViewTarget(view("chat", "chat"), moved, chats, geometry)).toEqual({
    kind: "ready",
    rect: { x: -1930, y: 4130, width: 700, height: 500 },
  });
  expect(
    projectViewTarget(
      view("chat", "chat"),
      [],
      [{ threadId: "chat", regionId: null, x: 90, y: 160 }],
      geometry,
    ),
  ).toEqual({ kind: "ready", rect: { x: 70, y: 130, width: 700, height: 500 } });
});

it("keeps section rectangles relative and free rectangles absolute", () => {
  expect(projectViewTarget(view("section", "s"), sections, [], geometry)).toEqual({
    kind: "ready",
    rect: { x: 980, y: 1970, width: 700, height: 500 },
  });
  expect(projectViewTarget(view("free"), sections, [], geometry)).toEqual({
    kind: "ready",
    rect: view("free").rect,
  });
});

it.each(["node", "island"] as const)(
  "waits for %s geometry, then reports a missing object instead of a stored fallback",
  (kind) => {
    expect(projectViewTarget(view(kind, kind), sections, [], new Map())).toEqual({
      kind: "loading",
      sectionId: "s",
    });
    expect(projectViewTarget(view(kind, "removed"), sections, [], geometry)).toMatchObject({
      kind: "missing",
    });
  },
);

it.each(["section", "node", "island", "chat"] as const)(
  "reports missing %s anchors visibly",
  (kind) => {
    expect(projectViewTarget(view(kind, kind), [], [], geometry)).toMatchObject({
      kind: "missing",
    });
  },
);

it("fits reflowed module bounds rather than the saved viewport dimensions", () => {
  const reflowed = new Map([
    [
      "s",
      {
        layer: {
          origin: { x: 1000, y: 2000 },
          layout: {
            nodes: new Map([["node", { x: 1400, y: 2600, width: 650, height: 440 }]]),
            islands: [],
          },
        },
      },
    ],
  ]);

  expect(projectViewTarget(view("node", "node"), sections, [], reflowed)).toEqual({
    kind: "ready",
    rect: { x: 1400, y: 2600, width: 650, height: 440 },
  });
});

it("does not treat a chat from a missing section as a free-space card", () => {
  expect(
    projectViewTarget(
      view("chat", "chat"),
      [],
      [{ threadId: "chat", regionId: "removed", x: 90, y: 160 }],
      geometry,
    ),
  ).toMatchObject({ kind: "missing" });
});

it("keeps an open chat card on screen when its anchor has panned away", () => {
  const size = { width: 1200, height: 900 };

  expect(openChatCardRect({ x: 1500, y: -300 }, size, 500)).toEqual({
    x: 752,
    y: 8,
    width: 440,
    height: 500,
  });
  expect(openChatCardRect({ x: 100, y: 2000 }, size, 500)).toMatchObject({ x: 100, y: 304 });
  expect(openChatCardRect({ x: 100, y: 120 }, size, 500)).toMatchObject({ x: 100, y: 120 });
});

it("draws a chat connector from the visible card edge to the changed module edge", () => {
  const card = { x: 752, y: 8, width: 440, height: 500 };

  expect(chatConnector(card, { x: 100, y: 600, width: 300, height: 120 })).toEqual({
    from: { x: 752, y: 508 },
    to: { x: 400, y: 600 },
  });
  expect(chatConnector(card, { x: 100, y: 100, width: 300, height: 120 })).toEqual({
    from: { x: 752, y: 220 },
    to: { x: 400, y: 220 },
  });
  expect(chatConnector(card, { x: 800, y: 100, width: 100, height: 100 })).toBeNull();
});

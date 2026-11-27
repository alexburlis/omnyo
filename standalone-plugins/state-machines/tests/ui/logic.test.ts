import { describe, expect, test } from "vitest";

import { attemptStatusSchema } from "../../src/contracts/events.js";
import { createEmptyDraft } from "../../src/definition/draft.js";
import { displayStepStatus, statusSummary } from "../../src/ui/data/projection.js";
import { QueryStore } from "../../src/ui/data/query.js";
import {
  addStateOperation,
  addTransitionOperation,
  applyOperation,
  createEditorState,
  deleteStatesOperation,
  reapply,
  renameStateIdOperation,
  undo,
  updateStateOperation,
} from "../../src/ui/graph/edit-model.js";
import { nodeRects } from "../../src/ui/graph/geometry.js";
import { edgeLabel } from "../../src/ui/graph/labels.js";
import { routeDiagnostics } from "../../src/ui/graph/route-check.js";
import {
  type EdgeInput,
  LABEL_MAX_WIDTH,
  labelWidth,
  type RoutedEdge,
  routeEdges,
} from "../../src/ui/graph/route.js";
import { nearestInDirection, outlineOrder } from "../../src/ui/graph/spatial-nav.js";
import {
  FIT_MAX_ZOOM,
  fitViewport,
  MAX_ZOOM,
  MIN_ZOOM,
  panelOcclusion,
  READABLE_ZOOM,
  readableViewport,
  revealRect,
  wheelZoomFactor,
  zoomAround,
} from "../../src/ui/graph/viewport.js";
import { formatRoute, parseRoute, type Route } from "../../src/ui/routes.js";
import { createReleaseLoopDraft } from "../../templates/index.js";

describe("panel routes", () => {
  const routes: Route[] = [
    { screen: "list" },
    { screen: "new" },
    { screen: "attention" },
    { screen: "machine", machineId: "mch_a1" },
    {
      screen: "instance",
      machineId: "mch_a1",
      instanceId: "ins_b2",
      view: "graph",
      selection: { kind: "state", id: "land-fix" },
    },
    { screen: "instance", machineId: "mch_a1", instanceId: "ins_b2", view: "log", selection: null },
    { screen: "draft", machineId: "mch_a1", selection: { kind: "transition", id: "tr_x9" } },
    { screen: "versions", machineId: "mch_a1" },
    {
      screen: "version",
      machineId: "mch_a1",
      versionId: "ver_3",
      compareWith: "ver_2",
      selection: null,
    },
    { screen: "settings", machineId: "mch_a1" },
  ];

  test.each(routes)("round-trips %o through the subPath", (route) => {
    expect(parseRoute(formatRoute(route))).toEqual(route);
  });

  test("accepts a host-encoded selection segment", () => {
    expect(parseRoute("m/mch_a1/draft/%40state%3Agate")).toEqual({
      screen: "draft",
      machineId: "mch_a1",
      selection: { kind: "state", id: "gate" },
    });
  });

  test("drops a stale or malformed selection instead of failing the route", () => {
    expect(parseRoute("m/mch_a1/draft/@state:bad id")).toEqual({
      screen: "draft",
      machineId: "mch_a1",
      selection: null,
    });
    expect(parseRoute("m/mch_a1/unknown")).toEqual({
      screen: "not-found",
      subPath: "m/mch_a1/unknown",
    });
  });
});

describe("instance status line", () => {
  test("omits a summary that only repeats the current state title", () => {
    expect(statusSummary("Installation verified", "Installation verified")).toBeNull();
    expect(statusSummary("Gate", " ")).toBeNull();
    expect(statusSummary("Land fix", "huppy/release-fix for 5c05d51")).toBe(
      "huppy/release-fix for 5c05d51",
    );
  });
});

describe("attempt status projection", () => {
  test.each(attemptStatusSchema.options)(
    "maps runtime status %s to exactly one display status",
    (status) => {
      const display = displayStepStatus({ status, nextRetryAt: null });

      expect(display.length).toBeGreaterThan(0);
    },
  );

  test("result-ready is shown as finishing, never as succeeded", () => {
    expect(displayStepStatus({ status: "result-ready", nextRetryAt: null })).toBe("finishing");
  });

  test("a pending attempt with a retry time is retry-wait, otherwise queued", () => {
    expect(displayStepStatus({ status: "pending", nextRetryAt: 5 })).toBe("retry-wait");
    expect(displayStepStatus({ status: "pending", nextRetryAt: null })).toBe("queued");
  });
});

describe("graph router", () => {
  const draft = createReleaseLoopDraft({ machineId: "mch_router" });

  const inputs = (overrides: Record<string, Partial<EdgeInput>> = {}): EdgeInput[] =>
    draft.transitions.flatMap((edge) =>
      edge.to === null
        ? []
        : [
            {
              id: edge.id,
              from: edge.from,
              to: edge.to,
              label: edgeLabel(edge, draft.layout.edgeLabels),
              sourceSide: null,
              targetSide: null,
              waypoints: [],
              labelAt: null,
              ...overrides[edge.id],
            },
          ],
    );

  const diagnose = (
    routed: readonly RoutedEdge[],
    edges: readonly EdgeInput[],
    rects: ReturnType<typeof nodeRects>,
  ) =>
    routeDiagnostics(
      routed.map((edge) => {
        const input = edges.find((candidate) => candidate.id === edge.id)!;

        return {
          id: edge.id,
          from: input.from,
          to: input.to,
          points: edge.points,
          labelBox: edge.labelBox,
        };
      }),
      rects,
    );

  const clean = {
    labelOverlaps: [],
    labelsOnNodes: [],
    labelsOnForeignEdges: [],
    pathsThroughNodes: [],
    coincidentRuns: [],
    sharedArrivals: [],
  };

  test("routes deterministically", () => {
    const rects = nodeRects(draft, false);

    expect(routeEdges(inputs(), rects)).toEqual(routeEdges(inputs(), rects));
  });

  test("the release loop has no label collisions, paths through states, shared runs or shared arrowheads", () => {
    for (const live of [false, true]) {
      const rects = nodeRects(draft, live);
      const edges = inputs();

      expect(diagnose(routeEdges(edges, rects), edges, rects)).toEqual(clean);
    }
  });

  test("keeps every transition with its own label; same-direction siblings share one line", () => {
    const rects = nodeRects(draft, false);
    const routed = routeEdges(inputs(), rects);

    const fixer = routed.filter(
      (edge) => edge.id.startsWith("tr_repair_") && edge.id !== "tr_repair_pr",
    );

    expect(routed).toHaveLength(inputs().length);
    expect(new Set(fixer.map((edge) => JSON.stringify(edge.points))).size).toBe(1);
    expect(new Set(fixer.map((edge) => edge.label.y)).size).toBe(fixer.length);
    expect(fixer.every((edge) => edge.bundleSize === fixer.length)).toBe(true);
  });

  test("opposite directions between the same states get separate lanes", () => {
    const routed = routeEdges(inputs(), nodeRects(draft, false));
    const down = routed.find((edge) => edge.id === "tr_promote")!;
    const up = routed.find((edge) => edge.id === "tr_promotion_verified")!;

    expect(JSON.stringify(down.points)).not.toBe(JSON.stringify(up.points));
    expect(Math.abs(down.points[0]!.x - up.points.at(-1)!.x)).toBeGreaterThanOrEqual(48);
  });

  test("produces orthogonal paths that leave and enter their states head-on", () => {
    const rects = nodeRects(draft, false);

    for (const routed of routeEdges(inputs(), rects)) {
      for (let index = 1; index < routed.points.length; index += 1) {
        const a = routed.points[index - 1]!;
        const b = routed.points[index]!;

        expect(a.x === b.x || a.y === b.y).toBe(true);
      }

      const end = routed.points.at(-1)!;
      const before = routed.points.at(-2)!;
      const target = rects.get(inputs().find((edge) => edge.id === routed.id)!.to)!;

      const onBorder =
        end.x === target.x ||
        end.x === target.x + target.width ||
        end.y === target.y ||
        end.y === target.y + target.height;

      expect(onBorder).toBe(true);
      expect(Math.abs(end.x - before.x) + Math.abs(end.y - before.y)).toBeGreaterThanOrEqual(8);
    }
  });

  test("respects saved waypoints, sides and label positions instead of bundling them", () => {
    const rects = nodeRects(draft, false);
    const waypoint = { x: 1200, y: 600 };

    const edges = inputs({
      tr_repair_budget: { waypoints: [waypoint], sourceSide: "right", targetSide: "right" },
      tr_gate_ok: { labelAt: 0.25 },
    });

    const routed = routeEdges(edges, rects);
    const manual = routed.find((edge) => edge.id === "tr_repair_budget")!;
    const sibling = routed.find((edge) => edge.id === "tr_repair_failed")!;
    const positioned = routed.find((edge) => edge.id === "tr_gate_ok")!;
    const gate = rects.get("gate")!;

    const passesThrough = manual.points.some((point, index) => {
      const next = manual.points[index + 1];

      if (next === undefined) return false;

      return (
        (point.x === waypoint.x &&
          next.x === waypoint.x &&
          Math.min(point.y, next.y) <= waypoint.y &&
          Math.max(point.y, next.y) >= waypoint.y) ||
        (point.y === waypoint.y &&
          next.y === waypoint.y &&
          Math.min(point.x, next.x) <= waypoint.x &&
          Math.max(point.x, next.x) >= waypoint.x)
      );
    });

    expect(passesThrough).toBe(true);
    expect(manual.points[0]!.x).toBe(rects.get("fixer-agent")!.x + rects.get("fixer-agent")!.width);
    expect(JSON.stringify(manual.points)).not.toBe(JSON.stringify(sibling.points));
    expect(manual.bundleSize).toBe(1);
    expect(positioned.label.x).toBeCloseTo(
      gate.x + gate.width + (positioned.points.at(-1)!.x - gate.x - gate.width) * 0.25,
      0,
    );
  });

  test("routes a self-transition as a loop beside its state and a long label clear of states", () => {
    const rects = new Map([
      ["a", { x: 0, y: 0, width: 224, height: 60 }],
      ["b", { x: 624, y: 0, width: 224, height: 60 }],
    ]);

    const long = "this label is deliberately much longer than the gap between the two states";

    const edges: EdgeInput[] = [
      {
        id: "self",
        from: "a",
        to: "a",
        label: "retry",
        sourceSide: null,
        targetSide: null,
        waypoints: [],
        labelAt: null,
      },
      {
        id: "long",
        from: "a",
        to: "b",
        label: long,
        sourceSide: null,
        targetSide: null,
        waypoints: [],
        labelAt: null,
      },
    ];

    const routed = routeEdges(edges, rects);
    const self = routed.find((edge) => edge.id === "self")!;

    expect(self.points.length).toBeGreaterThanOrEqual(4);
    expect(self.points[0]!.x).toBe(224);
    expect(diagnose(routed, edges, rects).labelsOnNodes).toEqual([]);
    expect(labelWidth(long)).toBe(LABEL_MAX_WIDTH);
  });
});

describe("spatial navigation and outline order", () => {
  const draft = createReleaseLoopDraft({ machineId: "mch_nav" });
  const rects = nodeRects(draft, false);

  test("every state is reachable by arrow keys from the initial state", () => {
    const seen = new Set<string>();
    const queue = [draft.initialStateId ?? ""];

    while (queue.length > 0) {
      const id = queue.shift()!;

      if (seen.has(id)) continue;

      seen.add(id);

      for (const direction of ["up", "down", "left", "right"] as const) {
        const next = nearestInDirection(id, direction, rects);

        if (next !== null) queue.push(next);
      }
    }

    expect([...seen].sort()).toEqual(draft.states.map((state) => state.id).sort());
  });

  test("outline order starts with the initial state and lists every state once", () => {
    const order = outlineOrder(
      draft.initialStateId,
      draft.states.map((state) => state.id),
      draft.transitions,
    );

    expect(order[0]).toBe(draft.initialStateId);
    expect(new Set(order).size).toBe(draft.states.length);
  });
});

describe("draft edit model", () => {
  const empty = createEmptyDraft({ machineId: "mch_edit", name: "Edit" });

  test("adding a first state makes it initial, and undo restores the previous draft", () => {
    let state = createEditorState(empty);

    state = applyOperation(
      state,
      addStateOperation("command", { x: 10, y: 10 }, () => undefined),
    );

    expect(state.draft.states).toHaveLength(1);
    expect(state.draft.initialStateId).toBe(state.draft.states[0]!.id);
    expect(state.draft.layout.nodes[state.draft.states[0]!.id]).toEqual({ x: 8, y: 8 });

    state = undo(state);

    expect(state.draft).toBe(empty);
  });

  test("renaming a state id rewrites transitions, layout and the initial state", () => {
    let state = createEditorState(empty);

    state = applyOperation(
      state,
      addStateOperation("wait", null, () => undefined),
    );
    state = applyOperation(
      state,
      addStateOperation("command", null, () => undefined),
    );

    const [first, second] = state.draft.states;

    state = applyOperation(
      state,
      addTransitionOperation(first!.id, second!.id, () => undefined),
    );
    state = applyOperation(state, renameStateIdOperation(first!.id, "waiting"));

    expect(state.draft.initialStateId).toBe("waiting");
    expect(state.draft.transitions[0]!.from).toBe("waiting");
    expect(state.draft.layout.nodes.waiting).toBeDefined();
  });

  test("reapply keeps edits whose targets still exist and reports the rest", () => {
    let mine = createEditorState(empty);

    mine = applyOperation(
      mine,
      addStateOperation("wait", null, () => undefined),
    );

    const id = mine.draft.states[0]!.id;
    const base = mine.draft;

    let local = createEditorState(base);

    local = applyOperation(
      local,
      updateStateOperation(id, "Rename state", (current) => ({ ...current, title: "Mine" })),
    );
    local = applyOperation(
      local,
      addStateOperation("end", null, () => undefined),
    );

    const theirs = applyOperation(createEditorState(base), deleteStatesOperation([id])).draft;
    const result = reapply(theirs, local.pending);

    expect(result.failed.map((operation) => operation.label)).toEqual(["Rename state"]);
    expect(result.applied.map((operation) => operation.label)).toEqual(["Add end"]);
    expect(result.draft.states.map((state) => state.kind)).toEqual(["end"]);
  });
});

describe("query store invalidation", () => {
  test("an invalidation during an in-flight fetch triggers exactly one fresh fetch after it settles", async () => {
    const store = new QueryStore();
    const resolvers: ((value: string) => void)[] = [];

    const fetcher = () =>
      new Promise<string>((resolve) => {
        resolvers.push(resolve);
      });

    const unsubscribe = store.subscribe("instance:ins_a", fetcher, () => undefined);

    expect(resolvers).toHaveLength(1);
    store.refetchAll();
    store.refetchAll();
    expect(resolvers).toHaveLength(1);
    resolvers[0]!("before-transition");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(resolvers).toHaveLength(2);
    resolvers[1]!("after-transition");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.snapshot("instance:ins_a").data).toBe("after-transition");
    expect(resolvers).toHaveLength(2);
    unsubscribe();
  });
});

describe("canvas wheel zoom", () => {
  const wheel = (deltaY: number, extra: Partial<Parameters<typeof wheelZoomFactor>[0]> = {}) =>
    wheelZoomFactor({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, ...extra });

  test("scrolling up zooms in, down zooms out, and sideways swipes do not zoom", () => {
    expect(wheel(-100)).toBeGreaterThan(1);
    expect(wheel(100)).toBeLessThan(1);
    expect(wheelZoomFactor({ deltaX: 120, deltaY: 4, deltaMode: 0, ctrlKey: false })).toBe(1);
  });

  test("line-mode mouse wheels match pixel-mode distance and pinches are more sensitive", () => {
    expect(wheel(-3, { deltaMode: 1 })).toBeCloseTo(wheel(-48), 6);
    expect(wheel(-10, { ctrlKey: true })).toBeGreaterThan(wheel(-10));
  });

  test("one event never jumps more than 2x", () => {
    expect(wheel(-100_000)).toBe(2);
    expect(wheel(100_000)).toBe(0.5);
  });

  test("zooming keeps the world point under the pointer fixed and clamps the range", () => {
    const before = { x: 40, y: -20, zoom: 0.8 };
    const pivot = { x: 300, y: 200 };
    const after = zoomAround(before, 1.5, pivot);

    const worldBefore = {
      x: (pivot.x - before.x) / before.zoom,
      y: (pivot.y - before.y) / before.zoom,
    };

    const worldAfter = { x: (pivot.x - after.x) / after.zoom, y: (pivot.y - after.y) / after.zoom };

    expect(after.zoom).toBeCloseTo(1.2, 6);
    expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
    expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
    expect(zoomAround(before, 100, pivot).zoom).toBe(MAX_ZOOM);
    expect(zoomAround(before, 0.001, pivot).zoom).toBe(MIN_ZOOM);
  });
});

describe("canvas initial zoom", () => {
  const releaseLoop = { x: 0, y: 0, width: 1024, height: 540 };

  test("a graph that fits opens at full fit, capped so small graphs are not blown up", () => {
    const wide = readableViewport(releaseLoop, { width: 1200, height: 900 }, 48);

    const tiny = readableViewport(
      { x: 0, y: 0, width: 200, height: 80 },
      { width: 1400, height: 900 },
      48,
    );

    expect(wide.zoom).toBeCloseTo((1200 - 96) / 1024, 6);
    expect(tiny.zoom).toBe(FIT_MAX_ZOOM);
  });

  test("a graph too big for the canvas opens at a readable zoom anchored at its start", () => {
    const size = { width: 694, height: 650 };
    const narrow = readableViewport(releaseLoop, size, 48);

    expect(fitViewport(releaseLoop, size, 48).zoom).toBeLessThan(READABLE_ZOOM);
    expect(narrow.zoom).toBe(READABLE_ZOOM);
    expect(narrow.x).toBe(48);
    expect(narrow.y).toBeCloseTo((650 - 540 * READABLE_ZOOM) / 2, 6);
  });
});

describe("canvas reveal beside the floating panel", () => {
  test("a state hidden under the panel is moved into the visible area; a visible one is left alone", () => {
    const size = { width: 1086, height: 678 };
    const area = { width: size.width - panelOcclusion(size.width), height: size.height };
    const viewport = { x: 0, y: 0, zoom: 1 };
    const hidden = { x: 900, y: 100, width: 224, height: 60 };
    const moved = revealRect(viewport, hidden, area);

    expect(moved.zoom).toBe(1);
    expect(moved.x + hidden.x + hidden.width).toBeLessThanOrEqual(area.width);
    expect(revealRect(viewport, { x: 40, y: 40, width: 224, height: 60 }, area)).toBe(viewport);
  });
});

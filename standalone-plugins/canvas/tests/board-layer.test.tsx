import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Board, CanvasNode, Composition } from "../contract";
import { sourceInputSchema, type SourceState } from "../source-contract";
import {
  BoardLayer,
  chooseMeasurements,
  measurementBudget,
  useBoardLayer,
} from "../components/board-layer";
import { measureKey } from "../lib/node-rendering";
import { flushRememberedHeights } from "../lib/measured-heights";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function sampleBoard(threadId: string): Board {
  return {
    threadId,
    revision: 1,
    seenRevision: 0,
    sections: ["Work"],
    nodes: [
      {
        id: "note",
        kind: "note",
        order: 0,
        section: "Work",
        title: "Note",
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
      },
    ],
    edges: [],
  };
}

it("translates measured board content without changing local placement or sizes", () => {
  const board = sampleBoard("translate");

  const { result, rerender } = renderHook(({ origin }) => useBoardLayer({ board, origin }), {
    initialProps: { origin: { x: 0, y: 0 } },
  });

  act(() => result.current.measure("note", 333, ""));
  const local = result.current.layout;
  const localNode = local.nodes.get("note");

  expect(localNode?.height).toBe(333);
  rerender({ origin: { x: 2400, y: -1200 } });
  expect(result.current.layout.nodes.get("note")).toEqual({
    ...localNode,
    x: (localNode?.x ?? 0) + 2400,
    y: (localNode?.y ?? 0) - 1200,
  });
  expect(result.current.layout.bounds).toEqual({
    ...local.bounds,
    x: local.bounds.x + 2400,
    y: local.bounds.y - 1200,
  });
  expect(result.current.layout.sections[0]?.rect.x).toBe((local.sections[0]?.rect.x ?? 0) + 2400);
  rerender({ origin: { x: 0, y: 0 } });
  expect(result.current.layout.nodes.get("note")).toEqual(localNode);
});

type Watch = { target: Element; observer: ResizeObserver; callback: ResizeObserverCallback };

function stubCapturingObserver() {
  const watches: Watch[] = [];

  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element) {
        watches.push({ target, observer: this, callback: this.callback });
      }
      unobserve() {}
      disconnect() {}
    },
  );

  return {
    report(target: Element, blockSize: number) {
      const entry: ResizeObserverEntry = {
        target,
        contentRect: new DOMRect(),
        borderBoxSize: [{ blockSize, inlineSize: 0 }],
        contentBoxSize: [{ blockSize, inlineSize: 0 }],
        devicePixelContentBoxSize: [{ blockSize, inlineSize: 0 }],
      };

      for (const watch of watches)
        if (watch.target === target) watch.callback([entry], watch.observer);
    },
    reportAll(blockSize: number) {
      for (const watch of watches) this.report(watch.target, blockSize);
    },
  };
}

function Harness({
  board,
  mounted = true,
  sourcesLoaded = true,
  onLayer,
}: {
  board: Board;
  mounted?: boolean;
  sourcesLoaded?: boolean;
  onLayer(layer: ReturnType<typeof useBoardLayer>): void;
}) {
  const layer = useBoardLayer({ board });

  onLayer(layer);

  return mounted ? (
    <BoardLayer
      board={board}
      baseline={0}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      sourcesLoaded={sourcesLoaded}
      layer={layer}
      zoom={1}
      onSelect={() => {}}
      onNodePointerDown={() => {}}
      onIslandPointerDown={() => {}}
    />
  ) : null;
}

it("keeps a module's measured height when its detached card reports zero", () => {
  const observer = stubCapturingObserver();
  const board = sampleBoard("detached-zero");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [{ ...note, id: "module" }];
  let latest: ReturnType<typeof useBoardLayer> | undefined;

  const view = render(
    <Harness
      board={board}
      onLayer={(layer) => {
        latest = layer;
      }}
    />,
  );

  const card = view.container.querySelector('[data-node-id="module"]');

  if (!card) throw new Error("Missing live card");
  act(() => observer.report(card, 333));
  expect(latest?.layout.nodes.get("module")?.height).toBe(333);
  view.rerender(
    <Harness
      board={board}
      mounted={false}
      onLayer={(layer) => {
        latest = layer;
      }}
    />,
  );
  expect(card.isConnected).toBe(false);
  act(() => observer.report(card, 0));

  expect(latest?.layout.nodes.get("module")?.height).toBe(333);
});

it("keeps an island header's measured height when the layer unmounts and the detached header reports zero", () => {
  const observer = stubCapturingObserver();
  const board = sampleBoard("island-header");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [{ ...note, id: "clicks" }];

  const composition: Composition = {
    width: 1200,
    root: {
      flow: "column",
      children: [
        {
          id: "discovery",
          flow: "column",
          island: { title: "Discovery", accent: "blue" },
          children: [{ node: "clicks" }],
        },
      ],
    },
  };

  board.composition = composition;
  let latest: ReturnType<typeof useBoardLayer> | undefined;

  const onLayer = (layer: ReturnType<typeof useBoardLayer>) => {
    latest = layer;
  };

  const view = render(<Harness board={board} onLayer={onLayer} />);
  const head = view.container.querySelector(".cnv-island-head");

  if (!head) throw new Error("Missing island header");
  const estimated = latest?.layout.nodes.get("clicks")?.y ?? 0;

  act(() => observer.report(head, estimated + 120));
  const measured = latest?.layout.nodes.get("clicks")?.y;

  expect(measured).not.toBe(estimated);
  view.rerender(<Harness board={board} mounted={false} onLayer={onLayer} />);
  expect(head.isConnected).toBe(false);
  act(() => observer.reportAll(0));
  expect(latest?.layout.nodes.get("clicks")?.y).toBe(measured);
});

it("measures only as many framed modules at a time as the frame budget allows", () => {
  stubCapturingObserver();
  stubOffscreenIntersections();
  const board = sampleBoard("framed-measure");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = Array.from({ length: measurementBudget.frames + 2 }, (_, index) => ({
    ...note,
    id: `frame-${index}`,
    kind: "html" as const,
    html: `<p>Frame ${index}</p>`,
  }));

  const view = render(<Harness board={board} onLayer={() => {}} />);

  expect(view.container.querySelectorAll("[data-measuring]")).toHaveLength(
    measurementBudget.frames,
  );
  expect(view.container.querySelectorAll("[data-measuring] iframe")).toHaveLength(
    measurementBudget.frames,
  );
});

it("restores remembered heights after the layer remounts and after a reload", () => {
  const observer = stubCapturingObserver();
  const board = sampleBoard("remembered");
  let latest: ReturnType<typeof useBoardLayer> | undefined;

  const onLayer = (layer: ReturnType<typeof useBoardLayer>) => {
    latest = layer;
  };

  const first = render(<Harness board={board} onLayer={onLayer} />);
  const card = first.container.querySelector('[data-node-id="note"]');

  if (!card) throw new Error("Missing live card");
  act(() => observer.report(card, 333));
  first.unmount();

  render(<Harness board={board} onLayer={onLayer} />);
  expect(latest?.layout.nodes.get("note")?.height).toBe(333);

  flushRememberedHeights();
  const saved = JSON.parse(localStorage.getItem("canvas.heights.v1.remembered") ?? "{}");

  expect(saved.note?.[0]).toBe(333);
  cleanup();

  localStorage.setItem(
    "canvas.heights.v1.reloaded",
    JSON.stringify({ note: [444, "an earlier revision"] }),
  );

  render(<Harness board={sampleBoard("reloaded")} onLayer={onLayer} />);

  expect(latest?.layout.nodes.get("note")?.height).toBe(444);
});

it("keys a module's measurement by its data, and waits only while the source list loads", () => {
  const note = sampleBoard("keys").nodes[0];

  if (!note) throw new Error("Missing module fixture");

  const node: CanvasNode = {
    ...note,
    kind: "html",
    binding: { sourceId: "clicks", view: "html", sources: ["pages"] },
  };

  const dataset = (sourceId: string, revision: number): SourceState => ({
    source: {
      definition: sourceInputSchema.parse({
        id: sourceId,
        title: sourceId,
        provider: "json",
        config: {
          url: "https://api.example.com",
          columns: [{ key: "clicks", label: "Clicks", type: "number" }],
        },
      }),
      status: "ready",
      error: null,
      lastAttemptAt: 100,
      lastSuccessAt: 100,
      nextRefreshAt: null,
      failures: 0,
    },
    dataset: {
      sourceId,
      columns: [],
      rows: [],
      revision,
      capturedAt: 100,
      provenance: { timezone: "UTC", windowLabel: "today", cohort: "visits" },
    },
  });

  expect(measureKey(node, 300, undefined, undefined, null)).toBeNull();
  expect(measureKey(node, 300, undefined, undefined, [dataset("clicks", 1)])).toContain("none");

  const loaded = measureKey(node, 300, "lead", "search", [
    dataset("clicks", 1),
    dataset("pages", 4),
  ]);

  expect(loaded).not.toBeNull();
  expect(
    measureKey(node, 300, "lead", "search", [dataset("clicks", 2), dataset("pages", 4)]),
  ).not.toBe(loaded);
  expect(
    measureKey(node, 300.4, "lead", "search", [dataset("clicks", 1), dataset("pages", 4)]),
  ).toBe(loaded);
});

it("measures an unloaded heavy thread-board module in a hidden copy, leaving light cards alone", () => {
  stubCapturingObserver();
  stubOffscreenIntersections();
  const board = sampleBoard("world-measure");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [
    note,
    { ...note, id: "chart", title: "Chart", kind: "html", html: "<p>Chart</p>" },
  ];

  const view = render(<Harness board={board} onLayer={() => {}} />);
  const copies = view.container.querySelectorAll("[data-measuring]");

  expect(copies).toHaveLength(1);
  expect(copies[0]?.getAttribute("aria-label")).toBe("Visual: Chart");
  expect(view.container.querySelectorAll('[data-node-id="chart"]')).toHaveLength(1);
  expect(view.container.querySelectorAll('[data-node-id="note"]')).toHaveLength(1);
});

it("caps measurements by frame count, so a module with three views costs three frames", () => {
  const candidates = [
    { id: "views", cost: 3 },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `frame-${index}`, cost: 1 })),
    ...Array.from({ length: 20 }, (_, index) => ({ id: `table-${index}`, cost: 0 })),
  ];

  const chosen = chooseMeasurements(candidates);
  const frames = chosen.reduce((sum, candidate) => sum + candidate.cost, 0);

  expect(chosen).toHaveLength(measurementBudget.total);
  expect(frames).toBe(measurementBudget.frames);
  expect(chosen[0]?.id).toBe("views");
});

it("measures a live bound data module that has not rendered yet in a hidden copy", () => {
  stubCapturingObserver();
  stubOffscreenIntersections();
  const board = sampleBoard("live-bound-unloaded");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [
    {
      ...note,
      id: "table",
      title: "Table",
      kind: "html",
      html: null,
      binding: { sourceId: "pages", view: "table" },
    },
  ];

  const view = render(<Harness board={board} onLayer={() => {}} />);

  expect(
    view.container.querySelector('[data-node-id="table"]')?.hasAttribute("data-content-deferred"),
  ).toBe(true);
  expect(view.container.querySelectorAll("[data-measuring]")).toHaveLength(1);
});

it("charges a bound data module's authored view frames against the measurement budget", () => {
  stubCapturingObserver();
  stubOffscreenIntersections();
  const board = sampleBoard("bound-views");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = Array.from({ length: measurementBudget.frames + 2 }, (_, index) => ({
    ...note,
    id: `table-${index}`,
    title: `Table ${index}`,
    kind: "html" as const,
    html: null,
    binding: { sourceId: "pages", view: "table" as const },
    views: { sources: "<p>Definitions</p>" },
  }));

  const view = render(<Harness board={board} onLayer={() => {}} />);

  expect(view.container.querySelectorAll("[data-measuring]")).toHaveLength(
    measurementBudget.frames,
  );
});

it("waits for a section's source list before measuring its bound modules", () => {
  stubCapturingObserver();
  stubOffscreenIntersections();
  const board = sampleBoard("bound-loading");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [
    {
      ...note,
      id: "table",
      kind: "html",
      html: null,
      binding: { sourceId: "pages", view: "table" },
    },
  ];

  const loading = render(<Harness board={board} sourcesLoaded={false} onLayer={() => {}} />);

  expect(loading.container.querySelector("[data-measuring]")).toBeNull();
  loading.unmount();

  const loaded = render(<Harness board={board} onLayer={() => {}} />);

  expect(loaded.container.querySelector("[data-measuring]")).not.toBeNull();
});

it("measures a live module again after its card remounts unloaded, even if it loaded before", () => {
  stubCapturingObserver();
  const intersections = { now: true };

  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];

      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              isIntersecting: intersections.now,
              intersectionRatio: intersections.now ? 1 : 0,
              boundingClientRect: new DOMRect(),
              intersectionRect: new DOMRect(),
              rootBounds: null,
              time: 0,
            },
          ],
          this,
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );

  const board = sampleBoard("remount-unloaded");
  const note = board.nodes[0];

  if (!note) throw new Error("Missing module fixture");
  board.nodes = [{ ...note, id: "chart", title: "Chart", kind: "html", html: "<p>Chart</p>" }];

  const view = render(<Harness board={board} onLayer={() => {}} />);

  expect(view.container.querySelector("[data-measuring]")).toBeNull();
  intersections.now = false;
  view.rerender(<Harness board={board} mounted={false} onLayer={() => {}} />);
  view.rerender(<Harness board={board} onLayer={() => {}} />);

  expect(
    view.container.querySelector('[data-node-id="chart"]')?.hasAttribute("data-content-deferred"),
  ).toBe(true);
  expect(view.container.querySelectorAll("[data-measuring]")).toHaveLength(1);
});

function stubOffscreenIntersections() {
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      readonly root = null;
      readonly rootMargin = "";
      readonly thresholds = [];

      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [
            {
              target,
              isIntersecting: false,
              intersectionRatio: 0,
              boundingClientRect: new DOMRect(),
              intersectionRect: new DOMRect(),
              rootBounds: null,
              time: 0,
            },
          ],
          this,
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
}

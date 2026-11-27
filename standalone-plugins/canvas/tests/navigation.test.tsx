import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Board, CanvasNode } from "../contract";
import { BoardCanvas, type BoardCommands } from "../components/board";
import { NodeCard } from "../components/node";
import { minZoom } from "../lib/layout";

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

function setup(visual = false, onCreatePrompt = vi.fn()) {
  let commands: BoardCommands | null = null;

  const board: Board = {
    threadId: "navigation",
    revision: 1,
    seenRevision: 1,
    sections: ["Work"],
    nodes: [
      visual ? { ...node("one"), kind: "html", html: "<p>Chart</p>" } : node("one"),
      node("two"),
    ],
    edges: [],
    composition: {
      width: 800,
      root: { flow: "column", gap: 0, children: [{ node: "one" }, { node: "two" }] },
    },
  };

  const element = (value: Board) => (
    <BoardCanvas
      board={value}
      baseline={1}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      onSelect={() => {}}
      onMove={() => {}}
      onCommands={(value) => {
        commands = value;
      }}
      onCreatePrompt={onCreatePrompt}
    />
  );

  const rendered = render(element(board));
  const { container } = rendered;

  const surface = container.querySelector<HTMLElement>(".cnv-board");
  const world = container.querySelector<HTMLElement>(".cnv-world");
  const minimap = container.querySelector<HTMLElement>(".cnv-minimap");

  if (!surface || !world || !minimap) throw new Error("Missing navigation elements");
  let size = { width: 800, height: 600 };
  vi.spyOn(surface, "getBoundingClientRect").mockImplementation(
    () => new DOMRect(100, 50, size.width, size.height),
  );
  Object.defineProperties(surface, {
    clientWidth: { get: () => size.width },
    clientHeight: { get: () => size.height },
  });
  act(() => observed.get(surface)?.());
  vi.spyOn(minimap, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 160, 100));

  return {
    container,
    board,
    renderBoard(value: Board) {
      rendered.rerender(element(value));
    },
    commands() {
      if (commands === null) throw new Error("Commands not ready");

      return commands;
    },
    surface,
    world,
    minimap,
    resize(width: number, height: number) {
      size = { width, height };
      act(() => observed.get(surface)?.());
    },
  };
}

function viewport(world: HTMLElement) {
  const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)$/.exec(
    world.style.transform,
  );

  if (match === null) throw new Error("Missing viewport transform");

  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

function worldAt(world: HTMLElement, x: number, y: number) {
  const view = viewport(world);

  return { x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom };
}

it.each([
  { deltaMode: 0, deltaY: 80, metaKey: true },
  { deltaMode: 1, deltaY: 3, metaKey: true },
  { deltaMode: 2, deltaY: 0.08, metaKey: true },
  { deltaMode: 0, deltaY: 12, ctrlKey: true },
])("returns to the same view through repeated wheel zoom cycles: %j", (input) => {
  const { surface, world } = setup();
  const initial = viewport(world);
  const point = worldAt(world, 130, 90);

  for (let cycle = 0; cycle < 12; cycle += 1) {
    for (const direction of [1, -1, -1, 1]) {
      fireEvent.wheel(surface, {
        ...input,
        deltaY: input.deltaY * direction,
        clientX: 230,
        clientY: 140,
      });
      expect(worldAt(world, 130, 90).x).toBeCloseTo(point.x, 8);
      expect(worldAt(world, 130, 90).y).toBeCloseTo(point.y, 8);
    }

    expect(viewport(world)).toEqual({
      zoom: expect.closeTo(initial.zoom, 8),
      x: expect.closeTo(initial.x, 8),
      y: expect.closeTo(initial.y, 8),
    });
  }
});

it("pans with two-finger scroll on both axes without zooming", () => {
  const { surface, world } = setup();
  const start = viewport(world);

  fireEvent.wheel(surface, { deltaX: 30, deltaY: 50, clientX: 130, clientY: 80 });
  expect(viewport(world)).toEqual({
    zoom: start.zoom,
    x: expect.closeTo(start.x - 30),
    y: expect.closeTo(start.y - 50),
  });

  fireEvent.wheel(surface, { deltaY: 3, deltaMode: 1, shiftKey: true });
  expect(viewport(world)).toEqual({
    zoom: start.zoom,
    x: expect.closeTo(start.x - 78),
    y: expect.closeTo(start.y - 50),
  });
});

it("keeps wheel zoom-out under the pointer, including after resize", () => {
  const { surface, world, resize } = setup();
  const pointer = worldAt(world, 30, 30);
  fireEvent.wheel(surface, { deltaY: 100, ctrlKey: true, clientX: 130, clientY: 80 });
  expect(worldAt(world, 30, 30).x).toBeCloseTo(pointer.x);
  expect(worldAt(world, 30, 30).y).toBeCloseTo(pointer.y);

  resize(1000, 800);
  const resizedPointer = worldAt(world, 800, 700);
  fireEvent.wheel(surface, { deltaY: 100, ctrlKey: true, clientX: 900, clientY: 750 });
  expect(worldAt(world, 800, 700).x).toBeCloseTo(resizedPointer.x);
  expect(worldAt(world, 800, 700).y).toBeCloseTo(resizedPointer.y);

  for (let i = 0; i < 10; i += 1)
    fireEvent.wheel(surface, { deltaY: 1000, ctrlKey: true, clientX: 130, clientY: 80 });
  const clamped = viewport(world);
  expect(clamped.zoom).toBe(minZoom);
  fireEvent.wheel(surface, { deltaY: 1000, ctrlKey: true, clientX: 900, clientY: 750 });
  expect(viewport(world)).toEqual({
    zoom: clamped.zoom,
    x: expect.closeTo(clamped.x),
    y: expect.closeTo(clamped.y),
  });
});

it("keeps wheel zoom-in under the pointer", () => {
  const { surface, world } = setup();
  const pointer = worldAt(world, 30, 30);
  fireEvent.wheel(surface, { deltaY: -100, metaKey: true, clientX: 130, clientY: 80 });
  expect(worldAt(world, 30, 30).x).toBeCloseTo(pointer.x);
  expect(worldAt(world, 30, 30).y).toBeCloseTo(pointer.y);

  for (let i = 0; i < 10; i += 1)
    fireEvent.wheel(surface, { deltaY: -1000, metaKey: true, clientX: 130, clientY: 80 });
  const clamped = viewport(world);
  expect(clamped.zoom).toBe(2.5);
  fireEvent.wheel(surface, { deltaY: -1000, metaKey: true, clientX: 900, clientY: 750 });
  expect(viewport(world)).toEqual({
    zoom: clamped.zoom,
    x: expect.closeTo(clamped.x),
    y: expect.closeTo(clamped.y),
  });
});

it("centers the minimap content with a ten-pixel inset and maps clicks back to the same node", () => {
  const { container, minimap, world } = setup();
  const glyphs = Array.from(container.querySelectorAll<HTMLElement>(".cnv-minimap-node"));

  const rects = glyphs.map((glyph) => ({
    x: parseFloat(glyph.style.left),
    y: parseFloat(glyph.style.top),
    width: parseFloat(glyph.style.width),
    height: parseFloat(glyph.style.height),
  }));

  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(10);
    expect(rect.y).toBeGreaterThanOrEqual(10);
    expect(rect.x + rect.width).toBeLessThanOrEqual(150);
    expect(rect.y + rect.height).toBeLessThanOrEqual(90);
  }

  const left = Math.min(...rects.map((rect) => rect.x));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const top = Math.min(...rects.map((rect) => rect.y));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  expect((left + right) / 2).toBeCloseTo(80);
  expect((top + bottom) / 2).toBeCloseTo(50);

  const second = rects[1];

  if (!second) throw new Error("Missing second glyph");
  fireEvent.pointerDown(minimap, {
    pointerId: 1,
    button: 0,
    clientX: 100 + second.x + second.width / 2,
    clientY: 50 + second.y + second.height / 2,
  });
  expect(worldAt(world, 400, 300).x).toBeCloseTo(400);
  expect(worldAt(world, 400, 300).y).toBeCloseTo(225);

  fireEvent.pointerDown(minimap, { pointerId: 2, button: 0, clientX: 100, clientY: 50 });
  expect(worldAt(world, 400, 300)).toEqual({ x: 0, y: 0 });
});

function wheelData(overrides = {}) {
  return {
    canvasFrameWheel: {
      deltaX: 0,
      deltaY: -100,
      deltaMode: 0,
      clientX: 100,
      clientY: 80,
      pointerRevision: 0,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      ...overrides,
    },
  };
}

it("keeps relayed zoom fixed when iframe coordinates lag behind its transform", () => {
  const { container, surface, world } = setup(true);
  const frame = container.querySelector<HTMLIFrameElement>(".cnv-frame");

  if (!frame || !frame.contentWindow) throw new Error("Missing visual frame");
  const source = frame.contentWindow;
  Object.defineProperties(frame, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  const bounds = vi.spyOn(frame, "getBoundingClientRect");
  bounds.mockReturnValue(new DOMRect(200, 150, 200, 100));
  const start = viewport(world);
  const pointer = worldAt(world, 150, 140);
  const receive = vi.fn();
  surface.addEventListener("wheel", receive);

  for (let cycle = 0; cycle < 12; cycle += 1) {
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { source, data: wheelData({ deltaY: 80 }) }),
      ),
    );
    bounds.mockReturnValue(new DOMRect(180, 140, 160, 80));
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", { source, data: wheelData({ deltaY: -80 }) }),
      ),
    );
    bounds.mockReturnValue(new DOMRect(200, 150, 200, 100));
    expect(viewport(world)).toEqual({
      zoom: expect.closeTo(start.zoom),
      x: expect.closeTo(start.x),
      y: expect.closeTo(start.y),
    });
    expect(worldAt(world, 150, 140).x).toBeCloseTo(pointer.x);
    expect(worldAt(world, 150, 140).y).toBeCloseTo(pointer.y);
  }

  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: wheelData({ pointerRevision: 1, clientX: 140, clientY: 100 }),
      }),
    ),
  );
  expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({ clientX: 270, clientY: 200 });
  vi.stubGlobal("screenX", 50);
  bounds.mockReturnValue(new DOMRect(180, 140, 160, 80));
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { source, data: wheelData({ pointerRevision: 1 }) }),
    ),
  );
  expect(receive.mock.calls.at(-1)?.[0]).toMatchObject({ clientX: 220, clientY: 172 });
});

it("relays only its own valid visual wheel events with scaled parent coordinates", () => {
  const { container, surface, world } = setup(true);
  const frame = container.querySelector<HTMLIFrameElement>(".cnv-frame");

  if (!frame || !frame.contentWindow) throw new Error("Missing visual frame");
  const source = frame.contentWindow;
  Object.defineProperties(frame, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 150, 200, 100));
  const pointer = worldAt(world, 150, 140);
  const receive = vi.fn();
  surface.addEventListener("wheel", receive);
  act(() => window.dispatchEvent(new MessageEvent("message", { source, data: wheelData() })));
  expect(worldAt(world, 150, 140).x).toBeCloseTo(pointer.x);
  expect(worldAt(world, 150, 140).y).toBeCloseTo(pointer.y);
  expect(receive).toHaveBeenCalledOnce();
  const event = receive.mock.calls[0]?.[0];
  expect(event).toBeInstanceOf(WheelEvent);
  expect(event).toMatchObject({ clientX: 250, clientY: 190, deltaY: -100 });

  const unchanged = viewport(world);
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { source: window, data: wheelData() }));
    window.dispatchEvent(new MessageEvent("message", { source, data: wheelData({ deltaY: NaN }) }));
    window.dispatchEvent(
      new MessageEvent("message", { source, data: wheelData({ clientX: Infinity }) }),
    );
    window.dispatchEvent(
      new MessageEvent("message", { source, data: wheelData({ deltaMode: 3 }) }),
    );
    window.dispatchEvent(new MessageEvent("message", { source, data: { canvasFrameWheel: null } }));
  });
  expect(viewport(world)).toEqual(unchanged);
  expect(receive).toHaveBeenCalledOnce();

  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source,
        data: wheelData({ ctrlKey: false, deltaX: 20, deltaY: 40 }),
      }),
    ),
  );
  expect(viewport(world)).toEqual({
    zoom: unchanged.zoom,
    x: expect.closeTo(unchanged.x - 20),
    y: expect.closeTo(unchanged.y - 40),
  });
});

it("leaves visual wheel events local outside BoardCanvas", () => {
  const { container } = render(
    <NodeCard
      node={{ ...node("local"), kind: "html", html: "<p>Local content</p>" }}
      change={null}
      selected={false}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      onSelect={() => {}}
    />,
  );

  const frame = container.querySelector<HTMLIFrameElement>(".cnv-frame");

  if (!frame || !frame.contentWindow) throw new Error("Missing local frame");
  Object.defineProperties(frame, { clientWidth: { value: 400 }, clientHeight: { value: 200 } });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(200, 150, 200, 100));
  const receive = vi.fn();
  frame.addEventListener("wheel", receive);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", { source: frame.contentWindow, data: wheelData() }),
    ),
  );
  expect(receive).not.toHaveBeenCalled();
  expect(frame.srcdoc).not.toContain("canvasFrameWheel");
});

it("focuses changed targets with animation and places prompts in canvas coordinates", () => {
  const createPrompt = vi.fn();
  const view = setup(false, createPrompt);
  const before = viewport(view.world);
  act(() => view.commands().focus(["node:two"]));
  expect(view.world.dataset.animate).toBe("true");
  expect(viewport(view.world)).not.toEqual(before);
  const point = worldAt(view.world, 80, 90);
  fireEvent.doubleClick(view.surface, { clientX: 180, clientY: 140 });
  expect(createPrompt).toHaveBeenCalledWith({
    x: expect.closeTo(point.x),
    y: expect.closeTo(point.y),
  });
  createPrompt.mockClear();
  const node = view.container.querySelector('[data-node-id="one"]');

  if (node === null) throw new Error("Missing node");
  fireEvent.doubleClick(node);
  expect(createPrompt).not.toHaveBeenCalled();
});

it("keeps the location of a removed item available for undo navigation", () => {
  const view = setup();
  act(() => view.commands().focus(["node:two"]));
  const focused = viewport(view.world);
  view.renderBoard({ ...view.board, nodes: view.board.nodes.filter((node) => node.id !== "two") });
  act(() => view.commands().fit());
  expect(viewport(view.world)).not.toEqual(focused);
  act(() => view.commands().focus(["node:two"]));
  expect(viewport(view.world)).toEqual(focused);
  view.renderBoard(view.board);
  act(() => view.commands().focus(["node:two"]));
  expect(viewport(view.world)).toEqual(focused);
});

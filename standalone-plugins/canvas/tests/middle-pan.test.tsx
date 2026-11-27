import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Board, CanvasNode } from "../contract";
import { BoardCanvas } from "../components/board";

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
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup() {
  const node: CanvasNode = {
    id: "code",
    kind: "code",
    order: 1,
    section: "Work",
    title: "Code example",
    body: "const value = 1",
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: "typescript",
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

  const board: Board = {
    threadId: "thread",
    revision: 1,
    seenRevision: 0,
    sections: ["Work"],
    nodes: [node],
    edges: [],
  };

  const onSelect = vi.fn();
  const onMove = vi.fn();

  const { container } = render(
    <BoardCanvas
      board={board}
      baseline={0}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected="code"
      onSelect={onSelect}
      onMove={onMove}
      onCommands={() => {}}
    />,
  );

  const surface = container.querySelector<HTMLElement>(".cnv-board");
  const world = container.querySelector<HTMLElement>(".cnv-world");

  if (!surface || !world) throw new Error("Missing board");
  surface.setPointerCapture = vi.fn();

  return { container, surface, world, onSelect, onMove };
}

function point(clientX: number, clientY: number, button = 1) {
  return {
    pointerId: 7,
    pointerType: "mouse",
    clientX,
    clientY,
    button,
    buttons: button === 1 ? 4 : 2,
  };
}

function viewport(world: HTMLElement) {
  const match = /^translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)$/.exec(
    world.style.transform,
  );

  if (match === null) throw new Error("Missing viewport transform");

  return { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) };
}

it.each([".cnv-board", ".cnv-node-head", ".cnv-code"])(
  "pans with the middle button from %s without moving or selecting a node",
  (selector) => {
    const { container, surface, world, onSelect, onMove } = setup();
    const target = container.querySelector<HTMLElement>(selector);

    if (target === null) throw new Error("Missing drag target");
    const initial = viewport(world);
    const allowedDefault = fireEvent.pointerDown(target, point(100, 120));

    fireEvent.pointerMove(surface, point(165, 160));
    expect(viewport(world)).toEqual({ ...initial, x: initial.x + 65, y: initial.y + 40 });
    expect(allowedDefault).toBe(false);
    expect(surface.setPointerCapture).toHaveBeenCalledWith(7);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();

    fireEvent.pointerUp(surface, { ...point(165, 160), buttons: 0 });
    const released = world.style.transform;

    fireEvent.pointerMove(surface, point(220, 210));
    expect(world.style.transform).toBe(released);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  },
);

it.each([".cnv-board", ".cnv-node-head", ".cnv-code"])(
  "does not pan or move a node with a right-button drag from %s",
  (selector) => {
    const { container, surface, world, onMove } = setup();
    const target = container.querySelector<HTMLElement>(selector);

    if (target === null) throw new Error("Missing drag target");
    const initial = world.style.transform;

    fireEvent.pointerDown(target, point(100, 120, 2));
    fireEvent.pointerMove(surface, point(165, 160, 2));
    fireEvent.pointerUp(surface, { ...point(165, 160, 2), buttons: 0 });
    expect(world.style.transform).toBe(initial);
    expect(onMove).not.toHaveBeenCalled();
  },
);

it.each(["pointercancel", "lostpointercapture"])("stops middle-button panning after %s", (type) => {
  const { surface, world, onMove } = setup();
  const initial = viewport(world);

  fireEvent.pointerDown(surface, point(100, 120));
  fireEvent.pointerMove(surface, point(165, 160));
  expect(viewport(world)).toEqual({ ...initial, x: initial.x + 65, y: initial.y + 40 });
  fireEvent(surface, new PointerEvent(type, { ...point(165, 160), bubbles: true }));
  const stopped = world.style.transform;

  fireEvent.pointerMove(surface, point(220, 210));
  expect(world.style.transform).toBe(stopped);
  expect(onMove).not.toHaveBeenCalled();
});

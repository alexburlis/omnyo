import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { CanvasNode, Board } from "../contract";
import { BoardCanvas } from "../components/board";

function node(id: string, overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    kind: "note",
    order: 1,
    section: "Investigate",
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("pinches from nodes without moving them, then continues one-finger pan", () => {
  class Pointer extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "touch";
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
  const onMove = vi.fn();

  const board: Board = {
    threadId: "t",
    revision: 1,
    seenRevision: 0,
    sections: ["Investigate"],
    nodes: [node("one")],
    edges: [],
  };

  const { container } = render(
    <BoardCanvas
      board={board}
      baseline={0}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      onSelect={() => {}}
      onMove={onMove}
      onCommands={() => {}}
    />,
  );

  const surface = container.querySelector<HTMLElement>(".cnv-board");
  const head = container.querySelector<HTMLElement>(".cnv-node-head");
  const world = container.querySelector<HTMLElement>(".cnv-world");

  if (!surface || !head || !world) throw new Error("Missing board");
  surface.setPointerCapture = vi.fn();

  const point = (pointerId: number, clientX: number, clientY: number) => ({
    pointerId,
    pointerType: "touch",
    clientX,
    clientY,
    button: 0,
  });

  fireEvent.pointerDown(head, point(1, 100, 100));
  fireEvent.pointerMove(surface, point(1, 110, 100));
  fireEvent.pointerDown(head, point(2, 200, 100));
  fireEvent.pointerMove(surface, point(2, 290, 100));
  expect(world.style.transform).toContain("scale(1.6)");
  const zoomed = world.style.transform;
  fireEvent.pointerUp(surface, point(2, 290, 100));
  fireEvent.pointerMove(surface, point(1, 150, 130));
  expect(world.style.transform).not.toBe(zoomed);
  expect(world.style.transform).toContain("scale(1.6)");
  fireEvent.pointerUp(surface, point(1, 150, 130));
  expect(onMove).not.toHaveBeenCalled();
  fireEvent.pointerDown(surface, point(3, 100, 100));
  fireEvent.pointerDown(surface, point(4, 200, 100));
  fireEvent.pointerMove(surface, point(4, 2000, 100));
  expect(world.style.transform).toContain("scale(2.5)");
  fireEvent.pointerCancel(surface, point(4, 2000, 100));
  fireEvent.pointerCancel(surface, point(3, 100, 100));
  expect(onMove).not.toHaveBeenCalled();
  const link = document.createElement("a");
  const image = document.createElement("img");
  link.href = "https://example.com/image.png";
  link.append(image);
  head.append(link);
  fireEvent.pointerDown(image, point(5, 100, 100));
  fireEvent.pointerDown(image, point(6, 200, 100));
  fireEvent.pointerMove(surface, point(6, 110, 100));
  expect(world.style.transform).toContain("scale(0.25)");
  fireEvent.lostPointerCapture(surface, point(5, 100, 100));
  const cancelled = world.style.transform;
  fireEvent.pointerMove(surface, point(6, 500, 100));
  expect(world.style.transform).toBe(cancelled);
});

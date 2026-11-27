import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BoardCanvas, type BoardCommands } from "../components/board";
import type { Board } from "../contract";
import { gridBackground } from "../lib/grid";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps the painted grid registered to the board while zooming and panning", () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );

  const board: Board = {
    threadId: "grid",
    revision: 1,
    seenRevision: 0,
    sections: [],
    nodes: [],
    edges: [],
  };

  let commands: BoardCommands | undefined;

  const { container } = render(
    <BoardCanvas
      board={board}
      baseline={0}
      workspace={{ hostId: null, environmentId: null }}
      actions={{ choose: async () => {} }}
      selected={null}
      onSelect={() => {}}
      onMove={() => {}}
      onCommands={(value) => {
        commands = value;
      }}
    />,
  );

  const surface = container.querySelector<HTMLElement>(".cnv-board");

  if (!surface || !commands) throw new Error("Missing board controls");
  const controls = commands;

  for (const zoom of [0.1, 0.5, 1, 2, 2.5]) {
    act(() => controls.restore({ x: 13, y: -27, zoom }));
    const pitches = surface.style.backgroundSize.split(",").map(parseFloat);

    const positions = surface.style.backgroundPosition
      .split(",")
      .map((value) => value.trim().split(" ").map(parseFloat));

    const strengths = [...surface.style.backgroundImage.matchAll(/([\d.]+)%, transparent/g)].map(
      (match) => Number(match[1]),
    );

    expect(strengths.length).toBeGreaterThan(1);
    expect(strengths.reduce((sum, value) => sum + value, 0)).toBeCloseTo(14, 5);

    for (const [index, strength] of strengths.entries()) {
      const pitch = pitches[index] ?? NaN;
      expect((positions[index]?.[0] ?? NaN) + pitch / 2).toBeCloseTo(13);
      expect((positions[index]?.[1] ?? NaN) + pitch / 2).toBeCloseTo(-27);

      if (strength > 0) {
        expect(pitch).toBeGreaterThanOrEqual(12);
        expect(pitch).toBeLessThanOrEqual(48);
      }
    }

    expect(surface.style.backgroundImage).not.toContain("calc(");
    expect(surface.style.getPropertyValue("--cnv-zoom")).toBe(String(zoom));
  }

  act(() => controls.restore({ x: -80, y: 120, zoom: 2 }));
  const pitches = surface.style.backgroundSize.split(",").map(parseFloat);

  const positions = surface.style.backgroundPosition
    .split(",")
    .map((value) => value.trim().split(" ").map(parseFloat));

  for (const [index, pitch] of pitches.entries()) {
    expect((positions[index]?.[0] ?? NaN) + pitch / 2).toBeCloseTo(-80);
    expect((positions[index]?.[1] ?? NaN) + pitch / 2).toBeCloseTo(120);
  }
});

it("fades between grid levels continuously without crowding the viewport", () => {
  const strengths = (zoom: number) =>
    [
      ...String(gridBackground({ x: 0, y: 0, zoom }).backgroundImage).matchAll(
        /([\d.]+)%, transparent/g,
      ),
    ].map((match) => Number(match[1]));

  for (const boundary of [24 / 176, 24 / 88, 24 / 44, 24 / 22, 24 / 11]) {
    const before = strengths(boundary - 0.000001);
    const after = strengths(boundary + 0.000001);

    for (const [index, value] of before.entries()) {
      expect(value).toBeCloseTo(after[index] ?? NaN, 5);
    }
  }

  for (let sample = 0; sample <= 100; sample++) {
    const zoom = 0.1 * 25 ** (sample / 100);
    const style = gridBackground({ x: 0, y: 0, zoom });
    const pitches = String(style.backgroundSize).split(",").map(parseFloat);
    const opacity = strengths(zoom);
    const visible = pitches.filter((_, index) => (opacity[index] ?? 0) > 0);
    expect(visible.length).toBeGreaterThanOrEqual(1);
    expect(visible.length).toBeLessThanOrEqual(2);
    expect(Math.min(...visible)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...visible)).toBeLessThanOrEqual(48);
    expect(strengths(zoom).reduce((sum, strength) => sum + strength, 0)).toBeCloseTo(14, 5);
  }
});

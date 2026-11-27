import type { GraphDefinition } from "../data/contract.js";

export const NODE_WIDTH = 224;

export const NODE_HEIGHT = 60;

export const META_HEIGHT = 18;

export const GRID = 8;

export const CANVAS_PADDING = 48;

export const INITIAL_RADIUS = 7;

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Side = "top" | "right" | "bottom" | "left";

export function snap(value: number): number {
  return Math.round(value / GRID) * GRID;
}

export function autoPosition(index: number): Point {
  return { x: 64 + (index % 4) * 320, y: 80 + Math.floor(index / 4) * 160 };
}

export function nodeRects(definition: GraphDefinition, withMeta: boolean): Map<string, Rect> {
  const rects = new Map<string, Rect>();
  const height = NODE_HEIGHT + (withMeta ? META_HEIGHT : 0);

  definition.states.forEach((state, index) => {
    const position = definition.layout.nodes[state.id] ?? autoPosition(index);

    rects.set(state.id, { x: position.x, y: position.y, width: NODE_WIDTH, height });
  });

  return rects;
}

export function initialPoint(definition: GraphDefinition, rects: Map<string, Rect>): Point | null {
  if (definition.initialStateId === null) return null;

  const target = rects.get(definition.initialStateId);

  if (target === undefined) return null;

  const stored = definition.layout.initial;

  if (stored.x === 0 && stored.y === 0) return { x: target.x + 40, y: target.y - 72 };

  return stored;
}

export function bounds(rects: Iterable<Rect>, extra: readonly Point[]): Rect {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }

  for (const point of extra) {
    minX = Math.min(minX, point.x - 16);
    minY = Math.min(minY, point.y - 16);
    maxX = Math.max(maxX, point.x + 16);
    maxY = Math.max(maxY, point.y + 16);
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 640, height: 360 };

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

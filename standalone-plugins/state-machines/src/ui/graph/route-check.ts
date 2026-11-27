import type { Point, Rect } from "./geometry.js";

export interface CheckedEdge {
  id: string;
  from: string;
  to: string;
  points: readonly Point[];
  labelBox: Rect;
}

export interface RouteDiagnostics {
  labelOverlaps: string[];
  labelsOnNodes: string[];
  labelsOnForeignEdges: string[];
  pathsThroughNodes: string[];
  coincidentRuns: string[];
  sharedArrivals: string[];
}

const EPSILON = 0.5;

function boxesOverlap(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

export function segmentCrossesBox(a: Point, b: Point, box: Rect, inset = 0): boolean {
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;

  if (a.y === b.y) {
    if (a.y <= top || a.y >= bottom) return false;

    return Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
  }

  if (a.x <= left || a.x >= right) return false;

  return Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
}

function segments(points: readonly Point[]): [Point, Point][] {
  const result: [Point, Point][] = [];

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];

    if (a !== undefined && b !== undefined) result.push([a, b]);
  }

  return result;
}

function samePath(a: readonly Point[], b: readonly Point[]): boolean {
  return (
    a.length === b.length &&
    a.every((point, index) => point.x === b[index]?.x && point.y === b[index]?.y)
  );
}

function collinearOverlap(a: [Point, Point], b: [Point, Point]): number {
  const [a1, a2] = a;
  const [b1, b2] = b;

  if (a1.x === a2.x && b1.x === b2.x && Math.abs(a1.x - b1.x) < EPSILON) {
    return (
      Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) -
      Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
    );
  }

  if (a1.y === a2.y && b1.y === b2.y && Math.abs(a1.y - b1.y) < EPSILON) {
    return (
      Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) -
      Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
    );
  }

  return 0;
}

export function routeDiagnostics(
  edges: readonly CheckedEdge[],
  rects: ReadonlyMap<string, Rect>,
): RouteDiagnostics {
  const result: RouteDiagnostics = {
    labelOverlaps: [],
    labelsOnNodes: [],
    labelsOnForeignEdges: [],
    pathsThroughNodes: [],
    coincidentRuns: [],
    sharedArrivals: [],
  };

  for (const [index, edge] of edges.entries()) {
    for (const other of edges.slice(index + 1))
      if (boxesOverlap(edge.labelBox, other.labelBox, 0))
        result.labelOverlaps.push(`${edge.id}~${other.id}`);

    for (const [id, rect] of rects)
      if (boxesOverlap(edge.labelBox, rect, 0)) result.labelsOnNodes.push(`${edge.id}@${id}`);

    for (const other of edges) {
      if (other === edge || samePath(other.points, edge.points)) continue;

      if (segments(other.points).some(([a, b]) => segmentCrossesBox(a, b, edge.labelBox, 1)))
        result.labelsOnForeignEdges.push(`${edge.id}/${other.id}`);
    }

    const own = new Set([edge.from, edge.to]);

    for (const [id, rect] of rects) {
      if (own.has(id)) continue;

      if (segments(edge.points).some(([a, b]) => segmentCrossesBox(a, b, rect, 0)))
        result.pathsThroughNodes.push(`${edge.id}@${id}`);
    }

    for (const other of edges.slice(index + 1)) {
      if (samePath(other.points, edge.points)) continue;

      const touching = segments(edge.points).some((a) =>
        segments(other.points).some((b) => collinearOverlap(a, b) > 4),
      );

      if (touching) result.coincidentRuns.push(`${edge.id}=${other.id}`);

      const endA = edge.points.at(-1);
      const endB = other.points.at(-1);

      if (endA !== undefined && endB !== undefined && endA.x === endB.x && endA.y === endB.y)
        result.sharedArrivals.push(`${edge.id}>${other.id}`);
    }
  }

  return result;
}

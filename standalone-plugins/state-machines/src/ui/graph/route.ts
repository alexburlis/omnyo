import { center, type Point, type Rect, type Side } from "./geometry.js";
import { routeDiagnostics } from "./route-check.js";

export interface EdgeInput {
  id: string;
  from: string;
  to: string;
  label: string;
  sourceSide: Side | null;
  targetSide: Side | null;
  waypoints: readonly Point[];
  labelAt: number | null;
}

export interface RoutedEdge {
  id: string;
  points: Point[];
  label: Point;
  labelBox: Rect;
  labelSegmentHorizontal: boolean;
  overlapsNode: boolean;
  bundleSize: number;
}

const STUB = 16;

const CLEARANCE = 12;

const PORT_GAP = 20;

const PORT_INSET = 16;

const LANE_GAP = 12;

const LABEL_HEIGHT = 16;

const LABEL_WIDTH_SAFETY = 1.04;

export const LABEL_MAX_WIDTH = 240;

const LABEL_PADDING = 10;

const LABEL_MARGIN = 4;

const END_KEEP = 14;

const CORNER_KEEP = 6;

const NARROW = new Set("iljtfrI.,·:;'!| ");

const WIDE = new Set("mwMW@");

function charWidth(char: string): number {
  if (NARROW.has(char)) return 3.6;

  if (WIDE.has(char)) return 9.4;

  if (char !== char.toLowerCase()) return 8;

  return 6.4;
}

export function labelWidth(text: string): number {
  let width = 0;

  for (const char of text) width += charWidth(char);

  return Math.min(LABEL_MAX_WIDTH, Math.ceil(width * LABEL_WIDTH_SAFETY + LABEL_PADDING));
}

function sidePoint(rect: Rect, side: Side, offset: number): Point {
  switch (side) {
    case "top":
      return { x: rect.x + rect.width / 2 + offset, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.width / 2 + offset, y: rect.y + rect.height };
    case "left":
      return { x: rect.x, y: rect.y + rect.height / 2 + offset };
    case "right":
      return { x: rect.x + rect.width, y: rect.y + rect.height / 2 + offset };
  }
}

function step(point: Point, side: Side, distance: number): Point {
  switch (side) {
    case "top":
      return { x: point.x, y: point.y - distance };
    case "bottom":
      return { x: point.x, y: point.y + distance };
    case "left":
      return { x: point.x - distance, y: point.y };
    case "right":
      return { x: point.x + distance, y: point.y };
  }
}

function isHorizontalSide(side: Side): boolean {
  return side === "left" || side === "right";
}

export function chooseSides(source: Rect, target: Rect): [Side, Side] {
  const a = center(source);
  const b = center(target);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  if (Math.abs(dx) >= Math.abs(dy) * 1.2) return dx >= 0 ? ["right", "left"] : ["left", "right"];

  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"];
}

function segmentHitsRect(a: Point, b: Point, rect: Rect): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);

  return (
    maxX > rect.x - CLEARANCE / 2 &&
    minX < rect.x + rect.width + CLEARANCE / 2 &&
    maxY > rect.y - CLEARANCE / 2 &&
    minY < rect.y + rect.height + CLEARANCE / 2
  );
}

function pathCollides(points: readonly Point[], obstacles: readonly Rect[]): boolean {
  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];

    if (a === undefined || b === undefined) continue;

    if (obstacles.some((rect) => segmentHitsRect(a, b, rect))) return true;
  }

  return false;
}

function orthogonalThrough(
  start: Point,
  end: Point,
  startHorizontal: boolean,
  waypoints: readonly Point[],
): Point[] {
  const points: Point[] = [start];
  let horizontal = startHorizontal;
  let current = start;

  for (const target of [...waypoints, end]) {
    if (current.x !== target.x && current.y !== target.y) {
      const corner = horizontal ? { x: target.x, y: current.y } : { x: current.x, y: target.y };

      points.push(corner);
      horizontal = !horizontal;
    }

    points.push(target);
    current = target;
  }

  return points;
}

function simplify(points: readonly Point[]): Point[] {
  const result: Point[] = [];

  for (const point of points) {
    const last = result.at(-1);

    if (last !== undefined && last.x === point.x && last.y === point.y) continue;

    const before = result.at(-2);

    if (last !== undefined && before !== undefined) {
      const straightThrough =
        (before.x === last.x &&
          last.x === point.x &&
          Math.sign(last.y - before.y) === Math.sign(point.y - last.y)) ||
        (before.y === last.y &&
          last.y === point.y &&
          Math.sign(last.x - before.x) === Math.sign(point.x - last.x));

      if (straightThrough) result.pop();
    }

    result.push({ x: point.x, y: point.y });
  }

  return result;
}

function selfLoop(rect: Rect): Point[] {
  const right = rect.x + rect.width;
  const top = rect.y + rect.height / 2 - 20;
  const bottom = rect.y + rect.height / 2 + 20;

  return [
    { x: right, y: top },
    { x: right + 40, y: top },
    { x: right + 40, y: bottom },
    { x: right, y: bottom },
  ];
}

function detourRoute(source: Rect, target: Rect, rects: ReadonlyMap<string, Rect>): Point[] | null {
  const all = [...rects.values()];
  const obstacles = all.filter((rect) => rect !== source && rect !== target);
  const top = Math.min(...all.map((rect) => rect.y));
  const bottom = Math.max(...all.map((rect) => rect.y + rect.height));

  for (let lane = 0; lane < 6; lane += 1) {
    for (const side of ["top", "bottom"] as const) {
      const y =
        side === "top"
          ? Math.min(source.y, target.y) - 40 - lane * 16
          : Math.max(source.y + source.height, target.y + target.height) + 40 + lane * 16;

      const clampedY =
        side === "top" ? Math.max(y, top - 40 - lane * 16) : Math.min(y, bottom + 40 + lane * 16);

      const start = sidePoint(source, side, 0);
      const end = sidePoint(target, side, 0);

      const candidate = simplify([
        start,
        { x: start.x, y: clampedY },
        { x: end.x, y: clampedY },
        end,
      ]);

      if (!pathCollides([start, ...candidate, end], obstacles)) return candidate;
    }
  }

  return null;
}

interface Unit {
  key: string;
  members: EdgeInput[];
  from: string;
  to: string;
  manual: boolean;
  points: Point[];
  overlapsNode: boolean;
}

function groupUnits(edges: readonly EdgeInput[], rects: ReadonlyMap<string, Rect>): Unit[] {
  const byKey = new Map<string, Unit>();
  const units: Unit[] = [];

  for (const edge of edges) {
    if (!rects.has(edge.from) || !rects.has(edge.to)) continue;

    const manual =
      edge.sourceSide !== null ||
      edge.targetSide !== null ||
      edge.waypoints.length > 0 ||
      edge.labelAt !== null;

    const key = manual ? `edge:${edge.id}` : `pair:${edge.from}>${edge.to}`;
    const existing = byKey.get(key);

    if (existing !== undefined) {
      existing.members.push(edge);
      continue;
    }

    const unit: Unit = {
      key,
      members: [edge],
      from: edge.from,
      to: edge.to,
      manual,
      points: [],
      overlapsNode: false,
    };

    byKey.set(key, unit);
    units.push(unit);
  }

  return units;
}

interface Ports {
  offsets: Map<string, number>;
  siblings: Map<string, string[]>;
}

function portOffsets(
  units: readonly Unit[],
  sides: ReadonlyMap<string, [Side, Side]>,
  rects: ReadonlyMap<string, Rect>,
): Ports {
  const ports = new Map<string, { key: string; along: number; partner: string }[]>();
  const portSides = new Map<string, { node: string; side: Side }>();

  for (const unit of units) {
    const pair = sides.get(unit.key);
    const source = rects.get(unit.from);
    const target = rects.get(unit.to);

    if (pair === undefined || source === undefined || target === undefined) continue;

    const entries: [string, Side, Rect, string][] = [
      [unit.from, pair[0], target, unit.to],
      [unit.to, pair[1], source, unit.from],
    ];

    for (const [node, side, other, partner] of entries) {
      const port = `${node}:${side}`;
      const list = ports.get(port) ?? [];
      const otherCenter = center(other);

      list.push({
        key: `${unit.key}:${node === unit.from ? "out" : "in"}`,
        along: isHorizontalSide(side) ? otherCenter.y : otherCenter.x,
        partner,
      });
      ports.set(port, list);
      portSides.set(port, { node, side });
    }
  }

  const offsets = new Map<string, number>();
  const siblings = new Map<string, string[]>();

  for (const [port, list] of ports) {
    for (const entry of list)
      siblings.set(
        entry.key,
        list.flatMap((other) => (other.key === entry.key ? [] : [other.key])),
      );

    const where = portSides.get(port);

    if (where === undefined) continue;

    const { node, side } = where;
    const rect = rects.get(node);

    if (rect === undefined) continue;

    const length = isHorizontalSide(side) ? rect.height : rect.width;
    const middle = isHorizontalSide(side) ? rect.y + rect.height / 2 : rect.x + rect.width / 2;
    const half = length / 2 - PORT_INSET;

    const pairKey = (key: string): string => key.replace(/:(in|out)$/, "");

    const desired = list
      .map((entry) => {
        const sharing = list
          .filter((other) => other.partner === entry.partner)
          .map((other) => pairKey(other.key))
          .sort();

        const position = sharing.indexOf(pairKey(entry.key));

        const spread = sharing.length > 1 ? (position / (sharing.length - 1) - 0.5) * half : 0;

        return {
          key: entry.key,
          want: Math.max(-half, Math.min(half, entry.along - middle + spread)),
        };
      })
      .sort((a, b) => a.want - b.want || a.key.localeCompare(b.key));

    const gap = desired.length > 1 ? Math.min(PORT_GAP, (half * 2) / (desired.length - 1)) : 0;
    const placed = desired.map((entry) => entry.want);

    for (let index = 1; index < placed.length; index += 1)
      placed[index] = Math.max(placed[index] ?? 0, (placed[index - 1] ?? 0) + gap);

    const overflow = (placed.at(-1) ?? 0) - half;

    if (overflow > 0)
      for (let index = 0; index < placed.length; index += 1)
        placed[index] = (placed[index] ?? 0) - overflow;

    for (let index = placed.length - 2; index >= 0; index -= 1)
      placed[index] = Math.min(placed[index] ?? 0, (placed[index + 1] ?? 0) - gap);

    const underflow = -half - (placed[0] ?? 0);

    if (underflow > 0)
      for (let index = 0; index < placed.length; index += 1)
        placed[index] = (placed[index] ?? 0) + underflow;

    desired.forEach((entry, index) => offsets.set(entry.key, Math.round(placed[index] ?? 0)));
  }

  return { offsets, siblings };
}

const SIDES: readonly Side[] = ["top", "right", "bottom", "left"];

const OUTER_LANE = 32;

function segmentsOf(points: readonly Point[]): [Point, Point][] {
  const result: [Point, Point][] = [];

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];

    if (a !== undefined && b !== undefined) result.push([a, b]);
  }

  return result;
}

function crosses(a: [Point, Point], b: [Point, Point]): boolean {
  const [a1, a2] = a;
  const [b1, b2] = b;
  const aHorizontal = a1.y === a2.y;
  const bHorizontal = b1.y === b2.y;

  if (aHorizontal === bHorizontal) return false;

  const [h1, h2, v1, v2] = aHorizontal ? [a1, a2, b1, b2] : [b1, b2, a1, a2];

  return (
    v1.x > Math.min(h1.x, h2.x) &&
    v1.x < Math.max(h1.x, h2.x) &&
    h1.y > Math.min(v1.y, v2.y) &&
    h1.y < Math.max(v1.y, v2.y)
  );
}

function hitsOwnNode(points: readonly Point[], rects: readonly Rect[]): boolean {
  const segments = segmentsOf(points);

  return segments.slice(1, -1).some(([a, b]) =>
    rects.some((rect) => {
      if (a.y === b.y)
        return (
          a.y > rect.y &&
          a.y < rect.y + rect.height &&
          Math.max(a.x, b.x) > rect.x &&
          Math.min(a.x, b.x) < rect.x + rect.width
        );

      return (
        a.x > rect.x &&
        a.x < rect.x + rect.width &&
        Math.max(a.y, b.y) > rect.y &&
        Math.min(a.y, b.y) < rect.y + rect.height
      );
    }),
  );
}

function outward(side: Side): Point {
  switch (side) {
    case "top":
      return { x: 0, y: -1 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "right":
      return { x: 1, y: 0 };
  }
}

const MIN_FIRST = 10;

const MIN_LAST = 14;

function reverses(points: readonly Point[]): boolean {
  for (let index = 2; index < points.length; index += 1) {
    const a = points[index - 2];
    const b = points[index - 1];
    const c = points[index];

    if (a === undefined || b === undefined || c === undefined) continue;

    if (a.x === b.x && b.x === c.x && Math.sign(b.y - a.y) === -Math.sign(c.y - b.y)) return true;

    if (a.y === b.y && b.y === c.y && Math.sign(b.x - a.x) === -Math.sign(c.x - b.x)) return true;
  }

  return false;
}

function endsLongEnough(points: readonly Point[]): boolean {
  const [first, second] = points;
  const last = points.at(-1);
  const beforeLast = points.at(-2);

  if (first === undefined || second === undefined || last === undefined || beforeLast === undefined)
    return false;

  return (
    Math.abs(first.x - second.x) + Math.abs(first.y - second.y) >= MIN_FIRST &&
    Math.abs(last.x - beforeLast.x) + Math.abs(last.y - beforeLast.y) >= MIN_LAST
  );
}

function leavesAndEntersCleanly(
  points: readonly Point[],
  sourceSide: Side,
  targetSide: Side,
): boolean {
  const [first, second] = points;
  const last = points.at(-1);
  const beforeLast = points.at(-2);

  if (first === undefined || second === undefined || last === undefined || beforeLast === undefined)
    return false;

  const out = outward(sourceSide);
  const inward = outward(targetSide);

  if (!endsLongEnough(points) || reverses(points)) return false;

  return (
    Math.sign(second.x - first.x) === out.x &&
    Math.sign(second.y - first.y) === out.y &&
    Math.sign(last.x - beforeLast.x) === -inward.x &&
    Math.sign(last.y - beforeLast.y) === -inward.y
  );
}

function middles(start: Point, end: Point, source: Rect, target: Rect): Point[][] {
  const right = Math.max(source.x + source.width, target.x + target.width) + OUTER_LANE;
  const left = Math.min(source.x, target.x) - OUTER_LANE;
  const bottom = Math.max(source.y + source.height, target.y + target.height) + OUTER_LANE;
  const top = Math.min(source.y, target.y) - OUTER_LANE;
  const xs = [(start.x + end.x) / 2, start.x, end.x, right, left];
  const ys = [(start.y + end.y) / 2, start.y, end.y, bottom, top];

  return [
    ...xs.map((x) => [
      { x, y: start.y },
      { x, y: end.y },
    ]),
    ...ys.map((y) => [
      { x: start.x, y },
      { x: end.x, y },
    ]),
  ];
}

interface PathChoice {
  points: Point[];
  cost: number;
}

const SHORT_SEGMENT = 320;

interface Weights {
  overlap: number;
  crossing: number;
}

interface Tuning {
  sideOverlap: number;
  crossing: number;
}

const LARGE_GRAPH_EDGES = 40;

const TUNINGS: readonly Tuning[] = [
  { sideOverlap: 0, crossing: 60 },
  { sideOverlap: 0, crossing: 160 },
  { sideOverlap: 400, crossing: 160 },
  { sideOverlap: 400, crossing: 400 },
];

interface Segment {
  horizontal: boolean;
  at: number;
  low: number;
  high: number;
  length: number;
}

function toSegments(points: readonly Point[]): Segment[] {
  const result: Segment[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];

    if (a === undefined || b === undefined) continue;

    const horizontal = a.y === b.y;
    const low = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const high = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);

    result.push({ horizontal, at: horizontal ? a.y : a.x, low, high, length: high - low });
  }

  return result;
}

function pathCost(
  points: readonly Point[],
  clean: boolean,
  own: readonly Rect[],
  obstacles: readonly Rect[],
  routed: readonly Segment[],
  weights: Weights,
  budget: number,
): number {
  const mine = toSegments(points);
  let cost = clean ? 0 : 2000;

  for (const segment of mine) cost += segment.length;

  cost += (mine.length - 1) * 40;

  if (cost >= budget) return cost;

  if (pathCollides(points, obstacles)) cost += 2000;

  if (hitsOwnNode(points, own)) cost += 2000;

  for (const a of mine) {
    if (cost >= budget) return cost;

    for (const b of routed) {
      if (a.horizontal !== b.horizontal) {
        if (b.at > a.low && b.at < a.high && a.at > b.low && a.at < b.high)
          cost += weights.crossing * (b.length < SHORT_SEGMENT ? 3 : 1);
      } else if (Math.abs(a.at - b.at) < 4 && Math.min(a.high, b.high) - Math.max(a.low, b.low) > 4)
        cost += weights.overlap;
    }
  }

  return cost;
}

function bestPath(
  sourceSide: Side,
  targetSide: Side,
  start: Point,
  end: Point,
  source: Rect,
  target: Rect,
  obstacles: readonly Rect[],
  routed: readonly Segment[],
  weights: Weights,
  budget = Number.POSITIVE_INFINITY,
): PathChoice {
  const startStub = step(start, sourceSide, STUB);
  const endStub = step(end, targetSide, STUB);
  let best: PathChoice | null = null;

  for (const middle of middles(startStub, endStub, source, target)) {
    const points = simplify([
      start,
      ...orthogonalThrough(startStub, endStub, isHorizontalSide(sourceSide), middle),
      end,
    ]);

    const cost = pathCost(
      points,
      leavesAndEntersCleanly(points, sourceSide, targetSide),
      [source, target],
      obstacles,
      routed,
      weights,
      Math.min(budget, best?.cost ?? Number.POSITIVE_INFINITY),
    );

    if (best === null || cost < best.cost) best = { points, cost };
  }

  return best ?? { points: [start, end], cost: Number.POSITIVE_INFINITY };
}

function chooseUnitSides(
  unit: Unit,
  rects: ReadonlyMap<string, Rect>,
  routed: readonly Segment[],
  tuning: Tuning,
): [Side, Side] | null {
  const source = rects.get(unit.from);
  const target = rects.get(unit.to);
  const edge = unit.members[0];

  if (source === undefined || target === undefined || edge === undefined) return null;

  const auto = chooseSides(source, target);

  if (unit.manual) return [edge.sourceSide ?? auto[0], edge.targetSide ?? auto[1]];

  const obstacles = obstaclesFor(unit, rects);
  let best: { pair: [Side, Side]; cost: number } | null = null;

  for (const sourceSide of SIDES)
    for (const targetSide of SIDES) {
      const preferred = sourceSide === auto[0] && targetSide === auto[1] ? 0 : 24;
      const from = sidePoint(source, sourceSide, 0);
      const to = sidePoint(target, targetSide, 0);

      if (
        best !== null &&
        Math.abs(from.x - to.x) + Math.abs(from.y - to.y) + preferred >= best.cost
      )
        continue;

      const choice = bestPath(
        sourceSide,
        targetSide,
        sidePoint(source, sourceSide, 0),
        sidePoint(target, targetSide, 0),
        source,
        target,
        obstacles,
        routed,
        { overlap: tuning.sideOverlap, crossing: tuning.crossing },
        best === null ? Number.POSITIVE_INFINITY : best.cost,
      );

      const cost = choice.cost + preferred;

      if (best === null || cost < best.cost) best = { pair: [sourceSide, targetSide], cost };
    }

  return best?.pair ?? auto;
}

function obstaclesFor(unit: Unit, rects: ReadonlyMap<string, Rect>): Rect[] {
  return [...rects.entries()].flatMap(([id, rect]) =>
    id === unit.from || id === unit.to ? [] : [rect],
  );
}

function routeUnit(
  unit: Unit,
  pair: [Side, Side],
  ports: Ports,
  rects: ReadonlyMap<string, Rect>,
  routed: readonly Segment[],
  tuning: Tuning,
): void {
  const offsets = ports.offsets;
  const source = rects.get(unit.from);
  const target = rects.get(unit.to);
  const edge = unit.members[0];

  if (source === undefined || target === undefined || edge === undefined) return;

  const [sourceSide, targetSide] = pair;
  let start = sidePoint(source, sourceSide, offsets.get(`${unit.key}:out`) ?? 0);
  let end = sidePoint(target, targetSide, offsets.get(`${unit.key}:in`) ?? 0);
  const obstacles = obstaclesFor(unit, rects);

  if (edge.waypoints.length > 0) {
    unit.points = simplify([
      start,
      ...orthogonalThrough(
        step(start, sourceSide, STUB),
        step(end, targetSide, STUB),
        isHorizontalSide(sourceSide),
        edge.waypoints,
      ),
      end,
    ]);
    unit.overlapsNode = pathCollides(unit.points, obstacles);

    return;
  }

  const siblingsOf = (key: string): number[] =>
    (ports.siblings.get(key) ?? []).flatMap((sibling) => {
      const offset = offsets.get(sibling);

      return offset === undefined ? [] : [offset];
    });

  const aligned = alignFacingPair(
    start,
    end,
    sourceSide,
    targetSide,
    source,
    target,
    siblingsOf(`${unit.key}:out`),
    siblingsOf(`${unit.key}:in`),
  );

  start = aligned[0];
  end = aligned[1];

  let points = bestPath(sourceSide, targetSide, start, end, source, target, obstacles, routed, {
    overlap: 400,
    crossing: tuning.crossing,
  }).points;

  if (pathCollides(points, obstacles) && edge.sourceSide === null && edge.targetSide === null) {
    const detour = detourRoute(source, target, rects);

    if (detour !== null) points = detour;
  }

  unit.points = points;
  unit.overlapsNode = pathCollides(points, obstacles);
}

const FACING_SNAP = 24;

const PORT_CLEARANCE = 8;

function alignFacingPair(
  start: Point,
  end: Point,
  sourceSide: Side,
  targetSide: Side,
  source: Rect,
  target: Rect,
  sourceSiblings: readonly number[],
  targetSiblings: readonly number[],
): [Point, Point] {
  const facing =
    (sourceSide === "right" && targetSide === "left" && start.x < end.x) ||
    (sourceSide === "left" && targetSide === "right" && start.x > end.x) ||
    (sourceSide === "bottom" && targetSide === "top" && start.y < end.y) ||
    (sourceSide === "top" && targetSide === "bottom" && start.y > end.y);

  if (!facing) return [start, end];

  const horizontal = isHorizontalSide(targetSide);
  const a = horizontal ? start.y : start.x;
  const b = horizontal ? end.y : end.x;

  if (a === b || Math.abs(a - b) > FACING_SNAP) return [start, end];

  const sourceMiddle = horizontal ? source.y + source.height / 2 : source.x + source.width / 2;
  const targetMiddle = horizontal ? target.y + target.height / 2 : target.x + target.width / 2;

  const low =
    Math.max(horizontal ? source.y : source.x, horizontal ? target.y : target.x) + PORT_INSET / 2;

  const high =
    Math.min(
      horizontal ? source.y + source.height : source.x + source.width,
      horizontal ? target.y + target.height : target.x + target.width,
    ) -
    PORT_INSET / 2;

  const clear = (value: number): boolean =>
    value >= low &&
    value <= high &&
    sourceSiblings.every((offset) => Math.abs(sourceMiddle + offset - value) >= PORT_CLEARANCE) &&
    targetSiblings.every((offset) => Math.abs(targetMiddle + offset - value) >= PORT_CLEARANCE);

  const middle = Math.round((a + b) / 2);
  const tries = [a, b, middle];

  for (let distance = 2; distance <= FACING_SNAP; distance += 2)
    tries.push(middle - distance, middle + distance);

  const chosen = tries.find(clear);

  if (chosen === undefined) return [start, end];

  return horizontal
    ? [
        { x: start.x, y: chosen },
        { x: end.x, y: chosen },
      ]
    : [
        { x: chosen, y: start.y },
        { x: chosen, y: end.y },
      ];
}

interface Run {
  unit: Unit;
  index: number;
  coord: number;
  low: number;
  high: number;
}

function separateLanes(units: readonly Unit[], rects: ReadonlyMap<string, Rect>): void {
  for (const vertical of [true, false]) {
    const groups = new Map<number, Run[]>();

    for (const unit of units) {
      if (unit.manual || unit.from === unit.to) continue;

      for (let index = 1; index < unit.points.length - 2; index += 1) {
        const a = unit.points[index];
        const b = unit.points[index + 1];

        if (a === undefined || b === undefined) continue;

        if (vertical ? a.x !== b.x : a.y !== b.y) continue;

        const coord = vertical ? a.x : a.y;
        const low = vertical ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
        const high = vertical ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
        const list = groups.get(coord) ?? [];

        list.push({ unit, index, coord, low, high });
        groups.set(coord, list);
      }
    }

    for (const runs of groups.values()) {
      runs.sort((a, b) => a.low - b.low || a.unit.key.localeCompare(b.unit.key));

      let cluster: Run[] = [];
      let reach = Number.NEGATIVE_INFINITY;

      const flush = () => {
        const distinct = [...new Map(cluster.map((run) => [run.unit.key, run])).values()];

        if (distinct.length > 1) {
          distinct.sort((a, b) => a.unit.key.localeCompare(b.unit.key));

          const taken: number[] = [];

          distinct.forEach((run, position) => {
            const preferred = (position - (distinct.length - 1) / 2) * LANE_GAP;

            const options = [preferred, -preferred];

            for (let step = 1; step <= distinct.length + 1; step += 1)
              options.push(step * LANE_GAP, -step * LANE_GAP);

            const moved = shiftRun(run, options, taken, vertical, rects);

            taken.push(run.coord + moved);
          });
        }

        cluster = [];
      };

      for (const run of runs) {
        if (cluster.length > 0 && run.low >= reach - 4) flush();

        cluster.push(run);
        reach = cluster.length === 1 ? run.high : Math.max(reach, run.high);
      }

      flush();
    }
  }
}

function shiftRun(
  run: Run,
  options: readonly number[],
  taken: readonly number[],
  vertical: boolean,
  rects: ReadonlyMap<string, Rect>,
): number {
  const obstacles = [...rects.entries()].flatMap(([id, rect]) =>
    id === run.unit.from || id === run.unit.to ? [] : [rect],
  );

  for (const delta of options) {
    if (taken.some((coord) => Math.abs(coord - (run.coord + delta)) < LANE_GAP / 2)) continue;

    if (delta === 0) return 0;

    const moved = run.unit.points.map((point, index) =>
      index === run.index || index === run.index + 1
        ? vertical
          ? { x: point.x + delta, y: point.y }
          : { x: point.x, y: point.y + delta }
        : point,
    );

    if (!pathCollides(moved, obstacles) && endsLongEnough(moved)) {
      run.unit.points = moved;

      return delta;
    }
  }

  return 0;
}

interface Candidate {
  box: Rect;
  horizontal: boolean;
  cost: number;
}

const FRACTIONS = [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9];

function crossingsAlong(a: Point, b: Point, others: readonly (readonly Point[])[]): number[] {
  const horizontal = a.y === b.y;
  const result: number[] = [];

  for (const other of others)
    for (const segment of segmentsOf(other))
      if (crosses([a, b], segment)) result.push(horizontal ? segment[0].x : segment[0].y);

  return result;
}

function jogCandidates(points: readonly Point[], width: number, height: number): Candidate[] {
  const result: Candidate[] = [];
  const last = points.length - 2;

  for (let index = 1; index < last; index += 1) {
    const before = points[index - 1];
    const a = points[index];
    const b = points[index + 1];
    const after = points[index + 2];

    if (before === undefined || a === undefined || b === undefined || after === undefined) continue;

    const jog = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    if (jog > FACING_SNAP) continue;

    const horizontalRun = before.y === a.y && b.y === after.y;
    const verticalRun = before.x === a.x && b.x === after.x;

    if (!horizontalRun && !verticalRun) continue;

    const half = horizontalRun ? width / 2 : height / 2;
    const keepBefore = index - 1 === 0 ? END_KEEP : CORNER_KEEP;
    const keepAfter = index + 1 === last ? END_KEEP : CORNER_KEEP;
    const lengthBefore = Math.abs(before.x - a.x) + Math.abs(before.y - a.y);
    const lengthAfter = Math.abs(b.x - after.x) + Math.abs(b.y - after.y);

    if (lengthBefore < half + keepBefore || lengthAfter < half + keepAfter) continue;

    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;

    result.push({
      box: { x: cx - width / 2, y: cy - height / 2, width, height },
      horizontal: horizontalRun,
      cost: horizontalRun ? 0.01 : 0.31,
    });
  }

  return result;
}

function labelCandidates(
  points: readonly Point[],
  width: number,
  height: number,
  others: readonly (readonly Point[])[],
): Candidate[] {
  const result: Candidate[] = [...jogCandidates(points, width, height)];
  const last = points.length - 2;

  for (let index = 0; index <= last; index += 1) {
    const a = points[index];
    const b = points[index + 1];

    if (a === undefined || b === undefined) continue;

    const horizontal = a.y === b.y;
    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const along = horizontal ? width : height;
    const keepStart = index === 0 ? END_KEEP : CORNER_KEEP;
    const keepEnd = index === last ? END_KEEP : CORNER_KEEP;
    const usable = length - along - keepStart - keepEnd;

    if (usable < 0) continue;

    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);

    const startCoord = horizontal ? a.x : a.y;
    const direction = horizontal ? dx : dy;
    const blocked = crossingsAlong(a, b, others).map((coord) => (coord - startCoord) * direction);

    const edges = [keepStart, ...blocked.map((value) => value + LABEL_MARGIN)].sort(
      (p, q) => p - q,
    );

    for (const from of edges) {
      const limit = Math.min(
        length - keepEnd,
        ...blocked.filter((value) => value > from).map((value) => value - LABEL_MARGIN),
      );

      if (limit - from < along) continue;

      const distance = (from + limit) / 2;
      const cx = a.x + dx * distance;
      const cy = a.y + dy * distance;

      result.push({
        box: { x: cx - width / 2, y: cy - height / 2, width, height },
        horizontal,
        cost: (horizontal ? 0 : 0.3) + 0.05,
      });
    }

    FRACTIONS.forEach((fraction, rank) => {
      const distance = keepStart + along / 2 + usable * fraction;
      const cx = a.x + dx * distance;
      const cy = a.y + dy * distance;
      const lengthBonus = -Math.min(length, 400) / 4000;
      const base = (horizontal ? 0 : 0.3) + rank * 0.02 + lengthBonus;

      result.push({
        box: { x: cx - width / 2, y: cy - height / 2, width, height },
        horizontal,
        cost: base,
      });

      const beside = horizontal
        ? [
            { x: cx - width / 2, y: cy - height - LABEL_MARGIN },
            { x: cx - width / 2, y: cy + LABEL_MARGIN },
          ]
        : [
            { x: cx + LABEL_MARGIN + 2, y: cy - height / 2 },
            { x: cx - width - LABEL_MARGIN - 2, y: cy - height / 2 },
          ];

      for (const corner of beside)
        result.push({
          box: { x: corner.x, y: corner.y, width, height },
          horizontal,
          cost: base + 0.6,
        });
    });
  }

  return result;
}

function overlaps(a: Rect, b: Rect, margin: number): boolean {
  return (
    a.x < b.x + b.width + margin &&
    a.x + a.width + margin > b.x &&
    a.y < b.y + b.height + margin &&
    a.y + a.height + margin > b.y
  );
}

function crossesBox(a: Point, b: Point, box: Rect): boolean {
  if (a.y === b.y) {
    if (a.y <= box.y || a.y >= box.y + box.height) return false;

    return Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
  }

  if (a.x <= box.x || a.x >= box.x + box.width) return false;

  return Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
}

function violations(
  box: Rect,
  unit: Unit,
  units: readonly Unit[],
  rects: ReadonlyMap<string, Rect>,
  placed: readonly Rect[],
): number {
  let count = 0;

  for (const rect of rects.values()) if (overlaps(box, rect, LABEL_MARGIN)) count += 100;

  for (const other of placed) if (overlaps(box, other, LABEL_MARGIN)) count += 10;

  for (const other of units) {
    if (other === unit) continue;

    for (let index = 1; index < other.points.length; index += 1) {
      const a = other.points[index - 1];
      const b = other.points[index];

      if (a !== undefined && b !== undefined && crossesBox(a, b, box)) count += 1;
    }
  }

  return count;
}

function manualLabel(
  points: readonly Point[],
  labelAt: number,
  width: number,
  height: number,
): Candidate {
  let best = { length: -1, index: 0 };

  for (let index = 0; index < points.length - 1; index += 1) {
    const a = points[index];
    const b = points[index + 1];

    if (a === undefined || b === undefined) continue;

    const length = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    if (length > best.length) best = { length, index };
  }

  const a = points[best.index] ?? { x: 0, y: 0 };
  const b = points[best.index + 1] ?? a;
  const cx = a.x + (b.x - a.x) * labelAt;
  const cy = a.y + (b.y - a.y) * labelAt;

  return {
    box: { x: cx - width / 2, y: cy - height / 2, width, height },
    horizontal: a.y === b.y,
    cost: 0,
  };
}

function pathLength(points: readonly Point[]): number {
  let total = 0;

  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];

    if (a !== undefined && b !== undefined) total += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  return total;
}

export function routeEdges(
  edges: readonly EdgeInput[],
  rects: ReadonlyMap<string, Rect>,
  options: { fast?: boolean } = {},
): RoutedEdge[] {
  let best: { routed: RoutedEdge[]; score: number; drawn: number } | null = null;

  const tunings =
    options.fast === true || edges.length > LARGE_GRAPH_EDGES ? TUNINGS.slice(0, 1) : TUNINGS;

  for (const tuning of tunings) {
    const routed = routeWith(edges, rects, tuning);
    const score = layoutScore(routed, edges, rects);
    const drawn = drawnLength(routed);

    if (best === null || score < best.score || (score === best.score && drawn < best.drawn))
      best = { routed, score, drawn };

    if (score === 0) break;
  }

  return best?.routed ?? [];
}

function drawnLength(routed: readonly RoutedEdge[]): number {
  const paths = new Map(routed.map((edge) => [JSON.stringify(edge.points), edge.points]));
  let cost = 0;

  for (const points of paths.values()) {
    const segments = segmentsOf(points);

    cost += (segments.length - 1) * 40;

    for (const [a, b] of segments) cost += Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  }

  return cost;
}

function layoutScore(
  routed: readonly RoutedEdge[],
  edges: readonly EdgeInput[],
  rects: ReadonlyMap<string, Rect>,
): number {
  const ends = new Map(edges.map((edge) => [edge.id, edge]));

  const checked = routed.flatMap((edge) => {
    const input = ends.get(edge.id);

    return input === undefined
      ? []
      : [
          {
            id: edge.id,
            from: input.from,
            to: input.to,
            points: edge.points,
            labelBox: edge.labelBox,
          },
        ];
  });

  const found = routeDiagnostics(checked, rects);

  return (
    found.pathsThroughNodes.length * 1000 +
    found.labelsOnNodes.length * 500 +
    found.labelOverlaps.length * 500 +
    found.labelsOnForeignEdges.length * 100 +
    found.coincidentRuns.length * 100 +
    found.sharedArrivals.length * 100
  );
}

function routeWith(
  edges: readonly EdgeInput[],
  rects: ReadonlyMap<string, Rect>,
  tuning: Tuning,
): RoutedEdge[] {
  const units = groupUnits(edges, rects);
  const sides = new Map<string, [Side, Side]>();

  const distance = (unit: Unit): number => {
    const source = rects.get(unit.from);
    const target = rects.get(unit.to);

    if (source === undefined || target === undefined) return 0;

    const a = center(source);
    const b = center(target);

    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  };

  const straight = (unit: Unit): boolean => {
    const source = rects.get(unit.from);
    const target = rects.get(unit.to);

    if (source === undefined || target === undefined || unit.from === unit.to) return false;

    const horizontalOverlap =
      Math.min(source.x + source.width, target.x + target.width) - Math.max(source.x, target.x);

    const verticalOverlap =
      Math.min(source.y + source.height, target.y + target.height) - Math.max(source.y, target.y);

    return horizontalOverlap >= 2 * PORT_INSET || verticalOverlap >= 2 * PORT_INSET;
  };

  const sequence = [...units].sort(
    (a, b) =>
      Number(b.manual) - Number(a.manual) ||
      Number(straight(b)) - Number(straight(a)) ||
      distance(a) - distance(b) ||
      a.key.localeCompare(b.key),
  );

  const provisional: Segment[] = [];

  for (const unit of sequence) {
    if (unit.from === unit.to) continue;

    const pair = chooseUnitSides(unit, rects, provisional, tuning);

    if (pair === null) continue;

    sides.set(unit.key, pair);

    const source = rects.get(unit.from);
    const target = rects.get(unit.to);

    if (source !== undefined && target !== undefined)
      provisional.push(
        ...toSegments(
          bestPath(
            pair[0],
            pair[1],
            sidePoint(source, pair[0], 0),
            sidePoint(target, pair[1], 0),
            source,
            target,
            obstaclesFor(unit, rects),
            provisional,
            { overlap: tuning.sideOverlap, crossing: tuning.crossing },
          ).points,
        ),
      );
  }

  const ports = portOffsets(units, sides, rects);
  const finished: Segment[] = [];

  for (const unit of sequence) {
    if (unit.from === unit.to) {
      const rect = rects.get(unit.from);

      if (rect !== undefined) unit.points = selfLoop(rect);

      finished.push(...toSegments(unit.points));
      continue;
    }

    const pair = sides.get(unit.key);

    if (pair === undefined) continue;

    routeUnit(unit, pair, ports, rects, finished, tuning);
    finished.push(...toSegments(unit.points));
  }

  separateLanes(units, rects);

  for (const unit of units) {
    if (unit.manual || unit.from === unit.to) continue;

    const obstacles = [...rects.entries()].flatMap(([id, rect]) =>
      id === unit.from || id === unit.to ? [] : [rect],
    );

    unit.overlapsNode = pathCollides(unit.points, obstacles);
  }

  const placed: Rect[] = [];
  const boxes = new Map<string, Candidate>();

  const order = [...units].sort(
    (a, b) =>
      b.members.length - a.members.length ||
      pathLength(a.points) - pathLength(b.points) ||
      a.key.localeCompare(b.key),
  );

  for (const unit of order) {
    const width = Math.max(...unit.members.map((member) => labelWidth(member.label)));
    const height = LABEL_HEIGHT * unit.members.length;
    const labelAt = unit.members[0]?.labelAt ?? null;

    let chosen: Candidate | null = null;

    if (labelAt !== null) chosen = manualLabel(unit.points, labelAt, width, height);
    else {
      let best: { candidate: Candidate; score: number } | null = null;

      const others = units.flatMap((other) => (other === unit ? [] : [other.points]));

      for (const candidate of labelCandidates(unit.points, width, height, others)) {
        const score = violations(candidate.box, unit, units, rects, placed) + candidate.cost;

        if (best === null || score < best.score) best = { candidate, score };
      }

      chosen = best?.candidate ?? manualLabel(unit.points, 0.5, width, height);
    }

    placed.push(chosen.box);
    boxes.set(unit.key, chosen);
  }

  const routed: RoutedEdge[] = [];
  const unitOf = new Map(units.flatMap((unit) => unit.members.map((member) => [member.id, unit])));

  for (const edge of edges) {
    const unit = unitOf.get(edge.id);
    const chosen = unit === undefined ? undefined : boxes.get(unit.key);

    if (unit === undefined || chosen === undefined) continue;

    const position = unit.members.indexOf(edge);
    const width = labelWidth(edge.label);
    const cx = chosen.box.x + chosen.box.width / 2;
    const cy = chosen.box.y + LABEL_HEIGHT / 2 + position * LABEL_HEIGHT;

    routed.push({
      id: edge.id,
      points: unit.points,
      label: { x: cx, y: cy },
      labelBox: { x: cx - width / 2, y: cy - LABEL_HEIGHT / 2, width, height: LABEL_HEIGHT },
      labelSegmentHorizontal: chosen.horizontal,
      overlapsNode: unit.overlapsNode,
      bundleSize: unit.members.length,
    });
  }

  return routed;
}

export function pathData(points: readonly Point[], radius = 8): string {
  if (points.length === 0) return "";

  const first = points[0];

  if (first === undefined) return "";

  let d = `M ${first.x} ${first.y}`;

  for (let index = 1; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    const next = points[index + 1];

    if (current === undefined || previous === undefined) continue;

    if (next === undefined) {
      d += ` L ${current.x} ${current.y}`;
      continue;
    }

    const inLength = Math.abs(current.x - previous.x) + Math.abs(current.y - previous.y);
    const outLength = Math.abs(next.x - current.x) + Math.abs(next.y - current.y);
    const r = Math.min(radius, inLength / 2, outLength / 2);

    const before = {
      x: current.x - Math.sign(current.x - previous.x) * r,
      y: current.y - Math.sign(current.y - previous.y) * r,
    };

    const after = {
      x: current.x + Math.sign(next.x - current.x) * r,
      y: current.y + Math.sign(next.y - current.y) * r,
    };

    d += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }

  return d;
}

export function arrowHead(points: readonly Point[]): string {
  const end = points.at(-1);
  const before = points.at(-2);

  if (end === undefined || before === undefined) return "";

  const dx = Math.sign(end.x - before.x);
  const dy = Math.sign(end.y - before.y);
  const length = 8;
  const half = 4;
  const baseX = end.x - dx * length;
  const baseY = end.y - dy * length;

  return `M ${end.x} ${end.y} L ${baseX - dy * half} ${baseY + dx * half} L ${baseX + dy * half} ${baseY - dx * half} Z`;
}

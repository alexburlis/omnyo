import {
  flowLeaves,
  isIsland,
  type Board,
  type CanvasEdge,
  type CanvasNode,
  type FlowGroup,
  type FlowItem,
  type FlowLeaf,
  type Island,
  type IslandAccent,
  type IslandGroup,
} from "../contract.ts";
import {
  bentoTracks,
  containsIsland,
  defaultGap,
  islandGroups,
  lastLeaf,
  packBento,
} from "./composition.ts";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface SectionFrame {
  name: string;
  rect: Rect;
}

export interface IslandFrame {
  id: string;
  island: Island;
  accent: IslandAccent;
  rect: Rect;
  header: number;
  members: readonly string[];
}

export interface Slack {
  blank: number;
  row: number;
}

export interface BoardLayout {
  nodes: ReadonlyMap<string, Rect>;
  sections: readonly SectionFrame[];
  islands: readonly IslandFrame[];
  slack: ReadonlyMap<string, Slack>;
  tracks: ReadonlyMap<string, number>;
  bounds: Rect;
}

export const islandPadding = 24;

export const islandHeaderGap = 18;

export function islandHeaderKey(id: string): string {
  return `island:${id}`;
}

export function estimatedIslandHeader(island: Island): number {
  return island.question === undefined ? 26 : 50;
}

export const nodeWidth = 300;

export const wideWidth = 620;

export const estimatedHeight = 150;

const columnGap = 20;

const rowGap = 20;

const padding = 20;

const header = 18;

const sectionGap = 72;

export const minZoom = 0.1;

export const maxZoom = 2.5;

export function orderedNodes(board: Board): CanvasNode[] {
  if (board.composition == null) return board.nodes;

  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  const ordered: CanvasNode[] = [];

  for (const leaf of flowLeaves(board.composition.root)) {
    const node = byId.get(leaf.node);

    if (node === undefined) continue;
    ordered.push(node);
    byId.delete(node.id);
  }

  return [...ordered, ...board.nodes.filter((node) => byId.has(node.id))];
}

export interface ReadingGroup {
  island?: IslandGroup;
  nodes: CanvasNode[];
}

export function readingGroups(board: Board): ReadingGroup[] {
  const islandByNode = new Map(
    board.composition == null
      ? []
      : islandGroups(board.composition.root).flatMap((island) =>
          flowLeaves(island).map((leaf) => [leaf.node, island] as const),
        ),
  );

  const groups: ReadingGroup[] = [];

  for (const node of orderedNodes(board)) {
    const island = islandByNode.get(node.id);
    const last = groups.at(-1);

    if (last !== undefined && last.island?.id === island?.id) last.nodes.push(node);
    else groups.push({ island, nodes: [node] });
  }

  return groups;
}

export function nodeEmphases(board: Board): ReadonlyMap<string, FlowLeaf["emphasis"]> {
  return new Map(
    board.composition == null
      ? []
      : flowLeaves(board.composition.root).map((leaf) => [leaf.node, leaf.emphasis]),
  );
}

function resolvedFlow(item: FlowItem, active: ReadonlyMap<string, CanvasNode>): FlowItem | null {
  if ("node" in item) return active.has(item.node) ? item : null;

  const children = item.children.flatMap((child) => {
    const resolved = resolvedFlow(child, active);

    return resolved === null ? [] : [resolved];
  });

  return children.length === 0 ? null : { ...item, children };
}

function layoutComposition(
  board: Board,
  composition: NonNullable<Board["composition"]>,
  heights: ReadonlyMap<string, number>,
): BoardLayout {
  const active = new Map(board.nodes.map((node) => [node.id, node]));
  const nodes = new Map<string, Rect>();
  const islands: IslandFrame[] = [];
  const slack = new Map<string, Slack>();
  const trackUnits = new Map<string, number>();
  let members: string[] | null = null;

  function note(child: FlowItem, height: number, row: number) {
    if (containsIsland(child)) return;
    const leaf = lastLeaf(child);

    if (leaf !== undefined && active.has(leaf.node) && row - height > 0)
      slack.set(leaf.node, { blank: Math.round(row - height), row: Math.round(row) });
  }

  function placeLeaf(item: FlowLeaf, x: number, y: number, width: number): number {
    const node = active.get(item.node);

    if (node === undefined) return 0;
    const height = heights.get(node.id) ?? estimatedHeight;
    members?.push(node.id);
    nodes.set(node.id, {
      x,
      y,
      ...node.position,
      width:
        node.width == null
          ? width
          : node.position === null
            ? Math.min(width, node.width)
            : node.width,
      height,
    });

    return height;
  }

  function row(
    children: readonly FlowItem[],
    x: number,
    top: number,
    width: number,
    requestedGap: number,
  ): number {
    const gap =
      children.length < 2 ? 0 : Math.min(requestedGap, width / (2 * (children.length - 1)));

    const available = width - gap * (children.length - 1);
    const weight = children.reduce((sum, child) => sum + (child.weight ?? 1), 0);
    let left = x;
    const placed: { child: FlowItem; height: number }[] = [];

    for (const child of children) {
      const childWidth = (available * (child.weight ?? 1)) / weight;
      placed.push({ child, height: place(child, left, top, childWidth) });
      left += childWidth + gap;
    }

    const height = Math.max(0, ...placed.map((entry) => entry.height));

    if (placed.length > 1) for (const entry of placed) note(entry.child, entry.height, height);

    return height;
  }

  function bento(item: FlowGroup, x: number, y: number, width: number, gap: number): number {
    const tracks = bentoTracks(width, item);
    const track = (width - gap * (tracks - 1)) / tracks;
    let top = y;

    for (const line of packBento(
      item.children.map((child) => child.span ?? 1),
      tracks,
    )) {
      const placed = line.slots.flatMap((slot) => {
        const child = item.children[slot.index];

        if (child !== undefined && "node" in child) trackUnits.set(child.node, track + gap);

        return child === undefined
          ? []
          : [
              {
                child,
                height: place(
                  child,
                  x + slot.track * (track + gap),
                  top,
                  slot.span * track + (slot.span - 1) * gap,
                ),
              },
            ];
      });

      const height = Math.max(0, ...placed.map((entry) => entry.height));

      if (placed.length > 1) for (const entry of placed) note(entry.child, entry.height, height);
      top += height + gap;
    }

    return Math.max(0, top - y - gap);
  }

  function group(item: FlowGroup, x: number, y: number, width: number): number {
    const gap = item.gap ?? defaultGap(item);

    if (item.flow === "row") return row(item.children, x, y, width, gap);

    if (item.flow === "bento") return bento(item, x, y, width, gap);

    if (item.flow === "column") {
      let top = y;

      for (const child of item.children) top += place(child, x, top, width) + gap;

      return Math.max(0, top - y - gap);
    }

    const columns = Math.max(1, Math.floor((width + gap) / ((item.minWidth ?? 280) + gap)));
    let top = y;

    for (let start = 0; start < item.children.length; start += columns)
      top += row(item.children.slice(start, start + columns), x, top, width, gap) + gap;

    return Math.max(0, top - y - gap);
  }

  function island(
    item: FlowGroup & { id: string; island: Island },
    x: number,
    y: number,
    width: number,
  ) {
    const header =
      (heights.get(islandHeaderKey(item.id)) ?? estimatedIslandHeader(item.island)) +
      islandHeaderGap;

    const inner = Math.max(0, width - islandPadding * 2);
    const collected: string[] = [];
    members = collected;
    const content = group(item, x + islandPadding, y + islandPadding + header, inner);
    members = null;
    const height = islandPadding * 2 + header + content;
    const offset = item.island.offset ?? { x: 0, y: 0 };

    for (const id of collected) {
      const rect = nodes.get(id);

      if (rect !== undefined && active.get(id)?.position === null)
        nodes.set(id, { ...rect, x: rect.x + offset.x, y: rect.y + offset.y });
    }

    islands.push({
      id: item.id,
      island: item.island,
      accent: item.island.accent ?? "neutral",
      rect: { x: x + offset.x, y: y + offset.y, width, height },
      header,
      members: collected,
    });

    return height;
  }

  function place(item: FlowItem, x: number, y: number, width: number): number {
    if ("node" in item) return placeLeaf(item, x, y, width);

    return isIsland(item) ? island(item, x, y, width) : group(item, x, y, width);
  }

  const root = resolvedFlow(composition.root, active);
  const height = root === null ? 0 : place(root, 0, 0, composition.width);
  const remaining = board.nodes.filter((node) => !nodes.has(node.id));
  let totalHeight = height;

  if (remaining.length > 0)
    totalHeight +=
      (height > 0 ? 24 : 0) +
      place(
        { flow: "wrap", minWidth: 560, children: remaining.map((node) => ({ node: node.id })) },
        0,
        height > 0 ? height + 24 : 0,
        composition.width,
      );

  const bounds = union([
    { x: 0, y: 0, width: composition.width, height: totalHeight },
    ...nodes.values(),
    ...islands.map((frame) => frame.rect),
  ]);

  return { nodes, sections: [], islands, slack, tracks: trackUnits, bounds };
}

export function layoutBoard(board: Board, heights: ReadonlyMap<string, number>): BoardLayout {
  if (board.composition != null) return layoutComposition(board, board.composition, heights);
  const nodes = new Map<string, Rect>();
  const sections: SectionFrame[] = [];

  let cursor = 0;

  for (const name of board.sections) {
    const members = board.nodes.filter((node) => node.section === name);
    const automatic = members.filter((node) => node.position === null);
    const columns = automatic.length > 3 ? 2 : 1;
    const bottoms = Array.from({ length: columns }, () => padding + header);

    for (const node of automatic) {
      const height = heights.get(node.id) ?? estimatedHeight;

      if (node.wide) {
        const top = Math.max(...bottoms);

        nodes.set(node.id, { x: cursor + padding, y: top, width: node.width ?? wideWidth, height });
        bottoms.fill(top + height + rowGap);

        continue;
      }

      const column = bottoms.indexOf(Math.min(...bottoms));

      nodes.set(node.id, {
        x: cursor + padding + column * (nodeWidth + columnGap),
        y: bottoms[column] ?? 0,
        width: node.width ?? nodeWidth,
        height,
      });
      bottoms[column] = (bottoms[column] ?? 0) + height + rowGap;
    }

    const columnsWidth = columns * nodeWidth + (columns - 1) * columnGap;

    const width =
      Math.max(columnsWidth, automatic.some((node) => node.wide) ? wideWidth : 0) + padding * 2;

    sections.push({
      name,
      rect: { x: cursor, y: 0, width, height: Math.max(...bottoms) - rowGap + padding },
    });
    cursor += width + sectionGap;
  }

  for (const node of board.nodes)
    if (node.position !== null)
      nodes.set(node.id, {
        ...node.position,
        width: node.width ?? (node.wide ? wideWidth : nodeWidth),
        height: heights.get(node.id) ?? estimatedHeight,
      });

  return {
    nodes,
    sections,
    islands: [],
    slack: new Map(),
    tracks: new Map(),
    bounds: union([...nodes.values(), ...sections.map((s) => s.rect)]),
  };
}

export function union(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function edgePath(edge: CanvasEdge, layout: BoardLayout) {
  const from = layout.nodes.get(edge.from);
  const to = layout.nodes.get(edge.to);

  if (from === undefined || to === undefined) return null;

  const forward = to.x >= from.x + from.width / 2;
  const startX = forward ? from.x + from.width : from.x;
  const endX = forward ? to.x : to.x + to.width;
  const startY = from.y + Math.min(from.height / 2, 60);
  const endY = to.y + Math.min(to.height / 2, 60);
  const bend = Math.max(40, Math.abs(endX - startX) / 2) * (forward ? 1 : -1);

  return {
    d: `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`,
    labelX: (startX + endX) / 2,
    labelY: (startY + endY) / 2 - 6,
  };
}

export function clampZoom(zoom: number): number {
  return Math.min(maxZoom, Math.max(minZoom, zoom));
}

export interface MinimapProjection {
  x: number;
  y: number;
  scale: number;
}

export function minimapProjection(
  bounds: Rect,
  size: Pick<Rect, "width" | "height">,
  inset: number,
): MinimapProjection {
  const scale = Math.min(
    (size.width - inset * 2) / Math.max(bounds.width, 1),
    (size.height - inset * 2) / Math.max(bounds.height, 1),
  );

  return {
    scale,
    x: (size.width - bounds.width * scale) / 2 - bounds.x * scale,
    y: (size.height - bounds.height * scale) / 2 - bounds.y * scale,
  };
}

export function minimapWorldPoint(
  projection: MinimapProjection,
  bounds: Rect,
  point: Pick<Rect, "x" | "y">,
): Pick<Rect, "x" | "y"> {
  return {
    x: Math.min(
      bounds.x + bounds.width,
      Math.max(bounds.x, (point.x - projection.x) / projection.scale),
    ),
    y: Math.min(
      bounds.y + bounds.height,
      Math.max(bounds.y, (point.y - projection.y) / projection.scale),
    ),
  };
}

export function zoomAround(viewport: Viewport, factor: number, x: number, y: number): Viewport {
  const zoom = clampZoom(viewport.zoom * factor);
  const scale = zoom / viewport.zoom;

  return { zoom, x: x - (x - viewport.x) * scale, y: y - (y - viewport.y) * scale };
}

export function fitViewport(bounds: Rect, width: number, height: number, margin = 40): Viewport {
  if (bounds.width === 0 || width === 0) return { x: margin, y: margin, zoom: 1 };

  const zoom = clampZoom(
    Math.min(1, (width - margin * 2) / bounds.width, (height - margin * 2) / bounds.height),
  );

  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: Math.max(margin, (height - bounds.height * zoom) / 2) - bounds.y * zoom,
  };
}

export function focusViewport(rect: Rect, width: number, height: number, zoom: number): Viewport {
  return {
    zoom,
    x: width / 2 - (rect.x + rect.width / 2) * zoom,
    y: height / 2 - (rect.y + Math.min(rect.height, height / zoom - 80) / 2) * zoom,
  };
}

function wheelDeltaScale(deltaMode: number): number {
  return deltaMode === 1 ? 16 : deltaMode === 2 ? 800 : 1;
}

export function wheelZoomFactor(deltaY: number, deltaMode: number, pinch: boolean): number {
  const sensitivity = pinch ? 0.01 : 0.0018;

  return Math.min(2, Math.max(0.5, Math.exp(-deltaY * wheelDeltaScale(deltaMode) * sensitivity)));
}

export function wheelPanDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  horizontal: boolean,
) {
  const scale = wheelDeltaScale(deltaMode);

  if (horizontal && deltaX === 0) return { x: -deltaY * scale, y: 0 };

  return { x: -deltaX * scale, y: -deltaY * scale };
}

export type NodeChange = "new" | "updated" | null;

export function nodeChange(
  node: { createdRevision: number; updatedRevision: number },
  seenRevision: number,
): NodeChange {
  if (node.createdRevision > seenRevision) return "new";

  if (node.updatedRevision > seenRevision) return "updated";

  return null;
}

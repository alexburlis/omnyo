import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Board, CanvasNode } from "../contract";
import type { SourceState } from "../source-contract";
import { updateIsland } from "../lib/composition";
import {
  edgePath,
  islandHeaderKey,
  layoutBoard,
  nodeChange,
  nodeEmphases,
  orderedNodes,
  type IslandFrame,
} from "../lib/layout";
import { rememberHeights, rememberedHeights, type MeasuredHeight } from "../lib/measured-heights";
import { frameCount, measureKey } from "../lib/node-rendering";
import { NodeCard, type NodeActions, type NodeWorkspace } from "./node";

export const measurementBudget = { frames: 6, total: 16 };

type LayerDrag = { id: string; x: number; y: number } | null;

export function useBoardLayer({
  board,
  dragging = null,
  islandDrag = null,
  origin = { x: 0, y: 0 },
}: {
  board: Board;
  dragging?: LayerDrag;
  islandDrag?: LayerDrag;
  origin?: { x: number; y: number };
}) {
  const [stored, setStored] = useState(() => ({
    boardId: board.threadId,
    heights: rememberedHeights(board.threadId),
  }));

  const measured =
    stored.boardId === board.threadId ? stored.heights : rememberedHeights(board.threadId);

  if (stored.boardId !== board.threadId) setStored({ boardId: board.threadId, heights: measured });

  useEffect(() => rememberHeights(stored.boardId, stored.heights), [stored]);

  const heights = useMemo(
    () => new Map([...measured].map(([id, entry]) => [id, entry.height])),
    [measured],
  );

  const ordered = useMemo(() => orderedNodes(board), [board]);
  const emphases = useMemo(() => nodeEmphases(board), [board]);

  const localLayout = useMemo(() => {
    const arranged =
      islandDrag === null || !board.composition
        ? board
        : {
            ...board,
            composition: updateIsland(board.composition, islandDrag.id, {
              offset: { x: islandDrag.x, y: islandDrag.y },
            }),
          };

    const base = layoutBoard(arranged, heights);

    if (dragging === null) return base;

    const nodes = new Map(base.nodes);
    const rect = nodes.get(dragging.id);

    if (rect !== undefined) nodes.set(dragging.id, { ...rect, x: dragging.x, y: dragging.y });

    return { ...base, nodes };
  }, [board, heights, dragging, islandDrag]);

  const layout = useMemo(() => {
    if (origin.x === 0 && origin.y === 0) return localLayout;

    const translate = <T extends { x: number; y: number }>(rect: T): T => ({
      ...rect,
      x: rect.x + origin.x,
      y: rect.y + origin.y,
    });

    return {
      ...localLayout,
      nodes: new Map([...localLayout.nodes].map(([id, rect]) => [id, translate(rect)])),
      islands: localLayout.islands.map((frame) => ({ ...frame, rect: translate(frame.rect) })),
      sections: localLayout.sections.map((section) => ({
        ...section,
        rect: translate(section.rect),
      })),
      bounds: translate(localLayout.bounds),
    };
  }, [localLayout, origin.x, origin.y]);

  const nodeIslands = useMemo(
    () =>
      new Map(layout.islands.flatMap((frame) => frame.members.map((id) => [id, frame] as const))),
    [layout.islands],
  );

  const measure = useCallback(
    (id: string, height: number, key: string) => {
      if (height <= 0) return;
      setStored((current) => {
        if (current.boardId !== board.threadId) return current;
        const previous = current.heights.get(id);

        if (previous?.height === height && previous.key === key) return current;

        const next = new Map<string, MeasuredHeight>(current.heights);

        next.set(id, { height, key });

        return { boardId: current.boardId, heights: next };
      });
    },
    [board.threadId],
  );

  const measureHeader = useCallback(
    (id: string, height: number) => measure(id, height, ""),
    [measure],
  );

  const [realization, setRealization] = useState<ReadonlyMap<string, boolean>>(new Map());

  const observe = useCallback(
    (id: string, realized: boolean) =>
      setRealization((current) =>
        current.get(id) === realized ? current : new Map(current).set(id, realized),
      ),
    [],
  );

  return {
    layout,
    localLayout,
    origin,
    ordered,
    emphases,
    nodeIslands,
    measured,
    measure,
    measureHeader,
    realization,
    observe,
  };
}

type MeasurementLayer = Pick<
  ReturnType<typeof useBoardLayer>,
  "ordered" | "layout" | "emphases" | "nodeIslands" | "measured" | "realization"
>;

export interface MeasurementCandidate {
  id: string;
  cost: number;
}

function measurementCost(node: CanvasNode, threadId: string | undefined): number {
  const frames = frameCount(node, threadId);

  if (frames > 0) return frames;

  return !node.binding && (node.kind === "image" || node.kind === "video") && node.assetId !== null
    ? 1
    : 0;
}

export function measurementKeys(
  layer: MeasurementLayer,
  sources: readonly SourceState[] | null,
): ReadonlyMap<string, string | null> {
  return new Map(
    layer.ordered.map((node) => {
      const rect = layer.layout.nodes.get(node.id);

      return [
        node.id,
        rect === undefined
          ? null
          : measureKey(
              node,
              rect.width,
              layer.emphases.get(node.id),
              layer.nodeIslands.get(node.id)?.id,
              sources,
            ),
      ] as const;
    }),
  );
}

export function measurementCandidates(
  layer: MeasurementLayer,
  keys: ReadonlyMap<string, string | null>,
  threadId: string | undefined,
): MeasurementCandidate[] {
  return layer.ordered.flatMap((node) => {
    const key = keys.get(node.id);
    const cost = measurementCost(node, threadId);

    if (
      key == null ||
      layer.measured.get(node.id)?.key === key ||
      (node.conversation && threadId) ||
      layer.realization.get(node.id) !== false
    )
      return [];

    return [{ id: node.id, cost }];
  });
}

export function chooseMeasurements<Candidate extends { cost: number }>(
  candidates: readonly Candidate[],
): Candidate[] {
  const chosen: Candidate[] = [];
  let frames = measurementBudget.frames;

  for (const candidate of candidates) {
    if (chosen.length >= measurementBudget.total) break;

    if (candidate.cost > frames) continue;
    frames -= candidate.cost;
    chosen.push(candidate);
  }

  return chosen;
}

export interface BoardLayerProps {
  board: Board;
  baseline: number;
  workspace: NodeWorkspace;
  actions: NodeActions;
  selected: string | null;
  selectedIsland?: string | null;
  sources?: readonly SourceState[];
  onWidthChange?(id: string, width: number, trackUnit?: number): void;
  onSelect(id: string | null): void;
  onSelectIsland?(id: string | null): void;
  layer: ReturnType<typeof useBoardLayer>;
  zoom: number;
  showContentAtAnyZoom?: boolean;
  eager?: boolean;
  sourcesLoaded: boolean;
  onNodePointerDown(event: ReactPointerEvent<HTMLDivElement>, id: string): void;
  onIslandPointerDown(event: ReactPointerEvent<HTMLElement>, frame: IslandFrame): void;
}

export function BoardLayer({
  board,
  baseline,
  workspace,
  actions,
  selected,
  selectedIsland = null,
  sources = [],
  onWidthChange,
  onSelect,
  onSelectIsland,
  layer,
  zoom,
  showContentAtAnyZoom,
  eager = false,
  sourcesLoaded,
  onNodePointerDown,
  onIslandPointerDown,
}: BoardLayerProps) {
  const { layout, ordered, emphases, nodeIslands } = layer;
  const keys = measurementKeys(layer, sourcesLoaded ? sources : null);

  const pending = new Set(
    eager
      ? []
      : chooseMeasurements(measurementCandidates(layer, keys, board.threadId)).map(
          (candidate) => candidate.id,
        ),
  );

  const edges = board.edges
    .map((edge) => ({ edge, path: edgePath(edge, layout) }))
    .filter((entry) => entry.path !== null);

  return (
    <>
      {layout.sections.map((section) => (
        <div
          key={section.name}
          className="cnv-section"
          style={{
            left: section.rect.x,
            top: section.rect.y,
            width: section.rect.width,
            height: section.rect.height,
          }}
        >
          <span className="cnv-section-label">{section.name}</span>
        </div>
      ))}
      {layout.islands.map((frame) => (
        <IslandSurface
          key={frame.id}
          frame={frame}
          selected={selectedIsland === frame.id}
          onMeasure={layer.measureHeader}
          onHeadPointerDown={onIslandPointerDown}
          onActivate={(entry) => onSelectIsland?.(entry.id)}
        />
      ))}
      <svg className="cnv-edges" width={1} height={1} aria-hidden="true">
        {edges.map(({ edge, path }) =>
          path === null ? null : (
            <g key={`${edge.from}-${edge.to}`}>
              <path d={path.d} />
              {edge.label === null ? null : (
                <text x={path.labelX} y={path.labelY} textAnchor="middle">
                  {edge.label}
                </text>
              )}
            </g>
          ),
        )}
      </svg>
      {ordered.map((node) => {
        const rect = layout.nodes.get(node.id);
        const frame = nodeIslands.get(node.id);

        if (rect === undefined) return null;

        const key = keys.get(node.id) ?? null;

        const copy = pending.has(node.id) ? (
          <NodeCard
            key="measure"
            node={node}
            threadId={board.threadId}
            accent={frame?.accent}
            island={frame?.id}
            trackUnit={layout.tracks.get(node.id)}
            emphasis={emphases.get(node.id)}
            canvasNavigation
            zoom={zoom}
            sources={sources}
            change={nodeChange(node, baseline)}
            selected={false}
            workspace={workspace}
            actions={actions}
            style={{ left: rect.x, top: rect.y, width: rect.width }}
            eager
            measuring
            measureKey={key}
            onSelect={() => {}}
            onMeasure={layer.measure}
          />
        ) : null;

        return (
          <Fragment key={node.id}>
            <NodeCard
              key="card"
              node={node}
              threadId={board.threadId}
              accent={frame?.accent}
              island={frame?.id}
              slack={layout.slack.get(node.id)}
              trackUnit={layout.tracks.get(node.id)}
              estimatedHeight={rect.height}
              remembered={layer.measured.has(node.id)}
              eager={eager}
              emphasis={emphases.get(node.id)}
              canvasNavigation
              zoom={zoom}
              showContentAtAnyZoom={showContentAtAnyZoom}
              sources={sources}
              onWidthChange={onWidthChange}
              change={nodeChange(node, baseline)}
              selected={selected === node.id}
              workspace={workspace}
              actions={actions}
              style={{ left: rect.x, top: rect.y, width: rect.width }}
              measureKey={key}
              onSelect={onSelect}
              onHeadPointerDown={onNodePointerDown}
              onMeasure={layer.measure}
              onRealization={layer.observe}
            />
            {copy}
          </Fragment>
        );
      })}
    </>
  );
}

function IslandSurface({
  frame,
  selected,
  onMeasure,
  onHeadPointerDown,
  onActivate,
}: {
  frame: IslandFrame;
  selected: boolean;
  onMeasure(id: string, height: number): void;
  onHeadPointerDown(event: ReactPointerEvent<HTMLElement>, frame: IslandFrame): void;
  onActivate(frame: IslandFrame): void;
}) {
  const head = useRef<HTMLDivElement>(null);
  const key = islandHeaderKey(frame.id);

  useEffect(() => {
    const target = head.current;

    if (target === null) return;

    const observer = new ResizeObserver((entries) => {
      const size = entries[0]?.borderBoxSize[0];

      if (size !== undefined && target.isConnected) onMeasure(key, Math.ceil(size.blockSize));
    });

    observer.observe(target);

    return () => observer.disconnect();
  }, [key, onMeasure]);

  return (
    <section
      className="cnv-island"
      data-island-id={frame.id}
      data-accent={frame.accent}
      data-surface={frame.island.surface ?? "soft"}
      data-selected={selected}
      data-moved={frame.island.offset !== undefined}
      aria-label={`Island: ${frame.island.title}`}
      style={{
        left: frame.rect.x,
        top: frame.rect.y,
        width: frame.rect.width,
        height: frame.rect.height,
      }}
    >
      <div
        ref={head}
        className="cnv-island-head"
        data-question={frame.island.question !== undefined}
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`${frame.island.title} island`}
        onPointerDown={(event) => onHeadPointerDown(event, frame)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onActivate(frame);
        }}
      >
        <span className="cnv-island-pip" aria-hidden="true" />
        <span className="cnv-island-title">{frame.island.title}</span>
        <span className="cnv-island-grip" aria-hidden="true">
          ⠿
        </span>
        {frame.island.question === undefined ? null : (
          <span className="cnv-island-question" role="heading" aria-level={2}>
            {frame.island.question}
          </span>
        )}
      </div>
    </section>
  );
}

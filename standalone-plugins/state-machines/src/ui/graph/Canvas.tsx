import { experimental_Icon as Icon } from "@omnyo/plugin-sdk/app";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { DraftState, GraphDefinition, InstanceView, StateKind } from "../data/contract.js";
import type { Selection } from "../routes.js";
import {
  bounds,
  CANVAS_PADDING,
  INITIAL_RADIUS,
  initialPoint,
  nodeRects,
  type Point,
  type Rect,
} from "./geometry.js";
import {
  edgeLabel,
  KIND_ICON,
  KIND_LABEL,
  KIND_SHORTCUT,
  STATE_KINDS,
  stateSubtitle,
} from "./labels.js";
import { arrowHead, pathData, type RoutedEdge, routeEdges } from "./route.js";
import { nearestInDirection, outlineOrder } from "./spatial-nav.js";
import { findByData } from "./dom.js";
import { nodeStatus, type NodeStatus } from "./status-style.js";
import {
  fitViewport,
  panelOcclusion,
  readableViewport,
  revealRect,
  type Viewport,
  wheelZoomFactor,
  zoomAround,
} from "./viewport.js";

export type CanvasMode = "inspect" | "edit" | "readonly" | "preview";

export type DiffMark = "added" | "removed" | "changed";

export interface LiveOverlay {
  instance: InstanceView;
  now: number;
  frozen: boolean;
}

export interface CanvasEditHandlers {
  onMove(positions: ReadonlyMap<string, Point>): void;
  onConnect(from: string, to: string): void;
  onDelete(selection: Exclude<Selection, null>, extra: readonly string[]): void;
  onAddState(kind: StateKind, at: Point): void;
  onDuplicate(stateId: string): void;
  onRename(stateId: string): void;
  onUndo(): void;
  onRedo(): void;
}

export interface CanvasProps {
  definition: GraphDefinition;
  mode: CanvasMode;
  label: string;
  selection: Selection;
  onSelect(selection: Selection): void;
  onActivate?(selection: Exclude<Selection, null>): void;
  live?: LiveOverlay;
  diff?: ReadonlyMap<string, DiffMark>;
  problems?: ReadonlyMap<string, "error" | "warning" | "info">;
  edit?: CanvasEditHandlers;
  followCurrent?: boolean;
  occludeRight?: boolean;
  multiSelection?: ReadonlySet<string>;
  onMultiSelectionChange?(ids: ReadonlySet<string>): void;
}

function edgeVisual(
  id: string,
  from: string,
  live: LiveOverlay | undefined,
): "default" | "last" | "candidate" | "dim" {
  if (live === undefined) return "default";

  if (live.instance.lastTransition?.transitionId === id) return "last";

  if (from === live.instance.stateId) return "candidate";

  return "dim";
}

function nodeAccessibleName(
  state: DraftState,
  status: NodeStatus | null,
  outgoing: number,
): string {
  const parts = [
    `${state.title}, ${KIND_LABEL[state.kind].toLowerCase()}, ${stateSubtitle(state)}.`,
  ];

  if (status?.isCurrent === true) parts.push(`Current, ${status.meta}.`);

  parts.push(`${outgoing} transition${outgoing === 1 ? "" : "s"} out.`);

  return parts.join(" ");
}

export function Canvas(props: CanvasProps) {
  const { definition, mode, live, edit, selection, onSelect } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
  const [size, setSize] = useState({ width: 800, height: 480 });
  const [drag, setDrag] = useState<{ ids: string[]; dx: number; dy: number } | null>(null);

  const [connect, setConnect] = useState<{
    from: string;
    pointer: Point | null;
    target: string | null;
  } | null>(null);

  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusedEdge, setFocusedEdge] = useState<string | null>(null);
  const [addMenu, setAddMenu] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const lastUserPan = useRef(0);
  const userAdjusted = useRef(false);
  const interactive = mode !== "preview";
  const editable = mode === "edit" && edit !== undefined;
  const multi = props.multiSelection ?? new Set<string>();

  const baseRects = useMemo(() => nodeRects(definition, live !== undefined), [definition, live]);

  const rects = useMemo(() => {
    if (drag === null) return baseRects;

    const moved = new Map(baseRects);

    for (const id of drag.ids) {
      const rect = baseRects.get(id);

      if (rect !== undefined) moved.set(id, { ...rect, x: rect.x + drag.dx, y: rect.y + drag.dy });
    }

    return moved;
  }, [baseRects, drag]);

  const edges = useMemo(
    () =>
      definition.transitions.flatMap((edge) =>
        edge.to === null
          ? []
          : [
              {
                id: edge.id,
                from: edge.from,
                to: edge.to,
                label: edgeLabel(edge, definition.layout.edgeLabels),
                sourceSide: definition.layout.edges[edge.id]?.sourceSide ?? null,
                targetSide: definition.layout.edges[edge.id]?.targetSide ?? null,
                waypoints: definition.layout.edges[edge.id]?.waypoints ?? [],
                labelAt: definition.layout.edges[edge.id]?.labelAt ?? null,
              },
            ],
      ),
    [definition.layout.edgeLabels, definition.layout.edges, definition.transitions],
  );

  const dragging = drag !== null;

  const routed = useMemo(
    () => routeEdges(edges, rects, { fast: dragging }),
    [dragging, edges, rects],
  );

  const drawOrder = useMemo(() => {
    const weight = (edge: RoutedEdge): number => {
      if (selection?.kind === "transition" && selection.id === edge.id) return 4;

      const source = definition.transitions.find((candidate) => candidate.id === edge.id);
      const visual = edgeVisual(edge.id, source?.from ?? "", live);

      return visual === "last" ? 3 : visual === "candidate" ? 2 : visual === "dim" ? 0 : 1;
    };

    return [...routed].sort((a, b) => weight(a) - weight(b));
  }, [definition.transitions, live, routed, selection]);

  const initial = initialPoint(definition, rects);

  const world = useMemo(
    () => bounds(rects.values(), initial === null ? [] : [initial]),
    [initial, rects],
  );

  const order = useMemo(
    () =>
      outlineOrder(
        definition.initialStateId,
        definition.states.map((state) => state.id),
        definition.transitions,
      ),
    [definition.initialStateId, definition.states, definition.transitions],
  );

  const statuses = useMemo(() => {
    const map = new Map<string, NodeStatus>();

    if (live !== undefined)
      for (const state of definition.states)
        map.set(state.id, nodeStatus(live.instance, state.id, live.now, live.frozen));

    return map;
  }, [definition.states, live]);

  useLayoutEffect(() => {
    const element = containerRef.current;

    if (element === null) return;

    const measure = () => {
      const rect = element.getBoundingClientRect();

      if (rect.width > 0 && rect.height > 0) setSize({ width: rect.width, height: rect.height });
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  const fit = useCallback(() => {
    setViewport(fitViewport(world, size, CANVAS_PADDING));
  }, [size, world]);

  const initialView = useCallback(() => {
    setViewport(readableViewport(world, size, CANVAS_PADDING));
  }, [size, world]);

  const fitKey = `${definition.states.length}:${size.width}x${size.height}`;

  const initialRef = useRef(initialView);

  initialRef.current = initialView;

  useEffect(() => {
    if (!userAdjusted.current) initialRef.current();
  }, [fitKey]);

  const currentId = live?.instance.stateId ?? null;
  const occluded = props.occludeRight === true;

  const visibleArea = useMemo(
    () => ({
      width: Math.max(160, size.width - (occluded ? panelOcclusion(size.width) : 0)),
      height: size.height,
    }),
    [occluded, size],
  );

  useEffect(() => {
    if (props.followCurrent !== true || currentId === null) return;

    if (Date.now() - lastUserPan.current < 10_000) return;

    const rect = baseRects.get(currentId);

    if (rect === undefined) return;

    setViewport((previous) => revealRect(previous, rect, visibleArea));
  }, [baseRects, currentId, props.followCurrent, visibleArea]);

  const rectsRef = useRef(baseRects);

  rectsRef.current = baseRects;

  const routedRef = useRef(routed);

  routedRef.current = routed;

  const selectedStateId = selection?.kind === "state" ? selection.id : null;
  const selectedTransitionId = selection?.kind === "transition" ? selection.id : null;

  useEffect(() => {
    const rect =
      selectedTransitionId !== null
        ? routedRef.current.find((edge) => edge.id === selectedTransitionId)?.labelBox
        : rectsRef.current.get(selectedStateId ?? (occluded ? (currentId ?? "") : ""));

    if (rect === undefined) return;

    setViewport((previous) => revealRect(previous, rect, visibleArea));
  }, [currentId, occluded, selectedStateId, selectedTransitionId, visibleArea]);

  const toWorld = useCallback(
    (clientX: number, clientY: number): Point => {
      const element = containerRef.current;
      const rect = element?.getBoundingClientRect();
      const left = rect?.left ?? 0;
      const top = rect?.top ?? 0;

      return {
        x: (clientX - left - viewport.x) / viewport.zoom,
        y: (clientY - top - viewport.y) / viewport.zoom,
      };
    },
    [viewport],
  );

  const zoomBy = useCallback(
    (factor: number, around?: Point) => {
      userAdjusted.current = true;
      setViewport((previous) =>
        zoomAround(previous, factor, around ?? { x: size.width / 2, y: size.height / 2 }),
      );
    },
    [size],
  );

  const pendingWheel = useRef<{ factor: number; pivot: Point } | null>(null);
  const wheelFrame = useRef<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;

    if (element === null || !interactive) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      lastUserPan.current = Date.now();
      userAdjusted.current = true;

      const rect = element.getBoundingClientRect();
      const pivot = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const factor = wheelZoomFactor(event);
      const pending = pendingWheel.current;

      pendingWheel.current = { factor: (pending?.factor ?? 1) * factor, pivot };

      if (wheelFrame.current !== null) return;

      wheelFrame.current = requestAnimationFrame(() => {
        wheelFrame.current = null;

        const next = pendingWheel.current;

        pendingWheel.current = null;

        if (next !== null) setViewport((previous) => zoomAround(previous, next.factor, next.pivot));
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      element.removeEventListener("wheel", onWheel);

      if (wheelFrame.current !== null) cancelAnimationFrame(wheelFrame.current);

      wheelFrame.current = null;
      pendingWheel.current = null;
    };
  }, [interactive]);

  const panState = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origin: Viewport;
  } | null>(null);

  const onBackgroundPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || event.button !== 0) return;

    if (
      event.target !== event.currentTarget &&
      !(event.target instanceof SVGElement && event.target.dataset.background === "true")
    )
      return;

    panState.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: viewport,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onBackgroundPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panState.current;

    if (pan !== null && pan.pointerId === event.pointerId) {
      lastUserPan.current = Date.now();
      userAdjusted.current = true;
      setViewport({
        ...pan.origin,
        x: pan.origin.x + event.clientX - pan.startX,
        y: pan.origin.y + event.clientY - pan.startY,
      });

      return;
    }

    if (connect !== null) {
      const point = toWorld(event.clientX, event.clientY);

      const hit = [...rects.entries()].find(
        ([, rect]) =>
          point.x >= rect.x &&
          point.x <= rect.x + rect.width &&
          point.y >= rect.y &&
          point.y <= rect.y + rect.height,
      );

      setConnect({ ...connect, pointer: point, target: hit?.[0] ?? null });
    }
  };

  const onBackgroundPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panState.current;

    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = Math.abs(event.clientX - pan.startX) + Math.abs(event.clientY - pan.startY);

      panState.current = null;

      if (moved < 4) {
        onSelect(null);
        props.onMultiSelectionChange?.(new Set());
      }

      return;
    }

    if (connect?.pointer != null) {
      if (connect.target !== null && edit !== undefined)
        edit.onConnect(connect.from, connect.target);

      setConnect(null);
    }
  };

  const nodeDrag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    ids: string[];
    moved: boolean;
  } | null>(null);

  const onNodePointerDown = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    if (!interactive || event.button !== 0) return;

    event.stopPropagation();

    if (!editable) return;

    const ids = multi.has(id) && multi.size > 1 ? [...multi] : [id];

    nodeDrag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      ids,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onNodePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const current = nodeDrag.current;

    if (current === null || current.pointerId !== event.pointerId) return;

    const dx = (event.clientX - current.startX) / viewport.zoom;
    const dy = (event.clientY - current.startY) / viewport.zoom;

    if (!current.moved && Math.abs(dx) + Math.abs(dy) < 3) return;

    current.moved = true;
    setDrag({ ids: current.ids, dx, dy });
  };

  const onNodePointerUp = (event: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    const current = nodeDrag.current;

    nodeDrag.current = null;

    if (current?.moved === true && drag !== null && edit !== undefined) {
      const positions = new Map<string, Point>();

      for (const dragged of drag.ids) {
        const rect = baseRects.get(dragged);

        if (rect !== undefined)
          positions.set(dragged, { x: rect.x + drag.dx, y: rect.y + drag.dy });
      }

      setDrag(null);
      edit.onMove(positions);

      return;
    }

    setDrag(null);
    selectNode(id, event.shiftKey);
  };

  const selectNode = (id: string, additive: boolean) => {
    setFocusedId(id);

    if (additive && editable) {
      const next = new Set(multi);

      if (selection?.kind === "state") next.add(selection.id);

      if (next.has(id)) next.delete(id);
      else next.add(id);

      props.onMultiSelectionChange?.(next);

      return;
    }

    props.onMultiSelectionChange?.(new Set());
    onSelect({ kind: "state", id });
  };

  const startConnect = (event: ReactPointerEvent<HTMLSpanElement>, from: string) => {
    event.stopPropagation();
    event.preventDefault();
    setConnect({ from, pointer: toWorld(event.clientX, event.clientY), target: null });
    containerRef.current?.setPointerCapture(event.pointerId);
  };

  const focusNode = (id: string | null) => {
    if (id === null) return;

    setFocusedId(id);
    setFocusedEdge(null);
    requestAnimationFrame(() => findByData(containerRef.current, "nodeId", id)?.focus());
  };

  const focusEdge = (id: string) => {
    setFocusedEdge(id);
    requestAnimationFrame(() => findByData(containerRef.current, "edgeId", id)?.focus());
  };

  const pendingAdd = useRef(false);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return;

    const target = event.target;

    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    )
      return;

    const meta = event.metaKey || event.ctrlKey;
    const key = event.key;
    const nodeId = focusedId ?? selection?.id ?? order[0] ?? null;

    if (pendingAdd.current && editable) {
      pendingAdd.current = false;

      const kind = STATE_KINDS.find((candidate) => KIND_SHORTCUT[candidate] === key.toLowerCase());

      if (kind !== undefined) {
        event.preventDefault();
        edit.onAddState(kind, {
          x: (size.width / 2 - viewport.x) / viewport.zoom,
          y: (size.height / 2 - viewport.y) / viewport.zoom,
        });
      }

      return;
    }

    if (connect !== null && connect.pointer === null) {
      if (key === "Escape") {
        event.preventDefault();
        setConnect(null);

        return;
      }

      if (key === "Enter" && connect.target !== null && edit !== undefined) {
        event.preventDefault();
        edit.onConnect(connect.from, connect.target);
        setConnect(null);

        return;
      }

      const direction =
        key === "ArrowUp"
          ? "up"
          : key === "ArrowDown"
            ? "down"
            : key === "ArrowLeft"
              ? "left"
              : key === "ArrowRight"
                ? "right"
                : null;

      if (direction !== null) {
        event.preventDefault();

        const next = nearestInDirection(connect.target ?? connect.from, direction, rects);

        if (next !== null) setConnect({ ...connect, target: next });
      }

      return;
    }

    if (focusedEdge !== null && (key === "Escape" || key === "e" || key === "E")) {
      const edge = definition.transitions.find((candidate) => candidate.id === focusedEdge);

      if (key === "Escape" && edge !== undefined) {
        event.preventDefault();
        focusNode(edge.from);

        return;
      }
    }

    if (key.startsWith("Arrow") && !meta) {
      const direction =
        key === "ArrowUp"
          ? "up"
          : key === "ArrowDown"
            ? "down"
            : key === "ArrowLeft"
              ? "left"
              : "right";

      if (event.shiftKey && editable && nodeId !== null) {
        event.preventDefault();

        const distance = event.altKey ? 1 : 8;
        const rect = baseRects.get(nodeId);

        if (rect === undefined) return;

        const dx = direction === "left" ? -distance : direction === "right" ? distance : 0;
        const dy = direction === "up" ? -distance : direction === "down" ? distance : 0;

        edit.onMove(new Map([[nodeId, { x: rect.x + dx, y: rect.y + dy }]]));

        return;
      }

      if (nodeId === null) return;

      event.preventDefault();
      focusNode(nearestInDirection(nodeId, direction, rects) ?? nodeId);

      return;
    }

    if (key === "Home" || key === "End") {
      event.preventDefault();
      focusNode((key === "Home" ? order[0] : order.at(-1)) ?? null);

      return;
    }

    if ((key === "j" || key === "J") && currentId !== null && !meta) {
      event.preventDefault();
      focusNode(currentId);

      return;
    }

    if ((key === "e" || key === "E") && nodeId !== null && !meta) {
      event.preventDefault();

      const list = definition.transitions
        .filter((edge) => (event.shiftKey ? edge.to === nodeId : edge.from === nodeId))
        .sort((a, b) => a.priority - b.priority);

      if (list.length === 0) return;

      const index = focusedEdge === null ? -1 : list.findIndex((edge) => edge.id === focusedEdge);
      const next = list[(index + 1) % list.length];

      if (next !== undefined) focusEdge(next.id);

      return;
    }

    if (key === "f" || key === "F") {
      if (meta) return;

      event.preventDefault();
      fit();

      return;
    }

    if (key === "+" || key === "=") {
      event.preventDefault();
      zoomBy(1.2);

      return;
    }

    if (key === "-") {
      event.preventDefault();
      zoomBy(1 / 1.2);

      return;
    }

    if (key === "0" && !meta) {
      event.preventDefault();
      zoomBy(1 / viewport.zoom);

      return;
    }

    if (key === "?") {
      event.preventDefault();
      setShowHelp((value) => !value);

      return;
    }

    if (!editable) return;

    if (meta && (key === "z" || key === "Z")) {
      event.preventDefault();

      if (event.shiftKey) edit.onRedo();
      else edit.onUndo();

      return;
    }

    if (meta && (key === "d" || key === "D") && nodeId !== null) {
      event.preventDefault();
      edit.onDuplicate(nodeId);

      return;
    }

    if ((key === "Delete" || key === "Backspace") && selection !== null) {
      event.preventDefault();
      edit.onDelete(selection, [...multi]);

      return;
    }

    if ((key === "n" || key === "N") && !meta) {
      event.preventDefault();
      pendingAdd.current = true;

      return;
    }

    if ((key === "c" || key === "C") && !meta && nodeId !== null) {
      event.preventDefault();
      setConnect({ from: nodeId, pointer: null, target: null });

      return;
    }

    if (key === "F2" && nodeId !== null) {
      event.preventDefault();
      edit.onRename(nodeId);
    }
  };

  const outgoingCount = useMemo(() => {
    const counts = new Map<string, number>();

    for (const edge of definition.transitions)
      counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);

    return counts;
  }, [definition.transitions]);

  const rovingId =
    focusedId !== null && rects.has(focusedId)
      ? focusedId
      : selection?.kind === "state" && rects.has(selection.id)
        ? selection.id
        : (currentId ?? order[0] ?? null);

  const statusSummary =
    live === undefined
      ? ""
      : `, current: ${definition.states.find((state) => state.id === currentId)?.title ?? currentId ?? "none"}, ${nodeStatus(live.instance, currentId ?? "", live.now, live.frozen).meta}`;

  const canvasLabel = `${props.label} graph, ${definition.states.length} state${definition.states.length === 1 ? "" : "s"}${statusSummary}`;
  const connectLine = connect !== null ? connectPreview(connect, rects) : null;

  return (
    <div
      className={`stm-canvas stm-canvas--${mode}${live !== undefined && live.instance.lifecycle === "paused" ? " stm-canvas--paused" : ""}`}
    >
      <div
        ref={containerRef}
        className="stm-canvas-viewport"
        role="group"
        aria-roledescription="state graph"
        aria-label={canvasLabel}
        aria-hidden={mode === "preview" ? true : undefined}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onBackgroundPointerMove}
        onPointerUp={onBackgroundPointerUp}
        onKeyDown={onKeyDown}
      >
        <div
          className="stm-canvas-world"
          style={{
            transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          }}
        >
          <svg
            className="stm-edges"
            width={world.x + world.width + 400}
            height={world.y + world.height + 400}
            aria-hidden="true"
            style={{ left: 0, top: 0 }}
          >
            <rect
              data-background="true"
              x={world.x - 4000}
              y={world.y - 4000}
              width={world.width + 8000}
              height={world.height + 8000}
              fill="transparent"
            />
            {initial !== null && definition.initialStateId !== null ? (
              <InitialEdge point={initial} target={rects.get(definition.initialStateId)} />
            ) : null}
            {drawOrder.map((edge) => {
              const source = definition.transitions.find((candidate) => candidate.id === edge.id);

              if (source === undefined) return null;

              const visual = edgeVisual(edge.id, source.from, live);
              const diffMark = props.diff?.get(`tr:${edge.id}`);
              const problem = props.problems?.get(`tr:${edge.id}`);
              const selected = selection?.kind === "transition" && selection.id === edge.id;

              return (
                <g
                  key={edge.id}
                  data-route-id={edge.id}
                  className={`stm-edge stm-edge--${visual}${selected ? " stm-edge--selected" : ""}${diffMark === undefined ? "" : ` stm-edge--diff-${diffMark}`}${problem === "error" ? " stm-edge--problem" : ""}`}
                >
                  <path
                    className="stm-edge-hit"
                    d={pathData(edge.points)}
                    onClick={() => interactive && onSelect({ kind: "transition", id: edge.id })}
                  />
                  <path className="stm-edge-line" d={pathData(edge.points)} />
                  <path className="stm-edge-arrow" d={arrowHead(edge.points)} />
                </g>
              );
            })}
            {connectLine !== null ? (
              <path className="stm-edge-connecting" d={pathData(connectLine)} />
            ) : null}
          </svg>
          {routed.map((edge) => (
            <EdgeLabel
              key={edge.id}
              edge={edge}
              definition={definition}
              selected={selection?.kind === "transition" && selection.id === edge.id}
              focusable={interactive}
              visual={edgeVisual(
                edge.id,
                definition.transitions.find((candidate) => candidate.id === edge.id)?.from ?? "",
                live,
              )}
              focused={focusedEdge === edge.id}
              onSelect={() => {
                setFocusedEdge(edge.id);
                onSelect({ kind: "transition", id: edge.id });
              }}
              onActivate={() => props.onActivate?.({ kind: "transition", id: edge.id })}
            />
          ))}
          {definition.states.map((state) => {
            const rect = rects.get(state.id);

            if (rect === undefined) return null;

            const status = statuses.get(state.id) ?? null;

            const selected =
              (selection?.kind === "state" && selection.id === state.id) || multi.has(state.id);

            const diffMark = props.diff?.get(`state:${state.id}`);
            const problem = props.problems?.get(`state:${state.id}`);
            const connecting = connect?.target === state.id;

            return (
              <button
                key={state.id}
                type="button"
                data-node-id={state.id}
                data-state-id={state.id}
                tabIndex={interactive && rovingId === state.id ? 0 : -1}
                aria-pressed={selected}
                aria-label={nodeAccessibleName(state, status, outgoingCount.get(state.id) ?? 0)}
                aria-current={status?.isCurrent === true ? "step" : undefined}
                className={[
                  "stm-node",
                  `stm-node--${status?.visual ?? "idle"}`,
                  selected ? "stm-node--selected" : "",
                  diffMark === undefined ? "" : `stm-node--diff-${diffMark}`,
                  problem === undefined ? "" : `stm-node--problem-${problem}`,
                  connecting ? "stm-node--connect-target" : "",
                  editable ? "stm-node--editable" : "",
                ]
                  .filter((name) => name.length > 0)
                  .join(" ")}
                style={{ left: rect.x, top: rect.y, width: rect.width, minHeight: rect.height }}
                onPointerDown={(event) => onNodePointerDown(event, state.id)}
                onPointerMove={onNodePointerMove}
                onPointerUp={(event) => onNodePointerUp(event, state.id)}
                onFocus={() => setFocusedId(state.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();

                    if (event.key === " " && editable && event.shiftKey) {
                      selectNode(state.id, true);

                      return;
                    }

                    onSelect({ kind: "state", id: state.id });
                    props.onActivate?.({ kind: "state", id: state.id });
                  }
                }}
                onDoubleClick={() => editable && edit.onRename(state.id)}
              >
                <span className="stm-node-head">
                  <Icon
                    name={KIND_ICON[state.kind]}
                    fallback="Circle"
                    className="stm-node-glyph"
                    aria-hidden
                  />
                  <span className="stm-node-title">{state.title}</span>
                  <NodeBadges state={state} status={status} problem={problem} diff={diffMark} />
                </span>
                <span className="stm-node-sub">{stateSubtitle(state)}</span>
                {live !== undefined ? (
                  <span className="stm-node-meta">
                    {status?.isCurrent === true ? status.meta : " "}
                  </span>
                ) : null}
                {status?.visual === "current-executing" ? (
                  <span className="stm-node-progress" aria-hidden="true" />
                ) : null}
                {editable ? (
                  <>
                    {(["top", "right", "bottom", "left"] as const).map((side) => (
                      <span
                        key={side}
                        className={`stm-handle stm-handle--${side}`}
                        aria-hidden="true"
                        onPointerDown={(event) => startConnect(event, state.id)}
                      />
                    ))}
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
        {definition.states.length === 0 && editable ? (
          <div className="stm-canvas-hint">
            <p className="stm-canvas-hint-title">Add your first state</p>
            <button
              type="button"
              className="stm-button stm-button--primary"
              onClick={() => setAddMenu(true)}
            >
              Add state
            </button>
          </div>
        ) : null}
      </div>
      {interactive ? (
        <div className="stm-canvas-toolbar" role="toolbar" aria-label="Canvas">
          {editable ? (
            <div className="stm-menu-anchor">
              <button
                type="button"
                className="stm-tool"
                aria-haspopup="menu"
                aria-expanded={addMenu}
                onClick={() => setAddMenu((value) => !value)}
              >
                <Icon name="Plus" aria-hidden />
                <span>Add state</span>
              </button>
              {addMenu ? (
                <div className="stm-menu" role="menu" aria-label="Add state">
                  {STATE_KINDS.map((kind) => (
                    <button
                      key={kind}
                      type="button"
                      role="menuitem"
                      className="stm-menu-item"
                      onClick={() => {
                        setAddMenu(false);
                        edit.onAddState(kind, {
                          x: (size.width / 2 - viewport.x) / viewport.zoom - 112,
                          y: (size.height / 2 - viewport.y) / viewport.zoom - 30,
                        });
                      }}
                    >
                      <Icon name={KIND_ICON[kind]} fallback="Circle" aria-hidden />
                      <span>{KIND_LABEL[kind]}</span>
                      <kbd className="stm-kbd">N {KIND_SHORTCUT[kind].toUpperCase()}</kbd>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {editable ? (
            <>
              <button
                type="button"
                className="stm-tool"
                aria-label="Undo"
                title="Undo (⌘Z)"
                onClick={edit.onUndo}
              >
                <Icon name="ArrowTurnBackward" aria-hidden />
              </button>
              <button
                type="button"
                className="stm-tool"
                aria-label="Redo"
                title="Redo (⇧⌘Z)"
                onClick={edit.onRedo}
              >
                <Icon name="ArrowTurnForward" aria-hidden />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="stm-tool"
            aria-label="Fit graph"
            title="Fit (F)"
            onClick={fit}
          >
            <Icon name="Maximize2" aria-hidden />
          </button>
          <button
            type="button"
            className="stm-tool"
            aria-label="Zoom out"
            title="Zoom out (−)"
            onClick={() => zoomBy(1 / 1.2)}
          >
            <Icon name="Minus" aria-hidden />
          </button>
          <span className="stm-zoom" aria-live="off">
            {Math.round(viewport.zoom * 100)}%
          </span>
          <button
            type="button"
            className="stm-tool"
            aria-label="Zoom in"
            title="Zoom in (+)"
            onClick={() => zoomBy(1.2)}
          >
            <Icon name="Plus" aria-hidden />
          </button>
          <button
            type="button"
            className="stm-tool"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
            aria-expanded={showHelp}
            onClick={() => setShowHelp((value) => !value)}
          >
            <Icon name="Keyboard" aria-hidden />
          </button>
          <span className="stm-canvas-gesture-hint" aria-hidden="true">
            Scroll to zoom · drag to pan
          </span>
        </div>
      ) : null}
      {showHelp ? <ShortcutHelp editable={editable} onClose={() => setShowHelp(false)} /> : null}
      {connect !== null && connect.pointer === null ? (
        <p className="stm-canvas-status" role="status">
          Choose a target with the arrow keys, then press Enter. Esc cancels.
        </p>
      ) : null}
    </div>
  );
}

function connectPreview(
  connect: { from: string; pointer: Point | null; target: string | null },
  rects: ReadonlyMap<string, Rect>,
): Point[] | null {
  const source = rects.get(connect.from);

  if (source === undefined) return null;

  const start = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const targetRect = connect.target === null ? undefined : rects.get(connect.target);

  const end =
    targetRect !== undefined
      ? { x: targetRect.x + targetRect.width / 2, y: targetRect.y + targetRect.height / 2 }
      : connect.pointer;

  if (end === null) return null;

  return [start, { x: end.x, y: start.y }, end];
}

function InitialEdge({ point, target }: { point: Point; target: Rect | undefined }) {
  if (target === undefined) return null;

  const end = { x: point.x, y: target.y };

  const points =
    point.y < target.y
      ? [{ x: point.x, y: point.y + INITIAL_RADIUS }, end]
      : [point, { x: point.x, y: target.y + target.height }];

  return (
    <g className="stm-initial">
      <circle cx={point.x} cy={point.y} r={INITIAL_RADIUS} />
      <path className="stm-edge-line" d={pathData(points)} />
      <path className="stm-edge-arrow" d={arrowHead(points)} />
    </g>
  );
}

function EdgeLabel(props: {
  edge: RoutedEdge;
  definition: GraphDefinition;
  selected: boolean;
  focusable: boolean;
  focused: boolean;
  visual: string;
  onSelect(): void;
  onActivate(): void;
}) {
  const transition = props.definition.transitions.find(
    (candidate) => candidate.id === props.edge.id,
  );

  if (transition === undefined) return null;

  const text = edgeLabel(transition, props.definition.layout.edgeLabels);

  const from =
    props.definition.states.find((state) => state.id === transition.from)?.title ?? transition.from;

  const to =
    props.definition.states.find((state) => state.id === transition.to)?.title ??
    transition.to ??
    "nowhere";

  return (
    <button
      type="button"
      data-edge-id={props.edge.id}
      tabIndex={props.focusable && props.focused ? 0 : -1}
      aria-pressed={props.selected}
      aria-label={`From ${from} to ${to} on ${text}.${props.visual === "last" ? " Last taken." : ""}`}
      title={text}
      className={`stm-edge-label stm-edge-label--${props.visual}${props.selected ? " stm-edge-label--selected" : ""}`}
      style={{ left: props.edge.label.x, top: props.edge.label.y }}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={props.onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          props.onSelect();
          props.onActivate();
        }
      }}
    >
      {text}
    </button>
  );
}

function NodeBadges({
  state,
  status,
  problem,
  diff,
}: {
  state: DraftState;
  status: NodeStatus | null;
  problem: string | undefined;
  diff: DiffMark | undefined;
}) {
  const badges: { key: string; icon: string; label: string }[] = [];

  if (status?.paused === true && status.isCurrent)
    badges.push({ key: "paused", icon: "Pause", label: "Paused" });

  if (status?.visual === "current-uncertain")
    badges.push({ key: "uncertain", icon: "CircleQuestion", label: "Outcome unknown" });

  if (status?.visual === "failed" && status.isCurrent)
    badges.push({ key: "failed", icon: "CircleX", label: "Failed" });

  if ((state.kind === "agent" || state.kind === "command") && state.effect === "external-write")
    badges.push({ key: "authority", icon: "AlertTriangle", label: "Changes external services" });

  if ((state.kind === "agent" || state.kind === "command") && state.maxAttempts > 1)
    badges.push({ key: "retry", icon: "RotateCcw", label: `Up to ${state.maxAttempts} attempts` });

  if (problem === "error")
    badges.push({ key: "problem", icon: "AlertCircle", label: "Has problems" });

  if (diff === "added") badges.push({ key: "diff", icon: "Plus", label: "Added" });
  else if (diff === "changed") badges.push({ key: "diff", icon: "Circle", label: "Changed" });
  else if (diff === "removed") badges.push({ key: "diff", icon: "Minus", label: "Removed" });

  if (badges.length === 0) return null;

  return (
    <span className="stm-node-badges">
      {badges.slice(0, 3).map((badge) => (
        <span key={badge.key} className={`stm-badge stm-badge--${badge.key}`} title={badge.label}>
          <Icon name={badge.icon} fallback="Circle" aria-label={badge.label} />
        </span>
      ))}
    </span>
  );
}

function ShortcutHelp({ editable, onClose }: { editable: boolean; onClose(): void }) {
  const rows: [string, string][] = [
    ["Scroll or pinch", "Zoom around the pointer"],
    ["Drag background", "Pan"],
    ["Arrows", "Move focus to the nearest state"],
    ["Home / End", "First / last state"],
    ["J", "Jump to the current state"],
    ["Enter", "Open in inspector"],
    ["E / ⇧E", "Cycle outgoing / incoming transitions"],
    ["F, +, −, 0", "Fit, zoom in, zoom out, 100%"],
  ];

  if (editable)
    rows.push(
      ["N then A/C/W/H/M/E", "Add agent, command, wait, choice, manual or end"],
      ["C, arrows, Enter", "Connect to another state"],
      ["⇧ Arrows (⌥ for 1px)", "Move state 8px"],
      ["Delete", "Delete selection"],
      ["⌘D", "Duplicate state"],
      ["⌘Z / ⇧⌘Z", "Undo / redo"],
      ["F2", "Rename"],
    );

  return (
    <div className="stm-popover stm-shortcuts" role="dialog" aria-label="Keyboard shortcuts">
      <div className="stm-popover-head">
        <h3 className="stm-h3">Keyboard shortcuts</h3>
        <button type="button" className="stm-tool" aria-label="Close" onClick={onClose}>
          <Icon name="CircleX" aria-hidden />
        </button>
      </div>
      <dl className="stm-shortcut-list">
        {rows.map(([keys, text]) => (
          <div key={keys} className="stm-shortcut-row">
            <dt>
              <kbd className="stm-kbd">{keys}</kbd>
            </dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

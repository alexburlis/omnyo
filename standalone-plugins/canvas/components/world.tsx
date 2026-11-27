import { z } from "zod";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { gridBackground } from "../lib/grid";
import {
  fitViewport,
  minZoom,
  maxZoom,
  focusViewport,
  islandPadding,
  minimapProjection,
  minimapWorldPoint,
  wheelPanDelta,
  wheelZoomFactor,
  type IslandFrame,
  type BoardLayout,
  type Rect,
  type Viewport,
  type NodeChange,
} from "../lib/layout";
import { useSemanticDetail } from "./semantic-detail";
import type { SemanticDetail } from "../lib/semantic";

const framePanDelta = z.object({ deltaX: z.number().finite(), deltaY: z.number().finite() });

export interface BoardCommands {
  fit(): void;
  latest(): void;
  focus(targets: readonly string[]): void;
  createPrompt(): void;
  capture(): Viewport;
  restore(viewport: Viewport): void;
}

export interface WorldNode {
  id: string;
  updatedRevision: number;
  change: NodeChange;
}

export type DragPosition = { id: string; x: number; y: number } | null;

export interface WorldSurfaceProps {
  layout: BoardLayout;
  nodes?: readonly WorldNode[];
  render(
    viewport: Viewport,
    gestures: {
      onNodePointerDown(event: ReactPointerEvent<HTMLDivElement>, id: string): void;
      onIslandPointerDown(event: ReactPointerEvent<HTMLElement>, frame: IslandFrame): void;
    },
  ): ReactNode;
  overlay?(viewport: Viewport, detail: SemanticDetail): ReactNode;
  minimumZoom?: number;
  initialViewport?: Viewport;
  fitOnMount?: boolean;
  fitBounds?(bounds: Rect, width: number, height: number): Viewport;
  initialFit?(bounds: Rect, width: number, height: number): Viewport;
  onViewportChange?(viewport: Viewport, size: { width: number; height: number }): void;
  transitionMs?: number;
  panBackground?: string;
  empty?: ReactNode;
  showMinimap?: boolean;
  showMinimapSections?: boolean;
  draggableMinimap?: boolean;
  selectedIsland?: string | null;
  dragging?: DragPosition;
  islandDrag?: DragPosition;
  onNodeDrag?(position: DragPosition): void;
  onIslandDrag?(position: DragPosition): void;
  onSelect(id: string | null): void;
  onSelectIsland?(id: string | null): void;
  onMove?(id: string, position: { x: number; y: number }): void;
  onIslandMove?(id: string, offset: { x: number; y: number }): void;
  onCommands(commands: BoardCommands): void;
  onCreatePrompt?(position: { x: number; y: number }): void;
  topInset?: number;
}

type Point = { x: number; y: number };

type Drag =
  | { kind: "pinch"; origin: Viewport; center: Point; distance: number }
  | { kind: "pan"; pointerId: number; startX: number; startY: number; origin: Viewport }
  | {
      kind: "node";
      pointerId: number;
      id: string;
      startX: number;
      startY: number;
      origin: { x: number; y: number };
      moved: boolean;
    }
  | {
      kind: "island";
      pointerId: number;
      id: string;
      startX: number;
      startY: number;
      origin: { x: number; y: number };
      moved: boolean;
    };

const minimapWidth = 160;

const minimapHeight = 100;

const minimapInset = 10;

const minimapReserve = minimapHeight + 20;

type BoardStyle = CSSProperties & { "--cnv-zoom"?: number; "--cnv-label-size"?: string };

function worldStyle(viewport: Viewport): BoardStyle {
  return {
    "--cnv-zoom": viewport.zoom,
    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
  };
}

const labelQuestionBand = 64;

function latestNode(nodes: readonly WorldNode[]): WorldNode | null {
  return nodes.reduce<WorldNode | null>(
    (latest, node) =>
      latest === null || node.updatedRevision > latest.updatedRevision ? node : latest,
    null,
  );
}

export function WorldSurface({
  layout,
  nodes = [],
  render,
  overlay,
  minimumZoom = minZoom,
  initialViewport = { x: 40, y: 40, zoom: 0.8 },
  fitOnMount = false,
  fitBounds = fitViewport,
  initialFit,
  onViewportChange,
  transitionMs = 180,
  panBackground,
  empty,
  showMinimap = true,
  showMinimapSections = false,
  draggableMinimap = false,
  selectedIsland = null,
  dragging = null,
  islandDrag = null,
  onNodeDrag,
  onIslandDrag,
  onSelect,
  onSelectIsland,
  onMove,
  onIslandMove,
  onCommands,
  onCreatePrompt,
  topInset = 0,
}: WorldSurfaceProps) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const placed = useRef(false);
  const glideTimer = useRef<number | undefined>(undefined);
  const previousRects = useRef(new Map<string, Rect>());

  const [viewport, setViewport] = useState<Viewport>(initialViewport);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [animate, setAnimate] = useState(false);
  const detail = useSemanticDetail(viewport.zoom);

  const cameraZoom = useCallback(
    (current: Viewport, factor: number, x: number, y: number) => {
      const zoom = Math.max(minimumZoom, Math.min(maxZoom, current.zoom * factor));

      return {
        zoom,
        x: x - ((x - current.x) / current.zoom) * zoom,
        y: y - ((y - current.y) / current.zoom) * zoom,
      };
    },
    [minimumZoom],
  );

  useEffect(() => onViewportChange?.(viewport, size), [onViewportChange, viewport, size]);

  useLayoutEffect(() => {
    const target = surface.current;

    if (target === null) return;

    const observer = new ResizeObserver(() =>
      setSize({ width: target.clientWidth, height: target.clientHeight }),
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, []);

  const glide = useCallback(
    (next: Viewport) => {
      setAnimate(true);
      viewportRef.current = next;
      setViewport(next);
      window.clearTimeout(glideTimer.current);
      glideTimer.current = window.setTimeout(() => setAnimate(false), transitionMs);
    },
    [transitionMs],
  );

  useEffect(() => () => window.clearTimeout(glideTimer.current), []);

  const clear = useCallback(
    (next: Viewport): Viewport => ({ ...next, y: next.y + topInset }),
    [topInset],
  );

  const viewHeight = size.height - topInset;

  const fittedViewport = useCallback(
    () => clear(fitBounds(layout.bounds, size.width, viewHeight - minimapReserve)),
    [clear, fitBounds, layout.bounds, viewHeight, size.width],
  );

  const fit = useCallback(() => glide(fittedViewport()), [glide, fittedViewport]);

  useLayoutEffect(() => {
    if (!fitOnMount || placed.current || size.width === 0 || size.height === 0) return;
    placed.current = true;
    setViewport(fittedViewport());
  }, [fitOnMount, size.width, size.height, fittedViewport]);

  const latest = useCallback(() => {
    const node = latestNode(nodes);
    const rect = node === null ? undefined : layout.nodes.get(node.id);

    if (node === null || rect === undefined) return;
    onSelect(node.id);
    glide(clear(focusViewport(rect, size.width, viewHeight, Math.max(viewport.zoom, 0.8))));
  }, [nodes, glide, clear, layout.nodes, onSelect, viewHeight, size.width, viewport.zoom]);

  const focus = useCallback(
    (targets: readonly string[]) => {
      const expanded = targets.flatMap((target) =>
        target.startsWith("edge:")
          ? target
              .slice(5)
              .split(":")
              .map((id) => `node:${id}`)
          : [target],
      );

      const rects = expanded.flatMap((target) => {
        const id = target.replace(/^(?:node|island):/u, "");

        const rect =
          layout.nodes.get(id) ??
          layout.islands.find((frame) => frame.id === id)?.rect ??
          previousRects.current.get(target);

        return rect === undefined ? [] : [rect];
      });

      if (rects.length === 0) {
        if (targets.includes("board")) fit();

        return;
      }

      const x = Math.min(...rects.map((rect) => rect.x));
      const y = Math.min(...rects.map((rect) => rect.y));

      const bounds = {
        x,
        y,
        width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
        height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
      };

      const fitted = fitViewport(bounds, size.width, viewHeight - minimapReserve);
      glide(
        clear(
          focusViewport(bounds, size.width, viewHeight - minimapReserve, Math.min(1, fitted.zoom)),
        ),
      );
    },
    [fit, glide, clear, layout.nodes, layout.islands, viewHeight, size.width],
  );

  useEffect(() => {
    for (const [id, rect] of layout.nodes) previousRects.current.set(`node:${id}`, rect);

    for (const frame of layout.islands) previousRects.current.set(`island:${frame.id}`, frame.rect);
  }, [layout]);

  const createPrompt = useCallback(() => {
    onCreatePrompt?.({
      x: (size.width / 2 - viewport.x) / viewport.zoom,
      y: (size.height / 2 - viewport.y) / viewport.zoom,
    });
  }, [onCreatePrompt, size, viewport]);

  const capture = useCallback(() => ({ ...viewportRef.current }), []);

  useEffect(
    () => onCommands({ fit, latest, focus, createPrompt, capture, restore: glide }),
    [fit, latest, focus, createPrompt, capture, glide, onCommands],
  );

  useEffect(() => {
    if (initialFit === undefined || placed.current || size.width === 0 || nodes.length === 0)
      return;
    placed.current = true;
    setViewport(clear(initialFit(layout.bounds, size.width, viewHeight - minimapReserve)));
  }, [nodes.length, clear, initialFit, layout.bounds, viewHeight, size.width]);

  useEffect(() => {
    const target = surface.current;

    if (target === null) return;

    function wheel(event: WheelEvent) {
      const zooming = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.deltaY !== 0;

      if (
        !zooming &&
        target !== null &&
        scrollsInside(event.target, target, event.deltaX, event.deltaY, event.shiftKey)
      )
        return;
      event.preventDefault();

      const bounds = target?.getBoundingClientRect();

      if (bounds === undefined) return;
      setAnimate(false);

      if (zooming) {
        const factor = wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey);
        const x = event.clientX - bounds.left;
        const y = event.clientY - bounds.top;

        setViewport((current) => cameraZoom(current, factor, x, y));
      } else {
        const delta = wheelPanDelta(event.deltaX, event.deltaY, event.deltaMode, event.shiftKey);

        setViewport((current) => ({ ...current, x: current.x + delta.x, y: current.y + delta.y }));
      }
    }

    function pan(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      const input = framePanDelta.safeParse(event.detail);

      if (!input.success) return;
      setAnimate(false);
      setViewport((current) => ({
        ...current,
        x: current.x + input.data.deltaX,
        y: current.y + input.data.deltaY,
      }));
    }

    target.addEventListener("canvas-frame-pan", pan);
    target.addEventListener("wheel", wheel, { passive: false });

    return () => {
      target.removeEventListener("canvas-frame-pan", pan);
      target.removeEventListener("wheel", wheel);
    };
  }, [cameraZoom]);

  function capturePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button === 1) {
      event.preventDefault();
      event.stopPropagation();
      startPan(event);

      return;
    }

    if (event.pointerType !== "touch" || pointers.current.size >= 2) return;

    if (event.target instanceof Element && event.target.closest(".cnv-hud, .cnv-minimap")) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const pair = [...pointers.current.values()];
    const first = pair[0];
    const second = pair[1];

    if (first === undefined || second === undefined) return;
    event.stopPropagation();
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    drag.current = {
      kind: "pinch",
      origin: viewportRef.current,
      center: {
        x: (first.x + second.x) / 2 - bounds.left,
        y: (first.y + second.y) / 2 - bounds.top,
      },
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
    };
    onNodeDrag?.(null);
    setAnimate(false);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startPan(event: ReactPointerEvent<HTMLDivElement>) {
    const projectBackground =
      panBackground !== undefined &&
      event.target instanceof Element &&
      event.target.matches(panBackground);

    if (
      event.button !== 1 &&
      (event.button !== 0 || (event.target !== event.currentTarget && !projectBackground))
    )
      return;

    if (event.button === 0) onSelect(null);
    drag.current = {
      kind: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: viewport,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function startNodeDrag(event: ReactPointerEvent<HTMLDivElement>, id: string) {
    const rect = layout.nodes.get(id);

    if (event.button !== 0 || rect === undefined) return;
    event.stopPropagation();
    drag.current = {
      kind: "node",
      pointerId: event.pointerId,
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin: { x: rect.x, y: rect.y },
      moved: false,
    };
    surface.current?.setPointerCapture(event.pointerId);
  }

  function startIslandDrag(event: ReactPointerEvent<HTMLElement>, frame: IslandFrame) {
    if (event.button !== 0) return;
    event.stopPropagation();
    onSelectIsland?.(frame.id);

    if (onIslandMove === undefined) return;
    drag.current = {
      kind: "island",
      pointerId: event.pointerId,
      id: frame.id,
      startX: event.clientX,
      startY: event.clientY,
      origin: frame.island.offset ?? { x: 0, y: 0 },
      moved: false,
    };
    surface.current?.setPointerCapture(event.pointerId);
  }

  function focusIsland(frame: IslandFrame) {
    onSelectIsland?.(frame.id);
    glide(clear(fitViewport(frame.rect, size.width, viewHeight - minimapReserve, 56)));
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const current = drag.current;

    if (pointers.current.has(event.pointerId))
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (current?.kind === "pinch") {
      const pair = [...pointers.current.values()];
      const first = pair[0];
      const second = pair[1];

      if (first === undefined || second === undefined) return;
      const bounds = event.currentTarget.getBoundingClientRect();

      const next = cameraZoom(
        current.origin,
        Math.hypot(second.x - first.x, second.y - first.y) / current.distance,
        current.center.x,
        current.center.y,
      );

      setViewport({
        ...next,
        x: next.x + (first.x + second.x) / 2 - bounds.left - current.center.x,
        y: next.y + (first.y + second.y) / 2 - bounds.top - current.center.y,
      });

      return;
    }

    if (current === null || current.pointerId !== event.pointerId) return;

    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;

    if (current.kind === "pan") {
      setViewport({ ...current.origin, x: current.origin.x + dx, y: current.origin.y + dy });

      return;
    }

    if (!current.moved && Math.hypot(dx, dy) < 4) return;
    current.moved = true;

    if (current.kind === "island") {
      onIslandDrag?.({
        id: current.id,
        x: Math.round(current.origin.x + dx / viewport.zoom),
        y: Math.round(current.origin.y + dy / viewport.zoom),
      });

      return;
    }

    onNodeDrag?.({
      id: current.id,
      x: Math.round(current.origin.x + dx / viewport.zoom),
      y: Math.round(current.origin.y + dy / viewport.zoom),
    });
  }

  function pointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.kind === "pinch" && !pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    const current = drag.current;

    if (current?.kind === "pinch") {
      const remaining = [...pointers.current.entries()][0];
      drag.current =
        remaining === undefined
          ? null
          : {
              kind: "pan",
              pointerId: remaining[0],
              startX: remaining[1].x,
              startY: remaining[1].y,
              origin: viewportRef.current,
            };
      onNodeDrag?.(null);

      return;
    }

    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;

    if (
      event.type !== "pointercancel" &&
      current.kind === "node" &&
      current.moved &&
      dragging !== null
    )
      onMove?.(current.id, { x: dragging.x, y: dragging.y });

    if (
      event.type !== "pointercancel" &&
      current.kind === "island" &&
      current.moved &&
      islandDrag !== null
    )
      onIslandMove?.(current.id, { x: islandDrag.x, y: islandDrag.y });
    onNodeDrag?.(null);
    onIslandDrag?.(null);
  }

  function zoomBy(factor: number) {
    glide(cameraZoom(viewport, factor, size.width / 2, size.height / 2));
  }

  function minimapJump(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation();

    const bounds = event.currentTarget.getBoundingClientRect();

    const projection = minimapProjection(
      layout.bounds,
      { width: minimapWidth, height: minimapHeight },
      minimapInset,
    );

    const point = minimapWorldPoint(projection, layout.bounds, {
      x: event.clientX - bounds.left - event.currentTarget.clientLeft,
      y: event.clientY - bounds.top - event.currentTarget.clientTop,
    });

    glide({
      zoom: viewport.zoom,
      x: size.width / 2 - point.x * viewport.zoom,
      y: size.height / 2 - point.y * viewport.zoom,
    });
  }

  const gridStyle: BoardStyle = {
    "--cnv-zoom": viewport.zoom,
    ...gridBackground(viewport),
  };

  return (
    <div
      ref={surface}
      className="cnv-board"
      style={gridStyle}
      data-animate={animate}
      data-no-secondary-panel-swipe
      data-no-sidebar-swipe
      data-dragging={drag.current !== null}
      data-detail={detail}
      role="region"
      aria-label="Canvas board. Pinch or hold Command or Control while scrolling to zoom. Scroll with two fingers, drag the background or hold the middle mouse button to pan."
      onDoubleClick={(event) => {
        if (
          !(event.target instanceof Element) ||
          !event.target.matches(".cnv-board, .cnv-world, .cnv-section")
        )
          return;
        const bounds = event.currentTarget.getBoundingClientRect();
        onCreatePrompt?.({
          x: (event.clientX - bounds.left - viewport.x) / viewport.zoom,
          y: (event.clientY - bounds.top - viewport.y) / viewport.zoom,
        });
      }}
      onPointerDownCapture={capturePointerDown}
      onPointerDown={startPan}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerUp}
      onAuxClickCapture={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      onLostPointerCapture={(event) => {
        const current = drag.current;

        if (
          !pointers.current.has(event.pointerId) &&
          (current === null || current.kind === "pinch" || current.pointerId !== event.pointerId)
        )
          return;
        pointers.current.clear();
        drag.current = null;
        onNodeDrag?.(null);
        onIslandDrag?.(null);
      }}
    >
      <div
        className="cnv-hud cnv-hud-zoom"
        role="group"
        aria-label="Zoom"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="cnv-hud-button"
          aria-label="Zoom out"
          title="Zoom out"
          onClick={() => zoomBy(0.8)}
        >
          <HudGlyph path="M5 12h14" />
        </button>
        <button
          type="button"
          className="cnv-hud-button cnv-hud-zoom-level"
          aria-label={`${Math.round(viewport.zoom * 100)}%, fit board`}
          title="Fit board"
          onClick={fit}
        >
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          type="button"
          className="cnv-hud-button"
          aria-label="Zoom in"
          title="Zoom in"
          onClick={() => zoomBy(1.25)}
        >
          <HudGlyph path="M12 5v14M5 12h14" />
        </button>
      </div>
      {empty}
      <div className="cnv-world" data-animate={animate} style={worldStyle(viewport)}>
        {render(viewport, {
          onNodePointerDown: startNodeDrag,
          onIslandPointerDown: startIslandDrag,
        })}
      </div>
      {overlay?.(viewport, detail)}
      <div
        className="cnv-island-labels"
        data-visible={detail === "overview" || detail === "map"}
        data-animate={animate}
        aria-hidden={detail !== "overview" && detail !== "map"}
      >
        {layout.islands.map((frame) => {
          const width = Math.max(180, (frame.rect.width - islandPadding * 2) * viewport.zoom);
          const band = (islandPadding + frame.header) * viewport.zoom;
          const labelSize = Math.round(Math.min(16, Math.max(11, band * 0.42)));

          const labelStyle: BoardStyle = {
            left: viewport.x + (frame.rect.x + islandPadding) * viewport.zoom,
            top: viewport.y + (frame.rect.y + islandPadding) * viewport.zoom,
            maxWidth: width,
            "--cnv-label-size": `${labelSize}px`,
          };

          return (
            <button
              key={frame.id}
              type="button"
              className="cnv-island-label"
              data-accent={frame.accent}
              data-selected={selectedIsland === frame.id}
              tabIndex={detail === "overview" || detail === "map" ? 0 : -1}
              style={labelStyle}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => focusIsland(frame)}
            >
              <span className="cnv-island-label-title">
                <span className="cnv-island-pip" aria-hidden="true" />
                {frame.island.title}
              </span>
              {frame.island.question !== undefined && band >= labelQuestionBand ? (
                <span className="cnv-island-label-question">{frame.island.question}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      {showMinimap ? (
        <Minimap
          markers={nodes}
          islands={layout.islands}
          nodes={layout.nodes}
          sections={showMinimapSections ? layout.sections : undefined}
          bounds={layout.bounds}
          viewport={viewport}
          size={size}
          onJump={minimapJump}
          draggable={draggableMinimap}
        />
      ) : null}
    </div>
  );
}

function Minimap({
  markers,
  islands,
  nodes,
  sections = [],
  bounds,
  viewport,
  size,
  onJump,
  draggable = false,
}: {
  markers: readonly WorldNode[];
  islands: readonly IslandFrame[];
  nodes: ReadonlyMap<string, Rect>;
  sections?: BoardLayout["sections"];
  bounds: Rect;
  viewport: Viewport;
  size: { width: number; height: number };
  onJump(event: ReactPointerEvent<HTMLDivElement>): void;
  draggable?: boolean;
}) {
  const projection = minimapProjection(
    bounds,
    { width: minimapWidth, height: minimapHeight },
    minimapInset,
  );

  return (
    <div
      className="cnv-minimap"
      aria-hidden="true"
      onPointerDown={(event) => {
        if (draggable) event.currentTarget.setPointerCapture(event.pointerId);
        onJump(event);
      }}
      onPointerMove={(event) => {
        if (draggable && event.buttons === 1) onJump(event);
      }}
    >
      <div className="cnv-minimap-scene" style={{ clipPath: `inset(${minimapInset}px round 4px)` }}>
        {sections.map((section) => (
          <span
            key={section.name}
            className="cnv-minimap-island"
            style={{
              left: projection.x + section.rect.x * projection.scale,
              top: projection.y + section.rect.y * projection.scale,
              width: Math.max(3, section.rect.width * projection.scale),
              height: Math.max(3, section.rect.height * projection.scale),
            }}
          />
        ))}
        {islands.map((frame) => (
          <span
            key={frame.id}
            className="cnv-minimap-island"
            data-accent={frame.accent}
            data-surface={frame.island.surface ?? "soft"}
            style={{
              left: projection.x + frame.rect.x * projection.scale,
              top: projection.y + frame.rect.y * projection.scale,
              width: Math.max(3, frame.rect.width * projection.scale),
              height: Math.max(3, frame.rect.height * projection.scale),
            }}
          />
        ))}
        {markers.map((node) => {
          const rect = nodes.get(node.id);

          return rect === undefined ? null : (
            <span
              key={node.id}
              className="cnv-minimap-node"
              data-node-id={node.id}
              data-change={node.change ?? undefined}
              style={{
                left: projection.x + rect.x * projection.scale,
                top: projection.y + rect.y * projection.scale,
                width: Math.max(2, rect.width * projection.scale),
                height: Math.max(2, rect.height * projection.scale),
              }}
            />
          );
        })}
        <span
          className="cnv-minimap-view"
          style={{
            left: projection.x - (viewport.x / viewport.zoom) * projection.scale,
            top: projection.y - (viewport.y / viewport.zoom) * projection.scale,
            width: (size.width / viewport.zoom) * projection.scale,
            height: (size.height / viewport.zoom) * projection.scale,
          }}
        />
      </div>
    </div>
  );
}

function HudGlyph({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}

function scrollsInside(
  from: EventTarget | null,
  root: HTMLElement,
  deltaX: number,
  deltaY: number,
  shift: boolean,
): boolean {
  const horizontal = shift && deltaX === 0 ? deltaY : deltaX;
  const vertical = shift && deltaX === 0 ? 0 : deltaY;

  for (
    let element = from instanceof Element ? from : null;
    element !== null && element !== root;
    element = element.parentElement
  ) {
    const style = getComputedStyle(element);

    if (
      vertical !== 0 &&
      /auto|scroll/u.test(style.overflowY) &&
      (vertical < 0
        ? element.scrollTop > 0
        : Math.ceil(element.scrollTop + element.clientHeight) < element.scrollHeight)
    )
      return true;

    if (
      horizontal !== 0 &&
      /auto|scroll/u.test(style.overflowX) &&
      (horizontal < 0
        ? element.scrollLeft > 0
        : Math.ceil(element.scrollLeft + element.clientWidth) < element.scrollWidth)
    )
      return true;
  }

  return false;
}

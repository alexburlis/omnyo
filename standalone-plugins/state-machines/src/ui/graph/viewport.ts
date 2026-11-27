import type { Point } from "./geometry.js";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.2;

export const MAX_ZOOM = 2.5;

export const READABLE_ZOOM = 0.75;

export const FIT_MAX_ZOOM = 1.25;

const LINE_HEIGHT = 16;

const PAGE_HEIGHT = 800;

const WHEEL_SENSITIVITY = 0.0018;

const PINCH_SENSITIVITY = 0.01;

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export interface WheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
}

export function wheelZoomFactor(input: WheelInput): number {
  const scale = input.deltaMode === 1 ? LINE_HEIGHT : input.deltaMode === 2 ? PAGE_HEIGHT : 1;
  const delta = Math.abs(input.deltaY) >= Math.abs(input.deltaX) ? input.deltaY : 0;
  const sensitivity = input.ctrlKey ? PINCH_SENSITIVITY : WHEEL_SENSITIVITY;
  const factor = Math.exp(-delta * scale * sensitivity);

  return Math.min(2, Math.max(0.5, factor));
}

export function zoomAround(viewport: Viewport, factor: number, pivot: Point): Viewport {
  const zoom = clampZoom(viewport.zoom * factor);

  return {
    zoom,
    x: pivot.x - ((pivot.x - viewport.x) / viewport.zoom) * zoom,
    y: pivot.y - ((pivot.y - viewport.y) / viewport.zoom) * zoom,
  };
}

export interface WorldBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasSize {
  width: number;
  height: number;
}

export function fitViewport(world: WorldBox, size: CanvasSize, padding: number): Viewport {
  const zoom = clampZoom(
    Math.min(
      FIT_MAX_ZOOM,
      (size.width - padding * 2) / Math.max(world.width, 1),
      (size.height - padding * 2) / Math.max(world.height, 1),
    ),
  );

  return {
    zoom,
    x: (size.width - world.width * zoom) / 2 - world.x * zoom,
    y: (size.height - world.height * zoom) / 2 - world.y * zoom,
  };
}

export function readableViewport(world: WorldBox, size: CanvasSize, padding: number): Viewport {
  const fitted = fitViewport(world, size, padding);

  if (fitted.zoom >= READABLE_ZOOM) return fitted;

  const zoom = READABLE_ZOOM;
  const fitsWidth = world.width * zoom <= size.width - padding * 2;
  const fitsHeight = world.height * zoom <= size.height - padding * 2;

  return {
    zoom,
    x: fitsWidth
      ? (size.width - world.width * zoom) / 2 - world.x * zoom
      : padding - world.x * zoom,
    y: fitsHeight
      ? (size.height - world.height * zoom) / 2 - world.y * zoom
      : padding - world.y * zoom,
  };
}

export function panelOcclusion(canvasWidth: number): number {
  return Math.min(400, canvasWidth * 0.45) + 16;
}

export function revealRect(viewport: Viewport, rect: WorldBox, area: CanvasSize): Viewport {
  const left = rect.x * viewport.zoom + viewport.x;
  const top = rect.y * viewport.zoom + viewport.y;

  const visible =
    left >= 0 &&
    top >= 0 &&
    left + rect.width * viewport.zoom <= area.width &&
    top + rect.height * viewport.zoom <= area.height;

  if (visible) return viewport;

  return {
    ...viewport,
    x: area.width / 2 - (rect.x + rect.width / 2) * viewport.zoom,
    y: area.height / 2 - (rect.y + rect.height / 2) * viewport.zoom,
  };
}

import type { ProjectView, ProjectSection, ProjectChat } from "../project-contract";
import type { Rect, Viewport } from "../lib/layout";

export const projectMinZoom = 0.02;

export const projectSurfaceOptions = {
  minimumZoom: projectMinZoom,
  transitionMs: 350,
  panBackground: ".cnv-project-section, .cnv-project-atlas",
  showMinimapSections: true,
  draggableMinimap: true,
};

function centeredProjectViewport(
  bounds: Rect,
  width: number,
  height: number,
  maximumZoom = 1,
): Viewport {
  const zoom = Math.max(
    projectMinZoom,
    Math.min(
      maximumZoom,
      (width - 96) / Math.max(1, bounds.width),
      (height - 96) / Math.max(1, bounds.height),
    ),
  );

  return {
    zoom,
    x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
    y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
  };
}

export function fitProjectSurface(bounds: Rect, width: number, height: number): Viewport {
  return centeredProjectViewport(bounds, width, height);
}

export function fitOverviewSurface(bounds: Rect, width: number, height: number): Viewport {
  return centeredProjectViewport(bounds, width, height, 0.32);
}

export function projectFit(
  rect: Rect,
  size: { width: number; height: number },
  readable = false,
): Viewport {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height - 140);
  const fitted = fitProjectSurface(rect, width, height);

  if (readable && fitted.zoom <= 0.12 && rect.height > rect.width) {
    const widthZoom = Math.min(1, (width - 96) / Math.max(1, rect.width));

    if (widthZoom > 0.12)
      return {
        zoom: widthZoom,
        x: width / 2 - (rect.x + rect.width / 2) * widthZoom,
        y: 48 - rect.y * widthZoom,
      };
  }

  return fitted;
}

export function worldWindow(
  viewport: Viewport,
  size: { width: number; height: number },
  screens = 0,
): Rect {
  return {
    x: (-viewport.x - size.width * screens) / viewport.zoom,
    y: (-viewport.y - size.height * screens) / viewport.zoom,
    width: (size.width * (1 + screens * 2)) / viewport.zoom,
    height: (size.height * (1 + screens * 2)) / viewport.zoom,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}

export function unionRects(rects: readonly Rect[]): Rect {
  if (rects.length === 0) return { x: 0, y: 0, width: 1200, height: 800 };
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));

  return {
    x,
    y,
    width: Math.max(...rects.map((rect) => rect.x + rect.width)) - x,
    height: Math.max(...rects.map((rect) => rect.y + rect.height)) - y,
  };
}

type ViewGeometry = {
  layer: {
    origin: { x: number; y: number };
    layout: { nodes: ReadonlyMap<string, Rect>; islands: readonly { id: string; rect: Rect }[] };
  };
};

type ViewTarget =
  | { kind: "ready"; rect: Rect }
  | { kind: "loading"; sectionId: string }
  | { kind: "missing"; message: string };

export function projectViewTarget(
  view: ProjectView,
  sections: readonly Pick<ProjectSection, "id" | "x" | "y">[],
  chats: readonly Pick<ProjectChat, "threadId" | "regionId" | "x" | "y">[],
  geometry: ReadonlyMap<string, ViewGeometry>,
): ViewTarget {
  if (view.anchorKind === "free") return { kind: "ready", rect: view.rect };

  if (view.anchorKind === "chat") {
    const chat = chats.find((entry) => entry.threadId === view.anchorId);

    if (!chat) return { kind: "missing", message: "That view’s chat card is no longer available." };
    const section = sections.find((entry) => entry.id === chat.regionId);

    if (chat.regionId !== null && !section)
      return { kind: "missing", message: "That chat card’s section is no longer available." };

    return {
      kind: "ready",
      rect: {
        ...view.rect,
        x: view.rect.x + chat.x + (section?.x ?? 0),
        y: view.rect.y + chat.y + (section?.y ?? 0),
      },
    };
  }

  const section = sections.find((entry) => entry.id === view.regionId);

  if (!section) return { kind: "missing", message: "That view’s section is no longer available." };

  if (view.anchorKind === "section")
    return {
      kind: "ready",
      rect: { ...view.rect, x: view.rect.x + section.x, y: view.rect.y + section.y },
    };
  const layer = geometry.get(section.id)?.layer;

  if (!layer) return { kind: "loading", sectionId: section.id };

  const rect =
    view.anchorKind === "node"
      ? layer.layout.nodes.get(view.anchorId ?? "")
      : layer.layout.islands.find((island) => island.id === view.anchorId)?.rect;

  if (!rect)
    return {
      kind: "missing",
      message:
        view.anchorKind === "node"
          ? "That view’s module is no longer available."
          : "That view’s island is no longer available.",
    };

  return {
    kind: "ready",
    rect: {
      ...rect,
      x: rect.x + section.x - layer.origin.x,
      y: rect.y + section.y - layer.origin.y,
    },
  };
}

export const OPEN_CHAT_CARD_WIDTH = 440;

const OPEN_CHAT_CARD_MARGIN = 8;

const OPEN_CHAT_DOCK_RESERVE = 96;

export function openChatCardRect(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  measuredHeight: number | null,
): Rect {
  const height = measuredHeight ?? Math.min(420, size.height / 2) + 76;

  return {
    x: Math.max(
      OPEN_CHAT_CARD_MARGIN,
      Math.min(size.width - OPEN_CHAT_CARD_WIDTH - OPEN_CHAT_CARD_MARGIN, anchor.x),
    ),
    y: Math.max(
      OPEN_CHAT_CARD_MARGIN,
      Math.min(size.height - height - OPEN_CHAT_DOCK_RESERVE, anchor.y),
    ),
    width: OPEN_CHAT_CARD_WIDTH,
    height,
  };
}

function clampInto(point: { x: number; y: number }, rect: Rect) {
  return {
    x: Math.max(rect.x, Math.min(rect.x + rect.width, point.x)),
    y: Math.max(rect.y, Math.min(rect.y + rect.height, point.y)),
  };
}

export function chatConnector(
  card: Rect,
  node: Rect,
): { from: { x: number; y: number }; to: { x: number; y: number } } | null {
  const to = clampInto({ x: card.x + card.width / 2, y: card.y + card.height / 2 }, node);
  const from = clampInto(to, card);

  if (Math.hypot(to.x - from.x, to.y - from.y) < 1) return null;

  return { from, to };
}

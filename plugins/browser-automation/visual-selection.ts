import type { VisualElement, VisualObservation } from "./contracts.js";

export function selectVisualElement(args: {
  observation: VisualObservation;
  clientX: number;
  clientY: number;
  bounds: { left: number; top: number; width: number; height: number };
  bitmap: { width: number; height: number };
}): VisualElement | null {
  const { bounds, bitmap, observation } = args;

  if (
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    bitmap.width <= 0 ||
    bitmap.height <= 0
  )
    return null;

  const scale = Math.min(
    bounds.width / bitmap.width,
    bounds.height / bitmap.height,
  );

  const left = bounds.left + (bounds.width - bitmap.width * scale) / 2;
  const top = bounds.top + (bounds.height - bitmap.height * scale) / 2;
  const pixelX = (args.clientX - left) / scale;
  const pixelY = (args.clientY - top) / scale;

  if (
    pixelX < 0 ||
    pixelY < 0 ||
    pixelX >= bitmap.width ||
    pixelY >= bitmap.height
  )
    return null;
  const x = (pixelX / bitmap.width) * observation.viewport.width;
  const y = (pixelY / bitmap.height) * observation.viewport.height;

  return (
    observation.elements
      .filter(
        ({ rect }) =>
          x >= rect.x &&
          y >= rect.y &&
          x < rect.x + rect.width &&
          y < rect.y + rect.height,
      )
      .sort(
        (a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height,
      )[0] ?? null
  );
}

export function visualNoteText(args: {
  id: string;
  comment: string;
  observation: Omit<VisualObservation, "elements">;
  element: VisualElement;
  projectId: string;
  path: string;
}): string {
  return `\n\n[Visual note ${args.id}]\n${args.comment.trim()}\n${JSON.stringify({ visualRequestId: args.id, targetId: args.observation.targetId, url: args.observation.url, viewport: args.observation.viewport, element: args.element, image: { kind: "project-image", projectId: args.projectId, path: args.path, mimeType: "image/jpeg", alt: args.comment.trim().slice(0, 160), visualRequestId: args.id, role: "before" } })}\n[/Visual note ${args.id}]`;
}

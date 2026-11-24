import {
  getMediaQuerySnapshot,
  REDUCED_MOTION_QUERY,
} from "@omnyo/shared-ui/hooks/use-media-query";
import { MOTION_DURATION_MS, resolveMotionEase } from "@omnyo/shared-ui/motion";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";

const MORPH_DURATION_MS = MOTION_DURATION_MS.slow;

export interface CompanionMorphSnapshot {
  rect: DOMRect;
  ghost: HTMLElement;
}

export function captureCompanionMorphSnapshot(
  node: HTMLElement,
): CompanionMorphSnapshot | null {
  if (!node.isConnected) return null;
  const rect = node.getBoundingClientRect();

  if (rect.width === 0 || rect.height === 0) return null;
  const ghost = node.cloneNode(true);

  if (!(ghost instanceof HTMLElement)) return null;

  for (const media of ghost.querySelectorAll("iframe, video, audio")) {
    media.remove();
  }

  for (const element of ghost.querySelectorAll("[id]")) {
    element.removeAttribute("id");
  }

  return { rect, ghost };
}

function transformBetween(from: DOMRect, to: DOMRect): string {
  return `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})`;
}

export function playCompanionMorph(
  { ghost, rect: from }: CompanionMorphSnapshot,
  node: HTMLElement,
): () => void {
  const easing = resolveMotionEase("smooth");

  const to = node.getBoundingClientRect();

  if (
    getMediaQuerySnapshot(REDUCED_MOTION_QUERY) ||
    easing === "" ||
    to.width === 0 ||
    to.height === 0
  ) {
    return () => {};
  }

  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  Object.assign(ghost.style, {
    position: "fixed",
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
    margin: "0",
    pointerEvents: "none",
    transformOrigin: "0 0",
    zIndex: String(APP_OVERLAY_LAYER.sidebarTrigger),
  });
  document.body.append(ghost);

  const timing: KeyframeAnimationOptions = {
    duration: MORPH_DURATION_MS,
    easing,
  };

  const ghostAnimation = ghost.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: transformBetween(from, to), opacity: 0 },
    ],
    timing,
  );

  const nodeAnimation = node.animate(
    [
      {
        transformOrigin: "0 0",
        transform: transformBetween(to, from),
        opacity: 0,
      },
      { transformOrigin: "0 0", transform: "none", opacity: 1 },
    ],
    timing,
  );

  ghostAnimation.addEventListener("finish", () => ghost.remove());

  return () => {
    ghostAnimation.cancel();
    nodeAnimation.cancel();
    ghost.remove();
  };
}

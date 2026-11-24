import { type RefObject, useEffect, useState } from "react";

const PORTALED_OVERLAY_SELECTOR = "[data-omnyo-portaled-overlay]";

const SETTLED_POSITION_CHECK_DELAY_MS = 150;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.left < b.right &&
    b.left < a.right &&
    a.top < b.bottom &&
    b.top < a.bottom
  );
}

function listOccludingOverlays(): HTMLElement[] {
  return [
    ...document.querySelectorAll<HTMLElement>(PORTALED_OVERLAY_SELECTOR),
  ].filter((overlay) => overlay.querySelector('[role="tooltip"]') === null);
}

function isOccluded(element: HTMLElement, overlays: HTMLElement[]): boolean {
  const contentRect = element.getBoundingClientRect();

  return overlays.some((overlay) =>
    rectsIntersect(contentRect, overlay.getBoundingClientRect()),
  );
}

export function useIsBrowserViewOccluded(
  contentRef: RefObject<HTMLElement | null>,
  enabled: boolean,
): boolean {
  const [occluded, setOccluded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setOccluded(false);

      return;
    }

    const frames = new Set<number>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let observedOverlays: HTMLElement[] = [];

    const check = () => {
      const element = contentRef.current;
      const overlays = listOccludingOverlays();

      const nextOverlays = overlays.filter(
        (overlay) => !observedOverlays.includes(overlay),
      );

      for (const overlay of observedOverlays) {
        if (!overlays.includes(overlay)) resizeObserver.unobserve(overlay);
      }

      for (const overlay of nextOverlays) resizeObserver.observe(overlay);
      observedOverlays = overlays;
      setOccluded(element !== null && isOccluded(element, overlays));
    };

    const scheduleChecks = () => {
      const frame = requestAnimationFrame(() => {
        frames.delete(frame);
        check();

        const settledFrame = requestAnimationFrame(() => {
          frames.delete(settledFrame);
          check();
        });

        frames.add(settledFrame);
      });

      frames.add(frame);

      const timer = setTimeout(() => {
        timers.delete(timer);
        check();
      }, SETTLED_POSITION_CHECK_DELAY_MS);

      timers.add(timer);
    };

    const resizeObserver = new ResizeObserver(check);
    const mutationObserver = new MutationObserver(scheduleChecks);
    mutationObserver.observe(document.body, { childList: true });
    window.addEventListener("resize", scheduleChecks);
    check();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleChecks);

      for (const frame of frames) cancelAnimationFrame(frame);

      for (const timer of timers) clearTimeout(timer);
    };
  }, [contentRef, enabled]);

  return enabled && occluded;
}

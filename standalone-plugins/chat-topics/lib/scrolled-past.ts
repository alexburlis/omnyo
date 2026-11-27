import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

const SCROLL_EDGE = 0.5;

export interface ScrolledPastMetrics {
  slotTop: number;
  viewTop: number;
  inset: number;
}

export function isScrolledPast(metrics: ScrolledPastMetrics): boolean {
  return metrics.slotTop < metrics.viewTop + metrics.inset - SCROLL_EDGE;
}

function measure(list: HTMLElement, slotTop: () => number | null): boolean {
  const top = slotTop();

  if (top === null) return false;

  return isScrolledPast({
    slotTop: top,
    viewTop: list.getBoundingClientRect().top,
    inset: Number.parseFloat(list.style.getPropertyValue("--ct-toolbar-height")) || 0,
  });
}

export function useScrolledPast(
  list: RefObject<HTMLElement | null>,
  slotTop: () => number | null,
): boolean {
  const [past, setPast] = useState(false);

  useLayoutEffect(() => {
    const element = list.current;

    if (element !== null) setPast(measure(element, slotTop));
  });

  useEffect(() => {
    const element = list.current;

    if (element === null) return;
    let frame = 0;

    const apply = () => {
      frame = 0;
      setPast(measure(element, slotTop));
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const resize = new ResizeObserver(schedule);

    element.addEventListener("scroll", schedule, { passive: true });
    resize.observe(element);

    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", schedule);
      resize.disconnect();
    };
  }, [list, slotTop]);

  return past;
}

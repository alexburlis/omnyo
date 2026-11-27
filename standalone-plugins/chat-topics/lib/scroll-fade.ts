import { useEffect, type RefObject } from "react";

const SCROLL_EDGE = 2;

export interface ScrollFadeMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export interface ScrollFadeEdges {
  top: boolean;
  bottom: boolean;
}

export function scrollFadeEdges(metrics: ScrollFadeMetrics): ScrollFadeEdges {
  const hidden = metrics.scrollHeight - metrics.clientHeight;

  if (hidden <= SCROLL_EDGE) return { top: false, bottom: false };

  return {
    top: metrics.scrollTop > SCROLL_EDGE,
    bottom: metrics.scrollTop < hidden - SCROLL_EDGE,
  };
}

export function useScrollFade(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;

    if (element === null) return;
    let frame = 0;

    const apply = () => {
      frame = 0;
      const edges = scrollFadeEdges(element);

      element.toggleAttribute("data-fade-top", edges.top);
      element.toggleAttribute("data-fade-bottom", edges.bottom);
    };

    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };

    const resize = new ResizeObserver(schedule);

    const watch = (node: Node) => {
      if (node instanceof Element) resize.observe(node, { box: "border-box" });
    };

    const mutation = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of Array.from(record.removedNodes)) {
          if (node instanceof Element) resize.unobserve(node);
        }

        for (const node of Array.from(record.addedNodes)) watch(node);
      }

      schedule();
    });

    resize.observe(element);

    for (const child of Array.from(element.children)) watch(child);
    mutation.observe(element, { childList: true });
    element.addEventListener("scroll", schedule, { passive: true });
    schedule();

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      element.removeEventListener("scroll", schedule);
      element.removeAttribute("data-fade-top");
      element.removeAttribute("data-fade-bottom");
    };
  }, [ref]);
}

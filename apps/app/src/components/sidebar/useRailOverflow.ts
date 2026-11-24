import {
  useLayoutEffect,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

export const RAIL_SEPARATOR_CLASS =
  "my-1 h-px w-6 shrink-0 self-center bg-(--material-line)";

const RAIL_FADE_TOP_PX = 28;

const RAIL_FADE_BOTTOM_PX = 40;

const RAIL_SCROLL_EDGE_PX = 2;

export interface RailScrollFades {
  overflows: boolean;
  fadeTop: boolean;
  fadeBottom: boolean;
}

const NO_RAIL_SCROLL_FADES: RailScrollFades = {
  overflows: false,
  fadeTop: false,
  fadeBottom: false,
};

function readRailScrollFades(element: HTMLElement): RailScrollFades {
  const { scrollTop, scrollHeight, clientHeight } = element;
  const overflows = scrollHeight > clientHeight + 1;

  return {
    overflows,
    fadeTop: overflows && scrollTop > RAIL_SCROLL_EDGE_PX,
    fadeBottom:
      overflows &&
      scrollTop + clientHeight < scrollHeight - RAIL_SCROLL_EDGE_PX,
  };
}

function sameRailScrollFades(
  left: RailScrollFades,
  right: RailScrollFades,
): boolean {
  return (
    left.overflows === right.overflows &&
    left.fadeTop === right.fadeTop &&
    left.fadeBottom === right.fadeBottom
  );
}

export function useRailScrollFades(
  scrollRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
): RailScrollFades {
  const [fades, setFades] = useState(NO_RAIL_SCROLL_FADES);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;

    if (scroller === null) return;

    const update = () => {
      const next = readRailScrollFades(scroller);
      setFades((current) =>
        sameRailScrollFades(current, next) ? current : next,
      );
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(scroller);

    if (contentRef.current !== null) observer.observe(contentRef.current);
    scroller.addEventListener("scroll", update, { passive: true });

    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", update);
    };
  }, [contentRef, scrollRef]);

  return fades;
}

export function railFadeMaskStyle(
  fades: RailScrollFades,
): CSSProperties | undefined {
  if (!fades.fadeTop && !fades.fadeBottom) return undefined;

  const stops = [
    ...(fades.fadeTop
      ? ["transparent 0", `#000 ${RAIL_FADE_TOP_PX}px`]
      : ["#000 0"]),
    ...(fades.fadeBottom
      ? [`#000 calc(100% - ${RAIL_FADE_BOTTOM_PX}px)`, "transparent 100%"]
      : ["#000 100%"]),
  ];

  const mask = `linear-gradient(to bottom, ${stops.join(", ")})`;

  return { maskImage: mask, WebkitMaskImage: mask };
}

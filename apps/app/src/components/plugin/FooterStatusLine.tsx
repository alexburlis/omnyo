import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

const FADE_PX = 24;

const EDGE_PX = 2;

interface StatusRowFades {
  start: boolean;
  end: boolean;
}

const NO_FADES: StatusRowFades = { start: false, end: false };

function useHorizontalFades(
  scrollRef: RefObject<HTMLDivElement | null>,
  contentRef: RefObject<HTMLDivElement | null>,
): StatusRowFades {
  const [fades, setFades] = useState(NO_FADES);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;

    if (scroller === null) return;

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = scroller;
      const start = scrollLeft > EDGE_PX;
      const end = scrollLeft + clientWidth < scrollWidth - EDGE_PX;

      setFades((current) =>
        current.start === start && current.end === end
          ? current
          : { start, end },
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

function fadeMask({ start, end }: StatusRowFades): CSSProperties | undefined {
  if (!start && !end) return undefined;

  const mask = `linear-gradient(to right, ${
    start ? `transparent 0, #000 ${FADE_PX}px` : "#000 0"
  }, ${end ? `#000 calc(100% - ${FADE_PX}px), transparent 100%` : "#000 100%"})`;

  return { maskImage: mask, WebkitMaskImage: mask };
}

export function FooterStatusLine({ children }: { children: ReactNode }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const fades = useHorizontalFades(scrollRef, contentRef);

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-w-0 flex-1 items-center overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={fadeMask(fades)}
    >
      <div
        ref={contentRef}
        className="flex h-full shrink-0 items-center *:shrink-0"
      >
        {children}
      </div>
    </div>
  );
}

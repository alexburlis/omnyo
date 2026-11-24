import { createContext, type ReactNode } from "react";
import { useComposedRefs } from "@radix-ui/react-compose-refs";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  getDetailScrollMaxHeightClass,
  type DetailScrollSize,
} from "../../ui/detail-scroll-size.js";
import { useStickyBottomScroll } from "./useStickyBottomScroll.js";
import { useScrollOverflowState } from "./useScrollOverflowState.js";

export const InsideTimelineDetailScrollContext = createContext(false);

interface TimelineDetailScrollProps {
  size: DetailScrollSize;
  overflowX?: "auto" | "hidden";
  streaming?: boolean;
  contentKey: string;
  className?: string;
  scrollClassName?: string;
  showAboveFade?: boolean;
  children: ReactNode;
}

export function TimelineDetailScroll({
  size,
  overflowX = "auto",
  streaming = false,
  contentKey,
  className,
  scrollClassName,
  showAboveFade = true,
  children,
}: TimelineDetailScrollProps) {
  const sticky = useStickyBottomScroll<HTMLDivElement>({
    contentKey,
    streaming,
  });

  const overflow = useScrollOverflowState<HTMLDivElement>();
  const maxHeightClassName = getDetailScrollMaxHeightClass(size);
  const { aboveOverflow, belowOverflow } = overflow;

  const refCallback = useComposedRefs<HTMLDivElement>(
    sticky.ref,
    overflow.scrollRef,
  );

  return (
    <div
      className={cn("relative isolate min-w-0", className)}
      data-detail-scroll={size}
    >
      <div
        ref={refCallback}
        onScroll={sticky.onScroll}
        onPointerDown={sticky.onPointerDown}
        onTouchMove={sticky.onTouchMove}
        onTouchStart={sticky.onTouchStart}
        onWheel={sticky.onWheel}
        data-detail-scroll-area={size}
        tabIndex={0}
        role="region"
        aria-label="Tool output"
        className={cn(
          "min-w-0 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          overflowX === "auto" ? "overflow-x-auto" : "overflow-x-hidden",
          maxHeightClassName,
          scrollClassName,
        )}
      >
        <div
          ref={overflow.topSentinelRef}
          aria-hidden
          className="-mb-px h-px w-full"
        />
        <div ref={sticky.contentRef}>
          <InsideTimelineDetailScrollContext.Provider value>
            {children}
          </InsideTimelineDetailScrollContext.Provider>
        </div>
        <div
          ref={overflow.bottomSentinelRef}
          aria-hidden
          className="h-px w-full"
        />
      </div>
      {showAboveFade && aboveOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="above"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent"
        />
      ) : null}
      {belowOverflow ? (
        <div
          aria-hidden
          data-detail-scroll-fade="below"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-t from-background to-transparent"
        />
      ) : null}
    </div>
  );
}

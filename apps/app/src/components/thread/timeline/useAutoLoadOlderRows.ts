import { useCallback, useEffect, useRef, useState } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";

const LOAD_OLDER_ROWS_DISTANCE_PX = 1_200;

interface UseAutoLoadOlderRowsArgs {
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: (() => Promise<void> | void) | undefined;
}

interface AutoLoadOlderRows {
  isAutoLoadEnabled: boolean;
  loadOlderRows: () => void;
}

function isNearTop(scrollElement: HTMLElement): boolean {
  return (
    scrollElement.scrollTop <
    Math.max(LOAD_OLDER_ROWS_DISTANCE_PX, scrollElement.clientHeight)
  );
}

export function useAutoLoadOlderRows({
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: UseAutoLoadOlderRowsArgs): AutoLoadOlderRows {
  const bottomAnchor = useBottomAnchoredScroll();
  const getScrollElement = bottomAnchor?.getScrollElement;
  const [autoLoadFailed, setAutoLoadFailed] = useState(false);
  const [settledLoads, setSettledLoads] = useState(0);
  const inFlightRef = useRef(false);

  const isAutoLoadEnabled =
    getScrollElement !== undefined &&
    hasOlderTimelineRows &&
    onLoadOlderRows !== undefined &&
    !autoLoadFailed;

  const startLoad = useCallback(() => {
    if (!onLoadOlderRows || inFlightRef.current) return;
    inFlightRef.current = true;
    void (async () => {
      try {
        await onLoadOlderRows();
      } catch {
        setAutoLoadFailed(true);
      } finally {
        inFlightRef.current = false;
        setSettledLoads((count) => count + 1);
      }
    })();
  }, [onLoadOlderRows]);

  const loadOlderRows = useCallback(() => {
    setAutoLoadFailed(false);
    startLoad();
  }, [startLoad]);

  useEffect(() => {
    const scrollElement = getScrollElement?.();

    if (!isAutoLoadEnabled || isLoadingOlderTimelineRows || !scrollElement) {
      return;
    }

    if (scrollElement.scrollHeight <= scrollElement.clientHeight) {
      startLoad();

      return;
    }

    let lastScrollTop = scrollElement.scrollTop;

    const onScroll = () => {
      const scrollTop = scrollElement.scrollTop;
      const movedUp = scrollTop < lastScrollTop;
      lastScrollTop = scrollTop;

      if (movedUp && isNearTop(scrollElement)) startLoad();
    };

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0 && scrollElement.scrollTop <= 0) startLoad();
    };

    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    scrollElement.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      scrollElement.removeEventListener("wheel", onWheel);
    };
  }, [
    getScrollElement,
    isAutoLoadEnabled,
    isLoadingOlderTimelineRows,
    settledLoads,
    startLoad,
  ]);

  return { isAutoLoadEnabled, loadOlderRows };
}

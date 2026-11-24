import { useEffect, useState, type RefObject } from "react";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";

export function useLingeringAutoExpansion(
  autoExpanded: boolean,
  rowRef: RefObject<HTMLElement | null>,
): boolean {
  const getScrollElement = useBottomAnchoredScroll()?.getScrollElement;

  const [previousAutoExpanded, setPreviousAutoExpanded] =
    useState(autoExpanded);

  const [lingering, setLingering] = useState(false);

  if (previousAutoExpanded !== autoExpanded) {
    setPreviousAutoExpanded(autoExpanded);
    setLingering(!autoExpanded && getScrollElement !== undefined);
  }

  useEffect(() => {
    if (!lingering) return;

    const row = rowRef.current;
    const scrollElement = getScrollElement?.() ?? null;

    if (
      row === null ||
      scrollElement === null ||
      typeof IntersectionObserver === "undefined"
    ) {
      setLingering(false);

      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => !entry.isIntersecting)) {
          setLingering(false);
        }
      },
      { root: scrollElement },
    );

    observer.observe(row);

    return () => observer.disconnect();
  }, [getScrollElement, lingering, rowRef]);

  return lingering;
}

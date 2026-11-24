import { useCallback, useState } from "react";

export function useElementWidth() {
  const [width, setWidth] = useState(0);

  const ref = useCallback((element: HTMLDivElement | null) => {
    if (element === null) return;
    setWidth(element.getBoundingClientRect().width);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      setWidth(
        entry?.borderBoxSize?.[0]?.inlineSize ??
          element.getBoundingClientRect().width,
      );
    });

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

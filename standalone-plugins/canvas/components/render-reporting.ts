import { useEffect, useRef, type RefObject } from "react";

export function useRenderReporting({
  root,
  report,
  onError,
  enabled,
}: {
  root: RefObject<HTMLElement | null>;
  report(): Promise<void>;
  onError(): void;
  enabled: boolean;
}) {
  const latest = useRef({ report, onError });
  latest.current = { report, onError };
  const schedule = useRef<(() => void) | null>(null);

  useEffect(() => {
    const element = root.current;

    if (!enabled || element === null) return;
    let timer: number | undefined;

    const publish = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void latest.current.report().catch(() => latest.current.onError());
      }, 150);
    };

    schedule.current = publish;
    const changes = new MutationObserver(publish);
    changes.observe(element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "style",
        "data-detail",
        "data-active",
        "data-frame-report",
        "data-source-revision",
      ],
    });
    const sizes = new ResizeObserver(publish);
    sizes.observe(element);
    element.addEventListener("canvas-frame-report", publish);
    element.addEventListener("load", publish, true);
    publish();

    return () => {
      window.clearTimeout(timer);
      changes.disconnect();
      sizes.disconnect();
      element.removeEventListener("canvas-frame-report", publish);
      element.removeEventListener("load", publish, true);
      schedule.current = null;
    };
  }, [root, enabled]);

  useEffect(() => schedule.current?.(), [report]);
}

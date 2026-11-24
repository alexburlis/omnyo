import {
  useEffect,
  useRef,
  useState,
  type AnimationEvent,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  MODAL_CONTENT_MOTION,
  MODAL_OVERLAY_MOTION,
  MOTION_DURATION_MS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "@omnyo/shared-ui/motion";

interface BlockingOverlayProps extends Omit<
  ComponentProps<"div">,
  "children" | "role" | "tabIndex"
> {
  open: boolean;
  children: ReactNode;
}

function isAnimating(element: HTMLElement): boolean {
  const name = getComputedStyle(element).animationName;

  return name !== "" && name !== "none";
}

export function BlockingOverlay({
  open,
  children,
  className,
  ...props
}: BlockingOverlayProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [present, setPresent] = useState(open);
  const [lastOpenChildren, setLastOpenChildren] = useState(children);
  const state = open ? "open" : "closed";

  if (open && !present) setPresent(true);

  if (open && lastOpenChildren !== children) setLastOpenChildren(children);

  useEffect(() => {
    if (open && present) layerRef.current?.focus({ preventScroll: true });
  }, [open, present]);

  useEffect(() => {
    if (open || !present) return;
    const layer = layerRef.current;

    if (layer === null || !isAnimating(layer)) {
      setPresent(false);

      return;
    }

    const timer = window.setTimeout(
      () => setPresent(false),
      MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
    );

    return () => window.clearTimeout(timer);
  }, [open, present]);

  if (!present) return null;

  const handleAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (!open && event.target === event.currentTarget) setPresent(false);
  };

  return (
    <div
      ref={layerRef}
      role="dialog"
      aria-modal="true"
      aria-hidden={!open || undefined}
      inert={!open}
      tabIndex={-1}
      data-state={state}
      onAnimationEnd={handleAnimationEnd}
      className={cn(
        "fixed inset-0 z-60 flex items-center justify-center overflow-y-auto bg-surface-scrim pt-[calc(1rem+env(safe-area-inset-top))] pr-[calc(1rem+env(safe-area-inset-right))] pb-[calc(1rem+env(safe-area-inset-bottom))] pl-[calc(1rem+env(safe-area-inset-left))] outline-none",
        MODAL_OVERLAY_MOTION,
        !open && "pointer-events-none",
        className,
      )}
      {...props}
    >
      <div
        data-state={state}
        className={cn("w-full max-w-md", MODAL_CONTENT_MOTION)}
      >
        {open ? children : lastOpenChildren}
      </div>
    </div>
  );
}

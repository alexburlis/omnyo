import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  committedSwipe,
  dragDirection,
  inEdgeGuard,
  swipeProgress,
  type ActionLabels,
  type SwipeDirection,
} from "./deck-logic.ts";
import { CARD_DRAG_TRANSITION, CARD_SETTLE_TRANSITION } from "./ui/motion.ts";
import { cn } from "./ui/utils.ts";
import { useReducedMotion } from "./use-chief-changed.ts";

const TILT_DIVISOR = 18;

const MAX_TILT_DEG = 12;

const REDUCED_FADE = 0.4;

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  dx: number;
  dy: number;
}

function startsOnControl(target: EventTarget): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, label, summary") !== null
  );
}

function useEntered(): boolean {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));

    return () => window.cancelAnimationFrame(frame);
  }, []);

  return entered;
}

export function SwipeCard({
  labels,
  framed,
  onSwipe,
  children,
}: {
  labels: ActionLabels;
  framed: boolean;
  onSwipe: (direction: SwipeDirection) => void;
  children: ReactNode;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const reduced = useReducedMotion();
  const entered = useEntered();

  const update = (next: Drag | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || event.button !== 0 || startsOnControl(event.target))
      return;

    if (inEdgeGuard(event.clientX, window.innerWidth)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    update({ pointerId: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, dy: 0 });
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;

    if (current === null || current.pointerId !== event.pointerId) return;
    update({ ...current, dx: event.clientX - current.x, dy: event.clientY - current.y });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = dragRef.current;

    if (current === null || current.pointerId !== event.pointerId) return;
    update(null);
    const direction = committedSwipe(current.dx, current.dy);

    if (direction !== null) onSwipe(direction);
  };

  const direction = drag === null ? null : dragDirection(drag.dx, drag.dy);
  const progress = drag === null ? 0 : swipeProgress(direction, drag.dx, drag.dy);

  const tilt =
    drag === null ? 0 : Math.max(-MAX_TILT_DEG, Math.min(MAX_TILT_DEG, drag.dx / TILT_DIVISOR));

  const moving = drag !== null && !reduced;
  const opacity = !entered ? 0 : reduced ? 1 - progress * REDUCED_FADE : 1;

  return (
    <div
      data-no-sidebar-swipe=""
      data-no-secondary-panel-swipe=""
      className={cn(
        "relative pointer-coarse:touch-none pointer-coarse:select-none",
        framed && "rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm",
        drag === null ? CARD_SETTLE_TRANSITION : CARD_DRAG_TRANSITION,
      )}
      style={{
        opacity,
        transform: moving
          ? `translate(${drag.dx}px, ${Math.min(drag.dy, 0)}px) rotate(${tilt}deg)`
          : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => update(null)}
    >
      {direction === null ? null : (
        <span
          aria-hidden
          className="pointer-events-none absolute top-3 left-1/2 z-10 -translate-x-1/2 rounded-md bg-foreground px-2 py-0.5 text-xs font-medium text-background"
          style={{ opacity: progress }}
        >
          {labels[direction]}
        </span>
      )}
      {children}
    </div>
  );
}

import { useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { cn } from "@omnyo/shared-ui/lib/utils";

type Point = { x: number; y: number };

type View = Point & { scale: number };

type Gesture =
  | { kind: "idle" }
  | { kind: "pan"; start: Point; view: View }
  | { kind: "pinch"; center: Point; distance: number; view: View };

const initialView: View = { scale: 1, x: 0, y: 0 };

export function ZoomableImage({
  src,
  alt,
  onClose,
  checkerStyle,
  className,
}: {
  checkerStyle: CSSProperties;
  className?: string;
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const image = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [view, setView] = useState(initialView);
  const [isZoomAnimating, setIsZoomAnimating] = useState(false);
  const current = useRef(initialView);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture>({ kind: "idle" });
  const moved = useRef(false);
  const backdropTap = useRef(true);
  const lastPointerType = useRef("");
  const lastTap = useRef<{ time: number; point: Point } | null>(null);

  function apply(next: View) {
    const element = image.current;
    const area = surface.current;
    const scale = Math.min(8, Math.max(1, next.scale));

    const maxX = Math.max(
      0,
      ((element?.clientWidth ?? 0) * scale - (area?.clientWidth ?? 0)) / 2,
    );

    const maxY = Math.max(
      0,
      ((element?.clientHeight ?? 0) * scale - (area?.clientHeight ?? 0)) / 2,
    );

    current.current = {
      scale,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
    setView(current.current);
  }

  function point(event: { clientX: number; clientY: number }): Point {
    const rect = surface.current?.getBoundingClientRect();

    return {
      x: event.clientX - (rect ? rect.left + rect.width / 2 : 0),
      y: event.clientY - (rect ? rect.top + rect.height / 2 : 0),
    };
  }

  function animateTo(next: View) {
    setIsZoomAnimating(true);
    apply(next);
  }

  function zoom(scale: number, focal: Point = { x: 0, y: 0 }) {
    const previous = current.current;
    const nextScale = Math.min(8, Math.max(1, scale));
    const ratio = nextScale / previous.scale;
    animateTo({
      scale: nextScale,
      x: focal.x - (focal.x - previous.x) * ratio,
      y: focal.y - (focal.y - previous.y) * ratio,
    });
  }

  function begin() {
    const [first, second] = [...pointers.current.values()];

    if (first && second) {
      gesture.current = {
        kind: "pinch",
        center: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
        distance: Math.hypot(first.x - second.x, first.y - second.y),
        view: current.current,
      };
      moved.current = true;
      lastTap.current = null;
    } else if (first)
      gesture.current = { kind: "pan", start: first, view: current.current };
    else gesture.current = { kind: "idle" };
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;
    const location = point(event);
    pointers.current.set(event.pointerId, location);
    const active = gesture.current;

    if (active.kind !== "idle") setIsZoomAnimating(false);

    if (active.kind === "pan") {
      const x = location.x - active.start.x;
      const y = location.y - active.start.y;

      if (Math.hypot(x, y) > 5) moved.current = true;
      apply({
        scale: active.view.scale,
        x: active.view.x + x,
        y: active.view.y + y,
      });
    } else if (active.kind === "pinch") {
      const [first, second] = [...pointers.current.values()];

      if (!first || !second || active.distance <= 0) return;

      const scale = Math.min(
        8,
        Math.max(
          1,
          (active.view.scale *
            Math.hypot(first.x - second.x, first.y - second.y)) /
            active.distance,
        ),
      );

      const ratio = scale / active.view.scale;
      apply({
        scale,
        x: (first.x + second.x) / 2 - (active.center.x - active.view.x) * ratio,
        y: (first.y + second.y) / 2 - (active.center.y - active.view.y) * ratio,
      });
    }
  }

  function end(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId)) return;

    if (
      event.type === "pointerup" &&
      event.pointerType === "touch" &&
      !moved.current
    ) {
      const location = point(event);
      const previous = lastTap.current;

      if (
        previous &&
        Date.now() - previous.time < 350 &&
        Math.hypot(
          location.x - previous.point.x,
          location.y - previous.point.y,
        ) < 30
      ) {
        zoom(current.current.scale > 1 ? 1 : 3, location);
        lastTap.current = null;
        moved.current = true;
      } else lastTap.current = { time: Date.now(), point: location };
    }

    pointers.current.delete(event.pointerId);
    begin();
  }

  return (
    <>
      <div
        ref={surface}
        data-testid="image-zoom-surface"
        className="absolute inset-0 flex touch-none select-none items-center justify-center overflow-hidden p-4"
        style={{ cursor: view.scale > 1 ? "grab" : "zoom-in" }}
        onPointerDown={(event) => {
          if (event.button !== 0 || pointers.current.size >= 2) return;
          lastPointerType.current = event.pointerType;

          if (pointers.current.size === 0) {
            moved.current = false;
            backdropTap.current = event.target === event.currentTarget;
          }

          pointers.current.set(event.pointerId, point(event));
          event.currentTarget.setPointerCapture?.(event.pointerId);
          begin();
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onClick={(event) => {
          event.stopPropagation();

          if (
            event.target === event.currentTarget &&
            !moved.current &&
            backdropTap.current
          )
            onClose();
        }}
        onDoubleClick={(event) => {
          event.preventDefault();

          if (lastPointerType.current === "touch") return;
          zoom(current.current.scale > 1 ? 1 : 3, point(event));
        }}
      >
        <img
          ref={image}
          src={src}
          alt={alt}
          draggable={false}
          onDragStart={(event) => event.preventDefault()}
          data-zoom-animating={isZoomAnimating ? "true" : undefined}
          className={cn(
            "max-h-[82dvh] max-w-full object-contain motion-safe:data-[zoom-animating=true]:transition-transform motion-safe:data-[zoom-animating=true]:duration-(--motion-duration-base) motion-safe:data-[zoom-animating=true]:ease-(--motion-ease-smooth)",
            className,
          )}
          style={{
            ...checkerStyle,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
            WebkitTouchCallout: "none",
          }}
        />
      </div>
      <div className="absolute left-[max(0.5rem,env(safe-area-inset-left))] top-[max(0.5rem,env(safe-area-inset-top))] flex gap-1 rounded-full bg-black/45 text-white">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom out"
          disabled={view.scale === 1}
          onClick={() => zoom(current.current.scale / 1.5)}
        >
          −
        </Button>
        <Button
          variant="ghost"
          aria-label="Reset image zoom"
          onClick={() => animateTo(initialView)}
        >
          {Math.round(view.scale * 100)}%
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zoom in"
          disabled={view.scale === 8}
          onClick={() => zoom(current.current.scale * 1.5)}
        >
          +
        </Button>
      </div>
    </>
  );
}

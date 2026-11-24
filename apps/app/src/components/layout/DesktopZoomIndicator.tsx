import { useCallback, useEffect, useRef, useState } from "react";
import {
  OMNYO_DESKTOP_MAX_ZOOM_PERCENT,
  OMNYO_DESKTOP_MIN_ZOOM_PERCENT,
} from "@omnyo/desktop-contract";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { APP_OVERLAY_LAYER } from "@/components/ui/app-overlay-layers";
import {
  getOmnyoDesktopInfo,
  MACOS_APP_REGION_NO_DRAG_CLASS,
} from "@/lib/omnyo-desktop";

const HIDE_DELAY_MS = 2000;

const FADE_OUT_MS = MOTION_DURATION_MS.fast;

export function DesktopZoomIndicator() {
  const desktop = getOmnyoDesktopInfo();
  const onZoomChange = desktop?.onZoomChange;
  const zoom = desktop?.zoom;
  const [zoomFactor, setZoomFactor] = useState<number | null>(null);
  const [fading, setFading] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hovered = useRef(false);

  const restartHideTimer = useCallback(() => {
    clearTimeout(hideTimer.current);
    setFading(false);

    if (!hovered.current) {
      hideTimer.current = setTimeout(() => {
        setFading(true);
        hideTimer.current = setTimeout(() => setZoomFactor(null), FADE_OUT_MS);
      }, HIDE_DELAY_MS);
    }
  }, []);

  useEffect(() => {
    const unsubscribe = onZoomChange?.((factor) => {
      setZoomFactor(factor);
      restartHideTimer();
    });

    return () => {
      unsubscribe?.();
      clearTimeout(hideTimer.current);
    };
  }, [onZoomChange, restartHideTimer]);

  if (zoomFactor === null) {
    return null;
  }

  const zoomPercent = Math.round(zoomFactor * 100);

  return (
    <div
      className={`fixed right-0 top-(--omnyo-app-chrome-row-height) ${MACOS_APP_REGION_NO_DRAG_CLASS}`}
      style={{ zIndex: APP_OVERLAY_LAYER.sharedPortaledOverlay }}
    >
      <div
        role="toolbar"
        aria-label="Zoom"
        className={cn(
          "mt-2 mr-3 flex items-center gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md motion-safe:transition-opacity motion-safe:duration-(--motion-duration-fast)",
          fading && "opacity-0",
        )}
        style={{ zoom: 1 / zoomFactor }}
        onPointerEnter={() => {
          hovered.current = true;
          restartHideTimer();
        }}
        onPointerLeave={() => {
          hovered.current = false;
          restartHideTimer();
        }}
      >
        <span
          aria-live="polite"
          className="min-w-12 text-center text-sm font-medium tabular-nums"
        >
          {zoomPercent}%
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom out"
          disabled={zoomPercent <= OMNYO_DESKTOP_MIN_ZOOM_PERCENT}
          onClick={() => zoom?.("out")}
        >
          <Icon name="Minus" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="Zoom in"
          disabled={zoomPercent >= OMNYO_DESKTOP_MAX_ZOOM_PERCENT}
          onClick={() => zoom?.("in")}
        >
          <Icon name="Plus" />
        </Button>
        <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          aria-label="Reset zoom"
          disabled={zoomPercent === 100}
          onClick={() => zoom?.("reset")}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}

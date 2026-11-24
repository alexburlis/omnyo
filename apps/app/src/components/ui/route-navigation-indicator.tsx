import { useEffect, useRef, useState } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { useIsRouteNavigationPending } from "./app-route-anchor";

export const ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS = 120;

export const ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS = 320;

export function useDelayedBusyIndicator(busy: boolean): boolean {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (busy) {
      if (shownAtRef.current !== null) return;

      const revealTimeout = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, ROUTE_NAVIGATION_INDICATOR_REVEAL_DELAY_MS);

      return () => window.clearTimeout(revealTimeout);
    }

    const shownAt = shownAtRef.current;

    if (shownAt === null) {
      setVisible(false);

      return;
    }

    const remainingMs =
      ROUTE_NAVIGATION_INDICATOR_MIN_VISIBLE_MS - (Date.now() - shownAt);

    if (remainingMs <= 0) {
      shownAtRef.current = null;
      setVisible(false);

      return;
    }

    const hideTimeout = window.setTimeout(() => {
      shownAtRef.current = null;
      setVisible(false);
    }, remainingMs);

    return () => window.clearTimeout(hideTimeout);
  }, [busy]);

  return visible;
}

export function RouteNavigationIndicator() {
  const isPending = useIsRouteNavigationPending();
  const visible = useDelayedBusyIndicator(isPending);
  const [mounted, setMounted] = useState(visible);

  if (visible && !mounted) {
    setMounted(true);
  }

  useEffect(() => {
    if (visible || !mounted) return;

    const unmountTimeout = window.setTimeout(
      () => setMounted(false),
      MOTION_DURATION_MS.fast,
    );

    return () => window.clearTimeout(unmountTimeout);
  }, [mounted, visible]);

  if (!mounted) return null;

  return (
    <div
      data-testid="route-navigation-indicator"
      role={visible ? "progressbar" : undefined}
      aria-label={visible ? "Loading page" : undefined}
      aria-hidden={visible ? undefined : true}
      className={cn(
        "pointer-events-none fixed top-[env(safe-area-inset-top)] right-[env(safe-area-inset-right)] left-[env(safe-area-inset-left)] z-100 h-0.5 overflow-hidden bg-transparent animate-in fade-in-0 duration-(--motion-duration-fast) transition-opacity",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="h-full w-1/3 animate-indeterminate-progress rounded-full bg-muted-foreground" />
    </div>
  );
}

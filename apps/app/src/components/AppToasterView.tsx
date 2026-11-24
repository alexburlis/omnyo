import { useEffect, type CSSProperties } from "react";
import { toast, Toaster, type ToasterProps } from "sonner";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { usePreferredTheme } from "@/hooks/useTheme";
import { attachSonnerToast } from "./ui/app-toast-runtime";
import { APP_OVERLAY_LAYER } from "./ui/app-overlay-layers";

const COMPACT_TOAST_OFFSET: NonNullable<ToasterProps["offset"]> = {
  top: "calc(env(safe-area-inset-top) + var(--omnyo-app-chrome-row-height) + 16px)",
  left: "calc(env(safe-area-inset-left) + 16px)",
  right: "calc(env(safe-area-inset-right) + 16px)",
};

const DESKTOP_TOAST_OFFSET: NonNullable<ToasterProps["offset"]> = {
  right: "calc(env(safe-area-inset-right) + 1rem)",
  bottom:
    "calc(var(--omnyo-app-footer-height, 0px) + env(safe-area-inset-bottom) + 1rem)",
};

const TOAST_SWIPE_DIRECTIONS: NonNullable<ToasterProps["swipeDirections"]> = [
  "top",
  "left",
  "right",
];

const TOASTER_STYLE: CSSProperties & Record<"--width", string> = {
  zIndex: APP_OVERLAY_LAYER.toast,
  "--width": "320px",
};

export function AppToasterView() {
  const theme = usePreferredTheme();
  const isCompactViewport = useIsCompactViewport();
  useEffect(() => {
    attachSonnerToast(toast);
  }, []);

  return (
    <Toaster
      theme={theme}
      style={TOASTER_STYLE}
      position={isCompactViewport ? "top-center" : "bottom-right"}
      gap={6}
      offset={isCompactViewport ? COMPACT_TOAST_OFFSET : DESKTOP_TOAST_OFFSET}
      mobileOffset={isCompactViewport ? COMPACT_TOAST_OFFSET : undefined}
      swipeDirections={TOAST_SWIPE_DIRECTIONS}
    />
  );
}

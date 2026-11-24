import {
  useEffect,
  useLayoutEffect,
  useState,
  type CSSProperties,
  type Key,
} from "react";

type PanelCollapseTransitionStyle = CSSProperties & {
  "--panel-collapse-duration": string;
};

export const PANEL_COLLAPSE_TRANSITION_CLASS =
  "duration-[var(--panel-collapse-duration,var(--motion-duration-panel))] ease-smooth motion-reduce:transition-none";

export const PANEL_SLIDE_OPEN_CLASS =
  "visible translate-x-0 starting:translate-x-full [transition:translate_var(--panel-collapse-duration,var(--motion-duration-panel))_var(--motion-ease-smooth),visibility_0s_linear_0s] motion-reduce:transition-none";

export const PANEL_SLIDE_CLOSED_CLASS =
  "invisible translate-x-full [transition:translate_var(--panel-collapse-duration,var(--motion-duration-panel))_var(--motion-ease-smooth),visibility_0s_linear_var(--panel-collapse-duration,var(--motion-duration-panel))] motion-reduce:transition-none";

export function getPanelCollapseTransitionStyle(
  transitionsReady: boolean,
): PanelCollapseTransitionStyle {
  return {
    "--panel-collapse-duration": transitionsReady
      ? "var(--motion-duration-panel)"
      : "0ms",
  };
}

let visibleInlinePlaceholderCount = 0;

export function useVisibleInlinePanelPlaceholder(visible: boolean): void {
  useLayoutEffect(() => {
    if (!visible) return;
    visibleInlinePlaceholderCount += 1;

    return () => {
      visibleInlinePlaceholderCount -= 1;
    };
  }, [visible]);
}

export function isInlinePanelPlaceholderVisible(): boolean {
  return visibleInlinePlaceholderCount > 0;
}

export function usePanelCollapseTransitionsReady(
  resetKey: Key,
  enabled: boolean,
): boolean {
  const [readyKey, setReadyKey] = useState<Key | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let secondFrame: number | null = null;

    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setReadyKey(resetKey);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);

      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [enabled, resetKey]);

  return !enabled || readyKey === resetKey;
}

export const PANEL_RESIZE_HANDLE_LAYER_CLASS = "z-[25]";

export const PANEL_RESIZE_HANDLE_TRANSITION_CLASS =
  "[transition:opacity_var(--panel-collapse-duration,var(--motion-duration-panel))_var(--motion-ease-smooth),background-color_var(--motion-duration-fast)_var(--motion-ease-standard)] motion-reduce:transition-none!";

export const PANEL_RESIZE_HIT_TARGET_CLASS =
  "absolute inset-y-0 left-1/2 z-10 w-4 -translate-x-1/2 touch-none cursor-col-resize pointer-coarse:w-8 bg-transparent";

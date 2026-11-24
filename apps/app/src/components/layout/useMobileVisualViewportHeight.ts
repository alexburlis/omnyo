import { useEffect } from "react";

type AppShellElement = HTMLDivElement;

export const SHELL_SAFE_AREA_BOTTOM_PROPERTY = "--omnyo-safe-area-bottom";

export const KEYBOARD_OPEN_MIN_SHRINK_PX = 80;

const IOS_VIEWPORT_STABLE_MS = 300;

const IOS_VIEWPORT_MAX_SETTLE_MS = 1_500;

interface ViewportGeometry {
  layoutHeight: number;
  height: number;
  offsetTop: number;
  scrollY: number;
  scale: number;
}

function sameGeometry(a: ViewportGeometry, b: ViewportGeometry) {
  return (
    a.layoutHeight === b.layoutHeight &&
    a.height === b.height &&
    a.offsetTop === b.offsetTop &&
    a.scrollY === b.scrollY &&
    a.scale === b.scale
  );
}

export function isKeyboardFocusTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

export type VisualViewportShellLayout = "compact" | "framed";

export function useMobileVisualViewportHeight(
  shell: AppShellElement | null,
  enabled: boolean,
  settleIOSViewport: boolean,
  layout: VisualViewportShellLayout,
) {
  useEffect(() => {
    const visualViewport = window.visualViewport;

    if (!shell || !enabled || !visualViewport) return;
    const framed = layout === "framed";
    const viewportStyleRoot = shell.ownerDocument.body;

    const shellHeightRoot = framed
      ? shell.ownerDocument.documentElement
      : viewportStyleRoot;

    let animationFrame: number | null = null;
    let appliedOverride: { top: number; height: number } | null = null;
    let shellContainingBlockHeight = 0;
    let shellContainingBlockHeightStale = true;
    let viewportHeightBeforeKeyboard: number | null = null;
    let appliedKeyboardInset = false;

    let settling: {
      deadline: number;
      stableSince: number;
      geometry: ViewportGeometry;
    } | null = null;

    const setKeyboardInset = (open: boolean) => {
      if (open === appliedKeyboardInset) return;
      appliedKeyboardInset = open;

      if (open) {
        viewportStyleRoot.style.setProperty(
          SHELL_SAFE_AREA_BOTTOM_PROPERTY,
          "0px",
        );
      } else {
        viewportStyleRoot.style.removeProperty(SHELL_SAFE_AREA_BOTTOM_PROPERTY);
      }
    };

    const clearViewportOverride = () => {
      if (appliedOverride === null) return;
      appliedOverride = null;
      shell.style.removeProperty("top");
      shell.style.removeProperty("height");
      shellHeightRoot.style.removeProperty("--omnyo-shell-height");
    };

    const reconcile = (): ViewportGeometry => {
      if (settleIOSViewport || shellContainingBlockHeightStale) {
        shellContainingBlockHeight = shellHeightRoot.clientHeight;
        shellContainingBlockHeightStale = false;
      }

      const viewportHeight = visualViewport.height;

      const geometry = {
        layoutHeight: shellContainingBlockHeight,
        height: Math.round(viewportHeight),
        offsetTop: visualViewport.offsetTop,
        scrollY: window.scrollY,
        scale: visualViewport.scale,
      };

      const editorFocused = isKeyboardFocusTarget(document.activeElement);

      const heightMismatch =
        Math.abs(geometry.layoutHeight - geometry.height) > 1;

      const compensatePan =
        (geometry.offsetTop > 1 || geometry.scrollY > 0) &&
        (!settleIOSViewport || editorFocused || heightMismatch);

      setKeyboardInset(
        viewportHeightBeforeKeyboard !== null &&
          editorFocused &&
          viewportHeightBeforeKeyboard - viewportHeight >=
            KEYBOARD_OPEN_MIN_SHRINK_PX,
      );

      if (geometry.scale !== 1 || (!heightMismatch && !compensatePan)) {
        clearViewportOverride();

        return geometry;
      }

      if (compensatePan && (!settleIOSViewport || geometry.scrollY > 0)) {
        window.scrollTo(0, 0);
      }

      const shellTop = Math.round(window.scrollY + visualViewport.offsetTop);

      if (
        appliedOverride?.top === shellTop &&
        appliedOverride.height === geometry.height
      ) {
        return geometry;
      }

      appliedOverride = { top: shellTop, height: geometry.height };

      if (!framed) {
        shell.style.top = `${shellTop}px`;
        shell.style.height = `${geometry.height}px`;
      }

      shellHeightRoot.style.setProperty(
        "--omnyo-shell-height",
        `${geometry.height}px`,
      );

      return geometry;
    };

    const updateHeight = () => {
      animationFrame = null;
      const geometry = reconcile();

      if (settling === null) return;

      const now = performance.now();

      if (!sameGeometry(settling.geometry, geometry)) {
        settling.geometry = geometry;
        settling.stableSince = now;
      }

      const stillKeyboardSized =
        geometry.scale === 1 &&
        geometry.layoutHeight - geometry.height >= KEYBOARD_OPEN_MIN_SHRINK_PX;

      if (
        now < settling.deadline &&
        (stillKeyboardSized ||
          now - settling.stableSince < IOS_VIEWPORT_STABLE_MS)
      ) {
        animationFrame = window.requestAnimationFrame(updateHeight);
      } else {
        settling = null;
      }
    };

    const scheduleUpdate = () => {
      if (settleIOSViewport && settling === null) {
        const geometry = reconcile();
        const now = performance.now();
        settling = {
          deadline: now + IOS_VIEWPORT_MAX_SETTLE_MS,
          stableSince: now,
          geometry,
        };
      }

      animationFrame ??= window.requestAnimationFrame(updateHeight);
    };

    const scheduleContainingBlockUpdate = () => {
      shellContainingBlockHeightStale = true;
      scheduleUpdate();
    };

    const handleVisualViewportScroll = () => {
      if (
        !settleIOSViewport &&
        appliedOverride === null &&
        !isKeyboardFocusTarget(document.activeElement)
      ) {
        return;
      }

      scheduleUpdate();
    };

    const handleFocusOut = (event: FocusEvent) => {
      if (!isKeyboardFocusTarget(event.target)) return;

      if (isKeyboardFocusTarget(event.relatedTarget)) return;
      viewportHeightBeforeKeyboard = null;
      setKeyboardInset(false);

      if (settleIOSViewport) {
        settling = null;
        scheduleContainingBlockUpdate();
      }
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isKeyboardFocusTarget(event.target)) return;
      viewportHeightBeforeKeyboard ??= visualViewport.height;
      scheduleContainingBlockUpdate();
    };

    if (settleIOSViewport) {
      scheduleUpdate();
      window.addEventListener("pageshow", scheduleContainingBlockUpdate);
      document.addEventListener(
        "visibilitychange",
        scheduleContainingBlockUpdate,
      );
    } else {
      reconcile();
    }

    visualViewport.addEventListener("resize", scheduleUpdate);
    visualViewport.addEventListener("scroll", handleVisualViewportScroll);
    window.addEventListener("resize", scheduleContainingBlockUpdate);
    window.addEventListener("orientationchange", scheduleContainingBlockUpdate);
    document.addEventListener("focusout", handleFocusOut);
    document.addEventListener("focusin", handleFocusIn);

    return () => {
      visualViewport.removeEventListener("resize", scheduleUpdate);
      visualViewport.removeEventListener("scroll", handleVisualViewportScroll);
      window.removeEventListener("resize", scheduleContainingBlockUpdate);
      window.removeEventListener(
        "orientationchange",
        scheduleContainingBlockUpdate,
      );
      window.removeEventListener("pageshow", scheduleContainingBlockUpdate);
      document.removeEventListener(
        "visibilitychange",
        scheduleContainingBlockUpdate,
      );
      document.removeEventListener("focusout", handleFocusOut);
      document.removeEventListener("focusin", handleFocusIn);

      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }

      setKeyboardInset(false);
      clearViewportOverride();
    };
  }, [enabled, layout, settleIOSViewport, shell]);
}

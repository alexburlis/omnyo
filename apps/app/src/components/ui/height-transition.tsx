import { useStore } from "jotai";
import {
  createContext,
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import {
  getDisclosureDurationMs,
  MOTION_DURATION_MS,
  MOTION_EASE,
  usePrefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import { supportsScrollAnchoring } from "@/lib/scroll-anchoring-support";
import {
  observedBorderBoxBlockSize,
  observeSharedResize,
} from "@/lib/shared-resize-observer";
import { layoutAnimationInFlightCountAtom } from "./layoutAnimationAtoms.js";

const PAUSE_COLLAPSED_DESCENDANT_ANIMATIONS_CLASS =
  "[&_*]:![animation-play-state:paused]";

interface SnapState {
  restoreFrame: number | null;
}

const SNAP_TRANSITION_CLASS = "data-snap:transition-none!";

interface IntrinsicHeightResizeState {
  restoreTimerId: number | null;
  usingIntrinsicHeight: boolean;
}

interface ScheduleIntrinsicHeightRestoreArgs {
  inner: HTMLElement;
  snapState: SnapState;
  target: HTMLElement;
  resizeState: IntrinsicHeightResizeState;
}

function enterSnapMode(target: HTMLElement): void {
  target.dataset.snap = "";
}

function exitSnapMode(target: HTMLElement): void {
  delete target.dataset.snap;
}

function scheduleRestore(target: HTMLElement, state: SnapState): void {
  if (state.restoreFrame !== null) {
    cancelAnimationFrame(state.restoreFrame);
  }

  state.restoreFrame = requestAnimationFrame(() => {
    state.restoreFrame = null;
    exitSnapMode(target);
  });
}

function applyHeight(
  target: HTMLElement,
  nextHeight: string,
  snap: boolean,
  state: SnapState,
): void {
  const currentHeightPx = parseFloat(target.style.height);
  const nextHeightPx = parseFloat(nextHeight);

  const heightDecreasing =
    Number.isFinite(currentHeightPx) &&
    Number.isFinite(nextHeightPx) &&
    nextHeightPx < currentHeightPx;

  if (snap || heightDecreasing) {
    enterSnapMode(target);
    scheduleRestore(target, state);
  }

  target.style.height = nextHeight;
}

function cleanupSnapState(target: HTMLElement | null, state: SnapState): void {
  if (state.restoreFrame !== null) {
    cancelAnimationFrame(state.restoreFrame);
    state.restoreFrame = null;
  }

  if (target) exitSnapMode(target);
}

function enterIntrinsicHeightMode(
  target: HTMLElement,
  resizeState: IntrinsicHeightResizeState,
  snapState: SnapState,
): void {
  if (snapState.restoreFrame !== null) {
    cancelAnimationFrame(snapState.restoreFrame);
    snapState.restoreFrame = null;
  }

  enterSnapMode(target);

  if (resizeState.usingIntrinsicHeight) {
    return;
  }

  target.style.height = "auto";
  resizeState.usingIntrinsicHeight = true;
}

function scheduleIntrinsicHeightRestore({
  inner,
  resizeState,
  snapState,
  target,
}: ScheduleIntrinsicHeightRestoreArgs): void {
  if (resizeState.restoreTimerId !== null) {
    window.clearTimeout(resizeState.restoreTimerId);
  }

  resizeState.restoreTimerId = window.setTimeout(() => {
    resizeState.restoreTimerId = null;

    if (!resizeState.usingIntrinsicHeight) {
      return;
    }

    resizeState.usingIntrinsicHeight = false;
    applyHeight(target, `${inner.offsetHeight}px`, true, snapState);
  }, AUTO_HEIGHT_WIDTH_RESIZE_SETTLE_MS);
}

function cancelIntrinsicHeightRestore(
  resizeState: IntrinsicHeightResizeState,
): void {
  if (resizeState.restoreTimerId === null) {
    return;
  }

  window.clearTimeout(resizeState.restoreTimerId);
  resizeState.restoreTimerId = null;
}

function getObservedInnerHeight(
  entry: ResizeObserverEntry | undefined,
  inner: HTMLElement,
): number {
  const observed =
    entry === undefined ? undefined : observedBorderBoxBlockSize(entry);

  return observed ?? inner.offsetHeight;
}

interface HeightTransitionProps {
  visible: boolean;
  children: ReactNode;
}

export function HeightTransition({ visible, children }: HeightTransitionProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const store = useStore();
  const reducedMotion = usePrefersReducedMotion();
  const durationMs = getDisclosureDurationMs(visible);

  const transition = reducedMotion
    ? `opacity ${MOTION_DURATION_MS.fast}ms ${MOTION_EASE.standard}`
    : `height ${durationMs}ms ${MOTION_EASE.smooth}, opacity ${durationMs}ms ${MOTION_EASE.smooth}`;

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const inner = innerRef.current;

    if (!wrapper || !inner) return;
    wrapper.style.height = visible ? `${inner.offsetHeight}px` : "0px";

    if (typeof ResizeObserver === "undefined") return;
    let lastWidth: number | null = null;
    let pendingVisibilitySnap = false;
    const snapState: SnapState = { restoreFrame: null };

    const unobserveInner = observeSharedResize(inner, {
      read: (entry) => {
        const width = entry?.contentRect?.width;

        const widthChanged =
          lastWidth !== null && width !== undefined && width !== lastWidth;

        const layoutAnimationActive =
          store.get(layoutAnimationInFlightCountAtom) > 0;

        const snap =
          widthChanged || pendingVisibilitySnap || layoutAnimationActive;

        pendingVisibilitySnap = false;

        if (width !== undefined) {
          lastWidth = width;
        }

        return {
          nextHeight: visible
            ? `${getObservedInnerHeight(entry, inner)}px`
            : "0px",
          snap,
        };
      },
      write: ({ nextHeight, snap }) => {
        applyHeight(wrapper, nextHeight, snap, snapState);
      },
    });

    const onVisibility = () => {
      if (!isDocumentVisible()) return;
      pendingVisibilitySnap = true;
      const nextHeight = visible ? `${inner.offsetHeight}px` : "0px";
      applyHeight(wrapper, nextHeight, true, snapState);
    };

    const unsubscribeFromDocumentVisibility =
      subscribeToDocumentVisibility(onVisibility);

    return () => {
      unobserveInner();
      unsubscribeFromDocumentVisibility();
      cleanupSnapState(wrapper, snapState);
    };
  }, [visible, store]);

  return (
    <div
      ref={wrapperRef}
      className={cn(
        SNAP_TRANSITION_CLASS,
        !visible && PAUSE_COLLAPSED_DESCENDANT_ANIMATIONS_CLASS,
      )}
      style={{
        overflowX: "visible",
        overflowY: "clip",
        opacity: visible ? 1 : 0,
        transition,
      }}
    >
      <div ref={innerRef} style={{ display: "flow-root" }}>
        {children}
      </div>
    </div>
  );
}

export const AutoHeightSnapContext = createContext<(() => void) | null>(null);

interface AutoHeightContainerProps {
  children: ReactNode;
  snapRevision?: string;
  animateGrowth?: boolean;
}

const AUTO_HEIGHT_INITIAL_SETTLE_MS = MOTION_DURATION_MS.base;

const AUTO_HEIGHT_WIDTH_RESIZE_SETTLE_MS = 120;

function useSnapHeightGrowth(): boolean {
  const isPointerCoarse = usePointerCoarse();
  const prefersReducedMotion = usePrefersReducedMotion();

  return isPointerCoarse || prefersReducedMotion || !supportsScrollAnchoring();
}

export function AutoHeightContainer({
  children,
  snapRevision,
  animateGrowth = true,
}: AutoHeightContainerProps) {
  const snapGrowth = useSnapHeightGrowth();

  const durationMs = snapGrowth || !animateGrowth ? 0 : MOTION_DURATION_MS.base;

  const wrapperRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const snapToCurrentHeightRef = useRef<(() => void) | null>(null);
  const previousSnapRevisionRef = useRef(snapRevision);
  const store = useStore();

  const snapToContentHeight = useCallback(() => {
    snapToCurrentHeightRef.current?.();
  }, []);

  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const inner = innerRef.current;

    if (!wrapper || !inner || typeof ResizeObserver === "undefined") return;
    wrapper.style.height = `${inner.offsetHeight}px`;
    let lastWidth: number | null = null;
    let pendingVisibilitySnap = false;
    let initialSettleComplete = false;

    let initialSettleTimerId = window.setTimeout(() => {
      initialSettleComplete = true;
    }, AUTO_HEIGHT_INITIAL_SETTLE_MS);

    const snapState: SnapState = { restoreFrame: null };

    const resizeState: IntrinsicHeightResizeState = {
      restoreTimerId: null,
      usingIntrinsicHeight: false,
    };

    const snapToCurrentHeight = () => {
      cancelIntrinsicHeightRestore(resizeState);
      resizeState.usingIntrinsicHeight = false;
      applyHeight(wrapper, `${inner.offsetHeight}px`, true, snapState);
    };

    snapToCurrentHeightRef.current = snapToCurrentHeight;

    const deferInitialSettleComplete = () => {
      if (initialSettleComplete) {
        return;
      }

      window.clearTimeout(initialSettleTimerId);
      initialSettleTimerId = window.setTimeout(() => {
        initialSettleComplete = true;
      }, AUTO_HEIGHT_INITIAL_SETTLE_MS);
    };

    const unobserveInner = observeSharedResize(inner, {
      read: (entry) => {
        const width = entry?.contentRect?.width;

        const widthChanged =
          lastWidth !== null && width !== undefined && width !== lastWidth;

        const layoutAnimationActive =
          store.get(layoutAnimationInFlightCountAtom) > 0;

        const snap =
          widthChanged ||
          pendingVisibilitySnap ||
          !initialSettleComplete ||
          layoutAnimationActive;

        pendingVisibilitySnap = false;

        if (width !== undefined) {
          lastWidth = width;
        }

        if (widthChanged || resizeState.usingIntrinsicHeight) {
          return { useIntrinsicHeight: true as const };
        }

        return {
          useIntrinsicHeight: false as const,
          nextHeight: `${getObservedInnerHeight(entry, inner)}px`,
          snap,
        };
      },
      write: (sync) => {
        if (sync.useIntrinsicHeight) {
          enterIntrinsicHeightMode(wrapper, resizeState, snapState);
          scheduleIntrinsicHeightRestore({
            inner,
            resizeState,
            snapState,
            target: wrapper,
          });
          deferInitialSettleComplete();

          return;
        }

        applyHeight(wrapper, sync.nextHeight, sync.snap, snapState);
        deferInitialSettleComplete();
      },
    });

    const onVisibility = () => {
      if (!isDocumentVisible()) return;
      pendingVisibilitySnap = true;
      snapToCurrentHeight();
    };

    const unsubscribeFromDocumentVisibility =
      subscribeToDocumentVisibility(onVisibility);

    return () => {
      snapToCurrentHeightRef.current = null;
      unobserveInner();
      unsubscribeFromDocumentVisibility();
      window.clearTimeout(initialSettleTimerId);
      cancelIntrinsicHeightRestore(resizeState);
      cleanupSnapState(wrapper, snapState);
    };
  }, [store]);
  useLayoutEffect(() => {
    if (previousSnapRevisionRef.current === snapRevision) {
      return;
    }

    previousSnapRevisionRef.current = snapRevision;
    snapToCurrentHeightRef.current?.();
  }, [snapRevision]);

  return (
    <AutoHeightSnapContext.Provider value={snapToContentHeight}>
      <div
        ref={wrapperRef}
        className={SNAP_TRANSITION_CLASS}
        style={{
          overflowX: "visible",
          overflowY: "clip",
          transition: `height ${durationMs}ms ${MOTION_EASE.smooth}`,
        }}
      >
        <div ref={innerRef} style={{ display: "flow-root" }}>
          {children}
        </div>
      </div>
    </AutoHeightSnapContext.Provider>
  );
}

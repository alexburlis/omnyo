import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { useStore } from "jotai";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  MOTION_DURATION_MS,
  prefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import { PAGE_SHELL_CONTENT_STYLE } from "./page-shell-content-style.js";
import { PAGE_SCROLL_TO_TOP_EVENT } from "@/lib/page-scroll-to-top";
import { isEditableKeyboardTarget } from "@/lib/app-keybindings";
import { layoutAnimationInFlightCountAtom } from "./layoutAnimationAtoms.js";

export interface BottomAnchorContextValue {
  getScrollElement: () => HTMLElement | null;
  isAtBottom: boolean;
  scrollToBottom: () => void;
  scrollElementIntoView: (args: ScrollElementIntoViewArgs) => void;
  scrollElementIntoViewClampedToMaxScroll: (
    args: ScrollElementIntoViewClampedToMaxScrollArgs,
  ) => void;
  holdContentPosition: (args: HoldContentPositionArgs) => void;
}

interface BottomAnchoredScrollBodyProps {
  children: ReactNode;
  footer: ReactNode;
  scrollOverlay?: ReactNode;
  scrollAreaClassName?: string;
  contentClassName?: string;
  maxWidthClassName: string;
  animateFollowLatest?: boolean;
}

interface ScrollElementIntoViewArgs {
  element: HTMLElement;
  options?: ScrollIntoViewOptions;
}

interface ScrollElementIntoViewClampedToMaxScrollArgs {
  element: HTMLElement;
}

interface HoldContentPositionArgs {
  edge: "top" | "bottom";
  element: HTMLElement;
  update: () => void;
}

interface ContentAnchor {
  element: HTMLElement;
  rowId: string | null;
  descendantIndex: number | null;
  edge: "top" | "bottom";
  contentOffset: number;
}

const BOTTOM_THRESHOLD_PX = 4;

const SCROLLBAR_IDLE_DELAY_MS = 600;

const USER_SCROLL_INTENT_MS = 350;

const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
]);

const SCROLL_FOOTER_SELECTOR = "[data-scroll-footer]";

const CONTENT_POSITION_HOLD_MS = MOTION_DURATION_MS.slow;

const FOLLOW_LATEST_TIME_CONSTANT_MS = 80;

const TIMELINE_ROW_ID_SELECTOR = "[data-timeline-row-id]";

const READING_ANCHOR_SELECTOR =
  "p, pre, li, blockquote, h1, h2, h3, h4, h5, h6, [data-reading-anchor]";

const TOP_LEVEL_TIMELINE_ROW_SELECTOR = `[data-timeline-row-list="top-level"] > ${TIMELINE_ROW_ID_SELECTOR}`;

export const BottomAnchorContext =
  createContext<BottomAnchorContextValue | null>(null);

export function useBottomAnchoredScroll(): BottomAnchorContextValue | null {
  return useContext(BottomAnchorContext);
}

function maxScrollOffset(scrollArea: HTMLElement): number {
  return Math.max(0, scrollArea.scrollHeight - scrollArea.clientHeight);
}

function isNearBottom(scrollArea: HTMLElement): boolean {
  return (
    maxScrollOffset(scrollArea) - scrollArea.scrollTop <= BOTTOM_THRESHOLD_PX
  );
}

function anchorRows(scrollArea: HTMLElement): NodeListOf<HTMLElement> {
  const topLevelRows = scrollArea.querySelectorAll<HTMLElement>(
    TOP_LEVEL_TIMELINE_ROW_SELECTOR,
  );

  return topLevelRows.length > 0
    ? topLevelRows
    : scrollArea.querySelectorAll<HTMLElement>(TIMELINE_ROW_ID_SELECTOR);
}

function findFirstVisibleRow(
  rows: ArrayLike<HTMLElement>,
  viewportTop: number,
): HTMLElement | null {
  let low = 0;
  let high = rows.length - 1;
  let found: HTMLElement | null = null;

  while (low <= high) {
    const index = low + Math.floor((high - low) / 2);
    const row = rows[index];

    if (!row) break;

    if (row.getBoundingClientRect().bottom <= viewportTop + 1) {
      low = index + 1;
    } else {
      found = row;
      high = index - 1;
    }
  }

  return found;
}

function findRow(scrollArea: HTMLElement, rowId: string): HTMLElement | null {
  for (const row of scrollArea.querySelectorAll<HTMLElement>(
    TIMELINE_ROW_ID_SELECTOR,
  )) {
    if (row.dataset.timelineRowId === rowId) return row;
  }

  return null;
}

function isInScrollFooter(target: EventTarget | null): boolean {
  return (
    target instanceof Element && target.closest(SCROLL_FOOTER_SELECTOR) !== null
  );
}

function isInNestedOutput(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("[data-detail-scroll-area]") !== null
  );
}

function contentOffsetOf(
  scrollArea: HTMLElement,
  element: HTMLElement,
  edge: "top" | "bottom",
): number {
  return (
    element.getBoundingClientRect()[edge] -
    scrollArea.getBoundingClientRect().top +
    scrollArea.scrollTop
  );
}

export function BottomAnchoredScrollBody({
  scrollAreaClassName,
  contentClassName,
  maxWidthClassName,
  footer,
  scrollOverlay,
  children,
  animateFollowLatest = false,
}: BottomAnchoredScrollBodyProps) {
  const store = useStore();
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const anchorRef = useRef<ContentAnchor | null>(null);
  const expectedScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);
  const lastFooterHeightRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const pointerScrollIntentRef = useRef(false);
  const hasOpenedAtBottomRef = useRef(false);
  const followFrameRef = useRef<number | null>(null);
  const activeHoldsRef = useRef(0);
  const isAtBottomRef = useRef(true);
  const [isAtBottom, setIsAtBottomState] = useState(true);

  const setIsAtBottom = useCallback((next: boolean) => {
    if (isAtBottomRef.current === next) return;
    isAtBottomRef.current = next;
    setIsAtBottomState(next);
  }, []);

  const getScrollElement = useCallback(() => scrollAreaRef.current, []);

  const writeScrollTop = useCallback((top: number) => {
    const scrollArea = scrollAreaRef.current;

    if (!scrollArea) return;
    const previous = scrollArea.scrollTop;
    scrollArea.scrollTop = top;
    const applied = scrollArea.scrollTop;
    lastScrollTopRef.current = applied;
    lastFooterHeightRef.current = footerRef.current?.offsetHeight ?? 0;
    expectedScrollTopRef.current =
      Math.abs(applied - previous) >= 0.5 ? applied : null;
  }, []);

  const hasUserScrollIntent = useCallback(
    () =>
      pointerScrollIntentRef.current ||
      window.performance.now() <= userScrollIntentUntilRef.current,
    [],
  );

  const cancelFollow = useCallback(() => {
    if (followFrameRef.current === null) return;
    window.cancelAnimationFrame(followFrameRef.current);
    followFrameRef.current = null;
  }, []);

  const captureAnchor = useCallback(() => {
    const scrollArea = scrollAreaRef.current;

    if (!scrollArea) return;
    const viewportTop = scrollArea.getBoundingClientRect().top;
    const row = findFirstVisibleRow(anchorRows(scrollArea), viewportTop);

    const descendants = row
      ? Array.from(
          row.querySelectorAll<HTMLElement>(READING_ANCHOR_SELECTOR),
        ).filter(
          (element) => element.querySelector(READING_ANCHOR_SELECTOR) === null,
        )
      : undefined;

    const descendant = descendants
      ? findFirstVisibleRow(descendants, viewportTop)
      : null;

    const element = descendant ?? row;

    anchorRef.current =
      row && element
        ? {
            element,
            rowId: row.dataset.timelineRowId ?? null,
            descendantIndex:
              descendant && row
                ? Array.from(
                    row.querySelectorAll<HTMLElement>(READING_ANCHOR_SELECTOR),
                  ).indexOf(descendant)
                : null,
            edge: "top",
            contentOffset: contentOffsetOf(scrollArea, element, "top"),
          }
        : null;
  }, []);

  const attach = useCallback(() => {
    stickToBottomRef.current = true;
    anchorRef.current = null;
    setIsAtBottom(true);
  }, [setIsAtBottom]);

  const detach = useCallback(() => {
    stickToBottomRef.current = false;
    cancelFollow();
    setIsAtBottom(false);
  }, [cancelFollow, setIsAtBottom]);

  const followToBottom = useCallback(() => {
    const scrollArea = scrollAreaRef.current;

    if (!scrollArea) return;

    const animate =
      animateFollowLatest &&
      hasOpenedAtBottomRef.current &&
      !prefersReducedMotion();

    if (maxScrollOffset(scrollArea) > 0) hasOpenedAtBottomRef.current = true;

    if (!animate) {
      cancelFollow();
      writeScrollTop(maxScrollOffset(scrollArea));

      return;
    }

    if (followFrameRef.current !== null) return;
    let previousTime: number | null = null;

    const step = (time: number) => {
      followFrameRef.current = null;

      if (!stickToBottomRef.current) return;
      const target = maxScrollOffset(scrollArea);
      const distance = target - scrollArea.scrollTop;

      if (Math.abs(distance) <= 1) {
        writeScrollTop(target);

        return;
      }

      const elapsed =
        previousTime === null ? 16 : Math.min(64, time - previousTime);

      previousTime = time;
      writeScrollTop(
        scrollArea.scrollTop +
          distance * (1 - Math.exp(-elapsed / FOLLOW_LATEST_TIME_CONSTANT_MS)),
      );
      followFrameRef.current = window.requestAnimationFrame(step);
    };

    followFrameRef.current = window.requestAnimationFrame(step);
  }, [animateFollowLatest, cancelFollow, writeScrollTop]);

  const keepAnchorInPlace = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    const anchor = anchorRef.current;

    if (!scrollArea || !anchor) return;

    if (!anchor.element.isConnected) {
      const replacement =
        anchor.rowId === null ? null : findRow(scrollArea, anchor.rowId);

      if (!replacement) {
        captureAnchor();

        return;
      }

      anchor.element =
        anchor.descendantIndex === null
          ? replacement
          : (replacement.querySelectorAll<HTMLElement>(READING_ANCHOR_SELECTOR)[
              anchor.descendantIndex
            ] ?? replacement);
    }

    const drift =
      contentOffsetOf(scrollArea, anchor.element, anchor.edge) -
      anchor.contentOffset;

    if (Math.abs(drift) >= 0.5) {
      writeScrollTop(scrollArea.scrollTop + drift);
    }

    anchor.contentOffset = contentOffsetOf(
      scrollArea,
      anchor.element,
      anchor.edge,
    );
  }, [captureAnchor, writeScrollTop]);

  const handleLayoutChange = useCallback(() => {
    if (stickToBottomRef.current) {
      followToBottom();

      return;
    }

    keepAnchorInPlace();
  }, [followToBottom, keepAnchorInPlace]);

  const handleScroll = useCallback(() => {
    const scrollArea = scrollAreaRef.current;

    if (!scrollArea) return;
    const scrollTop = scrollArea.scrollTop;
    const expected = expectedScrollTopRef.current;
    expectedScrollTopRef.current = null;
    const footerHeight = footerRef.current?.offsetHeight ?? 0;
    const footerResized = footerHeight !== lastFooterHeightRef.current;
    lastFooterHeightRef.current = footerHeight;

    if (expected !== null && Math.abs(scrollTop - expected) < 1) {
      lastScrollTopRef.current = scrollTop;

      return;
    }

    const movedUp = scrollTop < lastScrollTopRef.current - 0.5;
    lastScrollTopRef.current = scrollTop;

    if (isNearBottom(scrollArea)) {
      attach();
    } else if (!stickToBottomRef.current) {
      keepAnchorInPlace();
      captureAnchor();
    } else if (movedUp && hasUserScrollIntent()) {
      detach();
      captureAnchor();
    } else if (movedUp || footerResized) {
      followToBottom();
    }
  }, [
    attach,
    captureAnchor,
    detach,
    followToBottom,
    hasUserScrollIntent,
    keepAnchorInPlace,
  ]);

  const scrollToBottom = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    attach();
    cancelFollow();

    if (scrollArea) writeScrollTop(maxScrollOffset(scrollArea));
  }, [attach, cancelFollow, writeScrollTop]);

  const scrollElementIntoView = useCallback(
    ({ element, options }: ScrollElementIntoViewArgs) => {
      detach();
      element.scrollIntoView(options);
      captureAnchor();
    },
    [captureAnchor, detach],
  );

  const scrollElementIntoViewClampedToMaxScroll = useCallback(
    ({ element }: ScrollElementIntoViewClampedToMaxScrollArgs) => {
      const scrollArea = scrollAreaRef.current;

      if (!scrollArea) {
        element.scrollIntoView({ block: "start", inline: "nearest" });

        return;
      }

      writeScrollTop(
        Math.min(
          maxScrollOffset(scrollArea),
          Math.max(0, contentOffsetOf(scrollArea, element, "top")),
        ),
      );

      if (isNearBottom(scrollArea)) {
        attach();

        return;
      }

      detach();
      captureAnchor();
    },
    [attach, captureAnchor, detach, writeScrollTop],
  );

  const holdContentPosition = useCallback(
    ({ edge, element, update }: HoldContentPositionArgs) => {
      const scrollArea = scrollAreaRef.current;

      if (!scrollArea) {
        update();

        return;
      }

      const edgeBefore = element.getBoundingClientRect()[edge];
      detach();
      activeHoldsRef.current += 1;
      store.set(layoutAnimationInFlightCountAtom, (count) => count + 1);

      window.setTimeout(() => {
        store.set(layoutAnimationInFlightCountAtom, (count) =>
          Math.max(0, count - 1),
        );
        activeHoldsRef.current -= 1;

        if (activeHoldsRef.current > 0 || stickToBottomRef.current) return;

        if (isNearBottom(scrollArea)) {
          attach();
          followToBottom();

          return;
        }

        captureAnchor();
      }, CONTENT_POSITION_HOLD_MS);

      flushSync(update);

      if (!element.isConnected) {
        captureAnchor();

        return;
      }

      const drift = element.getBoundingClientRect()[edge] - edgeBefore;

      if (Math.abs(drift) >= 0.5) {
        writeScrollTop(scrollArea.scrollTop + drift);
      }

      anchorRef.current = {
        element,
        rowId: null,
        descendantIndex: null,
        edge,
        contentOffset: contentOffsetOf(scrollArea, element, edge),
      };
    },
    [attach, captureAnchor, detach, followToBottom, store, writeScrollTop],
  );

  const latestRef = useRef({
    detach,
    handleLayoutChange,
    handleScroll,
  });

  useLayoutEffect(() => {
    latestRef.current = {
      detach,
      handleLayoutChange,
      handleScroll,
    };
  });

  useEffect(() => {
    const scrollArea = scrollAreaRef.current;
    const scrollContent = scrollContentRef.current;

    if (!scrollArea || !scrollContent) return;
    let scrollbarIdleTimeout: number | null = null;

    const onScroll = () => {
      if (scrollArea.dataset.scrollbarScrolling !== "true") {
        scrollArea.dataset.scrollbarScrolling = "true";
      }

      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }

      scrollbarIdleTimeout = window.setTimeout(() => {
        scrollbarIdleTimeout = null;
        scrollArea.removeAttribute("data-scrollbar-scrolling");
      }, SCROLLBAR_IDLE_DELAY_MS);
      latestRef.current.handleScroll();
    };

    const onScrollToTop = (event: Event) => {
      event.preventDefault();

      if (maxScrollOffset(scrollArea) === 0) return;
      latestRef.current.detach();
      scrollArea.scrollTo({
        top: 0,
        behavior: prefersReducedMotion() ? "instant" : "smooth",
      });
    };

    const markUserScrollIntent = () => {
      userScrollIntentUntilRef.current =
        window.performance.now() + USER_SCROLL_INTENT_MS;
    };

    const onWheel = (event: WheelEvent) => {
      if (isInNestedOutput(event.target)) return;

      if (event.deltaY < 0) markUserScrollIntent();
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!isInScrollFooter(event.target) && !isInNestedOutput(event.target))
        markUserScrollIntent();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (
        event.button === 0 &&
        !isInScrollFooter(event.target) &&
        !isInNestedOutput(event.target)
      ) {
        pointerScrollIntentRef.current = true;
      }
    };

    const onPointerEnd = () => {
      pointerScrollIntentRef.current = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;

      if (
        !SCROLL_KEYS.has(event.key) ||
        isEditableKeyboardTarget(target) ||
        isInScrollFooter(target) ||
        isInNestedOutput(target) ||
        (target !== document.body &&
          !(target instanceof Node && scrollArea.contains(target)))
      ) {
        return;
      }

      markUserScrollIntent();
    };

    const onLayoutChange = () => latestRef.current.handleLayoutChange();

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(onLayoutChange);

    resizeObserver?.observe(scrollArea);
    resizeObserver?.observe(scrollContent);
    lastScrollTopRef.current = scrollArea.scrollTop;
    scrollArea.addEventListener("scroll", onScroll, { passive: true });
    scrollArea.addEventListener("wheel", onWheel, { passive: true });
    scrollArea.addEventListener("touchmove", onTouchMove, { passive: true });
    scrollArea.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);
    window.addEventListener("blur", onPointerEnd);
    scrollArea.addEventListener("contextmenu", onPointerEnd);
    document.addEventListener("keydown", onKeyDown);
    scrollArea.addEventListener(PAGE_SCROLL_TO_TOP_EVENT, onScrollToTop);
    onLayoutChange();

    return () => {
      resizeObserver?.disconnect();
      scrollArea.removeEventListener("scroll", onScroll);
      scrollArea.removeEventListener("wheel", onWheel);
      scrollArea.removeEventListener("touchmove", onTouchMove);
      scrollArea.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
      window.removeEventListener("blur", onPointerEnd);
      scrollArea.removeEventListener("contextmenu", onPointerEnd);
      document.removeEventListener("keydown", onKeyDown);
      scrollArea.removeEventListener(PAGE_SCROLL_TO_TOP_EVENT, onScrollToTop);

      if (scrollbarIdleTimeout !== null) {
        window.clearTimeout(scrollbarIdleTimeout);
      }

      scrollArea.removeAttribute("data-scrollbar-scrolling");

      if (followFrameRef.current !== null) {
        window.cancelAnimationFrame(followFrameRef.current);
        followFrameRef.current = null;
      }
    };
  }, []);

  const bottomAnchorContextValue = useMemo<BottomAnchorContextValue>(
    () => ({
      getScrollElement,
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      holdContentPosition,
    }),
    [
      getScrollElement,
      isAtBottom,
      scrollToBottom,
      scrollElementIntoView,
      scrollElementIntoViewClampedToMaxScroll,
      holdContentPosition,
    ],
  );

  return (
    <BottomAnchorContext.Provider value={bottomAnchorContextValue}>
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(auto,1fr)] overflow-hidden">
        <div
          ref={scrollAreaRef}
          data-page-scroll-viewport=""
          style={{ overflowAnchor: "none" }}
          className={cn(
            "thread-scrollbar @container/page col-start-1 row-start-1 min-h-0 overflow-x-hidden overflow-y-auto",
            scrollAreaClassName,
          )}
        >
          <div
            ref={scrollContentRef}
            className="flex min-h-full min-w-0 flex-col"
          >
            <div
              data-page-content-column=""
              className={cn(
                "mx-auto flex w-full min-w-0 flex-1 flex-col px-4 pb-4 pt-2",
                maxWidthClassName,
                contentClassName,
              )}
              style={PAGE_SHELL_CONTENT_STYLE}
            >
              {children}
            </div>
            {footer ? (
              <div
                ref={footerRef}
                data-scroll-footer=""
                className="sticky bottom-0 z-20 shrink-0"
              >
                {footer}
              </div>
            ) : null}
          </div>
        </div>
        {scrollOverlay ? (
          <div
            data-scroll-overlay=""
            className="pointer-events-none z-30 col-start-1 row-start-1 flex min-h-0 min-w-0 items-center justify-end px-3 py-3"
          >
            <div className="pointer-events-auto">{scrollOverlay}</div>
          </div>
        ) : null}
      </div>
    </BottomAnchorContext.Provider>
  );
}

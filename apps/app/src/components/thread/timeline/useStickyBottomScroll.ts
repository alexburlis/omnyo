import {
  useCallback,
  useEffect,
  useRef,
  type PointerEventHandler,
  type RefObject,
  type TouchEventHandler,
  type UIEventHandler,
  type WheelEventHandler,
} from "react";

interface StickyBottomScrollBinding<TElement extends HTMLElement> {
  contentRef: RefObject<HTMLDivElement | null>;
  onPointerDown: PointerEventHandler<TElement>;
  onScroll: UIEventHandler<TElement>;
  onTouchMove: TouchEventHandler<TElement>;
  onTouchStart: TouchEventHandler<TElement>;
  onWheel: WheelEventHandler<TElement>;
  ref: RefObject<TElement | null>;
}

interface UseStickyBottomScrollArgs {
  contentKey: string;
  streaming: boolean;
}

const STICKY_BOTTOM_THRESHOLD_PX = 4;

const USER_SCROLL_INTENT_MS = 350;

function getMaxScrollOffset(element: HTMLElement): number {
  return Math.max(0, element.scrollHeight - element.clientHeight);
}

export function useStickyBottomScroll<TElement extends HTMLElement>({
  contentKey,
  streaming,
}: UseStickyBottomScrollArgs): StickyBottomScrollBinding<TElement> {
  const scrollRef = useRef<TElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const pointerScrollIntentRef = useRef(false);
  const userScrollIntentUntilRef = useRef(0);
  const wasStreamingRef = useRef(streaming);
  const maxScrollOffsetRef = useRef(0);

  const refreshMaxScrollOffset = useCallback((element: TElement): number => {
    const nextOffset = getMaxScrollOffset(element);
    maxScrollOffsetRef.current = nextOffset;

    return nextOffset;
  }, []);

  useEffect(() => {
    const element = scrollRef.current;

    if (!element) return;
    refreshMaxScrollOffset(element);

    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      refreshMaxScrollOffset(element);
    });

    observer.observe(element);
    const content = contentRef.current;

    if (content) {
      observer.observe(content);
    }

    return () => observer.disconnect();
  }, [refreshMaxScrollOffset]);

  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;

    if (!streaming && !wasStreaming) {
      return;
    }

    const element = scrollRef.current;

    if (!element || !shouldStickToBottomRef.current) {
      return;
    }

    element.scrollTop = refreshMaxScrollOffset(element);
  }, [contentKey, refreshMaxScrollOffset, streaming]);

  const markUserScrollIntent = useCallback(() => {
    userScrollIntentUntilRef.current =
      window.performance.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const onPointerDown = useCallback<PointerEventHandler<TElement>>(() => {
    pointerScrollIntentRef.current = true;
  }, []);

  const onPointerEnd = useCallback(() => {
    pointerScrollIntentRef.current = false;
  }, []);

  const onScroll = useCallback<UIEventHandler<TElement>>((event) => {
    if (
      maxScrollOffsetRef.current - event.currentTarget.scrollTop <=
      STICKY_BOTTOM_THRESHOLD_PX
    ) {
      shouldStickToBottomRef.current = true;

      return;
    }

    const hasUserScrollIntent =
      pointerScrollIntentRef.current ||
      window.performance.now() <= userScrollIntentUntilRef.current;

    if (hasUserScrollIntent) {
      shouldStickToBottomRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (!streaming) {
      return;
    }

    window.addEventListener("pointerup", onPointerEnd);
    window.addEventListener("pointercancel", onPointerEnd);

    return () => {
      window.removeEventListener("pointerup", onPointerEnd);
      window.removeEventListener("pointercancel", onPointerEnd);
    };
  }, [onPointerEnd, streaming]);

  return {
    contentRef,
    onPointerDown,
    onScroll,
    onTouchMove: markUserScrollIntent,
    onTouchStart: markUserScrollIntent,
    onWheel: markUserScrollIntent,
    ref: scrollRef,
  };
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, ReactNode } from "react";

const OPEN_DELAY_MS = 350;

const EDGE = 8;

const GAP = 6;

export interface HintTrigger {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onPointerDown: () => void;
  onFocus: (event: FocusEvent<HTMLElement>) => void;
  onBlur: () => void;
}

export interface Hint<T extends HTMLElement> {
  ref: (element: T | null) => void;
  trigger: HintTrigger;
  hint: ReactNode;
}

export function useHint<T extends HTMLElement>(text: string): Hint<T> {
  const [open, setOpen] = useState(false);
  const anchor = useRef<T | null>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const hide = useCallback(() => {
    cancel();
    setOpen(false);
  }, [cancel]);

  useEffect(() => cancel, [cancel]);

  useEffect(() => {
    if (!open) return;

    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    window.addEventListener("keydown", close, true);
    window.addEventListener("scroll", hide, true);

    return () => {
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("scroll", hide, true);
    };
  }, [open, hide]);

  useLayoutEffect(() => {
    const element = bubble.current;
    const target = anchor.current;

    if (element === null || target === null || !open) return;

    if (!element.matches(":popover-open")) element.showPopover();
    const rect = target.getBoundingClientRect();
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const above = rect.top - GAP - height;
    const top = above >= EDGE ? above : rect.bottom + GAP;

    const left = Math.min(
      Math.max(EDGE, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - EDGE,
    );

    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
    element.dataset.side = above >= EDGE ? "top" : "bottom";

    return () => {
      if (element.matches(":popover-open")) element.hidePopover();
    };
  }, [open, text]);

  const ref = useCallback((element: T | null) => {
    anchor.current = element;
  }, []);

  return {
    ref,
    trigger: {
      onPointerEnter: () => {
        cancel();
        timer.current = setTimeout(() => setOpen(true), OPEN_DELAY_MS);
      },
      onPointerLeave: hide,
      onPointerDown: hide,
      onFocus: (event) => {
        if (event.currentTarget.matches(":focus-visible")) setOpen(true);
      },
      onBlur: hide,
    },
    hint: open ? (
      <span ref={bubble} popover="manual" className="ct-tip" aria-hidden>
        {text}
      </span>
    ) : null,
  };
}

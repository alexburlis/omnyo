import * as React from "react";


const PERSISTENT_DRAWER_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

type PersistentDrawerStackEntry = {
  panel: () => HTMLElement | null;
  dismissOnEscape: (event: KeyboardEvent) => void;
};

type PersistentDrawerStack = {
  entries: PersistentDrawerStackEntry[];
  handleKeyDown: (event: KeyboardEvent) => void;
};

const PERSISTENT_DRAWER_STACK_KEY = Symbol.for("omnyo.persistent-drawer-stack.v1");

function isPersistentDrawerStack(
  value: unknown,
): value is PersistentDrawerStack {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries) &&
    "handleKeyDown" in value &&
    typeof value.handleKeyDown === "function"
  );
}

function readPersistentDrawerStack(
  ownerDocument: Document,
): PersistentDrawerStack | undefined {
  const stack: unknown = Reflect.get(
    ownerDocument,
    PERSISTENT_DRAWER_STACK_KEY,
  );

  return isPersistentDrawerStack(stack) ? stack : undefined;
}

function getDrawerFocusableElements(panel: HTMLElement): HTMLElement[] {
  return Array.from(
    panel.querySelectorAll<HTMLElement>(PERSISTENT_DRAWER_FOCUSABLE_SELECTOR),
  ).filter(
    (element) => element.closest('[aria-hidden="true"], [inert]') === null,
  );
}

function activeElementIsInAnotherOverlay(
  activeElement: Element | null,
  panel: HTMLElement,
): boolean {
  const overlay = activeElement?.closest<HTMLElement>(
    "[data-omnyo-portaled-overlay]",
  );

  return overlay !== null && overlay !== undefined && overlay !== panel;
}

function handleDrawerTab(event: KeyboardEvent, panel: HTMLElement): void {
  const activeElement = panel.ownerDocument.activeElement;

  if (
    !panel.contains(activeElement) &&
    activeElementIsInAnotherOverlay(activeElement, panel)
  ) {
    return;
  }

  const focusable = getDrawerFocusableElements(panel);
  event.preventDefault();

  if (focusable.length === 0) {
    panel.focus({ preventScroll: true });

    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (event.shiftKey) {
    if (
      !panel.contains(activeElement) ||
      activeElement === panel ||
      activeElement === first
    ) {
      last?.focus({ preventScroll: true });

      return;
    }

    const index = focusable.indexOf(activeElement as HTMLElement);
    focusable[Math.max(0, index - 1)]?.focus({ preventScroll: true });

    return;
  }

  if (
    !panel.contains(activeElement) ||
    activeElement === panel ||
    activeElement === last
  ) {
    first?.focus({ preventScroll: true });

    return;
  }

  const index = focusable.indexOf(activeElement as HTMLElement);
  focusable[Math.min(focusable.length - 1, index + 1)]?.focus({
    preventScroll: true,
  });
}

function registerOpenDrawer(
  ownerDocument: Document,
  entry: PersistentDrawerStackEntry,
): () => void {
  let stack = readPersistentDrawerStack(ownerDocument);

  if (stack === undefined) {
    const entries: PersistentDrawerStackEntry[] = [];

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }

      const topEntry = entries[entries.length - 1];
      const panel = topEntry?.panel() ?? null;

      if (topEntry === undefined || panel === null) {
        return;
      }

      if (event.key === "Escape") {
        topEntry.dismissOnEscape(event);
        event.preventDefault();
      } else if (event.key === "Tab") {
        handleDrawerTab(event, panel);
      }
    };

    stack = { entries, handleKeyDown };
    Reflect.set(ownerDocument, PERSISTENT_DRAWER_STACK_KEY, stack);
    ownerDocument.addEventListener("keydown", handleKeyDown);
  }

  stack.entries.push(entry);

  return () => {
    const currentStack = readPersistentDrawerStack(ownerDocument);

    if (currentStack === undefined) {
      return;
    }

    const index = currentStack.entries.indexOf(entry);

    if (index >= 0) {
      currentStack.entries.splice(index, 1);
    }

    if (currentStack.entries.length === 0) {
      ownerDocument.removeEventListener("keydown", currentStack.handleKeyDown);
      Reflect.deleteProperty(ownerDocument, PERSISTENT_DRAWER_STACK_KEY);
    }
  };
}

interface UsePersistentOverlayFocusArgs {
  onAfterCloseAutoFocus?: () => void;
  onBeforeCloseAutoFocus?: () => void;
  onEscapeKeyDown?: (event: KeyboardEvent) => void;
  open: boolean;
  panelRef: React.RefObject<HTMLElement | null>;
  requestClose: () => void;
}

export function usePersistentOverlayFocus({
  onAfterCloseAutoFocus,
  onBeforeCloseAutoFocus,
  onEscapeKeyDown,
  open,
  panelRef,
  requestClose,
}: UsePersistentOverlayFocusArgs): void {
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const onEscapeKeyDownRef = React.useRef(onEscapeKeyDown);
  React.useLayoutEffect(() => {
    onEscapeKeyDownRef.current = onEscapeKeyDown;
  }, [onEscapeKeyDown]);

  React.useLayoutEffect(() => {
    if (!open) return;
    const panel = panelRef.current;

    if (panel === null) return;
    const ownerDocument = panel.ownerDocument;
    const previousFocus = ownerDocument.activeElement;
    returnFocusRef.current =
      previousFocus instanceof HTMLElement &&
      previousFocus !== ownerDocument.body
        ? previousFocus
        : null;

    const unregister = registerOpenDrawer(ownerDocument, {
      panel: () => panelRef.current,
      dismissOnEscape: (event) => {
        onEscapeKeyDownRef.current?.(event);

        if (!event.defaultPrevented) requestClose();
      },
    });

    panel.focus({ preventScroll: true });

    return unregister;
  }, [open, panelRef, requestClose]);

  const previousOpenRef = React.useRef(open);
  React.useLayoutEffect(() => {
    let cancelDeferredFocus: (() => void) | undefined;

    if (previousOpenRef.current && !open) {
      onBeforeCloseAutoFocus?.();
      const returnFocus = returnFocusRef.current;

      if (
        returnFocus?.isConnected &&
        returnFocus.closest('[aria-hidden="true"], [inert]') === null
      ) {
        returnFocus.focus({ preventScroll: true });

        if (returnFocus.ownerDocument.activeElement !== returnFocus) {
          const ownerWindow = returnFocus.ownerDocument.defaultView;

          if (ownerWindow !== null) {
            const frame = ownerWindow.requestAnimationFrame(() => {
              if (
                returnFocus.isConnected &&
                returnFocus.closest('[aria-hidden="true"], [inert]') === null
              ) {
                returnFocus.focus({ preventScroll: true });
              }

              onAfterCloseAutoFocus?.();
            });

            cancelDeferredFocus = () => ownerWindow.cancelAnimationFrame(frame);
          }
        }
      }

      returnFocusRef.current = null;

      if (cancelDeferredFocus === undefined) {
        onAfterCloseAutoFocus?.();
      }
    }

    previousOpenRef.current = open;

    return cancelDeferredFocus;
  }, [onAfterCloseAutoFocus, onBeforeCloseAutoFocus, open]);
}

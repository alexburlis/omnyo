export function findTouchById(touches: TouchList, id: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);

    if (touch?.identifier === id) return touch;
  }

  return null;
}

export function isHorizontallyScrollableElement(element: Element): boolean {
  const view = element.ownerDocument.defaultView;

  if (view === null || !(element instanceof view.HTMLElement)) return false;
  const overflowX = view.getComputedStyle(element).overflowX;

  return (
    (overflowX === "auto" ||
      overflowX === "scroll" ||
      overflowX === "overlay") &&
    element.scrollWidth > element.clientWidth + 1
  );
}

export function hasTextSelectionWithin(root: Element): boolean {
  const selection = root.ownerDocument.getSelection();

  if (selection === null || selection.isCollapsed) return false;

  return (
    (selection.anchorNode !== null && root.contains(selection.anchorNode)) ||
    (selection.focusNode !== null && root.contains(selection.focusNode))
  );
}

export function listenToGesture<K extends keyof GlobalEventHandlersEventMap>(
  origin: EventTarget | null,
  type: K,
  listener: (event: GlobalEventHandlersEventMap[K]) => void,
  options?: AddEventListenerOptions,
): () => void {
  let lastEvent: Event | null = null;

  const handle = (event: GlobalEventHandlersEventMap[K]) => {
    if (event === lastEvent) return;
    lastEvent = event;
    listener(event);
  };

  window.addEventListener(type, handle, options);

  if (!(origin instanceof HTMLElement || origin instanceof SVGElement)) {
    return () => window.removeEventListener(type, handle, options);
  }

  const element = origin;
  const target: GlobalEventHandlers = element;

  const handleDetached = (event: GlobalEventHandlersEventMap[K]) => {
    if (element.isConnected) return;
    handle(event);
  };

  target.addEventListener(type, handleDetached, options);

  return () => {
    window.removeEventListener(type, handle, options);
    target.removeEventListener(type, handleDetached, options);
  };
}

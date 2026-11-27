import { useLayoutEffect } from "react";

const countKey = Symbol.for("omnyo.browser-dimming-modal-count.v1");

const changeEvent = "omnyo:browser-dimming-modal-change";

function changeCount(delta: number): void {
  const owner: Window & { [countKey]?: number } = window;
  owner[countKey] = (owner[countKey] ?? 0) + delta;
  window.dispatchEvent(new Event(changeEvent));
}

export function useBrowserDimmingModal(active: boolean): void {
  useLayoutEffect(() => {
    if (!active) return;
    changeCount(1);

    return () => changeCount(-1);
  }, [active]);
}

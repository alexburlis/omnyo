// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useIsBrowserViewOccluded } from "./useIsBrowserViewOccluded";

function placeAt(
  element: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  element.getBoundingClientRect = () =>
    DOMRect.fromRect({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
}

function mountOverlay(
  rect: { left: number; top: number; width: number; height: number },
  role?: string,
): HTMLElement {
  const portal = document.createElement("div");
  const overlay = document.createElement("div");
  overlay.setAttribute("data-omnyo-portaled-overlay", "");

  if (role !== undefined) {
    const hidden = document.createElement("span");
    hidden.setAttribute("role", role);
    overlay.append(hidden);
  }

  placeAt(overlay, rect);
  portal.append(overlay);
  document.body.append(portal);

  return portal;
}

async function flushChecks(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}

describe("useIsBrowserViewOccluded", () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function renderWithContent() {
    const content = document.createElement("div");
    placeAt(content, { left: 400, top: 0, width: 600, height: 800 });
    document.body.append(content);

    return renderHook(() =>
      useIsBrowserViewOccluded({ current: content }, true),
    );
  }

  it("hides the page while a popover overlaps it and restores it on close", async () => {
    vi.useFakeTimers();
    const { result } = renderWithContent();
    expect(result.current).toBe(false);

    const portal = mountOverlay({
      left: 700,
      top: 600,
      width: 320,
      height: 220,
    });

    await flushChecks();
    expect(result.current).toBe(true);

    portal.remove();
    await flushChecks();
    expect(result.current).toBe(false);
  });

  it("keeps the page visible for popovers elsewhere and for tooltips", async () => {
    vi.useFakeTimers();
    const { result } = renderWithContent();

    mountOverlay({ left: 0, top: 600, width: 320, height: 200 });
    mountOverlay({ left: 500, top: 10, width: 80, height: 24 }, "tooltip");
    await flushChecks();

    expect(result.current).toBe(false);
  });
});

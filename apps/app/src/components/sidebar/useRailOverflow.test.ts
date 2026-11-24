// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { railFadeMaskStyle, useRailScrollFades } from "./useRailOverflow";

const observers: { callback: () => void; targets: Element[] }[] = [];

class ControlledResizeObserver {
  private readonly entry: { callback: () => void; targets: Element[] };

  constructor(callback: () => void) {
    this.entry = { callback, targets: [] };
    observers.push(this.entry);
  }

  observe(target: Element) {
    this.entry.targets.push(target);
  }

  unobserve() {}

  disconnect() {
    this.entry.targets = [];
  }
}

function resize() {
  act(() => {
    for (const observer of observers) {
      if (observer.targets.length > 0) observer.callback();
    }
  });
}

function setMetrics(
  element: HTMLElement,
  metrics: { clientHeight?: number; scrollHeight?: number; scrollTop?: number },
) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useRailScrollFades", () => {
  it("fades only the edges that hide projects", () => {
    const scroller = document.createElement("div");
    const content = document.createElement("div");
    scroller.append(content);

    const { result } = renderHook(() =>
      useRailScrollFades({ current: scroller }, { current: content }),
    );

    expect(result.current).toEqual({
      overflows: false,
      fadeTop: false,
      fadeBottom: false,
    });

    setMetrics(scroller, {
      clientHeight: 200,
      scrollHeight: 500,
      scrollTop: 0,
    });
    resize();
    expect(result.current).toEqual({
      overflows: true,
      fadeTop: false,
      fadeBottom: true,
    });

    setMetrics(scroller, { scrollTop: 120 });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toEqual({
      overflows: true,
      fadeTop: true,
      fadeBottom: true,
    });

    setMetrics(scroller, { scrollTop: 300 });
    act(() => {
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(result.current).toEqual({
      overflows: true,
      fadeTop: true,
      fadeBottom: false,
    });
  });

  it("sets the standard and WebKit masks together", () => {
    expect(
      railFadeMaskStyle({
        overflows: false,
        fadeTop: false,
        fadeBottom: false,
      }),
    ).toBeUndefined();

    const style = railFadeMaskStyle({
      overflows: true,
      fadeTop: true,
      fadeBottom: true,
    });

    expect(style?.maskImage).toBe(
      "linear-gradient(to bottom, transparent 0, #000 28px, #000 calc(100% - 40px), transparent 100%)",
    );
    expect(style?.WebkitMaskImage).toBe(style?.maskImage);
  });
});

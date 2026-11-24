// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPluginCss,
  resetPluginCssForTest,
  useAllPluginCssSettled,
  usePluginCss,
  usePluginCssReady,
} from "./plugin-css";

const DEMO_STYLESHEET = 'link[data-omnyo-plugin-css="demo"]';

function dispatchLinkEvent(selector: string, type: "load" | "error"): void {
  act(() => {
    document.head.querySelector(selector)?.dispatchEvent(new Event(type));
  });
}

function useMountedPluginCssReady(pluginId: string): boolean {
  usePluginCss(pluginId);

  return usePluginCssReady(pluginId);
}

afterEach(() => {
  cleanup();
  resetPluginCssForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePluginCssReady", () => {
  it("holds a plugin until its stylesheet loads", () => {
    applyPluginCss("demo", "/demo.css?h=1");
    const { result } = renderHook(() => useMountedPluginCssReady("demo"));

    expect(result.current).toBe(false);
    dispatchLinkEvent(DEMO_STYLESHEET, "load");
    expect(result.current).toBe(true);
  });

  it("treats a stylesheet that failed to load as ready", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyPluginCss("demo", "/demo.css?h=1");
    const { result } = renderHook(() => useMountedPluginCssReady("demo"));

    expect(result.current).toBe(false);
    dispatchLinkEvent(DEMO_STYLESHEET, "error");
    expect(result.current).toBe(true);
  });

  it("is ready at once for a plugin without a stylesheet", () => {
    const { result } = renderHook(() => useMountedPluginCssReady("plain"));

    expect(result.current).toBe(true);
  });

  it("is ready at once on a remount after the release grace removed an applied stylesheet", async () => {
    vi.useFakeTimers();
    applyPluginCss("demo", "/demo.css?h=1");
    const first = renderHook(() => useMountedPluginCssReady("demo"));
    dispatchLinkEvent(DEMO_STYLESHEET, "load");
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(document.head.querySelector(DEMO_STYLESHEET)).toBeNull();

    const second = renderHook(() => useMountedPluginCssReady("demo"));

    expect(second.result.current).toBe(true);
  });

  it("keeps a mounted plugin ready while its replacement stylesheet loads", () => {
    applyPluginCss("demo", "/demo.css?h=1");
    const { result } = renderHook(() => useMountedPluginCssReady("demo"));
    dispatchLinkEvent(DEMO_STYLESHEET, "load");

    act(() => applyPluginCss("demo", "/demo.css?h=2"));

    expect(result.current).toBe(true);
  });
});

describe("useAllPluginCssSettled", () => {
  it("waits until every plugin stylesheet has applied, preloaded or failed", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    applyPluginCss("mounted", "/mounted.css");
    applyPluginCss("idle", "/idle.css");
    applyPluginCss("broken", "/broken.css");

    const { result } = renderHook(() => {
      usePluginCss("mounted");

      return useAllPluginCssSettled();
    });

    expect(result.current).toBe(false);
    dispatchLinkEvent('link[data-omnyo-plugin-css="mounted"]', "load");
    expect(result.current).toBe(false);
    dispatchLinkEvent('link[data-omnyo-plugin-css-preload="idle"]', "load");
    expect(result.current).toBe(false);
    dispatchLinkEvent('link[data-omnyo-plugin-css-preload="broken"]', "error");
    expect(result.current).toBe(true);
  });
});

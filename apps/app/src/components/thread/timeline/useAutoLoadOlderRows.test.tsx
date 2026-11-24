// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { BottomAnchorContext } from "@/components/ui/bottom-anchored-scroll-body.js";
import type { BottomAnchorContextValue } from "@/components/ui/bottom-anchored-scroll-body.js";
import { useAutoLoadOlderRows } from "./useAutoLoadOlderRows.js";

interface ScrollGeometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

function createScrollElement(geometry: ScrollGeometry) {
  const element = document.createElement("div");
  const state = { ...geometry };
  Object.defineProperty(element, "clientHeight", {
    configurable: true,
    get: () => state.clientHeight,
  });
  Object.defineProperty(element, "scrollHeight", {
    configurable: true,
    get: () => state.scrollHeight,
  });
  element.scrollTop = state.scrollTop;

  const scrollTo = (top: number) => {
    act(() => {
      element.scrollTop = top;
      element.dispatchEvent(new Event("scroll"));
    });
  };

  return { element, state, scrollTo };
}

function createBottomAnchor(element: HTMLElement): BottomAnchorContextValue {
  return {
    getScrollElement: () => element,
    isAtBottom: false,
    scrollToBottom: vi.fn(),
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    holdContentPosition: vi.fn(),
  };
}

function renderAutoLoad(args: {
  anchor: BottomAnchorContextValue | null;
  onLoadOlderRows: () => Promise<void> | void;
}) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    args.anchor === null ? (
      <>{children}</>
    ) : (
      <BottomAnchorContext.Provider value={args.anchor}>
        {children}
      </BottomAnchorContext.Provider>
    );

  return renderHook(
    ({ isLoading }: { isLoading: boolean }) =>
      useAutoLoadOlderRows({
        hasOlderTimelineRows: true,
        isLoadingOlderTimelineRows: isLoading,
        onLoadOlderRows: args.onLoadOlderRows,
      }),
    { initialProps: { isLoading: false }, wrapper },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useAutoLoadOlderRows", () => {
  it("fills an unfilled viewport and stops once the content overflows", async () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 400,
      scrollTop: 0,
    });

    const onLoadOlderRows = vi.fn(async () => {
      scroll.state.scrollHeight += 600;
    });

    const view = renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    await act(async () => {});
    view.rerender({ isLoading: true });
    view.rerender({ isLoading: false });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
  });

  it("loads only when the reader scrolls upward near the top", () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 20_000,
      scrollTop: 10_000,
    });

    const onLoadOlderRows = vi.fn();
    renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    scroll.scrollTo(5_000);
    expect(onLoadOlderRows).not.toHaveBeenCalled();
    scroll.scrollTo(600);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
  });

  it("never loads while scrolling down, even close to the top", () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 20_000,
      scrollTop: 0,
    });

    const onLoadOlderRows = vi.fn();
    renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    scroll.scrollTo(300);
    scroll.scrollTo(700);
    expect(onLoadOlderRows).not.toHaveBeenCalled();
  });

  it("does not chain another page after a load settles without new upward scrolling", async () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 20_000,
      scrollTop: 2_000,
    });

    const onLoadOlderRows = vi.fn(async () => {});

    const view = renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    scroll.scrollTo(200);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
    view.rerender({ isLoading: true });
    await act(async () => {});
    scroll.state.scrollHeight += 500;
    scroll.scrollTo(700);
    view.rerender({ isLoading: false });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);

    scroll.scrollTo(400);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });

  it("loads when the reader wheels up while already at the very top", () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 20_000,
      scrollTop: 0,
    });

    const onLoadOlderRows = vi.fn();
    renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    act(() => {
      scroll.element.dispatchEvent(new WheelEvent("wheel", { deltaY: -40 }));
    });
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);
  });

  it("stays manual with no bottom anchor to keep the reading position", () => {
    const onLoadOlderRows = vi.fn();
    const view = renderAutoLoad({ anchor: null, onLoadOlderRows });

    expect(view.result.current.isAutoLoadEnabled).toBe(false);
    expect(onLoadOlderRows).not.toHaveBeenCalled();
  });

  it("stops auto-loading after a failure until the reader retries", async () => {
    const scroll = createScrollElement({
      clientHeight: 800,
      scrollHeight: 20_000,
      scrollTop: 2_000,
    });

    const onLoadOlderRows = vi.fn(async () => {
      throw new Error("offline");
    });

    const view = renderAutoLoad({
      anchor: createBottomAnchor(scroll.element),
      onLoadOlderRows,
    });

    scroll.scrollTo(200);
    await act(async () => {});
    expect(view.result.current.isAutoLoadEnabled).toBe(false);
    scroll.scrollTo(2_000);
    scroll.scrollTo(100);
    expect(onLoadOlderRows).toHaveBeenCalledTimes(1);

    act(() => view.result.current.loadOlderRows());
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });
});

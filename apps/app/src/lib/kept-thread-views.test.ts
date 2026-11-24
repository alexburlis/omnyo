// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function loadStore() {
  vi.resetModules();

  return import("./kept-thread-views");
}

const view = (threadId: string) => ({ projectId: "project-1", threadId });

describe("kept thread views", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("evicts the least recently used chat but never a shown one", async () => {
    const store = await loadStore();
    store.showThreadView("pane-1", view("shown"));
    store.focusThreadViewScope("pane-1");

    for (let index = 0; index < store.KEPT_THREAD_VIEW_LIMIT + 2; index += 1)
      store.keepThreadView(view(`intent-${index}`));

    const { result } = renderHook(() =>
      store.useKeptThreadViews("pane-1", view("shown")),
    );

    const ids = result.current.map((entry) => entry.threadId);

    expect(ids).toHaveLength(store.KEPT_THREAD_VIEW_LIMIT);
    expect(ids).toContain("shown");
    expect(ids).not.toContain("intent-0");
    expect(ids).not.toContain("intent-1");
  });

  it("keeps existing chats in place when one is shown again", async () => {
    const store = await loadStore();
    store.showThreadView("pane-1", view("first"));
    store.showThreadView("pane-1", view("second"));
    store.showThreadView("pane-1", view("first"));

    const { result } = renderHook(() =>
      store.useKeptThreadViews("pane-1", view("first")),
    );

    expect(result.current.map((entry) => entry.threadId)).toEqual([
      "first",
      "second",
    ]);
  });

  it("renders the routed chat before the store has recorded it", async () => {
    const store = await loadStore();
    store.showThreadView("pane-1", view("earlier"));

    const { result } = renderHook(() =>
      store.useKeptThreadViews("pane-1", view("next")),
    );

    expect(result.current.map((entry) => entry.threadId)).toEqual([
      "earlier",
      "next",
    ]);
  });

  it("keeps each pane's chats separate and sends intent to the focused pane", async () => {
    const store = await loadStore();
    store.showThreadView("left", view("left-chat"));
    store.showThreadView("right", view("right-chat"));
    store.focusThreadViewScope("right");
    store.keepThreadView(view("hovered"));

    const left = renderHook(() =>
      store.useKeptThreadViews("left", view("left-chat")),
    );

    const right = renderHook(() =>
      store.useKeptThreadViews("right", view("right-chat")),
    );

    expect(left.result.current.map((entry) => entry.threadId)).toEqual([
      "left-chat",
    ]);
    expect(right.result.current.map((entry) => entry.threadId)).toEqual([
      "right-chat",
      "hovered",
    ]);

    store.releaseThreadViewScope("right");
    store.keepThreadView(view("ignored"));
    right.rerender();

    expect(right.result.current.map((entry) => entry.threadId)).toEqual([
      "right-chat",
    ]);
  });

  it("keeps rendered chats in their first order as chats are added and removed", async () => {
    const store = await loadStore();

    const { result, rerender } = renderHook(
      ({ views }) => store.useStableThreadViewOrder(views),
      { initialProps: { views: [view("a"), view("b")] } },
    );

    rerender({ views: [view("c"), view("b"), view("a")] });
    expect(result.current.map((entry) => entry.threadId)).toEqual([
      "a",
      "b",
      "c",
    ]);

    rerender({ views: [view("c"), view("a")] });
    expect(result.current.map((entry) => entry.threadId)).toEqual(["a", "c"]);
  });
});

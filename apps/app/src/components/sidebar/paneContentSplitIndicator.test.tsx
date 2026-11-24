// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { createStore, Provider } from "jotai";
import { useMemo, type ReactNode } from "react";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import type { LayoutNode, PaneContent, SplitLayout } from "@/lib/split-layout";
import { usePaneContentSplitIndicator } from "./paneContentSplitIndicator";

const { compactState } = vi.hoisted(() => ({
  compactState: { value: false },
}));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => compactState.value,
}));

function content(threadId: string): PaneContent {
  return { kind: "thread", projectId: "p1", threadId };
}

function pane(paneId: string, threadId: string): LayoutNode {
  return { type: "pane", paneId, content: content(threadId) };
}

function twoPanes(focused: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId: focused,
  };
}

function split(sizes: [number, number], focusedPaneId: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes,
      children: [pane("pane-1", "t1"), pane("pane-2", "t2")],
    },
    focusedPaneId,
  };
}

function singlePane(threadId: string): SplitLayout {
  return { root: pane("pane-1", threadId), focusedPaneId: "pane-1" };
}

const rowRenders = vi.fn<(threadId: string) => void>();

function Row({ threadId }: { threadId: string }) {
  const rowContent = useMemo(() => content(threadId), [threadId]);
  const indicator = usePaneContentSplitIndicator(rowContent, true);
  rowRenders(threadId);

  return <div data-in-split={indicator.isOpenInSplit} />;
}

function renderRows(layout: SplitLayout) {
  const store = createStore();
  store.set(splitLayoutAtom, layout);
  render(
    <Provider store={store}>
      {["t1", "t2", "t3", "t4"].map((threadId) => (
        <Row key={threadId} threadId={threadId} />
      ))}
    </Provider>,
  );
  rowRenders.mockClear();

  return store;
}

function renderedRows(): string[] {
  return rowRenders.mock.calls.map(([threadId]) => threadId).sort();
}

function renderIndicator(threadId: string) {
  const store = createStore();
  store.set(splitLayoutAtom, twoPanes("pane-1"));

  const wrapper = ({ children }: { children: ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );

  let renders = 0;
  const target = content(threadId);

  const { result } = renderHook(
    () => {
      renders += 1;

      return usePaneContentSplitIndicator(target, true);
    },
    { wrapper },
  );

  return { store, result, renderCount: () => renders };
}

beforeEach(() => {
  compactState.value = false;
});

afterEach(() => {
  cleanup();
  rowRenders.mockClear();
});

describe("usePaneContentSplitIndicator", () => {
  it("does not re-render for split layout changes on compact viewports", () => {
    compactState.value = true;
    const { store, result, renderCount } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(false);
    const settled = renderCount();

    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(renderCount()).toBe(settled);
    expect(result.current.isOpenInSplit).toBe(false);
  });

  it("follows the split layout on wide viewports", () => {
    const { store, result } = renderIndicator("t1");
    expect(result.current.isOpenInSplit).toBe(true);
    expect(result.current.miniMap?.find((slot) => slot.isMe)?.paneId).toBe(
      "pane-1",
    );
    act(() => {
      store.set(splitLayoutAtom, twoPanes("pane-2"));
    });
    expect(result.current.miniMap?.find((slot) => slot.isFocused)?.paneId).toBe(
      "pane-2",
    );
  });

  it("re-renders only the rows open in the split when the layout changes", () => {
    const store = renderRows(split([0.5, 0.5], "pane-1"));

    act(() => {
      store.set(splitLayoutAtom, split([0.5, 0.5], "pane-2"));
    });
    expect(renderedRows()).toEqual(["t1", "t2"]);

    rowRenders.mockClear();
    act(() => {
      store.set(splitLayoutAtom, split([0.6, 0.4], "pane-2"));
    });
    expect(renderedRows()).toEqual(["t1", "t2"]);

    rowRenders.mockClear();
    act(() => {
      store.set(splitLayoutAtom, split([0.6, 0.4], "pane-2"));
    });
    expect(renderedRows()).toEqual([]);
  });

  it("re-renders no row when a single pane switches to another chat", () => {
    const store = renderRows(singlePane("t3"));

    act(() => {
      store.set(splitLayoutAtom, singlePane("t4"));
    });
    expect(renderedRows()).toEqual([]);
  });
});

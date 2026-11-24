// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BottomAnchoredScrollBody,
  useBottomAnchoredScroll,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body";
import { PAGE_SCROLL_TO_TOP_EVENT } from "@/lib/page-scroll-to-top";

const VIEWPORT_HEIGHT = 500;

class ResizeObserverMock implements ResizeObserver {
  static instances: ResizeObserverMock[] = [];
  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverMock.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function relayout() {
  act(() => {
    for (const observer of ResizeObserverMock.instances) {
      observer.callback([], observer);
    }
  });
}

interface Layout {
  heights: Map<string, number>;
  order: string[];
  footerHeight: number;
}

function installLayout(viewport: HTMLElement, layout: Layout) {
  let scrollTop = 0;

  const totalHeight = () =>
    layout.order.reduce((sum, id) => sum + (layout.heights.get(id) ?? 0), 0) +
    layout.footerHeight;

  const maxScroll = () => Math.max(0, totalHeight() - VIEWPORT_HEIGHT);

  Object.defineProperty(viewport, "clientHeight", {
    configurable: true,
    get: () => VIEWPORT_HEIGHT,
  });
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => Math.max(VIEWPORT_HEIGHT, totalHeight()),
  });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.min(maxScroll(), Math.max(0, value));
    },
  });
  vi.spyOn(viewport, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 100, VIEWPORT_HEIGHT),
  );
  const footer = viewport.querySelector("[data-scroll-footer]");

  if (footer) {
    Object.defineProperty(footer, "offsetHeight", {
      configurable: true,
      get: () => layout.footerHeight,
    });
  }

  const placeRows = () => {
    for (const row of viewport.querySelectorAll<HTMLElement>(
      "[data-timeline-row-id]",
    )) {
      vi.spyOn(row, "getBoundingClientRect").mockImplementation(() => {
        const id = row.dataset.timelineRowId ?? "";
        const index = layout.order.indexOf(id);
        let top = 0;

        for (const previous of layout.order.slice(0, index)) {
          top += layout.heights.get(previous) ?? 0;
        }

        return new DOMRect(
          0,
          top - scrollTop,
          100,
          layout.heights.get(id) ?? 0,
        );
      });
    }
  };

  return {
    maxScroll,
    placeRows,
    userScrollTo(top: number) {
      act(() => {
        viewport.dispatchEvent(
          new WheelEvent("wheel", { deltaY: top - viewport.scrollTop }),
        );
        viewport.scrollTop = top;
        viewport.dispatchEvent(new Event("scroll"));
      });
    },
    clampToContent() {
      viewport.scrollTop = viewport.scrollTop;
    },
    deliverScrollEvent() {
      act(() => {
        viewport.dispatchEvent(new Event("scroll"));
      });
    },
    rowTop(id: string) {
      const row = viewport.querySelector<HTMLElement>(
        `[data-timeline-row-id="${id}"]`,
      );

      if (!row) throw new Error(`Missing row ${id}`);

      return row.getBoundingClientRect().top;
    },
  };
}

function rowIds(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${index}`);
}

let anchorApi: BottomAnchorContextValue | null = null;

function Probe() {
  anchorApi = useBottomAnchoredScroll();

  return null;
}

function renderTimeline({
  ids,
  heights,
  footer = null,
  footerHeight = 0,
}: {
  ids: string[];
  heights: Map<string, number>;
  footer?: ReactNode;
  footerHeight?: number;
}) {
  const layout: Layout = { heights, order: ids, footerHeight };

  const tree = (order: string[]) => (
    <BottomAnchoredScrollBody
      footer={footer}
      maxWidthClassName="max-w-none"
      animateFollowLatest={false}
    >
      <Probe />
      <div data-timeline-row-list="top-level">
        {order.map((id) => (
          <div key={id} data-timeline-row-id={id}>
            {id}
          </div>
        ))}
      </div>
    </BottomAnchoredScrollBody>
  );

  const view = render(tree(ids));

  const viewport = view.container.querySelector<HTMLElement>(
    "[data-page-scroll-viewport]",
  );

  if (!viewport) throw new Error("Missing viewport");
  const geometry = installLayout(viewport, layout);
  geometry.placeRows();
  relayout();

  return {
    ...geometry,
    layout,
    viewport,
    unmount: view.unmount,
    commitRows(order: string[]) {
      layout.order = order;
      view.rerender(tree(order));
      geometry.placeRows();
    },
    setRows(order: string[]) {
      this.commitRows(order);
      relayout();
    },
    resizeRow(id: string, height: number) {
      heights.set(id, height);
      relayout();
    },
  };
}

function uniformHeights(ids: string[], height = 100) {
  return new Map(ids.map((id) => [id, height]));
}

beforeEach(() => {
  ResizeObserverMock.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  cleanup();
  anchorApi = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BottomAnchoredScrollBody", () => {
  it("opens at the latest message and follows new content", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
    timeline.setRows([...ids, "row-new"]);
    timeline.resizeRow("row-new", 300);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
    expect(anchorApi?.isAtBottom).toBe(true);
  });

  it("keeps the visible message still while older history is prepended", () => {
    const ids = rowIds("row", 20);
    const heights = uniformHeights(ids);
    const timeline = renderTimeline({ ids, heights });

    timeline.userScrollTo(1_230);
    expect(anchorApi?.isAtBottom).toBe(false);
    const before = timeline.rowTop("row-12");

    const older = rowIds("older", 10);

    for (const id of older) heights.set(id, 37 + older.indexOf(id) * 11);
    timeline.setRows([...older, ...ids]);

    expect(timeline.rowTop("row-12")).toBe(before);
  });

  it("keeps the visible message still when the reader scrolls before a prepend is observed", () => {
    const ids = rowIds("row", 20);
    const heights = uniformHeights(ids);
    const timeline = renderTimeline({ ids, heights });

    timeline.userScrollTo(1_230);
    const before = timeline.rowTop("row-12");

    const older = rowIds("older", 10);

    for (const id of older) heights.set(id, 37 + older.indexOf(id) * 11);
    timeline.commitRows([...older, ...ids]);
    timeline.userScrollTo(1_190);
    relayout();

    expect(timeline.rowTop("row-12")).toBe(before + 40);
  });

  it("keeps the visible message still when content above it changes size", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.userScrollTo(1_000);
    const before = timeline.rowTop("row-10");
    timeline.resizeRow("row-3", 420);
    expect(timeline.rowTop("row-10")).toBe(before);
    timeline.resizeRow("row-5", 20);
    expect(timeline.rowTop("row-10")).toBe(before);
  });

  it("does not move a detached reader when new content arrives below", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.userScrollTo(800);
    timeline.setRows([...ids, "row-new"]);
    timeline.resizeRow("row-new", 600);
    expect(timeline.viewport.scrollTop).toBe(800);
    expect(anchorApi?.isAtBottom).toBe(false);
  });

  it("resumes following once the reader scrolls back to the bottom", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.userScrollTo(800);
    timeline.userScrollTo(timeline.maxScroll());
    expect(anchorApi?.isAtBottom).toBe(true);
    timeline.setRows([...ids, "row-new"]);
    timeline.resizeRow("row-new", 250);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it("stays attached when shrinking content clamps the bottom position", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.layout.heights.set("row-19", 10);
    timeline.userScrollTo(timeline.viewport.scrollTop);
    relayout();
    expect(anchorApi?.isAtBottom).toBe(true);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it("keeps following when the footer shrinks and regrows before the browser reports the clamp", () => {
    const ids = rowIds("row", 20);

    const timeline = renderTimeline({
      ids,
      heights: uniformHeights(ids),
      footer: <div>Question form</div>,
      footerHeight: 300,
    });

    timeline.layout.footerHeight = 100;
    timeline.clampToContent();
    timeline.layout.footerHeight = 200;
    timeline.deliverScrollEvent();
    relayout();
    expect(anchorApi?.isAtBottom).toBe(true);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it("keeps following when an answer returns the footer to its original height", () => {
    const ids = rowIds("row", 20);

    const timeline = renderTimeline({
      ids,
      heights: uniformHeights(ids),
      footer: <div>Question form</div>,
      footerHeight: 300,
    });

    timeline.layout.footerHeight = 100;
    timeline.clampToContent();
    act(() => anchorApi?.scrollToBottom());
    timeline.layout.footerHeight = 300;
    timeline.deliverScrollEvent();
    relayout();
    expect(anchorApi?.isAtBottom).toBe(true);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it("ignores presses and keys on footer controls when the browser clamps", () => {
    const ids = rowIds("row", 20);

    const timeline = renderTimeline({
      ids,
      heights: uniformHeights(ids),
      footer: <button type="button">Submit answer</button>,
      footerHeight: 300,
    });

    const button = timeline.viewport.querySelector("button");

    if (!button) throw new Error("Missing footer button");
    act(() => {
      button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      button.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true }),
      );
    });
    timeline.layout.footerHeight = 100;
    timeline.clampToContent();
    timeline.layout.footerHeight = 200;
    timeline.deliverScrollEvent();
    relayout();
    expect(anchorApi?.isAtBottom).toBe(true);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it("lets the reader leave with the wheel while the footer resizes", () => {
    const ids = rowIds("row", 20);

    const timeline = renderTimeline({
      ids,
      heights: uniformHeights(ids),
      footer: <div>Composer</div>,
      footerHeight: 100,
    });

    act(() => {
      timeline.viewport.dispatchEvent(
        new WheelEvent("wheel", { deltaY: -100, bubbles: true }),
      );
    });
    timeline.layout.footerHeight = 160;
    timeline.userScrollTo(1_200);
    relayout();
    expect(anchorApi?.isAtBottom).toBe(false);
    expect(timeline.viewport.scrollTop).toBe(1_200);
  });

  it("keeps following after a layout scroll without reader input", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.layout.heights.set("row-19", 300);
    timeline.viewport.scrollTop = 1_200;
    timeline.deliverScrollEvent();
    relayout();
    expect(anchorApi?.isAtBottom).toBe(true);
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
  });

  it.each(["wheel", "keyboard"])(
    "does not treat nested output %s input as reading the chat history",
    (input) => {
      const ids = rowIds("row", 20);
      const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });
      const output = document.createElement("div");
      output.setAttribute("data-detail-scroll-area", "base");
      timeline.viewport
        .querySelector('[data-timeline-row-id="row-19"]')
        ?.append(output);
      act(() =>
        output.dispatchEvent(
          input === "wheel"
            ? new WheelEvent("wheel", { deltaY: -100, bubbles: true })
            : new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }),
        ),
      );

      timeline.layout.heights.set("row-19", 300);
      timeline.viewport.scrollTop = 1_200;
      timeline.deliverScrollEvent();
      relayout();

      expect(anchorApi?.isAtBottom).toBe(true);
      expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
    },
  );

  it("keeps an interior paragraph still when an earlier paragraph grows", () => {
    const timeline = renderTimeline({
      ids: ["answer"],
      heights: new Map([["answer", 2_000]]),
    });

    const row = timeline.viewport.querySelector("[data-timeline-row-id]");
    const paragraph = document.createElement("p");
    row?.append(paragraph);
    let paragraphOffset = 700;
    vi.spyOn(paragraph, "getBoundingClientRect").mockImplementation(
      () =>
        new DOMRect(0, paragraphOffset - timeline.viewport.scrollTop, 100, 500),
    );

    timeline.userScrollTo(800);
    const readingTop = paragraph.getBoundingClientRect().top;
    paragraphOffset += 220;
    timeline.resizeRow("answer", 2_220);

    expect(paragraph.getBoundingClientRect().top).toBe(readingTop);
    expect(timeline.viewport.scrollTop).toBe(1_020);
    expect(anchorApi?.isAtBottom).toBe(false);
  });

  it("keeps a collapsing message's bottom edge in place", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.userScrollTo(1_050);

    const row = timeline.viewport.querySelector<HTMLElement>(
      '[data-timeline-row-id="row-10"]',
    );

    if (!row) throw new Error("Missing row");
    const bottomBefore = row.getBoundingClientRect().bottom;

    act(() => {
      anchorApi?.holdContentPosition({
        edge: "bottom",
        element: row,
        update: () => timeline.layout.heights.set("row-10", 40),
      });
    });
    relayout();
    expect(row.getBoundingClientRect().bottom).toBe(bottomBefore);
  });

  it("jumps back to the latest message and follows again on request", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });

    timeline.userScrollTo(300);
    act(() => anchorApi?.scrollToBottom());
    expect(timeline.viewport.scrollTop).toBe(timeline.maxScroll());
    expect(anchorApi?.isAtBottom).toBe(true);
  });

  it("detaches when the page header asks to scroll to the top", () => {
    const ids = rowIds("row", 20);
    const timeline = renderTimeline({ ids, heights: uniformHeights(ids) });
    const scrollTo = vi.fn();
    timeline.viewport.scrollTo = scrollTo;

    act(() => {
      timeline.viewport.dispatchEvent(
        new Event(PAGE_SCROLL_TO_TOP_EVENT, { cancelable: true }),
      );
    });
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(anchorApi?.isAtBottom).toBe(false);
  });
});

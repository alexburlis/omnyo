// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BottomAnchorContext,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow";

let reportIntersection: (isIntersecting: boolean) => void = () => {};

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback) {
    reportIntersection = (isIntersecting) =>
      callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      );
  }

  observe() {}

  disconnect() {}
}

const scrollElement = document.createElement("div");

const bottomAnchor: BottomAnchorContextValue = {
  getScrollElement: () => scrollElement,
  isAtBottom: true,
  scrollToBottom: () => {},
  scrollElementIntoView: () => {},
  scrollElementIntoViewClampedToMaxScroll: () => {},
  holdContentPosition: () => {},
};

function row(autoExpanded: boolean) {
  return (
    <BottomAnchorContext.Provider value={bottomAnchor}>
      <ExpandableTimelineRow
        autoExpanded={autoExpanded}
        title={{
          segments: [],
          decorations: [],
          tone: "default",
          action: null,
          plain: "Ran command",
        }}
        titleContent="Ran command"
        renderBody={() => <pre>output</pre>}
      />
    </BottomAnchorContext.Provider>
  );
}

const header = () => screen.getByRole("button", { name: "Ran command" });

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps finished live work open until it scrolls out of view", () => {
  const view = render(row(true));
  expect(header().getAttribute("aria-expanded")).toBe("true");

  view.rerender(row(false));
  expect(header().getAttribute("aria-expanded")).toBe("true");

  act(() => reportIntersection(true));
  expect(header().getAttribute("aria-expanded")).toBe("true");

  act(() => reportIntersection(false));
  expect(header().getAttribute("aria-expanded")).toBe("false");
});

it("folds at once outside a scrolling timeline", () => {
  const view = render(
    <ExpandableTimelineRow
      autoExpanded
      title={{
        segments: [],
        decorations: [],
        tone: "default",
        action: null,
        plain: "Ran command",
      }}
      titleContent="Ran command"
      renderBody={() => <pre>output</pre>}
    />,
  );

  view.rerender(
    <ExpandableTimelineRow
      autoExpanded={false}
      title={{
        segments: [],
        decorations: [],
        tone: "default",
        action: null,
        plain: "Ran command",
      }}
      titleContent="Ran command"
      renderBody={() => <pre>output</pre>}
    />,
  );

  expect(header().getAttribute("aria-expanded")).toBe("false");
});

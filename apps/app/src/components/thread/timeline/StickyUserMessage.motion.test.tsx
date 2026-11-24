// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Activity } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { StickyUserMessage } from "./StickyUserMessage";

const scroll = vi.hoisted(() => ({
  element: null as HTMLElement | null,
  atBottom: false,
}));

vi.mock("@/components/ui/bottom-anchored-scroll-body.js", () => ({
  useBottomAnchoredScroll: () => ({
    getScrollElement: () => scroll.element,
    isAtBottom: scroll.atBottom,
  }),
}));

const rows = [
  conversationRow({ id: "u1", role: "user", text: "first question" }),
  conversationRow({ id: "a1", text: "answer one" }),
  conversationRow({ id: "u2", role: "user", text: "second question" }),
  conversationRow({ id: "a2", text: "answer two" }),
];

const READING_FIRST_ANSWER = { u1: -200, a1: 0, u2: 100, a2: 200 };

const READING_SECOND_ANSWER = { u1: -400, a1: -300, u2: -200, a2: 0 };

let rowTops: Record<string, number> = READING_FIRST_ANSWER;

function Timeline({
  mode,
  loaded = true,
}: {
  mode: "visible" | "hidden";
  loaded?: boolean;
}) {
  const shownRows = loaded ? rows : [];

  return (
    <Activity mode={mode}>
      <div
        ref={(node) => {
          scroll.element = node;

          if (node === null) return;
          Object.defineProperties(node, {
            clientHeight: { configurable: true, value: 400 },
            scrollHeight: { configurable: true, value: 2000 },
            scrollTop: { configurable: true, value: 600 },
          });
        }}
      >
        <StickyUserMessage rows={shownRows} />
        <div data-timeline-row-list="top-level">
          {shownRows.map((row) => (
            <div
              key={row.id}
              data-timeline-row-id={row.id}
              ref={(node) => {
                if (node === null) return;
                node.getBoundingClientRect = () =>
                  new DOMRect(0, rowTops[row.id] ?? 0, 100, 100);
              }}
            />
          ))}
        </div>
      </div>
    </Activity>
  );
}

function settleFrames() {
  act(() => {
    vi.advanceTimersByTime(100);
  });
}

function firstFrame() {
  act(() => {
    vi.advanceTimersByTime(16);
  });
}

function label(text: string) {
  return screen
    .getByText(text)
    .closest<HTMLElement>("[data-sticky-user-text]")!;
}

function strip(text: string) {
  const element = label(text).closest("[data-sticky-user-message] > div");

  if (!(element instanceof HTMLElement)) throw new Error("strip missing");

  return element;
}

beforeEach(() => {
  vi.useFakeTimers();
  rowTops = READING_FIRST_ANSWER;
  scroll.atBottom = false;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("StickyUserMessage motion", () => {
  it("shows the departed prompt even a short distance from the live bottom", () => {
    render(<Timeline mode="visible" />);
    const element = scroll.element;

    if (!element) throw new Error("Missing viewport");
    Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 600 },
      scrollTop: { configurable: true, value: 150 },
    });
    firstFrame();
    expect(strip("first question")).toBeTruthy();
  });

  it("does not cover the live bottom with a pinned prompt", () => {
    scroll.atBottom = true;
    render(<Timeline mode="visible" />);
    firstFrame();
    expect(screen.queryByText("first question")).toBeNull();
  });

  it("pins the message in place when a chat is shown", () => {
    render(<Timeline mode="visible" />);
    firstFrame();

    expect(strip("first question").className).toContain("transition-none");
    expect(label("first question").className).not.toContain("animate-in");

    settleFrames();

    expect(label("first question").className).not.toContain("animate-in");
  });

  it("waits until the chat is rendered before pinning a message", () => {
    render(<Timeline mode="visible" />);
    const element = scroll.element as HTMLElement;
    element.checkVisibility = () => false;
    settleFrames();

    expect(screen.queryByText("first question")).toBeNull();

    element.checkVisibility = () => true;
    fireEvent.scroll(element);
    firstFrame();

    expect(strip("first question").className).toContain("transition-none");
    expect(label("first question").className).not.toContain("animate-in");
  });

  it("pins the message in place when rows arrive after the chat is shown", () => {
    const { rerender } = render(<Timeline mode="visible" loaded={false} />);
    settleFrames();

    rerender(<Timeline mode="visible" />);
    firstFrame();

    expect(strip("first question").className).toContain("transition-none");
    expect(label("first question").className).not.toContain("animate-in");
  });

  it("animates the label when the user scrolls to another message", () => {
    render(<Timeline mode="visible" />);
    settleFrames();

    rowTops = READING_SECOND_ANSWER;
    fireEvent.wheel(scroll.element as HTMLElement);
    fireEvent.scroll(scroll.element as HTMLElement);
    settleFrames();

    expect(label("second question").className).toContain("animate-in");
    expect(strip("second question").className).toContain(
      "transition-[opacity,translate]",
    );
  });

  it("pins another message in place when the layout moves without user scrolling", () => {
    render(<Timeline mode="visible" />);
    settleFrames();

    rowTops = READING_SECOND_ANSWER;
    fireEvent.scroll(scroll.element as HTMLElement);
    settleFrames();

    expect(label("second question").className).not.toContain("animate-in");
    expect(strip("second question").className).toContain("transition-none");
  });

  it("does not replay the label entrance when the chat is shown again", () => {
    const { rerender } = render(<Timeline mode="visible" />);
    settleFrames();
    rowTops = READING_SECOND_ANSWER;
    fireEvent.wheel(scroll.element as HTMLElement);
    fireEvent.scroll(scroll.element as HTMLElement);
    settleFrames();

    rerender(<Timeline mode="hidden" />);
    settleFrames();
    rerender(<Timeline mode="visible" />);

    expect(label("second question").className).not.toContain("animate-in");
    expect(strip("second question").className).toContain("transition-none");

    settleFrames();

    expect(label("second question").className).not.toContain("animate-in");
  });
});

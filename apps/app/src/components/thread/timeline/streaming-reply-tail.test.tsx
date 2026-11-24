// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MOTION_DURATION_MS } from "@omnyo/shared-ui/motion";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { STREAMING_WORD_LIMIT } from "@/components/ui/markdown-streaming-words";
import { ConversationMessageContent } from "./ConversationMessageContent";

let now = 1_000;

let frames: FrameRequestCallback[] = [];

function assistant(text: string, streaming: boolean) {
  return (
    <MemoryRouter>
      <RouteNavigationProvider>
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map()}
        >
          <ConversationMessageContent
            role="assistant"
            turnGit={null}
            attachments={null}
            id="msg_tail"
            threadId="thr_tail"
            turnId="turn_tail"
            streaming={streaming}
            showActions={false}
            text={text}
            timestamp={0}
          />
        </ThreadTitleMentionResourcesProvider>
      </RouteNavigationProvider>
    </MemoryRouter>
  );
}

function wordList(count: number, start = 0): string {
  return Array.from({ length: count }, (_, index) => `w${start + index}`).join(
    " ",
  );
}

function words(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>("[data-streaming-word]")];
}

function opacityOf(container: HTMLElement, word: string): string | null {
  const span = words(container).find((element) => element.textContent === word);

  return span === undefined ? null : span.style.opacity;
}

function runFrames(advanceMs: number) {
  now += advanceMs;
  const pending = frames;
  frames = [];

  act(() => {
    for (const frame of pending) frame(now);
  });
}

function reduceMotion(reduce: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation((query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  now = 1_000;
  frames = [];
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);

    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("streamed reply tail", () => {
  it("fades only the newest words by arrival and keeps their ages across updates", () => {
    reduceMotion(false);
    const first = wordList(3);
    const view = render(assistant(first, true));

    expect(words(view.container).map((word) => word.style.opacity)).toEqual([
      "",
      "",
      "",
    ]);
    expect(frames).toHaveLength(0);

    const second = `${first} ${wordList(27, 3)}`;
    view.rerender(assistant(second, true));

    expect(words(view.container)).toHaveLength(STREAMING_WORD_LIMIT);
    expect(opacityOf(view.container, "w0")).toBeNull();
    expect(Number(opacityOf(view.container, "w14"))).toBeCloseTo(0.08);
    expect(Number(opacityOf(view.container, "w29"))).toBeCloseTo(0.08);
    expect(view.container.textContent).toContain(second);

    runFrames(MOTION_DURATION_MS.base / 2);
    const firstFading = Number(opacityOf(view.container, "w14"));
    const lastFading = Number(opacityOf(view.container, "w29"));
    expect(firstFading).toBeGreaterThan(0.8);
    expect(lastFading).toBeLessThan(firstFading);

    const third = `${second} w30`;
    view.rerender(assistant(third, true));
    expect(Number(opacityOf(view.container, "w15"))).toBeGreaterThan(0.8);
    expect(Number(opacityOf(view.container, "w30"))).toBeCloseTo(0.08);

    for (let step = 0; step < 4 && frames.length > 0; step++) {
      runFrames(MOTION_DURATION_MS.base);
    }

    expect(frames).toHaveLength(0);
    expect(words(view.container).map((word) => word.style.opacity)).toEqual(
      Array.from({ length: STREAMING_WORD_LIMIT }, () => ""),
    );
  });

  it("settles to plain text when streaming ends", () => {
    reduceMotion(false);
    const view = render(assistant(wordList(4), true));
    view.rerender(assistant(wordList(24), true));
    expect(words(view.container).length).toBeGreaterThan(0);

    view.rerender(assistant(wordList(24), false));

    expect(words(view.container)).toHaveLength(0);
    expect(view.container.textContent).toContain(wordList(24));
  });

  it("shows words at full opacity without animation frames under reduced motion", () => {
    reduceMotion(true);
    const view = render(assistant(wordList(4), true));
    view.rerender(assistant(wordList(30), true));

    expect(words(view.container)).toHaveLength(0);
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("leaves code and links unwrapped", () => {
    reduceMotion(false);

    const view = render(
      assistant(
        "Read `inline code here` and [the link](https://x.test) now",
        true,
      ),
    );

    expect(
      view.container.querySelector(
        "code [data-streaming-word], a [data-streaming-word]",
      ),
    ).toBeNull();
    expect(words(view.container).map((word) => word.textContent)).toEqual([
      "Read",
      "and",
      "now",
    ]);
  });

  it("reconciles successive streamed updates without React errors", () => {
    reduceMotion(false);
    const consoleError = vi.spyOn(console, "error");

    const source =
      "Intro words for the **bold claim** keep going with `code` and more text.\n\n- first item has words\n- second item\n\nA closing paragraph that keeps streaming until the very end of the reply.";

    const view = render(assistant(source.slice(0, 4), true));

    for (let end = 8; end <= source.length; end += 5) {
      view.rerender(assistant(source.slice(0, end), true));
      expect(words(view.container).length).toBeLessThanOrEqual(
        STREAMING_WORD_LIMIT,
      );
      runFrames(40);
    }

    view.rerender(assistant(source, true));
    view.rerender(assistant(source, false));

    expect(consoleError).not.toHaveBeenCalled();
    expect(words(view.container)).toHaveLength(0);
    expect(view.container.textContent).toContain(
      "A closing paragraph that keeps streaming until the very end of the reply.",
    );
  });
});

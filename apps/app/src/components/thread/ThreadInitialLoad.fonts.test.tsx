// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ThreadInitialLoad,
  useThreadInitialLoadPending,
} from "./ThreadInitialLoad";

async function frames() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16),
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ThreadInitialLoad fonts", () => {
  it("shows a warm conversation on its first commit despite pending supporting and conversation reads", () => {
    function WarmConversation() {
      useThreadInitialLoadPending(true);
      useThreadInitialLoadPending(true, true);

      return <p>Warm conversation</p>;
    }

    render(
      <ThreadInitialLoad
        threadId="warm"
        initiallyReady
        fallback={<p>Loading chat</p>}
      >
        <WarmConversation />
      </ThreadInitialLoad>,
    );

    expect(
      getComputedStyle(screen.getByText("Warm conversation")).visibility,
    ).toBe("visible");
    expect(screen.queryByText("Loading chat")).toBeNull();
    expect(
      screen
        .getByText("Warm conversation")
        .closest("[aria-busy]")
        ?.getAttribute("aria-busy"),
    ).toBe("false");
  });

  it("reveals a ready conversation without waiting for unrelated fonts", async () => {
    function Conversation({ pending }: { pending: boolean }) {
      useThreadInitialLoadPending(pending, true);

      return <p>Ready conversation</p>;
    }

    const original = Object.getOwnPropertyDescriptor(document, "fonts");
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { status: "loading", ready: new Promise<void>(() => {}) },
    });

    const content = (pending: boolean) => (
      <ThreadInitialLoad threadId="fonts" fallback={<p>Loading chat</p>}>
        <Conversation pending={pending} />
      </ThreadInitialLoad>
    );

    try {
      const view = render(content(true));
      await frames();
      expect(
        getComputedStyle(screen.getByText("Ready conversation")).visibility,
      ).toBe("hidden");
      view.rerender(content(false));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(
        getComputedStyle(screen.getByText("Ready conversation")).visibility,
      ).toBe("hidden");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(
        getComputedStyle(screen.getByText("Ready conversation")).visibility,
      ).toBe("visible");
      expect(screen.queryByText("Loading chat")).toBeNull();
    } finally {
      if (original) Object.defineProperty(document, "fonts", original);
      else Reflect.deleteProperty(document, "fonts");
    }
  });
});

// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomAnchorContext } from "@/components/ui/bottom-anchored-scroll-body.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineSurface } from "./ThreadTimelineSurface";

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadTimelineSurface load-older control", () => {
  it("resumes auto-loading after a context boundary replaces a timeline whose older page failed", async () => {
    const scrollElement = document.createElement("div");
    vi.spyOn(scrollElement, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 100, 500),
    );

    const anchor = {
      holdContentPosition: vi.fn(),
      getScrollElement: () => scrollElement,
      isAtBottom: false,
      scrollElementIntoView: vi.fn(),
      scrollElementIntoViewClampedToMaxScroll: vi.fn(),
      scrollToBottom: vi.fn(),
    };

    const onLoadOlderRows = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("Server error"))
      .mockReturnValue(new Promise(() => {}));

    const surface = (contextBoundarySeq: number | null) => (
      <BottomAnchorContext.Provider value={anchor}>
        <ThreadTimelineSurface
          activeThinking={null}
          contextBoundarySeq={contextBoundarySeq}
          hasOlderTimelineRows
          isThreadTimelinePending={false}
          onLoadOlderRows={onLoadOlderRows}
          showOngoingIndicator={false}
          threadId="thread-1"
          threadRuntimeDisplayStatus="idle"
          timelineError={false}
          timelineRows={[]}
          workspaceRootPath={undefined}
        />
      </BottomAnchorContext.Provider>
    );

    const view = render(surface(null));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Load older messages" }),
      ).not.toBeNull();
    });

    view.rerender(surface(10));
    expect(
      document.querySelector("[aria-live=polite][role=status].text-xs"),
    ).not.toBeNull();
    expect(onLoadOlderRows).toHaveBeenCalledTimes(2);
  });
});

it("switches from running a command to writing as the latest reply streams", () => {
  const client = new QueryClient();

  const command = commandRow({
    command: "pnpm test",
    id: "active-command",
    sourceSeqStart: 1,
    status: "pending",
  });

  const surface = (timelineRows: TimelineRow[]) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ThreadTimelineSurface
          activeThinking={null}
          contextBoundarySeq={null}
          isThreadTimelinePending={false}
          showOngoingIndicator
          threadId="thread-1"
          threadRuntimeDisplayStatus="active"
          timelineError={false}
          timelineRows={timelineRows}
          workspaceRootPath={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const reply = conversationRow({
    id: "reply",
    role: "assistant",
    text: "Here is what passed.",
    sourceSeqStart: 2,
  });

  if (reply.role !== "assistant")
    throw new Error("Expected an assistant reply");

  const view = render(surface([command]));
  expect(screen.getByText(/^Running pnpm test ·/u)).toBeTruthy();

  view.rerender(
    surface([
      command,
      {
        ...reply,
        status: "streaming",
      },
    ]),
  );
  expect(screen.getByText(/^Writing reply… ·/u)).toBeTruthy();
  expect(screen.queryByText(/^Running pnpm test ·/u)).toBeNull();
});

describe("ThreadTimelineSurface catch-up indicator", () => {
  const props = {
    activeThinking: null,
    contextBoundarySeq: null,
    isThreadTimelinePending: false,
    showOngoingIndicator: false,
    threadId: "catch-up",
    threadRuntimeDisplayStatus: "idle" as const,
    timelineError: false,
    timelineRows: [],
    workspaceRootPath: undefined,
  };

  it("never shows loading for a catch-up that finishes within one second", async () => {
    vi.useFakeTimers();

    const view = render(
      <ThreadTimelineSurface {...props} isCatchingUpTimeline />,
    );

    expect(screen.queryByText("Loading latest messages…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(900);
    });
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
    view.rerender(
      <ThreadTimelineSurface {...props} isCatchingUpTimeline={false} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
  });

  it("delays each thread's indicator and hides immediately when caught up", async () => {
    vi.useFakeTimers();

    const view = render(
      <ThreadTimelineSurface {...props} isCatchingUpTimeline />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText("Loading latest messages…").textContent).toBe(
      "Loading latest messages…",
    );
    view.rerender(
      <ThreadTimelineSurface
        {...props}
        threadId="another-thread"
        isCatchingUpTimeline
      />,
    );
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(screen.getByText("Loading latest messages…").textContent).toBe(
      "Loading latest messages…",
    );
    view.rerender(
      <ThreadTimelineSurface
        {...props}
        threadId="another-thread"
        isCatchingUpTimeline={false}
      />,
    );
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
    view.rerender(
      <ThreadTimelineSurface
        {...props}
        threadId="another-thread"
        isCatchingUpTimeline
      />,
    );
    expect(screen.queryByText("Loading latest messages…")).toBeNull();
  });
});

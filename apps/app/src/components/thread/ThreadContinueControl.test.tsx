// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  threadContinueStateSchema,
  type ThreadContinueState,
} from "@omnyo/server-contract";
import { ThreadContinueControl } from "./ThreadContinueControl";

const mocks = vi.hoisted(() => ({
  state: {
    data: undefined as ThreadContinueState | undefined,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  continuation: { isPending: false, mutate: vi.fn() },
}));

vi.mock("@/hooks/queries/thread-continuation-queries", () => ({
  useThreadContinuation: () => mocks.state,
  useContinueThread: () => mocks.continuation,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function recovery(overrides: Partial<ThreadContinueState> = {}) {
  mocks.state.data = threadContinueStateSchema.parse({
    threadId: "thr-recovery",
    available: true,
    pending: false,
    action: "retry",
    message: "No automatic retry is scheduled. Continue when ready.",
    ...overrides,
  });
}

describe("Thread recovery banner", () => {
  it("keeps one recovery explanation with collapsed diagnostics", () => {
    recovery({ cause: "Selected model is at capacity." });
    render(<ThreadContinueControl threadId="thr-recovery" errored />);
    expect(screen.getByText("Paused")).toBeDefined();
    expect(screen.getByText("Failure details").closest("details")?.open).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue now" }));
    expect(mocks.continuation.mutate).toHaveBeenCalledWith(
      { threadId: "thr-recovery", now: true },
      expect.any(Object),
    );
  });

  it("offers an immediate attempt while a durable retry waits", () => {
    recovery({
      available: false,
      pending: true,
      canRetryNow: true,
      action: "retry-queued",
      retryAt: Date.now() + 3600000,
      message: "Rate limited. Next attempt scheduled.",
    });
    render(<ThreadContinueControl threadId="thr-recovery" errored />);
    expect(screen.getByText("Automatic recovery")).toBeDefined();
    expect(screen.getByText(/Next attempt in 1h/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Continue now" }));
    expect(mocks.continuation.mutate).toHaveBeenCalledWith(
      { threadId: "thr-recovery", now: true },
      expect.any(Object),
    );
  });

  it("keeps claimed recovery unavailable for another dispatch", () => {
    recovery({
      available: false,
      pending: true,
      canRetryNow: false,
      action: "none",
      message: "Recovery is starting.",
    });
    render(<ThreadContinueControl threadId="thr-recovery" errored />);
    expect(screen.queryByRole("button", { name: "Continue now" })).toBeNull();
  });

  it("distinguishes a due retry from a recovery waiting for a machine", () => {
    recovery({
      available: false,
      pending: true,
      action: "retry-queued",
      retryAt: Date.now() - 1,
    });

    const { rerender } = render(
      <ThreadContinueControl threadId="thr-recovery" errored />,
    );

    expect(screen.getByText("Scheduled retry is due")).toBeDefined();

    recovery({
      available: false,
      pending: true,
      action: "retry-queued",
      message: "Automatic recovery is waiting for Test Mac to reconnect.",
    });
    rerender(<ThreadContinueControl threadId="thr-recovery" errored />);

    expect(screen.queryByText("Scheduled retry is due")).toBeNull();
    expect(screen.getByText(/waiting for Test Mac to reconnect/)).toBeDefined();
  });

  it("explains unavailable recovery without hiding its cause", () => {
    recovery({
      action: "unavailable",
      cause: "The workspace was removed.",
      message: "Choose a workspace or start a new chat.",
    });
    render(<ThreadContinueControl threadId="thr-recovery" errored />);
    expect(
      screen.getByText("Choose a workspace or start a new chat."),
    ).toBeDefined();
    expect(screen.getByText("The workspace was removed.")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Continue now" })).toBeNull();
  });

  it("continues with the selected model only after the explicit action", () => {
    recovery({ model: "original" });
    render(
      <ThreadContinueControl
        threadId="thr-recovery"
        errored
        model="alternate"
        modelControl={<button>Model picker</button>}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Continue with selected model" }),
    );
    expect(mocks.continuation.mutate).toHaveBeenCalledWith(
      { threadId: "thr-recovery", now: true, model: "alternate" },
      expect.any(Object),
    );
  });

  it("removes the pause banner after the thread resumes", () => {
    recovery();

    const { rerender } = render(
      <ThreadContinueControl threadId="thr-recovery" errored />,
    );

    expect(screen.getByText("Paused")).toBeDefined();
    rerender(<ThreadContinueControl threadId="thr-recovery" errored={false} />);
    expect(screen.queryByTestId("thread-continue-control")).toBeNull();
  });
});

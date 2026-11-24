// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commandRow,
  conversationRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  ComposerWorkingDock,
  ComposerWorkingProvider,
  ComposerWorkingQueueHost,
  activeTurnStartedAt,
  type ComposerWorkingState,
} from "./ComposerWorkingTab";

describe("activeTurnStartedAt", () => {
  it("starts the clock at the earliest row of the running turn", () => {
    expect(
      activeTurnStartedAt([
        turnRow({ id: "previous", turnId: "turn-1", startedAt: 1_000 }),
        conversationRow({ text: "Next", turnId: "turn-2", startedAt: 5_000 }),
        commandRow({ command: "ls", turnId: "turn-2", startedAt: 6_000 }),
      ]),
    ).toBe(5_000);
  });

  it("has no clock while only a finished turn is on screen", () => {
    expect(
      activeTurnStartedAt([
        turnRow({ turnId: "turn-1", startedAt: 1_000, durationMs: 4_000 }),
      ]),
    ).toBeNull();
  });

  it("starts at a just-sent message before its turn begins", () => {
    expect(
      activeTurnStartedAt([
        turnRow({ turnId: "turn-1", startedAt: 1_000 }),
        conversationRow({ text: "Next", turnId: null, startedAt: 9_000 }),
      ]),
    ).toBe(9_000);
  });
});

function Composer({
  state,
  queued,
  compact = false,
}: {
  state: ComposerWorkingState | null;
  queued: boolean;
  compact?: boolean;
}) {
  return (
    <ComposerWorkingProvider state={state} allowQueueHost={!compact}>
      <ComposerWorkingQueueHost active={queued}>
        {(attached) =>
          queued ? (
            <div data-testid="queue" data-attached={String(attached)} />
          ) : null
        }
      </ComposerWorkingQueueHost>
      <ComposerWorkingDock>
        <div data-testid="composer" />
      </ComposerWorkingDock>
    </ComposerWorkingProvider>
  );
}

const THINKING: ComposerWorkingState = {
  label: "Thinking…",
  detail: "Thinking…",
  thinking: true,
  startedAt: null,
};

describe("ComposerWorkingDock", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("slides the tab away before unmounting it when work ends", () => {
    vi.useFakeTimers();

    const { container, rerender } = render(
      <Composer state={THINKING} queued={false} />,
    );

    const dock = () => container.querySelector("[data-composer-working]");
    expect(screen.getByRole("status").textContent).toBe("Thinking");
    expect(dock()?.getAttribute("data-composer-working")).toBe("open");

    rerender(<Composer state={null} queued={false} />);

    expect(
      screen
        .getByRole("status")
        .closest("[data-state]")
        ?.getAttribute("data-state"),
    ).toBe("closed");
    expect(dock()?.getAttribute("data-composer-working")).toBe("closed");

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(screen.queryByRole("status")).toBeNull();
    expect(dock()).toBeNull();
    expect(screen.getByTestId("composer")).toBeTruthy();
  });

  it("shows the full command only after a click", () => {
    const running: ComposerWorkingState = {
      label: "Running pnpm exec",
      detail: "Running pnpm exec turbo run typecheck --filter=@omnyo/app",
      thinking: false,
      startedAt: null,
    };

    const { rerender } = render(<Composer state={running} queued={false} />);
    const status = () => screen.getByRole("status");

    expect(status().textContent).toBe("Running pnpm exec");
    expect(status().className).toContain("truncate");

    fireEvent.click(status());
    expect(status().textContent).toBe(running.detail);
    expect(status().className).not.toContain("truncate");

    rerender(
      <Composer
        state={{ ...running, label: "Running ls", detail: "Running ls" }}
        queued={false}
      />,
    );
    expect(status().textContent).toBe("Running ls");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("moves the tab onto queued messages and back to the composer", () => {
    const { container, rerender } = render(
      <Composer state={THINKING} queued={true} />,
    );

    const tabHost = () =>
      screen.getByRole("status").closest("[data-composer-working-queue]");

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(tabHost()).not.toBeNull();
    expect(
      container.querySelector("[data-composer-working]")?.className,
    ).toContain("pt-0");

    rerender(<Composer state={THINKING} queued={false} />);

    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(tabHost()).toBeNull();
    expect(
      container.querySelector("[data-composer-working]")?.className,
    ).toContain("pt-6");
  });

  it("detaches compact queued messages while the tab holds the composer edge", () => {
    const queueAttached = () =>
      screen.getByTestId("queue").getAttribute("data-attached");

    const { rerender } = render(
      <Composer state={THINKING} queued={true} compact />,
    );

    expect(
      screen.getByRole("status").closest("[data-composer-working]"),
    ).not.toBeNull();
    expect(queueAttached()).toBe("false");

    rerender(<Composer state={null} queued={true} compact />);
    expect(queueAttached()).toBe("true");

    rerender(<Composer state={THINKING} queued={true} />);
    expect(queueAttached()).toBe("true");
  });
});

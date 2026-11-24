// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TimelineRow } from "@omnyo/server-contract";
import { APP_UPDATE_INTERRUPTION_TITLE } from "@omnyo/thread-view";
import {
  commandRow,
  conversationRow,
  fileChangeRow,
  systemRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadProviderContext } from "../thread-provider-context";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { TimelineReasoningExpansionProvider } from "./TimelineReasoningExpansion";

const ACTIVITY = {
  commands: 1,
  failures: 0,
  files: 2,
  searches: 0,
  tools: 0,
  warnings: 0,
};

afterEach(cleanup);

function timeline(rows: TimelineRow[], expansionThreadId?: string) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadProviderContext.Provider
          value={{ providerId: "echo-agent", pluginId: "echo-provider" }}
        >
          <TimelineReasoningExpansionProvider threadId={expansionThreadId}>
            <ThreadTimelineRows
              threadId="thr_main"
              threadRuntimeDisplayStatus="idle"
              workspaceRootPath={undefined}
              timelineRows={rows}
            />
          </TimelineReasoningExpansionProvider>
        </ThreadProviderContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderRows(rows: TimelineRow[]) {
  return render(timeline(rows));
}

function finishedTurn(
  overrides: Partial<Parameters<typeof turnRow>[0]> = {},
  activity: typeof ACTIVITY | null = ACTIVITY,
): TimelineRow {
  return {
    ...turnRow({
      id: "turn-row",
      createdAt: 1_000,
      startedAt: 1_000,
      durationMs: 1_286_000,
      seq: 10,
      sourceSeqStart: 10,
      sourceSeqEnd: 20,
      children: [
        commandRow({
          id: "inner-command",
          command: "echo inner",
          status: "completed",
          createdAt: 1_001,
          startedAt: 1_001,
        }),
      ],
      ...overrides,
    }),
    ...(activity === null ? {} : { activity }),
  };
}

function answer(createdAt: number): TimelineRow {
  return conversationRow({
    id: `assistant-${createdAt}`,
    seq: createdAt,
    role: "assistant",
    text: "ANSWER",
    createdAt,
    startedAt: createdAt,
  });
}

function updatePause(id: string, createdAt: number): TimelineRow {
  return systemRow({
    id,
    seq: createdAt,
    createdAt,
    startedAt: createdAt,
    operationKind: "thread-interrupted",
    status: "interrupted",
    title: APP_UPDATE_INTERRUPTION_TITLE,
    detail: null,
  });
}

function warningRow(id: string, seq: number, title: string): TimelineRow {
  return systemRow({
    id,
    seq,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    createdAt: seq,
    startedAt: seq,
    operationKind: "warning",
    status: "completed",
    title,
    detail: "fallback metadata in use",
  });
}

function foldLine(): HTMLElement {
  return screen.getByRole("button", { name: /^Worked/u });
}

function userPrompt(id: string, seq: number, turnId: string): TimelineRow {
  return conversationRow({
    id,
    seq,
    role: "user",
    text: `PROMPT ${id}`,
    createdAt: seq,
    startedAt: seq,
    turnId,
  });
}

function rowWrapper(container: HTMLElement, rowId: string): HTMLElement {
  const wrapper = container.querySelector<HTMLElement>(
    `[data-timeline-row-id="${rowId}"]`,
  );

  if (wrapper === null) {
    throw new Error(`Row ${rowId} did not render`);
  }

  return wrapper;
}

describe("one quiet activity line per turn", () => {
  it("folds a finished turn into one line above its answer", () => {
    renderRows([finishedTurn(), answer(2_000)]);

    expect(foldLine().textContent).toMatch(/^Worked for 21m /u);
    expect(foldLine().textContent).not.toContain("command");
    expect(screen.getByText("ANSWER")).toBeTruthy();
    expect(foldLine().getAttribute("aria-expanded")).toBe("false");
  });

  it("works without counts from an older server", () => {
    renderRows([finishedTurn({}, null), answer(2_000)]);

    expect(foldLine().textContent).toMatch(/^Worked for 21m \S/u);
  });

  it("shows seconds under ten minutes and sums loaded file changes", () => {
    renderRows([
      finishedTurn({
        durationMs: 100_000,
        children: [
          fileChangeRow({ id: "edit-a", diffStats: { added: 12, removed: 3 } }),
          fileChangeRow({ id: "edit-b", diffStats: { added: 2, removed: 0 } }),
        ],
      }),
      answer(2_000),
    ]);

    expect(foldLine().textContent).toMatch(/^Worked for 1m 40s \+14 -3 /u);
  });

  it("leaves a running turn expanded and never folds it", () => {
    renderRows([
      commandRow({
        id: "live-command",
        command: "echo live",
        status: "pending",
        createdAt: 1_000,
        startedAt: 1_000,
      }),
    ]);

    expect(screen.queryByRole("button", { name: /^Worked/u })).toBeNull();
    expect(screen.getByText(/echo live/u)).toBeTruthy();
  });

  it("shows warning and failure notes on the line as plain text", () => {
    renderRows([
      finishedTurn({}, { ...ACTIVITY, warnings: 1, failures: 2 }),
      answer(2_000),
    ]);

    const warning = screen.getByText("1 warning");
    const failure = screen.getByText("2 failed");

    expect(foldLine().contains(warning)).toBe(true);
    expect(warning.className).toContain("text-timeline-meta");
    expect(warning.className).not.toMatch(/(?:^| )(?:border|bg-)/u);
    expect(failure.className).toContain("text-destructive-text");
  });

  it("does not dim the notes with the past-row treatment", () => {
    renderRows([finishedTurn({}, { ...ACTIVITY, failures: 1 }), answer(2_000)]);

    expect(screen.getByText("1 failed").closest(".opacity-40")).toBeNull();
  });

  it("folds a thread-level warning before the turn into that turn's line", async () => {
    renderRows([
      warningRow("warn-1", 5, "Model metadata for gpt-6.1-sol not found"),
      finishedTurn(),
      answer(2_000),
    ]);

    expect(screen.queryByText(/Model metadata for gpt-6.1-sol/u)).toBeNull();
    expect(screen.getByText("1 warning")).toBeTruthy();

    fireEvent.click(foldLine());

    await waitFor(() => {
      expect(screen.getByText(/Model metadata for gpt-6.1-sol/u)).toBeTruthy();
    });
  });

  it("folds a warning past a child-chat notice into the turn that follows", () => {
    renderRows([
      warningRow("warn-3", 5, "Model metadata for gpt-6.1-sol not found"),
      systemRow({ id: "child-notice", sourceSeqStart: 6, sourceSeqEnd: 6 }),
      finishedTurn({}, { ...ACTIVITY, warnings: 0 }),
    ]);

    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(
      screen.queryByText("Model metadata for gpt-6.1-sol not found"),
    ).toBeNull();
  });

  it("folds a warning emitted during the turn, shown after its answer", () => {
    renderRows([
      finishedTurn(),
      answer(2_000),
      warningRow("warn-2", 15, "Model metadata for gpt-6.1-sol not found"),
    ]);

    expect(screen.queryByText(/Model metadata for gpt-6.1-sol/u)).toBeNull();
    expect(screen.getByText("1 warning")).toBeTruthy();
  });

  it("keeps a warning from an earlier segment on that segment, not the next turn", () => {
    renderRows([
      finishedTurn(
        {
          id: "a-seg-0",
          turnId: "turn-a",
          sourceSeqStart: 10,
          sourceSeqEnd: 20,
        },
        { ...ACTIVITY, commands: 2 },
      ),
      finishedTurn({
        id: "a-seg-1",
        turnId: "turn-a",
        seq: 40,
        sourceSeqStart: 40,
        sourceSeqEnd: 50,
      }),
      answer(2_000),
      warningRow("warn-seg", 30, "Model metadata for gpt-6.1-sol not found"),
      conversationRow({
        id: "user-2",
        seq: 60,
        role: "user",
        text: "NEXT",
        createdAt: 3_000,
        startedAt: 3_000,
      }),
      finishedTurn({
        id: "b",
        turnId: "turn-b",
        seq: 70,
        sourceSeqStart: 70,
        sourceSeqEnd: 80,
      }),
    ]);

    const [firstSegment, secondSegment, nextTurn] = screen.getAllByRole(
      "button",
      { name: /^Worked/u },
    );

    expect(firstSegment?.textContent).toContain("1 warning");
    expect(secondSegment?.textContent).not.toContain("1 warning");
    expect(nextTurn?.textContent).not.toContain("1 warning");
  });

  it("keeps a warning visible when no finished turn can hold it", () => {
    renderRows([
      answer(2_000),
      warningRow("warn-3", 3_000, "Model metadata for gpt-6.1-sol not found"),
    ]);

    expect(screen.getByText(/Model metadata for gpt-6.1-sol/u)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Worked/u })).toBeNull();
  });

  it("opens and closes the details in place under the line", async () => {
    const { container } = renderRows([finishedTurn(), answer(2_000)]);

    fireEvent.click(foldLine());

    await waitFor(() => {
      expect(screen.getByText(/echo inner/u)).toBeTruthy();
    });

    expect(foldLine().getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[data-turn-activity-details=""]'),
    ).not.toBeNull();

    fireEvent.click(foldLine());

    await waitFor(() => {
      expect(foldLine().getAttribute("aria-expanded")).toBe("false");
    });
  });

  it("remembers an open line when the chat is reopened", async () => {
    const rows = [finishedTurn(), answer(2_000)];

    const first = render(timeline(rows, "thr_remember"));

    fireEvent.click(foldLine());

    await waitFor(() => {
      expect(foldLine().getAttribute("aria-expanded")).toBe("true");
    });

    first.unmount();
    render(timeline(rows, "thr_remember"));

    await waitFor(() => {
      expect(foldLine().getAttribute("aria-expanded")).toBe("true");
    });
  });

  it("keeps open state separate for each chat", async () => {
    const rows = [finishedTurn(), answer(2_000)];

    const first = render(timeline(rows, "thr_open"));

    fireEvent.click(foldLine());

    await waitFor(() => {
      expect(foldLine().getAttribute("aria-expanded")).toBe("true");
    });

    first.unmount();
    render(timeline(rows, "thr_other"));

    expect(foldLine().getAttribute("aria-expanded")).toBe("false");
  });

  it("renders one hairline divider for an update pause that resumed", () => {
    const startedAt = new Date(2026, 10, 9, 15, 29).getTime();

    renderRows([
      answer(1_000),
      updatePause("pause-1", 2_000),
      conversationRow({
        id: "assistant-later",
        seq: 3_000,
        role: "assistant",
        text: "RESUMED",
        createdAt: startedAt,
        startedAt,
      }),
    ]);

    const divider = screen.getByTestId("thread-update-pause-divider");

    const time = new Date(startedAt).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });

    expect(divider.textContent).toBe(
      `Paused for an Omnyo update · resumed ${time}`,
    );
    expect(screen.queryByText(APP_UPDATE_INTERRUPTION_TITLE)).toBeNull();
  });

  it("follows the locale's clock in the divider time", () => {
    const toLocaleTimeString = vi
      .spyOn(Date.prototype, "toLocaleTimeString")
      .mockImplementation(
        (
          _locales?: Intl.LocalesArgument,
          options?: Intl.DateTimeFormatOptions,
        ) => (options?.hourCycle === "h23" ? "15:29" : "3:29 PM"),
      );

    try {
      renderRows([
        answer(1_000),
        updatePause("pause-1", 2_000),
        conversationRow({
          id: "assistant-later",
          seq: 3_000,
          role: "assistant",
          text: "RESUMED",
          createdAt: 3_000,
          startedAt: 3_000,
        }),
      ]);

      expect(
        screen.getByTestId("thread-update-pause-divider").textContent,
      ).toBe("Paused for an Omnyo update · resumed 3:29 PM");
    } finally {
      toLocaleTimeString.mockRestore();
    }
  });

  it("names the update pause for screen readers", () => {
    renderRows([answer(1_000), updatePause("pause-1", 2_000)]);

    expect(
      screen.getByRole("separator", { name: "Paused for an Omnyo update" }),
    ).toBeTruthy();
  });

  it("drops the resume time while the chat has not resumed", () => {
    renderRows([answer(1_000), updatePause("pause-1", 2_000)]);

    expect(screen.getByTestId("thread-update-pause-divider").textContent).toBe(
      "Paused for an Omnyo update",
    );
  });

  it("collapses consecutive update pauses into one divider", () => {
    renderRows([
      answer(1_000),
      updatePause("pause-1", 2_000),
      updatePause("pause-2", 2_001),
    ]);

    expect(screen.getAllByTestId("thread-update-pause-divider")).toHaveLength(
      1,
    );
  });

  it("keeps other stops as ordinary rows", () => {
    renderRows([
      answer(1_000),
      systemRow({
        id: "stopped",
        seq: 2_000,
        createdAt: 2_000,
        startedAt: 2_000,
        operationKind: "thread-interrupted",
        status: "interrupted",
        title: "Stopped manually",
        detail: null,
      }),
    ]);

    expect(screen.queryByTestId("thread-update-pause-divider")).toBeNull();
    expect(screen.getByText("Stopped manually")).toBeTruthy();
  });

  it("keeps today's flat rows when the collapse setting is off", () => {
    renderRows([
      conversationRow({
        id: "user-1",
        seq: 1,
        role: "user",
        text: "PROMPT",
        createdAt: 1,
        startedAt: 1,
      }),
      commandRow({
        id: "flat-command",
        command: "echo flat",
        status: "completed",
        seq: 2,
        createdAt: 2,
        startedAt: 2,
      }),
      answer(3),
    ]);

    expect(screen.queryByRole("button", { name: /^Worked/u })).toBeNull();
    expect(screen.getByText(/echo flat/u)).toBeTruthy();
  });
});

describe("one receipt per turn", () => {
  it("moves the answer time onto the receipt of a folded turn", () => {
    const { container } = renderRows([
      finishedTurn({
        createdAt: Date.now() - 2 * 3_600_000 - 1_286_000,
        startedAt: Date.now() - 2 * 3_600_000 - 1_286_000,
      }),
      answer(2_000),
    ]);

    expect(foldLine().textContent).toBe("Worked for 21m 2h ago");
    expect(
      rowWrapper(container, "assistant-2000").querySelector(
        "[data-message-time]",
      ),
    ).toBeNull();
  });

  it("keeps the bottom time on an answer without a fold", () => {
    const { container } = renderRows([answer(2_000)]);

    expect(
      rowWrapper(container, "assistant-2000").querySelector(
        "[data-message-time]",
      ),
    ).not.toBeNull();
  });

  it("separates turns with space and keeps a turn's rows close", () => {
    const { container } = renderRows([
      userPrompt("user-a", 1, "turn-a"),
      finishedTurn({ id: "fold-a", turnId: "turn-a", seq: 2 }),
      conversationRow({
        id: "answer-a",
        seq: 3,
        role: "assistant",
        text: "ANSWER A",
        createdAt: 3,
        startedAt: 3,
        turnId: "turn-a",
      }),
      userPrompt("user-b", 4, "turn-b"),
      conversationRow({
        id: "answer-b",
        seq: 5,
        role: "assistant",
        text: "ANSWER B",
        createdAt: 5,
        startedAt: 5,
        turnId: "turn-b",
      }),
      userPrompt("user-c", 6, "turn-c"),
    ]);

    const spacing = (rowId: string): string =>
      rowWrapper(container, rowId).style.marginTop;

    expect(spacing("user-a")).toBe("");
    expect(spacing("fold-a")).toBe("calc(var(--spacing) * 2)");
    expect(spacing("answer-a")).toBe("calc(var(--spacing) * 2)");
    expect(spacing("user-b")).toBe("calc(var(--spacing) * 4)");
    expect(spacing("answer-b")).toBe("calc(var(--spacing) * 2)");
    expect(spacing("user-c")).toBe("calc(var(--spacing) * 6)");
  });

  it("keeps the chevron visible on a folded receipt", () => {
    renderRows([finishedTurn(), answer(2_000)]);

    expect(
      foldLine().querySelector('[class*="group-hover/toggle:opacity-100"]'),
    ).toBeNull();
    expect(foldLine().querySelector("svg.opacity-100")).not.toBeNull();
  });
});

describe("the turn receipt swap", () => {
  const liveRows: TimelineRow[] = [
    userPrompt("user-live", 1, "turn-live"),
    commandRow({
      id: "live-command",
      command: "echo live",
      status: "pending",
      seq: 2,
      createdAt: 2,
      startedAt: 2,
      turnId: "turn-live",
    }),
  ];

  const finishedRows: TimelineRow[] = [
    userPrompt("user-live", 1, "turn-live"),
    finishedTurn({
      id: "fold-live",
      turnId: "turn-live",
      seq: 2,
      sourceSeqStart: 2,
      sourceSeqEnd: 3,
    }),
    conversationRow({
      id: "answer-live",
      seq: 4,
      role: "assistant",
      text: "ANSWER LIVE",
      createdAt: 4,
      startedAt: 4,
      turnId: "turn-live",
    }),
  ];

  it("swaps the live rows for the receipt instantly when a watched turn finishes", () => {
    const view = render(timeline(liveRows));

    view.rerender(timeline(finishedRows));

    expect(
      view.container.querySelector("[data-timeline-row-exiting]"),
    ).toBeNull();
    expect(
      view.container.querySelector('[data-timeline-row-id="live-command"]'),
    ).toBeNull();
    expect(
      view.container.querySelector("[data-turn-receipt-landing]"),
    ).toBeNull();
    expect(
      view.container.querySelector("[data-turn-receipt-digit]"),
    ).toBeNull();
    expect(foldLine().textContent).toMatch(/^Worked for 21m /u);
  });

  it("renders history without any receipt motion", () => {
    const { container } = renderRows(finishedRows);

    expect(container.querySelector("[data-timeline-row-exiting]")).toBeNull();
    expect(container.querySelector("[data-turn-receipt-landing]")).toBeNull();
  });
});

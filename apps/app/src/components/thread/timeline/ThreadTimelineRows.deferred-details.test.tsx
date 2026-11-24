// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  commandRow,
  conversationRow,
  delegationRow,
  systemRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { sdk } from "@/lib/sdk";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { timelineTurnSummaryDetails: vi.fn() } },
}));

const timelineTurnSummaryDetails = vi.mocked(
  sdk.threads.timelineTurnSummaryDetails,
);

function renderExpandedRow(
  row: TimelineRow,
  harness = createQueryClientTestHarness(),
) {
  return renderRow(row, new Set([row.id]), harness);
}

function renderRow(
  row: TimelineRow,
  initialExpanded: ReadonlySet<string>,
  harness = createQueryClientTestHarness(),
) {
  const { wrapper: Wrapper } = harness;

  return render(
    <MemoryRouter>
      <Wrapper>
        <ThreadTimelineRows
          initialExpanded={initialExpanded}
          threadId="thr_main"
          timelineRows={[row]}
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </Wrapper>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  timelineTurnSummaryDetails.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("deferred timeline details", () => {
  it("reuses a small completed detail after the normal heavy-payload minute", async () => {
    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [
        conversationRow({
          id: "small-completed-detail",
          text: "A retained completed answer.",
          threadId: "thr_main",
          turnId: "turn_1",
        }),
      ],
    });
    const harness = createQueryClientTestHarness();

    const deferredTurn = turnRow({
      sourceSeqEnd: 40,
      threadId: "thr_main",
      turnId: "turn_1",
    });

    const first = renderExpandedRow(deferredTurn, harness);
    expect(
      await screen.findByText("A retained completed answer."),
    ).toBeTruthy();
    vi.useFakeTimers();
    first.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(65_000));

    const returned = renderExpandedRow(deferredTurn, harness);
    expect(screen.getByText("A retained completed answer.")).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    returned.unmount();
    vi.useRealTimers();
  });

  it("refetches an oversized completed detail after the one-minute heavy-payload window", async () => {
    const largeOutput = "x".repeat(17 * 1024);

    const deferredCommand: TimelineRow = {
      ...commandRow({
        id: "large-output",
        command: "large-output",
        output: "",
        sourceSeqStart: 4,
        sourceSeqEnd: 7,
        status: "completed",
        threadId: "thr_main",
        turnId: "turn_1",
      }),
      contentDeferred: true,
    };

    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [
        commandRow({
          id: "large-output",
          command: "large-output",
          output: largeOutput,
          sourceSeqStart: 4,
          sourceSeqEnd: 7,
          status: "completed",
          threadId: "thr_main",
          turnId: "turn_1",
        }),
      ],
    });
    const harness = createQueryClientTestHarness();
    const first = renderExpandedRow(deferredCommand, harness);
    expect((await screen.findByText(/x{200}/)).textContent).toContain("x");
    vi.useFakeTimers();
    first.unmount();
    await act(async () => vi.advanceTimersByTimeAsync(65_000));

    vi.useRealTimers();
    const returned = renderExpandedRow(deferredCommand, harness);
    expect(await screen.findByText(/x{200}/)).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(2);
    returned.unmount();
    vi.useRealTimers();
  });

  it("loads a settled delegation's children by call when it is expanded", async () => {
    const deferred = delegationRow({
      callId: "agent-call",
      childRows: null,
      sourceSeqEnd: 30,
      sourceSeqStart: 12,
      threadId: "thr_main",
      turnId: "turn_1",
    });

    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [
        delegationRow({
          callId: "agent-call",
          childRows: [
            conversationRow({
              id: "child-message",
              text: "Child mapped the integration.",
              threadId: "thr_main",
              turnId: "turn_1",
            }),
          ],
          sourceSeqEnd: 30,
          sourceSeqStart: 12,
          threadId: "thr_main",
          turnId: "turn_1",
        }),
      ],
    });

    renderExpandedRow(deferred);

    expect(
      await screen.findByText("Child mapped the integration."),
    ).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    expect(timelineTurnSummaryDetails.mock.calls[0]?.[0]).toMatchObject({
      deferContent: "true",
      itemId: "agent-call",
      sourceSeqEnd: "30",
      sourceSeqStart: "12",
      threadId: "thr_main",
      turnId: "turn_1",
    });
    expect(screen.queryByText("Load earlier activity")).toBeNull();
  });

  it("loads earlier turn activity only when asked", async () => {
    timelineTurnSummaryDetails.mockImplementation(async (input) =>
      input.beforeCursor === undefined
        ? {
            olderCursor: "older-page",
            rows: [
              conversationRow({
                id: "latest-message",
                text: "Latest turn activity.",
                threadId: "thr_main",
                turnId: "turn_1",
              }),
            ],
          }
        : {
            olderCursor: null,
            rows: [
              conversationRow({
                id: "earlier-message",
                text: "Earlier turn activity.",
                threadId: "thr_main",
                turnId: "turn_1",
              }),
            ],
          },
    );

    renderExpandedRow(
      turnRow({ sourceSeqEnd: 40, threadId: "thr_main", turnId: "turn_1" }),
    );

    expect(await screen.findByText("Latest turn activity.")).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Earlier turn activity.")).toBeNull();

    fireEvent.click(screen.getByText("Load earlier activity"));

    expect(await screen.findByText("Earlier turn activity.")).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(2);
    expect(timelineTurnSummaryDetails.mock.calls[1]?.[0]).toMatchObject({
      beforeCursor: "older-page",
      turnId: "turn_1",
    });
    expect(screen.queryByText("Load earlier activity")).toBeNull();
  });

  it("loads a deferred command's output by item when it is expanded", async () => {
    const loaded = commandRow({
      id: "cmd-deferred",
      command: "pnpm test",
      output: "FULL OUTPUT FROM SERVER",
      sourceSeqStart: 4,
      sourceSeqEnd: 7,
      threadId: "thr_main",
      turnId: "turn_1",
    });

    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [loaded],
    });

    renderExpandedRow({ ...loaded, output: "", contentDeferred: true });

    expect(await screen.findByText(/FULL OUTPUT FROM SERVER/)).toBeTruthy();
    expect(timelineTurnSummaryDetails.mock.calls[0]?.[0]).toMatchObject({
      deferContent: "true",
      itemId: loaded.callId,
      sourceSeqEnd: "7",
      sourceSeqStart: "4",
      turnId: "turn_1",
    });
  });

  it("keeps a deferred reasoning row expandable and loads its text", async () => {
    const reasoning = systemRow({
      detail: "Considered every cursor edge case.",
      id: "reasoning-row",
      operationKind: "reasoning",
      sourceSeqEnd: 3,
      sourceSeqStart: 2,
      threadId: "thr_main",
      title: "Thought",
      turnId: "turn_1",
    });

    if (
      reasoning.systemKind !== "operation" ||
      reasoning.operationKind === "parent-change"
    ) {
      throw new Error("Expected a reasoning operation row");
    }

    const loaded = { ...reasoning, reasoningId: "reasoning-item" };
    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [loaded],
    });

    renderExpandedRow({ ...loaded, detail: null, contentDeferred: true });

    expect(
      await screen.findByText("Considered every cursor edge case."),
    ).toBeTruthy();
    expect(timelineTurnSummaryDetails.mock.calls[0]?.[0]).toMatchObject({
      itemId: "reasoning-item",
    });
  });

  it("keeps showing streamed output while a settled row loads its deferred content", async () => {
    let resolveDetails: (value: {
      olderCursor: null;
      rows: TimelineRow[];
    }) => void = () => {};

    timelineTurnSummaryDetails.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDetails = resolve;
        }),
    );

    const running = commandRow({
      id: "cmd-streaming",
      command: "long-task",
      output: "STREAMED LINE 1",
      sourceSeqStart: 4,
      sourceSeqEnd: 7,
      status: "pending",
      threadId: "thr_main",
      turnId: "turn_1",
    });

    const { wrapper: Wrapper } = createQueryClientTestHarness();

    const renderRows = (rows: TimelineRow[]) => (
      <MemoryRouter>
        <Wrapper>
          <ThreadTimelineRows
            initialExpanded={new Set([running.id])}
            threadId="thr_main"
            timelineRows={rows}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </Wrapper>
      </MemoryRouter>
    );

    const view = render(renderRows([running]));
    const streamed = await screen.findByText(/STREAMED LINE 1/);

    view.rerender(
      renderRows([
        {
          ...running,
          status: "completed",
          exitCode: 0,
          output: "",
          contentDeferred: true,
        },
      ]),
    );

    expect(screen.queryByText("Loading details...")).toBeNull();
    expect(screen.getByText(/STREAMED LINE 1/)).toBe(streamed);
    await vi.waitFor(() => {
      expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    });

    resolveDetails({
      olderCursor: null,
      rows: [
        {
          ...running,
          status: "completed",
          exitCode: 0,
          output: "STREAMED LINE 1\nFINAL LINE 2",
        },
      ],
    });
    expect(await screen.findByText(/FINAL LINE 2/)).toBeTruthy();
    expect(screen.queryByText("Loading details...")).toBeNull();
  });

  it("starts loading a collapsed row's deferred content when its header is pressed", async () => {
    const loaded = commandRow({
      id: "cmd-pressed",
      command: "pnpm lint",
      output: "LINT OUTPUT FROM SERVER",
      sourceSeqStart: 4,
      sourceSeqEnd: 7,
      threadId: "thr_main",
      turnId: "turn_1",
    });

    timelineTurnSummaryDetails.mockResolvedValue({
      olderCursor: null,
      rows: [loaded],
    });

    renderRow({ ...loaded, output: "", contentDeferred: true }, new Set());
    fireEvent.pointerDown(screen.getByText(/pnpm lint/));

    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
    expect(timelineTurnSummaryDetails.mock.calls[0]?.[0]).toMatchObject({
      itemId: loaded.callId,
    });
    expect(screen.queryByText(/LINT OUTPUT FROM SERVER/)).toBeNull();

    fireEvent.click(screen.getByText(/pnpm lint/));

    expect(await screen.findByText(/LINT OUTPUT FROM SERVER/)).toBeTruthy();
    expect(timelineTurnSummaryDetails).toHaveBeenCalledTimes(1);
  });
});

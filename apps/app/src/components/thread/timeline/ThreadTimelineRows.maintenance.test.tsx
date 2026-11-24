// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  conversationRow,
  systemRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const MAINTENANCE_TURN_ID = "turn_maintenance";

function maintenanceRequestRow(
  overrides: { turnRequestStatus?: "pending" | "accepted" | "rejected" } = {},
): TimelineRow {
  return conversationRow({
    id: "maintenance_request",
    role: "user",
    initiator: "system",
    maintenance: "auto-compaction",
    text: "/compact",
    seq: 10,
    turnId: MAINTENANCE_TURN_ID,
    turnRequest: {
      clientRequestId: null,
      isGrouped: false,
      kind: "message",
      status: overrides.turnRequestStatus ?? "accepted",
    },
  });
}

function compactionRow(
  status: "pending" | "completed" | "error" | "interrupted",
  detail: string | null = null,
): TimelineRow {
  return systemRow({
    id: "maintenance_compaction",
    operationKind: "compaction",
    title:
      status === "completed"
        ? "Context compacted"
        : status === "pending"
          ? "Compacting context"
          : status === "error"
            ? "Context compaction failed"
            : "Context compaction interrupted",
    detail,
    status,
    seq: 11,
    turnId: MAINTENANCE_TURN_ID,
  });
}

function renderRows(
  timelineRows: TimelineRow[],
  threadRuntimeDisplayStatus: ThreadRuntimeDisplayStatus = "idle",
) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ThreadTimelineRows
          timelineRows={timelineRows}
          threadRuntimeDisplayStatus={threadRuntimeDisplayStatus}
          workspaceRootPath={undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("automatic compaction rows", () => {
  it("renders a completed maintenance request as a muted system row before the compaction row", () => {
    renderRows([maintenanceRequestRow(), compactionRow("completed")]);

    const requestRow = screen.getByText(
      "Compacted before the prompt cache expired",
    );

    expect(screen.queryByText("/compact")).toBeNull();
    expect(
      requestRow
        .closest("[data-maintenance-run-state]")
        ?.getAttribute("data-maintenance-run-state"),
    ).toBe("done");
    expect(
      requestRow.compareDocumentPosition(
        screen.getByText("Context compacted"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it.each([
    {
      name: "the compaction row failed",
      rows: () => [
        maintenanceRequestRow(),
        compactionRow("error", "Rate limited.\nTry again later."),
      ],
      expected:
        "Automatic compaction failed: Rate limited. Try again later. Full history kept.",
    },
    {
      name: "a provider error ended the turn before compaction began",
      rows: () => [
        maintenanceRequestRow(),
        systemRow({
          id: "maintenance_error",
          systemKind: "error",
          title: "Authentication expired",
          detail: null,
          status: "error",
          seq: 12,
          turnId: MAINTENANCE_TURN_ID,
        }),
      ],
      expected:
        "Automatic compaction failed: Authentication expired. Full history kept.",
    },
    {
      name: "the request was rejected",
      rows: () => [maintenanceRequestRow({ turnRequestStatus: "rejected" })],
      expected: "Automatic compaction failed. Full history kept.",
    },
  ])("reports a failed run when $name", ({ rows, expected }) => {
    renderRows(rows());

    expect(screen.getByText(expected)).toBeTruthy();
    expect(
      screen.queryByText("Compacted before the prompt cache expired"),
    ).toBeNull();
  });

  it.each([
    {
      name: "the compaction row was interrupted",
      rows: () => [maintenanceRequestRow(), compactionRow("interrupted")],
    },
    {
      name: "the thread was stopped before compaction began",
      rows: () => [
        maintenanceRequestRow(),
        systemRow({
          id: "thread_interrupted",
          operationKind: "thread-interrupted",
          title: "Stopped manually",
          detail: null,
          status: "interrupted",
          seq: 12,
          turnId: null,
        }),
      ],
    },
  ])("reports a stopped run when $name", ({ rows }) => {
    renderRows(rows());

    expect(
      screen.getByText("Automatic compaction stopped. Full history kept."),
    ).toBeTruthy();
  });

  it("keeps a later owner turn's interruption off an earlier finished compaction", () => {
    renderRows([
      maintenanceRequestRow(),
      compactionRow("completed"),
      conversationRow({
        id: "owner_message",
        role: "user",
        text: "Carry on",
        seq: 20,
        turnId: "turn_owner",
      }),
      systemRow({
        id: "thread_interrupted",
        operationKind: "thread-interrupted",
        title: "Stopped manually",
        detail: null,
        status: "interrupted",
        seq: 21,
        turnId: null,
      }),
    ]);

    expect(
      screen.getByText("Compacted before the prompt cache expired"),
    ).toBeTruthy();
  });

  it("shows the run in progress while the thread is running it", () => {
    renderRows([maintenanceRequestRow()], "active");

    expect(
      screen.getByText("Compacting before the prompt cache expires"),
    ).toBeTruthy();
  });
});

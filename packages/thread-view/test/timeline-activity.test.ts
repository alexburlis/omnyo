import { timelineRowSchema, type TimelineRow } from "@omnyo/server-contract";
import { describe, expect, it } from "vitest";
import { previewIdRestartedByWholeCommand } from "../src/timeline-activity.js";
import { buildTimelineRowTitle } from "../src/timeline-row-title.js";
import { buildTimelineViewRows } from "../src/timeline-view.js";
import {
  createTimelineEventFactory,
  renderTimelineFixture,
} from "./timeline-test-harness.js";

const TITLE_OPTIONS = { summaryStyle: "bundle", workStyle: "default" } as const;

function previewActivityMetadata(previewId = "prv_lab") {
  return {
    activityKind: "preview",
    ref: { previewId },
    snapshot: { url: "http://127.0.0.1:4317/lab", hostName: "Studio" },
  };
}

function renderActiveTurn(command: {
  text: string;
  exitCode: number;
  activityPreviewId?: string;
}) {
  const factory = createTimelineEventFactory({ threadId: "thread-1" });

  return renderTimelineFixture({
    completedTurnDisplay: "flat",
    projectionOptions: { threadStatus: "active", turnMessageDetail: "full" },
    events: [
      factory.turnStarted({ createdAt: 1_000 }),
      factory.commandStarted({
        itemId: "restart",
        command: command.text,
        createdAt: 2_000,
      }),
      factory.systemOperation({
        turnId: "turn-1",
        operation: "activity",
        operationId: "activity-1",
        status: "completed",
        message: "Started http://127.0.0.1:4317/lab",
        metadata: previewActivityMetadata(command.activityPreviewId),
        createdAt: 3_000,
      }),
      factory.commandCompleted({
        itemId: "restart",
        command: command.text,
        aggregatedOutput: "Preview is online",
        exitCode: command.exitCode,
        status: command.exitCode === 0 ? "completed" : "failed",
        createdAt: 4_000,
      }),
    ],
  });
}

function viewKinds(rows: readonly TimelineRow[]) {
  return buildTimelineViewRows(rows).map((row) =>
    row.kind === "work" ? `work:${row.workKind}` : row.kind,
  );
}

describe("preview activity timeline rows", () => {
  it("projects a thread-scoped preview activity with a structured reference and a plain fallback", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });

    const { rows, text } = renderTimelineFixture({
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
      events: [
        factory.systemOperation({
          operation: "activity",
          operationId: "activity-1",
          status: "completed",
          message: "Started http://127.0.0.1:4317/lab",
          metadata: previewActivityMetadata(),
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "system",
        systemKind: "operation",
        operationKind: "generic",
        status: "completed",
        turnId: null,
        title: "Started localhost:4317/lab",
        detail: "Dev server on Studio",
        activityRef: {
          kind: "preview",
          previewId: "prv_lab",
          url: "http://127.0.0.1:4317/lab",
          hostName: "Studio",
        },
      }),
    ]);

    const [viewRow] = buildTimelineViewRows(rows);
    const title = buildTimelineRowTitle(viewRow!, TITLE_OPTIONS);
    expect(title.plain).toBe("Started localhost:4317/lab");
    expect(title.segments.map((segment) => segment.text)).toEqual([
      "Started",
      "localhost:4317/lab",
    ]);
    expect(text).toContain("Started localhost:4317/lab");
    expect(text).toContain("Dev server on Studio");
  });

  it("keeps the plain row when the activity metadata is not a known activity", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });

    const { rows } = renderTimelineFixture({
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
      events: [
        factory.systemOperation({
          operation: "activity",
          status: "completed",
          message: "Started something",
          metadata: { activityKind: "future" },
        }),
      ],
    });

    expect(rows[0]).toMatchObject({ title: "Activity" });
    expect(rows[0]).not.toHaveProperty("activityRef");
  });

  it("drops an unknown activity reference from a newer server instead of rejecting the row", () => {
    const parsed = timelineRowSchema.parse({
      id: "row-1",
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      kind: "system",
      systemKind: "operation",
      operationKind: "generic",
      title: "Opened a notebook",
      detail: null,
      status: "completed",
      completedAt: 1,
      activityRef: { kind: "notebook", notebookId: "nb_1" },
    });

    expect(parsed).toMatchObject({ title: "Opened a notebook" });
    expect(parsed).not.toHaveProperty("activityRef", expect.anything());
  });

  it("folds the agent's successful restart command into the activity step", () => {
    const { rows } = renderActiveTurn({
      text: "omnyo preview restart prv_lab --json",
      exitCode: 0,
    });

    expect(viewKinds(rows)).toEqual(["system"]);
  });

  it("keeps a failed restart command visible", () => {
    const { rows } = renderActiveTurn({
      text: "omnyo preview restart prv_lab",
      exitCode: 1,
    });

    expect(viewKinds(rows)).toEqual(["work:command", "system"]);
  });

  it("keeps a restart command for a different preview", () => {
    const { rows } = renderActiveTurn({
      text: "omnyo preview restart prv_other",
      exitCode: 0,
    });

    expect(viewKinds(rows)).toEqual(["work:command", "system"]);
  });

  it.each([
    "omnyo preview restart prv_lab && pnpm test",
    "omnyo preview restart prv_lab; sleep 1",
    "omnyo preview restart prv_lab | head",
    "omnyo preview restart prv_lab || true",
    "(omnyo preview restart prv_lab)",
  ])("keeps the chained command %s visible", (text) => {
    const { rows } = renderActiveTurn({ text, exitCode: 0 });

    expect(viewKinds(rows)).toEqual(["work:command", "system"]);
  });

  it("keeps a restart of the same preview from an earlier turn visible", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });
    const command = "omnyo preview restart prv_lab";

    const { rows } = renderTimelineFixture({
      completedTurnDisplay: "flat",
      projectionOptions: { threadStatus: "active", turnMessageDetail: "full" },
      events: [
        factory.turnStarted({ createdAt: 1_000 }),
        factory.commandStarted({
          itemId: "restart",
          command,
          createdAt: 2_000,
        }),
        factory.commandCompleted({
          itemId: "restart",
          command,
          aggregatedOutput: "Preview is online",
          exitCode: 0,
          createdAt: 3_000,
        }),
        factory.turnCompleted({ createdAt: 4_000 }),
        factory.turnStarted({ turnId: "turn-2", createdAt: 5_000 }),
        factory.systemOperation({
          turnId: "turn-2",
          operation: "activity",
          operationId: "activity-2",
          status: "completed",
          message: "Started http://127.0.0.1:4317/lab",
          metadata: previewActivityMetadata(),
          createdAt: 6_000,
        }),
      ],
    });

    expect(viewKinds(rows)).toEqual(["work:command", "system"]);
  });

  it.each([
    ["omnyo preview restart prv_a", "prv_a"],
    ["bash -lc 'omnyo preview restart prv_a'", "prv_a"],
    ['zsh -lc "cd /repo && omnyo preview restart prv_a --json"', "prv_a"],
    ["omnyo preview restart --request-id tap-1 prv_a --json", "prv_a"],
    ["omnyo preview restart --request-id=tap-1 prv_a", "prv_a"],
    ["cd app && /usr/local/bin/omnyo preview restart prv_a", "prv_a"],
    ["FORCE_COLOR=0 omnyo preview restart prv_a 2>&1", "prv_a"],
    ["omnyo preview restart prv_a >/dev/null 2>&1", "prv_a"],
    ["omnyo preview restart prv_a > out.txt", null],
    ["omnyo preview restart prv_a prv_b", null],
    ["omnyo preview restart prv_a --verbose", null],
    ["omnyo preview restart $(cat id)", null],
    ["omnyo preview status prv_a", null],
    ["echo omnyo preview restart prv_a", null],
  ])("reads the whole-command restart from %s", (command, expected) => {
    expect(previewIdRestartedByWholeCommand(command)).toBe(expected);
  });
});

function childActivityMetadata(
  state: "running" | "finished",
  summary: string | null,
) {
  return {
    activityKind: "child",
    ref: { threadId: "thr_child" },
    snapshot: { title: "OMNYO-V: investigate", state, summary },
  };
}

describe("child activity timeline rows", () => {
  it("settles a running child row into one finished row with its summary and a link to the child", () => {
    const factory = createTimelineEventFactory({ threadId: "thread-1" });

    const { rows } = renderTimelineFixture({
      projectionOptions: { threadStatus: "idle", turnMessageDetail: "full" },
      events: [
        factory.systemOperation({
          operation: "activity",
          operationId: "child-activity:thr_child",
          status: "running",
          message: "OMNYO-V: investigate is running",
          metadata: childActivityMetadata("running", null),
          createdAt: 1_000,
        }),
        factory.systemOperation({
          operation: "activity",
          operationId: "child-activity:thr_child",
          status: "completed",
          message: "OMNYO-V: investigate finished",
          metadata: childActivityMetadata(
            "finished",
            "Needs matching browser and coordinator timings.",
          ),
          createdAt: 2_000,
        }),
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "system",
        status: "completed",
        title: "OMNYO-V: investigate finished",
        activityRef: {
          kind: "child",
          threadId: "thr_child",
          title: "OMNYO-V: investigate",
          state: "finished",
          summary: "Needs matching browser and coordinator timings.",
        },
      }),
    ]);

    const [viewRow] = buildTimelineViewRows(rows);
    const title = buildTimelineRowTitle(viewRow!, TITLE_OPTIONS);
    expect(title.segments).toEqual([
      expect.objectContaining({
        text: "OMNYO-V: investigate",
        link: { kind: "thread", threadId: "thr_child" },
      }),
      expect.objectContaining({ text: "finished" }),
    ]);
  });
});

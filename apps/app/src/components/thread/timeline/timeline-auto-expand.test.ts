import { describe, expect, it } from "vitest";
import { buildTimelineViewRows } from "@omnyo/thread-view";
import {
  ECHO_RECEIPT_PRESENTATION,
  commandRow,
  conversationRow,
  delegationRow,
  extensionRow,
  imageViewRow,
  systemRow,
  workflowRow,
} from "@/test/fixtures/thread-timeline-rows";
import { isRowExpandable } from "@omnyo/client-core";
import { collectLiveTimelineExpansionRowIds } from "./timeline-live-expansion";

interface CollectAutoExpandedIdsArgs {
  rows: ReturnType<typeof buildTimelineViewRows>;
  scopeActive: boolean;
}

function collectAutoExpandedIds({
  rows,
  scopeActive,
}: CollectAutoExpandedIdsArgs): Set<string> {
  const liveExpandedRowIds = collectLiveTimelineExpansionRowIds({
    rows,
    scopeActive,
  });

  return new Set(liveExpandedRowIds);
}

const extensionPresentation = {
  ...ECHO_RECEIPT_PRESENTATION,
  icon: { glyph: "Check" },
};

describe("isRowExpandable", () => {
  it.each([
    {
      label: "an error-only degraded workflow row",
      row: workflowRow({
        error: "agent abandoned: user requested retry on all 3 attempts",
        status: "error",
        taskStatus: "failed",
      }),
      expandable: true,
    },
    {
      label: "a degraded workflow row without workflow, summary, or error",
      row: workflowRow({ status: "pending", taskStatus: "running" }),
      expandable: false,
    },
    ...[undefined, "", "   ", "\n\t "].map((detail) => ({
      label: `an extension row with detail ${JSON.stringify(detail)}`,
      row: extensionRow({
        presentation: { ...extensionPresentation, detail },
      }),
      expandable: false,
    })),
    {
      label: "an extension row with detail text",
      row: extensionRow({
        presentation: { ...extensionPresentation, detail: "Echoed **2**" },
      }),
      expandable: true,
    },
  ])("treats $label as expandable: $expandable", ({ row, expandable }) => {
    expect(isRowExpandable(row)).toBe(expandable);
  });
});

describe("collectLiveTimelineExpansionRowIds", () => {
  it("keeps only pending command details open", () => {
    const rows = buildTimelineViewRows(
      [1, 2, 3, 4].map((sequence) =>
        commandRow({
          id: `command-${sequence}`,
          command: `echo ${sequence}`,
          sourceSeqStart: sequence,
          sourceSeqEnd: sequence,
          status: sequence === 4 ? "pending" : "completed",
        }),
      ),
    );

    const liveExpandedRowIds = collectLiveTimelineExpansionRowIds({
      rows,
      scopeActive: true,
    });

    expect(liveExpandedRowIds.has("command-1")).toBe(false);
    expect(liveExpandedRowIds.has("command-2")).toBe(false);
    expect(liveExpandedRowIds.has("command-3")).toBe(false);
    expect(liveExpandedRowIds.has("command-4")).toBe(true);
  });

  it("returns no auto-expanded ids when the scope is inactive", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        output: "first output",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a trailing bundle and its recent commands", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const bundle = rows[0];

    if (!bundle || bundle.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([
      bundle.id,
      "command-pending-1",
      "command-pending-2",
    ]);

    for (const child of bundle.children) {
      expect(ids.has(child.id)).toBe(true);
    }
  });

  it("auto-expands a trailing pending system row with detail in an active scope", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "system-with-detail",
        detail: "provider transcript",
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["system-with-detail"]);
  });

  it("does not live-auto-expand a completed system row with detail in an active scope", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "completed-system-with-detail",
        detail: "completed transcript",
        status: "completed",
      }),
    ]);

    const liveExpandedRowIds = collectLiveTimelineExpansionRowIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(liveExpandedRowIds)).toEqual([]);
  });

  it("does not auto-expand a terminal system error after a follow-up makes the scope active", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "provider-rate-limit",
        detail:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        status: "error",
        systemKind: "error",
        title: "Provider rate limit reached",
        sourceSeqStart: 1,
      }),
      conversationRow({
        id: "follow-up",
        role: "user",
        text: "please keep going",
        sourceSeqStart: 2,
        turnRequest: {
          clientRequestId: null,
          isGrouped: false,
          kind: "message",
          status: "accepted",
        },
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("keeps a terminal system error collapsed after the turn ends", () => {
    const rows = buildTimelineViewRows([
      systemRow({
        id: "provider-rate-limit",
        detail:
          "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.",
        status: "error",
        systemKind: "error",
        title: "Provider rate limit reached",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("keeps nested failure diagnostics collapsed", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "pending-delegation-with-terminal-error",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-command",
            command: "pnpm test",
            output: "command output",
            sourceSeqStart: 1,
          }),
          systemRow({
            id: "nested-provider-error",
            detail: "Provider rate limit reached",
            status: "error",
            systemKind: "error",
            title: "Provider error",
            sourceSeqStart: 2,
          }),
        ],
      }),
    ]);

    const liveExpandedRowIds = collectLiveTimelineExpansionRowIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(liveExpandedRowIds)).toEqual([]);
  });

  it("auto-expands a recent command row in an active scope", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        output: "first output",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["command-1"]);
  });

  it("auto-expands a trailing image view row in an active scope", () => {
    const rows = buildTimelineViewRows([
      imageViewRow({
        id: "image-view-1",
        sourceSeqStart: 1,
        status: "pending",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual(["image-view-1"]);
  });

  it("folds a completed image view row in an active scope", () => {
    const rows = buildTimelineViewRows([
      imageViewRow({
        durationMs: 500,
        id: "image-view-1",
        sourceSeqStart: 1,
        status: "completed",
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("folds all completed bundles in an active scope", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-1",
        command: "pnpm test",
        sourceSeqStart: 1,
      }),
      commandRow({
        id: "command-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
      }),
      commandRow({
        id: "explore-1",
        command: "cat src/app.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/app.ts",
            name: "app.ts",
            path: "src/app.ts",
          },
        ],
        sourceSeqStart: 3,
      }),
      commandRow({
        id: "explore-2",
        command: "cat src/other.ts",
        activityIntents: [
          {
            type: "read",
            command: "cat src/other.ts",
            name: "other.ts",
            path: "src/other.ts",
          },
        ],
        sourceSeqStart: 4,
      }),
    ]);

    expect(rows).toHaveLength(2);
    const [displaced, trailing] = rows;

    if (!displaced || displaced.kind !== "bundle-summary") {
      throw new Error("expected the first row to be a bundle-summary");
    }

    if (!trailing || trailing.kind !== "bundle-summary") {
      throw new Error("expected the trailing row to be a bundle-summary");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(trailing.id)).toBe(false);
    expect(ids.has(displaced.id)).toBe(false);
  });

  it("folds earlier commands when the assistant starts a message", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "assistant-final",
        role: "assistant",
        text: "All done.",
        sourceSeqStart: 3,
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("looks past trailing user conversation rows when finding the frontier", () => {
    const rows = buildTimelineViewRows([
      commandRow({
        id: "command-pending-1",
        command: "pnpm test",
        sourceSeqStart: 1,
        status: "pending",
      }),
      commandRow({
        id: "command-pending-2",
        command: "pnpm lint",
        sourceSeqStart: 2,
        status: "pending",
      }),
      conversationRow({
        id: "pending-steer-1",
        role: "user",
        text: "Keep this in mind",
        turnRequest: {
          clientRequestId: null,
          isGrouped: false,
          kind: "steer",
          status: "pending",
        },
      }),
    ]);

    const bundle = rows.find((row) => row.kind === "bundle-summary");

    if (!bundle) {
      throw new Error("expected a bundle-summary row in the view");
    }

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has(bundle.id)).toBe(true);
  });

  it("does not auto-expand a pending delegation's frontier on an idle thread", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "idle-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: false,
    });

    expect(Array.from(ids)).toEqual([]);
  });

  it("auto-expands a pending delegation's frontier when the top-level scope is active", () => {
    const rows = buildTimelineViewRows([
      delegationRow({
        id: "active-pending-delegation",
        status: "pending",
        childRows: [
          commandRow({
            id: "nested-pending-command",
            command: "pnpm test",
            output: "still running",
            sourceSeqStart: 50,
            status: "pending",
          }),
        ],
      }),
    ]);

    const ids = collectAutoExpandedIds({
      rows,
      scopeActive: true,
    });

    expect(ids.has("active-pending-delegation")).toBe(true);
    expect(ids.has("nested-pending-command")).toBe(true);
  });
});

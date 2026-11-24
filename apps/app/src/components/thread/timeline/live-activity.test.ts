import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  commandRow,
  delegationRow,
  fileChangeRow,
  fileReadRow,
  planStepsRow,
  searchRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import { summarizeLiveActivity } from "./live-activity";

describe("summarizeLiveActivity", () => {
  const label = (row: TimelineRow) =>
    summarizeLiveActivity({
      activeThinking: null,
      label: undefined,
      rows: [row],
    }).label;

  it("names the pending step the way its timeline row does", () => {
    const cases: Array<[TimelineRow, string]> = [
      [
        fileChangeRow({
          path: "/repo/src/theme.css",
          kind: "update",
          status: "pending",
        }),
        "Editing theme.css",
      ],
      [
        fileChangeRow({
          path: "/repo/src/new.ts",
          kind: "add",
          status: "pending",
        }),
        "Creating new.ts",
      ],
      [
        fileReadRow({
          path: "/repo/src/ThreadTimelinePanelContent.tsx",
          status: "pending",
        }),
        "Reading ThreadTimelinePanelContent.tsx",
      ],
      [
        searchRow({
          mode: "content",
          query: "TimelineWorkingIndicator",
          status: "pending",
        }),
        "Searching for TimelineWorkingIndicator",
      ],
      [
        commandRow({
          command: "pnpm test:dev --package @omnyo/app",
          status: "pending",
        }),
        "Running pnpm test:dev",
      ],
      [
        commandRow({
          command: `/bin/zsh -lc "pnpm exec turbo run typecheck"`,
          status: "pending",
        }),
        "Running pnpm exec",
      ],
      [
        delegationRow({ subagentType: "scout", status: "pending" }),
        "Waiting on scout",
      ],
      [planStepsRow({ status: "pending" }), "Updating plan"],
      [
        commandRow({
          command: "pnpm build",
          approvalStatus: "waiting_for_approval",
          status: "pending",
        }),
        "Waiting for approval",
      ],
    ];

    for (const [row, expected] of cases) {
      expect(label(row)).toBe(expected);
    }
  });

  it("keeps the existing labels", () => {
    expect(label(toolRow({ toolName: "Grep", status: "pending" }))).toBe(
      "Using Grep",
    );
  });

  it("keeps the whole command as the expandable detail", () => {
    const command =
      "L=/Users/developer/worktrees/omnyo/run--sentry-fix; S=$TMPDIR/typecheck; pnpm exec tsc";

    const summary = summarizeLiveActivity({
      activeThinking: null,
      label: undefined,
      rows: [commandRow({ command, status: "pending" })],
    });

    expect(summary.label).toBe(
      "Running L=/Users/developer/worktrees/omnyo/run--sentry-fix; S=$TMPDIR/typecheck;",
    );
    expect(summary.detail).toBe(`Running ${command}`);
  });
});

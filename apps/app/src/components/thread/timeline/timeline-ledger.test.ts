import { describe, expect, it } from "vitest";
import {
  commandRow,
  fileChangeRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import { timelineRailPositions } from "./timeline-nested-group-line";
import {
  formatTimelineFigureDuration,
  formatTimelineLiveDuration,
  timelineRowFigureTiming,
} from "./timeline-row-figure";
import { formatWorkedDuration } from "./timeline-turn-activity";
import { timelineWorkSummaryNote } from "./timeline-work-summary-note";

describe("timeline ledger figures", () => {
  it.each([
    [0, "0.0s"],
    [420, "0.4s"],
    [3_240, "3.2s"],
    [12_400, "12s"],
    [100_000, "1m 40s"],
    [120_000, "2m"],
    [3_900_000, "1h 5m"],
  ])("formats %dms as %s", (durationMs, label) => {
    expect(formatTimelineFigureDuration(durationMs)).toBe(label);
  });

  it("ticks a live figure in whole seconds from zero", () => {
    expect(formatTimelineLiveDuration(400)).toBe("0s");
    expect(formatTimelineLiveDuration(61_900)).toBe("1m 1s");
  });

  it("times settled, live and untimed rows", () => {
    expect(
      timelineRowFigureTiming(commandRow({ command: "ls", durationMs: 250 })),
    ).toEqual({ kind: "settled", durationMs: 250 });
    expect(
      timelineRowFigureTiming(
        commandRow({ command: "ls", status: "pending", startedAt: 5 }),
      ),
    ).toEqual({ kind: "live", startedAt: 5 });
    expect(
      timelineRowFigureTiming(
        toolRow({
          status: "pending",
          approvalStatus: "waiting_for_approval",
        }),
      ),
    ).toBeNull();
    expect(timelineRowFigureTiming(fileChangeRow({}))).toBeNull();
  });

  it.each([
    [42_000, "42s"],
    [100_000, "1m 40s"],
    [540_000, "9m"],
    [720_000, "12m"],
    [3_900_000, "1h 5m"],
  ])("summarises a %dms turn as %s", (durationMs, label) => {
    expect(formatWorkedDuration(durationMs)).toBe(label);
  });
});

describe("timeline ledger rail", () => {
  it("joins consecutive work rows within a turn and breaks at everything else", () => {
    expect(
      timelineRailPositions([
        { eligible: true, continuesTurn: false },
        { eligible: true, continuesTurn: true },
        { eligible: true, continuesTurn: true },
        { eligible: false, continuesTurn: true },
        { eligible: true, continuesTurn: true },
        { eligible: true, continuesTurn: false },
        { eligible: true, continuesTurn: true },
      ]),
    ).toEqual(["first", "middle", "last", null, null, "first", "last"]);
  });
});

describe("timeline work summary notes", () => {
  it("counts failures and notes a later passing test run", () => {
    expect(
      timelineWorkSummaryNote([
        commandRow({ command: "pnpm test", status: "error", exitCode: 1 }),
        fileChangeRow({}),
        commandRow({ command: "pnpm test", exitCode: 0 }),
      ]),
    ).toEqual({ text: "1 failed, then passed", tone: "meta" });
  });

  it("keeps unresolved failures and interruptions destructive", () => {
    expect(
      timelineWorkSummaryNote([
        commandRow({ command: "pnpm test", exitCode: 0 }),
        commandRow({ command: "git push", status: "error", exitCode: 1 }),
        toolRow({ status: "interrupted" }),
      ]),
    ).toEqual({ text: "1 failed, 1 interrupted", tone: "negative" });
    expect(timelineWorkSummaryNote([commandRow({ command: "ls" })])).toBeNull();
  });
});

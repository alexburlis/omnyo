import { describe, expect, it } from "vitest";
import {
  commandRow,
  fileChangeRow,
  toolRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  timelineTitleLeadWords,
  timelineWorkResult,
  workResultRepeatsTitle,
} from "./timeline-work-result";
import { pastRowDimClassName } from "./timeline-row-prominence";

describe("timeline work results", () => {
  it("keeps failed work readable in an idle turn", () => {
    expect(
      pastRowDimClassName({
        row: toolRow({ status: "error" }),
        activeLatestBundleId: null,
        scopeActive: false,
      }),
    ).toBeUndefined();
  });
  it.each([
    [" Tests  50 passed (50)", "50 passed", "positive"],
    [" Tests  4 failed | 46 passed (50)", "4 failed", "negative"],
    [" Tests  48 passed | 2 skipped (50)", "48 passed · 2 skipped", "warning"],
    [" Tests  0 passed (0)", "no tests ran", "warning"],
  ])("shows the measured summary from %s", (output, label, tone) => {
    expect(
      timelineWorkResult(
        commandRow({
          command: "vitest run",
          output,
          status: tone === "negative" ? "error" : "completed",
          exitCode: tone === "negative" ? 1 : 0,
        }),
      ),
    ).toEqual({ label, tone });
  });

  it("does not turn a passed test summary into a successful failed process", () => {
    expect(
      timelineWorkResult(
        commandRow({
          command: "vitest run && build",
          output: " Tests  50 passed (50)",
          exitCode: 2,
        }),
      ),
    ).toEqual({ label: "50 passed · exit 2", tone: "negative" });
  });

  it.each([
    "maybe 50 passed",
    " Tests  50 passed (60)",
    " Tests  2 passed (2)\n Tests  3 passed (3)",
  ])("says nothing for unproven or ambiguous counts", (output) => {
    expect(
      timelineWorkResult(commandRow({ command: "test", output, exitCode: 0 })),
    ).toBeNull();
  });

  it("does not summarize an incomplete output preview", () => {
    const row = commandRow({
      command: "test",
      output: " Tests  50 passed (50)",
      exitCode: 0,
    });

    expect(
      timelineWorkResult({
        ...row,
        outputPreview: {
          totalChars: 20000,
          experimental_fullOutputAvailability: "available",
        },
      }),
    ).toBeNull();
  });

  it("distinguishes approval waits from running work", () => {
    expect(
      timelineWorkResult(
        toolRow({ status: "pending", approvalStatus: "waiting_for_approval" }),
      ),
    ).toEqual({ label: "needs approval", tone: "warning" });
  });

  it("names only outcomes worth reading next to the title", () => {
    expect(
      timelineWorkResult(commandRow({ command: "test", status: "pending" })),
    ).toBeNull();
    expect(
      timelineWorkResult(commandRow({ command: "test", exitCode: null })),
    ).toBeNull();
    expect(
      timelineWorkResult(
        commandRow({ command: "test", status: "error", exitCode: 2 }),
      ),
    ).toEqual({ label: "exit 2", tone: "negative" });
    expect(timelineWorkResult(toolRow({ status: "error" }))).toEqual({
      label: "failed",
      tone: "negative",
    });
    expect(timelineWorkResult(fileChangeRow({}))).toBeNull();
    expect(
      timelineWorkResult(fileChangeRow({ status: "interrupted" })),
    ).toEqual({ label: "interrupted", tone: "warning" });
  });

  it.each([
    ["failed", "Failed workflow: fixture-mini (3/3 agents)", true],
    ["failed", "Background command failed: Build the project", true],
    ["interrupted", "Interrupted workflow: fixture-mini", false],
    ["denied", "Permission denied: rm -rf node_modules", false],
    ["needs approval", "Waiting for approval to run git push", false],
    ["failed", "Ran tool: inspect_preview", false],
    ["exit 2", "Ran pnpm build failed", false],
  ])(
    "drops only a red failed tag that the title already says (%s)",
    (label, titlePlain, repeated) => {
      expect(
        workResultRepeatsTitle({ label, tone: "negative" }, titlePlain),
      ).toBe(repeated);
    },
  );

  it("reads only the leading verb, never the subject, when checking for a repeated status", () => {
    const segment = (text: string, em: boolean) => ({
      text,
      em,
      shimmer: false,
      truncate: false,
    });

    const title = (segments: ReturnType<typeof segment>[]) => ({
      segments,
      decorations: [],
      tone: "default" as const,
      action: null,
      plain: segments.map(({ text }) => text).join(" "),
    });

    expect(
      timelineTitleLeadWords(
        title([segment("Read", false), segment("src/failed-login.ts", true)]),
      ),
    ).toBe("Read");
    expect(
      workResultRepeatsTitle(
        { label: "failed", tone: "negative" },
        timelineTitleLeadWords(
          title([segment("Read", false), segment("src/failed-login.ts", true)]),
        ),
      ),
    ).toBe(false);
    expect(
      timelineTitleLeadWords(
        title([segment("Failed workflow:", false), segment("mini", true)]),
      ),
    ).toBe("Failed workflow:");
  });
});

import type { ThreadTimelineViewRow, TimelineTitle } from "@omnyo/thread-view";

export function timelineTitleLeadWords(title: TimelineTitle): string {
  const lead = title.segments[0];

  if (lead === undefined || lead.em || lead.link !== undefined) return "";

  return lead.plainText ?? lead.text;
}

export interface TimelineWorkResult {
  label: string;
  tone: "positive" | "negative" | "warning";
}

function testSummary(output: string): TimelineWorkResult | null {
  if (output.length > 131_072) return null;

  const lines = output.replace(/\u001b\[[\d;]*m/gu, "").split(/\r?\n/u);

  const summaries = lines.filter((line) =>
    /^\s*Tests\s+.+\(\d+\)\s*$/u.test(line),
  );

  if (summaries.length !== 1) return null;

  const summary = summaries[0];

  if (summary === undefined) return null;
  const match = /^\s*Tests\s+(.+)\((\d+)\)\s*$/u.exec(summary);

  if (match === null) return null;

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const part of (match[1] ?? "").trim().split(/\s*\|\s*/u)) {
    const count = /^(\d+) (passed|failed|skipped|todo)$/u.exec(part.trim());

    if (count === null) return null;
    const value = Number(count[1]);

    if (!Number.isSafeInteger(value)) return null;

    if (count[2] === "passed") passed += value;
    else if (count[2] === "failed") failed += value;
    else skipped += value;
  }

  const total = Number(match[2]);

  if (!Number.isSafeInteger(total) || passed + failed + skipped !== total)
    return null;

  if (failed > 0) return { label: `${failed} failed`, tone: "negative" };

  if (skipped > 0) {
    return {
      label: `${passed} passed · ${skipped} skipped`,
      tone: "warning",
    };
  }

  if (total === 0) return { label: "no tests ran", tone: "warning" };

  return { label: `${passed} passed`, tone: "positive" };
}

export function timelineWorkResult(
  row: ThreadTimelineViewRow,
): TimelineWorkResult | null {
  if (row.kind !== "work") return null;

  if (
    "approvalStatus" in row &&
    row.approvalStatus === "waiting_for_approval"
  ) {
    return { label: "needs approval", tone: "warning" };
  }

  if (row.status === "pending") return null;

  if ("approvalStatus" in row && row.approvalStatus === "denied") {
    return { label: "denied", tone: "negative" };
  }

  if (row.status === "interrupted")
    return { label: "interrupted", tone: "warning" };

  if (row.workKind === "command") {
    const failed =
      row.status === "error" || (row.exitCode !== null && row.exitCode !== 0);

    const summary =
      row.contentDeferred || row.outputPreview ? null : testSummary(row.output);

    if (failed) {
      const exit =
        row.exitCode === null || row.exitCode === 0
          ? "failed"
          : `exit ${row.exitCode}`;

      if (summary === null) return { label: exit, tone: "negative" };

      return {
        label:
          summary.tone === "negative"
            ? summary.label
            : `${summary.label} · ${exit}`,
        tone: "negative",
      };
    }

    return summary;
  }

  if (row.status === "error") return { label: "failed", tone: "negative" };

  return null;
}

const TITLE_STATED_RESULTS: ReadonlyMap<string, RegExp> = new Map([
  ["failed", /\bfail(?:ed|ure)?\b/iu],
]);

export function workResultRepeatsTitle(
  result: TimelineWorkResult,
  titlePlain: string,
): boolean {
  return TITLE_STATED_RESULTS.get(result.label)?.test(titlePlain) ?? false;
}

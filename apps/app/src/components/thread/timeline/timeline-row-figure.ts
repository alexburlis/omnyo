import type {
  ThreadTimelineViewRow,
  TimelineWorkSummaryChild,
} from "@omnyo/thread-view";

export type TimelineRowFigureTiming =
  | { kind: "live"; startedAt: number }
  | { kind: "settled"; durationMs: number };

const SECOND_MS = 1_000;

function formatWholeSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return `${totalSeconds}s`;

  if (totalSeconds < 3_600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatTimelineFigureDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / SECOND_MS;

  if (seconds < 9.95) return `${seconds.toFixed(1)}s`;

  return formatWholeSeconds(Math.round(seconds));
}

export function formatTimelineLiveDuration(elapsedMs: number): string {
  return formatWholeSeconds(Math.max(0, Math.floor(elapsedMs / SECOND_MS)));
}

function settledDurationMs(
  row: ThreadTimelineViewRow | TimelineWorkSummaryChild,
): number | null {
  if (!("completedAt" in row) || row.completedAt === null) return null;

  return Math.max(0, row.completedAt - row.startedAt);
}

function isAwaitingApproval(row: ThreadTimelineViewRow): boolean {
  return (
    "approvalStatus" in row && row.approvalStatus === "waiting_for_approval"
  );
}

export function timelineRowFigureTiming(
  row: ThreadTimelineViewRow,
): TimelineRowFigureTiming | null {
  if (row.kind === "bundle-summary" || row.kind === "step-summary") {
    if (row.status === "pending") return null;

    let total = 0;
    let measured = false;

    for (const child of row.children) {
      const durationMs = settledDurationMs(child);

      if (durationMs === null) continue;
      total += durationMs;
      measured = true;
    }

    return measured ? { kind: "settled", durationMs: total } : null;
  }

  if (!("completedAt" in row)) return null;

  if (row.status === "pending") {
    return isAwaitingApproval(row)
      ? null
      : { kind: "live", startedAt: row.startedAt };
  }

  const durationMs = settledDurationMs(row);

  return durationMs === null ? null : { kind: "settled", durationMs };
}

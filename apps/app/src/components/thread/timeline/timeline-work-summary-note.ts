import type {
  ThreadTimelineViewRow,
  TimelineWorkSummaryChild,
} from "@omnyo/thread-view";
import { classifyShellCommandPhase } from "./timeline-work-lane";

export interface TimelineWorkSummaryNote {
  text: string;
  tone: "negative" | "meta";
}

export function isFailedTimelineWork(
  row: ThreadTimelineViewRow | TimelineWorkSummaryChild,
): boolean {
  if (row.kind !== "work") return false;

  if (row.status === "error") return true;

  return (
    row.workKind === "command" &&
    row.status === "completed" &&
    row.exitCode !== null &&
    row.exitCode !== 0
  );
}

function isPassingTestCommand(child: TimelineWorkSummaryChild): boolean {
  return (
    child.kind === "work" &&
    child.workKind === "command" &&
    child.status === "completed" &&
    child.exitCode === 0 &&
    classifyShellCommandPhase(child.command) === "test"
  );
}

export function timelineWorkSummaryNote(
  children: readonly TimelineWorkSummaryChild[],
): TimelineWorkSummaryNote | null {
  let failedCount = 0;
  let interruptedCount = 0;
  let lastFailureIndex = -1;

  children.forEach((child, index) => {
    if (isFailedTimelineWork(child)) {
      failedCount += 1;
      lastFailureIndex = index;
    } else if (child.status === "interrupted") {
      interruptedCount += 1;
    }
  });

  const recovered =
    failedCount > 0 &&
    children.slice(lastFailureIndex + 1).some(isPassingTestCommand);

  const parts = [
    failedCount > 0
      ? `${failedCount} failed${recovered ? ", then passed" : ""}`
      : null,
    interruptedCount > 0 ? `${interruptedCount} interrupted` : null,
  ].filter((part) => part !== null);

  if (parts.length === 0) return null;

  return {
    text: parts.join(", "),
    tone: failedCount > 0 && !recovered ? "negative" : "meta",
  };
}

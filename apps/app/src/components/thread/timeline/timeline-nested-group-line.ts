import {
  assertNever,
  isTimelineActivityRow,
  type ThreadTimelineViewRow,
} from "@omnyo/thread-view";
import { cn } from "@omnyo/shared-ui/lib/utils";

export const NESTED_TIMELINE_GROUP_LINE_CLASS_NAME =
  "relative my-1 pl-3 pr-2 before:pointer-events-none before:absolute before:bottom-1 before:left-1.5 before:top-0 before:w-px before:bg-border-seam before:content-['']";

export type TimelineRailPosition = "first" | "middle" | "last";

export type TimelineRailInset = "inset" | "flush";

export type TimelineRailEnd = "first-line" | "last-line";

const RAIL_LINE_CLASS_NAME =
  "relative before:pointer-events-none before:absolute before:w-px before:bg-timeline-rail before:content-['']";

const RAIL_X_CLASS_NAME: Record<TimelineRailInset, string> = {
  inset: "before:left-[17.5px]",
  flush: "before:left-[9.5px]",
};

export const TIMELINE_LEDGER_BODY_INSET_CLASS_NAME: Record<
  TimelineRailInset,
  string
> = {
  inset: "pl-10 pr-2",
  flush: "pl-8 pr-0",
};

export function timelineRailClassName({
  end,
  inset,
  position,
}: {
  end: TimelineRailEnd;
  inset: TimelineRailInset;
  position: TimelineRailPosition;
}): string {
  return cn(
    RAIL_LINE_CLASS_NAME,
    RAIL_X_CLASS_NAME[inset],
    position === "first" && "before:bottom-0 before:top-3.5",
    position === "middle" && "before:bottom-0 before:top-0",
    position === "last" &&
      (end === "last-line"
        ? "before:bottom-3.5 before:top-0"
        : "before:top-0 before:h-3.5"),
  );
}

export function isTimelineLedgerRow(row: ThreadTimelineViewRow): boolean {
  switch (row.kind) {
    case "work":
    case "bundle-summary":
    case "step-summary":
      return true;
    case "system":
      return (
        (row.systemKind === "operation" && row.operationKind === "reasoning") ||
        isTimelineActivityRow(row)
      );
    case "conversation":
    case "turn":
      return false;
    default:
      return assertNever(row);
  }
}

export function timelineRailPositions(
  links: readonly { eligible: boolean; continuesTurn: boolean }[],
): (TimelineRailPosition | null)[] {
  const joinsPrevious = links.map(
    (link, index) =>
      link.eligible &&
      link.continuesTurn &&
      index > 0 &&
      links[index - 1]?.eligible === true,
  );

  return links.map((link, index) => {
    if (!link.eligible) return null;
    const fromPrevious = joinsPrevious[index] === true;
    const toNext = joinsPrevious[index + 1] === true;

    if (fromPrevious && toNext) return "middle";

    if (fromPrevious) return "last";

    if (toNext) return "first";

    return null;
  });
}

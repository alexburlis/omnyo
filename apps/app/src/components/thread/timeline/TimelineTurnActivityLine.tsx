import { Fragment } from "react";
import { useMinuteNow } from "@omnyo/shared-ui/hooks/use-minute-now";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import type { TimelineViewTurnRow } from "@omnyo/thread-view";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { formatShortMessageTime } from "./MessageActionBar";
import { buildTurnActivityLine } from "./timeline-turn-activity";

const NOTE_CLASS_NAME = "shrink-0 whitespace-nowrap text-xs";

function receiptTimeLabel(completedAt: number, now: number): string {
  const label = formatShortMessageTime(completedAt, new Date(now));

  return label === "now" ? "just now" : label;
}

function ReceiptTime({ completedAt }: { completedAt: number }) {
  const now = useMinuteNow();
  const date = new Date(completedAt);

  return (
    <span
      className={`${NOTE_CLASS_NAME} text-timeline-figure`}
      data-turn-receipt-time=""
    >
      <time
        dateTime={date.toISOString()}
        title={date.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "short",
        })}
      >
        {receiptTimeLabel(completedAt, now)}
      </time>
    </span>
  );
}

export function TimelineTurnActivityLine({
  row,
}: {
  row: TimelineViewTurnRow;
}) {
  const { diffStats, duration, failureCount, warningCount } =
    buildTurnActivityLine(row);

  const parts = [
    <span
      key="verb"
      className={`shrink-0 text-subtle-foreground ${CONTROL_HOVER_TRANSITION} group-hover/toggle:text-muted-foreground`}
    >
      {duration === null ? "Worked" : "Worked for"}
    </span>,
    duration === null ? null : (
      <span
        key="duration"
        className={`shrink-0 tabular-nums text-muted-foreground ${CONTROL_HOVER_TRANSITION} group-hover/toggle:text-foreground`}
      >
        {duration}
      </span>
    ),
    diffStats === null ? null : (
      <DiffStatsTally
        key="diff"
        insertions={diffStats.added}
        deletions={diffStats.removed}
        hideZero
        className="shrink-0 text-xs tabular-nums"
      />
    ),
    warningCount > 0 ? (
      <span key="warnings" className={`${NOTE_CLASS_NAME} text-timeline-meta`}>
        {warningCount === 1 ? "1 warning" : `${warningCount} warnings`}
      </span>
    ) : null,
    failureCount > 0 ? (
      <span
        key="failures"
        className={`${NOTE_CLASS_NAME} text-destructive-text`}
      >
        {failureCount} failed
      </span>
    ) : null,
    row.completedAt === null ? null : (
      <ReceiptTime key="time" completedAt={row.completedAt} />
    ),
  ].filter((part) => part !== null);

  return (
    <span
      className="inline-flex min-w-0 max-w-full items-baseline gap-1.5 overflow-hidden whitespace-nowrap text-sm leading-5"
      data-timeline-turn-activity=""
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 ? " " : null}
          {part}
        </Fragment>
      ))}
    </span>
  );
}

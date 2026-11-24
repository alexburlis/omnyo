import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import { TimelineReasoningDetail } from "./TimelineReasoningDetail.js";
import { TimelineTitleView } from "./TimelineTitleView.js";
import {
  TIMELINE_INDICATOR_ROW_CLASS,
  TimelineWorkingDot,
  TimelineWorkingStatus,
} from "./TimelineStatusIndicator.js";
import { useSecondTick } from "@/hooks/useSecondTick";
import type { TimelineTitle } from "@omnyo/thread-view";

interface TimelineWorkingIndicatorProps {
  label?: string;
  isThinking?: boolean;
  details?: string;
  reasoningId?: string;
  startedAt?: number;
  statusInComposer?: boolean;
}

export function TimelineWorkingIndicator({
  label,
  isThinking = false,
  details,
  reasoningId,
  startedAt,
  statusInComposer = false,
}: TimelineWorkingIndicatorProps) {
  const now = useSecondTick();
  const resolvedLabel = label ?? (isThinking ? "Thinking…" : "Working...");

  const elapsed =
    startedAt === undefined
      ? null
      : Math.max(0, Math.floor((now - startedAt) / 1000));

  const displayLabel =
    elapsed === null
      ? resolvedLabel
      : `${resolvedLabel} · ${elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}`;

  const hasDetails = (details?.trim().length ?? 0) > 0;

  if (statusInComposer && !hasDetails) return null;

  if (isThinking || hasDetails) {
    const title: TimelineTitle = {
      segments: [
        { text: displayLabel, em: false, shimmer: true, truncate: true },
      ],
      decorations: [],
      tone: "default",
      action: null,
      plain: displayLabel,
    };

    return (
      <div
        className="mt-2 rounded-lg bg-timeline-accent/10 px-2 py-1"
        role={statusInComposer ? undefined : "status"}
        aria-live={statusInComposer ? undefined : "polite"}
      >
        <ExpandableTimelineRow
          expansionKey={reasoningId}
          expandable={hasDetails}
          autoExpanded={hasDetails}
          headerClassName={TIMELINE_INDICATOR_ROW_CLASS}
          title={title}
          titleContent={
            statusInComposer ? (
              <TimelineTitleView title={title} />
            ) : (
              <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
                <TimelineWorkingDot />
                <TimelineTitleView title={title} />
              </span>
            )
          }
          renderBody={() => <TimelineReasoningDetail text={details ?? ""} />}
        />
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="mt-2 rounded-lg bg-timeline-accent/10 px-2 py-1"
    >
      <TimelineWorkingStatus label={displayLabel} />
    </div>
  );
}

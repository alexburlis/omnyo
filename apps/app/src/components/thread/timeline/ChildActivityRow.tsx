import type { TimelineChildActivityRef } from "@omnyo/server-contract";
import type {
  TimelineActivitySystemRow,
  TimelineTitle,
} from "@omnyo/thread-view";
import type { IconName } from "@omnyo/shared-ui/icon";
import {
  TimelineLedgerStaticRow,
  TimelineRowGlyph,
  timelineRowHorizontalPaddingClassName,
  type TimelineRowGlyphState,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";

type ChildActivityState = TimelineChildActivityRef["state"];

const CHILD_ACTIVITY_GLYPH: Record<
  ChildActivityState,
  { icon: IconName; state: TimelineRowGlyphState }
> = {
  running: { icon: "Spinner", state: "running" },
  finished: { icon: "CircleCheck", state: "idle" },
  failed: { icon: "CircleX", state: "failed" },
  interrupted: { icon: "Pause", state: "idle" },
};

export function ChildActivityRow({
  horizontalPadding,
  onTitleAction,
  row,
  title,
}: {
  horizontalPadding: TimelineRowHorizontalPadding;
  onTitleAction: TimelineTitleActionResolver | undefined;
  row: TimelineActivitySystemRow<TimelineChildActivityRef>;
  title: TimelineTitle;
}) {
  const { state, summary } = row.activityRef;
  const glyph = CHILD_ACTIVITY_GLYPH[state];

  return (
    <div data-child-activity-state={state}>
      <TimelineLedgerStaticRow
        horizontalPadding={horizontalPadding}
        glyph={
          <TimelineRowGlyph
            icon={glyph.icon}
            iconUrl={undefined}
            state={glyph.state}
            style={undefined}
          />
        }
      >
        <TimelineTitleView
          title={title}
          onTitleAction={onTitleAction}
          ledger="row"
        />
      </TimelineLedgerStaticRow>
      {summary === null ? null : (
        <div
          className={timelineRowHorizontalPaddingClassName(horizontalPadding)}
        >
          <p className="line-clamp-2 pb-1 pl-8 text-sm leading-5 text-muted-foreground">
            {summary}
          </p>
        </div>
      )}
    </div>
  );
}

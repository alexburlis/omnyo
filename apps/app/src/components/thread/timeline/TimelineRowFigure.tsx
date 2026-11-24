import { cn } from "@omnyo/shared-ui/lib/utils";
import { useSecondTick } from "@/hooks/useSecondTick";
import {
  formatTimelineFigureDuration,
  formatTimelineLiveDuration,
  type TimelineRowFigureTiming,
} from "./timeline-row-figure";
import { useTimelineStepRail } from "./timeline-step-rail";

const FIGURE_CLASS_NAME =
  "ml-auto min-w-11 shrink-0 pl-3 text-right text-xs tabular-nums whitespace-nowrap";

const INLINE_FIGURE_CLASS_NAME =
  "shrink-0 text-xs tabular-nums whitespace-nowrap before:content-['·_']";

function LiveFigureText({ startedAt }: { startedAt: number }) {
  return <>{formatTimelineLiveDuration(useSecondTick() - startedAt)}</>;
}

export function TimelineRowFigure({
  timing,
}: {
  timing: TimelineRowFigureTiming | null;
}) {
  const inline = useTimelineStepRail()?.role === "work";

  if (timing === null) return null;

  return (
    <>
      {" "}
      <span
        data-timeline-row-figure={timing.kind}
        className={cn(
          inline ? INLINE_FIGURE_CLASS_NAME : FIGURE_CLASS_NAME,
          timing.kind === "live"
            ? "text-subtle-foreground"
            : "text-timeline-figure group-hover/toggle:text-subtle-foreground",
        )}
      >
        {timing.kind === "live" ? (
          <LiveFigureText startedAt={timing.startedAt} />
        ) : (
          formatTimelineFigureDuration(timing.durationMs)
        )}
      </span>
    </>
  );
}

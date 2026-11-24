import { cn } from "@omnyo/shared-ui/lib/utils";
import type { TimelineWorkResult as WorkResult } from "./timeline-work-result";

const TONES: Record<WorkResult["tone"], string> = {
  positive: "text-timeline-meta",
  negative: "text-destructive-text",
  warning: "text-warning-text",
};

export function TimelineWorkResult({ result }: { result: WorkResult }) {
  return (
    <span
      data-timeline-work-result={result.tone}
      className={cn(
        "shrink-0 whitespace-nowrap text-xs tabular-nums",
        TONES[result.tone],
      )}
    >
      {result.label}
    </span>
  );
}

import type { ReactNode } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";

export const TIMELINE_INDICATOR_ROW_CLASS = "min-h-7 items-center";

interface TimelineStatusIndicatorProps {
  label: ReactNode;
  className?: string;
}

export function TimelineStatusIndicator({
  label,
  className,
}: TimelineStatusIndicatorProps) {
  return (
    <div className={cn("px-2 text-sm text-muted-foreground", className)}>
      {label}
    </div>
  );
}

export function TimelineWorkingDot() {
  return (
    <span
      aria-hidden="true"
      className="relative flex size-3.5 shrink-0 items-center justify-center"
    >
      <span className="omnyo-working-ping absolute size-1.5 rounded-full bg-timeline-accent" />
      <span className="omnyo-working-breathe relative size-1.5 rounded-full bg-timeline-accent" />
    </span>
  );
}

export function TimelineWorkingStatus({ label }: { label: string }) {
  return (
    <TimelineStatusIndicator
      label={
        <span className="inline-flex items-center gap-1.5">
          <TimelineWorkingDot />
          <span className="animate-shine">{label}</span>
        </span>
      }
      className={cn("flex", TIMELINE_INDICATOR_ROW_CLASS)}
    />
  );
}

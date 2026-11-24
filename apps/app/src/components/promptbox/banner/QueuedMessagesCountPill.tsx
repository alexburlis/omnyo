import { useState } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";

export function QueuedMessagesCountPill({
  arrivals,
  count,
  prefix = "",
  tone = "neutral",
}: {
  arrivals: number;
  count: number;
  prefix?: string;
  tone?: "neutral" | "failed";
}) {
  const [display, setDisplay] = useState<{
    arrivals: number;
    count: number;
    previousCount: number | null;
  }>({ arrivals, count, previousCount: null });

  if (display.arrivals !== arrivals || display.count !== count) {
    setDisplay({
      arrivals,
      count,
      previousCount:
        display.arrivals !== arrivals && count > display.count
          ? display.count
          : null,
    });
  }

  const bumped = display.arrivals > 0;

  return (
    <span
      key={display.arrivals}
      data-queued-messages-count=""
      data-queued-messages-count-tone={tone}
      className={cn(
        "relative inline-flex h-4 min-w-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-recessed px-1 text-2xs leading-none tabular-nums",
        tone === "failed" ? "text-destructive-text" : "text-subtle-foreground",
        bumped && "omnyo-count-flash",
      )}
    >
      {display.previousCount === null ? null : (
        <span
          aria-hidden
          data-queued-messages-previous-count=""
          className="omnyo-count-roll-out absolute inset-0 flex items-center justify-center"
          onAnimationEnd={() =>
            setDisplay((current) => ({ ...current, previousCount: null }))
          }
        >
          {prefix}
          {display.previousCount}
        </span>
      )}
      <span className={cn(bumped && "omnyo-count-roll-in")}>
        {prefix}
        {count}
      </span>
    </span>
  );
}

import { useState } from "react";
import { cn } from "../../lib/utils";
import { PROGRESS_FILL_TRANSITION } from "./motion";
import { CheckMark } from "./success-check";

export interface StepIndicatorStep {
  id: string;
  label: string;
}

type StepState = "complete" | "current" | "upcoming";

const STEP_STATE_LABEL: Record<StepState, string> = {
  complete: "Completed",
  current: "Current step",
  upcoming: "Not started",
};

const STEP_MARKER_CLASS: Record<StepState, string> = {
  complete: "border-foreground bg-foreground text-background",
  current:
    "border-foreground bg-background text-foreground ring-4 ring-foreground/10",
  upcoming: "border-border bg-background text-subtle-foreground",
};

const STEP_LABEL_CLASS: Record<StepState, string> = {
  complete: "text-muted-foreground",
  current: "font-medium text-foreground",
  upcoming: "text-subtle-foreground",
};

function stepState(index: number, currentIndex: number): StepState {
  if (index < currentIndex) return "complete";

  if (index === currentIndex) return "current";

  return "upcoming";
}

function useLastAdvance(currentIndex: number): number | null {
  const [previous, setPrevious] = useState(currentIndex);
  const [advancedFrom, setAdvancedFrom] = useState<number | null>(null);

  if (previous !== currentIndex) {
    setPrevious(currentIndex);
    setAdvancedFrom(currentIndex > previous ? previous : null);
  }

  return advancedFrom;
}

export function StepIndicator({
  steps,
  currentIndex,
  ariaLabel = "Progress",
  className,
}: {
  steps: readonly StepIndicatorStep[];
  currentIndex: number;
  ariaLabel?: string;
  className?: string;
}) {
  const advancedFrom = useLastAdvance(currentIndex);

  return (
    <div className={cn("@container w-full min-w-0", className)}>
      <ol aria-label={ariaLabel} className="flex w-full min-w-0 items-center">
        {steps.map((step, index) => {
          const state = stepState(index, currentIndex);
          const isLast = index === steps.length - 1;

          const justCompleted =
            advancedFrom !== null &&
            state === "complete" &&
            index >= advancedFrom &&
            index < currentIndex;

          return (
            <li
              key={step.id}
              aria-current={state === "current" ? "step" : undefined}
              className={cn("flex min-w-0 items-center", !isLast && "flex-1")}
            >
              <span className="flex shrink-0 items-center gap-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-6 shrink-0 place-items-center rounded-full border-[1.5px] text-xs font-semibold tabular-nums",
                    STEP_MARKER_CLASS[state],
                  )}
                >
                  {state === "complete" ? (
                    <CheckMark animate={justCompleted} className="size-3.5" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap text-sm",
                    STEP_LABEL_CLASS[state],
                    state !== "current" && "@max-[30rem]:sr-only",
                  )}
                >
                  {step.label}
                  <span className="sr-only">, {STEP_STATE_LABEL[state]}</span>
                </span>
              </span>
              {isLast ? null : (
                <span
                  aria-hidden="true"
                  className="relative mx-3 h-0.5 min-w-4 flex-1 overflow-hidden rounded-full bg-border"
                >
                  <span
                    className={cn(
                      "absolute inset-0 origin-left rounded-full bg-foreground",
                      PROGRESS_FILL_TRANSITION,
                    )}
                    style={{
                      transform: `scaleX(${index < currentIndex ? 1 : 0})`,
                    }}
                  />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

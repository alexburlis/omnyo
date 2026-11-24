import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import {
  MOTION_DURATION_MS,
  STEP_ENTER_CLASS,
  STEP_EXIT_CLASS,
  TRANSITION_FALLBACK_SLACK_MS,
} from "./motion";

export type StepDirection = "forward" | "back";

interface ExitingStep {
  key: string;
  node: ReactNode;
  direction: StepDirection;
}

export function StepTransition({
  stepKey,
  direction = "forward",
  children,
  className,
}: {
  stepKey: string;
  direction?: StepDirection;
  children: ReactNode;
  className?: string;
}) {
  const rendered = useRef<{ key: string; node: ReactNode }>({
    key: stepKey,
    node: children,
  });

  const [shownKey, setShownKey] = useState(stepKey);
  const [entering, setEntering] = useState<StepDirection | null>(null);
  const [exiting, setExiting] = useState<ExitingStep | null>(null);

  if (shownKey !== stepKey) {
    setShownKey(stepKey);
    setEntering(direction);
    setExiting({
      key: rendered.current.key,
      node: rendered.current.node,
      direction,
    });
  }

  useEffect(() => {
    rendered.current = { key: stepKey, node: children };
  });

  useEffect(() => {
    if (exiting === null) return;

    const timer = window.setTimeout(
      () => setExiting(null),
      MOTION_DURATION_MS.fast + TRANSITION_FALLBACK_SLACK_MS,
    );

    return () => window.clearTimeout(timer);
  }, [exiting]);

  return (
    <div className={cn("grid min-w-0", className)}>
      {exiting === null ? null : (
        <div
          key={`exit-${exiting.key}`}
          aria-hidden="true"
          inert
          data-step-direction={exiting.direction}
          className={cn(STEP_EXIT_CLASS, "min-w-0 [grid-area:1/1]")}
        >
          {exiting.node}
        </div>
      )}
      <div
        key={`step-${stepKey}`}
        data-step-direction={entering ?? undefined}
        className={cn(
          entering === null ? undefined : STEP_ENTER_CLASS,
          "min-w-0 [grid-area:1/1]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

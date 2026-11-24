import { useState } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { Card } from "@omnyo/shared-ui/card";
import { StepIndicator } from "@omnyo/shared-ui/step-indicator";
import {
  StepTransition,
  type StepDirection,
} from "@omnyo/shared-ui/step-transition";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "ui/Step Indicator",
};

const STEPS = [
  { id: "import", label: "Import" },
  { id: "brief", label: "Brief" },
  { id: "preview", label: "Preview" },
  { id: "run", label: "Run" },
] as const;

const STEP_BODY = [
  "Choose a workflow and review what it can do.",
  "Tell the workflow about your startup and audience.",
  "Check the first week before anything is scheduled.",
  "Turn on the schedule when the preview looks right.",
] as const;

export function Overview() {
  return (
    <StoryCard>
      {STEPS.map((step, index) => (
        <StoryRow key={step.id} label={`step ${index + 1}`}>
          <StepIndicator steps={STEPS} currentIndex={index} />
        </StoryRow>
      ))}
      <StoryRow label="all done">
        <StepIndicator steps={STEPS} currentIndex={STEPS.length} />
      </StoryRow>
      <StoryRow label="narrow" hint="only the current label stays visible">
        <div className="w-72">
          <StepIndicator steps={STEPS} currentIndex={1} />
        </div>
      </StoryRow>
    </StoryCard>
  );
}

export function Interactive() {
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState<StepDirection>("forward");

  const go = (next: number) => {
    setDirection(next > index ? "forward" : "back");
    setIndex(next);
  };

  const current = STEPS[Math.min(index, STEPS.length - 1)];

  return (
    <div className="m-6 flex max-w-xl flex-col gap-5">
      <StepIndicator steps={STEPS} currentIndex={index} />
      <Card className="overflow-hidden p-5">
        <StepTransition stepKey={String(index)} direction={direction}>
          <div className="flex flex-col gap-1.5">
            <h3 className="text-base font-semibold text-foreground">
              {index >= STEPS.length ? "All set" : current?.label}
            </h3>
            <p className="text-sm text-muted-foreground">
              {index >= STEPS.length
                ? "Every step is complete."
                : STEP_BODY[index]}
            </p>
          </div>
        </StepTransition>
      </Card>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          disabled={index === 0}
          onClick={() => go(index - 1)}
          data-testid="step-back"
        >
          Back
        </Button>
        <Button
          className="ml-auto"
          disabled={index >= STEPS.length}
          onClick={() => go(index + 1)}
          data-testid="step-next"
        >
          {index === STEPS.length - 1 ? "Finish" : "Continue"}
        </Button>
      </div>
    </div>
  );
}

import { useState } from "react";
import type { ThreadTimelineGoal } from "@omnyo/domain";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ResponsiveStage } from "./banner-story-stages";
import { ThreadGoalCard } from "./ThreadGoalCard";

export default {
  title: "promptbox/banner/Goal Card",
};

const activeGoal: ThreadTimelineGoal = {
  sourceSeq: 42,
  updatedAt: Date.now() - 12_000,
  objective:
    "Ship the prompt context banner cleanup: keep active state segments first, compact metadata into icon-only controls, and preserve quick actions for single-segment states.",
  status: "active",
  tokenBudget: 80_000,
  tokensUsed: 27_450,
  timeUsedSeconds: 1_238,
};

const unboundedGoal: ThreadTimelineGoal = {
  ...activeGoal,
  sourceSeq: 43,
  objective:
    "Audit the composer stack and identify the smallest set of follow-up UI fixes needed before merging.",
  tokenBudget: null,
  tokensUsed: 9_820,
  timeUsedSeconds: 412,
};

function ToggleableGoalCard({
  goal,
  initiallyExpanded = false,
}: {
  goal: ThreadTimelineGoal;
  initiallyExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);

  return (
    <ThreadGoalCard
      goal={goal}
      isExpanded={expanded}
      onClearGoal={() => {}}
      onExpandedChange={setExpanded}
    />
  );
}

function FauxTranscript() {
  return (
    <div className="relative h-48 rounded-lg border border-border bg-background p-3">
      <div className="absolute right-3 top-3 z-20">
        <ToggleableGoalCard goal={activeGoal} />
      </div>
      <p className="max-w-[70%] text-sm text-muted-foreground">
        Transcript content keeps its full width and height; the goal floats in
        the upper-right corner.
      </p>
    </div>
  );
}

function OpenGoalStage({ goal }: { goal: ThreadTimelineGoal }) {
  return (
    <div className="flex h-48 w-full max-w-xl justify-end">
      <ToggleableGoalCard goal={goal} initiallyExpanded />
    </div>
  );
}

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="floating pill"
        hint="upper-right of the chat; click to expand, Escape to collapse"
      >
        <ResponsiveStage>
          <FauxTranscript />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="expanded"
        hint="full objective with token budget and elapsed time; the popover grows from the pill"
      >
        <OpenGoalStage goal={activeGoal} />
      </StoryRow>
      <StoryRow
        label="no token budget"
        hint="unbounded goal usage summary; click to expand (open in Expanded Without Budget)"
      >
        <ResponsiveStage>
          <ToggleableGoalCard goal={unboundedGoal} />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

export function ExpandedWithoutBudget() {
  return (
    <StoryCard>
      <StoryRow
        label="no token budget"
        hint="unbounded goal usage summary shows tokens used without a cap"
      >
        <OpenGoalStage goal={unboundedGoal} />
      </StoryRow>
    </StoryCard>
  );
}

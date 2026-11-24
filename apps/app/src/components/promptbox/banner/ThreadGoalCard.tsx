import { useState } from "react";
import type { ThreadTimelineGoal } from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { useClearThreadGoal } from "@/hooks/mutations/thread-runtime-mutations";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Progress } from "@omnyo/shared-ui/progress";
import { StatusBadge } from "@omnyo/shared-ui/status-row";

function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    const rest = Math.round(seconds % 60);

    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;

  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }

  const minutes = Math.floor(seconds / 60);

  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
}

function formatTokenUsage(goal: ThreadTimelineGoal): string {
  const used = goal.tokensUsed.toLocaleString();

  if (goal.tokenBudget === null) {
    return `${used} tokens used`;
  }

  return `${used} of ${goal.tokenBudget.toLocaleString()} tokens used`;
}

function budgetPercent(used: number, budget: number): number {
  if (budget <= 0) return 100;

  return Math.min(100, Math.round((used / budget) * 100));
}

export function FloatingThreadGoal({
  goal,
  threadId,
}: {
  goal: ThreadTimelineGoal | null;
  threadId: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const clearThreadGoal = useClearThreadGoal();

  if (!goal || goal.status !== "active") {
    return null;
  }

  return (
    <div className="absolute right-3 top-2" data-thread-goal-overlay="">
      <ThreadGoalCard
        goal={goal}
        isClearPending={clearThreadGoal.isPending}
        isExpanded={isExpanded}
        onClearGoal={() => clearThreadGoal.mutate(threadId)}
        onExpandedChange={setIsExpanded}
      />
    </div>
  );
}

interface ThreadGoalCardProps {
  className?: string;
  goal: ThreadTimelineGoal | null;
  isClearPending?: boolean;
  isExpanded: boolean;
  onClearGoal?: () => void;
  onExpandedChange: (expanded: boolean) => void;
}

export function ThreadGoalCard({
  className,
  goal,
  isClearPending = false,
  isExpanded,
  onClearGoal,
  onExpandedChange,
}: ThreadGoalCardProps) {
  if (!goal || goal.status !== "active") {
    return null;
  }

  const objective = goal.objective.trim();

  return (
    <Popover open={isExpanded} onOpenChange={onExpandedChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Goal, ${formatElapsed(goal.timeUsedSeconds)} elapsed`}
          className={cn(
            "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border bg-card/95 px-2.5 text-xs text-foreground shadow-sm hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-sm:h-11 max-sm:px-3",
            CONTROL_PRESS_TRANSITION,
            CONTROL_PRESS_FEEDBACK,
            className,
          )}
        >
          <Icon
            name="Target"
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="font-medium">Goal</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <span className="tabular-nums text-muted-foreground">
            {formatElapsed(goal.timeUsedSeconds)}
          </span>
          <Icon
            name="ChevronDown"
            className={cn(
              "size-3 shrink-0 text-muted-foreground",
              DISCLOSURE_CHEVRON_TRANSITION,
              isExpanded && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        mobileTitle="Goal"
        aria-label="Goal"
        className="w-80 max-w-[calc(100vw-1.5rem)] p-0"
      >
        <div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-state-hover text-foreground">
            <Icon name="Target" className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                Goal
              </span>
              <StatusBadge tone="active">Working on it</StatusBadge>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The agent keeps going until this is done or you clear it.
            </p>
          </div>
        </div>
        <p className="mx-3.5 max-h-36 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-recessed px-3 py-2 text-sm leading-relaxed text-foreground">
          {objective.length > 0 ? objective : "No goal objective."}
        </p>
        <dl className="grid grid-cols-2 gap-3 px-3.5 pb-3 pt-3 text-xs">
          <div className="min-w-0">
            <dt className="text-subtle-foreground">Tokens used</dt>
            <dd className="mt-0.5 truncate font-medium tabular-nums text-foreground">
              {goal.tokensUsed.toLocaleString()}
              {goal.tokenBudget === null ? null : (
                <span className="font-normal text-muted-foreground">
                  {` of ${goal.tokenBudget.toLocaleString()}`}
                </span>
              )}
            </dd>
            {goal.tokenBudget === null ? null : (
              <Progress
                aria-label={formatTokenUsage(goal)}
                className="mt-1.5 h-1"
                value={budgetPercent(goal.tokensUsed, goal.tokenBudget)}
              />
            )}
          </div>
          <div className="min-w-0">
            <dt className="text-subtle-foreground">Time spent</dt>
            <dd className="mt-0.5 font-medium tabular-nums text-foreground">
              {formatDuration(goal.timeUsedSeconds)}
            </dd>
          </div>
        </dl>
        {onClearGoal ? (
          <div className="flex justify-end border-t border-border-hairline px-3.5 py-2.5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2.5 max-sm:h-11"
              disabled={isClearPending}
              onClick={onClearGoal}
            >
              {isClearPending ? "Clearing goal…" : "Clear goal"}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

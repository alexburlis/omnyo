import { useId } from "react";
import type { TimelineWorkflowWorkRow } from "@omnyo/server-contract";
import { AnimatedDisclosureBody } from "@/components/promptbox/banner/AnimatedBody";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import { LiveDurationText } from "@/components/thread/timeline/LiveDurationText";
import { WorkflowWorkRowBody } from "@/components/thread/timeline/WorkflowWorkRowBody";
import { activityIconClass } from "@omnyo/shared-ui/activity-row-styles";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackChevron,
  useDisclosureFocusHandoff,
} from "@omnyo/shared-ui/prompt-stack-disclosure";
import { WorkflowRunSummary } from "@omnyo/shared-ui/workflow-progress";

interface ThreadWorkflowCardProps {
  workflow: TimelineWorkflowWorkRow;
  isExpanded: boolean;
  onToggle: () => void;
}

export function ThreadWorkflowSummary({
  workflow,
}: {
  workflow: TimelineWorkflowWorkRow;
}) {
  return (
    <WorkflowRunSummary
      name={workflow.workflowName ?? workflow.description}
      progress={workflow.workflow ?? null}
      elapsed={<LiveDurationText startedAt={workflow.startedAt} />}
      icon={
        <Icon
          name="Workflow"
          className={activityIconClass("active", "size-3.5 shrink-0")}
          aria-hidden="true"
        />
      }
    />
  );
}

export function ThreadWorkflowCard({
  workflow,
  isExpanded,
  onToggle,
}: ThreadWorkflowCardProps) {
  const bodyId = useId();
  const toggleId = useId();
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);

  if (workflow.status !== "pending") {
    return null;
  }

  const name = workflow.workflowName ?? workflow.description;

  return (
    <PromptStackCard
      ariaLabel="Workflow"
      className="overflow-hidden"
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <button
        ref={focus.triggerRef}
        type="button"
        id={toggleId}
        aria-expanded={isExpanded}
        aria-controls={bodyId}
        aria-label={`Workflow: ${name}`}
        onClick={focus.onTriggerClick}
        className={cn(
          PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
          PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
        )}
      >
        <ThreadWorkflowSummary workflow={workflow} />
        <PromptStackChevron isExpanded={isExpanded} />
      </button>
      <AnimatedDisclosureBody
        id={bodyId}
        labelledBy={toggleId}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel={`Collapse workflow ${name}`}
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <WorkflowWorkRowBody row={workflow} size="base" collapsiblePhases />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}

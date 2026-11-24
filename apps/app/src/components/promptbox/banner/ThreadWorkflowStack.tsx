import { useEffect, useId, useState } from "react";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { getDisclosureRevealClass } from "@omnyo/shared-ui/motion";
import type { TimelineWorkflowWorkRow } from "@omnyo/server-contract";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  ThreadWorkflowCard,
  ThreadWorkflowSummary,
} from "@/components/promptbox/banner/ThreadWorkflowCard";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackCollapseRow,
  PromptStackCountSlot,
  PromptStackPeekLayers,
  useDisclosureFocusHandoff,
} from "@omnyo/shared-ui/prompt-stack-disclosure";

interface ThreadWorkflowStackProps {
  workflows: readonly TimelineWorkflowWorkRow[];
  isStackExpanded: boolean;
  onToggleStack: () => void;
  expandedWorkflowIds: ReadonlySet<string>;
  onToggleWorkflow: (workflowId: string) => void;
}

export function ThreadWorkflowStack({
  workflows,
  isStackExpanded,
  onToggleStack,
  expandedWorkflowIds,
  onToggleWorkflow,
}: ThreadWorkflowStackProps) {
  const listId = useId();
  const focus = useDisclosureFocusHandoff(isStackExpanded, onToggleStack);

  const [previousStackExpanded, setPreviousStackExpanded] =
    useState(isStackExpanded);

  const [fanOutPending, setFanOutPending] = useState(false);

  if (isStackExpanded !== previousStackExpanded) {
    setPreviousStackExpanded(isStackExpanded);
    setFanOutPending(isStackExpanded);
  }

  useEffect(() => {
    if (!fanOutPending) return;

    let secondFrame = 0;

    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => setFanOutPending(false));
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [fanOutPending]);

  const running = workflows.filter((workflow) => workflow.status === "pending");
  const front = running[0];

  if (!front) {
    return null;
  }

  const stacked = running.length > 1;

  if (stacked && !isStackExpanded) {
    return (
      <PromptStackPeekLayers hiddenCount={running.length - 1}>
        <PromptStackCard
          ariaLabel="Workflows"
          className="overflow-hidden"
          style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
        >
          <button
            ref={focus.triggerRef}
            type="button"
            aria-expanded="false"
            aria-label={`${running.length} workflows running. Show all`}
            onClick={focus.onTriggerClick}
            className={cn(
              PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
              PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
            )}
          >
            <ThreadWorkflowSummary workflow={front} />
            <PromptStackCountSlot count={running.length - 1} />
          </button>
        </PromptStackCard>
      </PromptStackPeekLayers>
    );
  }

  const renderCard = (workflow: TimelineWorkflowWorkRow) => (
    <ThreadWorkflowCard
      key={workflow.id}
      workflow={workflow}
      isExpanded={expandedWorkflowIds.has(workflow.id)}
      onToggle={() => onToggleWorkflow(workflow.id)}
    />
  );

  if (!stacked) {
    return <div className="flex flex-col gap-1">{renderCard(front)}</div>;
  }

  return (
    <div className="flex flex-col">
      <div id={listId} className="flex flex-col">
        {renderCard(front)}
        <div className={getDisclosureRevealClass(!fanOutPending)}>
          <div className="min-h-0 overflow-hidden">
            <div className="flex flex-col gap-2 pt-2">
              {running.slice(1).map(renderCard)}
            </div>
          </div>
        </div>
      </div>
      <PromptStackCollapseRow
        buttonRef={focus.collapseRef}
        className="mt-1"
        controlsId={listId}
        label={`Collapse ${running.length} workflows`}
        onCollapse={focus.onCollapseClick}
      />
    </div>
  );
}

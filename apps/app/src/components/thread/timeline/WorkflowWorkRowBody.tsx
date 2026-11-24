import type { TimelineViewWorkflowWorkRow } from "@omnyo/thread-view";
import { Icon } from "@omnyo/shared-ui/icon";
import { WorkflowProgress } from "@omnyo/shared-ui/workflow-progress";
import type { DetailScrollSize } from "../../ui/detail-scroll-size.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";

function workflowTerminalState(
  taskStatus: TimelineViewWorkflowWorkRow["taskStatus"],
): "completed" | "cancelled" | undefined {
  switch (taskStatus) {
    case "completed":
      return "completed";
    case "killed":
    case "stopped":
      return "cancelled";
    case "failed":
    case "pending":
    case "running":
    case "paused":
      return undefined;
  }
}

export function WorkflowWorkRowBody({
  row,
  size = "delegation",
  collapsiblePhases = false,
}: {
  row: TimelineViewWorkflowWorkRow;
  size?: DetailScrollSize;
  collapsiblePhases?: boolean;
}) {
  if (!row.workflow) {
    if (!row.summary && !row.error) return null;

    if (row.error && !row.summary) {
      return (
        <div className="flex items-start gap-2 px-2 py-1 text-xs leading-5 text-destructive-text">
          <Icon
            name="AlertCircle"
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span className="min-w-0 [overflow-wrap:anywhere]">{row.error}</span>
        </div>
      );
    }

    return (
      <div className="px-2 py-1 text-xs leading-5 text-muted-foreground">
        {row.summary ?? row.error}
      </div>
    );
  }

  const contentKey = row.workflow.agents
    .map((agent) => `${agent.index}:${agent.state}:${agent.lastProgressAt}`)
    .join("|");

  const workflowError = row.error?.trim() ?? "";

  const errorShownOnAgent = row.workflow.agents.some(
    (agent) => agent.error?.trim() === workflowError,
  );

  return (
    <TimelineDetailScroll
      size={size}
      streaming={collapsiblePhases ? false : row.status === "pending"}
      contentKey={contentKey}
      scrollClassName={collapsiblePhases ? "px-2.5 py-2" : undefined}
    >
      <WorkflowProgress
        progress={row.workflow}
        settled={row.status !== "pending"}
        terminalState={workflowTerminalState(row.taskStatus)}
        error={workflowError === "" || errorShownOnAgent ? null : workflowError}
        collapsiblePhases={collapsiblePhases}
      />
    </TimelineDetailScroll>
  );
}

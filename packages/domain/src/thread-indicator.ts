import type { ThreadWorkSummary } from "./thread-work.js";

export interface ThreadListIndicatorState {
  work: ThreadWorkSummary | null;
  hasUnsubmittedDraft: boolean;
}

export type ThreadListIndicatorKind =
  | "input-welcome"
  | "callback-waiting"
  | "dependency-failed"
  | "unread-error"
  | "waiting-for-input"
  | "working-draft"
  | "workflow"
  | "background-agent"
  | "background-command"
  | "plan-mode"
  | "goal"
  | "runtime"
  | "queued-failed"
  | "queued-waiting"
  | "draft"
  | "unread-success"
  | "ready-to-archive"
  | "external"
  | "open"
  | "none";

const THREAD_LIST_INDICATOR_LABELS: Record<
  Exclude<ThreadListIndicatorKind, "none">,
  string
> = {
  "ready-to-archive": "Ready to archive",
  external: "External",
  open: "Open",
  "input-welcome": "Optional question; the agent can continue",
  "callback-waiting": "Waiting",
  "dependency-failed": "Blocked",
  "unread-error": "Failed",
  "waiting-for-input": "Needs you",
  "working-draft": "Thread working with unsubmitted draft",
  workflow: "Workflow running",
  "background-agent": "Background agent running",
  "background-command": "Background command running",
  "plan-mode": "Plan mode active",
  goal: "Goal active",
  runtime: "Working",
  "queued-failed": "Queued message failed to send",
  "queued-waiting": "Thread has a message waiting to send",
  draft: "Thread has unsubmitted draft",
  "unread-success": "Unread thread succeeded",
};

export function getThreadListIndicatorLabel(
  kind: ThreadListIndicatorKind,
): string | null {
  return kind === "none" ? null : THREAD_LIST_INDICATOR_LABELS[kind];
}

export function hasThreadListWorkingActivity(
  state: ThreadListIndicatorState,
): boolean {
  return (state.work?.activity.length ?? 0) > 0;
}

export function resolveThreadListIndicator(
  state: ThreadListIndicatorState,
): ThreadListIndicatorKind {
  const label = state.work?.primary.label ?? "open";

  switch (label) {
    case "needs-you":
      return "waiting-for-input";
    case "working":
      return state.hasUnsubmittedDraft ? "working-draft" : "runtime";
    case "blocked":
      return "dependency-failed";
    case "failed":
      return "unread-error";
    case "waiting":
      return "callback-waiting";
    case "ready-to-archive":
      return state.hasUnsubmittedDraft ? "draft" : "ready-to-archive";
    case "external":
      return state.hasUnsubmittedDraft ? "draft" : "external";
    case "open":
      return state.hasUnsubmittedDraft ? "draft" : "open";
  }
}

const WORK_LABEL_PRIORITY: Record<
  ThreadWorkSummary["primary"]["label"],
  number
> = {
  "needs-you": 8,
  working: 7,
  failed: 6,
  blocked: 5,
  waiting: 4,
  open: 3,
  external: 2,
  "ready-to-archive": 1,
};

export function strongestThreadWorkSummary(
  summaries: readonly (ThreadWorkSummary | null | undefined)[],
): ThreadWorkSummary | null {
  let strongest: ThreadWorkSummary | null = null;
  let hasUnknownWork = false;

  for (const summary of summaries) {
    if (summary === null || summary === undefined) {
      hasUnknownWork = true;
      continue;
    }

    if (
      strongest === null ||
      WORK_LABEL_PRIORITY[summary.primary.label] >
        WORK_LABEL_PRIORITY[strongest.primary.label]
    )
      strongest = summary;
  }

  return hasUnknownWork && strongest?.primary.label === "ready-to-archive"
    ? null
    : strongest;
}

export const threadIndicators = {
  resolve: resolveThreadListIndicator,
  label: getThreadListIndicatorLabel,
  working: hasThreadListWorkingActivity,
  strongest: strongestThreadWorkSummary,
};

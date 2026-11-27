import type { AttemptStatus, Lifecycle, Phase, StepView } from "./contract.js";

export type DisplayStepStatus =
  | "queued"
  | "retry-wait"
  | "starting"
  | "running"
  | "finishing"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "uncertain";

export function displayStepStatus(
  step: Pick<StepView, "status" | "nextRetryAt">,
): DisplayStepStatus {
  const status: AttemptStatus = step.status;

  switch (status) {
    case "pending":
      return step.nextRetryAt === null ? "queued" : "retry-wait";
    case "dispatching":
      return "starting";
    case "running":
      return "running";
    case "result-ready":
      return "finishing";
    case "cancel-requested":
      return "cancelling";
    case "succeeded":
    case "failed":
    case "timed-out":
    case "cancelled":
    case "uncertain":
      return status;
  }
}

export const ACTIVE_STEP_STATUSES: readonly DisplayStepStatus[] = [
  "queued",
  "retry-wait",
  "starting",
  "running",
  "finishing",
  "cancelling",
  "uncertain",
];

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatRelativeDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));

  if (total < 60) return `${total}s`;

  const minutes = Math.round(total / 60);

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);

  return `${hours}h ${minutes % 60}m`;
}

export function stepStatusText(step: StepView, now: number, frozen: boolean): string {
  const display = displayStepStatus(step);
  const prefix = frozen ? "≥ " : "";

  switch (display) {
    case "queued":
      return step.admissionReason === null ? "Queued" : `Queued · ${step.admissionReason}`;
    case "retry-wait":
      return step.nextRetryAt === null
        ? `Retry ${step.attempt}/${step.maxAttempts}`
        : `Retry ${step.attempt}/${step.maxAttempts} in ${formatRelativeDuration(step.nextRetryAt - now)}`;
    case "starting":
      return "Starting…";
    case "running":
      return step.dispatchedAt === null
        ? "Running"
        : `Running · ${prefix}${formatDuration(now - step.dispatchedAt)} · ${step.attempt}/${step.maxAttempts}`;
    case "finishing":
      return "Result submitted · finishing";
    case "cancelling":
      return "Cancelling…";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "timed-out":
      return "Timed out";
    case "cancelled":
      return "Cancelled";
    case "uncertain":
      return "Outcome unknown";
  }
}

export interface LifecyclePresentation {
  label: string;
  tone: "success" | "warning" | "muted" | "danger" | "attention";
}

export function lifecyclePresentation(
  lifecycle: Lifecycle,
  hasUnknownOutcome: boolean,
): LifecyclePresentation {
  switch (lifecycle) {
    case "running":
      return { label: "Running", tone: "success" };
    case "paused":
      return { label: "Paused", tone: "warning" };
    case "stopping":
      return { label: "Stopping…", tone: "warning" };
    case "stopped":
      return hasUnknownOutcome
        ? { label: "Stopped · outcome unknown", tone: "attention" }
        : { label: "Stopped", tone: "muted" };
    case "completed":
      return { label: "Completed", tone: "muted" };
    case "failed":
      return { label: "Failed", tone: "danger" };
  }
}

export function statusSummary(stateTitle: string, summary: string): string | null {
  const text = summary.trim();

  if (text.length === 0 || text === stateTitle.trim()) return null;

  return text;
}

export function phaseText(phase: Phase | null): string {
  switch (phase) {
    case null:
      return "";
    case "waiting":
      return "Waiting";
    case "queued":
      return "Queued";
    case "executing":
      return "Running";
    case "retry-wait":
      return "Waiting to retry";
    case "needs-person":
      return "Needs you";
    case "uncertain":
      return "Outcome unknown";
  }
}

export const LIFECYCLE_URGENCY: Record<Lifecycle, number> = {
  failed: 3,
  stopping: 4,
  running: 5,
  paused: 6,
  stopped: 7,
  completed: 8,
};

export function phaseUrgency(phase: Phase | null): number {
  if (phase === "needs-person") return 1;

  if (phase === "uncertain") return 2;

  return 10;
}

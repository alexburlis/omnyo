import type { InstanceView, Lifecycle, Phase, StepView } from "../data/contract.js";
import { displayStepStatus, stepStatusText } from "../data/projection.js";

export type NodeVisual =
  | "idle"
  | "current-waiting"
  | "current-queued"
  | "current-executing"
  | "current-retry"
  | "current-needs-person"
  | "current-uncertain"
  | "final"
  | "failed";

export interface NodeStatus {
  visual: NodeVisual;
  meta: string;
  paused: boolean;
  isCurrent: boolean;
}

export function currentVisual(lifecycle: Lifecycle, phase: Phase | null): NodeVisual {
  if (lifecycle === "failed") return "failed";

  if (lifecycle === "stopped" || lifecycle === "completed") return "final";

  switch (phase) {
    case "needs-person":
      return "current-needs-person";
    case "uncertain":
      return "current-uncertain";
    case "queued":
      return "current-queued";
    case "executing":
      return "current-executing";
    case "retry-wait":
      return "current-retry";
    case "waiting":
    case null:
      return "current-waiting";
  }
}

function currentStep(instance: InstanceView): StepView | undefined {
  return (
    instance.steps.find(
      (step) => step.stateId === instance.stateId && step.entryId === instance.entryId,
    ) ?? instance.steps.find((step) => step.stateId === instance.stateId)
  );
}

export function nodeStatus(
  instance: InstanceView,
  stateId: string,
  now: number,
  frozen: boolean,
): NodeStatus {
  if (stateId !== instance.stateId)
    return { visual: "idle", meta: "", paused: false, isCurrent: false };

  const visual = currentVisual(instance.lifecycle, instance.phase);
  const paused = instance.lifecycle === "paused";
  const step = currentStep(instance);

  return { visual, meta: metaText(instance, visual, step, now, frozen), paused, isCurrent: true };
}

function metaText(
  instance: InstanceView,
  visual: NodeVisual,
  step: StepView | undefined,
  now: number,
  frozen: boolean,
): string {
  switch (visual) {
    case "failed":
      return "Failed";
    case "final":
      return instance.lifecycle === "completed"
        ? "Completed"
        : instance.unknownOutcomes.length > 0
          ? "Stopped here · outcome unknown"
          : "Stopped here";
    case "current-needs-person":
      return step?.status === "result-ready" ? "Result submitted · finishing" : "Needs you";
    case "current-uncertain":
      return "Outcome unknown";
    default:
      break;
  }

  if (step !== undefined) {
    const display = displayStepStatus(step);

    if (
      display !== "succeeded" &&
      display !== "failed" &&
      display !== "cancelled" &&
      display !== "timed-out"
    )
      return stepStatusText(step, now, frozen);
  }

  if (instance.lifecycle === "paused")
    return instance.pendingResultCount > 0
      ? `Paused · ${instance.pendingResultCount} result waiting`
      : "Paused";

  return "Waiting";
}

export function stepIsFinishing(step: StepView): boolean {
  return step.status === "result-ready";
}

import { z } from "zod";
import {
  jsonValueSchema,
  type JsonValue,
  type MachineDefinition,
  type TransitionDefinition,
  type Trigger,
} from "./definition.js";
import { evaluateGuard } from "../definition/guards.js";

export const lifecycleSchema = z.enum([
  "running",
  "paused",
  "stopping",
  "stopped",
  "completed",
  "failed",
]);

export const phaseSchema = z.enum([
  "waiting",
  "queued",
  "executing",
  "retry-wait",
  "needs-person",
  "uncertain",
]);

export const attemptStatusSchema = z.enum([
  "pending",
  "dispatching",
  "running",
  "result-ready",
  "succeeded",
  "failed",
  "timed-out",
  "cancel-requested",
  "cancelled",
  "uncertain",
]);

export type Lifecycle = z.infer<typeof lifecycleSchema>;

export type Phase = z.infer<typeof phaseSchema>;

export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const transitionEventSchema = z.strictObject({
  type: z.string().min(1).max(128),
  payload: jsonValueSchema,
  outcome: z.string().min(1).max(128).optional(),
});

export type TransitionEvent = z.infer<typeof transitionEventSchema>;

export function triggerMatches(trigger: Trigger, event: TransitionEvent): boolean {
  if (trigger.kind === "event") return event.type === trigger.eventType;

  if (trigger.kind === "decision") return event.type === `decision.${trigger.decisionId}`;

  if (trigger.kind === "result")
    return (
      event.type === `result.${trigger.outcome}` ||
      (event.type === "result" && event.outcome === trigger.outcome)
    );

  return event.type === trigger.kind;
}

export function triggerKey(trigger: Trigger): string {
  if (trigger.kind === "event") return `event:${trigger.eventType}`;

  if (trigger.kind === "decision") return `decision:${trigger.decisionId}`;

  if (trigger.kind === "result") return `result:${trigger.outcome}`;

  return trigger.kind;
}

export function selectTransition(
  definition: MachineDefinition,
  stateId: string,
  event: TransitionEvent,
  context: Record<string, JsonValue>,
  result?: JsonValue,
): TransitionDefinition | null {
  const candidates = definition.transitions
    .filter((edge) => edge.from === stateId && triggerMatches(edge.trigger, event))
    .sort((a, b) => a.priority - b.priority);

  return (
    candidates.find((edge) =>
      evaluateGuard(edge.guard, { context, event: event.payload, result }),
    ) ?? null
  );
}

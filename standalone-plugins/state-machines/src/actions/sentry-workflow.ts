import { z } from "zod";
import {
  sentryWorkflowCommandSchema,
  sentryWorkflowEffects,
} from "../contracts/sentry-workflow.js";
import { invocationResultSchema } from "../data/records.js";
import type { ActionInvocation } from "../runtime/adapter.js";

export const sentryWorkflowAuthorizationSchema = z.strictObject({
  allowed: z.boolean(),
  reference: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
});

export const sentryWorkflowObservationSchema = z.strictObject({
  status: z.enum(["running", "quiescent", "not-found", "uncertain"]),
  confirmedLive: z.boolean(),
  threadId: z.string().optional(),
  result: invocationResultSchema.optional(),
  retrySafe: z.boolean().optional(),
  retainedBytes: z.number().nonnegative().optional(),
  waitingForPerson: z.strictObject({ threadId: z.string(), interactionId: z.string() }).optional(),
  reason: z.string().optional(),
});

export const sentryWorkflowLogSchema = z.strictObject({
  text: z.string(),
  nextCursor: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export function sentryWorkflowRequest(invocation: ActionInvocation, argv: readonly string[]) {
  if (argv[0] !== "omnyo" || argv[1] !== "sentry" || argv[2] !== "workflow-step") return null;
  const parsed = sentryWorkflowCommandSchema.safeParse(argv);

  if (!parsed.success || invocation.state.kind !== "command")
    throw new Error("SCOPE_MISMATCH: invalid Sentry workflow command");
  const [, , , operation, , runId] = parsed.data;

  if (
    invocation.state.effect !== sentryWorkflowEffects[operation] ||
    invocation.state.action.shell !== false ||
    invocation.state.action.argv.some((part, index) => index < 5 && !("literal" in part))
  )
    throw new Error("SCOPE_MISMATCH: Sentry workflow effect or command differs");

  return {
    instanceId: invocation.instanceId,
    entryId: invocation.entryId,
    invocationId: invocation.invocationId,
    attemptId: invocation.attemptId,
    generation: invocation.generation,
    specHash: invocation.specHash,
    projectId: invocation.projectId,
    environmentId: invocation.environmentId,
    stateId: invocation.state.id,
    operation,
    runId,
    deadlineAt: invocation.deadlineAt,
  };
}

import { z } from "zod";
import {
  jsonObjectSchema,
  jsonValueSchema,
  machineDefinitionSchema,
  stateDefinitionSchema,
} from "../contracts/definition.js";
import { editorDraftSchema } from "../definition/draft.js";
import { lifecycleSchema, phaseSchema, attemptStatusSchema } from "../contracts/events.js";

export const machineSchema = z.strictObject({
  machineId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string(),
  draftRevision: z.int().nonnegative(),
  document: editorDraftSchema,
  publishedVersionId: z.string().nullable(),
  updatedAt: z.number(),
});

export const versionSchema = z.strictObject({
  versionId: z.string(),
  machineId: z.string(),
  number: z.int().positive(),
  semanticHash: z.string(),
  snapshotHash: z.string(),
  note: z.string().default(""),
  document: machineDefinitionSchema,
  createdAt: z.number(),
});

export const instanceSchema = z.strictObject({
  instanceId: z.string(),
  machineId: z.string(),
  versionId: z.string(),
  versionNumber: z.int(),
  projectId: z.string(),
  environmentId: z.string(),
  revision: z.int().nonnegative(),
  controlRevision: z.int().nonnegative(),
  lifecycle: lifecycleSchema,
  phase: phaseSchema.nullable(),
  pauseAfterStep: z.boolean(),
  stateId: z.string(),
  entryId: z.string(),
  context: jsonObjectSchema,
  sequence: z.int().nonnegative(),
  createdAt: z.number(),
  updatedAt: z.number(),
  cyclesCompleted: z.int().nonnegative(),
  lastTransition: z.strictObject({ transitionId: z.string(), at: z.number() }).nullable(),
  starts: z.array(z.number()),
  budget: z.record(z.string(), z.number()),
  quarantine: z.strictObject({ code: z.string(), reference: z.string() }).nullable(),
  homeThreadId: z.string().nullable().default(null),
});

export const entrySchema = z.strictObject({
  entryId: z.string(),
  instanceId: z.string(),
  stateId: z.string(),
  sequence: z.int(),
  enteredAt: z.number(),
  exitedAt: z.number().nullable(),
  attempts: z.int().nonnegative().default(0),
  exitTrigger: z.string().nullable().default(null),
});

export const subscriptionSchema = z.strictObject({
  subscriptionId: z.string(),
  instanceId: z.string(),
  entryId: z.string(),
  eventType: z.string(),
  epoch: z.int().positive(),
  openedAt: z.number(),
  settled: z.int().nonnegative(),
  nextDue: z.number().nullable(),
  everyMs: z.number().nullable(),
  observation: jsonValueSchema.nullable(),
  observationHash: z.string().nullable(),
  observedAt: z.number().nullable(),
  observationCount: z.int().nonnegative(),
  sourceVersion: z.number().nullable(),
  pendingEvent: z
    .strictObject({ type: z.string(), payload: jsonValueSchema, subject: z.string() })
    .nullable()
    .default(null),
});

export const inboxEventSchema = z.strictObject({
  eventId: z.string(),
  instanceId: z.string(),
  entryId: z.string(),
  sequence: z.int(),
  type: z.string(),
  payload: jsonValueSchema,
  outcome: z.string().optional(),
  subject: z.string(),
  receivedAt: z.number(),
  status: z.enum(["pending", "consumed", "ignored"]),
  reason: z.string().nullable(),
  subscriptionId: z.string().nullable(),
  epoch: z.int().nullable(),
});

export const invocationResultSchema = z.strictObject({
  type: z.enum(["succeeded", "failed", "timed-out", "cancelled", "no-result", "result"]),
  outcome: z.string().optional(),
  payload: jsonValueSchema,
});

export const invocationSchema = z.strictObject({
  instanceId: z.string(),
  entryId: z.string(),
  invocationId: z.string(),
  attemptId: z.string(),
  generation: z.int(),
  specHash: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  state: z.union([stateDefinitionSchema.options[2], stateDefinitionSchema.options[3]]),
  context: jsonObjectSchema,
  dispatchedAt: z.number(),
  deadlineAt: z.number(),
  threadId: z.string().nullable(),
  status: attemptStatusSchema,
  owned: z.boolean(),
  retired: z.boolean().default(false),
  retainedBytes: z.number().nonnegative().default(0),
  confirmedLive: z.boolean(),
  attempt: z.int(),
  maxAttempts: z.int(),
  nextRetryAt: z.number().nullable(),
  admissionReason: z.string().nullable(),
  candidate: invocationResultSchema.nullable(),
  receivedAt: z.number().nullable(),
  quiescentAt: z.number().nullable(),
  cancelReason: z.enum(["stop", "cancel", "timeout", "grace"]).nullable(),
  unknownAcknowledged: z.boolean(),
  authority: z.strictObject({ reference: z.string(), scope: z.string() }).nullable(),
  retrySafe: z.boolean(),
  dueAt: z.number(),
  homeThreadId: z.string().nullable().default(null),
});

export const attentionCauseSchema = z.strictObject({
  stateId: z.string(),
  stateTitle: z.string(),
  outcome: z.string(),
  reason: z.string().nullable(),
  invocationId: z.string().nullable(),
  threadId: z.string().nullable(),
  at: z.number(),
});

export const attentionSchema = z.strictObject({
  attentionId: z.string(),
  kind: z.string(),
  instanceId: z.string(),
  entryId: z.string(),
  invocationId: z.string().nullable(),
  revision: z.int(),
  title: z.string(),
  bodyMarkdown: z.string(),
  evidenceSummary: z.string().nullable(),
  interactionId: z.string().nullable().default(null),
  cause: attentionCauseSchema.nullable().default(null),
  createdAt: z.number(),
  resolvedAt: z.number().nullable(),
  decisions: z.array(
    z.strictObject({
      name: z.string(),
      label: z.string(),
      targetStateId: z.string().nullable(),
      evidenceRequired: z.boolean(),
      disabledReason: z.string().nullable(),
    }),
  ),
});

export const valueRowSchema = z.object({ value: z.number() });

export const numberRowSchema = z.object({ number: z.number() });

export const countRowSchema = z.object({ count: z.number() });

export const idRowSchema = z.object({ id: z.string() });

export const sequenceRowSchema = z.object({ sequence: z.number() });

export const environmentRowSchema = z.object({ environment_id: z.string() });

export const receiptSchema = z.object({ payload_hash: z.string(), document: z.string() });

export const historyRowSchema = z.object({
  sequence: z.number(),
  kind: z.string(),
  created_at: z.number(),
  document: z.string(),
});

export const checkpointSchema = z.object({
  through_sequence: z.number(),
  events_pruned: z.number().optional(),
  entries_pruned: z.number().optional(),
});

export type Machine = z.infer<typeof machineSchema>;

export type Version = z.infer<typeof versionSchema>;

export type Instance = z.infer<typeof instanceSchema>;

export type Entry = z.infer<typeof entrySchema>;

export type Subscription = z.infer<typeof subscriptionSchema>;

export type InboxEvent = z.infer<typeof inboxEventSchema>;

export type Invocation = z.infer<typeof invocationSchema>;

export type AttentionItem = z.infer<typeof attentionSchema>;

export type AttentionCause = z.infer<typeof attentionCauseSchema>;

export const draftViewSchema = z.strictObject({
  machineId: z.string(),
  revision: z.int(),
  document: editorDraftSchema,
  updatedAt: z.number(),
});

export const instanceViewSchema = instanceSchema
  .omit({ starts: true, budget: true, sequence: true, context: true, quarantine: true })
  .extend({
    latestVersionNumber: z.int(),
    asOf: z.number(),
    summary: z.string(),
    pendingResultCount: z.int(),
    context: z.array(
      z.strictObject({ path: z.string(), value: jsonValueSchema, display: z.string() }),
    ),
    budgets: z.array(
      z.strictObject({
        label: z.string(),
        used: z.number(),
        limit: z.number(),
        subject: z.string(),
      }),
    ),
    steps: z.array(
      z.strictObject({
        invocationId: z.string(),
        entryId: z.string(),
        attemptId: z.string(),
        generation: z.int().nonnegative(),
        specHash: z.string(),
        stateId: z.string(),
        kind: z.enum(["agent", "command"]),
        status: attemptStatusSchema,
        admissionReason: z.string().nullable(),
        attempt: z.int(),
        maxAttempts: z.int(),
        dispatchedAt: z.number().nullable(),
        deadlineAt: z.number().nullable(),
        nextRetryAt: z.number().nullable(),
        environmentId: z.string(),
        threadId: z.string().nullable(),
        confirmedLive: z.boolean(),
      }),
    ),
    unknownOutcomes: z.array(
      z.strictObject({ invocationId: z.string(), blocksRestartIn: z.string().nullable() }),
    ),
    standingAuthority: z.array(
      z.strictObject({ stateId: z.string(), reference: z.string(), scope: z.string() }),
    ),
    quarantined: z.strictObject({ code: z.string(), reference: z.string() }).nullable(),
  });

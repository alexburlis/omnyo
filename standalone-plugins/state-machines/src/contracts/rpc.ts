import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema, machineDefinitionSchema } from "./definition.js";
import { attemptStatusSchema, lifecycleSchema, phaseSchema } from "./events.js";
import { editorDraftInputSchema, editorDraftSchema } from "../definition/draft.js";

const id = z.string().min(1).max(256);

const revision = z.int().nonnegative();

const timestamp = z.number().nonnegative();

const issueSchema = z.strictObject({ path: z.string(), message: z.string() });

export const errorSchema = z.strictObject({
  code: id,
  message: z.string(),
  issues: z.array(issueSchema).optional(),
});

export function envelope<Schema extends z.ZodType>(value: Schema) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), value }),
    z.strictObject({ ok: z.literal(false), error: errorSchema }),
  ]);
}

const problemSchema = z.strictObject({
  code: id,
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  path: z.string(),
  stateId: z.string().nullable(),
  transitionId: z.string().nullable(),
});

export const changeSummarySchema = z.strictObject({
  states: z.strictObject({
    added: z.array(id),
    removed: z.array(id),
    changed: z.array(z.strictObject({ stateId: id, fields: z.array(z.string()) })),
  }),
  transitions: z.strictObject({ added: z.array(id), removed: z.array(id), changed: z.array(id) }),
});

export const draftViewSchema = z.strictObject({
  machineId: id,
  draftRevision: revision,
  baseVersionNumber: z.int().positive().nullable(),
  document: editorDraftSchema,
  problems: z.array(problemSchema),
  changeSummary: changeSummarySchema,
  updatedAt: timestamp,
});

const instanceSummarySchema = z.strictObject({
  instanceId: id,
  versionId: id,
  versionNumber: z.int().positive(),
  lifecycle: lifecycleSchema,
  phase: phaseSchema.nullable(),
  stateId: id,
  stateTitle: z.string(),
  startedAt: timestamp,
  updatedAt: timestamp,
});

const machineSummarySchema = z.strictObject({
  machineId: id,
  projectId: id,
  name: z.string(),
  description: z.string(),
  latestVersionId: id.nullable(),
  latestVersionNumber: z.int().positive().nullable(),
  draftChangeCount: revision,
  instances: z.array(instanceSummarySchema),
  openAttentionCount: revision,
  updatedAt: timestamp,
});

const versionSummarySchema = z.strictObject({
  versionId: id,
  number: z.int().positive(),
  publishedAt: timestamp,
  note: z.string().max(2000),
  instanceCount: revision,
});

const versionViewSchema = versionSummarySchema.extend({
  machineId: id,
  definition: machineDefinitionSchema,
});

const stepViewSchema = z.strictObject({
  invocationId: id,
  attemptId: id,
  generation: revision,
  specHash: id,
  entryId: id,
  stateId: id,
  kind: z.enum(["agent", "command"]),
  status: attemptStatusSchema,
  admissionReason: z.string().nullable(),
  attempt: z.int().positive(),
  maxAttempts: z.int().positive(),
  dispatchedAt: timestamp.nullable(),
  deadlineAt: timestamp.nullable(),
  nextRetryAt: timestamp.nullable(),
  environmentId: id,
  environmentLabel: z.string(),
  threadId: id.nullable(),
  confirmedLive: z.boolean(),
  markUnknownAllowed: z.boolean(),
});

export const instanceViewSchema = z.strictObject({
  instanceId: id,
  machineId: id,
  machineName: z.string(),
  versionId: id,
  versionNumber: z.int().positive(),
  latestVersionNumber: z.int().positive(),
  revision,
  controlRevision: revision,
  asOf: timestamp,
  lifecycle: lifecycleSchema,
  phase: phaseSchema.nullable(),
  pauseAfterStep: z.boolean(),
  stateId: id,
  entryId: id,
  summary: z.string(),
  pendingResultCount: revision,
  expiredWhilePaused: z.array(z.string()),
  lastTransition: z.strictObject({ transitionId: id, at: timestamp }).nullable(),
  context: z.array(z.strictObject({ path: z.string(), display: z.string(), isHash: z.boolean() })),
  budgets: z.array(
    z.strictObject({
      label: z.string(),
      used: revision,
      limit: z.int().positive(),
      subject: z.string(),
    }),
  ),
  cyclesCompleted: revision,
  steps: z.array(stepViewSchema),
  unknownOutcomes: z.array(
    z.strictObject({ invocationId: id, stateId: id, blocksRestartIn: id.nullable() }),
  ),
  standingAuthority: z.array(
    z.strictObject({ stateId: id, reference: z.string(), scope: z.string() }),
  ),
  quarantined: z.strictObject({ code: id, reference: z.string() }).nullable(),
  homeThreadId: id.nullable(),
  definition: machineDefinitionSchema,
});

export const attentionCauseViewSchema = z.strictObject({
  stateId: id,
  stateTitle: z.string(),
  outcome: z.string(),
  reason: z.string().nullable(),
  invocationId: id.nullable(),
  threadId: id.nullable(),
  at: timestamp,
});

export const startHomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new"), title: z.string().trim().min(1).max(120).optional() }),
  z.strictObject({ kind: z.literal("thread"), threadId: id }),
]);

export const attentionViewSchema = z.strictObject({
  attentionId: id,
  kind: z.enum([
    "gate",
    "uncertain",
    "retries-exhausted",
    "authority-required",
    "instance-failed",
    "non-yielding-cycle",
    "capability-unavailable",
    "agent-input",
  ]),
  machineId: id,
  machineName: z.string(),
  instanceId: id,
  entryId: id,
  stateId: id,
  stateTitle: z.string(),
  invocationId: id.nullable(),
  revision,
  title: z.string(),
  bodyMarkdown: z.string(),
  evidenceSummary: z.string().nullable(),
  cause: attentionCauseViewSchema.nullable(),
  homeThreadId: id.nullable(),
  createdAt: timestamp,
  decisions: z.array(
    z.strictObject({
      name: id,
      label: z.string(),
      targetStateId: id.nullable(),
      targetTitle: z.string().nullable(),
      evidenceRequired: z.boolean(),
      evidencePrompt: z.string(),
      acknowledgement: z.string().nullable(),
      disabledReason: z.string().nullable(),
    }),
  ),
});

export const historyKindSchema = z.enum([
  "transition",
  "event",
  "step",
  "control",
  "decision",
  "problem",
]);

export const historyEntrySchema = z.strictObject({
  seq: revision,
  at: timestamp,
  kind: historyKindSchema,
  actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("system") }),
    z.strictObject({ kind: z.literal("client") }),
    z.strictObject({ kind: z.literal("agent"), threadId: id, title: z.string() }),
  ]),
  text: z.string(),
  stateId: id.nullable(),
  invocationId: id.nullable(),
  disposition: z.string().nullable(),
  coalescedCount: revision,
  detail: z.array(z.strictObject({ label: z.string(), value: z.string() })),
  problem: z.boolean(),
});

const historyPageSchema = z.strictObject({
  entries: z.array(historyEntrySchema),
  nextCursor: revision.nullable(),
});

const stateHistoryPageSchema = z.strictObject({
  visits: z.array(
    z.strictObject({
      entryId: id,
      enteredAt: timestamp,
      exitedAt: timestamp.nullable(),
      exitTrigger: z.string().nullable(),
      attempts: revision,
    }),
  ),
  nextCursor: revision.nullable(),
  retainedSince: timestamp.nullable(),
});

const eventCatalogEntrySchema = z.strictObject({
  eventType: id,
  label: z.string(),
  source: z.string(),
  personOnly: z.boolean(),
  subscriptionId: id.nullable(),
  epoch: z.int().positive().nullable(),
  stateIds: z.array(id),
});

const logPageSchema = z.strictObject({
  text: z.string(),
  nextCursor: revision.nullable(),
  truncated: z.boolean(),
});

export const environmentOptionSchema = z.strictObject({
  environmentId: id,
  label: z.string(),
  hostId: id,
  available: z.boolean(),
  persistent: z.boolean(),
});

export const controlOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pause") }),
  z.strictObject({ kind: z.literal("pause-after-step") }),
  z.strictObject({ kind: z.literal("resume") }),
  z.strictObject({ kind: z.literal("stop") }),
  z.strictObject({ kind: z.literal("cancel-step"), invocationId: id, entryId: id }),
  z.strictObject({
    kind: z.literal("mark-unknown"),
    invocationId: id,
    entryId: id,
    expectedRevision: revision,
    evidence: z.string().min(1).max(4000),
    reason: z.string().min(1).max(4000).optional(),
    acknowledged: z.literal(true),
  }),
]);

export const stateMachinesRpc = defineRpcContract({
  sm_machine_list: {
    input: z.strictObject({ projectId: id.nullable(), limit: z.int().min(1).max(100).optional() }),
    output: envelope(z.array(machineSummarySchema)),
  },
  sm_machine_create: {
    input: z.strictObject({
      projectId: id,
      name: z.string().min(1).max(160),
      description: z.string().max(8192),
      template: z.enum(["blank", "release-loop", "local-check-loop"]),
      environmentId: id.optional(),
      requestId: id,
    }),
    output: envelope(z.strictObject({ machineId: id })),
  },
  sm_machine_draft_get: {
    input: z.strictObject({ machineId: id }),
    output: envelope(draftViewSchema),
  },
  sm_machine_draft_save: {
    input: z.strictObject({
      machineId: id,
      expectedRevision: revision,
      document: editorDraftInputSchema,
      requestId: id,
    }),
    output: envelope(draftViewSchema),
  },
  sm_machine_validate: {
    input: z.strictObject({ machineId: id, revision }),
    output: envelope(
      z.strictObject({
        revision,
        problems: z.array(problemSchema),
        nextVersionNumber: z.int().positive(),
        changeSummary: changeSummarySchema,
      }),
    ),
  },
  sm_machine_publish: {
    input: z.strictObject({
      machineId: id,
      expectedRevision: revision,
      note: z.string().max(2000),
      requestId: id,
    }),
    output: envelope(z.strictObject({ versionId: id, number: z.int().positive() })),
  },
  sm_machine_versions: {
    input: z.strictObject({ machineId: id }),
    output: envelope(z.array(versionSummarySchema)),
  },
  sm_machine_version_get: {
    input: z.strictObject({ machineId: id, versionId: id }),
    output: envelope(versionViewSchema),
  },
  sm_machine_export: {
    input: z.strictObject({ machineId: id, versionId: id.optional() }),
    output: envelope(
      z.strictObject({ definition: z.union([machineDefinitionSchema, editorDraftSchema]) }),
    ),
  },
  sm_instance_list: {
    input: z.strictObject({
      machineId: id.optional(),
      projectId: id.optional(),
      status: lifecycleSchema.optional(),
      cursor: id.optional(),
      limit: z.int().min(1).max(100).optional(),
    }),
    output: envelope(z.array(instanceSummarySchema)),
  },
  sm_instance_start: {
    input: z.strictObject({
      machineId: id,
      versionId: id,
      environmentId: id,
      context: jsonObjectSchema,
      home: startHomeSchema.optional(),
      requestId: id,
    }),
    output: envelope(z.strictObject({ instanceId: id })),
  },
  sm_instance_inspect: {
    input: z.strictObject({ instanceId: id }),
    output: envelope(instanceViewSchema),
  },
  sm_instance_control: {
    input: z.strictObject({
      instanceId: id,
      expectedControlRevision: revision,
      operation: controlOperationSchema,
      requestId: id,
    }),
    output: envelope(instanceViewSchema),
  },
  sm_instance_signal: {
    input: z.strictObject({
      instanceId: id,
      entryId: id,
      subscriptionId: id,
      epoch: z.int().positive(),
      eventType: id,
      payload: jsonValueSchema,
      requestId: id,
      sourceId: id.optional(),
      eventId: id.optional(),
      subject: id.optional(),
    }),
    output: envelope(z.strictObject({ eventId: id })),
  },
  sm_attention_list: {
    input: z.strictObject({ machineId: id.nullable(), instanceId: id.nullable() }),
    output: envelope(z.array(attentionViewSchema)),
  },
  sm_attention_resolve: {
    input: z.strictObject({
      instanceId: id,
      attentionId: id,
      entryId: id,
      expectedRevision: revision,
      decision: id,
      evidence: z.string().max(4000),
      requestId: id,
    }),
    output: envelope(z.strictObject({ resolved: z.literal(true) })),
  },
  sm_history_list: {
    input: z.strictObject({
      instanceId: id,
      before: revision.nullable(),
      after: revision.optional(),
      limit: z.int().min(1).max(100),
      kinds: z.array(historyKindSchema),
    }),
    output: envelope(historyPageSchema),
  },
  sm_state_history: {
    input: z.strictObject({
      instanceId: id,
      stateId: id.nullable().optional(),
      before: revision.nullable(),
      after: revision.optional(),
      limit: z.int().min(1).max(100),
    }),
    output: envelope(stateHistoryPageSchema),
  },
  sm_events_catalog: {
    input: z.strictObject({ instanceId: id }),
    output: envelope(z.array(eventCatalogEntrySchema)),
  },
  sm_log_read: {
    input: z.strictObject({ invocationId: id, cursor: revision, limit: z.int().min(1).max(32768) }),
    output: envelope(logPageSchema),
  },
  sm_environment_list: {
    input: z.strictObject({ projectId: id }),
    output: envelope(z.array(environmentOptionSchema)),
  },
});

export type RpcInstanceView = z.infer<typeof instanceViewSchema>;

export type RpcDraftView = z.infer<typeof draftViewSchema>;

export type RpcAttentionView = z.infer<typeof attentionViewSchema>;

export type RpcHistoryEntry = z.infer<typeof historyEntrySchema>;

export type RpcEnvironment = z.infer<typeof environmentOptionSchema>;

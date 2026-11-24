import { threadWorkSummarySchema } from "@omnyo/domain";
import { z } from "zod";
import {
  activeThinkingSchema,
  claudeProfileSelectionSchema,
  callerExecutionInputSourceSchema,
  completedTurnDisplaySchema,
  environmentSchema,
  hostSchema,
  jsonValueSchema,
  pluginIdSchema,
  pluginMetadataSchema,
  pendingInteractionResolutionSchema,
  pendingInteractionSchema,
  permissionModeInputSchema,
  permissionModeSchema,
  promptInputSchema,
  submissionIdSchema,
  promptTextMentionSchema,
  clientTurnRequestIdSchema,
  queuedMessageWaitHolderSchema,
  queuedMessageWaitingOnSchema,
  queuedMessageWaitReasonSchema,
  reasoningLevelSchema,
  sessionOptionSelectionsSchema,
  sessionOptionValueSchema,
  rawThreadIdSchema,
  serviceTierSchema,
  startedOnBehalfOfSchema,
  threadCreateOriginSchema,
  threadMessageSourceSchema,
  threadOriginKindSchema,
  threadListEntrySchema,
  threadQueuedMessageSchema,
  threadSearchSourceKindSchema,
  threadStatusSchema,
  threadTimelineActivePromptModeSchema,
  threadTimelineGoalSchema,
  threadTimelineModelFallbackSchema,
  threadTimelinePendingTodosSchema,
  threadEventTypeValues,
  threadEventItemStatusSchema,
  threadVisibilitySchema,
  threadWithRuntimeSchema,
} from "@omnyo/domain";
import type { CallerExecutionInputSource } from "@omnyo/domain";
import { THREAD_EVENT_LIST_PAGE_SIZE } from "../common.js";
import { providerCommandSchema } from "./projects.js";
import {
  timelineConversationRowSchema,
  timelineDeltaSchema,
  timelineRowSchema,
  timelineWorkflowWorkRowSchema,
} from "../thread-timeline.js";
import {
  createThreadEnvironmentArgsSchema,
  FILE_LIST_QUERY_MAX_LENGTH,
  isCommaSeparatedIncludeQueryValue,
  pathListIncludeQueryValueSchema,
  threadContextWindowUsageSchema,
  workspaceFileListResponseSchema,
  workspacePathListResponseSchema,
} from "./shared.js";

export const sendMessageModeSchema = z.enum([
  "queue-if-active",
  "steer-if-active",
  "auto",
  "start",
  "steer",
]);

export const executionInputFieldSourceSchema = callerExecutionInputSourceSchema;

export type ExecutionInputFieldSource = CallerExecutionInputSource;

export const createExecutionInputSourcesSchema = z
  .object({
    providerId: executionInputFieldSourceSchema.optional(),
    model: executionInputFieldSourceSchema.optional(),
    serviceTier: executionInputFieldSourceSchema.optional(),
    reasoningLevel: executionInputFieldSourceSchema.optional(),
    permissionMode: executionInputFieldSourceSchema.optional(),
  })
  .strict();

export type CreateExecutionInputSources = z.infer<
  typeof createExecutionInputSourcesSchema
>;

export const existingThreadExecutionInputSourcesSchema = z
  .object({
    model: executionInputFieldSourceSchema.optional(),
    serviceTier: executionInputFieldSourceSchema.optional(),
    reasoningLevel: executionInputFieldSourceSchema.optional(),
    permissionMode: executionInputFieldSourceSchema.optional(),
  })
  .strict();

export type ExistingThreadExecutionInputSources = z.infer<
  typeof existingThreadExecutionInputSourcesSchema
>;

export const createThreadRequestSchema = z
  .object({
    projectId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    claudeProfile: claudeProfileSelectionSchema.optional(),
    origin: threadCreateOriginSchema,
    originPluginId: z.string().min(1).optional(),
    pluginMetadata: pluginMetadataSchema.optional(),
    lifecycleOwnerThreadId: z.string().min(1).optional(),
    visibility: threadVisibilitySchema.optional(),
    title: z.string().min(1).optional(),
    input: z.array(promptInputSchema),
    model: z.string().min(1).optional(),
    serviceTier: serviceTierSchema.optional(),
    reasoningLevel: reasoningLevelSchema.optional(),
    sessionOptions: sessionOptionSelectionsSchema.optional(),
    permissionMode: permissionModeInputSchema.optional(),
    executionInputSources: createExecutionInputSourcesSchema.optional(),
    environment: createThreadEnvironmentArgsSchema,
    parentThreadId: z.string().min(1).optional(),
    sectionId: z.string().min(1).nullable().optional(),
    pinned: z.boolean().optional(),
    sourceThreadId: z.string().min(1).optional(),
    sourceSeqEnd: z.number().int().nonnegative().optional(),
    startedOnBehalfOf: startedOnBehalfOfSchema.nullable().default(null),
    originKind: threadOriginKindSchema.nullable().default(null),

    sendAt: z.number().int().nonnegative().optional(),
    idle: z.literal(true).optional(),
    pluginHome: z.literal(true).optional(),
    quiet: z.literal(true).optional(),
    pluginSubmission: z
      .object({ pluginId: pluginIdSchema, data: jsonValueSchema })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.origin === "plugin" && value.originPluginId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId is required when origin is "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.origin !== "plugin" && value.originPluginId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId requires origin "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.pluginMetadata !== undefined && value.origin !== "plugin") {
      ctx.addIssue({
        code: "custom",
        message: 'pluginMetadata requires origin "plugin"',
        path: ["pluginMetadata"],
      });
    }

    if (
      value.pluginMetadata !== undefined &&
      value.originPluginId !== undefined &&
      !pluginIdSchema.safeParse(value.originPluginId).success
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "pluginMetadata requires originPluginId to be a valid plugin id",
        path: ["originPluginId"],
      });
    }

    if (value.idle === true) {
      for (const [field, present] of [
        ["input", value.input.length > 0],
        ["sendAt", value.sendAt !== undefined],
        ["originKind", value.originKind !== null],
        ["parentThreadId", value.parentThreadId !== undefined],
        ["pluginSubmission", value.pluginSubmission !== undefined],
        ["visibility", value.visibility === "hidden"],
      ] as const) {
        if (present)
          ctx.addIssue({
            code: "custom",
            message: `idle chats cannot set ${field}`,
            path: [field],
          });
      }
    }

    if (value.pluginHome === true && value.origin !== "plugin") {
      ctx.addIssue({
        code: "custom",
        message: 'pluginHome requires origin "plugin"',
        path: ["pluginHome"],
      });
    }

    if (
      value.originKind !== "fork" &&
      value.idle !== true &&
      value.input.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "input must contain at least one entry",
        path: ["input"],
      });
    }

    if (value.originKind !== "fork" && value.sourceSeqEnd !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "sourceSeqEnd requires originKind fork",
        path: ["sourceSeqEnd"],
      });
    }
  });

export type CreateThreadRequest = z.infer<typeof createThreadRequestSchema>;

export const NATIVE_HISTORY_LIMITS = {
  agentTextChars: 64 * 1024,
  commandChars: 16 * 1024,
  commandOutputChars: 16 * 1024,
  diffChars: 64 * 1024,
  toolArgumentsChars: 8 * 1024,
  toolResultChars: 16 * 1024,
  toolErrorChars: 8 * 1024,
  userTextChars: 256 * 1024,
  itemsPerTurn: 400,
  changesPerFileChange: 200,
  turnsPerChat: 5000,
} as const;

export const nativeImportProviderIdSchema = z.enum(["codex", "claude-code"]);

export type NativeImportProviderId = z.infer<
  typeof nativeImportProviderIdSchema
>;

const nativeHistoryItemIdSchema = z.string().min(1).max(200);

export const nativeHistoryItemSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("agentMessage"),
      id: nativeHistoryItemIdSchema,
      text: z.string().max(NATIVE_HISTORY_LIMITS.agentTextChars),
    })
    .strict(),
  z
    .object({
      type: z.literal("commandExecution"),
      id: nativeHistoryItemIdSchema,
      command: z.string().max(NATIVE_HISTORY_LIMITS.commandChars),
      cwd: z.string().max(4096).nullable(),
      output: z.string().max(NATIVE_HISTORY_LIMITS.commandOutputChars),
      exitCode: z.number().int().nullable(),
      durationMs: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("fileChange"),
      id: nativeHistoryItemIdSchema,
      changes: z
        .array(
          z
            .object({
              path: z.string().min(1).max(4096),
              kind: z.enum(["add", "delete", "update"]),
              diff: z.string().max(NATIVE_HISTORY_LIMITS.diffChars).nullable(),
            })
            .strict(),
        )
        .min(1)
        .max(NATIVE_HISTORY_LIMITS.changesPerFileChange),
    })
    .strict(),
  z
    .object({
      type: z.literal("toolCall"),
      id: nativeHistoryItemIdSchema,
      tool: z.string().min(1).max(200),
      server: z.string().max(200).nullable(),
      arguments: z
        .string()
        .max(NATIVE_HISTORY_LIMITS.toolArgumentsChars)
        .nullable(),
      result: z.string().max(NATIVE_HISTORY_LIMITS.toolResultChars).nullable(),
      error: z.string().max(NATIVE_HISTORY_LIMITS.toolErrorChars).nullable(),
    })
    .strict(),
]);

export type NativeHistoryItem = z.infer<typeof nativeHistoryItemSchema>;

export const nativeHistoryTurnSchema = z
  .object({
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    status: z.enum(["completed", "interrupted"]),
    userText: z.string().min(1).max(NATIVE_HISTORY_LIMITS.userTextChars),
    items: z
      .array(nativeHistoryItemSchema)
      .max(NATIVE_HISTORY_LIMITS.itemsPerTurn),
  })
  .strict();

export type NativeHistoryTurn = z.infer<typeof nativeHistoryTurnSchema>;

export const importNativeThreadRequestSchema = z
  .object({
    projectId: z.string().min(1),
    hostId: z.string().min(1),
    providerId: nativeImportProviderIdSchema,
    sourceProviderThreadId: z.string().min(1).max(256),
    sourcePath: z.string().min(1).max(4096),
    cwd: z.string().min(1).max(4096),
    title: z.string().min(1).max(500),
    createdAt: z.number().int().nonnegative(),
    lastMessageAt: z.number().int().nonnegative(),
    turns: z
      .array(nativeHistoryTurnSchema)
      .max(NATIVE_HISTORY_LIMITS.turnsPerChat),
    origin: threadCreateOriginSchema,
    originPluginId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.origin === "plugin" && value.originPluginId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId is required when origin is "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.origin !== "plugin" && value.originPluginId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId requires origin "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.lastMessageAt < value.createdAt) {
      ctx.addIssue({
        code: "custom",
        message: "lastMessageAt must not be earlier than createdAt",
        path: ["lastMessageAt"],
      });
    }
  });

export type ImportNativeThreadRequest = z.infer<
  typeof importNativeThreadRequestSchema
>;

export const nativeSessionClaimViaSchema = z.enum(["import", "identity"]);

export const importNativeThreadImportedResponseSchema = z
  .object({ kind: z.literal("imported"), threadId: z.string().min(1) })
  .strict();

export type ImportNativeThreadImportedResponse = z.infer<
  typeof importNativeThreadImportedResponseSchema
>;

export const importNativeThreadAlreadyClaimedResponseSchema = z
  .object({
    kind: z.literal("already-claimed"),
    threadId: z.string().min(1),
    via: nativeSessionClaimViaSchema,
  })
  .strict();

export type ImportNativeThreadAlreadyClaimedResponse = z.infer<
  typeof importNativeThreadAlreadyClaimedResponseSchema
>;

export const importNativeThreadResponseSchema = z.discriminatedUnion("kind", [
  importNativeThreadImportedResponseSchema,
  importNativeThreadAlreadyClaimedResponseSchema,
]);

export type ImportNativeThreadResponse = z.infer<
  typeof importNativeThreadResponseSchema
>;

export const nativeSessionClaimsQuerySchema = z
  .object({
    hostId: z.string().min(1),
    providerId: nativeImportProviderIdSchema,
  })
  .strict();

export type NativeSessionClaimsQuery = z.infer<
  typeof nativeSessionClaimsQuerySchema
>;

export const nativeSessionClaimsResponseSchema = z
  .object({
    claimed: z.array(
      z
        .object({
          sourceProviderThreadId: z.string().min(1),
          threadId: z.string().min(1),
          via: nativeSessionClaimViaSchema,
        })
        .strict(),
    ),
  })
  .strict();

export type NativeSessionClaimsResponse = z.infer<
  typeof nativeSessionClaimsResponseSchema
>;

const agentOnlyPromptInputSchema = promptInputSchema.and(
  z.object({ visibility: z.literal("agent-only") }),
);

export const forkThreadRequestSchema = z
  .object({
    sourceThreadId: z.string().min(1),
    sourceSeqEnd: z.number().int().nonnegative().optional(),
    input: z.array(promptInputSchema).min(1).optional(),
    agentContextSeed: z.array(agentOnlyPromptInputSchema).min(1).optional(),
    title: z.string().min(1).optional(),
    permissionMode: permissionModeInputSchema.optional(),
    visibility: threadVisibilitySchema.default("visible"),
    environment: createThreadEnvironmentArgsSchema.optional(),
    origin: threadCreateOriginSchema.default("sdk"),
    originPluginId: z.string().min(1).optional(),
    pluginMetadata: pluginMetadataSchema.optional(),
    lifecycleOwnerThreadId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.origin === "plugin" && value.originPluginId === undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId is required when origin is "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.origin !== "plugin" && value.originPluginId !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: 'originPluginId requires origin "plugin"',
        path: ["originPluginId"],
      });
    }

    if (value.pluginMetadata !== undefined && value.origin !== "plugin") {
      ctx.addIssue({
        code: "custom",
        message: 'pluginMetadata requires origin "plugin"',
        path: ["pluginMetadata"],
      });
    }

    if (
      value.pluginMetadata !== undefined &&
      value.originPluginId !== undefined &&
      !pluginIdSchema.safeParse(value.originPluginId).success
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "pluginMetadata requires originPluginId to be a valid plugin id",
        path: ["originPluginId"],
      });
    }
  });

export type ForkThreadRequest = z.infer<typeof forkThreadRequestSchema>;

const sendMessageRequestFieldsSchema = z.object({
  requestId: clientTurnRequestIdSchema.optional(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeInputSchema.optional(),
  executionInputSources: existingThreadExecutionInputSourcesSchema.optional(),
  mode: sendMessageModeSchema,
  senderThreadId: z.string().min(1).optional(),
  messageSource: threadMessageSourceSchema.optional(),
  pluginSubmission: z
    .object({ pluginId: pluginIdSchema, data: jsonValueSchema })
    .optional(),

  sendAt: z.number().int().nonnegative().optional(),

  compactFirst: z.literal(true).optional(),
  sendNow: z.literal(true).optional(),
});

export const sendMessageRequestSchema = sendMessageRequestFieldsSchema;

export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const sendMessageDeliverySchema = z.enum(["sent", "queued"]);

export type SendMessageDelivery = z.infer<typeof sendMessageDeliverySchema>;

export const sendMessageResponseSchema = z.discriminatedUnion("delivery", [
  z.object({ ok: z.literal(true), delivery: z.literal("sent") }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("queued"),
    queuedMessage: threadQueuedMessageSchema,
  }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("stored"),
    late: z.boolean(),
  }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("waiting"),
    waitId: z.string(),
  }),
]);

export type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;

export const editMessageRequestSchema = sendMessageRequestFieldsSchema
  .omit({
    requestId: true,
    mode: true,
    sendAt: true,
    pluginSubmission: true,
    compactFirst: true,
    sendNow: true,
  })
  .extend({
    operationId: z.string().min(1),
    expectedRequestSequence: z.number().int().nonnegative().optional(),
  })
  .strict();

export type EditMessageRequest = z.infer<typeof editMessageRequestSchema>;

export const editMessageResponseSchema = z
  .object({
    ok: z.literal(true),
    operationId: z.string().min(1),
    requestSequence: z.number().int().nonnegative(),
  })
  .strict();

export type EditMessageResponse = z.infer<typeof editMessageResponseSchema>;

export const DEFAULT_TURN_RETRY_REASON = "Retry";

export const threadStartMoveRefusalCodeSchema = z.enum([
  "thread_not_found",
  "not_waiting",
  "no_waiting_start",
  "start_claimed",
  "machine_changed",
  "same_machine",
  "not_movable",
  "local_attachment",
  "pinned",
  "target_unavailable",
  "permission_ceiling",
  "agent_not_ready",
  "model_unavailable",
  "no_checkout",
  "placement_refused",
]);

export type ThreadStartMoveRefusalCode = z.infer<
  typeof threadStartMoveRefusalCodeSchema
>;

export const threadStartMoveInitiatorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person") }).strict(),
  z.object({ kind: z.literal("plugin"), pluginId: z.string().min(1) }).strict(),
]);

export type ThreadStartMoveInitiator = z.infer<
  typeof threadStartMoveInitiatorSchema
>;

export const threadStartMachineRequestSchema = z
  .object({
    hostId: z.string().min(1),
    expectedHostId: z.string().min(1),
    initiator: threadStartMoveInitiatorSchema.default({ kind: "person" }),
    note: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ThreadStartMachineRequest = z.infer<
  typeof threadStartMachineRequestSchema
>;

export type ThreadStartMachineRequestInput = z.input<
  typeof threadStartMachineRequestSchema
>;

export const threadStartMachineResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("moved"),
      threadId: z.string().min(1),
      fromHostId: z.string().min(1),
      toHostId: z.string().min(1),
      environmentProviderId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("refused"),
      code: threadStartMoveRefusalCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
]);

export type ThreadStartMachineResponse = z.infer<
  typeof threadStartMachineResponseSchema
>;

export const threadStartMachinesQuerySchema = z
  .object({ pluginId: z.string().min(1).optional() })
  .strict();

export type ThreadStartMachinesQuery = z.infer<
  typeof threadStartMachinesQuerySchema
>;

export const threadStartMachineOptionSchema = z
  .object({
    hostId: z.string().min(1),
    name: z.string(),
    eligible: z.boolean(),
    environmentProviderId: z.string().min(1).nullable(),
    reason: z.string().min(1).nullable(),
  })
  .strict();

export const threadStartMachinesResponseSchema = z
  .object({
    originHostId: z.string().min(1).nullable(),
    machines: z.array(threadStartMachineOptionSchema),
  })
  .strict();

export type ThreadStartMachinesResponse = z.infer<
  typeof threadStartMachinesResponseSchema
>;

export const retryTurnRequestSchema = z
  .object({
    turnRequestId: clientTurnRequestIdSchema.nullable().default(null),

    sendAt: z.number().int().nonnegative().nullable().default(null),

    reason: queuedMessageWaitReasonSchema.default(DEFAULT_TURN_RETRY_REASON),
    model: z.string().min(1).optional(),
  })
  .strict();

export type RetryTurnRequest = z.infer<typeof retryTurnRequestSchema>;

export const retryTurnResponseSchema = z.discriminatedUnion("delivery", [
  z.object({
    ok: z.literal(true),
    delivery: z.literal("sent"),

    turnRequestId: clientTurnRequestIdSchema,

    attempt: z.number().int().min(2),
  }),
  z.object({
    ok: z.literal(true),
    delivery: z.literal("queued"),
    turnRequestId: clientTurnRequestIdSchema,
    attempt: z.number().int().min(2),

    queuedMessageId: z.string().min(1),
    waitingOn: queuedMessageWaitingOnSchema,
    sendAt: z.number().int().nonnegative().nullable(),
  }),
]);

export type RetryTurnResponse = z.infer<typeof retryTurnResponseSchema>;

export const threadContinueQuerySchema = z
  .object({
    now: z.literal("true").optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export type ThreadContinueQuery = z.infer<typeof threadContinueQuerySchema>;

export const threadContinueStateSchema = z.object({
  threadId: z.string(),
  available: z.boolean(),
  pending: z.boolean(),
  action: z.enum([
    "retry",
    "retry-queued",
    "startup",
    "restore-workspace",
    "continue",
    "unavailable",
    "none",
  ]),
  message: z.string().nullable(),
  retryAt: z.number().nullable().default(null),
  retryAttempt: z.number().nullable().default(null),
  model: z.string().nullable().default(null),
  canRetryNow: z.boolean().default(false),
  cause: z.string().nullable().default(null),
  failureLabel: z.string().nullable().default(null),
  permissionMode: permissionModeSchema.nullable().default(null),
});

export type ThreadContinueState = z.infer<typeof threadContinueStateSchema>;

export const threadContinueResponseSchema = z.object({
  threadId: z.string(),
  outcome: z.enum(["sent", "queued", "pending", "blocked"]),
  queuedMessageId: z.string().nullable(),
  message: z.string().nullable(),
});

export type ThreadContinueResponse = z.infer<
  typeof threadContinueResponseSchema
>;

export const threadContinuationsResponseSchema = z.object({
  threads: z.array(threadContinueStateSchema),
});

export type ThreadContinuationsResponse = z.infer<
  typeof threadContinuationsResponseSchema
>;

export const threadContinueAllResponseSchema = z.object({
  results: z.array(threadContinueResponseSchema),
});

export type ThreadContinueAllResponse = z.infer<
  typeof threadContinueAllResponseSchema
>;

export const sendQueuedMessageModeSchema = z.enum(["auto", "steer"]);

export type SendQueuedMessageMode = z.infer<typeof sendQueuedMessageModeSchema>;

export const createQueuedMessageRequestSchema = z.object({
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeInputSchema.optional(),
  executionInputSources: existingThreadExecutionInputSourcesSchema.optional(),
  senderThreadId: z.string().min(1).optional(),
  messageSource: threadMessageSourceSchema.optional(),
});

export type CreateQueuedMessageRequest = z.infer<
  typeof createQueuedMessageRequestSchema
>;

export const SUBMISSION_CONTRACT_VERSION = 1;

export { submissionIdSchema } from "@omnyo/domain";

export const submissionAttachmentSchema = z
  .object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export type SubmissionAttachment = z.infer<typeof submissionAttachmentSchema>;

export const submissionActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("thread-message"),
      threadId: z.string().min(1),
      message: createQueuedMessageRequestSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("new-thread"),
      thread: createThreadRequestSchema,
    })
    .strict(),
]);

export type SubmissionAction = z.infer<typeof submissionActionSchema>;

export const submitRequestSchema = z
  .object({
    version: z.literal(SUBMISSION_CONTRACT_VERSION),
    submissionId: submissionIdSchema,
    storeId: z.string().min(1),
    action: submissionActionSchema,
    attachments: z.array(submissionAttachmentSchema),
  })
  .strict();

export type SubmitRequest = z.infer<typeof submitRequestSchema>;

export const submissionReceiptSchema = z.object({
  version: z.literal(SUBMISSION_CONTRACT_VERSION),
  submissionId: submissionIdSchema,
  storeId: z.string().min(1),
  action: z.enum(["thread-message", "new-thread"]),
  threadId: z.string().min(1),
  queuedMessageId: z.string().min(1),
  acceptedAt: z.number().int().nonnegative(),
  replayed: z.boolean(),
});

export type SubmissionReceipt = z.infer<typeof submissionReceiptSchema>;

export const submissionContractSchema = z.object({
  version: z.literal(SUBMISSION_CONTRACT_VERSION),
  storeId: z.string().min(1),
});

export type SubmissionContract = z.infer<typeof submissionContractSchema>;

export const updateQueuedMessageRequestSchema = z.object({
  expectedUpdatedAt: z.number().int().nonnegative(),
  input: z.array(promptInputSchema).min(1),
  model: z.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeInputSchema.optional(),
});

export type UpdateQueuedMessageRequest = z.infer<
  typeof updateQueuedMessageRequestSchema
>;

export const queuedMessageEditHoldResponseSchema = z.object({
  leaseMs: z.number().int().positive(),
});

export type QueuedMessageEditHoldResponse = z.infer<
  typeof queuedMessageEditHoldResponseSchema
>;

export const sendQueuedMessageRequestSchema = z.object({
  mode: sendQueuedMessageModeSchema,
  requestId: clientTurnRequestIdSchema.optional(),
});

export type SendQueuedMessageRequest = z.infer<
  typeof sendQueuedMessageRequestSchema
>;

export const reorderQueuedMessageRequestSchema = z.object({
  previousQueuedMessageId: z.string().min(1).nullable(),
  nextQueuedMessageId: z.string().min(1).nullable(),
  groupBoundaryQueuedMessageId: z.string().min(1).optional(),
});

export type ReorderQueuedMessageRequest = z.infer<
  typeof reorderQueuedMessageRequestSchema
>;

export const setQueuedMessageGroupBoundaryRequestSchema = z.object({
  expectedGroupedPrefixQueuedMessageIds: z.array(z.string().min(1)).min(1),
  groupBoundaryQueuedMessageId: z.string().min(1),
});

export type SetQueuedMessageGroupBoundaryRequest = z.infer<
  typeof setQueuedMessageGroupBoundaryRequestSchema
>;

export const sendQueuedMessageResponseSchema = z.discriminatedUnion(
  "delivery",
  [
    ...sendMessageResponseSchema.options,
    z.object({ ok: z.literal(true), delivery: z.literal("already-sent") }),
  ],
);

export type SendQueuedMessageResponse = z.infer<
  typeof sendQueuedMessageResponseSchema
>;

export const threadListResponseSchema = z.array(threadListEntrySchema);

export type ThreadListResponse = z.infer<typeof threadListResponseSchema>;

export const THREAD_MENTION_RESOLVE_MAX_IDS = 32;

export const resolveThreadMentionsRequestSchema = z
  .object({
    threadIds: z.array(rawThreadIdSchema).max(THREAD_MENTION_RESOLVE_MAX_IDS),
  })
  .strict();

export type ResolveThreadMentionsRequest = z.infer<
  typeof resolveThreadMentionsRequestSchema
>;

export const threadMentionResolutionSchema = z
  .object({
    threadId: rawThreadIdSchema,
    projectId: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export const resolveThreadMentionsResponseSchema = z.array(
  threadMentionResolutionSchema,
);

export type ResolveThreadMentionsResponse = z.infer<
  typeof resolveThreadMentionsResponseSchema
>;

export const threadSearchHighlightRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end > range.start, {
    message: "highlight range end must be greater than start",
  });

export const threadSearchMatchSchema = z
  .object({
    sourceKind: threadSearchSourceKindSchema,
    text: z.string(),
    highlightRanges: z.array(threadSearchHighlightRangeSchema),
    sourceSeq: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type ThreadSearchMatch = z.infer<typeof threadSearchMatchSchema>;

export const threadSearchResultSchema = z
  .object({
    thread: threadListEntrySchema,
    matches: z.array(threadSearchMatchSchema),
  })
  .strict();

export const threadSearchResultGroupSchema = z
  .object({
    total: z.number().int().nonnegative(),
    results: z.array(threadSearchResultSchema),
  })
  .strict();

export const threadSearchResponseSchema = z
  .object({
    active: threadSearchResultGroupSchema,
    archived: threadSearchResultGroupSchema,
  })
  .strict();

export type ThreadSearchResponse = z.infer<typeof threadSearchResponseSchema>;

export const threadResponseSchema = threadWithRuntimeSchema.extend({
  serviceTier: serviceTierSchema.optional(),
  work: threadWorkSummarySchema.nullable().default(null),
  activeBackgroundAgentCount: z.number().int().nonnegative(),

  canRestoreEnvironment: z.boolean(),
  canSpawnChild: z.boolean(),

  queuedMessageCount: z.number().int().nonnegative(),
});

export type ThreadResponse = z.infer<typeof threadResponseSchema>;

export type UpdateThreadResponse = ThreadResponse & {
  experimental_titleApplied?: boolean;
};

export const threadIncludeOptionSchema = z.enum([
  "environment",
  "host",
  "experimental_pluginData",
]);

export type ThreadIncludeOption = z.infer<typeof threadIncludeOptionSchema>;

export const threadGetQuerySchema = z.object({
  include: z
    .string()
    .min(1)
    .refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: threadIncludeOptionSchema.options,
          value,
        }),
      { message: "Invalid include" },
    )
    .optional(),
});

export type ThreadGetQuery = z.infer<typeof threadGetQuerySchema>;

export type ThreadPluginMetadataResponse = z.infer<typeof pluginMetadataSchema>;

export const threadPluginMetadataQuerySchema = z
  .object({ pluginId: pluginIdSchema })
  .strict();

export type ThreadPluginMetadataQuery = z.infer<
  typeof threadPluginMetadataQuerySchema
>;

export const PLUGIN_THREAD_METADATA_LIST_MAX_IDS = 200;

export const pluginThreadMetadataListRequestSchema = z
  .object({
    pluginId: pluginIdSchema,
    threadIds: z
      .array(z.string().min(1))
      .min(1)
      .max(PLUGIN_THREAD_METADATA_LIST_MAX_IDS),
  })
  .strict();

export type PluginThreadMetadataListRequest = z.infer<
  typeof pluginThreadMetadataListRequestSchema
>;

export const pluginThreadMetadataListResponseSchema = z
  .object({
    threads: z.array(
      z
        .object({ threadId: z.string(), metadata: pluginMetadataSchema })
        .strict(),
    ),
  })
  .strict();

export type PluginThreadMetadataListResponse = z.infer<
  typeof pluginThreadMetadataListResponseSchema
>;

export const THREAD_ANCESTORS_LIST_MAX_IDS = 200;

export const threadAncestorsListRequestSchema = z
  .object({
    threadIds: z
      .array(z.string().min(1))
      .min(1)
      .max(THREAD_ANCESTORS_LIST_MAX_IDS),
  })
  .strict();

export type ThreadAncestorsListRequest = z.infer<
  typeof threadAncestorsListRequestSchema
>;

export const threadAncestorsListResponseSchema = z
  .object({
    threads: z.array(
      z
        .object({ threadId: z.string(), ancestorIds: z.array(z.string()) })
        .strict(),
    ),
  })
  .strict();

export type ThreadAncestorsListResponse = z.infer<
  typeof threadAncestorsListResponseSchema
>;

export const THREAD_DESCENDANTS_LIST_MAX_IDS = 200;

export const threadDescendantsListRequestSchema = z
  .object({
    threadIds: z
      .array(z.string().min(1))
      .min(1)
      .max(THREAD_DESCENDANTS_LIST_MAX_IDS),
    includeArchived: z.boolean().optional(),
    includeHidden: z.boolean().optional(),
  })
  .strict();

export type ThreadDescendantsListRequest = z.infer<
  typeof threadDescendantsListRequestSchema
>;

export const threadDescendantsListResponseSchema = z
  .object({
    threads: z.array(
      z
        .object({ threadId: z.string(), descendantIds: z.array(z.string()) })
        .strict(),
    ),
  })
  .strict();

export type ThreadDescendantsListResponse = z.infer<
  typeof threadDescendantsListResponseSchema
>;

export const updateThreadPluginMetadataRequestSchema = z
  .object({
    pluginId: pluginIdSchema,
    set: pluginMetadataSchema.optional(),
    remove: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine(({ set, remove }, ctx) => {
    if (remove && new Set(remove).size !== remove.length) {
      ctx.addIssue({
        code: "custom",
        message: "remove contains duplicate keys",
        path: ["remove"],
      });
    }

    if (set && remove?.some((key) => Object.hasOwn(set, key))) {
      ctx.addIssue({
        code: "custom",
        message: "set and remove overlap",
        path: ["remove"],
      });
    }
  });

export type UpdateThreadPluginMetadataRequest = z.infer<
  typeof updateThreadPluginMetadataRequestSchema
>;

export const threadDispatchReadinessInputSchema = z
  .object({
    thread: z.object({ id: rawThreadIdSchema, status: threadStatusSchema }),
    host: z.object({ id: z.string(), name: z.string() }).nullable(),
  })
  .strict();

export type ThreadDispatchReadinessInput = z.infer<
  typeof threadDispatchReadinessInputSchema
>;

export const threadDispatchReadinessSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("proceed") }).strict(),
  z
    .object({
      action: z.literal("wait"),
      reason: queuedMessageWaitReasonSchema,
    })
    .strict(),
]);

export type ThreadDispatchReadiness = z.infer<
  typeof threadDispatchReadinessSchema
>;

export const threadWithIncludesResponseSchema = threadResponseSchema.extend({
  experimental_pluginData: z
    .array(
      z.object({
        pluginId: pluginIdSchema,
        method: z.string(),
        dispatchReadiness: z.literal(true).optional(),
        outcome: z.discriminatedUnion("ok", [
          z.object({ ok: z.literal(true), result: jsonValueSchema }),
          z.object({
            ok: z.literal(false),
            error: z.object({ message: z.string() }),
          }),
        ]),
      }),
    )
    .optional(),
  environment: environmentSchema.nullable().optional(),
  host: hostSchema.nullable().optional(),
  environmentHostName: z.string().nullable().optional(),
});

export type ThreadWithIncludesResponse = z.infer<
  typeof threadWithIncludesResponseSchema
>;

export const threadPendingInteractionsResponseSchema = z.array(
  pendingInteractionSchema,
);

export type ThreadPendingInteractionsResponse = z.infer<
  typeof threadPendingInteractionsResponseSchema
>;

export const resolvePendingInteractionRequestSchema =
  pendingInteractionResolutionSchema;

export type ResolvePendingInteractionRequest = z.infer<
  typeof resolvePendingInteractionRequestSchema
>;

export const respondPluginInteractionRequestSchema = z.object({
  value: jsonValueSchema,
});

export type RespondPluginInteractionRequest = z.infer<
  typeof respondPluginInteractionRequestSchema
>;

export const queuedMessageListQuerySchema = z.object({
  threadId: z.string().min(1).optional(),
  waitHolder: queuedMessageWaitHolderSchema.optional(),
});

export type QueuedMessageListQuery = z.infer<
  typeof queuedMessageListQuerySchema
>;

export const threadQueuedMessageListResponseSchema = z.array(
  threadQueuedMessageSchema,
);

export type ThreadQueuedMessageListResponse = z.infer<
  typeof threadQueuedMessageListResponseSchema
>;

export const threadChildSummaryResponseSchema = z.object({
  nonDeletedChildCount: z.number().int().nonnegative(),
  unarchivedDescendantCount: z.number().int().nonnegative(),
});

export type ThreadChildSummaryResponse = z.infer<
  typeof threadChildSummaryResponseSchema
>;

export const deleteThreadRequestSchema = z.object({
  childThreadsConfirmed: z.boolean(),
});

export type DeleteThreadRequest = z.infer<typeof deleteThreadRequestSchema>;

export const updateThreadRequestSchema = z
  .object({
    title: z.string().min(1).nullable(),
    experimental_titleIfUntitled: z.literal(true),
    sectionId: z.string().min(1).nullable(),
    groupId: z.string().min(1).nullable(),
    parentThreadId: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    reasoningLevel: reasoningLevelSchema.nullable(),
    serviceTier: serviceTierSchema,
    sessionOptions: z.record(
      z.string().min(1),
      sessionOptionValueSchema.nullable(),
    ),
    visibility: threadVisibilitySchema,
    experimental_pluginHome: z.boolean(),
  })
  .partial()
  .refine(
    (value) =>
      value.title !== undefined ||
      value.sectionId !== undefined ||
      value.groupId !== undefined ||
      value.parentThreadId !== undefined ||
      value.model !== undefined ||
      value.reasoningLevel !== undefined ||
      value.serviceTier !== undefined ||
      value.sessionOptions !== undefined ||
      value.visibility !== undefined ||
      value.experimental_pluginHome !== undefined,
    "At least one field must be provided",
  )
  .superRefine((value, context) => {
    if (!value.experimental_titleIfUntitled) return;

    if (!value.title?.trim()) {
      context.addIssue({
        code: "custom",
        path: ["title"],
        message: "A conditional title must be nonempty",
      });
    }

    if (
      Object.keys(value).some(
        (key) => key !== "title" && key !== "experimental_titleIfUntitled",
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["experimental_titleIfUntitled"],
        message: "A conditional title cannot be combined with other changes",
      });
    }
  });

export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

export const reorderPinnedThreadRequestSchema = z.object({
  previousThreadId: z.string().min(1).nullable(),
  nextThreadId: z.string().min(1).nullable(),
});

export type ReorderPinnedThreadRequest = z.infer<
  typeof reorderPinnedThreadRequestSchema
>;

export const reorderShelvedThreadRequestSchema =
  reorderPinnedThreadRequestSchema;

export type ReorderShelvedThreadRequest = ReorderPinnedThreadRequest;

export const panelFileSourceSchema = z.enum(["workspace", "thread-storage"]);

export type PanelFileSource = z.infer<typeof panelFileSourceSchema>;

export const threadOpenSplitSchema = z.enum([
  "right",
  "down",
  "left",
  "top",
  "replace",
]);

export type ThreadOpenSplit = z.infer<typeof threadOpenSplitSchema>;

export const threadOpenFileSchema = z
  .object({
    source: panelFileSourceSchema,
    path: z.string().min(1),
    lineNumber: z.number().int().positive().nullable(),
  })
  .strict();

export type ThreadOpenFile = z.infer<typeof threadOpenFileSchema>;

const threadOpenFileLenientSchema = z.object({
  source: panelFileSourceSchema,
  path: z.string().min(1),
  lineNumber: z.number().int().positive().nullable(),
});

export const threadOpenSignalSchema = z
  .object({
    type: z.literal("thread-open"),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    split: threadOpenSplitSchema,
    file: threadOpenFileSchema.nullable(),
  })
  .strict();

export type ThreadOpenSignal = z.infer<typeof threadOpenSignalSchema>;

export const threadOpenSignalLenientSchema = z.object({
  type: z.literal("thread-open"),
  projectId: z.string(),
  threadId: z.string(),
  split: threadOpenSplitSchema,
  file: threadOpenFileLenientSchema.nullable(),
});

export const threadOpenRequestSchema = z
  .object({
    split: threadOpenSplitSchema.optional(),
    file: threadOpenFileSchema.nullable(),
  })
  .strict();

export type ThreadOpenRequest = z.infer<typeof threadOpenRequestSchema>;

export const threadOpenResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
});

export type ThreadOpenResponse = z.infer<typeof threadOpenResponseSchema>;

export const threadPaneActionSchema = z.enum([
  "maximize",
  "restore",
  "toggle",
  "spotlight",
  "clear-spotlight",
]);

export type ThreadPaneAction = z.infer<typeof threadPaneActionSchema>;

export const threadPaneActionRequestSchema = z
  .object({ action: threadPaneActionSchema })
  .strict();

export type ThreadPaneActionRequest = z.infer<
  typeof threadPaneActionRequestSchema
>;

export const threadPaneActionSignalSchema = z
  .object({
    type: z.literal("thread-pane-action"),
    projectId: z.string().min(1),
    threadId: z.string().min(1),
    action: threadPaneActionSchema,
  })
  .strict();

export type ThreadPaneActionSignal = z.infer<
  typeof threadPaneActionSignalSchema
>;

export const threadPaneActionSignalLenientSchema = z.object({
  type: z.literal("thread-pane-action"),
  projectId: z.string(),
  threadId: z.string(),
  action: threadPaneActionSchema,
});

export const threadPaneActionResponseSchema = z.object({
  delivered: z.number().int().nonnegative(),
});

export type ThreadPaneActionResponse = z.infer<
  typeof threadPaneActionResponseSchema
>;

export const threadArchiveAllResponseSchema = z.object({
  ok: z.literal(true),
  archivedThreadIds: z.array(z.string().min(1)),
});

export type ThreadArchiveAllResponse = z.infer<
  typeof threadArchiveAllResponseSchema
>;

export const THREAD_LIST_MAX_IDS = 200;

export function parseThreadListThreadIds(value: string): string[] {
  return value === "" ? [] : value.split(",");
}

export const threadListQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
  hostId: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).optional(),
  sourceThreadId: z.string().min(1).optional(),
  archived: z.enum(["true", "false"]).optional(),
  shelved: z.enum(["true", "false"]).optional(),
  sectionId: z.string().min(1).optional(),
  unsectioned: z.enum(["true", "false"]).optional(),
  groupId: z.string().min(1).optional(),
  hasParent: z.enum(["true", "false"]).optional(),
  originKind: threadOriginKindSchema.optional(),
  originPluginId: z.string().min(1).optional(),
  includeHidden: z.enum(["true", "false"]).optional(),
  includePluginHome: z.enum(["true", "false"]).optional(),
  threadIds: z
    .string()
    .refine(
      (value) => {
        const ids = parseThreadListThreadIds(value);

        return (
          ids.length <= THREAD_LIST_MAX_IDS && ids.every((id) => id.length > 0)
        );
      },
      {
        message: `threadIds must be at most ${THREAD_LIST_MAX_IDS} comma-separated thread IDs`,
      },
    )
    .optional(),
  limit: z.string().regex(/^\d+$/).optional(),
  offset: z.string().regex(/^\d+$/).optional(),
});

export type ThreadListQuery = z.infer<typeof threadListQuerySchema>;

export const threadCountGroupBySchema = z.enum(["host", "provider", "project"]);

export type ThreadCountGroupBy = z.infer<typeof threadCountGroupBySchema>;

export const THREAD_COUNT_ROOT_PARENT = "none";

export const threadCountQuerySchema = z.object({
  status: threadStatusSchema.optional(),
  hostId: z.string().min(1).optional(),
  providerId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  parentThreadId: z.string().min(1).optional(),
  groupBy: threadCountGroupBySchema.optional(),

  includeArchived: z.enum(["true", "false"]).optional(),

  includeHidden: z.enum(["true", "false"]).optional(),
});

export type ThreadCountQuery = z.infer<typeof threadCountQuerySchema>;

export const threadCountResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  groups: z
    .array(
      z.object({
        key: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

export type ThreadCountResponse = z.infer<typeof threadCountResponseSchema>;

export const threadRunningEntrySchema = z.object({
  id: z.string(),

  hostId: z.string().nullable(),
});

export const threadRunningResponseSchema = z.array(threadRunningEntrySchema);

export type ThreadRunningResponse = z.infer<typeof threadRunningResponseSchema>;

export const threadSearchQuerySchema = z.object({
  query: z.string().trim().min(2),
  limitPerGroup: z.string().regex(/^\d+$/).optional(),
});

export type ThreadSearchQuery = z.infer<typeof threadSearchQuerySchema>;

export const timelinePaginationCursorSchema = z
  .object({
    anchorSeq: z.number().int().nonnegative(),
    anchorId: z.string().min(1),
  })
  .strict();

export type TimelinePaginationCursor = z.infer<
  typeof timelinePaginationCursorSchema
>;

export const timelinePageMetadataSchema = z
  .object({
    kind: z.enum(["latest", "older"]),
    segmentLimit: z.number().int().positive(),
    returnedSegmentCount: z.number().int().nonnegative(),
    hasOlderRows: z.boolean(),
    olderCursor: timelinePaginationCursorSchema.nullable(),
    historySnapshot: z.string().optional(),
    olderRowsSourceSeqEnd: z.number().int().nonnegative().nullable().optional(),
    olderRowUpdates: z.array(timelineRowSchema).optional(),
    contentPage: z
      .object({
        anchorSeq: z.number().int().nonnegative(),
        start: z.number().int().nonnegative(),
        end: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .strict();

export const threadTimelineQuerySchema = z
  .object({
    priority: z.literal("background"),
    includeNestedRows: z.enum(["true", "false"]),
    segmentLimit: z.string().regex(/^\d+$/),
    beforeAnchorSeq: z.string().regex(/^(0|[1-9]\d*)$/),
    beforeAnchorId: z.string().min(1),
    summaryOnly: z.enum(["true", "false"]),
    afterSequence: z.string().regex(/^\d+$/),
    deltaFormat: z.literal("assistant-text-append-v1"),
    afterRevision: z.string().min(1).max(128),
    runtimeIdentity: z.literal("server-v1"),
    afterRuntimeId: z.string().min(1).max(128),
    deferContent: z.enum(["true", "false"]),
  })
  .partial()
  .superRefine((query, context) => {
    if (
      query.afterRevision !== undefined &&
      (query.afterSequence === undefined || query.deltaFormat === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "afterRevision requires afterSequence and deltaFormat",
        path: ["afterRevision"],
      });
    }

    if (
      query.afterRuntimeId !== undefined &&
      (query.runtimeIdentity === undefined || query.afterSequence === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "afterRuntimeId requires runtimeIdentity and afterSequence",
        path: ["afterRuntimeId"],
      });
    }

    const hasBeforeAnchorSeq = query.beforeAnchorSeq !== undefined;
    const hasBeforeAnchorId = query.beforeAnchorId !== undefined;

    if (hasBeforeAnchorSeq === hasBeforeAnchorId) {
      return;
    }

    context.addIssue({
      code: "custom",
      message: "beforeAnchorSeq and beforeAnchorId must be provided together",
      path: hasBeforeAnchorSeq ? ["beforeAnchorId"] : ["beforeAnchorSeq"],
    });
  });

export type ThreadTimelineQuery = z.infer<typeof threadTimelineQuerySchema>;

export const timelineTurnSummaryDetailsQuerySchema = z.object({
  beforeCursor: z.string().min(1).optional(),
  deferContent: z.enum(["true", "false"]).optional(),
  itemId: z.string().min(1).optional(),
  turnId: z.string().min(1),
  sourceSeqStart: z.string().regex(/^\d+$/),
  sourceSeqEnd: z.string().regex(/^\d+$/),
});

export type TimelineTurnSummaryDetailsQuery = z.infer<
  typeof timelineTurnSummaryDetailsQuerySchema
>;

export const threadEventsQuerySchema = z
  .object({
    afterSeq: z.string().regex(/^\d+$/),
    beforeSeq: z.string().regex(/^\d+$/),
    limit: z
      .string()
      .regex(/^\d+$/)
      .refine(
        (value) => Number(value) <= THREAD_EVENT_LIST_PAGE_SIZE,
        `Thread event limit cannot exceed ${THREAD_EVENT_LIST_PAGE_SIZE}`,
      ),
    order: z.enum(["asc", "desc"]),
    types: z.string().refine(
      (value) =>
        isCommaSeparatedIncludeQueryValue({
          allowedValues: threadEventTypeValues,
          value,
        }),
      "Invalid thread event types",
    ),
  })
  .partial();

export type ThreadEventsQuery = z.infer<typeof threadEventsQuerySchema>;

export const threadEventWaitQuerySchema = z.object({
  type: z.string().min(1),
  afterSeq: z.string().regex(/^\d+$/).optional(),
  waitMs: z.string().regex(/^\d+$/).optional(),
});

export type ThreadEventWaitQuery = z.infer<typeof threadEventWaitQuerySchema>;

export const THREAD_MESSAGE_CONTEXT_LIMIT = 20;

const threadMessageContextCountSchema = z
  .string()
  .regex(/^\d+$/)
  .refine(
    (value) => Number(value) <= THREAD_MESSAGE_CONTEXT_LIMIT,
    `Message context cannot exceed ${THREAD_MESSAGE_CONTEXT_LIMIT}`,
  );

export const threadMessageQuerySchema = z
  .object({
    before: threadMessageContextCountSchema,
    after: threadMessageContextCountSchema,
  })
  .partial();

export type ThreadMessageQuery = z.infer<typeof threadMessageQuerySchema>;

export const threadMessageResponseSchema = z.object({
  message: timelineConversationRowSchema,
  before: z.array(timelineConversationRowSchema),
  after: z.array(timelineConversationRowSchema),
});

export type ThreadMessageResponse = z.infer<typeof threadMessageResponseSchema>;

export const threadStorageFilesQuerySchema = z
  .object({
    query: z.string().min(1).max(FILE_LIST_QUERY_MAX_LENGTH),
    limit: z.string().regex(/^\d+$/),
  })
  .partial();

export type ThreadStorageFilesQuery = z.infer<
  typeof threadStorageFilesQuerySchema
>;

export const threadHostFileQuerySchema = z.object({
  thumbnailWidth: z.enum(["160", "320", "640", "960"]).optional(),
});

export type ThreadHostFileQuery = z.infer<typeof threadHostFileQuerySchema>;

export const threadStoragePathsQuerySchema =
  threadStorageFilesQuerySchema.extend({
    includeFiles: pathListIncludeQueryValueSchema,
    includeDirectories: pathListIncludeQueryValueSchema,
  });

export type ThreadStoragePathsQuery = z.infer<
  typeof threadStoragePathsQuerySchema
>;

export const threadStorageLocationResponseSchema = z
  .object({
    hostId: z.string().min(1),
    storageRootPath: z.string().min(1),
  })
  .strict();

export type ThreadStorageLocationResponse = z.infer<
  typeof threadStorageLocationResponseSchema
>;

export const timelineTurnSummaryDetailsResponseSchema = z.object({
  olderCursor: z.string().nullable().optional(),
  historySnapshot: z.string().optional(),
  rows: z.array(timelineRowSchema),
});

export type TimelineTurnSummaryDetailsResponse = z.infer<
  typeof timelineTurnSummaryDetailsResponseSchema
>;

const threadTimelineSessionOptionBaseShape = {
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().nullable(),
  category: z.string().nullable(),
};

export const threadTimelineSessionOptionSchema = z.discriminatedUnion("type", [
  z.object({
    ...threadTimelineSessionOptionBaseShape,
    type: z.literal("select"),
    value: z.string(),
    pendingValue: z.string().nullable(),
    values: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        description: z.string().nullable(),
        group: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    ...threadTimelineSessionOptionBaseShape,
    type: z.literal("boolean"),
    value: z.boolean(),
    pendingValue: z.boolean().nullable(),
  }),
]);

export type ThreadTimelineSessionOption = z.infer<
  typeof threadTimelineSessionOptionSchema
>;

export const threadTimelineResponseSchema = z.object({
  rows: z.array(timelineRowSchema),
  contextBoundarySeq: z.number().int().nonnegative().nullable(),
  completedTurnDisplay: completedTurnDisplaySchema,
  activePromptMode: threadTimelineActivePromptModeSchema.nullable(),
  activeThinking: activeThinkingSchema.nullable(),
  activeWorkflows: z.array(timelineWorkflowWorkRowSchema),
  activeBackgroundCommands: z.array(timelineWorkflowWorkRowSchema),
  pendingTodos: threadTimelinePendingTodosSchema.nullable(),
  goal: threadTimelineGoalSchema.nullable(),
  providerCommands: z
    .array(providerCommandSchema.omit({ pluginId: true }))
    .nullable(),
  sessionOptions: z.array(threadTimelineSessionOptionSchema).nullable(),
  modelFallback: threadTimelineModelFallbackSchema.nullable(),
  contextWindowUsage: threadContextWindowUsageSchema.optional(),
  timelinePage: timelinePageMetadataSchema,
  maxSeq: z.number().int().nonnegative(),
  revision: z.string().min(1).max(128).optional(),
  runtimeId: z.string().min(1).max(128).optional(),
  delta: timelineDeltaSchema.optional(),
});

export type ThreadTimelineResponse = z.infer<
  typeof threadTimelineResponseSchema
>;

export const threadConversationOutlineAttachmentSummarySchema = z
  .object({
    imageCount: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadConversationOutlineAttachmentSummary = z.infer<
  typeof threadConversationOutlineAttachmentSummarySchema
>;

export const threadConversationOutlineItemSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(["user", "assistant"]),
    preview: z.string(),
    mentions: z.array(promptTextMentionSchema).optional(),
    attachmentSummary:
      threadConversationOutlineAttachmentSummarySchema.nullable(),
  })
  .strict();

export type ThreadConversationOutlineItem = z.infer<
  typeof threadConversationOutlineItemSchema
>;

export const threadConversationQuerySchema = z.object({
  afterSeq: z.string().regex(/^\d+$/).optional(),
  throughSeq: z.string().regex(/^\d+$/).optional(),
  limit: z
    .string()
    .regex(/^\d+$/)
    .refine(
      (value) => Number(value) >= 1 && Number(value) <= 100,
      "Conversation limit must be from 1 to 100",
    )
    .optional(),
});

export type ThreadConversationQuery = z.infer<
  typeof threadConversationQuerySchema
>;

export const threadConversationResponseSchema = z
  .object({
    rows: z.array(
      z
        .object({
          seq: z.number().int().nonnegative(),
          role: z.enum(["user", "assistant"]),
          text: z.string(),
        })
        .strict(),
    ),
    hasMore: z.boolean(),
    nextAfterSeq: z.number().int().nonnegative().nullable(),
    maxSeq: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadConversationResponse = z.infer<
  typeof threadConversationResponseSchema
>;

export const threadConversationOutlineQuerySchema = z
  .object({
    role: z.enum(["user", "assistant"]),
  })
  .partial();

export type ThreadConversationOutlineQuery = z.infer<
  typeof threadConversationOutlineQuerySchema
>;

export const threadConversationOutlineResponseSchema = z
  .object({
    items: z.array(threadConversationOutlineItemSchema),
    maxSeq: z.number().int().nonnegative(),
  })
  .strict();

export type ThreadConversationOutlineResponse = z.infer<
  typeof threadConversationOutlineResponseSchema
>;

export const threadStorageFileListResponseSchema =
  workspaceFileListResponseSchema.extend({
    storageRootPath: z.string(),
  });

export type ThreadStorageFileListResponse = z.infer<
  typeof threadStorageFileListResponseSchema
>;

export const threadStoragePathListResponseSchema =
  workspacePathListResponseSchema.extend({
    storageRootPath: z.string(),
  });

export type ThreadStoragePathListResponse = z.infer<
  typeof threadStoragePathListResponseSchema
>;

export const archiveReadyThreadRequestSchema = z
  .object({ basis: z.string().min(1) })
  .strict();

export type ArchiveReadyThreadRequest = z.infer<
  typeof archiveReadyThreadRequestSchema
>;

export const COMMAND_PROOF_EVENT_WINDOW = 500;

export const commandProofSelectorSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("command"), command: z.string().min(1).max(300) })
    .strict(),
  z
    .object({ kind: z.literal("event"), eventSeq: z.number().int().positive() })
    .strict(),
]);

export const commandProofLookupRequestSchema = z
  .object({
    selectors: z.array(commandProofSelectorSchema).max(10),
  })
  .strict();

export const commandExecutionProofSchema = z.object({
  eventSeq: z.number().int().positive(),
  command: z.string().max(500),
  cwd: z.string().max(1000),
  status: threadEventItemStatusSchema,
  exitCode: z.number().nullable(),
  excerpt: z.string().max(3000),
});

export const commandProofLookupResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("matched"),
    execution: commandExecutionProofSchema,
  }),
  z.object({ status: z.literal("missing") }),
  z.object({ status: z.literal("ambiguous") }),
]);

export const commandProofLookupResponseSchema = z.object({
  threadId: z.string().min(1),
  proofs: z.array(commandProofLookupResultSchema).max(10),
});

export type CommandProofSelector = z.infer<typeof commandProofSelectorSchema>;

export type CommandProofLookupRequest = z.infer<
  typeof commandProofLookupRequestSchema
>;

export type CommandProofLookupResponse = z.infer<
  typeof commandProofLookupResponseSchema
>;

export type CommandProofLookupResult = z.infer<
  typeof commandProofLookupResultSchema
>;

export type CommandExecutionProof = z.infer<typeof commandExecutionProofSchema>;

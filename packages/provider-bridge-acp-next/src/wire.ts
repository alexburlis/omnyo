import { z } from "zod";
import {
  acpContentBlockSchema,
  acpOptionalString,
  acpPermissionToolCallSchema,
  acpToolCallUpdateEventSchema,
} from "@omnyo/provider-bridge-protocol/acp/tool-call-wire";

export {
  ACP_TOOL_CALL_STATUSES,
  ACP_TOOL_KINDS,
  acpToolCallUpdateEventSchema,
  acpToolKindSchema,
  extractAcpContentText,
  type AcpContentBlock,
  type AcpToolCallContent,
  type AcpToolCallStatus,
  type AcpToolCallUpdateEvent,
  type AcpToolKind,
} from "@omnyo/provider-bridge-protocol/acp/tool-call-wire";

export const acpAgentMessageChunkUpdateSchema = z
  .object({
    sessionUpdate: z.literal("agent_message_chunk"),
    content: acpContentBlockSchema,
  })
  .passthrough();

export const acpAgentThoughtChunkUpdateSchema = z
  .object({
    sessionUpdate: z.literal("agent_thought_chunk"),
    content: acpContentBlockSchema,
  })
  .passthrough();

const acpPlanEntryStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
]);

export const acpPlanUpdateSchema = z
  .object({
    sessionUpdate: z.literal("plan"),
    entries: z.array(
      z
        .object({
          content: z.string(),
          status: acpPlanEntryStatusSchema.optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const acpUsageUpdateSchema = z
  .object({
    sessionUpdate: z.literal("usage_update"),
    used: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
  })
  .passthrough();

export type AcpUsageUpdate = z.infer<typeof acpUsageUpdateSchema>;

const acpOtherSessionUpdateSchema = z
  .object({
    sessionUpdate: z.string(),
  })
  .passthrough();

export const acpSessionUpdateSchema = z.union([
  acpAgentMessageChunkUpdateSchema,
  acpAgentThoughtChunkUpdateSchema,
  acpToolCallUpdateEventSchema,
  acpPlanUpdateSchema,
  acpUsageUpdateSchema,
  acpOtherSessionUpdateSchema,
]);

export type AcpSessionUpdate = z.infer<typeof acpSessionUpdateSchema>;

export const acpSessionNotificationParamsSchema = z
  .object({
    sessionId: z.string(),
    update: acpSessionUpdateSchema,
  })
  .passthrough();

const acpConfigOptionSelectOptionSchema = z
  .object({
    value: z.string(),
    name: acpOptionalString,
  })
  .passthrough();

const acpConfigOptionSchema = z
  .object({
    id: z.string(),
    name: acpOptionalString,
    category: acpOptionalString,
    type: z.string(),
    currentValue: acpOptionalString,
    options: z.array(acpConfigOptionSelectOptionSchema).optional(),
  })
  .passthrough();

export type AcpConfigOption = z.infer<typeof acpConfigOptionSchema>;

const acpSessionModelSchema = z
  .object({
    modelId: z.string(),
    name: acpOptionalString,
    description: acpOptionalString,
  })
  .passthrough();

const acpSessionModelsSchema = z
  .object({
    currentModelId: acpOptionalString,
    availableModels: z.array(acpSessionModelSchema).optional(),
  })
  .passthrough();

export type AcpSessionModels = z.infer<typeof acpSessionModelsSchema>;

const acpLooseConfigOptionSchema = z
  .object({
    id: z.string().optional(),
    name: z.unknown().optional(),
    category: acpOptionalString,
    type: z.unknown().optional(),
    currentValue: z.unknown().optional(),
    options: z.unknown().optional(),
  })
  .passthrough();

const acpConfigOptionSelectGroupSchema = z
  .object({
    group: z.string(),
    options: z.array(z.unknown()),
  })
  .passthrough();

function flattenAcpConfigOptionGroups(option: unknown): unknown {
  if (typeof option !== "object" || option === null) {
    return option;
  }

  const { options } = option as { options?: unknown };

  if (!Array.isArray(options)) {
    return option;
  }

  return {
    ...option,
    options: options.flatMap((entry) => {
      const group = acpConfigOptionSelectGroupSchema.safeParse(entry);

      return group.success ? group.data.options : [entry];
    }),
  };
}

function parseAcpConfigOptions(
  options: unknown[] | null | undefined,
  ctx: z.RefinementCtx,
): AcpConfigOption[] | undefined {
  if (options == null) {
    return undefined;
  }

  const parsedOptions: AcpConfigOption[] = [];

  for (const rawOption of options) {
    const option = flattenAcpConfigOptionGroups(rawOption);
    const loose = acpLooseConfigOptionSchema.safeParse(option);

    if (!loose.success) {
      continue;
    }

    const isModelOption =
      loose.data.category === "model" || loose.data.id === "model";

    if (isModelOption) {
      const strict = acpConfigOptionSchema.safeParse(option);

      if (strict.success) {
        parsedOptions.push(strict.data);
        continue;
      }

      ctx.addIssue({
        code: "custom",
        message: `Invalid ACP model config option: ${strict.error.message}`,
      });
      continue;
    }

    if (loose.data.id === undefined) {
      continue;
    }

    parsedOptions.push({
      id: loose.data.id,
      ...(typeof loose.data.name === "string" ? { name: loose.data.name } : {}),
      ...(loose.data.category !== undefined
        ? { category: loose.data.category }
        : {}),
      type: typeof loose.data.type === "string" ? loose.data.type : "",
      ...(typeof loose.data.currentValue === "string"
        ? { currentValue: loose.data.currentValue }
        : {}),
      ...(Array.isArray(loose.data.options)
        ? {
            options: loose.data.options.flatMap((selectOption) => {
              const parsed =
                acpConfigOptionSelectOptionSchema.safeParse(selectOption);

              return parsed.success ? [parsed.data] : [];
            }),
          }
        : {}),
    });
  }

  return parsedOptions;
}

export const acpSessionNewResultSchema = z
  .object({
    sessionId: z.string(),
    models: acpSessionModelsSchema.optional(),
    configOptions: z
      .array(z.unknown())
      .nullable()
      .optional()
      .transform((options, ctx) => parseAcpConfigOptions(options, ctx)),
  })
  .passthrough();

export const acpConfigStateResultSchema = z
  .object({
    models: acpSessionModelsSchema.optional(),
    configOptions: z
      .array(z.unknown())
      .nullable()
      .optional()
      .transform((options, ctx) => parseAcpConfigOptions(options, ctx)),
  })
  .passthrough();

export type AcpConfigStateResult = z.infer<typeof acpConfigStateResultSchema>;

export const acpSessionForkResultSchema = acpConfigStateResultSchema.extend({
  sessionId: z.string(),
});

export const acpStopReasonSchema = z.string();

export type AcpStopReason = z.infer<typeof acpStopReasonSchema>;

export const acpPromptResultSchema = z
  .object({
    stopReason: acpStopReasonSchema,
  })
  .passthrough();

const acpPermissionOptionKindSchema = z.enum([
  "allow_once",
  "allow_always",
  "reject_once",
  "reject_always",
]);

export type AcpPermissionOptionKind = z.infer<
  typeof acpPermissionOptionKindSchema
>;

const acpPermissionOptionSchema = z
  .object({
    optionId: z.string(),
    name: z.string(),
    kind: acpPermissionOptionKindSchema,
  })
  .passthrough();

export type AcpPermissionOption = z.infer<typeof acpPermissionOptionSchema>;

export const acpRequestPermissionParamsSchema = z
  .object({
    sessionId: z.string(),
    toolCall: acpPermissionToolCallSchema.optional(),
    options: z.array(acpPermissionOptionSchema).min(1),
  })
  .passthrough();

export const acpReadTextFileParamsSchema = z
  .object({
    sessionId: z.string(),
    path: z.string(),
    line: z.number().nullable().optional(),
    limit: z.number().nullable().optional(),
  })
  .passthrough();

export const acpWriteTextFileParamsSchema = z
  .object({
    sessionId: z.string(),
    path: z.string(),
    content: z.string(),
  })
  .passthrough();

import { z } from "zod";

const acpTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

const acpOtherContentBlockSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

export const acpContentBlockSchema = z.union([
  acpTextContentBlockSchema,
  acpOtherContentBlockSchema,
]);

export type AcpContentBlock = z.infer<typeof acpContentBlockSchema>;

export function extractAcpContentText(
  content: AcpContentBlock | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }

  const parsed = acpTextContentBlockSchema.safeParse(content);

  return parsed.success ? parsed.data.text : undefined;
}

export const ACP_TOOL_KINDS = [
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other",
] as const;

export const acpToolKindSchema = z.enum(ACP_TOOL_KINDS);

export type AcpToolKind = z.infer<typeof acpToolKindSchema>;

const ACP_TOOL_KIND_SET: ReadonlySet<string> = new Set(ACP_TOOL_KINDS);

export const ACP_TOOL_CALL_STATUSES = [
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
] as const;

const acpToolCallStatusSchema = z.enum(ACP_TOOL_CALL_STATUSES);

export type AcpToolCallStatus = z.infer<typeof acpToolCallStatusSchema>;

const ACP_TOOL_CALL_STATUS_SET: ReadonlySet<string> = new Set(
  ACP_TOOL_CALL_STATUSES,
);

const acpToolCallContentSchema = z.union([
  z
    .object({
      type: z.literal("content"),
      content: acpContentBlockSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal("diff"),
      path: z.string(),
      oldText: z.string().nullable().optional(),
      newText: z.string(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal("terminal"),
      terminalId: z.string(),
    })
    .passthrough(),
]);

export type AcpToolCallContent = z.infer<typeof acpToolCallContentSchema>;

const acpToolCallContentListSchema = z.array(z.unknown()).transform((entries) =>
  entries.flatMap((entry) => {
    const parsed = acpToolCallContentSchema.safeParse(entry);

    return parsed.success ? [parsed.data] : [];
  }),
);

const acpToolCallLocationSchema = z
  .object({
    path: z.string(),
    line: z.number().optional().nullable(),
  })
  .passthrough();

const acpToolCallNameSchema = z
  .union([z.string(), z.null()])
  .transform((value) => value ?? undefined)
  .optional();

const acpToolCallFieldsSchema = z.object({
  toolCallId: z.string(),
  title: z.string().optional(),
  name: acpToolCallNameSchema,
  kind: acpToolKindSchema.optional(),
  rawKind: z.string().optional(),
  status: acpToolCallStatusSchema.optional(),
  content: acpToolCallContentListSchema.optional(),
  locations: z.array(acpToolCallLocationSchema).optional(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
});

function openAcpToolCallEnums(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const fields = value as Record<string, unknown>;
  const { kind, status, ...rest } = fields;
  const next: Record<string, unknown> = rest;

  if (typeof kind === "string") {
    if (ACP_TOOL_KIND_SET.has(kind)) {
      next["kind"] = kind;
    } else {
      next["kind"] = "other";
      next["rawKind"] = kind;
    }
  } else if (kind !== undefined && kind !== null) {
    next["kind"] = kind;
  }

  if (typeof status === "string") {
    next["status"] = ACP_TOOL_CALL_STATUS_SET.has(status) ? status : "pending";
  } else if (status !== undefined && status !== null) {
    next["status"] = status;
  }

  return next;
}

export const acpToolCallUpdateEventSchema = z.preprocess(
  openAcpToolCallEnums,
  acpToolCallFieldsSchema
    .extend({
      sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
    })
    .passthrough(),
);

export type AcpToolCallUpdateEvent = z.infer<
  typeof acpToolCallUpdateEventSchema
>;

export const acpPermissionToolCallSchema = z.preprocess(
  openAcpToolCallEnums,
  acpToolCallFieldsSchema.partial().passthrough(),
);

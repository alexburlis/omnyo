import { z } from "zod";
import { pluginIdSchema } from "./plugin-id.js";
import { clientTurnRequestIdSchema } from "./protocol-ids.js";
import {
  systemMessageKindSchema,
  systemMessageSubjectSchema,
} from "./system-message.js";

export const queuedMessageWaitingOnKindValues = [
  "time",
  "thread-busy",
  "stopping",
  "turn-starting",
  "provisioning",
  "host-offline",
  "host-away",
  "interaction",
  "server-update",
  "plugin",
  "superseded",
] as const;

export const queuedMessageWaitingOnKindSchema = z.enum(
  queuedMessageWaitingOnKindValues,
);

export type QueuedMessageWaitingOnKind = z.infer<
  typeof queuedMessageWaitingOnKindSchema
>;

export const SERVER_UPDATE_WAIT_COPY = {
  status: "Finishing the Omnyo update",
  actor: "Server update",
  queuedDetail: "Sending after the update",
  continuationTitle: "Resume after update",
  continuationDetail: "Omnyo continues this turn when the update finishes",
} as const;

export const queuedMessageWaitHostNameSchema = z.string().min(1).max(200);

export const QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH = 200;

export const queuedMessageWaitReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_WAIT_REASON_MAX_LENGTH);

export const queuedMessageWaitingOnSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time") }),
  z.object({ kind: z.literal("thread-busy") }),
  z.object({ kind: z.literal("stopping") }),
  z.object({ kind: z.literal("turn-starting") }),
  z.object({ kind: z.literal("provisioning") }),
  z.object({
    kind: z.literal("host-offline"),
    hostName: queuedMessageWaitHostNameSchema,
  }),
  z.object({
    kind: z.literal("host-away"),
    hostName: queuedMessageWaitHostNameSchema,
  }),
  z.object({ kind: z.literal("interaction") }),
  z.object({ kind: z.literal("server-update") }),
  z.object({ kind: z.literal("superseded") }),
  z.object({
    kind: z.literal("plugin"),
    pluginId: pluginIdSchema,
    reason: queuedMessageWaitReasonSchema,
  }),
]);

export type QueuedMessageWaitingOn = z.infer<
  typeof queuedMessageWaitingOnSchema
>;

export const QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH = 200;

export const queuedMessageFailureReasonSchema = z
  .string()
  .min(1)
  .max(QUEUED_MESSAGE_FAILURE_REASON_MAX_LENGTH);

export const QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX = "plugin:";

export const queuedMessageWaitHolderSchema = z.templateLiteral([
  QUEUED_MESSAGE_PLUGIN_WAIT_HOLDER_PREFIX,
  pluginIdSchema,
]);

export type QueuedMessageWaitHolder = z.infer<
  typeof queuedMessageWaitHolderSchema
>;

export const queuedMessagePayloadKindValues = [
  "inline",
  "retry",
  "continuation",
] as const;

export const queuedMessagePayloadKindSchema = z.enum(
  queuedMessagePayloadKindValues,
);

export type QueuedMessagePayloadKind = z.infer<
  typeof queuedMessagePayloadKindSchema
>;

export const queuedMessagePayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inline") }),
  z.object({ kind: z.literal("continuation") }),
  z.object({
    kind: z.literal("retry"),

    retryOfTurnRequestId: clientTurnRequestIdSchema,

    attempt: z.number().int().min(2),

    reason: queuedMessageWaitReasonSchema,
  }),
]);

export type QueuedMessagePayload = z.infer<typeof queuedMessagePayloadSchema>;

export const queuedMessageSystemNoticeSchema = z.object({
  kind: systemMessageKindSchema,
  subject: systemMessageSubjectSchema.nullable(),
});

export type QueuedMessageSystemNotice = z.infer<
  typeof queuedMessageSystemNoticeSchema
>;

export const queuedMessageDeliveryModeValues = ["steer", "queue"] as const;

export const queuedMessageDeliveryModeSchema = z.enum(
  queuedMessageDeliveryModeValues,
);

export type QueuedMessageDeliveryMode = z.infer<
  typeof queuedMessageDeliveryModeSchema
>;

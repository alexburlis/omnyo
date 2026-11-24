import { defineRpcContract } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  ownNotificationLevelSchema,
  pushNotificationKindSchema,
  threadNotificationInputsSchema,
  threadNotificationsSchema,
} from "./preferences.js";

export const DEFAULT_EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

export const EXPO_PUSH_TOKEN_MAX_LENGTH = 512;

export const DEVICE_LABEL_MAX_LENGTH = 120;

export const pushPlatformSchema = z.enum(["ios", "android"]);

export const pushSubscriptionSchema = z
  .object({
    id: z.string().min(1),
    expoPushToken: z.string().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
    platform: pushPlatformSchema,
    deviceLabel: z.string().min(1).max(DEVICE_LABEL_MAX_LENGTH),
    createdAt: z.number().int().nonnegative(),
    lastSeenAt: z.number().int().nonnegative(),
  })
  .strict();

export const pushSubscriptionSummarySchema = pushSubscriptionSchema
  .omit({ expoPushToken: true })
  .extend({ tokenSuffix: z.string().min(1).max(6) })
  .strict();

export const addPushSubscriptionInputSchema = z
  .object({
    expoPushToken: z.string().trim().min(1).max(EXPO_PUSH_TOKEN_MAX_LENGTH),
    platform: pushPlatformSchema,
    deviceLabel: z.string().trim().min(1).max(DEVICE_LABEL_MAX_LENGTH),
  })
  .strict();

export const removePushSubscriptionInputSchema = z
  .object({ id: z.string().min(1) })
  .strict();

export const clientChannelSchema = z.enum(["web", "desktop"]);

export const CLIENT_NOTIFICATION_CHANNEL = "omnyo-notification-v1";

export const clientNotificationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    threadId: z.string().nullable(),
    kind: pushNotificationKindSchema.nullable().default(null),
    channels: z.array(clientChannelSchema),
  })
  .strict();

export type ClientNotification = z.infer<typeof clientNotificationSchema>;

export const THREAD_NOTIFICATIONS_CHANNEL = "threadNotifications";

export const THREAD_NOTIFICATIONS_LIST_MAX_IDS = 200;

export const threadNotificationsUpdateSchema = z
  .object({
    threads: z.record(z.string(), threadNotificationInputsSchema),
  })
  .strict();

export type ThreadNotificationsUpdate = z.infer<
  typeof threadNotificationsUpdateSchema
>;

const emptyInputSchema = z.object({}).strict();

export const queuedNotificationInputSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9._:-]+$/u),
    title: z.string().trim().min(1).max(80),
    body: z.string().trim().min(1).max(500),
  })
  .strict();

export const queuedNotificationReceiptSchema = z
  .object({
    id: z.string(),
    status: z.enum(["queued", "dispatched", "expired"]),
    duplicate: z.boolean(),
    durable: z.literal(true),
    acceptedTargetCount: z.number().int().nonnegative(),
  })
  .strict();

export const presenceReportSchema = z
  .object({
    clientId: z.string().min(1).max(128),
    idleSeconds: z.number().int().nonnegative(),
    locked: z.boolean(),
  })
  .strict();

export type PresenceReport = z.infer<typeof presenceReportSchema>;

export const listPushSubscriptionsOutputSchema = z
  .object({ subscriptions: z.array(pushSubscriptionSummarySchema) })
  .strict();

export const pushNotificationsRpcContract = defineRpcContract({
  "notifications.send": {
    input: queuedNotificationInputSchema,
    output: queuedNotificationReceiptSchema,
  },
  "notifications.pending": {
    input: z.object({ channel: clientChannelSchema.optional() }).strict(),
    output: z.object({ messages: z.array(clientNotificationSchema) }).strict(),
  },
  "notifications.ack": {
    input: z
      .object({
        id: queuedNotificationInputSchema.shape.id,
        clientId: z.string().min(1).max(128),
        channel: clientChannelSchema,
      })
      .strict(),
    output: z
      .object({
        ok: z.literal(true),
        acceptedTargetCount: z.number().int().positive(),
      })
      .strict(),
  },
  "notifications.test": {
    input: z.object({ channel: clientChannelSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "presence.report": {
    input: presenceReportSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "pushSubscriptions.list": {
    input: emptyInputSchema,
    output: listPushSubscriptionsOutputSchema,
  },
  "pushSubscriptions.add": {
    input: addPushSubscriptionInputSchema,
    output: z.object({ id: z.string().min(1), created: z.boolean() }).strict(),
  },
  "pushSubscriptions.remove": {
    input: removePushSubscriptionInputSchema,
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "threadNotifications.get": {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: threadNotificationsSchema,
  },
  "threadNotifications.list": {
    input: z
      .object({
        threadIds: z
          .array(z.string().min(1))
          .min(1)
          .max(THREAD_NOTIFICATIONS_LIST_MAX_IDS),
      })
      .strict(),
    output: z
      .object({
        threads: z.record(z.string(), threadNotificationInputsSchema),
      })
      .strict(),
  },
  "threadNotifications.set": {
    input: z
      .object({
        threadId: z.string().min(1),
        level: ownNotificationLevelSchema,
      })
      .strict(),
    output: threadNotificationInputsSchema,
  },
});

export type PushSubscription = z.infer<typeof pushSubscriptionSchema>;

export type PushSubscriptionSummary = z.infer<
  typeof pushSubscriptionSummarySchema
>;

export type AddPushSubscriptionInput = z.infer<
  typeof addPushSubscriptionInputSchema
>;

import { createHash, randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type PluginApi,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  addPushSubscriptionInputSchema,
  CLIENT_NOTIFICATION_CHANNEL,
  clientNotificationSchema,
  THREAD_NOTIFICATIONS_CHANNEL,
  clientChannelSchema,
  DEFAULT_EXPO_PUSH_URL,
  DEVICE_LABEL_MAX_LENGTH,
  EXPO_PUSH_TOKEN_MAX_LENGTH,
  pushNotificationsRpcContract,
  type queuedNotificationInputSchema,
  type ClientNotification,
  type PushSubscriptionSummary,
  type ThreadNotificationsUpdate,
} from "./contract.js";
import {
  createNotificationPreferences,
  describeNotificationSource,
  NOTIFICATION_LEVEL_LABELS,
  notificationLevelSchema,
  ownNotificationLevelSchema,
  type ThreadNotifications,
} from "./preferences.js";
import {
  createPushSender,
  type CreatePushSenderArgs,
  type LastSendOutcome,
} from "./sender.js";
import { createPresence } from "./presence.js";
import { createPushSubscriptionStore } from "./subscriptions.js";

interface PushNotificationsPluginOptions {
  coalesceMs?: number;
  assessmentWaitMs?: number;
  assessmentStartGraceMs?: number;
  assessmentPollMs?: number;
  createId?: () => string;
  fetch?: CreatePushSenderArgs["fetch"];
  now?: () => number;
  presenceIdleMs?: number;
  presenceStaleMs?: number;
  receiptDelayMs?: number;
}

interface StatusView {
  enabled: true;
  subscriptionCount: number;
  mobileEnabled: boolean;
  mobileOnlyWhenAway: boolean;
  desktopPresence: "active" | "away";
  heldMobileCount: number;
  webEnabled: boolean;
  desktopEnabled: boolean;
  defaultLevel: string;
  childLevel: string;
  relayUrl: string;
  lastSendOutcome: LastSendOutcome;
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

function formatSubscriptions(
  subscriptions: readonly PushSubscriptionSummary[],
): string {
  if (subscriptions.length === 0) return "No push devices registered";

  return [
    "ID\tDevice\tPlatform\tLast seen\tToken suffix",
    ...subscriptions.map((subscription) =>
      [
        subscription.id,
        subscription.deviceLabel,
        subscription.platform,
        new Date(subscription.lastSeenAt).toISOString(),
        subscription.tokenSuffix,
      ].join("\t"),
    ),
  ].join("\n");
}

function formatLastOutcome(outcome: LastSendOutcome): string {
  if (outcome.status === "never") return "Never";

  if (outcome.status === "sent") {
    return `Sent ${outcome.sentCount} at ${new Date(outcome.at).toISOString()}`;
  }

  return `Failed at ${new Date(outcome.at).toISOString()}: ${outcome.reason}`;
}

function formatStatus(status: StatusView): string {
  return [
    `Enabled: ${status.enabled}`,
    `Mobile: ${status.mobileEnabled}`,
    `Mobile only when away: ${status.mobileOnlyWhenAway}`,
    `Desktop presence: ${status.desktopPresence}`,
    `Held for phone: ${status.heldMobileCount}`,
    `Web: ${status.webEnabled}`,
    `Desktop: ${status.desktopEnabled}`,
    `Default level: ${status.defaultLevel}`,
    `Child thread level: ${status.childLevel}`,
    `Subscriptions: ${status.subscriptionCount}`,
    `Relay URL: ${status.relayUrl}`,
    `Last send: ${formatLastOutcome(status.lastSendOutcome)}`,
  ].join("\n");
}

function formatThreadNotifications(
  threadId: string,
  row: ThreadNotifications,
): string {
  return `Notifications for ${threadId}: ${row.effective} (${describeNotificationSource(row)})`;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createPushNotificationsPlugin(
  options: PushNotificationsPluginOptions = {},
) {
  return async function pushNotificationsPlugin(api: PluginApi): Promise<void> {
    const settings = api.settings.define({
      mobileEnabled: {
        type: "boolean",
        label: "Mobile notifications",
        description:
          "Send push messages to your registered phones and tablets.",
        default: true,
      },
      mobileOnlyWhenAway: {
        type: "boolean",
        label: "Phone only when away",
        description:
          "While you use a computer running the Omnyo desktop app, notify only there. Anything still unread reaches your phone once that computer locks or sits idle for 2 minutes.",
        default: true,
      },
      webEnabled: {
        type: "boolean",
        label: "Web notifications",
        description:
          "Show system notifications while Omnyo is open in a browser. Each browser needs notification permission.",
        default: true,
      },
      desktopEnabled: {
        type: "boolean",
        label: "Desktop notifications",
        description:
          "Show system notifications while the Omnyo desktop app is running.",
        default: true,
      },
      defaultLevel: {
        type: "select",
        label: "Default notifications",
        description:
          "For threads you haven't set. Needs input only skips finished turns.",
        options: [...notificationLevelSchema.options],
        experimental_optionLabels: {
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "all",
        experimental_schema: notificationLevelSchema,
      },
      childLevel: {
        type: "select",
        label: "Child thread notifications",
        description:
          "For child threads you haven't set. A thread's level also limits its child threads.",
        options: [...ownNotificationLevelSchema.options],
        experimental_optionLabels: {
          inherit: "Same as default",
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "input-only",
        experimental_schema: ownNotificationLevelSchema,
      },
      expoPushUrl: {
        type: "string",
        label: "Expo push relay URL",
        description: "The Expo push relay endpoint used for mobile delivery.",
        default: DEFAULT_EXPO_PUSH_URL,
        experimental_schema: z.string().url(),
      },
    });

    const preferences = createNotificationPreferences({
      api,
      getDefaults: async () => {
        const { defaultLevel, childLevel } = await settings.get();

        return {
          defaultLevel: notificationLevelSchema.parse(defaultLevel),
          childLevel: ownNotificationLevelSchema.parse(childLevel),
        };
      },
      publish: (threads) =>
        api.realtime.publish(THREAD_NOTIFICATIONS_CHANNEL, {
          threads,
        } satisfies ThreadNotificationsUpdate),
    });

    const presence = createPresence({
      now: options.now ?? Date.now,
      ...(options.presenceIdleMs === undefined
        ? {}
        : { idleMs: options.presenceIdleMs }),
      ...(options.presenceStaleMs === undefined
        ? {}
        : { staleMs: options.presenceStaleMs }),
    });

    const subscriptions = createPushSubscriptionStore(api, {
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.createId === undefined ? {} : { createId: options.createId }),
    });

    const sender = createPushSender({
      api,
      subscriptions,
      queueClientNotification: async (message) => {
        await queueNotice(message, true);
      },
      getDeliverySettings: () => settings.get(),
      presence,
      ...(options.presenceStaleMs === undefined
        ? {}
        : { restoredHoldMs: options.presenceStaleMs }),
      getExpoPushUrl: async () => (await settings.get()).expoPushUrl,
      getNotificationLevel: (thread) => preferences.effectiveLevel(thread),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.coalesceMs === undefined
        ? {}
        : { coalesceMs: options.coalesceMs }),
      ...(options.assessmentWaitMs === undefined
        ? {}
        : { assessmentWaitMs: options.assessmentWaitMs }),
      ...(options.assessmentStartGraceMs === undefined
        ? {}
        : { assessmentStartGraceMs: options.assessmentStartGraceMs }),
      ...(options.assessmentPollMs === undefined
        ? {}
        : { assessmentPollMs: options.assessmentPollMs }),
      ...(options.receiptDelayMs === undefined
        ? {}
        : { receiptDelayMs: options.receiptDelayMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    async function status(): Promise<StatusView> {
      const [
        {
          expoPushUrl,
          mobileEnabled,
          mobileOnlyWhenAway,
          webEnabled,
          desktopEnabled,
          defaultLevel,
          childLevel,
        },
        rows,
      ] = await Promise.all([settings.get(), subscriptions.list()]);

      return {
        enabled: true,
        subscriptionCount: rows.length,
        mobileEnabled,
        mobileOnlyWhenAway,
        desktopPresence: presence.activeUntil() === null ? "away" : "active",
        heldMobileCount: sender.getHeldCount(),
        webEnabled,
        desktopEnabled,
        defaultLevel,
        childLevel,
        relayUrl: expoPushUrl,
        lastSendOutcome: sender.getLastOutcome(),
      };
    }

    async function sendTest(channel: "web" | "desktop") {
      const config = await settings.get();

      if (!(channel === "web" ? config.webEnabled : config.desktopEnabled)) {
        throw new Error(`${channel} notifications are disabled`);
      }

      await queueNotice(
        {
          id: randomUUID(),
          title: "Omnyo notifications are working",
          body: "You’ll be notified when a thread needs your attention.",
          threadId: null,
          kind: null,
          channels: [channel],
        },
        true,
      );

      return { ok: true as const };
    }

    const noticePrefix = "queued-notification:";
    const automaticNoticePrefix = "pending-automatic-notification:";

    const noticeSchema = z
      .object({
        message: clientNotificationSchema,
        acceptedTargets: z.array(z.string()),
        queuedAt: z.number().int().nonnegative().optional(),
      })
      .strict();

    const noticeLifetimeMs = 24 * 60 * 60 * 1_000;

    type NoticeRecord = z.infer<typeof noticeSchema>;

    function noticeExpired(record: NoticeRecord) {
      return (
        record.queuedAt === undefined ||
        Date.now() - record.queuedAt >= noticeLifetimeMs
      );
    }

    const automaticReceiptPrefix = "automatic-notification-receipt:";
    const explicitReceiptPrefix = "explicit-notification-receipt:";
    const receiptLifetimeMs = 2 * noticeLifetimeMs;
    const drainBatchSize = 100;

    const automaticReceiptSchema = z
      .object({
        acceptedTargets: z.array(z.string()),
        queuedAt: z.number().int().nonnegative().optional(),
      })
      .strict();

    const explicitReceiptSchema = z
      .object({
        acceptedTargets: z.array(z.string()),
        queuedAt: z.number().int().nonnegative(),
        digest: z.string(),
      })
      .strict();

    function noticeDigest(message: ClientNotification) {
      return createHash("sha256")
        .update(
          JSON.stringify([
            message.title,
            message.body,
            message.threadId,
            message.channels,
          ]),
        )
        .digest("hex");
    }

    let noticeMutations: Promise<void> = Promise.resolve();
    let pendingNoticeIndex: Map<string, NoticeRecord> | undefined;

    function mutateNotice<T>(operation: () => Promise<T>): Promise<T> {
      const result = noticeMutations.then(operation, operation);
      noticeMutations = result.then(
        () => undefined,
        () => {
          pendingNoticeIndex = undefined;
        },
      );

      return result;
    }

    function noticeAccepted(record: NoticeRecord, channel?: "web" | "desktop") {
      return channel === undefined
        ? record.acceptedTargets.length > 0
        : record.acceptedTargets.some((target) =>
            target.startsWith(`${channel}:`),
          );
    }

    function noticeSettled(record: NoticeRecord) {
      return (
        noticeExpired(record) ||
        record.message.channels.every((channel) =>
          noticeAccepted(record, channel),
        )
      );
    }

    function updatePendingNotice(
      key: string,
      record: NoticeRecord,
      index = pendingNoticeIndex,
    ) {
      if (index === undefined) return;

      if (noticeSettled(record)) index.delete(key);
      else index.set(key, record);
    }

    function queueNotice(message: ClientNotification, automatic = false) {
      return mutateNotice(async () => {
        const key = `${automatic ? automaticNoticePrefix : noticePrefix}${message.id}`;
        const otherKey = `${automatic ? noticePrefix : automaticNoticePrefix}${message.id}`;

        if ((await api.storage.kv.get<unknown>(otherKey)) !== undefined)
          throw new Error("Notification id belongs to another delivery");
        const stored = await api.storage.kv.get<unknown>(key);

        if (stored === undefined && !automatic) {
          const savedReceipt = await api.storage.kv.get<unknown>(
            `${explicitReceiptPrefix}${message.id}`,
          );

          if (savedReceipt !== undefined) {
            const receipt = explicitReceiptSchema.parse(savedReceipt);

            if (receipt.digest !== noticeDigest(message))
              throw new Error("Notification id already has different content");

            return {
              id: message.id,
              status:
                receipt.acceptedTargets.length > 0
                  ? ("dispatched" as const)
                  : ("expired" as const),
              duplicate: true,
              durable: true as const,
              acceptedTargetCount: receipt.acceptedTargets.length,
            };
          }
        }

        const existing =
          stored === undefined ? null : noticeSchema.parse(stored);

        if (
          existing !== null &&
          (existing.message.title !== message.title ||
            existing.message.body !== message.body ||
            existing.message.threadId !== message.threadId ||
            existing.message.channels.join(",") !== message.channels.join(","))
        ) {
          throw new Error("Notification id already has different content");
        }

        const record = existing ?? {
          message,
          acceptedTargets: [],
          queuedAt: Date.now(),
        };

        if (existing === null) await api.storage.kv.set(key, record);
        updatePendingNotice(key, record);
        const expired = noticeExpired(record);

        if (record.acceptedTargets.length === 0 && !expired) {
          api.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, record.message);
        }

        return {
          id: message.id,
          status:
            record.acceptedTargets.length > 0
              ? ("dispatched" as const)
              : expired
                ? ("expired" as const)
                : ("queued" as const),
          duplicate: existing !== null,
          durable: true as const,
          acceptedTargetCount: record.acceptedTargets.length,
        };
      });
    }

    function sendNotice(input: z.infer<typeof queuedNotificationInputSchema>) {
      return queueNotice({
        ...input,
        threadId: null,
        kind: null,
        channels: ["web", "desktop"],
      });
    }

    async function retireNotice(key: string, record: NoticeRecord) {
      if (!noticeSettled(record)) return false;

      const queuedAt = record.queuedAt ?? 0;

      if (Date.now() - queuedAt < receiptLifetimeMs) {
        const { acceptedTargets, message } = record;

        if (key.startsWith(automaticNoticePrefix))
          await api.storage.kv.set(`${automaticReceiptPrefix}${message.id}`, {
            acceptedTargets,
            queuedAt,
          });
        else
          await api.storage.kv.set(`${explicitReceiptPrefix}${message.id}`, {
            acceptedTargets,
            queuedAt,
            digest: noticeDigest(message),
          });
      }

      await api.storage.kv.delete(key);
      pendingNoticeIndex?.delete(key);

      return true;
    }

    async function loadPendingNotices() {
      const index = new Map<string, NoticeRecord>();

      const keys = await Promise.all([
        api.storage.kv.list(noticePrefix),
        api.storage.kv.list(automaticNoticePrefix),
      ]);

      for (const [offset, key] of keys.flat().entries()) {
        if (offset > 0 && offset % 64 === 0)
          await new Promise<void>((resolve) => setImmediate(resolve));

        const record = noticeSchema.parse(
          await api.storage.kv.get<unknown>(key),
        );

        updatePendingNotice(key, record, index);
        await retireNotice(key, record);
      }

      return index;
    }

    function pendingNotices(input: { channel?: "web" | "desktop" }) {
      return mutateNotice(async () => {
        const messages: ClientNotification[] = [];

        if (input.channel !== undefined) {
          const config = await settings.get();

          if (!config[`${input.channel}Enabled`]) return { messages };
        }

        const index = pendingNoticeIndex ?? (await loadPendingNotices());

        pendingNoticeIndex = index;

        const entries = [...index].sort(([left], [right]) => {
          const regularLeft = left.startsWith(noticePrefix);
          const regularRight = right.startsWith(noticePrefix);

          if (regularLeft !== regularRight) return regularLeft ? -1 : 1;

          return left < right ? -1 : left > right ? 1 : 0;
        });

        for (const [key, record] of entries) {
          if (await retireNotice(key, record)) continue;

          if (
            !noticeAccepted(record, input.channel) &&
            (input.channel === undefined ||
              record.message.channels.includes(input.channel))
          )
            messages.push(record.message);
        }

        return { messages };
      });
    }

    function acknowledgeNotice(input: {
      id: string;
      clientId: string;
      channel: "web" | "desktop";
    }) {
      return mutateNotice(async () => {
        let key = `${noticePrefix}${input.id}`;
        let stored = await api.storage.kv.get<unknown>(key);

        if (stored === undefined) {
          key = `${automaticNoticePrefix}${input.id}`;
          stored = await api.storage.kv.get<unknown>(key);
        }

        const target = `${input.channel}:${input.clientId}`;

        if (stored === undefined) {
          const explicitKey = `${explicitReceiptPrefix}${input.id}`;

          const explicitReceipt =
            await api.storage.kv.get<unknown>(explicitKey);

          const receiptKey =
            explicitReceipt === undefined
              ? `${automaticReceiptPrefix}${input.id}`
              : explicitKey;

          const savedReceipt =
            explicitReceipt ?? (await api.storage.kv.get<unknown>(receiptKey));

          if (savedReceipt === undefined)
            throw new Error("Queued notification not found");

          const receipt =
            explicitReceipt === undefined
              ? automaticReceiptSchema.parse(savedReceipt)
              : explicitReceiptSchema.parse(savedReceipt);

          if (!receipt.acceptedTargets.includes(target)) {
            receipt.acceptedTargets.push(target);
            await api.storage.kv.set(receiptKey, receipt);
          }

          return {
            ok: true as const,
            acceptedTargetCount: receipt.acceptedTargets.length,
          };
        }

        const record = noticeSchema.parse(stored);

        if (!record.acceptedTargets.includes(target)) {
          record.acceptedTargets.push(target);
          await api.storage.kv.set(key, record);
        }

        updatePendingNotice(key, record);
        await retireNotice(key, record);

        return {
          ok: true as const,
          acceptedTargetCount: record.acceptedTargets.length,
        };
      });
    }

    async function drainKeys(
      prefix: string,
      drainKey: (key: string, stored: unknown) => Promise<boolean>,
    ) {
      const keys = await api.storage.kv.list(prefix);
      let drained = 0;

      for (let offset = 0; offset < keys.length; offset += drainBatchSize) {
        drained += await mutateNotice(async () => {
          let count = 0;

          for (const key of keys.slice(offset, offset + drainBatchSize)) {
            const stored = await api.storage.kv.get<unknown>(key);

            if (stored !== undefined && (await drainKey(key, stored)))
              count += 1;
          }

          return count;
        });
      }

      return drained;
    }

    async function forgetReceipt(
      key: string,
      receipt: { queuedAt?: number | undefined },
    ) {
      if (
        receipt.queuedAt !== undefined &&
        Date.now() - receipt.queuedAt < receiptLifetimeMs
      )
        return false;

      await api.storage.kv.delete(key);

      return true;
    }

    async function drainNotices() {
      let retired = 0;

      for (const prefix of [noticePrefix, automaticNoticePrefix])
        retired += await drainKeys(prefix, (key, stored) =>
          retireNotice(key, noticeSchema.parse(stored)),
        );

      const forgotten =
        (await drainKeys(explicitReceiptPrefix, (key, stored) =>
          forgetReceipt(key, explicitReceiptSchema.parse(stored)),
        )) +
        (await drainKeys(automaticReceiptPrefix, (key, stored) =>
          forgetReceipt(key, automaticReceiptSchema.parse(stored)),
        ));

      if (retired + forgotten > 0)
        api.log.info(
          `Retired ${retired} settled notifications and forgot ${forgotten} receipts older than two days`,
        );
    }

    api.rpc.register(pushNotificationsRpcContract, {
      "notifications.send": sendNotice,
      "notifications.pending": pendingNotices,
      "notifications.ack": acknowledgeNotice,
      "notifications.test": ({ channel }) => sendTest(channel),
      "presence.report": (input) => {
        presence.report(input);
        sender.onPresenceReported();

        return { ok: true as const };
      },
      "pushSubscriptions.list": async () => ({
        subscriptions: await subscriptions.listSummaries(),
      }),
      "pushSubscriptions.add": (input) => subscriptions.add(input),
      "pushSubscriptions.remove": async ({ id }) => {
        if (!(await subscriptions.remove(id))) {
          throw new Error(`Push subscription not found: ${id}`);
        }

        return { ok: true as const };
      },
      "threadNotifications.get": ({ threadId }) => preferences.get(threadId),
      "threadNotifications.list": async ({ threadIds }) => ({
        threads: await preferences.list(threadIds),
      }),
      "threadNotifications.set": ({ threadId, level }) =>
        preferences.set(threadId, level),
    });

    api.cli.register(
      defineCli({
        name: "push-notifications",
        summary: "Manage mobile, web, and desktop notifications",
        description:
          "Mobile devices receive Expo push messages. Web delivery needs an open tab; desktop delivery needs the app running. Mac windows can be closed; closing the last window quits on Windows and Linux.",
        commands: {
          test: cliCommand({
            summary: "Queue a test for web or desktop clients with permission",
            positionals: [
              {
                name: "channel",
                description: "Client type to notify: web or desktop",
                required: true,
              },
            ],
            options: { json: JSON_OPTION },
            async run(input) {
              const channel = clientChannelSchema.safeParse(
                input.positionals.channel,
              );

              if (!channel.success) {
                throw new PluginCliError("Use web or desktop", {
                  code: "invalid_channel",
                  hint: "Mobile devices are tested from the phone itself; this command only reaches web and desktop clients.",
                });
              }

              try {
                await sendTest(channel.data);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  {
                    code: "channel_disabled",
                    hint: `Turn it on with \`omnyo plugin config push-notifications set ${channel.data}Enabled true\`.`,
                  },
                );
              }

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, channel: channel.data })
                  : `Test queued for ${channel.data} clients with notification permission`,
              };
            },
          }),
          list: cliCommand({
            summary: "List registered push devices",
            options: { json: JSON_OPTION },
            async run(input) {
              const rows = await subscriptions.listSummaries();

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ subscriptions: rows })
                  : formatSubscriptions(rows),
              };
            },
          }),
          add: cliCommand({
            summary: "Register or refresh an Expo push device",
            options: {
              token: {
                type: "string",
                required: true,
                placeholder: "expo-push-token",
                aliases: ["expo-token", "push-token", "expo-push-token"],
                description: `Expo push token the device reported, at most ${EXPO_PUSH_TOKEN_MAX_LENGTH} characters`,
              },
              platform: {
                type: "enum",
                required: true,
                values: ["ios", "android"],
                aliases: ["os"],
                description: "Device operating system",
              },
              label: {
                type: "string",
                required: true,
                placeholder: "device-label",
                aliases: ["device-label", "device", "name"],
                description: `Name shown for the device, at most ${DEVICE_LABEL_MAX_LENGTH} characters`,
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const parsed = addPushSubscriptionInputSchema.safeParse({
                expoPushToken: input.options.token,
                platform: input.options.platform,
                deviceLabel: input.options.label,
              });

              if (!parsed.success) {
                throw new PluginCliError(
                  parsed.error.issues.map((issue) => issue.message).join("; "),
                  { code: "invalid_device" },
                );
              }

              const result = await subscriptions.add(parsed.data);

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(result)
                  : `${result.created ? "Registered" : "Refreshed"} push device ${result.id}`,
              };
            },
          }),
          remove: cliCommand({
            summary: "Remove a registered push device",
            positionals: [
              {
                name: "id",
                description:
                  "Subscription id, as `omnyo push-notifications list` prints it",
                required: true,
              },
            ],
            options: { json: JSON_OPTION },
            async run(input) {
              const id = input.positionals.id;

              if (!(await subscriptions.remove(id))) {
                throw new PluginCliError(`Push subscription not found: ${id}`, {
                  code: "subscription_not_found",
                  hint: "Run `omnyo push-notifications list` for the registered ids.",
                });
              }

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ id, removed: true })
                  : `Removed push device ${id}`,
              };
            },
          }),
          thread: cliCommand({
            summary: "Show or set a thread's notification level",
            description:
              "Without --level, prints the resolved level and where it comes from. A thread uses its own level, else childLevel if it has a parent, else defaultLevel; every ancestor's own level caps it.",
            positionals: [
              {
                name: "thread",
                description: "Thread id",
                required: true,
              },
            ],
            options: {
              level: {
                type: "enum",
                values: ownNotificationLevelSchema.options,
                description:
                  "Set the thread's own level; inherit clears it so the parent or default applies",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const threadId = input.positionals.thread;
              let row: ThreadNotifications;

              try {
                if (input.options.level !== undefined) {
                  await preferences.set(threadId, input.options.level);
                }

                row = await preferences.get(threadId);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  { code: "thread_not_found" },
                );
              }

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ threadId, ...row })
                  : formatThreadNotifications(threadId, row),
              };
            },
          }),
          status: cliCommand({
            summary: "Show push delivery status",
            options: { json: JSON_OPTION },
            async run(input) {
              const view = await status();

              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(view)
                  : formatStatus(view),
              };
            },
          }),
        },
      }),
    );

    api.events.on("interaction.pending", (payload) => {
      sender.onInteractionPending(payload);
    });
    api.events.on("thread.idle", (payload) => {
      sender.onThreadIdle(payload);
    });
    api.events.on("thread.failed", (payload) => {
      sender.onThreadFailed(payload);
    });
    api.onDispose(
      api.sdk.subscribe({
        event: "thread:changed",
        callback: (event) => {
          if (event.id && event.changes.includes("interactions-changed"))
            sender.onAttentionChanged(event.id);
        },
      }),
    );
    api.events.on("experimental_thread.parentChanged", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    api.events.on("thread.unarchived", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    api.background.schedule("notification-drain", "*/15 * * * *", drainNotices);
    api.background.service("push-sender", {
      async start(signal) {
        await sender.start();

        try {
          await waitForAbort(signal);
        } finally {
          await sender.stop();
        }
      },
    });
  };
}

export default createPushNotificationsPlugin();

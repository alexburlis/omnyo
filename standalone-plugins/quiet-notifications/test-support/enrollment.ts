import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginApi } from "@omnyo/plugin-sdk";
import Database from "better-sqlite3";
import { z } from "zod";
import {
  addPushSubscriptionInputSchema,
  pushSubscriptionSchema,
  removePushSubscriptionInputSchema,
  type PushSubscription,
} from "../contract.js";

export function createEnrollment(expoPushUrl: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "omnyo-quiet-notifications-"));
  const database = new Database(join(dataDir, "app.db"));
  database.pragma("journal_mode = WAL");
  database.exec(
    "CREATE TABLE plugin_kv (plugin_id TEXT, key TEXT, value TEXT, PRIMARY KEY (plugin_id, key))",
  );

  const values = {
    mobileEnabled: true,
    webEnabled: true,
    desktopEnabled: true,
    expoPushUrl,
  };

  let nextId = 1;
  const notificationLevels = new Map<string, "all" | "input-only" | "muted">();
  const notificationRequests: string[] = [];

  type NotificationAuthority = {
    mode: "ready" | "denied" | "unavailable" | "malformed";
  };

  const notificationAuthority: NotificationAuthority = {
    mode: "ready",
  };

  function list(): PushSubscription[] {
    const rows = z
      .array(z.object({ value: z.string() }))
      .parse(
        database
          .prepare("SELECT value FROM plugin_kv WHERE plugin_id = ? ORDER BY key")
          .all("push-notifications"),
      );

    return rows.map((row) => pushSubscriptionSchema.parse(JSON.parse(row.value)));
  }

  const sdk: Pick<PluginApi["sdk"]["plugins"], "callRpc" | "getSettings" | "updateSettings"> = {
    async getSettings() {
      return { ok: true, schema: {}, values: { ...values } };
    },
    async updateSettings(args) {
      Object.assign(
        values,
        z
          .object({
            mobileEnabled: z.boolean().optional(),
            webEnabled: z.boolean().optional(),
            desktopEnabled: z.boolean().optional(),
            expoPushUrl: z.string().optional(),
          })
          .parse(args.values),
      );

      return { ok: true, schema: {}, values: { ...values } };
    },
    async callRpc(args) {
      if (args.pluginId !== "push-notifications") throw new Error("Wrong enrollment plugin");

      if (args.method === "threadNotifications.get") {
        const { threadId } = z
          .object({ threadId: z.string().min(1) })
          .strict()
          .parse(args.input);

        notificationRequests.push(threadId);

        if (notificationAuthority.mode === "denied") throw new Error("Permission denied");

        if (notificationAuthority.mode === "unavailable")
          throw new Error("Unknown method: threadNotifications.get");

        return args.outputSchema.parse({
          own: "inherit",
          effective:
            notificationAuthority.mode === "malformed"
              ? "invalid-level"
              : (notificationLevels.get(threadId) ?? "all"),
          source: "global",
        });
      }

      if (args.method === "pushSubscriptions.list") {
        return args.outputSchema.parse({
          subscriptions: list().map(({ expoPushToken, ...subscription }) => ({
            ...subscription,
            tokenSuffix: expoPushToken.slice(-6),
          })),
        });
      }

      if (args.method === "pushSubscriptions.add") {
        const input = addPushSubscriptionInputSchema.parse(args.input);

        const existing = list().find(
          (subscription) => subscription.expoPushToken === input.expoPushToken,
        );

        const subscription: PushSubscription = {
          ...input,
          id: existing?.id ?? `subscription-${nextId++}`,
          createdAt: existing?.createdAt ?? 1,
          lastSeenAt: 2,
        };

        database
          .prepare("INSERT OR REPLACE INTO plugin_kv VALUES (?, ?, ?)")
          .run(
            "push-notifications",
            `subscription:${subscription.id}`,
            JSON.stringify(subscription),
          );

        return args.outputSchema.parse({
          id: subscription.id,
          created: existing === undefined,
        });
      }

      if (args.method === "pushSubscriptions.remove") {
        const { id } = removePushSubscriptionInputSchema.parse(args.input);

        const removed = database
          .prepare("DELETE FROM plugin_kv WHERE plugin_id = ? AND key = ?")
          .run("push-notifications", `subscription:${id}`);

        if (removed.changes === 0) throw new Error(`Push subscription not found: ${id}`);

        return args.outputSchema.parse({ ok: true });
      }

      throw new Error("Unknown enrollment method");
    },
  };

  return {
    dataDir,
    database,
    notificationLevels,
    notificationRequests,
    notificationAuthority,
    sdk,
    values,
    list,
    close() {
      database.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

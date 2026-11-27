import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";
import {
  listPushSubscriptionsOutputSchema,
  pushNotificationsRpcContract,
  pushSubscriptionSchema,
  type AddPushSubscriptionInput,
  type PushSubscription,
  type PushSubscriptionSummary,
} from "./contract.js";

const ENROLLMENT_PLUGIN = "push-notifications";

const ORIGINAL_SETTINGS_KEY = "original-delivery-settings";

const INITIALIZED_KEY = "delivery-initialized";

const deliverySettingsSchema = z.object({
  mobileEnabled: z.boolean(),
  webEnabled: z.boolean(),
  desktopEnabled: z.boolean(),
  expoPushUrl: z.string().url(),
});

type DeliverySettings = z.infer<typeof deliverySettingsSchema>;

export interface PushSubscriptionStore {
  add(input: AddPushSubscriptionInput): Promise<{ id: string; created: boolean }>;
  list(): Promise<PushSubscription[]>;
  listSummaries(): Promise<PushSubscriptionSummary[]>;
  remove(id: string): Promise<boolean>;
}

export async function initializeDelivery(
  api: PluginApi,
  settings: {
    experimental_set(values: DeliverySettings): Promise<DeliverySettings>;
  },
): Promise<void> {
  const source = await api.sdk.plugins.getSettings({
    pluginId: ENROLLMENT_PLUGIN,
  });

  const original = deliverySettingsSchema.parse(source.values);
  const initialized = await api.storage.kv.get<boolean>(INITIALIZED_KEY);

  if (initialized !== true) {
    const saved = await api.storage.kv.get<DeliverySettings>(ORIGINAL_SETTINGS_KEY);

    const initial = saved === undefined ? original : deliverySettingsSchema.parse(saved);

    await api.storage.kv.set(ORIGINAL_SETTINGS_KEY, initial);
    await settings.experimental_set(initial);
  }

  await api.sdk.plugins.updateSettings({
    pluginId: ENROLLMENT_PLUGIN,
    values: { mobileEnabled: false, webEnabled: false, desktopEnabled: false },
  });
  await api.storage.kv.set(INITIALIZED_KEY, true);
}

export function createPushSubscriptionStore(api: PluginApi): PushSubscriptionStore {
  const database = api.storage.database();
  const source = join(api.server.experimental_dataDir, "app.db");

  try {
    if (!existsSync(source)) throw new Error("Omnyo registration database is missing");
    database.pragma("query_only = ON");
    database.prepare("ATTACH DATABASE ? AS registrations").run(source);
    database
      .prepare("SELECT value FROM registrations.plugin_kv WHERE plugin_id = ? LIMIT 0")
      .all(ENROLLMENT_PLUGIN);
  } catch (cause) {
    throw new Error(
      "Omnyo phone registrations are unavailable; Quiet Notifications requires the canonical 0.46 registration store",
      { cause },
    );
  }

  async function listSummaries(): Promise<PushSubscriptionSummary[]> {
    const result = await api.sdk.plugins.callRpc({
      pluginId: ENROLLMENT_PLUGIN,
      method: "pushSubscriptions.list",
      input: {},
      outputSchema: listPushSubscriptionsOutputSchema,
    });

    return result.subscriptions;
  }

  return {
    async add(input) {
      return api.sdk.plugins.callRpc({
        pluginId: ENROLLMENT_PLUGIN,
        method: "pushSubscriptions.add",
        input,
        outputSchema: pushNotificationsRpcContract["pushSubscriptions.add"].output,
      });
    },
    async list() {
      const rows = z
        .array(z.object({ value: z.string() }))
        .parse(
          database
            .prepare(
              "SELECT value FROM registrations.plugin_kv WHERE plugin_id = ? AND key LIKE ? ORDER BY key",
            )
            .all(ENROLLMENT_PLUGIN, "subscription:%"),
        );

      return rows
        .map((row) => pushSubscriptionSchema.parse(JSON.parse(row.value)))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    listSummaries,
    async remove(id) {
      if (!(await listSummaries()).some((subscription) => subscription.id === id)) return false;
      await api.sdk.plugins.callRpc({
        pluginId: ENROLLMENT_PLUGIN,
        method: "pushSubscriptions.remove",
        input: { id },
        outputSchema: pushNotificationsRpcContract["pushSubscriptions.remove"].output,
      });

      return true;
    },
  };
}

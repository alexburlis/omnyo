import { describe, expect, it, vi } from "vitest";
import type { PushSubscriptionRecord } from "./push-contract";
import {
  syncPushRegistration,
  type PushNotificationsModule,
} from "./push-registration";
import { createMemoryPushStorage, createPushStore } from "./push-store";
import type { PushSubscriptionsApi } from "./push-subscriptions-api";

const NOW = 1_800_000_000_000;

const profile = {
  id: "profile-1",
  serverUrl: "https://omnyo.example",
  mode: "direct",
} as const;

const deviceToken = "device-token-a";

function row(id: string): PushSubscriptionRecord {
  return {
    id,
    platform: "ios",
    deviceLabel: "Phone",
    createdAt: NOW - 60_000,
    lastSeenAt: NOW - 60_000,
    tokenSuffix: deviceToken.slice(-6),
  };
}

function setup(serverRows: () => Promise<PushSubscriptionRecord[]>) {
  const store = createPushStore(createMemoryPushStorage());
  store.setEnabled(profile.id, true);
  store.setRegistration(profile.id, {
    subscriptionId: "row-before",
    expoPushToken: deviceToken,
    tokenSuffix: deviceToken.slice(-6),
    platform: "ios",
    serverUrl: profile.serverUrl,
    registeredAt: NOW - 60_000,
  });

  const notifications: PushNotificationsModule = {
    projectId: "expo-project",
    platform: "ios",
    getPermission: async () => "granted",
    requestPermission: async () => "granted",
    getExpoPushToken: async () => deviceToken,
    unregisterDevicePushToken: async () => undefined,
    addTokenListener: () => () => undefined,
    setBadgeCount: async () => undefined,
  };

  const api = {
    list: vi.fn((_serverUrl: string) => serverRows()),
    register: vi.fn(async () => ({ subscriptionId: "row-after" })),
    unregister: vi.fn(async () => undefined),
  } satisfies PushSubscriptionsApi;

  const deps = {
    notifications,
    api,
    store,
    deviceLabel: "Phone",
    now: () => NOW,
  };

  return { api, deps, store };
}

describe("push registration server check", () => {
  it("keeps a fresh registration the server still has", async () => {
    const { api, deps, store } = setup(async () => [row("row-before")]);

    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "skipped",
      reason: "up-to-date",
    });
    expect(api.list).toHaveBeenCalledWith(profile.serverUrl);
    expect(api.register).not.toHaveBeenCalled();
    expect(store.getRegistration(profile.id)?.subscriptionId).toBe(
      "row-before",
    );
  });

  it("registers again when the server lost a fresh registration", async () => {
    const { api, deps, store } = setup(async () => [row("someone-else")]);

    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "registered",
      expoPushToken: deviceToken,
    });
    expect(api.register).toHaveBeenCalledWith(profile.serverUrl, {
      expoPushToken: deviceToken,
      platform: "ios",
      deviceLabel: "Phone",
    });
    expect(api.unregister).not.toHaveBeenCalled();
    expect(store.getRegistration(profile.id)).toMatchObject({
      subscriptionId: "row-after",
      registeredAt: NOW,
    });
  });

  it("reports a failed server check without touching the saved registration", async () => {
    const { api, deps, store } = setup(async () => {
      throw new Error("Server unavailable");
    });

    expect(await syncPushRegistration(deps, profile)).toEqual({
      action: "failed",
      step: "verify",
      error: "Server unavailable",
    });
    expect(api.register).not.toHaveBeenCalled();
    expect(store.getRegistration(profile.id)?.subscriptionId).toBe(
      "row-before",
    );
  });
});

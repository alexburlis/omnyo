import { describe, expect, it, vi } from "vitest";
import { createPushRegistrationController } from "./push-registration-controller";
import {
  shouldShowPushPrompt,
  type PushNotificationsModule,
  type PushPermissionState,
} from "./push-registration";
import { createMemoryPushStorage, createPushStore } from "./push-store";
import type { PushSubscriptionsApi } from "./push-subscriptions-api";

const firstLaunch = {
  revealed: true,
  available: true,
  prompted: false,
  presented: false,
  serversLoaded: true,
  hasServers: false,
  serverConnected: false,
};

describe("shouldShowPushPrompt", () => {
  it("asks on first launch before any server is added", () => {
    expect(shouldShowPushPrompt(firstLaunch)).toBe(true);
  });

  it("waits for saved servers to load and for the splash to clear", () => {
    expect(shouldShowPushPrompt({ ...firstLaunch, serversLoaded: false })).toBe(
      false,
    );
    expect(shouldShowPushPrompt({ ...firstLaunch, revealed: false })).toBe(
      false,
    );
  });

  it("waits for a saved server to connect before asking for it", () => {
    expect(shouldShowPushPrompt({ ...firstLaunch, hasServers: true })).toBe(
      false,
    );
    expect(
      shouldShowPushPrompt({
        ...firstLaunch,
        hasServers: true,
        serverConnected: true,
      }),
    ).toBe(true);
  });

  it("asks only once per install", () => {
    expect(shouldShowPushPrompt({ ...firstLaunch, prompted: true })).toBe(
      false,
    );
    expect(shouldShowPushPrompt({ ...firstLaunch, presented: true })).toBe(
      false,
    );
  });
});

function setup(answer: PushPermissionState) {
  const store = createPushStore(createMemoryPushStorage());
  let permission: PushPermissionState = "undetermined";

  const notifications: PushNotificationsModule = {
    projectId: "expo-project",
    platform: "ios",
    getPermission: async () => permission,
    requestPermission: vi.fn(async () => {
      permission = answer;

      return answer;
    }),
    getExpoPushToken: async () => "device-token-a",
    unregisterDevicePushToken: async () => undefined,
    addTokenListener: () => () => undefined,
    setBadgeCount: async () => undefined,
  };

  const api = {
    register: vi.fn<PushSubscriptionsApi["register"]>(async () => ({
      subscriptionId: "row-1",
    })),
    unregister: vi.fn<PushSubscriptionsApi["unregister"]>(
      async () => undefined,
    ),
    list: vi.fn<PushSubscriptionsApi["list"]>(async () => []),
  };

  const controller = createPushRegistrationController({
    notifications,
    api,
    store,
    deviceLabel: "Phone",
    now: () => 1,
  });

  return { api, controller, notifications, store };
}

const server = {
  id: "server-1",
  serverUrl: "https://omnyo.example",
  mode: "direct",
} as const;

describe("turning notifications on before adding a server", () => {
  it("asks iOS at once and registers the first server when it connects", async () => {
    const { api, controller, notifications, store } = setup("granted");

    expect(await controller.enableForFirstServer()).toBe("granted");
    expect(notifications.requestPermission).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({
      prompted: true,
      enableFirstServer: true,
    });

    expect(await controller.sync(server)).toEqual({
      action: "registered",
      expoPushToken: "device-token-a",
    });
    expect(api.register).toHaveBeenCalledWith(server.serverUrl, {
      expoPushToken: "device-token-a",
      platform: "ios",
      deviceLabel: "Phone",
    });
    expect(store.isEnabled(server.id)).toBe(true);
    expect(store.getSnapshot().enableFirstServer).toBe(false);
  });

  it("remembers a refusal and leaves the first server off", async () => {
    const { api, controller, store } = setup("denied");

    expect(await controller.enableForFirstServer()).toBe("denied");
    expect(store.getSnapshot()).toMatchObject({
      prompted: true,
      enableFirstServer: false,
    });
    expect(await controller.sync(server)).toEqual({
      action: "skipped",
      reason: "disabled",
    });
    expect(api.register).not.toHaveBeenCalled();
  });

  it("keeps the choice for a server that can receive push", async () => {
    const { controller, store } = setup("granted");
    await controller.enableForFirstServer();

    await controller.sync({
      id: "plain-http",
      serverUrl: "http://192.168.1.20:3000",
      mode: "direct",
    });
    expect(store.isEnabled("plain-http")).toBe(false);
    expect(store.getSnapshot().enableFirstServer).toBe(true);

    await controller.sync(server);
    expect(store.isEnabled(server.id)).toBe(true);
  });
});

import { expect, it, vi } from "vitest";
import type { ConnectServerProfile } from "@/lib/profiles/profile";

const control = vi.hoisted(() => {
  const client = {
    profileId: "relay",
    serverUrl: "https://alexb.omnyo.link",
    onAuthFailure: vi.fn(() => () => {}),
    realtime: {
      onConnected: vi.fn(() => () => {}),
      onConnectFailed: vi.fn(() => () => {}),
    },
  };

  const scheduler = {
    start: vi.fn(async () => ({ status: "authenticating" })),
    stop: vi.fn(),
    getState: () => ({ status: "authenticating" }),
    onStateChange: vi.fn(() => () => {}),
    renewIfDue: vi.fn(),
  };

  return { client, scheduler };
});

vi.mock("@/lib/native", () => ({
  nativeAppState: {
    currentState: "active",
    addEventListener: () => ({ remove: () => {} }),
  },
  nativeCookieStore: { set: async () => true },
  nativeSessionCache: {
    read: async () => null,
    write: async () => {},
    clear: async () => {},
  },
}));

vi.mock("./client-registry", () => ({
  getAppProfileClientRegistry: () => ({
    getClientForProfile: () => control.client,
    disposeClient: () => {},
    disposeAll: () => {},
  }),
}));

vi.mock("@/lib/session", () => ({
  createSessionScheduler: () => control.scheduler,
}));

import { getActiveProfileConnector } from "./connector";

const relay: ConnectServerProfile = {
  id: "relay",
  mode: "connect",
  label: "alexb",
  serverUrl: "https://alexb.omnyo.link",
  handle: "alexb",
  credential: "fixture",
  createdAt: 0,
};

it("activates a omnyo.link relay profile through the app connector with a client and a session owner", () => {
  const connector = getActiveProfileConnector();
  connector.activate(relay);

  expect(connector.getSnapshot()).toMatchObject({
    profile: relay,
    client: control.client,
    session: { status: "authenticating" },
  });
  expect(control.scheduler.start).toHaveBeenCalledExactlyOnceWith(relay);

  connector.activate(null);
  expect(control.scheduler.stop).toHaveBeenCalled();
});

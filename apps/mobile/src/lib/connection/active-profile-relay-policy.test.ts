import { describe, expect, it, vi } from "vitest";
import type { ServerProfile } from "../profiles/profile";
import { isSupportedRelayServer } from "../profiles/supported-relay";
import type { ProfileClient } from "../sdk/client-registry";
import type {
  SessionScheduler,
  SessionState,
} from "../session/session-scheduler";
import {
  UNSUPPORTED_RELAY_DETAIL,
  createActiveProfileConnector,
} from "./active-profile-connector";

function relayProfile(serverUrl: string): ServerProfile {
  return {
    id: "relay",
    label: "Relay",
    serverUrl,
    createdAt: 17,
    mode: "connect",
    handle: new URL(serverUrl).hostname.split(".")[0] ?? "relay",
    credential: "fixture",
  };
}

function owner() {
  let reportAuthFailure: (() => void) | null = null;

  const client = {
    onAuthFailure: vi.fn((listener: () => void) => {
      reportAuthFailure = listener;

      return () => {};
    }),
    realtime: {
      onConnected: vi.fn(() => () => {}),
      onConnectFailed: vi.fn(() => () => {}),
      probeOrReconnect: vi.fn(),
    },
  };

  const authenticated: SessionState = {
    status: "authenticated",
    expiresAt: Date.now() + 3_600_000,
    restored: false,
  };

  const scheduler = {
    start: vi.fn(async () => authenticated),
    stop: vi.fn(),
    getState: () => authenticated,
    onStateChange: vi.fn(() => () => {}),
    renewIfDue: vi.fn(),
    renewNow: vi.fn(async () => authenticated),
    verifySession: vi.fn(async () => authenticated),
  };

  const registry = {
    getClientForProfile: vi.fn(() => client as unknown as ProfileClient),
    disposeClient: vi.fn(),
    disposeAll: vi.fn(),
  };

  const createSessionScheduler = vi.fn(
    () => scheduler as unknown as SessionScheduler,
  );

  const addEventListener = vi.fn(() => ({ remove: vi.fn() }));

  const connector = createActiveProfileConnector({
    isSupportedRelay: isSupportedRelayServer,
    registry,
    appState: { currentState: "active", addEventListener },
    createSessionScheduler,
  });

  return {
    connector,
    registry,
    scheduler,
    createSessionScheduler,
    addEventListener,
    reportClientAuthFailure: () => reportAuthFailure?.(),
  };
}

describe("relay profile policy", () => {
  it("refuses a saved getbb.app profile before any client, session or mint, and preserves it", () => {
    const retired = relayProfile("https://alex.getbb.app");
    const before = JSON.stringify(retired);
    const active = owner();

    active.connector.activate(retired);

    expect(active.connector.getSnapshot()).toEqual({
      profile: retired,
      client: null,
      session: { status: "unsupported", detail: UNSUPPORTED_RELAY_DETAIL },
    });
    expect(JSON.stringify(retired)).toBe(before);
    expect(active.registry.getClientForProfile).not.toHaveBeenCalled();
    expect(active.createSessionScheduler).not.toHaveBeenCalled();
    expect(active.addEventListener).not.toHaveBeenCalled();

    active.connector.reportShellAuthFailure(retired.id);
    expect(active.scheduler.renewNow).not.toHaveBeenCalled();
    active.connector.activate(null);
    expect(active.connector.getSnapshot()).toBeNull();
  });

  it("activates a omnyo.link relay profile with a client and a session owner", () => {
    const relay = relayProfile("https://alexb.omnyo.link");
    const active = owner();

    active.connector.activate(relay);

    expect(active.registry.getClientForProfile).toHaveBeenCalledExactlyOnceWith(
      relay,
    );
    expect(active.scheduler.start).toHaveBeenCalledExactlyOnceWith(relay);
    expect(active.connector.getSnapshot()?.client).not.toBeNull();
  });
});

describe("shell sign-in redirect", () => {
  it("re-mints in renew mode so a failed mint shows its error instead of a blank page", () => {
    const active = owner();
    active.connector.activate(relayProfile("https://alexb.omnyo.link"));

    active.connector.reportShellAuthFailure("relay");

    expect(active.scheduler.renewNow).toHaveBeenCalledOnce();
    expect(active.scheduler.verifySession).not.toHaveBeenCalled();
  });

  it("keeps verify mode for a 401 from a native API call", () => {
    const active = owner();
    active.connector.activate(relayProfile("https://alexb.omnyo.link"));

    active.reportClientAuthFailure();

    expect(active.scheduler.verifySession).toHaveBeenCalledOnce();
    expect(active.scheduler.renewNow).not.toHaveBeenCalled();
  });
});

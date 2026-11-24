import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotificationHub } from "../../src/ws/hub.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";

describe("NotificationHub client pressure", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      "thread-detail",
      (hub: NotificationHub) =>
        hub.notifyThread("thread-1", ["events-appended"]),
    ],
    [
      "thread-list",
      (hub: NotificationHub) =>
        hub.notifyThread("thread-1", ["events-appended"]),
    ],
    [
      "project",
      (hub: NotificationHub) =>
        hub.notifyProject("project-1", ["threads-changed"]),
    ],
    [
      "thread-open",
      (hub: NotificationHub) =>
        hub.notifyThreadOpen(
          { projectId: "project-1", threadId: "thread-1" },
          { split: "replace", file: null },
        ),
    ],
    [
      "pane-action",
      (hub: NotificationHub) =>
        hub.notifyThreadPaneAction(
          { projectId: "project-1", threadId: "thread-1" },
          "maximize",
        ),
    ],
    [
      "plugin-signal",
      (hub: NotificationHub) =>
        hub.notifyPluginSignal("plugin-1", "updates", { ready: true }),
    ],
  ] as const)(
    "disconnects a slow %s client without delaying healthy clients",
    (surface, notify) => {
      vi.useFakeTimers();
      const hub = new NotificationHub();

      const slow = {
        ...createMockHubSocket(),
        raw: { bufferedAmount: 4 * 1024 * 1024 },
      };

      const healthy = createMockHubSocket();

      for (const socket of [slow, healthy]) {
        if (surface === "thread-detail")
          hub.subscribe(socket, {
            kind: "thread-detail",
            threadId: "thread-1",
          });
        else if (surface === "thread-list")
          hub.subscribe(socket, { kind: "thread-list" });
        else if (surface === "project")
          hub.subscribe(socket, {
            kind: "project-detail",
            projectId: "project-1",
          });
        else hub.registerClient(socket);
      }

      notify(hub);
      expect(slow.closed).toEqual([
        { code: 1013, reason: "client-backpressure" },
      ]);
      expect(slow.messages).toEqual([]);
      expect(healthy.messages).toHaveLength(1);
      slow.raw.bufferedAmount = 0;
      notify(hub);
      vi.advanceTimersByTime(1_000);
      expect(slow.messages).toEqual([]);
      expect(healthy.messages).toHaveLength(2);
    },
  );

  it.each([0, 1])(
    "bounds encoded client bytes with %i bytes above the limit",
    (overflow) => {
      const hub = new NotificationHub();
      const value = 'Grüße 🦈\n"';

      const payload = JSON.stringify({
        type: "plugin-signal",
        pluginId: "plugin-1",
        channel: "updates",
        payload: value,
      });

      const socket = {
        ...createMockHubSocket(),
        raw: {
          bufferedAmount:
            4 * 1024 * 1024 - Buffer.byteLength(payload, "utf8") + overflow,
        },
      };

      hub.registerClient(socket);

      expect(hub.notifyPluginSignal("plugin-1", "updates", value)).toBe(
        overflow === 0 ? 1 : 0,
      );
      expect(socket.messages).toEqual(overflow === 0 ? [payload] : []);
      expect(socket.closed).toEqual(
        overflow === 0 ? [] : [{ code: 1013, reason: "client-backpressure" }],
      );
    },
  );

  it("removes a throwing client and continues notifications to healthy clients", () => {
    const hub = new NotificationHub();

    const broken = {
      ...createMockHubSocket(),
      send: vi.fn(() => {
        throw new Error("send failed");
      }),
    };

    const healthy = createMockHubSocket();

    for (const socket of [broken, healthy])
      hub.subscribe(socket, { kind: "project-list" });

    expect(() =>
      hub.notifyProject("project-1", ["threads-changed"]),
    ).not.toThrow();
    expect(broken.closed).toEqual([
      { code: 1013, reason: "client-send-failed" },
    ]);
    hub.notifyProject("project-1", ["threads-changed"]);
    expect(broken.send).toHaveBeenCalledTimes(1);
    expect(healthy.messages).toHaveLength(2);
    expect(hub.notifyPluginSignal("plugin-1", "updates", null)).toBe(1);
  });
});

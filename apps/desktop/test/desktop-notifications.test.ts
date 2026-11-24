import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  createDesktopNotificationDelivery,
  startDesktopNotifications,
} from "../src/desktop-notifications.js";

class TestNotification extends EventEmitter {
  show = vi.fn(() => this.emit("show"));
  close = vi.fn(() => this.emit("close"));
}

const message = {
  id: "closed-window-event",
  title: "Thread ready",
  body: "Finished with the window closed",
  threadId: "thread-1",
  channels: ["desktop"],
};

function options() {
  const notifications: TestNotification[] = [];

  return {
    notifications,
    isSupported: vi.fn(() => true),
    createNotification: vi.fn(() => {
      const notification = new TestNotification();
      notifications.push(notification);

      return notification;
    }),
    openThread: vi.fn(),
    removeThreadNotifications: vi.fn(),
    onError: vi.fn(),
  };
}

describe("desktop notification owner", () => {
  it("accepts once before renderer startup, shares acceptance on reopen, and opens the thread on click", async () => {
    const args = options();
    const delivery = createDesktopNotificationDelivery(args);

    try {
      expect(
        await Promise.all([
          delivery.deliver(message),
          delivery.deliver(message),
        ]),
      ).toEqual([true, true]);
      expect(await delivery.deliver(message)).toBe(true);
      expect(args.notifications).toHaveLength(1);
      args.notifications[0]?.emit("click");
      expect(args.openThread).toHaveBeenCalledExactlyOnceWith(message.threadId);
    } finally {
      delivery.stop();
    }
  });

  it("withdraws only the read chat's shown banners and keeps them accepted", async () => {
    const args = options();
    const delivery = createDesktopNotificationDelivery(args);

    try {
      await delivery.deliver(message);
      await delivery.deliver({ ...message, id: "second-event" });
      await delivery.deliver({ ...message, id: "other", threadId: "thread-2" });
      delivery.withdrawThread("thread-1");
      expect(
        args.notifications.map(({ close }) => close.mock.calls.length),
      ).toEqual([1, 1, 0]);
      expect(args.removeThreadNotifications).toHaveBeenCalledExactlyOnceWith(
        "thread-1",
      );
      expect(delivery.acceptedIds()).toEqual([
        message.id,
        "second-event",
        "other",
      ]);
      delivery.withdrawThread("thread-1");
      expect(args.notifications[0]?.close).toHaveBeenCalledOnce();
    } finally {
      delivery.stop();
    }
  });

  it("keeps refused notifications unaccepted and retries the same identity", async () => {
    const args = options();
    args.createNotification.mockImplementationOnce(() => {
      const notification = new TestNotification();
      notification.show.mockImplementation(() => notification.emit("failed"));
      args.notifications.push(notification);

      return notification;
    });
    const delivery = createDesktopNotificationDelivery(args);

    try {
      expect(await delivery.deliver(message)).toBe(false);
      expect(delivery.acceptedIds()).toEqual([]);
      expect(await delivery.deliver(message)).toBe(true);
      expect(args.notifications).toHaveLength(2);
      expect(args.onError).toHaveBeenCalledOnce();
    } finally {
      delivery.stop();
    }
  });

  it("does not acknowledge an in-flight notification after shutdown", async () => {
    const args = options();
    args.createNotification.mockImplementationOnce(() => {
      const notification = new TestNotification();
      notification.show.mockImplementation(() => false);
      args.notifications.push(notification);

      return notification;
    });
    const delivery = createDesktopNotificationDelivery(args);
    const accepted = delivery.deliver(message);
    delivery.stop();
    args.notifications[0]?.emit("show");
    expect(await accepted).toBe(false);
    expect(delivery.acceptedIds()).toEqual([]);
    expect(await delivery.deliver(message)).toBe(false);
  });

  it("rejects unsupported, malformed and other-channel messages without displaying", async () => {
    const args = options();
    const delivery = createDesktopNotificationDelivery(args);

    try {
      expect(await delivery.deliver({ ...message, threadId: 1 })).toBe(false);
      expect(await delivery.deliver({ ...message, channels: ["web"] })).toBe(
        false,
      );
      args.isSupported.mockReturnValue(false);
      expect(await delivery.deliver(message)).toBe(false);
      expect(args.notifications).toHaveLength(0);
    } finally {
      delivery.stop();
    }
  });

  it("drains a queued notice with no renderer and retries a lost acknowledgment without redisplaying", async () => {
    let accepted = false;
    let queuedMessage = message;
    let acknowledgments = 0;

    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(chunk);
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");

      if (request.url?.endsWith("notifications.pending")) {
        expect(input).toEqual({ channel: "desktop" });
        response.end(
          JSON.stringify({
            ok: true,
            result: { messages: accepted ? [] : [queuedMessage] },
          }),
        );
      } else if (request.url?.endsWith("notifications.ack")) {
        expect(input).toEqual({
          id: queuedMessage.id,
          clientId: "desktop-test-owner",
          channel: "desktop",
        });
        acknowledgments += 1;

        if (acknowledgments === 1) {
          accepted = true;
          response.writeHead(503).end(JSON.stringify({ ok: false }));
        } else {
          accepted = true;
          response.end(
            JSON.stringify({
              ok: true,
              result: { ok: true, acceptedTargetCount: 1 },
            }),
          );
        }
      } else {
        response.writeHead(404).end();
      }
    });

    const websocket = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const args = options();

    const owner = startDesktopNotifications({
      ...args,
      serverUrl: `http://127.0.0.1:${address.port}`,
      clientId: "desktop-test-owner",
      fetchImpl: fetch,
      getCookie: async () => "",
      readPresence: () => ({ idleSeconds: 0, locked: false }),
    });

    try {
      await vi.waitFor(() => expect(acknowledgments).toBe(2), {
        timeout: 4_000,
      });
      expect(acknowledgments).toBe(2);
      expect(args.notifications).toHaveLength(1);
      expect(await owner.deliver(message.id)).toBe(false);
      expect(args.notifications).toHaveLength(1);
      expect(args.onError).toHaveBeenCalledOnce();
      queuedMessage = { ...message, id: "reopened-window-event" };
      accepted = false;
      expect(await owner.deliver(queuedMessage.id)).toBe(true);
      expect(acknowledgments).toBe(3);
      expect(args.notifications).toHaveLength(2);
      expect(await owner.deliver(queuedMessage.id)).toBe(false);
      expect(args.notifications).toHaveLength(2);
    } finally {
      owner.stop();

      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports computer activity when connected and when the screen locks", async () => {
    const reports: unknown[] = [];

    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];

      for await (const chunk of request) chunks.push(chunk);
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "application/json");

      if (request.url?.endsWith("notifications.pending")) {
        response.end(JSON.stringify({ ok: true, result: { messages: [] } }));
      } else if (request.url?.endsWith("presence.report")) {
        reports.push(input);
        response.end(JSON.stringify({ ok: true, result: { ok: true } }));
      } else {
        response.writeHead(404).end();
      }
    });

    const websocket = new WebSocketServer({ server });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const args = options();

    const owner = startDesktopNotifications({
      ...args,
      serverUrl: `http://127.0.0.1:${address.port}`,
      clientId: "desktop-test-owner",
      fetchImpl: fetch,
      getCookie: async () => "",
      readPresence: () => ({ idleSeconds: 7, locked: false }),
    });

    try {
      await vi.waitFor(() =>
        expect(reports).toEqual([
          { clientId: "desktop-test-owner", idleSeconds: 7, locked: false },
        ]),
      );
      owner.reportPresence({ idleSeconds: 9, locked: true });
      await vi.waitFor(() =>
        expect(reports.at(-1)).toEqual({
          clientId: "desktop-test-owner",
          idleSeconds: 9,
          locked: true,
        }),
      );
      expect(args.onError).not.toHaveBeenCalled();
    } finally {
      owner.stop();

      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("shows a notice queued after connecting when the server signals it", async () => {
    let queued = false;
    let pendingReads = 0;

    const server = createServer((request, response) => {
      request.resume();
      response.setHeader("content-type", "application/json");

      if (request.url?.endsWith("notifications.pending")) {
        pendingReads += 1;
        response.end(
          JSON.stringify({
            ok: true,
            result: { messages: queued ? [message] : [] },
          }),
        );
      } else if (request.url?.endsWith("notifications.ack")) {
        queued = false;
        response.end(
          JSON.stringify({
            ok: true,
            result: { ok: true, acceptedTargetCount: 1 },
          }),
        );
      } else if (request.url?.endsWith("presence.report")) {
        response.end(JSON.stringify({ ok: true, result: { ok: true } }));
      } else {
        response.writeHead(404).end();
      }
    });

    const websocket = new WebSocketServer({ server });
    const subscriptions: unknown[] = [];
    websocket.on("connection", (client) =>
      client.on("message", (data) => {
        subscriptions.push(JSON.parse(data.toString()));
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Missing port");
    const args = options();

    const owner = startDesktopNotifications({
      ...args,
      serverUrl: `http://127.0.0.1:${address.port}`,
      clientId: "desktop-test-owner",
      fetchImpl: fetch,
      getCookie: async () => "",
      readPresence: () => ({ idleSeconds: 0, locked: false }),
    });

    try {
      await vi.waitFor(() => expect(pendingReads).toBe(1));
      expect(args.notifications).toHaveLength(0);
      queued = true;

      for (const client of websocket.clients)
        client.send(
          JSON.stringify({
            type: "plugin-signal",
            pluginId: "push-notifications",
            channel: "omnyo-notification-v1",
            payload: message,
          }),
        );
      await vi.waitFor(() => expect(args.notifications).toHaveLength(1));
      await vi.waitFor(() => expect(queued).toBe(false));
      expect(subscriptions).toContainEqual({
        type: "subscribe",
        target: { kind: "thread-list" },
      });

      const readChange = (lastReadAt: number | null) =>
        JSON.stringify({
          type: "changed",
          entity: "thread",
          id: message.threadId,
          changes: ["read-state-changed"],
          metadata: { listEntry: { id: message.threadId, lastReadAt } },
        });

      for (const client of websocket.clients) client.send(readChange(null));

      for (const client of websocket.clients) client.send(readChange(1));
      await vi.waitFor(() =>
        expect(args.removeThreadNotifications).toHaveBeenCalledOnce(),
      );
      expect(args.removeThreadNotifications).toHaveBeenCalledWith(
        message.threadId,
      );
      expect(args.notifications[0]?.close).toHaveBeenCalledOnce();
    } finally {
      owner.stop();

      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

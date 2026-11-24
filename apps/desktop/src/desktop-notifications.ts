import { z } from "zod";
import WebSocket from "ws";

const notificationSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string(),
  body: z.string(),
  threadId: z.string().nullable(),
  channels: z.array(z.enum(["web", "desktop"])),
});

const pendingSchema = z.object({
  ok: z.literal(true),
  result: z.object({ messages: z.array(notificationSchema) }),
});

const acknowledgmentSchema = z.object({
  ok: z.literal(true),
  result: z.object({
    ok: z.literal(true),
    acceptedTargetCount: z.number().int().positive(),
  }),
});

const notificationSignalSchema = z.object({
  type: z.literal("plugin-signal"),
  pluginId: z.literal("push-notifications"),
  channel: z.enum(["notification", "omnyo-notification-v1"]),
});

const presenceAcknowledgmentSchema = z.object({
  ok: z.literal(true),
  result: z.object({ ok: z.literal(true) }),
});

const threadReadSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("thread"),
  id: z.string().min(1),
  changes: z.array(z.string()),
  metadata: z.object({
    listEntry: z.object({ lastReadAt: z.number() }),
  }),
});

const pluginChangeSchema = z.object({
  type: z.literal("changed"),
  entity: z.literal("system"),
  changes: z.array(z.string()),
});

class DesktopNotificationsUnavailableError extends Error {}

class DesktopPresenceUnsupportedError extends Error {}

type NotificationMessage = z.infer<typeof notificationSchema>;

export interface DesktopPresence {
  idleSeconds: number;
  locked: boolean;
}

interface NativeNotification {
  once(
    event: "show" | "click" | "close" | "failed",
    callback: () => void,
  ): unknown;
  show(): void;
  close(): void;
}

interface DesktopNotificationOptions {
  isSupported(): boolean;
  createNotification(message: NotificationMessage): NativeNotification;
  openThread(threadId: string | null): void;
  removeThreadNotifications(threadId: string): void;
  onError(error: unknown): void;
}

export function desktopNotificationGroupId(threadId: string): string {
  return `omnyo-thread:${threadId}`;
}

export function createDesktopNotificationDelivery(
  args: DesktopNotificationOptions,
) {
  const accepted = new Set<string>();
  const pending = new Map<string, Promise<boolean>>();
  const active = new Map<NativeNotification, () => void>();
  const shownByThread = new Map<string, Set<NativeNotification>>();
  let stopped = false;

  function release(
    notification: NativeNotification,
    threadId: string | null,
  ): void {
    active.delete(notification);

    if (threadId === null) return;
    const shown = shownByThread.get(threadId);
    shown?.delete(notification);

    if (shown?.size === 0) shownByThread.delete(threadId);
  }

  function deliver(payload: unknown): Promise<boolean> {
    const parsed = notificationSchema.safeParse(payload);

    if (!parsed.success || stopped || !args.isSupported())
      return Promise.resolve(false);
    const message = parsed.data;

    if (!message.channels.includes("desktop")) return Promise.resolve(false);

    if (accepted.has(message.id)) return Promise.resolve(true);
    const existing = pending.get(message.id);

    if (existing) return existing;

    const result = new Promise<boolean>((resolve) => {
      let notification: NativeNotification;

      try {
        notification = args.createNotification(message);
      } catch (error) {
        args.onError(error);
        resolve(false);

        return;
      }

      let settled = false;

      const finish = (shown: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (shown) accepted.add(message.id);
        resolve(shown);
      };

      const timer = setTimeout(() => {
        args.onError(new Error("System notification display timed out"));
        finish(false);
        notification.close();
        release(notification, message.threadId);
      }, 10_000);

      active.set(notification, () => finish(false));
      notification.once("show", () => {
        finish(true);

        if (message.threadId === null || !active.has(notification)) return;
        const shown = shownByThread.get(message.threadId) ?? new Set();
        shown.add(notification);
        shownByThread.set(message.threadId, shown);
      });
      notification.once("click", () => {
        args.openThread(message.threadId);
        notification.close();
        release(notification, message.threadId);
      });
      notification.once("close", () => {
        finish(false);
        release(notification, message.threadId);
      });
      notification.once("failed", () => {
        args.onError(new Error("The system refused the notification"));
        finish(false);
        release(notification, message.threadId);
      });

      try {
        notification.show();
      } catch (error) {
        args.onError(error);
        finish(false);
        release(notification, message.threadId);
      }
    }).finally(() => pending.delete(message.id));

    pending.set(message.id, result);

    return result;
  }

  return {
    deliver,
    acceptedIds: () => [...accepted],
    acknowledge: (id: string) => accepted.delete(id),
    withdrawThread(threadId: string): void {
      if (stopped) return;
      const shown = [...(shownByThread.get(threadId) ?? [])];
      shownByThread.delete(threadId);

      for (const notification of shown) {
        notification.close();
        active.delete(notification);
      }

      args.removeThreadNotifications(threadId);
    },
    stop(): void {
      stopped = true;

      for (const [notification, finish] of active) {
        finish();
        notification.close();
      }

      active.clear();
      shownByThread.clear();
    },
  };
}

export function startDesktopNotifications(
  args: DesktopNotificationOptions & {
    serverUrl: string;
    clientId: string;
    fetchImpl: typeof fetch;
    getCookie(): Promise<string>;
    readPresence(): DesktopPresence;
  },
) {
  const delivery = createDesktopNotificationDelivery(args);
  const realtimeUrl = new URL("/ws", args.serverUrl);
  realtimeUrl.protocol = realtimeUrl.protocol === "https:" ? "wss:" : "ws:";
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatDeadline: ReturnType<typeof setTimeout> | null = null;
  let refreshing: Promise<Set<string>> | null = null;
  let refreshRequested = false;
  let presenceSupported = true;
  let presenceFailing = false;

  async function rpc(method: string, input: object): Promise<unknown> {
    const response = await args.fetchImpl(
      new URL(
        `/api/v1/plugins/push-notifications/rpc/${method}`,
        args.serverUrl,
      ).href,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(10_000),
      },
    );

    if (method === "presence.report" && response.status === 404)
      throw new DesktopPresenceUnsupportedError(
        "The server does not accept presence reports",
      );

    if (
      method === "notifications.pending" &&
      (response.status === 404 || response.status === 503)
    )
      throw new DesktopNotificationsUnavailableError(
        "Desktop notifications are unavailable",
      );

    if (!response.ok)
      throw new Error(
        `Desktop notification ${method} failed (${response.status})`,
      );

    return response.json();
  }

  function refresh(): Promise<Set<string>> {
    if (stopped) return Promise.resolve(new Set());
    refreshRequested = true;

    if (refreshing) return refreshing;
    refreshing = (async () => {
      const acknowledged = new Set<string>();

      while (refreshRequested && !stopped) {
        refreshRequested = false;

        const { result } = pendingSchema.parse(
          await rpc("notifications.pending", { channel: "desktop" }),
        );

        for (const message of result.messages) {
          if (stopped) return acknowledged;
          await delivery.deliver(message);
        }

        for (const id of delivery.acceptedIds()) {
          if (stopped) return acknowledged;
          acknowledgmentSchema.parse(
            await rpc("notifications.ack", {
              id,
              clientId: args.clientId,
              channel: "desktop",
            }),
          );
          delivery.acknowledge(id);
          acknowledged.add(id);
        }
      }

      return acknowledged;
    })().finally(() => {
      refreshing = null;
    });

    return refreshing;
  }

  function requestRefresh(): void {
    void refresh().catch((error: unknown) => {
      if (stopped) return;
      args.onError(error);

      if (error instanceof DesktopNotificationsUnavailableError) return;
      socket?.close();
    });
  }

  function reportPresence(presence: DesktopPresence = args.readPresence()) {
    if (stopped || !presenceSupported) return;

    void rpc("presence.report", { clientId: args.clientId, ...presence })
      .then((result) => {
        presenceAcknowledgmentSchema.parse(result);
        presenceFailing = false;
      })
      .catch((error: unknown) => {
        if (stopped) return;

        if (error instanceof DesktopPresenceUnsupportedError) {
          presenceSupported = false;

          return;
        }

        if (!presenceFailing) args.onError(error);
        presenceFailing = true;
      });
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);

    if (heartbeatDeadline !== null) clearTimeout(heartbeatDeadline);
    heartbeatTimer = null;
    heartbeatDeadline = null;
  }

  function reconnect(): void {
    clearHeartbeat();

    if (stopped || reconnectTimer !== null) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 1_000);
  }

  async function connect(): Promise<void> {
    try {
      const cookie = await args.getCookie();

      if (stopped) return;

      const next = new WebSocket(realtimeUrl, {
        headers: { origin: new URL(args.serverUrl).origin, cookie },
        handshakeTimeout: 10_000,
      });

      socket = next;
      next.on("open", () => {
        presenceSupported = true;
        next.send(
          JSON.stringify({
            type: "subscribe",
            target: { kind: "thread-list" },
          }),
        );
        requestRefresh();
        reportPresence();
        heartbeatTimer = setInterval(() => {
          reportPresence();

          if (heartbeatDeadline !== null || next.readyState !== WebSocket.OPEN)
            return;
          next.send(JSON.stringify({ type: "ping" }));
          heartbeatDeadline = setTimeout(() => next.close(), 10_000);
        }, 30_000);
      });
      next.on("message", (data) => {
        if (stopped) return;

        if (heartbeatDeadline !== null) clearTimeout(heartbeatDeadline);
        heartbeatDeadline = null;

        try {
          const message: unknown = JSON.parse(data.toString());

          const signal = notificationSignalSchema.safeParse(message);

          const pluginChange = pluginChangeSchema.safeParse(message);

          const threadRead = threadReadSchema.safeParse(message);

          if (
            threadRead.success &&
            threadRead.data.changes.includes("read-state-changed")
          )
            delivery.withdrawThread(threadRead.data.id);

          if (
            signal.success ||
            (pluginChange.success &&
              pluginChange.data.changes.includes("plugins-changed"))
          )
            requestRefresh();
        } catch {
          args.onError(new Error("Invalid notification socket message"));
        }
      });
      next.on("close", reconnect);
      next.on("error", (error) => {
        if (!stopped) args.onError(error);
        next.close();
      });
    } catch (error) {
      if (!stopped) args.onError(error);
      reconnect();
    }
  }

  void connect();

  return {
    refresh: requestRefresh,
    reportPresence,
    async deliver(id: string): Promise<boolean> {
      return (await refresh()).has(id);
    },
    stop(): void {
      stopped = true;
      clearHeartbeat();

      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      socket?.close();
      delivery.stop();
    },
  };
}

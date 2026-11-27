import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useAppNavigate,
  experimental_useAppContext,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
} from "@omnyo/plugin-sdk/app";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  type pushNotificationsRpcContract,
} from "./contract.js";
import {
  clientChannel,
  createClientDelivery,
  NotificationStateMigrationErrorV1,
  notificationPermission,
} from "./client.js";
import { NotificationIcon } from "./notification-icons.js";
import { notificationsThreadAction } from "./notificationsAction.js";
import {
  chatNoticeReducer,
  EMPTY_CHAT_NOTICE_STACK,
  type ChatNoticeAction,
} from "./chat-notice-model.js";
import { ChatNotices } from "./chat-notices.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  NotificationDeviceSettingsView,
  type NotificationSettingsMessage,
} from "./device-settings.js";

function NotificationDelivery() {
  const navigate = experimental_useAppNavigate();
  const { threadId } = experimental_useAppContext();
  const currentThread = useRef(threadId);
  currentThread.current = threadId;

  const [migrationError, setMigrationError] = useState<string | null>(null);

  const [notices, dispatch] = useReducer(
    chatNoticeReducer,
    EMPTY_CHAT_NOTICE_STACK,
  );

  const send = useCallback(
    (action: ChatNoticeAction) => dispatch({ action, now: Date.now() }),
    [],
  );

  const rpc = useRpc<typeof pushNotificationsRpcContract>();
  const { values } = useSettings();
  const webEnabled = values?.webEnabled === true;
  const desktopEnabled = values?.desktopEnabled === true;
  const connection = useRealtimeConnectionState();

  const receive = useRef<(payload: unknown) => Promise<void>>(
    async () => undefined,
  );

  const drain = useRef<() => Promise<void>>(async () => undefined);
  useEffect(() => {
    const next = createClientDelivery(
      (id) => navigate.toThread(id),
      (message) => {
        if (message.threadId === null) return false;

        if (message.threadId === currentThread.current) return true;

        if (message.kind === "turn-finished") return false;
        send({
          type: "receive",
          notice: {
            id: message.id,
            threadId: message.threadId,
            title: message.title,
            body: message.body,
          },
        });

        return true;
      },
    );

    let disposed = false;
    let draining = false;
    let requested = false;
    const identity = next.prepare();
    setMigrationError(null);
    void identity.catch(() => {
      if (!disposed) {
        next.dispose();
        setMigrationError(
          "Notifications are paused because saved device state needs review.",
        );
      }
    });

    const accept = async (payload: unknown): Promise<void> => {
      const clientId = await identity;

      if (disposed) return;
      const channel = clientChannel();

      let result: Awaited<ReturnType<typeof next.deliver>>;

      try {
        result = await next.deliver(
          payload,
          channel === "web" ? webEnabled : desktopEnabled,
        );
      } catch (error) {
        if (!disposed && error instanceof NotificationStateMigrationErrorV1)
          setMigrationError(
            "Notifications are paused because saved device state needs review.",
          );
        throw error;
      }

      if (result.status === "renderer" && !disposed)
        await rpc.call("notifications.ack", {
          id: result.id,
          clientId,
          channel: result.channel,
        });
    };

    receive.current = accept;

    const flush = async (): Promise<void> => {
      if (disposed) return;
      await identity;

      if (disposed) return;

      if (draining) {
        requested = true;

        return;
      }

      draining = true;

      try {
        const channel = clientChannel();

        if (channel === null || disposed) return;

        const { messages } = await rpc.call("notifications.pending", {
          channel,
        });

        for (const message of messages) {
          if (disposed) return;

          await accept(message);
        }
      } finally {
        draining = false;

        if (requested && !disposed) {
          requested = false;
          void flush().catch(() => undefined);
        }
      }
    };

    drain.current = flush;

    const refresh = () => {
      void flush().catch(() => undefined);
    };

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();

    return () => {
      disposed = true;
      drain.current = async () => undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      receive.current = async () => undefined;
      next.dispose();
    };
  }, [navigate, rpc, webEnabled, desktopEnabled, connection, send]);
  useRealtime(CLIENT_NOTIFICATION_CHANNEL, (payload) => {
    void receive
      .current(payload)
      .finally(() => drain.current())
      .catch(() => undefined);
  });

  return (
    <>
      {migrationError ? (
        <Alert variant="destructive" className="space-y-2">
          <Icon name="AlertCircle" />
          <AlertDescription>
            <p>{migrationError}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-2"
              onClick={() => window.location.reload()}
            >
              Reload Omnyo
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <ChatNotices stack={notices} send={send} openThreadId={threadId} />
    </>
  );
}

function NotificationSettings() {
  const rpc = useRpc<typeof pushNotificationsRpcContract>();
  const { values } = useSettings();
  const channel = clientChannel();
  const [permission, setPermission] = useState(notificationPermission);
  const [busy, setBusy] = useState(false);

  const [message, setMessage] = useState<NotificationSettingsMessage | null>(
    null,
  );

  useEffect(() => {
    const refresh = () => setPermission(notificationPermission());

    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);

    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  if (channel === null) return null;
  const enabled = values?.[`${channel}Enabled`] === true;

  async function requestPermission() {
    setBusy(true);
    setMessage(null);

    try {
      setPermission(await Notification.requestPermission());
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  async function testNotification() {
    if (channel === null) return;
    setBusy(true);
    setMessage(null);

    try {
      await rpc.call("notifications.test", { channel });
      setMessage({
        tone: "success",
        text: `Test sent to every ${channel === "desktop" ? "desktop app" : "browser"} that allows notifications.`,
      });
    } catch (error) {
      setMessage({
        tone: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <NotificationDeviceSettingsView
      channel={channel}
      permission={permission}
      enabled={enabled}
      busy={busy}
      message={message}
      onAllow={() => void requestPermission()}
      onTest={() => void testNotification()}
    />
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({
    name: "push-notifications/ringing",
    component: NotificationIcon,
  });
  app.experimental_icons.register({
    name: "push-notifications/off",
    component: ({ className }) => (
      <NotificationIcon className={className} muted />
    ),
  });
  app.slots.experimental_appOverlay({
    id: "delivery",
    component: NotificationDelivery,
  });
  app.slots.settingsSection({ id: "device", component: NotificationSettings });
  app.slots.experimental_threadAction(notificationsThreadAction);
});

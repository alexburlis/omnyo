import { z } from "zod";
import type { ClientNotification } from "./contract.js";

const desktopBridgeSchema = z.object({
  platform: z.string().optional(),
  focusWindow: z.function().optional(),
});

const mobileBridgeSchema = z.object({}).passthrough();

function desktopBridge() {
  const parsed = desktopBridgeSchema.safeParse(
    "omnyoDesktop" in window ? window.omnyoDesktop : null,
  );

  return parsed.success ? parsed.data : null;
}

export type ClientChannel = "web" | "desktop";

export function clientChannel(): ClientChannel | null {
  if ("omnyoDesktop" in window) return "desktop";

  const mobile = mobileBridgeSchema.safeParse("omnyo" in window ? window.omnyo : null);

  if (mobile.success && "native" in mobile.data) return null;

  return "web";
}

export function notificationPermission(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

function readSeenIds(key: string): string[] {
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(localStorage.getItem(key) ?? "[]"));

    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function createClientDelivery(navigate: (threadId: string) => void) {
  const active = new Set<Notification>();
  let disposed = false;

  function display(message: ClientNotification): void {
    if (disposed || notificationPermission() !== "granted") return;

    const options: NotificationOptions = {
      body: message.body,
      tag: `omnyo-${message.threadId ?? message.id}`,
    };

    if (desktopBridge()?.platform !== "macos") {
      options.icon = new URL("/icon-192.png", window.location.origin).href;
    }

    const notification = new Notification(message.title, options);
    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();
      const bridge = desktopBridge();

      if (bridge?.platform === "linux") bridge.focusWindow?.();

      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };
  }

  async function deliver(message: ClientNotification, enabled: boolean): Promise<void> {
    const channel = clientChannel();

    if (
      !enabled ||
      disposed ||
      channel === null ||
      !message.channels.includes(channel) ||
      notificationPermission() !== "granted"
    )
      return;

    const claim = () => {
      if (disposed) return;
      const key = `omnyo.quiet-notifications.seen.${channel}`;
      const legacyKey = `bb.quiet-notifications.seen.${channel}`;
      const ids = [...new Set([...readSeenIds(legacyKey), ...readSeenIds(key)])];

      if (ids.includes(message.id)) return;

      display(message);

      try {
        localStorage.setItem(key, JSON.stringify([...ids.slice(-99), message.id]));
        localStorage.removeItem(legacyKey);
      } catch {
        return;
      }
    };

    if (navigator.locks) await navigator.locks.request(`omnyo-notifications-${channel}`, claim);
    else claim();
  }

  return {
    deliver,
    dispose() {
      disposed = true;

      for (const notification of active) notification.close();
      active.clear();
    },
  };
}

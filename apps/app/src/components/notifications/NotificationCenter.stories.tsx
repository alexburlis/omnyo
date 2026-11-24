import { useLayoutEffect } from "react";
import {
  openNotificationCenter,
  recordNotification,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { NotificationCenter } from "./NotificationCenter";

export default {
  title: "notifications/Notification center",
};

const MINUTE = 60_000;

function seedNotifications(): void {
  const now = Date.now();

  recordNotification({
    toastId: null,
    tone: "message",
    title: "Update ready",
    description:
      "Omnyo 0.46.20 is downloaded. Relaunch to finish installing it, or choose Later and relaunch from Settings → Updates when you’re ready.",
    actions: [],
    badge: true,
    createdAt: now - 42 * MINUTE,
  });
  recordNotification({
    toastId: null,
    tone: "error",
    title: "Couldn’t reach studio-mac",
    description:
      "The machine stopped answering. Chats on it resume when it reconnects.",
    actions: [],
    badge: true,
    createdAt: now - 18 * MINUTE,
  });
  recordNotification({
    toastId: null,
    tone: "warning",
    title: "Provider CLI update paused",
    description: "Two chats are still running on workstation.",
    actions: [],
    badge: true,
    createdAt: now - 6 * MINUTE,
  });
  recordNotification({
    toastId: null,
    tone: "success",
    title: "Chat archived",
    description: "Fix the login redirect",
    actions: [{ kind: "undo", label: "Undo", run: () => {} }],
    badge: true,
    createdAt: now - 2 * MINUTE,
  });
  recordNotification({
    toastId: null,
    tone: "message",
    title: "Weekly content feed finished",
    description: null,
    actions: [{ kind: "open", label: "Open chat", run: () => {} }],
    badge: true,
    createdAt: now - 20_000,
  });
}

function NotificationCenterStage({ seeded }: { seeded: boolean }) {
  useLayoutEffect(() => {
    resetNotificationStore();

    if (seeded) {
      seedNotifications();
    }

    openNotificationCenter();

    return () => resetNotificationStore();
  }, [seeded]);

  return (
    <div className="min-h-[640px]">
      <NotificationCenter />
    </div>
  );
}

export function WithNotifications() {
  return <NotificationCenterStage seeded />;
}

export function Empty() {
  return <NotificationCenterStage seeded={false} />;
}

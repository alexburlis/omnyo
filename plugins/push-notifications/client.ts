import {
  clientNotificationSchema,
  pushNotificationsRpcContract,
  type ClientNotification,
} from "./contract.js";

export type ClientChannel = "web" | "desktop";

export class NotificationStateMigrationErrorV1 extends Error {}

export function importLegacyNotificationStateV1(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  createId: () => string = () => crypto.randomUUID(),
): string {
  const identitySchema =
    pushNotificationsRpcContract["notifications.ack"].input.shape.clientId;

  const seenSchema = clientNotificationSchema.shape.id.array();

  const copies: {
    legacyKey: string;
    canonicalKey: string;
    legacy: string | null;
    canonical: string | null;
    value: string | null;
  }[] = [];

  function plan(
    legacyKey: string,
    canonicalKey: string,
    normalize: (raw: string) => string,
  ) {
    let legacy: string | null;
    let canonical: string | null;

    try {
      legacy = storage.getItem(legacyKey);
      canonical = storage.getItem(canonicalKey);
    } catch {
      throw new NotificationStateMigrationErrorV1(
        "Saved notification state could not be read.",
      );
    }

    let legacyValue: string | null;
    let canonicalValue: string | null;

    try {
      legacyValue = legacy === null ? null : normalize(legacy);
      canonicalValue = canonical === null ? null : normalize(canonical);
    } catch {
      throw new NotificationStateMigrationErrorV1(
        "Saved notification state is invalid. Existing data was preserved.",
      );
    }

    if (
      legacyValue !== null &&
      canonicalValue !== null &&
      legacyValue !== canonicalValue
    )
      throw new NotificationStateMigrationErrorV1(
        "Saved notification state conflicts. Existing data was preserved.",
      );

    const copy = {
      legacyKey,
      canonicalKey,
      legacy,
      canonical,
      value: canonical ?? legacy,
    };

    copies.push(copy);

    return copy;
  }

  const identity = plan(
    "bb.push-notifications.client-id",
    "omnyo.push-notifications.client-id",
    (raw) => identitySchema.parse(raw),
  );

  for (const channel of ["web", "desktop"])
    plan(
      `bb.push-notifications.seen.${channel}`,
      `omnyo.push-notifications.seen.${channel}`,
      (raw) => JSON.stringify(seenSchema.parse(JSON.parse(raw))),
    );

  const generated = identitySchema.safeParse(identity.value ?? createId());

  if (!generated.success)
    throw new NotificationStateMigrationErrorV1(
      "Notification identity could not be created.",
    );
  const clientId = generated.data;
  identity.value = clientId;

  try {
    for (const copy of copies)
      if (
        storage.getItem(copy.legacyKey) !== copy.legacy ||
        storage.getItem(copy.canonicalKey) !== copy.canonical
      )
        throw new Error("Saved notification state changed.");

    for (const copy of copies) {
      if (copy.value === null) continue;

      if (copy.canonical !== copy.value)
        storage.setItem(copy.canonicalKey, copy.value);

      if (storage.getItem(copy.canonicalKey) !== copy.value)
        throw new Error("Saved notification state changed.");
    }

    for (const copy of copies)
      if (
        storage.getItem(copy.legacyKey) !== copy.legacy ||
        storage.getItem(copy.canonicalKey) !== copy.value
      )
        throw new Error("Saved notification state changed.");

    for (const copy of copies) {
      if (copy.legacy === null) continue;

      if (
        storage.getItem(copy.legacyKey) !== copy.legacy ||
        storage.getItem(copy.canonicalKey) !== copy.value
      )
        throw new Error("Saved notification state changed.");
      storage.removeItem(copy.legacyKey);

      if (storage.getItem(copy.legacyKey) !== null)
        throw new Error("Saved notification state changed.");
    }
  } catch {
    throw new NotificationStateMigrationErrorV1(
      "Saved notification state could not be verified. Existing data was preserved.",
    );
  }

  return clientId;
}

export function clientChannel(): ClientChannel | null {
  if ("omnyoDesktop" in window) return "desktop";

  if (
    "omnyo" in window &&
    typeof window.omnyo === "object" &&
    window.omnyo !== null &&
    "native" in window.omnyo
  )
    return null;

  return "web";
}

export function notificationPermission():
  | NotificationPermission
  | "unsupported" {
  return typeof Notification === "undefined" || !window.isSecureContext
    ? "unsupported"
    : Notification.permission;
}

function nativeDesktopDelivery(): ((id: string) => Promise<boolean>) | null {
  if (
    clientChannel() === "desktop" &&
    "omnyoDesktopNotifications" in window &&
    typeof window.omnyoDesktopNotifications === "object" &&
    window.omnyoDesktopNotifications !== null &&
    "deliver" in window.omnyoDesktopNotifications &&
    typeof window.omnyoDesktopNotifications.deliver === "function"
  ) {
    const deliver = window.omnyoDesktopNotifications.deliver;

    return async (id) => (await deliver(id)) === true;
  }

  return null;
}

export type ClientDeliveryResult =
  | { status: "ignored" }
  | { status: "renderer"; id: string; channel: ClientChannel }
  | { status: "native" };

export function createClientDelivery(
  navigate: (threadId: string) => void,
  foreground?: (message: ClientNotification) => boolean,
) {
  const nativeDelivery = nativeDesktopDelivery();
  const active = new Set<Notification>();
  let disposed = false;
  let preparation: Promise<string> | null = null;

  function prepare(): Promise<string> {
    if (preparation === null)
      preparation = (async () => {
        const locks = navigator.locks;

        if (!locks || typeof locks.request !== "function")
          throw new NotificationStateMigrationErrorV1(
            "Notification storage ownership could not be verified.",
          );

        return locks.request("omnyo-notifications-web", () =>
          locks.request("omnyo-notifications-desktop", () => {
            if (disposed)
              throw new NotificationStateMigrationErrorV1(
                "Notification storage owner was disposed.",
              );

            return importLegacyNotificationStateV1(localStorage);
          }),
        );
      })();

    return preparation;
  }

  function display(message: ClientNotification): boolean {
    if (disposed || notificationPermission() !== "granted") return false;

    const isMacDesktop =
      "omnyoDesktop" in window &&
      typeof window.omnyoDesktop === "object" &&
      window.omnyoDesktop !== null &&
      "platform" in window.omnyoDesktop &&
      window.omnyoDesktop.platform === "macos";

    const notification = new Notification(message.title, {
      body: message.body,
      ...(isMacDesktop
        ? {}
        : { icon: new URL("/icon-192.png", window.location.origin).href }),
      tag: `omnyo-${message.threadId ?? message.id}`,
    });

    active.add(notification);
    notification.onclose = () => active.delete(notification);
    notification.onclick = () => {
      if (disposed) return;
      window.focus();

      if (
        "omnyoDesktop" in window &&
        typeof window.omnyoDesktop === "object" &&
        window.omnyoDesktop !== null &&
        "platform" in window.omnyoDesktop &&
        window.omnyoDesktop.platform === "linux" &&
        "focusWindow" in window.omnyoDesktop &&
        typeof window.omnyoDesktop.focusWindow === "function"
      ) {
        window.omnyoDesktop.focusWindow();
      }

      if (message.threadId !== null) navigate(message.threadId);
      notification.close();
      active.delete(notification);
    };

    return true;
  }

  async function deliver(
    payload: unknown,
    enabled: boolean,
  ): Promise<ClientDeliveryResult> {
    const parsed = clientNotificationSchema.safeParse(payload);
    const channel = clientChannel();

    if (
      !enabled ||
      disposed ||
      channel === null ||
      !parsed.success ||
      !parsed.data.channels.includes(channel)
    )
      return { status: "ignored" };
    await prepare();

    if (disposed) return { status: "ignored" };
    const message = parsed.data;
    const accepted = { status: "renderer", id: message.id, channel } as const;

    const claim = async (): Promise<ClientDeliveryResult> => {
      if (disposed) return { status: "ignored" };
      const key = `omnyo.push-notifications.seen.${channel}`;
      let ids: string[];

      try {
        ids = clientNotificationSchema.shape.id
          .array()
          .parse(JSON.parse(localStorage.getItem(key) ?? "[]"));
      } catch {
        throw new NotificationStateMigrationErrorV1(
          "Saved notification state is invalid. Existing data was preserved.",
        );
      }

      if (ids.includes(message.id)) return accepted;

      const shownInApp =
        message.threadId !== null &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        foreground?.(message) === true;

      if (!shownInApp) {
        if (notificationPermission() !== "granted")
          return { status: "ignored" };

        if (channel === "desktop" && nativeDelivery)
          return (await nativeDelivery(message.id))
            ? { status: "native" }
            : { status: "ignored" };

        if (!display(message)) return { status: "ignored" };
      }

      try {
        localStorage.setItem(
          key,
          JSON.stringify([...ids.slice(-99), message.id]),
        );
      } catch {
        return accepted;
      }

      return accepted;
    };

    return navigator.locks.request(`omnyo-notifications-${channel}`, claim);
  }

  return {
    prepare,
    deliver,
    dispose() {
      disposed = true;

      for (const notification of active) notification.close();
      active.clear();
    },
  };
}

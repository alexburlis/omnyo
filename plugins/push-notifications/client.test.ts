// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createClientDelivery,
  importLegacyNotificationStateV1,
} from "./client.js";

const originalNotificationLocks = Object.getOwnPropertyDescriptor(
  navigator,
  "locks",
);

function notificationLocksFixture() {
  const pending = new Map<string, Promise<unknown>>();

  return {
    request: vi.fn(
      <T>(name: string, callback: (lock: Lock) => T | PromiseLike<T>) => {
        const lock: Lock = { name, mode: "exclusive" };

        const operation = (pending.get(name) ?? Promise.resolve()).then(() =>
          callback(lock),
        );

        pending.set(
          name,
          operation.catch(() => undefined),
        );

        return operation;
      },
    ),
  };
}

function restoreNotificationLocks() {
  if (originalNotificationLocks === undefined)
    Reflect.deleteProperty(navigator, "locks");
  else Object.defineProperty(navigator, "locks", originalNotificationLocks);
}

class TestNotification {
  static permission: NotificationPermission = "granted";
  static instances: TestNotification[] = [];
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    TestNotification.instances.push(this);
  }
}

const message = {
  id: "event-1",
  title: "Finished",
  body: "Ready",
  threadId: "thread-1",
  channels: ["web"],
};

beforeEach(() => {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: notificationLocksFixture(),
  });
  TestNotification.permission = "granted";
  TestNotification.instances = [];
  localStorage.clear();
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
});

afterEach(() => {
  restoreNotificationLocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client system notifications", () => {
  it.each([
    { platform: "macos", icon: undefined },
    { platform: "linux", icon: "http://localhost:3000/icon-192.png" },
    { platform: "web", icon: "http://localhost:3000/icon-192.png" },
  ])(
    "uses the appropriate notification icon on $platform",
    async ({ platform, icon }) => {
      if (platform !== "web") vi.stubGlobal("omnyoDesktop", { platform });
      const delivery = createClientDelivery(vi.fn());
      await delivery.deliver(
        { ...message, channels: [platform === "web" ? "web" : "desktop"] },
        true,
      );
      expect(TestNotification.instances).toHaveLength(1);
      expect(TestNotification.instances[0]?.options.icon).toBe(icon);
      delivery.dispose();
    },
  );

  it.each([
    { platform: "linux", native: true },
    { platform: "macos", native: false },
    { platform: "web", native: false },
    { platform: "older-linux", native: false },
  ])(
    "focuses the notification window on $platform",
    async ({ platform, native }) => {
      const focusWindow = vi.fn();

      if (platform !== "web") {
        vi.stubGlobal(
          "omnyoDesktop",
          platform === "older-linux"
            ? { platform: "linux" }
            : { platform, focusWindow },
        );
      }

      const navigate = vi.fn();
      const delivery = createClientDelivery(navigate);
      await delivery.deliver(
        {
          ...message,
          channels: [platform === "web" ? "web" : "desktop"],
        },
        true,
      );
      expect(focusWindow).not.toHaveBeenCalled();
      const notification = TestNotification.instances[0]!;
      notification.onclick?.();
      expect(focusWindow).toHaveBeenCalledTimes(native ? 1 : 0);
      expect(window.focus).toHaveBeenCalledOnce();
      expect(navigate).toHaveBeenCalledWith(message.threadId);
      expect(notification.close).toHaveBeenCalled();
      delivery.dispose();
    },
  );

  it("deduplicates windows, navigates on click, and cleans up on disposal", async () => {
    const navigate = vi.fn();
    const first = createClientDelivery(navigate);
    const second = createClientDelivery(navigate);
    await first.deliver(message, true);
    await second.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(1);
    const notification = TestNotification.instances[0]!;
    expect(notification.options.body).toBe("Ready");
    notification.onclick?.();
    expect(window.focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("thread-1");
    await first.deliver({ ...message, id: "event-2" }, true);
    first.dispose();
    expect(TestNotification.instances[1]?.close).toHaveBeenCalled();
    await first.deliver({ ...message, id: "event-3" }, true);
    expect(TestNotification.instances).toHaveLength(2);
    second.dispose();
  });

  it("respects channel, permission, disabled state, and malformed input", async () => {
    const delivery = createClientDelivery(vi.fn());
    await delivery.deliver(message, false);
    await delivery.deliver({ ...message, channels: ["desktop"] }, true);
    await delivery.deliver({ ...message, threadId: 3 }, true);
    TestNotification.permission = "denied";
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal("omnyoDesktop", {});
    TestNotification.permission = "granted";
    await delivery.deliver(message, true);
    await delivery.deliver({ ...message, channels: ["desktop"] }, true);
    expect(TestNotification.instances).toHaveLength(1);
    delivery.dispose();
  });

  it("does not deliver in the mobile WebView or invent an unpersisted identity", async () => {
    const delivery = createClientDelivery(vi.fn());
    vi.stubGlobal("omnyo", { native: {} });
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal("omnyo", undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    await expect(delivery.deliver(message, true)).rejects.toThrow(
      "Saved notification state could not be verified",
    );
    expect(TestNotification.instances).toHaveLength(0);
    delivery.dispose();
  });
});

describe("durable notification acceptance", () => {
  it.each([true, false])(
    "preserves desktop acceptance %s without a competing renderer notification",
    async (accepted) => {
      vi.stubGlobal("omnyoDesktop", { platform: "macos" });
      const deliver = vi.fn(async () => accepted);
      vi.stubGlobal("omnyoDesktopNotifications", { deliver });
      const delivery = createClientDelivery(vi.fn());
      const desktopMessage = { ...message, channels: ["desktop"] };

      expect(await delivery.deliver(desktopMessage, true)).toEqual({
        status: accepted ? "native" : "ignored",
      });
      expect(deliver).toHaveBeenCalledWith(desktopMessage.id);
      expect(TestNotification.instances).toHaveLength(0);
      delivery.dispose();
    },
  );

  it("reports false until the existing Notification API accepts, then deduplicates", async () => {
    const delivery = createClientDelivery(vi.fn());
    expect(await delivery.deliver(message, false)).toEqual({
      status: "ignored",
    });
    TestNotification.permission = "denied";
    expect(await delivery.deliver(message, true)).toEqual({
      status: "ignored",
    });
    TestNotification.permission = "granted";
    expect(await delivery.deliver(message, true)).toMatchObject({
      status: "renderer",
      id: message.id,
    });
    expect(await delivery.deliver(message, true)).toMatchObject({
      status: "renderer",
      id: message.id,
    });
    expect(TestNotification.instances).toHaveLength(1);
    delivery.dispose();
    expect(await delivery.deliver({ ...message, id: "later" }, true)).toEqual({
      status: "ignored",
    });
  });

  it("does not claim acceptance when the Notification constructor fails", async () => {
    vi.stubGlobal(
      "Notification",
      class {
        static permission = "granted";
        constructor() {
          throw new Error("OS API refused");
        }
      },
    );
    const delivery = createClientDelivery(vi.fn());
    await expect(delivery.deliver(message, true)).rejects.toThrow(
      "OS API refused",
    );
    expect(
      localStorage.getItem("omnyo.push-notifications.seen.web"),
    ).toBeNull();
    delivery.dispose();
  });
});

describe("foreground chat notification delivery", () => {
  it.each(["denied", "unsupported"])(
    "accepts once in the focused app with %s OS permission and preserves channel guards",
    async (permission) => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");

      if (permission === "unsupported")
        vi.stubGlobal("Notification", undefined);
      else TestNotification.permission = "denied";

      const foreground = vi.fn(() => true);
      const delivery = createClientDelivery(vi.fn(), foreground);
      expect(await delivery.deliver(message, false)).toEqual({
        status: "ignored",
      });
      expect(
        await delivery.deliver({ ...message, channels: ["desktop"] }, true),
      ).toEqual({ status: "ignored" });
      expect(await delivery.deliver(message, true)).toEqual({
        status: "renderer",
        id: message.id,
        channel: "web",
      });
      expect(await delivery.deliver(message, true)).toMatchObject({
        status: "renderer",
      });
      expect(foreground).toHaveBeenCalledOnce();
      expect(TestNotification.instances).toHaveLength(0);
      delivery.dispose();
    },
  );

  it("routes foreground desktop acceptance to renderer acknowledgment and delegates background delivery", async () => {
    vi.stubGlobal("omnyoDesktop", { platform: "macos" });
    const native = vi.fn(async () => true);
    vi.stubGlobal("omnyoDesktopNotifications", { deliver: native });
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const foreground = vi.fn(() => true);
    const delivery = createClientDelivery(vi.fn(), foreground);
    const desktop = { ...message, channels: ["desktop"] };
    expect(await delivery.deliver(desktop, true)).toMatchObject({
      status: "renderer",
      id: message.id,
    });
    expect(native).not.toHaveBeenCalled();
    focus.mockReturnValue(false);
    expect(
      await delivery.deliver({ ...desktop, id: "background" }, true),
    ).toEqual({ status: "native" });
    expect(native).toHaveBeenCalledWith("background");
    expect(foreground).toHaveBeenCalledOnce();
    delivery.dispose();
  });
});

describe("legacy notification browser state V1", () => {
  const legacyKey = "bb.push-notifications.client-id";
  const canonicalKey = "omnyo.push-notifications.client-id";

  it("imports the exact legacy ID without allocating or rewriting unrelated state", () => {
    localStorage.setItem(legacyKey, "preserved-client-id");
    localStorage.setItem("opaque.user.state", "untouched bytes");
    const createId = vi.fn(() => "new-client-id");
    const write = vi.spyOn(Storage.prototype, "setItem");

    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
    expect(write).toHaveBeenCalledExactlyOnceWith(
      canonicalKey,
      "preserved-client-id",
    );
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(localStorage.getItem("opaque.user.state")).toBe("untouched bytes");
    expect(createId).not.toHaveBeenCalled();
  });

  it("keeps an existing canonical ID without a legacy write or new allocation", () => {
    localStorage.setItem(canonicalKey, "canonical-client-id");
    const createId = vi.fn(() => "unused-client-id");
    const write = vi.spyOn(Storage.prototype, "setItem");

    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "canonical-client-id",
    );
    expect(write).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(createId).not.toHaveBeenCalled();
  });

  it("accepts equal dual IDs and refuses a collision before any write", () => {
    localStorage.setItem(legacyKey, "stable-client-id");
    localStorage.setItem(canonicalKey, "stable-client-id");
    const createId = vi.fn(() => "unused-client-id");
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "stable-client-id",
    );
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    localStorage.setItem(legacyKey, "stable-client-id");
    localStorage.setItem(canonicalKey, "different-client-id");
    const collisionWrite = vi.spyOn(Storage.prototype, "setItem");

    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state conflicts");
    expect(collisionWrite).not.toHaveBeenCalled();
    expect(localStorage.getItem(legacyKey)).toBe("stable-client-id");
    expect(localStorage.getItem(canonicalKey)).toBe("different-client-id");
    expect(createId).not.toHaveBeenCalled();
  });

  it.each([
    { key: legacyKey, raw: "" },
    { key: canonicalKey, raw: "" },
    { key: legacyKey, raw: "x".repeat(129) },
    { key: canonicalKey, raw: "x".repeat(129) },
  ])("refuses invalid stored identity at $key", ({ key, raw }) => {
    localStorage.setItem(key, raw);
    const createId = vi.fn(() => "unused-client-id");
    const write = vi.spyOn(Storage.prototype, "setItem");

    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state is invalid");
    expect(localStorage.getItem(key)).toBe(raw);
    expect(write).not.toHaveBeenCalled();
    expect(createId).not.toHaveBeenCalled();
  });

  it("leaves the old ID intact when a quota failure prevents its verified copy", () => {
    localStorage.setItem(legacyKey, "preserved-client-id");
    const createId = vi.fn(() => "unused-client-id");

    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("Quota", "QuotaExceededError");
      });

    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state could not be verified");
    expect(localStorage.getItem(legacyKey)).toBe("preserved-client-id");
    expect(localStorage.getItem(canonicalKey)).toBeNull();
    expect(createId).not.toHaveBeenCalled();
    write.mockRestore();
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
  });

  it("refuses an unverified write instead of creating an ephemeral identity", () => {
    localStorage.setItem(legacyKey, "preserved-client-id");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => undefined);
    const createId = vi.fn(() => "unused-client-id");

    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state could not be verified");
    expect(localStorage.getItem(legacyKey)).toBe("preserved-client-id");
    expect(localStorage.getItem(canonicalKey)).toBeNull();
    expect(createId).not.toHaveBeenCalled();
  });

  it("detects a source change during copy without overwriting either surviving value", () => {
    localStorage.setItem(legacyKey, "preserved-client-id");
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (this: Storage, key, value) {
        original.call(this, key, value);

        if (key === canonicalKey)
          original.call(this, legacyKey, "changed-source-id");
      },
    );

    expect(() => importLegacyNotificationStateV1(localStorage)).toThrow(
      "Saved notification state could not be verified",
    );
    expect(localStorage.getItem(legacyKey)).toBe("changed-source-id");
    expect(localStorage.getItem(canonicalKey)).toBe("preserved-client-id");
  });

  it("creates and reuses only the canonical key on an empty profile", () => {
    const createId = vi.fn(() => "new-client-id");
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "new-client-id",
    );
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "new-client-id",
    );
    expect(localStorage.getItem(canonicalKey)).toBe("new-client-id");
    expect(localStorage.getItem(legacyKey)).toBeNull();
    expect(createId).toHaveBeenCalledOnce();
  });
});

describe("canonical notification ownership after admitted realm drain", () => {
  it("imports seen identities before delivery, removes only exact legacy keys and emits canonical tags", async () => {
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem(
      "bb.push-notifications.seen.web",
      JSON.stringify([message.id]),
    );
    localStorage.setItem(
      "bb.push-notifications.seen.desktop",
      JSON.stringify(["desktop-event"]),
    );
    localStorage.setItem("opaque.user.preference", "unchanged");
    const delivery = createClientDelivery(vi.fn());
    expect(await delivery.prepare()).toBe("preserved-client-id");
    expect(await delivery.deliver(message, true)).toMatchObject({
      status: "renderer",
      id: message.id,
    });
    expect(TestNotification.instances).toHaveLength(0);
    await delivery.deliver({ ...message, id: "new-event" }, true);
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0]?.options.tag).toBe("omnyo-thread-1");
    expect(
      JSON.parse(
        localStorage.getItem("omnyo.push-notifications.seen.web") ?? "null",
      ),
    ).toEqual([message.id, "new-event"]);
    expect(localStorage.getItem("omnyo.push-notifications.seen.desktop")).toBe(
      JSON.stringify(["desktop-event"]),
    );

    for (const suffix of ["client-id", "seen.web", "seen.desktop"])
      expect(
        localStorage.getItem("bb.push-notifications." + suffix),
      ).toBeNull();
    expect(localStorage.getItem("opaque.user.preference")).toBe("unchanged");
    delivery.dispose();
  });

  it.each(["broken-json", "[1]", '[""]'])(
    "refuses invalid seen input %s before any identity write",
    (raw) => {
      localStorage.setItem(
        "bb.push-notifications.client-id",
        "preserved-client-id",
      );
      localStorage.setItem("bb.push-notifications.seen.web", raw);
      const createId = vi.fn(() => "unused-id");
      const write = vi.spyOn(Storage.prototype, "setItem");
      expect(() =>
        importLegacyNotificationStateV1(localStorage, createId),
      ).toThrow("Saved notification state is invalid");
      expect(write).not.toHaveBeenCalled();
      expect(createId).not.toHaveBeenCalled();
      expect(localStorage.getItem("bb.push-notifications.client-id")).toBe(
        "preserved-client-id",
      );
      expect(localStorage.getItem("bb.push-notifications.seen.web")).toBe(raw);
    },
  );

  it("refuses a seen collision before moving the ID or choosing a winner", () => {
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem("bb.push-notifications.seen.web", '["old-event"]');
    localStorage.setItem(
      "omnyo.push-notifications.seen.web",
      '["different-event"]',
    );
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(() => importLegacyNotificationStateV1(localStorage)).toThrow(
      "Saved notification state conflicts",
    );
    expect(write).not.toHaveBeenCalled();
    expect(
      localStorage.getItem("omnyo.push-notifications.client-id"),
    ).toBeNull();
    expect(localStorage.getItem("bb.push-notifications.client-id")).toBe(
      "preserved-client-id",
    );
  });

  it("preserves all old inputs through interrupted copy and resumes without allocating a new ID", () => {
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem("bb.push-notifications.seen.web", '["web-event"]');
    localStorage.setItem(
      "bb.push-notifications.seen.desktop",
      '["desktop-event"]',
    );
    const original = Storage.prototype.setItem;

    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key, value) {
        if (key === "omnyo.push-notifications.seen.desktop")
          throw new DOMException("Quota", "QuotaExceededError");
        original.call(this, key, value);
      });

    const createId = vi.fn(() => "unused-id");
    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state could not be verified");
    expect(localStorage.getItem("bb.push-notifications.client-id")).toBe(
      "preserved-client-id",
    );
    expect(localStorage.getItem("bb.push-notifications.seen.web")).toBe(
      '["web-event"]',
    );
    expect(localStorage.getItem("bb.push-notifications.seen.desktop")).toBe(
      '["desktop-event"]',
    );
    write.mockRestore();
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
    expect(createId).not.toHaveBeenCalled();
  });

  it("detects an earlier destination changing during copy before retiring any old input", () => {
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem("bb.push-notifications.seen.web", '["web-event"]');
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(
      function (this: Storage, key, value) {
        original.call(this, key, value);

        if (key === "omnyo.push-notifications.seen.web")
          original.call(
            this,
            "omnyo.push-notifications.client-id",
            "foreign-client-id",
          );
      },
    );
    expect(() => importLegacyNotificationStateV1(localStorage)).toThrow(
      "Saved notification state could not be verified",
    );
    expect(localStorage.getItem("bb.push-notifications.client-id")).toBe(
      "preserved-client-id",
    );
    expect(localStorage.getItem("bb.push-notifications.seen.web")).toBe(
      '["web-event"]',
    );
    expect(localStorage.getItem("omnyo.push-notifications.client-id")).toBe(
      "foreign-client-id",
    );
  });

  it("resumes interrupted legacy retirement from verified canonical copies", () => {
    localStorage.setItem(
      "bb.push-notifications.client-id",
      "preserved-client-id",
    );
    localStorage.setItem("bb.push-notifications.seen.web", '["web-event"]');
    const original = Storage.prototype.removeItem;

    const remove = vi
      .spyOn(Storage.prototype, "removeItem")
      .mockImplementation(function (this: Storage, key) {
        if (key === "bb.push-notifications.seen.web")
          throw new DOMException("Denied", "SecurityError");
        original.call(this, key);
      });

    const createId = vi.fn(() => "unused-id");
    expect(() =>
      importLegacyNotificationStateV1(localStorage, createId),
    ).toThrow("Saved notification state could not be verified");
    expect(localStorage.getItem("bb.push-notifications.client-id")).toBeNull();
    expect(localStorage.getItem("omnyo.push-notifications.client-id")).toBe(
      "preserved-client-id",
    );
    expect(localStorage.getItem("bb.push-notifications.seen.web")).toBe(
      '["web-event"]',
    );
    expect(localStorage.getItem("omnyo.push-notifications.seen.web")).toBe(
      '["web-event"]',
    );
    remove.mockRestore();
    expect(importLegacyNotificationStateV1(localStorage, createId)).toBe(
      "preserved-client-id",
    );
    expect(localStorage.getItem("bb.push-notifications.seen.web")).toBeNull();
    expect(createId).not.toHaveBeenCalled();
  });

  it("uses one canonical owner across concurrent windows without an old-lock alias", async () => {
    const createId = vi
      .spyOn(crypto, "randomUUID")
      .mockReturnValue("c87a56d4-bae9-4869-aeca-1fe88b61601d");

    const first = createClientDelivery(vi.fn());
    const second = createClientDelivery(vi.fn());

    const results = await Promise.all([
      first.prepare(),
      second.prepare(),
      first.deliver(message, true),
      second.deliver(message, true),
    ]);

    expect(results.slice(0, 2)).toEqual([
      "c87a56d4-bae9-4869-aeca-1fe88b61601d",
      "c87a56d4-bae9-4869-aeca-1fe88b61601d",
    ]);
    expect(createId).toHaveBeenCalledOnce();
    expect(TestNotification.instances).toHaveLength(1);
    expect(
      vi
        .mocked(navigator.locks.request)
        .mock.calls.every(([name]) => name.startsWith("omnyo-notifications-")),
    ).toBe(true);
    first.dispose();
    second.dispose();
  });

  it("refuses absent lock ownership before any display", async () => {
    Object.defineProperty(navigator, "locks", {
      configurable: true,
      value: undefined,
    });
    const delivery = createClientDelivery(vi.fn());
    await expect(delivery.deliver(message, true)).rejects.toThrow(
      "Notification storage ownership could not be verified",
    );
    expect(TestNotification.instances).toHaveLength(0);
    expect(
      localStorage.getItem("omnyo.push-notifications.client-id"),
    ).toBeNull();
    delivery.dispose();
  });
});

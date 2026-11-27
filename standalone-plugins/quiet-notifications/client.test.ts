// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clientChannel, createClientDelivery } from "./client.js";
import type { ClientNotification } from "./contract.js";

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

const message: ClientNotification = {
  id: "event-1",
  title: "Finished",
  body: "Ready",
  threadId: "thread-1",
  channels: ["web"],
};

beforeEach(() => {
  TestNotification.permission = "granted";
  TestNotification.instances = [];
  localStorage.clear();
  vi.stubGlobal("Notification", TestNotification);
  vi.stubGlobal("isSecureContext", true);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("client system notifications", () => {
  it("recognizes canonical native globals", () => {
    vi.stubGlobal("omnyo", { native: {} });
    expect(clientChannel()).toBeNull();
    vi.stubGlobal("omnyo", undefined);
    vi.stubGlobal("omnyoDesktop", { platform: "macos" });
    expect(clientChannel()).toBe("desktop");
  });

  it.each([
    { platform: "macos", icon: undefined },
    { platform: "linux", icon: "http://localhost:3000/icon-192.png" },
    { platform: "web", icon: "http://localhost:3000/icon-192.png" },
  ])("uses the appropriate notification icon on $platform", async ({ platform, icon }) => {
    if (platform !== "web") vi.stubGlobal("omnyoDesktop", { platform });
    const delivery = createClientDelivery(vi.fn());
    await delivery.deliver(
      { ...message, channels: [platform === "web" ? "web" : "desktop"] },
      true,
    );
    expect(TestNotification.instances).toHaveLength(1);
    expect(TestNotification.instances[0]?.options.icon).toBe(icon);
    delivery.dispose();
  });

  it.each([
    { platform: "linux", native: true },
    { platform: "macos", native: false },
    { platform: "web", native: false },
    { platform: "older-linux", native: false },
  ])("focuses the notification window on $platform", async ({ platform, native }) => {
    const focusWindow = vi.fn();

    if (platform !== "web") {
      vi.stubGlobal(
        "omnyoDesktop",
        platform === "older-linux" ? { platform: "linux" } : { platform, focusWindow },
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
  });

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

  it("honors ids seen under the earlier key and records new ones under the current key", async () => {
    localStorage.setItem("bb.quiet-notifications.seen.web", JSON.stringify(["event-1"]));
    const delivery = createClientDelivery(vi.fn());
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    await delivery.deliver({ ...message, id: "event-2" }, true);
    expect(TestNotification.instances).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem("omnyo.quiet-notifications.seen.web") ?? "[]")).toEqual([
      "event-1",
      "event-2",
    ]);
    expect(localStorage.getItem("bb.quiet-notifications.seen.web")).toBeNull();
    delivery.dispose();
  });

  it.each(["not json", JSON.stringify({ ids: ["event-1"] })])(
    "ignores an invalid earlier seen list %s",
    async (stored) => {
      localStorage.setItem("bb.quiet-notifications.seen.web", stored);
      localStorage.setItem("omnyo.quiet-notifications.seen.web", JSON.stringify(["event-0"]));
      const delivery = createClientDelivery(vi.fn());
      await delivery.deliver(message, true);
      expect(TestNotification.instances).toHaveLength(1);
      expect(
        JSON.parse(localStorage.getItem("omnyo.quiet-notifications.seen.web") ?? "[]"),
      ).toEqual(["event-0", "event-1"]);
      delivery.dispose();
    },
  );

  it("respects channel, permission and disabled state", async () => {
    const delivery = createClientDelivery(vi.fn());
    await delivery.deliver(message, false);
    await delivery.deliver({ ...message, channels: ["desktop"] }, true);
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

  it("does not deliver in the mobile WebView and survives unavailable storage", async () => {
    const delivery = createClientDelivery(vi.fn());
    vi.stubGlobal("omnyo", { native: {} });
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(0);
    vi.stubGlobal("omnyo", undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Unavailable");
    });
    await delivery.deliver(message, true);
    expect(TestNotification.instances).toHaveLength(1);
    delivery.dispose();
  });
});

import { describe, expect, it, vi } from "vitest";
import { openDesktopNotificationThread } from "../src/desktop-notification-target.js";

function fixture() {
  return {
    serverUrl: "https://omnyo.example.com",
    threadId: "thread/one",
    window: {
      isMinimized: vi.fn(() => true),
      restore: vi.fn(),
      show: vi.fn(),
      focus: vi.fn(),
    },
    createWindow: vi.fn(async (_url: string) => {}),
    openThreadInWindow: vi.fn(
      async (_window: unknown, _threadId: string) => false,
    ),
    navigateWindow: vi.fn(async (_window: unknown, _url: string) => {}),
  };
}

describe("desktop notification target", () => {
  it("opens the chat inside a window that handles it, without reloading", async () => {
    const args = fixture();
    args.openThreadInWindow.mockResolvedValue(true);
    await openDesktopNotificationThread(args);
    expect(args.openThreadInWindow).toHaveBeenCalledExactlyOnceWith(
      args.window,
      "thread/one",
    );
    expect(args.navigateWindow).not.toHaveBeenCalled();
    expect(args.createWindow).not.toHaveBeenCalled();
    expect(args.window.focus).toHaveBeenCalledOnce();
  });

  it("restores the existing window and navigates it without creating another", async () => {
    const args = fixture();
    await openDesktopNotificationThread(args);
    expect(args.createWindow).not.toHaveBeenCalled();
    expect(args.navigateWindow).toHaveBeenCalledExactlyOnceWith(
      args.window,
      "https://omnyo.example.com/threads/thread%2Fone",
    );
    expect(args.window.restore).toHaveBeenCalledOnce();
    expect(args.window.show).toHaveBeenCalledOnce();
    expect(args.window.focus).toHaveBeenCalledOnce();
  });

  it("focuses a threadless notification without replacing the existing route", async () => {
    const args = fixture();
    args.window.isMinimized.mockReturnValue(false);
    await openDesktopNotificationThread({ ...args, threadId: null });
    expect(args.createWindow).not.toHaveBeenCalled();
    expect(args.navigateWindow).not.toHaveBeenCalled();
    expect(args.window.restore).not.toHaveBeenCalled();
    expect(args.window.focus).toHaveBeenCalledOnce();
  });

  it.each(["thread/one", null])(
    "opens a window when all application windows are closed: %s",
    async (threadId) => {
      const args = fixture();
      await openDesktopNotificationThread({ ...args, window: null, threadId });
      expect(args.createWindow).toHaveBeenCalledExactlyOnceWith(
        threadId === null
          ? "https://omnyo.example.com/"
          : "https://omnyo.example.com/threads/thread%2Fone",
      );
      expect(args.navigateWindow).not.toHaveBeenCalled();
    },
  );
});

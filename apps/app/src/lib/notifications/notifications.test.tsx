// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { AppToastContent, appToast } from "@/components/ui/app-toast";
import { createRecordingToast } from "./plugin-toast-recording";
import {
  closeNotificationCenter,
  getNotificationCenterState,
  getNotifications,
  openNotificationCenter,
  resetNotificationStore,
  useUnseenNotificationCount,
} from "./notification-store";

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetNotificationStore();
});

describe("toast history", () => {
  it("collapses a toast that is replaced by its result into one entry", () => {
    appToast.message("Installing…", { id: "install" });
    appToast.error("Install failed", {
      id: "install",
      description: 'Could not resolve "@radix-ui/react-tabs"',
    });

    expect(getNotifications()).toHaveLength(1);
    expect(getNotifications()[0]?.tone).toBe("error");
    expect(getNotifications()[0]?.description).toBe(
      'Could not resolve "@radix-ui/react-tabs"',
    );
  });

  it("records plugin toasts without breaking the wrapped sonner methods", () => {
    const base = Object.assign(vi.fn(), {
      error: vi.fn((message?: unknown, data?: unknown) => {
        void message;
        void data;

        return "error";
      }),
      dismiss: vi.fn(() => "dismiss"),
    });

    const recording = createRecordingToast(base);

    recording.error("Sandbox boot failed", { description: "exit code 1" });

    expect(getNotifications()[0]?.title).toBe("Sandbox boot failed");
    expect(base.error).toHaveBeenCalledWith("Sandbox boot failed", {
      description: "exit code 1",
    });
    expect(recording.dismiss()).toBe("dismiss");
  });

  it("keeps a plugin toast's action and refreshes it when the toast id repeats", () => {
    const recording = createRecordingToast(vi.fn());

    recording("Chat B finished", {
      id: "notice-b",
      action: { label: "Open chat", onClick: vi.fn() },
    });
    recording("Chat B needs your input", {
      id: "notice-b",
      description: "Waiting for your input",
      action: { label: "Answer", onClick: vi.fn() },
    });
    recording("Plugin reloaded");

    expect(getNotifications()).toEqual([
      expect.objectContaining({ title: "Plugin reloaded", actions: [] }),
      expect.objectContaining({
        title: "Chat B needs your input",
        description: "Waiting for your input",
        actions: [expect.objectContaining({ label: "Answer" })],
      }),
    ]);
  });
});

describe("unseen notifications", () => {
  it("counts notifications recorded since the centre was last opened", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() => useUnseenNotificationCount());

    act(() => {
      appToast.message("Plugin installed");
      appToast.message("Plugin enabled");
    });
    expect(result.current).toBe(2);

    now.mockReturnValue(2_000);
    act(() => {
      openNotificationCenter();
      closeNotificationCenter();
    });
    expect(result.current).toBe(0);
    expect(getNotifications()).toEqual([]);

    now.mockReturnValue(3_000);
    act(() => {
      appToast.message("Plugin updated");
    });
    expect(result.current).toBe(1);
  });

  it("lists confirmations of the user's own actions without counting them", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { result } = renderHook(() => useUnseenNotificationCount());

    const pluginToast = createRecordingToast(
      Object.assign(vi.fn(), { success: vi.fn() }),
    );

    act(() => {
      appToast.success("Thread archived", { undo: vi.fn() });
      pluginToast.success("Draft saved");
      appToast.message("Message queued", { badge: false });
    });
    expect(getNotifications()).toHaveLength(3);
    expect(result.current).toBe(0);

    act(() => {
      appToast.success("Updated Omnyo", { badge: true });
      appToast.error("Archive failed");
    });
    expect(result.current).toBe(2);
  });
});

describe("truncated toast descriptions", () => {
  function renderToast() {
    render(
      <AppToastContent
        title="Installing the plugin failed"
        description="a very long esbuild error"
        tone="error"
        notificationId="notification-7"
      />,
    );
  }

  function mockWidths(scrollWidth: number, clientWidth: number) {
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "app-toast-description"
          ? scrollWidth
          : clientWidth;
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
      clientWidth,
    );
  }

  it("offers Show more only when the description does not fit", () => {
    mockWidths(300, 300);
    renderToast();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();

    cleanup();
    mockWidths(600, 300);
    renderToast();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeNull();
  });

  it("offers full details when wrapped text exceeds the visible height", () => {
    mockWidths(300, 300);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "app-toast-description" ? 160 : 20;
      },
    );
    renderToast();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(getNotificationCenterState().focusedId).toBe("notification-7");
  });
});

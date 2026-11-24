// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AppToasterView } from "@/components/AppToasterView";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { NotificationCenter } from "@/components/notifications/NotificationCenter";
import { appToast } from "@/components/ui/app-toast";
import {
  getNotificationCenterState,
  getNotifications,
  openNotificationCenter,
  resetNotificationStore,
} from "./notification-store";
import { createRecordingToast } from "./plugin-toast-recording";

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandHandler: vi.fn(),
}));

afterEach(() => {
  cleanup();
  resetNotificationStore();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("runs a plugin toast's action from its row and closes the centre", async () => {
  vi.useFakeTimers();
  const openChat = vi.fn();
  const pluginToast = createRecordingToast(vi.fn());
  render(<NotificationCenter />);
  act(() => {
    pluginToast("Chat B finished", {
      id: "notice-b",
      duration: Infinity,
      action: { label: "Open chat", onClick: openChat },
    });
    pluginToast("Plugin reloaded");
    openNotificationCenter();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(screen.getAllByRole("button", { name: "Open chat" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
  expect(openChat).toHaveBeenCalledTimes(1);
  expect(getNotificationCenterState().open).toBe(false);
});

it("undoes a user's action from its row and keeps the centre open", async () => {
  vi.useFakeTimers();
  const undoArchive = vi.fn();
  render(<NotificationCenter />);
  act(() => {
    appToast.success("Thread archived", { undo: undoArchive });
    appToast.success("Shelved", { undo: vi.fn() });
    openNotificationCenter();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  const center = screen.getByTestId("notification-center");
  const [, archivedUndo] = screen.getAllByRole("button", { name: "Undo" });

  if (archivedUndo === undefined) throw new Error("Missing archive Undo");
  fireEvent.click(archivedUndo);
  expect(undoArchive).toHaveBeenCalledTimes(1);
  expect(center.textContent).not.toContain("Thread archived");
  expect(center.textContent).toContain("Shelved");
  expect(getNotificationCenterState().open).toBe(true);
});

it("drops the recorded undo once the toast's Undo runs", async () => {
  vi.useFakeTimers();
  const undoArchive = vi.fn();
  render(<AppToasterView />);
  act(() => {
    appToast.success("Message deleted", { undo: undoArchive });
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });

  const toast = screen
    .getByText("Message deleted")
    .closest<HTMLElement>("[data-app-toast-surface]");

  if (toast === null) throw new Error("Missing toast");
  fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
  expect(undoArchive).toHaveBeenCalledTimes(1);
  expect(getNotifications()).toEqual([]);
});

it("keeps notification details open when dismissing the toast restores composer focus", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(300);
  render(
    <>
      <textarea aria-label="Composer" />
      <AppToasterView />
      <NotificationCenter />
    </>,
  );
  const composer = screen.getByRole("textbox", { name: "Composer" });
  act(() => {
    composer.focus();
    appToast.error(
      "Cannot submit the thread because the workspace is occupied",
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(50);
  });
  const showMore = screen.getByRole("button", { name: "Show more" });
  act(() => {
    showMore.focus();
  });
  fireEvent.click(showMore);
  expect(getNotificationCenterState().open).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(document.querySelector("[data-sonner-toast]")).toBeNull();
  expect(document.activeElement).toBe(composer);
  expect(getNotificationCenterState().open).toBe(true);
  expect(screen.getByTestId("notification-center").textContent).toContain(
    "Cannot submit the thread",
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(getNotificationCenterState().open).toBe(false);
});

it.each([false, true])(
  "requires manual close or Escape (compact: %s)",
  async (compact) => {
    vi.useFakeTimers();
    render(
      <CompactViewportOverrideProvider isCompactViewport={compact}>
        <button type="button">Outside</button>
        <NotificationCenter />
      </CompactViewportOverrideProvider>,
    );
    act(() => {
      openNotificationCenter();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    const outside = screen.getByRole("button", { name: "Outside" });
    const close = screen.getByRole("button", { name: "Hide notifications" });
    act(() => {
      close.focus();
    });
    act(() => {
      outside.focus();
    });
    expect(getNotificationCenterState().open).toBe(true);
    fireEvent(
      outside,
      new MouseEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    fireEvent.click(outside);

    if (compact) {
      const backdrop = document.querySelector(
        "[data-persistent-drawer-backdrop]",
      );

      if (!backdrop) throw new Error("Missing drawer backdrop");
      fireEvent.click(backdrop);
    }

    expect(getNotificationCenterState().open).toBe(true);
    fireEvent.click(close);
    expect(getNotificationCenterState().open).toBe(false);
    act(() => {
      openNotificationCenter();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(getNotificationCenterState().open).toBe(false);
  },
);

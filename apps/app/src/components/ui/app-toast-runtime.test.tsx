// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { toast, Toaster } from "sonner";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.resetModules();
});

it("settles failed attempts and retries only new notifications without replaying failed ones", async () => {
  const {
    attachSonnerToast,
    markToasterUnavailable,
    whenToasterSettled,
    withSonnerToast,
  } = await import("./app-toast-runtime");

  const failedNotification = vi.fn();
  const newNotification = vi.fn();
  const retry = vi.fn();

  withSonnerToast(failedNotification);
  const firstAttempt = whenToasterSettled();
  markToasterUnavailable(retry);
  await firstAttempt;
  expect(retry).not.toHaveBeenCalled();

  withSonnerToast(newNotification);
  expect(retry).toHaveBeenCalledOnce();
  const settled = vi.fn();
  const secondAttempt = whenToasterSettled().then(settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledOnce();

  attachSonnerToast(toast);
  await secondAttempt;
  expect(failedNotification).not.toHaveBeenCalled();
  expect(newNotification).toHaveBeenCalledExactlyOnceWith(toast);
});

it("discards each failed attempt instead of accumulating its notifications", async () => {
  const { attachSonnerToast, markToasterUnavailable, withSonnerToast } =
    await import("./app-toast-runtime");

  const failedNotifications = Array.from({ length: 10 }, () => vi.fn());
  const retry = vi.fn();

  for (const notification of failedNotifications) {
    withSonnerToast(notification);
    markToasterUnavailable(retry);
  }

  const finalNotification = vi.fn();
  withSonnerToast(finalNotification);
  attachSonnerToast(toast);
  expect(retry).toHaveBeenCalledTimes(10);

  for (const notification of failedNotifications) {
    expect(notification).not.toHaveBeenCalled();
  }

  expect(finalNotification).toHaveBeenCalledExactlyOnceWith(toast);
});

it("shows the latest early plugin toast after the host mounts, preserving its identity and dismissal", async () => {
  const { attachSonnerToast } = await import("./app-toast-runtime");
  const id = toast.loading("Plugin is starting", { id: "early-plugin" });
  expect(toast.success("Plugin is ready", { id })).toBe(id);
  toast("Discarded notification", { id: "discarded" });
  toast.dismiss("discarded");
  render(<Toaster />);

  act(() => attachSonnerToast(toast));

  expect(await screen.findByText("Plugin is ready")).toBeDefined();
  expect(screen.queryByText("Plugin is starting")).toBeNull();
  expect(screen.queryByText("Discarded notification")).toBeNull();
  expect(toast.getToasts().filter((entry) => entry.id === id)).toHaveLength(1);
});

it("preserves early custom toast content and does not replay on a later attachment", async () => {
  const { attachSonnerToast } = await import("./app-toast-runtime");
  const getToasts = vi.spyOn(toast, "getToasts");
  toast.custom((id) => (
    <button onClick={() => toast.dismiss(id)}>Review plugin result</button>
  ));
  render(<Toaster />);

  act(() => attachSonnerToast(toast));

  expect(
    await screen.findByRole("button", { name: "Review plugin result" }),
  ).toBeDefined();
  act(() => attachSonnerToast(toast));
  expect(getToasts).toHaveBeenCalledOnce();
});

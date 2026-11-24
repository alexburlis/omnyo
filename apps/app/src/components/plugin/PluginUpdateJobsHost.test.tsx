// @vitest-environment jsdom

import { MemoryRouter } from "react-router-dom";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginUpdateJob } from "@omnyo/server-contract";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginUpdateJobsQueryKey } from "@/hooks/queries/query-keys";
import { appToast } from "@/components/ui/app-toast";
import {
  getNotifications,
  resetNotificationStore,
} from "@/lib/notifications/notification-store";
import { PluginUpdateJobsHost } from "./PluginUpdateJobsHost";

const base = { id: "update-1", pluginId: "notes", displayName: "Notes" };

afterEach(() => {
  cleanup();
  resetNotificationStore();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount(jobs: PluginUpdateJob[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ jobs }))),
  );

  const harness = createQueryClientTestHarness({
    queries: { staleTime: Infinity },
  });

  harness.queryClient.setQueryData(pluginUpdateJobsQueryKey(), jobs);

  const view = render(
    <MemoryRouter>
      <PluginUpdateJobsHost />
    </MemoryRouter>,
    { wrapper: harness.wrapper },
  );

  return { ...view, ...harness };
}

it("records an update first seen after completion once in the bell panel", () => {
  const completed: PluginUpdateJob = {
    ...base,
    state: "completed",
    result: {
      applied: true,
      from: { version: "1.0.0", display: "1.0.0" },
      to: { version: "1.1.0", display: "1.1.0" },
      outcome: "updated",
    },
  };

  const first = mount([completed]);
  expect(getNotifications()).toEqual([
    expect.objectContaining({
      title: "Plugin updated",
      description: "Notes — 1.1.0",
      badge: true,
    }),
  ]);
  first.unmount();
  first.queryClient.clear();
  resetNotificationStore();

  const second = mount([completed]);
  expect(getNotifications()).toEqual([]);
  second.unmount();
  second.queryClient.clear();
});

it.each(["updated", "rolled-back"] as const)(
  "recovers a watched update after reload and reports %s once",
  async (outcome) => {
    const loading = vi.spyOn(appToast, "loading").mockReturnValue("toast");
    const success = vi.spyOn(appToast, "success").mockReturnValue("toast");
    const error = vi.spyOn(appToast, "error").mockReturnValue("toast");
    const first = mount([{ ...base, state: "running", phase: "checking" }]);
    expect(loading).toHaveBeenCalledWith(
      "Updating plugin…",
      expect.objectContaining({ id: "plugin-update:update-1" }),
    );
    first.unmount();
    first.queryClient.clear();

    const completed: PluginUpdateJob = {
      ...base,
      state: "completed",
      result: {
        applied: outcome === "updated",
        from: { version: "1", display: "1" },
        outcome,
      },
    };

    const second = mount([completed]);
    const toast = outcome === "updated" ? success : error;
    expect(toast).toHaveBeenCalledWith(
      outcome === "updated" ? "Plugin updated" : "Plugin update failed",
      expect.objectContaining({ id: "plugin-update:update-1" }),
    );
    await act(async () => {
      second.queryClient.setQueryData(pluginUpdateJobsQueryKey(), [completed]);
    });
    expect(toast).toHaveBeenCalledOnce();
    second.unmount();
    second.queryClient.clear();
  },
);

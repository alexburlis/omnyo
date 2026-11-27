import { act } from "react";
import { expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@omnyo/plugin-sdk/testing/app";
import { statusSchema } from "../contract";

it("loads only badge data in the global rail, keeps newer counts across delayed status, and exposes refresh errors", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find((entry) => entry.id === "sentry-icon-count");

  if (!overlay) throw new Error("Missing Sentry badge overlay");
  const target = document.createElement("span");
  target.dataset.navRailItem = "sentry/sentry";
  document.body.append(target);
  let statusCalls = 0;
  let badgeCalls = 0;
  let fail = false;
  const badge = { count: 3, watchedRoutes: 1, freshness: "live", lastSyncedAt: null };

  const fullStatus = statusSchema.parse({
    connected: false,
    syncing: false,
    apiOrigin: "https://fixture.invalid",
    lastError: null,
    routes: [],
    badge: { ...badge },
    projectPolicies: [],
    projectIssueCounts: [],
    batches: [],
    incidents: [],
    runs: [],
    syncs: [],
    notificationLimit: "",
  });

  let finishStatus: (value: typeof fullStatus) => void = () => {};

  const heldStatus = new Promise<typeof fullStatus>((resolve) => {
    finishStatus = resolve;
  });

  const options = {
    resourceScope: {},
    rpc: {
      badge: () => {
        badgeCalls++;

        if (fail) throw new Error("Offline");

        return badge;
      },
      targets: () => ({ projects: [], hosts: [] }),
      status: () => {
        statusCalls++;

        return heldStatus;
      },
    },
  };

  const slot = renderSlot(overlay, {}, options);

  try {
    await act(async () => {});
    await expect.poll(() => badgeCalls).toBe(1);
    expect(statusCalls).toBe(0);
    expect(target.querySelector(".sentry-rail-badge")?.textContent).toBe("3");
    const settings = app.settingsSections[0];

    if (!settings) throw new Error("Missing Sentry settings");
    const panel = renderSlot(settings, {}, options);

    try {
      await act(async () => {});
      await expect.poll(() => statusCalls).toBe(1);
      badge.count = 5;
      await slot.emitRealtime("changed", {});
      expect(target.querySelector(".sentry-rail-badge")?.textContent).toBe("5");
      await act(async () => finishStatus(fullStatus));
      expect(target.querySelector(".sentry-rail-badge")?.textContent).toBe("5");
      expect(panel.getByText("Not connected")).toBeDefined();
    } finally {
      panel.lifecycle.unmount();
    }

    fail = true;
    await slot.emitRealtime("changed", {});
    expect(target.querySelector(".sentry-rail-badge")?.getAttribute("data-freshness")).toBe(
      "stale",
    );
    expect(target.querySelector(".sentry-rail-badge")?.textContent).toBe("5");
    expect(statusCalls).toBe(1);
  } finally {
    slot.lifecycle.unmount();
    target.remove();
  }
});

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
  renderSlot,
} from "@omnyo/plugin-sdk/testing/app";
import type { z } from "zod";
import type { callbackStatusSchema, CoordinatorCallbackStatus } from "../contract";

type CallbackStatus = z.infer<typeof callbackStatusSchema>;

const queued: CoordinatorCallbackStatus = {
  threadId: "thr_coordinator",
  batchId: "batch_native",
  state: "queued",
  packageCount: 2,
  queued: 2,
  running: 0,
  reason: "The native Sentry queue owns completion.",
};

afterEach(cleanup);

async function setup(call: () => CallbackStatus | Promise<CallbackStatus>) {
  const app = await loadPluginApp(() => import("../app"));
  const overlay = app.appOverlays.find(({ id }) => id === "sentry-native-callback-status");

  const banner = app.composerCustomizations
    .find(({ id }) => id === "sentry-native-callback")
    ?.banners?.find(({ id }) => id === "sentry-native-callback");

  expect(overlay, "native Sentry waits must register an app-wide status bridge").toBeDefined();
  expect(banner, "the coordinator composer must explain its actual native wait").toBeDefined();

  const scripts = await mountPluginContentScripts(app, { pluginId: "sentry" });
  const bridge = renderSlot(overlay!, {}, { rpc: { "callback.status": call } });

  const footer = renderSlot(
    banner!,
    {},
    {
      composer: { scope: { kind: "thread", threadId: queued.threadId } },
    },
  );

  return { app, scripts, bridge, footer };
}

describe("native Sentry callback display", () => {
  it("marks a queued package before its worker chat exists, follows package progress, and clears on completion", async () => {
    let coordinators = [queued];
    const { scripts, bridge, footer } = await setup(() => ({ coordinators }));

    try {
      await waitFor(() =>
        expect(scripts.inspection.getThreadRowStatus(queued.threadId)).toMatchObject({
          icon: "Clock",
          label: expect.stringContaining("2 packages queued"),
        }),
      );
      expect(screen.getByRole("status").textContent).toContain("2 packages queued");
      expect(screen.getByRole("status").textContent).toContain(queued.reason);
      expect(bridge.inspection.rpcCalls).toEqual([{ method: "callback.status", input: null }]);

      coordinators = [{ ...queued, state: "running", queued: 1, running: 1 }];
      await bridge.behavior.emitRealtime("changed", { reason: "package-started" });
      await waitFor(() => expect(screen.getByRole("status").textContent).toContain("1 running"));
      expect(scripts.inspection.getThreadRowStatus(queued.threadId)?.label).toContain("1 queued");

      coordinators = [
        { ...queued, state: "blocked", queued: 0, reason: "A package needs owner recovery." },
      ];
      await bridge.behavior.emitRealtime("changed", { reason: "package-failed" });
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain("Sentry callback blocked"),
      );
      expect(scripts.inspection.getThreadRowStatus(queued.threadId)?.icon).toBe("CircleAlert");

      coordinators = [];
      await bridge.behavior.emitRealtime("changed", { reason: "batch-completed" });
      await waitFor(() =>
        expect(scripts.inspection.getThreadRowStatus(queued.threadId)).toBeNull(),
      );
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      bridge.lifecycle.unmount();
      footer.lifecycle.unmount();
      await scripts.lifecycle.dispose();
    }
  });

  it("reconciles a missed completion on reconnect, reports unavailable status, and ignores replies after unmount", async () => {
    let resolvePending!: (value: CallbackStatus) => void;
    let response: CallbackStatus | Promise<CallbackStatus> = { coordinators: [queued] };
    let fails = false;

    const { scripts, bridge, footer } = await setup(() => {
      if (fails) throw new Error("status transport unavailable");

      return response;
    });

    try {
      await waitFor(() =>
        expect(scripts.inspection.getThreadRowStatus(queued.threadId)?.icon).toBe("Clock"),
      );
      await bridge.behavior.setRealtimeConnectionState("reconnecting");
      response = { coordinators: [] };
      await bridge.behavior.setRealtimeConnectionState("connected");
      await waitFor(() =>
        expect(scripts.inspection.getThreadRowStatus(queued.threadId)).toBeNull(),
      );
      expect(screen.queryByRole("status")).toBeNull();

      response = { coordinators: [queued] };
      await bridge.behavior.emitRealtime("changed", {});
      await waitFor(() =>
        expect(scripts.inspection.getThreadRowStatus(queued.threadId)?.icon).toBe("Clock"),
      );
      fails = true;
      await bridge.behavior.emitRealtime("changed", {});
      await waitFor(() =>
        expect(screen.getByRole("status").textContent).toContain(
          "Sentry callback status unavailable",
        ),
      );
      expect(scripts.inspection.getThreadRowStatus(queued.threadId)?.icon).toBe("CircleAlert");

      fails = false;
      response = new Promise((resolve) => {
        resolvePending = resolve;
      });
      await bridge.behavior.emitRealtime("changed", {});
      bridge.lifecycle.unmount();
      expect(scripts.inspection.getThreadRowStatus(queued.threadId)).toBeNull();
      await act(async () => {
        resolvePending({ coordinators: [queued] });
      });
      expect(scripts.inspection.getThreadRowStatus(queued.threadId)).toBeNull();
      expect(screen.queryByRole("status")).toBeNull();
    } finally {
      bridge.lifecycle.unmount();
      footer.lifecycle.unmount();
      await scripts.lifecycle.dispose();
    }
  });
});

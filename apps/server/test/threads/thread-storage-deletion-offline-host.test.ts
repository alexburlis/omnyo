import { setTimeout as sleep } from "node:timers/promises";
import { getThread, markThreadDeleted } from "@omnyo/db";
import { describe, expect, it, vi } from "vitest";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHost,
  seedProjectWithSource,
  seedSession,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const SWEEPS_WHILE_DISCONNECTED = 3;

describe("thread storage deletion on a disconnected host", () => {
  it("waits for the host to reconnect instead of retrying on every sweep", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host_storage_offline" });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/storage-offline",
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/storage-offline",
      });

      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });

      markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

      const requestHostOnlineRpc = vi.spyOn(
        harness.hub,
        "requestHostOnlineRpc",
      );

      const warn = vi.spyOn(harness.deps.logger, "warn");

      const storageDeleteAttempts = () =>
        requestHostOnlineRpc.mock.calls.filter(
          ([args]) =>
            args.message.command.type === "thread.storage.delete" &&
            args.message.command.threadId === thread.id,
        ).length;

      const warningsFor = (message: string) =>
        warn.mock.calls.filter(([, logged]) => logged === message).length;

      for (let sweep = 0; sweep < SWEEPS_WHILE_DISCONNECTED; sweep += 1) {
        await runThreadLifecycleSweep(harness.deps);
        await sleep(25);
      }

      expect(storageDeleteAttempts()).toBe(1);
      expect(
        warningsFor(
          "Thread storage deletion is waiting for its host to reconnect",
        ),
      ).toBe(1);
      expect(warningsFor("Thread storage deletion command failed")).toBe(0);
      expect(getThread(harness.db, thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });

      seedSession(harness.deps, host.id);
      await runThreadLifecycleSweep(harness.deps);

      const storageDelete = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.storage.delete" &&
          command.threadId === thread.id,
      );

      await reportQueuedCommandSuccess(harness, storageDelete, {
        providerCheckpointId: null,
      });

      expect(storageDeleteAttempts()).toBe(2);
      expect(getThread(harness.db, thread.id)).toBeNull();
    });
  });
});

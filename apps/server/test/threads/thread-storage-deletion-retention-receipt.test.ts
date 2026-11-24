import { setTimeout as sleep } from "node:timers/promises";
import { getThread, markThreadDeleted } from "@omnyo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import { THREAD_STORAGE_RETENTION_RETRY_MS } from "../../src/services/threads/thread-lifecycle.js";
import {
  reportQueuedCommandError,
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
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const RETENTION_RECEIPT_MESSAGE = "Thread storage has a retention receipt";

const SWEEPS_WITHIN_BACKOFF = 3;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.UTC(2026, 10, 9, 9));
});

afterEach(() => {
  vi.useRealTimers();
});

function seedDeletedThread(harness: TestAppHarness, hostId: string) {
  const host = seedHost(harness.deps, { id: hostId });
  seedSession(harness.deps, host.id);

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/${hostId}`,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/${hostId}`,
  });

  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "idle",
  });

  markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });

  const requestHostOnlineRpc = vi.spyOn(harness.hub, "requestHostOnlineRpc");
  const warn = vi.spyOn(harness.deps.logger, "warn");
  const info = vi.spyOn(harness.deps.logger, "info");

  const isStorageDelete = ({
    command,
  }: {
    command: { threadId?: string; type: string };
  }) =>
    command.type === "thread.storage.delete" && command.threadId === thread.id;

  return {
    attempts: () =>
      requestHostOnlineRpc.mock.calls.filter(([args]) =>
        isStorageDelete(args.message),
      ).length,
    infos: (message: string) =>
      info.mock.calls.filter(([, logged]) => logged === message).length,
    infoFields: (message: string) =>
      info.mock.calls.find(([, logged]) => logged === message)?.[0],
    nextStorageDelete: () => waitForQueuedCommand(harness, isStorageDelete),
    thread,
    warnings: (message: string) =>
      warn.mock.calls.filter(([, logged]) => logged === message).length,
  };
}

async function sweep(harness: TestAppHarness, times = 1) {
  for (let index = 0; index < times; index += 1) {
    await runThreadLifecycleSweep(harness.deps);
    await sleep(25);
  }
}

describe("thread storage deletion refused by a retention receipt", () => {
  it("logs the hold once and retries only after the backoff until the receipt is gone", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedDeletedThread(harness, "host_storage_retained");

      const refuse = async () => {
        await reportQueuedCommandError(
          harness,
          await seeded.nextStorageDelete(),
          {
            errorCode: "command_failed",
            errorMessage: RETENTION_RECEIPT_MESSAGE,
          },
        );
        await sleep(25);
      };

      await runThreadLifecycleSweep(harness.deps);
      await refuse();
      await sweep(harness, SWEEPS_WITHIN_BACKOFF);

      expect(seeded.attempts()).toBe(1);
      expect(
        seeded.infos("Thread storage deletion is held by a retention receipt"),
      ).toBe(1);
      expect(
        seeded.infoFields(
          "Thread storage deletion is held by a retention receipt",
        ),
      ).not.toHaveProperty("err");
      expect(
        seeded.warnings(
          "Thread storage deletion is held by a retention receipt",
        ),
      ).toBe(0);
      expect(seeded.warnings("Thread storage deletion command failed")).toBe(0);
      expect(getThread(harness.db, seeded.thread.id)).toMatchObject({
        deletedAt: expect.any(Number),
        storageDeletedAt: null,
      });

      vi.setSystemTime(Date.now() + THREAD_STORAGE_RETENTION_RETRY_MS);
      await runThreadLifecycleSweep(harness.deps);
      await refuse();
      await sweep(harness, SWEEPS_WITHIN_BACKOFF);

      expect(seeded.attempts()).toBe(2);
      expect(
        seeded.infos("Thread storage deletion is held by a retention receipt"),
      ).toBe(1);
      expect(seeded.warnings("Thread storage deletion command failed")).toBe(0);

      vi.setSystemTime(Date.now() + THREAD_STORAGE_RETENTION_RETRY_MS);
      await runThreadLifecycleSweep(harness.deps);
      await reportQueuedCommandSuccess(
        harness,
        await seeded.nextStorageDelete(),
        { providerCheckpointId: null },
      );
      await sleep(25);

      expect(seeded.attempts()).toBe(3);
      expect(
        seeded.infos(
          "Thread storage deletion finished after its retention receipt was removed",
        ),
      ).toBe(1);
      expect(getThread(harness.db, seeded.thread.id)).toBeNull();
    });
  });

  it("keeps retrying other deletion failures on the next sweep", async () => {
    await withTestHarness(async (harness) => {
      const seeded = seedDeletedThread(harness, "host_storage_failing");

      await runThreadLifecycleSweep(harness.deps);
      await reportQueuedCommandError(
        harness,
        await seeded.nextStorageDelete(),
        {
          errorCode: "command_failed",
          errorMessage: "EACCES: permission denied",
        },
      );
      await sleep(25);
      await runThreadLifecycleSweep(harness.deps);
      await seeded.nextStorageDelete();

      expect(seeded.attempts()).toBe(2);
      expect(seeded.warnings("Thread storage deletion command failed")).toBe(1);
      expect(
        seeded.warnings(
          "Thread storage deletion is held by a retention receipt",
        ),
      ).toBe(0);
    });
  });
});

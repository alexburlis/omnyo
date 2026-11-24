import {
  getProject,
  getThread,
  markThreadDeleted,
  markThreadStorageDeleted,
} from "@omnyo/db";
import { describe, expect, it } from "vitest";
import {
  advanceProjectDeletion,
  beginProjectDeletion,
} from "../../src/services/projects/project-deletion.js";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import { reconcileDaemonReportedThreads } from "../../src/services/threads/thread-lifecycle.js";
import {
  listQueuedCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

function seedHostProject(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps);

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });

  return { environment, host, project };
}

function storageDeleteThreadIds(harness: TestAppHarness): string[] {
  return listQueuedCommands(harness, "thread.storage.delete")
    .map((command) =>
      command.type === "thread.storage.delete" ? command.threadId : null,
    )
    .filter((threadId) => threadId !== null)
    .sort();
}

function waitForStorageDelete(harness: TestAppHarness, threadId: string) {
  return waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.storage.delete" && command.threadId === threadId,
  );
}

describe("repeated thread storage deletion", () => {
  it.each(["idle", "error", "active", "starting", "stopping"] as const)(
    "does not repeat a finished storage deletion on reconnect for %s threads",
    async (status) => {
      await withTestHarness(async (harness) => {
        const { environment, host, project } = seedHostProject(harness);

        const finished = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status,
        });

        const pending = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        });

        for (const thread of [finished, pending]) {
          markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
        }

        markThreadStorageDeleted(harness.db, { threadId: finished.id });

        await reconcileDaemonReportedThreads(harness.deps, {
          hostId: host.id,
          activeThreadIds: [],
          undeliveredEventThreadIds: [],
          sameDaemonInstance: false,
        });

        const retry = await waitForStorageDelete(harness, pending.id);
        const sent = storageDeleteThreadIds(harness);

        await reportQueuedCommandSuccess(harness, retry, {
          providerCheckpointId: null,
        });

        expect(sent).toEqual([pending.id]);
        expect(getThread(harness.db, finished.id)).toMatchObject({
          storageDeletedAt: expect.any(Number),
        });
      });
    },
  );

  it("sends at most four storage deletions to a host at once", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, project } = seedHostProject(harness);

      const deleted = Array.from({ length: 6 }, () =>
        seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        }),
      );

      for (const thread of deleted) {
        markThreadDeleted(harness.db, harness.hub, { threadId: thread.id });
      }

      await reconcileDaemonReportedThreads(harness.deps, {
        hostId: host.id,
        activeThreadIds: [],
        undeliveredEventThreadIds: [],
        sameDaemonInstance: false,
      });

      for (let remaining = deleted.length; remaining > 0; remaining -= 1) {
        await expect
          .poll(() => storageDeleteThreadIds(harness).length)
          .toBe(Math.min(4, remaining));

        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "thread.storage.delete",
        );

        await reportQueuedCommandSuccess(harness, queued, {
          providerCheckpointId: null,
        });
      }

      await expect
        .poll(() =>
          deleted.filter((thread) => getThread(harness.db, thread.id) !== null),
        )
        .toEqual([]);
    });
  });

  it("retries only unfinished storage deletions while a project deletion is pending", async () => {
    await withTestHarness(async (harness) => {
      const { environment, project } = seedHostProject(harness);

      const [storageGone, succeeds, fails] = Array.from({ length: 3 }, () =>
        seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "idle",
        }),
      );

      markThreadDeleted(harness.db, harness.hub, { threadId: storageGone.id });
      markThreadStorageDeleted(harness.db, { threadId: storageGone.id });

      beginProjectDeletion(harness.deps, { projectId: project.id });

      const succeedsCommand = await waitForStorageDelete(harness, succeeds.id);
      const failsCommand = await waitForStorageDelete(harness, fails.id);

      expect(storageDeleteThreadIds(harness)).toEqual(
        [succeeds.id, fails.id].sort(),
      );

      await reportQueuedCommandSuccess(harness, succeedsCommand, {
        providerCheckpointId: null,
      });

      await reportQueuedCommandError(harness, failsCommand, {
        errorCode: "command_failed",
        errorMessage: "Thread storage could not be removed",
      });

      await expect(
        advanceProjectDeletion(harness.deps, { projectId: project.id }),
      ).resolves.toBe(false);

      const retry = await waitForStorageDelete(harness, fails.id);

      expect(storageDeleteThreadIds(harness)).toEqual([fails.id]);

      await reportQueuedCommandSuccess(harness, retry, {
        providerCheckpointId: null,
      });

      await expect.poll(() => getThread(harness.db, fails.id)).toBeNull();
      expect(getThread(harness.db, succeeds.id)).toBeNull();
      expect(getThread(harness.db, storageGone.id)).toMatchObject({
        storageDeletedAt: expect.any(Number),
      });

      await runThreadLifecycleSweep(harness.deps);

      expect(getThread(harness.db, storageGone.id)).toBeNull();
      expect(storageDeleteThreadIds(harness)).toEqual([]);

      await expect(
        advanceProjectDeletion(harness.deps, { projectId: project.id }),
      ).resolves.toBe(true);
      expect(getProject(harness.db, project.id)).toBeNull();
    });
  });
});

import { environments, threads } from "@omnyo/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { requireThreadCommandEnvironment } from "../../src/services/threads/thread-command-environment.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const SHARED_PATH = "/tmp/thread-command-shared-checkout";

function seedSharedCheckout(harness: TestAppHarness) {
  const { host } = seedHostSession(harness.deps, { id: "host-shared-send" });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: SHARED_PATH,
  });

  const shared = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: SHARED_PATH,
  });

  const sender = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: shared.id,
    status: "idle",
  });

  const starting = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: null,
    status: "starting",
  });

  return { host, project, shared, sender, starting };
}

function claimPath(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    ownerThreadId: string;
    teardownStatus?: "running";
  },
): void {
  harness.db
    .update(environments)
    .set({
      ownerThreadId: args.ownerThreadId,
      claimPath: SHARED_PATH,
      teardownStatus: args.teardownStatus ?? null,
    })
    .where(eq(environments.id, args.environmentId))
    .run();
}

describe("requireThreadCommandEnvironment on a shared checkout", () => {
  it("accepts a send while another thread is still attaching its own environment to the checkout", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, shared, sender, starting } =
        seedSharedCheckout(harness);

      const preparing = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: null,
        status: "provisioning",
      });

      claimPath(harness, {
        environmentId: preparing.id,
        ownerThreadId: starting.id,
      });

      await expect(
        requireThreadCommandEnvironment(harness.deps, { thread: sender }),
      ).resolves.toMatchObject({ id: shared.id });
    });
  });

  it("accepts a send after another starting thread adopted the shared environment", async () => {
    await withTestHarness(async (harness) => {
      const { shared, sender, starting } = seedSharedCheckout(harness);

      claimPath(harness, {
        environmentId: shared.id,
        ownerThreadId: starting.id,
      });

      await expect(
        requireThreadCommandEnvironment(harness.deps, { thread: sender }),
      ).resolves.toMatchObject({ id: shared.id });
    });
  });

  it("still refuses an archived thread while another thread holds the checkout", async () => {
    await withTestHarness(async (harness) => {
      const { shared, sender, starting } = seedSharedCheckout(harness);

      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, sender.id))
        .run();
      claimPath(harness, {
        environmentId: shared.id,
        ownerThreadId: starting.id,
      });

      await expect(
        requireThreadCommandEnvironment(harness.deps, { thread: sender }),
      ).rejects.toThrow(
        "Cannot checkout branch while another thread is using this workspace",
      );
    });
  });

  it("still refuses a send while another environment at the path is being cleaned up", async () => {
    await withTestHarness(async (harness) => {
      const { host, project, sender, starting } = seedSharedCheckout(harness);

      const retiring = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: null,
        status: "provisioning",
      });

      claimPath(harness, {
        environmentId: retiring.id,
        ownerThreadId: starting.id,
        teardownStatus: "running",
      });

      await expect(
        requireThreadCommandEnvironment(harness.deps, { thread: sender }),
      ).rejects.toThrow("Workspace cleanup is pending");
    });
  });
});

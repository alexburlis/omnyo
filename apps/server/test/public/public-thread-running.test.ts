import { archiveThread } from "@omnyo/db";
import { threadScope } from "@omnyo/domain";
import {
  systemAppUpdateStatusSchema,
  threadResponseSchema,
  threadRunningResponseSchema,
} from "@omnyo/server-contract";
import { describe, expect, it, vi } from "vitest";
import { HOST_RECONNECT_GRACE_MS } from "../../src/constants.js";
import {
  handleDaemonSessionSilent,
  handleDaemonSocketClosed,
} from "../../src/internal/session-owner-side-effects.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedSession,
  seedStoredEvent,
  seedThread,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

async function running(harness: TestAppHarness) {
  const response = await harness.app.request("/api/v1/threads/running");
  expect(response.status).toBe(200);

  return threadRunningResponseSchema.parse(await readJson(response));
}

async function updateRunningCount(harness: TestAppHarness): Promise<number> {
  const response = await harness.app.request("/api/v1/system/app-update");
  expect(response.status).toBe(200);

  return systemAppUpdateStatusSchema.parse(await readJson(response))
    .runningThreadCount;
}

describe("GET /threads/running", () => {
  it("lists running threads through a short drop and excludes a host waiting to reconnect", async () => {
    await withTestHarness(async (harness) => {
      const { host, session } = seedHostSession(harness.deps, {
        id: "host-thread-running",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: "/tmp/thread-running-source",
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/thread-running-source",
      });

      const root = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      const child = seedThread(harness.deps, {
        environmentId: environment.id,
        parentThreadId: root.id,
        projectId: project.id,
        status: "active",
      });

      const spawned = seedThread(harness.deps, {
        environmentId: environment.id,
        originPluginId: "workflows",
        projectId: project.id,
        status: "active",
      });

      seedStoredEvent(harness.deps, {
        threadId: spawned.id,
        environmentId: environment.id,
        sequence: 1,
        type: "item/started",
        scope: threadScope(),
        itemId: "command-1",
        itemKind: "backgroundTask",
        data: {
          item: {
            id: "command-1",
            type: "backgroundTask",
            taskType: "local_bash",
            description: "Background command",
            status: "pending",
          },
        },
      });

      const unplaced = seedThread(harness.deps, {
        environmentId: null,
        projectId: project.id,
        status: "starting",
      });

      seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "idle",
      });

      const archived = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      archiveThread(harness.db, harness.deps.hub, archived.id);

      const rows = await running(harness);

      expect(new Set(rows.map((row) => row.id))).toEqual(
        new Set([root.id, child.id, spawned.id, unplaced.id]),
      );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(root.id)).toEqual({ id: root.id, hostId: host.id });
      expect(byId.get(unplaced.id)?.hostId).toBeNull();

      expect(await updateRunningCount(harness)).toBe(5);

      vi.useFakeTimers();

      try {
        handleDaemonSocketClosed(harness.deps, { sessionId: session.id });
        expect(await running(harness)).toEqual(rows);
        expect(await updateRunningCount(harness)).toBe(5);

        vi.advanceTimersByTime(HOST_RECONNECT_GRACE_MS);
        expect(await running(harness)).toEqual([
          { id: unplaced.id, hostId: null },
        ]);

        const detail = await harness.app.request(
          `/api/v1/threads/${spawned.id}`,
        );

        expect(
          threadResponseSchema.parse(await readJson(detail)),
        ).toMatchObject({
          status: "active",
          runtime: { displayStatus: "waiting-for-host" },
          work: { primary: { label: "waiting" } },
        });
        expect(await updateRunningCount(harness)).toBe(1);

        const reconnected = seedSession(harness.deps, host.id);
        expect(await running(harness)).toEqual(rows);
        expect(await updateRunningCount(harness)).toBe(5);

        handleDaemonSessionSilent(harness.deps, { sessionId: reconnected.id });
        expect(await running(harness)).toEqual([
          { id: unplaced.id, hostId: null },
        ]);
        expect(await updateRunningCount(harness)).toBe(1);
      } finally {
        harness.hub.cancelPendingDaemonDisconnect(session.id);
        vi.useRealTimers();
      }
    });
  });
});

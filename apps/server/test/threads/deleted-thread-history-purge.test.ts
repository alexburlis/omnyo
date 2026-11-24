import {
  getThread,
  insertEvents,
  markThreadDeleted,
  markThreadStorageDeleted,
  noopNotifier,
} from "@omnyo/db";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import { runThreadLifecycleSweep } from "../../src/services/system/periodic-sweeps.js";
import {
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { type TestAppHarness, withTestHarness } from "../helpers/test-app.js";

function seedHistory(harness: TestAppHarness, threadId: string, count: number) {
  insertEvents(
    harness.db,
    noopNotifier,
    Array.from({ length: count }, (_, index) => ({
      threadId,
      sequence: index + 1,
      scope: { kind: "turn", turnId: "turn" },
      type: "turn/diff/updated",
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      data: '{"diff":"unused"}',
      createdAt: 1,
    })),
  );
}

function eventCount(harness: TestAppHarness, threadId: string): number {
  return Number(
    harness.db.$client
      .prepare("SELECT count(*) FROM events WHERE thread_id = ?")
      .pluck()
      .get(threadId),
  );
}

describe("deleted thread history purge", () => {
  it("lets other work run between dependents while deleting a thread family", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const owner = seedThread(harness.deps, { projectId: project.id });

      const children = Array.from({ length: 4 }, () =>
        seedThread(harness.deps, {
          projectId: project.id,
          lifecycleOwnerThreadId: owner.id,
        }),
      );

      const remaining = () =>
        children.filter((child) => getThread(harness.db, child.id) !== null)
          .length;

      const observed = new Set<number>();
      let sampling = true;

      const sample = () => {
        observed.add(remaining());

        if (sampling) setImmediate(sample);
      };

      setImmediate(sample);

      const response = await harness.app.request(
        `/api/v1/threads/${owner.id}`,
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ childThreadsConfirmed: true }),
        },
      );

      sampling = false;

      expect(response.status).toBe(200);
      expect(remaining()).toBe(0);
      expect(
        [...observed].some((count) => count > 0 && count < children.length),
      ).toBe(true);
    });
  });

  it("stops purging deleted histories once a sweep spends its time budget", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const deleted = Array.from({ length: 3 }, () => {
        const thread = seedThread(harness.deps, { projectId: project.id });
        seedHistory(harness, thread.id, 150);
        markThreadDeleted(harness.db, harness.deps.hub, {
          threadId: thread.id,
        });
        markThreadStorageDeleted(harness.db, { threadId: thread.id });

        return thread;
      });

      let clock = 0;

      const now = vi.spyOn(performance, "now").mockImplementation(() => {
        clock += 1_000;

        return clock;
      });

      try {
        await runThreadLifecycleSweep(harness.deps);
      } finally {
        now.mockRestore();
      }

      const counts = deleted.map((thread) => eventCount(harness, thread.id));
      expect(counts.filter((count) => count < 150)).toEqual([50]);
      expect(counts.filter((count) => count === 150)).toHaveLength(2);
    });
  });
});

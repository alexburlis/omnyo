import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@omnyo/db";
import {
  childThreadActivitySchema,
  systemOperationEventDataSchema,
  threadSchema,
  turnRequestEventDataSchema,
  turnScope,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  queueChildThreadNeedsAttentionNotificationBestEffort,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import { resolveQuestionOwnerThread } from "../../src/services/threads/thread-parent.js";
import { reportNextEnvironmentAttachSuccess } from "../helpers/commands.js";
import {
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function seedParentAndChild(harness: TestAppHarness, quiet: boolean) {
  const { project, environment, thread: parent } = seedThreadFixture(harness);

  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "parent-provider-thread",
  });

  harness.db
    .update(threads)
    .set({ quiet })
    .where(eq(threads.id, parent.id))
    .run();

  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    status: "idle",
    title: "OMNYO-V: investigate",
  });

  return { parent, child, project, environment };
}

function parentSystemRequests(harness: TestAppHarness, parentThreadId: string) {
  return listEvents(harness.db, { threadId: parentThreadId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system");
}

function childActivities(harness: TestAppHarness, parentThreadId: string) {
  return listEvents(harness.db, { threadId: parentThreadId })
    .filter((row) => row.type === "system/operation")
    .map((row) => systemOperationEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.operation === "activity")
    .map((data) => ({
      operationId: data.operationId,
      status: data.status,
      activity: childThreadActivitySchema.parse(data.metadata),
    }));
}

afterEach(() => vi.useRealTimers());

describe("quiet parent chats", () => {
  it("wakes an ordinary parent's model when a child finishes", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = seedParentAndChild(harness, false);

      vi.useFakeTimers();
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnStatus: "completed",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      await vi.waitFor(() =>
        expect(parentSystemRequests(harness, parent.id)).toHaveLength(1),
      );
      expect(childActivities(harness, parent.id)).toEqual([]);
    });
  });

  it("records a finished row with the child's first paragraph instead of waking a quiet parent", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = seedParentAndChild(harness, true);

      seedStoredEvent(harness.deps, {
        threadId: child.id,
        providerThreadId: "child-provider-thread",
        sequence: 1,
        type: "item/completed",
        scope: turnScope("turn-1"),
        itemId: "message-1",
        itemKind: "agentMessage",
        data: {
          item: {
            id: "message-1",
            type: "agentMessage",
            text: "Needs matching browser and\ncoordinator timings.\n\nDetails follow.",
          },
        },
      });

      vi.useFakeTimers();
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnStatus: "completed",
      });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(parentSystemRequests(harness, parent.id)).toEqual([]);
      expect(
        listQueuedThreadMessages(harness.db, parent.id, {
          includeClaimed: true,
        }),
      ).toEqual([]);
      expect(childActivities(harness, parent.id)).toEqual([
        {
          operationId: `child-activity:${child.id}`,
          status: "completed",
          activity: {
            activityKind: "child",
            ref: { threadId: child.id },
            snapshot: {
              title: "OMNYO-V: investigate",
              state: "finished",
              summary: "Needs matching browser and coordinator timings.",
            },
          },
        },
      ]);
    });
  });

  it("starts a new row when a settled child reports again", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = seedParentAndChild(harness, true);

      for (const turnStatus of ["failed", "completed"] as const)
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: parent.id,
          turnStatus,
        });

      const [first, second] = childActivities(harness, parent.id);
      expect(first).toMatchObject({
        operationId: `child-activity:${child.id}`,
        status: "failed",
      });
      expect(second?.operationId).toMatch(
        new RegExp(`^child-activity:${child.id}:`),
      );
      expect(second?.activity.snapshot.state).toBe("finished");
    });
  });

  it("keeps needs-attention notices and child questions off a quiet parent", async () => {
    await withTestHarness(async (harness) => {
      const { parent, child } = seedParentAndChild(harness, true);

      await queueChildThreadNeedsAttentionNotificationBestEffort(harness.deps, {
        blockerSummary: "Waiting on approval",
        childThread: child,
        parentThreadId: parent.id,
      });

      expect(
        listQueuedThreadMessages(harness.db, parent.id, {
          includeClaimed: true,
        }),
      ).toEqual([]);
      expect(resolveQuestionOwnerThread(harness.deps, child)).toBeNull();
    });
  });

  it("creates an idle quiet chat and marks a child it gains as running", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment } = seedThreadFixture(harness);

      const created = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "plugin",
          originPluginId: "state-machines",
          projectId: project.id,
          providerId: "codex",
          input: [],
          idle: true,
          quiet: true,
          title: "Omnyo Sentry root-cause maintenance",
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(created.status, await created.clone().text()).toBe(201);
      const { id } = threadSchema.parse(await created.json());

      await reportNextEnvironmentAttachSuccess(harness, id).catch(() => {});
      await expect.poll(() => getThread(harness.db, id)?.status).toBe("idle");
      expect(getThread(harness.db, id)?.quiet).toBe(true);

      const child = await harness.app.request("/api/v1/threads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          origin: "plugin",
          originPluginId: "state-machines",
          projectId: project.id,
          providerId: "codex",
          input: [{ type: "text", text: "Investigate", mentions: [] }],
          parentThreadId: id,
          title: "Investigate · try 1",
          environment: { type: "reuse", environmentId: environment.id },
        }),
      });

      expect(child.status, await child.clone().text()).toBe(201);
      const { id: childId } = threadSchema.parse(await child.json());

      expect(childActivities(harness, id)).toEqual([
        expect.objectContaining({
          operationId: `child-activity:${childId}`,
          status: "running",
          activity: expect.objectContaining({
            snapshot: {
              title: "Investigate · try 1",
              state: "running",
              summary: null,
            },
          }),
        }),
      ]);
      expect(parentSystemRequests(harness, id)).toEqual([]);
    });
  });
});

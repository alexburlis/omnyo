import { describe, expect, it, vi, type MockInstance } from "vitest";
import { appendStoredThreadEvent } from "@omnyo/db";
import {
  backgroundTaskItemStatus,
  changedMessageSchema,
  LOCAL_WORKFLOW_TASK_TYPE,
  threadScope,
  turnScope,
  type WorkflowAgentState,
} from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { createMockHubSocket } from "../helpers/mock-hub-socket.js";
import { seedThreadFixture, seedTurnStarted } from "../helpers/seed.js";
import type { NotificationHub } from "../../src/ws/hub.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const providerThreadId = "provider-subagents";

async function postEvents(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
  events: HostDaemonEventEnvelope["event"][],
): Promise<void> {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: fixture.host.id }),
    body: JSON.stringify({
      sessionId: fixture.session.id,
      eventGroups: groupHostDaemonEvents(
        events.map((event) => ({ threadId: fixture.thread.id, event })),
      ),
    }),
  });

  expect(response.status).toBe(200);
}

function drainListedSubagentCounts(
  messages: string[],
  threadId: string,
  field: "activeSubagentCount" | "activeWorkflowCount" = "activeSubagentCount",
): number[] {
  const counts = messages.flatMap((raw) => {
    const payload: unknown = JSON.parse(raw);

    if (
      typeof payload !== "object" ||
      payload === null ||
      !("type" in payload) ||
      payload.type !== "changed"
    )
      return [];

    const message = changedMessageSchema.parse(payload);

    return message.entity === "thread" &&
      message.id === threadId &&
      message.metadata?.listEntry !== undefined
      ? [message.metadata.listEntry.activity[field]]
      : [];
  });

  messages.length = 0;

  return counts;
}

function delegation(
  threadId: string,
  type: "item/started" | "item/completed",
): HostDaemonEventEnvelope["event"] {
  return {
    type,
    threadId,
    providerThreadId,
    scope: turnScope("root-turn"),
    item: {
      type: "delegation",
      id: "agent-call",
      childRef: "child-agent",
      label: "Review the change",
      status: type === "item/started" ? "pending" : "completed",
      background: false,
    },
  };
}

function workflow(
  threadId: string,
  type: "item/started" | "item/backgroundTask/progress",
  agents: readonly WorkflowAgentState[],
): HostDaemonEventEnvelope["event"] {
  const item = {
    type: "backgroundTask" as const,
    id: "workflow-task",
    taskType: LOCAL_WORKFLOW_TASK_TYPE,
    description: "Review in parallel",
    status: "pending" as const,
    taskStatus: "running" as const,
    skipTranscript: false,
    workflow: {
      phases: [],
      agents: agents.map((state, index) => ({
        index: index + 1,
        label: `reviewer ${index + 1}`,
        state,
        model: "fixture-model",
        attempt: 1,
        cached: false,
        lastProgressAt: index,
      })),
    },
  };

  return type === "item/started"
    ? {
        type,
        threadId,
        providerThreadId,
        scope: turnScope("root-turn"),
        item,
      }
    : { type, threadId, providerThreadId, scope: threadScope(), item };
}

function seedRunningThread(harness: TestAppHarness) {
  const fixture = seedThreadFixture(harness, { thread: { status: "active" } });

  seedTurnStarted(harness.deps, {
    environmentId: fixture.environment.id,
    providerThreadId,
    threadId: fixture.thread.id,
    turnId: "root-turn",
  });

  const socket = createMockHubSocket();
  harness.hub.subscribe(socket, { kind: "thread-list" });

  return { fixture, socket };
}

describe("subagent count realtime updates", () => {
  it("resends the sidebar row when a delegation starts and when it finishes", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, socket } = seedRunningThread(harness);
      const threadId = fixture.thread.id;

      await postEvents(harness, fixture, [
        delegation(threadId, "item/started"),
      ]);
      expect(drainListedSubagentCounts(socket.messages, threadId)).toEqual([1]);

      await postEvents(harness, fixture, [
        delegation(threadId, "item/completed"),
      ]);
      expect(drainListedSubagentCounts(socket.messages, threadId)).toEqual([0]);
    });
  });

  it("resends the sidebar row only when a workflow's running agents change", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, socket } = seedRunningThread(harness);
      const threadId = fixture.thread.id;

      await postEvents(harness, fixture, [
        workflow(threadId, "item/started", ["queued", "queued"]),
      ]);
      expect(drainListedSubagentCounts(socket.messages, threadId)).toEqual([0]);

      await postEvents(harness, fixture, [
        workflow(threadId, "item/backgroundTask/progress", [
          "running",
          "running",
        ]),
      ]);
      expect(drainListedSubagentCounts(socket.messages, threadId)).toEqual([2]);

      await postEvents(harness, fixture, [
        workflow(threadId, "item/backgroundTask/progress", [
          "running",
          "running",
        ]),
      ]);
      expect(drainListedSubagentCounts(socket.messages, threadId)).toEqual([]);
    });
  });

  it("resends the sidebar row when the server settles a workflow and when its progress reopens it", async () => {
    await withTestHarness(async (harness) => {
      const { fixture, socket } = seedRunningThread(harness);
      const threadId = fixture.thread.id;

      await postEvents(harness, fixture, [
        workflow(threadId, "item/started", ["queued"]),
      ]);
      expect(
        drainListedSubagentCounts(
          socket.messages,
          threadId,
          "activeWorkflowCount",
        ),
      ).toEqual([1]);

      settleDanglingBackgroundTasks(harness.deps, {
        hostId: fixture.host.id,
      });
      expect(
        drainListedSubagentCounts(
          socket.messages,
          threadId,
          "activeWorkflowCount",
        ),
      ).toEqual([0]);

      await postEvents(harness, fixture, [
        workflow(threadId, "item/backgroundTask/progress", ["queued"]),
      ]);
      expect(
        drainListedSubagentCounts(
          socket.messages,
          threadId,
          "activeWorkflowCount",
        ),
      ).toEqual([1]);
    });
  });
});

function plainBackgroundTask(
  threadId: string,
  type: "item/started" | "item/backgroundTask/progress",
): HostDaemonEventEnvelope["event"] {
  const item = {
    type: "backgroundTask" as const,
    id: "plain-task",
    taskType: LOCAL_WORKFLOW_TASK_TYPE,
    description: "Plain task",
    status: "pending" as const,
    taskStatus: "running" as const,
    skipTranscript: false,
  };

  return type === "item/started"
    ? {
        type,
        threadId,
        providerThreadId,
        scope: turnScope("root-turn"),
        item,
      }
    : { type, threadId, providerThreadId, scope: threadScope(), item };
}

function settleOnServer(
  harness: TestAppHarness,
  fixture: ReturnType<typeof seedThreadFixture>,
): void {
  appendStoredThreadEvent(harness.deps.db, harness.hub, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId,
    type: "item/backgroundTask/completed",
    scope: threadScope(),
    data: {
      providerThreadId,
      item: {
        type: "backgroundTask",
        id: "plain-task",
        taskType: LOCAL_WORKFLOW_TASK_TYPE,
        description: "Plain task",
        status: backgroundTaskItemStatus("stopped"),
        taskStatus: "stopped",
        skipTranscript: false,
      },
    },
  });
}

function backgroundActivityFlags(
  notifyThread: MockInstance<NotificationHub["notifyThread"]>,
): (boolean | undefined)[] {
  return notifyThread.mock.calls.map(
    ([, , metadata]) => metadata?.backgroundActivityChanged,
  );
}

describe("background activity change notifications", () => {
  it("flags a running report that reopens a settled task and no other running report", async () => {
    await withTestHarness(async (harness) => {
      const { fixture } = seedRunningThread(harness);
      const threadId = fixture.thread.id;

      await postEvents(harness, fixture, [
        plainBackgroundTask(threadId, "item/started"),
      ]);

      const notifyThread = vi.spyOn(harness.hub, "notifyThread");

      await postEvents(harness, fixture, [
        plainBackgroundTask(threadId, "item/backgroundTask/progress"),
      ]);
      expect(backgroundActivityFlags(notifyThread)).toEqual([undefined]);

      settleOnServer(harness, fixture);
      notifyThread.mockClear();

      await postEvents(harness, fixture, [
        plainBackgroundTask(threadId, "item/backgroundTask/progress"),
      ]);
      expect(backgroundActivityFlags(notifyThread)).toEqual([true]);

      notifyThread.mockClear();

      await postEvents(harness, fixture, [
        plainBackgroundTask(threadId, "item/backgroundTask/progress"),
      ]);
      expect(backgroundActivityFlags(notifyThread)).toEqual([undefined]);
    });
  });
});

import { describe, expect, it } from "vitest";
import {
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_WORKFLOW_TASK_TYPE,
  threadEventSchema,
  threadScope,
  turnScope,
  type ThreadEvent,
  type WorkflowAgentState,
} from "@omnyo/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  appendDaemonEventsInTransaction,
  listActiveBackgroundTaskCountsByThreadIds,
} from "../../src/data/events.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { deriveStoredEventItemFields } from "../../src/stored-event-item-fields.js";
import type { DbConnection } from "../../src/connection.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const providerThreadId = "provider-thread";

type ItemStatus = "pending" | "completed";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "subagent-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "subagent-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/subagents" },
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  const append = (...events: ThreadEvent[]) =>
    db.transaction((tx) =>
      appendDaemonEventsInTransaction(
        tx,
        events.map((candidate) => {
          const event = threadEventSchema.parse(candidate);
          const { scope, type, threadId, ...data } = event;

          return {
            threadId,
            environmentId: null,
            providerThreadId,
            scope,
            type,
            ...deriveStoredEventItemFields(event),
            data: JSON.stringify(data),
          };
        }),
      ),
    );

  return { db, thread, append };
}

function counts(db: DbConnection, threadId: string) {
  return listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [threadId],
  });
}

function freshCounts(db: DbConnection, threadId: string) {
  return db.transaction((tx) =>
    listActiveBackgroundTaskCountsByThreadIds(tx, { threadIds: [threadId] }),
  );
}

function subagents(db: DbConnection, threadId: string): number {
  const reused = counts(db, threadId);
  expect(reused).toEqual(freshCounts(db, threadId));

  return reused[0]?.activeSubagentCount ?? 0;
}

function turnStarted(
  threadId: string,
  turnId: string,
  parentToolCallId?: string,
): ThreadEvent {
  return {
    type: "turn/started",
    threadId,
    providerThreadId,
    scope: turnScope(turnId),
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
  };
}

function turnCompleted(
  threadId: string,
  turnId: string,
  status: "completed" | "interrupted" = "completed",
): ThreadEvent {
  return {
    type: "turn/completed",
    threadId,
    providerThreadId,
    scope: turnScope(turnId),
    status,
  };
}

function delegation(args: {
  threadId: string;
  turnId: string;
  itemId: string;
  type: "item/started" | "item/completed";
  parentToolCallId?: string;
}): ThreadEvent {
  return {
    type: args.type,
    threadId: args.threadId,
    providerThreadId,
    scope: turnScope(args.turnId),
    item: {
      type: "delegation",
      id: args.itemId,
      childRef: `child-${args.itemId}`,
      label: `agent ${args.itemId}`,
      status: args.type === "item/started" ? "pending" : "completed",
      background: false,
      ...(args.parentToolCallId === undefined
        ? {}
        : { parentToolCallId: args.parentToolCallId }),
    },
  };
}

function backgroundTask(args: {
  threadId: string;
  itemId: string;
  taskType: string;
  status: ItemStatus;
  type:
    | "item/started"
    | "item/backgroundTask/progress"
    | "item/backgroundTask/completed";
  turnId?: string;
  parentToolCallId?: string;
  workflowAgents?: readonly WorkflowAgentState[];
}): ThreadEvent {
  const item = {
    type: "backgroundTask" as const,
    id: args.itemId,
    taskType: args.taskType,
    description: `task ${args.itemId}`,
    status: args.status,
    taskStatus:
      args.status === "pending" ? ("running" as const) : ("completed" as const),
    skipTranscript: false,
    ...(args.parentToolCallId === undefined
      ? {}
      : { parentToolCallId: args.parentToolCallId }),
    ...(args.workflowAgents === undefined
      ? {}
      : {
          workflow: {
            phases: [],
            agents: args.workflowAgents.map((state, index) => ({
              index: index + 1,
              label: `workflow agent ${index + 1}`,
              state,
              model: "fixture-model",
              attempt: 1,
              cached: false,
              lastProgressAt: index,
            })),
          },
        }),
  };

  if (args.type === "item/started") {
    return {
      type: args.type,
      threadId: args.threadId,
      providerThreadId,
      scope: turnScope(args.turnId ?? "turn-root"),
      item,
    };
  }

  return {
    type: args.type,
    threadId: args.threadId,
    providerThreadId,
    scope: threadScope(),
    item,
  };
}

describe("active subagent counts", () => {
  it("counts each pending delegation in the open root turn until it closes", () => {
    const { db, thread, append } = setup();
    const ids = ["deleg-a", "deleg-b", "deleg-c"];

    append(
      turnStarted(thread.id, "root-1"),
      ...ids.flatMap((itemId, index) => [
        delegation({
          threadId: thread.id,
          turnId: "root-1",
          itemId,
          type: "item/started",
        }),
        turnStarted(thread.id, `child-${index}`, itemId),
      ]),
    );

    expect(counts(db, thread.id)).toEqual([
      {
        threadId: thread.id,
        activeWorkflowCount: 0,
        activeBackgroundAgentCount: 0,
        activeBackgroundCommandCount: 0,
        activeSubagentCount: 3,
      },
    ]);
    expect(subagents(db, thread.id)).toBe(3);

    append(
      ...ids.flatMap((itemId, index) => [
        turnCompleted(thread.id, `child-${index}`),
        delegation({
          threadId: thread.id,
          turnId: "root-1",
          itemId,
          type: "item/completed",
        }),
      ]),
    );

    expect(subagents(db, thread.id)).toBe(0);
    expect(counts(db, thread.id)).toEqual([]);
  });

  it("counts a foreground Claude agent once while its delegation and task are both pending", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "agent-call",
        type: "item/started",
      }),
      backgroundTask({
        threadId: thread.id,
        itemId: "agent-task",
        taskType: LOCAL_AGENT_TASK_TYPE,
        status: "pending",
        type: "item/started",
        turnId: "root-1",
        parentToolCallId: "agent-call",
      }),
    );

    expect(counts(db, thread.id)[0]).toMatchObject({
      activeBackgroundAgentCount: 1,
      activeSubagentCount: 1,
    });
    expect(subagents(db, thread.id)).toBe(1);
  });

  it("keeps counting a Claude background agent after its launching delegation completes", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "agent-call",
        type: "item/started",
      }),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "agent-call",
        type: "item/completed",
      }),
      backgroundTask({
        threadId: thread.id,
        itemId: "agent-task",
        taskType: LOCAL_AGENT_TASK_TYPE,
        status: "pending",
        type: "item/started",
        turnId: "root-1",
        parentToolCallId: "agent-call",
      }),
      backgroundTask({
        threadId: thread.id,
        itemId: "agent-task",
        taskType: LOCAL_AGENT_TASK_TYPE,
        status: "pending",
        type: "item/backgroundTask/progress",
        parentToolCallId: "agent-call",
      }),
    );

    expect(subagents(db, thread.id)).toBe(1);

    append(
      backgroundTask({
        threadId: thread.id,
        itemId: "agent-task",
        taskType: LOCAL_AGENT_TASK_TYPE,
        status: "completed",
        type: "item/backgroundTask/completed",
        parentToolCallId: "agent-call",
      }),
    );

    expect(subagents(db, thread.id)).toBe(0);
  });

  it("counts the running agents in a workflow's latest snapshot", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      backgroundTask({
        threadId: thread.id,
        itemId: "workflow-task",
        taskType: LOCAL_WORKFLOW_TASK_TYPE,
        status: "pending",
        type: "item/started",
        turnId: "root-1",
        workflowAgents: ["running", "queued", "queued"],
      }),
      backgroundTask({
        threadId: thread.id,
        itemId: "workflow-task",
        taskType: LOCAL_WORKFLOW_TASK_TYPE,
        status: "pending",
        type: "item/backgroundTask/progress",
        workflowAgents: ["done", "running", "running"],
      }),
    );

    expect(counts(db, thread.id)[0]).toMatchObject({
      activeWorkflowCount: 1,
      activeSubagentCount: 2,
    });
    expect(subagents(db, thread.id)).toBe(2);
  });

  it("ignores a delegation left pending in an earlier root turn", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "abandoned-call",
        type: "item/started",
      }),
      turnCompleted(thread.id, "root-1", "interrupted"),
      turnStarted(thread.id, "root-2"),
    );

    expect(subagents(db, thread.id)).toBe(0);
  });

  it("ignores a delegation under an unfinished nested turn once every root turn completed", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "outer-call",
        type: "item/started",
      }),
      turnStarted(thread.id, "child-1", "outer-call"),
      delegation({
        threadId: thread.id,
        turnId: "child-1",
        itemId: "inner-call",
        type: "item/started",
        parentToolCallId: "outer-call",
      }),
    );

    expect(subagents(db, thread.id)).toBe(2);

    append(
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "outer-call",
        type: "item/completed",
      }),
      turnCompleted(thread.id, "root-1"),
    );

    expect(subagents(db, thread.id)).toBe(0);
  });

  it("lowers a cached count when a close event is appended", () => {
    const { db, thread, append } = setup();

    append(
      turnStarted(thread.id, "root-1"),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "first-call",
        type: "item/started",
      }),
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "second-call",
        type: "item/started",
      }),
    );

    expect(counts(db, thread.id)[0]?.activeSubagentCount).toBe(2);
    expect(counts(db, thread.id)[0]?.activeSubagentCount).toBe(2);

    append(
      delegation({
        threadId: thread.id,
        turnId: "root-1",
        itemId: "first-call",
        type: "item/completed",
      }),
    );

    expect(counts(db, thread.id)[0]?.activeSubagentCount).toBe(1);
    expect(subagents(db, thread.id)).toBe(1);
  });
});

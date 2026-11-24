import { describe, expect, it } from "vitest";
import {
  LOCAL_WORKFLOW_TASK_TYPE,
  backgroundTaskItemStatus,
  threadEventSchema,
  threadScope,
  turnScope,
  type BackgroundTaskStatus,
  type ThreadEvent,
  type ThreadEventBackgroundTaskItem,
} from "@omnyo/domain";
import { noopNotifier } from "../../src/notifier.js";
import {
  appendDaemonEventsInTransaction,
  appendRetainedDaemonEventsInTransaction,
  appendStoredThreadEventInTransaction,
  deleteThreadEventSuffixInTransaction,
  insertEvents,
  listActiveBackgroundTaskCountsByThreadIds,
  listEvents,
  listLatestOpenBackgroundTaskStateRowsForThread,
  listOpenBackgroundTaskItemRowsForHost,
  listOpenBackgroundTaskItemRowsForThread,
  listThreadEventSuffixBackgroundSettlementRows,
} from "../../src/data/events.js";
import { createEnvironment } from "../../src/data/environments.js";
import { advanceThreadPruning } from "../../src/data/thread-pruning.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { deriveStoredEventItemFields } from "../../src/stored-event-item-fields.js";
import type { DbConnection } from "../../src/connection.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const providerThreadId = "provider-thread";

const itemId = "workflow-task";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "reopening-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "reopening-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/reopening" },
  });

  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    path: "/tmp/reopening",
    status: "ready",
    providerOwnsPath: false,
  });

  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "claude-code",
    environmentId: environment.id,
  });

  const toDaemonInputs = (candidates: readonly ThreadEvent[]) =>
    candidates.map((candidate) => {
      const event = threadEventSchema.parse(candidate);
      const { scope, type, threadId, ...data } = event;

      return {
        threadId,
        environmentId: environment.id,
        providerThreadId,
        scope,
        type,
        ...deriveStoredEventItemFields(event),
        data: JSON.stringify(data),
      };
    });

  const appendFromDaemon = (...candidates: ThreadEvent[]) =>
    db.transaction((tx) =>
      appendDaemonEventsInTransaction(tx, toDaemonInputs(candidates)),
    );

  const appendRetainedFromDaemon = (...candidates: ThreadEvent[]) =>
    db.transaction((tx) =>
      appendRetainedDaemonEventsInTransaction(tx, toDaemonInputs(candidates)),
    );

  const settleFromServer = (taskStatus: BackgroundTaskStatus) =>
    db.transaction((tx) =>
      appendStoredThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId,
        type: "item/backgroundTask/completed",
        scope: threadScope(),
        data: {
          providerThreadId,
          item: workflowItem({ taskStatus }),
        },
      }),
    );

  return {
    db,
    environment,
    host,
    thread,
    appendFromDaemon,
    appendRetainedFromDaemon,
    settleFromServer,
  };
}

function workflowItem(
  args: {
    taskStatus: BackgroundTaskStatus;
  } & Partial<ThreadEventBackgroundTaskItem>,
): ThreadEventBackgroundTaskItem {
  const { taskStatus, ...rest } = args;

  return {
    type: "backgroundTask",
    id: itemId,
    taskType: LOCAL_WORKFLOW_TASK_TYPE,
    description: "fixture workflow",
    status: backgroundTaskItemStatus(taskStatus),
    taskStatus,
    skipTranscript: false,
    workflowName: "fixture-workflow",
    ...rest,
  };
}

function started(threadId: string): ThreadEvent[] {
  return [
    {
      type: "turn/started",
      threadId,
      providerThreadId,
      scope: turnScope("turn-root"),
    },
    {
      type: "item/started",
      threadId,
      providerThreadId,
      scope: turnScope("turn-root"),
      item: workflowItem({ taskStatus: "running" }),
    },
  ];
}

function progress(
  threadId: string,
  taskStatus: BackgroundTaskStatus,
): ThreadEvent {
  return {
    type: "item/backgroundTask/progress",
    threadId,
    providerThreadId,
    scope: threadScope(),
    item: workflowItem({ taskStatus }),
  };
}

function providerClose(
  threadId: string,
  taskStatus: BackgroundTaskStatus = "completed",
): ThreadEvent {
  return {
    type: "item/backgroundTask/completed",
    threadId,
    providerThreadId,
    scope: threadScope(),
    item: workflowItem({
      taskStatus,
      summary: "provider summary",
      outputFile: "/tmp/reopening/output.txt",
      usage: { totalTokens: 1200, toolUses: 7, durationMs: 9000 },
    }),
  };
}

function activeWorkflowCount(db: DbConnection, threadId: string): number {
  const memoized = listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [threadId],
  });

  const fresh = db.transaction((tx) =>
    listActiveBackgroundTaskCountsByThreadIds(tx, { threadIds: [threadId] }),
  );

  expect(memoized).toEqual(fresh);

  return memoized[0]?.activeWorkflowCount ?? 0;
}

function storedCloses(db: DbConnection, threadId: string) {
  return listEvents(db, { threadId })
    .filter((row) => row.type === "item/backgroundTask/completed")
    .map((row) => {
      const { item } = JSON.parse(row.data) as {
        item: ThreadEventBackgroundTaskItem;
      };

      return { taskStatus: item.taskStatus, summary: item.summary ?? null };
    });
}

function openTaskItemIds(
  db: DbConnection,
  args: { hostId: string; threadId: string },
) {
  const forThread = listOpenBackgroundTaskItemRowsForThread(db, {
    threadId: args.threadId,
  }).map((row) => row.itemId);

  const forHost = listOpenBackgroundTaskItemRowsForHost(db, {
    hostId: args.hostId,
  }).map((row) => row.itemId);

  expect(forHost).toEqual(forThread);

  return forThread;
}

function editFromSequence(
  db: DbConnection,
  args: { cutoffSequence: number; environmentId: string; threadId: string },
): number {
  const oldMaxSequence = Math.max(
    ...listEvents(db, { threadId: args.threadId }).map((row) => row.sequence),
  );

  const suffix = {
    cutoffSequence: args.cutoffSequence,
    oldMaxSequence,
    threadId: args.threadId,
  };

  const carried = db.transaction((tx) => {
    const rows = listThreadEventSuffixBackgroundSettlementRows(tx, suffix);
    deleteThreadEventSuffixInTransaction(tx, suffix);

    return rows;
  });

  insertEvents(
    db,
    noopNotifier,
    carried.map((row, index) => ({
      threadId: args.threadId,
      environmentId: args.environmentId,
      providerThreadId: row.providerThreadId,
      sequence: oldMaxSequence + 1 + index,
      scope: threadScope(),
      type: row.type,
      itemId: row.itemId,
      itemKind: row.itemKind,
      parentToolCallId: null,
      data: row.data,
    })),
  );

  return carried.length;
}

function timelineOpenStateItemIds(db: DbConnection, threadId: string) {
  return listLatestOpenBackgroundTaskStateRowsForThread(db, { threadId }).map(
    (row) => row.itemId,
  );
}

describe("background task settlement evidence", () => {
  it("reopens a task the server settled while the provider still reports it running, then stores the provider's close", () => {
    const { db, host, thread, appendFromDaemon, settleFromServer } = setup();

    appendFromDaemon(...started(thread.id));
    expect(activeWorkflowCount(db, thread.id)).toBe(1);

    settleFromServer("stopped");
    expect(activeWorkflowCount(db, thread.id)).toBe(0);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([]);

    const reopening = appendFromDaemon(progress(thread.id, "running"));

    expect(reopening.insertedInputIndexes).toEqual([0]);
    expect(reopening.reopenedInputIndexes).toEqual([0]);
    expect(activeWorkflowCount(db, thread.id)).toBe(1);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([itemId]);
    expect(timelineOpenStateItemIds(db, thread.id)).toEqual([itemId]);

    const repeated = appendFromDaemon(progress(thread.id, "running"));

    expect(repeated.insertedInputIndexes).toEqual([0]);
    expect(repeated.reopenedInputIndexes).toEqual([]);

    const close = appendFromDaemon(providerClose(thread.id));

    expect(close.insertedInputIndexes).toEqual([0]);
    expect(storedCloses(db, thread.id)).toEqual([
      { taskStatus: "stopped", summary: null },
      { taskStatus: "completed", summary: "provider summary" },
    ]);
    expect(activeWorkflowCount(db, thread.id)).toBe(0);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([]);
    expect(timelineOpenStateItemIds(db, thread.id)).toEqual([]);
  });

  it("reports no reopening for running reports of a task that was never settled", () => {
    const { db, thread, appendFromDaemon } = setup();

    appendFromDaemon(...started(thread.id));

    const batch = appendFromDaemon(
      progress(thread.id, "running"),
      progress(thread.id, "running"),
    );

    expect(batch.insertedInputIndexes).toEqual([0, 1]);
    expect(batch.reopenedInputIndexes).toEqual([]);
    expect(activeWorkflowCount(db, thread.id)).toBe(1);
  });

  it("reports only the first running report of a batch as the reopening one", () => {
    const { thread, appendFromDaemon, settleFromServer } = setup();

    appendFromDaemon(...started(thread.id));
    settleFromServer("stopped");

    const batch = appendFromDaemon(
      progress(thread.id, "running"),
      progress(thread.id, "running"),
    );

    expect(batch.insertedInputIndexes).toEqual([0, 1]);
    expect(batch.reopenedInputIndexes).toEqual([0]);
  });

  it("stores the provider's close when its running report arrives in the same batch", () => {
    const { db, thread, appendFromDaemon, settleFromServer } = setup();

    appendFromDaemon(...started(thread.id));
    settleFromServer("stopped");

    const batch = appendFromDaemon(
      progress(thread.id, "running"),
      providerClose(thread.id),
      providerClose(thread.id),
    );

    expect(batch.insertedInputIndexes).toEqual([0, 1]);
    expect(storedCloses(db, thread.id)).toEqual([
      { taskStatus: "stopped", summary: null },
      { taskStatus: "completed", summary: "provider summary" },
    ]);
    expect(activeWorkflowCount(db, thread.id)).toBe(0);
  });

  it("keeps a single close when the provider repeats it without new evidence", () => {
    const { db, host, thread, appendFromDaemon } = setup();

    appendFromDaemon(...started(thread.id), providerClose(thread.id));

    const duplicate = appendFromDaemon(providerClose(thread.id));

    expect(duplicate.insertedInputIndexes).toEqual([]);
    expect(storedCloses(db, thread.id)).toEqual([
      { taskStatus: "completed", summary: "provider summary" },
    ]);
    expect(activeWorkflowCount(db, thread.id)).toBe(0);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([]);
  });

  it.each(["completed", "failed"] as const)(
    "does not reopen a closed task for a later %s progress report",
    (taskStatus) => {
      const { db, host, thread, appendFromDaemon } = setup();

      appendFromDaemon(...started(thread.id), providerClose(thread.id));
      appendFromDaemon(progress(thread.id, taskStatus));

      expect(activeWorkflowCount(db, thread.id)).toBe(0);
      expect(
        openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
      ).toEqual([]);
      expect(timelineOpenStateItemIds(db, thread.id)).toEqual([]);

      const duplicate = appendFromDaemon(providerClose(thread.id));

      expect(duplicate.insertedInputIndexes).toEqual([]);
      expect(storedCloses(db, thread.id)).toHaveLength(1);
    },
  );

  it("keeps the running report that reopened a task when pruning superseded progress", () => {
    const { db, host, thread, appendFromDaemon, settleFromServer } = setup();

    appendFromDaemon(...started(thread.id));
    settleFromServer("stopped");
    appendFromDaemon(
      progress(thread.id, "running"),
      progress(thread.id, "running"),
      progress(thread.id, "running"),
      {
        type: "turn/completed",
        threadId: thread.id,
        providerThreadId,
        scope: turnScope("turn-root"),
        status: "completed",
      },
    );

    runResolvedItemPruning(db);

    expect(
      listEvents(db, { threadId: thread.id })
        .filter((row) => row.type === "item/backgroundTask/progress")
        .map((row) => row.sequence),
    ).toEqual([6]);
    expect(activeWorkflowCount(db, thread.id)).toBe(1);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([itemId]);
  });

  it("carries the provider's close past an edited message when an earlier server settlement was reopened", () => {
    const { db, thread, appendFromDaemon, settleFromServer } = setup();

    appendFromDaemon(...started(thread.id));
    settleFromServer("stopped");
    appendFromDaemon(progress(thread.id, "running"));

    const [closeSequence] = appendFromDaemon(
      providerClose(thread.id),
    ).acceptedEvents.map((event) => event.sequence);

    if (closeSequence === undefined) {
      throw new Error("Expected the provider close to be stored");
    }

    expect(
      listThreadEventSuffixBackgroundSettlementRows(db, {
        threadId: thread.id,
        cutoffSequence: closeSequence,
        oldMaxSequence: closeSequence,
      }).map((row) => [row.sequence, row.type]),
    ).toEqual([[closeSequence, "item/backgroundTask/completed"]]);
  });
  it("keeps a task running across an edited message when its progress reopened a server settlement in the suffix", () => {
    const {
      db,
      environment,
      host,
      thread,
      appendFromDaemon,
      settleFromServer,
    } = setup();

    appendFromDaemon(...started(thread.id), progress(thread.id, "running"));
    const cutoffSequence = settleFromServer("stopped");
    appendFromDaemon(progress(thread.id, "running"));
    expect(activeWorkflowCount(db, thread.id)).toBe(1);

    expect(
      editFromSequence(db, {
        cutoffSequence,
        environmentId: environment.id,
        threadId: thread.id,
      }),
    ).toBe(0);
    expect(activeWorkflowCount(db, thread.id)).toBe(1);
    expect(
      openTaskItemIds(db, { hostId: host.id, threadId: thread.id }),
    ).toEqual([itemId]);
  });
  it("drops a retained running report that would reopen a server settlement and stores the live one", () => {
    const {
      db,
      thread,
      appendFromDaemon,
      appendRetainedFromDaemon,
      settleFromServer,
    } = setup();

    appendFromDaemon(...started(thread.id));
    settleFromServer("stopped");
    const [, restarted] = started(thread.id);

    if (restarted === undefined) {
      throw new Error("Expected a started item fixture");
    }

    expect(
      appendRetainedFromDaemon(restarted, progress(thread.id, "running")),
    ).toMatchObject({ insertedInputIndexes: [], reopenedInputIndexes: [] });
    expect(activeWorkflowCount(db, thread.id)).toBe(0);

    expect(
      appendFromDaemon(progress(thread.id, "running")).reopenedInputIndexes,
    ).toEqual([0]);
    expect(activeWorkflowCount(db, thread.id)).toBe(1);
  });
});

function runResolvedItemPruning(db: DbConnection): void {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (advanceThreadPruning(db, "resolved-items").action === "cycle-complete")
      return;
  }

  throw new Error("Resolved-item pruning did not finish a cycle");
}

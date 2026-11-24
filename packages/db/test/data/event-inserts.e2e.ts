import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { threadCpuUsage } from "node:process";
import { DrizzleError } from "drizzle-orm";
import { threadScope, turnScope, type ThreadEventScope } from "@omnyo/domain";
import { createConnection, type DbConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier, type DbNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createEnvironment } from "../../src/data/environments.js";
import { createThread } from "../../src/data/threads.js";
import { recordProjectAttachment } from "../../src/data/project-attachments.js";
import {
  appendStoredThreadEventInTransaction,
  appendStoredThreadEventsInTransaction,
  insertEvents,
  type InsertEventInput,
} from "../../src/data/events.js";
import { COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS } from "../../src/retained-event-output.js";

const templateDb = createConnection(":memory:");

let template: Buffer;

try {
  migrate(templateDb);
  template = templateDb.$client.serialize();
} finally {
  templateDb.$client.close();
}

function fixture() {
  const db = createConnection(template);
  const host = upsertHost(db, noopNotifier, { name: "event-insert-proof" });

  const { project } = createProject(db, noopNotifier, {
    name: "event-insert-proof",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/tmp/event-insert-proof",
    },
  });

  const environment = createEnvironment(db, noopNotifier, {
    projectId: project.id,
    hostId: host.id,
    providerOwnsPath: false,
  });

  const threads = Array.from({ length: 4 }, () =>
    createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    }),
  );

  return { db, project, environment, threads };
}

function input(threadId: string, sequence: number): InsertEventInput {
  return {
    threadId,
    sequence,
    type: "system/error",
    scope: threadScope(),
    itemId: null,
    itemKind: null,
    parentToolCallId: null,
    data: JSON.stringify({ message: `event-${sequence}-😀`, retryable: false }),
    createdAt: 1_800_000_000_000 + sequence,
  };
}

function rowCount(db: DbConnection, table: string): number {
  const row = db.$client.prepare(`SELECT count(*) count FROM ${table}`).get();
  assert(
    row !== undefined &&
      row !== null &&
      typeof row === "object" &&
      "count" in row,
  );
  assert.equal(typeof row.count, "number");

  return row.count as number;
}

function counted(db: DbConnection) {
  const original = db.$client.prepare.bind(db.$client);
  const counts = { all: 0, error: 0, ignore: 0 };
  db.$client.prepare = (source: string) => {
    counts.all += 1;

    if (/^INSERT OR IGNORE INTO events\b/u.test(source)) counts.ignore += 1;
    else if (/^INSERT INTO events\b/u.test(source)) counts.error += 1;

    return original(source);
  };

  return {
    counts,
    restore: () => {
      db.$client.prepare = original;
    },
  };
}

function drizzleFailure(work: () => unknown, cause: RegExp): void {
  assert.throws(work, (error: unknown) => {
    assert(error instanceof DrizzleError);
    assert.match(error.message, /^Failed to run the query 'INSERT/u);
    assert(error.cause instanceof Error);
    assert.match(error.cause.message, cause);

    return true;
  });
}

const completed = (threadId: string, sequence: number): InsertEventInput => ({
  ...input(threadId, sequence),
  type: "item/completed",
  scope: turnScope("output-turn"),
  itemId: `command-${sequence}`,
  itemKind: "commandExecution",
  data: JSON.stringify({
    item: {
      id: `command-${sequence}`,
      type: "commandExecution",
      aggregatedOutput:
        "head-" +
        "x".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
        "-tail",
    },
  }),
});

const cases: string[] = [];

function check(
  name: string,
  work: (value: ReturnType<typeof fixture>) => void,
) {
  const value = fixture();

  try {
    work(value);
    cases.push(name);
  } finally {
    value.db.$client.close();
  }
}

check(
  "fresh thirteen-column values and nullable transitions",
  ({ db, environment, threads }) => {
    const values = [
      {
        ...input(threads[0]!.id, 1),
        environmentId: environment.id,
        scope: turnScope("turn-a"),
        providerThreadId: "provider-a",
        itemId: "item-a",
        itemKind: "agentMessage" as const,
        parentToolCallId: "parent-a",
      },
      input(threads[1]!.id, 7),
      {
        ...input(threads[0]!.id, 2),
        type: "provider/unhandled" as const,
        scope: turnScope("turn-b"),
        providerThreadId: "provider-b",
        itemId: "item-b",
        itemKind: "toolCall" as const,
        parentToolCallId: "parent-b",
        data: '{"raw":"b"}',
        createdAt: 13,
      },
    ];

    assert.deepEqual(insertEvents(db, noopNotifier, values), {
      insertedCount: 3,
      insertedInputIndexes: [0, 1, 2],
    });

    const stored = db.$client
      .prepare("SELECT * FROM events ORDER BY created_at DESC")
      .all();

    assert.equal(stored.length, values.length);
    const ids = new Set();

    for (const value of values) {
      const row = db.$client
        .prepare("SELECT * FROM events WHERE thread_id = ? AND sequence = ?")
        .get(value.threadId, value.sequence);

      assert(
        row !== undefined &&
          row !== null &&
          typeof row === "object" &&
          "id" in row,
      );
      assert.equal(typeof row.id, "string");
      ids.add(row.id);
      assert.deepEqual(
        { ...row, id: undefined },
        {
          id: undefined,
          thread_id: value.threadId,
          environment_id: value.environmentId ?? null,
          scope_kind: value.scope.kind,
          turn_id: value.scope.kind === "turn" ? value.scope.turnId : null,
          provider_thread_id: value.providerThreadId ?? null,
          sequence: value.sequence,
          type: value.type,
          item_id: value.itemId,
          item_kind: value.itemKind,
          parent_tool_call_id: value.parentToolCallId,
          data: value.data,
          created_at: value.createdAt,
        },
      );
    }

    assert.equal(ids.size, values.length);
  },
);

check(
  "OR IGNORE duplicates and CHECK; ordinary errors retain SQLite causes",
  ({ db, threads }) => {
    const threadId = threads[0]!.id;

    const malformedScope = JSON.parse(
      '{"kind":"turn","turnId":null}',
    ) as ThreadEventScope;

    const notifications: string[] = [];

    const notifier: DbNotifier = {
      ...noopNotifier,
      notifyThread: (id) => {
        notifications.push(id);
      },
    };

    assert.deepEqual(
      insertEvents(db, notifier, [
        input(threadId, 1),
        input(threadId, 1),
        { ...input(threadId, 2), scope: malformedScope },
      ]),
      { insertedCount: 1, insertedInputIndexes: [0] },
    );
    assert.deepEqual(notifications, [threadId]);
    drizzleFailure(
      () =>
        db.transaction((tx) =>
          appendStoredThreadEventInTransaction(tx, {
            threadId,
            scope: malformedScope,
            type: "system/error",
            data: { message: "bad scope" },
          }),
        ),
      /CHECK constraint failed/u,
    );
    drizzleFailure(
      () =>
        insertEvents(db, notifier, [
          input(threadId, 2),
          input("missing-thread", 1),
        ]),
      /FOREIGN KEY constraint failed/u,
    );
    drizzleFailure(
      () =>
        db.transaction((tx) =>
          appendStoredThreadEventInTransaction(tx, {
            threadId,
            environmentId: "missing-environment",
            scope: threadScope(),
            type: "system/error",
            data: { message: "bad environment" },
          }),
        ),
      /FOREIGN KEY constraint failed/u,
    );
    db.$client.exec(`CREATE TEMP TRIGGER duplicate_event BEFORE INSERT ON events
    WHEN NEW.data = '{"message":"duplicate-trigger"}' BEGIN
      INSERT INTO events (id, thread_id, environment_id, scope_kind, turn_id, provider_thread_id, sequence, type, item_id, item_kind, parent_tool_call_id, data, created_at)
      VALUES ('evt_forced_duplicate', NEW.thread_id, NEW.environment_id, NEW.scope_kind, NEW.turn_id, NEW.provider_thread_id, NEW.sequence, NEW.type, NEW.item_id, NEW.item_kind, NEW.parent_tool_call_id, NEW.data, NEW.created_at);
    END`);
    drizzleFailure(
      () =>
        db.transaction((tx) =>
          appendStoredThreadEventInTransaction(tx, {
            threadId,
            scope: threadScope(),
            type: "system/error",
            data: { message: "duplicate-trigger" },
          }),
        ),
      /UNIQUE constraint failed: events.thread_id, events.sequence/u,
    );
    db.$client.exec("DROP TRIGGER duplicate_event");
    assert.equal(rowCount(db, "events"), 1);
    assert.deepEqual(notifications, [threadId]);
    assert.equal(
      insertEvents(db, notifier, [input(threadId, 2)]).insertedCount,
      1,
    );
  },
);

check(
  "retained payloads and attachment effects follow successful inserts and roll back",
  ({ db, project, threads }) => {
    const threadId = threads[0]!.id;
    const output = completed(threadId, 1);
    assert.equal(insertEvents(db, noopNotifier, [output]).insertedCount, 1);

    const retained = db.$client
      .prepare("SELECT value FROM retained_event_outputs")
      .get();

    assert(
      retained !== undefined &&
        retained !== null &&
        typeof retained === "object" &&
        "value" in retained,
    );
    assert.equal(
      JSON.parse(retained.value as string),
      "head-" +
        "x".repeat(COMPLETED_EVENT_OUTPUT_TRUNCATION_THRESHOLD_CHARS) +
        "-tail",
    );
    const preview = db.$client.prepare("SELECT data FROM events").get();
    assert(
      preview !== undefined &&
        preview !== null &&
        typeof preview === "object" &&
        "data" in preview,
    );
    assert.equal(typeof preview.data, "string");
    assert((preview.data as string).length < 10_000);
    assert.equal(insertEvents(db, noopNotifier, [output]).insertedCount, 0);
    assert.equal(rowCount(db, "retained_event_outputs"), 1);
    recordProjectAttachment(db, {
      projectId: project.id,
      storedPath: "owned.txt",
      originalName: "owned.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      createdAt: 1,
      readyAt: 1,
    });

    const attachment = (sequence: number, path: string): InsertEventInput => ({
      ...input(threadId, sequence),
      type: "client/turn/requested",
      data: JSON.stringify({ input: [{ type: "localFile", path }] }),
    });

    assert.equal(
      insertEvents(db, noopNotifier, [attachment(2, "owned.txt")])
        .insertedCount,
      1,
    );
    assert.equal(rowCount(db, "project_attachment_threads"), 1);
    assert.equal(
      insertEvents(db, noopNotifier, [attachment(2, "missing.txt")])
        .insertedCount,
      0,
    );
    assert.throws(
      () =>
        insertEvents(db, noopNotifier, [
          completed(threadId, 3),
          attachment(4, "missing.txt"),
        ]),
      /was not uploaded/u,
    );
    assert.equal(rowCount(db, "events"), 2);
    assert.equal(rowCount(db, "retained_event_outputs"), 1);
    assert.equal(rowCount(db, "project_attachment_threads"), 1);
    db.$client.exec(
      "CREATE TEMP TRIGGER output_failure BEFORE INSERT ON retained_event_outputs BEGIN SELECT RAISE(ABORT, 'sidecar-failure'); END",
    );
    assert.throws(
      () => insertEvents(db, noopNotifier, [completed(threadId, 3)]),
      /sidecar-failure/u,
    );
    db.$client.exec("DROP TRIGGER output_failure");
    assert.equal(rowCount(db, "events"), 2);
    assert.equal(
      insertEvents(db, noopNotifier, [completed(threadId, 3)]).insertedCount,
      1,
    );
  },
);

let cacheCounts: {
  first: { all: number; error: number; ignore: number };
  warm: { all: number; error: number; ignore: number };
};

check(
  "direct transaction rollback, warm reuse, separate connections and close",
  ({ db, threads }) => {
    const threadId = threads[0]!.id;
    const counter = counted(db);

    try {
      insertEvents(db, noopNotifier, [input(threadId, 1)]);
      db.transaction((tx) =>
        appendStoredThreadEventInTransaction(tx, {
          threadId,
          scope: threadScope(),
          type: "system/error",
          data: { message: "ordinary" },
        }),
      );
      const first = { ...counter.counts };

      for (let index = 0; index < 5; index += 1) {
        assert.throws(
          () =>
            db.transaction((tx) => {
              appendStoredThreadEventInTransaction(tx, {
                threadId,
                scope: turnScope(`rollback-${index}`),
                type: "system/error",
                data: { message: "rollback" },
              });
              throw new Error("rollback-marker");
            }),
          /rollback-marker/u,
        );
        insertEvents(db, noopNotifier, [input(threadId, 10 + index)]);
      }

      cacheCounts = { first, warm: { ...counter.counts } };
      assert.equal(rowCount(db, "events"), 7);

      if (process.argv.includes("--require-cache")) {
        assert.equal(first.ignore, 1, "one cold ignore preparation");
        assert.equal(first.error, 1, "one cold ordinary preparation");
        assert.equal(
          counter.counts.ignore,
          1,
          "warm ignore reuses the statement",
        );
        assert.equal(
          counter.counts.error,
          1,
          "direct transaction rollback reuses the statement",
        );
      }
    } finally {
      counter.restore();
    }

    const other = fixture();
    const reopened = fixture();

    try {
      insertEvents(other.db, noopNotifier, [input(other.threads[0]!.id, 1)]);
      assert.equal(rowCount(other.db, "events"), 1);
      assert.equal(rowCount(db, "events"), 7);
      other.db.$client.close();
      assert.throws(() =>
        insertEvents(other.db, noopNotifier, [input(other.threads[0]!.id, 2)]),
      );
      assert.equal(
        insertEvents(reopened.db, noopNotifier, [
          input(reopened.threads[0]!.id, 2),
        ]).insertedCount,
        1,
      );
    } finally {
      if (other.db.$client.open) other.db.$client.close();
      reopened.db.$client.close();
    }
  },
);

function benchmark(mode: "ignore" | "error") {
  const samples: {
    elapsedMs: number;
    cpuMs: number;
    prepares: { all: number; error: number; ignore: number } | null;
    inserted: number;
  }[] = [];

  for (let repetition = 0; repetition < 12; repetition += 1) {
    const { db, threads } = fixture();

    const batches = Array.from({ length: 100 }, (_, batch) =>
      Array.from({ length: 50 }, (_, index) => {
        const value = input(
          threads[index % threads.length]!.id,
          batch * 50 + index + 1,
        );

        return {
          ...value,
          data: JSON.stringify({
            message: `message-${batch}-${index}-` + "x".repeat(256),
          }),
          providerThreadId: index % 2 === 0 ? "provider" : null,
        };
      }),
    );

    const counter = process.argv.includes("--uncounted-benchmark")
      ? { counts: null, restore: () => {} }
      : counted(db);

    try {
      const startedCpu = threadCpuUsage();
      const startedAt = performance.now();

      for (const batch of batches) {
        if (mode === "ignore") insertEvents(db, noopNotifier, batch);
        else
          db.transaction((tx) =>
            appendStoredThreadEventsInTransaction(
              tx,
              batch.map((event) => ({
                threadId: event.threadId,
                scope: event.scope,
                type: "system/error" as const,
                providerThreadId: event.providerThreadId,
                data: { message: event.data },
              })),
            ),
          );
      }

      const elapsedMs = performance.now() - startedAt;
      const cpu = threadCpuUsage(startedCpu);
      const prepares = counter.counts === null ? null : { ...counter.counts };
      const inserted = rowCount(db, "events");
      assert.equal(inserted, 5_000);

      if (repetition >= 3)
        samples.push({
          elapsedMs,
          cpuMs: (cpu.user + cpu.system) / 1_000,
          prepares,
          inserted,
        });
    } finally {
      counter.restore();
      db.$client.close();
    }
  }

  return {
    mode,
    warmupRuns: 3,
    measuredRuns: 9,
    batchCount: 100,
    batchSize: 50,
    samples,
  };
}

console.log(
  JSON.stringify({
    cases,
    cacheCounts: cacheCounts!,
    benchmarks: process.argv.includes("--benchmark")
      ? [benchmark("ignore"), benchmark("error")]
      : [],
  }),
);

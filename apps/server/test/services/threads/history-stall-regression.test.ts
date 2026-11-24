import { describe, expect, it } from "vitest";
import {
  createConnection,
  getLatestThreadSequence,
  type DbConnection,
} from "@omnyo/db";
import { loadThreadConversationOutline } from "../../../src/services/threads/timeline.js";
import {
  appendRows,
  withTestThread,
  type RowSpec,
  type TestThread,
} from "../../helpers/timeline-cache-fixture.js";

function taskRows(completed: boolean): RowSpec[] {
  const task = {
    type: "backgroundTask",
    id: "historical-task",
    familyId: "historical-family",
    taskType: "local_bash",
    description: "Historical task",
    skipTranscript: false,
  };

  const state = (
    type: RowSpec["type"],
    finished: boolean,
    turnId: string | null,
  ): RowSpec => ({
    type,
    turnId,
    providerThreadId: "provider-memo",
    itemId: task.id,
    itemKind: "backgroundTask",
    data: {
      item: {
        ...task,
        status: finished ? "completed" : "pending",
        taskStatus: finished ? "completed" : "running",
      },
    },
  });

  return [
    state("item/started", false, "turn-0"),
    state("item/backgroundTask/progress", false, null),
    ...(completed ? [state("item/backgroundTask/completed", true, null)] : []),
  ];
}

function seed(fixture: TestThread, count: number, task: boolean | null): void {
  const rows: RowSpec[] = [];

  for (let i = 0; i < count; i += 1) {
    const turnId = `turn-${i}`;

    rows.push(
      { type: "system/manager/user_message", data: { text: `Question ${i}` } },
      { type: "turn/started", turnId },
      ...(i === 0 && task !== null ? taskRows(task) : []),
      {
        type: "item/completed",
        turnId,
        itemId: `message-${i}`,
        itemKind: "agentMessage",
        data: {
          item: {
            id: `message-${i}`,
            type: "agentMessage",
            text: `Answer ${i}`,
          },
        },
      },
      { type: "turn/completed", turnId, data: { status: "completed" } },
    );
  }

  appendRows(fixture, [...rows, { type: "turn/started", turnId: "live" }]);
}

function load(db: DbConnection, fixture: TestThread) {
  return loadThreadConversationOutline(db, fixture.thread, {
    completedTurnDisplay: "flat",
    includeClearedContextHistory: false,
    maxSeq: getLatestThreadSequence(db, { threadId: fixture.thread.id }),
  });
}

function appendMessage(fixture: TestThread): void {
  appendRows(fixture, [
    {
      type: "item/completed",
      turnId: "live",
      itemId: "message-live",
      itemKind: "agentMessage",
      data: {
        item: { id: "message-live", type: "agentMessage", text: "New answer" },
      },
    },
  ]);
}

function selectedEvents(db: DbConnection, run: () => void): number {
  const original = db.$client.prepare;
  const restores = new Map<object, () => void>();
  let count = 0;

  Object.defineProperty(db.$client, "prepare", {
    configurable: true,
    writable: true,
    value: (sql: string) => {
      const statement = original.call(db.$client, sql);

      if (
        !restores.has(statement) &&
        sql.includes('from "events"') &&
        sql.includes('"created_at"')
      ) {
        const unwrapped = statement.all;
        const all = unwrapped.bind(statement);

        restores.set(statement, () => {
          statement.all = unwrapped;
        });
        Object.defineProperty(statement, "all", {
          configurable: true,
          writable: true,
          value: (...params: unknown[]) => {
            const rows = all(params);
            count += rows.length;

            return rows;
          },
        });
      }

      return statement;
    },
  });

  try {
    run();

    return count;
  } finally {
    db.$client.prepare = original;

    for (const restore of restores.values()) restore();
  }
}

describe("history work after an append", () => {
  it.each([50, 200, 800])(
    "reuses settled history containing an old completed task at %i turns",
    (count) => {
      withTestThread((fixture) => {
        seed(fixture, count, true);
        load(fixture.db, fixture);
        appendMessage(fixture);

        const selected = selectedEvents(fixture.db, () => {
          const outline = load(fixture.db, fixture);

          expect(outline.items.map((item) => item.preview)).toEqual([
            ...Array.from({ length: count }, (_, i) => [
              `Question ${i}`,
              `Answer ${i}`,
            ]).flat(),
            "New answer",
          ]);
        });

        expect(selected).toBeLessThanOrEqual(32);
      });
    },
  );

  it("updates an old running task without rereading unrelated completed turns", () => {
    withTestThread((fixture) => {
      seed(fixture, 800, false);
      load(fixture.db, fixture);
      appendMessage(fixture);
      appendRows(fixture, [taskRows(false)[1]!]);

      const selected = selectedEvents(fixture.db, () => {
        expect(
          load(fixture.db, fixture).items.map((item) => item.preview),
        ).toEqual([
          ...Array.from({ length: 800 }, (_, i) => [
            `Question ${i}`,
            `Answer ${i}`,
          ]).flat(),
          "New answer",
        ]);
      });

      expect(selected).toBeLessThanOrEqual(32);
    });
  });

  it("retains a read-only connection's prefix after an ordinary external append", () => {
    withTestThread((fixture) => {
      seed(fixture, 100, null);

      const reader = createConnection(fixture.db.$client.name, {
        readonly: true,
        cacheSizeKiB: 8192,
        mmapSizeBytes: 0,
      });

      try {
        load(reader, fixture);
        appendMessage(fixture);

        const selected = selectedEvents(reader, () => {
          expect(load(reader, fixture).items.at(-1)?.preview).toBe(
            "New answer",
          );
        });

        expect(selected).toBeLessThanOrEqual(32);
      } finally {
        reader.$client.close();
      }
    });
  });
});

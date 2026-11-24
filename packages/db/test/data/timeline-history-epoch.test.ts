import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { threadScope, turnScope, type JsonValue } from "@omnyo/domain";
import Database from "better-sqlite3";
import { createConnection, type DbConnection } from "../../src/connection.js";
import { insertEvents } from "../../src/data/events.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  getThreadHistoryEpoch,
  getThreadHistoryState,
} from "../../src/data/timeline-history-epoch.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import {
  dropHostAvailabilityColumn,
  dropReplayCreatedTables,
} from "../helpers/rewind.js";

function epoch(db: DbConnection, threadId: string): string {
  return getThreadHistoryEpoch(db, threadId);
}

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "epoch-host" });

  const { project } = createProject(db, noopNotifier, {
    name: "epoch-project",
    source: { type: "local_path", hostId: host.id, path: "/inert/epoch" },
  });

  const first = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  const second = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });

  return { db, first, second };
}

function append(db: DbConnection, threadId: string, sequence: number): void {
  insertEvents(db, noopNotifier, [
    {
      data: JSON.stringify({ text: `visible ${sequence}` }),
      scope: threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      sequence,
      threadId,
      type: "system/manager/user_message",
    },
  ]);
}

describe("durable timeline history epochs", () => {
  it("initializes existing history without changing public epochs or events", () => {
    const { db, first, second } = setup();

    try {
      append(db, first.id, 2);
      append(db, first.id, 4);
      const before = getThreadHistoryState(db, first.id);
      const secondBefore = getThreadHistoryState(db, second.id);

      const events = db.$client
        .prepare("SELECT * FROM events ORDER BY id")
        .all();

      const migrations = readMigrationFiles({
        migrationsFolder: fileURLToPath(
          new URL("../../drizzle", import.meta.url),
        ),
      });

      const rewriteMigration = migrations[147];

      const previousMigration = readFileSync(
        new URL(
          "../../drizzle/0144_timeline_history_cache.sql",
          import.meta.url,
        ),
        "utf8",
      );

      db.$client.exec(`
        DROP TRIGGER timeline_history_thread_insert;
        DROP TRIGGER timeline_history_event_replacement;
        DROP TRIGGER timeline_history_event_insert;
        DROP TRIGGER timeline_history_event_update;
        DROP TRIGGER timeline_history_event_delete;
        ALTER TABLE thread_history_epochs DROP COLUMN rewrite_epoch;
      `);
      db.$client.exec(
        previousMigration.slice(
          previousMigration.indexOf(
            "CREATE TRIGGER timeline_history_thread_insert",
          ),
        ),
      );
      db.$client
        .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
        .run(rewriteMigration.folderMillis);
      dropHostAvailabilityColumn(db);
      dropReplayCreatedTables(db);

      migrate(db);
      const upgraded = getThreadHistoryState(db, first.id);
      const secondUpgraded = getThreadHistoryState(db, second.id);
      expect(upgraded).toEqual({
        epoch: before.epoch,
        rewriteEpoch: expect.stringMatching(/^[a-f0-9]{32}$/u),
        highWaterSequence: 4,
      });
      expect(secondUpgraded).toEqual({
        epoch: secondBefore.epoch,
        rewriteEpoch: expect.stringMatching(/^[a-f0-9]{32}$/u),
        highWaterSequence: 0,
      });
      expect(secondUpgraded.rewriteEpoch).not.toBe(upgraded.rewriteEpoch);
      expect(
        db.$client.prepare("SELECT * FROM events ORDER BY id").all(),
      ).toEqual(events);
      migrate(db);
      expect(getThreadHistoryState(db, first.id)).toEqual(upgraded);
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("invalidates late finished-group changes while preserving unrelated new turns", () => {
    const { db, first } = setup();
    let sequence = 0;

    const add = (
      type:
        | "turn/started"
        | "turn/completed"
        | "item/completed"
        | "turn/input/accepted"
        | "client/turn/requested",
      turnId: string | null,
      data: Record<string, JsonValue> = {},
      itemId: string | null = null,
      parentToolCallId: string | null = null,
    ) =>
      insertEvents(db, noopNotifier, [
        {
          threadId: first.id,
          sequence: ++sequence,
          scope: turnId === null ? threadScope() : turnScope(turnId),
          type,
          data: JSON.stringify(data),
          itemId,
          itemKind: itemId === null ? null : "toolCall",
          parentToolCallId,
        },
      ]);

    try {
      const initial = epoch(db, first.id);
      const initialRewrite = getThreadHistoryState(db, first.id).rewriteEpoch;
      add("turn/started", "finished-root");
      add(
        "item/completed",
        "finished-root",
        { item: { id: "delegate", type: "toolCall" } },
        "delegate",
      );
      add(
        "turn/started",
        "finished-child",
        { parentToolCallId: "delegate" },
        null,
        "delegate",
      );
      add(
        "item/completed",
        "finished-child",
        { item: { id: "nested-delegate", type: "toolCall" } },
        "nested-delegate",
      );
      add("turn/completed", "finished-child");
      add("turn/input/accepted", "finished-root", {
        clientRequestId: "accepted-before-request",
      });
      add("turn/completed", "finished-root");
      expect(epoch(db, first.id)).toBe(initial);

      add("turn/started", "new-root");
      add(
        "item/completed",
        "new-root",
        { item: { id: "new-item", type: "toolCall" } },
        "new-item",
      );
      add("turn/completed", "new-root");
      expect(epoch(db, first.id)).toBe(initial);

      add(
        "item/completed",
        "finished-root",
        { item: { id: "late-item", type: "toolCall" } },
        "late-item",
      );
      let previous = epoch(db, first.id);
      expect(previous).not.toBe(initial);
      add(
        "turn/started",
        "late-child",
        { parentToolCallId: "delegate" },
        null,
        "delegate",
      );
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add(
        "turn/started",
        "late-grandchild",
        { parentToolCallId: "nested-delegate" },
        null,
        "nested-delegate",
      );
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add(
        "item/completed",
        "late-child",
        { item: { id: "late-child-item", type: "toolCall" } },
        "late-child-item",
      );
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add("turn/input/accepted", "finished-root", {
        clientRequestId: "late-request",
      });
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add("client/turn/requested", null, {
        requestId: "late-target",
        target: { kind: "steer", expectedTurnId: "finished-root" },
      });
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add("client/turn/requested", null, {
        requestId: "accepted-before-request",
        target: { kind: "new-turn" },
      });
      expect(epoch(db, first.id)).not.toBe(previous);
      previous = epoch(db, first.id);
      add("client/turn/requested", null, {
        requestId: "unrelated-request",
        target: { kind: "new-turn" },
      });
      add("turn/started", "unrelated-root");
      add("turn/input/accepted", "unrelated-root", {
        clientRequestId: "unrelated-request",
      });
      expect(epoch(db, first.id)).toBe(previous);
      expect(getThreadHistoryState(db, first.id)).toEqual({
        epoch: previous,
        rewriteEpoch: initialRewrite,
        highWaterSequence: sequence,
      });
    } finally {
      db.$client.close();
    }
  });

  it("handles native ID replacement across threads and exact duplicate retries without connection functions", () => {
    const { db, first, second } = setup();
    const foreign = new Database(db.$client.serialize());
    db.$client.close();
    foreign.pragma("foreign_keys = ON");
    foreign.pragma("recursive_triggers = OFF");

    const readState = (threadId: string) =>
      foreign
        .prepare<
          [string],
          { epoch: string; rewriteEpoch: string; highWaterSequence: number }
        >(
          "SELECT epoch, rewrite_epoch AS rewriteEpoch, high_water_sequence AS highWaterSequence FROM thread_history_epochs WHERE thread_id = ?",
        )
        .get(threadId)!;

    const readEpoch = (threadId: string) => readState(threadId).epoch;

    const eventSql =
      "INTO events (id, thread_id, scope_kind, sequence, type, data, created_at) VALUES (?, ?, 'thread', ?, 'system/manager/user_message', ?, 0)";

    const insert = foreign.prepare(`INSERT ${eventSql}`);
    const ignore = foreign.prepare(`INSERT OR IGNORE ${eventSql}`);
    const replace = foreign.prepare(`INSERT OR REPLACE ${eventSql}`);

    try {
      insert.run("native-id", first.id, 1, '{"text":"original"}');
      const originalState = readState(first.id);
      const original = readEpoch(first.id);
      const otherState = readState(second.id);
      const other = readEpoch(second.id);
      ignore.run("native-id", first.id, 1, '{"text":"original"}');
      expect(readState(first.id)).toEqual(originalState);
      ignore.run("native-id", first.id, 1, '{"text":"conflicting retry"}');
      expect(readEpoch(first.id)).not.toBe(original);
      expect(readState(first.id).rewriteEpoch).toBe(originalState.rewriteEpoch);
      expect(
        foreign.prepare("SELECT data FROM events WHERE id = 'native-id'").get(),
      ).toEqual({ data: '{"text":"original"}' });
      const conflict = readEpoch(first.id);
      replace.run("native-id", second.id, 20, '{"text":"moved replacement"}');
      expect(readEpoch(first.id)).not.toBe(conflict);
      expect(readEpoch(second.id)).not.toBe(other);
      expect(readState(first.id).rewriteEpoch).not.toBe(
        originalState.rewriteEpoch,
      );
      expect(readState(second.id).rewriteEpoch).not.toBe(
        otherState.rewriteEpoch,
      );
      expect(readState(first.id).highWaterSequence).toBe(1);
      expect(readState(second.id).highWaterSequence).toBe(20);
      const movedState = readState(second.id);
      const moved = readEpoch(second.id);
      replace.run(
        "native-id",
        second.id,
        30,
        '{"text":"same-thread replacement"}',
      );
      expect(readEpoch(second.id)).not.toBe(moved);
      expect(readState(second.id).rewriteEpoch).not.toBe(
        movedState.rewriteEpoch,
      );
      const replacementState = readState(second.id);
      const replacement = readEpoch(second.id);
      expect(() =>
        foreign.transaction(() => {
          replace.run(
            "native-id",
            first.id,
            40,
            '{"text":"rolled back replacement"}',
          );
          throw new Error("rollback replacement");
        })(),
      ).toThrow("rollback replacement");
      expect(readEpoch(second.id)).toBe(replacement);
      expect(readState(second.id)).toEqual(replacementState);
      foreign.prepare("DELETE FROM threads WHERE id = ?").run(second.id);
      expect(
        foreign
          .prepare("SELECT 1 FROM thread_history_epochs WHERE thread_id = ?")
          .get(second.id),
      ).toBeUndefined();
      expect(foreign.pragma("foreign_key_check")).toEqual([]);
    } finally {
      foreign.close();
    }
  });

  it("keeps ordinary appends and ignored duplicates in one epoch but changes for backfill and credential binding", () => {
    const { db, first, second } = setup();

    try {
      const initial = epoch(db, first.id);
      const secondInitial = epoch(db, second.id);
      const initialState = getThreadHistoryState(db, first.id);
      const secondState = getThreadHistoryState(db, second.id);
      expect(initial).toMatch(/^[a-f0-9]{32}$/u);
      expect(initialState.rewriteEpoch).toMatch(/^[a-f0-9]{32}$/u);
      expect(secondState.rewriteEpoch).not.toBe(initialState.rewriteEpoch);
      expect(secondInitial).not.toBe(initial);
      append(db, first.id, 2);
      append(db, first.id, 4);
      append(db, first.id, 4);
      expect(epoch(db, first.id)).toBe(initial);
      expect(getThreadHistoryState(db, first.id)).toEqual({
        ...initialState,
        highWaterSequence: 4,
      });
      append(db, first.id, 3);
      const backfilled = epoch(db, first.id);
      expect(backfilled).not.toBe(initial);
      const backfilledState = getThreadHistoryState(db, first.id);
      expect(backfilledState.rewriteEpoch).not.toBe(initialState.rewriteEpoch);
      expect(backfilledState.highWaterSequence).toBe(4);
      insertEvents(db, noopNotifier, [
        {
          data: JSON.stringify({
            entries: [
              {
                name: "SYNTHETIC_TOKEN",
                source: "shell",
                value: "inert-value",
              },
            ],
          }),
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          sequence: 5,
          threadId: first.id,
          type: "provider.env-resolved",
        },
      ]);
      expect(epoch(db, first.id)).not.toBe(backfilled);
      expect(getThreadHistoryState(db, first.id).rewriteEpoch).not.toBe(
        backfilledState.rewriteEpoch,
      );
      expect(getThreadHistoryState(db, first.id).highWaterSequence).toBe(5);
      expect(epoch(db, second.id)).toBe(secondInitial);
      expect(getThreadHistoryState(db, second.id)).toEqual(secondState);
    } finally {
      db.$client.close();
    }
  });

  it("tracks foreign SQL updates, moves and deletes across reopen, rolls back atomically and permits thread cascades", () => {
    const seeded = setup();
    append(seeded.db, seeded.first.id, 1);
    append(seeded.db, seeded.first.id, 3);
    const directory = mkdtempSync(join(import.meta.dirname, ".epoch-fixture-"));
    const path = join(directory, "history.db");
    writeFileSync(path, seeded.db.$client.serialize());
    seeded.db.$client.close();
    let db = createConnection(path, { readonly: true });
    const foreign = createConnection(path);

    try {
      const firstBefore = epoch(db, seeded.first.id);
      const secondBefore = epoch(db, seeded.second.id);
      const firstBeforeState = getThreadHistoryState(db, seeded.first.id);
      const secondBeforeState = getThreadHistoryState(db, seeded.second.id);
      foreign.$client
        .prepare("UPDATE events SET data = data WHERE thread_id = ?")
        .run(seeded.first.id);
      expect(getThreadHistoryState(db, seeded.first.id)).toEqual(
        firstBeforeState,
      );
      expect(() =>
        foreign.$client.transaction(() => {
          foreign.$client
            .prepare(
              "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 1",
            )
            .run('{"text":"rolled back"}', seeded.first.id);
          expect(epoch(foreign, seeded.first.id)).not.toBe(firstBefore);
          expect(
            getThreadHistoryState(foreign, seeded.first.id).rewriteEpoch,
          ).not.toBe(firstBeforeState.rewriteEpoch);
          throw new Error("rollback fixture");
        })(),
      ).toThrow("rollback fixture");
      expect(getThreadHistoryState(db, seeded.first.id)).toEqual(
        firstBeforeState,
      );
      foreign.$client
        .prepare(
          "UPDATE events SET data = ? WHERE thread_id = ? AND sequence = 1",
        )
        .run('{"text":"rewritten"}', seeded.first.id);
      const rewritten = epoch(db, seeded.first.id);
      const rewrittenState = getThreadHistoryState(db, seeded.first.id);
      expect(rewritten).not.toBe(firstBefore);
      expect(rewrittenState.rewriteEpoch).not.toBe(
        firstBeforeState.rewriteEpoch,
      );
      expect(rewrittenState.highWaterSequence).toBe(3);
      expect(getThreadHistoryState(db, seeded.second.id)).toEqual(
        secondBeforeState,
      );
      db.$client.close();
      db = createConnection(path, { readonly: true });
      expect(getThreadHistoryState(db, seeded.first.id)).toEqual(
        rewrittenState,
      );
      foreign.$client
        .prepare(
          "INSERT OR REPLACE INTO events (id, thread_id, scope_kind, sequence, type, data, created_at) VALUES (?, ?, 'thread', 3, 'system/manager/user_message', ?, 0)",
        )
        .run("replacement-at-tip", seeded.first.id, '{"text":"replaced tip"}');
      const replacedTip = epoch(db, seeded.first.id);
      const replacedTipState = getThreadHistoryState(db, seeded.first.id);
      expect(replacedTip).not.toBe(rewritten);
      expect(replacedTipState.rewriteEpoch).not.toBe(
        rewrittenState.rewriteEpoch,
      );
      foreign.$client
        .prepare(
          "UPDATE events SET thread_id = ? WHERE thread_id = ? AND sequence = 1",
        )
        .run(seeded.second.id, seeded.first.id);
      expect(epoch(db, seeded.first.id)).not.toBe(replacedTip);
      expect(epoch(db, seeded.second.id)).not.toBe(secondBefore);
      expect(getThreadHistoryState(db, seeded.first.id).rewriteEpoch).not.toBe(
        replacedTipState.rewriteEpoch,
      );
      const movedState = getThreadHistoryState(db, seeded.second.id);
      expect(movedState.rewriteEpoch).not.toBe(secondBeforeState.rewriteEpoch);
      expect(movedState.highWaterSequence).toBe(1);
      const moved = epoch(db, seeded.second.id);
      foreign.$client
        .prepare("DELETE FROM events WHERE thread_id = ?")
        .run(seeded.second.id);
      expect(epoch(db, seeded.second.id)).not.toBe(moved);
      expect(getThreadHistoryState(db, seeded.second.id).rewriteEpoch).not.toBe(
        movedState.rewriteEpoch,
      );
      expect(
        getThreadHistoryState(db, seeded.second.id).highWaterSequence,
      ).toBe(1);
      expect(() =>
        foreign.$client
          .prepare("DELETE FROM threads WHERE id = ?")
          .run(seeded.first.id),
      ).not.toThrow();
      expect(
        db.$client
          .prepare("SELECT 1 FROM thread_history_epochs WHERE thread_id = ?")
          .get(seeded.first.id),
      ).toBeUndefined();
    } finally {
      foreign.$client.close();
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

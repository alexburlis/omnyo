import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@omnyo/domain";
import { createConnection } from "../../src/connection.js";
import { insertEvents } from "../../src/data/events.js";
import { getThreadHistoryEpoch } from "../../src/data/timeline-history-epoch.js";
import {
  getThreadTimelineRecord,
  putThreadTimelineRecord,
} from "../../src/data/timeline-derived-cache.js";
import { createThread } from "../../src/data/threads.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import {
  dropHostAvailabilityColumn,
  dropReplayCreatedTables,
  dropThreadLastMessageAtColumn,
} from "../helpers/rewind.js";

describe("timeline history storage compatibility", () => {
  it("backfills existing histories without changing events and preserves epochs on repeated migration", () => {
    const db = createMigratedConnection();

    try {
      const triggers = db.$client
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name GLOB 'timeline_history_*'",
        )
        .all();

      for (const trigger of triggers)
        db.$client.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
      db.$client.exec(`
        DROP TABLE IF EXISTS thread_timeline_records;
        DROP TABLE IF EXISTS thread_history_epochs;
        DROP INDEX IF EXISTS events_thread_accepted_client_request_idx;
        DELETE FROM __drizzle_migrations WHERE created_at > 1791915286889;
      `);

      const thread = createThread(db, noopNotifier, {
        projectId: PERSONAL_PROJECT_ID,
        providerId: "codex",
      });

      const append = (sequence: number) =>
        insertEvents(db, noopNotifier, [
          {
            threadId: thread.id,
            sequence,
            type: "system/manager/user_message",
            scope: threadScope(),
            itemId: null,
            itemKind: null,
            parentToolCallId: null,
            data: JSON.stringify({ text: `preserved ${sequence}` }),
          },
        ]);

      append(47);

      const before = db.$client
        .prepare("SELECT * FROM events ORDER BY id")
        .all();

      dropThreadLastMessageAtColumn(db);
      dropHostAvailabilityColumn(db);
      dropReplayCreatedTables(db);
      migrate(db);
      expect(
        db.$client.prepare("SELECT * FROM events ORDER BY id").all(),
      ).toEqual(before);
      const initial = getThreadHistoryEpoch(db, thread.id);
      expect(initial).toMatch(/^[a-f0-9]{32}$/u);
      expect(
        db.$client
          .prepare(
            "SELECT high_water_sequence FROM thread_history_epochs WHERE thread_id = ?",
          )
          .get(thread.id),
      ).toEqual({ high_water_sequence: 47 });
      migrate(db);
      expect(getThreadHistoryEpoch(db, thread.id)).toBe(initial);
      append(48);
      expect(getThreadHistoryEpoch(db, thread.id)).toBe(initial);
      append(46);
      expect(getThreadHistoryEpoch(db, thread.id)).not.toBe(initial);
      expect(() => getThreadHistoryEpoch(db, "missing-thread")).toThrow();
      expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("enforces read-only connections and pure expiry reads without migrating, resizing or creating a database", () => {
    const seeded = createMigratedConnection();

    const thread = createThread(seeded, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
    });

    putThreadTimelineRecord(
      seeded,
      {
        key: "retained",
        threadId: thread.id,
        body: "opaque redacted body",
        kind: "root",
        createdAt: 10,
        expiresAt: 20,
      },
      { maxBytes: 1024, maxEntries: 10, maxEntryBytes: 1024 },
    );
    const initialEpoch = getThreadHistoryEpoch(seeded, thread.id);

    const directory = mkdtempSync(
      join(import.meta.dirname, ".timeline-storage-"),
    );

    const path = join(directory, "history.db");
    writeFileSync(path, seeded.$client.serialize());
    seeded.$client.close();

    const digest = () =>
      createHash("sha256").update(readFileSync(path)).digest("hex");

    const before = digest();
    const options = { readonly: true, cacheSizeKiB: 8192, mmapSizeBytes: 0 };
    const reader = createConnection(path, options);

    try {
      expect(reader.$client.readonly).toBe(true);
      expect(reader.$client.pragma("cache_size", { simple: true })).toBe(-8192);
      expect(reader.$client.pragma("mmap_size", { simple: true })).toBe(0);
      expect(getThreadHistoryEpoch(reader, thread.id)).toBe(initialEpoch);
      expect(
        getThreadTimelineRecord(reader, { key: "retained", now: 19 })?.body,
      ).toBe("opaque redacted body");
      expect(
        getThreadTimelineRecord(reader, { key: "retained", now: 20 }),
      ).toBeNull();
      expect(
        getThreadTimelineRecord(reader, { key: "retained", now: 9 }),
      ).toBeNull();
      expect(
        reader.$client
          .prepare("SELECT count(*) AS count FROM thread_timeline_records")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        reader.$client.prepare("SELECT total_changes() AS count").get(),
      ).toEqual({ count: 0 });
      expect(() =>
        reader.$client.prepare("DELETE FROM thread_timeline_records").run(),
      ).toThrow(/readonly/u);
      expect(() =>
        reader.$client.exec("CREATE TABLE forbidden (value TEXT)"),
      ).toThrow(/readonly/u);
      const missing = join(directory, "missing.db");
      expect(() => createConnection(missing, options)).toThrow();
      expect(existsSync(missing)).toBe(false);
      expect(digest()).toBe(before);
      expect(
        readdirSync(directory).reduce(
          (bytes, file) => bytes + statSync(join(directory, file)).size,
          0,
        ),
      ).toBeLessThan(64 * 1024 * 1024);
    } finally {
      reader.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }

    expect(existsSync(directory)).toBe(false);
  });
});

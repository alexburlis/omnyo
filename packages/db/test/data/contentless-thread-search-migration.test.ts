import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createConnection } from "../../src/connection.js";
import { migrate } from "../../src/migrate.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import {
  archiveThread,
  createThread,
  searchThreadsWithPendingInteractionState,
  updateThread,
  upsertThreadSearchSegments,
} from "../../src/data/threads.js";
import {
  dropHostAvailabilityColumn,
  dropReplayCreatedTables,
  dropThreadLastMessageAtColumn,
} from "../helpers/rewind.js";

it("migrates stored search without changing results or source text, then reopens and tracks mutations", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-contentless-search-"));
  const databasePath = join(directory, "app.db");
  let db = createConnection(databasePath);

  try {
    migrate(db);
    const host = upsertHost(db, noopNotifier, { name: "search-migration" });

    const { project } = createProject(db, noopNotifier, {
      name: "search-migration",
      source: { type: "local_path", hostId: host.id, path: directory },
    });

    const active = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Café alpha title",
    });

    const archived = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      title: "Café alpha archived",
    });

    archiveThread(db, noopNotifier, archived.id);

    const segment = {
      threadId: active.id,
      sourceKind: "user_message" as const,
      sourceKey: "1",
      sourceSeq: 1,
      text: "beta message 🙂 " + "retained source ".repeat(100),
    };

    upsertThreadSearchSegments(db, { segments: [segment] });
    db.$client.exec(
      readFileSync(
        resolve(__dirname, "../../drizzle/0101_thread_search_prefix_fts.sql"),
        "utf8",
      ),
    );
    db.$client.exec(
      "DELETE FROM __drizzle_migrations WHERE created_at >= 1792485953018",
    );
    db.$client.exec("UPDATE threads SET status_changed_at = updated_at");
    const queries = ["cafe", "alp", "alpha beta", "🙂", "retained"];

    const search = (query: string) =>
      searchThreadsWithPendingInteractionState(db, {
        query,
        limitPerGroup: 10,
      });

    const sourceRows = () =>
      db.$client
        .prepare("SELECT rowid, * FROM thread_search_segments ORDER BY rowid")
        .all();

    const beforeSearch = queries.map(search);
    const beforeSource = sourceRows();
    db.$client.exec(`
      DROP TRIGGER timeline_history_thread_insert;
      DROP TRIGGER timeline_history_event_replacement;
      DROP TRIGGER timeline_history_event_insert;
      DROP TRIGGER timeline_history_event_update;
      DROP TRIGGER timeline_history_event_delete;
      ALTER TABLE thread_history_epochs DROP COLUMN rewrite_epoch;
    `);

    for (const statement of readFileSync(
      resolve(__dirname, "../../drizzle/0144_timeline_history_cache.sql"),
      "utf8",
    ).split("--> statement-breakpoint")) {
      if (statement.trimStart().startsWith("CREATE TRIGGER"))
        db.$client.exec(statement);
    }

    dropThreadLastMessageAtColumn(db);
    dropHostAvailabilityColumn(db);
    dropReplayCreatedTables(db);
    migrate(db);
    migrate(db);
    expect(queries.map(search)).toEqual(beforeSearch);
    expect(sourceRows()).toEqual(beforeSource);
    expect(
      db.$client.prepare("SELECT text FROM thread_search_segments_fts").all(),
    ).toEqual(beforeSource.map(() => ({ text: null })));
    db.$client.close();
    db = createConnection(databasePath);
    migrate(db);
    expect(queries.map(search)).toEqual(beforeSearch);
    expect(sourceRows()).toEqual(beforeSource);
    updateThread(db, noopNotifier, active.id, { title: "replacement title" });
    expect(search("replacement").active.results[0]?.thread.id).toBe(active.id);
    expect(search("alpha").active.total).toBe(0);
    expect(search("alpha").archived.results[0]?.thread.id).toBe(archived.id);
    upsertThreadSearchSegments(db, {
      segments: [{ ...segment, text: "updated message" }],
    });
    expect(search("beta").active.total).toBe(0);
    expect(search("updated").active.results[0]?.thread.id).toBe(active.id);
    upsertThreadSearchSegments(db, {
      segments: [{ ...segment, text: "" }],
    });
    expect(search("updated").active.total).toBe(0);
    db.$client.prepare("DELETE FROM threads WHERE id = ?").run(archived.id);
    expect(search("alpha").archived.total).toBe(0);
    expect(() =>
      db.$client.exec(
        "INSERT INTO thread_search_segments_fts(thread_search_segments_fts) VALUES ('integrity-check')",
      ),
    ).not.toThrow();
    expect(db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    if (db.$client.open) db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

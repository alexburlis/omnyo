import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import {
  createConnection,
  createProject,
  migrate,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "../src/index.js";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

function isJournalEntry(value: unknown): value is JournalEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "idx" in value &&
    typeof value.idx === "number" &&
    "version" in value &&
    typeof value.version === "string" &&
    "when" in value &&
    typeof value.when === "number" &&
    "tag" in value &&
    typeof value.tag === "string" &&
    "breakpoints" in value &&
    typeof value.breakpoints === "boolean"
  );
}

function parseJournal(source: string) {
  const value: unknown = JSON.parse(source);

  if (
    typeof value !== "object" ||
    value === null ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  )
    throw new Error("Invalid migration journal");

  const entries: unknown[] = value.entries;

  if (!entries.every(isJournalEntry))
    throw new Error("Invalid migration journal entries");

  return { ...value, entries };
}

const inboxTables = [
  "thread_failures",
  "thread_moves",
  "thread_owner_inputs",
  "thread_producers",
  "thread_receipts",
  "thread_turn_marks",
  "thread_wait_conditions",
  "thread_wait_results",
  "thread_waits",
];

interface MigrationRow {
  hash: string;
  createdAt: number;
}

interface SchemaObject {
  name: string;
  type: "table" | "index";
  tableName: string;
}

it("upgrades the unchanged published 0–160 schema once without rewriting history or user work", async () => {
  const root = await mkdtemp(join(tmpdir(), "omnyo-state-upgrade-"));
  let db: DbConnection | undefined;

  try {
    const currentFolder = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../drizzle",
    );

    const prefixFolder = join(root, "published-prefix");

    const journal = parseJournal(
      await readFile(join(currentFolder, "meta/_journal.json"), "utf8"),
    );

    const prefixEntries = journal.entries.slice(0, 161);

    expect(prefixEntries).toHaveLength(161);
    expect(prefixEntries.at(-1)?.tag).toBe("0160_coalesced_system_notices");
    expect(journal.entries[161]?.tag).toBe("0161_omnyo_inbox_state");
    await mkdir(join(prefixFolder, "meta"), { recursive: true });
    await writeFile(
      join(prefixFolder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: prefixEntries }),
    );

    for (let start = 0; start < prefixEntries.length; start += 8)
      await Promise.all(
        prefixEntries
          .slice(start, start + 8)
          .map((entry) =>
            copyFile(
              join(currentFolder, `${entry.tag}.sql`),
              join(prefixFolder, `${entry.tag}.sql`),
            ),
          ),
      );

    const currentMigrations = readMigrationFiles({
      migrationsFolder: currentFolder,
    });

    const prefixMigrations = readMigrationFiles({
      migrationsFolder: prefixFolder,
    });

    const forwardMigrations = currentMigrations.slice(161);

    expect(prefixMigrations).toEqual(currentMigrations.slice(0, 161));
    db = createConnection(join(root, "published.sqlite"));
    const sqlite = db.$client;
    sqlite.exec(`
      CREATE TEMP TABLE bb_migration_existing_installation (existing INTEGER NOT NULL);
      INSERT INTO bb_migration_existing_installation VALUES (0);
      CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY);
    `);
    sqlite.pragma("foreign_keys = OFF");

    try {
      drizzleMigrate(db, { migrationsFolder: prefixFolder });
    } finally {
      sqlite.pragma("foreign_keys = ON");
    }

    const history = () =>
      sqlite
        .prepare<[], MigrationRow>(
          "SELECT hash, created_at AS createdAt FROM __drizzle_migrations ORDER BY created_at",
        )
        .all();

    const objects = () =>
      sqlite
        .prepare<[], SchemaObject>(
          "SELECT name, type, tbl_name AS tableName FROM sqlite_master WHERE type IN ('table', 'index') AND sql IS NOT NULL ORDER BY name",
        )
        .all();

    const columns = () =>
      sqlite
        .prepare<[], { name: string }>(
          "PRAGMA table_info(plugin_state_snapshots)",
        )
        .all()
        .map((column) => column.name);

    expect(columns()).toContain("rollback_bb_version");
    expect(columns()).not.toContain("rollback_core_version");
    const objectsBefore = objects();
    expect(
      objectsBefore.filter((entry) => inboxTables.includes(entry.name)),
    ).toEqual([]);
    const historyBefore = history();
    expect(historyBefore).toEqual(
      prefixMigrations.map((entry) => ({
        hash: entry.hash,
        createdAt: entry.folderMillis,
      })),
    );

    const host = upsertHost(db, noopNotifier, { name: "unchanged bb host" });

    const { project } = createProject(db, noopNotifier, {
      name: "User bb project",
      source: { type: "local_path", hostId: host.id, path: "/work/user-bb-π" },
    });

    const threadId = "thr_user_bb_work";
    sqlite
      .prepare(
        "INSERT INTO threads (id, project_id, provider_id, title, latest_attention_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        threadId,
        project.id,
        "opaque-user-provider",
        "Keep user bb words 日本語",
        444,
        444,
        444,
      );

    const publishedThreadColumns = sqlite
      .prepare<[], { name: string }>("PRAGMA table_info(threads)")
      .all()
      .map((column) => `"${column.name}"`)
      .join(", ");

    const snapshotId = "snapshot-stable-owner";
    const pluginId = "opaque-user-plugin";
    const rollbackVersion = "0.46.241+private.1";
    sqlite
      .prepare(
        "INSERT INTO plugin_state_snapshots (id, plugin_id, to_artifact_id, snapshot_path, state_path, status, rollback_bb_version, created_at, retained_until, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        snapshotId,
        pluginId,
        "artifact-stable",
        ".bb/snapshots/π",
        ".bb/user-state",
        "ready",
        rollbackVersion,
        111,
        999999,
        222,
      );

    const userValue = JSON.stringify({
      untouched: "User bb work π 日本語 😀",
      path: ".bb/unknown",
    });

    sqlite
      .prepare(
        "INSERT INTO plugin_kv (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
      )
      .run(pluginId, "opaque-work", userValue, 333);
    const unknownBytes = Buffer.from([0, 255, 128, 13, 10, 42, 0, 9]);
    sqlite.exec(
      "CREATE TABLE user_opaque_work (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)",
    );
    sqlite
      .prepare("INSERT INTO user_opaque_work (id, bytes) VALUES (?, ?)")
      .run("unknown-stable", unknownBytes);

    const preserved = () => ({
      host: sqlite.prepare("SELECT * FROM hosts WHERE id = ?").get(host.id),
      project: sqlite
        .prepare("SELECT * FROM projects WHERE id = ?")
        .get(project.id),
      thread: sqlite
        .prepare(`SELECT ${publishedThreadColumns} FROM threads WHERE id = ?`)
        .get(threadId),
      snapshot: sqlite
        .prepare("SELECT * FROM plugin_state_snapshots WHERE id = ?")
        .raw()
        .get(snapshotId),
      kv: sqlite
        .prepare("SELECT * FROM plugin_kv WHERE plugin_id = ? AND key = ?")
        .get(pluginId, "opaque-work"),
      unknown: sqlite
        .prepare("SELECT * FROM user_opaque_work WHERE id = ?")
        .get("unknown-stable"),
    });

    const workBefore = preserved();
    const objectNamesBefore = new Set(objectsBefore.map((entry) => entry.name));
    objectNamesBefore.add("user_opaque_work");

    migrate(db);
    const historyAfter = history();
    expect(historyAfter).toHaveLength(
      historyBefore.length + forwardMigrations.length,
    );
    expect(historyAfter.slice(0, 161)).toEqual(historyBefore);
    expect(historyAfter.slice(161)).toEqual(
      forwardMigrations.map((entry) => ({
        hash: entry.hash,
        createdAt: entry.folderMillis,
      })),
    );
    expect(preserved()).toEqual(workBefore);
    expect(
      sqlite
        .prepare(
          "SELECT rollback_core_version FROM plugin_state_snapshots WHERE id = ?",
        )
        .get(snapshotId),
    ).toEqual({ rollback_core_version: rollbackVersion });
    expect(columns()).toContain("rollback_core_version");
    expect(columns()).not.toContain("rollback_bb_version");

    const additions = objects().filter(
      (entry) => !objectNamesBefore.has(entry.name),
    );

    expect(
      additions
        .filter((entry) => entry.type === "table")
        .map((entry) => entry.name),
    ).toEqual(["native_thread_imports", ...inboxTables]);
    const indexes = additions.filter((entry) => entry.type === "index");
    expect(
      indexes.filter((entry) => inboxTables.includes(entry.tableName)),
    ).toHaveLength(21);
    expect(
      indexes.filter((entry) => !inboxTables.includes(entry.tableName)),
    ).toEqual([
      {
        name: "native_thread_imports_source_idx",
        type: "index",
        tableName: "native_thread_imports",
      },
      { name: "threads_launched_by_idx", type: "index", tableName: "threads" },
    ]);
    expect(sqlite.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
    expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);

    migrate(db);
    expect(history()).toEqual(historyAfter);
    expect(preserved()).toEqual(workBefore);
    expect(sqlite.pragma("integrity_check")).toEqual([
      { integrity_check: "ok" },
    ]);
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db?.$client.close();
    await rm(root, { recursive: true, force: true });
    expect(existsSync(root)).toBe(false);
  }
});

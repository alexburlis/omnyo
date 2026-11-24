import { createHash } from "node:crypto";
import { afterEach, expect, test } from "vitest";
import { createConnection, migrate, type DbConnection } from "@omnyo/db";
import { runPluginStorageMigrations } from "@omnyo/plugin-sdk/internal/host-policy";

const connections: DbConnection[] = [];

const statement =
  "CREATE TABLE omnyo_fixture (id TEXT PRIMARY KEY, value TEXT NOT NULL)";

const statementHash = createHash("sha256").update(statement).digest("hex");

function fixture(hash: string | null = statementHash) {
  const db = createConnection(":memory:");
  connections.push(db);
  migrate(db);
  db.$client.exec(statement);
  db.$client
    .prepare("INSERT INTO omnyo_fixture VALUES (?, ?)")
    .run("stable-id", "preserved");
  db.$client.exec(
    "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  db.$client
    .prepare("INSERT INTO _bb_migrations VALUES (?, ?, ?)")
    .run(0, 17, hash);

  return db.$client;
}

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

test("adopts populated legacy ledger without replay and preserves statement hashes and IDs", () => {
  const database = fixture();
  runPluginStorageMigrations(database, [statement]);
  runPluginStorageMigrations(database, [statement]);
  expect(database.prepare("SELECT * FROM _plugin_migrations").all()).toEqual([
    { id: 0, applied_at: 17, statement_hash: statementHash },
  ]);
  expect(database.prepare("SELECT * FROM omnyo_fixture").all()).toEqual([
    { id: "stable-id", value: "preserved" },
  ]);
  expect(
    database
      .prepare("SELECT name FROM sqlite_master WHERE name = '_bb_migrations'")
      .get(),
  ).toBeUndefined();
});

test("refuses two ledgers without modifying either namespace", () => {
  const database = fixture();
  database.exec(
    "CREATE TABLE _plugin_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
  );
  expect(() => runPluginStorageMigrations(database, [statement])).toThrow(
    /collision/i,
  );
  expect(
    database.prepare("SELECT applied_at FROM _bb_migrations").get(),
  ).toEqual({ applied_at: 17 });
  expect(
    database.prepare("SELECT count(*) AS count FROM _plugin_migrations").get(),
  ).toEqual({ count: 0 });
});

test("rolls back adoption when a new migration fails and resumes once without partial data", () => {
  const database = fixture();
  expect(() =>
    runPluginStorageMigrations(database, [
      statement,
      "INSERT INTO missing_table VALUES (1)",
    ]),
  ).toThrow();
  expect(
    database
      .prepare(
        "SELECT name FROM sqlite_master WHERE name = '_plugin_migrations'",
      )
      .get(),
  ).toBeUndefined();
  expect(
    database.prepare("SELECT applied_at FROM _bb_migrations").get(),
  ).toEqual({ applied_at: 17 });
  runPluginStorageMigrations(database, [
    statement,
    "INSERT INTO omnyo_fixture VALUES ('second-id', 'new')",
  ]);
  runPluginStorageMigrations(database, [
    statement,
    "INSERT INTO omnyo_fixture VALUES ('second-id', 'new')",
  ]);
  expect(
    database.prepare("SELECT count(*) AS count FROM omnyo_fixture").get(),
  ).toEqual({ count: 2 });
});

test("refuses changed applied statements without converting or erasing the legacy ledger", () => {
  const database = fixture();
  expect(() =>
    runPluginStorageMigrations(database, [
      "CREATE TABLE changed_fixture (id TEXT)",
    ]),
  ).toThrow(/recorded statement/);
  expect(
    database.prepare("SELECT statement_hash FROM _bb_migrations").get(),
  ).toEqual({ statement_hash: statementHash });
});

test("adopts legacy null hashes once while preserving original application time", () => {
  const database = fixture(null);
  runPluginStorageMigrations(database, [statement]);
  expect(database.prepare("SELECT * FROM _plugin_migrations").get()).toEqual({
    id: 0,
    applied_at: 17,
    statement_hash: statementHash,
  });
});

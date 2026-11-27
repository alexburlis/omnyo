import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import {
  dropThreadShelfSortKeyColumn,
  dropPostShelfMigrationArtifacts,
  dropNativeThreadImportsTable,
  dropThreadStatusChangedAtColumn,
} from "./helpers/rewind.js";

const LEGACY_ID = "bb-machine-auth-system-user";

const CANONICAL_ID = "omnyo-machine-auth-system-user";

const here = dirname(fileURLToPath(import.meta.url));

const journal = JSON.parse(
  readFileSync(resolve(here, "../drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

const principalMigrationWhen = journal.entries.find(
  (entry) => entry.tag === "0164_machine_auth_principal_id",
)!.when;

const connections: DbConnection[] = [];

function migrated(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);
  connections.push(db);

  return db;
}

function seedUser(db: DbConnection, id: string, email: string): void {
  db.$client
    .prepare(
      `INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?, 'Machine Auth System', ?, 1, 1000, 2000)`,
    )
    .run(id, email);
}

function seedKey(db: DbConnection, id: string, referenceId: string): void {
  db.$client
    .prepare(
      `INSERT INTO apikey (
         id, key, referenceId, enabled, rateLimitEnabled, rateLimitTimeWindow,
         rateLimitMax, requestCount, createdAt, updatedAt, configId
       ) VALUES (?, ?, ?, 1, 0, 0, 0, 0, 1000, 2000, 'default')`,
    )
    .run(id, `hashed-${id}`, referenceId);
}

function replayPrincipalMigration(db: DbConnection): void {
  dropPostShelfMigrationArtifacts(db);
  dropThreadShelfSortKeyColumn(db);
  dropThreadStatusChangedAtColumn(db);
  dropNativeThreadImportsTable(db);
  db.$client
    .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(principalMigrationWhen);
  migrate(db);
}

function userRows(db: DbConnection): { id: string; email: string }[] {
  return db.$client
    .prepare<[], { id: string; email: string }>(
      "SELECT id, email FROM user ORDER BY id",
    )
    .all();
}

function keyRows(db: DbConnection): { id: string; referenceId: string }[] {
  return db.$client
    .prepare<[], { id: string; referenceId: string }>(
      "SELECT id, referenceId FROM apikey ORDER BY id",
    )
    .all();
}

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

describe("0164 machine auth principal id", () => {
  it("renames the principal and its key references in one step", () => {
    const db = migrated();
    seedUser(db, LEGACY_ID, "machine-auth@omnyo.internal");
    seedUser(db, "person", "person@example.test");
    seedKey(db, "machine-a", LEGACY_ID);
    seedKey(db, "machine-b", LEGACY_ID);
    seedKey(db, "personal", "person");

    replayPrincipalMigration(db);

    expect(userRows(db)).toEqual([
      { id: CANONICAL_ID, email: "machine-auth@omnyo.internal" },
      { id: "person", email: "person@example.test" },
    ]);
    expect(keyRows(db)).toEqual([
      { id: "machine-a", referenceId: CANONICAL_ID },
      { id: "machine-b", referenceId: CANONICAL_ID },
      { id: "personal", referenceId: "person" },
    ]);
    expect(
      db.$client
        .prepare("SELECT key FROM apikey WHERE id = ?")
        .get("machine-a"),
    ).toEqual({ key: "hashed-machine-a" });
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  it("leaves a colliding pair for the service to refuse", () => {
    const db = migrated();
    seedUser(db, LEGACY_ID, "machine-auth@bb.internal");
    seedUser(db, CANONICAL_ID, "machine-auth@omnyo.internal");
    seedKey(db, "machine-a", LEGACY_ID);

    replayPrincipalMigration(db);

    expect(userRows(db).map((row) => row.id)).toEqual([
      LEGACY_ID,
      CANONICAL_ID,
    ]);
    expect(keyRows(db)).toEqual([{ id: "machine-a", referenceId: LEGACY_ID }]);
  });

  it("does nothing when no legacy principal exists", () => {
    const db = migrated();
    seedUser(db, CANONICAL_ID, "machine-auth@omnyo.internal");
    seedKey(db, "machine-a", CANONICAL_ID);

    replayPrincipalMigration(db);

    expect(userRows(db).map((row) => row.id)).toEqual([CANONICAL_ID]);
    expect(keyRows(db)).toEqual([
      { id: "machine-a", referenceId: CANONICAL_ID },
    ]);
  });
});

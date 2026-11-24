import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import {
  dropNativeThreadImportsTable,
  dropThreadShelfSortKeyColumn,
  dropThreadStatusChangedAtColumn,
} from "./helpers/rewind.js";

const here = dirname(fileURLToPath(import.meta.url));

const journal = JSON.parse(
  readFileSync(resolve(here, "../drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

const migrationWhen = journal.entries.find(
  (entry) => entry.tag === "0167_drop_marketplace_stats_json",
)!.when;

const connections: DbConnection[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

function columns(db: DbConnection): string[] {
  return db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(plugin_marketplaces)")
    .all()
    .map((column) => column.name);
}

describe("0167_drop_marketplace_stats_json", () => {
  it("drops stats_json and keeps every marketplace row", () => {
    const db = createConnection(":memory:");
    connections.push(db);
    migrate(db);
    dropThreadShelfSortKeyColumn(db);
    dropThreadStatusChangedAtColumn(db);
    dropNativeThreadImportsTable(db);
    db.$client
      .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
      .run(migrationWhen);
    db.$client.exec(
      "ALTER TABLE plugin_marketplaces ADD COLUMN stats_json text",
    );
    db.$client
      .prepare(
        "INSERT INTO plugin_marketplaces (name, source_kind, manifest_url, source_git_ref, source_git_subdirectory, source_git_commit, manifest_json, stats_json, etag, last_modified, last_successful_refresh_at, last_attempted_refresh_at, last_error, created_at, updated_at) VALUES ('acme-plugins', 'git', 'https://example.test/acme.git', 'main', 'catalog', 'abc123', '{}', '{\"installs\":{}}', 'etag-1', 'yesterday', 10, 11, 'stale', 1, 2)",
      )
      .run();

    migrate(db);

    expect(columns(db)).not.toContain("stats_json");
    expect(
      db.$client
        .prepare(
          "SELECT * FROM plugin_marketplaces WHERE name = 'acme-plugins'",
        )
        .get(),
    ).toEqual({
      name: "acme-plugins",
      source_kind: "git",
      manifest_url: "https://example.test/acme.git",
      source_git_ref: "main",
      source_git_subdirectory: "catalog",
      source_git_commit: "abc123",
      manifest_json: "{}",
      etag: "etag-1",
      last_modified: "yesterday",
      last_successful_refresh_at: 10,
      last_attempted_refresh_at: 11,
      last_error: "stale",
      created_at: 1,
      updated_at: 2,
    });
  });
});

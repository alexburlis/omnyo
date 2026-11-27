import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import {
  dropPostShelfMigrationArtifacts,
  dropNativeThreadImportsTable,
  dropThreadShelfSortKeyColumn,
  dropThreadStatusChangedAtColumn,
} from "./helpers/rewind.js";

const here = dirname(fileURLToPath(import.meta.url));

const journal = JSON.parse(
  readFileSync(resolve(here, "../drizzle/meta/_journal.json"), "utf8"),
) as { entries: { tag: string; when: number }[] };

const migrationWhen = journal.entries.find(
  (entry) => entry.tag === "0166_drop_upstream_community_marketplace",
)!.when;

const connections: DbConnection[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});

function migrated(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);
  connections.push(db);

  return db;
}

function seedPlugin(
  db: DbConnection,
  id: string,
  provenance: string,
  marketplace: string | null,
): void {
  db.$client
    .prepare(
      `INSERT INTO plugins (id, source, source_kind, source_path, root_dir, version, enabled, installed_at, updated_at, provenance, catalog_entry_id, catalog_marketplace_name)
       VALUES (?, ?, 'path', ?, ?, '1.0.0', 1, 1, 2, ?, ?, ?)`,
    )
    .run(
      id,
      `/plugins/${id}`,
      `/plugins/${id}`,
      `/plugins/${id}`,
      provenance,
      provenance === "catalog" ? id : null,
      marketplace,
    );
}

function seedMarketplace(db: DbConnection, name: string): void {
  db.$client
    .prepare(
      "INSERT INTO plugin_marketplaces (name, source_kind, manifest_url, manifest_json, created_at, updated_at) VALUES (?, 'https', 'https://example.test/marketplace.json', '{}', 1, 2)",
    )
    .run(name);
  db.$client
    .prepare(
      "INSERT INTO plugin_marketplace_icons (marketplace_name, entry_id, source_url, content_type, content_hash, bytes, updated_at) VALUES (?, 'entry', 'https://example.test/icon.svg', 'image/svg+xml', 'hash', X'00', 1)",
    )
    .run(name);
}

function replay(db: DbConnection): void {
  dropPostShelfMigrationArtifacts(db);
  dropThreadShelfSortKeyColumn(db);
  dropThreadStatusChangedAtColumn(db);
  dropNativeThreadImportsTable(db);
  db.$client
    .prepare("DELETE FROM __drizzle_migrations WHERE created_at >= ?")
    .run(migrationWhen);
  migrate(db);
}

describe("0166_drop_upstream_community_marketplace", () => {
  it("removes the upstream community marketplace and keeps its plugins as direct installs", () => {
    const db = migrated();
    seedMarketplace(db, "bb-community");
    seedMarketplace(db, "acme-plugins");
    seedPlugin(db, "from-upstream", "catalog", "bb-community");
    seedPlugin(db, "legacy-catalog", "catalog", null);
    seedPlugin(db, "from-acme", "catalog", "acme-plugins");
    seedPlugin(db, "local", "direct", null);

    replay(db);

    expect(
      db.$client
        .prepare("SELECT name FROM plugin_marketplaces ORDER BY name")
        .all(),
    ).toEqual([{ name: "acme-plugins" }]);
    expect(
      db.$client
        .prepare(
          "SELECT marketplace_name FROM plugin_marketplace_icons ORDER BY marketplace_name",
        )
        .all(),
    ).toEqual([{ marketplace_name: "acme-plugins" }]);
    expect(
      db.$client
        .prepare(
          "SELECT id, provenance, catalog_entry_id, catalog_marketplace_name FROM plugins ORDER BY id",
        )
        .all(),
    ).toEqual([
      {
        id: "from-acme",
        provenance: "catalog",
        catalog_entry_id: "from-acme",
        catalog_marketplace_name: "acme-plugins",
      },
      {
        id: "from-upstream",
        provenance: "direct",
        catalog_entry_id: null,
        catalog_marketplace_name: null,
      },
      {
        id: "legacy-catalog",
        provenance: "direct",
        catalog_entry_id: null,
        catalog_marketplace_name: null,
      },
      {
        id: "local",
        provenance: "direct",
        catalog_entry_id: null,
        catalog_marketplace_name: null,
      },
    ]);
  });
});

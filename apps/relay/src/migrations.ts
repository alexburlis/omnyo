import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { z } from "zod";

export const CONNECT_DB_MIGRATIONS_TABLE = "__relay_connect_db_migrations";

export const RELAY_LOCAL_MIGRATIONS_TABLE = "__relay_local_migrations";

const RELAY_LOCAL_MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/u;

const MIGRATION_TAG = /^\d{4}_[a-z0-9_]+$/u;

export interface MigrationDirectories {
  connectDb: string;
  relayLocal: string;
}

export interface MigrationEntry {
  tag: string;
  sql: string;
  sha256: string;
}

export interface MigrationSet {
  table:
    | typeof CONNECT_DB_MIGRATIONS_TABLE
    | typeof RELAY_LOCAL_MIGRATIONS_TABLE;
  entries: readonly MigrationEntry[];
}

export interface AppliedMigrations {
  connectDb: string[];
  relayLocal: string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

const journalSchema = z.object({
  dialect: z.literal("sqlite"),
  entries: z
    .array(
      z.object({
        idx: z.number().int().nonnegative(),
        tag: z.string().regex(MIGRATION_TAG),
      }),
    )
    .min(1),
});

const recordedRowSchema = z.object({
  tag: z.string(),
  sha256: z.string(),
});

export function sourceMigrationDirectories(): MigrationDirectories {
  return {
    connectDb: fileURLToPath(
      new URL("../../../packages/connect-db/migrations/", import.meta.url),
    ),
    relayLocal: fileURLToPath(new URL("../migrations/", import.meta.url)),
  };
}

export function bundledMigrationDirectories(
  entryUrl: string,
): MigrationDirectories {
  return {
    connectDb: fileURLToPath(new URL("./migrations/connect-db/", entryUrl)),
    relayLocal: fileURLToPath(new URL("./migrations/relay/", entryUrl)),
  };
}

function readEntry(directory: string, tag: string): MigrationEntry {
  let bytes: Buffer;

  try {
    bytes = readFileSync(join(directory, `${tag}.sql`));
  } catch {
    throw new MigrationError(
      `Migration file ${tag}.sql is missing from ${directory}`,
    );
  }

  return {
    tag,
    sql: bytes.toString("utf8"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function readConnectDbMigrations(directory: string): MigrationSet {
  let raw: unknown;

  try {
    raw = JSON.parse(
      readFileSync(join(directory, "meta", "_journal.json"), "utf8"),
    );
  } catch {
    throw new MigrationError(
      `Cannot read the connect-db migration journal in ${directory}`,
    );
  }

  const journal = journalSchema.safeParse(raw);

  if (!journal.success) {
    throw new MigrationError(
      `The connect-db migration journal in ${directory} is malformed`,
    );
  }

  const ordered = [...journal.data.entries].sort((a, b) => a.idx - b.idx);
  const tags = new Set<string>();

  ordered.forEach((entry, position) => {
    if (entry.idx !== position || tags.has(entry.tag)) {
      throw new MigrationError(
        `The connect-db migration journal in ${directory} has a gap or duplicate at ${entry.tag}`,
      );
    }

    tags.add(entry.tag);
  });

  return {
    table: CONNECT_DB_MIGRATIONS_TABLE,
    entries: ordered.map((entry) => readEntry(directory, entry.tag)),
  };
}

export function readRelayLocalMigrations(directory: string): MigrationSet {
  let files: string[];

  try {
    files = readdirSync(directory).filter((file) => file.endsWith(".sql"));
  } catch {
    throw new MigrationError(
      `Cannot read relay-local migrations in ${directory}`,
    );
  }

  const invalid = files.filter(
    (file) => !RELAY_LOCAL_MIGRATION_FILE.test(file),
  );

  if (invalid.length > 0) {
    throw new MigrationError(
      `Unexpected relay-local migration file names: ${invalid.join(", ")}`,
    );
  }

  return {
    table: RELAY_LOCAL_MIGRATIONS_TABLE,
    entries: files
      .sort()
      .map((file) => readEntry(directory, file.slice(0, -".sql".length))),
  };
}

function ensureLedger(
  sqlite: Database.Database,
  table: MigrationSet["table"],
): void {
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${table}" (tag TEXT PRIMARY KEY NOT NULL, sha256 TEXT NOT NULL, applied_at INTEGER NOT NULL)`,
  );
}

function recordedMigrations(
  sqlite: Database.Database,
  table: MigrationSet["table"],
): Map<string, string> {
  const rows = z
    .array(recordedRowSchema)
    .parse(sqlite.prepare(`SELECT tag, sha256 FROM "${table}"`).all());

  return new Map(rows.map((row) => [row.tag, row.sha256]));
}

function foreignKeysEnabled(sqlite: Database.Database): boolean {
  return sqlite.pragma("foreign_keys", { simple: true }) === 1;
}

function applyOne(
  sqlite: Database.Database,
  table: MigrationSet["table"],
  entry: MigrationEntry,
  now: () => number,
): void {
  sqlite.pragma("foreign_keys = OFF");

  if (foreignKeysEnabled(sqlite)) {
    throw new MigrationError(
      `Could not disable foreign keys before ${entry.tag}`,
    );
  }

  try {
    sqlite.exec("BEGIN IMMEDIATE");

    try {
      sqlite.exec(entry.sql);

      if (!sqlite.inTransaction) {
        throw new MigrationError(
          `Migration ${entry.tag} ended the runner's transaction`,
        );
      }

      const violations = z
        .array(z.unknown())
        .parse(sqlite.pragma("foreign_key_check"));

      if (violations.length > 0) {
        throw new MigrationError(
          `Migration ${entry.tag} left ${violations.length} foreign key violation(s)`,
        );
      }

      sqlite
        .prepare(
          `INSERT INTO "${table}" (tag, sha256, applied_at) VALUES (?, ?, ?)`,
        )
        .run(entry.tag, entry.sha256, now());
      sqlite.exec("COMMIT");
    } catch (error) {
      if (sqlite.inTransaction) sqlite.exec("ROLLBACK");

      if (error instanceof MigrationError) throw error;

      throw new MigrationError(
        `Migration ${entry.tag} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  if (!foreignKeysEnabled(sqlite)) {
    throw new MigrationError(
      `Could not re-enable foreign keys after ${entry.tag}`,
    );
  }
}

export function applyMigrationSet(
  sqlite: Database.Database,
  set: MigrationSet,
  now: () => number = Date.now,
): string[] {
  if (sqlite.inTransaction) {
    throw new MigrationError("Migrations must start outside a transaction");
  }

  ensureLedger(sqlite, set.table);
  const recorded = recordedMigrations(sqlite, set.table);
  const known = new Map(set.entries.map((entry) => [entry.tag, entry]));

  for (const [tag, sha256] of recorded) {
    const entry = known.get(tag);

    if (entry === undefined) {
      throw new MigrationError(
        `${set.table} records ${tag}, which no migration file provides`,
      );
    }

    if (entry.sha256 !== sha256) {
      throw new MigrationError(
        `Migration ${tag} changed after it was applied (recorded ${sha256}, file ${entry.sha256})`,
      );
    }
  }

  const applied: string[] = [];

  for (const entry of set.entries) {
    if (recorded.has(entry.tag)) continue;
    applyOne(sqlite, set.table, entry, now);
    applied.push(entry.tag);
  }

  return applied;
}

export function runRelayMigrations(
  sqlite: Database.Database,
  directories: MigrationDirectories,
  now: () => number = Date.now,
): AppliedMigrations {
  const connectDb = readConnectDbMigrations(directories.connectDb);
  const relayLocal = readRelayLocalMigrations(directories.relayLocal);

  return {
    connectDb: applyMigrationSet(sqlite, connectDb, now),
    relayLocal: applyMigrationSet(sqlite, relayLocal, now),
  };
}

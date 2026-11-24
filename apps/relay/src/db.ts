import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { schema } from "@omnyo/connect-db";
import {
  type AppliedMigrations,
  type MigrationDirectories,
  runRelayMigrations,
} from "./migrations.js";

export const SQLITE_BUSY_TIMEOUT_MS = 5000;

const IN_MEMORY_PATH = ":memory:";

const SYNCHRONOUS_NORMAL = 1;

const TEMP_STORE_MEMORY = 2;

export type RelayDb = BetterSQLite3Database<typeof schema>;

export interface RelayDatabase {
  sqlite: Database.Database;
  db: RelayDb;
  applied: AppliedMigrations;
  close(): void;
}

export class DatabaseSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseSetupError";
  }
}

function expectPragma(
  sqlite: Database.Database,
  name: string,
  expected: number | string,
): void {
  const actual = sqlite.pragma(name, { simple: true });

  if (actual !== expected) {
    throw new DatabaseSetupError(
      `SQLite pragma ${name} is ${String(actual)}, expected ${String(expected)}`,
    );
  }
}

export function applyRelayPragmas(
  sqlite: Database.Database,
  path: string,
): void {
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  expectPragma(sqlite, "busy_timeout", SQLITE_BUSY_TIMEOUT_MS);

  const journalMode = sqlite.pragma("journal_mode = WAL", { simple: true });
  const expectedJournalMode = path === IN_MEMORY_PATH ? "memory" : "wal";

  if (journalMode !== expectedJournalMode) {
    throw new DatabaseSetupError(
      `SQLite journal_mode is ${String(journalMode)}, expected ${expectedJournalMode}`,
    );
  }

  sqlite.pragma("synchronous = NORMAL");
  expectPragma(sqlite, "synchronous", SYNCHRONOUS_NORMAL);
  sqlite.pragma("temp_store = MEMORY");
  expectPragma(sqlite, "temp_store", TEMP_STORE_MEMORY);
  sqlite.pragma("foreign_keys = ON");
  expectPragma(sqlite, "foreign_keys", 1);
  sqlite.pragma("secure_delete = ON");
  expectPragma(sqlite, "secure_delete", 1);
}

export function openRelayDatabase(
  path: string,
  directories: MigrationDirectories,
  now: () => number = Date.now,
): RelayDatabase {
  const sqlite = new Database(path);

  try {
    applyRelayPragmas(sqlite, path);
    const applied = runRelayMigrations(sqlite, directories, now);
    expectPragma(sqlite, "foreign_keys", 1);

    return {
      sqlite,
      db: drizzle(sqlite, { schema }),
      applied,
      close: () => sqlite.close(),
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

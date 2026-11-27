import type Database from "better-sqlite3";
import { z } from "zod";

export type StateMachineDatabase = Database.Database;

export const migrationStatements = [
  `CREATE TABLE IF NOT EXISTS sm_quarantine (instance_id TEXT PRIMARY KEY, code TEXT NOT NULL, reference TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sm_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sm_machines (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_machines_project ON sm_machines(project_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS sm_versions (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, number INTEGER NOT NULL, document TEXT NOT NULL, UNIQUE(machine_id,number))`,
  `CREATE TABLE IF NOT EXISTS sm_instances (id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, version_id TEXT NOT NULL, project_id TEXT NOT NULL, environment_id TEXT NOT NULL, lifecycle TEXT NOT NULL, updated_at INTEGER NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_instances_version ON sm_instances(version_id)`,
  `CREATE INDEX IF NOT EXISTS sm_instances_scope ON sm_instances(project_id,lifecycle,updated_at)`,
  `CREATE TABLE IF NOT EXISTS sm_requests (scope TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, document TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(scope,request_id))`,
  `CREATE TABLE IF NOT EXISTS sm_entries (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, state_id TEXT NOT NULL, sequence INTEGER NOT NULL, closed_at INTEGER, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_entries_state ON sm_entries(instance_id,state_id,sequence)`,
  `CREATE INDEX IF NOT EXISTS sm_entries_instance ON sm_entries(instance_id, sequence)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS sm_entries_active ON sm_entries(instance_id) WHERE closed_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS sm_subscriptions (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_subscriptions_entry ON sm_subscriptions(entry_id)`,
  `CREATE INDEX IF NOT EXISTS sm_subscriptions_instance ON sm_subscriptions(instance_id,entry_id)`,
  `CREATE TABLE IF NOT EXISTS sm_inbox (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL, subscription_id TEXT, epoch INTEGER, dedup_key TEXT, payload_hash TEXT NOT NULL, document TEXT NOT NULL, UNIQUE(instance_id, subscription_id, epoch, dedup_key))`,
  `CREATE INDEX IF NOT EXISTS sm_inbox_entry ON sm_inbox(entry_id,status)`,
  `CREATE INDEX IF NOT EXISTS sm_inbox_pending ON sm_inbox(instance_id,status,sequence)`,
  `CREATE TABLE IF NOT EXISTS sm_invocations (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, status TEXT NOT NULL, environment_id TEXT NOT NULL, owned INTEGER NOT NULL, retired INTEGER NOT NULL DEFAULT 0, due_at INTEGER NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_invocations_retirement ON sm_invocations(retired,owned,due_at)`,
  `CREATE INDEX IF NOT EXISTS sm_invocations_entry_only ON sm_invocations(entry_id)`,
  `CREATE INDEX IF NOT EXISTS sm_invocations_due ON sm_invocations(owned,due_at)`,
  `CREATE INDEX IF NOT EXISTS sm_invocations_instance_owned ON sm_invocations(instance_id,owned)`,
  `CREATE INDEX IF NOT EXISTS sm_invocations_entry ON sm_invocations(instance_id,entry_id)`,
  `CREATE TABLE IF NOT EXISTS sm_retirements (attempt_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, byte_count INTEGER NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_retirements_entry ON sm_retirements(entry_id)`,
  `CREATE INDEX IF NOT EXISTS sm_retirements_instance ON sm_retirements(instance_id,created_at)`,
  `CREATE INDEX IF NOT EXISTS sm_retirements_due ON sm_retirements(due_at,attempt_id)`,
  `CREATE TABLE IF NOT EXISTS sm_attention (id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, entry_id TEXT NOT NULL, resolved_at INTEGER, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_attention_entry ON sm_attention(entry_id,resolved_at)`,
  `CREATE INDEX IF NOT EXISTS sm_attention_open ON sm_attention(instance_id,resolved_at)`,
  `CREATE TABLE IF NOT EXISTS sm_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, instance_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL, document TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sm_history_age ON sm_history(instance_id,created_at,sequence)`,
  `CREATE INDEX IF NOT EXISTS sm_history_instance ON sm_history(instance_id,sequence)`,
  `CREATE TABLE IF NOT EXISTS sm_checkpoints (instance_id TEXT PRIMARY KEY, through_sequence INTEGER NOT NULL, events_pruned INTEGER NOT NULL DEFAULT 0, entries_pruned INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)`,
];

export function migrateStateMachines(database: StateMachineDatabase): void {
  database.transaction(() => {
    const existing = database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sm_instances','sm_entries','sm_invocations','sm_retirements')",
      )
      .all();

    const tables = z.array(z.object({ name: z.string() })).parse(existing);

    for (const table of tables) {
      const columns = z
        .array(z.object({ name: z.string() }))
        .parse(database.prepare(`PRAGMA table_info(${table.name})`).all());

      if (
        table.name === "sm_instances" &&
        !columns.some((column) => column.name === "version_id")
      ) {
        database.exec("ALTER TABLE sm_instances ADD COLUMN version_id TEXT NOT NULL DEFAULT ''");
        database.exec(
          "UPDATE sm_instances SET version_id=json_extract(document,'$.versionId') WHERE json_valid(document)",
        );
      }

      if (table.name === "sm_entries" && !columns.some((column) => column.name === "state_id")) {
        database.exec("ALTER TABLE sm_entries ADD COLUMN state_id TEXT NOT NULL DEFAULT ''");
        database.exec(
          "UPDATE sm_entries SET state_id=json_extract(document,'$.stateId') WHERE json_valid(document)",
        );
      }

      if (table.name === "sm_retirements") {
        if (!columns.some((column) => column.name === "created_at")) {
          database.exec(
            "ALTER TABLE sm_retirements ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
          );
          database
            .prepare(
              "UPDATE sm_retirements SET created_at=COALESCE(json_extract(document,'$.quiescentAt'),?) WHERE json_valid(document)",
            )
            .run(Date.now());
        }

        if (!columns.some((column) => column.name === "byte_count"))
          database.exec(
            "ALTER TABLE sm_retirements ADD COLUMN byte_count INTEGER NOT NULL DEFAULT 0",
          );
      }

      if (table.name === "sm_invocations" && !columns.some((column) => column.name === "retired"))
        database.exec("ALTER TABLE sm_invocations ADD COLUMN retired INTEGER NOT NULL DEFAULT 0");
    }

    for (const sql of migrationStatements) database.exec(sql);
  })();
}

export interface SqliteDocumentRow {
  document: string;
}

export function row<T, Input>(schema: z.ZodType<T>, value: Input): T | null {
  const source = z.object({ document: z.string() }).optional().parse(value);

  if (!source) return null;

  return schema.parse(JSON.parse(source.document));
}

export function rows<T, Input>(schema: z.ZodType<T>, values: Input[]): T[] {
  return values.flatMap((value) => {
    const parsed = row(schema, value);

    return parsed === null ? [] : [parsed];
  });
}

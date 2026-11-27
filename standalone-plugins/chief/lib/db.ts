import type Database from "better-sqlite3";
import { z } from "zod";

export type SqlParam = string | number | null;

const sqlRowSchema = z.record(z.string(), z.union([z.string(), z.number(), z.bigint(), z.null()]));

export type SqlRow = z.infer<typeof sqlRowSchema>;

export interface Statement {
  run(...params: SqlParam[]): void;
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): SqlRow[];
}

export interface Sql {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

export function fromDriver(driver: Database.Database): Sql {
  return {
    exec: (sql) => {
      driver.exec(sql);
    },
    prepare: (sql) => {
      const statement = driver.prepare<SqlParam[]>(sql);

      return {
        run: (...params) => {
          statement.run(...params);
        },
        get: (...params) => {
          const row = statement.get(...params);

          return row === undefined ? undefined : sqlRowSchema.parse(row);
        },
        all: (...params) => statement.all(...params).map((row) => sqlRowSchema.parse(row)),
      };
    },
  };
}

export function one<S extends z.ZodType>(
  schema: S,
  row: SqlRow | undefined,
): z.output<S> | undefined {
  return row === undefined ? undefined : schema.parse(row);
}

export function many<S extends z.ZodType>(schema: S, rows: readonly SqlRow[]): z.output<S>[] {
  return rows.map((row) => schema.parse(row));
}

export const MIGRATIONS = [
  `CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE judges (
    thread_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('triage', 'distill', 'eval')),
    job_id TEXT,
    item_keys TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'recorded', 'failed', 'retired')),
    error TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE triage (
    item_key TEXT PRIMARY KEY,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    verdict TEXT,
    error TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX triage_thread ON triage (thread_id)`,
  `CREATE TABLE outcomes (
    id TEXT PRIMARY KEY,
    card_kind TEXT NOT NULL,
    action TEXT NOT NULL,
    thread_id TEXT,
    question_ids TEXT NOT NULL,
    project TEXT,
    tag TEXT,
    short_label TEXT,
    prompt TEXT,
    options TEXT NOT NULL,
    agent_recommended TEXT NOT NULL,
    chief_recommended TEXT NOT NULL,
    chosen TEXT NOT NULL,
    free_text TEXT,
    reason_chip TEXT,
    rule_ids TEXT NOT NULL,
    response_ms INTEGER,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX outcomes_scope ON outcomes (project, tag, at)`,
  `CREATE TABLE snoozes (card_key TEXT PRIMARY KEY, until INTEGER NOT NULL)`,
  `CREATE TABLE eval_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed', 'cancelled')),
    split_at INTEGER NOT NULL,
    until_at INTEGER NOT NULL,
    progress TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    ended_at INTEGER
  )`,
  `CREATE TABLE rules (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    cue TEXT NOT NULL,
    action TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('global', 'project', 'tag')),
    scope_value TEXT,
    level TEXT NOT NULL CHECK (level IN ('ask', 'veto', 'auto')),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    provenance TEXT NOT NULL CHECK (provenance IN ('learned', 'told')),
    evidence TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('candidate', 'adopted', 'superseded', 'retired')),
    owner_adopted INTEGER NOT NULL CHECK (owner_adopted IN (0, 1)),
    question_id TEXT,
    question_revision INTEGER,
    requested_level TEXT,
    replay_precision REAL,
    replay_matches INTEGER,
    matches INTEGER NOT NULL,
    overrides INTEGER NOT NULL,
    last_matched_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, version)
  )`,
  `CREATE TABLE delegated_answers (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    answer TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    reason TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting', 'unconfirmed', 'sent', 'uncertain', 'cancelled', 'corrected')),
    send_at INTEGER NOT NULL,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (question_id, revision)
  )`,
  `CREATE TABLE rule_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT,
    at INTEGER NOT NULL
  )`,
  `ALTER TABLE triage ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE rules ADD COLUMN label TEXT`,
];

export function applyMigrations(db: Sql, statements: readonly string[] = MIGRATIONS): void {
  for (const statement of statements) db.exec(statement);
}

const stateRowSchema = z.object({ value: z.string() });

export function readState(db: Sql, key: string): string | null {
  return (
    one(stateRowSchema, db.prepare("SELECT value FROM state WHERE key = ?").get(key))?.value ?? null
  );
}

export function writeState(db: Sql, key: string, value: string): void {
  db.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

const stringListSchema = z.array(z.string());

export function stringList(text: string | null): string[] {
  return text === null ? [] : stringListSchema.parse(JSON.parse(text));
}

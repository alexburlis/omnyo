import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type HistoryCacheKind = "outline" | "root" | "page";

export interface HistoryCacheRecord {
  key: string;
  threadId: string;
  sourceIdentity: string;
  rewriteEpoch: string;
  kind: HistoryCacheKind;
  body: string;
  createdAt: number;
  expiresAt: number | null;
  sequence: number;
}

export type HistoryCacheMetadata = Omit<HistoryCacheRecord, "body">;

export interface HistoryCacheReconcileOptions {
  sourceIdentity: string;
  now: number;
  afterKey?: string | null;
  limit?: number;
  isThreadEligible: (record: HistoryCacheMetadata) => boolean;
}

export interface HistoryCacheReconcileResult {
  nextKey: string | null;
  examined: number;
  removed: number;
}

export type HistoryCachePutResult = {
  status: "stored" | "unchanged" | "stale" | "expired" | "capacity";
};

export interface HistoryCacheStorageUsage {
  records: number;
  payloadBytes: number;
  databaseBytes: number;
  walBytes: number;
  sharedMemoryBytes: number;
  allocatedBytes: number | null;
}

export interface HistoryCache {
  get(args: {
    key: string;
    sourceIdentity: string;
    now: number;
  }): HistoryCacheRecord | null;
  batch<T>(write: () => T): T;
  put(record: HistoryCacheRecord): HistoryCachePutResult;
  purgeThread(threadId: string): number;
  touch(keys: readonly string[], now: number): number;
  reconcile(options: HistoryCacheReconcileOptions): HistoryCacheReconcileResult;
  storageUsage(): HistoryCacheStorageUsage;
  close(): void;
}

const CACHE_FILE_NAME = "history-cache.db";

export function historySourceIdentity(databasePath: string): string {
  const stat = statSync(databasePath);

  return createHash("sha256")
    .update(JSON.stringify([resolve(databasePath), stat.dev, stat.ino]))
    .digest("hex");
}

const SCHEMA_VERSION = 1;

const APPLICATION_ID = 0x42424843;

const MAX_PAYLOAD_BYTES = 128 * 1024 * 1024;

const MAX_RECORDS = 1024;

const MAX_IDENTITY_BYTES = 4096;

const MAX_RECONCILE_RECORDS = 256;

const ENTRY_LIMITS: Record<HistoryCacheKind, number> = {
  outline: 8 * 1024 * 1024,
  root: 4 * 1024 * 1024,
  page: 1024 * 1024,
};

const SCHEMA = [
  {
    name: "history_cache_records",
    sql: `CREATE TABLE history_cache_records (
      key TEXT PRIMARY KEY NOT NULL,
      thread_id TEXT NOT NULL,
      source_identity TEXT NOT NULL,
      rewrite_epoch TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('outline', 'root', 'page')),
      body TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      last_accessed_at INTEGER NOT NULL
    )`,
  },
  {
    name: "history_cache_source_thread_key_idx",
    sql: "CREATE INDEX history_cache_source_thread_key_idx ON history_cache_records (source_identity, thread_id, key)",
  },
  {
    name: "history_cache_thread_key_idx",
    sql: "CREATE INDEX history_cache_thread_key_idx ON history_cache_records (thread_id, key)",
  },
  {
    name: "history_cache_expiry_key_idx",
    sql: "CREATE INDEX history_cache_expiry_key_idx ON history_cache_records (expires_at, key)",
  },
  {
    name: "history_cache_access_key_idx",
    sql: "CREATE INDEX history_cache_access_key_idx ON history_cache_records (last_accessed_at, key)",
  },
];

const RECORD_COLUMNS = `key, thread_id AS threadId, source_identity AS sourceIdentity, rewrite_epoch AS rewriteEpoch,
  kind, body, created_at AS createdAt, expires_at AS expiresAt, sequence`;

const METADATA_COLUMNS = `key, thread_id AS threadId, source_identity AS sourceIdentity, rewrite_epoch AS rewriteEpoch,
  kind, created_at AS createdAt, expires_at AS expiresAt, sequence`;

function normalizeSchemaSql(sql: string): string {
  return sql.replace(/\s+/gu, " ").trim();
}

function assertIdentity(value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTITY_BYTES
  )
    throw new TypeError("Invalid history cache identity");
}

function assertInteger(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError("Invalid history cache timestamp or sequence");
}

function assertRecord(record: HistoryCacheRecord): void {
  assertIdentity(record.key);
  assertIdentity(record.threadId);
  assertIdentity(record.sourceIdentity);
  assertIdentity(record.rewriteEpoch);
  assertInteger(record.createdAt);
  assertInteger(record.sequence);

  if (record.expiresAt !== null) assertInteger(record.expiresAt);

  if (
    (record.kind !== "outline" &&
      record.kind !== "root" &&
      record.kind !== "page") ||
    typeof record.body !== "string"
  )
    throw new TypeError("Invalid history cache record");
}

function validateSchema(sqlite: Database.Database): void {
  if (
    sqlite.pragma("application_id", { simple: true }) !== APPLICATION_ID ||
    sqlite.pragma("user_version", { simple: true }) !== SCHEMA_VERSION
  )
    throw new Error("Unsupported history cache schema");

  const entries = sqlite
    .prepare<[], { name: string; sql: string }>(
      "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
    )
    .all();

  if (
    entries.length !== SCHEMA.length ||
    !SCHEMA.every((expected) =>
      entries.some(
        (entry) =>
          entry.name === expected.name &&
          normalizeSchemaSql(entry.sql) === normalizeSchemaSql(expected.sql),
      ),
    )
  )
    throw new Error("Unsupported history cache schema");
}

function fileUsage(path: string): {
  bytes: number;
  allocatedBytes: number | null;
} {
  try {
    const file = statSync(path);

    return {
      bytes: file.size,
      allocatedBytes: process.platform === "win32" ? null : file.blocks * 512,
    };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { bytes: 0, allocatedBytes: 0 };

    throw error;
  }
}

export function historyCachePath(primaryPath: string): string {
  if (
    primaryPath === ":memory:" ||
    primaryPath.length === 0 ||
    primaryPath.startsWith("file:") ||
    basename(primaryPath) === CACHE_FILE_NAME
  )
    throw new Error("History cache requires a separate primary database file");

  return join(dirname(resolve(primaryPath)), CACHE_FILE_NAME);
}

export function openHistoryCache(
  path: string,
  options: { readonly?: boolean } = {},
): HistoryCache {
  const cachePath = resolve(path);

  if (basename(cachePath) !== CACHE_FILE_NAME)
    throw new Error("History cache must use its dedicated database file");

  const readonly = options.readonly ?? false;
  let created = false;

  if (!readonly && !existsSync(cachePath)) {
    try {
      closeSync(openSync(cachePath, "wx", 0o600));
      created = true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
  }

  const file = lstatSync(cachePath);

  if (!file.isFile() || file.nlink !== 1)
    throw new Error("History cache requires a dedicated regular file");

  const sqlite = new Database(cachePath, {
    readonly,
    fileMustExist: true,
    timeout: 1000,
  });

  try {
    if (created) {
      sqlite.pragma("auto_vacuum = INCREMENTAL");
      sqlite
        .transaction(() => {
          for (const entry of SCHEMA) sqlite.exec(entry.sql);
          sqlite.pragma(`application_id = ${APPLICATION_ID}`);
          sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
        })
        .immediate();
    }

    validateSchema(sqlite);

    if (!readonly) {
      chmodSync(cachePath, 0o600);
      sqlite.pragma("journal_mode = WAL");
      sqlite.pragma("synchronous = NORMAL");
      sqlite.pragma("wal_autocheckpoint = 256");
      sqlite.pragma("journal_size_limit = 16777216");
    }

    sqlite.pragma("cache_size = -8192");
    sqlite.pragma("mmap_size = 0");

    const readRecord = sqlite.prepare<
      { key: string; sourceIdentity: string; now: number },
      HistoryCacheRecord
    >(`SELECT ${RECORD_COLUMNS} FROM history_cache_records
      WHERE key = @key AND source_identity = @sourceIdentity
      AND created_at <= @now AND (expires_at IS NULL OR expires_at > @now)`);

    const existingRecord = sqlite.prepare<[string], HistoryCacheRecord>(
      `SELECT ${RECORD_COLUMNS} FROM history_cache_records WHERE key = ?`,
    );

    const hasRecord = sqlite.prepare<[string], { present: number }>(
      "SELECT 1 AS present FROM history_cache_records WHERE key = ?",
    );

    const accessRecord = readonly
      ? null
      : sqlite.prepare(
          "UPDATE history_cache_records SET last_accessed_at = MAX(last_accessed_at, ?) WHERE key = ?",
        );

    const deleteExpired = sqlite.prepare(
      "DELETE FROM history_cache_records WHERE expires_at <= ?",
    );

    const deleteKey = sqlite.prepare(
      "DELETE FROM history_cache_records WHERE key = ?",
    );

    const deleteThread = sqlite.prepare(
      "DELETE FROM history_cache_records WHERE thread_id = ?",
    );

    const upsertRecord = sqlite.prepare(`
      INSERT INTO history_cache_records
        (key, thread_id, source_identity, rewrite_epoch, kind, body, byte_size, created_at, expires_at, sequence, last_accessed_at)
      VALUES (@key, @threadId, @sourceIdentity, @rewriteEpoch, @kind, @body, @byteSize, @createdAt, @expiresAt, @sequence, @now)
      ON CONFLICT (key) DO UPDATE SET
        thread_id = excluded.thread_id, source_identity = excluded.source_identity,
        rewrite_epoch = excluded.rewrite_epoch,
        kind = excluded.kind, body = excluded.body, byte_size = excluded.byte_size,
        created_at = excluded.created_at, expires_at = excluded.expires_at,
        sequence = excluded.sequence, last_accessed_at = excluded.last_accessed_at
    `);

    const prune = sqlite.prepare(`
      DELETE FROM history_cache_records WHERE key IN (
        SELECT key FROM (
          SELECT key,
            SUM(byte_size) OVER (ORDER BY last_accessed_at DESC, key DESC ROWS UNBOUNDED PRECEDING) AS retained_bytes,
            ROW_NUMBER() OVER (ORDER BY last_accessed_at DESC, key DESC) AS retained_count
          FROM history_cache_records
        ) WHERE retained_bytes > ? OR retained_count > ?
      )
    `);

    const usage = sqlite.prepare<[], { records: number; payloadBytes: number }>(
      "SELECT COUNT(*) AS records, COALESCE(SUM(byte_size), 0) AS payloadBytes FROM history_cache_records",
    );

    const metadata = sqlite.prepare<
      [string, number],
      HistoryCacheMetadata
    >(`SELECT ${METADATA_COLUMNS} FROM history_cache_records
      WHERE key > ? ORDER BY key LIMIT ?`);

    function assertWritable(): void {
      if (readonly) throw new Error("History cache is readonly");
    }

    const put = sqlite.transaction(
      (
        record: HistoryCacheRecord,
        byteSize: number,
        now: number,
      ): HistoryCachePutResult => {
        deleteExpired.run(now);
        const previous = existingRecord.get(record.key);

        if (previous?.sourceIdentity === record.sourceIdentity) {
          if (
            previous.threadId !== record.threadId ||
            previous.kind !== record.kind
          )
            throw new Error("History cache key has a different binding");

          if (previous.rewriteEpoch === record.rewriteEpoch) {
            if (previous.sequence > record.sequence) return { status: "stale" };

            if (previous.sequence === record.sequence) {
              if (previous.body !== record.body)
                throw new Error(
                  "History cache record changed without a new sequence",
                );

              accessRecord?.run(now, record.key);

              return { status: "unchanged" };
            }
          }
        }

        upsertRecord.run({ ...record, byteSize, now });
        prune.run(MAX_PAYLOAD_BYTES, MAX_RECORDS);

        return {
          status: hasRecord.get(record.key) ? "stored" : "capacity",
        };
      },
    );

    const reconcile = sqlite.transaction(
      (args: HistoryCacheReconcileOptions): HistoryCacheReconcileResult => {
        const limit = Math.min(
          args.limit ?? MAX_RECONCILE_RECORDS,
          MAX_RECONCILE_RECORDS,
        );

        if (!Number.isSafeInteger(limit) || limit < 1)
          throw new TypeError("Invalid history cache reconciliation limit");

        const rows = metadata.all(args.afterKey ?? "", limit + 1);
        const batch = rows.slice(0, limit);
        let removed = 0;

        for (const record of batch) {
          if (
            record.sourceIdentity !== args.sourceIdentity ||
            (record.expiresAt !== null && record.expiresAt <= args.now) ||
            !args.isThreadEligible(record)
          )
            removed += deleteKey.run(record.key).changes;
        }

        return {
          nextKey: rows.length > limit ? (batch.at(-1)?.key ?? null) : null,
          examined: batch.length,
          removed,
        };
      },
    );

    return {
      batch(write) {
        assertWritable();

        return sqlite.transaction(write).immediate();
      },
      get(args) {
        assertIdentity(args.key);
        assertIdentity(args.sourceIdentity);
        assertInteger(args.now);
        const record = readRecord.get(args) ?? null;

        if (record) accessRecord?.run(args.now, record.key);

        return record;
      },
      put(record) {
        assertWritable();
        assertRecord(record);
        const now = Date.now();

        if (record.expiresAt !== null && record.expiresAt <= now)
          return { status: "expired" };

        if (record.createdAt > now) return { status: "stale" };

        const byteSize = Buffer.byteLength(record.body, "utf8");

        if (byteSize > ENTRY_LIMITS[record.kind]) return { status: "capacity" };

        return put.immediate(record, byteSize, now);
      },
      purgeThread(threadId) {
        assertWritable();
        assertIdentity(threadId);

        return deleteThread.run(threadId).changes;
      },
      touch(keys, now) {
        assertWritable();
        assertInteger(now);

        for (const key of keys) assertIdentity(key);

        return sqlite
          .transaction(() =>
            keys.reduce(
              (changes, key) =>
                changes + (accessRecord?.run(now, key).changes ?? 0),
              0,
            ),
          )
          .immediate();
      },
      reconcile(args) {
        assertWritable();
        assertIdentity(args.sourceIdentity);
        assertInteger(args.now);

        return reconcile.immediate(args);
      },
      storageUsage() {
        const totals = usage.get();

        if (!totals) throw new Error("History cache usage is unavailable");

        const database = fileUsage(cachePath);
        const wal = fileUsage(`${cachePath}-wal`);
        const sharedMemory = fileUsage(`${cachePath}-shm`);

        return {
          ...totals,
          databaseBytes: database.bytes,
          walBytes: wal.bytes,
          sharedMemoryBytes: sharedMemory.bytes,
          allocatedBytes:
            database.allocatedBytes === null ||
            wal.allocatedBytes === null ||
            sharedMemory.allocatedBytes === null
              ? null
              : database.allocatedBytes +
                wal.allocatedBytes +
                sharedMemory.allocatedBytes,
        };
      },
      close() {
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();

    throw error;
  }
}

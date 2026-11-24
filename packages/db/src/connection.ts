import Database from "better-sqlite3";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { resourceUsage, threadCpuUsage } from "node:process";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { registerHostPathSqlFunctions } from "./data/host-path-sql.js";
import { startBackgroundCheckpoint } from "./background-checkpoint.js";
import {
  finishQueryDiagnostics,
  type QueryDiagnosticsLogFields,
} from "./query-diagnostics.js";
import * as schema from "./schema.js";

export interface SlowDbQueryLogFields {
  bindingArgumentCount: number;
  durationMs: number;
  cpuDurationMs: number;
  operation: SlowDbQueryOperation;
  sql: string;
  thresholdMs: number;
  work?: string;
  nested?: boolean;
  diagnostics?: QueryDiagnosticsLogFields;
}

export interface SlowDbQueryLogger {
  info(fields: SlowDbQueryLogFields, message: string): void;
}

export interface CreateConnectionOptions {
  backgroundCheckpoint?: { onError: (error: Error) => void };
  readonly?: boolean;
  cacheSizeKiB?: number;
  mmapSizeBytes?: number;
  slowQueryLogger?: SlowDbQueryLogger;
  slowQueryThresholdMs?: number | (() => number);
  slowQueryDiagnosticsEnabled?: () => boolean;
  slowQueryWork?: () => string | null;
}

export type DbConnection = ReturnType<typeof createConnection>;

export type DbTransaction = Parameters<
  Parameters<DbConnection["transaction"]>[0]
>[0];

export type DbQueryConnection = DbConnection | DbTransaction;

export type SlowDbQueryOperation =
  | "all"
  | "get"
  | "run"
  | "exec"
  | "transaction";

const compiledQueries = new WeakMap<
  DbQueryConnection,
  Map<(db: DbQueryConnection) => unknown, unknown>
>();

export function prepareCachedQuery<TQuery>(
  db: DbQueryConnection,
  build: (db: DbQueryConnection) => TQuery,
): TQuery {
  let queries = compiledQueries.get(db);

  if (!queries) {
    queries = new Map();
    compiledQueries.set(db, queries);
  }

  if (queries.has(build)) return queries.get(build) as TQuery;
  const query = build(db);
  queries.set(build, query);

  return query;
}

interface SlowDbQueryConfig {
  logger: SlowDbQueryLogger;
  thresholdMs: number | (() => number);
  walPath: string | null;
  diagnosticsEnabled: () => boolean;
  work: () => string | null;
  inTransaction: () => boolean;
}

interface TimedStatementOperationArgs<TValue> {
  bindingArgumentCount: number;
  config: SlowDbQueryConfig;
  operation: SlowDbQueryOperation;
  source: string;
  work: () => TValue;
}

const DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS = 100;

export const SQLITE_CACHE_SIZE_KIB = 262_144;

export const SQLITE_MMAP_SIZE_BYTES = 1_073_741_824;

export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

const MAX_LOGGED_SQL_LENGTH = 1_000;

const SQL_TRUNCATION_SUFFIX = "...";

const SQL_STRING_LITERAL_PATTERN = /'(?:''|[^'])*'/gu;

const SQL_WHITESPACE_PATTERN = /\s+/gu;

function roundDurationMs(durationMs: number): number {
  return Math.round(durationMs * 10) / 10;
}

function formatSqlForLog(source: string): string {
  const redacted = source.replace(SQL_STRING_LITERAL_PATTERN, "'?'");
  const normalized = redacted.replace(SQL_WHITESPACE_PATTERN, " ").trim();

  if (normalized.length <= MAX_LOGGED_SQL_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(
    0,
    MAX_LOGGED_SQL_LENGTH - SQL_TRUNCATION_SUFFIX.length,
  )}${SQL_TRUNCATION_SUFFIX}`;
}

function runTimedStatementOperation<TValue>(
  args: TimedStatementOperationArgs<TValue>,
): TValue {
  const startedUsage = args.config.diagnosticsEnabled()
    ? resourceUsage()
    : null;

  const nested = args.config.inTransaction();
  const startedCpu = threadCpuUsage();
  const startedAt = performance.now();

  try {
    return args.work();
  } finally {
    const durationMs = performance.now() - startedAt;

    const thresholdMs =
      typeof args.config.thresholdMs === "function"
        ? args.config.thresholdMs()
        : args.config.thresholdMs;

    if (durationMs >= thresholdMs) {
      const cpu = threadCpuUsage(startedCpu);
      const finishedUsage = startedUsage ? resourceUsage() : null;
      const work = args.config.work();
      args.config.logger.info(
        {
          bindingArgumentCount: args.bindingArgumentCount,
          durationMs: roundDurationMs(durationMs),
          cpuDurationMs: roundDurationMs((cpu.user + cpu.system) / 1_000),
          operation: args.operation,
          sql: formatSqlForLog(args.source),
          thresholdMs,
          ...(work === null ? {} : { work }),
          ...(nested ? { nested: true } : {}),
          ...(startedUsage && finishedUsage
            ? {
                diagnostics: finishQueryDiagnostics(
                  startedUsage,
                  finishedUsage,
                  args.config.walPath,
                ),
              }
            : {}),
        },
        "Slow DB query",
      );
    }
  }
}

function instrumentStatement(
  statement: Database.Statement,
  source: string,
  config: SlowDbQueryConfig,
): Database.Statement {
  const originalAll = statement.all.bind(statement);
  const originalGet = statement.get.bind(statement);
  const originalRun = statement.run.bind(statement);

  statement.all = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "all",
      source,
      work: () => originalAll(...params),
    });
  statement.get = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "get",
      source,
      work: () => originalGet(...params),
    });
  statement.run = (...params) =>
    runTimedStatementOperation({
      bindingArgumentCount: params.length,
      config,
      operation: "run",
      source,
      work: () => originalRun(...params),
    });

  return statement;
}

export const STATEMENT_CACHE_SIZE = 512;

const CACHEABLE_STATEMENT =
  /^\s*(?:select|with|insert|update|delete|replace)\b/i;

function resetRawModeAfterReads(
  statement: Database.Statement,
): Database.Statement {
  if (!statement.reader) return statement;

  const originalAll = statement.all.bind(statement);
  const originalGet = statement.get.bind(statement);

  statement.all = (...params) => {
    try {
      return originalAll(...params);
    } finally {
      statement.raw(false);
    }
  };

  statement.get = (...params) => {
    try {
      return originalGet(...params);
    } finally {
      statement.raw(false);
    }
  };

  return statement;
}

function installStatementCache(
  sqlite: Database.Database,
  wrap: (statement: Database.Statement, source: string) => Database.Statement,
): void {
  const originalPrepare: Database.Database["prepare"] =
    sqlite.prepare.bind(sqlite);

  const statements = new Map<string, Database.Statement>();

  function prepare(source: string): Database.Statement {
    const cached = statements.get(source);

    if (cached !== undefined && !cached.busy) {
      statements.delete(source);
      statements.set(source, cached);

      return cached;
    }

    const statement = wrap(
      resetRawModeAfterReads(originalPrepare(source)),
      source,
    );

    if (cached !== undefined || !CACHEABLE_STATEMENT.test(source))
      return statement;
    statements.set(source, statement);

    if (statements.size > STATEMENT_CACHE_SIZE) {
      const [oldest] = statements.keys();

      if (oldest !== undefined) statements.delete(oldest);
    }

    return statement;
  }

  Object.defineProperty(sqlite, "prepare", {
    configurable: true,
    value: prepare,
    writable: true,
  });
}

function instrumentSqliteClient(
  sqlite: Database.Database,
  options: CreateConnectionOptions,
): void {
  if (!options.slowQueryLogger) {
    installStatementCache(sqlite, (statement) => statement);

    return;
  }

  const config: SlowDbQueryConfig = {
    logger: options.slowQueryLogger,
    thresholdMs:
      options.slowQueryThresholdMs ?? DEFAULT_SLOW_DB_QUERY_LOG_THRESHOLD_MS,
    walPath: sqlite.memory ? null : `${resolve(sqlite.name)}-wal`,
    diagnosticsEnabled: options.slowQueryDiagnosticsEnabled ?? (() => false),
    work: options.slowQueryWork ?? (() => null),
    inTransaction: () => sqlite.inTransaction,
  };

  const originalExec = sqlite.exec.bind(sqlite);
  sqlite.exec = (source) =>
    runTimedStatementOperation({
      bindingArgumentCount: 0,
      config,
      operation: "exec",
      source,
      work: () => originalExec(source),
    });
  const originalTransaction = sqlite.transaction.bind(sqlite);
  sqlite.transaction = (fn) => {
    const original = originalTransaction(fn);

    function wrap(mode: "default" | "deferred" | "immediate" | "exclusive") {
      return function (this: unknown, ...params: Parameters<typeof original>) {
        return runTimedStatementOperation({
          bindingArgumentCount: params.length,
          config,
          operation: "transaction",
          source: `TRANSACTION ${mode.toUpperCase()}`,
          work: () => original[mode].apply(this, params),
        });
      };
    }

    const modes = {
      default: wrap("default"),
      deferred: wrap("deferred"),
      immediate: wrap("immediate"),
      exclusive: wrap("exclusive"),
    };

    const transaction = Object.assign(modes.default, modes);

    for (const mode of Object.values(modes)) {
      Object.defineProperties(mode, {
        default: {
          value: modes.default,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        deferred: {
          value: modes.deferred,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        immediate: {
          value: modes.immediate,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        exclusive: {
          value: modes.exclusive,
          enumerable: false,
          writable: false,
          configurable: false,
        },
        database: { value: sqlite, enumerable: true },
      });
    }

    return transaction;
  };

  installStatementCache(sqlite, (statement, source) =>
    instrumentStatement(statement, source, config),
  );
}

export function createConnection(
  source: string | Buffer,
  options: CreateConnectionOptions = {},
) {
  const sqlite = new Database(source, { readonly: options.readonly ?? false });

  if (!options.readonly) {
    sqlite.pragma("auto_vacuum = INCREMENTAL");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = NORMAL");
  }

  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma(
    `cache_size = -${options.cacheSizeKiB ?? SQLITE_CACHE_SIZE_KIB}`,
  );
  sqlite.pragma(
    `mmap_size = ${options.mmapSizeBytes ?? SQLITE_MMAP_SIZE_BYTES}`,
  );
  sqlite.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  registerHostPathSqlFunctions(sqlite);
  instrumentSqliteClient(sqlite, options);

  const stopCheckpoint =
    options.backgroundCheckpoint !== undefined && !sqlite.readonly
      ? startBackgroundCheckpoint(sqlite, options.backgroundCheckpoint.onError)
      : () => {};

  const db = drizzle({ client: sqlite, schema });
  const queries = new Map<(db: DbQueryConnection) => unknown, unknown>();
  compiledQueries.set(db, queries);
  const originalTransaction = db.transaction.bind(db);
  db.transaction = (work, config) =>
    originalTransaction((tx) => {
      compiledQueries.set(tx, queries);

      return work(tx);
    }, config);
  const originalClose = sqlite.close.bind(sqlite);
  sqlite.close = () => {
    stopCheckpoint();
    const result = originalClose();
    queries.clear();

    return result;
  };

  return db;
}

export class PrimaryWriteBusyError extends Error {
  readonly waitMs: number;

  constructor(waitMs: number, options?: ErrorOptions) {
    super(`Primary write lock was not acquired within ${waitMs} ms`, options);
    this.name = "PrimaryWriteBusyError";
    this.waitMs = waitMs;
  }
}

function isSqliteBusyError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_BUSY")
  );
}

function readBusyTimeoutMs(sqlite: Database.Database): number {
  const value: unknown = sqlite.pragma("busy_timeout", { simple: true });

  if (typeof value !== "number") {
    throw new Error("SQLite did not report a numeric busy timeout");
  }

  return value;
}

const BUSY_RETRY_STEP_MS = 10;

const busyRetrySleeper = new Int32Array(new SharedArrayBuffer(4));

function sleepSynchronously(milliseconds: number): void {
  Atomics.wait(busyRetrySleeper, 0, 0, milliseconds);
}

export function runImmediateTransactionWithBusyWait<TResult>(
  db: DbConnection,
  waitMs: number,
  work: (tx: DbTransaction) => TResult,
): TResult {
  if (!Number.isInteger(waitMs) || waitMs < 0) {
    throw new Error("Bounded write admission needs a whole, non-negative wait");
  }

  const sqlite = db.$client;

  if (sqlite.inTransaction) {
    throw new Error(
      "Bounded write admission cannot start inside an open transaction",
    );
  }

  const previousWaitMs = readBusyTimeoutMs(sqlite);
  const startedAt = performance.now();
  let started = false;
  sqlite.pragma("busy_timeout = 0");

  try {
    for (;;) {
      try {
        return db.transaction(
          (tx) => {
            started = true;
            sqlite.pragma(`busy_timeout = ${previousWaitMs}`);

            return work(tx);
          },
          { behavior: "immediate" },
        );
      } catch (error) {
        if (started || !isSqliteBusyError(error)) {
          throw error;
        }

        const remainingMs = waitMs - (performance.now() - startedAt);

        if (remainingMs <= 0) {
          throw new PrimaryWriteBusyError(waitMs, { cause: error });
        }

        sleepSynchronously(Math.min(BUSY_RETRY_STEP_MS, remainingMs));
      }
    }
  } finally {
    sqlite.pragma(`busy_timeout = ${previousWaitMs}`);
  }
}

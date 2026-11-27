import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceUsage } from "node:process";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  createConnection,
  PrimaryWriteBusyError,
  runImmediateTransactionWithBusyWait,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_CACHE_SIZE_KIB,
  SQLITE_MMAP_SIZE_BYTES,
  type SlowDbQueryLogger,
  type SlowDbQueryLogFields,
} from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { hosts } from "../src/schema.js";

interface LoggedInfo {
  fields: SlowDbQueryLogFields;
  message: string;
}

class CapturingSlowQueryLogger implements SlowDbQueryLogger {
  readonly infoLogs: LoggedInfo[] = [];

  info(fields: SlowDbQueryLogFields, message: string): void {
    this.infoLogs.push({ fields, message });
  }

  clear(): void {
    this.infoLogs.length = 0;
  }
}

function getOnlyInfoLog(logger: CapturingSlowQueryLogger): LoggedInfo {
  expect(logger.infoLogs).toHaveLength(1);
  const infoLog = logger.infoLogs[0];

  if (!infoLog) {
    throw new Error("Expected slow query info log");
  }

  return infoLog;
}

describe("createConnection", () => {
  it("distinguishes time waiting inside SQLite from CPU work", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
      slowQueryDiagnosticsEnabled: () => true,
    });

    migrate(db);

    try {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      let insideBefore = resourceUsage();
      let insideAfter = insideBefore;
      db.$client.function("wait_for_io", () => {
        insideBefore = resourceUsage();
        const pages = Buffer.alloc(32 * 1024 * 1024, 1);
        Atomics.wait(signal, 0, 0, 100);
        insideAfter = resourceUsage();

        return 6 + pages[0]!;
      });
      logger.clear();
      const outsideBefore = resourceUsage();
      expect(db.$client.prepare("SELECT wait_for_io() AS value").get()).toEqual(
        { value: 7 },
      );
      const outsideAfter = resourceUsage();
      const { fields } = getOnlyInfoLog(logger);
      expect(fields.durationMs).toBeGreaterThanOrEqual(90);
      expect(fields.cpuDurationMs).toBeGreaterThanOrEqual(0);
      expect(fields.durationMs - fields.cpuDurationMs).toBeGreaterThan(50);
      const diagnostics = fields.diagnostics;
      expect(diagnostics).toBeDefined();

      if (!diagnostics) throw new Error("Expected diagnostic attribution");

      for (const key of [
        "minorPageFault",
        "majorPageFault",
        "fsRead",
        "fsWrite",
        "voluntaryContextSwitches",
        "involuntaryContextSwitches",
      ] as const) {
        expect(diagnostics.resourceUsage[key]).toBeGreaterThanOrEqual(
          insideAfter[key] - insideBefore[key],
        );
        expect(diagnostics.resourceUsage[key]).toBeLessThanOrEqual(
          outsideAfter[key] - outsideBefore[key],
        );
      }

      expect(diagnostics.wal).toEqual({ sizeBytes: null });
    } finally {
      db.$client.close();
    }
  });

  it("samples WAL size with the live diagnostic gate on already-prepared statements", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-db-attribution-"));
    const databasePath = join(directory, "app.db");
    const logger = new CapturingSlowQueryLogger();
    let diagnosticsEnabled = false;

    const db = createConnection(databasePath, {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
      slowQueryDiagnosticsEnabled: () => diagnosticsEnabled,
    });

    try {
      migrate(db);
      db.$client.exec("CREATE TABLE diagnostic_values (value INTEGER)");
      db.$client.exec("INSERT INTO diagnostic_values VALUES (0)");

      const update = db.$client.prepare(
        "UPDATE diagnostic_values SET value = value + 1",
      );

      logger.clear();
      update.run();
      expect(getOnlyInfoLog(logger).fields).not.toHaveProperty("diagnostics");

      for (let i = 0; i < 2; i++) {
        diagnosticsEnabled = true;
        logger.clear();
        update.run();
        expect(getOnlyInfoLog(logger).fields.diagnostics?.wal).toEqual({
          sizeBytes: statSync(`${databasePath}-wal`).size,
        });
        expect(statSync(`${databasePath}-wal`).size).toBeGreaterThan(0);

        diagnosticsEnabled = false;
        logger.clear();
        update.run();
        expect(getOnlyInfoLog(logger).fields).not.toHaveProperty("diagnostics");
      }

      diagnosticsEnabled = true;
      db.$client.pragma("journal_mode = DELETE");
      logger.clear();
      update.run();
      expect(getOnlyInfoLog(logger).fields.diagnostics?.wal).toEqual({
        sizeBytes: null,
      });
    } finally {
      db.$client.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the work that issued a slow statement", () => {
    const logger = new CapturingSlowQueryLogger();
    let work: string | null = "sweep:retention > plugin:storage delete";

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
      slowQueryWork: () => work,
    });

    migrate(db);

    try {
      const statement = db.$client.prepare("SELECT 1");
      logger.clear();
      statement.get();
      expect(getOnlyInfoLog(logger).fields.work).toBe(
        "sweep:retention > plugin:storage delete",
      );
      logger.clear();
      work = null;
      statement.get();
      expect(getOnlyInfoLog(logger).fields).not.toHaveProperty("work");
    } finally {
      db.$client.close();
    }
  });

  it("marks work that ran inside an open transaction as nested", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    try {
      db.transaction(() => {
        db.$client.prepare("SELECT 1").get();
        db.transaction(() => undefined);
      });

      expect(
        logger.infoLogs.map((log) => ({
          nested: log.fields.nested ?? false,
          operation: log.fields.operation,
        })),
      ).toEqual([
        { nested: true, operation: "get" },
        { nested: true, operation: "transaction" },
        { nested: false, operation: "transaction" },
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("applies live thresholds to statements prepared before the setting changed", () => {
    const logger = new CapturingSlowQueryLogger();
    let thresholdMs = Infinity;

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: () => thresholdMs,
    });

    migrate(db);

    try {
      const statement = db.$client.prepare("SELECT 1");
      statement.get();
      expect(logger.infoLogs).toHaveLength(0);
      thresholdMs = 0;
      statement.get();
      expect(getOnlyInfoLog(logger).fields.thresholdMs).toBe(0);
      logger.clear();
      thresholdMs = Infinity;
      statement.get();
      expect(logger.infoLogs).toHaveLength(0);
    } finally {
      db.$client.close();
    }
  });

  it.each(["default", "deferred", "immediate", "exclusive"] as const)(
    "times complete %s transactions and exec while preserving rollback and receivers",
    (mode) => {
      const logger = new CapturingSlowQueryLogger();

      const db = createConnection(":memory:", {
        slowQueryLogger: logger,
        slowQueryThresholdMs: 0,
      });

      migrate(db);

      try {
        db.$client.exec("CREATE TABLE diagnostic_values (value TEXT)");
        logger.clear();
        expect(
          db.$client.exec(
            "INSERT INTO diagnostic_values VALUES ('private-value')",
          ),
        ).toBe(db.$client);
        expect(getOnlyInfoLog(logger).fields).toMatchObject({
          operation: "exec",
          sql: "INSERT INTO diagnostic_values VALUES ('?')",
        });

        const nested = db.$client.transaction(() => {
          db.$client.exec(
            "INSERT INTO diagnostic_values VALUES ('rolled-back')",
          );
          throw new Error("rollback nested transaction");
        });

        const transaction = db.$client.transaction(function (
          this: { prefix: string },
          value: string,
        ) {
          db.$client
            .prepare("INSERT INTO diagnostic_values VALUES (?)")
            .run(value);
          expect(() => nested()).toThrow("rollback nested transaction");

          return this.prefix + value;
        });

        logger.clear();
        expect(transaction[mode].call({ prefix: "result:" }, "committed")).toBe(
          "result:committed",
        );

        const transactions = logger.infoLogs.filter(
          (log) => log.fields.operation === "transaction",
        );

        expect(transactions.map((log) => log.fields.sql)).toEqual([
          "TRANSACTION DEFAULT",
          `TRANSACTION ${mode.toUpperCase()}`,
        ]);
        expect(transactions[1]?.fields).toMatchObject({
          bindingArgumentCount: 1,
          cpuDurationMs: expect.any(Number),
          durationMs: expect.any(Number),
        });
        expect(
          db.$client
            .prepare("SELECT value FROM diagnostic_values ORDER BY value")
            .all(),
        ).toEqual([{ value: "committed" }, { value: "private-value" }]);
        expect(transaction.default).toBe(transaction);
        expect(Reflect.get(transaction[mode], "database")).toBe(db.$client);
      } finally {
        db.$client.close();
      }
    },
  );

  it("logs slow prepared statement executions without parameter values", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT ? AS value").get("sensitive-value");

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.message).toBe("Slow DB query");
    expect(infoLog.fields).not.toHaveProperty("diagnostics");
    expect(infoLog.fields.operation).toBe("get");
    expect(infoLog.fields.bindingArgumentCount).toBe(1);
    expect(infoLog.fields.sql).toBe("SELECT ? AS value");
    expect(infoLog.fields.sql).not.toContain("sensitive-value");

    db.$client.close();
  });

  it("redacts SQL string literals in slow query logs", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    db.$client.prepare("SELECT 'sensitive-literal' AS value").get();

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.fields.sql).toBe("SELECT '?' AS value");
    expect(infoLog.fields.sql).not.toContain("sensitive-literal");

    db.$client.close();
  });

  it("logs slow drizzle ORM statement executions", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    migrate(db);
    db.insert(hosts)
      .values({
        createdAt: 1,
        id: "host-drizzle",
        name: "Drizzle Host",
        type: "persistent",
        updatedAt: 1,
      })
      .run();
    logger.clear();

    const row = db
      .select()
      .from(hosts)
      .where(eq(hosts.id, "host-drizzle"))
      .get();

    expect(row?.name).toBe("Drizzle Host");
    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.message).toBe("Slow DB query");
    expect(infoLog.fields.operation).toBe("get");
    expect(infoLog.fields.bindingArgumentCount).toBe(1);
    expect(infoLog.fields.sql).toContain("from");
    expect(infoLog.fields.sql).toContain("hosts");
    expect(infoLog.fields.sql).not.toContain("host-drizzle");

    db.$client.close();
  });

  it("keeps truncated slow query SQL within the logged length limit", () => {
    const logger = new CapturingSlowQueryLogger();

    const db = createConnection(":memory:", {
      slowQueryLogger: logger,
      slowQueryThresholdMs: 0,
    });

    const longSql = `SELECT '${"x".repeat(1_200)}' AS value, ${"1 OR ".repeat(
      300,
    )} 1`;

    db.$client.prepare(longSql).get();

    const infoLog = getOnlyInfoLog(logger);
    expect(infoLog.fields.sql).toHaveLength(1_000);
    expect(infoLog.fields.sql.endsWith("...")).toBe(true);

    db.$client.close();
  });

  it("applies the hot-path sqlite pragmas on a file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "omnyo-db-pragmas-"));
    const db = createConnection(join(directory, "app.db"));

    try {
      expect(
        db.$client.prepare("PRAGMA cache_size").get() as {
          cache_size: number;
        },
      ).toEqual({ cache_size: -SQLITE_CACHE_SIZE_KIB });
      expect(
        db.$client.prepare("PRAGMA synchronous").get() as {
          synchronous: number;
        },
      ).toEqual({ synchronous: 1 });
      expect(
        db.$client.prepare("PRAGMA mmap_size").get() as { mmap_size: number },
      ).toEqual({ mmap_size: SQLITE_MMAP_SIZE_BYTES });
      expect(
        db.$client.prepare("PRAGMA busy_timeout").get() as { timeout: number },
      ).toEqual({ timeout: SQLITE_BUSY_TIMEOUT_MS });
      expect(
        db.$client.prepare("PRAGMA journal_mode").get() as {
          journal_mode: string;
        },
      ).toEqual({ journal_mode: "wal" });
    } finally {
      db.$client.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

async function withWriterPair(
  run: (
    primary: ReturnType<typeof createConnection>,
    peer: ReturnType<typeof createConnection>,
  ) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-db-bounded-write-"));
  const file = join(directory, "omnyo.db");
  const primary = createConnection(file);
  const peer = createConnection(file);

  try {
    primary.$client.exec("CREATE TABLE bounded_write (value INTEGER)");
    await run(primary, peer);
  } finally {
    peer.$client.close();
    primary.$client.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

function countBoundedWrites(db: ReturnType<typeof createConnection>): number {
  return Number(
    db.$client.prepare("SELECT count(*) FROM bounded_write").pluck().get(),
  );
}

describe("runImmediateTransactionWithBusyWait", () => {
  it("allows a timer to release the write lock and commits the waiting write", async () => {
    await withWriterPair(async (primary, peer) => {
      peer.$client.exec("BEGIN IMMEDIATE");
      const unlock = setTimeout(() => peer.$client.exec("COMMIT"), 0);

      try {
        const writing = runImmediateTransactionWithBusyWait(
          primary,
          500,
          () => {
            primary.$client
              .prepare("INSERT INTO bounded_write VALUES (1)")
              .run();
          },
        );

        expect(primary.$client.pragma("busy_timeout", { simple: true })).toBe(
          SQLITE_BUSY_TIMEOUT_MS,
        );
        await writing;
        expect(countBoundedWrites(primary)).toBe(1);
      } finally {
        clearTimeout(unlock);
      }
    });
  });

  it("refuses within the wait while another connection holds the write lock and restores the previous busy timeout", async () => {
    await withWriterPair(async (primary, peer) => {
      primary.$client.pragma("busy_timeout = 1234");
      peer.$client.exec("BEGIN IMMEDIATE");
      let workStarted = false;
      const startedAt = performance.now();

      await expect(
        runImmediateTransactionWithBusyWait(primary, 50, () => {
          workStarted = true;
        }),
      ).rejects.toThrow(PrimaryWriteBusyError);

      const refusedAfterMs = performance.now() - startedAt;
      peer.$client.exec("ROLLBACK");

      const timeoutInsideWork = await runImmediateTransactionWithBusyWait(
        primary,
        50,
        () => {
          primary.$client.prepare("INSERT INTO bounded_write VALUES (1)").run();

          return primary.$client.pragma("busy_timeout", { simple: true });
        },
      );

      expect({
        refusedWithinOneSecond: refusedAfterMs < 1_000,
        rows: countBoundedWrites(primary),
        timeoutAfter: primary.$client.pragma("busy_timeout", { simple: true }),
        timeoutInsideWork,
        workStarted,
      }).toEqual({
        refusedWithinOneSecond: true,
        rows: 1,
        timeoutAfter: 1234,
        timeoutInsideWork: 1234,
        workStarted: false,
      });
    });
  });

  it("throws when called inside an open transaction", async () => {
    await withWriterPair(async (primary) => {
      const attempt = primary.transaction(() => ({
        result: runImmediateTransactionWithBusyWait(
          primary,
          50,
          () => undefined,
        ),
      }));

      await expect(attempt.result).rejects.toThrow(
        "cannot start inside an open transaction",
      );

      expect(primary.$client.pragma("busy_timeout", { simple: true })).toBe(
        SQLITE_BUSY_TIMEOUT_MS,
      );
    });
  });

  it("rolls back nested effect transactions with the outer transaction", async () => {
    await withWriterPair(async (primary) => {
      await expect(
        runImmediateTransactionWithBusyWait(primary, 50, () => {
          primary.$client.prepare("INSERT INTO bounded_write VALUES (1)").run();
          primary.transaction(
            () => {
              primary.$client
                .prepare("INSERT INTO bounded_write VALUES (2)")
                .run();
            },
            { behavior: "immediate" },
          );

          if (countBoundedWrites(primary) !== 2) {
            throw new Error("nested effect write was not visible");
          }

          throw new Error("effect failed");
        }),
      ).rejects.toThrow("effect failed");

      expect(countBoundedWrites(primary)).toBe(0);
    });
  });
});

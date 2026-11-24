import { sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { getLastStoredTurnRequestEvent } from "../src/data/events.js";
import { getHost, getNonDestroyedHost } from "../src/data/hosts.js";
import {
  deletePluginKvValue,
  getPluginKvValue,
  listPluginKvKeys,
  listPluginKvRows,
  setPluginKvValue,
} from "../src/data/plugin-storage.js";
import { getThread, listRunningThreads } from "../src/data/threads.js";
import { getProject } from "../src/data/projects.js";
import { getEnvironment } from "../src/data/environments.js";
import { describe, expect, it, vi } from "vitest";
import { createConnection, STATEMENT_CACHE_SIZE } from "../src/connection.js";
import { migrate } from "../src/migrate.js";
import { hosts } from "../src/schema.js";

describe("connection statement cache", () => {
  it.each([
    ["without", undefined],
    ["with", { info: vi.fn() }],
  ])(
    "reuses one SQLite statement for repeated one-time queries %s a slow-query logger",
    (_label, slowQueryLogger) => {
      const db = createConnection(":memory:", { slowQueryLogger });

      try {
        const first = db.$client.prepare("SELECT 1 AS value");

        expect(db.$client.prepare("SELECT 1 AS value")).toBe(first);
        expect(db.get(sql.raw("SELECT 1 AS value"))).toEqual({ value: 1 });
      } finally {
        db.$client.close();
      }
    },
  );

  it("keeps object and array reads of the same SQL independent", () => {
    const db = createConnection(":memory:");
    const query = sql.raw("SELECT 1 AS value");

    try {
      const held = db.$client.prepare("SELECT 1 AS value");

      expect(db.values(query)).toEqual([[1]]);
      expect(held.all()).toEqual([{ value: 1 }]);
      expect(db.values(query)).toEqual([[1]]);
      expect(db.get(query)).toEqual({ value: 1 });
      expect(db.all(query)).toEqual([{ value: 1 }]);
    } finally {
      db.$client.close();
    }
  });

  it("prepares a separate statement while the cached one is iterating", () => {
    const db = createConnection(":memory:");
    const source = "SELECT value FROM numbers ORDER BY value";

    try {
      db.$client.exec(
        "CREATE TABLE numbers (value INTEGER); INSERT INTO numbers VALUES (1), (2)",
      );

      const iterating = db.$client.prepare<[], { value: number }>(source);
      const seen: number[] = [];

      for (const row of iterating.iterate()) {
        const nested = db.$client.prepare<[], { value: number }>(source);

        expect(nested).not.toBe(iterating);
        expect(nested.all()).toEqual([{ value: 1 }, { value: 2 }]);
        seen.push(row.value);
      }

      expect(seen).toEqual([1, 2]);
      expect(db.$client.prepare(source)).toBe(iterating);
    } finally {
      db.$client.close();
    }
  });

  it("prepares schema statements afresh so SQLite still checks them", () => {
    const db = createConnection(":memory:");
    const create = "CREATE TABLE numbers (value INTEGER)";

    try {
      db.$client.prepare(create).run();

      expect(() => db.$client.prepare(create)).toThrow(/already exists/);
    } finally {
      db.$client.close();
    }
  });

  it("evicts the least recently used statement beyond the cache size", () => {
    const db = createConnection(":memory:");

    try {
      const first = db.$client.prepare("SELECT 0 AS value");
      const kept = db.$client.prepare("SELECT 1 AS value");

      for (let index = 2; index <= STATEMENT_CACHE_SIZE; index += 1) {
        db.$client.prepare(`SELECT ${index} AS value`);

        if (index === 2) db.$client.prepare("SELECT 1 AS value");
      }

      expect(db.$client.prepare("SELECT 1 AS value")).toBe(kept);
      expect(db.$client.prepare("SELECT 0 AS value")).not.toBe(first);
    } finally {
      db.$client.close();
    }
  });
});

describe("connection prepared queries", () => {
  it.each([getHost, getThread, getProject, getEnvironment])(
    "does not rebuild SQL for warm %s lookups",
    (lookup) => {
      const db = createConnection(":memory:");
      migrate(db);
      const compile = vi.spyOn(SQLiteSyncDialect.prototype, "sqlToQuery");

      try {
        expect(lookup(db, "missing-first")).toBeNull();
        expect(compile).toHaveBeenCalledOnce();
        compile.mockClear();

        for (let i = 0; i < 10; i++) {
          expect(lookup(db, `missing-${i}`)).toBeNull();
        }

        expect(compile).not.toHaveBeenCalled();
      } finally {
        compile.mockRestore();
        db.$client.close();
      }
    },
  );

  it("does not rebuild SQL for warm plugin storage, host, running-thread and turn-request reads", () => {
    const db = createConnection(":memory:");
    migrate(db);

    const calls = [
      () => setPluginKvValue(db, "plugin", "key-1", "value"),
      () => getPluginKvValue(db, "plugin", "key-1"),
      () => listPluginKvKeys(db, "plugin"),
      () => listPluginKvKeys(db, "plugin", "key-"),
      () => listPluginKvRows(db, "plugin"),
      () => deletePluginKvValue(db, "plugin", "missing"),
      () => getNonDestroyedHost(db, "missing"),
      () => listRunningThreads(db),
      () => getLastStoredTurnRequestEvent(db, "missing"),
    ];

    for (const call of calls) call();

    const compile = vi.spyOn(SQLiteSyncDialect.prototype, "sqlToQuery");

    try {
      for (const call of calls) call();

      expect(compile).not.toHaveBeenCalled();
      expect(getPluginKvValue(db, "plugin", "key-1")).toBe("value");
      setPluginKvValue(db, "plugin", "key-1", "changed");
      expect(listPluginKvRows(db, "plugin")).toEqual([
        expect.objectContaining({ key: "key-1", value: "changed" }),
      ]);
      expect(listPluginKvKeys(db, "plugin", "key_")).toEqual([]);
      expect(deletePluginKvValue(db, "plugin", "key-1")).toBe(true);
      expect(listPluginKvKeys(db, "plugin")).toEqual([]);
    } finally {
      compile.mockRestore();
      db.$client.close();
    }
  });

  it("reuses compiled lookups across transactions while seeing writes and rollbacks", () => {
    const db = createConnection(":memory:");
    const other = createConnection(":memory:");
    migrate(db);
    migrate(other);

    try {
      db.insert(hosts)
        .values({
          id: "host",
          name: "original",
          type: "persistent",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      expect(getHost(db, "host")?.name).toBe("original");
      expect(getHost(other, "host")).toBeNull();
      const compile = vi.spyOn(SQLiteSyncDialect.prototype, "sqlToQuery");

      try {
        for (let i = 0; i < 3; i++) {
          expect(() =>
            db.transaction((tx) => {
              db.$client
                .prepare("UPDATE hosts SET name = ? WHERE id = ?")
                .run(`changed-${i}`, "host");
              expect(getHost(tx, "host")?.name).toBe(`changed-${i}`);
              throw new Error("rollback");
            }),
          ).toThrow("rollback");
          expect(getHost(db, "host")?.name).toBe("original");
        }

        expect(compile).not.toHaveBeenCalled();
      } finally {
        compile.mockRestore();
      }
    } finally {
      other.$client.close();
      db.$client.close();
    }
  });
});

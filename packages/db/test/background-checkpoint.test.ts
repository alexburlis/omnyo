import {
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import type { Worker } from "node:worker_threads";
import { createConnection } from "../src/connection.js";
import { createMigratedConnection } from "./helpers/migrated-connection.js";

afterEach(() => {
  workerControl.modulePath = null;
  workerControl.workers.length = 0;
});

const workerControl = vi.hoisted(
  (): { workers: Worker[]; modulePath: string | null } => ({
    workers: [],
    modulePath: null,
  }),
);

vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();

  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        const [filename, options] = args;
        super(
          filename,
          workerControl.modulePath === null
            ? options
            : {
                ...options,
                workerData: {
                  ...options?.workerData,
                  modulePath: workerControl.modulePath,
                },
              },
        );
        workerControl.workers.push(this);
      }
    },
  };
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 10_000;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("Checkpoint did not finish");
    await setTimeout(20);
  }
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omnyo-checkpoint-"));
  const path = join(dir, "db.sqlite");
  const template = createMigratedConnection();
  writeFileSync(path, template.$client.serialize());
  template.$client.close();

  return { dir, path };
}

it("checkpoints off the event loop and catches up after a reader releases its snapshot", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];

  const db = createConnection(path, {
    backgroundCheckpoint: { onError: (error) => errors.push(error) },
  }).$client;

  const reader = createConnection(path).$client;

  try {
    await until(() => db.pragma("wal_autocheckpoint", { simple: true }) === 0);
    db.exec("CREATE TABLE checkpoint_test (value BLOB)");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const initialSize = statSync(path).size;
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM checkpoint_test").get();
    db.transaction(() => {
      db.prepare("INSERT INTO checkpoint_test VALUES (?)").run(
        Buffer.alloc(8 * 1024 * 1024, 7),
      );
    }).immediate();
    await setTimeout(1200);
    expect(statSync(path).size).toBe(initialSize);
    reader.exec("ROLLBACK");

    const signal = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 10_000;

    while (statSync(path).size === initialSize && Date.now() < deadline) {
      Atomics.wait(signal, 0, 0, 20);
    }

    expect(statSync(path).size).toBeGreaterThan(initialSize);
    expect(errors).toEqual([]);
    reader.close();
    db.close();
    const reopened = createConnection(path).$client;

    try {
      expect(
        reopened
          .prepare("SELECT length(value) AS size FROM checkpoint_test")
          .get(),
      ).toEqual({ size: 8 * 1024 * 1024 });
    } finally {
      reopened.close();
    }
  } finally {
    if (reader.open) reader.close();

    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

it("keeps automatic checkpoints and reports worker startup failures", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];
  workerControl.modulePath = join(dir, "missing-sqlite-module.cjs");

  const db = createConnection(path, {
    backgroundCheckpoint: { onError: (error) => errors.push(error) },
  }).$client;

  try {
    await until(() => errors.length > 0);
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    expect(errors).toHaveLength(1);
  } finally {
    workerControl.modulePath = null;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("restores automatic checkpoints when the running worker exits unexpectedly", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];

  const db = createConnection(path, {
    backgroundCheckpoint: { onError: (error) => errors.push(error) },
  }).$client;

  try {
    await until(() => db.pragma("wal_autocheckpoint", { simple: true }) === 0);
    const worker = workerControl.workers.at(-1);

    if (!worker) throw new Error("Expected checkpoint worker");
    await worker.terminate();
    await until(() => errors.length > 0);
    expect(db.pragma("wal_autocheckpoint", { simple: true })).toBe(1000);
    expect(errors).toHaveLength(1);
    db.exec("CREATE TABLE after_failure (value INTEGER)");
    db.prepare("INSERT INTO after_failure VALUES (?)").run(42);
    expect(db.prepare("SELECT value FROM after_failure").get()).toEqual({
      value: 42,
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports a failed checkpoint fallback when a real cursor keeps the main connection busy", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];

  const db = createConnection(path, {
    backgroundCheckpoint: { onError: (error) => errors.push(error) },
  }).$client;

  let rows: Iterator<unknown> | null = null;

  try {
    await until(() => db.pragma("wal_autocheckpoint", { simple: true }) === 0);
    rows = db.prepare("SELECT 1 AS value UNION ALL SELECT 2").iterate();
    rows.next();
    const worker = workerControl.workers.at(-1);

    if (!worker) throw new Error("Expected checkpoint worker");
    await worker.terminate();
    await until(() => errors.length > 0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AggregateError);
    expect(errors[0]?.message).toContain("could not be restored");
  } finally {
    rows?.return?.();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("stops checkpoint ownership before attempting a busy main close", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];

  const db = createConnection(path, {
    backgroundCheckpoint: { onError: (error) => errors.push(error) },
  }).$client;

  let rows: Iterator<unknown> | null = null;

  try {
    await until(() => db.pragma("wal_autocheckpoint", { simple: true }) === 0);
    rows = db.prepare("SELECT 1 AS value UNION ALL SELECT 2").iterate();
    rows.next();
    const worker = workerControl.workers.at(-1);

    if (!worker) throw new Error("Expected checkpoint worker");
    expect(() => db.close()).toThrow("busy executing a query");
    expect(db.open).toBe(true);
    await until(() => worker.threadId === -1);
    expect(errors).toEqual([]);
    rows.return?.();
    db.exec("CREATE TABLE after_busy_close (value INTEGER)");
    db.prepare("INSERT INTO after_busy_close VALUES (?)").run(42);
    db.close();
    const reopened = createConnection(path).$client;

    try {
      expect(
        reopened.prepare("SELECT value FROM after_busy_close").get(),
      ).toEqual({ value: 42 });
    } finally {
      reopened.close();
    }
  } finally {
    rows?.return?.();

    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["starting", "ready"])(
  "releases files synchronously when closed with a %s worker",
  async (state) => {
    const { dir, path } = fixture();
    const errors: Error[] = [];

    const db = createConnection(path, {
      backgroundCheckpoint: { onError: (error) => errors.push(error) },
    }).$client;

    try {
      if (state === "ready") {
        await until(
          () => db.pragma("wal_autocheckpoint", { simple: true }) === 0,
        );
      }

      db.exec("CREATE TABLE close_test (value INTEGER)");
      db.prepare("INSERT INTO close_test VALUES (?)").run(42);
      db.close();
      expect(existsSync(`${path}-wal`)).toBe(false);
      expect(existsSync(`${path}-shm`)).toBe(false);
      const moved = `${path}.moved`;
      renameSync(path, moved);
      rmSync(moved);
      rmSync(dir, { recursive: true });
      const worker = workerControl.workers.at(-1);

      if (!worker) throw new Error("Expected checkpoint worker");
      await until(() => worker.threadId === -1);
      expect(existsSync(path)).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      if (db.open) db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

it("leaves readonly and memory connections outside checkpoint ownership", async () => {
  const { dir, path } = fixture();
  const errors: Error[] = [];

  const options = {
    backgroundCheckpoint: { onError: (error: Error) => errors.push(error) },
  };

  const memory = createConnection(":memory:", options).$client;

  const reader = createConnection(path, {
    ...options,
    readonly: true,
    cacheSizeKiB: 8192,
    mmapSizeBytes: 0,
  }).$client;

  try {
    await setTimeout(100);
    expect(workerControl.workers).toEqual([]);
    expect(reader.pragma("cache_size", { simple: true })).toBe(-8192);
    expect(reader.pragma("mmap_size", { simple: true })).toBe(0);
    expect(() =>
      reader.exec("CREATE TABLE forbidden (value INTEGER)"),
    ).toThrow();
    expect(errors).toEqual([]);
  } finally {
    memory.close();
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

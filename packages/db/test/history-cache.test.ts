import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PERSONAL_PROJECT_ID, threadScope } from "@omnyo/domain";
import { createConnection } from "../src/connection.js";
import { insertEvents } from "../src/data/events.js";
import { createThread } from "../src/data/threads.js";
import {
  historyCachePath,
  openHistoryCache,
  type HistoryCache,
  type HistoryCacheRecord,
} from "../src/history-cache.js";
import { noopNotifier } from "../src/notifier.js";
import { createMigratedConnection } from "./helpers/migrated-connection.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omnyo-history-cache-"));
  const primaryPath = join(directory, "app.db");
  const path = historyCachePath(primaryPath);
  const connections: { close(): void }[] = [];

  return {
    directory,
    primaryPath,
    path,
    open(readonly = false): HistoryCache {
      const cache = openHistoryCache(path, { readonly });
      connections.push(cache);

      return cache;
    },
    cleanup() {
      for (const connection of connections.reverse()) connection.close();
      rmSync(directory, { recursive: true, force: true });
      expect(existsSync(directory)).toBe(false);
    },
  };
}

function record(
  overrides: Partial<HistoryCacheRecord> = {},
): HistoryCacheRecord {
  return {
    key: "outline:thread-a",
    threadId: "thread-a",
    sourceIdentity: "source-a",
    rewriteEpoch: "rewrite-a",
    kind: "outline",
    body: JSON.stringify({ items: [{ id: "safe-turn", title: "Safe text" }] }),
    createdAt: Date.now() - 1000,
    expiresAt: null,
    sequence: 10,
    ...overrides,
  };
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walCommits(path: string): number {
  if (!existsSync(`${path}-wal`)) return 0;
  const wal = readFileSync(`${path}-wal`);

  if (wal.length < 32) return 0;
  const pageSize = wal.readUInt32BE(8);
  let commits = 0;

  for (
    let offset = 32;
    offset + 24 + pageSize <= wal.length;
    offset += 24 + pageSize
  )
    if (wal.readUInt32BE(offset + 4) !== 0) commits += 1;

  return commits;
}

function cacheRows(path: string) {
  const db = new Database(path, { readonly: true });

  try {
    return db.prepare("SELECT * FROM history_cache_records ORDER BY key").all();
  } finally {
    db.close();
  }
}

describe("isolated history cache", () => {
  it("commits an ordered batch once and rolls back all its writes on failure", () => {
    const f = fixture();
    const cache = f.open();

    try {
      const before = walCommits(f.path);
      const observer = f.open(true);

      expect(
        cache.batch(() => {
          const admissions = [
            cache.put(record({ key: "first" })),
            cache.put(record({ key: "second" })),
          ];

          expect(
            observer.get({
              key: "first",
              sourceIdentity: "source-a",
              now: Date.now(),
            }),
          ).toBeNull();

          return admissions;
        }),
      ).toEqual([{ status: "stored" }, { status: "stored" }]);
      expect(walCommits(f.path) - before).toBe(1);
      const committed = cacheRows(f.path);

      expect(() =>
        cache.batch(() => {
          cache.put(record({ key: "third" }));
          cache.put(record({ key: "first", body: "conflicting body" }));
        }),
      ).toThrow(/new sequence/u);
      expect(cacheRows(f.path)).toEqual(committed);
      expect(() => observer.batch(() => cache.put(record()))).toThrow(
        /readonly/u,
      );
    } finally {
      f.cleanup();
    }
  });

  it("matches sequential admission and eviction for repeated keys, expiry and the count limit", () => {
    const sequentialFixture = fixture();
    const batchFixture = fixture();
    const sequential = sequentialFixture.open();
    const batched = batchFixture.open();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);

    try {
      const initial = Array.from({ length: 1024 }, (_, index) =>
        record({ key: `record-${String(index).padStart(4, "0")}` }),
      );

      for (const cache of [sequential, batched])
        cache.batch(() => initial.forEach((input) => cache.put(input)));

      const inputs = [
        record({ key: "000-evicted", body: "first body" }),
        record({ key: "000-evicted", body: "different body at same sequence" }),
        record({ key: "zzz-kept" }),
        record({ key: "zzz-kept" }),
        record({ key: "zzz-kept", sequence: 9 }),
        record({ key: "zzz-kept", sequence: 11, body: "newer" }),
        record({ key: "expired", expiresAt: now - 1 }),
        record({ key: "future", createdAt: now + 100 }),
        record({
          key: "oversized",
          kind: "page",
          body: "x".repeat(1024 * 1024 + 1),
        }),
      ];

      const expected = inputs.map((input) => sequential.put(input));

      const actual = batched.batch(() =>
        inputs.map((input) => batched.put(input)),
      );

      expect(actual).toEqual(expected);
      expect(actual.map(({ status }) => status)).toEqual([
        "capacity",
        "capacity",
        "stored",
        "unchanged",
        "stale",
        "stored",
        "expired",
        "stale",
        "capacity",
      ]);
      expect(cacheRows(batchFixture.path)).toEqual(
        cacheRows(sequentialFixture.path),
      );
    } finally {
      clock.mockRestore();
      batchFixture.cleanup();
      sequentialFixture.cleanup();
    }
  });

  it("matches sequential admission when records cross the byte limit and revisit evicted keys", () => {
    const sequentialFixture = fixture();
    const batchFixture = fixture();
    const sequential = sequentialFixture.open();
    const batched = batchFixture.open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

    try {
      const body = "x".repeat(8 * 1024 * 1024);

      const inputs = Array.from({ length: 17 }, (_, index) =>
        record({ key: `large-${String(index).padStart(2, "0")}`, body }),
      );

      inputs.push(record({ key: "large-00", body: "replacement" }));
      const expected = inputs.map((input) => sequential.put(input));

      const actual = batched.batch(() =>
        inputs.map((input) => batched.put(input)),
      );

      expect(actual).toEqual(expected);
      expect(cacheRows(batchFixture.path)).toEqual(
        cacheRows(sequentialFixture.path),
      );
      expect(batched.storageUsage().payloadBytes).toBeLessThanOrEqual(
        128 * 1024 * 1024,
      );
    } finally {
      clock.mockRestore();
      batchFixture.cleanup();
      sequentialFixture.cleanup();
    }
  });

  it("holds its real write lock independently of authoritative event writes", () => {
    const f = fixture();
    const template = createMigratedConnection();
    writeFileSync(f.primaryPath, template.$client.serialize());
    template.$client.close();
    const primary = createConnection(f.primaryPath);
    primary.$client.pragma("busy_timeout = 0");

    const thread = createThread(primary, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
    });

    const cache = f.open();
    const cacheBlocker = new Database(f.path);
    const primaryBlocker = new Database(f.primaryPath);

    const append = (sequence: number) =>
      insertEvents(primary, noopNotifier, [
        {
          threadId: thread.id,
          sequence,
          type: "system/manager/user_message",
          scope: threadScope(),
          itemId: null,
          itemKind: null,
          parentToolCallId: null,
          data: JSON.stringify({ text: `message ${sequence}` }),
        },
      ]);

    try {
      cacheBlocker.exec("BEGIN IMMEDIATE");
      expect(cacheBlocker.inTransaction).toBe(true);
      expect(() => cache.put(record())).toThrow(/locked/u);
      expect(() => append(1)).not.toThrow();
      expect(
        primary.$client
          .prepare("SELECT sequence FROM events WHERE thread_id = ?")
          .all(thread.id),
      ).toEqual([{ sequence: 1 }]);
      cacheBlocker.exec("ROLLBACK");
      primaryBlocker.exec("BEGIN IMMEDIATE");
      expect(() => append(2)).toThrow(/locked/u);
      expect(cache.put(record())).toEqual({ status: "stored" });
      primaryBlocker.exec("ROLLBACK");
      append(2);
      expect(cache.storageUsage().records).toBe(1);
    } finally {
      cacheBlocker.close();
      primaryBlocker.close();
      primary.$client.close();
      f.cleanup();
    }
  });

  it("serves only the requested source and live clock interval through a pure readonly handle", () => {
    const f = fixture();
    const writer = f.open();
    const now = Date.now();
    const input = record({ createdAt: now - 100, expiresAt: now + 10_000 });

    try {
      expect(writer.put(input)).toEqual({ status: "stored" });
      expect(statSync(f.path).mode & 0o777).toBe(0o600);
      const reader = f.open(true);
      const before = digest(f.path);
      expect(
        reader.get({ key: input.key, sourceIdentity: "source-a", now }),
      ).toEqual(input);
      expect(
        reader.get({ key: input.key, sourceIdentity: "source-b", now }),
      ).toBeNull();
      expect(
        reader.get({
          key: input.key,
          sourceIdentity: "source-a",
          now: now - 101,
        }),
      ).toBeNull();
      expect(
        reader.get({
          key: input.key,
          sourceIdentity: "source-a",
          now: now + 10_000,
        }),
      ).toBeNull();
      expect(() => reader.put(record())).toThrow(/readonly/u);
      expect(() => reader.purgeThread(input.threadId)).toThrow(/readonly/u);
      expect(() =>
        reader.reconcile({
          sourceIdentity: "source-a",
          now,
          isThreadEligible: () => true,
        }),
      ).toThrow(/readonly/u);
      expect(digest(f.path)).toBe(before);
      const missingPath = join(f.directory, "missing", "history-cache.db");
      expect(() => openHistoryCache(missingPath, { readonly: true })).toThrow();
      expect(existsSync(missingPath)).toBe(false);
      expect(
        writer.put(record({ key: "expired", expiresAt: now - 1 })),
      ).toEqual({ status: "expired" });
      expect(
        writer.put(record({ key: "future", createdAt: now + 60_000 })),
      ).toEqual({ status: "stale" });
      expect(writer.storageUsage().records).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it("never regresses or changes a checkpoint under its captured sequence binding", () => {
    const f = fixture();
    const cache = f.open();

    try {
      expect(cache.put(record())).toEqual({ status: "stored" });
      expect(cache.put(record({ sequence: 9, body: "older" }))).toEqual({
        status: "stale",
      });
      expect(cache.put(record())).toEqual({ status: "unchanged" });
      expect(() =>
        cache.put(record({ body: "changed at same sequence" })),
      ).toThrow(/new sequence/u);
      expect(() => cache.put(record({ threadId: "different-thread" }))).toThrow(
        /binding/u,
      );
      expect(
        cache.get({
          key: "outline:thread-a",
          sourceIdentity: "source-a",
          now: Date.now(),
        })?.sequence,
      ).toBe(10);
      expect(cache.put(record({ sequence: 11, body: "newer" }))).toEqual({
        status: "stored",
      });
      expect(
        cache.get({
          key: "outline:thread-a",
          sourceIdentity: "source-a",
          now: Date.now(),
        })?.body,
      ).toBe("newer");
      expect(
        cache.put(
          record({ rewriteEpoch: "rewrite-b", sequence: 1, body: "rewritten" }),
        ),
      ).toEqual({ status: "stored" });
      expect(
        cache.get({
          key: "outline:thread-a",
          sourceIdentity: "source-a",
          now: Date.now(),
        })?.rewriteEpoch,
      ).toBe("rewrite-b");
      expect(
        cache.put(
          record({ sourceIdentity: "replacement-source", sequence: 1 }),
        ),
      ).toEqual({ status: "stored" });
      expect(
        cache.get({
          key: "outline:thread-a",
          sourceIdentity: "source-a",
          now: Date.now(),
        }),
      ).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it("bounds each payload kind and the shared payload budget including outlines", () => {
    const f = fixture();
    const cache = f.open();

    try {
      for (const [kind, limit] of [
        ["outline", 8 * 1024 * 1024],
        ["root", 4 * 1024 * 1024],
        ["page", 1024 * 1024],
      ] as const) {
        expect(
          cache.put(
            record({
              key: `oversized-${kind}`,
              kind,
              body: "x".repeat(limit + 1),
            }),
          ),
        ).toEqual({ status: "capacity" });
      }

      const body = "a".repeat(8 * 1024 * 1024);

      for (let index = 0; index < 17; index++) {
        expect(
          cache.put(
            record({
              key: `outline:${index.toString().padStart(2, "0")}`,
              body,
            }),
          ),
        ).toEqual({ status: "stored" });
      }

      expect(cache.storageUsage()).toMatchObject({
        records: 16,
        payloadBytes: 128 * 1024 * 1024,
      });
      expect(
        cache.get({
          key: "outline:00",
          sourceIdentity: "source-a",
          now: Date.now(),
        }),
      ).toBeNull();
      expect(
        cache.put(
          record({
            key: "root:new",
            kind: "root",
            body: "b".repeat(4 * 1024 * 1024),
          }),
        ),
      ).toEqual({ status: "stored" });
      expect(cache.storageUsage()).toMatchObject({
        records: 16,
        payloadBytes: 124 * 1024 * 1024,
      });
      expect(cache.storageUsage().databaseBytes).toBeGreaterThan(0);
      expect(cache.storageUsage().walBytes).toBeGreaterThanOrEqual(0);
    } finally {
      f.cleanup();
    }
  });

  it("evicts old records at the shared count cap and retains a recently accessed record", () => {
    const f = fixture();
    const cache = f.open();

    try {
      for (let index = 0; index < 1024; index++)
        cache.put(
          record({
            key: index.toString().padStart(4, "0"),
            body: "",
            kind: index % 2 === 0 ? "outline" : "page",
          }),
        );
      expect(
        cache.get({
          key: "0000",
          sourceIdentity: "source-a",
          now: Date.now() + 1000,
        }),
      ).not.toBeNull();
      expect(cache.put(record({ key: "1024", body: "" }))).toEqual({
        status: "stored",
      });
      expect(cache.storageUsage()).toMatchObject({
        records: 1024,
        payloadBytes: 0,
      });
      expect(
        cache.get({ key: "0000", sourceIdentity: "source-a", now: Date.now() }),
      ).not.toBeNull();
      expect(
        cache.get({ key: "0001", sourceIdentity: "source-a", now: Date.now() }),
      ).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it("reconciles crash-surviving orphan/source/expiry records in bounded metadata batches and purges a deleted thread", () => {
    const f = fixture();
    const cache = f.open();
    const now = Date.now();

    try {
      cache.put(record({ key: "a:keep", threadId: "keep" }));
      cache.put(record({ key: "b:orphan", threadId: "orphan" }));
      cache.put(
        record({ key: "c:other-source", sourceIdentity: "old-source" }),
      );
      cache.put(record({ key: "d:expiry", expiresAt: now + 60_000 }));
      cache.put(record({ key: "e:keep-page", threadId: "keep", kind: "page" }));
      cache.put(
        record({
          key: "f:old-revision",
          threadId: "keep",
          rewriteEpoch: "old-rewrite",
        }),
      );
      cache.close();
      const reopened = f.open();
      const examined: string[] = [];

      const isThreadEligible = (metadata: Omit<HistoryCacheRecord, "body">) => {
        expect(metadata).not.toHaveProperty("body");
        examined.push(metadata.key);

        return (
          metadata.threadId === "keep" && metadata.rewriteEpoch === "rewrite-a"
        );
      };

      const first = reopened.reconcile({
        sourceIdentity: "source-a",
        now: now + 60_000,
        limit: 2,
        isThreadEligible,
      });

      expect(first).toEqual({ nextKey: "b:orphan", examined: 2, removed: 1 });

      const second = reopened.reconcile({
        sourceIdentity: "source-a",
        now: now + 60_000,
        afterKey: first.nextKey,
        limit: 2,
        isThreadEligible,
      });

      expect(second).toEqual({ nextKey: "d:expiry", examined: 2, removed: 2 });
      expect(
        reopened.reconcile({
          sourceIdentity: "source-a",
          now: now + 60_000,
          afterKey: second.nextKey,
          limit: 2,
          isThreadEligible,
        }),
      ).toEqual({ nextKey: null, examined: 2, removed: 1 });
      expect(examined).toEqual([
        "a:keep",
        "b:orphan",
        "e:keep-page",
        "f:old-revision",
      ]);
      expect(reopened.purgeThread("keep")).toBe(2);
      expect(reopened.storageUsage().records).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("rejects primary aliases and unknown schemas without changing their bytes", () => {
    const f = fixture();

    try {
      const primary = new Database(f.primaryPath);
      primary.exec("CREATE TABLE authoritative (value TEXT)");
      primary.close();
      const primaryDigest = digest(f.primaryPath);
      expect(() => openHistoryCache(f.primaryPath)).toThrow(/dedicated/u);
      expect(() => historyCachePath(f.path)).toThrow(/separate/u);
      symlinkSync(f.primaryPath, f.path);
      expect(() => openHistoryCache(f.path)).toThrow(/regular file/u);
      rmSync(f.path);
      linkSync(f.primaryPath, f.path);
      expect(() => openHistoryCache(f.path)).toThrow(/regular file/u);
      rmSync(f.path);
      expect(digest(f.primaryPath)).toBe(primaryDigest);
      writeFileSync(f.path, readFileSync(f.primaryPath));
      const unknownDigest = digest(f.path);
      expect(() => openHistoryCache(f.path)).toThrow(
        /Unsupported history cache schema/u,
      );
      expect(digest(f.path)).toBe(unknownDigest);
      rmSync(f.path);
      const cache = f.open();
      cache.close();
      const future = new Database(f.path);
      future.pragma("user_version = 999");
      future.close();
      const futureDigest = digest(f.path);
      expect(() => openHistoryCache(f.path, { readonly: true })).toThrow(
        /Unsupported history cache schema/u,
      );
      expect(() => openHistoryCache(f.path)).toThrow(
        /Unsupported history cache schema/u,
      );
      expect(digest(f.path)).toBe(futureDigest);
    } finally {
      f.cleanup();
    }
  });
});

import { describe, expect, it } from "vitest";
import type { TimelineRow } from "@omnyo/server-contract";
import { createTimelineLatestRowsCache } from "../../../src/services/threads/timeline-latest-rows-cache.js";

interface WeightedLatestRowsCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
  ringSize?: number;
}

interface LatestRowsSnapshot {
  maxSeq: number;
  revision?: string;
  rows: readonly TimelineRow[];
}

interface RevisionAwareLatestRowsCache {
  get(
    threadId: string,
    paramsKey: string,
    maxSeq: number,
    revision?: string,
  ): LatestRowsSnapshot | undefined;
}

function createWeightedCache(options: WeightedLatestRowsCacheOptions = {}) {
  return createTimelineLatestRowsCache(options);
}

function setSnapshot(
  cache: ReturnType<typeof createTimelineLatestRowsCache>,
  threadId: string,
  paramsKey: string,
  value: LatestRowsSnapshot,
): void {
  cache.set(threadId, paramsKey, value);
}

function getSnapshot(
  cache: ReturnType<typeof createTimelineLatestRowsCache>,
  threadId: string,
  paramsKey: string,
  maxSeq: number,
  revision?: string,
): LatestRowsSnapshot | undefined {
  const revisionAwareCache: RevisionAwareLatestRowsCache = cache;

  return revisionAwareCache.get(threadId, paramsKey, maxSeq, revision);
}

function snapshotBytes(value: LatestRowsSnapshot): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function rows(label: string): TimelineRow[] {
  return [
    {
      id: `row-${label}`,
      kind: "system",
      threadId: "thr_x",
      turnId: null,
      sourceSeqStart: 0,
      sourceSeqEnd: 0,
      startedAt: 0,
      createdAt: 0,
      systemKind: "debug",
      title: label,
      detail: null,
      status: null,
    },
  ];
}

describe("createTimelineLatestRowsCache", () => {
  it("keeps a ring of recent revisions per params key and evicts the oldest", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 3 });

    for (const maxSeq of [1, 2, 3]) {
      cache.set("thr_x", "k", { maxSeq, rows: rows(`r${maxSeq}`) });
    }

    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 3)?.rows).toEqual(rows("r3"));

    cache.set("thr_x", "k", { maxSeq: 4, rows: rows("r4") });
    expect(cache.get("thr_x", "k", 1)).toBeUndefined();
    expect(cache.get("thr_x", "k", 2)?.rows).toEqual(rows("r2"));
    expect(cache.get("thr_x", "k", 4)?.rows).toEqual(rows("r4"));
    expect(cache.get("thr_x", "k", 5)).toBeUndefined();
    expect(cache.get("thr_x", "other", 4)).toBeUndefined();
  });

  it("keeps distinct delivered revisions at one sequence and replaces legacy snapshots", () => {
    const cache = createWeightedCache({
      maxEntryBytes: 10_000,
      maxBytes: 30_000,
      ringSize: 3,
    });

    const revisionA = rows("revision-a");
    const revisionB = rows("revision-b");
    const legacyFirst = rows("legacy-first");
    const legacySecond = rows("legacy-second");

    setSnapshot(cache, "thr_x", "k", {
      maxSeq: 7,
      revision: "credential-set-a",
      rows: revisionA,
    });
    setSnapshot(cache, "thr_x", "k", {
      maxSeq: 7,
      revision: "credential-set-b",
      rows: revisionB,
    });
    setSnapshot(cache, "thr_x", "k", {
      maxSeq: 7,
      rows: legacyFirst,
    });
    setSnapshot(cache, "thr_x", "k", {
      maxSeq: 7,
      rows: legacySecond,
    });

    expect(
      getSnapshot(cache, "thr_x", "k", 7, "credential-set-a")?.rows,
    ).toEqual(revisionA);
    expect(
      getSnapshot(cache, "thr_x", "k", 7, "credential-set-b")?.rows,
    ).toEqual(revisionB);
    expect(getSnapshot(cache, "thr_x", "k", 7)?.rows).toEqual(legacySecond);
    expect(cache.size).toBe(1);
  });

  it("retains eight near-limit snapshots before evicting under the default budget", () => {
    const snapshot = {
      maxSeq: 1,
      rows: rows("x".repeat(510_000)),
    };

    const weight = snapshotBytes(snapshot);
    expect(weight).toBeLessThan(1_048_576);
    expect(weight * 8).toBeGreaterThan(8_000_000);
    expect(weight * 8).toBeLessThanOrEqual(8_388_608);

    const cache = createTimelineLatestRowsCache();

    for (let index = 0; index < 8; index += 1) {
      setSnapshot(cache, `thr_${index}`, `key-${index}`, snapshot);
    }

    for (let index = 0; index < 8; index += 1) {
      expect(
        getSnapshot(cache, `thr_${index}`, `key-${index}`, 1),
      ).toBeDefined();
    }

    setSnapshot(cache, "thr_ninth", "key-ninth", snapshot);

    expect(getSnapshot(cache, "thr_0", "key-0", 1)).toBeUndefined();
  });

  it("does not retain a snapshot above the per-entry byte limit", () => {
    const largeRows = rows("x".repeat(1_100_000));
    expect(snapshotBytes({ maxSeq: 1, rows: largeRows })).toBeGreaterThan(
      1_048_576,
    );

    const cache = createTimelineLatestRowsCache();

    setSnapshot(cache, "thr_x", "large", { maxSeq: 1, rows: largeRows });

    expect(getSnapshot(cache, "thr_x", "large", 1)).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it.each(['escaped\n"\\', "Grüße 🦈\u0000"])(
    "keeps the exact revision snapshot byte boundary for %j",
    (label) => {
      const snapshot = { maxSeq: 12, revision: label, rows: rows(label) };
      const weight = snapshotBytes(snapshot);

      for (const maxEntryBytes of [weight - 1, weight]) {
        const cache = createTimelineLatestRowsCache({ maxEntryBytes });
        cache.set("thr_x", "encoded", snapshot);

        expect(cache.get("thr_x", "encoded", 12, label)).toEqual(
          maxEntryBytes === weight ? snapshot : undefined,
        );
      }
    },
  );

  it("evicts snapshots from the least-recently-used key under total byte pressure", () => {
    const firstRows = rows("a".repeat(300));
    const secondRows = rows("b".repeat(500));
    const firstSnapshot = { maxSeq: 1, rows: firstRows };
    const secondSnapshot = { maxSeq: 1, rows: secondRows };
    const firstBytes = snapshotBytes(firstSnapshot);
    const secondBytes = snapshotBytes(secondSnapshot);

    const cache = createWeightedCache({
      maxEntryBytes: Math.max(firstBytes, secondBytes),
      maxBytes: firstBytes + secondBytes - 1,
    });

    setSnapshot(cache, "thr_first", "first", firstSnapshot);
    setSnapshot(cache, "thr_second", "second", secondSnapshot);

    expect(getSnapshot(cache, "thr_second", "second", 1)?.rows).toEqual(
      secondRows,
    );
    expect(getSnapshot(cache, "thr_first", "first", 1)).toBeUndefined();
    expect(cache.size).toBe(1);
  });

  it("a repeated set at the same revision refreshes recency without consuming a ring slot", () => {
    const cache = createTimelineLatestRowsCache({ ringSize: 2 });
    cache.set("thr_x", "k", { maxSeq: 1, rows: rows("r1") });
    cache.set("thr_x", "k", { maxSeq: 2, rows: rows("r2") });
    cache.set("thr_x", "k", { maxSeq: 1, rows: rows("r1") });
    cache.set("thr_x", "k", { maxSeq: 1, rows: rows("r1") });
    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 2)?.rows).toEqual(rows("r2"));
    cache.set("thr_x", "k", { maxSeq: 3, rows: rows("r3") });
    expect(cache.get("thr_x", "k", 2)).toBeUndefined();
    expect(cache.get("thr_x", "k", 1)?.rows).toEqual(rows("r1"));
    expect(cache.get("thr_x", "k", 3)?.rows).toEqual(rows("r3"));
  });

  it("bounds params keys LRU-style; a lookup counts as use", () => {
    const cache = createTimelineLatestRowsCache({ maxEntries: 2 });
    cache.set("thr_a", "a", { maxSeq: 1, rows: rows("a") });
    cache.set("thr_b", "b", { maxSeq: 1, rows: rows("b") });
    expect(cache.get("thr_a", "a", 1)).toBeDefined();
    cache.set("thr_c", "c", { maxSeq: 1, rows: rows("c") });
    expect(cache.size).toBe(2);
    expect(cache.get("thr_b", "b", 1)).toBeUndefined();
    expect(cache.get("thr_a", "a", 1)?.rows).toEqual(rows("a"));
    expect(cache.get("thr_c", "c", 1)?.rows).toEqual(rows("c"));
  });

  it("invalidates only revisions for the rewritten thread", () => {
    const snapshotRows = rows("weighted".repeat(50));
    const snapshot = { maxSeq: 1, rows: snapshotRows };
    const weight = snapshotBytes(snapshot);

    const cache = createWeightedCache({
      maxEntryBytes: weight,
      maxBytes: weight * 2,
    });

    setSnapshot(cache, "thr_x", "x", snapshot);
    setSnapshot(cache, "thr_y", "y", snapshot);

    cache.invalidateThread("thr_x");
    setSnapshot(cache, "thr_z", "z", snapshot);

    expect(getSnapshot(cache, "thr_x", "x", 1)).toBeUndefined();
    expect(getSnapshot(cache, "thr_y", "y", 1)?.rows).toEqual(snapshotRows);
    expect(getSnapshot(cache, "thr_z", "z", 1)?.rows).toEqual(snapshotRows);
    expect(cache.size).toBe(2);
  });
});

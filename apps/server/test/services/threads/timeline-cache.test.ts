import { describe, expect, it, vi } from "vitest";
import {
  threadTimelineResponseSchema,
  type ThreadTimelineResponse,
} from "@omnyo/server-contract";
import type { ThreadTimelinePageRequest } from "../../../src/services/threads/timeline-pagination.js";
import {
  buildThreadTimelineCacheKey,
  createThreadTimelineCache,
  type ThreadTimelineCacheKeyArgs,
} from "../../../src/services/threads/timeline-cache.js";

interface WeightedThreadTimelineCacheOptions {
  maxBytes?: number;
  maxEntries?: number;
  maxEntryBytes?: number;
}

function createWeightedCache(options: WeightedThreadTimelineCacheOptions = {}) {
  return createThreadTimelineCache(options);
}

function makeResponse(
  rowCount: number,
  detailCharsPerRow = 0,
): ThreadTimelineResponse {
  return {
    rows: Array.from({ length: rowCount }, (_, index) => ({
      id: `row-${index}`,
      kind: "system",
      threadId: "thr_x",
      turnId: null,
      sourceSeqStart: index,
      sourceSeqEnd: index,
      startedAt: 0,
      createdAt: 0,
      systemKind: "debug",
      title: "t",
      detail: detailCharsPerRow === 0 ? null : "x".repeat(detailCharsPerRow),
      status: null,
    })),
    contextBoundarySeq: null,
    completedTurnDisplay: "collapse",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    maxSeq: Math.max(rowCount - 1, 0),
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: rowCount === 0 ? 0 : 1,
      hasOlderRows: false,
      olderCursor: null,
    },
  };
}

function responseBytes(response: ThreadTimelineResponse): number {
  return Buffer.byteLength(JSON.stringify(response), "utf8");
}

function validResponse(
  rowCount: number,
  detailCharsPerRow = 0,
): ThreadTimelineResponse {
  return threadTimelineResponseSchema.parse(
    makeResponse(rowCount, detailCharsPerRow),
  );
}

const latestPage: ThreadTimelinePageRequest = {
  kind: "latest",
  segmentLimit: 20,
};

const baseKeyArgs: ThreadTimelineCacheKeyArgs = {
  threadId: "thr_x",
  maxSeq: 10,
  status: "idle",
  environmentId: null,
  page: latestPage,
  includeNestedRows: false,
  deferContent: false,
  summaryOnly: false,
  includeClearedContextHistory: false,
  includeDiagnosticOperations: false,
  completedTurnDisplay: "collapse",
};

describe("createThreadTimelineCache", () => {
  it("builds once for the same key and serves cached on repeat", () => {
    const cache = createThreadTimelineCache();
    const build = vi.fn(() => makeResponse(3));

    const first = cache.getOrBuild("thr_x", "k", build);
    const second = cache.getOrBuild("thr_x", "k", build);

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("caches a schema-valid dense response under the default byte limits", () => {
    const response = validResponse(210, 600);
    expect(response.rows).toHaveLength(210);
    expect(responseBytes(response)).toBeLessThan(1_048_576);

    const cache = createThreadTimelineCache();
    const build = vi.fn(() => response);

    const first = cache.getOrBuild("thr_x", "dense", build, "dense");
    const second = cache.getOrBuild("thr_x", "dense", build, "dense");

    expect(build).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("retains eight near-limit responses before evicting under the default budget", () => {
    const response = validResponse(1, 1_020_000);
    const weight = responseBytes(response);
    expect(weight).toBeLessThan(1_048_576);
    expect(weight * 8).toBeGreaterThan(8_000_000);
    expect(weight * 8).toBeLessThanOrEqual(8_388_608);

    const cache = createThreadTimelineCache();
    const builders = Array.from({ length: 8 }, () => vi.fn(() => response));

    for (const [index, build] of builders.entries()) {
      cache.getOrBuild(`thr_${index}`, `key-${index}`, build);
    }

    for (const [index, build] of builders.entries()) {
      const probe = vi.fn(() => response);
      cache.getOrBuild(`thr_${index}`, `key-${index}`, probe);
      expect(probe).not.toHaveBeenCalled();
      expect(build).toHaveBeenCalledTimes(1);
    }

    cache.getOrBuild("thr_ninth", "key-ninth", () => response);

    const firstAgain = vi.fn(() => response);
    cache.getOrBuild("thr_0", "key-0", firstAgain);
    expect(firstAgain).toHaveBeenCalledTimes(1);
  });

  it("does not retain a one-row response above the per-entry byte limit", () => {
    const response = validResponse(1, 1_100_000);
    expect(responseBytes(response)).toBeGreaterThan(1_048_576);

    const cache = createThreadTimelineCache();

    const build = vi.fn(() => response);

    cache.getOrBuild("thr_x", "large", build, "large");
    cache.getOrBuild("thr_x", "large", build, "large");

    expect(build).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it.each(['escaped\n"\\', "Grüße 🦈\u0000"])(
    "keeps the exact response byte boundary for %j",
    (detail) => {
      const response = validResponse(1);
      const row = response.rows[0];

      if (row?.kind !== "system") throw new Error("Expected a system row");
      row.detail = detail;
      const weight = responseBytes(response);

      for (const maxEntryBytes of [weight - 1, weight]) {
        const cache = createThreadTimelineCache({ maxEntryBytes });
        const build = vi.fn(() => response);
        cache.getOrBuild("thr_x", "encoded", build);
        cache.getOrBuild("thr_x", "encoded", build);

        expect(build).toHaveBeenCalledTimes(maxEntryBytes === weight ? 1 : 2);
      }
    },
  );

  it("evicts the least-recently-used weighted response under total byte pressure", () => {
    const firstResponse = validResponse(1, 200);
    const secondResponse = validResponse(1, 500);
    const firstBytes = responseBytes(firstResponse);
    const secondBytes = responseBytes(secondResponse);

    const cache = createWeightedCache({
      maxEntryBytes: Math.max(firstBytes, secondBytes),
      maxBytes: firstBytes + secondBytes - 1,
    });

    cache.getOrBuild("thr_first", "first", () => firstResponse, "first");
    cache.getOrBuild("thr_second", "second", () => secondResponse, "second");

    const secondAgain = vi.fn(() => secondResponse);
    cache.getOrBuild("thr_second", "second", secondAgain, "second");
    expect(secondAgain).not.toHaveBeenCalled();

    const firstAgain = vi.fn(() => firstResponse);
    cache.getOrBuild("thr_first", "first", firstAgain, "first");
    expect(firstAgain).toHaveBeenCalledTimes(1);
  });

  it("evicts least-recently-used entries beyond maxEntries", () => {
    const cache = createThreadTimelineCache({ maxEntries: 2 });
    const build = vi.fn(() => makeResponse(1));

    cache.getOrBuild("thr_x", "a", build);
    cache.getOrBuild("thr_x", "b", build);
    cache.getOrBuild("thr_x", "a", build);
    cache.getOrBuild("thr_x", "c", build);

    expect(cache.size).toBe(2);
    const buildAgain = vi.fn(() => makeResponse(1));
    cache.getOrBuild("thr_x", "a", buildAgain);
    cache.getOrBuild("thr_x", "b", buildAgain);
    expect(buildAgain).toHaveBeenCalledTimes(1);
  });

  it("invalidates only entries for the rewritten thread", () => {
    const response = validResponse(1, 100);
    const weight = responseBytes(response);
    const oversized = validResponse(1, 1_000);
    expect(responseBytes(oversized)).toBeGreaterThan(weight);

    const cache = createWeightedCache({
      maxEntryBytes: weight,
      maxBytes: weight * 2,
    });

    cache.getOrBuild("thr_x", "x", () => response);
    cache.getOrBuild("thr_y", "y", () => response);

    cache.invalidateThread("thr_x");

    const oversizedRebuild = vi.fn(() => oversized);
    const unrelated = vi.fn(() => response);
    const afterInvalidation = vi.fn(() => response);

    cache.getOrBuild("thr_x", "x", oversizedRebuild);
    cache.getOrBuild("thr_z", "z", () => response);
    cache.getOrBuild("thr_y", "y", unrelated);
    cache.getOrBuild("thr_z", "z", afterInvalidation);

    expect(oversizedRebuild).toHaveBeenCalledTimes(1);
    expect(unrelated).not.toHaveBeenCalled();
    expect(afterInvalidation).not.toHaveBeenCalled();
    expect(cache.size).toBe(2);
  });

  it("keeps unrelated history cached while one projection advances", () => {
    const cache = createThreadTimelineCache({ maxEntries: 3 });
    const idle = vi.fn(() => makeResponse(1));
    const active = vi.fn(() => makeResponse(2));
    cache.getOrBuild("thr_idle", "idle-10", idle, "idle-latest");
    cache.getOrBuild("thr_active", "older-10", active, "active-older");

    for (let sequence = 10; sequence < 20; sequence += 1) {
      cache.getOrBuild(
        "thr_active",
        `latest-${sequence}`,
        active,
        "active-latest",
      );
    }

    cache.getOrBuild("thr_idle", "idle-10", idle, "idle-latest");
    cache.getOrBuild("thr_active", "older-10", active, "active-older");
    expect(idle).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledTimes(11);
    expect(cache.size).toBe(3);
  });

  it("releases obsolete versions when the replacement exceeds the byte cap", () => {
    const latest = validResponse(3);
    const olderPage = validResponse(3);
    const oversized = validResponse(1, 1_000);
    const latestBytes = responseBytes(latest);
    expect(responseBytes(oversized)).toBeGreaterThan(latestBytes);

    const cache = createWeightedCache({
      maxEntryBytes: latestBytes,
      maxBytes: latestBytes * 2,
    });

    cache.getOrBuild("thr_active", "latest-10", () => latest, "latest");
    cache.getOrBuild("thr_active", "older-10", () => olderPage, "older");
    cache.getOrBuild("thr_active", "latest-11", () => oversized, "latest");

    expect(cache.size).toBe(1);
    const previousLatest = vi.fn(() => latest);
    cache.getOrBuild("thr_active", "latest-10", previousLatest, "latest");
    expect(previousLatest).toHaveBeenCalledTimes(1);

    const older = vi.fn(() => olderPage);
    cache.getOrBuild("thr_active", "older-10", older, "older");
    expect(older).not.toHaveBeenCalled();
  });
});

describe("buildThreadTimelineCacheKey", () => {
  it("differs when any projection input differs", () => {
    const base = buildThreadTimelineCacheKey(baseKeyArgs);

    const variants: ThreadTimelineCacheKeyArgs[] = [
      { ...baseKeyArgs, maxSeq: 11 },
      { ...baseKeyArgs, status: "active" },
      { ...baseKeyArgs, environmentId: "env_1" },
      { ...baseKeyArgs, includeNestedRows: true },
      { ...baseKeyArgs, summaryOnly: true },
      { ...baseKeyArgs, includeDiagnosticOperations: true },
      { ...baseKeyArgs, completedTurnDisplay: "flat" },
      {
        ...baseKeyArgs,
        page: {
          kind: "older",
          segmentLimit: 20,
          beforeCursor: { anchorSeq: 5, anchorId: "a5" },
        },
      },
    ];

    for (const variant of variants) {
      expect(buildThreadTimelineCacheKey(variant)).not.toBe(base);
    }
  });

  it("distinguishes older-page cursors", () => {
    const cursorA = buildThreadTimelineCacheKey({
      ...baseKeyArgs,
      page: {
        kind: "older",
        segmentLimit: 20,
        beforeCursor: { anchorSeq: 5, anchorId: "a5" },
      },
    });

    const cursorB = buildThreadTimelineCacheKey({
      ...baseKeyArgs,
      page: {
        kind: "older",
        segmentLimit: 20,
        beforeCursor: { anchorSeq: 6, anchorId: "a6" },
      },
    });

    expect(cursorA).not.toBe(cursorB);
  });
});

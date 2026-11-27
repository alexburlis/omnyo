// Failure criteria declared before benchmark implementation:
// 1. 100,000 sparse minute records make paged reports exceed 600 points/100 groups.
// 2. A 100-observation production transaction cannot keep up with live pages.
// 3. Retention changes permanent counters, daily history, or pooled speed.
// 4. Summing separate cohort peaks incorrectly overstates global concurrency.
// 5. A filtered mean uses filtered coverage instead of observed global time.
// 6. Benchmark SQLite exceeds 100 MiB or survives producer disposal.
// 7. Recent exact observations or expired median samples remain after cleanup.
// 8. Permanent stream/scope ledgers exceed the storage budget or lose old
//    baselines after retention, replay, or an invalid atomic page commit.
// The benchmark calls the production store with real SDK-managed SQLite.
// 9. Full-range facets duplicate output, omit Other, or grow beyond six rows
//    per requested split when the breakdown itself is paginated.
// Timing targets are observations, not portable pass guarantees: report p95
// below 100 ms and 100-observation transaction p95 below 20 ms on this host.

import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import {
  emptyCounters,
  reportInputSchema,
  type Cohort,
  type CounterUsage,
  type Health,
} from "../contract.ts";
import { StatsStore } from "../lib/store.ts";

const evidenceDirectory = process.env.OMNYO_THREAD_STORAGE;

if (!evidenceDirectory)
  throw new Error("OMNYO_THREAD_STORAGE must identify the retained benchmark evidence directory");

const evidencePath = `${evidenceDirectory}/stats-redesign-evidence/efficiency-acceptance.json`;

const host = createFakePluginHost({ pluginId: "stats-efficiency" });

const store = new StatsStore(host.api);

const db = host.api.storage.database();

const databasePath = db.name;

const asOf = Date.now();

const batchTimings: number[] = [];

const reportTimings: number[] = [];

const lifetimeTimings: number[] = [];

const headlineTimings: number[] = [];

const ledgerTimings: number[] = [];

const lookupTimings: number[] = [];

const cohorts: Cohort[] = [];

const initialRss = process.memoryUsage().rss;

function percentile(values: number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
}

function health(): Health {
  return {
    ...store.health(),
    queueDepth: 0,
    indexing: false,
    error: null,
    accountState: "unavailable",
    accounts: [],
    sourcePages: 0,
    sourceEvents: 0,
    lastPageMs: 0,
  };
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);

    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

const ownership = {
  owner: "Stats benchmark",
  purpose: "production-store synthetic performance and retention proof",
  restoreInputs: "scripts/benchmark.ts deterministic synthetic fixtures",
  expectedMaximumBytes: 100 * 1024 * 1024,
  scratch: databasePath,
  retainedEvidence: evidencePath,
};

await mkdir(`${evidenceDirectory}/stats-redesign-evidence`, { recursive: true });

await writeFile(
  evidencePath,
  `${JSON.stringify({ checkedAt: new Date().toISOString(), ownership, status: "running" }, null, 2)}\n`,
);

let accepted = false;

let metrics;

try {
  for (let index = 0; index < 20; index += 1) {
    const cohort: Cohort = {
      machine: `machine-${index % 2}`,
      project: `project-${index % 2}`,
      chat: `bench-${index}`,
      provider: "codex",
      model: `model-${index % 4}`,
      effort: index % 2 ? "max" : "low",
      mode: "default",
      account: "",
      chatRole: index % 2 ? "subagent" : "main",
      agentRole: index % 2 ? "subagent" : "main",
    };

    cohorts.push(cohort);
    store.touchChat({
      id: cohort.chat,
      title: `Bench ${index}`,
      machineName: "Fixture machine",
      projectName: "Fixture project",
      deleted: false,
      archived: false,
      chatRole: cohort.chatRole,
    });

    for (let batch = 0; batch < 50; batch += 1) {
      const observations = [];

      for (let entry = 0; entry < 100; entry += 1) {
        const counters = emptyCounters();
        counters.input = 2;
        counters.output = 1;
        counters.total = 3;
        counters.usageEvents = 1;
        observations.push({ at: asOf - (5000 - batch * 100 - entry) * 60_000, counters });
      }

      const started = performance.now();
      store.commit({
        threadId: cohort.chat,
        seq: batch + 1,
        state: "scalar-state",
        parts: [{ cohort, observations, samples: [] }],
      });
      batchTimings.push(performance.now() - started);
    }

    store.markComplete(cohort.chat);
  }

  const first = cohorts[0];
  const second = cohorts[1];
  assert.ok(first && second);
  const speed = emptyCounters();
  speed.turns = 100;
  speed.measuredTurns = 100;
  speed.speedOutput = 1000;
  speed.modelMs = 100_000;
  store.commit({
    threadId: first.chat,
    seq: 51,
    state: "scalar-state",
    parts: [
      {
        cohort: first,
        observations: [{ at: asOf, counters: speed }],
        samples: Array.from({ length: 100 }, (_, index) => ({
          id: `sample-${index}`,
          at: asOf,
          output: 10,
          modelMs: 1000,
        })),
      },
    ],
  });
  store.recordConcurrency(
    asOf - 30_000,
    [
      { cohort: first, count: 2 },
      { cohort: second, count: 3 },
    ],
    asOf - 60_000,
  );
  store.recordConcurrency(asOf, [{ cohort: first, count: 2 }], asOf - 30_000);
  const summary = store.summary(asOf, 2, 1, 1, true);
  assert.equal(summary.allTime.output, 100_000);
  assert.equal(summary.allTime.input, 200_000);
  assert.equal(summary.allTime.total, 300_000);
  assert.equal(summary.observedSeconds5m, 60);

  for (let index = 0; index < 25; index += 1) {
    const started = performance.now();

    const report = store.report(
      reportInputSchema.parse({ range: "month", groupBy: "chat", limit: 7 }),
      summary,
      health(),
    );

    const duration = performance.now() - started;

    if (index >= 5) reportTimings.push(duration);
    assert.ok(report.series.length <= 600);
    assert.equal(report.groups.length, 7);
    assert.equal(report.groupCount, 20);
    assert.equal(report.counters.output, 100_000);
    assert.equal(report.facets.length, 6);

    for (const facet of report.facets) {
      assert.ok(facet.groups.length <= 6);
      assert.equal(facet.totalOutput, 100_000);
      assert.equal(
        facet.groups.reduce((sum, row) => sum + row.output, 0),
        100_000,
      );
    }
  }

  const all = store.report(
    reportInputSchema.parse({ range: "hour", groupBy: "chat" }),
    summary,
    health(),
  );

  const covered = all.series.reduce((sum, point) => sum + point.observedMs, 0);

  const agentMs = all.series.reduce(
    (sum, point) => sum + (point.agents ?? 0) * point.observedMs,
    0,
  );

  assert.equal(agentMs / covered, 3.5);
  assert.equal(Math.max(...all.series.map((point) => point.peak ?? 0)), 5);

  const filtered = store.report(
    reportInputSchema.parse({ range: "hour", groupBy: "chat", filters: { chat: first.chat } }),
    summary,
    health(),
  );

  assert.equal(
    filtered.series.reduce((sum, point) => sum + (point.agents ?? 0) * point.observedMs, 0) /
      covered,
    2,
  );
  assert.ok(filtered.series.every((point) => point.peak === null));

  // A second dimension distribution measures the cost hidden by only twenty
  // active chats: ten thousand retained, deleted chats with permanent history.
  for (let index = 0; index < 10_000; index += 1) {
    const cohort: Cohort = { ...first, chat: `historic-${index}` };
    store.touchChat({
      id: cohort.chat,
      title: `Historic ${index}`,
      machineName: "Fixture machine",
      projectName: "Fixture project",
      deleted: false,
      archived: true,
    });
    const counters = emptyCounters();
    counters.input = 2;
    counters.output = 1;
    counters.total = 3;
    counters.usageEvents = 1;
    store.commit({
      threadId: cohort.chat,
      seq: 1,
      state: "",
      parts: [{ cohort, observations: [{ at: asOf - 400 * 86_400_000, counters }], samples: [] }],
    });
    store.markDeleted(cohort.chat);
  }

  const ledgerThread = "ledger-benchmark";

  const ledgerValue: CounterUsage = {
    input: 2,
    output: 1,
    total: 3,
    cached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };

  for (let batch = 0; batch < 2000; batch += 1) {
    const scopes = [];
    const streams = [];

    for (let entry = 0; entry < 50; entry += 1) {
      const index = batch * 50 + entry;
      scopes.push({
        turnId: `turn-${index}`,
        value: {
          key: `agent-${index}`,
          nested: true,
          at: asOf - 400 * 86_400_000,
          session: "fixture-session",
        },
      });
      streams.push({ key: `stream-${index}`, value: ledgerValue });
    }

    const started = performance.now();
    store.commit({
      threadId: ledgerThread,
      seq: batch + 1,
      state: "",
      parts: [],
      ledger: { scopes, streams },
    });
    ledgerTimings.push(performance.now() - started);
  }

  assert.deepEqual(store.stream(ledgerThread, "stream-0"), ledgerValue);
  assert.equal(store.turnScope(ledgerThread, "turn-0")?.key, "agent-0");
  assert.equal(store.turnScope(ledgerThread, "turn-99999")?.session, "fixture-session");
  assert.equal(store.stream(ledgerThread, "missing"), null);
  assert.equal(store.turnScope(ledgerThread, "missing"), null);
  store.commit({
    threadId: ledgerThread,
    seq: 2000,
    state: "replayed",
    parts: [],
    ledger: { scopes: [], streams: [{ key: "stream-0", value: { ...ledgerValue, total: 4000 } }] },
  });
  assert.deepEqual(store.stream(ledgerThread, "stream-0"), ledgerValue);
  const atomicCounters = emptyCounters();
  atomicCounters.output = 1;
  assert.throws(() =>
    store.commit({
      threadId: ledgerThread,
      seq: 2001,
      state: "must-rollback",
      parts: [
        { cohort: first, observations: [{ at: asOf, counters: atomicCounters }], samples: [] },
      ],
      ledger: {
        scopes: [],
        streams: [
          { key: "stream-0", value: { ...ledgerValue, total: 4000 } },
          { key: "invalid", value: { ...ledgerValue, input: -1 } },
        ],
      },
    }),
  );
  assert.deepEqual(store.stream(ledgerThread, "stream-0"), ledgerValue);
  assert.equal(store.cursor(ledgerThread).seq, 2000);
  assert.equal(store.stream(ledgerThread, "invalid"), null);

  for (let index = 0; index < 1000; index += 1) {
    const key = index * 97;
    const started = performance.now();
    assert.equal(store.stream(ledgerThread, `stream-${key}`)?.total, 3);
    assert.equal(store.turnScope(ledgerThread, `turn-${key}`)?.nested, true);
    lookupTimings.push(performance.now() - started);
  }

  const streamRows =
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM stream_baselines").get()
      ?.count ?? 0;

  const scopeRows =
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM turn_scopes").get()?.count ??
    0;

  assert.equal(streamRows, 100000);
  assert.equal(scopeRows, 100000);
  const lifetimeSummary = store.summary(asOf, 2, 1, 1, true);
  assert.equal(lifetimeSummary.allTime.output, 110_000);

  for (let index = 0; index < 25; index += 1) {
    const started = performance.now();

    const report = store.report(
      reportInputSchema.parse({ range: "all", groupBy: "chat", limit: 50 }),
      lifetimeSummary,
      health(),
    );

    if (index >= 5) lifetimeTimings.push(performance.now() - started);
    assert.equal(report.groupCount, 10_020);
    assert.equal(report.groups.length, 50);
    assert.ok(report.series.length <= 600);
    assert.equal(report.counters.output, 110_000);
  }

  for (let index = 0; index < 1000; index += 1) {
    const started = performance.now();
    assert.equal(store.summary(asOf, 2, 1, 1, true).allTime.output, 110_000);
    headlineTimings.push(performance.now() - started);
  }

  store.maintenance(asOf);
  const peak = store.health();
  const peakPageCount = Number(db.pragma("page_count", { simple: true }));
  const pageSize = Number(db.pragma("page_size", { simple: true }));
  const logicalDatabaseBytes = peakPageCount * pageSize;
  assert.ok(logicalDatabaseBytes < ownership.expectedMaximumBytes);
  const before = lifetimeSummary.allTime;
  const maintenanceStarted = performance.now();
  let maintenanceCalls = 0;
  let stale = false;

  do {
    stale = store.maintenance(asOf + 31 * 86_400_000);
    maintenanceCalls += 1;
  } while (stale && maintenanceCalls < 200);

  const retained = store.health();
  assert.equal(retained.minuteRows, 0);
  assert.equal(retained.observationRows, 0);
  assert.equal(retained.speedRows, 0);
  assert.deepEqual(store.stream(ledgerThread, "stream-0"), ledgerValue);
  assert.equal(store.turnScope(ledgerThread, "turn-0")?.key, "agent-0");
  assert.equal(
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM stream_baselines").get()
      ?.count,
    100000,
  );
  assert.equal(
    db.prepare<[], { count: number }>("SELECT COUNT(*) AS count FROM turn_scopes").get()?.count,
    100000,
  );
  assert.ok(retained.dailyRows > 0);
  assert.deepEqual(store.summary(asOf, 0, 0, 0, false).allTime, before);

  const after = store.report(
    reportInputSchema.parse({ range: "all", groupBy: "model" }),
    store.summary(asOf, 0, 0, 0, false),
    health(),
  );

  assert.equal(after.counters.output, 110_000);
  assert.equal(after.speeds.find((entry) => entry.model === "model-0")?.modelTps, 10);
  assert.equal(after.speeds.find((entry) => entry.model === "model-0")?.medianTps, null);
  const finalRssBeforeGc = process.memoryUsage().rss;
  globalThis.gc?.();
  metrics = {
    sourceObservations: 110_000,
    liveBatchSize: 100,
    insertBatches: batchTimings.length,
    batchP50Ms: percentile(batchTimings, 0.5),
    batchP95Ms: percentile(batchTimings, 0.95),
    permanentStreamRows: streamRows,
    permanentScopeRows: scopeRows,
    ledgerRowsPerBatch: 100,
    ledgerBatchP95Ms: percentile(ledgerTimings, 0.95),
    ledgerLookupPairP95Ms: percentile(lookupTimings, 0.95),
    ledgerReplayAndAtomicity: true,
    reportWarmSamples: reportTimings.length,
    monthReportP50Ms: percentile(reportTimings, 0.5),
    monthReportP95Ms: percentile(reportTimings, 0.95),
    lifetimeChatGroups: 10_020,
    lifetimeReportP50Ms: percentile(lifetimeTimings, 0.5),
    lifetimeReportP95Ms: percentile(lifetimeTimings, 0.95),
    headlineP95Ms: percentile(headlineTimings, 0.95),
    databaseBytesAtPeak: peak.databaseBytes,
    walBytesAtPeak: peak.walBytes,
    logicalDatabaseBytes,
    minuteRowsAtPeak: peak.minuteRows,
    dailyRowsRetained: retained.dailyRows,
    exactConcurrency: {
      agentMs,
      coveredMs: covered,
      globalAverage: agentMs / covered,
      globalPeak: 5,
      filteredAverage: 2,
    },
    maintenanceCalls,
    maintenanceTotalMs: performance.now() - maintenanceStarted,
    reusableFreePages: Number(db.pragma("freelist_count", { simple: true })),
    initialRssBytes: initialRss,
    finalRssBeforeGcBytes: finalRssBeforeGc,
    finalRssBytes: process.memoryUsage().rss,
    finalHeapUsedBytes: process.memoryUsage().heapUsed,
    gcApplied: Boolean(globalThis.gc),
    retentionPreservedAllTime: true,
  };
  accepted = true;
} finally {
  await host.harness.lifecycle.dispose();
  const removed = await absent(databasePath);
  await writeFile(
    evidencePath,
    `${JSON.stringify({ checkedAt: new Date().toISOString(), surface: "production StatsStore, public SDK harness, real SQLite, synthetic data", ownership, accepted, metrics, storageCloseout: { databaseAbsent: removed, retained: evidencePath } }, null, 2)}\n`,
  );
  assert.ok(removed, "SDK harness SQLite must be removed at completion");
}

console.log(JSON.stringify({ evidencePath, accepted, metrics }));

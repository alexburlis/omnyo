import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { cpus, loadavg, platform, release } from "node:os";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { z } from "zod";
import {
  getLatestThreadSequence,
  getThreadHistoryState,
  historyCachePath,
  historySourceIdentity,
  insertEvents,
  noopNotifier,
  type DbConnection,
} from "@omnyo/db";
import { turnScope } from "@omnyo/domain";
import {
  buildHostDaemonWebSocketAuthorizationHeader,
  buildHostDaemonWebSocketProtocols,
} from "@omnyo/host-daemon-contract";
import { threadConversationOutlineResponseSchema } from "@omnyo/server-contract";
import { ensureHistoryCache } from "../../src/services/threads/history-cache-writer.js";
import { closeThreadTimelinePageBuilders } from "../../src/services/threads/timeline-page-builder.js";
import {
  timelineWorkerMessageSchema,
  type TimelineWorkerRequest,
  type TimelineWorkerResult,
} from "../../src/services/threads/timeline-worker-contract.js";
import { startDaemonLivenessChecks } from "../../src/ws/daemon-protocol.js";
import { seedHostSession } from "../helpers/seed.js";
import {
  createTestDaemonHostKey,
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";
import {
  benchmarkPaths,
  peerPath,
  readPreparedHistory,
  verifyPreparedBindings,
  type HistoryFixture,
} from "./history-stalls-fixture.js";

const healthSampleSchema = z.object({
  startedAt: z.number(),
  durationMs: z.number(),
  ok: z.boolean(),
});

const observationSchema = z.object({
  type: z.literal("observed"),
  health: z.array(healthSampleSchema),
  leases: z.array(
    z.object({
      observedAt: z.number(),
      status: z.string(),
      remainingMs: z.number(),
    }),
  ),
  sent: z.number(),
  acknowledgements: z.array(
    z.object({
      sentAt: z.number(),
      acknowledgedAt: z.number(),
      latencyMs: z.number(),
    }),
  ),
  unacknowledged: z.number(),
  errors: z.array(z.string()),
});

const lockSchema = z.object({
  type: z.literal("locked"),
  acquiredAt: z.number(),
  inTransaction: z.boolean(),
});

const releaseSchema = z.object({
  type: z.literal("released"),
  heldMs: z.number(),
});

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function messageOf<T extends z.ZodType>(
  worker: Worker,
  schema: T,
  timeoutMs = 10_000,
): Promise<z.infer<T>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () =>
        finish(
          new Error("Benchmark worker exceeded its bounded response time"),
        ),
      timeoutMs,
    );

    const receive = (message: unknown) => {
      const parsed = schema.safeParse(message);

      if (parsed.success) finish(null, parsed.data);
      else finish(new Error("Benchmark worker returned an unexpected result"));
    };

    const failed = () => finish(new Error("Benchmark worker failed"));

    const exited = () =>
      finish(new Error("Benchmark worker exited before its result"));

    const finish = (error: Error | null, value?: z.infer<T>) => {
      clearTimeout(timeout);
      worker.off("message", receive);
      worker.off("error", failed);
      worker.off("exit", exited);

      if (error !== null) reject(error);
      else if (value !== undefined) resolve(value);
    };

    worker.on("message", receive);
    worker.once("error", failed);
    worker.once("exit", exited);
  });
}

function appendMessage(
  db: DbConnection,
  threadId: string,
  text: string,
): number {
  const startedAt = performance.now();
  const sequence = getLatestThreadSequence(db, { threadId }) + 1;
  insertEvents(db, noopNotifier, [
    {
      threadId,
      sequence,
      scope: turnScope("live"),
      providerThreadId: "inert-benchmark-provider",
      type: "item/completed",
      itemId: `append-${sequence}`,
      itemKind: "agentMessage",
      parentToolCallId: null,
      data: JSON.stringify({
        item: { id: `append-${sequence}`, type: "agentMessage", text },
      }),
    },
  ]);

  return performance.now() - startedAt;
}

function expectedPreviews(
  fixture: HistoryFixture,
  additions: readonly string[],
): string[] {
  return [
    ...Array.from({ length: fixture.turns }, (_, index) => [
      `Question ${index}`,
      `Answer ${index}`,
    ]).flat(),
    ...additions,
  ];
}

function p95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  const result = sorted[Math.ceil(sorted.length * 0.95) - 1];

  if (result === undefined)
    throw new Error("No history latency samples were recorded");

  return result;
}

it("measures history isolation, production heartbeats and compiled cold readers on prepared inert inputs", async () => {
  const paths = benchmarkPaths();
  const prepared = readPreparedHistory();
  const workers = new Set<Worker>();
  const additions = new Map<string, string[]>();

  const result: Record<string, unknown> = {
    schema: 1,
    startedAt: new Date().toISOString(),
    prepared,
    machine: {
      platform: platform(),
      release: release(),
      cpu: cpus()[0]?.model ?? "unknown",
      logicalCpus: cpus().length,
      loadAverage: loadavg(),
      node: process.version,
    },
    limits: [
      "Synthetic Mac fixture; production VPS and physical-device latency are not measured.",
      "Fresh workers and missing derived records retain the operating system file cache; this does not claim a flushed disk cache.",
      "HTTP measurements use the source test server and source-loader workers; compiled cold samples use the exact bound production worker entries.",
      "Nearest-rank p95 uses 20 samples per warm and append group; all raw samples and errors are retained.",
    ],
    command:
      "pnpm exec turbo run test --only --filter=@omnyo/server -- test/performance/history-stalls.bench.test.ts",
  };

  let server: RunningTestServer | null = null;
  let stopLiveness: (() => void) | null = null;
  let failed: unknown = null;

  const spawn = (data: Record<string, unknown>) => {
    const worker = new Worker(peerPath, {
      workerData: {
        ...data,
        sqliteModule: fileURLToPath(import.meta.resolve("better-sqlite3")),
        wsModule: createRequire(import.meta.url).resolve("ws"),
      },
      env: {},
      execArgv: [],
    });

    workers.add(worker);

    return worker;
  };

  const stopPeer = async (worker: Worker) => {
    const observed = messageOf(worker, observationSchema);
    worker.postMessage({ type: "stop" });
    const observation = await observed;
    await worker.terminate();
    workers.delete(worker);

    return observation;
  };

  const releaseLock = async (worker: Worker) => {
    const released = messageOf(worker, releaseSchema);
    worker.postMessage({ type: "release" });
    const receipt = await released;
    await worker.terminate();
    workers.delete(worker);

    return receipt;
  };

  const compiledRequest = async (
    entry: string,
    request: TimelineWorkerRequest,
  ) => {
    const startedAt = performance.now();

    const worker = new Worker(entry, {
      workerData: { databasePath: prepared.databasePath, mode: "read" },
      env: {},
      execArgv: [],
    });

    workers.add(worker);

    try {
      const pending = messageOf(worker, timelineWorkerMessageSchema, 5_000);
      worker.postMessage(request);
      const message = await pending;
      const durationMs = performance.now() - startedAt;

      if (message.type === "error")
        throw new Error(
          `Compiled history read failed with status ${message.status}`,
        );
      expect(durationMs).toBeLessThan(5_000);

      return { message, durationMs };
    } finally {
      await worker.terminate();
      workers.delete(worker);
    }
  };

  try {
    server = await startTestServer({ databaseSource: prepared.databasePath });
    const running = server;

    const negativePeer = spawn({
      kind: "peer",
      databasePath: prepared.databasePath,
      healthUrl: `${running.baseUrl}/health`,
      sessionId: null,
    });

    await messageOf(negativePeer, z.object({ type: z.literal("ready") }));
    await delay(100);

    const primaryLock = spawn({
      kind: "lock",
      surface: "primary",
      databasePath: prepared.databasePath,
      threadId: prepared.overlap.threadId,
    });

    const primaryLocked = await messageOf(primaryLock, lockSchema);
    expect(primaryLocked.inTransaction).toBe(true);
    const negativeStarted = performance.now();
    let primaryBlocked = false;

    try {
      appendMessage(
        running.db,
        prepared.overlap.threadId,
        "negative control must roll back",
      );
    } catch {
      primaryBlocked = true;
    }

    const negativeAppendMs = performance.now() - negativeStarted;
    const primaryReleased = await releaseLock(primaryLock);
    await delay(100);
    const negativeObservation = await stopPeer(negativePeer);
    result.primaryLockNegativeControl = {
      primaryLocked,
      primaryReleased,
      primaryBlocked,
      negativeAppendMs,
      observation: negativeObservation,
    };
    expect(primaryBlocked).toBe(true);
    expect(negativeAppendMs).toBeGreaterThanOrEqual(1_000);
    expect(
      negativeObservation.health.some(
        (sample) => sample.durationMs >= 1_000 || !sample.ok,
      ),
    ).toBe(true);

    await ensureHistoryCache(running.db);
    const daemon = seedHostSession(running.deps);
    stopLiveness = startDaemonLivenessChecks(running.deps);

    const peer = spawn({
      kind: "peer",
      databasePath: prepared.databasePath,
      healthUrl: `${running.baseUrl}/health`,
      sessionId: daemon.session.id,
      websocketUrl: `${running.baseUrl.replace("http:", "ws:")}/internal/ws?sessionId=${encodeURIComponent(daemon.session.id)}`,
      authorization: buildHostDaemonWebSocketAuthorizationHeader(
        createTestDaemonHostKey({ hostId: daemon.host.id }),
      ),
      protocols: buildHostDaemonWebSocketProtocols(),
    });

    await messageOf(peer, z.object({ type: z.literal("ready") }));

    const cacheLock = spawn({
      kind: "lock",
      surface: "cache",
      databasePath: historyCachePath(prepared.databasePath),
      threadId: prepared.overlap.threadId,
      sourceIdentity: historySourceIdentity(prepared.databasePath),
      rewriteEpoch: getThreadHistoryState(running.db, prepared.overlap.threadId)
        .rewriteEpoch,
    });

    const cacheLocked = await messageOf(cacheLock, lockSchema);
    expect(cacheLocked.inTransaction).toBe(true);
    const lockedAt = performance.now();
    const coldStartedAt = performance.now();

    const coldFailure = fetch(
      `${running.baseUrl}/api/v1/threads/${prepared.overlap.threadId}/conversation-outline`,
    ).then(async (response) => ({
      status: response.status,
      body: await response.json(),
      durationMs: performance.now() - coldStartedAt,
    }));

    const primaryAppendMs: number[] = [];
    const appendFixture = prepared.warm[0]!;

    for (let index = 0; index < 20; index++) {
      const text = `Primary append ${index}`;
      primaryAppendMs.push(
        appendMessage(running.db, appendFixture.threadId, text),
      );
      additions.set(appendFixture.threadId, [
        ...(additions.get(appendFixture.threadId) ?? []),
        text,
      ]);
      await delay(3_000);
    }

    await delay(Math.max(0, 66_000 - (performance.now() - lockedAt)));
    const cacheReleased = await releaseLock(cacheLock);
    const observation = await stopPeer(peer);
    const writeFailure = await coldFailure;
    result.cacheLockOverlap = {
      cacheLocked,
      cacheReleased,
      primaryAppendMs,
      writeFailure,
      observation,
    };
    expect(cacheReleased.heldMs).toBeGreaterThan(65_000);
    expect(writeFailure.status).toBe(503);
    expect(observation.errors).toEqual([]);
    expect(observation.health.length).toBeGreaterThanOrEqual(20);
    expect(
      observation.health.every(
        (sample) => sample.ok && sample.durationMs < 1_000,
      ),
    ).toBe(true);
    expect(primaryAppendMs.length).toBe(20);
    expect(Math.max(...primaryAppendMs)).toBeLessThan(1_000);
    expect(observation.acknowledgements.length).toBeGreaterThanOrEqual(13);
    expect(observation.unacknowledged).toBe(0);
    expect(
      observation.acknowledgements.every((ack) => ack.latencyMs < 2_000),
    ).toBe(true);
    expect(
      observation.acknowledgements
        .slice(1)
        .every(
          (ack, index) =>
            ack.acknowledgedAt -
              observation.acknowledgements[index]!.acknowledgedAt <
            7_000,
        ),
    ).toBe(true);
    expect(observation.leases.length).toBeGreaterThanOrEqual(60);
    expect(
      observation.leases.every(
        (lease) =>
          lease.status === "active" &&
          lease.remainingMs > 0 &&
          lease.remainingMs <= 30_000,
      ),
    ).toBe(true);
    stopLiveness();
    stopLiveness = null;

    const httpRead = async (fixture: HistoryFixture) => {
      const startedAt = performance.now();

      const response = await fetch(
        `${running.baseUrl}/api/v1/threads/${fixture.threadId}/conversation-outline`,
        { signal: AbortSignal.timeout(5_000) },
      );

      const outline = threadConversationOutlineResponseSchema.parse(
        await response.json(),
      );

      const durationMs = performance.now() - startedAt;
      expect(response.status).toBe(200);
      expect(outline.items.map((item) => item.preview)).toEqual(
        expectedPreviews(fixture, additions.get(fixture.threadId) ?? []),
      );

      return durationMs;
    };

    const latency: {
      turns: number;
      warmMs: number[];
      appendMs: number[];
      warmP95Ms: number;
      appendP95Ms: number;
    }[] = [];

    result.httpLatency = latency;

    for (const fixture of prepared.warm) {
      await httpRead(fixture);
      const warmMs: number[] = [];
      const appendMs: number[] = [];

      const samples = {
        turns: fixture.turns,
        warmMs,
        appendMs,
        warmP95Ms: 0,
        appendP95Ms: 0,
      };

      latency.push(samples);

      for (let index = 0; index < 20; index++)
        warmMs.push(await httpRead(fixture));

      for (let index = 0; index < 20; index++) {
        const text = `Measured append ${index}`;
        appendMessage(running.db, fixture.threadId, text);
        additions.set(fixture.threadId, [
          ...(additions.get(fixture.threadId) ?? []),
          text,
        ]);
        appendMs.push(await httpRead(fixture));
      }

      samples.warmP95Ms = p95(warmMs);
      samples.appendP95Ms = p95(appendMs);
      expect(samples.warmP95Ms).toBeLessThan(500);
      expect(samples.appendP95Ms).toBeLessThan(500);
    }

    const coldSamples: {
      durationMs: number;
      entry: string;
      threadId: string;
    }[] = [];

    result.compiledCold = coldSamples;

    for (const [index, fixture] of prepared.cold.entries()) {
      const entry = prepared.compiledWorkers[index === 4 ? 1 : 0]!.path;

      const built = await compiledRequest(entry, {
        kind: "outline",
        id: `cold-${index}`,
        threadId: fixture.threadId,
        options: {
          completedTurnDisplay: "flat",
          includeClearedContextHistory: false,
          maxSeq: fixture.events,
        },
      });

      if (built.message.type !== "outline-result")
        throw new Error("Compiled reader returned the wrong history surface");

      const outline = threadConversationOutlineResponseSchema.parse(
        JSON.parse(built.message.result.body),
      );

      expect(outline.items.map((item) => item.preview)).toEqual(
        expectedPreviews(fixture, []),
      );
      expect(built.message.result.workerThreadId).toBeGreaterThan(0);
      coldSamples.push({
        durationMs: built.durationMs,
        entry,
        threadId: fixture.threadId,
      });
    }

    const profiles: {
      fixture: HistoryFixture;
      durationMs: number;
      profile: TimelineWorkerResult["profile"];
      queries: TimelineWorkerResult["queries"];
    }[] = [];

    result.groupContext = profiles;

    for (const [index, fixture] of prepared.progress.entries()) {
      const built = await compiledRequest(prepared.compiledWorkers[0]!.path, {
        kind: "timeline",
        id: `profile-${index}`,
        threadId: fixture.threadId,
        options: {
          compactionOfferEnabled: false,
          completedTurnDisplay: "collapse",
          deferContent: true,
          eventBudget: 1500,
          includeClearedContextHistory: false,
          includeDiagnosticOperations: false,
          includeNestedRows: true,
          maxInlineOutputChars: 32768,
          maxSeq: fixture.events,
          page: { kind: "latest", segmentLimit: 20 },
        },
      });

      if (built.message.type !== "result")
        throw new Error("Compiled reader returned the wrong timeline surface");
      const profile = built.message.result.profile;
      profiles.push({
        fixture,
        durationMs: built.durationMs,
        profile,
        queries: built.message.result.queries,
      });

      const groupContextMs = profile.stageTimings
        .filter((stage) => stage.stage === "group-context-query")
        .reduce((total, stage) => total + stage.durationMs, 0);

      expect(groupContextMs).toBeLessThan(5_000);
    }

    expect(profiles[1]!.profile.decodedEventCount).toBeLessThanOrEqual(
      profiles[0]!.profile.decodedEventCount * 2 + 32,
    );
    expect(profiles[1]!.profile.eventDataBytes).toBeLessThanOrEqual(
      profiles[0]!.profile.eventDataBytes * 2 + 65_536,
    );
    verifyPreparedBindings(prepared);
    result.bindingsVerifiedAtFinish = true;
    result.status = "passed";
  } catch (error) {
    failed = error;
    result.status = "failed";
    result.failure =
      error instanceof Error
        ? { name: error.name, message: error.message }
        : { name: "Unknown failure" };
  } finally {
    stopLiveness?.();
    const cleanupErrors: string[] = [];

    const stopped = await Promise.allSettled(
      [...workers].map((worker) => worker.terminate()),
    );

    if (stopped.some((entry) => entry.status === "rejected"))
      cleanupErrors.push("An observation or lock worker did not close");
    workers.clear();

    if (server !== null) {
      try {
        await closeThreadTimelinePageBuilders(server.db);
        await server.close();
        server.db.$client.close();
      } catch {
        cleanupErrors.push("The benchmark server did not close");
      }
    }

    const allocation = readdirSync(prepared.directory).map((name) => {
      const file = statSync(resolve(prepared.directory, name));

      return {
        path: resolve(prepared.directory, name),
        bytes: file.size,
        allocatedBytes: file.blocks * 512,
      };
    });

    result.storageBeforeCloseout = allocation;
    result.cleanupErrors = cleanupErrors;

    if (cleanupErrors.length > 0) {
      failed ??= new Error(cleanupErrors.join("; "));
      result.status = "failed";
    }

    result.finishedAt = new Date().toISOString();
    writeFileSync(paths.result, JSON.stringify(result, null, 2) + "\n", {
      mode: 0o600,
    });

    if (cleanupErrors.length === 0 && failed === null) {
      try {
        rmSync(prepared.directory, { recursive: true });
      } catch {
        cleanupErrors.push("Owned fixture removal failed");
        failed ??= new Error("Owned fixture removal failed");
        result.status = "failed";
        writeFileSync(paths.result, JSON.stringify(result, null, 2) + "\n", {
          mode: 0o600,
        });
      }
    }

    const prior: unknown = JSON.parse(readFileSync(paths.receipt, "utf8"));
    const filesystem = statfsSync(dirname(prepared.directory));
    writeFileSync(
      paths.receipt,
      JSON.stringify(
        {
          prior,
          owner: prepared.owner,
          directory: prepared.directory,
          state:
            cleanupErrors.length > 0
              ? "cleanup-failed-retained"
              : failed === null
                ? "measurement-closed"
                : "measurement-failed-retained",
          removed:
            cleanupErrors.length === 0 && failed === null
              ? [prepared.directory]
              : [],
          absent: !existsSync(prepared.directory),
          retained: [paths.result, paths.manifest, paths.receipt],
          retainedReason:
            "Source bindings, raw performance samples and exact storage closeout",
          consumersClosed: cleanupErrors.length === 0,
          allocationBeforeRemoval: allocation,
          freeBytesAfter: filesystem.bavail * filesystem.bsize,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }

  if (failed !== null) throw failed;
}, 240_000);

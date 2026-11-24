import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { fork, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  createCredentialTextRedactor,
  jsonValueSchema,
  type JsonValue,
} from "../../../packages/domain/src/index.ts";
import { createHistoryFixture, hashFile } from "./fixture.mts";
import {
  appendCalibratedTurns,
  createCalibratedHistoryFixture,
} from "./calibrated-fixture.mts";

const repository =
  process.argv.find((arg) => arg.startsWith("--repository="))?.slice(13) ??
  fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

const proofRoot = `${repository}/.tmp/instant-chat-history-20261018`;

const isChild = process.argv.includes("--child");

const smoke = process.argv.includes("--smoke");

const oracleOnly = process.argv.includes("--oracle-only");

const calibrated = process.argv.includes("--calibrated");

const after = process.argv.includes("--after");

const compiledChild = process.argv
  .find((argument) => argument.startsWith("--compiled-child="))
  ?.slice("--compiled-child=".length);

type HistoryFixture =
  | ReturnType<typeof createHistoryFixture>
  | ReturnType<typeof createCalibratedHistoryFixture>;

const sampleCount =
  smoke || oracleOnly
    ? 1
    : z.coerce
        .number()
        .int()
        .min(1)
        .max(20)
        .parse(
          process.argv
            .find((argument) => argument.startsWith("--samples="))
            ?.slice("--samples=".length) ?? 6,
        );

const measurementRestarts =
  sampleCount + (after && !smoke && !oracleOnly ? 1 : 0);

const prefix = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .parse(
    process.argv
      .find((argument) => argument.startsWith("--output-prefix="))
      ?.slice("--output-prefix=".length) ??
      (calibrated
        ? `calibrated-service-before${smoke ? "-smoke" : ""}`
        : smoke
          ? "baseline-service-smoke"
          : oracleOnly
            ? "baseline-service-oracle"
            : "baseline-service"),
  );

const exec = promisify(execFile);

const messageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    baseUrl: z.string(),
    pid: z.number(),
    databaseName: z.string(),
    dataDir: z.string(),
    runtime: z.object({
      nativeModuleVersion: z.string(),
      nodeVersion: z.string(),
      nodeAbi: z.string(),
      compiled: z.boolean(),
      execArgv: z.array(z.string()),
    }),
  }),
  z.object({ type: z.literal("timeline-received"), marker: z.string() }),
  z.object({
    type: z.literal("timeline-served"),
    marker: z.string(),
    workerStarts: z.number(),
    status: z.number(),
  }),
  z.object({ type: z.literal("closed"), modelTurnRequests: z.number().int() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

type ChildMessage = z.infer<typeof messageSchema>;

const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

function orderedJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(orderedJson);
  const record = jsonObjectSchema.safeParse(value);

  if (!record.success) return value;

  return Object.fromEntries(
    Object.entries(record.data)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, orderedJson(entry)]),
  );
}

function contentOracle(body: string, fixture: HistoryFixture) {
  const response = jsonObjectSchema.parse(JSON.parse(body));

  const {
    runtimeId: _runtimeId,
    revision: _revision,
    timelinePage,
    ...retained
  } = response;

  const {
    historySnapshot: _historySnapshot,
    olderCursor,
    ...page
  } = jsonObjectSchema.parse(timelinePage);

  const cursor =
    olderCursor === null
      ? null
      : (() => {
          const { anchorId: _anchorId, ...rest } =
            jsonObjectSchema.parse(olderCursor);

          return rest;
        })();

  let normalized = JSON.stringify(
    orderedJson({
      ...retained,
      timelinePage: { ...page, olderCursor: cursor },
    }),
  );

  const identities = new Map([
    [fixture.projectId, "<project>"],
    [fixture.environmentId, "<environment>"],
    [fixture.hostId, "<host>"],
    ...fixture.histories.map(
      (history) => [history.threadId, `<${history.kind}-thread>`] as const,
    ),
  ]);

  for (const [identity, replacement] of identities)
    normalized = normalized.replaceAll(identity, replacement);

  return {
    sha256: createHash("sha256").update(normalized).digest("hex"),
    normalizedBytes: Buffer.byteLength(normalized),
    omittedFields: [
      "runtimeId",
      "revision",
      "timelinePage.historySnapshot",
      "timelinePage.olderCursor.anchorId",
    ],
    retainedCursor: cursor,
    retainedPageFields: Object.keys(page),
    retainedResponseFields: Object.keys(retained),
  };
}

async function bytesUnder(directory: string): Promise<number> {
  let size = 0;

  for (const entry of await readdir(directory, { withFileTypes: true }))
    size += entry.isDirectory()
      ? await bytesUnder(`${directory}/${entry.name}`)
      : (await stat(`${directory}/${entry.name}`)).size;

  return size;
}

if (isChild) {
  let workerStarts = 0;

  const workerHook = createHook({
    init(_id, type) {
      if (type === "WORKER") workerStarts += 1;
    },
  });

  workerHook.enable();

  const config = z
    .object({
      databasePath: z.string(),
      hostId: z.string(),
      compiled: z.boolean(),
    })
    .parse(JSON.parse(process.argv.at(-1)!));

  const { createTestAppHarness } =
    await import("../../../apps/server/test/helpers/test-app.ts");

  const { minimalProviderRegistration } =
    await import("../../../apps/server/test/helpers/provider-registry.ts");

  const { makeProviderInfo } =
    await import("../../../packages/test-helpers/src/domain-fixtures.ts");

  const { seedHostSession } =
    await import("../../../apps/server/test/helpers/seed.ts");

  const { listQueuedCommands } =
    await import("../../../apps/server/test/helpers/commands.ts");

  const serverRequire = createRequire(`${repository}/apps/server/package.json`);

  const nativeRequire = config.compiled
    ? createRequire(import.meta.url)
    : serverRequire;

  const nativeModule = z
    .object({ version: z.string() })
    .parse(nativeRequire("better-sqlite3/package.json"));

  const { serve } = await import(
    pathToFileURL(serverRequire.resolve("@hono/node-server")).href
  );

  let harness: Awaited<ReturnType<typeof createTestAppHarness>> | undefined;

  try {
    harness = await createTestAppHarness({
      databaseSource: config.databasePath,
      seedFirstPartyProviders: false,
    });
    harness.deps.providerRegistry.register(
      minimalProviderRegistration({
        pluginId: "provider-inert",
        info: makeProviderInfo({ id: "codex", pluginId: "provider-inert" }),
        serverCapabilities: {
          reasoningLevels: ["medium"],
          fork: "none",
          supportsManualCompaction: false,
        },
      }),
    );
    seedHostSession(harness.deps, { id: config.hostId });
    const app = harness.app;

    const server = serve(
      {
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request: Request) => {
          const marker = request.headers.get("x-instant-history-probe");
          const startsBefore = workerStarts;

          if (marker) process.send?.({ type: "timeline-received", marker });

          return Promise.resolve(app.fetch(request)).then((response) => {
            if (marker)
              process.send?.({
                type: "timeline-served",
                marker,
                workerStarts: workerStarts - startsBefore,
                status: response.status,
              });

            return response;
          });
        },
      },
      (address: { port: number }) =>
        process.send?.({
          type: "ready",
          baseUrl: `http://127.0.0.1:${address.port}`,
          pid: process.pid,
          databaseName: harness!.db.$client.name,
          dataDir: harness!.config.dataDir,
          runtime: {
            nativeModuleVersion: nativeModule.version,
            nodeVersion: process.version,
            nodeAbi: process.versions.modules,
            compiled: config.compiled,
            execArgv: process.execArgv,
          },
        }),
    );

    process.on("message", async (message) => {
      if (message !== "stop") return;
      await new Promise<void>((resolve, reject) =>
        server.close((error: Error | undefined) =>
          error ? reject(error) : resolve(),
        ),
      );

      await harness!.cleanup();
      harness!.db.$client.close();
      workerHook.disable();
      process.send?.(
        {
          type: "closed",
          modelTurnRequests: listQueuedCommands(harness!, "turn.submit").length,
        },
        () => {
          process.disconnect();
          process.exit(0);
        },
      );
    });
  } catch (error) {
    await harness?.cleanup();
    harness?.db.$client.close();
    process.send?.({
      type: "error",
      message:
        error instanceof Error ? error.message : "Unknown harness failure",
    });
    process.exitCode = 1;
    process.disconnect();
  }
} else {
  const admission = JSON.parse(
    await readFile(`${proofRoot}/${prefix}-admission.json`, "utf8"),
  );

  const scratch = admission.scratchPath;
  assert.ok(scratch.startsWith(`${proofRoot}/${prefix}-scratch-`));
  await assert.rejects(access(scratch));
  const startedAt = performance.now();
  const children = new Set<ReturnType<typeof fork>>();
  const childErrors: Array<{ pid: number | undefined; stderr: string }> = [];

  const runBudgetMs = calibrated
    ? sampleCount > 6
      ? 120_000
      : 60_000
    : 180_000;

  const deadline = setTimeout(() => {
    for (const child of children) child.kill("SIGTERM");
  }, runBudgetMs);

  deadline.unref();
  const samples = [];
  let fixture: HistoryFixture | undefined;

  const appendOracles: Array<{
    history: string;
    kind: string;
    bodyBytes: number;
    wallMs: number;
    contentOracle: ReturnType<typeof contentOracle>;
  }> = [];

  let beforeAppendFixture: HistoryFixture | undefined;
  let peakScratchBytes = 0;
  let failed = false;

  const sourcePaths = [
    "apps/server/test/helpers/test-app.ts",
    "apps/server/src/routes/threads/data.ts",
    "apps/server/src/services/threads/timeline.ts",
    "apps/server/src/services/threads/timeline-cache.ts",
    "apps/server/src/services/threads/timeline-context-order.ts",
    "apps/server/src/services/threads/timeline-selection-memo.ts",
    "apps/server/src/services/threads/timeline-snapshot.ts",
    "apps/server/src/services/threads/timeline-page-builder.ts",
    "apps/server/src/services/threads/timeline-root-cache.ts",
    "apps/server/src/services/threads/timeline-worker.ts",
    "apps/server/src/services/threads/timeline-worker-contract.ts",
    "apps/server/src/services/threads/thread-history-redaction.ts",
    "packages/db/src/schema.ts",
    "packages/db/src/data/events.ts",
    "packages/db/src/data/timeline-derived-cache.ts",
    "packages/db/src/data/timeline-history-epoch.ts",
    "packages/db/drizzle/0144_timeline_history_cache.sql",
    "packages/db/drizzle/meta/_journal.json",
    "tests/qa/instant-chat-history/service-proof.mts",
    "tests/qa/instant-chat-history/fixture.mts",
    ...(calibrated
      ? ["tests/qa/instant-chat-history/calibrated-fixture.mts"]
      : []),
  ];

  const sourceHashes = Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (path) => [
        path,
        await hashFile(`${repository}/${path}`),
      ]),
    ),
  );

  const sourceCommit = (
    await exec("git", ["rev-parse", "HEAD"], { cwd: repository })
  ).stdout.trim();

  async function request(url: string, init?: RequestInit) {
    const start = performance.now();

    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(45_000),
      headers: { "accept-encoding": "identity", ...init?.headers },
    });

    const headersMs = performance.now() - start;
    const body = await response.text();

    return {
      status: response.status,
      headersMs,
      wallMs: performance.now() - start,
      bodyBytes: Buffer.byteLength(body),
      body,
      contentEncoding: response.headers.get("content-encoding"),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
  }

  const result = await (async () => {
    try {
      await mkdir(scratch);
      const databasePath = `${scratch}/fixture.db`;
      fixture = calibrated
        ? createCalibratedHistoryFixture(databasePath, smoke)
        : createHistoryFixture(databasePath, smoke);
      beforeAppendFixture = fixture;
      const fixtureDatabaseSHA256 = await hashFile(databasePath);
      peakScratchBytes = await bytesUnder(scratch);
      assert.ok(peakScratchBytes < admission.ceilingBytes);

      for (
        let restart = 0;
        restart < measurementRestarts + (calibrated ? 1 : 0);
        restart += 1
      ) {
        const afterAppend = calibrated && restart === measurementRestarts;

        if (afterAppend) {
          assert.ok(fixture && "calibration" in fixture);
          fixture = appendCalibratedTurns(databasePath, fixture);
        }

        const child = fork(
          compiledChild ?? fileURLToPath(import.meta.url),
          [
            "--child",
            `--repository=${repository}`,
            JSON.stringify({
              databasePath,
              hostId: fixture.hostId,
              compiled: compiledChild !== undefined,
            }),
          ],
          {
            cwd: repository,
            execArgv:
              compiledChild === undefined
                ? ["--conditions=source", "--import", "tsx"]
                : [],
            env:
              compiledChild === undefined
                ? { ...process.env, TMPDIR: scratch }
                : {
                    PATH: process.env.PATH,
                    HOME: process.env.HOME,
                    USER: process.env.USER,
                    LOGNAME: process.env.LOGNAME,
                    TMPDIR: scratch,
                  },
            stdio: ["ignore", "ignore", "pipe", "ipc"],
          },
        );

        children.add(child);

        let stderr = "";
        child.stderr!.setEncoding("utf8");
        child.stderr!.on("data", (data: string) => {
          stderr = (stderr + data).slice(-16_384);
        });

        const exited = new Promise<number | null>((resolve) =>
          child.once("exit", resolve),
        );

        const messages: ChildMessage[] = [];
        const listeners = new Set<() => void>();
        child.on("message", (message) => {
          messages.push(messageSchema.parse(message));

          for (const listener of listeners) listener();
        });
        child.once("exit", (code) => {
          if (stderr.length > 0)
            childErrors.push({
              pid: child.pid,
              stderr: createCredentialTextRedactor([])(
                `Child stderr: ${stderr}`,
              ),
            });

          if (!messages.some((message) => message.type === "closed"))
            messages.push({
              type: "error",
              message: `Child exited before close:${code}`,
            });

          for (const listener of listeners) listener();
        });

        async function waitMessage(
          type: ChildMessage["type"],
          marker?: string,
        ): Promise<ChildMessage> {
          return await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
              listeners.delete(check);
              reject(new Error(`Bounded child message timeout:${type}`));
            }, 30_000);

            function check() {
              const error = messages.find(
                (message) => message.type === "error",
              );

              const found = messages.find(
                (message) =>
                  message.type === type &&
                  (marker === undefined ||
                    ((message.type === "timeline-received" ||
                      message.type === "timeline-served") &&
                      message.marker === marker)),
              );

              if (!error && !found) return;
              clearTimeout(timeout);
              listeners.delete(check);

              if (error) reject(new Error(String(error.message)));
              else resolve(found!);
            }

            listeners.add(check);
            check();
          });
        }

        const ready = await waitMessage("ready");
        assert.equal(ready.type, "ready");

        if (ready.type !== "ready") throw new Error("Missing ready message");
        assert.equal(ready.databaseName, databasePath);
        const baseUrl = String(ready.baseUrl);
        const idleHealth = await request(`${baseUrl}/health`);
        assert.equal(idleHealth.status, 200);

        for (const history of fixture.histories.filter(
          (history) => !afterAppend || history.kind === "completed",
        )) {
          for (const mode of oracleOnly || afterAppend
            ? (["cold-process-cache"] as const)
            : (["cold-process-cache", "warm"] as const)) {
            const marker = `${restart}-${history.kind}-${mode}`;

            const timelinePromise = request(
              `${baseUrl}/api/v1/threads/${history.threadId}/timeline?includeNestedRows=true&deferContent=true&segmentLimit=20${after ? "&priority=background" : ""}`,
              { headers: { "x-instant-history-probe": marker } },
            );

            await waitMessage("timeline-received", marker);
            const healthPromise = request(`${baseUrl}/health`);

            const createPromise = request(`${baseUrl}/api/v1/threads`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                origin: "app",
                projectId: fixture.projectId,
                providerId: "codex",
                model: "inert-model",
                permissionMode: "full",
                input: [
                  {
                    type: "text",
                    text: "Inert scheduled responsiveness probe",
                  },
                ],
                environment: {
                  type: "reuse",
                  environmentId: fixture.environmentId,
                },
                sendAt: Date.now() + 3_600_000,
              }),
            });

            const foregroundHistory = fixture.histories.find(
              (candidate) => candidate.kind === "open",
            );

            const foregroundPromise =
              after &&
              restart === 0 &&
              history.kind === "completed" &&
              mode === "cold-process-cache" &&
              foregroundHistory !== undefined
                ? request(
                    `${baseUrl}/api/v1/threads/${foregroundHistory.threadId}/timeline?includeNestedRows=true&deferContent=true&segmentLimit=20`,
                  )
                : Promise.resolve(undefined);

            let probeHealth =
              after &&
              restart === 0 &&
              history.kind === "completed" &&
              mode === "cold-process-cache";

            const healthDuringBuild: Array<{
              status: number;
              wallMs: number;
            }> = [];

            const healthSentinel = (async () => {
              while (probeHealth) {
                const probe = await request(`${baseUrl}/health`);
                healthDuringBuild.push({
                  status: probe.status,
                  wallMs: probe.wallMs,
                });
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            })();

            const [timeline, health, created, foreground] = await Promise.all([
              timelinePromise,
              healthPromise,
              createPromise,
              foregroundPromise,
            ]);

            probeHealth = false;
            await healthSentinel;

            const execution = await waitMessage("timeline-served", marker);

            if (foreground !== undefined) assert.equal(foreground.status, 200);

            assert.equal(
              timeline.status,
              200,
              `Timeline ${history.kind} status:${timeline.status}`,
            );
            assert.equal(health.status, 200);
            assert.equal(
              created.status,
              201,
              `Scheduled create status:${created.status}:${created.body.slice(0, 250)}`,
            );
            const body = JSON.parse(timeline.body);
            assert.equal(body.maxSeq, history.maxSeq);
            assert.ok(Array.isArray(body.rows) && body.rows.length > 0);

            const normalized = timeline.body
              .replaceAll(history.threadId, `<${history.kind}-thread>`)
              .replaceAll(fixture.projectId, "<project>")
              .replaceAll(fixture.environmentId, "<environment>");

            const { body: _timelineBody, ...timelineMetrics } = timeline;
            const { body: _healthBody, ...healthMetrics } = health;
            const { body: _createdBody, ...createMetrics } = created;
            samples.push({
              restart,
              phase: afterAppend ? "after-append" : "before-append",
              mode,
              history: history.kind,
              serverPid: ready.pid,
              runtime: ready.runtime,
              idleHealthWallMs: idleHealth.wallMs,
              timeline: {
                ...timelineMetrics,
                rows: body.rows.length,
                hasOlderRows: body.timelinePage.hasOlderRows,
                contentOracle: contentOracle(timeline.body, fixture),
                semanticSHA256: createHash("sha256")
                  .update(normalized)
                  .digest("hex"),
              },
              health: healthMetrics,
              create: createMetrics,
              execution,
              healthDuringBuild,
              foreground:
                foreground === undefined
                  ? undefined
                  : {
                      status: foreground.status,
                      wallMs: foreground.wallMs,
                      bodyBytes: foreground.bodyBytes,
                    },
              probesStartedAfterTimelineIngress: true,
            });

            if (calibrated && restart === 0 && mode === "cold-process-cache")
              appendOracles.push({
                history: history.kind,
                kind: "before-append-latest",
                bodyBytes: timeline.bodyBytes,
                wallMs: timeline.wallMs,
                contentOracle: contentOracle(timeline.body, fixture),
              });

            if (afterAppend) {
              appendOracles.push({
                history: history.kind,
                kind: "after-append-latest",
                bodyBytes: timeline.bodyBytes,
                wallMs: timeline.wallMs,
                contentOracle: contentOracle(timeline.body, fixture),
              });
              let pageBody = timeline.body;

              for (let page = 0; page < 8; page += 1) {
                const parsed = jsonObjectSchema.parse(JSON.parse(pageBody));

                if (
                  JSON.stringify(parsed.rows).includes("calibrated-giant-root")
                )
                  break;
                const metadata = jsonObjectSchema.parse(parsed.timelinePage);

                const cursor = z
                  .object({ anchorId: z.string(), anchorSeq: z.number() })
                  .parse(metadata.olderCursor);

                const older = await request(
                  `${baseUrl}/api/v1/threads/${history.threadId}/timeline?includeNestedRows=true&deferContent=true&segmentLimit=20&beforeAnchorSeq=${cursor.anchorSeq}&beforeAnchorId=${encodeURIComponent(cursor.anchorId)}`,
                );

                assert.equal(older.status, 200);
                appendOracles.push({
                  history: history.kind,
                  kind: `after-append-older-${page + 1}`,
                  bodyBytes: older.bodyBytes,
                  wallMs: older.wallMs,
                  contentOracle: contentOracle(older.body, fixture),
                });
                pageBody = older.body;
              }

              assert.ok(
                JSON.stringify(
                  jsonObjectSchema.parse(JSON.parse(pageBody)).rows,
                ).includes("calibrated-giant-root"),
                "After append walk did not retrieve the completed giant root",
              );
            }

            peakScratchBytes = Math.max(
              peakScratchBytes,
              await bytesUnder(scratch),
            );
            assert.ok(peakScratchBytes < admission.ceilingBytes);
          }
        }

        child.send("stop");
        const closed = await waitMessage("closed");
        assert.equal(closed.type, "closed");

        if (closed.type === "closed") assert.equal(closed.modelTurnRequests, 0);

        const exitCode = await Promise.race([
          exited,
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Child exit exceeded10s")),
              10_000,
            );

            timeout.unref();
          }),
        ]);

        assert.equal(exitCode, 0);
        await assert.rejects(access(ready.dataDir));
        children.delete(child);
        process.stdout.write(
          JSON.stringify({
            stage: "restart-complete",
            restart,
            elapsedMs: performance.now() - startedAt,
            samples: samples.length,
          }) + "\n",
        );
        assert.ok(
          performance.now() - startedAt < runBudgetMs,
          "Measured workload exceeded admitted time budget",
        );
      }

      const sourceHashesAfter = Object.fromEntries(
        await Promise.all(
          sourcePaths.map(async (path) => [
            path,
            await hashFile(`${repository}/${path}`),
          ]),
        ),
      );

      assert.deepEqual(sourceHashesAfter, sourceHashes);

      for (const history of fixture.histories)
        assert.equal(
          new Set(
            samples.flatMap((sample) =>
              sample.history === history.kind &&
              sample.phase === "before-append"
                ? [sample.timeline.semanticSHA256]
                : [],
            ),
          ).size,
          1,
        );

      return {
        ok: true,
        at: new Date().toISOString(),
        sourceCommit,
        sourceHashes,
        sourceUnchangedDuringRun: true,
        smoke,
        oracleOnly,
        sampleCount,
        measurementRestarts,
        after,
        compiledChild,
        childErrors,
        fixture,
        calibrated,
        beforeAppendFixture: calibrated ? beforeAppendFixture : undefined,
        appendOracles: calibrated ? appendOracles : undefined,
        fixtureDatabaseSHA256,
        samples,
        wallMs: performance.now() - startedAt,
        peakScratchBytes,
        cacheConditions:
          "Fresh server process per restart;fixture DB and OS filesystem caches retained;no drop-cache/cold-disk claim;warm follows same thread's first request in that process",
        limits:
          "Source/test-harness real HTTP on local loopback,identity encoding,independent client process. Future-scheduled201 creates use existing inert test-session/RPC capture;model turn requests must stay0. No real provider/host,production/native/package or exact original502 attribution claim.",
      };
    } catch (error) {
      failed = true;

      return {
        ok: false,
        at: new Date().toISOString(),
        smoke,
        sourceCommit,
        sourceHashes,
        fixture,
        samples,
        wallMs: performance.now() - startedAt,
        peakScratchBytes,
        error: error instanceof Error ? error.message : "Unknown proof failure",
        childErrors,
      };
    } finally {
      clearTimeout(deadline);

      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null) continue;

        const exited = new Promise<void>((resolve) =>
          child.once("exit", () => resolve()),
        );

        child.kill("SIGTERM");
        await exited;
      }

      children.clear();

      await rm(scratch, { recursive: true, force: true });

      const scratchAbsent = await access(scratch).then(
        () => false,
        () => true,
      );

      await writeFile(
        `${proofRoot}/${prefix}-storage.json`,
        JSON.stringify(
          {
            scratchPath: scratch,
            scratchAbsent,
            ownChildCount: children.size,
            ownChildrenExited: true,
            peakScratchBytes,
            removed:
              "exact own fixture,DB WAL/SHM and per-process data dirs;test helper cleanup owns its generated machine-auth temp directory",
            retained: `${prefix}-result.json plus checked-in recipe/harness hashes`,
          },
          null,
          2,
        ) + "\n",
      );
    }
  })();

  await writeFile(
    `${proofRoot}/${prefix}-result.json`,
    JSON.stringify(result, null, 2) + "\n",
  );
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      smoke,
      result: `${proofRoot}/${prefix}-result.json`,
      wallMs: result.wallMs,
    }) + "\n",
  );

  if (failed) process.exitCode = 1;
}

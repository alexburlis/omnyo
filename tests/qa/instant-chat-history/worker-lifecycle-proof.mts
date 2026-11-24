import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { z } from "zod";
import type { BuildThreadTimelineOptions } from "../../../apps/server/src/services/threads/timeline.ts";

type Bridge = Pick<
  typeof import("../../../packages/db/src/index.ts"),
  "createConnection" | "createThread" | "insertEvents" | "noopNotifier"
> &
  Pick<typeof import("../../../packages/domain/src/index.ts"), "threadScope"> &
  Pick<
    typeof import("../../../apps/server/src/services/threads/timeline-page-builder.ts"),
    "buildThreadTimelinePage" | "closeThreadTimelinePageBuilders"
  > &
  Pick<typeof import("./fixture.mts"), "createHistoryFixture">;

const sha = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function bytesUnder(path: string): Promise<number> {
  let bytes = 0;

  for (const entry of await readdir(path, { withFileTypes: true }))
    if (entry.isDirectory()) bytes += await bytesUnder(`${path}/${entry.name}`);
    else if (entry.isFile())
      bytes += (await stat(`${path}/${entry.name}`)).size;

  return bytes;
}

async function observe<T>(promise: Promise<T>) {
  try {
    return { ok: true as const, value: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}

async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`Lifecycle operation exceeded ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(result: Awaited<ReturnType<typeof observe>>) {
  assert.equal(result.ok, false);

  if (result.ok) throw new Error("Expected unavailable");
  z.object({
    status: z.literal(503),
    body: z
      .object({
        code: z.literal("timeline_unavailable"),
        message: z.literal("Chat could not load. Try again."),
        retryable: z.literal(true),
      })
      .strict(),
  }).parse(result.error);
}

async function child(scratch: string) {
  assert.deepEqual(process.execArgv, []);
  assert.deepEqual(
    Object.keys(process.env).filter(
      (name) =>
        process.platform !== "darwin" || name !== "__CF_USER_TEXT_ENCODING",
    ),
    [],
  );

  const bridge: Bridge = await import(
    pathToFileURL(`${scratch}/bridge.js`).href
  );

  const workers: Array<{
    threadId: number;
    createdAt: number;
    exitedAt: number | null;
  }> = [];

  const onWorker = (worker: Worker) => {
    const record: (typeof workers)[number] = {
      threadId: worker.threadId,
      createdAt: Date.now(),
      exitedAt: null,
    };

    workers.push(record);
    worker.once("exit", () => {
      record.exitedAt = Date.now();
    });
  };

  process.on("worker", onWorker);
  const fixture = bridge.createHistoryFixture(`${scratch}/history.db`);
  assert.ok((await bytesUnder(scratch)) < 576 * 1024 * 1024);
  const db = bridge.createConnection(`${scratch}/history.db`);

  const small = bridge.createThread(db, bridge.noopNotifier, {
    projectId: fixture.projectId,
    environmentId: fixture.environmentId,
    providerId: "codex",
    status: "idle",
    title: "Inert lifecycle small thread",
  });

  bridge.insertEvents(
    db,
    bridge.noopNotifier,
    Array.from({ length: 20 }, (_, index) => ({
      threadId: small.id,
      sequence: index + 1,
      scope: bridge.threadScope(),
      itemId: null,
      itemKind: null,
      parentToolCallId: null,
      type: "system/manager/user_message",
      data: JSON.stringify({ text: `Inert small lifecycle message ${index}` }),
    })),
  );

  const giant = fixture.histories.find(
    (history) => history.kind === "completed",
  )!;

  const options: BuildThreadTimelineOptions = {
    completedTurnDisplay: "collapse",
    deferContent: false,
    eventBudget: 1500,
    includeClearedContextHistory: false,
    includeDiagnosticOperations: false,
    includeNestedRows: true,
    maxInlineOutputChars: 128,
    page: { kind: "latest", segmentLimit: 20 },
  };

  const build = (
    threadId: string,
    priority: "foreground" | "background",
    key: string,
    signal?: AbortSignal,
  ) =>
    bridge.buildThreadTimelinePage(db, {
      threadId,
      priority,
      signal,
      options: { ...options, providerDisplayName: key },
    });

  const close = () => bridge.closeThreadTimelinePageBuilders(db);
  let report;

  try {
    let backgroundSettled = false;
    const backgroundController = new AbortController();

    const background = observe(
      build(
        giant.threadId,
        "background",
        "promotion-blocker",
        backgroundController.signal,
      ).finally(() => {
        backgroundSettled = true;
      }),
    );

    const cancel = new AbortController();

    const queued = observe(
      build(small.id, "background", "promoted", cancel.signal),
    );

    const started = performance.now();
    const promoted = build(small.id, "foreground", "promoted");
    cancel.abort();
    const canceled = await queued;
    assert.ok(
      !canceled.ok &&
        canceled.error instanceof Error &&
        canceled.error.name === "AbortError",
    );
    const foreground = await bounded(promoted, 1500);
    const promotionMs = performance.now() - started;
    assert.ok(promotionMs <= 500);
    assert.equal(backgroundSettled, false);
    assert.ok(foreground.workerThreadId !== null);
    assert.equal(foreground.response.rows.length, 20);
    assert.equal(workers.length, 2);
    backgroundController.abort();
    const backgroundCanceled = await background;
    assert.ok(
      !backgroundCanceled.ok &&
        backgroundCanceled.error instanceof Error &&
        backgroundCanceled.error.name === "AbortError",
    );
    await close();

    const occupied = [
      observe(build(giant.threadId, "foreground", "full-fg")),
      observe(build(giant.threadId, "background", "full-bg")),
    ];

    const queuedJobs = Array.from({ length: 32 }, (_, index) =>
      observe(build(small.id, "foreground", `queue-${index}`)),
    );

    const queuedBackground = observe(
      build(small.id, "background", "cannot-promote"),
    );

    queuedJobs.push(
      ...Array.from({ length: 31 }, (_, index) =>
        observe(build(small.id, "background", `background-queue-${index}`)),
      ),
    );
    unavailable(await observe(build(small.id, "foreground", "overflow")));
    unavailable(
      await observe(build(small.id, "background", "background-overflow")),
    );
    unavailable(await observe(build(small.id, "foreground", "cannot-promote")));
    await close();

    const closed = await Promise.all([
      ...occupied,
      ...queuedJobs,
      queuedBackground,
    ]);

    closed.forEach(unavailable);

    const firstIdle = await build(small.id, "foreground", "idle");

    const idleWorker = workers.find(
      (worker) => worker.threadId === firstIdle.workerThreadId,
    )!;

    process.stdout.write(
      JSON.stringify({ phase: "idle-disposal-window", milliseconds: 31000 }) +
        "\n",
    );
    await delay(31_000);
    assert.ok(idleWorker.exitedAt !== null);
    const afterIdle = await build(small.id, "foreground", "idle");
    assert.notEqual(afterIdle.workerThreadId, firstIdle.workerThreadId);
    await close();

    await rename(
      `${scratch}/timeline-worker.js`,
      `${scratch}/timeline-worker.disabled`,
    );
    const beforeFault = workers.length;
    const faultStarted = performance.now();
    let faultMs;
    let faultWorkerStarts = 0;

    try {
      unavailable(
        await bounded(
          observe(build(small.id, "foreground", "boot-fault")),
          3000,
        ),
      );
      faultMs = performance.now() - faultStarted;
      assert.ok(faultMs <= 3000);
      await delay(250);
      faultWorkerStarts = workers.length - beforeFault;
      assert.equal(faultWorkerStarts, 1);
      assert.ok(workers.at(-1)!.exitedAt !== null);
    } finally {
      await rename(
        `${scratch}/timeline-worker.disabled`,
        `${scratch}/timeline-worker.js`,
      );
    }

    const recovered = await build(small.id, "foreground", "explicit-recovery");
    assert.ok(recovered.workerThreadId !== null);

    const shutdown = [
      observe(build(giant.threadId, "foreground", "shutdown-fg")),
      observe(build(giant.threadId, "background", "shutdown-bg")),
      observe(build(small.id, "foreground", "shutdown-queued")),
    ];

    await close();
    (await Promise.all(shutdown)).forEach(unavailable);
    assert.ok(workers.every((worker) => worker.exitedAt !== null));
    report = {
      ok: true,
      fixture,
      promotionMs,
      foregroundWorker: foreground.workerThreadId,
      queueRejected: 3,
      shutdownSettledJobs: closed.length + shutdown.length,
      idle: {
        first: firstIdle.workerThreadId,
        next: afterIdle.workerThreadId,
        exitedAt: idleWorker.exitedAt,
      },
      faultMs,
      faultWorkerStarts,
      retryObservationMs: 250,
      recoveredWorker: recovered.workerThreadId,
      workers,
      execArgv: process.execArgv,
      environmentNames: Object.keys(process.env),
    };
  } finally {
    await close();
    db.$client.close();
    assert.equal(db.$client.open, false);
    process.off("worker", onWorker);
  }

  await writeFile(
    `${scratch}/child-result.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}

async function producer() {
  const repository = fileURLToPath(
    new URL("../../../", import.meta.url),
  ).replace(/\/$/, "");

  const root = `${repository}/.tmp/instant-chat-history-20261018`;

  const prefix = z
    .string()
    .regex(/^worker-lifecycle-[a-z0-9-]+$/)
    .parse(
      process.argv.find((arg) => arg.startsWith("--output-prefix="))?.slice(16),
    );

  await assert.rejects(access(`${root}/${prefix}-result.json`));
  const filesystem = await statfs(root);
  const availableBytes = filesystem.bavail * filesystem.bsize;
  assert.ok(availableBytes > 1024 * 1024 * 1024);
  const scratch = await mkdtemp(`${root}/${prefix}-scratch-`);
  await writeFile(
    `${root}/${prefix}-admission.json`,
    JSON.stringify(
      {
        owner: "/root/instant_chat_astra_review",
        scratch,
        availableBytes,
        fixtureCeilingBytes: 512 * 1024 * 1024,
        buildCeilingBytes: 64 * 1024 * 1024,
        expectedSeconds: 45,
        deadlineSeconds: 90,
        retained: ["source/native hashes", "numeric result", "command log"],
        disposable: ["compiled bridge/worker", "inert fixture"],
        cleanup:
          "Producer waits for own child, then removes only its exact scratch",
      },
      null,
      2,
    ) + "\n",
  );

  const paths = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
    cwd: repository,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(
      (path) =>
        /^apps\/server\/src\//.test(path) ||
        /^packages\/[^/]+\/src\//.test(path) ||
        /^packages\/db\/drizzle\/(?:.*\.sql|meta\/_journal.json)$/.test(path) ||
        [
          "tests/qa/instant-chat-history/fixture.mts",
          "tests/qa/instant-chat-history/worker-lifecycle-proof.mts",
          "scripts/build-utils.mjs",
          "pnpm-lock.yaml",
          "packages/omnyo-app/package.json",
        ].includes(path),
    );

  const sourceBefore = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        sha(await readFile(`${repository}/${path}`)),
      ]),
    ),
  );

  let failure: string | undefined;
  let childPid: number | undefined;
  let exitCode: number | null = null;
  let peakBytes = 0;
  let inputHashes: Record<string, string> = {};
  let nativeHash = "";
  let outputHashes: Record<string, string> = {};
  let result: z.infer<typeof childResultSchema> | null = null;
  const began = performance.now();

  try {
    await mkdir(`${scratch}/node_modules`);

    const require = createRequire(
      `${repository}/packages/omnyo-app/package.json`,
    );

    const native = dirname(require.resolve("better-sqlite3/package.json"));
    z.object({ version: z.literal("13.0.3") }).parse(
      require("better-sqlite3/package.json"),
    );
    nativeHash = sha(
      await readFile(
        `${native}/prebuilds/${process.platform}-${process.arch}.node`,
      ),
    );
    assert.equal(
      nativeHash,
      "98e0e8acd01c632fe5615243e1296af0372826f8783b18fc31c506f73c47459c",
    );
    await symlink(native, `${scratch}/node_modules/better-sqlite3`);
    await symlink(`${repository}/packages/db/drizzle`, `${scratch}/drizzle`);
    await writeFile(
      `${scratch}/bridge.mts`,
      `export { createConnection, createThread, insertEvents, noopNotifier } from ${JSON.stringify(`${repository}/packages/db/src/index.ts`)};\nexport { threadScope } from ${JSON.stringify(`${repository}/packages/domain/src/index.ts`)};\nexport { buildThreadTimelinePage, closeThreadTimelinePageBuilders } from ${JSON.stringify(`${repository}/apps/server/src/services/threads/timeline-page-builder.ts`)};\nexport { createHistoryFixture } from ${JSON.stringify(`${repository}/tests/qa/instant-chat-history/fixture.mts`)};\n`,
    );

    const { buildNodeEsmEntry } =
      await import("../../../scripts/build-utils.mjs");

    const outputs = [
      [`${scratch}/bridge.mts`, "bridge.js"],
      [
        `${repository}/apps/server/src/services/threads/timeline-worker.ts`,
        "timeline-worker.js",
      ],
      [fileURLToPath(import.meta.url), "probe.js"],
    ];

    const used = new Set(
      paths.filter((path) => path.startsWith("packages/db/drizzle/")),
    );

    for (const [entryPoint, name] of outputs) {
      await buildNodeEsmEntry({
        cleanDist: false,
        entryPoint,
        outfile: `${scratch}/${name}`,
        packageRoot: repository,
      });

      const map = z
        .object({ sources: z.array(z.string()) })
        .parse(JSON.parse(await readFile(`${scratch}/${name}.map`, "utf8")));

      for (const source of map.sources) {
        const path = relative(repository, resolve(scratch, source));

        if (
          !path.startsWith("..") &&
          !path.includes("node_modules/") &&
          !path.startsWith(".tmp/")
        )
          used.add(path);
      }
    }

    const hashes = async () =>
      Object.fromEntries(
        await Promise.all(
          [...used].map(async (path) => [
            path,
            sha(await readFile(`${repository}/${path}`)),
          ]),
        ),
      );

    inputHashes = await hashes();

    for (const [path, hash] of Object.entries(inputHashes))
      assert.equal(
        hash,
        sourceBefore[path],
        `Source changed during compile: ${path}`,
      );
    outputHashes = Object.fromEntries(
      await Promise.all(
        outputs.map(async ([, name]) => [
          name!,
          sha(await readFile(`${scratch}/${name}`)),
        ]),
      ),
    );
    peakBytes = await bytesUnder(scratch);
    assert.ok(peakBytes < 64 * 1024 * 1024);
    const log = await open(`${root}/${prefix}.log`, "wx");

    try {
      const run = spawn(
        process.execPath,
        [`${scratch}/probe.js`, `--child=${scratch}`],
        {
          cwd: repository,
          env: {},
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        },
      );

      childPid = run.pid;
      let killer: ReturnType<typeof setTimeout> | undefined;

      const timer = setTimeout(() => {
        if (run.pid) process.kill(-run.pid, "SIGTERM");
        killer = setTimeout(() => {
          if (run.exitCode === null && run.pid)
            process.kill(-run.pid, "SIGKILL");
        }, 3000);
      }, 90_000);

      try {
        [exitCode] = await once(run, "exit");
      } finally {
        clearTimeout(timer);
        clearTimeout(killer);
      }

      assert.equal(exitCode, 0);
      result = childResultSchema.parse(
        JSON.parse(await readFile(`${scratch}/child-result.json`, "utf8")),
      );
      assert.deepEqual(await hashes(), inputHashes);
      assert.equal(
        sha(await readFile(`${scratch}/timeline-worker.js`)),
        outputHashes["timeline-worker.js"],
      );
    } finally {
      await log.close();
    }
  } catch (error) {
    failure =
      error instanceof Error
        ? error.message
        : "Compiled lifecycle proof failed";
    process.exitCode = 1;
  } finally {
    peakBytes = Math.max(peakBytes, await bytesUnder(scratch));

    if (peakBytes >= 576 * 1024 * 1024) {
      failure ??= "Scratch budget exceeded";
      process.exitCode = 1;
    }

    await rm(scratch, { recursive: true });

    const scratchAbsent = await access(scratch).then(
      () => false,
      () => true,
    );

    await writeFile(
      `${root}/${prefix}-result.json`,
      JSON.stringify(
        {
          ok: failure === undefined,
          failure,
          childPid,
          exitCode,
          peakBytes,
          scratch,
          scratchAbsent,
          wallMs: performance.now() - began,
          nativeHash,
          inputHashes,
          outputHashes,
          result,
          surface:
            "Plain Node compiled pool and worker, actual better-sqlite3 13.0.3, inert file-backed recipe1; no HTTP/provider/device/release claim",
        },
        null,
        2,
      ) + "\n",
    );
  }
}

const childResultSchema = z.object({ ok: z.literal(true) }).passthrough();

const childPath = process.argv
  .find((arg) => arg.startsWith("--child="))
  ?.slice(8);

if (childPath) await child(childPath);
else await producer();

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { listEvents } from "../../../packages/db/src/index.js";
import { acceptThreadSendRequest } from "../../../apps/server/src/services/threads/thread-send-request.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../../apps/server/test/helpers/commands.js";
import { textInput } from "../../../apps/server/test/helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../../../apps/server/test/helpers/seed.js";
import { createTestAppHarness } from "../../../apps/server/test/helpers/test-app.js";

const [resultPath] = process.argv.slice(2);

assert.ok(resultPath, "Usage: send.mts result.json");

const sourcePaths = [
  "apps/server/src/services/threads/thread-send-request.ts",
  "apps/server/src/services/threads/thread-send.ts",
  "apps/server/src/services/threads/dispatch-attempt.ts",
  "apps/server/src/services/threads/thread-runtime-config.ts",
  "tests/qa/latency-simplification/send.mts",
];

const sourceHashes = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [
      path,
      createHash("sha256")
        .update(await readFile(resolve(path)))
        .digest("hex"),
    ]),
  ),
);

const report = {
  at: new Date().toISOString(),
  surface:
    "Migrated in-memory SQLite and real server acceptance; inert test daemon",
  measurement:
    "Service call to accepted acknowledgement; setup and daemon settlement excluded",
  exclusions:
    "HTTP transport, browser draft presentation, network latency and provider generation are not measured",
  sourceHashes,
  trials: [] as {
    trial: number;
    acknowledgementMs: number;
    persistedRequests: number;
    queuedTurnSubmits: number;
  }[],
  failures: [] as { trial: number; message: string }[],
  cleanup: { dataDirectoryAbsent: false, databaseClosed: false },
};

const harness = await createTestAppHarness();

try {
  for (let trial = 0; trial < 5; trial += 1) {
    const { host, session } = seedHostSession(harness.deps, {
      id: `send-latency-${trial}`,
    });

    const { project } = seedProjectWithSource(harness.deps, {
      hostId: host.id,
      path: resolve(harness.config.dataDir, `workspace-${trial}`),
    });

    const environment = seedEnvironment(harness.deps, {
      hostId: host.id,
      projectId: project.id,
      path: resolve(harness.config.dataDir, `workspace-${trial}`),
      status: "ready",
    });

    const thread = seedThread(harness.deps, {
      projectId: project.id,
      environmentId: environment.id,
      status: "idle",
    });

    seedThreadRuntimeState(harness.deps, {
      environmentId: environment.id,
      providerThreadId: `inert-provider-${trial}`,
      threadId: thread.id,
    });

    const input = textInput(`Synthetic acceptance measurement ${trial}`);

    const before = listEvents(harness.db, { threadId: thread.id }).filter(
      (event) => event.type === "client/turn/requested",
    ).length;

    try {
      const started = performance.now();

      const response = await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: {
          input,
          mode: "auto",
          model: "gpt-5",
          permissionMode: "full",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      });

      const acknowledgementMs = performance.now() - started;

      assert.deepEqual(response, { ok: true, delivery: "sent" });

      const requests = listEvents(harness.db, { threadId: thread.id }).filter(
        (event) => event.type === "client/turn/requested",
      );

      assert.equal(requests.length - before, 1);
      assert.deepEqual(
        JSON.parse(requests.at(-1)?.data ?? "null").input,
        input,
      );

      const queued = await waitForQueuedCommand(
        harness,
        (entry) =>
          entry.command.type === "turn.submit" &&
          entry.command.threadId === thread.id,
      );

      assert.equal(queued.command.type, "turn.submit");

      const commands = listQueuedThreadCommands(
        harness,
        "turn.submit",
        thread.id,
      );

      assert.equal(commands.length, 1);
      assert.deepEqual(commands[0]?.input, input);
      report.trials.push({
        trial,
        acknowledgementMs,
        persistedRequests: requests.length - before,
        queuedTurnSubmits: commands.length,
      });
      await reportQueuedCommandSuccess(harness, queued, {
        trace: { spans: [] },
      });
    } catch (error) {
      report.failures.push({
        trial,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      harness.hub.unregisterDaemon(session.id);
    }
  }
} finally {
  await harness.cleanup();
  harness.db.$client.close();
  report.cleanup.databaseClosed = true;
  report.cleanup.dataDirectoryAbsent = await access(
    harness.config.dataDir,
  ).then(
    () => false,
    () => true,
  );
  await mkdir(dirname(resolve(resultPath)), { recursive: true });
  await writeFile(resolve(resultPath), JSON.stringify(report, null, 2));
}

const timings = report.trials
  .map((trial) => trial.acknowledgementMs)
  .sort((a, b) => a - b);

console.log(
  JSON.stringify({
    trials: report.trials.length,
    failures: report.failures.length,
    acknowledgementMs: {
      median: timings[2],
      min: timings[0],
      max: timings.at(-1),
    },
    cleanup: report.cleanup,
  }),
);

assert.equal(report.failures.length, 0);

assert.equal(report.trials.length, 5);

assert.ok(report.cleanup.dataDirectoryAbsent);

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createConnection,
  createProject,
  createThread,
  getAppSettings,
  insertEvents,
  migrate,
  noopNotifier,
  setAppSettings,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { parseStoredThreadEvent, threadScope, turnScope } from "@omnyo/domain";
import {
  benchmarkPaths,
  benchmarkStorage,
  currentSourceHashes,
  fileHash,
  repositoryRoot,
  preparedHistorySchema,
  sourceCommit,
  validatePreparedOwnership,
  type HistoryFixture,
  type PreparedHistory,
} from "./history-stalls-fixture.js";

type BenchmarkEventInput = Parameters<typeof insertEvents>[2][number];

const paths = benchmarkPaths();

const storage = benchmarkStorage();

if (process.argv.includes("--cleanup")) {
  const prepared = preparedHistorySchema.parse(
    JSON.parse(readFileSync(paths.manifest, "utf8")),
  );

  validatePreparedOwnership(prepared);

  const closeout = z
    .object({
      owner: z.literal("coordinator-history-stalls-benchmark"),
      directory: z.string(),
      state: z.literal("measurement-failed-retained"),
      consumersClosed: z.literal(true),
    })
    .parse(JSON.parse(readFileSync(paths.receipt, "utf8")));

  if (closeout.directory !== prepared.directory)
    throw new Error("Retained fixture receipt does not match its manifest");

  let consumers: string;

  try {
    consumers = execFileSync("lsof", ["-t", "+D", prepared.directory], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("status" in error) ||
      error.status !== 1
    )
      throw new Error("Could not verify retained fixture consumers");
    consumers = "";
  }

  if (consumers.length > 0)
    throw new Error("Retained history fixture still has live consumers");
  rmSync(prepared.directory, { recursive: true });
  writeFileSync(
    paths.receipt,
    JSON.stringify(
      {
        ...closeout,
        state: "measurement-failed-cleaned",
        removed: [prepared.directory],
        absent: !existsSync(prepared.directory),
        retained: [paths.manifest, paths.result, paths.receipt],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({
      removed: prepared.directory,
      absent: !existsSync(prepared.directory),
    }) + "\n",
  );
  process.exit(0);
}

if (existsSync(paths.manifest)) {
  const previous: unknown = JSON.parse(readFileSync(paths.manifest, "utf8"));

  if (
    typeof previous === "object" &&
    previous !== null &&
    "directory" in previous &&
    typeof previous.directory === "string" &&
    existsSync(previous.directory)
  )
    throw new Error(
      "An existing prepared history fixture still owns its inputs",
    );
}

const workers = [
  resolve(repositoryRoot, "apps/server/dist/timeline-worker.js"),
  resolve(repositoryRoot, "packages/omnyo-app/server/dist/timeline-worker.js"),
].map((path) => ({ path, hash: fileHash(path) }));

const filesystem = statfsSync(storage);

const freeBytes = filesystem.bavail * filesystem.bsize;

if (freeBytes < 1_073_741_824)
  throw new Error("History fixture preparation requires 1 GiB of free storage");

const directory = mkdtempSync(resolve(storage, "history-stalls-fixture-"));

chmodSync(directory, 0o700);

const databasePath = resolve(directory, "history.db");

const receipt = {
  owner: "coordinator-history-stalls-benchmark",
  directory,
  databasePath,
  purpose: "Prepared inert SQLite inputs for one bounded history measurement",
  restoreInputs: "history-stalls-prepare.ts and bound source hashes",
  expectedMaximumBytes: 1_073_741_824,
  freeBytesBefore: freeBytes,
  state: "preparing",
};

writeFileSync(paths.receipt, JSON.stringify(receipt, null, 2) + "\n", {
  mode: 0o600,
});

let db: DbConnection | null = null;

try {
  db = createConnection(databasePath);
  migrate(db);
  setAppSettings(db, {
    ...getAppSettings(db),
    providerCompletedTurnDisplay: { codex: "flat" },
  });

  const host = upsertHost(db, noopNotifier, {
    name: "Inert history benchmark",
  });

  const { project } = createProject(db, noopNotifier, {
    name: "Inert history benchmark",
    source: {
      type: "local_path",
      hostId: host.id,
      path: "/inert/history-benchmark",
    },
  });

  const seed = (
    turns: number,
    tasks = 1,
    progressPerTask = 2,
  ): HistoryFixture => {
    if (db === null)
      throw new Error("History preparation connection is closed");
    const connection = db;

    const thread = createThread(connection, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
      status: "active",
    });

    let sequence = 0;
    let pending: BenchmarkEventInput[] = [];

    const add = (
      type: BenchmarkEventInput["type"],
      turnId: string | null,
      data: Record<string, unknown>,
      itemId: string | null = null,
      itemKind: BenchmarkEventInput["itemKind"] = null,
    ) => {
      const scope = turnId === null ? threadScope() : turnScope(turnId);
      parseStoredThreadEvent({
        threadId: thread.id,
        type,
        scope,
        providerThreadId: "inert-benchmark-provider",
        data,
      });
      pending.push({
        createdAt: 1_800_000_000_000 + sequence,
        data: JSON.stringify(data),
        itemId,
        itemKind,
        parentToolCallId: null,
        providerThreadId: "inert-benchmark-provider",
        scope,
        sequence: ++sequence,
        threadId: thread.id,
        type,
      });

      if (pending.length === 500) {
        insertEvents(connection, noopNotifier, pending);
        pending = [];
      }
    };

    for (let index = 0; index < turns; index++) {
      const turnId = `turn-${index}`;
      add("system/manager/user_message", null, { text: `Question ${index}` });
      add("turn/started", turnId, {});

      if (index === 0)
        for (let task = 0; task < tasks; task++)
          add(
            "item/started",
            turnId,
            {
              item: {
                type: "backgroundTask",
                id: `task-${task}`,
                familyId: `family-${task}`,
                taskType: "local_bash",
                description: "Inert background operation",
                skipTranscript: false,
                status: "pending",
                taskStatus: "running",
              },
            },
            `task-${task}`,
            "backgroundTask",
          );

      add(
        "item/completed",
        turnId,
        {
          item: {
            type: "agentMessage",
            id: `answer-${index}`,
            text: `Answer ${index}`,
          },
        },
        `answer-${index}`,
        "agentMessage",
      );
      add("turn/completed", turnId, { status: "completed" });
    }

    for (let task = 0; task < tasks; task++) {
      const item = {
        type: "backgroundTask",
        id: `task-${task}`,
        familyId: `family-${task}`,
        taskType: "local_bash",
        description: "Inert background operation",
        skipTranscript: false,
      };

      for (let progress = 0; progress < progressPerTask; progress++)
        add(
          "item/backgroundTask/progress",
          null,
          {
            item: {
              ...item,
              status: "pending",
              taskStatus: "running",
              summary: "x".repeat(512),
            },
          },
          item.id,
          "backgroundTask",
        );

      if (task < tasks - 1)
        add(
          "item/backgroundTask/completed",
          null,
          {
            item: { ...item, status: "completed", taskStatus: "completed" },
          },
          item.id,
          "backgroundTask",
        );
    }

    add("turn/started", "live", {});

    if (pending.length > 0) insertEvents(connection, noopNotifier, pending);

    return {
      threadId: thread.id,
      turns,
      tasks,
      progressPerTask,
      events: sequence,
    };
  };

  const warm = [50, 200, 800].map((turns) => seed(turns));
  const cold = Array.from({ length: 5 }, () => seed(800));
  const overlap = seed(800, 131, 350);
  const progress = [seed(800, 131, 35), seed(800, 131, 350)];
  db.$client.pragma("wal_checkpoint(TRUNCATE)");
  db.$client.close();
  db = null;
  const databaseBytes = statSync(databasePath).size;

  if (databaseBytes > receipt.expectedMaximumBytes)
    throw new Error(
      "Prepared history fixture exceeded its 1 GiB allocation bound",
    );

  const prepared: PreparedHistory = {
    schema: 1,
    preparedAt: new Date().toISOString(),
    owner: receipt.owner,
    directory,
    databasePath,
    databaseHash: fileHash(databasePath),
    databaseBytes,
    allocatedBytes: statSync(databasePath).blocks * 512,
    sourceCommit: sourceCommit(),
    sourceHashes: currentSourceHashes(),
    compiledWorkers: workers,
    warm,
    cold,
    overlap,
    progress,
  };

  writeFileSync(paths.manifest, JSON.stringify(prepared, null, 2) + "\n", {
    mode: 0o600,
  });
  writeFileSync(
    paths.receipt,
    JSON.stringify(
      {
        ...receipt,
        state: "prepared",
        databaseBytes,
        allocatedBytes: statSync(databasePath).blocks * 512,
        machine: {
          platform: platform(),
          release: release(),
          cpu: cpus()[0]?.model ?? "unknown",
        },
        retained: [paths.manifest, paths.receipt],
        removed: [],
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(
    JSON.stringify({ manifest: paths.manifest, databaseBytes, fixtures: 11 }) +
      "\n",
  );
} catch (error) {
  db?.$client.close();
  rmSync(directory, { recursive: true });
  writeFileSync(
    paths.receipt,
    JSON.stringify(
      {
        ...receipt,
        state: "preparation-failed-cleaned",
        removed: [directory],
        absent: !existsSync(directory),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  throw error;
}

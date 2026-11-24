import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const repositoryRoot = resolve(import.meta.dirname, "../../../..");

export const benchmarkSourcePaths = [
  "apps/server/src/routes/threads/data.ts",
  "apps/server/src/routes/threads/base.ts",
  "apps/server/src/services/projects/project-deletion.ts",
  "apps/server/src/services/system/periodic-sweeps.ts",
  "apps/server/src/services/system/thread-pruning-sweep.ts",
  "apps/server/src/services/threads/timeline-worker-contract.ts",
  "apps/server/src/services/threads/timeline-root-cache.ts",
  "apps/server/src/services/threads/timeline-cache.ts",
  "apps/server/src/services/threads/thread-history-redaction.ts",
  "apps/server/src/services/threads/timeline-output-truncation.ts",
  "apps/server/src/services/threads/timeline-output-preview.ts",
  "packages/db/src/schema.ts",
  "packages/db/src/data/timeline-history-epoch.ts",
  "packages/db/src/index.ts",
  "packages/db/src/data/index.ts",
  "packages/process-utils/src/event-loop-delay.ts",
  "apps/server/vitest.config.ts",
  "apps/server/test/setup/warm-test-harness.ts",
  "apps/server/test/helpers/test-app.ts",
  "apps/server/test/performance/history-stalls.bench.test.ts",
  "apps/server/test/performance/history-stalls-fixture.ts",
  "apps/server/test/performance/history-stalls-prepare.ts",
  "apps/server/test/performance/history-stalls-peer.mjs",
  "apps/server/src/services/threads/timeline.ts",
  "apps/server/src/services/threads/timeline-worker.ts",
  "apps/server/src/services/threads/timeline-page-builder.ts",
  "apps/server/src/services/threads/history-cache-writer.ts",
  "apps/server/src/services/threads/history-cache-access.ts",
  "apps/server/src/services/threads/conversation-outline-cache.ts",
  "packages/db/src/data/events.ts",
  "packages/db/src/history-cache.ts",
  "packages/db/drizzle/0147_lucky_madelyne_pryor.sql",
];

const fixtureSchema = z.object({
  threadId: z.string(),
  turns: z.number().int().positive(),
  tasks: z.number().int().nonnegative(),
  progressPerTask: z.number().int().nonnegative(),
  events: z.number().int().positive(),
});

export const preparedHistorySchema = z.object({
  schema: z.literal(1),
  preparedAt: z.string(),
  owner: z.string(),
  directory: z.string(),
  databasePath: z.string(),
  databaseHash: z.string(),
  databaseBytes: z.number(),
  allocatedBytes: z.number(),
  sourceCommit: z.string(),
  sourceHashes: z.record(z.string(), z.string()),
  compiledWorkers: z
    .array(z.object({ path: z.string(), hash: z.string() }))
    .length(2),
  warm: z.array(fixtureSchema).length(3),
  cold: z.array(fixtureSchema).length(5),
  overlap: fixtureSchema,
  progress: z.array(fixtureSchema).length(2),
});

export type PreparedHistory = z.infer<typeof preparedHistorySchema>;

export type HistoryFixture = z.infer<typeof fixtureSchema>;

export function benchmarkStorage(): string {
  const path = process.env.OMNYO_THREAD_STORAGE;

  if (path === undefined || !isAbsolute(path))
    throw new Error(
      "OMNYO_THREAD_STORAGE must identify this benchmark's existing owner storage",
    );

  return resolve(path);
}

export function benchmarkPaths() {
  const storage = benchmarkStorage();

  return {
    manifest: resolve(storage, "history-stalls-prepared.json"),
    receipt: resolve(storage, "history-stalls-storage.json"),
    result: resolve(storage, "history-stalls-result.json"),
  };
}

export function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sdkRuntimePaths(): string[] {
  const paths: string[] = [];

  const inspect = (path: string) => {
    const absolute = resolve(repositoryRoot, path);
    const metadata = lstatSync(absolute);

    if (metadata.isSymbolicLink() || realpathSync(absolute) !== absolute)
      throw new Error(`SDK binding refuses a symbolic path: ${path}`);

    if (!metadata.isDirectory() && !metadata.isFile())
      throw new Error(
        `SDK binding requires a regular file or directory: ${path}`,
      );

    return metadata;
  };

  const visit = (directory: string, runtime: boolean) => {
    if (!inspect(directory).isDirectory())
      throw new Error(`SDK binding requires a directory: ${directory}`);

    for (const name of readdirSync(resolve(repositoryRoot, directory)).sort()) {
      const path = [directory, name].join("/");
      const metadata = inspect(path);

      if (metadata.isDirectory()) {
        if (name !== "__tests__") visit(path, runtime);
      } else if (
        runtime
          ? /\.[cm]?js$/u.test(name)
          : /\.(?:[cm]?[jt]sx?|json)$/u.test(name) &&
            !/\.(?:test|spec|typecheck)\.[cm]?[jt]sx?$/u.test(name) &&
            !/\.d\.[cm]?ts$/u.test(name)
      ) {
        paths.push(
          relative(repositoryRoot, resolve(repositoryRoot, path))
            .split(sep)
            .join("/"),
        );
      }
    }
  };

  for (const root of ["packages/plugin-sdk", "packages/sdk"]) {
    const manifest = `${root}/package.json`;

    if (!inspect(manifest).isFile())
      throw new Error(`SDK binding requires a package manifest: ${manifest}`);
    paths.push(manifest);
    visit(`${root}/src`, false);
    visit(`${root}/dist`, true);
  }

  return paths;
}

export function currentSourceHashes(): Record<string, string> {
  const paths = [
    ...new Set([...benchmarkSourcePaths, ...sdkRuntimePaths()]),
  ].sort();

  return Object.fromEntries(
    paths.map((path) => [path, fileHash(resolve(repositoryRoot, path))]),
  );
}

export function sourceCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function validatePreparedOwnership(prepared: PreparedHistory): void {
  const storage = benchmarkStorage();
  const relativeDirectory = relative(storage, prepared.directory);

  if (
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    !relativeDirectory.startsWith("history-stalls-fixture-") ||
    dirname(prepared.databasePath) !== prepared.directory
  )
    throw new Error("Prepared history fixture is outside its owned storage");

  if (prepared.owner !== "coordinator-history-stalls-benchmark")
    throw new Error("Prepared history fixture has another owner");
}

export function verifyPreparedBindings(prepared: PreparedHistory): void {
  if (
    JSON.stringify(prepared.sourceHashes) !==
    JSON.stringify(currentSourceHashes())
  )
    throw new Error("History source changed after preparation");

  for (const worker of prepared.compiledWorkers)
    if (fileHash(worker.path) !== worker.hash)
      throw new Error("Compiled history worker changed after preparation");
}

export function readPreparedHistory(): PreparedHistory {
  const prepared = preparedHistorySchema.parse(
    JSON.parse(readFileSync(benchmarkPaths().manifest, "utf8")),
  );

  validatePreparedOwnership(prepared);
  verifyPreparedBindings(prepared);

  if (fileHash(prepared.databasePath) !== prepared.databaseHash)
    throw new Error("Prepared history database changed before measurement");

  return prepared;
}

export const peerPath = fileURLToPath(
  new URL("./history-stalls-peer.mjs", import.meta.url),
);

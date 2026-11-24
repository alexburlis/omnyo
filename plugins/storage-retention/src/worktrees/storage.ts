import { Worker } from "node:worker_threads";
import { isAbsolute, relative, resolve } from "node:path";

export type WorktreeStorage = {
  status: "measured" | "partial" | "unavailable";
  allocatedBytes: number | null;
  reclaimableBytes: number | null;
  measuredAt: string;
  error: string | null;
};

const cache = new Map<
  string,
  {
    folder: string;
    expires: number;
    measurement: Promise<WorktreeStorage>;
  }
>();

const waiters: (() => void)[] = [];

let active = 0;

const maxEntries = 100000;

const maxMilliseconds = 4000;

const cacheMilliseconds = 30000;

function within(parent: string, path: string) {
  const difference = relative(parent, path);

  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith("../") &&
      !difference.startsWith("..\\"))
  );
}

type ScanInput = {
  path: string;
  excluded: string[];
  deadline: number;
  maxEntries: number;
};

type ScanMessage = {
  complete: boolean;
  allocatedBytes: number;
  reclaimableBytes: number | null;
  error: string | null;
};

function scanAllocatedFolder(nativeRequire: NodeJS.Require) {
  const { parentPort, workerData } = nativeRequire(
    "node:worker_threads",
  ) as typeof import("node:worker_threads");

  const { lstatSync, opendirSync } = nativeRequire(
    "node:fs",
  ) as typeof import("node:fs");

  const { isAbsolute, join, relative } = nativeRequire(
    "node:path",
  ) as typeof import("node:path");

  const input: ScanInput = workerData;
  let allocatedBytes = 0;
  let entries = 0;
  let error: string | null = null;

  const files = new Map<
    string,
    {
      bytes: number;
      links: number;
      seen: number;
    }
  >();

  const directories = [input.path];
  let metadataBytes = 0;
  let lastProgress = 0;

  try {
    const root = lstatSync(input.path);

    if (!root.isDirectory())
      throw new Error("Working folder is missing or is a symbolic link");

    while (directories.length) {
      if (Date.now() > input.deadline)
        throw new Error("Storage scan exceeded its four-second budget");
      const directory = directories.pop()!;
      const directoryStat = lstatSync(directory);

      if (!directoryStat.isDirectory())
        throw new Error("Folder changed during storage scan");
      const directoryBytes = directoryStat.blocks * 512;

      if (!Number.isSafeInteger(directoryBytes))
        throw new Error("Filesystem allocation is unavailable");
      allocatedBytes += directoryBytes;
      metadataBytes += directoryBytes;
      const iterator = opendirSync(directory);

      try {
        for (
          let entry = iterator.readSync();
          entry;
          entry = iterator.readSync()
        ) {
          if (++entries > input.maxEntries)
            throw new Error("Storage scan exceeded 100,000 entries");

          if (Date.now() > input.deadline)
            throw new Error("Storage scan exceeded its four-second budget");
          const child = join(directory, entry.name);

          if (
            child === join(input.path, ".git") ||
            input.excluded.some((item) => {
              const difference = relative(item, child);

              return (
                difference === "" ||
                (!isAbsolute(difference) &&
                  difference !== ".." &&
                  !difference.startsWith("../") &&
                  !difference.startsWith("..\\"))
              );
            })
          )
            continue;
          const item = lstatSync(child);
          const bytes = item.blocks * 512;

          if (!Number.isSafeInteger(bytes))
            throw new Error("Filesystem allocation is unavailable");

          if (item.isDirectory()) directories.push(child);
          else {
            const key = `${item.dev}:${item.ino}`;
            const previous = files.get(key);

            if (previous) previous.seen++;
            else {
              allocatedBytes += bytes;
              files.set(key, { bytes, links: item.nlink, seen: 1 });
            }
          }

          if (Date.now() - lastProgress >= 100) {
            parentPort?.postMessage({
              complete: false,
              allocatedBytes,
              reclaimableBytes: null,
              error: null,
            });
            lastProgress = Date.now();
          }
        }
      } finally {
        iterator.closeSync();
      }
    }
  } catch (cause) {
    error =
      cause instanceof Error &&
      [
        "Working folder is missing or is a symbolic link",
        "Folder changed during storage scan",
        "Filesystem allocation is unavailable",
        "Storage scan exceeded its four-second budget",
        "Storage scan exceeded 100,000 entries",
      ].includes(cause.message)
        ? cause.message
        : "Working folder could not be completely read";
  }

  const reclaimableBytes = error
    ? null
    : metadataBytes +
      [...files.values()].reduce(
        (sum, file) => sum + (file.seen >= file.links ? file.bytes : 0),
        0,
      );

  parentPort?.postMessage({
    complete: true,
    allocatedBytes,
    reclaimableBytes,
    error,
  });
  parentPort?.close();
}

function resultFromScan(message: ScanMessage): WorktreeStorage {
  return {
    status: message.error
      ? message.allocatedBytes
        ? "partial"
        : "unavailable"
      : "measured",
    allocatedBytes: message.error
      ? message.allocatedBytes || null
      : message.allocatedBytes,
    reclaimableBytes: message.error ? null : message.reclaimableBytes,
    measuredAt: new Date().toISOString(),
    error: message.error,
  };
}

async function measure(
  path: string,
  excluded: string[],
  deadline: number,
): Promise<WorktreeStorage> {
  let worker: Worker | null = null;
  let exited: Promise<number> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  let latest: ScanMessage = {
    complete: false,
    allocatedBytes: 0,
    reclaimableBytes: null,
    error: null,
  };

  try {
    worker = new Worker(`(${scanAllocatedFolder.toString()})(require)`, {
      eval: true,
      workerData: { path, excluded, deadline, maxEntries } satisfies ScanInput,
      env: {},
      execArgv: [],
    });
    const scanner = worker;
    exited = new Promise<number>((resolve) => scanner.once("exit", resolve));

    const completed = await new Promise<ScanMessage>((resolve) => {
      scanner.on("message", (message: ScanMessage) => {
        latest = message;

        if (message.complete) resolve(message);
      });
      scanner.once("error", () =>
        resolve({ ...latest, error: "Storage reader failed" }),
      );
      scanner.once("exit", () =>
        resolve({
          ...latest,
          error: "Storage reader exited before completion",
        }),
      );
      timer = setTimeout(
        () =>
          resolve({
            ...latest,
            error: "Storage scan exceeded its four-second budget",
          }),
        Math.max(0, deadline - Date.now()),
      );
    });

    return resultFromScan(completed);
  } catch {
    return resultFromScan({
      ...latest,
      error: "Storage reader could not start",
    });
  } finally {
    if (timer) clearTimeout(timer);

    if (worker) await worker.terminate();

    if (exited) await exited;
  }
}

export function measureWorktreeStorage(path: string, exclusions: string[]) {
  const folder = resolve(path);

  const excluded = [...new Set(exclusions.map((item) => resolve(item)))]
    .filter((item) => item !== folder && within(folder, item))
    .sort();

  const key = JSON.stringify([folder, excluded]);
  const now = Date.now();
  const existing = cache.get(key);

  if (existing && existing.expires > now) return existing.measurement;

  if (cache.size >= 256) {
    for (const [key, value] of cache)
      if (value.expires <= now) cache.delete(key);

    if (cache.size >= 256) cache.delete(cache.keys().next().value!);
  }

  const deadline = now + maxMilliseconds;

  const measurement = (async () => {
    if (active >= 4) await new Promise<void>((resume) => waiters.push(resume));
    else active++;

    try {
      if (Date.now() > deadline)
        return {
          status: "unavailable" as const,
          allocatedBytes: null,
          reclaimableBytes: null,
          measuredAt: new Date().toISOString(),
          error: "Storage readers were busy; refresh to retry",
        };

      return await measure(folder, excluded, deadline);
    } finally {
      const next = waiters.shift();

      if (next) next();
      else active--;
    }
  })();

  cache.set(key, { folder, expires: now + cacheMilliseconds, measurement });

  return measurement;
}

export function invalidateWorktreeStorage(path: string) {
  const folder = resolve(path);

  for (const [key, value] of cache) {
    if (within(value.folder, folder) || within(folder, value.folder))
      cache.delete(key);
  }
}

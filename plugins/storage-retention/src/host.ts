import {
  isStorageEntryName,
  isRetentionTrashName,
  RETENTION_TRASH_PREFIX,
} from "./storage-identities.js";
import {
  experimental_defineHostEntry,
  experimental_killProcessesWithCwdUnder,
  type ExperimentalHostRpcContext,
} from "@omnyo/plugin-sdk/host";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  inspectDeveloperEntries,
  removeDeveloperEntries,
} from "./developer-storage.js";
import { randomUUID } from "node:crypto";
import { hostStorageContract } from "./host-contract.js";
import { measureDiskUsage } from "./disk-usage.js";
import { isFsErrorWithCode } from "./fs-errors.js";
import { removeTrashInBackground } from "./trash.js";
import { createManagedHost } from "./managed-host.js";
import { createHousekeepingHost } from "./housekeeping-host.js";
import { housekeepingHostSignals } from "./housekeeping-contract.js";
import worktreesHost from "./worktrees/host.js";
import { hostSignals as worktreesHostSignals } from "./worktrees/host-contract.js";

const managedHosts = new Map<string, ReturnType<typeof createManagedHost>>();

function managedHost(context: ExperimentalHostRpcContext) {
  const dataDir = context.experimental_paths.dataDir;
  let host = managedHosts.get(dataDir);

  if (!host) {
    host = createManagedHost({ dataDir });
    managedHosts.set(dataDir, host);
    context.lifecycle.signal.addEventListener(
      "abort",
      () => managedHosts.delete(dataDir),
      { once: true },
    );
  }

  return host;
}

const housekeepingHosts = new Map<
  string,
  ReturnType<typeof createHousekeepingHost>
>();

function housekeepingHost(
  context: ExperimentalHostRpcContext<typeof housekeepingHostSignals>,
) {
  const dataDir = context.experimental_paths.dataDir;
  let host = housekeepingHosts.get(dataDir);

  if (!host) {
    host = createHousekeepingHost({
      dataDir,
      retainWorker: () => context.experimental_retainWorker(),
      changed: (runId) => {
        void context
          .experimental_emitSignal("changed", { runId })
          .catch(() => undefined);
      },
    });
    housekeepingHosts.set(dataDir, host);
    context.lifecycle.signal.addEventListener(
      "abort",
      () => housekeepingHosts.delete(dataDir),
      { once: true },
    );
  }

  return host;
}

function assertStorageEntry(rootPath: string, name: string) {
  if (
    !path.isAbsolute(rootPath) ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    !isStorageEntryName(name)
  )
    throw new Error("Invalid storage entry");
}

async function hasRetentionReceipt(directory: string): Promise<boolean> {
  try {
    await fs.lstat(path.join(directory, "storage-retention.json"));

    return true;
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }
}

export default experimental_defineHostEntry({
  contract: hostStorageContract,
  experimental_signals: { ...housekeepingHostSignals, ...worktreesHostSignals },
  dispose: worktreesHost.dispose,
  handlers: {
    ...worktreesHost.handlers,
    housekeepingHostState: (_input, context) =>
      housekeepingHost(context).state(),
    housekeepingHostAdapterPreview: (input, context) =>
      housekeepingHost(context).adapterPreview(input),
    housekeepingHostAdapterAdopt: (input, context) =>
      housekeepingHost(context).adapterAdopt(input),
    housekeepingHostAdapterRemove: (input, context) =>
      housekeepingHost(context).adapterRemove(input),
    housekeepingHostStart: (input, context) =>
      housekeepingHost(context).start(input, () =>
        context.experimental_retainWorker(),
      ),
    housekeepingHostRun: (input, context) =>
      housekeepingHost(context).run(input),
    managedAllocate: (input, context) =>
      managedHost(context).managedAllocate(input, context.signal),
    managedInspect: (input, context) =>
      managedHost(context).managedInspect(input, context.signal),
    managedList: (input, context) =>
      managedHost(context).managedList(input, context.signal),
    managedOwnerDecision: (input, context) =>
      managedHost(context).managedOwnerDecision(input, context.signal),
    managedReview: (input, context) =>
      managedHost(context).managedReview(input, context.signal),
    managedTransition: (input, context) =>
      managedHost(context).managedTransition(input, context.signal),
    managedReconcile: (input, context) =>
      managedHost(context).managedReconcile(input, context.signal),
    managedReanchor: (input, context) =>
      managedHost(context).managedReanchor(input, context.signal),

    async retainedEntries({ rootPath, names }, context) {
      const retained: string[] = [];

      for (const name of names) {
        assertStorageEntry(rootPath, name);
        context.signal.throwIfAborted();

        if (await hasRetentionReceipt(path.join(rootPath, name)))
          retained.push(name);
      }

      return { retained };
    },
    inspectDeveloperEntries: (input, context) =>
      inspectDeveloperEntries(input, context.signal),
    removeDeveloperEntries: (input, context) =>
      removeDeveloperEntries(input, context.signal, () =>
        context.experimental_retainWorker(),
      ),
    homeDirectory: () => os.homedir(),
    measure: (input, context) =>
      measureDiskUsage(input, undefined, context.signal),
    async discardLargeFiles({ rootPath, names, minBytes }, context) {
      for (const name of names) assertStorageEntry(rootPath, name);
      let root: string;

      try {
        root = await fs.realpath(rootPath);
      } catch (error) {
        if (isFsErrorWithCode(error, "ENOENT")) return { removed: [] };
        throw error;
      }

      const removed = [];

      for (const name of names) {
        const directory = path.join(root, name);

        if (await hasRetentionReceipt(directory)) continue;

        const stats = await fs.lstat(directory).catch((error: unknown) => {
          if (isFsErrorWithCode(error, "ENOENT")) return null;
          throw error;
        });

        if (stats === null) continue;

        if (stats.isSymbolicLink() || !stats.isDirectory())
          throw new Error(
            "Storage entry must be a directory, not a symbolic link",
          );
        let sizeBytes = 0;
        let count = 0;

        const { largeFiles } = await measureDiskUsage(
          {
            targets: [{ path: directory, perChild: false }],
            timeoutMs: 29 * 60_000,
            largeFileMinBytes: minBytes,
          },
          { duCommand: null },
          context.signal,
        );

        for (const file of largeFiles) {
          context.signal.throwIfAborted();
          const relative = path.relative(directory, file.path);

          if (
            !path.isAbsolute(file.path) ||
            relative === "" ||
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw new Error("Large file must be inside its storage directory");

          try {
            const current = await fs.lstat(file.path);

            if (!current.isFile()) continue;

            const currentBytes =
              process.platform === "win32"
                ? current.size
                : current.blocks * 512;

            if (currentBytes < minBytes) continue;

            if ((await fs.realpath(file.path)) !== file.path) continue;
            context.signal.throwIfAborted();

            if (await hasRetentionReceipt(directory)) break;
            await fs.unlink(file.path);
            sizeBytes += currentBytes;
            count++;
          } catch (error) {
            if (
              !isFsErrorWithCode(error, "ENOENT") &&
              !isFsErrorWithCode(error, "ENOTDIR")
            )
              throw error;
          }
        }

        removed.push({ name, sizeBytes, count });
      }

      return { removed };
    },
    async capacity({ path: target }) {
      if (!path.isAbsolute(target)) throw new Error("Invalid storage path");

      for (let current = target; ; current = path.dirname(current)) {
        try {
          const stats = await fs.statfs(current);

          return {
            totalBytes: stats.blocks * stats.bsize,
            freeBytes: stats.bavail * stats.bsize,
          };
        } catch (error) {
          if (
            !isFsErrorWithCode(error, "ENOENT") ||
            current === path.dirname(current)
          )
            throw error;
        }
      }
    },
    async discard({ rootPath, names, recreate }, context) {
      for (const name of names) {
        assertStorageEntry(rootPath, name);

        if (recreate && isRetentionTrashName(name))
          throw new Error("Cannot recreate a trash directory");
      }

      context.signal.throwIfAborted();

      if (recreate) await fs.mkdir(rootPath, { recursive: true });
      let root: string;

      try {
        root = await fs.realpath(rootPath);
      } catch (error) {
        if (isFsErrorWithCode(error, "ENOENT")) return { removed: [] };
        throw error;
      }

      const eligible: string[] = [];

      for (const name of names) {
        context.signal.throwIfAborted();

        if (!(await hasRetentionReceipt(path.join(root, name))))
          eligible.push(name);
      }

      if (eligible.length === 0) return { removed: [] };
      await experimental_killProcessesWithCwdUnder({
        directories: eligible.flatMap((name) =>
          isRetentionTrashName(name) ? [] : [path.join(root, name)],
        ),
      });
      context.signal.throwIfAborted();
      const removed: string[] = [];

      const trashes = (await fs.readdir(root)).flatMap((name) =>
        isRetentionTrashName(name) ? [path.join(root, name)] : [],
      );

      try {
        for (const name of eligible) {
          context.signal.throwIfAborted();
          const source = path.join(root, name);

          if (await hasRetentionReceipt(source)) continue;

          try {
            const stat = await fs.lstat(source);

            if (stat.isSymbolicLink() || !stat.isDirectory())
              throw new Error(
                "Storage entry must be a directory, not a symbolic link",
              );

            const trash = isRetentionTrashName(name)
              ? source
              : path.join(
                  root,
                  `${RETENTION_TRASH_PREFIX}${name}-${randomUUID()}`,
                );

            if (source !== trash) await fs.rename(source, trash);
            trashes.push(trash);
            removed.push(name);
          } catch (error) {
            if (!isFsErrorWithCode(error, "ENOENT")) throw error;
          }

          if (recreate) await fs.mkdir(source, { recursive: true });
        }
      } finally {
        for (const trash of new Set(trashes)) {
          try {
            if (await hasRetentionReceipt(trash)) continue;
            removeTrashInBackground(
              [trash],
              () => context.experimental_retainWorker(),
              "Storage trash cleanup failed",
            );
          } catch (error) {
            console.error("Storage trash cleanup failed", error);
          }
        }
      }

      return { removed };
    },
  },
});

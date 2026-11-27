import fs from "node:fs/promises";
import path from "node:path";
import {
  killProcessesWithCwdUnder,
  resolveContainedPath,
} from "@omnyo/process-utils";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
} from "./command-errors.js";
import { resolveNonSymlinkDirectoryPath } from "./command-handlers/root-path.js";

async function resolveThreadStoragePath(args: {
  rootPath: string;
  threadId: string;
  missingDirectory: "ignore" | "error";
}): Promise<string | null> {
  const candidate = resolveContainedPath({
    rootPath: args.rootPath,
    candidatePath: path.join(args.rootPath, args.threadId),
  });

  if (candidate === null || path.basename(candidate) !== args.threadId)
    throw new CommandDispatchError(
      "invalid_path",
      "Thread storage path escapes the storage root",
    );

  try {
    const root = await resolveNonSymlinkDirectoryPath({
      path: args.rootPath,
      description: "Thread storage root",
    });

    const target = await resolveNonSymlinkDirectoryPath({
      path: candidate,
      description: "Thread storage directory",
    });

    if (
      resolveContainedPath({ rootPath: root, candidatePath: target }) === null
    )
      throw new CommandDispatchError(
        "invalid_path",
        "Thread storage path escapes the storage root",
      );

    return target;
  } catch (error) {
    if (
      args.missingDirectory === "ignore" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}

export async function removeThreadStorage(args: {
  rootPath: string;
  threadId: string;
  missingDirectory: "ignore" | "error";
}): Promise<void> {
  const storagePath = await resolveThreadStoragePath(args);

  if (storagePath === null) return;
  const receiptPath = path.join(storagePath, "storage-retention.json");

  async function requireUnretained() {
    try {
      await fs.lstat(receiptPath);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return;
      throw error;
    }

    throw new ExpectedCommandDispatchError(
      "command_failed",
      "Thread storage has a retention receipt",
    );
  }

  await requireUnretained();
  await killProcessesWithCwdUnder({ directories: [storagePath] });
  await requireUnretained();
  await fs.rm(storagePath, {
    recursive: true,
    force: args.missingDirectory === "ignore",
  });
}

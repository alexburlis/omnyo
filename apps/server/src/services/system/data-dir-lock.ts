import { join } from "node:path";
import { FileLockTimeoutError, acquireFileLock } from "@omnyo/config/file-lock";
import { SERVER_DATA_DIR_LOCK_FILE_NAME } from "@omnyo/config/server";

const SERVER_DATA_DIR_LOCK_TIMEOUT_MS = 15_000;

export class ServerDataDirInUseError extends Error {
  constructor(readonly dataDir: string) {
    super(
      `Another Omnyo server is using the data directory ${dataDir}. Stop that server before starting another one on this directory.`,
    );
    this.name = "ServerDataDirInUseError";
  }
}

export async function lockServerDataDir(args: {
  dataDir: string;
  timeoutMs?: number;
}): Promise<() => Promise<void>> {
  const path = join(args.dataDir, SERVER_DATA_DIR_LOCK_FILE_NAME);

  try {
    return await acquireFileLock({
      path,
      timeoutMs: args.timeoutMs ?? SERVER_DATA_DIR_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError)
      throw new ServerDataDirInUseError(args.dataDir);
    throw error;
  }
}

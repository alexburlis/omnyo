import { mkdir, open, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const LOCK_RETRY_MS = 25;

interface NativeFileLocks {
  tryLock: (fd: number) => boolean;
  unlock: (fd: number) => void;
}

let loadedNativeFileLocks: NativeFileLocks | undefined;

function loadNativeFileLocks(): NativeFileLocks {
  if (loadedNativeFileLocks !== undefined) return loadedNativeFileLocks;
  const value: unknown = createRequire(import.meta.url)("fs-native-extensions");

  if (
    value === null ||
    typeof value !== "object" ||
    !("tryLock" in value) ||
    typeof value.tryLock !== "function" ||
    !("unlock" in value) ||
    typeof value.unlock !== "function"
  ) {
    throw new Error("Invalid fs-native-extensions module");
  }

  const tryLock = value.tryLock;
  const unlock = value.unlock;
  loadedNativeFileLocks = {
    tryLock: (fd) => {
      const result: unknown = Reflect.apply(tryLock, value, [fd]);

      if (typeof result !== "boolean") {
        throw new Error("Invalid fs-native-extensions lock result");
      }

      return result;
    },
    unlock: (fd) => {
      Reflect.apply(unlock, value, [fd]);
    },
  };

  return loadedNativeFileLocks;
}

export class FileLockTimeoutError extends Error {
  constructor(readonly path: string) {
    super(`Timed out waiting for file lock: ${path}`);
  }
}

type FileLockArgs = {
  path: string;
  timeoutMs: number;
} & (
  | { existingOnly: true; identity: { device: string; inode: string } }
  | { existingOnly?: undefined; identity?: undefined }
);

export async function acquireFileLock(
  args: FileLockArgs,
): Promise<() => Promise<void>> {
  const nativeFileLocks = loadNativeFileLocks();

  if (args.existingOnly !== true)
    await mkdir(dirname(args.path), { recursive: true });

  const handle = await open(
    args.path,
    args.existingOnly === true ? "r+" : "a+",
    0o600,
  );

  try {
    if (args.existingOnly === true) {
      const info = await handle.stat({ bigint: true });

      if (
        !info.isFile() ||
        info.dev.toString() !== args.identity.device ||
        info.ino.toString() !== args.identity.inode
      )
        throw new Error("Existing file lock no longer has its original inode");
    }

    const deadline = performance.now() + args.timeoutMs;

    for (;;) {
      if (nativeFileLocks.tryLock(handle.fd)) {
        break;
      }

      if (performance.now() >= deadline) {
        throw new FileLockTimeoutError(args.path);
      }

      await sleep(LOCK_RETRY_MS);
    }

    const held = await handle.stat({ bigint: true });
    const current = await stat(args.path, { bigint: true });

    if (held.dev !== current.dev || held.ino !== current.ino) {
      throw new Error("File lock path changed while waiting for its owner");
    }
  } catch (error) {
    await handle.close();
    throw error;
  }

  let releasePromise: Promise<void> | null = null;

  return () =>
    (releasePromise ??= (async () => {
      try {
        nativeFileLocks.unlock(handle.fd);
      } finally {
        await handle.close();
      }
    })());
}

export async function withFileLock<T>(
  args: FileLockArgs & { work: () => Promise<T> },
): Promise<T> {
  const release = await acquireFileLock(args);

  try {
    return await args.work();
  } finally {
    await release();
  }
}

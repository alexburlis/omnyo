import { lstat, realpath, statfs } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

function missing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function bytes(value, positive) {
  return Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

export async function assertStorageAdmission({
  directory,
  expectedBytes,
  minimumFreeBytes,
}) {
  if (
    !bytes(expectedBytes, true) ||
    !bytes(minimumFreeBytes, false) ||
    !Number.isSafeInteger(expectedBytes + minimumFreeBytes)
  )
    throw new Error(
      "Storage admission requires a finite positive allocation and a finite reserve.",
    );

  if (
    typeof directory !== "string" ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory
  )
    throw new Error(
      "Storage admission requires an exact absolute destination.",
    );

  let filesystemDirectory = directory;
  let before;

  for (;;) {
    try {
      before = await lstat(filesystemDirectory, { bigint: true });
      break;
    } catch (error) {
      if (
        !missing(error) ||
        dirname(filesystemDirectory) === filesystemDirectory
      )
        throw error;
      filesystemDirectory = dirname(filesystemDirectory);
    }
  }

  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (await realpath(filesystemDirectory)) !== filesystemDirectory
  )
    throw new Error(
      "Storage admission refuses a symbolic or nonphysical destination.",
    );

  const space = await statfs(filesystemDirectory, { bigint: true });
  const after = await lstat(filesystemDirectory, { bigint: true });

  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    !after.isDirectory() ||
    (await realpath(filesystemDirectory)) !== filesystemDirectory
  )
    throw new Error("The storage destination changed during admission.");

  if (space.bavail < 0n || space.bsize <= 0n)
    throw new Error("The storage destination has unknown available space.");

  const available = space.bavail * space.bsize;
  const requiredBytes = expectedBytes + minimumFreeBytes;

  if (available < BigInt(requiredBytes))
    throw new Error(
      `Storage admission needs ${requiredBytes} bytes but only ${available} bytes are available. No allocation was created.`,
    );

  return {
    directory,
    filesystemDirectory,
    availableBytes: Number(
      available > BigInt(Number.MAX_SAFE_INTEGER)
        ? BigInt(Number.MAX_SAFE_INTEGER)
        : available,
    ),
    requiredBytes,
    expectedBytes,
    minimumFreeBytes,
  };
}

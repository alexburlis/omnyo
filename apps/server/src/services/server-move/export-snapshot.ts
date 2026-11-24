import { constants, statfsSync } from "node:fs";
import {
  chmod,
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatServerDataSize } from "@omnyo/domain";
import { isSealed, type SecretVault } from "@omnyo/secret-storage";
import {
  hasErrorCode,
  listServerOwnedEntries,
  ServerArchiveError,
  type ServerArchiveSourceFile,
  type ServerOwnedInventory,
} from "@omnyo/server-archive";
import { ApiError } from "../../errors.js";
import type { ServerLogger } from "../../types.js";

export const SERVER_DATABASE_ARCHIVE_PATH = "app.db";

const SNAPSHOT_DIR_PREFIX = "snapshot-";

const BACKUP_PAGES_PER_STEP = 100;

const SERVER_EXPORT_MARGIN_BYTES = 1024 ** 3;

const FROZEN_FILE_MAX_BYTES = 1024 ** 2;

const DEPENDENCY_TREE_DIR_NAME = "node_modules";

const SEALED_PROBE_BYTES = 64;

type ServerOwnedFile = ServerOwnedInventory["entries"][number]["files"][number];

export interface ServerExportFreeSpace {
  marginBytes: number;
  readFreeBytes(path: string): number;
}

export function readFreeBytes(path: string): number {
  const stats = statfsSync(path);

  return Number(stats.bavail) * Number(stats.bsize);
}

export const SERVER_EXPORT_FREE_SPACE: ServerExportFreeSpace = {
  marginBytes: SERVER_EXPORT_MARGIN_BYTES,
  readFreeBytes,
};

export interface SqliteBackupProgress {
  totalPages: number;
  remainingPages: number;
}

export type SqliteBackupProgressHandler = (
  progress: SqliteBackupProgress,
) => number;

export interface SqliteSnapshotSource {
  backup(
    destinationPath: string,
    options: { progress: SqliteBackupProgressHandler },
  ): Promise<SqliteBackupProgress>;
  close(): void;
  exec(source: string): void;
  prepare(source: string): { get(...params: unknown[]): unknown };
}

export type OpenSqliteSnapshotSource = (path: string) => SqliteSnapshotSource;

export interface ServerDataSnapshotArgs {
  backupServerDatabase(
    destinationPath: string,
    progress: SqliteBackupProgressHandler,
  ): Promise<void>;
  dataDir: string;
  freeSpace: ServerExportFreeSpace;
  logger: Pick<ServerLogger, "warn">;
  openDatabase: OpenSqliteSnapshotSource;
  openVault(): Promise<SecretVault>;
  signal: AbortSignal | null;
  workDir: string;
}

export interface ServerDataSnapshot {
  files: ServerArchiveSourceFile[];
  inventory: ServerOwnedInventory;
}

function diskSpaceError(message: string): ApiError {
  return new ApiError(507, "server_export_disk_space", message);
}

async function fileSizeOrZero(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return 0;
    }

    throw error;
  }
}

async function estimateSnapshotBytes(
  inventory: ServerOwnedInventory,
): Promise<number> {
  let total = 0;

  for (const entry of inventory.entries) {
    for (const file of entry.files) {
      if (file.sqliteDatabase) {
        total +=
          file.sizeBytes + (await fileSizeOrZero(`${file.absolutePath}-wal`));
      } else if (isFrozenFile(file)) {
        total += file.sizeBytes;
      }
    }
  }

  return total;
}

function isDependencyTreeFile(file: ServerOwnedFile): boolean {
  return file.path.split("/").includes(DEPENDENCY_TREE_DIR_NAME);
}

function isFrozenFile(file: ServerOwnedFile): boolean {
  return (
    !file.sqliteDatabase &&
    file.sizeBytes <= FROZEN_FILE_MAX_BYTES &&
    !isDependencyTreeFile(file)
  );
}

function looksSealed(bytes: Buffer): boolean {
  return isSealed(bytes.subarray(0, SEALED_PROBE_BYTES).toString("utf8"));
}

interface ServerFileBytes {
  bytes: Buffer;
  mode: number;
}

async function readServerFile(
  sourcePath: string,
  limit: number | null,
): Promise<ServerFileBytes> {
  let source: FileHandle;

  try {
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new ServerArchiveError(
        "unsafe_entry",
        `${sourcePath} is a symbolic link`,
      );
    }

    throw error;
  }

  try {
    const stats = await source.stat();

    if (!stats.isFile()) {
      throw new ServerArchiveError(
        "unsafe_entry",
        `${sourcePath} is not a regular file`,
      );
    }

    if (limit === null)
      return { bytes: await source.readFile(), mode: stats.mode & 0o777 };

    const probe = Buffer.alloc(limit);
    const { bytesRead } = await source.read(probe, 0, limit, 0);

    return { bytes: probe.subarray(0, bytesRead), mode: stats.mode & 0o777 };
  } finally {
    await source.close();
  }
}

async function writeFrozenFile(
  destinationPath: string,
  frozen: ServerFileBytes,
): Promise<void> {
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, frozen.bytes, { flag: "wx" });
  await chmod(destinationPath, frozen.mode);
}

async function assertRoomForSnapshot(args: {
  dataDir: string;
  freeSpace: ServerExportFreeSpace;
  workDir: string;
}): Promise<void> {
  const estimatedBytes = await estimateSnapshotBytes(
    await listServerOwnedEntries(args.dataDir),
  );

  const requiredBytes = estimatedBytes + args.freeSpace.marginBytes;
  const freeBytes = args.freeSpace.readFreeBytes(args.workDir);

  if (freeBytes < requiredBytes) {
    throw diskSpaceError(
      `The export needs about ${formatServerDataSize(requiredBytes)} free in ${args.workDir} for its database snapshot and a ${formatServerDataSize(args.freeSpace.marginBytes)} margin, but only ${formatServerDataSize(freeBytes)} is available. Free up space, then export again.`,
    );
  }
}

function guardBackupProgress(args: {
  freeSpace: ServerExportFreeSpace;
  signal: AbortSignal | null;
  workDir: string;
}): SqliteBackupProgressHandler {
  return () => {
    args.signal?.throwIfAborted();
    const freeBytes = args.freeSpace.readFreeBytes(args.workDir);

    if (freeBytes < args.freeSpace.marginBytes) {
      throw diskSpaceError(
        `Free space in ${args.workDir} fell to ${formatServerDataSize(freeBytes)}, below the ${formatServerDataSize(args.freeSpace.marginBytes)} margin, so the export stopped and removed its snapshot.`,
      );
    }

    return BACKUP_PAGES_PER_STEP;
  };
}

export async function withSqliteReadSnapshot<T>(
  openDatabase: OpenSqliteSnapshotSource,
  sourcePath: string,
  run: (source: SqliteSnapshotSource) => Promise<T>,
): Promise<T> {
  const source = openDatabase(sourcePath);

  try {
    source.exec("BEGIN");

    try {
      source.prepare("SELECT COUNT(*) FROM sqlite_schema").get();

      return await run(source);
    } finally {
      source.exec("ROLLBACK");
    }
  } finally {
    source.close();
  }
}

async function snapshotSqliteDatabase(args: {
  destinationPath: string;
  openDatabase: OpenSqliteSnapshotSource;
  progress: SqliteBackupProgressHandler;
  sourcePath: string;
}): Promise<void> {
  await mkdir(dirname(args.destinationPath), { recursive: true });
  await withSqliteReadSnapshot(args.openDatabase, args.sourcePath, (source) =>
    source.backup(args.destinationPath, { progress: args.progress }),
  );
}

export async function withServerDataSnapshot<T>(
  args: ServerDataSnapshotArgs,
  run: (snapshot: ServerDataSnapshot) => Promise<T>,
): Promise<T> {
  await mkdir(args.workDir, { recursive: true });
  const snapshotDir = await mkdtemp(join(args.workDir, SNAPSHOT_DIR_PREFIX));

  try {
    args.signal?.throwIfAborted();
    await assertRoomForSnapshot({
      dataDir: args.dataDir,
      freeSpace: args.freeSpace,
      workDir: args.workDir,
    });

    const progress = guardBackupProgress({
      freeSpace: args.freeSpace,
      signal: args.signal,
      workDir: args.workDir,
    });

    const databaseSnapshotPath = join(
      snapshotDir,
      SERVER_DATABASE_ARCHIVE_PATH,
    );

    await args.backupServerDatabase(databaseSnapshotPath, progress);
    const inventory = await listServerOwnedEntries(args.dataDir);

    if (inventory.skippedPaths.length > 0) {
      args.logger.warn(
        { dataDir: args.dataDir, skippedPaths: inventory.skippedPaths },
        "Server export skipped symbolic links and special files",
      );
    }

    const files: ServerArchiveSourceFile[] = [
      {
        archivePath: SERVER_DATABASE_ARCHIVE_PATH,
        sourcePath: databaseSnapshotPath,
      },
    ];

    let vault: Promise<SecretVault> | undefined;

    const unsealed = async (
      file: ServerOwnedFile,
      sealed: Buffer,
    ): Promise<ServerArchiveSourceFile> => {
      vault ??= args.openVault();

      return {
        archivePath: file.path,
        sourcePath: file.absolutePath,
        contents: Buffer.from((await vault).open(sealed.toString("utf8"))),
      };
    };

    for (const entry of inventory.entries) {
      for (const file of entry.files) {
        if (file.path === SERVER_DATABASE_ARCHIVE_PATH) {
          continue;
        }

        const snapshotPath = join(snapshotDir, ...file.path.split("/"));

        if (isFrozenFile(file)) {
          const frozen = await readServerFile(file.absolutePath, null);

          if (looksSealed(frozen.bytes)) {
            files.push(await unsealed(file, frozen.bytes));
            continue;
          }

          await writeFrozenFile(snapshotPath, frozen);
          files.push({ archivePath: file.path, sourcePath: snapshotPath });
          continue;
        }

        if (!file.sqliteDatabase) {
          if (
            !isDependencyTreeFile(file) &&
            looksSealed(
              (await readServerFile(file.absolutePath, SEALED_PROBE_BYTES))
                .bytes,
            )
          ) {
            files.push(
              await unsealed(
                file,
                (await readServerFile(file.absolutePath, null)).bytes,
              ),
            );
            continue;
          }

          files.push({ archivePath: file.path, sourcePath: file.absolutePath });
          continue;
        }

        await snapshotSqliteDatabase({
          destinationPath: snapshotPath,
          openDatabase: args.openDatabase,
          progress,
          sourcePath: file.absolutePath,
        });
        files.push({ archivePath: file.path, sourcePath: snapshotPath });
      }
    }

    return await run({ files, inventory });
  } finally {
    await rm(snapshotDir, { force: true, recursive: true });
  }
}

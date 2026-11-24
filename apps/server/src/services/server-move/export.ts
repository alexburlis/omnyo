import Database from "better-sqlite3";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  countAppliedMigrations,
  getExperiments,
  type DbConnection,
} from "@omnyo/db";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import type { SecretVault } from "@omnyo/secret-storage";
import {
  pipeServerArchive,
  planServerArchive,
  ServerArchiveError,
  type ServerArchiveDigest,
  type ServerArchiveManifestInput,
  writeServerArchive,
} from "@omnyo/server-archive";
import type { ServerLogger } from "../../types.js";
import {
  type ServerDataSnapshot,
  type ServerExportFreeSpace,
  type SqliteSnapshotSource,
  withServerDataSnapshot,
} from "./export-snapshot.js";
import { listOldCopyEntries } from "./switch.js";

interface ServerExportSourceArgs {
  appVersion: string;
  dataDir: string;
  db: DbConnection;
  freeSpace: ServerExportFreeSpace;
  logger: Pick<ServerLogger, "warn">;
  now: number;
  sourceServerHostId: string | null;
  vault: SecretVault;
  workDir: string;
}

export interface ExportServerArchiveArgs extends ServerExportSourceArgs {
  fileName: string;
}

export interface StreamServerExportArgs extends ServerExportSourceArgs {
  onMeasured(archive: ServerArchiveDigest): void;
  output: Writable;
  signal: AbortSignal;
}

export interface ServerArchiveExport {
  oldCopyEntries: string[];
  path: string;
  sha256: string;
  sizeBytes: number;
  skippedPaths: string[];
}

export interface ServerArchiveStream extends ServerArchiveDigest {
  skippedPaths: string[];
}

function openReadonlyDatabase(path: string): SqliteSnapshotSource {
  return new Database(path, { fileMustExist: true, readonly: true });
}

function withLiveServerSnapshot<T>(
  args: ServerExportSourceArgs,
  signal: AbortSignal | null,
  run: (snapshot: ServerDataSnapshot) => Promise<T>,
): Promise<T> {
  return withServerDataSnapshot(
    {
      backupServerDatabase: async (destinationPath, progress) => {
        await args.db.$client.backup(destinationPath, { progress });
      },
      dataDir: args.dataDir,
      freeSpace: args.freeSpace,
      logger: args.logger,
      openDatabase: openReadonlyDatabase,
      openVault: async () => args.vault,
      signal,
      workDir: args.workDir,
    },
    run,
  );
}

function serverManifestInput(
  args: ServerExportSourceArgs,
): ServerArchiveManifestInput {
  return {
    createdAt: args.now,
    appVersion: args.appVersion,
    protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
    migrationCount: countAppliedMigrations(args.db),
    sourceDataDir: args.dataDir,
    sourceServerHostId: args.sourceServerHostId,
    serverMoveExperiment: getExperiments(args.db).serverMove,
  };
}

function discardingWritable(): Writable {
  return new Writable({
    write(_chunk: Buffer, _encoding, callback) {
      callback();
    },
  });
}

export async function exportServerArchive(
  args: ExportServerArchiveArgs,
): Promise<ServerArchiveExport> {
  return withLiveServerSnapshot(args, null, async (snapshot) => {
    const outPath = join(args.workDir, args.fileName);

    const result = await writeServerArchive({
      outPath,
      files: snapshot.files,
      manifest: serverManifestInput(args),
    });

    return {
      oldCopyEntries: listOldCopyEntries(snapshot.inventory.entries),
      path: outPath,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
      skippedPaths: snapshot.inventory.skippedPaths,
    };
  });
}

export async function streamServerExport(
  args: StreamServerExportArgs,
): Promise<ServerArchiveStream> {
  return withLiveServerSnapshot(args, args.signal, async (snapshot) => {
    const plan = await planServerArchive({
      files: snapshot.files,
      manifest: serverManifestInput(args),
      signal: args.signal,
    });

    const measured = await pipeServerArchive({
      plan,
      output: discardingWritable(),
      signal: args.signal,
    });

    args.onMeasured(measured);

    const streamed = await pipeServerArchive({
      plan,
      output: args.output,
      signal: args.signal,
    });

    if (
      streamed.sha256 !== measured.sha256 ||
      streamed.sizeBytes !== measured.sizeBytes
    ) {
      throw new ServerArchiveError(
        "digest_mismatch",
        "The streamed server export differs from the archive it measured",
      );
    }

    return { ...streamed, skippedPaths: snapshot.inventory.skippedPaths };
  });
}

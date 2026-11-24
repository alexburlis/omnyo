import { join } from "node:path";
import type { Writable } from "node:stream";
import { defaultExperiments, type ExperimentKey } from "@omnyo/domain";
import {
  type ServerArchiveDigest,
  streamServerArchive,
} from "@omnyo/server-archive";
import { readRuntimeIdentity } from "@omnyo/server-archive/runtime-identity";
import { openSecretVault } from "@omnyo/secret-storage";
import { z } from "zod";
import { readPrimaryHostIdFromDataDir } from "../src/services/hosts/primary-host-id.js";
import {
  type OpenSqliteSnapshotSource,
  SERVER_DATABASE_ARCHIVE_PATH,
  type ServerExportFreeSpace,
  type SqliteSnapshotSource,
  withServerDataSnapshot,
  withSqliteReadSnapshot,
} from "../src/services/server-move/export-snapshot.js";
import type { ServerLogger } from "../src/types.js";

const SERVER_MOVE_EXPERIMENT_KEY: ExperimentKey = "serverMove";

const migrationCountRowSchema = z.object({
  count: z.number().int().nonnegative(),
});

const experimentRowSchema = z
  .object({ value: z.union([z.literal(0), z.literal(1)]) })
  .optional();

export interface OmnyoAppRuntime {
  appVersion: string;
  protocolVersion: number;
}

export interface ExportDataDirArchiveArgs {
  dataDir: string;
  freeSpace: ServerExportFreeSpace;
  logger: Pick<ServerLogger, "warn">;
  now: number;
  openDatabase: OpenSqliteSnapshotSource;
  output: Writable;
  runtime: OmnyoAppRuntime;
  signal: AbortSignal;
  workDir: string;
}

interface ServerManifestFacts {
  migrationCount: number;
  serverMoveExperiment: boolean;
}

export async function readOmnyoAppRuntime(
  omnyoAppDir: string,
): Promise<OmnyoAppRuntime> {
  const identity = await readRuntimeIdentity(omnyoAppDir);

  return {
    appVersion: identity.runtimeVersion,
    protocolVersion: identity.hostDaemonProtocolVersion,
  };
}

function readServerManifestFacts(
  database: SqliteSnapshotSource,
): ServerManifestFacts {
  const migrationsTable = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    )
    .get();

  const migrationCount =
    migrationsTable === undefined
      ? 0
      : migrationCountRowSchema.parse(
          database
            .prepare("SELECT COUNT(*) AS count FROM __drizzle_migrations")
            .get(),
        ).count;

  const experiment = experimentRowSchema.parse(
    database
      .prepare("SELECT value FROM system_experiments WHERE key = ?")
      .get(SERVER_MOVE_EXPERIMENT_KEY),
  );

  return {
    migrationCount,
    serverMoveExperiment:
      experiment === undefined
        ? defaultExperiments.serverMove
        : experiment.value === 1,
  };
}

export async function exportDataDirArchive(
  args: ExportDataDirArchiveArgs,
): Promise<ServerArchiveDigest> {
  let facts: ServerManifestFacts | null = null;

  return withServerDataSnapshot(
    {
      backupServerDatabase: (destinationPath, progress) =>
        withSqliteReadSnapshot(
          args.openDatabase,
          join(args.dataDir, SERVER_DATABASE_ARCHIVE_PATH),
          async (source) => {
            await source.backup(destinationPath, { progress });
            facts = readServerManifestFacts(source);
          },
        ),
      dataDir: args.dataDir,
      freeSpace: args.freeSpace,
      logger: args.logger,
      openDatabase: args.openDatabase,
      openVault: () => openSecretVault(args.dataDir),
      signal: args.signal,
      workDir: args.workDir,
    },
    async (snapshot) => {
      if (facts === null) {
        throw new Error(
          "The database snapshot finished without reading its migration count and experiments",
        );
      }

      const result = await streamServerArchive({
        files: snapshot.files,
        manifest: {
          createdAt: args.now,
          appVersion: args.runtime.appVersion,
          protocolVersion: args.runtime.protocolVersion,
          migrationCount: facts.migrationCount,
          sourceDataDir: args.dataDir,
          sourceServerHostId: readPrimaryHostIdFromDataDir({
            dataDir: args.dataDir,
          }),
          serverMoveExperiment: facts.serverMoveExperiment,
        },
        output: args.output,
        signal: args.signal,
      });

      return { sha256: result.sha256, sizeBytes: result.sizeBytes };
    },
  );
}

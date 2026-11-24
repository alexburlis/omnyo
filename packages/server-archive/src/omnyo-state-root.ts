import {
  adoptLegacyAppUpdateFilesV1,
  assertLegacyAppUpdateOwnerStoppedV1,
} from "./legacy-app-update-files-v1.js";
import { copyMacStateAclTreeV1 } from "../mac-state-acl-v1.mjs";
import {
  copyOmnyoStateTreeV1,
  inspectOmnyoStateTreeKindsV1,
  inspectOmnyoStateTreeDigestV1,
  isOmnyoStateSocketPathV1,
  validateOmnyoSocketBridgesV1,
  type OmnyoStateSocketBindingV1,
  type OmnyoStateTreeConfigDigestV1,
} from "../omnyo-state-tree-v1.mjs";
import { legacyInstalledRuntimeVersionV1Schema } from "./legacy-runtime-identity-v1.js";
import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import {
  assertDatabaseIntegrity,
  databaseVerificationProofV2Schema,
  inspectDatabaseFilesV2,
  inspectDatabaseRootIdentityV2,
  readDatabaseVerificationProofV2,
  verifyDatabaseReadonlyV2,
  type DatabaseVerificationProofV2,
  type ReadonlyStateRootDatabaseV2,
} from "./omnyo-state-database-v2.js";
import {
  identityAdoptionBindingSchema,
  identityAdoptionControlRequestSchemaV1,
  type IdentityAdoptionControlRequestV1,
} from "@omnyo/domain";
import { withFileLock } from "@omnyo/config/file-lock";
import { parseAppManagedConfig } from "@omnyo/config/managed-app-config";
import {
  prepareOmnyoStateAdmission,
  assertOmnyoStateAdmissionPrepared,
  readOmnyoStateAdmission,
  selectOmnyoPreWriteRollback,
  type OmnyoStateBinding,
} from "@omnyo/config/omnyo-state-admission";
import {
  assertStoppedIdentityRuntimeOwnersV1,
  assertPromotedIdentityHoldV1,
  readMaintenanceHold,
} from "./maintenance-hold.js";
import {
  SERVER_IMPORT_FILE_NAME,
  SERVER_IMPORT_JOURNAL_FILE_NAME,
  SERVER_MOVED_FILE_NAME,
} from "./markers.js";
import { hasErrorCode } from "./errors.js";
import {
  writeJsonFileAtomically,
  writeTextFileAtomically,
} from "./json-file.js";
import {
  readRuntimeIdentity,
  runtimeIdentitySchema,
  verifyWorkerRuntimeIdentity,
} from "./runtime-identity.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const jobSchema = z
  .object({
    version: z.literal(1),
    migrationId: z.string().min(1),
    ownerId: z.string().min(1),
    serverHostId: z.string().min(1),
    sourceDataDir: z.string().min(1),
    destinationDataDir: z.string().min(1),
    artifactDigest: digest,
    sourceDigest: digest,
    digestAlgorithm: z
      .enum(["legacy-tree-v1", "state-tree-v2"])
      .default("legacy-tree-v1"),
    databaseVerification: z
      .enum(["inline-v1", "release-producer-v1"])
      .default("inline-v1"),
    phase: z.enum([
      "prepared",
      "fenced",
      "cloned",
      "clone-verified",
      "acl-verified",
      "renaming-database",
      "copied",
      "converted",
      "database-verified",
      "destination-sealed",
      "sealed",
      "verified",
      "rollback-selected",
      "rollback-source-verified",
      "aborting-before-admission",
      "aborted-before-admission",
    ]),
    configPresent: z.boolean(),
    configMode: z.number().int(),
    configDigest: digest.nullable(),
    destinationDigest: digest.nullable(),
    stagingDevice: z.string().nullable(),
    stagingInode: z.string().nullable(),
    stagingCreationIntent: z.boolean().default(false),
    databaseRenames: z
      .array(
        z
          .object({
            suffix: z.enum(["", "-wal", "-shm"]),
            device: z.string(),
            inode: z.string(),
            mode: z.number().int(),
          })
          .strict(),
      )
      .default([]),
    socketBindings: z
      .array(
        z
          .object({
            path: z.string(),
            sourcePath: z.string(),
            device: z.string(),
            inode: z.string(),
            uid: z.number().int(),
            gid: z.number().int(),
            mode: z.number().int(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

type RootJob = z.infer<typeof jobSchema>;

export async function assertOmnyoStateRootRollbackSelected(input: {
  jobDir: string;
  sourceDataDir: string;
  destinationDataDir: string;
  artifactDigest: string;
}): Promise<void> {
  const job = jobSchema.parse(
    JSON.parse(
      await readFile(join(input.jobDir, "root-adoption.json"), "utf8"),
    ),
  );

  if (
    job.phase !== "rollback-selected" ||
    job.sourceDataDir !== input.sourceDataDir ||
    job.destinationDataDir !== input.destinationDataDir ||
    job.artifactDigest !== input.artifactDigest ||
    job.destinationDigest === null ||
    readOmnyoStateAdmission({
      journalPath: join(input.jobDir, "write-admission.json"),
      binding: {
        migrationId: job.migrationId,
        sourceDataDir: job.sourceDataDir,
        destinationDataDir: job.destinationDataDir,
        artifactDigest: job.artifactDigest,
        sourceDigest: job.sourceDigest,
        destinationDigest: job.destinationDigest,
      },
    }).admission !== 2
  )
    throw new Error("Omnyo root rollback has not durably restored its owner");
  const path = join(input.sourceDataDir, "config.json");

  if (job.configPresent) {
    const info = await lstat(path);

    if (
      info.isSymbolicLink() ||
      !info.isFile() ||
      (info.mode & 0o777) !== job.configMode ||
      (await fileDigest(path)) !== job.configDigest ||
      (await fileDigest(join(input.jobDir, "source-config.json"))) !==
        job.configDigest
    )
      throw new Error("Omnyo rollback source configuration is not restored");
  } else if ((await optionalInfo(path)) !== null)
    throw new Error(
      "Omnyo rollback did not restore absent source configuration",
    );
}

const heldFenceSchema = z
  .object({
    version: z.literal(1),
    request: identityAdoptionControlRequestSchemaV1,
    acquisitionSha256: digest,
    acquisitionKind: z.enum([
      "original-held-stop-v1",
      "disconnected-stopped-owner-v1",
    ]),
    configPresent: z.boolean(),
    configMode: z.number().int().nonnegative(),
    configDigest: digest.nullable(),
  })
  .strict();

function heldFenceInput(
  request: IdentityAdoptionControlRequestV1,
): OmnyoStateRootInput {
  return {
    migrationId: request.id,
    ownerId: request.ownerId,
    serverHostId: request.serverHostId,
    sourceDataDir: request.binding.sourceDataDir,
    destinationDataDir: request.binding.destinationDataDir,
    jobDir: request.binding.jobDir,
    artifactDigest: request.binding.runtimeSha256,
    expectedSourceDigest: "0".repeat(64),
  };
}

async function readHeldFence(input: OmnyoStateRootInput) {
  const path = join(input.jobDir, "held-source-fence-v1.json");
  const info = await optionalInfo(path);

  if (info === null) return null;

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Held source fence checkpoint ownership differs");

  const checkpoint = heldFenceSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );

  const bound = heldFenceInput(checkpoint.request);

  for (const key of [
    "migrationId",
    "ownerId",
    "serverHostId",
    "sourceDataDir",
    "destinationDataDir",
    "jobDir",
    "artifactDigest",
  ] as const)
    if (input[key] !== bound[key])
      throw new Error("Held source fence belongs to another identity owner");
  const backupPath = join(input.jobDir, "source-config.json");
  const backupInfo = await optionalInfo(backupPath);

  if (
    checkpoint.configPresent &&
    (backupInfo === null ||
      !backupInfo.isFile() ||
      backupInfo.isSymbolicLink() ||
      backupInfo.uid !== process.getuid?.() ||
      (backupInfo.mode & 0o777) !== checkpoint.configMode ||
      (await fileDigest(backupPath)) !== checkpoint.configDigest)
  )
    throw new Error("Held source original configuration backup changed");

  if (!checkpoint.configPresent && backupInfo !== null)
    throw new Error(
      "Held source has an unexpected original configuration backup",
    );
  const configPath = join(input.sourceDataDir, "config.json");

  const current = (await optionalInfo(configPath))
    ? await readConfig(configPath)
    : { raw: {} };

  const { stateMigration: _migration, ...raw } = z
    .record(z.string(), z.unknown())
    .parse(current.raw);

  const original = checkpoint.configPresent
    ? JSON.parse(await readFile(backupPath, "utf8"))
    : {};

  if (JSON.stringify(raw) !== JSON.stringify(original))
    throw new Error("Held source configuration changed outside its fence");

  const acquisitionPath = join(
    input.jobDir,
    "legacy-worker-stop-acquired-v1.json",
  );

  const acquisitionInfo = await optionalInfo(acquisitionPath);

  if (
    acquisitionInfo === null ||
    !acquisitionInfo.isFile() ||
    acquisitionInfo.isSymbolicLink() ||
    acquisitionInfo.uid !== process.getuid?.() ||
    (acquisitionInfo.mode & 0o077) !== 0 ||
    (await fileDigest(acquisitionPath)) !== checkpoint.acquisitionSha256
  )
    throw new Error("Held source acquisition receipt changed");

  return checkpoint;
}

export async function assertHeldIdentitySourceFenceV1(
  value: IdentityAdoptionControlRequestV1,
): Promise<z.infer<typeof heldFenceSchema>> {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);
  const input = heldFenceInput(request);
  assertInput(input);
  const checkpoint = await readHeldFence(input);

  if (
    checkpoint === null ||
    JSON.stringify(checkpoint.request) !== JSON.stringify(request)
  )
    throw new Error("Held identity source checkpoint is missing or changed");
  const current = await readConfig(join(input.sourceDataDir, "config.json"));

  const expected = {
    journalPath: join(input.jobDir, "write-admission.json"),
    binding: binding(input, "0".repeat(64)),
  };

  if (
    JSON.stringify(current.parsed.stateMigration) !== JSON.stringify(expected)
  )
    throw new Error("Held identity source sentinel differs");

  const original = checkpoint.configPresent
    ? z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(
            await readFile(join(input.jobDir, "source-config.json"), "utf8"),
          ),
        )
    : {};

  const { stateMigration: _stateMigration, ...raw } = current.raw;

  if (JSON.stringify(raw) !== JSON.stringify(original))
    throw new Error("Held source configuration changed outside its fence");

  return checkpoint;
}

async function assertDisconnectedStopAcquisitionV1(
  request: IdentityAdoptionControlRequestV1,
  path: string,
  rawAcquisition: unknown,
): Promise<void> {
  const jobDir = request.binding.jobDir;

  for (const file of [
    path,
    join(jobDir, "legacy-worker-stop-request-v1.json"),
  ]) {
    const info = await lstat(file);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error(
        "Disconnected stop receipt and request must be privately owned",
      );
  }

  const acquired = z
    .object({
      formatVersion: z.literal(1),
      acquisitionKind: z.literal("disconnected-stopped-owner-v1"),
      requestSha256: digest,
      finalBinding: identityAdoptionBindingSchema,
      coordinatorProtocolVersion: z.number().int(),
      acquisition: z
        .object({
          hostId: z.string(),
          runtimeVersion: legacyInstalledRuntimeVersionV1Schema,
          protocolVersion: z.literal(252),
          connected: z.literal(false),
          admission: z.object({
            held: z.literal(false),
            holdOwner: z.null(),
            activity: z.record(z.string(), z.number().int().nonnegative()),
            directProbe: z.literal(false),
            activation: z.literal(false),
            blockers: z.tuple([]),
          }),
        })
        .nullable(),
      stop: z.object({
        witness: z.enum(["live", "stopped"]),
        serviceUnloaded: z.literal(true),
        pidsExited: z.literal(true),
        listenerAbsent: z.literal(true),
        runtimeOwnersStopped: z.literal(true),
      }),
    })
    .strict()
    .parse(rawAcquisition);

  const rawRequest: unknown = JSON.parse(
    await readFile(join(jobDir, "legacy-worker-stop-request-v1.json"), "utf8"),
  );

  const stopRequest = z
    .object({
      formatVersion: z.literal(1),
      stopKind: z.literal("disconnected-v1"),
      hostId: z.string(),
      migrationId: z.string(),
      baselineIdentity: runtimeIdentitySchema,
      finalBinding: identityAdoptionBindingSchema,
      coordinatorProtocolVersion: z.number().int(),
    })
    .parse(rawRequest);

  const activity =
    acquired.acquisition === null
      ? null
      : Object.values(acquired.acquisition.admission.activity);

  if (
    createHash("sha256").update(JSON.stringify(rawRequest)).digest("hex") !==
      acquired.requestSha256 ||
    JSON.stringify(acquired.finalBinding) !== JSON.stringify(request.binding) ||
    JSON.stringify(stopRequest.finalBinding) !==
      JSON.stringify(request.binding) ||
    stopRequest.hostId !== request.serverHostId ||
    request.id !== stopRequest.migrationId ||
    request.ownerId !== `disconnected-stop:${stopRequest.migrationId}` ||
    acquired.coordinatorProtocolVersion === 252 ||
    acquired.coordinatorProtocolVersion !==
      stopRequest.coordinatorProtocolVersion ||
    (acquired.stop.witness === "live") !== (acquired.acquisition !== null) ||
    (acquired.acquisition !== null &&
      (acquired.acquisition.hostId !== request.serverHostId ||
        acquired.acquisition.runtimeVersion !==
          stopRequest.baselineIdentity.runtimeVersion ||
        activity === null ||
        activity.length === 0 ||
        activity.some((count) => count !== 0)))
  )
    throw new Error(
      "Disconnected stop receipt belongs to another worker, owner or artifact",
    );
}

export async function prepareHeldIdentitySourceFenceV1(
  value: IdentityAdoptionControlRequestV1,
  owners: { attestHeld: () => Promise<void> },
): Promise<z.infer<typeof heldFenceSchema>> {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);
  const input = heldFenceInput(request);
  assertInput(input);

  if (request.binding.ownerKind !== "worker")
    throw new Error(
      "Pre-stop identity fencing requires its worker update owner",
    );
  const job = await lstat(input.jobDir);

  if (
    !job.isDirectory() ||
    job.isSymbolicLink() ||
    job.uid !== process.getuid?.() ||
    (job.mode & 0o077) !== 0 ||
    (await realpath(input.jobDir)) !== input.jobDir
  )
    throw new Error(
      "Pre-stop identity fence requires its protected existing job",
    );

  return withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      await owners.attestHeld();
      const hold = readMaintenanceHold(input.sourceDataDir);

      if (
        hold?.kind !== "desktop-update" ||
        hold.phase !== "held" ||
        hold.id !== request.id ||
        hold.ownerId !== request.ownerId ||
        hold.serverHostId !== request.serverHostId ||
        hold.artifact?.runtimeSha256 !== request.binding.runtimeSha256 ||
        hold.artifact.archiveSha256 !== request.binding.archiveSha256 ||
        (await fileDigest(
          join(input.sourceDataDir, "server-maintenance-hold.json"),
        )) !== request.expectedHoldSha256
      )
        throw new Error(
          "Pre-stop identity fencing lost its genuine held worker",
        );

      const identity = await verifyWorkerRuntimeIdentity(
        request.binding.runtimeRoot,
        await readRuntimeIdentity(request.binding.runtimeRoot),
      );

      if (identity.runtimeSha256 !== request.binding.runtimeSha256)
        throw new Error("Pre-stop identity artifact binding changed");

      const stopAcquisitionPath = join(
        input.jobDir,
        "legacy-worker-stop-acquired-v1.json",
      );

      const bridgeAcquisitionPath = join(
        input.jobDir,
        "legacy-worker-bridge-acquired-v1.json",
      );

      const stopExists = await optionalInfo(stopAcquisitionPath);

      if ((await optionalInfo(bridgeAcquisitionPath)) !== null)
        throw new Error(
          "Retired NPM bridge acquisition cannot fence the source",
        );
      let acquisitionPath: string;

      let acquisitionKind:
        | "original-held-stop-v1"
        | "disconnected-stopped-owner-v1";

      const rawAcquisition: unknown =
        stopExists === null
          ? null
          : JSON.parse(await readFile(stopAcquisitionPath, "utf8"));

      if (
        stopExists !== null &&
        z
          .object({ acquisitionKind: z.unknown() })
          .partial()
          .parse(rawAcquisition).acquisitionKind ===
          "disconnected-stopped-owner-v1"
      ) {
        await assertDisconnectedStopAcquisitionV1(
          request,
          stopAcquisitionPath,
          rawAcquisition,
        );
        acquisitionPath = stopAcquisitionPath;
        acquisitionKind = "disconnected-stopped-owner-v1";
      } else if (stopExists !== null) {
        if (
          !stopExists.isFile() ||
          stopExists.isSymbolicLink() ||
          stopExists.uid !== process.getuid?.() ||
          (stopExists.mode & 0o077) !== 0
        )
          throw new Error("Original held-stop receipt is not privately owned");

        const acquired = z
          .object({
            formatVersion: z.literal(1),
            requestSha256: digest,
            finalBinding: identityAdoptionBindingSchema,
            acquisition: z.object({
              managementVersion: z.literal(1),
              hostId: z.string(),
              instanceId: z.string(),
              runtimeVersion: legacyInstalledRuntimeVersionV1Schema,
              protocolVersion: z.literal(252),
              connected: z.literal(true),
              automaticUpdates: z.boolean(),
              admission: z.object({
                held: z.literal(true),
                holdOwner: z.string(),
                activity: z.record(z.string(), z.number().int().nonnegative()),
                directProbe: z.literal(false),
                activation: z.literal(false),
                blockers: z.array(z.literal("update_held")),
              }),
              pluginBlockers: z.tuple([]),
              update: z.object({
                phase: z.enum(["idle", "current", "disabled"]),
                target: z
                  .object({
                    version: z.string(),
                    protocolVersion: z.number().int(),
                    artifactDigest: digest,
                  })
                  .nullable(),
              }),
            }),
          })
          .strict()
          .parse(rawAcquisition);

        const stopRequestPath = join(
          input.jobDir,
          "legacy-worker-stop-request-v1.json",
        );

        const stopRequestInfo = await lstat(stopRequestPath);

        if (
          !stopRequestInfo.isFile() ||
          stopRequestInfo.isSymbolicLink() ||
          stopRequestInfo.uid !== process.getuid?.() ||
          (stopRequestInfo.mode & 0o077) !== 0
        )
          throw new Error("Original held-stop request is not privately owned");
        const rawRequest = JSON.parse(await readFile(stopRequestPath, "utf8"));

        const stopRequest = z
          .object({
            formatVersion: z.literal(1),
            hostId: z.string(),
            instanceId: z.string(),
            baselineIdentity: runtimeIdentitySchema,
            finalBinding: identityAdoptionBindingSchema,
          })
          .parse(rawRequest);

        if (
          createHash("sha256")
            .update(JSON.stringify(rawRequest))
            .digest("hex") !== acquired.requestSha256 ||
          JSON.stringify(acquired.finalBinding) !==
            JSON.stringify(request.binding) ||
          JSON.stringify(stopRequest.finalBinding) !==
            JSON.stringify(request.binding) ||
          acquired.acquisition.runtimeVersion !==
            stopRequest.baselineIdentity.runtimeVersion ||
          acquired.acquisition.hostId !== request.serverHostId ||
          stopRequest.hostId !== request.serverHostId ||
          stopRequest.instanceId !== acquired.acquisition.instanceId ||
          acquired.acquisition.admission.holdOwner !== request.ownerId ||
          request.ownerId !==
            `self-update:${acquired.acquisition.instanceId}` ||
          Object.keys(acquired.acquisition.admission.activity).length === 0 ||
          Object.values(acquired.acquisition.admission.activity).some(
            (count) => count !== 0,
          )
        )
          throw new Error(
            "Original held-stop receipt belongs to another worker or artifact",
          );
        acquisitionPath = stopAcquisitionPath;
        acquisitionKind = "original-held-stop-v1";
      } else {
        throw new Error(
          "The original held-stop acquisition is required before source fencing",
        );
      }

      const checkpointPath = join(input.jobDir, "held-source-fence-v1.json");

      if (await optionalInfo(checkpointPath)) {
        const checkpoint = await readHeldFence(input);

        if (
          checkpoint === null ||
          JSON.stringify(checkpoint.request) !== JSON.stringify(request)
        )
          throw new Error("Pre-stop checkpoint binding changed");

        const current = await optionalInfo(
          join(input.sourceDataDir, "config.json"),
        );

        const parsed = current
          ? await readConfig(join(input.sourceDataDir, "config.json"))
          : { raw: {}, parsed: {} };

        if (
          !("stateMigration" in parsed.parsed) ||
          parsed.parsed.stateMigration === undefined
        ) {
          const original = checkpoint.configPresent
            ? JSON.parse(
                await readFile(
                  join(input.jobDir, "source-config.json"),
                  "utf8",
                ),
              )
            : {};

          if (JSON.stringify(parsed.raw) !== JSON.stringify(original))
            throw new Error("Pre-stop source changed before its fence");
          await writeFence(
            input,
            input.sourceDataDir,
            "0".repeat(64),
            checkpoint.configMode,
          );
        }

        const asserted = await assertHeldIdentitySourceFenceV1(request);
        await owners.attestHeld();

        return asserted;
      }

      const configPath = join(input.sourceDataDir, "config.json");
      const config = await optionalInfo(configPath);

      if (config && (config.isSymbolicLink() || !config.isFile()))
        throw new Error("Pre-stop configuration is not an ordinary owned file");
      const raw = config ? await readFile(configPath, "utf8") : null;

      if (
        raw !== null &&
        parseAppManagedConfig(JSON.parse(raw)).stateMigration !== undefined
      )
        throw new Error("A source migration already owns this configuration");
      const backup = join(input.jobDir, "source-config.json");

      if (await optionalInfo(backup))
        throw new Error("Pre-stop original configuration backup collision");

      if (raw !== null)
        await writeTextFileAtomically(
          backup,
          raw,
          true,
          config ? config.mode & 0o777 : 0o600,
        );

      const checkpoint = {
        version: 1 as const,
        request,
        acquisitionSha256: await fileDigest(acquisitionPath),
        acquisitionKind,
        configPresent: raw !== null,
        configMode: config ? config.mode & 0o777 : 0o600,
        configDigest:
          raw === null ? null : createHash("sha256").update(raw).digest("hex"),
      };

      await writeJsonFileAtomically(checkpointPath, checkpoint, true);
      await writeFence(
        input,
        input.sourceDataDir,
        "0".repeat(64),
        checkpoint.configMode,
      );
      await owners.attestHeld();

      return assertHeldIdentitySourceFenceV1(request);
    },
  });
}

export interface OmnyoStateRootInput {
  migrationId: string;
  ownerId: string;
  serverHostId: string;
  sourceDataDir: string;
  destinationDataDir: string;
  jobDir: string;
  artifactDigest: string;
  expectedSourceDigest: string;
  digestAlgorithm?: "legacy-tree-v1" | "state-tree-v2";
  databaseVerification?: "inline-v1" | "release-producer-v1";
}

export interface OmnyoStagedStateRoot extends OmnyoStateRootInput {
  dataDir: string;
  databasePath: string;
  databaseState: "present" | "absent-worker";
}

interface StateRootDatabase {
  prepare(statement: string): { get(): unknown };
  close(): void;
}

interface StateRootOwners {
  prepareDestination(stage: OmnyoStagedStateRoot): Promise<void>;
  openDatabase?: (path: string) => StateRootDatabase;
}

async function stagedDatabaseState(
  input: OmnyoStateRootInput,
  dataDir: string,
): Promise<OmnyoStagedStateRoot["databaseState"]> {
  if (
    (await optionalInfo(join(dataDir, "app.db"))) ||
    (dataDir === input.sourceDataDir &&
      (await optionalInfo(join(dataDir, "bb.db"))))
  )
    return "present";

  for (const name of [
    "bb.db",
    "bb.db-wal",
    "bb.db-shm",
    "app.db-wal",
    "app.db-shm",
  ])
    if (await optionalInfo(join(dataDir, name)))
      throw new Error(
        "Omnyo database state is incomplete; migration will not initialize an empty profile",
      );

  if (
    readMaintenanceHold(input.sourceDataDir)?.identityAdoption?.ownerKind !==
    "worker"
  )
    throw new Error(
      "Omnyo source database is missing; migration will not initialize an empty profile",
    );
  const binding = await assertPromotedIdentityHoldV1(input.sourceDataDir);

  if (
    binding.ownerKind !== "worker" ||
    binding.sourceDataDir !== input.sourceDataDir ||
    binding.destinationDataDir !== input.destinationDataDir ||
    binding.jobDir !== input.jobDir ||
    binding.runtimeSha256 !== input.artifactDigest
  )
    throw new Error(
      "Omnyo worker database absence belongs to another promoted owner",
    );

  return "absent-worker";
}

async function assertStageIdentity(path: string, job: RootJob): Promise<void> {
  const info = await lstat(path, { bigint: true });

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.dev.toString() !== job.stagingDevice ||
    info.ino.toString() !== job.stagingInode
  )
    throw new Error("Omnyo staging directory identity changed");
}

export async function assertOmnyoStagedStateRoot(
  stage: OmnyoStagedStateRoot,
): Promise<void> {
  assertInput(stage);

  if (
    stage.dataDir !== join(stage.jobDir, "root-staging") ||
    stage.databasePath !== join(stage.dataDir, "app.db")
  )
    throw new Error("Omnyo staged profile path differs from its owner");

  const job = jobSchema.parse(
    JSON.parse(
      await readFile(join(stage.jobDir, "root-adoption.json"), "utf8"),
    ),
  );

  sameJob(job, stage);

  if (job.phase !== "copied")
    throw new Error(
      "Omnyo staged profile is not owned by the local conversion phase",
    );
  await assertStoppedSource(stage);
  await assertStageIdentity(stage.dataDir, job);

  if (stage.databaseState !== (await stagedDatabaseState(stage, stage.dataDir)))
    throw new Error("Omnyo staged database ownership differs from its source");
  const source = await readConfig(join(stage.sourceDataDir, "config.json"));
  const destination = await readConfig(join(stage.dataDir, "config.json"));

  if (
    source.parsed.stateMigration === undefined ||
    JSON.stringify(source.parsed.stateMigration) !==
      JSON.stringify(destination.parsed.stateMigration)
  )
    throw new Error(
      "Omnyo staged startup fence differs from the stopped source",
    );
  await assertSourceFence(
    stage,
    source.parsed.stateMigration.binding.destinationDigest,
  );

  if (
    stage.digestAlgorithm !== "state-tree-v2" &&
    (await inspectOmnyoStateRoot(stage.sourceDataDir)).digest !==
      stage.expectedSourceDigest
  )
    throw new Error("Omnyo source changed before local conversion");

  if (await optionalInfo(source.parsed.stateMigration.journalPath)) {
    assertOmnyoStateAdmissionPrepared(source.parsed.stateMigration);

    if (readOmnyoStateAdmission(source.parsed.stateMigration).admission !== 0)
      throw new Error(
        "Omnyo write admission already opened; use forward repair",
      );
  }
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);

  return (
    suffix === "" ||
    (suffix !== ".." &&
      !suffix.startsWith("../") &&
      !suffix.startsWith("..\\") &&
      !isAbsolute(suffix))
  );
}

async function optionalInfo(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function canonicalJson(value: unknown, root = false): string {
  if (Array.isArray(value))
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;

  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([key]) => !root || key !== "stateMigration")
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;

  return JSON.stringify(value);
}

async function fileDigest(path: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

export class OmnyoStateWorkPendingError extends Error {
  constructor(
    readonly progress: {
      phase:
        | "source-kinds"
        | "source-digest"
        | "clone"
        | "clone-verification"
        | "acl"
        | "database-verification"
        | "destination-seal"
        | "source-verification";
      entries: number;
      bytes: number;
    },
  ) {
    super("Omnyo state work checkpointed; continue the same owned operation");
  }
}

export async function preflightOmnyoStateRootKindsV1(input: {
  sourceDataDir: string;
  jobDir: string;
}) {
  await mkdir(input.jobDir, { recursive: true, mode: 0o700 });

  const result = await inspectOmnyoStateTreeKindsV1(input.sourceDataDir, {
    checkpointPath: join(input.jobDir, "source-kinds-preflight-v1.json"),
  });

  if (!result.complete)
    throw new OmnyoStateWorkPendingError({
      phase: "source-kinds",
      entries: result.phaseEntries,
      bytes: result.phaseBytes,
    });

  if (result.unsupportedCount !== 0)
    throw new Error(
      "Omnyo source contains an unbound filesystem kind; original owner must remain running",
    );

  return {
    metadataDigest: result.metadataDigest,
    counts: result.counts,
    socketCount: result.socketBindings.length,
  };
}

type RootDigestRole =
  | "source-digest"
  | "clone-verification"
  | "destination-seal"
  | "staging-publication"
  | "source-verification"
  | "rollback-source"
  | "rollback-destination";

async function configDigestBinding(
  dataDir: string,
): Promise<OmnyoStateTreeConfigDigestV1> {
  const path = join(dataDir, "config.json");
  const observed = await optionalInfo(path);

  if (observed === null) return { kind: "absent" };
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);

  try {
    const before = await file.stat({ bigint: true });

    if (
      !before.isFile() ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.nlink !== 1n ||
      before.size > 1_048_576n
    )
      throw new Error(
        "Omnyo configuration is not a bounded owned ordinary file",
      );
    const value: unknown = JSON.parse(await file.readFile("utf8"));
    parseAppManagedConfig(value);
    const after = await file.stat({ bigint: true });
    const pathname = await lstat(path, { bigint: true });

    for (const key of [
      "dev",
      "ino",
      "uid",
      "gid",
      "mode",
      "size",
      "mtimeNs",
      "ctimeNs",
      "nlink",
    ] as const)
      if (before[key] !== after[key] || before[key] !== pathname[key])
        throw new Error("Omnyo configuration changed during fingerprinting");
    const normalized = canonicalJson(value, true);

    return {
      kind: "normalized",
      sha256:
        normalized === "{}"
          ? null
          : createHash("sha256").update(normalized).digest("hex"),
      binding: {
        device: before.dev.toString(),
        inode: before.ino.toString(),
        uid: Number(before.uid),
        gid: Number(before.gid),
        mode: Number(before.mode & 0o7777n),
        size: Number(before.size),
        mtimeNs: before.mtimeNs.toString(),
        ctimeNs: before.ctimeNs.toString(),
        nlink: Number(before.nlink),
      },
    };
  } finally {
    await file.close();
  }
}

export async function inspectOmnyoStateRootForAdoptionV2(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
  dataDir: string,
  options: {
    role: RootDigestRole;
    durable?: boolean;
    socketBindings?: OmnyoStateSocketBindingV1[];
  },
): Promise<{ digest: string; files: number; bytes: number }> {
  assertPaths(input);

  if (
    dataDir !== input.sourceDataDir &&
    dataDir !== input.destinationDataDir &&
    dataDir !== join(input.jobDir, "root-staging")
  )
    throw new Error("Omnyo fingerprint root differs from its adoption owner");
  await mkdir(input.jobDir, { recursive: true, mode: 0o700 });

  const result = await inspectOmnyoStateTreeDigestV1(dataDir, {
    checkpointPath: join(input.jobDir, `root-${options.role}-v2.json`),
    config: await configDigestBinding(dataDir),
    durable: options.durable ?? false,
    ...(dataDir === input.sourceDataDir
      ? {}
      : {
          socketBridgeSource: {
            root: input.sourceDataDir,
            bindings: options.socketBindings ?? [],
          },
        }),
  });

  if (!result.complete)
    throw new OmnyoStateWorkPendingError({
      phase:
        options.role === "rollback-source"
          ? "source-verification"
          : options.role === "rollback-destination" ||
              options.role === "staging-publication"
            ? "destination-seal"
            : options.role,
      entries: result.phaseEntries,
      bytes: result.bytesHashed,
    });

  if (result.digest === null)
    throw new Error("Omnyo fingerprint completed without a digest");

  return { digest: result.digest, files: result.files, bytes: result.bytes };
}

async function inspectAdoptionRoot(
  input: OmnyoStateRootInput,
  dataDir: string,
  role: RootDigestRole,
  options: {
    durable?: boolean;
    socketBindings?: OmnyoStateSocketBindingV1[];
  } = {},
) {
  return input.digestAlgorithm === "state-tree-v2"
    ? inspectOmnyoStateRootForAdoptionV2(input, dataDir, { role, ...options })
    : inspectOmnyoStateRoot(dataDir, {
        socketBridgeSourceDataDir:
          dataDir === input.sourceDataDir ? undefined : input.sourceDataDir,
      });
}

export async function readOmnyoStateRootJobBindingV2(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
) {
  assertPaths(input);
  const path = join(input.jobDir, "root-adoption.json");
  const info = await optionalInfo(path);

  if (info === null) return null;

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Omnyo root journal is not privately owned");
  const job = jobSchema.parse(JSON.parse(await readFile(path, "utf8")));
  sameJobBinding(job, input);

  return {
    sourceDigest: job.sourceDigest,
    digestAlgorithm: job.digestAlgorithm,
    databaseVerification: job.databaseVerification,
    phase: job.phase,
    destinationDigest: job.destinationDigest,
  };
}

export async function inspectOmnyoStateRoot(
  dataDir: string,
  options: { socketBridgeSourceDataDir?: string } = {},
): Promise<{ digest: string; files: number; bytes: number }> {
  const root = resolve(dataDir);
  const info = await lstat(root);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(root)) !== root ||
    process.getuid === undefined ||
    info.uid !== process.getuid()
  )
    throw new Error("Omnyo root migration requires an exact owned directory");
  const records: string[] = [];
  let files = 0;
  let bytes = 0;

  const visit = async (path: string, prefix: string) => {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name, "en"),
    )) {
      const child = join(path, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = await lstat(child);

      if (stat.uid !== info.uid)
        throw new Error("Omnyo root migration refuses foreign-owned state");

      if (entry.isSymbolicLink()) {
        const target = await readlink(child);

        const sourceSocket =
          options.socketBridgeSourceDataDir === undefined
            ? null
            : join(options.socketBridgeSourceDataDir, key);

        if (
          sourceSocket !== null &&
          isOmnyoStateSocketPathV1(key) &&
          target === sourceSocket
        ) {
          const original = await lstat(sourceSocket);

          if (!original.isSocket() || original.uid !== info.uid)
            throw new Error("Omnyo socket bridge lost its original IPC owner");
          records.push(
            `socket:${key}:${original.uid}:${original.gid}:${original.mode & 0o777}`,
          );
        } else records.push(`link:${key}:${target}`);
      } else if (entry.isDirectory()) {
        records.push(`directory:${key}:${stat.mode & 0o777}`);
        await visit(child, key);
      } else if (entry.isFile()) {
        let hash: string;

        if (key === "config.json") {
          const value: unknown = JSON.parse(await readFile(child, "utf8"));
          parseAppManagedConfig(value);
          const normalized = canonicalJson(value, true);

          if (normalized === "{}") continue;
          hash = createHash("sha256").update(normalized).digest("hex");
        } else hash = await fileDigest(child);
        records.push(`file:${key}:${stat.mode & 0o777}:${hash}`);
        files++;
        bytes += stat.size;
      } else if (stat.isSocket() && isOmnyoStateSocketPathV1(key)) {
        records.push(
          `socket:${key}:${stat.uid}:${stat.gid}:${stat.mode & 0o777}`,
        );
      } else
        throw new Error(
          "Omnyo root migration refuses an unbound IPC socket or special file",
        );
    }
  };

  await visit(root, "");

  return {
    digest: createHash("sha256").update(records.join("\n")).digest("hex"),
    files,
    bytes,
  };
}

async function assertStoppedSource(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
): Promise<void> {
  const hold = readMaintenanceHold(input.sourceDataDir);

  if (
    hold === null ||
    hold.kind !== "migration" ||
    hold.phase !== "held" ||
    hold.id !== input.migrationId ||
    hold.ownerId !== input.ownerId ||
    hold.serverHostId !== input.serverHostId ||
    hold.artifact?.runtimeSha256 !== input.artifactDigest
  )
    throw new Error(
      "Omnyo root migration requires its exact existing held migration owner",
    );

  if (
    (await readFile(join(input.sourceDataDir, "host-id"), "utf8")).trim() !==
    input.serverHostId
  )
    throw new Error("Omnyo root migration host identity differs");

  await assertStoppedIdentityRuntimeOwnersV1(input.sourceDataDir);
  await assertLegacyAppUpdateOwnerStoppedV1(input.sourceDataDir);
}

function binding(
  input: OmnyoStateRootInput,
  destinationDigest: string,
): OmnyoStateBinding {
  return {
    migrationId: input.migrationId,
    sourceDataDir: input.sourceDataDir,
    destinationDataDir: input.destinationDataDir,
    sourceDigest: input.expectedSourceDigest,
    destinationDigest,
    artifactDigest: input.artifactDigest,
  };
}

async function readConfig(path: string) {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));

  return {
    parsed: parseAppManagedConfig(value),
    raw: z.record(z.string(), z.unknown()).parse(value),
  };
}

async function writeFence(
  input: OmnyoStateRootInput,
  dataDir: string,
  destinationDigest: string,
  mode: number,
): Promise<void> {
  const path = join(dataDir, "config.json");

  const current = (await optionalInfo(path))
    ? await readConfig(path)
    : { parsed: {}, raw: {} };

  if (
    "stateMigration" in current.parsed &&
    current.parsed.stateMigration !== undefined
  ) {
    const prior = current.parsed.stateMigration.binding;

    if (
      current.parsed.stateMigration.journalPath !==
        join(input.jobDir, "write-admission.json") ||
      prior.migrationId !== input.migrationId ||
      prior.sourceDataDir !== input.sourceDataDir ||
      prior.destinationDataDir !== input.destinationDataDir ||
      (prior.sourceDigest !== input.expectedSourceDigest &&
        !(
          prior.sourceDigest === "0".repeat(64) && (await readHeldFence(input))
        )) ||
      prior.artifactDigest !== input.artifactDigest
    )
      throw new Error(
        "A foreign state migration fence already owns this profile",
      );
  }

  await writeJsonFileAtomically(
    path,
    {
      ...current.raw,
      stateMigration: {
        journalPath: join(input.jobDir, "write-admission.json"),
        binding: binding(input, destinationDigest),
      },
    },
    false,
    mode,
  );
}

async function syncPublication(input: OmnyoStateRootInput): Promise<void> {
  for (const path of [input.jobDir, dirname(input.destinationDataDir)]) {
    const directory = await open(path, "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

async function syncStagedTree(path: string): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);

    if (entry.isDirectory()) await syncStagedTree(child);
    else if (entry.isFile()) {
      const file = await open(child, "r");

      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  }

  const directory = await open(path, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function databaseProofBinding(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
  sourceDigest: string | null,
) {
  return {
    migrationId: input.migrationId,
    ownerId: input.ownerId,
    serverHostId: input.serverHostId,
    sourceDataDir: input.sourceDataDir,
    destinationDataDir: input.destinationDataDir,
    jobDir: input.jobDir,
    artifactDigest: input.artifactDigest,
    sourceDigest,
    digestAlgorithm: input.digestAlgorithm ?? "legacy-tree-v1",
    databaseVerification: "release-producer-v1" as const,
  };
}

function databaseProofResult(
  proof: DatabaseVerificationProofV2,
  proofSha256: string,
) {
  return {
    version: 2 as const,
    verified: true as const,
    capacityOnly: proof.kind === "capacity",
    migrationId: proof.binding.migrationId,
    artifactDigest: proof.binding.artifactDigest,
    durationMs: proof.durationMs,
    databaseBytes: proof.files.database.size,
    proofSha256,
  };
}

async function assertDatabaseJobOwner(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
) {
  assertPaths(input);
  const info = await lstat(input.jobDir);

  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(input.jobDir)) !== input.jobDir
  )
    throw new Error(
      "Omnyo database producer requires its existing private job owner",
    );

  if (input.databaseVerification !== "release-producer-v1")
    throw new Error(
      "Omnyo database verification is not selected through its release producer",
    );
}

async function readVerifiedDatabaseProof(
  input: OmnyoStateRootInput,
  job: RootJob,
) {
  const record = await readDatabaseVerificationProofV2(
    join(input.jobDir, "database-verification-v2.json"),
  );

  if (record === null) return null;
  const stage = join(input.jobDir, "root-staging");
  await assertStageIdentity(stage, job);

  const [root, files] = await Promise.all([
    inspectDatabaseRootIdentityV2(stage),
    inspectDatabaseFilesV2(stage, "app.db"),
  ]);

  if (
    record.proof.kind !== "staged" ||
    !isDeepStrictEqual(
      record.proof.binding,
      databaseProofBinding(input, input.expectedSourceDigest),
    ) ||
    !isDeepStrictEqual(record.proof.root, root) ||
    !isDeepStrictEqual(record.proof.files, files)
  )
    throw new Error("Omnyo verified database proof or physical files changed");

  return record;
}

async function requireVerifiedDatabaseProof(
  input: OmnyoStateRootInput,
  job: RootJob,
) {
  const proof = await readVerifiedDatabaseProof(input, job);

  if (proof === null)
    throw new Error("Omnyo database release verification is missing");

  return proof;
}

export async function verifyOmnyoStateRootDatabaseV2(
  input: OmnyoStateRootInput,
  owners: { openReadonlyDatabase(path: string): ReadonlyStateRootDatabaseV2 },
) {
  assertInput(input);
  await assertDatabaseJobOwner(input);

  return withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      const job = jobSchema.parse(
        JSON.parse(
          await readFile(join(input.jobDir, "root-adoption.json"), "utf8"),
        ),
      );

      sameJob(job, input);

      if (job.phase !== "converted" && job.phase !== "database-verified")
        throw new Error(
          "Omnyo database producer requires its converted, unpublished profile",
        );
      await assertStoppedSource(input);
      await assertUnpublishedPathsAbsent(input);
      const stage = join(input.jobDir, "root-staging");
      await assertStageIdentity(stage, job);
      await assertSourceFence(input, "0".repeat(64));
      const stagedConfig = await readConfig(join(stage, "config.json"));

      const originalConfig = await readConfig(
        join(input.sourceDataDir, "config.json"),
      );

      if (
        !isDeepStrictEqual(
          stagedConfig.parsed.stateMigration,
          originalConfig.parsed.stateMigration,
        )
      )
        throw new Error("Omnyo database producer staging fence differs");
      const existing = await readVerifiedDatabaseProof(input, job);

      if (existing !== null)
        return databaseProofResult(existing.proof, existing.sha256);
      const before = await inspectDatabaseFilesV2(stage, "app.db");

      const durationMs = verifyDatabaseReadonlyV2(
        join(stage, "app.db"),
        owners.openReadonlyDatabase,
      );

      const after = await inspectDatabaseFilesV2(stage, "app.db");

      if (
        !isDeepStrictEqual(before.database, after.database) ||
        (before.wal !== null &&
          before.wal.size > 0 &&
          !isDeepStrictEqual(before.wal, after.wal)) ||
        ((before.wal === null || before.wal.size === 0) &&
          after.wal !== null &&
          after.wal.size > 0)
      )
        throw new Error(
          "Omnyo database data changed during readonly verification",
        );
      await assertStoppedSource(input);
      await assertUnpublishedPathsAbsent(input);

      const proof = databaseVerificationProofV2Schema.parse({
        version: 2,
        kind: "staged",
        binding: databaseProofBinding(input, input.expectedSourceDigest),
        root: await inspectDatabaseRootIdentityV2(stage),
        files: after,
        integrity: "ok",
        foreignKeys: "ok",
        durationMs,
      });

      await writeJsonFileAtomically(
        join(input.jobDir, "database-verification-v2.json"),
        proof,
        true,
      );
      const saved = await requireVerifiedDatabaseProof(input, job);

      return databaseProofResult(saved.proof, saved.sha256);
    },
  });
}

export async function verifyOmnyoSourceDatabaseCapacityV2(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
  owners: { openReadonlyDatabase(path: string): ReadonlyStateRootDatabaseV2 },
) {
  await assertDatabaseJobOwner(input);

  return withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      for (const name of [
        "root-adoption.json",
        "root-staging",
        "write-admission.json",
        "held-source-fence-v1.json",
        "source-stopped-preflight-v2.json",
        "root-source-digest-v2.json",
      ])
        if ((await optionalInfo(join(input.jobDir, name))) !== null)
          throw new Error(
            "Omnyo source capacity must complete before fencing or staging",
          );

      if ((await optionalInfo(input.destinationDataDir)) !== null)
        throw new Error(
          "Omnyo source capacity refuses an existing destination",
        );

      const config = await optionalInfo(
        join(input.sourceDataDir, "config.json"),
      );

      if (
        config !== null &&
        (await readConfig(join(input.sourceDataDir, "config.json"))).parsed
          .stateMigration !== undefined
      )
        throw new Error("Omnyo source capacity refuses a fenced configuration");
      const hold = readMaintenanceHold(input.sourceDataDir);

      if (
        hold !== null &&
        hold.phase !== "released" &&
        (hold.kind !== "desktop-update" ||
          hold.phase !== "held" ||
          hold.id !== input.migrationId ||
          hold.ownerId !== input.ownerId ||
          hold.serverHostId !== input.serverHostId)
      )
        throw new Error(
          "Omnyo source capacity refuses a promoted or foreign hold",
        );

      if (
        (
          await readFile(join(input.sourceDataDir, "host-id"), "utf8")
        ).trim() !== input.serverHostId
      )
        throw new Error("Omnyo source capacity machine identity differs");
      const root = await inspectDatabaseRootIdentityV2(input.sourceDataDir);
      const files = await inspectDatabaseFilesV2(input.sourceDataDir, "bb.db");
      const path = join(input.jobDir, "database-capacity-v2.json");
      const existing = await readDatabaseVerificationProofV2(path);

      if (existing !== null) {
        if (
          existing.proof.kind !== "capacity" ||
          !isDeepStrictEqual(
            existing.proof.binding,
            databaseProofBinding(input, null),
          ) ||
          !isDeepStrictEqual(existing.proof.root, root) ||
          ["device", "inode", "uid", "gid", "mode", "nlink"].some((key) => {
            const field = z
              .enum(["device", "inode", "uid", "gid", "mode", "nlink"])
              .parse(key);

            return (
              existing.proof.files.database[field] !== files.database[field]
            );
          })
        )
          throw new Error(
            "Omnyo source capacity receipt belongs to another owner",
          );

        return databaseProofResult(existing.proof, existing.sha256);
      }

      const durationMs = verifyDatabaseReadonlyV2(
        join(input.sourceDataDir, "bb.db"),
        owners.openReadonlyDatabase,
      );

      const after = await inspectDatabaseFilesV2(input.sourceDataDir, "bb.db");

      if (
        !isDeepStrictEqual(
          await inspectDatabaseRootIdentityV2(input.sourceDataDir),
          root,
        ) ||
        after.database.device !== files.database.device ||
        after.database.inode !== files.database.inode
      )
        throw new Error(
          "Omnyo source database identity changed during capacity verification",
        );

      const proof = databaseVerificationProofV2Schema.parse({
        version: 2,
        kind: "capacity",
        binding: databaseProofBinding(input, null),
        root,
        files: after,
        integrity: "ok",
        foreignKeys: "ok",
        durationMs,
      });

      await writeJsonFileAtomically(path, proof, true);
      const saved = await readDatabaseVerificationProofV2(path);

      if (saved === null)
        throw new Error("Omnyo source capacity proof was not persisted");

      return databaseProofResult(saved.proof, saved.sha256);
    },
  });
}

async function publishSealedRoot(
  input: OmnyoStateRootInput,
  job: RootJob,
): Promise<OmnyoStateBinding> {
  if (job.phase !== "sealed" || job.destinationDigest === null)
    throw new Error("Omnyo profile is not durably sealed for publication");
  const stageDir = join(input.jobDir, "root-staging");
  await assertStageIdentity(stageDir, job);

  if (await optionalInfo(input.destinationDataDir))
    throw new Error("Omnyo destination collision before sealed publication");

  if (job.databaseVerification === "release-producer-v1")
    await requireVerifiedDatabaseProof(input, job);

  if (
    input.digestAlgorithm !== "state-tree-v2" &&
    ((await inspectOmnyoStateRoot(input.sourceDataDir)).digest !==
      input.expectedSourceDigest ||
      (
        await inspectOmnyoStateRoot(stageDir, {
          socketBridgeSourceDataDir: input.sourceDataDir,
        })
      ).digest !== job.destinationDigest)
  )
    throw new Error("Omnyo sealed profile or stopped source changed");

  if (
    input.digestAlgorithm === "state-tree-v2" &&
    (
      await inspectAdoptionRoot(input, stageDir, "destination-seal", {
        durable: true,
        socketBindings: job.socketBindings,
      })
    ).digest !== job.destinationDigest
  )
    throw new Error(
      "Omnyo sealed profile changed before admission preparation",
    );
  await validateOmnyoSocketBridgesV1(
    input.sourceDataDir,
    stageDir,
    job.socketBindings,
  );

  const request = {
    journalPath: join(input.jobDir, "write-admission.json"),
    binding: binding(input, job.destinationDigest),
  };

  const initial = { ...request, binding: binding(input, "0".repeat(64)) };

  for (const root of [input.sourceDataDir, stageDir]) {
    const config = await readConfig(join(root, "config.json"));
    const fence = JSON.stringify(config.parsed.stateMigration);

    if (fence !== JSON.stringify(initial) && fence !== JSON.stringify(request))
      throw new Error("Omnyo sealed profile startup fence changed");
  }

  await prepareOmnyoStateAdmission(request);

  if (readOmnyoStateAdmission(request).admission !== 0)
    throw new Error("Omnyo sealed admission changed; use forward repair");
  await writeFence(input, stageDir, job.destinationDigest, job.configMode);
  await writeFence(
    input,
    input.sourceDataDir,
    job.destinationDigest,
    job.configMode,
  );
  await writeJsonFileAtomically(join(input.jobDir, "root-adoption.json"), {
    ...job,
    phase: "verified",
  });
  await rename(stageDir, input.destinationDataDir);
  await syncPublication(input);

  return request.binding;
}

async function assertSourceFence(
  input: OmnyoStateRootInput,
  destinationDigest: string,
): Promise<void> {
  const config = await readConfig(join(input.sourceDataDir, "config.json"));

  const expected = {
    journalPath: join(input.jobDir, "write-admission.json"),
    binding: binding(input, destinationDigest),
  };

  if (JSON.stringify(config.parsed.stateMigration) !== JSON.stringify(expected))
    throw new Error("Omnyo source fence changed; refusing resume");
}

function assertInput(input: OmnyoStateRootInput): void {
  assertPaths(input);
  digest.parse(input.expectedSourceDigest);
}

function assertPaths(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
): void {
  if (process.platform !== "darwin")
    throw new Error(
      "Omnyo stopped-root clone requires the verified Mac state owner; another OS needs its native copy and permission proof",
    );
  digest.parse(input.artifactDigest);

  for (const path of [
    input.sourceDataDir,
    input.destinationDataDir,
    input.jobDir,
  ])
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("Omnyo migration paths must be exact absolute paths");

  for (const [left, right] of [
    [input.sourceDataDir, input.destinationDataDir],
    [input.sourceDataDir, input.jobDir],
    [input.destinationDataDir, input.jobDir],
  ])
    if (inside(left, right) || inside(right, left))
      throw new Error(
        "Omnyo migration roots and protected job must be separate",
      );
}

function sameJob(job: RootJob, input: OmnyoStateRootInput): void {
  sameJobBinding(job, input);

  if (job.sourceDigest !== input.expectedSourceDigest)
    throw new Error("Omnyo root migration source digest differs");
}

function sameJobBinding(
  job: RootJob,
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
): void {
  for (const key of [
    "migrationId",
    "ownerId",
    "serverHostId",
    "sourceDataDir",
    "destinationDataDir",
    "artifactDigest",
  ] as const)
    if (job[key] !== input[key])
      throw new Error("Omnyo root migration journal binding differs");

  if (job.digestAlgorithm !== (input.digestAlgorithm ?? "legacy-tree-v1"))
    throw new Error("Omnyo root migration digest algorithm differs");

  if (job.databaseVerification !== (input.databaseVerification ?? "inline-v1"))
    throw new Error("Omnyo root migration database verification owner differs");
}

export async function stageOmnyoStateRoot(
  input: OmnyoStateRootInput,
  owners: StateRootOwners,
): Promise<OmnyoStateBinding> {
  return stageOmnyoStateRootImpl(input, owners, false);
}

export async function stageOmnyoStateRootFromOwnerV2(
  input: Omit<OmnyoStateRootInput, "expectedSourceDigest">,
  owners: StateRootOwners,
): Promise<OmnyoStateBinding> {
  if (input.digestAlgorithm !== "state-tree-v2")
    throw new Error(
      "Omnyo v2 source owner requires its declared digest algorithm",
    );
  assertPaths(input);
  await assertStoppedSource(input);
  const job = await readOmnyoStateRootJobBindingV2(input);

  const sourceDigest =
    job?.sourceDigest ??
    (
      await inspectOmnyoStateRootForAdoptionV2(input, input.sourceDataDir, {
        role: "source-digest",
      })
    ).digest;

  return stageOmnyoStateRootImpl(
    { ...input, expectedSourceDigest: sourceDigest },
    owners,
    job === null,
  );
}

async function stageOmnyoStateRootImpl(
  input: OmnyoStateRootInput,
  owners: StateRootOwners,
  freshSourceVerified: boolean,
): Promise<OmnyoStateBinding> {
  assertInput(input);
  await mkdir(input.jobDir, { recursive: true, mode: 0o700 });
  const jobInfo = await lstat(input.jobDir);
  const destinationParent = await realpath(dirname(input.destinationDataDir));

  if (
    (await realpath(input.jobDir)) !== input.jobDir ||
    destinationParent !== dirname(input.destinationDataDir) ||
    jobInfo.uid !== process.getuid?.() ||
    jobInfo.dev !== (await lstat(input.sourceDataDir)).dev ||
    jobInfo.dev !== (await lstat(destinationParent)).dev
  )
    throw new Error("Omnyo staging requires exact same-volume owned paths");

  return withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      await assertStoppedSource(input);
      await stagedDatabaseState(input, input.sourceDataDir);

      for (const marker of [
        SERVER_IMPORT_FILE_NAME,
        SERVER_IMPORT_JOURNAL_FILE_NAME,
        SERVER_MOVED_FILE_NAME,
      ])
        if (await optionalInfo(join(input.sourceDataDir, marker)))
          throw new Error(
            "An existing server-move owner must resolve its markers before Omnyo adoption",
          );
      const jobPath = join(input.jobDir, "root-adoption.json");
      const stageDir = join(input.jobDir, "root-staging");
      const preStop = await readHeldFence(input);
      let job: RootJob;

      if (await optionalInfo(jobPath)) {
        job = jobSchema.parse(JSON.parse(await readFile(jobPath, "utf8")));
        sameJob(job, input);
      } else {
        if (
          (await optionalInfo(input.destinationDataDir)) ||
          (await optionalInfo(stageDir))
        )
          throw new Error(
            "Omnyo profile collision: destination or staging already exists",
          );

        if (
          !freshSourceVerified &&
          (
            await inspectAdoptionRoot(
              input,
              input.sourceDataDir,
              "source-digest",
            )
          ).digest !== input.expectedSourceDigest
        )
          throw new Error("Omnyo source changed before staging");

        const config = await optionalInfo(
          join(input.sourceDataDir, "config.json"),
        );

        const backupPath = join(input.jobDir, "source-config.json");
        const backupInfo = await optionalInfo(backupPath);

        if (
          backupInfo &&
          preStop === null &&
          (config === null ||
            !backupInfo.isFile() ||
            backupInfo.isSymbolicLink() ||
            backupInfo.uid !== process.getuid?.() ||
            (await fileDigest(backupPath)) !==
              (await fileDigest(join(input.sourceDataDir, "config.json"))))
        )
          throw new Error("Omnyo original configuration backup collision");

        if (config && preStop === null) {
          if (backupInfo === null)
            await copyFile(
              join(input.sourceDataDir, "config.json"),
              backupPath,
              constants.COPYFILE_EXCL,
            );

          const backup = await open(backupPath, "r");

          try {
            await backup.sync();
          } finally {
            await backup.close();
          }
        }

        job = {
          version: 1,
          migrationId: input.migrationId,
          ownerId: input.ownerId,
          serverHostId: input.serverHostId,
          sourceDataDir: input.sourceDataDir,
          destinationDataDir: input.destinationDataDir,
          artifactDigest: input.artifactDigest,
          sourceDigest: input.expectedSourceDigest,
          digestAlgorithm: input.digestAlgorithm ?? "legacy-tree-v1",
          databaseVerification: input.databaseVerification ?? "inline-v1",
          phase: "prepared",
          configPresent: preStop?.configPresent ?? config !== null,
          configMode:
            preStop?.configMode ?? (config ? config.mode & 0o777 : 0o600),
          configDigest:
            preStop !== null
              ? preStop.configDigest
              : config
                ? await fileDigest(join(input.sourceDataDir, "config.json"))
                : null,
          destinationDigest: null,
          stagingDevice: null,
          stagingInode: null,
          stagingCreationIntent: false,
          databaseRenames: [],
          socketBindings: [],
        };
        await writeJsonFileAtomically(jobPath, job, true);

        if (input.digestAlgorithm === "state-tree-v2")
          throw new OmnyoStateWorkPendingError({
            phase: "clone",
            entries: 0,
            bytes: 0,
          });
      }

      if (
        job.phase === "rollback-selected" ||
        job.phase === "aborting-before-admission" ||
        job.phase === "aborted-before-admission"
      )
        throw new Error("Omnyo root rollback already selected");

      if (job.phase === "verified") {
        const request = {
          journalPath: join(input.jobDir, "write-admission.json"),
          binding: binding(input, job.destinationDigest ?? ""),
        };

        assertOmnyoStateAdmissionPrepared(request);
        await assertSourceFence(input, request.binding.destinationDigest);

        if (
          input.digestAlgorithm !== "state-tree-v2" &&
          (await inspectOmnyoStateRoot(input.sourceDataDir)).digest !==
            input.expectedSourceDigest
        )
          throw new Error(
            "Omnyo stopped source changed before publication reconciliation",
          );

        if (!(await optionalInfo(input.destinationDataDir))) {
          await assertStageIdentity(stageDir, job);

          if (
            (
              await inspectAdoptionRoot(
                input,
                stageDir,
                "staging-publication",
                { socketBindings: job.socketBindings },
              )
            ).digest !== job.destinationDigest
          )
            throw new Error(
              "Omnyo verified staging changed before destination publication",
            );
          const stagedConfig = await readConfig(join(stageDir, "config.json"));

          if (
            JSON.stringify(stagedConfig.parsed.stateMigration) !==
            JSON.stringify(request)
          )
            throw new Error("Omnyo verified staging binding changed");
          await rename(stageDir, input.destinationDataDir);
          await assertStageIdentity(input.destinationDataDir, job);
          await syncPublication(input);

          return request.binding;
        }

        await assertStageIdentity(input.destinationDataDir, job);

        if (
          readOmnyoStateAdmission(request).admission === 0 &&
          (
            await inspectAdoptionRoot(
              input,
              input.destinationDataDir,
              "rollback-destination",
              { socketBindings: job.socketBindings },
            )
          ).digest !== job.destinationDigest
        )
          throw new Error("Omnyo destination changed before write admission");

        const config = await readConfig(
          join(input.destinationDataDir, "config.json"),
        );

        if (
          JSON.stringify(config.parsed.stateMigration) !==
          JSON.stringify(request)
        )
          throw new Error("Omnyo destination binding changed");

        await syncPublication(input);

        return request.binding;
      }

      if (job.phase === "sealed") return publishSealedRoot(input, job);

      if (job.phase === "prepared") {
        await writeFence(
          input,
          input.sourceDataDir,
          "0".repeat(64),
          job.configMode,
        );
        job = { ...job, phase: "fenced" };
        await writeJsonFileAtomically(jobPath, job);
      }

      const sourceFence = await readConfig(
        join(input.sourceDataDir, "config.json"),
      );

      const currentDestinationDigest =
        sourceFence.parsed.stateMigration?.binding.destinationDigest;

      if (currentDestinationDigest === undefined)
        throw new Error("Omnyo source fence is missing");
      await assertSourceFence(input, currentDestinationDigest);

      if (
        input.digestAlgorithm !== "state-tree-v2" &&
        (await inspectOmnyoStateRoot(input.sourceDataDir)).digest !==
          input.expectedSourceDigest
      )
        throw new Error("Omnyo source changed while fenced");

      if (job.phase === "fenced") {
        if (await optionalInfo(input.destinationDataDir))
          throw new Error("Omnyo destination collision before staging");

        if (job.stagingDevice === null || job.stagingInode === null) {
          if (!job.stagingCreationIntent) {
            if ((await optionalInfo(stageDir)) !== null)
              throw new Error(
                "Omnyo staging creation collides with an unbound root",
              );
            job = { ...job, stagingCreationIntent: true };
            await writeJsonFileAtomically(jobPath, job);
          }

          const existing = await optionalInfo(stageDir);

          if (existing === null) await mkdir(stageDir, { mode: 0o700 });
          else if (
            !existing.isDirectory() ||
            existing.isSymbolicLink() ||
            existing.uid !== process.getuid?.() ||
            (existing.mode & 0o777) !== 0o700 ||
            (await realpath(stageDir)) !== stageDir ||
            (await readdir(stageDir)).length !== 0
          )
            throw new Error(
              "Omnyo interrupted staging creation is not an empty owned root",
            );
          const staging = await lstat(stageDir, { bigint: true });
          job = {
            ...job,
            stagingDevice: staging.dev.toString(),
            stagingInode: staging.ino.toString(),
          };
          await writeJsonFileAtomically(jobPath, job);
        } else await assertStageIdentity(stageDir, job);

        const copiedTree = await copyOmnyoStateTreeV1(
          input.sourceDataDir,
          stageDir,
          {
            checkpointPath: join(input.jobDir, "root-tree-copy-v1.json"),
          },
        );

        if (!copiedTree.complete)
          throw new OmnyoStateWorkPendingError({
            phase: "clone",
            entries: copiedTree.phaseEntries,
            bytes: copiedTree.phaseBytes,
          });
        job = {
          ...job,
          socketBindings: copiedTree.socketBindings,
          phase: "cloned",
        };
        await writeJsonFileAtomically(jobPath, job);

        if (input.digestAlgorithm === "state-tree-v2")
          throw new OmnyoStateWorkPendingError({
            phase: "clone-verification",
            entries: copiedTree.phaseEntries,
            bytes: copiedTree.phaseBytes,
          });
      }

      if (job.phase === "cloned") {
        await assertStageIdentity(stageDir, job);
        await validateOmnyoSocketBridgesV1(
          input.sourceDataDir,
          stageDir,
          job.socketBindings,
        );

        if (
          (
            await inspectAdoptionRoot(input, stageDir, "clone-verification", {
              socketBindings: job.socketBindings,
            })
          ).digest !== input.expectedSourceDigest
        )
          throw new Error("Omnyo stopped-root clone differs from source");
        job = { ...job, phase: "clone-verified" };
        await writeJsonFileAtomically(jobPath, job);

        if (input.digestAlgorithm === "state-tree-v2")
          throw new OmnyoStateWorkPendingError({
            phase: "acl",
            entries: 0,
            bytes: 0,
          });
      }

      if (job.phase === "clone-verified") {
        await assertStageIdentity(stageDir, job);

        const aclCopy = await copyMacStateAclTreeV1(
          input.sourceDataDir,
          stageDir,
          {
            checkpointPath: join(input.jobDir, "root-acl-copy-v1.json"),
            socketBindings: job.socketBindings,
          },
        );

        if (!aclCopy.complete)
          throw new OmnyoStateWorkPendingError({
            phase: "acl",
            entries: aclCopy.entriesVerified,
            bytes: 0,
          });
        job = { ...job, phase: "acl-verified" };
        await writeJsonFileAtomically(jobPath, job);

        if (input.digestAlgorithm === "state-tree-v2")
          throw new OmnyoStateWorkPendingError({
            phase: "clone-verification",
            entries: aclCopy.entriesVerified,
            bytes: 0,
          });
      }

      if (job.phase === "acl-verified") {
        const databaseRenames: RootJob["databaseRenames"] = [];

        for (const suffix of ["", "-wal", "-shm"]) {
          const oldPath = join(stageDir, `bb.db${suffix}`);
          const old = await optionalInfo(oldPath);

          if (old === null) continue;

          if (
            !old.isFile() ||
            old.isSymbolicLink() ||
            old.uid !== process.getuid?.()
          )
            throw new Error(
              "Omnyo database rename requires an owned ordinary file",
            );

          if (await optionalInfo(join(stageDir, `app.db${suffix}`)))
            throw new Error("Omnyo staged database filename collision");
          const info = await lstat(oldPath, { bigint: true });
          databaseRenames.push({
            suffix: z.enum(["", "-wal", "-shm"]).parse(suffix),
            device: info.dev.toString(),
            inode: info.ino.toString(),
            mode: Number(info.mode),
          });
        }

        job = { ...job, phase: "renaming-database", databaseRenames };
        await writeJsonFileAtomically(jobPath, job);
      }

      if (job.phase === "renaming-database") {
        await assertStageIdentity(stageDir, job);

        for (const selected of job.databaseRenames) {
          const oldPath = join(stageDir, `bb.db${selected.suffix}`);
          const nextPath = join(stageDir, `app.db${selected.suffix}`);
          const old = await optionalInfo(oldPath);
          const next = await optionalInfo(nextPath);

          if ((old === null) === (next === null))
            throw new Error("Omnyo database rename has an ambiguous owner");

          const info = await lstat(old === null ? nextPath : oldPath, {
            bigint: true,
          });

          if (
            !info.isFile() ||
            info.uid !== BigInt(process.getuid?.() ?? -1) ||
            info.dev.toString() !== selected.device ||
            info.ino.toString() !== selected.inode ||
            Number(info.mode) !== selected.mode
          )
            throw new Error("Omnyo database rename identity changed");

          if (old !== null) await rename(oldPath, nextPath);
        }

        const copied = await lstat(stageDir, { bigint: true });
        job = {
          ...job,
          phase: "copied",
          stagingDevice: copied.dev.toString(),
          stagingInode: copied.ino.toString(),
        };
        await writeJsonFileAtomically(jobPath, job);

        if (input.digestAlgorithm === "state-tree-v2")
          throw new OmnyoStateWorkPendingError({
            phase: "destination-seal",
            entries: 0,
            bytes: 0,
          });
      }

      if (await optionalInfo(stageDir)) {
        const stage = {
          ...input,
          dataDir: stageDir,
          databasePath: join(stageDir, "app.db"),
          databaseState: await stagedDatabaseState(input, stageDir),
        };

        if (
          stage.databaseState === "present" &&
          owners.openDatabase === undefined
        )
          throw new Error(
            "Omnyo database conversion requires its existing database owner",
          );

        if (job.phase === "copied") {
          await assertOmnyoStagedStateRoot(stage);
          await adoptLegacyAppUpdateFilesV1({
            migrationId: input.migrationId,
            sourceDataDir: input.sourceDataDir,
            destinationDataDir: input.destinationDataDir,
            dataDir: stage.dataDir,
            jobDir: input.jobDir,
            artifactDigest: input.artifactDigest,
            sourceDigest: input.expectedSourceDigest,
          });
          await owners.prepareDestination(stage);

          if (stage.databaseState === "absent-worker") {
            if (await optionalInfo(stage.databasePath))
              throw new Error(
                "Omnyo worker conversion unexpectedly created a database",
              );
          }

          job = { ...job, phase: "converted" };
          await writeJsonFileAtomically(jobPath, job);

          if (input.digestAlgorithm === "state-tree-v2")
            throw new OmnyoStateWorkPendingError({
              phase: "destination-seal",
              entries: 0,
              bytes: 0,
            });
        }

        if (job.phase === "converted") {
          if (stage.databaseState === "present") {
            if (job.databaseVerification === "release-producer-v1") {
              if ((await readVerifiedDatabaseProof(input, job)) === null)
                throw new OmnyoStateWorkPendingError({
                  phase: "database-verification",
                  entries: 0,
                  bytes: 0,
                });
            } else {
              if (owners.openDatabase === undefined)
                throw new Error("Omnyo database owner is missing");
              const database = owners.openDatabase(stage.databasePath);

              try {
                assertDatabaseIntegrity(database);
              } finally {
                database.close();
              }
            }
          }

          job = { ...job, phase: "database-verified" };
          await writeJsonFileAtomically(jobPath, job);

          if (input.digestAlgorithm === "state-tree-v2")
            throw new OmnyoStateWorkPendingError({
              phase: "destination-seal",
              entries: 0,
              bytes: 0,
            });
        }

        if (job.phase === "database-verified") {
          if (job.databaseVerification === "release-producer-v1")
            await requireVerifiedDatabaseProof(input, job);

          const destinationDigest = (
            await inspectAdoptionRoot(input, stageDir, "destination-seal", {
              durable: true,
              socketBindings: job.socketBindings,
            })
          ).digest;

          if (input.digestAlgorithm !== "state-tree-v2")
            await syncStagedTree(stageDir);
          job = { ...job, destinationDigest, phase: "destination-sealed" };
          await writeJsonFileAtomically(jobPath, job);

          if (input.digestAlgorithm === "state-tree-v2")
            throw new OmnyoStateWorkPendingError({
              phase: "source-verification",
              entries: 0,
              bytes: 0,
            });
        }

        if (job.phase === "destination-sealed") {
          if (
            (
              await inspectAdoptionRoot(
                input,
                input.sourceDataDir,
                "source-verification",
              )
            ).digest !== input.expectedSourceDigest
          )
            throw new Error("Omnyo stopped source changed before publication");
          job = { ...job, phase: "sealed" };
          await writeJsonFileAtomically(jobPath, job);

          if (input.digestAlgorithm === "state-tree-v2")
            throw new OmnyoStateWorkPendingError({
              phase: "destination-seal",
              entries: 0,
              bytes: 0,
            });
        }

        return publishSealedRoot(input, job);
      }

      throw new Error(
        "Omnyo root staging outcome is uncertain; preserve the job for owner reconciliation",
      );
    },
  });
}

export async function rollBackOmnyoStateRoot(
  input: OmnyoStateRootInput,
): Promise<void> {
  assertInput(input);
  await withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      const jobPath = join(input.jobDir, "root-adoption.json");
      let job = jobSchema.parse(JSON.parse(await readFile(jobPath, "utf8")));
      sameJob(job, input);

      if (job.phase === "aborted-before-admission") {
        await assertUnpublishedPathsAbsent(input, true);
        await assertOriginalConfiguration(input, job);

        return;
      }

      if (
        (await optionalInfo(input.destinationDataDir)) === null &&
        (await optionalInfo(join(input.jobDir, "write-admission.json"))) ===
          null
      ) {
        await abortUnpublishedRoot(input, job);

        return;
      }

      if (job.destinationDigest === null)
        throw new Error("Unverified Omnyo admission requires owner recovery");
      await assertStoppedSource(input);

      const request = {
        journalPath: join(input.jobDir, "write-admission.json"),
        binding: binding(input, job.destinationDigest),
      };

      const admission = readOmnyoStateAdmission(request).admission;

      if (admission === 1)
        throw new Error("Omnyo writers were admitted; use forward repair");

      if (job.phase === "rollback-selected") {
        if (admission !== 2)
          throw new Error(
            "Omnyo rollback journal differs from its admission owner",
          );

        await assertOriginalConfiguration(input, job);

        return;
      }

      if (job.phase !== "rollback-source-verified") {
        if (
          (
            await inspectAdoptionRoot(
              input,
              input.sourceDataDir,
              "rollback-source",
            )
          ).digest !== input.expectedSourceDigest
        )
          throw new Error("Omnyo source changed; refusing stale rollback");

        if (input.digestAlgorithm === "state-tree-v2") {
          job = { ...job, phase: "rollback-source-verified" };
          await writeJsonFileAtomically(jobPath, job);
          throw new OmnyoStateWorkPendingError({
            phase: "destination-seal",
            entries: 0,
            bytes: 0,
          });
        }
      }

      if (
        (
          await inspectAdoptionRoot(
            input,
            input.destinationDataDir,
            "rollback-destination",
            { socketBindings: job.socketBindings },
          )
        ).digest !== job.destinationDigest
      )
        throw new Error("Omnyo destination changed; refusing stale rollback");

      if (admission === 0)
        await assertSourceFence(input, job.destinationDigest);

      if (
        job.configPresent &&
        (job.configDigest === null ||
          (await fileDigest(join(input.jobDir, "source-config.json"))) !==
            job.configDigest)
      )
        throw new Error("Omnyo original configuration backup changed");

      await selectOmnyoPreWriteRollback({
        journalPath: join(input.jobDir, "write-admission.json"),
        binding: binding(input, job.destinationDigest),
      });

      if (job.configPresent) {
        await writeTextFileAtomically(
          join(input.sourceDataDir, "config.json"),
          await readFile(join(input.jobDir, "source-config.json"), "utf8"),
          false,
          job.configMode,
        );
      } else
        await rm(join(input.sourceDataDir, "config.json"), { force: true });

      if (job.configPresent) {
        const config = await open(
          join(input.sourceDataDir, "config.json"),
          "r",
        );

        try {
          await config.sync();
        } finally {
          await config.close();
        }
      }

      const directory = await open(input.sourceDataDir, "r");

      try {
        await directory.sync();
      } finally {
        await directory.close();
      }

      await writeJsonFileAtomically(jobPath, {
        ...job,
        phase: "rollback-selected",
      });
    },
  });
}

async function assertUnpublishedPathsAbsent(
  input: OmnyoStateRootInput,
  includeStage = false,
) {
  const paths = [
    input.destinationDataDir,
    join(input.jobDir, "write-admission.json"),
  ];

  if (includeStage) paths.push(join(input.jobDir, "root-staging"));

  for (const path of paths)
    if ((await optionalInfo(path)) !== null)
      throw new Error(
        "Omnyo unadmitted recovery refuses a destination, staging or admission owner",
      );
}

async function assertOriginalConfiguration(
  input: OmnyoStateRootInput,
  job: Pick<RootJob, "configPresent" | "configMode" | "configDigest">,
) {
  const path = join(input.sourceDataDir, "config.json");
  const info = await optionalInfo(path);

  if (job.configPresent) {
    if (
      info === null ||
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== job.configMode ||
      (await fileDigest(path)) !== job.configDigest
    )
      throw new Error("Omnyo original configuration is not restored");
  } else if (info !== null)
    throw new Error("Omnyo original absent configuration is not restored");
}

async function restoreOriginalConfiguration(
  input: OmnyoStateRootInput,
  job: Pick<RootJob, "configPresent" | "configMode" | "configDigest">,
) {
  const path = join(input.sourceDataDir, "config.json");
  const backup = join(input.jobDir, "source-config.json");

  if (job.configPresent) {
    const info = await lstat(backup);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== job.configMode ||
      (await fileDigest(backup)) !== job.configDigest
    )
      throw new Error("Omnyo original configuration backup changed");
    await writeTextFileAtomically(
      path,
      await readFile(backup, "utf8"),
      false,
      job.configMode,
    );
  } else if ((await optionalInfo(path)) !== null) await unlink(path);
  await assertOriginalConfiguration(input, job);
  const directory = await open(input.sourceDataDir, "r");

  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const discardSchema = z
  .object({
    version: z.literal(1),
    migrationId: z.string(),
    ownerId: z.string(),
    sourceDigest: digest,
    device: z.string(),
    inode: z.string(),
    complete: z.boolean(),
    stack: z
      .array(
        z
          .object({ path: z.string(), device: z.string(), inode: z.string() })
          .strict(),
      )
      .max(256),
    removed: z.number().int().nonnegative(),
  })
  .strict();

async function discardUnadmittedStage(
  input: OmnyoStateRootInput,
  job: RootJob,
): Promise<void> {
  const stage = join(input.jobDir, "root-staging");
  const path = join(input.jobDir, "root-abort-discard-v1.json");
  let checkpoint: z.infer<typeof discardSchema>;

  if ((await optionalInfo(path)) !== null) {
    const info = await lstat(path);

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    )
      throw new Error("Omnyo stage disposal checkpoint is not privately owned");
    checkpoint = discardSchema.parse(JSON.parse(await readFile(path, "utf8")));

    if (
      checkpoint.migrationId !== input.migrationId ||
      checkpoint.ownerId !== input.ownerId ||
      checkpoint.sourceDigest !== input.expectedSourceDigest ||
      checkpoint.device !== job.stagingDevice ||
      checkpoint.inode !== job.stagingInode
    )
      throw new Error("Omnyo stage disposal belongs to another root");
  } else {
    if (job.stagingDevice === null || job.stagingInode === null) {
      if ((await optionalInfo(stage)) !== null)
        throw new Error("Omnyo unbound staging collision during recovery");

      return;
    }

    await assertStageIdentity(stage, job);
    checkpoint = {
      version: 1,
      migrationId: input.migrationId,
      ownerId: input.ownerId,
      sourceDigest: input.expectedSourceDigest,
      device: job.stagingDevice,
      inode: job.stagingInode,
      complete: false,
      removed: 0,
      stack: [
        { path: stage, device: job.stagingDevice, inode: job.stagingInode },
      ],
    };
    await writeJsonFileAtomically(path, checkpoint, true);
  }

  if (checkpoint.complete) {
    if ((await optionalInfo(stage)) !== null)
      throw new Error("Omnyo staging reappeared after owned disposal");

    return;
  }

  const started = Date.now();
  let mutations = 0;

  while (
    checkpoint.stack.length > 0 &&
    mutations < 2048 &&
    Date.now() - started < 8_000
  ) {
    const frame = checkpoint.stack.at(-1);

    if (frame === undefined)
      throw new Error("Omnyo stage disposal stack is missing");

    if (!inside(stage, frame.path))
      throw new Error("Omnyo stage disposal path escapes its owner");

    const info = await lstat(frame.path, { bigint: true }).catch(
      (error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) return null;
        throw error;
      },
    );

    if (info === null) {
      checkpoint.stack.pop();
      continue;
    }

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== BigInt(process.getuid?.() ?? -1) ||
      (await realpath(frame.path)) !== frame.path ||
      info.dev.toString() !== frame.device ||
      info.ino.toString() !== frame.inode
    )
      throw new Error("Omnyo stage disposal directory identity changed");
    const entries = await readdir(frame.path, { withFileTypes: true });

    if (entries.length > 65_536)
      throw new Error(
        "Omnyo stage disposal directory exceeds its proven bound",
      );

    if (entries.length === 0) {
      await rmdir(frame.path);
      checkpoint.stack.pop();
      mutations++;
      checkpoint.removed++;
      continue;
    }

    for (const entry of entries) {
      if (mutations >= 2048 || Date.now() - started >= 8_000) break;
      const child = join(frame.path, entry.name);
      const selected = await lstat(child, { bigint: true });

      if (
        selected.uid !== BigInt(process.getuid?.() ?? -1) ||
        selected.dev.toString() !== checkpoint.device
      )
        throw new Error("Omnyo stage disposal refuses a foreign entry");

      if (selected.isDirectory() && !selected.isSymbolicLink()) {
        if (checkpoint.stack.length >= 256)
          throw new Error(
            "Omnyo stage disposal exceeds its proven depth bound",
          );
        checkpoint.stack.push({
          path: child,
          device: selected.dev.toString(),
          inode: selected.ino.toString(),
        });
        break;
      }

      if (!selected.isFile() && !selected.isSymbolicLink())
        throw new Error(
          "Omnyo stage disposal refuses an unbound special entry",
        );
      await unlink(child);
      mutations++;
      checkpoint.removed++;
    }
  }

  checkpoint.complete = checkpoint.stack.length === 0;
  await writeJsonFileAtomically(path, checkpoint);

  if (!checkpoint.complete)
    throw new OmnyoStateWorkPendingError({
      phase: "clone",
      entries: checkpoint.removed,
      bytes: 0,
    });
}

async function abortUnpublishedRoot(
  input: OmnyoStateRootInput,
  job: RootJob,
): Promise<void> {
  if (
    ["verified", "rollback-selected", "rollback-source-verified"].includes(
      job.phase,
    )
  )
    throw new Error(
      "Omnyo admitted publication cannot use unadmitted recovery",
    );
  await assertUnpublishedPathsAbsent(input);
  await assertStoppedSource(input);

  if (
    job.stagingCreationIntent &&
    job.stagingDevice === null &&
    job.stagingInode === null
  ) {
    const stage = join(input.jobDir, "root-staging");
    const info = await optionalInfo(stage);

    if (info !== null) {
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700 ||
        (await realpath(stage)) !== stage ||
        (await readdir(stage)).length !== 0
      )
        throw new Error(
          "Omnyo interrupted staging creation is not an empty owned root",
        );
      const identity = await lstat(stage, { bigint: true });
      job = {
        ...job,
        stagingDevice: identity.dev.toString(),
        stagingInode: identity.ino.toString(),
      };
      await writeJsonFileAtomically(
        join(input.jobDir, "root-adoption.json"),
        job,
      );
    }
  }

  if (job.phase !== "aborting-before-admission") {
    if (
      (await inspectAdoptionRoot(input, input.sourceDataDir, "rollback-source"))
        .digest !== input.expectedSourceDigest
    )
      throw new Error("Omnyo unadmitted recovery source changed");
    const sourceConfigPath = join(input.sourceDataDir, "config.json");

    const source =
      (await optionalInfo(sourceConfigPath)) === null
        ? { parsed: { stateMigration: undefined } }
        : await readConfig(sourceConfigPath);

    if (source.parsed.stateMigration !== undefined)
      await assertSourceFence(
        input,
        source.parsed.stateMigration.binding.destinationDigest,
      );
    else if (job.phase !== "prepared")
      throw new Error("Omnyo unadmitted source fence is missing");
    job = { ...job, phase: "aborting-before-admission" };
    await writeJsonFileAtomically(
      join(input.jobDir, "root-adoption.json"),
      job,
    );

    if (input.digestAlgorithm === "state-tree-v2")
      throw new OmnyoStateWorkPendingError({
        phase: "clone",
        entries: 0,
        bytes: 0,
      });
  }

  const sourceConfigPath = join(input.sourceDataDir, "config.json");

  const source =
    (await optionalInfo(sourceConfigPath)) === null
      ? { parsed: { stateMigration: undefined } }
      : await readConfig(sourceConfigPath);

  if (source.parsed.stateMigration !== undefined)
    await assertSourceFence(
      input,
      source.parsed.stateMigration.binding.destinationDigest,
    );
  else await assertOriginalConfiguration(input, job);
  await restoreOriginalConfiguration(input, job);
  await discardUnadmittedStage(input, job);
  await assertUnpublishedPathsAbsent(input, true);
  await writeJsonFileAtomically(join(input.jobDir, "root-adoption.json"), {
    ...job,
    phase: "aborted-before-admission",
    destinationDigest: null,
    stagingDevice: null,
    stagingInode: null,
  });
}

export async function restoreUnstagedOmnyoSourceFenceV1(
  value: IdentityAdoptionControlRequestV1,
): Promise<void> {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);
  const input = heldFenceInput(request);
  assertInput(input);
  await withFileLock({
    path: join(input.jobDir, "root-adoption.lock"),
    timeoutMs: 5_000,
    work: async () => {
      await assertUnpublishedPathsAbsent(input, true);

      if (
        (await optionalInfo(join(input.jobDir, "root-adoption.json"))) !== null
      )
        throw new Error("Omnyo root journal requires its own rollback owner");
      await assertStoppedSource(input);
      const checkpoint = await readHeldFence(input);

      if (checkpoint === null) return;

      if (JSON.stringify(checkpoint.request) !== JSON.stringify(request))
        throw new Error("Omnyo unstaged fence recovery request differs");

      const current = await optionalInfo(
        join(input.sourceDataDir, "config.json"),
      );

      if (
        current !== null &&
        (await readConfig(join(input.sourceDataDir, "config.json"))).parsed
          .stateMigration !== undefined
      )
        await assertSourceFence(input, "0".repeat(64));
      else await assertOriginalConfiguration(input, checkpoint);
      await restoreOriginalConfiguration(input, checkpoint);
    },
  });
}

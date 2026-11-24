import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  identityAdoptionBindingSchema,
  maintenanceHoldSchema,
  type IdentityAdoptionBinding,
  type MaintenanceHold,
} from "@omnyo/domain";
import { withFileLock } from "@omnyo/config/file-lock";
import { formatAppRuntimeFilePath } from "@omnyo/config/app-runtime-file";
import { readConfiguredOmnyoStateAdmission } from "@omnyo/config/omnyo-state-startup";
import {
  readOmnyoStateAdmission,
  omnyoStateAdmissionSchema,
} from "@omnyo/config/omnyo-state-admission";
import { parseAppManagedConfig } from "@omnyo/config/managed-app-config";
import { z } from "zod";
import {
  readPrivateJsonFileText,
  writeJsonFileAtomically,
  writeTextFileAtomically,
} from "./json-file.js";
import {
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  verifyWorkerRuntimeIdentity,
} from "./runtime-identity.js";
import { readServerImportFile, readServerMovedFile } from "./markers.js";

export const SERVER_MAINTENANCE_HOLD_FILE_NAME = "server-maintenance-hold.json";

export function readMaintenanceHold(dataDir: string): MaintenanceHold | null {
  let bytes: string;

  try {
    bytes = readFileSync(
      join(dataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME),
      "utf8",
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }

  return maintenanceHoldSchema.parse(JSON.parse(bytes));
}

export async function writeMaintenanceHold(
  dataDir: string,
  hold: MaintenanceHold,
): Promise<void> {
  await writeJsonFileAtomically(
    join(dataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME),
    maintenanceHoldSchema.parse(hold),
  );
}

export interface PromoteIdentityHoldInput {
  id: string;
  ownerId: string;
  serverHostId: string;
  expectedHoldSha256: string;
  binding: IdentityAdoptionBinding;
}

const identityHoldReceiptSchema = z
  .object({
    version: z.literal(1),
    id: z.string(),
    ownerId: z.string(),
    serverHostId: z.string(),
    originalHoldText: z.string(),
    originalHoldMode: z.number().int().nonnegative(),
    originalHoldSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    binding: identityAdoptionBindingSchema,
  })
  .strict();

export async function assertPromotedIdentityHoldV1(
  dataDir: string,
): Promise<IdentityAdoptionBinding> {
  const hold = readMaintenanceHold(dataDir);

  if (
    hold === null ||
    hold.kind !== "migration" ||
    hold.phase !== "held" ||
    hold.identityAdoption === undefined
  )
    throw new Error(
      "Identity adoption requires its actual promoted source hold",
    );
  const binding = hold.identityAdoption;

  if (
    binding.sourceDataDir !== dataDir ||
    resolve(dataDir) !== dataDir ||
    hold.artifact?.runtimeSha256 !== binding.runtimeSha256 ||
    hold.artifact.archiveSha256 !== binding.archiveSha256
  )
    throw new Error(
      "Promoted identity hold source or artifact binding differs",
    );
  const path = join(binding.jobDir, "identity-hold-v1.json");
  const info = await lstat(path);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path
  )
    throw new Error(
      "Promoted identity hold receipt must be an exact ordinary file",
    );

  const receipt = identityHoldReceiptSchema.parse(
    JSON.parse(await readFile(path, "utf8")),
  );

  const original = maintenanceHoldSchema.parse(
    JSON.parse(receipt.originalHoldText),
  );

  if (
    receipt.id !== hold.id ||
    receipt.ownerId !== hold.ownerId ||
    receipt.serverHostId !== hold.serverHostId ||
    JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
    createHash("sha256").update(receipt.originalHoldText).digest("hex") !==
      receipt.originalHoldSha256 ||
    original.kind !== "desktop-update" ||
    original.phase !== "held" ||
    original.id !== hold.id ||
    original.ownerId !== hold.ownerId ||
    original.serverHostId !== hold.serverHostId ||
    (original.artifact !== null &&
      (original.artifact.runtimeSha256 !== binding.runtimeSha256 ||
        original.artifact.archiveSha256 !== binding.archiveSha256))
  )
    throw new Error(
      "Promoted identity hold receipt does not attest its original acquired owner",
    );

  const runtime = await (
    binding.ownerKind === "worker"
      ? verifyWorkerRuntimeIdentity
      : verifyRuntimeIdentity
  )(binding.runtimeRoot, await readRuntimeIdentity(binding.runtimeRoot));

  if (runtime.runtimeSha256 !== binding.runtimeSha256)
    throw new Error("Promoted identity hold runtime bytes changed");
  await assertStoppedIdentityRuntimeOwnersV1(dataDir);

  return binding;
}

export async function assertStoppedIdentityRuntimeOwnersV1(
  dataDir: string,
): Promise<void> {
  const lock = await lstat(join(dataDir, "daemon.lock.lock")).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    },
  );

  if (lock !== null)
    throw new Error("Stop the existing daemon owner before identity adoption");

  for (const path of new Set([
    formatAppRuntimeFilePath(dataDir),
    join(dataDir, "bb-app-runtime.json"),
  ])) {
    const raw = await readFile(path, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (raw === null) continue;

    const { pid } = z
      .object({
        pid: z.number().int().positive(),
        entryPath: z.string().min(1),
        surface: z.string().min(1),
        serverUrl: z.string().min(1),
        startedAt: z.string().min(1),
        version: z.string().min(1),
      })
      .parse(JSON.parse(raw));

    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH")
        continue;
      throw error;
    }

    throw new Error("Stop the existing runtime owner before identity adoption");
  }
}

export async function promoteDesktopUpdateHoldForIdentityV1(
  input: PromoteIdentityHoldInput,
): Promise<MaintenanceHold> {
  const binding = identityAdoptionBindingSchema.parse(input.binding);
  z.string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(input.expectedHoldSha256);

  for (const path of [
    binding.sourceDataDir,
    binding.destinationDataDir,
    binding.jobDir,
    binding.runtimeRoot,
  ])
    if (!isAbsolute(path) || resolve(path) !== path)
      throw new Error("Identity adoption requires exact absolute paths");

  const contains = (left: string, right: string) => {
    const path = relative(left, right);

    return (
      path === "" ||
      (!isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep))
    );
  };

  for (const [left, right] of [
    [binding.sourceDataDir, binding.destinationDataDir],
    [binding.sourceDataDir, binding.jobDir],
    [binding.destinationDataDir, binding.jobDir],
  ])
    if (contains(left, right) || contains(right, left))
      throw new Error("Identity adoption roots and job must be separate");

  for (const path of [binding.sourceDataDir, binding.runtimeRoot]) {
    const info = await lstat(path);

    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new Error("Identity adoption requires exact owned directories");
  }

  await mkdir(binding.jobDir, { recursive: true, mode: 0o700 });
  const job = await lstat(binding.jobDir);

  if (
    !job.isDirectory() ||
    job.isSymbolicLink() ||
    (await realpath(binding.jobDir)) !== binding.jobDir ||
    (process.getuid !== undefined && job.uid !== process.getuid())
  )
    throw new Error("Identity adoption job ownership differs");

  return withFileLock({
    path: join(binding.jobDir, "identity-hold-v1.lock"),
    timeoutMs: 1000,
    work: async () => {
      await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);

      if (
        (
          await readFile(join(binding.sourceDataDir, "host-id"), "utf8")
        ).trim() !== input.serverHostId ||
        (await readServerImportFile(binding.sourceDataDir)) !== null ||
        (await readServerMovedFile(binding.sourceDataDir)) !== null
      )
        throw new Error("Identity adoption source authority differs");

      const identity = await (
        binding.ownerKind === "worker"
          ? verifyWorkerRuntimeIdentity
          : verifyRuntimeIdentity
      )(binding.runtimeRoot, await readRuntimeIdentity(binding.runtimeRoot));

      if (identity.runtimeSha256 !== binding.runtimeSha256)
        throw new Error("Identity adoption runtime artifact differs");

      const holdPath = join(
        binding.sourceDataDir,
        SERVER_MAINTENANCE_HOLD_FILE_NAME,
      );

      const holdInfo = await lstat(holdPath);

      if (
        !holdInfo.isFile() ||
        holdInfo.isSymbolicLink() ||
        (await realpath(holdPath)) !== holdPath
      )
        throw new Error(
          "Identity adoption hold must be an exact ordinary file",
        );
      const text = await readFile(holdPath, "utf8");
      const hold = maintenanceHoldSchema.parse(JSON.parse(text));
      const path = join(binding.jobDir, "identity-hold-v1.json");

      const existing = await readFile(path, "utf8").then(
        (raw) => identityHoldReceiptSchema.parse(JSON.parse(raw)),
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
            return null;
          throw error;
        },
      );

      const original = existing?.originalHoldText ?? text;
      const sha = createHash("sha256").update(original).digest("hex");

      const expected = {
        version: 1,
        id: input.id,
        ownerId: input.ownerId,
        serverHostId: input.serverHostId,
        originalHoldText: original,
        originalHoldMode: existing?.originalHoldMode ?? holdInfo.mode & 0o777,
        originalHoldSha256: input.expectedHoldSha256,
        binding,
      };

      if (
        sha !== input.expectedHoldSha256 ||
        hold.id !== input.id ||
        hold.ownerId !== input.ownerId ||
        hold.serverHostId !== input.serverHostId ||
        hold.phase !== "held" ||
        (existing !== null &&
          JSON.stringify(existing) !== JSON.stringify(expected))
      )
        throw new Error("Identity adoption hold binding differs");

      const promoted: MaintenanceHold = {
        ...hold,
        kind: "migration",
        artifact: {
          archiveSha256: binding.archiveSha256,
          runtimeSha256: binding.runtimeSha256,
        },
        identityAdoption: binding,
      };

      if (hold.identityAdoption !== undefined) {
        if (
          JSON.stringify(hold) !== JSON.stringify(promoted) ||
          existing === null
        )
          throw new Error("Identity adoption promotion is ambiguous");

        return hold;
      }

      if (
        hold.kind !== "desktop-update" ||
        (hold.artifact !== null &&
          (hold.artifact.archiveSha256 !== binding.archiveSha256 ||
            hold.artifact.runtimeSha256 !== binding.runtimeSha256)) ||
        text !== original
      )
        throw new Error(
          "Identity adoption requires the actual stopped desktop-update hold",
        );

      if (existing === null)
        await writeJsonFileAtomically(path, expected, true);
      await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);

      if ((await readFile(holdPath, "utf8")) !== text)
        throw new Error("Identity adoption hold changed before promotion");
      await writeMaintenanceHold(binding.sourceDataDir, promoted);

      return promoted;
    },
  });
}

export function assertIdentityAdoptionHoldCanReleaseV1(
  dataDir: string,
  hold: MaintenanceHold,
): void {
  const binding = hold.identityAdoption;

  if (
    binding === undefined ||
    hold.kind !== "migration" ||
    hold.phase !== "held" ||
    binding.destinationDataDir !== dataDir ||
    binding.runtimeSha256 !== hold.artifact?.runtimeSha256
  )
    throw new Error("Identity adoption destination hold binding differs");
  const admission = readConfiguredOmnyoStateAdmission(dataDir);

  if (
    admission === undefined ||
    admission.journalPath !== join(binding.jobDir, "write-admission.json") ||
    admission.binding.sourceDataDir !== binding.sourceDataDir ||
    admission.binding.destinationDataDir !== binding.destinationDataDir ||
    admission.binding.artifactDigest !== binding.runtimeSha256 ||
    admission.binding.migrationId !== hold.id ||
    readOmnyoStateAdmission(admission).admission !== 1
  )
    throw new Error(
      "Identity adoption requires the admitted destination before maintenance release",
    );
}

export async function restoreIdentityHoldAfterRollbackV1(
  input: PromoteIdentityHoldInput,
): Promise<void> {
  const binding = identityAdoptionBindingSchema.parse(input.binding);
  await withFileLock({
    path: join(binding.jobDir, "identity-hold-v1.lock"),
    timeoutMs: 1000,
    work: async () => {
      await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);

      const receipt = identityHoldReceiptSchema.parse(
        JSON.parse(
          await readFile(join(binding.jobDir, "identity-hold-v1.json"), "utf8"),
        ),
      );

      if (
        receipt.id !== input.id ||
        receipt.ownerId !== input.ownerId ||
        receipt.serverHostId !== input.serverHostId ||
        receipt.originalHoldSha256 !== input.expectedHoldSha256 ||
        JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
        createHash("sha256").update(receipt.originalHoldText).digest("hex") !==
          input.expectedHoldSha256
      )
        throw new Error("Identity rollback original hold receipt differs");

      const raw: unknown = JSON.parse(
        await readFile(join(binding.jobDir, "write-admission.json"), "utf8"),
      );

      const journal = z
        .object({ binding: z.unknown() })
        .passthrough()
        .parse(raw);

      const request = omnyoStateAdmissionSchema.parse({
        journalPath: join(binding.jobDir, "write-admission.json"),
        binding: journal.binding,
      });

      const configRaw = await readFile(
        join(binding.sourceDataDir, "config.json"),
        "utf8",
      ).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });

      const config = parseAppManagedConfig(JSON.parse(configRaw ?? "{}"));

      if (
        config.stateMigration !== undefined ||
        request.binding.migrationId !== input.id ||
        request.binding.sourceDataDir !== binding.sourceDataDir ||
        request.binding.destinationDataDir !== binding.destinationDataDir ||
        request.binding.artifactDigest !== binding.runtimeSha256 ||
        readOmnyoStateAdmission(request).admission !== 2
      )
        throw new Error(
          "Identity rollback requires its actual selected pre-write rollback and restored source config",
        );

      const markerPath = join(
        binding.jobDir,
        binding.ownerKind === "coordinator" || process.platform !== "win32"
          ? "root-adoption.json"
          : "rollback-selected.json",
      );

      const marker: unknown = JSON.parse(await readFile(markerPath, "utf8"));

      if (binding.ownerKind === "coordinator" || process.platform !== "win32") {
        const selected = z
          .object({
            phase: z.literal("rollback-selected"),
            migrationId: z.string(),
            ownerId: z.string(),
            serverHostId: z.string(),
            sourceDataDir: z.string(),
            destinationDataDir: z.string(),
            artifactDigest: z.string(),
            sourceDigest: z.string(),
            destinationDigest: z.string(),
            configPresent: z.boolean(),
            configDigest: z.string().nullable(),
          })
          .passthrough()
          .parse(marker);

        if (
          selected.migrationId !== input.id ||
          selected.ownerId !== input.ownerId ||
          selected.serverHostId !== input.serverHostId ||
          selected.sourceDataDir !== binding.sourceDataDir ||
          selected.destinationDataDir !== binding.destinationDataDir ||
          selected.artifactDigest !== binding.runtimeSha256 ||
          selected.sourceDigest !== request.binding.sourceDigest ||
          selected.destinationDigest !== request.binding.destinationDigest ||
          (selected.configPresent
            ? configRaw === null ||
              createHash("sha256").update(configRaw).digest("hex") !==
                selected.configDigest
            : configRaw !== null)
        )
          throw new Error("Identity rollback Mac owner receipt differs");
      } else {
        const selected = z
          .object({
            input: z
              .object({
                formatVersion: z.literal(2),
                migrationId: z.string(),
                ownerId: z.string(),
                hostId: z.string(),
                sourceDataDir: z.string(),
                destinationDataDir: z.string(),
                jobDir: z.string(),
                artifactDigest: z.string(),
                archiveDigest: z.string(),
                expectedHoldSha256: z.string(),
                expectedSourceDigest: z.string(),
              })
              .passthrough(),
            destinationDigest: z.string(),
            configDigest: z.string(),
          })
          .passthrough()
          .parse(marker);

        const native = selected.input;

        if (
          native.migrationId !== input.id ||
          native.ownerId !== input.ownerId ||
          native.hostId !== input.serverHostId ||
          native.sourceDataDir !== binding.sourceDataDir ||
          native.destinationDataDir !== binding.destinationDataDir ||
          native.jobDir !== binding.jobDir ||
          native.artifactDigest !== binding.runtimeSha256 ||
          native.archiveDigest !== binding.archiveSha256 ||
          native.expectedHoldSha256 !== input.expectedHoldSha256 ||
          native.expectedSourceDigest !== request.binding.sourceDigest ||
          selected.destinationDigest !== request.binding.destinationDigest ||
          configRaw === null ||
          createHash("sha256").update(configRaw).digest("hex") !==
            selected.configDigest
        )
          throw new Error("Identity rollback Windows owner receipt differs");
      }

      const path = join(
        binding.sourceDataDir,
        SERVER_MAINTENANCE_HOLD_FILE_NAME,
      );

      const current = await readFile(path, "utf8");

      if (current === receipt.originalHoldText) return;
      const hold = maintenanceHoldSchema.parse(JSON.parse(current));

      if (
        hold.id !== input.id ||
        hold.ownerId !== input.ownerId ||
        hold.serverHostId !== input.serverHostId ||
        hold.kind !== "migration" ||
        hold.phase !== "held" ||
        JSON.stringify(hold.identityAdoption) !== JSON.stringify(binding)
      )
        throw new Error("Identity rollback promoted hold differs");
      await writeTextFileAtomically(
        path,
        receipt.originalHoldText,
        false,
        receipt.originalHoldMode,
      );
    },
  });
}

export async function restoreUnstagedIdentityHoldV1(
  input: PromoteIdentityHoldInput,
): Promise<void> {
  const binding = identityAdoptionBindingSchema.parse(input.binding);
  await withFileLock({
    path: join(binding.jobDir, "identity-hold-v1.lock"),
    timeoutMs: 1000,
    work: async () => {
      const actual = await assertPromotedIdentityHoldV1(binding.sourceDataDir);

      const receipt = identityHoldReceiptSchema.parse(
        JSON.parse(
          await readFile(join(binding.jobDir, "identity-hold-v1.json"), "utf8"),
        ),
      );

      if (
        JSON.stringify(actual) !== JSON.stringify(binding) ||
        JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
        receipt.id !== input.id ||
        receipt.ownerId !== input.ownerId ||
        receipt.serverHostId !== input.serverHostId ||
        receipt.originalHoldSha256 !== input.expectedHoldSha256
      )
        throw new Error(
          "Unstaged identity restoration belongs to another owner",
        );

      for (const path of [
        binding.destinationDataDir,
        join(binding.jobDir, "root-adoption.json"),
        join(binding.jobDir, "root-staging"),
        join(binding.jobDir, "write-admission.json"),
      ]) {
        const exists = await lstat(path).then(
          () => true,
          (error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return false;
            throw error;
          },
        );

        if (exists)
          throw new Error("Identity staging has already acquired an owner");
      }

      const config = parseAppManagedConfig(
        JSON.parse(
          await readFile(join(binding.sourceDataDir, "config.json"), "utf8"),
        ),
      );

      if (config.stateMigration !== undefined)
        throw new Error("Identity source already has a staging fence");
      await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);
      await writeTextFileAtomically(
        join(binding.sourceDataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME),
        receipt.originalHoldText,
        false,
        receipt.originalHoldMode,
      );
    },
  });
}

const abortedIdentityRootSchema = z
  .object({
    version: z.literal(1),
    phase: z.literal("aborted-before-admission"),
    migrationId: z.string().min(1),
    ownerId: z.string().min(1),
    serverHostId: z.string().min(1),
    sourceDataDir: z.string().min(1),
    destinationDataDir: z.string().min(1),
    artifactDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    destinationDigest: z.null(),
    configPresent: z.boolean(),
    configMode: z.number().int().min(0).max(0o777),
    configDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    stagingDevice: z.null(),
    stagingInode: z.null(),
  })
  .passthrough();

async function assertIdentityRestorePathsAbsent(paths: string[]) {
  const infos = await Promise.all(
    paths.map((path) =>
      lstat(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      }),
    ),
  );

  if (infos.some((info) => info !== null))
    throw new Error(
      "Aborted identity restoration still has a writer or staging fence",
    );
}

async function readIdentityRestoreFile(path: string) {
  const info = await lstat(path);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  )
    throw new Error(
      "Aborted identity restoration requires exact owned ordinary files",
    );

  return { text: await readFile(path, "utf8"), mode: info.mode & 0o777 };
}

export async function restoreAbortedIdentityHoldV1(
  input: PromoteIdentityHoldInput & { expectedSourceDigest: string },
): Promise<void> {
  const binding = identityAdoptionBindingSchema.parse(input.binding);

  for (const value of [input.expectedHoldSha256, input.expectedSourceDigest])
    z.string()
      .regex(/^[a-f0-9]{64}$/u)
      .parse(value);

  for (const path of [
    binding.sourceDataDir,
    binding.jobDir,
    binding.runtimeRoot,
  ]) {
    const info = await lstat(path);

    if (
      !isAbsolute(path) ||
      resolve(path) !== path ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      (process.getuid !== undefined && info.uid !== process.getuid())
    )
      throw new Error(
        "Aborted identity restoration requires exact owned directories",
      );
  }

  await withFileLock({
    path: join(binding.jobDir, "root-adoption.lock"),
    timeoutMs: 1000,
    work: () =>
      withFileLock({
        path: join(binding.jobDir, "identity-hold-v1.lock"),
        timeoutMs: 1000,
        work: async () => {
          const [receiptText, markerText] = await Promise.all([
            readPrivateJsonFileText(
              join(binding.jobDir, "identity-hold-v1.json"),
            ),
            readPrivateJsonFileText(join(binding.jobDir, "root-adoption.json")),
          ]);

          const receipt = identityHoldReceiptSchema.parse(
            JSON.parse(receiptText ?? "null"),
          );

          const marker = abortedIdentityRootSchema.parse(
            JSON.parse(markerText ?? "null"),
          );

          const original = maintenanceHoldSchema.parse(
            JSON.parse(receipt.originalHoldText),
          );

          if (
            receipt.id !== input.id ||
            receipt.ownerId !== input.ownerId ||
            receipt.serverHostId !== input.serverHostId ||
            receipt.originalHoldSha256 !== input.expectedHoldSha256 ||
            receipt.originalHoldMode > 0o777 ||
            JSON.stringify(receipt.binding) !== JSON.stringify(binding) ||
            createHash("sha256")
              .update(receipt.originalHoldText)
              .digest("hex") !== input.expectedHoldSha256 ||
            original.id !== input.id ||
            original.ownerId !== input.ownerId ||
            original.serverHostId !== input.serverHostId ||
            original.kind !== "desktop-update" ||
            original.phase !== "held" ||
            original.identityAdoption !== undefined ||
            (original.artifact !== null &&
              (original.artifact.runtimeSha256 !== binding.runtimeSha256 ||
                original.artifact.archiveSha256 !== binding.archiveSha256)) ||
            marker.migrationId !== input.id ||
            marker.ownerId !== input.ownerId ||
            marker.serverHostId !== input.serverHostId ||
            marker.sourceDataDir !== binding.sourceDataDir ||
            marker.destinationDataDir !== binding.destinationDataDir ||
            marker.artifactDigest !== binding.runtimeSha256 ||
            marker.sourceDigest !== input.expectedSourceDigest ||
            marker.configPresent !== (marker.configDigest !== null)
          )
            throw new Error(
              "Aborted identity restoration owner or abort receipt differs",
            );

          const absent = [
            binding.destinationDataDir,
            join(binding.jobDir, "root-staging"),
            join(binding.jobDir, "write-admission.json"),
            join(binding.sourceDataDir, "server-moved.json"),
            join(binding.sourceDataDir, "server-import.json"),
            join(binding.sourceDataDir, "server-import-journal.json"),
          ];

          await assertIdentityRestorePathsAbsent(absent);
          await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);

          const [host, runtimeIdentity] = await Promise.all([
            readIdentityRestoreFile(join(binding.sourceDataDir, "host-id")),
            readRuntimeIdentity(binding.runtimeRoot),
          ]);

          const runtime = await (
            binding.ownerKind === "worker"
              ? verifyWorkerRuntimeIdentity
              : verifyRuntimeIdentity
          )(binding.runtimeRoot, runtimeIdentity);

          if (
            host.text.trim() !== input.serverHostId ||
            runtime.runtimeSha256 !== binding.runtimeSha256
          )
            throw new Error(
              "Aborted identity restoration source or runtime artifact differs",
            );

          const configPath = join(binding.sourceDataDir, "config.json");
          const backupPath = join(binding.jobDir, "source-config.json");

          if (marker.configPresent) {
            const [config, backup] = await Promise.all([
              readIdentityRestoreFile(configPath),
              readIdentityRestoreFile(backupPath),
            ]);

            if (
              config.mode !== marker.configMode ||
              backup.mode !== marker.configMode ||
              config.text !== backup.text ||
              createHash("sha256").update(config.text).digest("hex") !==
                marker.configDigest ||
              parseAppManagedConfig(JSON.parse(config.text)).stateMigration !==
                undefined
            )
              throw new Error(
                "Aborted identity restoration source config is not restored",
              );
          } else
            await assertIdentityRestorePathsAbsent([configPath, backupPath]);

          const holdPath = join(
            binding.sourceDataDir,
            SERVER_MAINTENANCE_HOLD_FILE_NAME,
          );

          const current = await readIdentityRestoreFile(holdPath);

          if (current.text === receipt.originalHoldText) {
            if (current.mode !== receipt.originalHoldMode)
              throw new Error(
                "Aborted identity restoration original hold mode differs",
              );

            return;
          }

          const promoted = maintenanceHoldSchema.parse({
            ...original,
            kind: "migration",
            artifact: {
              runtimeSha256: binding.runtimeSha256,
              archiveSha256: binding.archiveSha256,
            },
            identityAdoption: binding,
          });

          if (
            JSON.stringify(
              maintenanceHoldSchema.parse(JSON.parse(current.text)),
            ) !== JSON.stringify(promoted)
          )
            throw new Error(
              "Aborted identity restoration promoted hold differs",
            );

          await assertIdentityRestorePathsAbsent(absent);
          await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);
          const unchanged = await readIdentityRestoreFile(holdPath);

          if (
            unchanged.text !== current.text ||
            unchanged.mode !== current.mode
          )
            throw new Error(
              "Aborted identity restoration hold changed before restoration",
            );
          await writeTextFileAtomically(
            holdPath,
            receipt.originalHoldText,
            false,
            receipt.originalHoldMode,
          );
        },
      }),
  });
}

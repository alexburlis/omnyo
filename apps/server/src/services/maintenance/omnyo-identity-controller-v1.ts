import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createConnection } from "@omnyo/db";
import {
  appManagedEnvFileSchema,
  parseAppManagedConfig,
} from "@omnyo/config/managed-app-config";
import {
  identityAdoptionControlRequestSchemaV1,
  identityAdoptionPreflightRequestSchemaV1,
  maintenanceHoldSchema,
  type IdentityAdoptionControlRequestV1,
  type IdentityAdoptionPreflightRequestV1,
} from "@omnyo/domain";
import {
  readOmnyoStateRootJobBindingV2,
  readPrivateJsonFileText,
  type OmnyoStateRootInput,
  preflightOmnyoStateRootKindsV1,
  promoteDesktopUpdateHoldForIdentityV1,
  assertPromotedIdentityHoldV1,
  stageOmnyoStateRootFromOwnerV2,
  verifyOmnyoSourceDatabaseCapacityV2,
  verifyOmnyoStateRootDatabaseV2,
  rollBackOmnyoStateRoot,
  restoreIdentityHoldAfterRollbackV1,
  restoreAbortedIdentityHoldV1,
  restoreUnstagedIdentityHoldV1,
  restoreUnstagedOmnyoSourceFenceV1,
  assertStoppedIdentityRuntimeOwnersV1,
  assertOmnyoStagedStateRoot,
  writeJsonFileAtomically,
} from "@omnyo/server-archive";
import { adoptOmnyoPluginStateV1 } from "../plugins/omnyo-plugin-state-v1.js";
import {
  verifyIdentityPluginArtifactsV1,
  readIdentityPluginArtifactsSelectionV1,
  adoptIdentityPluginArtifactsV1,
} from "../plugins/omnyo-plugin-artifacts-v1.js";

async function readIdentityManagedStateV1(dataDir: string) {
  const files = [];

  for (const name of ["config.json", "env.json"]) {
    const path = join(dataDir, name);

    const info = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (info === null) continue;

    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await realpath(path)) !== path
    )
      throw new Error("Identity managed state must be an exact ordinary file");

    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const original = z.record(z.string(), z.unknown()).parse(value);

      const parsed =
        name === "env.json"
          ? appManagedEnvFileSchema.parse(value)
          : parseAppManagedConfig(value);

      const next =
        name === "env.json"
          ? parsed
          : {
              ...original,
              ...("config" in parsed && parsed.config !== undefined
                ? { config: parsed.config }
                : {}),
            };

      files.push({
        path,
        mode: info.mode & 0o777,
        next,
        changed: JSON.stringify(original) !== JSON.stringify(next),
      });
    } catch {
      throw new Error(
        "Saved managed state is invalid; identity adoption refused",
      );
    }
  }

  return files;
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);

const count = z.number().int().nonnegative();

const sourceCapabilitySchema = z
  .object({
    version: z.literal(2),
    request: identityAdoptionPreflightRequestSchemaV1.omit({
      expectedHoldSha256: true,
    }),
    root: z
      .object({ device: z.string(), inode: z.string(), uid: count })
      .strict(),
    selection: z
      .object({
        manifestSha256: sha256.nullable(),
        inventorySha256: sha256.nullable(),
        cohortSha256: sha256.nullable(),
      })
      .strict(),
    capabilities: z
      .object({
        metadataDigest: sha256,
        counts: z
          .object({
            entries: count,
            directories: count,
            regularFiles: count,
            symbolicLinks: count,
            sockets: count,
            logicalBytes: count,
            hardlinkAliases: count,
            largestRegularFileBytes: count,
          })
          .strict(),
        socketCount: count,
      })
      .strict(),
  })
  .strict();

async function sourceCapabilityOwner(
  request: IdentityAdoptionPreflightRequestV1,
) {
  const { sourceDataDir, jobDir } = request.binding;
  const owner = process.getuid?.();

  if (
    owner === undefined ||
    [sourceDataDir, jobDir].some(
      (path) => !isAbsolute(path) || resolve(path) !== path,
    )
  )
    throw new Error(
      "Identity source capability paths must have an exact local owner",
    );
  const source = await lstat(sourceDataDir, { bigint: true });

  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    Number(source.uid) !== owner ||
    (await realpath(sourceDataDir)) !== sourceDataDir
  )
    throw new Error("Identity source capability root owner differs");

  const existing = await lstat(jobDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (existing === null) {
    const parent = dirname(jobDir);
    const entry = await lstat(parent);

    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.uid !== owner ||
      (await realpath(parent)) !== parent
    )
      throw new Error("Identity source capability job parent differs");
    await mkdir(jobDir, { mode: 0o700 }).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    });
  }

  const job = await lstat(jobDir);

  if (
    !job.isDirectory() ||
    job.isSymbolicLink() ||
    job.uid !== owner ||
    (job.mode & 0o077) !== 0 ||
    (await realpath(jobDir)) !== jobDir
  )
    throw new Error("Identity source capability job must be private and owned");
  const hostPath = join(sourceDataDir, "host-id");
  const host = await lstat(hostPath);

  if (
    !host.isFile() ||
    host.isSymbolicLink() ||
    host.nlink !== 1 ||
    host.uid !== owner ||
    (await realpath(hostPath)) !== hostPath ||
    (await readFile(hostPath, "utf8")).trim() !== request.serverHostId
  )
    throw new Error("Identity source capability machine identity differs");

  return {
    device: source.dev.toString(),
    inode: source.ino.toString(),
    uid: Number(source.uid),
  };
}

function sourceCapabilityRequest(request: IdentityAdoptionPreflightRequestV1) {
  return {
    version: request.version,
    id: request.id,
    ownerId: request.ownerId,
    serverHostId: request.serverHostId,
    binding: request.binding,
    ...(request.pluginArtifacts === undefined
      ? {}
      : { pluginArtifacts: request.pluginArtifacts }),
  };
}

async function readSourceProof<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | null> {
  const info = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (info === null) return null;

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    info.size > 1024 * 1024 ||
    (await realpath(path)) !== path
  )
    throw new Error("Identity source capability receipt owner differs");
  const text = await readPrivateJsonFileText(path);
  const current = await lstat(path);

  if (
    text === null ||
    current.dev !== info.dev ||
    current.ino !== info.ino ||
    current.nlink !== 1 ||
    current.uid !== process.getuid?.() ||
    (current.mode & 0o077) !== 0
  )
    throw new Error("Identity source capability receipt changed while reading");

  return schema.parse(JSON.parse(text));
}

const stoppedPreflightSchema = z
  .object({
    version: z.literal(2),
    sourceCapabilitySha256: sha256,
    holdSha256: sha256,
    originalHoldSha256: sha256,
    installedPluginCount: count,
  })
  .strict();

function capabilitySelection(
  request: IdentityAdoptionPreflightRequestV1,
  manifest: Awaited<ReturnType<typeof verifyIdentityPluginArtifactsV1>>,
) {
  return {
    manifestSha256: request.pluginArtifacts?.manifestSha256 ?? null,
    inventorySha256: manifest?.installedInventorySha256 ?? null,
    cohortSha256:
      manifest === null
        ? null
        : createHash("sha256")
            .update(JSON.stringify(manifest.entries))
            .digest("hex"),
  };
}

async function stoppedPreflightOwner(
  request: IdentityAdoptionPreflightRequestV1,
) {
  const text = await readPrivateJsonFileText(
    join(request.binding.sourceDataDir, "server-maintenance-hold.json"),
  );

  if (text === null) return null;
  const hold = maintenanceHoldSchema.parse(JSON.parse(text));

  if (hold.kind !== "migration") return null;

  if (
    hold.phase !== "held" ||
    hold.id !== request.id ||
    hold.ownerId !== request.ownerId ||
    hold.serverHostId !== request.serverHostId ||
    !isDeepStrictEqual(
      await assertPromotedIdentityHoldV1(request.binding.sourceDataDir),
      request.binding,
    )
  )
    throw new Error(
      "Stopped identity preflight requires its exact promoted hold",
    );
  await assertStoppedIdentityRuntimeOwnersV1(request.binding.sourceDataDir);

  const original = await readPrivateJsonFileText(
    join(request.binding.jobDir, "identity-hold-v1.json"),
  );

  if (original === null)
    throw new Error("Stopped identity preflight has no acquired hold proof");

  const selected = z
    .object({ originalHoldSha256: sha256 })
    .passthrough()
    .parse(JSON.parse(original));

  if (
    request.expectedHoldSha256 !== undefined &&
    request.expectedHoldSha256 !== selected.originalHoldSha256
  )
    throw new Error("Stopped identity preflight acquired hold changed");

  return {
    holdSha256: createHash("sha256").update(text).digest("hex"),
    originalHoldSha256: selected.originalHoldSha256,
  };
}

async function rootBinding(request: IdentityAdoptionPreflightRequestV1) {
  const { binding } = request;

  const text = await readPrivateJsonFileText(
    join(binding.jobDir, "root-adoption.json"),
  );

  const checkpoint =
    text === null
      ? null
      : z
          .object({
            digestAlgorithm: z
              .enum(["legacy-tree-v1", "state-tree-v2"])
              .default("legacy-tree-v1"),
            databaseVerification: z
              .enum(["inline-v1", "release-producer-v1"])
              .default("inline-v1"),
          })
          .passthrough()
          .parse(JSON.parse(text));

  const input = {
    migrationId: request.id,
    ownerId: request.ownerId,
    serverHostId: request.serverHostId,
    sourceDataDir: binding.sourceDataDir,
    destinationDataDir: binding.destinationDataDir,
    jobDir: binding.jobDir,
    artifactDigest: binding.runtimeSha256,
    digestAlgorithm: checkpoint?.digestAlgorithm ?? "state-tree-v2",
    databaseVerification:
      checkpoint?.databaseVerification ?? "release-producer-v1",
  } satisfies Omit<OmnyoStateRootInput, "expectedSourceDigest">;

  return { input, job: await readOmnyoStateRootJobBindingV2(input) };
}

export async function preflightIdentityAdoptionV1(value: unknown) {
  const request = identityAdoptionPreflightRequestSchemaV1.parse(value);

  if (request.binding.ownerKind !== "coordinator")
    throw new Error(
      "Worker preflight must use its existing native state owner",
    );

  const { job: existing } = await rootBinding(request);

  if (existing !== null) {
    const selected = await readIdentityPluginArtifactsSelectionV1(request);

    return {
      ready: true,
      version: 1,
      recovery: true,
      runtimeSha256: request.binding.runtimeSha256,
      installedPluginCount: selected?.manifest.entries.length ?? 0,
      pluginArtifactsManifestSha256:
        request.binding.pluginArtifactsManifestSha256 ?? null,
    };
  }

  const root = await sourceCapabilityOwner(request);
  const path = join(request.binding.jobDir, "source-capabilities-v2.json");
  const receipt = await readSourceProof(path, sourceCapabilitySchema);
  const identity = sourceCapabilityRequest(request);

  if (
    receipt !== null &&
    (!isDeepStrictEqual(receipt.request, identity) ||
      !isDeepStrictEqual(receipt.root, root))
  )
    throw new Error(
      "Identity source capability receipt belongs to another request or root",
    );
  await readIdentityManagedStateV1(request.binding.sourceDataDir);
  const promoted = await stoppedPreflightOwner(request);

  const stoppedPath = join(
    request.binding.jobDir,
    "source-stopped-preflight-v2.json",
  );

  const stopped = await readSourceProof(stoppedPath, stoppedPreflightSchema);

  const sourceCapabilitySha256 =
    receipt === null
      ? null
      : createHash("sha256").update(JSON.stringify(receipt)).digest("hex");

  if (
    stopped !== null &&
    stopped.sourceCapabilitySha256 !== sourceCapabilitySha256
  )
    throw new Error(
      "Stopped identity preflight belongs to another capability owner",
    );

  if (promoted !== null && stopped !== null) {
    if (
      stopped.holdSha256 !== promoted.holdSha256 ||
      stopped.originalHoldSha256 !== promoted.originalHoldSha256 ||
      receipt === null
    )
      throw new Error("Stopped identity preflight hold changed");
    const selected = await readIdentityPluginArtifactsSelectionV1(request);

    if (
      !isDeepStrictEqual(
        receipt.selection,
        capabilitySelection(request, selected?.manifest ?? null),
      )
    )
      throw new Error("Stopped identity preflight artifact selection changed");

    return {
      ready: true,
      version: 1,
      sourceRootCapabilities: receipt.capabilities,
      runtimeSha256: request.binding.runtimeSha256,
      installedPluginCount: stopped.installedPluginCount,
      pluginArtifactsManifestSha256:
        request.binding.pluginArtifactsManifestSha256 ?? null,
    };
  }

  if (promoted !== null && stopped === null) {
    const fingerprint = await lstat(
      join(request.binding.jobDir, "root-source-digest-v2.json"),
    ).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (fingerprint !== null)
      throw new Error(
        "Stopped source fingerprint started without its database preflight proof",
      );
  }

  const source = createConnection(
    join(request.binding.sourceDataDir, "bb.db"),
    { readonly: true },
  );

  let manifest: Awaited<ReturnType<typeof verifyIdentityPluginArtifactsV1>>;

  try {
    manifest = await verifyIdentityPluginArtifactsV1(request, source);
  } finally {
    source.$client.close();
  }

  const selection = capabilitySelection(request, manifest);

  if (receipt !== null && !isDeepStrictEqual(receipt.selection, selection))
    throw new Error("Identity source capability cohort or inventory changed");

  const sourceRootCapabilities =
    receipt?.capabilities ??
    (await preflightOmnyoStateRootKindsV1({
      sourceDataDir: request.binding.sourceDataDir,
      jobDir: request.binding.jobDir,
    }));

  if (receipt === null) {
    if (!isDeepStrictEqual(await sourceCapabilityOwner(request), root))
      throw new Error(
        "Identity source capability root changed during preflight",
      );

    const completed = sourceCapabilitySchema.parse({
      version: 2,
      request: identity,
      root,
      selection,
      capabilities: sourceRootCapabilities,
    });

    try {
      await writeJsonFileAtomically(path, completed, true);
    } catch (error: unknown) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;

      if (
        !isDeepStrictEqual(
          await readSourceProof(path, sourceCapabilitySchema),
          completed,
        )
      )
        throw new Error("Identity source capability receipt collision");
    }
  }

  if (promoted !== null) {
    if (!isDeepStrictEqual(await stoppedPreflightOwner(request), promoted))
      throw new Error(
        "Stopped identity preflight owner changed during database verification",
      );
    const capability = await readSourceProof(path, sourceCapabilitySchema);

    if (capability === null)
      throw new Error("Stopped identity preflight lost its capability proof");

    const completed = stoppedPreflightSchema.parse({
      version: 2,
      sourceCapabilitySha256: createHash("sha256")
        .update(JSON.stringify(capability))
        .digest("hex"),
      ...promoted,
      installedPluginCount: manifest?.entries.length ?? 0,
    });

    try {
      await writeJsonFileAtomically(stoppedPath, completed, true);
    } catch (error: unknown) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;

      if (
        !isDeepStrictEqual(
          await readSourceProof(stoppedPath, stoppedPreflightSchema),
          completed,
        )
      )
        throw new Error("Stopped identity preflight receipt collision");
    }
  }

  return {
    ready: true,
    version: 1,
    sourceRootCapabilities,
    runtimeSha256: request.binding.runtimeSha256,
    installedPluginCount: manifest?.entries.length ?? 0,
    pluginArtifactsManifestSha256:
      request.binding.pluginArtifactsManifestSha256 ?? null,
  };
}

async function sourceDatabaseCapacityInput(
  request: IdentityAdoptionPreflightRequestV1,
) {
  const { input, job } = await rootBinding(request);

  const paths = [
    request.binding.destinationDataDir,
    ...[
      "source-stopped-preflight-v2.json",
      "root-source-digest-v2.json",
      "held-source-fence-v1.json",
      "root-staging",
      "write-admission.json",
    ].map((name) => join(request.binding.jobDir, name)),
  ];

  const checkpoints = await Promise.all(
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

  if (job !== null || checkpoints.some((info) => info !== null))
    throw new Error(
      "Identity source database capacity requires its pre-stop phase",
    );

  for (const file of await readIdentityManagedStateV1(
    request.binding.sourceDataDir,
  ))
    if ("stateMigration" in file.next && file.next.stateMigration !== undefined)
      throw new Error(
        "Identity source database capacity requires its unfenced phase",
      );

  const holdText = await readPrivateJsonFileText(
    join(request.binding.sourceDataDir, "server-maintenance-hold.json"),
  );

  if (holdText !== null) {
    const hold = maintenanceHoldSchema.parse(JSON.parse(holdText));

    if (
      hold.phase !== "released" &&
      (hold.kind !== "desktop-update" ||
        hold.phase !== "held" ||
        hold.id !== request.id ||
        hold.ownerId !== request.ownerId ||
        hold.serverHostId !== request.serverHostId ||
        (request.expectedHoldSha256 !== undefined &&
          request.expectedHoldSha256 !==
            createHash("sha256").update(holdText).digest("hex")))
    )
      throw new Error(
        "Identity source database capacity requires its original hold phase",
      );
  }

  return input;
}

export async function preflightIdentityAdoptionDatabaseV1(value: unknown) {
  const request = identityAdoptionPreflightRequestSchemaV1.parse(value);

  if (request.binding.ownerKind !== "coordinator")
    throw new Error(
      "Worker database capacity must use its existing native state owner",
    );
  const input = await sourceDatabaseCapacityInput(request);
  await preflightIdentityAdoptionV1(request);

  return verifyOmnyoSourceDatabaseCapacityV2(input, {
    openReadonlyDatabase: (path) =>
      createConnection(path, { readonly: true }).$client,
  });
}

export async function verifyIdentityAdoptionDatabaseV1(value: unknown) {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);

  if (request.binding.ownerKind !== "coordinator")
    throw new Error(
      "Worker database verification must use its existing native state owner",
    );
  const { input, job } = await rootBinding(request);

  if (job === null)
    throw new Error(
      "Identity database verification requires its bound root job",
    );
  await readIdentityPluginArtifactsSelectionV1(request);

  if ((await stoppedPreflightOwner(request)) === null)
    throw new Error(
      "Identity database verification requires its promoted hold",
    );

  return verifyOmnyoStateRootDatabaseV2(
    { ...input, expectedSourceDigest: job.sourceDigest },
    {
      openReadonlyDatabase: (path) =>
        createConnection(path, { readonly: true }).$client,
    },
  );
}

export async function stageIdentityAdoptionV1(value: unknown) {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);

  if (request.binding.ownerKind !== "coordinator")
    throw new Error(
      "Worker profile adoption must use its existing native state owner",
    );

  const { input, job } = await rootBinding(request);

  if (
    job !== null &&
    [
      "aborted-before-admission",
      "aborting-before-admission",
      "rollback-selected",
      "rollback-source-verified",
    ].includes(job.phase)
  )
    throw new Error(
      "Identity staging cannot resume a selected rollback or abort",
    );

  if (job === null) await preflightIdentityAdoptionV1(request);
  else await readIdentityPluginArtifactsSelectionV1(request);
  await promoteDesktopUpdateHoldForIdentityV1(request);

  if (job === null) await preflightIdentityAdoptionV1(request);

  return stageOmnyoStateRootFromOwnerV2(input, {
    async prepareDestination(stage) {
      await assertOmnyoStagedStateRoot(stage);

      if (stage.databaseState !== "present")
        throw new Error(
          "Coordinator identity adoption requires its existing database",
        );

      for (const file of await readIdentityManagedStateV1(stage.dataDir))
        if (file.changed)
          await writeJsonFileAtomically(file.path, file.next, false, file.mode);
      await adoptOmnyoPluginStateV1(stage);
      const db = createConnection(stage.databasePath);

      try {
        const manifest = await verifyIdentityPluginArtifactsV1(
          request,
          db,
          stage,
        );

        await adoptIdentityPluginArtifactsV1(
          stage,
          db,
          manifest,
          request.binding.runtimeRoot,
        );
      } finally {
        db.$client.close();
      }
    },
    openDatabase: (path) => createConnection(path).$client,
  });
}

async function assertOriginalUnstagedHold(
  request: IdentityAdoptionControlRequestV1,
  text: string,
) {
  const hold = maintenanceHoldSchema.parse(JSON.parse(text));

  if (
    createHash("sha256").update(text).digest("hex") !==
      request.expectedHoldSha256 ||
    hold.kind !== "desktop-update" ||
    hold.phase !== "held" ||
    hold.id !== request.id ||
    hold.ownerId !== request.ownerId ||
    hold.serverHostId !== request.serverHostId
  )
    throw new Error(
      "Identity unstaged rollback does not own the original hold",
    );
  const { binding } = request;
  const source = await lstat(binding.sourceDataDir);

  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    source.uid !== process.getuid?.() ||
    (await realpath(binding.sourceDataDir)) !== binding.sourceDataDir
  )
    throw new Error("Identity unstaged rollback source owner differs");

  const paths = [
    binding.destinationDataDir,
    join(binding.jobDir, "root-adoption.json"),
    join(binding.jobDir, "root-staging"),
    join(binding.jobDir, "write-admission.json"),
    join(binding.jobDir, "held-source-fence-v1.json"),
  ];

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
      "Identity unstaged rollback still has a staging or source-fence owner",
    );
  const configPath = join(binding.sourceDataDir, "config.json");
  const configInfo = await lstat(configPath);

  if (
    !configInfo.isFile() ||
    configInfo.isSymbolicLink() ||
    configInfo.nlink !== 1 ||
    configInfo.uid !== process.getuid?.() ||
    (await realpath(configPath)) !== configPath
  )
    throw new Error("Identity unstaged rollback configuration owner differs");

  const config = parseAppManagedConfig(
    JSON.parse(await readFile(configPath, "utf8")),
  );

  if (config.stateMigration !== undefined)
    throw new Error("Identity unstaged rollback still has a source fence");
  await assertStoppedIdentityRuntimeOwnersV1(binding.sourceDataDir);
}

export async function rollBackIdentityAdoptionV1(value: unknown) {
  const request = identityAdoptionControlRequestSchemaV1.parse(value);

  if (request.binding.ownerKind !== "coordinator")
    throw new Error("Worker rollback must use its existing native state owner");
  const { input: binding, job } = await rootBinding(request);

  if (job === null) {
    const text = await readPrivateJsonFileText(
      join(request.binding.sourceDataDir, "server-maintenance-hold.json"),
    );

    if (text === null)
      throw new Error("Identity unstaged rollback has no confirmed hold owner");
    const hold = maintenanceHoldSchema.parse(JSON.parse(text));

    if (hold.kind === "desktop-update")
      await assertOriginalUnstagedHold(request, text);
    else {
      await restoreUnstagedOmnyoSourceFenceV1(request);
      await restoreUnstagedIdentityHoldV1(request);
    }

    return { rolledBack: true, id: request.id };
  }

  const input = { ...binding, expectedSourceDigest: job.sourceDigest };

  if (
    job.phase !== "rollback-selected" &&
    job.phase !== "aborted-before-admission"
  )
    await rollBackOmnyoStateRoot(input);
  const settled = await readOmnyoStateRootJobBindingV2(binding);

  if (settled?.phase === "aborted-before-admission")
    await restoreAbortedIdentityHoldV1({
      ...request,
      expectedSourceDigest: input.expectedSourceDigest,
    });
  else if (settled?.phase === "rollback-selected")
    await restoreIdentityHoldAfterRollbackV1(request);
  else throw new Error("Identity rollback did not settle its root owner");

  return { rolledBack: true, id: request.id };
}

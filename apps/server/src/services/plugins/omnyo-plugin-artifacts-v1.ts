import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { z } from "zod";
import semver from "semver";
import {
  createPluginArtifact,
  getPluginArtifact,
  getInstalledPlugin,
  installedPlugins,
  type DbConnection,
} from "@omnyo/db";
import {
  importLegacyOwnedPluginIdV1,
  importLegacyBuiltinNameV1,
  type IdentityAdoptionControlRequestV1,
} from "@omnyo/domain";
import {
  assertOmnyoStagedStateRoot,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  type OmnyoStagedStateRoot,
} from "@omnyo/server-archive";
import { hashInstallDir, promoteImmutableDir } from "./install-sources.js";
import { stageBuiltinPluginArtifact } from "./builtin-plugin-artifacts.js";
import { isPluginSdkRangeSatisfied } from "./sdk-compat.js";
import { readPluginManifest } from "./manifest.js";
import {
  parsePluginAppBundleMeta,
  validatePluginArtifactMeta,
} from "./app-bundle.js";

const sha = z.string().regex(/^[a-f0-9]{64}$/u);

const piece = z
  .object({
    path: z.string(),
    sha256: sha,
    metadataPath: z.string(),
    metadataSha256: sha,
    formatVersion: z.literal(2),
  })
  .strict();

const identityPluginArtifactEntrySchemaV1 = z
  .object({
    oldId: z.string(),
    id: z.string(),
    version: z.string(),
    sourceRoot: z.string(),
    artifactRoot: z.string(),
    contentDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
    artifacts: z
      .object({
        server: piece,
        app: piece.optional(),
        host: piece.optional(),
      })
      .strict(),
  })
  .strict();

const carriedDisabledUnmanagedPluginSchemaV1 = z
  .object({
    oldId: z.literal("desktop-helper"),
    id: z.literal("desktop-helper"),
    version: z.literal("0.1.0"),
    carriedDisabledUnmanagedV1: z
      .object({
        enabled: z.literal(false),
        sourceKind: z.literal("path"),
        source: z.literal(
          "path:/Users/developer/projects/omnyo-plugins/desktop-helper",
        ),
        sourcePath: z.literal("/Users/developer/projects/omnyo-plugins/desktop-helper"),
        rootDir: z.literal("/Users/developer/projects/omnyo-plugins/desktop-helper"),
        status: z.literal("disabled"),
      })
      .strict(),
  })
  .strict();

export const identityPluginArtifactsManifestSchemaV1 = z
  .object({
    schema: z.literal(1),
    coreSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    pluginSourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    runtimeSha256: sha,
    installedInventorySha256: sha,
    entries: z.array(
      z.union([
        identityPluginArtifactEntrySchemaV1,
        carriedDisabledUnmanagedPluginSchemaV1,
      ]),
    ),
  })
  .strict();

export const identityInstalledPluginInventorySchemaV1 = z
  .object({
    schema: z.literal(1),
    plugins: z.array(
      z
        .object({
          id: z.string().min(1),
          version: z.string().min(1),
          enabled: z.boolean(),
          source: z.string().min(1),
          rootDir: z.string().min(1),
          status: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

type IdentityInstalledPluginInventoryRowV1 = z.infer<
  typeof identityInstalledPluginInventorySchemaV1
>["plugins"][number];

export function selectIdentityPluginCohortSourceV1<T extends { id: string }>(
  installed: IdentityInstalledPluginInventoryRowV1,
  owners: readonly T[],
):
  | {
      kind: "artifact";
      installed: IdentityInstalledPluginInventoryRowV1;
      id: string;
      owner: T;
    }
  | {
      kind: "carried-disabled-unmanaged";
      installed: IdentityInstalledPluginInventoryRowV1;
      id: string;
      entry: z.infer<typeof carriedDisabledUnmanagedPluginSchemaV1>;
    } {
  const id = importLegacyOwnedPluginIdV1(installed.id);
  const owner = owners.find((candidate) => candidate.id === id);

  if (owner !== undefined) return { kind: "artifact", installed, id, owner };

  const carried = carriedDisabledUnmanagedPluginSchemaV1.safeParse({
    oldId: installed.id,
    id,
    version: installed.version,
    carriedDisabledUnmanagedV1: {
      enabled: installed.enabled,
      sourceKind: "path",
      source: installed.source,
      sourcePath: installed.rootDir,
      rootDir: installed.rootDir,
      status: installed.status,
    },
  });

  if (!carried.success)
    throw new Error(`Installed plugin has no owned source: ${installed.id}`);

  return {
    kind: "carried-disabled-unmanaged",
    installed,
    id,
    entry: carried.data,
  };
}

function assertCarriedDisabledUnmanagedRowV1(
  entry: z.infer<typeof carriedDisabledUnmanagedPluginSchemaV1>,
  row: typeof installedPlugins.$inferSelect | undefined,
): void {
  const carried = entry.carriedDisabledUnmanagedV1;

  if (
    row === undefined ||
    row.id !== entry.id ||
    entry.oldId !== entry.id ||
    importLegacyOwnedPluginIdV1(entry.oldId) !== entry.id ||
    row.version !== entry.version ||
    row.enabled !== false ||
    row.enabledFollowsDefault !== false ||
    row.removedAt !== null ||
    row.provenance !== "direct" ||
    row.catalogEntryId !== null ||
    row.sourceKind !== carried.sourceKind ||
    row.source !== carried.source ||
    row.sourcePath !== carried.sourcePath ||
    row.rootDir !== carried.rootDir
  )
    throw new Error(
      "Carried disabled unmanaged plugin changed or became managed",
    );
}

export type IdentityPluginArtifactsManifestV1 = z.infer<
  typeof identityPluginArtifactsManifestSchemaV1
>;

const digest = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

function inside(root: string, path: string) {
  const delta = relative(root, path);

  return (
    delta === "" ||
    (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(".." + sep))
  );
}

async function assertImmutableArtifactTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const info = await lstat(path);

    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error(
        "Identity artifact must contain ordinary self-contained bytes",
      );

    if (info.isDirectory()) await assertImmutableArtifactTree(path);
  }
}

export async function assertIdentityArtifactEsmScopeV1(
  root: string,
): Promise<void> {
  for (const directory of [join(root, "dist"), root]) {
    const raw = await readFile(join(directory, "package.json"), "utf8").catch(
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

    if (raw === null) continue;

    const scope = z
      .object({ type: z.enum(["module", "commonjs"]).optional() })
      .passthrough()
      .parse(JSON.parse(raw));

    if (scope.type === "module") return;

    if (scope.type !== undefined) break;
  }

  throw new Error(
    "Identity server artifact requires an explicit ESM package scope",
  );
}

async function boundFile(root: string, path: string, expected: string) {
  if (
    isAbsolute(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    resolve(root, path) === root ||
    !inside(root, resolve(root, path))
  )
    throw new Error("Identity artifact path escapes its immutable root");
  const absolute = resolve(root, path);

  if (
    (await realpath(absolute)) !== absolute ||
    !(await lstat(absolute)).isFile()
  )
    throw new Error("Identity artifact must be an exact ordinary file");
  const bytes = await readFile(absolute);

  if (digest(bytes) !== expected)
    throw new Error("Identity artifact bytes differ from the selected receipt");

  return bytes;
}

export async function readIdentityPluginArtifactsSelectionV1(
  request: Pick<
    IdentityAdoptionControlRequestV1,
    "binding" | "pluginArtifacts"
  >,
) {
  const selection = request.pluginArtifacts;

  if (selection === undefined) return null;

  if (
    request.binding.pluginArtifactsManifestSha256 !== selection.manifestSha256
  )
    throw new Error(
      "Identity plugin selection is not bound to its maintenance owner",
    );
  const manifestBytes = await readFile(selection.manifestPath);

  if (digest(manifestBytes) !== selection.manifestSha256)
    throw new Error("Identity plugin manifest changed after selection");

  const manifest = identityPluginArtifactsManifestSchemaV1.parse(
    JSON.parse(manifestBytes.toString("utf8")),
  );

  if (manifest.runtimeSha256 !== request.binding.runtimeSha256)
    throw new Error("Identity plugin receipt belongs to another runtime");
  const inventoryBytes = await readFile(selection.installedInventoryPath);

  if (digest(inventoryBytes) !== manifest.installedInventorySha256)
    throw new Error("Identity installed-plugin inventory differs");

  const inventory = z
    .object({
      schema: z.literal(1),
      plugins: z.array(
        z
          .object({ id: z.string(), version: z.string(), enabled: z.boolean() })
          .passthrough(),
      ),
    })
    .strict()
    .parse(JSON.parse(inventoryBytes.toString("utf8")));

  return { manifest, inventory };
}

export async function verifyIdentityPluginArtifactsV1(
  request: Pick<
    IdentityAdoptionControlRequestV1,
    "binding" | "pluginArtifacts"
  >,
  db: DbConnection,
  stage?: OmnyoStagedStateRoot,
): Promise<IdentityPluginArtifactsManifestV1 | null> {
  if (stage !== undefined) await assertOmnyoStagedStateRoot(stage);

  const rows = db
    .select()
    .from(installedPlugins)
    .where(isNull(installedPlugins.removedAt))
    .all();

  const selected = await readIdentityPluginArtifactsSelectionV1(request);

  if (selected === null) {
    if (rows.length > 0)
      throw new Error(
        "Every installed plugin requires a selected canonical artifact before identity cutover",
      );

    return null;
  }

  const { manifest, inventory } = selected;

  const runtime = await verifyRuntimeIdentity(
    request.binding.runtimeRoot,
    await readRuntimeIdentity(request.binding.runtimeRoot),
  );

  if (runtime.runtimeSha256 !== request.binding.runtimeSha256)
    throw new Error("Identity plugin runtime bytes differ");

  if (
    rows.length !== inventory.plugins.length ||
    rows.length !== manifest.entries.length ||
    new Set(manifest.entries.map((entry) => entry.oldId)).size !==
      rows.length ||
    new Set(manifest.entries.map((entry) => entry.id)).size !== rows.length
  )
    throw new Error("Identity plugin coverage is incomplete or colliding");

  for (const row of rows) {
    const entry = manifest.entries.find(
      (plugin) =>
        plugin.oldId === row.id ||
        (stage !== undefined && plugin.id === row.id),
    );

    const old = inventory.plugins.find((plugin) => plugin.id === entry?.oldId);

    if (entry !== undefined && "carriedDisabledUnmanagedV1" in entry) {
      const selected =
        identityInstalledPluginInventorySchemaV1.shape.plugins.element.safeParse(
          old,
        );

      if (
        !selected.success ||
        selected.data.id !== entry.oldId ||
        selected.data.version !== entry.version ||
        selected.data.enabled !== false ||
        selected.data.status !== entry.carriedDisabledUnmanagedV1.status ||
        selected.data.source !== entry.carriedDisabledUnmanagedV1.source ||
        selected.data.rootDir !== entry.carriedDisabledUnmanagedV1.rootDir
      )
        throw new Error("Carried disabled unmanaged plugin inventory changed");

      assertCarriedDisabledUnmanagedRowV1(entry, row);
      continue;
    }

    const newArtifact =
      entry === undefined
        ? undefined
        : getPluginArtifact(
            db,
            `identity_v1_${digest(`${entry.id}\0${entry.contentDigest}`)}`,
          );

    const alreadySelected =
      entry !== undefined &&
      row.activeArtifactId === newArtifact?.id &&
      (newArtifact?.contentHash === entry.contentDigest ||
        (row.sourceKind === "builtin" &&
          newArtifact?.sourceKind === "builtin" &&
          newArtifact.validationResult === "valid")) &&
      newArtifact.pluginId === entry.id &&
      row.version === entry.version;

    if (
      old === undefined ||
      old.enabled !== row.enabled ||
      entry === undefined ||
      entry.id !== importLegacyOwnedPluginIdV1(entry.oldId) ||
      (old.version !== row.version && !alreadySelected)
    )
      throw new Error(
        "Installed plugin state changed or lacks its exact selected artifact",
      );

    if (
      !isAbsolute(entry.artifactRoot) ||
      (await realpath(entry.artifactRoot)) !== entry.artifactRoot ||
      !isAbsolute(entry.sourceRoot) ||
      resolve(entry.sourceRoot) !== entry.sourceRoot
    )
      throw new Error("Identity artifact roots must be exact owned paths");

    await assertImmutableArtifactTree(entry.artifactRoot);
    await assertIdentityArtifactEsmScopeV1(entry.artifactRoot);

    if ((await hashInstallDir(entry.artifactRoot)) !== entry.contentDigest)
      throw new Error("Identity plugin content digest differs");

    if (row.sourceKind === "builtin") {
      const name = importLegacyBuiltinNameV1(row.sourceBuiltinName);

      if (name === null)
        throw new Error("Identity builtin provenance is incomplete");

      const bundledRoot = join(
        request.binding.runtimeRoot,
        "server/dist/builtin-plugins",
        name,
      );

      if ((await realpath(bundledRoot)) !== bundledRoot)
        throw new Error("Identity builtin runtime path differs");
      await assertImmutableArtifactTree(bundledRoot);

      if ((await hashInstallDir(bundledRoot)) !== entry.contentDigest)
        throw new Error(
          "Identity builtin candidate differs from its selected runtime bytes",
        );
    }

    const metadata = z
      .object({
        name: z.string(),
        omnyo: z.unknown(),
        bb: z.never().optional(),
      })
      .passthrough()
      .parse(
        JSON.parse(
          await readFile(join(entry.artifactRoot, "package.json"), "utf8"),
        ),
      );

    const plugin = await readPluginManifest(entry.artifactRoot);

    if (
      (plugin.coreEngineRange !== undefined &&
        !semver.satisfies(runtime.runtimeVersion, plugin.coreEngineRange, {
          includePrerelease: true,
        })) ||
      (plugin.pluginSdkRange !== undefined &&
        !isPluginSdkRangeSatisfied(plugin.pluginSdkRange))
    )
      throw new Error(
        "Identity plugin engine or SDK range is incompatible with the selected runtime",
      );

    if (
      metadata.name !== `omnyo-plugin-${entry.id}` ||
      plugin.id !== entry.id ||
      plugin.version !== entry.version ||
      Boolean(plugin.appEntry) !== Boolean(entry.artifacts.app) ||
      Boolean(plugin.hostEntry) !== Boolean(entry.artifacts.host)
    )
      throw new Error("Identity plugin package and artifact surfaces differ");

    for (const artifact of ["server", "app", "host"] as const) {
      const selected = entry.artifacts[artifact];

      if (selected === undefined) continue;

      if (
        selected.path !== `dist/${artifact}.js` ||
        selected.metadataPath !== `dist/${artifact}.meta.json`
      )
        throw new Error(
          "Identity plugin artifact paths differ from their existing runtime owner",
        );
      await boundFile(entry.artifactRoot, selected.path, selected.sha256);

      const raw = (
        await boundFile(
          entry.artifactRoot,
          selected.metadataPath,
          selected.metadataSha256,
        )
      ).toString("utf8");

      const parsed = parsePluginAppBundleMeta(raw);

      if (
        parsed?.artifactFormatVersion !== 2 ||
        validatePluginArtifactMeta({
          artifact,
          raw,
          pluginId: entry.id,
          pluginVersion: entry.version,
        }) !== null
      )
        throw new Error(
          "Identity plugin artifact has an incompatible SDK package or runtime ABI",
        );
    }
  }

  return manifest;
}

export async function adoptIdentityPluginArtifactsV1(
  stage: OmnyoStagedStateRoot,
  db: DbConnection,
  manifest: IdentityPluginArtifactsManifestV1 | null,
  runtimeRoot: string,
): Promise<void> {
  await assertOmnyoStagedStateRoot(stage);

  if (stage.databaseState !== "present")
    throw new Error(
      "Installed plugin adoption requires its existing coordinator database",
    );

  if (manifest === null) return;

  const selected: Array<{
    entry: z.infer<typeof identityPluginArtifactEntrySchemaV1>;
    id: string;
    finalRoot: string;
    builtin: boolean;
  }> = [];

  const installedRuntimeRoot = inside(stage.sourceDataDir, runtimeRoot)
    ? join(stage.destinationDataDir, relative(stage.sourceDataDir, runtimeRoot))
    : runtimeRoot;

  for (const entry of manifest.entries) {
    if ("carriedDisabledUnmanagedV1" in entry) {
      assertCarriedDisabledUnmanagedRowV1(
        entry,
        getInstalledPlugin(db, entry.id),
      );
      continue;
    }

    const id = `identity_v1_${digest(`${entry.id}\0${entry.contentDigest}`)}`;
    const installed = getInstalledPlugin(db, entry.id);

    if (installed === undefined)
      throw new Error("Identity plugin registration disappeared");

    if (installed.sourceKind === "builtin") {
      if (installed.sourceBuiltinName === null)
        throw new Error("Identity builtin provenance is incomplete");
      const files: Array<{ path: string; base64: string; sha256: string }> = [];

      async function collect(directory: string, prefix: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name;
          const absolute = join(directory, entry.name);

          if (entry.isDirectory()) await collect(absolute, path);
          else if (entry.isFile()) {
            const bytes = await readFile(absolute);
            files.push({
              path,
              base64: bytes.toString("base64"),
              sha256: digest(bytes),
            });
          } else
            throw new Error(
              "Identity builtin artifact contains a nonordinary file",
            );
        }
      }

      await collect(entry.artifactRoot, "");

      if ((await hashInstallDir(entry.artifactRoot)) !== entry.contentDigest)
        throw new Error(
          "Identity builtin candidate changed while preparing its owner",
        );

      const stagedRuntimeRoot = inside(stage.sourceDataDir, runtimeRoot)
        ? join(stage.dataDir, relative(stage.sourceDataDir, runtimeRoot))
        : runtimeRoot;

      const bundledRoot = join(
        stagedRuntimeRoot,
        "server/dist/builtin-plugins",
        installed.sourceBuiltinName,
      );

      await assertImmutableArtifactTree(bundledRoot);

      if ((await hashInstallDir(bundledRoot)) !== entry.contentDigest)
        throw new Error(
          "Identity builtin runtime changed before artifact adoption",
        );

      const adopted = await stageBuiltinPluginArtifact({
        db,
        dataDir: stage.dataDir,
        row: installed,
        bundledRootDir: join(
          installedRuntimeRoot,
          "server/dist/builtin-plugins",
          installed.sourceBuiltinName,
        ),
        candidate: {
          expectedVersion: installed.version,
          expectedArtifactId: installed.activeArtifactId,
          files,
        },
        checkCompatibility: (plugin) =>
          plugin.id === entry.id && plugin.version === entry.version
            ? undefined
            : "Identity bundled candidate differs from its selected manifest",
        identityAdoption: { stage, artifactId: id },
      });

      selected.push({
        entry,
        id: adopted.artifactId,
        finalRoot: adopted.rootDir,
        builtin: true,
      });
      continue;
    }

    const relativeRoot = join(
      "plugins",
      "cache",
      "identity-v1",
      entry.id,
      entry.contentDigest.slice("sha256:".length),
    );

    const target = join(stage.dataDir, relativeRoot);
    const finalRoot = join(stage.destinationDataDir, relativeRoot);
    let parent = stage.dataDir;

    for (const segment of relativeRoot.split(sep).slice(0, -1)) {
      parent = join(parent, segment);

      const info = await lstat(parent).catch((error: unknown) => {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null;
        throw error;
      });

      if (info !== null && (!info.isDirectory() || info.isSymbolicLink()))
        throw new Error("Identity plugin artifact parent collision");

      if (info === null) await mkdir(parent);

      if ((await realpath(parent)) !== parent)
        throw new Error(
          "Identity plugin artifact parent resolves outside its owner",
        );
    }

    const existing = await lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (existing !== null) {
      if (
        existing.isSymbolicLink() ||
        !existing.isDirectory() ||
        (await hashInstallDir(target)) !== entry.contentDigest
      )
        throw new Error("Identity plugin artifact target collision");
    } else {
      for (const suffix of [".promoting", ".corrupt"])
        if (
          await lstat(target + suffix).then(
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
          )
        )
          throw new Error("Identity plugin promotion owner collision");
      const temporary = join(stage.jobDir, `plugin-artifact-${randomUUID()}`);

      try {
        await cp(entry.artifactRoot, temporary, {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });

        if ((await hashInstallDir(temporary)) !== entry.contentDigest)
          throw new Error("Copied identity plugin bytes differ");
        await mkdir(join(target, ".."), { recursive: true });
        await promoteImmutableDir({
          stagingDir: temporary,
          targetDir: target,
          contentHash: entry.contentDigest,
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }

    selected.push({ entry, id, finalRoot, builtin: false });
  }

  db.transaction(() => {
    for (const { entry, id, finalRoot, builtin } of selected) {
      const row = db
        .select()
        .from(installedPlugins)
        .where(eq(installedPlugins.id, entry.id))
        .get();

      if (row === undefined)
        throw new Error("Identity plugin registration disappeared");
      const previous = getPluginArtifact(db, id);

      if (previous !== undefined) {
        if (
          previous.pluginId !== entry.id ||
          previous.path !== finalRoot ||
          (!builtin && previous.contentHash !== entry.contentDigest)
        )
          throw new Error("Identity plugin artifact record collision");
      } else {
        const common = {
          id,
          pluginId: entry.id,
          path: finalRoot,
          contentHash: entry.contentDigest,
          validationResult: "valid" as const,
          validatedAt: Date.now(),
        };

        switch (row.sourceKind) {
          case "path":
            createPluginArtifact(db, {
              ...common,
              sourceKind: "path",
              npmResolvedVersion: null,
              gitResolvedCommit: null,
              gitCheckoutRoot: null,
              integrity: null,
            });
            break;
          case "builtin":
            throw new Error(
              "Builtin identity artifact must be staged by its existing owner",
            );
          case "npm":
            if (row.npmResolvedVersion === null || row.npmIntegrity === null)
              throw new Error("Identity npm provenance is incomplete");
            createPluginArtifact(db, {
              ...common,
              sourceKind: "npm",
              npmResolvedVersion: row.npmResolvedVersion,
              gitResolvedCommit: null,
              gitCheckoutRoot: null,
              integrity: row.npmIntegrity,
            });
            break;
          case "git":
            if (row.gitResolvedCommit === null)
              throw new Error("Identity git provenance is incomplete");
            createPluginArtifact(db, {
              ...common,
              sourceKind: "git",
              npmResolvedVersion: null,
              gitResolvedCommit: manifest.pluginSourceCommit,
              gitCheckoutRoot: null,
              integrity: row.npmIntegrity,
            });
            break;
        }
      }

      db.update(installedPlugins)
        .set({
          activeArtifactId: id,
          rootDir: finalRoot,
          version: entry.version,
          ...(row.sourceKind === "git"
            ? { gitResolvedCommit: manifest.pluginSourceCommit }
            : {}),
          ...(row.sourceKind === "path"
            ? {
                sourcePath: entry.sourceRoot,
                source: `path:${entry.sourceRoot}`,
              }
            : {}),
        })
        .where(eq(installedPlugins.id, entry.id))
        .run();
    }
  });
}

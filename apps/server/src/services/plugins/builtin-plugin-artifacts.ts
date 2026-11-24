import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { HOST_ARTIFACT_MAX_BYTES } from "@omnyo/host-daemon-contract/protocol";
import {
  createPluginArtifact,
  getPluginArtifact,
  type DbConnection,
  type InstalledPluginRow,
} from "@omnyo/db";
import {
  MAX_BUNDLED_PLUGIN_BYTES,
  pluginApplyUpdateRequestSchema,
  type PluginApplyUpdateRequest,
} from "@omnyo/server-contract";
import { validatePluginArtifactMeta } from "./app-bundle.js";
import { readPluginManifest, type PluginManifest } from "./manifest.js";
import {
  assertOmnyoStagedStateRoot,
  writeJsonFileAtomically,
  type OmnyoStagedStateRoot,
} from "@omnyo/server-archive";

const inventoryName = ".omnyo-builtin-files.json";

const legacyInventoryNameV1 = ".bb-builtin-files.json";

const inventorySchema = z
  .array(
    z
      .object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict(),
  )
  .min(1);

const digest = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

function validPath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\\:\u0000-\u001f]/u.test(path) &&
    path !== inventoryName &&
    path !== legacyInventoryNameV1 &&
    path
      .split("/")
      .every(
        (part) =>
          part.length > 0 &&
          part !== "." &&
          part !== ".." &&
          part !== "node_modules" &&
          part !== ".git",
      )
  );
}

interface BuiltinPluginInventory {
  name: typeof inventoryName | typeof legacyInventoryNameV1;
  raw: Buffer;
  files: z.infer<typeof inventorySchema>;
}

async function readOptionalBuiltinPluginInventory(
  rootDir: string,
): Promise<BuiltinPluginInventory | null> {
  const info = await lstat(rootDir).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });

  if (info === null) return null;

  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Invalid managed bundled plugin directory");

  const [canonical, legacyV1] = await Promise.all(
    [inventoryName, legacyInventoryNameV1].map((name) =>
      lstat(join(rootDir, name)).catch((error: unknown) => {
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

  if (canonical !== null && legacyV1 !== null)
    throw new Error("Ambiguous bundled plugin inventories");
  const selected = canonical ?? legacyV1;

  if (selected === null) return null;

  if (!selected.isFile() || selected.isSymbolicLink())
    throw new Error("Bundled plugin inventory must be a regular file");
  const name = canonical === null ? legacyInventoryNameV1 : inventoryName;
  const raw = await readFile(join(rootDir, name));
  let value: unknown;

  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Invalid bundled plugin inventory");
  }

  const parsed = inventorySchema.safeParse(value);

  if (
    !parsed.success ||
    new Set(parsed.data.map((file) => file.path)).size !== parsed.data.length ||
    parsed.data.some((file) => !validPath(file.path))
  )
    throw new Error("Invalid bundled plugin inventory");

  return { name, raw, files: parsed.data };
}

export async function readBuiltinPluginInventory(
  rootDir: string,
): Promise<BuiltinPluginInventory> {
  const inventory = await readOptionalBuiltinPluginInventory(rootDir);

  if (inventory === null)
    throw new Error("Bundled plugin inventory is missing");

  return inventory;
}

async function validateBuiltEntries(
  rootDir: string,
  manifest: PluginManifest,
): Promise<void> {
  for (const artifact of ["server", "app", "host"] as const) {
    const entry = {
      server: manifest.serverEntry,
      app: manifest.appEntry,
      host: manifest.hostEntry,
    }[artifact];

    if (entry === undefined) continue;

    if (entry !== resolve(rootDir, "dist", `${artifact}.js`))
      throw new Error(
        `Bundled candidate must declare prebuilt dist/${artifact}.js`,
      );
    const entryStat = await lstat(entry);

    if (!entryStat.isFile() || entryStat.isSymbolicLink())
      throw new Error(
        `Bundled candidate entry is not a regular file: ${artifact}`,
      );

    const raw = await readFile(
      join(rootDir, "dist", `${artifact}.meta.json`),
      "utf8",
    );

    if (artifact === "host") {
      const metadata = z
        .object({ artifactDigest: z.string() })
        .parse(JSON.parse(raw));

      if (
        entryStat.size > HOST_ARTIFACT_MAX_BYTES ||
        metadata.artifactDigest !== digest(await readFile(entry))
      )
        throw new Error("Bundled host artifact digest differs");
    }

    const problem = validatePluginArtifactMeta({
      artifact,
      raw,
      pluginId: manifest.id,
      pluginVersion: manifest.version,
    });

    if (problem !== null) throw new Error(problem);
  }
}

export async function verifyBuiltinPluginArtifact(args: {
  db: DbConnection;
  dataDir: string;
  row: InstalledPluginRow;
}): Promise<void> {
  if (args.row.sourceKind !== "builtin" || args.row.activeArtifactId === null)
    return;
  const artifact = getPluginArtifact(args.db, args.row.activeArtifactId);

  const expectedRoot = resolve(
    args.dataDir,
    "plugins",
    "cache",
    "builtin",
    args.row.activeArtifactId,
  );

  if (
    artifact === undefined ||
    artifact.sourceKind !== "builtin" ||
    artifact.pluginId !== args.row.id ||
    artifact.validationResult !== "valid" ||
    resolve(artifact.path) !== expectedRoot ||
    resolve(args.row.rootDir) !== expectedRoot
  )
    throw new Error("Invalid managed bundled plugin registration");

  await verifyBuiltinPluginDirectory(
    expectedRoot,
    artifact.contentHash,
    args.row.id,
    args.row.version,
  );
}

async function verifyBuiltinPluginDirectory(
  expectedRoot: string,
  contentHash: string | null,
  pluginId: string,
  version: string,
): Promise<PluginManifest> {
  if (
    !(await lstat(expectedRoot)).isDirectory() ||
    (await lstat(expectedRoot)).isSymbolicLink()
  )
    throw new Error("Invalid managed bundled plugin directory");
  const inventory = await readBuiltinPluginInventory(expectedRoot);

  if (digest(inventory.raw) !== contentHash)
    throw new Error("Bundled plugin inventory digest differs");

  const expected = new Map(
    inventory.files.map((file) => [file.path, file.sha256]),
  );

  let seen = 0;

  async function visit(relative: string): Promise<void> {
    for (const name of await readdir(join(expectedRoot, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(expectedRoot, path));

      if (stat.isSymbolicLink())
        throw new Error("Bundled plugin symlink refused");

      if (stat.isDirectory()) await visit(path);
      else if (path === inventory.name && stat.isFile()) continue;
      else {
        if (
          !stat.isFile() ||
          expected.get(path) !==
            digest(await readFile(join(expectedRoot, path)))
        )
          throw new Error(`Bundled plugin file digest differs: ${path}`);
        seen++;
      }
    }
  }

  await visit("");

  if (seen !== expected.size)
    throw new Error("Bundled plugin inventory is incomplete");
  const manifest = await readPluginManifest(expectedRoot);

  if (manifest.id !== pluginId || manifest.version !== version)
    throw new Error("Bundled plugin identity differs");
  await validateBuiltEntries(expectedRoot, manifest);

  return manifest;
}

export async function stageBuiltinPluginArtifact(args: {
  db: DbConnection;
  dataDir: string;
  row: InstalledPluginRow;
  bundledRootDir: string;
  candidate: NonNullable<PluginApplyUpdateRequest["bundledCandidate"]>;
  checkCompatibility: (manifest: PluginManifest) => string | undefined;
  identityAdoption?: { stage: OmnyoStagedStateRoot; artifactId: string };
}) {
  const candidate = pluginApplyUpdateRequestSchema.parse({
    bundledCandidate: args.candidate,
  }).bundledCandidate;

  if (candidate === undefined) throw new Error("Bundled candidate required");
  const adoption = args.identityAdoption;

  if (adoption !== undefined) {
    await assertOmnyoStagedStateRoot(adoption.stage);

    if (
      adoption.stage.dataDir !== args.dataDir ||
      !/^identity_v1_[a-f0-9]{64}$/u.test(adoption.artifactId)
    )
      throw new Error("Bundled identity artifact owner differs");
  }

  const id = adoption?.artifactId ?? randomUUID();
  const rootDir = join(args.dataDir, "plugins", "cache", "builtin", id);

  const registeredRoot =
    adoption === undefined
      ? rootDir
      : join(adoption.stage.destinationDataDir, "plugins/cache/builtin", id);

  const paths = new Set<string>();
  let total = 0;

  const files = candidate.files.map((file) => {
    if (!validPath(file.path) || paths.has(file.path))
      throw new Error("Invalid or duplicate bundled plugin path");
    paths.add(file.path);
    const bytes = Buffer.from(file.base64, "base64");
    total += bytes.byteLength;

    if (
      bytes.toString("base64") !== file.base64 ||
      total > MAX_BUNDLED_PLUGIN_BYTES ||
      digest(bytes) !== file.sha256
    )
      throw new Error("Bundled plugin bytes or digest differ");

    return { ...file, bytes };
  });

  const inventory = JSON.stringify(
    files
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((a, b) => a.path.localeCompare(b.path)),
  );

  const existingInventory = await readOptionalBuiltinPluginInventory(rootDir);

  if (
    existingInventory !== null &&
    (adoption === undefined ||
      existingInventory.raw.toString("utf8") !== inventory)
  )
    throw new Error("Bundled identity artifact inventory collision");

  async function ensureIdentityDirectory(path: string): Promise<void> {
    const info = await lstat(path).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });

    if (info !== null && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error("Bundled identity artifact directory collision");

    if (info === null) await mkdir(path);

    if ((await realpath(path)) !== path)
      throw new Error(
        "Bundled identity artifact parent resolves outside its owner",
      );
  }

  if (adoption !== undefined) {
    const receiptPath = join(adoption.stage.jobDir, `builtin-stage-${id}.json`);

    const binding = {
      version: 1,
      migrationId: adoption.stage.migrationId,
      artifactId: id,
      rootDir,
      registeredRoot,
      inventoryDigest: digest(inventory),
    };

    const previous = await readFile(receiptPath, "utf8").then(
      (raw) =>
        z
          .object({
            version: z.literal(1),
            migrationId: z.string(),
            artifactId: z.string(),
            rootDir: z.string(),
            registeredRoot: z.string(),
            inventoryDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          })
          .strict()
          .parse(JSON.parse(raw)),
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

    if (previous === null) {
      if (
        await lstat(rootDir).then(
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
        throw new Error("Bundled identity artifact target collision");
      await writeJsonFileAtomically(receiptPath, binding, true);
    } else if (JSON.stringify(previous) !== JSON.stringify(binding))
      throw new Error("Bundled identity artifact receipt collision");
  }

  if (adoption === undefined) {
    await mkdir(dirname(rootDir), { recursive: true });
    await mkdir(rootDir);
  } else {
    let directory = adoption.stage.dataDir;

    for (const segment of ["plugins", "cache", "builtin", id]) {
      directory = join(directory, segment);
      await ensureIdentityDirectory(directory);
    }
  }

  try {
    for (const file of files) {
      const path = join(rootDir, file.path);

      if (adoption === undefined)
        await mkdir(dirname(path), { recursive: true });
      else {
        let directory = rootDir;

        for (const segment of file.path.split("/").slice(0, -1)) {
          directory = join(directory, segment);
          await ensureIdentityDirectory(directory);
        }
      }

      const existing =
        adoption === undefined
          ? null
          : await lstat(path).catch((error: unknown) => {
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "ENOENT"
              )
                return null;
              throw error;
            });

      if (existing !== null) {
        if (
          !existing.isFile() ||
          existing.isSymbolicLink() ||
          digest(await readFile(path)) !== file.sha256
        )
          throw new Error("Bundled identity artifact partial-write collision");
      } else await writeFile(path, file.bytes, { flag: "wx" });
    }

    const manifest = await readPluginManifest(rootDir);

    if (manifest.id !== args.row.id)
      throw new Error("Bundled candidate plugin id differs");
    const problem = args.checkCompatibility(manifest);

    if (problem !== undefined) throw new Error(problem);
    await validateBuiltEntries(rootDir, manifest);

    const currentInventory = await readOptionalBuiltinPluginInventory(rootDir);

    if (
      currentInventory !== null &&
      currentInventory.raw.toString("utf8") !== inventory
    )
      throw new Error("Bundled identity artifact inventory collision");

    if (currentInventory === null)
      await writeFile(join(rootDir, inventoryName), inventory, { flag: "wx" });
    await verifyBuiltinPluginDirectory(
      rootDir,
      digest(inventory),
      args.row.id,
      manifest.version,
    );
    const previousArtifact = getPluginArtifact(args.db, id);

    if (previousArtifact !== undefined) {
      if (
        previousArtifact.pluginId !== args.row.id ||
        previousArtifact.sourceKind !== "builtin" ||
        previousArtifact.path !== registeredRoot ||
        previousArtifact.contentHash !== digest(inventory) ||
        previousArtifact.bundledRootDir !== args.bundledRootDir
      )
        throw new Error("Bundled identity artifact record collision");
    } else
      createPluginArtifact(args.db, {
        id,
        pluginId: args.row.id,
        sourceKind: "builtin",
        npmResolvedVersion: null,
        gitResolvedCommit: null,
        gitCheckoutRoot: null,
        bundledRootDir: args.bundledRootDir,
        path: registeredRoot,
        integrity: digest(inventory),
        contentHash: digest(inventory),
        validationResult: "valid",
        validatedAt: Date.now(),
      });

    return { artifactId: id, rootDir: registeredRoot, manifest };
  } catch (error) {
    if (adoption === undefined)
      await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

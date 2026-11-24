import { createHash } from "node:crypto";
// oxlint-disable-next-line no-restricted-imports -- Reads coordinator-owned approval and artifact records.
import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  getPluginArtifact,
  installedPlugins,
  type DbConnection,
} from "@omnyo/db";
import { readBuiltinPluginInventory } from "../plugins/builtin-plugin-artifacts.js";
import type { PrivateServerUpdateManifest } from "@omnyo/config/app-update";
import { RELEASE_VERSION_PATTERN } from "@omnyo/config/release-version";
import {
  webBuildSchema,
  webUpdateIdentitySchema,
} from "@omnyo/server-contract";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);

const snapshotSchema = z
  .object({
    webStateSha256: digest.nullable(),
    bundledPlugins: z.array(
      z
        .object({
          id: z.string().min(1),
          rootDir: z.string().refine(isAbsolute),
          inventorySha256: digest,
        })
        .strict(),
    ),
  })
  .strict()
  .refine((snapshot) =>
    snapshot.bundledPlugins.every(
      (plugin, index, plugins) =>
        index === 0 || plugins[index - 1].id < plugin.id,
    ),
  );

const approvalSchema = z
  .object({
    schema: z.literal(1),
    version: z.string().regex(RELEASE_VERSION_PATTERN),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    runtimeSha256: digest,
    snapshot: snapshotSchema,
  })
  .strict();

export type PrivateDeliverySnapshot = z.infer<typeof snapshotSchema>;

export type PrivateDeliveryApproval = z.infer<typeof approvalSchema>;

export interface PrivateDeliveryGuard {
  snapshot(): Promise<PrivateDeliverySnapshot>;
  bundledName(pluginId: string): Promise<string | null>;
  flush(): Promise<void>;
}

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

async function regular(path: string): Promise<Buffer> {
  const info = await lstat(path);

  if (!info.isFile() || info.isSymbolicLink())
    throw new Error("Private delivery records must be regular files.");

  return readFile(path);
}

async function optionalRegular(path: string): Promise<Buffer | null> {
  try {
    return await regular(path);
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      return null;
    throw error;
  }
}

function sameHostMetadata(installed: Buffer, staged: Buffer): boolean {
  const portable = (raw: Buffer) => {
    try {
      const parsed = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(raw.toString("utf8")));

      if (!("buildInputs" in parsed)) return null;
      const { buildInputs: _buildInputs, ...rest } = parsed;

      return JSON.stringify(rest);
    } catch {
      return null;
    }
  };

  const left = portable(installed);

  return left !== null && left === portable(staged);
}

async function runtimeCoversBundledPlugin(args: {
  dataDir: string;
  version: string;
  name: string;
  plugin: PrivateDeliverySnapshot["bundledPlugins"][number];
}): Promise<boolean> {
  const staged = join(
    args.dataDir,
    "app-versions",
    args.version,
    "node_modules",
    "omnyo-app",
    "server",
    "dist",
    "builtin-plugins",
    args.name,
  );

  const inventory = await readBuiltinPluginInventory(args.plugin.rootDir);

  if (hash(inventory.raw) !== args.plugin.inventorySha256) return false;

  for (const file of inventory.files) {
    if (file.path.endsWith(".map") || file.path === "dist/omnyo-source.json")
      continue;

    const [installed, candidate] = await Promise.all([
      optionalRegular(join(args.plugin.rootDir, file.path)),
      optionalRegular(join(staged, file.path)),
    ]);

    if (installed === null || hash(installed) !== file.sha256) return false;

    if (candidate === null) return false;

    if (hash(candidate) === file.sha256) continue;

    if (
      basename(file.path) === "host.meta.json" &&
      sameHostMetadata(installed, candidate)
    )
      continue;

    return false;
  }

  return true;
}

async function webStateHash(dataDir: string): Promise<string | null> {
  try {
    return hash(
      await regular(join(dataDir, "private-web-updates", "active.json")),
    );
  } catch (error) {
    if (z.object({ code: z.literal("ENOENT") }).safeParse(error).success)
      return null;
    throw error;
  }
}

async function runtimeIncludesActiveWeb(args: {
  dataDir: string;
  approval: PrivateDeliveryApproval;
  webStateSha256: string | null;
}): Promise<boolean> {
  const { dataDir, approval, webStateSha256 } = args;
  const webRoot = join(dataDir, "private-web-updates");

  const staged = join(
    dataDir,
    "app-versions",
    approval.version,
    "node_modules",
    "omnyo-app",
  );

  try {
    const stateBytes = await regular(join(webRoot, "active.json"));

    if (hash(stateBytes) !== webStateSha256) return false;

    const state = z
      .object({
        compatibilityHash: digest,
        active: webUpdateIdentitySchema,
      })
      .parse(JSON.parse(stateBytes.toString()));

    const [generationBytes, stagedBuild, identityBytes] = await Promise.all([
      regular(join(webRoot, "generations", state.active.id, "web-build.json")),
      regular(join(staged, "app", "dist", "web-build.json")),
      regular(join(staged, "dist", "runtime-identity.json")),
    ]);

    if (hash(generationBytes) !== state.active.id) return false;

    const generation = webBuildSchema.parse(
      JSON.parse(generationBytes.toString()),
    );

    const candidate = webBuildSchema.parse(JSON.parse(stagedBuild.toString()));

    const identity = z
      .object({ runtimeSha256: digest })
      .parse(JSON.parse(identityBytes.toString()));

    if (
      identity.runtimeSha256 !== approval.runtimeSha256 ||
      candidate.sourceCommit !== approval.sourceCommit ||
      generation.sourceCommit !== state.active.sourceCommit ||
      generation.compatibilityHash !== state.compatibilityHash ||
      candidate.compatibilityHash !== generation.compatibilityHash ||
      candidate.files.length !== generation.files.length
    )
      return false;

    const candidateFiles = new Map(
      candidate.files.map((file) => [file.path, file]),
    );

    return (
      generation.files.every((file) => {
        const packaged = candidateFiles.get(file.path);

        return packaged?.sha256 === file.sha256 && packaged.size === file.size;
      }) && (await webStateHash(dataDir)) === webStateSha256
    );
  } catch {
    return false;
  }
}

export function readBundledPluginName(args: {
  db: DbConnection;
  pluginId: string;
}): string | null {
  const row = args.db
    .select({ name: installedPlugins.sourceBuiltinName })
    .from(installedPlugins)
    .where(
      and(
        eq(installedPlugins.id, args.pluginId),
        eq(installedPlugins.sourceKind, "builtin"),
        isNull(installedPlugins.removedAt),
      ),
    )
    .get();

  return row?.name ?? null;
}

export async function readPrivateDeliverySnapshot(args: {
  dataDir: string;
  db: DbConnection;
}): Promise<PrivateDeliverySnapshot> {
  const plugins = args.db
    .select({
      id: installedPlugins.id,
      rootDir: installedPlugins.rootDir,
      artifactId: installedPlugins.activeArtifactId,
    })
    .from(installedPlugins)
    .where(
      and(
        eq(installedPlugins.sourceKind, "builtin"),
        isNotNull(installedPlugins.activeArtifactId),
        isNull(installedPlugins.removedAt),
      ),
    )
    .all()
    .sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );

  const [webStateSha256, bundledPlugins] = await Promise.all([
    webStateHash(args.dataDir),
    Promise.all(
      plugins.map(async ({ id, rootDir, artifactId }) => {
        if (artifactId === null)
          throw new Error("Invalid managed bundled plugin registration");
        const artifact = getPluginArtifact(args.db, artifactId);

        const expectedRoot = resolve(
          args.dataDir,
          "plugins/cache/builtin",
          artifactId,
        );

        if (
          artifact === undefined ||
          artifact.sourceKind !== "builtin" ||
          artifact.pluginId !== id ||
          artifact.validationResult !== "valid" ||
          resolve(artifact.path) !== expectedRoot ||
          resolve(rootDir) !== expectedRoot
        )
          throw new Error("Invalid managed bundled plugin registration");
        const inventory = await readBuiltinPluginInventory(rootDir);
        const inventorySha256 = hash(inventory.raw);

        if (inventorySha256 !== artifact.contentHash)
          throw new Error("Bundled plugin inventory digest differs");

        return { id, rootDir, inventorySha256 };
      }),
    ),
  ]);

  return snapshotSchema.parse({ webStateSha256, bundledPlugins });
}

export async function verifyPrivateDeliveryApproval(args: {
  dataDir: string;
  manifest: Pick<
    PrivateServerUpdateManifest,
    "version" | "sourceCommit" | "runtimeSha256"
  >;
  guard: PrivateDeliveryGuard;
  expected?: PrivateDeliveryApproval;
}): Promise<PrivateDeliveryApproval> {
  let approval: PrivateDeliveryApproval;

  try {
    approval = approvalSchema.parse(
      JSON.parse(
        (
          await regular(
            join(
              args.dataDir,
              "private-server-update",
              "approved-delivery.json",
            ),
          )
        ).toString("utf8"),
      ),
    );
  } catch {
    throw new Error(
      "This private runtime has no valid delivery approval. Publish a verified runtime before updating.",
    );
  }

  if (
    approval.version !== args.manifest.version ||
    approval.sourceCommit !== args.manifest.sourceCommit ||
    approval.runtimeSha256 !== args.manifest.runtimeSha256 ||
    (args.expected !== undefined &&
      JSON.stringify(approval) !== JSON.stringify(args.expected))
  )
    throw new Error(
      "The private runtime delivery approval changed. Publish a freshly verified offer before updating.",
    );

  const current = await args.guard.snapshot();

  if (JSON.stringify(current) === JSON.stringify(approval.snapshot))
    return approval;

  if (
    current.webStateSha256 !== approval.snapshot.webStateSha256 &&
    !(await runtimeIncludesActiveWeb({
      dataDir: args.dataDir,
      approval,
      webStateSha256: current.webStateSha256,
    }))
  )
    throw new Error(
      "The active web interface changed after this runtime was verified. Publish a fresh runtime that includes it.",
    );

  const verified = new Set(
    approval.snapshot.bundledPlugins.map((plugin) => JSON.stringify(plugin)),
  );

  const missing: string[] = [];

  for (const plugin of current.bundledPlugins) {
    if (verified.has(JSON.stringify(plugin))) continue;
    const name = await args.guard.bundledName(plugin.id);

    if (
      name === null ||
      !/^[a-z0-9-]+$/u.test(name) ||
      !(await runtimeCoversBundledPlugin({
        dataDir: args.dataDir,
        version: approval.version,
        name,
        plugin,
      }))
    )
      missing.push(plugin.id);
  }

  if (missing.length > 0)
    throw new Error(
      `Bundled plugin fixes for ${missing.join(", ")} changed after this runtime was verified and are not in it. Publish a fresh runtime that includes them.`,
    );

  return approval;
}

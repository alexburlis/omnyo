import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isPluginOwnedIconPath, pluginPackageJsonSchema } from "@omnyo/domain";
import {
  MAX_BUNDLED_PLUGIN_BYTES,
  MAX_BUNDLED_PLUGIN_FILES,
  MAX_BUNDLED_PLUGIN_REQUEST_BYTES,
  pluginApplyUpdateRequestSchema,
  type PluginApplyUpdateRequest,
} from "@omnyo/server-contract";
import {
  BUNDLED_PLUGIN_SOURCE_PATH,
  type BundledPluginSourceIdentity,
} from "./bundled-plugin-source.js";

export function bundledCandidateVersion(
  candidate: NonNullable<PluginApplyUpdateRequest["bundledCandidate"]>,
) {
  return pluginPackageJsonSchema.parse(
    JSON.parse(
      Buffer.from(candidate.files[0].base64, "base64").toString("utf8"),
    ),
  ).version;
}

export async function readBundledPluginCandidate(args: {
  directory: string;
  expectedVersion: string;
  expectedArtifactId: string | null;
  sourceIdentity: BundledPluginSourceIdentity | null;
}): Promise<NonNullable<PluginApplyUpdateRequest["bundledCandidate"]>> {
  const root = await realpath(resolve(args.directory));

  const files: NonNullable<
    PluginApplyUpdateRequest["bundledCandidate"]
  >["files"] = [];

  const included = new Set<string>();
  let total = 0;

  async function collect(path: string): Promise<void> {
    const parts = path.replace(/^\.\//u, "").split("/");

    if (
      parts.some(
        (part) => !part || part.startsWith(".") || part === "node_modules",
      ) ||
      path.includes("\\")
    ) {
      throw new Error(`Unsafe runtime file path: ${path}`);
    }

    const canonical = parts.join("/");

    if (included.has(canonical)) return;
    const full = join(root, canonical);

    for (let index = 1; index <= parts.length; index++) {
      const info = await lstat(join(root, ...parts.slice(0, index)));

      if (info.isSymbolicLink())
        throw new Error(`Runtime symlinks are refused: ${canonical}`);
    }

    const info = await lstat(full);

    if (info.isDirectory()) {
      for (const name of (await readdir(full)).sort())
        await collect(`${canonical}/${name}`);

      return;
    }

    if (!info.isFile())
      throw new Error(`Runtime requires regular files: ${canonical}`);

    if (
      files.length >= MAX_BUNDLED_PLUGIN_FILES ||
      info.size > MAX_BUNDLED_PLUGIN_BYTES - total
    ) {
      throw new Error("Bundled plugin runtime exceeds file or byte limits.");
    }

    const bytes = await readFile(full);
    total += bytes.byteLength;

    if (total > MAX_BUNDLED_PLUGIN_BYTES)
      throw new Error("Bundled plugin runtime exceeds byte limit.");
    included.add(canonical);
    files.push({
      path: canonical,
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  await collect("package.json");

  const manifest = pluginPackageJsonSchema.parse(
    JSON.parse(Buffer.from(files[0].base64, "base64").toString("utf8")),
  );

  if (
    manifest.omnyo.server !== "./dist/server.js" ||
    (manifest.omnyo.app !== undefined &&
      manifest.omnyo.app !== "./dist/app.js") ||
    (manifest.omnyo.host !== undefined &&
      manifest.omnyo.host !== "./dist/host.js")
  ) {
    throw new Error(
      "--directory requires a prepared runtime with dist entrypoints; build the bundled runtime first.",
    );
  }

  await collect("dist");

  for (const path of manifest.omnyo.skills ?? []) await collect(path);
  const branding = manifest.omnyo.branding;

  const assets = [
    ...(branding.icon !== undefined && isPluginOwnedIconPath(branding.icon)
      ? [branding.icon]
      : []),
    branding.logo?.light,
    branding.logo?.dark,
    ...Object.values(branding.experimental_icons ?? {}),
  ];

  for (const path of assets) if (path !== undefined) await collect(path);

  for (const theme of manifest.omnyo.themes ?? []) await collect(theme.css);

  if (included.has(BUNDLED_PLUGIN_SOURCE_PATH))
    throw new Error(
      `Prepared runtimes must not contain ${BUNDLED_PLUGIN_SOURCE_PATH}; the update adds it.`,
    );

  if (args.sourceIdentity !== null) {
    const bytes = Buffer.from(`${JSON.stringify(args.sourceIdentity)}\n`);

    if (
      files.length >= MAX_BUNDLED_PLUGIN_FILES ||
      bytes.byteLength > MAX_BUNDLED_PLUGIN_BYTES - total
    )
      throw new Error("Bundled plugin runtime exceeds file or byte limits.");
    files.push({
      path: BUNDLED_PLUGIN_SOURCE_PATH,
      base64: bytes.toString("base64"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const bundledCandidate = {
    expectedVersion: args.expectedVersion,
    expectedArtifactId: args.expectedArtifactId,
    files,
  };

  const request = pluginApplyUpdateRequestSchema.parse({ bundledCandidate });

  if (
    Buffer.byteLength(JSON.stringify(request)) >
    MAX_BUNDLED_PLUGIN_REQUEST_BYTES
  )
    throw new Error("Bundled plugin request exceeds byte limit.");

  return bundledCandidate;
}

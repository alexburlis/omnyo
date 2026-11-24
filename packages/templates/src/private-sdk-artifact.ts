import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";

export interface PrivateSdkArtifact {
  artifactPath: string;
  file: string;
  version: string;
  sha256: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function optionalPackage(
  directory: string,
): Promise<Record<string, unknown> | null> {
  let text: string;

  try {
    text = await readFile(join(directory, "package.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }

  const value: unknown = JSON.parse(text);

  if (!record(value))
    throw new Error("Private SDK package owner has invalid metadata");

  return value;
}

export async function readPrivateSdkArtifact(
  directory: string,
): Promise<PrivateSdkArtifact> {
  const manifestPath = join(directory, "manifest.json");
  const info = await lstat(manifestPath);

  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
    throw new Error("Private SDK manifest is not an owned regular file");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));

  if (
    !record(value) ||
    Object.keys(value).sort().join(",") !==
      "file,packageName,schema,sha256,version" ||
    value.schema !== 1 ||
    value.packageName !== "@omnyo/plugin-sdk" ||
    value.version !== PLUGIN_SDK_VERSION ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    value.file !==
      `omnyo-plugin-sdk-${PLUGIN_SDK_VERSION}-${value.sha256.slice(0, 12)}.tgz`
  )
    throw new Error(
      "Private SDK artifact identity or manifest differs from this runtime",
    );

  const artifact: PrivateSdkArtifact = {
    artifactPath: join(directory, value.file),
    file: value.file,
    version: PLUGIN_SDK_VERSION,
    sha256: value.sha256,
  };

  await readArtifactBytes(artifact);

  return artifact;
}

async function readArtifactBytes(
  artifact: PrivateSdkArtifact,
): Promise<Buffer> {
  const info = await lstat(artifact.artifactPath);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size === 0 ||
    info.size > 10 * 1024 * 1024
  )
    throw new Error("Private SDK artifact is not a bounded regular file");
  const bytes = await readFile(artifact.artifactPath);

  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256)
    throw new Error("Private SDK artifact digest differs from its manifest");

  return bytes;
}

export async function resolvePrivateSdkArtifact(args: {
  cliDirectory?: string;
  sourceUrl: string;
}): Promise<PrivateSdkArtifact> {
  const starts = [dirname(fileURLToPath(args.sourceUrl))];

  if (args.cliDirectory !== undefined) {
    if (!isAbsolute(args.cliDirectory))
      throw new Error("The runtime CLI directory must be absolute");
    starts.unshift(args.cliDirectory);
  }

  const visited = new Set<string>();

  for (const start of starts) {
    let current = resolve(start);

    while (!visited.has(current)) {
      visited.add(current);
      const manifest = await optionalPackage(current);

      if (manifest?.name === "omnyo-app") {
        if (manifest.private !== true)
          throw new Error("Private SDK runtime owner is not private");

        return readPrivateSdkArtifact(join(current, "dist", "plugin-sdk"));
      }

      if (manifest?.name === "omnyo") {
        const workspace = await lstat(join(current, "pnpm-workspace.yaml"));

        if (!workspace.isFile() || workspace.isSymbolicLink())
          throw new Error("Private SDK source workspace identity differs");
        const owners: string[] = [];

        for (const entry of await readdir(join(current, "packages"), {
          withFileTypes: true,
        })) {
          if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
          const packageRoot = join(current, "packages", entry.name);
          const candidate = await optionalPackage(packageRoot);

          if (
            candidate?.name === "@omnyo/plugin-sdk" &&
            candidate.private === true
          )
            owners.push(packageRoot);
        }

        if (owners.length !== 1)
          throw new Error(
            "Private SDK source package owner is missing or ambiguous",
          );

        return readPrivateSdkArtifact(join(owners[0]!, "private-artifact"));
      }

      const parent = dirname(current);

      if (parent === current) break;
      current = parent;
    }
  }

  throw new Error(
    "The selected Omnyo runtime has no verified private SDK artifact",
  );
}

export async function installPrivateSdkArtifact(
  rootDir: string,
  artifact: PrivateSdkArtifact,
): Promise<string> {
  if (
    artifact.version !== PLUGIN_SDK_VERSION ||
    artifact.file !==
      `omnyo-plugin-sdk-${artifact.version}-${artifact.sha256.slice(0, 12)}.tgz` ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256)
  )
    throw new Error("Private SDK input identity differs from this runtime");
  const bytes = await readArtifactBytes(artifact);
  const vendor = join(rootDir, "vendor");
  await mkdir(vendor, { recursive: true });
  const directory = await lstat(vendor);

  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("Private SDK vendor directory is not owned by this plugin");
  const target = join(vendor, artifact.file);

  try {
    await writeFile(target, bytes, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    await readArtifactBytes({ ...artifact, artifactPath: target });
  }

  await readArtifactBytes({ ...artifact, artifactPath: target });

  return `file:./vendor/${artifact.file}`;
}

export async function privateSdkDependencyPin(
  artifact: PrivateSdkArtifact,
): Promise<string> {
  const selected = await readPrivateSdkArtifact(dirname(artifact.artifactPath));

  if (
    selected.artifactPath !== artifact.artifactPath ||
    selected.file !== artifact.file ||
    selected.version !== artifact.version ||
    selected.sha256 !== artifact.sha256
  )
    throw new Error("The selected private SDK artifact identity changed");

  return `file:./vendor/${selected.file}`;
}

export async function privateSdkArtifactCopyNeeded(
  rootDir: string,
  artifact: PrivateSdkArtifact,
): Promise<boolean> {
  await privateSdkDependencyPin(artifact);
  const vendor = join(rootDir, "vendor");

  try {
    const directory = await lstat(vendor);

    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Private SDK vendor directory is not regular");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return true;
    throw error;
  }

  const target = join(vendor, artifact.file);

  try {
    await readArtifactBytes({ ...artifact, artifactPath: target });

    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return true;
    throw error;
  }
}

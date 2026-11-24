import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export function parsePrivateSdkArtifactManifest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "file,packageName,schema,sha256,version" ||
    value.schema !== 1 ||
    value.packageName !== "@omnyo/plugin-sdk" ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(value.version) ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    value.file !==
      `omnyo-plugin-sdk-${value.version}-${value.sha256.slice(0, 12)}.tgz`
  )
    throw new Error("Invalid private SDK artifact manifest");

  return value;
}

export async function verifyPrivateSdkArtifact(directory) {
  const manifestPath = join(directory, "manifest.json");
  const manifestStat = await lstat(manifestPath);

  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 4096
  )
    throw new Error("Private SDK manifest is not an owned regular file");

  const manifest = parsePrivateSdkArtifactManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );

  const artifactPath = join(directory, manifest.file);
  const info = await lstat(artifactPath);

  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size === 0 ||
    info.size > 10 * 1024 * 1024
  )
    throw new Error("Private SDK artifact is not a bounded regular file");
  const bytes = await readFile(artifactPath);

  if (createHash("sha256").update(bytes).digest("hex") !== manifest.sha256)
    throw new Error("Private SDK artifact digest differs from its manifest");

  return { manifest, artifactPath };
}

export async function copyPrivateSdkArtifact(sourceDirectory, targetDirectory) {
  const { manifest, artifactPath } =
    await verifyPrivateSdkArtifact(sourceDirectory);

  await mkdir(targetDirectory, { recursive: true });
  const targetPath = join(targetDirectory, manifest.file);

  try {
    await copyFile(
      artifactPath,
      targetPath,
      constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const target = await lstat(targetPath);

    if (
      !target.isFile() ||
      target.isSymbolicLink() ||
      createHash("sha256")
        .update(await readFile(targetPath))
        .digest("hex") !== manifest.sha256
    )
      throw new Error("Private SDK target artifact collision");
  }

  const temporary = join(targetDirectory, `manifest.${process.pid}.pending`);
  await writeFile(temporary, `${JSON.stringify(manifest)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  await rename(temporary, join(targetDirectory, "manifest.json"));

  return verifyPrivateSdkArtifact(targetDirectory);
}

export function orderPrivateSdkDevelopmentDependencies(
  manifest,
  preferredOrder,
) {
  if (
    manifest?.name !== "@omnyo/plugin-sdk" ||
    manifest.private !== true ||
    manifest.publishConfig !== undefined ||
    !Array.isArray(preferredOrder) ||
    preferredOrder.some(
      (name) => typeof name !== "string" || name.length === 0,
    ) ||
    new Set(preferredOrder).size !== preferredOrder.length
  )
    throw new Error("Private SDK beforePacking identity differs");

  if (manifest.devDependencies === undefined) return manifest;

  const dependencies = manifest.devDependencies;

  if (
    dependencies === null ||
    typeof dependencies !== "object" ||
    Array.isArray(dependencies) ||
    Object.values(dependencies).some((value) => typeof value !== "string")
  )
    throw new Error("Private SDK beforePacking dependency metadata differs");

  const rank = new Map(preferredOrder.map((name, index) => [name, index]));

  const keys = Object.keys(dependencies).sort((left, right) => {
    const first = rank.get(left),
      second = rank.get(right);

    if (first !== undefined && second !== undefined) return first - second;

    if (first !== undefined) return -1;

    if (second !== undefined) return 1;

    return left < right ? -1 : left > right ? 1 : 0;
  });

  return {
    ...manifest,
    devDependencies: Object.fromEntries(
      keys.map((name) => [name, dependencies[name]]),
    ),
  };
}

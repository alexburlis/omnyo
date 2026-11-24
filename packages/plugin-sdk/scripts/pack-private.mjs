import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  copyPrivateSdkArtifact,
  verifyPrivateSdkArtifact,
} from "./private-artifact.mjs";

const execute = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const manifest = JSON.parse(
  await readFile(join(packageRoot, "package.json"), "utf8"),
);

if (
  manifest.name !== "@omnyo/plugin-sdk" ||
  manifest.private !== true ||
  manifest.publishConfig !== undefined
)
  throw new Error("Private SDK package identity or publication policy differs");

for (const declaration of Object.values(manifest.exports)) {
  for (const key of ["types", "import", "default"]) {
    const file = declaration[key];

    if (
      typeof file !== "string" ||
      !/^\.\/(?:dist|bundled-types)\/[a-zA-Z0-9_./-]+$/u.test(file) ||
      file.includes("..")
    )
      throw new Error("Private SDK export has an unowned packed path");
    await access(join(packageRoot, file));
  }
}

const pnpm = process.env.npm_execpath;

if (typeof pnpm !== "string" || !/pnpm\.(?:c?js)$/u.test(pnpm))
  throw new Error(
    "Private SDK packing requires the repository's pnpm task owner",
  );

const workspaceRoot = resolve(packageRoot, "../..");

const outputDirectory = join(packageRoot, "private-artifact");

const configuration = async (name) => {
  const result = await execute(
    process.execPath,
    [
      pnpm,
      ...(name === "ignore-pnpmfile" ? [] : ["--config.ignore-pnpmfile=true"]),
      "config",
      "get",
      name,
      "--json",
    ],
    { cwd: packageRoot, timeout: 5000, maxBuffer: 65536 },
  );

  const value = result.stdout.trim();

  return value === "" || value === "undefined" ? undefined : JSON.parse(value);
};

const selectedOrder = async () => {
  const previousManifest = await lstat(
    join(outputDirectory, "manifest.json"),
  ).catch((error) => {
    if (error.code !== "ENOENT") throw error;

    return null;
  });

  if (previousManifest === null) return [];
  const selected = await verifyPrivateSdkArtifact(outputDirectory);

  const result = await execute(
    process.platform === "win32" ? "tar.exe" : "/usr/bin/tar",
    ["-xOf", selected.artifactPath, "package/package.json"],
    { timeout: 5000, maxBuffer: 1024 * 1024 },
  );

  const previous = JSON.parse(result.stdout);

  if (
    previous.name !== selected.manifest.packageName ||
    previous.version !== selected.manifest.version ||
    previous.private !== true ||
    previous.publishConfig !== undefined ||
    previous.devDependencies === null ||
    typeof previous.devDependencies !== "object" ||
    Array.isArray(previous.devDependencies)
  )
    throw new Error("Private SDK selected package metadata differs");

  return Object.keys(previous.devDependencies);
};

const [configuredPnpmfiles, ignoredPnpmfiles, preferredOrder] =
  await Promise.all([
    configuration("pnpmfile"),
    configuration("ignore-pnpmfile"),
    selectedOrder(),
  ]);

if (ignoredPnpmfiles === true)
  throw new Error("Private SDK beforePacking hooks must remain enabled");

const existingHooks =
  configuredPnpmfiles === undefined || configuredPnpmfiles === null
    ? []
    : typeof configuredPnpmfiles === "string"
      ? [configuredPnpmfiles]
      : configuredPnpmfiles;

if (
  !Array.isArray(existingHooks) ||
  existingHooks.some((path) => typeof path !== "string" || path.length === 0)
)
  throw new Error("Private SDK pnpm hook configuration differs");

const hookPaths = existingHooks.map((path) =>
  isAbsolute(path) ? path : resolve(workspaceRoot, path),
);

if (configuredPnpmfiles === undefined || configuredPnpmfiles === null) {
  const defaultHook = join(workspaceRoot, ".pnpmfile.cjs");

  const entry = await lstat(defaultHook).catch((error) => {
    if (error.code !== "ENOENT") throw error;

    return null;
  });

  if (entry !== null) hookPaths.push(defaultHook);
}

await mkdir(outputDirectory, { recursive: true });

const stage = await mkdtemp(join(outputDirectory, ".private-pack-"));

try {
  const packed = join(stage, "candidate.tgz");
  const hookPath = join(stage, "private-sdk-before-packing.cjs");

  const owner = pathToFileURL(
    join(packageRoot, "scripts/private-artifact.mjs"),
  ).href;

  await writeFile(
    hookPath,
    `exports.hooks={beforePacking:async(manifest,directory)=>{if(directory!==${JSON.stringify(packageRoot)})throw Error("Private SDK beforePacking directory differs");const owner=await import(${JSON.stringify(owner)});return owner.orderPrivateSdkDevelopmentDependencies(manifest,${JSON.stringify(preferredOrder)});}};\n`,
    { flag: "wx", mode: 0o600 },
  );

  await execute(
    process.execPath,
    [
      pnpm,
      "--config.ignore-scripts=true",
      ...[...hookPaths, hookPath].map((path) => "--config.pnpmfile=" + path),
      "pack",
      "--json",
      "--out",
      packed,
    ],
    {
      cwd: packageRoot,
      timeout: 45_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const bytes = await readFile(packed);
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  const artifact = {
    schema: 1,
    packageName: manifest.name,
    version: manifest.version,
    file: `omnyo-plugin-sdk-${manifest.version}-${sha256.slice(0, 12)}.tgz`,
    sha256,
  };

  await rename(packed, join(stage, artifact.file));
  await writeFile(
    join(stage, "manifest.json"),
    `${JSON.stringify(artifact)}\n`,
    { flag: "wx" },
  );
  await copyPrivateSdkArtifact(stage, outputDirectory);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
} finally {
  await rm(stage, { recursive: true, force: true });
}

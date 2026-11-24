import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import semverCompare from "semver/functions/compare.js";
import minVersion from "semver/ranges/min-version.js";
import {
  derivePluginId,
  INBOX_CORE_EVENT_FAMILIES,
  INBOX_EVENT_FAMILY_PATTERN,
  PLUGIN_SDK_VERSION,
} from "@omnyo/domain";
import {
  installPrivateSdkArtifact,
  privateSdkDependencyPin,
  privateSdkArtifactCopyNeeded,
  type PrivateSdkArtifact,
} from "./private-sdk-artifact.js";
import {
  importLegacySdkManifestV1,
  LEGACY_SDK_PACKAGE_NAMES_V1,
  LEGACY_VENDORED_DECLARATIONS_V1,
  rewriteLegacySdkSourceV1,
} from "./legacy-plugin-sdk-layout-v1.js";

export { resolvePrivateSdkArtifact } from "./private-sdk-artifact.js";

import {
  PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
  PLUGIN_STARTER_DEPENDENCIES,
  PLUGIN_STARTER_FILES,
  PLUGIN_REGISTRY_FILES,
} from "./generated/plugin-starter-files.generated.js";

interface ScaffoldPluginArgs {
  targetDir: string;
  packageName: string;
  appVersion: string;
  sdkArtifact: PrivateSdkArtifact;
}

interface PluginSdkLayout {
  kind: "vendored" | "package";
  pin: string | null;
}

export async function resolvePluginSdkLayout(
  rootDir: string,
): Promise<PluginSdkLayout> {
  const manifest = await readJsonFile(join(rootDir, "package.json"));
  const pin = manifest === null ? null : readSdkPinFrom(manifest).version;

  const legacyPackage =
    manifest !== null &&
    ["dependencies", "devDependencies"].some((field) =>
      LEGACY_SDK_PACKAGE_NAMES_V1.some(
        (name) => asRecord(manifest[field])[name] !== undefined,
      ),
    );

  const [hasBackend, hasApp, hasPathMap] = await Promise.all([
    pathExists(join(rootDir, "types", LEGACY_VENDORED_DECLARATIONS_V1[0])),
    pathExists(join(rootDir, "types", LEGACY_VENDORED_DECLARATIONS_V1[1])),
    tsconfigMapsSdk(rootDir),
  ]);

  return {
    kind:
      legacyPackage || hasBackend || hasApp || hasPathMap
        ? "vendored"
        : "package",
    pin,
  };
}

const SDK_PATH_MAP_PREFIXES = LEGACY_SDK_PACKAGE_NAMES_V1;

const VENDORED_DECLARATIONS = LEGACY_VENDORED_DECLARATIONS_V1;

const PLUGIN_SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

const UNSCANNED_DIRECTORIES = new Set([
  "dist",
  "node_modules",
  ".git",
  "types",
  "vendor",
]);

const MAX_SOURCE_SCAN_DEPTH = 12;

interface MigratePluginArgs {
  rootDir: string;
  sdkArtifact: PrivateSdkArtifact;
  dryRun?: boolean;
}

export interface PluginPackageLayoutMigration {
  changed: boolean;
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  enginesFloor: { from: string | null; to: string } | null;
  removedPathMaps: string[];
  removedIncludes: string[];
  archivedFiles: string[];
  removedTypesDir: boolean;
  rewrittenImports: RewrittenSdkImportFile[];
  inputDigest: string;
  artifactCopyRequired: boolean;
}

interface RewrittenSdkImportFile {
  path: string;
  imports: number;
  sha256: string;
}

export async function migratePluginToPackageLayout(
  args: MigratePluginArgs,
): Promise<PluginPackageLayoutMigration> {
  const { rootDir, sdkArtifact, dryRun = false } = args;
  const sdkPin = await privateSdkDependencyPin(sdkArtifact);

  const manifestPlan = await planManifest(
    rootDir,
    sdkPin,
    sdkArtifact.version,
    {
      raiseFloor: true,
      shimmedTypePins: "none",
    },
  );

  const typesPlan = await planLegacyDeclarationArchiveV1(rootDir);

  const tsconfigPlan = await planTsconfig(rootDir, {
    removeTypesIncludes: typesPlan.removedTypesDir,
  });

  const importPlan = await planSdkImportRewrites(rootDir);

  const artifactCopyRequired = await privateSdkArtifactCopyNeeded(
    rootDir,
    sdkArtifact,
  );

  const result: PluginPackageLayoutMigration = {
    changed:
      artifactCopyRequired ||
      manifestPlan.text !== null ||
      tsconfigPlan.text !== null ||
      typesPlan.archivedFiles.length > 0 ||
      typesPlan.removedTypesDir ||
      importPlan.length > 0,
    pin: manifestPlan.pin,
    movedFromDependencies: manifestPlan.movedFromDependencies,
    enginesFloor: manifestPlan.enginesFloor,
    removedPathMaps: tsconfigPlan.removedPathMaps,
    removedIncludes: tsconfigPlan.removedIncludes,
    archivedFiles: typesPlan.archivedFiles,
    removedTypesDir: typesPlan.removedTypesDir,
    rewrittenImports: importPlan,
    artifactCopyRequired,
    inputDigest: createHash("sha256")
      .update(
        JSON.stringify({
          manifest: await readFile(join(rootDir, "package.json"), "utf8"),
          tsconfig:
            (await statNoFollow(
              join(rootDir, "tsconfig.json"),
              "tsconfig.json",
            )) === null
              ? null
              : await readFile(join(rootDir, "tsconfig.json"), "utf8"),
          declarations: typesPlan.files,
          imports: importPlan,
        }),
      )
      .digest("hex"),
  };

  if (dryRun) return result;

  await installPrivateSdkArtifact(rootDir, sdkArtifact);

  if (manifestPlan.text !== null) {
    await writeJsonFileAtomically(rootDir, "package.json", manifestPlan.text);
  }

  const typesDir = join(rootDir, "types");

  for (const file of typesPlan.files) {
    await assertWritableTypesDir(rootDir, typesDir);
    const source = join(rootDir, file.path);
    const target = join(rootDir, "vendor", "legacy-plugin-sdk-v1", file.name);
    const current = await readFile(source);

    if (createHash("sha256").update(current).digest("hex") !== file.sha256)
      throw new Error(`Vendored declaration changed: ${file.path}`);
    await mkdir(dirname(target), { recursive: true });
    const directory = await lstat(dirname(target));

    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error("Legacy SDK archive directory is not regular");

    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }

    const targetInfo = await lstat(target);

    if (
      !targetInfo.isFile() ||
      targetInfo.isSymbolicLink() ||
      !(await readFile(target)).equals(current)
    )
      throw new Error(`Legacy SDK archive collision: ${file.path}`);
    await rm(source);
  }

  if (typesPlan.removedTypesDir) {
    await assertWritableTypesDir(rootDir, typesDir);
    await rmdir(typesDir).catch(() => undefined);
    result.removedTypesDir = (await statNoFollow(typesDir, "types")) === null;
  }

  const appliedTsconfigPlan =
    typesPlan.removedTypesDir && !result.removedTypesDir
      ? await planTsconfig(rootDir, { removeTypesIncludes: false })
      : tsconfigPlan;

  result.removedIncludes = appliedTsconfigPlan.removedIncludes;

  if (appliedTsconfigPlan.text !== null) {
    await writeJsonFileAtomically(
      rootDir,
      "tsconfig.json",
      appliedTsconfigPlan.text,
    );
  }

  for (const file of importPlan) {
    const current = await readFile(join(rootDir, file.path));

    if (createHash("sha256").update(current).digest("hex") !== file.sha256)
      throw new Error(`Plugin source changed: ${file.path}`);
    await rewriteSdkImportsInFile(rootDir, file.path);
  }

  return result;
}

async function rewriteSdkImportsInFile(
  rootDir: string,
  relativePath: string,
): Promise<void> {
  const filePath = join(rootDir, ...relativePath.split("/"));
  await assertInsidePlugin(rootDir, dirname(filePath), relativePath);
  const stats = await statNoFollow(filePath, relativePath);

  if (stats === null || !stats.isFile()) return;
  const current = await readFile(filePath, "utf8");
  const rewritten = rewriteLegacySdkSourceV1(relativePath, current);

  if (rewritten.imports === 0) return;
  await writeFileAtomically(filePath, relativePath, rewritten.text);
}

async function planSdkImportRewrites(
  rootDir: string,
): Promise<RewrittenSdkImportFile[]> {
  const found: RewrittenSdkImportFile[] = [];

  const walk = async (
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> => {
    if (depth > MAX_SOURCE_SCAN_DEPTH)
      throw new Error(`Plugin source exceeds scan depth: ${prefix}`);

    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;

      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;

      if (entry.isDirectory()) {
        if (UNSCANNED_DIRECTORIES.has(entry.name)) continue;

        if (entry.name.startsWith(".")) continue;
        await walk(join(dir, entry.name), relativePath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      if (!PLUGIN_SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        continue;
      }

      const content = await readFile(join(dir, entry.name), "utf8");
      const { imports } = rewriteLegacySdkSourceV1(relativePath, content);

      if (imports > 0)
        found.push({
          path: relativePath,
          imports,
          sha256: createHash("sha256").update(content).digest("hex"),
        });
    }
  };

  await walk(rootDir, "", 0);
  found.sort((left, right) => (left.path < right.path ? -1 : 1));

  return found;
}

async function assertInsidePlugin(
  rootDir: string,
  path: string,
  label: string,
): Promise<void> {
  const [realRoot, realPath] = await Promise.all([
    realpath(rootDir),
    realpath(path),
  ]);

  const rel = relative(realRoot, realPath);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the plugin (${realPath})`);
  }
}

interface SetPluginSdkPinArgs {
  rootDir: string;
  sdkArtifact: PrivateSdkArtifact;
  dryRun?: boolean;
}

export interface ShimmedTypePinChange {
  name: string;
  from: string | null;
  to: string;
  movedFromDependencies: boolean;
}

interface PluginSdkPinChange {
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  shimmedTypePins: ShimmedTypePinChange[];
  artifactCopyRequired: boolean;
}

export async function setPluginSdkPin(
  args: SetPluginSdkPinArgs,
): Promise<PluginSdkPinChange | null> {
  const { rootDir, sdkArtifact, dryRun = false } = args;
  const sdkPin = await privateSdkDependencyPin(sdkArtifact);

  const plan = await planManifest(rootDir, sdkPin, sdkArtifact.version, {
    raiseFloor: false,
    shimmedTypePins: "declared",
  });

  const artifactCopyRequired = await privateSdkArtifactCopyNeeded(
    rootDir,
    sdkArtifact,
  );

  if (!dryRun) {
    await installPrivateSdkArtifact(rootDir, sdkArtifact);

    if (plan.text !== null)
      await writeJsonFileAtomically(rootDir, "package.json", plan.text);
  }

  if (plan.text === null && !artifactCopyRequired) return null;

  return {
    pin: plan.pin,
    movedFromDependencies: plan.movedFromDependencies,
    shimmedTypePins: plan.shimmedTypePins,
    artifactCopyRequired,
  };
}

interface ManifestPlan {
  pin: { from: string | null; to: string } | null;
  movedFromDependencies: boolean;
  shimmedTypePins: ShimmedTypePinChange[];
  enginesFloor: { from: string | null; to: string } | null;
  text: string | null;
}

type ShimmedTypePinPolicy = "none" | "declared";

async function planManifest(
  rootDir: string,
  sdkPin: string,
  sdkVersion: string,
  options: { raiseFloor: boolean; shimmedTypePins: ShimmedTypePinPolicy },
): Promise<ManifestPlan> {
  const path = join(rootDir, "package.json");
  await statNoFollow(path, "package.json");
  let raw: string;

  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error("package.json could not be read");
  }

  let manifest: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }

    manifest = parsed as Record<string, unknown>;
  } catch {
    throw new Error("package.json is not valid JSON");
  }

  const original = JSON.stringify(manifest);
  const declaredPin = readSdkPinFrom(manifest);
  manifest = importLegacySdkManifestV1(manifest);

  const pin =
    declaredPin.version === sdkPin
      ? null
      : { from: declaredPin.version, to: sdkPin };

  const movedFromDependencies = declaredPin.inDependencies;

  for (const field of ["dependencies", "devDependencies"] as const) {
    const dependencies = { ...asRecord(manifest[field]) };

    for (const name of [...LEGACY_SDK_PACKAGE_NAMES_V1, "@omnyo/plugin-sdk"])
      delete dependencies[name];

    if (Object.keys(dependencies).length === 0) delete manifest[field];
    else manifest[field] = dependencies;
  }

  manifest.devDependencies = insertDependency(
    asRecord(manifest.devDependencies),
    "@omnyo/plugin-sdk",
    sdkPin,
  );

  const shimmedTypePins = applyShimmedTypePins(
    manifest,
    options.shimmedTypePins,
  );

  let enginesFloor: ManifestPlan["enginesFloor"] = null;

  if (options.raiseFloor) {
    const engines = asRecord(manifest.engines);
    const current = engines.omnyoPluginSdk;
    const from = typeof current === "string" ? current : null;

    if (isFloorBelow(from, sdkVersion)) {
      enginesFloor = { from, to: `>=${sdkVersion}` };
      manifest.engines = { ...engines, omnyoPluginSdk: `>=${sdkVersion}` };
    }
  }

  if (original === JSON.stringify(manifest)) {
    return {
      pin: null,
      movedFromDependencies: false,
      shimmedTypePins: [],
      enginesFloor: null,
      text: null,
    };
  }

  return {
    pin,
    movedFromDependencies,
    shimmedTypePins,
    enginesFloor,
    text: reserialize(raw, manifest),
  };
}

function applyShimmedTypePins(
  manifest: Record<string, unknown>,
  policy: ShimmedTypePinPolicy,
): ShimmedTypePinChange[] {
  if (policy === "none") return [];
  const changes: ShimmedTypePinChange[] = [];
  const deps = asRecord(manifest.dependencies);
  let devDeps = asRecord(manifest.devDependencies);
  let depsChanged = false;

  for (const [name, hostVersion] of Object.entries(
    PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
  )) {
    const runtimeDeclared = deps[name];
    const devDeclared = devDeps[name];
    const inDependencies = typeof runtimeDeclared === "string";

    const declared =
      typeof devDeclared === "string"
        ? devDeclared
        : inDependencies
          ? runtimeDeclared
          : null;

    if (declared === null) continue;

    if (declared === hostVersion && !inDependencies) continue;
    changes.push({
      name,
      from: declared,
      to: hostVersion,
      movedFromDependencies: inDependencies,
    });

    if (inDependencies) {
      delete deps[name];
      depsChanged = true;
    }

    devDeps = insertDependency(devDeps, name, hostVersion);
  }

  if (changes.length === 0) return [];

  if (depsChanged) {
    if (Object.keys(deps).length === 0) {
      delete manifest.dependencies;
    } else {
      manifest.dependencies = deps;
    }
  }

  manifest.devDependencies = devDeps;

  return changes;
}

function readSdkPinFrom(manifest: Record<string, unknown>): {
  inDependencies: boolean;
  version: string | null;
} {
  const declarations: { field: string; version: string }[] = [];

  for (const field of ["devDependencies", "dependencies"] as const) {
    for (const name of ["@omnyo/plugin-sdk", ...LEGACY_SDK_PACKAGE_NAMES_V1]) {
      const value = asRecord(manifest[field])[name];

      if (value !== undefined && typeof value !== "string")
        throw new Error("SDK dependency pin must be a string");

      if (typeof value === "string")
        declarations.push({ field, version: value });
    }
  }

  const selected = declarations[0];

  if (declarations.some((entry) => entry.version !== selected?.version))
    throw new Error("Conflicting legacy and canonical SDK dependency pins");

  return {
    inDependencies: declarations.some(
      (entry) => entry.field === "dependencies",
    ),
    version: selected?.version ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function insertDependency(
  deps: Record<string, unknown>,
  name: string,
  version: string,
): Record<string, unknown> {
  if (name in deps) return { ...deps, [name]: version };
  const keys = Object.keys(deps);

  const sorted = keys.every(
    (key, index) => index === 0 || keys[index - 1]! < key,
  );

  if (!sorted) return { ...deps, [name]: version };
  const next: Record<string, unknown> = {};
  let inserted = false;

  for (const key of keys) {
    if (!inserted && name < key) {
      next[name] = version;
      inserted = true;
    }

    next[key] = deps[key];
  }

  if (!inserted) next[name] = version;

  return next;
}

function isFloorBelow(range: string | null, version: string): boolean {
  if (range === null || range.trim().length === 0) return true;

  try {
    const floor = minVersion(range);

    return floor !== null && semverCompare(floor, version) < 0;
  } catch {
    return false;
  }
}

interface TsconfigPlan {
  removedPathMaps: string[];
  removedIncludes: string[];
  text: string | null;
}

function isSdkPathMapKey(key: string): boolean {
  return SDK_PATH_MAP_PREFIXES.some(
    (name) => key === name || key.startsWith(`${name}/`),
  );
}

async function planTsconfig(
  rootDir: string,
  options: { removeTypesIncludes: boolean },
): Promise<TsconfigPlan> {
  const empty: TsconfigPlan = {
    removedPathMaps: [],
    removedIncludes: [],
    text: null,
  };

  const path = join(rootDir, "tsconfig.json");

  if ((await statNoFollow(path, "tsconfig.json")) === null) return empty;
  const raw = await readFile(path, "utf8");
  let tsconfig: Record<string, unknown>;

  try {
    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("not an object");
    }

    tsconfig = parsed as Record<string, unknown>;
  } catch {
    throw new Error(
      "tsconfig.json is not valid JSON — remove the @get-bb/plugin-sdk paths entry by hand",
    );
  }

  const compilerOptions = asRecord(tsconfig.compilerOptions);
  const paths = asRecord(compilerOptions.paths);
  const removedPathMaps = Object.keys(paths).filter(isSdkPathMapKey);
  const include = Array.isArray(tsconfig.include) ? tsconfig.include : null;

  const removedIncludes =
    include === null || !options.removeTypesIncludes
      ? []
      : include.filter(
          (entry): entry is string =>
            typeof entry === "string" &&
            (entry === "types" || entry.startsWith("types/")),
        );

  if (removedPathMaps.length === 0 && removedIncludes.length === 0) {
    return empty;
  }

  if (removedPathMaps.length > 0) {
    const nextPaths = Object.fromEntries(
      Object.entries(paths).filter(([key]) => !removedPathMaps.includes(key)),
    );

    if (Object.keys(nextPaths).length === 0) {
      delete compilerOptions.paths;
    } else {
      compilerOptions.paths = nextPaths;
    }

    tsconfig.compilerOptions = compilerOptions;
  }

  if (removedIncludes.length > 0 && include !== null) {
    tsconfig.include = include.filter(
      (entry) => typeof entry !== "string" || !removedIncludes.includes(entry),
    );
  }

  return {
    removedPathMaps,
    removedIncludes,
    text: reserialize(raw, tsconfig),
  };
}

async function planLegacyDeclarationArchiveV1(rootDir: string): Promise<{
  archivedFiles: string[];
  removedTypesDir: boolean;
  files: { path: string; name: string; sha256: string }[];
}> {
  const typesDir = join(rootDir, "types");
  await assertWritableTypesDir(rootDir, typesDir);

  if ((await statNoFollow(typesDir, "types")) === null)
    return { archivedFiles: [], removedTypesDir: false, files: [] };
  const files: { path: string; name: string; sha256: string }[] = [];

  for (const name of VENDORED_DECLARATIONS) {
    const path = `types/${name}`;
    const stats = await statNoFollow(join(rootDir, path), path);

    if (stats === null) continue;

    if (!stats.isFile()) throw new Error(`${path} is not a regular file`);
    const bytes = await readFile(join(rootDir, path));
    const archiveDir = join(rootDir, "vendor", "legacy-plugin-sdk-v1");
    const parent = await statNoFollow(archiveDir, "legacy SDK archive");

    if (parent !== null && !parent.isDirectory())
      throw new Error("Legacy SDK archive is not a directory");
    const target = join(archiveDir, name);
    const previous = await statNoFollow(target, "legacy SDK archive");

    if (
      previous !== null &&
      (!previous.isFile() || !(await readFile(target)).equals(bytes))
    )
      throw new Error(`Legacy SDK archive collision: ${path}`);
    files.push({
      path,
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }

  const archivedFiles = files.map((file) => file.path);

  const remaining = (await readdir(typesDir)).filter(
    (name) => !archivedFiles.includes(`types/${name}`),
  );

  return { archivedFiles, removedTypesDir: remaining.length === 0, files };
}

function reserialize(raw: string, value: Record<string, unknown>): string {
  const indentMatch = /\n([ \t]+)"/.exec(raw);
  const indent = indentMatch === null ? 2 : indentMatch[1]!;
  const serialized = JSON.stringify(value, null, indent);

  return raw.endsWith("\n") ? `${serialized}\n` : serialized;
}

async function writeJsonFileAtomically(
  rootDir: string,
  name: string,
  text: string,
): Promise<void> {
  await writeFileAtomically(join(rootDir, name), name, text);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);

    return true;
  } catch {
    return false;
  }
}

async function tsconfigMapsSdk(rootDir: string): Promise<boolean> {
  const tsconfigPath = join(rootDir, "tsconfig.json");
  const tsconfig = await readJsonFile(tsconfigPath);

  if (tsconfig === null) {
    let raw: string;

    try {
      raw = await readFile(tsconfigPath, "utf8");
    } catch {
      return false;
    }

    return (
      raw.includes('"@get-bb/plugin-sdk') || raw.includes('"@bb/plugin-sdk')
    );
  }

  const compilerOptions = tsconfig.compilerOptions;

  if (typeof compilerOptions !== "object" || compilerOptions === null) {
    return false;
  }

  const paths = (compilerOptions as Record<string, unknown>).paths;

  if (typeof paths !== "object" || paths === null) return false;

  return Object.keys(paths).some(isSdkPathMapKey);
}

async function readJsonFile(
  path: string,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));

    if (typeof parsed !== "object" || parsed === null) return null;

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function statNoFollow(
  path: string,
  label: string,
): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  let stats: Awaited<ReturnType<typeof lstat>>;

  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to write through the symbolic link ${label}`);
  }

  return stats;
}

async function assertWritableTypesDir(
  rootDir: string,
  typesDir: string,
): Promise<void> {
  const stats = await statNoFollow(typesDir, "types");

  if (stats === null) return;

  if (!stats.isDirectory())
    throw new Error("types exists but is not a directory");

  const [realRoot, realTypes] = await Promise.all([
    realpath(rootDir),
    realpath(typesDir),
  ]);

  const rel = relative(realRoot, realTypes);

  if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`types resolves outside the plugin (${realTypes})`);
  }
}

async function writeFileAtomically(
  filePath: string,
  label: string,
  content: string,
): Promise<void> {
  const suffix = `${process.pid}-${randomBytes(6).toString("hex")}.omnyo-tmp`;
  const tempPath = `${filePath}.${suffix}`;

  if (await pathExists(tempPath)) {
    throw new Error(
      `refusing to overwrite the temporary file ${label}.${suffix}`,
    );
  }

  await writeFile(tempPath, content, { flag: "wx" });

  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

function pluginNameOf(packageName: string): string {
  return derivePluginId(packageName)
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function enginesRange(appVersion: string): string {
  const match = /^(\d+)\.(\d+)/.exec(appVersion);

  return match ? `>=${match[1]}.${match[2]}` : ">=0.0";
}

function componentsJsonSource(): string {
  return `${JSON.stringify(
    {
      $schema: "https://ui.shadcn.com/schema.json",
      style: "new-york",
      tsx: true,
      tailwind: {
        config: "",
        css: "app.css",
        baseColor: "neutral",
        cssVariables: true,
      },
      aliases: {
        components: "@/components",
        ui: "@/components/ui",
        lib: "@/lib",
        utils: "@/lib/utils",
        hooks: "@/hooks",
      },
    },
    null,
    2,
  )}\n`;
}

function serverEntrySource(packageName: string): string {
  const id = derivePluginId(packageName);
  const name = pluginNameOf(packageName);

  return `import { randomUUID } from "node:crypto";
import { defineRpcContract, type PluginApi } from "@omnyo/plugin-sdk";
import { z } from "zod";

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  done: z.boolean(),
  createdAt: z.string(),
});
export type Todo = z.infer<typeof todoSchema>;
export const rpcContract = defineRpcContract({
  todos_list: {
    input: z.null(),
    output: z.object({ todos: z.array(todoSchema) }),
  },
  todos_add: {
    input: z.object({ title: z.string().trim().min(1).max(200) }),
    output: todoSchema,
  },
  todos_set_done: {
    input: z.object({ id: z.string(), done: z.boolean() }),
    output: todoSchema,
  },
  todos_remove: {
    input: z.object({ id: z.string() }),
    output: z.object({ removed: z.boolean() }),
  },
});
const TODOS_CHANGED = "todos-changed";

export default async function plugin(api: PluginApi) {
  api.log.info("loaded");
  const settings = api.settings.define({
    showDone: {
      type: "boolean",
      label: "Show completed todos",
      default: true,
    },
  });
  const { showDone } = await settings.get();
  async function readTodos(): Promise<Todo[]> {
    return (await api.storage.kv.get<Todo[]>("todos")) ?? [];
  }
  async function writeTodos(todos: Todo[]): Promise<void> {
    await api.storage.kv.set("todos", todos);
    api.realtime.publish(TODOS_CHANGED, { count: todos.length });
  }

  async function listTodos(): Promise<Todo[]> {
    const todos = await readTodos();
    return showDone ? todos : todos.filter((todo) => !todo.done);
  }
  async function addTodo(title: string): Promise<Todo> {
    const todo: Todo = {
      id: randomUUID().slice(0, 8),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    };
    await writeTodos([...(await readTodos()), todo]);
    return todo;
  }
  async function setTodoDone(id: string, done: boolean): Promise<Todo | null> {
    const todos = await readTodos();
    const todo = todos.find((candidate) => candidate.id === id);
    if (todo === undefined) return null;
    todo.done = done;
    await writeTodos(todos);
    return todo;
  }
  async function removeTodo(id: string): Promise<boolean> {
    const todos = await readTodos();
    const remaining = todos.filter((todo) => todo.id !== id);
    if (remaining.length === todos.length) return false;
    await writeTodos(remaining);
    return true;
  }

  api.rpc.register(rpcContract, {
    todos_list: async () => ({ todos: await listTodos() }),
    todos_add: ({ title }) => addTodo(title),
    todos_set_done: async ({ id, done }) => {
      const todo = await setTodoDone(id, done);
      if (todo === null) throw new Error(\`No todo with id \${id}\`);
      return todo;
    },
    todos_remove: async ({ id }) => ({ removed: await removeTodo(id) }),
  });
  const usage = [
    "Usage:",
    "  omnyo ${id} list [--json]",
    "  omnyo ${id} add <title> [--json]",
    "  omnyo ${id} done <todo-id> [--json]",
    "  omnyo ${id} undo <todo-id> [--json]",
    "  omnyo ${id} remove <todo-id> [--json]",
  ].join("\\n");
  function formatTodo(todo: Todo): string {
    return \`[\${todo.done ? "x" : " "}] \${todo.id}  \${todo.title}\`;
  }
  api.cli.register({
    name: "${id}",
    summary: "Manage the ${name} plugin's example todo list",
    commands: [
      { name: "list", summary: "List todos", usage: "omnyo ${id} list [--json]" },
      {
        name: "add",
        summary: "Add a todo",
        usage: "omnyo ${id} add <title> [--json]",
      },
      {
        name: "done",
        summary: "Mark a todo done",
        usage: "omnyo ${id} done <todo-id> [--json]",
      },
      {
        name: "undo",
        summary: "Mark a todo not done",
        usage: "omnyo ${id} undo <todo-id> [--json]",
      },
      {
        name: "remove",
        summary: "Remove a todo",
        usage: "omnyo ${id} remove <todo-id> [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const [command, ...args] = argv.filter((arg) => arg !== "--json");
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const notFound = (missingId: string) => ({
        exitCode: 1,
        stderr: \`No todo with id \${missingId}. Run "omnyo ${id} list" to see ids.\`,
      });
      const todoId = args[0];
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const todos = await listTodos();
          return reply(
            todos,
            todos.length === 0 ? "No todos." : todos.map(formatTodo).join("\\n"),
          );
        }
        case "add": {
          const title = args.join(" ").trim();
          if (title === "") break;
          const todo = await addTodo(title);
          return reply(todo, \`Added \${formatTodo(todo)}\`);
        }
        case "done":
        case "undo": {
          if (todoId === undefined || args.length !== 1) break;
          const todo = await setTodoDone(todoId, command === "done");
          if (todo === null) return notFound(todoId);
          return reply(todo, formatTodo(todo));
        }
        case "remove": {
          if (todoId === undefined || args.length !== 1) break;
          if (!(await removeTodo(todoId))) return notFound(todoId);
          return reply({ removed: true, id: todoId }, \`Removed \${todoId}\`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });
  api.onDispose(() => {
    api.log.info("disposed");
  });
}
`;
}

function appEntrySource(packageName: string): string {
  const id = derivePluginId(packageName);

  return `import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@omnyo/plugin-sdk/app";
import type { rpcContract, Todo } from "./server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
function useTodos() {
  const rpc = useRpc<typeof rpcContract>();
  const [todos, setTodos] = useState<Todo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    rpc.call("todos_list").then((result) => {
      setTodos(result.todos);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("todos-changed", refetch);
  return { rpc, todos, error, report, refetch };
}

function TodoRow({
  todo,
  onToggle,
  onRemove,
}: {
  todo: Todo;
  onToggle: (done: boolean) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <Checkbox
        checked={todo.done}
        onCheckedChange={(checked) => onToggle(checked === true)}
        aria-label={\`Mark "\${todo.title}" \${todo.done ? "not done" : "done"}\`}
      />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          todo.done && "text-muted-foreground line-through",
        )}
      >
        {todo.title}
      </span>
      <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
        {todo.id}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        aria-label={\`Remove "\${todo.title}"\`}
        onClick={onRemove}
      >
        <Icon name="Trash2" className="size-4" />
      </Button>
    </li>
  );
}
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}
function TodosPage() {
  const { rpc, todos, error, report, refetch } = useTodos();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = title.trim();
    if (next === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("todos_add", { title: next });
      setTitle("");
      refetch();
    } catch (cause) {
      report(cause);
    } finally {
      setPending(false);
    }
  };
  const doneCount = todos?.filter((todo) => todo.done).length ?? 0;
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Agents keep this list with <code>omnyo ${id}</code>; the skill in{" "}
          <code>skills/example-todos</code> tells them how.
        </p>
        <form onSubmit={add} className="mt-4 flex items-center gap-2">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing?"
            aria-label="New todo"
          />
          <Button type="submit" disabled={pending || title.trim() === ""}>
            <Icon name="Plus" className="size-4" />
            Add
          </Button>
        </form>
        {error === null ? null : (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="mt-4">
          {todos === null ? (
            <EmptyState>Loading todos…</EmptyState>
          ) : todos.length === 0 ? (
            <EmptyState>
              Nothing to do. Add one above, or run{" "}
              <code>omnyo ${id} add "Ship it"</code>.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
              {todos.map((todo) => (
                <TodoRow
                  key={todo.id}
                  todo={todo}
                  onToggle={(done) => {
                    rpc
                      .call("todos_set_done", { id: todo.id, done })
                      .then(refetch, report);
                  }}
                  onRemove={() => {
                    rpc
                      .call("todos_remove", { id: todo.id })
                      .then(refetch, report);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
        {todos !== null && todos.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {doneCount} of {todos.length} done
          </p>
        ) : null}
      </div>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "example-todos",
    title: "Example todos",
    icon: "ListTodo",
    path: "example-todos",
    component: TodosPage,
  });
});
`;
}

function tsconfigSource(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        paths: { "@/*": ["./*"] },
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["server.ts", "app.tsx", "components", "lib", "hooks"],
    },
    null,
    2,
  )}\n`;
}

function skillSource(packageName: string): string {
  const id = derivePluginId(packageName);
  const name = pluginNameOf(packageName);

  return `---
name: example-todos
description: Read and update the ${name} plugin's example todo list with the \`omnyo ${id}\` CLI. Use when the user asks to add, complete, reopen, remove, or review todos, or when the steps of a task should be tracked as todos.
---

# Example todos

The ${name} plugin keeps one todo list. The Example todos page in the Omnyo sidebar and
the \`omnyo ${id}\` command read and write the same list, so a change from either
side shows in the other at once.

## Commands

| Command | Effect |
| --- | --- |
| \`omnyo ${id} list\` | Show every todo with its id. \`[x]\` marks a done todo. |
| \`omnyo ${id} add <title>\` | Add a todo. Quote a title that has spaces. |
| \`omnyo ${id} done <todo-id>\` | Mark a todo done. |
| \`omnyo ${id} undo <todo-id>\` | Mark a todo not done. |
| \`omnyo ${id} remove <todo-id>\` | Delete a todo. |

Add \`--json\` to any command when the output drives code.

## Procedure

1. Run \`omnyo ${id} list\` before you change the list. Use the ids it prints;
   never guess an id.
2. Add todos one at a time with a short title that starts with a verb:
   \`omnyo ${id} add "Write the release notes"\`.
3. When you finish a todo, mark it done: \`omnyo ${id} done <todo-id>\`. Do not
   remove a todo to mark it done.
4. Remove a todo only when the user asks for it or when it duplicates
   another todo.
5. End with a short summary of what you added, completed, or removed.

## Rules

- Change the list only through \`omnyo ${id}\`. Do not edit app.db or the plugin's
  storage directly.
- A non-zero exit with "No todo with id" means the id is stale: run
  \`omnyo ${id} list\` again.
`;
}

function pluginOverviewSource(packageName: string): string {
  const id = derivePluginId(packageName);

  return `Keep a todo list beside the work it belongs to, in the sidebar and in
your agent threads.

## What you get

- An **Example todos** page in the left sidebar that adds, completes, and
  removes todos.
- A \`omnyo ${id}\` command that does the same from a terminal.
- Live updates, so a change made in one place reaches every open page at once.

## How it works

The todos live in this plugin's own storage on the Omnyo server, one list per
installation. Nothing leaves the machine, and the plugin needs no account, API
key, or external service.

## For agents

The bundled skill tells an agent to read the list with \`omnyo ${id} list\`, add
one todo at a time with \`omnyo ${id} add\`, and close finished work with
\`omnyo ${id} done\`.
`;
}

function readmeSource(packageName: string): string {
  const id = derivePluginId(packageName);

  return `# ${packageName}

An Omnyo plugin that keeps a todo list. It shows every surface a plugin can own:

- \`server.ts\` — the backend: a todo store in \`api.storage.kv\`, RPC methods
  for the page, a \`omnyo ${id}\` CLI command, a setting, and a realtime signal
  that keeps every open page current.
- \`app.tsx\` — the frontend: an **Example todos** page in the left sidebar
  (\`app.slots.navPanel\`) built from the vendored components.
- \`skills/example-todos/SKILL.md\` — a skill that tells agents how to keep the list
  with \`omnyo ${id}\`. Omnyo imports it into agent threads automatically.
- \`PLUGIN_OVERVIEW.md\` — the store listing text: a longer version of
  \`omnyo.description\` that the plugin detail page shows under it. See
  [Store listing](#store-listing).

Try it: install the plugin, open **Example todos** in the sidebar, then run
\`omnyo ${id} add "Ship it"\` in a terminal. The page updates at once.

## UI components

\`components/ui/\` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the Omnyo
component registry bundled with your Omnyo install. From the plugin root:

\`\`\`
npx shadcn add ./vendor/omnyo-ui/select.json ./vendor/omnyo-ui/table.json
\`\`\`

Run \`npm install\` once before \`omnyo plugin build\` — the vendored components'
npm deps bundle into your dist. React, and Omnyo-shimmed packages like the
radix portal primitives and \`sonner\` (\`import { toast } from "sonner"\`
reaches Omnyo's own toaster), are provided by the Omnyo app at runtime and never
bundled. Every shimmed package is declared in \`devDependencies\` at the
host's version so those imports typecheck; keep them there (never in
\`dependencies\`, which would bundle a second copy), and \`omnyo plugin types\`
repins declared packages alongside the SDK; unused packages may be removed. Ship \`dist/\` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

\`package.json\` is the plugin manifest. Notable fields:

- \`omnyo.server\` — backend entry (required).
- \`omnyo.app\` — frontend entry. Delete it, \`app.tsx\`, \`components/\`,
  \`hooks/\`, and \`lib/\` for a headless plugin.
- \`omnyo.skills\` — skill roots; omitted here, so Omnyo reads \`skills/\`. Each
  directory with a \`SKILL.md\` is one skill, named after the directory.
- \`omnyo.name\` and \`omnyo.description\` — required human-facing identity.
- \`omnyo.branding\` — required; declare \`icon\` as an Omnyo icon name or a
  plugin-relative compact SVG, or declare \`logo.light\` (with optional
  \`logo.dark\`). Logo assets must be relative \`.svg\`, \`.png\`, or
  \`.webp\` files.
- \`engines.omnyo\` — supported omnyo app version range.
- \`engines.omnyoPluginSdk\` — the lowest plugin SDK you need (scaffold:
  \`>=${PLUGIN_SDK_VERSION}\`). Omnyo reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- \`dependencies\` — every package your source imports that Omnyo does not provide.
  \`omnyo plugin build\` inlines them into \`dist/\`, and git installs resolve this
  list alone, so a build-required package here rather than in
  \`devDependencies\` is what keeps your plugin installable. \`devDependencies\`
  is for types and tooling only (Omnyo shims React, the portal primitives, and
  \`@omnyo/plugin-sdk\` at runtime — never bundle them).

Run \`omnyo plugin build\` before publishing git/npm installs. It writes
\`dist/server.js\` + \`server.meta.json\` and \`app.js\` / \`app.css\` /
\`app.meta.json\`. Each \`*.meta.json\` stamps SDK major/version,
\`artifactFormatVersion\`, \`pluginId\`, \`pluginVersion\`, and
\`builtWith\` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. \`omnyo.description\` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. \`PLUGIN_OVERVIEW.md\` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
\`omnyo.description\` changes, so the two never disagree.

The listing in the private plugin catalog uses the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a \`#\` title or repeat \`omnyo.description\` verbatim; the page
shows both directly above.

## Install

From this directory (\`omnyo plugin new\` already ran the install; a fresh clone
needs it):

\`\`\`
npm install
omnyo plugin install .
\`\`\`

After editing sources, reload:

\`\`\`
omnyo plugin reload ${id}
\`\`\`

Or let \`omnyo plugin dev\` rebuild and reload on every save.

## Configure

\`\`\`
omnyo plugin config ${id}
omnyo plugin config ${id} set showDone false
omnyo plugin reload ${id}
\`\`\`

## Types & API reference

The plugin API ships as the private package \`@omnyo/plugin-sdk\`, pinned to an
digest-bound local archive in \`devDependencies\` (\`${PLUGIN_SDK_VERSION}\` — the SDK version of the Omnyo
that scaffolded this plugin). After \`npm install\`, the full surface is on disk
at:

\`\`\`
node_modules/@omnyo/plugin-sdk/bundled-types/omnyo-plugin-sdk.d.ts      # backend
node_modules/@omnyo/plugin-sdk/bundled-types/omnyo-plugin-sdk-app.d.ts  # frontend
\`\`\`

Your editor and \`tsc\` resolve \`@omnyo/plugin-sdk\` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every Omnyo release, so the pin has to track the Omnyo you
actually run:

\`\`\`
omnyo plugin types          # sync this plugin's SDK surface to the running Omnyo
omnyo plugin types --check  # CI: fail when it does not match
\`\`\`

Ask Omnyo to write plugins for you: the \`omnyo-plugin-authoring\` skill documents
the whole surface with examples.

For the private API, use the installed SDK declarations and the Plugin Guide.
The upstream project source is available at <https://github.com/get-bb/bb>.
`;
}

async function createScaffoldDirectory(targetDir: string): Promise<void> {
  try {
    await mkdir(targetDir, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`directory already exists: ${targetDir}`);
    }

    throw error;
  }
}

export function eventSourceFamilyOf(packageName: string): string {
  const family = derivePluginId(packageName);

  if (
    !INBOX_EVENT_FAMILY_PATTERN.test(family) ||
    (INBOX_CORE_EVENT_FAMILIES as readonly string[]).includes(family)
  ) {
    throw new Error(
      `"${family}" cannot name an event family: pick a plugin name that starts with a letter and has 2 to 32 letters, digits or dashes`,
    );
  }

  return family;
}

function eventSourceServerSource(family: string): string {
  return `import type {
  PluginApi,
  PluginEventSourceFiring,
  PluginEventSourceProblem,
} from "@omnyo/plugin-sdk";
import { z } from "zod";
const TARGET =
  /^((?:@[a-z0-9-~][a-z0-9-._~]*\\/)?[a-z0-9-~][a-z0-9-._~]*)@([0-9A-Za-z.+-]+)$/;
const packument = z.object({ versions: z.record(z.string(), z.unknown()) });

export default async function plugin(api: PluginApi) {
  api.experimental_eventSources.register({
    family: "${family}",
    label: "An npm package publishes a version",
    keyFormat: "${family}:<package>@<version>",
    examples: ["${family}:left-pad@1.3.0"],
    approval: "none",
    validate: (target) =>
      TARGET.test(target) ? null : "expected <package>@<version>",
    describe: (target) => \`npm publishes \${target}\`,
    poll: {
      everyMs: 5 * 60_000,
      async check(targets, { signal }) {
        const outcomes: (PluginEventSourceFiring | PluginEventSourceProblem)[] =
          [];

        for (const target of targets) {
          const [, name = "", version = ""] = TARGET.exec(target) ?? [];
          const response = await fetch(
            \`https://registry.npmjs.org/\${name.replace("/", "%2F")}\`,
            { signal },
          );

          if (response.status === 404) {
            outcomes.push({ target, problem: \`\${name} is not on npm\` });
            continue;
          }
          if (!response.ok) throw new Error(\`npm answered \${response.status}\`);

          const { versions } = packument.parse(await response.json());

          if (version in versions)
            outcomes.push({ target, result: \`\${name}@\${version} is on npm.\` });
        }

        return outcomes;
      },
    },
    proof: null,
  });
}
`;
}

function eventSourceTestSource(packageName: string, family: string): string {
  return `import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import plugin from "./server";

afterEach(() => vi.unstubAllGlobals());

const signal = new AbortController().signal;

async function load() {
  const host = createFakePluginHost({ pluginId: "${derivePluginId(packageName)}" });

  await plugin(host.api);

  const source = host.harness.registrations.eventSources.get("${family}");

  if (!source?.poll) throw new Error("expected a poll source");

  return { host, source, poll: source.poll };
}

it("accepts <package>@<version> targets and describes them", async () => {
  const { host, source } = await load();

  expect(source.validate("left-pad@1.3.0")).toBeNull();
  expect(source.validate("left-pad")).toBe("expected <package>@<version>");
  expect(source.describe("left-pad@1.3.0")).toBe("npm publishes left-pad@1.3.0");
  await host.harness.lifecycle.dispose();
});

it("fires once the version is on npm and reports an unknown package", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/left-pad")
        ? Response.json({ versions: { "1.3.0": {} } })
        : new Response("Not found", { status: 404 }),
    ),
  );

  const { host, poll } = await load();

  await expect(
    poll.check(["left-pad@1.3.0", "left-pad@9.9.9", "no-such-pkg@1.0.0"], {
      signal,
    }),
  ).resolves.toEqual([
    { target: "left-pad@1.3.0", result: "left-pad@1.3.0 is on npm." },
    { target: "no-such-pkg@1.0.0", problem: "no-such-pkg is not on npm" },
  ]);
  await host.harness.lifecycle.dispose();
});

it("throws when npm itself fails, so Omnyo backs off", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 503 })),
  );

  const { host, poll } = await load();

  await expect(poll.check(["left-pad@1.3.0"], { signal })).rejects.toThrow(
    "npm answered 503",
  );
  await host.harness.lifecycle.dispose();
});
`;
}

function eventSourceTsconfigSource(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022", "DOM"],
        types: ["node"],
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["server.ts", "server.test.ts"],
    },
    null,
    2,
  )}\n`;
}

function eventSourceSkillSource(family: string): string {
  return `---
name: ${family}
description: "Wait until an npm package publishes a version: omnyo wait --event ${family}:<package>@<version>."
---

# Wait for an npm version

Use \`${family}:<package>@<version>\` with \`omnyo wait --event\` when a chat should
continue once npm publishes that version, for example after a release starts.

1. Run \`omnyo wait check ${family}:<package>@<version>\`. It validates the key and
   says whether the version is already on npm.
2. Wait on it:

   \`\`\`sh
   omnyo wait --self --key npm-release --for "npm publishes <package>@<version>" \\
     --event ${family}:<package>@<version>
   \`\`\`

Omnyo checks every five minutes while the chat waits. An unknown package is a
problem the owner hears about after three checks in a row. When npm itself
fails, Omnyo retries with backoff.
`;
}

function eventSourceOverviewSource(family: string): string {
  return `Let a chat wait until npm publishes a package version, then continue on
its own with the result.

## What you get

- A \`${family}:<package>@<version>\` wait key that agents and you can name in
  \`omnyo wait --event\`.
- A check every five minutes while a chat waits, with backoff when npm is
  down.
- A note in the Inbox when a package does not exist.

## How it works

The plugin asks the public npm registry whether the version exists. It needs
no account or API key, and it reads nothing from your machines.

## For agents

The bundled skill tells an agent to test a key with \`omnyo wait check\` first,
then wait on it with \`omnyo wait --event\` instead of checking npm by hand.
When the version appears, the chat wakes with
\`<package>@<version> is on npm.\` as its result.
`;
}

function eventSourceReadmeSource(packageName: string, family: string): string {
  const id = derivePluginId(packageName);

  return `# ${packageName}

An Omnyo wait event source. It adds the \`${family}\` family of wait event keys,
so agents and you can run \`omnyo wait --event ${family}:<target>\` and the chat
continues when the event happens.

- \`server.ts\` registers the family with
  \`api.experimental_eventSources.register\`. The example fires when npm
  publishes a package version.
- \`server.test.ts\` checks the source with the fake plugin host and a stubbed
  \`fetch\`.
- \`skills/${family}/SKILL.md\` tells agents when and how to wait on these
  keys. Omnyo imports it into agent threads automatically.
- \`PLUGIN_OVERVIEW.md\` is the store listing text under \`omnyo.description\`.

## Make it yours

1. In \`server.ts\`, change the key format, \`validate\`, \`describe\` and
   \`poll.check\` to your event. \`check\` gets every pending target at once and
   returns \`{ target, result }\` for each one that fired and
   \`{ target, problem }\` for each one it cannot check. Throw only when the
   whole source cannot check, such as when it is signed out.
2. Set \`approval: "owner"\` when checking a key runs something on the owner's
   behalf, such as a command or a request to any URL.
3. Add a \`proof\` when the source needs access, such as a CLI sign-in. Omnyo runs
   it before polling and refuses the family's keys while it fails.
4. Update the tests, the skill, \`omnyo.description\` and \`PLUGIN_OVERVIEW.md\`.

## Try it

\`\`\`
npm install
npm test
omnyo plugin install .
omnyo wait sources
omnyo wait check ${family}:left-pad@1.3.0
\`\`\`

After editing \`server.ts\`, run \`omnyo plugin reload ${id}\`.

The \`omnyo-plugin-authoring\` skill's references/backend-event-sources.md has the
full contract: cadence, backoff, proofs, owner approval and push sources.
`;
}

export async function scaffoldEventSourcePlugin(
  args: ScaffoldPluginArgs,
): Promise<void> {
  const { targetDir, packageName, appVersion, sdkArtifact } = args;
  const family = eventSourceFamilyOf(packageName);

  await privateSdkDependencyPin(sdkArtifact);
  await createScaffoldDirectory(targetDir);
  const sdkPin = await installPrivateSdkArtifact(targetDir, sdkArtifact);
  await writeFile(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        engines: {
          omnyo: enginesRange(appVersion),
          omnyoPluginSdk: `>=${PLUGIN_SDK_VERSION}`,
        },
        omnyo: {
          name: pluginNameOf(packageName),
          description:
            "Wakes waiting chats when an npm package publishes a version.",
          branding: { icon: "Eye" },
          server: "./server.ts",
        },
        scripts: {
          test: "vitest run",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          zod: "^4.6.5",
        },
        devDependencies: {
          "@omnyo/plugin-sdk": sdkPin,
          "@types/better-sqlite3": "^7.6.12",
          "@types/node": "^22.0.0",
          "better-sqlite3": "^12.0.0",
          "cron-parser": "^5.5.0",
          hono: "^4.11.9",
          typescript: "^5.7.0",
          vitest: "^4.1.0",
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(targetDir, "server.ts"),
    eventSourceServerSource(family),
  );
  await writeFile(
    join(targetDir, "server.test.ts"),
    eventSourceTestSource(packageName, family),
  );
  await writeFile(
    join(targetDir, "tsconfig.json"),
    eventSourceTsconfigSource(),
  );

  const skillDir = join(targetDir, "skills", family);

  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), eventSourceSkillSource(family));
  await writeFile(join(targetDir, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(
    join(targetDir, "README.md"),
    eventSourceReadmeSource(packageName, family),
  );
  await writeFile(
    join(targetDir, "PLUGIN_OVERVIEW.md"),
    eventSourceOverviewSource(family),
  );
}

export async function scaffoldPlugin(args: ScaffoldPluginArgs): Promise<void> {
  const { targetDir, packageName, appVersion, sdkArtifact } = args;

  await privateSdkDependencyPin(sdkArtifact);
  await createScaffoldDirectory(targetDir);

  const sdkPin = await installPrivateSdkArtifact(targetDir, sdkArtifact);

  await writeFile(
    join(targetDir, "package.json"),
    JSON.stringify(
      {
        name: packageName,
        version: "0.1.0",
        private: true,
        type: "module",
        engines: {
          omnyo: enginesRange(appVersion),
          omnyoPluginSdk: `>=${PLUGIN_SDK_VERSION}`,
        },
        omnyo: {
          name: pluginNameOf(packageName),
          description: "An Omnyo plugin with an example todo list.",
          branding: { icon: "ListTodo" },
          server: "./server.ts",
          app: "./app.tsx",
        },
        dependencies: {
          ...PLUGIN_STARTER_DEPENDENCIES,
          zod: "^4.6.5",
        },
        devDependencies: {
          "@omnyo/plugin-sdk": sdkPin,
          "@types/better-sqlite3": "^7.6.12",
          "@types/node": "^22.0.0",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          "better-sqlite3": "^12.0.0",
          "cron-parser": "^5.5.0",
          hono: "^4.11.9",
          typescript: "^5.7.0",
          ...PLUGIN_SHIMMED_TYPE_DEPENDENCIES,
        },
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(join(targetDir, "server.ts"), serverEntrySource(packageName));
  await writeFile(join(targetDir, "app.tsx"), appEntrySource(packageName));
  await writeFile(join(targetDir, "tsconfig.json"), tsconfigSource());

  for (const file of [...PLUGIN_STARTER_FILES, ...PLUGIN_REGISTRY_FILES]) {
    const filePath = join(targetDir, file.target);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content);
  }

  await writeFile(join(targetDir, "components.json"), componentsJsonSource());
  const skillDir = join(targetDir, "skills", "example-todos");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), skillSource(packageName));
  await writeFile(join(targetDir, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(join(targetDir, "README.md"), readmeSource(packageName));
  await writeFile(
    join(targetDir, "PLUGIN_OVERVIEW.md"),
    pluginOverviewSource(packageName),
  );
}

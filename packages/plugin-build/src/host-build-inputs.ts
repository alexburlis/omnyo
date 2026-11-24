import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PLUGIN_SDK_VERSION } from "@omnyo/domain";
import { isRecord } from "./plugin-manifest.js";
import { PLUGIN_TOOLCHAIN_PINS } from "./toolchain.js";

interface HostBuildInputs {
  version: 1;
  key: string;
  rootDir: string;
  paths: Array<{ path: string; state: string }>;
}

const RESOLUTION_EXTENSIONS = [
  "",
  ".tsx",
  ".ts",
  ".jsx",
  ".js",
  ".css",
  ".json",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
];

function buildKey(coreVersion: string): string {
  return JSON.stringify([
    coreVersion,
    PLUGIN_SDK_VERSION,
    PLUGIN_TOOLCHAIN_PINS.esbuild,
  ]);
}

async function pathState(path: string): Promise<string> {
  try {
    const resolvedPath = await realpath(path);
    const info = await stat(resolvedPath, { bigint: true });

    const value = info.isFile()
      ? createHash("sha256")
          .update(await readFile(resolvedPath))
          .digest("hex")
      : info.mtimeNs.toString();

    return JSON.stringify([
      resolvedPath,
      info.isFile() ? "file" : "directory",
      value,
    ]);
  } catch (error) {
    if (
      isRecord(error) &&
      (error.code === "ENOENT" || error.code === "ENOTDIR")
    )
      return "missing";
    throw error;
  }
}

function packageName(specifier: string): string | null {
  if (
    specifier.startsWith(".") ||
    isAbsolute(specifier) ||
    isBuiltin(specifier) ||
    specifier.startsWith("#")
  )
    return null;
  const segments = specifier.split("/");

  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? null);
}

export async function collectPluginHostBuildInputs(args: {
  rootDir: string;
  coreVersion: string;
  inputPaths: string[];
  imports: ReadonlyMap<string, string[]>;
  loadedInputs?: ReadonlyMap<string, string | Uint8Array>;
}): Promise<HostBuildInputs | null> {
  const rootDir = await realpath(args.rootDir);
  const paths = new Set<string>([join(rootDir, "package.json")]);
  const configs = new Set<string>();

  function resolution(candidate: string) {
    for (const extension of RESOLUTION_EXTENSIONS) {
      paths.add(`${candidate}${extension}`);
      paths.add(join(candidate, `index${extension}`));
    }

    paths.add(join(candidate, "package.json"));
  }

  async function ancestors(start: string, specifiers: readonly string[]) {
    let directory = start;
    let foundConfig = false;

    while (true) {
      paths.add(join(directory, "package.json"));

      if (!foundConfig) {
        for (const name of ["tsconfig.json", "jsconfig.json"]) {
          const config = join(directory, name);
          paths.add(config);

          if ((await pathState(config)) !== "missing") {
            configs.add(config);
            foundConfig = true;
            break;
          }
        }
      }

      for (const specifier of specifiers) {
        const name = packageName(specifier);

        if (name === null) continue;
        const moduleDirectory = join(directory, "node_modules");
        const candidate = join(moduleDirectory, name);
        paths.add(moduleDirectory);
        paths.add(candidate);
        paths.add(join(candidate, "package.json"));
      }

      const parent = dirname(directory);

      if (parent === directory) break;
      directory = parent;
    }
  }

  for (const input of args.inputPaths) {
    paths.add(input);
    const directory = dirname(input);

    if (directory !== join(rootDir, "dist")) paths.add(directory);
    const specifiers = args.imports.get(input) ?? [];

    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) continue;
      resolution(resolve(directory, specifier));
    }

    await ancestors(directory, specifiers);
  }

  const visitedConfigs = new Set<string>();

  while (configs.size > 0) {
    const config = configs.values().next().value;

    if (config === undefined) break;
    configs.delete(config);

    if (visitedConfigs.has(config)) continue;
    visitedConfigs.add(config);
    paths.add(config);
    let parsed: unknown;

    try {
      parsed = JSON.parse(await readFile(config, "utf8"));
    } catch {
      return null;
    }

    if (!isRecord(parsed)) return null;

    const options = isRecord(parsed.compilerOptions)
      ? parsed.compilerOptions
      : {};

    const baseUrl = resolve(
      dirname(config),
      typeof options.baseUrl === "string" ? options.baseUrl : ".",
    );

    for (const specifier of [...args.imports.values()].flat()) {
      if (packageName(specifier) === null) continue;

      if (typeof options.baseUrl === "string")
        resolution(resolve(baseUrl, specifier));

      if (!isRecord(options.paths)) continue;

      for (const [pattern, targets] of Object.entries(options.paths)) {
        const [prefix, suffix] = pattern.split("*");

        if (prefix === undefined || !Array.isArray(targets)) return null;

        if (
          suffix === undefined
            ? specifier !== pattern
            : !specifier.startsWith(prefix) || !specifier.endsWith(suffix)
        )
          continue;

        const matched =
          suffix === undefined
            ? ""
            : specifier.slice(prefix.length, specifier.length - suffix.length);

        for (const target of targets) {
          if (typeof target !== "string") return null;
          resolution(resolve(baseUrl, target.replace("*", matched)));
        }
      }
    }

    if (parsed.extends === undefined) continue;

    const extensions: unknown[] = Array.isArray(parsed.extends)
      ? parsed.extends
      : [parsed.extends];

    for (const extension of extensions) {
      if (typeof extension !== "string") return null;
      await ancestors(dirname(config), [extension]);
      let inherited: string;

      try {
        inherited = createRequire(config).resolve(extension);
      } catch {
        const candidate = resolve(dirname(config), extension);
        paths.add(candidate);
        paths.add(`${candidate}.json`);

        if (!extension.startsWith(".") && !isAbsolute(extension)) return null;
        inherited =
          (await pathState(candidate)) !== "missing"
            ? candidate
            : `${candidate}.json`;
      }

      configs.add(inherited);
    }
  }

  return {
    version: 1,
    key: buildKey(args.coreVersion),
    rootDir,
    paths: await Promise.all(
      [...paths].sort().map(async (path) => {
        const contents = args.loadedInputs?.get(path);

        const state =
          contents === undefined
            ? await pathState(path)
            : JSON.stringify([
                await realpath(path),
                "file",
                createHash("sha256").update(contents).digest("hex"),
              ]);

        return { path, state };
      }),
    ),
  };
}

export async function isPluginHostArtifactFresh(
  rootDir: string,
  coreVersion: string,
): Promise<boolean> {
  let metadata: unknown;

  try {
    metadata = JSON.parse(
      await readFile(join(rootDir, "dist", "host.meta.json"), "utf8"),
    );
    await stat(join(rootDir, "dist", "host.js"));
  } catch {
    return false;
  }

  if (
    !isRecord(metadata) ||
    metadata.sdkVersion !== PLUGIN_SDK_VERSION ||
    !isRecord(metadata.buildInputs)
  )
    return false;
  const inputs = metadata.buildInputs;

  if (
    inputs.version !== 1 ||
    inputs.key !== buildKey(coreVersion) ||
    inputs.rootDir !== (await realpath(rootDir)) ||
    !Array.isArray(inputs.paths) ||
    inputs.paths.length === 0
  )
    return false;

  const paths: Array<{ path: string; state: string }> = [];

  for (const input of inputs.paths) {
    if (
      !isRecord(input) ||
      typeof input.path !== "string" ||
      !isAbsolute(input.path) ||
      typeof input.state !== "string"
    )
      return false;
    paths.push({ path: input.path, state: input.state });
  }

  return (
    await Promise.all(
      paths.map(async (input) => (await pathState(input.path)) === input.state),
    )
  ).every(Boolean);
}

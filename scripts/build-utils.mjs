import { publicBetaCollectionPlugins } from "./public-beta-collection.mjs";
import { chmod, cp, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { zodLocaleStubPlugin } from "../packages/plugin-build/src/zod-locale-stub.mjs";

const NODE_ESM_REQUIRE_BANNER = [
  'import { createRequire as __createRequire } from "node:module";',
  'import { dirname as __pathDirname } from "node:path";',
  'import { fileURLToPath as __fileURLToPath } from "node:url";',
  "const require = __createRequire(import.meta.url);",
  "var __filename = __fileURLToPath(import.meta.url);",
  "var __dirname = __pathDirname(__filename);",
].join("\n");

export const RUNTIME_NATIVE_MODULES = Object.freeze([
  "@parcel/watcher",
  "better-sqlite3",
  "fs-native-extensions",
  "node-pty",
  "sharp",
]);

const NATIVE_EXTERNAL_PACKAGES = [
  ...RUNTIME_NATIVE_MODULES,
  "bufferutil",
  "fsevents",
  "pino",
  "pino-pretty",
  "pino-roll",
  "thread-stream",
  "utf-8-validate",
];

export function externalPackagePatterns(packageNames) {
  return packageNames.flatMap((packageName) => [
    packageName,
    `${packageName}/*`,
  ]);
}

export function createNativeExternalPatterns({ bundledPackages = [] } = {}) {
  const bundledPackageSet = new Set(bundledPackages);

  return externalPackagePatterns(
    NATIVE_EXTERNAL_PACKAGES.filter(
      (packageName) => !bundledPackageSet.has(packageName),
    ),
  );
}

async function removeFileAndMap(outfile) {
  await Promise.all([
    rm(outfile, { force: true }),
    rm(`${outfile}.map`, { force: true }),
  ]);
}

export async function copyDirectory({ from, to }) {
  await rm(to, { force: true, recursive: true });
  await cp(from, to, { recursive: true });
}

export function splitOutputOptions(outfile) {
  const baseName = path.basename(outfile);
  const entryName = baseName.endsWith(".js") ? baseName.slice(0, -3) : baseName;

  return {
    chunkDir: path.join(path.dirname(outfile), `${entryName}-chunks`),
    esbuild: {
      chunkNames: `${entryName}-chunks/[name]-[hash]`,
      entryNames: entryName,
      outdir: path.dirname(outfile),
      splitting: true,
    },

    writtenEntry: path.join(path.dirname(outfile), `${entryName}.js`),
  };
}

export async function finalizeSplitOutput(outfile) {
  const { writtenEntry } = splitOutputOptions(outfile);

  if (writtenEntry !== outfile) {
    await rename(writtenEntry, outfile);
  }
}

const RELATIVE_JS_SPECIFIER = /["'](\.\.?\/[^"']+\.js)["']/g;

export async function pruneUnreferencedChunks({ chunkDir, entry }) {
  const resolvedChunkDir = path.resolve(chunkDir);

  const chunkFiles = new Set(
    (await readdir(resolvedChunkDir, { withFileTypes: true }))
      .filter((dirent) => dirent.isFile())
      .map((dirent) => path.join(resolvedChunkDir, dirent.name)),
  );

  const reachable = new Set();
  const queue = [path.resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop();

    if (reachable.has(file)) {
      continue;
    }

    reachable.add(file);
    const source = await readFile(file, "utf8");

    for (const [, specifier] of source.matchAll(RELATIVE_JS_SPECIFIER)) {
      const target = path.resolve(path.dirname(file), specifier);

      if (chunkFiles.has(target) && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  if (![...chunkFiles].some((chunkFile) => reachable.has(chunkFile))) {
    throw new Error(
      `${path.resolve(entry)} references no chunk in ${resolvedChunkDir}; refusing to prune`,
    );
  }

  const removed = [];

  for (const chunkFile of chunkFiles) {
    const owner = chunkFile.endsWith(".map")
      ? chunkFile.slice(0, -".map".length)
      : chunkFile;

    if (reachable.has(owner)) {
      continue;
    }

    await rm(chunkFile);
    removed.push(chunkFile);
  }

  return removed;
}

export async function buildNodeEsmEntry({
  cleanDist,
  entryPoint,
  executable = false,
  external = [],
  outfile,
  packageRoot,
  sourcemap = true,
  splitting = false,
  target = "node22",
}) {
  const split = splitting ? splitOutputOptions(outfile) : null;

  if (cleanDist) {
    await rm(path.join(packageRoot, "dist"), { force: true, recursive: true });
  } else {
    await removeFileAndMap(outfile);

    if (split) {
      await rm(split.chunkDir, { force: true, recursive: true });
    }
  }

  await build({
    banner: {
      js: NODE_ESM_REQUIRE_BANNER,
    },
    bundle: true,
    conditions: ["source"],
    entryPoints: [entryPoint],
    external: [...createNativeExternalPatterns(), ...external],
    format: "esm",
    legalComments: "none",
    ...(split ? split.esbuild : { outfile }),
    plugins: [zodLocaleStubPlugin(), ...publicBetaCollectionPlugins()],
    platform: "node",
    sourcemap,
    target,
  });

  if (split) {
    await finalizeSplitOutput(outfile);
  }

  if (executable) {
    await chmod(outfile, 0o755);
  }
}

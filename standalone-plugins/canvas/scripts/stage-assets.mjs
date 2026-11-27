import { createRequire } from "node:module";
import { cp, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const destination = join(root, "dist/media-codec");

const pending = [{ name: "sharp", from: root }];

const copied = new Set();

async function packageRoot(name, from) {
  const paths = createRequire(join(from, "package.json")).resolve.paths(name) ?? [];

  for (const directory of paths) {
    const candidate = join(directory, name);

    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));

      if (manifest.name === name) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
  }

  const error = new Error(`Cannot locate the installed ${name} package`);
  error.code = "MODULE_NOT_FOUND";
  throw error;
}

await mkdir(destination, { recursive: true });

while (pending.length) {
  const { name, from } = pending.shift();

  if (copied.has(name)) continue;
  const source = await packageRoot(name, from);
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  const awaitedSource = await realpath(source);
  await cp(awaitedSource, join(destination, "node_modules", name), {
    recursive: true,
    dereference: true,
    filter: (path) => !relative(awaitedSource, path).split(/[\\/]/u).includes("node_modules"),
  });
  copied.add(name);

  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (!copied.has(dependency)) pending.push({ name: dependency, from: awaitedSource });
  }

  for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
    try {
      await packageRoot(dependency, awaitedSource);

      if (!copied.has(dependency)) pending.push({ name: dependency, from: awaitedSource });
    } catch (error) {
      if (error.code !== "MODULE_NOT_FOUND" && error.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED")
        throw error;
    }
  }
}

await writeFile(
  join(destination, "platform.json"),
  JSON.stringify({ platform: process.platform, arch: process.arch }) + "\n",
);

await writeFile(join(destination, "loader.cjs"), 'module.exports = require("sharp");\n');

await stat(join(destination, "node_modules/sharp"));

const codec = createRequire(join(destination, "loader.cjs"))("sharp");

if (codec.versions.sharp !== "0.35.5")
  throw new Error("Staged image codec version differs from the pin");

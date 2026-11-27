import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { build as compile } from "esbuild";

const root = resolve(import.meta.dirname, "..");

const acceptance = process.argv.includes("--acceptance");

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const files = new Map();

for (const name of [
  "server.js",
  "server.meta.json",
  "host.js",
  "host.meta.json",
  "app.js",
  "app.css",
  "app.meta.json",
])
  files.set(name, await readFile(join(root, "dist", name)));

// Path installations rebuild frontend entries. Keep the extracted CSS in that import graph.
files.set("app-entry.js", Buffer.from('import "./app.css"; export { default } from "./app.js";\n'));

if (acceptance) {
  const result = await compile({
    entryPoints: [join(root, "tests/acceptance-entry.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: ["@omnyo/plugin-sdk"],
    write: false,
    minify: true,
    keepNames: true,
  });

  files.set("server.js", result.outputFiles[0].contents);
}

async function collect(directory, prefix) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + "/" + item.name;

    if (item.isDirectory()) await collect(join(directory, item.name), name);
    else if (item.isFile()) files.set(name, await readFile(join(directory, item.name)));
    else throw new Error("Runtime packages must not contain links");
  }
}

await collect(join(root, "skills"), "skills");

for (const name of ["README.md", "PLUGIN_OVERVIEW.md"])
  files.set(name, await readFile(join(root, name)));

files.set(
  "package.json",
  Buffer.from(
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        type: "module",
        private: true,
        author: manifest.author,
        repository: manifest.repository,
        engines: manifest.engines,
        omnyo: {
          ...manifest.omnyo,
          name: acceptance ? "Sentry acceptance fixture" : manifest.omnyo.name,
          server: "./server.js",
          app: "./app-entry.js",
          host: "./host.js",
        },
      },
      null,
      2,
    ) + "\n",
  ),
);

const hashes = {};

for (const name of [...files.keys()].sort())
  hashes[name] = createHash("sha256").update(files.get(name)).digest("hex");

let build = createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 20);

if (!acceptance) {
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    }).trim();

  if (git("status", "--porcelain", "--untracked-files=all", "--", "."))
    throw new Error("Runtime source must be clean and committed before packaging");
  const top = git("rev-parse", "--show-toplevel");
  const sourceRoot = relative(top, root).replaceAll("\\", "/");
  const sourceCommit = git("rev-parse", "HEAD");
  const origin = git("remote", "get-url", "origin");

  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(
      origin,
    );

  if (!match) throw new Error("Runtime source must belong to the configured plugin repository");
  const sourceFiles = {};

  for (const line of git("ls-tree", "--full-tree", "-r", "-z", sourceCommit, "--", sourceRoot)
    .split("\0")
    .filter(Boolean)) {
    const entry = /^([0-7]+) blob ([a-f0-9]+)\t(.+)$/u.exec(line);

    if (!entry || !entry[3].startsWith(sourceRoot + "/"))
      throw new Error("Unsupported runtime source tree entry");
    const path = entry[3].slice(sourceRoot.length + 1);

    if (!/^(?:docs|tests|\.vitest)\//u.test(path))
      sourceFiles[path] = { mode: entry[1], oid: entry[2] };
  }

  if (!Object.keys(sourceFiles).length) throw new Error("Runtime source tree is empty");

  const metadata = {
    schema: 1,
    repository: match[1],
    root: sourceRoot,
    sourceCommit,
    baseCommit: sourceCommit,
    version: manifest.version,
    sourceFiles,
    runtimeFiles: [...files.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((path) => ({ path, sha256: hashes[path] })),
  };

  const marker = Buffer.from(JSON.stringify(metadata) + "\n");
  files.set("omnyo-workflow-source.json", marker);
  hashes["omnyo-workflow-source.json"] = createHash("sha256").update(marker).digest("hex");
  build = createHash("sha256").update(JSON.stringify(metadata)).digest("hex").slice(0, 20);
}

const destination = join(root, "dist", "runtime", build);

await mkdir(destination, { recursive: true });

for (const [name, content] of files) {
  await mkdir(resolve(destination, name, ".."), { recursive: true });
  await writeFile(join(destination, name), content);
}

const receipt = { version: manifest.version, build, acceptance, hashes };

await writeFile(join(destination, "build.json"), JSON.stringify(receipt, null, 2) + "\n");

await writeFile(
  join(root, "dist", acceptance ? "runtime-acceptance.json" : "runtime-current.json"),
  JSON.stringify(
    { directory: destination, build, version: manifest.version, acceptance },
    null,
    2,
  ) + "\n",
);

await mkdir(join(root, "docs/evidence"), { recursive: true });

await writeFile(
  join(root, "docs/evidence", acceptance ? "acceptance-package.json" : "runtime-package.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(JSON.stringify({ directory: destination, build, acceptance, files: files.size }));

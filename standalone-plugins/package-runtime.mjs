import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    plugin: { type: "string" },
    "create-evidence-directory": { type: "boolean", default: false },
  },
});

if (!values.plugin || !/^[a-z][a-z0-9-]*$/u.test(values.plugin))
  throw new Error("Select a plugin folder with --plugin");

const root = resolve(import.meta.dirname, values.plugin);

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const uncommitted = execFileSync(
  "git",
  ["status", "--porcelain", "--untracked-files=all", "--", ".", ":!docs/evidence"],
  { cwd: root, encoding: "utf8" },
).trim();

if (uncommitted !== "")
  throw new Error(`Commit ${values.plugin} before packaging it:\n${uncommitted}`);

execFileSync("omnyo", ["plugin", "build", root], { cwd: root, stdio: "inherit" });

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const files = new Map();

for (const name of ["server.js", "server.meta.json", "app.js", "app.css", "app.meta.json"])
  files.set(name, await readFile(join(root, "dist", name)));

files.set("app-entry.js", Buffer.from('import "./app.css"; export { default } from "./app.js";\n'));

async function collect(directory, prefix) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + "/" + item.name;

    if (item.isDirectory()) await collect(join(directory, item.name), name);
    else if (item.isFile()) files.set(name, await readFile(join(directory, item.name)));
    else throw new Error("Runtime packages must contain only regular files");
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
        private: true,
        type: "module",
        author: manifest.author,
        repository: manifest.repository,
        engines: manifest.engines,
        omnyo: { ...manifest.omnyo, server: "./server.js", app: "./app-entry.js" },
      },
      null,
      2,
    ) + "\n",
  ),
);

const hashes = Object.fromEntries(
  [...files.keys()]
    .sort()
    .map((name) => [name, createHash("sha256").update(files.get(name)).digest("hex")]),
);

const build = createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 20);

const destination = join(root, "dist", "runtime", build);

await mkdir(destination, { recursive: true });

for (const [name, bytes] of files) {
  await mkdir(dirname(join(destination, name)), { recursive: true });
  await writeFile(join(destination, name), bytes);
}

const receipt = { plugin: values.plugin, version: manifest.version, sourceCommit, build, hashes };

await writeFile(join(destination, "build.json"), JSON.stringify(receipt, null, 2) + "\n");

await writeFile(
  join(root, "dist/runtime-current.json"),
  JSON.stringify(
    { directory: destination, sourceCommit, build, version: manifest.version },
    null,
    2,
  ) + "\n",
);

if (values["create-evidence-directory"])
  await mkdir(join(root, "docs/evidence"), { recursive: true });

await writeFile(
  join(root, "docs/evidence/runtime-package.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(JSON.stringify({ directory: destination, build, files: files.size }));

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const files = new Map();

const modes = {};

const serverSource = await readFile(join(root, "dist/server.js"), "utf8");

if (/file:[^"\n]+\/lib\/media\.ts/u.test(serverSource))
  throw new Error(
    "Build a portable server with omnyo plugin build before packaging; a source-preserving cache artifact cannot be relocated",
  );

await import("./stage-assets.mjs");

for (const name of ["server.js", "server.meta.json", "app.js", "app.css", "app.meta.json"])
  files.set("dist/" + name, await readFile(join(root, "dist", name)));

files.set(
  "app-entry.js",
  Buffer.from('import "./dist/app.css"; export { default } from "./dist/app.js";\n'),
);

async function collect(directory, prefix) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + "/" + item.name;

    if (item.isDirectory()) await collect(join(directory, item.name), name);
    else if (item.isFile()) {
      const file = join(directory, item.name);
      files.set(name, await readFile(file));
      modes[name] = (await stat(file)).mode & 0o777;
    } else throw new Error("Runtime packages must contain only regular files");
  }
}

await collect(join(root, "skills"), "skills");

await collect(join(root, "dist/media-codec"), "dist/media-codec");

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
        omnyo: { ...manifest.omnyo, server: "./dist/server.js", app: "./app-entry.js" },
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

const build = createHash("sha256")
  .update(JSON.stringify({ hashes, modes }))
  .digest("hex")
  .slice(0, 20);

const destination = join(root, "dist", "runtime", build);

await mkdir(destination, { recursive: true });

for (const [name, bytes] of files) {
  await mkdir(dirname(join(destination, name)), { recursive: true });
  await writeFile(join(destination, name), bytes, { mode: modes[name] ?? 0o644 });
}

const receipt = { plugin: "canvas", version: manifest.version, sourceCommit, build, hashes, modes };

await writeFile(join(destination, "build.json"), JSON.stringify(receipt, null, 2) + "\n");

await writeFile(
  join(root, "dist/runtime-current.json"),
  JSON.stringify(
    { directory: destination, sourceCommit, build, version: manifest.version },
    null,
    2,
  ) + "\n",
);

await writeFile(
  join(root, "docs/evidence/runtime-package.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(JSON.stringify({ directory: destination, build, files: files.size }));

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();

function committed() {
  if (
    execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        ":(exclude)docs/evidence/runtime-package.json",
        ":(exclude)docs/evidence/runtime-install.json",
      ],
      { cwd: root, encoding: "utf8" },
    ).trim() !== ""
  )
    throw new Error("Commit every Chime change before packaging its runtime");
}

committed();

execFileSync("omnyo", ["plugin", "build"], { cwd: root, stdio: "inherit" });

committed();

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

const files = new Map();

for (const name of ["server.js", "server.meta.json", "app.js", "app.css", "app.meta.json"])
  files.set(name, await readFile(join(root, "dist", name)));

files.set("app-entry.js", Buffer.from('import "./app.css"; export { default } from "./app.js";\n'));

const assets = execFileSync("git", ["ls-files", "-z", "--", "assets"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);

if (!assets.some((name) => /^assets\/sounds\/[a-z0-9-]+\.wav$/u.test(name)))
  throw new Error("Chime has no committed sounds to package");

for (const name of assets) files.set(name, await readFile(join(root, name)));

for (const name of ["README.md", "LICENSE", "NOTICE"])
  files.set(name, await readFile(join(root, name)));

files.set(
  "package.json",
  Buffer.from(
    JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: true,
        license: manifest.license,
        type: "module",
        author: manifest.author,
        repository: manifest.repository,
        engines: manifest.engines,
        omnyo: {
          ...manifest.omnyo,
          server: "./server.js",
          app: "./app-entry.js",
        },
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

const receipt = {
  plugin: "chime-local",
  version: manifest.version,
  sourceCommit,
  build,
  hashes,
};

await writeFile(join(destination, "build.json"), JSON.stringify(receipt, null, 2) + "\n");

await writeFile(
  join(root, "dist/runtime-current.json"),
  JSON.stringify(
    { directory: destination, sourceCommit, build, version: manifest.version },
    null,
    2,
  ) + "\n",
);

await mkdir(join(root, "docs/evidence"), { recursive: true });

await writeFile(
  join(root, "docs/evidence/runtime-package.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(JSON.stringify({ directory: destination, build, files: files.size }));

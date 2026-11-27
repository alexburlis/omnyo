import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2).filter((value) => value !== "--");

if (args.length !== 2 || args[0] !== "--machine" || !args[1])
  throw new Error("Usage: node scripts/install-runtime.mjs --machine <host-id>");

const hostId = args[1];

function api(argv, input) {
  return execFileSync("omnyo", argv, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
}

const status = JSON.parse(api(["status", "--json"]));

const hosts = JSON.parse(api(["machine", "list", "--json"]));

if (!hosts.some((host) => host.id === hostId && host.status === "connected"))
  throw new Error("The selected machine must be connected");

const pointer = JSON.parse(await readFile(join(root, "dist/runtime-current.json"), "utf8"));

if (
  !/^[a-f0-9]{20}$/u.test(pointer.build) ||
  pointer.directory !== join(root, "dist/runtime", pointer.build)
)
  throw new Error("Invalid local runtime package pointer");

const base = join(status.dataDir, "plugins/local-builds/leftover-processes");

const destination = join(base, pointer.build);

const plugins = JSON.parse(api(["plugin", "list", "--json"])).plugins;

const previous = plugins.find((plugin) => plugin.id === "leftover-processes");

if (previous && !previous.source.startsWith("path:" + base + "/"))
  throw new Error("The existing Left running installation belongs to a different source");

const manifest = JSON.parse(await readFile(join(pointer.directory, "build.json"), "utf8"));

const files = [];

async function collect(directory, prefix = "") {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? prefix + "/" + item.name : item.name;

    if (item.isDirectory()) await collect(join(directory, item.name), name);
    else if (item.isFile()) files.push(name);
    else throw new Error("Runtime packages must contain only regular files");
  }
}

await collect(pointer.directory);

const transferred = [];

for (const name of files.sort()) {
  const bytes = await readFile(join(pointer.directory, name));
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  if (name !== "build.json" && manifest.hashes[name] !== sha256)
    throw new Error("Local runtime digest mismatch: " + name);

  const result = JSON.parse(
    api(
      [
        "file",
        "write",
        join(destination, name),
        "--host",
        hostId,
        "--root",
        join(status.dataDir, "plugins"),
        "--create-parents",
        "--stdin",
        "--json",
      ],
      bytes.toString("utf8"),
    ),
  );

  if (result.outcome !== "written" || result.sha256 !== sha256)
    throw new Error("Runtime transfer digest mismatch: " + name);
  transferred.push({ name, sha256 });
}

const installed = JSON.parse(api(["plugin", "install", "path:" + destination, "--yes", "--json"]));

api(["plugin", "reload", "leftover-processes", "--json"]);

const current = JSON.parse(api(["plugin", "list", "--json"])).plugins.find(
  (plugin) => plugin.id === "leftover-processes",
);

if (
  current?.status !== "running" ||
  current.source !== "path:" + destination ||
  current.version !== pointer.version
)
  throw new Error("Left running did not start from the exact transferred package");

const receipt = {
  sourceCommit: pointer.sourceCommit,
  destination,
  hostId,
  build: pointer.build,
  version: pointer.version,
  files: transferred,
  previous: previous ? { source: previous.source, version: previous.version } : null,
  installed,
  status: current.status,
  appBundle: current.app.bundle,
};

await writeFile(
  join(root, "docs/evidence/runtime-install.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

console.log(JSON.stringify({ destination, build: pointer.build, status: current.status }));

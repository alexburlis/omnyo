import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..");

const args = process.argv.slice(2).filter((value) => value !== "--");

if (args.length !== 2 || args[0] !== "--machine" || !args[1])
  throw new Error("Select the existing coordinator with --machine MACHINE_ID");

const hostId = args[1];

if (!process.env.OMNYO_SERVER_URL)
  throw new Error("Run this installer in a coordinator-local Omnyo terminal");

const endpoint = new URL(process.env.OMNYO_SERVER_URL);

if (
  process.platform !== "darwin" ||
  !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)
)
  throw new Error("Run this installer locally on the selected Mac coordinator");

function api(argv, input) {
  return execFileSync("omnyo", argv, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
}

const status = JSON.parse(api(["status", "--json"]));

if (!status.dataDir) throw new Error("The selected server did not report its data directory");

const hosts = JSON.parse(api(["machine", "list", "--json"]));

if (!hosts.some((host) => host.id === hostId && host.status === "connected"))
  throw new Error("The exact coordinator must be connected");

const pointer = JSON.parse(await readFile(join(root, "dist/runtime-current.json"), "utf8"));

if (
  !/^[a-f0-9]{20}$/u.test(pointer.build) ||
  pointer.directory !== join(root, "dist/runtime", pointer.build)
)
  throw new Error("Invalid local runtime package pointer");

const base = join(status.dataDir, "plugins/local-builds/canvas");

const destination = join(base, pointer.build);

const plugins = JSON.parse(api(["plugin", "list", "--json"])).plugins;

const previous = plugins.find((plugin) => plugin.id === "canvas");

if (previous && !resolve(previous.rootDir).startsWith(base + "/"))
  throw new Error("The existing Canvas installation belongs to a different source");

const manifest = JSON.parse(await readFile(join(pointer.directory, "build.json"), "utf8"));

const packageJson = JSON.parse(await readFile(join(pointer.directory, "package.json"), "utf8"));

if (
  manifest.plugin !== "canvas" ||
  manifest.build !== pointer.build ||
  manifest.version !== pointer.version ||
  manifest.sourceCommit !== pointer.sourceCommit ||
  packageJson.name !== "omnyo-plugin-canvas" ||
  packageJson.version !== pointer.version
)
  throw new Error("The local runtime package is not the selected Canvas build");

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

  const target = resolve(destination, name);

  if (!target.startsWith(destination + sep)) throw new Error("Runtime path escapes its package");
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const ownedBase = await realpath(base);

  if (!parent.startsWith(ownedBase + sep)) throw new Error("Runtime destination escapes its store");

  try {
    await copyFile(join(pointer.directory, name), target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const actualHash = createHash("sha256")
    .update(await readFile(target))
    .digest("hex");

  if (actualHash !== sha256) throw new Error("Runtime transfer digest mismatch: " + name);

  transferred.push({ name, sha256 });
}

const installed = JSON.parse(api(["plugin", "install", "path:" + destination, "--yes", "--json"]));

const receipt = {
  sourceCommit: pointer.sourceCommit,
  destination,
  hostId,
  build: pointer.build,
  version: pointer.version,
  files: transferred,
  previous: previous
    ? { source: previous.source, rootDir: previous.rootDir, version: previous.version }
    : null,
  installed,
  status: "unverified",
  appBundle: null,
};

const receiptPath = join(root, "docs/evidence/runtime-install.json");

await mkdir(dirname(receiptPath), { recursive: true });

await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

const current = JSON.parse(api(["plugin", "list", "--json"])).plugins.find(
  (plugin) => plugin.id === "canvas",
);

if (
  current?.status !== "running" ||
  current.source !== "path:" + destination ||
  current.rootDir !== destination ||
  current.version !== pointer.version
)
  throw new Error("Canvas did not start from the exact transferred package");

receipt.status = current.status;

receipt.appBundle = current.app.bundle;

await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");

console.log(JSON.stringify({ destination, build: pointer.build, status: current.status }));

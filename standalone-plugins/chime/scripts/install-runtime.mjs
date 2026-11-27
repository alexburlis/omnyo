import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const BASE_URL = process.env.CHIME_OMNYO_BASE_URL ?? "http://127.0.0.1:38886";

const READ_CONCURRENCY = 4;

const root = resolve(import.meta.dirname, "..");

const CHECKOUT_DIRECTORIES = [root];

const args = process.argv.slice(2).filter((value) => value !== "--");

if (args.length !== 2 || args[0] !== "--machine" || !args[1])
  throw new Error("Usage: node scripts/install-runtime.mjs --machine <host-id>");

const hostId = args[1];

const run = promisify(execFile);

function api(argv) {
  return execFileSync("omnyo", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

const home = dirname(status.dataDir);

if (relative(home, pointer.directory).startsWith(".."))
  throw new Error("The local runtime package must be inside " + home);

const plugins = join(status.dataDir, "plugins");

const base = join(plugins, "local-builds/chime-local");

const cohort = join(plugins, "cache/identity-v1/chime-local");

const destination = join(base, pointer.build);

const previous = JSON.parse(api(["plugin", "list", "--json"])).plugins.find(
  (plugin) => plugin.id === "chime-local",
);

const fromLocalBuild = (plugin) =>
  plugin.source === "path:" + plugin.rootDir &&
  /^[a-f0-9]{20}$/u.test(relative(base, plugin.rootDir));

const fromCohort = (plugin) =>
  CHECKOUT_DIRECTORIES.some((directory) => plugin.source === "path:" + directory) &&
  /^[a-f0-9]{64}$/u.test(relative(cohort, plugin.rootDir));

const fromCheckout = (plugin) =>
  CHECKOUT_DIRECTORIES.some(
    (directory) => plugin.source === "path:" + directory && plugin.rootDir === directory,
  );

if (
  previous &&
  (previous.provenance !== "direct" ||
    !(fromLocalBuild(previous) || fromCohort(previous) || fromCheckout(previous)))
)
  throw new Error("The existing Chime installation belongs to a different source");

if (previous?.rootDir === destination)
  throw new Error("Chime already runs build " + pointer.build);

const removal =
  "omnyo file remove " +
  destination +
  " --host " +
  hostId +
  " --root " +
  plugins +
  " --recursive --yes";

if (existsSync(destination))
  throw new Error(
    destination + " already exists; inspect it, then remove it with `" + removal + "`",
  );

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

files.sort();

const expected = [...Object.keys(manifest.hashes), "build.json"].sort();

if (
  manifest.build !== pointer.build ||
  manifest.version !== pointer.version ||
  JSON.stringify(expected) !== JSON.stringify(files)
)
  throw new Error("The local runtime package does not match its build manifest");

const digests = new Map();

for (const name of files) {
  const sha256 = createHash("sha256")
    .update(await readFile(join(pointer.directory, name)))
    .digest("hex");

  if (name !== "build.json" && manifest.hashes[name] !== sha256)
    throw new Error("Local runtime digest mismatch: " + name);
  digests.set(name, sha256);
}

api(["file", "mkdir", base, "--host", hostId, "--root", plugins, "--recursive", "--json"]);

api(["file", "move", pointer.directory, destination, "--host", hostId, "--root", home, "--json"]);

const received = new Map();

const pending = [...files];

await Promise.all(
  Array.from({ length: READ_CONCURRENCY }, async () => {
    for (let name = pending.shift(); name !== undefined; name = pending.shift()) {
      const { stdout } = await run(
        "omnyo",
        ["file", "read", join(destination, name), "--host", hostId, "--root", plugins, "--json"],
        { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      );
      received.set(name, JSON.parse(stdout).sha256);
    }
  }),
);

const transferred = files.map((name) => {
  if (received.get(name) !== digests.get(name))
    throw new Error(
      "Runtime transfer digest mismatch: " + name + "; remove it with `" + removal + "`",
    );
  return { name, sha256: received.get(name) };
});

const installed = JSON.parse(api(["plugin", "install", "path:" + destination, "--yes", "--json"]));

if (installed.ok !== true || installed.plugin?.source !== "path:" + destination)
  throw new Error("The Chime installation did not report the transferred package");

const current = JSON.parse(api(["plugin", "list", "--json"])).plugins.find(
  (plugin) => plugin.id === "chime-local",
);

if (
  current?.source !== "path:" + destination ||
  current.rootDir !== destination ||
  current.version !== pointer.version ||
  current.status !== "running" ||
  current.app?.hasApp !== true ||
  current.app.bundle === null ||
  current.app.bundle.compatible !== true
)
  throw new Error("Chime did not start from the exact transferred package");

const headers = { origin: new URL(BASE_URL).origin };

const sounds = await Promise.all(
  Object.keys(manifest.hashes)
    .filter((name) => /^assets\/sounds\/[a-z0-9-]+\.wav$/u.test(name))
    .map(async (name) => {
      const id = name.slice("assets/sounds/".length, -".wav".length);
      const response = await fetch(
        new URL("/api/v1/plugins/chime-local/http/sound-" + id, BASE_URL),
        { headers },
      );
      const sha256 = createHash("sha256")
        .update(Buffer.from(await response.arrayBuffer()))
        .digest("hex");

      if (!response.ok || sha256 !== manifest.hashes[name])
        throw new Error("Chime does not serve " + name + " from the installed package");
      return id;
    }),
);

if (sounds.length === 0) throw new Error("The runtime package has no sounds to check");

const receipt = {
  sourceCommit: pointer.sourceCommit,
  destination,
  hostId,
  build: pointer.build,
  version: pointer.version,
  files: transferred,
  previous: previous ? { source: previous.source, version: previous.version } : null,
  installed: {
    source: installed.plugin.source,
    version: installed.plugin.version,
    status: installed.plugin.status,
  },
  status: current.status,
  statusDetail: current.statusDetail,
  appBundle: current.app.bundle,
  soundsServed: sounds.sort(),
};

await writeFile(
  join(root, "docs/evidence/runtime-install.json"),
  JSON.stringify(receipt, null, 2) + "\n",
);

await rm(join(root, "dist/runtime-current.json"));

if ((await readdir(join(root, "dist/runtime"))).length === 0)
  await rmdir(join(root, "dist/runtime"));

console.log(
  JSON.stringify({
    destination,
    build: pointer.build,
    status: current.status,
    statusDetail: current.statusDetail,
    soundsServed: sounds.length,
  }),
);

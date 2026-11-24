import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { z } from "zod";
import { copyPrivateSdkArtifact } from "../../plugin-sdk/scripts/private-artifact.mjs";

const execute = promisify(execFile);

export function npmLaunch(args, platform = process.platform) {
  return platform === "win32"
    ? {
        command: process.execPath,
        args: [
          join(
            dirname(process.execPath),
            "node_modules",
            "npm",
            "bin",
            "npm-cli.js",
          ),
          ...args,
        ],
      }
    : { command: "npm", args };
}

export const hostDependencyNames = Object.freeze([
  "@parcel/watcher",
  "fs-native-extensions",
  "node-pty",
  "pino",
  "pino-pretty",
  "pino-roll",
]);

const daemonFiles = [
  "omnyo",
  "omnyo.cmd",
  "omnyo-file-search-worker.mjs",
  "omnyo-parcel-watcher-child.mjs",
  "omnyo-plugin-host-worker.mjs",
  "omnyo-process-launcher-worker.mjs",
  "omnyo-workspace-observer-child.mjs",
  "omnyo-workspace-read-child.mjs",
  "omnyo-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
];

export async function buildHostArtifact({ packageRoot, protocolVersion }) {
  z.number().int().positive().parse(protocolVersion);

  const manifest = z
    .object({
      name: z.literal("omnyo-app"),
      version: z.string().min(1),
      os: z.array(z.string()),
      engines: z.object({ node: z.string() }),
      dependencies: z.record(z.string(), z.string()),
    })
    .parse(
      JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
    );

  const dependencies = Object.fromEntries(
    hostDependencyNames.map((name) => {
      const version = manifest.dependencies[name];

      if (version === undefined)
        throw new Error(`omnyo-app is missing host dependency ${name}`);

      return [name, version];
    }),
  );

  const scratch = await mkdtemp(join(tmpdir(), "omnyo-host-artifact-"));

  try {
    const stage = join(scratch, "package");
    await mkdir(join(stage, "dist"), { recursive: true });
    await mkdir(join(stage, "host-daemon/dist"), { recursive: true });

    await copyPrivateSdkArtifact(
      join(packageRoot, "dist", "plugin-sdk"),
      join(stage, "dist", "plugin-sdk"),
    );

    for (const name of [
      "omnyo-app.js",
      "omnyo-host-daemon.js",
      "omnyo.js",
      "machine-state.mjs",
      "state-admission.mjs",
      "runtime-identity-verifier.js",
    ]) {
      const target = join(stage, "dist", name);
      await copyFile(
        join(packageRoot, "dist", name),
        target,
        constants.COPYFILE_FICLONE,
      );
      await chmod(target, 0o755);
    }

    for (const name of daemonFiles)
      await copyFile(
        join(packageRoot, "host-daemon/dist", name),
        join(stage, "host-daemon/dist", name),
        constants.COPYFILE_FICLONE,
      );
    await chmod(join(stage, "host-daemon/dist/omnyo"), 0o755);
    await cp(
      join(packageRoot, "host-daemon/dist/omnyo-chunks"),
      join(stage, "host-daemon/dist/omnyo-chunks"),
      { recursive: true, mode: constants.COPYFILE_FICLONE },
    );

    await copyFile(
      join(packageRoot, "README.md"),
      join(stage, "README.md"),
      constants.COPYFILE_FICLONE,
    );

    await writeFile(
      join(stage, "package.json"),
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        description: "Omnyo enrolled host runtime",
        type: "module",
        os: [...new Set([...manifest.os, "win32"])],
        bin: {
          omnyo: "dist/omnyo.js",
          "omnyo-app": "dist/omnyo-app.js",
          "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
        },
        files: ["dist", "host-daemon", "README.md"],
        engines: manifest.engines,
        dependencies,
      }) + "\n",
    );

    const { createWorkerRuntimeIdentity, verifyWorkerRuntimeIdentity } =
      await import(
        pathToFileURL(join(stage, "dist", "runtime-identity-verifier.js")).href
      );

    const identity = await createWorkerRuntimeIdentity(stage, {
      runtimeVersion: manifest.version,
      hostDaemonProtocolVersion: protocolVersion,
    });

    await writeFile(
      join(stage, "dist", "runtime-identity.json"),
      JSON.stringify(identity) + "\n",
    );
    await verifyWorkerRuntimeIdentity(stage, identity);

    const pack = npmLaunch([
      "pack",
      stage,
      "--pack-destination",
      scratch,
      "--ignore-scripts",
      "--json",
    ]);

    const { stdout } = await execute(pack.command, pack.args, {
      maxBuffer: 10_000_000,
    });

    const [packed] = z
      .array(
        z.object({ filename: z.string().regex(/^[a-zA-Z0-9_.+-]+\.tgz$/u) }),
      )
      .length(1)
      .parse(JSON.parse(stdout));

    const packedPath = join(scratch, packed.filename);
    const bytes = await readFile(packedPath);

    const descriptor = {
      schemaVersion: 1,
      version: manifest.version,
      protocolVersion,
      digest: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };

    await copyFile(
      packedPath,
      join(packageRoot, "dist/host-artifact.tgz"),
      constants.COPYFILE_FICLONE,
    );
    await writeFile(
      join(packageRoot, "dist/host-artifact.json"),
      JSON.stringify(descriptor) + "\n",
    );

    return descriptor;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      package: { type: "string" },
      "protocol-version": { type: "string" },
    },
  });

  if (!values.package || !values["protocol-version"])
    throw new Error("Expected --package and --protocol-version");
  process.stdout.write(
    JSON.stringify(
      await buildHostArtifact({
        packageRoot: resolve(values.package),
        protocolVersion: Number(values["protocol-version"]),
      }),
    ) + "\n",
  );
}

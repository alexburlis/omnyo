import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyPrivateSdkArtifact } from "../../plugin-sdk/scripts/private-artifact.mjs";
import {
  buildNodeEsmEntry,
  copyDirectory,
  pruneUnreferencedChunks,
} from "../../../scripts/build-utils.mjs";
import { hostDependencyNames } from "./build-host-artifact.mjs";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const packageRoot = resolve(scriptsDir, "..");

const workspaceRoot = resolve(packageRoot, "..", "..");

const hostPackageRoot = resolve(packageRoot, "host-package");

const hostDaemonSource = resolve(workspaceRoot, "apps", "host-daemon", "dist");

const hostDaemonTarget = resolve(hostPackageRoot, "host-daemon", "dist");

const hostDaemonFiles = [
  "omnyo-file-search-worker.mjs",
  "omnyo-parcel-watcher-child.mjs",
  "omnyo-plugin-host-worker.mjs",
  "omnyo-process-launcher-worker.mjs",
  "omnyo-workspace-observer-child.mjs",
  "omnyo-workspace-read-child.mjs",
  "omnyo-provider-bridge-worker.mjs",
  "daemon-bundle.mjs",
];

const sourcePackageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);

const dependencies = Object.fromEntries(
  hostDependencyNames.map((name) => {
    const version = sourcePackageJson.dependencies?.[name];

    if (typeof version !== "string") {
      throw new Error(`Missing Omnyo host dependency ${name}`);
    }

    return [name, version];
  }),
);

await rm(hostPackageRoot, { force: true, recursive: true });

await buildNodeEsmEntry({
  cleanDist: true,
  entryPoint: resolve(packageRoot, "src", "bin", "omnyo-app.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "omnyo-app.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "omnyo.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "omnyo.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await buildNodeEsmEntry({
  cleanDist: false,
  entryPoint: resolve(packageRoot, "src", "bin", "omnyo-host-daemon.ts"),
  executable: true,
  outfile: resolve(hostPackageRoot, "dist", "omnyo-host-daemon.js"),
  packageRoot: hostPackageRoot,
  sourcemap: false,
});

await mkdir(hostDaemonTarget, { recursive: true });

await copyPrivateSdkArtifact(
  resolve(workspaceRoot, "packages", "plugin-sdk", "private-artifact"),
  resolve(hostPackageRoot, "dist", "plugin-sdk"),
);

await copyFile(
  resolve(hostDaemonSource, "omnyo"),
  resolve(hostDaemonTarget, "omnyo"),
);

await chmod(resolve(hostDaemonTarget, "omnyo"), 0o755);

await copyFile(
  resolve(hostDaemonSource, "omnyo.cmd"),
  resolve(hostDaemonTarget, "omnyo.cmd"),
);

await copyDirectory({
  from: resolve(hostDaemonSource, "omnyo-chunks"),
  to: resolve(hostDaemonTarget, "omnyo-chunks"),
});

await pruneUnreferencedChunks({
  chunkDir: resolve(hostDaemonTarget, "omnyo-chunks"),
  entry: resolve(hostDaemonTarget, "omnyo"),
});

for (const fileName of hostDaemonFiles) {
  await copyFile(
    resolve(hostDaemonSource, fileName),
    resolve(hostDaemonTarget, fileName),
  );
}

await copyFile(
  resolve(packageRoot, "README.md"),
  resolve(hostPackageRoot, "README.md"),
);

await writeFile(
  resolve(hostPackageRoot, "package.json"),
  `${JSON.stringify(
    {
      name: sourcePackageJson.name,
      version: sourcePackageJson.version,
      description: "Omnyo enrolled host runtime",
      type: "module",
      os: [...new Set([...sourcePackageJson.os, "win32"])],
      bin: {
        omnyo: "dist/omnyo.js",
        "omnyo-app": "dist/omnyo-app.js",
        "omnyo-host-daemon": "dist/omnyo-host-daemon.js",
      },
      files: ["dist", "host-daemon", "README.md"],
      engines: sourcePackageJson.engines,
      dependencies,
    },
    null,
    2,
  )}\n`,
);

for (const [entryPoint, outputName] of [
  [resolve(packageRoot, "src", "machine-state.ts"), "machine-state.mjs"],
  [resolve(packageRoot, "src", "state-admission.ts"), "state-admission.mjs"],
  [
    resolve(
      workspaceRoot,
      "packages",
      "server-archive",
      "src",
      "runtime-identity.ts",
    ),
    "runtime-identity-verifier.js",
  ],
]) {
  await buildNodeEsmEntry({
    cleanDist: false,
    entryPoint,
    outfile: resolve(hostPackageRoot, "dist", outputName),
    packageRoot: hostPackageRoot,
    sourcemap: false,
  });
}

const { HOST_DAEMON_PROTOCOL_VERSION } = await import(
  pathToFileURL(resolve(hostPackageRoot, "dist", "machine-state.mjs")).href
);

const { createWorkerRuntimeIdentity, verifyWorkerRuntimeIdentity } =
  await import(
    pathToFileURL(
      resolve(hostPackageRoot, "dist", "runtime-identity-verifier.js"),
    ).href
  );

const identity = await createWorkerRuntimeIdentity(hostPackageRoot, {
  runtimeVersion: sourcePackageJson.version,
  hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
});

await writeFile(
  resolve(hostPackageRoot, "dist", "runtime-identity.json"),
  JSON.stringify(identity) + "\n",
);

await verifyWorkerRuntimeIdentity(hostPackageRoot, identity);

process.stdout.write("omnyo-app: built and verified enrolled host package\n");

import { buildHostArtifact } from "./build-host-artifact.mjs";
import {
  RUNTIME_MAC_SIGNING_TEAM_ENV,
  signRuntimeMacNativeCode,
} from "./sign-mac-native-code.mjs";
import { copyPrivateSdkArtifact } from "../../plugin-sdk/scripts/private-artifact.mjs";
import {
  access,
  copyFile,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  buildNodeEsmEntry,
  copyDirectory,
} from "../../../scripts/build-utils.mjs";

const execFileAsync = promisify(execFile);

const scriptsDir = dirname(fileURLToPath(import.meta.url));

const packageRoot = resolve(scriptsDir, "..");

const workspaceRoot = resolve(packageRoot, "..", "..");

async function assertPathExists(pathToCheck, label) {
  try {
    await access(pathToCheck);
  } catch {
    throw new Error(
      `Missing ${label} at ${pathToCheck}. Build @omnyo/app, @omnyo/server, and @omnyo/host-daemon before packaging omnyo-app.`,
    );
  }
}

async function copyBuildOutput({ from, label, to }) {
  await assertPathExists(from, label);
  await copyDirectory({ from, to });
}

async function buildPublicSdkDeclarations() {
  await execFileAsync(
    "node",
    [resolve(scriptsDir, "build-public-sdk-dts.mjs")],
    { cwd: packageRoot },
  );
}

const entrypoints = [
  ["omnyo-app", "omnyo-app.js"],
  ["omnyo", "omnyo.js"],
  ["omnyo-server", "omnyo-server.js"],
  ["omnyo-host-daemon", "omnyo-host-daemon.js"],
];

const [[firstSourceName, firstOutputName], ...remainingEntrypoints] =
  entrypoints;

await buildNodeEsmEntry({
  cleanDist: true,
  entryPoint: resolve(packageRoot, "src", "bin", `${firstSourceName}.ts`),
  executable: true,
  outfile: resolve(packageRoot, "dist", firstOutputName),
  packageRoot,
});

const started = performance.now();

async function runBuildStep(name, operation) {
  process.stdout.write(
    JSON.stringify({
      buildStep: name,
      event: "start",
      elapsedMs: performance.now() - started,
    }) + "\n",
  );

  try {
    await operation();
    process.stdout.write(
      JSON.stringify({
        buildStep: name,
        event: "finish",
        elapsedMs: performance.now() - started,
      }) + "\n",
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        buildStep: name,
        event: "failed",
        elapsedMs: performance.now() - started,
      }) + "\n",
    );
    throw error;
  }
}

const stages = await Promise.allSettled([
  runBuildStep("public-sdk-declarations", buildPublicSdkDeclarations),
  runBuildStep("launchers-and-private-sdk", async () => {
    for (const [sourceName, outputName] of remainingEntrypoints) {
      await buildNodeEsmEntry({
        cleanDist: false,
        entryPoint: resolve(packageRoot, "src", "bin", `${sourceName}.ts`),
        executable: true,
        outfile: resolve(packageRoot, "dist", outputName),
        packageRoot,
      });
    }

    await copyPrivateSdkArtifact(
      resolve(workspaceRoot, "packages", "plugin-sdk", "private-artifact"),
      resolve(packageRoot, "dist", "plugin-sdk"),
    );

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(packageRoot, "src", "public-sdk.ts"),
      outfile: resolve(packageRoot, "dist", "index.js"),
      packageRoot,
    });

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(packageRoot, "src", "state-admission.ts"),
      outfile: resolve(packageRoot, "dist", "state-admission.mjs"),
      packageRoot,
    });

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(packageRoot, "src", "machine-state.ts"),
      outfile: resolve(packageRoot, "dist", "machine-state.mjs"),
      packageRoot,
    });

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(scriptsDir, "prune-omnyo-chunks.mjs"),
      outfile: resolve(packageRoot, "dist", "prune-omnyo-chunks.mjs"),
      packageRoot,
    });

    await buildNodeEsmEntry({
      cleanDist: false,
      entryPoint: resolve(
        workspaceRoot,
        "packages",
        "server-archive",
        "src",
        "runtime-identity.ts",
      ),
      outfile: resolve(packageRoot, "dist", "runtime-identity-verifier.js"),
      packageRoot,
    });
  }),
  runBuildStep("web-and-host-assets", async () => {
    await copyBuildOutput({
      from: resolve(workspaceRoot, "apps", "app", "dist"),
      label: "@omnyo/app dist",
      to: resolve(packageRoot, "app", "dist"),
    });

    await copyBuildOutput({
      from: resolve(workspaceRoot, "apps", "host-daemon", "dist"),
      label: "@omnyo/host-daemon dist",
      to: resolve(packageRoot, "host-daemon", "dist"),
    });
  }),
  runBuildStep("server-and-builtin-assets", async () => {
    await copyBuildOutput({
      from: resolve(workspaceRoot, "apps", "server", "dist"),
      label: "@omnyo/server dist",
      to: resolve(packageRoot, "server", "dist"),
    });

    await copyBuildOutput({
      from: resolve(workspaceRoot, "packages", "bundled-plugins", "dist"),
      label: "@omnyo/bundled-plugins dist",
      to: resolve(packageRoot, "server", "dist", "builtin-plugins"),
    });

    await copyFile(
      resolve(workspaceRoot, "LICENSE"),
      resolve(packageRoot, "dist", "LICENSE"),
    );
  }),
]);

for (const stage of stages) {
  if (stage.status === "rejected") throw stage.reason;
}

await assertPathExists(
  resolve(packageRoot, "host-daemon", "dist", "omnyo-chunks"),
  "bundled omnyo CLI chunks",
);

const pruneRun = await execFileAsync(
  "node",
  [resolve(packageRoot, "dist", "prune-omnyo-chunks.mjs")],
  { cwd: packageRoot },
);

process.stderr.write(pruneRun.stderr);

const { createRuntimeIdentity } = await import(
  pathToFileURL(resolve(packageRoot, "dist", "runtime-identity-verifier.js"))
    .href
);

const { getRuntimeBuildIdentity } = await import(
  pathToFileURL(resolve(packageRoot, "server", "dist", "start-server.js")).href
);

const packageJson = JSON.parse(
  await readFile(resolve(packageRoot, "package.json"), "utf8"),
);

const hostOutputRoot = resolve(packageRoot, "host-daemon", "dist");

for (const entry of await readdir(hostOutputRoot)) {
  const path = `host-daemon/dist/${entry}`;

  if (
    !packageJson.files.some(
      (included) => included === path || included.startsWith(path + "/"),
    )
  ) {
    await rm(resolve(hostOutputRoot, entry), { recursive: true });
  }
}

await buildHostArtifact({
  packageRoot,
  protocolVersion: getRuntimeBuildIdentity().hostDaemonProtocolVersion,
});

const runtimeMacSigningTeam = process.env[RUNTIME_MAC_SIGNING_TEAM_ENV];

if (runtimeMacSigningTeam) {
  const signed = await signRuntimeMacNativeCode({
    root: packageRoot,
    relativeRoots: ["dist", "server/dist", "host-daemon/dist", "app/dist"],
    team: runtimeMacSigningTeam,
    entitlements: resolve(
      workspaceRoot,
      "apps",
      "desktop",
      "build",
      "entitlements.mac.inherit.plist",
    ),
  });

  process.stdout.write(
    `omnyo-app: signed ${signed.length} macOS native files with team ${runtimeMacSigningTeam}\n`,
  );
}

const identity = await createRuntimeIdentity(packageRoot, {
  runtimeVersion: packageJson.version,
  hostDaemonProtocolVersion:
    getRuntimeBuildIdentity().hostDaemonProtocolVersion,
});

await writeFile(
  resolve(packageRoot, "dist", "runtime-identity.json"),
  JSON.stringify(identity) + "\n",
);

process.stdout.write("omnyo-app: built package assets\n");

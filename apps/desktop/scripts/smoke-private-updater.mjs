import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { z } from "zod";
import { createPackage } from "@electron/asar";
import { createRuntimeIdentity } from "../../../packages/server-archive/src/runtime-identity.js";
import { redactCredentialText } from "../../../packages/domain/src/credential-redaction.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);

function flag(name) {
  const index = args.indexOf(name);

  if (index < 0 || args[index + 1] === undefined)
    throw new Error(`Required ${name} argument is missing`);

  return args[index + 1];
}

const phase = flag("--phase");

assert.ok(phase === "baseline" || phase === "final");

const sourceApp = resolve(flag("--app-source"));

const output = resolve(flag("--output"));

assert.notEqual(sourceApp, "/Applications/Omnyo.app");

assert.ok(sourceApp.endsWith("/Omnyo.app"));

const scratch = await mkdtemp(join(tmpdir(), "omnyo-private-updater-native-"));

const fixtureId =
  "dev.omnyo.private.updater-fixture." +
  scratch.split("-").at(-1).toLowerCase();

const nativeHome = userInfo().homedir;

const nativeCachePaths = [
  join(nativeHome, "Library", "Caches", fixtureId + ".ShipIt"),
  join(nativeHome, "Library", "Application Support", fixtureId + ".ShipIt"),
];

nativeCachePaths.push(join(nativeHome, "Library", "Caches", fixtureId));

const retainedReports = output.replace(/\.json$/, "-reports");

for (const path of nativeCachePaths)
  assert.equal(
    await stat(path).then(
      () => true,
      () => false,
    ),
    false,
  );

const ownedChildren = new Set();

const fixtures = [];

const requests = [];

let server;

const result = {
  phase,
  sourceApp,
  cases: [],
  scratch,
  cleaned: false,
  limits: [
    "Owned updater fixtures only; no installed app activation",
    "Synthetic lifecycle hold is not server admission proof",
    "No notarization upload or real HTTPS/Tailnet deployment",
    "Fixture signatures omit timestamps; the separate minimal timestamp capability proof is retained",
  ],
};

const desktopRequire = createRequire(join(packageRoot, "package.json"));

const signingRequire = createRequire(
  desktopRequire.resolve("electron-builder"),
);

const { signAsync } = signingRequire("@electron/osx-sign");

const identity =
  "Developer ID Application: Burlis Management GmbH (Z7T4C33A35)";

function run(command, arguments_) {
  return execFileSync(command, arguments_, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: nativeHome },
  });
}

async function hash(path) {
  const digest = createHash("sha512");

  for await (const chunk of createReadStream(path)) digest.update(chunk);

  return digest.digest("base64");
}

async function fixture(version) {
  const appPath = join(
    scratch,
    "release-" + version,
    "Omnyo Updater Fixture.app",
  );

  const contents = join(appPath, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources", "app"), { recursive: true });
  run("/bin/cp", ["-cR", join(sourceApp, "Contents", "Frameworks"), contents]);
  run("/bin/cp", [
    "-c",
    join(sourceApp, "Contents", "MacOS", "Omnyo"),
    join(contents, "MacOS", "Omnyo"),
  ]);
  run("/bin/cp", [
    "-c",
    join(sourceApp, "Contents", "Info.plist"),
    join(contents, "Info.plist"),
  ]);

  for (const [key, value] of Object.entries({
    CFBundleIdentifier: fixtureId,
    CFBundleExecutable: "Omnyo",
    CFBundleName: "Omnyo",
    CFBundleDisplayName: "Omnyo",
    CFBundleVersion: version,
    CFBundleShortVersionString: version,
  })) {
    run("/usr/libexec/PlistBuddy", [
      "-c",
      `Set :${key} ${value}`,
      join(contents, "Info.plist"),
    ]);
  }

  await writeFile(
    join(contents, "Resources", "app", "package.json"),
    JSON.stringify({
      name: "omnyo-private-updater-fixture",
      version: version + "+private.2",
      main: "main.cjs",
    }),
  );
  await writeFile(
    join(contents, "Resources", "app-update.yml"),
    `updaterCacheDirName: ${fixtureId}\n`,
  );
  await build({
    entryPoints: [
      join(packageRoot, "test", "fixtures", "private-updater-native.mts"),
    ],
    outfile: join(contents, "Resources", "app", "main.cjs"),
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node24",
    external: ["electron", "original-fs", "@aws-sdk/client-s3"],
    conditions: ["source"],
    define: {
      "process.env.OMNYO_PRIVATE_UPDATER_FIXTURE_CONFIG": JSON.stringify(
        join(scratch, "active-control.json"),
      ),
    },
    logLevel: "silent",
  });

  await createPackage(
    join(contents, "Resources", "app"),
    join(contents, "Resources", "app.asar"),
  );
  await rm(join(contents, "Resources", "app"), { recursive: true });

  const runtimeRoot = join(
    contents,
    "Resources",
    "app.asar.unpacked",
    "node_modules",
    "omnyo-app",
  );

  for (const directory of [
    "dist",
    "server/dist",
    "host-daemon/dist",
    "app/dist",
  ])
    await mkdir(join(runtimeRoot, directory), { recursive: true });
  await writeFile(
    join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: version + "+private.2" }),
  );
  await writeFile(
    join(runtimeRoot, "dist", "omnyo-app.js"),
    "export const inertFixture = true;\n",
  );
  await writeFile(
    join(runtimeRoot, "server", "dist", "start-server.js"),
    "export const fixtureProtocol = 234;\n",
  );
  await writeFile(
    join(runtimeRoot, "host-daemon", "dist", "index.js"),
    "export const inertFixture = true;\n",
  );
  await writeFile(
    join(runtimeRoot, "app", "dist", "index.html"),
    "<title>Inert updater fixture</title>",
  );

  const runtimeIdentity = await createRuntimeIdentity(runtimeRoot, {
    runtimeVersion: version + "+private.2",
    hostDaemonProtocolVersion: 234,
  });

  await writeFile(
    join(runtimeRoot, "dist", "runtime-identity.json"),
    JSON.stringify(runtimeIdentity),
  );
  await signAsync({
    app: appPath,
    identity,
    platform: "darwin",
    type: "distribution",
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    optionsForFile: () => ({
      entitlements: join(packageRoot, "build", "entitlements.mac.plist"),
      hardenedRuntime: true,
      timestamp: "none",
    }),
  });
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  fixtures.push(appPath);

  return appPath;
}

async function launch(appPath, scenario, feedUrl) {
  const dir = join(scratch, scenario);
  await mkdir(join(dir, "user-data"), { recursive: true });
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      scenario,
      reportDirectory: dir,
      userData: join(dir, "user-data"),
      feedUrl,
      appId: fixtureId,
    }),
  );
  await writeFile(
    join(scratch, "active-control.json"),
    await readFile(configPath),
  );

  const child = spawn(join(appPath, "Contents", "MacOS", "Omnyo"), [], {
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: nativeHome,
      OMNYO_PRIVATE_UPDATER_FIXTURE_CONFIG: configPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  ownedChildren.add(child);
  let diagnostics = "";

  function collect(chunk) {
    if (diagnostics.length + chunk.length > 128 * 1024) {
      child.kill("SIGTERM");

      return;
    }

    diagnostics += chunk.toString("utf8");
  }

  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Owned updater fixture timed out")),
      90_000,
    );

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", async (code, signal) => {
      clearTimeout(timer);
      ownedChildren.delete(child);

      try {
        await writeFile(
          join(dir, "exit.json"),
          JSON.stringify({ pid: child.pid, code, signal }),
        );
        const prefix = "Native fixture diagnostics\n";
        await writeFile(
          join(dir, "diagnostics.txt"),
          redactCredentialText(prefix + diagnostics).slice(prefix.length),
        );
        code === 0
          ? resolvePromise()
          : reject(new Error("Owned updater fixture exited unsuccessfully"));
      } catch {
        reject(new Error("Owned fixture diagnostics withheld"));
      }
    });
  });

  return dir;
}

function ownedNativeActors() {
  const actors = new Set();

  for (const root of [scratch, ...nativeCachePaths]) {
    let records;

    try {
      records = run("/usr/sbin/lsof", ["-nP", "-Fpcfn", "+D", root]).toString(
        "utf8",
      );
    } catch (error) {
      if (error.status === 1) continue;
      throw new Error("Owned native process inventory failed");
    }

    let pid = null;
    let isText = false;

    for (const line of records.split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));

      if (line.startsWith("f")) isText = line === "ftxt";

      if (
        line.startsWith("n") &&
        isText &&
        pid !== null &&
        pid !== process.pid &&
        (line.slice(1).startsWith(scratch + "/") ||
          nativeCachePaths.some((path) => line.slice(1).startsWith(path + "/")))
      )
        actors.add(pid);
    }
  }

  return [...actors];
}

async function stopOwnedNativeActors() {
  const observed = ownedNativeActors();

  const alive = (pid) => {
    try {
      process.kill(pid, 0);

      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };

  for (const pid of observed) {
    if (alive(pid)) process.kill(pid, "SIGTERM");
  }

  const deadline = Date.now() + 5_000;

  while (observed.some(alive) && Date.now() < deadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  const remaining = observed.filter(alive);
  const stillOwned = ownedNativeActors();

  for (const pid of remaining) {
    if (!stillOwned.includes(pid))
      throw new Error("Native actor identity changed; storage remains bound");
    process.kill(pid, "SIGKILL");
  }

  const killDeadline = Date.now() + 1_000;

  while (remaining.some(alive) && Date.now() < killDeadline)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  assert.equal(
    remaining.some(alive),
    false,
    "Owned native actor survived; storage remains bound",
  );
  assert.deepEqual(ownedNativeActors(), []);
  result.nativeActors = { observed, remaining: [] };
}

try {
  const current = await fixture("0.46.1");

  if (phase === "baseline") {
    const dir = await launch(current, "baseline", "http://127.0.0.1:1/");

    const observed = JSON.parse(
      await readFile(join(dir, "result.json"), "utf8"),
    );

    result.cases.push({ name: "native install-on-quit baseline", ...observed });
    assert.equal(
      observed.passed,
      true,
      "Baseline exposes unsafe install-on-quit before any feed request",
    );
  } else {
    const next = await fixture("0.46.2");
    const archive = join(scratch, "Omnyo-Private-0.46.2-arm64.zip");
    run("/usr/bin/ditto", [
      "-c",
      "-k",
      "--sequesterRsrc",
      "--keepParent",
      next,
      archive,
    ]);
    let archiveSize = (await stat(archive)).size;
    let archiveDigest = await hash(archive);

    const signedArchivePath = join(next, "Contents", "Resources", "app.asar");

    const signedArchive = await readFile(signedArchivePath);
    let scenario = "digest-rejection";
    server = createServer((request, response) => {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      requests.push({ scenario, pathname });

      if (pathname === "/latest-mac.yml") {
        response.setHeader("content-type", "application/yaml");
        response.end(
          `version: 0.46.2\nreleaseDate: '2026-10-13T00:00:00.000Z'\nfiles:\n  - url: Omnyo-Private-0.46.2-arm64.zip\n    sha512: '${scenario === "digest-rejection" ? Buffer.alloc(64).toString("base64") : archiveDigest}'\n    size: ${archiveSize}\nomnyoPrivate:\n  appId: ${fixtureId}\n  teamId: Z7T4C33A35\n  runtimeVersion: 0.46.2+private.2\n  protocolVersion: 234\n`,
        );
      } else if (pathname === "/Omnyo-Private-0.46.2-arm64.zip") {
        response.setHeader("content-length", archiveSize);
        createReadStream(archive).pipe(response);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise((resolvePromise) =>
      server.listen(0, "127.0.0.1", resolvePromise),
    );

    const address = z
      .object({ port: z.number().int().positive() })
      .parse(server.address());

    const feedUrl = `http://127.0.0.1:${address.port}/`;

    const scenarios = [
      "digest-rejection",
      "active-work",
      "ordinary-quit",
      "signature-rejection",
      "install",
    ];

    const scenarioIndex = args.indexOf("--scenario");
    const selectedScenario = scenarioIndex < 0 ? null : args[scenarioIndex + 1];
    assert.ok(
      selectedScenario === null || scenarios.includes(selectedScenario),
    );
    result.selectedScenario = selectedScenario;

    for (scenario of scenarios.filter(
      (name) => selectedScenario === null || name === selectedScenario,
    )) {
      if (scenario === "signature-rejection") {
        await writeFile(
          signedArchivePath,
          Buffer.concat([signedArchive, Buffer.from("\nvoid 0;\n")]),
        );
        await rm(archive);
        run("/usr/bin/ditto", [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          next,
          archive,
        ]);
      }

      if (scenario === "install") {
        await writeFile(signedArchivePath, signedArchive);
        run("/usr/bin/codesign", ["--verify", "--deep", "--strict", next]);
        await rm(archive);
        run("/usr/bin/ditto", [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          next,
          archive,
        ]);
      }

      archiveSize = (await stat(archive)).size;
      archiveDigest = await hash(archive);
      const dir = await launch(current, scenario, feedUrl);
      const reportName = scenario === "install" ? "relaunch" : "result";

      if (scenario === "install") {
        const deadline = Date.now() + 60_000;

        while (
          !(await stat(join(dir, "relaunch.json")).then(
            () => true,
            () => false,
          )) &&
          Date.now() < deadline
        )
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }

      const observed = JSON.parse(
        await readFile(join(dir, reportName + ".json"), "utf8"),
      );

      result.cases.push({ name: scenario, ...observed });
      assert.equal(
        scenario === "install"
          ? observed.nativeInstallCompleted
          : observed.passed,
        true,
      );
    }

    result.artifact = {
      version: "0.46.2",
      sha512: archiveDigest,
      size: archiveSize,
    };
  }
} catch (error) {
  result.failure = redactCredentialText(
    error instanceof Error ? error.message : "Owned fixture failed",
  );
  process.exitCode = 1;
} finally {
  try {
    for (const child of ownedChildren) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill("SIGTERM");
      await new Promise((resolvePromise, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error("Owned fixture did not stop; storage remains bound"),
            ),
          5_000,
        );

        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    }

    if (server !== undefined)
      await new Promise((resolvePromise) => server.close(resolvePromise));
    await mkdir(retainedReports, { recursive: true });

    for (const item of await readdir(scratch, { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith("release-")) continue;
      const from = join(scratch, item.name);
      const to = join(retainedReports, item.name);
      await mkdir(to, { recursive: true });

      for (const entry of await readdir(from)) {
        if (entry.endsWith(".json") || entry === "diagnostics.txt")
          await writeFile(join(to, entry), await readFile(join(from, entry)));
      }
    }

    await stopOwnedNativeActors();

    for (const path of nativeCachePaths)
      await rm(path, { force: true, recursive: true });
    result.nativeCachePaths = nativeCachePaths;
    await rm(scratch, { force: true, recursive: true });
    result.cleaned = await stat(scratch).then(
      () => false,
      (error) => error.code === "ENOENT",
    );
  } catch (error) {
    result.cleanupFailure = redactCredentialText(
      error instanceof Error ? error.message : "Owned cleanup failed",
    );
    process.exitCode = 1;
  }

  result.requests = requests;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + "\n");

  if (!result.cleaned) process.exitCode = 1;
}

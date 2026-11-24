import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";

const execute = promisify(execFile);

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const [mode, preparedArgument, evidenceArgument] = process.argv.slice(2);

const prepared = resolve(preparedArgument ?? "");

assert.ok(
  preparedArgument && ["prepare", "run", "cleanup"].includes(mode),
  "Usage: node proof.mjs prepare PREPARED_DIR [SOURCE_ROOT] | run PREPARED_DIR EVIDENCE_DIR | cleanup PREPARED_DIR",
);

const owner = "worker-update-checkpoint-proof";

const nativePackages = [
  "@parcel/watcher",
  "better-sqlite3",
  "node-pty",
  "pino",
  "pino-pretty",
  "pino-roll",
  "thread-stream",
  "bufferutil",
  "fsevents",
  "utf-8-validate",
];

const sourceFiles = [
  "apps/host-daemon/src/app.ts",
  "apps/host-daemon/src/event-sink.ts",
  "apps/host-daemon/src/interactive-request-registry.ts",
  "apps/host-daemon/src/protocol-self-update.ts",
  "apps/host-daemon/src/server-client.ts",
  "packages/omnyo-app/src/launcher.ts",
  "packages/host-daemon-contract/src/session.ts",
  "apps/server/src/internal/events.ts",
  "apps/server/src/internal/interactive-requests.ts",
  "packages/db/src/data/events.ts",
  "packages/db/src/schema.ts",
  "apps/server/src/assets/install-machine.sh",
  "apps/server/src/assets/install-machine-windows.mjs",
  "packages/bundled-plugins/dist/marketplace.json",
  "tests/qa/worker-update-checkpoint/proof.mjs",
  "tests/qa/worker-update-checkpoint/worker.mjs",
  "tests/qa/worker-update-checkpoint/coordinator.mjs",
];

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

function childEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    TMP: home,
    TEMP: home,
    SystemRoot: process.env.SystemRoot,
    ComSpec: process.env.ComSpec,
    npm_config_cache: join(home, "npm-cache"),
    npm_config_userconfig: join(home, "npmrc"),
    npm_config_globalconfig: join(home, "global-npmrc"),
    npm_config_offline: "true",
    npm_config_audit: "false",
    npm_config_fund: "false",
    OMNYO_SENTRY_DSN: "",
    OMNYO_TELEMETRY: "false",
  };
}

async function command(commandName, args, options = {}) {
  return execute(commandName, args, {
    timeout: 60_000,
    maxBuffer: 8_000_000,
    ...options,
  });
}

async function stop(process) {
  process.expectedExit = true;

  if (process.child.exitCode !== null || process.child.signalCode !== null)
    return;
  process.child.kill("SIGTERM");
  const timeout = setTimeout(() => process.child.kill("SIGKILL"), 5_000);

  try {
    await process.exit;
  } finally {
    clearTimeout(timeout);
  }
}

if (mode === "prepare") {
  const sourceRoot = resolve(evidenceArgument ?? root);
  await mkdir(prepared);

  try {
    const marker = {
      owner,
      sourceRoot,
      thread: process.env.OMNYO_THREAD_ID ?? null,
      purpose: "Disposable prepared two-version worker artifacts",
      budgetBytes: 300_000_000,
    };

    await writeFile(
      join(prepared, "owner.json"),
      JSON.stringify(marker) + "\n",
    );
    const home = join(prepared, "home");
    await mkdir(home);
    await writeFile(join(home, "npmrc"), "");
    await writeFile(join(home, "global-npmrc"), "");
    const env = childEnv(home);
    const require = createRequire(join(sourceRoot, "package.json"));

    const protocolPath = join(
      sourceRoot,
      "packages/host-daemon-contract/src/protocol.ts",
    );

    const protocolSource = await readFile(protocolPath, "utf8");

    const oldProtocol = Number(
      /HOST_DAEMON_PROTOCOL_VERSION = (\d+)/u.exec(protocolSource)?.[1],
    );

    assert.ok(
      Number.isSafeInteger(oldProtocol) && oldProtocol > 0,
      "Source protocol must be explicit",
    );
    const nativeBindings = {};

    for (const name of nativePackages) {
      try {
        nativeBindings[name] =
          name === "better-sqlite3"
            ? createRequire(
                join(sourceRoot, "packages/db/package.json"),
              ).resolve(name)
            : require.resolve(name, {
                paths: [
                  sourceRoot,
                  join(sourceRoot, "apps/host-daemon"),
                  join(sourceRoot, "packages/omnyo-app"),
                ],
              });
      } catch {}
    }

    for (const name of [
      "@parcel/watcher",
      "better-sqlite3",
      "node-pty",
      "pino",
    ])
      assert.ok(
        nativeBindings[name],
        `Required installed native dependency is absent: ${name}`,
      );
    const sourceHashes = {};

    for (const name of sourceFiles)
      sourceHashes[name] = hash(await readFile(join(sourceRoot, name)));

    const checkpointHelper =
      "apps/host-daemon/src/update-delivery-checkpoint.ts";

    if (await exists(join(sourceRoot, checkpointHelper)))
      sourceHashes[checkpointHelper] = hash(
        await readFile(join(sourceRoot, checkpointHelper)),
      );

    const banner =
      'import { createRequire as __createRequire } from "node:module";import { dirname as __dirnameOf } from "node:path";import { fileURLToPath as __urlPath } from "node:url";const require=__createRequire(import.meta.url);const __filename=__urlPath(import.meta.url);const __dirname=__dirnameOf(__filename);';

    async function bundle(entryPoint, outfile, protocol) {
      await mkdir(dirname(outfile), { recursive: true });

      const result = await build({
        absWorkingDir: sourceRoot,
        metafile: true,
        entryPoints: [join(sourceRoot, entryPoint)],
        outfile,
        bundle: true,
        conditions: ["source"],
        platform: "node",
        format: "esm",
        target: "node22",
        nodePaths: [join(sourceRoot, "apps/server/node_modules")],
        legalComments: "none",
        logLevel: "silent",
        banner: { js: banner },
        plugins: [
          {
            name: "checkpoint-fixture-protocol",
            setup(builder) {
              builder.onLoad(
                {
                  filter: /packages\/host-daemon-contract\/src\/protocol\.ts$/,
                },
                () => ({
                  contents: protocolSource.replace(
                    /HOST_DAEMON_PROTOCOL_VERSION = \d+/u,
                    `HOST_DAEMON_PROTOCOL_VERSION = ${protocol}`,
                  ),
                  loader: "ts",
                }),
              );
              builder.onResolve(
                {
                  filter:
                    /^(?:@parcel\/watcher|better-sqlite3|node-pty|pino|pino-pretty|pino-roll|thread-stream|bufferutil|fsevents|utf-8-validate)(?:\/|$)/,
                },
                (args) => {
                  const packageName = nativePackages.find(
                    (name) =>
                      args.path === name || args.path.startsWith(name + "/"),
                  );

                  if (packageName && nativeBindings[packageName]) {
                    return {
                      path:
                        args.path === packageName
                          ? nativeBindings[packageName]
                          : require.resolve(args.path),
                      external: true,
                    };
                  }

                  return { path: args.path, external: true };
                },
              );
            },
          },
        ],
      });

      for (const input of Object.keys(result.metafile.inputs)) {
        const name = relative(sourceRoot, resolve(sourceRoot, input));

        if (sourceHashes[name] === undefined)
          sourceHashes[name] = hash(await readFile(resolve(sourceRoot, input)));
      }
    }

    const artifacts = [];

    for (const [label, protocol, version] of [
      ["old", oldProtocol, "99.0.0+private.1"],
      ["next", oldProtocol + 1, "99.0.1+private.1"],
    ]) {
      const packageRoot = join(prepared, label, "package");
      const daemonDirectory = join(packageRoot, "host-daemon/dist");
      await mkdir(daemonDirectory, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: "omnyo-app",
          version,
          type: "module",
          bin: { "omnyo-app": "dist/omnyo-app.js" },
          files: ["dist", "host-daemon"],
        }) + "\n",
      );
      await bundle(
        "packages/omnyo-app/src/bin/omnyo-app.ts",
        join(packageRoot, "dist/omnyo-app.js"),
        protocol,
      );
      await bundle(
        "tests/qa/worker-update-checkpoint/worker.mjs",
        join(daemonDirectory, "daemon-bundle.mjs"),
        protocol,
      );

      for (const [entry, output] of [
        [
          "packages/provider-bridge-protocol/src/bridge-worker-entry.ts",
          "omnyo-provider-bridge-worker.mjs",
        ],
        [
          "tests/scripted-echo-provider/src/provider-bridge.ts",
          "scripted-echo-provider.mjs",
        ],
        [
          "packages/host-watcher/src/parcel-subprocess/parcel-child-entry.ts",
          "omnyo-parcel-watcher-child.mjs",
        ],
        [
          "apps/host-daemon/src/plugin-host-worker.ts",
          "omnyo-plugin-host-worker.mjs",
        ],
        [
          "apps/host-daemon/src/command-handlers/file-search-worker.ts",
          "omnyo-file-search-worker.mjs",
        ],
        [
          "packages/process-utils/src/process-launcher-worker.ts",
          "omnyo-process-launcher-worker.mjs",
        ],
      ])
        await bundle(entry, join(daemonDirectory, output), protocol);
      await mkdir(join(daemonDirectory, "omnyo-chunks"));
      await bundle(
        "apps/cli/src/index.ts",
        join(daemonDirectory, "omnyo-chunks/cli.js"),
        protocol,
      );
      await writeFile(
        join(daemonDirectory, "omnyo"),
        'import "./omnyo-chunks/cli.js";\n',
      );
      const coordinator = join(prepared, label, "coordinator.mjs");
      await symlink(
        join(sourceRoot, "apps/server/node_modules"),
        join(prepared, label, "node_modules"),
        "dir",
      );
      await symlink(
        join(sourceRoot, "packages/bundled-plugins/dist"),
        join(prepared, label, "builtin-plugins"),
        "dir",
      );
      await cp(
        join(sourceRoot, "apps/server/src/assets"),
        join(prepared, label, "assets"),
        { recursive: true, mode: constants.COPYFILE_FICLONE },
      );
      await bundle(
        "tests/qa/worker-update-checkpoint/coordinator.mjs",
        coordinator,
        protocol,
      );
      await bundle(
        "apps/server/src/services/threads/timeline-worker.ts",
        join(prepared, label, "timeline-worker.js"),
        protocol,
      );
      await writeFile(
        join(prepared, label, "package.json"),
        JSON.stringify({ type: "module" }) + "\n",
      );
      const migrationDirectory = join(prepared, label, "drizzle");
      await cp(join(sourceRoot, "packages/db/drizzle"), migrationDirectory, {
        recursive: true,
        mode: constants.COPYFILE_FICLONE,
      });

      const packed = JSON.parse(
        (
          await command(
            "npm",
            [
              "pack",
              "--ignore-scripts",
              "--json",
              "--pack-destination",
              join(prepared, label),
            ],
            { cwd: packageRoot, env },
          )
        ).stdout,
      );

      const tarball = join(prepared, label, packed[0].filename);
      artifacts.push({
        label,
        protocol,
        version,
        tarball,
        coordinator,
        digest: hash(await readFile(tarball)),
      });
    }

    const manifest = {
      schema: 1,
      owner,
      sourceRoot,
      sourceHashes,
      nativeBindings,
      node: process.version,
      preparedAt: new Date().toISOString(),
      oldProtocol,
      old: artifacts[0],
      next: artifacts[1],
    };

    await writeFile(
      join(prepared, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        status: "prepared",
        manifest: join(prepared, "manifest.json"),
        node: process.version,
        versions: artifacts.map(({ version, protocol, digest }) => ({
          version,
          protocol,
          digest,
        })),
      }),
    );
    process.exit(0);
  } catch (error) {
    await rm(prepared, { recursive: true, force: true });
    console.error(
      JSON.stringify({
        status: "preparation-failed",
        preparedRemoved: !(await exists(prepared)),
        error: error.message,
      }),
    );
    throw error;
  }
}

const marker = JSON.parse(await readFile(join(prepared, "owner.json"), "utf8"));

assert.equal(
  marker.owner,
  owner,
  "Preparation directory is not owned by this producer",
);

if (mode === "cleanup") {
  await rm(prepared, { recursive: true, force: true });
  assert.equal(await exists(prepared), false);
  console.log(JSON.stringify({ status: "removed", prepared }));
  process.exit(0);
}

assert.ok(
  evidenceArgument,
  "Pass a new evidence directory outside the prepared directory",
);

const evidence = resolve(evidenceArgument);

assert.ok(
  evidence !== prepared && !evidence.startsWith(prepared + "/"),
  "Evidence must survive prepared-artifact cleanup",
);

await mkdir(evidence);

const manifest = JSON.parse(
  await readFile(join(prepared, "manifest.json"), "utf8"),
);

assert.equal(manifest.owner, owner);

for (const [name, expected] of Object.entries(manifest.sourceHashes))
  assert.equal(
    hash(await readFile(join(manifest.sourceRoot, name))),
    expected,
    `Prepared source changed: ${name}`,
  );

for (const artifact of [manifest.old, manifest.next])
  assert.equal(
    hash(await readFile(artifact.tarball)),
    artifact.digest,
    "Prepared artifact changed",
  );

const scratch = await mkdtemp(join(tmpdir(), "omnyo-worker-checkpoint-smoke-"));

const smokeStartedAt = Date.now();

const receipt = {
  schema: 1,
  owner,
  sourceHashes: manifest.sourceHashes,
  versions: [manifest.old, manifest.next].map(
    ({ version, protocol, digest }) => ({ version, protocol, digest }),
  ),
  node: process.version,
  scratch,
  scratchPurpose:
    "Disposable isolated npm prefix, daemon, coordinator DB, provider and logs",
  budgetBytes: 300_000_000,
  status: "running",
  checks: [],
  cleanup: [],
};

const children = [];

let providerPid = null;

try {
  await writeFile(
    join(evidence, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  const home = join(scratch, "home");
  await mkdir(home);
  await writeFile(join(home, "npmrc"), "");
  await writeFile(join(home, "global-npmrc"), "");
  const env = childEnv(home);

  const port = async () => {
    const listener = createServer();
    await new Promise((resolvePort) =>
      listener.listen(0, "127.0.0.1", resolvePort),
    );
    const value = listener.address().port;
    await new Promise((resolveClose) => listener.close(resolveClose));

    return value;
  };

  const serverPort = await port();
  const daemonPort = await port();
  const dataDir = join(scratch, "worker-data");

  const config = {
    ...manifest,
    dataDir,
    home,
    hostId: "host_checkpoint_smoke",
    hostKey: "test-daemon-key:host_checkpoint_smoke",
    serverPort,
    daemonPort,
    serverUrl: `http://127.0.0.1:${serverPort}`,
    database: join(scratch, "coordinator.sqlite"),
    workspace: join(scratch, "workspace"),
    entitiesFile: join(scratch, "entities.json"),
    coordinatorReady: join(scratch, "coordinator-ready.json"),
    coordinatorStarts: join(scratch, "coordinator-starts.jsonl"),
    emitSignal: join(scratch, "emit-signal"),
    emittedSignal: join(scratch, "emitted-signal"),
    oldVersion: manifest.old.version,
    outputMarker: `checkpoint-output-${randomUUID()}`,
  };

  const configPath = join(scratch, "fixture.json");
  await Promise.all([
    mkdir(dataDir),
    mkdir(config.workspace),
    writeFile(configPath, JSON.stringify(config), { mode: 0o600 }),
  ]);
  await writeFile(
    join(dataDir, "auth.json"),
    JSON.stringify({ hostId: config.hostId }),
  );
  await writeFile(join(dataDir, "host-id"), config.hostId);
  const prefix = join(scratch, "npm-prefix");
  const providerLog = join(scratch, "provider-process.log");
  const deadline = smokeStartedAt + 50_000;

  async function waitFor(label, read) {
    while (Date.now() < deadline) {
      const exited = children.find(
        (child) =>
          !child.expectedExit &&
          (child.child.exitCode !== null || child.child.signalCode !== null),
      );

      if (exited)
        throw new Error(
          `${exited.name} exited before ${label}: ${exited.child.exitCode ?? exited.child.signalCode}; ${exited.output.stderr.slice(-6_000)}`,
        );
      const result = await read();

      if (result) return result;
      await delay(30);
    }

    throw new Error(`50-second smoke deadline exceeded: ${label}`);
  }

  function start(name, entry, args = []) {
    const child = spawn(process.execPath, [entry, ...args], {
      env: {
        ...env,
        OMNYO_CHECKPOINT_SMOKE_CONFIG: configPath,
        OMNYO_APP_NPM_PREFIX: prefix,
        SCRIPTED_ECHO_PROCESS_LOG_PATH: providerLog,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", (bytes) => {
      output.stdout += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output.stderr += bytes;
    });

    const exit = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const result = { name, child, output, exit };
    children.push(result);

    return result;
  }

  const status = async () =>
    fetch(config.serverUrl + "/fixture/status", {
      signal: AbortSignal.timeout(800),
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null)
      .then((current) => {
        const responseStatus = current?.sessionOpens.at(-1)?.responseStatus;

        if (current)
          receipt.lastObservation = {
            protocol: current.protocol,
            sessionOpens: current.sessionOpens,
            pending: current.pending,
            output: current.output,
            terminals: current.terminals,
            lostEventAck: current.lostEventAck,
            interruptionPosts: current.interruptionPosts,
            rejectedOldProtocol: current.rejectedOldProtocol,
            eventFailures: current.eventFailures,
            inputAcceptedCount: current.inputAcceptedCount,
          };

        if (
          current?.protocol === manifest.old.protocol &&
          responseStatus >= 400
        )
          throw new Error(
            `Initial worker session refused: HTTP ${responseStatus}`,
          );

        return current;
      });

  await command(
    "npm",
    ["install", "-g", "--prefix", prefix, manifest.old.tarball],
    { cwd: scratch, env, timeout: Math.min(20_000, deadline - Date.now()) },
  );
  await writeFile(
    join(dataDir, "host-artifact.sha256"),
    manifest.old.digest + "\n",
  );
  let coordinator = start("coordinator-N", manifest.old.coordinator);
  await waitFor(
    "old coordinator health",
    async () => (await status())?.protocol === manifest.old.protocol,
  );
  const launcher = join(prefix, "lib/node_modules/omnyo-app/dist/omnyo-app.js");
  start("launcher", launcher, [
    "host-daemon",
    "--supervise",
    "--data-dir",
    dataDir,
    "--host-daemon-port",
    String(daemonPort),
    "--host-id",
    config.hostId,
    "--server-url",
    config.serverUrl,
  ]);
  await waitFor("real scripted provider user question", async () =>
    (await status())?.pending.some((record) => record.status === "pending"),
  );
  const log = await readFile(providerLog, "utf8");
  providerPid = Number(
    log
      .split("\n")
      .find((line) => line.startsWith("spawn:"))
      ?.slice(6),
  );
  assert.ok(
    Number.isSafeInteger(providerPid) && providerPid > 1,
    "Real bridge process PID must be recorded by the scripted provider",
  );
  await stop(coordinator);
  coordinator = start("coordinator-N+1", manifest.next.coordinator);
  await waitFor(
    "real incompatible session rejection",
    async () => (await status())?.rejectedOldProtocol > 0,
  );
  await writeFile(config.emitSignal, "emit\n");
  await waitFor("ordinary output queued after protocol rejection", async () =>
    exists(config.emittedSignal),
  );
  process.kill(providerPid, "SIGKILL");
  providerPid = null;

  const result = await waitFor(
    "replacement worker and retained delivery",
    async () => {
      const current = await status();

      const checkpointPath = join(dataDir, "worker-update-checkpoint.json");

      const checkpoint = await readFile(checkpointPath, "utf8")
        .then((value) => JSON.parse(value))
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });

      receipt.checkpointObservation = checkpoint
        ? {
            present: true,
            events: checkpoint.events.map((event) => ({
              instanceId: event.instanceId,
              index: event.index,
              blockedReason: event.blockedReason,
            })),
            interrupts: checkpoint.interrupts.map((interrupt) => ({
              deliveryId: interrupt.deliveryId,
            })),
          }
        : { present: false };

      if (
        !current ||
        current.output.length !== 1 ||
        current.terminals.length !== 1 ||
        !current.lostEventAck ||
        current.interruptionPosts < 1 ||
        current.pending.some(
          (record) =>
            record.status === "pending" || record.status === "resolving",
        )
      )
        return null;

      const starts = (
        await readFile(join(dataDir, "worker-starts.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      if (
        !starts.some(
          (record) => record.protocolVersion === manifest.next.protocol,
        )
      )
        return null;

      if (await exists(join(dataDir, "worker-update-checkpoint.json")))
        return null;

      return { ...current, starts };
    },
  );

  assert.equal(
    result.starts.length,
    2,
    "The existing launcher must start exactly one replacement worker",
  );
  assert.notEqual(result.starts[0].instanceId, result.starts[1].instanceId);
  assert.equal(result.starts[1].version, manifest.next.version);
  assert.ok(
    result.sessionOpens.some(
      (request) =>
        request.protocolVersion === manifest.next.protocol &&
        request.undeliveredEventThreadIds.includes(result.entities.threadId),
    ),
    "The new worker must restore retained thread IDs before handshake",
  );
  assert.ok(
    result.output[0].sequence < result.terminals[0].sequence,
    "Ordinary output must precede the terminal event",
  );
  assert.equal(
    (await readFile(join(dataDir, "host-artifact.sha256"), "utf8")).trim(),
    manifest.next.digest,
  );
  assert.equal(
    await exists(join(dataDir, "worker-update-checkpoint.json")),
    false,
    "Acknowledged checkpoint must retire",
  );
  receipt.status = "passed";
  receipt.checks = [
    "N work session connected",
    "real scripted bridge question registered",
    "N+1 rejected N protocol",
    "real provider process exited",
    "actual npm installer replaced package",
    "real launcher restarted one worker",
    "restored IDs appeared in new handshake",
    "retained output preceded terminal event",
    "post-commit lost acknowledgment did not duplicate output",
    "exact interruption settled",
    "installed artifact digest matched",
    "acknowledged checkpoint retired",
  ];
  receipt.observed = {
    rejectedOldProtocol: result.rejectedOldProtocol,
    starts: result.starts,
    outputSequence: result.output[0].sequence,
    terminalSequence: result.terminals[0].sequence,
    interruptionPosts: result.interruptionPosts,
    lostEventAck: result.lostEventAck,
  };
} catch (error) {
  receipt.status = "failed";
  receipt.error = { name: error.name, message: error.message };
  throw error;
} finally {
  await Promise.all([...children].reverse().map((child) => stop(child)));

  for (const child of [...children].reverse()) {
    await writeFile(
      join(evidence, child.name + ".stdout.log"),
      child.output.stdout,
    );
    await writeFile(
      join(evidence, child.name + ".stderr.log"),
      child.output.stderr,
    );
  }

  if (providerPid !== null) {
    try {
      process.kill(providerPid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  await rm(scratch, { recursive: true, force: true });
  receipt.cleanup.push({ path: scratch, absent: !(await exists(scratch)) });
  receipt.finishedAt = new Date().toISOString();
  receipt.elapsedMs = Date.now() - smokeStartedAt;
  await writeFile(
    join(evidence, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: join(evidence, "receipt.json"),
      checks: receipt.checks.length,
      cleanup: receipt.cleanup,
    }),
  );
}

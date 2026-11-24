import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  createConnection,
  getPluginKvValue,
  getInstalledPluginRegistration,
  getPluginSettingsValues,
  migrate,
  setPluginSettingsValues,
  upsertInstalledPlugin,
} from "../../../packages/db/src/index.ts";
import {
  RELEASE_VERSION_PATTERN,
  macBundleVersion,
  parseReleaseVersion,
} from "../../../packages/config/src/release-version.mjs";
import {
  readRuntimeIdentity,
  verifyRuntimeIdentity,
} from "../../../packages/server-archive/src/runtime-identity.ts";
import { proveNotifications } from "./notifications.mjs";

const execute = promisify(execFile);

const systemEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
  LC_ALL: "C",
};

const targetNames = ["composer-predictions", "account-usage", "account-pool"];

const migratedIds = [
  "composer-predictions",
  "account-usage",
  "omnyo--composer-predictions",
  "omnyo--account-usage",
  "account-pool",
];

const composerSettings = {
  enabled: "false",
  cliPath: JSON.stringify("/nonexistent/private-native-codex-must-not-run"),
};

const usageSettings = {
  qaMigrationValue: JSON.stringify("native-migration-preserved"),
};

const timeoutMs = 60_000;

const shutdownTimeoutMs = 25_000;

const report = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  verifiedSurface:
    "macOS packaged native app, bundled local server, SQLite migration, native graceful shutdown",
  limitations: [
    "No provider inference, account login, reset redemption, physical input, or human play is exercised.",
    "No screenshot or rendered-interface claim is made.",
  ],
  launches: [],
  attempts: [],
  cleanup: null,
  status: "running",
};

let scratch;

let evidenceDir;

let appPath;

let executable;

let bridgePath;

let userDataDir;

let dataDir;

let serverUrl;

let ports = [];

let activeAppPid = null;

let notificationsEnabled = false;

const tracked = new Map();

const launchLogs = [];

let launchIdentity = null;

async function run(command, args) {
  const result = await execute(command, args, {
    env: systemEnv,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  return result.stdout.trim();
}

async function present(path) {
  try {
    await access(path);

    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function sleep(ms) {
  await new Promise((done) => setTimeout(done, ms));
}

async function waitFor(label, work, limit = timeoutMs) {
  const deadline = Date.now() + limit;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await work();

      if (result !== null && result !== false) return result;
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw new Error(
    `${label} timed out${lastError ? `: ${lastError.message}` : ""}`,
  );
}

async function json(url, method = "GET", input) {
  const options = {
    method,
    headers: { Origin: serverUrl, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(10_000),
  };

  if (input !== undefined) options.body = JSON.stringify(input);
  const response = await fetch(url, options);
  assert.equal(
    response.ok,
    true,
    `${new URL(url).pathname} returned HTTP ${response.status}`,
  );

  return await response.json();
}

async function rpc(id, method, input = null) {
  const response = await json(
    `${serverUrl}/api/v1/plugins/${id}/rpc/${method}`,
    "POST",
    input,
  );

  assert.equal(response.ok, true, `${id}.${method} did not acknowledge`);

  return response.result;
}

async function hashFile(path) {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(path)) hash.update(chunk);

  return hash.digest("hex");
}

async function hashBundle() {
  const entries = [];

  async function visit(path) {
    const metadata = await lstat(path);
    const name = relative(appPath, path);

    if (metadata.isSymbolicLink())
      entries.push({ path: name, link: await readlink(path) });
    else if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await visit(join(path, child));
    } else if (metadata.isFile())
      entries.push({
        path: name,
        size: metadata.size,
        sha256: await hashFile(path),
      });
    else throw new Error(`Unsupported bundle member: ${name}`);
  }

  await visit(appPath);

  return {
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    fileCount: entries.length,
    fileBytes: entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
    entries,
  };
}

async function reuseLifecycle(path, bundle) {
  assert.ok(isAbsolute(path), "Lifecycle result path must be absolute");
  const contents = await readFile(path, "utf8");
  const prior = JSON.parse(contents);
  assert.equal(prior.schemaVersion, 1);
  assert.equal(prior.status, "passed");
  assert.equal(prior.reusedLifecycle, undefined);
  assert.equal(prior.launches.length, 3);
  assert.deepEqual(
    prior.launches.map((entry) => [entry.index, entry.case]),
    [
      [1, "fresh-store-with-predictions-disabled-safety-setting"],
      [2, "seeded-legacy-migration"],
      [3, "seeded-legacy-migration"],
    ],
  );

  for (const entry of prior.launches) {
    assert.equal(entry.shutdown.gracefulNativeQuit, true);
    assert.deepEqual(entry.shutdown.survivors, []);
    assert.deepEqual(entry.shutdown.listenerOwners, [[], []]);
    assert.deepEqual(entry.shutdown.scratchActors, []);
    assert.equal(entry.shutdown.runtimeMarkerAbsent, true);
    assert.equal(entry.version.currentVersion, report.package.version);
  }

  assert.equal(prior.cleanup.removed, true);
  assert.deepEqual(prior.cleanup.failures, []);
  assert.deepEqual(prior.cleanup.remaining, {
    actors: [],
    listeners: [[], []],
    scratchActors: [],
    nativeApplications: [],
  });
  assert.equal(prior.idempotence.registrationRowsUnchanged, true);
  assert.equal(prior.idempotence.settingRowsAndTimestampsUnchanged, true);
  assert.equal(prior.idempotence.bundleBytesUnchanged, true);
  assert.equal(prior.idempotence.bundleSha256, bundle.sha256);

  for (const key of [
    "receiptSha256",
    "sourceCommit",
    "version",
    "protocolVersion",
    "installed",
  ])
    assert.deepEqual(prior.candidateBinding[key], report.candidateBinding[key]);

  for (const key of [
    "bundleId",
    "name",
    "version",
    "nativeVersion",
    "nativeBuild",
    "expectedDesktopVersion",
    "expectedIdentitySource",
    "runtimeIdentity",
    "bundle",
  ])
    assert.deepEqual(prior.package[key], report.package[key]);

  const manifestPath = join(dirname(path), "bundle-manifest.json");
  const manifestContents = await readFile(manifestPath, "utf8");
  assert.deepEqual(JSON.parse(manifestContents), bundle);

  return {
    resultPath: path,
    resultSha256: createHash("sha256").update(contents).digest("hex"),
    manifestPath,
    manifestSha256: createHash("sha256").update(manifestContents).digest("hex"),
    completedAt: prior.completedAt,
    verifiedLaunchCount: prior.launches.length,
    scope: "Prior three-launch lifecycle and seeded-startup idempotence only",
    currentScope:
      "One isolated seeded launch, notification proof and graceful cleanup",
  };
}

async function unusedPort() {
  const socket = createServer();
  await new Promise((done, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", done);
  });
  const address = socket.address();
  assert.ok(address !== null && Number.isInteger(address.port));
  const port = address.port;
  await new Promise((done, reject) =>
    socket.close((error) => (error ? reject(error) : done())),
  );

  return port;
}

async function processTable() {
  const output = await run("/bin/ps", ["-c", "-axo", "pid=,ppid=,comm="]);

  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);

    return match
      ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: match[3] }]
      : [];
  });
}

async function birth(pid) {
  try {
    return await run("/bin/ps", ["-p", String(pid), "-o", "lstart="]);
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}

async function textFiles(pid) {
  try {
    return (
      await run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "txt", "-Fn"])
    )
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

async function rememberTree(pid) {
  const rows = await processTable();
  const owned = new Set([pid]);
  let changed = true;

  while (changed) {
    changed = false;

    for (const row of rows)
      if (owned.has(row.ppid) && !owned.has(row.pid)) {
        owned.add(row.pid);
        changed = true;
      }
  }

  for (const row of rows)
    if (owned.has(row.pid) && !tracked.has(row.pid))
      tracked.set(row.pid, { ...row, birth: await birth(row.pid) });

  return rows.filter((row) => owned.has(row.pid));
}

async function listeners(port) {
  try {
    return (
      await run("/usr/sbin/lsof", [
        "-nP",
        `-iTCP:${port}`,
        "-sTCP:LISTEN",
        "-t",
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

async function scratchActors() {
  try {
    return (await run("/usr/sbin/lsof", ["-t", "+D", scratch]))
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch (error) {
    if (error.code === 1) return [];
    throw error;
  }
}

async function survivors() {
  const live = [];

  for (const actor of tracked.values())
    if (actor.birth !== null && (await birth(actor.pid)) === actor.birth)
      live.push(actor);

  return live;
}

function withDb(work) {
  const db = createConnection(join(dataDir, "app.db"));

  try {
    return work(db);
  } finally {
    db.$client.close();
  }
}

function snapshot() {
  return withDb((db) => ({
    registrations: migratedIds.map((id) => ({
      id,
      row: getInstalledPluginRegistration(db, id) ?? null,
    })),
    settings: migratedIds.map((id) => ({
      id,
      values: getPluginSettingsValues(db, id),
      rows: db.$client
        .prepare(
          "SELECT key, value, updated_at FROM plugin_settings WHERE plugin_id = ? ORDER BY key",
        )
        .all(id),
    })),
    threadCount: db.$client
      .prepare("SELECT count(*) AS count FROM threads")
      .get().count,
    eventCount: db.$client.prepare("SELECT count(*) AS count FROM events").get()
      .count,
  }));
}

function seed(roots, manifests) {
  withDb((db) => {
    migrate(db);

    const add = (id, name, enabled, builtin) =>
      upsertInstalledPlugin(db, {
        id,
        enabled,
        enabledFollowsDefault: false,
        rootDir: roots[name],
        version: manifests[name].version,
        updateState: {
          lastCheckAt: null,
          availableCompatibleVersion: null,
          newestIncompatibleVersion: null,
          statusDetail: null,
        },
        activeArtifactId: null,
        source: builtin ? `builtin:${name}` : `path:${roots[name]}`,
        provenance: { kind: builtin ? "builtin" : "direct" },
        sourceIntent: builtin
          ? { kind: "builtin", name }
          : { kind: "path", canonicalPath: roots[name] },
        exactResolution: { kind: builtin ? "builtin" : "path" },
      });

    add("composer-predictions", "composer-predictions", false, false);
    add("account-usage", "account-usage", true, false);
    add("account-pool", "account-pool", true, true);
    setPluginSettingsValues(db, "composer-predictions", composerSettings);
    setPluginSettingsValues(db, "account-usage", usageSettings);
  });
}

function assertMigration(value, roots, fresh) {
  const rows = Object.fromEntries(
    value.registrations.map((entry) => [entry.id, entry.row]),
  );

  if (fresh) {
    for (const [id, name, enabled] of [
      ["omnyo--composer-predictions", "composer-predictions", true],
      ["omnyo--account-usage", "account-usage", true],
      ["account-pool", "account-pool", false],
    ]) {
      assert.equal(rows[id].enabled, enabled);
      assert.equal(rows[id].enabledFollowsDefault, true);
      assert.equal(rows[id].source, `builtin:${name}`);
      assert.equal(rows[id].rootDir, roots[name]);
    }

    assert.equal(rows["composer-predictions"], null);
    assert.equal(rows["account-usage"], null);
    assert.deepEqual(
      value.settings.find((item) => item.id === "omnyo--composer-predictions")
        .values,
      composerSettings,
    );
    assert.equal(value.threadCount, 0);
    assert.equal(value.eventCount, 0);

    return;
  }

  for (const id of ["composer-predictions", "account-usage"])
    assert.equal(rows[id].enabled, false, `${id} must remain disabled`);

  for (const [id, name, enabled] of [
    ["omnyo--composer-predictions", "composer-predictions", false],
    ["omnyo--account-usage", "account-usage", true],
    ["account-pool", "account-pool", true],
  ]) {
    assert.equal(rows[id].enabled, enabled);
    assert.equal(rows[id].enabledFollowsDefault, false);
    assert.equal(rows[id].source, `builtin:${name}`);
    assert.equal(rows[id].rootDir, roots[name]);
    assert.equal(rows[id].sourceKind, "builtin");
    assert.equal(rows[id].sourceBuiltinName, name);
    assert.equal(rows[id].removedAt, null);
  }

  const settings = Object.fromEntries(
    value.settings.map((item) => [item.id, item.values]),
  );

  assert.deepEqual(settings["omnyo--composer-predictions"], composerSettings);
  assert.deepEqual(settings["omnyo--account-usage"], usageSettings);
  assert.equal(value.threadCount, 0, "Native boot must not create a thread");
  assert.equal(
    value.eventCount,
    0,
    "Native boot must not create provider/thread events",
  );
}

async function nativeApplications() {
  const output = await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit'); const target = ${JSON.stringify(executable)}; const apps = $.NSWorkspace.sharedWorkspace.runningApplications; const matches = []; for (let i = 0; i < apps.count; i++) { const app = apps.objectAtIndex(i); const url = app.executableURL; if (url && ObjC.unwrap(url.path) === target) matches.push(Number(app.processIdentifier)); } JSON.stringify(matches);`,
  ]);

  return JSON.parse(output);
}

async function discoverNativeApplication() {
  const candidates = await nativeApplications();
  assert.ok(
    candidates.length <= 1,
    "Ambiguous exact candidate native ownership",
  );

  if (candidates.length === 0) return null;
  const pid = candidates[0];
  const started = await birth(pid);
  assert.ok(started, "Candidate native PID must be live");
  assert.ok((await textFiles(pid)).includes(executable));

  if (launchIdentity !== null) {
    assert.equal(pid, launchIdentity.pid);
    assert.equal(started, launchIdentity.birth);
  } else {
    launchIdentity = { pid, birth: started, executable };
    report.attempts.at(-1).native = launchIdentity;
  }

  activeAppPid = pid;
  await rememberTree(pid);

  return launchIdentity;
}

async function captureLaunchLogs() {
  const patterns = {
    keychain: /keychain/iu,
    encryption: /safeStorage|decrypt|encrypt/iu,
    sandbox: /sandbox|operation not permitted/iu,
    bridge: /bridge/iu,
    moduleResolution:
      /Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/iu,
    sqlite: /SQLITE_[A-Z_]+/u,
    fatal: /uncaught|unhandled|fatal|Error:/iu,
    loader: /(?:env:|execvp|posix_spawn).*(?:No such file|not found|ENOENT)/iu,
    architecture:
      /dyld|Library not loaded|incompatible architecture|Bad CPU type/iu,
    launchServices:
      /LSOpen|kLS|RBSRequestError|LaunchServices|launchd.*(?:denied|refused|error)/iu,
    crashpad: /crashpad|crash_report/iu,
    chromium: /Chromium|chrome_main|zygote|gpu_process|FATAL:/iu,
    serverTarget: /server.{0,24}(?:url|https?:\/\/)/iu,
  };

  for (const { attempt, paths } of launchLogs) {
    attempt.logMetadata = {};

    for (const [name, path] of Object.entries(paths)) {
      if (!(await present(path))) continue;
      const contents = await readFile(path, "utf8");
      attempt.logMetadata[name] = {
        bytes: (await lstat(path)).size,
        sha256: await hashFile(path),
        errorCodes: [
          ...new Set(
            contents.match(
              /\b(?:EACCES|EPERM|ENOENT|EADDRINUSE|ECONNREFUSED|ERR_[A-Z_]+|SQLITE_[A-Z_]+)\b/gu,
            ) ?? [],
          ),
        ],
        diagnosticLines: contents.split("\n").flatMap((line, index) => {
          const kinds = Object.entries(patterns)
            .filter(([, pattern]) => pattern.test(line))
            .map(([kind]) => kind);

          return kinds.length ? [{ line: index + 1, kinds }] : [];
        }),
      };
    }
  }

  await writeFile(
    join(evidenceDir, "launch-metadata.json"),
    `${JSON.stringify(report.attempts, null, 2)}\n`,
  );
}

async function discoverApp() {
  const markerPath = join(userDataDir, "owned-runtime.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  assert.equal(marker.bridgePath, bridgePath);
  assert.equal(marker.serverUrl, serverUrl);
  const rows = await processTable();
  const bridge = rows.find((row) => row.pid === marker.pid);
  assert.ok(bridge, "Owned bridge must be live");
  assert.ok(
    (await textFiles(bridge.ppid)).includes(executable),
    "Bridge parent must be this packaged native executable",
  );
  assert.ok(
    (await textFiles(marker.pid)).includes(executable),
    "Bundled bridge must use this packaged Electron runtime",
  );
  assert.equal(bridge.ppid, launchIdentity?.pid);
  assert.equal(await birth(bridge.ppid), launchIdentity.birth);
  activeAppPid = bridge.ppid;

  return {
    marker,
    appPid: activeAppPid,
    actors: await rememberTree(activeAppPid),
  };
}

async function quitOwnedApp() {
  if (activeAppPid === null) return;
  assert.ok(
    (await textFiles(activeAppPid)).includes(executable),
    "Refuse to terminate a native PID with changed ownership",
  );
  assert.equal(await birth(activeAppPid), launchIdentity?.birth);
  await rememberTree(activeAppPid);

  const output = await run("/usr/bin/osascript", [
    "-l",
    "JavaScript",
    "-e",
    `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${activeAppPid}); if (!app || !app.terminate) throw new Error('Owned native app refused graceful termination'); 'termination-requested';`,
  ]);

  assert.equal(output, "termination-requested");
  await waitFor(
    "Exact owned native graceful shutdown",
    async () =>
      (await survivors()).length === 0 &&
      (await Promise.all(ports.map(listeners))).every(
        (pids) => pids.length === 0,
      ) &&
      (await scratchActors()).length === 0 &&
      !(await present(join(userDataDir, "owned-runtime.json"))),
    shutdownTimeoutMs,
  );
  activeAppPid = null;
}

async function selectBuiltinServer() {
  const path = join(userDataDir, "server-target.json");

  const value = {
    connectServer: null,
    customServerUrl: null,
    customServerUrls: [],
    target: "builtin",
  };

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  report.isolation.serverTargets ??= [];

  report.isolation.serverTargets.push({
    path,
    value,
    sha256: await hashFile(path),
  });
}

async function launch(index, childEnv, roots, fresh = false) {
  assert.deepEqual(
    await nativeApplications(),
    [],
    "Candidate executable already has a live consumer",
  );
  launchIdentity = null;

  for (const port of ports)
    assert.deepEqual(
      await listeners(port),
      [],
      `Port ${port} must be unused before native launch`,
    );
  assert.equal(await present(join(userDataDir, "owned-runtime.json")), false);

  const logPaths = {
    stdout: join(scratch, `native-${index}.stdout.log`),
    stderr: join(scratch, `native-${index}.stderr.log`),
  };

  const attempt = {
    index,
    startedAt: new Date().toISOString(),
    executable,
    userDataDir,
  };

  report.attempts.push(attempt);
  launchLogs.push({ attempt, paths: logPaths });

  const clearNames = Object.keys(process.env).filter(
    (name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && !(name in childEnv),
  );

  const envArgs = [
    ...clearNames.map((name) => ["--env", `${name}=`]),
    ...Object.entries(childEnv).map(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
  ].flat();

  const args = [
    "-g",
    "-j",
    "-n",
    "-a",
    appPath,
    "--stdout",
    logPaths.stdout,
    "--stderr",
    logPaths.stderr,
    ...envArgs,
    "--args",
    `--user-data-dir=${userDataDir}`,
  ];

  await execute("/usr/bin/open", args, {
    env: childEnv,
    timeout: 15_000,
    encoding: "utf8",
  });

  attempt.launchServicesReturnedAt = new Date().toISOString();
  await waitFor(
    "Exact LaunchServices native application",
    discoverNativeApplication,
  );

  const ownership = await waitFor(
    "Real packaged bridge ownership",
    discoverApp,
  );

  const health = await waitFor("Bundled server health", () =>
    json(`${serverUrl}/health`),
  );

  assert.equal(health.ok, true);
  const config = await json(`${serverUrl}/api/v1/system/config`);
  assert.equal(config.dataDir, dataDir);
  assert.equal(config.hostDaemonPort, ports[1]);
  assert.equal(config.serverUrl, serverUrl);
  assert.equal(config.appVersion, report.package.version);

  const plugins = await waitFor(
    "Bundled private plugin discovery",
    async () => {
      const value = await json(`${serverUrl}/api/v1/plugins`);
      assert.ok(Array.isArray(value.plugins));

      for (const [id, name, enabled] of [
        ["omnyo--composer-predictions", "composer-predictions", fresh],
        ["omnyo--account-usage", "account-usage", true],
        ["account-pool", "account-pool", !fresh],
      ]) {
        const matches = value.plugins.filter((plugin) => plugin.id === id);
        assert.equal(matches.length, 1, `${id} must be discovered once`);
        assert.equal(matches[0].source, `builtin:${name}`);
        assert.equal(matches[0].provenance, "builtin");
        assert.equal(matches[0].rootDir, roots[name]);
        assert.equal(matches[0].isOrphanedBuiltin, false);
        assert.equal(matches[0].enabled, enabled);
        assert.ok(
          (enabled
            ? ["running", "needs-configuration"]
            : ["disabled"]
          ).includes(matches[0].status),
          `${id}: ${matches[0].status}`,
        );
      }

      return value.plugins;
    },
  );

  let accounts = [];
  let routedThreads = [];

  if (!fresh) {
    accounts = await waitFor("Account Pooler read-only account RPC", () =>
      rpc("account-pool", "account.list"),
    );
    assert.deepEqual(accounts, []);

    const poolStatus = await waitFor(
      "Account Pooler read-only status RPC",
      () => rpc("account-pool", "status.get"),
    );

    assert.deepEqual(poolStatus.accounts, []);
    routedThreads = await waitFor("Account Pooler routed-thread RPC", () =>
      rpc("account-pool", "status.routedThreads"),
    );
    assert.deepEqual(routedThreads, []);
  } else {
    const settings = await json(
      `${serverUrl}/api/v1/plugins/omnyo--composer-predictions/settings`,
    );

    assert.equal(settings.ok, true);
    assert.equal(settings.values.enabled, false);
    assert.equal(settings.values.cliPath, JSON.parse(composerSettings.cliPath));
  }

  const usage = await waitFor("Account Usage read-only snapshot RPC", () =>
    rpc("omnyo--account-usage", "snapshot"),
  );

  assert.equal(usage.poolUnavailable, fresh);
  assert.equal(usage.error, null);
  assert.ok(Array.isArray(usage.groups));

  for (const group of usage.groups) assert.equal(group.accounts.length, 0);
  const version = await json(`${serverUrl}/api/v1/system/version`);
  assert.equal(version.installKind, "desktop");
  assert.equal(version.currentVersion, report.package.version);

  const listenerOwners = await waitFor(
    "App-owned server and daemon listener readiness",
    async () => {
      const actors = await rememberTree(ownership.appPid);
      const actorPids = new Set(actors.map((actor) => actor.pid));
      const owners = await Promise.all(ports.map(listeners));

      for (let portIndex = 0; portIndex < ports.length; portIndex++) {
        assert.equal(
          owners[portIndex].length,
          1,
          `Port ${ports[portIndex]} must have one listener`,
        );
        assert.ok(
          actorPids.has(owners[portIndex][0]),
          "Listener must descend from the tested native app",
        );
      }

      return owners;
    },
  );

  assert.notEqual(
    listenerOwners[0][0],
    listenerOwners[1][0],
    "Server and daemon must be distinct owned actors",
  );
  const liveDb = snapshot();
  assertMigration(liveDb, roots, fresh);

  const record = {
    index,
    case: fresh
      ? "fresh-store-with-predictions-disabled-safety-setting"
      : "seeded-legacy-migration",
    ownership,
    actors: [...tracked.values()],
    serverUrl,
    listenerOwners,
    health,
    config: {
      dataDir: config.dataDir,
      serverUrl: config.serverUrl,
      hostDaemonPort: config.hostDaemonPort,
    },
    version,
    plugins: plugins.filter((plugin) => migratedIds.includes(plugin.id)),
    accounts,
    routedThreads,
    usage: {
      poolUnavailable: usage.poolUnavailable,
      error: usage.error,
      groupCount: usage.groups.length,
    },
    liveDb,
  };

  report.launches.push(record);

  if (notificationsEnabled && index === 3) {
    record.notifications = {};
    const appBirth = await birth(activeAppPid);
    assert.ok(appBirth);
    await proveNotifications({
      evidenceDir,
      result: record.notifications,
      binding: {
        candidate: report.candidateBinding,
        bundleSha256: report.package.bundle.sha256,
        appPath,
        appPid: activeAppPid,
        appBirth,
        dataDir,
        userDataDir,
        serverUrl,
      },
      rpc: (method, input) => rpc("push-notifications", method, input),
      async configure() {
        const values = {
          mobileEnabled: false,
          webEnabled: false,
          desktopEnabled: true,
        };

        const url = `${serverUrl}/api/v1/plugins/push-notifications/settings`;
        await json(url, "PUT", { values });
        const configured = await json(url);
        assert.equal(configured.ok, true);

        for (const [key, value] of Object.entries(values))
          assert.equal(configured.values[key], value);

        return values;
      },
      readNotice(id) {
        return withDb((db) => {
          const value = getPluginKvValue(
            db,
            "push-notifications",
            `queued-notification:${id}`,
          );

          return value === undefined ? null : JSON.parse(value);
        });
      },
      async assertOwnership() {
        assert.equal(await birth(record.ownership.appPid), appBirth);
        const current = await discoverApp();
        assert.equal(current.appPid, record.ownership.appPid);
        assert.equal(
          (await json(`${serverUrl}/api/v1/system/config`)).dataDir,
          dataDir,
        );
      },
    });
  }

  await quitOwnedApp();
  record.shutdown = {
    gracefulNativeQuit: true,
    survivors: await survivors(),
    listenerOwners: await Promise.all(ports.map(listeners)),
    scratchActors: await scratchActors(),
    runtimeMarkerAbsent: !(await present(
      join(userDataDir, "owned-runtime.json"),
    )),
  };
  record.persistedDb = snapshot();
  assertMigration(record.persistedDb, roots, fresh);
  record.logHashes = {};

  for (const [name, path] of Object.entries(logPaths))
    if (await present(path))
      record.logHashes[name] = {
        bytes: (await lstat(path)).size,
        sha256: await hashFile(path),
      };

  return record;
}

async function cleanup() {
  const failures = [];

  if (scratch === undefined) return { createdScratch: false };

  if (
    activeAppPid === null &&
    userDataDir &&
    (await present(join(userDataDir, "owned-runtime.json")))
  ) {
    try {
      await discoverApp();
    } catch {
      failures.push(
        "Could not establish native ownership from the retained marker",
      );
    }
  }

  if (activeAppPid === null && report.attempts.length > 0)
    await discoverNativeApplication();

  if (activeAppPid !== null) {
    try {
      await quitOwnedApp();
    } catch {
      failures.push(
        "Graceful cleanup failed; exact owned actors require bounded termination",
      );
    }
  }

  for (const actor of (await survivors()).reverse()) {
    if ((await birth(actor.pid)) !== actor.birth) continue;

    try {
      process.kill(actor.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }

  if ((await survivors()).length > 0) {
    await sleep(2_000);

    for (const actor of (await survivors()).reverse()) {
      if ((await birth(actor.pid)) !== actor.birth) continue;

      try {
        process.kill(actor.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }

    await sleep(500);
  }

  const remaining = {
    actors: await survivors(),
    listeners: await Promise.all(ports.map(listeners)),
    scratchActors: await scratchActors(),
    nativeApplications: await nativeApplications(),
  };

  await captureLaunchLogs();

  if (
    remaining.actors.length ||
    remaining.listeners.some((owners) => owners.length) ||
    remaining.scratchActors.length ||
    remaining.nativeApplications.length
  )
    return { scratch, removed: false, failures, remaining };

  if (report.status === "failed")
    return {
      scratch,
      removed: false,
      failures,
      remaining,
      diagnosticsPending: true,
    };
  await rm(scratch, { recursive: true, force: false });
  assert.equal(await present(scratch), false);

  return { scratch, removed: true, failures, remaining };
}

async function main() {
  assert.equal(
    process.platform,
    "darwin",
    "This proof requires the packaged macOS app",
  );

  const { values, positionals } = parseArgs({
    options: {
      "candidate-receipt": { type: "string" },
      notifications: { type: "boolean", default: false },
      "reuse-lifecycle": { type: "string" },
    },
    allowPositionals: true,
  });

  const [appArgument, evidenceArgument, scratchArgument] = positionals;
  notificationsEnabled = values.notifications;
  assert.ok(
    !notificationsEnabled || values["candidate-receipt"],
    "Notification proof requires the exact continuous candidate receipt",
  );
  assert.ok(
    values["reuse-lifecycle"] === undefined ||
      (notificationsEnabled && values["candidate-receipt"]),
    "Lifecycle reuse requires --notifications and --candidate-receipt",
  );

  if (notificationsEnabled)
    report.limitations[1] =
      "Native notification/window claims require the external driver's bound observed artifacts; thread deep links are not exercised.";

  assert.ok(
    appArgument && evidenceArgument,
    "Usage: node --conditions=source --import tsx tests/qa/private-native/proof.mjs /absolute/Omnyo.app /absolute/evidence [new-absolute-scratch] [--candidate-receipt /absolute/results/native-build.json]",
  );
  assert.ok(positionals.length <= 3, "Unexpected positional argument");
  assert.ok(isAbsolute(appArgument) && isAbsolute(evidenceArgument));
  let candidate = null;

  if (values["candidate-receipt"] !== undefined) {
    const path = values["candidate-receipt"];
    assert.ok(isAbsolute(path), "Candidate receipt path must be absolute");
    const contents = await readFile(path, "utf8");

    candidate = JSON.parse(contents);
    assert.equal(candidate?.schema, 1);
    assert.equal(candidate.surface, "native");
    assert.equal(candidate.phase, "build");
    assert.equal(candidate.status, "complete");
    assert.match(candidate.version, RELEASE_VERSION_PATTERN);
    assert.match(candidate.sourceCommit, /^[a-f0-9]{40}$/u);
    assert.ok(
      Number.isSafeInteger(candidate.protocolVersion) &&
        candidate.protocolVersion > 0,
    );
    const installed = candidate.installedIdentities?.macos;

    assert.equal(installed?.appId, "dev.omnyo.private");
    assert.equal(installed.runtimeVersion, candidate.version);
    assert.equal(installed.protocolVersion, candidate.protocolVersion);
    assert.match(installed.runtimeSha256, /^[a-f0-9]{64}$/u);
    assert.match(installed.desktopSha256, /^[a-f0-9]{64}$/u);
    report.candidateBinding = {
      receiptPath: path,
      receiptSha256: createHash("sha256").update(contents).digest("hex"),
      sourceCommit: candidate.sourceCommit,
      version: candidate.version,
      protocolVersion: candidate.protocolVersion,
      installed,
    };
  }

  appPath = await realpath(appArgument);
  assert.ok(
    !appPath.startsWith("/Applications/"),
    "Run the prepared private bundle; never launch an installed app",
  );
  evidenceDir = resolve(evidenceArgument);
  await mkdir(evidenceDir, { recursive: true });
  assert.equal(
    await present(join(evidenceDir, "result.json")),
    false,
    "Use a new artifact directory for each run",
  );

  const info = JSON.parse(
    await run("/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(appPath, "Contents/Info.plist"),
    ]),
  );

  assert.equal(info.CFBundleIdentifier, "dev.omnyo.private");
  assert.equal(info.CFBundleName, "Omnyo");
  executable = join(appPath, "Contents/MacOS", info.CFBundleExecutable);
  const unpacked = join(appPath, "Contents/Resources/app.asar.unpacked");
  bridgePath = join(unpacked, "dist/omnyo-app-bridge.mjs");
  const packageRoot = join(unpacked, "node_modules/omnyo-app");

  const packageJson = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );

  const desktopPackageJson = JSON.parse(
    await readFile(
      new URL("../../../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  );

  const expectedDesktopVersion =
    candidate === null ? desktopPackageJson.version : candidate.version;

  const runtimeIdentity = await verifyRuntimeIdentity(
    packageRoot,
    await readRuntimeIdentity(packageRoot),
  );

  assert.equal(runtimeIdentity.runtimeVersion, packageJson.version);

  if (candidate !== null) {
    assert.equal(runtimeIdentity.runtimeVersion, candidate.version);
    assert.equal(
      runtimeIdentity.hostDaemonProtocolVersion,
      candidate.protocolVersion,
    );
    assert.equal(
      runtimeIdentity.runtimeSha256,
      candidate.installedIdentities.macos.runtimeSha256,
    );
    assert.equal(
      await hashFile(join(appPath, "Contents/Resources/app.asar")),
      candidate.installedIdentities.macos.desktopSha256,
    );
  }

  const roots = Object.fromEntries(
    targetNames.map((name) => [
      name,
      join(packageRoot, "server/dist/builtin-plugins", name),
    ]),
  );

  const manifests = {};

  for (const name of targetNames)
    manifests[name] = JSON.parse(
      await readFile(join(roots[name], "package.json"), "utf8"),
    );

  for (const path of [
    executable,
    bridgePath,
    join(packageRoot, "server/dist/index.js"),
    join(packageRoot, "host-daemon/dist/daemon-bundle.mjs"),
  ])
    assert.equal(await present(path), true, `Missing packaged input: ${path}`);
  assert.match(await readFile(bridgePath, "utf8"), /--bundled/u);
  assert.match(await readFile(bridgePath, "utf8"), /--no-in-app-updates/u);
  report.package = {
    appPath,
    bundleId: info.CFBundleIdentifier,
    name: info.CFBundleName,
    version: packageJson.version,
    nativeVersion: info.CFBundleShortVersionString,
    nativeBuild: info.CFBundleVersion,
    expectedDesktopVersion,
    expectedIdentitySource:
      candidate === null ? "canonical-checkout" : "candidate-receipt",
    runtimeIdentity: {
      runtimeSha256: runtimeIdentity.runtimeSha256,
      protocolVersion: runtimeIdentity.hostDaemonProtocolVersion,
    },
    executable,
    bridgePath,
    packageRoot,
    roots,
    manifests,
  };
  assert.equal(packageJson.name, "omnyo-app");
  assert.equal(packageJson.private, true);
  assert.equal(desktopPackageJson.private, true);
  assert.equal(packageJson.version, expectedDesktopVersion);

  const releaseVersion = parseReleaseVersion(packageJson.version);

  assert.ok(
    releaseVersion,
    "Packaged logical version must be a release version",
  );
  assert.equal(report.package.nativeVersion, releaseVersion.numeric);
  assert.equal(
    report.package.nativeBuild,
    runtimeIdentity.hostDaemonProtocolVersion >= 236
      ? macBundleVersion(packageJson.version)
      : releaseVersion.numeric,
  );
  const before = await hashBundle();
  await writeFile(
    join(evidenceDir, "bundle-manifest.json"),
    `${JSON.stringify(before, null, 2)}\n`,
  );
  report.package.bundle = {
    sha256: before.sha256,
    fileCount: before.fileCount,
    fileBytes: before.fileBytes,
  };

  if (values["reuse-lifecycle"] !== undefined)
    report.reusedLifecycle = await reuseLifecycle(
      values["reuse-lifecycle"],
      before,
    );

  if (scratchArgument) {
    assert.ok(isAbsolute(scratchArgument));
    scratch = resolve(scratchArgument);
    assert.equal(
      await present(scratch),
      false,
      "Scratch path must be new and owned by this run",
    );
    await mkdir(scratch, { recursive: false, mode: 0o700 });
  } else scratch = await mkdtemp(join(tmpdir(), "omnyo-private-native-"));
  assert.ok(
    evidenceDir !== scratch && !evidenceDir.startsWith(`${scratch}/`),
    "Evidence must be outside disposable scratch",
  );
  const nativeHomeDir = await realpath(userInfo().homedir);
  assert.equal((await lstat(nativeHomeDir)).isDirectory(), true);
  const runtimeHomeDir = join(scratch, "home");
  dataDir = join(scratch, "fresh-data");
  userDataDir = join(scratch, "fresh-electron");
  const tempDir = join(scratch, "tmp");

  for (const path of [runtimeHomeDir, dataDir, userDataDir, tempDir])
    await mkdir(path, { mode: 0o700 });

  const providerDirs = {
    CODEX_HOME: join(runtimeHomeDir, ".codex"),
    CLAUDE_CONFIG_DIR: join(runtimeHomeDir, ".claude"),
    PI_CODING_AGENT_DIR: join(runtimeHomeDir, ".pi", "agent"),
  };

  for (const path of Object.values(providerDirs))
    await mkdir(path, { recursive: true, mode: 0o700 });

  const runtimeEnvironment = {
    env: { HOME: runtimeHomeDir, PATH: systemEnv.PATH },
  };

  const runtimeEnvironmentContents = `${JSON.stringify(runtimeEnvironment, null, 2)}\n`;
  await writeFile(join(dataDir, "env.json"), runtimeEnvironmentContents, {
    mode: 0o600,
  });
  ports = [await unusedPort(), await unusedPort()];

  while (ports[0] === ports[1]) ports[1] = await unusedPort();
  serverUrl = `http://127.0.0.1:${ports[0]}`;

  const childEnv = {
    ...systemEnv,
    ...providerDirs,
    HOME: nativeHomeDir,
    ZDOTDIR: runtimeHomeDir,
    TMPDIR: `${tempDir}/`,
    XDG_CONFIG_HOME: join(runtimeHomeDir, ".config"),
    XDG_CACHE_HOME: join(runtimeHomeDir, ".cache"),
    NODE_ENV: "production",
    OMNYO_DATA_DIR: dataDir,
    OMNYO_SERVER_BIND_HOST: "127.0.0.1",
    OMNYO_SERVER_PORT: String(ports[0]),
    OMNYO_HOST_DAEMON_PORT: String(ports[1]),
    OMNYO_SENTRY_DSN: "",
    OMNYO_TELEMETRY: "false",
    OMNYO_DESKTOP_OPEN_DEVTOOLS: "0",
  };

  report.isolation = {
    scratch,
    freshDataDir: dataDir,
    freshUserDataDir: userDataDir,
    nativeHomeDir,
    nativeHomeSource: "node:os.userInfo().homedir",
    runtimeHomeDir,
    providerDirs,
    runtimeEnvironment,
    freshRuntimeEnvironmentPath: join(dataDir, "env.json"),
    ports,
    passedEnvironmentNames: Object.keys(childEnv).sort(),
    callerEnvironmentValuesInherited: false,
    launch:
      "open -g -j -n -a <tested bundle> with explicit isolated --env values and --user-data-dir",
  };

  if (report.reusedLifecycle === undefined) {
    withDb((db) => {
      migrate(db);
      setPluginSettingsValues(
        db,
        "omnyo--composer-predictions",
        composerSettings,
      );
    });
    report.freshSeed = snapshot();
    assert.ok(
      report.freshSeed.registrations.every((entry) => entry.row === null),
      "Fresh case must not preinstall plugin registrations",
    );
    await selectBuiltinServer();
    await launch(1, childEnv, roots, true);
    tracked.clear();
  }

  dataDir = join(scratch, "seeded-data");
  userDataDir = join(scratch, "seeded-electron");
  await mkdir(dataDir, { mode: 0o700 });
  await mkdir(userDataDir, { mode: 0o700 });
  await writeFile(join(dataDir, "env.json"), runtimeEnvironmentContents, {
    mode: 0o600,
  });
  childEnv.OMNYO_DATA_DIR = dataDir;
  report.isolation.seededDataDir = dataDir;
  report.isolation.seededUserDataDir = userDataDir;
  report.isolation.seededRuntimeEnvironmentPath = join(dataDir, "env.json");
  seed(roots, manifests);
  await selectBuiltinServer();
  report.seed = snapshot();

  if (report.reusedLifecycle === undefined) {
    const first = await launch(2, childEnv, roots);
    tracked.clear();
    const second = await launch(3, childEnv, roots);
    assert.deepEqual(
      second.persistedDb.registrations,
      first.persistedDb.registrations,
      "Second native startup must not rewrite migrated registrations",
    );
    assert.deepEqual(
      second.persistedDb.settings,
      first.persistedDb.settings,
      "Second native startup must not rewrite migrated settings",
    );
    report.idempotence = {
      registrationRowsUnchanged: true,
      settingRowsAndTimestampsUnchanged: true,
    };
  } else await launch(3, childEnv, roots);
  const after = await hashBundle();
  assert.equal(
    after.sha256,
    before.sha256,
    "The exact app payload must remain unchanged across current native launches",
  );
  report.bundleIntegrity = {
    bundleBytesUnchanged: true,
    bundleSha256: after.sha256,
  };

  if (report.idempotence !== undefined)
    Object.assign(report.idempotence, report.bundleIntegrity);
  report.status = "passed";
}

try {
  await main();
} catch (error) {
  report.status = "failed";
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  try {
    report.cleanup = await cleanup();

    if (report.cleanup.removed === false || report.cleanup.failures?.length) {
      report.status = "failed";
      process.exitCode = 1;
    }
  } catch (error) {
    report.cleanup = { scratch, removed: false, failure: error.message };
    report.status = "failed";
    process.exitCode = 1;
  }

  report.completedAt = new Date().toISOString();

  if (evidenceDir)
    await writeFile(
      join(evidenceDir, "result.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  console.log(
    JSON.stringify({
      status: report.status,
      artifact: evidenceDir ? join(evidenceDir, "result.json") : null,
      failure: report.failure?.message,
      cleanup: report.cleanup,
    }),
  );
}

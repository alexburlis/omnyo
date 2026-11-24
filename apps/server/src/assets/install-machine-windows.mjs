import { execFile, spawn } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PACKAGE_DOWNLOAD_TIMEOUT_MS = 300_000;

const DAEMON_WAIT_ATTEMPTS = 120;

const WAIT_PROGRESS_EVERY_ATTEMPTS = 15;

const FIRST_HOST_DAEMON_PORT = 38888;

const NATIVE_MODULES = "better-sqlite3,node-pty,@parcel/watcher";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const INSTALLER_FILE_NAME = "install-machine-windows.mjs";

const SERVICE_FILE_NAME = "machine-service.json";

const PID_FILE_NAME = "install-daemon.pid";

const LEGACY_WORKER_ROOT_V1 = ".bb-machines";

const ATTEMPT_FILE_NAME = "host-daemon-update-attempt.json";

const INSTALLED_DIGEST_FILE_NAME = "host-artifact.sha256";

const PENDING_INSTALL_FILE_NAME = "host-daemon-pending-install.json";

const PENDING_INSTALL_TARBALL_NAME = "host-daemon-pending-install.tgz";

const SERVICE_INSTALL_EXIT_CODE = 76;

const RECONCILIATION_DIR_NAME = "update-reconciliations";

const INSTALLER_TIMEOUT_MS = 600_000;

const PACKAGE_RELEASE_TIMEOUT_MS = 30_000;

const NPM_RETIRED_ENTRY_PATTERN =
  /^\.(?:omnyo|omnyo-app|omnyo-host-daemon)(?:\.cmd|\.ps1)?-[A-Za-z0-9_-]{8}$/u;

const ARTIFACT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;

const ARTIFACT_SIGNATURE_MESSAGE_PREFIX = "omnyo-host-artifact-v1";

export const HOST_ARTIFACT_SIGNING_PUBLIC_KEYS = [
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIO7mX4VG4BJBYtyzrplzZLqkwR4wqpUBboDzocVR4Q1M",
];

const ARTIFACT_KEY_ID_PATTERN = /^[a-f0-9]{16}$/u;

const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const USAGE = [
  "Usage:",
  "  node install-machine-windows.mjs --bootstrap-env <NAME> [--host-daemon-port <port>]",
  "  node install-machine-windows.mjs --start --host-id <id> [--data-dir <path>]",
  "  node install-machine-windows.mjs --stop --host-id <id> [--data-dir <path>]",
  "  node install-machine-windows.mjs --uninstall --host-id <id> [--data-dir <path>]",
  "  node install-machine-windows.mjs --repair-runtime --host-id <id> [--data-dir <path>]",
].join("\n");

class InstallError extends Error {
  constructor(message, details = []) {
    super(message);
    this.details = details;
  }
}

function step(text) {
  process.stdout.write(`  > ${text}\n`);
}

function done(text) {
  process.stdout.write(`  ok ${text}\n`);
}

function warn(text) {
  process.stdout.write(`  !  ${text}\n`);
}

function detail(text) {
  process.stdout.write(`     ${text}\n`);
}

export function parseArguments(argv) {
  const options = {
    action: null,
    bootstrapEnv: null,
    dataDir: null,
    hostDaemonPort: null,
    hostId: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    const value = () => {
      const next = argv[index + 1];

      if (next === undefined || next.startsWith("--")) {
        throw new InstallError(USAGE);
      }

      index += 1;

      return next;
    };

    if (argument === "--bootstrap-env") options.bootstrapEnv = value();
    else if (argument === "--host-daemon-port")
      options.hostDaemonPort = value();
    else if (argument === "--host-id") options.hostId = value();
    else if (argument === "--data-dir") options.dataDir = value();
    else if (
      argument === "--start" ||
      argument === "--run" ||
      argument === "--stop" ||
      argument === "--uninstall" ||
      argument === "--repair-runtime"
    ) {
      if (options.action !== null) throw new InstallError(USAGE);
      options.action = argument.slice(2);
    } else throw new InstallError(USAGE);
  }

  if (options.action === null) {
    if (
      options.bootstrapEnv === null ||
      options.hostId !== null ||
      options.dataDir !== null
    ) {
      throw new InstallError(USAGE);
    }
  } else if (
    options.hostId === null ||
    options.bootstrapEnv !== null ||
    options.hostDaemonPort !== null
  ) {
    throw new InstallError(USAGE);
  }

  return options;
}

export function parseBootstrap(raw) {
  let bundle;

  try {
    bundle = JSON.parse(raw);
  } catch {
    throw new InstallError("The enrollment bundle is not valid JSON.");
  }

  if (
    bundle === null ||
    typeof bundle !== "object" ||
    typeof bundle.hostId !== "string" ||
    bundle.hostId.length === 0 ||
    typeof bundle.serverUrl !== "string"
  ) {
    throw new InstallError("The enrollment bundle is incomplete.");
  }

  let url;

  try {
    url = new URL(bundle.serverUrl);
  } catch {
    throw new InstallError("The enrollment bundle has an invalid server URL.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new InstallError("The enrollment bundle has an invalid server URL.");
  }

  const headers = {};

  if (bundle.headers !== null && typeof bundle.headers === "object") {
    for (const [name, value] of Object.entries(bundle.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
  }

  return {
    dataDir: typeof bundle.dataDir === "string" ? bundle.dataDir : null,
    headers,
    hostId: bundle.hostId,
    reconnect: bundle.reconnect === true,
    serverUrl: url.href.replace(/\/$/u, ""),
  };
}

export function serverHostSlug(serverUrl) {
  return new URL(serverUrl).host.replace(/[^a-zA-Z0-9.-]/gu, "-");
}

export function serviceName(serverUrl, hostId) {
  const hostSlug = hostId.replace(/[^a-zA-Z0-9_.-]/gu, "-");

  return `omnyo-host-daemon-${`${serverHostSlug(serverUrl)}-${hostSlug}`.replaceAll(".", "-")}`;
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function startupCommand({ dataDir, hostId, nodePath }) {
  const command = [
    "&",
    quotePowerShell(nodePath),
    quotePowerShell(join(dataDir, INSTALLER_FILE_NAME)),
    "--start",
    "--host-id",
    quotePowerShell(hostId),
    "--data-dir",
    quotePowerShell(dataDir),
  ].join(" ");

  return `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${command.replaceAll('"', '\\"')}"`;
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeFileAtomic(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function installedHostId(dataDir) {
  const readIdentity = (name) => {
    try {
      return readFileSync(join(dataDir, name), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw new InstallError("The existing machine identity cannot be read.");
    }
  };

  const recordedText = readIdentity("host-id");
  const recorded = recordedText?.trim() ?? "";
  const authText = readIdentity("auth.json");
  let authenticated = "";

  if (authText !== null) {
    try {
      const value = JSON.parse(authText);

      if (
        value === null ||
        typeof value !== "object" ||
        typeof value.hostId !== "string" ||
        !/^[a-zA-Z0-9_-]+$/u.test(value.hostId)
      )
        throw new Error("Invalid identity");
      authenticated = value.hostId;
    } catch {
      throw new InstallError(
        "The existing machine authentication identity is invalid.",
      );
    }
  }

  if (
    (recordedText !== null && !/^[a-zA-Z0-9_-]+$/u.test(recorded)) ||
    (recorded !== "" && authenticated !== "" && recorded !== authenticated)
  )
    throw new InstallError("The existing machine identity records disagree.");

  return recorded || authenticated;
}

function normalizeServerUrl(value) {
  const url = new URL(String(value));

  if (url.hostname === "localhost") url.hostname = "127.0.0.1";

  return url.href.replace(/\/$/u, "");
}

async function daemonStatusMatches({
  hostId,
  port,
  requireConnected,
  serverUrl,
}) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(750),
    });

    if (!response.ok) return false;
    const status = await response.json();

    return (
      status !== null &&
      typeof status === "object" &&
      status.hostId === hostId &&
      normalizeServerUrl(status.serverUrl) === normalizeServerUrl(serverUrl) &&
      (!requireConnected || status.connected === true)
    );
  } catch {
    return false;
  }
}

function portIsAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen({ exclusive: true, host: "127.0.0.1", port }, () => {
      server.close((error) => resolve(error === undefined));
    });
  });
}

function validPort(raw) {
  const port = Number(raw);

  return String(port) === raw &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535
    ? port
    : null;
}

async function chooseHostDaemonPort({ dataDir, hostId, requested, serverUrl }) {
  const portFile = join(dataDir, "host-daemon-port");

  const matches = (port) =>
    daemonStatusMatches({ hostId, port, requireConnected: false, serverUrl });

  let chosen = null;

  if (requested !== null) {
    const port = validPort(requested);

    if (port === null) {
      throw new InstallError(
        "--host-daemon-port must be an integer between 1 and 65535.",
      );
    }

    if (!(await portIsAvailable(port)) && !(await matches(port))) {
      throw new InstallError(
        `Host daemon local API port ${port} is already in use.`,
        [
          "Choose another value for --host-daemon-port and run this command again.",
        ],
      );
    }

    chosen = port;
  } else {
    const stored = validPort(readText(portFile).split(/\r?\n/u)[0] ?? "");

    if (stored !== null) {
      if ((await portIsAvailable(stored)) || (await matches(stored))) {
        chosen = stored;
      } else {
        warn(
          `Stored host-daemon port ${stored} is unavailable; assigning a new port.`,
        );
      }
    }
  }

  for (
    let port = FIRST_HOST_DAEMON_PORT;
    chosen === null && port <= 65535;
    port += 1
  ) {
    if (await portIsAvailable(port)) chosen = port;
  }

  if (chosen === null) {
    throw new InstallError("Could not find an available host-daemon port.");
  }

  writeFileAtomic(portFile, `${chosen}\n`);
  done(`Using local host-daemon port ${chosen}`);

  return chosen;
}

function npmLaunch(args) {
  const npmCli = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );

  if (existsSync(npmCli)) {
    return {
      args: [npmCli, ...args],
      command: process.execPath,
      verbatim: false,
    };
  }

  const commandLine = ["npm", ...args].map((part) => `"${part}"`).join(" ");

  return {
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    command: process.env.ComSpec ?? "cmd.exe",
    verbatim: true,
  };
}

function runInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function installPackage({ dataDir, npmPrefix, source }) {
  const launch = npmLaunch([
    "install",
    "-g",
    `--allow-scripts=${NATIVE_MODULES}`,
    "--prefix",
    npmPrefix,
    source,
  ]);

  rmSync(join(dataDir, "host-artifact.sha256"), { force: true });

  const code = await runInherited(launch.command, launch.args, {
    windowsVerbatimArguments: launch.verbatim,
  });

  if (code !== 0) {
    throw new InstallError(
      "Could not install omnyo-app for this machine. Check the npm error above, then run this command again.",
    );
  }
}

export function packageRoot(npmPrefix) {
  return join(npmPrefix, "node_modules", "omnyo-app");
}

async function preparePackage({ bootstrap, dataDir, npmPrefix }) {
  const root = packageRoot(npmPrefix);
  const digestFile = join(dataDir, "host-artifact.sha256");

  const installedDigest =
    existsSync(join(root, "dist", "omnyo-app.js")) &&
    existsSync(join(root, "host-daemon", "dist", "daemon-bundle.mjs"))
      ? readText(digestFile).trim()
      : "";

  const knownDigest = /^[a-f0-9]{64}$/u.test(installedDigest)
    ? installedDigest
    : "";

  const packageUrl = `${bootstrap.serverUrl}/install/omnyo-app.tgz`;
  step("Downloading the server's omnyo-app package (timeout: 5 minutes)");
  let response;

  try {
    response = await fetch(packageUrl, {
      redirect: "error",
      headers: {
        ...bootstrap.headers,
        ...(knownDigest === ""
          ? {}
          : { "if-none-match": `"sha256-${knownDigest}"` }),
      },
      signal: AbortSignal.timeout(PACKAGE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new InstallError(
      `Could not download the server's omnyo-app package from ${packageUrl}.`,
      [error instanceof Error ? error.message : String(error)],
    );
  }

  if (response.status === 304 && knownDigest !== "") {
    done("The identical server host artifact is already installed");

    return {
      packageFile: null,
      packageDir: null,
      helperPath: join(root, "dist", "state-admission.mjs"),
      expectedDigest: knownDigest,
    };
  }

  if (response.status === 404) {
    throw new InstallError(
      "The private server does not provide its Omnyo runtime artifact.",
    );
  }

  if (!response.ok) {
    const details = [];

    try {
      const body = await response.json();

      if (body !== null && typeof body.message === "string") {
        details.push(
          `Server: ${body.message.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ").slice(0, 2000)}`,
        );
      }
    } catch {}

    throw new InstallError(
      `Could not download the server's omnyo-app package from ${packageUrl} (HTTP ${response.status}).`,
      details,
    );
  }

  const tarball = Buffer.from(await response.arrayBuffer());
  const expectedDigest = response.headers.get("x-omnyo-artifact-sha256") ?? "";
  const downloadedDigest = createHash("sha256").update(tarball).digest("hex");

  if (
    !/^[a-f0-9]{64}$/u.test(expectedDigest) ||
    expectedDigest !== downloadedDigest
  ) {
    throw new InstallError(
      "The downloaded Omnyo host artifact failed SHA-256 verification.",
      [`Expected ${expectedDigest} but received ${downloadedDigest}.`],
    );
  }

  done("Downloaded the server's omnyo-app package");
  const packageDir = mkdtempSync(join(tmpdir(), "omnyo-app-"));
  const packageFile = join(packageDir, "omnyo-app.tgz");

  try {
    writeFileSync(packageFile, tarball);

    const helper = await execFileAsync(
      "tar.exe",
      ["-xOf", packageFile, "package/dist/state-admission.mjs"],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );

    if (helper.stdout.length === 0)
      throw new InstallError(
        "The verified runtime archive has no installation admission owner.",
      );
    const helperPath = join(packageDir, "state-admission.mjs");
    writeFileSync(helperPath, helper.stdout, { mode: 0o600 });

    return { packageFile, packageDir, helperPath, expectedDigest };
  } catch (error) {
    rmSync(packageDir, { force: true, recursive: true });
    throw error;
  }
}

async function verifyNativeModules(root) {
  try {
    await execFileAsync(process.execPath, [
      "-e",
      'const root = process.argv[1]; require(root + "/node_modules/node-pty"); require(root + "/node_modules/@parcel/watcher");',
      root,
    ]);
  } catch {
    throw new InstallError(
      "npm installed omnyo-app, but its host native add-ons (node-pty, @parcel/watcher) did not load.",
      [
        "npm did not run their install scripts. Check the npm warnings above. If they mention allowScripts or ignore-scripts, set npm_config_allow_scripts and run this command again.",
        `npm_config_allow_scripts=${NATIVE_MODULES}`,
      ],
    );
  }
}

function withoutLegacyInstallerEnvironmentV1() {
  const environment = { ...process.env };
  delete environment.BB_APP_NPM_PREFIX;
  delete environment.BB_DATA_DIR;

  return environment;
}

function daemonEnvironment({ dataDir, npmPrefix }) {
  return {
    ...withoutLegacyInstallerEnvironmentV1(),
    OMNYO_APP_NPM_PREFIX: npmPrefix,
    OMNYO_DATA_DIR: dataDir,
    OMNYO_WINDOWS_SERVICE_INSTALL: "1",
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value)}\n`);
}

function escapeRegExp(value) {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function installerTreeSurvivors(
  processes,
  { rootPid, startedAt, markers },
) {
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const verdicts = new Map();

  const attributable = (entry) => {
    const known = verdicts.get(entry.pid);

    if (known !== undefined) return known;
    verdicts.set(entry.pid, false);
    let verdict = false;

    if (entry.created >= startedAt) {
      if (entry.pid === rootPid) verdict = true;
      else {
        const parent = byPid.get(entry.ppid);

        verdict =
          parent === undefined ||
          parent.pid === entry.pid ||
          parent.created > entry.created ||
          attributable(parent);
      }
    }

    verdicts.set(entry.pid, verdict);

    return verdict;
  };

  return processes.filter(
    (entry) =>
      attributable(entry) ||
      markers.some((marker) => marker.test(entry.commandLine)),
  );
}

const PROCESS_SNAPSHOT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$list = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; created = $(if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }); name = [string]$_.Name; executablePath = [string]$_.ExecutablePath; commandLine = [string]$_.CommandLine } })",
  "ConvertTo-Json -Compress -Depth 3 -InputObject $list",
].join("; ");

async function processSnapshot() {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", PROCESS_SNAPSHOT_SCRIPT],
    { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, windowsHide: true },
  );

  const parsed = JSON.parse(stdout);

  if (!Array.isArray(parsed))
    throw new InstallError("Windows returned an invalid process list.");

  return parsed.map((entry) => ({
    pid: Number(entry.pid),
    ppid: Number(entry.ppid),
    created: Number(entry.created),
    name: String(entry.name ?? ""),
    executablePath: String(entry.executablePath ?? ""),
    commandLine: String(entry.commandLine ?? ""),
  }));
}

const LOADED_MODULE_SCRIPT = [
  "$ErrorActionPreference='Continue'",
  "$root = $env:OMNYO_PACKAGE_PREFIX",
  'Get-Process | ForEach-Object { $owner = $_; try { foreach ($module in $owner.Modules) { if ($module.FileName -and $module.FileName.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { [Console]::Out.WriteLine("$($owner.Id)`t$($module.FileName)") } } } catch {} }',
].join("; ");

async function packageUsers(npmPrefix) {
  const prefix = npmPrefix.toLowerCase();
  const processes = await processSnapshot();

  const running = processes
    .filter(
      (entry) =>
        entry.pid !== process.pid &&
        (entry.executablePath.toLowerCase().startsWith(prefix) ||
          entry.commandLine.toLowerCase().includes(prefix)),
    )
    .map((entry) => `${entry.pid} ${entry.name}`);

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", LOADED_MODULE_SCRIPT],
    {
      env: {
        ...withoutLegacyInstallerEnvironmentV1(),
        OMNYO_PACKAGE_PREFIX: npmPrefix,
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  );

  const mapped = stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return [...running, ...mapped];
}

async function waitForPackageRelease(npmPrefix) {
  const deadline = Date.now() + PACKAGE_RELEASE_TIMEOUT_MS;

  for (;;) {
    const users = await packageUsers(npmPrefix);

    if (users.length === 0) return;

    if (Date.now() >= deadline)
      throw new InstallError(
        "Processes still use the installed Omnyo runtime, so it cannot be replaced safely.",
        users.slice(0, 20),
      );
    await delay(1_000);
  }
}

async function installRuntimeArchive({ dataDir, npmPrefix, tarball, journal }) {
  const launch = npmLaunch([
    "install",
    "-g",
    `--allow-scripts=${NATIVE_MODULES}`,
    "--prefix",
    npmPrefix,
    tarball,
  ]);

  journal({
    treeTermination: "unverified",
    processGroupId: null,
    processPlatform: "win32",
  });
  const startedAt = Date.now() - 1_000;
  const log = openSync(join(dataDir, "logs", "machine-service.log"), "a");
  let child;

  try {
    child = spawn(launch.command, launch.args, {
      cwd: dataDir,
      env: {
        ...withoutLegacyInstallerEnvironmentV1(),
        PATH: `${dirname(process.execPath)};${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", log, log],
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
    });
  } finally {
    closeSync(log);
  }

  if (child.pid !== undefined)
    journal({
      treeTermination: "unverified",
      processGroupId: child.pid,
      processPlatform: "win32",
    });

  const exited = waitForChildExit(child);
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;

    if (child.pid !== undefined) void stopProcessTree(child.pid);
  }, INSTALLER_TIMEOUT_MS);

  let code;

  try {
    code = await exited;
  } finally {
    clearTimeout(timer);
  }

  const survivors = installerTreeSurvivors(await processSnapshot(), {
    rootPid: child.pid ?? -1,
    startedAt,
    markers: [new RegExp(escapeRegExp(tarball), "iu")],
  });

  if (survivors.length === 0) journal(null);

  return {
    code: timedOut ? null : code,
    rootPid: child.pid ?? null,
    startedAt,
    survivors: survivors.map((entry) => ({
      pid: entry.pid,
      ppid: entry.ppid,
      name: entry.name,
      created: entry.created,
    })),
  };
}

function readAttempt(dataDir) {
  const path = join(dataDir, ATTEMPT_FILE_NAME);

  if (!existsSync(path)) return null;

  return readJsonFile(path);
}

function attemptJournal(dataDir, base) {
  return (installer) => {
    const next = { ...base };
    delete next.installer;

    if (installer !== null) next.installer = installer;
    writeJsonAtomic(join(dataDir, ATTEMPT_FILE_NAME), next);
  };
}

async function verifyInstalledPackage(root, expectedVersion) {
  for (const file of [
    join(root, "dist", "omnyo-app.js"),
    join(root, "host-daemon", "dist", "daemon-bundle.mjs"),
  ])
    if (!existsSync(file))
      throw new InstallError(`The installed Omnyo runtime is missing ${file}.`);

  const manifest = readJsonFile(join(root, "package.json"));

  if (manifest.version !== expectedVersion)
    throw new InstallError(
      `npm installed Omnyo ${manifest.version}, not ${expectedVersion}.`,
    );

  await verifyNativeModules(root);
}

function clearPendingInstall(dataDir) {
  for (const name of [PENDING_INSTALL_FILE_NAME, PENDING_INSTALL_TARBALL_NAME])
    rmSync(join(dataDir, name), { force: true });
}

async function installPendingRuntime(dataDir, service) {
  const recordPath = join(dataDir, PENDING_INSTALL_FILE_NAME);

  if (!existsSync(recordPath)) return;

  let record;

  try {
    record = readJsonFile(recordPath);
  } catch {
    warn("Discarded an unreadable pending Omnyo update");
    clearPendingInstall(dataDir);

    return;
  }

  const tarball = join(dataDir, PENDING_INSTALL_TARBALL_NAME);

  if (
    record?.schema !== 1 ||
    record.tarball !== PENDING_INSTALL_TARBALL_NAME ||
    typeof record.version !== "string" ||
    !ARTIFACT_DIGEST_PATTERN.test(String(record.artifactDigest)) ||
    !existsSync(tarball) ||
    sha256(readFileSync(tarball)) !== record.artifactDigest
  ) {
    warn("Discarded a pending Omnyo update that failed verification");
    clearPendingInstall(dataDir);

    return;
  }

  const attempt = readAttempt(dataDir);

  if (attempt?.installer !== undefined) {
    warn(
      "A previous Omnyo installer is unverified; run --repair-runtime before installing updates",
    );
    clearPendingInstall(dataDir);

    return;
  }

  const base =
    attempt !== null &&
    attempt.version === record.version &&
    attempt.artifactDigest === record.artifactDigest
      ? attempt
      : {
          attemptedAt: record.requestedAt,
          attemptCount: 1,
          protocolVersion: record.protocolVersion,
          version: record.version,
          artifactDigest: record.artifactDigest,
        };

  try {
    step(`Installing Omnyo ${record.version} while the runtime is stopped`);
    await waitForPackageRelease(service.npmPrefix);
    rmSync(join(dataDir, INSTALLED_DIGEST_FILE_NAME), { force: true });

    const result = await installRuntimeArchive({
      dataDir,
      npmPrefix: service.npmPrefix,
      tarball,
      journal: attemptJournal(dataDir, base),
    });

    if (result.survivors.length > 0) {
      warn(
        `The Omnyo installer left ${result.survivors.length} process(es); worker admission stays held until --repair-runtime verifies them`,
      );

      return;
    }

    if (result.code !== 0) {
      warn(
        `npm could not install Omnyo ${record.version}; see machine-service.log`,
      );

      return;
    }

    await verifyInstalledPackage(
      packageRoot(service.npmPrefix),
      record.version,
    );
    writeFileAtomic(
      join(dataDir, INSTALLED_DIGEST_FILE_NAME),
      `${record.artifactDigest}\n`,
    );
    done(`Installed Omnyo ${record.version}`);
  } catch (error) {
    warn(
      `Could not install the pending Omnyo update: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearPendingInstall(dataDir);
  }
}

function spawnDaemon({
  args,
  dataDir,
  logFile,
  npmPrefix,
  root,
  detached = true,
}) {
  const log = openSync(logFile, "a");

  try {
    const child = spawn(
      process.execPath,
      [join(root, "dist", "omnyo-app.js"), "host-daemon", ...args],
      {
        cwd: dataDir,
        detached,
        env: daemonEnvironment({ dataDir, npmPrefix }),
        stdio: ["ignore", log, log],
        windowsHide: true,
      },
    );

    if (detached) child.unref();

    return child;
  } finally {
    closeSync(log);
  }
}

async function stopProcessTree(pid) {
  await execFileAsync("taskkill", ["/pid", String(pid), "/T", "/F"], {
    windowsHide: true,
  }).catch(() => undefined);
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function processCommandLine(pid) {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
      ],
      { windowsHide: true },
    );

    return stdout.trim();
  } catch {
    return "";
  }
}

async function waitForConnection({ hostId, port, serverUrl, subject }) {
  step(`Waiting for ${subject} to connect (up to about 2 minutes)`);

  for (let attempt = 1; attempt <= DAEMON_WAIT_ATTEMPTS; attempt += 1) {
    if (
      await daemonStatusMatches({
        hostId,
        port,
        requireConnected: true,
        serverUrl,
      })
    ) {
      return true;
    }

    if (attempt % WAIT_PROGRESS_EVERY_ATTEMPTS === 0) {
      step(
        `Still waiting for ${subject} (${attempt}/${DAEMON_WAIT_ATTEMPTS} checks)`,
      );
    }

    await delay(1_000);
  }

  return false;
}

function authMatchesHost(dataDir, hostId) {
  try {
    return JSON.parse(readText(join(dataDir, "auth.json"))).hostId === hostId;
  } catch {
    return false;
  }
}

function alreadyJoined({ dataDir, hostId, serverUrl }) {
  if (!existsSync(join(dataDir, "auth.json"))) return false;

  if (!authMatchesHost(dataDir, hostId)) {
    throw new InstallError(
      `${dataDir} already holds credentials for a different host, not ${hostId}.`,
      [
        `If this machine was removed from the server, delete ${dataDir} and run this command again.`,
      ],
    );
  }

  try {
    const config = JSON.parse(readText(join(dataDir, "config.json")));
    const normalize = (value) => String(value).replace(/\/+$/u, "");

    return normalize(config.serverUrl) === normalize(serverUrl);
  } catch {
    return false;
  }
}

async function joinServer({ bootstrap, dataDir, npmPrefix, port, root }) {
  if (
    alreadyJoined({
      dataDir,
      hostId: bootstrap.hostId,
      serverUrl: bootstrap.serverUrl,
    })
  ) {
    done(
      `This machine is already joined to ${bootstrap.serverUrl} as ${bootstrap.hostId}`,
    );

    return;
  }

  const joinLog = join(dataDir, "install-join.log");
  step(`Joining ${bootstrap.serverUrl} as ${bootstrap.hostId}`);
  detail(`Join progress is logged to ${joinLog}`);

  const child = spawnDaemon({
    args: [
      "join",
      "--auto-update",
      "--host-daemon-port",
      String(port),
      "--host-id",
      bootstrap.hostId,
      "--server-url",
      bootstrap.serverUrl,
    ],
    dataDir,
    logFile: joinLog,
    npmPrefix,
    root,
  });

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  step(
    "Waiting for the temporary host daemon to connect (up to about 2 minutes)",
  );
  let joined = false;

  for (let attempt = 1; attempt <= DAEMON_WAIT_ATTEMPTS; attempt += 1) {
    if (
      authMatchesHost(dataDir, bootstrap.hostId) &&
      (await daemonStatusMatches({
        hostId: bootstrap.hostId,
        port,
        requireConnected: true,
        serverUrl: bootstrap.serverUrl,
      }))
    ) {
      joined = true;
      break;
    }

    if (exited) {
      throw new InstallError(
        `Omnyo host daemon exited before it connected to ${bootstrap.serverUrl}.`,
        [`See ${joinLog}`],
      );
    }

    await delay(1_000);
  }

  if (child.pid !== undefined) await stopProcessTree(child.pid);

  if (!joined) {
    throw new InstallError(
      `Timed out waiting for host daemon ${bootstrap.hostId} to connect to ${bootstrap.serverUrl}.`,
      [`See ${joinLog}`],
    );
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (
      !(await daemonStatusMatches({
        hostId: bootstrap.hostId,
        port,
        requireConnected: false,
        serverUrl: bootstrap.serverUrl,
      }))
    ) {
      break;
    }

    await delay(500);
  }

  done("Joined successfully");
}

function readService(dataDir) {
  let text;

  try {
    text = readFileSync(join(dataDir, SERVICE_FILE_NAME), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw new InstallError(
      "The existing machine service owner cannot be read.",
    );
  }

  try {
    const service = JSON.parse(text);

    if (
      service !== null &&
      typeof service === "object" &&
      typeof service.hostId === "string" &&
      typeof service.serverUrl === "string" &&
      typeof service.npmPrefix === "string" &&
      Number.isInteger(service.hostDaemonPort) &&
      service.hostDaemonPort > 0 &&
      service.hostDaemonPort <= 65535 &&
      isAbsolute(service.npmPrefix)
    ) {
      return service;
    }
  } catch {}

  throw new InstallError("The existing machine service owner is invalid.");
}

function waitForChildExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

async function runLauncherOnce(dataDir, service) {
  const pid = Number(readText(join(dataDir, PID_FILE_NAME)).trim());

  if (Number.isInteger(pid) && pid > 1 && processIsRunning(pid)) {
    const commandLine = await processCommandLine(pid);
    const entry = join(packageRoot(service.npmPrefix), "dist", "omnyo-app.js");

    if (
      !commandLine
        .replaceAll("/", "\\")
        .toLowerCase()
        .includes(entry.toLowerCase()) ||
      !commandLine.includes("host-daemon") ||
      !new RegExp(
        String.raw`(?:^|\s)(?:"--host-daemon-port"|--host-daemon-port)\s+(?:"${service.hostDaemonPort}"|${service.hostDaemonPort})(?=\s|$)`,
        "u",
      ).test(commandLine)
    ) {
      throw new InstallError(
        "The recorded launcher does not belong to this machine service.",
      );
    }

    step("Supervising the existing machine launcher without restarting it");

    const watcher = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); $null=$p.Handle; $p.WaitForExit(); exit $p.ExitCode } catch { [Console]::Error.WriteLine('Could not monitor the existing Omnyo launcher'); exit 1 }`,
      ],
      { stdio: ["ignore", "ignore", "inherit"], windowsHide: true },
    );

    return waitForChildExit(watcher);
  }

  await installPendingRuntime(dataDir, service);

  if (!(await portIsAvailable(service.hostDaemonPort))) {
    throw new InstallError(
      "The machine port is occupied without a verified launcher owner.",
    );
  }

  const child = spawnDaemon({
    args: [
      "--auto-update",
      "--supervise",
      "--host-daemon-port",
      String(service.hostDaemonPort),
      "--server-url",
      service.serverUrl,
    ],
    dataDir,
    logFile: join(dataDir, "logs", "machine-service.log"),
    npmPrefix: service.npmPrefix,
    root: packageRoot(service.npmPrefix),
    detached: false,
  });

  const exit = waitForChildExit(child);

  if (child.pid !== undefined)
    writeFileAtomic(join(dataDir, PID_FILE_NAME), `${child.pid}\n`);

  return exit;
}

async function runDaemon(dataDir, service) {
  mkdirSync(join(dataDir, "logs"), { recursive: true });

  for (;;) {
    const code = await runLauncherOnce(dataDir, service);

    if (code !== SERVICE_INSTALL_EXIT_CODE) {
      process.exitCode = code;

      return;
    }

    await installPendingRuntime(dataDir, service);
  }
}

async function readManagementStatus(dataDir, service) {
  let hostKey;

  try {
    const auth = readJsonFile(join(dataDir, "auth.json"));

    if (auth?.hostId !== service.hostId || typeof auth.hostKey !== "string")
      throw new Error("mismatch");
    hostKey = auth.hostKey;
  } catch {
    throw new InstallError("This machine's credentials cannot be read.");
  }

  try {
    const response = await fetch(
      `http://127.0.0.1:${service.hostDaemonPort}/management/v1/status`,
      {
        headers: { authorization: `Bearer ${hostKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );

    if (!response.ok) {
      await response.body?.cancel();

      return null;
    }

    return await response.json();
  } catch {
    return null;
  }
}

function statusSummary(status) {
  return status === null
    ? null
    : {
        instanceId: status.instanceId ?? null,
        runtimeVersion: status.runtimeVersion ?? null,
        protocolVersion: status.protocolVersion ?? null,
        connected: status.connected ?? null,
        admission: status.admission ?? null,
        update: status.update ?? null,
      };
}

export function readMachineHeaders(dataDir) {
  let config;

  try {
    config = readJsonFile(join(dataDir, "config.json"));
  } catch {
    throw new InstallError("This machine's server settings cannot be read.");
  }

  const headers =
    config?.serverHeaders ??
    (typeof config?.machineCredential === "string"
      ? { "x-omnyo-connect-machine": config.machineCredential }
      : {});

  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    !Object.values(headers).every((value) => typeof value === "string")
  )
    throw new InstallError("This machine's server headers are invalid.");

  return headers;
}

function readOpenSshString(blob, offset) {
  if (offset + 4 > blob.length) throw new Error("Malformed public key");
  const end = offset + 4 + blob.readUInt32BE(offset);

  if (end > blob.length) throw new Error("Malformed public key");

  return { value: blob.subarray(offset + 4, end), next: end };
}

function rawArtifactPublicKey(publicKey) {
  const [type, encoded] = publicKey.trim().split(/\s+/u);

  if (type !== "ssh-ed25519" || encoded === undefined)
    throw new Error("Unsupported public key");

  if (!BASE64_PATTERN.test(encoded)) throw new Error("Malformed public key");
  const blob = Buffer.from(encoded, "base64");
  const blobType = readOpenSshString(blob, 0);
  const blobKey = readOpenSshString(blob, blobType.next);

  if (
    blobType.value.toString("utf8") !== "ssh-ed25519" ||
    blobKey.value.length !== 32 ||
    blobKey.next !== blob.length
  )
    throw new Error("Malformed public key");

  return Buffer.from(blobKey.value);
}

export function verifyServerArtifactSignature(
  target,
  keys = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
) {
  try {
    const { version, protocolVersion, artifactDigest } = target;
    const signature = target.artifactSignature;
    const keyId = target.artifactSignatureKeyId;

    if (
      typeof version !== "string" ||
      version.length === 0 ||
      /[\r\n]/u.test(version) ||
      !Number.isSafeInteger(protocolVersion) ||
      protocolVersion <= 0 ||
      !ARTIFACT_DIGEST_PATTERN.test(String(artifactDigest)) ||
      typeof keyId !== "string" ||
      !ARTIFACT_KEY_ID_PATTERN.test(keyId) ||
      typeof signature !== "string" ||
      !BASE64_PATTERN.test(signature)
    )
      return false;
    const signatureBytes = Buffer.from(signature, "base64");

    if (signatureBytes.length !== 64) return false;

    const message = Buffer.from(
      `${ARTIFACT_SIGNATURE_MESSAGE_PREFIX}\n${version}\n${protocolVersion}\n${artifactDigest}\n`,
      "utf8",
    );

    return keys.some((key) => {
      let raw;

      try {
        raw = rawArtifactPublicKey(key);
      } catch {
        return false;
      }

      if (sha256(raw).slice(0, 16) !== keyId) return false;

      return verify(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
          format: "der",
          type: "spki",
        }),
        signatureBytes,
      );
    });
  } catch {
    return false;
  }
}

function accessRefused() {
  return new InstallError(
    "The server refused this machine's access to its runtime (HTTP 403).",
  );
}

export async function downloadServerArtifact(
  serverUrl,
  headers,
  signingKeys = HOST_ARTIFACT_SIGNING_PUBLIC_KEYS,
) {
  let target;

  try {
    const response = await fetch(`${serverUrl}/install/version`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 403) {
      await response.body?.cancel();
      throw accessRefused();
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    target = await response.json();
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError("Could not read the server's runtime version.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (
    typeof target?.version !== "string" ||
    !Number.isInteger(target.protocolVersion) ||
    !ARTIFACT_DIGEST_PATTERN.test(String(target.artifactDigest))
  )
    throw new InstallError("The server's runtime version is invalid.");

  if (!verifyServerArtifactSignature(target, signingKeys))
    throw new InstallError(
      "The server's runtime is not signed by the Omnyo release key.",
    );

  step(`Downloading the server's Omnyo ${target.version} runtime`);
  let response;

  try {
    response = await fetch(`${serverUrl}/install/omnyo-app.tgz`, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(PACKAGE_DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new InstallError("Could not download the server's runtime.", [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  if (response.status === 403) {
    await response.body?.cancel();
    throw accessRefused();
  }

  if (!response.ok) {
    await response.body?.cancel();
    throw new InstallError(
      `Could not download the server's runtime (HTTP ${response.status}).`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha256(bytes);

  if (
    response.headers.get("x-omnyo-artifact-sha256") !== digest ||
    digest !== target.artifactDigest
  )
    throw new InstallError(
      "The downloaded runtime does not match the server's verified artifact.",
    );

  const directory = mkdtempSync(join(tmpdir(), "omnyo-repair-"));

  try {
    const tarball = join(directory, "omnyo-app.tgz");
    writeFileSync(tarball, bytes);
    const extracted = join(directory, "extracted");
    mkdirSync(extracted);
    await execFileAsync("tar.exe", ["-xzf", tarball, "-C", extracted], {
      timeout: 120_000,
      windowsHide: true,
    });
    const packageDir = join(extracted, "package");
    const helperPath = join(packageDir, "dist", "state-admission.mjs");

    if (!existsSync(helperPath))
      throw new InstallError(
        "The verified runtime archive has no installation admission owner.",
      );

    if (
      readJsonFile(join(packageDir, "package.json")).version !== target.version
    )
      throw new InstallError(
        "The verified runtime archive does not carry the server's version.",
      );

    done(`Downloaded and verified Omnyo ${target.version}`);

    return {
      directory,
      tarball,
      packageDir,
      helperPath,
      version: target.version,
      protocolVersion: target.protocolVersion,
      artifactDigest: digest,
    };
  } catch (error) {
    rmSync(directory, { force: true, recursive: true });
    throw error;
  }
}

function listFiles(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const relative = prefix === "" ? entry.name : join(prefix, entry.name);

      return entry.isDirectory() ? listFiles(root, relative) : [relative];
    },
  );
}

function compareInstalledPackage(packageDir, installedRoot) {
  const files = listFiles(packageDir);

  const mismatched = files.filter((relative) => {
    const installed = join(installedRoot, relative);

    return (
      !existsSync(installed) ||
      sha256(readFileSync(installed)) !==
        sha256(readFileSync(join(packageDir, relative)))
    );
  });

  return { files: files.length, mismatched };
}

function preserveRetiredNpmEntries(npmPrefix, destination) {
  const moved = [];

  for (const [directory, label] of [
    [npmPrefix, "prefix"],
    [join(npmPrefix, "node_modules"), "node_modules"],
  ]) {
    if (!existsSync(directory)) continue;

    for (const name of readdirSync(directory)) {
      if (!NPM_RETIRED_ENTRY_PATTERN.test(name)) continue;
      const target = join(destination, label, name);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(join(directory, name), target);
      moved.push(join(label, name));
    }
  }

  return moved;
}

export function repairedWorkerAdmitsCommands(status, version) {
  return (
    status !== null &&
    status.runtimeVersion === version &&
    status.connected === true &&
    status.admission?.held === false &&
    status.admission.directProbe === false &&
    status.admission.activation === false &&
    status.update?.reason !== "installer_unverified"
  );
}

async function repairRuntime(dataDir, service) {
  const attemptPath = join(dataDir, ATTEMPT_FILE_NAME);

  const attemptBytes = existsSync(attemptPath)
    ? readFileSync(attemptPath)
    : null;

  let attempt = null;

  try {
    attempt = attemptBytes === null ? null : JSON.parse(attemptBytes);
  } catch {
    throw new InstallError("The update attempt journal is unreadable.");
  }

  if (
    attempt?.installer?.treeTermination !== "unverified" ||
    attempt.installer.processPlatform !== "win32" ||
    !Number.isFinite(attempt.attemptedAt)
  )
    throw new InstallError(
      "This machine has no unverified Windows installer to repair.",
    );

  const attemptSha = sha256(attemptBytes);

  step("Checking that the worker is idle");
  const status = await readManagementStatus(dataDir, service);

  if (status === null) {
    if (
      await daemonStatusMatches({
        hostId: service.hostId,
        port: service.hostDaemonPort,
        requireConnected: false,
        serverUrl: service.serverUrl,
      })
    )
      throw new InstallError(
        "The worker is running but did not report its admission status.",
      );
  } else {
    const activity = status.admission?.activity;

    if (status.hostId !== service.hostId)
      throw new InstallError("The running worker belongs to another host.");

    if (
      activity === null ||
      typeof activity !== "object" ||
      Object.values(activity).some((count) => count !== 0)
    )
      throw new InstallError(
        "The worker is still running work; repair it once it is idle.",
        [JSON.stringify(activity)],
      );

    if (status.update?.reason !== "installer_unverified")
      throw new InstallError(
        "The running worker does not report an unverified installer.",
      );
  }

  done("The worker is idle");

  step("Checking that the recorded installer left no processes");
  const startedAt = attempt.attemptedAt - 1_000;
  const before = await processSnapshot();

  const leftovers = installerTreeSurvivors(before, {
    rootPid: attempt.installer.processGroupId ?? -1,
    startedAt,
    markers: [/(?:omnyo|bb)-app-update-\d+\.tgz/iu],
  });

  if (leftovers.length > 0)
    throw new InstallError(
      "Processes from the failed installer may still be running; nothing was changed.",
      leftovers
        .slice(0, 20)
        .map((entry) => `${entry.pid} ${entry.name} (parent ${entry.ppid})`),
    );

  done(
    `No process started since the failed installer lacks a live owner (${before.length} processes checked)`,
  );

  const artifact = await downloadServerArtifact(
    service.serverUrl,
    readMachineHeaders(dataDir),
  );

  try {
    await assertInstallationAdmission(dataDir, artifact.helperPath, true);

    const reconciliation = join(
      dataDir,
      RECONCILIATION_DIR_NAME,
      `${String(attempt.version ?? "unknown").replaceAll(/[^A-Za-z0-9.+-]/gu, "_")}-${attemptSha.slice(0, 16)}`,
    );

    if (existsSync(join(reconciliation, "result.json")))
      throw new InstallError(
        "This installer attempt was already reconciled; its journal changed afterwards.",
      );
    mkdirSync(reconciliation, { recursive: true });
    const originalPath = join(reconciliation, "attempt.original.json");

    if (!existsSync(originalPath)) writeFileSync(originalPath, attemptBytes);
    else if (sha256(readFileSync(originalPath)) !== attemptSha)
      throw new InstallError(
        "The preserved installer journal differs from the current one.",
      );

    const installerCopy = join(dataDir, INSTALLER_FILE_NAME);
    const previousInstaller = join(reconciliation, "installer.previous.mjs");

    if (existsSync(installerCopy) && !existsSync(previousInstaller))
      copyFileSync(installerCopy, previousInstaller);

    writeJsonAtomic(join(reconciliation, "proof-before.json"), {
      schema: 1,
      checkedAt: new Date().toISOString(),
      hostId: service.hostId,
      attemptSHA: attemptSha,
      installer: attempt.installer,
      windowStartedAt: startedAt,
      processesChecked: before.length,
      installerProcesses: 0,
      worker: statusSummary(status),
      target: {
        version: artifact.version,
        protocolVersion: artifact.protocolVersion,
        artifactDigest: artifact.artifactDigest,
      },
    });

    step("Stopping the worker so its runtime files are released");
    await stopService(dataDir, service);
    await waitForPackageRelease(service.npmPrefix);
    done("No process uses the installed runtime");

    const retired = preserveRetiredNpmEntries(
      service.npmPrefix,
      join(reconciliation, "npm-retired"),
    );

    if (retired.length > 0)
      done(`Preserved ${retired.length} entries npm had moved aside`);

    step(`Installing Omnyo ${artifact.version} while the runtime is stopped`);
    rmSync(join(dataDir, INSTALLED_DIGEST_FILE_NAME), { force: true });
    const repairJournal = join(reconciliation, "repair-install.json");

    const install = await installRuntimeArchive({
      dataDir,
      npmPrefix: service.npmPrefix,
      tarball: artifact.tarball,
      journal: (installer) =>
        writeJsonAtomic(repairJournal, {
          schema: 1,
          version: artifact.version,
          installer,
        }),
    });

    if (install.survivors.length > 0)
      throw new InstallError(
        "The repair installer left processes; the worker stays stopped.",
        install.survivors.map((entry) => `${entry.pid} ${entry.name}`),
      );

    if (install.code !== 0)
      throw new InstallError(
        "npm could not install the server's runtime; the worker stays stopped.",
        [`See ${join(dataDir, "logs", "machine-service.log")}`],
      );

    const root = packageRoot(service.npmPrefix);
    await verifyInstalledPackage(root, artifact.version);
    const inventory = compareInstalledPackage(artifact.packageDir, root);

    if (inventory.mismatched.length > 0)
      throw new InstallError(
        "The installed runtime differs from the verified archive; the worker stays stopped.",
        inventory.mismatched.slice(0, 20),
      );

    writeFileAtomic(
      join(dataDir, INSTALLED_DIGEST_FILE_NAME),
      `${artifact.artifactDigest}\n`,
    );
    done(
      `Installed runtime matches all ${inventory.files} files of the verified archive`,
    );

    const reconciledAttempt = {
      attemptedAt: Date.now(),
      attemptCount: 1,
      protocolVersion: artifact.protocolVersion,
      version: artifact.version,
      artifactDigest: artifact.artifactDigest,
    };

    writeJsonAtomic(join(reconciliation, "acknowledgement.json"), {
      schema: 1,
      acknowledgedAt: new Date().toISOString(),
      originalAttemptSHA: attemptSha,
      installerProcessesAbsent: true,
      repairInstallerRootPid: install.rootPid,
      repairInstallerProcessesAbsent: true,
      preservedNpmEntries: retired,
      installedVersion: artifact.version,
      artifactDigest: artifact.artifactDigest,
      installedFilesVerified: inventory.files,
    });
    writeJsonAtomic(attemptPath, reconciledAttempt);

    const installerSource = fileURLToPath(import.meta.url);

    if (
      !existsSync(installerCopy) ||
      realpathSync(installerSource).toLowerCase() !==
        realpathSync(installerCopy).toLowerCase()
    )
      copyFileSync(installerSource, installerCopy);

    step("Starting the worker");
    await startService(dataDir, service);
    const after = await readManagementStatus(dataDir, service);

    const admitted = repairedWorkerAdmitsCommands(after, artifact.version);

    writeJsonAtomic(join(reconciliation, "result.json"), {
      schema: 1,
      completedAt: new Date().toISOString(),
      status: admitted ? "reconciled" : "started-without-admission",
      hostId: service.hostId,
      worker: statusSummary(after),
    });

    if (!admitted)
      throw new InstallError(
        "The worker started but does not report open command admission.",
        [JSON.stringify(statusSummary(after))],
      );

    done(
      `Worker ${service.hostId} runs Omnyo ${artifact.version} with command admission open`,
    );
    detail(`Evidence: ${reconciliation}`);
  } finally {
    rmSync(artifact.directory, { force: true, recursive: true });
  }
}

export function detachedRunCommandLine({
  dataDir,
  hostId,
  installerPath,
  nodePath,
}) {
  return [
    nodePath,
    installerPath,
    "--run",
    "--host-id",
    hostId,
    "--data-dir",
    dataDir,
  ]
    .map((part) => `"${part}"`)
    .join(" ");
}

const START_DETACHED_PROCESS_SCRIPT = [
  "$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
  "$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:MACHINE_SERVICE_COMMAND; CurrentDirectory = $env:MACHINE_SERVICE_DIRECTORY; ProcessStartupInformation = $startup }",
  "if ($result.ReturnValue -ne 0) { exit 1 }",
].join("; ");

async function controlScheduledService(dataDir, service, action) {
  const startupOwner = service.startupOwner;

  if (
    startupOwner !== undefined &&
    (startupOwner === null ||
      startupOwner.version !== 1 ||
      typeof startupOwner.taskName !== "string" ||
      typeof startupOwner.taskPath !== "string" ||
      typeof startupOwner.nodePath !== "string" ||
      realpathSync(startupOwner.nodePath).toLowerCase() !==
        realpathSync(process.execPath).toLowerCase())
  )
    throw new InstallError(
      "Use the verified existing Windows startup owner and Node runtime.",
    );

  const argumentsLine = [
    join(dataDir, INSTALLER_FILE_NAME),
    "--run",
    "--host-id",
    service.hostId,
    "--data-dir",
    dataDir,
  ]
    .map((part) => `"${part}"`)
    .join(" ");

  const script = [
    "$ErrorActionPreference='Stop'",
    "$candidates=if($env:MACHINE_SERVICE_TASK_NAME){@(Get-ScheduledTask -TaskName $env:MACHINE_SERVICE_TASK_NAME -TaskPath $env:MACHINE_SERVICE_TASK_PATH)}else{@(Get-ScheduledTask)}",
    "$tasks=@($candidates | Where-Object { @($_.Actions).Count -eq 1 -and $_.Actions[0].Execute -eq $env:MACHINE_SERVICE_NODE -and $_.Actions[0].Arguments -eq $env:MACHINE_SERVICE_ARGUMENTS })",
    "if($env:MACHINE_SERVICE_TASK_NAME -and $tasks.Count -ne 1){throw 'The verified Windows startup owner changed'}",
    "if($tasks.Count -gt 1){throw 'Conflicting machine service startup tasks'}",
    "if($tasks.Count -eq 0){[Console]::Write('false');exit 0}",
    "$task=$tasks[0]",
    "if($env:MACHINE_SERVICE_ACTION -eq 'start'){Enable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null; Start-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath}",
    "if($env:MACHINE_SERVICE_ACTION -eq 'stop'){Disable-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath | Out-Null; Stop-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath}",
    "if($env:MACHINE_SERVICE_ACTION -eq 'remove'){Unregister-ScheduledTask -TaskName $task.TaskName -TaskPath $task.TaskPath -Confirm:$false}",
    "[Console]::Write('true')",
  ].join("; ");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        MACHINE_SERVICE_NODE: process.execPath,
        MACHINE_SERVICE_ARGUMENTS: argumentsLine,
        MACHINE_SERVICE_ACTION: action,
        MACHINE_SERVICE_TASK_NAME: startupOwner?.taskName ?? "",
        MACHINE_SERVICE_TASK_PATH: startupOwner?.taskPath ?? "",
      },
    },
  );

  if (stdout.trim() !== "true" && stdout.trim() !== "false") {
    throw new InstallError("Windows returned an invalid startup task result.");
  }

  return stdout.trim() === "true";
}

async function startService(dataDir, service) {
  const status = {
    hostId: service.hostId,
    port: service.hostDaemonPort,
    serverUrl: service.serverUrl,
  };

  if (await controlScheduledService(dataDir, service, "start")) {
    if (
      !(await waitForConnection({
        ...status,
        subject: "the scheduled host daemon",
      }))
    ) {
      throw new InstallError(
        "The startup task is running but the machine has not connected.",
      );
    }

    done("Scheduled host daemon connected");

    return;
  }

  if (await daemonStatusMatches({ ...status, requireConnected: false })) {
    done("The host daemon is already running");

    return;
  }

  rmSync(join(dataDir, PID_FILE_NAME), { force: true });

  try {
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        START_DETACHED_PROCESS_SCRIPT,
      ],
      {
        env: {
          ...process.env,
          MACHINE_SERVICE_COMMAND: detachedRunCommandLine({
            dataDir,
            hostId: service.hostId,
            installerPath: join(dataDir, INSTALLER_FILE_NAME),
            nodePath: process.execPath,
          }),
          MACHINE_SERVICE_DIRECTORY: dataDir,
        },
        windowsHide: true,
      },
    );
  } catch {
    throw new InstallError("Could not start the Omnyo host daemon.", [
      "Windows refused to create the daemon process through WMI.",
    ]);
  }

  if (!(await waitForConnection({ ...status, subject: "the host daemon" }))) {
    throw new InstallError(
      `The Omnyo host daemon did not connect to ${service.serverUrl}.`,
      [`See ${join(dataDir, "logs", "machine-service.log")}`],
    );
  }

  done("Host daemon connected");
}

async function stopService(dataDir, service) {
  const pid = Number(readText(join(dataDir, PID_FILE_NAME)).trim());
  const running = Number.isInteger(pid) && pid > 1 && processIsRunning(pid);

  if (running) {
    const commandLine = await processCommandLine(pid);

    if (
      !commandLine.includes("host-daemon") ||
      !new RegExp(
        String.raw`(?:^|\s)(?:"--host-daemon-port"|--host-daemon-port)\s+(?:"${service.hostDaemonPort}"|${service.hostDaemonPort})(?=\s|$)`,
        "u",
      ).test(commandLine)
    ) {
      throw new InstallError(
        `Process ${pid} recorded in ${join(dataDir, PID_FILE_NAME)} is not this machine's host daemon.`,
      );
    }

    await controlScheduledService(dataDir, service, "stop");

    if (processIsRunning(pid)) await stopProcessTree(pid);
  } else {
    await controlScheduledService(dataDir, service, "stop");
  }

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (
      !(await daemonStatusMatches({
        hostId: service.hostId,
        port: service.hostDaemonPort,
        requireConnected: false,
        serverUrl: service.serverUrl,
      }))
    ) {
      rmSync(join(dataDir, PID_FILE_NAME), { force: true });
      done("Stopped the host daemon");

      return;
    }

    await delay(500);
  }

  throw new InstallError(
    "An Omnyo host daemon that this installer did not start is still running on this machine's port.",
    [
      `Stop the process listening on port ${service.hostDaemonPort}, then run this command again.`,
    ],
  );
}

async function registerStartup(dataDir, service) {
  if (await controlScheduledService(dataDir, service, "exists")) return;
  await execFileAsync(
    "reg.exe",
    [
      "add",
      RUN_KEY,
      "/v",
      serviceName(service.serverUrl, service.hostId),
      "/t",
      "REG_SZ",
      "/d",
      startupCommand({
        dataDir,
        hostId: service.hostId,
        nodePath: process.execPath,
      }),
      "/f",
    ],
    { windowsHide: true },
  );
}

async function unregisterStartup(dataDir, service) {
  await controlScheduledService(dataDir, service, "remove");
  await execFileAsync(
    "reg.exe",
    [
      "delete",
      RUN_KEY,
      "/v",
      serviceName(service.serverUrl, service.hostId),
      "/f",
    ],
    { windowsHide: true },
  ).catch(() => undefined);
}

function findInstallation(hostId, requestedDataDir) {
  const candidates =
    requestedDataDir !== null
      ? [requestedDataDir]
      : (() => {
          return [".omnyo-machines", LEGACY_WORKER_ROOT_V1].flatMap((root) => {
            const machinesDir = join(homedir(), root);

            if (!existsSync(machinesDir)) return [];

            return readdirSync(machinesDir).map((name) =>
              join(machinesDir, name),
            );
          });
        })();

  const installations = [];

  for (const dataDir of candidates) {
    const service = readService(dataDir);

    if (service !== null && service.hostId === hostId) {
      installations.push({ dataDir, service });
    }
  }

  if (installations.length === 1) return installations[0];

  if (installations.length > 1) {
    throw new InstallError(
      "Several profiles claim this machine. Pass --data-dir to choose one.",
    );
  }

  throw new InstallError(
    `Machine ${hostId} is not installed on this computer.`,
  );
}

export function legacyProfileRemoval(dataDir, hostId) {
  if (!dataDir.split(/[\\/]/u).includes(LEGACY_WORKER_ROOT_V1)) return null;

  return `node "${join(dataDir, INSTALLER_FILE_NAME)}" --uninstall --host-id ${hostId}`;
}

async function assertInstallationAdmission(dataDir, helperPath, forStart) {
  const admission = await import(pathToFileURL(helperPath).href);

  if (forStart) await admission.assertInstallationStateForStart(dataDir);
  else await admission.assertInstallationState(dataDir);
}

async function runLifecycle(options) {
  const { dataDir, service } = findInstallation(
    options.hostId,
    options.dataDir,
  );

  const removal = legacyProfileRemoval(dataDir, options.hostId);

  if (removal !== null) {
    throw new InstallError(
      "An older installer owns this profile. Remove it with that installer's own copy, then enroll this machine again.",
      [removal],
    );
  }

  if (options.action === "repair-runtime") {
    await repairRuntime(dataDir, service);

    return;
  }

  await assertInstallationAdmission(
    dataDir,
    join(packageRoot(service.npmPrefix), "dist", "state-admission.mjs"),
    true,
  );

  if (options.action === "run") {
    await runDaemon(dataDir, service);

    return;
  }

  if (options.action === "start") {
    await startService(dataDir, service);

    return;
  }

  await stopService(dataDir, service);

  if (options.action === "uninstall") {
    await unregisterStartup(dataDir, service);
    rmSync(dataDir, {
      force: true,
      maxRetries: 20,
      recursive: true,
      retryDelay: 250,
    });
    done(`Removed machine ${options.hostId} from this computer`);
  }
}

async function runInstall(options) {
  const rawBootstrap = process.env[options.bootstrapEnv];
  delete process.env[options.bootstrapEnv];

  if (rawBootstrap === undefined) {
    throw new InstallError(`${options.bootstrapEnv} is not set.`);
  }

  const bootstrap = parseBootstrap(rawBootstrap);
  process.stdout.write("\n  Omnyo machine setup\n\n");
  step(
    `Setting up this machine as ${bootstrap.hostId} for ${bootstrap.serverUrl}`,
  );

  const [major, minor] = process.versions.node.split(".").map(Number);

  if (major < 22 || (major === 22 && minor < 19)) {
    throw new InstallError(
      `Node.js ${process.versions.node} is too old; omnyo-app requires Node.js 22.19 or newer (22.19, 24, and 26 are tested).`,
    );
  }

  const configuredDataDir = process.env.OMNYO_DATA_DIR?.trim();

  const dataDir =
    configuredDataDir !== undefined && configuredDataDir.length > 0
      ? configuredDataDir
      : (bootstrap.dataDir ??
        join(
          homedir(),
          ".omnyo-machines",
          serverHostSlug(bootstrap.serverUrl),
        ));

  if (!isAbsolute(dataDir)) {
    throw new InstallError("OMNYO_DATA_DIR must be an absolute path.");
  }

  const legacyDataDir = join(
    homedir(),
    LEGACY_WORKER_ROOT_V1,
    serverHostSlug(bootstrap.serverUrl),
  );

  const canonicalDefault = join(
    homedir(),
    ".omnyo-machines",
    serverHostSlug(bootstrap.serverUrl),
  );

  if (
    dataDir === canonicalDefault &&
    existsSync(legacyDataDir) &&
    readdirSync(legacyDataDir).length > 0
  ) {
    throw new InstallError(
      `An old worker profile still exists at ${legacyDataDir}. Remove it, then enroll this machine again.`,
      [legacyProfileRemoval(legacyDataDir, "<machine-id>")],
    );
  }

  const existingHostId = installedHostId(dataDir);

  if (existingHostId !== "" && existingHostId !== bootstrap.hostId) {
    throw new InstallError(
      `${dataDir} on this computer belongs to machine ${existingHostId}, not ${bootstrap.hostId}.`,
      [
        bootstrap.reconnect
          ? `Run this command on the computer where machine ${bootstrap.hostId} runs.`
          : "To add another machine on this computer, set OMNYO_DATA_DIR to a new directory and run the command again.",
      ],
    );
  }

  if (bootstrap.reconnect && existingHostId !== bootstrap.hostId) {
    throw new InstallError(
      `Machine ${bootstrap.hostId} is not installed in ${dataDir} on this computer.`,
      [
        `Run this command on the computer where machine ${bootstrap.hostId} runs.`,
      ],
    );
  }

  const previousService = readService(dataDir);

  if (
    previousService !== null &&
    (previousService.hostId !== bootstrap.hostId ||
      normalizeServerUrl(previousService.serverUrl) !==
        normalizeServerUrl(bootstrap.serverUrl))
  )
    throw new InstallError(
      "The existing machine service belongs to another host or server route.",
    );

  const preparedPackage = await preparePackage({
    bootstrap,
    dataDir,
    npmPrefix: join(dataDir, "npm"),
  });

  try {
    await assertInstallationAdmission(
      dataDir,
      preparedPackage.helperPath,
      false,
    );
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    rmSync(join(dataDir, "machine-suspended"), { force: true });
    const canonicalDataDir = realpathSync(dataDir);
    const npmPrefix = join(canonicalDataDir, "npm");
    const root = packageRoot(npmPrefix);

    if (previousService !== null) {
      step("Stopping the host daemon before updating it");
      await stopService(canonicalDataDir, previousService);
    }

    const port = await chooseHostDaemonPort({
      dataDir: canonicalDataDir,
      hostId: bootstrap.hostId,
      requested: options.hostDaemonPort,
      serverUrl: bootstrap.serverUrl,
    });

    if (preparedPackage.packageFile !== null) {
      step("Installing the server's omnyo-app build");
      await installPackage({
        dataDir: canonicalDataDir,
        npmPrefix,
        source: preparedPackage.packageFile,
      });
      writeFileAtomic(
        join(canonicalDataDir, "host-artifact.sha256"),
        preparedPackage.expectedDigest + "\n",
      );
      done("Installed the server's omnyo-app build");
    }

    if (!existsSync(join(root, "dist", "omnyo-app.js"))) {
      throw new InstallError(
        `npm installed omnyo-app, but did not create the expected package at ${root}.`,
      );
    }

    await verifyNativeModules(root);

    const enrollCode = await runInherited(
      process.execPath,
      [
        join(root, "dist", "omnyo.js"),
        "machine",
        "enroll",
        "--bootstrap-env",
        "OMNYO_ENROLLMENT",
      ],
      {
        env: {
          ...daemonEnvironment({ dataDir: canonicalDataDir, npmPrefix }),
          OMNYO_ENROLLMENT: rawBootstrap,
        },
      },
    );

    if (enrollCode !== 0) {
      throw new InstallError("Could not enroll this machine with the server.");
    }

    await joinServer({
      bootstrap,
      dataDir: canonicalDataDir,
      npmPrefix,
      port,
      root,
    });

    const service = {
      hostDaemonPort: port,
      hostId: bootstrap.hostId,
      npmPrefix,
      serverUrl: bootstrap.serverUrl,
    };

    writeFileAtomic(
      join(canonicalDataDir, SERVICE_FILE_NAME),
      `${JSON.stringify(service, null, 2)}\n`,
    );
    const installerCopy = join(canonicalDataDir, INSTALLER_FILE_NAME);
    const installerSource = fileURLToPath(import.meta.url);

    if (installerSource !== installerCopy) {
      copyFileSync(installerSource, installerCopy);
    }

    step("Starting the host daemon");
    await startService(canonicalDataDir, service);
    await registerStartup(canonicalDataDir, service);
    done("The host daemon starts when you sign in to Windows");
    detail(`Omnyo CLI for this machine: ${join(npmPrefix, "omnyo.cmd")}`);
    detail(
      `To remove this machine: node "${installerCopy}" --uninstall --host-id ${bootstrap.hostId}`,
    );
  } finally {
    if (preparedPackage.packageDir !== null)
      rmSync(preparedPackage.packageDir, { force: true, recursive: true });
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2));

  if (process.platform !== "win32") {
    throw new InstallError(
      "This installer supports Windows only. Use install.sh on macOS and Linux.",
    );
  }

  if (options.action === null) {
    await runInstall(options);
  } else {
    await runLifecycle(options);
  }
}

function isMainModule() {
  if (process.argv[1] === undefined) return false;

  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)).toLowerCase() ===
      realpathSync(process.argv[1]).toLowerCase()
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error) => {
    process.stderr.write(
      `  x  ${error instanceof Error ? error.message : String(error)}\n`,
    );

    if (error instanceof InstallError) {
      for (const line of error.details) process.stderr.write(`     ${line}\n`);
    }

    process.exitCode = 1;
  });
}

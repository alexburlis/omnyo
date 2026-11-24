import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer as createNetServer } from "node:net";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = new URL(
  "../../src/assets/install-machine.sh",
  import.meta.url,
);

const createdDirectories: string[] = [];

let runtimeArtifactFixture:
  | { bytes: Buffer; digest: string; admissionEntry: Buffer }
  | undefined;

function getRuntimeArtifactFixture(): {
  bytes: Buffer;
  digest: string;
  admissionEntry: Buffer;
} {
  if (runtimeArtifactFixture) return runtimeArtifactFixture;

  const root = mkdtempSync(join(tmpdir(), "omnyo-installer-artifact-"));

  try {
    const packageRoot = join(root, "package");
    const dist = join(packageRoot, "dist");
    mkdirSync(dist, { recursive: true });

    const build = spawnSync(
      process.execPath,
      [
        new URL("../../../../scripts/build-node-entry.mjs", import.meta.url)
          .pathname,
        "src/state-admission.ts",
        join(dist, "state-admission.mjs"),
      ],
      {
        cwd: new URL("../../../../packages/omnyo-app", import.meta.url),
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    if (build.status !== 0)
      throw new Error(
        `Installer admission fixture build failed: ${build.stderr}`,
      );
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "omnyo-app", version: "0.0.0" }),
    );
    const archive = join(root, "runtime.tgz");

    const pack = spawnSync("tar", ["-czf", archive, "-C", root, "package"], {
      encoding: "utf8",
      timeout: 5_000,
    });

    if (pack.status !== 0)
      throw new Error(`Installer artifact fixture failed: ${pack.stderr}`);
    const bytes = readFileSync(archive);
    runtimeArtifactFixture = {
      bytes,
      digest: createHash("sha256").update(bytes).digest("hex"),
      admissionEntry: readFileSync(join(dist, "state-admission.mjs")),
    };

    return runtimeArtifactFixture;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function createFixture(): { binDir: string; dataDir: string; homeDir: string } {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "omnyo-install-script-test-")),
  );

  createdDirectories.push(root);
  const binDir = join(root, "bin");
  const dataDir = join(root, "data");
  const homeDir = join(root, "home");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(join(root, "package.json"), '{"type":"commonjs"}\n');
  symlinkSync(process.execPath, join(binDir, "node"));

  return { binDir, dataDir, homeDir };
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

type Fixture = ReturnType<typeof createFixture>;

function createScriptEnv(
  fixture: Fixture,
  env: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OMNYO_DATA_DIR: fixture.dataDir,
    OMNYO_ENROLLMENT: bootstrapBundle(),
    HOME: fixture.homeDir,
    PATH: [fixture.binDir, "/usr/bin", "/bin"].join(delimiter),
    ...env,
  };
}

function runScript(
  args: string[],
  fixture: Fixture,
  env: Record<string, string | undefined> = {},
) {
  return spawnSync("sh", [SCRIPT_PATH.pathname, ...args], {
    encoding: "utf8",
    env: createScriptEnv(fixture, env),
  });
}

const BOOTSTRAP_ARGS = ["--bootstrap-env", "OMNYO_ENROLLMENT"];

function bootstrapBundle(serverUrl = "https://coordinator.example"): string {
  return JSON.stringify({
    hostId: "host-test",
    serverUrl,
    credential: "join-secret",
    expiresAt: 4102444800000,
  });
}

function writeJoinedState(
  fixture: ReturnType<typeof createFixture>,
  serverUrl = "https://coordinator.example",
  hostId = "host-test",
): void {
  writeFileSync(
    join(fixture.dataDir, "auth.json"),
    JSON.stringify({ hostId, hostKey: "secret", hostType: "persistent" }),
  );
  writeFileSync(
    join(fixture.dataDir, "config.json"),
    JSON.stringify({ serverUrl }),
  );
}

function createRuntimeLauncherScript(args: {
  hostId: string;
  invocationPath?: string;
  statusServerUrl?: string;
}): string {
  const recordInvocation =
    args.invocationPath === undefined
      ? ""
      : `fs.writeFileSync(${JSON.stringify(args.invocationPath)}, cliArgs.join("\\n") + "\\n");`;

  return `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const cliArgs = process.argv.slice(2);
const option = (name) => {
  const index = cliArgs.indexOf(name);
  return index === -1 ? undefined : cliArgs[index + 1];
};
const dataDir = process.env.OMNYO_DATA_DIR;
const hostId = ${JSON.stringify(args.hostId)};
if (cliArgs[0] === "machine" && cliArgs[1] === "enroll") {
  const bundle = JSON.parse(process.env[option("--bootstrap-env")]);
  const enrolledUrl = new URL(bundle.serverUrl);
  if (enrolledUrl.hostname === "localhost") enrolledUrl.hostname = "127.0.0.1";
  const authPath = path.join(dataDir, "auth.json");
  if (fs.existsSync(authPath)) {
    if (JSON.parse(fs.readFileSync(authPath, "utf8")).hostId !== bundle.hostId) {
      process.stderr.write("Refusing to overwrite a different machine identity\\n");
      process.exit(1);
    }
    process.exit(0);
  }
  fs.writeFileSync(
    path.join(dataDir, "enrollment-argv"),
    JSON.stringify(cliArgs) + "\\n",
  );
  fs.writeFileSync(
    path.join(dataDir, "auth.json"),
    JSON.stringify({ hostId: bundle.hostId, hostKey: "secret" }) + "\\n",
  );
  fs.writeFileSync(
    path.join(dataDir, "config.json"),
    JSON.stringify({ serverUrl: enrolledUrl.href.replace(/\\/$/u, "") }) +
      "\\n",
  );
  process.exit(0);
}
${recordInvocation}
const port = Number(option("--host-daemon-port"));
const serverUrl = option("--server-url");
const statusServerUrl = ${JSON.stringify(args.statusServerUrl)} ?? serverUrl;
if (!fs.existsSync(path.join(dataDir, "auth.json"))) {
  fs.writeFileSync(
    path.join(dataDir, "auth.json"),
    JSON.stringify({ hostId, hostKey: "secret" }) + "\\n",
  );
}
const configPath = path.join(dataDir, "config.json");
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, JSON.stringify({ serverUrl }) + "\\n");
}
const server = http.createServer((request, response) => {
  if (request.url !== "/status") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ connected: true, hostId, serverUrl: statusServerUrl }));
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`;
}

function writeServerInstallTools(
  fixture: ReturnType<typeof createFixture>,
  artifactStatus: 200 | 404 | 500,
  artifactDigest = getRuntimeArtifactFixture().digest,
  transientFailures = 0,
  artifactBody: string | Uint8Array = getRuntimeArtifactFixture().bytes,
): void {
  const curlLog = join(fixture.binDir, "curl.log");
  const curlConfigLog = join(fixture.binDir, "curl-config.log");
  const curlAttemptsLog = join(fixture.binDir, "curl-attempts.log");
  const npmLog = join(fixture.binDir, "npm.log");
  writeExecutable(
    join(fixture.binDir, "curl"),
    `#!/bin/sh
printf '%s\n' "$*" >>"${curlLog}"
case "$*" in
  *)
    output=
    headers=
    retries=0
    unchanged=no
    case "$*" in *'If-None-Match: "sha256-${artifactDigest}"'*) unchanged=yes ;; esac
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --output ]; then output=$2; shift 2
      elif [ "$1" = --dump-header ]; then headers=$2; shift 2
      elif [ "$1" = --retry ]; then retries=$2; shift 2
      elif [ "$1" = --config ]; then cat "$2" >>"${curlConfigLog}"; shift 2
      else shift
      fi
    done
    attempt=0
    while [ "$attempt" -lt '${transientFailures}' ]; do
      printf '%s\n' 504 >>"${curlAttemptsLog}"
      if [ "$attempt" -ge "$retries" ]; then
        printf '%s' 504
        exit 0
      fi
      attempt=$((attempt + 1))
    done
    printf '%s\n' '${artifactStatus}' >>"${curlAttemptsLog}"
    [ -z "$headers" ] || printf '%s\n' 'HTTP/1.1 ${artifactStatus}' 'x-omnyo-artifact-sha256: ${artifactDigest}' >"$headers"
    if [ "$unchanged" = yes ] && [ '${artifactStatus}' = 200 ]; then
      printf '%s' 304
    else
      [ -z "$output" ] || printf '%s' '${Buffer.from(artifactBody).toString("base64")}' | base64 --decode >"$output"
      printf '%s' '${artifactStatus}'
    fi
    ;;
esac
`,
  );
  const runtimeTemplatePath = join(fixture.dataDir, "omnyo-app-template");
  writeExecutable(
    runtimeTemplatePath,
    createRuntimeLauncherScript({ hostId: "host-test" }),
  );
  writeExecutable(
    join(fixture.binDir, "npm"),
    `#!/bin/sh
printf '%s\n' "$*" >>"${npmLog}"
prefix=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --prefix ]; then prefix=$2; shift 2; else shift; fi
done
[ -n "$prefix" ] || exit 2
mkdir -p "$prefix/bin"
cp "${runtimeTemplatePath}" "$prefix/bin/omnyo-app"
chmod +x "$prefix/bin/omnyo-app"
cp "${runtimeTemplatePath}" "$prefix/bin/omnyo"
chmod +x "$prefix/bin/omnyo"
mkdir -p "$prefix/lib/node_modules/omnyo-app/host-daemon/dist"
printf '%s\n' 'fixture' >"$prefix/lib/node_modules/omnyo-app/host-daemon/dist/daemon-bundle.mjs"
for module in node-pty @parcel/watcher; do
  mkdir -p "$prefix/lib/node_modules/omnyo-app/node_modules/$module"
  if [ -z "$FAKE_NPM_SKIP_NATIVE_MODULES" ]; then
    printf '%s\n' 'module.exports = {};' >"$prefix/lib/node_modules/omnyo-app/node_modules/$module/index.js"
  fi
done
`,
  );
}

function writeRuntimeLauncher(
  fixture: ReturnType<typeof createFixture>,
  invocationPath: string,
  hostId = "host-test",
  statusServerUrl?: string,
): void {
  writeExecutable(
    join(fixture.binDir, "omnyo-app"),
    createRuntimeLauncherScript({ hostId, invocationPath, statusServerUrl }),
  );
  writeEnrollmentCli(fixture, hostId);
  const template = join(fixture.dataDir, "omnyo-app-template");

  if (existsSync(template))
    writeExecutable(
      template,
      createRuntimeLauncherScript({ hostId, invocationPath, statusServerUrl }),
    );
}

function writeEnrollmentCli(
  fixture: ReturnType<typeof createFixture>,
  hostId = "host-test",
): void {
  writeExecutable(
    join(fixture.binDir, "omnyo"),
    createRuntimeLauncherScript({ hostId }),
  );
}

function writeCurlArtifactMock(
  fixture: ReturnType<typeof createFixture>,
  artifactStatus: number,
): void {
  writeExecutable(
    join(fixture.binDir, "curl"),
    `#!/bin/sh
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output=$2; shift 2; else shift; fi
done
[ -z "$output" ] || printf '%s' 'fixture-tarball' >"$output"
printf '%s' '${artifactStatus}'
`,
  );
}

function writeUnreachableUserBus(fixture: Fixture, init: string): void {
  writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");
  writeExecutable(join(fixture.binDir, "id"), "#!/bin/sh\necho 1000\n");
  writeExecutable(join(fixture.binDir, "ps"), `#!/bin/sh\necho ${init}\n`);
  writeExecutable(
    join(fixture.binDir, "systemd-detect-virt"),
    "#!/bin/sh\nexit 1\n",
  );
  writeExecutable(join(fixture.binDir, "systemctl"), "#!/bin/sh\nexit 1\n");
  writeExecutable(join(fixture.binDir, "loginctl"), "#!/bin/sh\nexit 1\n");
}

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) {
    try {
      const servicePid = Number(
        readFileSync(join(directory, "data/service-daemon.pid"), "utf8"),
      );

      process.kill(servicePid, "SIGTERM");
    } catch {}

    rmSync(directory, { force: true, recursive: true });
  }
});

const describeOnPosix = process.platform === "win32" ? describe.skip : describe;

describeOnPosix("machine install script", { timeout: 15_000 }, () => {
  it.each([
    { uid: 0, unset: true },
    { uid: 501, unset: true },
    { uid: 501, unset: false },
  ])(
    "resolves an unset HOME and preserves explicit HOME: %j",
    ({ uid, unset }) => {
      const fixture = createFixture();

      const homeScript =
        'const home = require("node:os").homedir(); if (!require("node:path").isAbsolute(home)) process.exit(1); process.stdout.write(home);';

      rmSync(join(fixture.binDir, "node"));
      writeExecutable(
        join(fixture.binDir, "node"),
        `#!/bin/sh
if [ "$1" = -e ] && [ "$2" = '${homeScript}' ]; then
  : >'${join(fixture.dataDir, "resolved-home")}'
  printf '%s' '${fixture.homeDir}'
  exit 0
fi
exec '${process.execPath}' "$@"
`,
      );
      writeExecutable(join(fixture.binDir, "id"), `#!/bin/sh\necho ${uid}\n`);
      writeCurlArtifactMock(fixture, 404);

      const result = runScript(BOOTSTRAP_ARGS, fixture, {
        HOME: unset ? undefined : fixture.homeDir,
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain("HOME");
      expect(existsSync(join(fixture.dataDir, "resolved-home"))).toBe(unset);
      expect(existsSync(join(fixture.homeDir, ".local/bin/omnyo"))).toBe(false);
      expect(existsSync(join(fixture.dataDir, "auth.json"))).toBe(false);
    },
  );

  it("rejects missing required flags with usage", () => {
    const fixture = createFixture();
    const result = runScript(["--host-id", "host-only"], fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "Usage: install.sh --bootstrap-env <NAME> [--host-daemon-port <port>]",
    );
  });

  it("starts an owned daemon that has no service under launcher supervision", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".omnyo-machines", "owned"), {
      recursive: true,
    });

    const dataDir = realpathSync(
      join(fixture.homeDir, ".omnyo-machines", "owned"),
    );

    writeJoinedState({ ...fixture, dataDir });
    writeFileSync(join(dataDir, "host-daemon-port"), "40000\n");
    const invocationPath = join(dataDir, "invocation");
    mkdirSync(join(dataDir, "npm", "bin"), { recursive: true });
    writeExecutable(
      join(dataDir, "npm", "bin", "omnyo-app"),
      createRuntimeLauncherScript({ hostId: "host-test", invocationPath }),
    );

    const admissionPath = join(
      dataDir,
      "npm/lib/node_modules/omnyo-app/dist/state-admission.mjs",
    );

    mkdirSync(dirname(admissionPath), { recursive: true });
    writeFileSync(admissionPath, getRuntimeArtifactFixture().admissionEntry);
    const daemonPidPath = join(dataDir, "install-daemon.pid");

    const started = runScript(
      ["--start", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    try {
      expect(started.status, started.stderr).toBe(0);
      expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
        "host-daemon",
        "--auto-update",
        "--supervise",
        "--host-daemon-port",
        "40000",
        "--server-url",
        "https://coordinator.example",
      ]);
    } finally {
      if (existsSync(daemonPidPath)) {
        process.kill(Number(readFileSync(daemonPidPath, "utf8")), "SIGTERM");
      }
    }
  });

  it("stops and uninstalls an owned Linux service through installer flags", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".bb-machines", "owned"), {
      recursive: true,
    });

    const dataDir = realpathSync(
      join(fixture.homeDir, ".bb-machines", "owned"),
    );

    writeJoinedState({ ...fixture, dataDir });
    writeFileSync(join(dataDir, "host-daemon-port"), "40000\n");
    const serviceDir = join(fixture.homeDir, ".config", "systemd", "user");
    const serviceName = "bb-host-daemon-machine-example-test-host-test.service";
    const servicePath = join(serviceDir, serviceName);
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      servicePath,
      `[Service]\nEnvironment="OMNYO_DATA_DIR=${dataDir}"\n`,
    );
    writeExecutable(
      join(fixture.binDir, "uname"),
      "#!/bin/sh\nprintf '%s\\n' Linux\n",
    );
    const systemctlLog = join(fixture.homeDir, "systemctl.log");
    writeExecutable(
      join(fixture.binDir, "systemctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(systemctlLog)}\n`,
    );

    const stopped = runScript(
      ["--stop", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(stopped.status, stopped.stderr).toBe(0);
    expect(existsSync(dataDir)).toBe(true);
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      `--user stop ${serviceName}`,
    );

    const uninstalled = runScript(
      ["--uninstall", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(uninstalled.status, uninstalled.stderr).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
    expect(readFileSync(systemctlLog, "utf8")).toContain(
      `--user disable --now ${serviceName}`,
    );
  });

  it("stops and uninstalls a Linux service after a server move rewrote its server URL", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".bb-machines", "machine.example.test"), {
      recursive: true,
    });

    const dataDir = realpathSync(
      join(fixture.homeDir, ".bb-machines", "machine.example.test"),
    );

    writeJoinedState(
      { ...fixture, dataDir },
      "https://desk.tailnet.example:38886",
    );
    writeFileSync(join(dataDir, "host-daemon-port"), "40000\n");
    const serviceDir = join(fixture.homeDir, ".config", "systemd", "user");
    const serviceName = "bb-host-daemon-machine-example-test-host-test.service";
    const servicePath = join(serviceDir, serviceName);
    const otherServiceName = "bb-host-daemon-other-example-host-test.service";
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      servicePath,
      `[Service]\nExecStart="node" "bb-app" host-daemon --server-url "https://desk.tailnet.example:38886"\nEnvironment="OMNYO_DATA_DIR=${dataDir}"\n`,
    );
    writeFileSync(
      join(serviceDir, otherServiceName),
      `[Service]\nEnvironment="OMNYO_DATA_DIR=${dataDir}-other"\n`,
    );
    writeExecutable(
      join(fixture.binDir, "uname"),
      "#!/bin/sh\nprintf '%s\\n' Linux\n",
    );
    const systemctlLog = join(fixture.homeDir, "systemctl.log");
    writeExecutable(
      join(fixture.binDir, "systemctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(systemctlLog)}\n`,
    );

    const stopped = runScript(
      ["--stop", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(stopped.status, stopped.stderr).toBe(0);
    expect(readFileSync(systemctlLog, "utf8")).toBe(
      `--user stop ${serviceName}\n`,
    );

    const uninstalled = runScript(
      ["--uninstall", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(uninstalled.status, uninstalled.stderr).toBe(0);
    expect(existsSync(dataDir)).toBe(false);
    expect(existsSync(servicePath)).toBe(false);
    expect(existsSync(join(serviceDir, otherServiceName))).toBe(true);
    expect(readFileSync(systemctlLog, "utf8")).toBe(
      `--user stop ${serviceName}\n--user disable --now ${serviceName}\n--user daemon-reload\n`,
    );
  });

  it("boots out a macOS launch agent after a server move rewrote its server URL", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".bb-machines", "machine.example.test"), {
      recursive: true,
    });

    const dataDir = realpathSync(
      join(fixture.homeDir, ".bb-machines", "machine.example.test"),
    );

    writeJoinedState({ ...fixture, dataDir }, "https://desk.tailnet.example");
    writeFileSync(join(dataDir, "host-daemon-port"), "40000\n");
    const agentDir = join(fixture.homeDir, "Library", "LaunchAgents");

    const agentPath = join(
      agentDir,
      "app.getbb.host-daemon.machine-example-test-host-test.plist",
    );

    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      agentPath,
      `<plist><dict><key>EnvironmentVariables</key><dict><key>OMNYO_DATA_DIR</key><string>${dataDir}</string></dict></dict></plist>\n`,
    );
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");
    const launchctlLog = join(fixture.homeDir, "launchctl.log");
    writeExecutable(
      join(fixture.binDir, "launchctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(launchctlLog)}\n`,
    );

    const stopped = runScript(
      ["--stop", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(stopped.status, stopped.stderr).toBe(0);
    expect(readFileSync(launchctlLog, "utf8")).toBe(
      `bootout gui/${process.getuid?.()} ${agentPath}\n`,
    );
  });

  it("refuses lifecycle actions when several services reference the machine data directory", () => {
    const fixture = createFixture();
    mkdirSync(join(fixture.homeDir, ".omnyo-machines", "coordinator.example"), {
      recursive: true,
    });

    const dataDir = realpathSync(
      join(fixture.homeDir, ".omnyo-machines", "coordinator.example"),
    );

    writeJoinedState({ ...fixture, dataDir }, "https://desk.tailnet.example");
    writeFileSync(join(dataDir, "host-daemon-port"), "40000\n");
    const serviceDir = join(fixture.homeDir, ".config", "systemd", "user");
    mkdirSync(serviceDir, { recursive: true });

    for (const serviceName of [
      "omnyo-host-daemon-coordinator-example-host-test.service",
      "omnyo-host-daemon-coordinator-example.service",
    ]) {
      writeFileSync(
        join(serviceDir, serviceName),
        `[Service]\nEnvironment="OMNYO_DATA_DIR=${dataDir}"\n`,
      );
    }

    writeExecutable(
      join(fixture.binDir, "uname"),
      "#!/bin/sh\nprintf '%s\\n' Linux\n",
    );
    const systemctlLog = join(fixture.homeDir, "systemctl.log");
    writeExecutable(
      join(fixture.binDir, "systemctl"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >>${JSON.stringify(systemctlLog)}\n`,
    );

    const uninstalled = runScript(
      ["--uninstall", "--host-id", "host-test", "--data-dir", dataDir],
      fixture,
    );

    expect(uninstalled.status).toBe(1);
    expect(uninstalled.stderr).toContain(
      "Machine data directory is referenced by several services.",
    );
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(systemctlLog)).toBe(false);
  });

  it("rejects an invalid explicit host-daemon port", () => {
    const fixture = createFixture();

    const result = runScript(
      [...BOOTSTRAP_ARGS, "--host-daemon-port", "0"],
      fixture,
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "--host-daemon-port must be an integer between 1 and 65535",
    );
  });

  it("rejects a bootstrap bundle carrying an unusable server URL", () => {
    const fixture = createFixture();

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_ENROLLMENT: bootstrapBundle("not-a-url"),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Usage: install.sh --bootstrap-env <NAME>");
    expect(result.stderr).not.toContain("TypeError");
    expect(existsSync(join(fixture.dataDir, "auth.json"))).toBe(false);
  });

  it("prefers its verified CLI and pins the selected machine profile", () => {
    const prepared = createFixture();
    const dataDir = join(prepared.homeDir, "a profile's files");
    mkdirSync(dataDir);
    const fixture = { ...prepared, dataDir };
    writeServerInstallTools(fixture, 200);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);

    const pid = Number(
      readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
    );

    try {
      const other = join(
        fixture.homeDir,
        ".omnyo-machines/older/npm/bin/omnyo",
      );

      mkdirSync(dirname(other), { recursive: true });
      writeExecutable(other, "#!/bin/sh\necho wrong-installation\n");
      const installed = join(fixture.dataDir, "npm/bin/omnyo");
      writeExecutable(installed, '#!/bin/sh\nprintf "%s" "$OMNYO_DATA_DIR"\n');
      const shim = join(fixture.homeDir, ".local/bin/omnyo");

      const explicit = spawnSync(shim, ["machine", "list"], {
        env: createScriptEnv(fixture, {}),
        encoding: "utf8",
      });

      expect(explicit.status, explicit.stderr).toBe(0);
      expect(explicit.stdout).toBe(fixture.dataDir);
      const env = createScriptEnv(fixture, {});
      delete env.OMNYO_DATA_DIR;

      const selected = spawnSync(shim, ["machine", "list"], {
        env,
        encoding: "utf8",
      });

      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout).toBe(fixture.dataDir);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });

  it("cleans the verified artifact without publishing a CLI when installation fails", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);
    const argsFile = join(fixture.binDir, "failed-npm-args");
    writeExecutable(
      join(fixture.binDir, "npm"),
      "#!/bin/sh\nprintf '%s\\n' \"$@\" >'" + argsFile + "'\nexit 19\n",
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not install omnyo-app");
    expect(existsSync(join(fixture.homeDir, ".local/bin/omnyo"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "auth.json"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "install-daemon.pid"))).toBe(false);
    const archive = readFileSync(argsFile, "utf8").trim().split("\n").at(-1);
    expect(archive).toMatch(/omnyo-app\.tgz$/u);
    expect(existsSync(archive ?? "missing")).toBe(false);
  });

  it.each([{ container: true }])(
    "enrolls privately with portable service selection (%j)",
    ({ container }) => {
      const fixture = createFixture();
      writeServerInstallTools(fixture, 200);
      writeRuntimeLauncher(
        fixture,
        join(fixture.dataDir, "daemon-invocation"),
        "host-test",
      );
      writeExecutable(
        join(fixture.binDir, "omnyo"),
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const bundle = JSON.parse(process.env.OMNYO_ENROLLMENT);
fs.writeFileSync(path.join(process.env.OMNYO_DATA_DIR, "enrollment-argv"), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(path.join(process.env.OMNYO_DATA_DIR, "auth.json"), JSON.stringify({hostId: bundle.hostId, hostKey: "durable-test"}));
fs.writeFileSync(path.join(process.env.OMNYO_DATA_DIR, "config.json"), JSON.stringify({serverUrl: bundle.serverUrl}));
`,
      );

      if (container) {
        writeExecutable(
          join(fixture.binDir, "uname"),
          "#!/bin/sh\necho Linux\n",
        );
        writeExecutable(join(fixture.binDir, "id"), "#!/bin/sh\necho 0\n");
        writeExecutable(
          join(fixture.binDir, "ps"),
          "#!/bin/sh\necho systemd\n",
        );
        writeExecutable(
          join(fixture.binDir, "systemd-detect-virt"),
          "#!/bin/sh\nexit 0\n",
        );
        writeExecutable(
          join(fixture.binDir, "systemctl"),
          "#!/bin/sh\nexit 1\n",
        );
      }

      const result = runScript(["--bootstrap-env", "TEST_BUNDLE"], fixture, {
        OMNYO_INSTALL_SKIP_SERVICE: container ? "0" : "1",
        TEST_BUNDLE: JSON.stringify({
          hostId: "host-test",
          serverUrl: "https://coordinator.example",
          credential: "private-bootstrap-test",
          expiresAt: Date.now() + 60_000,
        }),
      });

      const pidPath = join(fixture.dataDir, "install-daemon.pid");

      try {
        expect(result.status, result.stderr).toBe(0);
        expect(
          JSON.parse(
            readFileSync(join(fixture.dataDir, "enrollment-argv"), "utf8"),
          ),
        ).toEqual(["machine", "enroll", "--bootstrap-env", "OMNYO_ENROLLMENT"]);
        expect(result.stdout + result.stderr).not.toContain(
          "private-bootstrap-test",
        );
        expect(
          spawnSync("sh", ["-n", join(fixture.homeDir, ".local/bin/omnyo")])
            .status,
        ).toBe(0);
      } finally {
        if (existsSync(pidPath)) {
          try {
            process.kill(Number(readFileSync(pidPath, "utf8")), "SIGTERM");
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              )
            )
              throw error;
          }
        }
      }
    },
  );

  it("refuses a PATH runtime when the private artifact is unavailable", () => {
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    writeServerInstallTools(fixture, 404);
    writeRuntimeLauncher(fixture, invocationPath);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 404");
    expect(existsSync(invocationPath)).toBe(false);
    expect(existsSync(join(fixture.dataDir, "auth.json"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "npm"))).toBe(false);
    expect(existsSync(join(fixture.homeDir, ".local"))).toBe(false);
  });

  it("starts the daemon for an existing enrollment when service setup is skipped", () => {
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    const daemonPidPath = join(fixture.dataDir, "install-daemon.pid");
    writeServerInstallTools(fixture, 200);
    writeExecutable(
      join(fixture.dataDir, "omnyo-app-template"),
      createRuntimeLauncherScript({ hostId: "host-test", invocationPath }),
    );
    writeJoinedState(fixture);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("already joined");

    try {
      expect(existsSync(daemonPidPath)).toBe(true);
      expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
        "host-daemon",
        "--auto-update",
        "--supervise",
        "--host-daemon-port",
        readFileSync(join(fixture.dataDir, "host-daemon-port"), "utf8").trim(),
        "--server-url",
        "https://coordinator.example",
      ]);
    } finally {
      if (existsSync(daemonPidPath)) {
        process.kill(Number(readFileSync(daemonPidPath, "utf8")), "SIGTERM");
      }
    }
  });

  it("refuses reconnect while the existing daemon still owns the profile", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const first = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(first.status, first.stderr).toBe(0);
    const pidFile = join(fixture.dataDir, "install-daemon.pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));

    try {
      const second = runScript(BOOTSTRAP_ARGS, fixture, {
        OMNYO_INSTALL_SKIP_SERVICE: "1",
      });

      expect(second.status).toBe(1);
      expect(second.stderr).toContain("existing daemon");
      expect(Number(readFileSync(pidFile, "utf8"))).toBe(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
      expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(
        config,
      );
      expect(
        readFileSync(join(fixture.binDir, "npm.log"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(1);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });

  it("accepts the daemon's normalized loopback server URL", () => {
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    writeServerInstallTools(fixture, 200);
    writeRuntimeLauncher(
      fixture,
      invocationPath,
      "host-test",
      "http://127.0.0.1:20101",
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_ENROLLMENT: bootstrapBundle("http://localhost:20101"),
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(invocationPath, "utf8").trim().split("\n")).toEqual([
      "host-daemon",
      "--auto-update",
      "--supervise",
      "--host-daemon-port",
      readFileSync(join(fixture.dataDir, "host-daemon-port"), "utf8").trim(),
      "--server-url",
      "http://localhost:20101",
    ]);

    const daemonPid = Number(
      readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
    );

    process.kill(daemonPid, "SIGTERM");
  });

  it("installs the server tarball even when a same-version omnyo-app is on PATH", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "omnyo-app"), "#!/bin/sh\nexit 99\n");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);

    const npmInvocation = readFileSync(join(fixture.binDir, "npm.log"), "utf8");

    expect(npmInvocation).toMatch(
      /^install -g --allow-scripts=better-sqlite3,node-pty,@parcel\/watcher --prefix \/.*\/data\/npm \/.*omnyo-app\..*\.tgz$/mu,
    );

    const daemonPid = Number(
      readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
    );

    process.kill(daemonPid, "SIGTERM");
  });

  it("prefers the server-matched tarball when omnyo-app is absent", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);

    const npmInvocation = readFileSync(join(fixture.binDir, "npm.log"), "utf8");

    expect(npmInvocation).toMatch(
      /^install -g --allow-scripts=better-sqlite3,node-pty,@parcel\/watcher --prefix \/.*\/data\/npm \/.*omnyo-app\..*\.tgz$/mu,
    );
    expect(npmInvocation).not.toContain("omnyo-app\n");
    const curlLog = readFileSync(join(fixture.binDir, "curl.log"), "utf8");

    expect(curlLog).toContain(
      "--silent --show-error --max-redirs 0 --connect-timeout 10 --max-time 300 --retry 3",
    );
    expect(curlLog).not.toMatch(/--location|(^|\s)-L(\s|$)/u);
    expect(result.stdout).toContain(
      "Setting up this machine as host-test for https://coordinator.example",
    );
    expect(result.stdout).toContain("\n  Omnyo machine setup\n\n");
    expect(result.stdout).toContain(
      "  ○  Setting up this machine as host-test for https://coordinator.example",
    );
    expect(result.stdout).toContain(
      "Downloading the server's omnyo-app package (timeout: 5 minutes)",
    );
    expect(result.stdout).toContain(
      "  ✓  Downloaded the server's omnyo-app package",
    );
    expect(result.stdout).toContain(
      "  ○  Installing the server's omnyo-app build",
    );
    expect(result.stdout).toContain(
      "  ✓  Installed the server's omnyo-app build",
    );
    expect(result.stdout).toContain("Waiting for the host daemon to connect");
    expect(result.stdout).toContain("Host daemon output is logged to");

    const daemonPid = Number(
      readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
    );

    process.kill(daemonPid, "SIGTERM");
  });

  it.each([
    [
      JSON.stringify({
        message:
          "The server ran out of disk space while preparing the host package. Check the server logs for diagnostic ID test-123, then retry installation.",
      }),
      "Server: The server ran out of disk space while preparing the host package. Check the server logs for diagnostic ID test-123, then retry installation.",
    ],
    ["<html>upstream failure</html>", null],
    ["{invalid json", null],
  ])("handles failed package response %s", (body, expected) => {
    const fixture = createFixture();
    writeServerInstallTools(
      fixture,
      500,
      getRuntimeArtifactFixture().digest,
      0,
      body,
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 500");

    if (expected !== null) expect(result.stderr).toContain(expected);
    else expect(result.stderr).not.toContain("Server:");
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });

  it("retries a transient server artifact download failure", () => {
    const fixture = createFixture();
    writeServerInstallTools(
      fixture,
      200,
      getRuntimeArtifactFixture().digest,
      1,
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(fixture.binDir, "curl-attempts.log"), "utf8")
        .trim()
        .split("\n"),
    ).toEqual(["504", "200"]);
    expect(result.stdout).toContain(
      "Downloaded the server's omnyo-app package",
    );

    const daemonPid = Number(
      readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
    );

    process.kill(daemonPid, "SIGTERM");
  });

  it("refuses a duplicate installation while the same artifact owner is active", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const first = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(first.status, first.stderr).toBe(0);
    const pidFile = join(fixture.dataDir, "install-daemon.pid");
    const pid = Number(readFileSync(pidFile, "utf8"));
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));

    try {
      const second = runScript(BOOTSTRAP_ARGS, fixture, {
        OMNYO_INSTALL_SKIP_SERVICE: "1",
      });

      expect(second.status).toBe(1);
      expect(second.stderr).toContain("existing daemon");
      expect(Number(readFileSync(pidFile, "utf8"))).toBe(pid);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
      expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(
        config,
      );
      expect(
        readFileSync(join(fixture.binDir, "npm.log"), "utf8")
          .trim()
          .split("\n"),
      ).toHaveLength(1);
    } finally {
      process.kill(pid, "SIGTERM");
    }
  });

  it("rejects a server host artifact whose digest does not match", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200, "a".repeat(64));

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed SHA-256 verification");
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "host-artifact.sha256"))).toBe(
      false,
    );
  });

  it("adopts a pinned local artifact without a canonical or public package fallback", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 500);
    const artifact = join(fixture.homeDir, "approved.tgz");
    writeFileSync(artifact, getRuntimeArtifactFixture().bytes);
    writeFileSync(
      join(fixture.dataDir, "auth.json"),
      JSON.stringify({ hostId: "host-test", hostKey: "secret" }) + "\n",
    );
    const before = readFileSync(join(fixture.dataDir, "auth.json"));

    const result = runScript(
      [
        "--adopt",
        "--data-dir",
        fixture.dataDir,
        "--artifact-path",
        artifact,
        "--artifact-sha256",
        getRuntimeArtifactFixture().digest,
      ],
      fixture,
      { OMNYO_ENROLLMENT: undefined, OMNYO_INSTALL_SKIP_SERVICE: "1" },
    );

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(fixture.binDir, "curl.log"))).toBe(false);
      expect(readFileSync(join(fixture.binDir, "npm.log"), "utf8")).toMatch(
        /omnyo-app\.tgz\n$/u,
      );
      expect(
        readFileSync(join(fixture.dataDir, "host-artifact.sha256"), "utf8"),
      ).toBe(getRuntimeArtifactFixture().digest + "\n");
      expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(before);
    } finally {
      const pidFile = join(fixture.dataDir, "install-daemon.pid");

      if (existsSync(pidFile))
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    }
  });

  it.each([
    "missing-hash",
    "missing-path",
    "invalid-hash",
    "missing-file",
    "symlink",
    "wrong-hash",
  ])(
    "refuses a local artifact before changing the enrolled data: %s",
    (mode) => {
      const fixture = createFixture();
      writeJoinedState(fixture);
      writeServerInstallTools(fixture, 500);
      const artifact = join(fixture.homeDir, "approved.tgz");
      writeFileSync(artifact, getRuntimeArtifactFixture().bytes);
      const link = artifact + ".link";

      if (mode === "symlink") symlinkSync(artifact, link);
      const before = readdirSync(fixture.dataDir).sort();
      const args = ["--adopt", "--data-dir", fixture.dataDir];

      if (mode !== "missing-path")
        args.push(
          "--artifact-path",
          mode === "missing-file"
            ? artifact + ".missing"
            : mode === "symlink"
              ? link
              : artifact,
        );

      if (mode !== "missing-hash")
        args.push(
          "--artifact-sha256",
          mode === "invalid-hash"
            ? "invalid"
            : mode === "wrong-hash"
              ? "0".repeat(64)
              : getRuntimeArtifactFixture().digest,
        );
      const result = runScript(args, fixture, { OMNYO_ENROLLMENT: undefined });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/artifact|Artifact/u);
      expect(readdirSync(fixture.dataDir).sort()).toEqual(before);
      expect(existsSync(join(fixture.homeDir, ".local/bin/omnyo"))).toBe(false);
    },
  );

  it("refuses a missing private artifact without installing a registry package", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 404);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("HTTP 404");
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "host-artifact.sha256"))).toBe(
      false,
    );
    expect(existsSync(join(fixture.dataDir, "npm"))).toBe(false);
    expect(existsSync(join(fixture.homeDir, ".local"))).toBe(false);
  });

  it("fails loudly when npm skipped the native add-on install scripts", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
      FAKE_NPM_SKIP_NATIVE_MODULES: "1",
    });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain(
      "npm installed omnyo-app, but its host native add-ons (node-pty, @parcel/watcher) did not load.",
    );
    expect(result.stderr).toContain(
      "npm_config_allow_scripts=better-sqlite3,node-pty,@parcel/watcher",
    );
    expect(existsSync(join(fixture.dataDir, "install-daemon.pid"))).toBe(false);
  });

  it("defaults the data dir to a per-server directory under ~/.omnyo-machines", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_DATA_DIR: "",
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status, result.stderr).toBe(0);

    const defaultDataDir = join(
      fixture.homeDir,
      ".omnyo-machines/coordinator.example",
    );

    expect(
      JSON.parse(readFileSync(join(defaultDataDir, "auth.json"), "utf8")),
    ).toMatchObject({ hostId: "host-test" });

    const daemonPid = Number(
      readFileSync(join(defaultDataDir, "install-daemon.pid"), "utf8"),
    );

    process.kill(daemonPid, "SIGTERM");
  });

  it("refuses a data dir enrolled for a different host instead of faking success", () => {
    const fixture = createFixture();
    writeCurlArtifactMock(fixture, 404);
    writeExecutable(join(fixture.binDir, "omnyo-app"), "#!/bin/sh\nexit 99\n");
    writeEnrollmentCli(fixture);
    writeJoinedState(fixture, "https://coordinator.example", "host-other");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "belongs to machine host-other, not host-test",
    );
    expect(result.stdout).not.toContain("Downloading");
    expect(existsSync(join(fixture.dataDir, "install-daemon.pid"))).toBe(false);
  });

  it("refuses a reconnect before downloading on a computer without that machine", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);
    const missingDir = join(fixture.homeDir, "elsewhere");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_DATA_DIR: "",
      OMNYO_ENROLLMENT: JSON.stringify({
        ...JSON.parse(bootstrapBundle()),
        reconnect: true,
        dataDir: missingDir,
      }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `Machine host-test is not installed in ${missingDir} on this computer.`,
    );
    expect(result.stdout).not.toContain("Downloading");
    expect(existsSync(missingDir)).toBe(false);
  });

  it("adopts an enrolled data directory as a launch agent without enrolling it again", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.dataDir, "auth.json"),
      JSON.stringify({ hostId: "host-test", hostKey: "secret" }),
    );
    writeFileSync(
      join(fixture.dataDir, "config.json"),
      JSON.stringify({
        serverUrl: "https://coordinator.example/",
        serverHeaders: { "x-omnyo-connect-machine": "machine-credential" },
      }),
    );
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");
    writeExecutable(
      join(fixture.binDir, "launchctl"),
      `#!/bin/sh
if [ "$1" = bootstrap ]; then
  port=$(sed -n '1p' "${join(fixture.dataDir, "host-daemon-port")}")
  OMNYO_DATA_DIR="${fixture.dataDir}" "${join(fixture.dataDir, "npm/bin/omnyo-app")}" host-daemon --host-daemon-port "$port" --server-url https://coordinator.example >/dev/null 2>&1 &
  echo $! >"${join(fixture.dataDir, "service-daemon.pid")}"
fi
`,
    );

    const result = runScript(
      ["--adopt", "--data-dir", fixture.dataDir],
      fixture,
      { OMNYO_DATA_DIR: undefined, OMNYO_ENROLLMENT: undefined },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Setting up this machine as host-test for https://coordinator.example",
    );
    expect(result.stdout).toContain("already joined");
    expect(result.stdout).toContain("  ●  Omnyo machine is ready");
    expect(existsSync(join(fixture.dataDir, "enrollment-argv"))).toBe(false);
    expect(
      readFileSync(join(fixture.binDir, "curl-config.log"), "utf8"),
    ).toContain('header = "x-omnyo-connect-machine: machine-credential"');
    expect(readFileSync(join(fixture.binDir, "curl.log"), "utf8")).not.toMatch(
      /--location|(^|\s)-L(\s|$)/u,
    );

    const plist = readFileSync(
      join(
        fixture.homeDir,
        "Library/LaunchAgents/app.omnyo.host-daemon.coordinator-example-host-test.plist",
      ),
      "utf8",
    );

    expect(plist).toContain(
      `<key>OMNYO_DATA_DIR</key><string>${fixture.dataDir}</string>`,
    );
    expect(plist).toContain("<string>--auto-update</string>");
    expect(plist).toContain("<string>https://coordinator.example</string>");
  });

  it("sends a legacy machine credential when adopting a data directory", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.dataDir, "auth.json"),
      JSON.stringify({ hostId: "host-test", hostKey: "secret" }),
    );
    writeFileSync(
      join(fixture.dataDir, "config.json"),
      JSON.stringify({
        serverUrl: "https://coordinator.example",
        machineCredential: "legacy-credential",
      }),
    );
    writeServerInstallTools(fixture, 200);

    const result = runScript(
      ["--adopt", "--data-dir", fixture.dataDir],
      fixture,
      { OMNYO_ENROLLMENT: undefined, OMNYO_INSTALL_SKIP_SERVICE: "1" },
    );

    expect(result.status, result.stderr).toBe(0);
    process.kill(
      Number(readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8")),
      "SIGTERM",
    );
    expect(
      readFileSync(join(fixture.binDir, "curl-config.log"), "utf8"),
    ).toContain('header = "x-omnyo-connect-machine: legacy-credential"');
  });

  it.each([
    { name: "without a data directory", args: ["--adopt"] },
    {
      name: "with a bootstrap bundle",
      args: ["--adopt", "--data-dir", "/tmp/data", ...BOOTSTRAP_ARGS],
    },
    {
      name: "with a lifecycle action",
      args: ["--adopt", "--stop", "--host-id", "host-test"],
    },
  ])("rejects --adopt $name", ({ args }) => {
    const fixture = createFixture();
    const result = runScript(args, fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("install.sh --adopt --data-dir <path>");
  });

  it("refuses to adopt a data directory without machine credentials", () => {
    const fixture = createFixture();
    writeFileSync(
      join(fixture.dataDir, "config.json"),
      JSON.stringify({ serverUrl: "https://coordinator.example" }),
    );
    writeServerInstallTools(fixture, 200);

    const result = runScript(
      ["--adopt", "--data-dir", fixture.dataDir],
      fixture,
      { OMNYO_ENROLLMENT: undefined },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${fixture.dataDir} has no machine credentials to adopt (auth.json is missing).`,
    );
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });

  it("assigns a different port when the first enrolled-daemon port is occupied", async () => {
    const occupied = createNetServer();
    let occupiedByTest = false;
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", (error) => {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;

        if (code === "EADDRINUSE") {
          resolve();

          return;
        }

        reject(error);
      });
      occupied.listen(38888, "127.0.0.1", () => {
        occupiedByTest = true;
        resolve();
      });
    });
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    writeServerInstallTools(fixture, 200);
    writeRuntimeLauncher(fixture, invocationPath);

    try {
      const result = runScript(BOOTSTRAP_ARGS, fixture, {
        OMNYO_INSTALL_SKIP_SERVICE: "1",
      });

      expect(result.status, result.stderr).toBe(0);

      const selectedPort = readFileSync(
        join(fixture.dataDir, "host-daemon-port"),
        "utf8",
      ).trim();

      expect(selectedPort).not.toBe("38888");
      expect(readFileSync(invocationPath, "utf8")).toContain(
        `--host-daemon-port\n${selectedPort}\n`,
      );

      const daemonPid = Number(
        readFileSync(join(fixture.dataDir, "install-daemon.pid"), "utf8"),
      );

      process.kill(daemonPid, "SIGTERM");
    } finally {
      if (occupiedByTest) {
        await new Promise<void>((resolve, reject) => {
          occupied.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  it("reports progress while waiting for its newly started daemon", () => {
    const fixture = createFixture();
    writeServerInstallTools(fixture, 200);

    const runtime = createRuntimeLauncherScript({ hostId: "host-test" })
      .replace(
        "const server = http.createServer(",
        "let checks=0;\nconst server = http.createServer(",
      )
      .replace("connected: true, hostId", "connected: ++checks > 5, hostId");

    writeExecutable(join(fixture.dataDir, "omnyo-app-template"), runtime);
    writeExecutable(join(fixture.binDir, "sleep"), "#!/bin/sh\nexit 0\n");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    const pidFile = join(fixture.dataDir, "install-daemon.pid");

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "Still waiting for the host daemon (5/60 checks)",
      );
      expect(result.stdout).not.toContain("(60/60 checks)");
    } finally {
      if (existsSync(pidFile))
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
    }
  });

  it("starts one fresh macOS agent and refuses to replace its existing owner", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");
    writeExecutable(
      join(fixture.binDir, "launchctl"),
      `#!/bin/sh
printf '%s\n' "$*" >>"${join(fixture.dataDir, "launchctl.log")}"
if [ "$1" = bootout ] && [ -f "${join(fixture.dataDir, "service-daemon.pid")}" ]; then
  service_pid=$(sed -n '1p' "${join(fixture.dataDir, "service-daemon.pid")}")
  kill "$service_pid" 2>/dev/null || true
  attempts=0
  while kill -0 "$service_pid" 2>/dev/null && [ "$attempts" -lt 100 ]; do
    attempts=$((attempts + 1))
    sleep 0.01
  done
  rm -f "${join(fixture.dataDir, "service-daemon.pid")}"
fi
if [ "$1" = bootstrap ]; then
  port=$(sed -n '1p' "${join(fixture.dataDir, "host-daemon-port")}")
  OMNYO_DATA_DIR="${fixture.dataDir}" "${join(fixture.dataDir, "npm/bin/omnyo-app")}" host-daemon --host-daemon-port "$port" --server-url https://coordinator.example >/dev/null 2>&1 &
  echo $! >"${join(fixture.dataDir, "service-daemon.pid")}"
  printf 'start\n' >>"${join(fixture.dataDir, "launchctl-starts.log")}"
fi
if [ "$1" = kickstart ]; then
  printf '%s\n' 'unexpected kickstart' >&2
  exit 70
fi
`,
    );

    const firstResult = runScript([...BOOTSTRAP_ARGS], fixture);
    const secondResult = runScript(BOOTSTRAP_ARGS, fixture);

    expect(firstResult.status, firstResult.stderr).toBe(0);
    expect(firstResult.stdout).toContain("already joined");
    expect(firstResult.stdout).toContain(
      "Installing the persistent Omnyo host daemon service",
    );
    expect(firstResult.stdout).toContain(
      "Waiting for the launch agent to connect",
    );
    expect(firstResult.stdout).toContain("  ●  Omnyo machine is ready");
    expect(secondResult.status, secondResult.stderr).toBe(1);
    expect(secondResult.stderr).toContain("already has an owner");
    expect(firstResult.stdout).toContain("server  https://coordinator.example");
    expect(firstResult.stdout).toContain(
      "service " +
        join(
          fixture.homeDir,
          "Library/LaunchAgents/app.omnyo.host-daemon.coordinator-example-host-test.plist",
        ),
    );

    const plist = readFileSync(
      join(
        fixture.homeDir,
        "Library/LaunchAgents/app.omnyo.host-daemon.coordinator-example-host-test.plist",
      ),
      "utf8",
    );

    expect(plist).toContain(
      "<string>app.omnyo.host-daemon.coordinator-example-host-test</string>",
    );
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<string>host-daemon</string>");
    expect(plist).toContain("<string>--auto-update</string>");

    const selectedPort = readFileSync(
      join(fixture.dataDir, "host-daemon-port"),
      "utf8",
    ).trim();

    expect(plist).toContain(
      `<string>--host-daemon-port</string>\n    <string>${selectedPort}</string>`,
    );
    expect(plist).toContain("<string>https://coordinator.example</string>");
    expect(plist).toContain(
      `<key>OMNYO_APP_NPM_PREFIX</key><string>${realpathSync(fixture.dataDir)}/npm</string>`,
    );

    const serviceFile = join(
      fixture.homeDir,
      "Library/LaunchAgents/app.omnyo.host-daemon.coordinator-example-host-test.plist",
    );

    const domain = `gui/${process.getuid?.()}`;
    expect(readFileSync(join(fixture.dataDir, "launchctl.log"), "utf8")).toBe(
      `bootstrap ${domain} ${serviceFile}\n`,
    );
    expect(
      readFileSync(join(fixture.dataDir, "launchctl-starts.log"), "utf8"),
    ).toBe("start\n");

    const serviceNode =
      /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/u.exec(
        plist,
      )?.[1] ?? "";

    rmSync(join(fixture.binDir, "node"));

    const nodeAfterSession = spawnSync(serviceNode, ["--version"], {
      encoding: "utf8",
    });

    expect(nodeAfterSession.status, nodeAfterSession.error?.message).toBe(0);
    expect(nodeAfterSession.stdout.trim()).toBe(process.version);
  });

  it("refuses replacing a V1 macOS agent when its recorded port differs", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");

    const service = join(
      fixture.homeDir,
      "Library/LaunchAgents",
      "app.getbb.host-daemon.recorded-owner.plist",
    );

    mkdirSync(dirname(service), { recursive: true });

    const bytes =
      "<dict><key>BB_DATA_DIR</key><string>" +
      fixture.dataDir +
      "</string></dict>";

    writeFileSync(service, bytes);
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));
    const effects = join(fixture.binDir, "service-effects");

    for (const tool of ["launchctl", "systemctl"])
      writeExecutable(
        join(fixture.binDir, tool),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >>'" + effects + "'\nexit 0\n",
      );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has an owner");
    expect(readFileSync(service, "utf8")).toBe(bytes);
    expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
    expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(config);
    expect(existsSync(effects)).toBe(false);
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });

  it("preserves an existing macOS agent without trying to stop it", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");

    const service = join(
      fixture.homeDir,
      "Library/LaunchAgents",
      "app.omnyo.host-daemon.recorded-owner.plist",
    );

    mkdirSync(dirname(service), { recursive: true });

    const bytes =
      "<dict><key>OMNYO_DATA_DIR</key><string>" +
      fixture.dataDir +
      "</string></dict>";

    writeFileSync(service, bytes);
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));
    const effects = join(fixture.binDir, "service-effects");

    for (const tool of ["launchctl", "systemctl"])
      writeExecutable(
        join(fixture.binDir, tool),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >>'" + effects + "'\nexit 0\n",
      );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has an owner");
    expect(readFileSync(service, "utf8")).toBe(bytes);
    expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
    expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(config);
    expect(existsSync(effects)).toBe(false);
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });

  it("reports launchctl bootstrap failures", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");
    writeExecutable(
      join(fixture.binDir, "launchctl"),
      `#!/bin/sh
printf '%s\n' "$*" >>"${join(fixture.dataDir, "launchctl.log")}"
if [ "$1" = bootstrap ]; then
  printf '%s\n' 'fixture bootstrap failure' >&2
  exit 36
fi
`,
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Could not register the Omnyo host-daemon launch agent app.omnyo.host-daemon.coordinator-example-host-test.",
    );
    expect(result.stderr).toContain("launchctl: fixture bootstrap failure");
  });

  it("treats launch-agent readiness as authoritative after bootstrap", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    rmSync(join(fixture.binDir, "node"));
    writeExecutable(
      join(fixture.binDir, "node"),
      `#!/bin/sh
if [ "$1" = -e ] && [ "$#" -eq 6 ] &&
   [ "$4" = host-test ] && [ "$5" = https://coordinator.example ] &&
   { [ "$6" = yes ] || [ "$6" = no ]; }; then
  case "$2" in
    *"fetch("*"/status"*) exit 1 ;;
  esac
fi
exec '${process.execPath}' "$@"
`,
    );
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Darwin\n");
    writeExecutable(
      join(fixture.binDir, "launchctl"),
      `#!/bin/sh
printf '%s\n' "$*" >>"${join(fixture.dataDir, "launchctl.log")}"
`,
    );
    writeExecutable(join(fixture.binDir, "sleep"), "#!/bin/sh\nexit 0\n");

    const result = runScript(BOOTSTRAP_ARGS, fixture);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "The Omnyo host-daemon launch agent started but did not connect to https://coordinator.example.",
    );
    expect(result.stderr).toContain(
      `See ${fixture.dataDir}/logs/host-daemon-stdio.log for the startup error and ${fixture.dataDir}/logs/launchd.log for launch agent output.`,
    );
    expect(result.stdout).toContain(
      "Still waiting for the launch agent (60/60 checks)",
    );
  });

  it("refuses reinstalling an existing systemd owner", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");

    const service = join(
      fixture.homeDir,
      ".config/systemd/user",
      "omnyo-host-daemon-recorded-owner.service",
    );

    mkdirSync(dirname(service), { recursive: true });

    const bytes =
      '[Service]\nEnvironment="OMNYO_DATA_DIR=' + fixture.dataDir + '"\n';

    writeFileSync(service, bytes);
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));
    const effects = join(fixture.binDir, "service-effects");

    for (const tool of ["launchctl", "systemctl"])
      writeExecutable(
        join(fixture.binDir, tool),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >>'" + effects + "'\nexit 0\n",
      );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has an owner");
    expect(readFileSync(service, "utf8")).toBe(bytes);
    expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
    expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(config);
    expect(existsSync(effects)).toBe(false);
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });

  it("recovers the current user's systemd runtime path when the installer has no session environment", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");
    const runtimeDir = join(fixture.homeDir, "runtime");
    mkdirSync(runtimeDir);
    writeExecutable(
      join(fixture.binDir, "loginctl"),
      `#!/bin/sh
printf '%s\\n' "$*" >>"${join(fixture.dataDir, "loginctl.log")}"
printf '%s\\n' '${runtimeDir}'
`,
    );
    writeExecutable(
      join(fixture.binDir, "systemctl"),
      `#!/bin/sh
printf '%s %s\\n' "$*" "\${XDG_RUNTIME_DIR:-missing}" >>"${join(fixture.dataDir, "systemctl.log")}"
if [ "$2" = show-environment ] && { [ "\${XDG_RUNTIME_DIR:-}" != '${runtimeDir}' ] || [ -n "\${DBUS_SESSION_BUS_ADDRESS:-}" ]; }; then exit 1; fi
if [ "$2" = start ]; then
  port=$(sed -n '1p' "${join(fixture.dataDir, "host-daemon-port")}")
  OMNYO_DATA_DIR="${fixture.dataDir}" "${join(fixture.dataDir, "npm/bin/omnyo-app")}" host-daemon --host-daemon-port "$port" --server-url https://coordinator.example >/dev/null 2>&1 &
  echo $! >"${join(fixture.dataDir, "service-daemon.pid")}"
fi
`,
    );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      XDG_RUNTIME_DIR: undefined,
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/stale/bus",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture.dataDir, "loginctl.log"), "utf8")).toBe(
      `show-user ${process.getuid?.()} --property=RuntimePath --value\n`,
    );
    expect(
      readFileSync(join(fixture.dataDir, "systemctl.log"), "utf8"),
    ).toContain(
      `--user enable omnyo-host-daemon-coordinator-example-host-test.service ${runtimeDir}`,
    );
  });

  it("fails visibly when the systemd user bus cannot be reached on a systemd host", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeUnreachableUserBus(fixture, "systemd");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      XDG_RUNTIME_DIR: undefined,
      DBUS_SESSION_BUS_ADDRESS: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("systemd user bus is unavailable");
    expect(result.stderr).toContain("will not start after a reboot");
    expect(result.stdout).not.toContain(
      "Installed and started the systemd service",
    );
    expect(existsSync(join(fixture.homeDir, ".config/systemd/user"))).toBe(
      false,
    );
    expect(existsSync(join(fixture.dataDir, "install-daemon.pid"))).toBe(false);
  });

  it("fails before joining when the systemd user bus is unavailable on a systemd host", () => {
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    writeCurlArtifactMock(fixture, 404);
    writeRuntimeLauncher(fixture, invocationPath);
    writeUnreachableUserBus(fixture, "systemd");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      XDG_RUNTIME_DIR: undefined,
      DBUS_SESSION_BUS_ADDRESS: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("systemd user bus is unavailable");
    expect(result.stdout).not.toContain("Joining");
    expect(existsSync(join(fixture.dataDir, "enrollment-argv"))).toBe(false);
    expect(existsSync(join(fixture.dataDir, "auth.json"))).toBe(false);
    expect(existsSync(invocationPath)).toBe(false);
  });

  it("runs a detached daemon on Linux without systemd as init", () => {
    const fixture = createFixture();
    const invocationPath = join(fixture.dataDir, "invocation");
    writeServerInstallTools(fixture, 200);
    writeRuntimeLauncher(fixture, invocationPath);
    writeUnreachableUserBus(fixture, "tini");

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      XDG_RUNTIME_DIR: undefined,
      DBUS_SESSION_BUS_ADDRESS: undefined,
    });

    try {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain(
        "Service installation skipped",
      );
      expect(existsSync(join(fixture.homeDir, ".config/systemd/user"))).toBe(
        false,
      );
    } finally {
      const pidPath = join(fixture.dataDir, "install-daemon.pid");

      if (existsSync(pidPath)) {
        process.kill(Number(readFileSync(pidPath, "utf8")), "SIGTERM");
      }
    }
  });

  it.each([false, true])(
    "installs a persistent root system unit (container=%s)",
    (container) => {
      const fixture = createFixture();
      writeJoinedState(fixture);
      writeServerInstallTools(fixture, 200);
      writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");
      writeExecutable(join(fixture.binDir, "id"), "#!/bin/sh\necho 0\n");
      writeExecutable(join(fixture.binDir, "ps"), "#!/bin/sh\necho systemd\n");
      writeExecutable(
        join(fixture.binDir, "systemd-detect-virt"),
        `#!/bin/sh\nexit ${container ? 0 : 1}\n`,
      );
      const scope = container ? "--user" : "--system";
      writeExecutable(
        join(fixture.binDir, "systemctl"),
        `#!/bin/sh
printf '%s\n' "$*" >>"${join(fixture.dataDir, "systemctl.log")}"
if [ "$*" = "${scope} start omnyo-host-daemon-coordinator-example-host-test.service" ]; then
  port=$(sed -n '1p' "${join(fixture.dataDir, "host-daemon-port")}")
  OMNYO_DATA_DIR="${fixture.dataDir}" "${join(fixture.dataDir, "npm/bin/omnyo-app")}" host-daemon --host-daemon-port "$port" --server-url https://coordinator.example >/dev/null 2>&1 &
  echo $! >"${join(fixture.dataDir, "service-daemon.pid")}"
fi
`,
      );

      const result = runScript(BOOTSTRAP_ARGS, fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("already joined");
      expect(result.stdout).toContain(
        "Waiting for the systemd service to connect",
      );

      const unit = readFileSync(
        container
          ? join(
              fixture.homeDir,
              ".config/systemd/user/omnyo-host-daemon-coordinator-example-host-test.service",
            )
          : join(
              fixture.dataDir,
              "systemd/omnyo-host-daemon-coordinator-example-host-test.service",
            ),
        "utf8",
      );

      const selectedPort = readFileSync(
        join(fixture.dataDir, "host-daemon-port"),
        "utf8",
      ).trim();

      expect(unit).toContain(
        `host-daemon --auto-update --host-daemon-port "${selectedPort}" --server-url "https://coordinator.example"`,
      );
      expect(unit).toContain(
        `Environment="OMNYO_APP_NPM_PREFIX=${realpathSync(fixture.dataDir)}/npm"`,
      );
      expect(unit).toContain(
        container ? "WantedBy=default.target" : "WantedBy=multi-user.target",
      );

      const enableUnit = container
        ? "omnyo-host-daemon-coordinator-example-host-test.service"
        : join(
            realpathSync(fixture.dataDir),
            "systemd/omnyo-host-daemon-coordinator-example-host-test.service",
          );

      expect(readFileSync(join(fixture.dataDir, "systemctl.log"), "utf8")).toBe(
        `${container ? "--user show-environment\n" : ""}${scope} daemon-reload\n${scope} enable ${enableUnit}\n${scope} start omnyo-host-daemon-coordinator-example-host-test.service\n`,
      );
    },
  );

  it("refuses replacing a V1 systemd owner", () => {
    const fixture = createFixture();
    writeJoinedState(fixture);
    writeServerInstallTools(fixture, 200);
    writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");

    const service = join(
      fixture.homeDir,
      ".config/systemd/user",
      "bb-host-daemon-recorded-owner.service",
    );

    mkdirSync(dirname(service), { recursive: true });

    const bytes =
      '[Service]\nEnvironment="BB_DATA_DIR=' + fixture.dataDir + '"\n';

    writeFileSync(service, bytes);
    const auth = readFileSync(join(fixture.dataDir, "auth.json"));
    const config = readFileSync(join(fixture.dataDir, "config.json"));
    const effects = join(fixture.binDir, "service-effects");

    for (const tool of ["launchctl", "systemctl"])
      writeExecutable(
        join(fixture.binDir, tool),
        "#!/bin/sh\nprintf '%s\\n' \"$*\" >>'" + effects + "'\nexit 0\n",
      );

    const result = runScript(BOOTSTRAP_ARGS, fixture, {
      OMNYO_INSTALL_SKIP_SERVICE: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("already has an owner");
    expect(readFileSync(service, "utf8")).toBe(bytes);
    expect(readFileSync(join(fixture.dataDir, "auth.json"))).toEqual(auth);
    expect(readFileSync(join(fixture.dataDir, "config.json"))).toEqual(config);
    expect(existsSync(effects)).toBe(false);
    expect(existsSync(join(fixture.binDir, "npm.log"))).toBe(false);
  });
});

describeOnPosix("installer admission", () => {
  it.each([
    "legacy database",
    "migration pointer",
    "maintenance hold",
    "existing service",
    "alias service",
  ])(
    "refuses %s before installer writes or launches a second owner",
    (kind) => {
      const fixture = createFixture();
      const requestLog = join(fixture.binDir, "effects");
      writeExecutable(join(fixture.binDir, "uname"), "#!/bin/sh\necho Linux\n");

      for (const command of ["curl", "npm", "systemctl", "launchctl"]) {
        writeExecutable(
          join(fixture.binDir, command),
          `#!/bin/sh\nprintf '%s\\n' '${command}' >>'${requestLog}'\nexit 1\n`,
        );
      }

      const protectedFile =
        kind === "legacy database"
          ? join(fixture.dataDir, "bb.db")
          : kind === "migration pointer"
            ? join(fixture.dataDir, "config.json")
            : kind === "maintenance hold"
              ? join(fixture.dataDir, "server-maintenance-hold.json")
              : join(fixture.homeDir, ".config/systemd/user/owned.service");

      mkdirSync(dirname(protectedFile), { recursive: true });

      const bytes =
        kind === "migration pointer"
          ? JSON.stringify({
              serverUrl: "http://127.0.0.1:1",
              stateMigration: {},
            })
          : kind.includes("service")
            ? `Environment="OMNYO_DATA_DIR=${kind === "alias service" ? fixture.dataDir.replace(/^\/private\//u, "/") : fixture.dataDir}"\n`
            : "preserved owner bytes";

      writeFileSync(protectedFile, bytes);
      const before = readdirSync(fixture.dataDir).sort();

      const result = runScript(BOOTSTRAP_ARGS, fixture, {
        OMNYO_INSTALL_SKIP_SERVICE: "1",
      });

      expect(result.status).not.toBe(0);

      const reason =
        kind === "legacy database"
          ? "existing database"
          : kind === "migration pointer"
            ? "cannot be reused"
            : kind === "maintenance hold"
              ? "maintenance hold"
              : "already has an owner";

      expect(result.stderr).toContain(reason);
      expect(readFileSync(protectedFile, "utf8")).toBe(bytes);
      expect(readdirSync(fixture.dataDir).sort()).toEqual(before);
      expect(existsSync(join(fixture.homeDir, ".local"))).toBe(false);
      expect(existsSync(requestLog)).toBe(false);
    },
  );
});

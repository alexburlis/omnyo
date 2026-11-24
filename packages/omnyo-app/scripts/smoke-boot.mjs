import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const launcherEntry = join(packageRoot, "dist", "omnyo-app.js");

const cliEntry = join(packageRoot, "dist", "omnyo.js");

const EXPECTED_DISABLED_BUILTIN_PLUGINS = ["provider-acp", "resources"];

const EXPECTED_RUNNING_BUILTIN_PLUGINS = [
  "automations",
  "environment-git-worktree",
  "environment-project-checkout",
  "glance",
  "provider-claude-code",
  "provider-codex",
  "secrets",
];

const HEALTH_TIMEOUT_MS = 120_000;

const PLUGIN_LOAD_TIMEOUT_MS = 120_000;

const POLL_INTERVAL_MS = 500;

const STOP_TIMEOUT_MS = 15_000;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function reserveFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Expected a TCP address with a port"));

        return;
      }

      server.close(() => resolvePort(address.port));
    });
  });
}

async function isHealthy(serverUrl) {
  try {
    const response = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(2_000),
    });

    return response.ok && (await response.json()).ok === true;
  } catch {
    return false;
  }
}

async function runCli(args, env) {
  const { stdout } = await execFileAsync(
    process.execPath,
    [cliEntry, ...args],
    {
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  );

  return stdout;
}

async function waitForBuiltinPlugins(cliEnv) {
  const deadline = Date.now() + PLUGIN_LOAD_TIMEOUT_MS;
  let lastSummary = "no plugin list output yet";

  while (Date.now() <= deadline) {
    const plugins =
      JSON.parse(await runCli(["plugin", "list", "--json"], cliEnv)).plugins ??
      [];

    const failed = plugins.filter(
      (plugin) =>
        plugin.status === "error" && plugin.statusDetail !== "not loaded",
    );

    if (failed.length > 0) {
      throw new Error(
        `Builtin plugins failed to load:\n${failed
          .map((plugin) => `- ${plugin.id}: ${plugin.statusDetail}`)
          .join("\n")}`,
      );
    }

    const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));

    const unexpectedlyEnabled = EXPECTED_DISABLED_BUILTIN_PLUGINS.filter(
      (id) => {
        const plugin = byId.get(id);

        return (
          plugin !== undefined &&
          (plugin.enabled !== false || plugin.status !== "disabled")
        );
      },
    );

    if (unexpectedlyEnabled.length > 0) {
      throw new Error(
        `Retired plugins must remain disabled: ${unexpectedlyEnabled.join(", ")}`,
      );
    }

    const pending = EXPECTED_RUNNING_BUILTIN_PLUGINS.filter(
      (id) => byId.get(id)?.status !== "running",
    );

    if (pending.length === 0) {
      return plugins.length;
    }

    lastSummary = pending
      .map((id) => `${id}=${byId.get(id)?.status ?? "missing"}`)
      .join(", ");
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for builtin plugins: ${lastSummary}`);
}

async function stopProcessTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));

  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    }).catch(() => undefined);
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }

  let timer;

  try {
    await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("omnyo-app did not exit after it was stopped")),
          STOP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createIsolatedHomeEnv(home) {
  const homeEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
  };

  for (const directory of Object.values(homeEnv)) {
    await mkdir(directory, { recursive: true });
  }

  return homeEnv;
}

async function removeDirectory(directory) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });

      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }

      await delay(250);
    }
  }
}

const dataDir = await mkdtemp(join(tmpdir(), "omnyo-app-boot-smoke-"));

const homeDir = await mkdtemp(join(tmpdir(), "omnyo-app-boot-smoke-home-"));

const homeEnv = await createIsolatedHomeEnv(homeDir);

const serverPort = await reserveFreePort();

const daemonPort = await reserveFreePort();

const serverUrl = `http://127.0.0.1:${serverPort}`;

const cliEnv = {
  OMNYO_DATA_DIR: dataDir,
  OMNYO_HOST_DAEMON_PORT: String(daemonPort),
  OMNYO_SENTRY_DSN: "",
  OMNYO_SERVER_URL: serverUrl,
  OMNYO_TELEMETRY: "false",
  OMNYO_VAULT_KEY_STORE: "key-file",
};

let output = "";

const launcher = spawn(
  process.execPath,
  [
    launcherEntry,
    "--data-dir",
    dataDir,
    "--server-port",
    String(serverPort),
    "--host-daemon-port",
    String(daemonPort),
    "--bundled",
  ],
  {
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      ...homeEnv,
      OMNYO_SENTRY_DSN: "",
      OMNYO_TELEMETRY: "false",
      OMNYO_VAULT_KEY_STORE: "key-file",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  },
);

launcher.stdout.on("data", (chunk) => (output += chunk.toString("utf8")));

launcher.stderr.on("data", (chunk) => (output += chunk.toString("utf8")));

try {
  const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (!(await isHealthy(serverUrl))) {
    if (launcher.exitCode !== null) {
      throw new Error(
        `omnyo-app exited with ${launcher.exitCode} before /health`,
      );
    }

    if (Date.now() > healthDeadline) {
      throw new Error("Timed out waiting for the Omnyo server /health");
    }

    await delay(POLL_INTERVAL_MS);
  }

  process.stdout.write(
    `omnyo-app boot smoke: server healthy at ${serverUrl}\n`,
  );

  const status = await runCli(["status"], cliEnv);

  if (!status.includes(dataDir)) {
    throw new Error(`omnyo status did not report the data dir:\n${status}`);
  }

  process.stdout.write(
    "omnyo-app boot smoke: bundled Omnyo CLI answered status\n",
  );

  const pluginCount = await waitForBuiltinPlugins(cliEnv);
  process.stdout.write(
    `omnyo-app boot smoke: ${pluginCount} plugins listed, expected builtins running\n`,
  );

  const hostDeadline = Date.now() + HEALTH_TIMEOUT_MS;

  while (true) {
    const hosts = JSON.parse(
      await runCli(["machine", "list", "--json"], cliEnv),
    );

    if (hosts.length === 1 && hosts[0].status === "connected") break;

    if (
      hosts.length > 1 ||
      Date.now() > hostDeadline ||
      launcher.exitCode !== null
    ) {
      throw new Error(
        `Expected one connected machine, got ${JSON.stringify(hosts)}`,
      );
    }

    await delay(POLL_INTERVAL_MS);
  }

  process.stdout.write("omnyo-app boot smoke: host daemon connected\n");
} catch (error) {
  process.stderr.write(`omnyo-app output:\n${output}\n`);
  throw error;
} finally {
  await stopProcessTree(launcher);
  await Promise.all([removeDirectory(dataDir), removeDirectory(homeDir)]);
}

if (await isHealthy(serverUrl)) {
  throw new Error(
    "The Omnyo server kept answering after omnyo-app was stopped",
  );
}

process.stdout.write("omnyo-app boot smoke: passed\n");

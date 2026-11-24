import { execFile, fork, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import {
  HOST_ID_FILE_NAME,
  HOST_DAEMON_PROTOCOL_VERSION,
} from "@omnyo/host-daemon-contract";
import type { ServerMoveProgressMessage } from "@omnyo/host-daemon-contract";
import {
  writeServerArchive,
  writeServerMovedFile,
} from "@omnyo/server-archive";
import { afterEach, vi } from "vitest";
import type { CommandOf } from "../command-dispatch-support.js";
import {
  createDefaultPendingServerLauncher,
  type PendingServerLaunchRequest,
} from "./pending-server.js";
import { ServerMoveService, type ServerMoveServiceOptions } from "./service.js";
import {
  defaultDetachedProcessSpawner,
  type DetachedSpawnRequest,
} from "./service-manager.js";

const roots: string[] = [];

const httpServers: Server[] = [];

const spawnedPids: number[] = [];

const spawnedChildren: ChildProcess[] = [];

export const MOVE_ID = "move-0001";

export const ACTIVATION_TOKEN = "activation-token-0123456789";

export const HOST_KEY = "host-key-target";

export const PARENT_PID = 424_242;

export const LAUNCHER_ENTRY_PATH = "/opt/npm/bin/omnyo-app";

export const lastMove = {
  moveId: MOVE_ID,
  fromHostId: "host-source",
  fromHostName: "laptop",
  toHostId: "host-target",
  toHostName: "studio",
  completedAt: 1_700_000_100_000,
  oldCopyDeletedAt: null,
};

const STUB_PENDING_SERVER = `
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
const [dataDir = process.env.OMNYO_DATA_DIR, port = process.env.OMNYO_SERVER_PORT] = process.argv.slice(2);
const importFile = JSON.parse(readFileSync(join(dataDir, "server-import.json"), "utf8"));
const server = createServer((request, response) => {
  const identityPath = join(dataDir, "pending-identity.json");
  const identity = existsSync(identityPath) ? JSON.parse(readFileSync(identityPath, "utf8")) : {};
  response.setHeader("content-type", "application/json");
  if (request.url === "/api/v1/server/maintenance") {
    response.end(JSON.stringify({contractVersion:1,runtime:{runtimeId:"inert-pending",processId:process.pid,parentProcessId:process.ppid,launchId:process.env.OMNYO_SERVER_LAUNCH_ID??null,dataDir,serverHostId:"host-target",appVersion:"1.0.0",protocolVersion:${HOST_DAEMON_PROTOCOL_VERSION},...identity.runtime},hold:JSON.parse(readFileSync(join(dataDir,"server-maintenance-hold.json"),"utf8")),activity:{runningThreads:0,pendingInteractions:0,hostRpcs:0,provisioning:0,queuedDispatches:0,pluginLoads:0,pluginInvocations:0,hungServices:0}}));
    return;
  }
  if (request.url === "/health") {
    response.end(JSON.stringify({ ok: true, serverMove: { state: "pending", moveId: identity.moveId ?? importFile.moveId } }));
    return;
  }
  if (request.url === "/internal/server-move/pending") {
    response.end(JSON.stringify({ moveId: importFile.moveId, verified: existsSync(join(dataDir, "app.db")), message: null }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});
if (process.send) {
  process.once("message", (_message, handle) => {
    server.listen(handle, () => process.send("listening"));
  });
  process.send("ready-for-handle");
} else {
  server.listen(Number(port), "127.0.0.1");
}
process.on("SIGTERM", () => process.exit(0));
`;

export function registerServerMoveFixtureCleanup(): void {
  afterEach(async () => {
    await Promise.all(
      spawnedChildren.splice(0).map(async (child) => {
        if (
          child.pid === undefined ||
          child.exitCode !== null ||
          child.signalCode !== null
        )
          return;
        await new Promise<void>((resolveExit) => {
          child.once("exit", () => resolveExit());
          child.kill("SIGKILL");
        });
      }),
    );

    for (const pid of spawnedPids.splice(0)) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }

    await Promise.all(
      httpServers
        .splice(0)
        .map(
          (server) =>
            new Promise<void>((resolveClose) =>
              server.close(() => resolveClose()),
            ),
        ),
    );
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });
}

export async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omnyo-server-move-test-"));
  roots.push(root);

  return root;
}

export async function writeFileWithDirs(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; port: number }> {
  const server = createServer(handler);
  httpServers.push(server);
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, port };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));

  return port;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

interface SourceServer {
  archiveSha256: string;
  archiveSizeBytes: number;
  omnyoAppSha256: string;
  omnyoAppSizeBytes: number;
  archiveRequests: IncomingMessage[];
  url: string;
}

async function createSourceServer(root: string): Promise<SourceServer> {
  const sourceDir = join(root, "source-data");
  await writeFileWithDirs(join(sourceDir, "app.db"), "sqlite database bytes");
  await writeFileWithDirs(
    join(sourceDir, "config.json"),
    JSON.stringify({
      config: { OMNYO_LOG_LEVEL: "info" },
      serverUrl: "https://omnyo.example.test",
      serverHeaders: { "x-omnyo-connect-machine": "bbcm_source" },
    }),
  );
  await writeFileWithDirs(
    join(sourceDir, "attachments", "project", "a.txt"),
    "attachment",
  );
  await writeFileWithDirs(
    join(sourceDir, "plugins", "tasks", "data.db"),
    "tasks database",
  );
  const archivePath = join(root, "server-archive.tar.gz");

  const archive = await writeServerArchive({
    outPath: archivePath,
    files: [
      "app.db",
      "config.json",
      "attachments/project/a.txt",
      "plugins/tasks/data.db",
    ].map((archivePathEntry) => ({
      sourcePath: join(sourceDir, ...archivePathEntry.split("/")),
      archivePath: archivePathEntry,
    })),
    manifest: {
      createdAt: 1_700_000_000_000,
      appVersion: "1.0.0",
      protocolVersion: 209,
      migrationCount: 10,
      sourceDataDir: "/Users/me/.omnyo",
      sourceServerHostId: "host-source",
      serverMoveExperiment: true,
    },
  });

  const omnyoAppPath = join(root, "omnyo-app.tgz");
  await writeFile(omnyoAppPath, "full omnyo-app package");
  const omnyoAppBytes = await readFile(omnyoAppPath);
  const archiveRequests: IncomingMessage[] = [];

  const { url } = await listen((request, response) => {
    if (request.headers.authorization !== `Bearer ${HOST_KEY}`) {
      response.statusCode = 401;
      response.end();

      return;
    }

    if (request.url === `/internal/server-move/${MOVE_ID}/archive`) {
      archiveRequests.push(request);
      response.setHeader("content-length", String(archive.sizeBytes));
      createReadStream(archivePath).pipe(response);

      return;
    }

    if (request.url === `/internal/server-move/${MOVE_ID}/app-runtime.tgz`) {
      response.write(omnyoAppBytes);
      response.end();

      return;
    }

    response.statusCode = 404;
    response.end();
  });

  return {
    archiveSha256: archive.sha256,
    archiveSizeBytes: archive.sizeBytes,
    omnyoAppSha256: createHash("sha256").update(omnyoAppBytes).digest("hex"),
    omnyoAppSizeBytes: omnyoAppBytes.byteLength,
    archiveRequests,
    url,
  };
}

async function createPackageRoot(root: string): Promise<string> {
  const packageRoot = join(root, "npm", "lib", "node_modules", "omnyo-app");
  await writeFileWithDirs(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "omnyo-app", version: "1.0.0" }),
  );

  for (const file of [
    "host-daemon/dist/daemon-bundle.mjs",
    "dist/omnyo-app.js",
    "dist/omnyo-server.js",
    "server/dist/index.js",
    "app/dist/index.html",
  ]) {
    await writeFileWithDirs(join(packageRoot, ...file.split("/")), "");
  }

  await writeFileWithDirs(join(root, "npm", "bin", "omnyo-app"), "");

  return packageRoot;
}

export const launcherProcessOps: ServerMoveServiceOptions["processOps"] = {
  isRunning: (pid) => pid === process.pid,
  readIdentity: async (pid) =>
    pid === process.pid
      ? { command: `node ${LAUNCHER_ENTRY_PATH} start`, startedAt: null }
      : null,
};

export async function writeLauncherMovedMode(args: {
  dataDir: string;
  serverPort: number;
  oldCopyEntries?: string[];
}): Promise<void> {
  await writeServerMovedFile(args.dataDir, {
    version: 1,
    moveId: "move-away",
    movedAt: 1_700_000_000_000,
    fromHostId: "host-target",
    toHostId: "host-other",
    toHostName: "other",
    serverUrl: "http://other.example.test:38886",
    mode: "direct",
    connectHandle: null,
    oldCopyEntries: args.oldCopyEntries ?? [],
  });
  await writeOmnyoAppRuntime({
    dataDir: args.dataDir,
    serverPort: args.serverPort,
  });
}

export async function writeOmnyoAppRuntime(args: {
  dataDir: string;
  serverPort: number;
}): Promise<void> {
  await writeFileWithDirs(
    join(args.dataDir, "app-runtime.json"),
    JSON.stringify({
      entryPath: LAUNCHER_ENTRY_PATH,
      pid: process.pid,
      surface: "web",
      serverUrl: `http://127.0.0.1:${args.serverPort}`,
      startedAt: new Date().toISOString(),
      version: "1.0.0",
    }),
  );
}

export async function writeSystemdUnit(args: {
  homeDir: string;
  dataDir: string;
  execStart: string;
}): Promise<string> {
  const unitPath = join(
    args.homeDir,
    ".config",
    "systemd",
    "user",
    "omnyo-host-daemon-old-server-studio.service",
  );

  await writeFileWithDirs(
    unitPath,
    [
      "[Service]",
      `ExecStart=${args.execStart}`,
      'Environment="OMNYO_APP_NPM_PREFIX=/opt/npm"',
      `Environment="OMNYO_DATA_DIR=${args.dataDir.replaceAll("\\", "\\\\")}"`,
      "Restart=always",
      "",
    ].join("\n"),
  );

  return unitPath;
}

export interface FixtureArgs {
  getDirectAccessActivity?: ServerMoveServiceOptions["getDirectAccessActivity"];
  env?: NodeJS.ProcessEnv;
  serverUrl?: string;
  autoUpdate?: boolean;
  supervised?: boolean;
  hostDaemonPort?: number | null;
  installOmnyoApp?: ServerMoveServiceOptions["installOmnyoApp"];
  checkPortAvailable?: ServerMoveServiceOptions["checkPortAvailable"];
  processOps?: ServerMoveServiceOptions["processOps"];
  portReleaseTimeoutMs?: number;
  packagedPendingServer?: boolean;
}

export async function createFixture(args: FixtureArgs = {}) {
  const root = await createRoot();
  const homeDir = join(root, "home");
  const dataDir = join(homeDir, ".omnyo-machines", "old-server");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, HOST_ID_FILE_NAME), "host-target\n");
  const packageRoot = await createPackageRoot(root);
  const stubPath = join(root, "pending-server.mjs");
  await writeFile(stubPath, STUB_PENDING_SERVER);

  if (args.packagedPendingServer) {
    const packageSource = fileURLToPath(
      new URL("../../../../packages/omnyo-app/", import.meta.url),
    );

    await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../../../scripts/build-node-entry.mjs", import.meta.url),
        ),
        join(packageSource, "src", "bin", "omnyo-server.ts"),
        join(packageRoot, "dist", "omnyo-server.js"),
      ],
      { cwd: packageSource },
    );
    await symlink(
      join(packageSource, "node_modules"),
      join(packageRoot, "node_modules"),
      "dir",
    );
    await writeFile(
      join(packageRoot, "server", "dist", "index.js"),
      STUB_PENDING_SERVER,
    );

    for (const file of [
      "omnyo",
      "omnyo-chunks/fixture.js",
      "omnyo-provider-bridge-worker.mjs",
      "omnyo-parcel-watcher-child.mjs",
      "omnyo-plugin-host-worker.mjs",
      "omnyo-file-search-worker.mjs",
      "omnyo-process-launcher-worker.mjs",
      "omnyo-workspace-observer-child.mjs",
      "omnyo-workspace-read-child.mjs",
    ]) {
      await writeFileWithDirs(
        join(packageRoot, "host-daemon", "dist", file),
        "",
      );
    }
  }

  const source = await createSourceServer(root);
  const session = { open: false };
  const progress: ServerMoveProgressMessage[] = [];
  const shutdownRequests: Array<[string, 0 | 1]> = [];
  const detachedRequests: DetachedSpawnRequest[] = [];
  const commands: string[][] = [];
  const launches: PendingServerLaunchRequest[] = [];
  const reservedPorts = new Map<number, Server>();

  const reserveServerPort = async (): Promise<number> => {
    const server = createServer();
    httpServers.push(server);
    await new Promise<void>((resolveListen) =>
      server.listen(0, "127.0.0.1", resolveListen),
    );
    const { port } = server.address() as AddressInfo;
    reservedPorts.set(port, server);

    return port;
  };

  const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };

  const options: ServerMoveServiceOptions = {
    getDirectAccessActivity: args.getDirectAccessActivity,
    dataDir,
    homeDir,
    hostId: "host-target",
    instanceId: "instance-host-target",
    getServerSessionId: () => (session.open ? "session-host-target" : null),
    serverUrl: args.serverUrl ?? source.url,
    hostKey: HOST_KEY,
    serverHeaders: { "x-test-access": "opaque" },
    hostDaemonPort:
      args.hostDaemonPort === undefined ? 38_887 : args.hostDaemonPort,
    autoUpdate: args.autoUpdate ?? false,
    supervised: args.supervised ?? false,
    env: args.env ?? { OMNYO_SERVER_MOVE_SERVICE_MANAGER: "none" },
    platform: "linux",
    uid: 1000,
    parentPid: PARENT_PID,
    daemonEntryPath: join(
      packageRoot,
      "host-daemon",
      "dist",
      "daemon-bundle.mjs",
    ),
    logger,
    fetchFn: fetch,
    now: Date.now,
    sleep: (ms) => sleep(ms),
    runCommand: async (command, commandArgs) => {
      commands.push([command, ...commandArgs]);
    },
    spawnDetached: async (request) => {
      detachedRequests.push(request);

      return 999_999;
    },
    launchPendingServer: async (request) => {
      launches.push(request);
      const reservation = reservedPorts.get(request.serverPort);

      if (args.packagedPendingServer) {
        if (reservation !== undefined) {
          await new Promise<void>((resolveClose) =>
            reservation.close(() => resolveClose()),
          );
          reservedPorts.delete(request.serverPort);
        }

        const pid = await createDefaultPendingServerLauncher(
          defaultDetachedProcessSpawner,
        )(request);

        spawnedPids.push(pid);

        return pid;
      }

      if (reservation !== undefined) {
        await mkdir(dirname(request.logPath), { recursive: true });
        const log = openSync(request.logPath, "a", 0o600);
        let child: ChildProcess;
        let ready: Promise<void>;

        try {
          child = fork(
            stubPath,
            [request.dataDir, String(request.serverPort)],
            {
              detached: true,
              env: {
                PATH: process.env.PATH,
                OMNYO_SERVER_LAUNCH_ID: request.env.OMNYO_SERVER_LAUNCH_ID,
              },
              execArgv: [],
              stdio: ["ignore", log, log, "ipc"],
            },
          );
          spawnedChildren.push(child);
          ready = new Promise<void>((resolveReady, rejectReady) => {
            const finish = (error?: Error) => {
              child.off("exit", onExit);
              child.off("error", finish);
              child.off("message", onMessage);

              if (error) rejectReady(error);
              else resolveReady();
            };

            const onExit = () =>
              finish(
                new Error("Pending fixture server exited before listening"),
              );

            const onMessage = (message: unknown) => {
              if (message === "ready-for-handle") {
                child.send("listen", reservation, (error) => {
                  if (error) finish(error);
                });
              } else if (message === "listening") {
                finish();
              }
            };

            child.once("error", finish);
            child.once("exit", onExit);
            child.on("message", onMessage);
          });
        } finally {
          closeSync(log);
        }

        await ready;
        await new Promise<void>((resolveClose) =>
          reservation.close(() => resolveClose()),
        );
        reservedPorts.delete(request.serverPort);
        child.disconnect();
        child.unref();

        if (child.pid === undefined)
          throw new Error("Pending fixture server did not report a pid");

        return child.pid;
      }

      const pid = await defaultDetachedProcessSpawner({
        command: process.execPath,
        args: [stubPath, request.dataDir, String(request.serverPort)],
        env: {
          PATH: process.env.PATH,
          OMNYO_SERVER_LAUNCH_ID: request.env.OMNYO_SERVER_LAUNCH_ID,
        },
        logPath: request.logPath,
      });

      spawnedPids.push(pid);

      return pid;
    },
    installOmnyoApp: args.installOmnyoApp ?? (async () => undefined),
    checkGhAuthenticated: async () => null,
    checkPortAvailable: args.checkPortAvailable ?? (async () => true),
    processOps: args.processOps ?? launcherProcessOps,
    isServerSessionOpen: () => session.open,
    getShellEnv: () => ({}),
    emitProgress: (message) => {
      progress.push(message);
    },
    requestShutdown: async (reason, exitCode) => {
      shutdownRequests.push([reason, exitCode]);
    },
    pendingServerTimeoutMs: 10_000,
    portReleaseTimeoutMs: args.portReleaseTimeoutMs ?? 400,
    activationSessionCloseTimeoutMs: 10_000,
  };

  const createService = (
    overrides: Partial<ServerMoveServiceOptions> = {},
  ): ServerMoveService => new ServerMoveService({ ...options, ...overrides });

  return {
    options,
    root,
    homeDir,
    dataDir,
    packageRoot,
    npmPrefix: join(root, "npm"),
    source,
    session,
    service: createService(),
    createService,
    progress,
    shutdownRequests,
    detachedRequests,
    commands,
    launches,
    reserveServerPort,
    logger,
  };
}

export type Fixture = Awaited<ReturnType<typeof createFixture>>;

export async function prepareCommand(
  fixture: Fixture,
  overrides: Partial<CommandOf<"server_move.prepare">> = {},
): Promise<CommandOf<"server_move.prepare">> {
  return {
    type: "server_move.prepare",
    moveId: MOVE_ID,
    activationToken: ACTIVATION_TOKEN,
    archive: {
      downloadPath: `/internal/server-move/${MOVE_ID}/archive`,
      sha256: fixture.source.archiveSha256,
      sizeBytes: fixture.source.archiveSizeBytes,
    },
    appRuntime: null,
    serverPort: overrides.serverPort ?? (await fixture.reserveServerPort()),
    bindHost: null,
    sourceDataDir: "/Users/me/.omnyo",
    sourceServerHostId: "host-source",
    serverUrl: "https://omnyo.example.test",
    archiveExistingServerData: false,
    ...overrides,
  };
}

export const activateCommand: CommandOf<"server_move.activate"> = {
  type: "server_move.activate",
  moveId: MOVE_ID,
  activationToken: ACTIVATION_TOKEN,
  lastMove,
};

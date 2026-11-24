import { z } from "zod";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { WebSocket } from "ws";
import { runInSerialLane } from "../serial-lane.js";
import {
  readMaintenanceHold,
  writeMaintenanceHold,
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  SERVER_MAINTENANCE_HOLD_FILE_NAME,
} from "@omnyo/server-archive";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { readAppRuntimeFile } from "@omnyo/config/app-runtime-file";
import { resolveCodexHome } from "@omnyo/config/codex-home";
import { isLoopbackHostname } from "@omnyo/config/loopback";
import { createNodeVerifiedProcessOps } from "@omnyo/config/verified-process-stop";
import type { ServerMoveStepId } from "@omnyo/domain";
import type {
  HostDaemonOnlineRpcResult,
  HostPlatform,
  ServerMoveProgressMessage,
} from "@omnyo/host-daemon-contract";
import {
  readProcessIdentity,
  sanitizeInheritedChildProcessEnv,
} from "@omnyo/process-utils";
import {
  archiveExistingServerData,
  discardImportBackups,
  deleteOldServerCopy,
  extractServerArchive,
  installImportedServerFiles,
  readServerImportFile,
  readServerImportJournalStatus,
  readServerMovedFile,
  readLastServerMoveFile,
  removeImportedServerFiles,
  removeServerConnectHoldFile,
  removeServerImportJournalFile,
  rollBackServerImport,
  SERVER_IMPORT_BACKUP_DIR_NAME,
  SERVER_IMPORT_FILE_NAME,
  SERVER_MOVED_FILE_NAME,
  ServerArchiveError,
  writeLastServerMoveFile,
  writeServerImportFile,
} from "@omnyo/server-archive";
import {
  CommandDispatchError,
  ExpectedCommandDispatchError,
  type CommandOf,
} from "../command-dispatch-support.js";
import { resolveHostPlatform } from "../host-platform.js";
import type { HostDaemonLogger } from "../logger.js";
import {
  defaultInstallTarball,
  defaultRunProcess,
} from "../protocol-self-update.js";
import type { FetchFn } from "../server-client.js";
import type { ServerMovedNotice } from "../server-connection-support.js";
import { downloadVerifiedFile } from "./download.js";
import {
  expandHomePath,
  isFileNotFoundError,
  isSameOrInsidePath,
  pathExists,
  removeEmptyDirectory,
  writeFileAtomically,
} from "./fs.js";
import {
  defaultGhAuthenticationCheck,
  defaultPortAvailabilityCheck,
  readDiskFreeBytes,
  readFileSizeBytes,
  type GhAuthenticationCheck,
  type PortAvailabilityCheck,
} from "./host-probes.js";
import {
  detectLauncherMovedMode,
  isLiveOmnyoAppRuntime,
  serverUrlPort,
  type LauncherMovedMode,
  type LauncherProcessOps,
} from "./launcher-runtime.js";
import {
  restoreMachineConnectionConfig,
  rewriteManagedConfigServer,
  switchConfigToLocalServer,
} from "./managed-config.js";
import {
  incomingMoveDir,
  incomingMovesRoot,
  listIncomingMoveIds,
  readIncomingMoveState,
  requireMoveIdSegment,
  writeIncomingMoveState,
  type ActivationPlanKind,
  type IncomingMoveState,
} from "./move-state.js";
import {
  detectUnrecognizedSupervisor,
  normalizeMovedServerUrl,
  tryNormalizeMovedServerUrl,
  validateServerHeaders,
} from "./moved-server.js";
import {
  npmPrefixOmnyoAppRoot,
  readOmnyoAppVersion,
  resolveOmnyoAppLauncherEntry,
  resolveOmnyoServerEntry,
  resolvePackagedOmnyoAppRoot,
} from "./package-layout.js";
import {
  createDefaultPendingServerLauncher,
  createPendingServerEnv,
  isProcessGroupAlive,
  readPendingServerMoveId,
  readPendingServerRuntime,
  readServerMoveHealth,
  SERVER_MOVE_START_FAILED,
  stopProcessGroup,
  waitForPendingServer,
  type PendingServerLauncher,
} from "./pending-server.js";
import {
  buildServerStartArguments,
  findServiceDefinition,
  forcesNoServiceManager,
  formatServiceDefinitionContent,
  isServerStartDefinition,
  readHostDaemonPortArgument,
  replaceServerUrlArgument,
  SERVER_MOVE_SERVICE_MANAGER_ENV,
  writeServiceDefinition,
  type ServiceDefinition,
} from "./service-definition.js";
import {
  defaultDetachedProcessSpawner,
  defaultServerMoveCommandRunner,
  restartService,
  type DetachedProcessSpawner,
  type ServerMoveCommandRunner,
} from "./service-manager.js";

const PENDING_SERVER_TIMEOUT_MS = 3 * 60 * 1000;

const PENDING_SERVER_POLL_INTERVAL_MS = 500;

const PENDING_SERVER_STOP_TIMEOUT_MS = 10_000;

const PORT_RELEASE_TIMEOUT_MS = 15_000;

const PORT_RELEASE_POLL_INTERVAL_MS = 250;

const ACTIVATION_SESSION_CLOSE_TIMEOUT_MS = 90_000;

const SESSION_CLOSE_POLL_INTERVAL_MS = 250;

const PROBE_TIMEOUT_MS = 10_000;

const PROGRESS_INTERVAL_MS = 1_000;

const OMNYO_APP_MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

const SERVER_DATABASE_PATHS = ["app.db", "app.db-wal", "app.db-shm"] as const;

const HOST_ARTIFACT_DIGEST_FILE_NAME = "host-artifact.sha256";

const STANDALONE_DATA_DIR_NAME = ".omnyo";

const SERVER_DATABASE_FILE_NAME = "app.db";

const SERVER_MOVE_LOG_FILE_NAME = "server-move.log";

const INSTALL_DAEMON_PID_FILE_NAME = "install-daemon.pid";

const PENDING_SERVER_LOG_FILE_NAME = "server-move-pending-server.log";

const ARCHIVE_FILE_NAME = "server-archive.tar.gz";

const STAGING_DIR_NAME = "staging";

const ACTIVATION_REJECTED = "server_move_activation_rejected";

type ServerMoveLogger = Pick<HostDaemonLogger, "error" | "info" | "warn">;

interface WorkerActivity {
  commands: number;
  runtimes: number;
  terminals: number;
  pluginHosts: number;
  interactions: number;
}

export type WorkerUpdateScope = "runtime" | "provider";

export interface ServerMoveServiceOptions {
  getDirectAccessActivity?: () => WorkerActivity | null;
  getRuntimeUpdateActivity?: (args: {
    ownerId: string | null;
    scope: WorkerUpdateScope;
  }) => WorkerActivity | null;
  dataDir: string;
  homeDir: string;
  hostId: string;
  instanceId: string;
  serverUrl: string;
  hostKey: string;
  serverHeaders: Record<string, string>;
  hostDaemonPort: number | null;
  autoUpdate: boolean;
  supervised: boolean;
  env: NodeJS.ProcessEnv;
  platform: HostPlatform;
  uid: number;
  parentPid: number;
  daemonEntryPath: string | null;
  logger: ServerMoveLogger;
  fetchFn: FetchFn;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  runCommand: ServerMoveCommandRunner;
  spawnDetached: DetachedProcessSpawner;
  launchPendingServer: PendingServerLauncher;
  installOmnyoApp: (tarballPath: string) => Promise<void>;
  checkGhAuthenticated: GhAuthenticationCheck;
  checkPortAvailable: PortAvailabilityCheck;
  processOps: LauncherProcessOps;
  isServerSessionOpen: () => boolean;
  getServerSessionId?: () => string | null;
  getShellEnv: () => NodeJS.ProcessEnv;
  emitProgress: (message: ServerMoveProgressMessage) => void;
  requestShutdown: (reason: string, exitCode: 0 | 1) => Promise<void>;
  pendingServerTimeoutMs: number;
  portReleaseTimeoutMs: number;
  activationSessionCloseTimeoutMs: number;
}

export function defaultServerMoveServiceOptions() {
  return {
    homeDir: homedir(),
    env: process.env,
    platform: resolveHostPlatform(),
    uid: process.getuid?.() ?? 0,
    parentPid: process.ppid,
    daemonEntryPath: process.argv[1] ?? null,
    fetchFn: fetch,
    now: Date.now,
    sleep: (ms: number) => sleep(ms),
    runCommand: defaultServerMoveCommandRunner,
    spawnDetached: defaultDetachedProcessSpawner,
    launchPendingServer: createDefaultPendingServerLauncher(
      defaultDetachedProcessSpawner,
    ),
    installOmnyoApp: (tarballPath: string) =>
      defaultInstallTarball(tarballPath, defaultRunProcess),
    checkGhAuthenticated: defaultGhAuthenticationCheck,
    checkPortAvailable: defaultPortAvailabilityCheck,
    processOps: createNodeVerifiedProcessOps(),
    pendingServerTimeoutMs: PENDING_SERVER_TIMEOUT_MS,
    portReleaseTimeoutMs: PORT_RELEASE_TIMEOUT_MS,
    activationSessionCloseTimeoutMs: ACTIVATION_SESSION_CLOSE_TIMEOUT_MS,
  };
}

interface InFlightPrepare {
  activationToken: string;
  controller: AbortController;
  promise: Promise<HostDaemonOnlineRpcResult<"server_move.prepare">>;
}

interface RunningActivation {
  moveId: string;
  promise: Promise<void>;
}

type ActivatingState = IncomingMoveState & {
  activation: NonNullable<IncomingMoveState["activation"]>;
};

type ActivationPlan =
  | { kind: "launcher" }
  | {
      kind: "service";
      definition: ServiceDefinition;
      programArguments: string[];
    }
  | { kind: "replacement"; programArguments: string[] };

function tokensEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizePrepareError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) {
    return new ExpectedCommandDispatchError(
      "server_move_cancelled",
      "The server move was cancelled",
    );
  }

  if (error instanceof ServerArchiveError) {
    return new CommandDispatchError(
      `server_move_archive_${error.code}`,
      error.message,
    );
  }

  return error instanceof Error ? error : new Error(String(error));
}

function isActivatingState(state: IncomingMoveState): state is ActivatingState {
  return state.activation !== null;
}

function rejectActivation(message: string): ExpectedCommandDispatchError {
  return new ExpectedCommandDispatchError(ACTIVATION_REJECTED, message);
}

function sameArguments(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export class ServerMoveService {
  private readonly inFlightPrepares = new Map<string, InFlightPrepare>();
  private activation: RunningActivation | null = null;
  private serverMovedLane: Promise<void> = Promise.resolve();
  private switchedToMovedServer = false;

  private readonly fencingMoves = new Set<string>();
  private readonly moveLifecycleLanes = new Map<string, Promise<void>>();
  private fencePath(moveId: string): string {
    return join(
      this.options.dataDir,
      "server-move-fences",
      `${requireMoveIdSegment(moveId)}.json`,
    );
  }
  private async assertNotFenced(moveId: string): Promise<void> {
    if (this.fencingMoves.has(moveId) || (await this.hasFence(moveId)))
      throw new ExpectedCommandDispatchError(
        "server_move_fenced",
        `Server move ${moveId} is fenced`,
      );
  }
  private async hasFence(moveId: string): Promise<boolean> {
    try {
      await stat(this.fencePath(moveId));

      return true;
    } catch (error) {
      if (isFileNotFoundError(error)) return false;
      throw error;
    }
  }
  constructor(private readonly options: ServerMoveServiceOptions) {}

  private directProbe: {
    challenge: string;
    coordinatorInstanceId: string;
    sessionId: string | null;
    committed: boolean;
  } | null = null;
  private runtimeUpdateHeld = false;
  private runtimeUpdateOwner: string | null = null;
  runtimeUpdateStatus(scope: WorkerUpdateScope = "runtime") {
    const activity =
      this.options.getRuntimeUpdateActivity?.({
        ownerId: this.runtimeUpdateOwner,
        scope,
      }) ?? null;

    const blockers: string[] = [];

    if (this.runtimeUpdateHeld) blockers.push("update_held");

    if (this.directProbe !== null) blockers.push("direct_probe");

    if (this.activation !== null) blockers.push("activation");

    if (activity === null) blockers.push("activity_unknown");
    else {
      for (const [kind, count] of Object.entries(activity)) {
        if (
          !Number.isSafeInteger(count) ||
          count < 0 ||
          (count !== 0 &&
            !(
              scope === "provider" &&
              (kind === "terminals" || kind === "pluginHosts")
            ))
        )
          blockers.push(kind);
      }
    }

    return {
      activity,
      held: this.runtimeUpdateHeld,
      holdOwner: this.runtimeUpdateOwner,
      directProbe: this.directProbe !== null,
      activation: this.activation !== null,
      blockers,
    };
  }
  tryAcquireRuntimeUpdateHold(
    ownCommands = 0,
    ownerId: string | null = null,
  ): boolean {
    return this.tryAcquireUpdateHold("runtime", ownCommands, ownerId);
  }
  tryAcquireProviderUpdateHold(
    ownCommands = 0,
    ownerId: string | null = null,
  ): boolean {
    return this.tryAcquireUpdateHold("provider", ownCommands, ownerId);
  }
  private tryAcquireUpdateHold(
    scope: WorkerUpdateScope,
    ownCommands: number,
    ownerId: string | null,
  ): boolean {
    if (ownCommands !== 0 && ownCommands !== 1) return false;

    const sameOwner =
      this.runtimeUpdateHeld &&
      ownerId !== null &&
      this.runtimeUpdateOwner === ownerId;

    if (
      (this.runtimeUpdateHeld && !sameOwner) ||
      this.directProbe !== null ||
      this.activation !== null
    )
      return false;
    const wasHeld = this.runtimeUpdateHeld;
    this.runtimeUpdateHeld = true;

    const counts =
      this.options.getRuntimeUpdateActivity?.({ ownerId, scope }) ?? null;

    if (
      counts === null ||
      Object.entries(counts).some(
        ([kind, count]) =>
          !Number.isSafeInteger(count) ||
          count < 0 ||
          (!(
            scope === "provider" &&
            (kind === "terminals" || kind === "pluginHosts")
          ) &&
            count !== (kind === "commands" ? ownCommands : 0)),
      )
    ) {
      this.runtimeUpdateHeld = wasHeld;

      return false;
    }

    this.runtimeUpdateOwner = ownerId;

    return true;
  }
  restoreRuntimeUpdateHold(ownerId: string): boolean {
    if (this.runtimeUpdateHeld && this.runtimeUpdateOwner !== ownerId)
      return false;
    this.runtimeUpdateHeld = true;
    this.runtimeUpdateOwner = ownerId;

    return true;
  }
  releaseRuntimeUpdateHold(ownerId: string | null = null): void {
    if (this.runtimeUpdateHeld && this.runtimeUpdateOwner !== ownerId)
      throw new ExpectedCommandDispatchError(
        "runtime_update_owner_mismatch",
        "Runtime update ownership does not match",
      );
    this.runtimeUpdateHeld = false;
    this.runtimeUpdateOwner = null;
  }
  assertDirectAccessAdmission(commandType?: string): void {
    if (
      this.runtimeUpdateHeld &&
      commandType !== "runtime_update.acquire" &&
      commandType !== "runtime_update.release" &&
      commandType !== "provider.installation.start" &&
      commandType !== "provider.installation.get"
    )
      throw new ExpectedCommandDispatchError(
        commandType === "provider.installation.run"
          ? "runtime_update_busy"
          : "runtime_update_held",
        "Worker admission is held for a private runtime update",
      );

    if (
      this.directProbe !== null &&
      commandType !== "server_access.inspect_direct_probe" &&
      commandType !== "server_access.probe_direct" &&
      commandType !== "server_access.release_direct_probe"
    )
      throw new ExpectedCommandDispatchError(
        "direct_access_held",
        "Worker admission is held for direct access handoff",
      );
  }
  async inspectDirectProbe(): Promise<
    HostDaemonOnlineRpcResult<"server_access.inspect_direct_probe">
  > {
    const probe = this.directProbe;

    return {
      hostId: this.options.hostId,
      workerInstanceId: this.options.instanceId,
      sessionId: this.options.getServerSessionId?.() ?? null,
      probe:
        probe === null
          ? null
          : {
              phase: probe.committed ? "committed" : "uncommitted",
              ownerFingerprint: createHash("sha256")
                .update(probe.challenge)
                .digest("hex"),
              coordinatorInstanceId: probe.coordinatorInstanceId,
              sessionId: probe.sessionId,
            },
    };
  }
  async probeDirect(
    command: CommandOf<"server_access.probe_direct">,
  ): Promise<{ ok: true }> {
    if (this.directProbe !== null)
      throw new ExpectedCommandDispatchError(
        "direct_access_conflict",
        "A worker handoff is already held",
      );
    this.directProbe = {
      challenge: command.challenge,
      coordinatorInstanceId: command.instanceId,
      sessionId: this.options.getServerSessionId?.() ?? null,
      committed: false,
    };
    const counts = this.options.getDirectAccessActivity?.() ?? null;

    if (
      counts === null ||
      Object.values(counts).some(
        (count) => !Number.isSafeInteger(count) || count < 0 || count > 0,
      )
    ) {
      this.directProbe = null;
      throw new ExpectedCommandDispatchError(
        "direct_access_busy",
        counts === null
          ? "Worker activity is unknown"
          : "Worker owners are busy",
      );
    }

    await this.proveDirectRoute(command);

    return { ok: true };
  }
  async proveCurrentPrimary(
    command: CommandOf<"server_access.prove_current_primary">,
  ): Promise<{ ok: true }> {
    const assertCurrent = () => {
      this.assertDirectAccessAdmission("server_access.prove_current_primary");

      if (
        this.directProbe !== null ||
        this.options.getServerSessionId?.() !== command.expectedSessionId ||
        normalizeMovedServerUrl(this.options.serverUrl) !==
          normalizeMovedServerUrl(command.serverUrl)
      ) {
        throw new ExpectedCommandDispatchError(
          "direct_access_primary_changed",
          "The authenticated primary connection changed",
        );
      }
    };

    assertCurrent();
    await this.proveDirectRoute(command);
    assertCurrent();

    return { ok: true };
  }
  private async proveDirectRoute(
    command:
      | CommandOf<"server_access.probe_direct">
      | CommandOf<"server_access.prove_current_primary">,
  ): Promise<void> {
    const base = new URL(command.serverUrl);

    if (
      !["http:", "https:"].includes(base.protocol) ||
      base.username ||
      base.password
    )
      throw new Error("Invalid direct route");
    const headers = { authorization: "Bearer " + this.options.hostKey };

    const input = {
      challenge: command.challenge,
      instanceId: command.instanceId,
    };

    const response = await this.options.fetchFn(
      new URL(
        "internal/server-access/direct-proof",
        base.href.replace(/\/?$/u, "/"),
      ),
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );

    const receipt = response.ok
      ? z
          .object({
            ok: z.literal(true),
            challenge: z.string(),
            instanceId: z.string(),
          })
          .strict()
          .parse(await response.json())
      : null;

    if (
      !receipt ||
      receipt.ok !== true ||
      receipt.challenge !== command.challenge ||
      receipt.instanceId !== command.instanceId
    )
      throw new Error("Direct HTTP route proof failed");

    const url = new URL(
      "internal/server-access/direct-proof/ws",
      base.href.replace(/\/?$/u, "/"),
    );

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("challenge", command.challenge);
    url.searchParams.set("instanceId", command.instanceId);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers });

      const timer = setTimeout(
        () => finish(new Error("Direct WebSocket proof timed out")),
        PROBE_TIMEOUT_MS,
      );

      let settled = false;

      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.terminate();

        if (error) reject(error);
        else resolve();
      }

      socket.on("error", (error) => finish(error));
      socket.on("close", () =>
        finish(new Error("Direct WebSocket proof closed before receipt")),
      );
      socket.on("message", (data) => {
        try {
          const value = z
            .object({
              ok: z.literal(true),
              challenge: z.string(),
              instanceId: z.string(),
            })
            .strict()
            .parse(JSON.parse(data.toString()));

          finish(
            value.ok === true &&
              value.challenge === command.challenge &&
              value.instanceId === command.instanceId
              ? undefined
              : new Error("Direct WebSocket proof mismatch"),
          );
        } catch {
          finish(new Error("Invalid direct WebSocket proof"));
        }
      });
    });
  }
  async releaseDirectProbe(
    command: CommandOf<"server_access.release_direct_probe">,
  ): Promise<{ ok: true }> {
    if (this.directProbe === null) return { ok: true };

    if (
      this.directProbe.challenge !== command.challenge ||
      this.directProbe.committed
    )
      throw new ExpectedCommandDispatchError(
        "direct_access_owner_mismatch",
        "Direct probe challenge owner does not match or is committed",
      );
    this.directProbe = null;

    return { ok: true };
  }

  async inspect(
    command: CommandOf<"server_move.inspect">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.inspect">> {
    const { dataDir, homeDir } = this.options;
    const shellEnv = this.options.getShellEnv();
    const standaloneDataDir = join(homeDir, STANDALONE_DATA_DIR_NAME);
    const incomingMoveIds = await listIncomingMoveIds(dataDir);
    const staleMoves = await this.listStaleMoves(incomingMoveIds);

    const journalStatus = await readServerImportJournalStatus(dataDir).catch(
      () => null,
    );

    const interruptedImport =
      journalStatus?.kind === "interrupted" ? journalStatus.journal : null;

    const staleImport =
      interruptedImport?.entries.includes(SERVER_DATABASE_FILE_NAME) === true ||
      staleMoves.some(
        (state) =>
          state.importedEntries?.includes(SERVER_DATABASE_FILE_NAME) === true,
      );

    const stalePendingPort = staleMoves.some(
      (state) =>
        state.pendingServer !== null && state.serverPort === command.port,
    );

    const movedMode = await this.detectLauncherMovedMode();

    const standaloneDatabaseSize = (await this.standaloneDataDirIsOwnDataDir())
      ? null
      : await readFileSizeBytes(
          join(standaloneDataDir, SERVER_DATABASE_FILE_NAME),
        );

    const [
      serverEntry,
      coreVersion,
      dataDirHasDatabase,
      oldServerCopyPending,
      importBackupPresent,
      portAvailable,
      ghAuthenticated,
      codexCredentialsPresent,
      pathsExist,
      diskFreeBytes,
    ] = await Promise.all([
      this.resolveServerEntry(),
      readOmnyoAppVersion({
        env: this.options.env,
        packageRoot: resolvePackagedOmnyoAppRoot(this.options.daemonEntryPath),
      }),
      this.dataDirHasDatabase(),
      this.oldServerCopyPending(),
      pathExists(join(dataDir, SERVER_IMPORT_BACKUP_DIR_NAME)),
      stalePendingPort || movedMode?.serverPort === command.port
        ? true
        : this.options.checkPortAvailable(command.port),
      this.options.checkGhAuthenticated(shellEnv),
      pathExists(join(resolveCodexHome(homeDir, shellEnv), "auth.json")),
      Promise.all(
        command.paths.map(
          async (path) =>
            [path, await pathExists(expandHomePath(path, homeDir))] as const,
        ),
      ),
      readDiskFreeBytes(dataDir),
    ]);

    const orphanedImportBackup =
      importBackupPresent &&
      interruptedImport === null &&
      incomingMoveIds.length === 0 &&
      this.inFlightPrepares.size === 0;

    return {
      dataDir,
      platform: this.options.platform,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
      coreVersion,
      serverEntryAvailable: serverEntry !== null,
      existingServerData:
        standaloneDatabaseSize === null
          ? null
          : { path: standaloneDataDir, sizeBytes: standaloneDatabaseSize },
      dataDirHasServerData:
        oldServerCopyPending ||
        orphanedImportBackup ||
        (dataDirHasDatabase && !staleImport),
      portAvailable,
      ghAuthenticated,
      codexCredentialsPresent,
      pathsExist: Object.fromEntries(pathsExist),
      diskFreeBytes,
    };
  }

  async probe(
    command: CommandOf<"server_move.probe">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.probe">> {
    try {
      const health = await readServerMoveHealth({
        fetchFn: this.options.fetchFn,
        serverUrl: command.url,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      if (health?.moveId === command.moveId) {
        return { reachable: true, message: null, state: health.state };
      }

      return {
        reachable: false,
        message:
          health === null
            ? `${command.url} answered, but it is not the new Omnyo server`
            : `${command.url} answered for a different server move`,
        state: null,
      };
    } catch (error) {
      return {
        reachable: false,
        message: `Could not reach ${command.url}: ${errorMessage(error)}`,
        state: null,
      };
    }
  }

  prepare(
    command: CommandOf<"server_move.prepare">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.prepare">> {
    const moveId = requireMoveIdSegment(command.moveId);
    const existing = this.inFlightPrepares.get(moveId);

    if (existing !== undefined) {
      if (!tokensEqual(existing.activationToken, command.activationToken))
        return Promise.reject(
          new ExpectedCommandDispatchError(
            "server_move_rejected",
            "A different token is preparing this move",
          ),
        );

      return existing.promise;
    }

    const controller = new AbortController();

    const promise = this.prepareFresh(command, controller.signal).finally(() =>
      this.inFlightPrepares.delete(moveId),
    );

    this.inFlightPrepares.set(moveId, {
      activationToken: command.activationToken,
      controller,
      promise,
    });

    return promise;
  }
  private async prepareFresh(
    command: CommandOf<"server_move.prepare">,
    signal: AbortSignal,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.prepare">> {
    await this.assertNotFenced(command.moveId);

    if (this.activation !== null || (await this.findActivatingState()) !== null)
      throw new ExpectedCommandDispatchError(
        "server_move_already_activated",
        "A server move already activated on this machine",
      );

    if ([...this.inFlightPrepares.keys()].some((id) => id !== command.moveId))
      throw new ExpectedCommandDispatchError(
        "server_move_busy",
        "A different move is already preparing",
      );

    if (command.archiveExistingServerData) {
      if (await this.standaloneDataDirIsOwnDataDir())
        throw new ExpectedCommandDispatchError(
          "server_move_rejected",
          "The target's own data directory cannot be archived",
        );
      await this.assertStandaloneDataDirNotRunning();
    }

    signal.throwIfAborted();
    const prepared = await this.readPreparedResult(command);

    if (prepared !== null) return prepared;
    await this.abortStaleMoves();
    await this.assertNotFenced(command.moveId);
    signal.throwIfAborted();

    return this.runPrepare(command, signal);
  }

  activate(
    command: CommandOf<"server_move.activate">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.activate">> {
    return runInSerialLane(this.moveLifecycleLanes, command.moveId, () =>
      this.activateOwned(command),
    );
  }
  private async activateOwned(
    command: CommandOf<"server_move.activate">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.activate">> {
    const moveId = requireMoveIdSegment(command.moveId);
    await this.assertNotFenced(moveId);
    const { dataDir } = this.options;
    const state = await readIncomingMoveState(dataDir, moveId);

    if (
      state === null ||
      !tokensEqual(state.activationToken, command.activationToken)
    ) {
      throw rejectActivation(
        `Server move ${moveId} is not prepared on this machine or the activation token does not match`,
      );
    }

    if (isActivatingState(state)) {
      void this.startActivation(state, false);

      return { ok: true };
    }

    const importFile = await readServerImportFile(dataDir).catch(() => null);

    if (
      state.pendingServer === null ||
      state.preparedAt === null ||
      importFile === null ||
      importFile.kind !== "move" ||
      importFile.moveId !== moveId ||
      importFile.activationToken === null ||
      !tokensEqual(importFile.activationToken, command.activationToken)
    ) {
      throw rejectActivation(
        `Server move ${moveId} is not prepared on this machine or the activation token does not match`,
      );
    }

    if (this.activation !== null) {
      throw rejectActivation(
        `Server move ${this.activation.moveId} is already activating on this machine`,
      );
    }

    const plan = await this.planActivation(state, null);

    const activatingState: ActivatingState = {
      ...state,
      activation: {
        lastMove: command.lastMove,
        plan: plan.kind,
        requestedAt: this.options.now(),
      },
    };

    await writeIncomingMoveState(dataDir, activatingState);
    void this.startActivation(activatingState, true);

    return { ok: true };
  }

  abort(
    command: CommandOf<"server_move.abort">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.abort">> {
    this.fencingMoves.add(requireMoveIdSegment(command.moveId));

    return runInSerialLane(this.moveLifecycleLanes, command.moveId, () =>
      this.abortOwned(command),
    );
  }
  private async abortOwned(
    command: CommandOf<"server_move.abort">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.abort">> {
    const moveId = requireMoveIdSegment(command.moveId);

    const alreadyActivated = new ExpectedCommandDispatchError(
      "server_move_already_activated",
      `Server move ${moveId} already activated`,
    );

    if (
      this.activation?.moveId === moveId ||
      (await readLastServerMoveFile(this.options.dataDir))?.moveId === moveId
    ) {
      this.fencingMoves.delete(moveId);
      throw alreadyActivated;
    }

    let state = await readIncomingMoveState(this.options.dataDir, moveId);

    if (state !== null && isActivatingState(state)) {
      this.fencingMoves.delete(moveId);
      throw alreadyActivated;
    }

    await mkdir(dirname(this.fencePath(moveId)), { recursive: true });
    await writeFileAtomically({
      path: this.fencePath(moveId),
      content: JSON.stringify({ version: 1, moveId, phase: "fencing" }),
      mode: 0o600,
    });
    const inFlight = this.inFlightPrepares.get(moveId);

    if (inFlight !== undefined) {
      inFlight.controller.abort();
      await inFlight.promise.catch(() => undefined);
    }

    state = await readIncomingMoveState(this.options.dataDir, moveId);

    if (state !== null) {
      if (isActivatingState(state)) throw alreadyActivated;
      await this.cleanupMove(state);
    } else {
      const imported = await readServerImportFile(this.options.dataDir);
      const held = readMaintenanceHold(this.options.dataDir);

      if (
        imported?.moveId === moveId ||
        (held?.kind === "migration" &&
          held.id === moveId &&
          held.phase !== "released")
      )
        throw new Error(
          "Target ownership is uncertain without its pending process receipt",
        );
    }

    await writeFileAtomically({
      path: this.fencePath(moveId),
      content: JSON.stringify({ version: 1, moveId, phase: "fenced" }),
      mode: 0o600,
    });

    return { ok: true, moveId, fenced: true };
  }

  async deleteOldCopy(): Promise<
    HostDaemonOnlineRpcResult<"server_move.delete_old_copy">
  > {
    const { dataDir } = this.options;
    const marker = await readServerMovedFile(dataDir);

    if (marker === null) {
      return { deleted: false };
    }

    await deleteOldServerCopy(dataDir, marker, (entry) => {
      this.options.logger.warn(
        { entry },
        "Skipping a protected entry while deleting the old server copy",
      );
    });
    this.options.logger.info(
      { moveId: marker.moveId, entries: marker.oldCopyEntries.length },
      "Deleted the old Omnyo server copy",
    );

    return { deleted: true };
  }

  handleServerMoved(notice: ServerMovedNotice): Promise<void> {
    if (
      this.directProbe !== null &&
      notice.headers?.["x-omnyo-direct-proof"] === this.directProbe.challenge
    )
      this.directProbe.committed = true;

    const task = this.serverMovedLane.then(() =>
      this.processServerMoved(notice),
    );

    this.serverMovedLane = task.catch(() => undefined);

    return task;
  }

  async resumeActivation(): Promise<void> {
    if (this.activation !== null) {
      return this.activation.promise;
    }

    const state = await this.findActivatingState();

    if (state === null) {
      return;
    }

    const importFile = await readServerImportFile(this.options.dataDir).catch(
      () => null,
    );

    if (importFile !== null && importFile.moveId !== state.moveId) {
      this.options.logger.error(
        { moveId: state.moveId, importMoveId: importFile.moveId },
        "Not resuming the server move activation: server-import.json belongs to another move",
      );

      return;
    }

    if (importFile === null && this.runsWithActivatedServer(state)) {
      await this.removeIncomingState(state);
      this.options.logger.info(
        { moveId: state.moveId },
        "Finished the server move: this daemon runs next to the activated server",
      );

      return;
    }

    this.options.logger.warn(
      { moveId: state.moveId },
      "Resuming an interrupted server move activation",
    );

    return this.startActivation(state, false);
  }

  private startActivation(
    state: ActivatingState,
    waitForSessionClose: boolean,
  ): Promise<void> {
    if (this.activation !== null) {
      return this.activation.promise;
    }

    const promise = this.runActivation(state, waitForSessionClose).catch(
      (error: unknown) => {
        this.options.logger.error(
          { err: error, moveId: state.moveId },
          "Server move activation failed after the old server committed the move",
        );
      },
    );

    this.activation = { moveId: state.moveId, promise };

    return promise;
  }

  private async runActivation(
    state: ActivatingState,
    waitForSessionClose: boolean,
  ): Promise<void> {
    const { dataDir } = this.options;

    if (waitForSessionClose) {
      await this.waitForServerSessionClose(state.moveId);
    }

    await this.stopPendingServer(state);

    try {
      await this.waitForPortRelease(state.serverPort, null);
    } catch (error) {
      this.options.logger.error(
        { err: error, moveId: state.moveId },
        "The imported server's port did not free up; exiting so the activation resumes on the next start",
      );
      await this.options.requestShutdown("server-move-activation-port-busy", 1);

      return;
    }

    await writeLastServerMoveFile(dataDir, {
      version: 1,
      ...state.activation.lastMove,
    });
    const plan = await this.planActivation(state, state.activation.plan);

    if (
      plan.kind === "service" &&
      !sameArguments(plan.definition.programArguments, plan.programArguments)
    ) {
      await writeServiceDefinition(plan.definition, plan.programArguments);
    }

    await switchConfigToLocalServer({
      dataDir,
      serverUrl: `http://127.0.0.1:${state.serverPort}`,
    });
    await discardImportBackups(dataDir);
    await rm(join(dataDir, SERVER_IMPORT_FILE_NAME), { force: true });
    this.options.logger.info(
      { moveId: state.moveId, plan: plan.kind },
      "Activated the imported Omnyo server; switching this machine to run it",
    );

    if (plan.kind === "launcher") {
      await rm(join(dataDir, SERVER_MOVED_FILE_NAME), { force: true });
      await this.removeIncomingState(state);
      await this.options.requestShutdown("server-move-activated", 0);

      return;
    }

    if (plan.kind === "replacement") {
      await this.spawnReplacement(plan.programArguments);
      await this.removeIncomingState(state);
      await this.options.requestShutdown("server-move-activated", 0);

      return;
    }

    if (
      !(await this.restartThroughServiceManager(
        { ...plan.definition, programArguments: plan.programArguments },
        "server-move-activated",
      ))
    ) {
      return;
    }

    await this.removeIncomingState(state);
  }

  private async planActivation(
    state: IncomingMoveState,
    fixedKind: ActivationPlanKind | null,
  ): Promise<ActivationPlan> {
    const { dataDir } = this.options;

    if (state.runtime !== null) {
      const entry = await this.resolveServerEntry();

      if (
        entry === null ||
        resolve(dirname(entry), "..") !== state.runtime.root
      )
        throw rejectActivation("Prepared runtime root changed");

      const identity = await verifyRuntimeIdentity(
        state.runtime.root,
        await readRuntimeIdentity(state.runtime.root),
      );

      if (
        identity.runtimeSha256 !== state.runtime.sha256 ||
        identity.runtimeVersion !== state.runtime.version ||
        identity.hostDaemonProtocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
      )
        throw rejectActivation("Prepared runtime bytes changed");
    }

    if ((await this.resolveServerEntry()) === null) {
      throw rejectActivation(
        "This machine's Omnyo installation does not include the Omnyo server",
      );
    }

    if (fixedKind === "launcher") {
      return { kind: "launcher" };
    }

    if (fixedKind === null) {
      const movedMode = await this.detectLauncherMovedMode();

      if (movedMode !== null) {
        if (movedMode.serverPort !== state.serverPort) {
          throw rejectActivation(
            `The Omnyo launcher on this machine serves port ${String(movedMode.serverPort)}, but the move expects port ${state.serverPort}`,
          );
        }

        return { kind: "launcher" };
      }
    }

    let definition: ServiceDefinition | null;

    try {
      definition = await this.findServiceDefinition();
    } catch (error) {
      throw rejectActivation(
        `Could not read this machine's Omnyo service definition: ${errorMessage(error)}`,
      );
    }

    if (definition !== null && fixedKind !== "replacement") {
      const hostDaemonPort =
        readHostDaemonPortArgument(definition.programArguments) ??
        this.options.hostDaemonPort;

      if (hostDaemonPort === null) {
        throw rejectActivation("This machine's host daemon port is unknown");
      }

      try {
        const programArguments = buildServerStartArguments(
          definition.programArguments,
          {
            dataDir,
            serverPort: state.serverPort,
            hostDaemonPort,
            bindHost: state.bindHost,
          },
        );

        formatServiceDefinitionContent(definition, programArguments);

        return { kind: "service", definition, programArguments };
      } catch (error) {
        throw rejectActivation(
          `Cannot switch ${definition.path} to run the Omnyo server: ${errorMessage(error)}`,
        );
      }
    }

    if (fixedKind === "service") {
      throw new Error(
        `The Omnyo service definition for ${dataDir} disappeared during activation`,
      );
    }

    if (fixedKind === null) {
      const supervisor = await this.detectUnrecognizedSupervisor();

      if (supervisor !== null) {
        throw rejectActivation(
          `This machine's Omnyo runs under ${supervisor}, but no Omnyo service definition for ${dataDir} was found`,
        );
      }
    }

    if (this.options.hostDaemonPort === null) {
      throw rejectActivation("This machine's host daemon port is unknown");
    }

    const launcherEntry = await this.resolveLauncherEntry();

    if (launcherEntry === null) {
      throw rejectActivation("No omnyo-app launcher was found on this machine");
    }

    return {
      kind: "replacement",
      programArguments: [
        launcherEntry,
        "start",
        "--data-dir",
        dataDir,
        "--server-port",
        String(state.serverPort),
        "--host-daemon-port",
        String(this.options.hostDaemonPort),
        ...(state.bindHost === null
          ? []
          : ["--server-bind-host", state.bindHost]),
      ],
    };
  }

  private async processServerMoved(notice: ServerMovedNotice): Promise<void> {
    if (this.switchedToMovedServer) {
      return;
    }

    const serverUrl = normalizeMovedServerUrl(notice.serverUrl);

    const headers =
      notice.headers === null ? null : validateServerHeaders(notice.headers);

    if (
      this.activation !== null ||
      (await this.findActivatingState()) !== null
    ) {
      this.options.logger.info(
        { serverUrl, source: notice.source },
        "Ignoring a server address change while this machine activates a server move",
      );

      return;
    }

    if (await pathExists(join(this.options.dataDir, SERVER_IMPORT_FILE_NAME))) {
      if (
        notice.source === "session-open" &&
        (await this.trySelfActivation(serverUrl, notice))
      ) {
        return;
      }

      this.options.logger.warn(
        { serverUrl, source: notice.source },
        "Ignoring a server address change while a server move is prepared on this machine",
      );

      return;
    }

    await this.switchToMovedServer(serverUrl, headers);
    this.switchedToMovedServer = true;
  }

  private async trySelfActivation(
    serverUrl: string,
    notice: Extract<ServerMovedNotice, { source: "session-open" }>,
  ): Promise<boolean> {
    const { dataDir } = this.options;
    const importFile = await readServerImportFile(dataDir).catch(() => null);

    if (
      importFile === null ||
      importFile.kind !== "move" ||
      importFile.moveId === null ||
      importFile.activationToken === null ||
      importFile.serverUrl === null ||
      importFile.sourceServerHostId === null ||
      tryNormalizeMovedServerUrl(importFile.serverUrl) !== serverUrl
    ) {
      return false;
    }

    const state = await readIncomingMoveState(dataDir, importFile.moveId).catch(
      () => null,
    );

    if (
      state === null ||
      state.pendingServer === null ||
      state.preparedAt === null ||
      state.activation !== null ||
      !tokensEqual(state.activationToken, importFile.activationToken)
    ) {
      return false;
    }

    let plan: ActivationPlan;

    try {
      plan = await this.planActivation(state, null);
    } catch (error) {
      this.options.logger.error(
        { err: error, moveId: state.moveId },
        "The old Omnyo server moved to this machine, but this machine cannot start the server",
      );

      return true;
    }

    const activatingState: ActivatingState = {
      ...state,
      activation: {
        lastMove: {
          moveId: importFile.moveId,
          fromHostId: importFile.sourceServerHostId,
          fromHostName: importFile.sourceServerHostId,
          toHostId: this.options.hostId,
          toHostName: notice.toHostName,
          completedAt: notice.movedAt,
          oldCopyDeletedAt: null,
        },
        plan: plan.kind,
        requestedAt: this.options.now(),
      },
    };

    await writeIncomingMoveState(dataDir, activatingState);
    this.options.logger.warn(
      { moveId: state.moveId, serverUrl },
      "The old Omnyo server committed the move to this machine without confirming; finishing activation",
    );
    void this.startActivation(activatingState, false);

    return true;
  }

  private emitProgress(
    moveId: string,
    step: ServerMoveStepId,
    message: string,
  ): void {
    this.options.emitProgress({
      type: "server_move.progress",
      moveId,
      step,
      message,
    });
  }

  private logPath(fileName: string): string {
    return join(this.options.dataDir, "logs", fileName);
  }

  private findServiceDefinition(): Promise<ServiceDefinition | null> {
    return findServiceDefinition({
      dataDir: this.options.dataDir,
      homeDir: this.options.homeDir,
      platform: this.options.platform,
      env: this.options.env,
    });
  }

  private detectLauncherMovedMode(): Promise<LauncherMovedMode | null> {
    return detectLauncherMovedMode({
      dataDir: this.options.dataDir,
      processOps: this.options.processOps,
    });
  }

  private detectUnrecognizedSupervisor(): Promise<string | null> {
    return detectUnrecognizedSupervisor({
      env: this.options.env,
      dataDir: this.options.dataDir,
      parentPid: this.options.parentPid,
    });
  }

  private standaloneDataDirIsOwnDataDir(): Promise<boolean> {
    return isSameOrInsidePath(
      this.options.dataDir,
      join(this.options.homeDir, STANDALONE_DATA_DIR_NAME),
    );
  }

  private async assertStandaloneDataDirNotRunning(): Promise<void> {
    const standaloneDataDir = join(
      this.options.homeDir,
      STANDALONE_DATA_DIR_NAME,
    );

    if (
      !(await pathExists(join(standaloneDataDir, SERVER_DATABASE_FILE_NAME)))
    ) {
      return;
    }

    const runtime = await readAppRuntimeFile(standaloneDataDir);

    if (
      runtime === null ||
      !(await isLiveOmnyoAppRuntime(runtime, this.options.processOps))
    ) {
      return;
    }

    throw new ExpectedCommandDispatchError(
      "server_move_rejected",
      `Omnyo is running from ${standaloneDataDir} on this machine (pid ${runtime.pid}). Quit Omnyo there first, then start the move again.`,
    );
  }

  private async dataDirHasDatabase(): Promise<boolean> {
    const present = await Promise.all(
      SERVER_DATABASE_PATHS.map((path) =>
        pathExists(join(this.options.dataDir, path)),
      ),
    );

    return present.some(Boolean);
  }

  private async oldServerCopyPending(): Promise<boolean> {
    const marker = await readServerMovedFile(this.options.dataDir).catch(
      () => null,
    );

    return marker !== null && marker.oldCopyEntries.length > 0;
  }

  private async findActivatingState(): Promise<ActivatingState | null> {
    for (const moveId of await listIncomingMoveIds(this.options.dataDir)) {
      const state = await readIncomingMoveState(
        this.options.dataDir,
        moveId,
      ).catch(() => null);

      if (state !== null && isActivatingState(state)) {
        return state;
      }
    }

    return null;
  }

  private runsWithActivatedServer(state: IncomingMoveState): boolean {
    return (
      this.isLoopbackServerUrl() &&
      serverUrlPort(this.options.serverUrl) === state.serverPort
    );
  }

  private async waitForServerSessionClose(moveId: string): Promise<void> {
    const deadline =
      this.options.now() + this.options.activationSessionCloseTimeoutMs;

    while (this.options.isServerSessionOpen()) {
      if (this.options.now() >= deadline) {
        this.options.logger.warn(
          { moveId },
          "The old server session is still open; continuing the activation",
        );

        return;
      }

      await this.options.sleep(SESSION_CLOSE_POLL_INTERVAL_MS);
    }
  }

  private async waitForPortRelease(
    port: number,
    signal: AbortSignal | null,
  ): Promise<void> {
    const deadline = this.options.now() + this.options.portReleaseTimeoutMs;

    while (true) {
      signal?.throwIfAborted();

      if (await this.options.checkPortAvailable(port)) {
        return;
      }

      if (this.options.now() >= deadline) {
        throw new CommandDispatchError(
          SERVER_MOVE_START_FAILED,
          `Port ${port} is still in use on this machine after ${Math.round(this.options.portReleaseTimeoutMs / 1000)}s. Stop whatever answers on that port (for Omnyo, restart Omnyo on this machine), then start the move again.`,
        );
      }

      await this.options.sleep(PORT_RELEASE_POLL_INTERVAL_MS);
    }
  }

  private async removeIncomingState(state: IncomingMoveState): Promise<void> {
    await rm(incomingMoveDir(this.options.dataDir, state.moveId), {
      recursive: true,
      force: true,
    });
    await removeEmptyDirectory(incomingMovesRoot(this.options.dataDir));
  }

  private packageRoots(): string[] {
    const roots = new Set<string>();
    const npmPrefix = this.npmPrefix();

    if (npmPrefix !== null) {
      roots.add(npmPrefixOmnyoAppRoot(npmPrefix));
    }

    const packagedRoot = resolvePackagedOmnyoAppRoot(
      this.options.daemonEntryPath,
    );

    if (packagedRoot !== null) {
      roots.add(packagedRoot);
    }

    return [...roots];
  }

  private npmPrefix(): string | null {
    const npmPrefix = this.options.env.OMNYO_APP_NPM_PREFIX?.trim();

    return npmPrefix !== undefined && npmPrefix !== "" && isAbsolute(npmPrefix)
      ? npmPrefix
      : null;
  }

  private async resolveServerEntry(): Promise<string | null> {
    for (const root of this.packageRoots()) {
      const entry = await resolveOmnyoServerEntry(root);

      if (entry !== null) {
        return entry;
      }
    }

    return null;
  }

  private async resolveLauncherEntry(): Promise<string | null> {
    const npmPrefix = this.npmPrefix();

    if (npmPrefix !== null) {
      const npmBin = join(npmPrefix, "bin", "omnyo-app");

      if (await pathExists(npmBin)) {
        return npmBin;
      }
    }

    for (const root of this.packageRoots()) {
      const entry = await resolveOmnyoAppLauncherEntry(root);

      if (entry !== null) {
        return entry;
      }
    }

    return null;
  }

  private replacementEnv(): NodeJS.ProcessEnv {
    const sanitized = sanitizeInheritedChildProcessEnv({
      env: this.options.env,
    });

    const executableDirectory = dirname(process.execPath);
    const npmPrefix = this.options.env.OMNYO_APP_NPM_PREFIX;

    return {
      ...sanitized,
      PATH:
        sanitized.PATH === undefined
          ? executableDirectory
          : `${executableDirectory}${delimiter}${sanitized.PATH}`,
      OMNYO_DATA_DIR: this.options.dataDir,
      ...(npmPrefix === undefined ? {} : { OMNYO_APP_NPM_PREFIX: npmPrefix }),
      ...(forcesNoServiceManager(this.options.env)
        ? { [SERVER_MOVE_SERVICE_MANAGER_ENV]: "none" }
        : {}),
    };
  }

  private async listStaleMoves(
    moveIds: readonly string[],
  ): Promise<IncomingMoveState[]> {
    const states: IncomingMoveState[] = [];

    for (const moveId of moveIds) {
      if (this.inFlightPrepares.has(moveId)) {
        continue;
      }

      const state = await readIncomingMoveState(
        this.options.dataDir,
        moveId,
      ).catch(() => null);

      if (state !== null && !isActivatingState(state)) {
        states.push(state);
      }
    }

    return states;
  }

  private async abortStaleMoves(): Promise<void> {
    for (const moveId of await listIncomingMoveIds(this.options.dataDir)) {
      if (this.inFlightPrepares.has(moveId)) continue;
      const state = await readIncomingMoveState(this.options.dataDir, moveId);

      if (state !== null && isActivatingState(state)) continue;
      this.options.logger.warn(
        { moveId },
        "Fencing an abandoned server move before preparing a new one",
      );
      await this.abort({ type: "server_move.abort", moveId });
    }

    const interruptedImport = await rollBackServerImport(this.options.dataDir);

    if (interruptedImport !== null) {
      this.options.logger.warn(
        { entries: interruptedImport.entries.length },
        "Rolled back an interrupted server import before preparing a new move",
      );
    }

    await this.removeStaleConnectHold();
  }

  private async removeStaleConnectHold(): Promise<void> {
    if (!(await this.dataDirHasDatabase())) {
      await removeServerConnectHoldFile(this.options.dataDir);
    }
  }

  private async readPreparedResult(
    command: CommandOf<"server_move.prepare">,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.prepare"> | null> {
    const state = await readIncomingMoveState(
      this.options.dataDir,
      command.moveId,
    ).catch(() => null);

    if (
      state === null ||
      state.pendingServer === null ||
      state.preparedAt === null ||
      !tokensEqual(state.activationToken, command.activationToken) ||
      !isProcessGroupAlive(state.pendingServer.pid)
    ) {
      return null;
    }

    try {
      await this.verifyPendingServerOwner(state);

      const moveId = await readPendingServerMoveId({
        fetchFn: this.options.fetchFn,
        serverUrl: state.pendingServer.localServerUrl,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        timeoutMs: PROBE_TIMEOUT_MS,
      });

      return moveId === command.moveId
        ? {
            localServerUrl: state.pendingServer.localServerUrl,
            pid: state.pendingServer.pid,
          }
        : null;
    } catch {
      return null;
    }
  }

  private async runPrepare(
    command: CommandOf<"server_move.prepare">,
    signal: AbortSignal,
  ): Promise<HostDaemonOnlineRpcResult<"server_move.prepare">> {
    const { dataDir } = this.options;
    const moveDir = incomingMoveDir(dataDir, command.moveId);

    let state: IncomingMoveState = {
      version: 1,
      moveId: command.moveId,
      activationToken: command.activationToken,
      serverPort: command.serverPort,
      bindHost: command.bindHost,
      importedEntries: null,
      archivedServerData: null,
      pendingServer: null,
      pendingLaunch: null,
      preparedAt: null,
      runtime: null,
      activation: null,
    };

    const updateState = async (
      patch: Partial<IncomingMoveState>,
    ): Promise<void> => {
      state = { ...state, ...patch };
      await writeIncomingMoveState(dataDir, state);
    };

    try {
      await mkdir(moveDir, { recursive: true, mode: 0o700 });
      await updateState({});

      if (command.appRuntime !== null) {
        await this.installOmnyoApp(command, moveDir, signal);
      }

      const serverEntry = await this.resolveServerEntry();

      if (serverEntry === null) {
        throw new CommandDispatchError(
          "server_move_server_entry_unavailable",
          "This machine's Omnyo installation does not include the Omnyo server",
        );
      }

      if (command.appRuntime !== null) {
        const root = resolve(dirname(serverEntry), "..");

        const identity = await verifyRuntimeIdentity(
          root,
          await readRuntimeIdentity(root),
        );

        if (
          identity.runtimeSha256 !== command.appRuntime.runtimeSha256 ||
          identity.runtimeVersion !== command.appRuntime.version ||
          identity.hostDaemonProtocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
        )
          throw new Error("Installed target runtime identity mismatch");
        await updateState({
          runtime: {
            root,
            sha256: identity.runtimeSha256,
            version: identity.runtimeVersion,
          },
        });
      }

      const archivePath = join(moveDir, ARCHIVE_FILE_NAME);
      await this.download({
        moveId: command.moveId,
        step: "transfer",
        label: "server data",
        downloadPath: command.archive.downloadPath,
        destinationPath: archivePath,
        sha256: command.archive.sha256,
        sizeBytes: command.archive.sizeBytes,
        maxSizeBytes: Number.MAX_SAFE_INTEGER,
        signal,
      });
      signal.throwIfAborted();

      if (command.archiveExistingServerData) {
        const archivedServerData = await this.archiveStandaloneServerData(
          command.moveId,
        );

        if (archivedServerData !== null) {
          await updateState({ archivedServerData });
        }
      }

      this.emitProgress(
        command.moveId,
        "start-target",
        "Importing server data",
      );
      const stagingDir = join(moveDir, STAGING_DIR_NAME);
      await rm(stagingDir, { recursive: true, force: true });

      const manifest = await extractServerArchive({
        archivePath,
        destinationDir: stagingDir,
      });

      signal.throwIfAborted();
      const localServerUrl = `http://127.0.0.1:${command.serverPort}`;

      const installed = await installImportedServerFiles({
        stagingDir,
        dataDir,
        manifest,
        localServerUrl,
      });

      await updateState({ importedEntries: installed.importedEntries });
      await removeServerImportJournalFile(dataDir);
      await restoreMachineConnectionConfig({
        dataDir,
        backupConfigPath: join(
          dataDir,
          SERVER_IMPORT_BACKUP_DIR_NAME,
          "config.json",
        ),
      });
      await writeServerImportFile(dataDir, {
        version: 1,
        kind: "move",
        moveId: command.moveId,
        activationToken: command.activationToken,
        sourceDataDir: command.sourceDataDir,
        sourceServerHostId: command.sourceServerHostId,
        targetHostId: this.options.hostId,
        serverUrl: command.serverUrl,
        importedEntries: installed.importedEntries,
        createdAt: this.options.now(),
        fixupsAppliedAt: null,
      });
      await writeMaintenanceHold(dataDir, {
        version: 1,
        id: command.moveId,
        ownerId: command.moveId,
        kind: "migration",
        phase: "held",
        serverHostId: this.options.hostId,
        createdAt: this.options.now(),
        artifact:
          command.appRuntime === null
            ? null
            : {
                archiveSha256: command.appRuntime.sha256,
                runtimeSha256: command.appRuntime.runtimeSha256,
              },
      });
      await rm(stagingDir, { recursive: true, force: true });
      await rm(archivePath, { force: true });
      signal.throwIfAborted();

      if ((await this.detectLauncherMovedMode()) !== null) {
        this.emitProgress(
          command.moveId,
          "start-target",
          `Waiting for this machine's old server address on port ${command.serverPort} to close`,
        );
        await this.waitForPortRelease(command.serverPort, signal);
      }

      this.emitProgress(
        command.moveId,
        "start-target",
        "Starting the imported server",
      );
      const logPath = this.logPath(PENDING_SERVER_LOG_FILE_NAME);
      const launchId = randomUUID();
      await updateState({ pendingLaunch: { launchId, localServerUrl } });

      const pid = await this.options.launchPendingServer({
        omnyoServerEntry: serverEntry,
        dataDir,
        serverPort: command.serverPort,
        bindHost: command.bindHost,
        hostDaemonPort: this.options.hostDaemonPort,
        env: {
          ...createPendingServerEnv(
            this.options.env,
            this.options.hostDaemonPort,
          ),
          OMNYO_SERVER_LAUNCH_ID: launchId,
        },
        logPath,
      });

      const startedAt = (await readProcessIdentity(pid))?.startedAt ?? null;

      if (startedAt === null)
        throw new Error("Pending process start identity is unknown");
      await updateState({ pendingServer: { pid, localServerUrl, startedAt } });
      await waitForPendingServer({
        fetchFn: this.options.fetchFn,
        localServerUrl,
        moveId: command.moveId,
        pid,
        logPath,
        timeoutMs: this.options.pendingServerTimeoutMs,
        pollIntervalMs: PENDING_SERVER_POLL_INTERVAL_MS,
        now: this.options.now,
        sleep: this.options.sleep,
        signal,
      });
      await this.verifyPendingServerOwner(state);
      await updateState({ preparedAt: this.options.now() });
      this.emitProgress(
        command.moveId,
        "start-target",
        "The imported server is running",
      );

      return { localServerUrl, pid };
    } catch (error) {
      const normalized = normalizePrepareError(error, signal);
      this.options.logger.warn(
        { err: normalized, moveId: command.moveId },
        "Server move prepare failed; cleaning up",
      );
      await this.cleanupMove(state).catch((cleanupError: unknown) => {
        this.options.logger.error(
          { err: cleanupError, moveId: command.moveId },
          "Server move cleanup failed",
        );
      });
      throw normalized;
    }
  }

  private async installOmnyoApp(
    command: CommandOf<"server_move.prepare">,
    moveDir: string,
    signal: AbortSignal,
  ): Promise<void> {
    const appRuntime = command.appRuntime;

    if (appRuntime === null) {
      return;
    }

    const tarballPath = join(moveDir, `omnyo-app-${appRuntime.sha256}.tgz`);
    await this.download({
      moveId: command.moveId,
      step: "update-target",
      label: `Omnyo ${appRuntime.version}`,
      downloadPath: appRuntime.downloadPath,
      destinationPath: tarballPath,
      sha256: appRuntime.sha256,
      sizeBytes: appRuntime.sizeBytes,
      maxSizeBytes: OMNYO_APP_MAX_DOWNLOAD_BYTES,
      signal,
    });
    signal.throwIfAborted();
    this.emitProgress(
      command.moveId,
      "update-target",
      `Installing Omnyo ${appRuntime.version}`,
    );

    try {
      await this.options.installOmnyoApp(tarballPath);
    } catch (error) {
      throw new CommandDispatchError(
        "server_move_install_failed",
        `Could not install Omnyo ${appRuntime.version}: ${errorMessage(error)}`,
      );
    }

    await rm(join(this.options.dataDir, HOST_ARTIFACT_DIGEST_FILE_NAME), {
      force: true,
    });
    await rm(tarballPath, { force: true });
    this.emitProgress(
      command.moveId,
      "update-target",
      `Installed Omnyo ${appRuntime.version}`,
    );
  }

  private async download(args: {
    moveId: string;
    step: ServerMoveStepId;
    label: string;
    downloadPath: string;
    destinationPath: string;
    sha256: string;
    sizeBytes: number | null;
    maxSizeBytes: number;
    signal: AbortSignal;
  }): Promise<void> {
    this.emitProgress(args.moveId, args.step, `Downloading ${args.label}`);
    let lastProgressAt = this.options.now();
    await downloadVerifiedFile({
      fetchFn: this.options.fetchFn,
      url: new URL(args.downloadPath, this.options.serverUrl).toString(),
      headers: {
        ...this.options.serverHeaders,
        authorization: `Bearer ${this.options.hostKey}`,
      },
      destinationPath: args.destinationPath,
      expectedSha256: args.sha256,
      expectedSizeBytes: args.sizeBytes,
      maxSizeBytes: args.maxSizeBytes,
      signal: args.signal,
      onProgress: (receivedBytes) => {
        const now = this.options.now();

        if (now - lastProgressAt < PROGRESS_INTERVAL_MS) {
          return;
        }

        lastProgressAt = now;
        this.emitProgress(
          args.moveId,
          args.step,
          args.sizeBytes === null
            ? `Downloading ${args.label} (${formatMegabytes(receivedBytes)})`
            : `Downloading ${args.label} (${formatMegabytes(receivedBytes)} of ${formatMegabytes(args.sizeBytes)})`,
        );
      },
    });
    this.emitProgress(args.moveId, args.step, `Downloaded ${args.label}`);
  }

  private async archiveStandaloneServerData(
    moveId: string,
  ): Promise<IncomingMoveState["archivedServerData"]> {
    const originalPath = resolve(
      this.options.homeDir,
      STANDALONE_DATA_DIR_NAME,
    );

    if (!(await pathExists(join(originalPath, SERVER_DATABASE_FILE_NAME)))) {
      return null;
    }

    await this.assertStandaloneDataDirNotRunning();
    this.emitProgress(
      moveId,
      "start-target",
      `Archiving the existing Omnyo server data in ${originalPath}`,
    );

    const archivedPath = await archiveExistingServerData({
      dataDir: originalPath,
      now: this.options.now(),
    });

    return { originalPath, archivedPath };
  }

  private async stopPendingServer(state: IncomingMoveState): Promise<void> {
    const pendingServer = state.pendingServer;

    if (pendingServer === null) {
      if (state.pendingLaunch !== null && state.importedEntries !== null)
        throw new Error(
          "Pending launch ownership is uncertain without its process receipt",
        );

      return;
    }

    if (!isProcessGroupAlive(pendingServer.pid)) return;
    await this.verifyPendingServerOwner(state);

    await stopProcessGroup({
      pid: pendingServer.pid,
      timeoutMs: PENDING_SERVER_STOP_TIMEOUT_MS,
      sleep: this.options.sleep,
      now: this.options.now,
      verifyOwner: () => this.verifyPendingProcessStart(state),
    });
  }

  private async verifyPendingProcessStart(
    state: IncomingMoveState,
  ): Promise<void> {
    const pending = state.pendingServer;

    if (
      pending === null ||
      pending.startedAt == null ||
      state.pendingLaunch == null
    )
      throw new Error("Pending process ownership identity is unavailable");
    const actual = await readProcessIdentity(pending.pid);

    if (
      actual?.startedAt == null ||
      Math.abs(actual.startedAt - pending.startedAt) > 1_500
    )
      throw new Error("Pending process start identity does not match");
  }

  private async verifyPendingServerOwner(
    state: IncomingMoveState,
  ): Promise<void> {
    await this.verifyPendingProcessStart(state);
    const pending = state.pendingServer;
    const launch = state.pendingLaunch;

    if (pending === null || launch == null)
      throw new Error("Pending process ownership identity is unavailable");

    const args = {
      fetchFn: this.options.fetchFn,
      serverUrl: pending.localServerUrl,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      timeoutMs: PROBE_TIMEOUT_MS,
    };

    const [moveId, runtime] = await Promise.all([
      readPendingServerMoveId(args),
      readPendingServerRuntime(args),
    ]);

    if (
      moveId !== state.moveId ||
      (runtime.processId !== pending.pid &&
        runtime.parentProcessId !== pending.pid) ||
      runtime.launchId !== launch.launchId ||
      runtime.dataDir !== this.options.dataDir ||
      launch.localServerUrl !== pending.localServerUrl
    )
      throw new Error(
        "Pending process endpoint ownership identity does not match",
      );
    await this.verifyPendingProcessStart(state);
  }

  private async cleanupMove(state: IncomingMoveState): Promise<void> {
    const { dataDir } = this.options;
    const imported = await readServerImportFile(dataDir);

    if (imported !== null && imported.moveId !== state.moveId)
      throw new Error("Target import belongs to another move");
    const hold = readMaintenanceHold(dataDir);

    if (hold?.kind === "migration" && hold.id !== state.moveId)
      throw new Error("Target maintenance belongs to another move");
    await this.stopPendingServer(state);

    if (state.pendingServer !== null)
      await this.waitForPortRelease(state.serverPort, null);

    if (state.importedEntries === null) {
      await rollBackServerImport(dataDir);
    } else {
      await removeImportedServerFiles({
        dataDir,
        importedEntries: state.importedEntries,
      });
    }

    await this.removeStaleConnectHold();
    const importFile = await readServerImportFile(dataDir).catch(() => null);

    if (importFile?.kind === "move" && importFile.moveId === state.moveId) {
      await rm(join(dataDir, SERVER_IMPORT_FILE_NAME), { force: true });
    }

    const archived = state.archivedServerData;

    if (
      archived !== null &&
      !(await pathExists(archived.originalPath)) &&
      (await pathExists(archived.archivedPath))
    ) {
      await rename(archived.archivedPath, archived.originalPath);
    }

    if (hold?.kind === "migration" && hold.id === state.moveId)
      await rm(join(dataDir, SERVER_MAINTENANCE_HOLD_FILE_NAME), {
        force: true,
      });
    await this.removeIncomingState(state);
  }

  private async restartThroughServiceManager(
    definition: ServiceDefinition,
    reason: string,
  ): Promise<boolean> {
    this.options.logger.info(
      { manager: definition.manager, path: definition.path, reason },
      "Restarting the Omnyo service with its updated definition",
    );

    try {
      await restartService({
        definition,
        runCommand: this.options.runCommand,
        spawnDetached: this.options.spawnDetached,
        uid: this.options.uid,
        env: this.options.env,
        logPath: this.logPath(SERVER_MOVE_LOG_FILE_NAME),
      });

      return true;
    } catch (error) {
      this.options.logger.error(
        { err: error, manager: definition.manager, path: definition.path },
        "The service manager could not restart Omnyo; exiting so it restarts the daemon",
      );
      await this.options.requestShutdown(`${reason}-restart-failed`, 1);

      return false;
    }
  }

  private isLoopbackServerUrl(): boolean {
    try {
      return isLoopbackHostname(new URL(this.options.serverUrl).hostname);
    } catch {
      return false;
    }
  }

  private async switchToMovedServer(
    serverUrl: string,
    headers: Record<string, string> | null,
  ): Promise<void> {
    await rewriteManagedConfigServer({
      dataDir: this.options.dataDir,
      serverUrl,
      headers,
    });
    const definition = await this.findServiceDefinition();

    if (definition !== null && !isServerStartDefinition(definition)) {
      const updated = await writeServiceDefinition(
        definition,
        replaceServerUrlArgument(definition.programArguments, serverUrl),
      );

      await this.restartThroughServiceManager(updated, "server-moved");

      return;
    }

    if (
      definition !== null ||
      this.isLoopbackServerUrl() ||
      (await pathExists(join(this.options.dataDir, SERVER_MOVED_FILE_NAME)))
    ) {
      this.options.logger.info(
        { serverUrl },
        "The Omnyo server moved; exiting so the omnyo-app launcher reconnects to the new server",
      );
      await this.options.requestShutdown("server-moved", 0);

      return;
    }

    const supervisor = await this.detectUnrecognizedSupervisor();

    if (supervisor !== null) {
      this.options.logger.warn(
        { serverUrl, supervisor },
        "The Omnyo server moved, but this daemon runs under a service Omnyo does not manage; updated config.json and exiting instead of starting a second daemon",
      );
      await this.options.requestShutdown("server-moved", 0);

      return;
    }

    const launcherEntry = await this.resolveLauncherEntry();

    if (launcherEntry === null) {
      this.options.logger.warn(
        { serverUrl },
        "The Omnyo server moved, but this daemon has no omnyo-app launcher to restart through; exiting",
      );
      await this.options.requestShutdown("server-moved", 0);

      return;
    }

    await this.spawnReplacement([
      launcherEntry,
      "host-daemon",
      ...(this.options.autoUpdate ? ["--auto-update"] : []),
      ...(this.options.supervised ? ["--supervise"] : []),
      ...(this.options.hostDaemonPort === null
        ? []
        : ["--host-daemon-port", String(this.options.hostDaemonPort)]),
      "--server-url",
      serverUrl,
    ]);
    await this.options.requestShutdown("server-moved", 0);
  }

  private async spawnReplacement(args: string[]): Promise<void> {
    const pid = await this.options.spawnDetached({
      command: process.execPath,
      args,
      env: this.replacementEnv(),
      logPath: this.logPath(SERVER_MOVE_LOG_FILE_NAME),
    });

    const pidFilePath = join(
      this.options.dataDir,
      INSTALL_DAEMON_PID_FILE_NAME,
    );

    if (await pathExists(pidFilePath)) {
      await writeFileAtomically({
        path: pidFilePath,
        content: `${pid}\n`,
        mode: 0o600,
      });
    }

    this.options.logger.info(
      { pid, args },
      "Started a replacement omnyo-app process for this machine",
    );
  }
}

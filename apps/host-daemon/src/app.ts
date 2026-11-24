import { setProcessErrorReportingEnabled } from "@omnyo/process-utils/error-reporting";
import { randomUUID } from "node:crypto";
import {
  idleProviderSessionGraceMs,
  readMemoryPressure,
  readProviderProcessMemory,
} from "./memory-pressure.js";
import { realpath } from "node:fs/promises";
import { CommandMetadataCatalog } from "./command-metadata.js";
import {
  drainIsolatedFilesystemReaders,
  startFileChunkReader,
  IsolatedCommandMetadataCatalog,
} from "./workspace-read-client.js";
import {
  HOST_DAEMON_RESTART_EXIT_CODE,
  HOST_DAEMON_SERVICE_INSTALL_EXIT_CODE,
} from "@omnyo/config/machine-service";
import { prepareWorkerIdentityAdoptionRestart } from "./identity-adoption-update.js";
import { createAgentProcessContainment } from "./agent-process-containment.js";
import { startDesktopBrowserBroker } from "./desktop-browser-broker.js";
import { MachineEnvironment } from "./machine-environment.js";
import { CommandRouter } from "./command-router.js";
import { ExpectedCommandDispatchError } from "./command-errors.js";
import { WorkspaceReadCoalescer } from "./workspace-read-coalescer.js";
import {
  createDaemon,
  type HostDaemon,
  type HostDaemonExitCode,
} from "./daemon.js";
import {
  createEventSink,
  EventSinkDisposedError,
  type EventSink,
} from "./event-sink.js";
import {
  InteractiveRequestRegistry,
  InteractiveRequestRegistryError,
} from "./interactive-request-registry.js";
import { startEventLoopStallMonitor } from "./event-loop-stall-monitor.js";
import { startHostDaemonHealthMonitor } from "./host-daemon-health-monitor.js";
import { startLocalApiServer, type LocalApiServer } from "./local-api.js";
import type { HostDaemonLocalApiConfig } from "./local-api-config.js";
import type { HostDaemonLogger } from "./logger.js";
import {
  HOST_DAEMON_PROTOCOL_VERSION,
  type HostDaemonDaemonWsMessage,
  type HostDaemonInteractiveRequestKey,
  type HostDaemonOpenThreadWork,
  type HostHousekeepingStatus,
  type MemoryPressureSample,
} from "@omnyo/host-daemon-contract";
import {
  RuntimeManager,
  type RuntimeManagerReapIdleProviderSessionsArgs,
  type RuntimeManagerReapIdleProviderSessionsResult,
  type RuntimeManagerOptions,
} from "./runtime-manager.js";
import { WatchManager, type WatchManagerOptions } from "./watch-manager.js";
import {
  createIsolatedWatchManager,
  type WatchManagerClient,
} from "./workspace-observer-client.js";
import { ConnectTunnelClient } from "./connect-tunnel/index.js";
import { TerminalManager } from "./terminals/terminal-manager.js";
import { ManagedPreviewManager } from "./previews/managed-preview-manager.js";
import { PreviewHostTransport } from "./previews/preview-transport.js";
import {
  createServerClient,
  ServerResponseError,
  type FetchFn,
} from "./server-client.js";
import {
  cleanupInjectedSkillStagingDirs,
  ensureDataDirSkillsRootPath,
} from "./injected-skills.js";
import {
  ServerConnection,
  type HandleServerSessionInvalidatedArgs,
  type ServerSessionInvalidationSource,
  type CreateReconnectingWebSocket,
} from "./server-connection.js";
import { runtimeErrorLogFields, summarizeError } from "./error-utils.js";
import { ensureThreadStorageRoot } from "./thread-storage-root.js";
import { createRuntimeShellEnvCache } from "./runtime-shell-env-cache.js";
import type {
  AgentRuntime,
  AgentRuntimeOptions,
  RuntimeOpenBackgroundWork,
} from "@omnyo/agent-runtime";
import { createProtocolSelfUpdater } from "./protocol-self-update.js";
import {
  UpdateDeliveryCheckpoint,
  waitForUpdateCheckpoint,
  type PendingInteractiveInterruptRequest,
} from "./update-delivery-checkpoint.js";
import {
  readWorkerRuntimeVersion,
  resolvePackagedOmnyoAppRoot,
} from "./server-move/package-layout.js";
import type { HostWatcher } from "@omnyo/host-watcher";
import { PluginHostManager } from "./plugin-host-manager.js";
import { writeMachineSuspensionMarker } from "./suspension-marker.js";
import {
  defaultServerMoveServiceOptions,
  ServerMoveService,
} from "./server-move/service.js";

interface SessionState {
  value: string | null;
}

const INTERACTIVE_INTERRUPT_RETRY_DELAY_MS = 1_000;

const INTERACTIVE_INTERRUPT_MAX_RETRY_DELAY_MS = 60_000;

const IDLE_PROVIDER_SESSION_REAP_INTERVAL_MS = 60 * 1000;

const RUNTIME_SHELL_ENV_REFRESH_TTL_MS = 10_000;

const ENDED_INTERACTIVE_REQUEST_REASON =
  "The question was closed while the host was disconnected";

function collectOpenThreadWork(args: {
  backgroundWork: readonly RuntimeOpenBackgroundWork[];
  interactiveRequests: readonly HostDaemonInteractiveRequestKey[];
}): HostDaemonOpenThreadWork[] {
  const byThreadId = new Map<string, HostDaemonOpenThreadWork>();

  const threadWork = (threadId: string): HostDaemonOpenThreadWork => {
    const existing = byThreadId.get(threadId);

    if (existing) return existing;

    const created: HostDaemonOpenThreadWork = {
      threadId,
      backgroundItemIds: [],
      interactiveRequests: [],
    };

    byThreadId.set(threadId, created);

    return created;
  };

  for (const work of args.backgroundWork) {
    threadWork(work.threadId).backgroundItemIds.push(...work.itemIds);
  }

  for (const request of args.interactiveRequests) {
    threadWork(request.threadId).interactiveRequests.push(request);
  }

  return [...byThreadId.values()];
}

interface IdleProviderSessionReaperTimer {
  clear(): void;
  unref(): void;
}

type IdleProviderSessionReaperIntervalFn = (
  callback: () => void,
  intervalMs: number,
) => IdleProviderSessionReaperTimer;

interface IdleProviderSessionReaper {
  stop(): void;
}

interface IdleProviderSessionReaperRuntimeManager {
  recordHousekeepingStatus(status: HostHousekeepingStatus): void;
  reapIdleProviderSessions(
    args: RuntimeManagerReapIdleProviderSessionsArgs,
  ): Promise<RuntimeManagerReapIdleProviderSessionsResult>;
}

interface StartIdleProviderSessionReaperArgs {
  readMemoryPressure?: () => Promise<MemoryPressureSample>;
  logger: HostDaemonLogger;
  nowMs: () => number;
  runtimeManager: IdleProviderSessionReaperRuntimeManager;
  setIntervalFn: IdleProviderSessionReaperIntervalFn;
}

interface CreateHostDaemonAppOptions {
  dataDir: string;
  serverUrl: string;
  hostKey: string;
  bridgeBundleDir?: string;
  hostId: string;
  hostName: string;
  instanceId: string;
  appUrl?: string;
  devAppPort?: number;
  logger: HostDaemonLogger;
  serverHeaders?: Record<string, string>;
  autoUpdate?: boolean;
  supervised?: boolean;
  windowsServiceInstall?: boolean;
  releaseLock: () => Promise<void>;
  localApiConfig: HostDaemonLocalApiConfig | null;
  createRuntime?: RuntimeManagerOptions["createRuntime"];
  runtimeShellEnv?: AgentRuntimeOptions["shellEnv"];
  runtimeShellEnvResolvedAtMs?: number;
  resolveRuntimeShellEnv?: () => Promise<
    NonNullable<AgentRuntimeOptions["shellEnv"]>
  >;
  nowMs?: () => number;
  hostWatcher?: HostWatcher;
  fetchFn?: FetchFn;
  createWebSocket?: CreateReconnectingWebSocket;
  closeMachineAuthProxy?: () => Promise<void>;
  exitProcess?: (code: number) => void;
}

export interface HostDaemonApp {
  daemon: HostDaemon;
  eventSink: EventSink;
  localApi: LocalApiServer | null;
  runtimeManager: RuntimeManager;
  watchManager: WatchManagerClient;
  connectTunnel: ConnectTunnelClient;
  terminalManager: TerminalManager;
  router: CommandRouter;
  connection: ServerConnection;
}

export function startIdleProviderSessionReaper(
  args: StartIdleProviderSessionReaperArgs,
): IdleProviderSessionReaper {
  let running = false;
  let stopped = false;
  let previousPressure: string | null = null;

  const timer = args.setIntervalFn(() => {
    if (running || stopped) return;
    running = true;

    void (async () => {
      let memoryPressure: MemoryPressureSample;

      try {
        memoryPressure = await (
          args.readMemoryPressure ?? readMemoryPressure
        )();
      } catch {
        memoryPressure = { status: "unavailable", reason: "read-failed" };
      }

      if (stopped) return;
      const idleGraceMs = idleProviderSessionGraceMs(memoryPressure);
      const checkedAt = args.nowMs();
      const pressureKey = JSON.stringify(memoryPressure);

      if (pressureKey !== previousPressure) {
        args.logger.debug(
          { memoryPressure, idleGraceMs },
          "Idle provider cleanup memory pressure changed",
        );
        previousPressure = pressureKey;
      }

      try {
        const result = await args.runtimeManager.reapIdleProviderSessions({
          idleForMs: idleGraceMs,
          nowMs: checkedAt,
        });

        const processMemory = await readProviderProcessMemory(
          result.retainedSessions.flatMap((session) =>
            session.processId === null ? [] : [session.processId],
          ),
        );

        args.runtimeManager.recordHousekeepingStatus({
          status: "complete",
          checkedAt,
          memoryPressure,
          idleGraceMs,
          retainedSessions: result.retainedSessions.map((session) => {
            const bytes =
              session.processId === null
                ? undefined
                : processMemory.get(session.processId);

            return {
              ...session,
              memory:
                bytes === undefined
                  ? { status: "unavailable" }
                  : { status: "observed", source: "rss", bytes },
            };
          }),
          reapedSessions: result.reapedSessions.map(
            ({ environmentId, idleForMs, providerId, threadId }) => ({
              environmentId,
              idleForMs,
              providerId,
              threadId,
            }),
          ),
        });

        if (result.reapedSessions.length > 0) {
          args.logger.info(
            {
              count: result.reapedSessions.length,
              sessions: result.reapedSessions.map(
                ({ environmentId, idleForMs, providerId, threadId }) => ({
                  environmentId,
                  idleForMs,
                  providerId,
                  threadId,
                }),
              ),
            },
            "Reaped idle provider sessions",
          );
        }
      } catch (error) {
        args.runtimeManager.recordHousekeepingStatus({
          status: "failed",
          checkedAt,
          memoryPressure,
          idleGraceMs,
        });
        args.logger.warn(
          { ...runtimeErrorLogFields(error) },
          "Idle provider session reaper failed",
        );
      }
    })().finally(() => {
      running = false;
    });
  }, IDLE_PROVIDER_SESSION_REAP_INTERVAL_MS);

  timer.unref();

  return {
    stop() {
      stopped = true;
      timer.clear();
    },
  };
}

interface SessionRequestArgs<TResult> {
  request: () => Promise<TResult>;
  source: ServerSessionInvalidationSource;
}

interface MaybeInvalidateSessionArgs {
  error: unknown;
  observedSessionId: string | null;
  source: ServerSessionInvalidationSource;
}

export async function createHostDaemonApp(
  options: CreateHostDaemonAppOptions,
): Promise<HostDaemonApp> {
  const machineEnvironment = new MachineEnvironment(
    process.env,
    options.runtimeShellEnv ?? {},
  );

  const threadStorageRootPath = await ensureThreadStorageRoot(options.dataDir);

  const dataDirSkillsRootPath = await ensureDataDirSkillsRootPath(
    options.dataDir,
  );

  await cleanupInjectedSkillStagingDirs({
    dataDir: options.dataDir,
    keepCatalogHashes: [],
    logger: options.logger,
  });

  const sessionState: SessionState = {
    value: null,
  };

  const deliveryCheckpoint = new UpdateDeliveryCheckpoint(
    options.dataDir,
    options.hostId,
  );

  await deliveryCheckpoint.load();

  const pendingInteractiveInterrupts = new Map(
    deliveryCheckpoint.interrupts.map((request) => [
      buildInteractiveInterruptKey(request),
      request,
    ]),
  );

  const rejectedInteractiveInterrupts = new Set<string>();
  let deliveryPaused = false;
  let interruptAbort: AbortController | null = null;

  let runtimeManager: RuntimeManager;
  let watchManager: WatchManagerClient;

  const workspaceReads = new WorkspaceReadCoalescer({
    now: Date.now,
    environmentPath: (environmentId) => runtimeManager.get(environmentId)?.path,
    realpath: (workspacePath) => realpath(workspacePath),
  });

  let flushPendingInteractiveInterruptsPromise: Promise<void> | null = null;

  let interactiveInterruptRetryTimeout: ReturnType<typeof setTimeout> | null =
    null;

  let interactiveInterruptRetryDelayMs = INTERACTIVE_INTERRUPT_RETRY_DELAY_MS;
  let eventSink: EventSink;

  let handleServerSessionInvalidated = (
    _args: HandleServerSessionInvalidatedArgs,
  ): void => undefined;

  function maybeInvalidateServerSession(
    args: MaybeInvalidateSessionArgs,
  ): void {
    if (
      args.observedSessionId === null ||
      !(args.error instanceof ServerResponseError) ||
      args.error.code !== "inactive_session"
    ) {
      return;
    }

    handleServerSessionInvalidated({
      code: "inactive_session",
      observedSessionId: args.observedSessionId,
      source: args.source,
    });
  }

  async function runSessionRequest<TResult>(
    args: SessionRequestArgs<TResult>,
  ): Promise<TResult> {
    const observedSessionId = sessionState.value;

    try {
      return await args.request();
    } catch (error) {
      maybeInvalidateServerSession({
        error,
        observedSessionId,
        source: args.source,
      });
      throw error;
    }
  }

  const serverClient = createServerClient({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    logger: options.logger,
    serverHeaders: options.serverHeaders,
    getSessionId: () => {
      if (!sessionState.value) {
        throw new Error("Server session is not open");
      }

      return sessionState.value;
    },
    runtimeUpdate: () => ({
      runtimeVersion,
      automaticUpdates: options.autoUpdate ?? false,
    }),
    fetchFn: options.fetchFn,
  });

  function buildInteractiveInterruptKey(
    request: Omit<PendingInteractiveInterruptRequest, "deliveryId">,
  ): string {
    return [
      request.providerId,
      request.reason,
      [...request.threadIds].sort().join(","),
      JSON.stringify(request.requests),
    ].join("|");
  }

  function clearInteractiveInterruptRetry(): void {
    if (interactiveInterruptRetryTimeout !== null) {
      clearTimeout(interactiveInterruptRetryTimeout);
      interactiveInterruptRetryTimeout = null;
    }
  }

  function scheduleInteractiveInterruptRetry(): void {
    if (
      deliveryPaused ||
      interactiveInterruptRetryTimeout !== null ||
      sessionState.value === null ||
      ![...pendingInteractiveInterrupts.keys()].some(
        (key) => !rejectedInteractiveInterrupts.has(key),
      )
    ) {
      return;
    }

    const delayMs = interactiveInterruptRetryDelayMs;
    interactiveInterruptRetryDelayMs = Math.min(
      delayMs * 2,
      INTERACTIVE_INTERRUPT_MAX_RETRY_DELAY_MS,
    );
    interactiveInterruptRetryTimeout = setTimeout(() => {
      interactiveInterruptRetryTimeout = null;
      void flushPendingInteractiveInterrupts();
    }, delayMs);
  }

  function isRejectedInteractiveInterrupt(error: unknown): boolean {
    return (
      error instanceof ServerResponseError &&
      !error.retryable &&
      error.code !== "inactive_session"
    );
  }

  async function flushPendingInteractiveInterrupts(): Promise<void> {
    if (deliveryPaused) return;

    if (flushPendingInteractiveInterruptsPromise) {
      await flushPendingInteractiveInterruptsPromise;

      return;
    }

    clearInteractiveInterruptRetry();

    interruptAbort = new AbortController();
    flushPendingInteractiveInterruptsPromise = (async () => {
      while (!deliveryPaused && sessionState.value !== null) {
        const nextEntry = [...pendingInteractiveInterrupts.entries()].find(
          ([key]) => !rejectedInteractiveInterrupts.has(key),
        );

        if (!nextEntry) {
          return;
        }

        const [key, request] = nextEntry;

        try {
          await runSessionRequest({
            source: "interruptInteractiveRequests",
            request: () =>
              serverClient.interruptInteractiveRequests(
                request,
                interruptAbort?.signal,
              ),
          });
          await deliveryCheckpoint.acknowledgeInterrupt(request.deliveryId);
          pendingInteractiveInterrupts.delete(key);
          interactiveInterruptRetryDelayMs =
            INTERACTIVE_INTERRUPT_RETRY_DELAY_MS;
        } catch (error) {
          const logFields = {
            providerId: request.providerId,
            threadIds: request.threadIds,
            ...runtimeErrorLogFields(error),
          };

          if (isRejectedInteractiveInterrupt(error)) {
            rejectedInteractiveInterrupts.add(key);
            options.logger.warn(
              logFields,
              "Retained pending interactive interrupt request the server rejected",
            );
            continue;
          }

          options.logger.warn(
            logFields,
            "Failed to flush pending interactive interrupt request",
          );
          scheduleInteractiveInterruptRetry();

          return;
        }
      }
    })();

    try {
      await flushPendingInteractiveInterruptsPromise;
    } finally {
      flushPendingInteractiveInterruptsPromise = null;
      interruptAbort = null;
    }
  }

  function enqueueInteractiveInterrupt(
    request: Omit<PendingInteractiveInterruptRequest, "deliveryId">,
  ): void {
    const key = buildInteractiveInterruptKey(request);

    if (!pendingInteractiveInterrupts.has(key)) {
      pendingInteractiveInterrupts.set(key, {
        ...request,
        deliveryId: randomUUID(),
      });
    }

    if (interactiveInterruptRetryTimeout === null) {
      void flushPendingInteractiveInterrupts();
    }
  }

  eventSink = createEventSink({
    isSessionOpen: () => sessionState.value !== null,
    logger: options.logger,
    instanceId: options.instanceId,
    initialEvents: deliveryCheckpoint.events,
    onAcknowledged: (events) => deliveryCheckpoint.acknowledgeEvents(events),
    onRejected: (events) => deliveryCheckpoint.recordRejectedEvents(events),
    postEvents: (batch, signal) =>
      runSessionRequest({
        source: "postEvents",
        request: () => serverClient.postEvents(batch, signal),
      }),
  });

  const interactiveRequestRegistry = new InteractiveRequestRegistry({
    registerRequest: (request) => {
      const eventsThrough = eventSink.markThrough();

      return runSessionRequest({
        source: "registerInteractiveRequest",
        request: () =>
          serverClient.registerInteractiveRequest(request, eventsThrough),
      });
    },
    onRegistrationFailure: ({ error, request }) => {
      enqueueInteractiveInterrupt({
        providerId: request.providerId,
        reason: `Failed to register interactive request while provider was waiting: ${error.message}`,
        threadIds: [request.threadId],
        requests: [
          {
            interactionId: null,
            threadId: request.threadId,
            turnId: request.turnId ?? null,
            providerThreadId: request.providerThreadId,
            providerRequestId: request.providerRequestId,
          },
        ],
      });
    },
  });

  let sendServerMessage = (_message: HostDaemonDaemonWsMessage) => false;

  function logHostWatchError(fields: Record<string, string>): void {
    options.logger.warn(
      fields,
      "Host filesystem watch error (live updates for this path may be stale until it recovers)",
    );
  }

  const watchManagerOptions = {
    shellEnv: () => runtimeManager.getShellEnv(),
    threadStorageRootPath,
    onThreadStorageChanged: ({ environmentId }) => {
      sendServerMessage({
        type: "environment-change",
        environmentId,
        change: "thread-storage-changed",
      });
    },
    onThreadStorageWatchError: ({ error }) => {
      logHostWatchError({
        watchSource: "thread-storage",
        rootPath: error.rootPath,
        watchError: error.message,
      });
    },
    onWorkspaceStatusChanged: ({ environmentId, changeKinds }) => {
      workspaceReads.invalidateEnvironment(environmentId);

      for (const change of changeKinds) {
        sendServerMessage({
          type: "environment-change",
          environmentId,
          change,
        });
      }
    },
    onWorkspaceMetadataChanged: ({ environmentId, workspace }) => {
      const publish = () =>
        sendServerMessage({
          type: "environment-metadata-change",
          environmentId,
          workspace,
        });

      if (options.hostWatcher !== undefined) {
        publish();

        return;
      }

      void runtimeManager
        .refreshEnvironmentWorkspace({
          environmentId,
          workspacePath: workspace.path,
          provision: { path: workspace.path },
        })
        .then(publish)
        .catch((error: unknown) =>
          logHostWatchError({
            watchSource: "workspace-status",
            environmentId,
            rootPath: workspace.path,
            watchError:
              error instanceof Error
                ? error.message
                : "Workspace metadata refresh failed",
          }),
        );
    },
    onWorkspaceStatusWatchError: ({ error }) => {
      logHostWatchError({
        watchSource: "workspace-status",
        environmentId: error.environmentId,
        rootPath: error.rootPath,
        watchError: error.message,
      });
    },
  } satisfies WatchManagerOptions;

  let hostWatcher: HostWatcher;

  if (options.hostWatcher === undefined) {
    const isolated = createIsolatedWatchManager({
      ...watchManagerOptions,
      logger: options.logger,
    });

    watchManager = isolated;
    hostWatcher = isolated.hostWatcher;
  } else {
    hostWatcher = options.hostWatcher;
    watchManager = new WatchManager({
      ...watchManagerOptions,
      hostWatcher,
      refreshWorkspace: (args) =>
        runtimeManager.refreshEnvironmentWorkspace(args),
    });
  }

  const commandMetadata =
    options.hostWatcher === undefined
      ? new IsolatedCommandMetadataCatalog((scopes) => {
          sendServerMessage({ type: "command-catalog-change", scopes });
        }, hostWatcher)
      : new CommandMetadataCatalog(hostWatcher, () => {
          sendServerMessage({ type: "command-catalog-change" });
        });

  const connectTunnel = new ConnectTunnelClient({
    serverUrl: options.serverUrl,
    hostName: options.hostName,
    machineCredential: options.serverHeaders?.["x-omnyo-connect-machine"],
    fetchFn: options.fetchFn,
    logger: options.logger,
    onIdentity: (identity) => {
      sendServerMessage({
        type: "connect-tunnel.identity",
        identity,
      });
    },
    onStatusChange: (status) => {
      options.logger.debug(
        { connectTunnelStatus: status },
        "Machine tunnel status",
      );
    },
  });

  const agentProcessContainment = createAgentProcessContainment({
    logger: options.logger,
  });

  runtimeManager = new RuntimeManager({
    workspaceUnscopedWriterActivity: () =>
      terminalManager.getDirectAccessActivityCount(),
    bridgeBundleDir: options.bridgeBundleDir,
    containProviderProcess: agentProcessContainment?.contain,
    createRuntime: options.createRuntime,
    dataDir: options.dataDir,
    dataDirSkillsRootPath,
    fetchSkillTree: (treeHash) =>
      runSessionRequest({
        source: "fetchSkillTree",
        request: () => serverClient.fetchSkillTree(treeHash),
      }),
    hostWatcher,
    logger: options.logger,
    shellEnv: options.runtimeShellEnv,
    applyMachineEnvironment: (shell) =>
      machineEnvironment.shellEnvironment(shell),
    onEvent: ({ environmentId, event }) => {
      if (event.type === "turn/completed")
        workspaceReads.invalidateEnvironment(environmentId);

      try {
        eventSink.emit({
          threadId: event.threadId,
          event,
        });
      } catch (error) {
        if (error instanceof EventSinkDisposedError) {
          options.logger.warn(
            {
              environmentId,
              eventType: event.type,
              threadId: event.threadId,
            },
            "Ignoring runtime event received after event sink disposal",
          );

          return;
        }

        throw error;
      }
    },
    onInjectedSkillsChanged: (change) => {
      options.logger.debug(
        {
          changedPaths: change.changedPaths,
          sourceType: change.sourceType,
        },
        "Injected skills changed; future runtime launches will rescan",
      );
    },
    onDataDirSkillsWatchError: ({ error }) => {
      logHostWatchError({
        watchSource: "data-dir-skills",
        rootPath: error.rootPath,
        watchError: error.message,
      });
    },
    onToolCall: async (request, signal) => {
      try {
        signal?.throwIfAborted();
        const eventsThrough = eventSink.markThrough();

        return await runSessionRequest({
          source: "callTool",
          request: () =>
            serverClient.callTool(request, {
              eventsThrough,
              ...(signal === undefined ? {} : { signal }),
            }),
        });
      } catch (error) {
        if (signal?.aborted && error === signal.reason) throw error;

        options.logger.error(
          {
            tool: request.tool,
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            turnId: request.turnId,
            callId: request.callId,
            err: error,
          },
          "Failed to forward dynamic tool call to server",
        );
        throw error;
      }
    },
    onInteractiveRequest: async (request) => {
      try {
        return await interactiveRequestRegistry.registerAndWait(request);
      } catch (error) {
        if (
          error instanceof InteractiveRequestRegistryError &&
          (error.code === "interactive_request_rejected" ||
            error.code === "interactive_request_ended")
        ) {
          options.logger.warn(
            {
              interactiveRequestErrorCode: error.code,
              ...summarizeError(error),
              threadId: request.threadId,
              providerThreadId: request.providerThreadId,
              turnId: request.turnId,
              providerRequestId: request.providerRequestId,
              kind: request.payload.kind,
            },
            "Interactive provider request rejected by server",
          );
          throw error;
        }

        options.logger.error(
          {
            threadId: request.threadId,
            providerThreadId: request.providerThreadId,
            turnId: request.turnId,
            providerRequestId: request.providerRequestId,
            kind: request.payload.kind,
            err: error,
          },
          "Failed to forward interactive provider request to server",
        );
        throw error;
      }
    },
    onThreadDetached: ({ providerId, threadId }) => {
      const threadIds = [threadId];
      const reason = `Provider "${providerId}" detached thread while awaiting user interaction`;

      const requests = interactiveRequestRegistry.interruptThreads({
        providerId,
        threadIds,
        reason,
      });

      if (requests.length > 0) {
        enqueueInteractiveInterrupt({
          providerId,
          threadIds,
          reason,
          requests,
        });
      }
    },
    onProcessExit: (info) => {
      const threadIds = info.threads.map((thread) => thread.threadId);

      if (!info.expected && info.stderr) {
        options.logger.warn(
          {
            providerId: info.providerId,
            threadIds,
            code: info.code,
            signal: info.signal,
            stderr: info.stderr,
          },
          "Unexpected provider process exited with stderr",
        );
      }

      if (threadIds.length === 0) {
        return;
      }

      const reason = `Provider "${info.providerId}" exited while awaiting user interaction`;

      const requests = interactiveRequestRegistry.interruptThreads({
        providerId: info.providerId,
        threadIds,
        reason,
      });

      enqueueInteractiveInterrupt({
        providerId: info.providerId,
        threadIds,
        reason,
        requests,
      });
    },
    threadStorageRootPath,
  });
  const nowMs = options.nowMs ?? Date.now;

  const runtimeShellEnvCache = createRuntimeShellEnvCache({
    applyShellEnv: (shellEnv) => runtimeManager.replaceBaseShellEnv(shellEnv),
    now: nowMs,
    onRefreshError: (error) => {
      options.logger.warn(
        { err: error },
        "Background login-shell environment refresh failed",
      );
    },
    readShellEnv: () => runtimeManager.getShellEnv(),
    ttlMs: RUNTIME_SHELL_ENV_REFRESH_TTL_MS,
    ...(options.resolveRuntimeShellEnv
      ? { resolveShellEnv: options.resolveRuntimeShellEnv }
      : {}),
    ...(options.runtimeShellEnvResolvedAtMs === undefined
      ? {}
      : { resolvedAtMs: options.runtimeShellEnvResolvedAtMs }),
  });

  const withMaintenanceRuntime = async <TResult>(
    request: (runtime: AgentRuntime) => Promise<TResult>,
  ): Promise<TResult> => {
    await runtimeShellEnvCache.refresh({ allowStale: false });

    return runtimeManager.withProviderMaintenanceRuntime(
      { dataDir: options.dataDir },
      request,
    );
  };

  const idleProviderSessionReaper = startIdleProviderSessionReaper({
    logger: options.logger,
    nowMs: Date.now,
    runtimeManager,
    setIntervalFn: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs);

      return {
        clear() {
          clearInterval(timer);
        },
        unref() {
          timer.unref();
        },
      };
    },
  });

  const terminalManager = new TerminalManager({
    logger: options.logger,
    runtimeManager,
    sendMessage: (message) => sendServerMessage(message),
  });

  const managedPreviews = new ManagedPreviewManager({
    logger: options.logger,
    shellEnv: () => runtimeManager.getShellEnv(),
    markActive: (environmentId, previewId) =>
      runtimeManager.markTerminalActive(environmentId, `preview:${previewId}`),
    markInactive: (environmentId, previewId) =>
      runtimeManager.markTerminalInactive(
        environmentId,
        `preview:${previewId}`,
      ),
  });

  const previewTransport = new PreviewHostTransport({
    logger: options.logger,
    getTarget: (previewId, runId) =>
      managedPreviews.resolveTarget(previewId, runId),
    validateRun: (previewId, runId) =>
      managedPreviews.validateSocketOwner(previewId, runId),
  });

  const pluginHostManager = new PluginHostManager({
    dataDir: options.dataDir,
    hostWatcher,
    logger: options.logger,
    shellEnv: () => runtimeManager.getShellEnv(),
    fetchArtifact: (args) =>
      runSessionRequest({
        source: "fetchPluginHostArtifact",
        request: () => serverClient.fetchPluginHostArtifact(args),
      }),
    onWorkerExit: (event) => {
      sendServerMessage({
        type: "plugin-host.worker-exited",
        ...event,
      });
    },
    onSignal: (event) => {
      sendServerMessage({
        type: "plugin-host.signal",
        ...event,
      });
    },
  });

  const desktopBrowserBroker = await startDesktopBrowserBroker({
    dataDir: options.dataDir,
    hostId: options.hostId,
    serverUrl: options.serverUrl,
    onChanged: (event) => sendServerMessage(event),
  });

  let requestServerMoveShutdown = async (
    _reason: string,
    _exitCode: 0 | 1,
  ): Promise<void> => undefined;

  const updateOwner = `self-update:${options.instanceId}`;

  const serverMove = new ServerMoveService({
    ...defaultServerMoveServiceOptions(),
    instanceId: options.instanceId,
    getDirectAccessActivity: () => ({
      commands: router.getDirectAccessActivityCount(),
      runtimes: runtimeManager.getDirectAccessActivityCount(),
      terminals:
        terminalManager.getDirectAccessActivityCount() +
        managedPreviews.activityCount(),
      pluginHosts: pluginHostManager.getDirectAccessActivityCount(),
      interactions:
        interactiveRequestRegistry.getDirectAccessActivityCount() +
        pendingInteractiveInterrupts.size,
    }),
    getRuntimeUpdateActivity: ({ ownerId, scope }) => ({
      commands: router.getDirectAccessActivityCount(),
      runtimes: runtimeManager.getRuntimeUpdateActivityCount(scope),
      terminals:
        terminalManager.getDirectAccessActivityCount() +
        managedPreviews.activityCount(),
      pluginHosts: pluginHostManager.getRuntimeUpdateActivityCount(),
      interactions:
        interactiveRequestRegistry.getDirectAccessActivityCount() +
        (ownerId === updateOwner ? 0 : pendingInteractiveInterrupts.size),
    }),
    dataDir: options.dataDir,
    hostId: options.hostId,
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    serverHeaders: options.serverHeaders ?? {},
    hostDaemonPort: options.localApiConfig?.port ?? null,
    autoUpdate: options.autoUpdate ?? false,
    supervised: options.supervised ?? false,
    logger: options.logger,
    ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
    isServerSessionOpen: () => sessionState.value !== null,
    getServerSessionId: () => sessionState.value,
    getShellEnv: () => runtimeManager.getShellEnv(),
    emitProgress: (message) => {
      sendServerMessage(message);
    },
    requestShutdown: (reason, exitCode) =>
      requestServerMoveShutdown(reason, exitCode),
  });

  const router = new CommandRouter({
    workspaceReads,
    managedPreviews,
    terminals: terminalManager,
    previewTransport,
    emitEnvironmentHookProgress: (message) => sendServerMessage(message),
    desktopBrowserBroker,
    dataDir: options.dataDir,
    fetchProjectAttachment: (args) =>
      runSessionRequest({
        source: "fetchProjectAttachment",
        request: () => serverClient.fetchProjectAttachment(args),
      }),
    fetchSkillTree: (treeHash) =>
      runSessionRequest({
        source: "fetchSkillTree",
        request: () => serverClient.fetchSkillTree(treeHash),
      }),
    fetchPluginHostArtifact: (args) =>
      runSessionRequest({
        source: "fetchPluginHostArtifact",
        request: () => serverClient.fetchPluginHostArtifact(args),
      }),
    runtimeManager,
    listModels: (args) =>
      withMaintenanceRuntime((runtime) => runtime.listModels(args)),
    providerHealth: (args) =>
      withMaintenanceRuntime((runtime) => runtime.providerHealth(args)),
    providerUsage: (args) =>
      withMaintenanceRuntime((runtime) => runtime.providerUsage(args)),
    providerInstallationStatus: (args) =>
      withMaintenanceRuntime((runtime) =>
        runtime.providerInstallationStatus(args),
      ),
    providerInstallationRun: (args) =>
      withMaintenanceRuntime((runtime) =>
        runtime.providerInstallationRun(args),
      ),
    refreshShellEnv: async (args) => {
      await runtimeShellEnvCache.refresh(args);
    },
    resolveInteractiveRequest: async (request) => {
      interactiveRequestRegistry.resolve(request);
    },
    ensureConnectTunnelIdentity: () => connectTunnel.ensureTunnelIdentity(),
    serverMove,
    pluginHostManager,
    threadStorageRootPath,
    agentProcessContainment,
    commandMetadata,
    logger: options.logger,
    eventSink,
  });

  let requestDaemonRestart = (_exitCode: HostDaemonExitCode): void => undefined;
  let requestMachineShutdown = async (): Promise<void> => undefined;
  let restartRequested = false;

  const restartAfterUpdate = () => {
    if (restartRequested) return;
    restartRequested = true;

    const exitCode = protocolSelfUpdater.serviceInstallPending()
      ? HOST_DAEMON_SERVICE_INSTALL_EXIT_CODE
      : HOST_DAEMON_RESTART_EXIT_CODE;

    setTimeout(() => requestDaemonRestart(exitCode), 100).unref();
  };

  const runtimeVersion = await readWorkerRuntimeVersion({
    env: process.env,
    packageRoot: resolvePackagedOmnyoAppRoot(process.argv[1] ?? null),
  });

  const protocolSelfUpdater = createProtocolSelfUpdater({
    currentVersion: runtimeVersion,
    acquireUpdate: () => serverMove.tryAcquireRuntimeUpdateHold(0, updateOwner),
    protectUpdate: () => serverMove.restoreRuntimeUpdateHold(updateOwner),
    releaseUpdate: () => serverMove.releaseRuntimeUpdateHold(updateOwner),
    isIdle: () => serverMove.runtimeUpdateStatus().blockers.length === 0,
    onInstalled: restartAfterUpdate,
    installMode:
      process.platform !== "win32"
        ? "in-place"
        : options.windowsServiceInstall === true
          ? "service-handoff"
          : "unsupported",
    onBeforeRestart: (target) =>
      prepareWorkerIdentityAdoptionRestart({
        dataDir: options.dataDir,
        hostId: options.hostId,
        instanceId: options.instanceId,
        updateOwner,
        serverMove,
        target,
      }),
    prepareUpdate: async (signal) => {
      deliveryPaused = true;
      clearInteractiveInterruptRetry();
      interruptAbort?.abort();
      await Promise.all([
        eventSink.pauseForUpdate(signal),
        waitForUpdateCheckpoint(
          flushPendingInteractiveInterruptsPromise ?? Promise.resolve(),
          signal,
        ),
      ]);
      await deliveryCheckpoint.capture({
        events: eventSink.pendingEvents(),
        interrupts: [...pendingInteractiveInterrupts.values()],
        signal,
      });
    },
    resumeDelivery: () => {
      deliveryPaused = false;
      eventSink.resume();
      void flushPendingInteractiveInterrupts();
    },
    dataDir: options.dataDir,
    enabled: options.autoUpdate ?? false,
    fetchFn: options.fetchFn,
    logger: options.logger,
    serverUrl: options.serverUrl,
    machineCredential: options.serverHeaders?.["x-omnyo-connect-machine"],
  });

  const connection = new ServerConnection({
    serverUrl: options.serverUrl,
    hostKey: options.hostKey,
    hostId: options.hostId,
    hostName: options.hostName,
    dataDir: options.dataDir,
    instanceId: options.instanceId,
    localApiPort: options.localApiConfig?.port ?? null,
    logger: options.logger,
    serverHeaders: options.serverHeaders,
    serverClient,
    protocolSelfUpdater,
    onSelfUpdateInstalled: restartAfterUpdate,
    onMachineShutdown: () => requestMachineShutdown(),
    onInteractiveRequestsEnded: ({ reason, requests }) =>
      interactiveRequestRegistry.endRequests(requests, reason),
    onServerMoved: (notice) => serverMove.handleServerMoved(notice),
    onMachineEnvironment: (environment) =>
      machineEnvironment.replace(environment.entries),
    onDiagnosticsPolicy: setProcessErrorReportingEnabled,
    createWebSocket: options.createWebSocket,
    getActiveThreads: () => runtimeManager.listActiveThreads(),
    getUndeliveredEventThreadIds: () => eventSink.listUndeliveredThreadIds(),
    getOpenThreadWork: () =>
      collectOpenThreadWork({
        backgroundWork: runtimeManager.listOpenBackgroundWork(),
        interactiveRequests: interactiveRequestRegistry.listOpenRequests(),
      }),
    getLoadedEnvironments: () => runtimeManager.listLoadedEnvironments(),
    onHostRpcRequest: async (message) => {
      const response = await router.handleOnlineRpcRequest(message);
      sendServerMessage(response);
    },
    onCatalogRetain: (scopes) => commandMetadata.retain(scopes),
    onWatchSetReplace: async (message) => {
      for (const target of message.workspaceTargets)
        workspaceReads.trackEnvironment(
          target.environmentId,
          target.workspaceContext.workspacePath,
        );

      await watchManager.replaceWatchSet({
        generation: message.generation,
        workspaceTargets: message.workspaceTargets,
        threadStorageTargets: message.threadStorageTargets,
      });
    },
    onConnectSharesReplace: (message) => {
      connectTunnel.replaceShareSet({
        generation: message.generation,
        ports: message.ports,
      });
    },
    onTerminalMessage: async (message) => {
      try {
        serverMove.assertDirectAccessAdmission();
      } catch (error) {
        if (
          !(error instanceof ExpectedCommandDispatchError) ||
          (error.code !== "runtime_update_held" &&
            error.code !== "direct_access_held") ||
          (message.type !== "terminal.open" &&
            message.type !== "terminal.attach")
        )
          throw error;

        sendServerMessage({
          type: "terminal.error",
          requestId: message.requestId,
          terminalId: message.terminalId,
          code: error.code,
          message: error.message,
        });

        return;
      }

      return terminalManager.handleMessage(message);
    },
    onSessionOpened: async (session) => {
      commandMetadata.invalidate();
      sessionState.value = session.sessionId;

      if (session.endedInteractiveRequests.length > 0) {
        interactiveRequestRegistry.endRequests(
          session.endedInteractiveRequests,
          ENDED_INTERACTIVE_REQUEST_REASON,
        );
        options.logger.info(
          {
            requests: session.endedInteractiveRequests,
            sessionId: session.sessionId,
          },
          "Ended provider questions the server no longer waits on",
        );
      }

      connectTunnel.replaceAuthoritativeShareSet(session.connectShares);
      await pluginHostManager.reconcileGenerations(
        session.pluginHostGenerations,
      );

      if (session.retiredEnvironmentIds.length > 0) {
        await Promise.all(
          session.retiredEnvironmentIds.map((environmentId) =>
            runtimeManager.forgetEnvironment(environmentId),
          ),
        );
        options.logger.info(
          {
            environmentIds: session.retiredEnvironmentIds,
            sessionId: session.sessionId,
          },
          "Retired locally loaded environments after session reconciliation",
        );
      }

      await watchManager.replaceAuthoritativeWatchSet(session.watchSet);
      void eventSink.flush().catch((error) => {
        options.logger.warn(
          {
            sessionId: session.sessionId,
            ...runtimeErrorLogFields(error),
          },
          "Failed to flush pending daemon events after session opened",
        );
      });
      void flushPendingInteractiveInterrupts();
      void protocolSelfUpdater.checkForUpdates();
    },
    setSession: (session) => {
      sessionState.value = session?.sessionId ?? null;
      desktopBrowserBroker.setConnected(session !== null);

      if (session === null) {
        terminalManager.releaseOutputStreams();
        clearInteractiveInterruptRetry();
        interactiveInterruptRetryDelayMs = INTERACTIVE_INTERRUPT_RETRY_DELAY_MS;
      }
    },
  });

  sendServerMessage = (message) => connection.sendMessage(message);
  handleServerSessionInvalidated = (args) =>
    connection.handleSessionInvalidated(args);

  const localApi = options.localApiConfig
    ? await startLocalApiServer({
        dataDir: options.dataDir,
        hostId: options.hostId,
        localApiConfig: options.localApiConfig,
        serverUrl: options.serverUrl,
        serverPort: Number(new URL(options.serverUrl).port) || 0,
        devAppPort: options.devAppPort,
        appUrl: options.appUrl,
        getConnected: () => connection.sessionId != null,
        management: {
          hostKey: options.hostKey,
          getStatus: () => ({
            managementVersion: 1,
            hostId: options.hostId,
            instanceId: options.instanceId,
            runtimeVersion: runtimeVersion ?? null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            serverUrl: options.serverUrl,
            connected: connection.sessionId !== null,
            automaticUpdates: options.autoUpdate ?? false,
            admission: serverMove.runtimeUpdateStatus(),
            pluginBlockers: pluginHostManager.getRuntimeUpdateBlockers(),
            update: protocolSelfUpdater.getStatus(),
          }),
          requestUpdate: async (target) => {
            const result = await protocolSelfUpdater.requestUpdate(target);

            if (result === "updated") restartAfterUpdate();

            return result;
          },
        },
        shellEnv: () => runtimeManager.getShellEnv(),
      })
    : null;

  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger: options.logger,
  });

  const hostDaemonHealthMonitor = startHostDaemonHealthMonitor({
    logger: options.logger,
    getWatchCounts: () => ({
      workspaceWatches: watchManager.workspaceWatchCount(),
      threadStorageTargets: watchManager.threadStorageWatchTargetCount(),
    }),
  });

  const daemon = createDaemon({
    identity: {
      hostId: options.hostId,
      hostName: options.hostName,
      instanceId: options.instanceId,
    },
    logger: options.logger,
    releaseLock: options.releaseLock,
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
    flushEvents: async () => {
      await eventSink.flush();
    },
    shutdownRuntimes: async () => {
      previewTransport.dispose();
      await managedPreviews.shutdown();
      await router.shutdownFilesystemMutations();
      await desktopBrowserBroker.close();
      idleProviderSessionReaper.stop();
      eventLoopStallMonitor.stop();
      hostDaemonHealthMonitor.stop();
      await pluginHostManager.shutdown();
      await options.closeMachineAuthProxy?.();
      await localApi?.close();
      connectTunnel.shutdown();
      await commandMetadata.dispose();
      await drainIsolatedFilesystemReaders();
      await watchManager.shutdown();
      await terminalManager.shutdownAll();
      terminalManager.dispose();
      await runtimeManager.shutdownAll();
      agentProcessContainment?.dispose();
      await eventSink.flush();
      await eventSink.dispose();
      await connection.shutdown();
      machineEnvironment.replace([]);
    },
    onStart: async () => {
      options.logger.info(
        { dataDir: options.dataDir, serverUrl: options.serverUrl },
        "Host daemon connecting",
      );
      startFileChunkReader();
      await connection.start();
    },
  });

  requestDaemonRestart = (exitCode) => {
    void daemon.shutdown("self-update", exitCode).catch((error) => {
      options.logger.error({ err: error }, "Self-update shutdown failed");
    });
  };

  requestMachineShutdown = async () => {
    await writeMachineSuspensionMarker(options.dataDir);
    sendServerMessage({ type: "machine.shutdown-ack" });
    await daemon.shutdown("machine-shutdown", 0);
  };

  requestServerMoveShutdown = (reason, exitCode) =>
    daemon.shutdown(reason, exitCode);
  void serverMove.resumeActivation().catch((error: unknown) => {
    options.logger.error(
      { ...runtimeErrorLogFields(error) },
      "Failed to resume the server move activation",
    );
  });
  connection.setSessionCloseHandler((reason) =>
    daemon.shutdown(`session-close:${reason}`, 0),
  );

  return {
    daemon,
    eventSink,
    localApi,
    runtimeManager,
    watchManager,
    connectTunnel,
    terminalManager,
    router,
    connection,
  };
}

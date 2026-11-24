import { ServerCommandMetadata } from "./services/skills/command-metadata.js";
import {
  admitConfiguredOmnyoStateWrites,
  retireCompletedOmnyoStateAdmissionV1,
} from "@omnyo/config/omnyo-state-startup";
import { ProjectCommandCatalogs } from "./services/threads/project-command-catalogs.js";
import { randomUUID } from "node:crypto";
import { ApiError } from "./errors.js";
import { readPrimaryHostIdFromDataDir } from "./services/hosts/primary-host-id.js";
import { closeThreadTimelinePageBuilders } from "./services/threads/timeline-page-builder.js";
import { requestQueuedMessageDispatch } from "./services/threads/queued-message-dispatch.js";
import {
  readRuntimeIdentity,
  verifyRuntimeIdentity,
  verifyHeldRuntimeRepair,
} from "@omnyo/server-archive";
import { ensureStartupHold } from "./services/maintenance/startup-hold.js";
import { prepareStaticAppAssets } from "./services/system/static-app-assets.js";
import {
  setMaintenanceFrozen,
  setServerMoveFrozen,
} from "./services/server-move/freeze-state.js";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@omnyo/host-daemon-contract";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerConfig } from "@omnyo/config/server";
import { isLoopbackHostname } from "@omnyo/config/loopback";
import { toOptionalString } from "@omnyo/config/strings";
import { createLogger } from "@omnyo/logger";
import {
  captureProcessError,
  exitAfterFlushingProcessErrorReports,
  readProcessErrorReportingStatus,
  resolveProcessErrorReportingStatus,
  setProcessErrorReportingEnabled,
} from "@omnyo/process-utils/error-reporting";
import {
  getAppSettings,
  getDisabledProviderIds,
  primeThreadUpdateActivity,
  getSessionById,
} from "@omnyo/db";
import { initDb } from "./db.js";
import { createApp } from "./server.js";
import { PendingInteractionLifecycle } from "./services/interactions/pending-interactions.js";
import { createMachineAuthService } from "./services/machine-auth.js";
import { openServerVault } from "./services/system/server-vault.js";
import { resolveBuiltinSkillsRootPath } from "./services/skills/builtin-skills-copy.js";
import { SkillTreeRegistry } from "./services/skills/injected-skills.js";
import { PluginHostArtifactRegistry } from "./services/plugins/plugin-host-artifact-registry.js";
import { createProviderNativeRootsCache } from "./services/providers/native-roots.js";
import { createAiServiceRegistry } from "./services/ai/ai-service-registry.js";
import { createAppUpdateService } from "./services/system/app-update.js";
import { countRunningThreadsForAppUpdate } from "./services/threads/thread-runtime-display.js";
import {
  readBundledPluginName,
  readPrivateDeliverySnapshot,
} from "./services/system/private-delivery-guard.js";
import { createAppVersionService } from "./services/system/app-version.js";
import { createLauncherChannel } from "./services/system/launcher-channel.js";
import { setServerUpdateDraining } from "./services/system/server-update-drain.js";
import { createOmnyoAppManagedConfigReloader } from "./services/system/managed-app-config.js";
import { startGatedPerformanceDiagnostics } from "./services/system/performance-diagnostics.js";
import { startEventLoopStallMonitor } from "./services/system/event-loop-stall-monitor.js";
import { currentEventLoopWorkLabel } from "./services/system/event-loop-work.js";
import {
  runPeriodicSweeps,
  runStartupRecoverySweep,
} from "./services/system/periodic-sweeps.js";
import { installProviderModelCatalogPrewarm } from "./services/providers/provider-model-catalog-prewarm.js";
import { installVoiceInputPrewarm } from "./services/ai/voice-prepare.js";
import { installProjectRemoteSync } from "./services/projects/project-remote-sync.js";
import {
  createProviderRegistryService,
  type ProviderRegistryService,
} from "./services/providers/provider-registry.js";
import type { PluginService } from "./services/plugins/plugin-service.js";
import { createTelemetryService } from "./services/system/telemetry.js";
import { TerminalSessionLifecycle } from "./services/terminals/terminal-session-lifecycle.js";
import { createLifecycleDedupers } from "./lifecycle-dedupers.js";
import type { ServerLogger, ServerRuntimeConfig } from "./types.js";
import { NotificationHub } from "./ws/hub.js";
import { startDaemonLivenessChecks } from "./ws/daemon-protocol.js";
import { WatchInterestCoordinator } from "./ws/watch-interests.js";
import { WorkspaceReadCaches } from "./services/environments/workspace-read-cache.js";
import { HostSharedPortCoordinator } from "./ws/host-shared-ports.js";
import { disconnectImportedDaemonSessions } from "./internal/session-owner-side-effects.js";
import {
  applyServerImportAtBoot,
  refuseInterruptedServerImport,
  repairLastServerMoveHostName,
} from "./services/server-move/pending-boot.js";
import { createConnectHold } from "./services/server-move/connect-hold.js";
import { stopRunningWorkForAppUpdate } from "./services/server-move/stop-work.js";
import { isServerMoveFrozen } from "./services/server-move/freeze-state.js";
import { reconcileServerMoveRunAtBoot } from "./services/server-move/reconcile.js";
import {
  retireServerProcess as retireProcessWithDeadline,
  SERVER_RETIRE_FORCE_EXIT_MS,
} from "./services/server-move/retire.js";
import {
  PluginToolCallRegistry,
  setPluginToolCallRegistry,
} from "./services/plugins/plugin-tool-calls.js";
import { startHttpListener } from "./http-listener.js";

export interface StartServerPluginsArgs {
  dataDir: string;
  logger: Pick<ServerLogger, "error" | "warn">;
  pluginService: Pick<PluginService, "start" | "startPeriodicUpdateChecks">;
  providerRegistry: Pick<ProviderRegistryService, "markRegistrationsSettled">;
}

export function startServerPlugins(
  args: StartServerPluginsArgs,
): Promise<void> {
  return args.pluginService
    .start({
      hold: createConnectHold({ dataDir: args.dataDir, logger: args.logger }),
    })
    .catch((error) => {
      args.logger.error({ err: error }, "Plugin startup failed");
    })
    .finally(() => {
      args.providerRegistry.markRegistrationsSettled();
      args.pluginService.startPeriodicUpdateChecks();
    });
}

export function getRuntimeBuildIdentity() {
  return { hostDaemonProtocolVersion: HOST_DAEMON_PROTOCOL_VERSION };
}

export async function runServer(serverConfig: ServerConfig): Promise<void> {
  await admitConfiguredOmnyoStateWrites(serverConfig.OMNYO_DATA_DIR);
  const bootMaintenanceHold = await ensureStartupHold(serverConfig);
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const packaged = existsSync(join(packageRoot, "dist", "omnyo-app.js"));

  const runtimeIdentity = packaged
    ? await verifyRuntimeIdentity(
        packageRoot,
        await readRuntimeIdentity(packageRoot),
      )
    : null;

  if (
    runtimeIdentity !== null &&
    runtimeIdentity.hostDaemonProtocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
  )
    throw new Error("Packaged runtime protocol identity mismatch");

  await verifyHeldRuntimeRepair(
    serverConfig.OMNYO_DATA_DIR,
    bootMaintenanceHold,
    runtimeIdentity,
    packageRoot,
  );

  const runtimeVersion =
    runtimeIdentity?.runtimeVersion ?? serverConfig.OMNYO_APP_VERSION;

  const bootMaintenanceHeld =
    bootMaintenanceHold !== null && bootMaintenanceHold.phase !== "released";

  const logger = createLogger({
    component: "server",
    dataDir: serverConfig.OMNYO_DATA_DIR,
  });

  if (!bootMaintenanceHeld)
    await retireCompletedOmnyoStateAdmissionV1(
      serverConfig.OMNYO_DATA_DIR,
    ).catch((error: unknown) => {
      logger.warn(
        { err: error },
        "Could not retire the completed state migration record; it will be retried at the next start",
      );
    });

  await refuseInterruptedServerImport({
    dataDir: serverConfig.OMNYO_DATA_DIR,
    logger,
  });

  const vault = await openServerVault({
    dataDir: serverConfig.OMNYO_DATA_DIR,
    logger,
  });

  let diagnosticsEnabled = () => false;

  const db = initDb(serverConfig.databasePath, {
    slowQueryThresholdMs: () => (diagnosticsEnabled() ? 25 : 100),
    slowQueryDiagnosticsEnabled: () => diagnosticsEnabled(),
    slowQueryWork: currentEventLoopWorkLabel,
    dataDir: serverConfig.OMNYO_DATA_DIR,
    logger,
  });

  const crashReportsEnabled = getAppSettings(db).crashReportsEnabled;
  setProcessErrorReportingEnabled(
    crashReportsEnabled &&
      resolveProcessErrorReportingStatus({
        dsn: serverConfig.OMNYO_SENTRY_DSN,
        nodeEnv: process.env.NODE_ENV,
        release: serverConfig.OMNYO_APP_VERSION,
      }).enabled,
  );

  const errorReporting = readProcessErrorReportingStatus({
    dsn: serverConfig.OMNYO_SENTRY_DSN,
    nodeEnv: process.env.NODE_ENV,
    release: serverConfig.OMNYO_APP_VERSION,
  });

  logger.info(
    {
      crashReportsEnabled,
      sentryErrorReporting: errorReporting.enabled
        ? "enabled"
        : errorReporting.reason,
    },
    errorReporting.enabled
      ? "Sentry error reporting enabled"
      : "Sentry error reporting disabled",
  );

  setMaintenanceFrozen(db, bootMaintenanceHeld);

  const serverImport = await applyServerImportAtBoot({
    dataDir: serverConfig.OMNYO_DATA_DIR,
    db,
    logger,
    now: Date.now(),
    vault,
  });

  const pendingServerMove = serverImport.pendingMove;

  if (pendingServerMove === null) {
    await repairLastServerMoveHostName({
      dataDir: serverConfig.OMNYO_DATA_DIR,
      db,
      logger,
    });
  }

  const serverMoveRun =
    pendingServerMove === null
      ? await reconcileServerMoveRunAtBoot({
          dataDir: serverConfig.OMNYO_DATA_DIR,
          logger,
          now: Date.now(),
        })
      : null;

  if (serverMoveRun?.kind === "recovery_required")
    setServerMoveFrozen(db, true);
  const hub = new NotificationHub();
  const watchInterests = new WatchInterestCoordinator({ db, hub });
  const sharedPorts = new HostSharedPortCoordinator({ db, hub });
  const workspaceReadCaches = new WorkspaceReadCaches({ hub });
  const lifecycleDedupers = createLifecycleDedupers();
  const appUrl = toOptionalString(serverConfig.OMNYO_APP_URL);

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const appDir = resolve(selfDir, "../../app");
  const appDistDir = join(appDir, "dist");
  const isProduction = process.env.NODE_ENV === "production";

  const staticDir =
    isProduction && existsSync(appDistDir) ? appDistDir : undefined;

  const retainedStaticDirs = staticDir
    ? await prepareStaticAppAssets({
        staticDir,
        dataDir: serverConfig.OMNYO_DATA_DIR,
      })
    : [];

  const runtimeConfig: ServerRuntimeConfig = {
    appAliasOrigins: serverConfig.OMNYO_APP_ALIAS_URLS,
    appVersion: runtimeVersion,
    builtinSkillsRootPath: resolveBuiltinSkillsRootPath(),
    customModels: [],
    dataDir: serverConfig.OMNYO_DATA_DIR,
    featureFlags: serverConfig.featureFlags,
    hostDaemonPort: serverConfig.OMNYO_HOST_DAEMON_PORT,
    inheritedSkillsRootPaths: serverConfig.OMNYO_INHERITED_SKILLS_ROOTS,
    isDevelopment: !isProduction,
    performanceDiagnosticsAvailable: serverConfig.OMNYO_PERF_DIAGNOSTICS,
    serverPort: serverConfig.OMNYO_SERVER_PORT,
    sharedSkillRoots: { user: [], project: [] },
  };

  const providerRegistry = createProviderRegistryService({
    deferRegistrationsSettled: true,
    readUserProviderPreferences: () => {
      const settings = getAppSettings(db);

      return {
        providerOrder: settings.providerOrder,
        disabledProviderIds: getDisabledProviderIds(db),
        defaultProviderId: settings.defaultProviderId,
      };
    },
  });

  if (appUrl !== undefined) {
    runtimeConfig.appUrl = appUrl;
  }

  if (serverConfig.OMNYO_DEV_APP_PORT !== undefined) {
    runtimeConfig.devAppPort = serverConfig.OMNYO_DEV_APP_PORT;
  }

  if (
    resolveProcessErrorReportingStatus({
      dsn: serverConfig.OMNYO_SENTRY_DSN,
      nodeEnv: process.env.NODE_ENV,
      release: runtimeVersion,
    }).enabled
  ) {
    runtimeConfig.errorReportingDsn = serverConfig.OMNYO_SENTRY_DSN.trim();
  }

  if (serverConfig.OMNYO_SERVER_LAUNCH_ID !== undefined) {
    runtimeConfig.launchId = serverConfig.OMNYO_SERVER_LAUNCH_ID;
  }

  const terminalSessions = new TerminalSessionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    logger,
    vault,
  });

  const omnyoAppManagedConfig = await createOmnyoAppManagedConfigReloader({
    config: runtimeConfig,
    hub,
    logger,
  });

  const telemetry = await createTelemetryService({
    collectorUrl: serverConfig.OMNYO_USAGE_COLLECTOR_URL,
    countRegion: serverConfig.OMNYO_USAGE_COUNT_REGION,
    db,
    appVersion: runtimeVersion,
    dataDir: serverConfig.OMNYO_DATA_DIR,
    enabled:
      serverConfig.OMNYO_TELEMETRY &&
      isProduction &&
      pendingServerMove === null,
    logger,
  });

  const machineAuth = await createMachineAuthService({
    db,
    logger,
    vault,
  });

  await machineAuth.ensureReady();
  const skillTreeRegistry = new SkillTreeRegistry();

  const commandMetadata = new ServerCommandMetadata({
    config: runtimeConfig,
    logger,
  });

  const pluginHostArtifacts = new PluginHostArtifactRegistry();
  const providerNativeRoots = createProviderNativeRootsCache();

  const aiServices = createAiServiceRegistry({
    onStatusChange: () => hub.notifySystem(["config-changed"]),
  });

  const pendingInteractions = new PendingInteractionLifecycle({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    vault,
  });

  if (!bootMaintenanceHeld && !isServerMoveFrozen(db))
    pendingInteractions.start();
  setPluginToolCallRegistry(new PluginToolCallRegistry({ logger }));

  const appVersion = createAppVersionService({
    installKind: serverConfig.OMNYO_APP_INSTALL_KIND ?? null,
    sourceCommit: serverConfig.OMNYO_APP_SOURCE_COMMIT ?? null,
    config: runtimeConfig,
  });

  const appUpdateMode = serverConfig.OMNYO_APP_UPDATE_MODE ?? null;

  const updateHostId = readPrimaryHostIdFromDataDir({
    dataDir: serverConfig.OMNYO_DATA_DIR,
  });

  const requestUpdateAdmission = async (
    command:
      | {
          type: "runtime_update.acquire";
          ownerId: string;
          closePluginLeases: string[];
        }
      | { type: "runtime_update.release"; ownerId: string },
  ): Promise<void> => {
    const sessionId =
      updateHostId === null
        ? null
        : hub.getDaemonSessionIdForHost(updateHostId);

    const session =
      sessionId === null ? null : getSessionById(db, { sessionId });

    if (
      updateHostId === null ||
      session?.protocolVersion !== HOST_DAEMON_PROTOCOL_VERSION
    )
      throw new ApiError(
        409,
        "runtime_update_busy",
        "The primary worker is not ready for guarded updates.",
      );

    const response = await hub.requestHostOnlineRpc({
      hostId: updateHostId,
      message: {
        type: "host-rpc.request",
        requestId: randomUUID(),
        command,
      },
      timeoutMs: 15_000,
    });

    if (!response.ok)
      throw new ApiError(409, response.errorCode, response.errorMessage);

    if (response.commandType !== command.type)
      throw new Error(
        "Worker update admission returned an unexpected response",
      );
  };

  primeThreadUpdateActivity(db);

  const appUpdate = createAppUpdateService({
    currentCommit:
      serverConfig.OMNYO_APP_INSTALL_KIND === "source"
        ? (serverConfig.OMNYO_APP_SOURCE_COMMIT ?? null)
        : null,
    appSurface: serverConfig.OMNYO_APP_SURFACE,
    config: runtimeConfig,
    countRunningThreads: () => countRunningThreadsForAppUpdate({ db, hub }),
    acquireRestartHold: (ownerId, closePluginLeases) =>
      requestUpdateAdmission({
        type: "runtime_update.acquire",
        ownerId,
        closePluginLeases: [...closePluginLeases],
      }),
    releaseRestartHold: (ownerId) =>
      requestUpdateAdmission({ type: "runtime_update.release", ownerId }),
    dataDir: serverConfig.OMNYO_DATA_DIR,
    launcher: appUpdateMode === null ? null : createLauncherChannel(process),
    logger,
    mode: appUpdateMode,
    privateDelivery: {
      snapshot: () =>
        readPrivateDeliverySnapshot({
          dataDir: serverConfig.OMNYO_DATA_DIR,
          db,
        }),
      bundledName: async (pluginId) => readBundledPluginName({ db, pluginId }),
      flush: async () => {
        await Promise.all([
          webUpdate.flush(),
          pluginService.flushRegistrationOperations(),
        ]);
      },
    },
    notifyChanged: () => hub.notifySystem(["app-update-changed"]),
    stopRunningThreads: (stopArgs) =>
      stopRunningWorkForAppUpdate(sweepDeps, stopArgs),
    setDraining: (draining) => {
      setServerUpdateDraining(db, draining);

      if (!draining) {
        requestQueuedMessageDispatch(sweepDeps, {
          kind: "idle-recovery",
          now: Date.now(),
        });
      }
    },
  });

  const appDeps = {
    appUpdate,
    appVersion,
    managedAppConfig: omnyoAppManagedConfig,
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    providerNativeRoots,
    aiServices,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    vault,
    watchInterests,
    sharedPorts,
    workspaceReadCaches,
    commandMetadata,
  };

  const commandCatalogs = new ProjectCommandCatalogs(appDeps);

  const {
    app,
    closeWebSockets,
    injectWebSocket,
    pluginCatalogService,
    pluginService,
    maintenance,
    serverMove,
    webUpdate,
  } = createApp(
    { ...appDeps, commandCatalogs },
    {
      serverMove: {
        appSurface: serverConfig.OMNYO_APP_SURFACE,
        bindHost: serverConfig.OMNYO_SERVER_BIND_HOST,
        manualImportPending: serverImport.manualImportPending,
        pending: pendingServerMove,
        restoredRun: serverMoveRun,
        retireProcess: retireServerProcess,
      },
      staticDir,
      retainedStaticDirs,
      performanceDiagnosticsEnabled: () => diagnosticsEnabled(),
    },
  );

  disconnectImportedDaemonSessions(
    {
      config: runtimeConfig,
      db,
      hub,
      lifecycleDedupers,
      logger,
      machineAuth,
      pendingInteractions,
      providerRegistry,
      pluginHostArtifacts,
      aiServices,
      skillTreeRegistry,
      telemetry,
      terminalSessions,
      vault,
    },
    { sessions: serverImport.importedDaemonSessions },
  );

  const performanceDiagnostics = await startGatedPerformanceDiagnostics({
    allowed: serverConfig.OMNYO_PERF_DIAGNOSTICS,
    dataDir: serverConfig.OMNYO_DATA_DIR,
    db,
    hub,
    logger,
  });

  diagnosticsEnabled = performanceDiagnostics.isEnabled;

  const eventLoopStallMonitor = startEventLoopStallMonitor({
    logger,
    resourceSamplerPath: fileURLToPath(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../dist/stall-resource-sampler"
          : "./stall-resource-sampler",
        import.meta.url,
      ),
    ),
    thresholdMs: () => (diagnosticsEnabled() ? 100 : 500),
  });

  const stopDaemonLivenessChecks = startDaemonLivenessChecks({
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    sharedPorts,
    skillTreeRegistry,
    telemetry,
    terminalSessions,
    vault,
  });

  const sweepDeps = {
    config: runtimeConfig,
    db,
    hub,
    lifecycleDedupers,
    logger,
    machineAuth,
    pendingInteractions,
    providerRegistry,
    pluginHostArtifacts,
    aiServices,
    skillTreeRegistry,
    pluginSchedules: pluginService,
    plugins: pluginService,
    telemetry,
    terminalSessions,
    vault,
  };

  let providerModelCatalogPrewarm =
    pendingServerMove === null && !bootMaintenanceHeld
      ? installProviderModelCatalogPrewarm(sweepDeps)
      : null;

  let voiceInputPrewarm =
    pendingServerMove === null && !bootMaintenanceHeld
      ? installVoiceInputPrewarm(sweepDeps)
      : null;

  let projectRemoteSync =
    pendingServerMove === null && !bootMaintenanceHeld
      ? installProjectRemoteSync(sweepDeps)
      : null;

  if (
    pendingServerMove === null &&
    !bootMaintenanceHeld &&
    !isServerMoveFrozen(db)
  ) {
    await runStartupRecoverySweep(sweepDeps).catch((error) => {
      logger.error({ err: error }, "Startup recovery sweep failed");
    });
  }

  if (!isLoopbackHostname(serverConfig.OMNYO_SERVER_BIND_HOST)) {
    logger.warn(
      { bindHost: serverConfig.OMNYO_SERVER_BIND_HOST },
      "SECURITY WARNING: The public API is unauthenticated and permits command execution and file reads. Wildcard server binding must only be used behind a trusted network boundary.",
    );
  }

  const server = startHttpListener({
    fetch: app.fetch,
    logger,
    serverConfig,
  });

  injectWebSocket(server);

  logger.info(
    {
      bindHost: serverConfig.OMNYO_SERVER_BIND_HOST,
      port: serverConfig.OMNYO_SERVER_PORT,
      dataDir: serverConfig.OMNYO_DATA_DIR,
    },
    "Server listening",
  );
  pluginService.bindSdk({
    baseUrl: `http://127.0.0.1:${serverConfig.OMNYO_SERVER_PORT}`,
  });
  let sweepInterval: ReturnType<typeof setInterval> | null = null;

  if (pendingServerMove === null && !bootMaintenanceHeld) {
    if (serverMoveRun?.kind === "completed") {
      logger.info(
        { moveId: serverMoveRun.run.status.moveId },
        "This server already moved before it restarted; retiring without starting plugins",
      );
      providerRegistry.markRegistrationsSettled();
    } else {
      void startServerPlugins({
        dataDir: serverConfig.OMNYO_DATA_DIR,
        logger,
        pluginService,
        providerRegistry,
      }).finally(() => {
        void serverMove.handlePluginsStarted();
      });
    }

    pluginCatalogService.startPeriodicRefresh();
    sweepInterval = setInterval(() => {
      telemetry.prune();

      if (!isServerMoveFrozen(db)) {
        void runPeriodicSweeps(sweepDeps);
      }
    }, 10_000);
    sweepInterval.unref();
  } else {
    logger.info(
      { moveId: pendingServerMove?.moveId ?? bootMaintenanceHold?.id },
      "Server started in pending move mode; waiting for the target machine to activate it",
    );
  }

  maintenance.bindFrameworkResume(
    async () => {
      providerRegistry.markRegistrationsSettled();
    },
    () => {
      pendingInteractions.start();
      providerModelCatalogPrewarm ??=
        installProviderModelCatalogPrewarm(sweepDeps);
      voiceInputPrewarm ??= installVoiceInputPrewarm(sweepDeps);
      projectRemoteSync ??= installProjectRemoteSync(sweepDeps);
      void runStartupRecoverySweep(sweepDeps).catch((error: unknown) =>
        logger.error({ err: error }, "Released maintenance recovery failed"),
      );
      pluginService.startPeriodicUpdateChecks();
      pluginCatalogService.startPeriodicRefresh();

      if (sweepInterval === null) {
        sweepInterval = setInterval(() => {
          telemetry.prune();

          if (!isServerMoveFrozen(db)) void runPeriodicSweeps(sweepDeps);
        }, 10_000);
        sweepInterval.unref();
      }
    },
    async () => {
      providerModelCatalogPrewarm?.stop();
      providerModelCatalogPrewarm = null;
      voiceInputPrewarm?.stop();
      voiceInputPrewarm = null;
      projectRemoteSync?.stop();
      projectRemoteSync = null;
      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();

      if (sweepInterval !== null) {
        clearInterval(sweepInterval);
        sweepInterval = null;
      }
    },
  );
  let shutdownPromise: Promise<void> | null = null;

  const runShutdown = (): Promise<void> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      telemetry.stop();
      await commandCatalogs.dispose();
      await commandMetadata.dispose();
      serverMove.dispose();
      appUpdate.dispose();
      providerModelCatalogPrewarm?.stop();
      voiceInputPrewarm?.stop();
      projectRemoteSync?.stop();
      eventLoopStallMonitor.stop();
      await performanceDiagnostics.stop();
      stopDaemonLivenessChecks();

      if (sweepInterval !== null) {
        clearInterval(sweepInterval);
      }

      pluginCatalogService.stopPeriodicRefresh();
      await pluginService.stopPeriodicUpdateChecks();

      if (pendingServerMove === null) {
        await pluginService.stop().catch((error) => {
          logger.warn({ err: error }, "Plugin shutdown failed");
        });
      }

      const closeServer = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);

            return;
          }

          resolve();
        });
      });

      await closeWebSockets();
      await closeThreadTimelinePageBuilders(db);
      await closeServer;
    })();

    return shutdownPromise;
  };

  function retireServerProcess(): void {
    logger.info({}, "Server moved to another machine; shutting down");
    retireProcessWithDeadline({
      exit: (code) => process.exit(code),
      forceExitAfterMs: SERVER_RETIRE_FORCE_EXIT_MS,
      shutdown: runShutdown,
    });
  }

  let exitingAfterUncaughtException = false;

  process.on("uncaughtException", (error: unknown) => {
    if (pluginService.handleUncaughtException(error)) return;

    const message =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    process.stderr.write(`${message}\n`);

    if (exitingAfterUncaughtException) return;
    exitingAfterUncaughtException = true;
    captureProcessError(error, { level: "fatal", stage: "uncaught-exception" });
    exitAfterFlushingProcessErrorReports(1);
  });

  process.once("SIGINT", () => {
    void runShutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void runShutdown().finally(() => process.exit(0));
  });
}

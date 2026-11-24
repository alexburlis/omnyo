import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { loadHostDaemonStartConfig } from "@omnyo/config/host-daemon";
import { admitConfiguredOmnyoStateWrites } from "@omnyo/config/omnyo-state-startup";
import { createLogger } from "@omnyo/logger";
import { enableProcessLauncherWorker } from "@omnyo/process-utils";
import type { ProcessErrorReportingStatus } from "@omnyo/process-utils/error-reporting";
import { createHostDaemonApp } from "./app.js";
import {
  readHostAuthState,
  resolveServerUrl,
  writeHostAuthState,
} from "./auth-state.js";
import type { HostDaemon } from "./daemon.js";
import { enrollDaemonHost } from "./enroll.js";
import { loadHostIdentity, persistHostId } from "./identity.js";
import { acquireDaemonLock } from "./lock.js";
import { resolveHostDaemonLocalApiConfig } from "./local-api-config.js";
import {
  createUserShellPathResolver,
  prepareRuntimeShellEnv,
  resolvePowerShellExecutionPolicyDefault,
  resolveOmnyoExecutablePathInDirectory,
  resolveLocalOmnyoExecutablePath,
} from "./runtime-shell-env.js";
import type { HostDaemonLogger } from "./logger.js";
import {
  startMachineAuthProxy,
  type MachineAuthProxy,
} from "./machine-auth-proxy.js";

interface StartHostDaemonOptions {
  enrollKey?: string;
  errorReporting: ProcessErrorReportingStatus;
  hostId?: string;
  cliExecutableDirectory?: string;
  bridgeBundleDir?: string;
  serverHeaders?: Record<string, string>;
  autoUpdate?: boolean;
  supervised?: boolean;
  windowsServiceInstall?: boolean;
}

export async function startHostDaemon(
  options: StartHostDaemonOptions,
): Promise<HostDaemon> {
  const resolvedConfig = loadHostDaemonStartConfig({});
  const dataDir = resolvedConfig.dataDir;
  await admitConfiguredOmnyoStateWrites(dataDir);
  enableProcessLauncherWorker();
  const hostDaemonConfig = resolvedConfig.connectionConfig;
  let lockDiagnosticsLogger: HostDaemonLogger | null = null;
  let handleDaemonLockLost: () => void = () => process.exit(1);

  const releaseLock = await acquireDaemonLock(dataDir, {
    logger: {
      warn: (fields, message) => {
        if (lockDiagnosticsLogger) {
          lockDiagnosticsLogger.warn(fields, message);
        } else {
          console.warn(message, fields);
        }
      },
      error: (fields, message) => {
        if (lockDiagnosticsLogger) {
          lockDiagnosticsLogger.error(fields, message);
        } else {
          console.error(message, fields);
        }
      },
    },
    onLockLost: () => handleDaemonLockLost(),
  });

  let app: Awaited<ReturnType<typeof createHostDaemonApp>> | undefined;
  let machineAuthProxy: MachineAuthProxy | undefined;

  try {
    const persistedAuth = await readHostAuthState(dataDir);

    const identity = await loadHostIdentity({
      dataDir,
      providedHostId: options.hostId,
    });

    const instanceId = randomUUID();

    const serverUrl = resolveServerUrl({
      providedServerUrl: hostDaemonConfig.OMNYO_SERVER_URL,
    });

    if (!serverUrl) {
      throw new Error("Host daemon server URL is required");
    }

    if (persistedAuth && persistedAuth.hostId !== identity.hostId) {
      throw new Error(
        `Resolved host ID ${identity.hostId} does not match persisted auth state ${persistedAuth.hostId}`,
      );
    }

    const hostKey =
      persistedAuth?.hostKey ??
      (
        await enrollDaemonHost({
          hostId: identity.hostId,
          hostName: identity.hostName,
          serverUrl,
          serverHeaders: options.serverHeaders,
          token:
            options.enrollKey ??
            (() => {
              throw new Error(
                `Missing host bootstrap material. Provide OMNYO_HOST_ENROLL_KEY or populate ${dataDir}/auth.json first.`,
              );
            })(),
        })
      ).hostKey;

    if (!persistedAuth) {
      await persistHostId({ dataDir, hostId: identity.hostId });
      await writeHostAuthState(dataDir, {
        hostId: identity.hostId,
        hostKey,
      });
    }

    const localApiConfig = resolveHostDaemonLocalApiConfig({
      hostDaemonPort: hostDaemonConfig.OMNYO_HOST_DAEMON_PORT,
    });

    const omnyoExecutablePath =
      options.cliExecutableDirectory !== undefined
        ? resolveOmnyoExecutablePathInDirectory(options.cliExecutableDirectory)
        : await resolveLocalOmnyoExecutablePath();

    const omnyoExecutableDirectory = dirname(omnyoExecutablePath);

    const logger = createLogger({
      component: "host-daemon",
      base: { serverUrl },
      dataDir,
    });

    lockDiagnosticsLogger = logger;

    const errorReporting = options.errorReporting;

    logger.info(
      {
        crashReportsChoice: "awaiting-current-server-policy",
        crashReportsEnabled: false,
        sentryErrorReporting: errorReporting.enabled
          ? "enabled"
          : errorReporting.reason,
      },
      errorReporting.enabled
        ? "Sentry error reporting enabled"
        : "Sentry error reporting disabled",
    );

    if (options.serverHeaders !== undefined) {
      machineAuthProxy = await startMachineAuthProxy({
        serverHeaders: options.serverHeaders,
        serverUrl,
      });
    }

    const resolveUserShellPath = createUserShellPathResolver();

    const resolveRuntimeShellEnv = async () =>
      prepareRuntimeShellEnv({
        cliExecutableDirectory: omnyoExecutableDirectory,
        cliExecutablePath: omnyoExecutablePath,
        hostDaemonPort: localApiConfig.port,
        inheritedPath: (await resolveUserShellPath()) ?? process.env.PATH,
        powershellExecutionPolicy:
          await resolvePowerShellExecutionPolicyDefault(),
        serverUrl: machineAuthProxy?.serverUrl ?? serverUrl,
      });

    const runtimeShellEnv = await resolveRuntimeShellEnv();
    const runtimeShellEnvResolvedAtMs = Date.now();
    app = await createHostDaemonApp({
      dataDir,
      serverUrl,
      hostKey,
      serverHeaders: options.serverHeaders,
      autoUpdate: options.autoUpdate,
      supervised: options.supervised,
      windowsServiceInstall: options.windowsServiceInstall,
      bridgeBundleDir: options.bridgeBundleDir,
      hostId: identity.hostId,
      hostName: identity.hostName,
      instanceId,
      appUrl:
        hostDaemonConfig.OMNYO_APP_URL === ""
          ? undefined
          : hostDaemonConfig.OMNYO_APP_URL,
      devAppPort: hostDaemonConfig.OMNYO_DEV_APP_PORT,
      logger,
      releaseLock,
      localApiConfig,
      runtimeShellEnv,
      runtimeShellEnvResolvedAtMs,
      resolveRuntimeShellEnv,
      closeMachineAuthProxy: machineAuthProxy?.close,
      exitProcess: (code) => process.exit(code),
    });
    const startedApp = app;
    handleDaemonLockLost = () => {
      void startedApp.daemon
        .shutdown("daemon-lock-lost", 1)
        .catch(() => process.exit(1));
    };

    await app.daemon.start();

    return app.daemon;
  } catch (error) {
    if (!app) {
      await machineAuthProxy?.close().catch(() => undefined);
      await releaseLock().catch(() => undefined);
    }

    throw error;
  }
}

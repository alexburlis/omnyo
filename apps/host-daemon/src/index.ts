import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadHostDaemonErrorReportingConfig,
  loadHostDaemonStartConfig,
} from "@omnyo/config/host-daemon";
import {
  admitConfiguredOmnyoStateWrites,
  assertConfiguredOmnyoStateWriteAdmission,
} from "@omnyo/config/omnyo-state-startup";
import { loadHostDaemonEntrypointConfig } from "@omnyo/config/host-daemon-entrypoint";
import {
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@omnyo/process-utils";
import {
  captureProcessError,
  exitAfterFlushingProcessErrorReports,
  initProcessErrorReporting,
  setProcessErrorReportingEnabled,
  installUncaughtExceptionReporting,
  type ProcessErrorReportingStatus,
} from "@omnyo/process-utils/error-reporting";
import { hasMachineSuspensionMarker } from "./suspension-marker.js";

interface ReportStartupFailureArgs {
  diagnosticsLogsDir: string;
  error: unknown;
}

type MainFailureHandler = (error: unknown) => void;

const entrypointDir = dirname(fileURLToPath(import.meta.url));

function resolveEntrypointBridgeBundleDir(): string | undefined {
  return existsSync(join(entrypointDir, "omnyo-provider-bridge-worker.mjs"))
    ? entrypointDir
    : undefined;
}

function resolveDiagnosticsLogsDir(): string {
  const hostDaemonStartConfig = loadHostDaemonStartConfig({});

  return join(hostDaemonStartConfig.dataDir, "logs");
}

function reportStartupFailure(args: ReportStartupFailureArgs): void {
  try {
    assertConfiguredOmnyoStateWriteAdmission(dirname(args.diagnosticsLogsDir));
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: args.diagnosticsLogsDir,
      processName: "host-daemon",
      error: args.error,
    });
  } catch {}

  captureProcessError(args.error, { level: "fatal", stage: "startup" });

  const message =
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error);

  process.stderr.write(`${message}\n`, () =>
    exitAfterFlushingProcessErrorReports(1),
  );
}

function startHostDaemonErrorReporting(): ProcessErrorReportingStatus {
  const errorReportingConfig = loadHostDaemonErrorReportingConfig();

  setProcessErrorReportingEnabled(false);

  const status = initProcessErrorReporting({
    dsn: errorReportingConfig.OMNYO_SENTRY_DSN,
    homeDir: homedir(),
    nodeEnv: process.env.NODE_ENV,
    release: errorReportingConfig.OMNYO_APP_VERSION,
    service: "host-daemon",
  });

  installUncaughtExceptionReporting();

  return status;
}

async function runHostDaemonEntrypoint(): Promise<void> {
  const hostDaemonStartConfig = loadHostDaemonStartConfig({});

  const errorReporting = startHostDaemonErrorReporting();

  const hostDaemonEntrypointConfig = loadHostDaemonEntrypointConfig();

  await admitConfiguredOmnyoStateWrites(hostDaemonStartConfig.dataDir);
  installSafeProcessDiagnostics({
    logsDir: join(hostDaemonStartConfig.dataDir, "logs"),
    processName: "host-daemon",
  });
  installSocketTypeOfServiceGuard();

  if (await hasMachineSuspensionMarker(hostDaemonStartConfig.dataDir)) {
    return;
  }

  const hostDaemonModule = await import("./start-host-daemon.js");

  const daemon = await hostDaemonModule.startHostDaemon({
    cliExecutableDirectory: hostDaemonEntrypointConfig.OMNYO_CLI_DIR,
    bridgeBundleDir:
      hostDaemonEntrypointConfig.OMNYO_BRIDGE_DIR ??
      resolveEntrypointBridgeBundleDir(),
    serverHeaders: hostDaemonEntrypointConfig.OMNYO_SERVER_HEADERS,
    autoUpdate: hostDaemonEntrypointConfig.OMNYO_HOST_DAEMON_AUTO_UPDATE,
    supervised: hostDaemonEntrypointConfig.OMNYO_HOST_DAEMON_SUPERVISED,
    windowsServiceInstall:
      hostDaemonEntrypointConfig.OMNYO_WINDOWS_SERVICE_INSTALL,
    enrollKey: hostDaemonEntrypointConfig.OMNYO_HOST_ENROLL_KEY,
    errorReporting,
    hostId: hostDaemonEntrypointConfig.OMNYO_HOST_ID,
  });

  await daemon.waitUntilStopped();
}

const entrypointPath = process.argv[1];

const isMainModule =
  typeof entrypointPath === "string" &&
  fileURLToPath(import.meta.url) === entrypointPath;

if (isMainModule) {
  const diagnosticsLogsDir = resolveDiagnosticsLogsDir();

  const handleMainFailure: MainFailureHandler = (error) => {
    reportStartupFailure({ diagnosticsLogsDir, error });
  };

  void runHostDaemonEntrypoint().catch(handleMainFailure);
}

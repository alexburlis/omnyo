import { homedir } from "node:os";
import { join } from "node:path";
import { loadServerConfig } from "@omnyo/config/server";
import {
  admitConfiguredOmnyoStateWrites,
  assertConfiguredOmnyoStateWriteAdmission,
} from "@omnyo/config/omnyo-state-startup";
import {
  installSafeProcessDiagnostics,
  installSocketTypeOfServiceGuard,
  writeSafeProcessDiagnosticReport,
} from "@omnyo/process-utils";
import {
  captureProcessError,
  flushProcessErrorReports,
  initProcessErrorReporting,
  setProcessErrorReportingEnabled,
} from "@omnyo/process-utils/error-reporting";

const serverConfig = loadServerConfig();

setProcessErrorReportingEnabled(false);

initProcessErrorReporting({
  dsn: serverConfig.OMNYO_SENTRY_DSN,
  homeDir: homedir(),
  nodeEnv: process.env.NODE_ENV,
  release: serverConfig.OMNYO_APP_VERSION,
  service: "coordinator",
});

const diagnosticsLogsDir = join(serverConfig.OMNYO_DATA_DIR, "logs");

function reportStartupFailure(error: unknown): void {
  try {
    assertConfiguredOmnyoStateWriteAdmission(serverConfig.OMNYO_DATA_DIR);
    writeSafeProcessDiagnosticReport({
      kind: "startupFailure",
      logsDir: diagnosticsLogsDir,
      processName: "server",
      error,
    });
  } catch {}

  captureProcessError(error, { level: "fatal", stage: "startup" });

  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
  void flushProcessErrorReports();
}

async function main(): Promise<void> {
  await admitConfiguredOmnyoStateWrites(serverConfig.OMNYO_DATA_DIR);
  installSafeProcessDiagnostics({
    logsDir: diagnosticsLogsDir,
    processName: "server",
    trackAbortDeadlines: true,
  });
  installSocketTypeOfServiceGuard();
  const serverModule = await import("./start-server.js");
  await serverModule.runServer(serverConfig);
}

void main().catch(reportStartupFailure);

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCallSites } from "node:util";
import { ownedErrorSource } from "./error-reporting-privacy.js";

type SafeProcessDiagnosticKind = "startupFailure" | "uncaughtException";

interface SafeProcessDiagnosticsOptions {
  logsDir: string;
  processName: string;
}

interface InstallSafeProcessDiagnosticsOptions extends SafeProcessDiagnosticsOptions {
  trackAbortDeadlines?: boolean;
}

interface WriteSafeProcessDiagnosticReportArgs extends SafeProcessDiagnosticsOptions {
  kind: SafeProcessDiagnosticKind;
  error: unknown;
  uncaughtException?: UncaughtExceptionDiagnostic;
  now?: () => Date;
  createReportId?: () => string;
}

export const MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH = 8;

const MAX_DIAGNOSTIC_AGGREGATE_ERRORS = 8;

interface SafeProcessDiagnosticError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SafeProcessDiagnosticError;
  errors?: SafeProcessDiagnosticError[];
  errorsTruncated?: number;
  truncationReason?: "cycle" | "depth";
}

interface AbortDeadlineSite {
  source: string;
  line: number;
  column: number;
}

interface UncaughtExceptionDiagnostic {
  origin: NodeJS.UncaughtExceptionOrigin;
  deadline?: AbortDeadlineSite;
}

interface SafeProcessDiagnosticReport {
  diagnosticVersion: 1;
  kind: SafeProcessDiagnosticKind;
  processName: string;
  occurredAt: string;
  pid: number;
  runtime: {
    nodeVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    execPath: string;
  };
  error: SafeProcessDiagnosticError;
  uncaughtException?: UncaughtExceptionDiagnostic;
}

type UncaughtExceptionMonitorHandler = (
  error: Error,
  origin: NodeJS.UncaughtExceptionOrigin,
) => void;

function createCurrentDiagnosticDate(): Date {
  return new Date();
}

function sanitizeDiagnosticFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-");

  return sanitized.length > 0 ? sanitized : "process";
}

function formatDiagnosticTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createTruncatedDiagnosticError(
  truncationReason: "cycle" | "depth",
): SafeProcessDiagnosticError {
  return {
    name: "TruncatedErrorCause",
    message:
      truncationReason === "cycle"
        ? "Error cause serialization stopped because the cause chain contains a cycle"
        : `Error cause serialization stopped at the maximum depth of ${MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH}`,
    truncationReason,
  };
}

function serializeDiagnosticError(
  error: unknown,
  seenErrors: Set<Error> = new Set(),
  depth = 0,
): SafeProcessDiagnosticError {
  if (error instanceof Error) {
    if (seenErrors.has(error)) {
      return createTruncatedDiagnosticError("cycle");
    }

    if (depth >= MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH) {
      return createTruncatedDiagnosticError("depth");
    }

    seenErrors.add(error);

    const serialized: SafeProcessDiagnosticError = {
      name: error.name,
      message: error.message,
    };

    if (error.stack !== undefined) {
      serialized.stack = error.stack;
    }

    if ("code" in error && typeof error.code === "string") {
      serialized.code = error.code;
    }

    if (error.cause !== undefined) {
      serialized.cause = serializeDiagnosticError(
        error.cause,
        seenErrors,
        depth + 1,
      );
    }

    if (error instanceof AggregateError) {
      const aggregateErrors = error.errors.slice(
        0,
        MAX_DIAGNOSTIC_AGGREGATE_ERRORS,
      );

      serialized.errors = aggregateErrors.map((aggregateError) =>
        serializeDiagnosticError(aggregateError, seenErrors, depth + 1),
      );
      const errorsTruncated = error.errors.length - aggregateErrors.length;

      if (errorsTruncated > 0) {
        serialized.errorsTruncated = errorsTruncated;
      }
    }

    seenErrors.delete(error);

    return serialized;
  }

  return {
    name: "NonError",
    message: String(error),
  };
}

export function writeSafeProcessDiagnosticReport(
  args: WriteSafeProcessDiagnosticReportArgs,
): string {
  mkdirSync(args.logsDir, { recursive: true });
  const occurredAt = (args.now ?? createCurrentDiagnosticDate)();

  const reportId = sanitizeDiagnosticFilenamePart(
    (args.createReportId ?? randomUUID)(),
  );

  const processName = sanitizeDiagnosticFilenamePart(args.processName);

  const reportPath = join(
    args.logsDir,
    `process-${processName}-${args.kind}-${formatDiagnosticTimestamp(
      occurredAt,
    )}-${reportId}.json`,
  );

  const report: SafeProcessDiagnosticReport = {
    diagnosticVersion: 1,
    kind: args.kind,
    processName: args.processName,
    occurredAt: occurredAt.toISOString(),
    pid: process.pid,
    runtime: {
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      execPath: process.execPath,
    },
    error: serializeDiagnosticError(args.error),
    ...(args.uncaughtException === undefined
      ? {}
      : { uncaughtException: args.uncaughtException }),
  };

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
  });

  return reportPath;
}

function describeDeadlineSource(scriptName: string): string {
  const path = scriptName.replaceAll("\\", "/").split(/[?#]/, 1)[0] ?? "";

  const pluginArtifact = path.match(
    /\/(plugins\/(?:runtime\/server\/[a-f0-9]{64}\/[a-f0-9]{64}\/server\.cjs|cache\/(?:builtin\/(?:identity_v1_[a-f0-9]{64}|[a-f0-9-]{36})|identity-v1\/[a-z0-9-]{1,96}\/[a-f0-9]{64})\/dist\/server\.js))$/u,
  )?.[1];

  return (
    ownedErrorSource(scriptName) ??
    pluginArtifact ??
    `sha256:${createHash("sha256").update(path).digest("hex").slice(0, 16)}`
  );
}

function trackAbortDeadlines(sites: WeakMap<DOMException, AbortDeadlineSite>) {
  const timeout = AbortSignal.timeout;

  function trackedTimeout(delay: number): AbortSignal {
    const signal = timeout(delay);
    const [, caller] = getCallSites(2, { sourceMap: false });

    if (caller === undefined) return signal;

    const site: AbortDeadlineSite = {
      source: describeDeadlineSource(caller.scriptName),
      line: caller.lineNumber,
      column: caller.columnNumber,
    };

    const dispatch = signal.dispatchEvent;
    Object.defineProperty(signal, "dispatchEvent", {
      configurable: true,
      writable: true,
      value(this: AbortSignal, event: Event): boolean {
        if (this === signal && event.type === "abort" && event.isTrusted) {
          Reflect.deleteProperty(signal, "dispatchEvent");
          const reason: unknown = signal.reason;

          if (
            reason instanceof DOMException &&
            reason.name === "TimeoutError"
          ) {
            sites.set(reason, site);
          }
        }

        return dispatch.call(this, event);
      },
    });

    return signal;
  }

  AbortSignal.timeout = trackedTimeout;

  return () => {
    if (AbortSignal.timeout === trackedTimeout) AbortSignal.timeout = timeout;
  };
}

export function installSafeProcessDiagnostics(
  options: InstallSafeProcessDiagnosticsOptions,
): () => void {
  mkdirSync(options.logsDir, { recursive: true });
  const deadlineSites = new WeakMap<DOMException, AbortDeadlineSite>();

  const stopTracking = options.trackAbortDeadlines
    ? trackAbortDeadlines(deadlineSites)
    : undefined;

  const handleUncaughtExceptionMonitor: UncaughtExceptionMonitorHandler = (
    error,
    origin,
  ) => {
    try {
      const deadline =
        error instanceof DOMException ? deadlineSites.get(error) : undefined;

      writeSafeProcessDiagnosticReport({
        ...options,
        kind: "uncaughtException",
        error,
        uncaughtException: {
          origin,
          ...(deadline === undefined ? {} : { deadline }),
        },
      });
    } catch {}
  };

  process.on("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);

  return () => {
    process.off("uncaughtExceptionMonitor", handleUncaughtExceptionMonitor);
    stopTracking?.();
  };
}

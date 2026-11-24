import {
  CREDENTIAL_REDACTION_MARKER,
  redactCredentialText,
} from "@omnyo/domain";
import {
  captureException,
  captureFeedback,
  createStackParser,
  createTransport,
  dedupeIntegration,
  eventFiltersIntegration,
  flush,
  functionToStringIntegration,
  getClient,
  getCurrentScope,
  initAndBind,
  linkedErrorsIntegration,
  uuid4,
  type BaseTransportOptions,
  type DataCollection,
  type Event,
  type Scope,
  type Transport,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";
import { MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH } from "./diagnostics.js";
import {
  createErrorReportingBoundary,
  readErrorDiagnosticContext,
  scrubDiagnosticErrorEvent,
  type ErrorDiagnosticContext,
  type ErrorReportIdentity,
} from "./error-reporting-privacy.js";

export type {
  ErrorDiagnosticContext,
  TimelineProjectionDiagnosticContext,
} from "./error-reporting-privacy.js";

export type ProcessErrorReportingService = "coordinator" | "host-daemon";

export type ProcessErrorReportingDisabledReason =
  | "development-version"
  | "missing-dsn"
  | "not-initialized"
  | "not-production";

export type ProcessErrorReportingStatus =
  | { enabled: true }
  | { enabled: false; reason: ProcessErrorReportingDisabledReason };

export interface ProcessErrorReportingConfig {
  dsn: string;
  nodeEnv: string | undefined;
  release: string;
}

export interface InitProcessErrorReportingArgs extends ProcessErrorReportingConfig {
  homeDir: string;
  service: ProcessErrorReportingService;
}

export type ProcessErrorReportingStage =
  | "plugin"
  | "request"
  | "startup"
  | "uncaught-exception";

export interface ProcessBugReport {
  message: string;
  email?: string;
  associatedEventId?: string;
}

export type ProcessBugReportResult =
  | { status: "sent"; reportId: string }
  | { status: "unavailable"; reason: "crash-reports-off" | "not-configured" }
  | { status: "failed"; reason: "rejected" | "timeout" };

export interface SendProcessBugReportOptions {
  scope?: Scope;
  timeoutMs?: number;
}

export interface CaptureProcessErrorArgs {
  eventId?: string;
  level: "error" | "fatal";
  stage: ProcessErrorReportingStage;
  tags?: Record<string, string>;
  fingerprint?: string[];
  diagnostic?: ErrorDiagnosticContext;
}

const DEVELOPMENT_RELEASE_PREFIX = "0.0.0";

const PROCESS_ERROR_REPORT_FLUSH_TIMEOUT_MS = 2_000;

const PROCESS_ERROR_REPORT_REQUEST_TIMEOUT_MS = 5_000;

const MAX_REPORTED_TEXT_CHARS = 4_096;

const MAX_REPORTED_EXCEPTIONS = MAX_DIAGNOSTIC_ERROR_CAUSE_DEPTH;

const BUG_REPORT_SEND_TIMEOUT_MS = 10_000;

const BUG_REPORT_SOURCE = "omnyo-bug-report";

const PROCESS_ERROR_REPORTING_ENABLED_KEY = Symbol.for(
  "omnyo.processErrorReporting.enabled",
);

const DISABLED_DATA_COLLECTION: DataCollection = {
  cookies: false,
  databaseQueryData: false,
  frameContextLines: 0,
  genAI: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
  httpBodies: [],
  httpHeaders: false,
  mcp: { inputs: false, outputs: false },
  queues: false,
  stackFrameVariables: false,
  urlQueryParams: false,
  userInfo: false,
};

export function resolveProcessErrorReportingStatus(
  config: ProcessErrorReportingConfig,
): ProcessErrorReportingStatus {
  if (config.nodeEnv !== "production") {
    return { enabled: false, reason: "not-production" };
  }

  if (config.dsn.trim() === "") {
    return { enabled: false, reason: "missing-dsn" };
  }

  if (
    config.release.trim() === "" ||
    config.release.startsWith(DEVELOPMENT_RELEASE_PREFIX)
  ) {
    return { enabled: false, reason: "development-version" };
  }

  return { enabled: true };
}

const PROCESS_ERROR_REPORTING_GENERATION_KEY = Symbol.for(
  "omnyo.processErrorReporting.generation",
);

function isProcessErrorReportingEnabled(): boolean {
  return Reflect.get(globalThis, PROCESS_ERROR_REPORTING_ENABLED_KEY) === true;
}

function processErrorReportingGeneration(): number {
  const generation: unknown = Reflect.get(
    globalThis,
    PROCESS_ERROR_REPORTING_GENERATION_KEY,
  );

  return typeof generation === "number" ? generation : 0;
}

export function setProcessErrorReportingEnabled(enabled: boolean): void {
  if (enabled !== isProcessErrorReportingEnabled()) {
    Reflect.set(
      globalThis,
      PROCESS_ERROR_REPORTING_GENERATION_KEY,
      processErrorReportingGeneration() + 1,
    );
  }

  Reflect.set(globalThis, PROCESS_ERROR_REPORTING_ENABLED_KEY, enabled);
}

export function readProcessErrorReportingStatus(
  config: ProcessErrorReportingConfig,
): ProcessErrorReportingStatus {
  const status = resolveProcessErrorReportingStatus(config);

  if (status.enabled && getClient() === undefined) {
    return { enabled: false, reason: "not-initialized" };
  }

  return status;
}

function replaceHomeDirectory(text: string, homeDir: string): string {
  if (homeDir.length <= 1) return text;
  let replaced = text.split(homeDir).join("~");
  const forwardSlashHomeDir = homeDir.replaceAll("\\", "/");

  if (forwardSlashHomeDir !== homeDir) {
    replaced = replaced.split(forwardSlashHomeDir).join("~");
  }

  return replaced;
}

function redactReportedCredentials(text: string): string {
  try {
    return redactCredentialText(text);
  } catch {
    return CREDENTIAL_REDACTION_MARKER;
  }
}

export function scrubErrorReportText(text: string, homeDir: string): string {
  const scrubbed = replaceHomeDirectory(
    redactReportedCredentials(text),
    homeDir,
  );

  return scrubbed.length > MAX_REPORTED_TEXT_CHARS
    ? `${scrubbed.slice(0, MAX_REPORTED_TEXT_CHARS)}…`
    : scrubbed;
}

export function scrubErrorReportEvent(
  event: Event,
  _homeDir: string,
  identity?: ErrorReportIdentity,
): Event {
  return scrubDiagnosticErrorEvent(event, identity);
}

function readContextString(
  context: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = context?.[key];

  return typeof value === "string" ? value : undefined;
}

export function scrubBugReportEvent(
  event: Event,
  homeDir: string,
  identity?: ErrorReportIdentity,
): Event {
  const scrubbed: Event = {
    ...scrubErrorReportEvent(event, homeDir, identity),
    type: "feedback",
  };

  delete scrubbed.exception;
  delete scrubbed.message;
  delete scrubbed.logentry;
  delete scrubbed.fingerprint;

  const feedback = event.contexts?.feedback;
  const email = readContextString(feedback, "contact_email");

  const associatedEventId = readContextString(feedback, "associated_event_id");

  scrubbed.contexts = {
    ...scrubbed.contexts,
    feedback: {
      message: scrubErrorReportText(
        readContextString(feedback, "message") ?? "",
        homeDir,
      ),
      source: BUG_REPORT_SOURCE,
      ...(email === undefined ? {} : { contact_email: email }),
      ...(associatedEventId === undefined
        ? {}
        : { associated_event_id: associatedEventId }),
    },
  };

  return scrubbed;
}

function createFetchTransport(options: BaseTransportOptions): Transport {
  return createTransport(options, async (request) => {
    const response = await fetch(options.url, {
      body:
        typeof request.body === "string"
          ? request.body
          : new Uint8Array(request.body),
      headers: options.headers,
      method: "POST",
      signal: AbortSignal.timeout(PROCESS_ERROR_REPORT_REQUEST_TIMEOUT_MS),
    });

    return {
      headers: {
        "retry-after": response.headers.get("Retry-After"),
        "x-sentry-rate-limits": response.headers.get("X-Sentry-Rate-Limits"),
      },
      statusCode: response.status,
    };
  });
}

export function createProcessErrorReportingOptions(
  args: InitProcessErrorReportingArgs,
  transport: ServerRuntimeClientOptions["transport"] = createFetchTransport,
): ServerRuntimeClientOptions {
  const identity: ErrorReportIdentity = {
    service: args.service,
    release: args.release,
    platform: process.platform,
    arch: process.arch,
    runtime: { name: "node", version: process.version },
  };

  const boundary = createErrorReportingBoundary(
    () => ({
      enabled: isProcessErrorReportingEnabled(),
      generation: processErrorReportingGeneration(),
    }),
    (event) =>
      event.type === "feedback"
        ? scrubBugReportEvent(event, args.homeDir, identity)
        : scrubErrorReportEvent(event, args.homeDir, identity),
  );

  return {
    beforeBreadcrumb: () => null,
    beforeSend: boundary.beforeSend,
    beforeSendTransaction: () => null,
    dataCollection: DISABLED_DATA_COLLECTION,
    dsn: args.dsn,
    environment: "production",
    initialScope: {
      tags: {
        arch: process.arch,
        platform: process.platform,
        service: args.service,
      },
    },
    integrations: [
      dedupeIntegration(),
      eventFiltersIntegration(),
      functionToStringIntegration(),
      linkedErrorsIntegration({ limit: MAX_REPORTED_EXCEPTIONS - 1 }),
      boundary.integration,
    ],
    maxBreadcrumbs: 0,
    platform: "node",
    release: args.release,
    runtime: { name: "node", version: process.version },
    sendClientReports: false,
    stackParser: createStackParser(nodeStackLineParser()),
    traceLifecycle: "static",
    transport: (options) => boundary.transport(transport(options)),
  };
}

export function initProcessErrorReporting(
  args: InitProcessErrorReportingArgs,
): ProcessErrorReportingStatus {
  const status = resolveProcessErrorReportingStatus(args);

  if (!status.enabled || getClient() !== undefined) return status;

  initAndBind(ServerRuntimeClient, createProcessErrorReportingOptions(args));

  return status;
}

export function captureProcessError(
  error: unknown,
  args: CaptureProcessErrorArgs,
): void {
  if (!isProcessErrorReportingEnabled()) return;
  const diagnostic = readErrorDiagnosticContext(args.diagnostic);

  if (
    args.level !== "fatal" &&
    diagnostic !== undefined &&
    diagnostic.outcome !== "terminal"
  )
    return;
  captureException(error, {
    ...(typeof args.eventId === "string" &&
    /^[a-f0-9]{32}$/iu.test(args.eventId)
      ? { event_id: args.eventId }
      : {}),
    captureContext: {
      level: args.level,
      tags: { stage: args.stage },
      contexts: {
        diagnostic: diagnostic === undefined ? undefined : { ...diagnostic },
      },
    },
  });
}

export function sendProcessBugReport(
  report: ProcessBugReport,
  options: SendProcessBugReportOptions = {},
): Promise<ProcessBugReportResult> {
  const scope = options.scope ?? getCurrentScope();
  const client = scope.getClient();

  if (client === undefined) {
    return Promise.resolve({ status: "unavailable", reason: "not-configured" });
  }

  if (!isProcessErrorReportingEnabled()) {
    return Promise.resolve({
      status: "unavailable",
      reason: "crash-reports-off",
    });
  }

  const reportId = uuid4();

  return new Promise((resolve) => {
    const finish = (result: ProcessBugReportResult) => {
      clearTimeout(timer);
      stopListening();
      resolve(result);
    };

    const stopListening = client.on("afterSendEvent", (event, response) => {
      if (event.event_id !== reportId) return;
      const statusCode = response?.statusCode;

      finish(
        statusCode !== undefined && statusCode >= 200 && statusCode < 300
          ? { status: "sent", reportId }
          : { status: "failed", reason: "rejected" },
      );
    });

    const timer = setTimeout(
      () => finish({ status: "failed", reason: "timeout" }),
      options.timeoutMs ?? BUG_REPORT_SEND_TIMEOUT_MS,
    );

    captureFeedback(
      {
        message: report.message,
        source: BUG_REPORT_SOURCE,
        ...(report.email === undefined ? {} : { email: report.email }),
        ...(report.associatedEventId === undefined
          ? {}
          : { associatedEventId: report.associatedEventId }),
      },
      { event_id: reportId },
      scope,
    );
  });
}

export function flushProcessErrorReports(): Promise<boolean> {
  return flush(PROCESS_ERROR_REPORT_FLUSH_TIMEOUT_MS).catch(() => false);
}

export function exitAfterFlushingProcessErrorReports(exitCode: number): void {
  const exit = () => process.exit(exitCode);

  if (getClient() === undefined) exit();
  else void flushProcessErrorReports().then(exit, exit);
}

function formatProcessErrorForStderr(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

export function installUncaughtExceptionReporting(): () => void {
  if (getClient() === undefined) return () => {};

  let exiting = false;

  const handleUncaughtException = (error: unknown) => {
    process.stderr.write(`${formatProcessErrorForStderr(error)}\n`);

    if (exiting) return;
    exiting = true;
    captureProcessError(error, { level: "fatal", stage: "uncaught-exception" });
    exitAfterFlushingProcessErrorReports(1);
  };

  process.on("uncaughtException", handleUncaughtException);

  return () => {
    process.off("uncaughtException", handleUncaughtException);
  };
}

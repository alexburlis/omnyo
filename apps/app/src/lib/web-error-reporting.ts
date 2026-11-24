import {
  CREDENTIAL_REDACTION_MARKER,
  redactCredentialText,
} from "@omnyo/domain";
import type { SystemConfigResponse } from "@omnyo/server-contract";
import {
  createErrorReportingBoundary,
  type ErrorReportIdentity,
} from "@omnyo/process-utils/error-reporting-privacy";
import {
  scrubBrowserErrorEvent,
  SLOW_SHELF_MOVE_MESSAGE,
  SHELF_TIMING_DEADLINE_MS,
} from "@omnyo/process-utils/web-error-reporting-privacy";
import {
  makeSameOriginErrorTransport,
  abortPendingWebErrorReports,
} from "./web-error-transport";
import { setVoiceDiagnosticsEnabled } from "./voice-diagnostics";
import {
  readSplitFailureDiagnostic,
  setSplitDownloadDiagnosticsEnabled,
} from "./split-load";
import {
  BrowserClient,
  browserApiErrorsIntegration,
  dedupeIntegration,
  defaultStackParser,
  eventFiltersIntegration,
  functionToStringIntegration,
  getCurrentScope,
  globalHandlersIntegration,
  linkedErrorsIntegration,
  reactErrorHandler,
  withScope,
  type ErrorEvent,
  type Event,
} from "@sentry/react";
import { hashKey, type QueryClient } from "@tanstack/react-query";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { readAppOverlayCrashContext } from "@/components/plugin/PluginSlotMount";

export interface WebErrorReportingTarget {
  dsn: string;
  release: string;
  runtimeRelease?: string;
  sourceRevision?: string;
}

type WebErrorReportingClientOptions = ConstructorParameters<
  typeof BrowserClient
>[0];

type WebErrorReportingTransport = WebErrorReportingClientOptions["transport"];

interface ActiveWebErrorReporting {
  client: BrowserClient;
  key: string;
  lastDeliveredErrorEventId: string | null;
  lastShelfTimingAt: number;
}

const WEB_ERROR_REPORTING_SERVICE = "web";

const WEB_ERROR_REPORT_CLOSE_TIMEOUT_MS = 2_000;

const SLOW_SHELF_MOVE_MS = 2_000;

const SHELF_TIMING_INTERVAL_MS = 5 * 60_000;

const SHELF_SERVER_TIMING_NAME = "omnyo_shelve";

const SHELF_SERVER_TIMING_PATTERN =
  /(?:^|,\s*)omnyo_shelve;dur=(\d+(?:\.\d+)?);desc="([a-f0-9-]{36})"(?=\s*(?:,|$))/u;

const MAX_REPORTED_TEXT_CHARS = 4_096;

const URL_ORIGIN_PATTERN = /^(?:blob:)?[a-z][a-z\d+.-]*:\/\/[^/?#]*/i;

const URL_IN_TEXT_PATTERN = /\b(?:blob:)?[a-z][a-z\d+.-]*:\/\/[^\s"'<>`]+/gi;

const HOME_DIRECTORY_PATTERN =
  /(?:\/Users\/|\/home\/)[^/\s"'`]+|[A-Za-z]:\\Users\\[^\\\s"'`]+/g;

let active: ActiveWebErrorReporting | null = null;

export function resolveWebErrorReportingTarget(
  config:
    | Pick<SystemConfigResponse, "diagnostics" | "generalSettings">
    | undefined,
): WebErrorReportingTarget | null {
  if (config === undefined || !config.generalSettings.crashReportsEnabled) {
    return null;
  }

  const dsn = config.diagnostics?.sentryDsn?.trim();
  const runtimeRelease = config.diagnostics?.release.trim();

  if (!dsn || !runtimeRelease) return null;

  const loadedRelease = document
    .querySelector('meta[name="omnyo-web-release"]')
    ?.getAttribute("content");

  const release =
    loadedRelease !== null &&
    loadedRelease !== undefined &&
    /^web-[a-f0-9]{64}$/.test(loadedRelease)
      ? loadedRelease
      : "web-development";

  const sourceRevision = document
    .querySelector('meta[name="omnyo-web-source"]')
    ?.getAttribute("content");

  return {
    dsn,
    release,
    runtimeRelease,
    ...(sourceRevision !== null &&
    sourceRevision !== undefined &&
    /^[a-f0-9]{40,64}$/.test(sourceRevision)
      ? { sourceRevision }
      : {}),
  };
}

export function scrubReportedUrl(value: string): string {
  const withoutFragment = value.split("#", 1)[0] ?? "";
  const withoutQuery = withoutFragment.split("?", 1)[0] ?? "";

  return withoutQuery
    .replace(URL_ORIGIN_PATTERN, "app://")
    .replace(HOME_DIRECTORY_PATTERN, "~");
}

function redactReportedCredentials(text: string): string {
  try {
    return redactCredentialText(text);
  } catch {
    return CREDENTIAL_REDACTION_MARKER;
  }
}

export function scrubReportedText(text: string): string {
  const scrubbed = redactReportedCredentials(text)
    .replace(URL_IN_TEXT_PATTERN, scrubReportedUrl)
    .replace(HOME_DIRECTORY_PATTERN, "~");

  return scrubbed.length > MAX_REPORTED_TEXT_CHARS
    ? `${scrubbed.slice(0, MAX_REPORTED_TEXT_CHARS)}…`
    : scrubbed;
}

export function scrubWebErrorEvent(
  event: Event,
  target?: WebErrorReportingTarget,
): ErrorEvent {
  const identity: ErrorReportIdentity = {
    service: WEB_ERROR_REPORTING_SERVICE,
    webOrigin: window.location.origin,
    ...target,
  };

  return scrubBrowserErrorEvent(event, identity);
}

export function createWebErrorReportingOptions(
  target: WebErrorReportingTarget,
  isActive: () => boolean,
  transport: WebErrorReportingTransport = makeSameOriginErrorTransport,
): WebErrorReportingClientOptions {
  const boundary = createErrorReportingBoundary(
    () => ({ enabled: isActive(), generation: 0 }),
    (event, hint) => {
      const diagnostic = readSplitFailureDiagnostic(hint?.originalException);

      return scrubWebErrorEvent(
        diagnostic === undefined
          ? event
          : { ...event, contexts: { ...event.contexts, diagnostic } },
        target,
      );
    },
  );

  return {
    dsn: target.dsn,
    release: target.release,
    environment: "production",
    transport: (options) => boundary.transport(transport(options)),
    stackParser: defaultStackParser,
    integrations: [
      boundary.integration,
      eventFiltersIntegration(),
      functionToStringIntegration(),
      browserApiErrorsIntegration(),
      globalHandlersIntegration({ onerror: true, onunhandledrejection: true }),
      linkedErrorsIntegration(),
      dedupeIntegration(),
    ],
    dataCollection: {
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
    },
    enhanceFetchErrorMessages: false,
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    sendClientReports: false,
    beforeSend: boundary.beforeSend,
    beforeSendTransaction: () => null,
  };
}

function stopWebErrorReporting(): void {
  const current = active;
  active = null;

  abortPendingWebErrorReports();
  setSplitDownloadDiagnosticsEnabled(false);

  if (current === null) return;
  current.client.getOptions().enabled = false;
  const scope = getCurrentScope();

  if (scope.getClient() === current.client) scope.setClient(undefined);
  void current.client.close(WEB_ERROR_REPORT_CLOSE_TIMEOUT_MS);
}

export function applyWebErrorReporting(
  target: WebErrorReportingTarget | null,
  transport?: WebErrorReportingTransport,
): void {
  const key =
    target === null
      ? null
      : `${target.dsn}\n${target.release}\n${target.runtimeRelease ?? ""}\n${target.sourceRevision ?? ""}`;

  if (key === (active?.key ?? null)) return;
  stopWebErrorReporting();

  if (target === null || key === null) return;

  const client = new BrowserClient(
    createWebErrorReportingOptions(
      target,
      () => active?.client === client,
      transport,
    ),
  );

  const reporting: ActiveWebErrorReporting = {
    client,
    key,
    lastDeliveredErrorEventId: null,
    lastShelfTimingAt: -Infinity,
  };

  client.on("afterSendEvent", (event, response) => {
    const statusCode = response?.statusCode;

    if (
      event.type === undefined &&
      event.level !== "warning" &&
      event.event_id !== undefined &&
      statusCode !== undefined &&
      statusCode >= 200 &&
      statusCode < 300
    ) {
      reporting.lastDeliveredErrorEventId = event.event_id;
    }
  });

  active = reporting;
  setSplitDownloadDiagnosticsEnabled(true);
  getCurrentScope().setClient(client);
  client.init();
}

export function startShelfMoveTiming() {
  const reporting = active;

  if (reporting === null || document.visibilityState !== "visible") return;

  const start = performance.now();

  if (start - reporting.lastShelfTimingAt < SHELF_TIMING_INTERVAL_MS) return;

  let beforeOptimisticMs: number | undefined;
  let optimisticCommitMs: number | undefined;
  let foregroundFrameMs: number | undefined;
  let requestStartedAt: number | undefined;
  let requestMs: number | undefined;
  let totalMs: number | undefined;
  let outcome: "saved" | "failed" | "pending" = "pending";
  let frame: number | undefined;
  let observer: PerformanceObserver | undefined;
  let coordinatorTiming: { marker: string; durationMs: number } | undefined;

  let responseTiming:
    | { responseStartMs: number; responseEndMs: number }
    | undefined;

  let reported = false;
  let stayedVisible = true;

  const recordResourceTiming = (entries: readonly PerformanceEntry[]) => {
    if (coordinatorTiming === undefined || requestStartedAt === undefined)
      return;

    const { marker } = coordinatorTiming;

    const entry = entries.find(
      (candidate): candidate is PerformanceResourceTiming =>
        candidate instanceof PerformanceResourceTiming &&
        candidate.serverTiming?.some(
          (metric) =>
            metric.name === SHELF_SERVER_TIMING_NAME &&
            metric.description === marker,
        ),
    );

    if (
      entry !== undefined &&
      entry.responseStart > 0 &&
      entry.responseStart >= requestStartedAt &&
      entry.responseEnd >= entry.responseStart
    ) {
      responseTiming = {
        responseStartMs: entry.responseStart - requestStartedAt,
        responseEndMs: entry.responseEnd - requestStartedAt,
      };
    }
  };

  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") stayedVisible = false;
  };

  document.addEventListener("visibilitychange", onVisibilityChange);

  const report = () => {
    if (reported) return;
    reported = true;
    clearTimeout(deadline);
    document.removeEventListener("visibilitychange", onVisibilityChange);

    if (frame !== undefined) cancelAnimationFrame(frame);

    if (observer !== undefined) {
      recordResourceTiming(observer.takeRecords());
      observer.disconnect();
    }

    const now = performance.now();
    const elapsed = totalMs ?? now - start;

    const roundTrip =
      requestMs ??
      (requestStartedAt === undefined ? undefined : now - requestStartedAt);

    if (
      active !== reporting ||
      Math.max(elapsed, foregroundFrameMs ?? 0) < SLOW_SHELF_MOVE_MS ||
      now - reporting.lastShelfTimingAt < SHELF_TIMING_INTERVAL_MS
    )
      return;

    reporting.lastShelfTimingAt = now;
    reporting.client.captureEvent({
      message: SLOW_SHELF_MOVE_MESSAGE,
      level: "warning",
      contexts: {
        shelfMove: {
          outcome,
          beforeOptimisticMs,
          optimisticCommitMs,
          foregroundFrameMs,
          requestMs: roundTrip,
          coordinatorMs: coordinatorTiming?.durationMs,
          ...responseTiming,
          totalMs: elapsed,
        },
      },
    });
  };

  const deadline = setTimeout(report, SHELF_TIMING_DEADLINE_MS);

  return {
    optimisticStarted() {
      beforeOptimisticMs = performance.now() - start;
    },
    requestStarted() {
      requestStartedAt = performance.now();

      if (
        !reported &&
        typeof PerformanceObserver !== "undefined" &&
        typeof PerformanceResourceTiming !== "undefined" &&
        PerformanceObserver.supportedEntryTypes?.includes("resource")
      ) {
        observer = new PerformanceObserver((list) =>
          recordResourceTiming(list.getEntries()),
        );
        observer.observe({ type: "resource" });
      }

      if (beforeOptimisticMs !== undefined)
        optimisticCommitMs = requestStartedAt - start - beforeOptimisticMs;

      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          frame = undefined;

          if (stayedVisible && document.visibilityState === "visible")
            foregroundFrameMs = performance.now() - start;

          if (totalMs !== undefined) report();
        });
      });
    },
    responseTiming(header: string | null) {
      if (reported || header === null) return;
      const match = SHELF_SERVER_TIMING_PATTERN.exec(header);

      if (match === null) return;

      const [, duration, marker] = match;
      const durationMs = Number(duration);

      if (marker !== undefined && Number.isFinite(durationMs)) {
        coordinatorTiming = { marker, durationMs };
      }
    },
    requestSettled() {
      if (requestStartedAt !== undefined)
        requestMs = performance.now() - requestStartedAt;
    },
    finish(result: "saved" | "failed") {
      totalMs = performance.now() - start;
      outcome = result;

      if (frame === undefined) report();
    },
  };
}

export function readLastDeliveredWebErrorEventId(): string | null {
  return active?.lastDeliveredErrorEventId ?? null;
}

export function isWebErrorReportingActive(): boolean {
  return active !== null;
}

export function installWebErrorReporting(queryClient: QueryClient): void {
  const queryKey = systemConfigQueryKey();
  const queryHash = hashKey(queryKey);

  const sync = () => {
    const config = queryClient.getQueryData<SystemConfigResponse>(queryKey);
    const target = resolveWebErrorReportingTarget(config);
    setVoiceDiagnosticsEnabled(target !== null);
    applyWebErrorReporting(target);
  };

  queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === queryHash) sync();
  });
  sync();
}

export function createRootErrorHandler<
  Info extends { componentStack?: string; errorBoundary?: unknown },
>(
  log: (error: unknown, errorInfo: Info) => void,
): (error: unknown, errorInfo: Info) => void {
  const capture = reactErrorHandler();

  return (error, errorInfo) => {
    if (active !== null) {
      const overlay = readAppOverlayCrashContext(errorInfo.errorBoundary);

      if (overlay === undefined) capture(error, errorInfo);
      else
        withScope((scope) => {
          scope.setContext("pluginOverlay", overlay);
          capture(error, errorInfo);
        });
    }

    log(error, errorInfo);
  };
}

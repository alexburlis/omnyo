import {
  captureException,
  createStackParser,
  createTransport,
  dedupeIntegration,
  flush,
  functionToStringIntegration,
  getClient,
  initAndBind,
  linkedErrorsIntegration,
  type BaseTransportOptions,
  type ErrorEvent,
  type Transport,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";

import { SENTRY_DSN } from "./config";
import {
  rebuildErrorEvent,
  routeSection,
  type ErrorReportIdentity,
} from "./error-event";

export type ServerErrorStage = "request" | "uncaught-exception";

const REQUEST_TIMEOUT_MS = 5_000;

const FLUSH_TIMEOUT_MS = 2_000;

const STAGES = new Set<string>(["request", "uncaught-exception"]);

export function ownServerFrame(filename: string): string | undefined {
  if (filename.startsWith("node:")) return filename;
  let path = filename;

  if (filename.startsWith("file://")) {
    try {
      path = new URL(filename).pathname;
    } catch {
      return undefined;
    }
  }

  const index = path.lastIndexOf("/dist/server/");

  return index === -1 ? undefined : `app:///${path.slice(index + 1)}`;
}

const SERVER_IDENTITY: ErrorReportIdentity = {
  service: "website-server",
  environment: "production",
  platform: "node",
  ownFrame: ownServerFrame,
  contexts: { runtime: { name: "node", version: process.version } },
};

export function rebuildServerEvent(event: ErrorEvent): ErrorEvent | null {
  const stage = event.tags?.stage;
  const route = event.tags?.route;

  return rebuildErrorEvent(event, SERVER_IDENTITY, {
    ...(typeof stage === "string" && STAGES.has(stage) ? { stage } : {}),
    ...(typeof route === "string" ? { route: routeSection(route) } : {}),
  });
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
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

function serverErrorReportingEnabled(): boolean {
  return (
    SENTRY_DSN !== "" &&
    import.meta.env.PROD &&
    process.env.NODE_ENV === "production"
  );
}

function ensureClient(): boolean {
  if (getClient() !== undefined) return true;

  if (!serverErrorReportingEnabled()) return false;

  const options: ServerRuntimeClientOptions = {
    dsn: SENTRY_DSN,
    environment: "production",
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [
      dedupeIntegration(),
      functionToStringIntegration(),
      linkedErrorsIntegration({ limit: 5 }),
    ],
    dataCollection: {
      cookies: false,
      frameContextLines: 0,
      httpBodies: [],
      httpHeaders: false,
      stackFrameVariables: false,
      urlQueryParams: false,
      userInfo: false,
    },
    maxBreadcrumbs: 0,
    beforeBreadcrumb: () => null,
    beforeSend: rebuildServerEvent,
    beforeSendTransaction: () => null,
    sendClientReports: false,
    traceLifecycle: "static",
    transport: createFetchTransport,
  };

  initAndBind(ServerRuntimeClient, options);

  return true;
}

export function captureServerError(
  error: unknown,
  stage: ServerErrorStage,
  pathname?: string,
): void {
  if (stage === "request" && !(error instanceof Error)) return;

  if (error instanceof Error && error.name === "AbortError") return;

  if (!ensureClient()) return;
  captureException(error, {
    captureContext: {
      level: stage === "uncaught-exception" ? "fatal" : "error",
      tags: {
        stage,
        ...(pathname === undefined ? {} : { route: pathname }),
      },
    },
  });
}

export async function reportFatalServerError(error: unknown): Promise<void> {
  captureServerError(error, "uncaught-exception");

  if (getClient() !== undefined)
    await flush(FLUSH_TIMEOUT_MS).catch(() => false);
}

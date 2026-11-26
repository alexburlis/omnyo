import { QueuedMessageThreadUnavailableError } from "@omnyo/db";
import { ProjectAttachmentError } from "@omnyo/domain";
import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { captureProcessError } from "@omnyo/process-utils/error-reporting";
import type { ThreadEventScopeKind, ThreadEventType } from "@omnyo/domain";
import type { ServerLogger } from "./types.js";
import { timelineProjectionDiagnostic } from "./services/threads/timeline-projection-diagnostics.js";

interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  retryable?: boolean;
}

interface ApiErrorOptions {
  details?: unknown;
  retryable?: boolean;
}

interface TurnStartGuardFailureDetails {
  eventType: ThreadEventType;
  scopeKind: ThreadEventScopeKind;
  threadId: string;
  turnId: string;
}

export class ApiError extends HTTPException {
  readonly body: ApiErrorBody;

  constructor(
    status: ConstructorParameters<typeof HTTPException>[0],
    code: string,
    message: string,
    options?: boolean | ApiErrorOptions,
  ) {
    super(status, { message });
    const resolvedOptions = normalizeApiErrorOptions(options);
    this.body = { code, message };

    if (resolvedOptions.details !== undefined) {
      this.body.details = resolvedOptions.details;
    }

    if (resolvedOptions.retryable !== undefined) {
      this.body.retryable = resolvedOptions.retryable;
    }
  }

  toResponse(): Response {
    return new Response(JSON.stringify(this.body), {
      status: this.status,
      headers: {
        "content-type": "application/json",
      },
    });
  }
}

function normalizeApiErrorOptions(
  options: boolean | ApiErrorOptions | undefined,
): ApiErrorOptions {
  if (typeof options === "boolean") {
    return { retryable: options };
  }

  return options ?? {};
}

export class TurnStartGuardError extends ApiError {
  readonly details: TurnStartGuardFailureDetails;

  constructor(details: TurnStartGuardFailureDetails) {
    super(
      409,
      "invalid_request",
      `Cannot append ${details.eventType} for turn ${details.turnId} before turn/started is stored`,
    );
    this.name = "TurnStartGuardError";
    this.details = details;
  }
}

interface FailedRequest {
  method: string;
  path: string;
}

interface ReportedRequest {
  method: string;
  route: string;
}

export function createServerErrorHandler(logger: ServerLogger): ErrorHandler {
  return (error, context) => {
    const signal = context.req.raw.signal;

    const requestBodyDisconnected =
      error.name === "Error" &&
      error.message === "aborted" &&
      "code" in error &&
      error.code === "ECONNRESET" &&
      signal.reason === "Error: aborted";

    if (
      signal.aborted &&
      (error.name === "AbortError" || requestBodyDisconnected)
    ) {
      return Response.json(
        { code: "request_cancelled", message: "Request cancelled" },
        { status: 499 },
      );
    }

    return errorToResponse(
      error,
      logger,
      {
        method: context.req.method,
        path: context.req.path,
      },
      {
        method: context.req.method,
        route: routePath(context) || "unmatched",
      },
    );
  };
}

function reportServerError(
  error: unknown,
  status: number,
  request: ReportedRequest,
): void {
  captureProcessError(error, {
    level: "error",
    stage: "request",
    diagnostic: timelineProjectionDiagnostic(error),
    tags: {
      method: request.method,
      route: request.route,
      status: String(status),
      ...(error instanceof ApiError ? { code: error.body.code } : {}),
    },
  });
}

function errorToResponse(
  error: unknown,
  logger: ServerLogger,
  request: FailedRequest,
  reportedRequest: ReportedRequest,
): Response {
  if (error instanceof QueuedMessageThreadUnavailableError) {
    return new ApiError(409, "thread_not_writable", error.message).toResponse();
  }

  if (error instanceof ProjectAttachmentError) {
    return new ApiError(400, "invalid_request", error.message).toResponse();
  }

  if (error instanceof TurnStartGuardError) {
    logger.warn(
      { err: error, ...error.details },
      "Rejected turn-scoped server event before turn/started",
    );

    return error.toResponse();
  }

  if (error instanceof HTTPException && error.status >= 500) {
    logger.error(
      {
        err: error,
        ...request,
        status: error.status,
        ...(error instanceof ApiError ? { body: error.body } : {}),
      },
      "Server error response",
    );

    if (!(error instanceof ApiError) || error.status === 500) {
      reportServerError(error, error.status, reportedRequest);
    }
  }

  if (error instanceof ApiError) {
    return error.toResponse();
  }

  if (error instanceof HTTPException) {
    return new Response(
      JSON.stringify({
        code: "internal_error",
        message: error.message,
      }),
      {
        status: error.status,
        headers: {
          "content-type": "application/json",
        },
      },
    );
  }

  logger.error({ err: error, ...request }, "Unhandled server error");
  reportServerError(error, 500, reportedRequest);

  return new Response(
    JSON.stringify({
      code: "internal_error",
      message: "Internal server error",
    }),
    {
      status: 500,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

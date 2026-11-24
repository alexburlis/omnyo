import {
  getLastStoredTurnRequestEvent,
  getLatestStoredRateLimitsEvent,
  getLatestStoredThreadEventOfTypes,
  getThread,
  listStoredTurnInputAcceptedRowsByClientRequestIds,
  listStoredTurnRejectedRowsByClientRequestIds,
  type DbConnection,
  type StoredThreadEventDataRow,
} from "@omnyo/db";
import {
  providerErrorInfoSchema,
  providerRateLimitStateSchema,
  threadEventTurnStatusSchema,
  systemThreadInterruptedEventDataSchema,
  systemErrorEventDataSchema,
  type ClientTurnRequestId,
  type ProviderErrorInfo,
  type ProviderRateLimitState,
  type Thread,
  type TurnRequestEventData,
} from "@omnyo/domain";
import type { PluginTurnFailedEvent } from "@omnyo/plugin-sdk";
import { z } from "zod";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

const providerErrorDataSchema = z.object({
  message: z.string(),
  detail: z.string().nullish(),
  errorInfo: providerErrorInfoSchema.optional(),
});

const rateLimitsDataSchema = z.object({
  rateLimits: providerRateLimitStateSchema,
});

const rejectedReasonDataSchema = z.object({
  reason: z.string(),
});

const systemErrorCodeDataSchema = z.object({
  code: z.string(),
});

const PROVIDER_PROCESS_EXITED_CODE = "provider_process_exited";

const PROVIDER_PROCESS_EXITED_ERROR_INFO: ProviderErrorInfo = {
  category: "connection-failed",
  providerCode: PROVIDER_PROCESS_EXITED_CODE,
  httpStatusCode: null,
};

function parseRowData(row: StoredThreadEventDataRow): unknown {
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

const terminalFailureDataSchema = z.object({
  status: threadEventTurnStatusSchema,
  error: z.object({ message: z.string() }).nullish(),
});

const rejectedFailureDataSchema = z.object({
  requestId: z.string(),
  message: z.string(),
});

export interface FailedTurnRecord {
  request: TurnRequestEventData;
  requestSequence: number;
}

export function loadFailedTurn(
  db: DbConnection,
  threadId: string,
): FailedTurnRecord | null {
  const row = getLastStoredTurnRequestEvent(db, threadId);

  if (row === null) return null;

  try {
    return {
      request: parseStoredTurnRequestEvent(row),
      requestSequence: row.sequence,
    };
  } catch {
    return null;
  }
}

export function loadFailedTurnErrorMessage(
  db: DbConnection,
  threadId: string,
): string | null {
  const failed = loadFailedTurn(db, threadId);

  if (failed === null && getLastStoredTurnRequestEvent(db, threadId) !== null) {
    return null;
  }

  const afterSequence = failed?.requestSequence ?? 0;

  const terminal = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["turn/completed", "client/turn/rejected"],
    afterSequence,
  });

  if (terminal?.type === "turn/completed") {
    const data = terminalFailureDataSchema.safeParse(
      parseRowData(terminal),
    ).data;

    if (data === undefined || data.status !== "failed") return null;

    if (data.error?.message && data.error.message !== "Provider error")
      return data.error.message;
  } else if (terminal?.type === "client/turn/rejected") {
    const data = rejectedFailureDataSchema.safeParse(
      parseRowData(terminal),
    ).data;

    return data?.requestId === failed?.request.requestId
      ? (data?.message ?? null)
      : null;
  }

  const error = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["provider/error", "system/error"],
    afterSequence,
  });

  if (error === null) return null;
  const data = providerErrorDataSchema.safeParse(parseRowData(error)).data;

  return data?.detail?.trim() || data?.message || null;
}

export function retryChain(request: TurnRequestEventData): {
  attemptNumber: number;
  originalRequestId: ClientTurnRequestId;
} {
  return {
    attemptNumber: request.retryAttempt ?? 1,
    originalRequestId: request.retryOfRequestId ?? request.requestId,
  };
}

export function wasFailedTurnInputAccepted(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): boolean {
  return (
    listStoredTurnInputAcceptedRowsByClientRequestIds(db, {
      threadId: args.threadId,
      clientRequestIds: [args.failed.request.requestId],
      afterSequence: args.failed.requestSequence,
    }).length > 0
  );
}

function doorRejectionErrorInfo(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): ProviderErrorInfo | null {
  const row = listStoredTurnRejectedRowsByClientRequestIds(db, {
    threadId: args.threadId,
    clientRequestIds: [args.failed.request.requestId],
    afterSequence: args.failed.requestSequence,
  })[0];

  if (row === undefined) return null;

  const reason = rejectedReasonDataSchema.safeParse(parseRowData(row)).data
    ?.reason;

  switch (reason) {
    case "rate_limited":
      return {
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: null,
      };
    case "auth_required":
      return {
        category: "unauthorized",
        providerCode: null,
        httpStatusCode: null,
      };
    case PROVIDER_PROCESS_EXITED_CODE:
      return PROVIDER_PROCESS_EXITED_ERROR_INFO;
    default:
      return null;
  }
}

function providerExitErrorInfo(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): ProviderErrorInfo | null {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["system/error"],
    afterSequence: args.failed.requestSequence,
  });

  if (row === null) return null;

  return systemErrorCodeDataSchema.safeParse(parseRowData(row)).data?.code ===
    PROVIDER_PROCESS_EXITED_CODE
    ? PROVIDER_PROCESS_EXITED_ERROR_INFO
    : null;
}

function hostInterruptionErrorInfo(
  db: DbConnection,
  args: { threadId: string; failed: FailedTurnRecord },
): ProviderErrorInfo | null {
  const row = getLatestStoredThreadEventOfTypes(db, {
    threadId: args.threadId,
    types: ["system/thread/interrupted"],
    afterSequence: args.failed.requestSequence,
  });

  if (row === null) return null;

  const interruption = systemThreadInterruptedEventDataSchema.safeParse(
    parseRowData(row),
  ).data;

  if (interruption?.reason !== "host-daemon-restarted") return null;

  return {
    category: "connection-failed",
    providerCode: interruption.cause ?? interruption.reason,
    httpStatusCode: null,
  };
}

export function buildTurnFailedEvent(
  db: DbConnection,
  threadId: string,
): PluginTurnFailedEvent | null {
  const thread = getThread(db, threadId);

  if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
    return null;
  }

  const failed = loadFailedTurn(db, threadId);

  if (failed === null) return null;

  const providerError = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["provider/error"],
    afterSequence: failed.requestSequence,
  });

  const commandFailure = getLatestStoredThreadEventOfTypes(db, {
    threadId,
    types: ["system/error"],
    afterSequence: failed.requestSequence,
  });

  const commandFailureData =
    commandFailure === null
      ? undefined
      : systemErrorEventDataSchema.safeParse(parseRowData(commandFailure)).data;

  const providerErrorInfo: ProviderErrorInfo | null =
    providerError === null
      ? null
      : (providerErrorDataSchema.safeParse(parseRowData(providerError)).data
          ?.errorInfo ?? null);

  return {
    threadId,
    requestId: failed.request.requestId,
    turnId: providerError?.turnId ?? null,
    errorInfo:
      providerErrorInfo ??
      commandFailureData?.errorInfo ??
      doorRejectionErrorInfo(db, { threadId, failed }) ??
      providerExitErrorInfo(db, { threadId, failed }) ??
      hostInterruptionErrorInfo(db, { threadId, failed }),
    inputAccepted: wasFailedTurnInputAccepted(db, { threadId, failed }),
    rateLimits: commandFailureData?.rateLimits ?? latestRateLimits(db, thread),
    attemptNumber: retryChain(failed.request).attemptNumber,
  };
}

function latestRateLimits(
  db: DbConnection,
  thread: Thread,
): ProviderRateLimitState | null {
  const row = getLatestStoredRateLimitsEvent(db, {
    threadId: thread.id,
  });

  if (row === null) return null;

  return (
    rateLimitsDataSchema.safeParse(parseRowData(row)).data?.rateLimits ?? null
  );
}

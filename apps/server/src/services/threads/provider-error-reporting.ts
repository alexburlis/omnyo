import { createHash } from "node:crypto";
import { eq, gte, and } from "drizzle-orm";
import {
  getThread,
  getAppSettings,
  getLatestStoredThreadEventOfTypes,
  threadFailures,
  type DbConnection,
} from "@omnyo/db";
import { systemErrorEventDataSchema } from "@omnyo/domain";
import {
  captureProcessError,
  type ErrorDiagnosticContext,
} from "@omnyo/process-utils/error-reporting";
import { listOpenFailures } from "../inbox/store.js";
import {
  buildTurnFailedEvent,
  loadFailedTurn,
  loadFailedTurnErrorMessage,
} from "./turn-failed.js";

const observationStartedAt = Date.now();

const reportedFailures = new WeakMap<DbConnection, Set<string>>();

const MAX_REPORTED_FAILURES = 4096;

const RETIRED_CLAUDE_POOL_ERROR =
  "API Error: 409 This conversation used an older Claude account pool. Use Account Pooler bypass for this thread to sign in directly through Claude Code, or start a new conversation to use a pooled Anthropic API key.";

const expectedCodes = new Set([
  "provision_cancelled",
  "runtime_update_busy",
  "runtime_update_held",
  "cancelled",
  "canceled",
  "request_cancelled",
  "turn_cancelled",
  "ABORT_ERR",
]);

const expectedCategories = new Set([
  "rate-limit",
  "billing",
  "budget-exceeded",
  "active-turn-not-steerable",
]);

function failureClass(
  category: string | undefined,
): ErrorDiagnosticContext["failureClass"] {
  switch (category) {
    case "connection-failed":
    case "stream-disconnected":
      return "connection";
    case "bad-request":
    case "context-window-exceeded":
    case "policy":
      return "upstream-rejected";
    case "overloaded":
      return "upstream-unavailable";
    case "internal":
      return "internal";
    default:
      return "unknown";
  }
}

export function captureActionableProviderFailures(
  db: DbConnection,
  threadIds: readonly string[],
): void {
  let seen = reportedFailures.get(db);

  if (seen === undefined) {
    seen = new Set();
    reportedFailures.set(db, seen);
  }

  for (const failure of listOpenFailures(db, threadIds)) {
    if (
      failure.state !== "actionable" ||
      failure.createdAt < observationStartedAt ||
      seen.has(failure.id)
    )
      continue;
    const failed = buildTurnFailedEvent(db, failure.threadId);
    const request = loadFailedTurn(db, failure.threadId);
    const thread = getThread(db, failure.threadId);

    if (
      failed === null ||
      request === null ||
      failure.requestId === null ||
      failure.requestId !== failed.requestId ||
      thread?.status !== "error"
    )
      continue;
    seen.add(failure.id);

    if (seen.size > MAX_REPORTED_FAILURES) {
      const oldest = seen.values().next().value;

      if (oldest !== undefined) seen.delete(oldest);
    }

    if (!getAppSettings(db).crashReportsEnabled) continue;

    const errorInfo = failed.errorInfo;
    const category = errorInfo?.category;

    if (
      (category !== undefined && expectedCategories.has(category)) ||
      expectedCodes.has(errorInfo?.providerCode ?? "") ||
      (thread.providerId === "claude-code" &&
        category === "bad-request" &&
        errorInfo?.httpStatusCode === 409 &&
        errorInfo.providerCode === null &&
        loadFailedTurnErrorMessage(db, thread.id) === RETIRED_CLAUDE_POOL_ERROR)
    )
      continue;

    const systemError = getLatestStoredThreadEventOfTypes(db, {
      threadId: failure.threadId,
      types: ["system/error"],
      afterSequence: request.requestSequence,
    });

    let commandCode: string | undefined;
    let expectedFailure: boolean | undefined;

    if (systemError !== null) {
      try {
        const data = systemErrorEventDataSchema.safeParse(
          JSON.parse(systemError.data),
        ).data;

        commandCode = data?.commandErrorCode;
        expectedFailure = data?.expectedFailure;
      } catch {}
    }

    if (
      expectedFailure === true ||
      expectedCodes.has(commandCode ?? "") ||
      (errorInfo === null &&
        (commandCode === undefined || expectedFailure !== false))
    )
      continue;

    const eventId = createHash("sha256")
      .update(failure.id)
      .digest("hex")
      .slice(0, 32);

    const operationId = `${eventId.slice(0, 8)}-${eventId.slice(8, 12)}-${eventId.slice(12, 16)}-${eventId.slice(16, 20)}-${eventId.slice(20)}`;
    const status = errorInfo?.httpStatusCode;
    const error = new Error("Provider operation failed");
    error.stack = undefined;
    captureProcessError(error, {
      level: "error",
      stage: "request",
      eventId,
      diagnostic: {
        operation:
          commandCode === undefined ? "provider-request" : "thread-startup",
        stage: "complete",
        failureClass: failureClass(category),
        outcome: "terminal",
        retryable: false,
        dependency: commandCode === undefined ? "provider" : "host-daemon",
        operationId,
        attempt: failed.attemptNumber,
        ...(status !== null &&
        status !== undefined &&
        Number.isInteger(status) &&
        status >= 100 &&
        status <= 599
          ? { status }
          : {}),
      },
    });
  }
}

export function captureDueProviderFailures(db: DbConnection): void {
  const rows = db
    .select({ threadId: threadFailures.threadId })
    .from(threadFailures)
    .where(
      and(
        eq(threadFailures.state, "actionable"),
        gte(threadFailures.createdAt, observationStartedAt),
      ),
    )
    .limit(4096)
    .all();

  captureActionableProviderFailures(db, [
    ...new Set(rows.map((row) => row.threadId)),
  ]);
}

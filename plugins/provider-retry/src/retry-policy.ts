import type { RetryAvailabilityLookup } from "./diagnostics.js";
import type { PluginTurnFailedEvent } from "@omnyo/plugin-sdk";

export const RESET_BUFFER_MS = 15_000;

export const RESET_JITTER_MS = 30_000;

export const DEFAULT_MAXIMUM_WAIT_MS = 6 * 60 * 60 * 1_000;

export const OVERLOAD_RETRY_BASE_MS = 5_000;

export const MAX_RETRY_ATTEMPTS = 5;

export const OVERLOAD_SLOW_RETRY_INTERVAL_MS = 15 * 60 * 1_000;

export const OVERLOAD_SLOW_RETRY_JITTER_MS = 60_000;

export type RetryDeclineReason =
  | "not-retryable"
  | "no-rate-limit-state"
  | "not-resettable"
  | "beyond-maximum-wait"
  | "attempts-exhausted"
  | "pool-unavailable";

export type RetryDecision =
  | { kind: "decline"; reason: RetryDeclineReason }
  | {
      kind: "retry";
      sendAt: number;
      reason:
        | "Rate limited"
        | "Checking account availability"
        | "The account reset time is unknown"
        | "Provider overloaded"
        | "Provider connection interrupted"
        | "Provider temporarily unavailable";
    };

export interface RetryPolicyInput {
  failure: PluginTurnFailedEvent;
  availability: RetryAvailabilityLookup;
  maximumWaitMs: number | null;
  now: number;
  random: number;
}

export function blockedWindowResetAtMs(
  rateLimits: NonNullable<PluginTurnFailedEvent["rateLimits"]>,
): number | null {
  const blocked = rateLimits.windows.filter(
    (window) => window.status === "blocked",
  );

  const relevant = blocked.length > 0 ? blocked : rateLimits.windows;

  const resets = relevant.flatMap((window) =>
    window.resetsAtMs === null ? [] : [window.resetsAtMs],
  );

  return resets.length === 0 ? null : Math.max(...resets);
}

export function verifiedResetAtMs(
  failure: PluginTurnFailedEvent,
  availability: RetryAvailabilityLookup,
): number | null {
  if (availability.kind === "blocked") return availability.retryAt;

  if (availability.kind !== "not-routed") return null;
  const rateLimits = failure.rateLimits;

  if (
    rateLimits === null ||
    rateLimits.status !== "blocked" ||
    rateLimits.kind !== "subscription-window"
  )
    return null;

  return blockedWindowResetAtMs(rateLimits);
}

export function sendAtMs(args: {
  resetsAtMs: number;
  now: number;
  random: number;
}): number {
  const base = Math.max(args.resetsAtMs, args.now);

  return base + RESET_BUFFER_MS + Math.floor(args.random * RESET_JITTER_MS);
}

export function overloadedSendAtMs(args: {
  attemptNumber: number;
  now: number;
  random: number;
}): number {
  const delay = OVERLOAD_RETRY_BASE_MS * 2 ** (args.attemptNumber - 1);

  return args.now + delay + Math.floor(args.random * delay);
}

export function isRateLimitFailure(failure: PluginTurnFailedEvent): boolean {
  return (
    failure.errorInfo?.category === "rate-limit" ||
    failure.errorInfo?.httpStatusCode === 429
  );
}

export function slowOverloadRetryLimit(maximumWaitMs: number | null): number {
  return maximumWaitMs === null
    ? Number.POSITIVE_INFINITY
    : Math.floor(maximumWaitMs / OVERLOAD_SLOW_RETRY_INTERVAL_MS);
}

function slowRetryDelayMs(random: number): number {
  return (
    OVERLOAD_SLOW_RETRY_INTERVAL_MS +
    Math.floor(random * OVERLOAD_SLOW_RETRY_JITTER_MS)
  );
}

function decideUnknownSubscriptionResetRetry(
  input: RetryPolicyInput,
): RetryDecision {
  const { attemptNumber } = input.failure;

  if (attemptNumber >= MAX_RETRY_ATTEMPTS)
    return { kind: "decline", reason: "attempts-exhausted" };

  const delayMs = slowRetryDelayMs(input.random);

  const priorWaitCeilingMs =
    (attemptNumber - 1) *
    (OVERLOAD_SLOW_RETRY_INTERVAL_MS + OVERLOAD_SLOW_RETRY_JITTER_MS - 1);

  if (
    input.maximumWaitMs !== null &&
    priorWaitCeilingMs + delayMs > input.maximumWaitMs
  )
    return { kind: "decline", reason: "beyond-maximum-wait" };

  return {
    kind: "retry",
    sendAt: input.now + delayMs,
    reason: "The account reset time is unknown",
  };
}

function decideOverloadRetry(input: RetryPolicyInput): RetryDecision {
  const { attemptNumber } = input.failure;

  if (attemptNumber < MAX_RETRY_ATTEMPTS)
    return {
      kind: "retry",
      sendAt: overloadedSendAtMs({
        attemptNumber,
        now: input.now,
        random: input.random,
      }),
      reason: "Provider overloaded",
    };

  const slowRetry = attemptNumber - MAX_RETRY_ATTEMPTS + 1;

  if (slowRetry > slowOverloadRetryLimit(input.maximumWaitMs))
    return { kind: "decline", reason: "attempts-exhausted" };

  return {
    kind: "retry",
    sendAt: input.now + slowRetryDelayMs(input.random),
    reason: "Provider overloaded",
  };
}

export function decideRetry(input: RetryPolicyInput): RetryDecision {
  const { failure } = input;

  if (failure.errorInfo?.category === "overloaded")
    return decideOverloadRetry(input);

  if (
    failure.attemptNumber >= MAX_RETRY_ATTEMPTS &&
    !isRateLimitFailure(failure)
  ) {
    return { kind: "decline", reason: "attempts-exhausted" };
  }

  const category = failure.errorInfo?.category;
  const status = failure.errorInfo?.httpStatusCode;

  const connectionFailure =
    (category === "stream-disconnected" || category === "connection-failed") &&
    (status == null || status === 408 || status === 499 || status >= 500);

  const serverFailure =
    category === "internal" && status != null && status >= 500;

  if (connectionFailure || serverFailure)
    return {
      kind: "retry",
      sendAt: overloadedSendAtMs({
        attemptNumber: failure.attemptNumber,
        now: input.now,
        random: input.random,
      }),
      reason: connectionFailure
        ? "Provider connection interrupted"
        : "Provider temporarily unavailable",
    };

  if (!isRateLimitFailure(failure)) {
    return { kind: "decline", reason: "not-retryable" };
  }

  if (input.availability.kind !== "not-routed") {
    if (input.availability.kind === "lookup-failed") {
      if (failure.attemptNumber >= MAX_RETRY_ATTEMPTS) {
        if (
          failure.attemptNumber - MAX_RETRY_ATTEMPTS + 1 >
          slowOverloadRetryLimit(input.maximumWaitMs)
        )
          return { kind: "decline", reason: "attempts-exhausted" };

        return {
          kind: "retry",
          sendAt: input.now + slowRetryDelayMs(input.random),
          reason: "Checking account availability",
        };
      }

      return {
        kind: "retry",
        sendAt: overloadedSendAtMs({
          attemptNumber: failure.attemptNumber,
          now: input.now,
          random: input.random,
        }),
        reason: "Rate limited",
      };
    }

    if (input.availability.kind === "unavailable") {
      if (
        input.availability.reason === "reset-unknown" ||
        input.availability.reason === "source-unavailable"
      ) {
        if (failure.attemptNumber > slowOverloadRetryLimit(input.maximumWaitMs))
          return { kind: "decline", reason: "attempts-exhausted" };

        return {
          kind: "retry",
          sendAt: input.now + slowRetryDelayMs(input.random),
          reason: "Checking account availability",
        };
      }

      return { kind: "decline", reason: "pool-unavailable" };
    }

    const resetsAtMs =
      input.availability.kind === "ready"
        ? input.now +
          (failure.attemptNumber >= MAX_RETRY_ATTEMPTS
            ? OVERLOAD_SLOW_RETRY_INTERVAL_MS
            : 0)
        : input.availability.retryAt;

    if (
      input.maximumWaitMs !== null &&
      resetsAtMs - input.now > input.maximumWaitMs
    )
      return { kind: "decline", reason: "beyond-maximum-wait" };

    return {
      kind: "retry",
      sendAt: sendAtMs({ resetsAtMs, now: input.now, random: input.random }),
      reason: "Rate limited",
    };
  }

  const rateLimits = failure.rateLimits;

  if (rateLimits === null || rateLimits.status !== "blocked") {
    return { kind: "decline", reason: "no-rate-limit-state" };
  }

  if (rateLimits.kind !== "subscription-window") {
    return { kind: "decline", reason: "not-resettable" };
  }

  const resetsAtMs = blockedWindowResetAtMs(rateLimits);

  if (resetsAtMs === null) return decideUnknownSubscriptionResetRetry(input);

  if (
    input.maximumWaitMs !== null &&
    resetsAtMs - input.now > input.maximumWaitMs
  ) {
    return { kind: "decline", reason: "beyond-maximum-wait" };
  }

  return {
    kind: "retry",
    sendAt: sendAtMs({
      resetsAtMs:
        failure.attemptNumber >= MAX_RETRY_ATTEMPTS && resetsAtMs <= input.now
          ? input.now + OVERLOAD_SLOW_RETRY_INTERVAL_MS
          : resetsAtMs,
      now: input.now,
      random: input.random,
    }),
    reason: "Rate limited",
  };
}

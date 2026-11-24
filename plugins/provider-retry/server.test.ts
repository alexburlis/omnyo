import {
  retryAvailabilityMethod,
  type RetryAvailability,
} from "./src/retry-contract.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeQueueEntry,
  makeTurnFailedEvent,
  type CreateFakePluginHostOptions,
} from "@omnyo/plugin-sdk/testing";
import type { PluginTurnFailedEvent } from "@omnyo/plugin-sdk";
import plugin from "./server.js";
import {
  DEFAULT_MAXIMUM_WAIT_MS,
  MAX_RETRY_ATTEMPTS,
  OVERLOAD_RETRY_BASE_MS,
  OVERLOAD_SLOW_RETRY_INTERVAL_MS,
  OVERLOAD_SLOW_RETRY_JITTER_MS,
  RESET_BUFFER_MS,
  RESET_JITTER_MS,
  decideRetry,
  slowOverloadRetryLimit,
} from "./src/retry-policy.js";

type QueueEntry = ReturnType<typeof makeQueueEntry>;

const NOW_MS = Date.parse("2026-08-05T12:00:00.000Z");

const RESET_AT_MS = NOW_MS + 5 * 60 * 60 * 1_000;

const THREAD_ID = "thread-limited";

const REQUEST_ID = "creq_aaaaaaaaaa";

const PLUGIN_ID = "provider-retry";

type RateLimits = NonNullable<PluginTurnFailedEvent["rateLimits"]>;

function rateLimits(overrides: Partial<RateLimits> = {}): RateLimits {
  return {
    providerId: "codex",
    status: "blocked",
    kind: "subscription-window",
    windows: [
      {
        providerKey: "primary",
        label: "Current session",
        status: "blocked",
        resetsAtMs: RESET_AT_MS,
      },
    ],
    reachedReason: "rate_limit_reached",
    overageStatus: null,
    overageReason: null,
    ...overrides,
  };
}

function failure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  return makeTurnFailedEvent({
    threadId: THREAD_ID,
    requestId: REQUEST_ID,
    errorInfo: {
      category: "rate-limit",
      providerCode: "usage_limit_reached",
      httpStatusCode: 429,
    },
    rateLimits: rateLimits(),
    ...overrides,
  });
}

function overloadedFailure(
  overrides: Partial<PluginTurnFailedEvent> = {},
): PluginTurnFailedEvent {
  return failure({
    errorInfo: {
      category: "overloaded",
      providerCode: "serverOverloaded",
      httpStatusCode: 529,
    },
    rateLimits: null,
    ...overrides,
  });
}

function queuedRetry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return makeQueueEntry({
    id: "queued_1",
    threadId: THREAD_ID,
    sendAt: RESET_AT_MS + RESET_BUFFER_MS,
    waitingOn: { kind: "time" },
    payload: {
      kind: "retry",
      retryOfTurnRequestId: REQUEST_ID,
      attempt: 2,
      reason: "Rate limited",
    },
    ...overrides,
  });
}

interface QueuedMessageTarget {
  threadId: string;
  queuedMessageId: string;
}

interface QueuedMessageSend extends QueuedMessageTarget {
  mode: string;
}

interface RetryRequest {
  threadId: string;
  turnRequestId?: string;
  sendAt?: number;
  reason?: string;
}

function createHost(
  queued: QueueEntry[] = [],
  plugins: NonNullable<CreateFakePluginHostOptions["sdk"]>["plugins"] = {
    experimental_discoverRpc: async () => [],
  },
) {
  const deleted: QueuedMessageTarget[] = [];
  const sent: QueuedMessageSend[] = [];
  const retries: RetryRequest[] = [];

  const sdk: CreateFakePluginHostOptions["sdk"] = {
    plugins,
    threads: {
      queue: { list: async () => queued },
      retry: async (args: RetryRequest) => {
        retries.push(args);

        return {
          ok: true,
          delivery: "queued",
          turnRequestId: args.turnRequestId ?? REQUEST_ID,
          attempt: 2,
          queuedMessageId: "queued_1",
          waitingOn: { kind: "time" },
          sendAt: args.sendAt ?? null,
        };
      },
      queuedMessages: {
        delete: async (args: QueuedMessageTarget) => {
          deleted.push(args);

          return { ok: true };
        },
        send: async (args: QueuedMessageSend) => {
          sent.push(args);

          return { ok: true };
        },
      },
    },
  };

  return {
    ...createFakePluginHost({ pluginId: PLUGIN_ID, sdk }),
    deleted,
    retries,
    sent,
  };
}

describe("provider retry policy", () => {
  it.each(["stream-disconnected", "connection-failed"] as const)(
    "resumes a transient %s with bounded backoff",
    (category) => {
      const decision = decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({
          errorInfo: { category, providerCode: null, httpStatusCode: null },
          rateLimits: null,
        }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      });

      expect(decision).toMatchObject({
        kind: "retry",
        sendAt: NOW_MS + OVERLOAD_RETRY_BASE_MS,
      });
    },
  );

  it.each([
    { category: "internal" as const, httpStatusCode: 503, retry: true },
    { category: "internal" as const, httpStatusCode: null, retry: false },
    {
      category: "connection-failed" as const,
      httpStatusCode: 401,
      retry: false,
    },
    {
      category: "connection-failed" as const,
      httpStatusCode: 400,
      retry: false,
    },
    { category: "unauthorized" as const, httpStatusCode: 503, retry: false },
    { category: "billing" as const, httpStatusCode: null, retry: false },
    { category: "policy" as const, httpStatusCode: null, retry: false },
  ])(
    "recovery eligibility for $category / $httpStatusCode",
    ({ category, httpStatusCode, retry }) => {
      const input = {
        availability: { kind: "not-routed" as const },
        failure: failure({
          errorInfo: { category, providerCode: null, httpStatusCode },
          rateLimits: null,
        }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      };

      expect(decideRetry(input).kind).toBe(retry ? "retry" : "decline");
      expect(
        decideRetry({
          ...input,
          failure: { ...input.failure, attemptNumber: MAX_RETRY_ATTEMPTS },
        }),
      ).toEqual({ kind: "decline", reason: "attempts-exhausted" });
    },
  );

  it("rechecks unknown account availability slowly and respects an explicit cap", () => {
    const input = {
      availability: {
        kind: "unavailable" as const,
        reason: "reset-unknown" as const,
      },
      failure: failure(),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    };

    expect(decideRetry(input)).toEqual({
      kind: "retry",
      sendAt: NOW_MS + OVERLOAD_SLOW_RETRY_INTERVAL_MS,
      reason: "Checking account availability",
    });
    expect(
      decideRetry({
        ...input,
        maximumWaitMs: 3_600_000,
        failure: failure({ attemptNumber: 5 }),
      }),
    ).toEqual({ kind: "decline", reason: "attempts-exhausted" });
  });

  it("waits for the reported reset plus a buffer, jittered within its bound", () => {
    const earliest = decideRetry({
      availability: { kind: "not-routed" },
      failure: failure(),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });

    const latest = decideRetry({
      availability: { kind: "not-routed" },
      failure: failure(),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0.999_999,
    });

    expect(earliest).toEqual({
      kind: "retry",
      sendAt: RESET_AT_MS + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
    expect(latest.kind).toBe("retry");

    if (latest.kind !== "retry") return;
    expect(latest.sendAt).toBeGreaterThan(RESET_AT_MS + RESET_BUFFER_MS);
    expect(latest.sendAt).toBeLessThan(
      RESET_AT_MS + RESET_BUFFER_MS + RESET_JITTER_MS,
    );
  });

  it("retries a temporary direct subscription limit without a reset time within its wait and attempt bounds", () => {
    const decide = (attemptNumber: number, maximumWaitMs: number | null) =>
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({
          attemptNumber,
          rateLimits: rateLimits({
            windows: [
              {
                providerKey: "primary",
                label: "Current session",
                status: "blocked",
                resetsAtMs: null,
              },
            ],
          }),
        }),
        maximumWaitMs,
        now: NOW_MS,
        random: 0.5,
      });

    const delayMs =
      OVERLOAD_SLOW_RETRY_INTERVAL_MS + OVERLOAD_SLOW_RETRY_JITTER_MS / 2;

    expect(decide(1, delayMs)).toEqual({
      kind: "retry",
      sendAt: NOW_MS + delayMs,
      reason: "The account reset time is unknown",
    });
    expect(decide(2, delayMs)).toEqual({
      kind: "decline",
      reason: "beyond-maximum-wait",
    });
    expect(decide(MAX_RETRY_ATTEMPTS, null)).toEqual({
      kind: "decline",
      reason: "attempts-exhausted",
    });
  });

  it("never schedules a retry in the past when the reset has already passed", () => {
    const decision = decideRetry({
      availability: { kind: "not-routed" },
      failure: failure({
        rateLimits: rateLimits({
          windows: [
            {
              providerKey: "primary",
              label: "Current session",
              status: "blocked",
              resetsAtMs: NOW_MS - 60_000,
            },
          ],
        }),
      }),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });

    expect(decision).toEqual({
      kind: "retry",
      sendAt: NOW_MS + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
  });

  it("waits for the latest blocked window, not the first to open", () => {
    const weekly = RESET_AT_MS + 48 * 60 * 60 * 1_000;

    const decision = decideRetry({
      availability: { kind: "not-routed" },
      failure: failure({
        rateLimits: rateLimits({
          windows: [
            {
              providerKey: "session",
              label: "Session",
              status: "blocked",
              resetsAtMs: RESET_AT_MS,
            },
            {
              providerKey: "weekly",
              label: "Weekly",
              status: "blocked",
              resetsAtMs: weekly,
            },
          ],
        }),
      }),
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0,
    });

    expect(decision).toEqual({
      kind: "retry",
      sendAt: weekly + RESET_BUFFER_MS,
      reason: "Rate limited",
    });
  });

  it("declines a reset beyond the configured maximum wait", () => {
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure(),
        maximumWaitMs: 60 * 60 * 1_000,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "beyond-maximum-wait" });
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure(),
        maximumWaitMs: 24 * 60 * 60 * 1_000,
        now: NOW_MS,
        random: 0,
      }).kind,
    ).toBe("retry");
  });

  it("retries overloads with exponential backoff and bounded jitter", () => {
    const overloaded = overloadedFailure();
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: overloaded,
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({
      kind: "retry",
      sendAt: NOW_MS + OVERLOAD_RETRY_BASE_MS,
      reason: "Provider overloaded",
    });

    const fourthAttempt = decideRetry({
      availability: { kind: "not-routed" },
      failure: { ...overloaded, attemptNumber: 4 },
      maximumWaitMs: null,
      now: NOW_MS,
      random: 0.999_999,
    });

    expect(fourthAttempt.kind).toBe("retry");

    if (fourthAttempt.kind !== "retry") return;
    const fourthDelay = OVERLOAD_RETRY_BASE_MS * 2 ** 3;
    expect(fourthAttempt.sendAt).toBeGreaterThan(NOW_MS + fourthDelay);
    expect(fourthAttempt.sendAt).toBeLessThan(NOW_MS + fourthDelay * 2);
  });

  it("declines failures that are not retryable, and limits that do not reset", () => {
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({
          errorInfo: {
            category: "bad-request",
            providerCode: null,
            httpStatusCode: 400,
          },
        }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "not-retryable" });
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({ rateLimits: null }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "no-rate-limit-state" });
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({ rateLimits: rateLimits({ kind: "credits" }) }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "not-resettable" });
  });

  it("keeps known-reset retries scheduled while bounding connection retries", () => {
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({ attemptNumber: MAX_RETRY_ATTEMPTS }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toMatchObject({ kind: "retry", reason: "Rate limited" });
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({ attemptNumber: MAX_RETRY_ATTEMPTS - 1 }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }).kind,
    ).toBe("retry");
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: failure({
          errorInfo: {
            category: "stream-disconnected",
            providerCode: null,
            httpStatusCode: null,
          },
          rateLimits: null,
          attemptNumber: MAX_RETRY_ATTEMPTS,
        }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }),
    ).toEqual({ kind: "decline", reason: "attempts-exhausted" });
  });

  it("keeps retrying a model at capacity every 15 minutes until the maximum wait", () => {
    const decide = (attemptNumber: number, random = 0) =>
      decideRetry({
        availability: { kind: "not-routed" },
        failure: overloadedFailure({ attemptNumber }),
        maximumWaitMs: DEFAULT_MAXIMUM_WAIT_MS,
        now: NOW_MS,
        random,
      });

    expect(slowOverloadRetryLimit(DEFAULT_MAXIMUM_WAIT_MS)).toBe(24);
    expect(decide(MAX_RETRY_ATTEMPTS)).toEqual({
      kind: "retry",
      sendAt: NOW_MS + OVERLOAD_SLOW_RETRY_INTERVAL_MS,
      reason: "Provider overloaded",
    });

    const jittered = decide(MAX_RETRY_ATTEMPTS, 0.999_999);

    expect(jittered.kind).toBe("retry");

    if (jittered.kind !== "retry") return;
    expect(jittered.sendAt).toBeLessThan(
      NOW_MS + OVERLOAD_SLOW_RETRY_INTERVAL_MS + OVERLOAD_SLOW_RETRY_JITTER_MS,
    );
    expect(decide(MAX_RETRY_ATTEMPTS + 23).kind).toBe("retry");
    expect(decide(MAX_RETRY_ATTEMPTS + 24)).toEqual({
      kind: "decline",
      reason: "attempts-exhausted",
    });
    expect(
      decideRetry({
        availability: { kind: "not-routed" },
        failure: overloadedFailure({ attemptNumber: 500 }),
        maximumWaitMs: null,
        now: NOW_MS,
        random: 0,
      }).kind,
    ).toBe("retry");
  });
});

describe("provider retry plugin", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("listens for one event and answers no hook", async () => {
    const host = createHost();
    await plugin(host.api);

    expect(host.harness.registrations.settingsDescriptors).toEqual({
      maximumWait: {
        type: "select",
        label: "Maximum automatic wait",
        description:
          "Longest wait for a subscription limit to reset, and roughly how long to keep retrying a model at capacity every 15 minutes.",
        options: ["6 hours", "24 hours", "No limit"],
        default: "No limit",
      },
    });
    expect(host.harness.registrations.threadEventHandlers["turn.failed"]).toBe(
      1,
    );
    expect(host.harness.registrations.hooks["message.dispatch"]).toBeNull();
    expect(
      host.harness.registrations.cli?.commands.map((command) => command.name),
    ).toEqual(["status", "explain", "cancel", "retry"]);
    await host.harness.dispose();
  });

  it("asks core to retry the failed turn at the reset window", async () => {
    const host = createHost();
    await plugin(host.api);

    const { errors } = await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure(),
    );

    expect(errors).toEqual([]);
    expect(host.retries).toHaveLength(1);
    const retry = host.retries[0];
    expect(retry?.threadId).toBe(THREAD_ID);
    expect(retry?.turnRequestId).toBe(REQUEST_ID);
    expect(retry?.sendAt).toBeGreaterThanOrEqual(RESET_AT_MS + RESET_BUFFER_MS);
    expect(retry?.reason).toBe("Rate limited");
    await host.harness.dispose();
  });

  it.each<{
    availability: RetryAvailability;
    scheduled: boolean;
    reason: string;
  }>([
    {
      availability: { kind: "ready" },
      scheduled: true,
      reason: "Rate limited",
    },
    {
      availability: { kind: "blocked", retryAt: RESET_AT_MS },
      scheduled: true,
      reason: "Rate limited",
    },
    {
      availability: { kind: "blocked", retryAt: NOW_MS + 7 * 3_600_000 },
      scheduled: true,
      reason: "Rate limited",
    },
    {
      availability: { kind: "unavailable", reason: "reset-unknown" },
      scheduled: true,
      reason: "Checking account availability",
    },
  ])(
    "uses pool availability $availability and records an explainable decision",
    async ({ availability, scheduled, reason }) => {
      const host = createHost([], {
        experimental_discoverRpc: async () => [
          {
            pluginId: "account-pool",
            displayName: "Account Pooler",
            method: retryAvailabilityMethod,
          },
        ],
        callRpc: async () => availability,
      });

      await plugin(host.api);
      expect(
        (await host.harness.behavior.emitThreadEvent("turn.failed", failure()))
          .errors,
      ).toEqual([]);
      expect(host.retries).toHaveLength(scheduled ? 1 : 0);

      const explained = await host.harness.runCli([
        "explain",
        THREAD_ID,
        "--json",
      ]);

      expect(explained.exitCode).toBe(0);

      const expected = {
        requestId: REQUEST_ID,
        availability,
        decision: { kind: scheduled ? "retry" : "decline", reason },
      };

      expect(JSON.parse(explained.stdout)).toMatchObject({
        threadId: THREAD_ID,
        diagnostic: expected,
      });
      expect(
        await host.harness.behavior.callRpc("decision.get", {
          threadId: THREAD_ID,
        }),
      ).toMatchObject(expected);
      await host.harness.dispose();
    },
  );

  it("tells Omnyo at once when it declines, naming the incident and its verified reset", async () => {
    const host = createHost();
    const declines: unknown[] = [];

    host.harness.sdk.stub("threads.get", async () => ({
      id: THREAD_ID,
      providerId: "claude-code",
      environmentId: "env_limited",
    }));
    host.harness.sdk.stub("environments.get", async () => ({
      id: "env_limited",
      hostId: "host_mac",
    }));
    host.harness.sdk.stub(
      "experimental_inbox.declineRetry",
      async (args: unknown) => {
        declines.push(args);

        return { state: "actionable" };
      },
    );
    await plugin(host.api);
    await host.harness.setSettings({ maximumWait: "6 hours" });

    const farReset = NOW_MS + 9 * 3_600_000;

    const { errors } = await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({
        rateLimits: rateLimits({
          windows: [
            {
              providerKey: "primary",
              label: "Current session",
              status: "blocked",
              resetsAtMs: farReset,
            },
          ],
        }),
      }),
    );

    expect(errors).toEqual([]);
    expect(host.retries).toEqual([]);
    expect(declines).toEqual([
      {
        threadId: THREAD_ID,
        turnRequestId: REQUEST_ID,
        reason: "beyond-maximum-wait",
        incident: {
          key: "codex:rate-limit:host:host_mac",
          label: "codex usage limit",
          resetAt: farReset,
        },
      },
    ]);
    await host.harness.dispose();
  });

  it("retries a pooled HTTP 429 wrapped by Codex native retry exhaustion", async () => {
    const host = createHost([], {
      experimental_discoverRpc: async () => [
        {
          pluginId: "account-pool",
          displayName: "Account Pooler",
          method: retryAvailabilityMethod,
        },
      ],
      callRpc: async () => ({ kind: "blocked", retryAt: RESET_AT_MS }),
    });

    await plugin(host.api);

    const result = await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      failure({
        errorInfo: {
          category: "too-many-failed-attempts",
          providerCode: "responseTooManyFailedAttempts",
          httpStatusCode: 429,
        },
        rateLimits: null,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(host.retries).toHaveLength(1);
    expect(host.retries[0]?.sendAt).toBeGreaterThanOrEqual(
      RESET_AT_MS + RESET_BUFFER_MS,
    );
    await host.harness.dispose();
  });

  it.each([
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    new Error("source stopped"),
  ])(
    "retries soon after a failed availability lookup ($name) instead of using a stale provider snapshot",
    async (lookupError) => {
      const host = createHost([], {
        experimental_discoverRpc: async () => [
          {
            pluginId: "account-pool",
            displayName: "Account Pooler",
            method: retryAvailabilityMethod,
          },
        ],
        callRpc: async () => {
          throw lookupError;
        },
      });

      await plugin(host.api);
      expect(
        (await host.harness.behavior.emitThreadEvent("turn.failed", failure()))
          .errors,
      ).toEqual([]);
      expect(host.retries).toHaveLength(1);
      expect(host.retries[0]).toMatchObject({
        threadId: THREAD_ID,
        turnRequestId: REQUEST_ID,
        reason: "Rate limited",
      });
      expect(host.retries[0]?.sendAt).toBeGreaterThanOrEqual(
        NOW_MS + OVERLOAD_RETRY_BASE_MS,
      );
      expect(host.retries[0]?.sendAt).toBeLessThan(
        NOW_MS + 2 * OVERLOAD_RETRY_BASE_MS,
      );
      expect(
        await host.harness.behavior.callRpc("decision.get", {
          threadId: THREAD_ID,
        }),
      ).toMatchObject({
        availability: { kind: "lookup-failed" },
        decision: { kind: "retry", reason: "Rate limited" },
      });
      expect(
        (await host.harness.runCli(["explain", THREAD_ID])).stdout,
      ).toContain("availability lookup failed");
      await host.harness.dispose();
    },
  );

  it("slows failed availability lookups after the quick attempt limit", async () => {
    const host = createHost([], {
      experimental_discoverRpc: async () => [
        {
          pluginId: "account-pool",
          displayName: "Account Pooler",
          method: retryAvailabilityMethod,
        },
      ],
      callRpc: async () => {
        throw new Error("source stopped");
      },
    });

    await plugin(host.api);
    expect(
      (
        await host.harness.behavior.emitThreadEvent(
          "turn.failed",
          failure({ attemptNumber: MAX_RETRY_ATTEMPTS }),
        )
      ).errors,
    ).toEqual([]);
    expect(host.retries).toHaveLength(1);
    expect(host.retries[0]?.sendAt).toBeGreaterThanOrEqual(
      NOW_MS + OVERLOAD_SLOW_RETRY_INTERVAL_MS,
    );
    expect(
      await host.harness.behavior.callRpc("decision.get", {
        threadId: THREAD_ID,
      }),
    ).toMatchObject({
      availability: { kind: "lookup-failed" },
      decision: { kind: "retry", reason: "Checking account availability" },
    });
    await host.harness.dispose();
  });

  it("re-reads the maximum wait when the setting changes", async () => {
    const host = createHost();
    await plugin(host.api);
    await host.harness.setSettings({ maximumWait: "6 hours" });

    const beyondSixHours = failure({
      rateLimits: rateLimits({
        windows: [
          {
            providerKey: "primary",
            label: "Weekly",
            status: "blocked",
            resetsAtMs: NOW_MS + 7 * 60 * 60 * 1_000,
          },
        ],
      }),
    });

    await host.harness.behavior.emitThreadEvent("turn.failed", beyondSixHours);
    expect(host.retries).toEqual([]);

    await host.harness.setSettings({ maximumWait: "No limit" });
    await host.harness.behavior.emitThreadEvent("turn.failed", beyondSixHours);
    expect(host.retries).toHaveLength(1);
    await host.harness.dispose();
  });

  it("queues slow retries for a model at capacity once the quick retries are spent", async () => {
    const host = createHost();
    await plugin(host.api);
    await host.harness.setSettings({ maximumWait: "6 hours" });

    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      overloadedFailure({ attemptNumber: MAX_RETRY_ATTEMPTS }),
    );
    expect(host.retries).toEqual([
      {
        threadId: THREAD_ID,
        turnRequestId: REQUEST_ID,
        sendAt: expect.any(Number),
        reason: "Provider overloaded",
      },
    ]);
    expect(host.retries[0]?.sendAt).toBeGreaterThanOrEqual(
      NOW_MS + OVERLOAD_SLOW_RETRY_INTERVAL_MS,
    );

    await host.harness.behavior.emitThreadEvent(
      "turn.failed",
      overloadedFailure({ attemptNumber: MAX_RETRY_ATTEMPTS + 24 }),
    );
    expect(host.retries).toHaveLength(1);
    expect(
      await host.harness.behavior.callRpc("decision.get", {
        threadId: THREAD_ID,
      }),
    ).toMatchObject({
      decision: { kind: "decline", reason: "attempts-exhausted" },
    });
    await host.harness.dispose();
  });

  it("reports pending retries from the queue rather than private state", async () => {
    const host = createHost([queuedRetry()]);
    await plugin(host.api);

    const status = await host.harness.runCli(["status", THREAD_ID, "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout ?? "")).toEqual({
      retries: [
        {
          id: "queued_1",
          threadId: THREAD_ID,
          sendAt: RESET_AT_MS + RESET_BUFFER_MS,
        },
      ],
    });
    expect(
      host.harness.inspection.sdk.callsTo("threads.queue.list")[0]?.[0],
    ).toEqual({ threadId: THREAD_ID });
    await host.harness.dispose();
  });

  it("cancels by deleting the queued row and retries by sending it now", async () => {
    const host = createHost([queuedRetry()]);
    await plugin(host.api);

    const cancelled = await host.harness.runCli(["cancel", THREAD_ID]);
    expect(cancelled.exitCode).toBe(0);
    expect(host.deleted).toEqual([
      { threadId: THREAD_ID, queuedMessageId: "queued_1" },
    ]);

    const retried = await host.harness.runCli(["retry", THREAD_ID]);
    expect(retried.exitCode).toBe(0);
    expect(host.sent).toEqual([
      { threadId: THREAD_ID, queuedMessageId: "queued_1", mode: "auto" },
    ]);
    await host.harness.dispose();
  });

  it("reports no pending retry when no row is queued", async () => {
    const host = createHost();
    await plugin(host.api);

    const status = await host.harness.runCli(["status"]);
    expect(status.stdout).toBe("No provider retries are pending.\n");
    const cancelled = await host.harness.runCli(["cancel", THREAD_ID]);
    expect(cancelled.exitCode).toBe(1);
    expect(host.deleted).toEqual([]);
    await host.harness.dispose();
  });

  it("acts on the invoking thread and says how to name one outside a thread", async () => {
    const host = createHost([queuedRetry()]);
    await plugin(host.api);

    const cancelled = await host.harness.runCli(["cancel"], {
      threadId: THREAD_ID,
    });

    expect(cancelled.exitCode, cancelled.stderr).toBe(0);
    expect(host.deleted).toEqual([
      { threadId: THREAD_ID, queuedMessageId: "queued_1" },
    ]);

    const missing = await host.harness.runCli(["cancel"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr).toContain(
      "A thread id is required: omnyo provider-retry cancel <thread-id>",
    );
    await host.harness.dispose();
  });

  it("documents the optional thread id, exits 2 on usage errors, and reports errors as JSON", async () => {
    const host = createHost();
    await plugin(host.api);

    const help = (await host.harness.runCli(["retry", "--help"])).stdout;
    expect(help).toContain("omnyo provider-retry retry");
    expect(help).toContain("[<thread-id>]");

    const stray = await host.harness.runCli(["retry", THREAD_ID, "extra"]);
    expect(stray.exitCode).toBe(2);
    expect(host.sent).toEqual([]);

    const envelope = await host.harness.runCli(["cancel", THREAD_ID, "--json"]);
    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "no_pending_retry",
        message: `No pending provider retry exists for ${THREAD_ID}.`,
      },
    });
    expect(host.deleted).toEqual([]);
    await host.harness.dispose();
  });
});

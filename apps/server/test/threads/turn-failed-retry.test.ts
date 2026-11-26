import { OWNER_ACTOR } from "../../src/services/inbox/actor.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  claimQueuedThreadMessageGroup,
  environments,
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  setThreadExecutionOverride,
  setQueuedThreadMessageFailureReason,
} from "@omnyo/db";
import { turnScope } from "@omnyo/domain";
import type { ThreadQueuedMessage } from "@omnyo/domain";
import type { PluginHookName } from "@omnyo/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { clearQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import { setServerUpdateDraining } from "../../src/services/system/server-update-drain.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import { interruptActiveThreadsForHost } from "../../src/services/threads/thread-lifecycle.js";
import { readThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import { buildTurnFailedEvent } from "../../src/services/threads/turn-failed.js";
import { retryFailedTurn } from "../../src/services/threads/turn-retry.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const WORKSPACE_PATH = "/tmp/turn-failed-project";

type MessageDispatchRegistration = PluginHookRegistration<"message.dispatch">;

type HookRegistry = {
  [K in PluginHookName]: PluginHookRegistration<K>[];
};

function installHooks(
  handlers: Partial<{ "message.dispatch": MessageDispatchRegistration[] }>,
): void {
  const registry: HookRegistry = {
    "message.dispatch": handlers["message.dispatch"] ?? [],
  };

  setPluginHookProvider({
    listHooks: (hook) => registry[hook],
    invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
    decisionTimeoutMs: 10_000,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  setPluginHookProvider(undefined);
  setPluginThreadEventEmitter(undefined);
});

interface FailureAnnouncement {
  event: "turn.failed" | "thread.failed";
  threadId: string;
}

function recordFailureAnnouncements(): FailureAnnouncement[] {
  const announced: FailureAnnouncement[] = [];
  setPluginThreadEventEmitter({
    emitThreadEvents: () => {},
    emitTerminalInput: () => {},
    emitHostDeleted: () => {},
    emitEnvironmentRemoved: () => {},
    emitThreadCreated: () => {},
    emitThreadActive: () => {},
    emitThreadIdle: () => {},
    emitThreadFailed: (thread) =>
      announced.push({ event: "thread.failed", threadId: thread.id }),
    emitThreadArchived: () => {},
    emitThreadDeleted: () => {},
    emitInteractionPending: () => {},
    emitMessageQueued: () => {},
    emitMessageDispatched: () => {},
    emitMessageCancelled: () => {},
    emitThreadUnarchived: () => {},
    emitThreadParentChanged: () => {},
    emitThreadMaintenance: () => {},
    emitTurnFailed: (threadId) =>
      announced.push({ event: "turn.failed", threadId }),
  });

  return announced;
}

function seedFailableThread(harness: TestAppHarness, hostId: string) {
  const { host } = seedHostSession(harness.deps, { id: hostId });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: WORKSPACE_PATH,
  });

  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    status: "active",
  });

  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    inputText: "Do the thing",
    providerThreadId: `provider-${hostId}`,
    threadId: thread.id,
  });

  return {
    environment,
    host,
    project,
    thread,
    requestId: lastTurnRequest(harness, thread.id).requestId,
  };
}

interface StoredTurnRequest {
  execution: { model: string };
  initiator: string;
  input: { text: string; visibility?: string }[];
  requestId: string;
  retryAttempt?: number;
  retryOfRequestId?: string;
}

function turnRequestData(event: { data: string }): StoredTurnRequest {
  return JSON.parse(event.data) as StoredTurnRequest;
}

function lastTurnRequest(
  harness: TestAppHarness,
  threadId: string,
): StoredTurnRequest {
  const events = turnRequests(harness, threadId);
  const last = events[events.length - 1];

  if (last === undefined) throw new Error("expected a turn request");

  return turnRequestData(last);
}

function seedRateLimitFailure(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    threadId: string;
    resetsAtMs: number;
    category?: string;
  },
) {
  const providerThreadId = "provider-session";
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "provider/rateLimits/updated",
    scope: { kind: "thread" },
    data: {
      providerThreadId,
      rateLimits: {
        providerId: "codex",
        status: "blocked",
        kind: "subscription-window",
        windows: [
          {
            providerKey: "primary",
            label: "Current session",
            status: "blocked",
            resetsAtMs: args.resetsAtMs,
          },
        ],
        reachedReason: "rate_limit_reached",
        overageStatus: null,
        overageReason: null,
      },
    },
  });
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "provider/error",
    scope: { kind: "thread" },
    data: {
      providerThreadId,
      message: "Usage limit reached",
      errorInfo: {
        category: args.category ?? "rate-limit",
        providerCode: "usage_limit_reached",
        httpStatusCode: 429,
      },
    },
  });
}

function seedInputAccepted(
  harness: TestAppHarness,
  args: { environmentId: string; threadId: string; requestId: string },
) {
  const providerThreadId = "provider-session";
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    providerThreadId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "turn/input/accepted",
    scope: { kind: "turn", turnId: "turn-1" },
    data: {
      providerThreadId,
      clientRequestId: args.requestId,
    },
  });
}

function seedDoorRejection(
  harness: TestAppHarness,
  args: {
    environmentId: string;
    threadId: string;
    requestId: string;
    reason: string;
  },
) {
  seedEvent(harness.deps, {
    threadId: args.threadId,
    environmentId: args.environmentId,
    sequence:
      getLatestThreadSequence(harness.db, { threadId: args.threadId }) + 1,
    type: "client/turn/rejected",
    scope: { kind: "thread" },
    data: {
      requestId: args.requestId,
      reason: args.reason,
      message: "Command turn.submit failed",
    },
  });
}

function failThread(harness: TestAppHarness, threadId: string): void {
  applyLoggedThreadLifecycleEvent(harness.deps, {
    event: { type: "run.failed" },
    threadId,
  });
}

function turnRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}

function queuedRows(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage[] {
  return listQueuedThreadMessages(harness.db, threadId)
    .map(toThreadQueuedMessage)
    .filter((entry) => entry.waitingOn !== null);
}

function onlyQueuedRow(
  harness: TestAppHarness,
  threadId: string,
): ThreadQueuedMessage {
  const rows = queuedRows(harness, threadId);

  if (rows.length !== 1 || rows[0] === undefined) {
    throw new Error(`expected exactly one queued row, found ${rows.length}`);
  }

  return rows[0];
}

function requireThread(harness: TestAppHarness, threadId: string) {
  const thread = getThread(harness.db, threadId);

  if (thread === null) throw new Error("expected a thread");

  return thread;
}

async function sweepPastResume(harness: TestAppHarness): Promise<void> {
  await runQueuedMessageDispatch(harness.deps, {
    kind: "time-reached",
    now: Date.now() + 120_000,
  });
}

describe("the turn.failed announcement", () => {
  it("preserves startup quota classification and reset like the equivalent in-turn failure", async () => {
    await withTestHarness(async (harness) => {
      const startup = seedFailableThread(harness, "host-startup-quota");
      const inTurn = seedFailableThread(harness, "host-in-turn-quota");
      const resetsAtMs = Date.now() + 3_600_000;
      seedRateLimitFailure(harness, {
        environmentId: inTurn.environment.id,
        threadId: inTurn.thread.id,
        resetsAtMs,
      });
      failThread(harness, inTurn.thread.id);
      const expected = buildTurnFailedEvent(harness.db, inTurn.thread.id);
      seedEvent(harness.deps, {
        threadId: startup.thread.id,
        environmentId: startup.environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: startup.thread.id }) +
          1,
        type: "system/error",
        scope: { kind: "thread" },
        data: {
          code: "thread_command_failed",
          message: "Command thread.start failed",
          errorInfo: expected?.errorInfo,
          rateLimits: expected?.rateLimits,
        },
      });
      failThread(harness, startup.thread.id);
      const actual = buildTurnFailedEvent(harness.db, startup.thread.id);
      expect(actual?.errorInfo).toEqual(expected?.errorInfo);
      expect(actual?.rateLimits).toEqual(expected?.rateLimits);
      expect(actual?.rateLimits?.windows[0]?.resetsAtMs).toBe(resetsAtMs);

      if (actual === null || expected === null)
        throw new Error("Expected failures");

      const { decideRetry } = await import(
        new URL(
          "../../../../plugins/provider-retry/src/retry-policy.ts",
          import.meta.url,
        ).href
      );

      for (const maximumWaitMs of [30 * 60_000, 6 * 60 * 60_000]) {
        const policy = {
          availability: { kind: "not-routed" },
          maximumWaitMs,
          now: resetsAtMs - 3_600_000,
          random: 0,
        };

        expect(decideRetry({ ...policy, failure: actual })).toEqual(
          decideRetry({ ...policy, failure: expected }),
        );
        expect(decideRetry({ ...policy, failure: actual }).kind).toBe(
          maximumWaitMs < 3_600_000 ? "decline" : "retry",
        );
      }
    });
  });

  it("carries the failed turn's ids and the provider's failure facts", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-ctx",
      );

      const resetsAtMs = Date.now() + 3_600_000;
      seedRateLimitFailure(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        resetsAtMs,
      });

      failThread(harness, thread.id);

      const event = buildTurnFailedEvent(harness.db, thread.id);

      if (event === null) throw new Error("expected a turn.failed payload");
      expect(event.threadId).toBe(thread.id);
      expect(event.requestId).toBe(requestId);

      expect(event.attemptNumber).toBe(1);
      expect(event.errorInfo).toEqual({
        category: "rate-limit",
        providerCode: "usage_limit_reached",
        httpStatusCode: 429,
      });
      expect(event.rateLimits?.windows[0]?.resetsAtMs).toBe(resetsAtMs);
    });
  });

  it("labels a typed door rejection and reports the input as never accepted", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-door",
      );

      seedDoorRejection(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
        reason: "rate_limited",
      });
      failThread(harness, thread.id);

      const event = buildTurnFailedEvent(harness.db, thread.id);

      expect(event?.errorInfo).toEqual({
        category: "rate-limit",
        providerCode: null,
        httpStatusCode: null,
      });
      expect(event?.turnId).toBeNull();
      expect(event?.inputAccepted).toBe(false);

      const unmapped = seedFailableThread(harness, "host-door-unmapped");
      seedDoorRejection(harness, {
        environmentId: unmapped.environment.id,
        threadId: unmapped.thread.id,
        requestId: unmapped.requestId,
        reason: "stale_turn",
      });
      failThread(harness, unmapped.thread.id);

      expect(
        buildTurnFailedEvent(harness.db, unmapped.thread.id)?.errorInfo,
      ).toBeNull();
    });
  });

  it("labels a provider process exit as a retryable connection failure", async () => {
    await withTestHarness(async (harness) => {
      const exitedInfo = {
        category: "connection-failed",
        providerCode: "provider_process_exited",
        httpStatusCode: null,
      };

      const rejected = seedFailableThread(harness, "host-exit-door");
      seedDoorRejection(harness, {
        environmentId: rejected.environment.id,
        threadId: rejected.thread.id,
        requestId: rejected.requestId,
        reason: "provider_process_exited",
      });
      failThread(harness, rejected.thread.id);

      expect(
        buildTurnFailedEvent(harness.db, rejected.thread.id)?.errorInfo,
      ).toEqual(exitedInfo);

      const midTurn = seedFailableThread(harness, "host-exit-turn");
      seedInputAccepted(harness, {
        environmentId: midTurn.environment.id,
        threadId: midTurn.thread.id,
        requestId: midTurn.requestId,
      });
      seedEvent(harness.deps, {
        threadId: midTurn.thread.id,
        environmentId: midTurn.environment.id,
        providerThreadId: "provider-session",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: midTurn.thread.id }) +
          1,
        type: "system/error",
        scope: turnScope("turn-1"),
        data: {
          code: "provider_process_exited",
          message: 'Provider "codex" exited unexpectedly (signal SIGTERM)',
        },
      });
      failThread(harness, midTurn.thread.id);

      expect(
        buildTurnFailedEvent(harness.db, midTurn.thread.id)?.errorInfo,
      ).toEqual(exitedInfo);
    });
  });

  it.each(["manual-stop", "host-removed", "provider-turn-idle"] as const)(
    "does not classify %s as a host connection failure",
    async (reason) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedFailableThread(harness, "host-stop");
        seedEvent(harness.deps, {
          threadId: thread.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "system/thread/interrupted",
          scope: { kind: "thread" },
          data: { reason },
        });
        failThread(harness, thread.id);
        expect(
          buildTurnFailedEvent(harness.db, thread.id)?.errorInfo,
        ).toBeNull();
      });
    },
  );

  it("ignores host interruptions from an earlier request", async () => {
    await withTestHarness(async (harness) => {
      const { environment, host, thread } = seedFailableThread(
        harness,
        "host-old-interruption",
      );

      interruptActiveThreadsForHost(harness.deps, {
        hostId: host.id,
        includeStopping: false,
        reason: "host-daemon-restarted",
      });
      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        providerThreadId: "provider-next-request",
        threadId: thread.id,
        sequenceStart:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
      });
      expect(buildTurnFailedEvent(harness.db, thread.id)?.errorInfo).toBeNull();
    });
  });

  it.each(["unauthorized", "billing"] as const)(
    "preserves a provider %s failure across a host interruption",
    async (category) => {
      await withTestHarness(async (harness) => {
        const { environment, host, thread } = seedFailableThread(
          harness,
          "host-provider-error",
        );

        const errorInfo = {
          category,
          providerCode: "provider-refused",
          httpStatusCode: null,
        };

        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "provider/error",
          scope: { kind: "thread" },
          data: {
            providerThreadId: "provider-session",
            message: "Provider refused",
            errorInfo,
          },
        });
        interruptActiveThreadsForHost(harness.deps, {
          hostId: host.id,
          includeStopping: false,
          reason: "host-daemon-restarted",
        });
        expect(buildTurnFailedEvent(harness.db, thread.id)?.errorInfo).toEqual(
          errorInfo,
        );
      });
    },
  );

  it("reports acceptance when the provider took the input before failing", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-accepted",
      );

      seedInputAccepted(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
      });
      seedRateLimitFailure(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        resetsAtMs: Date.now() + 3_600_000,
      });
      failThread(harness, thread.id);

      expect(buildTurnFailedEvent(harness.db, thread.id)?.inputAccepted).toBe(
        true,
      );
    });
  });

  it("is announced for a failure, before the failed thread, and for nothing else", async () => {
    await withTestHarness(async (harness) => {
      const announced = recordFailureAnnouncements();
      const succeeding = seedFailableThread(harness, "host-ok").thread;
      const failing = seedFailableThread(harness, "host-not-ok").thread;

      applyLoggedThreadLifecycleEvent(harness.deps, {
        event: { type: "run.succeeded" },
        threadId: succeeding.id,
      });
      expect(announced).toEqual([]);

      failThread(harness, failing.id);
      expect(announced).toEqual([
        { event: "turn.failed", threadId: failing.id },
        { event: "thread.failed", threadId: failing.id },
      ]);
    });
  });
});

describe("retrying a failed turn", () => {
  it("recovers the same failed-turn retry after server-update draining clears", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(
        harness,
        "host-update-deferred-retry",
      );

      failThread(harness, thread.id);
      setServerUpdateDraining(harness.db, true);

      await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: requestId,
          sendAt: null,
          reason: "Rate limited",
        },
      });

      expect(onlyQueuedRow(harness, thread.id)).toMatchObject({
        waitingOn: { kind: "server-update" },
        payload: {
          kind: "retry",
          retryOfTurnRequestId: requestId,
          attempt: 2,
        },
      });
      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      setServerUpdateDraining(harness.db, false);

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(2);
      expect(lastTurnRequest(harness, thread.id)).toMatchObject({
        retryOfRequestId: requestId,
        retryAttempt: 2,
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
      expect(turnRequests(harness, thread.id)).toHaveLength(2);
    });
  });

  it("queues a by-reference row on the clock and re-submits the original turn", async () => {
    await withTestHarness(async (harness) => {
      const sendAt = Date.now() + 60_000;
      const { requestId, thread } = seedFailableThread(harness, "host-retry");
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: requestId, sendAt, reason: "Rate limited" },
      });

      expect(result).toMatchObject({
        delivery: "queued",
        turnRequestId: requestId,
        attempt: 2,
      });
      const queued = onlyQueuedRow(harness, thread.id);

      expect(queued.payload).toEqual({
        kind: "retry",
        retryOfTurnRequestId: requestId,
        attempt: 2,
        reason: "Rate limited",
      });
      expect(queued.waitingOn).toEqual({ kind: "time" });
      expect(queued.sendAt).toBe(sendAt);

      await sweepPastResume(harness);

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      const retryRequest = requests[1];

      if (retryRequest === undefined) throw new Error("expected a retry turn");
      const data = turnRequestData(retryRequest);

      expect(data.retryOfRequestId).toBe(requestId);
      expect(data.retryAttempt).toBe(2);

      expect(data.input[0]?.text).toBe("Do the thing");
      expect(data.execution.model).toBe("gpt-5");

      expect(data.initiator).toBe("system");
      expect(data.input[0]?.visibility).toBe("agent-only");

      const userRequests = turnRequests(harness, thread.id).filter(
        (event) => turnRequestData(event).initiator === "user",
      );

      expect(userRequests).toHaveLength(1);

      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  });

  it("continues an accepted turn instead of re-asking it", async () => {
    await withTestHarness(async (harness) => {
      const { environment, requestId, thread } = seedFailableThread(
        harness,
        "host-continue",
      );

      seedInputAccepted(harness, {
        environmentId: environment.id,
        threadId: thread.id,
        requestId,
      });
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: requestId,
          sendAt: null,
          reason: "Rate limited",
        },
      });

      expect(result.delivery).toBe("sent");

      const requests = turnRequests(harness, thread.id);
      expect(requests).toHaveLength(2);
      const retryRequest = requests[1];

      if (retryRequest === undefined) throw new Error("expected a retry turn");
      const data = turnRequestData(retryRequest);

      expect(data.retryOfRequestId).toBe(requestId);
      expect(data.retryAttempt).toBe(2);
      expect(data.input).toHaveLength(1);
      expect(data.input[0]?.text).toBe("Please continue.");
      expect(data.input[0]?.visibility).toBe("agent-only");
    });
  });

  it("dispatches immediately when no instant is named", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailableThread(harness, "host-retry-now");
      failThread(harness, thread.id);

      const result = await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: null, sendAt: null, reason: "Retry" },
      });

      expect(result.delivery).toBe("sent");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(turnRequests(harness, thread.id)).toHaveLength(2);
    });
  });

  it("replays the failed attempt's execution instead of re-resolving today's", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-exec");
      failThread(harness, thread.id);

      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "gpt-6-pro",
        reasoningLevelOverride: "max",
      });

      await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: requestId, sendAt: null, reason: "Retry" },
      });

      const requests = turnRequests(harness, thread.id);
      const retryRequest = requests[1];

      if (retryRequest === undefined) throw new Error("expected a retry turn");
      expect(turnRequestData(retryRequest).execution.model).toBe("gpt-5");
      expect(requireThread(harness, thread.id).modelOverride).toBe("gpt-6-pro");
      expect(requireThread(harness, thread.id).reasoningLevelOverride).toBe(
        "max",
      );
    });
  });

  it("refuses the second of two concurrent retries of one failure", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-race");
      failThread(harness, thread.id);

      const retry = () =>
        retryFailedTurn(harness.deps, {
          actor: OWNER_ACTOR,
          thread: requireThread(harness, thread.id),
          request: {
            turnRequestId: requestId,
            sendAt: Date.now() + 60_000,
            reason: "Rate limited",
          },
        });

      const outcomes = await Promise.allSettled([retry(), retry()]);

      expect(
        outcomes.filter((outcome) => outcome.status === "fulfilled"),
      ).toHaveLength(1);

      const rejected = outcomes.find(
        (outcome) => outcome.status === "rejected",
      );

      expect(
        (rejected as PromiseRejectedResult | undefined)?.reason,
      ).toMatchObject({ body: { code: "retry_already_queued" } });
      expect(queuedRows(harness, thread.id)).toHaveLength(1);
    });
  });

  it("counts a retry's own failure as a later attempt of the same original", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(
        harness,
        "host-attempts",
      );

      failThread(harness, thread.id);
      await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: requestId,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });
      await sweepPastResume(harness);

      failThread(harness, thread.id);
      const failedAgain = buildTurnFailedEvent(harness.db, thread.id);

      expect(failedAgain?.attemptNumber).toBe(2);
      expect(failedAgain?.requestId).not.toBe(requestId);

      await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: failedAgain?.requestId ?? null,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });
      expect(onlyQueuedRow(harness, thread.id).payload).toEqual({
        kind: "retry",
        retryOfTurnRequestId: requestId,
        attempt: 3,
        reason: "Rate limited",
      });
    });
  });

  it.each(["clears", "unregisters", "clears a failed dispatch"] as const)(
    "keeps a scheduled retry behind its requested time when a plugin %s",
    async (release) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);

      await withTestHarness(async (harness) => {
        let held = true;
        let dispatchCalls = 0;
        installHooks({
          "message.dispatch": [
            {
              pluginId: "concurrency-limit",
              handler: () => {
                dispatchCalls += 1;

                return held
                  ? { action: "wait", reason: "At capacity" }
                  : { action: "proceed" };
              },
            },
          ],
        });
        const { thread } = seedFailableThread(harness, "host-scheduled-limit");
        failThread(harness, thread.id);
        const sendAt = now + 60_000;

        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/retry`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              turnRequestId: null,
              sendAt,
              reason: "Resume after reset",
            }),
          },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          delivery: "queued",
          sendAt,
        });
        expect(onlyQueuedRow(harness, thread.id)).toMatchObject({
          sendAt,
          waitingOn: { kind: "plugin", pluginId: "concurrency-limit" },
          payload: { kind: "retry" },
        });

        const failedDispatch = release === "clears a failed dispatch";
        const queuedId = onlyQueuedRow(harness, thread.id).id;

        if (failedDispatch)
          setQueuedThreadMessageFailureReason(harness.db, harness.deps.hub, {
            id: queuedId,
            threadId: thread.id,
            failureReason: "Dispatch needs explicit recovery",
            now,
            retryDelaysMs: [],
          });

        held = false;

        if (failedDispatch)
          clearQueuedMessageWait(harness.deps, {
            queuedMessageId: queuedId,
            threadId: thread.id,
          });
        else
          await runQueuedMessageDispatch(
            harness.deps,
            release === "clears"
              ? { kind: "plugin-recheck" }
              : { kind: "plugin-unregistered", pluginId: "concurrency-limit" },
          );
        expect(turnRequests(harness, thread.id)).toHaveLength(1);
        expect(dispatchCalls).toBe(1);
        expect(onlyQueuedRow(harness, thread.id).sendAt).toBe(sendAt);

        if (failedDispatch)
          expect(
            listQueuedThreadMessages(harness.db, thread.id)[0],
          ).toMatchObject({
            failureReason: "Dispatch needs explicit recovery",
            failureCount: 1,
            nextAttemptAt: null,
          });

        now = sendAt;
        await runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now,
        });

        if (failedDispatch) {
          expect(turnRequests(harness, thread.id)).toHaveLength(1);
          expect(dispatchCalls).toBe(1);

          const recovery = await harness.app.request(
            `/api/v1/threads/${thread.id}/queued-messages/${queuedId}/send`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ mode: "auto" }),
            },
          );

          expect(recovery.status).toBe(200);
        }

        expect(turnRequests(harness, thread.id)).toHaveLength(2);
        expect(dispatchCalls).toBe(failedDispatch ? 1 : 2);
        expect(queuedRows(harness, thread.id)).toHaveLength(0);

        await runQueuedMessageDispatch(harness.deps, {
          kind: "time-reached",
          now,
        });
        expect(turnRequests(harness, thread.id)).toHaveLength(2);
      });
    },
  );

  it("still passes the dispatch hook when the retry comes back", async () => {
    await withTestHarness(async (harness) => {
      let dispatchCalls = 0;
      installHooks({
        "message.dispatch": [
          {
            pluginId: "concurrency-limit",
            handler: (context) => {
              dispatchCalls += 1;

              if (context.queuedMessages.length === 0) {
                return { action: "proceed" };
              }

              expect(context.queuedMessages[0]?.payload.kind).toBe("retry");

              return { action: "wait", reason: "At capacity" };
            },
          },
        ],
      });
      const { thread } = seedFailableThread(harness, "host-limit");
      failThread(harness, thread.id);
      await retryFailedTurn(harness.deps, {
        actor: OWNER_ACTOR,
        thread: requireThread(harness, thread.id),
        request: {
          turnRequestId: null,
          sendAt: Date.now() + 60_000,
          reason: "Rate limited",
        },
      });

      await sweepPastResume(harness);

      expect(dispatchCalls).toBe(2);

      expect(turnRequests(harness, thread.id)).toHaveLength(1);
      const requeued = onlyQueuedRow(harness, thread.id);
      expect(requeued.waitingOn).toEqual({
        kind: "plugin",
        pluginId: "concurrency-limit",
        reason: "At capacity",
      });
      expect(requeued.sendAt).toBeNull();
      expect(requeued.payload.kind).toBe("retry");
    });
  });

  it("refuses a thread that has not failed, a turn that is not the failed one, and a second live retry", async () => {
    await withTestHarness(async (harness) => {
      const { requestId, thread } = seedFailableThread(harness, "host-refuse");

      const retry = (turnRequestId: string | null) =>
        retryFailedTurn(harness.deps, {
          actor: OWNER_ACTOR,
          thread: requireThread(harness, thread.id),
          request: {
            turnRequestId,
            sendAt: Date.now() + 60_000,
            reason: "Retry",
          },
        });

      await expect(retry(null)).rejects.toMatchObject({
        body: { code: "no_failed_turn" },
      });

      failThread(harness, thread.id);

      await expect(retry("creq_2222222222")).rejects.toMatchObject({
        body: { code: "no_failed_turn" },
      });

      await retry(requestId);

      await expect(retry(requestId)).rejects.toMatchObject({
        body: { code: "retry_already_queued" },
      });
      expect(queuedRows(harness, thread.id)).toHaveLength(1);

      const claimed = claimQueuedThreadMessageGroup(
        harness.db,
        harness.deps.hub,
        onlyQueuedRow(harness, thread.id).id,
        { kind: "explicit-send" },
      );

      expect(claimed).toHaveLength(1);
      await expect(retry(requestId)).rejects.toMatchObject({
        body: { code: "retry_already_queued" },
      });
    });
  });

  it("re-sends a never-started turn once however many times it is retried", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailableThread(harness, "host-repeat");

      for (let attempt = 2; attempt <= 6; attempt += 1) {
        failThread(harness, thread.id);
        await retryFailedTurn(harness.deps, {
          actor: { kind: "owner" },
          thread: requireThread(harness, thread.id),
          request: { turnRequestId: null, sendAt: null, reason: "Retry" },
        });
        expect(lastTurnRequest(harness, thread.id)).toMatchObject({
          retryAttempt: attempt,
          input: [{ text: "Do the thing", visibility: "agent-only" }],
        });
      }
    });
  });

  it("counts and re-sends a retry once when it has to reprovision the workspace", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps, {
        id: "host-reprovision",
      });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: WORKSPACE_PATH,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: WORKSPACE_PATH,
        environmentProviderId: "personal-workspace",
        environmentProviderPluginId: "bb-plugin-environment-personal-workspace",
        isGitRepo: false,
      });

      const thread = seedThread(harness.deps, {
        environmentId: environment.id,
        projectId: project.id,
        status: "active",
      });

      seedThreadRuntimeState(harness.deps, {
        environmentId: environment.id,
        inputText: "Do the thing",
        providerThreadId: "provider-reprovision",
        threadId: thread.id,
      });
      failThread(harness, thread.id);
      await retryFailedTurn(harness.deps, {
        actor: { kind: "owner" },
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: null, sendAt: null, reason: "Retry" },
      });
      harness.db
        .update(environments)
        .set({ status: "error" })
        .where(eq(environments.id, environment.id))
        .run();
      failThread(harness, thread.id);

      await retryFailedTurn(harness.deps, {
        actor: { kind: "owner" },
        thread: requireThread(harness, thread.id),
        request: { turnRequestId: null, sendAt: null, reason: "Retry" },
      });

      const resent = [{ text: "Do the thing", visibility: "agent-only" }];
      expect(requireThread(harness, thread.id).status).toBe("starting");
      expect(lastTurnRequest(harness, thread.id)).toMatchObject({
        retryAttempt: 3,
        input: resent,
      });
      expect(
        readThreadProvisionContext(harness.db, thread.id)?.request.input,
      ).toMatchObject(resent);
    });
  });
});

describe("host interruption retry integration", () => {
  it.each([
    { accepted: false, cause: undefined },
    { accepted: true, cause: undefined },
    { accepted: false, cause: "host-connection-lost" },
    { accepted: true, cause: "host-connection-lost" },
  ] as const)(
    "queues a durable retry for $cause with accepted=$accepted",
    async ({ accepted, cause }) => {
      await withTestHarness(async (harness) => {
        const { environment, host, requestId, thread } = seedFailableThread(
          harness,
          "host-interrupted",
        );

        if (accepted)
          seedInputAccepted(harness, {
            environmentId: environment.id,
            threadId: thread.id,
            requestId,
          });
        interruptActiveThreadsForHost(harness.deps, {
          hostId: host.id,
          includeStopping: false,
          reason: "host-daemon-restarted",
          ...(cause ? { cause } : {}),
        });
        const failed = buildTurnFailedEvent(harness.db, thread.id);
        expect(failed?.errorInfo).toEqual({
          category: "connection-failed",
          providerCode: cause ?? "host-daemon-restarted",
          httpStatusCode: null,
        });
        expect(failed?.inputAccepted).toBe(accepted);

        if (!failed) throw new Error("Expected host interruption failure");

        const retryModule = await import(
          new URL(
            "../../../../plugins/provider-retry/server.ts",
            import.meta.url,
          ).href
        );

        const providerRetryPlugin: (api: PluginApi) => Promise<void> =
          retryModule.default;

        const retry = createFakePluginHost({
          pluginId: "provider-retry",
          sdk: {
            plugins: { experimental_discoverRpc: async () => [] },
            threads: {
              retry: async (request) =>
                retryFailedTurn(harness.deps, {
                  actor: OWNER_ACTOR,
                  thread: requireThread(harness, request.threadId),
                  request: {
                    turnRequestId: request.turnRequestId ?? null,
                    sendAt: request.sendAt ?? null,
                    reason: request.reason ?? "Retry",
                  },
                }),
            },
          },
        });

        try {
          await providerRetryPlugin(retry.api);
          const before = Date.now();
          expect(
            (
              await retry.harness.behavior.emitThreadEvent(
                "turn.failed",
                failed,
              )
            ).errors,
          ).toEqual([]);
          const queued = listQueuedThreadMessages(harness.db, thread.id);
          expect(queued).toHaveLength(1);
          expect(queued[0]?.sendAt).toBeGreaterThanOrEqual(before + 5_000);
          expect(queued[0]?.sendAt).toBeLessThanOrEqual(Date.now() + 10_000);
          expect(queued[0] && toThreadQueuedMessage(queued[0]).payload).toEqual(
            {
              kind: "retry",
              retryOfTurnRequestId: requestId,
              attempt: 2,
              reason: "Provider connection interrupted",
            },
          );
        } finally {
          await retry.harness.dispose();
        }
      });
    },
  );
});

describe("pooled provider retry integration", () => {
  it("queues a durable retry for a pool 429 without a provider quota event", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment, host, requestId } = seedFailableThread(
        harness,
        "host-pooled-retry",
      );

      const poolModule = await import(
        new URL(
          "../../../../plugins/account-pool/src/server.ts",
          import.meta.url,
        ).href
      );

      const createAccountPoolPlugin: (options: {
        now: () => number;
        env: NodeJS.ProcessEnv;
        fetch: typeof fetch;
      }) => (api: PluginApi) => Promise<void> =
        poolModule.createAccountPoolPlugin;

      const retryModule = await import(
        new URL("../../../../plugins/provider-retry/server.ts", import.meta.url)
          .href
      );

      const providerRetryPlugin: (api: PluginApi) => Promise<void> =
        retryModule.default;

      const retryAvailabilityMethod = "provider-retry.v1.availability";

      const retryAvailabilitySchema = z.object({
        kind: z.literal("blocked"),
        retryAt: z.number(),
      });

      const now = Date.now();
      const resetAt = now + 3_600_000;
      const dataDir = await mkdtemp(path.join(tmpdir(), "omnyo-pool-retry-"));

      const pool = createFakePluginHost({
        pluginId: "account-pool",
        dataDir,
        sdk: {
          hosts: { list: async () => [host] },
          system: { providerStates: async () => ({ providers: [] }) },
          threads: {
            events: {
              list: async () => [{ data: lastTurnRequest(harness, thread.id) }],
            },
          },
        },
      });

      const retry = createFakePluginHost({
        pluginId: "provider-retry",
        sdk: {
          plugins: {
            experimental_discoverRpc: async () => [
              {
                pluginId: "account-pool",
                displayName: "Account Pooler",
                method: retryAvailabilityMethod,
              },
            ],
            callRpc: async ({ method, input }) =>
              retryAvailabilitySchema.parse(
                await pool.harness.behavior.callRpc(method, input),
              ),
          },
          threads: {
            retry: async (request) =>
              retryFailedTurn(harness.deps, {
                actor: OWNER_ACTOR,
                thread: requireThread(harness, request.threadId),
                request: {
                  turnRequestId: request.turnRequestId ?? null,
                  sendAt: request.sendAt ?? null,
                  reason: request.reason ?? "Rate limited",
                },
              }),
          },
        },
      });

      try {
        await createAccountPoolPlugin({
          now: () => now,
          env: {},
          fetch: async () =>
            Response.json(
              {},
              {
                status: 429,
                headers: {
                  "anthropic-ratelimit-unified-5h-status": "rejected",
                  "anthropic-ratelimit-unified-5h-reset": String(
                    resetAt / 1000,
                  ),
                },
              },
            ),
        })(pool.api);
        await pool.harness.behavior.callRpc("account.add", {
          provider: "claude",
          apiKey: "test-account",
          label: null,
          priority: 1,
        });
        pool.harness.behavior.runService("hub");

        const entries = await pool.harness.behavior.resolveProviderEnv(
          "claude-code",
          { threadId: thread.id, projectId: thread.projectId, hostId: host.id },
        );

        const token = entries.find(
          (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
        )?.value;

        if (typeof token !== "string") throw new Error("Expected a pool token");

        const response = await pool.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ model: "claude-opus-4-1", messages: [] }),
          },
        );

        expect(response.status).toBe(429);
        await response.text();
        seedEvent(harness.deps, {
          threadId: thread.id,
          environmentId: environment.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
          type: "provider/error",
          scope: { kind: "thread" },
          data: {
            providerThreadId: "provider-session",
            message: "No Account Pooler account is currently eligible.",
            errorInfo: {
              category: "rate-limit",
              providerCode: null,
              httpStatusCode: 429,
            },
          },
        });
        failThread(harness, thread.id);
        const failed = buildTurnFailedEvent(harness.db, thread.id);

        if (failed === null) throw new Error("Expected a failed turn");
        expect(failed.rateLimits).toBeNull();
        await providerRetryPlugin(retry.api);
        expect(
          (await retry.harness.behavior.emitThreadEvent("turn.failed", failed))
            .errors,
        ).toEqual([]);
        const queued = listQueuedThreadMessages(harness.db, thread.id);
        expect(queued).toHaveLength(1);
        const row = queued[0]!;
        expect(row.sendAt).toBeGreaterThanOrEqual(resetAt + 15_000);
        expect(row.sendAt).toBeLessThan(resetAt + 45_000);
        expect(toThreadQueuedMessage(row).payload).toMatchObject({
          kind: "retry",
          retryOfTurnRequestId: requestId,
          attempt: 2,
        });
      } finally {
        await retry.harness.dispose();
        await pool.harness.dispose();
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  });
});

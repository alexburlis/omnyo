import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  createConnection,
  hostDaemonSessions,
  listEvents,
  readDaemonEventReceiptIndex,
  threads,
  type DaemonEventReceiptKey,
} from "@omnyo/db";
import { turnScope } from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonSessionOpenResponseSchema,
  type HostDaemonEventEnvelope,
} from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/errors.js";
import {
  EVENTS_THROUGH_WAIT_MS,
  waitForEventsThrough,
} from "../../src/services/hosts/event-receipt-watermarks.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { seedThreadFixture } from "../helpers/seed.js";
import {
  createTestAppHarness,
  createTestDb,
  type TestAppHarness,
} from "../helpers/test-app.js";

const TURN_ID = "turn-1";

const STATUS_TRIGGER = "effect_boundary_block_thread_status";

const SETTLE_PROBE_MS = 50;

interface BoundaryFixture {
  file: string;
  harness: TestAppHarness;
  key: DaemonEventReceiptKey;
  sessionId: string;
  threadId: string;
  reopenCold(): Promise<void>;
}

interface BatchOutcome {
  accepted: number | null;
  code: string | null;
  duplicateEvents: number | null;
  retryable: boolean | null;
  status: number;
}

function turnStarted(threadId: string): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "turn/started",
      threadId,
      providerThreadId: "provider-thread-1",
      scope: turnScope(TURN_ID),
    },
  };
}

function turnCompleted(threadId: string): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "turn/completed",
      threadId,
      providerThreadId: "provider-thread-1",
      scope: turnScope(TURN_ID),
      status: "completed",
    },
  };
}

function providerProcessExited(threadId: string): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "system/error",
      threadId,
      scope: turnScope(TURN_ID),
      code: "provider_process_exited",
      message: "Provider process exited",
    },
  };
}

async function openHarness(file: string): Promise<TestAppHarness> {
  const harness = await createTestAppHarness({ databaseSource: file });
  harness.db.$client.pragma("busy_timeout = 50");

  return harness;
}

async function closeHarness(harness: TestAppHarness): Promise<void> {
  await harness.cleanup();
  harness.db.$client.close();
}

async function withBoundaryFixture(
  run: (fixture: BoundaryFixture) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "omnyo-effect-boundary-"));
  const file = join(directory, "omnyo.db");
  const template = createTestDb();
  await writeFile(file, template.$client.serialize());
  template.$client.close();

  const first = await openHarness(file);

  const { host, session, thread } = seedThreadFixture(first, {
    session: { id: "host-effect-boundary" },
  });

  const fixture: BoundaryFixture = {
    file,
    harness: first,
    key: { hostId: host.id, instanceId: session.instanceId },
    sessionId: session.id,
    threadId: thread.id,
    async reopenCold(): Promise<void> {
      await closeHarness(fixture.harness);
      fixture.harness = await openHarness(file);

      const active = fixture.harness.db
        .select({ id: hostDaemonSessions.id })
        .from(hostDaemonSessions)
        .where(eq(hostDaemonSessions.status, "active"))
        .all();

      if (active.some((row) => row.id === fixture.sessionId)) {
        return;
      }

      const response = await fixture.harness.app.request(
        "/internal/session/open",
        {
          method: "POST",
          headers: internalAuthHeaders(fixture.harness, { hostId: host.id }),
          body: JSON.stringify({
            hostId: host.id,
            instanceId: session.instanceId,
            hostName: "Test Host",
            hasMachineCredential: false,
            platform: "darwin",
            dataDir: "/tmp/host-daemon-effect-boundary",
            localApiPort: null,
            protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
            activeThreads: [],
            undeliveredEventThreadIds: [],
          }),
        },
      );

      expect(response.status).toBe(201);
      fixture.sessionId = hostDaemonSessionOpenResponseSchema.parse(
        await response.json(),
      ).sessionId;
    },
  };

  try {
    await run(fixture);
  } finally {
    await closeHarness(fixture.harness);
    await rm(directory, { recursive: true, force: true });
  }
}

async function postBatch(
  fixture: BoundaryFixture,
  events: HostDaemonEventEnvelope[],
  firstEventIndex: number,
): Promise<BatchOutcome> {
  const response = await fixture.harness.app.request(
    "/internal/session/events",
    {
      method: "POST",
      headers: internalAuthHeaders(fixture.harness, {
        hostId: fixture.key.hostId,
      }),
      body: JSON.stringify({
        sessionId: fixture.sessionId,
        eventGroups: groupHostDaemonEvents(events),
        firstEventIndex,
      }),
    },
  );

  const body = (await readJson(response)) as {
    acceptedEvents?: unknown[];
    code?: string;
    duplicateEvents?: number;
    retryable?: boolean;
  };

  return {
    accepted: body.acceptedEvents?.length ?? null,
    code: body.code ?? null,
    duplicateEvents: body.duplicateEvents ?? null,
    retryable: body.retryable ?? null,
    status: response.status,
  };
}

async function postApproval(
  fixture: BoundaryFixture,
  eventsThrough: number,
): Promise<Response> {
  return await fixture.harness.app.request(
    "/internal/session/interactive-request",
    {
      method: "POST",
      headers: internalAuthHeaders(fixture.harness, {
        hostId: fixture.key.hostId,
      }),
      body: JSON.stringify({
        sessionId: fixture.sessionId,
        eventsThrough,
        interaction: {
          threadId: fixture.threadId,
          turnId: TURN_ID,
          providerId: "codex",
          providerThreadId: "provider-thread-1",
          providerRequestId: `request-effect-boundary-${eventsThrough}`,
          payload: createCommandApprovalPayload({
            itemId: "item-effect-boundary",
            reason: "Needs approval",
            command: "git push",
            cwd: "/tmp/project",
          }),
        },
      }),
    },
  );
}

async function postToolCall(
  fixture: BoundaryFixture,
  eventsThrough: number,
): Promise<Response> {
  return await fixture.harness.app.request("/internal/session/tool-call", {
    method: "POST",
    headers: internalAuthHeaders(fixture.harness, {
      hostId: fixture.key.hostId,
    }),
    body: JSON.stringify({
      sessionId: fixture.sessionId,
      threadId: fixture.threadId,
      providerThreadId: "provider-thread-1",
      turnId: TURN_ID,
      callId: `call-effect-boundary-${eventsThrough}`,
      tool: "spawn_thread",
      arguments: {},
      eventsThrough,
    }),
  });
}

async function settlesWithin(
  pending: Promise<Response>,
  milliseconds: number,
): Promise<boolean> {
  let settled = false;

  void pending.then(() => {
    settled = true;
  });

  await sleep(milliseconds);

  return settled;
}

function threadStatus(fixture: BoundaryFixture): string | undefined {
  return fixture.harness.db
    .select({ status: threads.status })
    .from(threads)
    .where(eq(threads.id, fixture.threadId))
    .get()?.status;
}

function storedCount(fixture: BoundaryFixture, type: string): number {
  return listEvents(fixture.harness.db, { threadId: fixture.threadId }).filter(
    (row) => row.type === type,
  ).length;
}

function receipt(fixture: BoundaryFixture): number {
  return readDaemonEventReceiptIndex(fixture.harness.db, fixture.key);
}

function markThrough(
  fixture: BoundaryFixture,
  eventsThrough: number,
): Promise<string> {
  return waitForEventsThrough(fixture.harness.db, {
    eventsThrough,
    key: fixture.key,
    timeoutMs: SETTLE_PROBE_MS,
  });
}

function blockThreadStatusWrites(fixture: BoundaryFixture): void {
  fixture.harness.db.$client.exec(
    `CREATE TRIGGER ${STATUS_TRIGGER} BEFORE UPDATE OF status ON threads BEGIN SELECT RAISE(ABORT, 'injected effect failure'); END`,
  );
}

function allowThreadStatusWrites(fixture: BoundaryFixture): void {
  fixture.harness.db.$client.exec(`DROP TRIGGER ${STATUS_TRIGGER}`);
}

async function storeStartedTurn(fixture: BoundaryFixture): Promise<void> {
  const started = await postBatch(fixture, [turnStarted(fixture.threadId)], 1);

  expect(started.status).toBe(200);
  expect(threadStatus(fixture)).toBe("active");
}

async function failCompletedBatch(
  fixture: BoundaryFixture,
): Promise<BatchOutcome> {
  await storeStartedTurn(fixture);
  blockThreadStatusWrites(fixture);

  return await postBatch(fixture, [turnCompleted(fixture.threadId)], 2);
}

describe("daemon event effect boundary", () => {
  it("rolls back a batch whose effect write fails", () =>
    withBoundaryFixture(async (fixture) => {
      await storeStartedTurn(fixture);
      blockThreadStatusWrites(fixture);
      let notifications = 0;

      fixture.harness.hub.onThreadChanged(() => {
        notifications += 1;
      });

      const failed = await postBatch(
        fixture,
        [turnCompleted(fixture.threadId)],
        2,
      );

      expect({
        code: failed.code,
        mark: await markThrough(fixture, 2),
        notifications,
        receipt: receipt(fixture),
        retryable: failed.retryable,
        status: failed.status,
        storedCompleted: storedCount(fixture, "turn/completed"),
        threadStatus: threadStatus(fixture),
      }).toEqual({
        code: "event_batch_not_applied",
        mark: "timed_out",
        notifications: 0,
        receipt: 1,
        retryable: true,
        status: 503,
        storedCompleted: 0,
        threadStatus: "active",
      });
    }));

  it("refuses and rolls back a batch whose effect raises an API error", () =>
    withBoundaryFixture(async (fixture) => {
      await storeStartedTurn(fixture);

      const effectError = new ApiError(
        409,
        "invalid_request",
        "Pending interaction pi-effect-boundary is already resolved",
      );

      const interrupt = vi
        .spyOn(
          fixture.harness.deps.pendingInteractions,
          "interruptPendingInteractionsForThreadIds",
        )
        .mockImplementation(() => {
          throw effectError;
        });

      const errorLog = vi.spyOn(fixture.harness.deps.logger, "error");
      let failed: BatchOutcome;
      let errorLogs: { fields: unknown; message: unknown }[];
      let interruptCalls: number;

      try {
        failed = await postBatch(
          fixture,
          [providerProcessExited(fixture.threadId)],
          2,
        );
      } finally {
        errorLogs = errorLog.mock.calls
          .map(([fields, message]) => ({ fields, message }))
          .filter(
            (entry) => entry.message === "Daemon event batch was not applied",
          );
        interruptCalls = interrupt.mock.calls.length;
        interrupt.mockRestore();
        errorLog.mockRestore();
      }

      const refusedState = {
        mark: await markThrough(fixture, 2),
        receipt: receipt(fixture),
        storedErrors: storedCount(fixture, "system/error"),
        threadStatus: threadStatus(fixture),
      };

      const retry = await postBatch(
        fixture,
        [providerProcessExited(fixture.threadId)],
        2,
      );

      expect({
        code: failed.code,
        errorLogs,
        interruptCalls,
        refusedState,
        retry: {
          accepted: retry.accepted,
          receipt: receipt(fixture),
          status: retry.status,
          storedErrors: storedCount(fixture, "system/error"),
          threadStatus: threadStatus(fixture),
        },
        retryable: failed.retryable,
        status: failed.status,
      }).toEqual({
        code: "event_batch_not_applied",
        errorLogs: [
          {
            fields: {
              err: effectError,
              eventType: "system/error",
              sessionId: fixture.sessionId,
              threadId: fixture.threadId,
            },
            message: "Daemon event batch was not applied",
          },
        ],
        interruptCalls: 1,
        refusedState: {
          mark: "timed_out",
          receipt: 1,
          storedErrors: 0,
          threadStatus: "active",
        },
        retry: {
          accepted: 1,
          receipt: 2,
          status: 200,
          storedErrors: 1,
          threadStatus: "error",
        },
        retryable: true,
        status: 503,
      });
    }));

  it("applies a failed batch once on retry", () =>
    withBoundaryFixture(async (fixture) => {
      await failCompletedBatch(fixture);
      allowThreadStatusWrites(fixture);

      const first = await postBatch(
        fixture,
        [turnCompleted(fixture.threadId)],
        2,
      );

      const statusAfterFirst = threadStatus(fixture);

      const second = await postBatch(
        fixture,
        [turnCompleted(fixture.threadId)],
        2,
      );

      expect({
        first: {
          accepted: first.accepted,
          duplicateEvents: first.duplicateEvents,
          status: first.status,
        },
        receipt: receipt(fixture),
        second: {
          accepted: second.accepted,
          duplicateEvents: second.duplicateEvents,
          status: second.status,
        },
        statusAfterFirst,
        statusAfterSecond: threadStatus(fixture),
        storedCompleted: storedCount(fixture, "turn/completed"),
      }).toEqual({
        first: { accepted: 1, duplicateEvents: 0, status: 200 },
        receipt: 2,
        second: { accepted: 0, duplicateEvents: 1, status: 200 },
        statusAfterFirst: "idle",
        statusAfterSecond: "idle",
        storedCompleted: 1,
      });
    }));

  it("seeds a cold mark from applied state", () =>
    withBoundaryFixture(async (fixture) => {
      await failCompletedBatch(fixture);
      await fixture.reopenCold();

      const coldMarkAfterFailure = await markThrough(fixture, 2);
      const coldStatusAfterFailure = threadStatus(fixture);

      allowThreadStatusWrites(fixture);

      const retry = await postBatch(
        fixture,
        [turnCompleted(fixture.threadId)],
        2,
      );

      await fixture.reopenCold();

      expect({
        coldMarkAfterFailure,
        coldMarkAfterRetry: await markThrough(fixture, 2),
        coldStatusAfterFailure,
        coldStatusAfterRetry: threadStatus(fixture),
        retryAccepted: retry.accepted,
      }).toEqual({
        coldMarkAfterFailure: "timed_out",
        coldMarkAfterRetry: "reached",
        coldStatusAfterFailure: "active",
        coldStatusAfterRetry: "idle",
        retryAccepted: 1,
      });
    }));

  it("holds dependent requests behind a failed batch", () =>
    withBoundaryFixture(async (fixture) => {
      await failCompletedBatch(fixture);

      const toolCall = postToolCall(fixture, 2);
      const approval = postApproval(fixture, 2);

      const [toolCallSettledEarly, approvalSettledEarly] = await Promise.all([
        settlesWithin(toolCall, SETTLE_PROBE_MS),
        settlesWithin(approval, SETTLE_PROBE_MS),
      ]);

      allowThreadStatusWrites(fixture);
      await postBatch(fixture, [turnCompleted(fixture.threadId)], 2);

      const [toolCallResponse, approvalResponse] = await Promise.all([
        toolCall,
        approval,
      ]);

      expect({
        approvalSettledEarly,
        approvalStatus: approvalResponse.status,
        threadStatus: threadStatus(fixture),
        toolCallSettledEarly,
        toolCallStatus: toolCallResponse.status,
      }).toEqual({
        approvalSettledEarly: false,
        approvalStatus: 200,
        threadStatus: "idle",
        toolCallSettledEarly: false,
        toolCallStatus: 200,
      });
    }));

  it("keeps the deadline guard when the failed batch held the turn start", () =>
    withBoundaryFixture(async (fixture) => {
      blockThreadStatusWrites(fixture);

      const failed = await postBatch(
        fixture,
        [turnStarted(fixture.threadId)],
        1,
      );

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      try {
        const approval = postApproval(fixture, 1);
        const toolCall = postToolCall(fixture, 1);

        await vi.advanceTimersByTimeAsync(EVENTS_THROUGH_WAIT_MS);

        const [approvalResponse, toolCallResponse] = await Promise.all([
          approval,
          toolCall,
        ]);

        expect({
          approvalCode: (
            (await readJson(approvalResponse)) as { code?: string }
          ).code,
          approvalStatus: approvalResponse.status,
          batchStatus: failed.status,
          storedStarted: storedCount(fixture, "turn/started"),
          toolCallStatus: toolCallResponse.status,
        }).toEqual({
          approvalCode: "turn_start_not_ready",
          approvalStatus: 503,
          batchStatus: 503,
          storedStarted: 0,
          toolCallStatus: 200,
        });
      } finally {
        vi.useRealTimers();
      }
    }));

  it("takes the write lock between append commit and effect write", () =>
    withBoundaryFixture(async (fixture) => {
      await storeStartedTurn(fixture);

      const peer = createConnection(fixture.file);
      peer.$client.pragma("busy_timeout = 0");
      let lockTaken: boolean | null = null;

      const stopListening = fixture.harness.hub.onThreadChanged(() => {
        if (lockTaken !== null) {
          return;
        }

        try {
          peer.$client.exec("BEGIN IMMEDIATE");
          lockTaken = true;
        } catch {
          lockTaken = false;
        }
      });

      let completed: BatchOutcome;

      try {
        completed = await postBatch(
          fixture,
          [turnCompleted(fixture.threadId)],
          2,
        );
      } finally {
        if (lockTaken === true) {
          peer.$client.exec("ROLLBACK");
        }

        peer.$client.close();
        stopListening();
      }

      const warmMark = await markThrough(fixture, 2);

      const warmToolCall = await settlesWithin(
        postToolCall(fixture, 2),
        SETTLE_PROBE_MS,
      );

      const warmStatus = threadStatus(fixture);

      await fixture.reopenCold();

      expect({
        coldMark: await markThrough(fixture, 2),
        coldStatus: threadStatus(fixture),
        lockTaken,
        status: completed.status,
        warmMark,
        warmStatus,
        warmToolCall,
      }).toEqual({
        coldMark: "reached",
        coldStatus: "idle",
        lockTaken: true,
        status: 200,
        warmMark: "reached",
        warmStatus: "idle",
        warmToolCall: true,
      });
    }));

  it("refuses a batch when the write lock is held at admission", () =>
    withBoundaryFixture(async (fixture) => {
      await storeStartedTurn(fixture);

      const peer = createConnection(fixture.file);
      peer.$client.exec("BEGIN IMMEDIATE");
      const startedAt = performance.now();
      let refused: BatchOutcome;

      try {
        refused = await postBatch(
          fixture,
          [turnCompleted(fixture.threadId)],
          2,
        );
      } finally {
        peer.$client.exec("ROLLBACK");
        peer.$client.close();
      }

      const refusedWithinOneSecond = performance.now() - startedAt < 1_000;
      const storedWhileRefused = storedCount(fixture, "turn/completed");
      const receiptWhileRefused = receipt(fixture);

      const retry = await postBatch(
        fixture,
        [turnCompleted(fixture.threadId)],
        2,
      );

      expect({
        code: refused.code,
        receiptWhileRefused,
        refusedWithinOneSecond,
        retry: { accepted: retry.accepted, status: retry.status },
        retryable: refused.retryable,
        status: refused.status,
        storedWhileRefused,
        threadStatus: threadStatus(fixture),
      }).toEqual({
        code: "coordinator_busy",
        receiptWhileRefused: 1,
        refusedWithinOneSecond: true,
        retry: { accepted: 1, status: 200 },
        retryable: true,
        status: 503,
        storedWhileRefused: 0,
        threadStatus: "idle",
      });
    }));
});

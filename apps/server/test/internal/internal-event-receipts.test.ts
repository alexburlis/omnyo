import { setTimeout as sleep } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  events as storedEvents,
  listEvents,
  readDaemonEventReceiptIndex,
} from "@omnyo/db";
import { threadScope, turnScope } from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  HOST_DAEMON_PROTOCOL_VERSION,
  hostDaemonSessionOpenResponseSchema,
  type HostDaemonEventEnvelope,
  type HostDaemonInteractiveRequest,
} from "@omnyo/host-daemon-contract";
import { describe, expect, it, vi } from "vitest";
import { EVENTS_THROUGH_WAIT_MS } from "../../src/services/hosts/event-receipt-watermarks.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

function systemError(
  threadId: string,
  message: string,
): HostDaemonEventEnvelope {
  return {
    threadId,
    event: { type: "system/error", threadId, scope: threadScope(), message },
  };
}

function turnStarted(
  threadId: string,
  turnId: string,
): HostDaemonEventEnvelope {
  return {
    threadId,
    event: {
      type: "turn/started",
      threadId,
      providerThreadId: "provider-thread-1",
      scope: turnScope(turnId),
    },
  };
}

async function postEvents(
  harness: TestAppHarness,
  args: {
    events: HostDaemonEventEnvelope[];
    hostId?: string;
    firstEventIndex?: number;
    sourceInstanceId?: string;
    sessionId: string;
  },
): Promise<Response> {
  return await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(
      harness,
      args.hostId === undefined ? {} : { hostId: args.hostId },
    ),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
      ...(args.firstEventIndex === undefined
        ? {}
        : { firstEventIndex: args.firstEventIndex }),
      ...(args.sourceInstanceId === undefined
        ? {}
        : { sourceInstanceId: args.sourceInstanceId }),
    }),
  });
}

async function reopenSession(
  harness: TestAppHarness,
  args: {
    hostId: string;
    instanceId: string;
    undeliveredEventThreadIds: string[];
  },
): Promise<string> {
  const response = await harness.app.request("/internal/session/open", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: args.hostId }),
    body: JSON.stringify({
      hostId: args.hostId,
      instanceId: args.instanceId,
      hostName: "Test Host",
      hasMachineCredential: false,
      platform: "darwin",
      dataDir: "/tmp/host-daemon-checkpoint",
      localApiPort: null,
      protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
      activeThreads: [],
      undeliveredEventThreadIds: args.undeliveredEventThreadIds,
    }),
  });

  expect(response.status).toBe(201);

  return hostDaemonSessionOpenResponseSchema.parse(await response.json())
    .sessionId;
}

function storedSystemErrors(
  harness: TestAppHarness,
  threadId: string,
): string[] {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.type === "system/error")
    .map((row) => (JSON.parse(row.data) as { message: string }).message);
}

function approvalRequest(args: {
  eventsThrough: number;
  sessionId: string;
  threadId: string;
}): HostDaemonInteractiveRequest {
  return {
    sessionId: args.sessionId,
    eventsThrough: args.eventsThrough,
    interaction: {
      threadId: args.threadId,
      turnId: "turn-1",
      providerId: "codex",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-receipts",
      payload: createCommandApprovalPayload({
        itemId: "item-receipts",
        reason: "Needs approval",
        command: "git push",
        cwd: "/tmp/project",
      }),
    },
  };
}

async function postApproval(
  harness: TestAppHarness,
  body: HostDaemonInteractiveRequest,
): Promise<Response> {
  return await harness.app.request("/internal/session/interactive-request", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify(body),
  });
}

describe("daemon event receipts", () => {
  it("stores an unindexed batch twice, as protocol 244 daemons send it", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-legacy" },
      });

      const events = [
        systemError(thread.id, "first"),
        systemError(thread.id, "second"),
      ];

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const response = await postEvents(harness, {
          events,
          sessionId: session.id,
        });

        expect(response.status).toBe(200);
        expect(await readJson(response)).not.toHaveProperty("duplicateEvents");
      }

      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "first",
        "second",
        "first",
        "second",
      ]);
    }));

  it("appends nothing for a re-sent indexed batch and reports the duplicates", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-resend" },
      });

      const events = [
        systemError(thread.id, "first"),
        systemError(thread.id, "second"),
      ];

      const original = await postEvents(harness, {
        events,
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(await readJson(original)).toMatchObject({ duplicateEvents: 0 });

      const resent = await postEvents(harness, {
        events,
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(resent.status).toBe(200);
      expect(await readJson(resent)).toEqual({
        acceptedEvents: [],
        rejectedEvents: [],
        duplicateEvents: 2,
      });
      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "first",
        "second",
      ]);
    }));

  it("appends only the new events of an overlapping indexed batch", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-overlap" },
      });

      await postEvents(harness, {
        events: [
          systemError(thread.id, "first"),
          systemError(thread.id, "second"),
        ],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      const grown = await postEvents(harness, {
        events: [
          systemError(thread.id, "first"),
          systemError(thread.id, "second"),
          systemError(thread.id, "third"),
        ],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(await readJson(grown)).toMatchObject({
        acceptedEvents: [{ eventIndex: 2 }],
        duplicateEvents: 2,
      });
      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "first",
        "second",
        "third",
      ]);
    }));

  it("applies a batch after a gap and dedupes against the new mark", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-gap" },
      });

      await postEvents(harness, {
        events: [systemError(thread.id, "first")],
        firstEventIndex: 1,
        sessionId: session.id,
      });
      await postEvents(harness, {
        events: [systemError(thread.id, "fifth")],
        firstEventIndex: 5,
        sessionId: session.id,
      });

      const late = await postEvents(harness, {
        events: [systemError(thread.id, "third")],
        firstEventIndex: 3,
        sessionId: session.id,
      });

      expect(await readJson(late)).toMatchObject({ duplicateEvents: 1 });
      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "first",
        "fifth",
      ]);
    }));

  it("replays a checkpoint against its original receipt after replacement and pruning", () =>
    withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-checkpoint" },
      });

      const events = [systemError(thread.id, "retained output")];

      const original = await postEvents(harness, {
        events,
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(original.status).toBe(200);

      const replacementId = await reopenSession(harness, {
        hostId: host.id,
        instanceId: "instance-checkpoint-replacement",
        undeliveredEventThreadIds: [thread.id],
      });

      const replay = await postEvents(harness, {
        events,
        firstEventIndex: 1,
        sourceInstanceId: session.instanceId,
        sessionId: replacementId,
      });

      expect(replay.status).toBe(200);
      expect(await readJson(replay)).toEqual({
        acceptedEvents: [],
        rejectedEvents: [],
        duplicateEvents: 1,
      });
      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "retained output",
      ]);

      harness.db
        .delete(storedEvents)
        .where(eq(storedEvents.threadId, thread.id))
        .run();

      const prunedReplay = await postEvents(harness, {
        events,
        firstEventIndex: 1,
        sourceInstanceId: session.instanceId,
        sessionId: replacementId,
      });

      expect(prunedReplay.status).toBe(200);
      expect(await readJson(prunedReplay)).toMatchObject({
        acceptedEvents: [],
        duplicateEvents: 1,
      });
      expect(storedSystemErrors(harness, thread.id)).toEqual([]);

      const fresh = await postEvents(harness, {
        events: [systemError(thread.id, "fresh output")],
        firstEventIndex: 1,
        sessionId: replacementId,
      });

      expect(fresh.status).toBe(200);
      expect(await readJson(fresh)).toMatchObject({ duplicateEvents: 0 });
      expect(storedSystemErrors(harness, thread.id)).toEqual(["fresh output"]);

      await reopenSession(harness, {
        hostId: host.id,
        instanceId: "instance-checkpoint-replacement",
        undeliveredEventThreadIds: [],
      });

      expect(
        readDaemonEventReceiptIndex(harness.db, {
          hostId: host.id,
          instanceId: session.instanceId,
        }),
      ).toBe(0);
      expect(
        readDaemonEventReceiptIndex(harness.db, {
          hostId: host.id,
          instanceId: "instance-checkpoint-replacement",
        }),
      ).toBe(1);
    }));

  it("rejects an indexed ownership failure before committing any receipt or output", () =>
    withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-rejected" },
      });

      const receiptKey = { hostId: host.id, instanceId: session.instanceId };
      const first = systemError(thread.id, "first valid output");
      const rejected = systemError("thr_not_owned", "unowned output");
      const last = systemError(thread.id, "last valid output");

      const batch = await postEvents(harness, {
        events: [first, rejected, last],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(batch.status).toBe(400);
      expect(await readJson(batch)).toMatchObject({ code: "invalid_request" });
      expect(readDaemonEventReceiptIndex(harness.db, receiptKey)).toBe(0);
      expect(storedSystemErrors(harness, thread.id)).toEqual([]);

      const firstHalf = await postEvents(harness, {
        events: [first],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(firstHalf.status).toBe(200);
      expect(readDaemonEventReceiptIndex(harness.db, receiptKey)).toBe(1);

      const rejectedSingleton = await postEvents(harness, {
        events: [rejected],
        firstEventIndex: 2,
        sessionId: session.id,
      });

      expect(rejectedSingleton.status).toBe(400);
      expect(readDaemonEventReceiptIndex(harness.db, receiptKey)).toBe(1);

      const lastHalf = await postEvents(harness, {
        events: [last],
        firstEventIndex: 3,
        sessionId: session.id,
      });

      expect(lastHalf.status).toBe(200);
      expect(readDaemonEventReceiptIndex(harness.db, receiptKey)).toBe(3);
      expect(storedSystemErrors(harness, thread.id)).toEqual([
        "first valid output",
        "last valid output",
      ]);
    }));

  it("keeps source-instance receipt lookup scoped to the authenticated host", () =>
    withTestHarness(async (harness) => {
      const original = seedThreadFixture(harness, {
        session: { id: "host-receipts-original" },
      });

      const other = seedThreadFixture(harness, {
        session: { id: "host-receipts-other" },
      });

      const first = await postEvents(harness, {
        events: [systemError(original.thread.id, "original host output")],
        hostId: original.host.id,
        firstEventIndex: 1,
        sessionId: original.session.id,
      });

      const second = await postEvents(harness, {
        events: [systemError(other.thread.id, "other host output")],
        hostId: other.host.id,
        firstEventIndex: 1,
        sourceInstanceId: original.session.instanceId,
        sessionId: other.session.id,
      });

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(await readJson(second)).toMatchObject({ duplicateEvents: 0 });
      expect(storedSystemErrors(harness, other.thread.id)).toEqual([
        "other host output",
      ]);
    }));

  it("holds an approval stamped past the applied events until they arrive", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-approval" },
      });

      let settled = false;

      const pending = postApproval(
        harness,
        approvalRequest({
          eventsThrough: 1,
          sessionId: session.id,
          threadId: thread.id,
        }),
      ).then((response) => {
        settled = true;

        return response;
      });

      await sleep(50);
      expect(settled).toBe(false);

      const events = await postEvents(harness, {
        events: [turnStarted(thread.id, "turn-1")],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      expect(events.status).toBe(200);

      const response = await pending;
      expect(response.status).toBe(200);
      expect(await readJson(response)).toMatchObject({ outcome: "created" });
    }));

  it("refuses a stamped tool call the daemon cancelled while its events were pending", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-tool-call" },
      });

      const seededTypes = listEvents(harness.db, { threadId: thread.id }).map(
        (row) => row.type,
      );

      const controller = new AbortController();

      const pending = harness.app.request("/internal/session/tool-call", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        signal: controller.signal,
        body: JSON.stringify({
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "provider-thread-1",
          turnId: "turn-1",
          callId: "call-receipts",
          tool: "message_user",
          arguments: { text: "Should not be sent" },
          eventsThrough: 1,
        }),
      });

      await sleep(50);
      controller.abort();

      await postEvents(harness, {
        events: [systemError(thread.id, "applied")],
        firstEventIndex: 1,
        sessionId: session.id,
      });

      const response = await pending;
      expect(response.status).toBe(409);
      expect(
        listEvents(harness.db, { threadId: thread.id }).map((row) => row.type),
      ).toEqual([...seededTypes, "system/error"]);
    }));

  it("handles an approval after the wait deadline and keeps the turn-start guard", () =>
    withTestHarness(async (harness) => {
      const { session, thread } = seedThreadFixture(harness, {
        session: { id: "host-receipts-deadline" },
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      try {
        const pending = postApproval(
          harness,
          approvalRequest({
            eventsThrough: 1,
            sessionId: session.id,
            threadId: thread.id,
          }),
        );

        await vi.advanceTimersByTimeAsync(EVENTS_THROUGH_WAIT_MS);
        const response = await pending;

        expect(response.status).toBe(503);
        expect(await readJson(response)).toMatchObject({
          code: "turn_start_not_ready",
          retryable: true,
        });
      } finally {
        vi.useRealTimers();
      }
    }));
});

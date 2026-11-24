import {
  events,
  getThread,
  getStoredTurnRequestEventForTurn,
  pendingInteractions,
  queuedThreadMessages,
  threadCallbacks,
  threadFailures,
  threadOwnerInputs,
  threadQuestions,
  threadReceipts,
  threads,
} from "@omnyo/db";
import {
  INBOX_CALLER_PLUGIN_HEADER,
  INBOX_CALLER_THREAD_HEADER,
  inboxFailureAcknowledgeResponseSchema,
  inboxFailureListResponseSchema,
  turnScope,
} from "@omnyo/domain";
import { and, eq } from "drizzle-orm";
import { parseStoredTurnRequestEvent } from "../../src/services/threads/thread-events.js";
import { acquireThreadContinuationAdmission } from "../../src/services/threads/thread-continuation-admission.js";
import {
  insertFailure,
  insertTurnMark,
} from "../../src/services/inbox/store.js";
import { startProducer } from "../../src/services/inbox/engine.js";
import { describe, expect, it } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  agentRequest,
  endTurn,
  entryOf,
  ownerSend,
  pendingSubmitCount,
  postDaemonEvents,
  ownerRequest,
  type InboxWorld,
  type RunningTurn,
  seedChat,
  seedInboxWorld,
  snapshot,
  startSubmittedTurn,
} from "./inbox-driver.js";

interface FailureFixture {
  world: InboxWorld;
  parentId: string;
  childId: string;
  failureId: string;
  requestId: string;
  turn: RunningTurn;
}

async function seedFailure(harness: TestAppHarness): Promise<FailureFixture> {
  const world = seedInboxWorld(harness, "host-failure-ack");
  const parent = seedChat(world);
  const child = seedChat(world, { parentThreadId: parent.id });
  await ownerSend(world, child.id, "Prepare the change");
  const turn = await startSubmittedTurn(world, child.id);
  await postDaemonEvents(world, [
    {
      threadId: child.id,
      event: {
        type: "item/completed",
        threadId: child.id,
        providerThreadId: world.providerThreadIds.get(child.id) ?? "",
        scope: turnScope(turn.turnId),
        item: {
          type: "agentMessage",
          id: "retained-output",
          text: "Preparation is preserved.",
        },
      },
    },
  ]);
  await endTurn(world, turn, "interrupted");
  await runInboxSweep(harness.deps, Date.now() + 31_000);

  const failure = harness.db
    .select()
    .from(threadFailures)
    .where(eq(threadFailures.threadId, child.id))
    .get();

  if (failure === undefined) throw new Error("Missing interruption");

  return {
    world,
    parentId: parent.id,
    childId: child.id,
    failureId: failure.id,
    requestId: turnRequestId(harness, child.id, turn.turnId),
    turn,
  };
}

function turnRequestId(
  harness: TestAppHarness,
  threadId: string,
  turnId: string,
) {
  const stored = getStoredTurnRequestEventForTurn(harness.db, {
    threadId,
    turnId,
  });

  if (stored === null) throw new Error("Missing stored request");

  return parseStoredTurnRequestEvent(stored).requestId;
}

function acknowledge(
  fixture: FailureFixture,
  caller = fixture.parentId,
  turnId = fixture.turn.turnId,
) {
  return agentRequest(
    fixture.world,
    caller,
    `/threads/${fixture.childId}/failures/${fixture.failureId}/acknowledge`,
    {
      turnId,
      reason: "Preparation was completed and verified by the parent.",
    },
  );
}

function rows(harness: TestAppHarness) {
  return {
    failures: harness.db.select().from(threadFailures).all(),
    receipts: harness.db.select().from(threadReceipts).all(),
    history: harness.db.select().from(events).all(),
    inputs: harness.db.select().from(threadOwnerInputs).all(),
  };
}

describe("Stop while a turn is starting", () => {
  it("records an owner Stop issued before turn/started as stopped, not failed", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-stop-while-starting");
      const chat = seedChat(world);
      await ownerSend(world, chat.id, "Ship it quickly");
      let stopResponse: Promise<Response> | null = null;

      const turn = await startSubmittedTurn(world, chat.id, {
        beforeTurnStarted: async () => {
          stopResponse = Promise.resolve(
            harness.app.request(`/api/v1/threads/${chat.id}/stop`, {
              method: "POST",
            }),
          );
          await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.stop" && command.threadId === chat.id,
          );
        },
      });

      await endTurn(world, turn, "interrupted");

      const stop = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" && command.threadId === chat.id,
      );

      await reportQueuedCommandSuccess(harness, stop, {
        providerCheckpointId: null,
      });
      expect((await stopResponse!).status).toBe(200);
      await runInboxSweep(harness.deps, Date.now() + 31_000);

      expect(
        harness.db
          .select()
          .from(threadFailures)
          .where(eq(threadFailures.threadId, chat.id))
          .all(),
      ).toEqual([]);
      expect(entryOf(await snapshot(world), chat.id)?.state).not.toBe("failed");
    });
  });
});

describe("exact failure acknowledgment on the real server", () => {
  it("acknowledges an idle child's obsolete interruption without replay or lost history", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      const { world, childId, turn, failureId } = fixture;

      expect(getThread(harness.db, childId)?.status).toBe("idle");

      const listed = await harness.app.request(
        `/api/v1/threads/${childId}/failures`,
      );

      expect(listed.status).toBe(200);
      expect(
        inboxFailureListResponseSchema.parse(await listed.json()).failures,
      ).toEqual([
        expect.objectContaining({
          id: failureId,
          state: "actionable",
          requestId: fixture.requestId,
        }),
      ]);
      const before = rows(harness);
      const response = await acknowledge(fixture);
      expect(response.status).toBe(200);
      expect(
        inboxFailureAcknowledgeResponseSchema.parse(await response.json()),
      ).toMatchObject({
        failure: {
          id: failureId,
          turnId: turn.turnId,
          requestId: fixture.requestId,
          state: "resolved",
          resolvedBy: "acknowledged",
        },
        acknowledged: true,
      });
      const after = rows(harness);
      expect(after.history).toEqual(before.history);
      expect(after.inputs).toEqual(before.inputs);
      expect(after.receipts).toHaveLength(before.receipts.length + 1);
      expect(after.receipts.at(-1)).toMatchObject({
        outcomeRef: failureId,
        summary: expect.stringContaining(
          "Preparation was completed and verified by the parent.",
        ),
        handledAt: expect.any(Number),
      });
      expect(after.failures[0]).toMatchObject({
        turnId: turn.turnId,
        state: "resolved",
        reason: "The turn was interrupted.",
      });
      expect(getThread(harness.db, childId)?.status).toBe("idle");
      expect(pendingSubmitCount(world, childId)).toBe(0);
      const repeated = await acknowledge(fixture);
      expect(repeated.status).toBe(200);
      expect(
        inboxFailureAcknowledgeResponseSchema.parse(await repeated.json())
          .acknowledged,
      ).toBe(false);
      expect(rows(harness)).toEqual(after);
    });
  });

  it("lists only failure identity and status metadata and permits the owner", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);

      const listed = await harness.app.request(
        `/api/v1/threads/${fixture.childId}/failures`,
      );

      expect(listed.status).toBe(200);
      const body: unknown = await listed.json();
      const parsed = inboxFailureListResponseSchema.parse(body);
      expect(body).toEqual(parsed);
      expect(parsed.failures).toEqual([
        {
          id: fixture.failureId,
          threadId: fixture.childId,
          turnId: fixture.turn.turnId,
          requestId: fixture.requestId,
          state: "actionable",
          reason: "The turn was interrupted.",
          resolvedBy: null,
        },
      ]);

      const response = await ownerRequest(
        fixture.world,
        `/threads/${fixture.childId}/failures/${fixture.failureId}/acknowledge`,
        { turnId: fixture.turn.turnId, reason: "Verified obsolete." },
      );

      expect(response.status).toBe(200);
    });
  });

  it("permits the existing root and immediate parent, including lifecycle-owned children", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);

      const middle = seedChat(fixture.world, {
        parentThreadId: fixture.parentId,
      });

      harness.db
        .update(threads)
        .set({ parentThreadId: null, lifecycleOwnerThreadId: middle.id })
        .where(eq(threads.id, fixture.childId))
        .run();
      expect((await acknowledge(fixture, fixture.parentId)).status).toBe(200);
      expect((await acknowledge(fixture, middle.id)).status).toBe(200);
    });
  });

  it("rejects self, unrelated chats and plugin callers without an owner fallback", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      const foreign = seedChat(fixture.world);
      const before = rows(harness);

      for (const caller of [fixture.childId, foreign.id, "thr_missing"]) {
        expect((await acknowledge(fixture, caller)).status).toBe(403);

        const listed = await harness.app.request(
          `/api/v1/threads/${fixture.childId}/failures`,
          { headers: { [INBOX_CALLER_THREAD_HEADER]: caller } },
        );

        expect(listed.status).toBe(403);
      }

      const plugin = await harness.app.request(
        `/api/v1/threads/${fixture.childId}/failures/${fixture.failureId}/acknowledge`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INBOX_CALLER_PLUGIN_HEADER]: "test-plugin",
          },
          body: JSON.stringify({
            turnId: fixture.turn.turnId,
            reason: "Plugin must not become owner.",
          }),
        },
      );

      expect(plugin.status).toBe(403);
      expect(rows(harness)).toEqual(before);
    });
  });

  it("rejects mismatched turns, missing turn binding and request mismatches", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      let before = rows(harness);
      expect(
        (await acknowledge(fixture, fixture.parentId, "turn-other")).status,
      ).toBe(409);
      expect(rows(harness)).toEqual(before);
      harness.db
        .update(threadFailures)
        .set({ requestId: "request-other" })
        .where(eq(threadFailures.id, fixture.failureId))
        .run();
      before = rows(harness);
      expect((await acknowledge(fixture)).status).toBe(409);
      expect(rows(harness)).toEqual(before);
      harness.db
        .update(threadFailures)
        .set({ requestId: null, turnId: "turn-missing" })
        .where(eq(threadFailures.id, fixture.failureId))
        .run();
      before = rows(harness);
      expect(
        (await acknowledge(fixture, fixture.parentId, "turn-missing")).status,
      ).toBe(409);
      expect(rows(harness)).toEqual(before);
    });
  });

  it("never binds a legacy null request to a newer unrelated stored request", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      harness.db
        .update(threadFailures)
        .set({ requestId: null })
        .where(eq(threadFailures.id, fixture.failureId))
        .run();

      const stored = getStoredTurnRequestEventForTurn(harness.db, {
        threadId: fixture.childId,
        turnId: fixture.turn.turnId,
      });

      if (stored === null) throw new Error("Missing stored request");

      const original = harness.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.sequence, stored.sequence),
            eq(events.threadId, fixture.childId),
          ),
        )
        .get();

      if (original === undefined) throw new Error("Missing stored event");
      harness.db
        .insert(events)
        .values({
          ...original,
          id: "new-request-event",
          sequence: 1000,
          data: original.data.replaceAll(
            parseStoredTurnRequestEvent(stored).requestId,
            "req_newer",
          ),
        })
        .run();
      const before = rows(harness);
      expect((await acknowledge(fixture)).status).toBe(409);
      expect(rows(harness)).toEqual(before);
    });
  });

  it("rejects a replacement failure even after an idempotent acknowledgment", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      expect((await acknowledge(fixture)).status).toBe(200);
      insertFailure(harness.db, {
        threadId: fixture.childId,
        turnId: fixture.turn.turnId,
        requestId: null,
        waitId: null,
        state: "actionable",
        reason: "A new failure",
        decisionDeadline: null,
        now: Date.now() + 60_000,
      });
      const before = rows(harness);
      expect((await acknowledge(fixture)).status).toBe(409);
      expect(rows(harness)).toEqual(before);
    });
  });

  it.each(["active", "starting", "stopping", "pending", "error"] as const)(
    "refuses %s targets without mutation",
    async (status) => {
      await withTestHarness(async (harness) => {
        const fixture = await seedFailure(harness);
        harness.db
          .update(threads)
          .set({ status })
          .where(eq(threads.id, fixture.childId))
          .run();
        const before = rows(harness);
        expect((await acknowledge(fixture)).status).toBe(409);
        expect(rows(harness)).toEqual(before);
      });
    },
  );

  it("refuses a live stored turn even if the chat status is stale idle", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      await postDaemonEvents(fixture.world, [
        {
          threadId: fixture.childId,
          event: {
            type: "turn/started",
            threadId: fixture.childId,
            providerThreadId:
              fixture.world.providerThreadIds.get(fixture.childId) ?? "",
            scope: turnScope("turn-new-active"),
          },
        },
      ]);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, fixture.childId))
        .run();
      const before = rows(harness);
      expect((await acknowledge(fixture)).status).toBe(409);
      expect(rows(harness)).toEqual(before);
    });
  });

  it.each(["deciding", "held", "resolved"] as const)(
    "refuses a failure in %s state",
    async (state) => {
      await withTestHarness(async (harness) => {
        const fixture = await seedFailure(harness);
        harness.db
          .update(threadFailures)
          .set({ state, resolvedBy: state === "resolved" ? "turn" : null })
          .where(eq(threadFailures.id, fixture.failureId))
          .run();
        const before = rows(harness);
        expect((await acknowledge(fixture)).status).toBe(409);
        expect(rows(harness)).toEqual(before);
      });
    },
  );

  it.each(["inline", "retry", "continuation"] as const)(
    "refuses queued %s work",
    async (payloadKind) => {
      await withTestHarness(async (harness) => {
        const fixture = await seedFailure(harness);
        harness.db
          .insert(queuedThreadMessages)
          .values({
            id: "queued-work",
            threadId: fixture.childId,
            content: "[]",
            model: "test",
            reasoningLevel: "medium",
            permissionMode: "auto",
            serviceTier: "default",
            payloadKind,
            sortKey: "a",
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
          .run();
        const before = rows(harness);
        expect((await acknowledge(fixture)).status).toBe(409);
        expect(rows(harness)).toEqual(before);
      });
    },
  );

  it.each([
    "question",
    "interaction",
    "callback",
    "wait",
    "producer",
    "mark",
    "continuation",
  ] as const)("refuses open %s work", async (kind) => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      const now = Date.now();
      let release: (() => void) | null = null;

      if (kind === "question")
        harness.db
          .insert(threadQuestions)
          .values({
            id: "question",
            threadId: fixture.childId,
            revision: 1,
            question: "{}",
            mode: "required",
            state: "open",
            createdAt: now,
            updatedAt: now,
          })
          .run();

      if (kind === "interaction")
        harness.db
          .insert(pendingInteractions)
          .values({
            id: "interaction",
            threadId: fixture.childId,
            status: "pending",
            payload: "{}",
            createdAt: now,
            updatedAt: now,
          })
          .run();

      if (kind === "callback")
        harness.db
          .insert(threadCallbacks)
          .values({
            id: "callback",
            threadId: fixture.childId,
            sourceThreadId: fixture.parentId,
            sourceTitle: "Parent",
            reason: "Pending reply",
            createdAt: now,
            afterSeq: 0,
            matchText: "",
          })
          .run();

      if (kind === "wait")
        expect(
          (
            await agentRequest(
              fixture.world,
              fixture.childId,
              `/threads/${fixture.childId}/waits`,
              {
                key: "pending-check",
                for: "External evidence",
                check: { what: "Evidence arrives", at: now + 60_000 },
              },
            )
          ).status,
        ).toBe(200);

      if (kind === "producer")
        startProducer(harness.db, {
          threadId: fixture.childId,
          kind: "goal",
          pluginId: "test-plugin",
          label: "Active job",
          now,
        });

      if (kind === "mark")
        insertTurnMark(harness.db, {
          threadId: fixture.childId,
          turnId: "turn-other",
          waitId: null,
          waitGeneration: null,
          evaluation: false,
          now,
        });

      if (kind === "continuation")
        release = acquireThreadContinuationAdmission(fixture.childId);
      const before = rows(harness);

      try {
        expect((await acknowledge(fixture)).status).toBe(409);
        expect(rows(harness)).toEqual(before);
      } finally {
        release?.();
      }
    });
  });

  it("validates the bounded reason and turn at the route boundary", async () => {
    await withTestHarness(async (harness) => {
      const fixture = await seedFailure(harness);
      const before = rows(harness);

      for (const body of [
        { turnId: fixture.turn.turnId, reason: " " },
        { turnId: fixture.turn.turnId, reason: "x".repeat(1001) },
        { turnId: "", reason: "Verified." },
      ]) {
        expect(
          (
            await ownerRequest(
              fixture.world,
              `/threads/${fixture.childId}/failures/${fixture.failureId}/acknowledge`,
              body,
            )
          ).status,
        ).toBe(400);
      }

      expect(rows(harness)).toEqual(before);
    });
  });
});

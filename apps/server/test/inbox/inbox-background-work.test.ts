import {
  inboxWaitRegisterResponseSchema,
  INBOX_STALL_GRACE_MS,
  LOCAL_WORKFLOW_TASK_TYPE,
  threadScope,
  turnScope,
} from "@omnyo/domain";
import { listQueuedThreadMessages, threadReceipts } from "@omnyo/db";
import { eq } from "drizzle-orm";
import {
  insertReceipt,
  insertWait,
  markConditionsStall,
  updateWait,
} from "../../src/services/inbox/store.js";
import type { HostDaemonEventEnvelope } from "@omnyo/host-daemon-contract";
import { describe, expect, it } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  agentRequest,
  endTurn,
  entryOf,
  ownerRequest,
  ownerSend,
  pendingSubmitCount,
  postDaemonEvents,
  seedChat,
  seedInboxWorld,
  snapshot,
  startSubmittedTurn,
  type InboxWorld,
} from "./inbox-driver.js";

function workflowEnvelope(
  world: InboxWorld,
  threadId: string,
  event:
    | { type: "item/started"; turnId: string }
    | { type: "item/backgroundTask/progress" },
): HostDaemonEventEnvelope {
  const providerThreadId = world.providerThreadIds.get(threadId) ?? "";

  const item = {
    type: "backgroundTask" as const,
    id: "task:inbox-workflow",
    taskType: LOCAL_WORKFLOW_TASK_TYPE,
    description: "Review in parallel",
    status: "pending" as const,
    taskStatus: "running" as const,
    skipTranscript: false,
  };

  return {
    threadId,
    event:
      event.type === "item/started"
        ? {
            type: event.type,
            threadId,
            providerThreadId,
            scope: turnScope(event.turnId),
            item,
          }
        : {
            type: event.type,
            threadId,
            providerThreadId,
            scope: threadScope(),
            item,
          },
  };
}

async function seedWorkflowDependency(
  world: InboxWorld,
  creator: "agent" | "owner" = "agent",
) {
  const source = seedChat(world);
  const waiter = seedChat(world);
  await ownerSend(world, source.id, "Run the review workflow");
  const sourceTurn = await startSubmittedTurn(world, source.id);
  await ownerSend(world, waiter.id, "Wait for the review");
  const waiterTurn = await startSubmittedTurn(world, waiter.id);

  const registration = {
    key: "review",
    for: "the review",
    chats: [source.id],
  };

  const response =
    creator === "agent"
      ? await agentRequest(
          world,
          waiter.id,
          `/threads/${waiter.id}/waits`,
          registration,
        )
      : await ownerRequest(world, `/threads/${waiter.id}/waits`, registration);

  expect(response.status).toBe(200);
  const { wait } = inboxWaitRegisterResponseSchema.parse(await response.json());
  await postDaemonEvents(world, [
    workflowEnvelope(world, source.id, {
      type: "item/started",
      turnId: sourceTurn.turnId,
    }),
  ]);
  await endTurn(world, waiterTurn, "completed");
  await endTurn(world, sourceTurn, "completed");

  return { source, waiter, wait };
}

describe("inbox background work on the real server", () => {
  it("never reminds a callback source while its background workflow is still running", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-active-callback-workflow");
      const { source } = await seedWorkflowDependency(world);
      const now = Date.now();
      await runInboxSweep(harness.deps, now + 1);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "time-reached",
        now: now + 1,
      });
      expect(pendingSubmitCount(world, source.id)).toBe(0);
      expect(listQueuedThreadMessages(harness.db, source.id)).toHaveLength(0);
      await runInboxSweep(harness.deps, now + INBOX_STALL_GRACE_MS + 2);
      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, source.id))
          .all()
          .map((receipt) => receipt.cause),
      ).not.toContain("stall");
      expect(entryOf(await snapshot(world), source.id)).toMatchObject({
        state: "working",
        view: "running",
        card: null,
      });
    });
  });

  it.each([
    { creator: "owner", state: "needs-you", kind: "decision" },
    { creator: "agent", state: "waiting", kind: "deliver" },
  ] as const)(
    "shows a stored $creator callback reminder only while the source owes the result, then settles it on delivery",
    async ({ creator, state, kind }) => {
      await withTestHarness(async (harness) => {
        const hostId = `host-retained-callback-reminder-${creator}`;
        const world = seedInboxWorld(harness, hostId);

        const { source, waiter, wait } = await seedWorkflowDependency(
          world,
          creator,
        );

        const now = Date.now();

        const receipt = insertReceipt(harness.db, {
          rootThreadId: source.id,
          threadId: source.id,
          cause: "stall",
          summary: "Deliver the review",
          outcomeRef: source.id,
          waitId: null,
          coveredInputIds: [],
          now,
        });

        markConditionsStall(harness.db, {
          sourceThreadId: source.id,
          waitIds: [wait.id],
          patch: { stallWokenAt: now, stallReceiptId: receipt.id },
        });

        expect(entryOf(await snapshot(world), source.id)).toMatchObject({
          state: "working",
          view: "running",
          card: null,
        });

        settleDanglingBackgroundTasks(harness.deps, { hostId });
        expect(entryOf(await snapshot(world), source.id)).toMatchObject({
          state,
          reason: { kind },
        });

        const result = await agentRequest(
          world,
          source.id,
          `/threads/${waiter.id}/send`,
          {
            input: [
              {
                type: "text",
                text: `${wait.marker} Review completed`,
                mentions: [],
              },
            ],
            mode: "auto",
            senderThreadId: source.id,
          },
        );

        expect(result.status).toBe(200);

        const finished = entryOf(await snapshot(world), source.id);
        expect(finished).toMatchObject({ state: "finished", view: "inbox" });
        expect(
          finished?.card?.causes.map((cause) => cause.receiptId),
        ).not.toContain(receipt.id);
        expect(
          harness.db
            .select()
            .from(threadReceipts)
            .where(eq(threadReceipts.id, receipt.id))
            .get()?.handledAt,
        ).toEqual(expect.any(Number));
      });
    },
  );

  it.each([false, true])(
    "retains expired event receipts while projecting ongoing work (ownerAccepted=%s)",
    async (ownerAccepted) => {
      await withTestHarness(async (harness) => {
        const world = seedInboxWorld(harness, "host-expired-background-wait");
        const chat = seedChat(world);
        await ownerSend(world, chat.id, "Keep the workflow moving");
        const turn = await startSubmittedTurn(world, chat.id);
        await postDaemonEvents(world, [
          workflowEnvelope(world, chat.id, {
            type: "item/started",
            turnId: turn.turnId,
          }),
        ]);
        await endTurn(world, turn, "completed");

        const now = Date.now();

        const expired = insertWait(harness.db, {
          threadId: chat.id,
          key: "expired-external-event",
          generation: 1,
          kind: "event",
          status: "closed",
          readiness: "all",
          createdBy: "agent",
          automationId: null,
          ownerAccepted,
          forText: "the native lane releases",
          resumeText: null,
          marker: "expired-marker",
          deadline: now - 1,
          chainStartAt: now - 100,
          nextCheckAt: null,
          checkIntervalMs: null,
          reminderAt: null,
          questionId: null,
          questionRevision: null,
          coversReceiptIds: [],
          proposalKind: null,
          afterWaitId: null,
          now,
        });

        updateWait(
          harness.db,
          expired.id,
          { closedReason: "deadline", closedAt: now },
          now,
        );

        const receipt = insertReceipt(harness.db, {
          rootThreadId: chat.id,
          threadId: chat.id,
          cause: "deadline",
          summary: "The native lane did not release before its deadline",
          outcomeRef: expired.id,
          waitId: expired.id,
          coveredInputIds: [],
          now,
        });

        const whileWorking = entryOf(await snapshot(world), chat.id);
        expect(whileWorking).toMatchObject(
          ownerAccepted
            ? { state: "needs-you", view: "inbox" }
            : { state: "working", view: "running", card: null },
        );
        expect(
          harness.db
            .select()
            .from(threadReceipts)
            .where(eq(threadReceipts.id, receipt.id))
            .get()?.handledAt,
        ).toBeNull();

        settleDanglingBackgroundTasks(harness.deps, {
          hostId: "host-expired-background-wait",
        });
        const stopped = entryOf(await snapshot(world), chat.id);
        expect(stopped).toMatchObject({ state: "needs-you", view: "inbox" });
        expect(stopped?.card?.primary).toMatchObject({
          kind: "keep-waiting",
          waitId: expired.id,
        });
      });
    },
  );

  it("drops a chat from running when the server settles its workflow and restores it when the workflow reports progress again", async () => {
    await withTestHarness(async (harness) => {
      const hostId = "host-inbox-background-work";
      const world = seedInboxWorld(harness, hostId);
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Run the review workflow");
      const turn = await startSubmittedTurn(world, chat.id);
      await postDaemonEvents(world, [
        workflowEnvelope(world, chat.id, {
          type: "item/started",
          turnId: turn.turnId,
        }),
      ]);
      await endTurn(world, turn, "completed");

      const whileRunning = await snapshot(world);
      expect(whileRunning.running.map((entry) => entry.threadId)).toContain(
        chat.id,
      );
      expect(entryOf(whileRunning, chat.id)?.state).not.toBe("finished");

      settleDanglingBackgroundTasks(harness.deps, { hostId });
      expect(entryOf(await snapshot(world), chat.id)?.view).not.toBe("running");

      await postDaemonEvents(world, [
        workflowEnvelope(world, chat.id, {
          type: "item/backgroundTask/progress",
        }),
      ]);

      const reopened = await snapshot(world);
      expect(reopened.running.map((entry) => entry.threadId)).toContain(
        chat.id,
      );
      expect(entryOf(reopened, chat.id)).toMatchObject({ view: "running" });
      expect(entryOf(reopened, chat.id)?.state).not.toBe("finished");
    });
  });
});

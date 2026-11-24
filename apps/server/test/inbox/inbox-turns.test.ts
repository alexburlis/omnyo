import {
  getThread,
  readThreadAttention,
  threadFailures,
  threadOwnerInputs,
  threadReceipts,
  threadWaits,
  threads,
} from "@omnyo/db";
import { threadAttentionResultSchema } from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { withTestHarness } from "../helpers/test-app.js";
import { seedThread } from "../helpers/seed.js";
import {
  acceptSteer,
  agentRequest,
  endTurn,
  entryOf,
  ownerRequest,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  snapshot,
  startSubmittedTurn,
} from "./inbox-driver.js";

describe("inbox turns on the real server", () => {
  it("replaces a source failure with its handoff destination until the source resumes", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-handoff-reason");
      const source = seedChat(world);
      await ownerSend(world, source.id, "Finish the change");
      const turn = await startSubmittedTurn(world, source.id);
      await endTurn(world, turn, "failed");
      await runInboxSweep(harness.deps, Date.now() + 31_000);
      expect(entryOf(await snapshot(world), source.id)?.reason.kind).toBe(
        "failure",
      );

      const target = seedThread(harness.deps, {
        projectId: world.projectId,
        environmentId: world.environmentId,
        sourceThreadId: source.id,
        originKind: "handoff",
        title: "Delivery closeout",
        status: "active",
      });

      const handedOff = entryOf(await snapshot(world), source.id);
      expect(handedOff).toMatchObject({
        state: "finished",
        reason: {
          kind: "recap",
          text: "Continued in Delivery closeout",
          threadId: target.id,
        },
        archiveReady: false,
        card: { failure: null },
      });
      expect(getThread(harness.db, source.id)?.status).toBe("error");
      expect(harness.db.select().from(threadFailures).all()).toHaveLength(1);

      harness.db
        .update(threads)
        .set({ title: "Verified closeout", archivedAt: Date.now() })
        .where(eq(threads.id, target.id))
        .run();
      harness.deps.hub.notifyThread(target.id, [
        "title-changed",
        "archived-changed",
      ]);
      expect(entryOf(await snapshot(world), source.id)?.reason.text).toBe(
        "Continued in Verified closeout",
      );

      harness.db
        .update(threads)
        .set({ lastMessageAt: target.createdAt + 1 })
        .where(eq(threads.id, source.id))
        .run();
      harness.deps.hub.notifyThread(source.id, [
        "events-appended",
        "status-changed",
      ]);
      expect(entryOf(await snapshot(world), source.id)?.reason.kind).toBe(
        "failure",
      );
    });
  });

  it("answers an owner message with one Result receipt on its chat", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-result");
      const chat = seedChat(world);
      const attentionBefore = getThread(harness.db, chat.id)?.latestAttentionAt;

      await ownerSend(world, chat.id, "Please fix the overlap");

      const turn = await startSubmittedTurn(world, chat.id);
      const running = await snapshot(world);
      expect(entryOf(running, chat.id)?.view).toBe("running");

      await endTurn(world, turn, "completed");

      const done = await snapshot(world);
      const entry = entryOf(done, chat.id);
      expect(entry?.view).toBe("inbox");
      expect(entry?.card?.kind).toBe("result");
      expect(entry?.card?.causes).toHaveLength(1);

      const receipts = harness.db
        .select()
        .from(threadReceipts)
        .where(eq(threadReceipts.rootThreadId, chat.id))
        .all();

      expect(receipts).toHaveLength(1);
      expect(JSON.parse(receipts[0]?.coveredInputIds ?? "[]")).toHaveLength(1);
      expect(getThread(harness.db, chat.id)?.latestAttentionAt).toBeGreaterThan(
        attentionBefore ?? 0,
      );
    });
  });

  it("keeps automatic continuation in Waiting after an owner progress reply", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-automatic-progress");
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Keep going after the deploy finishes");
      const turn = await startSubmittedTurn(world, chat.id);

      const registered = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits`,
        {
          key: "automatic-deploy",
          for: "the deploy",
          check: { what: "The deploy finished", at: Date.now() + 60_000 },
        },
      );

      expect(registered.status).toBe(200);
      await endTurn(world, turn, "completed");

      expect(entryOf(await snapshot(world), chat.id)).toMatchObject({
        view: "waiting",
        card: null,
        waiting: { group: "comes-back", reason: "the deploy" },
      });

      const receipts = harness.db
        .select()
        .from(threadReceipts)
        .where(eq(threadReceipts.rootThreadId, chat.id))
        .all();

      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ cause: "result", handledAt: null });
    });
  });

  it("steers a descendant's question into its running parent instead of the owner inbox", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-descendant-question");
      const root = seedChat(world);
      const asking = seedChat(world, { parentThreadId: root.id });

      await ownerSend(world, root.id, "Keep working while I decide");
      await startSubmittedTurn(world, root.id);
      const submits = pendingSubmitCount(world, root.id);

      const opened = await agentRequest(
        world,
        asking.id,
        `/threads/${asking.id}/attention`,
        {
          action: "open",
          questions: [
            {
              prompt: "Which direction?",
              mode: "required",
              options: [
                { value: "compact", label: "Compact" },
                { value: "detailed", label: "Detailed" },
              ],
            },
          ],
        },
      );

      expect(opened.status).toBe(200);
      expect(
        threadAttentionResultSchema.parse(await opened.json()),
      ).toMatchObject({ questions: [], routedToThreadId: root.id });

      const result = await snapshot(world);

      expect(entryOf(result, root.id)?.view).toBe("running");
      expect(entryOf(result, root.id)?.card?.kind).not.toBe("question");
      expect(
        readThreadAttention(harness.db, [asking.id]).get(asking.id),
      ).toMatchObject({ kind: "none", requiredCount: 0, optionalCount: 0 });
      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.cause, "question"))
          .all(),
      ).toEqual([]);
      expect(harness.db.select().from(threadWaits).all()).toEqual([]);
      expect(harness.db.select().from(threadFailures).all()).toEqual([]);
      expect(pendingSubmitCount(world, root.id)).toBe(submits + 1);
    });
  });

  it.each(["root", "lifecycle-owned"] as const)(
    "surfaces an optional %s question while the owner turn keeps running",
    async (location) => {
      await withTestHarness(async (harness) => {
        const world = seedInboxWorld(
          harness,
          `host-inbox-optional-${location}`,
        );

        const root = seedChat(world);

        const asking =
          location === "root"
            ? root
            : seedChat(world, { lifecycleOwnerThreadId: root.id });

        await ownerSend(world, root.id, "Keep working while I decide");
        await startSubmittedTurn(world, root.id);
        const submits = pendingSubmitCount(world, root.id);

        const opened = await ownerRequest(
          world,
          `/threads/${asking.id}/attention`,
          {
            action: "open",
            questions: [
              {
                prompt: "Which direction?",
                mode: "optional",
                options: [
                  { value: "compact", label: "Compact" },
                  { value: "detailed", label: "Detailed" },
                ],
              },
            ],
          },
        );

        expect(opened.status).toBe(200);

        const question = threadAttentionResultSchema.parse(await opened.json())
          .questions[0];

        if (!question) throw new Error("Optional question missing");

        const result = await snapshot(world);
        const shown = entryOf(result, root.id);

        expect(result.inbox.map((entry) => entry.threadId)).toContain(root.id);
        expect(result.running.map((entry) => entry.threadId)).not.toContain(
          root.id,
        );
        expect(shown?.card).toMatchObject({
          kind: "question",
          questionMode: "optional",
          questionIds: [question.id],
          questionFrom: location === "root" ? null : asking.title,
          actions: ["archive", "wait", "reply", "shelf"],
        });
        expect(shown?.running?.label).toBeTruthy();
        expect(getThread(harness.db, root.id)?.status).toBe("active");
        expect(
          readThreadAttention(harness.db, [asking.id]).get(asking.id),
        ).toMatchObject({
          kind: "optional-input",
          requiredCount: 0,
          optionalCount: 1,
        });
        expect(harness.db.select().from(threadWaits).all()).toEqual([]);
        expect(harness.db.select().from(threadFailures).all()).toEqual([]);
        expect(pendingSubmitCount(world, root.id)).toBe(submits);

        const skipped = await ownerRequest(
          world,
          `/threads/${asking.id}/attention`,
          { action: "skip", id: question.id, revision: question.revision },
        );

        expect(skipped.status).toBe(200);
        expect(entryOf(await snapshot(world), root.id)?.view).toBe("running");
        expect(getThread(harness.db, root.id)?.status).toBe("active");
        expect(pendingSubmitCount(world, root.id)).toBe(submits);
      });
    },
  );

  it.each(["wait", "archive"] as const)(
    "keeps an optional question nonblocking for owner %s",
    async (action) => {
      await withTestHarness(async (harness) => {
        const world = seedInboxWorld(harness, `host-inbox-optional-${action}`);
        const chat = seedChat(world);

        const opened = await ownerRequest(
          world,
          `/threads/${chat.id}/attention`,
          {
            action: "open",
            questions: [{ prompt: "Which direction?", mode: "optional" }],
          },
        );

        expect(opened.status).toBe(200);
        const before = entryOf(await snapshot(world), chat.id);

        if (before === null) throw new Error("Optional Inbox card missing");
        expect(before.card?.questionMode).toBe("optional");

        const request =
          action === "wait"
            ? {
                action,
                threadId: chat.id,
                displayedReceiptIds: [],
                latch: before.latch,
                until: Date.now() + 60_000,
              }
            : {
                action,
                threadId: chat.id,
                displayedReceiptIds: [],
                latch: before.latch,
              };

        const moved = await ownerRequest(world, "/inbox/act", request);

        expect(moved.status).toBe(200);
        expect(harness.db.select().from(threadFailures).all()).toEqual([]);
        expect(pendingSubmitCount(world, chat.id)).toBe(0);

        if (action === "wait") {
          expect(getThread(harness.db, chat.id)?.status).toBe("idle");
          expect(
            readThreadAttention(harness.db, [chat.id]).get(chat.id),
          ).toMatchObject({ requiredCount: 0, optionalCount: 1 });
          expect(harness.db.select().from(threadWaits).all()).toHaveLength(1);
        } else
          expect(getThread(harness.db, chat.id)?.archivedAt).not.toBeNull();
      });
    },
  );

  it("requires a new latch when an optional question becomes required", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-question-mode");
      const chat = seedChat(world);

      const opened = await ownerRequest(
        world,
        `/threads/${chat.id}/attention`,
        {
          action: "open",
          questions: [{ prompt: "Which direction?", mode: "optional" }],
        },
      );

      expect(opened.status).toBe(200);

      const question = threadAttentionResultSchema.parse(await opened.json())
        .questions[0];

      if (!question) throw new Error("Optional question missing");

      const optional = entryOf(await snapshot(world), chat.id);

      if (optional === null) throw new Error("Optional Inbox card missing");
      expect(optional.card?.questionMode).toBe("optional");

      const changed = await ownerRequest(
        world,
        `/threads/${chat.id}/attention`,
        {
          action: "update",
          id: question.id,
          revision: question.revision,
          question: { ...question.question, mode: "required" },
        },
      );

      expect(changed.status).toBe(200);
      const required = entryOf(await snapshot(world), chat.id);

      expect(required?.card).toMatchObject({
        questionMode: "required",
        questionIds: [question.id],
        actions: [],
      });
      expect(required?.latch).not.toBe(optional?.latch);

      const stale = await ownerRequest(world, "/inbox/act", {
        action: "snooze-question",
        threadId: chat.id,
        questionId: question.id,
        until: Date.now() + 60_000,
        latch: optional.latch,
      });

      expect(stale.status).toBe(409);

      const archive = await ownerRequest(world, "/inbox/act", {
        action: "archive",
        threadId: chat.id,
        displayedReceiptIds: [],
        latch: required?.latch,
      });

      expect(archive.status).toBe(409);
      expect(getThread(harness.db, chat.id)?.archivedAt).toBeNull();
      expect(harness.db.select().from(threadWaits).all()).toEqual([]);
      expect(harness.db.select().from(threadFailures).all()).toEqual([]);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);
    });
  });

  it("pauses the chat on a failure: Problem with Resume, queued messages hold", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-failure");
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Run the migration");
      const turn = await startSubmittedTurn(world, chat.id);
      await ownerSend(world, chat.id, "Then summarise it");
      await acceptSteer(world, turn);
      await endTurn(world, turn, "failed");

      const deciding = entryOf(await snapshot(world), chat.id);
      expect(deciding?.view).toBe("waiting");
      expect(deciding?.state).toBe("waiting");
      expect(pendingSubmitCount(world, chat.id)).toBe(0);

      await runInboxSweep(harness.deps, Date.now() + 31_000);

      const inbox = await snapshot(world);
      const entry = entryOf(inbox, chat.id);
      expect(entry?.state).toBe("failed");
      expect(entry?.reason.text.trim()).not.toBe("");
      expect(entry?.card?.kind).toBe("problem");
      expect(entry?.card?.primary).toMatchObject({
        kind: "resume",
        targetThreadId: chat.id,
      });
      expect(pendingSubmitCount(world, chat.id)).toBe(0);

      const owed = harness.db
        .select()
        .from(threadOwnerInputs)
        .where(eq(threadOwnerInputs.threadId, chat.id))
        .all();

      expect(owed.map((input) => input.state)).toEqual(["owed", "owed"]);
    });
  });

  it("keeps a negative check silent and in Waiting", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-check");
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Check Google's data tomorrow");
      const first = await startSubmittedTurn(world, chat.id);
      const at = Date.now() + 60_000;

      const registered = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits`,
        {
          key: "seo-checkpoint",
          for: "Google's final Oct 27 data",
          check: { what: "Search Console shows Oct 27", at },
        },
      );

      expect(registered.status).toBe(200);
      const { wait } = (await registered.json()) as { wait: { id: string } };
      await endTurn(world, first, "completed");

      expect(entryOf(await snapshot(world), chat.id)?.view).toBe("waiting");

      const attentionBefore = getThread(harness.db, chat.id)?.latestAttentionAt;
      await runInboxSweep(harness.deps, at + 1);
      const check = await startSubmittedTurn(world, chat.id);
      expect(entryOf(await snapshot(world), chat.id)?.waiting?.checking).toBe(
        true,
      );

      const rearm = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits/${wait.id}/rearm`,
        undefined,
      );

      expect(rearm.status).toBe(200);
      await endTurn(world, check, "completed");

      const after = entryOf(await snapshot(world), chat.id);
      expect(after?.view).toBe("waiting");
      expect(after?.waiting?.checkCount).toBe(1);
      expect(getThread(harness.db, chat.id)?.latestAttentionAt).toBe(
        attentionBefore,
      );
    });
  });

  it("ends a fired wait whose queued wake is deleted while the chat is busy", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-wake-deleted");
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Watch the GPU run");
      const first = await startSubmittedTurn(world, chat.id);
      const at = Date.now() + 60_000;

      const registered = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits`,
        {
          key: "gpu-run",
          for: "the GPU run",
          check: { what: "The GPU run finished", at },
        },
      );

      expect(registered.status).toBe(200);
      const { wait } = (await registered.json()) as { wait: { id: string } };

      await runInboxSweep(harness.deps, at + 1);

      const fired = harness.db
        .select()
        .from(threadWaits)
        .where(eq(threadWaits.id, wait.id))
        .get();

      expect(fired?.status).toBe("dispatched");
      expect(fired?.dispatchQueuedMessageId).not.toBeNull();

      const deleted = await harness.app.request(
        `/api/v1/threads/${chat.id}/queued-messages/${fired?.dispatchQueuedMessageId}`,
        { method: "DELETE" },
      );

      expect(deleted.status).toBe(200);
      await endTurn(world, first, "completed");

      expect(
        harness.db
          .select()
          .from(threadWaits)
          .where(eq(threadWaits.id, wait.id))
          .get(),
      ).toMatchObject({ status: "closed", closedReason: "wake-deleted" });
      expect(entryOf(await snapshot(world), chat.id)?.view).not.toBe("waiting");
    });
  });

  it("closes the wait that woke a turn when the turn hands off to a follow-up wait", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-inbox-handoff");
      const chat = seedChat(world);

      await ownerSend(world, chat.id, "Check the deploy, then the rollout");
      const first = await startSubmittedTurn(world, chat.id);
      const at = Date.now() + 60_000;

      const registered = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits`,
        {
          key: "deploy",
          for: "the deploy",
          check: { what: "The deploy finished", at },
        },
      );

      expect(registered.status).toBe(200);

      const { wait: woke } = (await registered.json()) as {
        wait: { id: string };
      };

      await endTurn(world, first, "completed");

      await runInboxSweep(harness.deps, at + 1);
      const woken = await startSubmittedTurn(world, chat.id);

      const followUp = await agentRequest(
        world,
        chat.id,
        `/threads/${chat.id}/waits`,
        {
          key: "rollout",
          for: "the rollout",
          check: { what: "The rollout finished", at: at + 120_000 },
          after: woke.id,
        },
      );

      expect(followUp.status).toBe(200);

      const { wait: next } = (await followUp.json()) as {
        wait: { id: string };
      };

      await endTurn(world, woken, "completed");

      const waits = harness.db
        .select()
        .from(threadWaits)
        .where(eq(threadWaits.threadId, chat.id))
        .all();

      expect(waits.find((row) => row.id === woke.id)).toMatchObject({
        status: "closed",
        closedReason: "continued",
      });
      expect(waits.find((row) => row.id === next.id)?.status).toBe("live");
      expect(entryOf(await snapshot(world), chat.id)).toMatchObject({
        view: "waiting",
        card: null,
        waiting: { reason: "the rollout" },
      });
    });
  });
});

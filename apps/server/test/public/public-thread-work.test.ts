import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  archiveThread,
  createPendingInteraction,
  getThread,
  publishThreadWork,
  setPendingInteractionResolving,
  threadCallbacks,
  threadFailures,
  threads,
} from "@omnyo/db";
import {
  INBOX_CALLER_THREAD_HEADER,
  inboxSnapshotSchema,
  threadSchema,
  threadScope,
  threadWorkSummarySchema,
  turnScope,
  type ThreadEventType,
  type ThreadWorkContribution,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  seedChatCompletionReport,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
} from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { writeReceipt } from "../../src/services/inbox/engine.js";
import {
  createAllowOnceResolution,
  createCommandApprovalPayload,
} from "../helpers/pending-interactions.js";

async function read(harness: TestAppHarness, id: string) {
  const response = await harness.app.request(`/api/v1/threads/${id}/work`);
  expect(response.status).toBe(200);

  return threadWorkSummarySchema.parse(await response.json());
}

async function publish(
  harness: TestAppHarness,
  id: string,
  pluginId: string,
  contribution: ThreadWorkContribution,
) {
  return harness.app.request(`/api/v1/threads/${id}/work`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pluginId, contribution }),
  });
}

function seedConversationEvent(
  harness: TestAppHarness,
  threadId: string,
  sequence: number,
  type: ThreadEventType,
): void {
  seedStoredEvent(harness.deps, {
    threadId,
    sequence,
    type,
    scope: type.startsWith("turn/") ? turnScope("turn-1") : threadScope(),
    data: {},
  });
}

async function seedAssessedTurn(
  harness: TestAppHarness,
  threadId: string,
  { requestSeq = 1, completedSeq = 3, report = true } = {},
) {
  seedConversationEvent(harness, threadId, requestSeq, "client/turn/requested");
  seedConversationEvent(harness, threadId, requestSeq + 1, "turn/started");
  seedStoredEvent(harness.deps, {
    threadId,
    sequence: completedSeq,
    type: "turn/completed",
    scope: turnScope("turn-1"),
    data: { status: "completed" },
  });

  if (report)
    seedChatCompletionReport(harness.db, threadId, "turn-1", requestSeq);

  const { basis } = await read(harness, threadId);

  const published = await publish(harness, threadId, "composer-predictions", {
    kind: "assessment",
    assessment: {
      basis,
      contractVersion: 1,
      availability: "available",
      reason: "The requested change is complete.",
      sourceSeq: completedSeq,
      text: null,
      noSuggestionReason: "No reply is needed.",
      waitingOn: null,
      ask: null,
      recap: null,
      archiveReady: true,
    },
  });

  expect(published.status).toBe(200);

  return basis;
}

const activeSignals: ThreadWorkContribution = {
  kind: "signals",
  signals: {
    complete: true,
    validUntil: Date.now() + 600_000,
    activity: [
      {
        id: "release-1",
        kind: "command",
        label: "Release job running.",
        phase: "running",
        actor: { kind: "agent", id: "release-1", label: "Release job" },
      },
    ],
    waits: [],
    failures: [],
    postponement: null,
  },
};

describe("shared thread work API", () => {
  it("clears required input after a permission is answered while its acknowledgement is pending", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });

      const interaction = createPendingInteraction(harness.db, {
        threadId: thread.id,
        turnId: "turn-permission",
        providerId: "codex",
        providerThreadId: "provider-permission",
        providerRequestId: "request-permission",
        payload: JSON.stringify(
          createCommandApprovalPayload({
            itemId: "permission-command",
            reason: "Approve the command",
            command: "git status",
            cwd: "/tmp/project",
          }),
        ),
      });

      expect((await read(harness, thread.id)).primary.label).toBe("needs-you");
      setPendingInteractionResolving(harness.db, {
        id: interaction.id,
        resolution: JSON.stringify(createAllowOnceResolution()),
      });

      const answered = await read(harness, thread.id);
      expect(answered.requiredInput).toEqual([]);
      expect(answered.primary.label).toBe("working");
      expect(answered.waits.map((wait) => wait.id)).toContain(interaction.id);
      harness.db
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, thread.id))
        .run();
      const acknowledging = await read(harness, thread.id);
      expect(acknowledging.primary.label).toBe("waiting");
      expect(acknowledging.archive.eligible).toBe(false);
    });
  });

  it("keeps another chat's required answer on its owner instead of fabricating a callback question", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: waiter,
      } = seedThreadFixture(harness);

      const source = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Source chat",
      });

      const opened = await harness.app.request(
        `/api/v1/threads/${source.id}/attention`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "open",
            questions: [{ prompt: "Choose the scope.", mode: "required" }],
          }),
        },
      );

      expect(opened.status).toBe(200);
      harness.db
        .insert(threadCallbacks)
        .values({
          threadId: waiter.id,
          id: "callback-required-source",
          sourceThreadId: source.id,
          sourceTitle: "Source chat",
          reason: "Await the source result",
          createdAt: Date.now(),
          afterSeq: 0,
          matchText: "[callback-required-source]",
        })
        .run();

      const waiting = await read(harness, waiter.id);
      expect(waiting.requiredInput).toEqual([]);
      expect(waiting.primary.label).toBe("waiting");
      expect(waiting.waits).toContainEqual(
        expect.objectContaining({
          id: "callback-required-source",
          actor: { kind: "thread", id: source.id, label: "Source chat" },
        }),
      );

      const snapshot = inboxSnapshotSchema.parse(
        await (await harness.app.request("/api/v1/inbox")).json(),
      );

      expect(
        snapshot.waiting.find((entry) => entry.threadId === waiter.id),
      ).toMatchObject({ state: "waiting", reason: { kind: "wait" } });
      expect((await read(harness, source.id)).primary.label).toBe("needs-you");
    });
  });

  it.each([null, "Schedule the Round 9 comparison."])(
    "keeps a predicted external run without an owner ask in Waiting (suggestion: %s)",
    async (suggestion) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        const basis = await seedAssessedTurn(harness, thread.id);
        writeReceipt(harness.db, {
          threadId: thread.id,
          cause: "result",
          summary: "Turn finished",
          outcomeRef: "turn-1",
          waitId: null,
          coveredInputIds: [],
          now: Date.now(),
        });

        const response = await publish(
          harness,
          thread.id,
          "composer-predictions",
          {
            kind: "assessment",
            assessment: {
              basis,
              contractVersion: 1,
              availability: "available",
              reason: "The candidate run is still pending.",
              sourceSeq: 3,
              text: suggestion,
              noSuggestionReason:
                suggestion === null ? "The run is still pending." : null,
              waitingOn: "held-out candidate run and paired grading",
              ask: null,
              recap: null,
              archiveReady: false,
            },
          },
        );

        expect(response.status).toBe(200);
        expect((await read(harness, thread.id)).primary.label).toBe("external");

        const snapshot = inboxSnapshotSchema.parse(
          await (await harness.app.request("/api/v1/inbox")).json(),
        );

        expect(
          snapshot.waiting.find((entry) => entry.threadId === thread.id),
        ).toMatchObject({
          state: "waiting",
          reason: {
            kind: "wait",
            text: "Waiting on held-out candidate run and paired grading",
          },
          archiveReady: false,
        });
      });
    },
  );

  it.each([null, "Schedule the Round 9 comparison."])(
    "puts an owner ask in Needs you even while it also predicts an external wait (suggestion: %s)",
    async (suggestion) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness);
        const basis = await seedAssessedTurn(harness, thread.id);
        writeReceipt(harness.db, {
          threadId: thread.id,
          cause: "result",
          summary: "Turn finished",
          outcomeRef: "turn-1",
          waitId: null,
          coveredInputIds: [],
          now: Date.now(),
        });

        const response = await publish(
          harness,
          thread.id,
          "composer-predictions",
          {
            kind: "assessment",
            assessment: {
              basis,
              contractVersion: 1,
              availability: "available",
              reason: "The candidate run is still pending.",
              sourceSeq: 3,
              text: suggestion,
              noSuggestionReason:
                suggestion === null ? "The run is still pending." : null,
              waitingOn: "held-out candidate run and paired grading",
              ask: "Decide whether to schedule the Round 9 head-to-head comparison.",
              recap: null,
              archiveReady: false,
            },
          },
        );

        expect(response.status).toBe(200);

        const work = await read(harness, thread.id);

        expect(work.primary).toEqual({
          label: "needs-you",
          reason: {
            code: "assessed-ask",
            text: "Decide whether to schedule the Round 9 head-to-head comparison.",
          },
        });
        expect(work.nextActors).toEqual([
          { kind: "user", id: null, label: "You" },
        ]);
        expect(work.archive.recommended).toBe(false);

        const snapshot = inboxSnapshotSchema.parse(
          await (await harness.app.request("/api/v1/inbox")).json(),
        );

        expect(
          snapshot.waiting.some((entry) => entry.threadId === thread.id),
        ).toBe(false);
        expect(
          snapshot.inbox.find((entry) => entry.threadId === thread.id),
        ).toMatchObject({
          state: "needs-you",
          view: "inbox",
          reason: {
            kind: "ask",
            text: "Decide whether to schedule the Round 9 head-to-head comparison.",
          },
          card: { kind: "result" },
          archiveReady: false,
        });
        expect(snapshot.counts.needsYou).toBe(1);
      });
    },
  );

  it("replays Heyclicky: a historical plan does not clear the latest open outcome", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedChatCompletionReport(harness.db, thread.id, "earlier-plan-turn", 376);

      const basis = await seedAssessedTurn(harness, thread.id, {
        requestSeq: 2262,
        completedSeq: 2285,
        report: false,
      });

      const work = await read(harness, thread.id);
      expect(work.archive.recommended).toBe(false);
      expect(work.assessment.reason).toMatch(/completion report/i);

      const archive = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-ready`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ basis }),
        },
      );

      expect(archive.status).toBe(409);
    });
  });

  it("replays the landing-page continuation: a handoff withdraws the predecessor's Ready verdict", async () => {
    await withTestHarness(async (harness) => {
      const { project, thread } = seedThreadFixture(harness);

      const basis = await seedAssessedTurn(harness, thread.id, {
        requestSeq: 208,
        completedSeq: 311,
      });

      expect((await read(harness, thread.id)).archive.recommended).toBe(true);

      const fork = seedThread(harness.deps, {
        projectId: project.id,
        sourceThreadId: thread.id,
        originKind: "fork",
      });

      seedConversationEvent(harness, fork.id, 7, "turn/input/accepted");
      expect((await read(harness, thread.id)).archive.recommended).toBe(true);

      const continuation = seedThread(harness.deps, {
        projectId: project.id,
        sourceThreadId: thread.id,
        originKind: "handoff",
      });

      seedConversationEvent(harness, continuation.id, 7, "turn/input/accepted");
      const work = await read(harness, thread.id);
      expect(work.basis).toBe(basis);
      expect(work.archive.recommended).toBe(false);
      expect(work.assessment.reason).toMatch(/continued in another chat/i);
    });
  });

  it("treats a persisted pre-veto Ready verdict as stale without a new message", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedConversationEvent(harness, thread.id, 1, "client/turn/requested");
      seedConversationEvent(harness, thread.id, 2, "turn/started");
      seedConversationEvent(harness, thread.id, 3, "turn/completed");

      const basis = createHash("sha256")
        .update(JSON.stringify([2, thread.id, 1, 2, 3, 0]))
        .digest("hex");

      publishThreadWork(harness.db, thread.id, {
        pluginId: "composer-predictions",
        contribution: {
          kind: "assessment",
          assessment: {
            basis,
            contractVersion: 1,
            availability: "available",
            reason: "The local patch passed lint.",
            sourceSeq: 3,
            text: null,
            noSuggestionReason: null,
            waitingOn: null,
            ask: null,
            recap: null,
            archiveReady: true,
          },
        },
      });

      const work = await read(harness, thread.id);
      expect(work.assessment).toMatchObject({
        availability: "stale",
        sourceSeq: 3,
      });
      expect(work.archive.recommended).toBe(false);
    });
  });

  it("reads work, list, detail and notification snapshots without assembling the plugin catalogue", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      expect(
        (await publish(harness, thread.id, "release:1", activeSignals)).status,
      ).toBe(200);

      const catalogue = vi
        .spyOn(harness.pluginService, "list")
        .mockImplementation(() => {
          throw new Error("The full plugin catalogue is unavailable.");
        });

      try {
        const work = await read(harness, thread.id);
        expect(work.activity.map((activity) => activity.id)).toEqual([
          "release-1",
        ]);

        const listed = await harness.app.request(
          `/api/v1/threads?threadIds=${thread.id}`,
        );

        expect(listed.status).toBe(200);
        expect(await listed.json()).toEqual([
          expect.objectContaining({ id: thread.id, work }),
        ]);

        const detail = await harness.app.request(
          `/api/v1/threads/${thread.id}`,
        );

        expect(detail.status).toBe(200);
        expect(await detail.json()).toMatchObject({ id: thread.id, work });

        const notifications: ThreadWorkSummary[] = [];

        const unsubscribe = harness.hub.onChangedMessage((message) => {
          if (message.entity !== "thread" || message.id !== thread.id) return;
          const snapshot = message.metadata?.listEntry?.work;

          if (snapshot !== null && snapshot !== undefined)
            notifications.push(snapshot);
        });

        try {
          harness.hub.notifyThread(thread.id, ["status-changed"]);
          expect(notifications).toHaveLength(1);
          expect(notifications[0]).toEqual(await read(harness, thread.id));
        } finally {
          unsubscribe();
        }

        expect(catalogue).not.toHaveBeenCalled();
      } finally {
        catalogue.mockRestore();
      }
    });
  });

  it("retains required and optional input alongside the same producer snapshot in list and detail", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      expect(
        (await publish(harness, thread.id, "release:1", activeSignals)).status,
      ).toBe(200);

      const opened = await harness.app.request(
        `/api/v1/threads/${thread.id}/attention`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "open",
            questions: [
              { prompt: "Choose the scope.", mode: "required" },
              { prompt: "Any preferences?", mode: "optional" },
            ],
          }),
        },
      );

      expect(opened.status).toBe(200);
      const work = await read(harness, thread.id);
      expect(work.primary.label).toBe("needs-you");
      expect(work.activity).toHaveLength(1);
      expect(work.requiredInput).toHaveLength(1);
      expect(work.optionalInput).toHaveLength(1);
      expect(work.nextActors.map((actor) => actor.kind)).toEqual([
        "user",
        "agent",
      ]);

      const listed = await harness.app.request(
        `/api/v1/threads?threadIds=${thread.id}`,
      );

      const entries = await listed.json();
      const detail = await harness.app.request(`/api/v1/threads/${thread.id}`);
      expect(entries[0].work).toEqual(work);
      expect((await detail.json()).work).toEqual(work);
    });
  });

  it("rejects an assessment of an older conversation and rechecks the basis for ready-only archive", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);

      const assessment = {
        kind: "assessment" as const,
        assessment: {
          basis,
          contractVersion: 1 as const,
          availability: "available" as const,
          reason: "The requested change is complete.",
          sourceSeq: 3,
          text: null,
          noSuggestionReason: "No reply is needed.",
          waitingOn: null,
          ask: null,
          recap: null,
          archiveReady: true,
        },
      };

      expect(
        (await publish(harness, thread.id, "composer-predictions", assessment))
          .status,
      ).toBe(200);
      expect((await read(harness, thread.id)).archive.recommended).toBe(true);

      seedConversationEvent(harness, thread.id, 4, "client/turn/requested");
      expect(
        (await publish(harness, thread.id, "composer-predictions", assessment))
          .status,
      ).toBe(409);

      const stale = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-ready`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ basis }),
        },
      );

      expect(stale.status).toBe(409);
      const moved = await read(harness, thread.id);
      expect(moved.assessment.availability).toBe("stale");
      expect(moved.archive.recommended).toBe(false);
      expect(
        (
          await publish(harness, thread.id, "composer-predictions", {
            ...assessment,
            assessment: { ...assessment.assessment, basis: moved.basis },
          })
        ).status,
      ).toBe(200);

      expect((await read(harness, thread.id)).archive.recommended).toBe(false);

      const settled = await seedAssessedTurn(harness, thread.id, {
        requestSeq: 5,
        completedSeq: 7,
      });

      const archived = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-ready`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ basis: settled }),
        },
      );

      expect(archived.status).toBe(200);
      expect((await archived.json()).archivedThreadIds).toEqual([thread.id]);
    });
  });

  it.each([false, true])(
    "archives all descendants of a ready nested chat (already archived child: %s)",
    async (archivedChild) => {
      await withTestHarness(async (harness) => {
        const { project, thread: root } = seedThreadFixture(harness);

        const childOf = (parentThreadId: string) =>
          seedThread(harness.deps, { projectId: project.id, parentThreadId });

        const parent = childOf(root.id);
        const sibling = childOf(root.id);
        const child = childOf(parent.id);
        const grandchild = childOf(child.id);

        if (archivedChild) archiveThread(harness.db, harness.hub, child.id);

        const basis = await seedAssessedTurn(harness, parent.id);

        const archive = () =>
          harness.app.request(`/api/v1/threads/${parent.id}/archive-ready`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ basis }),
          });

        if (archivedChild) {
          harness.db
            .update(threads)
            .set({ status: "active" })
            .where(eq(threads.id, grandchild.id))
            .run();
          expect((await archive()).status).toBe(409);
          expect(getThread(harness.db, parent.id)?.archivedAt).toBeNull();
          expect(getThread(harness.db, grandchild.id)?.archivedAt).toBeNull();
          harness.db
            .update(threads)
            .set({ status: "idle" })
            .where(eq(threads.id, grandchild.id))
            .run();
        }

        const response = await archive();

        expect(response.status).toBe(200);

        const newlyArchived = archivedChild
          ? [parent.id, grandchild.id]
          : [parent.id, child.id, grandchild.id];

        expect((await response.json()).archivedThreadIds.sort()).toEqual(
          newlyArchived.sort(),
        );

        for (const thread of [parent, child, grandchild])
          expect(getThread(harness.db, thread.id)?.archivedAt).toEqual(
            expect.any(Number),
          );

        for (const thread of [root, sibling])
          expect(getThread(harness.db, thread.id)?.archivedAt).toBeNull();
      });
    },
  );

  it("keeps a formed verdict when only non-conversation evidence changes", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);
      expect((await read(harness, thread.id)).archive.recommended).toBe(true);

      seedConversationEvent(
        harness,
        thread.id,
        4,
        "thread/contextWindowUsage/updated",
      );
      seedConversationEvent(
        harness,
        thread.id,
        5,
        "provider/rateLimits/updated",
      );
      seedConversationEvent(harness, thread.id, 6, "system/git-activity");
      harness.hub.notifyThread(thread.id, ["status-changed"]);
      harness.hub.notifyThread(thread.id, ["queue-changed"]);

      const settled = await read(harness, thread.id);
      expect(settled.basis).toBe(basis);
      expect(settled.assessment.availability).toBe("available");
      expect(settled.archive.recommended).toBe(true);
      expect(settled.primary.label).toBe("ready-to-archive");
    });
  });

  it("keeps a chat with a live Inbox wait out of Ready to archive until the wait ends", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);
      const agent = { [INBOX_CALLER_THREAD_HEADER]: thread.id };

      const registered = await harness.app.request(
        `/api/v1/threads/${thread.id}/waits`,
        {
          method: "POST",
          headers: { "content-type": "application/json", ...agent },
          body: JSON.stringify({
            key: "deploy",
            for: "the deploy",
            check: { what: "The deploy finished", at: Date.now() + 60_000 },
          }),
        },
      );

      expect(registered.status).toBe(200);
      const { wait } = (await registered.json()) as { wait: { id: string } };

      const waiting = await read(harness, thread.id);
      expect(waiting.basis).toBe(basis);
      expect(waiting.primary.label).toBe("waiting");
      expect(waiting.archive.recommended).toBe(false);
      expect(waiting.waits).toEqual([
        {
          id: wait.id,
          reason: "Waiting for: the deploy",
          actor: { kind: "external", id: null, label: "The deploy finished" },
        },
      ]);

      const cancelled = await harness.app.request(
        `/api/v1/threads/${thread.id}/waits/${wait.id}/cancel`,
        { method: "POST", headers: agent },
      );

      expect(cancelled.status).toBe(200);
      const restored = await read(harness, thread.id);
      expect(restored.primary.label).toBe("ready-to-archive");
    });
  });

  it("vetoes a formed verdict while work is owned and restores it without reassessment", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);

      expect(
        (await publish(harness, thread.id, "release:1", activeSignals)).status,
      ).toBe(200);
      const owned = await read(harness, thread.id);
      expect(owned.primary.label).toBe("working");
      expect(owned.archive.recommended).toBe(false);

      const refused = await harness.app.request(
        `/api/v1/threads/${thread.id}/archive-ready`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ basis }),
        },
      );

      expect(refused.status).toBe(409);

      expect(
        (
          await publish(harness, thread.id, "release:1", {
            kind: "signals",
            signals: { ...activeSignals.signals, activity: [] },
          })
        ).status,
      ).toBe(200);
      const cleared = await read(harness, thread.id);
      expect(cleared.basis).toBe(basis);
      expect(cleared.archive.recommended).toBe(true);
    });
  });

  it("makes a formed verdict stale after a history rewrite such as a context clear", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);

      harness.hub.notifyThread(thread.id, ["history-rewritten"]);

      const moved = await read(harness, thread.id);
      expect(moved.basis).not.toBe(basis);
      expect(moved.assessment.availability).toBe("stale");
      expect(moved.archive.recommended).toBe(false);
    });
  });

  it.each([
    ["new input", "client/turn/requested"],
    ["a provider-started turn", "turn/started"],
    ["a later completed turn", "turn/completed"],
  ] as const)("makes a formed verdict stale after %s", async (_label, type) => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      const basis = await seedAssessedTurn(harness, thread.id);

      seedConversationEvent(harness, thread.id, 4, type);

      const moved = await read(harness, thread.id);
      expect(moved.basis).not.toBe(basis);
      expect(moved.assessment.availability).toBe("stale");
      expect(moved.archive.recommended).toBe(false);
    });
  });

  it("expires an unverified producer without hiding its durable terminal failure", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      expect(
        (
          await publish(harness, thread.id, "release:expired", {
            kind: "signals",
            signals: { ...activeSignals.signals, validUntil: Date.now() - 1 },
          })
        ).status,
      ).toBe(200);
      const expired = await read(harness, thread.id);
      expect(expired.primary.label).toBe("open");
      expect(expired.activity).toHaveLength(0);
      expect(expired.archive.eligible).toBe(false);
      expect(
        (
          await publish(harness, thread.id, "release:expired", {
            kind: "signals",
            signals: {
              ...activeSignals.signals,
              validUntil: null,
              activity: [],
              failures: [
                {
                  code: "release-failed",
                  text: "The release job failed before verification.",
                  sourceId: "release:expired",
                },
              ],
            },
          })
        ).status,
      ).toBe(200);
      const failed = await read(harness, thread.id);
      expect(failed.primary.label).toBe("failed");
      expect(failed.failures[0]?.code).toBe("release-failed");
      expect(failed.archive.recommended).toBe(false);
    });
  });

  it("keeps read state and Shelf placement independent of a recorded failure", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await publish(harness, thread.id, "release:failed", {
        kind: "signals",
        signals: {
          ...activeSignals.signals,
          validUntil: null,
          activity: [],
          failures: [
            {
              code: "release-failed",
              text: "The release job failed before verification.",
              sourceId: "release:failed",
            },
          ],
        },
      });
      const failed = await read(harness, thread.id);

      for (const action of ["read", "unread", "shelve"]) {
        expect(
          (
            await harness.app.request(
              `/api/v1/threads/${thread.id}/${action}`,
              { method: "POST" },
            )
          ).status,
        ).toBe(200);
        expect(await read(harness, thread.id)).toEqual(failed);
      }
    });
  });

  it("clears only the reporting producer and invalidates old completion after its start and finish", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      await publish(harness, thread.id, "release:first", activeSignals);
      await publish(harness, thread.id, "release:second", {
        kind: "signals",
        signals: {
          ...activeSignals.signals,
          activity: activeSignals.signals.activity.map((activity) => ({
            ...activity,
            id: "release-2",
          })),
        },
      });
      expect((await read(harness, thread.id)).activity).toHaveLength(2);
      await publish(harness, thread.id, "release:first", {
        kind: "signals",
        signals: { ...activeSignals.signals, activity: [] },
      });
      const remaining = await read(harness, thread.id);
      expect(remaining.primary.label).toBe("working");
      expect(remaining.activity.map((activity) => activity.id)).toEqual([
        "release-2",
      ]);
    });
  });

  it.each(["thread-busy", "stopping", "turn-starting"] as const)(
    "shows a message held by %s behind a failed run as Failed rather than Working",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness, {
          thread: { status: "error" },
        });

        seedQueuedMessage(harness.deps, {
          threadId: thread.id,
          content: textInput("Continue with the next step"),
          waitingOn: { kind },
        });
        const held = await read(harness, thread.id);
        expect(held.primary.label).toBe("failed");
        expect(held.primary.reason.code).toBe("run-failed");
        expect(held.activity).toHaveLength(0);
        expect(held.nextActors.map((actor) => actor.label)).not.toContain(
          "Agent queue",
        );
      });
    },
  );

  it("keeps a due retry on a failed run as queued work", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "error" },
      });

      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Retry"),
        sendAt: Date.now() - 1_000,
        waitingOn: { kind: "time" },
      });
      const due = await read(harness, thread.id);
      expect(due.primary.label).toBe("working");
      expect(due.activity.map((activity) => activity.kind)).toEqual(["queue"]);
    });
  });

  it.each(["held", "deciding", "actionable"] as const)(
    "counts a failed run with a %s failure as Failed only when actionable",
    async (state) => {
      await withTestHarness(async (harness) => {
        const { thread } = seedThreadFixture(harness, {
          thread: { status: "error" },
        });

        const now = Date.now();

        harness.db
          .insert(threadFailures)
          .values({
            id: "failure-1",
            threadId: thread.id,
            state,
            reason: "The turn failed.",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const work = await read(harness, thread.id);

        if (state === "actionable") {
          expect(work.primary.label).toBe("failed");
          expect(work.primary.reason.code).toBe("run-failed");
        } else {
          expect(work.primary.label).toBe("waiting");
          expect(work.failures).toHaveLength(0);
          expect(work.nextActors.map((actor) => actor.label)).toContain(
            "Automatic retry",
          );
        }
      });
    },
  );

  it("shows a future scheduled dispatch as Waiting rather than advancing work", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      seedQueuedMessage(harness.deps, {
        threadId: thread.id,
        content: textInput("Resume later"),
        sendAt: Date.now() + 600_000,
        waitingOn: { kind: "time" },
      });
      const waiting = await read(harness, thread.id);
      expect(waiting.primary.label).toBe("waiting");
      expect(waiting.activity).toHaveLength(0);
      expect(waiting.nextActors[0]?.label).toBe("Scheduled dispatch");
    });
  });
});

const settledSignals: ThreadWorkContribution = {
  kind: "signals",
  signals: {
    complete: true,
    validUntil: Date.now() + 600_000,
    activity: [],
    waits: [],
    failures: [],
    postponement: null,
  },
};

describe("work of chats a chat launched or parents", () => {
  it("records the calling chat as the launcher of a chat it creates", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: launcher,
      } = seedThreadFixture(harness);

      const create = async (headers: Record<string, string>) => {
        const response = await harness.app.request("/api/v1/threads", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({
            origin: "cli",
            projectId: project.id,
            providerId: "codex",
            model: "gpt-5",
            input: [{ type: "text", text: "Execute the plan" }],
            environment: { type: "reuse", environmentId: environment.id },
          }),
        });

        expect(response.status).toBe(201);
        const { id } = threadSchema.parse(await response.json());

        return getThread(harness.db, id)?.launchedByThreadId;
      };

      expect(await create({ [INBOX_CALLER_THREAD_HEADER]: launcher.id })).toBe(
        launcher.id,
      );
      expect(
        await create({ [INBOX_CALLER_THREAD_HEADER]: "thr_unknown000" }),
      ).toBeNull();
      expect(await create({})).toBeNull();
    });
  });

  it("keeps a launcher out of Ready to archive while a chat it launched still works", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: launcher,
      } = seedThreadFixture(harness);

      await seedAssessedTurn(harness, launcher.id);
      expect((await read(harness, launcher.id)).primary.label).toBe(
        "ready-to-archive",
      );

      const launched = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Execute the plan",
        launchedByThreadId: launcher.id,
      });

      expect(
        (await publish(harness, launched.id, "release:1", activeSignals))
          .status,
      ).toBe(200);

      const held = await read(harness, launcher.id);
      expect(held.primary.label).toBe("working");
      expect(held.archive).toMatchObject({
        eligible: false,
        recommended: false,
      });
      expect(held.activity).toContainEqual(
        expect.objectContaining({
          id: launched.id,
          phase: "running",
          actor: { kind: "thread", id: launched.id, label: "Execute the plan" },
        }),
      );

      expect(
        (await publish(harness, launched.id, "release:1", settledSignals))
          .status,
      ).toBe(200);
      expect((await read(harness, launcher.id)).primary.label).toBe(
        "ready-to-archive",
      );
    });
  });

  it("waits on a visible child that needs recovery but not on a failed hidden worker", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: parent,
      } = seedThreadFixture(harness);

      await seedAssessedTurn(harness, parent.id);

      seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "error",
        visibility: "hidden",
        lifecycleOwnerThreadId: parent.id,
        title: "Hidden worker",
      });
      expect((await read(harness, parent.id)).primary.label).toBe(
        "ready-to-archive",
      );

      const child = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "error",
        parentThreadId: parent.id,
        title: "Child chat",
      });

      const held = await read(harness, parent.id);
      expect(held.primary.label).toBe("waiting");
      expect(held.experimental_ownState).toMatchObject({
        primary: { label: "ready-to-archive" },
        hasActivity: false,
      });
      expect(held.waits).toContainEqual(
        expect.objectContaining({
          id: child.id,
          actor: { kind: "thread", id: child.id, label: "Child chat" },
        }),
      );
    });
  });

  it("rolls a grandchild's work up through an idle launched chat and notifies each launcher", async () => {
    await withTestHarness(async (harness) => {
      const { project, environment, thread: root } = seedThreadFixture(harness);
      await seedAssessedTurn(harness, root.id);

      const middle = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Middle",
        launchedByThreadId: root.id,
      });

      const leaf = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Leaf",
        launchedByThreadId: middle.id,
      });

      const notified = new Set<string>();

      const unsubscribe = harness.hub.onChangedMessage((message) => {
        if (
          message.entity === "thread" &&
          message.changes.includes("work-changed")
        )
          notified.add(message.id);
      });

      try {
        expect(
          (await publish(harness, leaf.id, "release:1", activeSignals)).status,
        ).toBe(200);
      } finally {
        unsubscribe();
      }

      expect([...notified].sort()).toEqual(
        [leaf.id, middle.id, root.id].sort(),
      );

      const rootWork = await read(harness, root.id);
      expect(rootWork.primary.label).toBe("working");
      expect(rootWork.experimental_ownState).toMatchObject({
        primary: { label: "ready-to-archive" },
        hasActivity: false,
      });
      expect(rootWork.activity).toContainEqual(
        expect.objectContaining({ id: middle.id }),
      );
    });
  });

  it("settles work across a launch cycle", async () => {
    await withTestHarness(async (harness) => {
      const {
        project,
        environment,
        thread: first,
      } = seedThreadFixture(harness);

      const second = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        title: "Second",
        launchedByThreadId: first.id,
      });

      harness.db
        .update(threads)
        .set({ launchedByThreadId: second.id })
        .where(eq(threads.id, first.id))
        .run();

      expect(
        (await publish(harness, second.id, "release:1", activeSignals)).status,
      ).toBe(200);
      expect((await read(harness, first.id)).primary.label).toBe("working");
      expect((await read(harness, second.id)).primary.label).toBe("working");
    });
  });
});

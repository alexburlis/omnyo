import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  getLastStoredTurnRequestEvent,
  getThread,
  listQueuedThreadMessages,
  readStoredThreadWork,
  threadFailures,
  threadOwnerInputs,
  threadReceipts,
} from "@omnyo/db";
import {
  threadWorkSummarySchema,
  turnScope,
  type Thread,
  type ThreadWorkSummary,
} from "@omnyo/domain";
import type { PluginThreadEventPayloads } from "@omnyo/plugin-sdk";
import { insertOwnerInput } from "../../../src/services/inbox/store.js";
import { setPluginThreadEventEmitter } from "../../../src/services/plugins/plugin-thread-events.js";
import { compactThreadContext } from "../../../src/services/threads/dispatch-attempt.js";
import {
  activeMaintenanceKind,
  getLatestMaintenanceRequest,
  readAutoCompactionMetadata,
} from "../../../src/services/threads/maintenance-run.js";
import { parseStoredTurnRequestEvent } from "../../../src/services/threads/thread-events.js";
import { reconcileDaemonReportedThreads } from "../../../src/services/threads/thread-lifecycle.js";
import { disconnectImportedDaemonSessions } from "../../../src/internal/session-owner-side-effects.js";
import {
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../../helpers/commands.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";
import {
  endTurn,
  ownerRequest,
  ownerSend,
  postDaemonEvents,
  seedChat,
  seedInboxWorld,
  startSubmittedTurn,
  type InboxWorld,
  type RunningTurn,
} from "../../inbox/inbox-driver.js";

function requireThread(harness: TestAppHarness, threadId: string): Thread {
  const thread = getThread(harness.db, threadId);

  if (thread === null) throw new Error(`Expected thread ${threadId}`);

  return thread;
}

function lastRequest(harness: TestAppHarness, threadId: string) {
  const row = getLastStoredTurnRequestEvent(harness.db, threadId);

  if (row === null) throw new Error("Expected a stored turn request");

  return { sequence: row.sequence, data: parseStoredTurnRequestEvent(row) };
}

async function ownerTurn(world: InboxWorld, threadId: string): Promise<void> {
  await ownerSend(world, threadId, "Please fix the overlap");
  const turn = await startSubmittedTurn(world, threadId);
  await endTurn(world, turn, "completed");
}

async function startMaintenance(
  world: InboxWorld,
  threadId: string,
): Promise<void> {
  const { execution } = lastRequest(world.harness, threadId).data;

  await compactThreadContext(
    world.harness.deps,
    requireThread(world.harness, threadId),
    {
      maintenance: "auto-compaction",
      execution: {
        model: execution.model,
        reasoningLevel: execution.reasoningLevel,
        serviceTier: execution.serviceTier,
      },
    },
  );
}

async function runMaintenance(
  world: InboxWorld,
  threadId: string,
): Promise<RunningTurn> {
  await startMaintenance(world, threadId);

  return startSubmittedTurn(world, threadId);
}

async function postCompactionUsage(
  world: InboxWorld,
  turn: RunningTurn,
): Promise<void> {
  const usage = {
    totalTokens: 24_500,
    inputTokens: 1_000,
    cachedInputTokens: 19_000,
    cacheReadInputTokens: 18_000,
    cacheWriteInputTokens: 1_000,
    outputTokens: 4_500,
    reasoningOutputTokens: 0,
  };

  await postDaemonEvents(world, [
    {
      threadId: turn.threadId,
      event: {
        type: "thread/tokenUsage/updated",
        threadId: turn.threadId,
        providerThreadId: `provider-${turn.threadId}`,
        scope: turnScope(turn.turnId),
        tokenUsage: {
          total: usage,
          last: usage,
          modelContextWindow: 1_000_000,
          promptCacheTtlMs: 3_600_000,
        },
      },
    },
  ]);
}

async function readWork(
  world: InboxWorld,
  threadId: string,
): Promise<ThreadWorkSummary> {
  const response = await world.harness.app.request(
    `/api/v1/threads/${threadId}/work`,
  );

  expect(response.status).toBe(200);

  return threadWorkSummarySchema.parse(await response.json());
}

function ownerVisibleState(harness: TestAppHarness, threadId: string) {
  const thread = requireThread(harness, threadId);

  return {
    lastReadAt: thread.lastReadAt,
    latestAttentionAt: thread.latestAttentionAt,
    receipts: harness.db
      .select()
      .from(threadReceipts)
      .where(eq(threadReceipts.threadId, threadId))
      .all(),
    ownerInputs: harness.db
      .select()
      .from(threadOwnerInputs)
      .where(eq(threadOwnerInputs.threadId, threadId))
      .all(),
    failures: harness.db
      .select()
      .from(threadFailures)
      .where(eq(threadFailures.threadId, threadId))
      .all(),
    obligationRevision: readStoredThreadWork(harness.db, [threadId]).get(
      threadId,
    )?.obligationRevision,
  };
}

async function publishTidyWork(
  world: InboxWorld,
  threadId: string,
  kind: "external" | "postponed",
): Promise<void> {
  if (kind === "postponed") {
    const signals = await ownerRequest(world, `/threads/${threadId}/work`, {
      pluginId: "tidy",
      contribution: {
        kind: "signals",
        signals: {
          complete: true,
          validUntil: Date.now() + 3_600_000,
          activity: [],
          waits: [],
          failures: [],
          postponement: {
            reason: "Not ready yet",
            until: null,
            resumeActor: { kind: "user", id: null, label: "You" },
          },
        },
      },
    });

    expect(signals.status).toBe(200);
  }

  const { basis } = await readWork(world, threadId);

  const assessment = await ownerRequest(world, `/threads/${threadId}/work`, {
    pluginId: "tidy",
    contribution: {
      kind: "assessment",
      assessment: {
        basis,
        contractVersion: 1,
        availability: "available",
        reason: "Assessed the latest turn.",
        sourceSeq: null,
        text: "Ship the overlap fix.",
        noSuggestionReason: null,
        waitingOn: kind === "external" ? "the design review" : null,
        archiveReady: false,
      },
    },
  });

  expect(assessment.status).toBe(200);
}

type RecordedEvent =
  | {
      name: "maintenance";
      thread: string;
      phase: string;
      outcome: string | null;
      kind: string | null;
    }
  | { name: string; thread: string };

function recordPluginEvents(harness: TestAppHarness) {
  const recorded: RecordedEvent[] = [];

  const named =
    (name: string) =>
    (thread: Thread): void => {
      recorded.push({ name, thread: thread.id });
    };

  setPluginThreadEventEmitter({
    emitThreadEvents: (threadId) => {
      recorded.push({ name: "experimental_thread.events", thread: threadId });
    },
    emitTerminalInput: () => {},
    emitHostDeleted: () => {},
    emitEnvironmentRemoved: () => {},
    emitThreadCreated: named("thread.created"),
    emitThreadActive: named("thread.active"),
    emitThreadIdle: named("thread.idle"),
    emitThreadFailed: named("thread.failed"),
    emitThreadArchived: named("thread.archived"),
    emitThreadUnarchived: named("thread.unarchived"),
    emitThreadParentChanged: named("experimental_thread.parentChanged"),
    emitThreadMaintenance: (
      thread,
      phase: PluginThreadEventPayloads["experimental_thread.maintenance"]["phase"],
      outcome,
    ) => {
      recorded.push({
        name: "maintenance",
        thread: thread.id,
        phase,
        outcome,
        kind: activeMaintenanceKind(harness.db, thread),
      });
    },
    emitThreadDeleted: named("thread.deleted"),
    emitMessageQueued: () => {},
    emitMessageDispatched: () => {},
    emitMessageCancelled: () => {},
    emitInteractionPending: named("interaction.pending"),
    emitTurnFailed: (threadId) => {
      recorded.push({ name: "turn.failed", thread: threadId });
    },
  });

  return recorded;
}

describe("silent maintenance compaction runs", () => {
  it.each(["external", "postponed"] as const)(
    "leaves read state, attention, receipts, owner inputs and readiness unchanged for a chat that is %s",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const world = seedInboxWorld(harness, `host-maintenance-${kind}`);
        const chat = seedChat(world);

        await ownerTurn(world, chat.id);
        insertOwnerInput(harness.db, {
          threadId: chat.id,
          kind: "message",
          state: "owed",
          requestId: null,
          queuedMessageId: null,
          now: Date.now(),
        });
        await publishTidyWork(world, chat.id, kind);

        const before = ownerVisibleState(harness, chat.id);
        const workBefore = await readWork(world, chat.id);

        expect(workBefore.primary.label).toBe(
          kind === "external" ? "external" : "open",
        );
        expect(workBefore.postponement?.reason ?? null).toBe(
          kind === "postponed" ? "Not ready yet" : null,
        );
        expect(workBefore.assessment.availability).toBe("available");
        expect(workBefore.assessment.suggestion).toBe("available");
        expect(before.receipts).toHaveLength(1);
        expect(
          before.ownerInputs.filter((input) => input.state === "owed"),
        ).toHaveLength(1);

        const turn = await runMaintenance(world, chat.id);

        expect(requireThread(harness, chat.id).status).toBe("active");
        expect(ownerVisibleState(harness, chat.id)).toEqual(before);

        await postCompactionUsage(world, turn);
        await endTurn(world, turn, "completed");

        expect(requireThread(harness, chat.id).status).toBe("idle");
        expect(ownerVisibleState(harness, chat.id)).toEqual(before);
        expect(await readWork(world, chat.id)).toEqual(workBefore);
        expect(lastRequest(harness, chat.id).data).toMatchObject({
          initiator: "system",
          maintenance: "auto-compaction",
        });
        expect(
          readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
        ).toEqual({
          requestSequence: lastRequest(harness, chat.id).sequence,
          state: "done",
          reason: null,
          cacheReadShare: 0.9,
          at: expect.any(String),
        });
      });
    },
  );

  it("records the cache-read share from usage that arrives after the run ended", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-late-usage");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const turn = await runMaintenance(world, chat.id);
      await endTurn(world, turn, "completed");

      expect(
        readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
      ).toMatchObject({ state: "done", cacheReadShare: null });

      await postCompactionUsage(world, turn);

      expect(
        readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
      ).toMatchObject({ state: "done", cacheReadShare: 0.9 });
    });
  });

  it("lets the owner's send win when it lands before the compaction appends", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-superseded");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const stale = requireThread(harness, chat.id);
      const eligibleSequence = lastRequest(harness, chat.id).sequence;
      const { execution } = lastRequest(harness, chat.id).data;

      await ownerSend(world, chat.id, "One more change");

      await expect(
        compactThreadContext(harness.deps, stale, {
          maintenance: "auto-compaction",
          execution: {
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            serviceTier: execution.serviceTier,
          },
          beforeAppendInTransaction: ({ tx }) => {
            const latest = getLastStoredTurnRequestEvent(tx, chat.id);

            if (latest?.sequence !== eligibleSequence)
              throw new Error("superseded");
          },
        }),
      ).rejects.toThrow("superseded");

      const turn = await startSubmittedTurn(world, chat.id);

      expect(getLatestMaintenanceRequest(harness.db, chat.id)).toBeNull();
      expect(lastRequest(harness, chat.id).data.initiator).toBe("user");

      await endTurn(world, turn, "completed");

      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, chat.id))
          .all(),
      ).toHaveLength(2);
    });
  });

  it("queues an owner send during the compaction and drains it afterwards", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-queued-send");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const compaction = await runMaintenance(world, chat.id);

      const revisionBefore = ownerVisibleState(
        harness,
        chat.id,
      ).obligationRevision;

      await ownerSend(world, chat.id, "Continue after compacting");

      const [queued] = listQueuedThreadMessages(harness.db, chat.id);

      expect(JSON.parse(queued?.waitingOn ?? "null")).toMatchObject({
        kind: "thread-busy",
      });
      expect(
        ownerVisibleState(harness, chat.id).obligationRevision,
      ).toBeGreaterThan(revisionBefore ?? 0);

      await endTurn(world, compaction, "completed");

      const ownerFollowUp = await startSubmittedTurn(world, chat.id);

      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(lastRequest(harness, chat.id).data).toMatchObject({
        initiator: "user",
      });
      expect(lastRequest(harness, chat.id).data.maintenance).toBeUndefined();

      await endTurn(world, ownerFollowUp, "completed");

      expect(
        harness.db
          .select()
          .from(threadReceipts)
          .where(eq(threadReceipts.threadId, chat.id))
          .all(),
      ).toHaveLength(2);
    });
  });

  it("ends a failed compaction idle without a failure receipt and refuses its retry", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-failed");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const before = ownerVisibleState(harness, chat.id);
      const turn = await runMaintenance(world, chat.id);

      await endTurn(world, turn, "failed");

      expect(requireThread(harness, chat.id).status).toBe("idle");
      expect(ownerVisibleState(harness, chat.id)).toEqual(before);
      expect(
        readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
      ).toMatchObject({
        state: "failed",
        reason: "Provider overloaded",
        cacheReadShare: null,
      });

      const retry = await ownerRequest(world, `/threads/${chat.id}/retry`, {});

      expect(retry.status).toBe(409);
      expect(await retry.json()).toMatchObject({
        code: "maintenance_not_retryable",
      });
    });
  });

  it.each(["owner stop", "server restart", "host disconnect"] as const)(
    "ends a compaction interrupted by %s idle as stopped",
    async (interruption) => {
      await withTestHarness(async (harness) => {
        const hostId = `host-maintenance-${interruption.replace(" ", "-")}`;
        const world = seedInboxWorld(harness, hostId);
        const chat = seedChat(world);

        await ownerTurn(world, chat.id);
        const before = ownerVisibleState(harness, chat.id);
        const turn = await runMaintenance(world, chat.id);

        if (interruption === "owner stop") {
          const response = harness.app.request(
            `/api/v1/threads/${chat.id}/stop`,
            { method: "POST" },
          );

          const stop = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.stop" && command.threadId === chat.id,
          );

          await reportQueuedCommandSuccess(harness, stop, {
            providerCheckpointId: null,
          });
          await endTurn(world, turn, "interrupted");
          expect((await response).status).toBe(200);
        } else if (interruption === "server restart") {
          await reconcileDaemonReportedThreads(harness.deps, {
            activeThreadIds: [],
            hostId,
            sameDaemonInstance: false,
            undeliveredEventThreadIds: [],
          });
        } else {
          disconnectImportedDaemonSessions(harness.deps, {
            sessions: [{ hostId, id: world.sessionId }],
          });
        }

        expect(requireThread(harness, chat.id).status).toBe("idle");
        expect(ownerVisibleState(harness, chat.id)).toEqual(before);
        expect(
          readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
        ).toMatchObject({ state: "stopped" });
        expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      });
    },
  );

  it("emits maintenance plugin events instead of the lifecycle events", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-events");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const recorded = recordPluginEvents(harness);

      try {
        const turn = await runMaintenance(world, chat.id);

        expect(recorded.filter((event) => event.thread === chat.id)).toEqual([
          {
            name: "maintenance",
            thread: chat.id,
            phase: "started",
            outcome: null,
            kind: "auto-compaction",
          },
        ]);

        await endTurn(world, turn, "completed");

        const failing = await runMaintenance(world, chat.id);
        await endTurn(world, failing, "failed");

        await expect
          .poll(
            () =>
              recorded.some(
                (event) =>
                  event.thread === chat.id &&
                  event.name === "experimental_thread.events",
              ),
            { timeout: 3_000 },
          )
          .toBe(true);

        expect(
          recorded.filter(
            (event) =>
              event.thread === chat.id &&
              event.name !== "experimental_thread.events",
          ),
        ).toEqual([
          {
            name: "maintenance",
            thread: chat.id,
            phase: "started",
            outcome: null,
            kind: "auto-compaction",
          },
          {
            name: "maintenance",
            thread: chat.id,
            phase: "ended",
            outcome: "completed",
            kind: null,
          },
          {
            name: "maintenance",
            thread: chat.id,
            phase: "started",
            outcome: null,
            kind: "auto-compaction",
          },
          {
            name: "maintenance",
            thread: chat.id,
            phase: "ended",
            outcome: "failed",
            kind: null,
          },
        ]);

        await ownerTurn(world, chat.id);

        expect(
          recorded
            .filter(
              (event) =>
                event.thread === chat.id &&
                event.name !== "experimental_thread.events",
            )
            .slice(4)
            .map((event) => event.name),
        ).toEqual(["thread.active", "thread.idle"]);
      } finally {
        setPluginThreadEventEmitter(undefined);
      }
    });
  });

  it("treats a provider-started turn after a finished compaction as a normal run", async () => {
    await withTestHarness(async (harness) => {
      const world = seedInboxWorld(harness, "host-maintenance-provider-turn");
      const chat = seedChat(world);

      await ownerTurn(world, chat.id);
      const compaction = await runMaintenance(world, chat.id);
      await endTurn(world, compaction, "completed");

      const outcome = readAutoCompactionMetadata(
        harness.db,
        chat.id,
      ).lastOutcome;

      const receiptsBefore = ownerVisibleState(harness, chat.id).receipts;
      const recorded = recordPluginEvents(harness);

      try {
        world.turnCounter.value += 1;

        const turn: RunningTurn = {
          threadId: chat.id,
          turnId: `turn-${world.turnCounter.value}`,
        };

        await postDaemonEvents(world, [
          {
            threadId: chat.id,
            event: {
              type: "turn/started",
              threadId: chat.id,
              providerThreadId: `provider-${chat.id}`,
              scope: turnScope(turn.turnId),
            },
          },
        ]);

        expect(requireThread(harness, chat.id).status).toBe("active");
        expect(
          activeMaintenanceKind(harness.db, requireThread(harness, chat.id)),
        ).toBeNull();

        await endTurn(world, turn, "completed");

        expect(
          recorded
            .filter(
              (event) =>
                event.thread === chat.id &&
                event.name !== "experimental_thread.events",
            )
            .map((event) => event.name),
        ).toEqual(["thread.active", "thread.idle"]);
        expect(
          readAutoCompactionMetadata(harness.db, chat.id).lastOutcome,
        ).toEqual(outcome);
        expect(
          ownerVisibleState(harness, chat.id).receipts.length,
        ).toBeGreaterThan(receiptsBefore.length);
      } finally {
        setPluginThreadEventEmitter(undefined);
      }
    });
  });
});

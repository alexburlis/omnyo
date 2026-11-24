import {
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessage,
  getLastStoredTurnRequestEvent,
  getLatestThreadSequence,
  getThread,
  getQueuedThreadMessage,
  listQueuedThreadMessages,
  setQueuedThreadMessageWaitingOn,
  threadFailures,
} from "@omnyo/db";
import {
  encodeClientTurnRequestIdNumber,
  permissionModeSchema,
} from "@omnyo/domain";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runInboxSweep } from "../../src/services/inbox/sweep.js";
import { setPluginHookProvider } from "../../src/services/plugins/plugin-hook-registry.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { parseStoredTurnRequestEvent } from "../../src/services/threads/thread-events.js";
import { continueThread } from "../../src/services/threads/thread-continue.js";
import { parseStoredQueuedThreadMessageWaitingOn } from "../../src/services/threads/thread-queued-messages.js";
import {
  createThreadStartup,
  readThreadProvisionContext,
  saveThreadProvisionContext,
} from "../../src/services/threads/thread-startup-store.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import {
  endTurn,
  ownerSend,
  pendingSubmitCount,
  seedChat,
  seedInboxWorld,
  startSubmittedTurn,
} from "../inbox/inbox-driver.js";
import {
  seedEnvironment,
  seedEvent,
  seedHost,
  seedSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  CAPACITY_TEST_PLUGIN_ID,
  failuresOf,
  installCapacityHook,
  installDispatchHook,
  recheckDispatchHooks,
  seedFailedTurn,
} from "../helpers/dispatch-capacity.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const stateSchema = z.object({
  threadId: z.string(),
  available: z.boolean(),
  pending: z.boolean(),
  action: z.string(),
  message: z.string().nullable(),
  cause: z.string().nullable(),
  retryAt: z.number().nullable(),
  canRetryNow: z.boolean(),
});

const resultSchema = z.object({
  threadId: z.string(),
  outcome: z.enum(["sent", "queued", "pending", "blocked"]),
  message: z.string().nullable(),
  queuedMessageId: z.string().nullable(),
});

afterEach(() => {
  setPluginHookProvider(undefined);
  vi.useRealTimers();
});

async function seedHeldUpdateContinuation(
  harness: TestAppHarness,
  hostId: string,
  kind: "continuation" | "retry" = "continuation",
) {
  const world = seedInboxWorld(harness, hostId);
  const chat = seedChat(world);

  const text =
    "Omnyo paused this turn to install an update. Please continue where you left off.";

  await ownerSend(world, chat.id, "Run the migration");
  const turn = await startSubmittedTurn(world, chat.id);
  const request = getLastStoredTurnRequestEvent(harness.db, chat.id);

  if (request === null) throw new Error("Expected a turn request");
  const { execution, requestId } = parseStoredTurnRequestEvent(request);

  const queue = () =>
    createQueuedThreadMessage(harness.db, harness.hub, {
      threadId: chat.id,
      content: [{ type: "text", text, mentions: [], visibility: "agent-only" }],
      model: execution.model,
      reasoningLevel: execution.reasoningLevel,
      permissionMode: permissionModeSchema.parse(execution.permissionMode),
      serviceTier: execution.serviceTier,
      waitingOn: null,
      sendAt: null,
      payload:
        kind === "continuation"
          ? { kind }
          : {
              kind,
              retryOfTurnRequestId: requestId,
              attempt: 2,
              reason: "Provider overloaded",
            },
      systemNotice: null,
      deliveryMode: "queue",
    });

  const early = kind === "continuation" ? queue() : null;

  await endTurn(world, turn, "failed");
  await runInboxSweep(harness.deps, Date.now() + 31_000);
  const continuation = early ?? queue();

  await runQueuedMessageDispatch(harness.deps, {
    kind: "idle-recovery",
    now: Date.now(),
  });

  expect(getThread(harness.db, chat.id)?.status).toBe("error");
  expect(
    harness.db
      .select({ state: threadFailures.state })
      .from(threadFailures)
      .where(eq(threadFailures.threadId, chat.id))
      .all(),
  ).toEqual([{ state: "actionable" }]);
  expect(
    listQueuedThreadMessages(harness.db, chat.id).map((row) => row.id),
  ).toEqual([continuation.id]);
  expect(pendingSubmitCount(world, chat.id)).toBe(0);

  return { world, chat, continuation, text };
}

function seedError(harness: TestAppHarness, id: string) {
  const host = seedHost(harness.deps, { id: `host-${id}` });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: "/tmp/continue-proof",
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/continue-proof",
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "error",
  });

  seedThreadRuntimeState(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: `provider-${id}`,
    inputText: "Preserve my task",
  });

  return { host, project, environment, thread };
}

function seedFailedStartup(
  harness: TestAppHarness,
  id: string,
  reason: string | null = null,
) {
  const host = seedHost(harness.deps, { id: `host-${id}` });

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/${id}`,
  });

  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: null,
    status: "starting",
  });

  saveThreadProvisionContext({
    db: harness.db,
    replace: true,
    threadId: thread.id,
    context: createThreadStartup({
      clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
      environmentIntent: {
        type: "provider",
        environmentProviderId: "personal-workspace",
        machine: { type: "existing", hostId: host.id },
        inputs: null,
        selectionResolved: true,
      },
      execution: {
        model: "gpt-5",
        reasoningLevel: "medium",
        serviceTier: "default",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      input: [{ type: "text", text: "Recover original startup", mentions: [] }],
      fork: null,
      seedWithoutRun: false,
      initiator: "user",
      titleProvided: true,
    }),
  });
  applyLoggedThreadLifecycleEvent(
    harness.deps,
    { threadId: thread.id, event: { type: "run.failed" } },
    reason === null ? undefined : { outcome: "failed", reason, summary: null },
  );

  return { host, thread };
}

interface ContinuePostBody {
  sendAt?: number;
}

function post(
  harness: TestAppHarness,
  path: string,
  body: ContinuePostBody = {},
) {
  return harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Continue public recovery", () => {
  it("explains the current failure and scheduled recovery without starting another turn", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedError(harness, "explanation");
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-explanation",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "provider/error",
        scope: { kind: "turn", turnId: "turn-explanation" },
        data: {
          providerThreadId: "provider-explanation",
          message: "Provider error",
          detail: "Selected model is at capacity.",
          willRetry: false,
          errorInfo: {
            category: "overloaded",
            providerCode: "serverOverloaded",
            httpStatusCode: null,
          },
        },
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-explanation",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn-explanation" },
        data: {
          providerThreadId: "provider-explanation",
          status: "failed",
          error: { message: "Provider error" },
        },
      });

      const read = async () => {
        const response = await harness.app.request(
          `/api/v1/threads/${thread.id}/continue`,
        );

        expect(response.status).toBe(200);

        return stateSchema.parse(await response.json());
      };

      expect(await read()).toMatchObject({
        pending: false,
        cause: expect.stringContaining("Selected model is at capacity."),
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      const sendAt = Date.now() + 60_000;
      expect(
        (await post(harness, `/threads/${thread.id}/retry`, { sendAt })).status,
      ).toBe(200);
      expect(await read()).toMatchObject({
        available: false,
        pending: true,
        canRetryNow: true,
        retryAt: sendAt,
      });
      expect((await read()).cause).toContain("Selected model is at capacity.");
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      const queued = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      setQueuedThreadMessageWaitingOn(harness.db, harness.hub, {
        id: queued.id,
        threadId: thread.id,
        waitingOn: { kind: "host-offline", hostName: "Test Mac" },
        sendAt,
      });
      expect(await read()).toMatchObject({
        pending: true,
        retryAt: null,
        message: expect.stringContaining("waiting for Test Mac to reconnect"),
      });
      expect(getQueuedThreadMessage(harness.db, queued.id)?.sendAt).toBe(
        sendAt,
      );

      setQueuedThreadMessageWaitingOn(harness.db, harness.hub, {
        id: queued.id,
        threadId: thread.id,
        waitingOn: {
          kind: "plugin",
          pluginId: CAPACITY_TEST_PLUGIN_ID,
          reason: "Waiting for a free worker slot",
        },
        sendAt,
      });
      expect(await read()).toMatchObject({
        pending: true,
        retryAt: sendAt,
        message: expect.stringContaining("Waiting for a free worker slot"),
      });

      setQueuedThreadMessageWaitingOn(harness.db, harness.hub, {
        id: queued.id,
        threadId: thread.id,
        waitingOn: { kind: "time" },
        sendAt,
      });
      expect(await read()).toMatchObject({ pending: true, retryAt: sendAt });
    });
  });

  it.each([false, true])(
    "replays only unaccepted input and keeps accepted input as a continuation: accepted=%s",
    async (accepted) => {
      await withTestHarness(async (harness) => {
        const { thread, environment } = seedError(
          harness,
          `accept-${accepted}`,
        );

        if (accepted)
          seedEvent(harness.deps, {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId: "provider-accepted",
            sequence:
              getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
            type: "turn/input/accepted",
            scope: { kind: "turn", turnId: "turn-accepted" },
            data: {
              providerThreadId: "provider-accepted",
              clientRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
            },
          });

        const state = await harness.app.request(
          `/api/v1/threads/${thread.id}/continue`,
        );

        expect(state.status).toBe(200);
        expect(stateSchema.parse(await state.json())).toMatchObject({
          available: true,
          pending: false,
          action: "retry",
        });
        const response = await post(harness, `/threads/${thread.id}/continue`);
        expect(response.status).toBe(200);
        expect(resultSchema.parse(await response.json()).outcome).toBe(
          "queued",
        );
        const queued = listQueuedThreadMessages(harness.db, thread.id);
        expect(queued).toHaveLength(1);
        expect(JSON.parse(queued[0]!.content)).toMatchObject([
          {
            text: accepted ? "Please continue." : "Preserve my task",
            visibility: "agent-only",
          },
        ]);
      });
    },
  );

  it("keeps missing startup facts visible and reports the refusal without writing work", async () => {
    await withTestHarness(async (harness) => {
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: seedHost(harness.deps, { id: "host-no-context" }).id,
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: null,
        status: "error",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/continue`,
      );

      expect(response.status).toBe(200);
      expect(stateSchema.parse(await response.json())).toMatchObject({
        available: true,
        pending: false,
        action: "unavailable",
        message: expect.any(String),
      });
      const continued = await post(harness, `/threads/${thread.id}/continue`);
      expect(continued.status).toBe(200);
      expect(resultSchema.parse(await continued.json())).toMatchObject({
        outcome: "blocked",
        message: expect.any(String),
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });

  it("recovers persisted startup intent before any dispatched turn without changing its machine or input", async () => {
    await withTestHarness(async (harness) => {
      const { host, thread } = seedFailedStartup(harness, "startup-continue");

      const state = await harness.app.request(
        `/api/v1/threads/${thread.id}/continue`,
      );

      expect(state.status).toBe(200);
      expect(stateSchema.parse(await state.json())).toMatchObject({
        available: true,
        action: "startup",
      });
      const response = await post(harness, `/threads/${thread.id}/continue`);
      expect(response.status).toBe(200);
      expect(resultSchema.parse(await response.json()).outcome).toBe("sent");
      const resumed = readThreadProvisionContext(harness.db, thread.id);
      expect(resumed?.request.environmentIntent).toMatchObject({
        machine: { type: "existing", hostId: host.id },
      });
      expect(resumed?.request.input).toMatchObject([
        { text: "Recover original startup", visibility: "agent-only" },
      ]);
      expect(resumed?.request.execution).toMatchObject({
        model: "gpt-5",
        reasoningLevel: "medium",
        serviceTier: "default",
        permissionMode: "full",
      });
    });
  });

  it("sends the same scheduled retry now with an explicitly selected model", async () => {
    await withTestHarness(async (harness) => {
      const { thread, host } = seedError(harness, "switch-model");
      seedSession(harness.deps, host.id);
      expect(
        (
          await post(harness, `/threads/${thread.id}/retry`, {
            sendAt: Date.now() + 60_000,
          })
        ).status,
      ).toBe(200);
      const original = listQueuedThreadMessages(harness.db, thread.id)[0]!;

      const responses = await Promise.all([
        post(harness, `/threads/${thread.id}/continue?now=true&model=gpt-5.4`),
        post(harness, `/threads/${thread.id}/continue?now=true&model=gpt-5.4`),
      ]);

      const results = await Promise.all(
        responses.map((response) => response.json()),
      );

      expect(
        results.filter((result) => result.outcome === "sent"),
      ).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      const event = getLastStoredTurnRequestEvent(harness.db, thread.id);
      expect(event).not.toBeNull();
      const request = parseStoredTurnRequestEvent(event!);
      expect(request.execution.model).toBe("gpt-5.4");
      expect(request.execution.permissionMode).toBe(original.permissionMode);
    });
  });

  it("leaves a claimed retry unchanged when an owner asks to switch models", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedError(harness, "claimed-model");
      await post(harness, `/threads/${thread.id}/retry`, {
        sendAt: Date.now() + 60_000,
      });
      const original = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      claimQueuedThreadMessageGroup(harness.db, harness.hub, original.id, {
        kind: "explicit-send",
      });

      const response = await post(
        harness,
        `/threads/${thread.id}/continue?now=true&model=gpt-5.4`,
      );

      expect(resultSchema.parse(await response.json()).outcome).toBe("pending");
      expect(getQueuedThreadMessage(harness.db, original.id)?.model).toBe(
        original.model,
      );
    });
  });

  it("preserves a queue claim acquired while a model switch validates", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedError(harness, "switch-claim-race");
      await post(harness, `/threads/${thread.id}/retry`, {
        sendAt: Date.now() + 60_000,
      });
      const original = listQueuedThreadMessages(harness.db, thread.id)[0]!;

      const continuing = continueThread(harness.deps, thread.id, {
        now: true,
        model: "gpt-5.4",
      });

      const claimed = claimQueuedThreadMessageGroup(
        harness.db,
        harness.hub,
        original.id,
        { kind: "explicit-send" },
      );

      expect(claimed).not.toBeNull();
      expect((await continuing).outcome).toBe("pending");
      expect(getQueuedThreadMessage(harness.db, original.id)?.model).toBe(
        original.model,
      );
    });
  });

  it("excludes scheduled and claimed retries from Continue and overlapping bulk dispatch", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedError(harness, "scheduled");

      const scheduled = await post(harness, `/threads/${thread.id}/retry`, {
        sendAt: Date.now() + 60_000,
      });

      expect(scheduled.status).toBe(200);
      const row = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      claimQueuedThreadMessageGroup(harness.db, harness.hub, row.id, {
        kind: "explicit-send",
      });

      const state = await harness.app.request(
        `/api/v1/threads/${thread.id}/continue`,
      );

      expect(state.status).toBe(200);
      expect(stateSchema.parse(await state.json())).toMatchObject({
        available: false,
        pending: true,
        retryAt: null,
        canRetryNow: false,
        message: "Recovery is starting.",
      });

      const results = await Promise.all([
        post(harness, `/threads/${thread.id}/continue`),
        post(harness, "/threads/continue-all"),
        post(harness, `/threads/${thread.id}/continue`),
      ]);

      expect(results.every((result) => result.status === 200)).toBe(true);
      expect(resultSchema.parse(await results[0]!.json()).outcome).toBe(
        "pending",
      );
      expect(resultSchema.parse(await results[2]!.json()).outcome).toBe(
        "pending",
      );
    });
  });

  it("admits at most one continuation when individual, automatic retry and bulk overlap", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedError(harness, "overlap");

      const responses = await Promise.all([
        post(harness, `/threads/${thread.id}/continue`),
        post(harness, "/threads/continue-all"),
        post(harness, `/threads/${thread.id}/retry`, {
          sendAt: Date.now() + 60_000,
        }),
        post(harness, `/threads/${thread.id}/continue`),
      ]);

      expect(responses[0]!.status).toBe(200);
      expect(responses[1]!.status).toBe(200);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    });
  });

  it("continues from a completed request instead of replaying completed work", async () => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = seedError(harness, "completed");
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        providerThreadId: "provider-completed",
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: { kind: "turn", turnId: "turn-completed" },
        data: { providerThreadId: "provider-completed", status: "completed" },
      });
      const response = await post(harness, `/threads/${thread.id}/continue`);
      expect(response.status).toBe(200);
      expect(resultSchema.parse(await response.json()).outcome).toBe("queued");
      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);
      expect(JSON.parse(queued[0]!.content)).toMatchObject([
        { text: "Please continue.", visibility: "agent-only" },
      ]);
      expect(queued[0]!.payloadKind).toBe("continuation");
    });
  });

  it("sends an update continuation held by the failure pause exactly once", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat, text } = await seedHeldUpdateContinuation(
        harness,
        "host-continue-paused",
      );

      const state = await harness.app.request(
        `/api/v1/threads/${chat.id}/continue`,
      );

      expect(state.status).toBe(200);
      expect(stateSchema.parse(await state.json())).toMatchObject({
        available: true,
        pending: false,
      });

      const first = await post(harness, `/threads/${chat.id}/continue`);

      expect(first.status).toBe(200);
      expect(resultSchema.parse(await first.json()).outcome).toBe("sent");
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
      const sent = getLastStoredTurnRequestEvent(harness.db, chat.id);

      if (sent === null) throw new Error("Expected the continuation request");
      expect(parseStoredTurnRequestEvent(sent).input).toMatchObject([
        { text, visibility: "agent-only" },
      ]);
      expect(
        harness.db
          .select({
            state: threadFailures.state,
            resolvedBy: threadFailures.resolvedBy,
          })
          .from(threadFailures)
          .where(eq(threadFailures.threadId, chat.id))
          .all(),
      ).toEqual([{ state: "resolved", resolvedBy: "owner" }]);

      const second = await post(harness, `/threads/${chat.id}/continue`);

      expect(second.status).toBe(200);
      expect(resultSchema.parse(await second.json()).outcome).toBe("blocked");
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
    });
  });

  it("lets the owner continue a retry held by the failure pause through the automatic drain", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedHeldUpdateContinuation(
        harness,
        "host-continue-retry",
        "retry",
      );

      const state = await harness.app.request(
        `/api/v1/threads/${chat.id}/continue`,
      );

      expect(stateSchema.parse(await state.json())).toMatchObject({
        available: true,
        pending: false,
        action: "retry-queued",
      });

      const first = await post(harness, `/threads/${chat.id}/continue`);

      expect(first.status).toBe(200);
      expect(resultSchema.parse(await first.json()).outcome).toBe("sent");
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
      expect(
        harness.db
          .select({
            state: threadFailures.state,
            resolvedBy: threadFailures.resolvedBy,
          })
          .from(threadFailures)
          .where(eq(threadFailures.threadId, chat.id))
          .all(),
      ).toEqual([{ state: "resolved", resolvedBy: "retry" }]);
    });
  });

  it("lets a dispatch hook hold Continue on a continuation held by the failure pause", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat, continuation, text } =
        await seedHeldUpdateContinuation(harness, "host-continue-capacity");

      const attempts: string[] = [];
      let capacity: "full" | "free" = "full";

      installDispatchHook((context) => {
        attempts.push(context.attempt);

        return capacity === "full"
          ? { action: "wait", reason: "14 of 14 running on host Mac Pro" }
          : { action: "proceed" };
      });

      const first = await post(harness, `/threads/${chat.id}/continue`);

      expect(first.status).toBe(200);
      expect(resultSchema.parse(await first.json())).toMatchObject({
        outcome: "queued",
        queuedMessageId: continuation.id,
      });
      expect(attempts).toEqual(["start-turn"]);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      const held = listQueuedThreadMessages(harness.db, chat.id);

      expect(held.map((row) => row.id)).toEqual([continuation.id]);
      expect(parseStoredQueuedThreadMessageWaitingOn(held[0]!)).toMatchObject({
        kind: "plugin",
        pluginId: CAPACITY_TEST_PLUGIN_ID,
      });
      expect(
        harness.db
          .select({
            state: threadFailures.state,
            resolvedBy: threadFailures.resolvedBy,
          })
          .from(threadFailures)
          .where(eq(threadFailures.threadId, chat.id))
          .all(),
      ).toEqual([{ state: "resolved", resolvedBy: "owner" }]);

      const state = await harness.app.request(
        `/api/v1/threads/${chat.id}/continue`,
      );

      expect(stateSchema.parse(await state.json())).toMatchObject({
        available: false,
        pending: true,
      });

      const again = await post(harness, `/threads/${chat.id}/continue`);

      expect(resultSchema.parse(await again.json()).outcome).toBe("pending");
      expect(attempts).toEqual(["start-turn"]);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);

      capacity = "free";
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 1_001);
      await runQueuedMessageDispatch(harness.deps, { kind: "plugin-recheck" });

      expect(attempts).toEqual(["start-turn", "start-turn"]);

      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(1);
      const sent = getLastStoredTurnRequestEvent(harness.db, chat.id);

      if (sent === null) throw new Error("Expected the continuation request");
      expect(parseStoredTurnRequestEvent(sent).input).toMatchObject([
        { text, visibility: "agent-only" },
      ]);
    });
  });

  it("releases the failure pause when a dispatch hook holds a startup Continue and starts it once capacity frees", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedFailedStartup(
        harness,
        "startup-capacity",
        "Unscoped plugin work prevents workspace identity preparation",
      );

      await runInboxSweep(harness.deps, Date.now() + 31_000);
      expect(getThread(harness.db, thread.id)?.status).toBe("error");
      expect(failuresOf(harness, thread.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
      const { attempts, capacity } = installCapacityHook();
      const first = await post(harness, `/threads/${thread.id}/continue`);

      expect(first.status).toBe(200);
      const queued = resultSchema.parse(await first.json());

      expect(queued).toMatchObject({
        outcome: "queued",
        queuedMessageId: expect.any(String),
      });
      expect(attempts).toEqual(["start-turn"]);
      const held = listQueuedThreadMessages(harness.db, thread.id);

      expect(held.map((row) => row.id)).toEqual([queued.queuedMessageId]);
      expect(held[0]!.payloadKind).toBe("continuation");
      expect(parseStoredQueuedThreadMessageWaitingOn(held[0]!)).toMatchObject({
        kind: "plugin",
        pluginId: CAPACITY_TEST_PLUGIN_ID,
      });

      await recheckDispatchHooks(harness);

      expect(attempts).toEqual(["start-turn", "start-turn"]);
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([queued.queuedMessageId]);

      const again = await post(harness, `/threads/${thread.id}/continue`);

      expect(resultSchema.parse(await again.json())).toMatchObject({
        outcome: "pending",
        queuedMessageId: queued.queuedMessageId,
      });
      expect(attempts).toHaveLength(2);

      capacity.free = true;
      await recheckDispatchHooks(harness);

      expect(attempts).toEqual(["start-turn", "start-turn", "start-turn"]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(getThread(harness.db, thread.id)?.status).not.toBe("error");
      expect(failuresOf(harness, thread.id)).toEqual([
        { state: "resolved", resolvedBy: "owner" },
      ]);
      expect(
        readThreadProvisionContext(harness.db, thread.id)?.request.input,
      ).toMatchObject([
        { text: "Recover original startup", visibility: "agent-only" },
      ]);

      const last = await post(harness, `/threads/${thread.id}/continue`);

      expect(["pending", "blocked"]).toContain(
        resultSchema.parse(await last.json()).outcome,
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(attempts).toHaveLength(3);
    });
  });

  it.each(["retry", "continue"] as const)(
    "sends a failed-turn %s Continue held by a dispatch hook exactly once after capacity frees",
    async (action) => {
      await withTestHarness(async (harness) => {
        const { world, chat } = await seedFailedTurn(
          harness,
          `host-capacity-${action}`,
          action,
        );

        const state = await harness.app.request(
          `/api/v1/threads/${chat.id}/continue`,
        );

        expect(stateSchema.parse(await state.json())).toMatchObject({
          available: true,
          action,
        });
        const { attempts, capacity } = installCapacityHook();
        const first = await post(harness, `/threads/${chat.id}/continue`);

        expect(first.status).toBe(200);
        const queued = resultSchema.parse(await first.json());

        expect(queued).toMatchObject({
          outcome: "queued",
          queuedMessageId: expect.any(String),
        });
        expect(attempts).toEqual(["start-turn"]);
        const held = listQueuedThreadMessages(harness.db, chat.id);

        expect(held.map((row) => row.id)).toEqual([queued.queuedMessageId]);
        expect(held[0]!.payloadKind).toBe(
          action === "retry" ? "retry" : "continuation",
        );
        expect(parseStoredQueuedThreadMessageWaitingOn(held[0]!)).toMatchObject(
          { kind: "plugin" },
        );

        await recheckDispatchHooks(harness);

        expect(attempts).toEqual(["start-turn", "start-turn"]);
        expect(pendingSubmitCount(world, chat.id)).toBe(0);

        const again = await post(harness, `/threads/${chat.id}/continue`);

        expect(resultSchema.parse(await again.json())).toMatchObject({
          outcome: "pending",
          queuedMessageId: queued.queuedMessageId,
        });
        expect(
          listQueuedThreadMessages(harness.db, chat.id).map((row) => row.id),
        ).toEqual([queued.queuedMessageId]);

        capacity.free = true;
        await recheckDispatchHooks(harness);

        expect(attempts).toEqual(["start-turn", "start-turn", "start-turn"]);
        expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
        expect(pendingSubmitCount(world, chat.id)).toBe(1);
        expect(failuresOf(harness, chat.id)).toEqual([
          {
            state: "resolved",
            resolvedBy: action === "retry" ? "retry" : "owner",
          },
        ]);

        const last = await post(harness, `/threads/${chat.id}/continue`);

        expect(["pending", "blocked"]).toContain(
          resultSchema.parse(await last.json()).outcome,
        );
        expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
        expect(pendingSubmitCount(world, chat.id)).toBe(1);
      });
    },
  );

  it("keeps the failure for the owner when a dispatch hook refuses Continue", async () => {
    await withTestHarness(async (harness) => {
      const { world, chat } = await seedFailedTurn(
        harness,
        "host-capacity-refused",
        "continue",
      );

      installDispatchHook(() => ({
        action: "reject",
        message: "Capacity is closed",
      }));

      const refused = await post(harness, `/threads/${chat.id}/continue`);

      expect(resultSchema.parse(await refused.json())).toMatchObject({
        outcome: "blocked",
        message: "Capacity is closed",
      });
      expect(listQueuedThreadMessages(harness.db, chat.id)).toHaveLength(0);
      expect(pendingSubmitCount(world, chat.id)).toBe(0);
      expect(failuresOf(harness, chat.id)).toEqual([
        { state: "actionable", resolvedBy: null },
      ]);
    });
  });

  it("keeps a destroyed workspace without a restore provider visible and refuses without work", async () => {
    await withTestHarness(async (harness) => {
      const host = seedHost(harness.deps, { id: "host-destroyed-continue" });

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: "/tmp/continue-destroyed",
        status: "destroyed",
      });

      const thread = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
        status: "error",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/continue`,
      );

      expect(response.status).toBe(200);
      expect(stateSchema.parse(await response.json())).toMatchObject({
        available: true,
        action: "unavailable",
        message: expect.any(String),
      });
      const continued = await post(harness, `/threads/${thread.id}/continue`);
      expect(resultSchema.parse(await continued.json())).toMatchObject({
        outcome: "blocked",
        message: expect.any(String),
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  });
});

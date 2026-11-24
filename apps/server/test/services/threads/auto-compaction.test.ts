import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import {
  getLatestThreadSequence,
  getThread,
  getThreadConversationSequences,
  pendingInteractions,
  setExperiments,
  threadFailures,
  threadProducers,
  threads,
} from "@omnyo/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  encodeClientTurnRequestIdNumber,
  threadScope,
  threadWorkSummarySchema,
  turnScope,
  type ProviderRateLimitState,
  type Thread,
} from "@omnyo/domain";
import {
  createAutoCompactionSweep,
  getAutoCompactionState,
  withAutoCompactionAt,
} from "../../../src/services/threads/auto-compaction.js";
import { readThreadContextWindowUsage } from "../../../src/services/threads/context-window-usage.js";
import {
  readAutoCompactionMetadata,
  writeAutoCompactionMetadata,
} from "../../../src/services/threads/maintenance-run.js";
import {
  reserveHostUpdateDrain,
  setServerUpdateDraining,
} from "../../../src/services/system/server-update-drain.js";
import { stubHostArtifact } from "../../helpers/provider-registry.js";
import {
  seedChatCompletionReport,
  seedEnvironment,
  seedHost,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedStoredEvent,
  seedThread,
} from "../../helpers/seed.js";
import {
  withTestHarness,
  type TestAppHarness,
} from "../../helpers/test-app.js";

const MINUTE = 60_000;

const MODEL = "claude-opus-4-5";

interface World {
  harness: TestAppHarness;
  hostId: string;
  projectId: string;
  environmentId: string;
}

interface ChatArgs {
  anchorAt: number;
  contextTokens?: number;
  environmentId?: string;
  providerId?: string;
  ttlMs?: number | null;
  status?: Thread["status"];
  visibility?: Thread["visibility"];
  parentThreadId?: string;
  launchedByThreadId?: string;
  originPluginId?: string;
  retryAfterOwnerTurn?: boolean;
  latestRequest?: "manual-compaction" | "auto-compaction";
  latestRequestSource?: "plugin";
  zeroUsageAfterMs?: number;
  rateLimits?: ProviderRateLimitState;
}

function seedWorld(harness: TestAppHarness, hostId: string): World {
  const { host } = seedHostSession(harness.deps, { id: hostId });

  for (const providerId of ["claude-code", "codex"]) {
    const registration = harness.deps.providerRegistry.get(providerId);

    if (registration === null) throw new Error(`${providerId} is missing`);
    harness.deps.pluginHostArtifacts.set(
      registration.pluginId,
      stubHostArtifact(registration.pluginId),
    );
  }

  const path = `/tmp/auto-compaction-${hostId}`;

  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path,
  });

  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
    status: "ready",
  });

  return {
    harness,
    hostId: host.id,
    projectId: project.id,
    environmentId: environment.id,
  };
}

function requestData(args: {
  requestNumber: number;
  initiator: "user" | "system";
  input?: unknown;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    direction: "outbound",
    requestId: encodeClientTurnRequestIdNumber({ value: args.requestNumber }),
    input: args.input ?? [{ type: "text", text: "Fix the overlap" }],
    target: { kind: "new-turn" },
    execution: {
      model: MODEL,
      serviceTier: "default",
      reasoningLevel: "high",
      permissionMode: "full",
      source: "client/turn/requested",
    },
    initiator: args.initiator,
    senderThreadId: null,
    request: { method: "turn/start", params: {} },
    source: "tell",
    ...args.extra,
  };
}

function seedChat(world: World, args: ChatArgs): Thread {
  const { harness } = world;
  const environmentId = args.environmentId ?? world.environmentId;

  const thread = seedThread(harness.deps, {
    projectId: world.projectId,
    environmentId,
    providerId: args.providerId ?? "claude-code",
    status: args.status ?? "idle",
    ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
    ...(args.parentThreadId !== undefined
      ? { parentThreadId: args.parentThreadId }
      : {}),
    ...(args.launchedByThreadId !== undefined
      ? { launchedByThreadId: args.launchedByThreadId }
      : {}),
    ...(args.originPluginId !== undefined
      ? { originPluginId: args.originPluginId }
      : {}),
  });

  const providerThreadId = `provider-${thread.id}`;
  let sequence = 0;

  const seed = (
    type: Parameters<typeof seedStoredEvent>[1]["type"],
    data: Record<string, unknown>,
    scope = threadScope(),
    createdAt = args.anchorAt - MINUTE,
  ) => {
    sequence += 1;
    seedStoredEvent(harness.deps, {
      threadId: thread.id,
      environmentId,
      providerThreadId,
      sequence,
      type,
      scope,
      data,
      createdAt,
    });
  };

  seed("thread/identity", {});
  seed(
    "client/turn/requested",
    requestData({
      requestNumber: 1,
      initiator: "user",
      ...(args.latestRequestSource === "plugin"
        ? {
            extra: {
              systemMessageKind: "external-message",
              systemMessageSubject: {
                kind: "message-source",
                source: { kind: "plugin", pluginId: "automations" },
              },
            },
          }
        : {}),
    }),
  );

  if (args.retryAfterOwnerTurn === true)
    seed(
      "client/turn/requested",
      requestData({
        requestNumber: 2,
        initiator: "system",
        extra: {
          retryOfRequestId: encodeClientTurnRequestIdNumber({ value: 1 }),
          retryAttempt: 2,
        },
      }),
    );

  if (args.rateLimits !== undefined)
    seed("provider/rateLimits/updated", { rateLimits: args.rateLimits });

  seed(
    "thread/contextWindowUsage/updated",
    {
      contextWindowUsage: {
        usedTokens: args.contextTokens ?? 250_000,
        modelContextWindow: 1_000_000,
        estimated: false,
      },
    },
    turnScope("turn-1"),
    args.anchorAt,
  );

  const usage = {
    totalTokens: args.contextTokens ?? 250_000,
    inputTokens: 10,
    cachedInputTokens: 249_990,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };

  seed(
    "thread/tokenUsage/updated",
    {
      tokenUsage: {
        total: usage,
        last: usage,
        modelContextWindow: 1_000_000,
        ...(args.ttlMs === null
          ? {}
          : { promptCacheTtlMs: args.ttlMs ?? 3_600_000 }),
      },
    },
    turnScope("turn-1"),
    args.anchorAt,
  );

  if (args.zeroUsageAfterMs !== undefined) {
    const zero = {
      totalTokens: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
    };

    seed(
      "thread/tokenUsage/updated",
      {
        tokenUsage: {
          total: usage,
          last: zero,
          modelContextWindow: 1_000_000,
          promptCacheTtlMs: 3_600_000,
        },
      },
      turnScope("turn-2"),
      args.anchorAt + args.zeroUsageAfterMs,
    );
  }

  if (args.latestRequest === "manual-compaction")
    seed(
      "client/turn/requested",
      requestData({
        requestNumber: 3,
        initiator: "user",
        input: createStandaloneBuiltinCompactCommandInput(),
      }),
    );

  if (args.latestRequest === "auto-compaction")
    seed(
      "client/turn/requested",
      requestData({
        requestNumber: 3,
        initiator: "system",
        input: createStandaloneBuiltinCompactCommandInput(),
        extra: { maintenance: "auto-compaction" },
      }),
    );

  return thread;
}

function maintenanceRequests(harness: TestAppHarness, threadId: string) {
  return harness.db.all<{ initiator: string; model: string }>(sql`
    SELECT json_extract(data, '$.initiator') AS initiator,
      json_extract(data, '$.execution.model') AS model
    FROM events
    WHERE thread_id = ${threadId}
      AND type = 'client/turn/requested'
      AND json_extract(data, '$.maintenance') = 'auto-compaction'
  `);
}

function requireThread(harness: TestAppHarness, threadId: string) {
  const thread = getThread(harness.db, threadId);

  if (thread === null) throw new Error(`Expected thread ${threadId}`);

  return thread;
}

function stateOf(harness: TestAppHarness, threadId: string, now: number) {
  return getAutoCompactionState(
    harness.deps,
    requireThread(harness, threadId),
    now,
  );
}

function enableExperiment(harness: TestAppHarness): void {
  setExperiments(harness.db, { autoCompactBeforeCacheExpiry: true });
}

function updateThread(
  harness: TestAppHarness,
  threadId: string,
  set: Partial<typeof threads.$inferInsert>,
): void {
  harness.db.update(threads).set(set).where(eq(threads.id, threadId)).run();
}

function rateLimits(
  overrides: Partial<ProviderRateLimitState>,
): ProviderRateLimitState {
  return {
    providerId: "claude-code",
    status: "allowed",
    kind: "subscription-window",
    windows: [
      {
        providerKey: "five_hour",
        label: "5-hour",
        status: "allowed",
        resetsAtMs: null,
      },
    ],
    reachedReason: null,
    overageStatus: null,
    overageReason: null,
    ...overrides,
  };
}

async function publishWork(
  harness: TestAppHarness,
  threadId: string,
  contribution: unknown,
): Promise<void> {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/work`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pluginId: "tidy", contribution }),
    },
  );

  expect(response.status, await response.clone().text()).toBe(200);
}

async function publishArchiveReady(
  harness: TestAppHarness,
  threadId: string,
): Promise<void> {
  await publishWork(harness, threadId, {
    kind: "signals",
    signals: {
      complete: true,
      validUntil: Date.now() + 60 * MINUTE,
      activity: [],
      waits: [],
      failures: [],
      postponement: null,
    },
  });

  seedStoredEvent(harness.deps, {
    threadId,
    sequence: getLatestThreadSequence(harness.db, { threadId }) + 1,
    type: "turn/completed",
    scope: turnScope("turn-1"),
    data: { status: "completed" },
  });

  const conversation = getThreadConversationSequences(harness.db, [threadId])[
    threadId
  ];

  if (!conversation) throw new Error("The chat has no stored conversation");
  seedChatCompletionReport(
    harness.db,
    threadId,
    "turn-1",
    conversation.lastInput,
  );

  const work = await harness.app.request(`/api/v1/threads/${threadId}/work`);
  const { basis } = threadWorkSummarySchema.parse(await work.json());

  await publishWork(harness, threadId, {
    kind: "assessment",
    assessment: {
      basis,
      contractVersion: 1,
      availability: "available",
      reason: "The requested work is complete.",
      sourceSeq: conversation.lastCompleted,
      text: "",
      noSuggestionReason: null,
      waitingOn: null,
      archiveReady: true,
    },
  });
}

describe("automatic compaction before the prompt cache expires", () => {
  it("fires once 50 minutes after the last request, as the system, with the last turn's model", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-t1");
      const anchorAt = Date.now() - 50 * MINUTE;
      const chat = seedChat(world, { anchorAt });
      const sweep = createAutoCompactionSweep();

      await sweep.run(harness.deps, anchorAt + 49 * MINUTE);
      expect(maintenanceRequests(harness, chat.id)).toEqual([]);
      expect(stateOf(harness, chat.id, anchorAt + 49 * MINUTE)).toEqual({
        state: "scheduled",
        at: new Date(anchorAt + 50 * MINUTE).toISOString(),
        reason: null,
        cacheReadShare: null,
      });

      await sweep.run(harness.deps, anchorAt + 50 * MINUTE);
      expect(maintenanceRequests(harness, chat.id)).toEqual([
        { initiator: "system", model: MODEL },
      ]);
      expect(requireThread(harness, chat.id).status).not.toBe("idle");
      expect(stateOf(harness, chat.id, anchorAt + 50 * MINUTE)).toMatchObject({
        state: "scheduled",
        reason: "running",
      });

      await sweep.run(harness.deps, anchorAt + 51 * MINUTE);
      expect(maintenanceRequests(harness, chat.id)).toHaveLength(1);
    });
  });

  it("does not fire when the window lapsed, the cache is short or unknown, the context is small, the provider is not Claude Code or the account is limited", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-t2");
      const now = Date.now();
      const anchorAt = now - 50 * MINUTE;

      const cases = {
        lapsed: seedChat(world, { anchorAt: now - 56 * MINUTE }),
        "short-cache-ttl": seedChat(world, { anchorAt, ttlMs: 300_000 }),
        "no-cache-ttl": seedChat(world, { anchorAt, ttlMs: null }),
        "small-context": seedChat(world, { anchorAt, contextTokens: 150_000 }),
        "provider-unsupported": seedChat(world, {
          anchorAt,
          providerId: "codex",
        }),
        "rate-limited": seedChat(world, {
          anchorAt,
          rateLimits: rateLimits({
            status: "blocked",
            windows: [
              {
                providerKey: "five_hour",
                label: "5-hour",
                status: "blocked",
                resetsAtMs: null,
              },
            ],
          }),
        }),
        overage: seedChat(world, {
          anchorAt,
          rateLimits: rateLimits({
            status: "allowed",
            overageStatus: "allowed",
            windows: [
              {
                providerKey: "five_hour",
                label: "5-hour",
                status: "blocked",
                resetsAtMs: null,
              },
            ],
          }),
        }),
        "using-credits": seedChat(world, {
          anchorAt,
          rateLimits: rateLimits({
            kind: "credits",
            windows: [
              {
                providerKey: "overage",
                label: null,
                status: "allowed",
                resetsAtMs: null,
              },
            ],
          }),
        }),
      };

      const allowedLimits = seedChat(world, {
        anchorAt,
        rateLimits: rateLimits({}),
      });

      const nearLimit = seedChat(world, {
        anchorAt,
        rateLimits: rateLimits({
          status: "warning",
          windows: [
            {
              providerKey: "seven_day",
              label: "Weekly limit",
              status: "warning",
              resetsAtMs: null,
            },
          ],
        }),
      });

      await createAutoCompactionSweep().run(harness.deps, now);

      for (const [name, chat] of Object.entries(cases))
        expect(maintenanceRequests(harness, chat.id), name).toEqual([]);
      expect(maintenanceRequests(harness, allowedLimits.id)).toHaveLength(1);
      expect(maintenanceRequests(harness, nearLimit.id)).toHaveLength(1);

      expect(stateOf(harness, cases.lapsed.id, now)).toEqual({
        state: "skipped",
        at: new Date(now - 6 * MINUTE).toISOString(),
        reason: "lapsed",
        cacheReadShare: null,
      });

      for (const reason of [
        "short-cache-ttl",
        "no-cache-ttl",
        "small-context",
        "provider-unsupported",
        "rate-limited",
        "using-credits",
      ] as const)
        expect(stateOf(harness, cases[reason].id, now), reason).toMatchObject({
          state: "disabled",
          reason,
        });
      expect(stateOf(harness, cases.overage.id, now)).toMatchObject({
        state: "disabled",
        reason: "rate-limited",
      });
    });
  });

  it("skips chats that are not idle owner-driven root chats with nothing pending, and still fires after a provider retry", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-t3");
      const now = Date.now();
      const anchorAt = now - 50 * MINUTE;
      const control = seedChat(world, { anchorAt });
      const retried = seedChat(world, { anchorAt, retryAfterOwnerTurn: true });

      const provisioning = seedEnvironment(harness.deps, {
        hostId: world.hostId,
        projectId: world.projectId,
        path: "/tmp/auto-compaction-provisioning",
        status: "provisioning",
      });

      const offlineHost = seedHost(harness.deps, { id: "host-offline" });

      const offlineEnvironment = seedEnvironment(harness.deps, {
        hostId: offlineHost.id,
        projectId: world.projectId,
        path: "/tmp/auto-compaction-offline",
        status: "ready",
      });

      const drainingWorld = seedWorld(harness, "host-auto-compaction-drain");
      reserveHostUpdateDrain(harness.db, drainingWorld.hostId);

      const cases = {
        archived: seedChat(world, { anchorAt }),
        shelved: seedChat(world, { anchorAt }),
        deleted: seedChat(world, { anchorAt }),
        hidden: seedChat(world, { anchorAt, visibility: "hidden" }),
        "child-chat": seedChat(world, {
          anchorAt,
          parentThreadId: control.id,
        }),
        "agent-launched": seedChat(world, {
          anchorAt,
          launchedByThreadId: control.id,
        }),
        "plugin-created": seedChat(world, {
          anchorAt,
          originPluginId: "glance",
        }),
        "automation-run": seedChat(world, {
          anchorAt,
          originPluginId: "automations",
        }),
        "automation-send": seedChat(world, {
          anchorAt,
          latestRequestSource: "plugin",
        }),
        "environment-not-ready": seedChat(world, {
          anchorAt,
          environmentId: provisioning.id,
        }),
        error: seedChat(world, { anchorAt, status: "error" }),
        working: seedChat(world, { anchorAt, status: "active" }),
        "host-disconnected": seedChat(world, {
          anchorAt,
          environmentId: offlineEnvironment.id,
        }),
        "update-drain": seedChat(drainingWorld, { anchorAt }),
        "queued-message": seedChat(world, { anchorAt }),
        "scheduled-message": seedChat(world, { anchorAt }),
        "inbox-wait": seedChat(world, { anchorAt }),
        "inbox-producer": seedChat(world, { anchorAt }),
        "pending-interaction": seedChat(world, { anchorAt }),
        "failure-paused": seedChat(world, { anchorAt }),
        "ready-to-archive": seedChat(world, { anchorAt }),
        "opted-out": seedChat(world, { anchorAt }),
        "manual-compaction": seedChat(world, {
          anchorAt,
          latestRequest: "manual-compaction",
        }),
        "auto-compaction": seedChat(world, {
          anchorAt,
          latestRequest: "auto-compaction",
        }),
      };

      updateThread(harness, cases.archived.id, { archivedAt: now });
      updateThread(harness, cases.shelved.id, { shelvedAt: now });
      updateThread(harness, cases.deleted.id, { deletedAt: now });
      seedQueuedMessage(harness.deps, {
        threadId: cases["queued-message"].id,
        content: [{ type: "text", text: "Next step", mentions: [] }],
      });
      seedQueuedMessage(harness.deps, {
        threadId: cases["scheduled-message"].id,
        content: [{ type: "text", text: "Later", mentions: [] }],
        sendAt: now + 60 * MINUTE,
      });

      const wait = await harness.app.request(
        `/api/v1/threads/${cases["inbox-wait"].id}/waits`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: "deploy",
            for: "the deploy",
            check: { what: "deploy status", at: now + 24 * 60 * MINUTE },
          }),
        },
      );

      expect(wait.status, await wait.clone().text()).toBe(200);
      harness.db
        .insert(threadProducers)
        .values({
          id: randomUUID(),
          threadId: cases["inbox-producer"].id,
          kind: "goal",
          pluginId: "goals",
          label: "Ship the goal",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      harness.db
        .insert(pendingInteractions)
        .values({
          id: randomUUID(),
          threadId: cases["pending-interaction"].id,
          turnId: "turn-1",
          status: "pending",
          payload: "{}",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      harness.db
        .insert(threadFailures)
        .values({
          id: randomUUID(),
          threadId: cases["failure-paused"].id,
          turnId: "turn-1",
          state: "actionable",
          reason: "Provider overloaded",
          createdAt: now,
          updatedAt: now,
        })
        .run();

      await publishArchiveReady(harness, cases["ready-to-archive"].id);

      const optOut = await harness.app.request(
        `/api/v1/threads/${cases["opted-out"].id}/auto-compaction`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      );

      expect(await optOut.json()).toEqual({ enabled: false });

      await createAutoCompactionSweep().run(harness.deps, now);

      for (const [name, chat] of Object.entries(cases)) {
        const expected = name === "auto-compaction" ? 1 : 0;

        expect(maintenanceRequests(harness, chat.id), name).toHaveLength(
          expected,
        );
      }

      expect(maintenanceRequests(harness, control.id)).toHaveLength(1);
      expect(maintenanceRequests(harness, retried.id)).toHaveLength(1);

      const reasons = Object.fromEntries(
        Object.entries(cases)
          .filter(([name]) => name !== "deleted")
          .map(([name, chat]) => [name, stateOf(harness, chat.id, now).reason]),
      );

      expect(reasons).toEqual({
        archived: "archived",
        shelved: "shelved",
        hidden: "hidden",
        "child-chat": "child-chat",
        "agent-launched": "agent-launched",
        "plugin-created": "plugin-created",
        "automation-run": "plugin-created",
        "automation-send": "not-owner-driven",
        "environment-not-ready": "environment-not-ready",
        error: "not-idle",
        working: "not-idle",
        "host-disconnected": "host-disconnected",
        "update-drain": "update-drain",
        "queued-message": "queued-message",
        "scheduled-message": "queued-message",
        "inbox-wait": "inbox-wait",
        "inbox-producer": "inbox-producer",
        "pending-interaction": "pending-interaction",
        "failure-paused": "queue-paused",
        "ready-to-archive": "work-ready-to-archive",
        "opted-out": "opted-out",
        "manual-compaction": "already-compacted",
        "auto-compaction": "already-compacted",
      });
    });
  });

  it("does not fire while the experiment is off, the server is draining or two maintenance runs are active", async () => {
    await withTestHarness(async (harness) => {
      const world = seedWorld(harness, "host-auto-compaction-global");
      const now = Date.now();
      const anchorAt = now - 50 * MINUTE;
      const first = seedChat(world, { anchorAt });
      const second = seedChat(world, { anchorAt });
      const third = seedChat(world, { anchorAt });
      const sweep = createAutoCompactionSweep();
      setExperiments(harness.db, { autoCompactBeforeCacheExpiry: false });

      const total = () =>
        [first, second, third].reduce(
          (count, chat) => count + maintenanceRequests(harness, chat.id).length,
          0,
        );

      await sweep.run(harness.deps, now);
      expect(total()).toBe(0);
      expect(stateOf(harness, first.id, now).reason).toBe("experiment-off");

      enableExperiment(harness);
      setServerUpdateDraining(harness.db, true);
      await sweep.run(harness.deps, now);
      expect(total()).toBe(0);
      expect(stateOf(harness, first.id, now).reason).toBe("update-drain");

      setServerUpdateDraining(harness.db, false);
      await sweep.run(harness.deps, now);
      expect(total()).toBe(2);

      const waiting = [first, second, third].find(
        (chat) => maintenanceRequests(harness, chat.id).length === 0,
      );

      if (waiting === undefined) throw new Error("Expected a waiting chat");
      expect(stateOf(harness, waiting.id, now).reason).toBe("capacity");
    });
  });

  it("never repeats after a compaction, even with fresh sweep state, and stops when the chat is opted out mid-dispatch", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-t4");
      const now = Date.now();
      const anchorAt = now - 50 * MINUTE;
      const fired = seedChat(world, { anchorAt });

      await createAutoCompactionSweep().run(harness.deps, now);
      expect(maintenanceRequests(harness, fired.id)).toHaveLength(1);

      updateThread(harness, fired.id, { status: "idle" });
      await createAutoCompactionSweep().run(harness.deps, now + MINUTE);
      expect(maintenanceRequests(harness, fired.id)).toHaveLength(1);
      expect(stateOf(harness, fired.id, now + MINUTE)).toMatchObject({
        state: "disabled",
        reason: "already-compacted",
      });

      const raced = seedChat(world, { anchorAt });
      const pending = createAutoCompactionSweep().run(harness.deps, now);

      writeAutoCompactionMetadata(harness.db, raced.id, {
        ...readAutoCompactionMetadata(harness.db, raced.id),
        disabled: true,
      });
      await pending;
      expect(maintenanceRequests(harness, raced.id)).toEqual([]);
      expect(requireThread(harness, raced.id).status).toBe("idle");
    });
  });

  it("anchors on the last request that reached the provider, not a later zero-usage result", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-zero-usage");
      const anchorAt = Date.now() - 50 * MINUTE;

      const chat = seedChat(world, {
        anchorAt,
        zeroUsageAfterMs: 20 * MINUTE,
      });

      expect(stateOf(harness, chat.id, anchorAt + 49 * MINUTE)).toMatchObject({
        state: "scheduled",
        at: new Date(anchorAt + 50 * MINUTE).toISOString(),
      });

      await createAutoCompactionSweep().run(
        harness.deps,
        anchorAt + 50 * MINUTE,
      );
      expect(maintenanceRequests(harness, chat.id)).toHaveLength(1);
    });
  });

  it("logs one lapse, with the blocker that held it, for a chat the sweep watched before its due time", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-lapse");
      const anchorAt = Date.now() - 50 * MINUTE;
      const blocked = seedChat(world, { anchorAt });
      const slept = seedChat(world, { anchorAt: anchorAt + 6 * MINUTE });
      const unseen = seedChat(world, { anchorAt: anchorAt - 60 * MINUTE });
      const sweep = createAutoCompactionSweep();
      const info = vi.spyOn(harness.deps.logger, "info");

      const lapses = () =>
        info.mock.calls.flatMap(([fields, message]) =>
          message ===
            "Automatic compaction lapsed before the prompt cache expired" &&
          typeof fields === "object" &&
          fields !== null &&
          "threadId" in fields &&
          "reason" in fields
            ? [{ threadId: fields.threadId, reason: fields.reason }]
            : [],
        );

      await sweep.run(harness.deps, anchorAt + 45 * MINUTE);
      seedQueuedMessage(harness.deps, {
        threadId: blocked.id,
        content: [{ type: "text", text: "Next step", mentions: [] }],
      });
      await sweep.run(harness.deps, anchorAt + 51 * MINUTE);
      await sweep.run(harness.deps, anchorAt + 62 * MINUTE);
      await sweep.run(harness.deps, anchorAt + 63 * MINUTE);

      expect(maintenanceRequests(harness, slept.id)).toEqual([]);
      expect(maintenanceRequests(harness, blocked.id)).toEqual([]);
      expect(lapses()).toHaveLength(2);
      expect(lapses()).toEqual(
        expect.arrayContaining([
          { threadId: slept.id, reason: "lapsed" },
          { threadId: blocked.id, reason: "queued-message" },
        ]),
      );
      expect(lapses().some((lapse) => lapse.threadId === unseen.id)).toBe(
        false,
      );
    });
  });

  it("puts the schedule on the timeline only for chats the sweep would compact, marking opted-out chats", async () => {
    await withTestHarness(async (harness) => {
      enableExperiment(harness);
      const world = seedWorld(harness, "host-auto-compaction-timeline");
      const now = Date.now();
      const anchorAt = now - 45 * MINUTE;
      const scheduled = seedChat(world, { anchorAt });
      const queued = seedChat(world, { anchorAt });
      const optedOut = seedChat(world, { anchorAt });

      seedQueuedMessage(harness.deps, {
        threadId: queued.id,
        content: [{ type: "text", text: "Next step", mentions: [] }],
      });
      writeAutoCompactionMetadata(harness.db, optedOut.id, {
        ...readAutoCompactionMetadata(harness.db, optedOut.id),
        disabled: true,
      });

      const timelineUsage = (threadId: string) => {
        const { sequenceStart, usage } = readThreadContextWindowUsage(
          harness.db,
          threadId,
        );

        if (usage === null) throw new Error("Expected context usage");

        return withAutoCompactionAt(harness.deps, {
          thread: requireThread(harness, threadId),
          usage,
          sequenceStart,
          now,
        });
      };

      const dueAt = new Date(anchorAt + 50 * MINUTE).toISOString();

      expect(timelineUsage(scheduled.id)).toMatchObject({
        autoCompactionAt: dueAt,
      });
      expect(
        timelineUsage(scheduled.id).autoCompactionOptedOut,
      ).toBeUndefined();
      expect(timelineUsage(queued.id).autoCompactionAt).toBeUndefined();
      expect(timelineUsage(optedOut.id)).toMatchObject({
        autoCompactionAt: dueAt,
        autoCompactionOptedOut: true,
      });
    });
  });
});

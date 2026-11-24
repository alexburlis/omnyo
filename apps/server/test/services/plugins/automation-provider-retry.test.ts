import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  claimQueuedThreadMessageGroup,
  getLatestThreadSequence,
  getQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  threads,
} from "@omnyo/db";
import { turnRequestEventDataSchema } from "@omnyo/domain";
import { createNodeOmnyoSdk } from "@omnyo/sdk";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { applyLoggedThreadLifecycleEvent } from "../../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../../src/services/threads/queued-message-dispatch.js";
import { toThreadQueuedMessage } from "../../../src/services/threads/thread-queued-messages.js";
import { buildTurnFailedEvent } from "../../../src/services/threads/turn-failed.js";
import { availableModelFixture } from "../../helpers/available-models.js";
import {
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  registerHostRpcResponder,
} from "../../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
} from "../../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../../helpers/test-app.js";

const EXECUTION = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "ultra",
  serviceTier: "default",
  permissionMode: "accept-edits",
} as const;

const executionTuple = {
  model: EXECUTION.model,
  reasoningLevel: EXECUTION.reasoningLevel,
  serviceTier: EXECUTION.serviceTier,
  permissionMode: EXECUTION.permissionMode,
};

const runSchema = z.object({
  id: z.string(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  skipReason: z.string().nullable(),
  error: z.string().nullable(),
  threadId: z.string().nullable(),
  trigger: z.enum(["schedule", "manual"]),
  scheduledFor: z.number(),
});

const automationSchema = z.object({
  id: z.string(),
  nextRunAt: z.number().nullable(),
});

type PluginModule = { default(api: PluginApi): Promise<void> };

type SweepModule = {
  sweepDueAutomations(
    api: PluginApi,
    db: ReturnType<PluginApi["storage"]["database"]>,
    args: {
      pluginDataDir: string;
      serverHostId: string;
      now: number;
    },
  ): Promise<void>;
};

async function eventually(check: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  const deadline = performance.now() + 2_000;

  while (performance.now() < deadline) {
    try {
      await check();

      return;
    } catch (error) {
      lastError = error;
    }

    await delay(5);
  }

  throw lastError;
}

function requests(server: RunningTestServer, threadId: string) {
  return listEvents(server.db, { threadId })
    .filter((event) => event.type === "client/turn/requested")
    .map((event) => turnRequestEventDataSchema.parse(JSON.parse(event.data)));
}

async function createFixture(options: { reuseTarget?: boolean } = {}) {
  const server = await startTestServer();
  const { host, session } = seedHostSession(server.deps);

  const { project } = seedProjectWithSource(server.deps, {
    hostId: host.id,
    path: "/tmp/automation-provider-retry-project",
  });

  const environment = seedEnvironment(server.deps, {
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/automation-provider-retry-project",
  });

  registerHostRpcResponder(server, {
    hostId: host.id,
    sessionId: session.id,
    handle({ command }) {
      switch (command.type) {
        case "provider.list_models":
          return {
            ok: true,
            result: {
              models: [
                availableModelFixture({
                  model: EXECUTION.model,
                  reasoningLevels: [EXECUTION.reasoningLevel],
                  isDefault: true,
                }),
              ],
              selectedOnlyModels: [],
            },
          };
        case "host.prepare_workspace_identity_v1":
          return {
            ok: true,
            result: {
              status: "current",
              rootPath: join(command.rootPath, ".omnyo"),
            },
          };
        case "host.read_workspace_agent_context":
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        case "thread.start":
          return {
            ok: true,
            result: { providerThreadId: `provider-${command.threadId}` },
          };
        case "turn.submit":
          return { ok: true, result: { trace: { spans: [] } } };
        default:
          throw new Error(`Unexpected host command ${command.type}`);
      }
    },
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
  const sdk = createNodeOmnyoSdk({ baseUrl: server.baseUrl });
  let nextThreadRead: (() => Promise<void>) | null = null;

  const sdkOverrides = {
    system: { config: sdk.system.config },
    projects: { get: sdk.projects.get, list: sdk.projects.list },
    hosts: { list: sdk.hosts.list },
    providers: { list: sdk.providers.list },
    plugins: {
      experimental_discoverRpc: sdk.plugins.experimental_discoverRpc,
      callRpc: sdk.plugins.callRpc,
    },
    threads: {
      async get(args: Parameters<typeof sdk.threads.get>[0]) {
        const interleave = nextThreadRead;
        nextThreadRead = null;
        await interleave?.();

        return sdk.threads.get(args);
      },
      send: sdk.threads.send,
      spawn: sdk.threads.spawn,
      retry: sdk.threads.retry,
      events: { list: sdk.threads.events.list },
    },
  };

  const pluginDataDir = join(server.config.dataDir, "automation-test-runtime");

  const automations = createFakePluginHost({
    pluginId: "automations",
    dataDir: pluginDataDir,
    sdk: sdkOverrides,
  });

  const providerRetry = createFakePluginHost({
    pluginId: "provider-retry",
    dataDir: join(server.config.dataDir, "provider-retry-test-runtime"),
    sdk: sdkOverrides,
  });

  try {
    const [automationModule, sweepModule, providerRetryModule] =
      await Promise.all([
        vi.importActual<PluginModule>(
          new URL(
            "../../../../../plugins/automations/src/server.ts",
            import.meta.url,
          ).pathname,
        ),
        vi.importActual<SweepModule>(
          new URL(
            "../../../../../plugins/automations/src/sweep.ts",
            import.meta.url,
          ).pathname,
        ),
        vi.importActual<PluginModule>(
          new URL(
            "../../../../../plugins/provider-retry/server.ts",
            import.meta.url,
          ).pathname,
        ),
      ]);

    await automationModule.default(automations.api);
    await providerRetryModule.default(providerRetry.api);

    const target = options.reuseTarget
      ? await sdk.threads.spawn({
          projectId: project.id,
          environment: { type: "reuse", environmentId: environment.id },
          prompt: "Earlier human request",
          ...EXECUTION,
          origin: "app",
        })
      : null;

    if (target !== null) {
      await eventually(() =>
        expect(getThread(server.db, target.id)?.status).toBe("active"),
      );
      expect(
        applyLoggedThreadLifecycleEvent(server.deps, {
          threadId: target.id,
          event: { type: "run.succeeded" },
        }).applied,
      ).toBe(true);
    }

    const automation = automationSchema.parse(
      await automations.harness.callRpc("automations_create", {
        projectId: project.id,
        name: "Scheduled inbox",
        enabled: true,
        trigger: {
          triggerType: "schedule",
          cron: "0 * * * *",
          timezone: "UTC",
        },
        execution: {
          mode: "agent",
          prompt: "Read the inbox",
          ...EXECUTION,
          environment: { type: "reuse", environmentId: environment.id },
          ...(target === null ? {} : { targetThreadId: target.id }),
        },
        origin: "human",
      }),
    );

    const automationInput = {
      projectId: project.id,
      automationId: automation.id,
    };

    const readAutomation = async () =>
      automationSchema.parse(
        await automations.harness.callRpc("automations_get", automationInput),
      );

    const runs = async () =>
      z
        .object({ runs: z.array(runSchema) })
        .parse(
          await automations.harness.callRpc(
            "automations_runs",
            automationInput,
          ),
        ).runs;

    const sweepAt = async (now: number) => {
      vi.setSystemTime(now);
      await sweepModule.sweepDueAutomations(
        automations.api,
        automations.api.storage.database(),
        {
          pluginDataDir,
          serverHostId: host.id,
          now,
        },
      );
    };

    const nextRunAt = automation.nextRunAt;

    if (nextRunAt === null) throw new Error("Expected a first scheduled tick");
    await sweepAt(nextRunAt);
    const initialRun = (await runs())[0];
    const threadId = initialRun?.threadId;

    if (threadId === null || threadId === undefined) {
      throw new Error("Expected a real core automation thread");
    }

    await eventually(() =>
      expect(getThread(server.db, threadId)?.status).toBe("active"),
    );
    const initialRequests = requests(server, threadId);
    expect(initialRequests).toHaveLength(target === null ? 1 : 2);
    const originalRequest = initialRequests.at(-1)!;
    expect(originalRequest.execution).toMatchObject(executionTuple);
    expect(getThread(server.db, threadId)).toMatchObject({
      providerId: EXECUTION.providerId,
      originPluginId: target === null ? "automations" : null,
    });

    const fail = async (failingThreadId = threadId, overloaded = true) => {
      seedEvent(server.deps, {
        environmentId: environment.id,
        threadId: failingThreadId,
        providerThreadId: `provider-${failingThreadId}`,
        sequence:
          getLatestThreadSequence(server.db, { threadId: failingThreadId }) + 1,
        type: "provider/error",
        scope: { kind: "thread" },
        data: {
          providerThreadId: `provider-${failingThreadId}`,
          message: overloaded
            ? "Provider temporarily overloaded"
            : "Task failed",
          errorInfo: {
            category: overloaded ? "overloaded" : "unknown",
            providerCode: null,
            httpStatusCode: overloaded ? 503 : null,
          },
        },
      });
      expect(
        applyLoggedThreadLifecycleEvent(server.deps, {
          threadId: failingThreadId,
          event: { type: "run.failed" },
        }).applied,
      ).toBe(true);
      const failed = buildTurnFailedEvent(server.db, failingThreadId);

      if (failed === null) throw new Error("Expected core turn.failed facts");
      expect(failed.errorInfo?.category).toBe(
        overloaded ? "overloaded" : "unknown",
      );
      expect(
        await automations.harness.emitThreadEvent("thread.failed", {
          thread: await sdk.threads.get({ threadId: failingThreadId }),
          error: "Task failed",
        }),
      ).toEqual({ errors: [] });
      expect(
        await providerRetry.harness.emitThreadEvent("turn.failed", failed),
      ).toEqual({ errors: [] });

      return failed;
    };

    const succeed = async (successfulThreadId = threadId) => {
      expect(
        applyLoggedThreadLifecycleEvent(server.deps, {
          threadId: successfulThreadId,
          event: { type: "run.succeeded" },
        }).applied,
      ).toBe(true);
      expect(
        await automations.harness.emitThreadEvent("thread.idle", {
          thread: await sdk.threads.get({ threadId: successfulThreadId }),
          lastAssistantText: null,
        }),
      ).toEqual({ errors: [] });
    };

    const dispatchRetry = async (retryThreadId = threadId) => {
      const row = listQueuedThreadMessages(server.db, retryThreadId)[0];

      if (row?.sendAt === null || row?.sendAt === undefined) {
        throw new Error("Expected a scheduled provider retry");
      }

      const now = Math.max(Date.now(), row.sendAt);
      vi.setSystemTime(now);
      await runQueuedMessageDispatch(server.deps, {
        kind: "time-reached",
        now,
      });
      await eventually(() =>
        expect(getThread(server.db, retryThreadId)?.status).toBe("active"),
      );
    };

    return {
      server,
      sdk,
      threadId,
      requestId: originalRequest.requestId,
      initialRunId: initialRun.id,
      pluginDb: automations.api.storage.database(),
      runs,
      automation: readAutomation,
      sweepAt,
      fail,
      succeed,
      dispatchRetry,
      interleaveNextThreadRead(callback: () => Promise<void>) {
        nextThreadRead = callback;
      },
      spawnOrdinary: () =>
        sdk.threads.spawn({
          projectId: project.id,
          environment: { type: "reuse", environmentId: environment.id },
          prompt: "Ordinary request",
          ...EXECUTION,
          origin: "app",
        }),
      threadIds: () =>
        server.db
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.projectId, project.id))
          .all()
          .map((thread) => thread.id),
      async close() {
        await providerRetry.harness.dispose();
        await automations.harness.dispose();
        vi.useRealTimers();
        await server.close();
      },
    };
  } catch (error) {
    await providerRetry.harness.dispose();
    await automations.harness.dispose();
    vi.useRealTimers();
    await server.close();
    throw error;
  }
}

describe("scheduled automations and provider retry", () => {
  it.each([
    "queued",
    "claimed",
    "resumed",
    "recovered",
    "terminal",
    "failed-again",
  ] as const)(
    "keeps the original thread and request chain when its retry is %s",
    async (state) => {
      const fixture = await createFixture();

      try {
        const { server, threadId, requestId } = fixture;
        await fixture.fail(threadId, state !== "terminal");
        const retryAt = (await fixture.automation()).nextRunAt;

        if (retryAt === null) throw new Error("Expected automation recovery");
        expect((await fixture.runs())[0]).toMatchObject({
          id: fixture.initialRunId,
          threadId,
          status: "failed",
          trigger: "schedule",
        });
        const queued = listQueuedThreadMessages(server.db, threadId);
        expect(queued).toHaveLength(state === "terminal" ? 0 : 1);

        if (state !== "terminal") {
          expect(toThreadQueuedMessage(queued[0]!).payload).toMatchObject({
            kind: "retry",
            retryOfTurnRequestId: requestId,
            attempt: 2,
          });
        }

        if (state === "claimed") {
          expect(
            claimQueuedThreadMessageGroup(
              server.db,
              server.hub,
              queued[0]!.id,
              {
                kind: "explicit-send",
              },
            ),
          ).toHaveLength(1);
          expect(
            getQueuedThreadMessage(server.db, queued[0]!.id),
          ).toMatchObject({
            claimedAt: expect.any(Number),
            claimToken: expect.any(String),
          });
        }

        if (state === "resumed" || state === "recovered") {
          await fixture.dispatchRetry();
          expect(Date.now()).toBeLessThan(retryAt);

          if (state === "recovered") await fixture.succeed();
        }

        await fixture.sweepAt(retryAt);

        expect(fixture.threadIds()).toEqual([threadId]);
        const history = await fixture.runs();
        expect(history).toHaveLength(2);
        expect(history.map((entry) => entry.threadId)).toEqual([
          threadId,
          threadId,
        ]);
        expect(history[1]).toMatchObject({
          id: fixture.initialRunId,
          status: "failed",
        });
        expect(history[0]?.status).toBe(
          state === "recovered" ? "succeeded" : "running",
        );

        if (
          state === "queued" ||
          state === "claimed" ||
          state === "failed-again"
        ) {
          expect(requests(server, threadId)).toHaveLength(1);
          expect(
            getQueuedThreadMessage(server.db, queued[0]!.id),
          ).toMatchObject({
            claimedAt: state === "claimed" ? expect.any(Number) : null,
            claimToken: state === "claimed" ? expect.any(String) : null,
          });

          if (state === "claimed") return;
          await fixture.dispatchRetry();
        }

        await eventually(() =>
          expect(requests(server, threadId)).toHaveLength(2),
        );
        expect(requests(server, threadId)[1]).toMatchObject({
          retryOfRequestId: requestId,
          retryAttempt: 2,
          initiator: "system",
          execution: executionTuple,
        });
        expect(listQueuedThreadMessages(server.db, threadId)).toEqual([]);

        if (state === "failed-again") {
          const secondFailure = await fixture.fail();
          expect(secondFailure).toMatchObject({
            requestId: requests(server, threadId)[1]!.requestId,
            attemptNumber: 2,
          });
          const secondRetryAt = (await fixture.automation()).nextRunAt;

          if (secondRetryAt === null)
            throw new Error("Expected another recovery");
          await fixture.sweepAt(secondRetryAt);
          expect(fixture.threadIds()).toEqual([threadId]);
          expect((await fixture.runs()).map((entry) => entry.threadId)).toEqual(
            [threadId, threadId, threadId],
          );

          const anchors = z
            .array(z.object({ requestId: z.string() }))
            .parse(
              fixture.pluginDb
                .prepare(
                  "SELECT turn_request_id AS requestId FROM automation_runs ORDER BY started_at",
                )
                .all(),
            );

          expect(anchors.map((entry) => entry.requestId)).toEqual([
            requestId,
            requestId,
            requestId,
          ]);
          expect(
            toThreadQueuedMessage(
              listQueuedThreadMessages(server.db, threadId)[0]!,
            ).payload,
          ).toMatchObject({
            kind: "retry",
            retryOfTurnRequestId: requestId,
            attempt: 3,
          });
          await fixture.dispatchRetry();
          expect(requests(server, threadId)).toHaveLength(3);
          expect(requests(server, threadId)[2]).toMatchObject({
            retryOfRequestId: requestId,
            retryAttempt: 3,
            execution: executionTuple,
          });
        }

        if (state !== "recovered") await fixture.succeed();
        expect((await fixture.runs())[0]?.status).toBe("succeeded");

        if (state === "recovered") {
          const nextCronTick = (await fixture.automation()).nextRunAt;

          if (nextCronTick === null)
            throw new Error("Expected next regular cron tick");
          expect(nextCronTick).toBeGreaterThan(retryAt);
          await fixture.sweepAt(nextCronTick);
          expect(fixture.threadIds()).toHaveLength(2);
          expect((await fixture.runs())[0]).toMatchObject({
            status: "running",
            trigger: "schedule",
            scheduledFor: nextCronTick,
          });
          expect((await fixture.runs())[0]?.threadId).not.toBe(threadId);
          expect(requests(server, threadId)).toHaveLength(2);
        }
      } finally {
        await fixture.close();
      }
    },
    30_000,
  );

  it("skips superseded automation recovery while preserving the later human provider retry", async () => {
    const fixture = await createFixture();

    try {
      const { server, threadId, requestId } = fixture;
      await fixture.fail(threadId, false);
      const originalRetryAt = (await fixture.automation()).nextRunAt;

      if (originalRetryAt === null)
        throw new Error("Expected original recovery");
      await fixture.sdk.threads.send({
        threadId,
        input: [
          { type: "text", text: "A superseding human request", mentions: [] },
        ],
        mode: "steer-if-active",
        messageSource: { kind: "user" },
      });
      await eventually(() => {
        expect(requests(server, threadId)).toHaveLength(2);
        expect(getThread(server.db, threadId)?.status).toBe("active");
      });
      const humanRequestId = requests(server, threadId)[1]!.requestId;
      expect(humanRequestId).not.toBe(requestId);
      await fixture.fail();
      const providerQueue = listQueuedThreadMessages(server.db, threadId);
      expect(providerQueue).toHaveLength(1);
      expect(toThreadQueuedMessage(providerQueue[0]!).payload).toMatchObject({
        kind: "retry",
        retryOfTurnRequestId: humanRequestId,
      });

      await fixture.sweepAt(originalRetryAt);

      expect(fixture.threadIds()).toEqual([threadId]);
      expect(requests(server, threadId)).toHaveLength(2);
      expect((await fixture.runs())[0]).toMatchObject({
        status: "skipped",
        threadId,
        skipReason:
          "superseded: the original thread has a different turn request",
      });
      expect(
        listQueuedThreadMessages(server.db, threadId).map((entry) => entry.id),
      ).toEqual([providerQueue[0]!.id]);
      await fixture.dispatchRetry();
      expect(requests(server, threadId)).toHaveLength(3);
      expect(requests(server, threadId)[2]).toMatchObject({
        retryOfRequestId: humanRequestId,
        retryAttempt: 2,
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("skips recovery when an unrelated turn completes during the thread status read", async () => {
    const fixture = await createFixture();

    try {
      const { server, threadId } = fixture;
      await fixture.fail(threadId, false);
      const retryAt = (await fixture.automation()).nextRunAt;

      if (retryAt === null) throw new Error("Expected automation recovery");
      let interleaved = false;
      fixture.interleaveNextThreadRead(async () => {
        await fixture.sdk.threads.send({
          threadId,
          input: [
            {
              type: "text",
              text: "An unrelated turn during recovery",
              mentions: [],
            },
          ],
          mode: "steer-if-active",
          messageSource: { kind: "user" },
        });
        await eventually(() => {
          expect(requests(server, threadId)).toHaveLength(2);
          expect(getThread(server.db, threadId)?.status).toBe("active");
        });
        expect(
          applyLoggedThreadLifecycleEvent(server.deps, {
            threadId,
            event: { type: "run.succeeded" },
          }).applied,
        ).toBe(true);
        interleaved = true;
      });

      await fixture.sweepAt(retryAt);

      expect(interleaved).toBe(true);
      expect(fixture.threadIds()).toEqual([threadId]);
      expect(requests(server, threadId)).toHaveLength(2);
      expect(getThread(server.db, threadId)?.status).toBe("idle");
      expect((await fixture.runs())[0]).toMatchObject({
        status: "skipped",
        skipReason:
          "superseded: the original thread has a different turn request",
      });
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("fails an unknown legacy target lineage visibly across repeated recovery ticks", async () => {
    const fixture = await createFixture({ reuseTarget: true });

    try {
      const { server, threadId } = fixture;
      expect(
        fixture.pluginDb
          .prepare(
            "UPDATE automation_runs SET turn_request_id = NULL WHERE id = ?",
          )
          .run(fixture.initialRunId).changes,
      ).toBe(1);
      await fixture.fail(threadId, false);

      for (const expectedHistoryLength of [2, 3]) {
        const retryAt = (await fixture.automation()).nextRunAt;

        if (retryAt === null)
          throw new Error("Expected visible recovery retry");
        await fixture.sweepAt(retryAt);
        expect(fixture.threadIds()).toEqual([threadId]);
        expect(requests(server, threadId)).toHaveLength(2);
        expect(listQueuedThreadMessages(server.db, threadId)).toEqual([]);
        const history = await fixture.runs();
        expect(history).toHaveLength(expectedHistoryLength);
        expect(history.map((entry) => entry.threadId)).toEqual(
          Array.from({ length: expectedHistoryLength }, () => threadId),
        );
        expect(history[0]).toMatchObject({
          status: "failed",
          error:
            "Cannot recover automation: its original turn request is unavailable",
        });
      }
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("keeps provider retry for ordinary threads and later human turns on automation threads", async () => {
    const fixture = await createFixture();

    try {
      const ordinary = await fixture.spawnOrdinary();
      await eventually(() =>
        expect(getThread(fixture.server.db, ordinary.id)?.status).toBe(
          "active",
        ),
      );
      await fixture.fail(ordinary.id);

      const ordinaryRequestId = requests(fixture.server, ordinary.id)[0]!
        .requestId;

      expect(
        toThreadQueuedMessage(
          listQueuedThreadMessages(fixture.server.db, ordinary.id)[0]!,
        ).payload,
      ).toMatchObject({
        kind: "retry",
        retryOfTurnRequestId: ordinaryRequestId,
      });
      await fixture.dispatchRetry(ordinary.id);
      expect(requests(fixture.server, ordinary.id)[1]?.retryOfRequestId).toBe(
        ordinaryRequestId,
      );
      await fixture.succeed(ordinary.id);

      await fixture.succeed();
      await fixture.sdk.threads.send({
        threadId: fixture.threadId,
        input: [{ type: "text", text: "A later human request", mentions: [] }],
        mode: "steer-if-active",
      });
      await eventually(() =>
        expect(requests(fixture.server, fixture.threadId)).toHaveLength(2),
      );

      const humanRequestId = requests(fixture.server, fixture.threadId)[1]!
        .requestId;

      await fixture.fail();
      expect(
        toThreadQueuedMessage(
          listQueuedThreadMessages(fixture.server.db, fixture.threadId)[0]!,
        ).payload,
      ).toMatchObject({ kind: "retry", retryOfTurnRequestId: humanRequestId });
      await fixture.dispatchRetry();
      expect(requests(fixture.server, fixture.threadId)[2]).toMatchObject({
        retryOfRequestId: humanRequestId,
        retryAttempt: 2,
        execution: executionTuple,
      });
      expect(await fixture.runs()).toHaveLength(1);
      expect(fixture.threadIds()).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

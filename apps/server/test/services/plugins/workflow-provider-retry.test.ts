import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getLatestThreadSequence,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@omnyo/db";
import { turnRequestEventDataSchema } from "@omnyo/domain";
import { createNodeOmnyoSdk } from "@omnyo/sdk";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
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
  seedThread,
} from "../../helpers/seed.js";
import { startTestServer } from "../../helpers/test-app.js";

const EXECUTION = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
  serviceTier: "default",
  permissionMode: "accept-edits",
} as const;

type WorkflowApi = ReturnType<typeof createFakePluginHost>["api"];

type WorkflowDatabase = ReturnType<WorkflowApi["storage"]["database"]>;

interface WorkflowDataModule {
  migrations: Parameters<WorkflowApi["storage"]["migrate"]>[1];
  getCall(
    db: WorkflowDatabase,
    runId: string,
    index: number,
  ): { status: string; childThreadId: string | null; error: string | null };
  getRunRequired(
    db: WorkflowDatabase,
    runId: string,
  ): { status: string; resultJson: string | null };
}

interface WorkflowServiceModule {
  createWorkflowService(
    api: WorkflowApi,
    db: WorkflowDatabase,
    settings: undefined,
    options: { failedWorkerCheckDelayMs: number },
  ): {
    onThreadFailed(threadId: string, error: string | null): void;
    onThreadIdle(threadId: string, output: string | null): void;
    runWorker(signal: AbortSignal): Promise<void>;
    start(args: {
      projectId: string;
      originThreadId: string;
      source: string;
      args: null;
      resumedFromRunId: null;
    }): Promise<{ id: string }>;
  };
}

type PluginModule = { default(api: PluginApi): Promise<void> };

const pluginSource = (path: string) =>
  new URL(`../../../../../plugins/${path}`, import.meta.url).pathname;

async function eventually(check: () => void | Promise<void>): Promise<void> {
  let lastError: unknown;
  const deadline = performance.now() + 5_000;

  while (performance.now() < deadline) {
    try {
      await check();

      return;
    } catch (error) {
      lastError = error;
    }

    await delay(10);
  }

  throw lastError;
}

async function createFixture() {
  const [data, service, providerRetryModule] = await Promise.all([
    vi.importActual<WorkflowDataModule>(pluginSource("workflows/src/data.ts")),
    vi.importActual<WorkflowServiceModule>(
      pluginSource("workflows/src/service.ts"),
    ),
    vi.importActual<PluginModule>(pluginSource("provider-retry/server.ts")),
  ]);

  const server = await startTestServer();
  const { host, session } = seedHostSession(server.deps);
  const path = "/tmp/workflow-provider-retry-project";

  const { project } = seedProjectWithSource(server.deps, {
    hostId: host.id,
    path,
  });

  const environment = seedEnvironment(server.deps, {
    hostId: host.id,
    projectId: project.id,
    path,
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

  const origin = seedThread(server.deps, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: EXECUTION.providerId,
  });

  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:05.000Z"));
  const sdk = createNodeOmnyoSdk({ baseUrl: server.baseUrl });
  const workers: string[] = [];
  let queueReads = 0;

  const workflowHost = createFakePluginHost({
    pluginId: "workflows",
    dataDir: join(server.config.dataDir, "workflows-test-runtime"),
    sdk: {
      threads: {
        get: sdk.threads.get,
        queue: {
          async list(args: Parameters<typeof sdk.threads.queue.list>[0]) {
            queueReads += 1;

            return sdk.threads.queue.list(args);
          },
        },
        defaultExecutionOptions: async () => ({
          model: EXECUTION.model,
          reasoningLevel: EXECUTION.reasoningLevel,
          permissionMode: EXECUTION.permissionMode,
          serviceTier: EXECUTION.serviceTier,
          source: "default",
        }),
        async spawn(args: Parameters<typeof sdk.threads.spawn>[0]) {
          if (args.prompt === undefined)
            throw new Error("Workflows spawned a worker without a prompt");

          const worker = await sdk.threads.spawn({
            projectId: project.id,
            environment: { type: "reuse", environmentId: environment.id },
            prompt: args.prompt,
            ...EXECUTION,
            origin: "app",
          });

          workers.push(worker.id);

          return worker;
        },
        send: async () => ({ ok: true }),
        stop: async () => ({ ok: true }),
        archive: async ({ threadId }) => ({ archivedThreadIds: [threadId] }),
      },
      environments: {
        get: async ({ environmentId }) =>
          ({
            id: environmentId,
            projectId: project.id,
            hostId: host.id,
            path,
            status: "ready",
            lifecycle: { phase: "active" },
            hostLifecycle: "active",
          }) as never,
      },
      providers: {
        list: async () => [
          {
            id: EXECUTION.providerId,
            displayName: "Codex",
            logoUrl: null,
            available: true,
            capabilities: {
              supportsThreadArchive: true,
              supportsThreadRename: true,
              supportsServiceTier: true,
              supportsNativeUserQuestion: false,
              supportsFork: true,
              permissionModes: [EXECUTION.permissionMode],
            },
            composerActions: [],
          },
        ],
        models: async () => ({
          providers: [],
          selectedOnlyModels: [],
          modelLoadError: null,
          models: [
            {
              id: EXECUTION.model,
              model: EXECUTION.model,
              displayName: "Fixture",
              description: "Fixture",
              supportedReasoningEfforts: [
                {
                  reasoningEffort: EXECUTION.reasoningLevel,
                  description: "Fixture",
                },
              ],
              defaultReasoningEffort: EXECUTION.reasoningLevel,
              isDefault: true,
            },
          ],
        }),
      },
    },
  });

  const providerRetry = createFakePluginHost({
    pluginId: "provider-retry",
    dataDir: join(server.config.dataDir, "provider-retry-test-runtime"),
    sdk: {
      plugins: {
        experimental_discoverRpc: sdk.plugins.experimental_discoverRpc,
        callRpc: sdk.plugins.callRpc,
      },
      threads: {
        get: sdk.threads.get,
        retry: sdk.threads.retry,
        queue: { list: sdk.threads.queue.list },
      },
      experimental_inbox: {
        declineRetry: sdk.experimental_inbox.declineRetry,
      },
    },
  });

  const workflowDb = workflowHost.api.storage.database();
  workflowHost.api.storage.migrate(workflowDb, data.migrations);

  const failedWorkerCheckDelayMs = 20;

  const workflow = service.createWorkflowService(
    workflowHost.api,
    workflowDb,
    undefined,
    { failedWorkerCheckDelayMs },
  );

  const controller = new AbortController();
  let worker: Promise<void> | undefined;

  const close = async () => {
    controller.abort();
    await worker;
    await providerRetry.harness.dispose();
    await workflowHost.harness.dispose();
    vi.useRealTimers();
    await server.close();
  };

  try {
    await providerRetryModule.default(providerRetry.api);
    worker = workflow.runWorker(controller.signal);

    const run = await workflow.start({
      projectId: project.id,
      originThreadId: origin.id,
      source:
        'export const meta = { name: "retry-in-place", description: "Fixture" }; return await agent("fixture");',
      args: null,
      resumedFromRunId: null,
    });

    await eventually(() => {
      expect(workers).toHaveLength(1);
      expect(data.getCall(workflowDb, run.id, 0).status).toBe("running");
      expect(getThread(server.db, workers[0]!)?.status).toBe("active");
    });
    const workerId = workers[0]!;

    const requests = () =>
      listEvents(server.db, { threadId: workerId })
        .filter((event) => event.type === "client/turn/requested")
        .map((event) =>
          turnRequestEventDataSchema.parse(JSON.parse(event.data)),
        );

    const advancePastCheck = async () => {
      const before = queueReads;
      await eventually(() => {
        vi.setSystemTime(Date.now() + failedWorkerCheckDelayMs);
        expect(queueReads).toBeGreaterThan(before);
      });
    };

    const fail = async (overloaded: boolean) => {
      seedEvent(server.deps, {
        environmentId: environment.id,
        threadId: workerId,
        providerThreadId: `provider-${workerId}`,
        sequence:
          getLatestThreadSequence(server.db, { threadId: workerId }) + 1,
        type: "provider/error",
        scope: { kind: "thread" },
        data: {
          providerThreadId: `provider-${workerId}`,
          message: overloaded ? "Selected model is at capacity" : "Task failed",
          errorInfo: {
            category: overloaded ? "overloaded" : "unknown",
            providerCode: null,
            httpStatusCode: overloaded ? 503 : null,
          },
        },
      });
      expect(
        applyLoggedThreadLifecycleEvent(server.deps, {
          threadId: workerId,
          event: { type: "run.failed" },
        }).applied,
      ).toBe(true);
      const failed = buildTurnFailedEvent(server.db, workerId);

      if (failed === null) throw new Error("Expected core turn.failed facts");
      workflow.onThreadFailed(
        workerId,
        overloaded ? "Selected model is at capacity" : "Task failed",
      );
      expect(
        await providerRetry.harness.emitThreadEvent("turn.failed", failed),
      ).toEqual({ errors: [] });
    };

    return {
      server,
      workflowDb,
      data,
      run,
      workerId,
      workers,
      requests,
      fail,
      advancePastCheck,
      async dispatchRetry() {
        const row = listQueuedThreadMessages(server.db, workerId)[0];

        if (row?.sendAt === null || row?.sendAt === undefined)
          throw new Error("Expected a scheduled provider retry");
        vi.setSystemTime(Math.max(Date.now(), row.sendAt));
        await runQueuedMessageDispatch(server.deps, {
          kind: "time-reached",
          now: Date.now(),
        });
        await eventually(() =>
          expect(getThread(server.db, workerId)?.status).toBe("active"),
        );
      },
      succeed(output: string) {
        expect(
          applyLoggedThreadLifecycleEvent(server.deps, {
            threadId: workerId,
            event: { type: "run.succeeded" },
          }).applied,
        ).toBe(true);
        workflow.onThreadIdle(workerId, output);
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("workflow workers and provider retry", () => {
  it("continues an overloaded worker in place and settles the call when the retry succeeds", async () => {
    const fixture = await createFixture();

    try {
      const { server, workerId } = fixture;
      const [original] = fixture.requests();

      await fixture.fail(true);
      const queued = listQueuedThreadMessages(server.db, workerId);
      expect(queued).toHaveLength(1);
      expect(toThreadQueuedMessage(queued[0]!).payload).toMatchObject({
        kind: "retry",
        retryOfTurnRequestId: original?.requestId,
        attempt: 2,
        reason: "Provider overloaded",
      });

      await fixture.advancePastCheck();
      expect(
        fixture.data.getCall(fixture.workflowDb, fixture.run.id, 0),
      ).toMatchObject({ status: "running", childThreadId: workerId });

      await fixture.dispatchRetry();
      expect(fixture.requests()).toHaveLength(2);
      expect(fixture.requests()[1]).toMatchObject({
        retryOfRequestId: original?.requestId,
      });

      fixture.succeed("recovered");
      await eventually(() =>
        expect(
          fixture.data.getRunRequired(fixture.workflowDb, fixture.run.id),
        ).toMatchObject({ status: "succeeded", resultJson: '"recovered"' }),
      );
      expect(fixture.workers).toEqual([workerId]);
    } finally {
      await fixture.close();
    }
  });

  it("fails the call with the worker's error once provider retry declines", async () => {
    const fixture = await createFixture();

    try {
      const { server, workerId } = fixture;

      await fixture.fail(false);
      expect(listQueuedThreadMessages(server.db, workerId)).toHaveLength(0);

      await fixture.advancePastCheck();
      await eventually(() =>
        expect(
          fixture.data.getCall(fixture.workflowDb, fixture.run.id, 0),
        ).toMatchObject({
          status: "failed",
          childThreadId: workerId,
          error: "Task failed",
        }),
      );
      expect(fixture.requests()).toHaveLength(1);
      expect(fixture.workers).toEqual([workerId]);
    } finally {
      await fixture.close();
    }
  });
});

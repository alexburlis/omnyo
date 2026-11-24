import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLatestThreadSequence, getThread } from "@omnyo/db";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { createPluginService } from "../../../src/services/plugins/plugin-service.js";
import { setPluginThreadEventEmitter } from "../../../src/services/plugins/plugin-thread-events.js";
import { applyTurnCompletedEvent } from "../../../src/internal/turn-completed-events.js";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";
import { openSecretVault } from "@omnyo/secret-storage";

type WorkflowApi = ReturnType<typeof createFakePluginHost>["api"];

type WorkflowDatabase = ReturnType<WorkflowApi["storage"]["database"]>;

interface WorkflowDataFixture {
  migrations: Parameters<WorkflowApi["storage"]["migrate"]>[1];
  getCall(db: WorkflowDatabase, runId: string, index: number): unknown;
}

interface WorkflowServiceFixture {
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

const dataModule: unknown = await import(
  new URL("../../../../../plugins/workflows/src/data.ts", import.meta.url).href
);

const serviceModule: unknown = await import(
  new URL("../../../../../plugins/workflows/src/service.ts", import.meta.url)
    .href
);

if (
  typeof dataModule !== "object" ||
  dataModule === null ||
  !("migrations" in dataModule) ||
  !Array.isArray(dataModule.migrations) ||
  !("getCall" in dataModule) ||
  typeof dataModule.getCall !== "function" ||
  typeof serviceModule !== "object" ||
  serviceModule === null ||
  !("createWorkflowService" in serviceModule) ||
  typeof serviceModule.createWorkflowService !== "function"
)
  throw new Error(
    "Actual Workflows source did not expose its fixture contract",
  );

const { migrations, getCall } = dataModule as WorkflowDataFixture;

const { createWorkflowService } = serviceModule as WorkflowServiceFixture;

it.each([
  {
    message: "HTTP 502: Bad Gateway",
    earlierProviderError: false,
    nextRequest: false,
    oldError: false,
  },
  {
    message: "HTTP 503: Service Unavailable",
    earlierProviderError: false,
    nextRequest: false,
    oldError: true,
  },
  {
    message: "Policy refusal",
    earlierProviderError: true,
    nextRequest: false,
    oldError: true,
  },
  {
    message: "HTTP 503: Service Unavailable",
    earlierProviderError: false,
    nextRequest: true,
    oldError: true,
  },
])(
  "routes the persisted current terminal cause into workflow settlement: $message, next request $nextRequest",
  async ({ message, earlierProviderError, nextRequest, oldError }) => {
    await withTestHarness(async (harness) => {
      const root = await mkdtemp(join(tmpdir(), "omnyo-workflow-cause-"));
      const { host } = seedHostSession(harness.deps);

      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
        path: root,
      });

      const environment = seedEnvironment(harness.deps, {
        hostId: host.id,
        projectId: project.id,
        path: root,
      });

      const origin = seedThread(harness.deps, {
        projectId: project.id,
        environmentId: environment.id,
      });

      const children: string[] = [];

      const workflowHost = createFakePluginHost({
        pluginId: "workflows",
        sdk: {
          threads: {
            get: async ({ threadId }) =>
              makeThreadResponse({
                id: threadId,
                projectId: project.id,
                environmentId: environment.id,
                providerId: "codex",
                status:
                  getThread(harness.db, threadId)?.status === "error"
                    ? "error"
                    : "idle",
              }),
            queue: { list: async () => [] },
            defaultExecutionOptions: async () => ({
              model: "gpt-fixture",
              reasoningLevel: "medium",
              permissionMode: "full",
              serviceTier: "default",
              source: "default",
            }),
            spawn: async () => {
              const child = seedThread(harness.deps, {
                projectId: project.id,
                environmentId: environment.id,
                status: "active",
              });

              if (oldError)
                seedEvent(harness.deps, {
                  threadId: child.id,
                  sequence: 1,
                  scope: { kind: "thread" },
                  type: "system/error",
                  data: {
                    code: "old",
                    message: "HTTP 500: Old unrelated failure",
                  },
                });
              seedThreadRuntimeState(harness.deps, {
                threadId: child.id,
                environmentId: environment.id,
                providerThreadId: "provider-fixture",
                sequenceStart: 2,
              });
              seedTurnStarted(harness.deps, {
                threadId: child.id,
                environmentId: environment.id,
                turnId: "turn-fixture",
                providerThreadId: "provider-fixture",
              });
              children.push(child.id);

              return makeThreadResponse({
                id: child.id,
                projectId: project.id,
                environmentId: environment.id,
                providerId: "codex",
                status: "active",
              });
            },
            send: async () => ({ ok: true }),
            stop: async () => ({ ok: true }),
            archive: async ({ threadId }) => ({
              archivedThreadIds: [threadId],
            }),
          },
          environments: {
            get: async ({ environmentId }) =>
              ({
                id: environmentId,
                projectId: project.id,
                hostId: host.id,
                path: root,
                status: "ready",
                lifecycle: { phase: "active" },
                hostLifecycle: "active",
              }) as never,
          },
          providers: {
            list: async () => [
              {
                id: "codex",
                displayName: "Codex",
                logoUrl: null,
                available: true,
                capabilities: {
                  supportsThreadArchive: true,
                  supportsThreadRename: true,
                  supportsServiceTier: true,
                  supportsNativeUserQuestion: false,
                  supportsFork: true,
                  permissionModes: ["full"],
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
                  id: "gpt-fixture",
                  model: "gpt-fixture",
                  displayName: "Fixture",
                  description: "Fixture",
                  supportedReasoningEfforts: [
                    { reasoningEffort: "medium", description: "Fixture" },
                  ],
                  defaultReasoningEffort: "medium",
                  isDefault: true,
                },
              ],
            }),
          },
        },
      });

      const workflowDb = workflowHost.api.storage.database();
      workflowHost.api.storage.migrate(workflowDb, migrations);

      const workflow = createWorkflowService(
        workflowHost.api,
        workflowDb,
        undefined,
        { failedWorkerCheckDelayMs: 20 },
      );

      const core = createPluginService({
        db: harness.db,
        hub: harness.deps.hub,
        logger: harness.deps.logger,
        providerRegistry: harness.deps.providerRegistry,
        aiServices: createAiServiceRegistry(),
        telemetry: createNoopTelemetryService(),
        dataDir: join(root, "data"),
        vault: await openSecretVault(join(root, "data")),
        appVersion: "0.46.0",
      });

      const observerRoot = join(root, "omnyo-plugin-cause-observer");
      await mkdir(observerRoot);
      await writeFile(
        join(observerRoot, "package.json"),
        JSON.stringify({
          name: "omnyo-plugin-cause-observer",
          version: "0.1.0",
          omnyo: {
            name: "Cause observer",
            description: "Fixture",
            branding: { icon: "Zap" },
            server: "./server.js",
          },
        }),
      );
      await writeFile(
        join(observerRoot, "server.js"),
        "export default function plugin() {}\n",
      );
      const controller = new AbortController();
      let worker: Promise<void> | undefined;

      try {
        await core.installPath(observerRoot);
        const observer = core.getApi("cause-observer");

        if (observer === undefined) throw new Error("Observer did not load");
        const observed: Array<string | null> = [];
        observer.events.on("thread.failed", ({ thread, error }) => {
          observed.push(error);
          workflow.onThreadFailed(thread.id, error);
        });
        observer.events.on("thread.idle", ({ thread, lastAssistantText }) =>
          workflow.onThreadIdle(thread.id, lastAssistantText),
        );
        setPluginThreadEventEmitter(core.events);
        worker = workflow.runWorker(controller.signal);

        const run = await workflow.start({
          projectId: project.id,
          originThreadId: origin.id,
          source:
            'export const meta = { name: "terminal-cause", description: "Fixture" }; return await agent("fixture");',
          args: null,
          resumedFromRunId: null,
        });

        await vi.waitFor(() => expect(children).toHaveLength(1));
        const childId = children[0];

        if (childId === undefined) throw new Error("Expected a worker");

        if (earlierProviderError)
          seedEvent(harness.deps, {
            threadId: childId,
            environmentId: environment.id,
            sequence:
              getLatestThreadSequence(harness.db, { threadId: childId }) + 1,
            type: "provider/error",
            scope: { kind: "turn", turnId: "turn-fixture" },
            data: {
              providerThreadId: "provider-fixture",
              message: "HTTP 502: Earlier transient provider failure",
            },
          });

        const payload = {
          type: "turn/completed" as const,
          threadId: childId,
          providerThreadId: "provider-fixture",
          scope: { kind: "turn" as const, turnId: "turn-fixture" },
          status: "failed" as const,
          error: { message },
        };

        seedEvent(harness.deps, {
          threadId: childId,
          environmentId: environment.id,
          sequence:
            getLatestThreadSequence(harness.db, { threadId: childId }) + 1,
          type: payload.type,
          scope: payload.scope,
          data: {
            providerThreadId: payload.providerThreadId,
            status: payload.status,
            error: payload.error,
          },
        });
        applyTurnCompletedEvent(harness.deps, { afterIdle: null, payload });

        if (nextRequest)
          seedThreadRuntimeState(harness.deps, {
            threadId: childId,
            environmentId: environment.id,
            providerThreadId: "provider-fixture",
            sequenceStart:
              getLatestThreadSequence(harness.db, { threadId: childId }) + 1,
            inputText: "Subsequent request",
          });
        await vi.waitFor(() => expect(observed).toEqual([message]));

        await vi.waitFor(() =>
          expect(getCall(workflowDb, run.id, 0)).toMatchObject({
            status: "failed",
            providerRetryAttempts: 0,
            error: message,
          }),
        );
        expect(children).toHaveLength(1);
      } finally {
        controller.abort();
        await worker;
        setPluginThreadEventEmitter(undefined);
        await core.stop();
        await workflowHost.harness.dispose();
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);

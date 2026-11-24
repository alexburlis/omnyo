import * as processErrorReporting from "@omnyo/process-utils/error-reporting";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime, AgentRuntimeOptions } from "@omnyo/agent-runtime";
import { createScriptedEchoRuntime } from "@omnyo/agent-runtime/test";
import {
  threadScope,
  turnScope,
  type PendingInteractionCreate,
  type ToolCallRequest,
} from "@omnyo/domain";
import {
  hostDaemonEventBatchRequestSchema,
  hostDaemonInteractiveInterruptRequestSchema,
  type HostDaemonInteractiveRequestKey,
  type HostDaemonInteractiveRequestResponse,
  type HostDaemonContributedEnvEntry,
} from "@omnyo/host-daemon-contract";
import type { HostWatcher } from "@omnyo/host-watcher";
import { setProcessErrorReportingEnabled } from "@omnyo/process-utils/error-reporting";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISPATCH_TEST_BRIDGE_LAUNCH,
  DISPATCH_TEST_ARTIFACT_BYTES,
  dispatchTestRuntimeBridgeLaunch,
} from "../test/command/dispatch-helpers.js";
import {
  createHostDaemonApp,
  startIdleProviderSessionReaper,
  type HostDaemonApp,
} from "./app.js";
import { InteractiveRequestRegistry } from "./interactive-request-registry.js";
import type { HostDaemonLogger } from "./logger.js";
import type {
  RuntimeManagerReapIdleProviderSessionsArgs,
  RuntimeManagerReapIdleProviderSessionsResult,
} from "./runtime-manager.js";
import type { FetchFn } from "./server-client.js";
import type { CreateReconnectingWebSocket } from "./server-connection.js";
import type { ReconnectingWebSocketLike } from "./server-connection-support.js";
import { MACHINE_SUSPENSION_MARKER } from "./suspension-marker.js";

interface RecordedFetchRequest {
  body: string | null;
  method: string;
  pathname: string;
}

interface FetchRecorder {
  fetchFn: FetchFn;
  requests: RecordedFetchRequest[];
}

interface CreateFetchRecorderArgs {
  machineEnvironment?: HostDaemonContributedEnvEntry[];
  toolCallResponse?: (
    signal: AbortSignal | null | undefined,
  ) => Promise<Response>;
  inactiveSessionOnFirstEventPost?: boolean;
  interactiveRequestError?: Error;
  interactiveRequestResponse?: HostDaemonInteractiveRequestResponse;
  interruptResponses?: Array<() => Response>;
  retiredEnvironmentIds?: string[];
  endedInteractiveRequestsOnReconnect?: HostDaemonInteractiveRequestKey[];
  sessionIds?: string[];
}

interface RuntimeOptionsRef {
  current: AgentRuntimeOptions | null;
}

interface HostDaemonAppFixture {
  app: HostDaemonApp;
  dataDir: string;
  fetchRecorder: FetchRecorder;
  logger: ReturnType<typeof createLogger>;
  runtimeOptions: RuntimeOptionsRef;
}

type StartIdleProviderSessionReaperArgsForTest = Parameters<
  typeof startIdleProviderSessionReaper
>[0];

const tempDirs: string[] = [];

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } satisfies HostDaemonLogger;
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);

  return dir;
}

function readFetchUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }

  if (input instanceof URL) {
    return input;
  }

  return new URL(input.url);
}

function readFetchBody(init: RequestInit | undefined): string | null {
  const body = init?.body;

  if (body === undefined || body === null) {
    return null;
  }

  if (typeof body === "string") {
    return body;
  }

  throw new Error("Expected string request body");
}

function createFetchRecorder(
  args: CreateFetchRecorderArgs = {},
): FetchRecorder {
  const requests: RecordedFetchRequest[] = [];
  let eventPostCount = 0;
  let interruptCount = 0;
  let sessionOpenCount = 0;

  const fetchFn: FetchFn = async (input, init) => {
    const url = readFetchUrl(input);

    const request = {
      body: readFetchBody(init),
      method: init?.method ?? "GET",
      pathname: url.pathname,
    };

    requests.push(request);

    if (url.pathname === "/internal/session/tool-call") {
      if (args.toolCallResponse) return args.toolCallResponse(init?.signal);
    }

    if (url.pathname === "/internal/session/open") {
      const sessionId =
        args.sessionIds?.[sessionOpenCount] ??
        args.sessionIds?.at(-1) ??
        "session-app-test";

      sessionOpenCount += 1;

      return Response.json(
        {
          sessionId,
          diagnosticsPolicy: { revision: 0, crashReportsEnabled: false },
          machineEnvironment: {
            revision: 0,
            entries: args.machineEnvironment ?? [],
          },
          heartbeatIntervalMs: 30000,
          leaseTimeoutMs: 90000,
          retiredEnvironmentIds: args.retiredEnvironmentIds ?? [],
          endedInteractiveRequests:
            sessionOpenCount > 1
              ? (args.endedInteractiveRequestsOnReconnect ?? [])
              : [],
        },
        { status: 201 },
      );
    }

    if (url.pathname === "/internal/session/events") {
      eventPostCount += 1;

      if (args.inactiveSessionOnFirstEventPost && eventPostCount === 1) {
        return Response.json(
          {
            code: "inactive_session",
            message: "Session is not active",
            retryable: false,
          },
          { status: 401 },
        );
      }

      return Response.json({
        acceptedEvents: [],
        rejectedEvents: [],
      });
    }

    if (url.pathname === "/internal/session/interactive-request") {
      if (args.interactiveRequestError) {
        throw args.interactiveRequestError;
      }

      const response: HostDaemonInteractiveRequestResponse =
        args.interactiveRequestResponse ?? {
          outcome: "created",
          interactionId: "pint_app_test",
          status: "pending",
        };

      return Response.json(response);
    }

    if (url.pathname === "/internal/session/interactive-request/interrupt") {
      const scripted = args.interruptResponses?.[interruptCount];
      interruptCount += 1;

      if (scripted) {
        return scripted();
      }

      return Response.json({
        ok: true,
        interactionIds: ["pint_app_test"],
      });
    }

    if (
      /^\/internal\/plugins\/[^/]+\/host\/[a-f0-9]{64}$/u.test(url.pathname)
    ) {
      return new Response(new Uint8Array(DISPATCH_TEST_ARTIFACT_BYTES), {
        status: 200,
        headers: {
          "content-length": String(DISPATCH_TEST_ARTIFACT_BYTES.byteLength),
        },
      });
    }

    return new Response(`Unhandled test request: ${url.pathname}`, {
      status: 500,
    });
  };

  return {
    fetchFn,
    requests,
  };
}

function createOpeningWebSocket(
  onCreate?: (socket: ReconnectingWebSocketLike) => void,
): CreateReconnectingWebSocket {
  return (urlProvider) => {
    let readyState = 0;

    const socket: ReconnectingWebSocketLike = {
      get readyState() {
        return readyState;
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: vi.fn(),
      close: vi.fn(() => {
        readyState = 3;
      }),
      reconnect: vi.fn(),
    };

    const openSocket = async () => {
      await urlProvider();
      queueMicrotask(() => {
        readyState = 1;
        socket.onopen?.({ type: "open" });
      });
    };

    socket.reconnect = vi.fn(() => {
      readyState = 3;
      socket.onclose?.({ code: 1000, reason: "test-reconnect" });
      void openSocket();
    });
    onCreate?.(socket);
    void openSocket();

    return socket;
  };
}

function createFakeRuntime(): AgentRuntime {
  return {
    async ensureProvider() {},
    async startThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async prepareThreadRewind() {
      return { providerThreadId: "provider-thread-rewind-app-test" };
    },
    async discardThreadRewind() {},
    async resumeThread() {
      return { providerThreadId: "provider-thread-app-test" };
    },
    async runTurn() {
      return { status: "started" };
    },
    async steerTurn() {
      return { status: "steered" };
    },
    async stopThread() {
      return { providerCheckpointId: null };
    },
    async setThreadSpeed() {},
    async clearThreadGoal() {
      return { cleared: true };
    },
    async renameThread() {},
    async archiveThread() {},
    async unarchiveThread() {},
    async listModels() {
      return {
        models: [],
        selectedOnlyModels: [],
      };
    },
    async providerHealth() {
      return { supported: false as const };
    },
    async providerUsage() {
      return { supported: false as const };
    },
    async providerInstallationStatus() {
      throw new Error("Unexpected provider installation status call");
    },
    async providerInstallationRun() {
      throw new Error("Unexpected provider installation run call");
    },
    listRunningProviders() {
      return [];
    },
    getActiveTurnId() {
      return null;
    },
    async waitForActiveTurn() {
      return null;
    },
    getProviderSession() {
      return null;
    },
    async reapIdleProviderSessions() {
      return { reapedSessions: [], retainedSessions: [] };
    },
    hasThread() {
      return false;
    },
    getLiveThreadIds() {
      return [];
    },
    hasOpenBackgroundWork() {
      return false;
    },
    listOpenBackgroundWork() {
      return [];
    },
    async shutdown() {},
  };
}

function createFakeRuntimeWithModelList(
  listModels: AgentRuntime["listModels"],
): AgentRuntime {
  return {
    ...createFakeRuntime(),
    listModels,
  };
}

function createCommandApprovalRequest(): PendingInteractionCreate {
  return {
    threadId: "thr_app_interactive",
    turnId: "turn_app_interactive",
    providerId: "codex",
    providerThreadId: "provider-thread-app-interactive",
    providerRequestId: "provider-request-app-interactive",
    payload: {
      kind: "approval",
      subject: {
        kind: "command",
        itemId: "item-app-interactive",
        command: "git status",
        cwd: "/tmp/project",
        actions: [],
        sessionGrant: null,
      },
      reason: "Needs approval",
      availableDecisions: ["allow_once", "deny"],
    },
  };
}

function createToolCallRequest(): ToolCallRequest {
  return {
    requestId: "provider-tool-request-app-test",
    threadId: "thr_app_tool",
    providerThreadId: "provider-thread-app-tool",
    turnId: "turn_app_tool",
    callId: "call-app-tool",
    tool: "message_user",
    arguments: {
      text: "hello",
    },
  };
}

async function settleReaperPromiseChain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createAppFixture(
  args: CreateFetchRecorderArgs = {},
  options: {
    closeMachineAuthProxy?: () => Promise<void>;
    createWebSocket?: CreateReconnectingWebSocket;
    exitProcess?: (code: number) => void;
    uncertainInstaller?: boolean;
    createRuntime?: (options: AgentRuntimeOptions) => AgentRuntime;
  } = {},
): Promise<HostDaemonAppFixture> {
  const dataDir = await makeTempDir("omnyo-host-daemon-app-test-");

  if (options.uncertainInstaller)
    await fs.writeFile(
      path.join(dataDir, "host-daemon-update-attempt.json"),
      JSON.stringify({
        attemptedAt: Date.now(),
        attemptCount: 1,
        protocolVersion: 999,
        version: "9.0.0+private.1",
        installer: {
          treeTermination: "unverified",
          processGroupId: null,
          processPlatform: process.platform,
        },
      }),
    );
  const fetchRecorder = createFetchRecorder(args);
  const logger = createLogger();
  const runtimeOptions: RuntimeOptionsRef = { current: null };

  const app = await createHostDaemonApp({
    dataDir,
    serverUrl: "http://127.0.0.1:3334",
    hostKey: "host-key-app-test",
    hostId: "host-app-test",
    hostName: "App Test Host",
    instanceId: "instance-app-test",
    logger,
    releaseLock: async () => undefined,
    localApiConfig: null,
    createRuntime: (runtimeArgs) => {
      runtimeOptions.current = runtimeArgs;

      return options.createRuntime?.(runtimeArgs) ?? createFakeRuntime();
    },
    fetchFn: fetchRecorder.fetchFn,
    createWebSocket: options.createWebSocket ?? createOpeningWebSocket(),
    ...(options.exitProcess ? { exitProcess: options.exitProcess } : {}),
    ...(options.closeMachineAuthProxy
      ? { closeMachineAuthProxy: options.closeMachineAuthProxy }
      : {}),
  });

  return {
    app,
    dataDir,
    fetchRecorder,
    logger,
    runtimeOptions,
  };
}

describe("createHostDaemonApp", () => {
  it.each([1, 2])(
    "interrupts only the stopped thread's interactive waiter with %i provider threads",
    async (threadCount) => {
      const interruptedThreads = vi.spyOn(
        InteractiveRequestRegistry.prototype,
        "interruptThreads",
      );

      const runtimeRef: {
        current: ReturnType<typeof createScriptedEchoRuntime> | null;
      } = { current: null };

      const pending = new Map<string, Promise<unknown>>();

      const { app, fetchRecorder } = await createAppFixture(
        {},
        {
          createRuntime: (options) => {
            const onInteractiveRequest = options.onInteractiveRequest;

            if (!onInteractiveRequest)
              throw new Error("Expected interaction callback");

            const runtime = createScriptedEchoRuntime({
              runtime: {
                ...options,
                onInteractiveRequest: (request) => {
                  const waiter = onInteractiveRequest(request);
                  pending.set(request.threadId, waiter);

                  return waiter;
                },
              },
            });

            runtimeRef.current = runtime;

            return runtime;
          },
        },
      );

      try {
        await app.connection.start();
        await app.runtimeManager.ensureEnvironment({
          environmentId: "env-stop-interaction",
          workspacePath: await makeTempDir("omnyo-stop-interaction-"),
        });
        const runtime = runtimeRef.current;

        if (!runtime) throw new Error("Expected real runtime");

        const options = {
          model: "test-model",
          serviceTier: "default",
          reasoningLevel: "medium",
          providerOptions: {},
          permissionMode: "full",
          permissionScope: "full",
          approvalReviewer: null,
          permissionEscalation: null,
        } as const;

        for (let i = 1; i <= threadCount; i++) {
          const threadId = `stop-interaction-${i}`;
          await runtime.startThread({
            environmentId: "env-stop-interaction",
            threadId,
            projectId: "p1",
            providerId: "fake",
            options,
          });
          await runtime.runTurn({
            clientRequestId: `creq_22222222${i === 1 ? "4h" : "4j"}`,
            threadId,
            input: [
              { type: "text", text: "approve:command ship it", mentions: [] },
            ],
            options,
          });
        }

        await vi.waitFor(() => expect(pending.size).toBe(threadCount));
        expect(runtime.listRunningProviders()).toHaveLength(1);
        const stoppedWaiter = pending.get("stop-interaction-1");

        if (!stoppedWaiter) throw new Error("Expected stopped thread waiter");
        let stoppedError: unknown = null;
        void stoppedWaiter.catch((error: unknown) => {
          stoppedError = error;
        });
        let peerSettled = false;
        void pending.get("stop-interaction-2")?.then(
          () => {
            peerSettled = true;
          },
          () => {
            peerSettled = true;
          },
        );
        await runtime.stopThread({ threadId: "stop-interaction-1" });
        await vi.waitFor(() => expect(stoppedError).toBeInstanceOf(Error), {
          timeout: 500,
        });
        expect(stoppedError).toHaveProperty(
          "message",
          'Provider "fake" detached thread while awaiting user interaction',
        );
        expect(peerSettled).toBe(false);
        const registry = interruptedThreads.mock.contexts[0];

        if (!(registry instanceof InteractiveRequestRegistry))
          throw new Error("Expected live interaction registry");
        expect(registry.getDirectAccessActivityCount()).toBe(threadCount - 1);
        expect(runtime.listRunningProviders()).toHaveLength(threadCount - 1);
        await vi.waitFor(() =>
          expect(
            fetchRecorder.requests.filter(
              (record) =>
                record.pathname ===
                "/internal/session/interactive-request/interrupt",
            ),
          ).toHaveLength(1),
        );

        const interrupt = fetchRecorder.requests.find(
          (record) =>
            record.pathname ===
            "/internal/session/interactive-request/interrupt",
        );

        if (!interrupt?.body) throw new Error("Expected interrupt envelope");
        expect(
          hostDaemonInteractiveInterruptRequestSchema.parse(
            JSON.parse(interrupt.body),
          ),
        ).toMatchObject({
          providerId: "fake",
          threadIds: ["stop-interaction-1"],
          requests: [{ threadId: "stop-interaction-1" }],
        });
      } finally {
        await app.daemon.shutdown("test", 0);
      }
    },
  );
  it("restores uncertain installer admission before connecting without stealing a foreign owner", async () => {
    const { app } = await createAppFixture({}, { uncertainInstaller: true });

    try {
      const denied = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "foreign-startup-hold",
        command: {
          type: "runtime_update.acquire",
          ownerId: "foreign-owner",
          closePluginLeases: [],
        },
      });

      expect(denied.ok).toBe(false);

      const own = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "own-startup-hold",
        command: {
          type: "runtime_update.acquire",
          ownerId: "self-update:instance-app-test",
          closePluginLeases: [],
        },
      });

      expect(own).toMatchObject({ ok: true, result: { held: true } });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it.each([
    { hold: "runtime_update_held", kind: "terminal.open" },
    { hold: "runtime_update_held", kind: "terminal.attach" },
    { hold: "direct_access_held", kind: "terminal.open" },
    { hold: "direct_access_held", kind: "terminal.attach" },
  ] as const)(
    "settles $kind with an expected $hold admission refusal",
    async ({ hold, kind }) => {
      let socket: ReconnectingWebSocketLike | undefined;

      const { app, logger } = await createAppFixture(
        {},
        {
          createWebSocket: createOpeningWebSocket((opened) => {
            socket = opened;
          }),
        },
      );

      try {
        await app.connection.start();

        if (!socket) throw new Error("Expected test socket");

        const held = await app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "hold-before-terminal",
          command:
            hold === "runtime_update_held"
              ? {
                  type: "runtime_update.acquire",
                  ownerId: "terminal-admission-test",
                  closePluginLeases: [],
                }
              : {
                  type: "server_access.probe_direct",
                  challenge: "terminal-admission-test",
                  instanceId: "test-coordinator",
                  serverUrl: "https://direct.example.test",
                },
        });

        if (hold === "runtime_update_held")
          expect(held).toMatchObject({ ok: true, result: { held: true } });
        else expect(held).toMatchObject({ ok: false });
        logger.warn.mockClear();
        logger.error.mockClear();
        const send = vi.spyOn(socket, "send");
        const terminalId = "term-admission-test";
        const requestId = "terminal-admission-request";

        const message =
          kind === "terminal.open"
            ? {
                type: kind,
                terminalId,
                requestId,
                target: { kind: "host_path", cwd: null },
                cols: 80,
                rows: 24,
                start: { mode: "shell" },
              }
            : {
                type: kind,
                terminalId,
                requestId,
                sinceSeq: 0,
                tailBytes: 1000,
              };

        expect(() =>
          socket?.onmessage?.({ data: JSON.stringify(message) }),
        ).not.toThrow();
        await vi.waitFor(() =>
          expect(
            send.mock.calls.map(([data]) => JSON.parse(String(data))),
          ).toContainEqual({
            type: "terminal.error",
            terminalId,
            requestId,
            code: hold,
            message:
              hold === "runtime_update_held"
                ? "Worker admission is held for a private runtime update"
                : "Worker admission is held for direct access handoff",
          }),
        );
        expect(logger.warn).not.toHaveBeenCalled();
        expect(logger.error).not.toHaveBeenCalled();
      } finally {
        await app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "release-terminal-hold",
          command:
            hold === "runtime_update_held"
              ? {
                  type: "runtime_update.release",
                  ownerId: "terminal-admission-test",
                }
              : {
                  type: "server_access.release_direct_probe",
                  challenge: "terminal-admission-test",
                },
        });
        await app.daemon.shutdown("test", 0);
      }
    },
  );

  it("installs machine variables into the daemon and child processes before work, then removes overrides live", async () => {
    vi.stubEnv("MACHINE_DAEMON_TEST", "original");
    let socket: ReconnectingWebSocketLike | undefined;

    const { app } = await createAppFixture(
      {
        machineEnvironment: [
          {
            name: "MACHINE_DAEMON_TEST",
            value: "configured",
            source: { core: "machine-environment" },
            reason: "test",
          },
        ],
      },
      {
        createWebSocket: createOpeningWebSocket((created) => {
          socket = created;
        }),
      },
    );

    const readChild = () =>
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(process.env.MACHINE_DAEMON_TEST)"],
        { encoding: "utf8" },
      );

    try {
      await app.daemon.start();
      expect(process.env.MACHINE_DAEMON_TEST).toBe("configured");
      expect(readChild()).toBe("configured");
      await app.runtimeManager.replaceBaseShellEnv({
        MACHINE_DAEMON_TEST: "stale-shell",
      });
      expect(app.runtimeManager.getShellEnv().MACHINE_DAEMON_TEST).toBe(
        "configured",
      );

      if (!socket) throw new Error("Expected daemon socket");
      socket.onmessage?.({
        data: JSON.stringify({
          type: "machine-environment.replace",
          environment: { revision: 1, entries: [] },
        }),
      });
      expect(process.env.MACHINE_DAEMON_TEST).toBe("original");
      expect(readChild()).toBe("original");
      expect(app.runtimeManager.getShellEnv()).not.toHaveProperty(
        "MACHINE_DAEMON_TEST",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
      vi.unstubAllEnvs();
    }
  });

  it("waits for fresh server diagnostics policy and disables on disconnect", async () => {
    let socket: ReconnectingWebSocketLike | undefined;

    const replacePolicy = vi.spyOn(
      processErrorReporting,
      "setProcessErrorReportingEnabled",
    );

    const { app, fetchRecorder, logger } = await createAppFixture(
      {},
      {
        createWebSocket: createOpeningWebSocket((created) => {
          socket = created;
        }),
      },
    );

    try {
      await app.daemon.start();

      expect(replacePolicy).toHaveBeenLastCalledWith(false);
      expect(
        fetchRecorder.requests.some(
          (request) => request.pathname === "/internal/session/open",
        ),
      ).toBe(true);

      if (!socket) throw new Error("Expected daemon socket");
      socket.onmessage?.({
        data: JSON.stringify({
          type: "diagnostics-policy.replace",
          policy: { revision: 1, crashReportsEnabled: true },
        }),
      });
      expect(replacePolicy).toHaveBeenLastCalledWith(true);
      socket.onclose?.({ code: 1000, reason: "test" });
      expect(replacePolicy).toHaveBeenLastCalledWith(false);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      await app.daemon.shutdown("test", 0);
      setProcessErrorReportingEnabled(true);
    }
  });

  it("acknowledges machine shutdown, cleans up, and exits", async () => {
    let socket: ReconnectingWebSocketLike | undefined;
    const exitProcess = vi.fn();

    const { app, dataDir } = await createAppFixture(
      {},
      {
        createWebSocket: createOpeningWebSocket((created) => {
          socket = created;
        }),
        exitProcess,
      },
    );

    await app.daemon.start();

    if (socket === undefined) throw new Error("Expected daemon socket");

    socket.onmessage?.({ data: JSON.stringify({ type: "machine.shutdown" }) });
    await app.daemon.waitUntilStopped();

    await expect(
      fs.access(path.join(dataDir, MACHINE_SUSPENSION_MARKER)),
    ).resolves.toBeUndefined();
    expect(socket.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "machine.shutdown-ack" }),
      expect.any(Function),
    );
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it("closes the machine authentication proxy during daemon shutdown", async () => {
    const closeMachineAuthProxy = vi.fn(async () => undefined);
    const { app } = await createAppFixture({}, { closeMachineAuthProxy });

    await app.daemon.shutdown("test", 0);

    expect(closeMachineAuthProxy).toHaveBeenCalledTimes(1);
  });

  it("refreshes runtime shell env before provider model listing", async () => {
    const dataDir = await makeTempDir("omnyo-host-daemon-app-models-");
    const fetchRecorder = createFetchRecorder();
    const logger = createLogger();
    const runtimeOptions: RuntimeOptionsRef = { current: null };

    const model = {
      id: "cursor-model",
      model: "cursor-model",
      displayName: "Cursor Model",
      description: "Test model",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium" as const,
      isDefault: true,
    };

    const listModels = vi.fn<AgentRuntime["listModels"]>(async () => ({
      models: [model],
      selectedOnlyModels: [],
    }));

    const resolveRuntimeShellEnv = vi.fn(async () => ({
      PATH: "/shell/bin:/usr/bin",
      OMNYO_SERVER_URL: "http://127.0.0.1:3334",
    }));

    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-app-test",
      hostId: "host-app-test",
      hostName: "App Test Host",
      instanceId: "instance-app-test",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      runtimeShellEnv: {
        PATH: "/old/bin:/usr/bin",
      },
      resolveRuntimeShellEnv,
      createRuntime: (options) => {
        runtimeOptions.current = options;

        return createFakeRuntimeWithModelList(listModels);
      },
      fetchFn: fetchRecorder.fetchFn,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      const response = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "provider-models-app-test",
        command: {
          type: "provider.list_models",
          providerId: "cursor",
          bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
          contributedEnv: [
            {
              name: "CODEX_OPENAI_BASE_URL",
              value: { serverPath: "/api/v1/plugins/account-pool/http/v1" },
              source: { plugin: "account-pool" },
              reason: "Routed through the Account Pooler hub",
            },
          ],
          cwd: "/tmp/worktree",
        },
      });

      expect(response).toMatchObject({
        ok: true,
        result: {
          models: [model],
          selectedOnlyModels: [],
        },
      });
      expect(resolveRuntimeShellEnv).toHaveBeenCalledTimes(1);
      expect(runtimeOptions.current).toEqual(
        expect.objectContaining({
          env: {
            PATH: "/shell/bin:/usr/bin",
          },
          shellEnv: {
            PATH: "/shell/bin:/usr/bin",
            OMNYO_SERVER_URL: "http://127.0.0.1:3334",
          },
        }),
      );
      expect(listModels).toHaveBeenCalledWith({
        providerId: "cursor",
        cwd: "/tmp/worktree",
        bridgeLaunch: {
          ...dispatchTestRuntimeBridgeLaunch(dataDir),
        },
        contributedEnv: [
          {
            name: "CODEX_OPENAI_BASE_URL",
            value: { serverPath: "/api/v1/plugins/account-pool/http/v1" },
            source: { plugin: "account-pool" },
            reason: "Routed through the Account Pooler hub",
          },
        ],
      });

      await expect(
        app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "provider-models-app-test-again",
          command: {
            type: "provider.list_models",
            providerId: "cursor",
            bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
      });
      expect(resolveRuntimeShellEnv).toHaveBeenCalledTimes(1);
      expect(listModels).toHaveBeenCalledTimes(2);
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("reuses freshly resolved startup shell env for immediate model listing", async () => {
    const dataDir = await makeTempDir("omnyo-host-daemon-app-startup-env-");
    const fetchRecorder = createFetchRecorder();
    const logger = createLogger();
    const runtimeOptions: RuntimeOptionsRef = { current: null };

    const model = {
      id: "codex-model",
      model: "codex-model",
      displayName: "Codex Model",
      description: "Test model",
      supportedReasoningEfforts: [],
      defaultReasoningEffort: "medium" as const,
      isDefault: true,
    };

    const listModels = vi.fn<AgentRuntime["listModels"]>(async () => ({
      models: [model],
      selectedOnlyModels: [],
    }));

    const resolveRuntimeShellEnv = vi.fn(async () => ({
      PATH: "/slow-shell/bin:/usr/bin",
      OMNYO_SERVER_URL: "http://127.0.0.1:3334",
    }));

    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-app-test",
      hostId: "host-app-test",
      hostName: "App Test Host",
      instanceId: "instance-app-test",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      runtimeShellEnv: {
        PATH: "/startup/bin:/usr/bin",
        OMNYO_SERVER_URL: "http://127.0.0.1:3334",
      },
      runtimeShellEnvResolvedAtMs: 1_000,
      resolveRuntimeShellEnv,
      nowMs: () => 1_500,
      createRuntime: (options) => {
        runtimeOptions.current = options;

        return createFakeRuntimeWithModelList(listModels);
      },
      fetchFn: fetchRecorder.fetchFn,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      await expect(
        app.router.handleOnlineRpcRequest({
          type: "host-rpc.request",
          requestId: "provider-models-startup-env-test",
          command: {
            type: "provider.list_models",
            providerId: "codex",
            bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
            contributedEnv: [],
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
      });

      expect(resolveRuntimeShellEnv).not.toHaveBeenCalled();
      expect(runtimeOptions.current).toEqual(
        expect.objectContaining({
          env: {
            PATH: "/startup/bin:/usr/bin",
          },
        }),
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("runs the idle provider session reaper on a non-overlapping interval", async () => {
    const logger = createLogger();

    const firstReap =
      createDeferredPromise<RuntimeManagerReapIdleProviderSessionsResult>();

    const failure = new Error("reaper failed");

    const queuedReaps: Array<
      () => Promise<RuntimeManagerReapIdleProviderSessionsResult>
    > = [
      () => firstReap.promise,
      async () => {
        throw failure;
      },
    ];

    const reapIdleProviderSessions = vi.fn(
      (
        _args: RuntimeManagerReapIdleProviderSessionsArgs,
      ): Promise<RuntimeManagerReapIdleProviderSessionsResult> => {
        const next = queuedReaps.shift();

        return next
          ? next()
          : Promise.resolve({
              reapedSessions: [],
              retainedSessions: [],
            });
      },
    );

    let nowMs = 1_000;
    let intervalCallback: (() => void) | null = null;
    let cleared = false;

    const timer: ReturnType<
      StartIdleProviderSessionReaperArgsForTest["setIntervalFn"]
    > = {
      clear: vi.fn(() => {
        cleared = true;
      }),
      unref: vi.fn(),
    };

    const setIntervalFn = vi.fn<
      StartIdleProviderSessionReaperArgsForTest["setIntervalFn"]
    >((callback, _intervalMs) => {
      intervalCallback = callback;

      return timer;
    });

    const triggerTick = (): void => {
      if (!intervalCallback || cleared) {
        return;
      }

      intervalCallback();
    };

    const reaper = startIdleProviderSessionReaper({
      logger,
      nowMs: () => nowMs,
      runtimeManager: {
        reapIdleProviderSessions,
        recordHousekeepingStatus: vi.fn(),
      },
      readMemoryPressure: async () => ({ status: "observed", level: "normal" }),
      setIntervalFn,
    });

    expect(setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 60_000);
    expect(timer.unref).toHaveBeenCalledTimes(1);

    triggerTick();
    await settleReaperPromiseChain();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(1);
    expect(reapIdleProviderSessions).toHaveBeenNthCalledWith(1, {
      idleForMs: 600_000,
      nowMs: 1_000,
    });

    nowMs = 2_000;
    triggerTick();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(1);

    firstReap.resolve({
      retainedSessions: [],
      reapedSessions: [
        {
          environmentId: "env-reaped",
          idleForMs: 1_900_000,
          providerId: "codex",
          providerThreadId: "provider-thread-reaped",
          threadId: "thread-reaped",
        },
      ],
    });
    await settleReaperPromiseChain();
    expect(logger.info).toHaveBeenCalledWith(
      {
        count: 1,
        sessions: [
          {
            environmentId: "env-reaped",
            idleForMs: 1_900_000,
            providerId: "codex",
            threadId: "thread-reaped",
          },
        ],
      },
      "Reaped idle provider sessions",
    );

    triggerTick();
    await settleReaperPromiseChain();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(2);
    expect(reapIdleProviderSessions).toHaveBeenNthCalledWith(2, {
      idleForMs: 600_000,
      nowMs: 2_000,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      {
        err: failure,
      },
      "Idle provider session reaper failed",
    );

    reaper.stop();
    expect(timer.clear).toHaveBeenCalledTimes(1);
    triggerTick();
    expect(reapIdleProviderSessions).toHaveBeenCalledTimes(2);
  });

  it("reconnects through the server connection when event posting sees an inactive session", async () => {
    const { app, fetchRecorder, logger } = await createAppFixture({
      inactiveSessionOnFirstEventPost: true,
      sessionIds: ["session-app-test-1", "session-app-test-2"],
    });

    try {
      await app.connection.start();

      app.eventSink.emit({
        threadId: "thr_app_inactive_session",
        event: {
          type: "turn/started",
          threadId: "thr_app_inactive_session",
          providerThreadId: "provider-thread-app-inactive-session",
          scope: turnScope("turn-app-inactive-session"),
        },
      });

      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (request) => request.pathname === "/internal/session/open",
          ),
        ).toHaveLength(2);
      });
      expect(logger.info).toHaveBeenCalledWith(
        {
          code: "inactive_session",
          sessionId: "session-app-test-1",
          source: "postEvents",
        },
        "Server reported inactive daemon session; reconnecting",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("reports an open provider question on reconnect and ends it when the server closed it", async () => {
    const request = createCommandApprovalRequest();

    const key = {
      threadId: request.threadId,
      providerId: request.providerId,
      providerThreadId: request.providerThreadId,
      providerRequestId: request.providerRequestId,
    };

    const { app, fetchRecorder, runtimeOptions } = await createAppFixture({
      inactiveSessionOnFirstEventPost: true,
      sessionIds: ["session-app-test-1", "session-app-test-2"],
      endedInteractiveRequestsOnReconnect: [key],
    });

    try {
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-ended-question",
        workspacePath: await makeTempDir("omnyo-host-daemon-app-ended-"),
      });
      const options = runtimeOptions.current;

      if (!options?.onInteractiveRequest) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const pending = options.onInteractiveRequest(request);

      const rejection = expect(pending).rejects.toMatchObject({
        code: "interactive_request_ended",
      });

      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (record) =>
              record.pathname === "/internal/session/interactive-request",
          ),
        ).toHaveLength(1);
      });

      app.eventSink.emit({
        threadId: request.threadId,
        event: {
          type: "turn/started",
          threadId: request.threadId,
          providerThreadId: request.providerThreadId,
          scope: turnScope(request.turnId),
        },
      });

      await rejection;

      const reopened = fetchRecorder.requests
        .filter((record) => record.pathname === "/internal/session/open")
        .map((record) => JSON.parse(record.body ?? "{}"));

      expect(reopened[1]).toMatchObject({
        openThreadWork: [
          {
            threadId: request.threadId,
            backgroundItemIds: [],
            interactiveRequests: [key],
          },
        ],
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("forgets server-retired loaded environments when opening a session", async () => {
    const dataDir = await makeTempDir("omnyo-host-daemon-app-retired-");

    const workspacePath = await makeTempDir(
      "omnyo-host-daemon-retired-workspace-",
    );

    const logger = createLogger();

    const fetchRecorder = createFetchRecorder({
      retiredEnvironmentIds: ["env-app-retired"],
    });

    const stopWatchingStatus = vi.fn(async () => undefined);

    const runtime = {
      ...createFakeRuntime(),
      shutdown: vi.fn(async () => undefined),
    } satisfies AgentRuntime;

    const hostWatcher = {
      watchWorkspace: vi.fn(() => stopWatchingStatus),
      watchThreadStorage: vi.fn(() => () => undefined),
    } satisfies HostWatcher;

    const app = await createHostDaemonApp({
      dataDir,
      serverUrl: "http://127.0.0.1:3334",
      hostKey: "host-key-retired-env",
      hostId: "host-retired-env",
      hostName: "Retired Environment Host",
      instanceId: "instance-retired-env",
      logger,
      releaseLock: async () => undefined,
      localApiConfig: null,
      createRuntime: () => runtime,
      fetchFn: fetchRecorder.fetchFn,
      hostWatcher,
      createWebSocket: createOpeningWebSocket(),
    });

    try {
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-retired",
        workspacePath,
      });
      expect(app.runtimeManager.get("env-app-retired")).toBeDefined();

      await app.connection.start();

      expect(app.runtimeManager.get("env-app-retired")).toBeUndefined();
      expect(stopWatchingStatus).not.toHaveBeenCalled();
      expect(runtime.shutdown).toHaveBeenCalledTimes(1);

      const openSessionBody = fetchRecorder.requests
        .filter((request) => request.pathname === "/internal/session/open")
        .map((request) => JSON.parse(request.body ?? "{}"));

      expect(openSessionBody[0]).toMatchObject({
        localApiPort: null,
        loadedEnvironments: [{ environmentId: "env-app-retired" }],
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs raw stderr for unexpected provider process exits", async () => {
    const { app, logger, runtimeOptions } = await createAppFixture();

    try {
      const workspacePath = await makeTempDir(
        "omnyo-host-daemon-app-log-workspace-",
      );

      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-provider-exit-log",
        workspacePath,
      });
      const options = runtimeOptions.current;

      if (!options?.onProcessExit) {
        throw new Error("Expected process exit callback to be captured");
      }

      options.onProcessExit({
        providerId: "codex",
        threads: [
          {
            threadId: "thr_provider_exit_log",
            activeTurnId: null,
            pendingTurnStart: false,
            providerThreadId: null,
          },
        ],
        code: 1,
        expected: false,
        signal: null,
        stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
      });

      expect(logger.warn).toHaveBeenCalledWith(
        {
          providerId: "codex",
          threadIds: ["thr_provider_exit_log"],
          code: 1,
          signal: null,
          stderr: "OPENAI_API_KEY=sk-test-secret\nUsage limit reached.",
        },
        "Unexpected provider process exited with stderr",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("posts a failure event when a provider exits before turn/started", async () => {
    const { app, fetchRecorder, runtimeOptions } = await createAppFixture();

    try {
      const workspacePath = await makeTempDir(
        "omnyo-host-daemon-app-pending-turn-exit-",
      );

      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-pending-turn-exit",
        workspacePath,
      });
      const options = runtimeOptions.current;

      if (!options?.onProcessExit) {
        throw new Error("Expected process exit callback to be captured");
      }

      options.onProcessExit({
        providerId: "claude-code",
        threads: [
          {
            threadId: "thr_pending_turn_exit",
            activeTurnId: null,
            pendingTurnStart: true,
            pendingRequestId: "creq_2222222262",
            providerThreadId: "provider-pending-turn-exit",
          },
        ],
        code: 1,
        expected: false,
        signal: null,
        stderr: null,
      });

      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (request) => request.pathname === "/internal/session/events",
          ),
        ).toHaveLength(1);
      });

      const eventRequest = fetchRecorder.requests.find(
        (request) => request.pathname === "/internal/session/events",
      );

      const payload = hostDaemonEventBatchRequestSchema.parse(
        JSON.parse(eventRequest?.body ?? "{}"),
      );

      expect(payload).toMatchObject({
        sessionId: "session-app-test",
        eventGroups: [
          {
            threadId: "thr_pending_turn_exit",
            events: [
              {
                type: "system/error",
                threadId: "thr_pending_turn_exit",
                scope: threadScope(),
                code: "provider_process_exited",
                requestId: "creq_2222222262",
                message:
                  'Provider "claude-code" exited unexpectedly with code 1',
              },
            ],
          },
        ],
        firstEventIndex: 1,
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("interrupts pending interactive requests when an expected provider exit affects their threads", async () => {
    const { app, fetchRecorder, runtimeOptions } = await createAppFixture();

    try {
      const workspacePath = await makeTempDir(
        "omnyo-host-daemon-app-workspace-",
      );

      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-interactive",
        workspacePath,
      });
      const options = runtimeOptions.current;

      if (!options?.onInteractiveRequest || !options.onProcessExit) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const request = createCommandApprovalRequest();
      const pending = options.onInteractiveRequest(request);
      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (record) =>
              record.pathname === "/internal/session/interactive-request",
          ),
        ).toHaveLength(1);
      });

      const pendingRejection = expect(pending).rejects.toThrow(
        'Provider "codex" exited while awaiting user interaction',
      );

      options.onProcessExit({
        providerId: "codex",
        threads: [
          {
            threadId: request.threadId,
            activeTurnId: request.turnId,
            pendingTurnStart: false,
            providerThreadId: request.providerThreadId,
          },
        ],
        code: null,
        expected: true,
        signal: "SIGTERM",
        stderr: null,
      });

      await pendingRejection;
      await vi.waitFor(() => {
        expect(
          fetchRecorder.requests.filter(
            (record) =>
              record.pathname ===
              "/internal/session/interactive-request/interrupt",
          ),
        ).toHaveLength(1);
      });

      const interruptRequest = fetchRecorder.requests.find(
        (record) =>
          record.pathname === "/internal/session/interactive-request/interrupt",
      );

      if (!interruptRequest?.body) {
        throw new Error("Expected interactive interrupt request body");
      }

      const payload = hostDaemonInteractiveInterruptRequestSchema.parse(
        JSON.parse(interruptRequest.body),
      );

      expect(payload).toMatchObject({
        sessionId: "session-app-test",
        providerId: "codex",
        threadIds: [request.threadId],
        reason: 'Provider "codex" exited while awaiting user interaction',
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("admits an idle update after provider exit while its interaction notice awaits delivery", async () => {
    const { app, runtimeOptions, fetchRecorder } = await createAppFixture({
      interruptResponses: [() => new Response("offline", { status: 503 })],
    });

    let acquiredOwner: string | null = null;

    try {
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-ended-notice",
        workspacePath: await makeTempDir("omnyo-host-daemon-app-workspace-"),
      });
      const options = runtimeOptions.current;

      if (!options?.onInteractiveRequest || !options.onProcessExit) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const request = createCommandApprovalRequest();
      const pending = options.onInteractiveRequest(request);
      const rejected = expect(pending).rejects.toThrow("exited while awaiting");
      await vi.waitFor(() =>
        expect(
          fetchRecorder.requests.filter(
            (entry) =>
              entry.pathname === "/internal/session/interactive-request",
          ),
        ).toHaveLength(1),
      );
      options.onProcessExit({
        providerId: request.providerId,
        threads: [
          {
            threadId: request.threadId,
            activeTurnId: request.turnId,
            pendingTurnStart: false,
            providerThreadId: request.providerThreadId,
          },
        ],
        code: null,
        expected: true,
        signal: "SIGTERM",
        stderr: null,
      });
      await rejected;

      const restartResponse = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "restart-after-exit",
        command: {
          type: "runtime_update.acquire",
          ownerId: "restart-owner-test",
          closePluginLeases: [],
        },
      });

      if (restartResponse.ok) acquiredOwner = "restart-owner-test";
      expect(restartResponse).toMatchObject({ ok: false });

      const updateOwner = "self-update:instance-app-test";

      const response = await app.router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "idle-update-after-exit",
        command: {
          type: "runtime_update.acquire",
          ownerId: updateOwner,
          closePluginLeases: [],
        },
      });

      if (response.ok) acquiredOwner = updateOwner;
      expect(response).toMatchObject({ ok: true, result: { held: true } });
    } finally {
      try {
        if (acquiredOwner !== null) {
          await app.router.handleOnlineRpcRequest({
            type: "host-rpc.request",
            requestId: "release-idle-update-after-exit",
            command: {
              type: "runtime_update.release",
              ownerId: acquiredOwner,
            },
          });
        }
      } finally {
        await app.daemon.shutdown("test", 0);
      }
    }
  });

  it("retains a rejected interactive interrupt without retrying it ahead of later interrupts", async () => {
    const { app, fetchRecorder, logger, runtimeOptions } =
      await createAppFixture({
        interruptResponses: [
          () =>
            Response.json(
              {
                code: "thread_environment_unavailable",
                message: "Thread environment is unavailable",
              },
              { status: 409 },
            ),
        ],
      });

    try {
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-rejected-interrupt",
        workspacePath: await makeTempDir("omnyo-host-daemon-app-workspace-"),
      });
      const options = runtimeOptions.current;

      if (!options?.onProcessExit) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const exitThread = (threadId: string) =>
        options.onProcessExit?.({
          providerId: "codex",
          threads: [
            {
              threadId,
              activeTurnId: null,
              pendingTurnStart: false,
              providerThreadId: null,
            },
          ],
          code: null,
          expected: true,
          signal: "SIGTERM",
          stderr: null,
        });

      const interruptedThreadIds = () =>
        fetchRecorder.requests
          .filter(
            (record) =>
              record.pathname ===
              "/internal/session/interactive-request/interrupt",
          )
          .map(
            (record) =>
              hostDaemonInteractiveInterruptRequestSchema.parse(
                JSON.parse(record.body ?? "{}"),
              ).threadIds,
          );

      exitThread("thr_app_rejected_interrupt");
      await vi.waitFor(() => {
        expect(logger.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            threadIds: ["thr_app_rejected_interrupt"],
          }),
          "Retained pending interactive interrupt request the server rejected",
        );
      });

      exitThread("thr_app_later_interrupt");
      await vi.waitFor(() => {
        expect(interruptedThreadIds()).toEqual([
          ["thr_app_rejected_interrupt"],
          ["thr_app_later_interrupt"],
        ]);
      });
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("backs off between retries of an interactive interrupt that fails transiently", async () => {
    const unavailable = () => new Response("offline", { status: 503 });

    const { app, fetchRecorder, runtimeOptions } = await createAppFixture({
      interruptResponses: [unavailable, unavailable, unavailable],
    });

    try {
      await app.connection.start();
      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-transient-interrupt",
        workspacePath: await makeTempDir("omnyo-host-daemon-app-workspace-"),
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const options = runtimeOptions.current;

      if (!options?.onProcessExit) {
        throw new Error("Expected runtime callbacks to be captured");
      }

      const interruptAttempts = () =>
        fetchRecorder.requests.filter(
          (record) =>
            record.pathname ===
            "/internal/session/interactive-request/interrupt",
        ).length;

      options.onProcessExit({
        providerId: "codex",
        threads: [
          {
            threadId: "thr_app_transient_interrupt",
            activeTurnId: null,
            pendingTurnStart: false,
            providerThreadId: null,
          },
        ],
        code: null,
        expected: true,
        signal: "SIGTERM",
        stderr: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(interruptAttempts()).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptAttempts()).toBe(2);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptAttempts()).toBe(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(interruptAttempts()).toBe(3);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(interruptAttempts()).toBe(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(interruptAttempts()).toBe(4);
    } finally {
      vi.useRealTimers();
      await app.daemon.shutdown("test", 0);
    }
  });

  it.each(["before forwarding", "during forwarding"])(
    "does not log a cancelled dynamic tool call %s",
    async (timing) => {
      const started = createDeferredPromise<void>();
      const controller = new AbortController();

      const { app, logger, fetchRecorder, runtimeOptions } =
        await createAppFixture({
          toolCallResponse: async (signal) => {
            if (!signal) throw new Error("Tool cancellation signal missing");
            started.resolve();

            return new Promise<Response>((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(signal.reason), {
                once: true,
              });
            });
          },
        });

      try {
        const workspacePath = await makeTempDir("omnyo-host-daemon-app-abort-");
        await app.runtimeManager.ensureEnvironment({
          environmentId: "env-abort",
          workspacePath,
        });
        await app.connection.start();
        const callback = runtimeOptions.current?.onToolCall;

        if (!callback) throw new Error("Tool callback missing");

        if (timing === "before forwarding") controller.abort();
        const pending = callback(createToolCallRequest(), controller.signal);

        const rejected = expect(pending).rejects.toMatchObject({
          name: "AbortError",
        });

        if (timing === "during forwarding") {
          await started.promise;
          controller.abort();
        }

        await rejected;
        expect(logger.error).not.toHaveBeenCalled();
        expect(
          fetchRecorder.requests.filter(
            (request) => request.pathname === "/internal/session/tool-call",
          ),
        ).toHaveLength(timing === "before forwarding" ? 0 : 1);
      } finally {
        await app.daemon.shutdown("test", 0);
      }
    },
  );

  it.each([false, true])(
    "logs stack-bearing fields for dynamic tool forwarding failures when the signal is aborted: %s",
    async (aborted) => {
      const controller = new AbortController();

      const { app, logger, runtimeOptions } = await createAppFixture({
        toolCallResponse: async () => {
          if (aborted) controller.abort();

          return new Response("tool forwarding failed", { status: 500 });
        },
      });

      try {
        const workspacePath = await makeTempDir("omnyo-host-daemon-app-tool-");
        await app.runtimeManager.ensureEnvironment({
          environmentId: "env-app-tool",
          workspacePath,
        });
        await app.connection.start();
        const options = runtimeOptions.current;

        if (!options?.onToolCall) {
          throw new Error("Expected tool call callback to be captured");
        }

        const request = createToolCallRequest();
        await expect(
          options.onToolCall(request, controller.signal),
        ).rejects.toThrow("Failed to call tool");

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            callId: request.callId,
            err: expect.any(Error),
            providerThreadId: request.providerThreadId,
            threadId: request.threadId,
            tool: request.tool,
            turnId: request.turnId,
          }),
          "Failed to forward dynamic tool call to server",
        );
      } finally {
        await app.daemon.shutdown("test", 0);
      }
    },
  );

  it("logs stack-bearing fields for unexpected interactive forwarding failures", async () => {
    const registrationError = new Error("registration transport failed");

    const { app, logger, runtimeOptions } = await createAppFixture({
      interactiveRequestError: registrationError,
    });

    try {
      const workspacePath = await makeTempDir(
        "omnyo-host-daemon-app-interactive-error-",
      );

      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-interactive-error",
        workspacePath,
      });
      await app.connection.start();
      const options = runtimeOptions.current;

      if (!options?.onInteractiveRequest) {
        throw new Error("Expected interactive request callback to be captured");
      }

      const request = createCommandApprovalRequest();
      await expect(options.onInteractiveRequest(request)).rejects.toThrow(
        "registration transport failed",
      );

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          err: registrationError,
          kind: request.payload.kind,
          providerRequestId: request.providerRequestId,
          providerThreadId: request.providerThreadId,
          threadId: request.threadId,
          turnId: request.turnId,
        }),
        "Failed to forward interactive provider request to server",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });

  it("logs rejected interactive request registrations with a structured code", async () => {
    const { app, logger, runtimeOptions } = await createAppFixture({
      interactiveRequestResponse: {
        outcome: "rejected",
        reason: "Ask User Question feature is disabled",
      },
    });

    try {
      const workspacePath = await makeTempDir(
        "omnyo-host-daemon-app-rejected-interactive-",
      );

      await app.runtimeManager.ensureEnvironment({
        environmentId: "env-app-rejected-interactive",
        workspacePath,
      });
      await app.connection.start();
      const options = runtimeOptions.current;

      if (!options?.onInteractiveRequest) {
        throw new Error("Expected interactive request callback to be captured");
      }

      const request = createCommandApprovalRequest();
      await expect(options.onInteractiveRequest(request)).rejects.toThrow(
        "Ask User Question feature is disabled",
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          errorMessage: "Ask User Question feature is disabled",
          errorName: "InteractiveRequestRegistryError",
          interactiveRequestErrorCode: "interactive_request_rejected",
          kind: request.payload.kind,
          providerRequestId: request.providerRequestId,
          providerThreadId: request.providerThreadId,
          threadId: request.threadId,
          turnId: request.turnId,
        }),
        "Interactive provider request rejected by server",
      );
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.anything(),
        "Failed to forward interactive provider request to server",
      );
    } finally {
      await app.daemon.shutdown("test", 0);
    }
  });
});

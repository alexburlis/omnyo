import {
  parseHostDaemonCommandResultForCommand,
  type HostDaemonCommand,
  type HostDaemonOnlineRpcRequestMessage,
  type HostDaemonOnlineRpcResponseMessage,
} from "@omnyo/host-daemon-contract";
import { WorkspaceError } from "@omnyo/host-workspace";
import {
  encodeClientTurnRequestIdNumber,
  type ClientTurnRequestId,
  type PromptInput,
} from "@omnyo/domain";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { describe, expect, it, vi } from "vitest";
import {
  CommandRouter,
  type CommandRouterOptions,
} from "../../src/command-router.js";
import {
  createHarness,
  createFakeRuntime,
  createFakeWorkspace,
  createTestWorkspaceReads,
  noopEventSink,
  unexpectedProjectAttachmentFetch,
  unexpectedProviderMaintenance,
  DISPATCH_TEST_BRIDGE_LAUNCH,
  fetchDispatchTestArtifact,
} from "./dispatch-helpers.js";
import { RuntimeManager } from "../../src/runtime-manager.js";
import {
  createFixture as createServerMoveFixture,
  registerServerMoveFixtureCleanup,
} from "../../src/server-move/test-fixture.js";

registerServerMoveFixtureCleanup();

type EnvironmentProvisionCommand = Extract<
  HostDaemonCommand,
  { type: "environment.attach" }
>;

type RouterHarness = ReturnType<typeof createHarness>;

type TextPromptInput = Extract<PromptInput, { type: "text" }>;

type InteractiveResolveCommand = Extract<
  HostDaemonCommand,
  { type: "interactive.resolve" }
>;

type ThreadStartCommand = Extract<HostDaemonCommand, { type: "thread.start" }>;

type TurnSubmitCommand = Extract<HostDaemonCommand, { type: "turn.submit" }>;

interface RunRouterCommandArgs {
  command: HostDaemonCommand;
  requestId: string;
  router: CommandRouter;
}

interface CreateTurnSubmitCommandArgs {
  environmentId?: string;
  providerId?: string;
  providerThreadId?: string;
  workspacePath?: string;
  text?: string;
  threadId?: string;
}

interface CreateRouterArgs {
  dataDir?: string;
  eventSink?: CommandRouterOptions["eventSink"];
  logger?: CommandRouterOptions["logger"];
  resolveInteractiveRequest?: CommandRouterOptions["resolveInteractiveRequest"];
  runtimeManager?: RuntimeManager;
  serverMove?: CommandRouterOptions["serverMove"];
  fetchPluginHostArtifact?: CommandRouterOptions["fetchPluginHostArtifact"];
  providerInstallationRun?: CommandRouterOptions["providerInstallationRun"];
}

let nextClientRequestIdValue = 1;

function createClientRequestId(): ClientTurnRequestId {
  const requestId = encodeClientTurnRequestIdNumber({
    value: nextClientRequestIdValue,
  });

  nextClientRequestIdValue += 1;

  return requestId;
}

function createRouter(
  harness: RouterHarness,
  args: CreateRouterArgs = {},
): CommandRouter {
  return new CommandRouter({
    dataDir: args.dataDir ?? "/tmp/omnyo-router-test-data",
    eventSink: args.eventSink ?? noopEventSink,
    fetchProjectAttachment: unexpectedProjectAttachmentFetch,
    ...unexpectedProviderMaintenance,
    serverMove: args.serverMove,
    fetchPluginHostArtifact:
      args.fetchPluginHostArtifact ?? fetchDispatchTestArtifact,
    providerInstallationRun:
      args.providerInstallationRun ??
      unexpectedProviderMaintenance.providerInstallationRun,
    logger: {
      debug: () => undefined,
      warn: () => undefined,
      ...args.logger,
    },
    resolveInteractiveRequest: args.resolveInteractiveRequest,
    runtimeManager: args.runtimeManager ?? harness.manager,
    workspaceReads: createTestWorkspaceReads(
      args.runtimeManager ?? harness.manager,
    ),
    threadStorageRootPath: "/tmp/omnyo-router-test-thread-storage",
  });
}

function createTurnSubmitCommand(
  args: CreateTurnSubmitCommandArgs = {},
): TurnSubmitCommand {
  const workspacePath = args.workspacePath ?? "/tmp/env-router";

  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "turn.submit",
    environmentId: args.environmentId ?? "env-router",
    threadId: args.threadId ?? "thread-router",
    requestId: createClientRequestId(),
    input: [textPromptInput(args.text ?? "after destroy")],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    resumeContext: {
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      workspaceContext: {
        workspacePath,
      },
      projectId: "project-router",
      providerId: args.providerId ?? "fake",
      providerThreadId: args.providerThreadId ?? "provider-thread-router",
      instructions: "Be a helpful coding agent.",
      dynamicTools: [],
      contributedEnv: [],
      injectedSkillSources: [],
      instructionMode: "append",
    },
    target: { mode: "start" },
  };
}

function createThreadStartCommand(): ThreadStartCommand {
  return {
    bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    type: "thread.start",
    environmentId: "env-router",
    threadId: "thread-router-start",
    workspaceContext: {
      workspacePath: "/tmp/env-router",
    },
    projectId: "project-router",
    providerId: "fake",
    requestId: createClientRequestId(),
    input: [textPromptInput("start")],
    options: {
      model: "gpt-5",
      serviceTier: "default",
      reasoningLevel: "medium",
      providerOptions: {},
      permissionMode: "full",
      permissionScope: "full",
      approvalReviewer: null,
      permissionEscalation: null,
    },
    instructions: "Be a helpful coding agent.",
    dynamicTools: [],
    contributedEnv: [],
    injectedSkillSources: [],
    instructionMode: "append",
  };
}

function createInteractiveResolveCommand(): InteractiveResolveCommand {
  return {
    type: "interactive.resolve",
    environmentId: "env-router",
    threadId: "thread-router",
    interactionId: "interaction-router",
    providerId: "fake",
    providerThreadId: "provider-thread-router",
    providerRequestId: "provider-request-router",
    resolution: { decision: "allow_once", grantedPermissions: null },
  };
}

function textPromptInput(text: string): TextPromptInput {
  return { type: "text", text, mentions: [] };
}

function createEnvironmentProvisionCommand(): EnvironmentProvisionCommand {
  return {
    type: "environment.attach",
    contributedEnv: [],
    environmentId: "env-router",
    initiator: null,
    path: "/tmp/env-router",
    setupScriptTimeoutMs: null,
  };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

async function runRouterCommand({
  command,
  requestId,
  router,
}: RunRouterCommandArgs): Promise<HostDaemonOnlineRpcResponseMessage> {
  const message: HostDaemonOnlineRpcRequestMessage = {
    type: "host-rpc.request",
    requestId,
    command,
  };

  return router.handleOnlineRpcRequest(message);
}

describe("CommandRouter", () => {
  it("preserves structured startup quota failures without an unexpected warning", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });

    const errorInfo = {
      category: "rate-limit",
      providerCode: "usage_limit_reached",
      httpStatusCode: 429,
    };

    vi.spyOn(harness.runtime, "startThread").mockRejectedValue(
      Object.assign(new Error("Quota exhausted"), { errorInfo }),
    );
    const warn = vi.fn();
    const router = createRouter(harness, { logger: { warn, debug: vi.fn() } });
    expect(
      await runRouterCommand({
        command: createThreadStartCommand(),
        requestId: "startup-quota",
        router,
      }),
    ).toMatchObject({ ok: false, errorInfo });
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the worker activity that refuses a runtime update hold", async () => {
    const fixture = await createServerMoveFixture();
    let router: CommandRouter;

    const service = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands: router.getDirectAccessActivityCount(),
        runtimes: 2,
        terminals: 1,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    router = createRouter(createHarness(), {
      dataDir: fixture.options.dataDir,
      serverMove: service,
    });

    expect(
      await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "busy-runtime-update",
        command: {
          type: "runtime_update.acquire",
          ownerId: "update-owner",
          closePluginLeases: [],
        },
      }),
    ).toMatchObject({
      ok: false,
      errorCode: "runtime_update_busy",
      errorMessage:
        "Worker activity prevents a runtime update: runtimes 2, terminals 1",
    });
  });

  it("holds provider update admission before bridge preparation and releases preparation failures", async () => {
    const fixture = await createServerMoveFixture();
    const harness = createHarness();
    let runtimeBusy = true;
    let router: CommandRouter;

    const service = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands: router.getDirectAccessActivityCount(),
        runtimes: runtimeBusy ? 1 : 0,
        terminals: 1,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    const prepared =
      createDeferredPromise<
        Awaited<ReturnType<typeof fetchDispatchTestArtifact>>
      >();

    const fetchArtifact = vi.fn(() => prepared.promise);

    const providerRun = vi.fn(async () => ({
      available: false as const,
      message: "No update",
    }));

    router = createRouter(harness, {
      dataDir: fixture.options.dataDir,
      serverMove: service,
      fetchPluginHostArtifact: fetchArtifact,
      providerInstallationRun: providerRun,
    });

    const command = {
      type: "provider.installation.run" as const,
      providerId: "codex",
      action: "update" as const,
      bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
    };

    const run = (requestId: string) =>
      router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId,
        command,
      });

    expect(await run("busy-update")).toMatchObject({
      ok: false,
      errorCode: "runtime_update_busy",
    });
    expect(fetchArtifact).not.toHaveBeenCalled();
    runtimeBusy = false;
    const pending = run("held-update");
    await vi.waitFor(() => expect(fetchArtifact).toHaveBeenCalledOnce());
    expect(
      await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "new-turn",
        command: createThreadStartCommand(),
      }),
    ).toMatchObject({ ok: false, errorCode: "runtime_update_held" });
    expect(providerRun).not.toHaveBeenCalled();
    prepared.reject(new Error("Preparation failed"));
    expect(await pending).toMatchObject({ ok: false });
    expect(() =>
      service.assertDirectAccessAdmission("thread.start"),
    ).not.toThrow();
  });

  it("holds admission during installer preparation and releases its failure", async () => {
    const fixture = await createServerMoveFixture();
    const harness = createHarness();
    let router: CommandRouter;

    const service = fixture.createService({
      getRuntimeUpdateActivity: () => ({
        commands: router.getDirectAccessActivityCount(),
        runtimes: 0,
        terminals: 0,
        pluginHosts: 0,
        interactions: 0,
      }),
    });

    const prepared =
      createDeferredPromise<
        Awaited<ReturnType<CommandRouterOptions["providerInstallationRun"]>>
      >();

    const providerRun = vi.fn(() => prepared.promise);
    router = createRouter(harness, {
      dataDir: fixture.options.dataDir,
      serverMove: service,
      providerInstallationRun: providerRun,
    });

    const pending = router.handleOnlineRpcRequest({
      type: "host-rpc.request",
      requestId: "install-preparing",
      command: {
        type: "provider.installation.run",
        providerId: "codex",
        action: "update",
        bridgeLaunch: DISPATCH_TEST_BRIDGE_LAUNCH,
      },
    });

    await vi.waitFor(() => expect(providerRun).toHaveBeenCalledOnce());
    expect(
      await router.handleOnlineRpcRequest({
        type: "host-rpc.request",
        requestId: "new-install-turn",
        command: createThreadStartCommand(),
      }),
    ).toMatchObject({ ok: false, errorCode: "runtime_update_held" });
    prepared.reject(new Error("Installer failed"));
    expect(await pending).toMatchObject({ ok: false });
    expect(() =>
      service.assertDirectAccessAdmission("terminal.create"),
    ).not.toThrow();
  });

  it("does not warn for expected provision cancellation RPC failures", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });

    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
    };

    const runtimeManager = new RuntimeManager({
      createRuntime: () => harness.runtime,
      provisionWorkspace: async () => {
        throw new WorkspaceError(
          "provision_cancelled",
          "Workspace provisioning was cancelled",
        );
      },
    });

    const router = createRouter(harness, { logger, runtimeManager });

    const response = await runRouterCommand({
      command: createEnvironmentProvisionCommand(),
      requestId: "provision-cancelled-env-router",
      router,
    });

    expect(response).toMatchObject({
      ok: false,
      errorCode: "provision_cancelled",
      errorMessage: "Workspace provisioning was cancelled",
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("orders turn.submit after an in-flight environment provision", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const provisionStarted = createDeferredPromise<void>();
    const releaseProvision = createDeferredPromise<void>();

    const runtimeManager = new RuntimeManager({
      createRuntime: () => harness.runtime,
      provisionWorkspace: async () => {
        provisionStarted.resolve();
        await releaseProvision.promise;

        return harness.workspace;
      },
    });

    const router = createRouter(harness, { runtimeManager });

    const provisionTask = runRouterCommand({
      command: createEnvironmentProvisionCommand(),
      requestId: "provision-env-router",
      router,
    });

    await provisionStarted.promise;

    const turnTask = runRouterCommand({
      command: createTurnSubmitCommand(),
      requestId: "turn-env-router",
      router,
    });

    await flushAsyncWork();

    expect(harness.runtimeState.ranTurnText).toBeUndefined();

    releaseProvision.resolve();
    const provisionResponse = await provisionTask;
    expect(provisionResponse.ok).toBe(true);
    const turnResponse = await turnTask;
    expect(turnResponse.ok).toBe(true);
    expect(harness.runtimeState.ranTurnText).toBe("after destroy");
  });

  it("stamps a turn.submit result with the emitted events instead of waiting for a flush", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const flush = vi.fn(() => new Promise<void>(() => undefined));
    const markThrough = vi.fn(() => 7);

    const router = createRouter(harness, {
      eventSink: { emit: () => undefined, flush, markThrough },
    });

    const response = await runRouterCommand({
      command: createTurnSubmitCommand(),
      requestId: "turn-stamp-env-router",
      router,
    });

    expect(response).toMatchObject({ ok: true, eventsThrough: 7 });
    expect(flush).not.toHaveBeenCalled();
    expect(markThrough).toHaveBeenCalledTimes(1);
  });

  it("returns turn.submit spans recorded across the execution lanes", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const router = createRouter(harness);

    const command = createTurnSubmitCommand();

    const response = await runRouterCommand({
      command,
      requestId: "turn-trace-env-router",
      router,
    });

    if (!response.ok) {
      throw new Error("Expected a successful turn.submit response");
    }

    const { spans } = parseHostDaemonCommandResultForCommand(
      command,
      response.result,
    ).trace;

    expect(spans.map((span) => span.name)).toEqual([
      "lanes.entered",
      "skills.staged",
      "runtime.ready",
      "input.staged",
      "bridge.turnStarted",
    ]);
    const offsets = spans.map((span) => span.atMs);
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right));
  });

  it("orders thread.stop after an in-flight thread.start handoff", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    const startEntered = createDeferredPromise<void>();
    const releaseStart = createDeferredPromise<void>();
    const originalStartThread = harness.runtime.startThread;
    harness.runtime.startThread = async (args) => {
      startEntered.resolve();
      await releaseStart.promise;

      return originalStartThread(args);
    };

    const router = createRouter(harness);

    const startTask = runRouterCommand({
      command: createThreadStartCommand(),
      requestId: "start-env-router",
      router,
    });

    await startEntered.promise;

    let stopResolved = false;

    const stopTask = runRouterCommand({
      command: {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-router",
        threadId: "thread-router-start",
      },
      requestId: "stop-env-router",
      router,
    }).then((response) => {
      stopResolved = true;

      return response;
    });

    await flushAsyncWork();

    expect(harness.runtimeState.stoppedThreadId).toBeUndefined();
    expect(stopResolved).toBe(false);

    releaseStart.resolve();
    const startResponse = await startTask;
    expect(startResponse.ok).toBe(true);
    const stopResponse = await stopTask;

    expect(stopResponse.ok).toBe(true);
    expect(harness.runtimeState.stoppedThreadId).toBe("thread-router-start");
    expect(harness.runtime.hasThread("thread-router-start")).toBe(false);
  });

  it("orders interactive.resolve after an in-flight turn.submit on the same thread", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    const turnEntered = createDeferredPromise<void>();
    const releaseTurn = createDeferredPromise<void>();
    const originalRunTurn = harness.runtime.runTurn;
    harness.runtime.runTurn = async (args) => {
      turnEntered.resolve();
      await releaseTurn.promise;

      return originalRunTurn(args);
    };

    const resolveInteractiveRequest = vi.fn(async () => undefined);

    const router = createRouter(harness, { resolveInteractiveRequest });

    const turnTask = runRouterCommand({
      command: createTurnSubmitCommand({ text: "hold the lane" }),
      requestId: "turn-before-resolve",
      router,
    });

    await turnEntered.promise;

    const resolveTask = runRouterCommand({
      command: createInteractiveResolveCommand(),
      requestId: "resolve-behind-turn",
      router,
    });

    await flushAsyncWork();

    expect(resolveInteractiveRequest).not.toHaveBeenCalled();

    releaseTurn.resolve();
    const turnResponse = await turnTask;
    expect(turnResponse.ok).toBe(true);
    const resolveResponse = await resolveTask;
    expect(resolveResponse.ok).toBe(true);
    expect(resolveInteractiveRequest).toHaveBeenCalledTimes(1);
    expect(resolveInteractiveRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        interactionId: "interaction-router",
        threadId: "thread-router",
      }),
    );
  });

  it("waits for an old-environment turn before resuming the moved thread", async () => {
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    const oldHarness = createFakeRuntime();
    const newHarness = createFakeRuntime();
    const oldRuntime = oldHarness.runtime;
    const newRuntime = newHarness.runtime;
    const runtimes = [oldRuntime, newRuntime];

    const runtimeManager = new RuntimeManager({
      createRuntime: () => {
        const runtime = runtimes.shift();

        if (!runtime) {
          throw new Error("Unexpected runtime creation");
        }

        return runtime;
      },
      provisionWorkspace: async (options) =>
        createFakeWorkspace(options.path).workspace,
    });

    await runtimeManager.ensureEnvironment({
      environmentId: "env-router-old",
      workspacePath: "/tmp/env-router-old",
    });
    oldHarness.threadControls.setProviderSession("thread-moved", {
      providerId: "fake",
      providerThreadId: "provider-moved",
    });

    const oldRunEntered = createDeferredPromise<void>();
    const releaseOldRun = createDeferredPromise<void>();
    const originalOldRunTurn = oldRuntime.runTurn.bind(oldRuntime);
    oldRuntime.runTurn = async (args) => {
      oldRunEntered.resolve();
      await releaseOldRun.promise;

      return originalOldRunTurn(args);
    };

    const originalOldStopThread = oldRuntime.stopThread.bind(oldRuntime);
    const oldStopThread = vi.fn(originalOldStopThread);
    oldRuntime.stopThread = oldStopThread;
    const originalNewResumeThread = newRuntime.resumeThread.bind(newRuntime);
    const newResumeThread = vi.fn(originalNewResumeThread);
    newRuntime.resumeThread = newResumeThread;

    const retainEnvironment = vi.spyOn(
      runtimeManager,
      "retainEnvironmentForThreadCommand",
    );

    const router = createRouter(harness, { runtimeManager });

    const oldTask = runRouterCommand({
      command: createTurnSubmitCommand({
        environmentId: "env-router-old",
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
        workspacePath: "/tmp/env-router-old",
        text: "old turn",
      }),
      requestId: "old-moved-turn",
      router,
    });

    await oldRunEntered.promise;

    const newTask = runRouterCommand({
      command: createTurnSubmitCommand({
        environmentId: "env-router-new",
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
        workspacePath: "/tmp/env-router-new",
        text: "new turn",
      }),
      requestId: "new-moved-turn",
      router,
    });

    await flushAsyncWork();

    expect(retainEnvironment).toHaveBeenCalledTimes(1);
    expect(newResumeThread).not.toHaveBeenCalled();
    releaseOldRun.resolve();
    const [oldResponse, newResponse] = await Promise.all([oldTask, newTask]);

    expect(oldResponse.ok).toBe(true);
    expect(newResponse.ok).toBe(true);
    expect(retainEnvironment).toHaveBeenNthCalledWith(
      2,
      "env-router-new",
      "thread-moved",
    );
    expect(oldStopThread).toHaveBeenCalledWith({
      threadId: "thread-moved",
    });
    expect(newResumeThread).toHaveBeenCalledWith(
      expect.objectContaining({
        providerThreadId: "provider-moved",
        threadId: "thread-moved",
      }),
    );
    expect(oldStopThread.mock.invocationCallOrder[0]).toBeLessThan(
      newResumeThread.mock.invocationCallOrder[0],
    );
    await runtimeManager.shutdownAll();
  });

  it("does not route separate threads through one lane", async () => {
    const providerId = "codex";
    const harness = createHarness({ workspacePath: "/tmp/env-router" });
    await harness.manager.ensureEnvironment({
      environmentId: "env-router",
      workspacePath: "/tmp/env-router",
    });
    harness.threadControls.setProviderSession("thread-stop", {
      providerId,
      providerThreadId: "provider-stop",
    });
    harness.threadControls.setProviderSession("thread-turn", {
      providerId,
      providerThreadId: "provider-turn",
    });

    const stopEntered = createDeferredPromise<void>();
    const releaseStop = createDeferredPromise<void>();
    const originalStopThread = harness.runtime.stopThread;
    harness.runtime.stopThread = async (args) => {
      stopEntered.resolve();
      await releaseStop.promise;

      return originalStopThread(args);
    };

    const router = createRouter(harness);

    const stopTask = runRouterCommand({
      command: {
        type: "thread.stop",
        intent: "interrupt",
        environmentId: "env-router",
        threadId: "thread-stop",
      },
      requestId: "stop-thread",
      router,
    });

    await stopEntered.promise;

    const turnTask = runRouterCommand({
      command: createTurnSubmitCommand({
        providerId,
        providerThreadId: "provider-turn",
        text: "other thread",
        threadId: "thread-turn",
      }),
      requestId: "turn-other-thread",
      router,
    });

    await flushAsyncWork();

    expect(harness.runtimeState.ranTurnText).toBe("other thread");
    const turnResponse = await turnTask;
    expect(turnResponse.ok).toBe(true);

    releaseStop.resolve();
    const stopResponse = await stopTask;
    expect(stopResponse.ok).toBe(true);
  });
});

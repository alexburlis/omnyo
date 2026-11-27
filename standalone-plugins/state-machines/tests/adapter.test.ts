import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { createOmnyoStateMachineAdapter } from "../src/actions/omnyo-adapter.js";
import { commandSpecSchema } from "../src/contracts/host.js";
import type { ActionInvocation } from "../src/runtime/adapter.js";
import { createLocalCheckLoop } from "../templates/index.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function invocation(): ActionInvocation {
  const state = createLocalCheckLoop({
    machineId: "mch_test",
    environmentId: "env_test",
  }).states.find((state) => state.kind === "command");

  if (!state || state.kind !== "command") throw new Error("Missing command fixture");

  return {
    instanceId: "ins_test",
    entryId: "ent_test",
    invocationId: "inv_test",
    attemptId: "try_test",
    generation: 1,
    specHash: "a".repeat(64),
    projectId: "proj_test",
    environmentId: "env_test",
    state,
    context: {},
    dispatchedAt: Date.now(),
    deadlineAt: Date.now() + 60000,
    threadId: null,
    attempt: 1,
    homeThreadId: null,
  };
}

const target = {
  projectId: "proj_test",
  hostId: "host_original",
  path: "/workspace",
  managed: false,
  lifecycle: { phase: "active", retireAt: null },
};

function agentInvocation(): ActionInvocation {
  return {
    ...invocation(),
    threadId: "thr_owned",
    state: {
      id: "agent",
      title: "Agent",
      subtitle: "",
      kind: "agent",
      deadlineMs: 60000,
      maxAttempts: 1,
      effect: "local-read",
      effectTarget: "env_test",
      annotations: { category: null },
      action: {
        prompt: "Check",
        execution: { providerId: "codex", model: "model", reasoningLevel: "high" },
        permissionMode: "auto",
        environmentId: "env_test",
        result: { outcomes: [{ name: "ok", fields: [] }] },
      },
    },
  };
}

describe("Omnyo action adapter boundaries", () => {
  it("pins the exact selected execution and default service tier when starting an agent", async () => {
    const request = agentInvocation();
    request.threadId = null;

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        environments: { get: () => target },
        providers: {
          list: () => [
            { id: "codex", available: true, capabilities: { permissionModes: ["auto"] } },
          ],
          models: () => ({
            modelLoadError: null,
            models: [
              {
                id: "model",
                model: "model",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
          }),
        },
        threads: {
          spawn: () => makeThreadResponse({ id: "thr_spawned", projectId: request.projectId }),
        },
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    expect(await adapter.start(request)).toMatchObject({
      status: "running",
      threadId: "thr_spawned",
    });
    const calls = host.harness.sdk.callsTo("threads.spawn");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toMatchObject({
      providerId: "codex",
      model: "model",
      reasoningLevel: "high",
      permissionMode: "auto",
      serviceTier: "default",
      environment: { type: "reuse", environmentId: "env_test" },
    });
  });

  it("runs an agent step of a run with a home chat in a visible chat nested under it", async () => {
    const request = { ...agentInvocation(), threadId: null, attempt: 2, homeThreadId: "thr_home" };

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        environments: { get: () => target },
        providers: {
          list: () => [
            { id: "codex", available: true, capabilities: { permissionModes: ["auto"] } },
          ],
          models: () => ({
            modelLoadError: null,
            models: [
              {
                id: "model",
                model: "model",
                supportedReasoningEfforts: [{ reasoningEffort: "high" }],
              },
            ],
          }),
        },
        threads: {
          spawn: () => makeThreadResponse({ id: "thr_step", projectId: request.projectId }),
        },
      },
    });

    hosts.push(host);
    await createOmnyoStateMachineAdapter(host.api).start(request);

    expect(host.harness.sdk.callsTo("threads.spawn")[0]?.[0]).toMatchObject({
      visibility: "visible",
      parentThreadId: "thr_home",
      title: "Agent · try 2",
    });
  });

  it("creates a visible home chat that names its run and rejects unusable home chats", async () => {
    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        threads: {
          spawn: () => makeThreadResponse({ id: "thr_home", projectId: "proj_test" }),
          list: (input) =>
            input?.threadIds?.[0] === "thr_hidden"
              ? [
                  makeThreadResponse({
                    id: "thr_hidden",
                    projectId: "proj_test",
                    visibility: "hidden",
                  }),
                ]
              : input?.threadIds?.[0] === "thr_elsewhere"
                ? [makeThreadResponse({ id: "thr_elsewhere", projectId: "proj_other" })]
                : [],
        },
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);

    expect(
      await adapter.createHomeThread({
        instanceId: "ins_test",
        projectId: "proj_test",
        environmentId: "env_test",
        machineName: "Sentry fix · OMNYO-M",
        requestId: "start-1",
      }),
    ).toEqual({ threadId: "thr_home" });
    const home = host.harness.sdk.callsTo("threads.spawn")[0]?.[0];

    expect(home).toMatchObject({
      projectId: "proj_test",
      visibility: "visible",
      title: "Sentry fix · OMNYO-M",
      pluginMetadata: { stateMachineHome: 1, instanceId: "ins_test", requestId: "start-1" },
      experimental_idle: true,
      experimental_quiet: true,
    });
    expect(home).not.toHaveProperty("prompt");
    expect(
      await adapter.homeThreadProblem({ projectId: "proj_test", threadId: "thr_hidden" }),
    ).toMatch(/visible chat/);
    expect(
      await adapter.homeThreadProblem({ projectId: "proj_test", threadId: "thr_elsewhere" }),
    ).toMatch(/machine's project/);
    expect(
      await adapter.homeThreadProblem({ projectId: "proj_test", threadId: "thr_missing" }),
    ).toMatch(/isn't archived/);
  });

  it("adopts an exact archived worker after a lost spawn response without spawning again", async () => {
    const request = agentInvocation();
    request.threadId = null;

    const thread = makeThreadResponse({
      id: "thr_archived",
      projectId: request.projectId,
      originPluginId: "state-machines",
      archivedAt: Date.now(),
    });

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        threads: {
          list: (input) => (input?.archived ? [thread] : []),
          get: () => thread,
          getPluginMetadata: () => ({
            stateMachineWorker: 1,
            instanceId: request.instanceId,
            entryId: request.entryId,
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            generation: request.generation,
            specHash: request.specHash,
          }),
          timeline: () => ({ activeWorkflows: [], activeBackgroundCommands: [] }),
          interactions: { list: () => [] },
          events: { list: () => [{ type: "turn/completed" }] },
        },
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    expect(await adapter.inspect(request)).toMatchObject({
      status: "quiescent",
      threadId: "thr_archived",
    });
    expect(host.harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });

  it("requires a completed worker turn and drained queues before reporting agent quiescence", async () => {
    const request = agentInvocation();
    let queued = 0;
    let backgrounds: { id: string }[] = [];
    let completed = false;
    let providerFailed = false;
    let questions: { id: string; status: string }[] = [];

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        threads: {
          get: () =>
            makeThreadResponse({
              id: "thr_owned",
              projectId: request.projectId,
              originPluginId: "state-machines",
              queuedMessageCount: queued,
            }),
          getPluginMetadata: () => ({
            stateMachineWorker: 1,
            instanceId: request.instanceId,
            entryId: request.entryId,
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            generation: request.generation,
            specHash: request.specHash,
          }),
          timeline: () => ({ activeWorkflows: [], activeBackgroundCommands: backgrounds }),
          interactions: { list: () => questions },
          events: {
            list: () =>
              completed ? [{ type: providerFailed ? "provider/error" : "turn/completed" }] : [],
          },
        },
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    expect(await adapter.inspect(request)).toMatchObject({
      status: "running",
      confirmedLive: false,
    });
    questions = [{ id: "question_exact", status: "pending" }];
    expect(await adapter.inspect(request)).toMatchObject({
      status: "running",
      confirmedLive: true,
      waitingForPerson: { threadId: "thr_owned", interactionId: "question_exact" },
    });
    questions = [];
    completed = true;
    queued = 1;
    expect(await adapter.inspect(request)).toMatchObject({
      status: "running",
      confirmedLive: true,
    });
    queued = 0;
    backgrounds = [{ id: "background-owned" }];
    expect(await adapter.inspect(request)).toMatchObject({
      status: "running",
      confirmedLive: true,
    });
    backgrounds = [];
    expect(await adapter.inspect(request)).toMatchObject({
      status: "quiescent",
      confirmedLive: false,
      result: { type: "no-result" },
    });
    providerFailed = true;
    expect(await adapter.inspect(request)).toMatchObject({
      status: "quiescent",
      result: { type: "failed" },
    });
  });

  it("preserves an unknown outcome even after the process group has ended", async () => {
    const request = invocation();

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: { environments: { get: () => target } },
      experimental_callHostRpc: () => ({
        attemptId: request.attemptId,
        specHash: request.specHash,
        status: "uncertain",
        pid: 100,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        exitCode: null,
        reason: "Terminal outcome unavailable",
        quiescent: true,
        bytes: 0,
      }),
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    expect(await adapter.start(request)).toEqual({
      status: "uncertain",
      confirmedLive: false,
      reason: "Terminal outcome unavailable",
    });
  });

  it("does not turn a supervisor-enforced failure into success when the process exits zero", async () => {
    const request = invocation();

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: { environments: { get: () => target } },
      experimental_callHostRpc: () => ({
        attemptId: request.attemptId,
        specHash: request.specHash,
        status: "failed",
        pid: 100,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        exitCode: 0,
        reason: "OUTPUT_LIMIT",
        quiescent: true,
        bytes: 1048576,
      }),
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    expect(await adapter.start(request)).toMatchObject({
      status: "quiescent",
      result: { type: "failed" },
    });
  });

  it.each([
    { path: "branch", key: "branch" },
    { path: "/branch~1name", key: "branch/name" },
  ])("keeps literal arguments and the admitted host binding for $path", async ({ path, key }) => {
    const request = invocation();

    if (request.state.kind !== "command") throw new Error("Expected command fixture");
    request.state.action.argv = [
      { literal: "node" },
      { literal: "$(touch forbidden); *" },
      { contextPath: path },
    ];
    request.context = { [key]: "a b; $HOME" };

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: { environments: { get: () => target } },
      experimental_callHostRpc(call) {
        expect(call.hostId).toBe("host_original");

        if (call.method === "submitInvocation") {
          const spec = commandSpecSchema.parse(call.input);
          expect(spec.argv).toEqual(["node", "$(touch forbidden); *", "a b; $HOME"]);
          expect(spec.rootPath).toBe("/workspace");
        }

        return {
          attemptId: request.attemptId,
          specHash: request.specHash,
          status: "running",
          pid: 100,
          startedAt: Date.now(),
          finishedAt: null,
          exitCode: null,
          reason: null,
          quiescent: false,
          bytes: 0,
        };
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    await adapter.start(request);
    host.harness.sdk.stub("environments.get", () => {
      throw new Error("Environment retired");
    });
    expect((await adapter.inspect(request)).confirmedLive).toBe(true);
    await adapter.cancel(request);
    expect(host.harness.sdk.callsTo("environments.get")).toHaveLength(1);
    expect(host.harness.inspection.experimental_hostRpcCalls.map((call) => call.method)).toEqual([
      "submitInvocation",
      "inspectInvocation",
      "cancelInvocation",
      "inspectInvocation",
    ]);
  });

  it("retains cleanup ownership after a failed acknowledgement and makes successful retirement idempotent", async () => {
    const request = invocation();
    let acknowledge = false;
    let acknowledgements = 0;

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: { environments: { get: () => target } },
      experimental_callHostRpc(call) {
        if (call.method === "ackInvocation") {
          acknowledgements++;

          if (!acknowledge) throw new Error("Host unavailable");

          return { acknowledged: true };
        }

        return {
          attemptId: request.attemptId,
          specHash: request.specHash,
          status: "succeeded",
          pid: 100,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          exitCode: 0,
          reason: null,
          quiescent: true,
          bytes: 0,
        };
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    await adapter.start(request);
    await expect(adapter.retire!(request)).rejects.toThrow("Host unavailable");
    acknowledge = true;
    await adapter.retire!(request);
    await adapter.retire!(request);
    expect(acknowledgements).toBe(2);
  });

  it("rejects a foreign worker before stop or archive even when a stored thread ID exists", async () => {
    const request = invocation();
    request.state = {
      id: "agent",
      title: "Agent",
      subtitle: "",
      kind: "agent",
      deadlineMs: 60000,
      maxAttempts: 1,
      effect: "local-read",
      effectTarget: "env_test",
      annotations: { category: null },
      action: {
        prompt: "Check",
        execution: { providerId: "codex", model: "model", reasoningLevel: "high" },
        permissionMode: "auto",
        environmentId: "env_test",
        result: { outcomes: [{ name: "ok", fields: [] }] },
      },
    };
    request.threadId = "thr_foreign";

    const host = createFakePluginHost({
      pluginId: "state-machines",
      sdk: {
        threads: {
          get: () =>
            makeThreadResponse({
              id: "thr_foreign",
              projectId: "proj_test",
              originPluginId: "another-plugin",
            }),
          getPluginMetadata: () => ({
            stateMachineWorker: 1,
            instanceId: request.instanceId,
            entryId: request.entryId,
            invocationId: request.invocationId,
            attemptId: request.attemptId,
            generation: request.generation,
            specHash: request.specHash,
          }),
        },
      },
    });

    hosts.push(host);
    const adapter = createOmnyoStateMachineAdapter(host.api);
    await expect(adapter.cancel(request)).rejects.toThrow("SCOPE_MISMATCH");
    await expect(adapter.retire!(request)).rejects.toThrow("SCOPE_MISMATCH");
    expect(host.harness.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(host.harness.sdk.callsTo("threads.archive")).toHaveLength(0);
  });
});

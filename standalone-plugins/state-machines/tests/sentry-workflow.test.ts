import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createOmnyoStateMachineAdapter } from "../src/actions/omnyo-adapter.js";
import { sentryWorkflowRequest } from "../src/actions/sentry-workflow.js";
import type { ActionInvocation } from "../src/runtime/adapter.js";
import { createLocalCheckLoop } from "../templates/index.js";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();
});

function invocation(): ActionInvocation {
  const template = createLocalCheckLoop({ machineId: "mch_test", environmentId: "env_test" });
  const state = template.states.find((state) => state.kind === "command");

  if (!state || state.kind !== "command") throw new Error("Missing command fixture");

  return {
    instanceId: "ins_test",
    entryId: "ent_test",
    invocationId: "inv_test",
    attemptId: "try_test",
    generation: 2,
    specHash: "a".repeat(64),
    projectId: "proj_test",
    environmentId: "env_test",
    state: {
      ...state,
      effect: "external-write",
      action: {
        ...state.action,
        argv: [
          { literal: "omnyo" },
          { literal: "sentry" },
          { literal: "workflow-step" },
          { literal: "publish" },
          { literal: "--run" },
          { contextPath: "runId" },
        ],
      },
    },
    context: { runId: "run_test" },
    dispatchedAt: 1000,
    deadlineAt: 61000,
    threadId: null,
    attempt: 1,
    homeThreadId: null,
  };
}

const expected = {
  instanceId: "ins_test",
  entryId: "ent_test",
  invocationId: "inv_test",
  attemptId: "try_test",
  generation: 2,
  specHash: "a".repeat(64),
  projectId: "proj_test",
  environmentId: "env_test",
  stateId: "check",
  operation: "publish",
  runId: "run_test",
  deadlineAt: 61000,
};

function setup(allowed = true) {
  const requests: { method: string; input: unknown }[] = [];

  const host = createFakePluginHost({
    pluginId: "state-machines",
    sdk: {
      environments: {
        get: () => ({
          projectId: "proj_test",
          hostId: "host_original",
          path: "/workspace",
          managed: false,
          lifecycle: { phase: "active", retireAt: null },
        }),
      },
      plugins: {
        callRpc: (request) => {
          requests.push({ method: request.method, input: request.input });

          if (request.method === "workflow.authorize")
            return allowed
              ? { allowed: true, reference: "user:approved-omnyo", scope: "repo:omnyo" }
              : { allowed: false };

          if (request.method === "workflow.log")
            return { text: "Verified the exact commit", nextCursor: 25, truncated: false };

          if (request.method === "workflow.cancel")
            return {
              status: "quiescent",
              confirmedLive: false,
              result: { type: "cancelled", payload: {} },
            };

          return { status: "running", confirmedLive: true, threadId: "thr_solver" };
        },
      },
    },
    experimental_callHostRpc: () => {
      throw new Error("A Sentry workflow must not execute a host command");
    },
  });

  hosts.push(host);

  return { adapter: createOmnyoStateMachineAdapter(host.api), requests };
}

describe("Sentry workflow delegation", () => {
  it("binds authorization and dispatch to the exact invocation without executing the command", async () => {
    const { adapter, requests } = setup();
    const input = invocation();
    expect(await adapter.authorize?.(input)).toMatchObject({ allowed: true });
    expect(await adapter.start(input)).toMatchObject({ status: "running", threadId: "thr_solver" });
    expect(requests).toEqual([
      { method: "workflow.authorize", input: expected },
      { method: "workflow.authorize", input: expected },
      { method: "workflow.start", input: expected },
    ]);
  });

  it("preserves refusal and rechecks authority before a direct start", async () => {
    const { adapter, requests } = setup(false);
    expect(await adapter.authorize?.(invocation())).toEqual({ allowed: false });
    await expect(adapter.start(invocation())).rejects.toThrow("AUTHORITY_REQUIRED");
    expect(requests.map((request) => request.method)).toEqual([
      "workflow.authorize",
      "workflow.authorize",
    ]);
  });

  it("routes observation, cancellation and logs to Sentry while retaining its execution evidence", async () => {
    const { adapter, requests } = setup();
    const input = invocation();
    expect(await adapter.inspect(input)).toMatchObject({ status: "running", confirmedLive: true });
    expect(await adapter.cancel(input)).toMatchObject({
      status: "quiescent",
      result: { type: "cancelled" },
    });
    expect(await adapter.readLog({ invocation: input, cursor: 4, limit: 50 })).toEqual({
      text: "Verified the exact commit",
      nextCursor: 25,
      truncated: false,
    });
    await adapter.retire?.(input);
    expect(requests).toEqual([
      { method: "workflow.inspect", input: expected },
      { method: "workflow.cancel", input: expected },
      { method: "workflow.log", input: { ...expected, cursor: 4, limit: 50 } },
    ]);
  });

  it("keeps other external writes refused", async () => {
    const { adapter, requests } = setup();
    const input = invocation();

    if (input.state.kind !== "command") throw new Error("Expected command");
    input.state.action.argv = [{ literal: "git" }, { literal: "push" }];
    expect(await adapter.authorize?.(input)).toEqual({ allowed: false });
    await expect(adapter.start(input)).rejects.toThrow("AUTHORITY_REQUIRED");
    expect(requests).toEqual([]);
  });

  it.each([
    ["omnyo", "sentry", "workflow-step", "unlisted", "--run", "run_test"],
    ["omnyo", "sentry", "workflow-step", "publish", "--run", "run_test", "extra"],
    ["omnyo", "sentry", "workflow-step", "publish", "--run", "bad/run"],
  ])("rejects forged workflow arguments %j", (...argv) => {
    expect(() => sentryWorkflowRequest(invocation(), argv)).toThrow("SCOPE_MISMATCH");
  });

  it("rejects an understated effect and a dynamic operation", async () => {
    const { adapter, requests } = setup();
    const input = invocation();
    input.state.effect = "local-read";
    await expect(adapter.authorize?.(input)).rejects.toThrow("SCOPE_MISMATCH");
    input.state.effect = "external-write";

    if (input.state.kind !== "command") throw new Error("Expected command");
    input.context.operation = "publish";
    input.state.action.argv[3] = { contextPath: "operation" };
    await expect(adapter.start(input)).rejects.toThrow("SCOPE_MISMATCH");
    expect(requests).toEqual([]);
  });
});

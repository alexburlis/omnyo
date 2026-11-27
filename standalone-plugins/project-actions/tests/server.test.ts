import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { z } from "zod";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import plugin, { checkState } from "../server";
import { configSchema, hostContract, runSchema, stateSchema } from "../contract";

const action = {
  id: "launch",
  label: "Launch",
  kind: "command",
  hostId: "host-a",
  cwd: "/tmp",
  argv: ["/usr/bin/true"],
  timeoutMs: 1000,
};

test("project config persists across reload; revisions reject stale writes and isolate projects", async () => {
  const { api, harness } = createFakePluginHost({ pluginId: "project-actions" });
  plugin(api);
  let call = harness.behavior.callRpc;
  assert.deepEqual(await call("list", { projectId: "a" }), {
    revision: 0,
    actions: [],
    runs: [],
    states: [],
  });
  await call("replace", { projectId: "a", revision: 0, actions: [action] });
  await assert.rejects(call("replace", { projectId: "a", revision: 0, actions: [] }));
  assert.deepEqual(await call("list", { projectId: "b" }), {
    revision: 0,
    actions: [],
    runs: [],
    states: [],
  });
  const replacement = await harness.lifecycle.reload(plugin);
  call = replacement.harness.behavior.callRpc;
  assert.equal(configSchema.parse(await call("list", { projectId: "a" })).revision, 1);
  await call("replace", { projectId: "a", revision: 1, actions: [] });
  assert.equal(configSchema.parse(await call("list", { projectId: "a" })).actions.length, 0);
  await replacement.harness.lifecycle.dispose();
});

test("invalid URL, duplicate IDs and relative paths fail boundary validation", async () => {
  const { api, harness } = createFakePluginHost({ pluginId: "project-actions" });
  plugin(api);

  for (const actions of [
    [{ id: "bad", label: "Bad", kind: "url", url: "javascript:alert(1)" }],
    [action, action],
    [{ ...action, cwd: "relative" }],
  ]) {
    await assert.rejects(
      harness.behavior.callRpc("replace", { projectId: "a", revision: 0, actions }),
    );
  }

  await harness.lifecycle.dispose();
});

test("command completion and failure expose actual exit metadata without output", async () => {
  let exitCode = 0;

  const { api, harness } = createFakePluginHost({
    pluginId: "project-actions",
    experimental_callHostRpc: async () => ({ exitCode, signal: null, stopped: false }),
  });

  plugin(api);
  await harness.behavior.callRpc("replace", { projectId: "a", revision: 0, actions: [action] });
  assert.equal(
    runSchema.parse(await harness.behavior.callRpc("run", { projectId: "a", id: "launch" })).status,
    "succeeded",
  );
  exitCode = 7;

  const failure = runSchema.parse(
    await harness.behavior.callRpc("run", { projectId: "a", id: "launch" }),
  );

  assert.equal(failure.status, "failed");
  assert.match(failure.detail, /7/);
  await harness.lifecycle.dispose();
});

test("running action blocks duplicate execution and removal", async () => {
  let finish: (() => void) | undefined;

  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const { api, harness } = createFakePluginHost({
    pluginId: "project-actions",
    experimental_callHostRpc: async () => {
      await gate;

      return { exitCode: 0, signal: null, stopped: false };
    },
  });

  plugin(api);
  await harness.behavior.callRpc("replace", { projectId: "a", revision: 0, actions: [action] });
  const pending = harness.behavior.callRpc("run", { projectId: "a", id: "launch" });
  await assert.rejects(harness.behavior.callRpc("run", { projectId: "a", id: "launch" }));
  await assert.rejects(
    harness.behavior.callRpc("replace", { projectId: "a", revision: 1, actions: [] }),
  );
  finish?.();
  await pending;
  await harness.lifecycle.dispose();
});

test("force quit marks the run stopping, then stopped, and rejects idle actions", async () => {
  let finish: ((stopped: boolean) => void) | undefined;
  const calls: string[] = [];

  const { api, harness } = createFakePluginHost({
    pluginId: "project-actions",
    experimental_callHostRpc: async (call) => {
      calls.push(call.method);

      if (call.method === "stop") {
        finish?.(true);

        return { stopped: true };
      }

      const stopped = await new Promise<boolean>((resolve) => {
        finish = resolve;
      });

      return { exitCode: null, signal: "SIGTERM", stopped };
    },
  });

  plugin(api);
  await harness.behavior.callRpc("replace", { projectId: "a", revision: 0, actions: [action] });
  await assert.rejects(harness.behavior.callRpc("stop", { projectId: "a", id: "launch" }));
  const pending = harness.behavior.callRpc("run", { projectId: "a", id: "launch" });
  await new Promise((resolve) => setImmediate(resolve));
  await harness.behavior.callRpc("stop", { projectId: "a", id: "launch" });
  const result = runSchema.parse(await pending);
  assert.equal(result.status, "stopped");
  assert.deepEqual(calls, ["execute", "stop"]);
  await harness.lifecycle.dispose();
});

test("native LLM tool edits only the caller project", async () => {
  const { api, harness } = createFakePluginHost({ pluginId: "project-actions" });
  plugin(api);
  await harness.behavior.callAgentTool(
    "project_actions",
    { operation: "replace", revision: 0, actions: [action] },
    { projectId: "caller" },
  );

  const own = await harness.behavior.callAgentTool(
    "project_actions",
    { operation: "list" },
    { projectId: "caller" },
  );

  assert.match(String(own), /launch/);

  const other = await harness.behavior.callAgentTool(
    "project_actions",
    { operation: "list" },
    { projectId: "other" },
  );

  assert.equal(String(other), JSON.stringify({ revision: 0, actions: [], runs: [], states: [] }));
  await assert.rejects(
    harness.behavior.callAgentTool(
      "project_actions",
      { operation: "replace", revision: 0, actions: [] },
      { projectId: "caller" },
    ),
  );
  await harness.lifecycle.dispose();
});

test("host activity reaches only its running action and clears when the run ends", async () => {
  let finish: (() => void) | undefined;
  let runId = "";

  const { api, harness } = createFakePluginHost({
    pluginId: "project-actions",
    experimental_callHostRpc: async (call) => {
      runId = hostContract.execute.input.parse(call.input).runId;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });

      return { exitCode: 0, signal: null, stopped: false };
    },
  });

  plugin(api);
  await harness.behavior.callRpc("replace", { projectId: "a", revision: 0, actions: [action] });
  const pending = harness.behavior.callRpc("run", { projectId: "a", id: "launch" });
  await new Promise((resolve) => setImmediate(resolve));

  const progress = { current: 3, total: 4 };
  await harness.behavior.experimental_emitHostSignal("host-b", "activity", {
    runId,
    text: "Wrong machine",
    progress: null,
  });
  await harness.behavior.experimental_emitHostSignal("host-a", "activity", {
    runId,
    text: "Building",
    progress,
  });

  const running = runSchema.parse(
    configSchema
      .extend({ runs: runSchema.array() })
      .parse(await harness.behavior.callRpc("list", { projectId: "a" })).runs[0],
  );

  assert.equal(running.status, "running");
  assert.deepEqual(running.activity, { text: "Building", progress });
  assert.ok(running.startedAt && running.startedAt <= Date.now());
  finish?.();
  const done = runSchema.parse(await pending);
  assert.equal(done.status, "succeeded");
  assert.equal(done.activity, null);
  assert.equal(done.startedAt, null);
  await harness.lifecycle.dispose();
});

test("a status check's exit sets its tone, and its line or a reason sets its text", () => {
  const output = (exitCode: number | null, text?: string, signal: string | null = null) => ({
    exitCode,
    signal,
    activity: text ? { text, progress: null } : null,
    startError: null,
  });

  assert.deepEqual(checkState("a", output(0, "Running the latest build")), {
    id: "a",
    tone: "on",
    text: "Running the latest build",
  });
  assert.deepEqual(checkState("a", output(1)), { id: "a", tone: "off", text: "Not running" });
  assert.equal(checkState("a", output(2)).tone, "attention");
  assert.deepEqual(checkState("a", output(7, "git missing")), {
    id: "a",
    tone: "unknown",
    text: "Status check failed (7): git missing",
  });
  assert.equal(checkState("a", output(null, undefined, "SIGKILL")).text, "Status check timed out");
  assert.deepEqual(checkState("a", { ...output(null), startError: "ENOENT" }), {
    id: "a",
    tone: "unknown",
    text: "Status check could not start (ENOENT)",
  });
  assert.deepEqual(checkState("a", null), {
    id: "a",
    tone: "unknown",
    text: "Could not reach the machine to check.",
  });
  assert.equal(checkState("a", output(3, "x".repeat(400))).text.length, 160);
});

const answered = () => new Promise((resolve) => setTimeout(resolve, 10));

function checkedHost() {
  const checks: unknown[] = [];
  let exitCode = 2;
  let hold: Promise<void> | null = null;

  const fake = createFakePluginHost({
    pluginId: "project-actions",
    experimental_callHostRpc: async (call) => {
      if (call.method === "execute") {
        exitCode = 0;

        return { exitCode: 0, signal: null, stopped: false };
      }

      checks.push({ hostId: call.hostId, input: call.input });
      const answer = { exitCode, signal: null, startError: null };
      await hold;

      return { ...answer, activity: { text: `exit ${answer.exitCode}`, progress: null } };
    },
  });

  plugin(fake.api);
  const call = fake.harness.behavior.callRpc;

  // The first list starts any due check; the second shows its answer.
  const states = async () => {
    await call("list", { projectId: "a" });
    await answered();

    return listing
      .parse(await call("list", { projectId: "a" }))
      .states.map(({ id, tone, text }) => ({ id, tone, text }));
  };

  return {
    ...fake,
    call,
    checks,
    states,
    holdChecks: () => {
      let release = () => {};

      hold = new Promise<void>((resolve) => {
        release = resolve;
      });

      return () => {
        hold = null;
        release();
      };
    },
  };
}

const listing = z.object({ states: stateSchema.array() });

const checked = { ...action, check: { argv: ["/usr/bin/true"], intervalMs: 60000 } };

test("status checks run on list at most once per interval, and again at once after a run", async () => {
  const { harness, call, checks, states } = checkedHost();
  await call("replace", { projectId: "a", revision: 0, actions: [checked] });

  assert.deepEqual(await states(), [{ id: "launch", tone: "attention", text: "exit 2" }]);
  await states();
  assert.equal(checks.length, 1, "A second list within the interval reuses the result.");
  assert.deepEqual(checks[0], {
    hostId: "host-a",
    input: { cwd: "/tmp", argv: ["/usr/bin/true"], timeoutMs: 10000 },
  });

  await call("run", { projectId: "a", id: "launch" });
  await answered();
  assert.equal(checks.length, 2, "A finished run checks again at once.");
  assert.deepEqual(await states(), [{ id: "launch", tone: "on", text: "exit 0" }]);
  await harness.lifecycle.dispose();
});

test("a run that ends mid-check checks once more, and a removed action's late answer is dropped", async () => {
  const { harness, call, checks, states, holdChecks } = checkedHost();
  await call("replace", { projectId: "a", revision: 0, actions: [checked] });

  let release = holdChecks();
  await call("list", { projectId: "a" });
  await call("run", { projectId: "a", id: "launch" });
  assert.equal(checks.length, 1, "The run's check waits for the one in flight.");
  release();
  await answered();
  assert.equal(checks.length, 2, "Then it runs once, for the run's result.");
  assert.deepEqual(await states(), [{ id: "launch", tone: "on", text: "exit 0" }]);

  await call("replace", { projectId: "a", revision: 1, actions: [] });
  await call("replace", { projectId: "a", revision: 2, actions: [checked] });
  release = holdChecks();
  await call("list", { projectId: "a" });
  await call("replace", { projectId: "a", revision: 3, actions: [] });
  const published = harness.realtimeSignals.length;
  release();
  await answered();
  assert.equal(
    harness.realtimeSignals.length,
    published,
    "A removed action's late answer publishes nothing.",
  );
  await call("replace", { projectId: "a", revision: 4, actions: [checked] });
  assert.deepEqual(
    listing.parse(await call("list", { projectId: "a" })).states,
    [],
    "A re-added action never shows an old answer.",
  );
  await harness.lifecycle.dispose();
});

test("a changed check never shows the old result, and an action without one runs none", async () => {
  const { harness, call, checks, states } = checkedHost();
  await call("replace", { projectId: "a", revision: 0, actions: [checked] });
  await states();
  await call("replace", {
    projectId: "a",
    revision: 1,
    actions: [{ ...checked, check: { argv: ["/usr/bin/false"], intervalMs: 60000 } }],
  });
  assert.deepEqual(listing.parse(await call("list", { projectId: "a" })).states, []);
  await answered();
  await call("replace", { projectId: "a", revision: 2, actions: [action] });
  const before = checks.length;
  assert.deepEqual(await states(), []);
  assert.equal(checks.length, before);
  await harness.lifecycle.dispose();
});

test("a state nobody polled lately is left out, and agent listings wait for a fresh check", async () => {
  const { harness, call, checks, states } = checkedHost();
  await call("replace", { projectId: "a", revision: 0, actions: [checked] });
  await states();
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 2 * 60000 + 10001 });

  try {
    const stale = listing.parse(await call("list", { projectId: "a" })).states;
    assert.deepEqual(stale, [], "An old state is not shown as current.");
    await answered();
    assert.equal(checks.length, 2, "That list started a new check.");

    mock.timers.setTime(Date.now() + 2 * 60000 + 10001);

    const tool = JSON.parse(
      String(
        await harness.behavior.callAgentTool(
          "project_actions",
          { operation: "list" },
          { projectId: "a" },
        ),
      ),
    );

    assert.equal(checks.length, 3, "The agent listing ran the due check first.");
    assert.equal(listing.parse(tool).states.length, 1, "and shows its answer.");
  } finally {
    mock.timers.reset();
  }

  await harness.lifecycle.dispose();
});

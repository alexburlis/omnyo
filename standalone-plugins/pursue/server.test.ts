import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import plugin, { rpcContract } from "./server.ts";

type Goal = NonNullable<ReturnType<typeof rpcContract.pursue_state.output.parse>["goal"]>;

type Evaluation = NonNullable<Goal["evaluation"]>;

interface FixtureState {
  ownerStatus: "idle" | "active";
  judgeStatus: "idle" | "active";
  output: () => Promise<string>;
  spawned: string[];
  sent: string[];
  deleted: string[];
  sendError: boolean;
  started: string[];
  settled: { verdict: string; summary: string }[];
  effects: string[];
}

type FakeHost = ReturnType<typeof createFakePluginHost>;

function stubProducers(host: FakeHost, state: FixtureState) {
  host.harness.sdk.stub(
    "experimental_inbox.startProducer",
    async ({ label }: { label: string }) => {
      state.started.push(label);

      return { producer: { id: "producer_1", status: "active" }, receiptId: null };
    },
  );
  host.harness.sdk.stub(
    "experimental_inbox.settleProducer",
    async ({ verdict, summary }: { verdict: string; summary: string }) => {
      state.settled.push({ verdict, summary });
      state.effects.push(`settle:${verdict}`);

      return {
        producer: { id: "producer_1", status: verdict === "unmet" ? "active" : "ended" },
        receiptId: verdict === "unmet" ? null : "receipt_1",
      };
    },
  );
}

const goalMapSchema = z.record(z.string(), rpcContract.pursue_state.output.shape.goal);

const ownerId = "thr_owner";

const judgeId = "thr_judge_1";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function goal(): Goal {
  return {
    threadId: ownerId,
    projectId: "proj_test",
    objective: "The requested repair passes its acceptance check.",
    iterations: 0,
    maxIterations: 3,
    status: "active",
    lastVerdict: null,
    createdAt: "2026-10-21T18:00:00.000Z",
    revision: 0,
    producerId: "producer_1",
  };
}

function pending(phase: Evaluation["phase"] = "judging"): Evaluation {
  return {
    ownerThreadId: ownerId,
    goalCreatedAt: goal().createdAt,
    goalRevision: 0,
    iteration: 0,
    judgeAttempt: 1,
    judgeThreadId: phase === "spawning" ? null : judgeId,
    phase,
  };
}

async function setup(t: TestContext, storedGoal: Goal = goal()) {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const state: FixtureState = {
    ownerStatus: "idle",
    judgeStatus: "idle",
    output: async () => "UNMET: The acceptance check is still incomplete.",
    spawned: [],
    sent: [],
    deleted: [],
    sendError: false,
    started: [],
    settled: [],
    effects: [],
  };

  const owner = (id = ownerId) =>
    makeThreadResponse({
      id,
      projectId: "proj_test",
      environmentId: "env_test",
      status: state.ownerStatus,
    });

  let host = createFakePluginHost({
    pluginId: "pursue",
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threadId === ownerId || threadId === "thr_owner_2"
            ? owner(threadId)
            : makeThreadResponse({
                id: threadId,
                status: state.judgeStatus,
                environmentId: "env_test",
              }),
        spawn: async () => {
          const id = `thr_judge_${state.spawned.length + 1}`;
          state.spawned.push(id);

          return makeThreadResponse({ id, environmentId: "env_test" });
        },
        output: async () => ({ output: await state.output() }),
        send: async ({ threadId }) => {
          state.sent.push(threadId);
          state.effects.push("send");

          if (state.sendError) throw new Error("transport closed after dispatch");

          return owner(threadId);
        },
        delete: async ({ threadId }) => {
          state.deleted.push(threadId);

          return { ok: true };
        },
      },
    },
  });

  stubProducers(host, state);
  await plugin(host.api);
  await host.api.storage.kv.set("goals", { [ownerId]: storedGoal });
  await host.api.storage.kv.set("judge-thread-ids", [judgeId]);
  t.after(() => host.harness.lifecycle.dispose());

  return {
    state,
    get host() {
      return host;
    },
    async stored(threadId = ownerId) {
      return (await host.api.storage.kv.get<Record<string, Goal>>("goals"))?.[threadId];
    },
    idle() {
      return host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: owner(),
        lastAssistantText: "The check is still pending.",
      });
    },
    async reload() {
      host = await host.harness.lifecycle.reload(plugin);
      stubProducers(host, state);
    },
    async start() {
      const service = host.harness.behavior.runService("reconcile");
      await flush();

      return service;
    },
    async tick() {
      t.mock.timers.tick(2_000);
      await flush();
    },
  };
}

test("only visible chats receive default goal guidance", async (t) => {
  const host = createFakePluginHost({ pluginId: "pursue", agentSkillIds: ["pursue"] });
  t.after(() => host.harness.lifecycle.dispose());
  await plugin(host.api);

  const visible = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { experimental_visibility: "visible" } }),
  );

  const hidden = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ thread: { experimental_visibility: "hidden" } }),
  );

  assert.match(visible.instructions ?? "", /omnyo pursue goal/);
  assert.equal(hidden.instructions, null);
  assert.deepEqual(visible.skills, ["pursue"]);
  assert.deepEqual(hidden.skills, ["pursue"]);
});

test("startup consumes an existing completed judge once without spawning or deleting history", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  await f.start();
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.equal((await f.stored()).iterations, 1);
  assert.equal((await f.stored()).evaluation, undefined);
  await f.reload();
  await f.start();
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.deleted, []);
});

test("concurrent startup preserves both goals and continues each existing judge once", async (t) => {
  const first = { ...goal(), evaluation: pending() };

  const second = {
    ...goal(),
    threadId: "thr_owner_2",
    evaluation: {
      ...pending(),
      ownerThreadId: "thr_owner_2",
      judgeThreadId: "thr_judge_2",
    },
  };

  const f = await setup(t, first);
  await f.host.api.storage.kv.set("goals", {
    [ownerId]: first,
    [second.threadId]: second,
  });
  await f.host.api.storage.kv.set("judge-thread-ids", [judgeId, "thr_judge_2"]);
  await f.start();
  assert.deepEqual(f.state.sent.sort(), [ownerId, second.threadId].sort());

  for (const id of [ownerId, second.threadId]) {
    const saved = await f.stored(id);
    assert.equal(saved.iterations, 1);
    assert.equal(saved.evaluation, undefined);
  }

  await f.reload();
  await f.start();
  assert.equal(f.state.sent.length, 2);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.deleted, []);
});

test("a clear racing with the persisted send intent cannot resurrect the goal or send its continuation", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  const storage = f.host.api.storage.kv;
  const originalSet = storage.set.bind(storage);
  let release!: () => void;

  const heldWrite = new Promise<void>((resolve) => {
    release = resolve;
  });

  let intentReached = false;
  storage.set = async (key, value) => {
    const parsed = goalMapSchema.safeParse(value);

    if (
      key === "goals" &&
      parsed.success &&
      parsed.data[ownerId]?.evaluation?.phase === "sending"
    ) {
      intentReached = true;
      await heldWrite;
    }

    await originalSet(key, value);
  };

  try {
    await f.start();
    assert.equal(intentReached, true);

    const clearing = f.host.harness.behavior.callRpc("pursue_clear_goal", {
      threadId: ownerId,
    });

    await flush();
    release();
    await clearing;
    await flush();
    assert.equal(await f.stored(), undefined);
    assert.deepEqual(f.state.sent, []);
    assert.deepEqual(f.state.spawned, []);
  } finally {
    release();
  }
});

test("disposal waits for a blocked goal write before reload exposes its persisted binding", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  const storage = f.host.api.storage.kv;
  const originalSet = storage.set.bind(storage);
  let release!: () => void;

  const heldWrite = new Promise<void>((resolve) => {
    release = resolve;
  });

  let intentReached = false;
  storage.set = async (key, value) => {
    const parsed = goalMapSchema.safeParse(value);

    if (
      key === "goals" &&
      parsed.success &&
      parsed.data[ownerId]?.evaluation?.phase === "sending"
    ) {
      intentReached = true;
      await heldWrite;
    }

    await originalSet(key, value);
  };

  const service = await f.start();
  let reloaded = false;

  const reloading = f.reload().then(() => {
    reloaded = true;
  });

  try {
    assert.equal(intentReached, true);
    await flush();
    assert.equal(reloaded, false, "disposal must wait for the accepted goal write");
    release();
    await reloading;
    await service.done;
    const saved = await f.stored();
    assert.ok(saved);
    assert.equal(saved.iterations, 1);
    assert.deepEqual(saved.evaluation, pending("sending"));
    assert.deepEqual(f.state.sent, []);
    assert.deepEqual(f.state.spawned, []);
  } finally {
    release();
    await reloading;
    await service.done;
  }
});

test("restart while a judge runs preserves its binding and resumes that same judge", async (t) => {
  const f = await setup(t);
  f.state.judgeStatus = "active";
  const oldIdle = f.idle();
  await flush();
  assert.equal((await f.stored()).evaluation.judgeThreadId, judgeId);
  await f.reload();
  await oldIdle;
  await f.start();
  assert.deepEqual(f.state.spawned, [judgeId]);
  assert.deepEqual(f.state.sent, []);
  f.state.judgeStatus = "idle";
  await f.tick();
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.equal((await f.stored()).iterations, 1);
  assert.deepEqual(f.state.spawned, [judgeId]);
  assert.deepEqual(f.state.deleted, []);
});

test("restart after result read does not let the disposed callback apply it twice", async (t) => {
  const f = await setup(t);
  let release!: (value: string) => void;

  const held = new Promise<string>((resolve) => {
    release = resolve;
  });

  let reads = 0;
  f.state.output = async () => {
    reads += 1;

    return reads === 1 ? held : "UNMET: One check remains.";
  };

  const oldIdle = f.idle();
  await flush();
  await f.tick();
  assert.equal(reads, 1);
  await f.reload();
  await f.start();
  assert.deepEqual(f.state.sent, [ownerId]);
  release("UNMET: One check remains.");
  await oldIdle;
  assert.equal((await f.stored()).iterations, 1);
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.deepEqual(f.state.spawned, [judgeId]);
});

test("pursue_goals answers many threads in one call and omits threads without a goal", async (t) => {
  const f = await setup(t);

  const result = rpcContract.pursue_goals.output.parse(
    await f.host.harness.behavior.callRpc("pursue_goals", {
      threadIds: [ownerId, "thr_other", "thr_third"],
    }),
  );

  assert.deepEqual(Object.keys(result.goals), [ownerId]);
  assert.equal(result.goals[ownerId]?.objective, goal().objective);

  assert.deepEqual(
    await f.host.harness.behavior.callRpc("pursue_goals", { threadIds: [] }),
    { goals: {} },
  );
});

for (const action of ["edit", "clear"] as const) {
  test(`${action} while judging prevents a stale result from restoring or advancing the goal`, async (t) => {
    const f = await setup(t);
    f.state.judgeStatus = "active";
    const oldIdle = f.idle();
    await flush();
    f.state.ownerStatus = "active";
    await f.host.harness.behavior.callRpc(
      action === "edit" ? "pursue_edit_goal" : "pursue_clear_goal",
      action === "edit"
        ? { threadId: ownerId, objective: "The replacement acceptance passes." }
        : { threadId: ownerId },
    );
    f.state.ownerStatus = "idle";
    f.state.judgeStatus = "idle";
    await f.tick();
    await oldIdle;
    await f.reload();
    await f.start();
    const stored = await f.stored();

    if (action === "clear") assert.equal(stored, undefined);
    else {
      assert.equal(stored.revision, 1);
      assert.equal(stored.iterations, 0);
      assert.equal(stored.evaluation, undefined);
    }

    assert.deepEqual(f.state.sent, []);
    assert.deepEqual(f.state.spawned, [judgeId]);
    assert.deepEqual(f.state.deleted, []);
  });
}

test("startup leaves an active owner alone, then its idle event resumes the bound judge", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.state.ownerStatus = "active";
  await f.start();
  assert.deepEqual(f.state.sent, []);
  assert.equal((await f.stored()).iterations, 0);
  f.state.ownerStatus = "idle";
  const idle = f.idle();
  await flush();
  await f.tick();
  await idle;
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.deepEqual(f.state.spawned, []);
});

test("an owner becoming active before application keeps the same result pending until idle", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.state.output = async () => {
    f.state.ownerStatus = "active";

    return "UNMET: One check remains.";
  };

  await f.start();
  assert.deepEqual(f.state.sent, []);
  assert.equal((await f.stored()).iterations, 0);
  assert.equal((await f.stored()).evaluation.judgeThreadId, judgeId);
  f.state.ownerStatus = "idle";
  f.state.output = async () => "UNMET: One check remains.";
  await f.idle();
  assert.deepEqual(f.state.sent, [ownerId]);
  assert.deepEqual(f.state.spawned, []);
});

for (const phase of ["spawning", "sending"] as const) {
  test(`restart at the uncertain ${phase} boundary stops visibly without repeating the effect`, async (t) => {
    const f = await setup(t, {
      ...goal(),
      iterations: phase === "sending" ? 1 : 0,
      evaluation: pending(phase),
    });

    await f.start();
    assert.equal((await f.stored()).status, "stopped");
    assert.match((await f.stored()).lastVerdict, /uncertain/i);
    await f.reload();
    await f.start();
    assert.deepEqual(f.state.sent, []);
    assert.deepEqual(f.state.spawned, []);
    assert.deepEqual(f.state.deleted, []);
  });
}

for (const reason of ["One check remains.", "The provider outcome uncertain."]) {
  test(`a send error stops visibly without blind resend when the judge says: ${reason}`, async (t) => {
    const f = await setup(t, { ...goal(), evaluation: pending() });
    f.state.output = async () => `UNMET: ${reason}`;
    f.state.sendError = true;
    await f.start();
    assert.equal((await f.stored()).status, "stopped");
    assert.match((await f.stored()).lastVerdict, /uncertain/i);
    await f.reload();
    await f.start();
    assert.deepEqual(f.state.sent, [ownerId]);
    assert.equal((await f.stored()).iterations, 1);
  });
}

test("an existing MET judge clears the goal without sending or deleting its history", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.state.output = async () => "MET";
  await f.start();
  assert.equal(await f.stored(), undefined);
  await f.reload();
  await f.start();
  assert.deepEqual(f.state.sent, []);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.deleted, []);
});

test("each verdict reaches Omnyo's producer before pursue acts on it", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  await f.start();
  assert.deepEqual(f.state.effects, ["settle:unmet", "send"]);
  assert.deepEqual(f.state.settled, [
    { verdict: "unmet", summary: "The acceptance check is still incomplete." },
  ]);
});

test("MET ends the producer with one card naming the objective", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.state.output = async () => "MET";
  await f.start();
  assert.deepEqual(f.state.settled, [
    { verdict: "met", summary: "Goal met: The requested repair passes its acceptance check." },
  ]);
  assert.deepEqual(f.state.sent, []);
});

test("the iteration limit ends the producer before the final report request", async (t) => {
  const f = await setup(t, { ...goal(), maxIterations: 1, evaluation: pending() });
  await f.start();
  assert.deepEqual(f.state.effects, ["settle:limit", "send"]);
  assert.match(f.state.settled[0]?.summary ?? "", /^Goal stopped after 1 checks: /);
  assert.equal((await f.stored()).status, "stopped");
});

test("an uncertain send ends the producer once, across a restart", async (t) => {
  const f = await setup(t, { ...goal(), iterations: 1, evaluation: pending("sending") });
  await f.start();
  assert.deepEqual(
    f.state.settled.map((entry) => entry.verdict),
    ["failed"],
  );
  await f.reload();
  await f.start();
  assert.equal(f.state.settled.length, 1);
});

test("a judge with no clear verdict twice ends the producer as failed", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.state.output = async () => "Probably fine.";
  await f.start();
  assert.deepEqual(f.state.settled, [
    { verdict: "failed", summary: "Goal stopped: judge returned no clear verdict twice" },
  ]);
  assert.deepEqual(f.state.sent, []);
});

test("a producer Omnyo already ended stops the goal instead of sending a continuation", async (t) => {
  const f = await setup(t, { ...goal(), evaluation: pending() });
  f.host.harness.sdk.stub("experimental_inbox.settleProducer", async () => ({
    producer: { id: "producer_1", status: "ended" },
    receiptId: null,
  }));
  await f.start();
  assert.deepEqual(f.state.sent, []);
  assert.equal((await f.stored()).status, "stopped");
});

test("clearing an active goal settles it as stopped; a goal from before producers gets one at startup", async (t) => {
  const f = await setup(t, { ...goal(), producerId: null });
  await f.start();
  assert.deepEqual(f.state.started, [
    "Pursuing: The requested repair passes its acceptance check.",
  ]);
  assert.equal((await f.stored()).producerId, "producer_1");
  await f.host.harness.behavior.callRpc("pursue_clear_goal", { threadId: ownerId });
  assert.deepEqual(f.state.settled, [
    {
      verdict: "stopped",
      summary: "Goal cleared: The requested repair passes its acceptance check.",
    },
  ]);
});

test("archiving drops the goal and never reopens the chat", async (t) => {
  const f = await setup(t);
  f.host.harness.sdk.stub("threads.unarchive", async () => ({}));

  const result = await f.host.harness.behavior.emitThreadEvent("thread.archived", {
    thread: makeThreadResponse({ id: ownerId }),
  });

  assert.deepEqual(result.errors, []);
  assert.equal(await f.stored(), undefined);
  assert.deepEqual(f.host.harness.sdk.callsTo("threads.unarchive"), []);
});

interface FakeWait {
  id: string;
  key: string;
  status: "live" | "dispatched" | "closed";
  checkCount: number;
  nextCheckAt: number | null;
  closedReason: string | null;
}

interface Registration {
  key: string;
  for: string;
  check: { what: string; at: number };
  resume: string;
  by: number;
}

interface LegacyLoopRecord {
  threadId: string;
  prompt: string;
  intervalMs: number;
  nextAtMs: number;
  iterations: number;
  maxIterations: number | null;
  createdAt: string;
}

async function setupLoop(t: TestContext, stored?: LegacyLoopRecord) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });

  const waits = new Map<string, FakeWait>();

  const registered: Registration[] = [];

  const cancelled: string[] = [];

  const host = createFakePluginHost({ pluginId: "pursue" });

  host.harness.sdk.stub("threads.experimental_publishWork", async () => ({}));
  host.harness.sdk.stub(
    "experimental_inbox.registerWait",
    async ({ wait }: { threadId: string; wait: Registration }) => {
      const id = `wait_${waits.size + 1}`;
      waits.set(id, {
        id,
        key: wait.key,
        status: "live",
        checkCount: 0,
        nextCheckAt: wait.check.at,
        closedReason: null,
      });
      registered.push(wait);

      return { wait: { id } };
    },
  );
  host.harness.sdk.stub("experimental_inbox.wait", async ({ waitId }: { waitId: string }) => {
    const wait = waits.get(waitId);

    if (wait === undefined) throw new Error(`no wait ${waitId}`);

    return { wait, closedReason: wait.closedReason };
  });
  host.harness.sdk.stub("experimental_inbox.waits", async () => ({
    waits: [...waits.values()].filter((wait) => wait.status !== "closed"),
  }));
  host.harness.sdk.stub("experimental_inbox.cancelWait", async ({ waitId }: { waitId: string }) => {
    const wait = waits.get(waitId);

    if (wait !== undefined) Object.assign(wait, { status: "closed", closedReason: "agent-cancel" });
    cancelled.push(waitId);

    return {};
  });
  await plugin(host.api);

  if (stored !== undefined) await host.api.storage.kv.set("loops", { [ownerId]: stored });
  t.after(() => host.harness.lifecycle.dispose());
  host.harness.behavior.runService("reconcile");
  await flush();

  return {
    host,
    waits,
    registered,
    cancelled,
    cli(argv: string[]) {
      return host.harness.behavior.runCli(argv, { threadId: ownerId });
    },
    idle() {
      return host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: ownerId }),
        lastAssistantText: null,
      });
    },
    wait(id: string) {
      const wait = waits.get(id);

      if (wait === undefined) throw new Error(`no wait ${id}`);

      return wait;
    },
    work() {
      return host.harness.sdk.callsTo("threads.experimental_publishWork").at(-1)?.[0];
    },
    async stored() {
      return (
        await host.api.storage.kv.get<Record<string, { iterations: number; waitId?: string }>>(
          "loops",
        )
      )?.[ownerId];
    },
  };
}

test("a loop is one Omnyo check wait: a silent rearm keeps it, a reported check opens the next", async (t) => {
  const f = await setupLoop(t);
  const set = await f.cli(["loop", "5m", "Check", "whether", "CI", "passed."]);
  assert.equal(set.exitCode, 0);
  assert.deepEqual(f.registered, [
    {
      key: "pursue-loop",
      for: "Loop: Check whether CI passed.",
      check: { what: "Check whether CI passed.", at: 300_000 },
      resume: "Check whether CI passed.",
      by: 30 * 86_400_000,
    },
  ]);

  f.wait("wait_1").checkCount = 1;
  await f.idle();
  assert.equal(f.registered.length, 1);

  t.mock.timers.tick(60_000);
  Object.assign(f.wait("wait_1"), { status: "closed", closedReason: "resumed" });
  await f.idle();
  assert.equal(f.registered.length, 2);
  assert.equal(f.registered[1]?.check.at, 360_000);
  assert.deepEqual(await f.stored(), {
    ...(await f.stored()),
    iterations: 2,
    waitId: "wait_2",
  });
});

test("--max ends the loop once its checks are used, cancelling the live wait", async (t) => {
  const f = await setupLoop(t);
  await f.cli(["loop", "30s", "Poll", "the", "deploy.", "--max", "2"]);
  f.wait("wait_1").checkCount = 1;
  await f.idle();
  assert.deepEqual(f.cancelled, []);
  f.wait("wait_1").checkCount = 2;
  await f.idle();
  assert.deepEqual(f.cancelled, ["wait_1"]);
  assert.equal(await f.stored(), undefined);
});

for (const reason of ["deadline", "archived", "owner-cancel"]) {
  test(`a loop whose wait closed for ${reason} ends without a new check`, async (t) => {
    const f = await setupLoop(t);
    await f.cli(["loop", "1m", "Look", "again."]);
    Object.assign(f.wait("wait_1"), { status: "closed", closedReason: reason });
    await f.idle();
    assert.equal(f.registered.length, 1);
    assert.equal(await f.stored(), undefined);
  });
}

test("a loop from before Omnyo waits becomes a check wait at startup", async (t) => {
  const f = await setupLoop(t, {
    threadId: ownerId,
    prompt: "Check whether the release finished.",
    intervalMs: 30_000,
    nextAtMs: 0,
    iterations: 3,
    maxIterations: null,
    createdAt: "2026-10-23T22:23:00.000Z",
  });

  assert.equal(f.registered[0]?.check.at, 1_000);
  assert.deepEqual(
    { iterations: (await f.stored())?.iterations, waitId: (await f.stored())?.waitId },
    { iterations: 3, waitId: "wait_1" },
  );
});

function loopWork(waits: unknown[]) {
  return {
    threadId: ownerId,
    pluginId: "pursue",
    contribution: {
      kind: "signals",
      signals: {
        complete: true,
        validUntil: null,
        activity: [],
        waits,
        failures: [],
        postponement: null,
      },
    },
  };
}

test("a live loop reports itself as its chat's next owner until it is stopped", async (t) => {
  const f = await setupLoop(t);
  await f.cli(["loop", "20m", "Check", "the", "queue."]);
  assert.deepEqual(
    f.work(),
    loopWork([
      {
        id: `pursue-loop:${ownerId}`,
        reason: "This chat's loop checks in again by itself.",
        actor: { kind: "agent", id: ownerId, label: "This chat's loop" },
      },
    ]),
  );
  const stopped = await f.cli(["loop", "stop"]);
  assert.equal(stopped.stdout, "Loop stopped.");
  assert.deepEqual(f.cancelled, ["wait_1"]);
  assert.deepEqual(f.work(), loopWork([]));
});

async function seedCanvasPlanGoal(f: Awaited<ReturnType<typeof setup>>) {
  const key = "c".repeat(64);
  const objective = "Execute the selected Canvas plan.";
  await f.host.api.storage.kv.set(`plan-run:${key}`, {
    key,
    sourceThreadId: "thr_source",
    projectId: "proj_test",
    environmentId: "env_test",
    hostId: "host_test",
    path: "/workspace/plan.md",
    sha256: "e".repeat(64),
    objective,
    selection: { providerId: "fixture", model: "fixture-model", reasoningLevel: "high" },
    requestId: "request_plan",
    createdAt: goal().createdAt,
    goalInitialized: false,
    threadId: null,
    phase: "starting",
  });
  f.host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ planExecutionKey: key }));

  const thread = makeThreadResponse({
    id: ownerId,
    projectId: "proj_test",
    environmentId: "env_test",
    parentThreadId: "thr_source",
    originPluginId: "pursue",
  });

  return { key, objective, thread };
}

test("Canvas plan goal starts one producer before persisting a new goal", async (t) => {
  const f = await setup(t);
  await f.host.api.storage.kv.set("goals", {});
  const plan = await seedCanvasPlanGoal(f);

  const results = await Promise.all([
    f.host.harness.behavior.emitThreadEvent("thread.created", { thread: plan.thread }),
    f.host.harness.behavior.emitThreadEvent("thread.created", { thread: plan.thread }),
  ]);

  assert(results.every((result) => result.errors.length === 0));
  assert.deepEqual(f.state.started, [`Pursuing: ${plan.objective}`]);
  assert.equal((await f.stored()).producerId, "producer_1");
  assert.equal((await f.stored()).objective, plan.objective);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.sent, []);
});

test("Canvas plan goal preserves an existing goal and starts no producer", async (t) => {
  const f = await setup(t);
  const existing = { ...goal(), opaque: { keep: "selected work" } };
  await f.host.api.storage.kv.set("goals", { [ownerId]: existing });
  const plan = await seedCanvasPlanGoal(f);

  const result = await f.host.harness.behavior.emitThreadEvent("thread.created", {
    thread: plan.thread,
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(await f.host.api.storage.kv.get("goals"), { [ownerId]: existing });
  assert.deepEqual(f.state.started, []);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.sent, []);
});

test("Canvas plan goal creation stays serialized with a clear and never resurrects work", async (t) => {
  const f = await setup(t);
  await f.host.api.storage.kv.set("goals", {});
  const plan = await seedCanvasPlanGoal(f);
  let release!: () => void;
  let reached = false;

  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  f.host.harness.sdk.stub(
    "experimental_inbox.startProducer",
    async ({ label }: { label: string }) => {
      reached = true;
      f.state.started.push(label);
      await held;

      return { producer: { id: "producer_1", status: "active" }, receiptId: null };
    },
  );

  const creating = f.host.harness.behavior.emitThreadEvent("thread.created", {
    thread: plan.thread,
  });

  let clearing: Promise<unknown> | undefined;

  try {
    await flush();
    assert.equal(reached, true);
    let cleared = false;
    clearing = f.host.harness.behavior
      .callRpc("pursue_clear_goal", { threadId: ownerId })
      .then(() => {
        cleared = true;
      });
    await flush();
    assert.equal(cleared, false);
    release();
    assert.deepEqual((await creating).errors, []);
    await clearing;
    assert.equal(await f.stored(), undefined);
    assert.deepEqual(f.state.started, [`Pursuing: ${plan.objective}`]);
    assert.deepEqual(
      f.state.settled.map((entry) => entry.verdict),
      ["stopped"],
    );
    assert.deepEqual(f.state.spawned, []);
    assert.deepEqual(f.state.sent, []);
  } finally {
    release();
    await creating;
    await clearing;
  }
});

test("Canvas plan goal producer failure preserves absent goal and uninitialized plan", async (t) => {
  const f = await setup(t);
  await f.host.api.storage.kv.set("goals", {});
  const plan = await seedCanvasPlanGoal(f);
  f.host.harness.sdk.stub("experimental_inbox.startProducer", async () => {
    throw new Error("fixture producer refused");
  });

  const result = await f.host.harness.behavior.emitThreadEvent("thread.created", {
    thread: plan.thread,
  });

  assert.equal(result.errors.length, 1);
  assert.equal(await f.stored(), undefined);

  const record = await f.host.api.storage.kv.get<{ goalInitialized: boolean }>(
    `plan-run:${plan.key}`,
  );

  assert.equal(record?.goalInitialized, false);
  assert.deepEqual(f.state.spawned, []);
  assert.deepEqual(f.state.sent, []);
});

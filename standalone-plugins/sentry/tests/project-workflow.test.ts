import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { callbackStatusSchema } from "../contract";
import { ProjectBatches } from "../src/batches";
import { SentryRunner } from "../src/runner";
import { SentryClient } from "../src/intake";
import { SentryStore } from "../src/store";
import { createSentryPlugin } from "../server";
import { route, sentryIssue } from "./fixtures";
import { TurnHistory, settle, type EventsListInput } from "./turn-events";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const connection = async () => ({
  apiOrigin: "https://de.sentry.io",
  apiToken: "fixture-non-secret",
});

function threadState(status: "idle" | "active") {
  return (input: { threadId: string }) => ({
    id: input.threadId,
    status,
    queuedMessageCount: 0,
    activeBackgroundAgentCount: 0,
  });
}

function setup(transport: typeof fetch) {
  let spawned = 0;
  const history = new TurnHistory();
  history.completedTurn("thr_coordinator");
  history.completedTurn("thr_worker");

  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      projects: {
        list: () => [
          {
            id: "proj_app",
            name: "App",
            sources: [
              { id: "src_app", type: "local_path", hostId: "host_mac", path: "/projects/umbrella" },
            ],
          },
        ],
      },
      providers: {
        models: () => ({
          models: [
            {
              id: "gpt-6.1-sol",
              supportedReasoningEfforts: [{ reasoningEffort: "max" }, { reasoningEffort: "ultra" }],
            },
          ],
        }),
      },
      threads: {
        spawn: () => ({
          id: ++spawned === 1 ? "thr_coordinator" : "thr_worker",
          environmentId: "env_coordinator",
        }),
        get: threadState("idle"),
        send: () => ({}),
        stop: () => ({}),
        promptHistory: () => [],
        queuedMessages: { list: () => [] },
        events: { list: (input: EventsListInput) => history.list(input) },
      },
      plugins: {
        callRpc: () => ({
          id: "notice",
          status: "queued",
          duplicate: false,
          durable: true,
          acceptedTargetCount: 1,
        }),
      },
    },
  });

  const runner = new SentryRunner(host.api, connection, transport);
  const batches = new ProjectBatches(runner, connection, transport);
  const first = runner.store.saveRoute(route());

  const ios = runner.store.saveRoute({
    ...route(),
    id: "ios",
    name: "iOS",
    sentryProjectId: "200",
    repositoryPath: "/projects/umbrella/ios",
  });

  runner.store.saveRoute({
    ...route(),
    id: "other",
    projectId: "proj_other",
    sentryProjectId: "300",
  });
  disposers.push(async () => {
    await batches.dispose();
    await runner.dispose();
    await host.harness.lifecycle.dispose();
  });

  return { ...host, runner, batches, first, ios, history };
}

// A just-spawned coordinator is still running its planning turn.
async function launch(f: ReturnType<typeof setup>) {
  f.harness.inspection.sdk.stub("threads.get", threadState("active"));
  await f.batches.reconcile();
  f.harness.inspection.sdk.stub("threads.get", threadState("idle"));
}

function pages(input: string | URL | Request) {
  const url = new URL(String(input));
  const project = url.searchParams.get("project")!;
  const offset = Number(url.searchParams.get("cursor") ?? "0");
  const total = project === "100" ? 205 : 10;
  const length = Math.min(100, total - offset);

  const rows = Array.from({ length }, (_, i) => ({
    ...sentryIssue(String(Number(project) * 100 + offset + i)),
    project: { id: project },
  }));

  const next = offset + length < total;
  url.searchParams.set("cursor", String(offset + length));

  return new Response(JSON.stringify(rows), {
    headers: next ? { link: `<${url}>; rel="next"; results="true"` } : {},
  });
}

it("accepts instantly, coalesces clicks and inventories every issue across the Omnyo project before launching one Ultra coordinator", async () => {
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const f = setup(async (input) => {
    await gate;

    return pages(input);
  });

  const batch = f.batches.start("proj_app");
  expect(batch.state).toBe("preparing");
  expect(f.batches.start("proj_app").id).toBe(batch.id);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  release();
  await launch(f);
  const saved = f.runner.store.getBatch(batch.id);
  expect(saved.incidents).toHaveLength(215);
  expect(new Set(saved.incidents.map((issue) => issue.projectId))).toEqual(new Set(["100", "200"]));
  const calls = f.harness.inspection.sdk.callsTo("threads.spawn");
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toMatchObject({
    projectId: "proj_app",
    model: "gpt-6.1-sol",
    reasoningLevel: "ultra",
    serviceTier: "default",
    environment: { environmentProviderId: "sentry-project" },
  });
  expect(JSON.stringify(calls[0]![0])).toMatch(/use subagents/iu);
  expect(JSON.stringify(calls[0]![0])).toMatch(/group/iu);
  expect(calls[0]![0]).toHaveProperty(
    "prompt",
    expect.stringContaining(
      `Sentry batch ${batch.id}: every inventory issue has a verified repair`,
    ),
  );
  expect(saved.rootPath).toBe("/projects/umbrella");
});

it("groups issues in one isolated worker, deduplicates secondary issues and refuses foreign membership and missing per-issue findings", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  f.runner.store.bindBatchThread(batch.id, "thr_coordinator");
  const saved = f.runner.store.getBatch(batch.id);

  const keys = saved.incidents
    .filter((i) => i.projectId === "100")
    .slice(0, 2)
    .map((i) => i.key);

  expect(() => f.batches.context("thr_forged", "proj_app", 0)).toThrow();

  const run = f.batches.queuePackage("thr_coordinator", "proj_app", {
    routeId: "client",
    issueKeys: keys,
    title: "Related response failure",
    rationale: "Shared response parser; verify both triggers",
  });

  expect(run.relatedIncidents.map((i) => i.key)).toEqual(keys);
  expect(run.model).toEqual({
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "ultra",
    serviceTier: "default",
  });
  expect(
    f.runner.store.enqueue(
      saved.incidents.find((i) => i.key === keys[1])!,
      f.first,
      false,
      true,
    ).id,
  ).toBe(run.id);
  expect(() =>
    f.batches.queuePackage("thr_coordinator", "proj_app", {
      routeId: "client",
      issueKeys: [saved.incidents.find((i) => i.projectId === "200")!.key],
      title: "Wrong repository",
      rationale: "Must refuse",
    }),
  ).toThrow();
  await f.runner.dispatch();
  await expect(
    f.runner.finish(
      "thr_worker",
      "proj_app",
      {
        outcome: "no-fix",
        classification: "Hypothesis",
        summary: "Only primary inspected",
        rootCause: "Missing related evidence",
        change: "",
        commit: null,
        changedFiles: [],
        reproduction: null,
        checks: [],
        limitations: [],
        issueFindings: [],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow();

  const findings = keys.map((key, i) => ({
    key,
    outcome: i === 0 ? ("already-fixed" as const) : ("blocked" as const),
    summary: i === 0 ? "Existing repair verified in base" : "Missing triggering input",
    evidence: i === 0 ? ["docs/proof.md"] : [],
  }));

  const completed = await f.runner.finish(
    "thr_worker",
    "proj_app",
    {
      outcome: "no-fix",
      classification: "Proven by inspection",
      summary: "Existing primary repair; second issue blocked",
      rootCause: "Second issue lacks input",
      change: "",
      commit: null,
      changedFiles: [],
      reproduction: null,
      checks: [],
      limitations: ["Second issue remains open"],
      issueFindings: findings,
    },
    new AbortController().signal,
  );

  expect(completed.result?.issueFindings?.[1]?.outcome).toBe("blocked");
});

it("requires full accounting and resumes the same coordinator after missed worker events without repeating an accepted summary", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  f.runner.store.bindBatchThread(batch.id, "thr_coordinator");
  const saved = f.runner.store.getBatch(batch.id);
  await expect(
    f.batches.finish("thr_coordinator", "proj_app", { summary: "All fixed", blocked: [] }),
  ).rejects.toThrow();
  const key = saved.incidents[0]!.key;

  const run = f.batches.queuePackage("thr_coordinator", "proj_app", {
    routeId: "client",
    issueKeys: [key],
    title: "One package",
    rationale: "Exact shared cause",
  });

  const blocked = saved.incidents
    .slice(1)
    .map((i) => ({ issueKey: i.key, reason: "Need affected-release evidence" }));

  expect(
    (
      await f.batches.finish("thr_coordinator", "proj_app", {
        summary: "One package queued; remaining need evidence",
        blocked,
      })
    ).state,
  ).toBe("waiting");
  await f.runner.dispatch();
  f.runner.store.updateRun(run.id, { state: "needs-evidence" });
  f.runner.store.release(run.id);
  await f.batches.reconcile();
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  const summary = f.runner.store.getBatch(batch.id);
  expect(summary.state).toBe("summarizing");
  const sent = f.harness.inspection.sdk.callsTo("threads.send")[0]![0];
  f.harness.inspection.sdk.stub("threads.promptHistory", () => [
    { id: "msg_summary", text: JSON.stringify(sent) },
  ]);
  await f.batches.reconcile();
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  await expect(
    f.batches.finish("thr_coordinator", "proj_app", {
      summary: "Other issues blocked",
      blocked,
    }),
  ).rejects.toThrow(/blocked/i);
  expect(f.runner.store.getBatch(batch.id)).toMatchObject({
    state: "planning",
    blocked: expect.arrayContaining([{ issueKey: key, reason: expect.any(String) }]),
  });
  f.history.completedTurn("thr_coordinator");
  await f.batches.idle("thr_coordinator");
  expect(f.runner.store.getBatch(batch.id).state).toBe("planning");
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
});

it("recovers a summary intent before send and preserves uncertain accepted sends without replacement launches", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  f.runner.store.bindBatchThread(batch.id, "thr_coordinator");

  const all = f.runner.store
    .getBatch(batch.id)
    .incidents.map((i) => ({ issueKey: i.key, reason: "Need evidence" }));

  f.runner.store.updateBatch(batch.id, { state: "waiting", blocked: all });
  f.harness.inspection.sdk.stub("threads.send", () => {
    throw new Error("lost accepted response");
  });
  await f.batches.reconcile();
  expect(f.runner.store.getBatch(batch.id).state).toBe("summarizing");
  await f.batches.reconcile();
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  expect(f.runner.store.getBatch(batch.id).reason).toMatch(/uncertain/iu);
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
});

it("never launches on a partial or failed scan and keeps manual defaults and unrelated projects untouched", async () => {
  const f = setup(async () => new Response("", { status: 429 }));
  const batch = f.batches.start("proj_app");
  await f.batches.reconcile();
  expect(f.runner.store.getBatch(batch.id)).toMatchObject({
    state: "failed",
    reason: expect.any(String),
  });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  expect(f.runner.store.policy("proj_app").autoSolve).toBe(false);
  expect(f.runner.store.listRuns()).toHaveLength(0);
});

it("projects the paginated Sentry catalog without raw keys and rejects unsafe pagination", async () => {
  let calls = 0;

  const client = new SentryClient("https://de.sentry.io", "fixture-non-secret", async (input) => {
    calls++;
    const url = new URL(String(input));

    return new Response(
      JSON.stringify([
        {
          id: String(calls),
          slug: calls === 1 ? "ios" : "landing",
          name: calls === 1 ? "iOS" : "Landing",
          dsn: "PRIVATE_DSN_SENTINEL",
        },
      ]),
      {
        headers:
          calls === 1
            ? { link: `<${url.origin}${url.pathname}?cursor=next>; rel="next"; results="true"` }
            : {},
      },
    );
  });

  expect(await client.projects("acme")).toEqual([
    { id: "1", slug: "ios", name: "iOS" },
    { id: "2", slug: "landing", name: "Landing" },
  ]);

  const unsafe = new SentryClient(
    "https://de.sentry.io",
    "fixture-non-secret",
    async () =>
      new Response("[]", {
        headers: { link: '<https://evil.invalid/?cursor=next>; rel="next"; results="true"' },
      }),
  );

  await expect(unsafe.projects("acme")).rejects.toThrow();
});

it("grants no project coordinator tools from forged display metadata or a wrong project", async () => {
  const host = createFakePluginHost({ pluginId: "sentry", agentSkillIds: ["sentry"] });
  disposers.push(() => host.harness.lifecycle.dispose());
  await createSentryPlugin()(host.api);

  const config = await host.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({ pluginMetadata: { batchId: "batch_forged" } }),
  );

  expect(config?.tools ?? []).toEqual([]);
  await expect(
    host.harness.behavior.callAgentTool(
      "sentry_project_context",
      { offset: 0 },
      { threadId: "thr_forged", projectId: "proj_app" },
    ),
  ).rejects.toThrow();
  expect(new SentryStore(host.api.storage).listBatches()).toHaveLength(0);
});

it("delivers the complete immutable package handoff on initial launch and retained-owner retry", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  const saved = f.runner.store.getBatch(batch.id);
  const rationale = "Shared evidence and repair contract. ".repeat(35) + "FINAL_HANDOFF_SENTINEL";

  const run = f.batches.queuePackage("thr_coordinator", "proj_app", {
    routeId: "client",
    issueKeys: [saved.incidents[0]!.key],
    title: "Preserve full diagnostic instructions",
    rationale,
  });

  await f.runner.dispatch();
  expect(f.runner.store.getRun(run.id).packageHandoff).toBe(rationale);
  expect(JSON.stringify(f.harness.inspection.sdk.callsTo("threads.spawn")[1]![0])).toContain(
    rationale,
  );
  f.runner.store.updateRun(run.id, {
    state: "needs-evidence",
    reason: "Preliminary evidence only",
  });
  f.runner.store.release(run.id);
  await f.runner.retry(run.id);
  expect(JSON.stringify(f.harness.inspection.sdk.callsTo("threads.send").at(-1))).toContain(
    rationale,
  );
  expect(f.runner.store.getRun(run.id).packageHandoff).toBe(rationale);
  expect(() => f.runner.store.updateRun(run.id, { packageHandoff: "replacement scope" })).toThrow();
  expect(f.runner.store.getRun(run.id).threadId).toBe("thr_worker");
});

it("projects native waits before worker chats exist and clears settled or cancelled waits", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  const saved = f.runner.store.getBatch(batch.id);
  const run = f.runner.store.enqueue(saved.incidents[0]!, f.first, true, true);
  f.runner.store.updateRun(run.id, { batchId: batch.id });
  f.runner.store.updateBatch(batch.id, { state: "waiting", runIds: [run.id] });
  const status = () => f.batches.callbackStatus();
  expect(status()).toEqual({
    coordinators: [
      {
        threadId: "thr_coordinator",
        batchId: batch.id,
        state: "queued",
        packageCount: 1,
        queued: 1,
        running: 0,
        reason: null,
      },
    ],
  });
  f.runner.store.updateRun(run.id, {
    reason: "Route changed; owner must review this queued target",
  });
  expect(status().coordinators[0]).toMatchObject({
    state: "blocked",
    reason: "Route changed; owner must review this queued target",
  });
  f.runner.store.updateRun(run.id, { reason: null });
  f.runner.store.claimNext();
  expect(status().coordinators[0]).toMatchObject({ state: "running", queued: 0, running: 1 });
  f.runner.store.updateRun(run.id, { reason: "Dispatch outcome needs reconciliation" });
  expect(status().coordinators[0]).toMatchObject({
    state: "blocked",
    reason: "Dispatch outcome needs reconciliation",
  });
  f.runner.store.updateRun(run.id, { state: "needs-evidence", reason: "Need owner evidence" });
  f.runner.store.release(run.id);
  expect(status().coordinators[0]).toMatchObject({
    state: "blocked",
    running: 0,
    reason: "Need owner evidence",
  });
  f.runner.store.updateBatch(batch.id, { state: "complete" });
  expect(status()).toEqual({ coordinators: [] });
  f.runner.store.updateBatch(batch.id, { state: "cancelled" });
  expect(status()).toEqual({ coordinators: [] });
});

const coordinatorInterrupted = "Coordinator interrupted. Open it to continue, or use Resume.";

it("dispatches work on an unchanged route when another route drifts", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  const { incidents } = f.runner.store.getBatch(batch.id);
  f.runner.store.saveRoute({ ...f.ios, enabled: false });

  const queue = (routeId: string) =>
    f.batches.queuePackage("thr_coordinator", "proj_app", {
      routeId,
      issueKeys: [incidents.find((issue) => issue.matchedRouteIds.includes(routeId))!.key],
      title: "Investigate the known failure",
      rationale: "Run the incident-specific regression",
    });

  expect(() => queue("ios")).toThrow(/ios/i);
  expect(queue("client")).toMatchObject({ route: { id: "client" }, batchId: batch.id });
  await f.runner.dispatch();
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(2);
});

// A launched project solve with the real plugin event handlers loaded on the same host.
async function solving() {
  const transport: typeof fetch = async (input) => pages(input);
  const f = setup(transport);
  await createSentryPlugin(transport)(f.api);
  const batchId = f.batches.start("proj_app").id;
  await launch(f);

  const idle = async (threadId: string) => {
    await f.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: threadId }),
      lastAssistantText: null,
    });
    await settle();
  };

  const active = async (threadId: string) => {
    await f.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: threadId, status: "active" }),
    });
    await settle();
  };

  // The coordinator queues one package, blocks the rest and waits for the worker it claimed.
  const queueOne = async () => {
    const [first, ...rest] = f.runner.store.getBatch(batchId).incidents;

    const run = f.batches.queuePackage("thr_coordinator", "proj_app", {
      routeId: "client",
      issueKeys: [first!.key],
      title: "One package",
      rationale: "Exact shared cause",
    });

    await f.batches.finish("thr_coordinator", "proj_app", {
      summary: "One package queued; remaining need evidence",
      blocked: rest.map((issue) => ({ issueKey: issue.key, reason: "Need release evidence" })),
    });
    await f.runner.dispatch();

    return run;
  };

  const sends = () => f.harness.inspection.sdk.callsTo("threads.send");

  const coordinators = async () =>
    callbackStatusSchema.parse(await f.harness.behavior.callRpc("callback.status", null))
      .coordinators;

  return { ...f, batchId, idle, active, queueOne, sends, coordinators };
}

function blockedReport(key: string) {
  return {
    outcome: "needs-evidence",
    classification: "Hypothesis",
    summary: "Package needs the affected release",
    rootCause: "Triggering input is unavailable",
    change: "",
    commit: null,
    changedFiles: [],
    reproduction: null,
    checks: [],
    limitations: ["Issue remains open"],
    issueFindings: [{ key, outcome: "blocked", summary: "Missing triggering input", evidence: [] }],
  };
}

it("queues follow-up work after a callback and delivers a fresh callback when that work ends", async () => {
  const f = await solving();
  const first = await f.queueOne();

  const finishWorker = async (threadId: string, key: string) => {
    await f.harness.behavior.callAgentTool("sentry_finish_run", blockedReport(key), {
      threadId,
      projectId: "proj_app",
    });
    f.history.completedTurn(threadId);
    await f.idle(threadId);
  };

  await finishWorker("thr_worker", first.incident.key);
  const previous = f.runner.store.getBatch(f.batchId);
  expect(previous.state).toBe("summarizing");
  const priorCallback = f.sends()[0]![0];
  f.harness.inspection.sdk.stub("threads.promptHistory", () => [
    { id: "msg_first_callback", text: JSON.stringify(priorCallback) },
  ]);
  f.harness.inspection.sdk.stub("threads.spawn", () => ({
    id: "thr_second_worker",
    environmentId: "env_second_worker",
  }));

  const nextIssue = previous.incidents.find(
    (issue) => issue.key !== first.incident.key && issue.matchedRouteIds.includes("client"),
  )!;

  const second = f.batches.queuePackage("thr_coordinator", "proj_app", {
    routeId: "client",
    issueKeys: [nextIssue.key],
    title: "Follow-up repair",
    rationale: "Independent evidence arrived in the first worker result",
  });

  await f.runner.dispatch();
  f.history.completedTurn("thr_coordinator");
  await f.idle("thr_coordinator");
  expect(f.runner.store.getBatch(f.batchId).state).toBe("waiting");

  await finishWorker("thr_second_worker", second.incident.key);
  const followUp = f.runner.store.getBatch(f.batchId);
  expect(followUp).toMatchObject({ state: "summarizing", runIds: [first.id, second.id] });
  expect(followUp.summaryMarker).not.toBe(previous.summaryMarker);
  expect(f.sends()).toHaveLength(2);
  expect(f.sends()[1]![0]).toMatchObject({ threadId: "thr_coordinator" });
  expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(3);
});

it("resumes the coordinator when a queued package can no longer start on its captured route", async () => {
  const f = setup(async (input) => pages(input));
  const batch = f.batches.start("proj_app");
  await launch(f);
  const { incidents } = f.runner.store.getBatch(batch.id);
  const [firstIssue, secondIssue] = incidents;

  const queue = (key: string) =>
    f.batches.queuePackage("thr_coordinator", "proj_app", {
      routeId: "client",
      issueKeys: [key],
      title: "Package",
      rationale: "Independent failure",
    });

  const first = queue(firstIssue!.key);
  const second = queue(secondIssue!.key);

  await f.runner.dispatch();
  const blocked = incidents.slice(2).map(({ key }) => ({ issueKey: key, reason: "Need evidence" }));
  await f.batches.finish("thr_coordinator", "proj_app", { summary: "Workers pending", blocked });

  f.runner.store.saveRoute({ ...f.first, enabled: false });
  f.runner.store.updateRun(first.id, { state: "needs-evidence" });
  f.runner.store.release(first.id);
  await f.runner.dispatch();
  await f.batches.progress();

  expect(f.runner.store.getRun(second.id)).toMatchObject({ state: "queued", threadId: null });
  expect(f.runner.store.getBatch(batch.id).state).toBe("summarizing");
  expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
  await expect(
    f.batches.finish("thr_coordinator", "proj_app", { summary: "Work remains blocked", blocked }),
  ).rejects.toThrow(/blocked/i);
  expect(f.runner.store.getBatch(batch.id).state).toBe("planning");
});

it("pauses a stopped planning coordinator without a reminder or failure until its chat continues", async () => {
  const f = await solving();

  f.history.stoppedTurn("thr_coordinator");
  await f.idle("thr_coordinator");
  f.history.stoppedTurn("thr_coordinator");
  await f.idle("thr_coordinator");

  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "planning",
    reason: coordinatorInterrupted,
    reportRequests: 0,
  });
  expect(f.sends()).toHaveLength(0);

  await f.active("thr_coordinator");
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({ state: "planning", reason: null });
});

it("holds the project summary while the coordinator's last turn is interrupted and lets Resume send one prompt", async () => {
  const f = await solving();
  const run = await f.queueOne();

  // The coordinator is stopped while a maintenance hold drops its idle event.
  f.history.stoppedTurn("thr_coordinator");
  await f.harness.behavior.callAgentTool("sentry_finish_run", blockedReport(run.incident.key), {
    threadId: "thr_worker",
    projectId: "proj_app",
  });
  f.history.completedTurn("thr_worker");
  await f.idle("thr_worker");
  await f.harness.behavior.callRpc("queue.reconcile", null);

  expect(f.runner.store.hasClaim(run.id)).toBe(false);
  expect(f.sends()).toHaveLength(0);
  const held = f.runner.store.getBatch(f.batchId);
  expect(["waiting", "summarizing"]).toContain(held.state);
  expect(held).toMatchObject({ summarySentAt: null, reason: coordinatorInterrupted });

  await f.harness.behavior.callRpc("batches.resume", { id: f.batchId });
  expect(f.sends()).toHaveLength(1);
  expect(f.sends()[0]![0]).toMatchObject({ threadId: "thr_coordinator" });
});

it("keeps a coordinator stopped during its summary turn resumable without failing the batch", async () => {
  const f = await solving();
  const run = await f.queueOne();

  await f.harness.behavior.callAgentTool("sentry_finish_run", blockedReport(run.incident.key), {
    threadId: "thr_worker",
    projectId: "proj_app",
  });
  f.history.completedTurn("thr_worker");
  await f.idle("thr_worker");
  expect(f.sends()).toHaveLength(1);

  // The summary prompt was delivered, then its turn was stopped.
  const sent = f.sends()[0]![0];

  f.harness.inspection.sdk.stub("threads.promptHistory", () => [
    { id: "msg_summary", text: JSON.stringify(sent) },
  ]);
  f.history.stoppedTurn("thr_coordinator");
  await f.idle("thr_coordinator");

  expect(f.sends()).toHaveLength(1);
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "summarizing",
    reason: coordinatorInterrupted,
  });
});

it("catches up a planning coordinator's dropped idle event once across repeated reconciles", async () => {
  const f = await solving();

  // The planning turn completes while a maintenance hold drops its idle event.
  f.history.completedTurn("thr_coordinator");
  await f.batches.reconcile();
  await f.batches.reconcile();

  expect(f.sends()).toHaveLength(1);
  expect(f.sends()[0]![0]).toMatchObject({ threadId: "thr_coordinator" });
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "planning",
    reportRequests: 1,
  });
});

it("reports an interrupted package as blocked by issue until its chat continues", async () => {
  const f = await solving();
  await f.queueOne();

  f.history.stoppedTurn("thr_worker");
  await f.idle("thr_worker");
  expect(await f.coordinators()).toEqual([
    expect.objectContaining({
      threadId: "thr_coordinator",
      state: "blocked",
      reason: "CLIENT-10000 package interrupted. Open its chat to continue, or stop it.",
    }),
  ]);

  await f.active("thr_worker");
  expect(await f.coordinators()).toEqual([
    expect.objectContaining({ state: "running", running: 1, reason: null }),
  ]);
});

it.each([0, 1])(
  "keeps a project-solve Stop that lands while the coordinator history is read (%i reminders)",
  async (reminders) => {
    const f = await solving();

    if (reminders) {
      await f.idle("thr_coordinator");
      f.history.completedTurn("thr_coordinator");
    }

    let stopped = false;

    f.harness.inspection.sdk.stub("threads.events.list", async (input: EventsListInput) => {
      if (!stopped) {
        stopped = true;
        await f.harness.behavior.callRpc("batches.stop", { id: f.batchId });
      }

      return f.history.list(input);
    });
    await f.idle("thr_coordinator");

    expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
      state: "cancelled",
      reason: "Stopped; existing source, branches and evidence are preserved",
      reportRequests: reminders,
    });
    expect(f.sends()).toHaveLength(reminders);
  },
);

it("sends one coordinator reminder when its idle event overlaps a reconcile catch-up", async () => {
  const f = await solving();

  await Promise.all([f.batches.reconcile(), f.batches.idle("thr_coordinator")]);
  expect(f.sends()).toHaveLength(1);
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "planning",
    reportRequests: 1,
  });
});

it.each([
  [
    "read",
    "threads.get",
    "Coordinator state is unavailable; its packages and evidence are preserved.",
    1,
  ],
  [
    "reminded",
    "threads.send",
    "The project-plan reminder could not be sent; the coordinator and its packages are preserved.",
    2,
  ],
] as const)(
  "keeps reconcile running and shows why when a coordinator cannot be %s",
  async (_label, path, reason, sends) => {
    const f = await solving();

    f.harness.inspection.sdk.stub(path, () => {
      throw new Error("Refused during a maintenance hold");
    });
    await expect(f.harness.behavior.callRpc("queue.reconcile", null)).resolves.toEqual({
      reconciled: true,
    });
    expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
      state: "planning",
      reason,
      reportRequests: 0,
      lastTurnSeq: null,
    });

    // The next reconcile reads the coordinator again and reminds it once.
    f.harness.inspection.sdk.stub("threads.get", threadState("idle"));
    f.harness.inspection.sdk.stub("threads.send", () => ({}));
    await f.harness.behavior.callRpc("queue.reconcile", null);
    await f.harness.behavior.callRpc("queue.reconcile", null);
    expect(f.sends()).toHaveLength(sends);
    expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
      state: "planning",
      reportRequests: 1,
    });
  },
);

it("acts only on coordinator turns that complete after its Resume prompt", async () => {
  const f = await solving();

  // The planning turn and the reminder's own turn both end without a plan.
  await f.idle("thr_coordinator");
  f.history.completedTurn("thr_coordinator");
  await f.idle("thr_coordinator");
  expect(f.runner.store.getBatch(f.batchId).state).toBe("failed");

  // The owner continues the failed coordinator's chat, then presses Resume.
  f.history.completedTurn("thr_coordinator");
  await f.idle("thr_coordinator");
  await f.harness.behavior.callRpc("batches.resume", { id: f.batchId });
  expect(f.sends()).toHaveLength(2);

  // Catch-up runs before the Resume prompt's own turn is recorded.
  await f.batches.reconcile();
  await f.batches.reconcile();
  expect(f.sends()).toHaveLength(2);
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "planning",
    reportRequests: 0,
  });
});

it("clears the coordinator's unavailable reason once its chat can be read again", async () => {
  const f = await solving();
  await f.idle("thr_coordinator");
  expect(f.sends()).toHaveLength(1);

  f.harness.inspection.sdk.stub("threads.get", () => {
    throw new Error("Refused during a maintenance hold");
  });
  await f.batches.reconcile();
  expect(f.runner.store.getBatch(f.batchId).reason).toBe(
    "Coordinator state is unavailable; its packages and evidence are preserved.",
  );

  f.harness.inspection.sdk.stub("threads.get", threadState("idle"));
  await f.batches.reconcile();
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "planning",
    reportRequests: 1,
    reason: null,
  });
  expect(f.sends()).toHaveLength(1);
});

const coordinatorDeletedReason =
  "Its coordinator chat was deleted, so this project investigation ended. Its packages, branches and evidence are preserved.";

function deletedChat(): never {
  throw Object.assign(new Error("HTTP 404: Thread not found"), {
    status: 404,
    code: "thread_not_found",
  });
}

it("ends a planning project investigation whose coordinator chat was deleted", async () => {
  const f = await solving();

  f.harness.inspection.sdk.stub("threads.get", deletedChat);
  await f.batches.reconcile();
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "failed",
    reason: coordinatorDeletedReason,
  });
  expect(f.sends()).toHaveLength(0);
});

it("ends a waiting project investigation once its packages stop and its coordinator chat is gone", async () => {
  const f = await solving();
  const run = await f.queueOne();

  expect(f.runner.store.getBatch(f.batchId).state).toBe("waiting");
  f.runner.store.updateRun(run.id, { state: "no-fix" });
  f.runner.store.release(run.id);
  f.harness.inspection.sdk.stub("threads.get", deletedChat);
  await f.batches.progress();
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "failed",
    reason: coordinatorDeletedReason,
  });
  expect(f.sends()).toHaveLength(0);
});

it("stops a project investigation whose coordinator chat was deleted", async () => {
  const f = await solving();

  f.harness.inspection.sdk.stub("threads.stop", deletedChat);
  await f.batches.stop(f.batchId);
  expect(f.runner.store.getBatch(f.batchId)).toMatchObject({
    state: "cancelled",
    reason: "Stopped; existing source, branches and evidence are preserved",
  });
});

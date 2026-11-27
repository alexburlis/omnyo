import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import {
  batchSchema,
  completionSchema,
  hostContract,
  routeSchema,
  runSchema,
  type Completion,
  type Incident,
  type ProjectBatch,
  type Route,
  type Run,
} from "../contract";
import { createSentryPlugin } from "../server";
import { SentryRunner } from "../src/runner";
import { incident, projects, route } from "./fixtures";
import { TurnHistory, settle } from "./turn-events";

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const owner = { threadId: "thr_owned", projectId: "proj_app" };

const baseSha = "e".repeat(40);

const repairCommit = "4f1c9e2d" + "b".repeat(32);

const reportCommit = "785a506b" + "c".repeat(32);

const oldFailure =
  "Worker stopped without a valid completion; inspect this existing chat before retrying";

const revokedSuffix =
  " Nothing was recorded; your evidence stays in this chat. Tell the user instead of resubmitting.";

const publishUncertain =
  "A draft PR may already exist for this run, so this report was not recorded. Resubmit the fix-ready completion to reconcile it; if this run no longer holds the execution slot, ask the user to press Retry first. Otherwise ask the user to stop this run.";

const connection = async () => ({ apiOrigin: "https://de.sentry.io" });

function escaped(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function exactly(text: string) {
  return new RegExp("^" + escaped(text) + "$", "u");
}

function revoked(reason: string) {
  return new RegExp("^" + escaped(reason) + "[\\s\\S]*" + escaped(revokedSuffix) + "$", "u");
}

function slotNeeded(commit: string) {
  return exactly(
    "Verification needs the execution slot. Ask the user to press Retry on this run in the Sentry panel; it resumes this chat when the slot is free. Nothing was recorded; commit " +
      commit.slice(0, 8) +
      " stays in this worktree.",
  );
}

async function answerHost(call: ExperimentalFakeHostRpcCall) {
  if (call.method === "verify") {
    const input = hostContract.verify.input.parse(call.input);

    return {
      head: input.head,
      tree: "d".repeat(40),
      changedFiles: input.changedFiles,
      checks: input.checks.map((check) => ({
        name: check.name,
        exitCode: 0,
        durationMs: 1,
        output: "",
      })),
    };
  }

  if (call.method === "publish") {
    const input = hostContract.publish.input.parse(call.input);

    return {
      url: "https://github.com/fixture/example/pull/7",
      number: 7,
      head: input.head,
      branch: input.branch,
      baseBranch: input.baseBranch,
      draft: true,
    };
  }

  if (call.method === "stop") return { stopped: true };

  throw new Error("Unexpected host RPC: " + call.method);
}

// A publish whose response is lost once, as when the host connection drops mid-call.
// `reached` receives the run ID when that first publish arrives at the host.
function losingFirstPublish(reached?: (runId: string) => void) {
  let publishes = 0;

  return (call: ExperimentalFakeHostRpcCall) => {
    if (call.method !== "publish" || ++publishes > 1) return answerHost(call);
    reached?.(hostContract.publish.input.parse(call.input).runId);

    return Promise.reject(new Error("Host connection closed before the publish response"));
  };
}

function prRoute() {
  return routeSchema.parse({ ...route(), delivery: "pr", githubRepository: "fixture/example" });
}

async function setup(answer: typeof answerHost = answerHost, configured: Route = route()) {
  const history = new TurnHistory();
  let spawned = 0;

  const host = createFakePluginHost({
    pluginId: "sentry",
    experimental_callHostRpc: answer,
    sdk: {
      projects,
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
      hosts: { list: () => [makeHostResponse({ id: "host_mac" })] },
      threads: {
        spawn: () => {
          spawned++;

          return {
            id: spawned === 1 ? "thr_owned" : "thr_worker_" + spawned,
            environmentId: "env_" + spawned,
          };
        },
        get: (input) => makeThreadResponse({ id: input.threadId, projectId: "proj_app" }),
        send: () => ({}),
        stop: () => ({}),
        events: { list: (input) => history.list(input) },
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

  disposers.push(() => host.harness.lifecycle.dispose());
  await createSentryPlugin()(host.api);
  const runner = new SentryRunner(host.api, connection);
  runner.store.saveRoute(configured);

  return { ...host, runner, history };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

function saveBatch(
  runner: SentryRunner,
  id: string,
  state: ProjectBatch["state"],
  incidents: Incident[],
) {
  return runner.store.saveBatch(
    batchSchema.parse({
      id,
      projectId: "proj_app",
      hostId: "host_mac",
      sourceId: null,
      rootPath: "/projects/umbrella",
      routes: [runner.store.getRoute("client")],
      incidents,
      state,
      threadId: "thr_coordinator",
      spawnRequestedAt: "2026-10-19T05:25:00Z",
      summaryMarker: null,
      summarySentAt: null,
      runIds: [],
      blocked: [],
      summary: null,
      reason: null,
      reportRequests: 0,
      createdAt: "2026-10-19T05:25:00Z",
      updatedAt: "2026-10-19T05:25:00Z",
    }),
  );
}

function queue(
  fixture: Fixture,
  issue: Incident,
  batchId: string | null = null,
  related: Incident[] = [issue],
) {
  const { runner } = fixture;
  const queued = runner.store.enqueue(issue, runner.store.getRoute("client"), false, true);

  if (!batchId) return queued;

  runner.store.updateBatch(batchId, {
    runIds: [...runner.store.getBatch(batchId).runIds, queued.id],
  });

  return runner.store.updateRun(queued.id, {
    batchId,
    relatedIncidents: related,
    packageTitle: issue.shortId + " package",
    reasoningLevel: "ultra",
    packageHandoff: "Prove the shared cause before any repair.",
  });
}

// Claims the slot, spawns the worker chat and records the worktree its environment would create.
async function launch(
  fixture: Fixture,
  issue = incident(),
  batchId: string | null = null,
  related: Incident[] = [issue],
) {
  const queued = queue(fixture, issue, batchId, related);
  await fixture.runner.dispatch();

  return fixture.runner.store.updateRun(queued.id, {
    worktreePath: "/worktrees/" + queued.id,
    baseSha,
    branch: "sentry/" + queued.id,
  });
}

function blocked(keys: string[]) {
  return keys.map((key) => ({
    key,
    outcome: "blocked" as const,
    summary: "Needs the affected-release evidence",
    evidence: [],
  }));
}

function report(keys: string[] = []) {
  return completionSchema.parse({
    outcome: "needs-evidence",
    classification: "Proven by inspection",
    summary: "The crash needs affected-release evidence before a repair",
    rootCause: "The failing frame is identified; its trigger is not",
    issueFindings: keys.length ? blocked(keys) : undefined,
  });
}

function repair(keys: string[] = []) {
  return completionSchema.parse({
    outcome: "fix-ready",
    classification: "Reproduced",
    summary: "Guard the released session before teardown",
    rootCause: "Teardown reads a released session",
    change: "Return early when the session is gone",
    commit: repairCommit,
    changedFiles: ["src/session.ts"],
    reproduction: {
      command: "pnpm test session",
      before: "Teardown crashed",
      after: "Teardown passes",
      evidence: ["proof/session.log"],
    },
    issueFindings: keys.length ? blocked(keys) : undefined,
  });
}

// The submission the 2026-10-19 worker could not record.
function packageReport() {
  return completionSchema.parse({
    outcome: "needs-evidence",
    classification: "Hypothesis",
    summary: "Both package crashes need affected-release symbols before a repair can be proven",
    rootCause: "Hypothesis: teardown races a released playback session",
    change: "No source change; the report commit records the investigation",
    commit: reportCommit,
    limitations: ["No PR, push or Sentry change was made"],
    issueFindings: [
      {
        key: "acme:101",
        outcome: "blocked",
        summary: "Needs the affected-release symbols",
        evidence: [],
      },
      {
        key: "acme:102",
        outcome: "blocked",
        summary: "Needs a device log from the affected release",
        evidence: [],
      },
    ],
  });
}

function recorded(response: string) {
  return runSchema.parse(JSON.parse(z.string().parse(response)));
}

function hostMethods(fixture: Fixture) {
  return fixture.harness.inspection.experimental_hostRpcCalls.map((call) => call.method);
}

async function expectRefusal(
  fixture: Fixture,
  runId: string,
  proposal: Completion,
  refusal: RegExp,
) {
  const { runner, harness } = fixture;
  const before = runner.store.getRun(runId);
  const claimed = runner.store.hasClaim(runId);
  const hostCalls = harness.inspection.experimental_hostRpcCalls.length;

  await expect(
    harness.behavior.callAgentTool("sentry_finish_run", proposal, owner),
  ).rejects.toThrow(refusal);
  expect(runner.store.getRun(runId)).toEqual(before);
  expect(runner.store.hasClaim(runId)).toBe(claimed);
  expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(hostCalls);
}

// Retry on a revoked run starts nothing: no slot, no continue prompt, no host call.
async function expectRetryRefusal(fixture: Fixture, runId: string, refusal: RegExp) {
  const { runner, harness } = fixture;
  const before = runner.store.getRun(runId);
  const sends = harness.inspection.sdk.callsTo("threads.send").length;
  const hostCalls = harness.inspection.experimental_hostRpcCalls.length;

  await expect(harness.behavior.callRpc("runs.retry", { id: runId })).rejects.toThrow(refusal);
  expect(runner.store.getRun(runId)).toEqual(before);
  expect(runner.store.claimedRuns()).toEqual([]);
  expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(sends);
  expect(harness.inspection.experimental_hostRpcCalls).toHaveLength(hostCalls);
}

async function idleAfterCompletedTurn(fixture: Fixture) {
  fixture.history.completedTurn("thr_owned");
  await fixture.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_owned", projectId: "proj_app" }),
    lastAssistantText: null,
  });
  await settle();
}

async function resumeChat(fixture: Fixture) {
  await fixture.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ id: "thr_owned", projectId: "proj_app", status: "active" }),
  });
}

// The planning coordinator packages these issues again; the new package takes the free slot.
async function queueSuccessor(fixture: Fixture, issueKeys: string[]) {
  const response = await fixture.harness.behavior.callAgentTool(
    "sentry_queue_package",
    {
      routeId: "client",
      issueKeys,
      title: "Client teardown crash",
      rationale: "Same crash; repeat the investigation with current evidence",
    },
    { threadId: "thr_coordinator", projectId: "proj_app" },
  );

  const successor = recorded(z.string().parse(response));
  await settle();
  expect(fixture.runner.store.hasClaim(successor.id)).toBe(true);

  return successor;
}

describe("submission authority", () => {
  it("records the incident package report from a chat the old runtime marked failed (R2)", async () => {
    const fixture = await setup();
    const { runner } = fixture;
    const members = [incident(), incident("102")];

    const waiting = saveBatch(runner, "batch_package", "waiting", [
      ...members,
      incident("103"),
      incident("104"),
    ]);

    const reporter = await launch(fixture, incident(), waiting.id, members);
    runner.store.updateRun(reporter.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(reporter.id);
    const holder = await launch(fixture, incident("103"), waiting.id);
    const queued = queue(fixture, incident("104"), waiting.id);
    const holderBefore = runner.store.getRun(holder.id);
    const queuedBefore = runner.store.getRun(queued.id);
    const batchBefore = runner.store.getBatch(waiting.id);
    let reloaded!: SentryRunner;

    const replacement = await fixture.harness.lifecycle.reload(async (api) => {
      await createSentryPlugin()(api);
      reloaded = new SentryRunner(api, connection);
    });

    disposers.push(() => replacement.harness.lifecycle.dispose());
    const reloadedHarness = replacement.harness;
    const payload = packageReport();

    const response = recorded(
      z
        .string()
        .parse(await reloadedHarness.behavior.callAgentTool("sentry_finish_run", payload, owner)),
    );

    expect(response).toMatchObject({
      id: reporter.id,
      threadId: "thr_owned",
      state: "needs-evidence",
      result: payload,
      reason: payload.summary,
    });
    expect(reloaded.store.getRun(reporter.id)).toEqual(response);
    expect(reloaded.store.hasClaim(reporter.id)).toBe(false);
    expect(reloaded.store.hasClaim(holder.id)).toBe(true);
    expect(reloaded.store.getRun(holder.id)).toEqual(holderBefore);
    expect(reloaded.store.getRun(queued.id)).toEqual(queuedBefore);
    expect(reloaded.store.getBatch(waiting.id)).toEqual(batchBefore);
    expect(await reloadedHarness.behavior.callRpc("callback.status", null)).toEqual({
      coordinators: [
        {
          threadId: "thr_coordinator",
          batchId: waiting.id,
          state: "blocked",
          packageCount: 3,
          queued: 1,
          running: 1,
          reason: payload.summary,
        },
      ],
    });
    expect(reloadedHarness.inspection.experimental_hostRpcCalls).toHaveLength(0);

    for (const path of ["threads.spawn", "threads.send", "threads.stop"])
      expect(reloadedHarness.inspection.sdk.callsTo(path)).toHaveLength(0);
  });

  it("refuses a released fix-ready until Retry takes the free slot, then verifies it once (R4)", async () => {
    const fixture = await setup();
    const { runner, harness } = fixture;
    const released = await launch(fixture);
    runner.store.updateRun(released.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(released.id);
    const holder = await launch(fixture, incident("102"));

    await expectRefusal(fixture, released.id, repair(), slotNeeded(repairCommit));
    expect(runner.store.hasClaim(holder.id)).toBe(true);

    const refused = runner.store.getRun(released.id);

    await expect(harness.behavior.callRpc("runs.retry", { id: released.id })).rejects.toThrow(
      exactly(
        "Another investigation (CLIENT-102) is using the execution slot. Retry after it finishes.",
      ),
    );
    expect(runner.store.getRun(released.id)).toEqual(refused);
    expect(runner.store.hasClaim(holder.id)).toBe(true);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);

    runner.store.updateRun(holder.id, { state: "needs-evidence", result: report() });
    runner.store.release(holder.id);
    await harness.behavior.callRpc("runs.retry", { id: released.id });
    expect(runner.store.hasClaim(released.id)).toBe(true);
    expect(runner.store.getRun(released.id)).toMatchObject({ reportRequests: 0 });
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);

    const response = z
      .string()
      .parse(await harness.behavior.callAgentTool("sentry_finish_run", repair(), owner));

    expect(recorded(response)).toMatchObject({
      id: released.id,
      state: "local-ready",
      verification: { head: repairCommit },
    });
    expect(hostMethods(fixture)).toEqual(["verify"]);
  });

  it("refuses report-only and fix-ready submissions from a run its owner stopped (G1)", async () => {
    const fixture = await setup();
    const run = await launch(fixture);
    await fixture.harness.behavior.callRpc("runs.stop", { id: run.id });

    for (const proposal of [report(), repair()])
      await expectRefusal(
        fixture,
        run.id,
        proposal,
        revoked("This Sentry run was stopped by its owner."),
      );
  });

  it("keeps a run cancelled when its owner stops it during fix-ready verification (G1)", async () => {
    let failVerification!: (cause: Error) => void;

    const fixture = await setup((call) =>
      call.method === "verify"
        ? new Promise<never>((_resolve, reject) => {
            failVerification = reject;
          })
        : answerHost(call),
    );

    const { runner, harness } = fixture;
    const run = await launch(fixture);

    const completion = harness.behavior.callAgentTool("sentry_finish_run", repair(), owner).then(
      () => null,
      (cause: Error) => cause,
    );

    await settle();
    expect(hostMethods(fixture)).toEqual(["verify"]);
    await harness.behavior.callRpc("runs.stop", { id: run.id });
    const stopped = runner.store.getRun(run.id);
    failVerification(new Error("Host verification was cancelled"));
    expect(await completion).toBeInstanceOf(Error);
    expect(runner.store.getRun(run.id)).toMatchObject({
      state: "cancelled",
      reason: stopped.reason,
      verification: null,
      publication: null,
    });
    expect(runner.store.hasClaim(run.id)).toBe(false);

    for (const proposal of [report(), repair()])
      await expectRefusal(
        fixture,
        run.id,
        proposal,
        revoked("This Sentry run was stopped by its owner."),
      );
  });

  it("refuses submissions from a claimed package while its project solve is stopping (G1)", async () => {
    const fixture = await setup((call) =>
      call.method === "stop"
        ? Promise.reject(new Error("Machine host_mac is offline"))
        : answerHost(call),
    );

    const { runner, harness } = fixture;
    const solve = saveBatch(runner, "batch_stopping", "waiting", [incident()]);
    const run = await launch(fixture, incident(), solve.id);
    await expect(harness.behavior.callRpc("batches.stop", { id: solve.id })).rejects.toThrow();
    expect(runner.store.getBatch(solve.id).state).toBe("stopping");
    expect(runner.store.hasClaim(run.id)).toBe(true);

    for (const proposal of [report(["acme:101"]), repair(["acme:101"])])
      await expectRefusal(
        fixture,
        run.id,
        proposal,
        revoked("This package's project solve was stopped."),
      );
  });

  it("refuses submissions from a released package after its project solve was stopped (G1)", async () => {
    const fixture = await setup();
    const { runner, harness } = fixture;
    const solve = saveBatch(runner, "batch_cancelled", "waiting", [incident()]);
    const run = await launch(fixture, incident(), solve.id);
    runner.store.updateRun(run.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(run.id);
    await harness.behavior.callRpc("batches.stop", { id: solve.id });
    expect(runner.store.getBatch(solve.id).state).toBe("cancelled");
    expect(runner.store.getRun(run.id).state).toBe("failed");

    for (const proposal of [report(["acme:101"]), repair(["acme:101"])])
      await expectRefusal(
        fixture,
        run.id,
        proposal,
        revoked("This package's project solve was stopped."),
      );
  });

  it("refuses submissions from a run whose issue a newer package owns (G1)", async () => {
    const fixture = await setup();
    const { runner } = fixture;
    const replaced = await launch(fixture);
    runner.store.updateRun(replaced.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(replaced.id);
    saveBatch(runner, "batch_planning", "planning", [incident()]);
    const successor = await queueSuccessor(fixture, ["acme:101"]);

    for (const proposal of [report(), repair()])
      await expectRefusal(
        fixture,
        replaced.id,
        proposal,
        revoked("Run " + successor.id + " now owns CLIENT-101."),
      );
  });

  it("refuses submissions from a package whose related issue a newer package owns (G1)", async () => {
    const fixture = await setup();
    const { runner } = fixture;
    const members = [incident(), incident("102")];
    const keys = members.map((member) => member.key);
    saveBatch(runner, "batch_planning", "planning", members);
    const replaced = await launch(fixture, incident(), "batch_planning", members);
    runner.store.updateRun(replaced.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(replaced.id);
    const successor = await queueSuccessor(fixture, ["acme:102"]);

    for (const proposal of [report(keys), repair(keys)])
      await expectRefusal(
        fixture,
        replaced.id,
        proposal,
        revoked("Run " + successor.id + " now owns CLIENT-102."),
      );
  });

  it("refuses Retry on a package whose project solve was stopped (G1)", async () => {
    const fixture = await setup();
    const { runner, harness } = fixture;
    const solve = saveBatch(runner, "batch_cancelled", "waiting", [incident()]);
    const run = await launch(fixture, incident(), solve.id);
    await harness.behavior.callRpc("batches.stop", { id: solve.id });
    expect(runner.store.getRun(run.id).state).toBe("cancelled");

    await expectRetryRefusal(fixture, run.id, exactly("This package's project solve was stopped."));
  });

  it("refuses Retry on a run whose issue a newer package owns (G1)", async () => {
    const fixture = await setup();
    const { runner } = fixture;
    const replaced = await launch(fixture);
    runner.store.updateRun(replaced.id, { state: "failed", reason: oldFailure, reportRequests: 1 });
    runner.store.release(replaced.id);
    saveBatch(runner, "batch_planning", "planning", [incident()]);
    const successor = await queueSuccessor(fixture, ["acme:101"]);
    runner.store.updateRun(successor.id, { state: "needs-evidence", result: report() });
    runner.store.release(successor.id);

    await expectRetryRefusal(
      fixture,
      replaced.id,
      exactly("Run " + successor.id + " now owns CLIENT-101."),
    );
  });

  it("refuses a report after a lost draft-PR publish and publishes the fix-ready resubmission (G1)", async () => {
    const atPublish: Run[] = [];

    const fixture: Fixture = await setup(
      losingFirstPublish((runId) => atPublish.push(fixture.runner.store.getRun(runId))),
      prRoute(),
    );

    const { runner, harness } = fixture;
    const run = await launch(fixture);
    const marker = { publishAttemptedAt: expect.any(String), publication: null };

    await expect(
      harness.behavior.callAgentTool("sentry_finish_run", repair(), owner),
    ).rejects.toThrow();
    expect(hostMethods(fixture)).toEqual(["verify", "publish"]);
    expect(atPublish).toMatchObject([{ id: run.id, state: "publishing", ...marker }]);
    expect(runner.store.getRun(run.id)).toMatchObject(marker);
    await resumeChat(fixture);
    await idleAfterCompletedTurn(fixture);
    expect(harness.inspection.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(runner.store.hasClaim(run.id)).toBe(true);
    expect(runner.store.getRun(run.id)).toMatchObject(marker);
    await expectRefusal(fixture, run.id, report(), exactly(publishUncertain));

    const response = z
      .string()
      .parse(await harness.behavior.callAgentTool("sentry_finish_run", repair(), owner));

    expect(recorded(response)).toMatchObject({
      id: run.id,
      state: "pr-open",
      publication: { number: 7, head: repairCommit },
    });
    expect(hostMethods(fixture)).toEqual(["verify", "publish", "verify", "publish"]);
  });

  it("refuses a report after a lost draft-PR publish whose idle released the run, and publishes after Retry (G1)", async () => {
    const fixture = await setup(losingFirstPublish(), prRoute());
    const { runner, harness } = fixture;
    const run = await launch(fixture);

    await expect(
      harness.behavior.callAgentTool("sentry_finish_run", repair(), owner),
    ).rejects.toThrow();
    runner.store.updateRun(run.id, { reportRequests: 1 });
    await resumeChat(fixture);
    await idleAfterCompletedTurn(fixture);
    expect(runner.store.getRun(run.id).state).toBe("failed");
    expect(runner.store.hasClaim(run.id)).toBe(false);
    await expectRefusal(fixture, run.id, report(), exactly(publishUncertain));
    await expectRefusal(fixture, run.id, repair(), slotNeeded(repairCommit));
    await harness.behavior.callRpc("runs.retry", { id: run.id });
    expect(runner.store.hasClaim(run.id)).toBe(true);

    expect(runner.store.getRun(run.id)).toMatchObject({
      reportRequests: 0,
      lastTurnSeq: null,
      interruptedAt: null,
      publishAttemptedAt: expect.any(String),
      publication: null,
    });

    await expectRefusal(fixture, run.id, report(), exactly(publishUncertain));

    const response = z
      .string()
      .parse(await harness.behavior.callAgentTool("sentry_finish_run", repair(), owner));

    expect(recorded(response)).toMatchObject({
      id: run.id,
      state: "pr-open",
      publication: { number: 7, head: repairCommit },
    });
    expect(hostMethods(fixture)).toEqual(["verify", "publish", "verify", "publish"]);
  });
});

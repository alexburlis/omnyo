import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import type { Completion, Incident } from "../contract";
import { createSentryPlugin } from "../server";
import { SentryRunner } from "../src/runner";
import { incident, projects, route } from "./fixtures";
import { settle, TurnHistory, type EventsListInput } from "./turn-events";

const interruptedReason = "Interrupted by a stop. Open the chat to continue it, or stop this run.";

const unavailableReason = "Worker state is unavailable; ownership and source are preserved.";

const ownerStopReason = "Stopped by owner; source and evidence retained";

const reminderFailedReason =
  "The completion reminder could not be sent; ownership and source are preserved.";

const endedTwiceReason =
  "Ended twice without a structured report. Continue its chat to submit one, or Retry.";

const machineRemovedReason =
  "Its machine was removed, so this run ended and released the execution slot. Update the route's machine before starting this issue again.";

const chatDeletedReason =
  "Its chat was deleted, so this run ended and released the execution slot. Its branch, worktree and evidence are preserved.";

function deletedChat(): never {
  throw Object.assign(new Error("HTTP 404: Thread not found"), {
    status: 404,
    code: "thread_not_found",
  });
}

const reminder =
  "Your Sentry run still has no validated completion. Preserve your current work, call sentry_run_context and sentry_finish_run with the actual evidence or exact blocker, then give a TL;DR.";

const solverThread = { threadId: "thr_solver", projectId: "proj_app" };

const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();

  for (const dispose of disposers.splice(0)) await dispose();
});

// The shape of the 2026-10-19 refused submission: report only, a report commit, no PR.
function evidenceReport(): Completion {
  return {
    outcome: "needs-evidence",
    classification: "Hypothesis",
    summary: "Both crashes need a device trace before a repair",
    rootCause: "Unproven; the shared playback teardown path is the leading hypothesis",
    change: "No source change; the investigation report is committed",
    commit: "785a506b".padEnd(40, "0"),
    changedFiles: [],
    reproduction: null,
    checks: [],
    limitations: ["No push, PR or Sentry issue change"],
  };
}

function packageReport(members: Incident[]): Completion {
  return {
    ...evidenceReport(),
    issueFindings: members.map((member) => ({
      key: member.key,
      outcome: "blocked",
      summary: "Needs a device trace for this crash path",
      evidence: [],
    })),
  };
}

async function setup() {
  const history = new TurnHistory();
  let spawned = 0;

  const host = createFakePluginHost({
    pluginId: "sentry",
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
        spawn: () => ({
          id: ++spawned === 1 ? "thr_solver" : "thr_successor",
          environmentId: "env_" + spawned,
        }),
        get: (input) => ({
          id: input.threadId,
          status: "idle",
          queuedMessageCount: 0,
          activeBackgroundAgentCount: 0,
        }),
        send: () => ({}),
        stop: () => ({}),
        events: { list: (input) => history.list(input) },
      },
    },
    experimental_callHostRpc: (call) => {
      if (call.method === "stop") return { stopped: true };

      throw new Error("An interrupted solver needs no host effect");
    },
  });

  disposers.push(() => host.harness.lifecycle.dispose());
  await createSentryPlugin()(host.api);
  const runner = new SentryRunner(host.api, async () => ({ apiOrigin: "https://de.sentry.io" }));
  runner.store.saveRoute(route());
  runner.store.savePolicy({ projectId: route().projectId, autoSolve: true, dailyLimit: 10 });
  const { harness } = host;
  const sdk = harness.inspection.sdk;

  return {
    harness,
    runner,
    history,
    sdk,
    sends: () => sdk.callsTo("threads.send"),
    spawns: () => sdk.callsTo("threads.spawn"),
    async idle(threadId: string) {
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: makeThreadResponse({ id: threadId, projectId: "proj_app" }),
        lastAssistantText: null,
      });
      await settle();
    },
    async active(threadId: string) {
      await harness.behavior.emitThreadEvent("thread.active", {
        thread: makeThreadResponse({ id: threadId, projectId: "proj_app", status: "active" }),
      });
      await settle();
    },
    async reconcile() {
      await harness.behavior.callRpc("queue.reconcile", null);
      await settle();
    },
    // One single-issue solver holds the slot; a queued successor waits behind it.
    async startSolver() {
      const solver = runner.store.enqueue(incident(), route());
      const successor = runner.store.enqueue(incident("102"), route());
      await runner.dispatch();

      return { solver, successor };
    },
    // The incident's grouped package of two issues, then the project's next package.
    async startPackage() {
      const members = [incident(), incident("102")];

      const solver = runner.store.updateRun(
        runner.store.enqueue(incident(), route(), true, true).id,
        {
          batchId: "batch_project",
          relatedIncidents: members,
          packageTitle: "Client playback crashes",
          reasoningLevel: "ultra",
          packageHandoff: "Both crashes share the playback teardown path",
        },
      );

      const successor = runner.store.updateRun(
        runner.store.enqueue(incident("103"), route(), true, true).id,
        {
          batchId: "batch_project",
          relatedIncidents: [incident("103")],
          packageTitle: "Client sync crash",
          reasoningLevel: "ultra",
          packageHandoff: "Independent sync failure",
        },
      );

      runner.store.saveBatch({
        id: "batch_project",
        projectId: "proj_app",
        hostId: "host_mac",
        sourceId: null,
        rootPath: "/projects/umbrella",
        routes: [route()],
        incidents: [...members, incident("103")],
        state: "waiting",
        threadId: "thr_coordinator",
        spawnRequestedAt: "2026-10-19T05:20:00Z",
        summaryMarker: null,
        summarySentAt: null,
        runIds: [solver.id, successor.id],
        blocked: [],
        summary: null,
        reason: null,
        reportRequests: 0,
        lastTurnSeq: null,
        createdAt: "2026-10-19T05:20:00Z",
        updatedAt: "2026-10-19T05:20:00Z",
      });
      await runner.dispatch();

      return { solver, successor, members };
    },
    // The slot stays with the stopped run: no message, no failure, no successor.
    expectPaused(runId: string) {
      expect(sdk.callsTo("threads.send")).toHaveLength(0);
      expect(runner.store.getRun(runId)).toMatchObject({
        state: "investigating",
        reportRequests: 0,
        interruptedAt: expect.any(String),
        reason: interruptedReason,
      });
      expect(runner.store.hasClaim(runId)).toBe(true);
      expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    },
    // The one reminder went to the solver, which keeps the slot for the reminder's own turn.
    expectReminded(runId: string) {
      expect(sdk.callsTo("threads.send")).toHaveLength(1);
      expect(sdk.callsTo("threads.send")[0]?.[0]).toMatchObject({
        threadId: "thr_solver",
        input: [{ type: "text", text: reminder }],
      });
      expect(runner.store.getRun(runId)).toMatchObject({
        state: "investigating",
        reportRequests: 1,
      });
      expect(runner.store.hasClaim(runId)).toBe(true);
      expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    },
    expectUnavailable(runId: string) {
      expect(sdk.callsTo("threads.send")).toHaveLength(0);
      expect(runner.store.getRun(runId)).toMatchObject({
        state: "investigating",
        reportRequests: 0,
        reason: unavailableReason,
      });
      expect(runner.store.hasClaim(runId)).toBe(true);
      expect(sdk.callsTo("threads.spawn")).toHaveLength(1);
    },
  };
}

describe("interrupted and continued solvers", () => {
  it.each(["manual", "raced"] as const)(
    "keeps a grouped package paused through two %s stops until its continued chat reports",
    async (kind) => {
      const f = await setup();
      const { solver, successor, members } = await f.startPackage();

      const stop = () =>
        kind === "manual"
          ? f.history.stoppedTurn("thr_solver")
          : f.history.racedStopTurn("thr_solver");

      vi.setSystemTime(new Date("2026-10-19T13:35:37Z"));
      stop();
      await f.idle("thr_solver");
      await f.reconcile();
      f.expectPaused(solver.id);
      const firstPause = f.runner.store.getRun(solver.id);

      vi.setSystemTime(new Date("2026-10-19T13:36:39Z"));
      stop();
      await f.idle("thr_solver");
      await f.reconcile();
      f.expectPaused(solver.id);
      expect(f.runner.store.getRun(solver.id).interruptedAt).toBe(firstPause.interruptedAt);
      expect(f.runner.store.getRun(successor.id).state).toBe("queued");

      await f.active("thr_solver");
      expect(f.runner.store.getRun(solver.id)).toMatchObject({
        state: "investigating",
        interruptedAt: null,
        reason: null,
      });

      const report = packageReport(members);
      await f.harness.behavior.callAgentTool("sentry_finish_run", report, solverThread);
      expect(f.runner.store.getRun(solver.id)).toMatchObject({ state: "needs-evidence" });
      expect(f.runner.store.getRun(solver.id).result).toEqual(report);
      expect(f.runner.store.hasClaim(solver.id)).toBe(true);
      expect(f.spawns()).toHaveLength(1);

      f.history.completedTurn("thr_solver");
      await f.idle("thr_solver");
      expect(f.runner.store.hasClaim(solver.id)).toBe(false);
      expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
      expect(f.spawns()).toHaveLength(2);
      expect(f.sends()).toHaveLength(0);
      expect(f.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
    },
  );

  it("cancels a paused package on Stop run, releases the slot and starts the successor", async () => {
    const f = await setup();
    const { solver, successor } = await f.startPackage();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    await f.reconcile();
    f.expectPaused(solver.id);

    await f.harness.behavior.callRpc("runs.stop", { id: solver.id });
    await settle();
    expect(f.runner.store.getRun(solver.id).state).toBe("cancelled");
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.sdk.callsTo("threads.stop")).toEqual([[{ threadId: "thr_solver" }]]);
    expect(f.harness.inspection.experimental_hostRpcCalls.map((call) => call.method)).toEqual([
      "stop",
    ]);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);
    expect(f.sends()).toHaveLength(0);
  });

  it("sends one reminder per completed turn and fails only after the reminder's own turn", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();
    f.history.completedTurn("thr_solver");
    // A background agent's later interrupted turn is not the chat's own turn.
    f.history.nestedTurn("thr_solver", "interrupted");
    await f.idle("thr_solver");
    f.expectReminded(solver.id);
    const reminded = f.runner.store.getRun(solver.id);

    await f.idle("thr_solver");
    await f.reconcile();
    expect({ ...f.runner.store.getRun(solver.id), updatedAt: reminded.updatedAt }).toEqual(
      reminded,
    );
    f.expectReminded(solver.id);

    await f.active("thr_solver");
    f.history.completedTurn("thr_solver");
    await f.idle("thr_solver");
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: endedTwiceReason,
      threadId: "thr_solver",
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);
    expect(f.sends()).toHaveLength(1);

    const report = evidenceReport();
    await f.harness.behavior.callAgentTool("sentry_finish_run", report, solverThread);
    expect(f.runner.store.getRun(solver.id)).toMatchObject({ state: "needs-evidence" });
    expect(f.runner.store.getRun(solver.id).result).toEqual(report);
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.hasClaim(successor.id)).toBe(true);
    expect(f.spawns()).toHaveLength(2);
    expect(f.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("reminds a continued chat whose turn ends without a report after a stop", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectPaused(solver.id);

    await f.active("thr_solver");
    f.history.completedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectReminded(solver.id);
    expect(f.runner.store.getRun(solver.id).interruptedAt).toBeNull();
  });

  it("pauses a reminded run that is stopped before its next turn starts", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.history.completedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectReminded(solver.id);

    await f.active("thr_solver");
    f.history.interrupted("thr_solver", "manual-stop");
    await f.idle("thr_solver");
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "investigating",
      interruptedAt: expect.any(String),
      reason: interruptedReason,
    });
    f.expectReminded(solver.id);
  });

  it("keeps the reminder budget when the reminder send fails", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    const before = f.runner.store.getRun(solver.id);
    f.sdk.stub("threads.send", () => {
      throw new Error("Send refused during a maintenance hold");
    });
    f.history.completedTurn("thr_solver");
    await f.idle("thr_solver");

    const after = f.runner.store.getRun(solver.id);
    expect(after.reason).toEqual(expect.any(String));
    expect({ ...after, reason: before.reason, updatedAt: before.updatedAt }).toEqual(before);
    expect(f.runner.store.hasClaim(solver.id)).toBe(true);
    expect(f.spawns()).toHaveLength(1);

    f.sdk.stub("threads.send", () => ({}));
    await f.reconcile();
    expect(f.sends()).toHaveLength(2);
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "investigating",
      reportRequests: 1,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(true);
  });

  it("keeps the slot without a reminder when the turn history cannot be read", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.sdk.stub("threads.events.list", () => {
      throw new Error("Thread history is unavailable");
    });
    await f.idle("thr_solver");
    await f.reconcile();
    f.expectUnavailable(solver.id);
  });

  it.each([
    ["no root turn is recorded", () => {}],
    [
      "only subagent turns completed",
      (history: TurnHistory) => {
        history.nestedTurn("thr_solver", "completed");
      },
    ],
    [
      "a root turn started after the latest completion",
      (history: TurnHistory) => {
        history.completedTurn("thr_solver");
        history.openTurn("thr_solver");
      },
    ],
  ] as const)("keeps the slot without a reminder when %s", async (_label, arrange) => {
    const f = await setup();
    const { solver } = await f.startSolver();
    arrange(f.history);
    await f.idle("thr_solver");
    await f.reconcile();
    f.expectUnavailable(solver.id);
  });

  it("ends a run whose machine was removed, starts the successor and records its late report", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();
    f.history.hostInterruptedTurn("thr_solver", "host-removed");
    await f.idle("thr_solver");
    expect(f.sends()).toHaveLength(0);
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: machineRemovedReason,
      threadId: "thr_solver",
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);

    const report = evidenceReport();
    await f.harness.behavior.callAgentTool("sentry_finish_run", report, solverThread);
    expect(f.runner.store.getRun(solver.id)).toMatchObject({ state: "needs-evidence" });
    expect(f.runner.store.getRun(solver.id).result).toEqual(report);
    expect(f.runner.store.hasClaim(successor.id)).toBe(true);
    expect(f.spawns()).toHaveLength(2);
    expect(f.sends()).toHaveLength(0);
    expect(f.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("ends a run whose chat was deleted at reconcile and starts the successor", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();

    f.sdk.stub("threads.get", deletedChat);
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: chatDeletedReason,
      threadId: "thr_solver",
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);
    expect(f.sends()).toHaveLength(0);
  });

  it("keeps the slot when a run's chat cannot be read for another reason", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();

    f.sdk.stub("threads.get", () => {
      throw new Error("Refused during a maintenance hold");
    });
    await f.reconcile();
    f.expectUnavailable(solver.id);
  });

  it("stops a run whose chat was deleted and starts the successor", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();

    f.sdk.stub("threads.stop", deletedChat);
    await f.harness.behavior.callRpc("runs.stop", { id: solver.id });
    await settle();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "cancelled",
      reason: ownerStopReason,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
  });

  it("ends an already paused run at reconcile once its machine disappears", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectPaused(solver.id);

    f.sdk.stub("hosts.list", () => [makeHostResponse({ id: "host_other" })]);
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: machineRemovedReason,
      threadId: "thr_solver",
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);
    expect(f.sends()).toHaveLength(0);
    expect(f.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("ends a run at reconcile once its machine disappears while its reminder cannot be sent", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();
    f.sdk.stub("threads.send", () => {
      throw new Error("Host not found");
    });
    f.history.completedTurn("thr_solver");
    await f.idle("thr_solver");
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "investigating",
      reportRequests: 0,
      reason: reminderFailedReason,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(true);

    f.sdk.stub("hosts.list", () => [makeHostResponse({ id: "host_other" })]);
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: machineRemovedReason,
      threadId: "thr_solver",
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.spawns()).toHaveLength(2);
    expect(f.harness.inspection.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("keeps the pause when the machine list cannot be read", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectPaused(solver.id);
    const paused = f.runner.store.getRun(solver.id);

    f.sdk.stub("hosts.list", () => {
      throw new Error("Machine list is unavailable");
    });
    await f.reconcile();
    expect({ ...f.runner.store.getRun(solver.id), updatedAt: paused.updatedAt }).toEqual(paused);
    f.expectPaused(solver.id);
  });

  it("reads the turn history again at the next reconcile and then reminds once", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.history.completedTurn("thr_solver");
    f.sdk.stub("threads.events.list", () => {
      throw new Error("Thread history is unavailable");
    });
    await f.idle("thr_solver");
    f.expectUnavailable(solver.id);

    f.sdk.stub("threads.events.list", (input: EventsListInput) => f.history.list(input));
    await f.reconcile();
    f.expectReminded(solver.id);
  });

  it("clears turn bookkeeping when the owner retries a run that ended after a pause", async () => {
    const f = await setup();
    const solver = f.runner.store.enqueue(incident(), route());
    await f.runner.dispatch();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    expect(f.runner.store.getRun(solver.id).interruptedAt).toEqual(expect.any(String));

    f.sdk.stub("hosts.list", () => [makeHostResponse({ id: "host_other" })]);
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "failed",
      reason: machineRemovedReason,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);

    f.sdk.stub("hosts.list", () => [makeHostResponse({ id: "host_mac" })]);
    await f.harness.behavior.callRpc("runs.retry", { id: solver.id });
    await settle();
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "investigating",
      reportRequests: 0,
      lastTurnSeq: null,
      interruptedAt: null,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(true);
    expect(f.sends()).toHaveLength(1);
  });

  it("restores the pause guidance once the history is readable again", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    const paused = f.runner.store.getRun(solver.id);

    f.sdk.stub("threads.events.list", () => {
      throw new Error("Thread history is unavailable");
    });
    await f.reconcile();
    expect(f.runner.store.getRun(solver.id).reason).toBe(unavailableReason);

    f.sdk.stub("threads.events.list", (input: EventsListInput) => f.history.list(input));
    await f.reconcile();
    f.expectPaused(solver.id);
    expect(f.runner.store.getRun(solver.id).interruptedAt).toBe(paused.interruptedAt);
  });

  it.each([
    [
      "its first turn ends without a report",
      0,
      (f: Fixture) => f.history.completedTurn("thr_solver"),
    ],
    [
      "its reminder's own turn ends without a report",
      1,
      async (f: Fixture) => {
        f.history.completedTurn("thr_solver");
        await f.idle("thr_solver");
        await f.active("thr_solver");
        f.history.completedTurn("thr_solver");
      },
    ],
    ["its turn is stopped", 0, (f: Fixture) => f.history.stoppedTurn("thr_solver")],
  ] as const)(
    "keeps an owner Stop that lands while idle reads the history after %s",
    async (_label, reminders, arrange) => {
      const f = await setup();
      const { solver, successor } = await f.startSolver();
      await arrange(f);
      stopInside(f, solver.id, "threads.events.list", (input) => f.history.list(input));
      await f.idle("thr_solver");

      expect(f.runner.store.getRun(solver.id)).toMatchObject({
        state: "cancelled",
        reason: ownerStopReason,
        reportRequests: reminders,
        interruptedAt: null,
      });
      expect(f.runner.store.hasClaim(solver.id)).toBe(false);
      expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
      expect(f.sends()).toHaveLength(reminders);
    },
  );

  it("keeps an owner Stop that lands while idle checks a paused run's machine", async () => {
    const f = await setup();
    const { solver, successor } = await f.startSolver();
    f.history.stoppedTurn("thr_solver");
    await f.idle("thr_solver");
    f.expectPaused(solver.id);

    stopInside(f, solver.id, "hosts.list", () => [makeHostResponse({ id: "host_other" })]);
    await f.idle("thr_solver");
    expect(f.runner.store.getRun(solver.id)).toMatchObject({
      state: "cancelled",
      reason: ownerStopReason,
    });
    expect(f.runner.store.hasClaim(solver.id)).toBe(false);
    expect(f.runner.store.getRun(successor.id).threadId).toBe("thr_successor");
    expect(f.sends()).toHaveLength(0);
  });

  it("finds a root turn behind more than one page of subagent turns", async () => {
    const f = await setup();
    const { solver } = await f.startSolver();
    const rootTurn = f.history.turnId();
    f.history.started("thr_solver", rootTurn);

    for (let subagent = 0; subagent < 120; subagent++)
      f.history.nestedTurn("thr_solver", "completed");
    f.history.completed("thr_solver", rootTurn, "completed");
    await f.idle("thr_solver");
    f.expectReminded(solver.id);
    expect(f.sdk.callsTo("threads.events.list").length).toBeGreaterThan(3);
  });
});

type Fixture = Awaited<ReturnType<typeof setup>>;

// The owner's Stop run completes inside the next call to an SDK path that idle() awaits.
function stopInside<T>(
  f: Fixture,
  runId: string,
  path: string,
  result: (input: EventsListInput) => T,
) {
  let stopped = false;

  f.sdk.stub(path, async (input: EventsListInput) => {
    if (!stopped) {
      stopped = true;
      await f.harness.behavior.callRpc("runs.stop", { id: runId });
    }

    return result(input);
  });
}

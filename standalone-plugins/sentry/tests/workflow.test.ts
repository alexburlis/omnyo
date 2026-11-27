import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { createStateMachineRpcHandlers } from "../../state-machines/src/rpc";
import { stateMachinesRpc } from "../../state-machines/src/contracts/rpc";
import { setup } from "../../state-machines/tests/runtime-fixtures";
import { sentryWorkflowRequest } from "../../state-machines/src/actions/sentry-workflow";
import { SentryRunner } from "../src/runner";
import { SentryWorkflow } from "../src/workflow";
import * as graph from "../src/workflow-graph";
import type { Diagnosis } from "../src/workflow-contract";
import { incident, route } from "./fixtures";

const dispose: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of dispose.splice(0)) await close();
  vi.restoreAllMocks();
});

const sha = "a".repeat(40);

const diagnosis: Diagnosis = {
  classification: "already-fixed",
  targetRouteId: null,
  proofKind: "Proven by inspection",
  summary: "The source fixes the exact observed cause",
  rootCause: "A value was read after disposal",
  proof: "The deployed source serializes access before disposal",
  evidence: ["proof.md"],
  sourceCommit: sha,
  nativeRequired: [],
  selectionPath: null,
  reconsiderWhen: "A matching event occurs on the fixed source",
};

async function fixture(issueCount = 1, substatus = "new") {
  const engine = setup();

  const handlers = createStateMachineRpcHandlers(engine.service, {
    listEnvironments: async () => [],
  });

  const configured = { ...route(), delivery: "pr" as const, githubRepository: "alexburlis/omnyo" };
  const metadata = new Map<string, Record<string, string>>();
  const setupFailures = new Map<string, boolean>();
  const runningThreads = new Set<string>();
  const queuedThreads = new Set<string>();
  const backgroundThreads = new Set<string>();
  const deletedThreads = new Set<string>();

  const connection = async () => ({
    apiOrigin: "https://sentry.invalid",
    apiToken: "fixture-token",
  });

  const transport = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));

  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      environments: {
        get: () => ({
          id: "environment",
          projectId: configured.projectId,
          hostId: configured.hostId,
          path: configured.repositoryPath,
          managed: false,
          lifecycle: { phase: "active", retireAt: null },
        }),
      },
      threads: {
        get: ({ threadId }) => {
          if (deletedThreads.has(threadId))
            throw Object.assign(new Error("HTTP 404: Thread not found"), {
              status: 404,
              code: "thread_not_found",
            });

          return makeThreadResponse({
            id: threadId,
            status: runningThreads.has(threadId)
              ? "active"
              : setupFailures.has(threadId)
                ? "error"
                : "idle",
            projectId: configured.projectId,
            environmentId: "environment",
            originPluginId: threadId === "forged" ? "another-plugin" : "sentry",
            queuedMessageCount: queuedThreads.has(threadId) ? 1 : 0,
            activeBackgroundAgentCount: backgroundThreads.has(threadId) ? 1 : 0,
          });
        },
        getPluginMetadata: ({ threadId }) => metadata.get(threadId) ?? {},
        stop: () => ({}),
        events: {
          list: ({ threadId, types }) => {
            if (!setupFailures.has(threadId)) return [];

            if (types?.[0] === "system/thread-provisioning")
              return [{ type: "system/thread-provisioning", data: { status: "failed" } }];

            if (types?.[0] === "turn/input/accepted" && setupFailures.get(threadId))
              return [{ type: "turn/input/accepted" }];

            return [];
          },
        },
        list: () => [],
      },
      plugins: {
        callRpc: async (request) => {
          switch (request.method) {
            case "sm_machine_create":
              return handlers.sm_machine_create(
                stateMachinesRpc.sm_machine_create.input.parse(request.input),
              );
            case "sm_machine_draft_get":
              return handlers.sm_machine_draft_get(
                stateMachinesRpc.sm_machine_draft_get.input.parse(request.input),
              );
            case "sm_machine_draft_save":
              return handlers.sm_machine_draft_save(
                stateMachinesRpc.sm_machine_draft_save.input.parse(request.input),
              );
            case "sm_machine_validate":
              return handlers.sm_machine_validate(
                stateMachinesRpc.sm_machine_validate.input.parse(request.input),
              );
            case "sm_machine_publish":
              return handlers.sm_machine_publish(
                stateMachinesRpc.sm_machine_publish.input.parse(request.input),
              );
            case "sm_machine_versions":
              return handlers.sm_machine_versions(
                stateMachinesRpc.sm_machine_versions.input.parse(request.input),
              );
            case "sm_machine_version_get":
              return handlers.sm_machine_version_get(
                stateMachinesRpc.sm_machine_version_get.input.parse(request.input),
              );
            case "sm_instance_start":
              return handlers.sm_instance_start(
                stateMachinesRpc.sm_instance_start.input.parse(request.input),
              );
            case "sm_instance_inspect":
              return handlers.sm_instance_inspect(
                stateMachinesRpc.sm_instance_inspect.input.parse(request.input),
              );
            case "sm_instance_control":
              return handlers.sm_instance_control(
                stateMachinesRpc.sm_instance_control.input.parse(request.input),
              );
            default:
              throw new Error(`Unexpected method ${request.method}`);
          }
        },
      },
    },
  });

  dispose.push(async () => {
    await host.harness.lifecycle.dispose();
    engine.database.close();
  });
  const runner = new SentryRunner(host.api, connection, transport);
  const savedRoute = runner.store.saveRoute(configured);

  const spawn = vi
    .spyOn(runner, "startWorkflowWorker")
    .mockImplementation(async (runId, _prompt, attemptId, operation) => {
      const threadId = `worker_${attemptId}`;
      metadata.set(threadId, { runId, workflowAttemptId: attemptId, workflowOperation: operation });

      return threadId;
    });

  const workflow = new SentryWorkflow(host.api, runner, connection, transport);

  const input = {
    routeId: savedRoute.id,
    environmentId: "environment",
    enabled: true,
    authorityReference: "Omnyo Sentry maintenance requested",
    dailyLimit: 10,
    includeExisting: true,
    nativeSurfaces: [],
  };

  await workflow.configure(input);
  runner.store.acceptPage(
    savedRoute,
    Array.from({ length: issueCount }, (_, index) => ({
      ...incident(String(101 + index)),
      substatus,
    })),
    null,
    new Date().toISOString(),
  );
  await workflow.reconcile();
  await engine.service.tick();

  const current = () => {
    const invocation = engine.adapter.starts.at(-1);

    if (!invocation) throw new Error("No graph invocation");
    const task = workflow.status().tasks.find((item) => item.instanceId === invocation.instanceId);

    if (!task) throw new Error("No workflow task");

    const value = sentryWorkflowRequest(invocation, [
      "omnyo",
      "sentry",
      "workflow-step",
      invocation.state.id,
      "--run",
      task.runId,
    ]);

    if (!value) throw new Error("No workflow request");

    return value;
  };

  const updateTask = (
    runId: string,
    update: {
      diagnosis?: Diagnosis;
      status?: "resolved" | "deferred" | "blocked";
      finishedAt?: string;
      waiting?: boolean;
      instanceId?: string | null;
      homeThreadId?: string | null;
    },
  ) => {
    const db = host.api.storage.database();

    const row = z
      .object({ payload: z.string() })
      .parse(db.prepare("SELECT payload FROM workflow_bindings WHERE run_id=?").get(runId));

    db.prepare("UPDATE workflow_bindings SET payload=? WHERE run_id=?").run(
      JSON.stringify({ ...JSON.parse(row.payload), ...update }),
      runId,
    );
  };

  const advance = async (
    outcome: string,
    failure?:
      | { type: "failed"; payload: { workspaceSetupFailed: true } }
      | { type: "cancelled"; payload: Record<string, never> },
  ) => {
    const invocation = engine.adapter.starts.at(-1);

    if (!invocation) throw new Error("No graph invocation");
    engine.adapter.settle(invocation, {
      status: "quiescent",
      confirmedLive: false,
      result: failure ?? { type: "result", outcome, payload: {} },
    });
    engine.advance(1000);
    await engine.service.tick();
    await engine.service.tick();
  };

  return {
    ...host,
    engine,
    runner,
    workflow,
    input,
    savedRoute,
    spawn,
    transport,
    metadata,
    setupFailures,
    runningThreads,
    queuedThreads,
    backgroundThreads,
    deletedThreads,
    current,
    updateTask,
    advance,
    restart: () => new SentryWorkflow(host.api, runner, connection, transport),
  };
}

describe("Sentry workflow authority and durable ownership", () => {
  it("reads delivery receipts from before explicit release approval", async () => {
    const f = await fixture();
    const invocation = f.current();
    const store = f.runner.store.workflow;
    const task = store.task(invocation.runId);

    const plan = {
      status: "planned",
      kind: "runtime",
      sourceCommit: sha,
      planPath: "/workflows/run/plan.json",
      planDigest: sha,
      nativeRequired: [],
      reason: null,
    };

    const observation = {
      status: "quiescent",
      confirmedLive: false,
      result: { type: "result", outcome: "already-fixed", payload: {} },
      retrySafe: false,
    };

    f.api.storage
      .database()
      .prepare("UPDATE workflow_bindings SET payload=? WHERE run_id=?")
      .run(
        JSON.stringify({
          ...task,
          plan,
          release: undefined,
          steps: [
            {
              invocation,
              state: "complete",
              threadId: null,
              workerResult: null,
              observation,
              reason: null,
            },
          ],
        }),
        task.runId,
      );

    const restored = store.task(task.runId);
    expect(restored.plan).toEqual({ ...plan, releaseRequired: false });
    expect(restored.release).toBeNull();
    await expect(f.restart().inspect(invocation)).resolves.toEqual(observation);
  });

  it("adopts the new graph once for a blocked repair and reuses its completed diagnosis", async () => {
    const definition = graph.sentryWorkflowGraph;

    const previousGraph = vi
      .spyOn(graph, "sentryWorkflowGraph")
      .mockImplementationOnce((id, policy) => ({
        ...definition(id, policy),
        description: "Previously published Sentry workflow",
      }));

    const f = await fixture();

    previousGraph.mockRestore();
    const first = f.current();

    f.updateTask(first.runId, { diagnosis: { ...diagnosis, classification: "needs-diagnostics" } });
    await f.workflow.start(first);
    await f.advance("needs-diagnostics");
    const failedRepair = f.current();
    const failedWorker = `worker_${failedRepair.attemptId}`;

    await f.workflow.start(failedRepair);
    f.setupFailures.set(failedWorker, false);
    f.runner.store.updateRun(first.runId, { threadId: failedWorker, baseSha: sha });
    await vi.waitFor(() =>
      expect(f.workflow.status().tasks[0]?.steps.at(-1)?.state).toBe("running"),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.workflow.cancel(failedRepair);
    expect(f.workflow.status().tasks[0]?.steps.at(-1)?.state).toBe("cancelled");
    await f.advance("cancelled", { type: "cancelled", payload: {} });
    await f.workflow.reconcile();
    const newPolicy = await f.workflow.configure(f.input);

    expect(f.workflow.status().tasks[0]).toMatchObject({
      status: "blocked",
      diagnosis: "needs-diagnostics",
      steps: [expect.anything(), { state: "cancelled", threadId: failedWorker }],
    });
    expect(f.engine.service.inspectInstance({ instanceId: first.instanceId }).versionId).not.toBe(
      newPolicy.versionId,
    );
    vi.spyOn(f.runner, "workflowWorkspace").mockResolvedValue("environment");
    const recovered = await f.workflow.recoverSetup(first.runId);

    expect(recovered.instanceId).toBeTruthy();
    expect(recovered.instanceId).not.toBe(first.instanceId);
    expect(f.engine.service.inspectInstance({ instanceId: first.instanceId }).lifecycle).toBe(
      "stopped",
    );
    expect(await f.workflow.recoverSetup(first.runId)).toEqual(recovered);
    await f.engine.service.tick();
    const savedDiagnosis = f.current();

    await f.workflow.start(savedDiagnosis);
    expect((await f.workflow.inspect(savedDiagnosis)).result?.outcome).toBe("needs-diagnostics");
    expect(f.spawn).toHaveBeenCalledTimes(2);
    await f.advance("needs-diagnostics");
    expect(f.current().operation).toBe("repair");
    expect(f.runner.store.getRun(first.runId).environmentId).toBe("environment");
  });

  it.each([false, true])(
    "only retries a proven workspace failure when inputAccepted=%s",
    async (inputAccepted) => {
      const f = await fixture();
      const first = f.current();
      f.updateTask(first.runId, {
        diagnosis: { ...diagnosis, classification: "needs-diagnostics" },
      });
      f.runner.store.updateRun(first.runId, { environmentId: "environment" });
      await f.workflow.start(first);
      await f.advance("needs-diagnostics");
      const repair = f.current();

      expect(repair.operation).toBe("repair");
      await f.workflow.start(repair);
      f.setupFailures.set(`worker_${repair.attemptId}`, inputAccepted);
      const workspace = vi.spyOn(f.runner, "workflowWorkspace").mockResolvedValue("environment");
      const observation = await f.workflow.inspect(repair);

      if (inputAccepted) {
        expect(observation.status).toBe("uncertain");
        expect(workspace).not.toHaveBeenCalled();

        return;
      }

      const failure = { type: "failed", payload: { workspaceSetupFailed: true } } as const;

      expect(observation.result).toEqual(failure);
      await f.advance("failed", failure);
      expect(f.engine.service.inspectInstance({ instanceId: repair.instanceId })).toMatchObject({
        stateId: "wait-workspace",
      });
      f.engine.advance(61_000);
      await f.engine.service.tick();
      await f.engine.service.tick();
      expect(f.current().operation).toBe("repair");
      expect(f.current().attemptId).not.toBe(repair.attemptId);
      await f.advance("failed", failure);
      expect(f.engine.service.inspectInstance({ instanceId: repair.instanceId }).stateId).toBe(
        "blocked",
      );
    },
  );

  it("does not start a resolved issue retained in the intake store", async () => {
    const f = await fixture(0);
    f.runner.store.acceptPage(
      f.savedRoute,
      [{ ...incident(), status: "resolved" }],
      null,
      new Date().toISOString(),
    );
    await f.workflow.reconcile();
    expect(f.workflow.status().tasks).toHaveLength(0);
  });

  it("starts a later regression on the same release after its prior generation ended", async () => {
    const f = await fixture(1, "regressed");
    const first = f.current();
    await f.advance("deferred");
    await f.advance("recorded");
    f.updateTask(first.runId, { status: "resolved", finishedAt: "2026-11-17T00:00:00Z" });
    f.runner.store.updateRun(first.runId, { state: "local-ready" });
    f.runner.store.acceptPage(
      f.savedRoute,
      [{ ...incident(), substatus: "regressed", lastSeen: "2026-11-17T23:59:59Z" }],
      null,
      new Date().toISOString(),
    );
    await f.workflow.reconcile();
    expect(f.workflow.status().tasks).toHaveLength(2);
  });

  it("keeps one issue owner and one admitted repository instance through reconciliation and restart", async () => {
    const f = await fixture(2);
    await f.workflow.reconcile();
    await f.restart().reconcile();
    expect(f.workflow.status().tasks).toHaveLength(2);
    expect(
      f.engine.service.listInstances({ machineId: f.workflow.status().policies[0]!.machineId }),
    ).toHaveLength(1);
    expect(f.runner.store.listRuns()).toHaveLength(2);
    expect(f.runner.store.issueOwner(incident().key)?.id).toBe(f.workflow.status().tasks[0]?.runId);
  });

  it("lets another issue progress while an existing issue waits for installation", async () => {
    const f = await fixture(2);
    const first = f.current();
    f.updateTask(first.runId, { waiting: true });
    f.runner.store.release(first.runId);
    await f.workflow.reconcile();
    expect(f.workflow.status().tasks.filter((task) => task.instanceId !== null)).toHaveLength(2);
  });

  it.each([
    "invocationId",
    "entryId",
    "attemptId",
    "specHash",
    "generation",
    "environmentId",
    "projectId",
  ] as const)("rejects a forged %s before starting work", async (field) => {
    const f = await fixture();
    const value = f.current();
    expect((await f.workflow.authorize(value)).allowed).toBe(true);
    const forged = { ...value, [field]: field === "generation" ? value.generation + 1 : "forged" };
    expect((await f.workflow.authorize(forged)).allowed).toBe(false);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("revokes stale policy authority and does not start queued stale work", async () => {
    const f = await fixture(2);
    const invocation = f.current();
    await f.workflow.configure({ ...f.input, enabled: false });
    expect((await f.workflow.authorize(invocation)).allowed).toBe(false);
    await f.advance("deferred");
    await f.advance("recorded");
    await f.workflow.reconcile();
    expect(f.workflow.status().tasks.filter((task) => task.instanceId !== null)).toHaveLength(1);
  });

  it("reuses the exact worker attempt and rejects a result from another thread", async () => {
    const f = await fixture();
    const invocation = f.current();
    await f.workflow.start(invocation);
    await f.workflow.start(invocation);
    expect(f.spawn).toHaveBeenCalledTimes(1);
    f.metadata.set("forged", { workflowAttemptId: invocation.attemptId });
    await expect(
      f.workflow.submit("forged", invocation.attemptId, { kind: "diagnosis", value: diagnosis }),
    ).rejects.toThrow();
  });

  it("returns a blocked task to active when the engine admits a new attempt", async () => {
    const f = await fixture();
    const first = f.current();
    f.updateTask(first.runId, { status: "blocked" });
    await f.workflow.start(first);
    expect(f.workflow.status().tasks[0]?.status).toBe("active");
  });

  it("nests step chats under the run's home chat when the first admission overlaps the start", async () => {
    const f = await fixture();
    const first = f.current();
    const { homeThreadId } = f.engine.service.inspectInstance({ instanceId: first.instanceId });

    f.updateTask(first.runId, { instanceId: null, homeThreadId: null });
    const admission = f.workflow.authorize(first);
    f.updateTask(first.runId, { instanceId: first.instanceId });
    expect((await admission).allowed).toBe(true);
    await f.workflow.start(first);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledTimes(1));

    expect(homeThreadId).toMatch(/^home-/);
    expect(f.spawn.mock.calls[0]?.[5]).toBe(homeThreadId);
  });

  it("rejects runtime proof for a different source and leaves Sentry untouched", async () => {
    const f = await fixture();
    const first = f.current();
    f.updateTask(first.runId, { diagnosis });
    await f.advance("already-fixed");
    const invocation = f.current();
    await f.workflow.start(invocation);
    const threadId = `worker_${invocation.attemptId}`;
    await f.workflow.submit(threadId, invocation.attemptId, {
      kind: "runtime",
      value: {
        sourceCommit: "b".repeat(40),
        passed: true,
        evidence: ["runtime.md"],
        summary: "Observed another source",
      },
    });
    await expect(f.workflow.inspect(invocation)).rejects.toThrow("exact delivered source");
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.workflow.status().tasks[0]?.status).toBe("active");
  });

  it("asks a reviewer to lead its evidence with a file path the merge step can check", async () => {
    const f = await fixture();
    const first = f.current();
    f.updateTask(first.runId, { diagnosis: { ...diagnosis, classification: "proven-defect" } });
    f.runner.store.updateRun(first.runId, { environmentId: "environment" });
    await f.workflow.start(first);
    await f.advance("proven-defect");
    await f.advance("fixed");
    await f.advance("verified");
    const review = f.current();

    expect(review.operation).toBe("review");
    await f.workflow.start(review);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const threadId = `worker_${review.attemptId}`;

    const result = (evidence: string[]) => ({
      kind: "review" as const,
      value: { head: sha, verdict: "approve" as const, summary: "The repair is sound", evidence },
    });

    await expect(
      f.workflow.submit(
        threadId,
        review.attemptId,
        result(["src/hub.ts:3208 and :3246: the fetch forwards the original body"]),
      ),
    ).rejects.toThrow("repository-relative path");
    await expect(
      f.workflow.submit(
        threadId,
        review.attemptId,
        result(["src/hub.ts", "src/hub.ts:3208 forwards the original body"]),
      ),
    ).resolves.toEqual({ accepted: true });
  });

  it.each(["active", "queued", "background"] as const)(
    "keeps a blocked run's slot during %s work and frees it once its chat is gone",
    async (work) => {
      const f = await fixture();
      const first = f.current();

      f.updateTask(first.runId, {
        diagnosis: { ...diagnosis, classification: "needs-diagnostics" },
      });
      await f.workflow.start(first);
      await f.advance("needs-diagnostics");
      const repair = f.current();
      const worker = `worker_${repair.attemptId}`;

      await f.workflow.start(repair);
      f.runner.store.updateRun(first.runId, { threadId: worker, baseSha: sha });
      await vi.waitFor(() =>
        expect(f.workflow.status().tasks[0]?.steps.at(-1)?.state).toBe("running"),
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.workflow.cancel(repair);
      await f.advance("cancelled", { type: "cancelled", payload: {} });
      await f.workflow.reconcile();
      expect(f.workflow.status().tasks[0]?.status).toBe("blocked");

      f.runner.store.updateRun(first.runId, { state: "investigating", reason: null });
      f.api.storage
        .database()
        .prepare("INSERT INTO repo_claims VALUES (?,?)")
        .run(`${f.savedRoute.hostId}:${f.savedRoute.repositoryPath}`, first.runId);

      const busyThreads =
        work === "active"
          ? f.runningThreads
          : work === "queued"
            ? f.queuedThreads
            : f.backgroundThreads;

      busyThreads.add(worker);
      await f.workflow.reconcile();

      expect(f.runner.store.hasClaim(first.runId)).toBe(true);
      expect(f.runner.store.getRun(first.runId).state).toBe("investigating");

      busyThreads.delete(worker);
      f.deletedThreads.add(worker);
      await f.restart().reconcile();

      expect(f.runner.store.hasClaim(first.runId)).toBe(false);
      expect(f.runner.store.getRun(first.runId)).toMatchObject({
        state: "needs-evidence",
        reason: "State Machine needs attention; inspect its retained step evidence",
      });
      expect(f.workflow.status().tasks[0]?.status).toBe("blocked");
    },
  );

  it("ends a step whose chat was deleted and frees its run once the workflow blocks", async () => {
    const f = await fixture();
    const first = f.current();

    f.updateTask(first.runId, { diagnosis: { ...diagnosis, classification: "needs-diagnostics" } });
    await f.workflow.start(first);
    await f.advance("needs-diagnostics");
    const repair = f.current();
    const worker = `worker_${repair.attemptId}`;

    await f.workflow.start(repair);
    await vi.waitFor(() =>
      expect(f.workflow.status().tasks[0]?.steps.at(-1)).toMatchObject({
        state: "running",
        threadId: worker,
      }),
    );
    f.runner.store.updateRun(first.runId, { threadId: worker, state: "investigating" });
    f.api.storage
      .database()
      .prepare("INSERT INTO repo_claims VALUES (?,?)")
      .run(`${f.savedRoute.hostId}:${f.savedRoute.repositoryPath}`, first.runId);
    f.deletedThreads.add(worker);

    const observation = await f.workflow.inspect(repair);

    expect(observation).toMatchObject({
      status: "quiescent",
      confirmedLive: false,
      result: { type: "failed" },
      retrySafe: false,
    });
    const invocation = f.engine.adapter.starts.at(-1);

    if (!invocation) throw new Error("No graph invocation");
    f.engine.adapter.settle(invocation, observation);
    f.engine.advance(1000);
    await f.engine.service.tick();
    await f.engine.service.tick();
    expect(f.engine.service.inspectInstance({ instanceId: repair.instanceId })).toMatchObject({
      stateId: "blocked",
      unknownOutcomes: [],
    });

    await f.workflow.reconcile();
    expect(f.runner.store.hasClaim(first.runId)).toBe(false);
    expect(f.runner.store.getRun(first.runId).state).toBe("needs-evidence");
  });

  it("stops a repair refused by a busy execution slot instead of leaving an unknown outcome", async () => {
    const f = await fixture(2);
    const first = f.current();
    f.updateTask(first.runId, { diagnosis: { ...diagnosis, classification: "needs-diagnostics" } });
    await f.workflow.start(first);
    await f.advance("needs-diagnostics");
    const repair = f.current();
    const holder = f.runner.store.listRuns().find((run) => run.id !== repair.runId);

    if (!holder) throw new Error("No second run");
    f.runner.store.reclaim(holder.id);
    f.spawn.mockImplementationOnce((...args) =>
      SentryRunner.prototype.startWorkflowWorker.apply(f.runner, args),
    );
    await f.workflow.start(repair);
    await vi.waitFor(() =>
      expect(
        f.workflow
          .status()
          .tasks.find((task) => task.runId === repair.runId)
          ?.steps.at(-1)?.state,
      ).toBe("complete"),
    );
    const observation = await f.workflow.inspect(repair);
    const invocation = f.engine.adapter.starts.at(-1);

    if (!invocation) throw new Error("No graph invocation");
    f.engine.adapter.settle(invocation, observation);
    f.engine.advance(1000);
    await f.engine.service.tick();
    await f.engine.service.tick();

    expect(observation).toMatchObject({ status: "quiescent", result: { type: "failed" } });
    expect(f.engine.service.inspectInstance({ instanceId: repair.instanceId })).toMatchObject({
      stateId: "blocked",
      unknownOutcomes: [],
    });
    expect(f.engine.service.listAttention({ instanceId: repair.instanceId })).toEqual([
      expect.objectContaining({
        kind: "gate",
        cause: expect.objectContaining({
          outcome: "failed",
          reason: `The step didn't start, so nothing changed. Another investigation (${holder.incident.shortId}) is using the execution slot. Retry after it finishes.`,
        }),
      }),
    ]);
  });

  it("keeps an ambiguous worker launch failure as an unknown outcome", async () => {
    const f = await fixture();
    const first = f.current();
    f.spawn.mockRejectedValueOnce(new Error("The launch response was lost"));
    await f.workflow.start(first);
    await vi.waitFor(() =>
      expect(f.workflow.status().tasks[0]?.steps.at(-1)?.state).toBe("unknown"),
    );

    expect(await f.workflow.inspect(first)).toMatchObject({ status: "uncertain" });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createStateMachineRpcHandlers } from "../../state-machines/src/rpc";
import { stateMachinesRpc } from "../../state-machines/src/contracts/rpc";
import { sentryWorkflowOperationSchema } from "../../state-machines/src/contracts/sentry-workflow";
import { setup } from "../../state-machines/tests/runtime-fixtures";
import { WorkflowMachine } from "../src/workflow-machine";
import { workflowOperationSchema, type WorkflowPolicy } from "../src/workflow-contract";

const fixtures: ReturnType<typeof setup>[] = [];

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose();

  for (const fixture of fixtures.splice(0)) fixture.database.close();
});

const input = {
  routeId: "omnyo",
  repairRouteIds: [],
  environmentId: "environment",
  authorityReference: "User requested Omnyo Sentry maintenance",
  enabled: true,
  includeExisting: true,
  dailyLimit: 10,
  nativeSurfaces: [],
};

function policy(ids: { machineId: string; versionId: string }): WorkflowPolicy {
  return {
    ...input,
    ...ids,
    projectId: "project",
    repository: "alexburlis/omnyo",
    routeVersion: 1,
    repairRoutes: [],
    createdAt: "2026-11-17T00:00:00Z",
  };
}

function fixture() {
  const f = setup();
  fixtures.push(f);
  const handlers = createStateMachineRpcHandlers(f.service, { listEnvironments: async () => [] });
  let loseResponse: string | null = null;
  let invalidEnvelope = false;

  const host = createFakePluginHost({
    pluginId: "sentry",
    sdk: {
      environments: {
        get: () => ({
          id: input.environmentId,
          projectId: "project",
          managed: false,
          lifecycle: { phase: "active", retireAt: null },
        }),
      },
      plugins: {
        callRpc: async (request) => {
          if (invalidEnvelope) return { ok: "incorrect" };

          const result = await (() => {
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
          })();

          if (loseResponse === request.method) {
            loseResponse = null;
            throw new Error("Response was lost after acceptance");
          }

          return result;
        },
      },
    },
  });

  hosts.push(host);
  const machine = new WorkflowMachine(host.api);

  return {
    ...f,
    machine,
    loseNext: (method: string) => {
      loseResponse = method;
    },
    invalidate: () => {
      invalidEnvelope = true;
    },
  };
}

async function begin(f: ReturnType<typeof fixture>) {
  const ids = await f.machine.configure(input);

  const { instanceId, homeThreadId } = await f.machine.start(
    policy(ids),
    "run_test",
    "start-run-test",
    "Sentry fix · TEST-1",
  );

  await f.service.tick();

  return { ...ids, instanceId, homeThreadId };
}

async function finish(f: ReturnType<typeof fixture>, outcome: string) {
  const invocation = f.adapter.starts.at(-1);

  if (!invocation) throw new Error("No active invocation");
  f.adapter.settle(invocation, {
    status: "quiescent",
    confirmedLive: false,
    result: { type: "result", outcome, payload: {} },
  });
  f.advance(1000);
  await f.service.tick();
  await f.service.tick();
}

describe("State Machines-owned Sentry workflow", () => {
  it.each(["proven-defect", "reporting-noise", "already-fixed"])(
    "allows resolution only after the %s branch reaches runtime proof",
    async (classification) => {
      const f = fixture();
      const { instanceId } = await begin(f);

      const outcomes =
        classification === "already-fixed"
          ? [classification, "verified", "resolved"]
          : [
              classification,
              "fixed",
              "verified",
              "approved",
              "published",
              "merged",
              "no-delivery",
              "verified",
              "resolved",
            ];

      for (const outcome of outcomes) await finish(f, outcome);
      expect(await f.machine.inspect(instanceId)).toMatchObject({
        lifecycle: "completed",
        stateId: "resolved",
      });
      expect(
        f.adapter.starts.filter((invocation) => invocation.state.id === "resolve"),
      ).toHaveLength(1);
    },
  );

  it.each(["sm_machine_create", "sm_machine_draft_save", "sm_machine_publish"])(
    "recovers a lost %s response without duplicating machines or immutable versions",
    async (method) => {
      const f = fixture();
      f.loseNext(method);
      await expect(f.machine.configure(input)).rejects.toThrow("Response was lost");
      const ids = await f.machine.configure(input);
      expect(f.service.listMachines()).toHaveLength(1);
      expect(f.service.listVersions({ machineId: ids.machineId })).toHaveLength(1);
      expect(await f.machine.configure(input, policy(ids))).toEqual(ids);
    },
  );

  it("validates the real graph, pins starts to its version, and enforces control revisions", async () => {
    const f = fixture();
    const started = await begin(f);
    expect(f.service.validateDraft({ machineId: started.machineId }).valid).toBe(true);
    expect(workflowOperationSchema.options.toSorted()).toEqual(
      sentryWorkflowOperationSchema.options.toSorted(),
    );
    expect(
      await f.machine.start(policy(started), "run_test", "start-run-test", "Sentry fix · TEST-1"),
    ).toEqual({ instanceId: started.instanceId, homeThreadId: started.homeThreadId });
    expect(started.homeThreadId).toBe("home-1");
    expect(f.service.listInstances({ machineId: started.machineId })).toHaveLength(1);
    const before = await f.machine.inspect(started.instanceId);
    expect(before).toMatchObject({
      machineId: started.machineId,
      versionId: started.versionId,
      stateId: "investigate",
      steps: [{ stateId: "investigate", status: "running" }],
    });

    const paused = await f.machine.control(
      started.instanceId,
      before.controlRevision,
      "pause",
      "pause-test",
    );

    expect(paused.lifecycle).toBe("paused");
    await expect(
      f.machine.control(started.instanceId, before.controlRevision, "resume", "resume-stale"),
    ).rejects.toThrow("REVISION_CONFLICT");
  });

  it("preserves independent draft edits when another version is requested", async () => {
    const f = fixture();
    const ids = await f.machine.configure(input);
    const current = f.service.getDraft({ machineId: ids.machineId });
    f.service.saveDraft({
      machineId: ids.machineId,
      expectedRevision: current.revision,
      document: { ...current.document, description: "Another owner's edit" },
      requestId: "foreign-edit",
    });
    await expect(
      f.machine.configure({ ...input, environmentId: "new-environment" }, policy(ids)),
    ).rejects.toThrow("REVISION_CONFLICT");
    expect(f.service.getDraft({ machineId: ids.machineId }).document.description).toBe(
      "Another owner's edit",
    );
  });

  it("rejects malformed response envelopes instead of inventing successful state", async () => {
    const f = fixture();
    f.invalidate();
    await expect(f.machine.inspect("ins_unknown")).rejects.toThrow();
  });

  it("never closes an issue after a diagnostics-only repair, even if verification returns verified", async () => {
    const f = fixture();
    const { instanceId } = await begin(f);

    for (const outcome of [
      "needs-diagnostics",
      "fixed",
      "verified",
      "approved",
      "published",
      "merged",
      "no-delivery",
      "verified",
    ])
      await finish(f, outcome);
    expect((await f.machine.inspect(instanceId)).stateId).toBe("defer");
    expect(f.adapter.starts.some((invocation) => invocation.state.id === "resolve")).toBe(false);
    await finish(f, "recorded");
    expect(await f.machine.inspect(instanceId)).toMatchObject({
      lifecycle: "completed",
      stateId: "open-with-reason",
    });
  });

  it("waits for publication without running a model, then resumes the same operation", async () => {
    const f = fixture();
    const { instanceId } = await begin(f);

    for (const outcome of [
      "proven-defect",
      "fixed",
      "verified",
      "approved",
      "published",
      "pending",
    ])
      await finish(f, outcome);
    const count = f.adapter.starts.length;
    expect((await f.machine.inspect(instanceId)).stateId).toBe("wait-checks");
    f.advance(59000);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(count);
    f.advance(1000);
    await f.service.tick();
    expect(f.adapter.starts.at(-1)?.state.id).toBe("merge");
  });

  it.each([
    ["release", "release"],
    ["later", "wait-delivery"],
  ] as const)(
    "asks the owner before any release of a merged runtime repair (%s)",
    async (decision, next) => {
      const f = fixture();
      const { instanceId } = await begin(f);

      for (const outcome of [
        "proven-defect",
        "fixed",
        "verified",
        "approved",
        "published",
        "merged",
        "release-required",
      ])
        await finish(f, outcome);
      expect((await f.machine.inspect(instanceId)).stateId).toBe("approve-release");

      const [gate] = f.service.listAttention({ instanceId });

      if (!gate) throw new Error("No release gate");
      expect(gate.decisions.map((item) => item.name)).toEqual(["release", "later"]);
      const count = f.adapter.starts.length;

      await f.service.resolveAttention({
        instanceId,
        attentionId: gate.attentionId,
        entryId: gate.entryId,
        expectedRevision: gate.revision,
        decision,
        evidence: "",
        requestId: "owner-" + decision,
      });
      await f.service.tick();

      if (next === "release") {
        expect(f.adapter.starts.at(-1)?.state.id).toBe("release");
        await finish(f, "released");
      } else expect(f.adapter.starts).toHaveLength(count);

      expect((await f.machine.inspect(instanceId)).stateId).toBe("wait-delivery");
      f.advance(60000);
      await f.service.tick();
      expect(f.adapter.starts.at(-1)?.state.id).toBe("deliver");
      expect(f.adapter.starts.filter((item) => item.state.id === "release")).toHaveLength(
        decision === "release" ? 1 : 0,
      );
    },
  );

  it("returns to the owner when the approved release fails before offering the fix", async () => {
    const f = fixture();
    const { instanceId } = await begin(f);

    for (const outcome of [
      "proven-defect",
      "fixed",
      "verified",
      "approved",
      "published",
      "merged",
      "release-required",
    ])
      await finish(f, outcome);
    const [gate] = f.service.listAttention({ instanceId });

    if (!gate) throw new Error("No release gate");
    await f.service.resolveAttention({
      instanceId,
      attentionId: gate.attentionId,
      entryId: gate.entryId,
      expectedRevision: gate.revision,
      decision: "release",
      evidence: "",
      requestId: "owner-release",
    });
    await f.service.tick();
    await finish(f, "release-required");
    expect((await f.machine.inspect(instanceId)).stateId).toBe("approve-release");
    const [again] = f.service.listAttention({ instanceId });

    if (!again) throw new Error("No release gate after the unconfirmed request");
    await f.service.resolveAttention({
      instanceId,
      attentionId: again.attentionId,
      entryId: again.entryId,
      expectedRevision: again.revision,
      decision: "release",
      evidence: "",
      requestId: "owner-release-again",
    });
    await f.service.tick();
    await finish(f, "released");
    f.advance(60000);
    await f.service.tick();
    await finish(f, "release-required");
    expect((await f.machine.inspect(instanceId)).stateId).toBe("approve-release");
    expect(f.service.listAttention({ instanceId })[0]?.decisions.map((item) => item.name)).toEqual([
      "release",
      "later",
    ]);
  });

  it("limits root-cause repair to two passes and holds uncertain outcomes without replay", async () => {
    const f = fixture();
    const { instanceId } = await begin(f);

    for (const outcome of [
      "proven-defect",
      "fixed",
      "verified",
      "changes-required",
      "fixed",
      "verified",
      "changes-required",
    ])
      await finish(f, outcome);
    expect((await f.machine.inspect(instanceId)).stateId).toBe("blocked");
    expect(f.adapter.starts.filter((invocation) => invocation.state.id === "repair")).toHaveLength(
      2,
    );

    const second = fixture();
    const active = await begin(second);
    const invocation = second.adapter.starts[0];

    if (!invocation) throw new Error("No active invocation");
    second.adapter.settle(invocation, {
      status: "uncertain",
      confirmedLive: false,
      reason: "The worker submission response was lost",
    });
    second.advance(1000);
    await second.service.tick();
    second.advance(60000);
    await second.service.tick();
    expect(second.adapter.starts).toHaveLength(1);
    expect(await second.machine.inspect(active.instanceId)).toMatchObject({
      phase: "uncertain",
      stateId: "investigate",
    });
  });
});

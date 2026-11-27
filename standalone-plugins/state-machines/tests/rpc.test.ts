import { afterEach, describe, expect, test } from "vitest";
import { z } from "zod";
import { stateMachinesRpc } from "../src/contracts/rpc.js";
import { createStateMachineRpcHandlers } from "../src/rpc.js";
import { createLocalCheckLoop, createReleaseLoopDraft } from "../templates/index.js";
import { setup, publish, signal, agentGraph } from "./runtime-fixtures.js";

const fixtures: ReturnType<typeof setup>[] = [];

function fixture() {
  const f = setup();
  fixtures.push(f);

  const handlers = createStateMachineRpcHandlers(f.service, {
    listEnvironments: async () => [
      {
        environmentId: "env_test",
        label: "Test workspace",
        hostId: "host_test",
        available: true,
        persistent: true,
      },
    ],
  });

  return { ...f, handlers };
}

afterEach(() => {
  for (const f of fixtures.splice(0)) f.database.close();
});

describe("public RPC boundary", () => {
  test("projects an owned worker question as agent input without granting a decision", async () => {
    const f = fixture();
    const { instance } = await publish(f, agentGraph);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.adapter.observations.set(invocation.attemptId, {
      status: "running",
      confirmedLive: true,
      threadId: `thread-${invocation.attemptId}`,
      waitingForPerson: {
        threadId: `thread-${invocation.attemptId}`,
        interactionId: "owned-question",
      },
    });
    f.advance();
    await f.service.tick();

    const attention = await f.handlers.sm_attention_list({
      machineId: null,
      instanceId: instance.instanceId,
    });

    const parsed = stateMachinesRpc.sm_attention_list.output.parse(attention);

    if (!parsed.ok) throw new Error(parsed.error.message);
    const question = parsed.value.find((item) => item.kind === "agent-input");
    expect(question).toEqual(
      expect.objectContaining({
        invocationId: invocation.invocationId,
        kind: "agent-input",
        decisions: [],
      }),
    );
    expect(
      f.service.inspectInstance({ instanceId: instance.instanceId }).steps[0]?.confirmedLive,
    ).toBe(true);
  });

  test("publishes representable JSON schemas for every discoverable RPC boundary", () => {
    for (const method of Object.values(stateMachinesRpc)) {
      for (const io of ["input", "output"] as const) {
        expect(() => z.toJSONSchema(method.input, { io })).not.toThrow();
        expect(() => z.toJSONSchema(method.output, { io })).not.toThrow();
      }
    }
  });

  test("accepts a replay of an older draft save with unset agent permissions", async () => {
    const f = fixture();

    const { machineId } = f.service.createMachine({
      projectId: "project",
      name: "Release fixture",
      requestId: "create-release",
    });

    const draft = createReleaseLoopDraft({ machineId });

    const request = {
      machineId,
      expectedRevision: 0,
      requestId: "save-release",
      document: {
        ...draft,
        states: draft.states.map((state) =>
          state.kind === "agent"
            ? { ...state, action: { ...state.action, permissionMode: null } }
            : state,
        ),
      },
    };

    f.service.saveDraft(request);

    const replay = await f.handlers.sm_machine_draft_save(
      stateMachinesRpc.sm_machine_draft_save.input.parse(request),
    );

    expect(replay).toMatchObject({
      ok: true,
      value: {
        draftRevision: 1,
        document: {
          states: expect.arrayContaining([
            expect.objectContaining({
              kind: "agent",
              action: expect.objectContaining({ permissionMode: "full" }),
            }),
          ]),
        },
      },
    });
  });

  test("publishes a draft and returns strict frontend projections bound to the saved version", async () => {
    const f = fixture();

    const created = await f.handlers.sm_machine_create({
      projectId: "project",
      name: "Loop",
      description: "A local check",
      template: "blank",
      requestId: "create",
    });

    expect(created.ok).toBe(true);

    if (!created.ok) throw new Error(created.error.message);
    const { machineId } = created.value;

    const saved = await f.handlers.sm_machine_draft_save({
      machineId,
      expectedRevision: 0,
      requestId: "save",
      document: createLocalCheckLoop({ machineId, environmentId: "environment" }),
    });

    expect(stateMachinesRpc.sm_machine_draft_save.output.parse(saved).ok).toBe(true);

    const published = await f.handlers.sm_machine_publish({
      machineId,
      expectedRevision: 1,
      note: "Verified local directory check",
      requestId: "publish",
    });

    if (!published.ok) throw new Error(published.error.message);

    const version = await f.handlers.sm_machine_version_get({
      machineId,
      versionId: published.value.versionId,
    });

    if (!version.ok) throw new Error(version.error.message);
    expect(stateMachinesRpc.sm_machine_version_get.output.parse(version)).toEqual(version);
    expect(version.value.note).toBe("Verified local directory check");
    expect(version.value.instanceCount).toBe(0);
    expect(version.value.definition.machineId).toBe(machineId);

    const started = await f.handlers.sm_instance_start({
      machineId,
      versionId: published.value.versionId,
      environmentId: "environment",
      context: {},
      requestId: "start",
    });

    if (!started.ok) throw new Error(started.error.message);
    const instance = await f.handlers.sm_instance_inspect({ instanceId: started.value.instanceId });

    if (!instance.ok) throw new Error(instance.error.message);
    expect(stateMachinesRpc.sm_instance_inspect.output.parse(instance)).toEqual(instance);
    expect(instance.value.definition).toEqual(version.value.definition);
    expect(instance.value.machineName).toBe("Local check loop");
    expect(instance.value.steps).toEqual([]);
    const versions = await f.handlers.sm_machine_versions({ machineId });

    if (!versions.ok) throw new Error(versions.error.message);
    expect(versions.value[0]?.instanceCount).toBe(1);
    expect(f.adapter.starts).toHaveLength(0);
  });

  test("returns field issues and revision conflicts without overwriting a draft", async () => {
    const f = fixture();

    const created = await f.handlers.sm_machine_create({
      projectId: "project",
      name: "Draft",
      description: "",
      template: "blank",
      requestId: "create",
    });

    if (!created.ok) throw new Error(created.error.message);
    const { machineId } = created.value;

    const rejected = await f.handlers.sm_machine_publish({
      machineId,
      expectedRevision: 0,
      note: "",
      requestId: "publish",
    });

    expect(rejected).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "VALIDATION_FAILED",
          issues: expect.arrayContaining([expect.objectContaining({ path: "/initialStateId" })]),
        }),
      }),
    );

    const stale = await f.handlers.sm_machine_draft_save({
      machineId,
      expectedRevision: 99,
      document: createLocalCheckLoop({ machineId, environmentId: "environment" }),
      requestId: "stale",
    });

    expect(stale).toEqual({
      ok: false,
      error: { code: "REVISION_CONFLICT", message: "The draft changed. Reload the latest draft." },
    });
    const untouched = await f.handlers.sm_machine_draft_get({ machineId });

    if (!untouched.ok) throw new Error(untouched.error.message);
    expect(untouched.value.draftRevision).toBe(0);
    expect(untouched.value.document.states).toHaveLength(0);
  });

  test("uses correlated event receipts and supplies durable visits plus honestly labelled history", async () => {
    const f = fixture();

    const machine = f.service.createMachine({
      projectId: "project",
      name: "Loop",
      template: "local-check-loop",
      environmentId: "environment",
      requestId: "create",
    });

    const version = f.service.publishVersion({
      machineId: machine.machineId,
      expectedRevision: 0,
      requestId: "publish",
    });

    const instance = await f.service.startInstance({
      machineId: machine.machineId,
      versionId: version.versionId,
      environmentId: "environment",
      home: { kind: "none" },
      requestId: "start",
    });

    const events = await f.handlers.sm_events_catalog({ instanceId: instance.instanceId });

    if (!events.ok) throw new Error(events.error.message);
    const subscription = events.value.find((entry) => entry.eventType === "check.requested");

    if (!subscription?.subscriptionId || !subscription.epoch)
      throw new Error("Subscription missing");

    const input = {
      instanceId: instance.instanceId,
      entryId: instance.entryId,
      subscriptionId: subscription.subscriptionId,
      epoch: subscription.epoch,
      eventType: "check.requested",
      payload: {},
      requestId: "signal",
      sourceId: "cli",
      eventId: "event-1",
      subject: "workspace",
    };

    const signal = await f.handlers.sm_instance_signal(input);
    expect(await f.handlers.sm_instance_signal(input)).toEqual(signal);
    await f.service.tick();
    const inspected = await f.handlers.sm_instance_inspect({ instanceId: instance.instanceId });

    if (!inspected.ok) throw new Error(inspected.error.message);
    expect(stateMachinesRpc.sm_instance_inspect.output.parse(inspected)).toEqual(inspected);
    expect(inspected.value.steps[0]?.entryId).toBe(inspected.value.entryId);

    const history = await f.handlers.sm_history_list({
      instanceId: instance.instanceId,
      before: null,
      limit: 100,
      kinds: ["control", "transition"],
    });

    if (!history.ok) throw new Error(history.error.message);
    expect(stateMachinesRpc.sm_history_list.output.parse(history)).toEqual(history);
    expect(history.value.entries.find((entry) => entry.text === "Instance started")?.actor).toEqual(
      { kind: "client" },
    );
    expect(history.value.entries.some((entry) => entry.kind === "transition")).toBe(true);

    const visits = await f.handlers.sm_state_history({
      instanceId: instance.instanceId,
      stateId: "waiting",
      before: null,
      limit: 100,
    });

    if (!visits.ok) throw new Error(visits.error.message);
    expect(stateMachinesRpc.sm_state_history.output.parse(visits)).toEqual(visits);
    expect(visits.value.visits[0]).toEqual(
      expect.objectContaining({
        entryId: instance.entryId,
        exitTrigger: "check.requested",
        attempts: 0,
      }),
    );
    expect(visits.value.retainedSince).not.toBeNull();
  });

  test("rejects caller-supplied authority fields and cross-machine version references", async () => {
    const f = fixture();

    const machine = f.service.createMachine({
      projectId: "project",
      name: "Loop",
      template: "local-check-loop",
      environmentId: "environment",
      requestId: "create",
    });

    const version = f.service.publishVersion({
      machineId: machine.machineId,
      expectedRevision: 0,
      requestId: "publish",
    });

    const other = f.service.createMachine({
      projectId: "project",
      name: "Other",
      requestId: "other",
    });

    expect(
      await f.handlers.sm_machine_version_get({
        machineId: other.machineId,
        versionId: version.versionId,
      }),
    ).toEqual({
      ok: false,
      error: { code: "SCOPE_MISMATCH", message: "The version belongs to a different machine." },
    });
    expect(() =>
      stateMachinesRpc.sm_instance_signal.input.parse({
        instanceId: "ins",
        entryId: "entry",
        subscriptionId: "sub",
        epoch: 1,
        eventType: "person.promote",
        payload: {},
        requestId: "req",
        actor: "human",
        approved: true,
      }),
    ).toThrow();
    expect(() =>
      stateMachinesRpc.sm_instance_control.input.parse({
        instanceId: "ins",
        expectedControlRevision: 0,
        operation: {
          kind: "mark-unknown",
          invocationId: "inv",
          entryId: "entry",
          expectedRevision: 0,
          evidence: "Checked",
          acknowledged: false,
        },
        requestId: "req",
      }),
    ).toThrow();
  });
});

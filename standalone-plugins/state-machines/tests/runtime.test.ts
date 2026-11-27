import { afterEach, describe, expect, test } from "vitest";
import { createStateMachineService } from "../src/service.js";
import { parseDraft } from "../src/definition/draft.js";
import { setup, publish, signal, agentGraph } from "./runtime-fixtures.js";

const fixtures: ReturnType<typeof setup>[] = [];

function fixture() {
  const result = setup();
  fixtures.push(result);

  return result;
}

afterEach(() => {
  for (const value of fixtures.splice(0)) value.database.close();
});

describe("durable execution boundary", () => {
  test("pins versions, deduplicates accepted input and dispatches only once after a committed transition", async () => {
    const f = fixture();
    const { instance, machine, version } = await publish(f);
    const receipt = signal(f.service, instance.instanceId);
    expect(signal(f.service, instance.instanceId)).toEqual(receipt);
    expect(f.adapter.starts).toHaveLength(0);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(1);
    const active = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(active.versionId).toBe(version.versionId);
    expect(active.steps[0]?.status).toBe("running");
    expect(() => signal(f.service, instance.instanceId)).toThrow();
    const draft = f.service.getDraft({ machineId: machine.machineId });
    f.service.saveDraft({
      machineId: machine.machineId,
      expectedRevision: draft.revision,
      document: { ...parseDraft(draft.document), name: "Next version" },
      requestId: "save-again",
    });
    f.service.publishVersion({
      machineId: machine.machineId,
      expectedRevision: 2,
      requestId: "publish-again",
    });
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).versionId).toBe(
      version.versionId,
    );
    f.adapter.settle(f.adapter.starts[0]!);
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
      instance.stateId,
    );
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).cyclesCompleted).toBe(1);
  });

  test("structured result is provisional until exact worker quiescence, including pause after step", async () => {
    const f = fixture();
    const { instance } = await publish(f, agentGraph);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    const before = f.service.inspectInstance({ instanceId: instance.instanceId });
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: before.controlRevision,
      operation: "pause-after-step",
      requestId: "drain",
    });

    const resultInput = {
      instanceId: invocation.instanceId,
      entryId: invocation.entryId,
      invocationId: invocation.invocationId,
      attemptId: invocation.attemptId,
      generation: invocation.generation,
      result: { outcome: "done", payload: {} },
    };

    expect(() =>
      f.service.submitResult(resultInput, { kind: "worker", threadId: "other" }),
    ).toThrow();
    f.service.submitResult(resultInput, {
      kind: "worker",
      threadId: `thread-${invocation.attemptId}`,
    });
    expect(
      f.service.submitResult(resultInput, {
        kind: "worker",
        threadId: `thread-${invocation.attemptId}`,
      }).status,
    ).toBe("result-ready");
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).entryId).toBe(
      invocation.entryId,
    );
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).steps[0]?.status).toBe(
      "result-ready",
    );
    f.adapter.settle(invocation, { status: "quiescent", confirmedLive: false });
    f.advance();
    await f.service.tick();
    const paused = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(paused.lifecycle).toBe("paused");
    expect(paused.stateId).toBe(instance.stateId);
    expect(f.adapter.starts).toHaveLength(1);
  });

  test("a timed-out live worker holds admission and cannot be marked stopped", async () => {
    const f = fixture();
    const { instance } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.advance(1_000_000);
    await f.service.tick();
    expect(f.adapter.cancellations).toContain(invocation.attemptId);
    let view = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(view.entryId).toBe(invocation.entryId);
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: view.controlRevision,
      operation: "stop",
      requestId: "stop",
    });
    view = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(view.lifecycle).toBe("stopping");
    expect(() =>
      f.service.controlInstance({
        instanceId: instance.instanceId,
        expectedControlRevision: view.controlRevision,
        operation: "mark-unknown",
        requestId: "unknown",
        invocationId: invocation.invocationId,
        entryId: invocation.entryId,
        expectedRevision: view.revision,
        acknowledged: true,
        reason: "Cannot inspect",
        evidence: "Evidence",
      }),
    ).toThrow("confirmed running");
    f.adapter.settle(invocation, { status: "quiescent", confirmedLive: false });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).lifecycle).toBe(
      "stopped",
    );
  });

  test("manual decision evidence and control CAS prevent stale mutation and do not create effect authority", async () => {
    const f = fixture();
    f.adapter.authorization = { allowed: false, reference: "", scope: "" };

    const { instance } = await publish(f, (definition) => ({
      ...definition,
      states: definition.states.map((state) =>
        state.kind === "command" ? { ...state, effect: "external-write" } : state,
      ),
    }));

    signal(f.service, instance.instanceId);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(0);
    expect(f.service.listAttention({ instanceId: instance.instanceId })[0]?.kind).toBe(
      "authority-required",
    );
    const view = f.service.inspectInstance({ instanceId: instance.instanceId });

    const pause = {
      instanceId: instance.instanceId,
      expectedControlRevision: view.controlRevision,
      operation: "pause" as const,
      requestId: "pause",
    };

    const paused = f.service.controlInstance(pause);
    expect(f.service.controlInstance(pause)).toEqual(paused);
    expect(() => f.service.controlInstance({ ...pause, requestId: "stale" })).toThrow(
      "controls changed",
    );
    expect(f.adapter.starts).toHaveLength(0);
  });

  test("expired inputs, conflicting events and pending backpressure fail before acceptance", async () => {
    const f = fixture();
    const { instance } = await publish(f);
    const current = f.service.eventCatalog({ instanceId: instance.instanceId })[0]!;

    const input = {
      instanceId: instance.instanceId,
      entryId: instance.entryId,
      subscriptionId: current.subscriptionId,
      epoch: current.epoch,
      sourceId: "test",
      eventId: "same",
      subject: "fixture",
      type: current.eventType,
      payload: {},
    };

    f.service.signalInstance(input);
    expect(() => f.service.signalInstance({ ...input, payload: { changed: true } })).toThrow(
      "different content",
    );
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: 0,
      operation: "pause",
      requestId: "pause",
    });

    for (let n = 1; n < 1000; n++) f.service.signalInstance({ ...input, eventId: String(n) });
    expect(() => f.service.signalInstance({ ...input, eventId: "overflow" })).toThrow(
      "queue is full",
    );
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).pendingResultCount).toBe(
      1000,
    );
  });
});

test("manual evidence records a choice and routes only its exact current visit", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    f.adapter.settle(f.adapter.starts[0]!, {
      status: "quiescent",
      confirmedLive: false,
      result: { type: "failed", payload: {} },
    });
    f.advance();
    await f.service.tick();
    const view = f.service.inspectInstance({ instanceId: instance.instanceId });
    const attention = f.service.listAttention({ instanceId: instance.instanceId })[0]!;

    const decision = {
      instanceId: instance.instanceId,
      attentionId: attention.attentionId,
      entryId: view.entryId,
      expectedRevision: view.revision,
      decision: "resume-waiting",
      evidence: "",
      requestId: "decision",
    };

    await expect(f.service.resolveAttention(decision)).rejects.toThrow("evidence");
    await f.service.resolveAttention({
      ...decision,
      evidence: "Exact previous invocation is quiescent.",
    });
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
      instance.stateId,
    );

    const history = f.service.listStateHistory({
      instanceId: instance.instanceId,
      stateId: "check",
    });

    expect(history.items[0]).toMatchObject({ attempts: 1, exitTrigger: "failed" });
  } finally {
    f.database.close();
  }
});

test("safe retry uses finite backoff and a fresh attempt after verified quiescence", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => ({
      ...d,
      states: d.states.map((s) =>
        s.kind === "command"
          ? { ...s, maxAttempts: 3, action: { ...s.action, retrySafety: "adapter-verified" } }
          : s,
      ),
    }));

    signal(f.service, instance.instanceId);
    await f.service.tick();
    const first = f.adapter.starts[0]!;
    f.adapter.settle(first, {
      status: "quiescent",
      confirmedLive: false,
      retrySafe: true,
      result: { type: "failed", payload: {} },
    });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).phase).toBe("retry-wait");
    expect(f.adapter.starts).toHaveLength(1);
    f.advance(4999);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(1);
    f.advance(1);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(2);
    expect(f.adapter.starts[1]?.attemptId).not.toBe(first.attemptId);
  } finally {
    f.database.close();
  }
});

test("repair rounds share an exact source budget across state visits", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => {
      const a = agentGraph(d);

      return {
        ...a,
        contextSchema: {
          type: "object",
          properties: { sourceSha: { type: "string" } },
          required: ["sourceSha"],
          additionalProperties: false,
        },
        initialContext: { sourceSha: "a".repeat(40) },
        transitions: [
          ...a.transitions,
          {
            id: "tr_repair_budget",
            from: "check",
            to: "needs-person",
            trigger: { kind: "budget-exhausted" },
            guard: null,
            contextPatch: [],
            priority: 9,
          },
        ],
      };
    });

    for (let n = 0; n < 2; n++) {
      signal(f.service, instance.instanceId, String(n));
      await f.service.tick();
      const invocation = f.adapter.starts.at(-1)!;
      f.service.submitResult(
        {
          instanceId: instance.instanceId,
          entryId: invocation.entryId,
          invocationId: invocation.invocationId,
          attemptId: invocation.attemptId,
          generation: invocation.generation,
          result: { outcome: "done", payload: {} },
        },
        { kind: "worker", threadId: `thread-${invocation.attemptId}` },
      );
      f.adapter.settle(invocation, { status: "quiescent", confirmedLive: false });
      f.advance(30001);
      await f.service.tick();
    }

    signal(f.service, instance.instanceId, "third");
    await f.service.tick();
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(2);
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
      "needs-person",
    );
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).budgets[0]).toMatchObject(
      { used: 2, limit: 2, subject: "a".repeat(40) },
    );
  } finally {
    f.database.close();
  }
});

test("event filters reject before acceptance and conflicting accepted IDs retain their original error", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => ({
      ...d,
      states: d.states.map((s) =>
        s.kind === "wait"
          ? {
              ...s,
              triggers: s.triggers.map((t) =>
                t.kind === "event" ? { ...t, filter: { branch: "main" } } : t,
              ),
            }
          : s,
      ),
    }));

    const sub = f.service
      .eventCatalog({ instanceId: instance.instanceId })
      .find((e) => e.eventType === "check.requested")!;

    const event = {
      instanceId: instance.instanceId,
      entryId: instance.entryId,
      subscriptionId: sub.subscriptionId,
      epoch: sub.epoch,
      sourceId: "source",
      eventId: "filtered",
      subject: "commit",
      type: sub.eventType,
      payload: { branch: "other" },
    };

    expect(() => f.service.signalInstance(event)).toThrow("does not match");
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).pendingResultCount).toBe(
      0,
    );
    f.service.signalInstance({ ...event, payload: { branch: "main" } });
    expect(() => f.service.signalInstance(event)).toThrow("different content");
  } finally {
    f.database.close();
  }
});

test("a result received after its coordinator deadline cancels immediately and never advances as success", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, agentGraph);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.advance(31000);
    f.service.submitResult(
      {
        instanceId: instance.instanceId,
        entryId: invocation.entryId,
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        generation: invocation.generation,
        result: { outcome: "done", payload: {} },
      },
      { kind: "worker", threadId: `thread-${invocation.attemptId}` },
    );
    await f.service.tick();
    expect(f.adapter.cancellations).toContain(invocation.attemptId);
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).entryId).toBe(
      invocation.entryId,
    );
    f.adapter.settle(invocation, { status: "quiescent", confirmedLive: false });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
      "needs-person",
    );
  } finally {
    f.database.close();
  }
});

test("unmatched cancellation enters attention instead of leaving an executing terminal step", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => {
      const removed = new Set(
        d.transitions.filter((e) => e.trigger.kind === "cancelled").map((e) => e.id),
      );

      return {
        ...d,
        transitions: d.transitions.filter((e) => !removed.has(e.id)),
        layout: {
          ...d.layout,
          edgeLabels: Object.fromEntries(
            Object.entries(d.layout.edgeLabels).filter(([edgeId]) => !removed.has(edgeId)),
          ),
        },
      };
    });

    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: 0,
      operation: "cancel-step",
      entryId: invocation.entryId,
      invocationId: invocation.invocationId,
      requestId: "cancel",
    });
    f.adapter.settle(invocation, {
      status: "quiescent",
      confirmedLive: false,
      result: { type: "cancelled", payload: {} },
    });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).phase).toBe(
      "needs-person",
    );
    expect(f.service.listAttention({ instanceId: instance.instanceId })[0]?.invocationId).toBe(
      invocation.invocationId,
    );
  } finally {
    f.database.close();
  }
});

test("cancellation intent survives a structured agent result while stopping", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, agentGraph);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: 0,
      operation: "stop",
      requestId: "stop",
    });
    f.service.submitResult(
      {
        instanceId: instance.instanceId,
        entryId: invocation.entryId,
        invocationId: invocation.invocationId,
        attemptId: invocation.attemptId,
        generation: invocation.generation,
        result: { outcome: "done", payload: {} },
      },
      { kind: "worker", threadId: `thread-${invocation.attemptId}` },
    );
    f.advance();
    await f.service.tick();
    expect(f.adapter.cancellations).toContain(invocation.attemptId);
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).steps[0]?.status).toBe(
      "cancel-requested",
    );
    f.adapter.settle(invocation, { status: "quiescent", confirmedLive: false });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).lifecycle).toBe(
      "stopped",
    );
  } finally {
    f.database.close();
  }
});

test("internal timer ingress respects the global pending cap and preserves accepted external work", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => {
      const waiting = d.states.find((s) => s.kind === "wait")!;

      return {
        ...d,
        states: [
          {
            ...waiting,
            triggers: [
              { kind: "event", eventType: "check.requested", filter: {} },
              ...Array.from(
                { length: 31 },
                () =>
                  ({
                    kind: "check",
                    everyMs: 30000,
                  }) satisfies import("../src/contracts/definition.js").WaitTrigger,
              ),
            ],
          },
        ],
        transitions: [],
        layout: { initial: { x: 0, y: 0 }, nodes: {}, edges: {}, edgeLabels: {} },
      };
    });

    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: 0,
      operation: "pause",
      requestId: "pause",
    });

    for (let n = 0; n < 1000; n++) signal(f.service, instance.instanceId, String(n));
    f.advance(31000);
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: 1,
      operation: "resume",
      requestId: "resume",
    });
    await f.service.tick();
    expect(
      f.service.inspectInstance({ instanceId: instance.instanceId }).pendingResultCount,
    ).toBeLessThanOrEqual(1000);

    for (let n = 0; n < 40; n++) {
      f.advance(30001);
      await f.service.tick();
      expect(
        f.service.inspectInstance({ instanceId: instance.instanceId }).pendingResultCount,
      ).toBeLessThanOrEqual(1000);
    }

    expect(f.adapter.starts).toHaveLength(0);
    expect(
      f.database
        .prepare(
          "SELECT COUNT(*) AS count FROM sm_history WHERE instance_id=? AND kind='event' AND json_extract(document,'$.type')='check.requested'",
        )
        .get(instance.instanceId),
    ).toEqual({ count: 1000 });
  } finally {
    f.database.close();
  }
});

test("terminal reconciliation and transition publish the committed final revision", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f);
    const changes: { kind: string; id: string; revision: number; inTransaction: boolean }[] = [];
    f.service = createStateMachineService({
      database: f.database,
      adapter: f.adapter,
      clock: f.time,
      onChange(change) {
        changes.push({ ...change, inTransaction: f.database.inTransaction });
      },
    });
    signal(f.service, instance.instanceId);
    await f.service.tick();
    changes.length = 0;
    f.adapter.settle(f.adapter.starts[0]!);
    f.advance();
    await f.service.tick();
    const final = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(final.stateId).toBe(instance.stateId);
    expect(changes.at(-1)).toEqual({
      kind: "instance",
      id: instance.instanceId,
      revision: final.revision,
      inTransaction: false,
    });
    changes.length = 0;
    f.advance();
    await f.service.tick();
    expect(changes).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("owned agent questions create attention until the exact interaction is answered", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, agentGraph);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    const threadId = `thread-${invocation.attemptId}`;
    f.adapter.settle(invocation, {
      status: "running",
      confirmedLive: true,
      threadId,
      waitingForPerson: { threadId, interactionId: "question-1" },
    });
    f.advance();
    await f.service.tick();
    const waiting = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(waiting.phase).toBe("needs-person");
    expect(waiting.steps[0]).toMatchObject({ threadId, confirmedLive: true, status: "running" });
    const first = f.service.listAttention({ instanceId: instance.instanceId });
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      kind: "agent-input",
      invocationId: invocation.invocationId,
      interactionId: "question-1",
      decisions: [],
    });
    f.advance();
    await f.service.tick();
    expect(f.service.listAttention({ instanceId: instance.instanceId })).toHaveLength(1);
    f.adapter.settle(invocation, {
      status: "running",
      confirmedLive: true,
      threadId,
      waitingForPerson: { threadId, interactionId: "question-2" },
    });
    f.advance();
    await f.service.tick();
    expect(f.service.listAttention({ instanceId: instance.instanceId })).toEqual([
      expect.objectContaining({ interactionId: "question-2" }),
    ]);
    f.adapter.settle(invocation, { status: "running", confirmedLive: true, threadId });
    f.advance();
    await f.service.tick();
    expect(f.service.listAttention({ instanceId: instance.instanceId })).toEqual([]);
    expect(f.service.inspectInstance({ instanceId: instance.instanceId })).toMatchObject({
      phase: "executing",
      entryId: invocation.entryId,
    });
    expect(
      f.database.prepare("SELECT COUNT(*) AS count FROM sm_invocations WHERE owned=1").get(),
    ).toEqual({ count: 1 });
    expect(f.adapter.starts).toHaveLength(1);
  } finally {
    f.database.close();
  }
});

test("clean stop resolves the current manual gate in attention counts and records", async () => {
  const f = fixture();

  const { instance, machine } = await publish(f, (definition) => ({
    ...definition,
    initialStateId: "needs-person",
  }));

  const attention = f.service.listAttention({ instanceId: instance.instanceId })[0]!;
  expect(attention.kind).toBe("gate");
  expect(f.service.countMachineAttention({ machineId: machine.machineId })).toBe(1);

  const stopped = f.service.controlInstance({
    instanceId: instance.instanceId,
    expectedControlRevision: instance.controlRevision,
    operation: "stop",
    requestId: "stop-manual-gate",
  });

  expect(stopped.lifecycle).toBe("stopped");
  expect(f.service.listAttention({ instanceId: instance.instanceId })).toEqual([]);
  expect(f.service.countMachineAttention({ machineId: machine.machineId })).toBe(0);
  expect(
    f.database
      .prepare(
        "SELECT resolved_at, json_extract(document, '$.resolvedAt') AS document_resolved_at FROM sm_attention WHERE id=?",
      )
      .get(attention.attentionId),
  ).toEqual({ resolved_at: f.time(), document_resolved_at: f.time() });
  expect(
    f.service
      .listHistory({ instanceId: instance.instanceId, limit: 100, kinds: [] })
      .items.some((entry) => entry.kind === "problem"),
  ).toBe(true);
});

test("reload resolves legacy stopped gates and publishes the committed attention revision", async () => {
  const f = fixture();

  const { instance, machine } = await publish(f, (definition) => ({
    ...definition,
    initialStateId: "needs-person",
  }));

  const stored = JSON.parse(
    f.database
      .prepare<[string], { document: string }>("SELECT document FROM sm_instances WHERE id=?")
      .get(instance.instanceId)!.document,
  );

  stored.lifecycle = "stopped";
  stored.phase = null;
  f.database
    .prepare("UPDATE sm_instances SET lifecycle='stopped', document=? WHERE id=?")
    .run(JSON.stringify(stored), instance.instanceId);
  const changes: { kind: string; id: string; revision: number; inTransaction: boolean }[] = [];
  f.service = createStateMachineService({
    database: f.database,
    adapter: f.adapter,
    clock: f.time,
    onChange(change) {
      changes.push({ ...change, inTransaction: f.database.inTransaction });
    },
  });
  const current = f.service.inspectInstance({ instanceId: instance.instanceId });
  expect(f.service.listAttention({ instanceId: instance.instanceId })).toEqual([]);
  expect(f.service.countMachineAttention({ machineId: machine.machineId })).toBe(0);
  expect(changes).toEqual([
    { kind: "instance", id: instance.instanceId, revision: current.revision, inTransaction: false },
  ]);
  expect(current.revision).toBe(stored.revision + 1);
});

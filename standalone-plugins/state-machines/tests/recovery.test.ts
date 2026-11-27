import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { createStateMachineService } from "../src/service.js";
import { publish, setup, signal } from "./runtime-fixtures.js";

test("reopens committed dispatch intent without respawning and fences the replaced dispatcher", async () => {
  const directory = mkdtempSync(join(tmpdir(), "state-machines-recovery-"));
  let database = new Database(join(directory, "runtime.sqlite"));

  try {
    const f = setup(database);
    const { instance, machine, version } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    database.close();
    database = new Database(join(directory, "runtime.sqlite"));
    const reopened = createStateMachineService({ database, adapter: f.adapter, clock: f.time });
    expect(reopened.inspectInstance({ instanceId: instance.instanceId }).entryId).toBe(
      invocation.entryId,
    );
    f.advance();
    await reopened.tick();
    expect(f.adapter.starts).toHaveLength(1);
    f.adapter.settle(invocation);
    f.advance();
    await reopened.tick();
    const recovered = reopened.inspectInstance({ instanceId: instance.instanceId });
    expect(recovered.stateId).toBe(instance.stateId);
    expect(recovered.entryId).not.toBe(instance.entryId);
    expect(
      (
        await reopened.startInstance({
          machineId: machine.machineId,
          versionId: version.versionId,
          environmentId: "environment",
          home: { kind: "none" },
          requestId: "start",
        })
      ).instanceId,
    ).toBe(instance.instanceId);
    const other = createStateMachineService({ database, adapter: f.adapter, clock: f.time });
    expect(() =>
      reopened.controlInstance({
        instanceId: instance.instanceId,
        expectedControlRevision: recovered.controlRevision,
        operation: "pause",
        requestId: "old-owner",
      }),
    ).toThrow("replaced");
    expect(other.inspectInstance({ instanceId: instance.instanceId }).lifecycle).toBe("running");
  } finally {
    database.close();
    rmSync(directory, { recursive: true });
  }
});

test("ambiguous launch retains ownership across recovery and blocks competing work until verified quiescence", async () => {
  const f = setup();

  try {
    const { instance, machine, version } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.adapter.settle(invocation, { status: "not-found", confirmedLive: false });
    f.advance();
    await f.service.tick();
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).phase).toBe("uncertain");

    const recovered = createStateMachineService({
      database: f.database,
      adapter: f.adapter,
      clock: f.time,
    });

    await expect(
      recovered.startInstance({
        machineId: machine.machineId,
        versionId: version.versionId,
        environmentId: "environment",
        home: { kind: "none" },
        requestId: "second-start",
      }),
    ).rejects.toThrow("unresolved invocation");
    f.advance(30_000);
    await recovered.tick();
    expect(f.adapter.starts).toHaveLength(1);
    const view = recovered.inspectInstance({ instanceId: instance.instanceId });
    const attention = recovered.listAttention({ instanceId: instance.instanceId })[0]!;
    await expect(
      recovered.resolveAttention({
        instanceId: instance.instanceId,
        attentionId: attention.attentionId,
        entryId: view.entryId,
        expectedRevision: view.revision,
        decision: "reconcile",
        evidence: "",
        requestId: "still-unknown",
      }),
    ).rejects.toThrow("not been confirmed stopped");
    f.adapter.settle(invocation);
    f.advance(30_000);
    await recovered.tick();
    expect(recovered.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
      instance.stateId,
    );
    expect(f.adapter.starts).toHaveLength(1);
  } finally {
    f.database.close();
  }
});

test("a stopped unknown outcome stays visible and retains its environment claim", async () => {
  const f = setup();

  try {
    const { instance, machine, version } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.adapter.settle(invocation, { status: "uncertain", confirmedLive: false });
    f.advance();
    await f.service.tick();
    const pending = f.service.listAttention({ instanceId: instance.instanceId })[0]!;
    expect(pending.decisions[0]?.evidenceRequired).toBe(false);
    let view = f.service.inspectInstance({ instanceId: instance.instanceId });
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: view.controlRevision,
      operation: "stop",
      requestId: "stop",
    });
    view = f.service.inspectInstance({ instanceId: instance.instanceId });
    f.service.controlInstance({
      instanceId: instance.instanceId,
      expectedControlRevision: view.controlRevision,
      expectedRevision: view.revision,
      operation: "mark-unknown",
      requestId: "ack",
      entryId: invocation.entryId,
      invocationId: invocation.invocationId,
      reason: "Host disappeared",
      evidence: "Recorded exact missing journal",
      acknowledged: true,
    });
    view = f.service.inspectInstance({ instanceId: instance.instanceId });
    expect(view.lifecycle).toBe("stopped");
    expect(view.phase).toBe("uncertain");
    expect(view.unknownOutcomes).toEqual([
      { invocationId: invocation.invocationId, blocksRestartIn: "environment" },
    ]);
    await expect(
      f.service.startInstance({
        machineId: machine.machineId,
        versionId: version.versionId,
        environmentId: "environment",
        home: { kind: "none" },
        requestId: "new",
      }),
    ).rejects.toThrow("unresolved invocation");
  } finally {
    f.database.close();
  }
});

test("corrupt persisted state is quarantined without resetting it or blocking an unrelated instance", async () => {
  const f = setup();

  try {
    const { instance, machine, version } = await publish(f);

    const healthy = await f.service.startInstance({
      machineId: machine.machineId,
      versionId: version.versionId,
      environmentId: "environment",
      home: { kind: "none" },
      requestId: "healthy",
    });

    f.database
      .prepare("UPDATE sm_instances SET document=? WHERE id=?")
      .run("{broken", instance.instanceId);
    signal(f.service, healthy.instanceId);
    await f.service.tick();
    expect(f.adapter.starts).toHaveLength(1);
    expect(f.adapter.starts[0]?.instanceId).toBe(healthy.instanceId);
    expect(() => f.service.inspectInstance({ instanceId: instance.instanceId })).toThrow(
      "quarantined",
    );
    expect(
      f.database.prepare("SELECT document FROM sm_instances WHERE id=?").get(instance.instanceId),
    ).toEqual({ document: "{broken" });
  } finally {
    f.database.close();
  }
});

test("terminal retirement retries durably outside transactions before releasing cleanup references", async () => {
  let attempts = 0;
  let failRetirement = true;
  const f = setup();
  f.adapter.retire = async () => {
    expect(f.database.inTransaction).toBe(false);
    attempts++;

    if (failRetirement) throw new Error("Temporary host loss");
  };

  try {
    const { instance } = await publish(f);
    signal(f.service, instance.instanceId);
    await f.service.tick();
    const invocation = f.adapter.starts[0]!;
    f.adapter.settle(invocation);
    f.advance();
    await f.service.tick();
    f.advance(1000);
    await f.service.tick();
    expect(attempts).toBe(0);
    f.advance(31 * 86400000);
    await f.service.tick();
    expect(attempts).toBe(1);
    expect(
      f.database
        .prepare("SELECT retired FROM sm_invocations WHERE id=?")
        .get(invocation.invocationId),
    ).toEqual({ retired: 0 });

    const recovered = createStateMachineService({
      database: f.database,
      adapter: f.adapter,
      clock: f.time,
    });

    f.advance(1000);
    await recovered.tick();
    expect(attempts).toBe(1);
    failRetirement = false;
    f.advance(30000);
    await recovered.tick();
    expect(attempts).toBe(2);
    expect(
      f.database
        .prepare("SELECT retired FROM sm_invocations WHERE id=?")
        .get(invocation.invocationId),
    ).toEqual({ retired: 1 });
  } finally {
    f.database.close();
  }
});

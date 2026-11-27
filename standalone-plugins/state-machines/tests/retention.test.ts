import { setImmediate } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { createStateMachineService } from "../src/service.js";
import { setup, publish, signal, ControlledAdapter } from "./runtime-fixtures.js";

const count = z.object({ count: z.number() });

function countRows(database: ReturnType<typeof setup>["database"], table: string): number {
  return count.parse(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).count;
}

test("100000 stationary observations stay bounded across restart, epoch rollover and delayed source versions", async () => {
  const adapter = new ControlledAdapter();
  let sourceVersion = 1;
  let changed = false;

  const observer = Object.assign(adapter, {
    observe: async () => ({ value: { latest: changed ? "new" : "same" }, sourceVersion }),
  });

  const f = setup(undefined, observer);

  try {
    const { instance } = await publish(f, (definition) => ({
      ...definition,
      states: [definition.states[0]!],
      transitions: [],
      layout: { initial: { x: 0, y: 0 }, nodes: {}, edges: {}, edgeLabels: {} },
    }));

    const first = f.service
      .eventCatalog({ instanceId: instance.instanceId })
      .find((item) => item.eventType === "check.requested")!;

    for (let n = 0; n < 100000; n++) {
      f.advance(300000);
      await f.service.tick();

      if (n % 1000 === 0) await setImmediate();

      if (n === 49999)
        f.service = createStateMachineService({
          database: f.database,
          adapter: observer,
          clock: f.time,
        });
    }

    const current = f.service
      .eventCatalog({ instanceId: instance.instanceId })
      .find((item) => item.eventType === "check.requested")!;

    expect(current.epoch).toBeGreaterThan(first.epoch);
    expect(countRows(f.database, "sm_history")).toBe(0);
    expect(countRows(f.database, "sm_inbox")).toBe(0);
    expect(countRows(f.database, "sm_subscriptions")).toBe(2);
    expect(() =>
      f.service.signalInstance({
        instanceId: instance.instanceId,
        entryId: instance.entryId,
        subscriptionId: first.subscriptionId,
        epoch: first.epoch,
        sourceId: "late",
        eventId: "old",
        subject: "source",
        type: first.eventType,
        payload: {},
      }),
    ).toThrow("expired");
    sourceVersion = 0;
    changed = true;
    f.advance(300000);
    await f.service.tick();

    const observation = z
      .object({ document: z.string() })
      .parse(
        f.database
          .prepare("SELECT document FROM sm_subscriptions WHERE id!=? LIMIT 1")
          .get(current.subscriptionId),
      );

    expect(JSON.parse(observation.document)).toMatchObject({
      observation: { latest: "same" },
      sourceVersion: 1,
      observationCount: 100001,
    });
    expect(f.adapter.starts).toHaveLength(0);
  } finally {
    f.database.close();
  }
}, 240000);

test("10000 completed cycles compact closed detail while preserving live position, version and restart", async () => {
  const f = setup();
  const retired: string[] = [];
  f.adapter.retire = async (invocation) => {
    retired.push(invocation.attemptId);
  };

  try {
    const { instance, version } = await publish(f);

    for (let cycle = 0; cycle < 10000; cycle++) {
      if (cycle % 100 === 0) await setImmediate();
      signal(f.service, instance.instanceId, `cycle-${cycle}`);
      await f.service.tick();
      const invocation = f.adapter.starts.at(-1)!;
      f.adapter.settle(invocation);
      f.advance(30001);
      await f.service.tick();
      expect(f.service.inspectInstance({ instanceId: instance.instanceId }).stateId).toBe(
        instance.stateId,
      );
    }

    expect(f.adapter.starts).toHaveLength(10000);
    expect(retired.length).toBeGreaterThan(0);
    expect(f.service.inspectInstance({ instanceId: instance.instanceId }).cyclesCompleted).toBe(
      10000,
    );
    expect(countRows(f.database, "sm_history")).toBeLessThanOrEqual(10000);
    expect(countRows(f.database, "sm_entries")).toBeLessThanOrEqual(10000);
    expect(countRows(f.database, "sm_invocations")).toBeLessThanOrEqual(5000);
    expect(f.service.listHistory({ instanceId: instance.instanceId }).checkpoint).not.toBeNull();

    const reopened = createStateMachineService({
      database: f.database,
      adapter: f.adapter,
      clock: f.time,
    });

    const view = reopened.inspectInstance({ instanceId: instance.instanceId });
    expect(view.versionId).toBe(version.versionId);
    expect(view.lifecycle).toBe("running");
    expect(view.stateId).toBe(instance.stateId);
    const old = f.service.listStateHistory({ instanceId: instance.instanceId, after: 0, limit: 1 });
    expect(old.items[0]?.sequence).toBeGreaterThan(1);
  } finally {
    f.database.close();
  }
}, 240000);

test("settled external receipts rotate atomically at1000 signals across dispatcher restart", async () => {
  const f = setup();

  try {
    const { instance } = await publish(f, (d) => ({
      ...d,
      states: [d.states[0]!],
      transitions: [],
      layout: { initial: { x: 0, y: 0 }, nodes: {}, edges: {}, edgeLabels: {} },
    }));

    const first = f.service
      .eventCatalog({ instanceId: instance.instanceId })
      .find((e) => e.eventType === "check.requested")!;

    const firstReceipt = signal(f.service, instance.instanceId, "zero");
    expect(signal(f.service, instance.instanceId, "zero")).toEqual(firstReceipt);
    await f.service.tick();

    for (let n = 1; n < 1000; n++) {
      signal(f.service, instance.instanceId, String(n));
      await f.service.tick();

      if (n === 500)
        f.service = createStateMachineService({
          database: f.database,
          adapter: f.adapter,
          clock: f.time,
        });
    }

    const current = f.service
      .eventCatalog({ instanceId: instance.instanceId })
      .find((e) => e.eventType === "check.requested")!;

    expect(current.epoch).toBe(2);
    expect(countRows(f.database, "sm_inbox")).toBe(0);
    expect(() =>
      f.service.signalInstance({
        instanceId: instance.instanceId,
        entryId: instance.entryId,
        subscriptionId: first.subscriptionId,
        epoch: first.epoch,
        sourceId: "test",
        eventId: "zero",
        subject: "fixture-subject",
        type: first.eventType,
        payload: {},
      }),
    ).toThrow("expired");
  } finally {
    f.database.close();
  }
});

test("recent command logs remain until measured storage pressure retires the oldest settled output", async () => {
  const f = setup();
  const retired: string[] = [];
  let reads = 0;
  f.adapter.readLog = async () => {
    reads++;

    return { text: "Retained log", nextCursor: 12, truncated: false };
  };

  f.adapter.retire = async (invocation) => {
    retired.push(invocation.attemptId);
  };

  try {
    const { instance } = await publish(f);

    for (let n = 0; n < 46; n++) {
      signal(f.service, instance.instanceId, String(n));
      await f.service.tick();
      const invocation = f.adapter.starts.at(-1)!;
      f.adapter.settle(invocation, {
        status: "quiescent",
        confirmedLive: false,
        result: { type: "succeeded", payload: {} },
        retainedBytes: 1024 * 1024,
      });
      f.advance(30001);
      await f.service.tick();

      if (n === 0) expect(retired).toHaveLength(0);
    }

    expect(retired.length).toBeGreaterThan(0);
    expect(retired).toContain(f.adapter.starts[0]!.attemptId);
    expect(retired).not.toContain(f.adapter.starts.at(-1)!.attemptId);
    expect(countRows(f.database, "sm_retirements")).toBeLessThanOrEqual(45);
    await expect(
      f.service.readLog({ invocationId: f.adapter.starts[0]!.invocationId }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "This step's retained log was compacted.",
    });
    expect(reads).toBe(0);
    await expect(
      f.service.readLog({ invocationId: f.adapter.starts.at(-1)!.invocationId }),
    ).resolves.toEqual({ text: "Retained log", nextCursor: 12, truncated: false });
    expect(reads).toBe(1);
  } finally {
    f.database.close();
  }
});

import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { CuaInventory, CuaStopInput, CuaStopResult } from "../cua-contract";
import { runCuaCli } from "../cua-cli";
import { cuaStopHold } from "../cua-policy";
import { createCuaService } from "../cua-service";
import { createCuaStore, CUA_MIGRATIONS } from "../cua-store";

const NOW = Date.parse("2026-11-12T20:00:00.000Z");

const CONFIG = {
  cuaExecutable: "/tools/cua",
  colimaExecutable: "/tools/colima",
  dockerExecutable: "/tools/docker",
  home: "/state/cua",
};

const SANDBOX = {
  name: "owned",
  containerId: "a".repeat(64),
  createdAt: new Date(NOW - 1000).toISOString(),
  processes: [{ pid: 1, startedAt: "Thu Nov 12 19:59:59 2026", executable: "cua-spacesd" }],
};

function inventory(): CuaInventory {
  return {
    config: CONFIG,
    vm: { pid: 123, startedAt: "Thu Nov 12 19:59:59 2026" },
    sandboxes: [SANDBOX],
    containers: [
      { id: SANDBOX.containerId, name: SANDBOX.name, kind: "sandbox", publishedPorts: [3211] },
    ],
    activeClientPorts: [],
    memory: { kind: "footprint", bytes: 22 * 1024 ** 3 },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function world() {
  const fake = createFakePluginHost({ pluginId: "cua-housekeeping-test" });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  const db = fake.api.storage.database();
  fake.api.storage.migrate(db, CUA_MIGRATIONS);
  const store = createCuaStore(db);
  let timestamp = NOW;
  let observation = inventory();
  let status: "finished" | "active" | "unknown" = "active";
  let result: CuaStopResult = { kind: "stopped" };
  let gate: Promise<void> | null = null;
  let reconciliation: "running" | "stopped" | "unknown" = "unknown";
  const calls: CuaStopInput[] = [];

  const host = {
    inspect: async () => observation,
    stop: async (_hostId: string, input: CuaStopInput) => {
      calls.push(input);

      if (gate !== null) await gate;

      return result;
    },
    reconcile: async () => reconciliation,
  };

  const service = createCuaService({
    store,
    host,
    ownerStatus: async () => status,
    now: () => timestamp,
  });

  return {
    service,
    store,
    host,
    calls,
    register: (ownership: "managed" | "observed" = "managed") =>
      service.register({
        hostId: "host_test",
        ownerThreadId: "thr_owner",
        initialConsumerId: "job_one",
        ownership,
        sandboxName: SANDBOX.name,
        idleGraceMs: 60_000,
      }),
    advance: (milliseconds: number) => {
      timestamp += milliseconds;
    },
    observe: (value: CuaInventory) => {
      observation = value;
    },
    owner: (value: typeof status) => {
      status = value;
    },
    outcome: (value: CuaStopResult) => {
      result = value;
    },
    pause: (value: Promise<void>) => {
      gate = value;
    },
    reconcile: (value: typeof reconciliation) => {
      reconciliation = value;
    },
  };
}

function consumer(resourceId: string, id = "job_one", ownerThreadId = "thr_owner") {
  return { resourceId, consumerId: id, ownerThreadId };
}

describe("owned Cua resources", () => {
  it("observes the existing runtime without registering or stopping it", async () => {
    const w = world();
    expect((await w.service.observe({ hostId: "host_test" })).memory).toEqual({
      kind: "footprint",
      bytes: 22 * 1024 ** 3,
    });
    expect((await w.service.list()).resources).toEqual([]);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toEqual([]);
  });

  it("requires a new sandbox and starts management with a consumer", async () => {
    const w = world();
    const resource = await w.register();
    expect(resource.retentionReason).toBe("consumer-active");
    expect(resource.consumers).toHaveLength(1);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(0);
    const older = world();
    older.advance(121_000);
    await expect(older.register()).rejects.toThrow("Older sandboxes remain observed only");
  });

  it("never whitelists a workload already present when management is requested", async () => {
    const w = world();
    const observed = inventory();
    observed.sandboxes = [
      {
        ...SANDBOX,
        processes: [
          ...SANDBOX.processes,
          { pid: 30, startedAt: "Thu Nov 12 19:59:59 2026", executable: "python3" },
        ],
      },
    ];
    w.observe(observed);
    await expect(w.register()).rejects.toThrow("not in a verified bootstrap-only state");
    expect((await w.service.list()).resources).toEqual([]);
    expect(w.calls).toHaveLength(0);
  });

  it("stops once only after the last consumer and its grace period", async () => {
    const w = world();
    const resource = await w.register();
    await w.service.acquire(consumer(resource.id, "job_two", "thr_other"));
    await w.service.release(consumer(resource.id));
    w.advance(61_000);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(0);
    await w.service.release(consumer(resource.id, "job_two", "thr_other"));
    w.advance(59_999);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(0);
    w.advance(1);
    await w.service.sweep({ allowStop: true });
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]?.sandboxes).toEqual([SANDBOX]);
    expect((await w.service.list()).resources[0]?.retentionReason).toBe("stopped");
  });

  it.each(["active", "unknown"] as const)(
    "retains a forgotten consumer when its owner is %s",
    async (status) => {
      const w = world();
      await w.register();
      w.owner(status);
      w.advance(600_000);
      await w.service.sweep({ allowStop: true });
      expect(w.calls).toHaveLength(0);
      expect((await w.service.list()).resources[0]?.consumers).toHaveLength(1);
    },
  );

  it("expires a forgotten consumer only after its owner finishes and waits the grace", async () => {
    const w = world();
    await w.register();
    w.owner("finished");
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(0);
    w.advance(60_000);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(1);
  });

  it("honors disabled automatic stops, observed ownership and an explicit keep", async () => {
    for (const mode of ["disabled", "observed", "kept"]) {
      const w = world();
      const resource = await w.register(mode === "observed" ? "observed" : "managed");
      await w.service.release(consumer(resource.id));

      if (mode === "kept")
        await w.service.keep({ resourceId: resource.id, ownerThreadId: "thr_owner", keep: true });
      w.advance(600_000);
      await w.service.sweep({ allowStop: mode !== "disabled" });
      expect(w.calls).toHaveLength(0);
    }
  });

  it("does not reset the grace period when unkeep is repeated", async () => {
    const w = world();
    const resource = await w.register();
    await w.service.release(consumer(resource.id));
    w.advance(30_000);

    const unchanged = await w.service.keep({
      resourceId: resource.id,
      ownerThreadId: "thr_owner",
      keep: false,
    });

    expect(unchanged.nextStopAt).toBe(NOW + 60_000);
  });

  it("refuses an idempotent acquire when the underlying VM was replaced", async () => {
    const w = world();
    const resource = await w.register();
    w.observe({ ...inventory(), vm: { pid: 124, startedAt: "Thu Nov 12 20:01:00 2026" } });
    await expect(w.service.acquire(consumer(resource.id))).rejects.toThrow("identity changed");
  });

  it.each(["client", "container", "sandbox", "vm", "guest-job"])(
    "holds shutdown for an active or changed %s",
    async (kind) => {
      const w = world();
      const resource = await w.register();
      await w.service.release(consumer(resource.id));
      w.advance(60_000);
      const observation = inventory();

      if (kind === "client") observation.activeClientPorts.push(3211);

      if (kind === "container")
        observation.containers.push({
          id: "b".repeat(64),
          name: "manual",
          kind: "unknown",
          publishedPorts: [],
        });

      if (kind === "sandbox")
        observation.sandboxes.push({ ...SANDBOX, name: "manual", containerId: "b".repeat(64) });

      if (kind === "vm") observation.vm = { pid: 124, startedAt: "Thu Nov 12 20:00:01 2026" };

      if (kind === "guest-job")
        observation.sandboxes = [
          {
            ...SANDBOX,
            processes: [
              ...SANDBOX.processes,
              { pid: 30, startedAt: "Thu Nov 12 20:00:10 2026", executable: "python3" },
            ],
          },
        ];
      w.observe(observation);
      await w.service.sweep({ allowStop: true });
      expect(w.calls).toHaveLength(0);
      expect((await w.service.list()).resources[0]?.retentionReason).toBe("blocked");
    },
  );

  it("does not replay uncertain stops, and reconciliation permits a new attempt", async () => {
    const w = world();
    const resource = await w.register();
    await w.service.release(consumer(resource.id));
    w.advance(60_000);
    w.outcome({ kind: "uncertain", reason: "lost response" });
    await w.service.sweep({ allowStop: true });
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(1);
    expect((await w.service.list()).resources[0]?.retentionReason).toBe("uncertain");
    w.reconcile("running");
    await w.service.reconcile({ resourceId: resource.id, ownerThreadId: "thr_owner" });
    w.outcome({ kind: "stopped" });
    w.advance(60_000);
    await w.service.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(2);
  });

  it("reacquires an owned stopped sandbox after its owner resumes the same preserved container", async () => {
    const w = world();
    const resource = await w.register();
    await w.service.release(consumer(resource.id));
    w.advance(60_000);
    await w.service.sweep({ allowStop: true });
    w.advance(600_000);
    const resumed = inventory();
    resumed.vm = { pid: 124, startedAt: "Thu Nov 12 20:11:00 2026" };
    resumed.sandboxes = [
      {
        ...SANDBOX,
        processes: [{ pid: 22, startedAt: "Thu Nov 12 20:11:00 2026", executable: "cua-spacesd" }],
      },
    ];
    w.observe(resumed);
    const acquired = await w.service.acquire(consumer(resource.id, "resumed_job"));
    expect(acquired.vm).toEqual(resumed.vm);
    expect(acquired.sandbox.containerId).toBe(resource.sandbox.containerId);
    expect(acquired.sandbox.createdAt).toBe(resource.sandbox.createdAt);
    expect(acquired.sandbox.processes).toEqual(resumed.sandboxes[0]?.processes);
    expect(acquired.retentionReason).toBe("consumer-active");
    expect(w.calls).toHaveLength(1);
  });

  it.each(["changed-container", "unknown-outcome", "guest-job", "another-owner"])(
    "does not adopt a resumed resource with %s",
    async (condition) => {
      const w = world();
      const resource = await w.register();
      await w.service.release(consumer(resource.id));
      w.advance(60_000);

      if (condition === "unknown-outcome")
        w.outcome({ kind: "uncertain", reason: "lost response" });
      await w.service.sweep({ allowStop: true });
      const resumed = inventory();
      resumed.vm = { pid: 124, startedAt: "Thu Nov 12 20:01:00 2026" };

      if (condition === "changed-container")
        resumed.sandboxes = [{ ...SANDBOX, containerId: "b".repeat(64) }];

      if (condition === "guest-job")
        resumed.sandboxes = [
          {
            ...SANDBOX,
            processes: [{ pid: 99, startedAt: "Thu Nov 12 20:01:00 2026", executable: "python3" }],
          },
        ];
      w.observe(resumed);
      await expect(
        w.service.acquire(
          consumer(
            resource.id,
            "resumed_job",
            condition === "another-owner" ? "thr_other" : "thr_owner",
          ),
        ),
      ).rejects.toThrow();
      expect(w.calls).toHaveLength(1);
      expect((await w.service.list()).resources[0]?.consumers).toEqual([]);
    },
  );

  it("blocks an acquire racing with shutdown and drains its queue", async () => {
    const w = world();
    const resource = await w.register();
    await w.service.release(consumer(resource.id));
    w.advance(60_000);
    let finish = () => {};

    w.pause(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const stopping = w.service.sweep({ allowStop: true });

    while (w.calls.length === 0) await Promise.resolve();
    const acquiring = w.service.acquire(consumer(resource.id, "racing"));
    finish();
    await stopping;
    await expect(acquiring).rejects.toThrow("stopping, stopped");
    await w.service.settled();
  });

  it("holds interrupted persisted shutdowns after a service restart", async () => {
    const w = world();
    const resource = await w.register();
    w.store.save({
      ...resource,
      consumers: [],
      idleSince: NOW - 60_000,
      transition: { kind: "stopping", requestedAt: NOW },
    });

    const restarted = createCuaService({
      store: w.store,
      host: w.host,
      ownerStatus: async () => "finished",
      now: () => NOW,
    });

    expect((await restarted.list()).resources[0]?.retentionReason).toBe("uncertain");
    await restarted.sweep({ allowStop: true });
    expect(w.calls).toHaveLength(0);
  });
});

describe("Cua runtime command admission", () => {
  it("allows only registered sandbox processes and the provider helper", () => {
    const observed = inventory();
    observed.containers.push({
      id: "f".repeat(64),
      name: "cua-runsc-helper",
      kind: "helper",
      publishedPorts: [],
    });
    expect(
      cuaStopHold(
        {
          config: CONFIG,
          vm: { pid: 123, startedAt: "Thu Nov 12 19:59:59 2026" },
          sandboxes: [SANDBOX],
        },
        observed,
      ),
    ).toBeNull();
  });

  it("reports unmanaged observations through the CLI without creating ownership", async () => {
    const w = world();

    const result = await runCuaCli(w.service, ["observe", "--host", "host_test"], {
      threadId: null,
      defaultHostId: null,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Ownership is not registered");
    expect((await w.service.list()).resources).toEqual([]);
  });

  it("exposes the managed acquire/release lifecycle through JSON CLI results", async () => {
    const w = world();
    const context = { threadId: "thr_owner", defaultHostId: "host_test" };

    const registered = await runCuaCli(
      w.service,
      [
        "register",
        "--sandbox",
        "owned",
        "--consumer",
        "job_one",
        "--managed",
        "--grace-minutes",
        "1",
        "--json",
      ],
      context,
    );

    expect(registered.exitCode).toBe(0);
    const resource = (await w.service.list()).resources[0];
    expect(resource).toBeDefined();

    if (resource === undefined) throw new Error("Expected registered Cua resource.");

    const released = await runCuaCli(
      w.service,
      ["release", "--resource", resource.id, "--consumer", "job_one", "--json"],
      context,
    );

    expect(released.exitCode).toBe(0);
    expect(JSON.parse(released.stdout ?? "{}")).toMatchObject({
      retentionReason: "idle-grace",
      nextStopAt: NOW + 60_000,
    });
  });
});

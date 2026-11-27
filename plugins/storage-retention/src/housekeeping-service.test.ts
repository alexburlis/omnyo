import fs from "node:fs/promises";
import path from "node:path";
import { scratchDirectory } from "./managed-test-fixture.js";
import { afterEach, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
} from "@omnyo/plugin-sdk/testing";
import { createHousekeepingService } from "./housekeeping-service.js";
import { createHousekeepingHost } from "./housekeeping-host.js";
import {
  defaultHousekeepingBudget,
  housekeepingHostContract,
} from "./housekeeping-contract.js";

const directories: string[] = [];

const hosts: ReturnType<typeof createFakePluginHost>[] = [];

const releases: (() => void)[] = [];

const completions: Promise<void>[] = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(completions.splice(0));
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));

  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true });
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  }
});

async function fixture(
  options: {
    lostStartResponse?: boolean;
    gated?: boolean;
    legacyPrune?: boolean;
    lostPruneResponse?: boolean;
  } = {},
) {
  const directory = await scratchDirectory("housekeeping-service-fixture-");

  directories.push(directory);
  let clock = 1000;
  let release = () => {};

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  releases.push(release);

  if (!options.gated) release();
  let finished = () => {};

  const closed = new Promise<void>((resolve) => {
    finished = resolve;
  });

  let started = false;
  let unavailable = false;
  let recoveries = 0;
  let inspections = 0;
  let managed = 0;
  let loseResponse = options.lostStartResponse ?? false;
  const calls: string[] = [];

  const prune: {
    dryRun: boolean | undefined;
    maxItems: number | undefined;
    maxBytes: number | undefined;
  }[] = [];

  const native = createHousekeepingHost({
    dataDir: directory,
    now: () => clock,
    retainWorker: () => {
      let done = () => {};

      const child = new Promise<void>((resolve) => {
        done = resolve;
      });

      completions.push(child);

      return {
        dispose() {
          done();
          finished();
        },
      };
    },
    recoverTemps: async () => {
      recoveries++;
      await gate;

      return [];
    },
    inspectTemps: async () => {
      inspections++;

      return [];
    },
  });

  const host = createFakePluginHost({
    pluginId: "storage-retention",
    experimental_hostEntry: true,
    experimental_callHostRpc: async (call) => {
      calls.push(call.method);

      if (unavailable) throw new Error("The host is temporarily unavailable.");

      switch (call.method) {
        case "housekeepingHostState":
          return native.state();
        case "housekeepingHostStart": {
          if (!started) {
            started = true;
            completions.push(closed);
          }

          const result = await native.start(
            housekeepingHostContract.housekeepingHostStart.input.parse(
              call.input,
            ),
          );

          if (loseResponse) {
            loseResponse = false;
            throw new Error("The launch response was lost.");
          }

          return result;
        }

        case "housekeepingHostRun":
          return native.run(
            housekeepingHostContract.housekeepingHostRun.input.parse(
              call.input,
            ),
          );
        case "housekeepingHostAdapterPreview":
          return native.adapterPreview(
            housekeepingHostContract.housekeepingHostAdapterPreview.input.parse(
              call.input,
            ),
          );
        case "housekeepingHostAdapterAdopt":
          return native.adapterAdopt(
            housekeepingHostContract.housekeepingHostAdapterAdopt.input.parse(
              call.input,
            ),
          );
        case "housekeepingHostAdapterRemove":
          return native.adapterRemove(
            housekeepingHostContract.housekeepingHostAdapterRemove.input.parse(
              call.input,
            ),
          );
        default:
          throw new Error(`Unexpected housekeeping host method ${call.method}`);
      }
    },
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "host_test", status: "connected" }),
        ],
      },
      plugins: {
        experimental_pruneCache: async (input) => {
          prune.push({
            dryRun: input?.dryRun,
            maxItems: input?.maxItems,
            maxBytes: input?.maxBytes,
          });

          if (!input?.dryRun && options.lostPruneResponse)
            throw new Error("The prune response was lost.");

          return {
            dryRun: input?.dryRun ?? false,
            removed: [],
            bytes: 0,
            ...(!options.legacyPrune
              ? {
                  budget: {
                    maxItems: input?.maxItems ?? null,
                    maxBytes: input?.maxBytes ?? null,
                  },
                }
              : {}),
          };
        },
      },
    },
  });

  hosts.push(host);

  const settings = {
    mode: "review",
    expiryEnabledAt: null,
    excludedThreads: ["thr_keep"],
  };

  await host.api.storage.kv.set("managed-cleanup.policy.v1", settings);

  let service = createHousekeepingService(host.api, {
    now: () => clock,
    reconcileManaged: async () => {
      managed++;
    },
  });

  return {
    native,
    host,
    calls,
    prune,
    closed,
    release,
    settings,
    get service() {
      return service;
    },
    counts: () => ({ recoveries, inspections, managed }),
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    advance: () => {
      clock += 2 * 60 * 60_000;
    },
    restart: async () => {
      const replacement = await host.harness.reload((api) => {
        service = createHousekeepingService(api, {
          now: () => clock,
          reconcileManaged: async () => {
            managed++;
          },
        });
      });

      hosts.splice(hosts.indexOf(host), 1, replacement);

      return replacement;
    },
  };
}

it("status has no adapter defaults, performs no cleanup, and preserves managed settings", async () => {
  const f = await fixture();
  expect(await f.service.status()).toMatchObject({
    hosts: [
      {
        hostId: "host_test",
        registration: null,
        currentRun: null,
        lastRun: null,
        nextRunAt: null,
      },
    ],
    failures: [],
  });
  expect(f.counts()).toEqual({ recoveries: 0, inspections: 0, managed: 0 });
  expect(f.prune).toEqual([]);
  expect(await f.host.api.storage.kv.get("managed-cleanup.policy.v1")).toEqual(
    f.settings,
  );
  const signals = f.host.harness.realtimeSignals.length;
  await f.service.status();
  expect(f.host.harness.realtimeSignals.length).toBe(signals);
});

it("coalesces simultaneous starts and recovers a lost response with the original UUID", async () => {
  const f = await fixture({ gated: true, lostStartResponse: true });

  const input = {
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  };

  const [first, second] = await Promise.all([
    f.service.run(input),
    f.service.run(input),
  ]);

  expect(first.currentRun?.id).toBe(second.currentRun?.id);
  expect(
    f.calls.filter((name) => name === "housekeepingHostStart"),
  ).toHaveLength(1);
  expect(first.currentRun?.reason).toContain("uncertain");
  expect((await f.service.status()).hosts[0]?.currentRun?.id).toBe(
    first.currentRun?.id,
  );
  f.release();
  await f.closed;
  const result = await f.service.status();
  expect(result.hosts[0]).toMatchObject({
    currentRun: null,
    lastRun: {
      id: first.currentRun?.id,
      state: "completed",
      stages: [
        { name: "process-private-temp" },
        { name: "local-policy" },
        { name: "managed-scratch", state: "complete" },
        { name: "unused-plugin-artifacts", state: "complete" },
      ],
    },
  });
  expect(f.counts()).toEqual({ recoveries: 1, inspections: 0, managed: 1 });
  expect(f.prune).toEqual([
    { dryRun: true, maxItems: 100, maxBytes: 10 * 1024 ** 3 },
    { dryRun: false, maxItems: 100, maxBytes: 10 * 1024 ** 3 },
  ]);
  expect(await f.host.api.storage.kv.get("managed-cleanup.policy.v1")).toEqual(
    f.settings,
  );
});

it("preview never removes or registers external policy and uses the supported bounded prune path", async () => {
  const f = await fixture();
  await f.service.preview({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });
  await f.closed;
  const status = await f.service.status();
  expect(status.hosts[0]).toMatchObject({
    currentRun: null,
    nextRunAt: null,
    lastRun: {
      mode: "preview",
      stages: [
        { name: "process-private-temp" },
        { name: "local-policy" },
        { name: "managed-scratch", state: "deferred" },
        { name: "unused-plugin-artifacts", state: "complete" },
      ],
    },
  });
  expect(f.counts()).toEqual({ recoveries: 0, inspections: 1, managed: 0 });
  expect(f.prune).toEqual([
    { dryRun: true, maxItems: 100, maxBytes: 10 * 1024 ** 3 },
  ]);
});

it("restart reconciles a completed original host run without dispatching another run", async () => {
  const f = await fixture({ lostStartResponse: true });

  const started = await f.service.run({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });

  await f.closed;
  await f.restart();
  const status = await f.service.status();
  expect(status.hosts[0]?.lastRun?.id).toBe(started.currentRun?.id);
  expect(status.hosts[0]?.currentRun).toBeNull();
  expect(
    f.calls.filter((name) => name === "housekeepingHostStart"),
  ).toHaveLength(1);
  expect(f.counts().recoveries).toBe(1);
  expect(f.prune).toHaveLength(2);
});

it("the installed server routes CLI and typed RPC through the same coordinator runner", async () => {
  const f = await fixture({ gated: true });
  const { default: storagePlugin } = await import("./server.js");
  storagePlugin(f.host.api);

  const rejected = await f.host.harness.runCli([
    "housekeeping",
    "run",
    "--machine",
    "host_test",
  ]);

  expect(rejected.exitCode).toBe(1);
  expect(f.counts().recoveries).toBe(0);
  await expect(
    f.host.harness.callRpc("housekeepingRun", {
      hostId: "host_test",
      executable: "/arbitrary-command",
      path: "/arbitrary-deletion",
    }),
  ).rejects.toThrow();

  const preview = await f.host.harness.runCli([
    "housekeeping",
    "preview",
    "--machine",
    "host_test",
  ]);

  expect(preview.exitCode).toBe(0);
  const started = JSON.parse(preview.stdout ?? "null");
  const status = await f.host.harness.callRpc("housekeepingStatus", null);
  expect(status).toMatchObject({
    hosts: [{ currentRun: { id: started.currentRun.id, mode: "preview" } }],
  });
  await f.closed;
  const terminal = await f.host.harness.callRpc("housekeepingStatus", null);
  expect(terminal).toMatchObject({
    hosts: [
      {
        currentRun: null,
        lastRun: { id: started.currentRun.id, mode: "preview" },
      },
    ],
  });
  expect(
    f.calls.filter((name) => name === "housekeepingHostStart"),
  ).toHaveLength(1);
  expect(f.counts()).toEqual({ recoveries: 0, inspections: 1, managed: 0 });
  expect(f.prune.every((call) => call.dryRun)).toBe(true);
});

it("an older coordinator that drops budget arguments is held before any plugin cache apply", async () => {
  const f = await fixture({ legacyPrune: true });
  await f.service.run({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });
  await f.closed;
  const status = await f.service.status();
  expect(status.hosts[0]?.lastRun).toMatchObject({
    state: "held",
    stages: expect.arrayContaining([
      {
        name: "unused-plugin-artifacts",
        state: "held",
        reason: "Coordinator update required for bounded plugin cache cleanup.",
        items: 0,
        bytes: 0,
      },
    ]),
  });
  expect(f.prune).toEqual([
    { dryRun: true, maxItems: 100, maxBytes: 10 * 1024 ** 3 },
  ]);
});

it("an ambiguous coordinator prune retains its reservation through restart and never applies again", async () => {
  const f = await fixture({ lostPruneResponse: true });
  await f.service.run({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });
  await f.closed;
  const first = await f.service.status();
  expect(first.hosts[0]?.currentRun).toMatchObject({
    state: "held",
    reserved: { items: 100, bytes: 10 * 1024 ** 3 },
  });
  await f.restart();
  const restarted = await f.service.status();
  expect(restarted.hosts[0]?.currentRun?.id).toBe(
    first.hosts[0]?.currentRun?.id,
  );
  expect(restarted.hosts[0]?.currentRun?.reserved).toEqual({
    items: 100,
    bytes: 10 * 1024 ** 3,
  });
  await f.service.run({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });
  expect(f.prune.filter((call) => !call.dryRun)).toHaveLength(1);
});

it("discovers a connected persistent host with an empty registry and runs only built-in maintenance once", async () => {
  const f = await fixture();
  expect(
    await f.host.api.storage.kv.get("housekeeping.hosts.v1"),
  ).toBeUndefined();
  await f.service.reconcile();
  await f.closed;
  const result = await f.service.status();
  expect(result.hosts[0]).toMatchObject({
    registration: null,
    currentRun: null,
    lastRun: {
      mode: "apply",
      state: "completed",
      stages: [
        { name: "process-private-temp", state: "complete" },
        {
          name: "local-policy",
          state: "deferred",
          reason: "No local policy adapter is registered.",
        },
        { name: "managed-scratch", state: "complete" },
        { name: "unused-plugin-artifacts", state: "complete" },
      ],
    },
  });
  expect(f.counts()).toEqual({ recoveries: 1, inspections: 0, managed: 1 });
  expect(f.calls).not.toContain("housekeepingHostAdapterPreview");
  expect(f.calls).not.toContain("housekeepingHostAdapterAdopt");
  expect(await f.host.api.storage.kv.get("managed-cleanup.policy.v1")).toEqual(
    f.settings,
  );
  await f.service.reconcile();
  expect(
    f.calls.filter((method) => method === "housekeepingHostStart"),
  ).toHaveLength(1);
});

it("records a scheduled host failure durably and preserves the exact unknown run until reconnect", async () => {
  const f = await fixture({ gated: true });

  const started = await f.service.run({
    hostId: "host_test",
    budget: { ...defaultHousekeepingBudget },
  });

  f.unavailable(true);
  await f.service.reconcile();
  const pending = await f.service.status();
  expect(pending.hosts[0]?.currentRun?.id).toBe(started.currentRun?.id);
  expect(pending.failures).toMatchObject([
    { hostId: "host_test", message: expect.stringContaining("without replay") },
  ]);
  await f.restart();
  expect((await f.service.status()).failures).toHaveLength(1);
  expect(
    f.calls.filter((method) => method === "housekeepingHostStart"),
  ).toHaveLength(1);
  f.release();
  await f.closed;
  f.unavailable(false);
  const recovered = await f.service.status();
  expect(recovered.hosts[0]?.lastRun?.id).toBe(started.currentRun?.id);
  expect(recovered.failures).toEqual([]);
});

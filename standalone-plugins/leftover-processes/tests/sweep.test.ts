import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import {
  hostContract,
  rpcContract,
  type HistoryEntry,
  type ListResult,
  type ObservedProcess,
  type ProcessIdentity,
  type ProcessStopResult,
  type ScanResult,
  type SweepStatus,
} from "../contract";
import plugin from "../server";

const HOUR = 3_600_000;

const INSTALLED = 1_000_000 * HOUR;

const AFTER_NOTICE = INSTALLED + 30 * HOUR;

const SWEEP_GAP = 5 * 60_000;

const GIB = 1024 ** 3;

function workload(overrides: Partial<ObservedProcess> & { pid: number }): ObservedProcess {
  return {
    startedAt: `Sun Nov 1 10:00:0${overrides.pid % 10} 2026`,
    ppid: 1,
    threadId: "thr_one",
    role: "workload",
    executable: "python3",
    command: `python3 serve.py --id ${overrides.pid}`,
    memoryBytes: 2 * GIB,
    memorySource: "footprint",
    cpuSeconds: 100,
    keepRequested: false,
    ...overrides,
  };
}

function identity(process: ObservedProcess): ProcessIdentity {
  return { pid: process.pid, startedAt: process.startedAt };
}

function settledWork(overrides: { waits?: readonly { id: string }[] } = {}) {
  return {
    revision: "r",
    basis: "b",
    primary: { label: "open", reason: { code: "assessment-missing", text: "No assessment." } },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "missing",
      reason: "None.",
      sourceSeq: null,
      suggestion: "unavailable",
      noSuggestionReason: null,
      waitingOn: null,
    },
    postponement: null,
    archive: { eligible: true, recommended: false, reason: "None." },
    ...overrides,
  };
}

function httpError(status: number, code: string): Error {
  return Object.assign(new Error(`HTTP ${status}: ${code}`), { status, code });
}

type ThreadRecord = {
  status?: "idle" | "active" | "starting" | "stopping" | "pending" | "error";
  archivedAt?: number | null;
  updatedAt?: number;
  title?: string | null;
};

type World = {
  hosts: Array<{ id: string; name: string; status: "connected" | "disconnected" }>;
  scans: Map<string, ObservedProcess[] | ScanResult | Error>;
  threads: Map<string, ThreadRecord | Error>;
  work: Map<string, ReturnType<typeof settledWork> | Error>;
  stops: Array<{ hostId: string; identities: ProcessIdentity[]; graceMs: number | undefined }>;
  stopResponse: ((identity: ProcessIdentity) => ProcessStopResult) | Error;
  gate: Promise<void> | null;
  scanCalls: number;
};

function createWorld(): World {
  return {
    hosts: [{ id: "host_mac", name: "Mac", status: "connected" }],
    scans: new Map(),
    threads: new Map(),
    work: new Map(),
    stops: [],
    stopResponse: (target) => ({ ...target, outcome: "terminated", detail: null }),
    gate: null,
    scanCalls: 0,
  };
}

async function hostRpc<Input>(world: World, hostId: string, method: string, input: Input) {
  if (method === "scan") {
    world.scanCalls += 1;

    if (world.gate !== null) await world.gate;

    const scan = world.scans.get(hostId) ?? [];

    if (scan instanceof Error) throw scan;

    return Array.isArray(scan) ? { supported: true, processes: scan, memoryFailure: null } : scan;
  }

  const request = hostContract.stop.input.parse(input);

  world.stops.push({ hostId, identities: request.identities, graceMs: request.graceMs });

  if (world.stopResponse instanceof Error) throw world.stopResponse;

  const respond = world.stopResponse;

  return { results: request.identities.map(respond) };
}

function load(world: World, settings: { autoStop?: boolean; idleHours?: number } = {}) {
  const owner = createFakePluginHost({
    pluginId: "leftover-processes",
    settings,
    sdk: {
      hosts: {
        list: async () =>
          world.hosts.map((host) =>
            makeHostResponse({ id: host.id, name: host.name, status: host.status }),
          ),
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const record = world.threads.get(threadId);

          if (record instanceof Error) throw record;

          if (record === undefined) throw httpError(404, "thread_not_found");

          return makeThreadResponse({
            id: threadId,
            title: record.title === undefined ? "Fix the login" : record.title,
            status: record.status ?? "idle",
            archivedAt: record.archivedAt ?? null,
            updatedAt: record.updatedAt ?? AFTER_NOTICE - 48 * HOUR,
          });
        },
        experimental_work: async ({ threadId }: { threadId: string }) => {
          const work = world.work.get(threadId) ?? settledWork();

          if (work instanceof Error) throw work;

          return work;
        },
      },
    },
    experimental_callHostRpc: ({ method, input, hostId }) => hostRpc(world, hostId, method, input),
  });

  plugin(owner.api);

  return owner;
}

type Owner = ReturnType<typeof load>;

async function list(
  owner: Owner,
  input: z.input<typeof rpcContract.list.input> = {},
): Promise<ListResult> {
  return rpcContract.list.output.parse(await owner.harness.behavior.callRpc("list", input));
}

async function sweepRpc(
  owner: Owner,
  input: z.input<typeof rpcContract.sweep.input> = {},
): Promise<SweepStatus> {
  return rpcContract.sweep.output.parse(await owner.harness.behavior.callRpc("sweep", input));
}

async function history(owner: Owner, limit = 200): Promise<HistoryEntry[]> {
  const response = rpcContract.history.output.parse(
    await owner.harness.behavior.callRpc("history", { limit }),
  );

  return response.entries;
}

async function scheduled(owner: Owner): Promise<void> {
  await owner.harness.behavior.runSchedule("sweep");
}

function rows(result: ListResult) {
  return result.hosts.flatMap((host) => host.threads.flatMap((thread) => thread.processes));
}

async function settleBaseline(owner: Owner): Promise<void> {
  await scheduled(owner);
  vi.setSystemTime(Date.now() + SWEEP_GAP);
}

let owners: Owner[] = [];

function track(owner: Owner): Owner {
  owners.push(owner);

  return owner;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(INSTALLED);
  owners = [];
});

afterEach(async () => {
  for (const owner of owners) await owner.harness.lifecycle.dispose();

  vi.useRealTimers();
});

describe("stopping an idle chat's leftovers", () => {
  it("holds a process it has no CPU baseline for, then stops it on the next sweep", async () => {
    const world = createWorld();
    const leftover = workload({ pid: 11 });

    world.scans.set("host_mac", [leftover]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner))[0]?.disposition).toEqual({
      kind: "waiting",
      reason: "busy",
      stopAt: null,
    });

    vi.setSystemTime(AFTER_NOTICE + SWEEP_GAP);
    await scheduled(owner);

    expect(world.stops).toEqual([
      { hostId: "host_mac", identities: [identity(leftover)], graceMs: 10_000 },
    ]);

    expect(await history(owner)).toEqual([
      {
        at: AFTER_NOTICE + SWEEP_GAP,
        hostId: "host_mac",
        hostName: "Mac",
        threadId: "thr_one",
        threadTitle: "Fix the login",
        command: leftover.command,
        memoryBytes: leftover.memoryBytes,
        reason: "idle",
        outcome: "terminated",
        detail: null,
      },
    ]);

    expect(rows(await list(owner))).toEqual([]);
  });

  it("never offers an agent or helper for stopping", async () => {
    const world = createWorld();
    const agent = workload({ pid: 20, role: "agent", memorySource: "rss" });
    const helper = workload({ pid: 21, ppid: 20, role: "helper", memorySource: "rss" });
    const tool = workload({ pid: 22, ppid: 20 });

    world.scans.set("host_mac", [agent, helper, tool]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops.flatMap((stop) => stop.identities)).toEqual([identity(tool)]);
  });

  it("stops the deepest processes first", async () => {
    const world = createWorld();
    const parent = workload({ pid: 30 });
    const child = workload({ pid: 31, ppid: 30 });
    const grandchild = workload({ pid: 32, ppid: 31 });

    world.scans.set("host_mac", [parent, child, grandchild]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops[0]?.identities.map((target) => target.pid)).toEqual([32, 31, 30]);
  });

  it("records a failed stop and keeps showing the process", async () => {
    const world = createWorld();
    const leftover = workload({ pid: 40 });

    world.scans.set("host_mac", [leftover]);
    world.threads.set("thr_one", {});
    world.stopResponse = new Error("worker went away");

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect((await history(owner))[0]).toMatchObject({ outcome: "failed", reason: "idle" });

    const result = await list(owner);

    expect(rows(result).map((row) => row.pid)).toEqual([40]);
    expect(result.hosts[0]?.failures[0]).toContain("worker went away");
    expect(result.lastSweep?.failures[0]).toContain("worker went away");
  });
});

describe("what defers a stop", () => {
  it("holds everything for the notice period and reports when it ends", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 50 })]);
    world.threads.set("thr_one", { updatedAt: INSTALLED - 100 * HOUR });

    const owner = track(load(world));

    vi.setSystemTime(INSTALLED + HOUR);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);

    const [row] = rows(await list(owner));

    expect(row?.disposition).toEqual({
      kind: "waiting",
      reason: "notice-period",
      stopAt: INSTALLED + 24 * HOUR,
    });

    expect(row?.nextStep).toBe("Stops in 23 h");
  });

  it("keeps installedAt across a reload, so the notice period does not restart", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 51 })]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);

    const reloaded = await owner.harness.lifecycle.reload(plugin);

    owners = [reloaded];
    await settleBaseline(reloaded);
    await scheduled(reloaded);

    expect(world.stops).toHaveLength(1);
  });

  it("keeps a process the user kept, covers its descendants, then forgets a gone process", async () => {
    const world = createWorld();
    const parent = workload({ pid: 60 });
    const child = workload({ pid: 61, ppid: 60 });

    world.scans.set("host_mac", [parent, child]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);

    const kept = await owner.harness.behavior.callRpc("keep", {
      hostId: "host_mac",
      identity: identity(parent),
    });

    expect(kept).toEqual({ ok: true, detail: "Kept" });

    await scheduled(owner);

    expect(world.stops).toEqual([]);

    const keptRows = rows(await list(owner));

    expect(keptRows.map((row) => [row.pid, row.nextStep, row.ownKeep])).toEqual([
      [60, "Kept", true],
      [61, "Kept", false],
    ]);

    world.scans.set("host_mac", []);
    await scheduled(owner);
    world.scans.set("host_mac", [{ ...parent, startedAt: "Mon Nov 2 10:00:00 2026" }]);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops.flatMap((stop) => stop.identities).map((target) => target.pid)).toEqual([
      60,
    ]);
  });

  it("lets go of a process after unkeep", async () => {
    const world = createWorld();
    const leftover = workload({ pid: 62 });

    world.scans.set("host_mac", [leftover]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);

    const target = { hostId: "host_mac", identity: identity(leftover) };

    await owner.harness.behavior.callRpc("keep", target);
    await owner.harness.behavior.callRpc("unkeep", target);
    await scheduled(owner);

    expect(world.stops).toHaveLength(1);
  });

  it("refuses to keep an unknown process or an agent", async () => {
    const world = createWorld();
    const agent = workload({ pid: 63, role: "agent" });

    world.scans.set("host_mac", [agent]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    await settleBaseline(owner);

    for (const candidate of [identity(agent), { pid: 999, startedAt: "never" }]) {
      const result = await owner.harness.behavior.callRpc("keep", {
        hostId: "host_mac",
        identity: candidate,
      });

      expect(result).toMatchObject({ ok: false });
    }
  });

  it("honors a launch request to keep running", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 64, keepRequested: true })]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner))[0]?.disposition).toEqual({ kind: "kept", reason: "launch-env" });
  });

  it("defers a busy chat thread-wide, then stops it once it settles", async () => {
    const world = createWorld();
    const parent = workload({ pid: 70, cpuSeconds: 100 });
    const child = workload({ pid: 71, ppid: 70, cpuSeconds: 100 });

    world.scans.set("host_mac", [parent, child]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);

    world.scans.set("host_mac", [parent, { ...child, cpuSeconds: 100 + 60 }]);
    await settleBaseline(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner)).map((row) => row.nextStep)).toEqual(["Busy", "Busy"]);

    await scheduled(owner);

    expect(world.stops[0]?.identities.map((target) => target.pid)).toEqual([71, 70]);
  });

  it("treats a chat that is running as in use", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 72 })]);
    world.threads.set("thr_one", { status: "active" });

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner))).toEqual([]);

    const everything = await list(owner, { includeRunningChats: true });

    expect(rows(everything)[0]?.nextStep).toBe("Chat is running");

    const thisChat = await list(owner, { threadId: "thr_one" });

    expect(rows(thisChat)[0]?.nextStep).toBe("Chat is running");
  });

  it("waits while the chat has open work", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 73 })]);
    world.threads.set("thr_one", {});
    world.work.set("thr_one", settledWork({ waits: [{ id: "w" }] }));

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner))[0]?.nextStep).toBe("Waiting on open work");
  });

  it("treats an unreadable work summary as open work and reports it", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 74 })]);
    world.threads.set("thr_one", {});
    world.work.set("thr_one", httpError(503, "invalid_request"));

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);

    const result = await list(owner);

    expect(rows(result)[0]?.nextStep).toBe("Waiting on open work");
    expect(result.hosts[0]?.failures[0]).toContain("Could not read open work");
    expect(result.lastSweep?.failures[0]).toContain("Could not read open work");
  });

  it("does not stop on a transport failure reading the chat", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 75 })]);
    world.threads.set("thr_one", httpError(500, "internal"));

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect((await list(owner)).hosts[0]?.failures[0]).toContain("Could not read chat thr_one");
  });

  it("never stops with autoStop off, and says so", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 76 })]);
    world.threads.set("thr_one", {});

    const owner = track(load(world, { autoStop: false }));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);

    const result = await list(owner);

    expect(result.autoStop).toBe(false);
    expect(rows(result)[0]?.nextStep).toBe("Auto-stop is off");
  });

  it("uses the idleHours setting", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 77 })]);
    world.threads.set("thr_one", { updatedAt: AFTER_NOTICE - HOUR });

    const owner = track(load(world, { idleHours: 2 }));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
    expect(rows(await list(owner))[0]?.nextStep).toBe("Stops in 55 min");

    vi.setSystemTime(AFTER_NOTICE + 2 * HOUR);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toHaveLength(1);
  });
});

describe("archived and deleted chats", () => {
  it("covers the undo window, then stops 60 s after the archive", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 80 })]);
    world.threads.set("thr_one", { archivedAt: AFTER_NOTICE });

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await scheduled(owner);
    vi.setSystemTime(AFTER_NOTICE + 30_000);
    await scheduled(owner);

    expect(world.stops).toEqual([]);

    vi.setSystemTime(AFTER_NOTICE + 61_000);
    await scheduled(owner);

    expect((await history(owner))[0]).toMatchObject({ reason: "archived", outcome: "terminated" });
  });

  it("stops the leftovers of a chat the server cannot find", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 81, threadId: "thr_gone" })]);

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect((await history(owner))[0]).toMatchObject({
      reason: "deleted",
      threadTitle: "Deleted chat",
    });
  });

  it("remembers the title of a chat deleted between sweeps", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 82 })]);
    world.threads.set("thr_one", { title: "Speech server", status: "active" });

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    world.threads.delete("thr_one");
    await scheduled(owner);

    expect((await history(owner))[0]?.threadTitle).toBe("Speech server");
  });
});

describe("machines", () => {
  it("records a host failure and still sweeps the others", async () => {
    const world = createWorld();
    const healthy = workload({ pid: 90 });

    world.hosts = [
      { id: "host_air", name: "Air", status: "connected" },
      { id: "host_mac", name: "Mac", status: "connected" },
    ];

    world.scans.set("host_air", new Error("worker unreachable"));
    world.scans.set("host_mac", [healthy]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    expect(world.stops).toEqual([
      { hostId: "host_mac", identities: [identity(healthy)], graceMs: 10_000 },
    ]);

    const result = await list(owner);

    expect(result.hosts.map((host) => [host.name, host.status, host.detail])).toEqual([
      ["Air", "failed", "worker unreachable"],
      ["Mac", "ok", null],
    ]);

    expect(result.lastSweep?.failures).toEqual(["Air: worker unreachable"]);
  });

  it("reports an unsupported machine without treating it as a failure", async () => {
    const world = createWorld();

    world.scans.set("host_mac", { supported: false, reason: "Process tracking is only on macOS." });

    const owner = track(load(world));

    await scheduled(owner);

    const result = await list(owner);

    expect(result.hosts[0]).toMatchObject({
      status: "unsupported",
      detail: "Process tracking is only on macOS.",
    });

    expect(result.lastSweep?.failures).toEqual([]);
  });

  it("skips a disconnected machine and drops its stale numbers", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 91 })]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    await scheduled(owner);

    expect((await list(owner)).processCount).toBe(1);

    const scansBefore = world.scanCalls;

    world.hosts = [{ id: "host_mac", name: "Mac", status: "disconnected" }];
    await scheduled(owner);

    expect(world.scanCalls).toBe(scansBefore);
    expect((await list(owner)).hosts).toEqual([]);
  });

  it("reports when the machines cannot be listed", async () => {
    const world = createWorld();
    const owner = track(load(world));

    owner.harness.sdk.stub("hosts.list", async () => {
      throw new Error("server busy");
    });

    await scheduled(owner);

    expect((await list(owner)).lastSweep?.failures).toEqual([
      "Could not list machines: server busy",
    ]);
  });

  it("shows a labelled rss reading and a memory failure", async () => {
    const world = createWorld();

    world.scans.set("host_mac", {
      supported: true,
      processes: [workload({ pid: 92, memorySource: "rss" })],
      memoryFailure: "top timed out",
    });

    world.threads.set("thr_one", {});

    const owner = track(load(world));

    await scheduled(owner);

    const result = await list(owner);

    expect(rows(result)[0]?.memorySource).toBe("rss");
    expect(result.hosts[0]?.failures).toEqual(["Memory: top timed out"]);
  });
});

describe("the sweep guard", () => {
  it("skips a scheduled sweep while another is running", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 95 })]);
    world.threads.set("thr_one", {});

    let open = () => {};

    world.gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const owner = track(load(world));
    const first = scheduled(owner);

    await vi.waitFor(() => expect(world.scanCalls).toBe(1));
    await scheduled(owner);

    expect(world.scanCalls).toBe(1);

    open();
    await first;
    world.gate = null;
    await scheduled(owner);

    expect(world.scanCalls).toBe(2);
  });
});

describe("list", () => {
  it("refreshes only when asked and filters by machine and chat", async () => {
    const world = createWorld();
    const first = workload({ pid: 100, threadId: "thr_one", memoryBytes: GIB });
    const second = workload({ pid: 101, threadId: "thr_two", memoryBytes: 3 * GIB });

    world.scans.set("host_mac", [first, second]);
    world.threads.set("thr_one", { title: "One" });
    world.threads.set("thr_two", { title: "Two" });

    const owner = track(load(world));

    expect((await list(owner)).hosts).toEqual([]);
    expect(world.scanCalls).toBe(0);

    const fresh = await list(owner, { refresh: true });

    expect(world.scanCalls).toBe(1);
    expect(fresh.memoryBytes).toBe(4 * GIB);
    expect(fresh.processCount).toBe(2);
    expect(fresh.hosts[0]?.threads.map((thread) => thread.title)).toEqual(["Two", "One"]);

    const filtered = await list(owner, { threadId: "thr_one" });

    expect(filtered.memoryBytes).toBe(GIB);
    expect(rows(filtered).map((row) => row.pid)).toEqual([100]);
    expect(await list(owner, { threadId: "thr_none" })).toMatchObject({
      hosts: [],
      processCount: 0,
    });
    expect(await list(owner, { hostId: "host_other" })).toMatchObject({ hosts: [] });
  });

  it("does not move the CPU baseline when a list refreshes", async () => {
    const world = createWorld();
    const leftover = workload({ pid: 102, cpuSeconds: 100 });

    world.scans.set("host_mac", [leftover]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);

    world.scans.set("host_mac", [{ ...leftover, cpuSeconds: 160 }]);
    await list(owner, { refresh: true });
    vi.setSystemTime(Date.now() + SWEEP_GAP);
    await scheduled(owner);

    expect(world.stops).toEqual([]);
  });

  it("fails visibly when refreshing a machine that is not connected", async () => {
    const owner = track(load(createWorld()));

    await expect(list(owner, { refresh: true, hostId: "host_other" })).rejects.toThrow(
      "is not connected",
    );
  });
});

describe("manual stop", () => {
  it("is allowed during the notice period and stops what the process started", async () => {
    const world = createWorld();
    const parent = workload({ pid: 110 });
    const child = workload({ pid: 111, ppid: 110 });

    world.scans.set("host_mac", [parent, child]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    const response = await owner.harness.behavior.callRpc("stop", {
      hostId: "host_mac",
      identities: [identity(parent)],
    });

    expect(world.stops[0]?.identities.map((target) => target.pid)).toEqual([111, 110]);
    expect(response).toMatchObject({
      results: [
        { pid: 111, outcome: "terminated" },
        { pid: 110, outcome: "terminated" },
      ],
    });

    expect((await history(owner)).map((entry) => entry.reason)).toEqual(["manual", "manual"]);
    expect(rows(await list(owner))).toEqual([]);
  });

  it("refuses an agent, a helper and a stale identity without signalling them", async () => {
    const world = createWorld();
    const agent = workload({ pid: 120, role: "agent" });
    const helper = workload({ pid: 121, ppid: 120, role: "helper" });

    world.scans.set("host_mac", [agent, helper]);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    const response = rpcContract.stop.output.parse(
      await owner.harness.behavior.callRpc("stop", {
        hostId: "host_mac",
        identities: [identity(agent), identity(helper), { pid: 122, startedAt: "never" }],
      }),
    );

    expect(response.results.map((result) => result.outcome)).toEqual([
      "refused",
      "refused",
      "refused",
    ]);

    expect(world.stops).toEqual([]);
  });

  it("fails visibly when the machine cannot be scanned", async () => {
    const world = createWorld();

    world.scans.set("host_mac", new Error("worker unreachable"));

    const owner = track(load(world));

    await expect(
      owner.harness.behavior.callRpc("stop", {
        hostId: "host_mac",
        identities: [{ pid: 130, startedAt: "x" }],
      }),
    ).rejects.toThrow("worker unreachable");
  });
});

describe("sweep now", () => {
  it("ignores the timer and notice period for one chat only", async () => {
    const world = createWorld();
    const mine = workload({ pid: 140, threadId: "thr_mine" });
    const other = workload({ pid: 141, threadId: "thr_other" });

    world.scans.set("host_mac", [mine, other]);
    world.threads.set("thr_mine", { updatedAt: INSTALLED });
    world.threads.set("thr_other", { updatedAt: INSTALLED });

    const owner = track(load(world));

    await settleBaseline(owner);
    expect(world.stops).toEqual([]);

    const status = await sweepRpc(owner, { threadId: "thr_mine", now: true });

    expect(status.stopped).toBe(1);
    expect(world.stops.flatMap((stop) => stop.identities)).toEqual([identity(mine)]);
  });

  it("still respects kept and busy", async () => {
    const world = createWorld();
    const kept = workload({ pid: 142, threadId: "thr_kept" });
    const busy = workload({ pid: 143, threadId: "thr_busy" });

    world.scans.set("host_mac", [kept, busy]);
    world.threads.set("thr_kept", { updatedAt: INSTALLED });
    world.threads.set("thr_busy", { updatedAt: INSTALLED });

    const owner = track(load(world));

    await settleBaseline(owner);

    await owner.harness.behavior.callRpc("keep", {
      hostId: "host_mac",
      identity: identity(kept),
    });

    world.scans.set("host_mac", [kept, { ...busy, cpuSeconds: 200 }]);

    await sweepRpc(owner, { threadId: "thr_kept", now: true });
    await sweepRpc(owner, { threadId: "thr_busy", now: true });

    expect(world.stops).toEqual([]);
  });

  it("refuses to run without a chat", async () => {
    const owner = track(load(createWorld()));

    await expect(sweepRpc(owner, { now: true })).rejects.toThrow("needs a chat");
  });

  it("does not bypass autoStop off", async () => {
    const world = createWorld();

    world.scans.set("host_mac", [workload({ pid: 144 })]);
    world.threads.set("thr_one", {});

    const owner = track(load(world, { autoStop: false }));

    await settleBaseline(owner);
    await sweepRpc(owner, { threadId: "thr_one", now: true });

    expect(world.stops).toEqual([]);
  });
});

describe("history", () => {
  it("keeps the newest 200 entries", async () => {
    const world = createWorld();
    const many = Array.from({ length: 205 }, (_, index) => workload({ pid: 1000 + index }));

    world.scans.set("host_mac", many);
    world.threads.set("thr_one", {});

    const owner = track(load(world));

    vi.setSystemTime(AFTER_NOTICE);
    await settleBaseline(owner);
    await scheduled(owner);

    const entries = await history(owner);

    expect(entries).toHaveLength(200);
    expect(entries.at(-1)?.command).toContain("--id 1005");
  });
});

describe("CLI", () => {
  async function cli(owner: Owner, ...argv: string[]) {
    return owner.harness.behavior.runCli(argv);
  }

  function worldWithOneLeftover() {
    const world = createWorld();
    const leftover = workload({ pid: 200, memoryBytes: 8.7 * GIB, command: "python3 serve.py" });

    world.scans.set("host_mac", [leftover]);
    world.threads.set("thr_one", { title: "Speech server" });

    return { world, leftover };
  }

  it("lists memory, chat title and what happens next", async () => {
    const { world } = worldWithOneLeftover();
    const owner = track(load(world));

    vi.setSystemTime(INSTALLED + HOUR);
    await settleBaseline(owner);
    await scheduled(owner);

    const { exitCode, stdout } = await cli(owner, "list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Left running: 8.7 GB in 1 process");
    expect(stdout).toContain("Mac (host_mac): 8.7 GB in 1 process");
    expect(stdout).toContain("Speech server (thr_one): 8.7 GB");
    expect(stdout).toContain("200  8.7 GB");
    expect(stdout).toContain("python3 serve.py");
  });

  it("retains the last successful inspection time when a later scan fails", async () => {
    const world = createWorld();
    const owner = track(load(world));
    vi.setSystemTime(INSTALLED);
    const first = await list(owner, { refresh: true });
    expect(first.coverage).toBe("complete");
    expect(first.hosts[0]?.lastSuccessfulAt).toBe(INSTALLED);
    world.scans.set("host_mac", new Error("scan failed"));
    vi.setSystemTime(INSTALLED + HOUR);
    const failed = await list(owner, { refresh: true });
    expect(failed.coverage).toBe("failed");
    expect(failed.hosts[0]?.lastSuccessfulAt).toBe(INSTALLED);
    const result = await cli(owner, "list");
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Resource usage is unknown");
    expect(result.stdout).not.toContain("Nothing left running");
  });

  it("keeps known processes visible while ambiguous ownership is held", async () => {
    const { world, leftover } = worldWithOneLeftover();
    world.scans.set("host_mac", {
      supported: true,
      processes: [leftover],
      memoryFailure: null,
      scanFailures: ["Process 201 and its descendants are held because ownership tags conflict."],
    });
    const owner = track(load(world));
    const observed = await list(owner, { refresh: true });
    expect(observed.coverage).toBe("partial");
    expect(observed.processCount).toBe(1);
    const result = await cli(owner, "list", "--json");
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout ?? "{}").coverage).toBe("partial");
  });

  it("says when a machine is not available or cannot be scanned", async () => {
    const world = createWorld();

    world.hosts = [
      { id: "host_win", name: "PC", status: "connected" },
      { id: "host_air", name: "Air", status: "connected" },
    ];

    world.scans.set("host_win", { supported: false, reason: "macOS only" });
    world.scans.set("host_air", new Error("worker unreachable"));

    const owner = track(load(world));
    const { exitCode, stdout } = await cli(owner, "list");

    expect(exitCode).toBe(1);
    expect(stdout).toContain("PC (host_win): Not available on this machine");
    expect(stdout).toContain("Air (host_air): Could not scan. worker unreachable");
  });

  it("says plainly when a machine has nothing left running", async () => {
    const owner = track(load(createWorld()));
    const { exitCode, stdout } = await cli(owner, "list");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Nothing left running.");
    expect(stdout).toContain("Mac (host_mac): Nothing left running");
  });

  it("prints JSON and honors the filters", async () => {
    const { world } = worldWithOneLeftover();
    const owner = track(load(world));

    const json = JSON.parse(
      (await cli(owner, "list", "--json", "--thread", "thr_one")).stdout ?? "",
    );

    expect(json.processCount).toBe(1);
    expect(
      JSON.parse((await cli(owner, "list", "--json", "--thread", "thr_none")).stdout ?? ""),
    ).toMatchObject({
      processCount: 0,
    });
  });

  it("stops by pid and fails on a pid no chat left running", async () => {
    const { world, leftover } = worldWithOneLeftover();
    const owner = track(load(world));
    const stopped = await cli(owner, "stop", "200");

    expect(stopped).toMatchObject({ exitCode: 0, stdout: "200: stopped" });
    expect(world.stops[0]?.identities).toEqual([identity(leftover)]);

    const missing = await cli(owner, "stop", "999");

    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("999");
  });

  it("asks for a machine when a pid is ambiguous", async () => {
    const { world, leftover } = worldWithOneLeftover();

    world.hosts = [
      { id: "host_air", name: "Air", status: "connected" },
      { id: "host_mac", name: "Mac", status: "connected" },
    ];

    world.scans.set("host_air", [leftover]);

    const owner = track(load(world));
    const ambiguous = await cli(owner, "stop", "200");

    expect(ambiguous.exitCode).toBe(1);
    expect(ambiguous.stderr).toContain("--host");

    expect((await cli(owner, "stop", "200", "--host", "host_air")).exitCode).toBe(0);
    expect(world.stops[0]?.hostId).toBe("host_air");
  });

  it("keeps and unkeeps by pid", async () => {
    const { world } = worldWithOneLeftover();
    const owner = track(load(world));

    expect(await cli(owner, "keep", "200")).toMatchObject({ exitCode: 0, stdout: "200: Kept" });
    expect((await cli(owner, "list")).stdout).toContain("Kept");
    expect(await cli(owner, "unkeep", "200")).toMatchObject({ exitCode: 0 });
    expect((await cli(owner, "list")).stdout).not.toContain("Kept");
  });

  it("sweeps, reports the count and refuses --now without --thread", async () => {
    const { world } = worldWithOneLeftover();
    const owner = track(load(world));

    await settleBaseline(owner);

    expect((await cli(owner, "sweep", "--thread", "thr_one", "--now")).stdout).toContain(
      "Stopped 1 process",
    );

    const refused = await cli(owner, "sweep", "--now");

    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("needs a chat");
  });

  it("prints the history", async () => {
    const { world } = worldWithOneLeftover();
    const owner = track(load(world));

    expect((await cli(owner, "history")).stdout).toBe("No stops yet.");

    await cli(owner, "stop", "200");

    const { stdout } = await cli(owner, "history");

    expect(stdout).toContain("Speech server");
    expect(stdout).toContain("8.7 GB");
    expect(stdout).toContain("manual");
    expect(stdout).toContain("stopped");
  });

  it("rejects an unknown option or command with the usage", async () => {
    const owner = track(load(createWorld()));

    expect(await cli(owner, "list", "--nope")).toMatchObject({ exitCode: 1 });
    expect((await cli(owner, "nope")).stderr).toContain("Usage:");
    expect((await cli(owner, "help")).stdout).toContain("Usage:");
    expect((await cli(owner, "stop", "abc")).exitCode).toBe(1);
  });
});

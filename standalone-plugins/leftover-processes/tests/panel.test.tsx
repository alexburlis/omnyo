import type { CuaResourceView } from "../cua-contract";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type PluginRpcTestHandlers,
} from "@omnyo/plugin-sdk/testing/app";
import type {
  ExperimentalThreadCompanionPlacement,
  ExperimentalThreadCompanionProps,
  PluginNavPanelProps,
} from "@omnyo/plugin-sdk/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Disposition,
  HistoryEntry,
  HostGroup,
  ListResult,
  rpcContract,
  ThreadGroup,
  WorkloadRow,
} from "../contract";
import { CHANGED_CHANNEL, PANEL_PATH } from "../lib/names";

const GIB = 1024 ** 3;

const app = await loadPluginApp(() => import("../app"));

function row(overrides: Partial<WorkloadRow> = {}): WorkloadRow {
  return {
    pid: 4242,
    startedAt: "Sun Nov 1 10:00:00 2026",
    ppid: 1,
    threadId: "thr_one",
    role: "workload",
    executable: "python3",
    command: "python3 serve.py --port 8000",
    memoryBytes: 8.7 * GIB,
    memorySource: "footprint",
    cpuSeconds: 10,
    keepRequested: false,
    hostId: "host_mac",
    ageSeconds: 432_000,
    disposition: { kind: "waiting", reason: "timer", stopAt: 1 },
    nextStep: "Stops in 23 h",
    ownKeep: false,
    ...overrides,
  };
}

function thread(processes: WorkloadRow[], overrides: Partial<ThreadGroup> = {}): ThreadGroup {
  return {
    threadId: "thr_one",
    title: "Speech server",
    state: { kind: "idle", since: 1 },
    memoryBytes: processes.reduce((total, process) => total + process.memoryBytes, 0),
    processes,
    ...overrides,
  };
}

function host(threads: ThreadGroup[], overrides: Partial<HostGroup> = {}): HostGroup {
  return {
    hostId: "host_mac",
    name: "Mac",
    status: "ok",
    detail: null,
    scannedAt: 1,
    memoryBytes: threads.reduce((total, group) => total + group.memoryBytes, 0),
    processCount: threads.reduce((total, group) => total + group.processes.length, 0),
    threads,
    failures: [],
    ...overrides,
  };
}

function listOf(hosts: HostGroup[], overrides: Partial<ListResult> = {}): ListResult {
  return {
    hosts,
    coverage: "complete",
    cuaResources: [],
    memoryBytes: hosts.reduce((total, group) => total + group.memoryBytes, 0),
    processCount: hosts.reduce((total, group) => total + group.processCount, 0),
    lastSweep: null,
    autoStop: true,
    idleHours: 24,
    ...overrides,
  };
}

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at: Date.now() - 2 * 3_600_000,
    hostId: "host_mac",
    hostName: "Mac",
    threadId: "thr_one",
    threadTitle: "Speech server",
    command: "node dev.js",
    memoryBytes: 512 * 1024 ** 2,
    reason: "idle",
    outcome: "terminated",
    detail: null,
    ...overrides,
  };
}

type Handlers = PluginRpcTestHandlers<typeof rpcContract>;

function unexpectedCall(method: string) {
  return () => {
    throw new Error(`Unexpected ${method} call`);
  };
}

function handlers(overrides: Partial<Handlers>): Handlers {
  return {
    list: unexpectedCall("list"),
    usage: unexpectedCall("usage"),
    history: () => ({ entries: [] }),
    stop: unexpectedCall("stop"),
    keep: unexpectedCall("keep"),
    unkeep: unexpectedCall("unkeep"),
    sweep: unexpectedCall("sweep"),
    cuaRegister: unexpectedCall("cuaRegister"),
    cuaAcquire: unexpectedCall("cuaAcquire"),
    cuaRelease: unexpectedCall("cuaRelease"),
    cuaKeep: unexpectedCall("cuaKeep"),
    cuaReconcile: unexpectedCall("cuaReconcile"),
    cuaList: unexpectedCall("cuaList"),
    cuaObserve: unexpectedCall("cuaObserve"),
    ...overrides,
  };
}

function mountPanel(overrides: Partial<Handlers>, subPath = "") {
  const panel = app.navPanels[0];

  if (panel === undefined) throw new Error("The panel must be registered");

  return renderSlot<PluginNavPanelProps, typeof rpcContract>(
    panel,
    { subPath },
    { rpc: handlers(overrides) },
  );
}

function mountCompanion(
  overrides: Partial<Handlers>,
  placement: ExperimentalThreadCompanionPlacement = "aside",
  threadId = "thr_one",
) {
  const companion = app.threadCompanions[0];

  if (companion === undefined) throw new Error("The companion must be registered");

  return renderSlot<ExperimentalThreadCompanionProps, typeof rpcContract>(
    companion,
    { threadId, projectId: "project-1", placement },
    { rpc: handlers(overrides) },
  );
}

async function visibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the panel", () => {
  it("is titled Task Manager and lives at its panel path", () => {
    expect(app.navPanels[0]).toMatchObject({ title: "Task Manager", path: PANEL_PATH });
  });

  it("shows a summary, then each machine, chat and process with its next step", async () => {
    const slot = mountPanel({
      list: () => listOf([host([thread([row()])])]),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("8.7 GB in 1 process")).toBeTruthy();

    const machine = within(screen.getByRole("region", { name: "Mac" }));

    expect(machine.getByRole("button", { name: "Speech server" })).toBeTruthy();
    expect(machine.getByText("python3")).toBeTruthy();
    expect(machine.getByText("python3 serve.py --port 8000")).toBeTruthy();
    expect(machine.getByText("Stops in 23 h")).toBeTruthy();
    expect(machine.getByText("8.7 GB")).toBeTruthy();
    expect(machine.getByText("up 5 d")).toBeTruthy();

    fireEvent.click(machine.getByRole("button", { name: "Speech server" }));

    expect(slot.inspection.navigateCalls[0]).toMatchObject({
      method: "toThread",
      threadId: "thr_one",
    });
  });

  it("states a chat-wide wait once in the chat header instead of on every process", async () => {
    const busy: Partial<WorkloadRow> = {
      disposition: { kind: "waiting", reason: "busy", stopAt: null },
      nextStep: "Busy",
    };

    mountPanel({
      list: () => listOf([host([thread([row(busy), row({ ...busy, pid: 4243 })])])]),
      history: () => ({ entries: [] }),
    });

    const machine = within(await screen.findByRole("region", { name: "Mac" }));

    expect(machine.getAllByText("Still working")).toHaveLength(1);
    expect(
      machine.getByText(
        "A process from this chat used CPU since the last check, so nothing stops yet.",
      ),
    ).toBeTruthy();
  });

  it("shows retained Cua ownership and lets the owner keep the runtime", async () => {
    let resource: CuaResourceView = {
      id: "00000000-0000-4000-8000-000000000001",
      hostId: "host_mac",
      ownerThreadId: "thr_owner",
      ownership: "managed",
      config: {
        cuaExecutable: "/tools/cua",
        colimaExecutable: "/tools/colima",
        dockerExecutable: "/tools/docker",
        home: "/cua",
      },
      vm: { pid: 123, startedAt: "Thu Nov 12 12:00:00 2026" },
      sandbox: {
        name: "test-desktop",
        containerId: "a".repeat(64),
        createdAt: "2026-11-12T17:00:00Z",
        processes: [],
      },
      consumers: [],
      keepRequested: false,
      idleGraceMs: 300_000,
      idleSince: Date.now(),
      lastHoldReason: null,
      lastObserved: { at: Date.now(), memory: { kind: "footprint", bytes: 2 * GIB } },
      transition: { kind: "stable" },
      registeredAt: Date.now(),
      retentionReason: "idle-grace",
      nextStopAt: Date.now() + 300_000,
    };

    const keep = vi.fn((input: { resourceId: string; ownerThreadId: string; keep: boolean }) => {
      resource = {
        ...resource,
        keepRequested: input.keep,
        retentionReason: "kept",
        nextStopAt: null,
      };

      return resource;
    });

    mountPanel({ list: () => listOf([], { cuaResources: [resource] }), cuaKeep: keep });
    expect(await screen.findByText("test-desktop")).toBeTruthy();
    expect(screen.queryByText("Nothing left running.")).toBeNull();
    expect(screen.getByText(/Last measured 2.0 GB/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Keep running" }));
    await waitFor(() =>
      expect(keep).toHaveBeenCalledWith({
        resourceId: resource.id,
        ownerThreadId: "thr_owner",
        keep: true,
      }),
    );
    expect(await screen.findByText("Kept running")).toBeTruthy();
  });

  it("says when nothing is left running", async () => {
    mountPanel({ list: () => listOf([]), history: () => ({ entries: [] }) });

    expect(await screen.findByText("Nothing left running.")).toBeTruthy();
  });

  it("labels an RSS reading", async () => {
    mountPanel({
      list: () => listOf([host([thread([row({ memorySource: "rss" })])])]),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("8.7 GB RSS")).toBeTruthy();
  });

  it("does not link a deleted chat", async () => {
    mountPanel({
      list: () => listOf([host([thread([row()], { state: { kind: "deleted" } })])]),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("Speech server")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Speech server" })).toBeNull();
  });
});

describe("refreshing", () => {
  it("reads the saved list first, then asks for a fresh scan on open", async () => {
    const slot = mountPanel({
      list: () => listOf([]),
      history: () => ({ entries: [] }),
    });

    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter((call) => call.method === "list").map((call) => call.input),
      ).toEqual([{ refresh: false }, { refresh: true }]),
    );
  });

  it("refetches on a realtime change without another scan", async () => {
    const slot = mountPanel({ list: () => listOf([]), history: () => ({ entries: [] }) });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThanOrEqual(4));

    const before = slot.inspection.rpcCalls.length;

    await slot.behavior.emitRealtime(CHANGED_CHANNEL, {});

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(before));

    const lastList = slot.inspection.rpcCalls.findLast((call) => call.method === "list");

    expect(lastList?.input).toEqual({ refresh: false });
  });

  it("makes no calls while hidden and catches up when shown again", async () => {
    const slot = mountPanel({ list: () => listOf([]), history: () => ({ entries: [] }) });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThanOrEqual(4));
    await visibility("hidden");

    const before = slot.inspection.rpcCalls.length;

    await slot.behavior.emitRealtime(CHANGED_CHANNEL, {});
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(slot.inspection.rpcCalls.length).toBe(before);

    await visibility("visible");

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(before));
  });

  it("does not poll while visible", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout"] });

    const slot = mountPanel({ list: () => listOf([]), history: () => ({ entries: [] }) });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    const before = slot.inspection.rpcCalls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(slot.inspection.rpcCalls.length).toBe(before);
  });
});

describe("actions", () => {
  it("stops a process with its exact identity and refreshes", async () => {
    let rows = [row()];
    const stop = vi.fn();

    const slot = mountPanel({
      list: () => listOf(rows.length === 0 ? [] : [host([thread(rows)])]),
      history: () => ({ entries: [] }),
      stop: (input) => {
        stop(input);
        rows = [];

        return {
          results: input.identities.map((identity) => ({
            ...identity,
            outcome: "terminated",
            detail: null,
          })),
        };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Stop python3 4242" }));

    await waitFor(() =>
      expect(stop).toHaveBeenCalledWith({
        hostId: "host_mac",
        identities: [{ pid: 4242, startedAt: "Sun Nov 1 10:00:00 2026" }],
      }),
    );

    expect(await screen.findByText("Nothing left running.")).toBeTruthy();
    expect(slot.inspection.rpcCalls.some((call) => call.method === "stop")).toBe(true);
  });

  it("shows why a stop was refused", async () => {
    mountPanel({
      list: () => listOf([host([thread([row()])])]),
      history: () => ({ entries: [] }),
      stop: (input) => ({
        results: input.identities.map((identity) => ({
          ...identity,
          outcome: "refused",
          detail: "process identity changed",
        })),
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Stop python3 4242" }));

    expect(await screen.findByText("4242: process identity changed")).toBeTruthy();
  });

  it("shows a stop that failed outright", async () => {
    mountPanel({
      list: () => listOf([host([thread([row()])])]),
      history: () => ({ entries: [] }),
      stop: () => {
        throw new Error("Machine host_mac is not connected.");
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Stop python3 4242" }));

    expect(await screen.findByText("Machine host_mac is not connected.")).toBeTruthy();
  });

  it("keeps a process with one click", async () => {
    const keep = vi.fn(() => ({ ok: true, detail: "Kept" }));

    mountPanel({
      list: () => listOf([host([thread([row()])])]),
      history: () => ({ entries: [] }),
      keep,
    });

    fireEvent.click(await screen.findByRole("button", { name: "Keep python3 4242" }));

    await waitFor(() =>
      expect(keep).toHaveBeenCalledWith({
        hostId: "host_mac",
        identity: { pid: 4242, startedAt: "Sun Nov 1 10:00:00 2026" },
      }),
    );
  });

  it("offers Unkeep only on a process the user kept itself", async () => {
    const kept: Disposition = { kind: "kept", reason: "user" };
    const launch: Disposition = { kind: "kept", reason: "launch-env" };

    mountPanel({
      list: () =>
        listOf([
          host([
            thread([
              row({
                pid: 1,
                executable: "own",
                disposition: kept,
                ownKeep: true,
                nextStep: "Kept",
              }),
              row({ pid: 2, executable: "covered", disposition: kept, nextStep: "Kept" }),
              row({ pid: 3, executable: "launch", disposition: launch, nextStep: "Kept" }),
            ]),
          ]),
        ]),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByRole("button", { name: "Unkeep own 1" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep own 1" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unkeep covered 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Keep covered 2" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unkeep launch 3" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop launch 3" })).toBeTruthy();
  });
});

describe("failures", () => {
  it("shows failed and unsupported machines visibly", async () => {
    mountPanel({
      list: () =>
        listOf([
          host([], {
            hostId: "host_air",
            name: "Air",
            status: "failed",
            detail: "worker unreachable",
          }),
          host([], {
            hostId: "host_pc",
            name: "PC",
            status: "unsupported",
            detail: "Process tracking is only available on macOS.",
          }),
        ]),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("Could not scan this machine. worker unreachable")).toBeTruthy();
    expect(screen.getByText("Not tracked")).toBeTruthy();
    expect(screen.getByText("Process tracking is only available on macOS.")).toBeTruthy();
    expect(screen.getByText("Inspection failed. Resource usage is unknown.")).toBeTruthy();
    expect(screen.queryByText("Nothing left running.")).toBeNull();
  });

  it("shows a machine's partial failures and a sweep failure once", async () => {
    mountPanel({
      list: () =>
        listOf(
          [host([thread([row()])], { failures: ["Could not read open work for Speech server"] })],
          {
            lastSweep: {
              at: 1,
              stopped: 0,
              failures: [
                "Mac: Could not read open work for Speech server",
                "Could not list machines: server busy",
              ],
            },
          },
        ),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("Could not read open work for Speech server")).toBeTruthy();
    expect(screen.getByText("Could not list machines: server busy")).toBeTruthy();
    expect(screen.queryByText("Mac: Could not read open work for Speech server")).toBeNull();
  });

  it("shows a load failure and recovers on Retry", async () => {
    let failing = true;

    mountPanel({
      list: () => {
        if (failing) throw new Error("Server unavailable");

        return listOf([]);
      },
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("Server unavailable")).toBeTruthy();

    failing = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Nothing left running.")).toBeTruthy();
    expect(screen.queryByText("Server unavailable")).toBeNull();
  });

  it("says when auto-stop is off", async () => {
    mountPanel({
      list: () => listOf([], { autoStop: false }),
      history: () => ({ entries: [] }),
    });

    expect(await screen.findByText("Auto-stop is off.")).toBeTruthy();
  });
});

describe("a machine with nothing to show", () => {
  it("does not take up a heading", async () => {
    mountPanel({ list: () => listOf([host([], { name: "Quiet machine" })]) });

    expect(await screen.findByText("Nothing left running.")).toBeTruthy();
    expect(screen.queryByText("Quiet machine")).toBeNull();
  });
});

describe("recent stops", () => {
  it("lists recent stops compactly and flags a failed one", async () => {
    mountPanel({
      list: () => listOf([]),
      history: () => ({
        entries: [
          entry(),
          entry({
            command: "node stuck.js",
            outcome: "failed",
            detail: "still running after SIGKILL",
          }),
        ],
      }),
    });

    const section = within(await screen.findByRole("region", { name: "Recent stops" }));

    expect(section.getByText("node dev.js")).toBeTruthy();
    expect(section.getByText("Chat idle")).toBeTruthy();
    expect(section.getByText("Could not stop")).toBeTruthy();
    expect(section.getByText("still running after SIGKILL")).toBeTruthy();
  });
});

describe("recent stops folding", () => {
  it("remembers a collapsed Recent stops section", async () => {
    window.localStorage.clear();
    const options = { list: () => listOf([]), history: () => ({ entries: [entry()] }) };

    mountPanel(options);
    const toggle = await screen.findByRole("button", { name: /Recent stops/ });

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    cleanup();

    mountPanel(options);

    expect(
      (await screen.findByRole("button", { name: /Recent stops/ })).getAttribute("aria-expanded"),
    ).toBe("false");
    window.localStorage.clear();
  });
});

describe("the list filtered to one chat", () => {
  it("asks for that chat, filters its stops and links back to all chats", async () => {
    const slot = mountPanel(
      {
        list: () => listOf([host([thread([row()])])]),
        history: () => ({
          entries: [entry(), entry({ threadId: "thr_other", command: "node other.js" })],
        }),
      },
      "thr_one",
    );

    expect(await screen.findByText("node dev.js")).toBeTruthy();
    expect(screen.queryByText("node other.js")).toBeNull();

    expect(slot.inspection.rpcCalls.find((call) => call.method === "list")?.input).toEqual({
      threadId: "thr_one",
      refresh: false,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all chats" }));

    expect(slot.inspection.navigateCalls[0]).toMatchObject({
      method: "toPluginPanel",
      path: PANEL_PATH,
    });
  });
});

describe("the chat companion", () => {
  it("renders nothing when the chat has no workloads", async () => {
    const slot = mountCompanion({ list: () => listOf([]) });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));

    expect(slot.container.textContent).toBe("");
  });

  it("renders nothing while the only workloads belong to a running chat", async () => {
    const running: Disposition = { kind: "in-use", reason: "chat-running" };

    const slot = mountCompanion({
      list: () => listOf([host([thread([row({ disposition: running })])])]),
    });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));
    await act(async () => {});

    expect(slot.container.textContent).toBe("");
  });

  it("shows the total and opens the same list filtered to this chat", async () => {
    const slot = mountCompanion({
      list: () => listOf([host([thread([row(), row({ pid: 2, memoryBytes: GIB })])])]),
    });

    fireEvent.click(await screen.findByRole("button", { name: /2 processes left running/ }));

    expect(screen.getByText("9.7 GB · Stops in 23 h")).toBeTruthy();
    expect(slot.inspection.navigateCalls[0]).toMatchObject({
      method: "toPluginPanel",
      path: PANEL_PATH,
      options: { subPath: "thr_one" },
    });
  });

  it("uses one short row in the title bar", async () => {
    mountCompanion({ list: () => listOf([host([thread([row()])])]) }, "toolbar");

    expect(await screen.findByRole("button", { name: "8.7 GB left running" })).toBeTruthy();
  });

  it("reads the saved list without scanning, and follows realtime changes", async () => {
    let rows: WorkloadRow[] = [];

    const slot = mountCompanion({
      list: () => listOf(rows.length === 0 ? [] : [host([thread(rows)])]),
    });

    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBe(1));

    expect(slot.inspection.rpcCalls[0]?.input).toEqual({ threadId: "thr_one", refresh: false });

    rows = [row()];
    await slot.behavior.emitRealtime(CHANGED_CHANNEL, {});

    expect(await screen.findByRole("button", { name: /1 process left running/ })).toBeTruthy();
    expect(slot.inspection.rpcCalls.every((call) => call.method === "list")).toBe(true);
  });
});

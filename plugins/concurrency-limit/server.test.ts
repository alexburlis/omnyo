import type {
  PluginApi,
  MessageDispatchHookContext,
  PluginDispatchAttemptKind,
} from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "./server.js";

type RunningThread = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["listRunning"]>
>[number];

type HostResponse = ReturnType<typeof makeHostResponse>;

type SdkSubscription = Parameters<PluginApi["sdk"]["subscribe"]>[0];

type HostChangedSubscription = Extract<
  SdkSubscription,
  { event: "host:changed" }
>;

function isHostChangedSubscription(
  subscription: SdkSubscription,
): subscription is HostChangedSubscription {
  return subscription.event === "host:changed";
}

function isThreadChangedSubscription(
  subscription: SdkSubscription,
): subscription is Extract<SdkSubscription, { event: "thread:changed" }> {
  return subscription.event === "thread:changed";
}

const PLUGIN_ID = "concurrency-limit";

function hostRecord(
  id: string,
  status: "connected" | "disconnected" = "connected",
  name = id,
): HostResponse {
  return makeHostResponse({ id, name, status });
}

function running(overrides: Partial<RunningThread> = {}): RunningThread {
  return { id: "thr_running", hostId: "host-a", ...overrides };
}

interface GateContextOverrides {
  hostId?: string | null;
  hostName?: string;
  thread?: Partial<MessageDispatchHookContext["thread"]>;
  attempt?: PluginDispatchAttemptKind;
}

function dispatchContext(overrides: GateContextOverrides = {}) {
  const hostId = overrides.hostId === undefined ? "host-a" : overrides.hostId;

  return makeMessageDispatchHookContext({
    thread: {
      id: "thr_1",
      status: "pending",
      ...overrides.thread,
    },
    attempt: overrides.attempt ?? "start-turn",
    host:
      hostId === null
        ? null
        : { id: hostId, name: overrides.hostName ?? hostId },
  });
}

type StartMachines = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["experimental_listStartMachines"]>
>;

type MoveStartArgs = Parameters<
  PluginApi["sdk"]["threads"]["experimental_moveStart"]
>[0];

type MoveStartResult = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["experimental_moveStart"]>
>;

interface DetectedFacts {
  os: "macos" | "windows" | "linux";
  arch: string;
  tools: { xcode: boolean; nvidiaGpu: string | null };
}

interface SetupOptions {
  configuration?: Record<string, unknown>;
  capacities?: Array<{ hostId: string; availableParallelism: number }>;
  facts?: Array<{
    hostId: string;
    facts: DetectedFacts & { availableParallelism: number };
  }>;
  hosts?: HostResponse[] | (() => HostResponse[]);
  running?: RunningThread[];
  detectedParallelism?: number;
  detectedFacts?: DetectedFacts | null;
  projects?: Array<{ id: string; name: string }>;
  startMachines?: (threadId: string) => StartMachines;
  moveStart?: (args: MoveStartArgs) => MoveStartResult;
  subscribe?: PluginApi["sdk"]["subscribe"];
  beforeLoad?: (api: PluginApi) => void;
}

const MAC_FACTS: DetectedFacts = {
  os: "macos",
  arch: "arm64",
  tools: { xcode: false, nvidiaGpu: null },
};

async function setup(options: SetupOptions = {}) {
  const subscribe: PluginApi["sdk"]["subscribe"] = () => () => {};

  const fake = createFakePluginHost({
    pluginId: PLUGIN_ID,
    sdk: {
      subscribe: options.subscribe ?? subscribe,
      hosts: {
        list: async () =>
          typeof options.hosts === "function"
            ? options.hosts()
            : (options.hosts ?? []),
      },
      projects: {
        list: async () =>
          (options.projects ?? []).map((project) => ({
            id: project.id,
            name: project.name,
          })),
      },
      threads: {
        listRunning: async () => options.running ?? [],
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({ id: threadId, projectId: "proj-a" }),
        experimental_listStartMachines: async ({
          threadId,
        }: {
          threadId: string;
        }) =>
          options.startMachines?.(threadId) ?? {
            originHostId: null,
            machines: [],
          },
        experimental_moveStart: async (args: MoveStartArgs) =>
          options.moveStart?.(args) ?? {
            kind: "refused" as const,
            code: "not_waiting" as const,
            message: "Only a waiting new chat can move.",
          },
      },
    },
    experimental_callHostRpc: (call) => {
      if (call.method === "getMachineFacts") {
        if (options.detectedFacts === null) {
          throw new Error("Unknown host method getMachineFacts");
        }

        return {
          availableParallelism: options.detectedParallelism ?? 8,
          ...(options.detectedFacts ?? MAC_FACTS),
        };
      }

      return { availableParallelism: options.detectedParallelism ?? 8 };
    },
  });

  if (options.configuration !== undefined) {
    await fake.api.storage.kv.set("configuration", options.configuration);
  }

  if (options.capacities !== undefined) {
    await fake.api.storage.kv.set("host-capacities", options.capacities);
  }

  if (options.facts !== undefined) {
    await fake.api.storage.kv.set("machine-facts", options.facts);
  }

  options.beforeLoad?.(fake.api);
  await plugin(fake.api);
  const hook = fake.harness.registrations.hooks["message.dispatch"];

  if (hook === null) throw new Error("message.dispatch was not registered");

  return { ...fake, hook };
}

function hostChanges(): {
  emitHostChanges(
    hostId: string,
    changes: Parameters<HostChangedSubscription["callback"]>[0]["changes"],
  ): void;
  subscribe: PluginApi["sdk"]["subscribe"];
} {
  let callback: HostChangedSubscription["callback"] | null = null;

  return {
    emitHostChanges(hostId, changes) {
      callback?.({
        type: "changed",
        entity: "host",
        id: hostId,
        changes,
      });
    },
    subscribe(subscription) {
      if (isHostChangedSubscription(subscription)) {
        callback = subscription.callback;
      }

      return () => {
        if (isHostChangedSubscription(subscription)) callback = null;
      };
    },
  };
}

describe("configuration", () => {
  it("uses a custom settings section rather than generic setting descriptors", async () => {
    const { harness } = await setup();

    expect(harness.registrations.settingsDescriptors).toEqual({});
  });

  it("returns each host's detected automatic limit and retained offline capacity", async () => {
    const { harness } = await setup({
      hosts: [
        hostRecord("host-a", "connected", "Laptop"),
        hostRecord("host-b", "disconnected", "Studio"),
      ],
      capacities: [
        { hostId: "host-a", availableParallelism: 8 },
        { hostId: "host-b", availableParallelism: 16 },
      ],
    });

    await expect(harness.behavior.callRpc("getConfiguration")).resolves.toEqual(
      {
        globalLimit: null,
        hostOverrides: [],
        overflow: { enabled: false, hosts: [], projectNeeds: [] },
        hosts: [
          {
            id: "host-a",
            name: "Laptop",
            status: "connected",
            availableParallelism: 8,
            automaticLimit: 8,
            effectiveLimit: 8,
            override: null,
            facts: null,
            takesOverflow: true,
            tags: [],
          },
          {
            id: "host-b",
            name: "Studio",
            status: "disconnected",
            availableParallelism: 16,
            automaticLimit: 16,
            effectiveLimit: 16,
            override: null,
            facts: null,
            takesOverflow: true,
            tags: [],
          },
        ],
        projects: [],
      },
    );
  });

  it("rejects invalid and duplicate limits at the RPC boundary", async () => {
    const { harness } = await setup();

    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: 1.5,
        hostOverrides: [],
      }),
    ).rejects.toThrow();
    await expect(
      harness.behavior.callRpc("setConfiguration", {
        globalLimit: null,
        hostOverrides: [
          { hostId: "host-a", limit: 1 },
          { hostId: "host-a", limit: 2 },
        ],
      }),
    ).rejects.toThrow(/rpc input validation failed/u);
  });

  it("persists validated configuration and rechecks waiting dispatches", async () => {
    const { api, harness } = await setup({
      hosts: [hostRecord("host-a")],
    });

    await harness.behavior.callRpc("setConfiguration", {
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
    });

    await expect(api.storage.kv.get("configuration")).resolves.toEqual({
      globalLimit: 3,
      hostOverrides: [{ hostId: "host-a", limit: 0 }],
      overflow: { enabled: false, hosts: [], projectNeeds: [] },
    });
    expect(harness.recheckCount).toBe(1);
    expect(harness.realtimeSignals).toContainEqual({
      channel: "dispatch-readiness-changed",
      payload: {},
    });
  });

  it("detects connected host capacity in the background", async () => {
    const { api, harness } = await setup({
      hosts: [hostRecord("host-a")],
      detectedParallelism: 12,
    });

    const service = harness.behavior.runService("capacity-detector");

    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });
    await expect(api.storage.kv.get("host-capacities")).resolves.toEqual([
      { hostId: "host-a", availableParallelism: 12 },
    ]);
    await expect(
      harness.behavior.callRpc("getConfiguration"),
    ).resolves.toMatchObject({
      hosts: [
        {
          id: "host-a",
          availableParallelism: 12,
          automaticLimit: 12,
          effectiveLimit: 12,
        },
      ],
    });

    service.controller.abort();
    await service.done;
  });

  it("detects a host when it connects after startup", async () => {
    const changes = hostChanges();
    let status: HostResponse["status"] = "disconnected";

    const { harness } = await setup({
      hosts: () => [hostRecord("host-a", status)],
      subscribe: changes.subscribe,
    });

    const service = harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(1);
    });
    expect(harness.experimental_hostRpcCalls).toHaveLength(0);

    status = "connected";
    changes.emitHostChanges("host-a", ["host-connected"]);
    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    });

    service.controller.abort();
    await service.done;
  });

  it("ignores host messages that only report a provider model catalog change", async () => {
    const changes = hostChanges();

    const { harness } = await setup({
      hosts: [hostRecord("host-a")],
      subscribe: changes.subscribe,
    });

    const service = harness.behavior.runService("capacity-detector");
    await vi.waitFor(() => {
      expect(harness.experimental_hostRpcCalls).toHaveLength(1);
      expect(
        harness.realtimeSignals.filter(
          (signal) => signal.channel === "configuration-changed",
        ),
      ).toHaveLength(1);
    });
    const hostListCalls = harness.inspection.sdk.callsTo("hosts.list").length;

    changes.emitHostChanges("host-a", ["provider-model-catalog-changed"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      harness.realtimeSignals.filter(
        (signal) => signal.channel === "configuration-changed",
      ),
    ).toHaveLength(1);
    expect(harness.experimental_hostRpcCalls).toHaveLength(1);
    expect(harness.inspection.sdk.callsTo("hosts.list")).toHaveLength(
      hostListCalls,
    );

    changes.emitHostChanges("host-a", ["host-disconnected"]);
    expect(
      harness.realtimeSignals.filter(
        (signal) => signal.channel === "configuration-changed",
      ),
    ).toHaveLength(2);

    service.controller.abort();
    await service.done;
  });

  it("provides CLI parity for global and host overrides", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    await expect(
      harness.behavior.runCli(["global", "3"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "3",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "0"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout:
        "Laptop: 0 (8 processors, connected; machine facts unknown; takes overflow)",
    });
    await expect(
      harness.behavior.runCli(["host", "host-a", "auto"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout:
        "Laptop: auto, 8 (8 processors, connected; machine facts unknown; takes overflow)",
    });
    await expect(
      harness.behavior.runCli(["global", "1.5"]),
    ).resolves.toMatchObject({ exitCode: 1 });
  });

  it("documents the limit range in help and reports errors as JSON", async () => {
    const { harness } = await setup({
      hosts: [hostRecord("host-a", "connected", "Laptop")],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
    });

    const help = (await harness.behavior.runCli(["host", "--help"])).stdout;
    expect(help).toContain("omnyo concurrency-limit host");
    expect(help).toContain("0 to 10000");

    const envelope = await harness.behavior.runCli([
      "host",
      "host-b",
      "--json",
    ]);

    expect(envelope.exitCode).toBe(1);
    expect(JSON.parse(envelope.stdout)).toEqual({
      ok: false,
      error: {
        code: "unknown_host",
        message: "Unknown host: host-b",
        hint: "Run `omnyo machine list` for the enrolled host ids.",
      },
    });
    expect(envelope.stderr).toContain("Unknown host: host-b");

    const badLimit = await harness.behavior.runCli(["host", "host-a", "many"]);
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.stderr).toContain(
      "Limit must be auto or a whole number from 0 to 10000",
    );
  });
});

describe("message.dispatch", () => {
  it("uses a conservative limit of one until a host is detected", async () => {
    const { hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
  });

  it("uses each host's detected automatic limit", async () => {
    const { hook } = await setup({
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
      running: [
        running({ id: "a" }),
        running({ id: "b" }),
        running({ id: "c" }),
        running({ id: "d" }),
        running({ id: "e" }),
        running({ id: "f" }),
        running({ id: "g" }),
        running({ id: "h" }),
      ],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "8 of 8 running on host host-a",
    });
  });

  it("keeps host pools separate and honors explicit overrides", async () => {
    const { hook } = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 1 }],
      },
      running: [running({ hostId: "host-a" })],
    });

    await expect(hook(dispatchContext({ hostId: "host-a" }))).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on host host-a",
    });
    await expect(hook(dispatchContext({ hostId: "host-b" }))).resolves.toEqual({
      action: "proceed",
    });
  });

  it("applies the overall limit before a host limit", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running()],
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
  });

  it("treats zero as a pause rather than as unlimited", async () => {
    const global = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(
      global.hook(dispatchContext({ hostId: null })),
    ).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on all hosts",
    });

    const host = await setup({
      configuration: {
        globalLimit: null,
        hostOverrides: [{ hostId: "host-a", limit: 0 }],
      },
    });

    await expect(host.hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "0 of 0 running on host host-a",
    });
  });

  it("skips host enforcement when no host has been selected", async () => {
    const { harness, hook } = await setup({ running: [running()] });

    await expect(hook(dispatchContext({ hostId: null }))).resolves.toEqual({
      action: "proceed",
    });
    expect(harness.inspection.sdk.callsTo("threads.listRunning")).toHaveLength(
      0,
    );
  });

  it("does not re-admit running threads or join-turn attempts", async () => {
    const { hook } = await setup({
      configuration: { globalLimit: 0, hostOverrides: [] },
    });

    await expect(
      hook(dispatchContext({ thread: { status: "active" } })),
    ).resolves.toEqual({ action: "proceed" });
    await expect(
      hook(
        dispatchContext({
          attempt: "join-turn",
          thread: { status: "idle" },
        }),
      ),
    ).resolves.toEqual({ action: "proceed" });
  });
});

describe("capacity wake events", () => {
  it("rechecks queued work when a running thread stops occupying capacity", async () => {
    const { harness } = await setup();
    const thread = makeThreadResponse({ id: "thr_freed", status: "idle" });

    await harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: null,
    });
    await harness.behavior.emitThreadEvent("thread.failed", {
      thread,
      error: null,
    });
    await harness.behavior.emitThreadEvent("thread.archived", { thread });
    await harness.behavior.emitThreadEvent("thread.deleted", { thread });

    expect(harness.recheckCount).toBe(4);
  });

  it("does not count a thread compacting automatically and rechecks when the run ends", async () => {
    const { harness, hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running({ id: "thr_maintenance" })],
    });

    const thread = {
      ...makeThreadResponse({ id: "thr_maintenance", status: "active" }),
      experimental_maintenance: "auto-compaction" as const,
    };

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });

    await harness.behavior.emitThreadEvent("experimental_thread.maintenance", {
      thread,
      phase: "started",
      outcome: null,
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "proceed",
    });
    expect(harness.recheckCount).toBe(0);

    await harness.behavior.emitThreadEvent("experimental_thread.maintenance", {
      thread: { ...thread, status: "idle", experimental_maintenance: null },
      phase: "ended",
      outcome: "completed",
    });

    expect(harness.recheckCount).toBe(1);
    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
  });

  it("loads on an Omnyo version without maintenance events", async () => {
    const { harness, hook } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: [running({ id: "thr_other" })],
      beforeLoad: (api) => {
        const on = api.events.on.bind(api.events);

        vi.spyOn(api.events, "on").mockImplementation((event, handler) => {
          if (event === "experimental_thread.maintenance")
            throw new Error(
              `unknown event "${event}" — supported events: thread.idle`,
            );

          return on(event, handler);
        });
      },
    });

    await expect(hook(dispatchContext())).resolves.toEqual({
      action: "wait",
      reason: "1 of 1 running on all hosts",
    });
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_other", status: "idle" }),
      lastAssistantText: null,
    });
    expect(harness.recheckCount).toBe(1);
  });
});

describe("read-only dispatch readiness", () => {
  it("signals starting and freed capacity without rechecking policy on every status change", async () => {
    let threadChanged:
      | Extract<SdkSubscription, { event: "thread:changed" }>["callback"]
      | undefined;

    const active: RunningThread[] = [];

    const { harness } = await setup({
      configuration: { globalLimit: 1, hostOverrides: [] },
      running: active,
      subscribe(subscription) {
        if (isThreadChangedSubscription(subscription))
          threadChanged = subscription.callback;

        return () => {
          threadChanged = undefined;
        };
      },
    });

    const service = harness.behavior.runService("capacity-detector");

    try {
      await vi.waitFor(() => expect(threadChanged).toBeDefined());
      active.push(running());
      threadChanged?.({
        type: "changed",
        entity: "thread",
        id: "thr_starting",
        changes: ["status-changed"],
      });
      await expect(
        harness.behavior.callRpc("getDispatchReadiness", {
          thread: { id: "thr_idle", status: "idle" },
          host: null,
        }),
      ).resolves.toEqual({
        action: "wait",
        reason: "1 of 1 running on all hosts",
      });
      active.splice(0);
      threadChanged?.({
        type: "changed",
        entity: "thread",
        id: "thr_starting",
        changes: ["status-changed"],
      });
      await expect(
        harness.behavior.callRpc("getDispatchReadiness", {
          thread: { id: "thr_idle", status: "idle" },
          host: null,
        }),
      ).resolves.toEqual({ action: "proceed" });
      threadChanged?.({
        type: "changed",
        entity: "thread",
        id: "thr_other",
        changes: ["events-appended"],
      });
      expect(
        harness.realtimeSignals.filter(
          (signal) => signal.channel === "dispatch-readiness-changed",
        ),
      ).toHaveLength(2);
      expect(harness.recheckCount).toBe(0);
    } finally {
      service.controller.abort();
      await service.done;
    }
  });

  it.each([
    {
      name: "global capacity",
      options: {
        configuration: { globalLimit: 1, hostOverrides: [] },
        running: [running()],
      },
      expected: { action: "wait", reason: "1 of 1 running on all hosts" },
    },
    {
      name: "host capacity",
      options: {
        configuration: {
          globalLimit: null,
          hostOverrides: [{ hostId: "host-a", limit: 1 }],
        },
        running: [running()],
      },
      expected: { action: "wait", reason: "1 of 1 running on host host-a" },
    },
    {
      name: "available capacity",
      options: {
        configuration: {
          globalLimit: 2,
          hostOverrides: [{ hostId: "host-a", limit: 2 }],
        },
        running: [running()],
      },
      expected: { action: "proceed" },
    },
  ])(
    "shares the real dispatch decision for $name",
    async ({ options, expected }) => {
      const { harness, hook } = await setup(options);
      const context = dispatchContext();

      await expect(
        harness.behavior.callRpc("getDispatchReadiness", {
          thread: { id: context.thread.id, status: context.thread.status },
          host:
            context.host === null
              ? null
              : { id: context.host.id, name: context.host.name },
        }),
      ).resolves.toEqual(expected);
      await expect(hook(context)).resolves.toEqual(expected);
      expect(harness.recheckCount).toBe(0);
    },
  );
});

describe("overflow", () => {
  const laptop = hostRecord("host-a", "connected", "Laptop");
  const air = hostRecord("host-b", "connected", "Air");
  const studio = hostRecord("host-c", "connected", "Studio");

  const capacities = ["host-a", "host-b", "host-c"].map((hostId) => ({
    hostId,
    availableParallelism: 8,
  }));

  function factsFor(hostId: string, facts: DetectedFacts = MAC_FACTS) {
    return { hostId, facts: { availableParallelism: 8, ...facts } };
  }

  const macFacts = ["host-a", "host-b", "host-c"].map((hostId) =>
    factsFor(hostId),
  );

  function listing(...machines: Array<{ hostId: string; name: string }>) {
    return (): StartMachines => ({
      originHostId: "host-a",
      machines: machines.map((machine) => ({
        hostId: machine.hostId,
        name: machine.name,
        eligible: true,
        environmentProviderId: "git-worktree",
        reason: null,
      })),
    });
  }

  function recordMoves(result: "moved" | "refused" = "moved") {
    const moves: MoveStartArgs[] = [];

    return {
      moves,
      moveStart(args: MoveStartArgs): MoveStartResult {
        moves.push(args);

        return result === "moved"
          ? {
              kind: "moved",
              threadId: args.threadId,
              fromHostId: args.expectedHostId,
              toHostId: args.hostId,
              environmentProviderId: "git-worktree",
            }
          : {
              kind: "refused",
              code: "agent_not_ready",
              message: "This chat's agent isn't ready on that machine.",
            };
      },
    };
  }

  function overflowConfiguration(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      globalLimit: null,
      hostOverrides: [
        { hostId: "host-a", limit: 1 },
        { hostId: "host-c", limit: 2 },
      ],
      overflow: { enabled: true, hosts: [], projectNeeds: [] },
      ...overrides,
    };
  }

  async function queueWaitingChat(
    harness: Awaited<ReturnType<typeof setup>>["harness"],
  ): Promise<void> {
    await harness.behavior.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({
        threadId: "thr_1",
        waitingOn: {
          kind: "plugin",
          pluginId: PLUGIN_ID,
          reason: "1 of 1 running on host Laptop",
        },
      }),
    });
  }

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it("moves a waiting chat from a full machine to the free machine with the most slots", async () => {
    const recorder = recordMoves();

    const { harness } = await setup({
      configuration: overflowConfiguration(),
      capacities,
      facts: macFacts,
      hosts: [laptop, air, studio],
      running: [running({ hostId: "host-a" })],
      startMachines: listing(
        { hostId: "host-b", name: "Air" },
        { hostId: "host-c", name: "Studio" },
      ),
      moveStart: recorder.moveStart,
    });

    await queueWaitingChat(harness);

    await vi.waitFor(() => expect(recorder.moves).toHaveLength(1));
    expect(recorder.moves[0]).toEqual({
      threadId: "thr_1",
      hostId: "host-b",
      expectedHostId: "host-a",
      note: "Started on Air because Laptop was full.",
    });
  });

  it.each([
    {
      name: "overflow is off",
      configuration: overflowConfiguration({
        overflow: { enabled: false, hosts: [], projectNeeds: [] },
      }),
      running: [running({ hostId: "host-a" })],
    },
    {
      name: "its own machine still has room",
      configuration: overflowConfiguration({ hostOverrides: [] }),
      running: [running({ hostId: "host-a" })],
    },
    {
      name: "the overall limit holds every machine",
      configuration: overflowConfiguration({ globalLimit: 1 }),
      running: [running({ hostId: "host-a" })],
    },
  ])("leaves a waiting chat alone when $name", async (scenario) => {
    const recorder = recordMoves();

    const { harness } = await setup({
      configuration: scenario.configuration,
      capacities,
      facts: macFacts,
      hosts: [laptop, air, studio],
      running: scenario.running,
      startMachines: listing({ hostId: "host-b", name: "Air" }),
      moveStart: recorder.moveStart,
    });

    await queueWaitingChat(harness);
    await settle();

    expect(recorder.moves).toEqual([]);
  });

  it("keeps a chat on its machine's operating system unless the project declares needs", async () => {
    const windowsAir = [
      factsFor("host-a"),
      factsFor("host-b", { ...MAC_FACTS, os: "windows", arch: "x64" }),
    ];

    const sameOs = recordMoves();

    const first = await setup({
      configuration: overflowConfiguration(),
      capacities,
      facts: windowsAir,
      hosts: [laptop, air],
      running: [running({ hostId: "host-a" })],
      startMachines: listing({ hostId: "host-b", name: "Air" }),
      moveStart: sameOs.moveStart,
    });

    await queueWaitingChat(first.harness);
    await settle();
    expect(sameOs.moves).toEqual([]);

    const anyOs = recordMoves();

    const second = await setup({
      configuration: overflowConfiguration({
        overflow: {
          enabled: true,
          hosts: [],
          projectNeeds: [{ projectId: "proj-a", needs: [] }],
        },
      }),
      capacities,
      facts: windowsAir,
      hosts: [laptop, air],
      running: [running({ hostId: "host-a" })],
      startMachines: listing({ hostId: "host-b", name: "Air" }),
      moveStart: anyOs.moveStart,
    });

    await queueWaitingChat(second.harness);
    await vi.waitFor(() => expect(anyOs.moves).toHaveLength(1));
  });

  it("skips machines that do not take overflow or lack a declared need", async () => {
    const recorder = recordMoves();

    const { harness } = await setup({
      configuration: overflowConfiguration({
        overflow: {
          enabled: true,
          hosts: [{ hostId: "host-b", takesOverflow: false, tags: [] }],
          projectNeeds: [
            {
              projectId: "proj-a",
              needs: [{ kind: "tool", tool: "xcode" }],
            },
          ],
        },
      }),
      capacities,
      facts: [
        factsFor("host-a"),
        factsFor("host-b", {
          ...MAC_FACTS,
          tools: { xcode: true, nvidiaGpu: null },
        }),
        factsFor("host-c", {
          ...MAC_FACTS,
          tools: { xcode: true, nvidiaGpu: null },
        }),
      ],
      hosts: [laptop, air, studio],
      running: [running({ hostId: "host-a" })],
      startMachines: listing(
        { hostId: "host-b", name: "Air" },
        { hostId: "host-c", name: "Studio" },
      ),
      moveStart: recorder.moveStart,
    });

    await queueWaitingChat(harness);

    await vi.waitFor(() => expect(recorder.moves).toHaveLength(1));
    expect(recorder.moves[0]?.hostId).toBe("host-c");
  });

  it("keeps a chat home when its first message clearly needs Xcode or a release", async () => {
    const recorder = recordMoves();

    const { harness } = await setup({
      configuration: overflowConfiguration(),
      capacities,
      facts: macFacts,
      hosts: [laptop, air],
      running: [running({ hostId: "host-a" })],
      startMachines: listing({ hostId: "host-b", name: "Air" }),
      moveStart: recorder.moveStart,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await harness.behavior.emitThreadEvent("message.queued", {
        entry: makeQueueEntry({
          threadId: "thr_1",
          content: [
            {
              type: "text",
              text: "Run the iOS tests in Xcode, then ship it",
              mentions: [],
            },
          ],
          waitingOn: {
            kind: "plugin",
            pluginId: PLUGIN_ID,
            reason: "1 of 1 running on host Laptop",
          },
        }),
      });
      await settle();
    }

    expect(recorder.moves).toEqual([]);
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.startsWith("Keeping waiting thread thr_1"),
      ),
    ).toEqual([
      {
        level: "info",
        message:
          'Keeping waiting thread thr_1 on its machine: its first message mentions "iOS".',
      },
    ]);
  });

  it.each(["Fix the relationship view", "Tidy the shipment table"])(
    "still moves a chat whose message only contains a held word inside another word: %s",
    async (text) => {
      const recorder = recordMoves();

      const { harness } = await setup({
        configuration: overflowConfiguration(),
        capacities,
        facts: macFacts,
        hosts: [laptop, air],
        running: [running({ hostId: "host-a" })],
        startMachines: listing({ hostId: "host-b", name: "Air" }),
        moveStart: recorder.moveStart,
      });

      await harness.behavior.emitThreadEvent("message.queued", {
        entry: makeQueueEntry({
          threadId: "thr_1",
          content: [{ type: "text", text, mentions: [] }],
          waitingOn: {
            kind: "plugin",
            pluginId: PLUGIN_ID,
            reason: "1 of 1 running on host Laptop",
          },
        }),
      });

      await vi.waitFor(() => expect(recorder.moves).toHaveLength(1));
    },
  );

  it("says once why no machine can take a waiting chat", async () => {
    const recorder = recordMoves();

    const { harness } = await setup({
      configuration: overflowConfiguration(),
      capacities,
      facts: macFacts,
      hosts: [laptop, air],
      running: [running({ hostId: "host-a" })],
      startMachines: () => ({
        originHostId: "host-a",
        machines: [
          {
            hostId: "host-b",
            name: "Air",
            eligible: false,
            environmentProviderId: null,
            reason: "This chat is pinned to its machine.",
          },
        ],
      }),
      moveStart: recorder.moveStart,
    });

    await queueWaitingChat(harness);
    await settle();
    await queueWaitingChat(harness);
    await settle();

    expect(recorder.moves).toEqual([]);
    expect(
      harness.logEntries.filter((entry) =>
        entry.message.startsWith("No machine can take waiting thread thr_1"),
      ),
    ).toEqual([
      {
        level: "info",
        message:
          "No machine can take waiting thread thr_1 yet. Air: This chat is pinned to its machine.",
      },
    ]);
  });

  it("waits out a cooldown after a refused move instead of retrying at once", async () => {
    const recorder = recordMoves("refused");

    const { harness } = await setup({
      configuration: overflowConfiguration(),
      capacities,
      facts: macFacts,
      hosts: [laptop, air],
      running: [running({ hostId: "host-a" })],
      startMachines: listing({ hostId: "host-b", name: "Air" }),
      moveStart: recorder.moveStart,
    });

    await queueWaitingChat(harness);
    await vi.waitFor(() => expect(recorder.moves).toHaveLength(1));
    await queueWaitingChat(harness);
    await settle();

    expect(recorder.moves).toHaveLength(1);
  });

  it("detects machine facts and keeps capacity from an older host entry", async () => {
    const detected = await setup({
      hosts: [laptop],
      detectedFacts: { ...MAC_FACTS, tools: { xcode: true, nvidiaGpu: null } },
    });

    const service = detected.harness.behavior.runService("capacity-detector");

    await vi.waitFor(() =>
      expect(
        detected.harness.behavior.callRpc("getConfiguration"),
      ).resolves.toMatchObject({
        hosts: [
          {
            facts: {
              availableParallelism: 8,
              ...MAC_FACTS,
              tools: { xcode: true, nvidiaGpu: null },
            },
          },
        ],
      }),
    );
    service.controller.abort();
    await service.done;

    const older = await setup({ hosts: [laptop], detectedFacts: null });
    const olderService = older.harness.behavior.runService("capacity-detector");

    await vi.waitFor(() =>
      expect(
        older.harness.behavior.callRpc("getConfiguration"),
      ).resolves.toMatchObject({
        hosts: [{ availableParallelism: 8, facts: null }],
      }),
    );
    olderService.controller.abort();
    await olderService.done;
  });

  it("provides CLI parity for overflow, host overflow and project needs", async () => {
    const { harness } = await setup({
      hosts: [laptop],
      capacities: [{ hostId: "host-a", availableParallelism: 8 }],
      projects: [{ id: "proj-a", name: "App" }],
    });

    await expect(
      harness.behavior.runCli(["overflow", "on"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "On",
    });
    await expect(
      harness.behavior.runCli([
        "host",
        "host-a",
        "--overflow",
        "off",
        "--tags",
        "dia",
      ]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout:
        "Laptop: auto, 8 (8 processors, connected; machine facts unknown; no overflow, tags dia)",
    });
    await expect(
      harness.behavior.runCli(["needs", "proj-a", "macos,xcode,tag:dia"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "App: macos, xcode, tag:dia",
    });
    await expect(
      harness.behavior.runCli(["needs", "proj-a", "same-os"]),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "App: same OS as its machine",
    });
    await expect(
      harness.behavior.runCli(["needs", "proj-a", "quantum"]),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});

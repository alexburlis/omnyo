import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import plugin from "./server";
import { SOUND_IDS } from "./domain";

describe("Chime backend", () => {
  it("serves every themed sound as a WAV asset", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: { subscribe: () => () => {} },
    });
    await plugin(api);

    for (const soundId of SOUND_IDS) {
      const response = await harness.behavior.fetchHttp("GET", `/sound-${soundId}`);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(
        Buffer.from(await response.arrayBuffer())
          .subarray(0, 4)
          .toString(),
      ).toBe("RIFF");
    }
    await harness.lifecycle.dispose();
  });

  it("publishes lifecycle events without message content", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: () => () => {},
        projects: { list: async () => [] },
        threads: {
          events: { list: async () => [] },
          interactions: { list: async () => [] },
          get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1" }),
        },
      },
    });
    await api.storage.kv.set("config", { eventEnabled: { started: true } });
    await plugin(api);

    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thread-1", projectId: "project-1" }),
    });
    const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
    const payload = (await response.json()) as { events: Array<Record<string, unknown>> };

    expect(payload.events).toEqual([
      expect.objectContaining({
        seq: expect.any(Number),
        notification: expect.objectContaining({
          kind: "started",
          threadId: "thread-1",
          projectId: "project-1",
        }),
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain("message");
    await harness.lifecycle.dispose();
  });

  it("honours muted projects before queueing", async () => {
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: { subscribe: () => () => {} },
    });
    await plugin(api);
    await harness.behavior.callRpc("updateConfig", {
      enabled: true,
      volume: 0.5,
      deliveryMode: "client",
      muteVisibleThread: false,
      mutedProjectIds: ["project-1"],
      eventEnabled: {
        started: true,
        completed: true,
        question: true,
        approval: true,
        failed: true,
        cancelled: true,
      },
      eventSounds: {
        started: "soft-rise",
        completed: "warm-resolve",
        question: "clear-question",
        approval: "gentle-knock",
        failed: "low-warning",
        cancelled: "soft-stop",
      },
    });
    await harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: "thread-1", projectId: "project-1" }),
    });
    const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
    const payload = (await response.json()) as { events: unknown[] };
    expect(payload.events).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("publishes each pending interaction once", async () => {
    let changed: ((event: { id?: string; changes: readonly string[] }) => void) | undefined;
    const interactions = [
      {
        id: "interaction-1",
        status: "pending",
        payload: { kind: "user_question" },
      },
    ];
    const thread = makeThreadResponse({ id: "thread-1", projectId: "project-1" });
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: ((args: { callback: typeof changed }) => {
          changed = args.callback;
          return () => {};
        }) as never,
        threads: {
          interactions: { list: async () => interactions as never },
          get: async () => thread,
        },
        experimental_attention: { history: async () => ({ questions: [], callbacks: [] }) },
      },
    });
    await plugin(api);

    changed?.({ id: "thread-1", changes: ["interactions-changed"] });
    changed?.({ id: "thread-1", changes: ["interactions-changed"] });

    await vi.waitFor(async () => {
      const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
      const payload = (await response.json()) as {
        events: Array<{ notification: { kind: string; interactionId?: string } }>;
      };
      expect(payload.events.map(({ notification }) => notification)).toEqual([
        expect.objectContaining({ kind: "question", interactionId: "interaction-1" }),
      ]);
    });
    await harness.lifecycle.dispose();
  });

  it("chimes once for each newly opened Omnyo question, optional or required", async () => {
    let changed: ((event: { id?: string; changes: readonly string[] }) => void) | undefined;
    const now = Date.now();
    const question = (
      id: string,
      mode: "optional" | "required",
      state: string,
      createdAt: number,
    ) => ({
      id,
      threadId: "thread-1",
      revision: 1,
      question: { prompt: `Question ${id}`, mode, options: [] },
      state,
      answer: null,
      queuedMessageId: null,
      createdAt,
      updatedAt: createdAt,
    });
    const questions = [
      question("optional", "optional", "open", now),
      question("stale", "required", "open", now - 10 * 60_000),
      question("answered", "required", "answered", now),
    ];
    let scans = 0;
    const thread = makeThreadResponse({ id: "thread-1", projectId: "project-1" });
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: ((args: { callback: typeof changed }) => {
          changed = args.callback;
          return () => {};
        }) as never,
        threads: {
          interactions: { list: async () => [] },
          get: async () => thread,
        },
        experimental_attention: {
          history: async () => {
            scans += 1;
            return { questions: [...questions], callbacks: [] } as never;
          },
        },
      },
    });
    await plugin(api);

    const published = async () => {
      const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
      const payload = (await response.json()) as {
        events: Array<{ notification: { kind: string; interactionId?: string } }>;
      };
      return payload.events.map(({ notification }) => notification);
    };

    changed?.({ id: "thread-1", changes: ["interactions-changed"] });
    await vi.waitFor(async () =>
      expect(await published()).toEqual([
        expect.objectContaining({ kind: "question", interactionId: "question:optional" }),
      ]),
    );
    questions.push(question("required", "required", "open", now));
    changed?.({ id: "thread-1", changes: ["interactions-changed"] });
    changed?.({ id: "thread-1", changes: ["interactions-changed"] });
    await vi.waitFor(() => expect(scans).toBeGreaterThanOrEqual(2));

    await vi.waitFor(async () =>
      expect(await published()).toEqual([
        expect.objectContaining({ kind: "question", interactionId: "question:optional" }),
        expect.objectContaining({ kind: "question", interactionId: "question:required" }),
      ]),
    );
    await harness.lifecycle.dispose();
  });
});

function sidebarSdk(readThread: () => ReturnType<typeof makeThreadResponse>) {
  return {
    projects: {
      sidebarBootstrap: async () =>
        ({
          sections: [],
          personalProject: { threads: [] },
          projects: [
            {
              threads: [
                {
                  ...readThread(),
                  queuedWork: "none",
                  hasPendingInteraction: false,
                  lastReadAt: 0,
                  latestAttentionAt: 1,
                  activity: {
                    activeBackgroundAgentCount: 0,
                    activeBackgroundCommandCount: 0,
                    activeWorkflowCount: 0,
                    activePlanModeCount: 0,
                    activeGoalCount: 0,
                  },
                },
              ],
            },
          ],
        }) as never,
    },
    plugins: { list: async () => ({ plugins: [] }) as never },
  };
}

describe("completion delivery", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    ["hidden helper", { visibility: "hidden" }],
    ["resumed turn", { status: "active", runtime: { displayStatus: "active" } }],
    ["active runtime", { runtime: { displayStatus: "active" } }],
    ["queued continuation", { queuedMessageCount: 1 }],
    ["background work", { activeBackgroundAgentCount: 1 }],
  ] as const)("does not report completion for %s", async (_name, overrides) => {
    vi.useFakeTimers();
    const idle = makeThreadResponse({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    const current = makeThreadResponse({ ...idle, ...overrides });
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: () => () => {},
        ...sidebarSdk(() => current),
        threads: {
          get: async () => current,
          interactions: { list: async () => [] },
          events: {
            list: async (args) =>
              args.types?.includes("thread/goal/updated")
                ? []
                : [
                    {
                      id: "event-1",
                      threadId: idle.id,
                      seq: 99,
                      createdAt: Date.now(),
                      scope: { kind: "turn", turnId: "turn-1" },
                      type: "turn/completed",
                      data: { status: "completed", providerThreadId: "provider-thread-1" },
                    },
                  ],
          },
        },
      },
    });
    await plugin(api);
    try {
      await harness.behavior.emitThreadEvent("thread.idle", {
        thread: current.visibility === "hidden" ? current : idle,
        lastAssistantText: "done",
      });
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
      expect((await response.json()).events).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it.each([
    "missing history",
    "newer turn",
    "failed turn",
    "provider interruption",
    "history failure",
    "pending question",
    "active goal",
  ])("does not report completion for %s", async (scenario) => {
    vi.useFakeTimers();
    const thread = makeThreadResponse({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: () => () => {},
        ...sidebarSdk(() => thread),
        threads: {
          get: async () => thread,
          interactions: {
            list: async () =>
              scenario === "pending question"
                ? ([{ id: "q1", status: "pending", payload: { kind: "user_question" } }] as never)
                : [],
          },
          events: {
            list: async (args) => {
              if (scenario === "history failure") throw new Error("history unavailable");
              if (args.types?.includes("thread/goal/updated"))
                return scenario === "active goal"
                  ? [
                      {
                        id: "goal-1",
                        threadId: thread.id,
                        seq: 98,
                        createdAt: Date.now(),
                        scope: { kind: "thread" },
                        type: "thread/goal/updated",
                        data: {
                          providerThreadId: "provider-thread-1",
                          status: "active",
                          objective: "finish",
                          tokenBudget: null,
                          tokensUsed: 1,
                          timeUsedSeconds: 1,
                        },
                      },
                    ]
                  : [];
              if (scenario === "missing history") return [];
              const base = {
                id: "event-1",
                threadId: thread.id,
                seq: 99,
                createdAt: Date.now(),
                scope: { kind: "turn" as const, turnId: "turn-1" },
              };
              if (scenario === "provider interruption")
                return [
                  {
                    ...base,
                    type: "system/thread/interrupted",
                    data: { reason: "provider-turn-idle" },
                  },
                ];
              if (scenario === "newer turn")
                return [
                  {
                    ...base,
                    type: "turn/completed",
                    data: { status: "completed", providerThreadId: "provider-thread-1" },
                  },
                  {
                    ...base,
                    id: "event-2",
                    seq: 100,
                    type: "turn/started",
                    data: { providerThreadId: "provider-thread-1" },
                  },
                ];
              return [
                {
                  ...base,
                  type: "turn/completed",
                  data: {
                    status: scenario === "failed turn" ? "failed" : "completed",
                    providerThreadId: "provider-thread-1",
                  },
                },
              ];
            },
          },
        },
      },
    });
    await plugin(api);
    try {
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await harness.behavior.fetchHttp("GET", "/events?after=0");
      expect((await response.json()).events).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("validates the same completed turn again at playback", async () => {
    vi.useFakeTimers();
    let thread = makeThreadResponse({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: () => () => {},
        ...sidebarSdk(() => thread),
        threads: {
          get: async () => thread,
          interactions: { list: async () => [] },
          events: {
            list: async (args) =>
              args.types?.includes("thread/goal/updated")
                ? []
                : [
                    {
                      id: "event-1",
                      threadId: thread.id,
                      seq: 99,
                      createdAt: Date.now(),
                      scope: { kind: "turn", turnId: "turn-1" },
                      type: "turn/completed",
                      data: { status: "completed", providerThreadId: "provider-thread-1" },
                    },
                  ],
          },
        },
      },
    });
    await plugin(api);
    try {
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
      const queued = await (await harness.behavior.fetchHttp("GET", "/events?after=0")).json();
      expect(queued.events).toHaveLength(1);
      expect(queued.events[0].notification).toMatchObject({ kind: "completed", turnSeq: 99 });
      expect(
        await (
          await harness.behavior.fetchHttp("GET", "/completion?threadId=thread-1&turnSeq=99")
        ).json(),
      ).toEqual({ play: true });
      expect(
        await (
          await harness.behavior.fetchHttp("GET", "/completion?threadId=thread-1&turnSeq=98")
        ).json(),
      ).toEqual({ play: false });
      thread = makeThreadResponse({
        ...thread,
        status: "active",
        runtime: { displayStatus: "active" },
      });
      expect(
        await (
          await harness.behavior.fetchHttp("GET", "/completion?threadId=thread-1&turnSeq=99")
        ).json(),
      ).toEqual({ play: false });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("sidebar completion agreement", () => {
  it.each([
    "background command",
    "workflow",
    "plan mode",
    "goal activity",
    "already read",
    "failed queued send",
    "pending sidebar input",
    "missing sidebar row",
    "unavailable sidebar",
    "callback wait",
    "owned worker",
    "open decision",
    "green disabled",
    "unavailable Needs You",
    "failed callback read",
    "settled unread success",
  ])("matches the green rule for %s", async (scenario) => {
    const thread = makeThreadResponse({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    const base = sidebarSdk(() => thread);
    const originalBootstrap = base.projects.sidebarBootstrap;
    const pluginStates =
      scenario.includes("callback") ||
      scenario === "owned worker" ||
      scenario === "open decision" ||
      scenario === "green disabled" ||
      scenario === "unavailable Needs You"
        ? [
            {
              id: "needs-you",
              enabled: true,
              status: scenario === "unavailable Needs You" ? "failed" : "running",
            },
            { id: "decisions", enabled: true, status: "running" },
          ]
        : [];
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        subscribe: () => () => {},
        projects: {
          sidebarBootstrap: async () => {
            if (scenario === "unavailable sidebar") throw new Error("sidebar unavailable");
            const bootstrap = (await originalBootstrap()) as {
              projects: Array<{
                threads: Array<{
                  activity: Record<string, number>;
                  lastReadAt: number;
                  latestAttentionAt: number;
                  queuedWork: string;
                  hasPendingInteraction: boolean;
                }>;
              }>;
            };
            const row = bootstrap.projects[0].threads[0];
            const activityKey = {
              "background command": "activeBackgroundCommandCount",
              workflow: "activeWorkflowCount",
              "plan mode": "activePlanModeCount",
              "goal activity": "activeGoalCount",
            }[scenario];
            if (activityKey) row.activity[activityKey] = 3;
            if (scenario === "already read") row.lastReadAt = row.latestAttentionAt;
            if (scenario === "failed queued send") row.queuedWork = "failed";
            if (scenario === "pending sidebar input") row.hasPendingInteraction = true;
            if (scenario === "missing sidebar row") bootstrap.projects[0].threads = [];
            return bootstrap as never;
          },
        },
        plugins: {
          list: async () => ({ plugins: pluginStates }) as never,
          getSettings: async () =>
            ({
              ok: true,
              schema: {},
              values: { unreadSuccess: scenario !== "green disabled" },
            }) as never,
          callRpc: async (args) => {
            if (scenario === "failed callback read") throw new Error("callbacks unavailable");
            if (args.method === "callbacks.list")
              return {
                waits: scenario === "callback wait" ? [{ threadId: thread.id }] : [],
              } as never;
            if (args.method === "worker-activity.list")
              return { ownerThreadIds: scenario === "owned worker" ? [thread.id] : [] } as never;
            if (args.method === "open_index")
              return {
                threads: scenario === "open decision" ? [{ threadId: thread.id, count: 1 }] : [],
              } as never;
            throw new Error("unexpected RPC");
          },
        },
        threads: {
          get: async () => thread,
          interactions: { list: async () => [] },
          events: {
            list: async (args) =>
              args.types?.includes("thread/goal/updated")
                ? []
                : [
                    {
                      id: "event-1",
                      threadId: thread.id,
                      seq: 99,
                      createdAt: Date.now(),
                      scope: { kind: "turn", turnId: "turn-1" },
                      type: "turn/completed",
                      data: { status: "completed", providerThreadId: "provider-thread-1" },
                    },
                  ],
          },
        },
      },
    });
    await plugin(api);
    try {
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
      const payload = await (await harness.behavior.fetchHttp("GET", "/events?after=0")).json();
      expect(payload.events).toHaveLength(scenario === "settled unread success" ? 1 : 0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

describe("completion after remaining work", () => {
  it("waits for background commands, rechecks playback, and emits once when they finish", async () => {
    let activeCommands = 3;
    let changed:
      | ((event: {
          id: string;
          changes: string[];
          metadata?: { backgroundActivityChanged: boolean };
        }) => void)
      | undefined;
    const thread = makeThreadResponse({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    const base = sidebarSdk(() => thread);
    const { api, harness } = createFakePluginHost({
      pluginId: "chime",
      sdk: {
        ...base,
        subscribe: ((args: { callback: typeof changed }) => {
          changed = args.callback;
          return () => {};
        }) as never,
        projects: {
          sidebarBootstrap: async () => {
            const result = (await base.projects.sidebarBootstrap()) as {
              projects: Array<{
                threads: Array<{ activity: { activeBackgroundCommandCount: number } }>;
              }>;
            };
            result.projects[0].threads[0].activity.activeBackgroundCommandCount = activeCommands;
            return result as never;
          },
        },
        threads: {
          get: async () => thread,
          interactions: { list: async () => [] },
          events: {
            list: async (args) =>
              args.types?.includes("thread/goal/updated")
                ? []
                : [
                    {
                      id: "event-1",
                      threadId: thread.id,
                      seq: 99,
                      createdAt: Date.now(),
                      scope: { kind: "turn", turnId: "turn-1" },
                      type: "turn/completed",
                      data: { status: "completed", providerThreadId: "provider-thread-1" },
                    },
                  ],
          },
        },
      },
    });
    await plugin(api);
    try {
      await harness.behavior.emitThreadEvent("thread.idle", { thread, lastAssistantText: "done" });
      expect(
        (await (await harness.behavior.fetchHttp("GET", "/events?after=0")).json()).events,
      ).toHaveLength(0);
      activeCommands = 0;
      changed?.({
        id: thread.id,
        changes: ["status-changed"],
        metadata: { backgroundActivityChanged: true },
      });
      await vi.waitFor(async () =>
        expect(
          (await (await harness.behavior.fetchHttp("GET", "/events?after=0")).json()).events,
        ).toHaveLength(1),
      );
      activeCommands = 1;
      expect(
        await (
          await harness.behavior.fetchHttp("GET", "/completion?threadId=thread-1&turnSeq=99")
        ).json(),
      ).toEqual({ play: false });
      activeCommands = 0;
      changed?.({
        id: thread.id,
        changes: ["status-changed"],
        metadata: { backgroundActivityChanged: true },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(
        (await (await harness.behavior.fetchHttp("GET", "/events?after=0")).json()).events,
      ).toHaveLength(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { PluginApi } from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  experimental_threadIndicatorCases,
  makeHostResponse,
  makeQueueEntry,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import {
  ASSESSMENT_VERSION,
  poolPredictionSchema,
  predictionSchema,
} from "./contract";
import plugin from "./server";

type WorkSummary = NonNullable<
  Awaited<ReturnType<PluginApi["sdk"]["threads"]["list"]>>[number]["work"]
>;

type ThreadWorkActivity = WorkSummary["activity"][number];

type ThreadWorkInput = WorkSummary["requiredInput"][number];

type ThreadWorkAssessment = Extract<
  Parameters<
    PluginApi["sdk"]["threads"]["experimental_publishWork"]
  >[0]["contribution"],
  { kind: "assessment" }
>["assessment"];

type HostResult = {
  text: string | null;
  promptVersion: string;
  noSuggestionReason?: string | null;
  archiveReadiness: {
    ready: boolean;
    reason: string;
    waitingOn?: string | null;
    ask?: string | null;
    recap?: string | null;
  } | null;
  tag?: string | null;
};

function pendingPrediction() {
  let resolve = (_value: HostResult) => {};

  let reject = (_error: Error) => {};

  const promise = new Promise<HostResult>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

const loaded: ReturnType<typeof createFakePluginHost>[] = [];

async function setup() {
  const pending = pendingPrediction();

  const source = {
    threadReadGate: null as Promise<void> | null,
    hostChanged: null as ((connected: boolean) => void) | null,
    thread: {
      ...makeThreadResponse({
        id: "thr_one",
        providerId: "codex",
        status: "idle",
        latestAttentionAt: 1,
      }),
      environment: { hostId: "host_source", path: "/work/source" },
    },
    host: makeHostResponse({ id: "host_source", status: "connected" }),
    events: [
      {
        id: "event_1",
        scope: { kind: "turn", turnId: "turn_one" },
        threadId: "thr_one",
        seq: 41,
        createdAt: 1,
        type: "turn/completed",
        data: {
          status: "completed",
          providerThreadId: "native_one",
          providerCheckpointId: "turn_one",
        },
      },
    ],
    replies: [
      reply("The requested work was delivered and checked."),
    ] as unknown[],
    reportEvents: null as {
      started: unknown[];
      requests: unknown[];
      accepted: unknown[];
    } | null,
    hasPendingInteraction: false,
    queuedWork: "none" as "none" | "waiting" | "failed",
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 0,
      activeGoalCount: 0,
      activeSubagentCount: 0,
    },
    callbacks: [] as { threadId: string }[],
    dependencyFailed: false,
    decisions: [] as { threadId: string; count: number }[],
    workerOwners: [] as string[],
    resourceJobs: [] as { machine: string }[],
    resourcesComplete: true,
    chatTopics: null as {
      enabled: boolean;
      tags:
        | { id: string; label: string; icon: string; description: string }[]
        | Error;
    } | null,
    suggested: [] as unknown[],
  };

  let publishedAssessment: ThreadWorkAssessment | null = null;

  function currentWork() {
    const activity: ThreadWorkActivity[] = [];
    const requiredInput: ThreadWorkInput[] = [];

    for (const [kind, count] of [
      [
        "workflow",
        source.activity.activeWorkflowCount + source.workerOwners.length,
      ],
      [
        "agent",
        source.activity.activeBackgroundAgentCount +
          (source.dependencyFailed ? 0 : source.callbacks.length),
      ],
      ["command", source.activity.activeBackgroundCommandCount],
      ["plugin", source.resourceJobs.length],
    ] as const)
      if (count > 0)
        activity.push({
          id: kind,
          kind,
          label: `${kind} running`,
          phase: "running",
          actor: { kind: "agent", id: kind, label: kind },
        });

    if (
      source.hasPendingInteraction ||
      source.decisions.some((decision) => decision.count > 0)
    )
      requiredInput.push({
        id: "question",
        kind: "question",
        label: "Answer the pending question.",
      });

    const basis = JSON.stringify({ sequence: source.events[0]?.seq });

    const base = experimental_threadIndicatorCases.find(
      (entry) => entry.state.work?.primary.label === "open",
    )?.state.work;

    if (base === null || base === undefined)
      throw new Error("Work fixture missing");

    const eligible =
      source.resourcesComplete &&
      source.activity.activePlanModeCount === 0 &&
      source.activity.activeGoalCount === 0 &&
      activity.length === 0 &&
      requiredInput.length === 0 &&
      !source.dependencyFailed &&
      source.callbacks.length === 0;

    const assessment = publishedAssessment;
    const fresh = assessment?.basis === basis;

    return {
      ...base,
      revision: basis,
      basis,
      activity,
      requiredInput,
      assessment: {
        ...base.assessment,
        availability: fresh
          ? assessment.availability
          : assessment === null
            ? "missing"
            : "stale",
        reason: fresh ? assessment.reason : base.assessment.reason,
        suggestion:
          !fresh || assessment.availability !== "available"
            ? "unavailable"
            : assessment.text?.trim()
              ? "available"
              : "omitted",
        noSuggestionReason: fresh ? assessment.noSuggestionReason : null,
      },
      failures: source.dependencyFailed
        ? [
            {
              code: "dependency-failed",
              text: "Dependency failed.",
              sourceId: null,
            },
          ]
        : [],
      archive: {
        eligible,
        recommended:
          eligible &&
          assessment?.basis === basis &&
          assessment.archiveReady === true,
        reason: "Server-owned eligibility.",
      },
    } satisfies WorkSummary;
  }

  Object.defineProperty(source.thread, "work", {
    get: currentWork,
    enumerable: true,
  });

  const host = createFakePluginHost({
    pluginId: "omnyo--composer-predictions",
    settings: { enabled: true, cliPath: "/tools/codex" },
    sdk: {
      experimental_attention: {
        snapshot: () => ({
          questions: source.decisions.filter((entry) => entry.count > 0),
          callbacks: source.callbacks,
        }),
      },
      subscribe: (args: Parameters<PluginApi["sdk"]["subscribe"]>[0]) => {
        if (args.event === "host:changed")
          source.hostChanged = (connected) =>
            args.callback({
              type: "changed",
              entity: "host",
              id: "host_source",
              changes: [connected ? "host-connected" : "host-disconnected"],
            });

        return () => {};
      },
      threads: {
        experimental_publishWork: (input) => {
          if (input.contribution.kind !== "assessment")
            throw new Error("Unexpected producer publication");

          if (input.contribution.assessment.basis !== currentWork().basis)
            throw Object.assign(new Error("Work basis changed"), {
              status: 409,
            });
          publishedAssessment = input.contribution.assessment;

          return currentWork();
        },
        get: async () => {
          if (source.threadReadGate) await source.threadReadGate;

          return source.thread;
        },
        list: (input?: { hasParent?: boolean }) =>
          [
            {
              ...source.thread,
              activity: {
                ...source.activity,
                activeWorkflowCount: Math.max(
                  source.activity.activeWorkflowCount,
                  source.workerOwners.includes(source.thread.id) ? 1 : 0,
                ),
              },
              hasPendingInteraction: source.hasPendingInteraction,
              queuedWork: source.queuedWork,
              attention: {
                kind: source.callbacks.some(
                  (wait) => wait.threadId === source.thread.id,
                )
                  ? source.dependencyFailed
                    ? "dependency-failed"
                    : "callback-waiting"
                  : "none",
                requiredCount: 0,
                optionalCount: 0,
                callback: null,
              },
            },
          ].filter(
            (thread) =>
              input?.hasParent === undefined ||
              input.hasParent === (thread.parentThreadId !== null),
          ),
        events: {
          list: (input: { types?: readonly string[] }) => {
            if (source.reportEvents) {
              switch (input.types?.[0]) {
                case "turn/started":
                  return source.reportEvents.started;
                case "client/turn/requested":
                  return source.reportEvents.requests;
                case "turn/input/accepted":
                  return source.reportEvents.accepted;
              }
            }

            return input.types?.includes("item/completed")
              ? source.replies
              : source.events;
          },
        },
      },
      hosts: { get: () => source.host },
      plugins: {
        list: () => ({
          plugins: [
            { id: "needs-you", enabled: true, status: "loaded" },
            { id: "decisions", enabled: true, status: "loaded" },
            { id: "resources", enabled: true, status: "loaded" },
            ...(source.chatTopics
              ? [
                  {
                    id: "chat-topics",
                    enabled: source.chatTopics.enabled,
                    status: "loaded",
                  },
                ]
              : []),
          ],
        }),
        callRpc: async ({ method, input, outputSchema }) => {
          if (method === "tags.list") {
            expect(input).toEqual({});

            if (source.chatTopics?.tags instanceof Error)
              throw source.chatTopics.tags;

            return outputSchema.parse({ tags: source.chatTopics?.tags ?? [] });
          }

          if (method === "tag.suggest") {
            source.suggested.push(input);

            return { applied: true };
          }

          if (method === "callbacks.list") return { waits: source.callbacks };

          if (method === "open_index") return { threads: source.decisions };

          if (method === "worker-activity.list")
            return { ownerThreadIds: source.workerOwners };

          if (method === "thread_work")
            return {
              complete: source.resourcesComplete,
              jobs: source.resourceJobs,
            };

          return method.endsWith(".predict")
            ? pending.promise.then((result) =>
                poolPredictionSchema.parse(result),
              )
            : { cancelled: true };
        },
      },
    },
  });

  loaded.push(host);
  await plugin(host.api);

  const state = async () =>
    predictionSchema.parse(
      await host.harness.callRpc("state", { threadId: "thr_one" }),
    );

  const request = async () =>
    predictionSchema.parse(
      await host.harness.callRpc("request", { threadId: "thr_one" }),
    );

  return { ...host, pending, source, state, request };
}

const poolCallSchema = z.object({
  method: z.string(),
  pluginId: z.string(),
  input: z.object({
    threadId: z.string(),
    requestId: z.string(),
    cliPath: z.string().optional(),
    claudeCliPath: z.string().optional(),
    includedOnly: z.boolean().optional(),
    backend: z.enum(["codex", "claude"]).optional(),
    model: z.string().optional(),
    tags: z
      .array(z.object({ id: z.string(), description: z.string() }).strict())
      .optional(),
    force: z.boolean().optional(),
  }),
  signal: z
    .custom<AbortSignal>((value) => value instanceof AbortSignal)
    .optional(),
});

function poolCalls(test: ReturnType<typeof createFakePluginHost>) {
  return test.harness.sdk
    .callsTo("plugins.callRpc")
    .filter(([call]) =>
      z.object({ method: z.string() }).parse(call).method.endsWith(".predict"),
    )
    .map(([call]) => poolCallSchema.parse(call))
    .filter((call) => call.method.endsWith(".predict"));
}

async function complete(
  pending: ReturnType<typeof pendingPrediction>,
  text: string | null,
  archiveReadiness: HostResult["archiveReadiness"] = null,
) {
  pending.resolve({
    text,
    promptVersion: "desktop-v1",
    archiveReadiness,
  });
  await pending.promise;
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function reply(
  text: string,
  options: { turnId?: string; parentToolCallId?: string } = {},
) {
  return {
    id: `reply_${text.length}`,
    scope: { kind: "turn", turnId: options.turnId ?? "turn_one" },
    threadId: "thr_one",
    seq: 40,
    createdAt: 1,
    type: "item/completed",
    data: {
      item: {
        type: "agentMessage",
        id: `message_${text.length}`,
        text,
        ...(options.parentToolCallId === undefined
          ? {}
          : { parentToolCallId: options.parentToolCallId }),
      },
    },
  };
}

const ALLOWANCE_ERROR = "Predictions require fresh included Codex allowance";

afterEach(async () => {
  await Promise.all(loaded.splice(0).map((host) => host.harness.dispose()));
});

function stubIdleChats(
  test: Awaited<ReturnType<typeof setup>>,
  host: ReturnType<typeof createFakePluginHost>,
  chats: { id: string; updatedAt: number }[],
) {
  const listed = (id: string) => {
    const { work } = test.source.thread;

    return {
      ...test.source.thread,
      id,
      updatedAt: chats.find((chat) => chat.id === id)?.updatedAt ?? 0,
      activity: test.source.activity,
      hasPendingInteraction: false,
      queuedWork: "none",
      work:
        id === test.source.thread.id || work === null
          ? work
          : {
              ...work,
              assessment: { ...work.assessment, availability: "missing" },
            },
    };
  };

  host.harness.sdk.stub("threads.get", (input) =>
    listed(z.object({ threadId: z.string() }).parse(input).threadId),
  );
  host.harness.sdk.stub("threads.list", (input) => {
    const { threadIds } = z
      .object({ threadIds: z.array(z.string()).optional() })
      .parse(input);

    return (threadIds ?? chats.map((chat) => chat.id)).map(listed);
  });
}

describe("prediction server public boundaries", () => {
  it("preserves initial prediction catch-up and structural rechecks while skipping unchanged transcript streams", async () => {
    const test = await setup();
    await test.harness.emitThreadEvent("experimental_thread.events", {
      thread: test.source.thread,
      sequence: 1,
      experimental_eventTypes: ["item/agentMessage/delta"],
      experimental_coveredSequence: { from: 1, to: 1 },
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    await complete(test.pending, "Keep the verified next step.");
    await delay(0);
    const reads = test.harness.sdk.callsTo("threads.list").length;

    for (let sequence = 2; sequence <= 21; sequence += 1) {
      await test.harness.emitThreadEvent("experimental_thread.events", {
        thread: test.source.thread,
        sequence,
        experimental_eventTypes: ["item/agentMessage/delta"],
        experimental_coveredSequence: { from: sequence, to: sequence },
      });
    }

    await delay(0);
    expect(test.harness.sdk.callsTo("threads.list")).toHaveLength(reads);
    await test.harness.emitThreadEvent("experimental_thread.events", {
      thread: test.source.thread,
      sequence: 99,
      experimental_eventTypes: ["item/backgroundTask/progress"],
      experimental_coveredSequence: { from: 22, to: 22 },
    });
    await vi.waitFor(() =>
      expect(test.harness.sdk.callsTo("threads.list").length).toBeGreaterThan(
        reads,
      ),
    );
    await delay(0);
    expect(poolCalls(test)).toHaveLength(1);
    expect(await test.state()).toMatchObject({
      status: "ready",
      text: "Keep the verified next step.",
    });
  });

  it("retains an omission reason through realtime, CLI and reload without new inference", async () => {
    const test = await setup();
    test.source.activity.activeBackgroundCommandCount = 1;
    await test.request();
    const noSuggestionReason = "The release job already owns the next step.";
    test.pending.resolve({
      text: null,
      noSuggestionReason,
      promptVersion: "desktop-v1",
      archiveReadiness: null,
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "ready",
        text: null,
        noSuggestionReason,
      }),
    );
    expect(test.harness.realtimeSignals.at(-1)).toMatchObject({
      payload: { noSuggestionReason },
    });
    const cli = await test.harness.runCli(["status", "thr_one", "--json"]);
    expect(JSON.parse(cli.stdout)).toMatchObject({ noSuggestionReason });
    const plain = await test.harness.runCli(["status", "thr_one"]);
    expect(plain.stdout).toContain(`No suggested reply. ${noSuggestionReason}`);
    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    expect(
      await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
    ).toMatchObject({ status: "ready", noSuggestionReason });
    expect(poolCalls(reloaded)).toHaveLength(0);
    await reloaded.harness.emitThreadEvent("thread.active", {
      thread: test.source.thread,
    });
    expect(
      await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
    ).toMatchObject({ noSuggestionReason: null });
  });

  describe("finished chats", () => {
    it("require a reply without marking the request as forced", async () => {
      const test = await setup();
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input.force).toBe(true);
      await complete(test.pending, "Ship the runtime and web release.");
      expect(await test.state()).toMatchObject({
        status: "ready",
        text: "Ship the runtime and web release.",
      });
      expect(await test.state()).not.toHaveProperty("forced");
    });

    it("require a reply from background predictions", async () => {
      const test = await setup();
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input.force).toBe(true);
    });

    it("predict again over a stored omission after a reload", async () => {
      const test = await setup();
      await test.request();
      test.pending.resolve({
        text: null,
        noSuggestionReason: "The work is complete.",
        promptVersion: "desktop-v1",
        archiveReadiness: { ready: true, reason: "Done." },
      });
      await vi.waitFor(() =>
        expect(test.source.thread.work?.assessment.suggestion).toBe("omitted"),
      );
      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      expect(
        await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
      ).toMatchObject({ noSuggestionReason: null });
      expect(poolCalls(reloaded)).toHaveLength(0);

      reloaded.harness.runService("prewarm");
      await vi.waitFor(() => expect(poolCalls(reloaded)).toHaveLength(1));
      expect(poolCalls(reloaded)[0]?.input.force).toBe(true);
    });

    it("keep a dismissed reply dismissed after a reload", async () => {
      const test = await setup();
      await test.request();
      await complete(test.pending, "A suggested reply", {
        ready: true,
        reason: "Done.",
      });
      const before = await test.state();
      await test.harness.callRpc("dismiss", {
        threadId: "thr_one",
        generation: before.generation,
      });
      await vi.waitFor(() =>
        expect(test.source.thread.work?.assessment.suggestion).toBe("omitted"),
      );
      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      reloaded.harness.runService("prewarm");
      await delay(10);
      expect(poolCalls(reloaded)).toHaveLength(0);
      expect(
        await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
      ).toMatchObject({ status: "none", text: null });
    });
  });

  it("reads historical cached predictions without inventing an omission reason", async () => {
    const test = await setup();
    await test.api.storage.kv.set("prediction:v1:thr_one", {
      sourceSeq: 41,
      state: {
        threadId: "thr_one",
        generation: 1,
        status: "ready",
        text: null,
        message: null,
        archiveReadiness: {
          ready: false,
          reason: "Work remains.",
          waitingOn: null,
        },
      },
    });
    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    expect(
      await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
    ).toMatchObject({ status: "idle", noSuggestionReason: null, basis: null });
    expect(poolCalls(reloaded)).toHaveLength(0);
  });

  it.each([
    ["codex", { backend: "codex", model: "gpt-6.1-sol" }],
    ["claude-code", { backend: "claude", model: "claude-haiku-5-5" }],
    ["acp", { backend: "codex", model: "gpt-6.1-sol" }],
  ])(
    "predicts %s chats with their default provider",
    async (providerId, expected) => {
      const test = await setup();
      test.source.thread.providerId = providerId;

      await test.request();
      expect(poolCalls(test)[0]?.input).toMatchObject({
        ...expected,
        cliPath: "/tools/codex",
        claudeCliPath: "claude",
      });
    },
  );

  it("routes a provider's chats to the backend and model chosen in settings", async () => {
    const test = await setup();
    await test.harness.setSettings({
      codexChats: "claude",
      claudeModel: "claude-sonnet-5-5",
    });

    await test.request();
    expect(poolCalls(test)[0]?.input).toMatchObject({
      backend: "claude",
      model: "claude-sonnet-5-5",
    });
  });

  it.each([
    [
      "codex",
      "OpenAI has not enabled composer predictions for any available account",
      ["codex", "claude"],
    ],
    [
      "claude-code",
      "Predictions need included Claude subscription allowance",
      ["claude", "codex"],
    ],
    ["codex", "private transport detail", ["codex"]],
  ])(
    "for %s chats failing with %j, predicts with %j",
    async (providerId, failure, backends) => {
      const test = await setup();
      test.source.thread.providerId = providerId;
      const [primary] = backends;

      test.harness.sdk.stub("plugins.callRpc", async ({ method, input }) => {
        if (!z.string().parse(method).endsWith(".predict"))
          return { cancelled: true };

        if (z.object({ backend: z.string() }).parse(input).backend === primary)
          throw new Error(failure);

        return { text: "Ship it.", archiveReadiness: null };
      });

      await test.request();
      await vi.waitFor(async () =>
        expect((await test.state()).status).toBe(
          backends.length === 2 ? "ready" : "failed",
        ),
      );
      const calls = poolCalls(test);
      expect(calls.map(({ input }) => input.backend)).toEqual(backends);
      expect(new Set(calls.map(({ input }) => input.requestId)).size).toBe(
        backends.length,
      );
    },
  );

  it.each([
    ["claude-code", "manual"],
    ["claude-code", "background"],
    ["acp", "manual"],
    ["acp", "background"],
  ])(
    "predicts completed %s turns through %s admission",
    async (providerId, mode) => {
      const test = await setup();
      test.source.thread.providerId = providerId;
      test.source.events[0]!.data.providerCheckpointId = "";

      if (mode === "manual") await test.request();
      else
        await test.harness.emitThreadEvent("thread.idle", {
          thread: test.source.thread,
          lastAssistantText: null,
        });
      await complete(test.pending, "Verify the delivery.", {
        ready: false,
        reason: "Delivery remains.",
      });
      expect(poolCalls(test)).toHaveLength(1);
      expect(await test.state()).toMatchObject({
        status: "ready",
        text: "Verify the delivery.",
        archiveReadiness: { ready: false },
      });
    },
  );

  it("gives the readiness read the same budget as the other admission reads", async () => {
    const test = await setup();
    test.harness.sdk.stub("threads.list", async (input) => {
      const { signal } = z
        .object({ signal: z.custom<AbortSignal>() })
        .parse(input);

      await delay(5500, undefined, { signal });

      return [
        {
          ...test.source.thread,
          activity: test.source.activity,
          hasPendingInteraction: false,
          queuedWork: "none",
        },
      ];
    });
    expect(await test.request()).toMatchObject({ status: "predicting" });
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("allows individually timely readiness reads that exceed five seconds together", async () => {
    const test = await setup();
    test.harness.sdk.stub("threads.list", async (input) => {
      const { signal } = z
        .object({ signal: z.custom<AbortSignal>() })
        .parse(input);

      await delay(2700, undefined, { signal });

      return [
        {
          ...test.source.thread,
          activity: test.source.activity,
          hasPendingInteraction: false,
          queuedWork: "none",
        },
      ];
    });
    test.harness.sdk.stub("plugins.list", async (input) => {
      const { signal } = z
        .object({ signal: z.custom<AbortSignal>() })
        .parse(input);

      await delay(2700, undefined, { signal });

      return { plugins: [] };
    });
    expect(await test.request()).toMatchObject({ status: "predicting" });
    expect(poolCalls(test)).toHaveLength(1);
  });

  it.each([
    [true, null, "Likely ready to archive"],
    [false, null, "More work remains"],
    [false, "App Store review", "Waiting on App Store review"],
  ])(
    "caches and exposes archive readiness (%s, waiting on %s) from background prediction without a next message",
    async (ready, waitingOn, label) => {
      const test = await setup();
      test.source.thread.lastReadAt = 2;
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));

      expect(
        test.harness.sdk.callsTo("experimental_attention.snapshot"),
      ).toHaveLength(0);

      const reason = ready
        ? "All requested work is complete."
        : "Required verification is pending.";

      const archiveReadiness = {
        ready,
        reason,
        waitingOn,
        ask: null,
        recap: null,
      };

      await complete(
        test.pending,
        null,
        waitingOn === null ? { ready, reason } : archiveReadiness,
      );
      expect(await test.request()).toMatchObject({
        status: "ready",
        text: null,
        archiveReadiness,
      });
      const result = await test.harness.runCli(["status", "thr_one", "--json"]);
      expect(JSON.parse(result.stdout).archiveReadiness).toEqual(
        archiveReadiness,
      );
      const plain = await test.harness.runCli(["status", "thr_one"]);
      expect(plain.stdout).toContain(`${label}: ${reason}`);
      expect(poolCalls(test)).toHaveLength(1);
      expect(test.harness.realtimeSignals.at(-1)).toMatchObject({
        payload: { archiveReadiness },
      });
      await vi.waitFor(() =>
        expect(
          test.harness.sdk
            .callsTo("threads.experimental_publishWork")
            .at(-1)?.[0],
        ).toMatchObject({
          contribution: {
            kind: "assessment",
            assessment: { waitingOn, ask: null, recap: null },
          },
        }),
      );
      await test.harness.emitThreadEvent("thread.active", {
        thread: test.source.thread,
      });
      expect(await test.state()).toMatchObject({
        status: "idle",
        archiveReadiness: null,
      });
    },
  );

  it.each([
    "callback",
    "worker",
    "resource job",
    "activeWorkflowCount",
    "activeBackgroundAgentCount",
    "activeBackgroundCommandCount",
  ] as const)(
    "spends no background inference while %s owns work",
    async (condition) => {
      const test = await setup();

      if (condition === "callback")
        test.source.callbacks.push({ threadId: "thr_one" });
      else if (condition === "worker") test.source.workerOwners.push("thr_one");
      else if (condition === "resource job")
        test.source.resourceJobs.push({ machine: "host_source" });
      else test.source.activity[condition] = 1;

      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(async () =>
        expect(
          await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
        ).toMatchObject({ lastSkip: { reason: "owned-work" } }),
      );
      expect(poolCalls(test)).toHaveLength(0);
    },
  );

  it.each([
    "failed dependency",
    "unverified resources",
    "activePlanModeCount",
    "activeGoalCount",
  ] as const)(
    "keeps the model verdict with %s and lets core withhold the recommendation",
    async (condition) => {
      const test = await setup();

      if (condition === "failed dependency") {
        test.source.callbacks.push({ threadId: "thr_one" });
        test.source.dependencyFailed = true;
      } else if (condition === "unverified resources")
        test.source.resourcesComplete = false;
      else test.source.activity[condition] = 1;

      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      await complete(test.pending, "Review the current result.", {
        ready: true,
        reason: "The completed turn is ready.",
      });
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "ready",
          text: "Review the current result.",
          archiveReadiness: { ready: true },
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(false);
    },
  );

  it("keeps a finished result when owned work appears during inference and adopts it once clear", async () => {
    const test = await setup();
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    test.source.callbacks.push({ threadId: "thr_one" });
    await complete(test.pending, "Review the result while the worker runs.", {
      ready: true,
      reason: "The completed turn is ready.",
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "idle",
        text: null,
      }),
    );
    expect(
      await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
    ).toMatchObject({ lastSkip: { reason: "owned-work" } });

    test.source.callbacks.length = 0;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "ready",
        archiveReadiness: { ready: true },
      }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("waits for owned work to clear before spending a background inference", async () => {
    const test = await setup();
    test.source.activity.activeBackgroundCommandCount = 1;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({ lastSkip: { reason: "owned-work" } }),
    );
    expect(poolCalls(test)).toHaveLength(0);

    test.source.activity.activeBackgroundCommandCount = 0;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
  });

  it.each(["child", "hidden", "owned-work"] as const)(
    "keeps a requested suggestion when a background recheck finds a %s chat",
    async (condition) => {
      const test = await setup();

      if (condition === "child")
        test.source.thread.parentThreadId = "thr_parent";
      else if (condition === "hidden") test.source.thread.visibility = "hidden";
      else test.source.activity.activeBackgroundCommandCount = 1;

      const recheck = () =>
        test.harness.emitThreadEvent("thread.idle", {
          thread: test.source.thread,
          lastAssistantText: null,
        });

      const cancellations = () =>
        test.harness.sdk
          .callsTo("plugins.callRpc")
          .filter(([call]) =>
            z
              .object({ method: z.string() })
              .parse(call)
              .method.endsWith(".cancel"),
          );

      await test.harness.callRpc("request", {
        threadId: "thr_one",
        force: true,
      });
      expect(await test.state()).toMatchObject({ status: "predicting" });

      await recheck();
      await delay(5);
      expect(await test.state()).toMatchObject({ status: "predicting" });
      expect(cancellations()).toHaveLength(0);

      await complete(test.pending, "Ship the fix.");
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "ready",
          text: "Ship the fix.",
        }),
      );

      await recheck();
      await delay(5);
      expect(await test.state()).toMatchObject({
        status: "ready",
        text: "Ship the fix.",
      });
      expect(poolCalls(test)).toHaveLength(1);
    },
  );

  it.each(["child", "owned-work"] as const)(
    "keeps a requested failure and its strength when a background recheck finds a %s chat",
    async (condition) => {
      const test = await setup();

      if (condition === "child")
        test.source.thread.parentThreadId = "thr_parent";
      else test.source.activity.activeBackgroundCommandCount = 1;

      await test.harness.callRpc("request", {
        threadId: "thr_one",
        force: true,
      });
      test.pending.reject(
        new Error(
          "Claude did not complete the prediction (status=success, code=api_error).",
        ),
      );

      const failed = {
        status: "failed",
        forced: true,
        message:
          "Claude could not finish the prediction. Omnyo retries automatically.",
      };

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject(failed),
      );

      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await delay(5);
      expect(await test.state()).toMatchObject(failed);
      expect(poolCalls(test)).toHaveLength(1);
    },
  );

  it("keeps a publication-free state read so it cannot feed a work-changed loop", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Next step.", {
      ready: true,
      reason: "Done.",
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "ready" }),
    );

    const publications = () =>
      test.harness.sdk.callsTo("threads.experimental_publishWork").length;

    await vi.waitFor(() => expect(publications()).toBeGreaterThan(0));
    const before = publications();
    await test.state();
    await test.state();
    await delay(5);
    expect(publications()).toBe(before);
  });

  it("does not read or publish a work basis for a skipped running chat", async () => {
    const test = await setup();
    test.source.thread.status = "active";
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({ lastSkip: { reason: "busy" } }),
    );
    await delay(5);
    expect(
      test.harness.sdk.callsTo("threads.experimental_publishWork"),
    ).toHaveLength(0);
  });

  const skipPublications = (test: ReturnType<typeof createFakePluginHost>) =>
    test.harness.sdk
      .callsTo("threads.experimental_publishWork")
      .map(([call]) =>
        z
          .object({
            contribution: z.object({
              assessment: z.object({
                availability: z.string(),
                reason: z.string(),
                basis: z.string(),
              }),
            }),
          })
          .parse(call),
      )
      .map(({ contribution }) => contribution.assessment);

  it.each([
    ["no-completed-turn", "The chat's last turn did not complete."],
    ["child", "Background predictions skip child chats."],
  ] as const)(
    "publishes one skipped assessment for a %s chat across repeated background passes",
    async (condition, reason) => {
      const test = await setup();

      if (condition === "no-completed-turn")
        test.source.events[0].data.status = "interrupted";
      else test.source.thread.parentThreadId = "thr_parent";

      const pass = () =>
        test.harness.emitThreadEvent("thread.idle", {
          thread: test.source.thread,
          lastAssistantText: null,
        });

      await pass();
      await vi.waitFor(() =>
        expect(skipPublications(test)).toEqual([
          {
            availability: "skipped",
            reason,
            basis: test.source.thread.work?.basis,
          },
        ]),
      );
      expect(test.source.thread.work?.assessment).toMatchObject({
        availability: "skipped",
        reason,
      });
      expect(test.source.thread.work?.archive.recommended).toBe(false);

      for (let index = 0; index < 3; index += 1) {
        await pass();
        await delay(5);
      }

      expect(skipPublications(test)).toHaveLength(1);
      expect(await test.state()).toMatchObject({ status: "idle" });
      expect(poolCalls(test)).toHaveLength(0);
    },
  );

  it.each(["closed", "hidden"] as const)(
    "publishes nothing for a %s chat, so no skip outlives its condition",
    async (condition) => {
      const test = await setup();

      if (condition === "hidden") test.source.thread.visibility = "hidden";
      else test.source.thread.archivedAt = 1;

      const pass = () =>
        test.harness.emitThreadEvent("thread.idle", {
          thread: { ...test.source.thread, archivedAt: null },
          lastAssistantText: null,
        });

      await pass();
      await vi.waitFor(async () =>
        expect(
          await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
        ).toMatchObject({ lastSkip: { reason: condition } }),
      );
      await delay(5);

      expect(skipPublications(test)).toEqual([]);
      expect(test.source.thread.work?.assessment.availability).not.toBe(
        "skipped",
      );
    },
  );

  it("republishes a skip when the chat's basis moves", async () => {
    const test = await setup();
    test.source.events[0].data.status = "interrupted";

    const pass = () =>
      test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });

    await pass();
    await vi.waitFor(() => expect(skipPublications(test)).toHaveLength(1));
    test.source.events[0] = { ...test.source.events[0], seq: 42 };
    await pass();
    await vi.waitFor(() => expect(skipPublications(test)).toHaveLength(2));
    expect(skipPublications(test)[1]).toMatchObject({
      availability: "skipped",
      basis: test.source.thread.work?.basis,
    });
  });

  it("keeps a current verdict when a later background pass skips the chat", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, null, { ready: true, reason: "Done." });
    await vi.waitFor(() =>
      expect(test.source.thread.work?.assessment.availability).toBe(
        "available",
      ),
    );
    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    test.source.thread.parentThreadId = "thr_parent";
    await reloaded.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(
        await reloaded.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({ lastSkip: { reason: "child" } }),
    );
    await delay(5);

    expect(
      skipPublications(reloaded).filter(
        ({ availability }) => availability === "skipped",
      ),
    ).toEqual([]);
    expect(test.source.thread.work?.assessment.availability).toBe("available");
  });

  it("lets the background sweep publish a child chat's skip without inference", async () => {
    const test = await setup();
    test.source.thread.parentThreadId = "thr_parent";
    test.harness.runService("prewarm");

    await vi.waitFor(() =>
      expect(skipPublications(test)).toEqual([
        {
          availability: "skipped",
          reason: "Background predictions skip child chats.",
          basis: test.source.thread.work?.basis,
        },
      ]),
    );
    expect(poolCalls(test)).toHaveLength(0);
  });

  it("keeps a published skip when a background recheck cannot read the chat", async () => {
    const test = await setup();
    test.source.events[0].data.status = "interrupted";

    const pass = () =>
      test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });

    await pass();
    await vi.waitFor(() => expect(skipPublications(test)).toHaveLength(1));
    test.harness.sdk.stub("threads.get", () => {
      throw new Error("server stalled");
    });
    await pass();
    await vi.waitFor(() =>
      expect(
        test.harness.logEntries.some((entry) =>
          entry.message.includes("Could not check the chat."),
        ),
      ).toBe(true),
    );
    await delay(5);

    expect(await test.state()).toMatchObject({
      status: "idle",
      message: "The chat's last turn did not complete.",
    });
    expect(skipPublications(test)).toHaveLength(1);
    expect(test.source.thread.work?.assessment.availability).toBe("skipped");
    expect(
      await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
    ).toMatchObject({ lastFailure: null });
  });

  it("keeps a published skip when a reloaded plugin cannot read the chat", async () => {
    const test = await setup();
    test.source.events[0].data.status = "interrupted";

    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(skipPublications(test)).toHaveLength(1));

    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    reloaded.harness.sdk.stub("threads.get", () => {
      throw new Error("server stalled");
    });
    await reloaded.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() =>
      expect(
        reloaded.harness.logEntries.some((entry) =>
          entry.message.includes("Could not check the chat."),
        ),
      ).toBe(true),
    );
    await delay(5);

    expect(skipPublications(reloaded)).toEqual([]);
    expect(test.source.thread.work?.assessment).toMatchObject({
      availability: "skipped",
      reason: "The chat's last turn did not complete.",
    });
    expect(
      await reloaded.harness.callRpc("diagnostics", { threadId: "thr_one" }),
    ).toMatchObject({ lastFailure: null });
  });

  it.each([
    [
      "the chat",
      "threads.get",
      "Could not check the chat. Retry when Omnyo is available.",
    ],
    [
      "its turns",
      "threads.events.list",
      "Could not check the chat’s turns. Retry when Omnyo is available.",
    ],
    [
      "its machine",
      "hosts.get",
      "Could not check the chat’s machine. Retry when Omnyo is available.",
    ],
  ] as const)(
    "names the failed read when %s cannot be read",
    async (_read, method, message) => {
      const test = await setup();
      test.harness.sdk.stub(method, () => {
        throw new Error("server stalled");
      });

      expect(await test.request()).toMatchObject({ status: "failed", message });
    },
  );

  it("keeps a finished verdict when a background recheck cannot read the chat", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, null, { ready: true, reason: "Done." });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "ready" }),
    );

    test.harness.sdk.stub("threads.get", () => {
      throw new Error("server stalled");
    });
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await delay(5);

    expect(await test.state()).toMatchObject({
      status: "ready",
      archiveReadiness: { ready: true },
    });
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("keeps a paid-for result when its validation reads fail", async () => {
    const test = await setup();
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));

    test.harness.sdk.stub("threads.list", () => {
      throw new Error("server stalled");
    });
    await complete(test.pending, null, { ready: true, reason: "Done." });

    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "ready",
        archiveReadiness: { ready: true },
      }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("keeps the model verdict when a chat is ineligible only at that moment", async () => {
    const test = await setup();
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    test.source.dependencyFailed = true;
    await complete(test.pending, null, { ready: true, reason: "Done." });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        archiveReadiness: { ready: true, reason: "Done." },
      }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(false);

    test.source.dependencyFailed = false;
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("keeps retrying a failed assessment until allowance returns", async () => {
    const test = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    let calls = 0;

    test.harness.sdk.stub("plugins.callRpc", async ({ method, input }) => {
      if (!z.string().parse(method).endsWith(".predict"))
        return { cancelled: true };

      if (z.object({ backend: z.string() }).parse(input).backend === "claude")
        throw new Error(
          "Predictions need included Claude subscription allowance",
        );

      calls += 1;

      if (calls <= 4)
        throw new Error("Predictions require fresh included Codex allowance");

      return poolPredictionSchema.parse({
        text: null,
        promptVersion: "desktop-v1",
        archiveReadiness: { ready: true, reason: "Done." },
      });
    });

    try {
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);

      for (const [index, backoff] of [
        30 * 60_000,
        90 * 60_000,
        90 * 60_000,
        90 * 60_000,
      ].entries()) {
        const { lastFailure } = z
          .object({
            lastFailure: z.object({
              failedAt: z.number(),
              retryAt: z.number(),
            }),
          })
          .parse(
            await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
          );

        expect(lastFailure.retryAt - lastFailure.failedAt).toBe(backoff);
        await vi.advanceTimersByTimeAsync(lastFailure.retryAt - Date.now() - 1);
        expect(calls).toBe(index + 1);
        await vi.advanceTimersByTimeAsync(2);
        expect(calls).toBe(index + 2);
      }

      await vi.advanceTimersByTimeAsync(1);
      expect(await test.state()).toMatchObject({
        status: "ready",
        archiveReadiness: { ready: true },
      });
      expect(test.source.thread.work?.archive.recommended).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the stored verdict for the same turn instead of inferring after a failed rerun", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Inspect the result.", {
      ready: true,
      reason: "Done.",
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "ready" }),
    );

    test.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
      if (!z.string().parse(method).endsWith(".predict"))
        return { cancelled: true };

      throw new Error("private transport detail");
    });
    await test.harness.callRpc("request", { threadId: "thr_one", fresh: true });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "failed" }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(false);

    const attempts = poolCalls(test).length;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "ready",
        archiveReadiness: { ready: true },
      }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(attempts);
  });

  it("keeps the stored verdict when a later forced run is cancelled", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Inspect the result.", {
      ready: true,
      reason: "Done.",
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "ready" }),
    );

    await test.harness.callRpc("request", { threadId: "thr_one", force: true });
    const running = await test.state();
    expect(running.status).toBe("predicting");
    await test.harness.callRpc("cancel", {
      threadId: "thr_one",
      generation: running.generation,
    });
    expect(test.source.thread.work?.archive.recommended).toBe(false);

    const attempts = poolCalls(test).length;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({
        status: "ready",
        archiveReadiness: { ready: true },
      }),
    );
    expect(test.source.thread.work?.archive.recommended).toBe(true);
    expect(poolCalls(test)).toHaveLength(attempts);
  });

  it("runs again when the conversation identity moved past a current stored result", async () => {
    const test = await setup();
    await test.api.storage.kv.set("prediction:v1:thr_one", {
      sourceSeq: 41,
      state: {
        threadId: "thr_one",
        generation: 1,
        basis: "before-a-context-clear",
        status: "ready",
        text: "Text for the old context.",
        noSuggestionReason: null,
        message: null,
        archiveReadiness: { ready: true, reason: "Done.", waitingOn: null },
        assessmentVersion: ASSESSMENT_VERSION,
      },
    });
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
  });

  it("forwards the model's ask and recap into the work assessment", async () => {
    const test = await setup();

    const archiveReadiness = {
      ready: false,
      reason: "A release decision is required.",
      waitingOn: null,
      ask: "Approve the release.",
      recap: "The release candidate passed its checks.",
    };

    const request = test.request();
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    await complete(test.pending, null, archiveReadiness);
    await request;
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ archiveReadiness }),
    );
    await vi.waitFor(() =>
      expect(
        test.harness.sdk
          .callsTo("threads.experimental_publishWork")
          .at(-1)?.[0],
      ).toMatchObject({
        contribution: {
          kind: "assessment",
          assessment: {
            ask: "Approve the release.",
            recap: "The release candidate passed its checks.",
          },
        },
      }),
    );
  });

  it("vetoes a positive prediction when the final reply explicitly reports unfinished work", async () => {
    const test = await setup();
    test.source.replies = [
      reply("**TL;DR:** Not ready: Production deployment is still required."),
    ];
    await test.request();
    await complete(test.pending, "Check the deployment.", {
      ready: true,
      reason: "The local change passed lint.",
    });

    await vi.waitFor(async () => {
      expect(await test.state()).toMatchObject({
        text: "Check the deployment.",
        archiveReadiness: {
          ready: false,
          reason: "Not ready: Production deployment is still required.",
        },
      });
      expect(test.source.thread.work?.archive.recommended).toBe(false);
    });
  });

  it("keeps a suggestion but withholds Ready when the final reply is unavailable", async () => {
    const test = await setup();
    test.source.replies = [];
    await test.request();
    await complete(test.pending, "Check the deployment.", {
      ready: true,
      reason: "The local change passed lint.",
    });
    await vi.waitFor(async () => {
      expect(await test.state()).toMatchObject({
        text: "Check the deployment.",
        archiveReadiness: null,
      });
      expect(test.source.thread.work?.archive.recommended).toBe(false);
    });
  });

  describe("without prediction allowance", () => {
    it.each([
      "complete",
      "open",
      "changed",
      "unaccepted",
      "legacy-blocker",
    ] as const)(
      "uses a private %s report only for the same input and turn",
      async (scenario) => {
        const test = await setup();
        const [completed] = test.source.events.splice(0);

        const request = {
          seq: 10,
          type: "client/turn/requested",
          data: { requestId: "request_one" },
        };

        test.source.reportEvents = {
          started: [
            { seq: 11, type: "turn/started", scope: completed.scope, data: {} },
          ],
          requests: [
            scenario === "unaccepted"
              ? { ...request, seq: 30, data: { requestId: "request_two" } }
              : request,
          ],
          accepted: [
            {
              seq: 12,
              type: "turn/input/accepted",
              scope: completed.scope,
              data: { clientRequestId: request.data.requestId },
            },
          ],
        };

        const submitted = test.harness.callAgentTool(
          "report_chat_outcome",
          {
            report:
              scenario === "open"
                ? {
                    status: "open",
                    blocker: "GitHub checks are pending.",
                    next: "Wait for checks.",
                  }
                : {
                    status: "complete",
                    outcome: "The change is active.",
                    evidence: "Read back the active artifact.",
                  },
          },
          { threadId: "thr_one" },
        );

        if (scenario === "unaccepted")
          await expect(submitted).rejects.toThrow("No active chat turn");
        else await expect(submitted).resolves.toBe("Recorded.");

        if (scenario === "changed")
          test.source.reportEvents.requests = [{ ...request, seq: 35 }];

        const unassessed = scenario === "changed" || scenario === "unaccepted";

        test.source.events.push(completed);
        test.source.replies = [
          reply(
            scenario === "legacy-blocker"
              ? "Not ready: Production verification is still pending."
              : "Here’s the result.",
          ),
        ];
        await test.harness.emitThreadEvent("thread.idle", {
          thread: test.source.thread,
          lastAssistantText: null,
        });
        await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
        test.pending.reject(new Error(ALLOWANCE_ERROR));

        await vi.waitFor(async () =>
          expect(await test.state()).toMatchObject({
            status: unassessed ? "failed" : "ready",
            text: null,
            archiveReadiness: unassessed
              ? null
              : {
                  ready: scenario === "complete",
                  reason:
                    scenario === "complete"
                      ? "Read back the active artifact. (reported by the agent)"
                      : scenario === "legacy-blocker"
                        ? "Not ready: Production verification is still pending."
                        : "GitHub checks are pending.",
                },
          }),
        );
        expect(test.source.thread.work?.archive.recommended).toBe(
          scenario === "complete",
        );
      },
    );

    async function settleWithoutAllowance(replies: unknown[]) {
      const test = await setup();
      test.source.replies = replies;
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      test.pending.reject(new Error(ALLOWANCE_ERROR));

      return test;
    }

    it("leaves a partial completion report unassessed", async () => {
      const test = await settleWithoutAllowance([
        reply(
          "Production deployment is pending.\nCompleted: Local patch; verified: lint passed.",
        ),
      ]);

      await vi.waitFor(async () => {
        expect(await test.state()).toMatchObject({
          status: "failed",
          archiveReadiness: null,
        });
        expect(test.source.thread.work?.archive.recommended).toBe(false);
      });
    });

    it.each([
      "Completed: The requested change is delivered; verified: focused tests and active artifact readback.",
      "**Completed:** The requested change is delivered; **verified:** focused tests and active artifact readback.",
      "**Completed**: The requested change is delivered; **verified**: focused tests and active artifact readback.",
      "completed: The requested change is delivered; VERIFIED: focused tests and active artifact readback.",
    ])("leaves an unchecked completion claim unassessed: %s", async (text) => {
      const test = await settleWithoutAllowance([reply(text)]);
      await vi.waitFor(async () => {
        expect(await test.state()).toMatchObject({
          status: "failed",
          archiveReadiness: null,
        });
        expect(test.source.thread.work?.archive.recommended).toBe(false);
      });
    });

    it.each([
      "The change is delivered and verified.",
      "The requested feature is still unverified. Waiting for the worker to finish.",
      "Source implementation is complete. Deployment remains blocked.",
      "Completed: ; verified: focused tests.",
      "Completed: The change is delivered; verified: .",
      "Completed: The change is delivered.",
      "Completed: <requested outcome>; verified: <concrete evidence>.",
      "Completed: one result; verified: first check.\nCompleted: another result; verified: second check.",
      "> Completed: The change is delivered; verified: focused tests.",
      "```text\nCompleted: The change is delivered; verified: focused tests.\n```",
    ])(
      "leaves readiness unassessed without a concrete completion report: %s",
      async (text) => {
        const test = await settleWithoutAllowance([reply(text)]);

        await vi.waitFor(async () =>
          expect(await test.state()).toMatchObject({
            status: "failed",
            message: "Predictions need fresh included Codex allowance.",
            archiveReadiness: null,
          }),
        );
        expect(test.source.thread.work?.archive.recommended).toBe(false);
        expect(
          await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
        ).toMatchObject({ lastFailure: { retryAt: expect.any(Number) } });
        expect(poolCalls(test)).toHaveLength(2);
      },
    );

    it.each([
      "**Not ready:** the release is pending; stopped because the job is still running.",
      "**Not ready**: the release is pending; stopped because the job is still running.",
      "Not Ready: the release is pending; stopped because the job is still running.",
      "- **Not ready**: the release is pending; stopped because the job is still running.",
      "Built it.\n\nNot ready: the release is pending; stopped because the job is still running.",
      "Built it. Not ready: the release is pending; stopped because the job is still running.",
      "Completed: source work; verified: focused tests.\nNot ready: the release is pending; stopped because the job is still running.",
      "Not ready: the release is pending; stopped because the job is still running.\nCompleted: source work; verified: focused tests.",
    ])("keeps the chat open when the final report says %s", async (text) => {
      const test = await settleWithoutAllowance([reply(text)]);

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "ready",
          archiveReadiness: {
            ready: false,
            reason:
              "Not ready: the release is pending; stopped because the job is still running.",
            ask: null,
            recap:
              "the release is pending; stopped because the job is still running.",
          },
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(false);
    });

    it("does not read a quoted mention of the convention as unfinished work", async () => {
      const test = await setup();
      test.source.replies = [
        reply(
          'Tidy now checks for a final "Not ready:" sentence.\n\n> Not ready: this quoted example is not this chat\'s state.\n\nCompleted: the requested Tidy change is delivered; verified: focused integration tests.',
        ),
      ];
      await test.request();
      await complete(test.pending, null, {
        ready: true,
        reason: "The change is verified.",
      });

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          archiveReadiness: { ready: true },
        }),
      );
    });

    it("takes no report from an earlier turn or a sub-agent", async () => {
      const test = await settleWithoutAllowance([
        reply("Not ready: Sub-agent work remains.", {
          parentToolCallId: "tool_1",
        }),
        reply("Not ready: Earlier work remains.", {
          turnId: "turn_zero",
        }),
      ]);

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "failed",
          message: "Predictions need fresh included Codex allowance.",
          archiveReadiness: null,
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(false);
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({ lastFailure: { retryAt: expect.any(Number) } });
    });

    it("reads a short first page and pages back only when the report is older", async () => {
      const test = await setup();

      const older = [
        ...Array.from({ length: 8 }, (_, index) => ({
          ...reply(`Sub-agent note ${index}`, { parentToolCallId: "tool_1" }),
          seq: 39 - index,
        })),
        {
          ...reply("Not ready: Deployment is still required."),
          seq: 31,
        },
      ];

      test.harness.sdk.stub(
        "threads.events.list",
        (input: {
          types?: readonly string[];
          beforeSeq?: string;
          limit?: string;
        }) =>
          input.types?.includes("item/completed")
            ? older
                .filter((event) => event.seq < Number(input.beforeSeq))
                .slice(0, Number(input.limit))
            : test.source.events,
      );
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      test.pending.reject(new Error(ALLOWANCE_ERROR));

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          archiveReadiness: {
            ready: false,
            reason: "Not ready: Deployment is still required.",
          },
        }),
      );

      const reads = test.harness.sdk.callsTo("threads.events.list");

      expect(reads).toContainEqual([
        expect.objectContaining({ types: ["item/completed"], limit: "8" }),
      ]);
      expect(reads).toContainEqual([
        expect.objectContaining({
          types: ["item/completed"],
          limit: "42",
          beforeSeq: "32",
        }),
      ]);
    });

    it("keeps the stored model verdict when a fresh run hits the allowance limit", async () => {
      const test = await setup();
      test.source.replies = [
        reply("The requested work was delivered and checked."),
      ];
      await test.request();
      await complete(test.pending, null, { ready: true, reason: "Done." });
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "ready" }),
      );

      test.harness.sdk.stub("plugins.callRpc", async ({ method }) => {
        if (!z.string().parse(method).endsWith(".predict"))
          return { cancelled: true };

        throw new Error(ALLOWANCE_ERROR);
      });
      await test.harness.callRpc("request", {
        threadId: "thr_one",
        fresh: true,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(3));
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "ready",
          archiveReadiness: { ready: true, reason: "Done." },
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(true);
    });

    it("rejects a same-basis Ready cache from the previous assessment version", async () => {
      const test = await setup();
      test.source.replies = [
        reply("Source implementation is complete. Deployment remains blocked."),
      ];
      await test.api.storage.kv.set("prediction:v1:thr_one", {
        sourceSeq: 41,
        state: {
          threadId: "thr_one",
          generation: 1,
          basis: test.source.thread.work?.basis,
          status: "ready",
          text: null,
          noSuggestionReason:
            "Predictions need fresh included Codex allowance.",
          message: null,
          archiveReadiness: {
            ready: true,
            reason: "The work was assessed as complete.",
            waitingOn: null,
          },
          assessmentVersion: 2,
        },
      });
      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      expect(
        await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
      ).toMatchObject({ archiveReadiness: null });
      expect(test.source.thread.work?.archive.recommended).toBe(false);

      await reloaded.harness.callRpc("request", {
        threadId: "thr_one",
        fresh: true,
      });
      await vi.waitFor(() => expect(poolCalls(reloaded)).toHaveLength(1));
      test.pending.reject(new Error(ALLOWANCE_ERROR));
      await vi.waitFor(async () =>
        expect(
          await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
        ).toMatchObject({
          status: "failed",
          message: "Predictions need fresh included Codex allowance.",
          archiveReadiness: null,
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(false);
    });

    it("still shows the allowance failure on a forced suggestion", async () => {
      const test = await setup();
      test.source.replies = [
        reply("Completed: the requested change; verified: focused tests."),
      ];
      await test.harness.callRpc("request", {
        threadId: "thr_one",
        force: true,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      test.pending.reject(new Error(ALLOWANCE_ERROR));

      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "failed",
          message: "Predictions need fresh included Codex allowance.",
        }),
      );
    });
  });

  it.each([
    { verdict: "model verdict", reason: "Done.", assessmentVersion: undefined },
    {
      verdict: "current model verdict",
      reason: "The requested result and its verification are complete.",
      assessmentVersion: ASSESSMENT_VERSION,
    },
  ])(
    "restores a stored $verdict only under the current policy and basis",
    async ({ reason, assessmentVersion }) => {
      const test = await setup();
      await test.api.storage.kv.set("prediction:v1:thr_one", {
        sourceSeq: 41,
        state: {
          threadId: "thr_one",
          generation: 1,
          basis:
            assessmentVersion === undefined
              ? "basis-from-an-earlier-core"
              : test.source.thread.work?.basis,
          status: "ready",
          text: "Inspect the result.",
          noSuggestionReason: null,
          message: null,
          archiveReadiness: { ready: true, reason, waitingOn: null },
          assessmentVersion,
        },
      });
      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      await vi.waitFor(async () =>
        expect(
          await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
        ).toMatchObject({
          archiveReadiness:
            assessmentVersion === undefined ? null : { ready: true, reason },
        }),
      );
      expect(test.source.thread.work?.archive.recommended).toBe(
        assessmentVersion !== undefined,
      );
      expect(poolCalls(reloaded)).toHaveLength(0);
    },
  );

  it.each([
    ["an older not-ready verdict", { ready: false, reason: "Remaining." }],
    ["an older ready verdict", { ready: true, reason: "Done." }],
  ])(
    "reassesses results from an older rubric: %s",
    async (_case, archiveReadiness) => {
      const test = await setup();
      await test.api.storage.kv.set("prediction:v1:thr_one", {
        sourceSeq: 41,
        state: {
          threadId: "thr_one",
          generation: 1,
          basis: "basis-from-an-earlier-core",
          status: "ready",
          text: null,
          noSuggestionReason: null,
          message: null,
          archiveReadiness: { waitingOn: null, ...archiveReadiness },
        },
      });
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    },
  );

  it("does not rebind a legacy Ready verdict to a new conversation basis", async () => {
    const test = await setup();
    await test.api.storage.kv.set("prediction:v1:thr_one", {
      sourceSeq: 41,
      state: {
        threadId: "thr_one",
        generation: 1,
        basis: "basis-from-an-earlier-core",
        status: "ready",
        text: null,
        noSuggestionReason: null,
        message: null,
        archiveReadiness: { ready: true, reason: "Done.", waitingOn: null },
        assessmentVersion: 1,
      },
    });
    expect(await test.state()).toMatchObject({ archiveReadiness: null });
    expect(test.source.thread.work?.archive.recommended).toBe(false);
  });

  it("warms a green chat after its pending question is resolved", async () => {
    const test = await setup();
    test.source.hasPendingInteraction = true;
    test.harness.runService("prewarm");

    const subscribed = () =>
      test.harness.sdk
        .callsTo("subscribe")
        .find(
          ([value]) =>
            z.object({ event: z.string() }).parse(value).event ===
            "thread:changed",
        );

    await vi.waitFor(() => expect(subscribed()).toBeDefined());
    const [subscription] = subscribed()!;

    const { callback } = z
      .object({
        callback: z.custom<(event: { id: string; changes: string[] }) => void>(
          (value) => typeof value === "function",
        ),
      })
      .parse(subscription);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(poolCalls(test)).toHaveLength(0);
    test.source.hasPendingInteraction = false;
    callback({ id: "thr_one", changes: ["interactions-changed"] });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
  });

  it("records once why background prediction skipped a chat", async () => {
    const test = await setup();
    test.source.hasPendingInteraction = true;
    test.harness.runService("prewarm");

    const diagnostics = () =>
      test.harness.callRpc("diagnostics", { threadId: "thr_one" });

    const skipped = () =>
      test.harness.logEntries.filter((entry) =>
        entry.message.startsWith("Prediction skipped:"),
      );

    await vi.waitFor(async () =>
      expect(await diagnostics()).toEqual({
        threadId: "thr_one",
        lastFailure: null,
        lastSkip: {
          threadId: "thr_one",
          sourceSeq: 41,
          skippedAt: expect.any(Number),
          reason: "awaiting-answer",
          message: "The chat was waiting for an answer.",
        },
      }),
    );

    const subscription = test.harness.sdk
      .callsTo("subscribe")
      .find(
        ([value]) =>
          z.object({ event: z.string() }).parse(value).event ===
          "thread:changed",
      );

    const { callback } = z
      .object({
        callback: z.custom<(event: { id: string; changes: string[] }) => void>(
          (value) => typeof value === "function",
        ),
      })
      .parse(subscription?.[0]);

    callback({ id: "thr_one", changes: ["interactions-changed"] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(skipped()).toHaveLength(1);
    test.source.hasPendingInteraction = false;
    test.source.queuedWork = "waiting";
    callback({ id: "thr_one", changes: ["queue-changed"] });
    await vi.waitFor(async () =>
      expect(await diagnostics()).toMatchObject({
        lastSkip: { reason: "queued", sourceSeq: 41 },
      }),
    );
    expect(skipped()).toHaveLength(2);
    expect(poolCalls(test)).toHaveLength(0);
  });

  it("serializes background inference and prioritizes the latest completed chat", async () => {
    const test = await setup();
    test.harness.sdk.stub("threads.get", (input) => ({
      ...test.source.thread,
      id: z.object({ threadId: z.string() }).parse(input).threadId,
    }));
    test.harness.sdk.stub("threads.list", (input) => {
      const { threadIds } = z
        .object({ threadIds: z.array(z.string()) })
        .parse(input);

      return threadIds.map((id) => ({
        ...test.source.thread,
        id,
        activity: test.source.activity,
        hasPendingInteraction: false,
        queuedWork: "none",
      }));
    });
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    await test.harness.emitThreadEvent("thread.idle", {
      thread: { ...test.source.thread, id: "thr_two" },
      lastAssistantText: null,
    });
    await test.harness.emitThreadEvent("thread.idle", {
      thread: { ...test.source.thread, id: "thr_three" },
      lastAssistantText: null,
    });

    for (const threadId of ["thr_two", "thr_three"])
      await vi.waitFor(async () =>
        expect(await test.harness.callRpc("state", { threadId })).toMatchObject(
          { status: "predicting" },
        ),
      );
    expect(poolCalls(test).map((call) => call.input.threadId)).toEqual([
      "thr_one",
    ]);
    await complete(test.pending, "Review the completed work.");
    await vi.waitFor(() =>
      expect(poolCalls(test).map((call) => call.input.threadId)).toEqual([
        "thr_one",
        "thr_three",
        "thr_two",
      ]),
    );
  });

  it.each(["question", "queue"])(
    "discards a prediction when %s appears before completion",
    async (condition) => {
      const test = await setup();
      await test.request();

      if (condition === "question") test.source.hasPendingInteraction = true;

      if (condition === "queue") test.source.queuedWork = "waiting";
      await complete(test.pending, "This suggestion is no longer relevant.", {
        ready: true,
        reason: "The previous work was complete.",
      });
      expect(await test.state()).toMatchObject({
        status: "idle",
        text: null,
        archiveReadiness: null,
      });
    },
  );

  it.each([false, true])(
    "keeps a formed verdict without new inference while work changes (reload %s)",
    async (reload) => {
      const test = await setup();
      await test.request();
      await complete(test.pending, "Cached next step.", {
        ready: true,
        reason: "Work is complete.",
      });
      await vi.waitFor(() =>
        expect(test.source.thread.work?.archive.recommended).toBe(true),
      );
      test.source.resourcesComplete = false;
      const active = reload ? await test.harness.reload(plugin) : test;

      if (reload) loaded.push(active);
      const initialCalls = poolCalls(active).length;
      active.harness.runService("prewarm");
      await delay(5);
      expect(poolCalls(active)).toHaveLength(initialCalls);
      expect(test.source.thread.work?.archive.recommended).toBe(false);

      const subscription = active.harness.sdk
        .callsTo("subscribe")
        .find(
          ([value]) =>
            z.object({ event: z.string() }).parse(value).event ===
            "thread:changed",
        );

      const { callback } = z
        .object({
          callback: z.custom<
            (event: { id: string; changes: string[] }) => void
          >((value) => typeof value === "function"),
        })
        .parse(subscription?.[0]);

      test.source.resourcesComplete = true;
      callback({ id: "thr_one", changes: ["work-changed"] });
      await delay(5);
      expect(poolCalls(active)).toHaveLength(initialCalls);
      expect(test.source.thread.work?.archive.recommended).toBe(true);
    },
  );

  it("restores stored predictions after a reload while new inference is still running", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Cached next step.");
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "ready" }),
    );
    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    stubIdleChats(test, reloaded, [
      { id: "thr_new", updatedAt: 2 },
      { id: "thr_one", updatedAt: 1 },
    ]);
    reloaded.harness.sdk.stub("plugins.callRpc", async (input) => {
      const called = z.object({ method: z.string() }).parse(input).method;

      if (called.endsWith(".predict")) return new Promise(() => {});

      if (called === "callbacks.list") return { waits: [] };

      if (called === "worker-activity.list") return { ownerThreadIds: [] };

      if (called === "open_index") return { threads: [] };

      if (called === "thread_work") return { complete: true, jobs: [] };

      return { cancelled: true };
    });
    const earlierCalls = poolCalls(reloaded).length;
    reloaded.harness.runService("prewarm");

    await vi.waitFor(() =>
      expect(
        poolCalls(reloaded)
          .slice(earlierCalls)
          .map((call) => call.input.threadId),
      ).toEqual(["thr_new"]),
    );
    await vi.waitFor(() =>
      expect(reloaded.harness.realtimeSignals).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({
            threadId: "thr_one",
            status: "ready",
            text: "Cached next step.",
          }),
        }),
      ),
    );
  });

  it("predicts the most recently active idle chats first at startup", async () => {
    const test = await setup();
    stubIdleChats(test, test, [
      { id: "thr_old", updatedAt: 1 },
      { id: "thr_recent", updatedAt: 3 },
      { id: "thr_middle", updatedAt: 2 },
    ]);
    test.harness.runService("prewarm");

    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    expect(poolCalls(test)[0]?.input.threadId).toBe("thr_recent");
  });

  it.each([
    ["a transient", "private transport detail", 2],
    ["an SDK timeout", "BB request timed out after 75 seconds.", 2],
    ["a canonical SDK timeout", "Omnyo request timed out after 75 seconds.", 2],
    ["a permanent", "Native Codex request failed (-32601)", 1],
  ])(
    "retries %s background failure only after its backoff when work changes",
    async (_kind, failure, expectedCalls) => {
      const test = await setup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

      try {
        await test.harness.emitThreadEvent("thread.idle", {
          thread: test.source.thread,
          lastAssistantText: null,
        });
        await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
        test.pending.reject(new Error(failure));
        await vi.waitFor(async () =>
          expect(await test.state()).toMatchObject({ status: "failed" }),
        );
        test.source.resourcesComplete = false;
        await test.harness.emitThreadEvent("experimental_thread.events", {
          thread: test.source.thread,
          sequence: 42,
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(poolCalls(test)).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(61_000);
        await vi.waitFor(() =>
          expect(poolCalls(test)).toHaveLength(expectedCalls),
        );
        await vi.advanceTimersByTimeAsync(60 * 60_000);
        expect(poolCalls(test).length).toBeLessThanOrEqual(
          expectedCalls === 1 ? 1 : 6,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps retrying at the longest delay and advancing diagnostics after identical preparation timeouts", async () => {
    const test = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), milliseconds);

        return controller.signal;
      });

    test.harness.sdk.stub("threads.list", async (input) => {
      const { signal } = z
        .object({
          signal: z.custom<AbortSignal>(
            (value) => value instanceof AbortSignal,
          ),
        })
        .parse(input);

      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    });

    try {
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.advanceTimersByTimeAsync(0);

      for (const [index, backoff] of [
        60_000,
        5 * 60_000,
        20 * 60_000,
      ].entries()) {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(
          await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
        ).toMatchObject({
          lastFailure: {
            stage: "preparation",
            attempt: index + 1,
            failedAt: Date.now(),
            retryAt: Date.now() + backoff,
            requestId: null,
            message:
              "Checking chat work status timed out. Retry the prediction.",
          },
        });

        const attempts = test.harness.sdk.callsTo("threads.list").length;
        await vi.advanceTimersByTimeAsync(backoff - 1);
        expect(test.harness.sdk.callsTo("threads.list")).toHaveLength(attempts);
        await vi.advanceTimersByTimeAsync(1);
        expect(test.harness.sdk.callsTo("threads.list")).toHaveLength(
          attempts + 1,
        );
      }

      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({
        lastFailure: {
          stage: "preparation",
          attempt: 4,
          failedAt: Date.now(),
          retryAt: Date.now() + 20 * 60_000,
        },
      });

      const attempts = test.harness.sdk.callsTo("threads.list").length;
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(test.harness.sdk.callsTo("threads.list")).toHaveLength(
        attempts + 1,
      );
      expect(poolCalls(test)).toHaveLength(0);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["the pool reports it", "The thread’s machine is unavailable", false],
    ["the request fails while it is offline", "private transport detail", true],
  ])(
    "regenerates after reconnecting when %s",
    async (_case, failure, offline) => {
      const test = await setup();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

      try {
        test.harness.runService("prewarm");
        await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));

        if (offline) test.source.host.status = "disconnected";
        test.pending.reject(new Error(failure));
        await vi.waitFor(async () =>
          expect(await test.state()).toMatchObject({
            status: "failed",
            message: expect.stringMatching(/machine/u),
          }),
        );
        test.source.host.status = "disconnected";
        await vi.advanceTimersByTimeAsync(30 * 60_000);
        expect(poolCalls(test)).toHaveLength(1);

        test.source.host.status = "connected";
        test.source.hostChanged?.(true);
        await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reuses the stored prediction for an unchanged source instead of regenerating", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Stored next step.");
    expect(await test.state()).toMatchObject({ status: "ready" });

    await test.harness.emitThreadEvent("message.queued", {
      entry: makeQueueEntry({ threadId: "thr_one" }),
    });
    expect(await test.state()).toMatchObject({ status: "idle", text: null });

    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    await reloaded.harness.emitThreadEvent("message.cancelled", {
      entry: makeQueueEntry({ threadId: "thr_one" }),
    });
    await vi.waitFor(async () =>
      expect(
        await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
      ).toMatchObject({ status: "ready", text: "Stored next step." }),
    );
    expect(poolCalls(reloaded)).toHaveLength(0);
    expect(await reloaded.api.storage.kv.list("prediction:")).toEqual([
      "prediction:v1:thr_one",
    ]);

    await reloaded.harness.emitThreadEvent("thread.deleted", {
      thread: { ...test.source.thread, deletedAt: 2 },
    });
    await vi.waitFor(async () =>
      expect(await reloaded.api.storage.kv.list("prediction:")).toEqual([]),
    );
  });

  it("marks a finished chat as checking while another chat's prediction runs", async () => {
    const test = await setup();
    test.harness.sdk.stub("threads.get", (input) => ({
      ...test.source.thread,
      id: z.object({ threadId: z.string() }).parse(input).threadId,
    }));
    test.harness.sdk.stub("threads.list", (input) => {
      const { threadIds } = z
        .object({ threadIds: z.array(z.string()) })
        .parse(input);

      return threadIds.map((id) => ({
        ...test.source.thread,
        id,
        activity: test.source.activity,
        hasPendingInteraction: false,
        queuedWork: "none",
      }));
    });
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    await test.harness.emitThreadEvent("thread.idle", {
      thread: { ...test.source.thread, id: "thr_two" },
      lastAssistantText: null,
    });

    await vi.waitFor(async () =>
      expect(
        await test.harness.callRpc("state", { threadId: "thr_two" }),
      ).toMatchObject({ status: "predicting" }),
    );
    await vi.waitFor(() =>
      expect(
        test.harness.sdk
          .callsTo("threads.experimental_publishWork")
          .map(([call]) =>
            z
              .object({ threadId: z.string(), contribution: z.unknown() })
              .parse(call),
          )
          .filter((call) => call.threadId === "thr_two")
          .at(-1),
      ).toMatchObject({
        contribution: { assessment: { availability: "checking" } },
      }),
    );
    expect(poolCalls(test).map((call) => call.input.threadId)).toEqual([
      "thr_one",
    ]);

    await complete(test.pending, "Review the completed work.");
    await vi.waitFor(() =>
      expect(poolCalls(test).map((call) => call.input.threadId)).toEqual([
        "thr_one",
        "thr_two",
      ]),
    );
  });

  it("fails a stalled prediction and moves on to the next queued chat", async () => {
    const test = await setup();
    test.harness.sdk.stub("threads.get", (input) => ({
      ...test.source.thread,
      id: z.object({ threadId: z.string() }).parse(input).threadId,
    }));
    test.harness.sdk.stub("threads.list", (input) => {
      const { threadIds } = z
        .object({ threadIds: z.array(z.string()) })
        .parse(input);

      return threadIds.map((id) => ({
        ...test.source.thread,
        id,
        activity: test.source.activity,
        hasPendingInteraction: false,
        queuedWork: "none",
      }));
    });
    test.harness.sdk.stub("plugins.callRpc", async (input) => {
      const { method, signal } = poolCallSchema
        .pick({ method: true, signal: true })
        .parse(input);

      if (!method.endsWith(".predict")) return { cancelled: true };

      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted.")),
        ),
      );
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      await test.harness.emitThreadEvent("thread.idle", {
        thread: test.source.thread,
        lastAssistantText: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      await test.harness.emitThreadEvent("thread.idle", {
        thread: { ...test.source.thread, id: "thr_two" },
        lastAssistantText: null,
      });
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
      expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "failed",
          message: "Prediction timed out. Omnyo retries automatically.",
        }),
      );
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({
        lastFailure: { cause: { kind: "timeout", timeoutMs: 4 * 60_000 } },
      });
      await vi.waitFor(() =>
        expect(poolCalls(test).map((call) => call.input.threadId)).toEqual([
          "thr_one",
          "thr_two",
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores repeated status changes for an archived chat without republishing", async () => {
    const test = await setup();
    test.source.thread.archivedAt = 5;
    test.harness.runService("prewarm");

    const subscribed = () =>
      test.harness.sdk
        .callsTo("subscribe")
        .find(
          ([value]) =>
            z.object({ event: z.string() }).parse(value).event ===
            "thread:changed",
        );

    await vi.waitFor(() => expect(subscribed()).toBeDefined());
    const [subscription] = subscribed()!;

    const { callback } = z
      .object({
        callback: z.custom<(event: { id: string; changes: string[] }) => void>(
          (value) => typeof value === "function",
        ),
      })
      .parse(subscription);

    callback({ id: "thr_one", changes: ["status-changed"] });
    await vi.waitFor(() =>
      expect(test.harness.sdk.callsTo("threads.get")).toHaveLength(1),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(test.harness.realtimeSignals).toEqual([
      {
        channel: "predictions-changed",
        payload: expect.objectContaining({
          status: "idle",
          message: "The chat was archived or deleted.",
        }),
      },
    ]);

    for (let index = 0; index < 5; index += 1)
      callback({ id: "thr_one", changes: ["status-changed"] });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(test.harness.sdk.callsTo("threads.get")).toHaveLength(1);
    expect(test.harness.realtimeSignals).toHaveLength(1);
    expect(poolCalls(test)).toHaveLength(0);
  });

  it("leaves an unchecked chat to the background producer when a conversation reads it", async () => {
    const test = await setup();
    expect(await test.state()).toMatchObject({ status: "idle" });
    await delay(50);
    expect(poolCalls(test)).toHaveLength(0);
    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    await complete(test.pending, "Prepared before the composer asked.");
    expect(await test.state()).toMatchObject({
      status: "ready",
      text: "Prepared before the composer asked.",
    });
    expect(poolCalls(test)).toHaveLength(1);
  });

  it.each(["startup", "in-flight"])(
    "automatically warms %s chats after their source host reconnects",
    async (phase) => {
      const test = await setup();

      try {
        test.source.host.status =
          phase === "startup" ? "disconnected" : "connected";
        test.harness.runService("prewarm");

        if (phase === "startup") {
          await vi.waitFor(async () =>
            expect(await test.state()).toMatchObject({ status: "failed" }),
          );
          expect(poolCalls(test)).toHaveLength(0);
        } else {
          await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
          test.source.host.status = "disconnected";
          test.source.hostChanged?.(false);
          await vi.waitFor(async () =>
            expect(await test.state()).toMatchObject({ status: "failed" }),
          );
          await complete(test.pending, "Ready before opening this chat.");
        }

        test.source.host.status = "connected";
        test.source.hostChanged?.(true);
        await vi.waitFor(() =>
          expect(poolCalls(test)).toHaveLength(phase === "startup" ? 1 : 2),
        );
        await complete(test.pending, "Ready before opening this chat.");
        expect(await test.state()).toMatchObject({
          status: "ready",
          text: "Ready before opening this chat.",
        });
      } finally {
        await complete(test.pending, "Ready before opening this chat.");
      }
    },
  );

  it("warms already-read chats at startup and reuses their suggestion on opening", async () => {
    const test = await setup();
    test.source.thread.lastReadAt = 2;
    test.harness.runService("prewarm");
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
    expect(poolCalls(test)[0]?.input).toMatchObject({ includedOnly: false });
    await complete(test.pending, "Inspect the finished work.");
    test.source.thread.lastReadAt = 2;
    expect(await test.request()).toMatchObject({
      status: "ready",
      text: "Inspect the finished work.",
    });
    expect(poolCalls(test)).toHaveLength(1);
  });

  it.each([
    ["question", "The chat was waiting for an answer."],
    ["queue", "The chat had queued work."],
  ])("does not warm a chat blocked by %s", async (condition, message) => {
    const test = await setup();

    if (condition === "question") test.source.hasPendingInteraction = true;

    if (condition === "queue") test.source.queuedWork = "waiting";

    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(async () =>
      expect(await test.state()).toMatchObject({ status: "idle", message }),
    );
    expect(
      test.harness.sdk.callsTo("threads.experimental_publishWork"),
    ).toHaveLength(0);
    expect(poolCalls(test)).toHaveLength(0);
    expect(test.harness.realtimeSignals).toEqual([
      {
        channel: "predictions-changed",
        payload: expect.objectContaining({ status: "idle", message }),
      },
    ]);
  });

  it.each([
    [
      "Predictions require fresh included Codex allowance",
      "Predictions need fresh included Codex allowance.",
    ],
    [
      "Predictions require an account in Account Pooler with fresh included Codex allowance",
      "Add a Claude or Codex account in Account Pooler to get predictions.",
    ],
    [
      "Predictions require an account in Account Pooler with included Claude subscription allowance",
      "Add a Claude or Codex account in Account Pooler to get predictions.",
    ],
    [
      "Predictions require fresh included Codex allowance or finite prepaid credits",
      "Predictions need fresh included Codex allowance or available prepaid credits.",
    ],
    [
      "OpenAI has not enabled composer predictions for this account",
      "OpenAI has not enabled predictions for the selected account.",
    ],
    [
      "OpenAI has not enabled composer predictions for any available account",
      "OpenAI has not enabled predictions for any available account.",
    ],
    [
      "Native Codex request failed (-32601)",
      "This Codex version cannot generate predictions. Update Codex on the thread’s machine.",
    ],
    [
      "Account Pooler rejected the Codex prediction payload.",
      "Codex sent an unsupported prediction request. Update Omnyo and retry.",
    ],
    [
      "This Codex model does not support composer predictions.",
      "This thread’s Codex model does not support predictions. Choose a supported model for your next turn.",
    ],
    [
      "This Codex model does not support composer predictions (model=gpt-5.4).",
      "This thread’s Codex model does not support predictions. Choose a supported model for your next turn.",
    ],
    [
      "Account Pooler rejected the Codex prediction payload (tools).",
      "Codex sent an unsupported prediction request. Update Omnyo and retry.",
    ],
    [
      "Untrusted provider diagnostic with arbitrary private content",
      "Prediction failed. Check Account Pooler and retry.",
    ],
    [
      "Omnyo request timed out after 75 seconds.",
      "Prediction timed out. Omnyo retries automatically.",
    ],
    [
      "Omnyo request timed out after 75 seconds.",
      "Prediction timed out. Omnyo retries automatically.",
    ],
  ])("shows a safe actionable failure for %s", async (failure, message) => {
    const test = await setup();
    await test.request();
    test.pending.reject(new Error(`HTTP 500: ${failure}`));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await test.state()).toMatchObject({
      status: "failed",
      text: null,
      message,
    });
  });
  it.each([
    [
      "Codex did not complete the prediction (status=failed, code=httpConnectionFailed, httpStatus=401).",
      { status: "failed", code: "httpConnectionFailed", httpStatus: 401 },
      { kind: "native" },
    ],
    [
      "Codex did not complete the prediction (status=failed, code=responseTooManyFailedAttempts, httpStatus=429).",
      {
        status: "failed",
        code: "responseTooManyFailedAttempts",
        httpStatus: 429,
      },
      { kind: "native" },
    ],
    [
      "private prompt and credential details",
      null,
      { kind: "http", status: 500 },
    ],
    [
      "Codex did not complete the prediction (status=failed, code=private-secret, httpStatus=401).",
      null,
      { kind: "http", status: 500 },
    ],
    [
      "Omnyo request timed out after 75 seconds.",
      null,
      { kind: "timeout", timeoutMs: 75_000 },
    ],
    [
      "Omnyo request timed out after 75 seconds.",
      null,
      { kind: "timeout", timeoutMs: 75_000 },
    ],
    [
      "Omnyo request timed out after 250 ms.",
      null,
      { kind: "timeout", timeoutMs: 250 },
    ],
    [
      "Omnyo request timed out after 250 ms.",
      null,
      { kind: "timeout", timeoutMs: 250 },
    ],
    [
      "Native Codex request failed (-32603)",
      null,
      { kind: "native-rpc", code: -32603 },
    ],
    [
      "Native Codex exited before prediction completed",
      null,
      { kind: "native-process", code: "exited" },
    ],
    [
      "Codex returned an invalid prediction.",
      null,
      { kind: "native-process", code: "invalid_prediction" },
    ],
  ])(
    "retains safe correlated failure diagnostics for %s",
    async (failure, native, cause) => {
      const test = await setup();

      const diagnostics = () =>
        test.harness.callRpc("diagnostics", { threadId: "thr_one" });

      expect(await diagnostics()).toEqual({
        threadId: "thr_one",
        lastFailure: null,
        lastSkip: null,
      });
      expect(poolCalls(test)).toHaveLength(0);
      const started = await test.request();
      const call = poolCalls(test)[0];
      test.pending.reject(new Error(`HTTP 500: ${failure}`));
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "failed" }),
      );
      const recorded = await diagnostics();
      expect(recorded).toMatchObject({
        threadId: "thr_one",
        lastFailure: {
          threadId: "thr_one",
          generation: started.generation,
          sourceSeq: 41,
          hostId: "host_source",
          requestId: call?.input.requestId,
          stage: "inference",
          native,
          cause,
          attempt: 1,
          failedAt: expect.any(Number),
          elapsedMs: expect.any(Number),
          retryAt: expect.any(Number),
        },
      });
      expect(JSON.stringify(recorded)).not.toContain("private");
      expect(
        test.harness.logEntries.some((entry) =>
          entry.message.includes(call?.input.requestId ?? "missing"),
        ),
      ).toBe(true);
      expect(JSON.stringify(test.harness.logEntries)).not.toContain("private");
      await test.harness.emitThreadEvent("thread.active", {
        thread: test.source.thread,
      });
      expect(await test.state()).toMatchObject({ status: "idle" });
      expect(await diagnostics()).toEqual(recorded);
      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      expect(
        await reloaded.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toEqual(recorded);

      const cli = await reloaded.harness.runCli([
        "diagnostics",
        "thr_one",
        "--json",
      ]);

      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout ?? "")).toEqual(recorded);
      expect(poolCalls(reloaded)).toHaveLength(0);
      await reloaded.harness.emitThreadEvent("thread.deleted", {
        thread: test.source.thread,
      });
      expect(
        await reloaded.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toEqual({ threadId: "thr_one", lastFailure: null, lastSkip: null });
    },
  );

  it("preserves old failure records without inventing missing diagnostic details", async () => {
    const test = await setup();

    const failure = {
      threadId: "thr_one",
      generation: 4,
      sourceSeq: 41,
      hostId: "host_source",
      requestId: "ac821299-0ad7-41f2-9671-e03aa7c1aea1",
      stage: "inference",
      failedAt: 100,
      elapsedMs: 75_000,
      attempt: 1,
      retryAt: 60_100,
      message: "Prediction failed. Check Account Pooler and retry.",
      native: null,
    };

    await test.api.storage.kv.set("prediction-failure:v1:thr_one", failure);
    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    expect(
      await reloaded.harness.callRpc("diagnostics", { threadId: "thr_one" }),
    ).toEqual({
      threadId: "thr_one",
      lastFailure: { ...failure, cause: null },
      lastSkip: null,
    });
    expect(poolCalls(reloaded)).toHaveLength(0);
  });

  it.each(["ECONNRESET", "UND_ERR_CONNECT_TIMEOUT", "private-secret"])(
    "retains only allowlisted structured transport codes for %s",
    async (code) => {
      const test = await setup();
      await test.request();
      test.pending.reject(
        new Error("private prompt and credential details", { cause: { code } }),
      );
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "failed" }),
      );

      const diagnostics = await test.harness.callRpc("diagnostics", {
        threadId: "thr_one",
      });

      expect(diagnostics).toMatchObject({
        lastFailure: {
          cause:
            code === "private-secret"
              ? { kind: "unknown" }
              : { kind: "transport", code },
        },
      });
      expect(JSON.stringify(diagnostics)).not.toContain("private");
      expect(JSON.stringify(test.harness.logEntries)).not.toContain("private");
    },
  );

  it("keeps the original failure cause when its host check crosses the deadline", async () => {
    const test = await setup();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let releaseHost = () => {};

    const hostGate = new Promise<void>((resolve) => {
      releaseHost = resolve;
    });

    let checkingHost = false;

    try {
      await test.request();
      await vi.advanceTimersByTimeAsync(239_000);
      test.harness.sdk.stub("hosts.get", async () => {
        checkingHost = true;
        await hostGate;

        return test.source.host;
      });
      test.pending.reject(
        new Error("private transport detail", {
          cause: { code: "ECONNRESET" },
        }),
      );
      await vi.waitFor(() => expect(checkingHost).toBe(true));
      await vi.advanceTimersByTimeAsync(2000);
      releaseHost();
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "failed" }),
      );
      expect(
        await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
      ).toMatchObject({
        lastFailure: {
          cause: { kind: "transport", code: "ECONNRESET" },
          message: "Prediction failed. Check Account Pooler and retry.",
        },
      });
    } finally {
      releaseHost();
      vi.useRealTimers();
    }
  });

  it("loads without global work and delegates prediction to the authenticated pool owner", async () => {
    const test = await setup();
    expect(poolCalls(test)).toHaveLength(0);
    const started = await test.request();
    expect(started.status).toBe("predicting");
    const call = poolCalls(test)[0];
    expect(call).toMatchObject({
      pluginId: "account-pool",
      method: "experimental_composer-predictions.v1.predict",
      input: {
        threadId: "thr_one",
        requestId: expect.any(String),
        cliPath: "/tools/codex",
      },
    });
    expect(call?.signal?.aborted).toBe(false);
    await complete(test.pending, "Run the final verification.");
    expect(await test.state()).toMatchObject({
      generation: started.generation,
      status: "ready",
      text: "Run the final verification.",
    });
    expect(test.harness.realtimeSignals.at(-1)).toMatchObject({
      channel: "predictions-changed",
      payload: { status: "ready" },
    });
    expect(test.harness.sdk.callsTo("threads.events.list")).toContainEqual([
      expect.objectContaining({
        threadId: "thr_one",
        types: ["turn/completed"],
        order: "desc",
        limit: "1",
      }),
    ]);
  });

  it("deduplicates concurrent and repeated requests for one completed source", async () => {
    const test = await setup();
    const [first, second] = await Promise.all([test.request(), test.request()]);
    expect(second.generation).toBe(first.generation);
    expect(poolCalls(test)).toHaveLength(1);
    await complete(test.pending, "Inspect the rendered result.");

    let releaseThreadRead!: () => void;

    const threadRead = new Promise<void>((resolve) => {
      releaseThreadRead = resolve;
    });

    test.source.threadReadGate = threadRead;

    const readinessReads = test.harness.sdk.callsTo("threads.list").length;
    const sourceReads = test.harness.sdk.callsTo("threads.events.list").length;
    const repeated = test.request();
    let reopened = await test.state();

    try {
      await vi.waitFor(() => {
        expect(test.harness.sdk.callsTo("threads.list")).toHaveLength(
          readinessReads + 1,
        );
        expect(test.harness.sdk.callsTo("threads.events.list")).toHaveLength(
          sourceReads + 1,
        );
      });
      expect(poolCalls(test)).toHaveLength(1);
    } finally {
      releaseThreadRead();
      reopened = await repeated;
    }

    expect(reopened.generation).toBe(first.generation);
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("does not reassess a formed verdict when work changes without new conversation", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, "Stored next step.");
    expect(await test.request()).toMatchObject({ text: "Stored next step." });
    expect(poolCalls(test)).toHaveLength(1);

    test.source.activity.activeBackgroundCommandCount = 1;
    expect(await test.request()).toMatchObject({ status: "ready" });
    test.source.activity.activeBackgroundCommandCount = 0;
    expect(await test.request()).toMatchObject({ status: "ready" });
    expect(poolCalls(test)).toHaveLength(1);

    await test.harness.callRpc("request", { threadId: "thr_one", fresh: true });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
  });

  describe("forced suggestions", () => {
    const force = (test: Awaited<ReturnType<typeof setup>>) =>
      test.harness.callRpc("request", { threadId: "thr_one", force: true });

    it("sends force only on a forced request while other work owns the next step", async () => {
      const test = await setup();
      test.source.activity.activeBackgroundCommandCount = 1;
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input).not.toHaveProperty("force");
      await complete(test.pending, "Stored next step.");

      await test.harness.callRpc("request", {
        threadId: "thr_one",
        fresh: true,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
      expect(poolCalls(test)[1]?.input).not.toHaveProperty("force");
      await complete(test.pending, "Stored next step.");

      await force(test);
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(3));
      expect(poolCalls(test)[2]?.input.force).toBe(true);
    });

    it.each([
      ["a stored reply", { text: "Stored next step." }],
      [
        "a stored omission",
        { text: null, noSuggestionReason: "A loop owns the next step." },
      ],
    ])("runs inference again over %s", async (_, stored) => {
      const test = await setup();
      await test.request();
      test.pending.resolve({
        promptVersion: "desktop-v1",
        archiveReadiness: null,
        ...stored,
      });
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "ready" }),
      );
      expect(await test.request()).toMatchObject({ status: "ready" });
      expect(poolCalls(test)).toHaveLength(1);

      expect(await force(test)).toMatchObject({
        status: "predicting",
        text: null,
      });
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
      expect(poolCalls(test)[1]?.input.force).toBe(true);
    });

    it("runs inference again after a dismissal", async () => {
      const test = await setup();
      await test.request();
      await complete(test.pending, "Stored next step.");
      const current = await test.state();
      await test.harness.callRpc("dismiss", {
        threadId: "thr_one",
        generation: current.generation,
      });
      expect(await test.request()).toMatchObject({ status: "none" });

      await force(test);
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
      expect(poolCalls(test)[1]?.input.force).toBe(true);
    });

    it("is not swallowed by an ordinary request still preparing", async () => {
      const test = await setup();
      test.source.activity.activeBackgroundCommandCount = 1;

      let releaseThreadRead!: () => void;

      test.source.threadReadGate = new Promise<void>((resolve) => {
        releaseThreadRead = resolve;
      });

      const ordinary = test.request();
      const forced = force(test);
      const again = force(test);

      releaseThreadRead();
      await Promise.all([ordinary, forced, again]);

      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
      expect(poolCalls(test).map((call) => call.input.force)).toEqual([
        undefined,
        true,
      ]);
      expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
    });

    it("keeps admission blockers and reports them", async () => {
      const test = await setup();
      test.source.hasPendingInteraction = true;

      expect(await force(test)).toMatchObject({
        status: "idle",
        message: "The chat was waiting for an answer.",
      });
      expect(poolCalls(test)).toHaveLength(0);
    });

    it("asks for an Account Pooler update when an older one refuses force, without retrying", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

      try {
        const test = await setup();
        await force(test);
        await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
        test.pending.reject(new Error("HTTP 400: rpc input validation failed"));
        await vi.waitFor(async () =>
          expect(await test.state()).toMatchObject({
            status: "failed",
            message: "Update Account Pooler to suggest a reply on demand.",
          }),
        );

        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect(poolCalls(test)).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not blame Account Pooler's version for an ordinary request", async () => {
      const test = await setup();
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      test.pending.reject(new Error("HTTP 400: rpc input validation failed"));
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "failed",
          message: "Prediction failed. Check Account Pooler and retry.",
        }),
      );
    });

    it("offers force on the CLI and rejects it elsewhere", async () => {
      const test = await setup();

      const requesting = test.harness.runCli([
        "request",
        "thr_one",
        "--force",
        "--json",
      ]);

      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input.force).toBe(true);
      await complete(test.pending, "Check the final proof.");
      expect(JSON.parse((await requesting).stdout)).toMatchObject({
        status: "ready",
        text: "Check the final proof.",
      });

      for (const argv of [
        ["status", "thr_one", "--force"],
        ["request", "thr_one", "--force", "--fresh"],
      ]) {
        const refused = await test.harness.runCli(argv);
        expect(refused.exitCode).toBe(1);
        expect(refused.stderr).toContain("--fresh | --force");
      }
    });
  });

  it("treats a null suggestion as a completed empty prediction", async () => {
    const test = await setup();
    await test.request();
    await complete(test.pending, null);
    expect(await test.state()).toMatchObject({
      status: "none",
      text: null,
      message: null,
    });
  });

  it.each([
    {
      ready: true,
      reason: "Requested work is complete.",
      waitingOn: null,
      ask: null,
      recap: null,
    },
    {
      ready: false,
      reason: "Verification remains.",
      waitingOn: null,
      ask: null,
      recap: null,
    },
    {
      ready: false,
      reason: "Waiting on review.",
      waitingOn: "Store review",
      ask: null,
      recap: null,
    },
  ])(
    "preserves the archive verdict after dismiss and reload ($reason)",
    async (archiveReadiness) => {
      const test = await setup();
      await test.request();
      await complete(test.pending, "A suggested reply", archiveReadiness);
      const before = await test.state();
      expect(before.archiveReadiness).toEqual(archiveReadiness);

      const after = predictionSchema.parse(
        await test.harness.callRpc("dismiss", {
          threadId: "thr_one",
          generation: before.generation,
        }),
      );

      expect(after.text).toBeNull();
      expect(after.archiveReadiness).toEqual(archiveReadiness);
      await vi.waitFor(() =>
        expect(test.source.thread.work?.archive.recommended).toBe(
          archiveReadiness.ready,
        ),
      );
      const restored = await test.harness.reload(plugin);
      loaded.push(restored);

      const reopened = predictionSchema.parse(
        await restored.harness.callRpc("request", { threadId: "thr_one" }),
      );

      expect(reopened.text).toBeNull();
      expect(reopened.archiveReadiness).toEqual(archiveReadiness);
      expect(poolCalls(restored)).toHaveLength(0);
    },
  );

  it.each(["cancel", "dismiss"])(
    "aborts %s and discards a late native result",
    async (method) => {
      const test = await setup();
      const next = pendingPrediction();
      let requests = 0;
      test.harness.sdk.stub("plugins.callRpc", async (input) => {
        const { method } = z.object({ method: z.string() }).parse(input);

        if (method === "callbacks.list")
          return { waits: test.source.callbacks };

        if (method === "open_index") return { threads: test.source.decisions };

        if (method === "worker-activity.list")
          return { ownerThreadIds: test.source.workerOwners };

        if (method === "thread_work")
          return {
            complete: test.source.resourcesComplete,
            jobs: test.source.resourceJobs,
          };
        const { method: poolMethod } = poolCallSchema.parse(input);

        if (!poolMethod.endsWith(".predict")) return { cancelled: true };
        requests += 1;

        return requests === 1 ? test.pending.promise : next.promise;
      });
      const first = await test.request();

      const changed = predictionSchema.parse(
        await test.harness.callRpc(method, {
          threadId: "thr_one",
          generation: first.generation,
        }),
      );

      expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
      expect(
        test.harness.sdk.callsTo("plugins.callRpc").at(-1)?.[0],
      ).toMatchObject({
        pluginId: "account-pool",
        method: "experimental_composer-predictions.v1.cancel",
        input: {
          threadId: "thr_one",
          requestId: poolCalls(test)[0]?.input.requestId,
        },
      });
      await complete(test.pending, "This result is stale.");
      expect(await test.state()).toEqual(changed);
      expect(changed.text).toBeNull();
      const reopened = await test.request();

      if (method === "cancel") {
        expect(reopened.status).toBe("predicting");
        expect(reopened.generation).toBeGreaterThan(changed.generation);
        expect(poolCalls(test)).toHaveLength(2);
        expect(poolCalls(test)[1]?.input.requestId).not.toBe(
          poolCalls(test)[0]?.input.requestId,
        );
        expect(poolCalls(test)[1]?.signal?.aborted).toBe(false);
        await complete(next, "Inspect the reopened composer.");
        expect(await test.state()).toMatchObject({
          status: "ready",
          text: "Inspect the reopened composer.",
          generation: reopened.generation,
        });
      } else {
        expect(reopened).toEqual(changed);
        expect(poolCalls(test)).toHaveLength(1);
      }
    },
  );

  it("does not let an older client generation cancel a newer source", async () => {
    const test = await setup();
    const first = await test.request();
    test.source.events[0]!.seq = 42;
    test.source.events[0]!.data.providerCheckpointId = "turn_two";
    const second = await test.request();
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);

    const unchanged = predictionSchema.parse(
      await test.harness.callRpc("cancel", {
        threadId: "thr_one",
        generation: first.generation,
      }),
    );

    expect(unchanged).toEqual(second);
    expect(poolCalls(test)[1]?.signal?.aborted).toBe(false);
  });

  it("invalidates on a new active turn and warms the next completed source", async () => {
    const test = await setup();
    await test.request();
    await test.harness.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({
        id: "thr_one",
        providerId: "codex",
        status: "active",
      }),
    });
    expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
    await complete(test.pending, "Old generation.");
    expect(await test.state()).toMatchObject({
      status: "idle",
      text: null,
      archiveReadiness: null,
    });
    test.source.events[0]!.seq = 42;
    await test.harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_one",
        providerId: "codex",
        status: "idle",
      }),
      lastAssistantText: "Private completed answer.",
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
    expect(JSON.stringify(test.harness.realtimeSignals)).not.toContain(
      "Private completed answer.",
    );
  });

  it("does not retain a cancelled prediction as a new failure", async () => {
    const test = await setup();
    await test.request();
    await test.harness.emitThreadEvent("thread.active", {
      thread: test.source.thread,
    });
    test.pending.reject(
      new Error(
        "Codex did not complete the prediction (status=failed, code=httpConnectionFailed, httpStatus=401).",
      ),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(
      await test.harness.callRpc("diagnostics", { threadId: "thr_one" }),
    ).toEqual({ threadId: "thr_one", lastFailure: null, lastSkip: null });
    expect(test.harness.logEntries).toEqual([]);
  });

  it.each([
    ["missing", "active"],
    ["missing", "cancel"],
    ["missing", "dismiss"],
    ["missing", "dispose"],
    ["failed", "active"],
    ["failed", "cancel"],
    ["failed", "dismiss"],
    ["failed", "dispose"],
  ])(
    "discards %s source validation after %s invalidates its request",
    async (sourceResult, action) => {
      const test = await setup();
      let resolveEvents = (_events: typeof test.source.events) => {};

      const events = new Promise<typeof test.source.events>((resolve) => {
        resolveEvents = resolve;
      });

      test.harness.sdk.stub("threads.events.list", () => events);
      const requesting = test.request();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(test.harness.sdk.callsTo("threads.events.list")).toHaveLength(1);
      let expected = await test.state();

      if (action === "active") {
        await test.harness.emitThreadEvent("thread.active", {
          thread: makeThreadResponse({
            id: "thr_one",
            providerId: "codex",
            status: "active",
          }),
        });
        expected = await test.state();
      } else if (action === "dispose") {
        await test.harness.dispose();
      } else {
        expected = predictionSchema.parse(
          await test.harness.callRpc(action, {
            threadId: "thr_one",
            generation: expected.generation,
          }),
        );
      }

      const signalCount = test.harness.realtimeSignals.length;
      test.source.events[0]!.data.status = "failed";
      resolveEvents(sourceResult === "missing" ? [] : test.source.events);
      expect(await requesting).toEqual(expected);
      expect(poolCalls(test)).toHaveLength(0);
      expect(test.harness.realtimeSignals).toHaveLength(signalCount);
    },
  );

  it.each([
    "active turn",
    "queued message",
    "missing checkpoint",
    "failed completion",
    "disconnected host",
  ])("rejects %s before host inference", async (condition) => {
    const test = await setup();

    if (condition === "active turn") test.source.thread.status = "active";

    if (condition === "queued message")
      test.source.thread.queuedMessageCount = 1;

    if (condition === "missing checkpoint")
      test.source.events[0]!.data.providerCheckpointId = "";

    if (condition === "failed completion")
      test.source.events[0]!.data.status = "failed";

    if (condition === "disconnected host")
      test.source.host.status = "disconnected";
    const result = await test.request();
    expect(result.status).toBe("failed");
    expect(result.message).toBeTruthy();
    expect(poolCalls(test)).toHaveLength(0);
  });

  it("reports host failure without private payloads and permits an explicit retry", async () => {
    const test = await setup();
    await test.request();
    test.pending.reject(new Error("private credential detail"));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(await test.state()).toMatchObject({
      status: "failed",
      text: null,
      message: "Prediction failed. Check Account Pooler and retry.",
    });
    expect(JSON.stringify(test.harness.logEntries)).not.toContain(
      "private credential detail",
    );
    expect(JSON.stringify(test.harness.realtimeSignals)).not.toContain(
      "private credential detail",
    );
    await test.request();
    expect(poolCalls(test)).toHaveLength(2);
  });

  it("honors live settings changes and cancels existing work", async () => {
    const test = await setup();
    await test.request();
    await test.harness.setSettings({ enabled: false });
    expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
    expect(await test.request()).toMatchObject({
      status: "disabled",
      text: null,
    });
    expect(poolCalls(test)).toHaveLength(1);
  });

  it("aborts owned host work on dispose without publishing from a stale handle", async () => {
    const test = await setup();
    await test.request();
    await test.harness.dispose();
    const count = test.harness.realtimeSignals.length;
    expect(poolCalls(test)[0]?.signal?.aborted).toBe(true);
    await complete(test.pending, "After disposal.");
    expect(test.harness.realtimeSignals).toHaveLength(count);
    expect(test.harness.logEntries).toEqual([]);
  });

  it("provides CLI state without inference and awaits manual request completion", async () => {
    const test = await setup();
    const status = await test.harness.runCli(["status", "thr_one", "--json"]);
    expect(status.exitCode).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: "idle" });
    expect(poolCalls(test)).toHaveLength(0);
    const requesting = test.harness.runCli(["request", "thr_one", "--json"]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await complete(test.pending, "Check the final proof.");
    const result = await requesting;
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: "ready",
      text: "Check the final proof.",
    });
  });

  describe("type-of-work tags", () => {
    const buildTag = {
      id: "build",
      label: "Build",
      icon: "🔨",
      description: "Features and refactors",
    };

    function resolveTagged(
      test: Awaited<ReturnType<typeof setup>>,
      tag: string | null,
    ) {
      test.pending.resolve({
        text: "Add the export.",
        promptVersion: "desktop-v1",
        archiveReadiness: null,
        tag,
      });
    }

    it("offers chat-topics tags and suggests the predicted tag once, not again from cache", async () => {
      const test = await setup();
      test.source.chatTopics = { enabled: true, tags: [buildTag] };
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input.tags).toEqual([
        { id: "build", description: "Features and refactors" },
      ]);

      resolveTagged(test, "build");
      await vi.waitFor(() =>
        expect(test.source.suggested).toEqual([
          { threadId: "thr_one", tagId: "build" },
        ]),
      );
      expect(await test.state()).not.toHaveProperty("tag");

      const reloaded = await test.harness.reload(plugin);
      loaded.push(reloaded);
      expect(
        await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
      ).toMatchObject({ status: "ready", text: "Add the export." });
      expect(poolCalls(reloaded)).toHaveLength(0);
      expect(test.source.suggested).toHaveLength(1);
    });

    it("neither offers nor suggests tags when chat-topics is disabled", async () => {
      const test = await setup();
      test.source.chatTopics = { enabled: false, tags: [buildTag] };
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input).not.toHaveProperty("tags");

      resolveTagged(test, "build");
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({ status: "ready" }),
      );
      expect(test.source.suggested).toEqual([]);
    });

    it("predicts without tags and warns when the tag list cannot be read", async () => {
      const test = await setup();
      test.source.chatTopics = {
        enabled: true,
        tags: new Error("chat-topics unavailable"),
      };
      await test.request();
      await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(1));
      expect(poolCalls(test)[0]?.input).not.toHaveProperty("tags");
      expect(test.harness.logEntries).toContainEqual({
        level: "warn",
        message: "Chat tags could not be read. Predicting without a tag.",
      });

      resolveTagged(test, null);
      await vi.waitFor(async () =>
        expect(await test.state()).toMatchObject({
          status: "ready",
          text: "Add the export.",
        }),
      );
      expect(test.source.suggested).toEqual([]);
    });
  });
});

describe("automatic compaction", () => {
  type LoggedEvent = {
    id: string;
    scope: { kind: string; turnId?: string };
    threadId: string;
    seq: number;
    createdAt: number;
    type: string;
    data: Record<string, unknown>;
  };

  function turnRequest(seq: number, maintenance: boolean): LoggedEvent {
    return {
      id: `request_${seq}`,
      scope: { kind: "thread" },
      threadId: "thr_one",
      seq,
      createdAt: seq,
      type: "client/turn/requested",
      data: maintenance ? { maintenance: "auto-compaction" } : {},
    };
  }

  function turnCompleted(seq: number, turnId: string): LoggedEvent {
    return {
      id: `completed_${seq}`,
      scope: { kind: "turn", turnId },
      threadId: "thr_one",
      seq,
      createdAt: seq,
      type: "turn/completed",
      data: {
        status: "completed",
        providerThreadId: "native_one",
        providerCheckpointId: turnId,
      },
    };
  }

  function eventLog(
    test: Awaited<ReturnType<typeof setup>>,
    appended: LoggedEvent[],
  ) {
    return (input: {
      types?: readonly string[];
      beforeSeq?: string;
      limit?: string;
    }) =>
      input.types?.includes("item/completed")
        ? test.source.replies
        : [...appended, ...test.source.events]
            .filter(
              (event) =>
                input.types === undefined || input.types.includes(event.type),
            )
            .filter(
              (event) =>
                input.beforeSeq === undefined ||
                event.seq < Number(input.beforeSeq),
            )
            .sort((left, right) => right.seq - left.seq)
            .slice(
              0,
              input.limit === undefined ? undefined : Number(input.limit),
            );
  }

  async function predicted() {
    const test = await setup();
    test.source.thread.providerId = "claude-code";
    await test.request();
    await complete(test.pending, "Ship the fix.");
    const prediction = await test.state();
    expect(prediction).toMatchObject({
      status: "ready",
      text: "Ship the fix.",
    });
    expect(poolCalls(test)).toHaveLength(1);

    return { test, prediction };
  }

  it("keeps the prediction through a maintenance compaction without new inference", async () => {
    const { test, prediction } = await predicted();
    const appended = [turnRequest(50, true)];
    const listEvents = eventLog(test, appended);
    test.harness.sdk.stub("threads.events.list", listEvents);
    const signals = test.harness.realtimeSignals.length;

    test.source.thread.status = "active";
    await test.harness.emitThreadEvent("experimental_thread.events", {
      thread: { ...test.source.thread, status: "idle" },
      sequence: 50,
    });
    await vi.waitFor(() =>
      expect(test.harness.sdk.callsTo("threads.events.list")).toContainEqual([
        expect.objectContaining({ types: ["client/turn/requested"] }),
      ]),
    );
    await delay(0);
    expect(await test.state()).toEqual(prediction);

    appended.unshift(turnCompleted(60, "turn_compact"));
    test.source.thread.status = "idle";
    await test.harness.emitThreadEvent("experimental_thread.events", {
      thread: { ...test.source.thread, experimental_maintenance: null },
      sequence: 60,
    });
    await vi.waitFor(() =>
      expect(test.harness.sdk.callsTo("threads.events.list")).toContainEqual([
        expect.objectContaining({
          types: ["turn/completed"],
          beforeSeq: "50",
        }),
      ]),
    );
    await delay(0);
    expect(await test.state()).toEqual(prediction);
    expect(poolCalls(test)).toHaveLength(1);
    expect(test.harness.realtimeSignals).toHaveLength(signals);

    const reloaded = await test.harness.reload(plugin);
    loaded.push(reloaded);
    reloaded.harness.sdk.stub("threads.events.list", listEvents);
    expect(
      await reloaded.harness.callRpc("state", { threadId: "thr_one" }),
    ).toMatchObject({ status: "ready", text: "Ship the fix." });
    expect(poolCalls(reloaded)).toHaveLength(0);
  });

  it("assesses the owner's next turn after a maintenance compaction", async () => {
    const { test } = await predicted();

    const appended = [
      turnRequest(70, false),
      turnCompleted(60, "turn_compact"),
      turnRequest(50, true),
    ];

    test.harness.sdk.stub("threads.events.list", eventLog(test, appended));
    test.source.events.unshift({
      id: "completed_80",
      scope: { kind: "turn", turnId: "turn_two" },
      threadId: "thr_one",
      seq: 80,
      createdAt: 80,
      type: "turn/completed",
      data: {
        status: "completed",
        providerThreadId: "native_one",
        providerCheckpointId: "turn_two",
      },
    });

    await test.harness.emitThreadEvent("thread.idle", {
      thread: test.source.thread,
      lastAssistantText: null,
    });
    await vi.waitFor(() => expect(poolCalls(test)).toHaveLength(2));
  });
});

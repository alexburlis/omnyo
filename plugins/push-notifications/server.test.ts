import type { PluginApi, PluginThreadEventPayloads } from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import { EnvHttpProxyAgent } from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  clientNotificationSchema,
  listPushSubscriptionsOutputSchema,
  THREAD_NOTIFICATIONS_CHANNEL,
} from "./contract.js";
import {
  parseStoredNotificationLevel,
  type NotificationLevel,
} from "./preferences.js";
import { createPushNotificationsPlugin } from "./server.js";
import type { ExpoPushMessage, PushSenderFetch } from "./sender.js";

type ThreadResponse = PluginThreadEventPayloads["thread.idle"]["thread"];

type ThreadListEntry = Awaited<
  ReturnType<PluginApi["sdk"]["threads"]["list"]>
>[number];

type PendingInteraction =
  PluginThreadEventPayloads["interaction.pending"]["interaction"];

type AttentionQuestion = Awaited<
  ReturnType<PluginApi["sdk"]["experimental_attention"]["history"]>
>["questions"][number];

type ChangedListener = (event: {
  id?: string;
  changes: readonly string[];
}) => void;

const COALESCE_MS = 10;

const EXPO_URL = "http://expo.test/push";

const EXPO_RECEIPTS_URL = "http://expo.test/getReceipts";

interface FakeExpo {
  fetch: PushSenderFetch;
  requests: ExpoPushMessage[][];
  receiptRequests: string[][];
  receiptErrors: Map<string, string>;
  ticketErrors: Map<string, string>;
  urls: string[];
}

function createFakeExpo(): FakeExpo {
  const requests: ExpoPushMessage[][] = [];
  const receiptRequests: string[][] = [];
  const receiptErrors = new Map<string, string>();
  const ticketErrors = new Map<string, string>();
  const urls: string[] = [];

  const fetch: PushSenderFetch = async (url, init) => {
    urls.push(url);
    expect(init.dispatcher).toBeInstanceOf(EnvHttpProxyAgent);

    if (url === EXPO_RECEIPTS_URL) {
      const { ids } = JSON.parse(init.body) as { ids: string[] };
      receiptRequests.push(ids);

      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: Object.fromEntries(
              ids.map((id) => {
                const error = receiptErrors.get(id);

                return [
                  id,
                  error === undefined
                    ? { status: "ok" }
                    : { status: "error", details: { error } },
                ];
              }),
            ),
          }),
      };
    }

    const messages = JSON.parse(init.body) as ExpoPushMessage[];
    requests.push(messages);

    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          data: messages.map((message) => {
            const error = ticketErrors.get(message.to);

            return error === undefined
              ? { status: "ok", id: `ticket-${message.to}` }
              : { status: "error", details: { error } };
          }),
        }),
    };
  };

  return {
    fetch,
    requests,
    receiptRequests,
    receiptErrors,
    ticketErrors,
    urls,
  };
}

function pendingQuestion(threadId: string, prompt: string): PendingInteraction {
  return {
    id: `interaction-${threadId}`,
    threadId,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    expiresAt: null,
    resolvedAt: null,
    turnId: `turn-${threadId}`,
    providerId: "codex",
    providerThreadId: `provider-${threadId}`,
    providerRequestId: `request-${threadId}`,
    origin: {
      kind: "provider",
      providerId: "codex",
      providerThreadId: `provider-${threadId}`,
      providerRequestId: `request-${threadId}`,
    },
    payload: {
      kind: "user_question",
      questions: [
        {
          id: "question-1",
          prompt,
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    },
    resolution: null,
  };
}

function nativeQuestion(
  threadId: string,
  prompt: string,
  change: Partial<AttentionQuestion> & {
    mode?: AttentionQuestion["question"]["mode"];
  } = {},
): AttentionQuestion {
  const { mode = "optional", ...rest } = change;

  return {
    id: `question-${threadId}`,
    threadId,
    revision: 1,
    question: {
      key: null,
      prompt,
      context: null,
      shortLabel: "Choice",
      mode,
      multiSelect: false,
      allowFreeText: true,
      additiveNotes: true,
      delegable: false,
      options: [],
    },
    state: "open",
    answer: null,
    queuedMessageId: null,
    answeredBy: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...rest,
  };
}

interface SetupOptions {
  appUrl?: string | null;
  assessmentWaitMs?: number;
  expo?: FakeExpo;
  fetch?: PushSenderFetch;
  now?: () => number;
  presenceStaleMs?: number;
  receiptDelayMs?: number;
}

async function setup(options: SetupOptions = {}) {
  const expo = options.expo ?? createFakeExpo();
  const threads = new Map<string, ThreadResponse>();
  const listState = new Map<string, Partial<ThreadListEntry>>();
  const interactions = new Map<string, PendingInteraction[]>();
  const questions = new Map<string, AttentionQuestion[]>();
  const metadata = new Map<string, Record<string, unknown>>();
  const changedListeners = new Set<ChangedListener>();
  let nextId = 1;

  const attentionHistory = vi.fn(
    async ({ threadId }: { threadId: string }) => ({
      questions: questions.get(threadId) ?? [],
      callbacks: [],
    }),
  );

  const listAncestors = vi.fn(
    async ({ threadIds }: { threadIds: readonly string[] }) => ({
      threads: [...new Set(threadIds)].flatMap((threadId) => {
        if (!threads.has(threadId)) return [];
        const ancestorIds: string[] = [];
        let parentId = threads.get(threadId)?.parentThreadId ?? null;

        while (parentId !== null && threads.has(parentId)) {
          ancestorIds.push(parentId);
          parentId = threads.get(parentId)?.parentThreadId ?? null;
        }

        return [{ threadId, ancestorIds }];
      }),
    }),
  );

  const fake = createFakePluginHost({
    pluginId: "push-notifications",
    ...(options.appUrl === undefined ? {} : { appUrl: options.appUrl }),
    settings: { expoPushUrl: EXPO_URL },
    sdk: {
      subscribe: ((args: { callback: ChangedListener }) => {
        changedListeners.add(args.callback);

        return () => changedListeners.delete(args.callback);
      }) as never,
      experimental_attention: { history: attentionHistory },
      threads: {
        get: async ({ threadId }) => {
          const thread = threads.get(threadId);

          if (!thread) throw new Error("Thread not found");

          return thread;
        },
        experimental_listAncestors: listAncestors,
        experimental_listDescendants: async ({
          threadIds,
          includeArchived = false,
          includeHidden = false,
        }) => ({
          threads: [...new Set(threadIds)].flatMap((threadId) => {
            if (!threads.has(threadId)) return [];
            const walked: ThreadResponse[] = [];

            for (let index = -1; index < walked.length; index += 1) {
              const parentId = index < 0 ? threadId : walked[index]?.id;

              for (const thread of threads.values()) {
                if (thread.parentThreadId === parentId) walked.push(thread);
              }
            }

            const descendantIds = walked
              .filter(
                (thread) =>
                  (includeArchived || thread.archivedAt === null) &&
                  (includeHidden || thread.visibility === "visible"),
              )
              .map((thread) => thread.id);

            return [{ threadId, descendantIds }];
          }),
        }),
        getPluginMetadata: async ({ threadId }) => {
          if (!threads.has(threadId)) throw new Error("Thread not found");

          return metadata.get(threadId) ?? {};
        },
        updatePluginMetadata: async ({ threadId, set, remove }) => {
          if (!threads.has(threadId)) throw new Error("Thread not found");
          const next = { ...(metadata.get(threadId) ?? {}), ...set };

          for (const key of remove ?? []) delete next[key];

          if (Object.keys(next).length === 0) metadata.delete(threadId);
          else metadata.set(threadId, next);

          return next;
        },
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds.flatMap((threadId) => {
            const value = metadata.get(threadId);

            return value === undefined ? [] : [{ threadId, metadata: value }];
          }),
        }),
        list: async (args = {}) =>
          [...threads.values()]
            .filter(
              (thread) =>
                thread.archivedAt === null &&
                thread.deletedAt === null &&
                (args.parentThreadId === undefined ||
                  thread.parentThreadId === args.parentThreadId) &&
                (args.projectId === undefined ||
                  thread.projectId === args.projectId) &&
                (args.environmentId === undefined ||
                  thread.environmentId === args.environmentId) &&
                (args.hasParent === undefined ||
                  (thread.parentThreadId !== null) === args.hasParent),
            )
            .slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100))
            .map((thread) => ({
              ...thread,
              activity: {
                activeWorkflowCount: 0,
                activeBackgroundAgentCount: thread.activeBackgroundAgentCount,
                activeBackgroundCommandCount: 0,
                activePlanModeCount: 0,
                activeGoalCount: 0,
                activeSubagentCount: 0,
              },
              queuedWork: thread.queuedMessageCount > 0 ? "waiting" : "none",
              hasPendingInteraction: (interactions.get(thread.id) ?? []).some(
                (interaction) => interaction.status === "pending",
              ),
              pinSortKey: null,
              environmentHostId: null,
              environmentName: null,
              environmentBranchName: null,
              environmentPath: null,
              environmentProviderId: null,
              environmentIsWorktree: null,
              environmentWorkspaceDisplayKind: null,
              ...listState.get(thread.id),
            })),
        interactions: {
          list: async ({ threadId }) => interactions.get(threadId) ?? [],
        },
      },
    },
  });

  await createPushNotificationsPlugin({
    coalesceMs: COALESCE_MS,
    assessmentPollMs: COALESCE_MS,
    assessmentStartGraceMs: COALESCE_MS * 8,
    assessmentWaitMs: options.assessmentWaitMs ?? 2_000,
    createId: () => `subscription-${nextId++}`,
    fetch: options.fetch ?? expo.fetch,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.presenceStaleMs === undefined
      ? {}
      : { presenceStaleMs: options.presenceStaleMs }),
    ...(options.receiptDelayMs === undefined
      ? {}
      : { receiptDelayMs: options.receiptDelayMs }),
  })(fake.api);

  function attentionChanged(threadId: string) {
    for (const listener of changedListeners)
      listener({ id: threadId, changes: ["interactions-changed"] });
  }

  async function addSubscription(
    expoPushToken = "ExponentPushToken[phone]",
    deviceLabel = "Phone",
  ) {
    return fake.harness.behavior.callRpc("pushSubscriptions.add", {
      expoPushToken,
      platform: "ios",
      deviceLabel,
    });
  }

  function setThread(overrides: Partial<ThreadResponse> = {}) {
    const thread = makeThreadResponse({
      id: `thread-${threads.size + 1}`,
      projectId: "project-1",
      status: "idle",
      title: "Fix the flaky test",
      latestAttentionAt: 100,
      ...overrides,
    });

    threads.set(thread.id, thread);

    return thread;
  }

  const service = fake.harness.behavior.runService("push-sender");

  async function cleanup() {
    service.controller.abort();
    await service.done;
    await fake.harness.lifecycle.dispose();
  }

  function storedLevel(threadId: string): NotificationLevel | null {
    return parseStoredNotificationLevel(metadata.get(threadId) ?? {});
  }

  function moveThread(threadId: string, parentThreadId: string | null) {
    const thread = threads.get(threadId);

    if (!thread) throw new Error("Thread not found");
    threads.set(threadId, { ...thread, parentThreadId });
  }

  async function setLevel(threadId: string, level: string) {
    return fake.harness.behavior.callRpc("threadNotifications.set", {
      threadId,
      level,
    });
  }

  async function getLevel(threadId: string) {
    const result = await fake.harness.behavior.runCli([
      "thread",
      threadId,
      "--json",
    ]);

    const { threadId: _threadId, ...row } = JSON.parse(result.stdout);

    if (result.exitCode !== 0) throw new Error(row.error.message);

    return row;
  }

  async function listLevels(threadIds: readonly string[]) {
    return fake.harness.behavior.callRpc("threadNotifications.list", {
      threadIds,
    });
  }

  async function reportPresence(idleSeconds: number, locked = false) {
    return fake.harness.behavior.callRpc("presence.report", {
      clientId: "mac-desktop",
      idleSeconds,
      locked,
    });
  }

  async function status() {
    const result = await fake.harness.behavior.runCli(["status", "--json"]);

    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  function signals(channel: string) {
    return fake.harness.realtimeSignals.filter(
      (signal) => signal.channel === channel,
    );
  }

  return {
    ...fake,
    addSubscription,
    attentionChanged,
    attentionHistory,
    cleanup,
    clientSignals: () => signals(CLIENT_NOTIFICATION_CHANNEL),
    levelUpdates: () =>
      signals(THREAD_NOTIFICATIONS_CHANNEL).map((signal) => signal.payload),
    expo,
    getLevel,
    interactions,
    questions,
    listAncestors,
    listLevels,
    setLevel,
    listState,
    reportPresence,
    setThread,
    status,
    storedLevel,
    moveThread,
    threads,
  };
}

async function waitForCoalesce(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 4));
}

type Availability = NonNullable<
  ThreadResponse["work"]
>["assessment"]["availability"];

function workWith(availability: Availability): ThreadResponse["work"] {
  return {
    revision: "revision-1",
    basis: "basis-1",
    primary: { label: "open", reason: { code: "test", text: "Test" } },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability,
      reason: "Test",
      sourceSeq: 1,
      suggestion: availability === "available" ? "available" : "unavailable",
      noSuggestionReason: null,
      waitingOn: null,
      ask: null,
      recap: null,
    },
    postponement: null,
    archive: { eligible: false, recommended: false, reason: "Test" },
  };
}

describe("push subscription RPC and CLI", () => {
  it("upserts by token, redacts lists, and reports stable RPC errors", async () => {
    const host = await setup();

    try {
      await expect(host.addSubscription()).resolves.toEqual({
        id: "subscription-1",
        created: true,
      });
      await expect(
        host.addSubscription("ExponentPushToken[phone]", "New phone name"),
      ).resolves.toEqual({ id: "subscription-1", created: false });

      const listed = await host.harness.behavior.callRpc(
        "pushSubscriptions.list",
        {},
      );

      expect(listed).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            deviceLabel: "New phone name",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(JSON.stringify(listed)).not.toContain("ExponentPushToken");

      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.add", {
          expoPushToken: "token",
          platform: "windows",
          deviceLabel: "PC",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "missing",
        }),
      ).rejects.toMatchObject({
        code: "handler_error",
        message: "Push subscription not found: missing",
      });
      await expect(
        host.harness.behavior.callRpc("pushSubscriptions.remove", {
          id: "subscription-1",
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      await host.cleanup();
    }
  });

  it("provides list, add, remove, and status commands", async () => {
    const host = await setup();

    try {
      await expect(
        host.harness.behavior.runCli([
          "add",
          "--platform",
          "ios",
          "--label",
          "Phone",
          "--token",
          "ExponentPushToken[phone]",
        ]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Registered push device subscription-1",
      });
      const list = await host.harness.behavior.runCli(["list", "--json"]);
      expect(JSON.parse(list.stdout)).toEqual({
        subscriptions: [
          expect.objectContaining({
            id: "subscription-1",
            tokenSuffix: "phone]",
          }),
        ],
      });
      expect(list.stdout).not.toContain("ExponentPushToken");
      const status = await host.harness.behavior.runCli(["status", "--json"]);
      expect(JSON.parse(status.stdout)).toEqual({
        enabled: true,
        mobileEnabled: true,
        mobileOnlyWhenAway: true,
        desktopPresence: "away",
        heldMobileCount: 0,
        webEnabled: true,
        desktopEnabled: true,
        defaultLevel: "all",
        childLevel: "input-only",
        subscriptionCount: 1,
        relayUrl: EXPO_URL,
        lastSendOutcome: { status: "never" },
      });
      await expect(
        host.harness.behavior.runCli(["remove", "subscription-1"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Removed push device subscription-1",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("documents limits in help, validates options, and reports errors as JSON", async () => {
    const host = await setup();

    try {
      const help = (await host.harness.behavior.runCli(["add", "--help"]))
        .stdout;

      expect(help).toContain("omnyo push-notifications add");
      expect(help).toContain("at most 512 characters");

      const badPlatform = await host.harness.behavior.runCli([
        "add",
        "--token",
        "ExponentPushToken[watch]",
        "--platform",
        "watchos",
        "--label",
        "Watch",
      ]);

      expect(badPlatform.exitCode).toBe(1);
      expect(badPlatform.stderr).toContain(
        "invalid value 'watchos' for --platform. Expected one of: ios, android",
      );

      const guessed = await host.harness.behavior.runCli([
        "add",
        "--expo-token",
        "ExponentPushToken[tablet]",
        "--os",
        "android",
        "--device",
        "Tablet",
        "--json",
      ]);

      expect(guessed.exitCode, guessed.stderr).toBe(0);
      expect(JSON.parse(guessed.stdout)).toEqual({
        id: "subscription-1",
        created: true,
      });

      const envelope = await host.harness.behavior.runCli([
        "remove",
        "missing",
        "--json",
      ]);

      expect(envelope.exitCode).toBe(1);
      expect(JSON.parse(envelope.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "subscription_not_found",
          message: "Push subscription not found: missing",
        },
      });
      expect(envelope.stderr).toContain("Push subscription not found: missing");

      const badChannel = await host.harness.behavior.runCli(["test", "sms"]);
      expect(badChannel.exitCode).toBe(1);
      expect(badChannel.stderr).toContain("Use web or desktop");
    } finally {
      await host.cleanup();
    }
  });
});

describe("push sender", () => {
  it("holds a finished-turn notice until its reply prediction is ready", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ work: workWith("checking") });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done.",
      });
      await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 20));
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);

      host.threads.set(thread.id, { ...thread, work: workWith("available") });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.clientSignals()).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("sends a finished-turn notice once the prediction wait expires", async () => {
    const host = await setup({ assessmentWaitMs: COALESCE_MS * 15 });

    try {
      await host.addSubscription();
      const thread = host.setThread({ work: workWith("checking") });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
    } finally {
      await host.cleanup();
    }
  });

  it("waits only briefly when no prediction has started", async () => {
    const host = await setup({ assessmentWaitMs: 60_000 });

    try {
      await host.addSubscription();
      const thread = host.setThread({ work: workWith("stale") });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done.",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
    } finally {
      await host.cleanup();
    }
  });

  it("drops a held notice when the chat is read before the prediction lands", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ work: workWith("checking") });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done.",
      });
      await waitForCoalesce();
      host.threads.set(thread.id, {
        ...thread,
        lastReadAt: thread.latestAttentionAt,
        work: workWith("available"),
      });
      await new Promise((resolve) => setTimeout(resolve, COALESCE_MS * 10));
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it.each(["activePlanModeCount", "activeGoalCount"] as const)(
    "waits for idle work with %s to finish",
    async (counter) => {
      const host = await setup();

      try {
        await host.addSubscription();
        const thread = host.setThread();

        const activity = {
          activeWorkflowCount: 0,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
          activeSubagentCount: 0,
          [counter]: 1,
        };

        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: "The background work is still running.",
        });
        host.listState.set(thread.id, { activity });
        await waitForCoalesce();
        expect(host.expo.requests).toEqual([]);
        expect(host.harness.realtimeSignals).toEqual([]);

        host.listState.delete(thread.id);
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: "All work is finished.",
        });
        await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
        expect(host.harness.realtimeSignals).toHaveLength(1);
        expect(host.expo.requests[0]?.[0]?.body).toBe("All work is finished.");
      } finally {
        await host.cleanup();
      }
    },
  );

  it.each([
    "activeWorkflowCount",
    "activeBackgroundAgentCount",
    "activeBackgroundCommandCount",
  ] as const)(
    "withholds completion while %s keeps running",
    async (counter) => {
      const host = await setup();

      try {
        await host.addSubscription();
        const thread = host.setThread();

        host.listState.set(thread.id, {
          activity: {
            activeWorkflowCount: 0,
            activeBackgroundAgentCount: 0,
            activeBackgroundCommandCount: 0,
            activePlanModeCount: 0,
            activeGoalCount: 0,
            activeSubagentCount: 0,
            [counter]: 1,
          },
        });
        host.threads.set(thread.id, {
          ...thread,
          activeBackgroundAgentCount:
            counter === "activeBackgroundAgentCount" ? 1 : 0,
        });
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: "My background check reports back.",
        });
        await waitForCoalesce();
        expect(host.expo.requests).toEqual([]);
        expect(host.harness.realtimeSignals).toEqual([]);
      } finally {
        await host.cleanup();
      }
    },
  );

  it("withholds completion while its follow-up is held", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();
      host.threads.set(thread.id, { ...thread, queuedMessageCount: 1 });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "A check-back runs after the update.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("withholds completion while a callback is waiting", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();
      host.listState.set(thread.id, {
        attention: {
          kind: "callback-waiting",
          requiredCount: 0,
          optionalCount: 0,
          callback: null,
        },
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Waiting for another chat to return.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("suppresses completion when a queued follow-up starts the next turn", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "An intermediate answer.",
      });
      host.threads.set(thread.id, {
        ...thread,
        status: "active",
        queuedMessageCount: 0,
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it.each(["pending", "starting", "active", "stopping"] as const)(
    "suppresses completion while a hidden child is %s",
    async (status) => {
      const host = await setup();

      try {
        await host.addSubscription();
        const thread = host.setThread();
        host.setThread({
          parentThreadId: thread.id,
          visibility: "hidden",
          status,
        });
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: "Waiting for the child.",
        });
        await waitForCoalesce();
        expect(host.expo.requests).toEqual([]);
        expect(host.harness.realtimeSignals).toEqual([]);
      } finally {
        await host.cleanup();
      }
    },
  );

  it("checks child turns past the first page", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();

      for (let index = 0; index < 101; index += 1) {
        host.setThread({ id: `child-${index}`, parentThreadId: thread.id });
      }

      host.listState.set("child-100", { status: "active" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Waiting for the last child.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("checks work in nested child chats", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();
      const child = host.setThread({ parentThreadId: thread.id });
      host.setThread({ parentThreadId: child.id, status: "active" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Waiting for the grandchild.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("finds the finishing chat past the first activity page", async () => {
    const host = await setup();

    try {
      await host.addSubscription();

      for (let index = 0; index < 101; index += 1) {
        host.setThread({ id: `older-${index}` });
      }

      const thread = host.setThread({ id: "finishing-thread" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Finished after reading all activity pages.",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.data.threadId).toBe(thread.id);
    } finally {
      await host.cleanup();
    }
  });

  it("withholds completion when its activity cannot be checked", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();
      host.harness.sdk.stub("threads.list", async () => {
        throw new Error("Activity unavailable");
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "An unverified completion.",
      });
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.harness.realtimeSignals).toEqual([]);
      expect(host.harness.logEntries).toEqual(
        expect.arrayContaining([expect.objectContaining({ level: "error" })]),
      );
    } finally {
      await host.cleanup();
    }
  });

  it("still delivers pending input while background work continues", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ queuedMessageCount: 1 });
      host.listState.set(thread.id, {
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 0,
          activeBackgroundCommandCount: 0,
          activePlanModeCount: 0,
          activeGoalCount: 0,
          activeSubagentCount: 0,
        },
      });

      const interaction = pendingQuestion(
        thread.id,
        "Which result should I use?",
      );

      host.interactions.set(thread.id, [interaction]);
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Waiting for the workflow.",
      });
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.data.kind).toBe("pending-interaction");
      expect(host.harness.realtimeSignals).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("sends a root idle preview to each device and reads the relay setting at flush", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      await host.addSubscription("ExponentPushToken[tablet]", "Tablet");
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done: the timer race is fixed.\nMore details.",
      });
      await host.harness.behavior.setSettings({
        expoPushUrl: "http://expo.test/changed",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.urls).toEqual(["http://expo.test/changed"]);
      expect(host.expo.requests[0]).toHaveLength(2);
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Fix the flaky test",
        body: "Done: the timer race is fixed. More details.",
        data: {
          kind: "turn-finished",
          projectId: "project-1",
          threadId: thread.id,
        },
        sound: "default",
        channelId: "threads",
        priority: "high",
      });
      expect(host.expo.requests[0]?.[0]?.data).not.toHaveProperty("serverUrl");
      await vi.waitFor(async () => {
        const result = await host.harness.behavior.runCli(["status", "--json"]);
        expect(JSON.parse(result.stdout).lastSendOutcome).toMatchObject({
          status: "sent",
          sentCount: 2,
        });
      });
    } finally {
      await host.cleanup();
    }
  });

  it("sends the first paragraph as plain text with thread references named", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      host.setThread({ id: "thr_aedn9u3q8i", title: "Fix scroll jumps" });
      host.setThread({
        id: "thr_23456789ab",
        title:
          "Compare Omnyo in-app terminal against Moshi, Termius, and Blink Shell",
      });
      const thread = host.setThread({ title: "Discord Dude" });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: [
          "## Summary",
          "",
          "@thread:thr_aedn9u3q8i fixed **[#4793](https://github.com/get-bb/bb/issues/4793)**",
          "as `9579549809`; thr_8quy6y32b5 and snake_case_name remain.",
          "Then see @thread:thr_23456789ab.",
          "",
          "Second paragraph.",
        ].join("\n"),
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Discord Dude",
        body: "“Fix scroll jumps” fixed #4793 as 9579549809; thr_8quy6y32b5 and snake_case_name remain. Then see “Compare Omnyo in-app terminal against M…”.",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("skips directives, tables, and raw JSON in the preview", async () => {
    const host = await setup();

    try {
      await host.addSubscription();

      const previews = {
        Directive: [
          '::page{id="2d98aecf" version="e4d24dd2" display="inline"}',
          "",
          "Pick one icon and press Ship.",
        ],
        Table: [
          "## Result",
          "",
          "| Step | Before | After |",
          "|---|---|---|",
          "| Template | Unset | Set |",
          "The deployment did not change.",
        ],
        Json: [
          "{",
          '  "ok": true,',
          '  "enrolled": 9',
          "}",
          "",
          "All nine people are enrolled.",
        ],
        "Directive only": ['::page{id="2d98aecf" version="e4d24dd2"}'],
      };

      for (const [title, lines] of Object.entries(previews)) {
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread: host.setThread({ title }),
          lastAssistantText: lines.join("\n"),
        });
      }

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(4));

      const bodies = Object.fromEntries(
        host.expo.requests.map((request) => [
          request[0]?.title,
          request[0]?.body,
        ]),
      );

      expect(bodies).toEqual({
        Directive: "Pick one icon and press Ship.",
        Table: "The deployment did not change.",
        Json: "All nine people are enrolled.",
        "Directive only": "Finished and waiting for you",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("includes the configured public server URL", async () => {
    const host = await setup({ appUrl: "https://omnyo.example.test" });

    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.data).toEqual({
        kind: "turn-finished",
        projectId: "project-1",
        serverUrl: "https://omnyo.example.test",
        threadId: thread.id,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("sends nothing for a finished turn that raised no new attention", async () => {
    let now = 1_000;
    const host = await setup({ now: () => now });

    try {
      await host.addSubscription();
      const checked = host.setThread({ id: "thread-negative-check" });
      host.threads.set(checked.id, {
        ...checked,
        latestAttentionAt: 500,
        lastReadAt: 900,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: checked,
        lastAssistantText: "Nothing changed yet",
      });
      now += 2;
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("drops child, read, hidden, archived, and stale-status events", async () => {
    let now = 1_000;
    const host = await setup({ now: () => now });

    try {
      await host.addSubscription();
      const child = host.setThread({ parentThreadId: "parent-1" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: child,
        lastAssistantText: "Child done",
      });

      const read = host.setThread({ id: "thread-read" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: read,
        lastAssistantText: "Read done",
      });
      host.threads.set(read.id, {
        ...read,
        latestAttentionAt: now + 1,
        lastReadAt: now + 1,
      });

      const stale = host.setThread({ id: "thread-stale" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: stale,
        lastAssistantText: "Stale done",
      });
      host.threads.set(stale.id, { ...stale, status: "active" });

      const hidden = host.setThread({ id: "thread-hidden" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: hidden,
        error: "Failed",
      });
      host.threads.set(hidden.id, {
        ...hidden,
        status: "error",
        visibility: "hidden",
      });

      const archived = host.setThread({ id: "thread-archived" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: archived,
        error: "Failed",
      });
      host.threads.set(archived.id, {
        ...archived,
        status: "error",
        archivedAt: now,
      });
      now += 2;
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("notifies once when a running chat opens an Omnyo question", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active", title: "Release" });

      host.questions.set(thread.id, [
        nativeQuestion(thread.id, "Which cleanup should the plan include?"),
      ]);
      host.attentionChanged(thread.id);
      host.attentionChanged(thread.id);

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]).toEqual([
        expect.objectContaining({
          title: "Release",
          body: "Which cleanup should the plan include?",
          data: expect.objectContaining({ kind: "pending-interaction" }),
        }),
      ]);
      expect(
        host
          .clientSignals()
          .map((signal) => clientNotificationSchema.parse(signal.payload)),
      ).toEqual([
        expect.objectContaining({
          threadId: thread.id,
          kind: "pending-interaction",
          body: "Which cleanup should the plan include?",
          channels: ["web", "desktop"],
        }),
      ]);

      host.attentionChanged(thread.id);
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
      expect(host.clientSignals()).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("names the question that triggered the notice, not an older open one", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active", title: "Release" });

      host.questions.set(thread.id, [
        nativeQuestion(thread.id, "An older required question", {
          id: "older",
          mode: "required",
          createdAt: Date.now() - 10 * 60_000,
        }),
        nativeQuestion(thread.id, "The new optional question", { id: "new" }),
      ]);
      host.attentionChanged(thread.id);

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]?.body).toBe(
        "The new optional question",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("drops a resolved interaction even while an older question stays open", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active" });
      const interaction = pendingQuestion(thread.id, "Approve the deploy?");

      host.questions.set(thread.id, [
        nativeQuestion(thread.id, "An older question", {
          createdAt: Date.now() - 10 * 60_000,
        }),
      ]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });

      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("skips Omnyo questions that are old or closed before delivery", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const stale = host.setThread({ status: "active" });

      host.questions.set(stale.id, [
        nativeQuestion(stale.id, "Asked before the restart", {
          createdAt: Date.now() - 10 * 60_000,
        }),
      ]);
      host.attentionChanged(stale.id);

      const withdrawn = host.setThread({ status: "active" });
      host.questions.set(withdrawn.id, [
        nativeQuestion(withdrawn.id, "Withdrawn right away", {
          mode: "required",
        }),
      ]);
      host.attentionChanged(withdrawn.id);

      const reads = () =>
        host.attentionHistory.mock.calls.filter(
          ([args]) => args.threadId === withdrawn.id,
        ).length;

      await vi.waitFor(() => expect(reads()).toBe(1));
      host.questions.set(withdrawn.id, [
        nativeQuestion(withdrawn.id, "Withdrawn right away", {
          mode: "required",
          state: "withdrawn",
        }),
      ]);

      await waitForCoalesce();
      expect(reads()).toBe(2);
      expect(host.expo.requests).toEqual([]);
      expect(host.clientSignals()).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("coalesces interaction and idle events, prefers the interaction, and checks it again", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread({ status: "active", title: "Release" });

      const interaction = pendingQuestion(
        thread.id,
        "Ship to staging or production?",
      );

      host.interactions.set(thread.id, [interaction]);

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: { ...thread, status: "idle" },
        lastAssistantText: "Done",
      });
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread,
        interaction,
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]).toEqual([
        expect.objectContaining({
          title: "Release",
          body: "Ship to staging or production?",
          data: expect.objectContaining({ kind: "pending-interaction" }),
        }),
      ]);

      const answered = host.setThread({ id: "thread-answered" });
      const answeredInteraction = pendingQuestion(answered.id, "Continue?");
      host.interactions.set(answered.id, [answeredInteraction]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: answered,
        interaction: answeredInteraction,
      });
      host.interactions.set(answered.id, []);
      await waitForCoalesce();
      expect(host.expo.requests).toHaveLength(1);
    } finally {
      await host.cleanup();
    }
  });

  it("batches devices and removes rows that Expo rejects as unregistered", async () => {
    const host = await setup();

    try {
      for (let index = 0; index < 101; index += 1) {
        await host.addSubscription(
          `ExponentPushToken[device-${index}]`,
          `Device ${index}`,
        );
      }

      host.expo.ticketErrors.set(
        "ExponentPushToken[device-100]",
        "DeviceNotRegistered",
      );
      const thread = host.setThread({ status: "error" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread,
        error: "Provider exited with code 1\nStack",
      });

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(2));
      expect(host.expo.requests.map((batch) => batch.length)).toEqual([100, 1]);
      await vi.waitFor(async () => {
        const listed = listPushSubscriptionsOutputSchema.parse(
          await host.harness.behavior.callRpc("pushSubscriptions.list", {}),
        );

        expect(listed.subscriptions).toHaveLength(100);
      });
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("warns once per hour for network failures and logs only row ids", async () => {
    let now = 10_000;

    const host = await setup({
      now: () => now,
      fetch: async () => {
        throw new Error("ECONNREFUSED with ExponentPushToken[secret]");
      },
    });

    try {
      await host.addSubscription();

      const trigger = async (id: string) => {
        const thread = host.setThread({ id, status: "error" });
        await host.harness.behavior.emitThreadEvent("thread.failed", {
          thread,
          error: "Provider failed",
        });
        await waitForCoalesce();
      };

      await trigger("thread-first");
      now += 3_599_999;
      await trigger("thread-second");
      now += 1;
      await trigger("thread-third");

      const warnings = host.harness.logEntries.filter(
        (entry) =>
          entry.level === "warn" &&
          entry.message.startsWith("Expo push request failed"),
      );

      expect(warnings).toHaveLength(2);
      expect(warnings[0]?.message).toContain("subscription-1");
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
      expect(host.harness.errorReports).toEqual([
        {
          message: "Expo push send failed: network",
          operation: "expo.send",
          code: "network",
        },
        {
          message: "Expo push send failed: network",
          operation: "expo.send",
          code: "network",
        },
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it("reports rejected tickets without checking their receipts", async () => {
    const host = await setup({ receiptDelayMs: 10 });

    try {
      await host.addSubscription("ExponentPushToken[limited]", "Limited");
      host.expo.ticketErrors.set(
        "ExponentPushToken[limited]",
        "MessageRateExceeded",
      );
      const thread = host.setThread({ status: "error" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread,
        error: "Provider failed",
      });

      await vi.waitFor(() =>
        expect(host.harness.errorReports).toEqual([
          {
            message: "Expo push ticket failed: MessageRateExceeded",
            operation: "expo.ticket",
            code: "MessageRateExceeded",
          },
        ]),
      );
      await waitForCoalesce();
      expect(host.expo.receiptRequests).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("retries a failed receipt read without reporting recovery or resending the push", async () => {
    const expo = createFakeExpo();
    let receiptAttempts = 0;

    const host = await setup({
      expo,
      receiptDelayMs: 10,
      fetch: async (url, init) => {
        if (url === EXPO_RECEIPTS_URL && ++receiptAttempts === 1) {
          throw Object.assign(new Error("private network detail"), {
            code: "ECONNRESET",
          });
        }

        return expo.fetch(url, init);
      },
    });

    try {
      await host.addSubscription();
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: host.setThread({ status: "error" }),
        error: "Provider failed",
      });
      await vi.waitFor(() => expect(expo.receiptRequests).toHaveLength(1));
      expect(receiptAttempts).toBe(2);
      expect(expo.requests).toHaveLength(1);
      expect(host.harness.errorReports).toEqual([]);
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "private network detail",
      );
    } finally {
      await host.cleanup();
    }
  });

  it.each(["ECONNRESET", "ENOTFOUND", "CUSTOM_PROVIDER_FAILURE"])(
    "reports a receipt outage for %s once after three read attempts",
    async (code) => {
      const expo = createFakeExpo();
      let receiptAttempts = 0;

      const host = await setup({
        expo,
        receiptDelayMs: 10,
        fetch: async (url, init) => {
          if (url === EXPO_RECEIPTS_URL) {
            receiptAttempts += 1;
            throw Object.assign(new Error("private network detail"), {
              code,
            });
          }

          return expo.fetch(url, init);
        },
      });

      try {
        await host.addSubscription();
        await host.harness.behavior.emitThreadEvent("thread.failed", {
          thread: host.setThread({ status: "error" }),
          error: "Provider failed",
        });
        await vi.waitFor(() => expect(receiptAttempts).toBe(3));
        await host.harness.behavior.runCli(["status", "--json"]);
        expect(expo.requests).toHaveLength(1);
        expect(host.harness.errorReports).toHaveLength(1);
        expect(host.harness.errorReports[0]).toMatchObject({
          operation: "expo.receipts",
          code,
          experimental_diagnostic: {
            stage: "receive",
            failureClass: "connection",
            outcome: "terminal",
            retryable: true,
            attempt: 3,
            itemCount: 1,
            ...(code === "CUSTOM_PROVIDER_FAILURE"
              ? {}
              : { transportCode: code }),
          },
        });

        if (code === "CUSTOM_PROVIDER_FAILURE") {
          expect(
            host.harness.errorReports[0]?.experimental_diagnostic,
          ).not.toHaveProperty("transportCode");
        }

        expect(JSON.stringify(host.harness.errorReports)).not.toContain(
          "private network detail",
        );
      } finally {
        await host.cleanup();
      }
    },
  );

  it.each([
    {
      status: 503,
      body: "upstream failed",
      attempts: 3,
      code: "http_503",
      failureClass: "upstream-unavailable",
      stage: "receive",
    },
    {
      status: 403,
      body: "forbidden",
      attempts: 1,
      code: "http_403",
      failureClass: "upstream-rejected",
      stage: "receive",
    },
    {
      status: 200,
      body: "invalid JSON",
      attempts: 1,
      code: "invalid_response",
      failureClass: "invalid-response",
      stage: "decode",
    },
    {
      status: 200,
      body: '{"data":{}}',
      attempts: 3,
      code: "receipt_unavailable",
      failureClass: "upstream-unavailable",
      stage: "receive",
    },
  ])(
    "reports receipt failure $code after $attempts attempts",
    async ({ status, body, attempts, code, failureClass, stage }) => {
      const expo = createFakeExpo();
      let receiptAttempts = 0;

      const host = await setup({
        expo,
        receiptDelayMs: 10,
        fetch: async (url, init) => {
          if (url === EXPO_RECEIPTS_URL) {
            receiptAttempts += 1;

            return { ok: status === 200, status, text: async () => body };
          }

          return expo.fetch(url, init);
        },
      });

      try {
        await host.addSubscription();
        await host.harness.behavior.emitThreadEvent("thread.failed", {
          thread: host.setThread({ status: "error" }),
          error: "Provider failed",
        });
        await vi.waitFor(() =>
          expect(host.harness.errorReports).toHaveLength(1),
        );
        expect(receiptAttempts).toBe(attempts);
        expect(expo.requests).toHaveLength(1);
        expect(host.harness.errorReports[0]).toMatchObject({
          operation: "expo.receipts",
          code,
          experimental_diagnostic: {
            stage,
            failureClass,
            outcome: "terminal",
            attempt: attempts,
            itemCount: 1,
          },
        });
      } finally {
        await host.cleanup();
      }
    },
  );

  it("retries only missing receipts and preserves a terminal delivery failure", async () => {
    const expo = createFakeExpo();
    let receiptAttempts = 0;

    const host = await setup({
      expo,
      receiptDelayMs: 10,
      fetch: async (url, init) => {
        if (url === EXPO_RECEIPTS_URL && ++receiptAttempts === 1) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                data: {
                  "ticket-ExponentPushToken[broken]": {
                    status: "error",
                    details: { error: "InvalidCredentials" },
                  },
                },
              }),
          };
        }

        return expo.fetch(url, init);
      },
    });

    try {
      await host.addSubscription("ExponentPushToken[broken]", "Broken");
      await host.addSubscription("ExponentPushToken[missing]", "Missing");
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: host.setThread({ status: "error" }),
        error: "Provider failed",
      });
      await vi.waitFor(() =>
        expect(expo.receiptRequests).toEqual([
          ["ticket-ExponentPushToken[missing]"],
        ]),
      );
      expect(expo.requests).toHaveLength(1);
      expect(host.harness.errorReports).toEqual([
        {
          message: "Expo push receipt failed: InvalidCredentials",
          operation: "expo.receipt",
          code: "InvalidCredentials",
        },
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it("checks receipts, removes unregistered devices and reports delivery failures", async () => {
    const host = await setup({ receiptDelayMs: 10 });

    try {
      await host.addSubscription("ExponentPushToken[broken]", "Broken");
      await host.addSubscription("ExponentPushToken[gone]", "Gone");
      await host.addSubscription("ExponentPushToken[fine]", "Fine");
      host.expo.receiptErrors.set(
        "ticket-ExponentPushToken[broken]",
        "InvalidCredentials",
      );
      host.expo.receiptErrors.set(
        "ticket-ExponentPushToken[gone]",
        "DeviceNotRegistered",
      );
      const thread = host.setThread({ status: "error" });
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread,
        error: "Provider failed",
      });

      await vi.waitFor(async () => {
        const listed = listPushSubscriptionsOutputSchema.parse(
          await host.harness.behavior.callRpc("pushSubscriptions.list", {}),
        );

        expect(
          listed.subscriptions.map((row) => row.deviceLabel).sort(),
        ).toEqual(["Broken", "Fine"]);
      });
      expect(host.expo.receiptRequests).toEqual([
        [
          "ticket-ExponentPushToken[broken]",
          "ticket-ExponentPushToken[gone]",
          "ticket-ExponentPushToken[fine]",
        ],
      ]);
      await vi.waitFor(async () => {
        const result = await host.harness.behavior.runCli(["status", "--json"]);

        expect(JSON.parse(result.stdout).lastSendOutcome).toMatchObject({
          status: "failed",
          reason: "delivery failed: InvalidCredentials",
        });
      });
      expect(host.harness.errorReports).toEqual([
        {
          message: "Expo push receipt failed: InvalidCredentials",
          operation: "expo.receipt",
          code: "InvalidCredentials",
        },
      ]);
      expect(JSON.stringify(host.harness.logEntries)).not.toContain(
        "ExponentPushToken",
      );
    } finally {
      await host.cleanup();
    }
  });
});

describe("web and desktop delivery", () => {
  it("retains a thread notice until a delayed desktop consumer accepts it", async () => {
    const host = await setup();

    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Ready while the window was closed",
      });
      await waitForCoalesce();

      const pending = await host.harness.behavior.callRpc(
        "notifications.pending",
        {},
      );

      expect(pending).toMatchObject({
        messages: [
          {
            threadId: thread.id,
            body: "Ready while the window was closed",
            channels: ["web", "desktop"],
          },
        ],
      });
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toEqual({ messages: [] });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toEqual(pending);
      await host.harness.behavior.setSettings({ desktopEnabled: true });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toEqual(pending);

      const message = clientNotificationSchema.parse(
        host.clientSignals()[0]?.payload,
      );

      const acknowledgment = {
        id: message.id,
        clientId: "desktop-owner",
        channel: "desktop",
      };

      expect(
        await host.api.storage.kv.get(
          `pending-automatic-notification:${message.id}`,
        ),
      ).toMatchObject({ message });

      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          acknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          acknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toEqual({ messages: [] });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toEqual(pending);
      const webAcknowledgment = { ...acknowledgment, channel: "web" };
      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          webAcknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 2 });
      expect(
        await host.api.storage.kv.get(
          `pending-automatic-notification:${message.id}`,
        ),
      ).toBeUndefined();
      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          webAcknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 2 });
    } finally {
      await host.cleanup();
    }
  });

  it("delivers without mobile subscriptions and applies channel changes immediately", async () => {
    const host = await setup();

    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toEqual([
        {
          channel: CLIENT_NOTIFICATION_CHANNEL,
          payload: expect.objectContaining({
            title: thread.title,
            body: "Done",
            threadId: thread.id,
            kind: "turn-finished",
            channels: ["web", "desktop"],
          }),
        },
      ]);
      await host.addSubscription();
      await host.harness.behavior.setSettings({
        mobileEnabled: false,
        webEnabled: false,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Desktop only",
      });
      await waitForCoalesce();
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      expect(host.expo.requests).toHaveLength(0);
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Disabled",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });

  it("routes CLI and RPC tests only to the selected enabled channel", async () => {
    const host = await setup();

    try {
      expect(await host.harness.behavior.runCli(["test", "web"])).toMatchObject(
        { exitCode: 0 },
      );
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["web"],
        threadId: null,
        kind: null,
      });
      await host.harness.behavior.callRpc("notifications.test", {
        channel: "desktop",
      });
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        channels: ["desktop"],
      });
      await host.harness.behavior.setSettings({ desktopEnabled: false });
      expect(
        await host.harness.behavior.runCli(["test", "desktop"]),
      ).toMatchObject({ exitCode: 1 });
      await expect(
        host.harness.behavior.callRpc("notifications.test", {
          channel: "desktop",
        }),
      ).rejects.toThrow("disabled");
      await expect(
        host.harness.behavior.callRpc("notifications.test", { channel: "ios" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(host.clientSignals()).toHaveLength(2);
    } finally {
      await host.cleanup();
    }
  });
});

describe("thread notification levels", () => {
  it("reads the same effective notification owner through RPC and CLI", async () => {
    const host = await setup();

    try {
      const root = host.setThread({ id: "rpc-owner-root" });

      const child = host.setThread({
        id: "rpc-owner-child",
        parentThreadId: root.id,
      });

      await host.setLevel(root.id, "muted");
      await host.setLevel(child.id, "all");

      const limited = await host.harness.behavior.callRpc(
        "threadNotifications.get",
        {
          threadId: child.id,
        },
      );

      expect(limited).toEqual({
        own: "all",
        effective: "muted",
        source: "parent",
      });
      expect(limited).toEqual(await host.getLevel(child.id));
      await host.setLevel(root.id, "inherit");
      await expect(
        host.harness.behavior.callRpc("threadNotifications.get", {
          threadId: child.id,
        }),
      ).resolves.toEqual({ own: "all", effective: "all", source: "self" });
      await expect(
        host.harness.behavior.callRpc("threadNotifications.get", {
          threadId: "",
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
    } finally {
      await host.cleanup();
    }
  });

  it.each([
    {
      name: "unset worker under an unset parent gets the child default",
      grandparent: "inherit",
      parent: "inherit",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "input-only", source: "child-default" },
        worker: { effective: "input-only", source: "child-default" },
      },
    },
    {
      name: "a worker's own all beats the child default",
      grandparent: "inherit",
      parent: "inherit",
      worker: "all",
      childLevel: "input-only",
      expected: {
        parent: { effective: "input-only", source: "child-default" },
        worker: { effective: "all", source: "self" },
      },
    },
    {
      name: "a parent set to all does not raise an unset worker",
      grandparent: "inherit",
      parent: "all",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "all", source: "self" },
        worker: { effective: "input-only", source: "child-default" },
      },
    },
    {
      name: "a muted parent mutes an unset worker",
      grandparent: "inherit",
      parent: "muted",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "muted", source: "self" },
        worker: { effective: "muted", source: "parent" },
      },
    },
    {
      name: "a muted grandparent caps a parent set to all and its workers",
      grandparent: "muted",
      parent: "all",
      worker: "inherit",
      childLevel: "input-only",
      expected: {
        parent: { effective: "muted", source: "parent" },
        worker: { effective: "muted", source: "ancestor" },
      },
    },
    {
      name: "a muted grandparent caps a worker set to all",
      grandparent: "muted",
      parent: "inherit",
      worker: "all",
      childLevel: "all",
      expected: {
        parent: { effective: "muted", source: "parent" },
        worker: { effective: "muted", source: "ancestor" },
      },
    },
  ])("$name", async ({ grandparent, parent, worker, childLevel, expected }) => {
    const host = await setup();

    try {
      await host.harness.behavior.setSettings({ childLevel });
      const root = host.setThread({ id: "root" });
      const middle = host.setThread({ id: "middle", parentThreadId: root.id });
      const leaf = host.setThread({ id: "leaf", parentThreadId: middle.id });
      await host.setLevel(leaf.id, worker);
      await host.setLevel(middle.id, parent);
      await host.setLevel(root.id, grandparent);
      await expect(host.getLevel(middle.id)).resolves.toEqual({
        own: parent,
        ...expected.parent,
      });
      await expect(host.getLevel(leaf.id)).resolves.toEqual({
        own: worker,
        ...expected.worker,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("stores only each thread's own level and resolves limits from the current tree", async () => {
    const host = await setup();

    try {
      const root = host.setThread({ id: "root" });
      const child = host.setThread({ id: "child", parentThreadId: root.id });

      const grandchild = host.setThread({
        id: "grandchild",
        parentThreadId: child.id,
      });

      const other = host.setThread({ id: "other" });

      await host.setLevel(root.id, "muted");
      expect(host.storedLevel(root.id)).toBe("muted");
      expect(host.storedLevel(child.id)).toBeNull();
      expect(host.storedLevel(grandchild.id)).toBeNull();
      expect(host.storedLevel(other.id)).toBeNull();
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "ancestor",
      });

      await host.setLevel(child.id, "all");
      expect(host.storedLevel(child.id)).toBe("all");
      await expect(host.getLevel(child.id)).resolves.toEqual({
        own: "all",
        effective: "muted",
        source: "parent",
      });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "ancestor",
      });

      await host.setLevel(root.id, "inherit");
      expect(host.storedLevel(root.id)).toBeNull();
      await expect(host.getLevel(child.id)).resolves.toEqual({
        own: "all",
        effective: "all",
        source: "self",
      });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });

      await host.setLevel(child.id, "inherit");
      expect(host.storedLevel(child.id)).toBeNull();

      await host.harness.behavior.setSettings({ defaultLevel: "muted" });
      await expect(host.getLevel(root.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "global",
      });
      await host.harness.behavior.setSettings({ childLevel: "inherit" });
      await expect(host.getLevel(grandchild.id)).resolves.toEqual({
        own: "inherit",
        effective: "muted",
        source: "global",
      });

      await expect(host.getLevel("missing")).rejects.toThrow(
        "Thread not found",
      );
      await expect(host.setLevel("missing", "muted")).rejects.toThrow(
        "Thread not found",
      );
    } finally {
      await host.cleanup();
    }
  });

  it("follows a thread nested under a new parent or released from an archived one", async () => {
    const host = await setup();

    try {
      const muted = host.setThread({ id: "muted" });
      const loud = host.setThread({ id: "loud" });
      const worker = host.setThread({ id: "worker", parentThreadId: muted.id });

      const subWorker = host.setThread({
        id: "sub-worker",
        parentThreadId: worker.id,
        status: "active",
      });

      await host.setLevel(muted.id, "muted");
      await host.setLevel(loud.id, "all");
      await expect(host.getLevel(subWorker.id)).resolves.toMatchObject({
        effective: "muted",
        source: "ancestor",
      });

      host.moveThread(worker.id, loud.id);
      await expect(host.getLevel(subWorker.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });
      const question = pendingQuestion(subWorker.id, "Ship it?");
      host.interactions.set(subWorker.id, [question]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: host.threads.get(subWorker.id)!,
        interaction: question,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: subWorker.id, body: "Ship it?" }),
      ]);

      host.moveThread(worker.id, muted.id);
      await expect(host.getLevel(subWorker.id)).resolves.toMatchObject({
        effective: "muted",
        source: "ancestor",
      });
      host.moveThread(worker.id, null);
      await expect(host.getLevel(worker.id)).resolves.toEqual({
        own: "inherit",
        effective: "all",
        source: "global",
      });
      await expect(host.getLevel(subWorker.id)).resolves.toEqual({
        own: "inherit",
        effective: "input-only",
        source: "child-default",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("publishes a moved thread's subtree when its parent changes", async () => {
    const host = await setup();

    try {
      const muted = host.setThread({ id: "muted" });
      const worker = host.setThread({ id: "worker" });

      const subWorker = host.setThread({
        id: "sub-worker",
        parentThreadId: worker.id,
      });

      host.setThread({ id: "other" });
      await host.setLevel(muted.id, "muted");
      const published = host.levelUpdates().length;

      host.moveThread(worker.id, muted.id);
      await host.harness.behavior.emitThreadEvent(
        "experimental_thread.parentChanged",
        { thread: host.threads.get(worker.id)!, previousParentThreadId: null },
      );

      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: muted.id },
      };

      expect(host.levelUpdates().slice(published)).toEqual([
        { threads: { [worker.id]: capped, [subWorker.id]: capped } },
      ]);
    } finally {
      await host.cleanup();
    }
  });

  it.each([false, true])(
    "keeps overlapping subtree refreshes current (earlier read fails: %s)",
    async (failRead) => {
      const host = await setup();
      let release!: () => void;
      let capture!: () => void;

      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const captured = new Promise<void>((resolve) => {
        capture = resolve;
      });

      try {
        host.setThread({ id: "muted" });
        host.setThread({ id: "worker", parentThreadId: "muted" });
        host.setThread({ id: "child", parentThreadId: "worker" });
        await host.setLevel("muted", "muted");
        const readAncestors = host.listAncestors.getMockImplementation()!;
        host.listAncestors.mockImplementationOnce(async (args) => {
          const result = await readAncestors(args);
          capture();
          await gate;

          if (failRead) throw new Error("Ancestry read failed");

          return result;
        });

        const older = host.harness.behavior.emitThreadEvent(
          "experimental_thread.parentChanged",
          {
            thread: host.threads.get("worker")!,
            previousParentThreadId: null,
          },
        );

        await captured;
        host.moveThread("child", null);

        const newer = host.harness.behavior.emitThreadEvent(
          "experimental_thread.parentChanged",
          {
            thread: host.threads.get("child")!,
            previousParentThreadId: "worker",
          },
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        release();
        await Promise.all([older, newer]);
        expect(host.levelUpdates().at(-1)).toEqual({
          threads: { child: { own: "inherit", ancestorCap: null } },
        });
      } finally {
        release();
        await host.cleanup();
      }
    },
  );

  it("publishes only live, visible descendants and republishes a thread when it is unarchived", async () => {
    const host = await setup();

    try {
      const root = host.setThread({ id: "root" });

      const archived = host.setThread({
        id: "archived",
        parentThreadId: root.id,
        archivedAt: 1,
      });

      const worker = host.setThread({
        id: "worker",
        parentThreadId: archived.id,
      });

      host.setThread({
        id: "hidden",
        parentThreadId: root.id,
        visibility: "hidden",
      });

      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: root.id },
      };

      await host.setLevel(root.id, "muted");
      expect(host.levelUpdates()).toEqual([
        {
          threads: {
            [root.id]: { own: "muted", ancestorCap: null },
            [worker.id]: capped,
          },
        },
      ]);

      const unarchived = { ...archived, archivedAt: null };
      host.threads.set(archived.id, unarchived);
      await host.harness.behavior.emitThreadEvent("thread.unarchived", {
        thread: unarchived,
      });
      expect(host.levelUpdates().at(-1)).toEqual({
        threads: { [archived.id]: capped, [worker.id]: capped },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("lists resolved levels in one call and publishes the written thread's subtree", async () => {
    const host = await setup();

    try {
      const root = host.setThread({ id: "root" });
      host.setThread({ id: "child", parentThreadId: root.id });
      host.setThread({ id: "other" });

      await host.setLevel(root.id, "muted");

      const capped = {
        own: "inherit",
        ancestorCap: { level: "muted", threadId: root.id },
      };

      await expect(
        host.listLevels(["root", "child", "other"]),
      ).resolves.toEqual({
        threads: { root: { own: "muted", ancestorCap: null }, child: capped },
      });
      expect(host.levelUpdates()).toEqual([
        {
          threads: {
            root: { own: "muted", ancestorCap: null },
            child: capped,
          },
        },
      ]);

      await host.setLevel(root.id, "inherit");
      const unset = { own: "inherit", ancestorCap: null };
      expect(host.levelUpdates().at(-1)).toEqual({
        threads: { root: unset, child: unset },
      });
      await expect(
        host.listLevels(["root", "child", "other"]),
      ).resolves.toEqual({ threads: {} });
    } finally {
      await host.cleanup();
    }
  });

  it("lists the requested threads' rows, archived ones included", async () => {
    const host = await setup();

    try {
      const archived = host.setThread({ id: "archived", archivedAt: 1 });
      const plain = host.setThread({ id: "plain" });
      host.setThread({ id: "unrequested" });
      await host.setLevel(archived.id, "muted");
      await host.setLevel("unrequested", "all");
      await expect(
        host.listLevels([archived.id, plain.id, "missing"]),
      ).resolves.toEqual({
        threads: { archived: { own: "muted", ancestorCap: null } },
      });
      await expect(host.listLevels([])).rejects.toMatchObject({
        code: "invalid_input",
      });
    } finally {
      await host.cleanup();
    }
  });

  it("prints and sets levels from the CLI", async () => {
    const host = await setup();

    try {
      const root = host.setThread({ id: "root" });
      const child = host.setThread({ id: "child", parentThreadId: root.id });

      const grandchild = host.setThread({
        id: "grandchild",
        parentThreadId: child.id,
      });

      await expect(
        host.harness.behavior.runCli(["thread", root.id]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for root: all (default)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", root.id, "--level", "muted"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for root: muted (set on this thread)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", child.id, "--level", "all"]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for child: muted (limited by parent)",
      });
      await expect(
        host.harness.behavior.runCli(["thread", grandchild.id]),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "Notifications for grandchild: muted (limited by an ancestor)",
      });

      const inherited = await host.harness.behavior.runCli([
        "thread",
        child.id,
        "--json",
      ]);

      expect(JSON.parse(inherited.stdout)).toEqual({
        threadId: "child",
        own: "all",
        effective: "muted",
        source: "parent",
      });

      const invalid = await host.harness.behavior.runCli([
        "thread",
        child.id,
        "--level",
        "loud",
      ]);

      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr).toContain("invalid value 'loud' for --level");

      const missing = await host.harness.behavior.runCli([
        "thread",
        "missing",
        "--json",
      ]);

      expect(missing.exitCode).toBe(1);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        ok: false,
        error: { code: "thread_not_found" },
      });
    } finally {
      await host.cleanup();
    }
  });

  it("applies the resolved level at send time", async () => {
    const host = await setup();

    try {
      const muted = host.setThread({ id: "muted", status: "active" });
      await host.setLevel(muted.id, "muted");
      const mutedQuestion = pendingQuestion(muted.id, "Continue?");
      host.interactions.set(muted.id, [mutedQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: muted,
        interaction: mutedQuestion,
      });

      const quiet = host.setThread({ id: "quiet" });
      await host.setLevel(quiet.id, "input-only");
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: quiet,
        lastAssistantText: "Finished quietly",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toEqual([]);

      host.threads.set(quiet.id, { ...quiet, status: "active" });
      const quietQuestion = pendingQuestion(quiet.id, "Deploy now?");
      host.interactions.set(quiet.id, [quietQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: quiet,
        interaction: quietQuestion,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: quiet.id, body: "Deploy now?" }),
      ]);

      const failing = host.setThread({ id: "failing", status: "error" });
      await host.setLevel(failing.id, "input-only");
      await host.harness.behavior.emitThreadEvent("thread.failed", {
        thread: failing,
        error: "Provider crashed",
      });

      const inheritedQuiet = host.setThread({
        id: "inherited-quiet",
        parentThreadId: quiet.id,
        status: "active",
      });

      const inheritedQuestion = pendingQuestion(inheritedQuiet.id, "Merge?");
      host.interactions.set(inheritedQuiet.id, [inheritedQuestion]);
      await host.harness.behavior.emitThreadEvent("interaction.pending", {
        thread: inheritedQuiet,
        interaction: inheritedQuestion,
      });
      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: quiet.id }),
        expect.objectContaining({
          threadId: failing.id,
          body: "Provider crashed",
        }),
        expect.objectContaining({
          threadId: inheritedQuiet.id,
          body: "Merge?",
        }),
      ]);

      await host.harness.behavior.setSettings({ defaultLevel: "input-only" });
      const plain = host.setThread({ id: "plain" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plain,
        lastAssistantText: "Done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(3);
    } finally {
      await host.cleanup();
    }
  });

  it("notifies only chosen trees under a muted default, their workers no louder than the child level", async () => {
    const host = await setup();

    try {
      await host.harness.behavior.setSettings({ defaultLevel: "muted" });
      const plain = host.setThread({ id: "plain" });
      const chosen = host.setThread({ id: "chosen" });
      await host.setLevel(chosen.id, "all");

      const chosenWorker = host.setThread({
        id: "chosen-worker",
        parentThreadId: chosen.id,
      });

      for (const thread of [plain, chosen, chosenWorker]) {
        await host.harness.behavior.emitThreadEvent("thread.idle", {
          thread,
          lastAssistantText: `${thread.id} done`,
        });
      }

      await waitForCoalesce();
      expect(host.clientSignals().map((signal) => signal.payload)).toEqual([
        expect.objectContaining({ threadId: chosen.id }),
      ]);

      const plainWorker = host.setThread({
        id: "plain-worker",
        parentThreadId: plain.id,
      });

      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plainWorker,
        lastAssistantText: "Worker done",
      });
      await waitForCoalesce();
      expect(host.clientSignals()).toHaveLength(1);

      await host.harness.behavior.setSettings({ childLevel: "all" });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: plainWorker,
        lastAssistantText: "Worker done again",
      });
      await waitForCoalesce();
      expect(host.clientSignals().at(-1)?.payload).toMatchObject({
        threadId: plainWorker.id,
        body: "Worker done again",
      });
    } finally {
      await host.cleanup();
    }
  });
});

describe("durable automation notifications", () => {
  const notice = {
    id: "private-upstream:release:proof",
    title: "Omnyo upstream update",
    body: "A new upstream identity is ready for review.",
  };

  it("refreshes live notices without rereading durable history", async () => {
    const host = await setup();

    try {
      const queuedAt = Date.now();

      for (let index = 0; index < 4_680; index += 1) {
        const id = `history-${index}`;

        await host.api.storage.kv.set(`queued-notification:${id}`, {
          message: {
            ...notice,
            id,
            threadId: null,
            channels: ["web", "desktop"],
          },
          acceptedTargets: ["web:browser", "desktop:desktop"],
          queuedAt: queuedAt - (index % 2) * 24 * 60 * 60 * 1_000,
        });
      }

      await host.harness.behavior.callRpc("notifications.send", notice);
      const get = vi.spyOn(host.api.storage.kv, "get");
      const list = vi.spyOn(host.api.storage.kv, "list");
      let yielded = false;

      const heartbeat = new Promise<void>((resolve) => {
        setImmediate(() => {
          yielded = true;
          resolve();
        });
      });

      const pending = await host.harness.behavior.callRpc(
        "notifications.pending",
        {},
      );

      const yieldedDuringLoad = yielded;

      await heartbeat;
      expect(pending).toMatchObject({ messages: [{ id: notice.id }] });
      get.mockClear();
      list.mockClear();

      for (const channel of [undefined, "web", "desktop"] as const) {
        expect(
          await host.harness.behavior.callRpc(
            "notifications.pending",
            channel === undefined ? {} : { channel },
          ),
        ).toEqual(pending);
      }

      expect(get.mock.calls.length).toBe(0);
      expect(list.mock.calls.length).toBe(0);
      expect(yieldedDuringLoad).toBe(true);

      await host.harness.behavior.callRpc("notifications.ack", {
        id: notice.id,
        clientId: "browser-owner",
        channel: "web",
      });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {}),
      ).toEqual({ messages: [] });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toEqual({ messages: [] });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toEqual(pending);

      const next = { ...notice, id: "first-pending" };

      await host.harness.behavior.callRpc("notifications.send", next);
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toMatchObject({ messages: [{ id: next.id }] });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toMatchObject({ messages: [{ id: next.id }, { id: notice.id }] });
    } finally {
      vi.restoreAllMocks();
      await host.cleanup();
    }
  });

  it.each(["acceptance", "retirement"])(
    "keeps pending state consistent when %s persistence fails",
    async (stage) => {
      const host = await setup();

      try {
        await host.harness.behavior.callRpc("notifications.test", {
          channel: "desktop",
        });

        const message = clientNotificationSchema.parse(
          host.clientSignals().at(-1)?.payload,
        );

        const key = `pending-automatic-notification:${message.id}`;
        const pending = { messages: [message] };

        expect(
          await host.harness.behavior.callRpc("notifications.pending", {
            channel: "desktop",
          }),
        ).toEqual(pending);

        const failure = new Error("Storage temporarily unavailable");

        const storage =
          stage === "acceptance"
            ? vi
                .spyOn(host.api.storage.kv, "set")
                .mockRejectedValueOnce(failure)
            : vi
                .spyOn(host.api.storage.kv, "delete")
                .mockRejectedValueOnce(failure);

        const ack = {
          id: message.id,
          clientId: "desktop-owner",
          channel: "desktop",
        };

        await expect(
          host.harness.behavior.callRpc("notifications.ack", ack),
        ).rejects.toThrow("Storage temporarily unavailable");
        storage.mockRestore();

        expect(
          await host.harness.behavior.callRpc("notifications.pending", {
            channel: "desktop",
          }),
        ).toEqual(stage === "acceptance" ? pending : { messages: [] });
        expect(
          await host.harness.behavior.callRpc("notifications.ack", ack),
        ).toEqual({ ok: true, acceptedTargetCount: 1 });
        expect(await host.api.storage.kv.get(key)).toBeUndefined();
      } finally {
        vi.restoreAllMocks();
        await host.cleanup();
      }
    },
  );

  it.each(["refresh", "acknowledgement"])(
    "retires automatic notices that cross their deadline during %s",
    async (operation) => {
      const host = await setup();
      const deadline = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline - 1);

      const message = {
        ...notice,
        id: "deadline-crossing",
        threadId: null,
        channels: ["web", "desktop"],
      };

      const key = `pending-automatic-notification:${message.id}`;

      try {
        await host.api.storage.kv.set(key, {
          message,
          acceptedTargets: [],
          queuedAt: deadline - 24 * 60 * 60 * 1_000,
        });

        if (operation === "acknowledgement") {
          expect(
            await host.harness.behavior.callRpc("notifications.pending", {
              channel: "desktop",
            }),
          ).toEqual({ messages: [{ ...message, kind: null }] });
        }

        let tick = deadline - 1;

        clock.mockImplementation(() => tick++);

        if (operation === "refresh") {
          await host.harness.behavior.callRpc("notifications.pending", {
            channel: "desktop",
          });
        } else {
          await host.harness.behavior.callRpc("notifications.ack", {
            id: message.id,
            clientId: "browser-owner",
            channel: "web",
          });
        }

        clock.mockReturnValue(deadline + 1);

        expect(
          await host.harness.behavior.callRpc("notifications.pending", {
            channel: "desktop",
          }),
        ).toEqual({ messages: [] });
        expect(await host.api.storage.kv.get(key)).toBeUndefined();
        expect(
          await host.api.storage.kv.get(
            `automatic-notification-receipt:${message.id}`,
          ),
        ).toEqual({
          acceptedTargets: operation === "refresh" ? [] : ["web:browser-owner"],
          queuedAt: expect.any(Number),
        });
        expect(
          await host.harness.behavior.callRpc("notifications.ack", {
            id: message.id,
            clientId: "late-desktop",
            channel: "desktop",
          }),
        ).toEqual({
          ok: true,
          acceptedTargetCount: operation === "refresh" ? 1 : 2,
        });
      } finally {
        clock.mockRestore();
        await host.cleanup();
      }
    },
  );

  it("includes writes committed while a replacement plugin is being constructed", async () => {
    const host = await setup();

    let replacement: Awaited<
      ReturnType<typeof host.harness.lifecycle.reload>
    > | null = null;

    try {
      await host.harness.behavior.callRpc("notifications.send", notice);
      await host.harness.behavior.callRpc("notifications.pending", {});
      const lateNotice = { ...notice, id: `${notice.id}:late` };

      replacement = await host.harness.lifecycle.reload(async (api) => {
        await createPushNotificationsPlugin({ fetch: host.expo.fetch })(api);
        await host.harness.behavior.callRpc("notifications.ack", {
          id: notice.id,
          clientId: "browser-owner",
          channel: "web",
        });
        await host.harness.behavior.callRpc("notifications.send", lateNotice);
      });

      expect(
        await replacement.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toMatchObject({ messages: [{ id: lateNotice.id }] });
      expect(
        await replacement.harness.behavior.callRpc("notifications.pending", {
          channel: "desktop",
        }),
      ).toMatchObject({ messages: [{ id: notice.id }, { id: lateNotice.id }] });
    } finally {
      if (replacement) await replacement.harness.lifecycle.dispose();
      else await host.cleanup();
    }
  });

  it("retires accepted automatic payloads without losing delayed acknowledgments or explicit receipts", async () => {
    const host = await setup();

    try {
      await host.harness.behavior.callRpc("notifications.send", notice);
      await host.harness.behavior.callRpc("notifications.ack", {
        id: notice.id,
        clientId: "desktop-owner",
        channel: "desktop",
      });
      let firstId = "";

      for (let index = 0; index < 102; index += 1) {
        await host.harness.behavior.callRpc("notifications.test", {
          channel: "desktop",
        });

        const message = clientNotificationSchema.parse(
          host.clientSignals().at(-1)?.payload,
        );

        if (index === 0) firstId = message.id;
        await host.harness.behavior.callRpc("notifications.ack", {
          id: message.id,
          clientId: "desktop-owner",
          channel: "desktop",
        });
      }

      expect(await host.api.storage.kv.list("queued-notification:")).toEqual([
        `queued-notification:${notice.id}`,
      ]);
      expect(
        await host.api.storage.kv.list("pending-automatic-notification:"),
      ).toEqual([]);
      expect(
        await host.harness.behavior.callRpc("notifications.ack", {
          id: firstId,
          clientId: "desktop-owner",
          channel: "desktop",
        }),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.send", notice),
      ).toMatchObject({
        duplicate: true,
        status: "dispatched",
        acceptedTargetCount: 1,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("stops offering notices nobody accepted within a day", async () => {
    const host = await setup();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);

    try {
      const thread = host.setThread();
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Finished while nobody had a browser open",
      });
      await waitForCoalesce();
      await host.harness.behavior.callRpc("notifications.send", notice);
      await host.api.storage.kv.set("queued-notification:legacy", {
        message: {
          id: "legacy",
          title: "Old",
          body: "Queued before expiry",
          threadId: null,
          channels: ["web", "desktop"],
        },
        acceptedTargets: [],
      });

      const pending = clientNotificationSchema.array().parse(
        (
          (await host.harness.behavior.callRpc("notifications.pending", {
            channel: "web",
          })) as { messages: unknown }
        ).messages,
      );

      expect(pending.map((message) => message.id)).toHaveLength(2);
      expect(pending.map((message) => message.id)).not.toContain("legacy");

      now.mockReturnValue(start + 24 * 60 * 60 * 1_000);

      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toEqual({ messages: [] });
      expect(
        await host.api.storage.kv.list("pending-automatic-notification:"),
      ).toEqual([]);

      const automaticId = pending.find(
        (message) => message.threadId === thread.id,
      )!.id;

      expect(
        await host.harness.behavior.callRpc("notifications.ack", {
          id: automaticId,
          clientId: "late-browser",
          channel: "web",
        }),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.send", notice),
      ).toEqual({
        id: notice.id,
        status: "expired",
        duplicate: true,
        durable: true,
        acceptedTargetCount: 0,
      });
    } finally {
      now.mockRestore();
      await host.cleanup();
    }
  });

  it("forgets settled notices after two days so stored history stays bounded", async () => {
    const host = await setup();
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const delivered = { ...notice, id: "private-upstream:release:delivered" };
    const unread = { ...notice, id: "private-upstream:release:unread" };

    try {
      await host.harness.behavior.callRpc("notifications.send", delivered);
      await host.harness.behavior.callRpc("notifications.send", unread);

      for (const channel of ["web", "desktop"] as const) {
        await host.harness.behavior.callRpc("notifications.ack", {
          id: delivered.id,
          clientId: `${channel}-owner`,
          channel,
        });
      }

      expect(await host.api.storage.kv.list("queued-notification:")).toEqual([
        `queued-notification:${unread.id}`,
      ]);
      expect(
        await host.harness.behavior.callRpc("notifications.send", delivered),
      ).toMatchObject({
        duplicate: true,
        status: "dispatched",
        acceptedTargetCount: 2,
      });
      await expect(
        host.harness.behavior.callRpc("notifications.send", {
          ...delivered,
          body: "Changed",
        }),
      ).rejects.toThrow("different content");

      await host.api.storage.kv.set("automatic-notification-receipt:legacy", {
        acceptedTargets: ["web:legacy-browser"],
      });
      now.mockReturnValue(start + 24 * 60 * 60 * 1_000);
      await host.harness.behavior.runSchedule("notification-drain");

      expect(await host.api.storage.kv.list("queued-notification:")).toEqual(
        [],
      );
      expect(
        await host.api.storage.kv.list("automatic-notification-receipt:"),
      ).toEqual([]);
      expect(
        await host.harness.behavior.callRpc("notifications.send", unread),
      ).toMatchObject({
        duplicate: true,
        status: "expired",
        acceptedTargetCount: 0,
      });

      now.mockReturnValue(start + 2 * 24 * 60 * 60 * 1_000);
      await host.harness.behavior.runSchedule("notification-drain");

      expect(
        (await host.api.storage.kv.list()).filter((key) =>
          key.includes("notification"),
        ),
      ).toEqual([]);
      expect(
        await host.harness.behavior.callRpc("notifications.send", delivered),
      ).toMatchObject({ duplicate: false, status: "queued" });
    } finally {
      now.mockRestore();
      await host.cleanup();
    }
  });

  it("retains one queued identity offline, rejects collisions, and survives reload", async () => {
    const host = await setup();

    let replacement: Awaited<
      ReturnType<typeof host.harness.lifecycle.reload>
    > | null = null;

    try {
      await host.harness.behavior.setSettings({
        webEnabled: false,
        desktopEnabled: false,
      });

      const [first, second] = await Promise.all([
        host.harness.behavior.callRpc("notifications.send", notice),
        host.harness.behavior.callRpc("notifications.send", notice),
      ]);

      expect(first).toEqual({
        id: notice.id,
        status: "queued",
        duplicate: false,
        durable: true,
        acceptedTargetCount: 0,
      });
      expect(second).toEqual({
        id: notice.id,
        status: "queued",
        duplicate: true,
        durable: true,
        acceptedTargetCount: 0,
      });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {}),
      ).toEqual({
        messages: [
          {
            ...notice,
            threadId: null,
            kind: null,
            channels: ["web", "desktop"],
          },
        ],
      });
      await expect(
        host.harness.behavior.callRpc("notifications.send", {
          ...notice,
          body: "Changed",
        }),
      ).rejects.toThrow("different content");
      replacement = await host.harness.lifecycle.reload(
        createPushNotificationsPlugin({ fetch: host.expo.fetch }),
      );
      expect(
        await replacement.harness.behavior.callRpc(
          "notifications.send",
          notice,
        ),
      ).toEqual({
        id: notice.id,
        status: "queued",
        duplicate: true,
        durable: true,
        acceptedTargetCount: 0,
      });
      expect(
        await replacement.harness.behavior.callRpc("notifications.pending", {}),
      ).toMatchObject({ messages: [{ id: notice.id }] });
      expect(host.expo.requests).toHaveLength(0);
    } finally {
      if (replacement) await replacement.harness.lifecycle.dispose();
      else await host.cleanup();
    }
  });

  it("counts only actual client acknowledgments and deduplicates each target", async () => {
    const host = await setup();

    try {
      await host.harness.behavior.callRpc("notifications.send", notice);

      const ack = {
        id: notice.id,
        clientId: "client-owner-browser",
        channel: "web",
      };

      expect(
        await host.harness.behavior.callRpc("notifications.ack", ack),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.ack", ack),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {}),
      ).toEqual({ messages: [] });
      expect(
        await host.harness.behavior.callRpc("notifications.send", notice),
      ).toEqual({
        id: notice.id,
        status: "dispatched",
        duplicate: true,
        durable: true,
        acceptedTargetCount: 1,
      });
      await expect(
        host.harness.behavior.callRpc("notifications.ack", {
          ...ack,
          id: "missing",
        }),
      ).rejects.toThrow("not found");
      expect(host.expo.requests).toHaveLength(0);
    } finally {
      await host.cleanup();
    }
  });

  it("uses the canonical event epoch without replaying retained legacy notice work", async () => {
    const host = await setup();

    const legacy = {
      id: "retained-legacy-event",
      title: "Ready",
      body: "Existing queued work",
      threadId: null,
      channels: ["web"],
    };

    const key = "queued-notification:" + legacy.id;

    const record = {
      message: legacy,
      acceptedTargets: [],
      queuedAt: Date.now(),
    };

    try {
      await host.api.storage.kv.set(key, record);
      host.api.realtime.publish("notification", legacy);
      const historicalSignals = host.harness.realtimeSignals.length;

      const pending = await host.harness.behavior.callRpc(
        "notifications.pending",
        { channel: "web" },
      );

      expect(pending).toEqual({ messages: [{ ...legacy, kind: null }] });
      expect(await host.api.storage.kv.get(key)).toEqual(record);
      expect(host.harness.realtimeSignals).toHaveLength(historicalSignals);
      expect(CLIENT_NOTIFICATION_CHANNEL).toBe("omnyo-notification-v1");
      await host.harness.behavior.callRpc("notifications.send", {
        id: "fresh-canonical-event",
        title: "Fresh work",
        body: "The current producer owns this event",
      });
      expect(
        host.harness.realtimeSignals.filter(
          (signal) => signal.channel === "notification",
        ),
      ).toEqual([{ channel: "notification", payload: legacy }]);
      expect(host.clientSignals()).toEqual([
        {
          channel: CLIENT_NOTIFICATION_CHANNEL,
          payload: expect.objectContaining({ id: "fresh-canonical-event" }),
        },
      ]);
      expect(await host.api.storage.kv.get(key)).toEqual(record);

      const acknowledgment = {
        id: legacy.id,
        clientId: "preserved-client-id",
        channel: "web",
      };

      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          acknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc(
          "notifications.ack",
          acknowledgment,
        ),
      ).toEqual({ ok: true, acceptedTargetCount: 1 });
      expect(
        await host.harness.behavior.callRpc("notifications.pending", {
          channel: "web",
        }),
      ).toMatchObject({ messages: [{ id: "fresh-canonical-event" }] });
      expect(host.expo.requests).toHaveLength(0);
    } finally {
      await host.cleanup();
    }
  });
});

describe("phone only when away", () => {
  async function finishTurn(
    host: Awaited<ReturnType<typeof setup>>,
    thread: ThreadResponse,
  ) {
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "The migration is ready for review.",
    });
    await vi.waitFor(() => expect(host.clientSignals()).toHaveLength(1));
  }

  it("notifies only the computer while it is in use and reaches the phone when it locks", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.reportPresence(5);
      await finishTurn(host, thread);
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
      expect(await host.status()).toMatchObject({
        desktopPresence: "active",
        heldMobileCount: 1,
      });

      await host.reportPresence(0, true);
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        title: "Fix the flaky test",
        body: "The migration is ready for review.",
        data: { kind: "turn-finished", threadId: thread.id },
      });
      expect(await host.status()).toMatchObject({
        desktopPresence: "away",
        heldMobileCount: 0,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("drops the held phone push when the chat was read on the computer", async () => {
    const host = await setup();

    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.reportPresence(0);
      await finishTurn(host, thread);
      await vi.waitFor(async () =>
        expect(await host.status()).toMatchObject({ heldMobileCount: 1 }),
      );
      host.threads.set(thread.id, { ...thread, lastReadAt: 200 });

      await host.reportPresence(0, true);
      await vi.waitFor(async () =>
        expect(await host.status()).toMatchObject({ heldMobileCount: 0 }),
      );
      await waitForCoalesce();
      expect(host.expo.requests).toEqual([]);
    } finally {
      await host.cleanup();
    }
  });

  it("reaches the phone once the computer stops reporting", async () => {
    const host = await setup({ presenceStaleMs: 400 });

    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.reportPresence(0);
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread,
        lastAssistantText: "Done.",
      });
      await vi.waitFor(async () =>
        expect(await host.status()).toMatchObject({ heldMobileCount: 1 }),
      );
      expect(host.expo.requests).toEqual([]);
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1), {
        timeout: 2_000,
      });
    } finally {
      await host.cleanup();
    }
  });

  it("keeps a held phone push across a restart and sends it once no computer reports in", async () => {
    const host = await setup();

    let replacement: Awaited<
      ReturnType<typeof host.harness.lifecycle.reload>
    > | null = null;

    try {
      await host.addSubscription();
      const thread = host.setThread();

      await host.reportPresence(0);
      await finishTurn(host, thread);
      await vi.waitFor(async () =>
        expect(await host.status()).toMatchObject({ heldMobileCount: 1 }),
      );

      const restarted = await host.harness.lifecycle.reload(
        createPushNotificationsPlugin({
          fetch: host.expo.fetch,
          presenceStaleMs: 1_000,
        }),
      );

      replacement = restarted;

      const restartedService =
        restarted.harness.behavior.runService("push-sender");

      await vi.waitFor(async () => {
        const restored = await restarted.harness.behavior.runCli([
          "status",
          "--json",
        ]);

        expect(JSON.parse(restored.stdout)).toMatchObject({
          desktopPresence: "away",
          heldMobileCount: 1,
        });
      });
      expect(host.expo.requests).toEqual([]);

      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1), {
        timeout: 2_000,
      });
      expect(host.expo.requests[0]?.[0]).toMatchObject({
        body: "The migration is ready for review.",
        data: { kind: "turn-finished", threadId: thread.id },
      });
      await vi.waitFor(async () => {
        const after = await restarted.harness.behavior.runCli([
          "status",
          "--json",
        ]);

        expect(JSON.parse(after.stdout)).toMatchObject({ heldMobileCount: 0 });
      });
      restartedService.controller.abort();
      await restartedService.done;
    } finally {
      if (replacement) await replacement.harness.lifecycle.dispose();
      await host.cleanup();
    }
  });

  it("sends to the phone at once when the computer is idle, locked or the option is off", async () => {
    const host = await setup();

    try {
      await host.addSubscription();

      await host.reportPresence(600);
      await finishTurn(host, host.setThread());
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(1));

      await host.reportPresence(0, true);
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: host.setThread(),
        lastAssistantText: "Locked.",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(2));

      await host.reportPresence(0);
      await host.harness.behavior.setSettings({ mobileOnlyWhenAway: false });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: host.setThread(),
        lastAssistantText: "Option off.",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(3));

      await host.harness.behavior.setSettings({
        mobileOnlyWhenAway: true,
        desktopEnabled: false,
      });
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: host.setThread(),
        lastAssistantText: "Desktop off.",
      });
      await vi.waitFor(() => expect(host.expo.requests).toHaveLength(4));
    } finally {
      await host.cleanup();
    }
  });
});

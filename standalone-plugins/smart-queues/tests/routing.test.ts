import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import type {
  PluginApi,
  PluginEvents,
  PluginThreadEventHandler,
  PluginThreadEventName,
  PluginThreadEventPayloads,
} from "@omnyo/plugin-sdk";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
} from "@omnyo/plugin-sdk/testing";
import {
  jobViewSchema,
  type PromptInput,
  type ThreadQueuedMessage,
  type ThreadResponse,
} from "../contracts.ts";
import plugin from "../server.ts";

const text = (value: string): PromptInput => ({ type: "text", text: value, mentions: [] });

function setup() {
  const source = makeThreadResponse({
    id: "thr_source",
    status: "active",
    environmentId: "env_shared",
  });

  const original: PromptInput[] = [
    {
      type: "text",
      text: "Build the export. DO NOT deploy. See @thread:thr_context.",
      mentions: [
        {
          start: 46,
          end: 69,
          resource: { kind: "thread", threadId: "thr_context", label: "Context" },
        },
      ],
    },
    {
      type: "localFile",
      path: "attachments/spec.pdf",
      name: "spec.pdf",
      mimeType: "application/pdf",
    },
  ];

  let queue = [
    makeQueueEntry({
      id: "qm_1",
      threadId: source.id,
      content: original,
      updatedAt: 10,
      initiator: "user",
      payload: { kind: "inline" },
      sendAt: null,
      failureReason: null,
    }),
  ];

  const queues = new Map<string, ThreadQueuedMessage[]>();
  const children = new Map<string, ThreadResponse>();
  const metadata = new Map<string, { role: string; jobId: string }>();
  const historyInput = [text("Preserve accessibility. Never rotate credentials.")];
  let conflictId: string | null = null;
  let notificationFailure = false;
  let deletionFailure = false;
  let stopSignals = false;
  let spawnWait: Promise<void> | null = null;
  let releaseSpawn: (() => void) | null = null;
  let turnId = "turn_1";
  let assistantOutput = "Working on the accessibility settings.";
  let priorHistoryInput: PromptInput[] = [];
  let beforeOutput: (() => void | Promise<void>) | null = null;

  const host = createFakePluginHost({
    pluginId: "smart-queues",
    settings: {
      enabled: true,
      debounceMs: 40,
      routerProvider: "claude-code",
      routerModel: "claude-haiku-5-5",
    },
    sdk: {
      threads: {
        get: async ({ threadId }) => children.get(threadId) ?? source,
        list: async () => [],
        getPluginMetadata: async ({ threadId }) => metadata.get(threadId) ?? {},
        defaultExecutionOptions: async () => ({
          providerId: "codex",
          model: "gpt-6.1-sol",
          reasoningLevel: "max",
          permissionMode: "accept-edits",
          serviceTier: "default",
        }),
        output: async () => {
          await beforeOutput?.();

          return { output: assistantOutput };
        },
        stop: async ({ threadId }) => {
          const child = children.get(threadId);

          if (child) {
            child.status = "idle";

            if (stopSignals)
              await host.harness.behavior.emitThreadEvent("thread.idle", {
                thread: child,
                lastAssistantText: null,
              });
          }

          return { ok: true };
        },
        events: {
          list: async () => [
            {
              id: turnId,
              threadId: source.id,
              type: "client/turn/requested",
              scope: "thread",
              seq: 1,
              createdAt: 1,
              data: { input: historyInput, initiator: "user", target: { kind: "follow-up" } },
            },
            ...(priorHistoryInput.length
              ? [
                  {
                    id: "turn_prior",
                    threadId: source.id,
                    type: "client/turn/requested",
                    scope: "thread",
                    seq: 0,
                    createdAt: 0,
                    data: {
                      input: priorHistoryInput,
                      initiator: "user",
                      target: { kind: "follow-up" },
                    },
                  },
                ]
              : []),
          ],
        },
        queuedMessages: {
          list: async ({ threadId }) =>
            threadId === source.id ? queue : (queues.get(threadId) ?? []),
          update: async ({ threadId, queuedMessageId, expectedUpdatedAt, input }) => {
            const rows = threadId === source.id ? queue : queues.get(threadId)!;
            const index = rows.findIndex((row) => row.id === queuedMessageId);

            if (threadId === source.id && queuedMessageId === conflictId) {
              queue[index] = {
                ...queue[index]!,
                content: [text("DO NOT deploy or rotate. Keep this changed instruction.")],
                updatedAt: 20,
              };
              throw new Error("Queued message changed");
            }

            assert.equal(rows[index]!.updatedAt, expectedUpdatedAt);
            rows[index] = { ...rows[index]!, content: input, updatedAt: expectedUpdatedAt + 1 };

            return rows[index]!;
          },
          delete: async ({ threadId, queuedMessageId }) => {
            assert.notEqual(threadId, source.id, "A handoff must never delete source instructions");
            assert.equal(metadata.get(threadId)?.role, "router", "Destination input must survive");
            const rows = queues.get(threadId)!;
            const row = rows.find((entry) => entry.id === queuedMessageId)!;
            assert.equal(
              children.get(threadId)?.status,
              "idle",
              "Stop before deleting a classifier",
            );
            assert.equal(row.origin, "plugin");
            assert.equal(row.originPluginId, "smart-queues");

            if (deletionFailure) throw new Error("Classifier delete unavailable");
            queues.set(
              threadId,
              rows.filter((entry) => entry.id !== queuedMessageId),
            );

            return { ok: true };
          },
          setGroupBoundary: async ({
            expectedGroupedPrefixQueuedMessageIds,
            groupBoundaryQueuedMessageId,
          }) => {
            const boundary = queue.findIndex((row) => row.id === groupBoundaryQueuedMessageId);
            assert.deepEqual(
              expectedGroupedPrefixQueuedMessageIds,
              queue.slice(0, boundary + 1).map((row) => row.id),
            );
            queue = queue.map((row, index) => ({
              ...row,
              groupWithNext: index < boundary,
              updatedAt: row.groupWithNext === index < boundary ? row.updatedAt : row.updatedAt + 1,
            }));

            return queue;
          },
          reorder: async () => queue,
          send: async () => {
            if (notificationFailure) throw new Error("Source notification failed");

            return { ok: true, delivery: "steered" };
          },
        },
        spawn: async (args) => {
          if (spawnWait) await spawnWait;
          const id = `thr_child_${children.size + 1}`;

          const child = makeThreadResponse({
            id,
            status: "pending",
            environmentId: source.environmentId,
            parentThreadId: source.id,
            lifecycleOwnerThreadId: args.lifecycleOwnerThreadId ?? null,
            originPluginId: args.originPluginId ?? null,
          });

          children.set(id, child);
          metadata.set(
            id,
            z.object({ role: z.string(), jobId: z.string() }).parse(args.pluginMetadata),
          );
          queues.set(id, [
            makeQueueEntry({
              id: `qm_${id}`,
              threadId: id,
              content: args.input ?? [text(args.prompt ?? "")],
              updatedAt: 1,
              initiator: "user",
              origin: "plugin",
              originPluginId: args.originPluginId ?? null,
            }),
          ]);

          return child;
        },
      },
    },
  });

  return {
    host,
    source,
    original,
    historyInput,
    queues,
    children,
    metadata,
    holdSpawn: () => {
      spawnWait = new Promise<void>((resolve) => {
        releaseSpawn = resolve;
      });
    },
    releaseSpawn: () => {
      releaseSpawn?.();
    },
    signalStop: () => {
      stopSignals = true;
    },
    failDeletion: (value: boolean) => {
      deletionFailure = value;
    },
    getQueue: () => queue,
    setQueue: (rows: ThreadQueuedMessage[]) => {
      queue = rows;
    },
    conflict: (id: string) => {
      conflictId = id;
    },
    failNotification: () => {
      notificationFailure = true;
    },
    nextTurn: () => {
      turnId = "turn_2";
    },
    setOutput: (value: string) => {
      assistantOutput = value;
    },
    setPriorHistory: (input: PromptInput[]) => {
      priorHistoryInput = input;
    },
    beforeOutput: (handler: () => void | Promise<void>) => {
      beforeOutput = handler;
    },
  };
}

test("new chat preserves exact blocks and every historical user instruction before replacing source with a receipt", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);
    f.failNotification();

    const result = await f.host.harness.behavior.callRpc("route", {
      threadId: f.source.id,
      action: "new-chat",
      count: 1,
    });

    assert.ok(result);
    const childInput = f.queues.get("thr_child_1")![0]!.content;

    for (const block of [...f.historyInput, ...f.original])
      assert.ok(
        childInput.some((candidate) => JSON.stringify(candidate) === JSON.stringify(block)),
      );
    const sourceReceipt = f.getQueue()[0]!.content[0]!;
    assert.match(sourceReceipt.type === "text" ? sourceReceipt.text : "", /thr_child_1/);
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.queuedMessages.delete").length, 0);

    const gate = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: { id: "thr_child_1", status: "pending" } }),
    );

    assert.equal(gate.action, "wait");
    f.source.status = "idle";

    const released = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: { id: "thr_child_1", status: "pending" } }),
    );

    assert.equal(released.action, "proceed");
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("concurrent source edit stays queued and destination remains held with a visible recovery error", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);
    f.setQueue([
      ...f.getQueue(),
      makeQueueEntry({
        id: "qm_2",
        threadId: f.source.id,
        content: [text("Retain the second instruction.")],
        initiator: "user",
        updatedAt: 11,
        sendAt: null,
      }),
    ]);
    f.conflict("qm_2");
    await assert.rejects(
      f.host.harness.behavior.callRpc("route", {
        threadId: f.source.id,
        action: "new-chat",
        count: 2,
      }),
    );
    assert.match(JSON.stringify(f.getQueue()[1]!.content), /Keep this changed instruction/);
    const status = await f.host.harness.behavior.callRpc("status", null);
    assert.match(JSON.stringify(status), /error/);

    const gate = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: { id: "thr_child_1", status: "pending" } }),
    );

    assert.equal(gate.action, "wait");

    const sourceGate = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: f.source, queuedMessages: f.getQueue() }),
    );

    assert.equal(sourceGate.action, "wait");
    const jobs = await f.host.harness.behavior.callRpc("status", null);
    const id = z.object({ jobs: z.array(jobViewSchema) }).parse(jobs).jobs[0]!.id;
    await f.host.harness.behavior.callRpc("restore", { id });
    assert.deepEqual(f.getQueue()[0]!.content, f.original);
    assert.match(JSON.stringify(f.getQueue()[1]!.content), /Keep this changed instruction/);

    const restoredGate = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: f.source, queuedMessages: f.getQueue() }),
    );

    assert.equal(restoredGate.action, "proceed");
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("combining and steering preserve original order and contradictory instructions", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);

    const rows = [
      ...f.getQueue(),
      makeQueueEntry({
        id: "qm_2",
        threadId: f.source.id,
        content: [text("Actually, do not build export yet. Explain the tradeoff first.")],
        initiator: "user",
        updatedAt: 11,
        sendAt: null,
      }),
    ];

    f.setQueue([
      rows[0]!,
      {
        ...rows[1]!,
        permissionMode: rows[0]!.permissionMode === "full" ? "accept-edits" : "full",
      },
    ]);
    await assert.rejects(
      f.host.harness.behavior.callRpc("route", {
        threadId: f.source.id,
        action: "combine",
        count: 2,
      }),
    );
    f.setQueue(rows);
    await f.host.harness.behavior.callRpc("route", {
      threadId: f.source.id,
      action: "combine",
      count: 2,
    });
    assert.deepEqual(
      f.getQueue().map((row) => row.content),
      rows.map((row) => row.content),
    );
    f.source.status = "stopping";
    await assert.rejects(
      f.host.harness.behavior.callRpc("route", {
        threadId: f.source.id,
        action: "steer",
        count: 2,
      }),
    );
    f.source.status = "active";
    await f.host.harness.behavior.callRpc("route", {
      threadId: f.source.id,
      action: "steer",
      count: 2,
    });
    const call = f.host.harness.inspection.sdk.callsTo("threads.queuedMessages.send")[0];
    assert.ok(call);
    assert.match(JSON.stringify(call), /qm_1/);
    assert.doesNotMatch(JSON.stringify(call), /qm_2/);
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("one classifier handles a burst and an unrelated agent cannot submit its decision", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);

    await f.host.harness.behavior.emitThreadEvent("message.queued", { entry: f.getQueue()[0]! });
    await f.host.harness.behavior.setSettings({ enabled: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    await f.host.harness.behavior.setSettings({ enabled: true });

    for (let i = 0; i < 3; i++)
      await f.host.harness.behavior.emitThreadEvent("message.queued", { entry: f.getQueue()[0]! });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    await assert.rejects(
      f.host.harness.behavior.callAgentTool(
        "smart_queues_decide",
        { action: "queue", count: 1, reason: "Wait for the current task." },
        { threadId: "thr_intruder" },
      ),
    );
    f.nextTurn();
    await assert.rejects(
      f.host.harness.behavior.callAgentTool(
        "smart_queues_decide",
        { action: "steer", count: 1, reason: "Apply correction." },
        { threadId: "thr_child_1" },
      ),
    );
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0);
    f.source.status = "idle";
    const idle = await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
    assert.deepEqual(idle, { started: false });
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

async function settleAsyncCleanup() {
  for (let i = 0; i < 12; i++) await setImmediate();
}

async function routeJobs(f: ReturnType<typeof setup>) {
  return z
    .object({ jobs: z.array(jobViewSchema) })
    .parse(await f.host.harness.behavior.callRpc("status", null)).jobs;
}

function retainForeignRows(f: ReturnType<typeof setup>, threadId: string) {
  const foreign = [
    makeQueueEntry({
      id: "qm_human",
      threadId,
      content: [text("Retain this user work.")],
      origin: "app",
      originPluginId: null,
      initiator: "user",
    }),
    makeQueueEntry({
      id: "qm_foreign_plugin",
      threadId,
      content: [text("Retain another plugin's work.")],
      origin: "plugin",
      originPluginId: "other-plugin",
      initiator: "user",
    }),
  ];

  f.queues.set(threadId, [...f.queues.get(threadId)!, ...foreign]);

  return structuredClone(foreign);
}

test("a timed-out classifier removes only positively owned prompts and retains original and foreign work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  for (const ownership of ["owned", "foreign-thread", "foreign-job", "foreign-row"] as const) {
    await t.test(ownership, async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        const sourceBefore = structuredClone(f.getQueue());
        await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
        const routerId = (await routeJobs(f))[0]!.routerThreadId!;
        const foreign = retainForeignRows(f, routerId);

        if (ownership === "foreign-thread")
          f.children.get(routerId)!.originPluginId = "other-plugin";

        if (ownership === "foreign-job") f.metadata.get(routerId)!.jobId = "another-job";

        if (ownership === "foreign-row")
          f.queues.get(routerId)![0]!.originPluginId = "other-plugin";
        const allBefore = structuredClone(f.queues.get(routerId)!);
        t.mock.timers.tick(90_000);
        await settleAsyncCleanup();
        const job = (await routeJobs(f))[0]!;
        assert.equal(job.state, "error");
        assert.match(job.error!, /timed out/);
        assert.deepEqual(f.getQueue(), sourceBefore);
        assert.deepEqual(f.queues.get(routerId), ownership === "owned" ? foreign : allBefore);

        const gate = await f.host.harness.inspection.registrations.hooks["message.dispatch"]!(
          makeMessageDispatchHookContext({
            thread: f.children.get(routerId),
            queuedMessages: f.queues.get(routerId),
          }),
        );

        assert.equal(gate.action, "wait", "A retired classifier must never run another prompt");

        if (ownership === "foreign-thread" || ownership === "foreign-job") {
          assert.equal(f.host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
          assert.match(job.error!, /cleanup|ownership/);
        }
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    });
  }
});

test("terminal classifier lifecycle paths retire owned prompts without clearing source or destination inputs", async (t) => {
  for (const terminal of [
    "pause",
    "reentrant-stop",
    "source-settled",
    "router-settled",
    "dispose",
    "startup-classifying",
    "startup-preparing",
  ] as const) {
    await t.test(terminal, async () => {
      const f = setup();
      let current = f.host;

      try {
        await plugin(f.host.api);
        let sourceBefore = structuredClone(f.getQueue());
        const destinations = new Map<string, ThreadQueuedMessage[]>();
        await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
        const job = (await routeJobs(f))[0]!;
        const routerId = job.routerThreadId!;
        const foreign = retainForeignRows(f, routerId);

        if (terminal === "pause" || terminal === "reentrant-stop") {
          if (terminal === "reentrant-stop") f.signalStop();
          await f.host.harness.behavior.setSettings({ enabled: false });
        }

        if (terminal === "source-settled")
          await f.host.harness.behavior.emitThreadEvent("thread.idle", {
            thread: f.source,
            lastAssistantText: null,
          });

        if (terminal === "router-settled") {
          await f.host.harness.behavior.callAgentTool(
            "smart_queues_decide",
            { action: "new-chat", count: 1, reason: "Start the independent work." },
            { threadId: routerId },
          );
          const destinationId = (await routeJobs(f))[0]!.destinationThreadId!;
          destinations.set(destinationId, structuredClone(f.queues.get(destinationId)!));
          sourceBefore = structuredClone(f.getQueue());
          await f.host.harness.behavior.emitThreadEvent("thread.idle", {
            thread: f.children.get(routerId)!,
            lastAssistantText: null,
          });
        }

        if (terminal === "dispose") await f.host.harness.lifecycle.dispose();

        if (terminal.startsWith("startup")) {
          if (terminal === "startup-preparing") {
            const db = f.host.api.storage.database();

            const row = z
              .object({ body: z.string() })
              .parse(db.prepare("SELECT body FROM jobs WHERE id=?").get(job.id));

            const persisted = JSON.parse(row.body);

            db.prepare("UPDATE jobs SET body=? WHERE id=?").run(
              JSON.stringify({ ...persisted, state: "preparing" }),
              job.id,
            );
          }

          current = await f.host.harness.lifecycle.reload(plugin);
          assert.equal(
            current.harness.inspection.sdk.callsTo("threads.queuedMessages.delete").length,
            1,
            "The new plugin must retire the interrupted job before the old runtime disposes",
          );

          const recovered = z
            .object({ jobs: z.array(jobViewSchema) })
            .parse(await current.harness.behavior.callRpc("status", null)).jobs[0]!;

          assert.equal(recovered.state, "error");
          assert.match(recovered.error!, /interrupted/);
        }

        await settleAsyncCleanup();
        assert.deepEqual(f.queues.get(routerId), foreign);
        assert.deepEqual(f.getQueue(), sourceBefore);

        for (const [destinationId, input] of destinations)
          assert.deepEqual(f.queues.get(destinationId), input);
        assert.equal(f.children.get(routerId)!.status, "idle");

        if (terminal === "reentrant-stop")
          assert.equal(
            f.host.harness.inspection.sdk.callsTo("threads.stop").length,
            1,
            "The stop lifecycle callback must not await or repeat its own retirement",
          );
      } finally {
        await current.harness.lifecycle.dispose();
      }
    });
  }
});

function withMaintenanceEvents(api: PluginApi) {
  const handlers: PluginThreadEventHandler<"experimental_thread.maintenance">[] = [];

  function on<E extends PluginThreadEventName>(
    event: E,
    handler: PluginThreadEventHandler<E>,
  ): void;

  function on(
    event: PluginThreadEventName,
    handler: PluginThreadEventHandler<PluginThreadEventName>,
  ): void {
    if (event === "experimental_thread.maintenance") handlers.push(handler);
    else api.events.on(event, handler);
  }

  const events: PluginEvents = { on };

  return {
    api: { ...api, events },
    emit: async (payload: PluginThreadEventPayloads["experimental_thread.maintenance"]) => {
      for (const handler of handlers) await handler(payload);
    },
  };
}

test("an automatic compaction ending settles the source queue like an idle turn", async () => {
  const f = setup();
  const core = withMaintenanceEvents(f.host.api);

  try {
    await plugin(core.api);
    const sourceBefore = structuredClone(f.getQueue());
    await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
    const routerId = (await routeJobs(f))[0]!.routerThreadId!;
    await core.emit({ thread: f.source, phase: "started", outcome: null });
    assert.equal((await routeJobs(f))[0]!.state, "classifying");
    await core.emit({ thread: f.source, phase: "ended", outcome: "completed" });
    await settleAsyncCleanup();
    const job = (await routeJobs(f))[0]!;
    assert.equal(job.state, "stale");
    assert.equal(job.error, "Source turn ended; queue drains normally.");
    assert.equal(f.children.get(routerId)!.status, "idle");
    assert.deepEqual(f.getQueue(), sourceBefore);
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("a message queued during an automatic compaction is left for the queue to drain", async () => {
  const f = setup();
  const core = withMaintenanceEvents(f.host.api);

  try {
    await plugin(core.api);
    await core.emit({ thread: f.source, phase: "started", outcome: null });
    await f.host.harness.behavior.emitThreadEvent("message.queued", { entry: f.getQueue()[0]! });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.deepEqual(await routeJobs(f), []);
    await core.emit({ thread: f.source, phase: "ended", outcome: "completed" });
    await f.host.harness.behavior.emitThreadEvent("message.queued", { entry: f.getQueue()[0]! });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("a compaction that starts before a queued message is classified spawns no router", async () => {
  const f = setup();
  const core = withMaintenanceEvents(f.host.api);

  try {
    await plugin(core.api);
    await f.host.harness.behavior.emitThreadEvent("message.queued", { entry: f.getQueue()[0]! });
    await core.emit({ thread: f.source, phase: "started", outcome: null });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.deepEqual(await routeJobs(f), []);
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("loads on a core without automatic compaction events and keeps its lifecycle listeners", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);
    const listeners = f.host.harness.inspection.registrations.threadEventHandlers;
    assert.equal(listeners["thread.idle"], 1);
    assert.equal(listeners["thread.failed"], 1);
    assert.equal(listeners["thread.active"], 1);
    assert.ok(
      f.host.harness.inspection.logEntries.some(
        (entry) => entry.level === "info" && /automatic compaction/u.test(entry.message),
      ),
    );
    await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
    await f.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: f.source,
      lastAssistantText: null,
    });
    await settleAsyncCleanup();
    assert.equal((await routeJobs(f))[0]!.state, "stale");
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("a failed classifier cleanup stays visible and retries only that router on its next settlement", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);
    const sourceBefore = structuredClone(f.getQueue());
    await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
    const routerId = (await routeJobs(f))[0]!.routerThreadId!;
    const foreign = retainForeignRows(f, routerId);
    f.failDeletion(true);
    await f.host.harness.behavior.setSettings({ enabled: false });
    await settleAsyncCleanup();
    const failed = (await routeJobs(f))[0]!;
    assert.match(failed.error!, /cleanup/);
    assert.ok(f.host.harness.inspection.logEntries.some((entry) => /cleanup/.test(entry.message)));
    assert.equal(f.queues.get(routerId)!.length, 3);
    assert.deepEqual(f.getQueue(), sourceBefore);
    f.failDeletion(false);
    await f.host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: f.children.get(routerId)!,
      lastAssistantText: null,
    });
    assert.deepEqual(f.queues.get(routerId), foreign);
    assert.deepEqual(f.getQueue(), sourceBefore);
    assert.equal(
      (await routeJobs(f))[0]!.state,
      "stale",
      "Cleanup must preserve the routing ledger outcome",
    );
    assert.equal((await routeJobs(f))[0]!.error, failed.error, "Retain the failure history");
  } finally {
    await f.host.harness.lifecycle.dispose();
  }
});

test("disposal waits for an already requested classifier spawn and retires its late result before closing storage", async () => {
  const f = setup();

  try {
    await plugin(f.host.api);
    const sourceBefore = structuredClone(f.getQueue());
    f.holdSpawn();
    const classification = f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });

    const classificationResult = classification.then(
      (result) => ({ result }),
      (error) => ({ error: z.instanceof(Error).parse(error) }),
    );

    await settleAsyncCleanup();
    assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
    const disposal = f.host.harness.lifecycle.dispose();
    await settleAsyncCleanup();
    f.releaseSpawn();
    const outcome = await classificationResult;
    await disposal;
    assert.deepEqual(outcome, { result: { started: false } });
    assert.deepEqual(f.queues.get("thr_child_1"), []);
    assert.deepEqual(f.getQueue(), sourceBefore);
    assert.equal(f.children.get("thr_child_1")!.status, "idle");
  } finally {
    f.releaseSpawn();
    await f.host.harness.lifecycle.dispose();
  }
});

function addSecondOriginal(f: ReturnType<typeof setup>) {
  const first = f.getQueue()[0]!;
  f.setQueue([
    first,
    {
      ...first,
      id: "qm_2",
      content: [text("Explain the tradeoff first. Keep the export task queued.")],
      updatedAt: first.updatedAt + 1,
    },
  ]);
}

async function finishClassification(
  f: ReturnType<typeof setup>,
  action: "queue" | "combine" | "steer" | "new-chat",
  count = 1,
) {
  assert.deepEqual(await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }), {
    started: true,
  });
  const routerId = (await routeJobs(f))[0]!.routerThreadId!;
  await f.host.harness.behavior.callAgentTool(
    "smart_queues_decide",
    { action, count, reason: "Respect the current task and exact ordered instructions." },
    { threadId: routerId },
  );

  return routerId;
}

test("completed classifications reuse only identical semantic input with fresh application", async (t) => {
  for (const action of ["queue", "combine"] as const) {
    await t.test(`${action} ignores noneligible suffix and transport changes`, async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        addSecondOriginal(f);
        const originals = f.getQueue().map((row) => structuredClone(row.content));
        await finishClassification(f, action, 2);

        for (let revision = 1; revision <= 8; revision++) {
          const prefix = f
            .getQueue()
            .slice(0, 2)
            .map((row) => ({
              ...row,
              updatedAt: row.updatedAt + 1,
            }));

          f.setQueue([
            ...prefix,
            makeQueueEntry({
              id: "qm_callback",
              threadId: f.source.id,
              initiator: "agent",
              content: [text(`A separate background callback completed ${revision}.`)],
              updatedAt: revision,
            }),
          ]);
          assert.deepEqual(
            await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
            { started: false },
            "Unchanged classifier input must not launch another router",
          );
          assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
          assert.deepEqual(
            f
              .getQueue()
              .slice(0, 2)
              .map((row) => row.content),
            originals,
          );
          assert.equal(f.getQueue()[0]!.groupWithNext, action === "combine");
          assert.equal(f.getQueue()[1]!.groupWithNext, false);
        }
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    });
  }

  await t.test(
    "an edited combine boundary is applied from a fresh snapshot without another router",
    async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        addSecondOriginal(f);
        const originals = f.getQueue().map((row) => structuredClone(row.content));
        await finishClassification(f, "combine", 2);
        f.setQueue(
          f
            .getQueue()
            .map((row) => ({ ...row, groupWithNext: false, updatedAt: row.updatedAt + 1 })),
        );
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          {
            started: false,
          },
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
        assert.equal(
          f.host.harness.inspection.sdk.callsTo("threads.queuedMessages.setGroupBoundary").length,
          2,
        );
        assert.deepEqual(
          f.getQueue().map((row) => row.groupWithNext),
          [true, false],
        );
        assert.deepEqual(
          f.getQueue().map((row) => row.content),
          originals,
        );
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    },
  );

  const changes: [string, (f: ReturnType<typeof setup>) => void | Promise<void>][] = [
    ["assistant output", (f) => f.setOutput("The export is complete; independent work can start.")],
    [
      "active user input",
      (f) => {
        f.historyInput[0] = text("Stop the export and explain first.");
      },
    ],
    [
      "older user history",
      (f) => f.setPriorHistory([text("Never start the independent task before my review.")]),
    ],
    ["source turn", (f) => f.nextTurn()],
    [
      "original content",
      (f) =>
        f.setQueue(
          f.getQueue().map((row, index) =>
            index === 0
              ? {
                  ...row,
                  content: [text("Do not export. Explain the change.")],
                  updatedAt: row.updatedAt + 1,
                }
              : row,
          ),
        ),
    ],
    ["prefix order", (f) => f.setQueue([...f.getQueue()].reverse())],
    [
      "queued model",
      (f) => f.setQueue(f.getQueue().map((row) => ({ ...row, model: `${row.model}-changed` }))),
    ],
    [
      "queued reasoning",
      (f) =>
        f.setQueue(
          f.getQueue().map((row) => ({
            ...row,
            reasoningLevel: row.reasoningLevel === "max" ? "low" : "max",
          })),
        ),
    ],
    [
      "queued permission",
      (f) =>
        f.setQueue(
          f.getQueue().map((row) => ({
            ...row,
            permissionMode: row.permissionMode === "full" ? "accept-edits" : "full",
          })),
        ),
    ],
    [
      "queued service tier",
      (f) =>
        f.setQueue(
          f.getQueue().map((row) => ({ ...row, serviceTier: `${row.serviceTier}-changed` })),
        ),
    ],
    [
      "router model",
      (f) => f.host.harness.behavior.setSettings({ routerModel: "changed-router-model" }),
    ],
    [
      "router provider",
      (f) => f.host.harness.behavior.setSettings({ routerProvider: "changed-router-provider" }),
    ],
    [
      "source environment",
      (f) => {
        f.source.environmentId = "env_changed";
      },
    ],
    [
      "source provider",
      (f) => {
        f.source.providerId = `${f.source.providerId}-changed`;
      },
    ],
    [
      "source project",
      (f) => {
        f.source.projectId = "proj_changed";
      },
    ],
  ];

  for (const [name, change] of changes) {
    await t.test(`${name} requires a fresh classifier`, async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        addSecondOriginal(f);
        await finishClassification(f, "queue", 2);
        await change(f);
        const originals = structuredClone(f.getQueue().map((row) => row.content));
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          {
            started: true,
          },
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 2);
        assert.deepEqual(
          f.getQueue().map((row) => row.content),
          originals,
        );
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    });
  }

  await t.test(
    "a source edit during cached combine application is refused and retained",
    async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        addSecondOriginal(f);
        await finishClassification(f, "combine", 2);
        f.setQueue(
          f
            .getQueue()
            .map((row) => ({ ...row, groupWithNext: false, updatedAt: row.updatedAt + 1 })),
        );
        f.beforeOutput(() => {
          f.setQueue(
            f.getQueue().map((row, index) =>
              index === 0
                ? {
                    ...row,
                    content: [
                      text("Changed instruction must survive without grouping or rewriting."),
                    ],
                    updatedAt: row.updatedAt + 1,
                  }
                : row,
            ),
          );
        });
        await assert.rejects(
          f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
        assert.equal(
          f.host.harness.inspection.sdk.callsTo("threads.queuedMessages.setGroupBoundary").length,
          1,
        );
        assert.match(JSON.stringify(f.getQueue()[0]!.content), /Changed instruction must survive/);
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    },
  );

  await t.test(
    "router settings changed during context read match the spawned classifier and saved identity",
    async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        f.beforeOutput(async () => {
          await f.host.harness.behavior.setSettings({ routerModel: "late-router-model" });
        });
        await finishClassification(f, "queue");

        const spawn = z
          .object({ model: z.string() })
          .parse(f.host.harness.inspection.sdk.callsTo("threads.spawn")[0]![0]);

        assert.equal(spawn.model, "late-router-model");
        f.beforeOutput(() => undefined);
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          { started: false },
        );
        await f.host.harness.behavior.setSettings({ routerModel: "claude-haiku-5-5" });
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          { started: true },
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 2);
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    },
  );

  await t.test(
    "a context read failure remains visible without changing original instructions",
    async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        f.beforeOutput(() => {
          throw new Error("Output unavailable.");
        });
        await assert.rejects(
          f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
        );
        assert.equal((await routeJobs(f))[0]!.state, "error");
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
        assert.deepEqual(f.getQueue()[0]!.content, f.original);
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    },
  );

  for (const legacy of [false, true]) {
    await t.test(
      legacy
        ? "unkeyed legacy jobs do not suppress a classifier after reload"
        : "successful semantic decisions survive reload",
      async () => {
        const f = setup();
        let current = f.host;

        try {
          await plugin(f.host.api);
          await finishClassification(f, "queue");

          if (legacy) {
            const id = (await routeJobs(f))[0]!.id;
            const db = f.host.api.storage.database();

            const row = z
              .object({ body: z.string() })
              .parse(db.prepare("SELECT body FROM jobs WHERE id=?").get(id));

            const body = z.record(z.string(), z.json()).parse(JSON.parse(row.body));

            delete body.classificationKey;
            db.prepare("UPDATE jobs SET body=? WHERE id=?").run(JSON.stringify(body), id);
          }

          current = await f.host.harness.lifecycle.reload(plugin);

          if (!legacy)
            f.setQueue([
              ...f.getQueue(),
              makeQueueEntry({
                id: "qm_callback",
                threadId: f.source.id,
                initiator: "agent",
                content: [text("A fresh callback changed only the suffix.")],
              }),
            ]);
          assert.deepEqual(
            await current.harness.behavior.callRpc("classify", { threadId: f.source.id }),
            {
              started: legacy,
            },
          );
          assert.equal(
            current.harness.inspection.sdk.callsTo("threads.spawn").length,
            legacy ? 1 : 0,
          );
          assert.deepEqual(f.getQueue()[0]!.content, f.original);
        } finally {
          await current.harness.lifecycle.dispose();
        }
      },
    );
  }

  await t.test(
    "explicit queue choices are not silently reused as model classifications",
    async () => {
      const f = setup();

      try {
        await plugin(f.host.api);
        await f.host.harness.behavior.callRpc("route", {
          threadId: f.source.id,
          action: "queue",
          count: 1,
        });
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          { started: true },
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    },
  );

  await t.test("failed classifiers remain visible and retryable", async () => {
    const f = setup();

    try {
      await plugin(f.host.api);
      await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id });
      await f.host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: f.children.get("thr_child_1")!,
        lastAssistantText: null,
      });
      assert.equal((await routeJobs(f))[0]!.state, "error");
      assert.deepEqual(
        await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
        { started: true },
      );
      assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, 2);
      assert.deepEqual(f.getQueue()[0]!.content, f.original);
    } finally {
      await f.host.harness.lifecycle.dispose();
    }
  });

  for (const action of ["steer", "new-chat"] as const) {
    await t.test(`${action} outcomes are not replayed as cached queue decisions`, async () => {
      const f = setup();

      try {
        await plugin(f.host.api);

        if (action === "new-chat") f.failNotification();
        await finishClassification(f, action);
        f.setQueue([
          { ...f.getQueue()[0]!, content: f.original, updatedAt: f.getQueue()[0]!.updatedAt + 1 },
        ]);
        const before = f.host.harness.inspection.sdk.callsTo("threads.spawn").length;
        assert.deepEqual(
          await f.host.harness.behavior.callRpc("classify", { threadId: f.source.id }),
          { started: true },
        );
        assert.equal(f.host.harness.inspection.sdk.callsTo("threads.spawn").length, before + 1);
        assert.deepEqual(f.getQueue()[0]!.content, f.original);
      } finally {
        await f.host.harness.lifecycle.dispose();
      }
    });
  }
});

import assert from "node:assert/strict";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import { Collector } from "../lib/collector.ts";

function deferred() {
  let resolve = () => {};

  const done = new Promise<void>((complete) => {
    resolve = complete;
  });

  return { done, resolve };
}

async function setup(filtered = true, read = async () => [], start = true) {
  const inventoryReady = deferred();
  let inventoryPages = 0;

  const thread = makeThreadResponse({
    id: "thr_filter",
    providerId: "codex",
    status: "active",
    activeBackgroundAgentCount: 0,
    title: "Before",
  });

  const host = createFakePluginHost({
    pluginId: "stats",
    sdk: {
      hosts: { list: async () => [] },
      projects: { list: async () => [] },
      plugins: { list: async () => ({ plugins: [] }) },
      threads: {
        list: async () => {
          inventoryPages += 1;

          if (inventoryPages === 2) inventoryReady.resolve();

          return [];
        },
        get: async () => thread,
        events: { list: read },
      },
    },
  });

  const on = host.api.events.on.bind(host.api.events);

  if (!filtered) host.api.events.on = (event, handler) => on(event, handler);
  const collector = new Collector(host.api);

  if (start) void collector.start(new AbortController().signal);

  if (start) await inventoryReady.done;

  return { host, collector, thread };
}

async function replay(filtered: boolean) {
  const { host, collector, thread } = await setup(filtered);
  const touchChat = collector.store.touchChat.bind(collector.store);
  let touches = 0;
  collector.store.touchChat = (...args) => {
    touches += 1;
    touchChat(...args);
  };

  const snapshots = [];

  try {
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 1,
      experimental_eventTypes: ["item/agentMessage/delta"],
      experimental_coveredSequence: { from: 1, to: 1 },
    });

    for (let sequence = 2; sequence <= 21; sequence += 1) {
      await host.harness.emitThreadEvent("experimental_thread.events", {
        thread,
        sequence,
        experimental_eventTypes: ["item/agentMessage/delta"],
        experimental_coveredSequence: { from: sequence, to: sequence },
      });
    }

    assert.equal(touches, filtered ? 2 : 42);
    snapshots.push(collector.summary());
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread: { ...thread, activeBackgroundAgentCount: 2 },
      sequence: 22,
      experimental_eventTypes: ["item/backgroundTask/progress"],
      experimental_coveredSequence: { from: 22, to: 22 },
    });
    assert.equal(collector.summary().nestedAgents, 2);
    assert.equal(collector.summary().running, 3);
    snapshots.push(collector.summary());
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 23,
      experimental_eventTypes: ["item/backgroundTask/completed"],
      experimental_coveredSequence: { from: 23, to: 23 },
    });
    assert.equal(collector.summary().nestedAgents, 0);
    assert.equal(collector.summary().running, 1);
    snapshots.push(collector.summary());
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread: { ...thread, title: "After" },
      sequence: 24,
      experimental_eventTypes: ["thread/name/updated"],
      experimental_coveredSequence: { from: 24, to: 24 },
    });
    await host.harness.emitThreadEvent("experimental_thread.events", { thread, sequence: 25 });
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 27,
      experimental_eventTypes: ["item/agentMessage/delta"],
      experimental_coveredSequence: { from: 27, to: 27 },
    });
    assert.equal(touches, filtered ? 12 : 52);
    assert.equal(collector.store.cursor(thread.id).seq, 27);

    return { touches, snapshots };
  } finally {
    await host.harness.dispose();
  }
}

async function failedRead() {
  let reads = 0;

  const { host, collector, thread } = await setup(true, async () => {
    reads += 1;

    if (reads === 1) throw new Error("Temporary history read failure");

    return [];
  });

  try {
    const first = await host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 1,
      experimental_eventTypes: ["thread/tokenUsage/updated"],
      experimental_coveredSequence: { from: 1, to: 1 },
    });

    assert.equal(first.errors.length, 1);
    assert.equal(collector.store.cursor(thread.id).seq, 0);
    assert.match(collector.health().error ?? "", /Could not collect chat/);
    await host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 2,
      experimental_eventTypes: ["item/agentMessage/delta"],
      experimental_coveredSequence: { from: 2, to: 2 },
    });
    assert.equal(reads, 2);
    assert.equal(collector.store.cursor(thread.id).seq, 2);
    assert.equal(collector.health().error, null);
  } finally {
    await host.harness.dispose();
  }
}

async function queuedDuringRead() {
  const firstRead = deferred(),
    firstRelease = deferred(),
    secondRead = deferred(),
    secondRelease = deferred();

  let reads = 0;

  const { host, collector, thread } = await setup(true, async () => {
    reads += 1;
    const read = reads === 1 ? firstRead : secondRead;
    const release = reads === 1 ? firstRelease : secondRelease;
    read.resolve();
    await release.done;

    return [];
  });

  try {
    const first = host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 10,
      experimental_eventTypes: ["thread/tokenUsage/updated"],
      experimental_coveredSequence: { from: 10, to: 10 },
    });

    await firstRead.done;

    const second = host.harness.emitThreadEvent("experimental_thread.events", {
      thread,
      sequence: 99,
      experimental_eventTypes: ["thread/tokenUsage/updated"],
      experimental_coveredSequence: { from: 11, to: 11 },
    });

    firstRelease.resolve();
    await secondRead.done;
    assert.equal(collector.store.cursor(thread.id).seq, 10);
    secondRelease.resolve();
    await Promise.all([first, second]);
    assert.equal(collector.store.cursor(thread.id).seq, 99);
    assert.equal(reads, 2);
  } finally {
    firstRelease.resolve();
    secondRelease.resolve();
    await host.harness.dispose();
  }
}

async function overflowAndDispose() {
  const { host, collector, thread } = await setup(true, async () => [], false);
  const queued = [];

  try {
    for (let index = 0; index < 1000; index += 1) {
      queued.push(
        host.harness.emitThreadEvent("experimental_thread.events", {
          thread: { ...thread, id: `thr_queue_${index}`, status: "idle" },
          sequence: 1,
        }),
      );
    }

    assert.equal(collector.health().queueDepth, 1000);

    const overflow = await host.harness.emitThreadEvent("experimental_thread.events", {
      thread: { ...thread, id: "thr_overflow", status: "idle" },
      sequence: 1,
    });

    assert.equal(overflow.errors.length, 1);
    assert.equal(collector.health().queueDepth, 1000);
    assert.equal(host.harness.sdk.callsTo("threads.events.list").length, 0);
  } finally {
    await host.harness.dispose();
  }

  const settled = await Promise.all(queued);
  assert.ok(settled.every((result) => result.errors.length === 1));

  return settled.length;
}

const now = Date.now;

Date.now = () => 1_800_000_000_000;

try {
  const pairs = [];

  for (let repetition = 0; repetition < 5; repetition += 1) {
    const before = await replay(false),
      after = await replay(true);

    assert.deepEqual(after.snapshots, before.snapshots);
    pairs.push({ beforeTouches: before.touches, afterTouches: after.touches });
  }

  await failedRead();
  await queuedDuringRead();
  const disposedQueuedReads = await overflowAndDispose();
  console.log(
    JSON.stringify({
      pairs,
      errors: 0,
      concurrencyEquivalent: true,
      capturedReadTargetPreserved: true,
      failedReadRecoveredOnStream: true,
      disposedQueuedReads,
      database: "real SDK harness SQLite",
      before: "legacy host ignores subscription options",
      metric: "production collector touchChat calls; no latency claim",
    }),
  );
} finally {
  Date.now = now;
}

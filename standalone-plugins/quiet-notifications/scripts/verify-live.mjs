import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@omnyo/plugin-sdk/testing";
import { createPushNotificationsPlugin } from "../dist/server.js";

const base = new URL("http://127.0.0.1:38886/api/v1/");

const output = process.argv[2];

const busyId = process.argv[3];

assert.ok(output, "Provide the verification JSON output path");

assert.ok(busyId, "Provide a live active chat ID as the second argument");

async function read(path, args = {}) {
  const url = new URL(path, base);

  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.ok, true, `Omnyo read failed: ${response.status}`);

  return response.json();
}

const busy = await read(`threads/${busyId}`);

assert.equal(busy.status, "active");

const roots = await read("threads", {
  projectId: busy.projectId,
  hasParent: false,
  includeHidden: true,
  limit: 100,
});

let finishedId = null;

for (const thread of roots) {
  if (
    thread.id === busyId ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.visibility !== "visible" ||
    thread.status !== "idle" ||
    thread.runtime.displayStatus !== "idle" ||
    thread.queuedWork !== "none" ||
    thread.hasPendingInteraction ||
    Object.values(thread.activity).some((count) => count > 0)
  )
    continue;

  const children = await read("threads", {
    parentThreadId: thread.id,
    includeHidden: true,
    limit: 1,
  });

  if (children.length === 0) {
    finishedId = thread.id;
    break;
  }
}

assert.ok(
  finishedId,
  "A live finished chat without descendants must be available for the positive control",
);

async function probe(threadId) {
  let mobileAttempts = 0;
  let threadReads = 0;
  let activityReads = 0;
  let initializationReads = 0;
  let observedStatus = null;
  const liveActivity = [];

  const fake = createFakePluginHost({
    pluginId: "quiet-notifications",
    dataDir: process.env.OMNYO_DATA_DIR ?? join(homedir(), ".omnyo"),
    settings: { mobileEnabled: true, webEnabled: false, desktopEnabled: true },
    sdk: {
      threads: {
        get: async (args) => {
          threadReads += 1;
          const thread = await read(`threads/${args.threadId}`);
          observedStatus = thread.status;

          return thread;
        },
        list: async (args) => {
          activityReads += 1;
          const threads = await read("threads", args);
          const current = threads.find((thread) => thread.id === threadId);

          if (current) liveActivity.push(current.activity);

          return threads;
        },
        interactions: { list: (args) => read(`threads/${args.threadId}/interactions`) },
      },
      plugins: {
        getSettings: async () => {
          initializationReads += 1;

          return read("plugins/push-notifications/settings");
        },
        updateSettings: async () => {
          const current = await read("plugins/push-notifications/settings");
          assert.equal(current.values.mobileEnabled, false);
          assert.equal(current.values.webEnabled, false);
          assert.equal(current.values.desktopEnabled, false);
          initializationReads += 1;

          return current;
        },
      },
    },
  });

  let service;

  try {
    await fake.api.storage.kv.set("delivery-initialized", true);
    await createPushNotificationsPlugin({
      coalesceMs: 10,
      now: () => Date.now() + 1_000,
      fetch: async (_url, init) => {
        mobileAttempts += 1;
        const messages = JSON.parse(init.body);

        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ data: messages.map(() => ({ status: "ok", id: "isolated-ticket" })) }),
        };
      },
    })(fake.api);
    service = fake.harness.behavior.runService("push-sender");

    for (let attempt = 0; initializationReads < 2 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(initializationReads, 2, "The sender must finish initialization");
    const thread = await read(`threads/${threadId}`);
    await fake.harness.behavior.emitThreadEvent("thread.idle", {
      thread,
      lastAssistantText: "Isolated notification verification",
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    service?.controller.abort();
    await service?.done;
    await fake.harness.lifecycle.dispose();
  }

  assert.ok(threadReads > 0, "The sender must read the live chat");
  assert.equal(fake.harness.logEntries.filter((entry) => entry.level === "error").length, 0);

  return {
    threadId,
    observedStatus,
    liveActivity,
    threadReads,
    activityReads,
    mobileAttempts,
    clientNotifications: fake.harness.realtimeSignals.length,
  };
}

const suppressed = await probe(busyId);

assert.equal(suppressed.mobileAttempts, 0);

assert.equal(suppressed.clientNotifications, 0);

assert.equal(suppressed.observedStatus, "active");

const delivered = await probe(finishedId);

await writeFile(output, `${JSON.stringify({ suppressed, delivered }, null, 2)}\n`);

assert.equal(delivered.mobileAttempts, 1);

assert.equal(delivered.clientNotifications, 1);

assert.ok(delivered.activityReads > 0, "The completed chat must pass live activity checks");

assert.ok(
  delivered.liveActivity.every((activity) => Object.values(activity).every((count) => count === 0)),
);

const result = {
  surface:
    "built replacement with live Omnyo thread/activity and canonical enrollment reads; isolated delivery sinks",
  suppressed,
  delivered,
  externalDelivery: false,
  passed: true,
};

await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);

console.log(JSON.stringify(result));

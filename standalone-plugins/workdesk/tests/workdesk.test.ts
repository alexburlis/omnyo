import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  experimental_scanPublicSdkOnly,
} from "@omnyo/plugin-sdk/testing";
import plugin from "../server";
import type { RecordItem } from "../server";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const host = createFakePluginHost({
    pluginId: "workdesk",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            projectId: threadId === "other" ? "project-b" : "project-a",
            title: `Chat ${threadId}`,
          }),
      },
      projects: {
        get: async ({ projectId }: { projectId: string }) => ({
          id: projectId,
          name: projectId === "project-b" ? "Beta" : "Alpha",
        }),
      },
    },
  });
  await plugin(host.api);
  t.after(() => host.harness.lifecycle.dispose());
  const call = host.harness.behavior;
  const report = async (input: object, threadId = "thread-a") =>
    JSON.parse(
      (await call.callAgentTool("workdesk_report", input, {
        threadId,
      })) as string,
    ) as RecordItem;
  const list = async (input: object) =>
    (await call.callRpc("list", input)) as {
      items: RecordItem[];
      total: number;
    };
  return { ...host, call, report, list };
}
const action = {
  key: "approve-release",
  kind: "action",
  area: "Mac release",
  summary:
    "Approve v2.4 publication to website and updater; release is blocked.",
  reason: "Sam must approve production publication.",
  priority: 1,
};
const work = {
  key: "checkout-verified",
  kind: "work",
  area: "Checkout",
  summary: "Fixed duplicate purchases; integration tests pass.",
  outcome: "verified",
  evidence: "Local integration suite: 12 tests pass.",
};

test("project-wide deduplication preserves both source chats and user controls", async (t) => {
  const h = await setup(t);
  const first = await h.report(action);
  await h.call.callRpc("edit", {
    id: first.id,
    operation: "priority",
    priority: 3,
  });
  const until = new Date(Date.now() + 86400000).toISOString();
  await h.call.callRpc("edit", { id: first.id, operation: "snooze", until });
  const updated = await h.report(
    {
      ...action,
      priority: 0,
      summary: "Approve v2.4; release remains blocked.",
    },
    "thread-b",
  );
  assert.equal(updated.id, first.id);
  assert.equal(updated.userPriority, 3);
  assert.equal(updated.snoozedUntil, until);
  assert.equal(updated.sources.length, 2);
  assert.equal((await h.list({ kind: "action" })).total, 0);
  assert.equal((await h.list({ kind: "action", status: "snoozed" })).total, 1);
  await h.call.callRpc("edit", { id: first.id, operation: "dismiss" });
  assert.equal((await h.report(action)).status, "dismissed");
  assert.equal(
    (await h.list({ kind: "action", status: "dismissed" })).total,
    1,
  );
});
test("archive and deletion retain records; reload preserves history and actions", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  await h.report(work);
  await h.call.emitThreadEvent("thread.archived", {
    thread: makeThreadResponse({ id: "thread-a" }),
  });
  assert.equal(
    (await h.list({ kind: "action" })).items[0].sources[0].archived,
    true,
  );
  const next = await h.harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  const read = async (kind: string) =>
    (await next.harness.behavior.callRpc("list", { kind })) as {
      items: RecordItem[];
      total: number;
    };
  assert.equal((await read("action")).items[0].id, a.id);
  assert.equal((await read("work")).total, 1);
  await next.harness.behavior.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "thread-a" }),
  });
  assert.equal((await read("work")).items[0].sources[0].deleted, true);
});
test("priority, due date ordering and project isolation", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  await h.report({ ...action, key: "normal", priority: 2 });
  await h.report({ ...action, key: "urgent", priority: 0 });
  await h.report(action, "other");
  await h.call.callRpc("edit", {
    id: a.id,
    operation: "priority",
    priority: 3,
  });
  const rows = await h.list({ kind: "action", projectId: "project-a" });
  assert.deepEqual(
    rows.items.map((r) => r.userPriority ?? r.priority),
    [0, 2, 3],
  );
  assert.equal(
    (await h.list({ kind: "action", projectId: "project-b" })).total,
    1,
  );
  await assert.rejects(
    h.call.callAgentTool(
      "workdesk_resolve",
      { id: a.id, evidence: "Verified approval" },
      { threadId: "other" },
    ),
  );
});
test("invalid, verbose, and unsupported verified reports fail visibly", async (t) => {
  const h = await setup(t);
  for (const bad of [
    { ...action, reason: "" },
    { ...action, summary: "x".repeat(241) },
    { ...work, evidence: "" },
    { ...action, priority: 4 },
    { ...work, important: true, reason: "" },
    { ...action, unknown: true },
  ])
    await assert.rejects(h.report(bad));
  assert.equal((await h.list({ kind: "action", status: "all" })).total, 0);
});
test("time windows, search, pagination and important acknowledgment", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-09-20T08:00:00Z"),
  });
  const h = await setup(t);
  await h.report(work);
  t.mock.timers.setTime(new Date("2026-09-21T10:00:00Z").getTime());
  const important = await h.report({
    ...work,
    key: "checkout-live",
    summary: "Checkout is live.",
    outcome: "shipped",
    important: true,
    reason: "New checkout changes purchase behavior.",
  });
  await h.report({
    ...work,
    key: "other-feature",
    area: "Watch sync",
    summary: "Verified reconnect behavior.",
  });
  assert.equal(
    (await h.list({ kind: "work", since: "2026-09-21T09:00:00Z" })).total,
    2,
  );
  assert.equal(
    (await h.list({ kind: "work", until: "2026-09-20T09:00:00Z" })).total,
    1,
  );
  assert.equal((await h.list({ kind: "work", search: "WATCH" })).total, 1);
  assert.equal(
    (await h.list({ kind: "work", limit: 1, offset: 1 })).items.length,
    1,
  );
  assert.equal((await h.list({ kind: "work", importantOnly: true })).total, 1);
  await h.call.callRpc("edit", { id: important.id, operation: "seen" });
  assert.equal((await h.list({ kind: "work", importantOnly: true })).total, 0);
});
test("snooze expiry, completion, reopen, and resolve with evidence", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-09-21T10:00:00Z"),
  });
  const h = await setup(t);
  const a = await h.report(action);
  await assert.rejects(
    h.call.callRpc("edit", {
      id: a.id,
      operation: "snooze",
      until: "2026-09-20T00:00:00Z",
    }),
  );
  await h.call.callRpc("edit", {
    id: a.id,
    operation: "snooze",
    until: "2026-09-21T11:00:00Z",
  });
  assert.equal((await h.list({ kind: "action" })).total, 0);
  t.mock.timers.setTime(new Date("2026-09-21T12:00:00Z").getTime());
  assert.equal((await h.list({ kind: "action" })).total, 1);
  await h.call.callRpc("edit", { id: a.id, operation: "done" });
  assert.equal((await h.report(action)).status, "done");
  const reopened = (await h.call.callRpc("edit", {
    id: a.id,
    operation: "reopen",
  })) as RecordItem;
  const resolved = JSON.parse(
    (await h.call.callAgentTool(
      "workdesk_resolve",
      {
        id: a.id,
        revision: reopened.revision,
        evidence: "Sam approved exact release in this chat.",
      },
      { threadId: "thread-b" },
    )) as string,
  );
  assert.equal(resolved.status, "done");
  assert.match(resolved.evidence, /Sam approved/);
  assert.equal(resolved.sources.length, 2);
});
test("missing reporting is explicit and checkpoints clear it", async (t) => {
  t.mock.timers.enable({
    apis: ["Date"],
    now: new Date("2026-09-21T10:00:00Z"),
  });
  const h = await setup(t);
  const thread = makeThreadResponse({ id: "thread-a" });
  await h.call.emitThreadEvent("thread.active", { thread });
  t.mock.timers.setTime(Date.now() + 1000);
  await h.call.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Finished.",
  });
  let overview = (await h.call.callRpc("overview")) as { missing: unknown[] };
  assert.equal(overview.missing.length, 1);
  await h.call.callAgentTool(
    "workdesk_checkpoint",
    {},
    { threadId: "thread-a" },
  );
  overview = (await h.call.callRpc("overview")) as { missing: unknown[] };
  assert.equal(overview.missing.length, 0);
  t.mock.timers.setTime(Date.now() + 1000);
  await h.call.emitThreadEvent("thread.active", { thread });
  t.mock.timers.setTime(Date.now() + 1000);
  await h.call.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Another turn.",
  });
  overview = (await h.call.callRpc("overview")) as { missing: unknown[] };
  assert.equal(overview.missing.length, 1);
});
test("CLI attaches current thread and rejects missing context", async (t) => {
  const h = await setup(t);
  const failed = await h.call.runCli(["report", JSON.stringify(action)]);
  assert.equal(failed.exitCode, 1);
  const result = await h.call.runCli(["overview"]);
  assert.equal(result.exitCode, 0);
});
test("plugin uses only public SDK exports", async () => {
  const result = await experimental_scanPublicSdkOnly(process.cwd(), {
    allow: [
      /^react(?:-dom)?(?:\/.*)?$/,
      /^@radix-ui\/react-(?:slot|checkbox|dialog)$/,
      /^class-variance-authority$/,
      /^@hugeicons\/(?:react|core-free-icons)$/,
      /^(?:clsx|tailwind-merge|jsdom)$/,
      /^@testing-library\/react$/,
    ],
  });
  assert.deepEqual(result.violations, []);
});

const tool = async (
  h: Awaited<ReturnType<typeof setup>>,
  name: string,
  input = {},
  threadId = "thread-a",
) =>
  JSON.parse((await h.call.callAgentTool(name, input, { threadId })) as string);

test("fresh context includes snoozed and dashboard-changed linked actions, scopes other chats and paginates", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  await h.call.callRpc("edit", {
    id: a.id,
    operation: "snooze",
    until: "2099-01-01T00:00:00Z",
  });
  await h.report({ ...action, key: "other-chat" }, "thread-b");
  await h.report(action, "other");
  let ctx = await tool(h, "workdesk_context", { limit: 1 });
  assert.equal(ctx.total, 2);
  assert.equal(ctx.nextOffset, 1);
  const page2 = await tool(h, "workdesk_context", { limit: 1, offset: 1 });
  assert.equal(page2.nextOffset, null);
  assert.equal(
    new Set([...ctx.items, ...page2.items].map((r) => r.id)).size,
    2,
  );
  for (const operation of ["done", "dismiss", "reopen"] as const) {
    await h.call.callRpc("edit", { id: a.id, operation });
    ctx = await tool(h, "workdesk_context");
    assert.equal(
      ctx.items.find((r: RecordItem) => r.id === a.id).status,
      operation === "reopen"
        ? "open"
        : operation === "dismiss"
          ? "dismissed"
          : "done",
    );
  }
  const instructions = h.harness.registrations.instructionProvider!({
    threadId: "thread-a",
    projectId: "project-a",
  })!;
  assert.ok(instructions.includes(a.id));
  assert.match(instructions, /start of every turn/);
  assert.ok(instructions.length < 4096);
});

test("handoff requires current pending review, including snoozed actions, and report cannot bypass it", async (t) => {
  const h = await setup(t);
  const thread = makeThreadResponse({ id: "thread-a" });
  await h.call.emitThreadEvent("thread.active", { thread });
  await h.report(work);
  const a = await h.report(action);
  await h.call.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Done",
  });
  assert.equal(((await h.call.callRpc("overview")) as any).missing.length, 1);
  assert.equal((await tool(h, "workdesk_checkpoint")).recorded, false);
  let pending = [
    {
      id: a.id,
      revision: a.revision,
      reason: "Exact release approval is still missing.",
    },
  ];
  assert.equal(
    (await tool(h, "workdesk_checkpoint", { pending })).recorded,
    true,
  );
  await h.call.callRpc("edit", {
    id: a.id,
    operation: "snooze",
    until: "2099-01-01T00:00:00Z",
  });
  assert.equal(
    (await tool(h, "workdesk_checkpoint", { pending })).recorded,
    false,
  );
  const updated = (await tool(h, "workdesk_context")).items[0];
  pending = [{ ...pending[0], revision: updated.revision }];
  assert.equal(
    (await tool(h, "workdesk_checkpoint", { pending })).recorded,
    true,
  );
  assert.equal((await tool(h, "workdesk_context")).items[0].status, "open");
  await assert.rejects(
    tool(h, "workdesk_checkpoint", {
      pending: [{ ...pending[0], reason: "" }],
    }),
  );
});

test("chat resolution clears handoff and persists evidence and resolving source across updates and reload", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  const evidence =
    "Sam approved v2.4 website and updater publication in this chat.";
  const r = await tool(
    h,
    "workdesk_resolve",
    { id: a.id, revision: a.revision, evidence },
    "thread-b",
  );
  assert.equal(r.status, "done");
  assert.equal(r.resolution.threadId, "thread-b");
  assert.equal((await tool(h, "workdesk_checkpoint")).recorded, true);
  const update = await h.report({ ...action, evidence: "Build ready" });
  assert.equal(update.resolution?.evidence, evidence);
  assert.equal(update.evidence, evidence);
  const next = await h.harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  const rows = (await next.harness.behavior.callRpc("list", {
    kind: "action",
    status: "done",
  })) as any;
  assert.equal(rows.items[0].resolution.evidence, evidence);
  assert.equal(rows.items[0].sources.length, 2);
});

test("stale resolutions cannot complete reopened items; dismissed items and evidence are preserved", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  await h.call.callRpc("edit", { id: a.id, operation: "done" });
  await h.call.callRpc("edit", { id: a.id, operation: "reopen" });
  await assert.rejects(
    tool(h, "workdesk_resolve", {
      id: a.id,
      revision: a.revision,
      evidence: "Old approval",
    }),
    /Action changed/,
  );
  const current = (await tool(h, "workdesk_context")).items[0];
  assert.equal(current.resolution, null);
  await h.call.callRpc("edit", { id: a.id, operation: "dismiss" });
  const dismissed = (await tool(h, "workdesk_context")).items[0];
  assert.equal(
    (
      await tool(h, "workdesk_resolve", {
        id: a.id,
        revision: dismissed.revision,
        evidence: "Unneeded",
      })
    ).status,
    "dismissed",
  );
  await assert.rejects(
    tool(h, "workdesk_resolve", { id: a.id, evidence: "Legacy stale attempt" }),
    /Read fresh workdesk_context/,
  );
  await assert.rejects(tool(h, "workdesk_resolve", { id: a.id, evidence: "" }));
});

test("opening, idle, archival and unrelated replies do not imply completion", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  const thread = makeThreadResponse({ id: "thread-a" });
  await h.call.emitThreadEvent("thread.active", { thread });
  await h.call.emitThreadEvent("thread.idle", {
    thread,
    lastAssistantText: "Done! Everything approved.",
  });
  await h.call.emitThreadEvent("thread.archived", { thread });
  assert.equal((await tool(h, "workdesk_context")).items[0].status, "open");
  assert.equal((await tool(h, "workdesk_checkpoint")).actions[0].id, a.id);
});

test("CLI supports old live sessions: context, review and resolution with source and project checks", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  const ctx = { threadId: "thread-a" };
  assert.equal((await h.call.runCli(["context"])).exitCode, 1);
  let result = await h.call.runCli(["context"], ctx);
  assert.equal(JSON.parse(result.stdout!).items[0].id, a.id);
  result = await h.call.runCli(["checkpoint"], ctx);
  assert.equal(JSON.parse(result.stdout!).recorded, false);
  const payload = JSON.stringify({
    id: a.id,
    revision: a.revision,
    evidence: "Sam supplied exact publication approval.",
  });
  assert.equal(
    (await h.call.runCli(["resolve", payload], { threadId: "other" })).exitCode,
    1,
  );
  assert.equal((await h.call.runCli(["resolve", payload], ctx)).exitCode, 0);
  result = await h.call.runCli(["checkpoint"], ctx);
  assert.equal(JSON.parse(result.stdout!).recorded, true);
  result = await h.call.runCli(["context"], ctx);
  assert.equal(JSON.parse(result.stdout!).items[0].status, "done");
});

test("pre-upgrade records get a usable revision and resolve without data migration", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  h.api.storage
    .database()
    .prepare(
      "UPDATE records SET data=json_remove(data,'$.revision','$.resolution') WHERE id=?",
    )
    .run(a.id);
  const legacy = (await tool(h, "workdesk_context")).items[0];
  assert.equal(legacy.revision, a.updatedAt);
  assert.equal(legacy.resolution, null);
  const resolved = await tool(h, "workdesk_resolve", {
    id: a.id,
    revision: legacy.revision,
    evidence: "Sam supplied the exact approval.",
  });
  assert.equal(resolved.status, "done");
});

const approval = {
  ...action,
  approval: true,
  details: "Publish only v2.4 to the website and updater; no other release.",
};
test("approval sends exact scope once to original source, resumes archive and closes after accepted delivery", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  const updated = await h.report(approval, "thread-b");
  h.harness.inspection.sdk.stub("threads.get", ({ threadId }: any) =>
    makeThreadResponse({ id: threadId, projectId: "project-a", archivedAt: 1 }),
  );
  h.harness.inspection.sdk.stub("threads.unarchive", () => ({ ok: true }));
  const sent: any[] = [];
  h.harness.inspection.sdk.stub("threads.send", (args: any) => {
    sent.push(args);
    return { ok: true, delivery: "sent" };
  });
  const r = (await h.call.callRpc("decide", {
    id: a.id,
    revision: updated.revision,
    choice: "approved",
  })) as RecordItem;
  assert.equal(r.status, "done");
  assert.equal(r.decision?.delivery, "sent");
  assert.equal(sent[0].threadId, "thread-a");
  assert.equal(sent[0].mode, "queue-if-active");
  assert.match(sent[0].input[0].text, /The user approved/);
  assert.ok(sent[0].input[0].text.includes(approval.details));
  assert.ok(sent[0].input[0].text.includes(approval.reason));
  assert.equal(h.harness.inspection.sdk.callsTo("threads.unarchive").length, 1);
  await h.call.callRpc("decide", {
    id: a.id,
    revision: updated.revision,
    choice: "approved",
  });
  assert.equal(sent.length, 1);
  await assert.rejects(
    h.call.callRpc("decide", {
      id: a.id,
      revision: r.revision,
      choice: "declined",
    }),
  );
  await assert.rejects(
    h.report({ ...approval, details: "Publish v3 instead" }),
  );
  await assert.rejects(
    h.call.callRpc("edit", { id: a.id, operation: "reopen" }),
  );
});
test("decline dismisses silently; generic completion and stale clicks cannot authorize", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  await assert.rejects(h.call.callRpc("edit", { id: a.id, operation: "done" }));
  await assert.rejects(
    h.call.callRpc("edit", { id: a.id, operation: "dismiss" }),
  );
  const changed = await h.report({
    ...approval,
    details: "Different exact scope",
  });
  await assert.rejects(
    h.call.callRpc("decide", {
      id: a.id,
      revision: a.revision,
      choice: "approved",
    }),
    /Request changed/,
  );
  h.harness.inspection.sdk.stub("threads.send", () => ({
    ok: true,
    delivery: "queued",
  }));
  const r = (await h.call.callRpc("decide", {
    id: a.id,
    revision: changed.revision,
    choice: "declined",
  })) as RecordItem;
  assert.equal(r.status, "dismissed");
  assert.equal(r.decision?.delivery, "not-required");
  assert.equal(r.decision!.message, "");
  assert.equal(h.harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.unarchive").length, 0);
  assert.equal((await h.list({ kind: "action" })).total, 0);
});
test("delivery ambiguity remains visible and cannot send twice; receiving chat can acknowledge", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  let sends = 0;
  h.harness.inspection.sdk.stub("threads.send", () => {
    sends++;
    throw new Error("Connection dropped after dispatch");
  });
  const r = (await h.call.callRpc("decide", {
    id: a.id,
    revision: a.revision,
    choice: "approved",
  })) as RecordItem;
  assert.equal(r.status, "open");
  assert.equal(r.decision?.delivery, "unconfirmed");
  await h.call.callRpc("decide", {
    id: a.id,
    revision: a.revision,
    choice: "approved",
  });
  assert.equal(sends, 1);
  const payload = JSON.stringify({ id: a.id, decisionId: r.decision!.id });
  assert.equal(
    (await h.call.runCli(["acknowledge", payload], { threadId: "thread-b" }))
      .exitCode,
    1,
  );
  const ack = await h.call.runCli(["acknowledge", payload], {
    threadId: "thread-a",
  });
  assert.equal(JSON.parse(ack.stdout!).status, "done");
  const next = await h.harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  const saved = (await next.harness.behavior.callRpc("decide", {
    id: a.id,
    revision: a.revision,
    choice: "approved",
  })) as RecordItem;
  assert.equal(saved.decision?.delivery, "sent");
  assert.equal(sends, 1);
});
test("concurrent decisions dispatch only once and missing recipient fails visibly", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  h.harness.inspection.sdk.stub("threads.send", () => ({
    ok: true,
    delivery: "sent",
  }));
  await Promise.all([
    h.call.callRpc("decide", {
      id: a.id,
      revision: a.revision,
      choice: "approved",
    }),
    h.call.callRpc("decide", {
      id: a.id,
      revision: a.revision,
      choice: "approved",
    }),
  ]);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.send").length, 1);
  const b = await h.report({ ...approval, key: "different" });
  await h.call.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "thread-a" }),
  });
  await assert.rejects(
    h.call.callRpc("decide", {
      id: b.id,
      revision: b.revision,
      choice: "approved",
    }),
    /unavailable/,
  );
  const task = await h.report({ ...action, key: "manual-task" });
  await assert.rejects(
    h.call.callRpc("decide", {
      id: task.id,
      revision: task.revision,
      choice: "approved",
    }),
    /not an open approval/,
  );
});

test("existing prose requests can be classified without deciding or sending", async (t) => {
  const h = await setup(t);
  const a = await h.report(action);
  const payload = { id: a.id, revision: a.revision, threadId: "thread-a" };
  assert.equal(
    (
      await h.call.runCli([
        "request-approval",
        JSON.stringify({ ...payload, threadId: "other" }),
      ])
    ).exitCode,
    1,
  );
  const result = await h.call.runCli([
    "request-approval",
    JSON.stringify(payload),
  ]);
  const r = JSON.parse(result.stdout!);
  assert.equal(r.approval, true);
  assert.equal(r.status, "open");
  assert.equal(r.decision, null);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal(
    (await h.call.runCli(["request-approval", JSON.stringify(payload)]))
      .exitCode,
    1,
  );
});

test("silent decline survives reload and works with a deleted recipient", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  await h.call.emitThreadEvent("thread.deleted", {
    thread: makeThreadResponse({ id: "thread-a" }),
  });
  const gets = h.harness.inspection.sdk.callsTo("threads.get").length;
  h.harness.inspection.sdk.stub("threads.get", () => {
    throw new Error("Unavailable");
  });
  const input = { id: a.id, revision: a.revision, choice: "declined" };
  const r = (await h.call.callRpc("decide", input)) as RecordItem;
  assert.equal(r.status, "dismissed");
  assert.equal(r.decision?.delivery, "not-required");
  assert.equal(h.harness.inspection.sdk.callsTo("threads.get").length, gets);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.send").length, 0);
  assert.equal(h.harness.inspection.sdk.callsTo("threads.unarchive").length, 0);
  const next = await h.harness.lifecycle.reload(plugin);
  t.after(() => next.harness.lifecycle.dispose());
  assert.equal(
    ((await next.harness.behavior.callRpc("decide", input)) as RecordItem)
      .status,
    "dismissed",
  );
  assert.equal(next.harness.inspection.sdk.callsTo("threads.send").length, 0);
});

test("queued approval still sends once and closes", async (t) => {
  const h = await setup(t);
  const a = await h.report(approval);
  h.harness.inspection.sdk.stub("threads.send", () => ({
    ok: true,
    delivery: "queued",
  }));
  const r = (await h.call.callRpc("decide", {
    id: a.id,
    revision: a.revision,
    choice: "approved",
  })) as RecordItem;
  assert.equal(r.status, "done");
  assert.equal(r.decision?.delivery, "queued");
});

test("idle first observed mid-turn does not invent missing reporting coverage", async (t) => {
  const h = await setup(t);
  await h.call.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thread-a" }),
    lastAssistantText: "Done",
  });
  assert.equal(((await h.call.callRpc("overview")) as any).missing.length, 0);
});

test("report boundaries reject verbose copy rather than silently truncating scope", async (t) => {
  const h = await setup(t);
  for (const [field, length] of [
    ["summary", 101],
    ["reason", 121],
    ["details", 1201],
    ["evidence", 401],
  ] as const) {
    await assert.rejects(h.report({ ...action, [field]: "x".repeat(length) }));
  }
  const r = await h.report({
    ...approval,
    details: "- Website and updater only.\n- No other release.",
  });
  assert.match(r.details, /No other release/);
});

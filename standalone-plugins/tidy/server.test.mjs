import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@omnyo/plugin-sdk/testing";
import plugin from "./server.ts";

const REASON = "The requested change is complete and verified.";

function work(ready = true, change = {}) {
  return {
    basis: "current-basis",
    revision: "current-revision",
    primary: {
      label: ready ? "ready-to-archive" : "open",
      reason: { code: "assessed", text: REASON },
    },
    activity: [],
    requiredInput: [],
    optionalInput: [],
    failures: [],
    waits: [],
    nextActors: [],
    assessment: {
      availability: "available",
      reason: REASON,
      sourceSeq: 10,
      suggestion: "omitted",
      noSuggestionReason: "No reply is needed.",
      waitingOn: null,
    },
    postponement: null,
    archive: { eligible: true, recommended: ready, reason: ready ? REASON : "More work remains." },
    ...change,
  };
}

async function fixture(t, items = [{ id: "done", work: work() }], environmentStatus = null) {
  const state = {
    threads: items.map((item) => makeThreadResponse({ status: "idle", ...item })),
    inputs: new Map(),
    maintenance: new Map(),
    listFailure: false,
    archiveFailure: new Set(),
    archived: [],
    guardCalls: [],
    workCalls: [],
    workFailure: false,
    predictionCalls: 0,
    nativeReads: 0,
    manualArchives: 0,
    listCalls: 0,
    idReads: [],
    subscriptions: [],
    listHold: null,
    listStarted: null,
  };

  const host = createFakePluginHost({
    pluginId: "tidy",
    sdk: {
      subscribe: (subscription) => {
        state.subscriptions.push(subscription);

        return () => {};
      },
      threads: {
        list: async ({ offset = 0, limit = 100, threadIds }) => {
          if (threadIds === undefined) state.listCalls += 1;
          else state.idReads.push(threadIds);

          if (state.listFailure) throw new Error("fixture list unavailable");

          const page = structuredClone(
            (threadIds === undefined
              ? state.threads.slice(offset, offset + limit)
              : state.threads.filter((thread) => threadIds.includes(thread.id))
            ).filter((thread) => thread.archivedAt === null),
          );

          state.listStarted?.();

          if (state.listHold !== null) await state.listHold;

          return page;
        },
        get: async ({ threadId }) => {
          const thread = state.threads.find((entry) => entry.id === threadId);

          if (!thread) throw Object.assign(new Error("not found"), { status: 404 });

          return thread;
        },
        events: {
          list: async ({ threadId, beforeSeq, limit }) =>
            [
              { seq: state.inputs.get(threadId) ?? 1, data: { initiator: "user" } },
              ...(state.maintenance.get(threadId) ?? []).map((seq) => ({
                seq,
                data: { initiator: "system", maintenance: "auto-compaction" },
              })),
            ]
              .filter((request) => beforeSeq === undefined || request.seq < Number(beforeSeq))
              .sort((left, right) => right.seq - left.seq)
              .slice(0, Number(limit ?? 100)),
        },
        experimental_publishWork: async (input) => {
          if (state.workFailure) throw new Error("work update unavailable");
          state.workCalls.push(input);

          return work(false);
        },
        experimental_archiveReady: async ({ threadId, basis }) => {
          state.guardCalls.push({ threadId, basis });
          const thread = state.threads.find((entry) => entry.id === threadId);

          if (
            !thread?.work?.archive.recommended ||
            thread.work.basis !== basis ||
            state.archiveFailure.has(threadId)
          )
            throw new Error("Work changed before archive");
          thread.archivedAt = Date.now();
          state.archived.push(threadId);

          return { ok: true, archivedThreadIds: [threadId] };
        },
        archive: async () => {
          state.manualArchives += 1;
          throw new Error("manual archive must not be called");
        },
        interactions: {
          list: async () => {
            state.nativeReads += 1;

            return [];
          },
        },
      },
      experimental_attention: {
        snapshot: async () => {
          state.nativeReads += 1;

          return { questions: [], callbacks: [] };
        },
      },
      plugins: {
        callRpc: async () => {
          state.predictionCalls += 1;
          throw new Error("No prediction reads should occur");
        },
      },
      projects: { list: async () => [] },
      environments: {
        status: async () =>
          environmentStatus ?? {
            outcome: "unavailable",
            failure: { code: "fixture_workspace_offline" },
          },
      },
    },
  });

  await plugin(host.api);
  t.after(() => host.harness.lifecycle.dispose());

  return { state, host, rpc: (method, input = null) => host.harness.callRpc(method, input) };
}

test("contributes evidence-bearing completion reports without treating omission as completion", async (t) => {
  const { host } = await fixture(t);

  const instructions = host.harness.inspection.registrations.instructionProvider({
    threadId: "done",
    projectId: "project-test",
  });

  assert.ok(instructions);
  assert.match(instructions, /Use report_chat_outcome when available/u);
  assert.doesNotMatch(instructions, /(?:Completed|Not ready):/u);
  assert.match(instructions, /readiness remains unassessed/u);
  assert.match(instructions, /honor their output format/u);
  assert.match(instructions, /Only the user can accept a narrower finish line/u);
  assert.match(
    instructions,
    /A plan, audit, draft, preparation step or handoff is complete only when that bounded deliverable is the user's requested outcome/u,
  );
  assert.match(
    instructions,
    /A provider refusal, partial trial, failed attempt, stopped run or delegated handoff leaves a larger requested outcome unfinished/u,
  );
  assert.match(
    instructions,
    /reports as still open, unfixed, unresolved or remaining keeps the chat open, including a defect or stale state you found/u,
  );
  assert.doesNotMatch(instructions, /Glance|Owner installation/u);
  assert.match(instructions, /Continue recoverable work within existing authority/u);
  assert.match(instructions, /Do not retry indefinitely or invent a blocker for optional work/u);
  assert.ok(
    !instructions.includes(
      "Do not leave a completed plan, audit, draft, preparation step or bounded handoff open",
    ),
  );
  assert.ok(!instructions.includes("a final response without it is offered as Ready to archive"));
});

test("lists the canonical recommendation without prediction, native-attention or per-thread reads", async (t) => {
  const { state, rpc } = await fixture(t, [
    { id: "done", status: "active", work: work() },
    { id: "open", work: work(false) },
    { id: "unknown", work: null },
  ]);

  const result = await rpc("queue_get");
  assert.deepEqual(
    result.entries.map((entry) => entry.threadId),
    ["done"],
  );
  assert.equal(result.entries[0].reason, REASON);
  assert.match(result.error, /unavailable for 1 chat/u);
  assert.equal(state.predictionCalls, 0);
  assert.equal(state.nativeReads, 0);
  assert.equal(state.listCalls, 1);
});

test("optional input does not create a competing archive veto", async (t) => {
  const { rpc } = await fixture(t, [
    {
      id: "done",
      work: work(true, {
        optionalInput: [{ id: "optional", kind: "question", label: "Optional preference" }],
      }),
    },
  ]);

  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
});

test("retains Not done until a new input arrives", async (t) => {
  const { rpc, state } = await fixture(t);
  await rpc("ready_ids");
  assert.deepEqual(await rpc("dismiss", { threadId: "done" }), {
    threadId: "done",
    dismissed: true,
  });
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
  state.threads[0].lastReadAt = Date.now();
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
  state.inputs.set("done", 2);
  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
});

test("an automatic compaction neither records nor clears Not done", async (t) => {
  const { rpc, state } = await fixture(t);
  await rpc("ready_ids");
  state.maintenance.set("done", [3]);
  await rpc("dismiss", { threadId: "done" });
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
  state.maintenance.set("done", [3, 5]);
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
  state.inputs.set("done", 7);
  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
});

test("dismissal publishes an Open work status for every sidebar client", async (t) => {
  const { rpc, state } = await fixture(t);
  await rpc("ready_ids");
  await rpc("dismiss", { threadId: "done" });
  assert.deepEqual(state.workCalls, [
    {
      threadId: "done",
      pluginId: "tidy",
      contribution: {
        kind: "signals",
        signals: {
          complete: true,
          validUntil: null,
          activity: [],
          waits: [],
          failures: [],
          postponement: {
            reason: "Not ready to archive",
            until: null,
            resumeActor: { kind: "user", id: null, label: "Continue the chat" },
          },
        },
      },
    },
  ]);
});

test("a failed sidebar update leaves the suggestion available for retry", async (t) => {
  const { rpc, state } = await fixture(t);
  await rpc("ready_ids");
  state.workFailure = true;
  await assert.rejects(rpc("dismiss", { threadId: "done" }), /work update unavailable/);
  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
});

test("a new server snapshot removes readiness without waiting for a prediction cache", async (t) => {
  const { rpc, state } = await fixture(t);
  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
  state.threads[0].work = work(false, {
    primary: { label: "working", reason: { code: "owned-work", text: "Release job running" } },
    archive: { eligible: false, recommended: false, reason: "Release job running" },
  });
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
});

test("keeps the last known list and reports it while the shared snapshot cannot be read", async (t) => {
  const { rpc, state, host } = await fixture(t);
  const before = await rpc("ready_ids");
  assert.deepEqual(before.threadIds, ["done"]);
  assert.equal(before.stale, false);
  state.listFailure = true;
  const queue = await rpc("queue_get");
  assert.deepEqual(
    queue.entries.map((entry) => entry.threadId),
    ["done"],
  );
  assert.match(queue.error, /could not be read .*last known list/u);
  const failed = await rpc("ready_ids");
  assert.deepEqual(failed.threadIds, ["done"]);
  assert.equal(failed.stale, true);
  assert.deepEqual(host.harness.realtimeSignals.at(-1).payload.threadIds, ["done"]);
  assert.equal(host.harness.realtimeSignals.at(-1).payload.stale, true);

  state.listFailure = false;
  assert.equal((await rpc("ready_ids")).stale, false);
  assert.equal((await rpc("queue_get")).error, null);
});

test("does not offer anything when the first read fails, and says so", async (t) => {
  const { rpc, state } = await fixture(t);
  state.listFailure = true;
  const queue = await rpc("queue_get");
  assert.deepEqual(queue.entries, []);
  assert.match(queue.error, /could not be read/u);
});

function changeCallback(state) {
  const changed = state.subscriptions.find(
    (subscription) => subscription.event === "thread:changed",
  );

  assert.ok(changed);

  return changed.callback;
}

async function runService(t, host) {
  const service = host.harness.runService("readiness");
  t.after(async () => {
    service.controller.abort();
    await service.done;
  });
}

async function settled(condition) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.fail("The change did not settle");
}

test("rereads only a changed chat and publishes its new recommendation", async (t) => {
  const { state, host } = await fixture(t, [
    { id: "done", work: work() },
    { id: "later", work: work(false) },
  ]);

  await runService(t, host);
  await settled(() => state.subscriptions.length >= 2 && state.listCalls === 1);
  await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 1);

  state.threads[1].work = work();
  changeCallback(state)({ id: "later", changes: ["work-changed"] });
  await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 2);

  assert.equal(state.listCalls, 1);
  assert.deepEqual(state.idReads, [["later"]]);
});

for (const change of ["queue-changed", "interactions-changed"]) {
  test(`rereads a chat after ${change}`, async (t) => {
    const { state, host } = await fixture(t);
    await runService(t, host);
    await settled(() => state.listCalls === 1);
    await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 1);

    state.threads[0].work = work(false);
    changeCallback(state)({ id: "done", changes: [change] });
    await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 0);
    assert.equal(state.listCalls, 1);
  });
}

test("a periodic full read heals a change that was never announced", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { state, host } = await fixture(t);
  await runService(t, host);
  await settled(() => state.listCalls === 1);
  await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 1);

  state.threads[0].work = work(false);
  t.mock.timers.tick(5 * 60_000);
  await settled(() => host.harness.realtimeSignals.at(-1)?.payload.threadIds.length === 0);
  assert.equal(state.listCalls, 2);
});

test("a stream of changes on one chat cannot hold back another chat's recommendation", async (t) => {
  const { rpc, state, host } = await fixture(t, [
    { id: "done", work: work(false) },
    { id: "noisy", status: "active", work: work(false) },
  ]);

  await runService(t, host);
  await settled(() => state.listCalls === 1);

  const callback = changeCallback(state);
  state.listStarted = () => callback({ id: "noisy", changes: ["work-changed"] });
  state.threads[0].work = work();

  const ready = await rpc("ready_ids");
  state.listStarted = null;
  assert.deepEqual(ready.threadIds, ["done"]);
});

test("a change during a full read keeps a removed chat out of the applied snapshot", async (t) => {
  const { state, host, rpc } = await fixture(t, [{ id: "done", work: work(false) }]);
  await runService(t, host);
  await settled(() => state.listCalls === 1);

  let release;
  state.listHold = new Promise((resolve) => {
    release = resolve;
  });

  const started = new Promise((resolve) => {
    state.listStarted = resolve;
  });

  state.threads[0].work = work();
  const pending = rpc("ready_ids");
  await started;
  state.listStarted = null;
  state.threads[0].work = work(false);
  state.listHold = null;
  changeCallback(state)({ id: "done", changes: ["status-changed"] });
  release();
  assert.deepEqual((await pending).threadIds, []);
});

test("returns only the server-recorded wait without parsing a model waitingOn string", async (t) => {
  const { rpc } = await fixture(t, [
    {
      id: "review",
      work: work(false, {
        primary: {
          label: "waiting",
          reason: { code: "external-wait", text: "Waiting for App Store review" },
        },
      }),
    },
  ]);

  assert.deepEqual((await rpc("ready_ids")).waiting, [
    { threadId: "review", on: "Waiting for App Store review" },
  ]);
});

test("lists a chat the server labels External and ignores an unclassified waitingOn", async (t) => {
  const assessment = { ...work().assessment, waitingOn: "App Store review" };

  const { rpc } = await fixture(t, [
    {
      id: "review",
      work: work(false, {
        primary: {
          label: "external",
          reason: { code: "predicted-external-wait", text: "Waiting on App Store review" },
        },
        assessment,
      }),
    },
    { id: "stale", work: work(false, { assessment }) },
  ]);

  assert.deepEqual((await rpc("ready_ids")).waiting, [
    { threadId: "review", on: "Waiting on App Store review" },
  ]);
});

test("uses the core guard with the current basis and preserves deliberate manual archiving", async (t) => {
  const { rpc, state } = await fixture(t);
  assert.deepEqual(await rpc("archive", { threadIds: ["done"] }), { archived: 1, failures: [] });
  assert.deepEqual(state.guardCalls, [{ threadId: "done", basis: "current-basis" }]);
  assert.equal(state.manualArchives, 0);
});

test("reports a race rejected by the core archive guard without using a manual archive fallback", async (t) => {
  const { rpc, state } = await fixture(t);
  state.archiveFailure.add("done");
  const result = await rpc("archive", { threadIds: ["done"] });
  assert.equal(result.archived, 0);
  assert.match(result.failures[0].message, /Work changed/u);
  assert.equal(state.manualArchives, 0);
});

test("does not archive a dismissed, shelved or hidden chat", async (t) => {
  const { rpc, state } = await fixture(t, [
    { id: "done", work: work() },
    { id: "shelf", shelvedAt: 20, work: work() },
    { id: "hidden", visibility: "hidden", work: work() },
  ]);

  await rpc("dismiss", { threadId: "done" });
  const result = await rpc("archive", { threadIds: ["done", "shelf", "hidden"] });
  assert.equal(result.archived, 0);
  assert.equal(result.failures.length, 3);
  assert.equal(state.guardCalls.length, 0);
});

test("keeps workspace notes advisory while the core guard owns eligibility", async (t) => {
  const { rpc } = await fixture(t, [{ id: "done", environmentId: "fixture-env", work: work() }]);
  const queue = await rpc("queue_get");
  assert.equal(queue.entries.length, 1);
  assert.equal(queue.entries[0].caveats[0].code, "workspace-unreadable");
  assert.equal((await rpc("archive", { threadIds: ["done"] })).archived, 1);
});

test("check lists shared-checkout changes as advisory notes, not as unfinished work", async (t) => {
  const { host } = await fixture(t, [{ id: "done", environmentId: "fixture-env", work: work() }], {
    outcome: "available",
    workspace: {
      workingTree: { hasUncommittedChanges: true, files: ["a.ts", "b.ts"] },
      mergeBase: null,
    },
  });

  const result = await host.harness.runCli(["check", "done"]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Ready to archive: /u);
  assert.match(
    result.stdout,
    /Workspace notes \(advisory; they never block readiness and may belong to other chats\):\n {2}- 2 uncommitted files in the workspace/u,
  );
});

test("check explains its own running turn and the recorded assessment", async (t) => {
  const { host } = await fixture(t, [
    {
      id: "running",
      status: "active",
      work: work(false, {
        primary: {
          label: "working",
          reason: { code: "owned-work", text: "The agent is working." },
        },
        activity: [
          {
            id: "turn:running",
            kind: "turn",
            label: "The agent is working.",
            phase: "running",
            actor: { kind: "agent", id: "running", label: "Agent" },
          },
        ],
        assessment: {
          ...work().assessment,
          availability: "failed",
          reason: "Predictions need fresh included Codex allowance.",
        },
        archive: {
          eligible: false,
          recommended: false,
          reason: "The chat still has unresolved work.",
        },
      }),
    },
  ]);

  const result = await host.harness.runCli(["check", "."], { threadId: "running" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Not ready to archive: The agent is working\./u);
  assert.doesNotMatch(result.stdout, /unresolved work/u);
  assert.equal(result.stdout.match(/The agent is working/gu).length, 1);
  assert.match(result.stdout, /inside this chat's own turn/u);
  assert.match(result.stdout, /Completion assessment: failed\. Predictions need fresh/u);
});

test("a newer work change prevents an older list response from restoring readiness", async (t) => {
  const { rpc, state, host } = await fixture(t);
  const service = host.harness.runService("readiness");
  t.after(async () => {
    service.controller.abort();
    await service.done;
  });
  assert.deepEqual((await rpc("ready_ids")).threadIds, ["done"]);
  let release;
  state.listHold = new Promise((resolve) => {
    release = resolve;
  });

  const started = new Promise((resolve) => {
    state.listStarted = resolve;
  });

  const stale = rpc("queue_get");
  await started;
  state.threads[0].work = work(false, {
    primary: { label: "working", reason: { code: "owned-work", text: "A new job is running" } },
    archive: { eligible: false, recommended: false, reason: "A new job is running" },
  });

  const changed = state.subscriptions.find(
    (subscription) => subscription.event === "thread:changed",
  );

  assert.ok(changed);
  changed.callback({ id: "done", changes: ["work-changed"] });
  release();
  const result = await stale;
  assert.deepEqual(result.entries, []);
  assert.deepEqual((await rpc("ready_ids")).threadIds, []);
});

async function settle() {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function openProposals(host) {
  return host.api.storage.kv.list("archive-proposal:");
}

test("one pinned approval archives only the reviewed, unchanged chats in the project", async (t) => {
  const { host, state, rpc } = await fixture(t, [
    { id: "source", title: "Coordinator", work: work(false) },
    { id: "first", title: "First", work: work() },
    { id: "second", title: "Second", work: work() },
    { id: "changed", title: "Changed", work: work() },
    { id: "elsewhere", projectId: "other", work: work() },
  ]);

  const proposal = await host.harness.runCli(["propose", "--json"], { threadId: "source" });
  assert.equal(proposal.exitCode, 0);
  const { threadIds, pinned } = JSON.parse(proposal.stdout);
  assert.deepEqual(new Set(threadIds), new Set(["first", "second", "changed"]));
  assert.equal(pinned, true);
  assert.deepEqual(state.archived, []);

  const [pending] = host.harness.pendingInteractions;
  assert.equal(host.harness.pendingInteractions.length, 1);
  assert.equal(pending.threadId, "source");
  assert.equal(pending.rendererId, "archive-approval");
  assert.equal(pending.title, "Archive 3 ready chats");
  assert.deepEqual(new Set(pending.payload.threadIds), new Set(threadIds));
  assert.equal(pending.presentation.label.pending, "Archive 3 ready chats");
  assert.ok(pending.timeoutMs <= 7 * 24 * 60 * 60 * 1000);
  assert.ok(pending.timeoutMs > 7 * 24 * 60 * 60 * 1000 - 60_000);

  const { chats } = await rpc("archive_review", {
    sourceThreadId: "source",
    threadIds: [...threadIds, "elsewhere", "source"],
  });

  assert.deepEqual(
    chats.slice(-2).map(({ state }) => state),
    ["unavailable", "unavailable"],
  );

  const reviewed = chats
    .filter(({ basis }) => basis !== null)
    .map(({ threadId, title, basis }) => ({ threadId, title, basis }));

  const input = { sourceThreadId: "source", reviewed };

  await assert.rejects(
    host.harness.callRpc("archive_approval", input, {
      experimental_caller: { kind: "plugin", pluginId: "fixture-plugin" },
    }),
    /Approve this archive from the approval above the composer/u,
  );
  assert.deepEqual(state.archived, []);

  state.threads.find(({ id }) => id === "changed").work = work(true, { basis: "different-turn" });
  const approval = await rpc("archive_approval", input);
  assert.equal(approval.archived, 2);
  assert.deepEqual(new Set(state.archived), new Set(["first", "second"]));
  assert.deepEqual(
    approval.failures.map(({ threadId }) => threadId),
    ["changed"],
  );
  assert.equal(state.guardCalls.length, 2);
  await rpc("ready_ids");
  await settle();
  assert.equal(host.harness.pendingInteractions.length, 1);
  assert.equal((await openProposals(host)).length, 1);

  assert.deepEqual(
    await pending.describeSubmission({
      archived: 2,
      failures: [{ threadId: "changed", message: "This chat changed since it was reviewed." }],
    }),
    {
      title: "Archived 2 of 3 chats",
      detail: "- Changed: This chat changed since it was reviewed.",
    },
  );
  assert.deepEqual(await pending.describeSubmission({ archived: 0, failures: [] }), {
    title: "Already archived",
  });

  host.harness.submitInteraction(pending.id, approval);
  await settle();
  assert.deepEqual(await openProposals(host), []);
  assert.equal((await rpc("archive_approval", input)).archived, 0);
  assert.deepEqual(
    (
      await rpc("archive_review", { sourceThreadId: "source", threadIds: ["first", "second"] })
    ).chats.map(({ state }) => state),
    ["archived", "archived"],
  );
});

test("propose tells the agent the approval is pinned and never pastes a directive", async (t) => {
  const { host } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", title: "First", work: work() },
  ]);

  const first = await host.harness.runCli(["propose"], { threadId: "source" });
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /Pinned an approval to archive 1 chat above the owner's composer/u);
  assert.match(first.stdout, /Do not paste a directive/u);
  assert.doesNotMatch(first.stdout, /::archive-chats/u);

  const again = await host.harness.runCli(["propose"], { threadId: "source" });
  assert.match(again.stdout, /already pinned/u);
  assert.equal(host.harness.pendingInteractions.length, 1);
  assert.equal(host.harness.pendingInteractions[0].title, "Archive 1 ready chat");
});

test("withdraws the pinned approval once no listed chat is still ready", async (t) => {
  const { host, state, rpc } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", work: work() },
    { id: "second", work: work() },
  ]);

  await host.harness.runCli(["propose"], { threadId: "source" });
  state.threads.find(({ id }) => id === "first").work = work(false);
  await rpc("ready_ids");
  await settle();
  assert.equal(host.harness.pendingInteractions.length, 1);

  state.threads.find(({ id }) => id === "second").archivedAt = Date.now();
  await rpc("ready_ids");
  await settle();
  assert.deepEqual(host.harness.pendingInteractions, []);
  assert.deepEqual(await openProposals(host), []);
});

test("Not now settles the approval without archiving", async (t) => {
  const { host, state } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", work: work() },
  ]);

  await host.harness.runCli(["propose"], { threadId: "source" });
  host.harness.cancelInteraction(host.harness.pendingInteractions[0].id);
  await settle();
  assert.deepEqual(await openProposals(host), []);
  assert.deepEqual(state.archived, []);
});

test("archiving the source chat withdraws its approval", async (t) => {
  const { host, state } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", work: work() },
  ]);

  await host.harness.runCli(["propose"], { threadId: "source" });
  const source = state.threads.find(({ id }) => id === "source");
  await host.harness.emitThreadEvent("thread.archived", { thread: source });
  await settle();
  assert.deepEqual(host.harness.pendingInteractions, []);
  assert.deepEqual(await openProposals(host), []);
});

test("re-pins an interrupted approval after the plugin restarts", async (t) => {
  const { host } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", work: work() },
  ]);

  await host.harness.runCli(["propose"], { threadId: "source" });
  const restarted = await host.harness.lifecycle.reload(plugin);
  t.after(() => restarted.harness.lifecycle.dispose());
  assert.equal((await openProposals(restarted)).length, 1);
  assert.deepEqual(restarted.harness.pendingInteractions, []);

  const service = restarted.harness.runService("readiness");
  t.after(() => service.controller.abort());
  await settle();
  assert.equal(restarted.harness.pendingInteractions.length, 1);
  assert.equal(restarted.harness.pendingInteractions[0].threadId, "source");
  assert.deepEqual(restarted.harness.pendingInteractions[0].payload, { threadIds: ["first"] });
});

test("an approval being answered stays pinned while its chats leave Ready", async (t) => {
  const { host, state, rpc } = await fixture(t, [
    { id: "source", work: work(false) },
    { id: "first", title: "First", work: work() },
  ]);

  await host.harness.runCli(["propose"], { threadId: "source" });

  const approval = await rpc("archive_approval", {
    sourceThreadId: "source",
    reviewed: [{ threadId: "first", title: "First", basis: "current-basis" }],
  });

  assert.equal(approval.archived, 1);
  assert.deepEqual(state.archived, ["first"]);
  await rpc("ready_ids");
  await settle();
  assert.equal(host.harness.pendingInteractions.length, 1);
});

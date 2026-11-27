import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { PluginApi } from "@omnyo/plugin-sdk";
import { cardDiffSchema, cardSchema, rpcContract, type CardInput } from "../contract.ts";
import plugin from "../server.ts";
import { GlanceService } from "../lib/service.ts";

type EventRow = Awaited<ReturnType<PluginApi["sdk"]["threads"]["events"]["list"]>>[number];

const hosts: FakePluginHost[] = [];

function card(headline = "The implementation is progressing"): CardInput {
  return { status: "working", phase: "build", headline };
}

function command(seq: number, text: string, exitCode = 0, output = `Result ${seq}`): EventRow {
  return {
    id: `event-${seq}`,
    threadId: "thread-1",
    seq,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: {
      providerThreadId: "provider-1",
      item: {
        type: "commandExecution",
        id: `command-${seq}`,
        command: text,
        cwd: "/workspace",
        status: exitCode === 0 ? "completed" : "failed",
        approvalStatus: null,
        aggregatedOutput: output,
        exitCode,
      },
    },
    createdAt: Date.now() - 1000,
  };
}

function reply(seq: number, text: string): EventRow {
  return {
    id: `event-${seq}`,
    threadId: "thread-1",
    seq,
    scope: { kind: "turn", turnId: "turn-1" },
    type: "item/completed",
    data: {
      providerThreadId: "provider-1",
      item: { type: "agentMessage", id: `reply-${seq}`, text },
    },
    createdAt: Date.now() - 1000,
  };
}

function fixture() {
  const events: EventRow[] = [];
  let maxSeq = 0;
  let failAbove = 100;
  let beforeReplies: (() => Promise<void>) | null = null;

  let proofs: Awaited<
    ReturnType<PluginApi["sdk"]["threads"]["experimental_lookupCommandProofs"]>
  >["proofs"] = [];

  const host = createFakePluginHost({
    pluginId: "glance",
    sdk: {
      threads: {
        experimental_lookupCommandProofs: async (input) => {
          if (input.threadId !== "thread-1") throw new Error("Chat not found");

          return {
            threadId: input.threadId,
            proofs: input.selectors.map(
              (_selector, index) => proofs[index] ?? { status: "missing" },
            ),
          };
        },
        get: async ({ threadId }) => {
          if (threadId !== "thread-1") throw new Error("Chat not found");

          return makeThreadResponse({ id: threadId });
        },
        events: {
          list: async (input) => {
            if (input.types?.includes("item/completed")) await beforeReplies?.();

            if (Number(input.limit) > failAbove)
              throw Object.assign(new Error("withheld"), { status: 413 });

            if (!input.types) {
              const seq = Math.max(maxSeq, ...events.map((row) => row.seq));

              return seq === 0
                ? []
                : [
                    {
                      id: "cursor",
                      threadId: "thread-1",
                      seq,
                      scope: { kind: "turn", turnId: "cursor-turn" },
                      type: "turn/started",
                      data: { providerThreadId: "provider-1" },
                      createdAt: 0,
                    },
                  ];
            }

            return events
              .filter(
                (row) =>
                  row.threadId === input.threadId &&
                  (!input.types || input.types.includes(row.type)) &&
                  (input.beforeSeq === undefined || row.seq < Number(input.beforeSeq)) &&
                  (input.afterSeq === undefined || row.seq > Number(input.afterSeq)),
              )
              .sort((a, b) => (input.order === "asc" ? a.seq - b.seq : b.seq - a.seq))
              .slice(0, Number(input.limit));
          },
        },
      },
    },
  });

  plugin(host.api);
  hosts.push(host);

  return {
    ...host,
    events,
    setProofs(value: typeof proofs) {
      proofs = value;
    },
    setMaxSeq(value: number) {
      maxSeq = value;
    },
    failAbove(value: number) {
      failAbove = value;
    },
    beforeReplies(value: () => Promise<void>) {
      beforeReplies = value;
    },
    async save(value: CardInput = card()) {
      await host.harness.callAgentTool("glance_set", value, { threadId: "thread-1" });
    },
    async get() {
      return rpcContract["card.get"].output.parse(
        await host.harness.callRpc("card.get", { threadId: "thread-1" }),
      );
    },
    async diff() {
      return cardDiffSchema.parse(
        await host.harness.callRpc("card.diff", { threadId: "thread-1" }),
      );
    },
    async seen(revision: number, conversationSeq: number) {
      return host.harness.callRpc("card.markSeen", {
        threadId: "thread-1",
        revision,
        conversationSeq,
      });
    },
  };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("Glance server", () => {
  it("reads legacy decision cards as status without changing their stored revisions", async () => {
    const test = fixture();
    await test.save({ ...card(), status: "needs-you", next: "Sam answers the native form" });

    const legacy = JSON.stringify({
      ...cardSchema.parse({ ...card(), status: "needs-you" }),
      ask: { question: "Legacy choice?", options: ["A", "B"], recommended: "A" },
    });

    const database = test.api.storage.database();
    database.prepare("UPDATE cards SET card_json = ? WHERE thread_id = ?").run(legacy, "thread-1");
    database
      .prepare("UPDATE card_revisions SET card_json = ? WHERE thread_id = ?")
      .run(legacy, "thread-1");
    const first = await test.get();
    expect(first.view?.card).toMatchObject({ status: "needs-you", headline: card().headline });
    expect(first.view?.card).not.toHaveProperty("ask");
    await test.seen(first.view!.revision, first.conversationSeq);
    await test.save({ ...card("The native question is answered"), status: "done" });
    expect((await test.diff()).changes.map((entry) => entry.field)).not.toContain("ask");
    const index = await test.harness.callRpc("cards.index", null);
    expect(index).toMatchObject({ cards: [{ status: "done" }] });
    expect(
      database.prepare("SELECT card_json FROM card_revisions WHERE revision = 1").get(),
    ).toEqual({ card_json: legacy });
  });

  it("logs safe refresh diagnostics once through the existing index RPC and keeps null clients working", async () => {
    const test = fixture();

    const diagnostic = {
      id: "6bcb5a75-59fd-40aa-a2ad-71e11e95d1b9",
      occurredAt: 1000,
      elapsedMs: 250,
      status: 503,
      stage: "http",
      name: "Error",
      code: "handler_error",
      online: true,
      visibility: "visible",
      clientBundle: "app-build.js",
      pluginBundle: "df7ee0d482c84b3c",
    };

    expect(await test.harness.callRpc("cards.index", null)).toEqual({ cards: [] });
    await test.harness.callRpc("cards.index", { diagnostic });
    await test.harness.callRpc("cards.index", { diagnostic });
    const failures = test.harness.inspection.logEntries.filter((entry) => entry.level === "warn");
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0]!.message)).toEqual({ event: "refresh-failure", ...diagnostic });
    expect(
      rpcContract["cards.index"].input.safeParse({
        diagnostic: { ...diagnostic, message: "private fixture text" },
      }).success,
    ).toBe(false);
    expect(
      rpcContract["cards.index"].input.safeParse({
        diagnostic: { ...diagnostic, clientBundle: "https://private.invalid/path" },
      }).success,
    ).toBe(false);
    expect(
      rpcContract["cards.index"].input.safeParse({
        diagnostic: { ...diagnostic, code: "private-code" },
      }).success,
    ).toBe(false);
  });

  it("persists completed sidebar outcomes through CLI, index, reload and revision diff", async () => {
    const test = fixture();

    await test.save({ ...card(), status: "done" });
    const initial = await test.get();

    expect(initial.view).not.toBeNull();
    await test.seen(1, initial.conversationSeq);

    const outcome = {
      ...card(),
      status: "done",
      sidebarSummary: "Private .52 installed · all targets",
    };

    const saved = await test.harness.runCli([
      "set",
      "--chat",
      "thread-1",
      "--card",
      JSON.stringify(outcome),
      "--json",
    ]);

    expect(saved.exitCode).toBe(0);
    const reloaded = new GlanceService(test.api);

    expect((await reloaded.get("thread-1")).view?.card.sidebarSummary).toBe(outcome.sidebarSummary);
    expect(reloaded.index().cards[0]?.sidebarSummary).toBe(outcome.sidebarSummary);
    expect((await test.diff()).changes).toContainEqual({
      field: "sidebarSummary",
      label: "Sidebar outcome",
      before: null,
      after: outcome.sidebarSummary,
    });
    await test.save({ ...card(), status: "done" });
    expect(reloaded.index().cards[0]?.sidebarSummary).toBeNull();
  });

  it("persists the original goal through CLI, index, reload, human output and revision diff", async () => {
    const test = fixture();

    await test.save(card());
    const initial = await test.get();

    await test.seen(1, initial.conversationSeq);
    expect(new GlanceService(test.api).index().cards[0]?.goal).toBeNull();

    const withGoal = {
      ...card(),
      goal: "Redesign the Glance card around goal, status and next step",
      next: "The agent installs the new card",
    };

    const saved = await test.harness.runCli([
      "set",
      "--chat",
      "thread-1",
      "--card",
      JSON.stringify(withGoal),
    ]);

    expect(saved.exitCode).toBe(0);
    expect(saved.stdout.split("\n").slice(0, 3)).toEqual([
      `Goal: ${withGoal.goal}`,
      `Now: ${withGoal.status} · ${withGoal.headline}`,
      `Next: ${withGoal.next}`,
    ]);

    const reloaded = new GlanceService(test.api);

    expect((await reloaded.get("thread-1")).view?.card.goal).toBe(withGoal.goal);
    expect(reloaded.index().cards[0]?.goal).toBe(withGoal.goal);
    expect((await test.diff()).changes).toContainEqual({
      field: "goal",
      label: "Goal",
      before: null,
      after: withGoal.goal,
    });
    expect(() => cardSchema.parse({ ...withGoal, goal: "G".repeat(121) })).toThrow();

    await test.save({ ...card(), headline: "Later update without a goal" });
    expect((await test.get()).view?.card.goal).toBe(withGoal.goal);
    expect((await test.diff()).changes.some((change) => change.field === "goal")).toBe(true);
    await test.save({ ...card(), goal: "Ship the redesign to every chat" });
    expect(new GlanceService(test.api).index().cards[0]?.goal).toBe(
      "Ship the redesign to every chat",
    );
  });

  it("persists compact proof facts and keeps missing or ambiguous executions unlinked", async () => {
    const test = fixture();
    test.setProofs([
      {
        status: "matched",
        execution: {
          eventSeq: 3,
          command: "actual failed command",
          exitCode: 1,
          status: "failed",
          cwd: "/workspace",
          excerpt: "Failure output",
        },
      },
      { status: "missing" },
      { status: "ambiguous" },
    ]);
    await test.save({
      ...card(),
      proof: [
        { claim: "Source inspected", kind: "inspected", ref: "contract.ts" },
        {
          claim: "Selected failed run",
          kind: "reproduced",
          command: "provided description",
          eventSeq: 3,
        },
        { claim: "Missing run", kind: "reproduced", command: "missing command" },
        { claim: "Ambiguous run", kind: "reproduced", command: "ambiguous command" },
      ],
    });
    expect(test.harness.sdk.callsTo("threads.events.list")).toHaveLength(0);
    const result = await test.get();
    expect(result.view?.proofs.map((entry) => entry.linked)).toEqual([false, true, false, false]);
    expect(result.view?.proofs[1]).toMatchObject({
      eventSeq: 3,
      command: "actual failed command",
      exitCode: 1,
      status: "failed",
      cwd: "/workspace",
      excerpt: "Failure output",
      excerptUnavailable: false,
    });
    test.setProofs([]);
    expect((await test.get()).view?.proofs[1]?.command).toBe("actual failed command");
  });

  it("halves oversized reply-history pages", async () => {
    const test = fixture();
    await test.save();
    const first = await test.get();
    await test.seen(first.view!.revision, first.conversationSeq);
    test.events.push(reply(1, "Later reply"));
    test.failAbove(25);
    const before = test.harness.sdk.callsTo("threads.events.list").length;
    expect(await test.diff()).toMatchObject({ newReplies: 1 });
    expect(
      test.harness.sdk
        .callsTo("threads.events.list")
        .slice(before + 1, before + 4)
        .map((call) => call[0]),
    ).toMatchObject([{ limit: "100" }, { limit: "50" }, { limit: "25" }]);
  });

  it("keeps the last seen baseline beyond 50 writes and reports bounded new messages", async () => {
    const test = fixture();

    test.setMaxSeq(5);
    await test.save(card("Original headline"));
    const first = await test.get();

    await test.seen(first.view!.revision, first.conversationSeq);

    for (let index = 0; index < 55; index += 1) await test.save(card(`New headline ${index}`));

    for (let seq = 6; seq <= 110; seq += 1) test.events.push(reply(seq, `Message ${seq}`));
    test.setMaxSeq(110);
    const result = await test.diff();

    expect(result).toMatchObject({
      seenRevision: 1,
      revision: 56,
      conversationSeq: 110,
      newReplies: 100,
      moreActivity: true,
    });
    expect(result.changes).toContainEqual({
      field: "headline",
      label: "Now",
      before: "Original headline",
      after: "New headline 54",
    });

    const revisions = test.api.storage
      .database()
      .prepare("SELECT revision FROM card_revisions ORDER BY revision")
      .all();

    expect(revisions).toHaveLength(51);
    expect(revisions[0]).toEqual({ revision: 1 });
  });

  it("finishes a history read when another view acknowledges and prunes its baseline", async () => {
    const test = fixture();

    test.setMaxSeq(5);
    await test.save(card("Original headline"));
    const first = await test.get();

    await test.seen(first.view!.revision, first.conversationSeq);

    for (let index = 0; index < 55; index += 1) await test.save(card(`New headline ${index}`));
    const latest = await test.get();

    test.events.push(reply(6, "New reply"));
    test.setMaxSeq(6);
    let release!: () => void;
    let entered!: () => void;

    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const history = new Promise<void>((resolve) => {
      release = resolve;
    });

    test.beforeReplies(async () => {
      entered();
      await history;
    });
    const pending = test.diff();

    await waiting;
    await test.seen(latest.view!.revision, latest.conversationSeq);
    expect(
      test.api.storage
        .database()
        .prepare("SELECT revision FROM card_revisions WHERE revision = 1")
        .get(),
    ).toBeUndefined();
    release();

    await expect(pending).resolves.toMatchObject({
      seenRevision: 1,
      revision: 56,
      conversationSeq: 6,
      newReplies: 1,
      changes: [{ field: "headline", before: "Original headline", after: "New headline 54" }],
    });
    expect(await test.diff()).toMatchObject({ seenRevision: 56, newReplies: 1 });
  });

  it("acknowledges captured snapshots without consuming later messages or regressing seen state", async () => {
    const test = fixture();

    await test.save(card("First"));
    test.setMaxSeq(10);
    const first = await test.get();

    const reloaded = new GlanceService(test.api);

    reloaded.markSeen("thread-1", first.view!.revision, first.conversationSeq);
    test.events.push(reply(11, "A new reply"));
    test.setMaxSeq(11);
    await test.seen(first.view!.revision, first.conversationSeq);
    expect((await test.diff()).newReplies).toBe(1);
    await test.save(card("Second"));
    const second = await test.get();

    await test.seen(second.view!.revision, second.conversationSeq);
    await test.seen(first.view!.revision, first.conversationSeq);
    expect(await test.diff()).toMatchObject({ seenRevision: 2, newReplies: 0 });
    await expect(test.seen(2, 999)).rejects.toThrow("Refresh");
  });

  it("counts each completed reply once and labels an exhausted event scan as more activity", async () => {
    const test = fixture();

    await test.save();
    const first = await test.get();

    await test.seen(first.view!.revision, first.conversationSeq);
    const duplicate = reply(2, "Updated same reply");

    if (duplicate.type === "item/completed") duplicate.data.item.id = "reply-1";
    test.events.push(reply(1, "Original reply"), duplicate);
    expect(await test.diff()).toMatchObject({ newReplies: 1, moreActivity: false });
    test.events.length = 0;

    for (let seq = 1; seq <= 500; seq += 1) test.events.push(command(seq, `echo ${seq}`));
    test.events.push(reply(501, "Beyond the bounded scan"));
    expect(await test.diff()).toMatchObject({ newReplies: 0, moreActivity: true });
  });

  it("starts with no diff and reports meaningful card field changes", async () => {
    const test = fixture();

    await test.save(card());
    expect(await test.diff()).toMatchObject({ changes: [], seenRevision: null, newReplies: 0 });
    const current = await test.get();

    await test.seen(current.view!.revision, current.conversationSeq);
    await test.save({
      status: "needs-you",
      phase: "ship",
      headline: "Choose the delivery",
      facts: [{ label: "Checks", value: "Passed" }],
      deliverables: [{ title: "Report", href: "docs/report.md" }],
      proof: [{ claim: "Source inspected", kind: "inspected" }],
      next: "Sam chooses the version",
    });
    const result = await test.diff();

    expect(result.changes.map((entry) => entry.field)).toEqual([
      "headline",
      "status",
      "phase",
      "next",
      "facts",
      "deliverables",
      "proof",
    ]);
  });

  it("marks a card stale after a later turn, clears on write, and removes all thread state on deletion", async () => {
    const test = fixture();

    await test.save();
    test.events.push({
      id: "turn-start",
      seq: 200,
      threadId: "thread-1",
      scope: { kind: "turn", turnId: "turn-2" },
      type: "turn/started",
      data: { providerThreadId: "provider-1" },
      createdAt: Date.now() + 1,
    });
    expect(
      (
        await test.harness.emitThreadEvent("thread.idle", {
          thread: makeThreadResponse(),
          lastAssistantText: null,
        })
      ).errors,
    ).toEqual([]);
    expect((await test.get()).view?.staleSince).not.toBeNull();
    await test.save(card("Fresh"));
    expect((await test.get()).view?.staleSince).toBeNull();
    const current = await test.get();

    await test.seen(current.view!.revision, current.conversationSeq);
    await test.harness.emitThreadEvent("thread.deleted", { thread: makeThreadResponse() });
    expect(await test.harness.callRpc("cards.index", null)).toEqual({ cards: [] });

    for (const table of ["cards", "card_revisions", "proofs", "seen", "card_captures"])
      expect(
        test.api.storage.database().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toEqual({ count: 0 });
    await expect(test.get()).rejects.toThrow("deleted");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(test.harness.realtimeSignals.at(-1)).toMatchObject({
      channel: "glance-changed",
      payload: { threadId: "thread-1", revision: 0, entry: null },
    });
  });

  it("supports the CLI's current/explicit chat modes and validates untrusted IDs before state writes", async () => {
    const test = fixture();
    const serialized = JSON.stringify(cardSchema.parse(card("CLI card")));

    expect((await test.harness.runCli(["show", "--json"])).exitCode).toBe(1);
    expect(
      (await test.harness.runCli(["set", "--card", serialized, "--json"], { threadId: "missing" }))
        .exitCode,
    ).toBe(1);
    expect(await test.harness.callRpc("cards.index", null)).toEqual({ cards: [] });
    expect(
      (await test.harness.runCli(["set", "--chat", "thread-1", "--card", serialized, "--json"]))
        .exitCode,
    ).toBe(0);

    const plain = await test.harness.runCli(["show", "thread-1"]);
    const json = await test.harness.runCli(["show", "thread-1", "--json"]);

    expect(plain.stdout).toContain("working · CLI card");
    expect(json.stdout).not.toBe(plain.stdout);
    expect(JSON.parse(json.stdout)).toMatchObject({ view: { revision: 1 } });

    for (const argv of [
      ["show", ".", "--json"],
      ["diff", "thread-1", "--json"],
      ["list", "--json"],
    ])
      expect((await test.harness.runCli(argv, { threadId: "thread-1" })).exitCode).toBe(0);
    expect(
      (await test.harness.runCli(["set", "--card-stdin"], { threadId: "thread-1" })).stderr,
    ).toContain("omnyo CLI");
    await expect(
      test.harness.callAgentTool("glance_show", {}, { threadId: "missing" }),
    ).rejects.toThrow("Chat not found");
  });
});

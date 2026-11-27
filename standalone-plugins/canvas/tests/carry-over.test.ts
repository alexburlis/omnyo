import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { MessageDispatchHookContext } from "@omnyo/plugin-sdk";
import { boardSchema, modeSchema } from "../contract.ts";
import plugin, { instructions, offer } from "../server.ts";

const hosts: FakePluginHost[] = [];

const boardResultSchema = z.object({ board: boardSchema.nullable() });

const sourceRowsSchema = z.array(z.object({ id: z.string() }));

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

type ThreadOverrides = Partial<MessageDispatchHookContext["thread"]>;

function setup() {
  const host = createFakePluginHost({ pluginId: "canvas" });
  hosts.push(host);
  plugin(host.api);

  const { registrations } = host.harness;

  async function cli(args: string[], threadId: string) {
    const result = await host.harness.runCli(args, { threadId });

    expect(result.exitCode, result.stderr).toBe(0);

    return result;
  }

  async function board(threadId: string, ids: string[]) {
    await cli(["on"], threadId);
    await cli(
      [
        "add",
        "--input",
        JSON.stringify({ nodes: ids.map((id) => ({ id, kind: "note", title: id })) }),
      ],
      threadId,
    );
  }

  async function source(threadId: string, id: string) {
    await cli(
      ["source", "--input", JSON.stringify({ id, title: id, provider: "manual" })],
      threadId,
    );
  }

  async function dispatch(
    threadId: string,
    text: string,
    thread: ThreadOverrides = {},
    attempt: MessageDispatchHookContext["attempt"] = "start-turn",
  ) {
    const handler = registrations.hooks["message.dispatch"];

    if (handler === null) throw new Error("No dispatch hook registered");

    return handler(
      makeMessageDispatchHookContext({
        attempt,
        thread: {
          id: threadId,
          status: "pending",
          parentThreadId: null,
          visibility: "visible",
          ...thread,
        },
        input: { text, blocks: [{ type: "text", text, mentions: [] }] },
      }),
    );
  }

  async function mode(threadId: string) {
    return modeSchema.parse(await host.harness.callRpc("mode.get", { threadId }));
  }

  async function nodes(threadId: string) {
    const result = boardResultSchema.parse(await host.harness.callRpc("board.get", { threadId }));

    return result.board?.nodes.map((node) => node.id) ?? null;
  }

  function sources(threadId: string) {
    return sourceRowsSchema
      .parse(
        host.api.storage
          .database()
          .prepare("SELECT id FROM canvas_sources WHERE thread_id = ? ORDER BY id")
          .all(threadId),
      )
      .map((row) => row.id);
  }

  async function configure(threadId: string) {
    const provider = registrations.agentConfigurationProvider;

    if (provider === null) throw new Error("No configuration provider");

    return provider(makePluginAgentConfigurationContext({ thread: { id: threadId } }));
  }

  async function remove(threadId: string) {
    return host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: threadId }),
    });
  }

  return { host, cli, board, source, dispatch, mode, nodes, sources, configure, remove };
}

const proceed = { action: "proceed" };

describe("carrying a board into the chat that continues it", () => {
  it("moves the board before the first turn and points the old chat at it", async () => {
    const test = setup();
    await test.board("thr_old", ["headline", "clicks", "trend"]);
    await test.source("thr_old", "traffic");

    expect(await test.dispatch("thr_new", "Continue from @thread:thr_old\n\nKeep going")).toEqual(
      proceed,
    );

    expect(await test.mode("thr_new")).toMatchObject({ canvas: true, movedTo: null });
    expect(await test.mode("thr_old")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: "thr_new",
    });
    expect(await test.nodes("thr_new")).toEqual(["headline", "clicks", "trend"]);
    expect(await test.nodes("thr_old")).toBeNull();
    expect(test.sources("thr_new")).toEqual(["traffic"]);
    expect(test.sources("thr_old")).toEqual([]);
    expect(await test.configure("thr_new")).toMatchObject({ instructions });
    expect(await test.configure("thr_old")).toMatchObject({ instructions: offer, tools: [] });

    expect(await test.dispatch("thr_new", "Continue from @thread:thr_old\n\nKeep going")).toEqual(
      proceed,
    );
    expect(await test.nodes("thr_new")).toEqual(["headline", "clicks", "trend"]);

    const stale = await test.host.harness.runCli(
      ["add", "--input", JSON.stringify({ nodes: [{ id: "late", kind: "note", title: "Late" }] })],
      { threadId: "thr_old" },
    );

    expect(stale.exitCode).not.toBe(0);
    expect(stale.stderr).toContain("its board moved to chat thr_new");
  });

  it("keeps a board that was fully seen marked as seen", async () => {
    const test = setup();
    await test.board("thr_old", ["headline"]);

    const { revision } = boardSchema.parse(
      boardResultSchema.parse(await test.host.harness.callRpc("board.get", { threadId: "thr_old" }))
        .board,
    );

    await test.host.harness.callRpc("board.markSeen", { threadId: "thr_old", revision });
    await test.dispatch("thr_new", "Continue from @thread:thr_old");

    expect(await test.mode("thr_new")).toMatchObject({ canvas: true, unseen: false });
  });

  it("leaves the board alone unless a new top-level chat starts by continuing a chat with Canvas on", async () => {
    const test = setup();
    await test.board("thr_old", ["headline"]);

    const misses: [string, string, ThreadOverrides, MessageDispatchHookContext["attempt"]][] = [
      ["thr_idle", "Continue from @thread:thr_old", { status: "idle" }, "start-turn"],
      ["thr_child", "Continue from @thread:thr_old", { parentThreadId: "thr_old" }, "start-turn"],
      ["thr_hidden", "Continue from @thread:thr_old", { visibility: "hidden" }, "start-turn"],
      ["thr_join", "Continue from @thread:thr_old", {}, "join-turn"],
      ["thr_asked", "Please continue from @thread:thr_old", {}, "start-turn"],
      ["thr_later", "See @thread:thr_old\n\nContinue from @thread:thr_old", {}, "start-turn"],
      ["thr_typo", "Continue from @thread:thr_older", {}, "start-turn"],
    ];

    for (const [threadId, text, thread, attempt] of misses) {
      expect(await test.dispatch(threadId, text, thread, attempt)).toEqual(proceed);
      expect((await test.mode(threadId)).canvas, threadId).toBe(false);
    }

    expect(await test.nodes("thr_old")).toEqual(["headline"]);

    await test.cli(["off"], "thr_old");
    await test.dispatch("thr_new", "Continue from @thread:thr_old");

    expect((await test.mode("thr_new")).canvas).toBe(false);
    expect((await test.mode("thr_old")).movedTo).toBeNull();

    await test.cli(["on"], "thr_old");

    expect(await test.nodes("thr_old")).toEqual(["headline"]);
  });

  it("still sends the message and changes neither chat when the move fails", async () => {
    const test = setup();
    await test.board("thr_old", ["headline"]);
    await test.source("thr_old", "traffic");
    await test.cli(["on"], "thr_new");
    await test.source("thr_new", "leftover");
    await test.cli(["off"], "thr_new");

    expect(await test.dispatch("thr_new", "Continue from @thread:thr_old")).toEqual(proceed);

    expect(test.host.harness.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining("already has Canvas sources"),
    });
    expect(await test.mode("thr_new")).toMatchObject({ canvas: false });
    expect(await test.mode("thr_old")).toMatchObject({ canvas: true, movedTo: null });
    expect(await test.nodes("thr_old")).toEqual(["headline"]);
    expect(test.sources("thr_old")).toEqual(["traffic"]);
  });

  it("returns the board when the chat holding it is deleted, along a chain of continuations", async () => {
    const test = setup();
    await test.board("thr_a", ["headline", "clicks"]);
    await test.source("thr_a", "traffic");
    await test.dispatch("thr_b", "Continue from @thread:thr_a");
    await test.dispatch("thr_c", "Continue from @thread:thr_b");

    expect((await test.mode("thr_a")).movedTo).toBe("thr_c");
    expect((await test.mode("thr_b")).movedTo).toBe("thr_c");

    expect((await test.remove("thr_c")).errors).toEqual([]);
    expect(await test.mode("thr_b")).toMatchObject({ canvas: true, movedTo: null });
    expect(await test.nodes("thr_b")).toEqual(["headline", "clicks"]);
    expect(test.sources("thr_b")).toEqual(["traffic"]);
    expect((await test.mode("thr_a")).movedTo).toBe("thr_b");

    await test.remove("thr_b");

    expect(await test.mode("thr_a")).toMatchObject({ canvas: true, movedTo: null });
    expect(await test.nodes("thr_a")).toEqual(["headline", "clicks"]);
    expect(test.sources("thr_a")).toEqual(["traffic"]);
  });

  it("deletes the board with its chat once the old chat has a board of its own", async () => {
    const test = setup();
    await test.board("thr_old", ["headline"]);
    await test.dispatch("thr_new", "Continue from @thread:thr_old");
    await test.board("thr_old", ["fresh"]);

    expect((await test.mode("thr_old")).movedTo).toBeNull();

    await test.remove("thr_new");

    expect(await test.nodes("thr_old")).toEqual(["fresh"]);
    expect(await test.nodes("thr_new")).toBeNull();
    expect((await test.mode("thr_new")).canvas).toBe(false);
  });

  it("drops the old chat's pointer when a chat holding a turned-off board is deleted", async () => {
    const test = setup();
    await test.board("thr_old", ["headline"]);
    await test.dispatch("thr_new", "Continue from @thread:thr_old");
    await test.cli(["off"], "thr_new");
    await test.remove("thr_new");

    expect(await test.mode("thr_old")).toMatchObject({ canvas: false, movedTo: null });
  });
});

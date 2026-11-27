import { describeBoard } from "../lib/agent-presentation.ts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import sharp from "sharp";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import type { JsonValue } from "@omnyo/plugin-sdk";
import {
  boardSchema,
  composeInputSchema,
  modeSchema,
  nodeInspectionSchema,
  toolNames,
  type Board,
  type FlowItem,
} from "../contract.ts";
import { CanvasService } from "../lib/service.ts";
import { sourceInputSchema } from "../source-contract.ts";
import plugin, { instructions, introduction, offer } from "../server.ts";

const hosts: FakePluginHost[] = [];

const boardResultSchema = z.object({ board: boardSchema.nullable() });

const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
  .png()
  .toBuffer();

const mp4 = Buffer.concat([
  Buffer.from([0, 0, 0, 24]),
  Buffer.from("ftypisom", "ascii"),
  Buffer.alloc(88, 2),
]);

function fixture() {
  const reads: string[] = [];

  const host = createFakePluginHost({
    pluginId: "canvas",
    sdk: {
      threads: {
        get: async ({ threadId }) => makeThreadResponse({ id: threadId, environmentId: "env-1" }),
      },
      environments: {
        get: async () => ({ id: "env-1", hostId: "host-1", path: "/work" }),
      },
      files: {
        read: async ({ path }) => {
          reads.push(path);

          const bytes = path.endsWith(".mp4")
            ? mp4
            : path.endsWith(".txt")
              ? Buffer.from("hi")
              : png;

          return {
            path,
            content: bytes.toString("base64"),
            contentEncoding: "base64",
            sizeBytes: bytes.length,
          };
        },
      },
    },
  });

  plugin(host.api);
  hosts.push(host);

  const registrations = host.harness.registrations;

  async function dispatch(threadId: string, status: "pending" | "idle", withMention: boolean) {
    const handler = registrations.hooks["message.dispatch"];

    if (handler === null) throw new Error("No dispatch hook registered");

    return handler(
      makeMessageDispatchHookContext({
        thread: { id: threadId, status },
        input: {
          text: "Fix the thread list",
          blocks: [
            {
              type: "text",
              text: "Canvas Fix the thread list",
              mentions: withMention
                ? [
                    {
                      start: 0,
                      end: 6,
                      resource: {
                        kind: "plugin",
                        pluginId: "canvas",
                        itemId: "mode:canvas",
                        label: "Canvas",
                      },
                    },
                  ]
                : [],
            },
          ],
        },
      }),
    );
  }

  async function tool(name: string, input: JsonValue, threadId = "thread-1") {
    const record = registrations.agentTools.find((entry) => entry.name === name);

    if (record === undefined) throw new Error(`No tool ${name}`);

    const parsed = record.parse(input);

    if (!parsed.ok) throw new Error(parsed.error);

    return record.execute(parsed.value, {
      threadId,
      projectId: "project-1",
      signal: new AbortController().signal,
    });
  }

  async function board(threadId = "thread-1"): Promise<Board | null> {
    const result = await host.harness.callRpc("board.get", { threadId });

    return boardResultSchema.parse(result).board;
  }

  async function mode(threadId: string) {
    return modeSchema.parse(await host.harness.callRpc("mode.get", { threadId }));
  }

  function configure(threadId: string) {
    const provider = registrations.agentConfigurationProvider;

    if (provider === null) throw new Error("No configuration provider");

    return provider(makePluginAgentConfigurationContext({ thread: { id: threadId } }));
  }

  return { host, dispatch, tool, board, mode, configure, reads };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("canvas mode", () => {
  it("turns Canvas on from any dispatch that carries the Canvas pill", async () => {
    const test = fixture();

    await test.dispatch("plain", "pending", false);
    await test.dispatch("plain-later", "idle", false);
    await test.dispatch("existing", "idle", true);
    expect(await test.dispatch("thread-1", "pending", true)).toEqual({ action: "proceed" });

    expect(await test.mode("thread-1")).toEqual({
      canvas: true,
      unseen: false,
      startedBy: "user",
      movedTo: null,
    });
    expect(await test.mode("existing")).toEqual({
      canvas: true,
      unseen: false,
      startedBy: "user",
      movedTo: null,
    });
    expect(await test.mode("plain")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });
    expect(await test.mode("plain-later")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });
  });

  it("resolves conversation context only for an existing conversation node", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.host.harness.callRpc("node.add", {
      threadId: "thread-1",
      nodes: [{ id: "prompt-one", kind: "note", conversation: { id: "prompt-one" } }],
    });

    const provider = test.host.harness.registrations.mentionProviders.find(
      (entry) => entry.id === "conversation",
    );

    expect(provider).toBeDefined();
    expect(await provider?.resolve("thread-1.prompt-one")).toMatchObject({
      context: expect.stringContaining("#canvas-node-MODULE_ID"),
    });
    await expect(async () => provider?.resolve("thread-1.missing")).rejects.toThrow(
      "no longer exists",
    );
  });

  it("sends the board introduction with the Canvas pill", async () => {
    const test = fixture();

    const provider = test.host.harness.registrations.mentionProviders.find(
      (entry) => entry.id === "mode",
    );

    const resolved = await provider?.resolve("canvas");

    expect(resolved?.context).toBe(introduction);
    expect(introduction).toContain("Canvas is now on");
    expect(introduction).toContain("canvas_show");
    expect(introduction).toContain("For dashboards, use canvas_compose by default");
    expect(introduction).toContain("omnyo canvas add --input-stdin");
    expect(introduction).toContain("Do not add goal, status or progress notes");
    expect(introduction).not.toMatch(/goal node|status node|"now"/u);
  });

  it("gives canvas tools, skill and instructions only to Canvas chats", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);

    const canvas = test.configure("thread-1");

    expect(canvas.tools).toEqual(Object.values(toolNames));
    expect(canvas.skills).toEqual(["canvas", "canvas-style"]);
    expect(canvas.instructions).toBe(instructions);
    expect(canvas.instructions).toContain("For dashboards, use canvas_compose by default");
    expect(canvas.instructions).toContain("keep primary evidence and useful comparisons visible");
    expect(canvas.instructions).toContain("group modules into islands");
    expect(canvas.instructions).toContain('flow "bento"');
    expect(canvas.instructions).toContain("canvas_verify({island})");
    expect(instructions.length).toBeLessThanOrEqual(4096);
    expect(test.configure("plain")).toEqual({ tools: [], skills: [], instructions: offer });
  });

  it("lets every other chat's agent turn Canvas on itself through the brief", () => {
    expect(offer.length).toBeLessThanOrEqual(1024);
    expect(offer).toContain("omnyo canvas on");
    expect(offer).toContain("omnyo canvas compose with flow groups by default for dashboards");
    expect(offer).toContain("question-led islands");
    expect(offer).toContain("omnyo canvas move-from <that chat>");
    expect(offer).toContain("Leave Canvas off for quick questions");
    expect(offer).not.toContain("canvas_");
  });

  it("refuses board writes while Canvas is off", async () => {
    const test = fixture();

    await expect(
      test.tool(toolNames.add, { nodes: [{ kind: "note", title: "Hi" }] }, "plain"),
    ).rejects.toThrow(/Canvas is off for this chat/u);
    expect(await test.board("plain")).toBeNull();
  });

  it("returns the change ID of each panel move, pin and hide so Omnyo can undo exactly that change", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "idle", true);
    await test.tool(toolNames.add, { nodes: [{ id: "goal", kind: "note", title: "Goal" }] });

    for (const [method, input] of [
      ["node.move", { threadId: "thread-1", id: "goal", position: { x: 40, y: 80 } }],
      ["node.pin", { threadId: "thread-1", id: "goal", pinned: true }],
      ["node.archive", { threadId: "thread-1", id: "goal" }],
    ] as const) {
      const result = await test.host.harness.callRpc(method, input);

      expect(result).toMatchObject({ changeId: expect.any(String) });
    }
  });

  it("turns Canvas off and back on, keeping the board", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "idle", true);
    await test.tool(toolNames.add, { nodes: [{ id: "goal", kind: "note", title: "Goal" }] });

    expect(await test.host.harness.callRpc("mode.off", { threadId: "thread-1" })).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });
    expect(await test.mode("thread-1")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });
    expect(await test.board()).toBeNull();
    expect(test.configure("thread-1")).toEqual({ tools: [], skills: [], instructions: offer });
    await expect(test.tool(toolNames.update, { id: "goal", title: "Changed" })).rejects.toThrow(
      /Canvas is off/u,
    );

    await test.dispatch("thread-1", "idle", true);

    expect((await test.board())?.nodes.map((node) => node.title)).toEqual(["Goal"]);
    expect(test.configure("thread-1").tools).toEqual(Object.values(toolNames));
  });

  it("reports unseen board changes until the user has looked", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ kind: "note", title: "One" }] });

    expect(await test.mode("thread-1")).toEqual({
      canvas: true,
      unseen: true,
      startedBy: "user",
      movedTo: null,
    });

    await test.host.harness.callRpc("board.markSeen", { threadId: "thread-1", revision: 1 });

    expect(await test.mode("thread-1")).toEqual({
      canvas: true,
      unseen: false,
      startedBy: "user",
      movedTo: null,
    });
  });

  it("publishes a change once the user has looked so unseen marks clear", async () => {
    const test = fixture();
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ kind: "note", title: "One" }] });
    await settle();
    const before = test.host.harness.realtimeSignals.length;

    await test.host.harness.callRpc("board.markSeen", { threadId: "thread-1", revision: 1 });
    await settle();

    expect(test.host.harness.realtimeSignals.slice(before)).toEqual([
      { channel: "canvas.changed", payload: { threadId: "thread-1", revision: 1 } },
    ]);

    await test.host.harness.callRpc("board.markSeen", { threadId: "thread-1", revision: 1 });
    await settle();

    expect(test.host.harness.realtimeSignals.length).toBe(before + 1);
  });

  it("turns Canvas on from the invoking chat's CLI and off for any chat", async () => {
    const test = fixture();

    const on = await test.host.harness.runCli(["on"], { threadId: "thread-1" });

    expect(on.exitCode).toBe(0);
    expect(on.stdout).toBe(introduction);
    expect(await test.mode("thread-1")).toEqual({
      canvas: true,
      unseen: false,
      startedBy: "agent",
      movedTo: null,
    });

    const other = await test.host.harness.runCli(["on", "thread-2"], { threadId: "thread-1" });

    expect(other.exitCode).toBe(1);
    expect(other.stderr).toContain("inside the chat");
    expect(await test.mode("thread-2")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });

    const off = await test.host.harness.runCli(["off", "thread-1", "--json"]);

    expect(off.exitCode).toBe(0);
    expect(JSON.parse(off.stdout)).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });
    expect(await test.mode("thread-1")).toEqual({
      canvas: false,
      unseen: false,
      startedBy: null,
      movedTo: null,
    });

    await test.dispatch("thread-1", "idle", true);

    expect(await test.mode("thread-1")).toEqual({
      canvas: true,
      unseen: false,
      startedBy: "user",
      movedTo: null,
    });
  });

  it("publishes a change when Canvas turns on or off", async () => {
    const test = fixture();
    const signal = { channel: "canvas.changed", payload: { threadId: "thread-1", revision: 0 } };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

    await test.dispatch("thread-1", "idle", true);
    await settle();

    expect(test.host.harness.realtimeSignals).toEqual([signal]);

    await test.dispatch("thread-1", "idle", true);
    await test.host.harness.callRpc("mode.off", { threadId: "thread-1" });
    await test.host.harness.callRpc("mode.off", { threadId: "thread-1" });
    await settle();

    expect(test.host.harness.realtimeSignals).toEqual([signal, signal]);
  });
});

describe("board", () => {
  it("adds, places, updates, links and archives nodes in revisions", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, {
      nodes: [
        { id: "goal", kind: "note", title: "Goal", section: "Investigate", pinned: true },
        { id: "repro", kind: "status", title: "Reproduce", state: "running", progress: 0.2 },
        { id: "fix", kind: "decision", title: "Fix?", section: "Decide", options: ["A", "B"] },
      ],
    });
    await test.tool(toolNames.add, { nodes: [{ id: "flame", kind: "note", after: "goal" }] });
    await test.tool(toolNames.update, {
      id: "repro",
      state: "done",
      progress: 1,
      tone: "positive",
    });
    await test.tool(toolNames.link, { from: "goal", to: "fix", label: "decides" });

    let board = await test.board();

    expect(board?.sections).toEqual(["Investigate", "Decide"]);
    expect(board?.nodes.map((node) => node.id)).toEqual(["goal", "flame", "repro", "fix"]);
    expect(board?.nodes.find((node) => node.id === "flame")?.section).toBe("Investigate");
    expect(board?.nodes.find((node) => node.id === "repro")).toMatchObject({
      section: "Investigate",
      state: "done",
      progress: 1,
      tone: "positive",
      createdRevision: 1,
      updatedRevision: 3,
    });
    expect(board?.edges).toEqual([{ from: "goal", to: "fix", label: "decides" }]);
    expect(board?.revision).toBe(4);

    await test.tool(toolNames.archive, { ids: ["goal"] });
    board = await test.board();

    expect(board?.nodes.map((node) => node.id)).toEqual(["flame", "repro", "fix"]);
    expect(board?.edges).toEqual([]);
  });

  it("rejects duplicate ids, unknown references and invalid decisions", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ id: "goal", kind: "note" }] });

    await expect(
      test.tool(toolNames.add, { nodes: [{ id: "goal", kind: "note" }] }),
    ).rejects.toThrow(/already exists/u);
    await expect(test.tool(toolNames.update, { id: "missing", title: "x" })).rejects.toThrow(
      /No node "missing"/u,
    );
    await expect(
      test.tool(toolNames.add, {
        nodes: [{ kind: "decision", title: "Pick", options: ["A"], recommended: "B" }],
      }),
    ).rejects.toThrow(/recommended/u);
    await expect(test.tool(toolNames.link, { from: "goal", to: "goal" })).rejects.toThrow(
      /itself/u,
    );
    expect((await test.board())?.revision).toBe(1);
  });

  it("stores workspace images and serves them with passive headers", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);

    const result = JSON.parse(
      String(await test.tool(toolNames.image, { path: "shots/flame.png", title: "Flame" })),
    );

    expect(test.reads).toEqual(["/work/shots/flame.png"]);

    const node = (await test.board())?.nodes.find((entry) => entry.id === result.id);

    expect(node?.kind).toBe("image");
    expect(node?.assetId).toMatch(/^[a-f0-9]{64}$/u);

    const response = await test.host.harness.fetchHttp("GET", `/asset?id=${node?.assetId}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer()).equals(png)).toBe(true);
    expect((await test.host.harness.fetchHttp("GET", "/asset?id=../x")).status).toBe(400);
  });

  it("stores wide videos and serves byte ranges for playback", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);

    const result = JSON.parse(
      String(await test.tool(toolNames.image, { path: "rec/demo.mp4", title: "Demo" })),
    );

    const node = (await test.board())?.nodes.find((entry) => entry.id === result.id);

    expect(node).toMatchObject({ kind: "video", wide: true });

    const path = `/asset?id=${node?.assetId}`;
    const whole = await test.host.harness.fetchHttp("GET", path);

    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");

    const part = await test.host.harness.fetchHttp("GET", path, {
      headers: { Range: "bytes=4-11" },
    });

    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-11/${mp4.length}`);
    expect(Buffer.from(await part.arrayBuffer()).toString("ascii")).toBe("ftypisom");

    const tail = await test.host.harness.fetchHttp("GET", path, { headers: { Range: "bytes=-8" } });

    expect(Buffer.from(await tail.arrayBuffer()).equals(mp4.subarray(-8))).toBe(true);

    const beyond = await test.host.harness.fetchHttp("GET", path, {
      headers: { Range: `bytes=${mp4.length}-` },
    });

    expect(beyond.status).toBe(416);
    await expect(test.tool(toolNames.image, { path: "notes.txt" })).rejects.toThrow(/Unsupported/u);
  });

  it("lets the agent make a note wide and narrow again", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ id: "chart", kind: "note", title: "Chart" }] });
    expect((await test.board())?.nodes[0]?.wide).toBe(false);
    await test.tool(toolNames.update, { id: "chart", wide: true });
    expect((await test.board())?.nodes[0]?.wide).toBe(true);
  });

  it("keeps seen state monotonic and within the board revision", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ kind: "note", title: "One" }] });

    expect(
      await test.host.harness.callRpc("board.markSeen", { threadId: "thread-1", revision: 9 }),
    ).toEqual({
      seenRevision: 1,
    });
    expect(
      await test.host.harness.callRpc("board.markSeen", { threadId: "thread-1", revision: 0 }),
    ).toEqual({
      seenRevision: 1,
    });
  });

  it("keeps user positions until the agent moves a node to another section", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ id: "a", kind: "note", section: "One" }] });
    await test.host.harness.callRpc("node.move", {
      threadId: "thread-1",
      id: "a",
      position: { x: 40, y: 80 },
    });
    await test.tool(toolNames.update, { id: "a", title: "Renamed" });

    expect((await test.board())?.nodes[0]?.position).toEqual({ x: 40, y: 80 });

    await expect(test.tool(toolNames.update, { id: "a", section: "Two" })).rejects.toThrow(
      /human.*position/i,
    );

    const inspected = nodeInspectionSchema.parse(
      JSON.parse(String(await test.tool(toolNames.inspect, { id: "a" }))),
    );

    await test.tool(toolNames.edit, {
      id: "a",
      fields: { section: "Two" },
      expectedVersions: inspected.fieldVersions,
    });

    expect((await test.board())?.nodes[0]?.position).toBeNull();
  });

  it("publishes changes, describes the board and clears it when the chat is deleted", async () => {
    const test = fixture();

    await test.dispatch("thread-1", "pending", true);

    const cli = await test.host.harness.runCli([
      "add",
      "--chat",
      "thread-1",
      "--input",
      JSON.stringify({
        nodes: [{ id: "s", kind: "status", title: "Tests", state: "running", progress: 0.5 }],
      }),
    ]);

    expect(cli.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(test.host.harness.realtimeSignals.at(-1)).toEqual({
      channel: "canvas.changed",
      payload: { threadId: "thread-1", revision: 1 },
    });
    expect(describeBoard(await test.board())).toContain("- s (status, running, 50%) Tests");

    await test.host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-1" }),
    });

    expect(await test.board()).toBeNull();
    expect((await test.host.harness.runCli(["show", "thread-1"])).stdout).toBe(
      "Canvas is off for this chat.",
    );
  });
});

describe("flow composition", () => {
  it("saves composition through tool and RPC, recreates the service, and resets only referenced positions", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "idle", true);
    await test.tool(toolNames.add, {
      nodes: [
        { id: "chart", kind: "note", title: "Chart" },
        { id: "aside", kind: "note", title: "Aside" },
        { id: "later", kind: "note", title: "Later" },
      ],
    });
    await test.host.harness.callRpc("node.move", {
      threadId: "thread-1",
      id: "chart",
      position: { x: 91, y: 43 },
    });
    await test.host.harness.callRpc("node.move", {
      threadId: "thread-1",
      id: "later",
      position: { x: 500, y: 600 },
    });

    const composition: JsonValue = {
      width: 1160,
      root: {
        flow: "row",
        children: [{ node: "chart", weight: 2, emphasis: "lead" }, { node: "aside" }],
      },
    };

    await test.tool(toolNames.compose, { composition });
    const saved = await test.board();
    expect(saved?.composition).toEqual(composition);
    expect(saved?.nodes.find((node) => node.id === "chart")?.position).toEqual({ x: 91, y: 43 });
    const recreated = new CanvasService(test.host.api);
    expect(recreated.board("thread-1")?.composition).toEqual(composition);
    await test.host.harness.callRpc("board.compose", {
      threadId: "thread-1",
      composition,
      resetPositions: true,
    });
    const reset = await test.board();

    if (reset === null) throw new Error("Expected an enabled board");
    expect(reset?.nodes.find((node) => node.id === "chart")?.position).toBeNull();
    expect(reset?.nodes.find((node) => node.id === "later")?.position).toEqual({ x: 500, y: 600 });
    expect(describeBoard(reset)).toContain('"width":1160');
    await test.tool(toolNames.archive, { ids: ["chart"] });
    expect((await test.board())?.nodes.map((node) => node.id)).toEqual(["aside", "later"]);
    expect((await test.board())?.composition).toEqual(composition);

    const cli = await test.host.harness.runCli(
      ["compose", "--input", JSON.stringify({ composition: null })],
      { threadId: "thread-1" },
    );

    expect(cli.exitCode).toBe(0);
    expect((await test.board())?.composition).toBeNull();
  });

  it("rejects unknown, duplicate, excessive and malformed references without mutating the board", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "idle", true);
    await test.tool(toolNames.add, { nodes: [{ id: "chart", kind: "note", title: "Chart" }] });
    const before = await test.board();

    for (const children of [[{ node: "missing" }], [{ node: "chart" }, { node: "chart" }]]) {
      await expect(
        test.tool(toolNames.compose, {
          composition: { width: 900, root: { flow: "row", children } },
        }),
      ).rejects.toThrow();
      expect(await test.board()).toEqual(before);
    }

    let root: FlowItem = { node: "chart" };

    for (let depth = 0; depth < 8; depth += 1) root = { flow: "column", children: [root] };
    expect(composeInputSchema.safeParse({ composition: { width: 900, root } }).success).toBe(false);

    for (const weight of [-1, 0, 9, Infinity])
      expect(
        composeInputSchema.safeParse({
          composition: { width: 900, root: { flow: "row", children: [{ node: "chart", weight }] } },
        }).success,
      ).toBe(false);

    const excessive = {
      flow: "column",
      children: Array.from({ length: 200 }, (_, id) => ({
        flow: "column",
        children: [{ flow: "column", children: [{ node: `n-${id}` }] }],
      })),
    };

    expect(
      composeInputSchema.safeParse({ composition: { width: 900, root: excessive } }).success,
    ).toBe(false);
    expect(
      composeInputSchema.safeParse({ composition: { width: 900, root: { node: "chart" } } })
        .success,
    ).toBe(false);
    expect(await test.board()).toEqual(before);
  });
});

describe("inspect, edit and verify agent workflow", () => {
  it("protects fresh human edits on actual tool paths while preserving agent-owned updates", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, {
      nodes: [
        { id: "chart", kind: "html", title: "Discovery", html: "<p>529</p>" },
        { id: "now", kind: "status", state: "running", progress: 0 },
      ],
    });

    const old = nodeInspectionSchema.parse(
      JSON.parse(String(await test.tool(toolNames.inspect, { id: "chart" }))),
    );

    await test.host.harness.callRpc("node.edit", {
      threadId: "thread-1",
      id: "chart",
      fields: { title: "Human heading" },
      expectedVersions: old.fieldVersions,
    });
    await expect(
      test.tool(toolNames.edit, {
        id: "chart",
        fields: { title: "Stale agent heading" },
        expectedVersions: old.fieldVersions,
      }),
    ).rejects.toThrow(/conflict/i);
    await expect(
      test.tool(toolNames.update, { id: "chart", title: "Legacy overwrite" }),
    ).rejects.toThrow(/human.*canvas_edit/i);
    await test.tool(toolNames.update, { id: "now", progress: 0.75 });
    expect((await test.board())?.nodes.find((node) => node.id === "now")?.progress).toBe(0.75);

    const fresh = nodeInspectionSchema.parse(
      JSON.parse(String(await test.tool(toolNames.inspect, { id: "chart" }))),
    );

    await test.tool(toolNames.edit, {
      id: "chart",
      fields: { title: "Inspected replacement" },
      expectedVersions: fresh.fieldVersions,
    });
    expect((await test.board())?.nodes.find((node) => node.id === "chart")?.title).toBe(
      "Inspected replacement",
    );
    const verification = JSON.parse(String(await test.tool(toolNames.verify, { id: "chart" })));
    expect(verification).toMatchObject({ current: false, report: null });
  });

  it("invalidates connected evidence after either the board or bound dataset changes", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.source, { id: "traffic", title: "Traffic", provider: "manual" });
    await test.tool(toolNames.data, {
      sourceId: "traffic",
      columns: [{ key: "visitors", label: "Visitors", type: "number" }],
      rows: [{ visitors: 529 }],
    });
    await test.tool(toolNames.add, {
      nodes: [
        {
          id: "chart",
          kind: "html",
          html: "<p>529</p>",
          binding: { sourceId: "traffic", view: "metric", y: "visitors" },
          evidence: { sourceIds: ["traffic"], revisions: { traffic: 1 } },
        },
      ],
    });

    const report = {
      nodeId: "chart",
      nodeRevision: 1,
      sourceRevision: 1,
      boardRevision: 1,
      capturedAt: Date.now(),
      mode: "board",
      zoom: 0.8,
      view: "evidence",
      bounds: { x: 0, y: 0, width: 600, height: 200 },
      text: "529",
      issues: [],
      ready: true,
    };

    await test.host.harness.callRpc("render.report", { threadId: "thread-1", reports: [report] });
    expect(JSON.parse(String(await test.tool(toolNames.verify, { id: "chart" })))).toMatchObject({
      current: true,
      issues: [],
    });
    await test.tool(toolNames.data, {
      sourceId: "traffic",
      columns: [{ key: "visitors", label: "Visitors", type: "number" }],
      rows: [{ visitors: 607 }],
    });
    expect(JSON.parse(String(await test.tool(toolNames.verify, { id: "chart" })))).toMatchObject({
      current: false,
    });
    await test.host.harness.callRpc("render.report", {
      threadId: "thread-1",
      reports: [{ ...report, sourceRevision: 2, capturedAt: Date.now(), text: "607" }],
    });
    const refreshed = JSON.parse(String(await test.tool(toolNames.verify, { id: "chart" })));
    expect(refreshed.current).toBe(true);
    expect(refreshed.issues.join(" ")).toContain("needs review");
    await test.tool(toolNames.add, { nodes: [{ id: "annotation", kind: "note" }] });
    expect(JSON.parse(String(await test.tool(toolNames.verify, { id: "chart" })))).toMatchObject({
      current: false,
    });
  });

  it("bounds recent history while retaining explicit full-detail access", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, {
      nodes: [{ id: "chart", kind: "html", html: "<p>Start</p>" }],
    });

    for (let index = 0; index < 12; index += 1)
      await test.tool(toolNames.update, {
        id: "chart",
        html: `<p>Revision ${index}${"x".repeat(8000)}</p>`,
      });
    const output = String(await test.tool(toolNames.history, {}));
    const recent = JSON.parse(output);
    expect(recent.entries).toHaveLength(10);
    expect(recent.totalEntries).toBe(13);
    expect(output.length).toBeLessThan(12000);

    const detail = JSON.parse(
      String(await test.tool(toolNames.history, { changeId: recent.entries[0].id })),
    );

    expect(detail.fullDetail).toBe(true);
    expect(detail.entries[0].fields[0].after).toContain("x".repeat(8000));
    expect(detail.nextFieldOffset).toBeNull();
  });

  it("bounds source previews on source/data/inspect/list tool paths", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.source, { id: "records", title: "Records", provider: "manual" });

    const output = String(
      await test.tool(toolNames.data, {
        sourceId: "records",
        columns: [{ key: "message", label: "Message", type: "string" }],
        rows: Array.from({ length: 500 }, () => ({ message: "x".repeat(3000) })),
      }),
    );

    const preview = JSON.parse(output);
    expect(preview.dataset.rowCount).toBe(500);
    expect(preview.dataset.rows).toHaveLength(5);
    expect(preview.dataset.rows[0].message).toHaveLength(80);
    expect(output.length).toBeLessThan(3000);
    await test.tool(toolNames.add, {
      nodes: [
        { id: "table", kind: "html", html: "", binding: { sourceId: "records", view: "table" } },
      ],
    });
    const inspected = JSON.parse(String(await test.tool(toolNames.inspect, { id: "table" })));
    expect(inspected.sources[0].dataset.rowCount).toBe(500);
    expect(String(await test.tool(toolNames.sources, {})).length).toBeLessThan(3000);

    const targeted = JSON.parse(String(await test.tool(toolNames.sources, { id: "records" })));
    expect(targeted).toHaveLength(1);
    expect(targeted[0].dataset.rows).toHaveLength(5);
    expect(targeted[0].dataset.rows[0].message).toHaveLength(80);
    expect(targeted[0].dataset.rowCount).toBe(500);
  });

  it("returns saved source configuration only on targeted tool and CLI reads without secrets", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.host.harness.behavior.setSettings({
      posthogToken: "synthetic-posthog-credential",
      apiToken1: "synthetic-private-api-credential",
    });

    const definitions = [
      sourceInputSchema.parse({
        id: "posthog",
        title: "Pageviews",
        provider: "posthog",
        config: { projectId: 1, query: "SELECT count() AS pageviews FROM events" },
      }),
      sourceInputSchema.parse({
        id: "gsc",
        title: "Search",
        provider: "gsc",
        config: {
          siteUrl: "sc-domain:example.com",
          startDate: "2026-10-01",
          endDate: "2026-10-31",
          dimensions: ["page"],
          rollingDays: 28,
          lagDays: 2,
        },
      }),
      sourceInputSchema.parse({
        id: "api",
        title: "API",
        provider: "json",
        config: {
          url: "https://api.example.com/metrics",
          rowsPath: ["results"],
          credential: "apiToken1",
          columns: [{ key: "visitors", label: "Visitors", type: "number", path: ["count"] }],
        },
      }),
    ];

    for (const definition of definitions) await test.tool(toolNames.source, definition);
    const listed = JSON.parse(String(await test.tool(toolNames.sources, {})));
    expect(listed).toHaveLength(3);

    for (const state of listed) expect(state.source.definition).not.toHaveProperty("config");
    const cliList = await test.host.harness.runCli(["sources", "thread-1", "--json"]);

    for (const state of JSON.parse(cliList.stdout).sources)
      expect(state.source.definition).not.toHaveProperty("config");

    for (const definition of definitions) {
      const output = String(await test.tool(toolNames.sources, { id: definition.id }));
      const targeted = JSON.parse(output);
      expect(targeted).toHaveLength(1);
      expect(sourceInputSchema.parse(targeted[0].source.definition)).toEqual(definition);

      const cli = await test.host.harness.runCli([
        "sources",
        "thread-1",
        "--source",
        definition.id,
        "--json",
      ]);

      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout).sources[0].source.definition).toEqual(definition);

      for (const result of [output, cli.stdout, cliList.stdout, JSON.stringify(listed)]) {
        expect(result).not.toContain("synthetic-posthog-credential");
        expect(result).not.toContain("synthetic-private-api-credential");
      }
    }

    await expect(test.tool(toolNames.sources, { id: "missing" })).rejects.toThrow(
      "Source not found",
    );

    const missing = await test.host.harness.runCli(["sources", "thread-1", "--source", "missing"]);
    expect(missing.exitCode).toBe(1);
  });
});

describe("workspace CLI", () => {
  it("supports inspect/edit/verify/history/undo/redo/duplicate through the registered CLI", async () => {
    const test = fixture();
    const context = { threadId: "thread-1" };
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, {
      nodes: [{ id: "chart", kind: "html", title: "Original", html: "<p>529</p>" }],
    });
    const inspected = await test.host.harness.runCli(["inspect", "chart", "--json"], context);
    expect(inspected.exitCode).toBe(0);
    const node = nodeInspectionSchema.parse(JSON.parse(inspected.stdout));

    const edit = await test.host.harness.runCli(
      [
        "edit",
        "--input",
        JSON.stringify({
          id: "chart",
          fields: { title: "Edited" },
          expectedVersions: node.fieldVersions,
        }),
      ],
      context,
    );

    expect(edit.exitCode).toBe(0);
    const changed = JSON.parse(edit.stdout);
    const history = await test.host.harness.runCli(["history", "1", "--json"], context);
    expect(JSON.parse(history.stdout).entries).toHaveLength(1);
    expect((await test.host.harness.runCli(["undo", changed.changeId], context)).exitCode).toBe(0);
    expect((await test.board())?.nodes[0]?.title).toBe("Original");
    expect((await test.host.harness.runCli(["redo", changed.changeId], context)).exitCode).toBe(0);
    expect((await test.board())?.nodes[0]?.title).toBe("Edited");
    const duplicate = await test.host.harness.runCli(["duplicate", "chart"], context);
    expect(duplicate.exitCode).toBe(0);
    expect((await test.board())?.nodes).toHaveLength(2);
    const verify = await test.host.harness.runCli(["verify", "chart"], context);
    expect(JSON.parse(verify.stdout)).toMatchObject({ current: false, report: null });

    const detail = await test.host.harness.runCli(
      ["history", "--change-id", changed.changeId],
      context,
    );

    expect(JSON.parse(detail.stdout).fullDetail).toBe(true);
    expect((await test.host.harness.runCli(["history", "21", "--json"], context)).exitCode).toBe(1);
  });

  it("configures sources and pushes previews while rejecting raw credential input", async () => {
    const test = fixture();
    const context = { threadId: "thread-1" };
    await test.dispatch("thread-1", "pending", true);

    const configured = await test.host.harness.runCli(
      [
        "source",
        "--input",
        JSON.stringify({ id: "manual", title: "Manual snapshot", provider: "manual" }),
      ],
      context,
    );

    expect(configured.exitCode).toBe(0);

    const pushed = await test.host.harness.runCli(
      [
        "data",
        "--input",
        JSON.stringify({
          sourceId: "manual",
          columns: [{ key: "visitors", label: "Visitors", type: "number" }],
          rows: [{ visitors: 529 }],
        }),
      ],
      context,
    );

    expect(JSON.parse(pushed.stdout).dataset).toMatchObject({
      rowCount: 1,
      rows: [{ visitors: 529 }],
    });
    const listed = await test.host.harness.runCli(["sources", "thread-1", "--json"]);
    expect(JSON.parse(listed.stdout).sources).toHaveLength(1);
    const missing = await test.host.harness.runCli(["refresh", "missing", "--json"], context);
    expect(missing.exitCode).toBe(1);

    const denied = await test.host.harness.runCli(
      [
        "source-credential",
        "--json",
        "--input",
        JSON.stringify({ slot: "apiToken1", reference: "unprotected-value" }),
      ],
      context,
    );

    expect(denied.exitCode).toBe(1);
    const help = await test.host.harness.runCli(["source-credential", "--help"], context);
    expect(help.stdout).toContain("--input-stdin");
  });
});

describe("guarded composition ownership", () => {
  it("protects human arrangement and position on the actual agent tool path", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, { nodes: [{ id: "chart", kind: "note" }] });

    const composition = {
      width: 1000,
      root: { id: "layout", flow: "column", children: [{ node: "chart" }] },
    };

    await test.host.harness.callRpc("board.compose", { threadId: "thread-1", composition });
    const replacement = { ...composition, width: 900 };
    await expect(test.tool(toolNames.compose, { composition: replacement })).rejects.toThrow(
      /human.*expectedRevision/i,
    );
    const fresh = await test.board();

    if (fresh === null) throw new Error("Expected an enabled board");
    await test.tool(toolNames.compose, {
      composition: replacement,
      expectedRevision: fresh.revision,
    });
    await test.host.harness.callRpc("node.move", {
      threadId: "thread-1",
      id: "chart",
      position: { x: 12, y: 34 },
    });
    await expect(
      test.tool(toolNames.compose, { composition: replacement, resetPositions: true }),
    ).rejects.toThrow(/human.*position/i);
    expect((await test.board())?.nodes[0]?.position).toEqual({ x: 12, y: 34 });
    const reset = await test.board();

    if (reset === null) throw new Error("Expected an enabled board");
    await test.tool(toolNames.compose, {
      composition: replacement,
      resetPositions: true,
      expectedRevision: reset.revision,
    });
    expect((await test.board())?.nodes[0]?.position).toBeNull();
  });
});

describe("guarded connection ownership", () => {
  it("protects a human edge label until the agent supplies current board intent", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "pending", true);
    await test.tool(toolNames.add, {
      nodes: [
        { id: "chart", kind: "note" },
        { id: "claim", kind: "note" },
      ],
    });
    await test.host.harness.callRpc("board.link", {
      threadId: "thread-1",
      from: "chart",
      to: "claim",
      label: "Human relationship",
    });
    await expect(
      test.tool(toolNames.link, { from: "chart", to: "claim", label: "Overwrite" }),
    ).rejects.toThrow(/human.*expectedRevision/i);
    const fresh = await test.board();

    if (fresh === null) throw new Error("Expected an enabled board");
    await test.tool(toolNames.link, {
      from: "chart",
      to: "claim",
      label: "Inspected relationship",
      expectedRevision: fresh.revision,
    });
    expect((await test.board())?.edges[0]?.label).toBe("Inspected relationship");
  });
});

describe("islands for agents", () => {
  it("outlines islands, returns design notes and verifies an island as a whole", async () => {
    const test = fixture();
    await test.dispatch("thread-1", "idle", true);
    await test.tool(toolNames.add, {
      nodes: ["headline", "clicks", "trend", "views"].map((id) => ({
        id,
        kind: "note",
        title: id,
      })),
    });

    const result = z.object({ notes: z.array(z.string()) }).parse(
      JSON.parse(
        String(
          await test.tool(toolNames.compose, {
            composition: {
              width: 1400,
              root: {
                flow: "column",
                children: [
                  { node: "headline", emphasis: "lead" },
                  {
                    id: "discovery",
                    flow: "bento",
                    columns: 2,
                    island: {
                      title: "Discovery",
                      question: "How do people find us?",
                      accent: "blue",
                    },
                    children: [{ node: "clicks" }, { node: "trend" }, { node: "views", span: 2 }],
                  },
                ],
              },
            },
          }),
        ),
      ),
    );

    expect(result.notes).toEqual([]);

    const outline = describeBoard(await test.board());

    expect(outline).toContain("Islands, in reading order:");
    expect(outline).toContain(
      "- discovery: Discovery — How do people find us? [bento 2 columns, blue] clicks, trend, views",
    );

    const verified = z
      .object({
        island: z.string(),
        current: z.boolean(),
        members: z.array(z.object({ id: z.string(), current: z.boolean() })),
        issues: z.array(z.string()),
      })
      .parse(JSON.parse(String(await test.tool(toolNames.verify, { island: "discovery" }))));

    expect(verified.island).toBe("discovery");
    expect(verified.current).toBe(false);
    expect(verified.members.map((member) => member.id)).toEqual(["clicks", "trend", "views"]);
    expect(verified.issues[0]).toContain("clicks: No connected render has reported this node");
    await expect(test.tool(toolNames.verify, { island: "nowhere" })).rejects.toThrow(
      "No island has id nowhere",
    );
    await expect(
      test.tool(toolNames.verify, { id: "clicks", island: "discovery" }),
    ).rejects.toThrow();

    const cli = await test.host.harness.runCli(["verify", "--island", "discovery", "--json"], {
      threadId: "thread-1",
    });

    expect(cli.exitCode).toBe(0);
    expect(cli.stdout).toContain('"island":"discovery"');
  });
});

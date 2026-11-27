import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { boardSchema } from "../contract.ts";
import { projectCanvasSchema } from "../project-contract.ts";
import plugin from "../server.ts";

const hosts: FakePluginHost[] = [];

const projectId = "proj-canvas-chat";

const otherProjectId = "proj-another";

const boardResult = z.object({ board: boardSchema.nullable() });

function marker(sectionId: string) {
  return {
    canvasChat: true,
    projectId,
    regionId: sectionId,
    anchorKind: "section",
    anchorId: sectionId,
    x: 150,
    y: 250,
  } as const;
}

function deferredMetadata() {
  let release: ((value: ReturnType<typeof marker>) => void) | undefined;
  let announce: (() => void) | undefined;

  const ready = new Promise<void>((resolve) => {
    announce = resolve;
  });

  const value = new Promise<ReturnType<typeof marker>>((resolve) => {
    release = resolve;
  });

  return {
    ready,
    load: async () => {
      announce?.();

      return value;
    },
    release(metadata: ReturnType<typeof marker>) {
      if (release === undefined) throw new Error("Metadata consumer not initialized");
      release(metadata);
    },
  };
}

function fixture(load?: (threadId: string) => Promise<ReturnType<typeof marker>>) {
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const metadata = new Map<string, ReturnType<typeof marker>>();

  const host = createFakePluginHost({
    pluginId: "canvas",
    agentSkillIds: ["canvas", "canvas-style"],
    sdk: {
      threads: {
        get: async ({ threadId }) =>
          threads.get(threadId) ?? makeThreadResponse({ id: threadId, projectId }),
        getPluginMetadata: async ({ threadId }) =>
          load === undefined ? (metadata.get(threadId) ?? {}) : load(threadId),
      },
    },
  });

  hosts.push(host);
  plugin(host.api);

  function chat(
    id: string,
    sectionId: string,
    overrides: Partial<ReturnType<typeof makeThreadResponse>> = {},
  ) {
    const thread = makeThreadResponse({
      id,
      projectId,
      originPluginId: "canvas",
      visibility: "visible",
      archivedAt: null,
      ...overrides,
    });

    threads.set(id, thread);
    metadata.set(id, marker(sectionId));

    return thread;
  }

  async function canvas(id = projectId) {
    return projectCanvasSchema.parse(await host.harness.callRpc("project.get", { projectId: id }));
  }

  async function section(title: string, id = projectId) {
    const project = projectCanvasSchema.parse(
      await host.harness.callRpc("project.section.create", { projectId: id, title }),
    );

    const created = project.sections.find((entry) => entry.title === title);

    if (created === undefined) throw new Error("Section creation failed");

    return created;
  }

  async function dispatch(thread: ReturnType<typeof makeThreadResponse>) {
    const handler = host.harness.registrations.hooks["message.dispatch"];

    if (handler === null) throw new Error("Missing Canvas dispatch hook");

    return handler(
      makeMessageDispatchHookContext({
        thread,
        project: { id: thread.projectId },
        input: {
          text: "Update the dashboard",
          blocks: [{ type: "text", text: "Update the dashboard", mentions: [] }],
        },
      }),
    );
  }

  function configure(thread: ReturnType<typeof makeThreadResponse>) {
    return host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread, project: { id: thread.projectId } }),
    );
  }

  return { host, chat, canvas, section, dispatch, configure };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("canvas chat server lifecycle", () => {
  it("awaits initial dispatch metadata before the agent receives its brief and tools", async () => {
    const metadata = deferredMetadata();
    const test = fixture(metadata.load);
    const section = await test.section("Dashboard");
    const thread = test.chat("initial", section.id);
    let dispatched = false;

    const dispatch = test.dispatch(thread).then((result) => {
      dispatched = true;

      return result;
    });

    await metadata.ready;
    expect(dispatched).toBe(false);
    expect((await test.canvas()).chats).toEqual([]);
    const before = await test.configure(thread);
    expect(before.tools).toEqual([]);
    metadata.release(marker(section.id));
    expect(await dispatch).toEqual({ action: "proceed" });
    const after = await test.configure(thread);
    expect(after.instructions).toContain(`Project canvas ${projectId}`);
    expect(after.instructions).toContain(section.id);
    expect(after.tools.map((tool) => tool.name)).toContain("canvas_add");
    expect(after.skills).toContain("canvas");
    expect((await test.canvas()).chats).toEqual([
      expect.objectContaining({
        threadId: thread.id,
        regionId: section.id,
        role: "spawned",
        state: "open",
        x: 150,
        y: 250,
      }),
    ]);
  });

  it("deduplicates concurrent creation and dispatch, then leaves repeated lifecycle calls unchanged", async () => {
    const metadata = deferredMetadata();
    const test = fixture(metadata.load);
    const section = await test.section("Dashboard");
    const thread = test.chat("racing", section.id);
    const created = test.host.harness.emitThreadEvent("thread.created", { thread });
    const dispatched = test.dispatch(thread);
    await metadata.ready;
    expect(test.host.harness.sdk.callsTo("threads.getPluginMetadata")).toHaveLength(1);
    metadata.release(marker(section.id));
    expect((await created).errors).toEqual([]);
    await dispatched;
    const first = await test.canvas();
    expect(first.chats).toHaveLength(1);
    expect((await test.host.harness.emitThreadEvent("thread.created", { thread })).errors).toEqual(
      [],
    );
    await test.dispatch(thread);
    expect(await test.canvas()).toEqual(first);
    expect(test.host.harness.sdk.callsTo("threads.getPluginMetadata")).toHaveLength(1);
  });

  it.each([
    {
      name: "another project",
      overrides: { projectId: otherProjectId },
      message: /another project/u,
    },
    {
      name: "hidden chat",
      overrides: { visibility: "hidden" as const },
      message: /visible and unarchived/u,
    },
    { name: "archived chat", overrides: { archivedAt: 1234 }, message: /visible and unarchived/u },
  ])(
    "rejects $name metadata visibly before linking or enabling its chat",
    async ({ overrides, message }) => {
      const test = fixture();
      const section = await test.section("Dashboard");
      const thread = test.chat("invalid", section.id, overrides);
      await expect(test.dispatch(thread)).rejects.toThrow(message);
      const event = await test.host.harness.emitThreadEvent("thread.created", { thread });
      expect(event.errors).toHaveLength(1);
      expect(event.errors[0]).toMatchObject({ message: expect.stringMatching(message) });
      expect((await test.canvas()).chats).toEqual([]);
      expect((await test.configure(thread)).tools).toEqual([]);
    },
  );

  it("resolves and reopens archived canvas chats, and keeps their section after deletion", async () => {
    const test = fixture();
    const section = await test.section("Dashboard");
    const thread = test.chat("lifecycle", section.id);
    expect((await test.host.harness.emitThreadEvent("thread.created", { thread })).errors).toEqual(
      [],
    );
    await test.host.harness.callAgentTool(
      "canvas_add",
      { nodes: [{ id: "retained", kind: "note", title: "Keep this module" }] },
      { threadId: thread.id, projectId },
    );

    const board = await test.host.harness.callRpc("board.get", {
      board: { sectionId: section.id },
    });

    expect(
      (
        await test.host.harness.emitThreadEvent("thread.archived", {
          thread: { ...thread, archivedAt: 1234 },
        })
      ).errors,
    ).toEqual([]);
    expect((await test.canvas()).chats[0]?.state).toBe("resolved");
    expect(
      (await test.host.harness.emitThreadEvent("thread.unarchived", { thread })).errors,
    ).toEqual([]);
    expect((await test.canvas()).chats[0]?.state).toBe("open");
    expect((await test.host.harness.emitThreadEvent("thread.deleted", { thread })).errors).toEqual(
      [],
    );
    expect((await test.canvas()).chats).toEqual([]);
    expect((await test.canvas()).sections[0]?.id).toBe(section.id);
    expect(
      await test.host.harness.callRpc("board.get", { board: { sectionId: section.id } }),
    ).toEqual(board);
  });

  it("attributes native tool edits to the explicitly selected board and enforces its project scope", async () => {
    const test = fixture();
    const primary = await test.section("Primary");
    const selected = await test.section("Selected");
    const foreign = await test.section("Foreign", otherProjectId);
    const thread = test.chat("selector", primary.id);
    await test.dispatch(thread);
    const context = { threadId: thread.id, projectId };
    const board = { sectionId: selected.id };

    const mutation = z.object({ changeId: z.string() }).parse(
      JSON.parse(
        z.string().parse(
          await test.host.harness.callAgentTool(
            "canvas_add",
            {
              board,
              nodes: [{ id: "selected-module", kind: "note", title: "Selected board" }],
            },
            context,
          ),
        ),
      ),
    );

    expect(
      boardResult.parse(
        await test.host.harness.callRpc("board.get", { board: { sectionId: primary.id } }),
      ).board?.nodes,
    ).toEqual([]);
    expect(
      boardResult.parse(await test.host.harness.callRpc("board.get", { board })).board?.nodes[0]
        ?.title,
    ).toBe("Selected board");
    expect(await test.host.harness.callAgentTool("canvas_show", { board }, context)).toContain(
      "Selected board",
    );
    expect(
      await test.host.harness.callRpc("project.chat.changes", { projectId, threadId: thread.id }),
    ).toEqual([{ sectionId: selected.id, nodeId: "selected-module", changeId: mutation.changeId }]);

    const updated = await test.host.harness.runCli(
      [
        "update",
        "--section",
        selected.id,
        "--project",
        projectId,
        "--input",
        JSON.stringify({ id: "selected-module", title: "CLI selected board" }),
      ],
      context,
    );

    expect(updated.exitCode, updated.stderr).toBe(0);
    const cliChange = z.object({ changeId: z.string() }).parse(JSON.parse(updated.stdout));

    const shown = await test.host.harness.runCli(
      ["show", "--section", selected.id, "--project", projectId, "--json"],
      context,
    );

    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(boardResult.parse(JSON.parse(shown.stdout)).board?.nodes[0]?.title).toBe(
      "CLI selected board",
    );
    expect(
      await test.host.harness.callRpc("project.chat.changes", { projectId, threadId: thread.id }),
    ).toContainEqual({
      sectionId: selected.id,
      nodeId: "selected-module",
      changeId: cliChange.changeId,
    });

    const wrongProject = await test.host.harness.runCli(
      ["show", "--section", selected.id, "--project", otherProjectId, "--json"],
      context,
    );

    expect(wrongProject.exitCode).not.toBe(0);
    expect(wrongProject.stderr).toMatch(/project/u);
    await expect(
      test.host.harness.callAgentTool(
        "canvas_add",
        {
          board: { sectionId: foreign.id },
          nodes: [{ id: "forbidden", kind: "note", title: "Forbidden" }],
        },
        context,
      ),
    ).rejects.toThrow(/another project/u);
    await expect(
      test.host.harness.callAgentTool("canvas_show", { board: { sectionId: foreign.id } }, context),
    ).rejects.toThrow(/another project/u);
    expect(
      await test.host.harness.callRpc("project.chat.changes", {
        projectId: otherProjectId,
        threadId: thread.id,
      }),
    ).toEqual([]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
  type FakePluginHost,
} from "@omnyo/plugin-sdk/testing";
import { boardSchema, modeSchema } from "../contract.ts";
import { projectCanvasSchema, projectSectionSchema } from "../project-contract.ts";
import { layoutBoard } from "../lib/layout.ts";
import plugin from "../server.ts";

const hosts: FakePluginHost[] = [];

const projectId = "proj-canvas";

const otherProjectId = "proj-other";

const boardResultSchema = z.object({ board: boardSchema.nullable() });

function fixture(beforeGet?: (threadId: string) => Promise<string | void>) {
  const host = createFakePluginHost({
    pluginId: "canvas",
    agentSkillIds: ["canvas", "canvas-style"],
    sdk: {
      projects: {
        get: async ({ projectId: id }) => ({
          id,
          name: "Canvas integration",
          kind: "standard",
          createdAt: 1,
          updatedAt: 1,
          gitRemoteUrl: null,
          sources: [],
        }),
      },
      threads: {
        get: async ({ threadId }) => {
          const currentProject = await beforeGet?.(threadId);

          return makeThreadResponse({
            id: threadId,
            projectId: currentProject ?? (threadId === "foreign" ? otherProjectId : projectId),
            title: `Chat ${threadId}`,
            visibility: "visible",
            archivedAt: null,
          });
        },
      },
    },
  });

  hosts.push(host);
  plugin(host.api);

  async function cli(args: string[], threadId = "origin") {
    const result = await host.harness.runCli(args, {
      threadId,
      projectId: threadId === "foreign" ? otherProjectId : projectId,
    });

    expect(result.exitCode, result.stderr).toBe(0);

    return result;
  }

  async function read(threadId = "origin") {
    return boardResultSchema.parse(await host.harness.callRpc("board.get", { threadId })).board;
  }

  async function createBoard(threadId = "origin", id = "lead") {
    await cli(["on"], threadId);
    await cli(
      ["add", "--input", JSON.stringify({ nodes: [{ id, kind: "note", title: "Initial" }] })],
      threadId,
    );
  }

  async function adopt() {
    await createBoard();
    const result = await cli(["project", "add", "origin"]);

    return projectSectionSchema.parse(JSON.parse(result.stdout));
  }

  async function project() {
    return projectCanvasSchema.parse(await host.harness.callRpc("project.get", { projectId }));
  }

  return { host, cli, read, createBoard, adopt, project };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("project canvas plugin integration", () => {
  it("keeps actions for live chats when a listed chat has been deleted", async () => {
    const test = fixture(async (threadId) => {
      if (threadId === "deleted")
        throw Object.assign(new Error("HTTP 404: Thread not found"), {
          status: 404,
          code: "thread_not_found",
        });
    });

    expect(
      await test.host.harness.callRpc("project.actions", {
        threadIds: ["live", "deleted", "live"],
      }),
    ).toEqual([
      {
        threadId: "live",
        projectId,
        boardTitle: null,
        link: null,
      },
    ]);
  });

  it.each([
    { status: 403, code: "forbidden" },
    { status: 404, code: "route_not_found" },
    { status: 502, code: "host_unavailable" },
  ])("keeps real project action failures visible: $code", async (details) => {
    const failure = Object.assign(new Error("Thread metadata unavailable"), details);

    const test = fixture(async () => {
      throw failure;
    });

    await expect(
      test.host.harness.callRpc("project.actions", { threadIds: ["unavailable"] }),
    ).rejects.toThrow("Thread metadata unavailable");
  });

  it("keeps legacy and explicit section references live for RPC and CLI reads and writes", async () => {
    const test = fixture();
    const section = await test.adopt();

    const bySection = boardResultSchema.parse(
      await test.host.harness.callRpc("board.get", { board: { sectionId: section.id } }),
    ).board;

    expect(bySection?.threadId).toBe(section.id);
    expect(await test.read()).toEqual(bySection);
    await test.host.harness.callRpc("node.move", {
      threadId: "origin",
      id: "lead",
      position: { x: 200, y: 300 },
    });
    await test.cli(["update", "--input", JSON.stringify({ id: "lead", title: "CLI update" })]);
    const after = await test.read();
    expect(after?.nodes[0]).toMatchObject({ title: "CLI update", position: { x: 200, y: 300 } });
    const shown = await test.cli(["show", "--json"]);
    expect(boardResultSchema.parse(JSON.parse(shown.stdout)).board).toEqual(after);

    const returned = await test.cli([
      "project",
      "return",
      section.id,
      "--expected-revision",
      String((await test.project()).revision),
    ]);

    expect(returned.stdout).toContain("origin");
    expect((await test.read())?.threadId).toBe("origin");
    expect((await test.read())?.nodes[0]?.title).toBe("CLI update");
  });

  it("preserves the original Canvas off setting while the adopted section remains readable", async () => {
    const test = fixture();
    await test.createBoard();
    await test.cli(["off"]);
    const result = await test.cli(["project", "add", "origin"]);
    const section = projectSectionSchema.parse(JSON.parse(result.stdout));
    expect(
      modeSchema.parse(await test.host.harness.callRpc("mode.get", { threadId: "origin" })).canvas,
    ).toBe(false);
    expect(
      modeSchema.parse(
        await test.host.harness.callRpc("mode.get", { board: { sectionId: section.id } }),
      ).canvas,
    ).toBe(true);
    expect(
      modeSchema.parse(
        await test.host.harness.callRpc("mode.get", { board: { threadId: "origin" } }),
      ).canvas,
    ).toBe(false);
    expect((await test.read())?.nodes[0]?.id).toBe("lead");
    await test.cli(["on"]);
    await test.host.harness.callRpc("mode.off", { board: { threadId: "origin" } });
    expect(
      modeSchema.parse(
        await test.host.harness.callRpc("mode.get", { board: { sectionId: section.id } }),
      ).canvas,
    ).toBe(true);
  });

  it("retains a project section and its sources after the origin thread is deleted", async () => {
    const test = fixture();
    const section = await test.adopt();
    await test.cli([
      "source",
      "--input",
      JSON.stringify({ id: "manual", title: "Manual", provider: "manual" }),
    ]);

    const before = boardResultSchema.parse(
      await test.host.harness.callRpc("board.get", { board: { sectionId: section.id } }),
    ).board;

    const event = await test.host.harness.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "origin", projectId }),
    });

    expect(event.errors).toEqual([]);
    expect(
      boardResultSchema.parse(
        await test.host.harness.callRpc("board.get", { board: { sectionId: section.id } }),
      ).board,
    ).toEqual(before);
    expect((await test.project()).sections[0]?.originThreadId).toBeNull();

    const sources = await test.host.harness.callRpc("source.list", {
      board: { sectionId: section.id },
    });

    expect(sources).toMatchObject({ sources: [{ source: { definition: { id: "manual" } } }] });
  });

  it("allows same-project reads while refusing native tool calls under another project", async () => {
    const test = fixture();
    await test.adopt();
    const native = test.host.harness;
    expect(
      await native.callAgentTool("canvas_show", {}, { threadId: "origin", projectId }),
    ).toContain("Initial");
    await expect(
      native.callAgentTool("canvas_show", {}, { threadId: "origin", projectId: otherProjectId }),
    ).rejects.toThrow(/another project/);
    await expect(
      native.callAgentTool(
        "canvas_update",
        { id: "lead", title: "Foreign overwrite" },
        { threadId: "origin", projectId: otherProjectId },
      ),
    ).rejects.toThrow(/another project/);
    expect((await test.read())?.nodes[0]?.title).toBe("Initial");
    await expect(
      native.callAgentTool(
        "canvas_project_add",
        { threadId: "foreign", title: "Foreign board" },
        { threadId: "origin", projectId },
      ),
    ).rejects.toThrow(/another project/);
  });

  it("delivers the project brief when joining and keeps locked sections readable to native tools", async () => {
    const test = fixture();
    const section = await test.adopt();
    const joined = await test.cli(["project", "join", "--section", section.id], "joined");
    expect(joined.stdout).toContain(section.id);

    const configuration = await test.host.harness.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "joined" },
        project: { id: projectId },
      }),
    );

    expect(configuration.instructions).toContain(`Project canvas ${projectId}`);
    expect(configuration.instructions).toContain(section.id);
    expect(configuration.tools.map((tool) => tool.name)).toContain("canvas_update");
    await test.host.harness.callRpc("project.section.update", {
      projectId,
      sectionId: section.id,
      locked: true,
    });
    expect(
      await test.host.harness.callAgentTool("canvas_show", {}, { threadId: "joined", projectId }),
    ).toContain("Initial");
    await expect(
      test.host.harness.callAgentTool(
        "canvas_update",
        { id: "lead", title: "Locked overwrite" },
        { threadId: "joined", projectId },
      ),
    ).rejects.toThrow(/locked/);
    expect((await test.read())?.nodes[0]?.title).toBe("Initial");
  });

  it("returns batched project actions for real boards, empty chats, spawned cards and adopted links", async () => {
    const test = fixture();
    await test.createBoard("loose");
    await test.cli(["off"], "loose");
    await test.cli(["on"], "empty");
    await test.createBoard("archived-only");
    await test.host.harness.callRpc("node.archive", { threadId: "archived-only", id: "lead" });
    await test.createBoard("historical");
    await test.cli(["move-from", "historical"], "origin");
    const adopted = await test.cli(["project", "add", "origin"]);
    const section = projectSectionSchema.parse(JSON.parse(adopted.stdout));
    await test.host.harness.callRpc("project.join", {
      projectId,
      threadId: "joined",
      sectionId: section.id,
    });
    await test.host.harness.callRpc("project.chat.put", {
      projectId,
      threadId: "spawned",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 20,
      y: 30,
      role: "spawned",
    });
    await test.host.harness.callRpc("project.chat.put", {
      projectId,
      threadId: "free-spawned",
      anchorKind: "free",
      x: 20,
      y: 30,
      role: "spawned",
    });
    const before = await test.project();
    expect(
      await test.host.harness.callRpc("project.actions", {
        threadIds: [
          "loose",
          "no-board",
          "empty",
          "archived-only",
          "origin",
          "historical",
          "joined",
          "spawned",
          "free-spawned",
          "origin",
        ],
      }),
    ).toEqual([
      { threadId: "loose", projectId, boardTitle: "Chat loose", link: null },
      { threadId: "no-board", projectId, boardTitle: null, link: null },
      { threadId: "empty", projectId, boardTitle: null, link: null },
      { threadId: "archived-only", projectId, boardTitle: null, link: null },
      {
        threadId: "origin",
        projectId,
        boardTitle: null,
        link: { sectionId: section.id, chat: false },
      },
      {
        threadId: "historical",
        projectId,
        boardTitle: null,
        link: { sectionId: section.id, chat: false },
      },
      {
        threadId: "joined",
        projectId,
        boardTitle: null,
        link: { sectionId: section.id, chat: false },
      },
      {
        threadId: "spawned",
        projectId,
        boardTitle: null,
        link: { sectionId: section.id, chat: true },
      },
      {
        threadId: "free-spawned",
        projectId,
        boardTitle: null,
        link: { sectionId: null, chat: true },
      },
    ]);
    expect(await test.project()).toEqual(before);
    test.host.harness.sdk.stub("threads.get", () => {
      throw new Error("Thread metadata unavailable");
    });
    expect(await test.host.harness.callRpc("project.actions", { threadIds: [] })).toEqual([]);
    await expect(
      test.host.harness.callRpc("project.actions", { threadIds: ["unavailable"] }),
    ).rejects.toThrow(/Thread metadata unavailable/u);
  });

  it("resolves saved project views while missing, removed and wrong-project links stay unavailable", async () => {
    const test = fixture();

    const saved = projectCanvasSchema.parse(
      await test.host.harness.callRpc("project.view.put", {
        projectId,
        title: "Dashboard link",
        anchorKind: "free",
        rect: { x: 100, y: 200, width: 800, height: 600 },
      }),
    );

    const view = saved.views.find((entry) => entry.title === "Dashboard link");

    if (view === undefined) throw new Error("View creation failed");
    expect(await test.host.harness.callRpc("project.view.resolve", { viewId: view.id })).toEqual({
      projectId,
      viewId: view.id,
    });
    expect(
      await test.host.harness.callRpc("project.view.resolve", { projectId, viewId: view.id }),
    ).toEqual({ projectId, viewId: view.id });
    expect(
      await test.host.harness.callRpc("project.view.resolve", {
        projectId: otherProjectId,
        viewId: view.id,
      }),
    ).toBeNull();
    expect(
      await test.host.harness.callRpc("project.view.resolve", { viewId: "view_missing" }),
    ).toBeNull();
    await test.host.harness.callRpc("project.view.remove", { projectId, id: view.id });
    expect(
      await test.host.harness.callRpc("project.view.resolve", { projectId, viewId: view.id }),
    ).toBeNull();
    expect(await test.host.harness.callRpc("project.view.resolve", { viewId: view.id })).toBeNull();
  });

  it("uses the same collision-safe position through CLI and RPC without changing anchored view rectangles", async () => {
    const test = fixture();
    const first = await test.adopt();
    await test.createBoard("second", "second-lead");
    const added = await test.cli(["project", "add", "second"]);
    const second = projectSectionSchema.parse(JSON.parse(added.stdout));

    const saved = projectCanvasSchema.parse(
      await test.host.harness.callRpc("project.view.put", {
        projectId,
        title: "Local anchor",
        anchorKind: "section",
        regionId: second.id,
        anchorId: second.id,
        rect: { x: 15, y: 25, width: 400, height: 300 },
      }),
    );

    const view = saved.views.find((entry) => entry.title === "Local anchor");
    const beforeFirst = saved.sections.find((entry) => entry.id === first.id);

    const rpcMoved = projectCanvasSchema.parse(
      await test.host.harness.callRpc("project.section.move", {
        projectId,
        sectionId: second.id,
        x: first.x + 7,
        y: first.y + 9,
      }),
    );

    const moved = rpcMoved.sections.find((entry) => entry.id === second.id);

    const cliMoved = await test.cli([
      "project",
      "section",
      "move",
      "--input",
      JSON.stringify({
        sectionId: second.id,
        x: first.x + 7,
        y: first.y + 9,
        expectedRevision: rpcMoved.revision,
      }),
    ]);

    expect(projectSectionSchema.parse(JSON.parse(cliMoved.stdout))).toEqual(moved);
    expect(Math.abs((moved?.x ?? NaN) % 40)).toBe(0);
    expect(Math.abs((moved?.y ?? NaN) % 40)).toBe(0);
    expect(rpcMoved.sections.find((entry) => entry.id === first.id)).toEqual(beforeFirst);
    expect(rpcMoved.views.find((entry) => entry.id === view?.id)?.rect).toEqual(view?.rect);
    const firstBoard = await test.read();
    const secondBoard = await test.read("second");

    if (!firstBoard || !secondBoard || !moved) throw new Error("Missing section geometry");
    const a = layoutBoard(firstBoard, new Map()).bounds;
    const b = layoutBoard(secondBoard, new Map()).bounds;

    const left = {
      x: a.x + first.x - 24,
      y: a.y + first.y - 72,
      width: a.width + 48,
      height: a.height + 96,
    };

    const right = {
      x: b.x + moved.x - 24,
      y: b.y + moved.y - 72,
      width: b.width + 48,
      height: b.height + 96,
    };

    expect(
      right.x >= left.x + left.width + 120 ||
        left.x >= right.x + right.width + 120 ||
        right.y >= left.y + left.height + 120 ||
        left.y >= right.y + right.height + 120,
    ).toBe(true);
    const chosenDistance = (moved.x - 7) ** 2 + (moved.y - 9) ** 2;
    const radius = Math.ceil(Math.sqrt(chosenDistance) / 40) * 40;
    let closerFreePositions = 0;

    for (let x = -radius; x <= radius; x += 40) {
      for (let y = -radius; y <= radius; y += 40) {
        if ((x - 7) ** 2 + (y - 9) ** 2 >= chosenDistance) continue;
        const candidate = { ...right, x: right.x + x - moved.x, y: right.y + y - moved.y };

        if (
          candidate.x >= left.x + left.width + 120 ||
          left.x >= candidate.x + candidate.width + 120 ||
          candidate.y >= left.y + left.height + 120 ||
          left.y >= candidate.y + candidate.height + 120
        )
          closerFreePositions++;
      }
    }

    expect(closerFreePositions).toBe(0);

    const atBoundary = projectCanvasSchema.parse(
      await test.host.harness.callRpc("project.section.move", {
        projectId,
        sectionId: second.id,
        x: 1000000,
        y: 1000000,
      }),
    );

    const bounded = atBoundary.sections.find((entry) => entry.id === second.id);

    if (bounded === undefined) throw new Error("Moved section missing");
    expect(b.x + bounded.x + b.width + 24).toBeLessThanOrEqual(1000000);
    expect(b.y + bounded.y + b.height + 24).toBeLessThanOrEqual(1000000);
    expect(atBoundary.views.find((entry) => entry.id === view?.id)?.rect).toEqual(view?.rect);
  });
});

it("refuses ownership replay when its original chat no longer exists in the SDK", async () => {
  let missing = false;

  const test = fixture(async (id) => {
    if (missing && id === "origin") throw new Error("Original chat is deleted");
  });

  await test.adopt();
  const before = await test.project();
  const content = await test.read();
  missing = true;
  await expect(test.host.harness.callRpc("project.undo", { projectId })).rejects.toThrow(/deleted/);
  expect(await test.project()).toEqual(before);
  expect(await test.read()).toEqual(content);
});

it("pins default ownership replay before asynchronous SDK checks and preserves intervening work", async () => {
  let mutate = false;

  const test = fixture(async (id) => {
    if (mutate && id === "origin") {
      mutate = false;
      await test.host.harness.callRpc("project.section.create", {
        projectId,
        title: "Concurrent section",
      });
    }
  });

  const adopted = await test.adopt();
  mutate = true;
  await expect(test.host.harness.callRpc("project.undo", { projectId })).rejects.toThrow(/changed/);
  const after = await test.project();
  expect(after.sections.map((section) => section.title)).toContain("Concurrent section");
  expect(after.sections.some((section) => section.id === adopted.id)).toBe(true);
  expect((await test.read())?.threadId).toBe(adopted.id);
});

it("shares structural journal undo and redo across CLI and RPC without weakening agent revision checks", async () => {
  const test = fixture();
  const section = await test.adopt();
  const journal = await test.cli(["project", "journal", "--json"]);

  const entries = z
    .array(z.object({ id: z.string(), revision: z.number() }))
    .parse(JSON.parse(journal.stdout));

  const entry = entries[0];

  if (!entry) throw new Error("Adoption was not journaled");

  const refused = await test.host.harness.runCli(["project", "undo", "--change-id", entry.id], {
    threadId: "origin",
    projectId,
  });

  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toMatch(/revision/);

  const undone = projectCanvasSchema.parse(
    await test.host.harness.callRpc("project.undo", { projectId, changeId: entry.id }),
  );

  expect(undone.sections).toEqual([]);

  const redone = await test.host.harness.runCli(
    [
      "project",
      "redo",
      "--project",
      projectId,
      "--change-id",
      entry.id,
      "--expected-revision",
      String(undone.revision),
    ],
    { projectId },
  );

  expect(redone.exitCode, redone.stderr).toBe(0);
  expect((await test.project()).sections[0]?.id).toBe(section.id);
  expect((await test.read())?.threadId).toBe(section.id);
});

it("refuses ownership replay after a historical alias chat moves to another core project", async () => {
  let moved = false;
  const test = fixture(async (id) => (moved && id === "historical" ? otherProjectId : undefined));
  await test.createBoard("historical");
  await test.cli(["move-from", "historical"], "origin");
  await test.cli(["project", "add", "origin"]);
  const before = await test.project();
  const board = await test.read();
  moved = true;
  await expect(test.host.harness.callRpc("project.undo", { projectId })).rejects.toThrow(
    /another project/,
  );
  expect(await test.project()).toEqual(before);
  expect(await test.read()).toEqual(board);
});

it("refuses metadata replay after a linked chat moves to another core project", async () => {
  let moved = false;
  const test = fixture(async (id) => (moved && id === "linked" ? otherProjectId : undefined));
  await test.host.harness.callRpc("project.chat.put", {
    projectId,
    threadId: "linked",
    anchorKind: "free",
    x: 10,
    y: 20,
    role: "spawned",
  });
  await test.host.harness.callRpc("project.chat.move", {
    projectId,
    threadId: "linked",
    anchorKind: "free",
    regionId: null,
    x: 80,
    y: 100,
  });
  const before = await test.project();
  moved = true;
  await expect(test.host.harness.callRpc("project.undo", { projectId })).rejects.toThrow(
    /another project/,
  );
  expect(await test.project()).toEqual(before);
});

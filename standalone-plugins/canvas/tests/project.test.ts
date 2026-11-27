import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { z } from "zod";
import { CanvasService } from "../lib/service.ts";
import { ProjectService } from "../lib/project.ts";
import { SourceService, type LoadedSource, type SourceLoader } from "../lib/sources.ts";
import { sourceInputSchema } from "../source-contract.ts";
import {
  archivedAdoptedCanvas,
  emptyServerCanvas,
  synthesizedOverview,
} from "./fixtures/project-canvas.ts";

const hosts: FakePluginHost[] = [];

const projectId = "project";

const human = { projectId, actor: "human" as const };

const data: LoadedSource = {
  columns: [{ key: "value", label: "Value", type: "number" }],
  rows: [{ value: 10 }],
};

function fixture(loader?: SourceLoader) {
  const host = createFakePluginHost({ pluginId: "canvas-project" });
  hosts.push(host);
  const service = new CanvasService(host.api);
  const sources = new SourceService(host.api, loader);
  const projects = new ProjectService(host.api, service, sources);

  return { host, service, sources, projects, db: host.api.storage.database() };
}

function board() {
  const state = fixture();
  const { service, sources } = state;
  service.enable("origin", "user");

  const added = service.add("origin", [
    { id: "lead", kind: "note", title: "Lead" },
    { id: "detail", kind: "note", title: "Detail" },
  ]);

  state.projects.recordChange("origin", added.changeId, "origin");
  service.link("origin", "lead", "detail", undefined, false);
  service.compose("origin", {
    composition: {
      width: 1400,
      root: {
        flow: "column",
        children: [
          { node: "lead", emphasis: "lead" },
          {
            id: "evidence",
            flow: "column",
            island: { title: "Evidence" },
            children: [{ node: "detail" }],
          },
        ],
      },
    },
  });
  service.update("origin", { id: "detail", title: "Verified detail" }, "human");
  sources.upsert(
    "origin",
    sourceInputSchema.parse({ id: "manual", title: "Manual", provider: "manual" }),
  );
  sources.push("origin", { sourceId: "manual", ...data });

  return state;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("project canvas storage", () => {
  it("reads an empty canvas without creating records and creates Overview on the first write", () => {
    const { projects, db } = fixture();
    expect(projects.get(projectId)).toMatchObject({
      revision: 0,
      sections: [],
      chats: [],
      views: [{ title: "Overview" }],
    });
    expect(db.prepare("SELECT project_id FROM canvas_projects").all()).toEqual([]);
    const section = projects.createSection({ ...human, title: "Dashboard" });
    expect(projects.get(projectId)).toMatchObject({
      revision: 1,
      homeViewId: `view_overview_${projectId}`,
      sections: [{ id: section.id }],
    });
    expect(() => projects.removeView({ ...human, id: `view_overview_${projectId}` })).toThrow(
      /Overview/,
    );
    expect(() =>
      projects.updateSection({
        ...human,
        sectionId: section.id,
        title: "Stale",
        expectedRevision: 0,
      }),
    ).toThrow(/changed/);
    expect(projects.getSection(section.id)?.title).toBe("Dashboard");
  });

  it("adopts every board-owned row atomically, preserves global media, resolves old references and returns the same document", () => {
    const { service, sources, projects, db } = board();
    const asset = "shared-asset";
    db.prepare("INSERT INTO assets(id,mime,content) VALUES(?,?,?)").run(
      asset,
      "image/png",
      Buffer.from("image"),
    );
    db.prepare("INSERT INTO canvas_media(asset_id,manifest_json) VALUES(?,?)").run(asset, "{}");
    db.prepare("INSERT INTO canvas_media_variants(asset_id,width,content) VALUES(?,?,?)").run(
      asset,
      64,
      Buffer.from("variant"),
    );
    db.prepare("UPDATE nodes SET asset_id=? WHERE thread_id='origin' AND id='detail'").run(asset);

    const tables = [
      "sections",
      "nodes",
      "edges",
      "canvas_history",
      "canvas_field_versions",
      "canvas_change_actors",
      "canvas_sources",
    ];

    const rows = tables.map((table) =>
      db.prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all("origin"),
    );

    const before = service.board("origin");
    const inspection = service.inspect("origin", "detail");
    const section = projects.adopt({ ...human, threadId: "origin", title: "Live dashboard" });

    for (const [index, table] of tables.entries()) {
      expect(db.prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all("origin")).toEqual([]);

      const moved = z
        .array(z.record(z.string(), z.unknown()))
        .parse(db.prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all(section.id));

      expect(
        moved.map((row) => {
          const normalized = { ...row, thread_id: "origin" };

          if (table !== "canvas_sources") return normalized;

          return { ...normalized, generation: 1, lease_until: 0 };
        }),
      ).toEqual(rows[index]);
    }

    expect(service.board(section.id)).toMatchObject({
      nodes: before?.nodes,
      edges: before?.edges,
      composition: before?.composition,
    });
    expect(projects.resolveBoard({ threadId: "origin" })).toBe(section.id);
    expect(projects.resolveBoard({ sectionId: section.id })).toBe(section.id);
    expect(projects.boardProject("origin")).toBe(projectId);
    expect(projects.get(projectId).views.some((view) => view.regionId === section.id)).toBe(true);
    expect(service.asset(asset)?.content.toString()).toBe("image");
    expect(service.asset(asset, null, 64)?.content.toString()).toBe("variant");
    service.edit(
      section.id,
      {
        id: "detail",
        fields: { title: "After adoption" },
        expectedVersions: inspection.fieldVersions,
      },
      "human",
    );
    expect(() =>
      service.edit(
        section.id,
        { id: "detail", fields: { title: "Stale" }, expectedVersions: inspection.fieldVersions },
        "human",
      ),
    ).toThrow(/conflict/);
    const result = projects.return({ ...human, sectionId: section.id });
    expect(result.removedViews).toHaveLength(1);
    expect(projects.resolveBoard("origin")).toBe("origin");
    expect(projects.get(projectId).sections).toEqual([]);
    expect(service.board("origin")?.nodes.find((node) => node.id === "detail")?.title).toBe(
      "After adoption",
    );
    expect(sources.get("origin", "manual")?.dataset?.rows).toEqual(data.rows);
    expect(service.history("origin").entries.some((entry) => entry.label === "Update detail")).toBe(
      true,
    );
  });

  it("keeps a historical carrying chat reference live only while its board is adopted", () => {
    const { service, sources, projects } = board();
    service.moveBoard("origin", "continuing", () => sources.move("origin", "continuing"));
    expect(projects.resolveBoard("origin")).toBe("origin");
    expect(service.board("origin")).toBeNull();
    expect(service.status("origin")).toMatchObject({ canvas: false, movedTo: "continuing" });

    const section = projects.adopt({
      ...human,
      threadId: "continuing",
      title: "Carried dashboard",
    });

    expect(projects.resolveBoard("origin")).toBe(section.id);
    expect(projects.resolveBoard("continuing")).toBe(section.id);
    expect(service.status("origin")).toMatchObject({ canvas: false, movedTo: section.id });
    expect(service.board(projects.resolveBoard("origin"))?.nodes).toHaveLength(2);
    expect(sources.get(projects.resolveBoard("origin"), "manual")?.dataset?.rows).toEqual(
      data.rows,
    );
    projects.return({ ...human, sectionId: section.id });
    expect(projects.resolveBoard("origin")).toBe("origin");
    expect(service.board("origin")).toBeNull();
    expect(service.status("origin")).toMatchObject({ canvas: false, movedTo: "continuing" });
    expect(service.board("continuing")?.nodes).toHaveLength(2);
    expect(projects.aliases(projectId)).toEqual([]);
  });

  it("preserves non-origin chat cards in free space when returning a section", () => {
    const { host, projects, service, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });

    const placed = projects.updateSection({
      ...human,
      sectionId: section.id,
      x: 1000000,
      y: -1000000,
    });

    const joined = projects.putChat({
      ...human,
      threadId: "joined",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 40,
      y: 50,
      role: "joined",
      state: "resolved",
    });

    const spawned = projects.putChat({
      ...human,
      threadId: "spawned",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 5000,
      y: -5000,
      role: "spawned",
      state: "open",
    });

    const unrelated = projects.putChat({
      ...human,
      threadId: "unrelated",
      anchorKind: "free",
      x: 12,
      y: 34,
      role: "spawned",
      state: "resolved",
    });

    const before = service.board(section.id);
    const snapshot = projects.get(projectId);
    const signals = host.harness.realtimeSignals.length;
    db.exec(
      "CREATE TRIGGER reject_return BEFORE DELETE ON canvas_regions BEGIN SELECT RAISE(ABORT,'return rejected'); END",
    );
    expect(() => projects.return({ ...human, sectionId: section.id })).toThrow(/return rejected/u);
    expect(projects.get(projectId)).toEqual(snapshot);
    expect(service.board(section.id)).toEqual(before);
    expect(projects.resolveBoard("origin")).toBe(section.id);
    expect(
      host.harness.realtimeSignals
        .slice(signals)
        .filter((signal) => signal.channel === "canvas.changed"),
    ).toEqual([]);
    db.exec("DROP TRIGGER reject_return");
    projects.return({ ...human, sectionId: section.id });
    expect(projects.link("origin")).toBeNull();
    expect(projects.link(joined.threadId)).toEqual({
      ...joined,
      regionId: null,
      anchorKind: "free",
      anchorId: null,
      x: placed.x + 40,
      y: placed.y + 50,
    });
    expect(projects.link(spawned.threadId)).toEqual({
      ...spawned,
      regionId: null,
      anchorKind: "free",
      anchorId: null,
      x: 1000000,
      y: -1000000,
    });
    expect(projects.link(unrelated.threadId)).toEqual(unrelated);
    expect(service.board("origin")?.nodes).toEqual(before?.nodes);
    expect(projects.getSection(section.id)).toBeNull();
  });

  it("invalidates historical and linked chat panels immediately after returning a section", () => {
    const { host, projects, service, sources, db } = board();
    service.moveBoard("origin", "continuing", () => sources.move("origin", "continuing"));
    const section = projects.adopt({ ...human, threadId: "continuing", title: "Dashboard" });
    projects.inheritLink("continuing", "joined");
    projects.putChat({
      ...human,
      threadId: "spawned",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 20,
      y: 30,
      role: "spawned",
    });
    service.enable("joined", "user");
    service.enable("spawned", "user");
    const start = host.harness.realtimeSignals.length;
    projects.return({ ...human, sectionId: section.id });

    const signals = host.harness.realtimeSignals
      .slice(start)
      .filter((signal) => signal.channel === "canvas.changed");

    for (const threadId of ["origin", "continuing", "joined", "spawned"]) {
      const revision = z
        .object({ revision: z.number() })
        .parse(
          db.prepare("SELECT revision FROM canvas_threads WHERE thread_id=?").get(threadId),
        ).revision;

      expect(signals).toContainEqual({
        channel: "canvas.changed",
        payload: { threadId, revision },
      });
    }

    expect(service.status("origin").movedTo).toBe("continuing");
    expect(projects.resolveBoard("origin")).toBe("origin");
  });

  it("preserves each origin chat's Canvas toggle while the section stays enabled", () => {
    const { service, projects } = board();
    service.disable("origin");
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    expect(service.isCanvas("origin")).toBe(false);
    expect(service.isCanvas(section.id)).toBe(true);
    service.enable("origin", "user");
    expect(projects.resolveBoard("origin")).toBe(section.id);
    service.disable("origin");
    expect(service.isCanvas(section.id)).toBe(true);
    projects.return({ ...human, sectionId: section.id });
    const second = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    expect(service.isCanvas("origin")).toBe(true);
    expect(service.isCanvas(second.id)).toBe(true);
  });

  it("notifies every linked chat after board and source edits without changing the structural revision", async () => {
    const { host, service, sources, projects } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    projects.inheritLink("origin", "continued");
    const revision = projects.get(projectId).revision;
    service.update(section.id, { id: "lead", title: "Updated" }, "human");
    sources.push(section.id, { sourceId: "manual", ...data, rows: [{ value: 20 }] });
    await new Promise((resolve) => setTimeout(resolve, 80));

    for (const threadId of [section.id, "origin", "continued"]) {
      expect(host.harness.realtimeSignals).toContainEqual({
        channel: "canvas.changed",
        payload: { threadId, revision: service.board(section.id)?.revision },
      });
      expect(host.harness.realtimeSignals).toContainEqual({
        channel: "canvas.sources.changed",
        payload: { threadId, sourceId: "manual", revision: 2 },
      });
    }

    expect(projects.get(projectId).revision).toBe(revision);
    expect(host.harness.realtimeSignals).toContainEqual({
      channel: "canvas.project.changed",
      payload: { projectId, revision },
    });
  });

  it("rolls the entire adoption back when a source move fails after board rows moved", () => {
    const { service, projects, db } = board();
    const before = service.board("origin");
    db.exec(
      "CREATE TRIGGER reject_source_move BEFORE UPDATE OF thread_id ON canvas_sources BEGIN SELECT RAISE(ABORT,'source move rejected'); END",
    );
    expect(() => projects.adopt({ ...human, threadId: "origin", title: "Dashboard" })).toThrow(
      /source move rejected/,
    );
    expect(service.board("origin")).toEqual(before);
    expect(db.prepare("SELECT * FROM canvas_regions").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM canvas_projects").all()).toEqual([]);
    expect(projects.resolveBoard("origin")).toBe("origin");
  });

  it("keeps adopted sections after deleting the origin chat and inherits links without moving content", () => {
    const { service, sources, projects } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    expect(projects.inheritLink("origin", "continued")).toMatchObject({
      regionId: section.id,
      role: "joined",
    });
    expect(projects.resolveBoard("continued")).toBe(section.id);
    const before = service.board(section.id);
    expect(projects.removeThread("origin")).toBe(true);
    sources.remove("origin");
    service.remove("origin");
    expect(service.board(section.id)).toEqual(before);
    expect(sources.get(section.id, "manual")?.dataset?.rows).toEqual(data.rows);
    expect(projects.getSection(section.id)?.originThreadId).toBeNull();
    expect(() => projects.return({ ...human, sectionId: section.id })).toThrow(/no original chat/);
    expect(projects.resolveBoard("continued")).toBe(section.id);
    expect(projects.removeThread("continued")).toBe(true);
    expect(service.board(section.id)).toEqual(before);
  });

  it("enforces agent locks at the board boundary and journals structural edits without losing modules", () => {
    const { service, projects } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    projects.updateSection({ ...human, sectionId: section.id, locked: true });
    expect(() => service.update(section.id, { id: "lead", title: "Agent overwrite" })).toThrow(
      /locked/,
    );
    expect(() => service.undo(section.id)).toThrow(/locked/);
    expect(() =>
      projects.updateSection({ projectId, sectionId: section.id, title: "Agent rename" }),
    ).toThrow(/locked/);
    service.update(section.id, { id: "lead", title: "Owner update" }, "human");
    expect(() =>
      projects.updateSection({ projectId, sectionId: section.id, title: "Unobserved" }),
    ).toThrow(/locked/);
    projects.updateSection({ ...human, sectionId: section.id, title: "Renamed" });
    projects.undo({ ...human });
    expect(projects.getSection(section.id)?.title).toBe("Dashboard");
    expect(service.board(section.id)?.nodes[0]?.title).toBe("Owner update");
    projects.archiveSection({ ...human, sectionId: section.id });
    expect(() =>
      service.update(section.id, { id: "lead", title: "Archived write" }, "human"),
    ).toThrow(/archived/);
    projects.restoreSection({ ...human, sectionId: section.id });
    expect(service.board(section.id)?.nodes[0]?.title).toBe("Owner update");
  });

  it("undoes adoption by returning the content and refuses return into an occupied origin", () => {
    const { service, projects } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    service.enable("origin", "user");
    service.add("origin", [{ id: "new", kind: "note", title: "New work" }]);
    expect(() => projects.return({ ...human, sectionId: section.id })).toThrow(
      /already has a board/,
    );
    expect(service.board(section.id)?.nodes).toHaveLength(2);
    const before = projects.get(projectId);
    expect(() => projects.undo({ ...human })).toThrow(/ownership or content changed/u);
    service.remove("origin");
    expect(() => projects.undo({ ...human })).toThrow(/ownership or content changed/u);
    expect(projects.get(projectId)).toEqual(before);
    expect(service.board(section.id)?.nodes).toHaveLength(2);
  });

  it("serves exactly the Overview the sidebar fixture models, before content and after the last archive", () => {
    const { projects } = fixture();
    expect(projects.get(projectId)).toEqual(emptyServerCanvas(projectId));
    const section = projects.createSection({ ...human, title: "Retired" });
    projects.archiveSection({ ...human, sectionId: section.id });
    expect(projects.get(projectId).views).toEqual([synthesizedOverview(projectId)]);
    expect(projects.get(projectId).sections.every((entry) => entry.archivedAt !== null)).toBe(true);
  });

  it("serves the sidebar fixture after adopting and archiving a board without removing its view", () => {
    const { projects, service } = fixture();
    service.enable("origin", "user");
    service.add("origin", [{ id: "lead", kind: "note", title: "Lead" }]);
    const section = projects.adopt({ ...human, threadId: "origin", title: "Retired" });
    const view = projects.get(projectId).views.find((entry) => entry.regionId === section.id);
    expect(view).toBeDefined();
    projects.archiveSection({ ...human, sectionId: section.id });
    const canvas = projects.get(projectId);
    expect({
      ...canvas,
      sections: canvas.sections.map((entry) => ({
        ...entry,
        createdAt: 1,
        archivedAt: entry.archivedAt === null ? null : 1,
      })),
      views: canvas.views.map((entry) =>
        entry.regionId === null ? entry : { ...entry, createdAt: 1 },
      ),
      chats: canvas.chats.map((entry) => ({ ...entry, createdAt: 1 })),
    }).toEqual(archivedAdoptedCanvas(projectId, section.id, view?.id));
  });

  it("validates view and chat anchors, protects Overview, and preserves free-space chats", () => {
    const { projects } = fixture();
    const section = projects.createSection({ ...human, title: "Dashboard" });

    const view = projects.putView({
      ...human,
      title: "Dashboard view",
      anchorKind: "section",
      regionId: section.id,
      anchorId: section.id,
      rect: { x: 10, y: 20, width: 600, height: 400 },
    });

    projects.setHome({ ...human, id: view.id });
    projects.reorderViews({ ...human, ids: [view.id, `view_overview_${projectId}`] });
    expect(projects.get(projectId).views[0]?.id).toBe(view.id);
    expect(() =>
      projects.putView({
        ...human,
        title: "Missing module",
        anchorKind: "node",
        regionId: section.id,
        anchorId: "missing",
        rect: view.rect,
      }),
    ).toThrow(/Module anchor/);
    expect(() => projects.updateSection({ ...human, sectionId: section.id, x: 1000001 })).toThrow();
    expect(() => projects.getSection(section.id)).not.toThrow();

    const chat = projects.putChat({
      ...human,
      threadId: "free-chat",
      anchorKind: "free",
      x: 400,
      y: 300,
    });

    expect(chat.regionId).toBeNull();
    projects.moveChat({
      ...human,
      threadId: chat.threadId,
      anchorKind: "section",
      regionId: section.id,
      anchorId: section.id,
      x: 10,
      y: 20,
    });
    projects.resolveChat({ ...human, threadId: chat.threadId });
    expect(projects.link(chat.threadId)).toMatchObject({ state: "resolved", regionId: section.id });
    projects.removeView({ ...human, id: view.id });
    expect(projects.get(projectId).homeViewId).toBe(`view_overview_${projectId}`);
  });

  it("tracks chat-anchored views atomically through section moves, free placement and undo", () => {
    const { projects, db } = fixture();
    const first = projects.createSection({ ...human, title: "First" });
    const second = projects.createSection({ ...human, title: "Second" });

    const chat = projects.putChat({
      ...human,
      threadId: "moving",
      regionId: first.id,
      anchorKind: "section",
      anchorId: first.id,
      x: 20,
      y: 30,
      role: "spawned",
    });

    projects.join({ ...human, threadId: "view-author", sectionId: first.id });

    const view = projects.putView({
      projectId,
      actor: "agent",
      actingThreadId: "view-author",
      title: "Follow this chat",
      anchorKind: "chat",
      regionId: first.id,
      anchorId: chat.threadId,
      rect: { x: 12, y: 18, width: 440, height: 320 },
    });

    const before = projects.get(projectId);
    projects.moveChat({
      ...human,
      threadId: chat.threadId,
      regionId: second.id,
      anchorKind: "section",
      anchorId: second.id,
      x: 50,
      y: 60,
    });
    expect(projects.get(projectId).views.find((entry) => entry.id === view.id)).toEqual({
      ...view,
      regionId: second.id,
    });
    expect(projects.link(chat.threadId)?.regionId).toBe(second.id);
    expect(
      projects.putView({
        ...human,
        id: view.id,
        title: "Renamed in second section",
        anchorKind: "chat",
        regionId: second.id,
        anchorId: chat.threadId,
        rect: view.rect,
      }).title,
    ).toBe("Renamed in second section");
    projects.undo({ ...human });
    expect(projects.get(projectId).views.find((entry) => entry.id === view.id)).toEqual({
      ...view,
      regionId: second.id,
    });
    projects.undo({ ...human });
    expect({ ...projects.get(projectId), revision: before.revision }).toEqual(before);
    const journal = projects.journal(projectId);
    const snapshot = projects.get(projectId);
    db.exec(
      "CREATE TRIGGER reject_chat_view_move BEFORE UPDATE ON canvas_views WHEN OLD.anchor_kind='chat' BEGIN SELECT RAISE(ABORT,'chat view move rejected'); END",
    );
    expect(() =>
      projects.moveChat({
        ...human,
        threadId: chat.threadId,
        regionId: second.id,
        anchorKind: "section",
        anchorId: second.id,
        x: 50,
        y: 60,
      }),
    ).toThrow(/chat view move rejected/u);
    expect(projects.get(projectId)).toEqual(snapshot);
    expect(projects.journal(projectId)).toEqual(journal);
    db.exec("DROP TRIGGER reject_chat_view_move");
    projects.moveChat({
      ...human,
      threadId: chat.threadId,
      regionId: null,
      anchorKind: "free",
      anchorId: null,
      x: 500,
      y: 600,
    });
    const freeView = projects.get(projectId).views.find((entry) => entry.id === view.id);
    expect(freeView).toEqual({ ...view, regionId: null });
    expect(
      projects.putView({
        ...human,
        id: view.id,
        title: "Renamed after moving",
        anchorKind: "chat",
        regionId: null,
        anchorId: chat.threadId,
        rect: view.rect,
      }).title,
    ).toBe("Renamed after moving");
  });

  it("keeps saved chat views when returning their section and removes only views whose anchors leave", () => {
    const { projects, service, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });

    const automatic = projects
      .get(projectId)
      .views.find((entry) => entry.anchorKind === "section" && entry.regionId === section.id);

    if (automatic === undefined) throw new Error("Adoption view missing");

    const spawned = projects.putChat({
      ...human,
      threadId: "spawned-view",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 50,
      y: 60,
      role: "spawned",
    });

    const joined = projects.join({ ...human, threadId: "joined-view", sectionId: section.id });
    const rect = { x: 10, y: 20, width: 440, height: 320 };

    const chatView = projects.putView({
      projectId,
      actor: "agent",
      actingThreadId: "origin",
      title: "Spawned chat",
      anchorKind: "chat",
      regionId: section.id,
      anchorId: spawned.threadId,
      rect,
    });

    const joinedView = projects.putView({
      ...human,
      title: "Joined chat",
      anchorKind: "chat",
      regionId: section.id,
      anchorId: joined.threadId,
      rect,
    });

    const originView = projects.putView({
      ...human,
      title: "Original chat",
      anchorKind: "chat",
      regionId: section.id,
      anchorId: "origin",
      rect,
    });

    const nodeView = projects.putView({
      ...human,
      title: "Lead module",
      anchorKind: "node",
      regionId: section.id,
      anchorId: "lead",
      rect,
    });

    const islandView = projects.putView({
      ...human,
      title: "Evidence island",
      anchorKind: "island",
      regionId: section.id,
      anchorId: "evidence",
      rect,
    });

    const freeView = projects.putView({
      ...human,
      title: "Free overview",
      anchorKind: "free",
      rect,
    });

    projects.setHome({ ...human, id: chatView.id });
    const before = projects.get(projectId);
    const content = service.board(section.id);
    db.exec(
      "CREATE TRIGGER reject_view_return BEFORE DELETE ON canvas_regions BEGIN SELECT RAISE(ABORT,'view return rejected'); END",
    );
    expect(() => projects.return({ ...human, sectionId: section.id })).toThrow(
      /view return rejected/u,
    );
    expect(projects.get(projectId)).toEqual(before);
    expect(service.board(section.id)).toEqual(content);
    db.exec("DROP TRIGGER reject_view_return");
    const returned = projects.return({ ...human, sectionId: section.id });
    const after = projects.get(projectId);
    expect(after.views.find((entry) => entry.id === chatView.id)).toEqual({
      ...chatView,
      regionId: null,
    });
    expect(after.views.find((entry) => entry.id === joinedView.id)).toEqual({
      ...joinedView,
      regionId: null,
    });
    expect(after.views.find((entry) => entry.id === freeView.id)).toEqual(freeView);
    expect(after.homeViewId).toBe(chatView.id);
    expect(returned.removedViews.sort()).toEqual(
      [automatic.id, originView.id, nodeView.id, islandView.id].sort(),
    );
    expect(
      projects.putView({
        ...human,
        id: chatView.id,
        title: "Renamed after return",
        anchorKind: "chat",
        regionId: null,
        anchorId: spawned.threadId,
        rect,
      }).title,
    ).toBe("Renamed after return");
    expect(service.board("origin")?.nodes).toEqual(content?.nodes);
  });

  it("undoes a returned section without dangling views or losing its board and sources", () => {
    const { projects, service, sources } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });

    const chat = projects.putChat({
      ...human,
      threadId: "working",
      regionId: section.id,
      anchorKind: "section",
      anchorId: section.id,
      x: 20,
      y: 40,
      role: "spawned",
    });

    projects.putView({
      ...human,
      title: "Follow working chat",
      anchorKind: "chat",
      regionId: section.id,
      anchorId: chat.threadId,
      rect: { x: 0, y: 0, width: 440, height: 320 },
    });
    const before = projects.get(projectId);
    const content = service.board(section.id);
    const source = sources.get(section.id, "manual");
    projects.return({ ...human, sectionId: section.id });
    const returned = projects.get(projectId);
    const entry = projects.journal(projectId)[0];
    expect(entry?.label).toBe("Return section to chat");
    expect(entry?.revision).toBe(returned.revision);
    expect(projects.historyOrigins(projectId, "undo", entry?.id)).toEqual(["origin", "working"]);
    projects.undo({ ...human, changeId: entry?.id });
    expect({ ...projects.get(projectId), revision: before.revision }).toEqual(before);
    expect(service.board(section.id)?.nodes).toEqual(content?.nodes);
    expect(sources.get(section.id, "manual")).toEqual(source);
    expect(projects.resolveBoard("origin")).toBe(section.id);
    projects.redo({ ...human, changeId: entry?.id });
    expect({ ...projects.get(projectId), revision: returned.revision }).toEqual(returned);
    expect(service.board("origin")?.nodes).toEqual(content?.nodes);
    expect(sources.get("origin", "manual")).toEqual(source);
    expect(projects.getSection(section.id)).toBeNull();
    expect(projects.journal(projectId).find((change) => change.id === entry?.id)?.revision).toBe(
      entry?.revision,
    );
  });

  it("redoes structural create and view edits with the same identities and creator metadata", () => {
    const { projects, service } = fixture();
    const section = projects.createSection({ ...human, title: "Dashboard" });
    service.add(section.id, [{ id: "retained", kind: "note", title: "Keep content" }]);
    projects.undo({ ...human });
    expect(projects.getSection(section.id)?.archivedAt).not.toBeNull();
    expect(service.board(section.id)?.nodes[0]?.title).toBe("Keep content");
    projects.redo({ ...human });
    expect(projects.getSection(section.id)).toEqual(section);
    expect(service.board(section.id)?.nodes[0]?.title).toBe("Keep content");

    const view = projects.putView({
      ...human,
      title: "Saved view",
      anchorKind: "section",
      regionId: section.id,
      anchorId: section.id,
      rect: { x: 10, y: 20, width: 600, height: 400 },
    });

    projects.undo({ ...human });
    projects.redo({ ...human });
    expect(projects.get(projectId).views.find((entry) => entry.id === view.id)).toEqual(view);
  });

  it("round-trips adoption ownership, historical aliases, source generations and actual chat attribution", () => {
    const { projects, service, sources, db } = board();
    service.moveBoard("origin", "continued", () => sources.move("origin", "continued"));
    service.disable("continued");
    const section = projects.adopt({ ...human, threadId: "continued", title: "Carried dashboard" });
    const entry = projects.journal(projectId)[0];
    const adopted = projects.get(projectId);

    const mode = db
      .prepare(
        "SELECT enabled,started_by,moved_to,carried_from FROM canvas_threads WHERE thread_id='continued'",
      )
      .get();

    const content = service.board(section.id);
    const source = sources.get(section.id, "manual");

    const generation = z
      .object({ generation: z.number() })
      .parse(
        db.prepare("SELECT generation FROM canvas_sources WHERE thread_id=?").get(section.id),
      ).generation;

    const actor = projects.changesByChat(projectId, "origin");
    expect(projects.historyOrigins(projectId, "undo", entry?.id)).toEqual(["continued", "origin"]);
    projects.undo({ ...human, changeId: entry?.id });
    expect(projects.getSection(section.id)).toBeNull();
    expect(projects.aliases(projectId)).toEqual([]);
    expect(service.status("origin").movedTo).toBe("continued");
    expect(service.isCanvas("continued")).toBe(false);
    expect(sources.get("continued", "manual")).toEqual(source);
    expect(
      db.prepare("SELECT carried_from FROM canvas_threads WHERE thread_id='continued'").get(),
    ).toEqual({ carried_from: "origin" });
    projects.redo({ ...human, changeId: entry?.id });
    expect({ ...projects.get(projectId), revision: adopted.revision }).toEqual(adopted);
    expect(projects.resolveBoard("origin")).toBe(section.id);
    expect(projects.resolveBoard("continued")).toBe(section.id);
    expect(
      db
        .prepare(
          "SELECT enabled,started_by,moved_to,carried_from FROM canvas_threads WHERE thread_id='continued'",
        )
        .get(),
    ).toEqual(mode);
    expect(service.board(section.id)?.nodes).toEqual(content?.nodes);
    expect(sources.get(section.id, "manual")).toEqual(source);

    const refreshedGeneration = z
      .object({ generation: z.number(), lease_until: z.number() })
      .parse(
        db
          .prepare("SELECT generation,lease_until FROM canvas_sources WHERE thread_id=?")
          .get(section.id),
      );

    expect(refreshedGeneration.generation).toBeGreaterThan(generation);
    expect(refreshedGeneration.lease_until).toBe(0);
    expect(projects.changesByChat(projectId, "origin")).toEqual(actor);
    expect(projects.journal(projectId).find((change) => change.id === entry?.id)).toMatchObject({
      state: "applied",
      revision: entry?.revision,
      actor: "human",
    });
  });

  it("round-trips section move, rename, archive, saved views and home selection in undo order", () => {
    const { projects } = fixture();
    const section = projects.createSection({ ...human, title: "Dashboard" });

    const view = projects.putView({
      ...human,
      title: "Dashboard view",
      anchorKind: "section",
      regionId: section.id,
      anchorId: section.id,
      rect: { x: 0, y: 0, width: 600, height: 400 },
    });

    const base = projects.get(projectId);
    projects.setHome({ ...human, id: view.id });
    projects.updateSection({ ...human, sectionId: section.id, title: "Renamed", x: 800, y: 400 });
    projects.archiveSection({ ...human, sectionId: section.id });
    const after = projects.get(projectId);
    projects.undo({ ...human });
    projects.undo({ ...human });
    projects.undo({ ...human });
    expect({ ...projects.get(projectId), revision: base.revision }).toEqual(base);
    projects.redo({ ...human });
    projects.redo({ ...human });
    projects.redo({ ...human });
    expect({ ...projects.get(projectId), revision: after.revision }).toEqual(after);
    expect(projects.get(projectId).views.find((entry) => entry.id === view.id)).toEqual(view);
  });

  it("rejects stale, locked, unsafe legacy and concurrent ownership replay without changing the project", () => {
    const { projects, service, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    const adoption = projects.journal(projectId)[0];
    const before = projects.get(projectId);
    service.update(section.id, { id: "lead", title: "Newer board work" });
    expect(() => projects.undo({ ...human, changeId: adoption?.id })).toThrow(
      /ownership or content changed/u,
    );
    expect(projects.get(projectId)).toEqual(before);
    expect(service.board(section.id)?.nodes[0]?.title).toBe("Newer board work");
    projects.updateSection({ ...human, sectionId: section.id, locked: true });
    const locked = projects.get(projectId);
    expect(() =>
      projects.undo({ projectId, actor: "agent", expectedRevision: locked.revision }),
    ).toThrow(/locked/u);
    expect(() => projects.undo({ ...human, expectedRevision: locked.revision - 1 })).toThrow(
      /changed/u,
    );
    expect(projects.get(projectId)).toEqual(locked);
    projects.undo({ ...human });

    const row = z
      .object({ before_json: z.string(), after_json: z.string() })
      .parse(
        db
          .prepare("SELECT before_json,after_json FROM canvas_project_journal WHERE id=?")
          .get(adoption?.id),
      );

    const clean = (value: string) =>
      JSON.stringify(
        z
          .object({ ownership: z.unknown().optional() })
          .passthrough()
          .transform(({ ownership: _ownership, ...snapshot }) => snapshot)
          .parse(JSON.parse(value)),
      );

    db.prepare("UPDATE canvas_project_journal SET before_json=?,after_json=? WHERE id=?").run(
      clean(row.before_json),
      clean(row.after_json),
      adoption?.id,
    );
    expect(() => projects.undo({ ...human, changeId: adoption?.id })).toThrow(
      /no safe replay evidence/u,
    );
  });

  it("rolls back failed ownership undo and redo while preserving board and journal state", () => {
    const { projects, service, sources, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    const entry = projects.journal(projectId)[0];
    const before = projects.get(projectId);
    const content = service.board(section.id);
    const source = sources.get(section.id, "manual");
    db.exec(
      "CREATE TRIGGER reject_history_update BEFORE UPDATE ON canvas_project_journal BEGIN SELECT RAISE(ABORT,'history update rejected'); END",
    );
    expect(() => projects.undo({ ...human, changeId: entry?.id })).toThrow(
      /history update rejected/u,
    );
    expect(projects.get(projectId)).toEqual(before);
    expect(service.board(section.id)).toEqual(content);
    expect(sources.get(section.id, "manual")).toEqual(source);
    expect(projects.resolveBoard("origin")).toBe(section.id);
    expect(projects.journal(projectId)[0]).toEqual(entry);
    db.exec("DROP TRIGGER reject_history_update");
    projects.undo({ ...human, changeId: entry?.id });
    const undone = projects.get(projectId);
    db.exec(
      "CREATE TRIGGER reject_history_redo BEFORE UPDATE ON canvas_project_journal BEGIN SELECT RAISE(ABORT,'history redo rejected'); END",
    );
    expect(() => projects.redo({ ...human, changeId: entry?.id })).toThrow(
      /history redo rejected/u,
    );
    expect(projects.get(projectId)).toEqual(undone);
    expect(service.board("origin")?.nodes).toEqual(content?.nodes);
    expect(sources.get("origin", "manual")).toEqual(source);
    expect(projects.getSection(section.id)).toBeNull();
    db.exec("DROP TRIGGER reject_history_redo");
  });

  it("refuses metadata replay that would overwrite another project's chat link", () => {
    const { projects } = fixture();
    projects.createSection({ ...human, title: "Dashboard" });
    projects.putChat({ ...human, threadId: "reused-chat", anchorKind: "free", x: 10, y: 20 });
    const entry = projects.journal(projectId)[0];
    projects.undo({ ...human, changeId: entry?.id });

    const foreign = projects.putChat({
      projectId: "foreign-project",
      actor: "human",
      threadId: "reused-chat",
      anchorKind: "free",
      x: 500,
      y: 600,
    });

    const before = projects.get(projectId);
    expect(() => projects.redo({ ...human, changeId: entry?.id })).toThrow(/another project/u);
    expect(projects.get(projectId)).toEqual(before);
    expect(projects.link("reused-chat")).toEqual(foreign);
  });

  it("refuses to restore a saved view whose module was removed after the structural entry", () => {
    const { projects, service } = fixture();
    const section = projects.createSection({ ...human, title: "Dashboard" });
    service.add(section.id, [{ id: "retired", kind: "note", title: "Retired module" }]);

    const view = projects.putView({
      ...human,
      title: "Module view",
      anchorKind: "node",
      regionId: section.id,
      anchorId: "retired",
      rect: { x: 0, y: 0, width: 500, height: 400 },
    });

    projects.removeView({ ...human, id: view.id });
    const removal = projects.journal(projectId)[0];
    service.archive(section.id, ["retired"], "human");
    const before = projects.get(projectId);
    expect(() => projects.undo({ ...human, changeId: removal?.id })).toThrow(/Module anchor/u);
    expect(projects.get(projectId)).toEqual(before);
    expect(projects.journal(projectId)[0]?.state).toBe("applied");
  });

  it("prevents an agent from changing a section lock by replaying an owner entry", () => {
    const { projects } = fixture();
    const section = projects.createSection({ ...human, title: "Dashboard" });
    projects.updateSection({ ...human, sectionId: section.id, locked: true });
    const entry = projects.journal(projectId)[0];
    projects.undo({ ...human, changeId: entry?.id });
    const before = projects.get(projectId);
    expect(() =>
      projects.redo({
        projectId,
        actor: "agent",
        changeId: entry?.id,
        expectedRevision: before.revision,
      }),
    ).toThrow(/locked/u);
    expect(projects.get(projectId)).toEqual(before);
  });

  it("requires an observed project revision for agent structural edits and keeps undo reversible", () => {
    const { projects } = fixture();

    const first = projects.createSection({
      projectId,
      title: "First",
      actingThreadId: "agent-chat",
    });

    projects.updateSection({ ...human, sectionId: first.id, title: "Owner rename" });
    expect(() =>
      projects.updateSection({ projectId, sectionId: first.id, title: "Unobserved overwrite" }),
    ).toThrow(/expectedRevision/);
    const current = projects.get(projectId).revision;
    projects.updateSection({
      projectId,
      sectionId: first.id,
      title: "Observed edit",
      expectedRevision: current,
      actingThreadId: "agent-chat",
    });
    expect(projects.journal(projectId)[0]?.actor).toBe("agent-chat");
    expect(() =>
      projects.updateSection({
        projectId,
        sectionId: first.id,
        title: "Stale",
        expectedRevision: current,
      }),
    ).toThrow(/changed/);
    projects.createSection({ ...human, title: "Second" });
    projects.undo({ ...human });
    expect(
      projects.get(projectId).sections.filter((section) => section.archivedAt === null),
    ).toHaveLength(1);
    projects.undo({ ...human });
    expect(projects.getSection(first.id)?.title).toBe("Owner rename");
  });

  it("attributes exact history targets to two chats without guessing or duplicating records", () => {
    const { service, projects, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    projects.inheritLink("origin", "joined");
    const update = service.update(section.id, { id: "lead", title: "Joined edit" });
    projects.recordChange("origin", update.changeId, "joined");
    projects.recordChange(section.id, update.changeId, "joined");
    expect(
      projects
        .changesByChat(projectId, "origin")
        .map((entry) => entry.nodeId)
        .sort(),
    ).toEqual(["detail", "lead"]);
    expect(projects.changesByChat(projectId, "joined")).toEqual([
      { sectionId: section.id, nodeId: "lead", changeId: update.changeId },
    ]);
    const unchanged = service.update(section.id, { id: "lead", title: "Joined edit" });
    expect(unchanged.changeId).toBeNull();
    projects.recordChange(section.id, unchanged.changeId, "joined");
    projects.recordChange(section.id, undefined, "joined");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM canvas_change_actors WHERE actor_thread_id='joined'",
        )
        .get(),
    ).toEqual({ count: 1 });
    const undone = service.undo(section.id, update.changeId ?? undefined, "agent");
    projects.recordChange(section.id, undone.changeId, "origin");
    expect(projects.changesByChat(projectId, "joined")).toContainEqual({
      sectionId: section.id,
      nodeId: "lead",
      changeId: update.changeId,
    });
    expect(projects.changesByChat(projectId, "origin")).toContainEqual({
      sectionId: section.id,
      nodeId: "lead",
      changeId: update.changeId,
    });
    const redone = service.redo(section.id, undone.changeId, "agent");
    projects.recordChange(section.id, redone.changeId, "joined");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM canvas_change_actors WHERE thread_id=? AND change_id=?",
        )
        .get(section.id, update.changeId),
    ).toEqual({ count: 2 });
  });

  it("rekeys attribution with adoption and return while preserving both acting chats", () => {
    const { service, projects, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    projects.inheritLink("origin", "joined");
    const changed = service.update(section.id, { id: "lead", title: "Changed by joined" });
    projects.recordChange("origin", changed.changeId, "joined");

    const row = z.object({
      thread_id: z.string(),
      change_id: z.string(),
      actor_thread_id: z.string(),
    });

    const before = z
      .array(row)
      .parse(
        db
          .prepare(
            "SELECT * FROM canvas_change_actors WHERE thread_id=? ORDER BY change_id,actor_thread_id",
          )
          .all(section.id),
      );

    expect(before.map((entry) => entry.actor_thread_id).sort()).toEqual(["joined", "origin"]);
    expect(db.prepare("SELECT * FROM canvas_change_actors WHERE thread_id='origin'").all()).toEqual(
      [],
    );
    projects.return({ ...human, sectionId: section.id });

    const after = z
      .array(row)
      .parse(
        db
          .prepare(
            "SELECT * FROM canvas_change_actors WHERE thread_id='origin' ORDER BY change_id,actor_thread_id",
          )
          .all(),
      );

    expect(after).toEqual(before.map((entry) => ({ ...entry, thread_id: "origin" })));
    expect(
      db.prepare("SELECT * FROM canvas_change_actors WHERE thread_id=?").all(section.id),
    ).toEqual([]);
    const readopted = projects.adopt({ ...human, threadId: "origin", title: "Dashboard again" });
    expect(projects.changesByChat(projectId, "joined")).toEqual([
      { sectionId: readopted.id, nodeId: "lead", changeId: changed.changeId },
    ]);
  });

  it("rejects invented and cross-project attribution and excludes layout-only or deleted module targets", () => {
    const { service, projects, db } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    projects.inheritLink("origin", "joined");
    expect(() => projects.recordChange(section.id, "invented", "joined")).toThrow(/retained/);
    projects.join({ projectId: "other-project", threadId: "outsider", actor: "human" });
    const edited = service.update(section.id, { id: "lead", title: "Real edit" });
    expect(() => projects.recordChange(section.id, edited.changeId, "outsider")).toThrow(/join/);
    projects.recordChange(section.id, edited.changeId, "joined");
    expect(projects.changesByChat("other-project", "joined")).toEqual([]);

    const arranged = service.compose(section.id, {
      composition: {
        width: 1600,
        root: { flow: "row", children: [{ node: "lead" }, { node: "detail" }] },
      },
    });

    projects.recordChange(section.id, arranged.changeId, "joined");
    expect(
      projects
        .changesByChat(projectId, "joined")
        .some((entry) => entry.changeId === arranged.changeId),
    ).toBe(false);
    service.archive(section.id, ["lead"], "human");
    expect(projects.changesByChat(projectId, "joined")).toEqual([]);
    expect(projects.changesByChat(projectId, "origin").map((entry) => entry.nodeId)).toEqual([
      "detail",
    ]);
    db.prepare("DELETE FROM nodes WHERE thread_id=? AND id='detail'").run(section.id);
    expect(projects.changesByChat(projectId, "origin")).toEqual([]);
    expect(service.history(section.id).entries.length).toBeGreaterThan(0);
  });

  it("restores a returning project without overwriting individual section archive flags", () => {
    const { projects, service } = board();
    const active = projects.adopt({ ...human, threadId: "origin", title: "Active" });
    const archived = projects.createSection({ ...human, title: "Already archived" });
    projects.archiveSection({ ...human, sectionId: archived.id });

    const flags = projects
      .get(projectId)
      .sections.map((section) => [section.id, section.archivedAt]);

    expect(projects.reconcile([], 1000)).toEqual([projectId]);
    expect(projects.get(projectId).archivedAt).toBe(1000);
    expect(
      projects.get(projectId).sections.map((section) => [section.id, section.archivedAt]),
    ).toEqual(flags);
    expect(() =>
      service.update(active.id, { id: "lead", title: "Archived project write" }, "human"),
    ).toThrow(/project canvas is archived/);
    expect(projects.reconcile([projectId], 2000)).toEqual([projectId]);
    expect(projects.get(projectId).archivedAt).toBeNull();
    expect(
      projects.get(projectId).sections.map((section) => [section.id, section.archivedAt]),
    ).toEqual(flags);
    service.update(active.id, { id: "lead", title: "Restored" }, "human");
    expect(service.board(active.id)?.nodes[0]?.title).toBe("Restored");
    expect(() => service.add(archived.id, [{ id: "hidden", kind: "note" }], "human")).toThrow(
      /section is archived/,
    );
    expect(projects.reconcile([projectId], 3000)).toEqual([]);
    expect(() => projects.reconcile([""], 4000)).toThrow();
    expect(() => projects.reconcile([], NaN)).toThrow();
    expect(projects.get(projectId).archivedAt).toBeNull();
  });

  it("retires only a still-missing project at exactly thirty days and preserves other boards and shared media", () => {
    const { projects, service, sources, db } = board();
    const retiring = projects.adopt({ ...human, threadId: "origin", title: "Retiring" });
    const extra = projects.createSection({ ...human, title: "Archived section" });
    projects.archiveSection({ ...human, sectionId: extra.id });
    service.enable("foreign-origin", "user");

    const foreignAdded = service.add("foreign-origin", [
      { id: "foreign", kind: "note", title: "Foreign board" },
    ]);

    projects.recordChange("foreign-origin", foreignAdded.changeId, "foreign-origin");
    const keptProject = "kept-project";

    const kept = projects.adopt({
      projectId: keptProject,
      threadId: "foreign-origin",
      title: "Keep",
      actor: "human",
    });

    service.add("origin", [{ id: "literal", kind: "note", title: "Literal origin board" }]);
    sources.upsert(
      "origin",
      sourceInputSchema.parse({ id: "literal", title: "Literal source", provider: "manual" }),
    );
    sources.upsert(
      kept.id,
      sourceInputSchema.parse({ id: "foreign", title: "Foreign source", provider: "manual" }),
    );

    for (const id of ["exclusive", "shared", "pending-foreign"]) {
      db.prepare("INSERT INTO assets(id,mime,content) VALUES(?,?,?)").run(
        id,
        "image/png",
        Buffer.from(id),
      );
      db.prepare("INSERT INTO canvas_media(asset_id,manifest_json) VALUES(?,?)").run(id, "{}");
      db.prepare("INSERT INTO canvas_media_variants(asset_id,width,content) VALUES(?,?,?)").run(
        id,
        64,
        Buffer.from(`variant-${id}`),
      );
      db.prepare("INSERT INTO canvas_media_failures(asset_id,message) VALUES(?,?)").run(
        id,
        "Synthetic failure",
      );
    }

    db.prepare("UPDATE nodes SET asset_id='exclusive' WHERE thread_id=? AND id='lead'").run(
      retiring.id,
    );
    db.prepare("UPDATE nodes SET asset_id='shared' WHERE thread_id=? AND id='detail'").run(
      retiring.id,
    );
    db.prepare("UPDATE nodes SET asset_id='shared' WHERE thread_id=? AND id='foreign'").run(
      kept.id,
    );
    db.prepare(
      "UPDATE nodes SET asset_id='shared' WHERE thread_id='origin' AND id='literal'",
    ).run();
    const literal = service.board("origin");
    const foreign = service.board(kept.id);
    const foreignSources = sources.list(kept.id);
    const literalSources = sources.list("origin");
    const keeper = projects.get(keptProject);
    const before = service.board(retiring.id);
    const archivedAt = 10000;
    const deadline = archivedAt + 30 * 24 * 60 * 60 * 1000;
    expect(projects.reconcile([keptProject], archivedAt)).toEqual([projectId]);
    expect(projects.reconcile([keptProject], deadline - 1)).toEqual([]);
    expect(service.board(retiring.id)).toEqual(before);
    expect(projects.get(projectId).archivedAt).toBe(archivedAt);
    expect(projects.reconcile([keptProject], deadline)).toEqual([projectId]);

    for (const table of [
      "canvas_threads",
      "sections",
      "nodes",
      "edges",
      "canvas_history",
      "canvas_field_versions",
      "canvas_change_actors",
      "canvas_sources",
    ])
      for (const key of [retiring.id, extra.id])
        expect(db.prepare(`SELECT * FROM ${table} WHERE thread_id=?`).all(key)).toEqual([]);

    for (const table of [
      "canvas_projects",
      "canvas_regions",
      "canvas_views",
      "canvas_chats",
      "canvas_project_journal",
    ])
      expect(db.prepare(`SELECT * FROM ${table} WHERE project_id=?`).all(projectId)).toEqual([]);
    expect(projects.resolveBoard("origin")).toBe("origin");
    expect(projects.resolveBoard("foreign-origin")).toBe(kept.id);
    expect(service.board("origin")).toEqual(literal);
    expect(service.board(kept.id)).toEqual(foreign);
    expect(sources.list("origin")).toEqual(literalSources);
    expect(sources.list(kept.id)).toEqual(foreignSources);
    expect(projects.get(keptProject)).toEqual(keeper);
    expect(projects.changesByChat(keptProject, "foreign-origin")).toHaveLength(1);
    expect(service.asset("exclusive")).toBeNull();
    expect(service.asset("shared")?.content.toString()).toBe("shared");
    expect(service.asset("pending-foreign")?.content.toString()).toBe("pending-foreign");

    for (const table of ["canvas_media", "canvas_media_variants", "canvas_media_failures"]) {
      expect(db.prepare(`SELECT asset_id FROM ${table} WHERE asset_id='exclusive'`).all()).toEqual(
        [],
      );
      expect(
        db
          .prepare(
            `SELECT asset_id FROM ${table} WHERE asset_id IN ('shared','pending-foreign') ORDER BY asset_id`,
          )
          .all(),
      ).toEqual([{ asset_id: "pending-foreign" }, { asset_id: "shared" }]);
    }

    expect(projects.reconcile([keptProject], deadline + 1)).toEqual([]);
  });

  it("archives deleted projects without deleting board content", () => {
    const { projects, service } = board();
    const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
    expect(projects.reconcile([])).toEqual([projectId]);
    expect(projects.get(projectId).archivedAt).not.toBeNull();
    expect(projects.getSection(section.id)?.archivedAt).toBeNull();
    expect(service.board(section.id)?.nodes).toHaveLength(2);
    expect(() => projects.createSection({ ...human, title: "Another" })).toThrow(/archived/);
  });
});

it("invalidates a refresh across adoption and return without letting stale work replace the dataset", async () => {
  let release: ((value: LoadedSource) => void) | undefined;
  let started: (() => void) | undefined;

  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  const pending = new Promise<LoadedSource>((resolve) => {
    release = resolve;
  });

  const { service, sources, projects, db } = fixture(async () => {
    started?.();

    return pending;
  });

  service.enable("origin", "user");
  service.add("origin", [{ id: "lead", kind: "note", title: "Lead" }]);
  sources.upsert(
    "origin",
    sourceInputSchema.parse({
      id: "remote",
      title: "Remote",
      provider: "json",
      intervalSeconds: 60,
      config: { url: "https://example.com/data", columns: data.columns },
    }),
  );
  const refresh = sources.refresh("origin", "remote");
  await ready;
  const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
  projects.return({ ...human, sectionId: section.id });
  db.prepare("UPDATE canvas_sources SET lease_until=? WHERE thread_id=? AND id=?").run(
    123456,
    "origin",
    "remote",
  );
  release?.(data);
  await refresh;
  expect(sources.get("origin", "remote")?.dataset).toBeNull();
  expect(
    db
      .prepare("SELECT lease_until FROM canvas_sources WHERE thread_id=? AND id=?")
      .get("origin", "remote"),
  ).toEqual({ lease_until: 123456 });
});

it("pauses polling archived sections and resumes without changing source preferences", async () => {
  let loads = 0;

  const { service, sources, projects, db } = fixture(async () => {
    loads++;

    return data;
  });

  service.enable("origin", "user");
  service.add("origin", [{ id: "lead", kind: "note", title: "Lead" }]);
  sources.upsert(
    "origin",
    sourceInputSchema.parse({
      id: "remote",
      title: "Remote",
      provider: "json",
      intervalSeconds: 60,
      config: { url: "https://example.com/data", columns: data.columns },
    }),
  );
  const section = projects.adopt({ ...human, threadId: "origin", title: "Dashboard" });
  db.prepare("UPDATE canvas_sources SET next_refresh_at=0 WHERE thread_id=?").run(section.id);
  projects.archiveSection({ ...human, sectionId: section.id });
  await sources.poll();
  expect(loads).toBe(0);
  expect(sources.get(section.id, "remote")?.source.definition.paused).toBe(false);
  projects.restoreSection({ ...human, sectionId: section.id });
  await sources.poll();
  expect(loads).toBe(1);
});

it("pauses a missing project's source polling, rejects late refresh data, and resumes on restoration", async () => {
  let release: ((value: LoadedSource) => void) | undefined;
  let started: (() => void) | undefined;

  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  const pending = new Promise<LoadedSource>((resolve) => {
    release = resolve;
  });

  let loads = 0;

  const { service, sources, projects, db } = fixture(async () => {
    loads++;

    if (loads !== 1) return { ...data, rows: [{ value: 20 }] };
    started?.();

    return pending;
  });

  const section = projects.createSection({ ...human, title: "Dashboard" });
  service.add(section.id, [{ id: "lead", kind: "note", title: "Lead" }]);
  sources.upsert(
    section.id,
    sourceInputSchema.parse({
      id: "remote",
      title: "Remote",
      provider: "json",
      intervalSeconds: 60,
      config: { url: "https://example.com/data", columns: data.columns },
    }),
  );
  db.prepare("UPDATE canvas_sources SET next_refresh_at=0 WHERE thread_id=?").run(section.id);
  const polling = sources.poll();
  await ready;
  projects.reconcile([], 1000);
  expect(projects.getSection(section.id)?.archivedAt).toBeNull();
  release?.(data);
  await polling;
  expect(sources.get(section.id, "remote")?.dataset).toBeNull();
  db.prepare("UPDATE canvas_sources SET next_refresh_at=0 WHERE thread_id=?").run(section.id);
  await sources.poll();
  expect(loads).toBe(1);
  await expect(sources.refresh(section.id, "remote")).rejects.toThrow(/archived/);
  projects.reconcile([projectId], 2000);
  await sources.poll();
  expect(loads).toBe(2);
  expect(sources.get(section.id, "remote")?.dataset?.rows).toEqual([{ value: 20 }]);
  expect(sources.get(section.id, "remote")?.source.definition.paused).toBe(false);
});

it("never recreates a retired source when an earlier refresh completes late", async () => {
  let release: ((value: LoadedSource) => void) | undefined;
  let started: (() => void) | undefined;

  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });

  const pending = new Promise<LoadedSource>((resolve) => {
    release = resolve;
  });

  const { sources, projects, db } = fixture(async () => {
    started?.();

    return pending;
  });

  const section = projects.createSection({ ...human, title: "Dashboard" });
  sources.upsert(
    section.id,
    sourceInputSchema.parse({
      id: "remote",
      title: "Remote",
      provider: "json",
      config: { url: "https://example.com/data", columns: data.columns },
    }),
  );
  const refreshing = expect(sources.refresh(section.id, "remote")).rejects.toThrow(/removed/u);
  await ready;
  projects.reconcile([], 1000);
  projects.reconcile([], 1000 + 30 * 24 * 60 * 60 * 1000);
  release?.(data);
  await refreshing;
  expect(db.prepare("SELECT * FROM canvas_sources WHERE thread_id=?").all(section.id)).toEqual([]);
  expect(projects.getSection(section.id)).toBeNull();
});

it("retrieves exact action revisions beyond the Changes list's most recent hundred entries", () => {
  const { projects } = fixture();
  const section = projects.createSection({ ...human, title: "First" });
  const firstRevision = projects.get(projectId).revision;

  for (let index = 0; index < 110; index++)
    projects.updateSection({ ...human, sectionId: section.id, title: `Name ${index}` });
  const latestRevision = projects.get(projectId).revision;
  expect(projects.journal(projectId)).toHaveLength(100);
  expect(projects.journal(projectId).some((entry) => entry.revision === firstRevision)).toBe(false);
  expect(
    projects.journal(projectId, [firstRevision, latestRevision]).map((entry) => entry.revision),
  ).toEqual([latestRevision, firstRevision]);
});

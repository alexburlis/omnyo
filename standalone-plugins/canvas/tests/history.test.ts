import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { CanvasService } from "../lib/service.ts";
import { SourceService } from "../lib/sources.ts";
import { sourceInputSchema } from "../source-contract.ts";

const hosts: FakePluginHost[] = [];

function fixture() {
  const host = createFakePluginHost({ pluginId: "canvas-history" });
  hosts.push(host);
  const service = new CanvasService(host.api);
  service.enable("board", "user");
  service.add("board", [{ id: "chart", kind: "html", title: "Reach", html: "<p>529</p>" }]);

  return { host, service };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("authored Canvas history", () => {
  it("keeps conversation identity and position through reload and undo/redo", () => {
    const { host, service } = fixture();

    const added = service.add(
      "board",
      [{ id: "prompt-one", kind: "note", conversation: { id: "prompt-one" }, width: 640 }],
      "human",
    );

    const moved = service.move("board", "prompt-one", { x: 900, y: 400 }, "human");
    const reloaded = new CanvasService(host.api);
    expect(reloaded.inspect("board", "prompt-one").node).toMatchObject({
      conversation: { id: "prompt-one" },
      position: { x: 900, y: 400 },
    });
    expect(added.changeId).not.toBeNull();
    service.undo("board", moved.changeId ?? undefined, "human");
    service.undo("board", added.changeId ?? undefined, "human");
    expect(service.board("board")?.nodes.some((node) => node.id === "prompt-one")).toBe(false);
    service.redo("board", added.changeId ?? undefined, "human");
    expect(service.inspect("board", "prompt-one").node.conversation).toEqual({ id: "prompt-one" });
  });

  it("persists optional module extras and inspection writer versions across service reload", () => {
    const { host, service } = fixture();
    service.update("board", {
      id: "chart",
      width: 720,
      views: { overview: "<b>Growth</b>", sources: "<p>Snapshot</p>" },
    });
    const inspected = service.inspect("board", "chart");
    expect(inspected.node.width).toBe(720);
    expect(inspected.node.views?.overview).toBe("<b>Growth</b>");
    expect(inspected.fieldVersions.width).toBe(inspected.boardRevision);
    const reloaded = new CanvasService(host.api);
    expect(reloaded.inspect("board", "chart")).toEqual(inspected);
    expect(reloaded.history("board").entries).toEqual(service.history("board").entries);
  });

  it("rejects stale edits even after the same field returns to its previous value", () => {
    const { service } = fixture();
    const original = service.inspect("board", "chart");
    service.update("board", { id: "chart", title: "Changed" });
    service.update("board", { id: "chart", title: "Reach" });
    const before = service.board("board");
    expect(() =>
      service.edit(
        "board",
        { id: "chart", fields: { title: "Stale" }, expectedVersions: original.fieldVersions },
        "human",
      ),
    ).toThrow(/conflict/i);
    expect(service.board("board")).toEqual(before);
  });

  it("undoes only touched authored fields while preserving later moves and content refreshes", () => {
    const { service } = fixture();
    const original = service.inspect("board", "chart");

    const change = service.edit(
      "board",
      {
        id: "chart",
        fields: { title: "Discovery" },
        expectedVersions: original.fieldVersions,
        label: "Rename chart",
      },
      "human",
    );

    service.move("board", "chart", { x: 90, y: 160 }, "human");
    service.update("board", { id: "chart", html: "<p>607</p>" }, "system");
    service.undo("board", change.changeId ?? undefined, "human");
    const node = service.inspect("board", "chart").node;
    expect(node.title).toBe("Reach");
    expect(node.html).toBe("<p>607</p>");
    expect(node.position).toEqual({ x: 90, y: 160 });
    expect(
      service.history("board").entries.find((entry) => entry.id === change.changeId),
    ).toMatchObject({
      state: "undone",
      actor: "human",
      label: "Rename chart",
      lastAction: "undo",
      lastActor: "human",
    });
  });

  it("rejects an explicit undo after another writer changes the same field", () => {
    const { service } = fixture();
    const first = service.update("board", { id: "chart", title: "First" }, "human");
    service.update("board", { id: "chart", title: "Second" }, "human");
    const before = service.board("board");
    expect(() => service.undo("board", first.changeId ?? undefined)).toThrow(/conflict.*title/i);
    expect(service.board("board")).toEqual(before);
  });

  it("restores prior semantic writers for consecutive undo and redo", () => {
    const { service } = fixture();
    service.update("board", { id: "chart", title: "One" });
    service.update("board", { id: "chart", title: "Two" });
    service.undo("board");
    expect(service.inspect("board", "chart").node.title).toBe("One");
    service.undo("board");
    expect(service.inspect("board", "chart").node.title).toBe("Reach");
    service.redo("board");
    expect(service.inspect("board", "chart").node.title).toBe("One");
    service.redo("board");
    expect(service.inspect("board", "chart").node.title).toBe("Two");
    expect(service.history("board").canRedo).toBe(false);
  });

  it("treats unchanged edits as no-ops and requires versions only for changed fields", () => {
    const { service } = fixture();
    const before = service.inspect("board", "chart");
    const history = service.history("board");

    const unchanged = service.edit("board", {
      id: "chart",
      fields: { title: "Reach" },
      expectedVersions: {},
    });

    expect(unchanged).toMatchObject({ revision: before.boardRevision, changeId: null });
    expect(service.inspect("board", "chart")).toEqual(before);
    expect(service.history("board")).toEqual(history);
    expect(() =>
      service.edit("board", { id: "chart", fields: { title: "New" }, expectedVersions: {} }),
    ).toThrow(/version|conflict/i);
  });

  it("records a batch atomically, preserves media and restores hidden linked modules", () => {
    const { service } = fixture();

    const batch = service.add("board", [
      { id: "one", kind: "note" },
      { id: "two", kind: "note" },
    ]);

    service.undo("board", batch.changeId ?? undefined);
    expect(service.board("board")?.nodes.map((node) => node.id)).toEqual(["chart"]);
    service.redo("board", batch.changeId ?? undefined);
    expect(service.board("board")?.nodes).toHaveLength(3);
    const beforeFailure = service.board("board");
    expect(() =>
      service.add("board", [
        { id: "fresh", kind: "note" },
        { id: "one", kind: "note" },
      ]),
    ).toThrow(/already exists/);
    expect(service.board("board")).toEqual(beforeFailure);

    const bytes = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(24, 1),
    ]);

    const media = service.addMedia("board", bytes, { id: "image" });
    const assetId = service.inspect("board", "image").node.assetId;
    service.undo("board", media.changeId ?? undefined);
    expect(service.board("board")?.nodes.some((node) => node.id === "image")).toBe(false);
    service.redo("board", media.changeId ?? undefined);
    expect(service.inspect("board", "image").node.assetId).toBe(assetId);
    service.link("board", "one", "two", "Supports", false);
    const archived = service.archive("board", ["one", "two"]);
    expect(service.board("board")?.edges).toEqual([]);
    service.undo("board", archived.changeId ?? undefined);
    expect(service.board("board")?.edges).toEqual([{ from: "one", to: "two", label: "Supports" }]);
  });

  it("reverses composition resets together while retaining later unrelated fields", () => {
    const { service } = fixture();
    service.move("board", "chart", { x: 17, y: 28 });

    const composed = service.compose("board", {
      composition: { width: 1000, root: { flow: "column", children: [{ node: "chart" }] } },
      resetPositions: true,
    });

    service.pin("board", "chart", true, "human");
    service.undo("board", composed.changeId ?? undefined);
    const board = service.board("board");
    expect(board?.composition).toBeNull();
    expect(board?.nodes[0]?.position).toEqual({ x: 17, y: 28 });
    expect(board?.nodes[0]?.pinned).toBe(true);
    service.redo("board", composed.changeId ?? undefined);
    expect(service.board("board")?.nodes[0]?.position).toBeNull();
  });

  it("restores removed edges, copies extras and rejects stale composition replacement", () => {
    const { service } = fixture();
    service.add("board", [{ id: "other", kind: "note" }]);
    service.link("board", "chart", "other", "Evidence", false);
    const removal = service.link("board", "chart", "other", undefined, true);
    service.undo("board", removal.changeId ?? undefined);
    expect(service.board("board")?.edges[0]?.label).toBe("Evidence");
    service.redo("board", removal.changeId ?? undefined);
    expect(service.board("board")?.edges).toEqual([]);
    service.update("board", {
      id: "chart",
      width: 610,
      binding: { sourceId: "traffic", view: "bar" },
      evidence: { sourceIds: ["traffic"], revisions: { traffic: 4 } },
      views: { overview: "<p>Overview</p>" },
    });
    const clone = service.duplicate("board", "chart", "human");
    expect(service.inspect("board", clone.id).node).toMatchObject({
      width: 610,
      binding: { sourceId: "traffic", view: "bar" },
      evidence: { sourceIds: ["traffic"], revisions: { traffic: 4 } },
      views: { overview: "<p>Overview</p>" },
    });
    const revision = service.board("board")?.revision;
    service.pin("board", clone.id, true);
    expect(() =>
      service.compose("board", { composition: null, expectedRevision: revision }),
    ).toThrow(/conflict/i);
    service.update(
      "board",
      {
        id: clone.id,
        width: null,
        binding: null,
        evidence: null,
        views: null,
      },
      "human",
    );
    const reset = service.inspect("board", clone.id).node;
    expect(reset.width).toBeUndefined();
    expect(reset.binding).toBeUndefined();
    expect(reset.views).toBeUndefined();
  });

  it("does not undo adding a module after another writer moves it", () => {
    const { service } = fixture();
    const added = service.add("board", [{ id: "fresh", kind: "note" }]);
    service.move("board", "fresh", { x: 12, y: 34 }, "human");
    expect(() => service.undo("board", added.changeId ?? undefined)).toThrow(/conflict.*position/i);
    expect(service.inspect("board", "fresh").node.position).toEqual({ x: 12, y: 34 });
  });

  it("keeps independently refreshed source datasets when undoing authored changes", () => {
    const { host, service } = fixture();
    const sources = new SourceService(host.api);
    sources.upsert(
      "board",
      sourceInputSchema.parse({ id: "traffic", title: "Traffic", provider: "manual" }),
    );

    const first = sources.push("board", {
      sourceId: "traffic",
      columns: [{ key: "visitors", label: "Visitors", type: "number" }],
      rows: [{ visitors: 529 }],
    });

    const edited = service.update("board", {
      id: "chart",
      title: "Review discovery",
      evidence: { sourceIds: ["traffic"], revisions: { traffic: first.dataset?.revision ?? 0 } },
    });

    const fresh = sources.push("board", {
      sourceId: "traffic",
      columns: [{ key: "visitors", label: "Visitors", type: "number" }],
      rows: [{ visitors: 607 }],
    });

    service.undo("board", edited.changeId ?? undefined);
    expect(sources.get("board", "traffic")).toEqual(fresh);
    expect(service.inspect("board", "chart").node.title).toBe("Reach");
  });

  it("requires an explicit guarded edit before replacing a human-owned field", () => {
    const { service } = fixture();
    service.update("board", { id: "chart", title: "Human heading" }, "human");
    const before = service.board("board");
    expect(() => service.update("board", { id: "chart", title: "Overwrite" })).toThrow(
      /human.*canvas_edit/i,
    );
    expect(service.board("board")).toEqual(before);
    service.update("board", { id: "chart", html: "<p>Fresh data</p>" });
    const inspected = service.inspect("board", "chart");
    service.edit("board", {
      id: "chart",
      fields: { title: "Approved replacement" },
      expectedVersions: inspected.fieldVersions,
    });
    expect(service.inspect("board", "chart").node.title).toBe("Approved replacement");
  });

  it("invalidates an inspection after undo restores its previous value and semantic writer", () => {
    const { service } = fixture();
    const inspected = service.inspect("board", "chart");
    service.update("board", { id: "chart", title: "Temporary" });
    service.undo("board");
    expect(service.inspect("board", "chart").node.title).toBe(inspected.node.title);
    expect(() =>
      service.edit("board", {
        id: "chart",
        fields: { title: "Stale inspection" },
        expectedVersions: inspected.fieldVersions,
      }),
    ).toThrow(/conflict/i);
  });

  it("requires a current board revision before an agent replaces a human arrangement or resets a human position", () => {
    const { service } = fixture();

    const human = {
      width: 1000,
      root: { id: "human-layout", flow: "column" as const, children: [{ node: "chart" }] },
    };

    const agent = {
      width: 900,
      root: { id: "agent-layout", flow: "row" as const, children: [{ node: "chart" }] },
    };

    service.compose("board", { composition: human }, "human");
    const before = service.board("board");
    expect(() => service.compose("board", { composition: agent })).toThrow(
      /human.*expectedRevision/i,
    );
    expect(service.board("board")).toEqual(before);
    expect(service.compose("board", { composition: human }).changeId).toBeNull();
    service.compose("board", { composition: agent, expectedRevision: before?.revision });
    service.move("board", "chart", { x: 45, y: 67 }, "human");
    expect(() => service.compose("board", { composition: agent, resetPositions: true })).toThrow(
      /human.*position/i,
    );
    const fresh = service.board("board");
    expect(() =>
      service.compose("board", { composition: agent, resetPositions: true, expectedRevision: 0 }),
    ).toThrow(/conflict/i);
    expect(service.board("board")).toEqual(fresh);
    service.compose("board", {
      composition: agent,
      resetPositions: true,
      expectedRevision: fresh?.revision,
    });
    expect(service.inspect("board", "chart").node.position).toBeNull();
  });

  it("requires current board intent before replacing or removing a human-owned edge", () => {
    const { service } = fixture();
    service.add("board", [{ id: "claim", kind: "note" }]);
    service.link("board", "chart", "claim", "Human relationship", false, "human");
    const before = service.board("board");
    expect(() => service.link("board", "chart", "claim", "Overwrite", false)).toThrow(
      /human.*expectedRevision/i,
    );
    expect(() => service.link("board", "chart", "claim", undefined, true)).toThrow(
      /human.*expectedRevision/i,
    );
    expect(service.board("board")).toEqual(before);
    expect(
      service.link("board", "chart", "claim", "Human relationship", false).changeId,
    ).toBeNull();
    expect(() => service.link("board", "chart", "claim", "Stale", false, "agent", 0)).toThrow(
      /conflict/i,
    );
    service.link(
      "board",
      "chart",
      "claim",
      "Inspected relationship",
      false,
      "agent",
      before?.revision,
    );
    expect(service.board("board")?.edges[0]?.label).toBe("Inspected relationship");
  });

  it("keeps unknown stored extras intact and retains the most recent 200 operations", () => {
    const { host, service } = fixture();
    host.api.storage
      .database()
      .prepare("UPDATE nodes SET extras_json = ? WHERE thread_id = ? AND id = ?")
      .run(JSON.stringify({ futureField: { keep: true } }), "board", "chart");
    const change = service.update("board", { id: "chart", width: 500 });
    service.undo("board", change.changeId ?? undefined);
    expect(
      host.api.storage
        .database()
        .prepare("SELECT extras_json FROM nodes WHERE thread_id = ? AND id = ?")
        .get("board", "chart"),
    ).toMatchObject({ extras_json: '{"futureField":{"keep":true}}' });

    for (let index = 0; index < 205; index += 1)
      service.update("board", { id: "chart", title: `Revision ${index}` });
    expect(service.history("board").entries).toHaveLength(200);
  });
});

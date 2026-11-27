import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import type { Composition, IslandGroup } from "../contract.ts";
import { islandGroups, updateIsland } from "../lib/composition.ts";
import { CanvasService } from "../lib/service.ts";

const hosts: FakePluginHost[] = [];

const discovery: IslandGroup = {
  id: "discovery",
  flow: "bento",
  island: { title: "Discovery", question: "How do people find us?", accent: "blue" },
  children: [{ node: "clicks" }, { node: "impressions", span: 2 }, { node: "trend", span: 3 }],
};

const browsing: IslandGroup = {
  id: "browsing",
  flow: "column",
  island: { title: "Browsing", question: "What happens next?", accent: "teal" },
  children: [{ node: "views" }, { node: "depth" }],
};

const map: Composition = {
  width: 1600,
  root: {
    id: "map",
    flow: "column",
    children: [
      { node: "headline", emphasis: "lead" },
      { id: "islands", flow: "row", children: [discovery, browsing] },
    ],
  },
};

function fixture() {
  const host = createFakePluginHost({ pluginId: "canvas-islands" });
  hosts.push(host);
  const service = new CanvasService(host.api);
  service.enable("board", "user");
  service.add(
    "board",
    ["headline", "clicks", "impressions", "trend", "views", "depth", "accounts"].map((id) => ({
      id,
      kind: "note" as const,
      title: id,
    })),
  );

  return { host, service };
}

function islandOf(service: CanvasService, id: string) {
  const composition = service.board("board")?.composition;

  return composition ? islandGroups(composition.root).find((entry) => entry.id === id) : undefined;
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("island-scoped history", () => {
  it("undoes an agent's island rearrangement without disturbing a later human island move", () => {
    const { service } = fixture();
    service.compose("board", { composition: map });

    const tightened = service.compose("board", {
      island: {
        ...discovery,
        columns: 2,
        children: [{ node: "clicks" }, { node: "impressions" }, { node: "trend", span: 2 }],
      },
    });

    const current = service.board("board")?.composition;

    if (!current) throw new Error("Expected a composition");

    const moved = service.compose(
      "board",
      { composition: updateIsland(current, "browsing", { offset: { x: 320, y: 40 } }) },
      "human",
    );

    expect(
      service
        .history("board")
        .entries.slice(0, 2)
        .map((entry) => entry.label),
    ).toEqual(["Move Browsing", "Arrange Discovery"]);

    service.undo("board", tightened.changeId ?? undefined, "human");

    expect(islandOf(service, "discovery")?.columns).toBeUndefined();
    expect(islandOf(service, "browsing")?.island.offset).toEqual({ x: 320, y: 40 });

    service.redo("board", tightened.changeId ?? undefined, "human");
    expect(islandOf(service, "discovery")?.columns).toBe(2);
    service.undo("board", moved.changeId ?? undefined, "human");
    expect(islandOf(service, "browsing")?.island.offset).toBeUndefined();
    expect(islandOf(service, "discovery")?.columns).toBe(2);
  });

  it("lets an agent rearrange its own island but protects an island a human moved", () => {
    const { service } = fixture();
    service.compose("board", { composition: map });
    const current = service.board("board")?.composition;

    if (!current) throw new Error("Expected a composition");
    service.compose(
      "board",
      { composition: updateIsland(current, "browsing", { offset: { x: 10, y: 10 } }) },
      "human",
    );

    expect(() =>
      service.compose("board", {
        island: { ...discovery, island: { ...discovery.island, accent: "violet" } },
      }),
    ).not.toThrow();
    expect(() => service.compose("board", { island: { ...browsing, flow: "bento" } })).toThrow(
      /Human edits protect island browsing/,
    );

    const revision = service.board("board")?.revision;
    service.compose("board", {
      island: { ...browsing, flow: "bento" },
      expectedRevision: revision,
    });
    expect(islandOf(service, "browsing")?.flow).toBe("bento");
  });

  it("adds an island after an anchor, pulls its modules and reports what moved", () => {
    const { service } = fixture();
    service.compose("board", { composition: map });

    const result = service.compose("board", {
      island: {
        id: "business",
        flow: "column",
        island: { title: "Business", question: "Are accounts growing?", accent: "violet" },
        children: [{ node: "accounts" }, { node: "depth" }],
      },
      after: "islands",
    });

    expect(result.notes).toEqual([
      "Moved depth from island “Browsing” into “Business”.",
      "The island “Browsing” holds one module. Merge it into a related island or drop the island wrapper.",
    ]);
    expect(service.history("board").entries[0]?.label).toBe("Add Business");
    expect(islandOf(service, "browsing")?.children).toEqual([{ node: "views" }]);
    expect(
      islandOf(service, "business")?.children.map((child) => ("node" in child ? child.node : "")),
    ).toEqual(["accounts", "depth"]);

    service.undo("board", result.changeId ?? undefined);
    expect(islandOf(service, "business")).toBeUndefined();
    expect(islandOf(service, "browsing")?.children).toEqual(browsing.children);
  });

  it("returns design notes with every arrangement and rejects ambiguous requests", () => {
    const { service } = fixture();

    const result = service.compose("board", {
      composition: {
        width: 1200,
        root: {
          flow: "column",
          children: [
            {
              id: "solo",
              flow: "column",
              island: { title: "Solo" },
              children: [{ node: "clicks" }],
            },
          ],
        },
      },
    });

    expect(result.notes).toContain(
      "The island “Solo” holds one module. Merge it into a related island or drop the island wrapper.",
    );
    expect(() => service.compose("board", {})).toThrow(/either a composition or one island/);
    expect(() => service.compose("board", { composition: map, island: discovery })).toThrow(
      /either a composition or one island/,
    );
    expect(() => service.compose("board", { composition: map, after: "islands" })).toThrow(
      /after positions/,
    );
  });

  it("keeps a legacy composition readable and stores new layouts outside the legacy column", () => {
    const { host, service } = fixture();

    const legacy: Composition = {
      width: 900,
      root: { flow: "row", children: [{ node: "clicks" }, { node: "views" }] },
    };

    host.api.storage
      .database()
      .prepare(
        "UPDATE canvas_threads SET composition_json = ?, layout_json = NULL, islands_json = NULL WHERE thread_id = ?",
      )
      .run(JSON.stringify(legacy), "board");

    expect(service.board("board")?.composition).toEqual(legacy);
    service.compose("board", { composition: map });

    const row = host.api.storage
      .database()
      .prepare("SELECT composition_json FROM canvas_threads WHERE thread_id = ?")
      .get("board");

    expect(row).toEqual({ composition_json: JSON.stringify(legacy) });
    expect(new CanvasService(host.api).board("board")?.composition).toEqual(map);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { modeSchema, type Composition } from "../contract.ts";
import { CanvasService } from "../lib/service.ts";
import { SourceService } from "../lib/sources.ts";
import { sourceInputSchema } from "../source-contract.ts";
import plugin from "../server.ts";

const hosts: FakePluginHost[] = [];

const map: Composition = {
  width: 1400,
  root: {
    flow: "column",
    children: [
      { node: "headline", emphasis: "lead" },
      {
        id: "discovery",
        flow: "bento",
        columns: 2,
        island: { title: "Discovery", question: "How do people find us?", accent: "blue" },
        children: [{ node: "clicks" }, { node: "trend" }],
      },
    ],
  },
};

function fixture() {
  const host = createFakePluginHost({ pluginId: "canvas-move" });
  hosts.push(host);
  const service = new CanvasService(host.api);
  const sources = new SourceService(host.api);
  service.enable("old", "user");
  service.add(
    "old",
    ["headline", "clicks", "trend"].map((id) => ({ id, kind: "note" as const, title: id })),
  );
  service.compose("old", { composition: map });
  sources.upsert(
    "old",
    sourceInputSchema.parse({ id: "traffic", title: "Traffic", provider: "manual" }),
  );
  sources.push("old", {
    sourceId: "traffic",
    columns: [{ key: "visitors", label: "Visitors", type: "number" }],
    rows: [{ visitors: 529 }],
  });

  return { host, service, sources };
}

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("moving a board to another chat", () => {
  it("moves modules, islands, history and sources, and turns the old chat off", () => {
    const { service, sources } = fixture();
    const renamed = service.update("old", { id: "clicks", title: "Google clicks" });
    const before = service.board("old");

    service.enable("new", "agent");

    const moved = service.moveBoard("old", "new", () => sources.move("old", "new"));
    const after = service.board("new");

    expect(moved).toMatchObject({ from: "old", to: "new", modules: 3, sources: 1 });
    expect(after?.nodes.map((node) => [node.id, node.title])).toEqual(
      before?.nodes.map((node) => [node.id, node.title]),
    );
    expect(after?.composition).toEqual(before?.composition);
    expect(after?.revision).toBeGreaterThan(before?.revision ?? 0);
    expect(after?.seenRevision).toBe(before?.seenRevision);
    expect(service.isCanvas("old")).toBe(false);
    expect(service.board("old")).toBeNull();
    expect(sources.list("old")).toEqual([]);
    expect(sources.get("new", "traffic")?.dataset?.rows).toEqual([{ visitors: 529 }]);
    expect(service.history("new").entries.map((entry) => entry.label)).toContain("Update clicks");

    service.undo("new", renamed.changeId ?? undefined, "human");
    expect(service.inspect("new", "clicks").node.title).toBe("clicks");
  });

  it("refuses to merge into a chat that already has a board and changes nothing", () => {
    const { service, sources } = fixture();
    service.enable("busy", "user");
    service.add("busy", [{ id: "own", kind: "note", title: "Own work" }]);
    const old = service.board("old");
    const busy = service.board("busy");

    expect(() => service.moveBoard("old", "busy", () => sources.move("old", "busy"))).toThrow(
      /already has a board/,
    );
    expect(service.board("old")).toEqual(old);
    expect(service.board("busy")).toEqual(busy);
    expect(() => service.moveBoard("old", "old", () => 0)).toThrow(/other chat/);
    expect(() => service.moveBoard("nowhere", "busy", () => 0)).toThrow(/no Canvas board/);
  });

  it("moves a board from the CLI inside the receiving chat and rolls back a failed attempt", async () => {
    const host = createFakePluginHost({ pluginId: "canvas-move-cli" });
    hosts.push(host);
    plugin(host.api);

    const mode = async (threadId: string) =>
      modeSchema.parse(await host.harness.callRpc("mode.get", { threadId })).canvas;

    expect((await host.harness.runCli(["on"], { threadId: "old" })).exitCode).toBe(0);
    expect(
      (
        await host.harness.runCli(
          [
            "add",
            "--input",
            JSON.stringify({
              nodes: ["headline", "clicks", "trend"].map((id) => ({ id, kind: "note", title: id })),
            }),
          ],
          { threadId: "old" },
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await host.harness.runCli(
          [
            "source",
            "--input",
            JSON.stringify({ id: "traffic", title: "Traffic", provider: "manual" }),
          ],
          { threadId: "old" },
        )
      ).exitCode,
    ).toBe(0);

    const failed = await host.harness.runCli(["move-from", "nowhere"], { threadId: "fresh" });

    expect(failed.exitCode).not.toBe(0);
    expect(await mode("fresh")).toBe(false);

    const result = await host.harness.runCli(["move-from", "old"], { threadId: "fresh" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Moved the board from old: 3 modules and 1 sources");
    expect(await mode("fresh")).toBe(true);
    expect(await mode("old")).toBe(false);
  });
});

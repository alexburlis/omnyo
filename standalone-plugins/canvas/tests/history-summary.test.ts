import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@omnyo/plugin-sdk/testing";
import { CanvasService } from "../lib/service.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.harness.dispose();
});

describe("bounded history summaries", () => {
  it("pages metadata without authored values and reads one complete change for inspection", () => {
    const host = createFakePluginHost({ pluginId: "canvas-history-summary" });
    hosts.push(host);
    const service = new CanvasService(host.api);
    service.enable("board", "user");
    service.add("board", [{ id: "chart", kind: "html", html: "original" }]);
    const content = "detail".repeat(10000);
    const change = service.update("board", { id: "chart", html: content });
    service.update("board", { id: "chart", title: "Newest" });
    const first = service.historySummary("board", 1, 0);
    const second = service.historySummary("board", 1, 1);
    expect(first.total).toBe(3);
    expect(first.entries).toHaveLength(1);
    expect(second.entries[0]).toMatchObject({
      id: change.changeId,
      fieldCount: 1,
      targets: ["node:chart"],
    });
    expect(JSON.stringify(second)).not.toContain(content);
    expect(JSON.stringify(second)).not.toContain('"before"');
    expect(service.historyDetail("board", change.changeId ?? "").fields).toEqual([
      { target: "node:chart", field: "html", before: "original", after: content },
    ]);
    service.undo("board");
    expect(service.historySummary("board", 1, 0)).toMatchObject({ canUndo: true, canRedo: true });
    expect(() => service.historyDetail("board", "missing")).toThrow(/not retained/u);
  });
});

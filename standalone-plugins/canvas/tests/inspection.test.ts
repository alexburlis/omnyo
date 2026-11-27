import { afterEach, describe, expect, it, vi } from "vitest";
import { canvasNodeSchema } from "../contract";
import { RenderRegistry } from "../lib/inspection";
import { renderReportSchema } from "../workspace-contract";

function node() {
  return canvasNodeSchema.parse({
    id: "chart",
    kind: "html",
    order: 1,
    section: "Evidence",
    title: "Discovery",
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<p>529</p>",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 2,
    updatedAt: 1000,
  });
}

function report() {
  return renderReportSchema.parse({
    nodeId: "chart",
    nodeRevision: 2,
    sourceRevision: 4,
    boardRevision: 5,
    capturedAt: Date.now(),
    mode: "board",
    zoom: 0.8,
    view: "evidence",
    bounds: { x: 10, y: 20, width: 600, height: 300 },
    text: "529 visitors",
    issues: [],
    ready: true,
  });
}

afterEach(() => vi.useRealTimers());

describe("connected render evidence", () => {
  it("distinguishes absent, current and stale node measurements", () => {
    const registry = new RenderRegistry();
    const module = node();
    expect(registry.verify("thread", module, 5, 4)).toMatchObject({ report: null, current: false });
    expect(registry.report("thread", [report()], [module])).toBe(1);
    expect(registry.verify("thread", module, 5, 4)).toMatchObject({ current: true, issues: [] });
    expect(registry.verify("thread", { ...module, updatedRevision: 3 }, 5, 4).current).toBe(false);
    expect(registry.verify("other-thread", module, 5, 4).current).toBe(false);
  });

  it("invalidates geometry after another module changes the board and after a source refresh", () => {
    const registry = new RenderRegistry();
    const module = node();
    registry.report("thread", [report()], [module]);
    expect(registry.verify("thread", module, 6, 4)).toMatchObject({ current: false });
    expect(registry.verify("thread", module, 5, 5)).toMatchObject({ current: false });
    expect(registry.verify("thread", module, 5, null)).toMatchObject({ current: false });
  });

  it("keeps readiness and measured issues distinct from report currency", () => {
    const registry = new RenderRegistry();
    const module = node();
    registry.report(
      "thread",
      [{ ...report(), ready: false, issues: ["Content exceeds module width"] }],
      [module],
    );
    const verified = registry.verify("thread", module, 5, 4);
    expect(verified.current).toBe(true);
    expect(verified.issues).toContain("Content exceeds module width");
    expect(verified.issues.some((issue) => issue.includes("waiting"))).toBe(true);
  });

  it("rejects unknown, obsolete and implausibly future reports while retaining the newest accepted report", () => {
    const registry = new RenderRegistry();
    const module = node();
    const latest = report();
    registry.report("thread", [latest], [module]);
    expect(
      registry.report(
        "thread",
        [
          { ...latest, capturedAt: latest.capturedAt - 1000 },
          { ...latest, nodeRevision: 1 },
          { ...latest, nodeId: "missing" },
          { ...latest, capturedAt: Date.now() + 6000 },
        ],
        [module],
      ),
    ).toBe(0);
    expect(registry.verify("thread", module, 5, 4).report).toEqual(latest);
    registry.report("thread", [], []);
    expect(registry.verify("thread", module, 5, 4).report).toBeNull();
  });

  it("expires measurements rather than presenting an old connected render as current", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const registry = new RenderRegistry();
    const module = node();
    registry.report("thread", [report()], [module]);
    vi.setSystemTime(1120000);
    const stale = registry.verify("thread", module, 5, 4);
    expect(stale.current).toBe(false);
    expect(stale.issues.join(" ")).toContain("stale");
  });
});

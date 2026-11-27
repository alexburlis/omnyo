import { afterEach, describe, expect, it, vi } from "vitest";
import type { Board, CanvasNode } from "../contract";
import { renderReportSchema } from "../workspace-contract";
import { readRenderReports } from "../components/render-report";

const roots: HTMLElement[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) root.remove();
});

function fixture({
  overviewHeight = 118,
  reservedHeight = 548,
  detail = "overview",
  authored = true,
  native = false,
}: {
  overviewHeight?: number;
  reservedHeight?: number;
  detail?: "overview" | "evidence" | "sources";
  authored?: boolean;
  native?: boolean;
} = {}) {
  const node: CanvasNode = {
    id: "product-use",
    kind: "html",
    order: 1,
    section: "Product",
    title: "Product use",
    body: null,
    tone: "neutral",
    pinned: false,
    wide: false,
    href: null,
    language: null,
    html: "<p>Primary evidence</p>",
    options: [],
    recommended: null,
    progress: null,
    state: null,
    assetId: null,
    position: null,
    createdRevision: 1,
    updatedRevision: 1,
    updatedAt: 0,
    views: authored ? { overview: "<p>Overview</p>" } : null,
    binding: native ? { sourceId: "traffic", view: "bar" } : null,
  };

  const board: Board = {
    threadId: "density",
    revision: 1,
    seenRevision: 0,
    sections: ["Product"],
    nodes: [node],
    edges: [],
  };

  const root = document.createElement("div");
  const world = document.createElement("div");
  world.className = "cnv-world";
  world.style.transform = "translate(20px, 30px) scale(0.4)";
  const card = document.createElement("div");
  card.className = "cnv-node";
  card.dataset.nodeId = node.id;
  card.style.left = "24px";
  card.style.top = "40px";
  Object.defineProperties(card, {
    offsetWidth: { value: 640 },
    offsetHeight: { value: reservedHeight + 20 },
  });
  card.getBoundingClientRect = () => new DOMRect(24, 40, 640, reservedHeight + 20);
  world.append(card);
  root.append(world);
  document.body.append(root);
  roots.push(root);
  const semantic = document.createElement("div");
  semantic.className = "cnv-semantic";
  semantic.dataset.detail = detail;
  Object.defineProperty(semantic, "offsetHeight", { value: reservedHeight });
  const evidence = document.createElement("div");
  evidence.className = "cnv-semantic-layer";
  evidence.dataset.view = "evidence";
  evidence.dataset.active = String(detail !== "overview" || !authored);
  evidence.style.visibility = detail === "overview" && authored ? "hidden" : "visible";

  if (authored) {
    const overview = document.createElement("div");
    overview.className = "cnv-semantic-layer";
    overview.dataset.view = "overview";
    overview.dataset.active = String(detail === "overview");
    overview.style.visibility = detail === "overview" ? "visible" : "hidden";
    const frame = document.createElement("iframe");
    frame.className = "cnv-frame";
    frame.dataset.frameReport = JSON.stringify({
      text: "Overview",
      overflowX: false,
      overflowY: false,
    });
    Object.defineProperty(frame, "offsetHeight", { value: overviewHeight });
    overview.append(frame);
    semantic.append(overview);
  }

  if (native) evidence.textContent = "Native chart";
  else {
    const frame = document.createElement("iframe");
    frame.className = "cnv-frame";
    frame.dataset.frameReport = JSON.stringify({
      text: "Evidence",
      overflowX: false,
      overflowY: false,
    });
    Object.defineProperty(frame, "offsetHeight", { value: reservedHeight });
    evidence.append(frame);
  }

  semantic.append(evidence);

  if (authored || native) card.append(semantic);
  else card.append(evidence);

  return { root, world, board, card };
}

describe("semantic overview verification", () => {
  it("reports the measured 118px overview inside the 548px slot without changing layout or camera", () => {
    const { root, board } = fixture();
    const before = root.outerHTML;
    const report = readRenderReports(root, board, false)[0];
    expect(report?.issues).toEqual([
      expect.stringContaining("Sparse overview product-use: 118px of 548px"),
    ]);
    expect(report).toMatchObject({
      ready: true,
      view: "overview",
      zoom: 0.4,
      bounds: { x: 24, y: 40, width: 640, height: 568 },
    });
    expect(renderReportSchema.safeParse(report).success).toBe(true);
    expect(root.outerHTML).toBe(before);
  });

  it.each([
    { overviewHeight: 100, reservedHeight: 500, sparse: true },
    { overviewHeight: 250, reservedHeight: 500, sparse: false },
    { overviewHeight: 320, reservedHeight: 500, sparse: false },
    { overviewHeight: 100, reservedHeight: 220, sparse: false },
    { overviewHeight: 100, reservedHeight: 221, sparse: true },
    { overviewHeight: 0, reservedHeight: 500, sparse: false },
  ])(
    "uses measured fill and blank-space bounds for $overviewHeight/$reservedHeight",
    ({ sparse, ...size }) => {
      const { root, board } = fixture(size);
      expect(readRenderReports(root, board, false)[0]?.issues.length).toBe(sparse ? 1 : 0);
    },
  );

  it.each(["evidence", "sources"] as const)("keeps an active %s view unaffected", (detail) => {
    const { root, board } = fixture({ detail });
    expect(readRenderReports(root, board, false)[0]?.issues).toEqual([]);
  });

  it.each([false, true])(
    "does not warn on ordinary evidence without an authored overview, native=%s",
    (native) => {
      const { root, board } = fixture({ authored: false, native });
      expect(readRenderReports(root, board, false)[0]?.issues).toEqual([]);
    },
  );
});

describe("render readiness and geometry budget", () => {
  it("checks both overlap directions from a single geometry read per module", () => {
    const { root, world, board, card } = fixture({ authored: false });
    const other = document.createElement("div");
    other.className = "cnv-node";
    other.dataset.nodeId = "other";
    world.append(other);
    const first = board.nodes[0];

    if (!first) throw new Error("Missing fixture module");
    board.nodes.push({ ...first, id: "other" });
    const measure = vi.fn(() => new DOMRect(24, 40, 640, 568));
    card.getBoundingClientRect = measure;
    other.getBoundingClientRect = measure;
    const reports = readRenderReports(root, board, false);
    expect(reports[0]?.issues).toContain("Overlaps other");
    expect(reports[1]?.issues).toContain("Overlaps product-use");
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("ignores a hidden measuring copy sitting on top of its module", () => {
    const { root, world, board, card } = fixture({ authored: false });
    const copy = document.createElement("div");
    copy.className = "cnv-node";
    copy.dataset.measuring = "true";
    world.append(copy);
    const rect = () => new DOMRect(24, 40, 640, 568);
    card.getBoundingClientRect = rect;
    copy.getBoundingClientRect = rect;

    expect(readRenderReports(root, board, false)[0]?.issues.join(" ")).not.toContain("Overlaps");
  });

  it.each(["deferred", "loading", "failed", "undecoded"] as const)(
    "does not verify %s media as ready",
    (state) => {
      const { root, board, card } = fixture({ authored: false });

      if (state === "deferred") card.dataset.contentDeferred = "true";
      else if (state === "undecoded") card.append(document.createElement("img"));
      else {
        const notice = document.createElement("span");
        notice.setAttribute(
          state === "loading" ? "aria-busy" : "role",
          state === "loading" ? "true" : "alert",
        );
        card.append(notice);
      }

      expect(readRenderReports(root, board, false)[0]?.ready).toBe(false);
    },
  );
});

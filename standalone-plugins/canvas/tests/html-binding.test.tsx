import { describe, expect, it } from "vitest";
import { frameData, frameDocument } from "../lib/frame-document";
import { draftFields, draftFor } from "../lib/editor";
import type { CanvasNode } from "../contract";
import { nodeBindingSchema, type Dataset } from "../source-contract";

const dataset: Dataset = {
  sourceId: "edge",
  columns: [
    { key: "hour", label: "Hour", type: "string" },
    { key: "requests", label: "Requests", type: "number" },
  ],
  rows: [{ hour: "</script><script>alert(1)</script>", requests: 31101 }],
  revision: 4,
  capturedAt: 1795266000000,
  provenance: { timezone: "UTC" },
};

const visitors: Dataset = {
  ...dataset,
  sourceId: "visitors",
  rows: [{ hour: "12:00", requests: 41 }],
  revision: 9,
};

describe("data-bound HTML modules", () => {
  it("accepts the html view with up to eight extra sources", () => {
    expect(
      nodeBindingSchema.parse({ sourceId: "edge", view: "html", sources: ["visitors"] }).sources,
    ).toEqual(["visitors"]);
    expect(
      nodeBindingSchema.safeParse({
        sourceId: "edge",
        view: "html",
        sources: Array.from({ length: 9 }, (_, index) => `s${index}`),
      }).success,
    ).toBe(false);
  });

  it("gives the module every bound dataset before its scripts run, without breaking out of the script", () => {
    const source = frameDocument(
      "<p id=\"total\"></p><script>document.getElementById('total').textContent = String(window.canvasSources.visitors.rows[0].requests)</script>",
      new Map(),
      "dark",
      false,
      frameData(dataset, { edge: dataset, visitors, missing: null }),
    );

    const head = source.slice(0, source.indexOf("</head>"));

    expect(head).toContain("window.canvasData=bound.data;window.canvasSources=bound.sources;");
    expect(head).toContain('"data":{"sourceId":"edge"');
    expect(head).toContain('"visitors":{"sourceId":"visitors"');
    expect(head).toContain('"missing":null');
    expect(head).not.toContain("</script><script>alert(1)");
    expect(head).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
    expect(source.indexOf("window.canvasData=")).toBeLessThan(source.indexOf("<body>"));
  });

  it("posts a frame height only while the document is attached and laid out", () => {
    const source = frameDocument("<p>Module</p>", new Map(), "dark");
    const start = source.lastIndexOf("<script>", source.indexOf("function post()")) + 8;
    const script = source.slice(start, source.indexOf("</script>", start));
    const posted: { canvasFrameHeight: number }[] = [];
    const retries: (() => void)[] = [];

    function run(width: number, height: number, layout: { width: number }) {
      posted.length = 0;
      retries.length = 0;

      const body = {
        scrollHeight: height,
        innerText: "",
        getBoundingClientRect: () => ({ width: layout.width, height }),
      };

      new Function(
        "document",
        "getComputedStyle",
        "parent",
        "ResizeObserver",
        "addEventListener",
        "setTimeout",
        "innerWidth",
        "innerHeight",
        script,
      )(
        { body, documentElement: { scrollWidth: 0, scrollHeight: 0 } },
        () => ({ marginTop: "0", marginBottom: "0" }),
        { postMessage: (message: { canvasFrameHeight: number }) => posted.push(message) },
        class {
          observe() {}
        },
        () => {},
        (retry: () => void) => retries.push(retry),
        width,
        0,
      );
    }

    run(0, 120, { width: 0 });
    expect(posted).toEqual([]);

    const pending = { width: 0 };

    run(320, 0, pending);
    expect(posted).toEqual([]);
    expect(retries).toHaveLength(1);
    pending.width = 320;
    retries.splice(0).forEach((retry) => retry());
    expect(posted).toMatchObject([{ canvasFrameHeight: 1 }]);

    run(320, 120.2, { width: 320 });
    expect(posted).toMatchObject([{ canvasFrameHeight: 121 }]);
    expect(retries).toEqual([]);
  });

  it("marks a missing dataset as null and leaves unbound modules unchanged", () => {
    expect(frameDocument("<p></p>", new Map(), "dark", false, frameData(null))).toContain(
      '({"data":null,"sources":{}})',
    );
    expect(frameDocument("<p></p>", new Map(), "dark")).not.toContain("canvasData");
  });

  it("keeps the extra sources when the module editor changes the binding view", () => {
    const base: CanvasNode = {
      id: "edge-chart",
      kind: "html",
      order: 1,
      section: "Edge",
      title: "Edge traffic",
      body: null,
      tone: "neutral",
      pinned: false,
      wide: false,
      href: null,
      language: null,
      html: "<svg></svg>",
      options: [],
      recommended: null,
      progress: null,
      state: null,
      assetId: null,
      position: null,
      createdRevision: 1,
      updatedRevision: 1,
      updatedAt: 0,
      binding: { sourceId: "edge", view: "html", sources: ["visitors"] },
    };

    const fields = draftFields(base, { ...draftFor(base), bindingView: "line" }, []);

    expect(fields.binding).toEqual({
      sourceId: "edge",
      view: "line",
      format: "number",
      sources: ["visitors"],
    });
  });
});

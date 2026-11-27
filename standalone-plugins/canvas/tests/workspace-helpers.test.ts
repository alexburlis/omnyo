import { describe, expect, it } from "vitest";
import { datasetPage, datasetReadSchema } from "../dataset-reader";
import { compositionSchema } from "../contract";
import { resizeFlow } from "../lib/resize";
import { datasetSchema } from "../source-contract";

describe("dataset inspection", () => {
  const data = datasetSchema.parse({
    sourceId: "source",
    revision: 3,
    capturedAt: 1000,
    columns: [
      { key: "day", label: "Day", type: "string" },
      { key: "count", label: "Count", type: "number" },
    ],
    rows: [
      { day: "Monday", count: 2 },
      { day: "Tuesday", count: 4 },
      { day: "Wednesday", count: null },
    ],
    provenance: { windowLabel: "Three days", timezone: "UTC", cohort: "Example", unit: "events" },
  });

  it("paginates projected columns and refuses changed pages", () => {
    const first = datasetPage(
      data,
      datasetReadSchema.parse({ sourceId: "source", limit: 2, columns: ["count"] }),
    );

    expect(first).toMatchObject({
      revision: 3,
      totalRows: 3,
      nextOffset: 2,
      rows: [{ count: 2 }, { count: 4 }],
    });
    expect(
      datasetPage(
        data,
        datasetReadSchema.parse({ sourceId: "source", offset: 2, expectedRevision: 3 }),
      ),
    ).toMatchObject({ nextOffset: null, rows: [{ day: "Wednesday", count: null }] });
    expect(() =>
      datasetPage(data, datasetReadSchema.parse({ sourceId: "source", expectedRevision: 2 })),
    ).toThrow("Dataset changed");
    expect(() =>
      datasetPage(data, datasetReadSchema.parse({ sourceId: "source", columns: ["unknown"] })),
    ).toThrow("Unknown dataset column");
  });
  it("bounds bytes while preserving the continuation offset", () => {
    const large = {
      ...data,
      rows: Array.from({ length: 5 }, () => ({ day: "x".repeat(12000), count: 1 })),
    };

    const page = datasetPage(large, datasetReadSchema.parse({ sourceId: "source" }));
    expect(page.rows).toHaveLength(2);
    expect(page.nextOffset).toBe(2);
    expect(() =>
      datasetPage(
        { ...large, rows: [{ day: "x".repeat(31000), count: 1 }] },
        datasetReadSchema.parse({ sourceId: "source" }),
      ),
    ).toThrow("fewer columns");
    expect(
      datasetPage(large, datasetReadSchema.parse({ sourceId: "source", columns: ["count"] })).rows,
    ).toHaveLength(5);
  });
});

describe("flow resize", () => {
  it("resizes the nearest row branch and preserves other branches", () => {
    const composition = compositionSchema.parse({
      width: 1200,
      root: {
        id: "root",
        flow: "row",
        children: [
          { id: "left", flow: "column", children: [{ node: "chart" }, { node: "note" }] },
          { node: "other" },
        ],
      },
    });

    const changed = resizeFlow(composition, "chart", 588, 784);
    expect(changed?.root.children[0]?.weight).toBeCloseTo(2);
    expect(changed?.root.children[1]).toEqual(composition.root.children[1]);
    expect(composition.root.children[0]?.weight).toBeUndefined();
    expect(resizeFlow(composition, "absent", 588, 784)).toBeNull();
  });
  it("uses the deepest row without rewriting outer weights", () => {
    const composition = compositionSchema.parse({
      width: 1600,
      root: {
        flow: "row",
        children: [
          { flow: "row", weight: 2, children: [{ node: "chart" }, { node: "note" }] },
          { node: "other" },
        ],
      },
    });

    const changed = resizeFlow(composition, "chart", 400, 500);
    const branch = changed?.root.children[0];
    expect(branch?.weight).toBe(2);
    expect(branch && "flow" in branch && branch.children[0]?.weight).toBeCloseTo(5 / 3);
    expect(changed?.root.children[1]).toEqual(composition.root.children[1]);
  });
});

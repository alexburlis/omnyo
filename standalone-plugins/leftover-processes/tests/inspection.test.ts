import { describe, expect, it } from "vitest";
import { inspectionStatus, inspectionSummary } from "../lib/inspection";

const failed = { status: "failed", failures: [] } as const;

const healthy = { status: "ok", failures: [] } as const;

describe("housekeeping inspection coverage", () => {
  it("does not report an empty machine when inspection failed", () => {
    expect(inspectionStatus([failed])).toBe("failed");
    expect(inspectionSummary({ hosts: [failed], processCount: 0, memoryBytes: 0 })).toBe(
      "Inspection failed. Resource usage is unknown.",
    );
  });
  it("labels counts from partial inspection as observed", () => {
    expect(inspectionStatus([failed, healthy])).toBe("partial");
    expect(
      inspectionSummary({ hosts: [failed, healthy], processCount: 1, memoryBytes: 1024 ** 3 }),
    ).toBe("Inspection incomplete. Observed 1.0 GB in 1 process.");
  });
  it("holds ambiguous owners while preserving known observations", () => {
    const partial = { status: "ok", failures: ["An ownership conflict is held."] } as const;
    expect(inspectionStatus([partial])).toBe("partial");
  });
  it("keeps tracked Cua resources visible when no processes were found", () => {
    expect(
      inspectionSummary({
        hosts: [healthy],
        processCount: 0,
        memoryBytes: 0,
        cuaResources: [{ transition: { kind: "stable" } }],
      }),
    ).toBe("1 Cua runtime tracked.");
  });

  it("reports an empty result only after complete inspection", () => {
    expect(inspectionSummary({ hosts: [healthy], processCount: 0, memoryBytes: 0 })).toBe(
      "Nothing left running.",
    );
  });
});

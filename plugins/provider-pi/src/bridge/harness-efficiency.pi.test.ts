import { describe, expect, it } from "vitest";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { runNativeSummaryDisproof } from "./harness-efficiency-fixtures/native-summary-disproof.js";

describe("HE-DISPROOF pinned native Pi summary boundary", () => {
  it("binds the experiment to the reviewed runtime", () => {
    expect(VERSION).toBe("0.84.0");
  });

  it("demonstrates that the genuine native summary path succeeds when its request fits", async () => {
    const result = await runNativeSummaryDisproof("precheck", 65536);
    expect(result.requestOrder).toEqual(["summary", "summary", "ordinary"]);
    expect(result.summaries).toHaveLength(2);
    expect(result.summaries[0]).toMatchObject({
      exceedsWindow: false,
      containsOriginalOldResult: true,
      containsPlaceholder: false,
    });
    expect(result.summaries[1]).toMatchObject({
      exceedsWindow: false,
      containsOriginalOldResult: false,
      containsPlaceholder: false,
    });
    expect(result.compactions).toEqual([
      { reason: "threshold", succeeded: true, willRetry: false },
    ]);
    expect(result.scratchRemoved).toBe(true);
  });

  it.each(["precheck", "postrun", "overflow"] as const)(
    "rejects fixed masking when %s native compaction sends the oversized original history",
    async (trigger) => {
      const result = await runNativeSummaryDisproof(trigger, 28672);
      expect(result.requestOrder).toEqual(
        trigger === "precheck"
          ? ["summary", "ordinary"]
          : ["ordinary", "summary"],
      );
      expect(result.summaries).toHaveLength(1);
      expect(result.summaries[0]).toMatchObject({
        exceedsWindow: true,
        containsOriginalOldResult: true,
        containsPlaceholder: false,
      });
      expect(result.compactions).toEqual([
        {
          reason: trigger === "overflow" ? "overflow" : "threshold",
          succeeded: false,
          willRetry: false,
        },
      ]);
      expect(result.ordinaryRequests).toHaveLength(1);
      expect(result.ordinaryRequests[0]).toMatchObject({
        maskedResults: 52,
        preservedRecentResults: 8,
      });
      expect(result.originalResultsUnchanged).toBe(true);
      expect(result.scratchRemoved).toBe(true);
    },
  );
});

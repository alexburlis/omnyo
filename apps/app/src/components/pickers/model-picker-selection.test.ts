import { describe, expect, it } from "vitest";
import type { ReasoningLevel } from "@omnyo/domain";
import {
  landingReasoningLevel,
  rowReasoningLevelInColumn,
} from "./model-picker-selection";

function row(levels: readonly ReasoningLevel[]) {
  return {
    reasoningOptions: levels.map((level) => ({ value: level, label: level })),
    defaultReasoningLevel: levels[0] ?? "medium",
  };
}

const codexSol = row(["low", "medium", "high", "xhigh", "max", "ultra"]);

const codexLuna = row(["low", "medium", "high", "xhigh", "max"]);

const claudeOpus = row(["low", "medium", "high", "xhigh", "ultracode", "max"]);

const claudeHaiku = row(["low", "medium", "high"]);

describe("rowReasoningLevelInColumn", () => {
  it("finds the row's own level in the shared Ultra column", () => {
    expect(rowReasoningLevelInColumn(claudeOpus, "ultra")).toBe("ultracode");
    expect(rowReasoningLevelInColumn(codexSol, "ultracode")).toBe("ultra");
    expect(rowReasoningLevelInColumn(codexSol, "high")).toBe("high");
    expect(rowReasoningLevelInColumn(claudeHaiku, "ultra")).toBeNull();
  });
});

describe("landingReasoningLevel", () => {
  it("lands an Ultra selection in the other provider's Ultra column", () => {
    expect(landingReasoningLevel(claudeOpus, "ultra")).toBe("ultracode");
    expect(landingReasoningLevel(codexSol, "ultracode")).toBe("ultra");
  });

  it("falls back to the effort each Ultra mode runs at when a row has no Ultra", () => {
    expect(landingReasoningLevel(codexLuna, "ultracode")).toBe("xhigh");
    expect(landingReasoningLevel(codexLuna, "ultra")).toBe("max");
    expect(landingReasoningLevel(claudeHaiku, "ultra")).toBe("high");
  });
});

import { describe, expect, it } from "vitest";
import { reasoningLevelValues, type ReasoningLevel } from "@omnyo/domain";
import type { FavoriteRow } from "./favorite-bars";
import type { ModelPickerOption } from "./model-picker-option";
import type { PickerOption } from "./OptionPicker";
import {
  MODEL_PICKER_ALL_MODELS_KEY,
  modelPickerCellsMode,
  modelPickerColumns,
  modelPickerFavoriteRowKey,
  modelPickerLevelDistance,
  modelPickerMoreKey,
  modelPickerNavEntries,
  modelPickerRowKey,
  modelPickerGridTemplate,
  modelPickerVisibleRows,
  stepRowReasoningLevel,
  type ModelPickerMatrixGroup,
  type ModelPickerMatrixRow,
} from "./model-picker-menu";

function levels(
  ...entries: readonly [ReasoningLevel, string][]
): PickerOption<ReasoningLevel>[] {
  return entries.map(([value, label]) => ({ value, label }));
}

function option(
  value: string,
  reasoningOptions: readonly PickerOption<ReasoningLevel>[],
): ModelPickerOption {
  return {
    value,
    label: value,
    reasoningOptions,
    defaultReasoningLevel: reasoningOptions[0]?.value ?? "medium",
    serviceTierOptions: [],
  };
}

function row(providerId: string, model: string): ModelPickerMatrixRow {
  return {
    key: modelPickerRowKey(providerId, model),
    providerId,
    option: option(model, levels(["medium", "Medium"])),
    label: model,
    hidden: false,
    selected: false,
    selectable: true,
    landingLevel: "medium",
  };
}

function group(
  providerId: string,
  body: ModelPickerMatrixGroup["body"],
): ModelPickerMatrixGroup {
  return {
    providerId,
    label: providerId,
    icon: undefined,
    installUrl: undefined,
    newChat: false,
    notice: null,
    body,
  };
}

describe("modelPickerColumns", () => {
  it("aligns every provider's levels in picker order with Ultra last", () => {
    const columns = modelPickerColumns([
      ["xhigh", "low", "medium"],
      ["max", "ultracode", "high", "xhigh"],
    ]);

    expect(columns).toEqual([
      { level: "low", levels: ["low"] },
      { level: "medium", levels: ["medium"] },
      { level: "high", levels: ["high"] },
      { level: "xhigh", levels: ["xhigh"] },
      { level: "max", levels: ["max"] },
      { level: "ultra", levels: ["ultracode"] },
    ]);
  });

  it("shares one Ultra column between Codex Ultra and Claude Ultracode", () => {
    const columns = modelPickerColumns([
      ["max", "ultra"],
      ["ultracode", "max"],
    ]);

    expect(columns.map(({ level, levels }) => [level, levels])).toEqual([
      ["max", ["max"]],
      ["ultra", ["ultracode", "ultra"]],
    ]);
  });

  it("keeps Ultracode and Ultra apart when one model offers both", () => {
    const columns = modelPickerColumns([["ultra", "max", "ultracode"]]);

    expect(columns.map((column) => column.level)).toEqual([
      "max",
      "ultracode",
      "ultra",
    ]);
  });

  it("keeps provider-specific levels after the standard ones in provider order", () => {
    const columns = modelPickerColumns([["minimal", "high", "off"]]);

    expect(columns.map((column) => column.level)).toEqual([
      "high",
      "minimal",
      "off",
    ]);
  });

  it("renders no columns when no visible row has a reasoning ladder", () => {
    expect(modelPickerColumns([[]])).toEqual([]);
  });
});

describe("modelPickerLevelDistance", () => {
  it("counts columns between levels with Ultracode and Ultra as one column", () => {
    expect(modelPickerLevelDistance("high", "high")).toBe(0);
    expect(modelPickerLevelDistance("medium", "xhigh")).toBe(2);
    expect(modelPickerLevelDistance("ultracode", "ultra")).toBe(0);
    expect(modelPickerLevelDistance("max", "ultra")).toBe(1);
    expect(modelPickerLevelDistance("max", "ultracode")).toBe(1);
  });

  it("puts provider-specific levels out of reach unless they match exactly", () => {
    expect(modelPickerLevelDistance("minimal", "minimal")).toBe(0);
    expect(modelPickerLevelDistance("minimal", "high")).toBe(
      Number.POSITIVE_INFINITY,
    );
  });
});

describe("modelPickerCellsMode", () => {
  it("shows the selected row and edit mode in full, favorites rows by their picks, and reveals the rest", () => {
    expect(
      modelPickerCellsMode({ kind: "row", row: { selected: true } }, false),
    ).toBe("all");
    expect(
      modelPickerCellsMode({ kind: "row", row: { selected: false } }, true),
    ).toBe("all");
    expect(
      modelPickerCellsMode({ kind: "row", row: { selected: false } }, false),
    ).toBe("reveal");
    expect(modelPickerCellsMode({ kind: "favorite" }, false)).toBe("favorites");
    expect(modelPickerCellsMode({ kind: "favorite" }, true)).toBe("favorites");
  });
});

describe("model picker layout", () => {
  const everyStandardLevel = modelPickerColumns([[...reasoningLevelValues]]);

  it("gives every standard level a chip column beside a readable name column", () => {
    expect(everyStandardLevel.map((column) => column.level)).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
      "ultra",
    ]);
    expect(modelPickerGridTemplate(everyStandardLevel.length, false)).toBe(
      "minmax(5rem, 1fr) repeat(8, auto)",
    );
    expect(modelPickerGridTemplate(0, false)).toBe("minmax(5rem, 1fr)");
  });

  it("reserves one fixed star column after the levels when a row can be starred", () => {
    expect(modelPickerGridTemplate(4, true)).toBe(
      "minmax(5rem, 1fr) repeat(4, auto) 1.75rem",
    );
  });
});

describe("stepRowReasoningLevel", () => {
  const ladder = levels(["high", "High"], ["low", "Low"], ["medium", "Medium"]);

  it("steps by rank without wrapping", () => {
    expect(stepRowReasoningLevel(ladder, "low", 1)).toBe("medium");
    expect(stepRowReasoningLevel(ladder, "medium", -1)).toBe("low");
    expect(stepRowReasoningLevel(ladder, "high", 1)).toBeNull();
    expect(stepRowReasoningLevel(ladder, "low", -1)).toBeNull();
  });

  it("does nothing for a level the row does not offer", () => {
    expect(stepRowReasoningLevel(ladder, "max", 1)).toBeNull();
  });

  it("steps through Max before the Ultra column", () => {
    const claude = levels(
      ["xhigh", "xHigh"],
      ["ultracode", "Ultracode"],
      ["max", "Max"],
    );

    expect(stepRowReasoningLevel(claude, "xhigh", 1)).toBe("max");
    expect(stepRowReasoningLevel(claude, "max", 1)).toBe("ultracode");
    expect(stepRowReasoningLevel(claude, "ultracode", -1)).toBe("max");
  });
});

describe("modelPickerNavEntries", () => {
  const solRow = row("codex", "gpt-6.1-sol");
  const astraRow = row("codex", "gpt-6-astra");
  const legacyRow = row("codex", "gpt-5.6-sol");
  const opusRow = row("claude-code", "claude-opus-5-5");

  const favoriteRow: FavoriteRow = {
    key: modelPickerFavoriteRowKey("claude-code", "claude-opus-5-5", "default"),
    modelLabel: "Opus 5.5",
    icon: undefined,
    tierLabel: null,
    startsNewChat: false,
    current: false,
    picks: [],
    landing: null,
  };

  it("walks favorites rows first, then rows across groups with a more entry per collapsed group", () => {
    const groups = [
      group("codex", {
        kind: "rows",
        rows: [solRow, astraRow],
        more: { count: 1, expanded: false, rows: [legacyRow] },
      }),
      group("claude-code", { kind: "loading" }),
      group("pi", { kind: "error", error: null }),
      group("cursor", { kind: "rows", rows: [opusRow], more: null }),
    ];

    expect(
      modelPickerNavEntries([favoriteRow], false, groups).map((entry) => [
        entry.kind,
        entry.key,
      ]),
    ).toEqual([
      ["favorite", favoriteRow.key],
      ["row", solRow.key],
      ["row", astraRow.key],
      ["more", modelPickerMoreKey("codex")],
      ["row", opusRow.key],
    ]);
    expect(modelPickerVisibleRows(groups)).toEqual([solRow, astraRow, opusRow]);
  });

  it("ends the favorites view with the All models entry", () => {
    expect(
      modelPickerNavEntries([favoriteRow], true, []).map((entry) => [
        entry.kind,
        entry.key,
      ]),
    ).toEqual([
      ["favorite", favoriteRow.key],
      ["all", MODEL_PICKER_ALL_MODELS_KEY],
    ]);
  });

  it("keys a favorites row apart from its model's provider row and other tiers", () => {
    expect(favoriteRow.key).not.toBe(opusRow.key);
    expect(favoriteRow.key).not.toBe(
      modelPickerFavoriteRowKey("claude-code", "claude-opus-5-5", "fast"),
    );
  });

  it("puts an expanded group's extra rows right after its more entry", () => {
    const groups = [
      group("codex", {
        kind: "rows",
        rows: [solRow],
        more: { count: 1, expanded: true, rows: [legacyRow] },
      }),
    ];

    expect(
      modelPickerNavEntries([], false, groups).map((entry) => entry.key),
    ).toEqual([solRow.key, modelPickerMoreKey("codex"), legacyRow.key]);
    expect(modelPickerVisibleRows(groups)).toEqual([solRow, legacyRow]);
  });
});

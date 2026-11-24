import { describe, expect, it } from "vitest";
import type { AvailableModel } from "@omnyo/domain";
import {
  resolveModelCatalogSelection,
  resolveModelPickerRows,
  resolveModelReasoningLevel,
  type ModelCatalogProvider,
} from "./model-catalog-selection";

const NO_HIDDEN_MODELS: ReadonlySet<string> = new Set();

function model(
  levels: readonly string[],
  defaultLevel: string,
): AvailableModel {
  return {
    id: "atlas",
    model: "atlas",
    displayName: "Atlas",
    description: "",
    supportedReasoningEfforts: levels.map((level) => ({
      reasoningEffort: level,
      description: level,
    })),
    defaultReasoningEffort: defaultLevel,
    isDefault: true,
  };
}

describe("resolveModelReasoningLevel", () => {
  it("opens a model whose levels are all provider-specific on the level the provider marked as its default", () => {
    expect(
      resolveModelReasoningLevel(
        model(["off", "think", "think-hard"], "think"),
        "medium",
      ),
    ).toBe("think");
  });

  it("keeps a remembered provider-specific level the model still offers", () => {
    expect(
      resolveModelReasoningLevel(
        model(["off", "think", "think-hard"], "think"),
        "think-hard",
      ),
    ).toBe("think-hard");
  });

  it("still picks the nearest standard level when the model has any", () => {
    expect(
      resolveModelReasoningLevel(
        model(["minimal", "low", "high"], "high"),
        "medium",
      ),
    ).toBe("high");
    expect(
      resolveModelReasoningLevel(
        model(["minimal", "low", "high"], "minimal"),
        "xhigh",
      ),
    ).toBe("high");
  });

  it("keeps the remembered level when the model lists none", () => {
    expect(resolveModelReasoningLevel(model([], "medium"), "xhigh")).toBe(
      "xhigh",
    );
    expect(resolveModelReasoningLevel(undefined, "low")).toBe("low");
  });
});

function daybreakModel(
  id: string,
  daybreak: { value: boolean; fixed: boolean },
  isDefault = false,
): AvailableModel {
  return {
    ...model(["low", "high"], "high"),
    id,
    model: id,
    displayName: id,
    isDefault,
    sessionOptions: [
      { type: "boolean", id: "daybreak", label: "Daybreak", ...daybreak },
    ],
  };
}

function selectWithDaybreak(
  selectedModel: string,
  sessionOptionSelections: Record<string, string | boolean>,
  models: AvailableModel[] = [
    daybreakModel("astra", { value: false, fixed: true }),
    daybreakModel("sol", { value: false, fixed: false }, true),
    daybreakModel("luna", { value: false, fixed: false }),
    daybreakModel("daybreak-only", { value: true, fixed: true }),
  ],
) {
  return resolveModelCatalogSelection({
    models,
    selectedOnlyModels: [],
    selectedModel,
    sessionOptionSelections,
    hiddenModels: NO_HIDDEN_MODELS,
    provider: undefined,
    catalogIsVerified: true,
    formatModelLabel: (name) => name,
  });
}

describe("resolveModelCatalogSelection with agent options", () => {
  it("leaves every model selectable until the user chooses an option", () => {
    const selection = selectWithDaybreak("astra", {});
    expect(selection.selectedModel).toBe("astra");
    expect(selection.modelOptions.map((option) => option.disabled)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(selection.declaredSessionOptions).toEqual([
      {
        type: "boolean",
        id: "daybreak",
        label: "Daybreak",
        value: false,
        fixed: false,
      },
    ]);
  });

  it("moves off a model the chosen option rules out, preferring the default, and greys that model out", () => {
    const selection = selectWithDaybreak("astra", { daybreak: true });
    expect(selection.selectedModel).toBe("sol");
    expect(selection.activeModel?.model).toBe("sol");
    expect(selection.requiresExplicitModel).toBe(false);
    expect(selection.isSessionOptionModelSwitch).toBe(true);
    expect(
      selection.modelOptions.map((option) => [
        option.value,
        option.disabledReason,
      ]),
    ).toEqual([
      ["astra", "Turn off Daybreak to use this model"],
      ["sol", undefined],
      ["luna", undefined],
      ["daybreak-only", undefined],
    ]);
  });

  it("keeps a compatible model and greys out the one that needs the option on", () => {
    const selection = selectWithDaybreak("luna", { daybreak: false });
    expect(selection.selectedModel).toBe("luna");
    expect(selection.isSessionOptionModelSwitch).toBe(false);
    expect(
      selection.modelOptions.find((option) => option.value === "daybreak-only")
        ?.disabledReason,
    ).toBe("Turn on Daybreak to use this model");
  });

  it("stays on the chosen model when no model fits the options", () => {
    const selection = selectWithDaybreak("astra", { daybreak: true }, [
      daybreakModel("astra", { value: false, fixed: true }, true),
    ]);

    expect(selection.selectedModel).toBe("astra");
  });

  it("drops a remembered choice the provider no longer declares or that has the wrong kind", () => {
    const selection = selectWithDaybreak("astra", {
      daybreak: "yes",
      gone: true,
    });

    expect(selection.sessionOptionSelections).toEqual({});
    expect(selection.selectedModel).toBe("astra");
  });

  it("rules out a model that does not list the chosen value of a select option", () => {
    const depth = (values: string[]): AvailableModel["sessionOptions"] => [
      {
        type: "select",
        id: "depth",
        label: "Search depth",
        value: values[0] ?? "",
        values: values.map((id) => ({ id, label: id })),
      },
    ];

    const selection = resolveModelCatalogSelection({
      models: [
        {
          ...model(["low"], "low"),
          id: "a",
          model: "a",
          sessionOptions: depth(["shallow"]),
        },
        {
          ...model(["low"], "low"),
          id: "b",
          model: "b",
          isDefault: false,
          sessionOptions: depth(["shallow", "deep"]),
        },
      ],
      selectedOnlyModels: [],
      selectedModel: "a",
      sessionOptionSelections: { depth: "deep" },
      hiddenModels: NO_HIDDEN_MODELS,
      provider: undefined,
      catalogIsVerified: true,
      formatModelLabel: (name) => name,
    });

    expect(selection.selectedModel).toBe("b");
    expect(selection.modelOptions[0]?.disabledReason).toBe(
      "Not available with Search depth set to deep",
    );
  });
});

function catalogModel(
  id: string,
  overrides: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    ...model(["low", "medium", "high"], "medium"),
    id,
    model: id,
    displayName: id,
    isDefault: false,
    ...overrides,
  };
}

const tieredProvider: ModelCatalogProvider = {
  reasoningLevels: [{ id: "xhigh", label: "Extra High" }],
  serviceTiers: [
    { id: "default", label: "Default" },
    { id: "fast", label: "Fast" },
  ],
  capabilities: { supportsServiceTier: true },
};

function selectHidden(
  selectedModel: string,
  hiddenModels: readonly string[],
  selectedOnlyModels: AvailableModel[] = [catalogModel("gpt-5.6-terra")],
) {
  return resolveModelCatalogSelection({
    models: [
      catalogModel("gpt-6.1-sol", { isDefault: true }),
      catalogModel("gpt-6-astra"),
      catalogModel("gpt-5.6-sol"),
      catalogModel("gpt-5.5"),
    ],
    selectedOnlyModels,
    selectedModel,
    hiddenModels: new Set(hiddenModels),
    provider: tieredProvider,
    catalogIsVerified: true,
    formatModelLabel: (name) => name,
  });
}

function values(options: readonly { value: string }[]): string[] {
  return options.map((option) => option.value);
}

describe("resolveModelCatalogSelection with hidden models", () => {
  it.each([false, true])(
    "preserves a selected model missing from the catalog (verified: %s)",
    (catalogIsVerified) => {
      const selection = resolveModelCatalogSelection({
        models: [catalogModel("claude-opus-4-8", { isDefault: true })],
        selectedOnlyModels: [],
        selectedModel: "claude-opus-5-5",
        hiddenModels: NO_HIDDEN_MODELS,
        provider: undefined,
        catalogIsVerified,
        formatModelLabel: (name) => name,
      });

      expect(selection.selectedModel).toBe("claude-opus-5-5");
      expect(selection.activeModel).toBeUndefined();
    },
  );

  it("folds hidden models ahead of the provider's extra models and keeps the catalog order for editing", () => {
    const selection = selectHidden("gpt-6-astra", ["gpt-5.6-sol", "gpt-5.5"]);

    expect(values(selection.modelOptions)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
    ]);
    expect(values(selection.moreModelOptions)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.5",
      "gpt-5.6-terra",
    ]);
    expect(values(selection.catalogModelOptions)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
    expect(selection.selectedModel).toBe("gpt-6-astra");
  });

  it("keeps a selected hidden model in the main list without changing the selection", () => {
    const selection = selectHidden("gpt-5.5", ["gpt-5.6-sol", "gpt-5.5"]);

    expect(selection.selectedModel).toBe("gpt-5.5");
    expect(selection.activeModel?.model).toBe("gpt-5.5");
    expect(selection.requiresExplicitModel).toBe(false);
    expect(values(selection.modelOptions)).toEqual([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-5.5",
    ]);
    expect(values(selection.moreModelOptions)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
    ]);
  });

  it("leaves the default model and every selection result unchanged when the default is hidden", () => {
    const visible = selectHidden("", []);
    const hidden = selectHidden("", ["gpt-6.1-sol", "gpt-6-astra"]);

    expect(hidden.selectedModel).toBe(visible.selectedModel);
    expect(hidden.selectedModel).toBe("gpt-6.1-sol");
    expect(hidden.activeModel).toEqual(visible.activeModel);
    expect(hidden.reasoningLevel).toBe(visible.reasoningLevel);
    expect(hidden.requiresExplicitModel).toBe(false);
    expect(hidden.isSessionOptionModelSwitch).toBe(false);
    expect(values(hidden.modelOptions)).toEqual([
      "gpt-6.1-sol",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
  });

  it("still offers a provider whose primary models are all hidden through its extra list", () => {
    const selection = selectHidden(
      "gpt-6.1-sol",
      ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol", "gpt-5.5"],
      [],
    );

    expect(values(selection.modelOptions)).toEqual(["gpt-6.1-sol"]);
    expect(values(selection.moreModelOptions)).toEqual([
      "gpt-6-astra",
      "gpt-5.6-sol",
      "gpt-5.5",
    ]);
  });
});

describe("model picker rows", () => {
  it("gives every row its own de-duplicated, labelled ladder, default level and tiers", () => {
    const selection = resolveModelCatalogSelection({
      models: [
        catalogModel("gpt-6.1-sol", {
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "high", description: "" },
            { reasoningEffort: "xhigh", description: "" },
            { reasoningEffort: "high", description: "" },
          ],
          supportedServiceTiers: [{ id: "fast" }],
        }),
        catalogModel("gpt-6-luna", {
          defaultReasoningEffort: "low",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", label: "Quick", description: "" },
          ],
          supportedServiceTiers: [],
        }),
      ],
      selectedOnlyModels: [],
      selectedModel: "gpt-6.1-sol",
      hiddenModels: NO_HIDDEN_MODELS,
      provider: tieredProvider,
      catalogIsVerified: true,
      formatModelLabel: (name) => name,
    });

    expect(
      selection.modelOptions.map((option) => ({
        value: option.value,
        reasoningOptions: option.reasoningOptions,
        defaultReasoningLevel: option.defaultReasoningLevel,
        serviceTierOptions: option.serviceTierOptions,
      })),
    ).toEqual([
      {
        value: "gpt-6.1-sol",
        reasoningOptions: [
          { value: "high", label: "High" },
          { value: "xhigh", label: "Extra High" },
        ],
        defaultReasoningLevel: "high",
        serviceTierOptions: [{ id: "fast", label: "Fast" }],
      },
      {
        value: "gpt-6-luna",
        reasoningOptions: [{ value: "low", label: "Quick" }],
        defaultReasoningLevel: "low",
        serviceTierOptions: [],
      },
    ]);
    expect(selection.reasoningOptions).toEqual(
      selection.modelOptions[0]?.reasoningOptions,
    );
  });

  it("projects a sibling provider's catalog with its own hidden models and session options", () => {
    const rows = resolveModelPickerRows({
      models: [
        daybreakModel("astra", { value: false, fixed: true }),
        daybreakModel("sol", { value: false, fixed: false }, true),
        daybreakModel("luna", { value: false, fixed: false }),
      ],
      selectedOnlyModels: [
        daybreakModel("sol", { value: false, fixed: false }),
      ],
      sessionOptionSelections: { daybreak: true, unknown: "x" },
      hiddenModels: new Set(["luna"]),
      provider: undefined,
      formatModelLabel: (name) => name.toUpperCase(),
    });

    expect(
      rows.modelOptions.map((option) => [option.label, option.disabledReason]),
    ).toEqual([
      ["ASTRA", "Turn off Daybreak to use this model"],
      ["SOL", undefined],
    ]);
    expect(values(rows.moreModelOptions)).toEqual(["luna"]);
    expect(values(rows.catalogModelOptions)).toEqual(["astra", "sol", "luna"]);
  });
});

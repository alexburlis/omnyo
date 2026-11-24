import { describe, expect, it } from "vitest";
import type { AvailableModel, ModelPickerFavorite } from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { resolveModelPickerRows } from "@/hooks/thread-creation-options/model-catalog-selection";
import {
  describeFavorite,
  favoriteKey,
  favoriteSelection,
  findCatalogRow,
  matchingFavorite,
  resolveFavoriteAvailability,
  toFavorite,
  type FavoriteAvailabilityContext,
} from "./model-favorites";
import type {
  ModelPickerCatalogStatus,
  ModelPickerProviderCatalog,
} from "./model-picker-selection";

const codexProvider = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  capabilities: { supportsServiceTier: true },
});

const claudeProvider = makeProviderInfo({
  id: "claude-code",
  displayName: "Claude Code",
  strings: {
    signInHint: "Run claude to sign in.",
    expiredHint: "Run claude to sign in again.",
    installUrl: "https://claude.com/claude-code",
    brandPrefix: "Claude",
  },
});

function availableModel(
  model: string,
  displayName: string,
  levels: readonly string[],
  overrides: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    id: model,
    model,
    displayName,
    description: "",
    supportedReasoningEfforts: levels.map((level) => ({
      reasoningEffort: level,
      description: "",
    })),
    defaultReasoningEffort: levels[0] ?? "medium",
    isDefault: false,
    ...overrides,
  };
}

function catalog(
  provider: typeof codexProvider,
  models: AvailableModel[],
  status: ModelPickerCatalogStatus = "verified",
  sessionOptionSelections: Record<string, boolean> = {},
): ModelPickerProviderCatalog {
  return {
    providerId: provider.id,
    provider,
    status,
    loadError: null,
    notice: null,
    ...resolveModelPickerRows({
      models: models.slice(0, -1),
      selectedOnlyModels: models.slice(-1),
      sessionOptionSelections,
      hiddenModels: new Set(),
      provider,
      formatModelLabel: (name) => name,
    }),
  };
}

const codexCatalog = catalog(codexProvider, [
  availableModel("gpt-6.1-sol", "GPT-6.1-Sol", ["low", "medium", "xhigh"], {
    supportedServiceTiers: [{ id: "fast" }],
  }),
  availableModel("gpt-6-luna", "GPT-6-Luna", ["low", "medium"], {
    supportedServiceTiers: [],
  }),
  availableModel("gpt-5.5", "GPT-5.5", [], {}),
]);

const claudeCatalog = catalog(
  claudeProvider,
  [
    availableModel("claude-opus-5-5", "Claude Opus 5.5", ["high", "xhigh"], {
      sessionOptions: [
        {
          type: "boolean",
          id: "daybreak",
          label: "Daybreak",
          value: false,
          fixed: true,
        },
      ],
    }),
    availableModel("claude-sonnet-5-5", "Claude Sonnet 5.5", ["high"]),
  ],
  "verified",
  { daybreak: true },
);

function context(
  overrides: Partial<FavoriteAvailabilityContext> = {},
): FavoriteAvailabilityContext {
  return {
    catalogs: new Map([
      ["codex", codexCatalog],
      ["claude-code", claudeCatalog],
    ]),
    disabledProviders: new Map([["gemini", "Gemini"]]),
    allowFastServiceTier: true,
    ...overrides,
  };
}

function favorite(
  providerId: string,
  model: string,
  reasoningLevel: string,
  serviceTier = "default",
): ModelPickerFavorite {
  return { providerId, model, reasoningLevel, serviceTier };
}

describe("resolveFavoriteAvailability", () => {
  it.each([
    {
      name: "a favorite the current catalog fully offers",
      favorite: favorite("codex", "gpt-6.1-sol", "xhigh", "fast"),
      context: context(),
      expected: { state: "ready" },
    },
    {
      name: "a provider-only model listed under More",
      favorite: favorite("codex", "gpt-5.5", "xhigh"),
      context: context(),
      expected: { state: "ready" },
    },
    {
      name: "a provider that is turned off",
      favorite: favorite("gemini", "gemini-3-pro", "high"),
      context: context(),
      expected: { state: "unavailable", reason: "Gemini is off" },
    },
    {
      name: "a provider this machine does not offer",
      favorite: favorite("pi", "nemotron", "high"),
      context: context(),
      expected: { state: "unavailable", reason: "Not on this machine" },
    },
    {
      name: "a catalog that is still loading",
      favorite: favorite("codex", "gpt-6.1-sol", "xhigh"),
      context: context({
        catalogs: new Map([["codex", { ...codexCatalog, status: "loading" }]]),
      }),
      expected: { state: "pending" },
    },
    {
      name: "a catalog that failed to load",
      favorite: favorite("codex", "gpt-6.1-sol", "xhigh"),
      context: context({
        catalogs: new Map([["codex", { ...codexCatalog, status: "failed" }]]),
      }),
      expected: { state: "unavailable", reason: "Models didn't load" },
    },
    {
      name: "a model missing from this machine's catalog",
      favorite: favorite("codex", "gpt-6-astra", "xhigh"),
      context: context(),
      expected: { state: "unavailable", reason: "Not on this machine" },
    },
    {
      name: "a reasoning level the model does not offer",
      favorite: favorite("claude-code", "claude-sonnet-5-5", "ultracode"),
      context: context(),
      expected: {
        state: "unavailable",
        reason: "Sonnet 5.5 has no Ultracode",
      },
    },
    {
      name: "a tier the model does not offer",
      favorite: favorite("codex", "gpt-6-luna", "low", "fast"),
      context: context(),
      expected: { state: "unavailable", reason: "Fast isn't available" },
    },
    {
      name: "a tier on a provider without tiers",
      favorite: favorite("claude-code", "claude-sonnet-5-5", "high", "fast"),
      context: context(),
      expected: { state: "unavailable", reason: "Fast isn't available" },
    },
    {
      name: "a Fast favorite while Fast is turned off in Settings",
      favorite: favorite("codex", "gpt-6.1-sol", "xhigh", "fast"),
      context: context({ allowFastServiceTier: false }),
      expected: { state: "unavailable", reason: "Fast isn't available" },
    },
    {
      name: "a model the current agent options rule out",
      favorite: favorite("claude-code", "claude-opus-5-5", "xhigh"),
      context: context(),
      expected: {
        state: "unavailable",
        reason: "Turn off Daybreak to use this model",
      },
    },
  ])("reports $name", ({ favorite: entry, context: ctx, expected }) => {
    expect(resolveFavoriteAvailability(entry, ctx)).toEqual(expected);
  });
});

describe("favorite identity", () => {
  const solXhigh = {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "xhigh",
  };

  const solDefault = favorite("codex", "gpt-6.1-sol", "xhigh");
  const solFast = favorite("codex", "gpt-6.1-sol", "xhigh", "fast");

  it("matches a default-tier favorite whatever the current tier is", () => {
    expect(matchingFavorite([solDefault], solXhigh, true)).toBe(solDefault);
    expect(
      matchingFavorite(
        [solDefault],
        { ...solXhigh, serviceTier: "fast" },
        true,
      ),
    ).toBe(solDefault);
  });

  it("matches a tier-pinned favorite only at its tier and prefers the exact tier", () => {
    expect(matchingFavorite([solFast], solXhigh, true)).toBeUndefined();
    expect(
      matchingFavorite([solFast], { ...solXhigh, serviceTier: "fast" }, true),
    ).toBe(solFast);
    expect(
      matchingFavorite(
        [solDefault, solFast],
        { ...solXhigh, serviceTier: "fast" },
        true,
      ),
    ).toBe(solFast);
    expect(matchingFavorite([solFast, solDefault], solXhigh, true)).toBe(
      solDefault,
    );
  });

  it("ignores tiers on providers without them and never crosses efforts or models", () => {
    const opusFast = favorite("claude-code", "claude-opus-5-5", "high", "fast");

    expect(
      matchingFavorite(
        [opusFast],
        {
          providerId: "claude-code",
          model: "claude-opus-5-5",
          reasoningLevel: "high",
        },
        false,
      ),
    ).toBe(opusFast);
    expect(
      matchingFavorite(
        [favorite("codex", "gpt-6.1-sol", "high"), solDefault],
        { ...solXhigh, model: "gpt-6-luna" },
        true,
      ),
    ).toBeUndefined();
    expect(
      matchingFavorite(
        [favorite("codex", "gpt-6.1-sol", "high")],
        solXhigh,
        true,
      ),
    ).toBeUndefined();
  });

  it("keeps the current tier when applying a default-tier favorite where the model offers it", () => {
    const solRow = findCatalogRow(codexCatalog, "gpt-6.1-sol");
    const lunaRow = findCatalogRow(codexCatalog, "gpt-6-luna");
    const lunaDefault = favorite("codex", "gpt-6-luna", "low");

    expect(favoriteSelection(solDefault, solRow, "fast", true)).toEqual({
      ...solXhigh,
      serviceTier: "fast",
    });
    expect(favoriteSelection(lunaDefault, lunaRow, "fast", true)).toEqual(
      lunaDefault,
    );
    expect(favoriteSelection(solDefault, solRow, "fast", false)).toEqual(
      solDefault,
    );
    expect(favoriteSelection(solDefault, undefined, "fast", true)).toEqual(
      solDefault,
    );
  });

  it("applies a tier-pinned favorite at its own tier", () => {
    const solRow = findCatalogRow(codexCatalog, "gpt-6.1-sol");

    expect(favoriteSelection(solFast, solRow, "default", true)).toEqual(
      solFast,
    );
  });

  it("stores the current tier only for providers that have tiers", () => {
    const selection = {
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "ultracode",
      serviceTier: "fast",
    };

    expect(toFavorite(selection, false)).toEqual({
      ...selection,
      serviceTier: "default",
    });
    expect(toFavorite(selection, true)).toEqual(selection);
    expect(favoriteKey(toFavorite(selection, false))).not.toBe(
      favoriteKey(toFavorite(selection, true)),
    );
  });
});

describe("describeFavorite", () => {
  it("labels a favorite from its catalog row without the brand prefix", () => {
    expect(
      describeFavorite(
        favorite("claude-code", "claude-opus-5-5", "xhigh"),
        claudeCatalog,
      ),
    ).toEqual({
      modelLabel: "Opus 5.5",
      reasoningLabel: "xHigh",
      serviceTierLabel: null,
      label: "Opus 5.5 · xHigh",
    });
    expect(
      describeFavorite(
        favorite("codex", "gpt-6.1-sol", "xhigh", "fast"),
        codexCatalog,
      ),
    ).toMatchObject({
      label: "GPT-6.1-Sol · xHigh",
      serviceTierLabel: "Fast",
    });
  });

  it("names a favorite whose model is gone by its stored id", () => {
    expect(
      describeFavorite(favorite("codex", "gpt-6-astra", "ultra"), undefined),
    ).toEqual({
      modelLabel: "gpt-6-astra",
      reasoningLabel: "Ultra",
      serviceTierLabel: null,
      label: "gpt-6-astra · Ultra",
    });
  });
});

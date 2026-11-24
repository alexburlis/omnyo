import { describe, expect, it } from "vitest";
import type {
  AvailableModel,
  ModelPickerFavorite,
  ProviderInfo,
} from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { resolveModelPickerRows } from "@/hooks/thread-creation-options/model-catalog-selection";
import {
  buildFavoriteBars,
  buildFavoriteRows,
  buildModelBars,
  favoriteActionLabel,
  isFavoritePick,
  type CurrentPick,
  type FavoriteBar,
  type FavoriteGroup,
  type FavoriteModel,
  type FavoriteRow,
  type FavoriteSegment,
  type ShownGroups,
  type TrackWidths,
} from "./favorite-bars";
import {
  describeFavorite,
  favoriteKey,
  favoriteSelection,
  findCatalogRow,
  matchingFavorite,
  resolveFavoriteAvailability,
  type FavoriteAvailabilityContext,
  type ModelFavoriteChipItem,
} from "./model-favorites";
import { modelPickerRowKey } from "./model-picker-menu";
import type {
  ModelPickerCatalogStatus,
  ModelPickerProviderCatalog,
} from "./model-picker-selection";

const codexProvider = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  capabilities: { supportsServiceTier: true },
  strings: {
    signInHint: "Run codex login.",
    expiredHint: "Run codex login again.",
    installUrl: "https://developers.openai.com/codex",
    brandPrefix: "GPT-",
  },
});

const claudeProvider = makeProviderInfo({
  id: "claude-code",
  displayName: "Claude Code",
  strings: {
    signInHint: "Run claude to sign in.",
    expiredHint: "Run claude to sign in again.",
    installUrl: "https://claude.com/claude-code",
    brandPrefix: "Claude ",
  },
});

const CODEX_LADDER = ["low", "medium", "high", "xhigh", "max", "ultra"];

const CLAUDE_LADDER = ["low", "medium", "high", "xhigh", "ultracode", "max"];

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
  provider: ProviderInfo,
  models: AvailableModel[],
  status: ModelPickerCatalogStatus = "verified",
): ModelPickerProviderCatalog {
  return {
    providerId: provider.id,
    provider,
    status,
    loadError: null,
    notice: null,
    ...resolveModelPickerRows({
      models,
      selectedOnlyModels: [],
      sessionOptionSelections: {},
      hiddenModels: new Set(),
      provider,
      formatModelLabel: (name) => name,
    }),
  };
}

const codexCatalog = catalog(codexProvider, [
  availableModel("gpt-6.1-sol", "GPT-6.1-Sol", CODEX_LADDER, {
    supportedServiceTiers: [{ id: "fast" }],
  }),
  availableModel("gpt-6-astra", "GPT-6-Astra", CODEX_LADDER),
  availableModel("gpt-6-luna", "GPT-6-Luna", CODEX_LADDER.slice(0, 5), {
    supportedServiceTiers: [],
  }),
  availableModel("gpt-5.5", "GPT-5.5", CODEX_LADDER.slice(0, 4)),
]);

const claudeCatalog = catalog(claudeProvider, [
  availableModel("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_LADDER),
  availableModel("claude-fable-5-1", "Claude Fable 5.1", CLAUDE_LADDER),
  availableModel("claude-sonnet-5-5", "Claude Sonnet 5.5", CLAUDE_LADDER),
  availableModel("claude-haiku-5-5", "Claude Haiku 5.5", CLAUDE_LADDER),
]);

const PROVIDER_ORDER = ["codex", "claude-code"];

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

function codex(
  model: string,
  reasoningLevel: string,
  serviceTier = "default",
): ModelPickerFavorite {
  return { providerId: "codex", model, reasoningLevel, serviceTier };
}

function claude(model: string, reasoningLevel: string): ModelPickerFavorite {
  return {
    providerId: "claude-code",
    model,
    reasoningLevel,
    serviceTier: "default",
  };
}

const SOL = "gpt-6.1-sol";

const ASTRA = "gpt-6-astra";

const LUNA = "gpt-6-luna";

const GPT55 = "gpt-5.5";

const OPUS = "claude-opus-5-5";

const FABLE = "claude-fable-5-1";

const SONNET = "claude-sonnet-5-5";

const MINE = [
  codex(SOL, "high"),
  codex(SOL, "max"),
  claude(OPUS, "max"),
  claude(OPUS, "high"),
  codex(SOL, "low"),
];

const MANY = [
  codex(SOL, "low"),
  codex(SOL, "high"),
  codex(SOL, "max"),
  codex(ASTRA, "high"),
  codex(GPT55, "medium"),
  claude(OPUS, "high"),
  claude(OPUS, "max"),
  claude(FABLE, "high"),
  claude(FABLE, "max"),
  claude(SONNET, "medium"),
  claude(SONNET, "high"),
];

interface Scenario {
  favorites: readonly ModelPickerFavorite[];
  current: ModelPickerFavorite;
  lockedProvider?: string;
  availability?: FavoriteAvailabilityContext;
  landOn?: CurrentPick["landOn"];
}

function chipItems({
  favorites,
  current,
  lockedProvider,
  availability = context(),
}: Scenario): ModelFavoriteChipItem[] {
  const hasTiers = (providerId: string) =>
    availability.catalogs.get(providerId)?.provider.capabilities
      .supportsServiceTier ?? false;

  const currentFavorite = matchingFavorite(
    favorites,
    current,
    hasTiers(current.providerId),
  );

  return favorites.map((favorite) => {
    const favoriteCatalog = availability.catalogs.get(favorite.providerId);

    return {
      key: favoriteKey(favorite),
      favorite,
      selection: favoriteSelection(
        favorite,
        favoriteCatalog === undefined
          ? undefined
          : findCatalogRow(favoriteCatalog, favorite.model),
        current.serviceTier,
        availability.allowFastServiceTier,
      ),
      description: describeFavorite(favorite, favoriteCatalog),
      icon: undefined,
      availability: resolveFavoriteAvailability(favorite, availability),
      current: favorite === currentFavorite,
      startsNewChat:
        lockedProvider !== undefined && favorite.providerId !== lockedProvider,
    };
  });
}

function currentPick({
  current,
  availability = context(),
  landOn,
}: Scenario): CurrentPick {
  const currentCatalog = availability.catalogs.get(current.providerId);

  return {
    selection: current,
    description: describeFavorite(current, currentCatalog),
    icon: undefined,
    efforts:
      currentCatalog?.modelOptions.find((row) => row.value === current.model)
        ?.reasoningOptions ?? [],
    landOn:
      landOn ??
      ((providerId, model) => ({
        state: "ready",
        selection: {
          providerId,
          model,
          reasoningLevel: current.reasoningLevel,
        },
      })),
  };
}

function buildBars(
  scenario: Scenario,
  widths: TrackWidths | null = null,
  shown: ShownGroups | null = null,
) {
  return buildFavoriteBars({
    favorites: chipItems(scenario),
    current: currentPick(scenario),
    providerOrder: PROVIDER_ORDER,
    widths,
    shown,
  });
}

function buildModels(
  scenario: Scenario,
  widths: TrackWidths | null = null,
  shown: ShownGroups | null = null,
) {
  return buildModelBars({
    favorites: chipItems(scenario),
    current: currentPick(scenario),
    providerOrder: PROVIDER_ORDER,
    widths,
    shown,
  });
}

function buildRows(scenario: Scenario): FavoriteRow[] {
  return buildFavoriteRows(
    chipItems(scenario),
    PROVIDER_ORDER,
    scenario.current.reasoningLevel,
    currentPick(scenario),
  );
}

function modelText(model: FavoriteModel): string {
  return [
    model.modelLabel,
    model.tierLabel === null ? "" : `[${model.tierLabel}]`,
    model.current ? (model.keep === null ? "*" : "~") : "",
    model.landing.state === "ready" ? "" : "!",
    model.keep === null ? "" : " ☆",
  ].join("");
}

function modelsText(models: readonly FavoriteModel[]): string {
  return models.map(modelText).join(" | ");
}

function modelBarText(bar: FavoriteBar<FavoriteModel>): string {
  return bar.kind === "pill" ? "pill" : modelsText(bar.groups);
}

function segmentText(segment: FavoriteSegment): string {
  if (segment.kind === "keep") return "☆";

  return [
    segment.effortLabel,
    segment.tierLabel === null ? "" : `[${segment.tierLabel}]`,
    segment.current ? (segment.pinned ? "*" : "~") : "",
    segment.availability.state === "ready" ? "" : "!",
  ].join("");
}

function groupsText(groups: readonly FavoriteGroup[]): string {
  return groups
    .map(
      (group) =>
        `${group.modelLabel}: ${group.segments.map(segmentText).join(" ")}`,
    )
    .join(" | ");
}

function rowsText(rows: readonly FavoriteRow[]): string {
  return rows
    .map(
      (row) =>
        `${row.modelLabel}${row.tierLabel === null ? "" : `[${row.tierLabel}]`}${row.startsNewChat ? " (new chat)" : ""}: ${row.picks.map(segmentText).join(" ")}`,
    )
    .join(" | ");
}

function barText(bar: FavoriteBar): string {
  if (bar.kind === "pill") return "pill";

  const text = groupsText(bar.groups);

  return bar.hidden === 0 ? text : `${text} +${bar.hidden}`;
}

function landings(groups: readonly (FavoriteGroup | FavoriteRow)[]): string[] {
  return groups.map(
    (group) =>
      `${group.modelLabel} → ${group.landing === null ? "none" : segmentText(group.landing)}`,
  );
}

function unavailableReasons(groups: readonly FavoriteGroup[]): string[] {
  return groups.flatMap((group) =>
    group.segments
      .filter(isFavoritePick)
      .flatMap((pick) =>
        pick.availability.state === "unavailable"
          ? [pick.availability.reason]
          : [],
      ),
  );
}

describe("buildFavoriteBars", () => {
  it.each([
    {
      name: "mine groups each model's efforts low to high, Codex first",
      favorites: MINE,
      current: codex(SOL, "low"),
      expected: "6.1-Sol: Low* High Max | Opus 5.5: High Max",
    },
    {
      name: "many stays on one track instead of one row per provider",
      favorites: MANY,
      current: codex(SOL, "low"),
      expected:
        "6.1-Sol: Low* High Max | 6-Astra: High | 5.5: Medium | Opus 5.5: High Max | Fable 5.1: High Max | Sonnet 5.5: Medium High",
    },
    {
      name: "none shows the current model with every effort, the current one unpinned, then ☆",
      favorites: [],
      current: codex(SOL, "low"),
      expected: "6.1-Sol: Low~ Medium High xHigh Max Ultra ☆",
    },
    {
      name: "none leaves the speed to the ⚡ toggle instead of marking every effort",
      favorites: [],
      current: codex(SOL, "low", "fast"),
      expected: "6.1-Sol: Low~ Medium High xHigh Max Ultra ☆",
    },
    {
      name: "mine adds an unpinned current pick to its model, then ☆",
      favorites: MINE,
      current: codex(SOL, "medium"),
      expected: "6.1-Sol: Low Medium~ High Max ☆ | Opus 5.5: High Max",
    },
    {
      name: "mine gives a current model without favorites its own group in provider order",
      favorites: MINE,
      current: codex(ASTRA, "xhigh"),
      expected:
        "6.1-Sol: Low High Max | 6-Astra: xHigh~ ☆ | Opus 5.5: High Max",
    },
    {
      name: "mine keeps a default-tier favorite current when Fast is on",
      favorites: MINE,
      current: codex(SOL, "max", "fast"),
      expected: "6.1-Sol: Low High Max* | Opus 5.5: High Max",
    },
    {
      name: "mine marks a Fast favorite and puts the default tier first",
      favorites: [codex(SOL, "max", "fast"), ...MINE],
      current: codex(SOL, "low"),
      expected: "6.1-Sol: Low* High Max Max[Fast] | Opus 5.5: High Max",
    },
    {
      name: "mine presses the Fast favorite over the default one while Fast is on",
      favorites: [codex(SOL, "max", "fast"), ...MINE],
      current: codex(SOL, "max", "fast"),
      expected: "6.1-Sol: Low High Max Max[Fast]* | Opus 5.5: High Max",
    },
    {
      name: "a Fast favorite does not stand in for the default tier",
      favorites: [codex(SOL, "max", "fast")],
      current: codex(SOL, "max"),
      expected: "6.1-Sol: Max~ Max[Fast] ☆",
    },
  ])("$name", ({ favorites, current, expected }) => {
    const { bar, all } = buildBars({ favorites, current });

    expect(barText(bar)).toBe(expected);
    expect(groupsText(all)).toBe(expected);
    expect(
      all.flatMap((group) =>
        group.segments.filter(isFavoritePick).filter((pick) => pick.current),
      ),
    ).toHaveLength(1);
  });

  it("only moves the pressed segment when the pick changes between favorites", () => {
    const before = buildBars({ favorites: MANY, current: codex(SOL, "low") });
    const after = buildBars({ favorites: MANY, current: claude(FABLE, "max") });

    const keys = (groups: readonly FavoriteGroup[]) =>
      groups.flatMap((group) =>
        group.segments.filter(isFavoritePick).map((pick) => pick.key),
      );

    const pressed = (groups: readonly FavoriteGroup[]) =>
      groups.flatMap((group) =>
        group.segments
          .filter(isFavoritePick)
          .filter((pick) => pick.current)
          .map((pick) => `${group.modelLabel} ${pick.effortLabel}`),
      );

    expect(keys(after.all)).toEqual(keys(before.all));
    expect(pressed(before.all)).toEqual(["6.1-Sol Low"]);
    expect(pressed(after.all)).toEqual(["Fable 5.1 Max"]);
  });

  it("pins stored favorites and leaves the current pick and the fallback efforts unpinned", () => {
    const pinned = (groups: readonly FavoriteGroup[]) =>
      groups.flatMap((group) =>
        group.segments
          .filter(isFavoritePick)
          .map((pick) => `${pick.effortLabel}:${String(pick.pinned)}`),
      );

    expect(
      pinned(buildBars({ favorites: MINE, current: codex(SOL, "medium") }).all),
    ).toEqual([
      "Low:true",
      "Medium:false",
      "High:true",
      "Max:true",
      "High:true",
      "Max:true",
    ]);
    expect(
      pinned(buildBars({ favorites: [], current: claude(OPUS, "max") }).all),
    ).toEqual([
      "Low:false",
      "Medium:false",
      "High:false",
      "xHigh:false",
      "Max:false",
      "Ultracode:false",
    ]);
  });

  it("applies default-tier favorites at the current speed where the model offers it", () => {
    const { all } = buildBars({
      favorites: [...MINE, codex(LUNA, "high")],
      current: codex(SOL, "low", "fast"),
    });

    expect(
      all.flatMap((group) =>
        group.segments
          .filter(isFavoritePick)
          .map(
            (pick) =>
              `${group.modelLabel} ${pick.effortLabel}:${pick.selection.serviceTier}`,
          ),
      ),
    ).toEqual([
      "6.1-Sol Low:fast",
      "6.1-Sol High:fast",
      "6.1-Sol Max:fast",
      "6-Luna High:default",
      "Opus 5.5 High:default",
      "Opus 5.5 Max:default",
    ]);
  });

  it("puts favorites that start a new chat after the in-place groups", () => {
    const { all } = buildBars({
      favorites: MINE,
      current: claude(OPUS, "max"),
      lockedProvider: "claude-code",
    });

    expect(groupsText(all)).toBe("Opus 5.5: High Max* | 6.1-Sol: Low High Max");
    expect(all.map((group) => group.startsNewChat)).toEqual([false, true]);
  });

  it("falls back to the current model's efforts before favorites that start a new chat", () => {
    const { all } = buildBars({
      favorites: [codex(SOL, "high"), codex(SOL, "max")],
      current: claude(OPUS, "high"),
      lockedProvider: "claude-code",
    });

    expect(groupsText(all)).toBe(
      "Opus 5.5: Low Medium High~ xHigh Max Ultracode ☆ | 6.1-Sol: High Max",
    );
    expect(all.map((group) => [group.current, group.startsNewChat])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("keeps unavailable picks where available ones would be", () => {
    const failedClaude = context({
      catalogs: new Map([
        ["codex", codexCatalog],
        ["claude-code", { ...claudeCatalog, status: "failed" }],
      ]),
    });

    const { all } = buildBars({
      favorites: MINE,
      current: codex(SOL, "low"),
      availability: failedClaude,
    });

    expect(groupsText(all)).toBe(
      "6.1-Sol: Low* High Max | Opus 5.5: High! Max!",
    );
    expect(unavailableReasons(all)).toEqual([
      "Models didn't load",
      "Models didn't load",
    ]);
    expect(landings(all)).toEqual(["6.1-Sol → Low*", "Opus 5.5 → none"]);
  });

  it("orders unavailable favorites by provider and effort, not by list position", () => {
    const { all } = buildBars({
      favorites: [
        { ...claude("gemini-3-pro", "high"), providerId: "gemini" },
        ...MINE,
        claude(OPUS, "ultra"),
      ],
      current: codex(SOL, "low"),
    });

    expect(groupsText(all)).toBe(
      "6.1-Sol: Low* High Max | Opus 5.5: High Max Ultra! | gemini-3-pro: High!",
    );
    expect(unavailableReasons(all)).toEqual([
      "Opus 5.5 has no Ultra",
      "Gemini is off",
    ]);
  });
});

describe("favorite landing", () => {
  const OPUS_LADDER = [
    claude(OPUS, "medium"),
    claude(OPUS, "high"),
    claude(OPUS, "max"),
    claude(OPUS, "ultracode"),
  ];

  it.each([
    {
      name: "keeps the current column, with Ultra and Ultracode as one",
      current: codex(SOL, "ultra"),
      favorites: OPUS_LADDER,
      expected: "Opus 5.5 → Ultracode",
    },
    {
      name: "keeps the current level when the model has it",
      current: codex(SOL, "high"),
      favorites: OPUS_LADDER,
      expected: "Opus 5.5 → High",
    },
    {
      name: "moves to the nearest level otherwise",
      current: codex(SOL, "low"),
      favorites: [claude(OPUS, "max"), claude(OPUS, "medium")],
      expected: "Opus 5.5 → Medium",
    },
    {
      name: "breaks a tie toward the lower level",
      current: codex(SOL, "high"),
      favorites: [claude(OPUS, "xhigh"), claude(OPUS, "medium")],
      expected: "Opus 5.5 → Medium",
    },
    {
      name: "skips picks that are not ready",
      current: codex(SOL, "high"),
      favorites: [claude(OPUS, "ultra"), claude(OPUS, "max")],
      expected: "Opus 5.5 → Max",
    },
  ])("$name", ({ current, favorites, expected }) => {
    const { all } = buildBars({ favorites, current });

    expect(landings(all).at(-1)).toBe(expected);
  });

  it("prefers the default tier when a level has both", () => {
    const { all } = buildBars({
      favorites: [codex(ASTRA, "max", "fast"), codex(ASTRA, "max")],
      current: claude(OPUS, "max"),
    });

    expect(landings(all)).toEqual(["6-Astra → Max", "Opus 5.5 → Max~"]);
  });

  it("names a landing by its action, effort and pinned tier", () => {
    const { all } = buildBars({
      favorites: [codex(SOL, "max", "fast"), claude(OPUS, "high")],
      current: claude(OPUS, "low"),
      lockedProvider: "claude-code",
    });

    const sol = all.find((group) => group.modelLabel === "6.1-Sol");

    expect(sol?.landing?.effortLabel).toBe("Max");
    expect(sol && favoriteActionLabel(sol, sol.landing)).toBe(
      "New chat with 6.1-Sol, Max, Fast",
    );
    expect(sol && favoriteActionLabel(sol, null)).toBe("New chat with 6.1-Sol");
  });
});

describe("buildFavoriteBars fitting", () => {
  const groupWidths = new Map([
    [modelPickerRowKey("codex", SOL), 150],
    [modelPickerRowKey("codex", ASTRA), 90],
    [modelPickerRowKey("codex", GPT55), 90],
    [modelPickerRowKey("claude-code", OPUS), 130],
    [modelPickerRowKey("claude-code", FABLE), 130],
    [modelPickerRowKey("claude-code", SONNET), 150],
  ]);

  function fitted(current: ModelPickerFavorite, available: number): string {
    return barText(
      buildBars(
        { favorites: MANY, current },
        { available, fixed: 40, overflow: 0, groups: groupWidths },
      ).bar,
    );
  }

  it("shows every group when the track has room", () => {
    expect(fitted(codex(SOL, "low"), 780)).toBe(
      "6.1-Sol: Low* High Max | 6-Astra: High | 5.5: Medium | Opus 5.5: High Max | Fable 5.1: High Max | Sonnet 5.5: Medium High",
    );
  });

  it("hides whole trailing groups that do not fit", () => {
    expect(fitted(codex(SOL, "low"), 420)).toBe(
      "6.1-Sol: Low* High Max | 6-Astra: High | 5.5: Medium +3",
    );
  });

  it("drops trailing groups until the current group fits beside them", () => {
    expect(fitted(claude(SONNET, "high"), 430)).toBe(
      "6.1-Sol: Low High Max | 6-Astra: High | Sonnet 5.5: Medium High* +3",
    );
  });

  it("shows the current group alone when nothing else fits beside it", () => {
    expect(fitted(claude(FABLE, "max"), 200)).toBe("Fable 5.1: High Max* +5");
  });

  it("reserves room for the hidden count only once a group must be hidden", () => {
    const fit = (available: number) =>
      barText(
        buildBars(
          { favorites: MANY, current: codex(SOL, "low") },
          { available, fixed: 40, overflow: 30, groups: groupWidths },
        ).bar,
      );

    expect(fit(780)).toBe(
      "6.1-Sol: Low* High Max | 6-Astra: High | 5.5: Medium | Opus 5.5: High Max | Fable 5.1: High Max | Sonnet 5.5: Medium High",
    );
    expect(fit(390)).toBe("6.1-Sol: Low* High Max | 6-Astra: High +4");
  });

  it("asks for the pill when even the current group cannot fit", () => {
    expect(fitted(codex(SOL, "low"), 180)).toBe("pill");
  });

  it("keeps the shown groups when a pick lands on one of them", () => {
    const widths = {
      available: 430,
      fixed: 40,
      overflow: 0,
      groups: groupWidths,
    };

    const before = buildBars(
      { favorites: MANY, current: claude(SONNET, "high") },
      widths,
    ).bar;

    const keys =
      before.kind === "track" ? before.groups.map((group) => group.key) : [];

    const after = buildBars(
      { favorites: MANY, current: codex(SOL, "low") },
      widths,
      { available: 430, keys },
    ).bar;

    expect(barText(after)).toBe(
      "6.1-Sol: Low* High Max | 6-Astra: High | Sonnet 5.5: Medium High +3",
    );
  });

  it("refits from the start when the track width changes", () => {
    const keys = [
      modelPickerRowKey("codex", SOL),
      modelPickerRowKey("codex", ASTRA),
      modelPickerRowKey("claude-code", SONNET),
    ];

    const bar = buildBars(
      { favorites: MANY, current: codex(SOL, "low") },
      { available: 420, fixed: 40, overflow: 0, groups: groupWidths },
      { available: 430, keys },
    ).bar;

    expect(barText(bar)).toBe(
      "6.1-Sol: Low* High Max | 6-Astra: High | 5.5: Medium +3",
    );
  });

  it("keeps every group listed for measuring while the track is fitted", () => {
    const { all } = buildBars(
      { favorites: MANY, current: codex(SOL, "low") },
      { available: 180, fixed: 40, overflow: 0, groups: groupWidths },
    );

    expect(all.map((group) => group.modelLabel)).toEqual([
      "6.1-Sol",
      "6-Astra",
      "5.5",
      "Opus 5.5",
      "Fable 5.1",
      "Sonnet 5.5",
    ]);
  });
});

describe("buildModelBars", () => {
  it.each([
    {
      name: "mine shows one segment per favorite model, Codex first, with no efforts",
      favorites: MINE,
      current: codex(SOL, "low"),
      expected: "6.1-Sol* | Opus 5.5",
    },
    {
      name: "many keeps every favorite model in provider order",
      favorites: MANY,
      current: claude(FABLE, "max"),
      expected: "6.1-Sol | 6-Astra | 5.5 | Opus 5.5 | Fable 5.1* | Sonnet 5.5",
    },
    {
      name: "mine presses a favorite model at an effort that is not a favorite, without a star",
      favorites: MINE,
      current: codex(SOL, "medium"),
      expected: "6.1-Sol* | Opus 5.5",
    },
    {
      name: "mine adds a current model without favorites unpinned in provider order, then ☆",
      favorites: MINE,
      current: codex(ASTRA, "xhigh"),
      expected: "6.1-Sol | 6-Astra~ ☆ | Opus 5.5",
    },
    {
      name: "none shows only the current model, unpinned, then ☆",
      favorites: [],
      current: claude(OPUS, "max"),
      expected: "Opus 5.5~ ☆",
    },
    {
      name: "mine marks the current model's faster tier",
      favorites: MINE,
      current: codex(SOL, "max", "fast"),
      expected: "6.1-Sol[Fast]* | Opus 5.5",
    },
  ])("$name", ({ favorites, current, expected }) => {
    const { bar, all } = buildModels({ favorites, current });

    expect(modelBarText(bar)).toBe(expected);
    expect(modelsText(all)).toBe(expected);
  });

  it("takes each other model's landing from the current pick and keeps the current model ready", () => {
    const { all } = buildModels({
      favorites: [...MINE, codex(ASTRA, "high")],
      current: codex(SOL, "low"),
      landOn: (providerId, model) =>
        model === OPUS
          ? {
              state: "ready",
              selection: { providerId, model, reasoningLevel: "high" },
            }
          : { state: "unavailable", reason: "Models didn't load" },
    });

    expect(modelsText(all)).toBe("6.1-Sol* | 6-Astra! | Opus 5.5");
    expect(all.map((model) => model.landing)).toEqual([
      { state: "ready", selection: codex(SOL, "low") },
      { state: "unavailable", reason: "Models didn't load" },
      {
        state: "ready",
        selection: {
          providerId: "claude-code",
          model: OPUS,
          reasoningLevel: "high",
        },
      },
    ]);
  });

  it("keeps models that start a new chat off the toggle", () => {
    const { all } = buildModels({
      favorites: MINE,
      current: claude(OPUS, "max"),
      lockedProvider: "claude-code",
    });

    expect(modelsText(all)).toBe("Opus 5.5*");
  });
});

describe("buildModelBars fitting", () => {
  const modelWidths = new Map([
    [modelPickerRowKey("codex", SOL), 100],
    [modelPickerRowKey("codex", ASTRA), 90],
    [modelPickerRowKey("codex", GPT55), 60],
    [modelPickerRowKey("claude-code", OPUS), 100],
    [modelPickerRowKey("claude-code", FABLE), 100],
    [modelPickerRowKey("claude-code", SONNET), 110],
  ]);

  function fittedModels(
    current: ModelPickerFavorite,
    available: number,
  ): string {
    return modelBarText(
      buildModels(
        { favorites: MANY, current },
        { available, fixed: 40, overflow: 0, groups: modelWidths },
      ).bar,
    );
  }

  it("shows every model when the toggle has room", () => {
    expect(fittedModels(codex(SOL, "low"), 600)).toBe(
      "6.1-Sol* | 6-Astra | 5.5 | Opus 5.5 | Fable 5.1 | Sonnet 5.5",
    );
  });

  it("drops whole trailing models until the current one fits beside them", () => {
    expect(fittedModels(claude(SONNET, "high"), 340)).toBe(
      "6.1-Sol | 6-Astra | Sonnet 5.5*",
    );
  });

  it("asks for the pill when even the current model cannot fit", () => {
    expect(fittedModels(codex(SOL, "low"), 120)).toBe("pill");
  });
});

describe("buildFavoriteRows", () => {
  it("shows a current level that is not a favorite as an unpinned pick in its model's row", () => {
    expect(
      rowsText(buildRows({ favorites: MINE, current: codex(SOL, "medium") })),
    ).toBe("6.1-Sol: Low Medium~ High Max | Opus 5.5: High Max");
  });

  it("gives a current model without favorites its own row where adding it will place it", () => {
    const shadow = buildRows({ favorites: MINE, current: codex(ASTRA, "max") });

    const added = buildRows({
      favorites: [...MINE, codex(ASTRA, "max")],
      current: codex(ASTRA, "max"),
    });

    expect(rowsText(shadow)).toBe(
      "6.1-Sol: Low High Max | 6-Astra: Max~ | Opus 5.5: High Max",
    );
    expect(rowsText(added)).toBe(
      "6.1-Sol: Low High Max | 6-Astra: Max* | Opus 5.5: High Max",
    );
    expect(shadow.map((row) => row.key)).toEqual(added.map((row) => row.key));
  });

  it("adds no unpinned pick when the current selection is already a favorite", () => {
    expect(
      rowsText(buildRows({ favorites: MINE, current: codex(SOL, "high") })),
    ).toBe("6.1-Sol: Low High* Max | Opus 5.5: High Max");
  });

  it("gives a model's tier-pinned favorites their own row after its default tier", () => {
    const rows = buildRows({
      favorites: [codex(SOL, "max", "fast"), ...MINE],
      current: codex(SOL, "max", "fast"),
    });

    expect(rowsText(rows)).toBe(
      "6.1-Sol: Low High Max | 6.1-Sol[Fast]: Max[Fast]* | Opus 5.5: High Max",
    );
    expect(rows.map((row) => row.current)).toEqual([false, true, false]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(3);
  });

  it("puts favorites that start a new chat after the in-place rows", () => {
    const rows = buildRows({
      favorites: MINE,
      current: claude(OPUS, "max"),
      lockedProvider: "claude-code",
    });

    expect(rowsText(rows)).toBe(
      "Opus 5.5: High Max* | 6.1-Sol (new chat): Low High Max",
    );
  });

  it("lands each row on the current column or its nearest ready pick", () => {
    expect(
      landings(buildRows({ favorites: MANY, current: claude(OPUS, "xhigh") })),
    ).toEqual([
      "6.1-Sol → High",
      "6-Astra → High",
      "5.5 → Medium",
      "Opus 5.5 → xHigh~",
      "Fable 5.1 → High",
      "Sonnet 5.5 → High",
    ]);
  });
});

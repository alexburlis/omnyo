// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultAppSettings,
  defaultUiPreferences,
  MODEL_PICKER_FAVORITES_MAX,
  UI_PREFERENCE_KEYS,
  type AvailableModel,
  type ModelPickerFavorite,
} from "@omnyo/domain";
import type {
  SystemExecutionOptionsResponse,
  SystemProviderCatalogEntry,
} from "@omnyo/server-contract";
import type {
  ExperimentalProviderModelPickerProps,
  ExperimentalProviderModelPickerValue,
} from "@omnyo/plugin-sdk";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import {
  modelPickerFavoritesAtom,
  modelPickerFooterFavoritesAtom,
  modelPickerHiddenModelsAtom,
} from "@/components/pickers/modelPickerPreferences";
import { uiPreferencesQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  readCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ModelPickerSettings } from "./ModelPickerSettings";

const picker = vi.hoisted(() => ({
  next: null as ExperimentalProviderModelPickerValue | null,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      executionOptions: vi.fn(),
      uiPreferences: { list: vi.fn(() => new Promise(() => undefined)) },
    },
    providers: { catalog: vi.fn() },
  },
  OmnyoHttpError: class OmnyoHttpError extends Error {},
}));

vi.mock("@/components/plugin/LazyPluginProviderModelPicker", () => ({
  LazyPluginProviderModelPicker: ({
    value,
    onChange,
  }: ExperimentalProviderModelPickerProps) => (
    <div>
      <output aria-label="Picker value">
        {[
          value.providerId,
          value.model,
          value.reasoningLevel,
          value.serviceTier ?? "-",
        ].join(" ")}
      </output>
      <button
        type="button"
        onClick={() => {
          if (picker.next !== null) onChange(picker.next);
        }}
      >
        Pick in picker
      </button>
    </div>
  ),
}));

const codex = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  capabilities: { supportsServiceTier: true },
});

const claude = makeProviderInfo({
  id: "claude-code",
  displayName: "Claude Code",
});

function availableModel(
  model: string,
  displayName: string,
  levels: readonly string[],
  isDefault = false,
): AvailableModel {
  return {
    id: model,
    model,
    displayName,
    description: "",
    supportedReasoningEfforts: levels.map((reasoningEffort) => ({
      reasoningEffort,
      description: "",
    })),
    defaultReasoningEffort: levels[0] ?? "high",
    isDefault,
  };
}

const models: Record<string, AvailableModel[]> = {
  codex: [
    availableModel("gpt-6.1-sol", "GPT-6.1-Sol", ["high", "xhigh"], true),
    availableModel("gpt-5.6-sol", "GPT-5.6-Sol", ["high"]),
  ],
  "claude-code": [
    availableModel(
      "claude-opus-5-5",
      "Opus 5.5",
      ["high", "xhigh", "ultracode"],
      true,
    ),
    availableModel("claude-haiku-5-5", "Haiku 5.5", ["high"]),
  ],
};

function response(
  providerId: string | undefined,
): SystemExecutionOptionsResponse {
  return {
    providers: [codex, claude],
    models: models[providerId ?? ""] ?? [],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice: null,
  };
}

const disabledOpenCode: SystemProviderCatalogEntry = {
  id: "acp-opencode",
  displayName: "OpenCode",
  pluginId: "provider-acp",
  pluginName: "ACP providers",
  pluginEnabled: true,
  enabled: false,
  available: true,
  logoUrl: null,
  info: null,
};

const solFast: ModelPickerFavorite = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "xhigh",
  serviceTier: "fast",
};

const opusUltracode: ModelPickerFavorite = {
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "ultracode",
  serviceTier: "default",
};

const openCodeFavorite: ModelPickerFavorite = {
  providerId: "acp-opencode",
  model: "big-pickle",
  reasoningLevel: "medium",
  serviceTier: "default",
};

interface RenderOptions {
  favorites?: ModelPickerFavorite[];
  hiddenModels?: Record<string, string[]>;
  ready?: boolean;
}

function renderSettings({
  favorites = [],
  hiddenModels = {},
  ready = true,
}: RenderOptions = {}) {
  const harness = createQueryClientTestHarness();

  if (ready) {
    harness.queryClient.setQueryData(uiPreferencesQueryKey(), {
      preferences: Object.fromEntries(
        UI_PREFERENCE_KEYS.map((key) => [
          key,
          { revision: 0, value: defaultUiPreferences[key] },
        ]),
      ),
    });
  }

  const store = createStore();
  store.set(modelPickerFavoritesAtom, favorites);
  store.set(modelPickerHiddenModelsAtom, hiddenModels);

  render(
    <JotaiProvider store={store}>
      <QueryClientProvider client={harness.queryClient}>
        <ModelPickerSettings
          providers={[codex, claude]}
          generalSettings={defaultAppSettings}
        />
      </QueryClientProvider>
    </JotaiProvider>,
  );

  return { store };
}

const solHigh: ModelPickerFavorite = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
  serviceTier: "default",
};

const sol56: ModelPickerFavorite = {
  providerId: "codex",
  model: "gpt-5.6-sol",
  reasoningLevel: "high",
  serviceTier: "default",
};

function favoriteGroupNames(): string[] {
  return screen
    .getAllByRole("group", { name: / favorites$/ })
    .map((group) => group.getAttribute("aria-label") ?? "");
}

function favoriteRowKeys(): string[] {
  return [...document.querySelectorAll("[data-favorite-row]")].map((row) =>
    (row.getAttribute("data-favorite-row") ?? "").split("\0").join(" "),
  );
}

function levelToggle(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  picker.next = null;
  vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
    response(args?.providerId),
  );
  vi.mocked(sdk.providers.catalog).mockResolvedValue([disabledOpenCode]);
  vi.mocked(sdk.system.uiPreferences.list).mockImplementation(
    () => new Promise<never>(() => undefined),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("ModelPickerSettings", () => {
  it("shows favorites the way the picker does: one row per model, in provider order", async () => {
    renderSettings({
      favorites: [opusUltracode, solFast, sol56, solHigh, openCodeFavorite],
    });

    await screen.findByRole("button", {
      name: "Favorite GPT-6.1-Sol at xHigh",
    });

    expect(favoriteGroupNames()).toEqual([
      "Codex favorites",
      "Claude Code favorites",
      "OpenCode favorites",
    ]);
    expect(favoriteRowKeys()).toEqual([
      "favorite codex gpt-6.1-sol default",
      "favorite codex gpt-6.1-sol fast",
      "favorite codex gpt-5.6-sol default",
      "favorite claude-code claude-opus-5-5 default",
      "favorite acp-opencode big-pickle default",
    ]);
    expect(
      levelToggle("Favorite GPT-6.1-Sol Fast at xHigh").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(
      levelToggle("Favorite GPT-6.1-Sol Fast at High").getAttribute(
        "aria-pressed",
      ),
    ).toBe("false");
    expect(
      levelToggle("Favorite Opus 5.5 at Ultracode").getAttribute(
        "aria-pressed",
      ),
    ).toBe("true");
    expect(screen.getByText("OpenCode is off")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reorder GPT-5.6-Sol" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reorder Opus 5.5" })).toBe(
      null,
    );
  });

  it("adds and removes single levels in place and removes a whole row", async () => {
    const { store } = renderSettings({
      favorites: [solFast, opusUltracode, openCodeFavorite],
    });

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Favorite GPT-6.1-Sol Fast at High",
      }),
    );
    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      solFast,
      opusUltracode,
      openCodeFavorite,
      { ...solFast, reasoningLevel: "high" },
    ]);

    fireEvent.click(levelToggle("Favorite Opus 5.5 at Ultracode"));
    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      solFast,
      openCodeFavorite,
      { ...solFast, reasoningLevel: "high" },
    ]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove GPT-6.1-Sol Fast from favorites",
      }),
    );
    expect(store.get(modelPickerFavoritesAtom)).toEqual([openCodeFavorite]);

    fireEvent.click(levelToggle("Favorite big-pickle at Medium"));
    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);
    expect(
      screen.getByText(
        "No favorites yet. Add one below, or star a level in the model picker.",
      ),
    ).toBeTruthy();
  });

  it("adds the picker's selection with its tier and reads that provider's catalog the way the picker does", async () => {
    const { store } = renderSettings();
    const add = screen.getByRole("button", { name: "Add favorite" });

    expect(add.hasAttribute("disabled")).toBe(true);
    expect(sdk.system.executionOptions).not.toHaveBeenCalled();

    picker.next = {
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
      serviceTier: "fast",
    };
    fireEvent.click(screen.getByRole("button", { name: "Pick in picker" }));
    fireEvent.click(add);

    expect(store.get(modelPickerFavoritesAtom)).toEqual([solFast]);
    expect(
      (
        await screen.findByRole("button", {
          name: "Favorite GPT-6.1-Sol Fast at xHigh",
        })
      ).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(add.textContent).toBe("Added");

    await waitFor(() => {
      expect(
        vi
          .mocked(sdk.system.executionOptions)
          .mock.calls.map(([args]) => args?.providerId)
          .sort(),
      ).toEqual(["claude-code", "codex"]);
    });
    await waitFor(() => {
      expect(
        readCachedModelCatalog(
          modelCatalogCacheKey({
            environmentId: null,
            hostId: null,
            providerId: "codex",
          }),
        ),
      ).not.toBeNull();
    });
    expect(
      readCachedModelCatalog(
        modelCatalogCacheKey({
          environmentId: null,
          hostId: null,
          providerId: "claude-code",
        }),
      ),
    ).toBeNull();
  });

  it("stores the default tier for a provider without service tiers", async () => {
    const { store } = renderSettings();

    picker.next = {
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "ultracode",
    };
    fireEvent.click(screen.getByRole("button", { name: "Pick in picker" }));
    fireEvent.click(screen.getByRole("button", { name: "Add favorite" }));

    expect(store.get(modelPickerFavoritesAtom)).toEqual([opusUltracode]);
    expect(
      (
        await screen.findByRole("button", {
          name: "Favorite Opus 5.5 at Ultracode",
        })
      ).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("stops adding once the favorites list is full", async () => {
    const { store } = renderSettings({
      favorites: [
        solFast,
        ...Array.from(
          { length: MODEL_PICKER_FAVORITES_MAX - 1 },
          (_, index) => ({ ...solFast, model: `model-${index}` }),
        ),
      ],
    });

    picker.next = { ...solFast, reasoningLevel: "high" };
    fireEvent.click(screen.getByRole("button", { name: "Pick in picker" }));

    expect(
      screen
        .getByRole("button", { name: "Add favorite" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      (
        await screen.findByRole("button", {
          name: "Favorite GPT-6.1-Sol Fast at High",
        })
      ).hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen.getByText(
        `You can keep up to ${MODEL_PICKER_FAVORITES_MAX} favorites.`,
      ),
    ).toBeTruthy();
    expect(store.get(modelPickerFavoritesAtom)).toHaveLength(
      MODEL_PICKER_FAVORITES_MAX,
    );
  });

  it("turns favorites in the composer off and on", () => {
    const { store } = renderSettings();

    const toggle = screen.getByRole("switch", {
      name: "Show favorites in the composer",
    });

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    expect(store.get(modelPickerFooterFavoritesAtom)).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(store.get(modelPickerFooterFavoritesAtom)).toBe(true);
  });

  it("lists hidden models per provider and shows one again", async () => {
    const { store } = renderSettings({
      hiddenModels: {
        codex: ["gpt-5.6-sol"],
        "claude-code": ["claude-haiku-5-5"],
      },
    });

    const codexGroup = screen.getByRole("group", {
      name: "Hidden Codex models",
    });

    const claudeGroup = screen.getByRole("group", {
      name: "Hidden Claude Code models",
    });

    expect(await within(codexGroup).findByText("GPT-5.6-Sol")).toBeTruthy();
    expect(await within(claudeGroup).findByText("Haiku 5.5")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show GPT-5.6-Sol" }));

    expect(store.get(modelPickerHiddenModelsAtom)).toEqual({
      "claude-code": ["claude-haiku-5-5"],
    });
    expect(screen.queryByRole("group", { name: "Hidden Codex models" })).toBe(
      null,
    );
  });

  it("waits for saved preferences before showing favorites", () => {
    renderSettings({ favorites: [solFast], ready: false });

    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add favorite" })).toBeNull();
    expect(sdk.system.executionOptions).not.toHaveBeenCalled();
  });

  it("shows an error and stops requesting preferences when they fail to load", async () => {
    vi.mocked(sdk.system.uiPreferences.list).mockRejectedValue(
      new Error("Internal Server Error"),
    );
    renderSettings({ favorites: [solFast], ready: false });

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Couldn't load preferences.",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(sdk.system.uiPreferences.list).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't load preferences.",
    );
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Show favorites in the composer" }),
    ).toBeNull();
    expect(sdk.system.executionOptions).not.toHaveBeenCalled();
  });
});

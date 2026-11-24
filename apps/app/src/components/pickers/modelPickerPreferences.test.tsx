// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultUiPreferences,
  MODEL_PICKER_FAVORITES_MAX,
  UI_PREFERENCE_KEYS,
} from "@omnyo/domain";
import { uiPreferencesQueryKey } from "@/hooks/queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  useFooterFavorites,
  useModelPickerFavorites,
  useModelPickerHiddenModelIds,
  useModelPickerHiddenModels,
} from "./modelPickerPreferences";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      uiPreferences: { list: vi.fn(() => new Promise(() => undefined)) },
    },
  },
  OmnyoHttpError: class OmnyoHttpError extends Error {},
}));

function readyHarness() {
  const harness = createQueryClientTestHarness();
  harness.queryClient.setQueryData(uiPreferencesQueryKey(), {
    preferences: Object.fromEntries(
      UI_PREFERENCE_KEYS.map((key) => [
        key,
        { revision: 0, value: defaultUiPreferences[key] },
      ]),
    ),
  });

  return harness;
}

const sol = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "xhigh",
  serviceTier: "fast",
};

const opus = {
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "ultracode",
  serviceTier: "fast",
};

afterEach(() => {
  cleanup();
});

describe("useModelPickerFavorites", () => {
  it("shows no favorites until preferences have loaded", () => {
    const { result } = renderHook(() => useModelPickerFavorites(), {
      wrapper: createQueryClientTestHarness().wrapper,
    });

    act(() => result.current.add(sol, true));
    expect(result.current.ready).toBe(false);
    expect(result.current.favorites).toEqual([]);
  });

  it("toggles favorites at the default tier and matches them at any tier", async () => {
    const { result } = renderHook(() => useModelPickerFavorites(), {
      wrapper: readyHarness().wrapper,
    });

    const solDefault = { ...sol, serviceTier: "default" };
    const opusDefault = { ...opus, serviceTier: "default" };

    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.toggle(sol, true));
    act(() => result.current.toggle(opus, false));

    expect(result.current.favorites).toEqual([solDefault, opusDefault]);
    expect(result.current.isFavorite(sol, true)).toBe(true);
    expect(result.current.isFavorite(solDefault, true)).toBe(true);
    expect(
      result.current.isFavorite({ ...opus, serviceTier: undefined }, false),
    ).toBe(true);

    act(() => result.current.toggle(sol, true));
    expect(result.current.favorites).toEqual([opusDefault]);
  });

  it("keeps an explicitly added tier and removes the exact match before the default-tier one", async () => {
    const { result } = renderHook(() => useModelPickerFavorites(), {
      wrapper: readyHarness().wrapper,
    });

    const solDefault = { ...sol, serviceTier: "default" };

    await waitFor(() => expect(result.current.ready).toBe(true));
    act(() => result.current.add(sol, true));

    expect(result.current.favorites).toEqual([sol]);
    expect(result.current.isFavorite(solDefault, true)).toBe(false);

    act(() => result.current.toggle(solDefault, true));
    expect(result.current.favorites).toEqual([sol, solDefault]);

    act(() => result.current.toggle(sol, true));
    expect(result.current.favorites).toEqual([solDefault]);

    act(() => result.current.toggle(sol, true));
    expect(result.current.favorites).toEqual([]);
  });

  it("moves and removes favorites by key and stops adding at the cap", async () => {
    const { result } = renderHook(() => useModelPickerFavorites(), {
      wrapper: readyHarness().wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      for (let index = 0; index < MODEL_PICKER_FAVORITES_MAX + 1; index += 1) {
        result.current.add({ ...sol, model: `model-${index}` }, true);
      }
    });

    expect(result.current.favorites).toHaveLength(MODEL_PICKER_FAVORITES_MAX);
    expect(result.current.isFull).toBe(true);

    const keys = () =>
      result.current.favorites.map((favorite) => favorite.model);

    act(() =>
      result.current.moveModel(
        { providerId: "codex", model: "model-2" },
        { providerId: "codex", model: "model-0" },
      ),
    );
    expect(keys().slice(0, 3)).toEqual(["model-2", "model-0", "model-1"]);

    act(() => result.current.remove(`codex\0model-0\0xhigh\0fast`));
    expect(keys().slice(0, 2)).toEqual(["model-2", "model-1"]);
    expect(result.current.isFull).toBe(false);
  });

  it("moves every level of a model together and keeps their saved order", async () => {
    const { result } = renderHook(() => useModelPickerFavorites(), {
      wrapper: readyHarness().wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      result.current.add({ ...sol, model: "a", reasoningLevel: "high" }, true);
      result.current.add({ ...sol, model: "b", reasoningLevel: "low" }, true);
      result.current.add({ ...sol, model: "a", reasoningLevel: "low" }, true);
      result.current.add({ ...sol, model: "c", reasoningLevel: "low" }, true);
    });

    act(() =>
      result.current.moveModel(
        { providerId: "codex", model: "a" },
        { providerId: "codex", model: "c" },
      ),
    );

    expect(
      result.current.favorites.map(
        (favorite) => `${favorite.model}:${favorite.reasoningLevel}`,
      ),
    ).toEqual(["b:low", "c:low", "a:high", "a:low"]);
  });
});

describe("useModelPickerHiddenModels", () => {
  it("hides and shows models per provider without duplicates or empty providers", async () => {
    const { result } = renderHook(
      () => ({
        hidden: useModelPickerHiddenModels(),
        codexIds: useModelPickerHiddenModelIds("codex"),
      }),
      { wrapper: readyHarness().wrapper },
    );

    await waitFor(() => expect(result.current.hidden.ready).toBe(true));
    act(() => {
      result.current.hidden.hide("codex", "gpt-5.5");
      result.current.hidden.hide("codex", "gpt-5.5");
      result.current.hidden.hide("codex", "gpt-5.6-sol");
      result.current.hidden.hide("claude-code", "claude-haiku-5-5");
    });

    expect(result.current.hidden.hiddenModels).toEqual({
      codex: ["gpt-5.5", "gpt-5.6-sol"],
      "claude-code": ["claude-haiku-5-5"],
    });
    expect([...result.current.hidden.hiddenFor("codex")]).toEqual([
      "gpt-5.5",
      "gpt-5.6-sol",
    ]);
    expect([...result.current.codexIds]).toEqual(["gpt-5.5", "gpt-5.6-sol"]);

    act(() => result.current.hidden.unhide("claude-code", "claude-haiku-5-5"));
    expect(result.current.hidden.hiddenModels).toEqual({
      codex: ["gpt-5.5", "gpt-5.6-sol"],
    });
    expect(result.current.hidden.hiddenFor("claude-code").size).toBe(0);
  });
});

describe("useFooterFavorites", () => {
  it("shows favorites in the composer by default and stores the switch", async () => {
    const { result } = renderHook(() => useFooterFavorites(), {
      wrapper: readyHarness().wrapper,
    });

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.shown).toBe(true);
    act(() => result.current.setShown(false));
    expect(result.current.shown).toBe(false);
  });
});

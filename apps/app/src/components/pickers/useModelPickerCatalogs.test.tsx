// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSetAtom } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AvailableModel, SessionOptionSelections } from "@omnyo/domain";
import type { SystemExecutionOptionsResponse } from "@omnyo/server-contract";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import {
  modelCatalogCacheKey,
  readCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { modelPickerHiddenModelsAtom } from "./modelPickerPreferences";
import { useModelPickerCatalogs } from "./useModelPickerCatalogs";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      executionOptions: vi.fn(),
    },
  },
}));

const codex = makeProviderInfo({ id: "codex", displayName: "Codex" });

const claude = makeProviderInfo({
  id: "claude-code",
  displayName: "Claude Code",
});

const pi = makeProviderInfo({ id: "pi", displayName: "Pi" });

function availableModel(
  model: string,
  overrides: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    id: model,
    model,
    displayName: model,
    description: "",
    supportedReasoningEfforts: [
      { reasoningEffort: "high", description: "" },
      { reasoningEffort: "xhigh", description: "" },
    ],
    defaultReasoningEffort: "high",
    isDefault: false,
    ...overrides,
  };
}

const catalogs: Record<string, AvailableModel[]> = {
  codex: [availableModel("gpt-6.1-sol", { isDefault: true })],
  "claude-code": [
    availableModel("claude-opus-5-5", {
      isDefault: true,
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
    availableModel("claude-sonnet-5-5"),
    availableModel("claude-haiku-5-5"),
  ],
};

function response(
  providerId: string | undefined,
): SystemExecutionOptionsResponse {
  const offered = [codex, claude];

  const loaded = offered.some((provider) => provider.id === providerId)
    ? providerId
    : offered[0]?.id;

  return {
    providers: offered,
    models: catalogs[loaded ?? ""] ?? [],
    selectedOnlyModels: [],
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice: null,
  };
}

const noSessionOptions = (): SessionOptionSelections => ({});

beforeEach(() => {
  vi.mocked(sdk.system.executionOptions).mockImplementation(async (args) =>
    response(args?.providerId),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("useModelPickerCatalogs", () => {
  it("loads only sibling providers and leaves the remembered catalogs alone", async () => {
    const { result } = renderHook(
      () =>
        useModelPickerCatalogs({
          routing: { hostId: "host_mac" },
          providers: [codex, claude],
          selectedProviderId: "codex",
          enabled: true,
          sessionOptionSelectionsForProvider: noSessionOptions,
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.map((catalog) => catalog.status)).toEqual([
        "verified",
      ]);
    });
    expect(result.current[0]?.providerId).toBe("claude-code");
    expect(
      result.current[0]?.modelOptions.map((option) => option.value),
    ).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
    expect(vi.mocked(sdk.system.executionOptions).mock.calls).toEqual([
      [
        expect.objectContaining({
          hostId: "host_mac",
          providerId: "claude-code",
        }),
      ],
    ]);
    expect(
      readCachedModelCatalog(
        modelCatalogCacheKey({
          environmentId: null,
          hostId: "host_mac",
          providerId: "claude-code",
        }),
      ),
    ).toBeNull();
  });

  it("requests nothing while disabled", async () => {
    const { result } = renderHook(
      () =>
        useModelPickerCatalogs({
          routing: {},
          providers: [codex, claude],
          selectedProviderId: "codex",
          enabled: false,
          sessionOptionSelectionsForProvider: noSessionOptions,
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    expect(result.current.map((catalog) => catalog.status)).toEqual([
      "loading",
    ]);
    expect(sdk.system.executionOptions).not.toHaveBeenCalled();
  });

  it("marks a provider the machine no longer offers as failed instead of showing another catalog", async () => {
    const { result } = renderHook(
      () =>
        useModelPickerCatalogs({
          routing: {},
          providers: [codex, pi],
          selectedProviderId: "codex",
          enabled: true,
          sessionOptionSelectionsForProvider: noSessionOptions,
        }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current[0]?.status).toBe("failed");
    });
    expect(result.current[0]).toMatchObject({
      providerId: "pi",
      loadError: null,
      modelOptions: [],
      moreModelOptions: [],
    });
  });

  it("applies each sibling's hidden models and agent options to its rows", async () => {
    const { result } = renderHook(
      () => ({
        catalogs: useModelPickerCatalogs({
          routing: {},
          providers: [codex, claude],
          selectedProviderId: "codex",
          enabled: true,
          sessionOptionSelectionsForProvider: (
            providerId,
          ): SessionOptionSelections =>
            providerId === "claude-code" ? { daybreak: true } : {},
        }),
        setHiddenModels: useSetAtom(modelPickerHiddenModelsAtom),
      }),
      { wrapper: createQueryClientTestHarness().wrapper },
    );

    await waitFor(() => {
      expect(result.current.catalogs[0]?.status).toBe("verified");
    });
    act(() => {
      result.current.setHiddenModels({ "claude-code": ["claude-haiku-5-5"] });
    });

    await waitFor(() => {
      expect(
        result.current.catalogs[0]?.moreModelOptions.map(
          (option) => option.value,
        ),
      ).toEqual(["claude-haiku-5-5"]);
    });
    expect(
      result.current.catalogs[0]?.modelOptions.map((option) => [
        option.value,
        option.disabledReason,
      ]),
    ).toEqual([
      ["claude-opus-5-5", "Turn off Daybreak to use this model"],
      ["claude-sonnet-5-5", undefined],
    ]);
  });
});

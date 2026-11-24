// @vitest-environment jsdom

import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  AvailableModel,
  ProviderInfo,
  ReasoningLevel,
} from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import type { SystemExecutionOptionsResponse } from "@omnyo/server-contract";
import type { ExperimentalProviderModelPickerValue } from "@omnyo/plugin-sdk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { systemExecutionOptionsQueryKey } from "@/hooks/queries/query-keys";
import {
  modelCatalogCacheKey,
  writeCachedModelCatalog,
} from "@/lib/model-catalog-cache";
import {
  providerListCacheKey,
  writeCachedProviderList,
} from "@/lib/provider-list-cache";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { PluginProviderModelPicker } from "./PluginProviderModelPicker";
import { ModelReasoningMenu } from "@/components/pickers/ModelReasoningMenuSplit";

const dispatchCommand = vi.hoisted(() =>
  vi.fn((_command: string, _target: EventTarget | null) => true),
);

vi.mock("@/components/commands/AppCommandProvider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/commands/AppCommandProvider")
  >()),
  useAppCommandRunner: () => ({
    dispatch: dispatchCommand,
    getShortcutCommand: () => null,
    isCommandAvailable: () => false,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    hosts: { list: vi.fn().mockResolvedValue([]) },
    system: {
      config: vi.fn().mockResolvedValue({
        primaryHostId: null,
        generalSettings: { streamerMode: false },
      }),
      executionOptions: vi.fn(() => new Promise<never>(() => undefined)),
    },
  },
}));

const providers: ProviderInfo[] = [
  provider("codex", "Codex", "OpenAI", true),
  provider("cursor", "Cursor", "Cursor", true),
  provider("claude-code", "Claude Code", "Claude", false),
];

function provider(
  id: string,
  displayName: string,
  brandPrefix: string,
  supportsServiceTier: boolean,
): ProviderInfo {
  return makeProviderInfo({
    id,
    displayName,
    logoUrl: null,
    maintenance: { health: true, usage: true, installation: false },
    strings: {
      signInHint: "Sign in",
      expiredHint: "Sign in again",
      installUrl: "https://example.com/install",
      brandPrefix,
    },
    capabilities: {
      supportsThreadArchive: true,
      supportsThreadRename: true,
      supportsServiceTier,
      supportsNativeUserQuestion: true,
      supportsFork: true,
      supportsSessionRewind: true,
      permissionModes: ["auto"],
      modelCatalogScope: "host",
    },
  });
}

function model(
  id: string,
  displayName: string,
  reasoning: readonly ReasoningLevel[],
  isDefault = false,
): AvailableModel {
  return {
    id,
    model: id,
    displayName,
    description: "",
    supportedReasoningEfforts: reasoning.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: reasoning[0] ?? "medium",
    isDefault,
  };
}

function executionOptions(
  models: AvailableModel[],
  options?: {
    selectedOnlyModels?: AvailableModel[];
    modelLoadError?: SystemExecutionOptionsResponse["modelLoadError"];
  },
): SystemExecutionOptionsResponse {
  return {
    providers,
    models,
    selectedOnlyModels: options?.selectedOnlyModels ?? [],
    permissionCeiling: "full",
    modelLoadError: options?.modelLoadError ?? null,
    modelNotice: null,
  };
}

function cacheCatalog(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  providerId: string,
  response: SystemExecutionOptionsResponse,
  hostId: string | null = null,
) {
  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({
      environmentId: null,
      hostId,
      providerId,
    }),
    response,
  );
}

beforeAll(() => ModelReasoningMenu.preload());

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

function cell(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function openPicker(): HTMLElement {
  const trigger = screen.getByRole("button", {
    name: "Provider, model and reasoning",
    hidden: true,
  });

  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }

  return trigger;
}

describe("PluginProviderModelPicker", () => {
  it("emits one verified tuple for another provider's cell and closes", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const hostId = "host-remote";
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium", "high"], true),
      ]),
      hostId,
    );
    cacheCatalog(
      queryClient,
      "cursor",
      executionOptions([
        model("cursor-agent", "Cursor Agent", ["medium", "high"], true),
      ]),
      hostId,
    );
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "fast",
      });

      return (
        <PluginProviderModelPicker
          value={value}
          routing={{ kind: "host", hostId }}
          className="plugin-picker"
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.classList.contains("plugin-picker")).toBe(true);
    expect(trigger.getAttribute("aria-keyshortcuts")).toBeNull();
    openPicker();
    fireEvent.click(
      await screen.findByRole("button", { name: "Agent, Medium reasoning" }),
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "cursor",
        model: "cursor-agent",
        reasoningLevel: "medium",
        serviceTier: "fast",
      });
      expect(trigger.textContent).toContain("Agent");
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("reconciles the kept tier against the target model in the same emit", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const tierProviders = providers.map((entry) =>
      entry.id === "codex"
        ? { ...entry, serviceTiers: [{ id: "ultrafast", label: "Ultrafast" }] }
        : entry,
    );

    cacheCatalog(queryClient, "codex", {
      ...executionOptions([
        {
          ...model("gpt-5.5", "OpenAI GPT-5.5", ["high"], true),
          supportedServiceTiers: [{ id: "ultrafast" }],
        },
      ]),
      providers: tierProviders,
    });
    cacheCatalog(queryClient, "cursor", {
      ...executionOptions([
        {
          ...model("cursor-agent", "Cursor Agent", ["high"], true),
          supportedServiceTiers: [{ id: "fast" }],
        },
      ]),
      providers: tierProviders,
    });
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "ultrafast",
      });

      return (
        <PluginProviderModelPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });

    const speed = await screen.findByRole("button", {
      name: "Ultrafast mode, faster responses",
      pressed: true,
    });

    expect(speed.querySelectorAll("svg")).toHaveLength(2);
    openPicker();
    fireEvent.click(
      await screen.findByRole("button", { name: "Agent, High reasoning" }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        providerId: "cursor",
        model: "cursor-agent",
        reasoningLevel: "high",
        serviceTier: "default",
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps the tier for same-provider cells and omits it for a provider without tiers", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium", "high"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );
    cacheCatalog(
      queryClient,
      "claude-code",
      executionOptions([model("claude-opus", "Claude Opus", ["xhigh"], true)]),
    );
    const onChange = vi.fn();

    function ControlledPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "fast",
      });

      return (
        <PluginProviderModelPicker
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }

    render(<ControlledPicker />, { wrapper });
    openPicker();
    fireEvent.click(cell("GPT Light, Low reasoning"));
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
        serviceTier: "fast",
      }),
    );

    const fastMode = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(fastMode.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(fastMode);
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
        serviceTier: "default",
      }),
    );

    openPicker();
    fireEvent.click(
      await screen.findByRole("button", { name: "Opus, xHigh reasoning" }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "claude-code",
        model: "claude-opus",
        reasoningLevel: "xhigh",
      }),
    );
  });

  it("preserves a missing controlled model until an explicit verified choice", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-current", "OpenAI GPT Current", ["medium", "high"], true),
      ]),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-removed",
          reasoningLevel: "ultra",
          serviceTier: "fast",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Provider, model and reasoning" })
          .textContent,
      ).toContain("gpt-removed"),
    );
    expect(onChange).not.toHaveBeenCalled();
    openPicker();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "GPT Current, High reasoning",
      }),
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        providerId: "codex",
        model: "gpt-current",
        reasoningLevel: "high",
        serviceTier: "fast",
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("preserves a controlled retired model from the selected-only catalog", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions(
        [model("gpt-current", "OpenAI GPT Current", ["medium"], true)],
        {
          selectedOnlyModels: [
            model("gpt-retired", "OpenAI GPT Retired", ["high", "xhigh"]),
          ],
        },
      ),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-retired",
          reasoningLevel: "xhigh",
          serviceTier: "default",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );

    const trigger = screen.getByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(trigger.textContent).toContain("GPT Retired");
    expect(trigger.querySelector("[title]")?.getAttribute("title")).toContain(
      "xHigh reasoning",
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not commit loading, placeholder, or failed provider catalogs", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true)]),
    );
    writeCachedModelCatalog(
      modelCatalogCacheKey({
        environmentId: null,
        hostId: null,
        providerId: "claude-code",
      }),
      {
        models: [model("claude-stale", "Claude Stale", ["high"], true)],
        selectedOnlyModels: [],
      },
    );
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      providers,
    );

    const resolveCatalog = new Map<
      string,
      (value: SystemExecutionOptionsResponse) => void
    >();

    vi.mocked(sdk.system.executionOptions).mockImplementation(
      (request) =>
        new Promise<SystemExecutionOptionsResponse>((resolve) => {
          if (request?.providerId) {
            resolveCatalog.set(request.providerId, resolve);
          }
        }),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "fast",
        }}
        onChange={onChange}
      />,
      { wrapper },
    );
    openPicker();
    await waitFor(() =>
      expect(sdk.system.executionOptions).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: "claude-code" }),
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Stale, High reasoning" }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();

    resolveCatalog.get("claude-code")?.(
      executionOptions([], {
        modelLoadError: {
          providerId: "claude-code",
          code: "failed",
          detail: null,
        },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText(/could not load models for claude code/i),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByRole("button", { name: "Stale, High reasoning" }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows a placeholder selected catalog as loading and never closes on it", async () => {
    const { wrapper } = createQueryClientTestHarness();
    writeCachedModelCatalog(
      modelCatalogCacheKey({
        environmentId: null,
        hostId: null,
        providerId: "codex",
      }),
      {
        models: [model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true)],
        selectedOnlyModels: [],
      },
    );
    writeCachedProviderList(
      providerListCacheKey({ environmentId: null, hostId: null }),
      providers,
    );

    const resolveCatalog = new Map<
      string,
      (value: SystemExecutionOptionsResponse) => void
    >();

    vi.mocked(sdk.system.executionOptions).mockImplementation(
      (request) =>
        new Promise<SystemExecutionOptionsResponse>((resolve) => {
          if (request?.providerId) {
            resolveCatalog.set(request.providerId, resolve);
          }
        }),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
        }}
        onChange={onChange}
        allowProviderChange={false}
      />,
      { wrapper },
    );

    const trigger = openPicker();

    expect(screen.getByRole("status", { name: "Loading models" })).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "GPT-5.5, Medium reasoning" }),
    ).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await waitFor(() => expect(resolveCatalog.has("codex")).toBe(true));
    resolveCatalog.get("codex")?.(
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "GPT Light, Low reasoning" }),
    );

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledExactlyOnceWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
      }),
    );
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("returns focus to its trigger without moving the caret into a composer", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );
    const onChange = vi.fn();

    render(
      <>
        <div data-app-composer>
          <textarea aria-label="Composer" />
        </div>
        <PluginProviderModelPicker
          value={{
            providerId: "codex",
            model: "gpt-5.5",
            reasoningLevel: "medium",
          }}
          onChange={onChange}
          allowProviderChange={false}
        />
      </>,
      { wrapper },
    );

    const trigger = openPicker();
    fireEvent.click(cell("GPT Light, Low reasoning"));

    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      "composer.focus",
      expect.anything(),
    );
  });

  it("rehydrates every controlled field without emitting a change", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true)]),
    );
    cacheCatalog(
      queryClient,
      "cursor",
      executionOptions([model("cursor-agent", "Cursor Agent", ["high"], true)]),
    );
    const onChange = vi.fn();

    function RehydratingPicker() {
      const [value, setValue] = useState<ExperimentalProviderModelPickerValue>({
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "medium",
        serviceTier: "default",
      });

      return (
        <>
          <PluginProviderModelPicker
            value={value}
            onChange={(next) => {
              onChange(next);
              setValue(next);
            }}
          />
          <button
            type="button"
            onClick={() =>
              setValue({
                providerId: "codex",
                model: "gpt-5.5",
                reasoningLevel: "medium",
                serviceTier: "default",
              })
            }
          >
            Rehydrate
          </button>
        </>
      );
    }

    render(<RehydratingPicker />, { wrapper });

    const rehydrate = screen.getByRole("button", { name: "Rehydrate" });
    const trigger = openPicker();
    fireEvent.click(
      await screen.findByRole("button", { name: "Agent, High reasoning" }),
    );
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        providerId: "cursor",
        model: "cursor-agent",
        reasoningLevel: "high",
        serviceTier: "default",
      });
      expect(trigger.textContent).toContain("Agent");
      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
        "Cursor: Agent · High reasoning",
      );
    });
    onChange.mockClear();

    fireEvent.click(rehydrate);
    await waitFor(() => {
      expect(trigger.textContent).toContain("GPT-5.5");
      expect(trigger.querySelector("[title]")?.getAttribute("title")).toBe(
        "Codex: GPT-5.5 · Medium reasoning",
      );
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows only the selected provider's group while provider changes are locked", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    cacheCatalog(
      queryClient,
      "codex",
      executionOptions([
        model("gpt-5.5", "OpenAI GPT-5.5", ["medium"], true),
        model("gpt-light", "OpenAI GPT Light", ["low"]),
      ]),
    );
    cacheCatalog(
      queryClient,
      "cursor",
      executionOptions([model("cursor-agent", "Cursor Agent", ["high"], true)]),
    );
    const onChange = vi.fn();

    render(
      <PluginProviderModelPicker
        value={{
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
        }}
        onChange={onChange}
        allowProviderChange={false}
      />,
      { wrapper },
    );

    openPicker();
    expect(cell("GPT Light, Low reasoning")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Agent, High reasoning" }),
    ).toBeNull();
    expect(screen.queryByText("Cursor")).toBeNull();
    fireEvent.click(cell("GPT Light, Low reasoning"));

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        providerId: "codex",
        model: "gpt-light",
        reasoningLevel: "low",
      }),
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

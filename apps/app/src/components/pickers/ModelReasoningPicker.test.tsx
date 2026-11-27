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
import { createStore, Provider as JotaiProvider } from "jotai";
import {
  defaultUiPreferences,
  MODEL_PICKER_FAVORITES_MAX,
  reasoningLevelValues,
  UI_PREFERENCE_KEYS,
  type AvailableModel,
  type ModelPickerFavorite,
  type ProviderInfo,
  type ProviderOptionDescriptor,
  type ReasoningLevel,
  type ServiceTier,
} from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import type {
  SystemExecutionOptionsModelLoadError,
  SystemExecutionOptionsModelNotice,
  SystemExecutionOptionsResponse,
  SystemProvidersQuery,
} from "@omnyo/server-contract";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  uiPreferencesQueryKey,
} from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { expectNonmodalPicker } from "@/test/nonmodal-picker";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  PaneContext,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import type {
  ModelPickerPresentation,
  ModelPickerSelects,
} from "./ModelFavoritesBar";
import {
  ModelReasoningPicker,
  type ModelReasoningPickerHandoff,
} from "./ModelReasoningPicker";
import { ModelReasoningMenu } from "./ModelReasoningMenuSplit";
import type { PickerOption } from "./OptionPicker";
import type { ProviderPickerOption } from "./model-brand-prefix";
import type { ModelPickerOption } from "./model-picker-option";
import type { ModelPickerSelection } from "./model-picker-selection";
import {
  modelPickerFavoritesAtom,
  modelPickerFooterFavoritesAtom,
  modelPickerHiddenModelsAtom,
} from "./modelPickerPreferences";
import {
  buildSessionOptionMenuSections,
  type SessionOptionChoice,
  type SessionOptionMenuSection,
} from "./SessionOptionsMenu";

type CapturedCommandHandler = (invocation: {
  target: EventTarget | null;
}) => boolean;

const commandHandlers = vi.hoisted(
  () => new Map<string, CapturedCommandHandler>(),
);

const dispatchCommand = vi.hoisted(() =>
  vi.fn((_command: string, _target: EventTarget | null) => true),
);

vi.mock("@/lib/sdk", () => ({
  sdk: {
    system: {
      executionOptions: vi.fn(() => new Promise<never>(() => undefined)),
      uiPreferences: { list: vi.fn(() => new Promise<never>(() => undefined)) },
      config: vi.fn(() => new Promise<never>(() => undefined)),
    },
    providers: { catalog: vi.fn(() => new Promise<never>(() => undefined)) },
  },
  OmnyoHttpError: class OmnyoHttpError extends Error {},
}));

vi.mock("@/components/commands/AppCommandProvider", () => ({
  useAppCommandContext: () => undefined,
  useAppCommandHandler: (command: string, handler: CapturedCommandHandler) => {
    commandHandlers.set(command, handler);
  },
  useIndexedAppCommandHandlers: (
    commands: readonly string[],
    handler: (
      index: number,
      invocation: { target: EventTarget | null },
    ) => boolean,
  ) => {
    commands.forEach((command, index) => {
      commandHandlers.set(command, (invocation) => handler(index, invocation));
    });
  },
  useAppCommandRunner: () => ({
    dispatch: dispatchCommand,
    getShortcutCommand: () => null,
    isCommandAvailable: () => false,
  }),
  useAppCommandShortcut: () => null,
  useIsAppCommandModifierHeld: () => false,
}));

const providerOptions: readonly ProviderPickerOption[] = [
  { value: "codex", label: "Codex", brandPrefix: "GPT-" },
  { value: "claude-code", label: "Claude Code", brandPrefix: "Claude " },
];

function ProviderMaskIcon({ className }: { className?: string }) {
  return <span className={className} data-testid="provider-mask-icon" />;
}

const reasoningOptions: readonly PickerOption<ReasoningLevel>[] = [
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const codexLadder: readonly PickerOption<ReasoningLevel>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

function modelRow(
  value: string,
  label: string,
  overrides: Partial<ModelPickerOption> = {},
): ModelPickerOption {
  return {
    value,
    label,
    reasoningOptions,
    defaultReasoningLevel: "medium",
    serviceTierOptions: [],
    ...overrides,
  };
}

const codexModels: readonly ModelPickerOption[] = [
  modelRow("gpt-5.5", "GPT-5.5"),
];

const manyCodexModels: readonly ModelPickerOption[] = [
  modelRow("gpt-5.5", "GPT-5.5"),
  modelRow("gpt-5.2", "GPT-5.2"),
  modelRow("gpt-4.1", "GPT-4.1"),
  modelRow("o3", "o3"),
  modelRow("o4-mini", "o4-mini"),
  modelRow("sonnet-in-codex", "Sonnet"),
];

const splitPaneContext: PaneContextValue = {
  paneId: "test-pane",
  isFocused: true,
  isSplitPane: true,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: true,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane: () => undefined,
};

function availableModel({
  value,
  label,
  isDefault = false,
  efforts = ["medium"],
}: {
  value: string;
  label: string;
  isDefault?: boolean;
  efforts?: readonly ReasoningLevel[];
}): AvailableModel {
  return {
    id: value,
    model: value,
    displayName: label,
    description: "",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: efforts.includes("medium")
      ? "medium"
      : (efforts[0] ?? "medium"),
    isDefault,
  };
}

function executionOptions({
  models,
  selectedOnlyModels = [],
  providers = [],
  modelNotice = null,
}: {
  models: AvailableModel[];
  selectedOnlyModels?: AvailableModel[];
  providers?: ProviderInfo[];
  modelNotice?: SystemExecutionOptionsModelNotice | null;
}): SystemExecutionOptionsResponse {
  return {
    providers,
    models,
    selectedOnlyModels,
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice,
  };
}

function readyPreferences() {
  return {
    preferences: Object.fromEntries(
      UI_PREFERENCE_KEYS.map((key) => [
        key,
        { revision: 0, value: defaultUiPreferences[key] },
      ]),
    ),
  };
}

function getTrigger(): HTMLElement {
  return screen.getByRole("button", { name: "Provider, model and reasoning" });
}

function openFavorites(): void {
  fireEvent.click(getTrigger());
}

function showAllModels(): void {
  const allModels = document.querySelector<HTMLButtonElement>(
    '[data-model-matrix-row="all-models"] button',
  );

  if (allModels !== null) fireEvent.click(allModels);
}

function openPicker(): void {
  openFavorites();
  showAllModels();
}

function renderPicker({
  onSelectedProviderChange = vi.fn(),
  onModelChange = vi.fn(),
  onReasoningChange = vi.fn(),
  onSelectionChange = vi.fn(() => true),
  onServiceTierChange = vi.fn(),
  serviceTierValue,
  serviceTierOptions = [],
  alternateProvider = makeProviderInfo({
    id: "claude-code",
    displayName: "Claude Code",
  }),
  modelOptions = codexModels,
  modelValue = modelOptions[0]?.value ?? "",
  pickerReasoningOptions = reasoningOptions,
  reasoningValue = "medium",
  moreModelOptions = [],
  pickerProviderOptions = providerOptions,
  alternateProviderModels,
  providerRouting,
  selectedProviderId = "codex",
  modelIsLoading = false,
  reasoningIsLoading = false,
  modelLoadError = null,
  modelNotice = null,
  alternateModelNotice = null,
  modelCatalogIsVerified = true,
  requireVerifiedCatalog = false,
  compact = false,
  splitPane = false,
  muted = false,
  handoff,
  agentSections,
  onAgentOptionChange = vi.fn(),
  favorites = [],
  hiddenModels = {},
  footerFavorites = true,
  preferencesReady = true,
  showFavoriteChips = false,
  insideComposer = true,
  presentation,
  selects,
  disabled = false,
  streamerMode = false,
  allowFastServiceTier = true,
}: {
  onSelectedProviderChange?: ((value: string) => void) | null;
  onModelChange?: (value: string) => void;
  onReasoningChange?: (value: ReasoningLevel) => void;
  onSelectionChange?: (selection: ModelPickerSelection) => boolean;
  onServiceTierChange?: (value: ServiceTier) => void;
  serviceTierValue?: ServiceTier;
  serviceTierOptions?: readonly ProviderOptionDescriptor[];
  alternateProvider?: ProviderInfo;
  modelOptions?: readonly ModelPickerOption[];
  modelValue?: string;
  pickerReasoningOptions?: readonly PickerOption<ReasoningLevel>[];
  reasoningValue?: ReasoningLevel;
  moreModelOptions?: readonly ModelPickerOption[];
  pickerProviderOptions?: readonly ProviderPickerOption[];
  alternateProviderModels?: AvailableModel[];
  providerRouting?: SystemProvidersQuery;
  selectedProviderId?: string;
  modelIsLoading?: boolean;
  reasoningIsLoading?: boolean;
  modelLoadError?: SystemExecutionOptionsModelLoadError | null;
  modelNotice?: SystemExecutionOptionsModelNotice | null;
  alternateModelNotice?: SystemExecutionOptionsModelNotice | null;
  modelCatalogIsVerified?: boolean;
  requireVerifiedCatalog?: boolean;
  compact?: boolean;
  splitPane?: boolean;
  muted?: boolean;
  handoff?: ModelReasoningPickerHandoff;
  agentSections?: readonly SessionOptionMenuSection[];
  onAgentOptionChange?: (optionId: string, value: SessionOptionChoice) => void;
  favorites?: ModelPickerFavorite[];
  hiddenModels?: Record<string, string[]>;
  footerFavorites?: boolean;
  preferencesReady?: boolean;
  showFavoriteChips?: boolean;
  insideComposer?: boolean;
  presentation?: ModelPickerPresentation;
  selects?: ModelPickerSelects;
  disabled?: boolean;
  streamerMode?: boolean;
  allowFastServiceTier?: boolean;
} = {}) {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  queryClient.setQueryData(systemConfigQueryKey(), {
    generalSettings: { streamerMode, allowFastServiceTier },
  });

  const routing = {
    environmentId: providerRouting?.environmentId ?? null,
    hostId: providerRouting?.hostId ?? null,
  };

  queryClient.setQueryData(
    systemExecutionOptionsQueryKey({ ...routing, providerId: "claude-code" }),
    executionOptions({
      models: alternateProviderModels ?? [
        availableModel({
          value: "claude-opus-4-7",
          label: "Claude Opus 4.7",
          isDefault: true,
        }),
      ],
      providers: [alternateProvider],
      modelNotice: alternateModelNotice,
    }),
  );

  const providers = pickerProviderOptions.map((option) =>
    option.value === alternateProvider.id
      ? alternateProvider
      : makeProviderInfo({ id: option.value, displayName: option.label }),
  );

  const hiddenForSelected = new Set(hiddenModels[selectedProviderId] ?? []);

  const catalogModelOptions = [
    ...modelOptions,
    ...moreModelOptions.filter((option) => hiddenForSelected.has(option.value)),
  ];

  if (preferencesReady) {
    queryClient.setQueryData(uiPreferencesQueryKey(), readyPreferences());
  }

  const store = createStore();
  store.set(modelPickerFavoritesAtom, favorites);
  store.set(modelPickerHiddenModelsAtom, hiddenModels);
  store.set(modelPickerFooterFavoritesAtom, footerFavorites);

  const pickerElement = (
    <>
      <ModelReasoningPicker
        providers={providers}
        providerOptions={pickerProviderOptions}
        providerRouting={providerRouting}
        selectedProviderId={selectedProviderId}
        onSelectedProviderChange={onSelectedProviderChange ?? undefined}
        hasMultipleProviders
        modelValue={modelValue}
        modelOptions={modelOptions}
        moreModelOptions={moreModelOptions}
        catalogModelOptions={catalogModelOptions}
        modelCatalogIsVerified={modelCatalogIsVerified}
        requireVerifiedCatalog={requireVerifiedCatalog}
        modelIsLoading={modelIsLoading}
        modelLoadError={modelLoadError}
        modelNotice={modelNotice}
        onModelChange={onModelChange}
        reasoningValue={reasoningValue}
        reasoningOptions={pickerReasoningOptions}
        reasoningIsLoading={reasoningIsLoading}
        onReasoningChange={onReasoningChange}
        onSelectionChange={onSelectionChange}
        serviceTierValue={serviceTierValue}
        serviceTierOptions={serviceTierOptions}
        onServiceTierChange={onServiceTierChange}
        muted={muted}
        handoff={handoff}
        agentSections={agentSections}
        onAgentOptionChange={onAgentOptionChange}
        showFavoriteChips={showFavoriteChips}
        presentation={presentation}
        selects={selects}
        disabled={disabled}
      />
      <button type="button">Composer action</button>
    </>
  );

  const picker = insideComposer ? (
    <div data-app-composer>{pickerElement}</div>
  ) : (
    <div>{pickerElement}</div>
  );

  const pickerWithPane = splitPane ? (
    <PaneContext.Provider value={splitPaneContext}>
      {picker}
    </PaneContext.Provider>
  ) : (
    picker
  );

  render(
    <JotaiProvider store={store}>
      {compact ? (
        <CompactViewportOverrideProvider isCompactViewport>
          {pickerWithPane}
        </CompactViewportOverrideProvider>
      ) : (
        pickerWithPane
      )}
    </JotaiProvider>,
    { wrapper },
  );

  return {
    store,
    queryClient,
    onSelectedProviderChange,
    onModelChange,
    onReasoningChange,
    onSelectionChange,
    onServiceTierChange,
    onAgentOptionChange,
  };
}

afterEach(() => {
  cleanup();
  commandHandlers.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("hides an unlisted selected model label in streamer mode without changing the selection", () => {
  const { onModelChange } = renderPicker({
    modelValue: "private-preview-model",
    modelOptions: [],
    streamerMode: true,
  });

  expect(screen.getByText("Selected model")).toBeTruthy();
  expect(screen.queryByText("private-preview-model")).toBeNull();
  expect(onModelChange).not.toHaveBeenCalled();
});

describe("ModelReasoningPicker", () => {
  beforeAll(() => ModelReasoningMenu.preload());

  it.each([
    ["ArrowRight", "medium", "high"],
    ["ArrowLeft", "high", "medium"],
  ] as const)(
    "adjusts reasoning with %s on the focused trigger",
    (key, value, next) => {
      const { onReasoningChange } = renderPicker({ reasoningValue: value });
      const trigger = getTrigger();

      trigger.focus();
      fireEvent.keyDown(trigger, { key });
      expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith(next);
      expect(document.activeElement).toBe(trigger);
    },
  );

  it.each([
    ["ArrowRight", "xhigh", "max"],
    ["ArrowRight", "max", "ultracode"],
    ["ArrowLeft", "ultracode", "max"],
  ] as const)(
    "steps %s from %s to %s in grid order, with Ultracode last",
    (key, value, next) => {
      const { onReasoningChange } = renderPicker({
        pickerReasoningOptions: [
          { value: "high", label: "High" },
          { value: "xhigh", label: "xHigh" },
          { value: "ultracode", label: "Ultracode" },
          { value: "max", label: "Max" },
        ],
        reasoningValue: value,
      });

      fireEvent.keyDown(getTrigger(), { key });
      expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith(next);
    },
  );

  it.each([
    ["ArrowLeft", "medium"],
    ["ArrowRight", "high"],
  ] as const)("stops at the reasoning limit for %s", (key, value) => {
    const { onReasoningChange } = renderPicker({ reasoningValue: value });
    fireEvent.keyDown(getTrigger(), { key });
    expect(onReasoningChange).not.toHaveBeenCalled();
  });

  it("keeps the page interactive and closes when focus leaves", async () => {
    renderPicker();
    const trigger = getTrigger();
    await expectNonmodalPicker({
      trigger,
      open: () => fireEvent.click(trigger),
      content: () => screen.queryByRole("dialog"),
    });
  });

  it("adjusts reasoning in an empty search but preserves text navigation", () => {
    const { onReasoningChange, onModelChange, onSelectionChange } =
      renderPicker({ modelOptions: manyCodexModels });

    openPicker();
    const search = screen.getByPlaceholderText("Search models");
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith("high");
    fireEvent.change(search, { target: { value: "o4" } });
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(onReasoningChange).toHaveBeenCalledTimes(1);
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("adjusts reasoning from the selected model row without changing the model", () => {
    const { onReasoningChange, onModelChange } = renderPicker();
    openPicker();
    const model = screen.getByRole("button", { name: "5.5" });
    model.focus();
    fireEvent.keyDown(model, { key: "ArrowRight" });
    expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith("high");
    expect(onModelChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(model);
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("moves another row's landing ring with arrows and commits there", () => {
    const { onReasoningChange, onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
    });

    openPicker();
    const model = screen.getByRole("button", { name: "5.2" });
    model.focus();
    fireEvent.keyDown(model, { key: "ArrowRight" });

    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: "5.2, High reasoning" })
        .hasAttribute("data-landing"),
    ).toBe(true);

    fireEvent.click(model);

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-5.2",
      reasoningLevel: "high",
    });
  });

  it("leaves modified arrows and models without reasoning alone", () => {
    const { onReasoningChange } = renderPicker();
    const trigger = getTrigger();

    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      fireEvent.keyDown(trigger, { key: "ArrowRight", [modifier]: true });
    }

    expect(onReasoningChange).not.toHaveBeenCalled();
    cleanup();
    renderPicker({ pickerReasoningOptions: [], onReasoningChange });
    fireEvent.keyDown(getTrigger(), { key: "ArrowRight" });
    expect(onReasoningChange).not.toHaveBeenCalled();
  });

  it("uses the lower-emphasis chrome token for the composer caret", () => {
    renderPicker({ muted: true });
    const trigger = getTrigger();

    expect(
      trigger.querySelector('[data-icon="ChevronDown"]')?.classList,
    ).toContain("text-subtle-foreground/75");
    expect(trigger.classList).toContain("font-normal");
  });

  it("gives a non-SVG provider mark the same 16px trigger size as button SVGs", () => {
    renderPicker({
      pickerProviderOptions: [
        { ...providerOptions[0], icon: ProviderMaskIcon },
        providerOptions[1],
      ],
    });

    expect(screen.getByTestId("provider-mask-icon").classList).toContain(
      "size-4",
    );
  });

  it("shows a failed provider's error under its own group and keeps the other providers selectable", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelLoadError: {
        providerId: "codex",
        code: "provider_unavailable",
        detail: null,
      },
    });

    openPicker();

    expect(screen.getByRole("rowheader", { name: "Codex" })).not.toBeNull();
    expect(screen.getByText("Could not load models for Codex.")).not.toBeNull();
    expect(screen.getByText("Provider plugin failed to load")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Opus 4.7, Medium reasoning" }),
    ).toHaveProperty("disabled", false);
  });

  it("names the missing CLI in one short line and links it to the install page", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      pickerProviderOptions: [
        {
          value: "codex",
          label: "Codex",
          brandPrefix: "GPT-",
          installUrl: "https://developers.openai.com/codex/cli",
        },
        { value: "claude-code", label: "Claude Code", brandPrefix: "Claude " },
      ],
      modelLoadError: {
        providerId: "codex",
        code: "missing_executable",
        detail:
          "Omnyo could not find the Codex CLI on this machine. Install Codex (https://developers.openai.com/codex/cli) or put `codex` on PATH, then retry.",
      },
    });

    openPicker();

    expect(screen.getByText("Could not load models for Codex.")).not.toBeNull();
    const reason = screen.getByText("CLI not found");
    expect(reason.tagName).toBe("A");
    expect(reason.getAttribute("href")).toBe(
      "https://developers.openai.com/codex/cli",
    );
    expect(screen.queryByText(/put `codex` on PATH/)).toBeNull();
  });

  it("shows the provider's sign-in instructions beneath a signed-out model-load error", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelLoadError: {
        providerId: "codex",
        code: "auth_required",
        detail:
          "Authentication required. To sign in, run this in a terminal on the machine that hosts the thread, then try again: agent login --device",
      },
    });

    openPicker();

    expect(screen.getByText("Not signed in")).not.toBeNull();
    expect(screen.getByText(/agent login --device$/)).not.toBeNull();
  });

  it("shows the underlying failure detail beneath a generic model-load error", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelLoadError: {
        providerId: "codex",
        code: "failed",
        detail: "Omnyo could not find the Codex CLI on this machine.",
      },
    });

    openPicker();

    expect(screen.getByText("Could not load models for Codex.")).not.toBeNull();
    expect(
      screen.getByText("Omnyo could not find the Codex CLI on this machine."),
    ).not.toBeNull();
    expect(
      screen.getByTitle(
        "Could not load models for Codex. Omnyo could not find the Codex CLI on this machine.",
      ),
    ).not.toBeNull();
  });

  it("holds the trigger and model-list layout with skeletons while loading", () => {
    renderPicker({
      modelOptions: [],
      modelValue: "",
      pickerReasoningOptions: [],
      modelIsLoading: true,
    });

    const trigger = getTrigger();

    expect(
      trigger.querySelectorAll("[data-model-loading-placeholder]"),
    ).toHaveLength(2);
    expect(trigger.textContent).not.toContain("Loading models...");

    fireEvent.click(trigger);
    showAllModels();

    const loadingStatus = screen.getByRole("status", {
      name: "Loading models",
    });

    expect(
      loadingStatus.querySelectorAll("[data-model-loading-row]"),
    ).toHaveLength(4);
    expect(screen.queryByText("Loading models…")).toBeNull();
  });

  it("keeps the selected model visible while its reasoning levels load", () => {
    renderPicker({
      modelOptions: [
        modelRow("selected", "Selected agent model"),
        modelRow("other", "Other agent model"),
      ],
      pickerReasoningOptions: [],
      reasoningIsLoading: true,
    });

    expect(
      within(getTrigger()).getByRole("status", {
        name: "Loading reasoning levels",
      }),
    ).toBeTruthy();
    expect(getTrigger().textContent).toContain("Selected agent model");
    openPicker();
    const grid = screen.getByRole("grid", { name: "Models" });

    const pending = within(grid).getByRole("status", {
      name: "Loading reasoning levels",
    });

    expect(pending.closest("[role=row]")?.textContent).toContain(
      "Selected agent model",
    );
  });

  it("cycles models backward from a Tab-focused composer control", () => {
    const { onModelChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
    });

    const target = screen.getByRole("button", { name: "Composer action" });

    expect(
      commandHandlers.get("modelPicker.cycleModelBackward")?.({ target }),
    ).toBe(true);
    expect(onModelChange).toHaveBeenCalledWith("gpt-5.2");
  });

  it("skips hidden models when cycling with the model chord", () => {
    const { onModelChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
        modelRow("o3", "o3"),
      ],
      hiddenModels: { codex: ["gpt-5.2"] },
    });

    commandHandlers.get("modelPicker.cycleModel")?.({ target: getTrigger() });

    expect(onModelChange).toHaveBeenCalledExactlyOnceWith("o3");
  });

  it("cycles reasoning backward in canonical order and wraps", () => {
    const { onReasoningChange } = renderPicker({
      pickerReasoningOptions: [
        { value: "max", label: "Max" },
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      reasoningValue: "low",
    });

    expect(
      commandHandlers.get("modelPicker.cycleReasoningBackward")?.({
        target: getTrigger(),
      }),
    ).toBe(true);
    expect(onReasoningChange).toHaveBeenCalledWith("max");
  });

  it("swallows the provider cycle chord when provider switching is locked", () => {
    renderPicker({ onSelectedProviderChange: null });

    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({
        target: getTrigger(),
      }),
    ).toBe(true);
  });

  it("does not swallow the provider cycle chord outside its composer", () => {
    renderPicker({ onSelectedProviderChange: null, splitPane: true });
    const outsideTarget = document.createElement("textarea");
    document.body.append(outsideTarget);

    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({
        target: outsideTarget,
      }),
    ).toBe(false);
  });

  it("still opens the split pane's picker from an unrelated editable", () => {
    renderPicker({ splitPane: true });
    const outsideTarget = document.createElement("textarea");
    document.body.append(outsideTarget);

    act(() => {
      expect(
        commandHandlers.get("modelPicker.toggle")?.({ target: outsideTarget }),
      ).toBe(true);
    });
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("cycles the provider while the picker popover is open", () => {
    const { onSelectedProviderChange } = renderPicker();
    const trigger = getTrigger();

    fireEvent.click(trigger);

    expect(
      commandHandlers.get("modelPicker.cycleProvider")?.({ target: trigger }),
    ).toBe(true);
    expect(onSelectedProviderChange).toHaveBeenCalledWith("claude-code");
  });

  it("cycles the provider backward while the picker popover is open", () => {
    const { onSelectedProviderChange } = renderPicker({
      pickerProviderOptions: [
        ...providerOptions,
        { value: "cursor", label: "Cursor" },
      ],
    });

    const trigger = getTrigger();

    fireEvent.click(trigger);

    expect(
      commandHandlers.get("modelPicker.cycleProviderBackward")?.({
        target: trigger,
      }),
    ).toBe(true);
    expect(onSelectedProviderChange).toHaveBeenCalledWith("cursor");
  });

  it("marks the portaled picker as native no-drag content", () => {
    renderPicker();
    openPicker();

    expect(
      screen.getByRole("dialog").getAttribute("data-omnyo-portaled-overlay"),
    ).toBe("");
  });

  it("caps the desktop picker and scrolls only the model grid", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      serviceTierOptions: [{ id: "fast", label: "Fast" }],
      serviceTierValue: "default",
    });

    openPicker();

    const menu = screen.getByRole("dialog");
    expect(menu.className).toContain(
      "max-h-[min(var(--radix-popover-content-available-height),calc(100dvh-0.5rem))]",
    );
    expect(menu.className).toContain("overflow-hidden");

    const scrollers = [
      ...(menu.className.includes("overflow-y-auto") ? [menu] : []),
      ...menu.querySelectorAll<HTMLElement>("[class*='overflow-y-auto']"),
    ];

    expect(scrollers).toHaveLength(1);

    const models = screen.getByRole("grid", { name: "Models" });
    expect(scrollers[0]).toBe(models);
    expect(models.className).toContain("overscroll-contain");
    expect(models.className).toContain("max-h-[20rem]");
    expect(
      menu.contains(
        screen.getByRole("button", { name: "Fast mode, faster responses" }),
      ),
    ).toBe(false);
  });

  it("fits the compact drawer to the favorites, then holds All models at a steady height", async () => {
    renderPicker({
      compact: true,
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
    });

    openFavorites();
    await screen.findByRole("grid", { name: "Models" });

    const drawerClasses = () =>
      screen.getByRole("dialog").className.split(/\s+/);

    expect(drawerClasses()).not.toContain("h-[min(40rem,85dvh)]");
    expect(drawerClasses()).toContain(
      "max-h-[min(40rem,85dvh,calc(92dvh-var(--omnyo-drawer-keyboard-inset,0px)))]",
    );

    showAllModels();

    expect(drawerClasses()).toContain("h-[min(40rem,85dvh)]");
    expect(drawerClasses().join(" ")).not.toContain("100dvh");
    expect(
      (await screen.findByRole("grid", { name: "Models" })).className,
    ).not.toContain("max-h-");
  });

  it("compact: opens straight on All models at its steady height when there are no favorites", async () => {
    renderPicker({ compact: true, modelOptions: manyCodexModels });

    openFavorites();

    expect(await screen.findByPlaceholderText("Search models")).not.toBeNull();
    expect(screen.getByRole("dialog").className.split(/\s+/)).toContain(
      "h-[min(40rem,85dvh)]",
    );
  });

  it("commits a cell as one provider, model and reasoning tuple, then closes and refocuses the composer", async () => {
    const {
      onSelectionChange,
      onModelChange,
      onReasoningChange,
      onSelectedProviderChange,
    } = renderPicker();

    const trigger = getTrigger();

    fireEvent.click(trigger);
    showAllModels();
    fireEvent.click(
      screen.getByRole("button", { name: "Opus 4.7, Medium reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-opus-4-7",
      reasoningLevel: "medium",
    });
    expect(onModelChange).not.toHaveBeenCalled();
    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(onSelectedProviderChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(dispatchCommand).toHaveBeenCalledWith("composer.focus", trigger),
    );
  });

  it("commits a model name at the nearest reasoning level it offers", () => {
    const { onSelectionChange } = renderPicker({
      reasoningValue: "high",
      alternateProviderModels: [
        availableModel({
          value: "claude-haiku-4-5",
          label: "Claude Haiku 4.5",
          isDefault: true,
          efforts: ["low", "medium"],
        }),
      ],
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Haiku 4.5" }));

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-haiku-4-5",
      reasoningLevel: "medium",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("marks other providers as a new chat in an existing chat and leaves the routing to the composer", () => {
    const onStart = vi.fn();

    const { onSelectionChange } = renderPicker({
      handoff: {
        sourceProviderId: "codex",
        active: false,
        onStart,
        onExit: vi.fn(),
      },
    });

    openPicker();

    const pills = screen.getAllByText("New chat");
    expect(pills).toHaveLength(1);
    expect(pills[0].closest('[role="rowheader"]')?.textContent).toContain(
      "Claude Code",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Opus 4.7, Medium reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-opus-4-7",
      reasoningLevel: "medium",
    });
    expect(onStart).not.toHaveBeenCalled();
  });

  it("starts a same-provider handoff from its row and closes", () => {
    const onStart = vi.fn();

    const { onSelectionChange } = renderPicker({
      pickerProviderOptions: providerOptions.filter(
        (provider) => provider.value === "codex",
      ),
      handoff: {
        sourceProviderId: "codex",
        active: false,
        onStart,
        onExit: vi.fn(),
      },
    });

    openPicker();
    fireEvent.click(
      screen.getByRole("button", { name: "Handoff to new thread" }),
    );

    expect(onStart).toHaveBeenCalledOnce();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers the exit control while a handoff is active", () => {
    const onExit = vi.fn();

    renderPicker({
      handoff: {
        sourceProviderId: "codex",
        active: true,
        onStart: vi.fn(),
        onExit,
      },
    });

    openPicker();

    expect(
      screen.queryByRole("button", { name: "Handoff to new thread" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exit handoff" }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("hides the search cursor on pointer motion and preserves keyboard commit", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-6.1-sol", "GPT-6.1-Sol", {
          reasoningOptions: codexLadder,
        }),
        modelRow("gpt-6-astra", "GPT-6-Astra", {
          reasoningOptions: codexLadder,
        }),
        modelRow("gpt-6-luna", "GPT-6-Luna", { reasoningOptions: codexLadder }),
        modelRow("gpt-5.6-mini", "GPT-5.6-Mini"),
        modelRow("gpt-5.6-nano", "GPT-5.6-Nano"),
        modelRow("o3", "o3"),
      ],
      modelValue: "gpt-6-astra",
    });

    openPicker();
    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "sol xh" } });

    expect(
      screen
        .getByRole("button", { name: "6.1-Sol, Extra High reasoning" })
        .hasAttribute("data-landing"),
    ).toBe(true);

    const target = screen.getByRole("button", {
      name: "6.1-Sol, High reasoning",
    });

    fireEvent.pointerMove(target, { pointerType: "touch" });
    expect(document.querySelectorAll("[data-landing]")).toHaveLength(1);
    fireEvent.pointerMove(target, { pointerType: "mouse" });
    expect(document.querySelectorAll("[data-landing]")).toHaveLength(0);
    expect((search as HTMLInputElement).value).toBe("sol xh");
    expect(screen.queryByRole("button", { name: "6-Astra" })).toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      screen
        .getByRole("button", { name: "6.1-Sol, Extra High reasoning" })
        .hasAttribute("data-landing"),
    ).toBe(true);
    fireEvent.pointerMove(target, { pointerType: "mouse" });
    expect(document.querySelectorAll("[data-landing]")).toHaveLength(0);
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-6.1-sol",
      reasoningLevel: "xhigh",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds and removes the current selection as a favorite without closing", () => {
    const { store, onSelectionChange } = renderPicker();

    openFavorites();
    fireEvent.click(screen.getByRole("button", { name: "Back to favorites" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));

    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
    ]);

    const remove = screen.getByRole("button", {
      name: "Remove from favorites",
    });

    expect(remove.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(remove);
    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("hides, shows and stars models in edit mode without committing", () => {
    const { store, onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      moreModelOptions: [modelRow("gpt-4.1", "GPT-4.1")],
      hiddenModels: { codex: ["gpt-4.1"] },
    });

    openPicker();
    expect(screen.getByRole("button", { name: "1 more" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "4.1" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Show 4.1" }));
    expect(store.get(modelPickerHiddenModelsAtom)).toEqual({});

    fireEvent.click(screen.getByRole("button", { name: "Hide 5.2" }));
    expect(store.get(modelPickerHiddenModelsAtom)).toEqual({
      codex: ["gpt-5.2"],
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Favorite 5.5 at High" }),
    );
    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "default",
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("button", { name: "Hide 5.2" })).toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("adds and removes a level favorite from its right-click menu without moving the level", async () => {
    const { store, onSelectionChange } = renderPicker();

    openPicker();
    const high = screen.getByRole("button", { name: "5.5, High reasoning" });

    expect(high.querySelector("[data-model-favorite-mark]")).toBeNull();
    expect(fireEvent.mouseDown(high, { button: 2 })).toBe(false);
    fireEvent.contextMenu(high);

    const addMenu = await screen.findByRole("menu", {
      name: "5.5 · High actions",
    });

    fireEvent.click(
      within(addMenu).getByRole("menuitem", { name: "Add to favorites" }),
    );

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText("Search models"),
      );
    });
    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "high",
        serviceTier: "default",
      },
    ]);

    const marked = screen.getByRole("button", {
      name: "5.5, High reasoning, favorite",
    });

    expect(marked).toBe(high);
    expect(marked.querySelector("[data-model-favorite-mark]")).not.toBeNull();

    fireEvent.contextMenu(marked);

    const removeMenu = await screen.findByRole("menu", {
      name: "5.5 · High actions",
    });

    fireEvent.click(
      within(removeMenu).getByRole("menuitem", {
        name: "Remove from favorites",
      }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);
    expect(high.querySelector("[data-model-favorite-mark]")).toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("favorites the level a model name would apply when the name is right-clicked", async () => {
    const { store } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      reasoningValue: "high",
    });

    openPicker();
    fireEvent.contextMenu(screen.getByRole("button", { name: "5.2" }));

    const menu = await screen.findByRole("menu", {
      name: "5.2 · High actions",
    });

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Add to favorites" }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "codex",
        model: "gpt-5.2",
        reasoningLevel: "high",
        serviceTier: "default",
      },
    ]);
  });

  it("adds the dashed current selection from its right-click menu in the favorites rows", async () => {
    const { store, onSelectionChange } = renderPicker();

    openFavorites();
    fireEvent.click(screen.getByRole("button", { name: "Back to favorites" }));
    fireEvent.contextMenu(
      within(screen.getByRole("rowgroup", { name: "Favorites" })).getByRole(
        "button",
        { name: "Switch to GPT-5.5, Medium" },
      ),
    );

    const menu = await screen.findByRole("menu", {
      name: "GPT-5.5 · Medium actions",
    });

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Add to favorites" }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "codex",
        model: "gpt-5.5",
        reasoningLevel: "medium",
        serviceTier: "default",
      },
    ]);
    expect(
      screen
        .getByRole("button", { name: "Remove from favorites" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("closes the right-click menu on a grid click without applying what was clicked", async () => {
    const { onSelectionChange, onReasoningChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
    });

    openPicker();
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByPlaceholderText("Search models"),
      );
    });
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "5.5, High reasoning" }),
    );

    const menu = await screen.findByRole("menu", {
      name: "5.5 · High actions",
    });

    fireEvent.keyDown(menu, { key: "ArrowRight" });
    fireEvent.keyDown(menu, { key: "r" });
    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBe(menu);

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const other = screen.getByRole("button", { name: "5.2" });

    fireEvent.pointerDown(other, { button: 0 });
    fireEvent.click(other);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).not.toBeNull();

    fireEvent.pointerDown(other, { button: 0 });
    fireEvent.click(other);
    expect(onSelectionChange).toHaveBeenCalledOnce();
  });

  it("offers no favorite menu for a model without reasoning levels", () => {
    const { store } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("codex-mini", "Codex Mini", { reasoningOptions: [] }),
      ],
    });

    openPicker();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Codex Mini" }));
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.contextMenu(
      screen.getByRole("button", { name: "5.5, High reasoning" }),
    );
    expect(
      screen.getByRole("menu", { name: "5.5 · High actions" }),
    ).not.toBeNull();
    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);
  });

  it("removes a favorite from the favorites rows by right-click", async () => {
    const gpt52High: ModelPickerFavorite = {
      providerId: "codex",
      model: "gpt-5.2",
      reasoningLevel: "high",
      serviceTier: "default",
    };

    const gpt55Medium: ModelPickerFavorite = {
      providerId: "codex",
      model: "gpt-5.5",
      reasoningLevel: "medium",
      serviceTier: "default",
    };

    const { store, onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      favorites: [gpt55Medium, gpt52High],
    });

    openFavorites();
    fireEvent.contextMenu(
      within(screen.getByRole("rowgroup", { name: "Favorites" })).getByRole(
        "button",
        { name: "Switch to GPT-5.2, High" },
      ),
    );

    const menu = await screen.findByRole("menu", {
      name: "GPT-5.2 · High actions",
    });

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Remove from favorites" }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([gpt55Medium]);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it("offers no add from the right-click menu once favorites are full", async () => {
    const full = Array.from(
      { length: MODEL_PICKER_FAVORITES_MAX },
      (_, index): ModelPickerFavorite => ({
        providerId: "claude-code",
        model: `claude-extra-${index}`,
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    );

    const { store } = renderPicker({ favorites: full });

    openPicker();
    fireEvent.contextMenu(
      screen.getByRole("button", { name: "5.5, High reasoning" }),
    );

    const menu = await screen.findByRole("menu", {
      name: "5.5 · High actions",
    });

    const add = within(menu).getByRole("menuitem", {
      name: "Add to favorites",
    });

    expect(add.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(add);
    expect(store.get(modelPickerFavoritesAtom)).toEqual(full);
  });

  it("stars a cell at the default tier whatever the current speed", () => {
    const fast = { id: "fast", label: "Fast" };
    const ultrafast = { id: "ultrafast", label: "Ultrafast" };

    const { store } = renderPicker({
      selectedProviderId: "claude-code",
      pickerProviderOptions: providerOptions.filter(
        (provider) => provider.value === "claude-code",
      ),
      alternateProvider: makeProviderInfo({
        id: "claude-code",
        displayName: "Claude Code",
        capabilities: { supportsServiceTier: true },
      }),
      modelOptions: [
        modelRow("opus", "Opus", { serviceTierOptions: [fast, ultrafast] }),
        modelRow("sonnet", "Sonnet", { serviceTierOptions: [fast] }),
      ],
      serviceTierOptions: [fast, ultrafast],
      serviceTierValue: "ultrafast",
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Favorite Opus at High" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Favorite Sonnet at High" }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([
      {
        providerId: "claude-code",
        model: "opus",
        reasoningLevel: "high",
        serviceTier: "default",
      },
      {
        providerId: "claude-code",
        model: "sonnet",
        reasoningLevel: "high",
        serviceTier: "default",
      },
    ]);

    for (const name of ["Favorite Opus at High", "Favorite Sonnet at High"]) {
      expect(
        within(screen.getByRole("grid", { name: "Models" }))
          .getAllByRole("button", { name })
          .every((button) => button.getAttribute("aria-pressed") === "true"),
      ).toBe(true);
    }
  });

  it("folds a hidden model into its provider's more row and still finds it by search", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: manyCodexModels,
      moreModelOptions: [modelRow("gpt-4.1-legacy", "GPT-4.1 Legacy")],
      hiddenModels: { codex: ["gpt-4.1-legacy"] },
    });

    openPicker();
    expect(screen.queryByRole("button", { name: "4.1 Legacy" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "1 more" }));
    expect(screen.getByRole("button", { name: "4.1 Legacy" })).not.toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();

    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "legacy" } });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-4.1-legacy",
      reasoningLevel: "medium",
    });
  });

  it("keeps a selected hidden model in the main list", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      hiddenModels: { codex: ["gpt-5.5"] },
    });

    openPicker();

    expect(
      screen
        .getByRole("button", { name: "5.5, Medium reasoning" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.queryByRole("button", { name: "1 more" })).toBeNull();
  });

  it("shows an unavailable favorite with its reason and never applies it", () => {
    const { onSelectionChange } = renderPicker({
      favorites: [
        {
          providerId: "codex",
          model: "gpt-9",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        {
          providerId: "claude-code",
          model: "claude-opus-4-7",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
    });

    openFavorites();

    const missing = screen.getByTitle("Not on this machine").closest("button");
    expect(missing?.getAttribute("aria-disabled")).toBe("true");

    if (missing) fireEvent.click(missing);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByText("Not on this machine")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Claude Opus 4.7, Medium" }),
    );

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-opus-4-7",
      reasoningLevel: "medium",
      serviceTier: "default",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("overlays an unavailable favorite's reason only while that chip has focus", () => {
    renderPicker({
      favorites: [
        {
          providerId: "codex",
          model: "gpt-9",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
        {
          providerId: "claude-code",
          model: "claude-opus-4-7",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
    });

    openFavorites();

    const reason = () =>
      document.querySelector<HTMLElement>("[data-model-favorite-reason]");

    const missing = screen.getByTitle("Not on this machine").closest("button");

    if (missing === null) throw new Error("missing favorite chip");
    expect(reason()).toBeNull();

    act(() => missing.focus());
    expect(reason()?.textContent).toBe("Not on this machine");
    expect(reason()?.className).toContain("absolute");
    expect(missing.getAttribute("aria-describedby")).toBe(reason()?.id);

    act(() =>
      screen
        .getByRole("button", { name: "Switch to Claude Opus 4.7, Medium" })
        .focus(),
    );
    expect(reason()).toBeNull();

    act(() => missing.focus());
    expect(reason()).not.toBeNull();

    act(() => screen.getByRole("grid", { name: "Models" }).focus());
    expect(reason()).toBeNull();
  });

  it("compact: keeps an unavailable favorite's reason inline inside the favorites rows", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);

      return frames.length;
    });
    renderPicker({
      compact: true,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-9",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
    });

    openPicker();
    act(() => frames.splice(0).forEach((callback) => callback(0)));
    act(() => frames.splice(0).forEach((callback) => callback(16)));

    const missing = screen.getByTitle("Not on this machine").closest("button");

    if (missing === null) throw new Error("missing favorite chip");
    act(() => missing.focus());

    const reason = document.querySelector<HTMLElement>(
      "[data-model-favorite-reason]",
    );

    expect(reason?.textContent).toBe("Not on this machine");
    expect(reason?.className).not.toContain("absolute");
    expect(reason?.closest('[role="rowgroup"]')).toBe(
      screen.getByRole("rowgroup", { name: "Favorites" }),
    );
  });

  it("starts on the current favorite and moves through favorites rows by keyboard before committing with Enter", () => {
    const favoriteOf = (
      model: string,
      reasoningLevel: string,
    ): ModelPickerFavorite => ({
      providerId: "codex",
      model,
      reasoningLevel,
      serviceTier: "default",
    });

    const { onSelectionChange, onReasoningChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { reasoningOptions: codexLadder }),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      pickerReasoningOptions: codexLadder,
      favorites: [
        favoriteOf("gpt-5.5", "medium"),
        favoriteOf("gpt-5.5", "xhigh"),
        favoriteOf("gpt-5.2", "high"),
      ],
      onSelectedProviderChange: null,
    });

    openFavorites();

    const grid = screen.getByRole("grid", { name: "Models" });

    const [sol, gpt52] = within(
      screen.getByRole("rowgroup", { name: "Favorites" }),
    ).getAllByRole("row");

    const cursor = () =>
      document.getElementById(grid.getAttribute("aria-activedescendant") ?? "");

    const rings = () =>
      [...document.querySelectorAll("[data-landing]")].map((cell) =>
        cell.getAttribute("aria-label"),
      );

    expect(cursor()).toBe(sol);
    expect(rings()).toEqual([]);

    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });

    expect(rings()).toEqual(["Switch to GPT-5.5, Extra High"]);
    expect(onReasoningChange).not.toHaveBeenCalled();

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(cursor()).toBe(gpt52);
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(cursor()?.getAttribute("data-model-matrix-row")).toBe("all-models");

    fireEvent.keyDown(grid, { key: "ArrowUp" });
    fireEvent.keyDown(grid, { key: "ArrowUp" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });
    fireEvent.keyDown(grid, { key: "ArrowRight" });
    expect(rings()).toEqual(["Switch to GPT-5.5, Extra High"]);

    fireEvent.keyDown(grid, { key: "Enter" });

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(
      favoriteOf("gpt-5.5", "xhigh"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("applies a favorites row's closest favorite when its name is clicked", () => {
    const favoriteOf = (
      model: string,
      reasoningLevel: string,
    ): ModelPickerFavorite => ({
      providerId: "codex",
      model,
      reasoningLevel,
      serviceTier: "default",
    });

    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { reasoningOptions: codexLadder }),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      pickerReasoningOptions: codexLadder,
      favorites: [
        favoriteOf("gpt-5.5", "medium"),
        favoriteOf("gpt-5.2", "high"),
      ],
      onSelectedProviderChange: null,
    });

    openFavorites();

    const [, gpt52] = within(
      screen.getByRole("rowgroup", { name: "Favorites" }),
    ).getAllByRole("row");

    const name = gpt52.querySelector<HTMLElement>("[data-model-favorite-name]");

    expect(name?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(name as HTMLElement);

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(
      favoriteOf("gpt-5.2", "high"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps favorites rows in the favorites view and out of All models search", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.2",
          reasoningLevel: "high",
          serviceTier: "default",
        },
      ],
    });

    openFavorites();
    expect(screen.getByRole("rowgroup", { name: "Favorites" })).not.toBeNull();

    showAllModels();
    fireEvent.change(screen.getByPlaceholderText("Search models"), {
      target: { value: "5.2" },
    });
    expect(screen.queryByRole("rowgroup", { name: "Favorites" })).toBeNull();
    expect(screen.getByRole("button", { name: "5.2" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to favorites" }));
    expect(screen.getByRole("rowgroup", { name: "Favorites" })).not.toBeNull();
    expect(screen.queryByPlaceholderText("Search models")).toBeNull();
  });

  it("aligns reasoning columns across providers with one shared Ultra column", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-6.1-sol", "GPT-6.1-Sol", {
          reasoningOptions: codexLadder,
        }),
      ],
      alternateProviderModels: [
        availableModel({
          value: "claude-opus-5-5",
          label: "Claude Opus 5.5",
          isDefault: true,
          efforts: ["max", "medium", "ultracode", "high", "xhigh"],
        }),
      ],
    });

    openPicker();

    const cellsOf = (name: string) => [
      ...(screen
        .getByRole("button", { name })
        .closest<HTMLElement>('[role="row"]')
        ?.querySelectorAll<HTMLElement>('[role="gridcell"]') ?? []),
    ];

    const levelsOf = (name: string) =>
      cellsOf(name)
        .slice(1)
        .map(
          (cell) =>
            cell
              .querySelector("[data-model-matrix-cell]")
              ?.getAttribute("data-model-matrix-cell") ?? "-",
        );

    expect(screen.queryAllByRole("columnheader")).toEqual([]);
    expect(levelsOf("6.1-Sol")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "-",
      "-",
    ]);
    expect(levelsOf("Opus 5.5")).toEqual([
      "-",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
    ]);
    expect(
      screen.queryByRole("button", { name: "6.1-Sol, Ultracode reasoning" }),
    ).toBeNull();
  });

  it("keeps an Ultra selection in the Ultra column when switching provider by name", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-6.1-sol", "GPT-6.1-Sol", {
          reasoningOptions: [
            ...codexLadder,
            { value: "ultra", label: "Ultra" },
          ],
        }),
      ],
      pickerReasoningOptions: [
        ...codexLadder,
        { value: "ultra", label: "Ultra" },
      ],
      reasoningValue: "ultra",
      alternateProviderModels: [
        availableModel({
          value: "claude-opus-5-5",
          label: "Claude Opus 5.5",
          isDefault: true,
          efforts: ["high", "xhigh", "ultracode", "max"],
        }),
      ],
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Opus 5.5" }));

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "claude-code",
      model: "claude-opus-5-5",
      reasoningLevel: "ultracode",
    });
  });

  it("keeps duplicate Pi models distinct by their nested provider", () => {
    const apiModel = "openai/gpt-5.3-codex-spark";
    const subscriptionModel = "openai-codex/gpt-5.3-codex-spark";
    const modelLabel = "GPT-5.3 Codex Spark";

    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow(apiModel, modelLabel, { routeProviderId: "openai" }),
        modelRow(subscriptionModel, modelLabel, {
          routeProviderId: "openai-codex",
        }),
      ],
      modelValue: subscriptionModel,
      pickerProviderOptions: [{ value: "pi", label: "Pi" }],
      selectedProviderId: "pi",
    });

    const trigger = getTrigger();

    expect(trigger.textContent).toContain(modelLabel);
    expect(trigger.textContent).not.toContain("openai-codex");

    fireEvent.click(trigger);
    showAllModels();

    expect(screen.getAllByText(modelLabel)).toHaveLength(3);
    const apiQualifier = screen.getByText("openai");
    expect(screen.getByText("openai-codex")).not.toBeNull();

    fireEvent.click(apiQualifier);

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "pi",
      model: apiModel,
      reasoningLevel: "medium",
    });
  });

  it("uses picker search policy and commits the first match with Enter", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: manyCodexModels,
    });

    openPicker();

    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "o4m" } });

    expect(screen.getByText("o4-mini")).not.toBeNull();
    expect(screen.queryByText("Sonnet")).toBeNull();

    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "o4-mini",
      reasoningLevel: "medium",
    });
  });

  it("ranks primary and selected-only model matches together", () => {
    const looseMatch = "Super GPT-4 Compatibility";
    const directMatch = "GPT-4 Turbo";

    renderPicker({
      modelOptions: [
        modelRow("super-gpt-4", looseMatch),
        modelRow("alpha", "Alpha"),
        modelRow("beta", "Beta"),
        modelRow("gamma", "Gamma"),
        modelRow("delta", "Delta"),
      ],
      moreModelOptions: [modelRow("gpt-4-turbo", directMatch)],
      pickerProviderOptions: [{ value: "codex", label: "Codex" }],
    });

    openPicker();
    fireEvent.change(screen.getByPlaceholderText("Search models"), {
      target: { value: "gpt4" },
    });

    const directResult = screen.getByText(directMatch);
    const looseResult = screen.getAllByText(looseMatch).at(-1);
    expect(looseResult).toBeTruthy();

    if (!looseResult) return;
    expect(
      directResult.compareDocumentPosition(looseResult) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("returns the results viewport to the top when searching", () => {
    renderPicker({ modelOptions: manyCodexModels });

    openPicker();

    const search = screen.getByPlaceholderText("Search models");
    const list = screen.getByRole("grid", { name: "Models" });
    list.scrollTop = 120;

    fireEvent.change(search, { target: { value: "o4" } });

    expect(list.scrollTop).toBe(0);
  });

  it("resets retained mobile browse state after the drawer closes", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);

      return frames.length;
    });
    renderPicker({ compact: true, modelOptions: manyCodexModels });

    const trigger = getTrigger();

    fireEvent.click(trigger);
    act(() => frames.splice(0).forEach((callback) => callback(0)));
    act(() => frames.splice(0).forEach((callback) => callback(16)));

    const search = screen.getByPlaceholderText(
      "Search models",
    ) as HTMLInputElement;

    fireEvent.change(search, { target: { value: "o4" } });
    expect(search.value).toBe("o4");

    fireEvent.keyDown(document, { key: "Escape" });

    const drawer = document.querySelector<HTMLElement>(
      "[data-persistent-drawer-content]",
    );

    fireEvent.transitionEnd(drawer as HTMLElement, {
      propertyName: "transform",
    });
    fireEvent.click(trigger);

    expect(
      (screen.getByPlaceholderText("Search models") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.getByText("o4-mini")).not.toBeNull();
  });

  it("reaches selected-only models by keyboard once a search flattens them", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: manyCodexModels,
      moreModelOptions: [modelRow("gpt-4.1-legacy", "GPT-4.1 Legacy")],
    });

    openPicker();

    const search = screen.getByPlaceholderText("Search models");
    fireEvent.change(search, { target: { value: "legacy" } });

    expect(screen.getByText("4.1 Legacy")).not.toBeNull();

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-4.1-legacy",
      reasoningLevel: "medium",
    });
  });

  it("compact: keeps the speed control outside the scrollable model grid", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);

      return frames.length;
    });
    renderPicker({
      compact: true,
      modelOptions: manyCodexModels,
      serviceTierOptions: [{ id: "fast", label: "Fast" }],
      serviceTierValue: "default",
    });

    openPicker();
    act(() => frames.splice(0).forEach((callback) => callback(0)));
    act(() => frames.splice(0).forEach((callback) => callback(16)));

    const modelGrid = screen.getByRole("grid", { name: "Models" });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(screen.getByRole("dialog").contains(speed)).toBe(false);

    for (const className of [
      "min-h-0",
      "flex-1",
      "overflow-y-auto",
      "overscroll-contain",
    ]) {
      expect(modelGrid.classList.contains(className)).toBe(true);
    }

    const scrollParents: string[] = [];

    for (
      let element = modelGrid.parentElement;
      element !== null && element.getAttribute("role") !== "dialog";
      element = element.parentElement
    ) {
      if (element.classList.contains("overflow-y-auto")) {
        scrollParents.push(element.className);
      }
    }

    expect(scrollParents).toEqual([]);
  });

  it("closes when focus leaves the window, as a click into a preview or browser panel does", () => {
    renderPicker({ modelOptions: manyCodexModels });
    openPicker();

    expect(screen.getByRole("dialog")).not.toBeNull();

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains a provider's account notice once in Favorites and under its All models header", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
      modelNotice: {
        providerId: "codex",
        message: "OpenAI used up",
        detail: "Showing openai2@",
        until: Date.now() + 2 * 60 * 60 * 1000,
      },
    });
    openFavorites();

    const favoritesLine = document.querySelector(
      '[data-model-picker-notice="codex"]',
    );

    expect(favoritesLine?.textContent).toMatch(
      /^OpenAI used up until .+ · Showing openai2@$/u,
    );

    showAllModels();

    const headerNotice = document.querySelector(
      '[data-model-picker-notice="codex"]',
    );

    expect(headerNotice?.textContent).toMatch(
      /^OpenAI used up until .+Showing openai2@$/u,
    );
    expect(
      document.querySelectorAll('[data-model-picker-notice="codex"]'),
    ).toHaveLength(1);
  });

  it("keeps another provider's notice out of Favorites unless one of its models is a favorite", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
      alternateModelNotice: {
        providerId: "claude-code",
        message: "claude@ used up",
        detail: "Using claude2@",
        until: null,
      },
    });
    openFavorites();

    expect(
      document.querySelector('[data-model-picker-notice="claude-code"]'),
    ).toBeNull();

    showAllModels();

    expect(
      document.querySelector('[data-model-picker-notice="claude-code"]')
        ?.textContent,
    ).toBe("claude@ used upUsing claude2@");
  });

  it("drops a notice once its reset time has passed", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
      modelNotice: {
        providerId: "codex",
        message: "OpenAI used up",
        detail: "Showing openai2@",
        until: Date.now() - 1000,
      },
    });
    openPicker();

    expect(document.querySelector("[data-model-picker-notice]")).toBeNull();
  });

  it("opens on favorites, moves typing into a focused All models search, and steps back on Escape", () => {
    renderPicker({
      modelOptions: manyCodexModels,
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.5",
          reasoningLevel: "medium",
          serviceTier: "default",
        },
      ],
    });
    openFavorites();

    expect(screen.queryByPlaceholderText("Search models")).toBeNull();

    fireEvent.keyDown(screen.getByRole("grid", { name: "Models" }), {
      key: "5",
    });

    const search = screen.getByPlaceholderText("Search models");

    expect(search).toHaveProperty("value", "5");
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole("rowgroup", { name: "Favorites" })).toBeNull();

    fireEvent.keyDown(search, { key: "Escape" });

    expect(screen.queryByPlaceholderText("Search models")).toBeNull();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByRole("button", { name: /^All models/u })).not.toBeNull();
  });

  it.each([
    {
      label: "fetches every sibling once opened",
      locked: false,
      expected: ["cursor", "pi"],
    },
    { label: "fetches nothing", locked: true, expected: [] },
  ])(
    "$label on the routed host with switching locked: $locked",
    async ({ locked, expected }) => {
      vi.mocked(sdk.system.executionOptions).mockImplementation(
        () => new Promise<SystemExecutionOptionsResponse>(() => undefined),
      );
      renderPicker({
        ...(locked ? { onSelectedProviderChange: null } : {}),
        providerRouting: { hostId: "h1" },
        pickerProviderOptions: [
          { value: "codex", label: "Codex" },
          { value: "cursor", label: "Cursor" },
          { value: "pi", label: "Pi" },
        ],
      });

      const calls = () =>
        vi
          .mocked(sdk.system.executionOptions)
          .mock.calls.map(([args]) => `${args?.hostId}/${args?.providerId}`)
          .sort();

      await act(async () => {});
      expect(calls()).toEqual([]);

      openPicker();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      expect(screen.getByRole("dialog")).not.toBeNull();
      expect(calls()).toEqual(expected.map((providerId) => `h1/${providerId}`));
    },
  );

  it("loads sibling provider models on the compose-selected host", async () => {
    renderPicker({ providerRouting: { hostId: "host-remote" } });

    openPicker();

    expect(await screen.findByText("Opus 4.7")).not.toBeNull();
  });

  it("keeps model names readable and sizes one shared column per level to its labels", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-6.1-sol", "GPT-6.1-Sol", {
          reasoningOptions: reasoningLevelValues
            .filter((level) => level !== "ultracode")
            .map((level) => ({ value: level, label: level })),
        }),
      ],
      alternateProviderModels: [
        availableModel({
          value: "claude-opus-5-5",
          label: "Claude Opus 5.5",
          isDefault: true,
          efforts: ["medium", "ultracode"],
        }),
      ],
    });

    openPicker();

    const row = screen
      .getByRole("button", { name: "6.1-Sol" })
      .closest<HTMLElement>('[role="row"]');

    expect(row?.querySelectorAll('[role="gridcell"]')).toHaveLength(8);
    expect(row?.className).toContain("grid-cols-subgrid");
    expect(
      screen.getByRole("grid", { name: "Models" }).style.gridTemplateColumns,
    ).toBe("minmax(5rem, 1fr) repeat(7, auto)");
    expect(screen.getByRole("dialog").className).toContain(
      "max-w-[min(28rem,calc(100vw-1rem))]",
    );
  });

  it("centres a hidden selected row once the compact drawer realizes its content", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);

      return frames.length;
    });

    const selectedRowKey = "codex\0sonnet-in-codex";

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function rectFor(this: Element) {
        if (this.getAttribute("role") === "grid") {
          return new DOMRect(0, 400, 390, 400);
        }

        return this.getAttribute("data-model-matrix-row") === selectedRowKey
          ? new DOMRect(0, 1000, 390, 64)
          : new DOMRect(0, 0, 0, 0);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(
      function heightFor(this: HTMLElement) {
        return this.getAttribute("role") === "grid" ? 400 : 0;
      },
    );

    const nearest = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => undefined);

    renderPicker({
      compact: true,
      modelOptions: manyCodexModels,
      modelValue: "sonnet-in-codex",
    });

    openPicker();

    expect(document.querySelector("[data-model-matrix-row]")).toBeNull();

    act(() => frames.splice(0).forEach((callback) => callback(0)));
    act(() => frames.splice(0).forEach((callback) => callback(16)));
    showAllModels();

    const grid = screen.getByRole("grid", { name: "Models" });

    expect(grid.scrollTop).toBe(600 - (400 - 64) / 2);
    expect(nearest).not.toHaveBeenCalled();

    fireEvent.keyDown(grid, { key: "ArrowUp" });

    expect(nearest).toHaveBeenCalledWith({ block: "nearest" });
  });

  it("shows no keyboard ring until the keyboard moves the cursor", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      onSelectedProviderChange: null,
    });

    openPicker();

    const rings = () =>
      [...document.querySelectorAll("[data-landing]")].map((cell) =>
        cell.getAttribute("aria-label"),
      );

    expect(rings()).toEqual([]);

    fireEvent.keyDown(screen.getByRole("grid", { name: "Models" }), {
      key: "ArrowDown",
    });

    expect(rings()).toEqual(["5.2, Medium reasoning"]);
  });

  it("hides the keyboard cursor when the mouse moves instead of chasing the pointer", () => {
    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
        modelRow("gpt-5.1", "GPT-5.1"),
      ],
      onSelectedProviderChange: null,
    });

    openPicker();
    const grid = screen.getByRole("grid", { name: "Models" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });

    const rings = () =>
      [...document.querySelectorAll("[data-landing]")].map((cell) =>
        cell.getAttribute("aria-label"),
      );

    expect(rings()).toEqual(["5.2, Medium reasoning"]);

    const lastRow = screen
      .getByRole("button", { name: "5.1" })
      .closest<HTMLElement>('[role="row"]');

    if (lastRow === null) throw new Error("missing row");
    fireEvent.pointerMove(lastRow, { pointerType: "touch" });
    expect(rings()).toEqual(["5.2, Medium reasoning"]);

    fireEvent.pointerMove(lastRow, { pointerType: "mouse" });
    expect(rings()).toEqual([]);

    fireEvent.pointerMove(lastRow, { pointerType: "mouse" });
    fireEvent.pointerLeave(grid, { pointerType: "mouse" });
    expect(rings()).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "5.1, High reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
      providerId: "codex",
      model: "gpt-5.1",
      reasoningLevel: "high",
    });
  });

  it("leaves live reasoning alone while the cursor is on a provider's more row", () => {
    const { onReasoningChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      moreModelOptions: [modelRow("gpt-4.1", "GPT-4.1")],
      hiddenModels: { codex: ["gpt-4.1"] },
      onSelectedProviderChange: null,
    });

    openPicker();

    const grid = screen.getByRole("grid", { name: "Models" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    fireEvent.keyDown(grid, { key: "ArrowDown" });

    expect(
      screen.getByRole("button", { name: "1 more" }).closest('[role="row"]')
        ?.className,
    ).toContain("bg-state-hover");

    fireEvent.keyDown(grid, { key: "ArrowRight" });
    fireEvent.keyDown(grid, { key: "ArrowLeft" });

    expect(onReasoningChange).not.toHaveBeenCalled();
  });

  it("presses only the selected cell, with the active chip look", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
    });

    openPicker();

    const pressed = within(screen.getByRole("grid", { name: "Models" }))
      .getAllByRole("button", { pressed: true })
      .filter((cell) => cell.hasAttribute("data-model-matrix-cell"));

    expect(pressed.map((cell) => cell.getAttribute("aria-label"))).toEqual([
      "5.5, Medium reasoning",
    ]);
    expect(pressed[0]?.className).toContain("bg-state-active");
  });

  it("shows the selected row's efforts and reveals other rows only on hover, keyboard or focus", () => {
    renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      onSelectedProviderChange: null,
    });

    openPicker();

    const modes = () =>
      [
        ...document.querySelectorAll<HTMLElement>("[data-model-matrix-row]"),
      ].map(
        (row) =>
          `${row.querySelector("[data-model-matrix-name]")?.textContent ?? ""}:${row.dataset.modelMatrixCells}${row.hasAttribute("data-active") ? "@" : ""}`,
      );

    expect(modes()).toEqual(["5.5:all", "5.2:reveal"]);

    fireEvent.keyDown(screen.getByRole("grid", { name: "Models" }), {
      key: "ArrowDown",
    });

    expect(modes()).toEqual(["5.5:all", "5.2:reveal@"]);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(
      [
        ...document.querySelectorAll<HTMLElement>("[data-model-matrix-row]"),
      ].map((row) => row.dataset.modelMatrixCells),
    ).toEqual(["all", "all"]);
  });

  it("compact: renders a hidden row's efforts only while the keyboard cursor is on it", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);

      return frames.length;
    });
    renderPicker({
      compact: true,
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      onSelectedProviderChange: null,
    });

    openPicker();
    act(() => frames.splice(0).forEach((callback) => callback(0)));
    act(() => frames.splice(0).forEach((callback) => callback(16)));
    showAllModels();

    const efforts = (model: string) =>
      screen
        .getByRole("button", { name: model })
        .closest('[role="row"]')
        ?.querySelectorAll("[data-model-matrix-cell]").length;

    expect(efforts("5.5")).toBe(2);
    expect(efforts("5.2")).toBe(0);

    fireEvent.keyDown(screen.getByRole("grid", { name: "Models" }), {
      key: "ArrowDown",
    });

    expect(efforts("5.2")).toBe(2);
  });

  it("keeps the picker open when the owner refuses a commit", () => {
    const onSelectionChange = vi.fn(() => false);
    renderPicker({ onSelectionChange });

    openPicker();
    fireEvent.click(
      screen.getByRole("button", { name: "5.5, High reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(dispatchCommand).not.toHaveBeenCalledWith(
      "composer.focus",
      getTrigger(),
    );
  });

  it("returns focus to its trigger instead of a composer when it lives outside one", async () => {
    const { onSelectionChange } = renderPicker({ insideComposer: false });
    const trigger = getTrigger();

    fireEvent.click(trigger);
    showAllModels();
    fireEvent.click(
      screen.getByRole("button", { name: "Opus 4.7, Medium reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenCalledOnce();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(dispatchCommand).not.toHaveBeenCalledWith("composer.focus", trigger);
  });

  it("shows an unverified selected catalog as loading when commits need a verified catalog", () => {
    const { onSelectionChange } = renderPicker({
      requireVerifiedCatalog: true,
      modelCatalogIsVerified: false,
      onSelectedProviderChange: null,
    });

    openPicker();

    expect(
      screen.getByRole("status", { name: "Loading models" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "5.5, Medium reasoning" }),
    ).toBeNull();
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

describe("ModelReasoningPicker favorites switcher", () => {
  beforeAll(() => ModelReasoningMenu.preload());

  const current: ModelPickerFavorite = {
    providerId: "codex",
    model: "gpt-5.5",
    reasoningLevel: "medium",
    serviceTier: "default",
  };

  const gptHigh: ModelPickerFavorite = { ...current, reasoningLevel: "high" };

  const opus: ModelPickerFavorite = {
    providerId: "claude-code",
    model: "claude-opus-4-7",
    reasoningLevel: "medium",
    serviceTier: "default",
  };

  const sonnetHigh: ModelPickerFavorite = {
    providerId: "claude-code",
    model: "claude-sonnet-4-6",
    reasoningLevel: "high",
    serviceTier: "default",
  };

  const claudeModels = [
    availableModel({
      value: "claude-opus-4-7",
      label: "Claude Opus 4.7",
      isDefault: true,
    }),
    availableModel({
      value: "claude-sonnet-4-6",
      label: "Claude Sonnet 4.6",
      efforts: ["medium", "high"],
    }),
  ];

  const existingChat: ModelReasoningPickerHandoff = {
    sourceProviderId: "codex",
    active: false,
    onStart: vi.fn(),
    onExit: vi.fn(),
  };

  function switcher(): HTMLElement | null {
    return screen.queryByRole("group", { name: "Model and effort" });
  }

  function segmentName(button: HTMLElement): string {
    const label = button.getAttribute("aria-label");

    if (label !== null) return label;
    const visible = button.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("[aria-hidden]").forEach((node) => node.remove());

    return visible.textContent ?? "";
  }

  function segments(element: HTMLElement): string[] {
    return within(element)
      .getAllByRole("button")
      .map(
        (button) =>
          `${segmentName(button)}${button.getAttribute("aria-pressed") === "true" ? "*" : ""}`,
      );
  }

  function mockTrackLayout(
    available: number,
    groupWidths: Readonly<Record<string, number>>,
  ) {
    const fixed = 40;

    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;

        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }

        observe() {
          setTimeout(() => act(() => this.callback([], this)));
        }

        unobserve() {}

        disconnect() {}
      },
    );

    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const measuring = this.closest("[inert]");

        if (measuring === null) {
          return this.parentElement?.hasAttribute("data-model-favorites-bar")
            ? new DOMRect(0, 0, available, 32)
            : new DOMRect();
        }

        const groups = [
          ...measuring.querySelectorAll<HTMLElement>("[data-favorite-group]"),
        ];

        const width = (group: HTMLElement) =>
          groupWidths[group.dataset.favoriteGroup ?? ""] ?? 0;

        const index = groups.indexOf(this as HTMLElement);

        const left = (count: number) =>
          2 +
          groups.slice(0, count).reduce((sum, group) => sum + width(group), 0);

        if (index >= 0) {
          return new DOMRect(left(index), 0, width(groups[index]), 28);
        }

        if (this.hasAttribute("data-favorite-track-end")) {
          return new DOMRect(left(groups.length), 0, 30, 28);
        }

        return this === measuring.querySelector('[role="group"]')
          ? new DOMRect(0, 0, left(groups.length) - 2 + fixed, 32)
          : new DOMRect();
      },
    );
  }

  it("shows favorites as one track and applies an effort without opening the picker", async () => {
    const { onSelectionChange } = renderPicker({
      favorites: [current, gptHigh, opus],
      showFavoriteChips: true,
    });

    const track = await screen.findByRole("group", {
      name: "Model and effort",
    });

    expect(
      within(track).queryByRole("group", { name: "Claude Opus 4.7" }),
    ).toBeNull();

    const gpt = within(track).getByRole("group", { name: "GPT-5.5" });

    expect(segments(gpt)).toEqual([
      "Change model (GPT-5.5)",
      "Medium*",
      "High",
    ]);
    expect(segments(track).at(-1)).toBe("All models");
    expect(
      screen.queryByRole("button", { name: "Provider, model and reasoning" }),
    ).toBeNull();
    expect(track.closest("[aria-live]")?.getAttribute("aria-live")).toBe("off");

    const high = within(gpt).getByRole("button", { name: "High" });
    expect(fireEvent.mouseDown(high)).toBe(false);
    fireEvent.click(high);
    expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith(gptHigh);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps every segment in place when the pick moves", async () => {
    const trackAt = async (reasoningValue: ReasoningLevel) => {
      renderPicker({
        favorites: [gptHigh, current, opus],
        showFavoriteChips: true,
        reasoningValue,
      });
      await screen.findByRole("group", { name: "GPT-5.5" });

      const shown = segments(switcher() ?? document.body);
      cleanup();

      return shown;
    };

    expect(await trackAt("medium")).toEqual([
      "Change model (GPT-5.5)",
      "Medium*",
      "High",
      "Switch to Claude Opus 4.7, Medium",
      "All models",
    ]);
    expect(await trackAt("high")).toEqual([
      "Change model (GPT-5.5)",
      "Medium",
      "High*",
      "Switch to Claude Opus 4.7, Medium",
      "All models",
    ]);
  });

  it("presses an unpinned current pick with a dashed ring and pins it with the star", async () => {
    const { store } = renderPicker({
      favorites: [opus],
      showFavoriteChips: true,
    });

    const gpt = await screen.findByRole("group", { name: "GPT-5.5" });
    const pick = within(gpt).getByRole("button", { name: "Medium" });

    expect(segments(gpt)).toEqual([
      "Change model (GPT-5.5)",
      "Medium*",
      "Add to favorites",
    ]);
    expect(pick.className).toContain("outline-dashed");

    fireEvent.click(
      within(gpt).getByRole("button", { name: "Add to favorites" }),
    );

    expect(store.get(modelPickerFavoritesAtom)).toEqual([opus, current]);

    const pinned = screen.getByRole("group", { name: "GPT-5.5" });

    expect(segments(pinned)).toEqual(["Change model (GPT-5.5)", "Medium*"]);
    expect(
      within(pinned).getByRole("button", { name: "Medium" }).className,
    ).not.toContain("outline-dashed");
  });

  it("returns keyboard focus to the composer when a focused star pins the pick", async () => {
    renderPicker({ favorites: [opus], showFavoriteChips: true });

    const star = await screen.findByRole("button", {
      name: "Add to favorites",
    });

    act(() => star.focus());
    fireEvent.click(star);

    expect(dispatchCommand).toHaveBeenCalledExactlyOnceWith(
      "composer.focus",
      screen.getByRole("button", { name: "All models" }),
    );
  });

  it("switches to another favorite model from its chip at the effort nearest the current one", async () => {
    const sonnetMedium = { ...sonnetHigh, reasoningLevel: "medium" };

    const switchToSonnet = async (reasoningValue: ReasoningLevel) => {
      const onSelectionChange = vi.fn((_: ModelPickerSelection) => true);

      renderPicker({
        favorites: [current, sonnetHigh, sonnetMedium],
        alternateProviderModels: claudeModels,
        showFavoriteChips: true,
        reasoningValue,
        onSelectionChange,
      });

      const track = await screen.findByRole("group", {
        name: "Model and effort",
      });

      const chip = within(track).getByRole("button", {
        name: /^Switch to Claude Sonnet 4\.6/,
      });

      const name = chip.getAttribute("aria-label");
      fireEvent.click(chip);

      const applied = onSelectionChange.mock.calls.at(-1)?.[0];
      cleanup();

      return { name, applied };
    };

    expect(await switchToSonnet("medium")).toEqual({
      name: "Switch to Claude Sonnet 4.6, Medium",
      applied: sonnetMedium,
    });
    expect(await switchToSonnet("high")).toEqual({
      name: "Switch to Claude Sonnet 4.6, High",
      applied: sonnetHigh,
    });
    expect(await switchToSonnet("low")).toEqual({
      name: "Switch to Claude Sonnet 4.6, Medium",
      applied: sonnetMedium,
    });
  });

  it("offers favorites that start a new chat as chips after the in-place groups and as favorites rows", async () => {
    const gpt52High: ModelPickerFavorite = {
      providerId: "codex",
      model: "gpt-5.2",
      reasoningLevel: "high",
      serviceTier: "default",
    };

    const { onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      favorites: [opus, gpt52High],
      showFavoriteChips: true,
      handoff: existingChat,
    });

    const track = await screen.findByRole("group", {
      name: "Model and effort",
    });

    expect(segments(track)).toEqual([
      "Switch to GPT-5.2, High",
      "Change model (GPT-5.5)",
      "Medium*",
      "Add to favorites",
      "New chat with Claude Opus 4.7, Medium",
      "All models",
    ]);

    fireEvent.click(
      within(track).getByRole("button", {
        name: "New chat with Claude Opus 4.7, Medium",
      }),
    );

    expect(onSelectionChange).toHaveBeenLastCalledWith(opus);

    fireEvent.click(screen.getByRole("button", { name: "All models" }));

    const favorites = await screen.findByRole("rowgroup", {
      name: "Favorites",
    });

    expect(
      within(favorites)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Switch to GPT-5.2, High",
      "Switch to GPT-5.5, Medium",
      "Add to favorites",
      "New chat with Claude Opus 4.7, Medium",
    ]);

    fireEvent.click(
      within(favorites).getByRole("button", {
        name: "Switch to GPT-5.2, High",
      }),
    );

    expect(onSelectionChange).toHaveBeenLastCalledWith(gpt52High);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("fits whole groups with the current one expanded, counts the rest on All models and lists them in the popover", async () => {
    mockTrackLayout(320, {
      "codex\0gpt-5.5": 150,
      "claude-code\0claude-opus-4-7": 120,
      "claude-code\0claude-sonnet-4-6": 120,
    });

    renderPicker({
      favorites: [gptHigh, opus, sonnetHigh],
      alternateProviderModels: claudeModels,
      showFavoriteChips: true,
    });

    const track = await screen.findByRole("group", {
      name: "Model and effort",
    });

    await waitFor(() =>
      expect(segments(track)).toEqual([
        "Change model (GPT-5.5)",
        "Medium*",
        "High",
        "Add to favorites",
        "Switch to Claude Opus 4.7, Medium",
        "All models, 1 more favorite",
      ]),
    );

    const allModels = within(track).getByRole("button", {
      name: "All models, 1 more favorite",
    });

    expect(allModels.textContent).toBe("+1");

    fireEvent.click(allModels);

    expect(
      within(
        await screen.findByRole("rowgroup", { name: "Favorites" }),
      ).getByRole("button", { name: "Switch to Claude Sonnet 4.6, High" }),
    ).not.toBeNull();
  });

  it("falls back to the model button when even the current group cannot fit", async () => {
    mockTrackLayout(100, { "codex\0gpt-5.5": 150 });

    renderPicker({ favorites: [gptHigh], showFavoriteChips: true });

    expect(
      await screen.findByRole("button", {
        name: "Provider, model and reasoning",
      }),
    ).not.toBeNull();
    expect(switcher()).toBeNull();
  });

  it("shows speed once, as the ⚡ toggle before ⌄, and keeps it beside the fallback button", async () => {
    const fast = { id: "fast", label: "Fast" };

    const tiers = {
      alternateProvider: makeProviderInfo({
        id: "codex",
        displayName: "Codex",
        capabilities: { supportsServiceTier: true },
      }),
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: [fast] }),
      ],
      serviceTierOptions: [fast],
      serviceTierValue: "fast",
      showFavoriteChips: true,
    };

    const { onServiceTierChange } = renderPicker(tiers);

    const track = await screen.findByRole("group", {
      name: "Model and effort",
    });

    expect(segments(track)).toEqual([
      "Change model (GPT-5.5)",
      "Medium*",
      "High",
      "Add to favorites",
      "Fast mode, faster responses*",
      "All models",
    ]);
    expect(within(track).queryByRole("img", { name: "Fast mode" })).toBeNull();

    fireEvent.click(
      within(track).getByRole("button", {
        name: "Fast mode, faster responses",
      }),
    );
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("default");
    expect(
      screen.queryByRole("button", { name: "Choose chat speed" }),
    ).toBeNull();

    cleanup();
    mockTrackLayout(100, { "codex\0gpt-5.5": 150 });
    renderPicker(tiers);

    const pill = await screen.findByRole("button", {
      name: "Provider, model and reasoning",
    });

    expect(
      pill.parentElement?.contains(
        screen.getByRole("button", { name: "Fast mode, faster responses" }),
      ),
    ).toBe(true);
  });

  it.each([
    {
      reason: "the composer does not ask for favorites",
      options: { showFavoriteChips: false },
    },
    {
      reason: "the viewport is compact",
      options: { showFavoriteChips: true, compact: true },
    },
    {
      reason: "the picker is disabled",
      options: { showFavoriteChips: true, disabled: true },
    },
    {
      reason: "favorites are turned off in the composer",
      options: { showFavoriteChips: true, footerFavorites: false },
    },
    {
      reason: "preferences are still loading",
      options: { showFavoriteChips: true, preferencesReady: false },
    },
  ])("keeps the single model button when $reason", async ({ options }) => {
    renderPicker({ favorites: [opus], ...options });

    await act(async () => {});

    expect(getTrigger()).not.toBeNull();
    expect(switcher()).toBeNull();
  });

  it("judges same-provider favorites from the composer's catalog without its own request", async () => {
    renderPicker({
      providerRouting: { environmentId: "env_existing" },
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      favorites: [
        {
          providerId: "codex",
          model: "gpt-5.2",
          reasoningLevel: "high",
          serviceTier: "default",
        },
      ],
      showFavoriteChips: true,
    });

    const chip = within(
      screen.getByRole("group", { name: "Model and effort" }),
    ).getByRole("button", { name: "Switch to GPT-5.2, High" });

    expect(chip.getAttribute("aria-disabled")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All models" }));

    const gpt52 = within(
      await screen.findByRole("rowgroup", { name: "Favorites" }),
    ).getByRole("button", { name: "Switch to GPT-5.2, High" });

    expect(gpt52.getAttribute("aria-disabled")).toBeNull();
    expect(
      vi
        .mocked(sdk.system.executionOptions)
        .mock.calls.map(([args]) => args?.providerId),
    ).not.toContain("codex");
  });

  it("refuses the star with a reason once favorites are full", async () => {
    const full = Array.from(
      { length: MODEL_PICKER_FAVORITES_MAX },
      (_, index): ModelPickerFavorite => ({
        providerId: "claude-code",
        model: `claude-extra-${index}`,
        reasoningLevel: "medium",
        serviceTier: "default",
      }),
    );

    const { store } = renderPicker({
      favorites: full,
      showFavoriteChips: true,
    });

    const star = await screen.findByRole("button", {
      name: "Add to favorites",
    });

    fireEvent.click(star);

    expect(star.getAttribute("aria-disabled")).toBe("true");
    expect(
      document.getElementById(star.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Favorites are full");
    expect(store.get(modelPickerFavoritesAtom)).toEqual(full);
  });

  it("reports a failed favorites load beside the model button", async () => {
    vi.mocked(sdk.system.uiPreferences.list).mockRejectedValueOnce(
      new Error("offline"),
    );
    renderPicker({
      favorites: [opus],
      preferencesReady: false,
      showFavoriteChips: true,
      presentation: "bar",
    });

    expect(await screen.findByText("Couldn't load favorites")).not.toBeNull();
    expect(getTrigger()).not.toBeNull();
    expect(switcher()).toBeNull();
    expect(screen.queryByText(/No favorites yet/)).toBeNull();
  });

  it("offers every effort of the current model with the pinning hint in the dock until there are favorites", async () => {
    renderPicker({ showFavoriteChips: true, presentation: "bar" });

    expect(
      segments(await screen.findByRole("group", { name: "GPT-5.5" })),
    ).toEqual(["GPT-5.5, Medium*", "GPT-5.5, High", "Add to favorites"]);
    expect(screen.getByText(/No favorites yet/)).not.toBeNull();
  });

  it("leaves the hint out of a composer footer", async () => {
    renderPicker({ showFavoriteChips: true });

    expect(
      await screen.findByRole("group", { name: "GPT-5.5" }),
    ).not.toBeNull();
    expect(screen.queryByText(/No favorites yet/)).toBeNull();
  });

  describe("model-only toggle", () => {
    function modelToggle(): Promise<HTMLElement> {
      return screen.findByRole("group", { name: "Model" });
    }

    it.each([
      { presentation: "bar" as const, compact: false },
      { presentation: "footer" as const, compact: true },
    ])(
      "offers one button per favorite model and no efforts ($presentation, compact: $compact)",
      async ({ presentation, compact }) => {
        renderPicker({
          favorites: [current, gptHigh, opus],
          showFavoriteChips: true,
          presentation,
          compact,
          selects: "model",
        });

        const toggle = await modelToggle();

        await waitFor(() =>
          expect(segments(toggle)).toEqual([
            "GPT-5.5*",
            "Claude Opus 4.7",
            expect.stringMatching(/^All models/),
          ]),
        );
        expect(switcher()).toBeNull();
        expect(within(toggle).queryByText("Medium")).toBeNull();
        expect(within(toggle).queryByText("High")).toBeNull();
      },
    );

    it.each([
      {
        name: "keeps an effort the other model offers",
        label: "Claude Sonnet 4.6",
        model: "claude-sonnet-4-6",
        reasoningLevel: "high",
      },
      {
        name: "lands on the closest effort when the other model lacks it",
        label: "Claude Opus 4.7",
        model: "claude-opus-4-7",
        reasoningLevel: "medium",
      },
    ])("switches model and $name", async ({ label, model, reasoningLevel }) => {
      const { onSelectionChange } = renderPicker({
        favorites: [current, opus, sonnetHigh],
        showFavoriteChips: true,
        presentation: "bar",
        reasoningValue: "high",
        alternateProviderModels: claudeModels,
        selects: "model",
      });

      const toggle = await modelToggle();

      fireEvent.click(within(toggle).getByRole("button", { name: "GPT-5.5" }));
      expect(onSelectionChange).not.toHaveBeenCalled();

      const target = await within(toggle).findByRole("button", { name: label });

      await waitFor(() =>
        expect(target.getAttribute("aria-disabled")).toBeNull(),
      );
      fireEvent.click(target);
      expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({
        providerId: "claude-code",
        model,
        reasoningLevel,
      });
    });

    it("shows the hidden effort when hovering the selected model", async () => {
      renderPicker({
        favorites: [current],
        showFavoriteChips: true,
        presentation: "bar",
        selects: "model",
      });

      const toggle = await modelToggle();

      expect(within(toggle).getByTitle("GPT-5.5 · Medium")).not.toBeNull();
    });

    it("pins a current model without favorites at its current effort", async () => {
      const { store } = renderPicker({
        favorites: [opus],
        showFavoriteChips: true,
        presentation: "bar",
        selects: "model",
      });

      const toggle = await modelToggle();

      fireEvent.click(
        within(toggle).getByRole("button", { name: "Add to favorites" }),
      );

      await waitFor(() =>
        expect(store.get(modelPickerFavoritesAtom)).toEqual([opus, current]),
      );
    });

    it("hints at pinning models in the dock until there are favorites", async () => {
      renderPicker({
        showFavoriteChips: true,
        presentation: "bar",
        selects: "model",
      });

      expect(segments(await modelToggle())).toEqual([
        "GPT-5.5*",
        "Add to favorites",
        expect.stringMatching(/^All models/),
      ]);
      expect(screen.getByText(/Star models in ⌄/)).not.toBeNull();
    });

    it("leaves efforts off the fallback model button and keeps arrow keys from changing them", async () => {
      const { onReasoningChange } = renderPicker({
        favorites: [current, opus],
        footerFavorites: false,
        showFavoriteChips: true,
        presentation: "bar",
        selects: "model",
      });

      const trigger = getTrigger();

      expect(trigger.textContent).toContain("5.5");
      expect(trigger.textContent).not.toContain("Medium");
      expect(trigger.getAttribute("aria-label") ?? "").not.toContain("Medium");

      fireEvent.keyDown(trigger, { key: "ArrowRight" });
      expect(onReasoningChange).not.toHaveBeenCalled();
    });

    it("still steps efforts with arrow keys on the model and effort button", () => {
      const { onReasoningChange } = renderPicker({ footerFavorites: false });

      fireEvent.keyDown(getTrigger(), { key: "ArrowRight" });
      expect(onReasoningChange).toHaveBeenCalledExactlyOnceWith("high");
    });
  });

  it("opens only model names from the model button and keeps the traditional picker on the chevron", async () => {
    const { onSelectionChange, onReasoningChange } = renderPicker({
      favorites: [current, gptHigh, opus],
      showFavoriteChips: true,
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2"),
      ],
      moreModelOptions: [modelRow("gpt-4.1", "GPT-4.1")],
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Change model (GPT-5.5)" }),
    );
    const models = await screen.findByRole("grid", { name: "Models" });
    expect(models.querySelector("[data-model-matrix-cell]")).toBeNull();
    expect(within(models).getByRole("button", { name: "4.1" })).not.toBeNull();
    expect(within(models).queryByRole("button", { name: "1 more" })).toBeNull();
    fireEvent.keyDown(models, { key: "ArrowRight" });
    fireEvent.keyDown(models, { key: "ArrowLeft" });
    expect(onReasoningChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("rowgroup", { name: "Favorites" })).toBeNull();
    fireEvent.click(within(models).getByRole("button", { name: "5.2" }));
    expect(onSelectionChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.2" }),
    );
    act(() => {
      expect(
        commandHandlers.get("modelPicker.toggle")?.({
          target: screen.getByRole("button", { name: "All models" }),
        }),
      ).toBe(true);
    });
    expect(
      await screen.findByRole("rowgroup", { name: "Favorites" }),
    ).not.toBeNull();
    showAllModels();
    const traditional = await screen.findByRole("grid", { name: "Models" });
    expect(
      within(traditional).getByRole("button", { name: "1 more" }),
    ).not.toBeNull();
    expect(
      traditional.querySelector("[data-model-matrix-cell]"),
    ).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "All models" }));
    fireEvent.click(screen.getByRole("button", { name: "All models" }));
    expect(
      await screen.findByRole("rowgroup", { name: "Favorites" }),
    ).not.toBeNull();
  });

  it("opens the full picker from the All models segment", async () => {
    renderPicker({ favorites: [opus], showFavoriteChips: true });

    fireEvent.click(screen.getByRole("button", { name: "All models" }));

    expect(await screen.findByRole("grid")).not.toBeNull();
  });

  it("unstars favorites from their All models cells in edit mode without committing", () => {
    const { store, onSelectionChange } = renderPicker({
      favorites: [opus, gptHigh],
      handoff: existingChat,
    });

    openPicker();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const toggle = (name: string) => screen.getByRole("button", { name });

    expect(
      ["Favorite 5.5 at High", "Favorite Opus 4.7 at Medium"].map((name) =>
        toggle(name).getAttribute("aria-pressed"),
      ),
    ).toEqual(["true", "true"]);

    fireEvent.click(toggle("Favorite Opus 4.7 at Medium"));
    expect(store.get(modelPickerFavoritesAtom)).toEqual([gptHigh]);

    fireEvent.click(toggle("Favorite 5.5 at High"));
    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);
    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("names favorite cells without extra marks and keeps the selected cell's emphasis", () => {
    renderPicker({ favorites: [current, gptHigh] });

    openPicker();

    const selected = screen.getByRole("button", {
      name: "5.5, Medium reasoning, favorite",
    });

    const high = screen.getByRole("button", {
      name: "5.5, High reasoning, favorite",
    });

    expect(selected.getAttribute("aria-pressed")).toBe("true");
    expect(selected.className).toContain("bg-state-active");
    expect(selected.textContent).toBe("Medium");
    expect(high.textContent).toBe("High");
  });
});

describe("ModelReasoningPicker service tiers and options", () => {
  beforeAll(() => ModelReasoningMenu.preload());

  const fast = { id: "fast", label: "Fast", description: "1.5x speed" };
  const ultrafast = { id: "ultrafast", label: "Ultrafast" };

  it.each([
    ["default", "Fast mode, faster responses", "fast"],
    ["fast", "Fast mode, faster responses", "ultrafast"],
    ["ultrafast", "Ultrafast mode, faster responses", "default"],
  ])("changes handoff speed from %s to %s", (value, label, next) => {
    const { onServiceTierChange } = renderPicker({
      handoff: {
        sourceProviderId: "claude-code",
        active: true,
        onStart: vi.fn(),
        onExit: vi.fn(),
      },
      serviceTierOptions: [fast, ultrafast],
      serviceTierValue: value,
    });

    fireEvent.click(screen.getByRole("button", { name: label }));

    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith(next);
  });

  it("toggles a single tier from ⚡ beside the trigger and keeps it out of the picker", () => {
    const { onServiceTierChange } = renderPicker({
      serviceTierOptions: [fast],
      serviceTierValue: "default",
    });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(speed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(speed);
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("fast");

    openPicker();

    const menu = screen.getByRole("dialog");

    expect(within(menu).queryByRole("switch")).toBeNull();
    expect(
      within(menu).queryByRole("radiogroup", { name: "Speed" }),
    ).toBeNull();
    expect(menu.contains(speed)).toBe(false);
  });

  it("turns a single selected tier back to default", () => {
    const { onServiceTierChange } = renderPicker({
      serviceTierOptions: [fast],
      serviceTierValue: "fast",
    });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(speed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(speed);
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("default");
  });

  it("steps from Fast to Ultrafast with the same ⚡ when the model offers both", () => {
    const { onServiceTierChange } = renderPicker({
      serviceTierOptions: [fast, ultrafast],
      serviceTierValue: "fast",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Fast mode, faster responses" }),
    );
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("ultrafast");
  });

  it("treats a tier the model no longer offers as the default tier", () => {
    const { onServiceTierChange } = renderPicker({
      serviceTierOptions: [fast, ultrafast],
      serviceTierValue: "flex",
    });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(speed.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(speed);
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("fast");
  });

  it.each([true, false])(
    "hides the control for unsupported models when faster tiers are allowed: %s",
    (allowFastServiceTier) => {
      renderPicker({
        allowFastServiceTier,
        serviceTierOptions: [],
        serviceTierValue: "fast",
      });
      openPicker();

      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "Speed" })).toBeNull();
      expect(screen.queryByRole("img", { name: /mode$/ })).toBeNull();
    },
  );

  it.each([[[fast]], [[fast, ultrafast]]])(
    "hides ⚡ when the provider's faster tiers are off: %j",
    (tiers) => {
      renderPicker({
        allowFastServiceTier: false,
        modelOptions: [
          modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: tiers }),
        ],
        serviceTierValue: "fast",
      });

      expect(screen.queryByTitle(/\(Fast mode\)$/)).toBeNull();
      expect(screen.queryByRole("button", { name: /mode$/u })).toBeNull();

      openPicker();

      expect(screen.queryByRole("switch")).toBeNull();
      expect(screen.queryByRole("radiogroup", { name: "Speed" })).toBeNull();
    },
  );

  it.each([
    { label: "loading", modelIsLoading: true },
    {
      label: "unverified",
      requireVerifiedCatalog: true,
      modelCatalogIsVerified: false,
    },
  ])("hides disabled tiers while the model is $label", (state) => {
    renderPicker({
      ...state,
      allowFastServiceTier: false,
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: [fast] }),
      ],
      serviceTierValue: "fast",
    });

    openPicker();

    expect(screen.queryByRole("switch", { name: "Fast mode" })).toBeNull();
  });

  it.each([false, true])(
    "does not show an active tier icon when faster tiers are off with favorite chips: %s",
    async (showFavoriteChips) => {
      renderPicker({
        allowFastServiceTier: false,
        alternateProvider: makeProviderInfo({
          id: "codex",
          displayName: "Codex",
          capabilities: { supportsServiceTier: true },
        }),
        modelOptions: [
          modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: [fast] }),
        ],
        serviceTierOptions: [fast],
        serviceTierValue: "fast",
        showFavoriteChips,
      });

      if (showFavoriteChips) {
        await screen.findByRole("group", { name: "Model and effort" });
      }

      expect(screen.queryByTitle(/\(Fast mode\)$/)).toBeNull();
      expect(screen.queryByRole("img", { name: "Fast mode" })).toBeNull();
    },
  );

  it.each([fast, ultrafast])(
    "names the $label tier on the trigger and lights ⚡ beside it",
    (tier) => {
      renderPicker({
        serviceTierOptions: [fast, ultrafast],
        serviceTierValue: tier.id,
      });

      expect(
        screen.getByTitle(new RegExp(`\\(${tier.label} mode\\)$`)),
      ).toBeTruthy();
      expect(
        within(getTrigger()).queryByRole("img", { name: `${tier.label} mode` }),
      ).toBeNull();
      expect(
        screen
          .getByRole("button", { name: `${tier.label} mode, faster responses` })
          .getAttribute("aria-pressed"),
      ).toBe("true");
    },
  );

  it("marks the active tier on a locked trigger that has no ⚡ beside it", () => {
    renderPicker({
      serviceTierOptions: [fast],
      serviceTierValue: "fast",
      disabled: true,
    });

    expect(
      within(getTrigger()).queryByRole("img", { name: "Fast mode" }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Fast mode, faster responses" }),
    ).toBeNull();
  });

  const codexWithTiers = makeProviderInfo({
    id: "codex",
    displayName: "Codex",
    capabilities: { supportsServiceTier: true },
  });

  it("puts the ⚡ toggle beside the model button when there is no switcher", () => {
    const { onServiceTierChange } = renderPicker({
      serviceTierOptions: [fast, ultrafast],
      serviceTierValue: "default",
    });

    const speed = screen.getByRole("button", {
      name: "Fast mode, faster responses",
    });

    expect(speed.getAttribute("aria-pressed")).toBe("false");
    expect(getTrigger().parentElement?.contains(speed)).toBe(true);
    fireEvent.click(speed);
    expect(onServiceTierChange).toHaveBeenCalledExactlyOnceWith("fast");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a default-tier favorite current and starred while Fast is on", () => {
    const solMedium: ModelPickerFavorite = {
      providerId: "codex",
      model: "gpt-5.5",
      reasoningLevel: "medium",
      serviceTier: "default",
    };

    const { store } = renderPicker({
      alternateProvider: codexWithTiers,
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: [fast] }),
      ],
      serviceTierOptions: [fast],
      serviceTierValue: "fast",
      favorites: [solMedium],
    });

    openFavorites();

    expect(
      within(screen.getByRole("rowgroup", { name: "Favorites" }))
        .getByRole("button", { name: "Switch to GPT-5.5, Medium" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.queryByRole("button", { name: "Add to favorites" }),
    ).toBeNull();

    showAllModels();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const star = screen.getByRole("button", { name: "Favorite 5.5 at Medium" });

    expect(star.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(star);
    expect(store.get(modelPickerFavoritesAtom)).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "Favorite 5.5 at Medium" }),
    );
    expect(store.get(modelPickerFavoritesAtom)).toEqual([solMedium]);
  });

  it("keeps the current tier when a cell or a default-tier favorite commits and applies a pinned tier", () => {
    const favoriteOf = (
      model: string,
      reasoningLevel: string,
      serviceTier = "default",
    ): ModelPickerFavorite => ({
      providerId: "codex",
      model,
      reasoningLevel,
      serviceTier,
    });

    const pick = (name: string) => {
      openFavorites();
      fireEvent.click(
        within(screen.getByRole("rowgroup", { name: "Favorites" })).getByRole(
          "button",
          { name },
        ),
      );
    };

    const { onSelectionChange } = renderPicker({
      alternateProvider: codexWithTiers,
      serviceTierOptions: [fast],
      serviceTierValue: "fast",
      favorites: [
        favoriteOf("gpt-5.2", "high"),
        favoriteOf("gpt-4.1", "medium"),
        favoriteOf("gpt-5.2", "max", "fast"),
      ],
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5", { serviceTierOptions: [fast] }),
        modelRow("gpt-5.2", "GPT-5.2", {
          serviceTierOptions: [fast],
          reasoningOptions: [
            ...reasoningOptions,
            { value: "max", label: "Max" },
          ],
        }),
        modelRow("gpt-4.1", "GPT-4.1"),
      ],
    });

    openPicker();
    fireEvent.click(
      screen.getByRole("button", { name: "5.2, Medium reasoning" }),
    );

    expect(onSelectionChange).toHaveBeenLastCalledWith({
      providerId: "codex",
      model: "gpt-5.2",
      reasoningLevel: "medium",
    });

    pick("Switch to GPT-5.2, High");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      favoriteOf("gpt-5.2", "high", "fast"),
    );

    pick("Switch to GPT-4.1, Medium");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      favoriteOf("gpt-4.1", "medium"),
    );

    pick("Switch to GPT-5.2, Max, Fast");
    expect(onSelectionChange).toHaveBeenLastCalledWith(
      favoriteOf("gpt-5.2", "max", "fast"),
    );
  });

  it("lists agent options below the models and reports each change", () => {
    const { onAgentOptionChange } = renderPicker({
      agentSections: buildSessionOptionMenuSections(
        [
          {
            type: "boolean",
            id: "daybreak",
            label: "Daybreak",
            description: null,
            category: null,
            value: false,
            pendingValue: null,
          },
          {
            type: "select",
            id: "depth",
            label: "Search depth",
            description: null,
            category: null,
            value: "shallow",
            pendingValue: "deep",
            values: [
              {
                id: "shallow",
                label: "Shallow",
                description: null,
                group: null,
              },
              { id: "deep", label: "Deep", description: null, group: null },
            ],
          },
        ],
        {},
      ),
    });

    openPicker();

    const toggle = screen.getByRole("switch", { name: "Daybreak" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(onAgentOptionChange).toHaveBeenLastCalledWith("daybreak", true);

    const depth = screen.getByRole("radiogroup", { name: "Search depth" });
    expect(depth.parentElement?.textContent).toContain("from the next turn");
    expect(
      screen.getByRole("radio", { name: "Deep" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Shallow" }));
    expect(onAgentOptionChange).toHaveBeenLastCalledWith("depth", "shallow");
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("shows no agent options when the provider reports none", () => {
    renderPicker();
    openPicker();

    expect(screen.queryByRole("switch")).toBeNull();
  });

  it("greys out a model the chosen options rule out and never selects it", () => {
    const { onModelChange, onSelectionChange } = renderPicker({
      modelOptions: [
        modelRow("gpt-5.5", "GPT-5.5"),
        modelRow("gpt-5.2", "GPT-5.2", {
          disabled: true,
          disabledReason: "Turn off Daybreak to use this model",
        }),
        modelRow("o3", "o3"),
      ],
    });

    commandHandlers.get("modelPicker.cycleModel")?.({ target: getTrigger() });
    expect(onModelChange).toHaveBeenLastCalledWith("o3");

    openPicker();

    const blocked = screen
      .getByTitle("Turn off Daybreak to use this model")
      .closest("button");

    expect(blocked?.disabled).toBe(true);
    expect(
      screen.getByRole("button", { name: "5.2, Medium reasoning" }),
    ).toHaveProperty("disabled", true);

    if (blocked) fireEvent.click(blocked);
    expect(onModelChange).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });
});

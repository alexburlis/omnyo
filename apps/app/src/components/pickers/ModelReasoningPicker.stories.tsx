import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider as JotaiProvider } from "jotai";
import {
  defaultAppSettings,
  defaultUiPreferences,
  resolveServiceTierOptions,
  UI_PREFERENCE_KEYS,
  type AvailableModel,
  type ModelPickerFavorite,
  type ProviderInfo,
  type ReasoningLevel,
  type ServiceTier,
} from "@omnyo/domain";
import { makeProviderInfo } from "@omnyo/test-helpers/domain-fixtures";
import type {
  SystemExecutionOptionsModelNotice,
  SystemExecutionOptionsResponse,
} from "@omnyo/server-contract";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  hostsQueryKey,
  systemConfigQueryKey,
  systemExecutionOptionsQueryKey,
  systemProviderCatalogQueryKey,
  uiPreferencesQueryKey,
} from "@/hooks/queries/query-keys";
import { resolveModelCatalogSelection } from "@/hooks/thread-creation-options/model-catalog-selection";
import { formatModelLabel } from "@/hooks/thread-creation-options/selection-state";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import codexLogoUrl from "../../../../../plugins/provider-codex/icons/codex.svg";
import claudeCodeLogoUrl from "../../../../../plugins/provider-claude-code/icons/claude-code.svg";
import type {
  ModelPickerPresentation,
  ModelPickerSelects,
} from "./ModelFavoritesBar";
import {
  ModelReasoningPicker,
  type ModelReasoningPickerHandoff,
} from "./ModelReasoningPicker";
import type { ProviderPickerOption } from "./model-brand-prefix";
import type { ModelPickerSelection } from "./model-picker-selection";
import {
  modelPickerFavoritesAtom,
  modelPickerFooterFavoritesAtom,
  modelPickerHiddenModelsAtom,
  useModelPickerHiddenModelIds,
} from "./modelPickerPreferences";

export default {
  title: "pickers/Model Reasoning Picker",
};

const CODEX_EFFORTS: readonly ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
];

const CLAUDE_EFFORTS: readonly ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
];

const WIDE_CODEX_EFFORTS: readonly ReasoningLevel[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

function storyModel(
  model: string,
  displayName: string,
  efforts: readonly ReasoningLevel[],
  extra: Partial<AvailableModel> = {},
): AvailableModel {
  return {
    id: model,
    model,
    displayName,
    description: "",
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: reasoningEffort,
    })),
    defaultReasoningEffort: "medium",
    isDefault: false,
    ...extra,
  };
}

function storyStrings(installUrl: string, brandPrefix: string) {
  return {
    signInHint: "Sign in from Settings, then try again.",
    expiredHint: "Sign in again from Settings.",
    installUrl,
    brandPrefix,
  };
}

const CODEX_PROVIDER: ProviderInfo = makeProviderInfo({
  id: "codex",
  displayName: "Codex",
  logoUrl: codexLogoUrl,
  capabilities: { supportsServiceTier: true },
  strings: storyStrings("https://developers.openai.com/codex/cli", "GPT-"),
});

const CLAUDE_PROVIDER: ProviderInfo = makeProviderInfo({
  id: "claude-code",
  displayName: "Claude Code",
  logoUrl: claudeCodeLogoUrl,
  strings: storyStrings("https://claude.com/claude-code", "Claude "),
});

const FAST_ONLY = [{ id: "fast" }];

interface StoryCatalog {
  provider: ProviderInfo;
  models: AvailableModel[];
  selectedOnlyModels: AvailableModel[];
}

type StoryCatalogs = Readonly<Record<string, StoryCatalog>>;

function codexCatalog(efforts: readonly ReasoningLevel[]): StoryCatalog {
  return {
    provider: CODEX_PROVIDER,
    models: [
      storyModel("gpt-6.1-sol", "GPT-6.1-Sol", efforts, {
        isDefault: true,
        supportedServiceTiers: FAST_ONLY,
      }),
      storyModel("gpt-6-astra", "GPT-6-Astra", efforts, {
        supportedServiceTiers: FAST_ONLY,
      }),
      storyModel("gpt-6-sol", "GPT-6-Sol", efforts, {
        supportedServiceTiers: FAST_ONLY,
      }),
      storyModel("gpt-6-luna", "GPT-6-Luna", efforts),
      storyModel("gpt-5.6-sol", "GPT-5.6-Sol", efforts),
      storyModel("gpt-5.6-luna", "GPT-5.6-Luna", efforts),
    ],
    selectedOnlyModels: [],
  };
}

const CLAUDE_CATALOG: StoryCatalog = {
  provider: CLAUDE_PROVIDER,
  models: [
    storyModel("claude-opus-5-5", "Claude Opus 5.5", CLAUDE_EFFORTS, {
      isDefault: true,
    }),
    storyModel("claude-fable-5-1", "Claude Fable 5.1", CLAUDE_EFFORTS),
    storyModel("claude-sonnet-5-5", "Claude Sonnet 5.5", CLAUDE_EFFORTS),
    storyModel("claude-haiku-5-5", "Claude Haiku 5.5", [
      "low",
      "medium",
      "high",
    ]),
    storyModel("claude-opus-4-8", "Claude Opus 4.8", CLAUDE_EFFORTS),
    storyModel("claude-sonnet-4-6", "Claude Sonnet 4.6", [
      "low",
      "medium",
      "high",
    ]),
  ],
  selectedOnlyModels: [
    storyModel("claude-opus-4-7", "Claude Opus 4.7", CLAUDE_EFFORTS),
  ],
};

const CATALOGS: StoryCatalogs = {
  codex: codexCatalog(CODEX_EFFORTS),
  "claude-code": CLAUDE_CATALOG,
};

function withUltrafast(catalogs: StoryCatalogs): StoryCatalogs {
  return {
    ...catalogs,
    codex: {
      ...catalogs.codex,
      provider: {
        ...CODEX_PROVIDER,
        serviceTiers: [
          ...(CODEX_PROVIDER.serviceTiers ?? []),
          { id: "ultrafast", label: "Ultrafast" },
        ],
      },
      models: catalogs.codex.models.map((model) =>
        model.supportedServiceTiers === undefined
          ? model
          : {
              ...model,
              supportedServiceTiers: [
                ...model.supportedServiceTiers,
                { id: "ultrafast" },
              ],
            },
      ),
    },
  };
}

const CODEX_SPEED_CATALOGS: StoryCatalogs = withUltrafast(CATALOGS);

const WIDE_CATALOGS: StoryCatalogs = {
  codex: codexCatalog(WIDE_CODEX_EFFORTS),
  "claude-code": CLAUDE_CATALOG,
};

const PROVIDERS: ProviderInfo[] = [CODEX_PROVIDER, CLAUDE_PROVIDER];

const PROVIDER_OPTIONS: readonly ProviderPickerOption[] = PROVIDERS.map(
  (provider) => ({
    value: provider.id,
    label: provider.displayName,
    icon: getProviderIconInfo("agent", provider.id, provider).icon,
    ...(provider.strings?.brandPrefix === undefined
      ? {}
      : { brandPrefix: provider.strings.brandPrefix }),
    ...(provider.strings?.installUrl === undefined
      ? {}
      : { installUrl: provider.strings.installUrl }),
  }),
);

const FAVORITES: ModelPickerFavorite[] = [
  {
    providerId: "claude-code",
    model: "claude-opus-5-5",
    reasoningLevel: "ultracode",
    serviceTier: "default",
  },
  {
    providerId: "codex",
    model: "gpt-6.1-sol",
    reasoningLevel: "xhigh",
    serviceTier: "fast",
  },
  {
    providerId: "claude-code",
    model: "claude-sonnet-5-5",
    reasoningLevel: "high",
    serviceTier: "default",
  },
  {
    providerId: "codex",
    model: "gpt-6-astra",
    reasoningLevel: "medium",
    serviceTier: "default",
  },
  {
    providerId: "codex",
    model: "gpt-6-pro",
    reasoningLevel: "high",
    serviceTier: "default",
  },
];

const DAILY_CODEX_EFFORTS: readonly ReasoningLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const DAILY_CATALOGS: StoryCatalogs = withUltrafast({
  codex: codexCatalog(DAILY_CODEX_EFFORTS),
  "claude-code": CLAUDE_CATALOG,
});

function dailyFavorites(
  providerId: string,
  model: string,
  levels: readonly ReasoningLevel[],
): ModelPickerFavorite[] {
  return levels.map((reasoningLevel) => ({
    providerId,
    model,
    reasoningLevel,
    serviceTier: "default",
  }));
}

const DAILY_FAVORITES: ModelPickerFavorite[] = [
  ...dailyFavorites("codex", "gpt-6.1-sol", ["medium", "high", "max", "ultra"]),
  ...dailyFavorites("codex", "gpt-6-astra", ["max"]),
  ...dailyFavorites("claude-code", "claude-opus-5-5", [
    "medium",
    "high",
    "max",
    "ultracode",
  ]),
  ...dailyFavorites("claude-code", "claude-fable-5-1", ["high"]),
];

const HIDDEN_MODELS: Record<string, string[]> = {
  codex: ["gpt-5.6-sol", "gpt-5.6-luna"],
  "claude-code": ["claude-opus-4-8", "claude-sonnet-4-6"],
};

const StoryNoticeContext =
  createContext<SystemExecutionOptionsModelNotice | null>(null);

const OPENAI_USED_UP_NOTICE: SystemExecutionOptionsModelNotice = {
  providerId: "codex",
  message: "OpenAI used up",
  detail: "Showing openai2@",
  until: Date.now() + 3 * 24 * 60 * 60 * 1000,
};

function executionOptions(
  catalog: StoryCatalog,
  modelNotice: SystemExecutionOptionsModelNotice | null,
): SystemExecutionOptionsResponse {
  return {
    providers: PROVIDERS,
    models: catalog.models,
    selectedOnlyModels: catalog.selectedOnlyModels,
    permissionCeiling: "full",
    modelLoadError: null,
    modelNotice,
  };
}

function createPickerQueryClient(
  catalogs: StoryCatalogs,
  allowFastServiceTier: boolean,
  notice: SystemExecutionOptionsModelNotice | null,
): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: false, staleTime: Infinity },
    },
  });

  for (const [providerId, catalog] of Object.entries(catalogs)) {
    queryClient.setQueryData(
      systemExecutionOptionsQueryKey({
        environmentId: null,
        hostId: null,
        providerId,
      }),
      executionOptions(
        catalog,
        notice?.providerId === providerId ? notice : null,
      ),
    );
  }

  queryClient.setQueryData(hostsQueryKey(), []);
  queryClient.setQueryData(
    systemConfigQueryKey(),
    makeSystemConfig({
      generalSettings: { ...defaultAppSettings, allowFastServiceTier },
    }),
  );
  queryClient.setQueryData(systemProviderCatalogQueryKey(), []);
  queryClient.setQueryData(uiPreferencesQueryKey(), {
    preferences: Object.fromEntries(
      UI_PREFERENCE_KEYS.map((key) => [
        key,
        { revision: 0, value: defaultUiPreferences[key] },
      ]),
    ),
  });

  return queryClient;
}

function PickerStoryProviders({
  catalogs = CATALOGS,
  favorites = FAVORITES,
  allowFastServiceTier = true,
  footerFavorites = true,
  notice = null,
  children,
}: {
  catalogs?: StoryCatalogs;
  favorites?: ModelPickerFavorite[];
  allowFastServiceTier?: boolean;
  footerFavorites?: boolean;
  notice?: SystemExecutionOptionsModelNotice | null;
  children: ReactNode;
}) {
  const queryClient = useMemo(
    () => createPickerQueryClient(catalogs, allowFastServiceTier, notice),
    [catalogs, allowFastServiceTier, notice],
  );

  const store = useMemo(() => {
    const pickerStore = createStore();
    pickerStore.set(modelPickerFavoritesAtom, favorites);
    pickerStore.set(modelPickerHiddenModelsAtom, HIDDEN_MODELS);
    pickerStore.set(modelPickerFooterFavoritesAtom, footerFavorites);

    return pickerStore;
  }, [favorites, footerFavorites]);

  return (
    <QueryClientProvider client={queryClient}>
      <JotaiProvider store={store}>
        <StoryNoticeContext.Provider value={notice}>
          {children}
        </StoryNoticeContext.Provider>
      </JotaiProvider>
    </QueryClientProvider>
  );
}

type StorySelection = Required<ModelPickerSelection>;

const INITIAL_SELECTION: StorySelection = {
  providerId: "claude-code",
  model: "claude-opus-5-5",
  reasoningLevel: "ultracode",
  serviceTier: "default",
};

const EXISTING_CHAT_SELECTION: StorySelection = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "xhigh",
  serviceTier: "default",
};

const DAILY_CHAT_SELECTION: StorySelection = {
  providerId: "codex",
  model: "gpt-6.1-sol",
  reasoningLevel: "high",
  serviceTier: "default",
};

const DAILY_CHAT: StoryChat = { kind: "new", initial: DAILY_CHAT_SELECTION };

type StoryChat =
  | { kind: "new"; initial?: StorySelection }
  | { kind: "existing"; source: StorySelection; handoffActive: boolean };

function initialStorySelection(chat: StoryChat): StorySelection {
  if (chat.kind === "new") return chat.initial ?? INITIAL_SELECTION;

  return chat.handoffActive ? INITIAL_SELECTION : chat.source;
}

function StoryPicker({
  catalogs,
  chat,
  presentation,
  selects,
}: {
  catalogs: StoryCatalogs;
  chat: StoryChat;
  presentation?: ModelPickerPresentation;
  selects?: ModelPickerSelects;
}) {
  const [selection, setSelection] = useState<StorySelection>(
    initialStorySelection(chat),
  );

  const [handoffActive, setHandoffActive] = useState(
    chat.kind === "existing" && chat.handoffActive,
  );

  const catalog = catalogs[selection.providerId];
  const hiddenModels = useModelPickerHiddenModelIds(selection.providerId);
  const notice = useContext(StoryNoticeContext);

  const resolved = useMemo(
    () =>
      resolveModelCatalogSelection({
        models: catalog.models,
        selectedOnlyModels: catalog.selectedOnlyModels,
        selectedModel: selection.model,
        preferredReasoningLevel: selection.reasoningLevel,
        hiddenModels,
        provider: catalog.provider,
        catalogIsVerified: true,
        formatModelLabel,
      }),
    [catalog, hiddenModels, selection.model, selection.reasoningLevel],
  );

  const serviceTierOptions = resolveServiceTierOptions({
    provider: catalog.provider,
    model: resolved.activeModel,
  });

  const selectProvider = (providerId: string) => {
    const next = catalogs[providerId];
    const model = next?.models.find((candidate) => candidate.isDefault);

    if (next === undefined || model === undefined) return;
    setSelection((current) => ({
      ...current,
      providerId,
      model: model.model,
    }));
  };

  const applySelection = (next: ModelPickerSelection): boolean => {
    if (
      chat.kind === "existing" &&
      next.providerId !== chat.source.providerId
    ) {
      setHandoffActive(true);
    }

    setSelection((current) => ({
      providerId: next.providerId,
      model: next.model,
      reasoningLevel: next.reasoningLevel,
      serviceTier: next.serviceTier ?? current.serviceTier,
    }));

    return true;
  };

  const handoff: ModelReasoningPickerHandoff | undefined =
    chat.kind === "existing"
      ? {
          sourceProviderId: chat.source.providerId,
          active: handoffActive,
          onStart: () => setHandoffActive(true),
          onExit: () => {
            setHandoffActive(false);
            setSelection(chat.source);
          },
        }
      : undefined;

  return (
    <ModelReasoningPicker
      providers={PROVIDERS}
      providerOptions={PROVIDER_OPTIONS}
      selectedProviderId={selection.providerId}
      onSelectedProviderChange={selectProvider}
      hasMultipleProviders
      modelValue={resolved.selectedModel}
      modelOptions={resolved.modelOptions}
      moreModelOptions={resolved.moreModelOptions}
      catalogModelOptions={resolved.catalogModelOptions}
      modelCatalogIsVerified
      modelNotice={notice?.providerId === selection.providerId ? notice : null}
      onModelChange={(model) =>
        setSelection((current) => ({ ...current, model }))
      }
      reasoningValue={resolved.reasoningLevel}
      reasoningOptions={resolved.reasoningOptions}
      onReasoningChange={(reasoningLevel) =>
        setSelection((current) => ({ ...current, reasoningLevel }))
      }
      onSelectionChange={applySelection}
      serviceTierValue={selection.serviceTier}
      serviceTierOptions={serviceTierOptions}
      onServiceTierChange={(serviceTier: ServiceTier) =>
        setSelection((current) => ({ ...current, serviceTier }))
      }
      muted
      showFavoriteChips
      handoff={handoff}
      presentation={presentation}
      selects={selects}
    />
  );
}

function StoryComposer({
  className,
  containerRef,
  catalogs = CATALOGS,
  chat = { kind: "new" },
  selects,
}: {
  className: string;
  containerRef?: RefObject<HTMLDivElement | null>;
  catalogs?: StoryCatalogs;
  chat?: StoryChat;
  selects?: ModelPickerSelects;
}) {
  return (
    <div
      ref={containerRef}
      data-promptbox=""
      data-app-composer=""
      className={cn("rounded-lg border border-border bg-background", className)}
    >
      <div className="px-3.5 pb-1 pt-3 text-sm text-subtle-foreground">
        {chat.kind === "existing" ? "Ask for a follow-up" : "Ask anything"}
      </div>
      <div className="flex flex-row items-center gap-3 pb-2 pl-3.5 pr-[13px] pt-1.5">
        <div
          aria-live="polite"
          className="flex min-w-9 flex-1 flex-row items-center gap-1"
        >
          <StoryPicker catalogs={catalogs} chat={chat} selects={selects} />
        </div>
        <span
          aria-hidden
          className="size-8 shrink-0 rounded-full bg-foreground"
        />
      </div>
    </div>
  );
}

function clickButton(
  root: ParentNode,
  matches: (button: HTMLButtonElement) => boolean,
) {
  [...root.querySelectorAll<HTMLButtonElement>("button")]
    .find(matches)
    ?.click();
}

function whenMenuRealized(onRealized: () => void): () => void {
  return whenPresent(
    () => document.querySelector("[data-model-matrix-row]") !== null,
    onRealized,
  );
}

function whenPresent(
  realized: () => boolean,
  onRealized: () => void,
): () => void {
  if (realized()) {
    onRealized();

    return () => {};
  }

  const observer = new MutationObserver(() => {
    if (!realized()) return;
    observer.disconnect();
    onRealized();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return () => observer.disconnect();
}

function useOpenPicker(
  containerRef: RefObject<HTMLDivElement | null>,
  { edit }: { edit: boolean },
) {
  useEffect(() => {
    const container = containerRef.current;

    if (container === null) return;
    clickButton(container, (button) => {
      const label = button.getAttribute("aria-label") ?? "";

      return (
        label.startsWith("All models") ||
        label.startsWith("Provider, model and reasoning")
      );
    });

    if (!edit) return;

    const isEdit = (button: HTMLButtonElement) => button.textContent === "Edit";
    let stopEdit = () => {};

    const stopMenu = whenMenuRealized(() => {
      clickButton(
        document,
        (button) =>
          button.closest('[data-model-matrix-row="all-models"]') !== null,
      );
      stopEdit = whenPresent(
        () => [...document.querySelectorAll("button")].some(isEdit),
        () => clickButton(document, isEdit),
      );
    });

    return () => {
      stopMenu();
      stopEdit();
    };
  }, [containerRef, edit]);
}

function OpenComposer({
  edit,
  catalogs,
  chat,
}: {
  edit: boolean;
  catalogs?: StoryCatalogs;
  chat?: StoryChat;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useOpenPicker(containerRef, { edit });

  return (
    <div className="h-[44rem] p-6">
      <StoryComposer
        className="w-[760px] max-w-full"
        containerRef={containerRef}
        catalogs={catalogs}
        chat={chat}
      />
    </div>
  );
}

export function FooterSwitcher() {
  return (
    <PickerStoryProviders>
      <div className="flex flex-col gap-6 p-6">
        <StoryComposer className="w-[760px]" />
        <StoryComposer className="w-[520px]" />
      </div>
    </PickerStoryProviders>
  );
}

export function CompactFooter() {
  return (
    <PickerStoryProviders>
      <CompactViewportOverrideProvider isCompactViewport>
        <div className="p-4">
          <StoryComposer className="w-full max-w-[390px]" />
        </div>
      </CompactViewportOverrideProvider>
    </PickerStoryProviders>
  );
}

export function NewChatModelToggle() {
  return (
    <PickerStoryProviders>
      <div className="flex flex-col items-center gap-6 p-6">
        <StoryPicker
          catalogs={CATALOGS}
          chat={{ kind: "new" }}
          presentation="bar"
          selects="model"
        />
      </div>
    </PickerStoryProviders>
  );
}

export function NewChatModelToggleCompact() {
  return (
    <PickerStoryProviders>
      <CompactViewportOverrideProvider isCompactViewport>
        <div className="p-4">
          <StoryComposer className="w-full max-w-[390px]" selects="model" />
        </div>
      </CompactViewportOverrideProvider>
    </PickerStoryProviders>
  );
}

export function OpenPopover() {
  return (
    <PickerStoryProviders>
      <OpenComposer edit={false} />
    </PickerStoryProviders>
  );
}

export function EditMode() {
  return (
    <PickerStoryProviders>
      <OpenComposer edit />
    </PickerStoryProviders>
  );
}

export function EveryReasoningLevel() {
  return (
    <PickerStoryProviders catalogs={WIDE_CATALOGS}>
      <OpenComposer edit={false} catalogs={WIDE_CATALOGS} />
    </PickerStoryProviders>
  );
}

export function ExistingChat() {
  return (
    <PickerStoryProviders>
      <OpenComposer
        edit={false}
        chat={{
          kind: "existing",
          source: EXISTING_CHAT_SELECTION,
          handoffActive: false,
        }}
      />
    </PickerStoryProviders>
  );
}

export function CodexFastModeDisabled() {
  return (
    <PickerStoryProviders
      catalogs={CODEX_SPEED_CATALOGS}
      allowFastServiceTier={false}
    >
      <OpenComposer
        edit={false}
        catalogs={CODEX_SPEED_CATALOGS}
        chat={{
          kind: "existing",
          source: EXISTING_CHAT_SELECTION,
          handoffActive: false,
        }}
      />
    </PickerStoryProviders>
  );
}

export function DailyFavoritesDock() {
  return (
    <PickerStoryProviders catalogs={DAILY_CATALOGS} favorites={DAILY_FAVORITES}>
      <div className="flex flex-col items-center gap-6 p-6">
        {[620, 460].map((width) => (
          <div
            key={width}
            style={{ width }}
            className="flex justify-center rounded-xl border border-border bg-background px-3.5 pb-2 pt-1.5"
          >
            <StoryPicker
              catalogs={DAILY_CATALOGS}
              chat={DAILY_CHAT}
              presentation="bar"
            />
          </div>
        ))}
      </div>
    </PickerStoryProviders>
  );
}

export function DailyFavoritesPopover() {
  return (
    <PickerStoryProviders catalogs={DAILY_CATALOGS} favorites={DAILY_FAVORITES}>
      <OpenComposer edit={false} catalogs={DAILY_CATALOGS} chat={DAILY_CHAT} />
    </PickerStoryProviders>
  );
}

export function AccountNotice() {
  return (
    <PickerStoryProviders
      catalogs={DAILY_CATALOGS}
      favorites={DAILY_FAVORITES}
      footerFavorites={false}
      notice={OPENAI_USED_UP_NOTICE}
    >
      <OpenComposer edit={false} catalogs={DAILY_CATALOGS} chat={DAILY_CHAT} />
    </PickerStoryProviders>
  );
}

export function PillComposerFavorites() {
  return (
    <PickerStoryProviders
      catalogs={DAILY_CATALOGS}
      favorites={DAILY_FAVORITES}
      footerFavorites={false}
    >
      <OpenComposer edit={false} catalogs={DAILY_CATALOGS} chat={DAILY_CHAT} />
    </PickerStoryProviders>
  );
}

export function PillComposerNonFavoriteLevel() {
  return (
    <PickerStoryProviders
      catalogs={DAILY_CATALOGS}
      favorites={DAILY_FAVORITES}
      footerFavorites={false}
    >
      <OpenComposer
        edit={false}
        catalogs={DAILY_CATALOGS}
        chat={{
          kind: "new",
          initial: { ...DAILY_CHAT_SELECTION, reasoningLevel: "xhigh" },
        }}
      />
    </PickerStoryProviders>
  );
}

export function PillComposerNonFavoriteModel() {
  return (
    <PickerStoryProviders
      catalogs={DAILY_CATALOGS}
      favorites={DAILY_FAVORITES}
      footerFavorites={false}
    >
      <OpenComposer
        edit={false}
        catalogs={DAILY_CATALOGS}
        chat={{
          kind: "new",
          initial: {
            ...DAILY_CHAT_SELECTION,
            model: "gpt-6-sol",
            reasoningLevel: "xhigh",
          },
        }}
      />
    </PickerStoryProviders>
  );
}

export function ExistingChatActiveHandoff() {
  return (
    <PickerStoryProviders>
      <OpenComposer
        edit={false}
        chat={{
          kind: "existing",
          source: EXISTING_CHAT_SELECTION,
          handoffActive: true,
        }}
      />
    </PickerStoryProviders>
  );
}

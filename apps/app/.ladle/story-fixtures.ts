import { useState } from "react";
import { reconcileReasoningLevel } from "@omnyo/domain";
import type {
  Host,
  ProjectSource,
  ProviderInfo,
  ProviderOptionDescriptor,
  ReasoningLevel,
  Thread,
  WorkspaceStatus,
} from "@omnyo/domain";
import type {
  ProviderCliKey,
  ProviderCliStatus,
} from "@omnyo/host-daemon-contract";
import type {
  ProjectResponse,
  SystemEnvironmentProvider,
} from "@omnyo/server-contract";
import { EMPTY_ORDERED_MENTION_SUGGESTIONS } from "@omnyo/client-core";
import {
  makeEnvironment as makeEnvironmentFixture,
  makeHost as makeHostFixture,
  makeProviderInfo,
  makeThread as makeThreadFixture,
  makeThreadListEntry as makeThreadListEntryFixture,
} from "@omnyo/test-helpers/domain-fixtures";
import { makeProjectResponse } from "../src/test/fixtures/projects";
import { getProviderIconInfo } from "../src/lib/provider-icon";
import codexLogoUrl from "../../../plugins/provider-codex/icons/codex.svg";
import claudeCodeLogoUrl from "../../../plugins/provider-claude-code/icons/claude-code.svg";
import piLogoUrl from "../../../plugins/provider-pi/icons/pi.svg";
import type { PickerOption } from "../src/components/pickers/OptionPicker";
import type { ModelPickerOption } from "../src/components/pickers/model-picker-option";
import type { ProjectSelectorOption } from "../src/components/pickers/ProjectSelector";
import type { ReuseThreadOption } from "../src/components/pickers/ReuseEnvironmentPicker";
import type { ExecutionControlsProps } from "../src/components/promptbox/ExecutionControls";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  type AttachmentsConfig,
  type TypeaheadCommandConfig,
  type TypeaheadConfig,
  type TypeaheadMentionConfig,
} from "../src/components/promptbox/PromptBoxInternal";

const noop = () => {};

export const HOST_IDS = {
  local: "host_local",
  remote: "host_remote",
} as const;

export const HOST_NAMES = {
  local: "Michael's MacBook Pro",
  remote: "michael-build-box",
} as const;

export const PROJECT_IDS = {
  omnyo: "proj_omnyo",
  pierre: "proj_pierre",
  ingest: "proj_ingest_pipeline",
} as const;

export const PROJECT_NAMES = {
  omnyo: "omnyo",
  pierre: "pierre",
  ingest: "ingest-pipeline",
} as const;

export const BRANCH_NAMES = {
  default: "main",
  feature: "feat/sidebar-rail",
} as const;

export function makeTypeaheadConfig(
  mentionOverrides: Partial<TypeaheadMentionConfig> = {},
  commandOverrides: Partial<TypeaheadCommandConfig> = {},
): TypeaheadConfig {
  const mention: TypeaheadMentionConfig = {
    results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
    isLoading: false,
    isRefreshing: false,
    isError: false,
    onQueryChange: noop,
    ...mentionOverrides,
  };

  return {
    mention,
    command: {
      ...INERT_TYPEAHEAD_COMMAND_CONFIG,
      ...commandOverrides,
    },
  };
}

export function makeAttachmentsConfig(
  overrides: Partial<AttachmentsConfig> = {},
): AttachmentsConfig {
  const base: AttachmentsConfig = {
    items: [],
    projectId: PROJECT_IDS.omnyo,
    onAttachFiles: async () => [],
    onUpdate: noop,
    isAttaching: false,
    error: null,
  };

  return { ...base, ...overrides };
}

function storyProviderIcon(providerId: string, logoUrl: string) {
  return getProviderIconInfo("agent", providerId, { logoUrl }).icon;
}

const STORY_PROVIDER_LOGO_URLS: Readonly<Record<string, string>> = {
  codex: codexLogoUrl,
  "claude-code": claudeCodeLogoUrl,
  pi: piLogoUrl,
};

export const STORY_PROVIDER_OPTIONS: readonly PickerOption<string>[] = [
  {
    value: "codex",
    label: "Codex",
    icon: storyProviderIcon("codex", codexLogoUrl),
  },
  {
    value: "claude-code",
    label: "Claude Code",
    icon: storyProviderIcon("claude-code", claudeCodeLogoUrl),
  },
  { value: "pi", label: "Pi", icon: storyProviderIcon("pi", piLogoUrl) },
];

export const STORY_CODEX_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
  { value: "ultra", label: "Ultra" },
];

export const STORY_CLAUDE_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "ultracode", label: "Ultracode" },
  { value: "max", label: "Max" },
];

export const STORY_PI_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  { value: "none", label: "None" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
];

const STORY_PI_OPUS_REASONING: readonly PickerOption<ReasoningLevel>[] = [
  ...STORY_PI_REASONING,
  { value: "max", label: "Max" },
];

export const STORY_FAST_SERVICE_TIERS: readonly ProviderOptionDescriptor[] = [
  { id: "fast", label: "Fast" },
];

export function storyModelOption(
  value: string,
  label: string,
  reasoningOptions: readonly PickerOption<ReasoningLevel>[],
  extra: Partial<ModelPickerOption> = {},
): ModelPickerOption {
  return {
    value,
    label,
    reasoningOptions,
    defaultReasoningLevel:
      reasoningOptions.find((option) => option.value === "medium")?.value ??
      reasoningOptions[0]?.value ??
      "medium",
    serviceTierOptions: [],
    ...extra,
  };
}

function codexModel(value: string, label: string): ModelPickerOption {
  return storyModelOption(value, label, STORY_CODEX_REASONING, {
    serviceTierOptions: STORY_FAST_SERVICE_TIERS,
  });
}

function claudeModel(value: string, label: string): ModelPickerOption {
  return storyModelOption(value, label, STORY_CLAUDE_REASONING);
}

function piModel(
  value: string,
  label: string,
  routeProviderId: string,
  reasoningOptions: readonly PickerOption<ReasoningLevel>[],
): ModelPickerOption {
  return storyModelOption(value, label, reasoningOptions, { routeProviderId });
}

export const STORY_CODEX_MODELS: readonly ModelPickerOption[] = [
  codexModel("gpt-5.5", "GPT-5.5"),
  codexModel("gpt-5.4", "GPT-5.4"),
  codexModel("gpt-5.4-mini", "GPT-5.4 Mini"),
  codexModel("gpt-5.3-codex", "GPT-5.3 Codex"),
  codexModel("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark"),
  codexModel("gpt-5.2", "GPT-5.2"),
];

export const STORY_CLAUDE_CODE_MODELS: readonly ModelPickerOption[] = [
  claudeModel("claude-fable-5", "Claude Fable 5"),
  claudeModel("claude-opus-4-8[1m]", "Claude Opus 4.8 (1M)"),
  claudeModel("claude-sonnet-5", "Claude Sonnet 5"),
];

export const STORY_CLAUDE_CODE_MORE_MODELS: readonly ModelPickerOption[] = [
  claudeModel("claude-sonnet-4-6[1m]", "Claude Sonnet 4.6 (1M)"),
  claudeModel("claude-sonnet-4-6", "Claude Sonnet 4.6"),
  claudeModel("claude-haiku-4-5", "Claude Haiku 4.5"),
];

export const STORY_PI_MODELS: readonly ModelPickerOption[] = [
  piModel(
    "openai-codex/gpt-5.5",
    "GPT-5.5",
    "openai-codex",
    STORY_PI_REASONING,
  ),
  piModel(
    "openai-codex/gpt-5.4",
    "GPT-5.4",
    "openai-codex",
    STORY_PI_REASONING,
  ),
  piModel(
    "openai-codex/gpt-5.4-mini",
    "GPT-5.4 Mini",
    "openai-codex",
    STORY_PI_REASONING,
  ),
  piModel(
    "openai/gpt-5.3-codex",
    "GPT-5.3 Codex",
    "openai",
    STORY_PI_REASONING,
  ),
  piModel(
    "openai/gpt-5.3-codex-spark",
    "GPT-5.3 Codex Spark",
    "openai",
    STORY_PI_REASONING.filter(({ value }) => value !== "none"),
  ),
  piModel(
    "openai-codex/gpt-5.3-codex-spark",
    "GPT-5.3 Codex Spark",
    "openai-codex",
    STORY_PI_REASONING,
  ),
  piModel(
    "anthropic/claude-haiku-4-5",
    "Claude Haiku 4.5",
    "anthropic",
    STORY_PI_REASONING.filter(({ value }) => value !== "xhigh"),
  ),
  piModel(
    "anthropic/claude-opus-4-8",
    "Claude Opus 4.8",
    "anthropic",
    STORY_PI_OPUS_REASONING,
  ),
  piModel(
    "anthropic/claude-opus-4-7",
    "Claude Opus 4.7",
    "anthropic",
    STORY_PI_OPUS_REASONING,
  ),
];

export const STORY_SERVICE_TIER_SUPPORT: Record<string, boolean> = {
  codex: true,
  "claude-code": false,
  pi: false,
};

export const STORY_PROVIDER_INFOS: readonly ProviderInfo[] =
  STORY_PROVIDER_OPTIONS.map((option) =>
    makeProviderInfo({
      id: option.value,
      displayName: option.label,
      logoUrl: STORY_PROVIDER_LOGO_URLS[option.value] ?? null,
      capabilities: {
        supportsServiceTier: STORY_SERVICE_TIER_SUPPORT[option.value] ?? false,
      },
    }),
  );

export const STORY_PROJECT_SOURCES: readonly ProjectSource[] = [
  {
    id: "src_local",
    projectId: PROJECT_IDS.omnyo,
    type: "local_path",
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/omnyo",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "src_remote",
    projectId: PROJECT_IDS.omnyo,
    type: "local_path",
    hostId: HOST_IDS.remote,
    path: "/home/michael/omnyo",
    isDefault: false,
    createdAt: 0,
    updatedAt: 0,
  },
];

export const STORY_BRANCH_OPTIONS: readonly string[] = [
  "main",
  "release/1.2",
  "feat/sidebar-rail",
  "fix/timeline-pagination",
  "omnyo/refactor-project-creation-thr_jj65bdsiwa",
];

export const STORY_WORKTREE_OPTIONS: readonly ReuseThreadOption[] = [
  {
    environmentId: "env_review_flow",
    branchName: "omnyo/review-flow-thr_4hge9xn14m",
    name: null,
    path: null,
    environmentProviderId: "git-worktree",
    threads: [
      { id: "thr_review", title: "Review flow cleanup" },
      { id: "thr_tests", title: "Backfill promptbox tests" },
    ],
  },
  {
    environmentId: "env_timeline",
    branchName: "omnyo/timeline-pagination-thr_qfk8ksbxkk",
    name: "Timeline workspace",
    path: null,
    environmentProviderId: "git-worktree",
    threads: [{ id: "thr_timeline", title: "Timeline pagination" }],
  },
];

export const STORY_ENVIRONMENT_PROVIDERS: readonly SystemEnvironmentProvider[] =
  [
    {
      machineProviderId: null,
      id: "project-checkout",
      displayName: "Project checkout",
      description: "Work in this project checkout.",
      icon: "Laptop",
      logoUrl: null,
      pluginId: "environment-project-checkout",
      acceptsEmptyInputs: true,
      machineAvailability: {},
      availability: null,
      requires: {
        projectCheckout: true,
        gitCheckout: false,
        gitRemote: false,
        projectless: false,
      },
      inputs: null,
    },
    {
      machineProviderId: null,
      id: "git-worktree",
      displayName: "Worktree",
      description: "Create an isolated Git worktree.",
      icon: "FolderGit",
      logoUrl: null,
      pluginId: "environment-git-worktree",
      acceptsEmptyInputs: true,
      machineAvailability: {},
      availability: null,
      requires: {
        projectCheckout: true,
        gitCheckout: true,
        gitRemote: false,
        projectless: false,
      },
      inputs: null,
    },
    {
      machineProviderId: null,
      id: "personal-workspace",
      displayName: "Personal workspace",
      description: "Create a personal directory without a project.",
      icon: "Folder",
      logoUrl: null,
      pluginId: "environment-personal-workspace",
      acceptsEmptyInputs: true,
      machineAvailability: {},
      availability: null,
      requires: {
        projectCheckout: false,
        gitCheckout: false,
        gitRemote: false,
        projectless: true,
      },
      inputs: null,
    },
  ];

export const STORY_PROJECTS: readonly ProjectSelectorOption[] = [
  { id: PROJECT_IDS.omnyo, name: PROJECT_NAMES.omnyo },
  { id: PROJECT_IDS.pierre, name: PROJECT_NAMES.pierre },
];

export function makeExecutionControlsProps(
  overrides: Partial<ExecutionControlsProps> = {},
): ExecutionControlsProps {
  const base: ExecutionControlsProps = {
    catalog: {
      providers: STORY_PROVIDER_INFOS,
      verified: true,
      modelOptions: STORY_CODEX_MODELS,
    },
    provider: {
      options: STORY_PROVIDER_OPTIONS,
      selectedId: "codex",
      onChange: noop,
      hasMultiple: true,
    },
    model: {
      active: { model: "gpt-5.5" },
      selected: "gpt-5.5",
      options: STORY_CODEX_MODELS,
      moreOptions: [],
      isLoading: false,
      loadFailed: false,
      onChange: noop,
    },
    serviceTier: {
      value: undefined,
      onChange: noop,
      supported: true,
      options: [{ id: "fast", label: "Fast" }],
    },
    reasoning: {
      value: "medium",
      options: STORY_CODEX_REASONING,
      onChange: noop,
    },
    selection: { onChange: noop },
  };

  return { ...base, ...overrides };
}

export function useInteractiveExecutionControls(
  base: ExecutionControlsProps,
): ExecutionControlsProps {
  const [providerId, setProviderId] = useState(
    base.provider.selectedId ?? "codex",
  );

  const [model, setModel] = useState(base.model.selected);
  const [reasoning, setReasoning] = useState(base.reasoning.value);
  const [serviceTier, setServiceTier] = useState(base.serviceTier?.value);

  const catalogForProvider = (id: string, selectedModel = model) => {
    if (id === base.provider.selectedId) {
      return {
        models: base.model.options,
        moreModels: base.model.moreOptions,
        reasoning: base.reasoning.options,
      };
    }

    return {
      models:
        id === "claude-code"
          ? STORY_CLAUDE_CODE_MODELS
          : id === "pi"
            ? STORY_PI_MODELS
            : STORY_CODEX_MODELS,
      moreModels: id === "claude-code" ? STORY_CLAUDE_CODE_MORE_MODELS : [],
      reasoning:
        id === "claude-code"
          ? STORY_CLAUDE_REASONING
          : id === "pi"
            ? (STORY_PI_MODELS.find((option) => option.value === selectedModel)
                ?.reasoningOptions ?? STORY_PI_REASONING)
            : STORY_CODEX_REASONING,
    };
  };

  const catalog = catalogForProvider(providerId);

  return {
    ...base,
    catalog: { ...base.catalog, modelOptions: catalog.models },
    provider: {
      ...base.provider,
      selectedId: providerId,
      onChange: (id) => {
        const next = catalogForProvider(id, "");
        setProviderId(id);
        setModel(next.models[0]?.value ?? "");

        if (next.reasoning.length > 0) {
          setReasoning((current) =>
            reconcileReasoningLevel(
              current,
              next.reasoning.map((option) => option.value),
            ),
          );
        }

        setServiceTier(undefined);
      },
    },
    model: {
      ...base.model,
      active: { model },
      selected: model,
      options: catalog.models,
      moreOptions: catalog.moreModels,
      onChange: (value) => {
        setModel(value);
        const next = catalogForProvider(providerId, value);

        if (next.reasoning.length > 0) {
          setReasoning((current) =>
            reconcileReasoningLevel(
              current,
              next.reasoning.map((option) => option.value),
            ),
          );
        }
      },
    },
    reasoning: {
      value: reasoning,
      options: catalog.reasoning,
      onChange: setReasoning,
    },
    selection: {
      onChange: (next) => {
        setProviderId(next.providerId);
        setModel(next.model);
        setReasoning(next.reasoningLevel);

        if (next.serviceTier !== undefined) setServiceTier(next.serviceTier);
      },
    },
    ...(base.serviceTier
      ? {
          serviceTier: {
            ...base.serviceTier,
            value: serviceTier,
            onChange: setServiceTier,
            supported: STORY_SERVICE_TIER_SUPPORT[providerId] ?? false,
          },
        }
      : {}),
  };
}

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: "thr_demo",
    projectId: PROJECT_IDS.omnyo,
    environmentId: "env_demo",
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    ...overrides,
  });
}

export function makeThreadListEntry(
  overrides: Parameters<typeof makeThreadListEntryFixture>[0] = {},
) {
  return makeThreadListEntryFixture({
    id: "thr_demo",
    projectId: PROJECT_IDS.omnyo,
    title: "Audit recurring permission failures",
    titleFallback: "Audit recurring permission failures",
    ...overrides,
  });
}

export function makeProject(
  overrides: Partial<ProjectResponse> = {},
): ProjectResponse {
  return makeProjectResponse({
    id: PROJECT_IDS.omnyo,
    name: PROJECT_NAMES.omnyo,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  });
}

export function makeHost(overrides: Partial<Host> = {}): Host {
  return makeHostFixture({
    id: HOST_IDS.local,
    name: HOST_NAMES.local,
    lastSeenAt: 100,
    updatedAt: 100,
    ...overrides,
  });
}

export function makeProviderCliStatus(
  provider: ProviderCliKey,
  overrides: Partial<ProviderCliStatus> = {},
): ProviderCliStatus {
  const identity =
    provider === "codex"
      ? { displayName: "Codex", executableName: "codex" }
      : provider === "claude-code"
        ? { displayName: "Claude Code", executableName: "claude" }
        : { displayName: "Cursor", executableName: "agent" };

  return {
    displayName: identity.displayName,
    executableName: identity.executableName,
    executablePath: `/usr/local/bin/${identity.executableName}`,
    installed: true,
    installSource: "npmGlobal",
    currentVersion: "1.0.0",
    latestVersion: "1.0.0",
    minimumSupportedVersion: null,
    npmPackageName: null,
    npmGlobalPackageVersion: null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: false,
    ...overrides,
  };
}

export function makeEnvironment(
  overrides: Parameters<typeof makeEnvironmentFixture>[0] = {},
) {
  return makeEnvironmentFixture({
    id: "env_demo",
    projectId: PROJECT_IDS.omnyo,
    hostId: HOST_IDS.local,
    path: "/Users/michael/Projects/omnyo",
    branchName: BRANCH_NAMES.feature,
    baseBranch: BRANCH_NAMES.default,
    defaultBranch: BRANCH_NAMES.default,
    updatedAt: 100,
    ...overrides,
  });
}

export function makeWorkspaceStatus(
  overrides: Partial<WorkspaceStatus> = {},
): WorkspaceStatus {
  const base: WorkspaceStatus = {
    workingTree: {
      hasUncommittedChanges: false,
      state: "clean",
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      fileCount: 0,
      files: [],
    },
    branch: {
      currentBranch: BRANCH_NAMES.feature,
      defaultBranch: BRANCH_NAMES.default,
    },
    checkout: {
      kind: "branch",
      branchName: BRANCH_NAMES.feature,
      headSha: null,
    },
    mergeBase: {
      mergeBaseBranch: BRANCH_NAMES.default,
      baseRef: null,
      aheadCount: 0,
      behindCount: 0,
      squashMergeCheckComplete: true,
      hasCommittedUnmergedChanges: false,
      commits: [],
      insertions: 0,
      deletions: 0,
      lineStatsComplete: true,
      fileCount: 0,
      files: [],
    },
  };

  return { ...base, ...overrides };
}

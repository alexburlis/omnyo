import {
  findLocalPathProjectSourceForHost,
  isLocalPathProjectSource,
  type ProjectSource,
  type ThreadListEntry,
} from "@omnyo/domain";
import type { SystemEnvironmentProvider } from "@omnyo/server-contract";
import {
  PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
} from "@omnyo/client-core";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { providerDisabledReason } from "@/components/pickers/environment-provider-scope";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import { getThreadDisplayTitle } from "@/lib/thread-title";

export type SeededReuseEnvironmentStatus = "pending" | "available" | "missing";

export interface SeededReuseEnvironment {
  environmentId: string;
  status: SeededReuseEnvironmentStatus;
}

interface ResolveRootComposeEffectiveEnvironmentValueArgs {
  defaultThreadMachineId?: string | null;
  environmentSelectionValue: string;
  environmentProviders?: readonly SystemEnvironmentProvider[];
  isProjectless: boolean;
  knownHostIds: ReadonlySet<string>;
  primaryHostId: string | null;
  projectSources: readonly ProjectSource[];
  reuseThreadOptions: readonly ReuseThreadOption[];
  reuseThreadOptionsLoading: boolean;
  seededReuseEnvironment: SeededReuseEnvironment | null;
}

interface ResolveProjectlessEnvironmentValueArgs {
  environmentProviders: readonly SystemEnvironmentProvider[] | undefined;
  environmentSelectionValue: string;
  parsedSelection: ReturnType<typeof parseEnvironmentValue>;
  primaryHostId: string | null;
  reuseThreadOptions: readonly ReuseThreadOption[];
  reuseThreadOptionsLoading: boolean;
  seededReuseEnvironment: SeededReuseEnvironment | null;
}

function reuseSelectionSurvives({
  environmentId,
  reuseThreadOptions,
  reuseThreadOptionsLoading,
  seededReuseEnvironment,
}: {
  environmentId: string;
  reuseThreadOptions: readonly ReuseThreadOption[];
  reuseThreadOptionsLoading: boolean;
  seededReuseEnvironment: SeededReuseEnvironment | null;
}): boolean {
  if (
    reuseThreadOptions.some((option) => option.environmentId === environmentId)
  ) {
    return true;
  }

  if (reuseThreadOptionsLoading) return true;

  if (seededReuseEnvironment?.environmentId === environmentId) {
    return seededReuseEnvironment.status !== "missing";
  }

  return false;
}

interface ResolveHostEnvironmentProviderArgs {
  currentProvider: SystemEnvironmentProvider | null;
  providers: readonly SystemEnvironmentProvider[];
  inputsControlProviderIds: ReadonlySet<string>;
}

export function resolveHostEnvironmentProvider({
  currentProvider,
  providers,
  inputsControlProviderIds,
}: ResolveHostEnvironmentProviderArgs): SystemEnvironmentProvider | null {
  const candidates = providers.filter(
    (provider) =>
      provider.machineProviderId === null &&
      providerDisabledReason(provider, inputsControlProviderIds) === null,
  );

  return (
    candidates.find((provider) => provider.id === currentProvider?.id) ??
    candidates[0] ??
    (currentProvider?.machineProviderId === null ? currentProvider : null)
  );
}

interface ProjectMachineCandidatesArgs {
  defaultThreadMachineId: string | null;
  rememberedHostId: string | null;
  localHostId: string | null;
  primaryHostId: string | null;
  sources: readonly ProjectSource[];
  hostOrder: readonly string[];
}

function projectMachineCandidates({
  defaultThreadMachineId,
  rememberedHostId,
  localHostId,
  primaryHostId,
  sources,
  hostOrder,
}: ProjectMachineCandidatesArgs): readonly string[] {
  const hostRank = new Map(hostOrder.map((hostId, index) => [hostId, index]));

  const sourceHostIds = sources
    .filter(isLocalPathProjectSource)
    .filter((source) => hostRank.has(source.hostId))
    .sort(
      (left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        (hostRank.get(left.hostId) ?? 0) - (hostRank.get(right.hostId) ?? 0),
    )
    .map((source) => source.hostId);

  return [
    ...new Set(
      [
        defaultThreadMachineId,
        rememberedHostId,
        localHostId,
        primaryHostId,
        ...sourceHostIds,
      ].filter((hostId): hostId is string => hostId !== null),
    ),
  ];
}

export function resolveProjectMachine({
  connectedHostIds,
  isUsable,
  ...candidateArgs
}: ProjectMachineCandidatesArgs & {
  connectedHostIds: ReadonlySet<string>;
  isUsable: (hostId: string) => boolean;
}): string | null {
  const candidates = projectMachineCandidates(candidateArgs);

  return (
    candidates.find(
      (hostId) => isUsable(hostId) && connectedHostIds.has(hostId),
    ) ??
    candidates.find(isUsable) ??
    candidateArgs.defaultThreadMachineId
  );
}

export function resolveNewThreadHostEnvironmentProvider({
  currentProviderId,
  providers,
}: {
  currentProviderId: string | null;
  providers: readonly SystemEnvironmentProvider[];
}): SystemEnvironmentProvider | null {
  const usable = providers.filter(
    (provider) =>
      provider.machineProviderId === null &&
      provider.availability?.status !== "unavailable",
  );

  return (
    usable.find((provider) => provider.id === currentProviderId) ??
    usable[0] ??
    null
  );
}

export function buildReuseThreadOptions(
  threads: readonly ThreadListEntry[],
  hostNameById: ReadonlyMap<string, string> | null = null,
): ReuseThreadOption[] {
  const threadsByEnvironmentId = new Map<string, ThreadListEntry[]>();
  const branchByEnvironmentId = new Map<string, string | null>();
  const nameByEnvironmentId = new Map<string, string | null>();
  const pathByEnvironmentId = new Map<string, string | null>();
  const providerIdByEnvironmentId = new Map<string, string | null>();
  const hostIdByEnvironmentId = new Map<string, string | null>();

  for (const thread of threads) {
    if (thread.environmentId === null) continue;
    let bucket = threadsByEnvironmentId.get(thread.environmentId);

    if (!bucket) {
      bucket = [];
      threadsByEnvironmentId.set(thread.environmentId, bucket);
      branchByEnvironmentId.set(
        thread.environmentId,
        thread.environmentBranchName,
      );
      nameByEnvironmentId.set(thread.environmentId, thread.environmentName);
      pathByEnvironmentId.set(thread.environmentId, thread.environmentPath);
      providerIdByEnvironmentId.set(
        thread.environmentId,
        thread.environmentProviderId,
      );
      hostIdByEnvironmentId.set(thread.environmentId, thread.environmentHostId);
    }

    bucket.push(thread);
  }

  const options: ReuseThreadOption[] = [];

  for (const [environmentId, bucket] of threadsByEnvironmentId) {
    bucket.sort(
      (left, right) => right.latestAttentionAt - left.latestAttentionAt,
    );
    const hostId = hostIdByEnvironmentId.get(environmentId) ?? null;
    options.push({
      environmentId,
      branchName: branchByEnvironmentId.get(environmentId) ?? null,
      name: nameByEnvironmentId.get(environmentId) ?? null,
      path: pathByEnvironmentId.get(environmentId) ?? null,
      environmentProviderId:
        providerIdByEnvironmentId.get(environmentId) ?? null,
      hostId,
      hostName:
        hostNameById !== null && hostId !== null
          ? (hostNameById.get(hostId) ?? null)
          : null,
      threads: bucket.map((thread) => ({
        id: thread.id,
        title: getThreadDisplayTitle(thread),
      })),
    });
  }

  options.sort((left, right) => {
    const leftLabel = left.name ?? left.branchName;
    const rightLabel = right.name ?? right.branchName;

    if (leftLabel && rightLabel) {
      return leftLabel.localeCompare(rightLabel);
    }

    return left.environmentId.localeCompare(right.environmentId);
  });

  return options;
}

export function resolveProjectlessDefaultEnvironmentProvider(
  providers: readonly SystemEnvironmentProvider[],
): SystemEnvironmentProvider | null {
  return (
    providers.find(
      (provider) =>
        provider.id === PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID &&
        provider.requires.projectless,
    ) ?? null
  );
}

function resolveProjectlessEnvironmentValue({
  environmentProviders,
  environmentSelectionValue,
  parsedSelection,
  primaryHostId,
  reuseThreadOptions,
  reuseThreadOptionsLoading,
  seededReuseEnvironment,
}: ResolveProjectlessEnvironmentValueArgs): string {
  if (
    parsedSelection?.type === "reuse" &&
    parsedSelection.environmentId !== null &&
    reuseSelectionSurvives({
      environmentId: parsedSelection.environmentId,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    })
  ) {
    return environmentSelectionValue;
  }

  if (environmentProviders === undefined) {
    return "";
  }

  if (
    parsedSelection?.type === "provider" &&
    environmentProviders.some((provider) => {
      if (provider.id !== parsedSelection.environmentProviderId) return false;

      return provider.requires.projectless && primaryHostId !== null;
    })
  ) {
    return environmentSelectionValue;
  }

  const defaultProvider = resolveProjectlessDefaultEnvironmentProvider(
    environmentProviders.filter(
      (provider) => provider.requires.projectless && primaryHostId !== null,
    ),
  );

  return defaultProvider === null
    ? ""
    : encodeProviderValue(defaultProvider.id);
}

export function resolveRootComposeEffectiveEnvironmentValue({
  defaultThreadMachineId = null,
  environmentSelectionValue,
  environmentProviders,
  isProjectless,
  knownHostIds,
  primaryHostId,
  projectSources,
  reuseThreadOptions,
  reuseThreadOptionsLoading,
  seededReuseEnvironment,
}: ResolveRootComposeEffectiveEnvironmentValueArgs): string {
  const parsedSelection = parseEnvironmentValue(environmentSelectionValue);
  const defaultHostId = defaultThreadMachineId ?? primaryHostId;

  if (isProjectless) {
    return resolveProjectlessEnvironmentValue({
      environmentProviders,
      environmentSelectionValue,
      parsedSelection,
      primaryHostId: defaultHostId,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    });
  }

  if (environmentProviders === undefined) {
    return "";
  }

  const providerRegistered = (environmentProviderId: string): boolean =>
    environmentProviders.some(
      (provider) => provider.id === environmentProviderId,
    );

  const selectedProvider =
    parsedSelection?.type === "provider"
      ? environmentProviders.find(
          (provider) => provider.id === parsedSelection.environmentProviderId,
        )
      : undefined;

  const fallbackValue =
    defaultHostId !== null &&
    knownHostIds.has(defaultHostId) &&
    (defaultThreadMachineId !== null ||
      findLocalPathProjectSourceForHost(projectSources, defaultHostId) !==
        undefined) &&
    providerRegistered(PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID)
      ? encodeProviderValue(PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID)
      : "";

  if (parsedSelection?.type === "reuse") {
    if (parsedSelection.environmentId === null) {
      return environmentSelectionValue;
    }

    return reuseSelectionSurvives({
      environmentId: parsedSelection.environmentId,
      reuseThreadOptions,
      reuseThreadOptionsLoading,
      seededReuseEnvironment,
    })
      ? environmentSelectionValue
      : fallbackValue;
  }

  if (
    selectedProvider !== undefined &&
    (selectedProvider.machineProviderId !== null || defaultHostId !== null)
  ) {
    return environmentSelectionValue;
  }

  return fallbackValue;
}

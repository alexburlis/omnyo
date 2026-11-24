import type {
  HostProviderCliDetectionResponse,
  SystemProviderState,
} from "@omnyo/server-contract";

export const ONBOARDING_PROVIDERS = [
  {
    id: "acp",
    name: "ACP",
    pluginIds: ["omnyo--provider-acp-next", "provider-acp"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    pluginIds: ["provider-claude-code"],
  },
  { id: "codex", name: "Codex", pluginIds: ["provider-codex"] },
] as const;

export type OnboardingProviderId = (typeof ONBOARDING_PROVIDERS)[number]["id"];

type Plugin = { id: string; enabled: boolean };

export function initialOnboardingProviderSelected({
  id,
  replay,
  detected,
  enabled,
}: {
  id: OnboardingProviderId;
  replay: boolean;
  detected: readonly string[] | undefined;
  enabled: boolean;
}): boolean {
  return replay || detected === undefined || (id === "acp" && enabled)
    ? enabled
    : detected.length > 0;
}

export function matchesOnboardingProvider(
  id: OnboardingProviderId,
  providerId: string,
): boolean {
  return id === "acp" ? providerId.startsWith("acp-") : providerId === id;
}

export function detectedOnboardingProviders(
  id: OnboardingProviderId,
  detection: Pick<HostProviderCliDetectionResponse, "providers"> | undefined,
  states: readonly SystemProviderState[] | undefined = undefined,
): string[] | undefined {
  const healthy = (states ?? [])
    .filter(
      (provider) =>
        matchesOnboardingProvider(id, provider.providerId) &&
        provider.status !== "unknown" &&
        provider.status !== "not_installed",
    )
    .map((provider) => provider.displayName);

  const detected = detection?.providers
    .filter(
      (provider) =>
        provider.installed && matchesOnboardingProvider(id, provider.id),
    )
    .map((provider) => provider.displayName);

  if (detected === undefined && healthy.length === 0) return undefined;

  return [...new Set([...(detected ?? []), ...healthy])];
}

export function onboardingProviderEnabled(
  id: OnboardingProviderId,
  plugins: readonly Plugin[],
): boolean {
  const definition = ONBOARDING_PROVIDERS.find(
    (provider) => provider.id === id,
  );

  return (
    definition?.pluginIds.some((pluginId) =>
      plugins.some((plugin) => plugin.id === pluginId && plugin.enabled),
    ) ?? false
  );
}

export function onboardingProviderChanges({
  id,
  enabled,
  plugins,
  preferredAcpPluginId,
}: {
  id: OnboardingProviderId;
  enabled: boolean;
  plugins: readonly Plugin[];
  preferredAcpPluginId?: string | null;
}): { pluginId: string; enabled: boolean }[] {
  const definition = ONBOARDING_PROVIDERS.find(
    (provider) => provider.id === id,
  );

  if (definition === undefined) return [];

  const installed = definition.pluginIds.flatMap((pluginId) => {
    const plugin = plugins.find((entry) => entry.id === pluginId);

    return plugin === undefined ? [] : [plugin];
  });

  if (enabled) {
    if (installed.some((plugin) => plugin.enabled)) return [];

    const preferred =
      (id === "acp"
        ? installed.find((plugin) => plugin.id === preferredAcpPluginId)
        : undefined) ?? installed[0];

    return preferred === undefined
      ? []
      : [{ pluginId: preferred.id, enabled: true }];
  }

  if (!installed.some((plugin) => plugin.enabled)) return [];

  return installed.map((plugin) => ({ pluginId: plugin.id, enabled: false }));
}

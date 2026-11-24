import type { SystemEnvironmentProvider } from "@omnyo/server-contract";
import { encodeProviderValue } from "./environment-picker-value";
import { providerInputsControlRequired } from "./environment-provider-inputs";

export type EnvironmentProvidersByHostId = ReadonlyMap<
  string,
  readonly SystemEnvironmentProvider[] | undefined
>;

export const PROVIDER_INPUTS_CONTROL_MISSING_REASON =
  "Needs its plugin's control";

export function providerValueSelected(
  value: string,
  provider: SystemEnvironmentProvider,
): boolean {
  return value === encodeProviderValue(provider.id);
}

export function providerDisabledReason(
  provider: SystemEnvironmentProvider,
  inputsControlProviderIds: ReadonlySet<string>,
): string | null {
  if (provider.availability?.status === "unavailable") {
    return provider.availability.message;
  }

  if (
    !inputsControlProviderIds.has(provider.id) &&
    providerInputsControlRequired(provider)
  ) {
    return PROVIDER_INPUTS_CONTROL_MISSING_REASON;
  }

  return null;
}

export function providerDescription(
  provider: SystemEnvironmentProvider,
  inputsControlProviderIds: ReadonlySet<string>,
): string | undefined {
  if (provider.availability?.status === "setup-required") {
    return provider.availability.message;
  }

  return (
    providerDisabledReason(provider, inputsControlProviderIds) ?? undefined
  );
}

export function scopedProviders(
  providers: readonly SystemEnvironmentProvider[],
  providersByHostId: EnvironmentProvidersByHostId | undefined,
  hostId: string | null,
  selection: { value: string; selectedProviderHostId: string | null },
): readonly SystemEnvironmentProvider[] {
  const hostProviders =
    hostId === null || providersByHostId === undefined
      ? providers
      : mergeHostProviders(providers, providersByHostId.get(hostId) ?? []);

  return hostProviders.filter(
    (provider) =>
      provider.availability?.status !== "unavailable" ||
      (providerValueSelected(selection.value, provider) &&
        selection.selectedProviderHostId === hostId),
  );
}

export function mergeHostProviders(
  providers: readonly SystemEnvironmentProvider[],
  resolved: readonly SystemEnvironmentProvider[],
): readonly SystemEnvironmentProvider[] {
  const hostProviders = new Map(
    resolved.map((provider) => [provider.id, provider]),
  );

  return providers.flatMap((provider) => {
    const hostProvider = hostProviders.get(provider.id);

    return hostProvider === undefined ? [] : [hostProvider];
  });
}

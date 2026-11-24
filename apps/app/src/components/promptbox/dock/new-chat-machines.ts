import {
  findLocalPathProjectSourceForHost,
  type Host,
  type ProjectSource,
} from "@omnyo/domain";
import type { SystemEnvironmentProvider } from "@omnyo/server-contract";
import {
  type EnvironmentProvidersByHostId,
  providerDisabledReason,
} from "@/components/pickers/environment-provider-scope";
import { formatHostUpdateStatus } from "@/lib/host-update-status";
import { formatRelativeTime } from "@/lib/relative-time";

export type NewChatMachineState = "ready" | "setup" | "offline" | "unavailable";

export interface NewChatMachineOption {
  host: Host;
  state: NewChatMachineState;
  title: string | null;
}

export interface NewChatHostlessProvider {
  provider: SystemEnvironmentProvider;
  disabledReason: string | null;
}

export function orderNewChatHosts(
  hosts: readonly Host[],
  localDaemonHostId: string | null,
): readonly Host[] {
  return [...hosts].sort(
    (left, right) =>
      Number(left.id !== localDaemonHostId) -
      Number(right.id !== localDaemonHostId),
  );
}

function hostHasEnabledProvider(
  providers: readonly SystemEnvironmentProvider[] | undefined,
  inputsControlProviderIds: ReadonlySet<string>,
): boolean {
  return (providers ?? []).some(
    (provider) =>
      provider.machineProviderId === null &&
      providerDisabledReason(provider, inputsControlProviderIds) === null,
  );
}

function resolveMachineState({
  host,
  sources,
  providersByHostId,
  inputsControlProviderIds,
  projectless,
  canRequestSetup,
  now,
}: {
  host: Host;
  sources: readonly ProjectSource[];
  providersByHostId: EnvironmentProvidersByHostId | undefined;
  inputsControlProviderIds: ReadonlySet<string>;
  projectless: boolean;
  canRequestSetup: boolean;
  now: number;
}): Omit<NewChatMachineOption, "host"> {
  const updateStatus = formatHostUpdateStatus(host);

  if (updateStatus !== null) {
    return { state: "unavailable", title: updateStatus };
  }

  if (host.status !== "connected") {
    return {
      state: "offline",
      title:
        host.lastSeenAt === null
          ? "Offline"
          : `Offline · last seen ${formatRelativeTime({ timestamp: host.lastSeenAt, now })}`,
    };
  }

  if (host.lifecycle.phase !== "active") {
    return {
      state: "unavailable",
      title: host.lifecycle.message ?? `Machine is ${host.lifecycle.phase}`,
    };
  }

  if (
    projectless ||
    findLocalPathProjectSourceForHost(sources, host.id) !== undefined ||
    hostHasEnabledProvider(
      providersByHostId?.get(host.id),
      inputsControlProviderIds,
    )
  ) {
    return { state: "ready", title: null };
  }

  return canRequestSetup
    ? { state: "setup", title: `Set up on ${host.name}…` }
    : { state: "unavailable", title: "Not set up for this project" };
}

export function buildNewChatMachines({
  hosts,
  localDaemonHostId,
  sources,
  providersByHostId,
  inputsControlProviderIds,
  projectless,
  canRequestSetup,
  now,
}: {
  hosts: readonly Host[];
  localDaemonHostId: string | null;
  sources: readonly ProjectSource[];
  providersByHostId: EnvironmentProvidersByHostId | undefined;
  inputsControlProviderIds: ReadonlySet<string>;
  projectless: boolean;
  canRequestSetup: boolean;
  now: number;
}): readonly NewChatMachineOption[] {
  return orderNewChatHosts(
    hosts.filter((host) => host.type === "persistent"),
    localDaemonHostId,
  ).map((host) => ({
    host,
    ...resolveMachineState({
      host,
      sources,
      providersByHostId,
      inputsControlProviderIds,
      projectless,
      canRequestSetup,
      now,
    }),
  }));
}

export function buildNewChatHostlessProviders({
  providers,
  projectless,
  inputsControlProviderIds,
}: {
  providers: readonly SystemEnvironmentProvider[];
  projectless: boolean;
  inputsControlProviderIds: ReadonlySet<string>;
}): readonly NewChatHostlessProvider[] {
  return providers
    .filter(
      (provider) =>
        provider.machineProviderId !== null &&
        provider.requires.projectless === projectless,
    )
    .map((provider) => ({
      provider,
      disabledReason: providerDisabledReason(
        provider,
        inputsControlProviderIds,
      ),
    }));
}

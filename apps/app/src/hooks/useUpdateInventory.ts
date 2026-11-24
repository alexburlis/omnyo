import { useQueries } from "@tanstack/react-query";
import type { Host } from "@omnyo/domain";
import type { HostProviderCliStatusResponse as ProviderCliStatusResponse } from "@omnyo/server-contract";
import type {
  SystemAppUpdateStatus,
  SystemVersionResponse,
} from "@omnyo/server-contract";
import type {
  OmnyoDesktopApi,
  OmnyoDesktopInfo,
} from "@omnyo/desktop-contract";
import {
  buildProviderCliIssue,
  isProviderCliIssue,
  providerCliEntries,
  type ProviderCliIssue,
} from "@/components/provider-cli/provider-cli-install";
import { hasActionableAppUpdate } from "@/components/app-update/app-update-presentation";
import { useAppUpdateStatus } from "@/hooks/queries/app-update-queries";
import { useDesktopUpdateInfo } from "@/hooks/useDesktopUpdateInfo";
import { useHosts } from "@/hooks/queries/host-queries";
import { hostProviderCliStatusQueryKey } from "@/hooks/queries/query-keys";
import { SESSION_STATIC_QUERY_POLICY } from "@/hooks/queries/query-policies";
import { useSystemVersion } from "@/hooks/queries/system-queries";
import { hostCanRetryUpdate } from "@/lib/host-update-status";
import { sdk } from "@/lib/sdk";

export interface UpdateInventoryMachine {
  host: Host;
  providerStatus: ProviderCliStatusResponse | null;
  statusPending: boolean;
  statusError: boolean;
  statusFetching: boolean;
  issues: ProviderCliIssue[];
  canRetryDaemonUpdate: boolean;
}

export interface UpdateInventory {
  isLoading: boolean;
  systemVersion: SystemVersionResponse | undefined;
  desktopInfo: OmnyoDesktopInfo | null;
  desktopApi: OmnyoDesktopApi | null;
  isDesktop: boolean;
  appUpdate: SystemAppUpdateStatus | undefined;
  appUpdateAvailable: boolean;
  desktopUpdateReady: boolean;
  machines: UpdateInventoryMachine[];
}

export function buildUpdateInventoryProviderIssues(
  providerStatus: ProviderCliStatusResponse,
): ProviderCliIssue[] {
  return providerCliEntries(providerStatus)
    .map(buildProviderCliIssue)
    .filter(isProviderCliIssue);
}

export function resolveAppUpdateAvailable(args: {
  appUpdate: SystemAppUpdateStatus | undefined;
  isDesktop: boolean;
  systemVersion: SystemVersionResponse | undefined;
}): boolean {
  if (hasActionableAppUpdate(args.appUpdate)) return true;

  return (
    !args.isDesktop &&
    args.systemVersion !== undefined &&
    !args.systemVersion.isDevelopment &&
    args.systemVersion.updateAvailable
  );
}

export function updateInventoryHosts(hosts: readonly Host[]): Host[] {
  return hosts.filter((host) => host.type !== "ephemeral");
}

export function useUpdateInventory(): UpdateInventory {
  const systemVersionQuery = useSystemVersion();
  const appUpdateStatusQuery = useAppUpdateStatus();
  const hostsQuery = useHosts();
  const { desktopApi, desktopInfo, isDesktop } = useDesktopUpdateInfo();

  const updateHosts = updateInventoryHosts(hostsQuery.data ?? []);

  const connectedHosts = updateHosts.filter(
    (host) => host.status === "connected",
  );

  const providerStatusQueries = useQueries({
    queries: connectedHosts.map((host) => ({
      queryKey: hostProviderCliStatusQueryKey(host.id),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        sdk.hosts.providerCliStatus({ hostId: host.id, signal }),
      ...SESSION_STATIC_QUERY_POLICY,
    })),
  });

  const providerStatusByHostId = new Map<
    string,
    (typeof providerStatusQueries)[number]
  >();

  connectedHosts.forEach((host, index) => {
    const query = providerStatusQueries[index];

    if (query !== undefined) {
      providerStatusByHostId.set(host.id, query);
    }
  });

  const machines: UpdateInventoryMachine[] = updateHosts.map((host) => {
    const statusQuery = providerStatusByHostId.get(host.id);
    const providerStatus = statusQuery?.data ?? null;

    const issues =
      providerStatus === null
        ? []
        : buildUpdateInventoryProviderIssues(providerStatus);

    return {
      host,
      providerStatus,
      statusPending: statusQuery?.isPending ?? false,
      statusError: statusQuery?.isError ?? false,
      statusFetching: statusQuery?.isFetching ?? false,
      issues,
      canRetryDaemonUpdate: hostCanRetryUpdate(host),
    };
  });

  const systemVersion = systemVersionQuery.data;

  const appUpdateAvailable = resolveAppUpdateAvailable({
    appUpdate: appUpdateStatusQuery.data,
    isDesktop,
    systemVersion,
  });

  const desktopUpdateReady = desktopInfo?.updateDownloaded === true;

  return {
    isLoading: systemVersionQuery.isPending || hostsQuery.isPending,
    systemVersion,
    desktopInfo,
    desktopApi,
    isDesktop,
    appUpdate: appUpdateStatusQuery.data,
    appUpdateAvailable,
    desktopUpdateReady,
    machines,
  };
}

import { useCallback, useMemo, type ReactNode } from "react";
import {
  ProviderCliBanner,
  providerCliBlockedReason,
} from "@/components/promptbox/banner/ProviderCliBanner";
import {
  buildProviderCliIssue,
  hasProviderCliAction,
  useProviderCliInstallRunner,
} from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { useHostProviderCliStatus } from "@/hooks/queries/system-queries";

export interface ProviderCliGate {
  banner: ReactNode;
  blockedReason: string | undefined;
}

export function useProviderCliGate({
  hostId,
  providerId,
}: {
  hostId: string | null;
  providerId: string;
}): ProviderCliGate {
  const providerCliStatus = useHostProviderCliStatus({
    hostId: hostId,
    enabled: hostId !== null,
  });

  const { queuedJobKeys, runningJobKey, startInstall } =
    useProviderCliInstallRunner();

  const selectedProviderCliStatus =
    providerCliStatus.data?.[providerId] ?? null;

  const blockingProviderCliStatus =
    selectedProviderCliStatus !== null &&
    (!selectedProviderCliStatus.installed ||
      selectedProviderCliStatus.versionUnsupported)
      ? selectedProviderCliStatus
      : null;

  const selectedProviderCliIssue = useMemo(() => {
    if (blockingProviderCliStatus === null) {
      return null;
    }

    const issue = buildProviderCliIssue({
      provider: providerId,
      status: blockingProviderCliStatus,
    });

    return issue && hasProviderCliAction(issue) ? issue : null;
  }, [blockingProviderCliStatus, providerId]);

  const handleRunProviderCliAction = useCallback(() => {
    if (selectedProviderCliIssue === null || hostId === null) return;
    startInstall({
      hostId: hostId,
      issue: selectedProviderCliIssue,
    });
  }, [selectedProviderCliIssue, hostId, startInstall]);

  const banner = useMemo(() => {
    if (blockingProviderCliStatus === null) {
      return null;
    }

    return (
      <ProviderCliBanner
        displayName={blockingProviderCliStatus.displayName}
        installed={blockingProviderCliStatus.installed}
        currentVersion={blockingProviderCliStatus.currentVersion}
        minimumSupportedVersion={
          blockingProviderCliStatus.minimumSupportedVersion
        }
        canRunAction={selectedProviderCliIssue !== null}
        actionRunning={
          hostId !== null &&
          (runningJobKey === providerCliJobKey(hostId, providerId) ||
            queuedJobKeys.has(providerCliJobKey(hostId, providerId)))
        }
        onAction={handleRunProviderCliAction}
      />
    );
  }, [
    blockingProviderCliStatus,
    hostId,
    handleRunProviderCliAction,
    queuedJobKeys,
    runningJobKey,
    selectedProviderCliIssue,
    providerId,
  ]);

  return {
    banner,
    blockedReason:
      blockingProviderCliStatus === null
        ? undefined
        : providerCliBlockedReason(blockingProviderCliStatus),
  };
}

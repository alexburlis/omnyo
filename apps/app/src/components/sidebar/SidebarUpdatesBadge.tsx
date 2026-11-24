import { useState } from "react";
import { Link } from "react-router-dom";
import type { ProviderCliKey } from "@omnyo/host-daemon-contract";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { relaunchIntoDesktopUpdate } from "@/components/app-update/DesktopUpdatePromptHost";
import { UpdateOmnyoNowDialog } from "@/components/app-update/UpdateOmnyoNowDialog";
import {
  appUpdateProgressLabel,
  omnyoUpdateNowState,
  currentAppUpdateFailure,
  formatStopsRunningChatsAt,
} from "@/components/app-update/app-update-presentation";
import { openAppUpdateResultDetails } from "@/components/app-update/app-update-details-store";
import { useProviderCliInstallRunner } from "@/components/provider-cli/provider-cli-install";
import { providerCliJobKey } from "@/components/provider-cli/provider-cli-install-store";
import { SidebarMenuItem } from "@/components/ui/sidebar.js";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useUpdateInventory } from "@/hooks/useUpdateInventory";
import { useMachineAttention } from "@/hooks/useMachineAttention";
import { getOmnyoDesktopInfo } from "@/lib/omnyo-desktop";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { getProviderIconInfo } from "@/lib/provider-icon";
import { getSettingsRoutePath } from "@/lib/route-paths";

interface SidebarUpdatesBadgeProps {
  onNavigate?: () => void;
  compact?: boolean;
}

const CHIP_FOCUS_CLASS =
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sidebar-ring";

const CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-sidebar-border px-2",
  "text-xs font-medium text-sidebar-foreground hover:bg-sidebar-accent",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CHIP_FOCUS_CLASS,
);

const COMPACT_CHIP_CLASS = cn(
  "flex h-6 shrink-0 items-center rounded-md px-1.5",
  "text-xs font-medium text-muted-foreground hover:bg-state-hover hover:text-sidebar-foreground focus-visible:text-sidebar-foreground",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CHIP_FOCUS_CLASS,
);

const COMPACT_WARNING_CLASS = cn(
  "flex size-6 shrink-0 items-center justify-center rounded-md text-warning-text",
  "hover:bg-state-hover hover:text-warning-text",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CHIP_FOCUS_CLASS,
);

function UpdateChipContent({
  compact,
  icon,
  label,
}: {
  compact: boolean;
  icon: "Download" | "ArrowReloadHorizontal";
  label: string;
}) {
  if (!compact) {
    return (
      <>
        <Icon name={icon} className="size-3 text-muted-foreground" />
        {label}
      </>
    );
  }

  return (
    <span className="relative flex size-3.5 shrink-0 items-center justify-center">
      <Icon name={icon} className="size-3.5" />
      <span
        aria-hidden
        data-testid="update-chip-dot"
        className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary"
      />
    </span>
  );
}

function joinNames(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }

  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

interface StaleProvider {
  provider: ProviderCliKey;
  displayName: string;
}

export function SidebarUpdatesBadge({
  onNavigate,
  compact = false,
}: SidebarUpdatesBadgeProps) {
  const inventory = useUpdateInventory();
  const providers = useSystemProviders().data;
  const [confirmingUpdateNow, setConfirmingUpdateNow] = useState(false);
  const { runningJobKey } = useProviderCliInstallRunner();

  const machineAttention = useMachineAttention(
    inventory.machines.map((machine) => machine.host),
    inventory.isLoading,
  );

  const appUpdate = inventory.appUpdate;
  const updateNowState = omnyoUpdateNowState(appUpdate);
  const failure = currentAppUpdateFailure(appUpdate);

  const progressLabel =
    appUpdate === undefined ? null : appUpdateProgressLabel(appUpdate);

  const omnyoUpdateAvailable =
    inventory.appUpdateAvailable ||
    updateNowState === "updating" ||
    failure !== null;

  const desktopUpdateReady = inventory.desktopUpdateReady;

  const staleProvidersByKey = new Map<ProviderCliKey, StaleProvider>();

  for (const machine of inventory.machines) {
    for (const issue of machine.issues) {
      if (!issue.status.installed) {
        continue;
      }

      if (!staleProvidersByKey.has(issue.provider)) {
        staleProvidersByKey.set(issue.provider, {
          provider: issue.provider,
          displayName: issue.status.displayName,
        });
      }
    }
  }

  const staleProviders = [...staleProvidersByKey.values()];

  const providerUpdateRunning = inventory.machines.some((machine) =>
    machine.issues.some(
      (issue) =>
        issue.status.installed &&
        runningJobKey === providerCliJobKey(machine.host.id, issue.provider),
    ),
  );

  if (
    !omnyoUpdateAvailable &&
    !desktopUpdateReady &&
    staleProviders.length === 0 &&
    machineAttention.label === null
  ) {
    return null;
  }

  const updatesRoutePath = getSettingsRoutePath("updates");
  const omnyoLabel = "Omnyo update available";

  const updateNowLabel =
    appUpdate?.available?.activation === "idle-only"
      ? "The update waits for all chats and background work to finish"
      : failure !== null
        ? "Retry Omnyo update"
        : appUpdate?.installsWhenIdle
          ? `Omnyo update installs when chats are idle${
              appUpdate.activity.phase === "draining"
                ? ` or at ${formatStopsRunningChatsAt(appUpdate.activity)}`
                : ""
            }. Update now`
          : "Update Omnyo now";

  const relaunchLabel = "Relaunch to update Omnyo";

  const providerLabel = `${joinNames(
    staleProviders.map((stale) => stale.displayName),
  )} ${staleProviders.length === 1 ? "update" : "updates"} available`;

  return (
    <SidebarMenuItem className="flex min-w-0 items-center gap-1">
      {machineAttention.label !== null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={getSettingsRoutePath("machines")}
              onClick={() => {
                machineAttention.acknowledge();
                onNavigate?.();
              }}
              aria-label={machineAttention.label}
              data-testid="sidebar-machines-attention-badge"
              className={
                compact
                  ? COMPACT_WARNING_CLASS
                  : cn(CHIP_CLASS, "text-warning-text")
              }
            >
              <Icon
                name="AlertTriangle"
                className={compact ? "size-3.5" : "size-3"}
              />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{machineAttention.label}</TooltipContent>
        </Tooltip>
      ) : null}
      {desktopUpdateReady ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => {
                const desktopApi = getOmnyoDesktopInfo();

                if (desktopApi !== null) relaunchIntoDesktopUpdate(desktopApi);
              }}
              aria-label={relaunchLabel}
              data-testid="sidebar-updates-badge-relaunch"
              className={compact ? COMPACT_CHIP_CLASS : CHIP_CLASS}
            >
              <UpdateChipContent
                compact={compact}
                icon="ArrowReloadHorizontal"
                label="Relaunch"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{relaunchLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {omnyoUpdateAvailable && updateNowState === "offer" && appUpdate ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => setConfirmingUpdateNow(true)}
                aria-label={updateNowLabel}
                data-testid="sidebar-updates-badge-omnyo"
                className={compact ? COMPACT_CHIP_CLASS : CHIP_CLASS}
              >
                <UpdateChipContent
                  compact={compact}
                  icon="Download"
                  label={failure === null ? "Update Omnyo" : "Retry update"}
                />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{updateNowLabel}</TooltipContent>
          </Tooltip>
          <UpdateOmnyoNowDialog
            open={confirmingUpdateNow}
            status={appUpdate}
            onOpenChange={setConfirmingUpdateNow}
          />
        </>
      ) : omnyoUpdateAvailable && updateNowState === "updating" && appUpdate ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={progressLabel ?? undefined}
              data-testid="sidebar-updates-badge-omnyo"
              className={CHIP_CLASS}
            >
              <Icon
                name={
                  progressLabel === "Update blocked"
                    ? "AlertTriangle"
                    : "Loading"
                }
                className={cn(
                  "size-3 text-muted-foreground",
                  progressLabel !== "Update blocked" && "animate-spin",
                )}
              />
              <span role="status" aria-label={progressLabel ?? undefined}>
                {progressLabel}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">
            {progressLabel}. View update details
          </TooltipContent>
        </Tooltip>
      ) : omnyoUpdateAvailable ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={omnyoLabel}
              data-testid="sidebar-updates-badge-omnyo"
              className={compact ? COMPACT_CHIP_CLASS : CHIP_CLASS}
            >
              <UpdateChipContent
                compact={compact}
                icon="Download"
                label="Update Omnyo"
              />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{omnyoLabel}</TooltipContent>
        </Tooltip>
      ) : null}
      {failure === null ? null : compact ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label="Show Omnyo update failure details"
              data-testid="sidebar-updates-badge-failure"
              onClick={() => openAppUpdateResultDetails(failure)}
              className={COMPACT_WARNING_CLASS}
            >
              <Icon name="AlertTriangle" className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Update failed</TooltipContent>
        </Tooltip>
      ) : (
        <button
          type="button"
          aria-label="Show Omnyo update failure details"
          onClick={() => openAppUpdateResultDetails(failure)}
          className={cn(CHIP_CLASS, "text-warning-text")}
        >
          <Icon name="AlertTriangle" className="size-3" />
          Update failed
        </button>
      )}
      {staleProviders.length > 0 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to={updatesRoutePath}
              onClick={onNavigate}
              aria-label={providerLabel}
              data-testid="sidebar-updates-badge-providers"
              className={cn(CHIP_CLASS, "min-w-0 shrink")}
            >
              <Icon
                name={providerUpdateRunning ? "Loading" : "Download"}
                className={cn(
                  "size-3 shrink-0 text-muted-foreground",
                  providerUpdateRunning && "animate-spin",
                )}
              />
              <span className="flex min-w-0 items-center gap-1 overflow-hidden @max-[30rem]/app-footer:hidden">
                {staleProviders.map((stale) => {
                  const providerId = stale.provider;

                  const provider = providers?.find(
                    (candidate) => candidate.id === providerId,
                  );

                  const iconInfo = getProviderIconInfo(
                    "agent",
                    providerId,
                    provider ?? null,
                  );

                  if (iconInfo === undefined) {
                    return null;
                  }

                  return (
                    <span
                      key={stale.provider}
                      data-provider-icon={providerId}
                      aria-hidden
                      className="flex size-3 shrink-0 items-center justify-center"
                    >
                      {provider === undefined ? (
                        <iconInfo.icon className="size-3" />
                      ) : (
                        <ProviderIconMark
                          provider={provider}
                          icon={iconInfo.icon}
                          className="size-3"
                        />
                      )}
                    </span>
                  );
                })}
              </span>
            </Link>
          </TooltipTrigger>
          <TooltipContent side="top">{providerLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}

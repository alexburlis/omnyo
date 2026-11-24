import { MachineLifecycleNoticeContent } from "@/components/machines/MachineLifecycleNotice";
import { useMemo, useState, type ComponentProps } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Host, PermissionMode } from "@omnyo/domain";
import type { SystemMachineProvider } from "@omnyo/server-contract";
import type { HostPlatform } from "@omnyo/host-daemon-contract";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { Pill } from "@omnyo/shared-ui/pill";
import { ResourceOverflowMenu } from "@omnyo/shared-ui/resource-list";
import { machineActions } from "@/components/machines/machine-actions";
import { MachineLifecycleActions } from "@/components/machines/MachineLifecycleActions";
import {
  MachineRemoveDialog,
  serverMachineRemoveDisabledReason,
  machineRemovalConsequences,
} from "@/components/machines/MachineRemoveDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { MachineReconnectDialog } from "@/components/machines/MachineReconnectDialog";
import { MoveServerDialog } from "@/components/machines/MoveServerDialog";
import {
  OldServerCopySection,
  hasOldServerCopy,
} from "@/components/machines/OldServerCopySection";
import {
  machineStatusLabel,
  machineStatusSummary,
  machineStatusTone,
} from "@/components/machines/machine-status";
import { canMoveServerHere } from "@/components/machines/server-move";
import { MachineLabel } from "@/components/machines/MachineLabel";
import { PageShell } from "@/components/ui/page-shell.js";
import {
  SettingsBadge,
  SettingsDetailRow,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import { Switch } from "@omnyo/shared-ui/switch";
import { appToast } from "@/components/ui/app-toast";
import { MachineRenameDialog } from "@/components/settings/MachineRenameDialog";
import {
  useRenameHost,
  useResumeHost,
  useRetryHostCleanup,
  useRetryHostUpdate,
  useSetHostAvailability,
  useSuspendHost,
  useUpdateHostPermissionCeiling,
} from "@/hooks/mutations/host-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { useServerMoveStatus } from "@/hooks/queries/server-move-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  useHostProviderCliStatus,
  useSystemConfig,
  useSystemProviders,
} from "@/hooks/queries/system-queries";
import { isProviderCliUpdateIssue } from "@/components/provider-cli/provider-cli-install";
import { buildUpdateInventoryProviderIssues } from "@/hooks/useUpdateInventory";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import {
  formatHostUpdateStatus,
  hostCanRetryUpdate,
} from "@/lib/host-update-status";
import {
  getMutationErrorMessage,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { formatRelativeTime } from "@/lib/relative-time";
import { ProviderIconMark } from "@/components/settings/ProviderIconMark";
import { getProviderIconInfo } from "@/lib/provider-icon";
import {
  getSettingsProjectRoutePath,
  getSettingsRoutePath,
} from "@/lib/route-paths";

const PERMISSION_LIMIT_DESCRIPTION =
  "Highest permission mode any thread on the selected machine may run with. Threads that ask for more resolve down to it, and a provider that supports nothing this low can't run here.";

const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  win32: "Windows",
  unknown: null,
};

interface MachineProject {
  id: string;
  name: string;
}

function headerMeta({
  host,
  platformLabel,
  now,
}: {
  host: Host;
  platformLabel: string | null;
  now: number;
}): string {
  const parts: string[] = [machineStatusLabel({ host, now })];

  if (platformLabel !== null) parts.push(platformLabel);
  parts.push(
    `paired ${formatRelativeTime({ timestamp: host.createdAt, now })}`,
  );

  return parts.join(" · ");
}

interface PermissionLimitCardProps {
  disabled: boolean;
  onSelect: (permissionMode: PermissionMode) => void;
  value: PermissionMode;
}

function PermissionLimitCards({
  disabled,
  onSelect,
  value,
}: PermissionLimitCardProps) {
  return (
    <div role="radiogroup" aria-label="Permission limit">
      <SettingsRowList>
        {PERMISSION_MODE_OPTIONS.map((option) => {
          const selected = option.value === value;

          return (
            <SettingsRow key={option.value} className="items-start">
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={disabled}
                onClick={() => {
                  if (!selected) onSelect(option.value);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  disabled && "opacity-70",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors duration-(--motion-duration-base)",
                    selected ? "border-foreground" : "border-input",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2 rounded-full bg-foreground transition-[opacity,scale] duration-(--motion-duration-base) ease-(--motion-ease-snappy) motion-reduce:transition-opacity",
                      !selected && "scale-50 opacity-0",
                    )}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground">
                    {option.label}
                  </span>
                  {option.description ? (
                    <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </button>
            </SettingsRow>
          );
        })}
      </SettingsRowList>
    </div>
  );
}

function BackToMachinesLink() {
  return (
    <Link
      to={getSettingsRoutePath("machines")}
      className={cn(
        "-ml-1 inline-flex items-center gap-1 rounded-sm px-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
        CONTROL_HOVER_TRANSITION,
      )}
    >
      <Icon name="ChevronLeft" className="size-3.5" />
      Machines
    </Link>
  );
}

export function MachineSettingsHeader({
  host,
  machineProvider,
  platformLabel,
  now,
  isPrimary,
  isThisMachine,
  showServerBadge,
  lifecycleNotice,
  lifecycleActionPending,
  onSuspend,
  onResume,
  onRetryCleanup,
  onRename,
  onReconnect,
  canMoveServerHere,
  onMoveServerHere,
}: {
  host: Host;
  machineProvider: SystemMachineProvider | null;
  platformLabel: string | null;
  now: number;
  isPrimary: boolean;
  isThisMachine: boolean;
  showServerBadge: boolean;
  lifecycleNotice: ComponentProps<
    typeof MachineLifecycleNoticeContent
  >["notice"];
  lifecycleActionPending: boolean;
  onSuspend: () => void;
  onResume: () => void;
  onRetryCleanup: () => void;
  onRename: () => void;
  onReconnect: () => void;
  canMoveServerHere: boolean;
  onMoveServerHere: () => void;
}) {
  return (
    <div className="space-y-3">
      <BackToMachinesLink />
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="min-w-0 text-sm font-semibold text-foreground">
              <MachineLabel host={host} machineProvider={machineProvider} />
            </h1>
            {isThisMachine ? <SettingsBadge>This machine</SettingsBadge> : null}
            {showServerBadge ? <SettingsBadge>Server</SettingsBadge> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <MachineStatusDot
              tone={machineStatusTone(host)}
              label={machineStatusSummary(host)}
              decorative
            />
            <p className="min-w-0 text-xs text-subtle-foreground">
              {headerMeta({ host, platformLabel, now })}
            </p>
          </div>
          <MachineLifecycleNoticeContent notice={lifecycleNotice} />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MachineLifecycleActions
            host={host}
            machineProvider={machineProvider}
            pending={lifecycleActionPending}
            onSuspend={onSuspend}
            onResume={onResume}
            onRetryCleanup={onRetryCleanup}
          />
          <ResourceOverflowMenu
            label={`${host.name} actions`}
            items={machineActions({
              host,
              machineProvider,
              isPrimary,
              canMoveServerHere,
              lifecycleActionPending,
              onRename,
              onReconnect,
              onMoveServerHere,
            })}
          />
        </div>
      </div>
    </div>
  );
}

export function MachineSettingsView() {
  const { hostId } = useParams<{ hostId: string }>();
  const navigate = useNavigate();
  const hostsQuery = useHosts();
  const { providers: machineProviders } = useSystemMachineProviders();
  const systemConfig = useSystemConfig();
  const { localDaemonHostId, platform: localDaemonPlatform } = useHostDaemon();
  const sidebarNavigationQuery = useSidebarNavigation();
  const renameHost = useRenameHost();
  const retryHostUpdate = useRetryHostUpdate();
  const suspendHost = useSuspendHost();
  const resumeHost = useResumeHost();
  const retryHostCleanup = useRetryHostCleanup();
  const updatePermissionCeiling = useUpdateHostPermissionCeiling();
  const setHostAvailability = useSetHostAvailability();
  const serverMoveStatus = useServerMoveStatus();
  const [renameOpen, setRenameOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [moveServerOpen, setMoveServerOpen] = useState(false);
  const [reconnectOpen, setReconnectOpen] = useState(false);

  const hosts = hostsQuery.data;
  const host = hosts?.find((candidate) => candidate.id === hostId) ?? null;

  const canCheckProviderStatus =
    host?.status === "connected" && host.type !== "ephemeral";

  const providerStatusQuery = useHostProviderCliStatus({
    hostId: host?.id ?? null,
    enabled: canCheckProviderStatus,
  });

  const providerStatus = canCheckProviderStatus
    ? providerStatusQuery.data
    : undefined;

  const lifecycleMessage = host?.lifecycle.message ?? null;

  const lifecycleNotice =
    host === null
      ? null
      : { phase: host.lifecycle.phase, message: lifecycleMessage };

  const primaryHostId = systemConfig.data?.primaryHostId ?? null;
  const serverMoveEnabled = systemConfig.data?.experiments.serverMove ?? false;
  const isPrimary = host !== null && host.id === primaryHostId;

  const showThisMachineBadge =
    (hosts?.filter((candidate) => candidate.type === "persistent").length ??
      0) > 1;

  const isThisMachine =
    showThisMachineBadge && host !== null && host.id === localDaemonHostId;

  const machineProvider =
    host?.machineProviderId === null || host?.machineProviderId === undefined
      ? null
      : (machineProviders?.find(
          (provider) => provider.id === host.machineProviderId,
        ) ?? null);

  const projects: MachineProject[] = useMemo(() => {
    const navigation = sidebarNavigationQuery.data?.projects ?? [];

    return navigation
      .filter((project) =>
        project.sources.some((source) => source.hostId === hostId),
      )
      .map((project) => ({ id: project.id, name: project.name }));
  }, [hostId, sidebarNavigationQuery.data]);

  const updateIssueCount = (
    providerStatus === undefined
      ? []
      : buildUpdateInventoryProviderIssues(providerStatus)
  ).filter(isProviderCliUpdateIssue).length;

  const providerRoster = useSystemProviders().data;

  const installedProviders = useMemo(() => {
    const status = providerStatus;

    if (!status) return [];

    return Object.entries(status).flatMap(([providerId, entry]) => {
      if (!entry.installed) return [];

      const provider = providerRoster?.find(
        (candidate) => candidate.id === providerId,
      );

      return [
        {
          ...entry,
          providerId,
          provider,
          ProviderIcon: getProviderIconInfo(
            "agent",
            providerId,
            provider ?? null,
          )?.icon,
        },
      ];
    });
  }, [providerStatus, providerRoster]);

  const now = Date.now();

  const platformLabel =
    host !== null &&
    host.id === localDaemonHostId &&
    localDaemonPlatform !== null
      ? PLATFORM_LABELS[localDaemonPlatform]
      : isPrimary && systemConfig.data?.primaryHostPlatform
        ? PLATFORM_LABELS[systemConfig.data.primaryHostPlatform]
        : null;

  if (hosts === undefined) {
    return (
      <PageShell contentClassName="pt-4 md:pt-5">
        <div className="mx-auto w-full max-w-3xl">
          <DelayedLoading>
            <p className="text-sm text-muted-foreground">Loading…</p>
          </DelayedLoading>
        </div>
      </PageShell>
    );
  }

  if (host === null) {
    return (
      <PageShell contentClassName="pt-4 md:pt-5">
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <BackToMachinesLink />
          <p className="text-sm text-muted-foreground">
            Machine is no longer paired.
          </p>
        </div>
      </PageShell>
    );
  }

  const updateStatus = formatHostUpdateStatus(host);
  const lastServerMove = serverMoveStatus.data?.lastMove ?? null;

  return (
    <PageShell contentClassName="pt-4 md:pt-5">
      <div className="mx-auto w-full max-w-3xl space-y-6 pb-10">
        <MachineSettingsHeader
          host={host}
          machineProvider={machineProvider}
          platformLabel={platformLabel}
          now={now}
          isPrimary={isPrimary}
          isThisMachine={isThisMachine}
          showServerBadge={isPrimary}
          lifecycleNotice={lifecycleNotice}
          lifecycleActionPending={
            suspendHost.isPending ||
            resumeHost.isPending ||
            retryHostCleanup.isPending
          }
          onSuspend={() => suspendHost.mutate(host.id)}
          onResume={() => resumeHost.mutate(host.id)}
          onRetryCleanup={() => retryHostCleanup.mutate(host.id)}
          onRename={() => {
            renameHost.reset();
            setRenameOpen(true);
          }}
          canMoveServerHere={
            systemConfig.data !== undefined &&
            canMoveServerHere({
              host,
              primaryHostId,
              move: serverMoveStatus.data?.move ?? null,
              serverMoveEnabled,
            })
          }
          onReconnect={() => setReconnectOpen(true)}
          onMoveServerHere={() => setMoveServerOpen(true)}
        />

        <SettingsSection title="Availability">
          <SettingsWithControl
            label="Away"
            description="Stops Omnyo's work on this machine and holds new turns until you turn this off."
          >
            <Switch
              aria-label={`${host.name} is Away`}
              checked={host.availability === "away"}
              disabled={setHostAvailability.isPending}
              onCheckedChange={(away) =>
                setHostAvailability.mutate(
                  {
                    hostId: host.id,
                    availability: away ? "away" : "available",
                  },
                  {
                    onError: (error) => {
                      showMutationErrorToast({
                        error,
                        fallbackMessage: `Couldn't change ${host.name}'s availability.`,
                      });
                    },
                  },
                )
              }
            />
          </SettingsWithControl>
        </SettingsSection>

        <SettingsSection
          title="Permission limit"
          description={PERMISSION_LIMIT_DESCRIPTION}
        >
          <PermissionLimitCards
            value={host.maxPermissionMode}
            disabled={updatePermissionCeiling.isPending}
            onSelect={(maxPermissionMode) =>
              updatePermissionCeiling.mutate(
                { hostId: host.id, maxPermissionMode },
                {
                  onError: (error) => {
                    showMutationErrorToast({
                      error,
                      fallbackMessage: `Couldn't change the permission limit for ${host.name}.`,
                    });
                  },
                },
              )
            }
          />
        </SettingsSection>

        <SettingsSection title="Provider CLIs">
          <SettingsRowList>
            <SettingsDetailRow label="Installed">
              {host.status !== "connected" ? (
                <span>Unavailable while offline</span>
              ) : canCheckProviderStatus && providerStatusQuery.isPending ? (
                <span>Checking…</span>
              ) : canCheckProviderStatus && providerStatusQuery.isError ? (
                <span>Status unavailable</span>
              ) : (
                <>
                  {installedProviders.length > 0 ? (
                    <span className="flex min-w-0 flex-wrap items-center justify-start gap-x-3 gap-y-1 @min-[36rem]/settings:justify-end">
                      {installedProviders.map((entry) => (
                        <span
                          key={entry.providerId}
                          className="inline-flex min-w-0 items-center gap-1.5"
                        >
                          {entry.ProviderIcon ? (
                            <span
                              data-provider-icon={entry.providerId}
                              aria-hidden
                              className="flex size-3.5 shrink-0 items-center justify-center"
                            >
                              {entry.provider === undefined ? (
                                <entry.ProviderIcon className="size-3.5" />
                              ) : (
                                <ProviderIconMark
                                  provider={entry.provider}
                                  icon={entry.ProviderIcon}
                                  className="size-3.5"
                                />
                              )}
                            </span>
                          ) : null}
                          <span>{entry.displayName}</span>
                          {entry.currentVersion ? (
                            <span>{entry.currentVersion}</span>
                          ) : null}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span>None installed</span>
                  )}
                  {updateIssueCount > 0 ? (
                    <Link
                      to={getSettingsRoutePath("updates")}
                      className="shrink-0 rounded outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    >
                      <Pill
                        variant="outline"
                        size="sm"
                        className="border-attention/50 bg-surface-attention text-warning-text transition-colors hover:border-attention hover:text-foreground"
                      >
                        {updateIssueCount} to fix
                      </Pill>
                    </Link>
                  ) : null}
                </>
              )}
            </SettingsDetailRow>
          </SettingsRowList>
        </SettingsSection>

        <SettingsSection title="Machine information">
          <SettingsRowList>
            <SettingsDetailRow label="Projects">
              {projects.length === 0 ? (
                <span>None</span>
              ) : (
                <span className="min-w-0 truncate">
                  {projects.map((project, index) => (
                    <span key={project.id}>
                      {index > 0 ? " · " : ""}
                      <Link
                        to={getSettingsProjectRoutePath(project.id)}
                        className={cn(
                          "rounded-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
                          CONTROL_HOVER_TRANSITION,
                        )}
                      >
                        {project.name}
                      </Link>
                    </span>
                  ))}
                </span>
              )}
            </SettingsDetailRow>
            <SettingsDetailRow label="Updates">
              <span>{updateStatus ?? "Up to date"}</span>
              {hostCanRetryUpdate(host) ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-xs"
                  disabled={retryHostUpdate.isPending}
                  onClick={() =>
                    retryHostUpdate.mutate(host.id, {
                      onSuccess: () => {
                        appToast.success(
                          `Update retry requested for ${host.name}`,
                        );
                      },
                    })
                  }
                >
                  {retryHostUpdate.isPending ? "Retrying…" : "Retry update"}
                </Button>
              ) : null}
            </SettingsDetailRow>
          </SettingsRowList>
        </SettingsSection>

        {serverMoveEnabled && hasOldServerCopy(host, lastServerMove) ? (
          <OldServerCopySection host={host} lastMove={lastServerMove} />
        ) : null}

        <SettingsSection
          title="Danger zone"
          description={
            isPrimary
              ? serverMachineRemoveDisabledReason(serverMoveEnabled)
              : `Revokes ${host.name}'s access to this server. ${machineRemovalConsequences(host)}`
          }
        >
          <SettingsRowList>
            <SettingsRow>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={isPrimary}
                onClick={() => setRemoveOpen(true)}
              >
                Remove machine
              </Button>
            </SettingsRow>
          </SettingsRowList>
        </SettingsSection>
      </div>

      <MachineRenameDialog
        target={renameOpen ? host : null}
        pending={renameHost.isPending}
        errorMessage={
          renameHost.isError
            ? getMutationErrorMessage({
                error: renameHost.error,
                fallbackMessage: "Couldn't rename the machine.",
              })
            : null
        }
        onOpenChange={(open) => {
          if (!open && !renameHost.isPending) setRenameOpen(false);
        }}
        onRename={(target, name) =>
          renameHost.mutate(
            { hostId: target.id, name },
            { onSuccess: () => setRenameOpen(false) },
          )
        }
      />

      <MachineRemoveDialog
        target={removeOpen ? host : null}
        onOpenChange={setRemoveOpen}
        onRemoved={() => navigate(getSettingsRoutePath("machines"))}
      />

      <MachineReconnectDialog
        target={reconnectOpen ? host : null}
        onOpenChange={setReconnectOpen}
      />

      <MoveServerDialog
        target={moveServerOpen ? host : null}
        onOpenChange={setMoveServerOpen}
      />
    </PageShell>
  );
}

import { getSettingsRouteIntent } from "@/views/settings-view-split";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Host, PermissionMode } from "@omnyo/domain";
import type { SystemMachineProvider } from "@omnyo/server-contract";
import type { HostPlatform } from "@omnyo/host-daemon-contract";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@omnyo/shared-ui/collapsible";
import { DelayedLoading } from "@omnyo/shared-ui/delayed-loading";
import {
  CONTROL_HOVER_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  LIST_HOVER_TRANSITION,
  REVEALED_CONTENT_MOTION,
} from "@omnyo/shared-ui/motion";
import { ShowMoreToggle } from "@/components/settings/ShowMoreToggle";
import {
  ResourceOverflowMenu,
  ResourceRowDetailChevron,
  targetsResourceAction,
} from "@omnyo/shared-ui/resource-list";
import { AddMachineDialog } from "@/components/dialogs/AddMachineDialog";
import { AttentionBanner } from "@/components/ui/attention-banner";
import { appToast } from "@/components/ui/app-toast";
import { machineActions } from "@/components/machines/machine-actions";
import { MachineReconnectDialog } from "@/components/machines/MachineReconnectDialog";
import { MachineRemoveDialog } from "@/components/machines/MachineRemoveDialog";
import { MachineStatusDot } from "@/components/machines/MachineStatusDot";
import { MoveServerDialog } from "@/components/machines/MoveServerDialog";
import {
  machineStatusLabel,
  machineStatusSummary,
  machineStatusTone,
} from "@/components/machines/machine-status";
import { canMoveServerHere } from "@/components/machines/server-move";
import { MachineRenameDialog } from "@/components/settings/MachineRenameDialog";
import { MachineLabel } from "@/components/machines/MachineLabel";
import {
  SettingsBadge,
  SettingsRow,
  SettingsRowList,
  SettingsSection,
  SettingsWithControl,
} from "@/components/ui/settings-section";
import {
  useRenameHost,
  useResumeHost,
  useRetryHostCleanup,
  useRetryHostUpdate,
  useSuspendHost,
} from "@/hooks/mutations/host-mutations";
import { OptionPicker } from "@/components/pickers/OptionPicker";
import { useUpdateGeneralSettings } from "@/hooks/mutations/settings-mutations";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSystemMachineProviders } from "@/hooks/queries/machine-provider-queries";
import { useServerMoveStatus } from "@/hooks/queries/server-move-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemConfig } from "@/hooks/queries/system-queries";
import { machineAttentionIssue } from "@/hooks/useMachineAttention";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { getSettingsMachineRoutePath } from "@/lib/route-paths";
import { PERMISSION_MODE_OPTIONS } from "@/lib/permission-mode-options";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

const PERMISSION_MODE_PRESENTATION: Record<
  PermissionMode,
  (typeof PERMISSION_MODE_OPTIONS)[number]
> = Object.fromEntries(
  PERMISSION_MODE_OPTIONS.map((option) => [option.value, option]),
) as Record<PermissionMode, (typeof PERMISSION_MODE_OPTIONS)[number]>;

const PLATFORM_LABELS: Record<HostPlatform, string | null> = {
  darwin: "macOS",
  linux: "Linux",
  wsl: "WSL",
  win32: "Windows",
  unknown: null,
};

interface MachineRowProps {
  host: Host;
  isPrimary: boolean;
  isThisMachine: boolean;
  showServerBadge: boolean;
  platformLabel: string | null;
  projectCount: number;
  now: number;
  onRename: () => void;
  onRemove: () => void;
  onReconnect: () => void;
  onRetryUpdate: () => void;
  onSuspend: () => void;
  onResume: () => void;
  onRetryCleanup: () => void;
  canMoveServerHere: boolean;
  onMoveServerHere: () => void;
  serverMoveEnabled: boolean;
  lifecycleActionPending: boolean;
  retryUpdatePending: boolean;
  machineProvider: SystemMachineProvider | null;
}

export function MachineRowContent({
  host,
  isPrimary,
  isThisMachine,
  showServerBadge,
  platformLabel,
  projectCount,
  now,
  onRename,
  onRemove,
  onReconnect,
  onRetryUpdate,
  onSuspend,
  onResume,
  onRetryCleanup,
  canMoveServerHere,
  onMoveServerHere,
  serverMoveEnabled,
  lifecycleActionPending,
  retryUpdatePending,
  machineProvider,
}: MachineRowProps) {
  const navigate = useNavigate();
  const detailPath = getSettingsMachineRoutePath(host.id);
  const permission = PERMISSION_MODE_PRESENTATION[host.maxPermissionMode];
  const projectLabel = `${projectCount} ${projectCount === 1 ? "project" : "projects"}`;
  const connectionLabel = machineStatusLabel({ host, now });

  return (
    <SettingsRow
      className={
        host.type === "ephemeral" ? REVEALED_CONTENT_MOTION : undefined
      }
    >
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div
          data-machine-row
          className={cn(
            "group group/machine -mx-2 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-state-hover focus-within:bg-state-hover",
            LIST_HOVER_TRANSITION,
          )}
          onClick={(event) => {
            if (targetsResourceAction(event)) return;
            navigate(detailPath);
          }}
        >
          <Link
            to={detailPath}
            {...getSettingsRouteIntent(detailPath)}
            aria-label={`Open ${host.name}`}
            className="flex min-w-0 flex-1 items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <MachineLabel
                  host={host}
                  machineProvider={machineProvider}
                  nameClassName="text-sm font-medium text-foreground"
                />
                {isThisMachine ? (
                  <SettingsBadge>this machine</SettingsBadge>
                ) : null}
                {showServerBadge ? <SettingsBadge>server</SettingsBadge> : null}
                {host.availability === "away" ? (
                  <SettingsBadge>away</SettingsBadge>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-subtle-foreground">
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MachineStatusDot
                    tone={machineStatusTone(host)}
                    label={machineStatusSummary(host)}
                    decorative
                  />
                  <span className="min-w-0 truncate">{connectionLabel}</span>
                </span>
                {platformLabel === null ? null : (
                  <span className="truncate">{platformLabel}</span>
                )}
                <span className="shrink-0">{projectLabel}</span>
                <span
                  title={`Highest permission agents can use on this machine. ${permission.description}`}
                  className={cn(
                    "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 font-medium",
                    permission.tone === "warning"
                      ? "bg-warning/15 text-warning-text"
                      : "bg-state-hover text-muted-foreground",
                  )}
                >
                  <Icon
                    name={permission.iconName}
                    aria-hidden
                    className="size-3 shrink-0"
                  />
                  <span className="sr-only">Up to </span>
                  <span>{permission.label}</span>
                </span>
              </div>
            </div>
          </Link>
          <div className="flex shrink-0 items-center gap-1">
            <ResourceOverflowMenu
              label={`${host.name} actions`}
              items={machineActions({
                host,
                machineProvider,
                isPrimary,
                canMoveServerHere,
                serverMoveEnabled,
                lifecycleActionPending,
                retryUpdatePending,
                onRename,
                onReconnect,
                onRetryUpdate,
                onSuspend,
                onResume,
                onRetryCleanup,
                onMoveServerHere,
                onRemove,
              })}
            />
            <ResourceRowDetailChevron />
          </div>
        </div>
      </div>
    </SettingsRow>
  );
}

function MachineErrorDetails({ message }: { message: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="text-xs text-muted-foreground"
    >
      <CollapsibleTrigger
        className={cn(
          "-ml-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          CONTROL_HOVER_TRANSITION,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden
          className={cn(
            "size-3 shrink-0",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-90",
          )}
        />
        Error details
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="whitespace-pre-wrap py-1">{message}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function MachinesSettingsSection() {
  const systemConfig = useSystemConfig();
  const updateGeneralSettings = useUpdateGeneralSettings();
  const hostsQuery = useHosts({ includeCreating: true });
  const { providers: machineProviders } = useSystemMachineProviders();
  const { localDaemonHostId, platform: localDaemonPlatform } = useHostDaemon();
  const sidebarNavigationQuery = useSidebarNavigation();
  const renameHost = useRenameHost();
  const retryHostUpdate = useRetryHostUpdate();
  const suspendHost = useSuspendHost();
  const resumeHost = useResumeHost();
  const retryHostCleanup = useRetryHostCleanup();
  const serverMoveStatus = useServerMoveStatus();
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [showAllMachines, setShowAllMachines] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Host | null>(null);
  const [removeTarget, setRemoveTarget] = useState<Host | null>(null);

  const [reconnectTargetId, setReconnectTargetId] = useState<string | null>(
    null,
  );

  const [moveServerTarget, setMoveServerTarget] = useState<Host | null>(null);

  const hosts = hostsQuery.data;
  const serverPrimaryHostId = systemConfig.data?.primaryHostId ?? null;
  const serverMoveEnabled = systemConfig.data?.experiments.serverMove ?? false;
  const serverMove = serverMoveStatus.data?.move ?? null;
  const projects = sidebarNavigationQuery.data?.projects;

  const projectCountByHostId = useMemo(() => {
    const counts = new Map<string, number>();

    for (const project of projects ?? []) {
      const hostIds = new Set(project.sources.map((source) => source.hostId));

      for (const hostId of hostIds) {
        counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
      }
    }

    return counts;
  }, [projects]);

  const now = Date.now();
  const primaryHostPlatform = systemConfig.data?.primaryHostPlatform ?? null;
  const persistentHosts = hosts?.filter((host) => host.type === "persistent");

  const attentionHosts = (hosts ?? []).flatMap((host) => {
    const issue = machineAttentionIssue(host);

    return issue === null ? [] : [{ host, issue }];
  });

  const allAttentionHostsOffline = attentionHosts.every(
    ({ issue }) => issue.offline,
  );

  const [firstAttentionHost] = attentionHosts;

  const singleOfflineHost =
    attentionHosts.length === 1 && firstAttentionHost?.issue.offline
      ? firstAttentionHost.host
      : null;

  const sandboxHosts = hosts?.filter((host) => host.type === "ephemeral");

  const visibleHosts =
    showAllMachines && sandboxHosts !== undefined
      ? [...(persistentHosts ?? []), ...sandboxHosts]
      : (persistentHosts ?? []);

  const showThisMachineBadge = (persistentHosts?.length ?? 0) > 1;

  const hasMachineRows =
    persistentHosts !== undefined && persistentHosts.length > 0;

  const machineProviderById = useMemo(
    () =>
      new Map(
        (machineProviders ?? []).map((provider) => [provider.id, provider]),
      ),
    [machineProviders],
  );

  const renderMachineRows = (rows: readonly Host[]) => (
    <SettingsRowList>
      {rows.map((host) => (
        <MachineRowContent
          key={host.id}
          host={host}
          isPrimary={host.id === serverPrimaryHostId}
          isThisMachine={showThisMachineBadge && host.id === localDaemonHostId}
          showServerBadge={host.id === serverPrimaryHostId}
          platformLabel={
            host.id === localDaemonHostId && localDaemonPlatform !== null
              ? PLATFORM_LABELS[localDaemonPlatform]
              : host.id === serverPrimaryHostId && primaryHostPlatform !== null
                ? PLATFORM_LABELS[primaryHostPlatform]
                : null
          }
          projectCount={projectCountByHostId.get(host.id) ?? 0}
          now={now}
          onRename={() => {
            renameHost.reset();
            setRenameTarget(host);
          }}
          onRemove={() => {
            setRemoveTarget(host);
          }}
          onReconnect={() => {
            setReconnectTargetId(host.id);
          }}
          onRetryUpdate={() =>
            retryHostUpdate.mutate(host.id, {
              onSuccess: () => {
                appToast.success(`Update retry requested for ${host.name}`);
              },
            })
          }
          retryUpdatePending={
            retryHostUpdate.isPending && retryHostUpdate.variables === host.id
          }
          onSuspend={() =>
            suspendHost.mutate(host.id, {
              onSuccess: () => appToast.success(`${host.name} suspended`),
            })
          }
          onResume={() =>
            resumeHost.mutate(host.id, {
              onSuccess: () => appToast.success(`${host.name} resumed`),
            })
          }
          onRetryCleanup={() =>
            retryHostCleanup.mutate(host.id, {
              onSuccess: () =>
                appToast.success(`Cleanup retried for ${host.name}`),
            })
          }
          canMoveServerHere={
            systemConfig.data !== undefined &&
            canMoveServerHere({
              host,
              primaryHostId: serverPrimaryHostId,
              move: serverMove,
              serverMoveEnabled,
            })
          }
          onMoveServerHere={() => setMoveServerTarget(host)}
          serverMoveEnabled={serverMoveEnabled}
          lifecycleActionPending={
            (suspendHost.isPending && suspendHost.variables === host.id) ||
            (resumeHost.isPending && resumeHost.variables === host.id) ||
            (retryHostCleanup.isPending &&
              retryHostCleanup.variables === host.id)
          }
          machineProvider={
            host.machineProviderId === null
              ? null
              : (machineProviderById.get(host.machineProviderId) ?? null)
          }
        />
      ))}
    </SettingsRowList>
  );

  return (
    <>
      <SettingsSection
        title="Machines"
        bodyClassName="space-y-3 border-0 bg-transparent p-0"
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAddDialogOpen(true)}
          >
            <Icon name="Plus" className="size-3.5" />
            Add a machine
          </Button>
        }
      >
        <SettingsWithControl label="Default machine for new chats">
          <OptionPicker
            label="Default machine for new chats"
            value={
              systemConfig.data?.generalSettings.defaultThreadMachineId ??
              "automatic"
            }
            options={[
              { value: "automatic", label: "Automatic" },
              ...(persistentHosts ?? []).map((host) => ({
                value: host.id,
                label: host.name,
              })),
            ]}
            disabled={!systemConfig.data || updateGeneralSettings.isPending}
            onChange={(value) =>
              updateGeneralSettings.mutate({
                defaultThreadMachineId: value === "automatic" ? null : value,
              })
            }
          />
        </SettingsWithControl>
        {attentionHosts.length > 0 ? (
          <AttentionBanner
            title={
              singleOfflineHost !== null
                ? `${singleOfflineHost.name} is offline`
                : allAttentionHostsOffline
                  ? `${attentionHosts.length} machines are offline`
                  : "Machines need attention"
            }
          >
            {singleOfflineHost === null ? (
              <ul className="space-y-2">
                {attentionHosts.map(({ host, issue }) => (
                  <li key={host.id} className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {allAttentionHostsOffline ? host.name : issue.label}
                      </p>
                      {!issue.offline && host.lifecycle.message ? (
                        <MachineErrorDetails message={host.lifecycle.message} />
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : null}
          </AttentionBanner>
        ) : null}
        <div
          role="note"
          aria-label="About the Omnyo server"
          className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-4 py-3"
        >
          <Icon
            name="Info"
            className="mt-0.5 size-4 shrink-0 text-subtle-foreground"
            aria-hidden
          />
          <div className="min-w-0 space-y-1 text-xs leading-relaxed text-subtle-foreground">
            <p className="font-medium text-foreground">How machines connect</p>
            <p>
              All your machines connect to one central Omnyo server, where your
              threads and settings are stored. Choose a machine that can stay
              awake and online to run the server.
            </p>
            {serverMoveEnabled ? (
              <p>
                To change which machine runs the server, open the ⋯ menu on
                another machine below and choose{" "}
                <span className="font-medium text-foreground">
                  Move server here
                </span>
                .
              </p>
            ) : null}
          </div>
        </div>
        <div
          className={cn(
            "rounded-lg border border-border bg-card px-4 py-3.5",
            hasMachineRows && "py-2",
          )}
        >
          {hosts === undefined ? (
            <div className="min-h-5">
              <DelayedLoading>
                <p className="text-sm text-muted-foreground">Loading…</p>
              </DelayedLoading>
            </div>
          ) : visibleHosts.length === 0 ? (
            <p className="text-sm text-subtle-foreground">No machines yet.</p>
          ) : (
            renderMachineRows(visibleHosts)
          )}
          {sandboxHosts !== undefined && sandboxHosts.length > 0 ? (
            <ShowMoreToggle
              expanded={showAllMachines}
              onExpandedChange={setShowAllMachines}
              collapsedLabel="Show all machines"
              expandedLabel="Show fewer machines"
            />
          ) : null}
        </div>
      </SettingsSection>

      <AddMachineDialog open={addDialogOpen} onOpenChange={setAddDialogOpen} />

      <MachineRenameDialog
        target={renameTarget}
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
          if (!open && !renameHost.isPending) setRenameTarget(null);
        }}
        onRename={(host, name) =>
          renameHost.mutate(
            { hostId: host.id, name },
            { onSuccess: () => setRenameTarget(null) },
          )
        }
      />

      <MachineReconnectDialog
        target={hosts?.find((host) => host.id === reconnectTargetId) ?? null}
        onOpenChange={(open) => {
          if (!open) setReconnectTargetId(null);
        }}
      />

      <MachineRemoveDialog
        target={removeTarget}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      />

      <MoveServerDialog
        target={moveServerTarget}
        onOpenChange={(open) => {
          if (!open) setMoveServerTarget(null);
        }}
      />
    </>
  );
}

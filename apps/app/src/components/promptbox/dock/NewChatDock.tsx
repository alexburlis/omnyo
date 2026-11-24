import {
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
} from "@omnyo/client-core";
import {
  findLocalPathProjectSourceForHost,
  PERSONAL_PROJECT_ID,
  type Host,
} from "@omnyo/domain";
import type { SystemEnvironmentProvider } from "@omnyo/server-contract";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { providerDisabledReason } from "@/components/pickers/environment-provider-scope";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import { ProjectSelector } from "@/components/pickers/ProjectSelector";
import {
  ProjectFace,
  ProjectIcon,
  useConnectedHostIds,
} from "@/components/sidebar/ProjectFace";
import { appToast } from "@/components/ui/app-toast";
import { useProjectSourceBranches } from "@/hooks/queries/project-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import {
  ComposerPlusMenuSlot,
  type PromptBoxAction,
  type PromptBoxApprovals,
} from "@/components/promptbox/PromptBoxActionsMenu";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import type {
  NewThreadEnvironmentConfig,
  NewThreadProjectConfig,
  NewThreadWorktreeConfig,
} from "@/components/promptbox/NewThreadPromptBox";
import {
  buildNewChatHostlessProviders,
  buildNewChatMachines,
  type NewChatHostlessProvider,
  type NewChatMachineOption,
} from "./new-chat-machines";
import {
  describeCheckoutBranch,
  describeMachineSwitch,
  wherePickSelection,
  type NewChatDockConfig,
  type NewChatWhere,
  type NewChatWorkspace,
  type WherePick,
} from "./new-chat-where";
import { dockCells } from "./project-ranking";
import { useWorktreeList, type WorktreeRow } from "./useWorktreeList";

const CORE_WORKSPACE_PROVIDER_IDS: ReadonlySet<string> = new Set([
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
  GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  PERSONAL_WORKSPACE_ENVIRONMENT_PROVIDER_ID,
]);

const NO_INPUTS_CONTROL_PROVIDER_IDS: ReadonlySet<string> = new Set();

const WORKTREE_SEARCH_MIN_ROWS = 6;

const SELECTION_FAILED_MESSAGE = "Couldn't change where this chat runs.";

const CHIP_CLASS_NAME = cn(
  "inline-flex h-7.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-xs text-muted-foreground outline-none",
  "hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "aria-pressed:bg-state-active aria-pressed:font-medium aria-pressed:text-foreground",
  "aria-expanded:bg-state-active aria-expanded:text-foreground",
  "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
  CONTROL_HOVER_TRANSITION,
);

const CELL_CLASS_NAME = cn(
  "flex w-[calc((100%-0.5rem)/3)] min-w-0 shrink-0 flex-col items-center gap-1.5 rounded-xl px-0.5 pb-1.5 pt-2 text-2xs text-muted-foreground outline-none sm:w-[calc((100%-1.25rem)/6)]",
  "hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "aria-pressed:bg-state-active aria-pressed:text-foreground aria-expanded:bg-state-active",
  "disabled:cursor-default disabled:opacity-60",
  CONTROL_HOVER_TRANSITION,
);

const STAGE_CHIP_CLASS_NAME = cn(CHIP_CLASS_NAME, "min-w-0 shrink");

const MACHINE_ICON_CLASS_NAME = cn(
  CHIP_CLASS_NAME,
  "w-7.5 justify-center px-0",
);

const STAGE_FOLDING_CLASS_NAME =
  "hidden @min-[36rem]/home-composer:inline-flex";

const SHELF_CELL_CLASS_NAME = cn(
  "group/shelf-cell flex w-20 min-w-0 shrink-0 flex-col items-center gap-1.5 rounded-lg pb-1 pt-1 text-2xs text-muted-foreground outline-none",
  "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
  "aria-pressed:text-foreground aria-expanded:text-foreground",
  "disabled:cursor-default disabled:opacity-60",
  CONTROL_HOVER_TRANSITION,
);

const SHELF_TILE_CLASS_NAME = cn(
  "block size-8 shrink-0 overflow-hidden rounded-lg opacity-60",
  "transition-opacity duration-(--motion-duration-fast) motion-reduce:transition-none",
  "group-hover/shelf-cell:opacity-100 group-aria-pressed/shelf-cell:opacity-100 group-aria-expanded/shelf-cell:opacity-100",
);

const MENU_ROW_CLASS_NAME = cn(
  "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground outline-none",
  "hover:bg-state-hover focus-visible:bg-state-hover disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent",
);

export interface NewChatDockProps {
  dock: NewChatDockConfig;
  project: NewThreadProjectConfig;
  environment: NewThreadEnvironmentConfig;
  worktree: NewThreadWorktreeConfig;
  favorites: ReactNode;
  approvals: PromptBoxApprovals | null;
  sessionOptionsControl: ReactNode;
  environmentProviderInputsSlot: ReactNode;
  machineProviderInputsSlot: ReactNode;
  promptActions: readonly PromptBoxAction[] | undefined;
  canAttach: boolean;
  promptBoxRef: RefObject<PromptBoxHandle | null>;
}

type KeepEditorFocus = ((event: MouseEvent) => void) | undefined;

function preventEditorBlur(event: MouseEvent) {
  event.preventDefault();
}

function useHostScopedPicks() {
  const pending = useRef(0);

  return (action: () => unknown) => {
    if (pending.current > 0) return;
    pending.current += 1;

    void (async () => {
      try {
        await action();
      } catch {
        appToast.error(SELECTION_FAILED_MESSAGE);
      } finally {
        pending.current -= 1;
      }
    })();
  };
}

export function NewChatDock({
  dock,
  project,
  environment,
  worktree,
  favorites,
  approvals,
  sessionOptionsControl,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
  promptActions,
  canAttach,
  promptBoxRef,
}: NewChatDockProps) {
  const isPointerCoarse = usePointerCoarse();
  const keepEditorFocus = isPointerCoarse ? undefined : preventEditorBlur;
  const runHostScoped = useHostScopedPicks();
  const projectless = project.value === null;

  const pickWhere = (pick: WherePick) => {
    const selection = wherePickSelection(
      dock.where,
      pick,
      dock.defaultThreadMachineId,
    );

    if (selection !== null) runHostScoped(() => dock.select(selection));
  };

  const pickProject = (projectId: string | null) =>
    runHostScoped(() => project.onChange(projectId));

  return (
    <div data-new-chat-dock="" className="flex select-none flex-col">
      <ProjectDock
        rankedProjectIds={dock.rankedProjectIds}
        project={project}
        keepEditorFocus={keepEditorFocus}
        onPick={pickProject}
      />
      <div className="flex justify-center px-3.5 pb-2 pt-1.5">{favorites}</div>
      <WhereLine
        where={dock.where}
        projectId={project.value}
        projectless={projectless}
        environment={environment}
        worktreeOptions={worktree.options}
        keepEditorFocus={keepEditorFocus}
        onPick={pickWhere}
        trailing={
          <>
            {sessionOptionsControl}
            <ComposerPlusMenuSlot
              actions={promptActions}
              onAttach={
                canAttach
                  ? () => promptBoxRef.current?.openAttachmentPicker()
                  : undefined
              }
              onAction={(action) =>
                promptBoxRef.current?.applyPromptAction(action)
              }
              approvals={approvals ?? undefined}
            />
          </>
        }
        environmentProviderInputsSlot={environmentProviderInputsSlot}
        machineProviderInputsSlot={machineProviderInputsSlot}
      />
      <MachineSwitchNote
        where={dock.where}
        project={project}
        environment={environment}
        defaultThreadMachineId={dock.defaultThreadMachineId}
      />
    </div>
  );
}

export interface NewChatStageDockProps extends Omit<
  NewChatDockProps,
  "favorites"
> {
  model: ReactNode;
  shelf: HTMLElement | null;
}

export function NewChatStageDock({
  dock,
  project,
  environment,
  worktree,
  model,
  approvals,
  sessionOptionsControl,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
  promptActions,
  canAttach,
  promptBoxRef,
  shelf,
}: NewChatStageDockProps) {
  const isPointerCoarse = usePointerCoarse();
  const keepEditorFocus = isPointerCoarse ? undefined : preventEditorBlur;
  const runHostScoped = useHostScopedPicks();
  const projectless = project.value === null;

  const pickWhere = (pick: WherePick) => {
    const selection = wherePickSelection(
      dock.where,
      pick,
      dock.defaultThreadMachineId,
    );

    if (selection !== null) runHostScoped(() => dock.select(selection));
  };

  const pickProject = (projectId: string | null) =>
    runHostScoped(() => project.onChange(projectId));

  return (
    <div
      data-new-chat-controls=""
      className="flex min-w-0 select-none items-center gap-0.5"
    >
      <ComposerPlusMenuSlot
        actions={promptActions}
        onAttach={
          canAttach
            ? () => promptBoxRef.current?.openAttachmentPicker()
            : undefined
        }
        onAction={(action) => promptBoxRef.current?.applyPromptAction(action)}
        approvals={approvals ?? undefined}
      />
      {sessionOptionsControl}
      {model}
      <StageWhereControls
        where={dock.where}
        projectId={project.value}
        projectless={projectless}
        environment={environment}
        worktreeOptions={worktree.options}
        keepEditorFocus={keepEditorFocus}
        onPick={pickWhere}
        environmentProviderInputsSlot={environmentProviderInputsSlot}
        machineProviderInputsSlot={machineProviderInputsSlot}
      />
      {shelf === null
        ? null
        : createPortal(
            <div
              data-new-chat-shelf=""
              className="flex select-none flex-col gap-2"
            >
              <ProjectShelf
                rankedProjectIds={dock.rankedProjectIds}
                project={project}
                keepEditorFocus={keepEditorFocus}
                onPick={pickProject}
              />
              <MachineSwitchNote
                where={dock.where}
                project={project}
                environment={environment}
                defaultThreadMachineId={dock.defaultThreadMachineId}
              />
            </div>,
            shelf,
          )}
    </div>
  );
}

function ProjectDock({
  rankedProjectIds,
  project,
  keepEditorFocus,
  onPick,
}: {
  rankedProjectIds: readonly string[];
  project: NewThreadProjectConfig;
  keepEditorFocus: KeepEditorFocus;
  onPick: (projectId: string | null) => void;
}) {
  const names = useMemo(
    () => new Map(project.projects.map((entry) => [entry.id, entry.name])),
    [project.projects],
  );

  const { cells, moreShows } = dockCells(
    rankedProjectIds.filter((id) => names.has(id)),
    project.value,
  );

  const moreLabel =
    moreShows === null
      ? "More"
      : moreShows.kind === "no-project"
        ? "No project"
        : (names.get(moreShows.projectId) ?? "Project");

  return (
    <div
      role="group"
      aria-label="Projects"
      className="flex flex-wrap justify-center gap-1 px-3.5 pb-1.5 pt-3"
    >
      {cells.map((projectId) => (
        <button
          key={projectId}
          type="button"
          aria-pressed={project.value === projectId}
          disabled={project.disabled}
          onMouseDown={keepEditorFocus}
          onClick={() => onPick(projectId)}
          className={CELL_CLASS_NAME}
        >
          <ProjectIcon projectId={projectId} className="size-8 rounded-lg" />
          <span className="max-w-full truncate">{names.get(projectId)}</span>
        </button>
      ))}
      <ProjectSelector
        projects={project.projects}
        value={project.value}
        onChange={onPick}
        allowNoProject={project.allowNoProject ?? false}
        createProject={project.createProject}
        disabled={project.disabled}
        isLoading={project.isLoading}
        trigger={{
          kind: "custom",
          element: (
            <button
              type="button"
              aria-label={`More projects: ${moreLabel}`}
              aria-pressed={moreShows !== null}
              disabled={project.disabled}
              className={CELL_CLASS_NAME}
            >
              {moreShows === null ? (
                <span className="grid size-8 place-items-center rounded-lg bg-surface-recessed">
                  <Icon name="ChevronDown" className="size-4" aria-hidden />
                </span>
              ) : (
                <ProjectIcon
                  projectId={
                    moreShows.kind === "project"
                      ? moreShows.projectId
                      : PERSONAL_PROJECT_ID
                  }
                  className="size-8 rounded-lg"
                />
              )}
              <span className="max-w-full truncate">{moreLabel}</span>
            </button>
          ),
        }}
      />
    </div>
  );
}

function ProjectShelf({
  rankedProjectIds,
  project,
  keepEditorFocus,
  onPick,
}: {
  rankedProjectIds: readonly string[];
  project: NewThreadProjectConfig;
  keepEditorFocus: KeepEditorFocus;
  onPick: (projectId: string | null) => void;
}) {
  const { data: navigation } = useSidebarNavigation();
  const connectedHostIds = useConnectedHostIds();

  const names = useMemo(
    () => new Map(project.projects.map((entry) => [entry.id, entry.name])),
    [project.projects],
  );

  const { cells, moreShows } = dockCells(
    rankedProjectIds.filter((id) => names.has(id)),
    project.value,
  );

  const moreLabel =
    moreShows === null
      ? "More"
      : moreShows.kind === "no-project"
        ? "No project"
        : (names.get(moreShows.projectId) ?? "Project");

  const plate = (projectId: string) => {
    const face =
      navigation === undefined
        ? undefined
        : navigation.personalProject.id === projectId
          ? navigation.personalProject
          : navigation.projects.find((entry) => entry.id === projectId);

    return (
      <span
        aria-hidden="true"
        data-project-icon={projectId}
        className={SHELF_TILE_CLASS_NAME}
      >
        {face === undefined ? null : (
          <ProjectFace
            project={face}
            connectedHostIds={connectedHostIds}
            variant="tile"
          />
        )}
      </span>
    );
  };

  return (
    <div
      role="group"
      aria-label="Projects"
      className="flex flex-wrap justify-center gap-4"
    >
      {cells.map((projectId) => (
        <button
          key={projectId}
          type="button"
          aria-pressed={project.value === projectId}
          disabled={project.disabled}
          onMouseDown={keepEditorFocus}
          onClick={() => onPick(projectId)}
          className={SHELF_CELL_CLASS_NAME}
        >
          {plate(projectId)}
          <span className="max-w-full truncate">{names.get(projectId)}</span>
        </button>
      ))}
      <ProjectSelector
        projects={project.projects}
        value={project.value}
        onChange={onPick}
        allowNoProject={project.allowNoProject ?? false}
        createProject={project.createProject}
        disabled={project.disabled}
        isLoading={project.isLoading}
        trigger={{
          kind: "custom",
          element: (
            <button
              type="button"
              aria-label={`More projects: ${moreLabel}`}
              aria-pressed={moreShows !== null}
              disabled={project.disabled}
              className={SHELF_CELL_CLASS_NAME}
            >
              {moreShows === null ? (
                <span className="grid size-8 place-items-center rounded-lg bg-surface-recessed">
                  <Icon name="ChevronDown" className="size-4" aria-hidden />
                </span>
              ) : (
                plate(
                  moreShows.kind === "project"
                    ? moreShows.projectId
                    : PERSONAL_PROJECT_ID,
                )
              )}
              <span className="max-w-full truncate">{moreLabel}</span>
            </button>
          ),
        }}
      />
    </div>
  );
}

function selectedHost(where: NewChatWhere, hosts: readonly Host[]) {
  if (where.machine.kind !== "host") return null;

  const hostId = where.machine.hostId;

  return hosts.find((host) => host.id === hostId) ?? null;
}

function whereOptions(
  where: NewChatWhere,
  projectless: boolean,
  environment: NewThreadEnvironmentConfig,
) {
  const machines = environment.machines ?? null;
  const hosts = machines?.hosts ?? [];
  const host = selectedHost(where, hosts);

  const inputsControlProviderIds =
    environment.inputsControlProviderIds ?? NO_INPUTS_CONTROL_PROVIDER_IDS;

  const providers = (environment.providers ?? []).filter(
    (provider) => provider.requires.projectless === projectless,
  );

  const hostProviders =
    host === null
      ? []
      : (environment.providersByHostId?.get(host.id) ?? []).filter(
          (provider) =>
            provider.requires.projectless === projectless &&
            providerDisabledReason(provider, inputsControlProviderIds) === null,
        );

  const newWorktreeAvailable = hostProviders.some(
    (provider) => provider.id === GIT_WORKTREE_ENVIRONMENT_PROVIDER_ID,
  );

  const otherProviders = hostProviders.filter(
    (provider) =>
      provider.machineProviderId === null &&
      !CORE_WORKSPACE_PROVIDER_IDS.has(provider.id),
  );

  const selectedProvider =
    where.workspace.kind === "provider"
      ? providers.find(
          (provider) =>
            where.workspace.kind === "provider" &&
            provider.id === where.workspace.providerId,
        )
      : undefined;

  const rows =
    machines === null
      ? null
      : buildNewChatMachines({
          hosts: machines.hosts,
          localDaemonHostId: machines.localDaemonHostId,
          sources: environment.sources,
          providersByHostId: environment.providersByHostId,
          inputsControlProviderIds,
          projectless,
          canRequestSetup:
            !projectless && environment.onRequestMachineSetup !== undefined,
          now: Date.now(),
        });

  const hostless = buildNewChatHostlessProviders({
    providers,
    projectless,
    inputsControlProviderIds,
  });

  const disabled = environment.disabled === true;

  return {
    host,
    newWorktreeAvailable,
    otherProviders,
    selectedProvider,
    rows,
    hostless,
    disabled,
  };
}

function WhereLine({
  where,
  projectId,
  projectless,
  environment,
  worktreeOptions,
  keepEditorFocus,
  onPick,
  trailing,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
}: {
  where: NewChatWhere;
  projectId: string | null;
  projectless: boolean;
  environment: NewThreadEnvironmentConfig;
  worktreeOptions: readonly ReuseThreadOption[];
  keepEditorFocus: KeepEditorFocus;
  onPick: (pick: WherePick) => void;
  trailing: ReactNode;
  environmentProviderInputsSlot: ReactNode;
  machineProviderInputsSlot: ReactNode;
}) {
  const {
    host,
    newWorktreeAvailable,
    otherProviders,
    selectedProvider,
    rows,
    hostless,
    disabled,
  } = whereOptions(where, projectless, environment);

  return (
    <div
      data-new-chat-where=""
      className="flex flex-wrap items-center justify-center gap-0.5 px-3.5 pb-3"
    >
      <MachineMenu
        where={where}
        rows={rows}
        hostless={hostless}
        disabled={disabled}
        keepEditorFocus={keepEditorFocus}
        onPickHost={(hostId) => onPick({ kind: "host", hostId })}
        onPickHostless={(providerId) =>
          onPick({ kind: "hostless", providerId })
        }
        onSetup={(target) => environment.onRequestMachineSetup?.(target)}
      />
      {!projectless && host !== null && projectId !== null ? (
        <>
          <WorkspaceMenu
            key={host.id}
            projectId={projectId}
            host={host}
            workspace={where.workspace}
            worktreeOptions={worktreeOptions}
            newWorktreeAvailable={newWorktreeAvailable}
            otherProviders={otherProviders}
            disabled={disabled}
            onPick={(workspace) => onPick({ kind: "workspace", workspace })}
          />
          {newWorktreeAvailable ? (
            <button
              type="button"
              aria-pressed={where.workspace.kind === "new-worktree"}
              disabled={disabled}
              onMouseDown={keepEditorFocus}
              onClick={() =>
                onPick({
                  kind: "workspace",
                  workspace:
                    where.workspace.kind === "new-worktree"
                      ? { kind: "checkout" }
                      : { kind: "new-worktree" },
                })
              }
              className={CHIP_CLASS_NAME}
            >
              <Icon name="GitBranch" className="size-3.5" aria-hidden />
              New worktree
            </button>
          ) : null}
        </>
      ) : null}
      {selectedProvider !== undefined && selectedProvider.inputs !== null
        ? environmentProviderInputsSlot
        : null}
      {selectedProvider?.machineInputs !== undefined &&
      selectedProvider.machineInputs !== null
        ? machineProviderInputsSlot
        : null}
      {trailing}
    </div>
  );
}

function StageWhereControls({
  where,
  projectId,
  projectless,
  environment,
  worktreeOptions,
  keepEditorFocus,
  onPick,
  environmentProviderInputsSlot,
  machineProviderInputsSlot,
}: {
  where: NewChatWhere;
  projectId: string | null;
  projectless: boolean;
  environment: NewThreadEnvironmentConfig;
  worktreeOptions: readonly ReuseThreadOption[];
  keepEditorFocus: KeepEditorFocus;
  onPick: (pick: WherePick) => void;
  environmentProviderInputsSlot: ReactNode;
  machineProviderInputsSlot: ReactNode;
}) {
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const workspaceTriggerRef = useRef<HTMLButtonElement>(null);

  const {
    host,
    newWorktreeAvailable,
    otherProviders,
    selectedProvider,
    rows,
    hostless,
    disabled,
  } = whereOptions(where, projectless, environment);

  const hasWorkspaceMenu = !projectless && host !== null && projectId !== null;

  const machineMenu = (
    <MachineMenu
      where={where}
      rows={rows}
      hostless={hostless}
      disabled={disabled}
      keepEditorFocus={keepEditorFocus}
      onPickHost={(hostId) => onPick({ kind: "host", hostId })}
      onPickHostless={(providerId) => onPick({ kind: "hostless", providerId })}
      onSetup={(target) => environment.onRequestMachineSetup?.(target)}
      foldedWorkspace={
        hasWorkspaceMenu
          ? {
              isFolded: () =>
                workspaceTriggerRef.current !== null &&
                workspaceTriggerRef.current.getClientRects().length === 0,
              open: () => setWorkspaceOpen(true),
            }
          : undefined
      }
    />
  );

  return (
    <>
      {hasWorkspaceMenu ? (
        <WorkspaceMenu
          key={host.id}
          projectId={projectId}
          host={host}
          workspace={where.workspace}
          worktreeOptions={worktreeOptions}
          newWorktreeAvailable={newWorktreeAvailable}
          otherProviders={otherProviders}
          disabled={disabled}
          onPick={(workspace) => onPick({ kind: "workspace", workspace })}
          stage={{
            leading: machineMenu,
            open: workspaceOpen,
            onOpenChange: setWorkspaceOpen,
            triggerRef: workspaceTriggerRef,
          }}
        />
      ) : (
        machineMenu
      )}
      {selectedProvider !== undefined && selectedProvider.inputs !== null
        ? environmentProviderInputsSlot
        : null}
      {selectedProvider?.machineInputs !== undefined &&
      selectedProvider.machineInputs !== null
        ? machineProviderInputsSlot
        : null}
    </>
  );
}

function machineLabel(
  where: NewChatWhere,
  rows: readonly NewChatMachineOption[] | null,
  hostless: readonly NewChatHostlessProvider[],
): string {
  if (rows === null) return "Loading machines";

  if (where.machine.kind === "host") {
    const hostId = where.machine.hostId;

    return rows.find((row) => row.host.id === hostId)?.host.name ?? "Machine";
  }

  if (where.machine.kind === "hostless") {
    const providerId = where.machine.providerId;

    return (
      hostless.find((entry) => entry.provider.id === providerId)?.provider
        .displayName ?? "Machine"
    );
  }

  return "Choose machine";
}

function MachineMenu({
  where,
  rows,
  hostless,
  disabled,
  keepEditorFocus,
  onPickHost,
  onPickHostless,
  onSetup,
  foldedWorkspace,
}: {
  where: NewChatWhere;
  rows: readonly NewChatMachineOption[] | null;
  hostless: readonly NewChatHostlessProvider[];
  disabled: boolean;
  keepEditorFocus: KeepEditorFocus;
  onPickHost: (hostId: string) => void;
  onPickHostless: (providerId: string) => void;
  onSetup: (host: Host) => void;
  foldedWorkspace?: { isFolded: () => boolean; open: () => void };
}) {
  const label = machineLabel(where, rows, hostless);
  const [showsFoldedWorkspace, setShowsFoldedWorkspace] = useState(false);
  const opensFoldedWorkspace = useRef(false);

  const selectedHostId =
    where.machine.kind === "host" ? where.machine.hostId : null;

  const selectedHostlessId =
    where.machine.kind === "hostless" ? where.machine.providerId : null;

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={
        foldedWorkspace === undefined
          ? undefined
          : (open) => {
              if (open) setShowsFoldedWorkspace(foldedWorkspace.isFolded());
            }
      }
    >
      <DropdownMenuTrigger asChild disabled={disabled || rows === null}>
        <button
          type="button"
          aria-label={`Machine: ${label}`}
          onMouseDown={keepEditorFocus}
          className={MACHINE_ICON_CLASS_NAME}
        >
          <Icon
            name={selectedHostlessId === null ? "Laptop" : "Cloud"}
            className="size-4"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="center"
        mobileTitle="Machine"
        className="min-w-60"
        onCloseAutoFocus={
          foldedWorkspace === undefined
            ? undefined
            : (event) => {
                if (!opensFoldedWorkspace.current) return;
                opensFoldedWorkspace.current = false;
                event.preventDefault();
                foldedWorkspace.open();
              }
        }
      >
        {(rows ?? []).map((row) => (
          <DropdownMenuItem
            key={row.host.id}
            disabled={row.state === "offline" || row.state === "unavailable"}
            onSelect={() =>
              row.state === "setup"
                ? onSetup(row.host)
                : onPickHost(row.host.id)
            }
          >
            <Icon
              name="Laptop"
              className="size-4 text-muted-foreground"
              aria-hidden
            />
            <span className="min-w-0 flex-1 truncate">{row.host.name}</span>
            {row.title === null ? null : (
              <span className="shrink-0 text-xs text-subtle-foreground">
                {row.title}
              </span>
            )}
            {row.host.id === selectedHostId ? (
              <Icon name="Check" className="size-3.5 shrink-0" aria-hidden />
            ) : null}
          </DropdownMenuItem>
        ))}
        {hostless.length === 0 ? null : (
          <>
            <DropdownMenuSeparator />
            {hostless.map((entry) => (
              <DropdownMenuItem
                key={entry.provider.id}
                disabled={entry.disabledReason !== null}
                onSelect={() => onPickHostless(entry.provider.id)}
              >
                <Icon
                  name="Cloud"
                  className="size-4 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate">
                  {entry.provider.displayName}
                </span>
                {entry.disabledReason === null ? null : (
                  <span className="shrink-0 text-xs text-subtle-foreground">
                    {entry.disabledReason}
                  </span>
                )}
                {entry.provider.id === selectedHostlessId ? (
                  <Icon
                    name="Check"
                    className="size-3.5 shrink-0"
                    aria-hidden
                  />
                ) : null}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {foldedWorkspace !== undefined && showsFoldedWorkspace ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                opensFoldedWorkspace.current = true;
              }}
            >
              <Icon
                name="GitBranch"
                className="size-4 text-muted-foreground"
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate">Start in…</span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function pathName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path;
}

function rowLabel(row: WorktreeRow): string {
  return row.kind === "environment"
    ? row.label
    : (row.branch ?? pathName(row.path));
}

function rowMatches(row: WorktreeRow, query: string): boolean {
  const needle = query.trim().toLowerCase();

  if (needle === "") return true;

  return [rowLabel(row), row.branch ?? "", row.path ?? ""].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

function environmentLabel(
  worktreeOptions: readonly ReuseThreadOption[],
  environmentId: string,
): string {
  const option = worktreeOptions.find(
    (candidate) => candidate.environmentId === environmentId,
  );

  return option?.name ?? option?.branchName ?? "Environment";
}

function workspaceLabel({
  workspace,
  checkoutLabel,
  baseBranch,
  worktreeOptions,
  providers,
}: {
  workspace: NewChatWorkspace;
  checkoutLabel: string;
  baseBranch: string;
  worktreeOptions: readonly ReuseThreadOption[];
  providers: readonly SystemEnvironmentProvider[];
}): string {
  switch (workspace.kind) {
    case "checkout":
      return checkoutLabel;
    case "new-worktree":
      return baseBranch;
    case "local-worktree":
      return pathName(workspace.path);
    case "environment":
      return environmentLabel(worktreeOptions, workspace.environmentId);
    case "provider":
      return (
        providers.find((provider) => provider.id === workspace.providerId)
          ?.displayName ?? "Environment"
      );
    case "personal":
      return "Personal workspace";
  }
}

function WorkspaceMenu({
  projectId,
  host,
  workspace,
  worktreeOptions,
  newWorktreeAvailable,
  otherProviders,
  disabled,
  onPick,
  stage,
}: {
  projectId: string;
  host: Host;
  workspace: NewChatWorkspace;
  worktreeOptions: readonly ReuseThreadOption[];
  newWorktreeAvailable: boolean;
  otherProviders: readonly SystemEnvironmentProvider[];
  disabled: boolean;
  onPick: (workspace: Exclude<NewChatWorkspace, { kind: "personal" }>) => void;
  stage?: {
    leading: ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    triggerRef: RefObject<HTMLButtonElement | null>;
  };
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = stage?.open ?? localOpen;
  const setOpen = stage?.onOpenChange ?? setLocalOpen;
  const [query, setQuery] = useState("");
  const branches = useProjectSourceBranches(projectId, host.id, { limit: 1 });

  const list = useWorktreeList({
    projectId,
    hostId: host.id,
    hostName: host.name,
    environments: worktreeOptions,
    enabled: open,
  });

  const checkout = branches.data?.checkout;

  const checkoutBranch =
    checkout === undefined ? null : describeCheckoutBranch(checkout);

  const checkoutLabel = checkoutBranch?.label ?? "Checkout";

  const baseBranch =
    branches.data?.defaultWorktreeBaseBranch ??
    branches.data?.defaultBranch ??
    checkoutLabel;

  const label = workspaceLabel({
    workspace,
    checkoutLabel,
    baseBranch,
    worktreeOptions,
    providers: otherProviders,
  });

  const visibleRows = list.rows.filter((row) => rowMatches(row, query));

  const choose = (next: Exclude<NewChatWorkspace, { kind: "personal" }>) => {
    setOpen(false);
    onPick(next);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {stage === undefined ? null : (
        <PopoverAnchor asChild>
          <span className="flex min-w-0 items-center gap-0.5">
            {stage.leading}
            <PopoverTrigger asChild disabled={disabled}>
              <button
                ref={stage.triggerRef}
                type="button"
                aria-label={`Start in: ${label}`}
                className={cn(STAGE_CHIP_CLASS_NAME, STAGE_FOLDING_CLASS_NAME)}
              >
                <Icon
                  name={
                    workspace.kind === "local-worktree" ||
                    workspace.kind === "environment"
                      ? "FolderGit"
                      : "GitBranch"
                  }
                  className="size-3.5"
                  aria-hidden
                />
                <span
                  className="min-w-0 max-w-40 truncate"
                  title={checkoutBranch?.title ?? undefined}
                >
                  {label}
                </span>
                <Icon
                  name="ChevronDown"
                  className="size-3 text-subtle-foreground"
                  aria-hidden
                />
              </button>
            </PopoverTrigger>
          </span>
        </PopoverAnchor>
      )}
      {stage !== undefined ? null : (
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label={`Start in: ${label}`}
            className={CHIP_CLASS_NAME}
          >
            <Icon
              name={
                workspace.kind === "local-worktree" ||
                workspace.kind === "environment"
                  ? "FolderGit"
                  : "GitBranch"
              }
              className="size-3.5"
              aria-hidden
            />
            <span
              className="max-w-40 truncate"
              title={checkoutBranch?.title ?? undefined}
            >
              {label}
            </span>
            <Icon
              name="ChevronDown"
              className="size-3 text-subtle-foreground"
              aria-hidden
            />
          </button>
        </PopoverTrigger>
      )}
      <PopoverContent
        align="center"
        aria-label="Start in"
        mobileTitle="Start in"
        className="w-72 p-1.5"
      >
        <MenuHeading>Start in</MenuHeading>
        <MenuRow
          icon="GitBranch"
          label={checkoutLabel}
          detail="Checkout"
          selected={workspace.kind === "checkout"}
          onSelect={() => choose({ kind: "checkout" })}
        />
        {newWorktreeAvailable ? (
          <MenuRow
            icon="GitBranch"
            label={`New worktree from ${baseBranch}`}
            detail={null}
            selected={workspace.kind === "new-worktree"}
            onSelect={() => choose({ kind: "new-worktree" })}
          />
        ) : null}
        <MenuHeading>Worktrees</MenuHeading>
        {list.rows.length > WORKTREE_SEARCH_MIN_ROWS ? (
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search worktrees"
            aria-label="Search worktrees"
            className="mb-1 h-7 w-full rounded-md bg-surface-recessed px-2 text-xs text-foreground outline-none placeholder:text-subtle-foreground"
          />
        ) : null}
        <div className="max-h-56 overflow-y-auto">
          {visibleRows.map((row) => (
            <MenuRow
              key={row.kind === "environment" ? row.environmentId : row.path}
              icon="FolderGit"
              label={rowLabel(row)}
              detail={row.kind === "environment" ? row.branch : null}
              selected={
                row.kind === "environment"
                  ? workspace.kind === "environment" &&
                    workspace.environmentId === row.environmentId
                  : workspace.kind === "local-worktree" &&
                    workspace.path === row.path
              }
              disabled={row.kind === "local" && row.prunable}
              onSelect={() =>
                choose(
                  row.kind === "environment"
                    ? { kind: "environment", environmentId: row.environmentId }
                    : { kind: "local-worktree", path: row.path },
                )
              }
            />
          ))}
          {list.status === "loading" ? (
            <MenuNote>Loading worktrees…</MenuNote>
          ) : null}
          {list.status === "failed" ? (
            <MenuNote>{list.message}</MenuNote>
          ) : null}
          {list.status === "ready" && list.rows.length === 0 ? (
            <MenuNote>No other worktrees on the {host.name}.</MenuNote>
          ) : null}
        </div>
        {otherProviders.length === 0 ? null : (
          <>
            <MenuHeading>Other</MenuHeading>
            {otherProviders.map((provider) => (
              <MenuRow
                key={provider.id}
                icon="Folder"
                label={provider.displayName}
                detail={null}
                selected={
                  workspace.kind === "provider" &&
                  workspace.providerId === provider.id
                }
                onSelect={() =>
                  choose({ kind: "provider", providerId: provider.id })
                }
              />
            ))}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function MenuHeading({ children }: { children: string }) {
  return (
    <div className="px-2 pb-1 pt-2 text-2xs font-medium text-subtle-foreground first:pt-1">
      {children}
    </div>
  );
}

function MenuNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-xs text-subtle-foreground">{children}</div>
  );
}

function MenuRow({
  icon,
  label,
  detail,
  selected,
  disabled = false,
  onSelect,
}: {
  icon: string;
  label: string;
  detail: string | null;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={detail === null ? undefined : `${label}, ${detail}`}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
      className={MENU_ROW_CLASS_NAME}
    >
      <Icon
        name={icon}
        className="size-3.5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail === null ? null : (
        <span className="max-w-28 shrink-0 truncate text-subtle-foreground">
          {detail}
        </span>
      )}
      {selected ? (
        <Icon name="Check" className="size-3.5 shrink-0" aria-hidden />
      ) : null}
    </button>
  );
}

function MachineSwitchNote({
  where,
  project,
  environment,
  defaultThreadMachineId,
}: {
  where: NewChatWhere;
  project: NewThreadProjectConfig;
  environment: NewThreadEnvironmentConfig;
  defaultThreadMachineId: string | null;
}) {
  const hosts = environment.machines?.hosts ?? [];

  const projectName =
    project.value === null
      ? null
      : (project.projects.find((entry) => entry.id === project.value)?.name ??
        null);

  const note =
    projectName === null
      ? null
      : describeMachineSwitch({
          projectName,
          defaultHost:
            hosts.find((host) => host.id === defaultThreadMachineId) ?? null,
          resolvedHostId:
            where.machine.kind === "host" ? where.machine.hostId : null,
          hostsWithProject: hosts.filter(
            (host) =>
              findLocalPathProjectSourceForHost(
                environment.sources,
                host.id,
              ) !== undefined,
          ),
          now: Date.now(),
        });

  if (note === null) return null;

  return (
    <p className="flex justify-center gap-1.5 px-4.5 pb-3 text-center text-xs text-muted-foreground">
      <Icon name="Info" className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{note}</span>
    </p>
  );
}

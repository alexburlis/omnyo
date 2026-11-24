import {
  forwardRef,
  useEffect,
  useMemo,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import type { DragEndEvent } from "@dnd-kit/core";
import { DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  RAIL_JUMP_APP_COMMAND_IDS,
  type KeyboardCommandId,
} from "@omnyo/domain";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@omnyo/shared-ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import { useSidebarSortable } from "@omnyo/shared-ui/sortable-motion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { useSidebarReorderDnd } from "@omnyo/shared-ui/use-sidebar-reorder-dnd";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appToast } from "@/components/ui/app-toast";
import {
  useAppCommandShortcut,
  useAppCommandShortcuts,
} from "@/components/commands/AppCommandProvider";
import { appCommandTarget } from "@/lib/app-command-targets";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { useCloseMobileSidebar } from "@/components/ui/sidebar.js";
import { useReorderProject } from "@/hooks/mutations/project-mutations";
import { useQuickCreateProjectController } from "@/hooks/useQuickCreateProject";
import { useSetRootComposeProjectId } from "@/lib/root-compose-selection";
import {
  getRootComposeRoutePath,
  getSettingsProjectRoutePath,
} from "@/lib/route-paths";
import {
  neighbourInDirection,
  partitionRailEntries,
  railProjectReorder,
  useHiddenRailProjects,
  type RailMoveDirection,
} from "./projectRailPreferences";
import {
  EMPTY_RAIL_ATTENTION,
  inboxTriageLabel,
  isRailAttentionQuiet,
  railAttentionBadgeCount,
  railAttentionLabel,
  sumRailAttention,
  type InboxTriageCounts,
  type RailAttentionCounts,
  type RailRoot,
} from "./railAttention";
import type { SidebarScope } from "./sidebarScope";
import { SidebarTouchSensor } from "./sidebarTouchSensor";
import { monogramStyle, ProjectFace, useConnectedHostIds } from "./ProjectFace";
import { projectMonogram } from "./useProjectIcon";
import { SidebarChatListPopover } from "./SidebarChatListPopover";
import type { ProjectRailEntry } from "./project-rail-catalog";

const RAIL_TILE_CLASS = cn(
  "relative size-10 shrink-0 cursor-pointer rounded-xl p-0 text-sidebar-foreground outline-none",
  "ring-sidebar-ring focus-visible:ring-2",
  CONTROL_PRESS_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
);

const RAIL_FACE_FOOTPRINT_CLASS =
  "relative m-0.75 block size-8.5 overflow-hidden rounded-[10px]";

const RAIL_RAISED_FACE_CLASS = cn(
  RAIL_FACE_FOOTPRINT_CLASS,
  "shadow-[0_1px_2px_var(--material-shadow)]",
  "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_0.5px_color-mix(in_oklab,var(--ink)_14%,transparent),inset_0_1px_0_var(--material-highlight)]",
);

const NEEDS_BADGE_CLASS = cn(
  "bg-attention text-[color-mix(in_oklch,var(--attention)_20%,var(--ink))]",
  "dark:text-[color-mix(in_oklch,var(--attention)_20%,var(--canvas))]",
);

const REORDER_KEY_SHORTCUTS = "Alt+ArrowUp Alt+ArrowDown";

interface RailTileProps extends Omit<
  ComponentProps<"button">,
  "aria-current" | "aria-label" | "aria-pressed" | "children"
> {
  name: string;
  label?: string;
  counts: RailAttentionCounts;
  isSelected: boolean;
  isCurrent?: boolean;
  isToggle?: boolean;
  showsFresh: boolean;
  isQuiet: boolean;
  face: ReactNode;
  faceStyle?: "raised" | "flat";
  shortcut?: AppShortcutPresentation | null;
  tooltipDetail?: ReactNode;
  showAttentionBadge?: boolean;
}

const RailTile = forwardRef<HTMLButtonElement, RailTileProps>(
  (
    {
      name,
      label,
      counts,
      isSelected,
      isCurrent = false,
      isToggle = true,
      showsFresh,
      isQuiet,
      face,
      faceStyle = "raised",
      shortcut = null,
      tooltipDetail = null,
      showAttentionBadge = true,
      "aria-keyshortcuts": keyShortcuts,
      className,
      ...props
    },
    ref,
  ) => {
    const badge = railAttentionBadgeCount(counts);

    const pill = isSelected
      ? "selected"
      : isCurrent
        ? "current"
        : showsFresh && !counts.hasRunningWork && counts.fresh > 0
          ? "fresh"
          : "none";

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-label={label ?? railAttentionLabel(name, counts)}
            aria-pressed={isToggle ? isSelected : undefined}
            aria-current={isCurrent ? "location" : undefined}
            aria-keyshortcuts={
              [shortcut?.ariaKeyshortcuts, keyShortcuts]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-rail-tile=""
            data-selected={isSelected || undefined}
            data-quiet={isQuiet || undefined}
            className={cn(RAIL_TILE_CLASS, className)}
            {...props}
          >
            <span
              aria-hidden="true"
              data-rail-tile-pill={pill}
              className={cn(
                "pointer-events-none absolute top-1/2 left-[calc((2.5rem_-_var(--omnyo-nav-rail-width))/2)] h-8 w-1 -translate-y-1/2 bg-sidebar-foreground",
                pill === "selected"
                  ? "[clip-path:inset(0_0_0_0_round_0_3px_3px_0)]"
                  : pill === "current"
                    ? "[clip-path:inset(8px_0_8px_0_round_0_3px_3px_0)]"
                    : pill === "fresh"
                      ? "[clip-path:inset(12px_0_12px_0_round_0_3px_3px_0)]"
                      : "[clip-path:inset(16px_0_16px_0_round_0_3px_3px_0)]",
              )}
            />
            <span
              data-rail-tile-face={faceStyle}
              className={
                faceStyle === "raised"
                  ? RAIL_RAISED_FACE_CLASS
                  : RAIL_FACE_FOOTPRINT_CLASS
              }
            >
              {face}
            </span>
            {showAttentionBadge && badge > 0 ? (
              <span
                aria-hidden="true"
                data-rail-tile-badge={counts.failed > 0 ? "failed" : "needs"}
                className={cn(
                  "pointer-events-none absolute -top-px -right-0.5 h-4 min-w-4 rounded-full px-1 text-center text-2xs leading-4 font-bold tabular-nums ring-2 ring-(--omnyo-rail-surface)",
                  counts.failed > 0
                    ? "bg-destructive text-destructive-foreground"
                    : NEEDS_BADGE_CLASS,
                )}
              >
                {badge > 99 ? "99+" : badge}
              </span>
            ) : null}
            <AppCommandShortcutHint
              shortcut={shortcut}
              className="absolute -bottom-1 left-1/2 z-10 -translate-x-1/2 bg-canvas px-1 py-0.5 text-2xs text-sidebar-foreground opacity-100 shadow-sm"
            />
            {counts.running > 0 ? (
              <span
                aria-hidden="true"
                data-rail-tile-running=""
                className="pointer-events-none absolute -bottom-0.5 left-1/2 h-0.75 w-3.5 -translate-x-1/2 rounded-full bg-success ring-2 ring-(--omnyo-rail-surface)"
              />
            ) : null}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">
          {tooltipDetail === null ? (
            shortcut ? (
              `${name} (${shortcut.label})`
            ) : (
              name
            )
          ) : (
            <span className="flex flex-col gap-0.5">
              <span>{shortcut ? `${name} (${shortcut.label})` : name}</span>
              {tooltipDetail}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  },
);

RailTile.displayName = "RailTile";

function RailAttentionBadge({
  counts,
  roots,
  title,
  onNavigate,
}: {
  counts: RailAttentionCounts;
  roots: readonly RailRoot[];
  title: string;
  onNavigate?: () => void;
}) {
  const badge = railAttentionBadgeCount(counts);

  if (badge === 0) return null;

  return (
    <SidebarChatListPopover
      label={`Show ${railAttentionLabel(title, counts)}`}
      title={title}
      roots={roots}
      side="right"
      onNavigate={onNavigate}
      badgeKind={counts.failed > 0 ? "failed" : "needs"}
      className={cn(
        "absolute -top-px -right-0.5 z-10 h-4 min-w-4 rounded-full px-1 text-center text-2xs leading-4 font-bold tabular-nums ring-2 ring-(--omnyo-rail-surface)",
        counts.failed > 0
          ? "bg-destructive text-destructive-foreground"
          : NEEDS_BADGE_CLASS,
      )}
    >
      {badge > 99 ? "99+" : badge}
    </SidebarChatListPopover>
  );
}

interface InboxRailTileProps extends Omit<
  ComponentProps<"button">,
  "aria-label" | "aria-pressed" | "children" | "onClick"
> {
  counts: RailAttentionCounts;
  triage: InboxTriageCounts;
  scope: SidebarScope;
  onSelectScope: (scope: SidebarScope) => void;
  attentionRoots: readonly RailRoot[];
}

const INBOX_HOME_OUTLINE =
  "M3.25 10.6v7.15A3.25 3.25 0 0 0 6.5 21h11a3.25 3.25 0 0 0 3.25-3.25V10.6a2 2 0 0 0-.74-1.55l-6.74-5.53a2 2 0 0 0-2.54 0L3.99 9.05a2 2 0 0 0-.74 1.55Z";

const INBOX_HOME_TRAY = "M3.25 13.75h5.6l1.25 2.5h3.8l1.25-2.5h5.6";

const INBOX_FACE_CLASS =
  "grid size-full place-items-center rounded-[inherit] text-muted-foreground hover:bg-state-hover";

const INBOX_FACE_SELECTED_CLASS =
  "bg-surface-selected text-sidebar-foreground shadow-[inset_0_0_0_0.5px_var(--surface-selected-border)] hover:bg-surface-selected";

function InboxHomeGlyph({ isSelected }: { isSelected: boolean }) {
  return (
    <svg
      aria-hidden="true"
      data-inbox-home-glyph=""
      data-icon-root=""
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5"
    >
      <path
        d={INBOX_HOME_OUTLINE}
        fill="currentColor"
        fillOpacity={isSelected ? 0.2 : 0.12}
        stroke="none"
      />
      <path
        d={`${INBOX_HOME_TRAY}v4A3.25 3.25 0 0 1 17.5 21h-11a3.25 3.25 0 0 1-3.25-3.25Z`}
        fill="currentColor"
        fillOpacity={isSelected ? 0.5 : 0.34}
        stroke="none"
      />
      <path d={INBOX_HOME_OUTLINE} />
      <path d={INBOX_HOME_TRAY} />
    </svg>
  );
}

type InboxTriageKind = "needs" | "failed" | "unread" | "ready";

interface InboxTriageRow {
  kind: InboxTriageKind;
  count: number;
  label: string;
}

function inboxTriageRows(triage: InboxTriageCounts): InboxTriageRow[] {
  const rows: InboxTriageRow[] = [
    {
      kind: "needs",
      count: triage.needs,
      label: triage.needs === 1 ? "needs you" : "need you",
    },
    { kind: "failed", count: triage.failed, label: "failed" },
    { kind: "unread", count: triage.unread, label: "unread" },
    { kind: "ready", count: triage.ready, label: "ready to archive" },
  ];

  return rows.filter((row) => row.count > 0);
}

function InboxTriageGlyph({ kind }: { kind: InboxTriageKind }) {
  if (kind === "ready") {
    return <Icon name="Check" className="size-3 text-success" />;
  }

  return (
    <span
      className={cn(
        "size-2 rounded-full",
        kind === "failed" && "bg-destructive",
        kind === "needs" && "bg-attention",
        kind === "unread" && "bg-success",
      )}
    />
  );
}

export const InboxRailTile = forwardRef<HTMLButtonElement, InboxRailTileProps>(
  ({ counts, triage, scope, onSelectScope, attentionRoots, ...props }, ref) => {
    const isSelected = scope.kind === "inbox";
    const shortcut = useAppCommandShortcut("rail.jump.1");
    const rows = inboxTriageRows(triage);
    const closeOnMobile = useCloseMobileSidebar();

    return (
      <span className="relative flex">
        <RailTile
          ref={ref}
          shortcut={shortcut}
          {...appCommandTarget("rail.jump.1")}
          data-rail-scope-target="inbox"
          name="Inbox"
          label={inboxTriageLabel(triage, counts.running)}
          counts={counts}
          showAttentionBadge={false}
          isSelected={isSelected}
          showsFresh={false}
          isQuiet={false}
          faceStyle="flat"
          tooltipDetail={
            rows.length === 0
              ? null
              : rows.map((row) => (
                  <span
                    key={row.kind}
                    data-inbox-triage-row={row.kind}
                    className="flex items-center gap-1.5 tabular-nums"
                  >
                    <span className="grid w-3 place-items-center">
                      <InboxTriageGlyph kind={row.kind} />
                    </span>
                    {row.count} {row.label}
                  </span>
                ))
          }
          face={
            <span
              className={cn(
                INBOX_FACE_CLASS,
                isSelected && INBOX_FACE_SELECTED_CLASS,
              )}
            >
              <InboxHomeGlyph isSelected={isSelected} />
            </span>
          }
          onClick={() => onSelectScope({ kind: "inbox" })}
          {...props}
        />
        <RailAttentionBadge
          counts={counts}
          roots={attentionRoots}
          title="Inbox attention"
          onNavigate={closeOnMobile}
        />
      </span>
    );
  },
);

InboxRailTile.displayName = "InboxRailTile";

interface RailTileArrangement {
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: ((direction: RailMoveDirection) => void) | null;
  isHidden: boolean;
  onHide: () => void;
  onShow: () => void;
}

function ProjectRailTile({
  entry,
  isSelected,
  isCurrent,
  connectedHostIds,
  arrangement,
  shortcut,
  command,
  onSelectScope,
}: {
  entry: ProjectRailEntry;
  isSelected: boolean;
  isCurrent: boolean;
  connectedHostIds: ReadonlySet<string>;
  arrangement: RailTileArrangement;
  shortcut: AppShortcutPresentation | null;
  command: KeyboardCommandId | undefined;
  onSelectScope: (scope: SidebarScope) => void;
}) {
  const { project, counts, roots } = entry;
  const navigate = useNavigate();
  const closeOnMobile = useCloseMobileSidebar();
  const setRootComposeProjectId = useSetRootComposeProjectId();
  const { onMove } = arrangement;

  const sortable = useSidebarSortable({
    id: project.id,
    disabled: onMove === null,
  });

  const pointerListeners = Object.fromEntries(
    Object.entries(sortable.dragBindings.listeners ?? {}).filter(
      ([name]) => name !== "onKeyDown",
    ),
  );

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (onMove === null || !event.altKey) return;

    if (event.key === "ArrowUp" && arrangement.canMoveUp) {
      event.preventDefault();
      onMove("up");
    } else if (event.key === "ArrowDown" && arrangement.canMoveDown) {
      event.preventDefault();
      onMove("down");
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <span
          ref={sortable.setNodeRef}
          style={sortable.style}
          className="relative flex"
          data-rail-project={project.id}
          data-rail-hidden={arrangement.isHidden || undefined}
        >
          <RailTile
            ref={sortable.dragBindings.setActivatorNodeRef}
            shortcut={shortcut}
            {...(command ? appCommandTarget(command) : {})}
            data-rail-scope-target={project.id}
            name={project.name}
            tooltipDetail={
              railAttentionLabel(project.name, counts).slice(
                project.name.length + 2,
              ) || null
            }
            counts={counts}
            showAttentionBadge={false}
            isSelected={isSelected}
            isCurrent={isCurrent}
            showsFresh
            isQuiet={isRailAttentionQuiet(counts)}
            face={
              <ProjectFace
                project={project}
                connectedHostIds={connectedHostIds}
                variant="tile"
              />
            }
            aria-keyshortcuts={
              onMove === null ? undefined : REORDER_KEY_SHORTCUTS
            }
            className={onMove === null ? undefined : "touch-manipulation"}
            {...pointerListeners}
            onKeyDown={handleKeyDown}
            onClick={() =>
              onSelectScope({ kind: "project", projectId: project.id })
            }
          />
          <RailAttentionBadge
            counts={counts}
            roots={roots.filter(
              (root) => root.state === "failed" || root.state === "needs",
            )}
            title={`Attention in ${project.name}`}
            onNavigate={closeOnMobile}
          />
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={`${project.name} options`}>
        <ContextMenuItem
          onSelect={() => {
            closeOnMobile();
            setRootComposeProjectId(project.id);
            void navigate(getRootComposeRoutePath(), {
              state: { focusPrompt: true },
            });
          }}
        >
          <Icon name="MessageSquarePlus" aria-hidden="true" />
          {`New chat in ${project.name}`}
        </ContextMenuItem>
        {project.kind === "personal" ? null : (
          <ContextMenuItem
            onSelect={() => {
              void navigate(getSettingsProjectRoutePath(project.id));
            }}
          >
            <Icon name="Settings" aria-hidden="true" />
            Project settings
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {onMove === null ? null : (
          <>
            <ContextMenuItem
              disabled={!arrangement.canMoveUp}
              onSelect={() => onMove("up")}
            >
              <Icon name="ArrowUp" aria-hidden="true" />
              Move up
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!arrangement.canMoveDown}
              onSelect={() => onMove("down")}
            >
              <Icon name="ArrowDown" aria-hidden="true" />
              Move down
            </ContextMenuItem>
          </>
        )}
        {arrangement.isHidden ? (
          <ContextMenuItem onSelect={arrangement.onShow}>
            <Icon name="Eye" aria-hidden="true" />
            Show in rail
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={arrangement.onHide}>
            <Icon name="EyeOff" aria-hidden="true" />
            Hide from rail
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function HiddenProjectsMenu({
  entries,
  onSelectScope,
  onShow,
}: {
  entries: readonly ProjectRailEntry[];
  onSelectScope: (scope: SidebarScope) => void;
  onShow: (projectIds: readonly string[]) => void;
}) {
  const isCompactViewport = useIsCompactViewport();
  const [isRestoreStep, setIsRestoreStep] = useState(false);

  const counts = useMemo(
    () => sumRailAttention(entries.map((entry) => entry.counts)),
    [entries],
  );

  const restoreItems = (
    <>
      {entries.map(({ project }) => (
        <DropdownMenuItem
          key={project.id}
          onSelect={() => onShow([project.id])}
        >
          {project.name}
        </DropdownMenuItem>
      ))}
      {entries.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => onShow(entries.map((entry) => entry.project.id))}
          >
            Show all
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open) setIsRestoreStep(false);
      }}
    >
      <DropdownMenuTrigger asChild>
        <RailTile
          name="Hidden projects"
          counts={counts}
          isSelected={false}
          isToggle={false}
          showsFresh={false}
          isQuiet={false}
          data-rail-hidden-projects=""
          face={
            <span className="grid size-full place-items-center text-xs font-semibold tabular-nums text-muted-foreground">
              {`+${entries.length}`}
            </span>
          }
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="right"
        align="end"
        sideOffset={12}
        mobileTitle="Hidden projects"
      >
        {isCompactViewport && isRestoreStep ? (
          <>
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setIsRestoreStep(false);
              }}
            >
              <Icon name="ChevronLeft" aria-hidden="true" />
              Back
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Show in rail</DropdownMenuLabel>
            {restoreItems}
          </>
        ) : (
          <>
            <DropdownMenuLabel>Hidden projects</DropdownMenuLabel>
            {entries.map(({ project, counts: projectCounts }) => {
              const badge = railAttentionBadgeCount(projectCounts);

              return (
                <DropdownMenuItem
                  key={project.id}
                  aria-label={railAttentionLabel(project.name, projectCounts)}
                  onSelect={() =>
                    onSelectScope({ kind: "project", projectId: project.id })
                  }
                >
                  <span
                    aria-hidden="true"
                    className="grid size-4 shrink-0 place-items-center overflow-hidden rounded-sm text-2xs font-bold"
                    style={monogramStyle(project.id)}
                  >
                    {project.kind === "personal" ? (
                      <Icon name="UserRound" className="size-3" />
                    ) : (
                      projectMonogram(project.name)
                    )}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {!projectCounts.hasRunningWork && projectCounts.unread > 0 ? (
                    <span
                      aria-hidden="true"
                      data-rail-hidden-project-unread=""
                      className="size-2 shrink-0 rounded-full bg-success"
                    />
                  ) : null}
                  {badge > 0 ? (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "rounded-full px-1.5 text-2xs font-bold tabular-nums",
                        projectCounts.failed > 0
                          ? "bg-destructive text-destructive-foreground"
                          : NEEDS_BADGE_CLASS,
                      )}
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  ) : null}
                </DropdownMenuItem>
              );
            })}
            <DropdownMenuSeparator />
            {isCompactViewport ? (
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  setIsRestoreStep(true);
                }}
              >
                <Icon name="Eye" aria-hidden="true" />
                <span className="flex-1">Show in rail</span>
                <Icon name="ChevronRight" aria-hidden="true" />
              </DropdownMenuItem>
            ) : (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Icon name="Eye" aria-hidden="true" />
                  Show in rail
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent aria-label="Show in rail">
                  {restoreItems}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AddProjectRailTile() {
  const quickCreateProject = useQuickCreateProjectController();

  return (
    <RailTile
      name={quickCreateProject.isCreating ? "Adding project…" : "Add project"}
      counts={EMPTY_RAIL_ATTENTION}
      isSelected={false}
      isToggle={false}
      showsFresh={false}
      isQuiet={false}
      disabled={
        !quickCreateProject.isAvailable || quickCreateProject.isCreating
      }
      data-rail-add-project=""
      className="disabled:opacity-50"
      onClick={quickCreateProject.openCreateDialog}
      face={
        <span className="grid size-full place-items-center text-subtle-foreground">
          <Icon name="Plus" aria-hidden="true" className="size-4" />
        </span>
      }
    />
  );
}

function useOrderedRailEntries(entries: readonly ProjectRailEntry[]) {
  const [optimisticOrder, setOptimisticOrder] = useState<
    readonly string[] | null
  >(null);

  const serverOrderKey = entries.map((entry) => entry.project.id).join("\n");

  useEffect(() => {
    setOptimisticOrder(null);
  }, [serverOrderKey]);

  const ordered = useMemo(() => {
    if (optimisticOrder === null) return entries;

    const byId = new Map(entries.map((entry) => [entry.project.id, entry]));
    const seen = new Set(optimisticOrder);

    return [
      ...optimisticOrder.flatMap((id) => byId.get(id) ?? []),
      ...entries.filter((entry) => !seen.has(entry.project.id)),
    ];
  }, [entries, optimisticOrder]);

  return { ordered, setOptimisticOrder };
}

function moveAnnouncement(
  name: string,
  order: readonly string[],
  visibleIds: ReadonlySet<string>,
  projectId: string,
): string {
  const visibleOrder = order.filter((id) => visibleIds.has(id));

  return `Moved ${name} to position ${visibleOrder.indexOf(projectId) + 1} of ${visibleOrder.length}`;
}

export const ProjectRailTiles = forwardRef<
  HTMLDivElement,
  {
    entries: readonly ProjectRailEntry[];
    scope: SidebarScope;
    currentProjectId: string | null;
    onSelectScope: (scope: SidebarScope) => void;
  }
>(({ entries, scope, currentProjectId, onSelectScope }, ref) => {
  const connectedHostIds = useConnectedHostIds();
  const shortcuts = useAppCommandShortcuts(RAIL_JUMP_APP_COMMAND_IDS);
  const { hiddenIds, hide, show } = useHiddenRailProjects();
  const reorderProject = useReorderProject();
  const { ordered, setOptimisticOrder } = useOrderedRailEntries(entries);
  const [announcement, setAnnouncement] = useState("");

  const { visible, hidden } = useMemo(
    () =>
      partitionRailEntries({
        entries: ordered,
        getId: (entry) => entry.project.id,
        hiddenIds,
        scope,
      }),
    [hiddenIds, ordered, scope],
  );

  const orderedProjectIds = useMemo(
    () => ordered.map((entry) => entry.project.id),
    [ordered],
  );

  const sortableIds = useMemo(
    () => visible.map((entry) => entry.project.id),
    [visible],
  );

  const reorder = (activeId: string, overId: string) => {
    if (reorderProject.isPending) return;
    const request = railProjectReorder(orderedProjectIds, activeId, overId);

    if (request === null) return;

    const name =
      entries.find((entry) => entry.project.id === activeId)?.project.name ??
      activeId;

    setOptimisticOrder(request.order);
    setAnnouncement(
      moveAnnouncement(name, request.order, new Set(sortableIds), activeId),
    );
    reorderProject.mutate(
      {
        id: activeId,
        previousProjectId: request.previousProjectId,
        nextProjectId: request.nextProjectId,
      },
      { onError: () => setOptimisticOrder(null) },
    );
  };

  const dnd = useSidebarReorderDnd({
    onDragEnd: ({ active, over }: DragEndEvent) => {
      if (typeof active.id === "string" && typeof over?.id === "string") {
        reorder(active.id, over.id);
      }
    },
    touchSensor: SidebarTouchSensor,
  });

  const arrangementOf = (entry: ProjectRailEntry): RailTileArrangement => {
    const projectId = entry.project.id;
    const isHidden = hiddenIds.has(projectId);
    const isSortable = !isHidden;
    const up = neighbourInDirection(sortableIds, projectId, "up");
    const down = neighbourInDirection(sortableIds, projectId, "down");

    return {
      canMoveUp: isSortable && up !== null,
      canMoveDown: isSortable && down !== null,
      onMove:
        isSortable && sortableIds.length > 1
          ? (direction) => {
              const overId = direction === "up" ? up : down;

              if (overId !== null) reorder(projectId, overId);
            }
          : null,
      isHidden,
      onHide: () => {
        hide(projectId);
        appToast.message(`${entry.project.name} hidden from rail`, {
          undo: () => show(projectId),
        });
      },
      onShow: () => show(projectId),
    };
  };

  const renderTile = (entry: ProjectRailEntry, index: number) => {
    const command = RAIL_JUMP_APP_COMMAND_IDS[index + 1];

    return (
      <ProjectRailTile
        key={entry.project.id}
        entry={entry}
        shortcut={command ? (shortcuts.get(command) ?? null) : null}
        command={command}
        isSelected={
          scope.kind === "project" && scope.projectId === entry.project.id
        }
        isCurrent={currentProjectId === entry.project.id}
        connectedHostIds={connectedHostIds}
        arrangement={arrangementOf(entry)}
        onSelectScope={onSelectScope}
      />
    );
  };

  return (
    <div
      ref={ref}
      role="group"
      aria-label="Projects"
      className="flex w-full flex-col items-center gap-2.5 pt-1.5 pb-3.5"
      onClickCapture={dnd.onClickCapture}
    >
      <DndContext {...dnd.dndContextProps}>
        <SortableContext
          items={sortableIds}
          strategy={verticalListSortingStrategy}
        >
          {visible.map(renderTile)}
        </SortableContext>
      </DndContext>
      {hidden.length > 0 ? (
        <HiddenProjectsMenu
          entries={hidden}
          onSelectScope={onSelectScope}
          onShow={(projectIds) => projectIds.forEach(show)}
        />
      ) : null}
      <AddProjectRailTile />
      <span role="status" data-rail-announcement="" className="sr-only">
        {announcement}
      </span>
    </div>
  );
});

ProjectRailTiles.displayName = "ProjectRailTiles";

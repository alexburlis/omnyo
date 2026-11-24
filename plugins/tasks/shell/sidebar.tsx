import { useMemo, useState, type ReactNode } from "react";
import type {
  Folder,
  Preset,
  Project,
  SidebarProjectSummary,
  Task,
} from "../shared/contract.js";
import { TaskWorkingDot } from "../components/working-dot.js";
import { useCollapsedSections } from "../shared/collapsed-sections.js";
import { useTasksRpc } from "./data.js";
import type { TasksRoute } from "./routes.js";
import {
  PresetDialog,
  savePresetDraft,
} from "../views/manage/preset-dialog.js";
import { Icon } from "@/components/ui/icon";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import {
  CONTROL_HOVER_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  getDisclosureRevealClass,
} from "@/components/ui/motion";
import { SECTION_COUNT_CLASS } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export const SIDEBAR_SECTIONS_SCOPE = "sidebar";

interface SidebarRowProps {
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  title?: string;
}

function SidebarRow({ active, onClick, children, title }: SidebarRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-sm max-md:pointer-coarse:h-9",
        "cursor-pointer",
        FOCUS_RING_CLASS,
        active
          ? "bg-sidebar-accent font-medium text-foreground"
          : "text-muted-foreground",
        !active && "hover:bg-state-hover hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function SidebarSection({
  label,
  count,
  countLabel,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  count?: number;
  countLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className="mt-3">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        title={open ? `Collapse ${label}` : `Show ${label}`}
        className={cn(
          "group/sidebar-section flex h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs font-semibold text-muted-foreground hover:bg-state-hover hover:text-foreground max-md:pointer-coarse:h-9",
          CONTROL_HOVER_TRANSITION,
          FOCUS_RING_CLASS,
        )}
      >
        <Icon
          name="ChevronRight"
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-subtle-foreground group-hover/sidebar-section:text-muted-foreground",
            DISCLOSURE_CHEVRON_TRANSITION,
            open && "rotate-90",
          )}
        />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {count === undefined ? null : (
          <span className={SECTION_COUNT_CLASS}>
            <span aria-hidden="true">{count}</span>
            {countLabel === undefined ? null : (
              <span className="sr-only">{countLabel}</span>
            )}
          </span>
        )}
      </button>
      <div
        aria-hidden={open ? undefined : true}
        inert={!open}
        className={getDisclosureRevealClass(open)}
      >
        <div className="-m-px min-h-0 space-y-px overflow-hidden p-px pt-0.5">
          {children}
        </div>
      </div>
    </section>
  );
}

function ProjectDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );
}

function RowCount({ value, label }: { value: number; label: string }) {
  return (
    <span
      title={label}
      className="ml-auto text-xs tabular-nums text-muted-foreground"
    >
      <span aria-hidden="true">{value}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

function taskCountLabel(count: number): string {
  return `${count} ${count === 1 ? "task" : "tasks"}, not counting sub-tasks`;
}

function ProjectRow({
  project,
  summary,
  active,
  onClick,
}: {
  project: Project;
  summary: SidebarProjectSummary | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarRow active={active} onClick={onClick} title={project.name}>
      <ProjectDot color={project.color} />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {summary !== undefined && summary.activeAgentCount > 0 ? (
        <span
          className="flex shrink-0"
          title={`${summary.activeAgentCount} ${summary.activeAgentCount === 1 ? "agent" : "agents"} working`}
        >
          <TaskWorkingDot />
          <span className="sr-only">
            {`${summary.activeAgentCount} ${summary.activeAgentCount === 1 ? "agent" : "agents"} working`}
          </span>
        </span>
      ) : null}
      {summary ? (
        <RowCount
          value={summary.taskCount}
          label={taskCountLabel(summary.taskCount)}
        />
      ) : null}
    </SidebarRow>
  );
}

function SidebarSkeleton() {
  return (
    <DelayedLoading>
      <div className="space-y-2 px-2 pt-2">
        {["w-3/4", "w-2/3", "w-4/5", "w-3/5", "w-2/3"].map((width, index) => (
          <div className="flex h-7 items-center gap-2 px-2" key={index}>
            <Skeleton className="size-3 rounded-sm" />
            <Skeleton className={cn("h-3", width)} />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

function SidebarPresetDialog({
  editing,
  onClose,
}: {
  editing: Preset | null;
  onClose: () => void;
}) {
  const rpc = useTasksRpc();

  return (
    <PresetDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      editing={editing}
      onSave={(draft) => savePresetDraft(rpc, editing, draft)}
    />
  );
}

interface TasksSidebarProps {
  route: TasksRoute;
  folders: Folder[] | undefined;
  projects: Project[] | undefined;
  summaries: SidebarProjectSummary[] | undefined;
  presets: Preset[] | undefined;
  activeTasks: Task[] | undefined;
  isLoading: boolean;
  onNavigate: (route: TasksRoute) => void;
  onNewProject: () => void;
}

export function TasksSidebar({
  route,
  folders,
  projects,
  summaries,
  presets,
  activeTasks,
  isLoading,
  onNavigate,
  onNewProject,
}: TasksSidebarProps) {
  const sections = useCollapsedSections(SIDEBAR_SECTIONS_SCOPE);

  const [presetDialog, setPresetDialog] = useState<{
    key: number;
    editing: Preset | null;
  } | null>(null);

  const summaryByProject = useMemo(
    () => new Map((summaries ?? []).map((entry) => [entry.projectId, entry])),
    [summaries],
  );

  const totalTasks = useMemo(
    () => (summaries ?? []).reduce((sum, entry) => sum + entry.taskCount, 0),
    [summaries],
  );

  const activeProjectId = route.kind === "project" ? route.projectId : null;

  const openProject = (projectId: string) =>
    onNavigate({ kind: "project", projectId, view: null });

  const rootFolders = (folders ?? []).filter((f) => f.parentFolderId === null);
  const childFolders = (folders ?? []).filter((f) => f.parentFolderId !== null);
  const knownFolderIds = new Set((folders ?? []).map((f) => f.id));

  const ungrouped = (projects ?? []).filter(
    (p) => p.folderId === null || !knownFolderIds.has(p.folderId),
  );

  const renderFolder = (folder: Folder, indent: boolean) => {
    const folderProjects = (projects ?? []).filter(
      (p) => p.folderId === folder.id,
    );

    const children = childFolders.filter((f) => f.parentFolderId === folder.id);

    return (
      <div key={folder.id} className={cn(indent && "pl-3")}>
        <SidebarSection
          label={folder.name}
          count={folderProjects.length}
          countLabel={`${folderProjects.length} ${folderProjects.length === 1 ? "project" : "projects"}`}
          open={sections.isOpen(`folder:${folder.id}`)}
          onOpenChange={(open) => sections.setOpen(`folder:${folder.id}`, open)}
        >
          {folderProjects.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              summary={summaryByProject.get(project.id)}
              active={activeProjectId === project.id}
              onClick={() => openProject(project.id)}
            />
          ))}
          {!indent ? children.map((child) => renderFolder(child, true)) : null}
        </SidebarSection>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-2">
        <div className="space-y-px">
          <SidebarRow
            active={route.kind === "all"}
            onClick={() => onNavigate({ kind: "all" })}
          >
            <Icon name="ListView" className="size-3.5 shrink-0" />
            <span className="flex-1">All tasks</span>
            {summaries ? (
              <RowCount value={totalTasks} label={taskCountLabel(totalTasks)} />
            ) : null}
          </SidebarRow>
          <SidebarRow
            active={route.kind === "active"}
            onClick={() => onNavigate({ kind: "active" })}
          >
            <Icon name="Zap" className="size-3.5 shrink-0" />
            <span className="flex-1">Active</span>
            {activeTasks && activeTasks.length > 0 ? <TaskWorkingDot /> : null}
            {activeTasks ? (
              <RowCount
                value={activeTasks.length}
                label={`${activeTasks.length} ${activeTasks.length === 1 ? "task has" : "tasks have"} an agent working`}
              />
            ) : null}
          </SidebarRow>
        </div>
        {isLoading ? (
          <SidebarSkeleton />
        ) : (
          <>
            {ungrouped.length > 0 ? (
              <SidebarSection
                label="Projects"
                count={ungrouped.length}
                countLabel={`${ungrouped.length} ${ungrouped.length === 1 ? "project" : "projects"}`}
                open={sections.isOpen("projects")}
                onOpenChange={(open) => sections.setOpen("projects", open)}
              >
                {ungrouped.map((project) => (
                  <ProjectRow
                    key={project.id}
                    project={project}
                    summary={summaryByProject.get(project.id)}
                    active={activeProjectId === project.id}
                    onClick={() => openProject(project.id)}
                  />
                ))}
              </SidebarSection>
            ) : null}
            {rootFolders.map((folder) => renderFolder(folder, false))}
            {(projects ?? []).length > 0 ? (
              <div className="mt-1.5">
                <SidebarRow onClick={onNewProject} title="New project">
                  <Icon name="Plus" className="size-3.5 shrink-0" />
                  <span className="flex-1">New project</span>
                </SidebarRow>
              </div>
            ) : null}
            {presets ? (
              <SidebarSection
                label="Agent presets"
                count={presets.length}
                countLabel={`${presets.length} ${presets.length === 1 ? "preset" : "presets"}`}
                open={sections.isOpen("presets")}
                onOpenChange={(open) => sections.setOpen("presets", open)}
              >
                {presets.map((preset) => (
                  <SidebarRow
                    key={preset.id}
                    title={`Edit preset ${preset.name}`}
                    onClick={() =>
                      setPresetDialog({ key: Date.now(), editing: preset })
                    }
                  >
                    <Icon name="Bot" className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">
                      {preset.name}
                    </span>
                    {preset.environmentKind === "new-worktree" ? (
                      <TooltipProvider delayDuration={300}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span
                              aria-label="Starts each agent in a new worktree"
                              className="flex shrink-0 text-subtle-foreground"
                            >
                              <Icon name="GitBranch" className="size-3" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left">
                            Starts each agent in a new worktree
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : null}
                  </SidebarRow>
                ))}
                {presets.length === 0 ? (
                  <p className="px-2 py-1 text-xs text-muted-foreground">
                    A preset picks the model and permissions an agent uses for a
                    task.
                  </p>
                ) : null}
                <SidebarRow
                  title="New preset"
                  onClick={() =>
                    setPresetDialog({ key: Date.now(), editing: null })
                  }
                >
                  <Icon name="Plus" className="size-3.5 shrink-0" />
                  <span className="flex-1">New preset</span>
                </SidebarRow>
              </SidebarSection>
            ) : null}
          </>
        )}
      </nav>
      <div className="shrink-0 border-t border-border-hairline px-2 py-1.5">
        <SidebarRow
          active={route.kind === "manage"}
          onClick={() => onNavigate({ kind: "manage" })}
        >
          <Icon name="Settings" className="size-3.5 shrink-0" />
          <span className="flex-1">Manage</span>
        </SidebarRow>
      </div>
      {presetDialog ? (
        <SidebarPresetDialog
          key={presetDialog.key}
          editing={presetDialog.editing}
          onClose={() => setPresetDialog(null)}
        />
      ) : null}
    </div>
  );
}

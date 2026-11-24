import { useState } from "react";
import type {
  Label,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  TaskThread,
} from "../../shared/contract.js";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../shared/contract.js";
import type { Preset } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import {
  PriorityIcon,
  StatusIcon,
  formatDueDate,
  isActiveThread,
} from "./meta.js";
import {
  DUE_DATE_PRESETS,
  dueUrgency,
  localIsoDate,
  PRIORITY_LABELS,
  STATUS_LABELS,
} from "../list/lib.js";
import { DispatchControl } from "./threads.js";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { StatusDot } from "@/components/ui/status-row";
import { DEFAULT_COLOR } from "../manage/shared.js";
import { OmnyoProjectLinkPicker } from "../manage/omnyo-project-link.js";
import type { OmnyoProjectOption } from "../../shared/contract.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export interface TaskPropertyUpdate {
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: string | null;
  labelIds?: string[];
}

interface TaskPropertiesProps {
  task: Task;
  project: Project | undefined;
  projects: Project[] | undefined;
  labels: Label[] | undefined;
  threads: TaskThread[];
  onUpdate: (update: TaskPropertyUpdate) => void;
  onMoveToProject: (projectId: string) => void;
}

function LabelChip({ label }: { label: Label }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground">
      <span
        aria-hidden
        className="size-1.5 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      {label.name}
    </span>
  );
}

function StatusMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <StatusIcon status={task.status} />
          {STATUS_LABELS[task.status]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_STATUSES.map((status) => (
          <DropdownMenuItem key={status} onSelect={() => onUpdate({ status })}>
            <StatusIcon status={status} />
            {STATUS_LABELS[status]}
            {status === task.status ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PriorityMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={triggerClassName}>
          <PriorityIcon priority={task.priority} />
          {PRIORITY_LABELS[task.priority]}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {TASK_PRIORITIES.map((priority) => (
          <DropdownMenuItem
            key={priority}
            onSelect={() => onUpdate({ priority })}
          >
            <PriorityIcon priority={priority} />
            {PRIORITY_LABELS[priority]}
            {priority === task.priority ? (
              <Icon name="Check" className="ml-auto size-3.5" />
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DueDateMenu({
  task,
  onUpdate,
  triggerClassName,
}: {
  task: Task;
  onUpdate: (update: TaskPropertyUpdate) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);

  const urgency =
    task.dueDate === null ? null : dueUrgency(task.dueDate, task.status);

  const pick = (dueDate: string | null) => {
    onUpdate({ dueDate });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            triggerClassName,
            urgency === "overdue" && "text-destructive-text",
            task.dueDate === null && "text-muted-foreground",
          )}
        >
          <Icon
            name={urgency === "overdue" ? "AlertCircle" : "Clock"}
            className="size-3.5 shrink-0"
          />
          {task.dueDate === null
            ? "Set due date"
            : urgency === "overdue"
              ? `Overdue · ${formatDueDate(task.dueDate)}`
              : urgency === "today"
                ? "Today"
                : formatDueDate(task.dueDate)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-2">
        <div className="flex flex-col">
          {DUE_DATE_PRESETS.map(([label, days]) => (
            <button
              key={label}
              type="button"
              className="flex items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(localIsoDate(days))}
            >
              {label}
              <span className="text-xs text-muted-foreground">
                {formatDueDate(localIsoDate(days))}
              </span>
            </button>
          ))}
          <input
            type="date"
            aria-label="Due date"
            className="mt-1 h-7 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
            value={task.dueDate ?? ""}
            onChange={(event) => {
              if (event.target.value) pick(event.target.value);
            }}
          />
          {task.dueDate ? (
            <button
              type="button"
              className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => pick(null)}
            >
              <Icon name="X" className="size-3.5" />
              Remove due date
            </button>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function LabelsMenu({
  task,
  labels,
  onUpdate,
  children,
}: {
  task: Task;
  labels: Label[] | undefined;
  onUpdate: (update: TaskPropertyUpdate) => void;
  children: React.ReactNode;
}) {
  const rpc = useTasksRpc();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  const toggle = (labelId: string) => {
    const next = task.labelIds.includes(labelId)
      ? task.labelIds.filter((id) => id !== labelId)
      : [...task.labelIds, labelId];

    onUpdate({ labelIds: next });
  };

  const createLabel = async (name: string) => {
    if (!name || creating) return;
    setCreating(true);

    try {
      const { label } = await rpc.call("createLabel", {
        projectId: task.projectId,
        name,
        color: DEFAULT_COLOR,
      });

      onUpdate({ labelIds: [...task.labelIds, label.id] });
      setQuery("");
    } finally {
      setCreating(false);
    }
  };

  const labelList = labels ?? [];

  return (
    <Popover onOpenChange={(open) => open || setQuery("")}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput
            placeholder="Add labels…"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty
              className={query.trim() !== "" ? "p-1 text-left" : undefined}
            >
              {query.trim() !== "" ? (
                <button
                  type="button"
                  disabled={creating}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void createLabel(query.trim())}
                >
                  <Icon name="Plus" className="size-3.5" />
                  Create “{query.trim()}”
                </button>
              ) : (
                "No labels in this project."
              )}
            </CommandEmpty>
            {labels !== undefined && labelList.length === 0 ? (
              <CommandGroup>
                <CommandItem
                  disabled={creating}
                  onSelect={() => {
                    const name = query.trim();

                    if (name) void createLabel(name);
                  }}
                >
                  <Icon name="Plus" className="size-3.5" />
                  New label{query.trim() ? ` “${query.trim()}”` : "…"}
                </CommandItem>
              </CommandGroup>
            ) : null}
            {labelList.length > 0 ? (
              <CommandGroup>
                {labelList.map((label) => (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => toggle(label.id)}
                  >
                    <span
                      aria-hidden
                      className="size-2.5 rounded-full"
                      style={{ backgroundColor: label.color }}
                    />
                    <span className="flex-1">{label.name}</span>
                    {task.labelIds.includes(label.id) ? (
                      <Icon name="Check" className="size-3.5" />
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function ProjectSwatch({ project }: { project: Project | undefined }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-sm"
      style={{ backgroundColor: project?.color }}
    />
  );
}

function ProjectMenu({
  task,
  project,
  projects,
  onMoveToProject,
  triggerClassName,
}: {
  task: Task;
  project: Project | undefined;
  projects: Project[] | undefined;
  onMoveToProject: (projectId: string) => void;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Move to project"
          className={triggerClassName}
        >
          <ProjectSwatch project={project} />
          <span className="truncate">{project?.name ?? "…"}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <Command>
          <CommandInput placeholder="Move to project…" />
          <CommandList>
            <CommandEmpty>No matching projects.</CommandEmpty>
            <CommandGroup>
              {(projects ?? []).map((candidate) => (
                <CommandItem
                  key={candidate.id}
                  value={`${candidate.name} ${candidate.prefix}`}
                  onSelect={() => {
                    setOpen(false);

                    if (candidate.id !== task.projectId) {
                      onMoveToProject(candidate.id);
                    }
                  }}
                >
                  <ProjectSwatch project={candidate} />
                  <span className="flex-1 truncate">{candidate.name}</span>
                  {candidate.id === task.projectId ? (
                    <Icon name="Check" className="size-3.5" />
                  ) : (
                    <span className="text-2xs text-muted-foreground">
                      {candidate.prefix}
                    </span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function DispatchTargetMenu({
  project,
  omnyoProjects,
  onError,
  triggerClassName,
}: {
  project: Project;
  omnyoProjects: readonly OmnyoProjectOption[];
  onError: (message: string) => void;
  triggerClassName: string;
}) {
  const rpc = useTasksRpc();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const linkedAppProjectId = project.linkedAppProjectId;

  const linkedName = omnyoProjects.find(
    (candidate) => candidate.id === linkedAppProjectId,
  )?.name;

  const save = async (linkedId: string | null) => {
    if (saving) return;
    setSaving(true);

    try {
      await rpc.call("updateProject", {
        projectId: project.id,
        linkedAppProjectId: linkedId,
      });
      setOpen(false);
    } catch (saveError) {
      onError(errorMessage(saveError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setSelection(linkedAppProjectId);
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Change where agents start"
          title="The Omnyo project where new agent chats for this task start"
          className={triggerClassName}
        >
          <Icon
            name="Folder"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          {linkedAppProjectId !== null ? (
            <span className="truncate">{linkedName ?? linkedAppProjectId}</span>
          ) : (
            <span className="truncate text-muted-foreground">
              Choose a project…
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-3">
        <OmnyoProjectLinkPicker
          value={selection}
          onChange={setSelection}
          omnyoProjects={omnyoProjects}
          noneLabel={linkedAppProjectId !== null ? "Unlink" : "Not linked"}
        />
        <div className="mt-2.5 flex items-center justify-between gap-2">
          {linkedAppProjectId !== null ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground"
              disabled={saving}
              onClick={() => void save(null)}
            >
              <Icon name="X" className="size-3.5" />
              Unlink
            </Button>
          ) : (
            <span />
          )}
          <Button
            size="sm"
            className="h-7"
            disabled={saving}
            onClick={() => void save(selection)}
          >
            Save
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const RAIL_ROW_CLASS = cn(
  "flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left text-sm hover:bg-state-hover",
  FOCUS_RING_CLASS,
);

export function PropertiesRail({
  task,
  project,
  projects,
  labels,
  threads,
  presets,
  onUpdate,
  onMoveToProject,
  onError,
  className,
}: TaskPropertiesProps & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );

  const active = threads.filter(isActiveThread);

  const omnyoProjects = useTasksQuery(
    async (query) => (await query.call("listAppProjects")).appProjects,
    ["projects:changed"],
  );

  return (
    <aside
      aria-label="Task properties"
      className={cn("w-64 shrink-0 py-10 pl-2 pr-6", className)}
    >
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">
        Properties
      </h2>
      <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-1 gap-y-0.5">
        <RailField label="Status">
          <StatusMenu
            task={task}
            onUpdate={onUpdate}
            triggerClassName={RAIL_ROW_CLASS}
          />
        </RailField>
        <RailField label="Priority">
          <PriorityMenu
            task={task}
            onUpdate={onUpdate}
            triggerClassName={RAIL_ROW_CLASS}
          />
        </RailField>
        <RailField label="Due date">
          <DueDateMenu
            task={task}
            onUpdate={onUpdate}
            triggerClassName={RAIL_ROW_CLASS}
          />
        </RailField>
        <RailField label="Project">
          <ProjectMenu
            task={task}
            project={project}
            projects={projects}
            onMoveToProject={onMoveToProject}
            triggerClassName={RAIL_ROW_CLASS}
          />
        </RailField>
        <RailField label="Labels" alignTop>
          <div className="flex min-h-7 flex-wrap items-center gap-1 px-1.5 py-1">
            {taskLabels.map((label) => (
              <LabelChip key={label.id} label={label} />
            ))}
            <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
              <button
                type="button"
                aria-label="Edit labels"
                title="Add or remove labels"
                className={cn(
                  "inline-flex h-5 items-center gap-1 rounded-md border border-dashed border-border px-1.5 text-2xs text-muted-foreground hover:border-input hover:text-foreground",
                  FOCUS_RING_CLASS,
                )}
              >
                <Icon name="Plus" className="size-3" />
                {taskLabels.length === 0 ? "Add" : null}
              </button>
            </LabelsMenu>
          </div>
        </RailField>
      </dl>

      <div className="mt-5 border-t border-border-hairline pt-4">
        <h2 className="text-xs font-semibold text-muted-foreground">Agents</h2>
        <p className="mb-2 mt-0.5 text-xs text-subtle-foreground">
          Start an agent chat that works on this task.
        </p>
        <dl className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-center gap-x-1">
          <RailField label="Starts in">
            {project !== undefined ? (
              <DispatchTargetMenu
                project={project}
                omnyoProjects={omnyoProjects.data ?? []}
                onError={onError}
                triggerClassName={RAIL_ROW_CLASS}
              />
            ) : (
              <span className="px-1.5 text-sm text-muted-foreground">…</span>
            )}
          </RailField>
        </dl>
        <div className="mt-2">
          <DispatchControl
            taskId={task.id}
            presets={presets}
            onError={onError}
            align="start"
            className="w-full"
          />
        </div>
        <div className="mt-3 flex flex-col gap-1.5 text-xs">
          {active.length > 0 ? (
            active.map((thread) => (
              <span
                key={thread.id}
                className="flex min-w-0 items-center gap-2 text-foreground"
              >
                <StatusDot
                  tone={thread.liveStatus === "starting" ? "pending" : "active"}
                />
                <span className="min-w-0 truncate font-medium">
                  {thread.presetName}
                </span>
                <span className="shrink-0 text-muted-foreground">
                  {thread.liveStatus === "starting" ? "starting" : "working"}
                </span>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">
              No agent is working on this task.
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

function RailField({
  label,
  alignTop = false,
  children,
}: {
  label: string;
  alignTop?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt
        className={cn(
          "text-xs text-muted-foreground",
          alignTop && "self-start pt-1.5",
        )}
      >
        {label}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

const CHIP_CLASS =
  "inline-flex items-center gap-1.5 rounded-md border border-border bg-secondary px-2.5 py-0.5 text-xs text-foreground hover:border-input";

export function InlineProperties({
  task,
  project,
  projects,
  labels,
  presets,
  onUpdate,
  onMoveToProject,
  onError,
  className,
}: Omit<TaskPropertiesProps, "threads"> & {
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  className?: string;
}) {
  const taskLabels = (labels ?? []).filter((label) =>
    task.labelIds.includes(label.id),
  );

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <ProjectMenu
        task={task}
        project={project}
        projects={projects}
        onMoveToProject={onMoveToProject}
        triggerClassName={CHIP_CLASS}
      />
      <StatusMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      <PriorityMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      <DueDateMenu
        task={task}
        onUpdate={onUpdate}
        triggerClassName={CHIP_CLASS}
      />
      {taskLabels.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      <LabelsMenu task={task} labels={labels} onUpdate={onUpdate}>
        <button
          type="button"
          aria-label="Edit labels"
          className="inline-flex items-center rounded-md border border-dashed border-border px-2 py-1 text-muted-foreground hover:border-input hover:text-foreground"
        >
          <Icon name="Plus" className="size-3" />
        </button>
      </LabelsMenu>
      <DispatchControl
        taskId={task.id}
        presets={presets}
        onError={onError}
        className="ml-auto max-w-56"
      />
    </div>
  );
}

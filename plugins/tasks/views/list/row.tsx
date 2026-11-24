import { memo, useState, type CSSProperties } from "react";
import type {
  Label,
  Project,
  Task,
  TaskThread,
} from "../../shared/contract.js";
import { TaskWorkingDot } from "../../components/working-dot.js";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { TaskRowMeta } from "./data.js";
import {
  activeWorkLabel,
  dueUrgency,
  formatDueDate,
  partitionLabels,
  type DueUrgency,
} from "./lib.js";
import type { EditFn } from "./property-menus.js";
import {
  isBareKey,
  PriorityEditor,
  StatusEditor,
  TaskContextMenu,
} from "./property-menus.js";

const RAIL_CHIP_CLASS =
  "flex items-center gap-1 rounded-md border border-border px-1.5 py-px text-xs text-muted-foreground";

function ActiveChip({ threads }: { threads: readonly TaskThread[] }) {
  if (threads.length === 0) return null;

  return (
    <span title={activeWorkLabel(threads)} className={RAIL_CHIP_CLASS}>
      <TaskWorkingDot />
      Active
    </span>
  );
}

const DUE_CHIP_CLASS: Record<DueUrgency, string> = {
  overdue:
    "border-surface-destructive-border bg-surface-destructive text-destructive-text",
  today: "border-transparent bg-surface-attention text-foreground",
  upcoming: "",
};

const DUE_PREFIX: Record<DueUrgency, string | null> = {
  overdue: "Overdue",
  today: "Due today",
  upcoming: null,
};

export function DueChip({ task, dueDate }: { task: Task; dueDate: string }) {
  const urgency = dueUrgency(dueDate, task.status);
  const prefix = DUE_PREFIX[urgency];
  const date = formatDueDate(dueDate);

  return (
    <span
      title={prefix === null ? `Due ${date}` : `${prefix} · ${date}`}
      className={cn(
        RAIL_CHIP_CLASS,
        "shrink-0 tabular-nums",
        DUE_CHIP_CLASS[urgency],
      )}
    >
      <Icon
        name={urgency === "overdue" ? "AlertCircle" : "Clock"}
        className="size-3 shrink-0"
      />
      {prefix === null ? null : (
        <span className="hidden @2xl:inline">{prefix} ·</span>
      )}
      {date}
    </span>
  );
}

function ProjectChip({ project }: { project: Project }) {
  return (
    <span
      title={project.name}
      className="flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-sm"
        style={{ backgroundColor: project.color }}
      />
      <span className="sr-only @3xl:not-sr-only @3xl:max-w-28 @3xl:truncate">
        {project.name}
      </span>
    </span>
  );
}

function LabelChip({ label }: { label: Label }) {
  return (
    <span className={`${RAIL_CHIP_CLASS} max-w-32`}>
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: label.color }}
      />
      <span className="truncate">{label.name}</span>
    </span>
  );
}

function LabelChipRow({
  labels,
  maxVisible,
}: {
  labels: readonly Label[];
  maxVisible: number;
}) {
  const { visible, hidden } = partitionLabels(labels, maxVisible);

  return (
    <>
      {visible.map((label) => (
        <LabelChip key={label.id} label={label} />
      ))}
      {hidden.length > 0 ? (
        <span
          title={hidden.map((label) => label.name).join(", ")}
          className={`${RAIL_CHIP_CLASS} tabular-nums`}
        >
          +{hidden.length}
        </span>
      ) : null}
    </>
  );
}

function LabelChips({
  task,
  labelsById,
}: {
  task: Task;
  labelsById: Map<string, Label>;
}) {
  const labels = task.labelIds.flatMap((id) => labelsById.get(id) ?? []);

  if (labels.length === 0) return null;

  return (
    <>
      <span className="hidden items-center gap-1.5 @xl:flex">
        <LabelChipRow labels={labels} maxVisible={2} />
      </span>
      <span className="flex items-center gap-1.5 @xl:hidden">
        <LabelChipRow labels={labels} maxVisible={1} />
      </span>
    </>
  );
}

interface TaskRowProps {
  task: Task;
  meta: TaskRowMeta | undefined;
  project: Project | undefined;
  showProject: boolean;
  labelsById: Map<string, Label>;
  projectLabels: readonly Label[];
  projects: readonly Project[];
  onEdit: EditFn;
  onMoveToProject: (task: Task, projectId: string) => void;
  onOpen: (taskKey: string) => void;
  pending: boolean;
  className?: string;
  style?: CSSProperties;
}

export const TaskRow = memo(function TaskRow({
  task,
  meta,
  project,
  showProject,
  labelsById,
  projectLabels,
  projects,
  onEdit,
  onMoveToProject,
  onOpen,
  pending,
  className,
  style,
}: TaskRowProps) {
  const [openMenu, setOpenMenu] = useState<"status" | "priority" | null>(null);

  return (
    <TaskContextMenu
      task={task}
      onEdit={onEdit}
      projectLabels={projectLabels}
      projects={projects}
      onMoveToProject={onMoveToProject}
    >
      <div
        data-task-key={task.key}
        aria-busy={pending || undefined}
        className={cn(
          "relative grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 border-b border-border-hairline px-3.5 py-1.5 text-left transition-opacity hover:bg-state-hover",
          "@md:flex @md:h-[34px] @md:py-0",
          pending && "opacity-70",
          className,
        )}
        style={style}
      >
        <button
          type="button"
          aria-label={`Open ${task.key}: ${task.title}`}
          onClick={() => onOpen(task.key)}
          onKeyDown={(event) => {
            if (!isBareKey(event)) return;
            const key = event.key.toLowerCase();

            if (key === "s") {
              event.preventDefault();
              setOpenMenu("status");
            } else if (key === "p") {
              event.preventDefault();
              setOpenMenu("priority");
            }
          }}
          className="absolute inset-0 rounded-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        />
        <PriorityEditor
          task={task}
          onEdit={onEdit}
          open={openMenu === "priority"}
          onOpenChange={(next) => setOpenMenu(next ? "priority" : null)}
          className="col-start-1 row-start-2"
        />
        <span className="col-start-2 row-start-2 min-w-0 truncate text-xs tabular-nums text-subtle-foreground @max-md:max-w-32 @md:w-14 @md:shrink-0">
          {task.key}
        </span>
        <StatusEditor
          task={task}
          onEdit={onEdit}
          open={openMenu === "status"}
          onOpenChange={(next) => setOpenMenu(next ? "status" : null)}
          className="col-start-1 row-start-1"
        />
        <span className="col-start-2 col-span-2 row-start-1 min-w-0 truncate text-sm @md:flex-1">
          {task.title}
        </span>
        <span className="col-start-3 row-start-2 flex min-w-0 items-center gap-1.5 justify-self-end text-xs text-subtle-foreground @max-md:overflow-hidden @md:shrink-0">
          {meta ? <ActiveChip threads={meta.activeThreads} /> : null}
          <LabelChips task={task} labelsById={labelsById} />
          {task.dueDate !== null ? (
            <DueChip task={task} dueDate={task.dueDate} />
          ) : null}
          {showProject && project !== undefined ? (
            <ProjectChip project={project} />
          ) : null}
        </span>
      </div>
    </TaskContextMenu>
  );
});

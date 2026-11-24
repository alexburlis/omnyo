import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  type Label,
  type Task,
  type TaskStatus,
  type TaskThread,
} from "../../shared/contract.js";
import {
  listAllTasks,
  signalTaskIds,
  useTasksQuery,
  type TaskSignal,
  useTasksRpc,
  type TasksRpc,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { NewTaskDialog } from "../manage/new-task-dialog.js";
import {
  applyBoardMove,
  BOARD_STATUSES,
  dropIndexForPointer,
  dropNeighborsForIndex,
  visibleBoardStatuses,
} from "./drop-position.js";
import { PriorityIcon, StatusIcon } from "./icons.js";
import { isActiveThread } from "../detail/meta.js";
import { PRIORITY_LABELS, STATUS_LABELS } from "../list/lib.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Icon, type IconName } from "@/components/ui/icon";
import { SECTION_COUNT_CLASS } from "@/components/ui/section-header";
import { Skeleton } from "@/components/ui/skeleton";
import { TaskWorkingDot } from "../../components/working-dot.js";
import { EmptyState } from "../../components/empty-state.js";
import { Hint } from "../../components/hint.js";
import { DueChip } from "../list/row.js";
import { cn } from "@/lib/utils";

const DRAG_THRESHOLD_PX = 5;

function CardMeta({
  icon,
  label,
  description,
}: {
  icon: IconName;
  label: string;
  description: string;
}) {
  return (
    <span
      title={description}
      className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full bg-state-hover px-1.5 text-2xs font-medium tabular-nums text-muted-foreground"
    >
      <Icon name={icon} aria-hidden="true" className="size-3 shrink-0" />
      <span aria-hidden="true">{label}</span>
      <span className="sr-only">{description}</span>
    </span>
  );
}

interface BoardCardMeta {
  workingThreads: TaskThread[];
  attachmentCount: number;
  subDone: number;
  subTotal: number;
}

interface BoardData {
  tasks: Task[];
  subtasks: Task[];
  labelsById: Map<string, Label>;
  metaByTaskId: Map<string, BoardCardMeta>;
}

const EMPTY_META: BoardCardMeta = {
  workingThreads: [],
  attachmentCount: 0,
  subDone: 0,
  subTotal: 0,
};

async function fetchBoard(
  rpc: TasksRpc,
  projectId: string,
): Promise<BoardData> {
  const tasks = await listAllTasks(rpc, { projectId });
  const topLevel = tasks.filter((task) => task.parentTaskId === null);

  const labels = await rpc.call("listLabels", { projectId }).then(
    (result) => result.labels,
    () => [],
  );

  const subProgress = new Map<string, { done: number; total: number }>();

  for (const task of tasks) {
    if (task.parentTaskId === null) continue;
    const entry = subProgress.get(task.parentTaskId) ?? { done: 0, total: 0 };
    entry.total += 1;

    if (task.status === "done") entry.done += 1;
    subProgress.set(task.parentTaskId, entry);
  }

  const activeTaskIds = await listAllTasks(rpc, {
    projectId,
    activeOnly: true,
  }).then(
    (result) => new Set(result.map((task) => task.id)),
    () => new Set<string>(),
  );

  const workingByTaskId = new Map<string, TaskThread[]>();
  await Promise.all(
    topLevel
      .filter((task) => activeTaskIds.has(task.id))
      .map(async (task) => {
        const threads = await rpc
          .call("listTaskThreads", { taskId: task.id })
          .then(
            (result) => result.taskThreads,
            () => [],
          );

        workingByTaskId.set(task.id, threads.filter(isActiveThread));
      }),
  );
  const attachmentCounts = new Map<string, number>();
  await Promise.all(
    topLevel.map(async (task) => {
      const count = await rpc.call("listAttachments", { taskId: task.id }).then(
        (result) => result.attachments.length,
        () => 0,
      );

      attachmentCounts.set(task.id, count);
    }),
  );

  return {
    tasks: topLevel,
    subtasks: tasks.filter((task) => task.parentTaskId !== null),
    labelsById: new Map(labels.map((label) => [label.id, label])),
    metaByTaskId: new Map(
      topLevel.map((task) => [
        task.id,
        {
          workingThreads: workingByTaskId.get(task.id) ?? [],
          attachmentCount: attachmentCounts.get(task.id) ?? 0,
          subDone: subProgress.get(task.id)?.done ?? 0,
          subTotal: subProgress.get(task.id)?.total ?? 0,
        },
      ]),
    ),
  };
}

async function workingThreadsFor(
  rpc: TasksRpc,
  taskId: string,
): Promise<TaskThread[]> {
  return rpc.call("listTaskThreads", { taskId }).then(
    (result) => result.taskThreads.filter(isActiveThread),
    () => [],
  );
}

async function patchBoard(
  rpc: TasksRpc,
  projectId: string,
  current: BoardData,
  signals: readonly TaskSignal[],
): Promise<BoardData | null> {
  if (signals.some((signal) => signal.channel === "projects:changed")) {
    return null;
  }

  const changedIds = signalTaskIds(signals, "tasks:changed");

  const fetched = await Promise.all(
    changedIds.map(async (taskId) => {
      const { task } = await rpc.call("getTask", { taskId });

      return [taskId, task] as const;
    }),
  );

  const changed = new Map(fetched);
  const keep = (task: Task) => !changed.has(task.id);
  const tasks = current.tasks.filter(keep);
  const subtasks = current.subtasks.filter(keep);
  const metaByTaskId = new Map(current.metaByTaskId);

  for (const taskId of changed.keys()) metaByTaskId.delete(taskId);
  const refreshedCards: Task[] = [];

  for (const task of changed.values()) {
    if (task === null || task.projectId !== projectId) continue;

    if (task.parentTaskId === null) {
      tasks.push(task);
      refreshedCards.push(task);
    } else {
      subtasks.push(task);
    }
  }

  const topLevelIds = new Set(tasks.map((task) => task.id));

  const threadIds = signalTaskIds(signals, "threads:changed").filter(
    (taskId) => topLevelIds.has(taskId) && !changed.has(taskId),
  );

  await Promise.all([
    ...refreshedCards.map(async (task) => {
      const [workingThreads, attachmentCount] = await Promise.all([
        workingThreadsFor(rpc, task.id),
        rpc.call("listAttachments", { taskId: task.id }).then(
          (result) => result.attachments.length,
          () => 0,
        ),
      ]);

      metaByTaskId.set(task.id, {
        ...EMPTY_META,
        workingThreads,
        attachmentCount,
      });
    }),
    ...threadIds.map(async (taskId) => {
      const workingThreads = await workingThreadsFor(rpc, taskId);
      metaByTaskId.set(taskId, {
        ...(metaByTaskId.get(taskId) ?? EMPTY_META),
        workingThreads,
      });
    }),
  ]);
  const progress = new Map<string, { done: number; total: number }>();

  for (const task of subtasks) {
    if (task.parentTaskId === null) continue;
    const entry = progress.get(task.parentTaskId) ?? { done: 0, total: 0 };
    entry.total += 1;

    if (task.status === "done") entry.done += 1;
    progress.set(task.parentTaskId, entry);
  }

  for (const task of tasks) {
    const meta = metaByTaskId.get(task.id) ?? EMPTY_META;
    const entry = progress.get(task.id);
    metaByTaskId.set(task.id, {
      ...meta,
      subDone: entry?.done ?? 0,
      subTotal: entry?.total ?? 0,
    });
  }

  tasks.sort(
    (a, b) =>
      a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  return { ...current, tasks, subtasks, metaByTaskId };
}

type ColumnMap = Record<TaskStatus, Task[]>;

function groupColumns(tasks: readonly Task[]): ColumnMap {
  const columns: ColumnMap = {
    backlog: [],
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
    canceled: [],
  };

  for (const task of tasks) columns[task.status].push(task);

  return columns;
}

interface DragState {
  taskId: string;
  width: number;
  overStatus: TaskStatus | null;
  dropIndex: number;
}

function WorkingAgentsChip({ threads }: { threads: TaskThread[] }) {
  if (threads.length === 0) return null;

  return (
    <span className="flex min-w-0 items-center gap-1 font-medium text-success">
      <TaskWorkingDot />
      <span className="truncate">
        {threads.length === 1
          ? threads[0]!.presetName
          : `${threads.length} agents`}
      </span>
    </span>
  );
}

interface TaskCardProps {
  task: Task;
  labelsById: Map<string, Label>;
  meta: BoardCardMeta;
  ghost?: boolean;
  dragging?: boolean;
  cardRef?: (element: HTMLDivElement | null) => void;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClick?: () => void;
}

function TaskCard({
  task,
  labelsById,
  meta,
  ghost = false,
  dragging = false,
  cardRef,
  onPointerDown,
  onClick,
}: TaskCardProps) {
  const labels = task.labelIds
    .map((labelId) => labelsById.get(labelId))
    .filter((label): label is Label => label !== undefined);

  return (
    <div
      ref={cardRef}
      data-task-key={task.key}
      role={onClick === undefined ? undefined : "button"}
      tabIndex={onClick === undefined ? undefined : 0}
      aria-label={
        onClick === undefined ? undefined : `Open ${task.key}: ${task.title}`
      }
      onPointerDown={onPointerDown}
      onClick={onClick}
      onKeyDown={(event) => {
        if (onClick === undefined || event.target !== event.currentTarget) {
          return;
        }

        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "shrink-0 rounded-lg border border-border bg-card px-2.5 py-2 shadow-2xs select-none",
        "transition-opacity duration-(--motion-duration-fast)",
        ghost
          ? "scale-[1.02] animate-in shadow-md ease-out zoom-in-[0.98]"
          : "cursor-pointer touch-none hover:border-input",
        !ghost && FOCUS_RING_CLASS,
        dragging && "opacity-40",
      )}
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="tabular-nums">{task.key}</span>
        <WorkingAgentsChip threads={meta.workingThreads} />
      </div>
      <div className="mt-1 line-clamp-2 text-sm leading-snug font-medium">
        {task.title}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 empty:hidden">
        {task.priority === "none" ? null : (
          <span
            className="flex shrink-0"
            title={`${PRIORITY_LABELS[task.priority]} priority`}
          >
            <PriorityIcon priority={task.priority} />
            <span className="sr-only">
              {PRIORITY_LABELS[task.priority]} priority
            </span>
          </span>
        )}
        {labels.map((label) => (
          <span
            key={label.id}
            className="flex items-center gap-1 rounded-md border border-border px-1.5 text-2xs text-muted-foreground"
          >
            <span
              aria-hidden
              className="size-1.5 rounded-full"
              style={{ backgroundColor: label.color }}
            />
            {label.name}
          </span>
        ))}
        {task.dueDate === null ? null : (
          <DueChip task={task} dueDate={task.dueDate} />
        )}
        {meta.subTotal > 0 ? (
          <CardMeta
            icon="CircleCheck"
            label={`${meta.subDone}/${meta.subTotal}`}
            description={`${meta.subDone} of ${meta.subTotal} sub-tasks done`}
          />
        ) : null}
        {meta.attachmentCount > 0 ? (
          <CardMeta
            icon="Paperclip"
            label={String(meta.attachmentCount)}
            description={`${meta.attachmentCount} ${meta.attachmentCount === 1 ? "attachment" : "attachments"}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function EmptyColumn({ dropTarget }: { dropTarget: boolean }) {
  return (
    <div
      className={cn(
        "flex h-16 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-subtle-foreground",
        dropTarget ? "border-transparent" : "border-border",
      )}
    >
      {dropTarget ? "Drop to move here" : "No tasks"}
    </div>
  );
}

function BoardSkeleton() {
  return (
    <DelayedLoading>
      <div className="flex h-full items-start gap-3 overflow-x-auto p-4">
        {BOARD_STATUSES.map((status) => (
          <div
            key={status}
            className="flex w-[230px] shrink-0 flex-col gap-2 p-1"
          >
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-20 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ))}
      </div>
    </DelayedLoading>
  );
}

interface BoardViewProps {
  projectId: string;
}

export function BoardView({ projectId }: BoardViewProps) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();

  const board = useTasksQuery<BoardData>(
    (queryRpc) => fetchBoard(queryRpc, projectId),
    ["tasks:changed", "projects:changed", "threads:changed"],
    [projectId],
    {
      applySignals: (queryRpc, current, signals) =>
        patchBoard(queryRpc, projectId, current, signals),
    },
  );

  const [columns, setColumns] = useState<ColumnMap | undefined>(undefined);
  useEffect(() => {
    setColumns(undefined);
  }, [projectId]);
  useEffect(() => {
    if (board.data) setColumns(groupColumns(board.data.tasks));
  }, [board.data]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  const [drag, setDrag] = useState<DragState | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const ghostPositionRef = useRef({ x: 0, y: 0 });
  const ghostFrameRef = useRef<number | null>(null);
  const [quickAddStatus, setQuickAddStatus] = useState<TaskStatus | null>(null);
  const boardRef = useRef<HTMLDivElement | null>(null);
  const columnRefs = useRef(new Map<TaskStatus, HTMLDivElement>());
  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const suppressClickRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      dragCleanupRef.current?.();

      if (ghostFrameRef.current !== null) {
        cancelAnimationFrame(ghostFrameRef.current);
      }
    },
    [],
  );

  const writeGhostPosition = () => {
    const element = ghostRef.current;

    if (!element) return;
    const { x, y } = ghostPositionRef.current;

    element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  };

  const scheduleGhostPosition = () => {
    if (ghostFrameRef.current !== null) return;

    ghostFrameRef.current = requestAnimationFrame(() => {
      ghostFrameRef.current = null;
      writeGhostPosition();
    });
  };

  const findDropTarget = (
    x: number,
    y: number,
    draggedTaskId: string,
  ): { status: TaskStatus; index: number } | null => {
    const current = columnsRef.current;

    if (!current) return null;
    const boardRect = boardRef.current?.getBoundingClientRect();

    if (
      boardRect &&
      (y < boardRect.top - 24 ||
        y > boardRect.bottom + 24 ||
        x < boardRect.left ||
        x > boardRect.right)
    ) {
      return null;
    }

    for (const status of visibleBoardStatuses(current)) {
      const columnElement = columnRefs.current.get(status);

      if (!columnElement) continue;
      const rect = columnElement.getBoundingClientRect();

      if (x < rect.left - 6 || x > rect.right + 6) continue;

      const centers = current[status]
        .filter((task) => task.id !== draggedTaskId)
        .map((task) => {
          const cardElement = cardRefs.current.get(task.id);

          if (!cardElement) return Number.NEGATIVE_INFINITY;
          const cardRect = cardElement.getBoundingClientRect();

          return cardRect.top + cardRect.height / 2;
        });

      return { status, index: dropIndexForPointer(centers, y) };
    }

    return null;
  };

  const commitDrop = (
    taskId: string,
    toStatus: TaskStatus,
    dropIndex: number,
  ) => {
    const current = columnsRef.current;

    if (!current) return;

    const neighbors = dropNeighborsForIndex(
      current[toStatus].map((task) => task.id),
      taskId,
      dropIndex,
    );

    setColumns(applyBoardMove(current, taskId, toStatus, dropIndex));
    void rpc
      .call("boardMove", {
        taskId,
        status: toStatus,
        beforeTaskId: neighbors.beforeTaskId,
        afterTaskId: neighbors.afterTaskId,
        authorName: "You",
      })
      .then(
        (result) => {
          if (!result.ok) board.refresh();
        },
        () => board.refresh(),
      );
  };

  const handleCardPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    task: Task,
  ) => {
    if (event.button !== 0 || dragCleanupRef.current) return;
    const rect = event.currentTarget.getBoundingClientRect();

    const start = {
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    };

    let active = false;

    const updateDrag = (moveEvent: PointerEvent) => {
      const target = findDropTarget(
        moveEvent.clientX,
        moveEvent.clientY,
        task.id,
      );

      ghostPositionRef.current = {
        x: moveEvent.clientX - start.offsetX,
        y: moveEvent.clientY - start.offsetY,
      };

      scheduleGhostPosition();

      const overStatus = target?.status ?? null;
      const dropIndex = target?.index ?? 0;

      setDrag((current) =>
        current !== null &&
        current.taskId === task.id &&
        current.overStatus === overStatus &&
        current.dropIndex === dropIndex
          ? current
          : {
              taskId: task.id,
              width: start.width,
              overStatus,
              dropIndex,
            },
      );
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (!active) {
        const distance = Math.hypot(
          moveEvent.clientX - start.x,
          moveEvent.clientY - start.y,
        );

        if (distance < DRAG_THRESHOLD_PX) return;
        active = true;
      }

      moveEvent.preventDefault();
      updateDrag(moveEvent);
    };

    const finish = (upEvent: PointerEvent | null) => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;

      if (!active) return;

      if (upEvent) {
        const target = findDropTarget(
          upEvent.clientX,
          upEvent.clientY,
          task.id,
        );

        if (target) commitDrop(task.id, target.status, target.index);
      }

      setDrag(null);
      suppressClickRef.current = true;
      setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };

    const onUp = (upEvent: PointerEvent) => finish(upEvent);
    const onCancel = () => finish(null);

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  const openTask = (task: Task) => {
    if (suppressClickRef.current) return;
    navigation.go({ kind: "task", taskKey: task.key });
  };

  if (columns === undefined) {
    if (board.error) {
      return (
        <EmptyState
          icon="AlertCircle"
          tone="error"
          title="Couldn't load the board"
          description={board.error}
          action={
            <Button variant="outline" size="sm" onClick={board.refresh}>
              <Icon name="RotateCcw" className="size-3.5" />
              Try again
            </Button>
          }
        />
      );
    }

    return <BoardSkeleton />;
  }

  const labelsById = board.data?.labelsById ?? new Map<string, Label>();

  const metaByTaskId =
    board.data?.metaByTaskId ?? new Map<string, BoardCardMeta>();

  const ghostTask = drag
    ? Object.values(columns)
        .flat()
        .find((task) => task.id === drag.taskId)
    : undefined;

  const renderColumn = (status: TaskStatus) => {
    const cards = columns[status];
    const isDragOver = drag !== null && drag.overStatus === status;

    const remaining = drag
      ? cards.filter((task) => task.id !== drag.taskId)
      : cards;

    const indicatorBeforeTaskId = isDragOver
      ? (remaining[drag.dropIndex]?.id ?? null)
      : undefined;

    const indicator = (
      <div
        key="drop-indicator"
        className="h-0.5 shrink-0 rounded-full bg-primary"
      />
    );

    const children: ReactNode[] = [];

    for (const task of cards) {
      if (task.id === indicatorBeforeTaskId) children.push(indicator);
      children.push(
        <TaskCard
          key={task.id}
          task={task}
          labelsById={labelsById}
          meta={metaByTaskId.get(task.id) ?? EMPTY_META}
          dragging={drag?.taskId === task.id}
          cardRef={(element) => {
            if (element) cardRefs.current.set(task.id, element);
            else cardRefs.current.delete(task.id);
          }}
          onPointerDown={(event) => handleCardPointerDown(event, task)}
          onClick={() => openTask(task)}
        />,
      );
    }

    if (cards.length === 0) {
      children.push(<EmptyColumn key="empty" dropTarget={isDragOver} />);
    } else if (indicatorBeforeTaskId === null) {
      children.push(indicator);
    }

    return (
      <div key={status} className="flex max-h-full w-[230px] shrink-0 flex-col">
        <div className="flex h-8 items-center gap-1.5 px-1 pb-1 text-sm font-semibold">
          <StatusIcon status={status} />
          <span>{STATUS_LABELS[status]}</span>
          <span className={SECTION_COUNT_CLASS}>
            <span aria-hidden="true">{cards.length}</span>
            <span className="sr-only">
              {cards.length} {cards.length === 1 ? "task" : "tasks"}
            </span>
          </span>
          <Hint label={`Add a task to ${STATUS_LABELS[status]}`}>
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto text-muted-foreground"
              aria-label={`Add a task to ${STATUS_LABELS[status]}`}
              onClick={() => setQuickAddStatus(status)}
            >
              <Icon name="Plus" className="size-3.5" />
            </Button>
          </Hint>
        </div>
        <div
          ref={(element) => {
            if (element) columnRefs.current.set(status, element);
            else columnRefs.current.delete(status);
          }}
          data-board-column={status}
          className={cn(
            "flex min-h-16 flex-col gap-2 overflow-y-auto rounded-lg p-1",
            isDragOver &&
              "bg-surface-selected outline-2 outline-dashed outline-input",
          )}
        >
          {children}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={boardRef}
      className={cn(
        "flex h-full items-start gap-3 overflow-x-auto p-4",
        drag !== null && "cursor-grabbing",
      )}
    >
      {visibleBoardStatuses(columns).map(renderColumn)}
      {drag && ghostTask ? (
        <div
          ref={(element) => {
            ghostRef.current = element;
            writeGhostPosition();
          }}
          className="pointer-events-none fixed top-0 left-0 z-50"
          style={{ width: drag.width }}
        >
          <TaskCard
            task={ghostTask}
            labelsById={labelsById}
            meta={metaByTaskId.get(ghostTask.id) ?? EMPTY_META}
            ghost
          />
        </div>
      ) : null}
      <NewTaskDialog
        open={quickAddStatus !== null}
        onOpenChange={(open) => {
          if (!open) setQuickAddStatus(null);
        }}
        projectId={projectId}
        defaultStatus={quickAddStatus ?? undefined}
      />
    </div>
  );
}

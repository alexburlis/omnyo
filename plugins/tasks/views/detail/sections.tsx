import { useState, type ReactNode, type Ref } from "react";
import type { Task } from "../../shared/contract.js";
import { STATUS_LABELS } from "../list/lib.js";
import { StatusIcon } from "./meta.js";
import { Button } from "@/components/ui/button";
import { INSET_FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import { LIST_HOVER_TRANSITION } from "@/components/ui/motion";
import { SECTION_COUNT_CLASS } from "@/components/ui/section-header";
import { cn } from "@/lib/utils";

export function DetailSectionHeading({
  title,
  count,
  countLabel,
  description,
  actions,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-2 flex min-h-7 min-w-0 items-center gap-2">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {count === undefined || count === 0 ? null : (
        <span className={SECTION_COUNT_CLASS}>
          <span aria-hidden="true">{count}</span>
          {countLabel === undefined ? null : (
            <span className="sr-only">{countLabel}</span>
          )}
        </span>
      )}
      {description === undefined ? null : (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {description}
        </span>
      )}
      {actions === undefined || actions === null ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
        </span>
      )}
    </div>
  );
}

export function SubTaskList({
  ref,
  task,
  subtasks,
  onOpen,
  onCreate,
}: {
  ref?: Ref<HTMLElement>;
  task: Task;
  subtasks: readonly Task[];
  onOpen: (taskKey: string) => void;
  onCreate: (title: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const done = subtasks.filter((subtask) => subtask.status === "done").length;

  const submit = async () => {
    const trimmed = title.trim();

    if (!trimmed || busy) return;
    setBusy(true);
    const created = await onCreate(trimmed);
    setBusy(false);

    if (created) setTitle("");
  };

  return (
    <section ref={ref} aria-label="Sub-tasks" className="mt-7">
      <DetailSectionHeading
        title="Sub-tasks"
        count={subtasks.length}
        countLabel={`${subtasks.length} ${subtasks.length === 1 ? "sub-task" : "sub-tasks"}`}
        description={
          subtasks.length === 0
            ? "Break this task into smaller steps."
            : `${done} of ${subtasks.length} done`
        }
        actions={
          adding ? null : (
            <Button size="xs" variant="soft" onClick={() => setAdding(true)}>
              <Icon name="Plus" />
              Add sub-task
            </Button>
          )
        }
      />
      {subtasks.length > 0 || adding ? (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {subtasks.map((subtask) => {
            const closed =
              subtask.status === "done" || subtask.status === "canceled";

            return (
              <button
                key={subtask.id}
                type="button"
                className={cn(
                  "flex h-9 w-full cursor-pointer items-center gap-2.5 border-b border-border-hairline px-3 text-left text-sm last:border-b-0 hover:bg-state-hover",
                  LIST_HOVER_TRANSITION,
                  INSET_FOCUS_RING_CLASS,
                )}
                onClick={() => onOpen(subtask.key)}
              >
                <StatusIcon status={subtask.status} />
                <span className="w-16 shrink-0 text-xs tabular-nums text-subtle-foreground">
                  {subtask.key}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate",
                    closed ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {subtask.title}
                </span>
                <span className="shrink-0 text-xs text-subtle-foreground">
                  {STATUS_LABELS[subtask.status]}
                </span>
              </button>
            );
          })}
          {adding ? (
            <div className="flex h-9 items-center gap-2.5 px-3">
              <StatusIcon status="todo" />
              <input
                autoFocus
                value={title}
                aria-label="New sub-task title"
                placeholder={`New sub-task of ${task.key}. Enter adds it, Esc cancels`}
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle-foreground"
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();

                  if (event.key === "Escape") {
                    setAdding(false);
                    setTitle("");
                  }
                }}
                onBlur={() => {
                  if (!title.trim()) setAdding(false);
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

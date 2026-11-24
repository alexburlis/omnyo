import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Task } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import { experimental_useAppNavigate, useRpc } from "@omnyo/plugin-sdk/app";
import {
  listAllTasks,
  useMentionItems,
  useTasksQuery,
  useTasksRpc,
} from "../../shell/data.js";
import { useTasksNavigation } from "../../shell/routes.js";
import { TasksEditor } from "../../editor/tasks-editor.js";
import { TaskActivity } from "../activity/task-activity.js";
import { AttachmentsGrid, uploadAttachment } from "./attachments.js";
import {
  createDescriptionSaver,
  type DescriptionSaver,
} from "./description-save.js";
import { StatusIcon } from "./meta.js";
import {
  InlineProperties,
  PropertiesRail,
  type TaskPropertyUpdate,
} from "./rail.js";
import { ThreadsSection } from "./threads.js";
import { SubTaskList } from "./sections.js";
import { EmptyState } from "../../components/empty-state.js";
import { Button } from "@/components/ui/button";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";

interface DetailViewProps {
  taskKey: string;
  onCanonicalKey?: (taskKey: string) => void;
  onBrowse?: () => void;
}

const DESCRIPTION_SAVE_DELAY_MS = 800;

const ACTIVE_PULL_REQUEST_REFRESH_MS = 60_000;

function SubTaskDonut({
  subtasks,
  onClick,
}: {
  subtasks: Task[];
  onClick: () => void;
}) {
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((subtask) => subtask.status === "done").length;
  const degrees = (done / subtasks.length) * 360;

  return (
    <button
      type="button"
      title="Sub-tasks completed"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input hover:text-foreground"
    >
      <span
        aria-hidden
        className="inline-block size-3 rounded-full"
        style={{
          background: `conic-gradient(var(--primary) ${degrees}deg, var(--muted) 0)`,
        }}
      />
      {done}/{subtasks.length} sub-tasks
    </button>
  );
}

function EditableTitle({
  task,
  onSave,
}: {
  task: Task;
  onSave: (title: string) => void;
}) {
  return (
    <h1
      key={`${task.id}:${task.title}`}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Task title"
      className="mb-2.5 mt-1 text-2xl font-semibold leading-tight outline-none"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        const next = event.currentTarget.textContent?.trim() ?? "";

        if (!next) {
          event.currentTarget.textContent = task.title;

          return;
        }

        if (next !== task.title) onSave(next);
      }}
    >
      {task.title}
    </h1>
  );
}

function SubTasksSection({
  ref,
  task,
  subtasks,
  onCreate,
}: {
  ref: React.Ref<HTMLElement>;
  task: Task;
  subtasks: Task[];
  onCreate: (title: string) => Promise<boolean>;
}) {
  const navigation = useTasksNavigation();

  return (
    <SubTaskList
      ref={ref}
      task={task}
      subtasks={subtasks}
      onOpen={(taskKey) => navigation.go({ kind: "task", taskKey })}
      onCreate={onCreate}
    />
  );
}

function DetailSkeleton() {
  return (
    <DelayedLoading>
      <div className="mx-auto w-full max-w-3xl px-8 py-12">
        <Skeleton className="mb-4 h-7 w-2/3" />
        <Skeleton className="mb-2 h-4 w-full" />
        <Skeleton className="mb-2 h-4 w-5/6" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </DelayedLoading>
  );
}

function TaskDetail({ task }: { task: Task }) {
  const rpc = useTasksRpc();
  const delegationRpc = useRpc<DelegationRpcContract>();
  const navigation = useTasksNavigation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const subtasksRef = useRef<HTMLElement>(null);

  const [draft, setDraft] = useState<{ taskId: string; markdown: string }>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const saverRef = useRef<DescriptionSaver | null>(null);
  saverRef.current ??= createDescriptionSaver({
    save: async (taskId, markdown) => {
      const result = await rpcRef.current.call("updateTask", {
        taskId,
        description: markdown,
      });

      return result.ok
        ? { ok: true }
        : { ok: false, errorMessage: result.error.message };
    },
    onError: (message) => toast.error(message),
    delayMs: DESCRIPTION_SAVE_DELAY_MS,
  });

  const projects = useTasksQuery(
    async (query) => (await query.call("listProjects", {})).projects,
    ["projects:changed"],
  );

  const project = projects.data?.find((entry) => entry.id === task.projectId);

  const parent = useTasksQuery(
    async (query) =>
      task.parentTaskId
        ? (await query.call("getTask", { taskId: task.parentTaskId })).task
        : null,
    ["tasks:changed"],
    [task.parentTaskId],
    { relevantTaskIds: task.parentTaskId ? [task.parentTaskId] : [] },
  );

  const subtasks = useTasksQuery(
    async (query) => listAllTasks(query, { parentTaskId: task.id }),
    ["tasks:changed"],
    [task.id],
  );

  const labels = useTasksQuery(
    async (query) =>
      (await query.call("listLabels", { projectId: task.projectId })).labels,
    ["projects:changed"],
    [task.projectId],
  );

  const attachments = useTasksQuery(
    async (query) =>
      (await query.call("listAttachments", { taskId: task.id })).attachments,
    ["tasks:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );

  const threads = useTasksQuery(
    async (query) =>
      (await query.call("listTaskThreads", { taskId: task.id })).taskThreads,
    ["threads:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );

  const presets = useTasksQuery(
    async (query) => (await query.call("listPresets")).presets,
    ["projects:changed"],
  );

  const pullRequests = useTasksQuery(
    async (query) => query.call("listTaskPullRequests", { taskId: task.id }),
    ["threads:changed"],
    [task.id],
    { relevantTaskIds: [task.id] },
  );

  const refreshPullRequests = pullRequests.refresh;

  const hasActivePullRequest = (pullRequests.data?.pullRequests ?? []).some(
    (pullRequest) =>
      pullRequest.state === "open" || pullRequest.state === "draft",
  );

  useEffect(() => {
    window.addEventListener("focus", refreshPullRequests);

    return () => window.removeEventListener("focus", refreshPullRequests);
  }, [refreshPullRequests]);
  useEffect(() => {
    if (!hasActivePullRequest) return;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== "hidden") refreshPullRequests();
    }, ACTIVE_PULL_REQUEST_REFRESH_MS);

    return () => window.clearInterval(timer);
  }, [hasActivePullRequest, refreshPullRequests]);

  const updateTask = async (
    input: TaskPropertyUpdate & { title?: string; description?: string },
  ) => {
    try {
      const result = await rpc.call("updateTask", {
        taskId: task.id,
        ...input,
      });

      if (!result.ok) toast.error(result.error.message);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const moveToProject = async (projectId: string) => {
    saverRef.current?.flush(task.id);

    try {
      const result = await rpc.call("moveTaskToProject", {
        taskId: task.id,
        projectId,
      });

      if (!result.ok) {
        toast.error(result.error.message);

        return;
      }

      navigation.go(
        { kind: "task", taskKey: result.task.key },
        { replace: true },
      );
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };

  const onDescriptionChange = (markdown: string) => {
    setDraft({ taskId: task.id, markdown });
    saverRef.current?.onChange(task.id, markdown);
  };

  useEffect(() => {
    return () => saverRef.current?.flush(task.id);
  }, [task.id]);

  const uploadForTask = async (file: File) => {
    const result = await uploadAttachment(file, { taskId: task.id });
    attachments.refresh();

    return result;
  };

  const onPickFiles = async (files: FileList | null) => {
    for (const file of files ?? []) {
      try {
        await uploadAttachment(file, { taskId: task.id });
      } catch (error) {
        toast.error(errorMessage(error));
      }
    }

    attachments.refresh();
  };

  const createSubtask = async (title: string): Promise<boolean> => {
    try {
      const result = await rpc.call("createTask", {
        projectId: task.projectId,
        title,
        parentTaskId: task.id,
        status: "todo",
      });

      if (!result.ok) {
        toast.error(result.error.message);

        return false;
      }

      subtasks.refresh();

      return true;
    } catch (error) {
      toast.error(errorMessage(error));

      return false;
    }
  };

  const mentionItems = useMentionItems();
  const navigate = experimental_useAppNavigate();

  const descriptionValue =
    draft && draft.taskId === task.id ? draft.markdown : task.description;

  const parentTask = parent.data ?? null;

  return (
    <div className="@container flex min-h-full flex-col bg-surface-recessed-solid p-3">
      <div className="flex flex-1 items-stretch rounded-lg border border-border bg-card shadow-2xs">
        <div className="mx-auto w-full min-w-0 max-w-[55rem] flex-1 px-7 pb-16 pt-8 @3xl:px-13 @3xl:pt-11">
          {parentTask || subtasks.data?.length ? (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              {parentTask ? (
                <button
                  type="button"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground shadow-2xs hover:border-input"
                  onClick={() =>
                    navigation.go({ kind: "task", taskKey: parentTask.key })
                  }
                >
                  Sub-task of
                  <StatusIcon status={parentTask.status} className="size-3" />
                  <span className="font-medium text-foreground">
                    {parentTask.key}
                  </span>
                  <span className="min-w-0 truncate">{parentTask.title}</span>
                </button>
              ) : null}
              <SubTaskDonut
                subtasks={subtasks.data ?? []}
                onClick={() =>
                  subtasksRef.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "center",
                  })
                }
              />
            </div>
          ) : null}

          <EditableTitle
            task={task}
            onSave={(title) => void updateTask({ title })}
          />

          <InlineProperties
            task={task}
            project={project}
            projects={projects.data}
            labels={labels.data}
            presets={presets.data}
            onUpdate={(update) => void updateTask(update)}
            onMoveToProject={(projectId) => void moveToProject(projectId)}
            onError={(message) => toast.error(message)}
            className="mb-4 @[45rem]:hidden"
          />

          <TasksEditor
            value={descriptionValue}
            onChange={onDescriptionChange}
            variant="doc"
            className="min-h-24"
            placeholder="Describe the task. Markdown works for headings, lists and checkboxes; type @ to link a task or chat."
            onUploadImage={uploadForTask}
            mentionItems={mentionItems}
            onOpenThread={(threadId) =>
              navigate.toThread(threadId, { experimental_userInitiated: true })
            }
          />

          <div className="mb-1 mt-3 flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="-ml-2 text-muted-foreground"
              onClick={() => fileInputRef.current?.click()}
            >
              <Icon name="Paperclip" />
              Attach files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void onPickFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </div>

          <AttachmentsGrid
            attachments={attachments.data ?? []}
            onRemove={async (attachment) => {
              const result = await rpc.call("deleteAttachment", {
                attachmentId: attachment.id,
                removeDescriptionReferences: true,
              });

              if (!result.ok) throw new Error(result.error.message);
              attachments.refresh();
            }}
            onError={(message) => toast.error(message)}
          />

          <SubTasksSection
            ref={subtasksRef}
            task={task}
            subtasks={subtasks.data ?? []}
            onCreate={createSubtask}
          />

          {(threads.data ?? []).length > 0 ? (
            <div className="mt-7">
              <ThreadsSection
                onOpenThread={(threadId) =>
                  navigate.toThread(threadId, {
                    experimental_userInitiated: true,
                  })
                }
                threads={threads.data ?? []}
                pullRequests={pullRequests.data?.pullRequests}
                unavailableThreadIds={
                  pullRequests.data?.unavailableThreadIds ?? []
                }
                onDetach={async (thread) => {
                  await delegationRpc.call("taskThreadsDetach", {
                    taskId: task.id,
                    threadId: thread.threadId,
                  });
                  threads.refresh();
                  pullRequests.refresh();
                }}
                onError={(message) => toast.error(message)}
              />
            </div>
          ) : null}

          <div className="mt-1">
            <TaskActivity taskId={task.id} />
          </div>
        </div>

        <PropertiesRail
          task={task}
          project={project}
          projects={projects.data}
          labels={labels.data}
          threads={threads.data ?? []}
          presets={presets.data}
          onUpdate={(update) => void updateTask(update)}
          onMoveToProject={(projectId) => void moveToProject(projectId)}
          onError={(message) => toast.error(message)}
          className="hidden @[45rem]:block"
        />
      </div>
    </div>
  );
}

export function DetailView({
  taskKey,
  onCanonicalKey,
  onBrowse,
}: DetailViewProps) {
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("getTaskByKey", { taskKey })).task,
    ["tasks:changed"],
    [taskKey],
  );

  const canonicalKey = query.data?.key;
  useEffect(() => {
    if (canonicalKey) onCanonicalKey?.(canonicalKey);
  }, [canonicalKey, onCanonicalKey]);

  if (query.data === undefined) {
    return query.error ? (
      <EmptyState
        icon="AlertCircle"
        tone="error"
        title={`Couldn't load ${taskKey}`}
        description={query.error}
        action={
          <Button size="sm" variant="outline" onClick={query.refresh}>
            <Icon name="RotateCcw" className="size-3.5" />
            Try again
          </Button>
        }
      />
    ) : (
      <DetailSkeleton />
    );
  }

  if (query.data === null) {
    return (
      <EmptyState
        icon="FileQuestion"
        title={`Task ${taskKey} was not found`}
        description="It may have been deleted, or its key changed when it moved to another project."
        action={
          onBrowse === undefined ? undefined : (
            <Button size="sm" variant="outline" onClick={onBrowse}>
              <Icon name="ListView" className="size-3.5" />
              Show all tasks
            </Button>
          )
        }
      />
    );
  }

  return <TaskDetail task={query.data} />;
}

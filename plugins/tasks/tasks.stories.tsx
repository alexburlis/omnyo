import { useState, type ReactNode } from "react";
import type {
  Label,
  Preset,
  Project,
  Task,
  TaskStatus,
  TaskThread,
} from "./shared/contract.js";
import { makeTask } from "./test-fixtures.js";
import { EmptyState } from "./components/empty-state.js";
import { TasksSidebar } from "./shell/sidebar.js";
import { TaskRow } from "./views/list/row.js";
import { StatusGroupHeader } from "./views/list/status-group.js";
import { groupTasksByStatus } from "./views/list/lib.js";
import { SubTaskList } from "./views/detail/sections.js";
import { ThreadsSection } from "./views/detail/threads.js";
import { AgentNotificationControl } from "./views/activity/task-activity.js";
import { PresetList } from "./views/manage/preset-list.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export default { title: "Tasks" };

const CORE = "01HZZZZZZZZZZZZZZZZZZZZZP1";

const WEB = "01HZZZZZZZZZZZZZZZZZZZZZP2";

const MOBILE = "01HZZZZZZZZZZZZZZZZZZZZZP3";

const PRODUCT = "01HZZZZZZZZZZZZZZZZZZZZZF1";

const CREATED = "2026-11-10T09:00:00.000Z";

function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

const projects: Project[] = [
  {
    id: CORE,
    name: "Core app",
    prefix: "CORE",
    nextTaskNumber: 20,
    color: "#6E7BF2",
    folderId: null,
    linkedAppProjectId: "proj_core",
    createdAt: CREATED,
  },
  {
    id: WEB,
    name: "Website",
    prefix: "WEB",
    nextTaskNumber: 9,
    color: "#3FB68B",
    folderId: null,
    linkedAppProjectId: null,
    createdAt: CREATED,
  },
  {
    id: MOBILE,
    name: "Mobile",
    prefix: "MOB",
    nextTaskNumber: 5,
    color: "#E5A33B",
    folderId: PRODUCT,
    linkedAppProjectId: null,
    createdAt: CREATED,
  },
];

const labels: Label[] = [
  {
    id: "01HZZZZZZZZZZZZZZZZZZZZZL1",
    projectId: CORE,
    name: "bug",
    color: "#E5484D",
  },
  {
    id: "01HZZZZZZZZZZZZZZZZZZZZZL2",
    projectId: CORE,
    name: "design",
    color: "#8E4EC6",
  },
  {
    id: "01HZZZZZZZZZZZZZZZZZZZZZL3",
    projectId: CORE,
    name: "backend",
    color: "#3E63DD",
  },
];

const labelsById = new Map(labels.map((label) => [label.id, label]));

const projectsById = new Map(projects.map((project) => [project.id, project]));

let taskSeq = 0;

function storyTask(
  projectId: string,
  key: string,
  title: string,
  status: TaskStatus,
  overrides: Partial<Task> = {},
): Task {
  taskSeq += 1;

  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZT${String(taskSeq).padStart(2, "0")}`,
    projectId,
    key,
    number: Number(key.split("-")[1] ?? 1),
    title,
    status,
    position: taskSeq,
    ...overrides,
  });
}

const tasks: Task[] = [
  storyTask(
    CORE,
    "CORE-16",
    "Archive finished chats from the command palette",
    "backlog",
    { priority: "low" },
  ),
  storyTask(
    CORE,
    "CORE-13",
    "Crash when pasting a 40 MB log into the composer",
    "todo",
    {
      priority: "urgent",
      dueDate: isoDaysFromToday(0),
      labelIds: ["01HZZZZZZZZZZZZZZZZZZZZZL1"],
    },
  ),
  storyTask(MOBILE, "MOB-2", "Haptic feedback when a chat finishes", "todo", {
    priority: "medium",
    dueDate: isoDaysFromToday(3),
  }),
  storyTask(
    CORE,
    "CORE-12",
    "Rebuild the release checklist so every step says who owns it",
    "in_progress",
    {
      priority: "high",
      dueDate: isoDaysFromToday(-2),
      labelIds: ["01HZZZZZZZZZZZZZZZZZZZZZL2", "01HZZZZZZZZZZZZZZZZZZZZZL3"],
    },
  ),
  storyTask(WEB, "WEB-4", "Rewrite the pricing page hero", "in_progress", {
    priority: "medium",
    dueDate: isoDaysFromToday(-4),
  }),
  storyTask(
    CORE,
    "CORE-14",
    "Show the reason a chat is waiting in plain words",
    "in_review",
    {
      labelIds: ["01HZZZZZZZZZZZZZZZZZZZZZL2"],
    },
  ),
  storyTask(
    WEB,
    "WEB-6",
    "Fix the broken footer link to the privacy policy",
    "done",
    {
      priority: "high",
      dueDate: isoDaysFromToday(-6),
    },
  ),
];

function StoryFrame({
  width = 960,
  children,
}: {
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="p-6">
      <div
        className="@container overflow-hidden rounded-lg border border-border bg-background"
        style={{ width }}
      >
        {children}
      </div>
    </div>
  );
}

function GroupedRows({ initiallyClosed }: { initiallyClosed: TaskStatus[] }) {
  const [closed, setClosed] = useState<ReadonlySet<TaskStatus>>(
    new Set(initiallyClosed),
  );

  return (
    <>
      {groupTasksByStatus(tasks).map((group) => {
        const open = !closed.has(group.status);

        return (
          <section key={group.status}>
            <StatusGroupHeader
              status={group.status}
              count={group.tasks.length}
              open={open}
              onOpenChange={(next) =>
                setClosed((current) => {
                  const updated = new Set(current);

                  if (next) updated.delete(group.status);
                  else updated.add(group.status);

                  return updated;
                })
              }
            />
            {open
              ? group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    meta={undefined}
                    project={projectsById.get(task.projectId)}
                    showProject
                    labelsById={labelsById}
                    projectLabels={labels}
                    projects={projects}
                    onEdit={() => {}}
                    onMoveToProject={() => {}}
                    onOpen={() => {}}
                    pending={false}
                  />
                ))
              : null}
          </section>
        );
      })}
    </>
  );
}

export function ListGroups() {
  return (
    <StoryFrame>
      <GroupedRows initiallyClosed={[]} />
    </StoryFrame>
  );
}

export function ListGroupsCollapsed() {
  return (
    <StoryFrame>
      <GroupedRows initiallyClosed={["backlog", "done"]} />
    </StoryFrame>
  );
}

export function ListRowsNarrow() {
  return (
    <StoryFrame width={420}>
      <GroupedRows initiallyClosed={["backlog", "done"]} />
    </StoryFrame>
  );
}

const presets: Preset[] = [
  {
    id: "01HZZZZZZZZZZZZZZZZZZZZZR1",
    name: "Opus builder",
    providerId: "claude-code",
    modelId: "claude-opus-5-5",
    reasoningLevel: "high",
    serviceTier: null,
    permissionMode: "full",
    environmentKind: "new-worktree",
    baseBranch: "main",
    machineId: null,
    instructions:
      "Implement the task, run the focused tests and open a pull request.",
    builtin: false,
    createdAt: CREATED,
  },
  {
    id: "01HZZZZZZZZZZZZZZZZZZZZZR2",
    name: "Codex reviewer",
    providerId: "codex",
    modelId: "gpt-5.4",
    reasoningLevel: "medium",
    serviceTier: "priority",
    permissionMode: "auto",
    environmentKind: "project-default",
    baseBranch: null,
    machineId: null,
    instructions: "",
    builtin: false,
    createdAt: CREATED,
  },
];

export function Sidebar() {
  return (
    <div className="h-[640px] w-60 border-r border-border-hairline">
      <TasksSidebar
        route={{ kind: "project", projectId: CORE, view: null }}
        folders={[
          {
            id: PRODUCT,
            name: "Product",
            parentFolderId: null,
            createdAt: CREATED,
          },
        ]}
        projects={projects}
        summaries={[
          { projectId: CORE, taskCount: 7, activeAgentCount: 1 },
          { projectId: WEB, taskCount: 2, activeAgentCount: 1 },
          { projectId: MOBILE, taskCount: 2, activeAgentCount: 0 },
        ]}
        presets={presets}
        activeTasks={tasks.slice(3, 5)}
        isLoading={false}
        onNavigate={() => {}}
        onNewProject={() => {}}
      />
    </div>
  );
}

const parent = tasks[3]!;

const subtasks: Task[] = [
  storyTask(CORE, "CORE-19", "List the current release steps", "done", {
    parentTaskId: parent.id,
  }),
  storyTask(CORE, "CORE-20", "Assign an owner to each step", "in_progress", {
    parentTaskId: parent.id,
  }),
  storyTask(CORE, "CORE-21", "Add the rollback step", "todo", {
    parentTaskId: parent.id,
  }),
];

export function DetailSubTasks() {
  return (
    <div className="max-w-2xl p-6">
      <SubTaskList
        task={parent}
        subtasks={subtasks}
        onOpen={() => {}}
        onCreate={async () => true}
      />
      <SubTaskList
        task={parent}
        subtasks={[]}
        onOpen={() => {}}
        onCreate={async () => true}
      />
    </div>
  );
}

function thread(
  id: string,
  title: string,
  liveStatus: TaskThread["liveStatus"],
  presetName: string,
  hoursAgo: number,
): TaskThread {
  const attachedAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

  return {
    id,
    taskId: parent.id,
    threadId: `thr_${id.slice(-8).toLowerCase()}`,
    presetName,
    title,
    liveStatus,
    attachedAt,
    updatedAt: attachedAt,
  };
}

export function DetailAgentChats() {
  return (
    <div className="max-w-2xl p-6">
      <ThreadsSection
        threads={[
          thread(
            "01HZZZZZZZZZZZZZZZZZZZZZH1",
            "Draft owners for each release step",
            "working",
            "Opus builder",
            2,
          ),
          thread(
            "01HZZZZZZZZZZZZZZZZZZZZZH2",
            "Pricing hero copy",
            "starting",
            "Opus builder",
            0.1,
          ),
          thread(
            "01HZZZZZZZZZZZZZZZZZZZZZH3",
            "Review the checklist wording",
            "completed",
            "Codex reviewer",
            26,
          ),
          thread(
            "01HZZZZZZZZZZZZZZZZZZZZZH4",
            "Add the rollback step to the release script",
            "failed",
            "Opus builder",
            50,
          ),
        ]}
        pullRequests={[]}
        unavailableThreadIds={["thr_zzzzzzh3"]}
        onDetach={async () => {}}
        onOpenThread={() => {}}
        onError={() => {}}
      />
    </div>
  );
}

export function CommentNotifyControl() {
  const [checked, setChecked] = useState(true);

  return (
    <div className="flex max-w-md flex-col gap-3 p-6">
      <AgentNotificationControl
        target={{ kind: "ready", title: "Draft owners for each release step" }}
        checked={checked}
        onCheckedChange={setChecked}
      />
      <AgentNotificationControl
        target={{ kind: "none" }}
        checked
        onCheckedChange={() => {}}
      />
    </div>
  );
}

export function ManagePresets() {
  return (
    <div className="flex max-w-3xl flex-col gap-6 p-6">
      <PresetList
        presets={presets}
        machines={[{ id: "host_mac", name: "Mac Pro" }]}
        onEdit={() => {}}
        onDelete={() => {}}
      />
      <PresetList
        presets={[]}
        machines={[]}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    </div>
  );
}

export function EmptyAndErrorStates() {
  return (
    <div className="grid grid-cols-2 gap-4 p-6">
      <div className="h-72 rounded-lg border border-border">
        <EmptyState
          icon="ListTodo"
          title="No tasks yet"
          description="Create the first task to start tracking work."
          action={
            <Button size="sm">
              <Icon name="Plus" className="size-3.5" />
              New task
            </Button>
          }
        />
      </div>
      <div className="h-72 rounded-lg border border-border">
        <EmptyState
          icon="AlertCircle"
          tone="error"
          title="Couldn't load the board"
          description="The Tasks server didn't answer in time."
          action={
            <Button size="sm" variant="outline">
              <Icon name="RotateCcw" className="size-3.5" />
              Try again
            </Button>
          }
        />
      </div>
      <div className="h-72 rounded-lg border border-border">
        <EmptyState
          icon="FileQuestion"
          title="Task CORE-99 was not found"
          description="It may have been deleted, or its key changed when it moved to another project."
          action={
            <Button size="sm" variant="outline">
              <Icon name="ListView" className="size-3.5" />
              Show all tasks
            </Button>
          }
        />
      </div>
      <div className="h-72 rounded-lg border border-border">
        <EmptyState
          icon="Zap"
          title="No agents working right now"
          description="Dispatch a task to an agent preset and it will show up here while it runs."
        />
      </div>
    </div>
  );
}

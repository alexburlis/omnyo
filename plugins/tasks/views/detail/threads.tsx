import { useState } from "react";
import { UrlLink, useRpc } from "@omnyo/plugin-sdk/app";
import type { DelegationRpcContract } from "../../delegate/contract.js";
import type {
  Preset,
  TaskPullRequest,
  TaskThread,
} from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { importLegacyTasksBrowserKeyV1 } from "../../shared/legacy-browser-key-v1.js";
import {
  PR_STATE_META,
  THREAD_STATUS_META,
  formatRelativeTime,
  isActiveThread,
} from "./meta.js";
import { PresetDialog, savePresetDraft } from "../manage/preset-dialog.js";
import {
  ConfirmDeleteDialog,
  ConfirmDeleteDialogContent,
} from "@/components/ui/confirm-delete-dialog";
import { useTasksRpc } from "../../shell/data.js";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FOCUS_RING_CLASS } from "@/components/ui/focus-ring";
import { Icon } from "@/components/ui/icon";
import {
  StatusList,
  StatusRow,
  type StatusTone,
} from "@/components/ui/status-row";
import { cn } from "@/lib/utils";
import { DetailSectionHeading } from "./sections.js";
import { Hint } from "../../components/hint.js";

function ThreadPullRequestPill({
  pullRequest,
  unavailable,
}: {
  pullRequest: TaskPullRequest | undefined;
  unavailable: boolean;
}) {
  if (pullRequest) {
    const meta = PR_STATE_META[pullRequest.state];

    return (
      <UrlLink
        href={pullRequest.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`${pullRequest.title} (${meta.label})`}
        aria-label={`Pull request #${pullRequest.number}: ${pullRequest.title} (${meta.label})`}
        className={cn(
          "inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-state-hover px-2 text-xs font-medium text-foreground hover:bg-state-active",
          FOCUS_RING_CLASS,
        )}
      >
        <Icon name={meta.icon} className={cn("size-3.5", meta.textClassName)} />
        PR #{pullRequest.number}
        <span className="text-muted-foreground">{meta.label}</span>
      </UrlLink>
    );
  }

  if (unavailable) {
    return (
      <span
        title="Couldn't check this chat's pull request"
        className="shrink-0 text-xs text-muted-foreground"
      >
        PR status unknown
      </span>
    );
  }

  return null;
}

const THREAD_TONE: Record<TaskThread["liveStatus"], StatusTone> = {
  starting: "pending",
  working: "active",
  idle: "neutral",
  completed: "success",
  failed: "error",
};

export function ThreadRow({
  thread,
  pullRequest,
  pullRequestUnavailable,
  busy,
  onOpen,
  onDetach,
}: {
  thread: TaskThread;
  pullRequest: TaskPullRequest | undefined;
  pullRequestUnavailable: boolean;
  busy: boolean;
  onOpen: () => void;
  onDetach: () => void;
}) {
  const meta = THREAD_STATUS_META[thread.liveStatus];

  return (
    <StatusRow
      tone={THREAD_TONE[thread.liveStatus]}
      title={thread.title}
      status={meta.label}
      meta={[
        thread.presetName,
        `added ${formatRelativeTime(thread.attachedAt)}`,
      ]}
      actions={
        <>
          <ThreadPullRequestPill
            pullRequest={pullRequest}
            unavailable={pullRequestUnavailable}
          />
          <Button
            size="xs"
            variant="soft"
            aria-label="Open chat"
            onClick={onOpen}
          >
            Open chat
            <Icon name="ArrowUpRight" />
          </Button>
          <Hint label="Remove from this task. The chat itself is kept.">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Detach ${thread.title}`}
              disabled={busy}
              className="text-muted-foreground"
              onClick={onDetach}
            >
              <Icon name="X" />
            </Button>
          </Hint>
        </>
      }
    />
  );
}

const LAST_PRESET_STORAGE_KEY = "tasks:last-dispatch-preset";

const LEGACY_LAST_PRESET_STORAGE_KEY_V1 = "bb-tasks:last-dispatch-preset";

function loadLastPresetId(): string | null {
  importLegacyTasksBrowserKeyV1(
    LEGACY_LAST_PRESET_STORAGE_KEY_V1,
    LAST_PRESET_STORAGE_KEY,
  );

  try {
    return window.localStorage.getItem(LAST_PRESET_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLastPresetId(presetId: string): void {
  try {
    window.localStorage.setItem(LAST_PRESET_STORAGE_KEY, presetId);
  } catch {}
}

interface DispatchControlProps {
  taskId: string;
  presets: Preset[] | undefined;
  onError: (message: string) => void;
  align?: "start" | "end";
  className?: string;
}

export function DispatchControl({
  taskId,
  presets,
  onError,
  align = "end",
  className,
}: DispatchControlProps) {
  const rpc = useRpc<DelegationRpcContract>();
  const tasksRpc = useTasksRpc();
  const [dispatching, setDispatching] = useState(false);
  const [lastPresetId, setLastPresetId] = useState(loadLastPresetId);
  const [createDialogKey, setCreateDialogKey] = useState<number | null>(null);

  const dispatch = async (presetId: string) => {
    setDispatching(true);

    try {
      await rpc.call("delegate", { taskId, presetId });
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setDispatching(false);
    }
  };

  const pickPreset = (preset: Preset) => {
    setLastPresetId(preset.id);
    storeLastPresetId(preset.id);
    void dispatch(preset.id);
  };

  if (presets !== undefined && presets.length === 0) {
    return (
      <>
        <Hint label="A preset picks the model and permissions an agent uses for this task">
          <Button
            size="sm"
            className={cn("h-7 gap-1.5", className)}
            onClick={() => setCreateDialogKey(Date.now())}
          >
            <Icon name="Plus" className="size-3.5 shrink-0" />
            Add an agent preset
          </Button>
        </Hint>
        {createDialogKey !== null ? (
          <PresetDialog
            key={createDialogKey}
            open
            onOpenChange={(open) => {
              if (!open) setCreateDialogKey(null);
            }}
            editing={null}
            onSave={(draft) => savePresetDraft(tasksRpc, null, draft)}
          />
        ) : null}
      </>
    );
  }

  const current =
    presets?.find((preset) => preset.id === lastPresetId) ??
    (presets
      ? [...presets].sort((a, b) => a.name.localeCompare(b.name))[0]
      : undefined);

  return (
    <>
      <div className={cn("flex min-w-0", className)}>
        <Hint
          label={
            current
              ? `Start a new agent chat on this task with the ${current.name} preset`
              : "Start a new agent chat on this task"
          }
        >
          <Button
            size="sm"
            disabled={dispatching || !current}
            className="h-7 min-w-0 flex-1 gap-1.5 rounded-r-none"
            onClick={() => {
              if (current) pickPreset(current);
            }}
          >
            <Icon
              name={dispatching ? "Loading" : "Play"}
              className={cn("size-3.5 shrink-0", dispatching && "animate-spin")}
            />
            <span className="truncate">
              {dispatching
                ? "Starting agent…"
                : current
                  ? `Start ${current.name}`
                  : "Start agent"}
            </span>
          </Button>
        </Hint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={dispatching || !current}>
            <Button
              size="sm"
              aria-label="Choose which preset starts the agent"
              className="h-7 shrink-0 rounded-l-none border-l border-control-primary-foreground/25 px-1.5"
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align={align}>
            <DropdownMenuLabel>Start an agent with</DropdownMenuLabel>
            {(presets ?? []).map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => pickPreset(preset)}
              >
                <span className="min-w-0 flex-1 truncate">{preset.name}</span>
                <span className="text-xs text-muted-foreground">
                  {preset.modelId}
                </span>
                {preset.id === current?.id ? (
                  <Icon name="Check" className="size-3.5" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

interface ThreadsSectionProps {
  threads: TaskThread[];
  pullRequests: TaskPullRequest[] | undefined;
  unavailableThreadIds: string[];
  onDetach: (thread: TaskThread) => Promise<void>;
  onOpenThread: (threadId: string) => void;
  onError: (message: string) => void;
}

export function ThreadsSection({
  threads,
  pullRequests,
  unavailableThreadIds,
  onDetach,
  onOpenThread,
  onError,
}: ThreadsSectionProps) {
  const [confirm, setConfirm] = useState<TaskThread | null>(null);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const performDetach = async (thread: TaskThread) => {
    setPending((current) => new Set(current).add(thread.id));

    try {
      await onDetach(thread);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(thread.id);

        return next;
      });
    }
  };

  const activeCount = threads.filter(isActiveThread).length;
  const pullRequestByThread = new Map<string, TaskPullRequest>();

  for (const pullRequest of pullRequests ?? []) {
    for (const threadId of pullRequest.threadIds) {
      pullRequestByThread.set(threadId, pullRequest);
    }
  }

  const unavailable = new Set(unavailableThreadIds);

  return (
    <section aria-label="Agent chats">
      <DetailSectionHeading
        title="Agent chats"
        count={threads.length}
        countLabel={`${threads.length} ${threads.length === 1 ? "chat" : "chats"}`}
        description={
          activeCount > 0
            ? `${activeCount} working now`
            : "None working right now"
        }
      />
      <StatusList label="Agent chats">
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            pullRequest={pullRequestByThread.get(thread.threadId)}
            pullRequestUnavailable={unavailable.has(thread.threadId)}
            busy={pending.has(thread.id)}
            onOpen={() => onOpenThread(thread.threadId)}
            onDetach={() => setConfirm(thread)}
          />
        ))}
      </StatusList>
      <ConfirmDeleteDialog
        className="max-w-sm"
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        {confirm ? (
          <ConfirmDeleteDialogContent
            title="Detach this chat?"
            description={`"${confirm.title}" will no longer be listed on this task. The chat itself is kept; re-attach it with omnyo tasks attach.`}
            confirmLabel="Detach"
            pending={false}
            size="sm"
            onCancel={() => setConfirm(null)}
            onConfirm={() => {
              setConfirm(null);
              void performDetach(confirm);
            }}
          />
        ) : null}
      </ConfirmDeleteDialog>
    </section>
  );
}

import { CuaResources } from "./cua-resources";
import { inspectionStatus, inspectionSummary } from "../lib/inspection";
import { useState, type ReactNode } from "react";
import { experimental_useAppNavigate, type PluginNavPanelProps } from "@omnyo/plugin-sdk/app";
import type {
  HistoryEntry,
  HostGroup,
  ListResult,
  ProcessStopResult,
  StopReason,
  ThreadGroup,
  WorkloadRow,
} from "../contract";
import { formatBytes, formatDuration, formatProcessCount } from "../lib/format";
import { PANEL_PATH } from "../lib/names";
import { Button } from "./ui/button";
import { EmptyStateBlock } from "./ui/empty-state";
import { FOCUS_RING_CLASS } from "./ui/focus-ring";
import { Icon } from "./ui/icon";
import { CollapsibleSection } from "./ui/section-header";
import { StatusBadge, StatusList, StatusRow, type StatusTone } from "./ui/status-row";
import { useLeftRunning } from "./use-left-running";

const RECENT_STOPS_SHOWN = 8;

const RECENT_STOPS_OPEN_KEY = "leftover-processes:recent-stops-open";

const STOP_REASON_TEXT: ReadonlyMap<StopReason, string> = new Map([
  ["archived", "Chat archived"],
  ["deleted", "Chat deleted"],
  ["idle", "Chat idle"],
  ["manual", "You stopped it"],
]);

type RowActions = {
  busyKey: string | null;
  stop: (row: WorkloadRow) => void;
  keep: (row: WorkloadRow) => void;
  unkeep: (row: WorkloadRow) => void;
};

function rowKey(row: WorkloadRow): string {
  return `${row.hostId}:${row.pid}:${row.startedAt}`;
}

function memoryText(row: WorkloadRow): string {
  const bytes = formatBytes(row.memoryBytes);

  return row.memorySource === "rss" ? `${bytes} RSS` : bytes;
}

type RowState = { tone: StatusTone; text: string; hint: string | null };

function rowState(row: WorkloadRow): RowState {
  const { disposition } = row;

  switch (disposition.kind) {
    case "in-use":
      return {
        tone: "active",
        text: "Chat is running",
        hint: "Nothing here stops while the chat is running.",
      };

    case "kept":
      return { tone: "neutral", text: "Kept running", hint: null };

    case "stop":
      return { tone: "warning", text: "Stopping now", hint: null };

    case "waiting":
      if (disposition.reason === "busy")
        return {
          tone: "active",
          text: "Still working",
          hint: "A process from this chat used CPU since the last check, so nothing stops yet.",
        };

      if (disposition.reason === "open-work")
        return {
          tone: "pending",
          text: row.nextStep,
          hint: "The chat still has open work, so nothing stops until it finishes.",
        };

      return { tone: "pending", text: row.nextStep, hint: null };
  }
}

function sharedState(rows: readonly WorkloadRow[]): RowState | null {
  const [first, ...rest] = rows.map(rowState);

  if (first === undefined || rest.length === 0) return null;

  return rest.every((state) => state.text === first.text && state.tone === first.tone)
    ? first
    : null;
}

function readRecentStopsOpen(): boolean {
  try {
    return window.localStorage.getItem(RECENT_STOPS_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeRecentStopsOpen(open: boolean): void {
  try {
    window.localStorage.setItem(RECENT_STOPS_OPEN_KEY, String(open));
  } catch {
    return;
  }
}

function ProcessRow({
  row,
  actions,
  showStatus,
}: {
  row: WorkloadRow;
  actions: RowActions;
  showStatus: boolean;
}) {
  const disabled = actions.busyKey !== null;
  const name = `${row.executable} ${row.pid}`;
  const state = rowState(row);

  return (
    <StatusRow
      tone={state.tone}
      title={row.executable}
      status={showStatus ? state.text : undefined}
      meta={[
        memoryText(row),
        ...(row.ageSeconds === null ? [] : [`up ${formatDuration(row.ageSeconds * 1000)}`]),
      ]}
      detail={
        <span title={row.command} className="block truncate font-mono text-xs">
          {row.command}
        </span>
      }
      actions={
        <>
          {row.ownKeep ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              aria-label={`Unkeep ${name}`}
              onClick={() => actions.unkeep(row)}
            >
              Unkeep
            </Button>
          ) : row.disposition.kind === "kept" ? null : (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              aria-label={`Keep ${name}`}
              onClick={() => actions.keep(row)}
            >
              Keep
            </Button>
          )}
          <Button
            variant="soft"
            size="xs"
            disabled={disabled}
            aria-label={`Stop ${name}`}
            onClick={() => actions.stop(row)}
          >
            {actions.busyKey === rowKey(row) ? "Stopping…" : "Stop"}
          </Button>
        </>
      }
    />
  );
}

function ChatGroup({ thread, actions }: { thread: ThreadGroup; actions: RowActions }) {
  const navigate = experimental_useAppNavigate();
  const shared = sharedState(thread.processes);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border-seam px-3 py-2">
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          {thread.state.kind === "deleted" ? (
            <span className="min-w-0 truncate text-sm font-semibold text-foreground">
              {thread.title}
            </span>
          ) : (
            <button
              type="button"
              className={`group/chat flex min-w-0 items-center gap-1 rounded-sm text-left text-sm font-semibold text-foreground hover:text-muted-foreground ${FOCUS_RING_CLASS}`}
              onClick={() => navigate.toThread(thread.threadId)}
            >
              <span className="min-w-0 truncate">{thread.title}</span>
              <Icon
                name="ChevronRight"
                aria-hidden="true"
                className="size-3.5 shrink-0 text-subtle-foreground group-hover/chat:text-muted-foreground"
              />
            </button>
          )}
          {shared === null ? null : <StatusBadge tone={shared.tone}>{shared.text}</StatusBadge>}
          <span className="ml-auto shrink-0 pl-1 text-xs tabular-nums text-muted-foreground">
            {`${formatProcessCount(thread.processes.length)} · ${formatBytes(thread.memoryBytes)}`}
          </span>
        </div>
        {shared === null || shared.hint === null ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{shared.hint}</p>
        )}
      </div>
      <StatusList variant="plain" label={`Processes for ${thread.title}`}>
        {thread.processes.map((row) => (
          <ProcessRow key={rowKey(row)} row={row} actions={actions} showStatus={shared === null} />
        ))}
      </StatusList>
    </div>
  );
}

function MachineSection({ host, actions }: { host: HostGroup; actions: RowActions }) {
  if (host.status === "ok" && host.threads.length === 0 && host.failures.length === 0) return null;

  return (
    <section aria-label={host.name} className="space-y-2.5">
      <div className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name="Laptop" aria-hidden="true" className="size-4 text-subtle-foreground" />
        <h2 className="text-sm font-semibold text-foreground">{host.name}</h2>
        {host.status === "unsupported" && <StatusBadge tone="neutral">Not tracked</StatusBadge>}
        {host.status === "failed" && <StatusBadge tone="error">Scan failed</StatusBadge>}
        {host.lastSuccessfulAt != null && (
          <span className="text-xs text-subtle-foreground">
            {`Last checked ${formatDuration(Date.now() - host.lastSuccessfulAt)} ago`}
          </span>
        )}
      </div>
      {host.status === "unsupported" && (
        <p className="text-sm text-muted-foreground">
          {host.detail ?? "Process tracking is not available on this machine."}
        </p>
      )}
      {host.status === "failed" && (
        <p role="alert" className="text-sm text-destructive-text">
          Could not scan this machine. {host.detail}
        </p>
      )}
      {host.failures.map((failure) => (
        <p key={failure} role="alert" className="text-sm text-destructive-text">
          {failure}
        </p>
      ))}
      {host.threads.map((thread) => (
        <ChatGroup key={thread.threadId} thread={thread} actions={actions} />
      ))}
    </section>
  );
}

function sweepOnlyFailures(list: ListResult): string[] {
  const hostTexts = list.hosts.flatMap((host) => [
    ...host.failures,
    ...(host.detail === null ? [] : [host.detail]),
  ]);

  return (list.lastSweep?.failures ?? []).filter(
    (failure) => !hostTexts.some((text) => failure.endsWith(text)),
  );
}

function RecentStops({ entries }: { entries: readonly HistoryEntry[] }) {
  const [open, setOpen] = useState(readRecentStopsOpen);

  if (entries.length === 0) return null;

  const now = Date.now();
  const shown = entries.slice(0, RECENT_STOPS_SHOWN);

  return (
    <CollapsibleSection
      title="Recent stops"
      count={shown.length}
      countLabel={`${shown.length} recent stops`}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        writeRecentStopsOpen(next);
      }}
      headerClassName="-mx-1.5"
      contentClassName="pt-1.5"
    >
      <StatusList>
        {shown.map((entry) => {
          const failed = entry.outcome === "failed" || entry.outcome === "refused";

          return (
            <StatusRow
              key={`${entry.at}:${entry.command}`}
              tone={failed ? "error" : "neutral"}
              title={
                <span title={entry.command} className="font-mono text-xs">
                  {entry.command}
                </span>
              }
              status={failed ? "Could not stop" : undefined}
              meta={[
                formatBytes(entry.memoryBytes),
                ...(failed ? [] : [STOP_REASON_TEXT.get(entry.reason)]),
                `${formatDuration(now - entry.at)} ago`,
              ]}
              error={failed ? (entry.detail ?? "Could not stop") : undefined}
            />
          );
        })}
      </StatusList>
    </CollapsibleSection>
  );
}

function stopFailure(results: readonly ProcessStopResult[]): string | null {
  const failed = results.flatMap((result) =>
    result.outcome === "refused" || result.outcome === "failed"
      ? [`${result.pid}: ${result.detail ?? "could not stop"}`]
      : [],
  );

  return failed.length === 0 ? null : failed.join("; ");
}

function isEmpty(list: ListResult): boolean {
  return (
    inspectionStatus(list.hosts) === "complete" &&
    list.processCount === 0 &&
    list.cuaResources.length === 0
  );
}

function ErrorNotice({ children, action }: { children: string; action?: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-lg border border-surface-destructive-border bg-surface-destructive px-3 py-2.5 text-sm text-destructive-text"
    >
      <Icon name="AlertCircle" aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
    </div>
  );
}

export function LeftRunningPage({ subPath }: PluginNavPanelProps) {
  const threadId = subPath.split("/")[0] || null;
  const navigate = experimental_useAppNavigate();

  const { rpc, list, history, error, load } = useLeftRunning(threadId, {
    refreshOnOpen: true,
    withHistory: true,
  });

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function run(key: string, task: () => Promise<string | null>): Promise<void> {
    setBusyKey(key);
    setActionError(null);

    try {
      setActionError(await task());
    } catch (failure) {
      setActionError(failure instanceof Error ? failure.message : "That did not work.");
    } finally {
      setBusyKey(null);
      void load(false);
    }
  }

  const actions: RowActions = {
    busyKey,
    stop: (row) => {
      void run(rowKey(row), async () => {
        const response = await rpc.call("stop", {
          hostId: row.hostId,
          identities: [{ pid: row.pid, startedAt: row.startedAt }],
        });

        return stopFailure(response.results);
      });
    },
    keep: (row) => {
      void run(`keep:${rowKey(row)}`, async () => {
        const result = await rpc.call("keep", {
          hostId: row.hostId,
          identity: { pid: row.pid, startedAt: row.startedAt },
        });

        return result.ok ? null : result.detail;
      });
    },
    unkeep: (row) => {
      void run(`keep:${rowKey(row)}`, async () => {
        const result = await rpc.call("unkeep", {
          hostId: row.hostId,
          identity: { pid: row.pid, startedAt: row.startedAt },
        });

        return result.ok ? null : result.detail;
      });
    },
  };

  const stops =
    threadId === null ? history : history.filter((entry) => entry.threadId === threadId);

  const summary = list === null ? null : inspectionSummary(list);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1.5">
            <h1 className="text-lead font-semibold text-foreground">Task Manager</h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
              {list === null || list.autoStop === false
                ? "Servers and scripts that chats started and left behind."
                : `Servers and scripts that chats started and left behind. Each one stops by itself shortly after its chat is archived, or once the chat has been idle for ${list.idleHours} h, unless you keep it.`}
            </p>
            {summary !== null && summary !== "Nothing left running." && (
              <p className="text-sm font-medium text-foreground">{summary}</p>
            )}
          </div>
          {threadId !== null && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => navigate.toPluginPanel(PANEL_PATH)}
            >
              <Icon name="ArrowLeft" aria-hidden="true" />
              Show all chats
            </Button>
          )}
        </header>

        {list?.autoStop === false && (
          <div className="flex items-start gap-2.5 rounded-lg border border-border bg-state-hover px-3 py-2.5 text-sm">
            <Icon
              name="Info"
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <p className="text-muted-foreground">
              <span className="font-medium text-foreground">Auto-stop is off.</span> Nothing here
              stops by itself; stop what you no longer need.
            </p>
          </div>
        )}

        {error !== null && (
          <ErrorNotice
            action={
              <Button
                variant="soft"
                size="xs"
                className="shrink-0"
                onClick={() => {
                  void load(true);
                }}
              >
                Retry
              </Button>
            }
          >
            {error}
          </ErrorNotice>
        )}

        {actionError !== null && <ErrorNotice>{actionError}</ErrorNotice>}

        {list !== null &&
          sweepOnlyFailures(list).map((failure) => (
            <ErrorNotice key={failure}>{failure}</ErrorNotice>
          ))}

        {list === null && error === null && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="Loading" aria-hidden="true" className="size-4" />
            Checking what is still running…
          </p>
        )}

        {list !== null && isEmpty(list) && (
          <EmptyStateBlock
            icon="CircleCheck"
            title="Nothing left running."
            description={
              threadId === null
                ? "No chat has a server or script still running."
                : "This chat has no server or script still running."
            }
            className="rounded-lg border border-dashed border-border"
          />
        )}

        {list !== null && (
          <CuaResources
            resources={list.cuaResources}
            busyKey={busyKey}
            onOpenThread={(id) => navigate.toThread(id)}
            onKeep={(resource) => {
              setBusyKey(`cua:${resource.id}`);
              setActionError(null);
              void (async () => {
                try {
                  await rpc.call("cuaKeep", {
                    resourceId: resource.id,
                    ownerThreadId: resource.ownerThreadId,
                    keep: !resource.keepRequested,
                  });
                  await load(false);
                } catch (failure) {
                  setActionError(
                    failure instanceof Error
                      ? failure.message
                      : "The runtime could not be updated.",
                  );
                } finally {
                  setBusyKey(null);
                }
              })();
            }}
          />
        )}

        {list?.hosts.map((host) => (
          <MachineSection key={host.hostId} host={host} actions={actions} />
        ))}

        <RecentStops entries={stops} />
      </div>
    </div>
  );
}

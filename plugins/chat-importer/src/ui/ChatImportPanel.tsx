import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { experimental_useAppNavigate, useRpc } from "@omnyo/plugin-sdk/app";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyStateBlock } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-row";
import { cn } from "@/lib/utils";
import {
  DEFAULT_DAYS,
  MAX_DAYS,
  type chatImportRpc,
  type HostsOutput,
  type ImportChatOutput,
  type PreviewChat,
  type PreviewOutput,
  type TargetProject,
} from "../contract.js";
import {
  DROP_REASON_LABELS,
  formatRelativeTime,
  projectLabel,
  PROVIDER_LABELS,
  selectionPlan,
} from "../service.js";

export const DAYS_DEBOUNCE_MS = 400;

type PreviewState =
  | { status: "loading"; data: PreviewOutput | null }
  | { status: "error"; message: string; data: PreviewOutput | null }
  | { status: "ready"; data: PreviewOutput };

interface ImportProgress {
  done: number;
  total: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function parseDays(text: string): number | null {
  if (!/^\d+$/u.test(text.trim())) return null;
  const value = Number(text.trim());

  return value >= 1 && value <= MAX_DAYS ? value : null;
}

export function countText(data: PreviewOutput): string {
  const parts = [plural(data.counts.found, "chat found", "chats found")];

  for (const providerId of ["claude-code", "codex"] as const) {
    const found = data.counts.byProvider[providerId].found;

    if (found > 0) parts.push(`${PROVIDER_LABELS[providerId]} ${found}`);
  }

  if (data.counts.alreadyImported > 0) {
    parts.push(`${data.counts.alreadyImported} already imported`);
  }

  return parts.join(" · ");
}

function isDone(result: ImportChatOutput | undefined): boolean {
  return result !== undefined && result.status !== "failed";
}

function ChatRowResult({
  result,
  onOpen,
}: {
  result: ImportChatOutput;
  onOpen: (threadId: string) => void;
}) {
  if (result.status === "failed") {
    return <StatusBadge tone="error">Failed</StatusBadge>;
  }

  const threadId = result.threadId;

  return (
    <span className="flex shrink-0 items-center gap-2">
      <StatusBadge tone={result.status === "imported" ? "success" : "neutral"}>
        {result.status === "imported" ? "Imported" : "Already imported"}
      </StatusBadge>
      {threadId === null ? null : (
        <Button size="xs" variant="soft" onClick={() => onOpen(threadId)}>
          Open
        </Button>
      )}
    </span>
  );
}

function ChatRow({
  chat,
  project,
  nowMs,
  checked,
  disabled,
  result,
  onCheckedChange,
  onOpen,
}: {
  chat: PreviewChat;
  project: TargetProject | null;
  nowMs: number;
  checked: boolean;
  disabled: boolean;
  result: ImportChatOutput | undefined;
  onCheckedChange: (checked: boolean) => void;
  onOpen: (threadId: string) => void;
}) {
  const id = `chat-import-${chat.key}`;
  const ready = chat.status === "ready";

  return (
    <li
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        ready && !disabled && "hover:bg-state-hover",
      )}
    >
      <Checkbox
        id={id}
        className="mt-0.5"
        checked={ready && checked}
        disabled={!ready || disabled}
        aria-label={chat.title}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <div className="min-w-0 flex-1">
        <label
          htmlFor={id}
          className={cn(
            "block min-w-0",
            ready && !disabled ? "cursor-pointer" : "cursor-default",
          )}
        >
          <span
            className={cn(
              "block truncate text-sm",
              ready ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {chat.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {ready && project !== null
              ? [
                  projectLabel(project),
                  PROVIDER_LABELS[chat.providerId],
                  formatRelativeTime(chat.lastMessageAt, nowMs),
                ].join(" · ")
              : [
                  chat.reason ?? "",
                  PROVIDER_LABELS[chat.providerId],
                  formatRelativeTime(chat.lastMessageAt, nowMs),
                ].join(" · ")}
          </span>
        </label>
        {result === undefined || result.message === null ? null : (
          <p
            role={result.status === "failed" ? "alert" : undefined}
            className={cn(
              "mt-1 flex items-start gap-1.5 text-xs",
              result.status === "failed"
                ? "text-destructive-text"
                : "text-muted-foreground",
            )}
          >
            <Icon
              name={result.status === "failed" ? "AlertCircle" : "Info"}
              aria-hidden
              className="mt-0.5 size-3.5 shrink-0"
            />
            <span>{result.message}</span>
          </p>
        )}
        {result?.status === "failed" && result.message === null ? (
          <p role="alert" className="mt-1 text-xs text-destructive-text">
            Import failed.
          </p>
        ) : null}
      </div>
      {result === undefined ? (
        ready ? null : (
          <StatusBadge tone="neutral" className="mt-px">
            Can’t import
          </StatusBadge>
        )
      ) : (
        <ChatRowResult result={result} onOpen={onOpen} />
      )}
    </li>
  );
}

function LoadingRows() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Looking for chats">
      <Skeleton className="h-4 w-56" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export function ChatImportPanel() {
  const rpc = useRpc<typeof chatImportRpc>();
  const navigate = experimental_useAppNavigate();
  const [daysText, setDaysText] = useState(String(DEFAULT_DAYS));
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [hostId, setHostId] = useState<string | undefined>(undefined);
  const [reloadToken, setReloadToken] = useState(0);

  const [state, setState] = useState<PreviewState>({
    status: "loading",
    data: null,
  });

  const [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());

  const [results, setResults] = useState<ReadonlyMap<string, ImportChatOutput>>(
    new Map(),
  );

  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [relisting, setRelisting] = useState(false);
  const [machines, setMachines] = useState<HostsOutput | null>(null);
  const requestRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const parsed = parseDays(daysText);

    if (parsed === null || parsed === days) return;
    const timer = setTimeout(() => setDays(parsed), DAYS_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [daysText, days]);

  useEffect(() => {
    let current = true;
    rpc
      .call("hosts", {})
      .then((next) => {
        if (current) setMachines(next);
      })
      .catch(() => {
        if (current) setMachines(null);
      });

    return () => {
      current = false;
    };
  }, [rpc, reloadToken]);

  useEffect(() => {
    const request = ++requestRef.current;
    setState((current) => ({ status: "loading", data: current.data }));
    rpc
      .call("preview", hostId === undefined ? { days } : { days, hostId })
      .then((data) => {
        if (request !== requestRef.current) return;
        setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (request !== requestRef.current) return;
        setState((current) => ({
          status: "error",
          message: errorMessage(error),
          data: current.data,
        }));
      });
  }, [rpc, days, hostId, reloadToken]);

  const data = state.status === "ready" ? state.data : null;
  const hosts = state.data?.hosts ?? machines?.hosts ?? [];
  const importing = progress !== null && progress.done < progress.total;
  const busy = importing || relisting;

  const selected = useMemo(
    () =>
      (data?.chats ?? []).filter(
        (chat) =>
          chat.status === "ready" &&
          !unticked.has(chat.key) &&
          !isDone(results.get(chat.key)),
      ),
    [data, unticked, results],
  );

  const plan = useMemo(
    () =>
      data === null
        ? null
        : selectionPlan(
            data,
            (chat) => !unticked.has(chat.key) || isDone(results.get(chat.key)),
          ),
    [data, unticked, results],
  );

  const batch = useMemo(
    () =>
      selected.flatMap((chat) => {
        const project = plan?.targets.get(chat.key);

        return project === undefined ? [] : [{ chat, project }];
      }),
    [selected, plan],
  );

  const newProjectNames = useMemo(
    () => [
      ...new Set(
        batch.flatMap(({ project }) =>
          project.kind === "new" ? [project.name] : [],
        ),
      ),
    ],
    [batch],
  );

  const selectable = useMemo(
    () =>
      (data?.chats ?? []).filter(
        (chat) => chat.status === "ready" && !isDone(results.get(chat.key)),
      ),
    [data, results],
  );

  const setAllChecked = useCallback(
    (chats: readonly PreviewChat[], checked: boolean) => {
      setUnticked((current) => {
        const next = new Set(current);

        for (const chat of chats) {
          if (checked) next.delete(chat.key);
          else next.add(chat.key);
        }

        return next;
      });
    },
    [],
  );

  const setChecked = useCallback((key: string, checked: boolean) => {
    setUnticked((current) => {
      const next = new Set(current);

      if (checked) next.delete(key);
      else next.add(key);

      return next;
    });
  }, []);

  async function importSelected(): Promise<void> {
    if (data === null || busy || batch.length === 0) return;
    const queued = batch;
    setProgress({ done: 0, total: queued.length });

    for (const [index, { chat, project }] of queued.entries()) {
      let result: ImportChatOutput;

      try {
        result = await rpc.call("importChat", {
          hostId: data.hostId,
          providerId: chat.providerId,
          sourceProviderThreadId: chat.sourceProviderThreadId,
          sourcePath: chat.sourcePath,
          project,
        });
      } catch (error) {
        result = {
          status: "failed",
          threadId: null,
          projectId: null,
          createdProject: false,
          message: errorMessage(error),
          omittedTurns: 0,
          skippedLines: 0,
        };
      }

      if (mountedRef.current) {
        setResults((current) => new Map(current).set(chat.key, result));
        setProgress({ done: index + 1, total: queued.length });
      }
    }

    if (mountedRef.current) await relist(data);
  }

  async function relist(listed: PreviewOutput): Promise<void> {
    const request = ++requestRef.current;
    setRelisting(true);

    try {
      const next = await rpc.call("preview", {
        days: listed.days,
        hostId: listed.hostId,
      });

      if (mountedRef.current && request === requestRef.current) {
        setState({ status: "ready", data: next });
      }
    } catch (error) {
      if (mountedRef.current && request === requestRef.current) {
        setState({
          status: "error",
          message: errorMessage(error),
          data: listed,
        });
      }
    } finally {
      if (mountedRef.current) setRelisting(false);
    }
  }

  const openThread = useCallback(
    (threadId: string) =>
      navigate.toThread(threadId, { experimental_userInitiated: true }),
    [navigate],
  );

  return (
    <div className="w-full min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          Chats with messages in the last
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_DAYS}
            aria-label="Days"
            aria-invalid={parseDays(daysText) === null}
            className="h-8 w-16"
            value={daysText}
            disabled={busy}
            onChange={(event) => setDaysText(event.target.value)}
          />
          {parseDays(daysText) === 1 ? "day" : "days"}
        </label>
        {hosts.length > 1 ? (
          <Select
            value={
              hostId ?? state.data?.hostId ?? machines?.primaryHostId ?? ""
            }
            disabled={busy}
            onValueChange={(value) => {
              setUnticked(new Set());
              setResults(new Map());
              setProgress(null);
              setHostId(value);
            }}
          >
            <SelectTrigger aria-label="Machine" className="h-8 w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {hosts.map((host) => (
                <SelectItem key={host.id} value={host.id}>
                  {host.connected ? host.name : `${host.name} (offline)`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>

      {state.status === "loading" ? <LoadingRows /> : null}

      {state.status === "error" ? (
        <Alert variant="destructive">
          <Icon name="AlertCircle" aria-hidden />
          <AlertTitle>Couldn’t look for chats</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{state.message}</span>
            <Button
              size="xs"
              variant="soft"
              onClick={() => setReloadToken((token) => token + 1)}
            >
              <Icon name="RotateCcw" aria-hidden />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {data !== null && data.counts.found === 0 ? (
        <div className="rounded-lg border border-border bg-card">
          <EmptyStateBlock
            icon="MessageSquare"
            title="No recent chats"
            description={`No Codex or Claude Code chats with messages in the last ${plural(data.days, "day", "days")}. Try a longer window above.`}
            className="py-8"
          />
          {data.dropped.length > 0 ? (
            <details className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Skipped files
              </summary>
              <ul className="mt-1.5 space-y-0.5">
                {data.dropped.map((drop) => (
                  <li key={`${drop.providerId}:${drop.reason}`}>
                    {PROVIDER_LABELS[drop.providerId]}: {drop.count}{" "}
                    {DROP_REASON_LABELS[drop.reason]}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      {data !== null && data.counts.found > 0 ? (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border border-border bg-card shadow-card">
            <div className="flex min-h-10 items-center gap-3 border-b border-border bg-surface-recessed px-3 py-2">
              <Checkbox
                aria-label="Select all ready chats"
                checked={
                  selectable.length > 0 && selected.length === selectable.length
                }
                disabled={busy || selectable.length === 0}
                onCheckedChange={(value) =>
                  setAllChecked(selectable, value === true)
                }
              />
              <p
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
                role="status"
              >
                {countText(data)}
              </p>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {selected.length} selected
              </span>
            </div>
            <ul
              aria-label="Chats to import"
              className="max-h-80 divide-y divide-border overflow-y-auto"
            >
              {data.chats.map((chat) => (
                <ChatRow
                  key={chat.key}
                  chat={chat}
                  project={plan?.targets.get(chat.key) ?? null}
                  nowMs={data.nowMs}
                  checked={!unticked.has(chat.key)}
                  disabled={busy || isDone(results.get(chat.key))}
                  result={results.get(chat.key)}
                  onCheckedChange={(checked) => setChecked(chat.key, checked)}
                  onOpen={openThread}
                />
              ))}
            </ul>
          </div>
          {newProjectNames.length > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Icon
                name="FolderPlus"
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0"
              />
              <span>New projects: {newProjectNames.join(", ")}</span>
            </p>
          ) : null}
          {importing && progress !== null ? (
            <div className="space-y-1.5" role="status">
              <Progress
                value={(progress.done / progress.total) * 100}
                aria-label="Import progress"
              />
              <p className="text-xs text-muted-foreground tabular-nums">
                Importing {progress.done + 1} of {progress.total}
              </p>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Button
                disabled={relisting || batch.length === 0}
                onClick={() => void importSelected()}
              >
                Import {plural(batch.length, "chat", "chats")}
              </Button>
              <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                Each chat continues where you left off. Your CLI history is not
                changed.
              </p>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

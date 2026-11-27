import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_Icon as Icon,
  UrlLink,
  useComposer,
  useComposers,
  useRealtimeConnectionState,
  useRpc,
  type PluginThreadHeaderActionProps,
} from "@omnyo/plugin-sdk/app";
import type { DevServerRow, DevServerShelf, GlanceRpcContract } from "../contract";
import { Button, buttonClass } from "./ui/button";
import { StatusList, StatusRow, type StatusTone } from "./ui/status-row";
import { useCompactViewport } from "./viewport";

export const devServersPopupId = "dev-servers";

type ServerState = DevServerRow["status"]["state"];

const statusLabels: Record<ServerState, string> = {
  online: "Running",
  stopped: "Stopped",
  starting: "Starting…",
  conflict: "Port in use",
  error: "Didn't start",
  unknown: "Status unknown",
  "host-offline": "Computer offline",
};

const statusTones: Record<ServerState, StatusTone> = {
  online: "active",
  stopped: "neutral",
  starting: "pending",
  conflict: "warning",
  error: "error",
  unknown: "neutral",
  "host-offline": "warning",
};

function relativeAge(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60000);

  if (minutes < 1) return "just now";

  if (minutes < 60) return `${minutes} min ago`;

  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;

  return `${Math.floor(minutes / 1440)} d ago`;
}

function serverHistory(row: DevServerRow, recent: boolean): string | null {
  if (!recent) return null;

  return row.lastObservedOnlineAt === null
    ? "Not seen running yet"
    : `Last seen running ${relativeAge(row.lastObservedOnlineAt)}`;
}

interface ServerGuidance {
  error: string | null;
  hint: string | null;
}

function serverGuidance(
  state: ServerState,
  detail: string | null,
  host: string,
  fresh: boolean,
): ServerGuidance {
  const shown = fresh ? detail : null;

  switch (state) {
    case "error":
      return {
        error: shown ?? "Its start command failed.",
        hint: `Fix the cause, then Restart to run its saved command again on ${host}.`,
      };
    case "stopped":
      return { error: null, hint: shown ?? `Restart runs its saved command again on ${host}.` };
    case "conflict":
      return {
        error: shown,
        hint: `Another app on ${host} already uses this port, and Omnyo won't stop it. Close that app to free the port.`,
      };
    case "host-offline":
      return {
        error: null,
        hint: shown ?? `${host} isn't connected, so this server can't be checked or restarted.`,
      };
    case "unknown":
      return { error: null, hint: shown };
    case "online":
    case "starting":
      return { error: null, hint: null };
  }
}

function ServerRow({
  row,
  recent,
  fresh,
  restarting,
  restart,
  compact,
}: {
  row: DevServerRow;
  recent: boolean;
  fresh: boolean;
  restarting: boolean;
  restart: () => void;
  compact: boolean;
}) {
  const state: ServerState = restarting ? "starting" : fresh ? row.status.state : "unknown";
  const canRestart = state === "stopped" || state === "error";
  const label = new URL(row.preview.url);

  if (label.hostname === "127.0.0.1") label.hostname = "localhost";
  const endpoint = `${label.host}${label.pathname === "/" ? "" : label.pathname}${label.search}${label.hash}`;
  const history = serverHistory(row, recent);
  const guidance = serverGuidance(state, row.status.detail, row.preview.hostName, fresh);

  const actions =
    state === "online" ? (
      <UrlLink
        href={new URL(row.preview.remoteUrl, window.location.href).href}
        className={buttonClass("soft", "xs")}
        aria-label={`Open ${endpoint}`}
      >
        Open
        <Icon name="ArrowUpRight" className="size-3.5" aria-hidden="true" />
      </UrlLink>
    ) : canRestart || state === "starting" ? (
      <Button
        disabled={!canRestart}
        aria-busy={state === "starting"}
        aria-label={`Restart ${endpoint}`}
        onClick={restart}
      >
        {state === "starting" ? (
          <Icon name="Spinner" className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
        ) : (
          <Icon name="RotateCcw" className="size-3.5" aria-hidden="true" />
        )}
        {state === "starting" ? "Starting…" : "Restart"}
      </Button>
    ) : undefined;

  return (
    <StatusRow
      tone={statusTones[state]}
      dense={compact}
      title={<span title={row.preview.url}>{endpoint}</span>}
      status={statusLabels[state]}
      meta={[row.preview.hostName, history]}
      error={guidance.error ?? undefined}
      detail={guidance.hint ?? undefined}
      actions={actions}
    />
  );
}

function useDevServers(threadId: string) {
  const rpc = useRpc<GlanceRpcContract>();
  const connection = useRealtimeConnectionState();
  const [shelf, setShelf] = useState<DevServerShelf | null>(null);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<ReadonlySet<string>>(new Set());
  const pending = useRef(new Map<string, string>());
  const sequence = useRef(0);
  const mounted = useRef(false);
  const latest = useRef(shelf);
  latest.current = shelf;

  const refresh = useCallback(async () => {
    if (document.hidden || pending.current.size > 0) return;
    const current = ++sequence.current;

    try {
      const result = await rpc.call("servers.read", { threadId });

      if (!mounted.current || current !== sequence.current) return;
      setShelf(result);
      setFresh(true);
      setError(null);
    } catch {
      if (!mounted.current || current !== sequence.current) return;
      setFresh(false);
      setError("Could not check dev servers.");
    }
  }, [rpc, threadId]);

  useEffect(() => {
    mounted.current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let pollGeneration = 0;

    const poll = async (generation: number) => {
      await refresh();

      if (disposed || generation !== pollGeneration) return;
      const starting = latest.current?.active.some((row) => row.status.state === "starting");
      timer = setTimeout(() => void poll(generation), starting ? 1000 : 10000);
    };

    const resume = () => {
      setFresh(false);

      if (timer !== undefined) clearTimeout(timer);
      pollGeneration += 1;

      if (!document.hidden) void poll(pollGeneration);
    };

    resume();
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);

    return () => {
      mounted.current = false;
      disposed = true;
      sequence.current += 1;

      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh]);

  useEffect(() => {
    if (connection === "connected") void refresh();
  }, [connection, refresh]);

  useEffect(() => {
    const rows =
      shelf === null ? [] : [...shelf.active, ...(shelf.recent === null ? [] : [shelf.recent])];

    if (rows.length === 0) return;
    const expiresAt = Math.min(...rows.map((row) => row.status.checkedAt)) + 15000;

    const timer = setTimeout(
      () => {
        setFresh(false);
        setError("Server status expired. Retry to check it.");
      },
      Math.max(0, expiresAt - Date.now()),
    );

    return () => clearTimeout(timer);
  }, [shelf]);

  const restart = async (previewId: string) => {
    if (pending.current.has(previewId)) return;
    const requestId = crypto.randomUUID();
    pending.current.set(previewId, requestId);
    setRestarting(new Set(pending.current.keys()));
    const current = ++sequence.current;

    try {
      const result = await rpc.call("servers.restart", { threadId, previewId, requestId });

      if (!mounted.current || current !== sequence.current) return;
      setShelf(result);
      setFresh(true);
      setError(null);
    } catch {
      if (!mounted.current || current !== sequence.current) return;
      setFresh(false);
      setError("Could not start the dev server. Retry checks its current state.");
    } finally {
      pending.current.delete(previewId);

      if (mounted.current) setRestarting(new Set(pending.current.keys()));
    }
  };

  const rows =
    shelf === null ? [] : [...shelf.active, ...(shelf.recent === null ? [] : [shelf.recent])];

  return { shelf, rows, fresh, error, restarting, restart, refresh };
}

export function DevServers({
  threadId,
  presentation = "shelf",
}: {
  threadId: string;
  presentation?: "shelf" | "popup";
}) {
  const { shelf, rows, fresh, error, restarting, restart, refresh } = useDevServers(threadId);

  if (rows.length === 0 && error === null && presentation === "shelf") return null;

  const popup = presentation === "popup";

  return (
    <section
      aria-label="Dev servers"
      className={popup ? "w-full min-w-0 max-w-full p-4" : "mb-1.5 w-full min-w-0 max-w-full"}
    >
      {popup ? (
        <div className="mb-3">
          <h3 className="text-sm font-semibold">Dev servers</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Previews this chat started. Open a running one, or restart one that stopped.
          </p>
        </div>
      ) : (
        <h3 className="sr-only">Dev servers</h3>
      )}
      {rows.length === 0 && error === null ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
          This chat hasn't started a dev server yet.
        </p>
      ) : null}
      {rows.length === 0 ? null : (
        <StatusList label="Dev servers">
          {rows.map((row) => (
            <ServerRow
              key={row.preview.id}
              row={row}
              compact={!popup}
              recent={row.preview.id === shelf?.recent?.preview.id}
              fresh={fresh && Date.now() - row.status.checkedAt < 15000}
              restarting={restarting.has(row.preview.id)}
              restart={() => void restart(row.preview.id)}
            />
          ))}
        </StatusList>
      )}
      {error !== null ? (
        <div
          className="mt-1.5 flex min-h-8 items-center gap-2 rounded-lg bg-surface-recessed py-1 pr-1 pl-2.5 text-xs text-muted-foreground"
          role="status"
        >
          <Icon name="AlertCircle" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{error}</span>
          <Button onClick={() => void refresh()}>Retry</Button>
        </div>
      ) : null}
    </section>
  );
}

export function ComposerDevServers() {
  const composer = useComposer();
  const compact = useCompactViewport();

  return !compact && composer.scope.kind === "thread" ? (
    <DevServers key={composer.scope.threadId} threadId={composer.scope.threadId} />
  ) : null;
}

export function DevServersPopup() {
  const composer = useComposer();

  return composer.scope.kind === "thread" ? (
    <DevServers
      key={composer.scope.threadId}
      threadId={composer.scope.threadId}
      presentation="popup"
    />
  ) : null;
}

function ServerHeader({ threadId }: { threadId: string }) {
  const { rows, fresh, error } = useDevServers(threadId);
  const [openFailed, setOpenFailed] = useState(false);

  const composer = useComposers().find(
    (entry) => entry.scope.kind === "thread" && entry.scope.threadId === threadId,
  );

  if (rows.length === 0 && error === null) return null;
  const current = fresh && rows.every((row) => Date.now() - row.status.checkedAt < 15000);
  const running = current ? rows.filter((row) => row.status.state === "online").length : 0;
  const starting = current && rows.some((row) => row.status.state === "starting");

  const label = openFailed
    ? "Could not open dev servers. Retry"
    : current
      ? `Dev servers, ${running} running, ${rows.length} total`
      : "Dev servers, status unknown";

  return (
    <button
      type="button"
      className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-10"
      aria-label={label}
      aria-haspopup="dialog"
      title={label}
      disabled={composer === undefined}
      onClick={() => {
        if (composer !== undefined)
          setOpenFailed(!composer.experimental_openPopup(devServersPopupId));
      }}
    >
      <Icon name="Server" className="size-4" aria-hidden="true" />
      <span
        aria-hidden="true"
        className={`size-1.5 rounded-full ${running > 0 && !openFailed ? "bg-success" : starting ? "bg-warning" : "bg-muted-foreground"}`}
      />
      <span aria-hidden="true">{openFailed ? "!" : current ? rows.length : "?"}</span>
    </button>
  );
}

export function HeaderDevServers({ threadId, isCompactViewport }: PluginThreadHeaderActionProps) {
  return isCompactViewport ? <ServerHeader key={threadId} threadId={threadId} /> : null;
}

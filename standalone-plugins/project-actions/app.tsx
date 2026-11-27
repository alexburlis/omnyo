import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_useAppContext,
  experimental_useAppNavigate,
  useRealtime,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import type { PluginThreadHeaderActionProps } from "@omnyo/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, Action, Run, State } from "./contract";
import { useProjectActions } from "./state";
import { projectActionsThreadAction, type ThreadActionData } from "./thread-action";
import "./app.css";

const DONE_FLASH_MS = 2500;

const CONFIRM_TIMEOUT_MS = 6000;

type Glyph = "running" | "command" | "link" | "done" | "failed";

function ActionGlyph({ kind }: { kind: Glyph }) {
  return (
    <svg className={`pa-glyph pa-glyph-${kind}`} viewBox="0 0 16 16" aria-hidden="true">
      {kind === "command" ? <path d="M5 3.5v9l7-4.5z" /> : null}
      {kind === "link" ? <path d="M5 11l6-6M6.5 5H11v4.5" /> : null}
      {kind === "running" ? <path d="M8 2.75a5.25 5.25 0 1 1-5.25 5.25" /> : null}
      {kind === "done" ? <path d="M3.5 8.5l3 3 6-7" /> : null}
      {kind === "failed" ? <path d="M8 3.5v5.5M8 12v.25" /> : null}
    </svg>
  );
}

const isBusy = (run: Run | undefined) => run?.status === "running" || run?.status === "stopping";

/** Formats a duration as m:ss, or h:mm:ss from one hour. */
export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, "0");

  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, [ticking]);

  return now;
}

function ActionStatus({ id, run, elapsed }: { id: string; run: Run; elapsed: string | null }) {
  const progress = run.activity?.progress ?? null;
  const text = run.activity?.text ?? (run.status === "stopping" ? "Force quitting" : "Running");

  const meta = [
    progress ? `Step ${progress.current} of ${progress.total}` : null,
    elapsed ? `${elapsed} elapsed` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <span className={`pa-meter${progress ? "" : " pa-meter-indeterminate"}`} aria-hidden="true">
        <span
          className="pa-meter-fill"
          style={
            progress
              ? { width: `${Math.round((progress.current / progress.total) * 100)}%` }
              : undefined
          }
        />
      </span>
      <span id={id} className="pa-status">
        <span className="pa-status-text" role="status">
          {text}
        </span>
        {meta ? <span className="pa-status-meta">{meta}</span> : null}
      </span>
    </>
  );
}

/** The hover card for a status check: its text, and why the last click failed. */
function CheckStatus({ id, state, failure }: { id: string; state: State; failure: string | null }) {
  return (
    <span id={id} className="pa-status">
      <span className="pa-status-text">{state.text}</span>
      {failure ? <span className="pa-status-meta">{failure}</span> : null}
    </span>
  );
}

/** Lists again every `intervalMs` while the page is visible, which runs the status checks. */
function useCheckPolling(actions: Action[], refresh: () => Promise<void>) {
  const intervals = actions.flatMap((action) =>
    action.kind === "command" && action.check ? [action.check.intervalMs] : [],
  );

  const intervalMs = intervals.length ? Math.min(...intervals) : null;

  useEffect(() => {
    if (intervalMs === null) return;

    const poll = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    const timer = setInterval(poll, intervalMs);
    document.addEventListener("visibilitychange", poll);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [intervalMs, refresh]);
}

function useDoneFlash(runs: Run[]) {
  const previous = useRef(new Map<string, Run["status"]>());
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const finished = runs.filter(
      (run) => run.status === "succeeded" && previous.current.get(run.id) === "running",
    );

    previous.current = new Map(runs.map((run) => [run.id, run.status]));

    if (!finished.length) return;
    setFlashing((current) => new Set([...current, ...finished.map((run) => run.id)]));

    const timer = setTimeout(() => {
      setFlashing((current) => {
        const next = new Set(current);

        for (const run of finished) next.delete(run.id);

        return next;
      });
    }, DONE_FLASH_MS);

    return () => clearTimeout(timer);
  }, [runs]);

  return flashing;
}

function ProjectActionsBar({ projectId, compact }: { projectId: string; compact: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = experimental_useAppNavigate();

  const load = useCallback((id: string) => rpc.call("list", { projectId: id }), [rpc]);
  const { snapshot, loadError, refresh } = useProjectActions(projectId, load);
  const [executionError, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<string | null>(null);
  const flashing = useDoneFlash(snapshot.runs);
  const statusIds = useId();
  const now = useNow(snapshot.runs.some(isBusy));
  const error = executionError ?? loadError;
  useCheckPolling(snapshot.actions, refresh);

  const elapsedFor = (run: Run | undefined) =>
    isBusy(run) && run?.startedAt ? formatElapsed(now - run.startedAt) : null;

  useRealtime("changed", () => {
    void refresh();
  });

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), CONFIRM_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [confirming]);

  async function execute(action: Action) {
    setError(null);
    setStarting((current) => new Set([...current, action.id]));

    try {
      const pending = rpc.call("run", { projectId, id: action.id });

      void refresh().finally(() =>
        setStarting((current) => {
          const next = new Set(current);
          next.delete(action.id);

          return next;
        }),
      );

      const result = await pending;

      if (result.status === "failed") setError(`${action.label}: ${result.detail}`);
      else if (result.url && !navigate.openUrl(result.url))
        setError("Omnyo could not open the URL.");
    } catch {
      setError(`Could not run ${action.label}.`);
    }

    await refresh();
  }

  async function forceQuit(action: Action) {
    setConfirming(null);
    setError(null);

    try {
      await rpc.call("stop", { projectId, id: action.id });
    } catch {
      setError(`Could not force quit ${action.label}.`);
    }

    await refresh();
  }

  function button(action: Action) {
    const state = snapshot.runs.find((run) => run.id === action.id);
    const status = state?.status;
    const stopping = status === "stopping";
    const running = status === "running" || stopping || starting.has(action.id);
    const canStop = action.kind === "command" && status === "running";
    const done = flashing.has(action.id) && !running;
    const failed = status === "failed" && !running;
    const elapsed = elapsedFor(state);
    const statusId = `${statusIds}-${action.id}`;
    // While the action runs, its own status replaces the check's.
    const checked = running ? undefined : snapshot.states.find((item) => item.id === action.id);

    const glyph: Glyph = running
      ? "running"
      : done
        ? "done"
        : failed
          ? "failed"
          : action.kind === "command"
            ? "command"
            : "link";

    if (confirming === action.id && canStop)
      return (
        <div
          key={action.id}
          className="pa-group pa-confirm"
          role="group"
          aria-label={`Force quit ${action.label}?`}
          onKeyDown={(event) => {
            if (event.key === "Escape") setConfirming(null);
          }}
        >
          <span className="pa-confirm-text">Quit {action.label}?</span>
          <button
            type="button"
            className="pa-button pa-danger"
            autoFocus
            onClick={() => {
              void forceQuit(action);
            }}
          >
            Force quit
          </button>
          <button type="button" className="pa-button" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      );

    return (
      <div
        key={action.id}
        className={`pa-group${running ? " pa-running" : ""}${done ? " pa-done" : ""}${failed ? " pa-failed" : ""}`}
      >
        <button
          type="button"
          className="pa-button"
          disabled={running}
          aria-busy={running}
          aria-describedby={(state && isBusy(state)) || checked ? statusId : undefined}
          title={running || checked ? undefined : (state?.detail ?? action.label)}
          onClick={() => {
            void execute(action);
          }}
        >
          <ActionGlyph kind={glyph} />
          {stopping ? `Quitting ${action.label}` : action.label}
          {checked ? <span className={`pa-dot pa-dot-${checked.tone}`} aria-hidden="true" /> : null}
          {elapsed ? <span className="pa-elapsed">{elapsed}</span> : null}
        </button>
        {canStop ? (
          <button
            type="button"
            className="pa-button pa-stop"
            aria-label={`Force quit ${action.label}`}
            title={`Force quit ${action.label}`}
            onClick={() => setConfirming(action.id)}
          >
            <svg className="pa-glyph" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
            </svg>
          </button>
        ) : null}
        {state && isBusy(state) ? (
          <ActionStatus id={statusId} run={state} elapsed={elapsed} />
        ) : null}
        {checked ? (
          <CheckStatus
            id={statusId}
            state={checked}
            failure={failed ? (state?.detail ?? null) : null}
          />
        ) : null}
      </div>
    );
  }

  if (!snapshot.actions.length && !error) return null;
  const visible = compact ? [] : snapshot.actions.slice(0, 2);
  const overflow = compact ? snapshot.actions : snapshot.actions.slice(2);

  const overflowBusy = overflow.some(
    (action) =>
      isBusy(snapshot.runs.find((run) => run.id === action.id)) || starting.has(action.id),
  );

  const overflowAttention = overflow.some(
    (action) =>
      !isBusy(snapshot.runs.find((run) => run.id === action.id)) &&
      snapshot.states.some((item) => item.id === action.id && item.tone === "attention"),
  );

  const overflowElapsed = overflow
    .map((action) => elapsedFor(snapshot.runs.find((run) => run.id === action.id)))
    .find(Boolean);

  return (
    <div className="pa-bar" aria-label="Project actions">
      {visible.map(button)}
      {(overflow.length > 0 || error) && (
        <details className="pa-menu">
          <summary aria-label={compact ? "Project actions" : "More project actions"}>
            {overflowBusy ? <ActionGlyph kind="running" /> : null}
            {overflowElapsed ? <span className="pa-elapsed">{overflowElapsed}</span> : null}
            {error ? <ActionGlyph kind="failed" /> : null}
            {overflowAttention ? (
              <span className="pa-dot pa-dot-attention" aria-hidden="true" />
            ) : null}
            {compact ? "Actions" : "More"}
            <svg className="pa-glyph pa-chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 6.5l4 4 4-4" />
            </svg>
          </summary>
          <div className="pa-popover">
            {overflow.map(button)}
            {error && <p role="alert">{error}</p>}
          </div>
        </details>
      )}
    </div>
  );
}

export function ProjectActions({ projectId, isCompactViewport }: PluginThreadHeaderActionProps) {
  return <ProjectActionsBar projectId={projectId} compact={isCompactViewport} />;
}

function useThreadActionData(): ThreadActionData {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId } = experimental_useAppContext();
  const load = useCallback((id: string) => rpc.call("list", { projectId: id }), [rpc]);
  const { snapshot, refresh } = useProjectActions(projectId, load);
  const [confirmingStop, setConfirmingStop] = useState<string | null>(null);

  useRealtime("changed", () => {
    void refresh();
  });

  useEffect(() => {
    if (!confirmingStop) return;
    const timer = setTimeout(() => setConfirmingStop(null), CONFIRM_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [confirmingStop]);

  return useMemo(
    () => ({
      projectId,
      snapshot,
      confirmingStop,
      armStop: setConfirmingStop,
      async execute(id, actionId) {
        const pending = rpc.call("run", { projectId: id, id: actionId });

        void refresh();

        try {
          return await pending;
        } finally {
          await refresh();
        }
      },
      async stop(id, actionId) {
        setConfirmingStop(null);

        try {
          await rpc.call("stop", { projectId: id, id: actionId });
        } finally {
          await refresh();
        }
      },
    }),
    [projectId, snapshot, confirmingStop, rpc, refresh],
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "actions",
    title: "Project actions",
    component: ProjectActions,
  });
  app.slots.experimental_threadAction({
    id: "actions",
    title: "Project actions",
    icon: "Zap",
    group: experimental_THREAD_ACTION_GROUPS.settings,
    useData: useThreadActionData,
    item: ({ thread, data, navigate }) =>
      projectActionsThreadAction({
        thread,
        data,
        openUrl: (url) => navigate.openUrl(url),
        notifyError: (message) => toast.error(message),
      }),
  });
});

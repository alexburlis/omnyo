// Live plan runs a chat started, pinned directly above its composer so the
// newest message area always shows what is executing and one click opens it.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  experimental_useAppNavigate,
  useComposer,
  useRealtime,
  useRpc,
} from "@omnyo/plugin-sdk/app";
import { z } from "zod";
import { planRunsChannel, type planRpcContract, type PlanRuns } from "./plan-contract";
import { Icon } from "./components/ui/icon";
import { cn } from "./lib/utils";

type Run = PlanRuns["runs"][number];

// Blocked, waiting and queued changes do not all arrive as lifecycle events,
// so a visible bar rechecks while it has something to show.
const recheckMs = 15_000;

const changedSchema = z.object({ sourceThreadId: z.string() });

const presentation: Record<Run["kind"], { label: string; icon: string; tone: string }> = {
  running: { label: "Running", icon: "Loading", tone: "text-success" },
  "in-progress": { label: "Waiting", icon: "ListTodo", tone: "text-muted-foreground" },
  blocked: { label: "Blocked", icon: "AlertCircle", tone: "text-warning" },
  pending: { label: "Starting", icon: "Loading", tone: "text-muted-foreground" },
};

function usePlanRuns(sourceThreadId: string) {
  const rpc = useRpc<typeof planRpcContract>();
  const [runs, setRuns] = useState<readonly Run[]>([]);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++sequence.current;

    try {
      const result = await rpc.call("pursue_plan_runs", { sourceThreadId });

      if (current === sequence.current) setRuns(result.runs);
    } catch {
      // Keep the last known rows; the next event, focus or recheck retries.
    }
  }, [rpc, sourceThreadId]);

  useEffect(() => {
    void refresh();

    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
    };

    window.addEventListener("focus", visible);
    document.addEventListener("visibilitychange", visible);

    return () => {
      sequence.current += 1;
      window.removeEventListener("focus", visible);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);

  useEffect(() => {
    if (runs.length === 0) return;

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, recheckMs);

    return () => clearInterval(timer);
  }, [runs.length, refresh]);

  useRealtime(planRunsChannel, (payload) => {
    const changed = changedSchema.safeParse(payload);

    if (changed.success && changed.data.sourceThreadId === sourceThreadId) void refresh();
  });

  return runs;
}

function RunRow({ run, open }: { run: Run; open: (threadId: string) => void }) {
  const { label, icon, tone } = presentation[run.kind];
  const threadId = run.threadId;
  const spinning = run.kind === "running" || run.kind === "pending";

  const body = (
    <>
      <Icon
        name={icon}
        className={cn("size-4 shrink-0", tone, spinning && "motion-safe:animate-spin")}
        aria-hidden
      />
      <span className={cn("shrink-0 text-xs font-medium", tone)}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {run.title}
      </span>
      {run.message !== null && run.kind === "blocked" ? (
        <span className="hidden min-w-0 max-w-[40%] truncate text-xs text-muted-foreground sm:inline">
          {run.message}
        </span>
      ) : null}
      {threadId !== null ? (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-state-hover px-2 py-0.5 text-xs font-medium text-foreground group-hover:bg-state-active">
          Open run
          <Icon name="ArrowUpRight" className="size-3.5" aria-hidden />
        </span>
      ) : null}
    </>
  );

  const rowClass = "group flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left";

  return threadId === null ? (
    <div role="listitem" className={rowClass} title={run.message ?? undefined}>
      {body}
    </div>
  ) : (
    <button
      type="button"
      role="listitem"
      className={cn(
        rowClass,
        "cursor-pointer hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      title={run.message ?? `Open the chat executing ${run.title}`}
      aria-label={`${label}: ${run.title}. Open run`}
      onClick={() => open(threadId)}
    >
      {body}
    </button>
  );
}

function PlanRunList({ sourceThreadId }: { sourceThreadId: string }) {
  const runs = usePlanRuns(sourceThreadId);
  const navigate = experimental_useAppNavigate();

  if (runs.length === 0) return null;

  return (
    <section
      aria-label="Plan runs"
      role="list"
      className="mb-1.5 flex w-full min-w-0 flex-col divide-y divide-border-seam overflow-hidden rounded-lg border border-border bg-card shadow-card"
    >
      {runs.map((run) => (
        <RunRow
          key={run.threadId ?? `${run.title}\n${run.createdAt}`}
          run={run}
          open={(threadId) => navigate.toThread(threadId)}
        />
      ))}
    </section>
  );
}

export function PlanRunBar() {
  const composer = useComposer();

  return composer.scope.kind === "thread" ? (
    <PlanRunList key={composer.scope.threadId} sourceThreadId={composer.scope.threadId} />
  ) : null;
}

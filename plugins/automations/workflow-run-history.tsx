import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import {
  ResourceListPanel,
  ResourceListState,
} from "@/components/ui/resource-list";
import { DISCLOSURE_CHEVRON_TRANSITION } from "@/components/ui/motion";
import { StatusBadge } from "@/components/ui/status-row";
import { cn } from "@/lib/utils";
import type { AutomationRunResponse } from "./src/rpc-types";
import { parseWorkflowRunResult } from "./lib/workflow-week.js";

type RunTone = "running" | "ready" | "partial" | "failed" | "muted";

function describeRun(run: AutomationRunResponse) {
  const result = parseWorkflowRunResult(run.output);

  const tone: RunTone =
    run.status === "running"
      ? "running"
      : run.status === "failed" || run.error
        ? "failed"
        : result?.contentStatus === "complete"
          ? "ready"
          : result?.contentStatus === "partial"
            ? "partial"
            : "muted";

  const label =
    run.status === "running"
      ? "Writing and reviewing with your selected model…"
      : result?.contentStatus === "complete"
        ? "Ready to read"
        : result?.contentStatus === "partial"
          ? "This week is incomplete"
          : STATUS_LABEL[run.status];

  return { result, tone, label };
}

const STATUS_LABEL: Record<AutomationRunResponse["status"], string> = {
  running: "Running",
  succeeded: "Finished",
  failed: "Run failed",
  skipped: "Skipped",
  recovered: "Recovered",
};

function guidance(contentError: string) {
  const reason = `${contentError.replace(/[.]+$/, "")}.`;

  if (contentError.startsWith("Candidate budget exhausted"))
    return `${reason} This copy has used its candidate limit for the week. To try a revised brief now, import a new copy with distinct product facts.`;

  return `${reason} Open Technical details below to see what happened.`;
}

function RunGlyph({ tone }: { tone: RunTone }) {
  if (tone === "running")
    return (
      <Icon
        name="Loading"
        className="size-4 animate-spin text-muted-foreground"
        aria-hidden
      />
    );

  return (
    <Icon
      name={
        tone === "ready"
          ? "CircleCheck"
          : tone === "failed"
            ? "CircleX"
            : tone === "partial"
              ? "AlertCircle"
              : "Clock"
      }
      className={cn(
        "size-4",
        tone === "ready" && "text-success",
        tone === "failed" && "text-destructive",
        tone === "partial" && "text-warning",
        tone === "muted" && "text-muted-foreground",
      )}
      aria-hidden
    />
  );
}

const runDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function RunRow({
  run,
  showing,
  loading,
  onLoad,
}: {
  run: AutomationRunResponse;
  showing: boolean;
  loading: boolean;
  onLoad: () => void;
}) {
  const { result, tone, label } = describeRun(run);

  return (
    <div className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-3 gap-y-1 py-3">
      <span className="mt-0.5 flex items-start">
        <RunGlyph tone={tone} />
      </span>
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 text-sm text-foreground">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">
              {" · "}
              <time dateTime={new Date(run.scheduledFor).toISOString()}>
                {runDate.format(run.scheduledFor)}
              </time>
              {" · "}
              {run.trigger === "manual" ? "Started manually" : "Scheduled"}
            </span>
          </p>
          {result?.contentStatus === "complete" &&
            (showing ? (
              <StatusBadge tone="neutral" className="gap-1">
                <Icon name="Eye" className="size-3" aria-hidden />
                Showing above
              </StatusBadge>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="soft"
                disabled={loading}
                onClick={onLoad}
              >
                <Icon name="FileText" aria-hidden />
                Open drafts
              </Button>
            ))}
        </div>
        {result?.contentError && (
          <p
            role="status"
            className="text-xs leading-relaxed text-muted-foreground"
          >
            {guidance(result.contentError)}
          </p>
        )}
        {run.skipReason && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {run.skipReason}
          </p>
        )}
        {run.error && run.error !== result?.contentError && (
          <p className="text-xs leading-relaxed text-destructive-text">
            {run.error}
          </p>
        )}
        {run.output && (
          <details className="group text-xs">
            <summary className="inline-flex cursor-default select-none items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60">
              <Icon
                name="ChevronRight"
                className={cn(
                  "size-3 group-open:rotate-90",
                  DISCLOSURE_CHEVRON_TRANSITION,
                )}
                aria-hidden
              />
              Technical details
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-recessed px-3 py-2 font-mono text-2xs text-muted-foreground">
              {run.output}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}

export function WorkflowRunHistory({
  runs,
  hasAutomation,
  showingRunId,
  loadingRunId,
  onLoad,
  onRefresh,
}: {
  runs: readonly AutomationRunResponse[] | undefined;
  hasAutomation: boolean;
  showingRunId: string | null;
  loadingRunId: string | null;
  onLoad: (runId: string) => void;
  onRefresh: () => void;
}) {
  let body;

  if (!hasAutomation) {
    body = (
      <ResourceListState
        state="empty"
        message="No runs yet. Run it once to write and review this week’s drafts."
      />
    );
  } else if (runs === undefined) {
    body = (
      <DelayedLoading>
        <ResourceListState
          state="loading"
          message="Loading runs"
          loadingRows={2}
        />
      </DelayedLoading>
    );
  } else if (runs.length === 0) {
    body = (
      <ResourceListState
        state="empty"
        message="No runs yet. Run it once to write and review this week’s drafts."
      />
    );
  } else {
    body = (
      <ResourceListPanel>
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            showing={run.id === showingRunId}
            loading={loadingRunId !== null}
            onLoad={() => onLoad(run.id)}
          />
        ))}
      </ResourceListPanel>
    );
  }

  return (
    <section aria-labelledby="workflow-run-history" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 id="workflow-run-history" className="text-sm font-semibold">
          Run history
        </h3>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={!hasAutomation}
          onClick={onRefresh}
          className="-mr-2 text-muted-foreground"
        >
          <Icon name="ArrowReloadHorizontal" aria-hidden />
          Refresh runs
        </Button>
      </div>
      {body}
    </section>
  );
}

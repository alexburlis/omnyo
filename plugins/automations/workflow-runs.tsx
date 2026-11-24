import { useEffect, useMemo, useState } from "react";
import { useRpc } from "@omnyo/plugin-sdk/app";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { DelayedLoading } from "@/components/ui/delayed-loading";
import { DISCLOSURE_CHEVRON_TRANSITION } from "@/components/ui/motion";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { automationRpcContract } from "./src/rpc";
import type { workflowRpcContract } from "./src/workflow-contract";
import { errorMessage, saveFile, type Copy } from "./workflow-panel-shared";
import {
  parseWorkflowRunResult,
  readWorkflowWeek,
  type WorkflowArtifactFile,
} from "./lib/workflow-week.js";
import { WorkflowDraftReader } from "./workflow-draft-reader.js";
import { WorkflowRunHistory } from "./workflow-run-history.js";
import { ErrorNote } from "./workflow-setup.js";

type RunList = z.output<
  (typeof automationRpcContract)["automations_runs"]["output"]
>;

function ReaderSkeleton() {
  return (
    <div
      role="status"
      className="space-y-4 rounded-xl border border-border bg-card px-4 py-5 sm:px-6"
    >
      <span className="sr-only">Loading drafts</span>
      <div aria-hidden className="space-y-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-5 w-56" />
      </div>
      <div aria-hidden className="flex gap-1">
        {Array.from({ length: 7 }, (_, index) => (
          <Skeleton key={index} className="h-14 flex-1 rounded-lg" />
        ))}
      </div>
      <div aria-hidden className="mx-auto max-w-prose space-y-2 pt-2">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}

export function WorkflowRunsLayout({
  copy,
  files,
  filesRunId,
  runs,
  writing,
  loadingRunId,
  error,
  onLoad,
  onRefresh,
}: {
  copy: Copy;
  files: readonly WorkflowArtifactFile[];
  filesRunId: string | null;
  runs: RunList["runs"] | undefined;
  writing: boolean;
  loadingRunId: string | null;
  error: string;
  onLoad: (runId: string) => void;
  onRefresh: () => void;
}) {
  const week = useMemo(() => readWorkflowWeek(files), [files]);
  const startup = copy.bindings?.inputs.startup;

  const subject =
    typeof startup === "string" && startup.trim()
      ? `${copy.package.title} · ${startup.trim()}`
      : copy.package.title;

  return (
    <div className="space-y-5">
      {writing && files.length === 0 && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 shadow-card sm:px-6"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-state-hover">
            <Icon
              name="Loading"
              className="size-4 animate-spin text-muted-foreground"
              aria-hidden
            />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              Writing and reviewing with your selected model…
            </p>
            <p className="text-xs text-muted-foreground">
              Drafts appear here once every one has passed review. The run keeps
              going if you leave this page.
            </p>
          </div>
        </div>
      )}
      {loadingRunId !== null && files.length === 0 && (
        <DelayedLoading>
          <ReaderSkeleton />
        </DelayedLoading>
      )}
      {week.drafts.length > 0 && (
        <WorkflowDraftReader
          key={filesRunId ?? "drafts"}
          drafts={week.drafts}
          heading={
            week.drafts.length === 7
              ? "Your week is ready"
              : "Your reviewed drafts"
          }
          subject={subject}
          timezone={week.timezone}
          calendarProblem={week.calendarProblem}
          onDownload={(draft) => saveFile(draft.content, draft.name)}
        />
      )}
      {files.length > 0 && (
        <details className="group rounded-lg border border-border bg-card px-4 py-2 shadow-card">
          <summary className="flex cursor-default select-none items-center gap-1.5 rounded-sm py-1 text-sm text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring/60">
            <Icon
              name="ChevronRight"
              className={cn(
                "size-3.5 text-muted-foreground group-open:rotate-90",
                DISCLOSURE_CHEVRON_TRANSITION,
              )}
              aria-hidden
            />
            <Icon
              name="Download"
              className="size-3.5 text-muted-foreground"
              aria-hidden
            />
            Download drafts and calendar
            <span className="ml-auto text-xs text-muted-foreground">
              {files.length} {files.length === 1 ? "file" : "files"}
            </span>
          </summary>
          <div className="flex flex-wrap gap-2 pb-2 pt-3">
            {files.map((file) => (
              <Button
                key={file.name}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => saveFile(file.content, file.name)}
              >
                <Icon
                  name={file.name.endsWith(".md") ? "FileText" : "File"}
                  className="size-3.5"
                  aria-hidden
                />
                {file.name}
              </Button>
            ))}
          </div>
        </details>
      )}
      <WorkflowRunHistory
        runs={runs}
        hasAutomation={Boolean(copy.automationId)}
        showingRunId={files.length > 0 ? filesRunId : null}
        loadingRunId={loadingRunId}
        onLoad={onLoad}
        onRefresh={onRefresh}
      />
      {error && <ErrorNote>{error}</ErrorNote>}
    </div>
  );
}

export function WorkflowRuns({
  copy,
  firstRun,
}: {
  copy: Copy;
  firstRun: string;
}) {
  const workflows = useRpc<typeof workflowRpcContract>();
  const rpc = useRpc<typeof automationRpcContract>();
  const [files, setFiles] = useState<WorkflowArtifactFile[]>([]);
  const [filesRunId, setFilesRunId] = useState<string | null>(null);
  const [loadingRunId, setLoadingRunId] = useState<string | null>(null);
  const [list, setList] = useState<RunList>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!copy.automationId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const automationId = copy.automationId;

    async function load() {
      try {
        const value = await rpc.call("automations_runs", {
          projectId: copy.projectId,
          automationId,
          limit: 20,
        });

        if (!active) return;
        setList(value);

        const run = firstRun
          ? value.runs.find((row) => row.id === firstRun)
          : value.runs[0];

        if (run?.status === "running") {
          timer = setTimeout(() => void load(), 2500);
        } else if (
          run &&
          parseWorkflowRunResult(run.output)?.contentStatus === "complete"
        ) {
          setLoadingRunId(run.id);

          const data = await workflows.call("workflow_artifacts", {
            projectId: copy.projectId,
            importId: copy.importId,
            runId: run.id,
          });

          if (!active) return;
          setFiles(data.files);
          setFilesRunId(run.id);
          setLoadingRunId(null);
        }
      } catch (reason) {
        if (!active) return;
        setError(errorMessage(reason));
        setLoadingRunId(null);
      }
    }

    setFiles([]);
    setFilesRunId(null);
    setError("");
    void load();

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    copy.automationId,
    copy.projectId,
    copy.importId,
    firstRun,
    refresh,
    rpc,
    workflows,
  ]);

  const target = firstRun
    ? list?.runs.find((row) => row.id === firstRun)
    : list?.runs[0];

  return (
    <WorkflowRunsLayout
      copy={copy}
      files={files}
      filesRunId={filesRunId}
      runs={copy.automationId ? list?.runs : []}
      writing={target?.status === "running"}
      loadingRunId={loadingRunId}
      error={error}
      onRefresh={() => setRefresh(refresh + 1)}
      onLoad={(runId) => {
        setError("");
        setLoadingRunId(runId);
        void workflows
          .call("workflow_artifacts", {
            projectId: copy.projectId,
            importId: copy.importId,
            runId,
          })
          .then(
            (value) => {
              setFiles(value.files);
              setFilesRunId(runId);
            },
            (reason: unknown) => setError(errorMessage(reason)),
          )
          .finally(() => setLoadingRunId(null));
      }}
    />
  );
}

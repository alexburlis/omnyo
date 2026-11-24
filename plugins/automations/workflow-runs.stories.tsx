import type { ReactNode } from "react";
import template from "./workflow-fixtures/weekly-content-feed.json";
import { workflowPackageSchema } from "./src/workflow-package";
import type { AutomationRunResponse } from "./src/rpc-types";
import { FIXTURE_FILES, FIXTURE_LABEL } from "./src/workflow-week-fixture";
import type { Copy } from "./workflow-panel-shared";
import { WorkflowRunsLayout } from "./workflow-runs";

export default { title: "Automations/Workflow runs" };

const DIGEST = "0".repeat(64);

const COPY: Copy = {
  importId: "imp_story",
  projectId: "proj_story",
  graphId: "graph_story",
  graphVersion: 1,
  automationId: "auto_story",
  package: workflowPackageSchema.parse(template),
  packageDigest: DIGEST,
  executionDigest: DIGEST,
  bindingRevision: 1,
  bindings: {
    hostId: "host_story",
    providerId: "codex",
    model: "codex",
    inputs: { startup: "Mosslight Workshop" },
  },
  confirmation: DIGEST,
};

function run(
  id: string,
  overrides: Partial<AutomationRunResponse>,
): AutomationRunResponse {
  return {
    id,
    automationId: "auto_story",
    runMode: "workflow",
    threadId: null,
    status: "succeeded",
    trigger: "manual",
    skipReason: null,
    error: null,
    output: null,
    exitCode: null,
    scheduledFor: Date.UTC(2026, 10, 22, 8, 30),
    startedAt: Date.UTC(2026, 10, 22, 8, 30),
    finishedAt: Date.UTC(2026, 10, 22, 8, 41),
    ...overrides,
  };
}

const COMPLETE = run("run_complete", {
  output: JSON.stringify({ graphRunId: "gr_1", contentStatus: "complete" }),
});

const PARTIAL = run("run_partial", {
  trigger: "schedule",
  scheduledFor: Date.UTC(2026, 10, 15, 8),
  startedAt: Date.UTC(2026, 10, 15, 8),
  output: JSON.stringify({
    graphRunId: "gr_0",
    contentStatus: "partial",
    contentError: "Candidate budget exhausted: 5/7 drafts accepted",
  }),
});

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-6">
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
        {FIXTURE_LABEL}
      </p>
      {children}
    </div>
  );
}

const noop = () => {};

export const ReadyWeek = () => (
  <Frame>
    <WorkflowRunsLayout
      copy={COPY}
      files={FIXTURE_FILES}
      filesRunId="run_complete"
      runs={[COMPLETE, PARTIAL]}
      writing={false}
      loadingRunId={null}
      error=""
      onLoad={noop}
      onRefresh={noop}
    />
  </Frame>
);

export const Writing = () => (
  <Frame>
    <WorkflowRunsLayout
      copy={COPY}
      files={[]}
      filesRunId={null}
      runs={[
        run("run_running", { status: "running", finishedAt: null }),
        PARTIAL,
      ]}
      writing
      loadingRunId={null}
      error=""
      onLoad={noop}
      onRefresh={noop}
    />
  </Frame>
);

export const LoadingDrafts = () => (
  <Frame>
    <WorkflowRunsLayout
      copy={COPY}
      files={[]}
      filesRunId={null}
      runs={[COMPLETE]}
      writing={false}
      loadingRunId="run_complete"
      error=""
      onLoad={noop}
      onRefresh={noop}
    />
  </Frame>
);

export const NoRunsAndError = () => (
  <Frame>
    <WorkflowRunsLayout
      copy={{ ...COPY, automationId: null }}
      files={[]}
      filesRunId={null}
      runs={[]}
      writing={false}
      loadingRunId={null}
      error="The automation service is unavailable."
      onLoad={noop}
      onRefresh={noop}
    />
  </Frame>
);

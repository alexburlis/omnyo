import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceDiffTarget } from "@omnyo/domain";
import type { EnvironmentDiffFilesResponse } from "@omnyo/server-contract";
import type { DiffPresentation } from "@/components/code/code-rendering";
import {
  environmentDiffFilesQueryKey,
  environmentDiffTargetKey,
} from "@/hooks/queries/query-keys";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { GitDiffTabContent } from "./ThreadSecondaryPanelTabContent";

export default {
  title: "right-panel/Diff tab states",
};

const PRESENTATION: DiffPresentation = {
  view: "unified",
  overflow: "scroll",
  showLineNumbers: true,
};

type DiffStoryData =
  | { kind: "response"; response: EnvironmentDiffFilesResponse }
  | { kind: "error"; error: Error };

function DiffTabStage({
  environmentId,
  target,
  data,
  fileFilter = "",
}: {
  environmentId: string;
  target: WorkspaceDiffTarget;
  data: DiffStoryData;
  fileFilter?: string;
}) {
  const [queryClient] = useState(() => {
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          retryOnMount: false,
          refetchOnMount: false,
          refetchOnWindowFocus: false,
          staleTime: Infinity,
        },
      },
    });

    const queryKey = environmentDiffFilesQueryKey(
      environmentId,
      target.type,
      environmentDiffTargetKey(target),
    );

    if (data.kind === "response") {
      client.setQueryData(queryKey, data.response);
    } else {
      const query = client.getQueryCache().build(client, { queryKey });
      query.setState({
        ...query.state,
        status: "error",
        error: data.error,
        errorUpdatedAt: Date.now(),
        fetchStatus: "idle",
      });
    }

    return client;
  });

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-[320px] w-full max-w-[640px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-sidebar pt-3">
        <GitDiffTabContent
          environmentId={environmentId}
          target={target}
          isPanelOpen
          gitDiffPresentation={PRESENTATION}
          fileFilter={fileFilter}
        />
      </div>
    </QueryClientProvider>
  );
}

const EMPTY_AVAILABLE: EnvironmentDiffFilesResponse = {
  outcome: "available",
  files: [],
  truncated: false,
  shortstat: "",
  mergeBaseRef: null,
  initialPatches: [],
};

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="no uncommitted changes"
        hint="the workspace is clean; the title says which comparison is empty"
      >
        <DiffTabStage
          environmentId="env_story_clean"
          target={{ type: "uncommitted" }}
          data={{ kind: "response", response: EMPTY_AVAILABLE }}
        />
      </StoryRow>
      <StoryRow
        label="nothing committed on the branch"
        hint="branch comparison with nothing committed yet"
      >
        <DiffTabStage
          environmentId="env_story_branch"
          target={{ type: "branch_committed", mergeBaseBranch: "main" }}
          data={{ kind: "response", response: EMPTY_AVAILABLE }}
        />
      </StoryRow>
      <StoryRow label="load failed" hint="the diff file list request failed">
        <DiffTabStage
          environmentId="env_story_error"
          target={{ type: "uncommitted" }}
          data={{
            kind: "error",
            error: new Error("The host daemon did not answer within 10s."),
          }}
        />
      </StoryRow>
      <StoryRow
        label="workspace unavailable"
        hint="the workspace path is missing on its machine"
      >
        <DiffTabStage
          environmentId="env_story_unavailable"
          target={{ type: "uncommitted" }}
          data={{
            kind: "response",
            response: {
              outcome: "unavailable",
              failure: {
                code: "path_not_found",
                workspacePath: "/Users/developer/worktrees/omnyo/old-lane",
                message:
                  "The folder /Users/developer/worktrees/omnyo/old-lane no longer exists.",
              },
            },
          }}
        />
      </StoryRow>
      <StoryRow
        label="not a Git workspace"
        hint="the environment is a plain folder"
      >
        <DiffTabStage
          environmentId="env_story_not_git"
          target={{ type: "uncommitted" }}
          data={{
            kind: "response",
            response: {
              outcome: "not_applicable",
              reason: "non_git_environment",
              message: "This environment is not a Git repository.",
            },
          }}
        />
      </StoryRow>
    </StoryCard>
  );
}

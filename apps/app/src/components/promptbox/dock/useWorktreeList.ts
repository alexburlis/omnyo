import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { ReuseThreadOption } from "@/components/pickers/ReuseEnvironmentPicker";
import { sdk } from "@/lib/sdk";

const WORKTREE_PLUGIN_ID = "environment-git-worktree";

const LIST_WORKTREES_METHOD = "listExistingWorktrees";

const WORKTREE_LIST_STALE_MS = 30_000;

const localWorktreesSchema = z.object({
  worktrees: z.array(
    z.object({
      path: z.string().min(1),
      branch: z.string().nullable(),
      prunable: z.boolean(),
    }),
  ),
});

export type LocalWorktree = z.infer<
  typeof localWorktreesSchema
>["worktrees"][number];

export type WorktreeRow =
  | {
      kind: "environment";
      environmentId: string;
      label: string;
      branch: string | null;
      path: string | null;
    }
  | { kind: "local"; path: string; branch: string | null; prunable: boolean };

export type WorktreeList =
  | { status: "loading" | "ready"; rows: readonly WorktreeRow[] }
  | { status: "failed"; rows: readonly WorktreeRow[]; message: string };

const NO_LOCAL_WORKTREES: readonly LocalWorktree[] = [];

function compareLocal(left: LocalWorktree, right: LocalWorktree): number {
  if (left.branch !== null && right.branch !== null) {
    return left.branch.localeCompare(right.branch);
  }

  if (left.branch !== null) return -1;

  if (right.branch !== null) return 1;

  return left.path.localeCompare(right.path);
}

export function mergeWorktreeRows(
  environments: readonly ReuseThreadOption[],
  local: readonly LocalWorktree[],
  hostId: string,
): readonly WorktreeRow[] {
  const onHost = environments.filter((option) => option.hostId === hostId);
  const heldPaths = new Set(onHost.map((option) => option.path));

  return [
    ...onHost.map((option): WorktreeRow => ({
      kind: "environment",
      environmentId: option.environmentId,
      label: option.name ?? option.branchName ?? option.environmentId,
      branch: option.branchName,
      path: option.path,
    })),
    ...local
      .filter((worktree) => !heldPaths.has(worktree.path))
      .sort(compareLocal)
      .map((worktree): WorktreeRow => ({
        kind: "local",
        path: worktree.path,
        branch: worktree.branch,
        prunable: worktree.prunable,
      })),
  ];
}

export function useWorktreeList({
  projectId,
  hostId,
  hostName,
  environments,
  enabled,
}: {
  projectId: string;
  hostId: string;
  hostName: string;
  environments: readonly ReuseThreadOption[];
  enabled: boolean;
}): WorktreeList {
  const query = useQuery({
    queryKey: [
      "plugins",
      WORKTREE_PLUGIN_ID,
      LIST_WORKTREES_METHOD,
      projectId,
      hostId,
    ],
    queryFn: ({ signal }) =>
      sdk.plugins.callRpc({
        pluginId: WORKTREE_PLUGIN_ID,
        method: LIST_WORKTREES_METHOD,
        input: { projectId, hostId },
        outputSchema: localWorktreesSchema,
        signal,
      }),
    enabled,
    staleTime: WORKTREE_LIST_STALE_MS,
    retry: false,
  });

  const rows = mergeWorktreeRows(
    environments,
    query.data?.worktrees ?? NO_LOCAL_WORKTREES,
    hostId,
  );

  if (query.data !== undefined) return { status: "ready", rows };

  return query.isError
    ? {
        status: "failed",
        rows,
        message: `Couldn't list worktrees on the ${hostName}.`,
      }
    : { status: "loading", rows };
}

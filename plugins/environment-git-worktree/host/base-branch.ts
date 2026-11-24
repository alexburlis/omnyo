import {
  hasRef,
  readBranchRelation,
  readDefaultBranchRefs,
  resolveDefaultBaseBranch,
} from "omnyo-environment-provider-host/git";
import type { WorktreeBaseBranch } from "../contract.js";

export interface ResolvedWorktreeBaseBranch {
  ref: string;
  fetchFailureFallback: boolean;
}

function resolvedBaseBranch(
  ref: string | null,
  automaticRemoteRef: string | null,
): ResolvedWorktreeBaseBranch | null {
  if (ref === null) return null;

  return { ref, fetchFailureFallback: ref === automaticRemoteRef };
}

async function resolveNamedBaseBranch(
  sourcePath: string,
  name: string,
): Promise<ResolvedWorktreeBaseBranch | null> {
  if (
    name.startsWith("refs/") ||
    (await hasRef(sourcePath, `refs/remotes/${name}`))
  ) {
    return resolvedBaseBranch(name, null);
  }

  const [hasLocalBranch, hasRemoteBranch] = await Promise.all([
    hasRef(sourcePath, `refs/heads/${name}`),
    hasRef(sourcePath, `refs/remotes/origin/${name}`),
  ]);

  if (!hasRemoteBranch) return resolvedBaseBranch(name, null);

  const localBranch = hasLocalBranch ? name : null;
  const remoteBranch = `origin/${name}`;

  return resolvedBaseBranch(
    resolveDefaultBaseBranch({
      defaultBranch: localBranch,
      originDefaultBranch: remoteBranch,
      defaultBranchRelation:
        (await readBranchRelation(
          sourcePath,
          localBranch ?? undefined,
          remoteBranch,
        )) ?? null,
    }),
    remoteBranch,
  );
}

export async function resolveWorktreeBaseBranch(
  sourcePath: string,
  requested: WorktreeBaseBranch,
): Promise<ResolvedWorktreeBaseBranch | null> {
  if (requested.kind === "named") {
    return resolveNamedBaseBranch(sourcePath, requested.name);
  }

  const refs = await readDefaultBranchRefs(sourcePath);
  const originDefaultBranch = refs.originDefaultBranch ?? null;

  const resolved = resolveDefaultBaseBranch({
    defaultBranch: refs.defaultBranch ?? null,
    defaultBranchRelation: refs.defaultBranchRelation ?? null,
    originDefaultBranch,
  });

  return resolved && resolved !== (refs.defaultBranch ?? null)
    ? resolvedBaseBranch(resolved, originDefaultBranch)
    : null;
}

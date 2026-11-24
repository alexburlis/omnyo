import { purgeWorktree, deleteBranches, primaryCheckout } from "./git.js";
import type { CleanupItem, CleanupResult } from "./cleanup-plan.js";

export async function runCleanup(
  items: CleanupItem[],
  beforeItem: (item: CleanupItem) => string[] | Promise<string[]>,
  progress: (done: number) => void,
  chatTargets?: ReadonlySet<string>,
): Promise<CleanupResult> {
  const repositories = new Map<
    string,
    {
      item: CleanupItem;
      index: number;
    }[]
  >();

  const deletedBranches = new Map<string, Set<string>>();

  for (const [index, item] of items.entries()) {
    let repository = repositories.get(item.repo);

    if (!repository) repositories.set(item.repo, (repository = []));
    repository.push({ item, index });

    if (item.kind === "branch") {
      let names = deletedBranches.get(item.repo);

      if (!names) deletedBranches.set(item.repo, (names = new Set()));
      names.add(item.target);
    }
  }

  if (items.some((item) => deletedBranches.get(item.repo)?.has(item.base)))
    throw new Error(
      "Cleanup plan would delete a retained branch. Review it again.",
    );

  const removableSources = new Set(
    items.flatMap((item) =>
      item.kind === "folder" && item.target === item.repo ? [item.repo] : [],
    ),
  );

  const executionRepos = new Map<string, string>();

  const outcomes: (
    | {
        freedBytes: number | null;
      }
    | {
        reason: string;
      }
  )[] = [];

  let done = 0;

  for (const kind of ["folder", "branch"] as const) {
    const batches = [...repositories.values()].flatMap((repository) => {
      const batch = repository.filter(({ item }) => item.kind === kind);

      return batch.length ? [batch] : [];
    });

    let cursor = 0;

    async function worker() {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        const approvedBranches: typeof batch = [];

        for (const { item, index } of batch) {
          try {
            const protectedPaths = await beforeItem(item);

            if (item.kind === "branch") {
              approvedBranches.push({ item, index });
              continue;
            }

            let repo = executionRepos.get(item.repo) ?? item.repo;

            if (
              removableSources.has(item.repo) &&
              !executionRepos.has(item.repo)
            ) {
              repo = await primaryCheckout(item.repo);
              executionRepos.set(item.repo, repo);
            }

            outcomes[index] = await purgeWorktree(
              repo,
              item.target,
              item.head,
              protectedPaths,
              item.base,
              chatTargets,
            );
          } catch (error) {
            outcomes[index] = {
              reason: error instanceof Error ? error.message : String(error),
            };
          }

          progress(++done);
        }

        if (!approvedBranches.length) continue;
        const source = approvedBranches[0].item.repo;

        try {
          const results = await deleteBranches(
            executionRepos.get(source) ?? source,
            approvedBranches.map(({ item }) => item),
            chatTargets,
          );

          for (const { item, index } of approvedBranches) {
            const reason = results.get(item.target);
            outcomes[index] =
              reason === null
                ? { freedBytes: null }
                : { reason: reason ?? "Git deletion outcome is unknown." };
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);

          for (const { index } of approvedBranches)
            outcomes[index] = { reason };
        }

        done += approvedBranches.length;
        progress(done);
      }
    }

    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, batches.length) }, () => worker()),
    );

    for (const result of workers)
      if (result.status === "rejected") throw result.reason;
  }

  const result: CleanupResult = { removed: [], skipped: [] };

  for (const [index, item] of items.entries()) {
    const outcome = outcomes[index];

    if ("reason" in outcome)
      result.skipped.push({ ...item, reason: outcome.reason });
    else result.removed.push({ ...item, freedBytes: outcome.freedBytes });
  }

  return result;
}

import type { Repo } from "./git.js";

export type CleanupItem = {
  projectId: string;
  projectName: string;
  repo: string;
  kind: "folder" | "branch";
  target: string;
  head: string;
  base: string;
  estimatedBytes: number | null;
};

export function planCleanup(
  entries: {
    projectId: string;
    projectName: string;
    repo: Repo;
  }[],
) {
  const items: CleanupItem[] = [];

  for (const entry of entries) {
    const { repo } = entry;

    const removable = repo.worktrees.filter(
      (w) => w.purgeReady && w.preserveIn,
    );

    const paths = new Set(removable.map((w) => w.path));

    const scope = {
      projectId: entry.projectId,
      projectName: entry.projectName,
      repo: repo.path,
    };

    for (const w of removable)
      items.push({
        ...scope,
        kind: "folder",
        target: w.path,
        head: w.head,
        base: w.preserveIn!,
        estimatedBytes: w.storage.reclaimableBytes,
      });

    for (const b of repo.branches) {
      if (
        !b.deleteBase ||
        b.reasons.some((reason) => reason !== "Checked out in a working folder")
      )
        continue;

      if (!b.worktrees.every((path) => paths.has(path))) continue;
      items.push({
        ...scope,
        kind: "branch",
        target: b.name,
        head: b.head,
        base: b.deleteBase,
        estimatedBytes: null,
      });
    }
  }

  return items.sort(
    (a, b) => Number(a.kind === "branch") - Number(b.kind === "branch"),
  );
}

export type CleanupResult = {
  removed: (CleanupItem & {
    freedBytes: number | null;
  })[];
  skipped: (CleanupItem & {
    reason: string;
  })[];
};

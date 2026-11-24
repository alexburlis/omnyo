import { randomUUID } from "node:crypto";
import type { SavedScan } from "./contract.js";
import type { CleanupItem } from "./cleanup-plan.js";

export type CleanupTarget = Pick<
  CleanupItem,
  "projectId" | "repo" | "kind" | "target"
>;

export function key(item: CleanupTarget) {
  return JSON.stringify([item.projectId, item.repo, item.kind, item.target]);
}

export function applyCleanup(
  snapshot: SavedScan,
  result: {
    removed: CleanupTarget[];
    skipped: (CleanupTarget & {
      reason: string;
    })[];
  },
): SavedScan {
  const removed = new Set(result.removed.map(key));

  const skipped = new Map(
    result.skipped.map((item) => [key(item), item.reason]),
  );

  const items = snapshot.items.filter(
    (item) => !removed.has(key(item)) && !skipped.has(key(item)),
  );

  const eligible = new Set(items.map(key));

  return {
    ...snapshot,
    id: randomUUID(),
    items,
    entries: snapshot.entries.map((entry) => {
      if (!entry.repo) return entry;

      const itemKey = (kind: "folder" | "branch", target: string) =>
        JSON.stringify([entry.projectId, entry.path, kind, target]);

      return {
        ...entry,
        repo: {
          ...entry.repo,
          worktrees: entry.repo.worktrees
            .filter((w) => !removed.has(itemKey("folder", w.path)))
            .map((w) => {
              const reason = skipped.get(itemKey("folder", w.path));

              return reason
                ? { ...w, purgeReady: false, reasons: [reason] }
                : w;
            }),
          branches: entry.repo.branches
            .filter((b) => !removed.has(itemKey("branch", b.name)))
            .map((b) => {
              const reason = skipped.get(itemKey("branch", b.name));

              const branch = {
                ...b,
                worktrees: b.worktrees.filter(
                  (path) => !removed.has(itemKey("folder", path)),
                ),
              };

              if (reason) {
                branch.deleteReady = false;
                branch.reasons = [reason];
              } else if (
                b.worktrees.length &&
                !branch.worktrees.length &&
                eligible.has(itemKey("branch", b.name))
              ) {
                branch.deleteReady = true;
                branch.reasons = branch.reasons.filter(
                  (reason) => reason !== "Checked out in a working folder",
                );
              }

              return branch;
            }),
        },
      };
    }),
  };
}

import type { FeatureMeta } from "../feature-types";

export const meta: FeatureMeta = {
  slug: "parallel-agents",
  name: "Parallel agents",
  group: "Run agents",
  order: 3,
  tagline:
    "Give each chat its own Git worktree and branch, so agents work side by side.",
  visual: "worktrees",
  seoTitle: "Run Parallel Claude Code Agents in Git Worktrees | Omnyo",
  seoDescription:
    "Start each Claude Code or Codex chat in its own Git worktree on a fresh branch. Omnyo can copy your .env, run your setup script and clean up afterwards.",
  keyword: "claude code worktrees",
  tile: "regular",
};

import type { FeatureMeta } from "../feature-types";

export const meta: FeatureMeta = {
  slug: "storage-cleanup",
  name: "Automatic resource cleanup",
  group: "Tools",
  order: 5,
  tagline: "Free disk space and memory when your agents finish working.",
  visual: "storage",
  seoTitle: "Automatic resource cleanup for coding agents | Omnyo",
  seoDescription:
    "Omnyo removes finished agents’ Git worktrees and stops leftover dev servers on macOS. See what uses disk space and memory on each machine.",
  keyword: "git worktree remove",
  tile: "regular",
};

import type { FeatureMeta } from "../feature-types";

export const meta: FeatureMeta = {
  slug: "automations",
  name: "Automations",
  group: "Automate",
  order: 1,
  tagline: "Run agent prompts and scripts on a cron schedule or at a set time.",
  visual: "app-schedule",
  seoTitle: "Schedule Claude Code and Codex Agents | Omnyo",
  seoDescription:
    "Run Claude Code or Codex prompts on a cron schedule with a timezone. Each run gets a chat or worktree; failed runs retry, then pause and notify you.",
  keyword: "claude code scheduled tasks",
  tile: null,
};

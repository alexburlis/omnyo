import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "GitHub and Sentry, one click from an agent",
  lede: "Every chat shows its branch and pull request status, and any of your GitHub issues or Sentry errors can start an agent.",
  sections: [
    {
      heading: "Pull request status in the chat header",
      body: "The Git control shows the branch, uncommitted changes and commits ahead of the base. Its badge shows what the pull request needs, from failing checks to ready to merge, and Commit, Mark ready and Merge are one click each.",
      bullets: [
        "Merge, Squash or Rebase from the same button",
        "Every change in the diff panel, stacked or split",
        "Path filters such as `docs/**` or `!*.test.ts`",
      ],
      visual: "integrations-pr",
    },
    {
      heading: "Sentry errors get a fix and a review",
      body: "Pick the Sentry projects to watch and their open errors land in an inbox inside Omnyo. Start a solver and it reproduces and fixes the error in its own worktree, then a separate chat reviews the fix.",
      bullets: [
        "Fixes stay local commits unless you pick draft pull requests",
        "Routes start paused, and the first scan starts no solver",
        "After a fix, the solver resolves the issue in Sentry",
      ],
      visual: "sentry",
    },
  ],
  goodToKnow: [
    {
      label: "GitHub sign-in",
      value:
        "Uses the GitHub CLI (`gh`) login on your server. No GitHub App, no stored token.",
    },
    {
      label: "Shown",
      value:
        "Issues and pull requests you opened, plus bot pull requests on repositories you can write to.",
    },
    {
      label: "Sentry token",
      value: "An auth token with `org:read`, `project:read` and `event:read`.",
    },
    {
      label: "Refresh",
      value: "GitHub syncs every 15 minutes, Sentry every 5.",
    },
    {
      label: "Auto solve",
      value:
        "Off by default. When on, at most 10 automatic starts per UTC day.",
    },
    {
      label: "CLI",
      value: "`omnyo workspace-github` and `omnyo sentry`.",
    },
  ],
  faq: [
    {
      question: "Does Omnyo need a GitHub token?",
      answer:
        "No. It uses your existing GitHub CLI sign-in on the machine that runs your Omnyo server and stores no GitHub token.",
    },
    {
      question: "Can I attach an issue to a chat?",
      answer:
        "Yes. Type @ or # in any composer to attach one of your issues or pull requests as context, or press Send agent on the issue itself.",
    },
    {
      question: "Will the Sentry agent open pull requests or merge on its own?",
      answer:
        "Not by default. Fixes stay local commits, draft pull requests happen only on routes where you choose them, and merging stays off until you turn it on. Even then it needs reviewer approval and passing checks.",
    },
    {
      question: "Does Omnyo ever force a merge?",
      answer:
        "No. It never requests an admin override, auto-merge, a merge queue or branch deletion, and Close, Reopen and Merge ask for confirmation first.",
    },
  ],
  relatedFeatures: ["parallel-agents", "multi-agent", "storage-cleanup"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};

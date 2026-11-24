import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Several agents, one repo, no collisions",
  lede: "Start a chat in a new Git worktree and its agent gets its own folder and branch, while your main checkout stays exactly as you left it.",
  sections: [
    {
      heading: "Your setup runs before the agent does",
      body: "Omnyo copies the untracked files listed in `.worktreeinclude`, such as `.env`, then runs `.omnyo-env-setup.sh`. Its output streams into the chat, and a failed setup stops the chat from starting.",
      bullets: [
        "`.omnyo-env-teardown.sh` runs before removal",
        "Both run with bash, on Windows through Git for Windows",
        "Each script has a 15-minute timeout",
      ],
      visual: "parallel-agents-setup",
    },
    {
      heading: "Finished worktrees clean up after themselves",
      body: "Five minutes after you archive a worktree's last chat, Omnyo stops the processes still running in it and removes the folder. The branch stays, with every commit.",
      bullets: ["Deleting the last chat removes the worktree right away"],
      visual: "parallel-agents-cleanup",
    },
    {
      heading: "Run as many as your machines allow",
      body: "Each machine runs one chat per processor by default, and extra chats wait for a free slot. Turn on overflow and a waiting new chat starts on another of your machines with room.",
      bullets: [],
      visual: "parallel-agents-queue",
    },
  ],
  goodToKnow: [
    {
      label: "Agents",
      value: "Works the same for Claude Code and Codex chats.",
    },
    {
      label: "Keep your work",
      value:
        "Uncommitted changes go with the worktree. Commit what you want to keep.",
    },
    {
      label: "Safety",
      value:
        "Omnyo refuses to remove a worktree mid-merge, rebase, cherry-pick, revert or bisect.",
    },
    {
      label: "CLI",
      value:
        "`omnyo thread spawn --new-environment worktree` and `omnyo concurrency-limit`.",
    },
    {
      label: "Not included",
      value:
        "Cloud sandboxes. The optional Modal plugin needs your own Modal account.",
    },
  ],
  faq: [
    {
      question: "What happens to my branch when the chat ends?",
      answer:
        "The branch stays. Omnyo removes only the worktree folder: right away when you delete the last chat, or five minutes after you archive it.",
    },
    {
      question: "How do I get my .env file into each worktree?",
      answer:
        "Commit a `.worktreeinclude` file that lists it in gitignore syntax. Omnyo copies matching untracked files into every new worktree.",
    },
    {
      question: "Can a chat use my existing checkout instead?",
      answer:
        "Yes. Pick the project checkout in the Start in picker. Omnyo will not switch its branch while it has uncommitted changes or another live chat.",
    },
  ],
  relatedFeatures: ["multi-agent", "dev-servers", "storage-cleanup"],
  relatedGuides: [
    {
      slug: "remote-dev-servers",
      label: "Dev servers for every branch",
    },
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};

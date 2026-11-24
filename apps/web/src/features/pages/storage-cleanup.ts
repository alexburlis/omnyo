import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Get disk space and memory back when agents finish",
  lede: "A coding agent can leave a checkout on disk and a dev server in memory. When you archive the chat, Omnyo removes its worktree, keeps your committed branch and stops leftover servers on macOS. You can keep a server you still need.",
  sections: [
    {
      heading: "The worktree goes, the branch stays",
      body: "Each worktree chat gets its own folder on a fresh branch. When the last chat in it ends, Omnyo runs your teardown script, removes the folder and leaves the branch with your commits.",
      bullets: [
        "Deleted chat: removed at once. Archived: after five minutes",
        "Uncommitted changes go with the folder, so commit first",
        "Never removed mid-merge, rebase, cherry-pick or bisect",
      ],
      visual: "storage-cleanup-worktree",
    },
    {
      heading: "Leftover servers get stopped",
      body: "Dev servers and watchers often outlive their chat. Left running lists them by machine and chat with their memory, and stops them a minute after you archive the chat, or after 24 idle hours.",
      bullets: [
        "SIGTERM first, SIGKILL after 10 seconds",
        "Keep one alive with Keep or `OMNYO_KEEP_RUNNING=1`",
        "Works on macOS",
      ],
      visual: "storage-cleanup-processes",
    },
    {
      heading: "In preview, projects share one file watch",
      body: "Agents working in separate projects can use the same skills folder. Omnyo shares one file watch across those projects and lets idle skill readers exit. Editing a skill refreshes only the projects that use its folder.",
      bullets: [
        "In a Mac test, two projects sharing a folder used one native file watch",
        "After a minute idle, both readers exited without triggering a refresh",
        "Both projects picked up the next edit while a third project stayed idle",
      ],
      visual: "skill-watch-counts",
    },
  ],
  goodToKnow: [
    {
      label: "Chat retention",
      value:
        "Off by default. Archive or delete chats after 7 to 365 days when you choose.",
    },
    {
      label: "Excluded",
      value: "Pinned and shelved chats are never archived for their age.",
    },
    {
      label: "Other worktrees",
      value:
        "Ones made with `git worktree add` are listed and removed only when clean and unlocked.",
    },
    {
      label: "Branches",
      value:
        "Deleted only when provably merged, and only when you click Clean up.",
    },
    {
      label: "Sizes",
      value: "Estimates. APFS clones can make the space you get back smaller.",
    },
  ],
  faq: [
    {
      question: "Does Omnyo delete my branch when it removes a worktree?",
      answer:
        "No. The branch stays with its commits. The Worktrees page deletes a branch only when it is provably merged and you click Clean up.",
    },
    {
      question: "What happens to uncommitted changes?",
      answer:
        "They are removed with the worktree, five minutes after you archive the last chat in it or right away when you delete it. Commit first.",
    },
    {
      question:
        "How do I keep a dev server running after its chat is archived?",
      answer:
        "Press Keep on it in Left running, or start it with `OMNYO_KEEP_RUNNING=1`.",
    },
    {
      question: "Does Omnyo delete old chats automatically?",
      answer:
        "Only if you turn it on in Storage & retention. Pinned and shelved chats are never included.",
    },
  ],
  relatedFeatures: [
    "parallel-agents",
    "dev-servers",
    "inbox",
    "shared-skill-updates",
  ],
  relatedGuides: [],
};

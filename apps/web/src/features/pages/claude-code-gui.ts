import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Claude Code, without the terminal tabs",
  lede: "Omnyo runs the real Claude Code CLI on your machine with your own sign-in, and adds an Inbox, worktrees and diff review around it.",
  sections: [
    {
      heading: "Pick the model and effort per chat",
      body: "The model picker is a grid of models and reasoning levels, from Low to Max plus Ultracode. Type a few letters, such as opus max, and press Enter.",
      bullets: [
        "Cmd+Shift+M opens it, with your favorites first",
        "Accept Edits, Approve for me or Full Access per chat",
        "Plan mode, checkpoint forks and compaction",
      ],
      visual: "claude-code-gui-picker",
    },
    {
      heading: "Review every change before you merge",
      body: "The side panel shows each file's diff, stacked or split. Filter a big change by path, such as `!*.test.ts`, to see only what matters.",
      bullets: [
        "Images, Markdown, HTML and PDFs open inside the chat",
        "Optional File Editor, built on Monaco, for quick fixes",
      ],
      visual: "claude-code-gui-diff",
    },
    {
      heading: "Give each chat its own branch",
      body: "Start a chat in a new Git worktree and Claude Code works on its own branch and folder. Run several at once without touching your main checkout. See [parallel agents](/features/parallel-agents).",
      bullets: [],
      visual: "worktrees",
    },
  ],
  goodToKnow: [
    {
      label: "Needs",
      value:
        "The Claude Code CLI, signed in. Guided setup can install it and sign you in.",
    },
    {
      label: "Platforms",
      value:
        "Mac with Apple silicon (macOS 13 or later), Windows, iPhone and the web.",
    },
    {
      label: "Account",
      value:
        "None on your own machines. Remote access needs a free Omnyo account.",
    },
    {
      label: "Cost",
      value: "Omnyo is free to use. Claude Code runs on your own plan.",
    },
    {
      label: "Other agents",
      value:
        "Codex is built in. Pi and ACP agents such as Cursor and opencode are off by default.",
    },
  ],
  faq: [
    {
      question: "Does Omnyo replace Claude Code?",
      answer:
        "No. Omnyo runs your Claude Code CLI with your own sign-in and subscription, and keeps its own controls.",
    },
    {
      question: "Can I keep my existing Claude Code chats?",
      answer:
        "Yes. [Chat import](/features/chat-import) brings in recent chats from the CLI and the VS Code extension and leaves the originals untouched.",
    },
    {
      question: "Which Claude Code controls still work?",
      answer:
        "Permission modes, plan mode, reasoning levels up to Max and Ultracode, checkpoint forks, compaction and native questions.",
    },
    {
      question: "Should I use Codex or Claude Code?",
      answer:
        "It depends on your plan and how you like to approve changes. [Codex vs Claude Code](/compare/codex-vs-claude-code) lists the differences, and Omnyo runs both side by side.",
    },
  ],
  relatedFeatures: ["codex-gui", "parallel-agents", "inbox"],
  relatedGuides: [
    {
      slug: "switch-from-claude-code",
      label: "Switch from Claude Code",
    },
    {
      slug: "claude-code-and-codex-together",
      label: "Claude Code and Codex together",
    },
  ],
};

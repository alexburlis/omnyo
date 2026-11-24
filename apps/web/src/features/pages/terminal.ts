import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Run commands without leaving chat.",
  lede: "Check your branch, run a test, or start a script in the same chat where you’re working with Claude Code or Codex. The shell runs in the chat’s workspace on its machine.",
  sections: [
    {
      heading: "Run a command from the message box",
      body: "Type `!git status --short` in an open chat and press Enter. The message box becomes a terminal and shows the output under your conversation.",
      bullets: [
        "Use Back to chat to return to the message box while the shell keeps running.",
        "The next `!` command reuses the same shell while it’s running.",
      ],
      visual: "terminal",
    },
    {
      heading: "Leave a terminal open beside the chat",
      body: "Open a new panel tab and choose Start terminal. Keep test output or a running script in view while you ask your agent a follow-up.",
      bullets: [
        "Open multiple terminal tabs when you need separate sessions.",
        "Select terminal output and use Add to chat to share it with your agent.",
      ],
      visual: "terminal-panel",
    },
  ],
  goodToKnow: [
    {
      label: "Workspace",
      value: "A chat set up in its own worktree opens its terminal there.",
    },
    {
      label: "Shortcut",
      value:
        "Toggle the composer terminal with `⌘J` on Mac or `Ctrl+J` on Windows and Linux.",
    },
    {
      label: "CLI",
      value:
        "Use `omnyo terminal` to list, create, attach to, or read output from terminal sessions.",
    },
  ],
  faq: [
    {
      question: "Does my agent receive commands I run with !?",
      answer:
        "Enter runs the command in the shell. To send the text as a chat message, use the Run button’s menu or press `⌘Enter` on Mac or `Ctrl+Enter` on Windows and Linux.",
    },
    {
      question: "Where do commands run?",
      answer:
        "A chat terminal runs on the machine hosting that chat, in its workspace. If your chat uses a separate Git worktree, that’s where the terminal starts.",
    },
    {
      question: "Can I keep a command running while I write a message?",
      answer:
        "Yes. Choose Back to chat to hide the composer terminal, or open a separate terminal tab and keep both in view.",
    },
  ],
  relatedFeatures: ["dev-servers", "keyboard", "parallel-agents"],
  relatedGuides: [],
};

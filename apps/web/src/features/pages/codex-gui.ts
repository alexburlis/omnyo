import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Codex in a real app, beside Claude Code",
  lede: "Omnyo drives the real Codex CLI on your machine with your own ChatGPT sign-in, and runs it next to Claude Code in one window.",
  sections: [
    {
      heading: "Codex models, levels and speed",
      body: "The model picker lists every Codex model with reasoning from None to Ultra. The arrow keys step the level, and ⚡ steps through Fast and Ultrafast where your account has them.",
      bullets: [
        "Accept Edits, Approve for me or Full Access per chat",
        "Plan and goal actions in the composer",
      ],
      visual: "codex-gui-picker",
    },
    {
      heading: "Hand a chat to another agent",
      body: "Pick a Claude Code favorite in a Codex chat and Omnyo continues the work in a new chat on that model. Each chat links to the other, so nothing gets lost.",
      bullets: [],
      visual: "codex-gui-handoff",
    },
    {
      heading: "Let Claude Code review what Codex wrote",
      body: "A Codex chat that finishes a change can start a [Claude Code](/features/claude-code-gui) chat to review it, or the other way round. The review comes back to the chat that asked. See [chats that work together](/features/multi-agent).",
      bullets: [],
      visual: "app-review",
    },
    {
      heading: "See how much allowance is left",
      body: "Rings in the bottom bar show what is left on each Claude and Codex account in Account Pooler. When one runs low, new chats move to the next account. See [usage tracking](/features/usage-tracking).",
      bullets: [],
      visual: "usage",
    },
  ],
  goodToKnow: [
    {
      label: "Needs",
      value:
        "Codex CLI 0.136.0 or newer, signed in with ChatGPT or an OpenAI API key.",
    },
    {
      label: "Setup",
      value: "Guided setup can install the Codex CLI and sign you in.",
    },
    {
      label: "Platforms",
      value:
        "Mac with Apple silicon (macOS 13 or later), Windows, iPhone and the web.",
    },
    {
      label: "Phone",
      value:
        "The iPhone app steers chats. Codex itself runs on your Mac, Windows or Linux computer.",
    },
    {
      label: "Cost",
      value: "Omnyo is free to use. Codex runs on your own plan.",
    },
  ],
  faq: [
    {
      question: "Is Omnyo the same as the Codex app?",
      answer:
        "No. The Codex app is OpenAI's product. Omnyo is a separate free app that drives the Codex CLI and also runs Claude Code.",
    },
    {
      question: "Which login does Omnyo use for Codex?",
      answer:
        "Your own. Omnyo drives the Codex CLI on your machine, signed in with your ChatGPT account or an OpenAI API key.",
    },
    {
      question: "Can I bring my existing Codex chats?",
      answer:
        "Yes. [Chat import](/features/chat-import) brings in recent Codex CLI and VS Code extension chats and leaves the originals untouched. Imported Codex chats cannot continue while Account Pooler routes Codex.",
    },
    {
      question: "Should I use Codex or Claude Code?",
      answer:
        "It depends on your plan and how you like to approve changes. [Codex vs Claude Code](/compare/codex-vs-claude-code) lists the differences, and Omnyo runs both side by side.",
    },
  ],
  relatedFeatures: ["claude-code-gui", "multi-agent", "usage-tracking"],
  relatedGuides: [
    {
      slug: "switch-from-codex",
      label: "Switch from Codex",
    },
    {
      slug: "claude-code-and-codex-together",
      label: "Claude Code and Codex together",
    },
  ],
};

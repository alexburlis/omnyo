import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "One chat builds, another reviews",
  lede: "Any chat can start other chats on Claude Code or Codex, message them and hear back when they finish. Child chats ask their parent, not you.",
  sections: [
    {
      heading: "Start a reviewer on another agent",
      body: "A Claude Code chat can start a Codex chat with `omnyo thread spawn` to review its work, then steer it with `omnyo thread tell`. The result comes back to the parent when the review ends.",
      bullets: [
        "Pick the agent, model and reasoning level per child",
        "Run a child on another of your machines",
        "Give it a fresh worktree on its own branch",
      ],
      visual: "multi-agent-spawn",
    },
    {
      heading: "Questions go to the parent, not you",
      body: "While its parent is live, a child never asks you. Its question arrives in the parent as a message, and the parent answers. You only hear what the chain cannot settle.",
      bullets: [],
      visual: "multi-agent-ask",
    },
    {
      heading: "Claude Code subagents stay visible",
      body: "When Claude Code hands work to its own subagents, each run is a timeline row you can expand, and the chat's status ring counts the ones still running.",
      bullets: [
        "Turn on Disable provider subagents to make every helper a full Omnyo chat",
      ],
      visual: "multi-agent-subagents",
    },
  ],
  goodToKnow: [
    {
      label: "Routing",
      value:
        "Parent and child talk automatically. Other chats only hear from each other when an agent sends a message.",
    },
    {
      label: "Depth",
      value:
        "Children can start children of their own. The sidebar nests them under their parent.",
    },
    {
      label: "Permissions",
      value:
        "A child inherits its parent's permission mode, adapted to its agent.",
    },
    {
      label: "Default agent",
      value:
        "`omnyo thread spawn` without a model or remembered choice starts a Codex chat.",
    },
    {
      label: "Archive",
      value:
        "A parent is never Ready to archive while a chat it started still has work.",
    },
  ],
  faq: [
    {
      question: "Can a Claude Code chat start a Codex chat?",
      answer:
        "Yes. `omnyo thread spawn --provider codex` starts it, `omnyo thread tell` messages it, and its result comes back to the parent when it finishes.",
    },
    {
      question: "Will chats message each other on their own?",
      answer:
        "Between parent and child, yes: questions go up and results come back. Other chats only hear from each other when an agent decides to send a message.",
    },
    {
      question: "Can I ask a side question without derailing the chat?",
      answer:
        "Yes. Reply in side chat opens a fork beside the main chat, and Send to main thread brings a useful answer back.",
    },
  ],
  relatedFeatures: ["goals-and-waits", "parallel-agents", "state-machines"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
    {
      slug: "claude-code-and-codex-together",
      label: "Claude Code and Codex together",
    },
  ],
};

import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Know where a chat stands in two seconds",
  lede: "Every chat carries a Glance card that its own agent keeps current: what you asked for, where the work stands and what happens next.",
  sections: [
    {
      heading: "Goal, Now and Next, always current",
      body: "The card shows your goal, a one-line Now and the next step, with a status of Working, Needs you, Blocked or Done. A small strip tracks Investigate, Build, Test and Ship.",
      bullets: [
        "A Blocked card names who or what unblocks it",
        "Finished chats offer Ready to archive",
      ],
      visual: "glance-phases",
    },
    {
      heading: "Evidence behind every claim",
      body: "Details holds facts, files and evidence. Each claim is marked Reproduced, Inspected or Hypothesis, and a linked command shows its exit code and real output.",
      bullets: [
        "A linked run shows the command ran; it does not prove the claim",
      ],
      visual: "glance-details",
    },
    {
      heading: "See what changed since you looked",
      body: "Open a card that moved on and Glance lists what changed, such as the status or the result. Archive the finished chat in one click, with Undo.",
      bullets: [],
      visual: "glance-changed",
    },
  ],
  goodToKnow: [
    {
      label: "Written by",
      value: "The agent in the chat. No separate model summarizes your chats.",
    },
    {
      label: "Status",
      value: "Omnyo's live chat state wins over an outdated card.",
    },
    {
      label: "Agents",
      value: "Claude Code and Codex chats both keep a card.",
    },
    {
      label: "CLI",
      value: "Agents and scripts set the card with `omnyo glance`.",
    },
    {
      label: "Output",
      value:
        "Linked command output is redacted and capped at 3,000 characters.",
    },
  ],
  faq: [
    {
      question: "Does Glance use extra tokens?",
      answer:
        "No extra model calls. The agent already working in the chat writes the card as part of its turn.",
    },
    {
      question: "What if the agent forgets to update the card?",
      answer:
        "Omnyo's live server status wins over the last card, so a chat that stopped is never shown as still working.",
    },
    {
      question: "Where does the card show up?",
      answer:
        "As a floating card beside the chat, in a popover from the title bar, or above the composer on phones.",
    },
  ],
  relatedFeatures: ["inbox", "notifications", "canvas"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};

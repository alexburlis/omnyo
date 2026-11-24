import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Every chat that needs you, in one list",
  lede: "The Inbox sorts chats from every project by what they need from you: an answer, a look at a failure, an archive or nothing yet.",
  sections: [
    {
      heading: "Agents ask, you pick an answer",
      body: "Agents ask through a native question card with two to four options and a free-text Other field. A required question keeps the chat in Needs you until you answer.",
      bullets: [
        "Up to four questions per card",
        "Options can carry a preview, such as a code snippet",
        "Optional questions let the agent carry on with its default",
      ],
      visual: "inbox-question",
    },
    {
      heading: "Triage a morning's chats from the keyboard",
      body: "J and K move between cards. E archives, W sets a wait, R replies, S shelves and O opens the chat. Every move shows an Undo toast, and Z takes it back.",
      bullets: [
        "Shift+E reviews and archives every finished chat at once",
        "Enter never sends words or archives running work",
      ],
      visual: "inbox-keys",
    },
    {
      heading: "Archive what is done, shelve what can wait",
      body: "Ready to archive lists chats with nothing left running, queued or waiting on you. The Shelf parks chats you want to keep, and a shelved chat comes back when it asks for something.",
      bullets: [],
      visual: "inbox-shelf",
    },
  ],
  goodToKnow: [
    {
      label: "Sections",
      value:
        "Needs you, Failed, Finished, Ready to archive, Running, Waiting and Shelf. Reorder or hide them in Settings.",
    },
    {
      label: "Undo",
      value: "Every Inbox move shows an Undo toast for 10 seconds.",
    },
    {
      label: "Owner only",
      value:
        "Agents and automations cannot archive, shelve or move your chats.",
    },
    {
      label: "Automations",
      value:
        "An automation's runs group into one card you can archive together.",
    },
    {
      label: "Plugin",
      value:
        "The card Inbox comes from the bundled Chat Topics plugin, on by default.",
    },
  ],
  faq: [
    {
      question: "How does a chat end up in Needs you?",
      answer:
        "Its agent asks a required question, fails or opens a decision. After a finished turn, Omnyo can also name something the chat still needs from you.",
    },
    {
      question: "Can I undo an archive?",
      answer:
        "Yes. Every Inbox move shows an Undo toast for 10 seconds, and Z in the Inbox takes the last move back.",
    },
    {
      question: "Can an agent archive or shelve its own chat?",
      answer:
        "No. Inbox moves are owner-only, so agents and automations are refused.",
    },
    {
      question: "Does the end-of-turn check cost API spend?",
      answer:
        "It runs on subscription allowance: included Codex allowance through Account Pooler, or a Claude subscription account. API-key accounts are refused, so it adds no pay-per-token spend.",
    },
  ],
  relatedFeatures: ["glance", "notifications", "keyboard"],
  relatedGuides: [
    {
      slug: "orchestrate-coding-agents",
      label: "Orchestrate coding agents",
    },
  ],
};

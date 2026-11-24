import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Drive every agent chat from the keyboard",
  lede: "Jump between chats, search, run any command and answer an agent's question with one key, then rebind every shortcut.",
  sections: [
    {
      heading: "Answer a question with one key",
      body: "When an agent asks a question with options, press 1 to 9 to pick one, as long as you are not typing in a text field. The Inbox has single keys for triage too.",
      bullets: ["Inbox: J and K move, E archives, S shelves, Z undoes"],
      visual: "keyboard-answer",
    },
    {
      heading: "Rebind any shortcut",
      body: "In Settings → Keyboard, click a shortcut and press its new keys. Omnyo warns you when another command already uses them, and the change syncs to every Omnyo window.",
      bullets: [
        "A custom key needs a modifier, or F1 to F24",
        "Archive thread has no default key, so give it one",
      ],
      visual: "keyboard-rebind",
    },
    {
      heading: "Bring back a prompt you already wrote",
      body: "Prompt Library opens with Ctrl+R and searches the messages you have sent, typos and all. Starred prompts sit above recent ones, and Tab switches between this chat, project and everything.",
      bullets: ["Cmd/Ctrl+S stars or unstars the highlighted prompt"],
      visual: "keyboard-prompts",
    },
  ],
  goodToKnow: [
    {
      label: "Search",
      value:
        "Cmd/Ctrl+K searches chats. Cmd/Ctrl+Enter opens the result in a split.",
    },
    {
      label: "Commands",
      value:
        "Cmd/Ctrl+Shift+P opens the palette, with each command's shortcut beside it.",
    },
    {
      label: "New chat",
      value: "Cmd/Ctrl+Shift+O, plus Cmd/Ctrl+N in the desktop app.",
    },
    {
      label: "Next chat",
      value:
        "Cmd+↓ and Cmd+↑ on a Mac, Ctrl+Shift+] and [ on Windows and Linux.",
    },
    {
      label: "Projects",
      value:
        "Cmd/Ctrl+1 opens the Inbox and 2 to 9 your projects in the desktop app.",
    },
    {
      label: "Undo",
      value: "Cmd/Ctrl+Z, which also brings back an archived chat.",
    },
  ],
  faq: [
    {
      question: "Can I change Omnyo's keyboard shortcuts?",
      answer:
        "Yes. Open Settings → Keyboard, click the shortcut next to a command and press the new keys. Omnyo shows which other commands already use the same keys.",
    },
    {
      question: "What is the shortcut for the next chat?",
      answer:
        "Cmd+↓ on a Mac and Ctrl+Shift+] on Windows and Linux. The previous chat is Cmd+↑ or Ctrl+Shift+[.",
    },
    {
      question: "Do the shortcuts work in the web app?",
      answer:
        "Mostly. Project keys move to Ctrl+1 to 9 on a Mac and Ctrl+Shift+1 to 9 elsewhere, and the extra Cmd/Ctrl+N for a new chat is desktop-only.",
    },
    {
      question: "Can plugins add shortcuts?",
      answer:
        "Yes. Plugins add bindable commands, such as Prompt Library's Ctrl+R, and their actions appear in the command palette.",
    },
  ],
  relatedFeatures: ["inbox", "voice-coding", "plugins"],
  relatedGuides: [],
};

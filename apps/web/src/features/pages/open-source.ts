import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Free and yours to run",
  lede: "Omnyo is a free, MIT-licensed app for Claude Code, Codex and other coding agents. It runs on your computers with your own subscriptions.",
  sections: [
    {
      heading: "An app for agents, not an agent",
      body: "Omnyo drives the agent CLIs you already use. Claude Code and Codex are on by default. Pi and ACP agents such as Cursor and opencode come bundled but switched off, and each needs its own CLI.",
      bullets: [
        "Each chat runs one agent, and different agents run side by side",
      ],
      visual: "open-source-providers",
    },
    {
      heading: "You decide which computer does what",
      body: "One computer is the server and keeps your chats. Other Mac, Windows or Linux machines can join to run agents, and any browser, the desktop app or the phone app is a screen.",
      bullets: [
        "One computer can be all three at once",
        "Phones only steer. They run nothing themselves",
      ],
      visual: "devices-machines",
    },
  ],
  goodToKnow: [
    {
      label: "License",
      value: "MIT. Omnyo is built on the open source bb project.",
    },
    {
      label: "Needs",
      value:
        "An agent such as Claude Code or Codex, signed in with your account.",
    },
    {
      label: "Platforms",
      value:
        "Mac (Apple silicon, macOS 13 or later), Windows, iOS and the web.",
    },
    {
      label: "Server",
      value: "Must stay awake. While it sleeps, nothing can reach Omnyo.",
    },
    {
      label: "Telemetry",
      value:
        "Separate weekly count, opt-in product analytics and crash report controls in updated builds.",
    },
    {
      label: "Plugins",
      value:
        "Much of the app is [plugins](/features/plugins) you can switch off or write.",
    },
  ],
  faq: [
    {
      question: "Is Omnyo an AI coding agent?",
      answer:
        "No. Omnyo is an app that runs agents such as Claude Code and Codex. It sells no AI service and resells no tokens.",
    },
    {
      question: "Do I need an Omnyo account?",
      answer:
        "Not to use Omnyo on your own machines. A free account is only needed for Omnyo connect, the optional remote access route.",
    },
    {
      question: "Can I use Omnyo without an AI subscription?",
      answer:
        "Not on its own. Chats need a signed-in agent such as Claude Code or Codex, and Omnyo uses that agent's own account. Codex also works with an OpenAI API key.",
    },
    {
      question: "Where does my code go?",
      answer:
        "To the Omnyo server you run, then to the AI provider you choose. See [privacy](/features/privacy) for the full data flow.",
    },
  ],
  relatedFeatures: ["privacy", "plugins", "devices"],
  relatedGuides: [],
};

import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "Let your agent click through the change",
  lede: "The desktop app puts a browser beside each chat, where your agent clicks through its work and saves screenshots while you can take over.",
  sections: [
    {
      heading: "Point at the element you mean",
      body: "Turn on Annotate elements, click anything on the page and write a note. Your agent gets the page address, selector, text, size and key styles, plus React component names when the page exposes them.",
      bullets: [
        "Design Mode adds a cropped screenshot to each note",
        "Capture result puts a fresh image beside the original",
      ],
      visual: "browser-annotate",
    },
    {
      heading: "Start signed in to your own sites",
      body: "On a Mac, connect your everyday browser once. Omnyo refreshes its logins from that profile every 15 minutes, so your agent can test pages behind a sign-in.",
      bullets: [
        "Chromium browsers, Firefox and Zen",
        "Safari once you grant Full Disk Access",
        "Copies cookies only, never passwords, history or bookmarks",
      ],
      visual: "browser-logins",
    },
  ],
  goodToKnow: [
    {
      label: "Needs",
      value:
        "The desktop app. Phones and the web app show a placeholder instead.",
    },
    {
      label: "Headless",
      value:
        "Agents can also run headless Chrome on any connected Mac or Linux machine.",
    },
    {
      label: "Screenshots",
      value:
        "Saved with the chat under Screenshots, and kept after the browser closes.",
    },
    {
      label: "Take over",
      value: "While an agent drives a tab, a banner offers Stop and Take over.",
    },
    {
      label: "CLI",
      value:
        "`omnyo browser` opens, controls, captures and closes tabs. It is experimental.",
    },
  ],
  faq: [
    {
      question: "Can Claude Code use a browser in Omnyo?",
      answer:
        "Yes. An agent can open a tab in the desktop app's browser or a headless Chrome session, click through pages and save screenshots. Codex chats use the same tools.",
    },
    {
      question: "Does Omnyo copy my passwords?",
      answer:
        "No. Login sync copies cookies only, from one profile you choose, and skips expired ones. Cookies stay on your Mac.",
    },
    {
      question: "Does browser automation run on Windows?",
      answer:
        "No. It runs on Mac and Linux machines. Automation scripts run as trusted code, not in a sandbox.",
    },
  ],
  relatedFeatures: ["dev-servers", "parallel-agents", "integrations"],
  relatedGuides: [
    {
      slug: "agent-browser",
      label: "Let your agent use a browser",
    },
  ],
};

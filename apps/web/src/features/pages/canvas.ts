import type { FeaturePageBody } from "../feature-types";

export const page: FeaturePageBody = {
  headline: "One board for what your agents find",
  lede: "Any chat can have a board and every project a dashboard, where agents pin charts, notes and results instead of burying them in chat.",
  sections: [
    {
      heading: "A project dashboard fed by live data",
      body: "The project canvas splits into sections, each its own board. Connect a read-only source, then add a metric, chart or table that refreshes when you ask or on a schedule.",
      bullets: [
        "Sources: your data, HTTPS JSON, MCP tools, Search Console, PostHog",
        "Refresh every minute up to once a day, or by hand",
        "Lock a section and agents cannot write to it",
      ],
      visual: "canvas-dashboard",
    },
    {
      heading: "Replies that read like a status report",
      body: "In the chat itself, agents answer with native blocks in your Omnyo theme: status tables, metrics, progress bars, small charts and file cards. No HTML file, server or chart library needed.",
      bullets: [
        "File cards check the file exists on that machine",
        "HTML pages run in a sandboxed frame",
      ],
      visual: "canvas-inline",
    },
  ],
  goodToKnow: [
    {
      label: "Included",
      value:
        "Canvas comes installed and on. Turn it on in a chat from the composer's + menu.",
    },
    {
      label: "Navigate",
      value:
        "Pinch or Cmd/Ctrl+scroll to zoom. Below 45% island names become map labels.",
    },
    {
      label: "Undo",
      value:
        "Your edits join Omnyo's undo history. Undo an agent's change from Changes.",
    },
    {
      label: "History",
      value: "The latest 200 operations are kept per board.",
    },
    {
      label: "Views",
      value:
        "Save a view of a section, module or free rectangle and reopen it from Contents or a link.",
    },
  ],
  faq: [
    {
      question: "Can an agent overwrite what I changed?",
      answer:
        "No. Agents use guarded edits that cannot overwrite your later changes, and a locked section is off limits to them entirely.",
    },
    {
      question: "Which data can a dashboard show?",
      answer:
        "Manual datasets, public HTTPS JSON APIs, read-only tools on MCP servers you allow, Google Search Console and PostHog queries. Every source is read-only.",
    },
    {
      question: "Can agents put custom HTML on a board?",
      answer:
        "Yes. Custom HTML, SVG, CSS and JavaScript run in sandboxed frames, so a page cannot reach Omnyo's own page, cookies or storage.",
    },
    {
      question: "What happens to a board if I turn Canvas off?",
      answer: "Turning Canvas off in a chat keeps its content for later.",
    },
  ],
  relatedFeatures: ["glance", "stats", "inbox"],
  relatedGuides: [],
};

export const SCATTERED = [
  {
    title: "claude — harbor-ledger",
    lines: [
      "› add a CSV export to invoices",
      "Reading InvoiceTable.tsx",
      "Editing 2 files…",
    ],
  },
  {
    title: "codex — harbor-ledger",
    lines: [
      "› cover European dates in parseDate",
      "Plan: 3 steps",
      "✓ 1. list the formats",
    ],
  },
  {
    title: "pnpm dev — feat/csv-export",
    lines: ["ready in 412 ms", "➜ local  http://localhost:5174/", ""],
  },
  {
    title: "codex — atlas-notes",
    lines: ["› triage the new issues", "Waiting for your approval", ""],
  },
  {
    title: "claude — lumen-web",
    lines: [
      "› move settings to the form kit",
      "Found 4 forms",
      "Editing SettingsPage.tsx",
    ],
  },
  {
    title: "git — harbor-ledger",
    lines: ["On branch feat/csv-export", "4 files changed", ""],
  },
  {
    title: "notes.md",
    lines: [
      "- ask codex to review export",
      "- restart the preview?",
      "- check atlas triage",
    ],
  },
] as const;

export const STORY_LINES = [
  "Claude Code in one terminal.",
  "Codex in another.",
  "A dev server in a third.",
  "You, in between.",
] as const;

export type ViewId = "split" | "review" | "preview" | "anywhere";

export const CHAPTERS: readonly {
  view: ViewId;
  number: string;
  name: string;
  title: string;
  body: string;
  guide: { label: string; href: string };
}[] = [
  {
    view: "split",
    number: "01",
    name: "Side by side",
    title: "Claude Code and Codex, side by side.",
    body: "Start a chat with either agent. Each chat runs in its own thread, so several tasks move at once and you can see what every agent is doing.",
    guide: {
      label: "Use Claude Code and Codex together",
      href: "/guides/claude-code-and-codex-together",
    },
  },
  {
    view: "review",
    number: "02",
    name: "Build, then review",
    title: "One agent builds. Another reviews.",
    body: "Hand a finished task to a different agent. It reviews the work in its own thread, and you talk the findings through with the reviewer.",
    guide: {
      label: "Orchestrate coding agents",
      href: "/guides/orchestrate-coding-agents",
    },
  },
  {
    view: "preview",
    number: "03",
    name: "Live previews",
    title: "A live preview for every branch.",
    body: "Omnyo runs a dev server for every branch and gives each one a live preview link, so you can open the work in a browser.",
    guide: {
      label: "Run dev servers for every branch",
      href: "/guides/remote-dev-servers",
    },
  },
  {
    view: "anywhere",
    number: "04",
    name: "Anywhere",
    title: "Keep working from anywhere.",
    body: "Turn on Omnyo Connect, optional remote access with a free account, to follow and steer your chats from another device.",
    guide: {
      label: "Work from anywhere",
      href: "/guides/work-from-anywhere",
    },
  },
];

export const ROUTE = [
  { name: "Your Mac", detail: "The Omnyo app" },
  { name: "Your Omnyo server", detail: "On a machine you run" },
  { name: "Your AI provider", detail: "The one you choose" },
] as const;

export const FACTS = [
  { title: "Free", body: "Free to download and use." },
  { title: "Open source", body: "Built on bb (MIT License)." },
  { title: "No Omnyo account", body: "Not needed on your own machines." },
  { title: "Made for macOS", body: "Apple Silicon, macOS 13 or later." },
] as const;

export const SWITCH_GUIDES = [
  { label: "Claude Code", slug: "switch-from-claude-code" },
  { label: "Codex", slug: "switch-from-codex" },
  { label: "Conductor", slug: "switch-from-conductor" },
  { label: "Cursor", slug: "switch-from-cursor" },
  { label: "Superset", slug: "switch-from-superset" },
  { label: "T3 Code", slug: "switch-from-t3-code" },
  { label: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

export const TOPIC_GUIDES = [
  { label: "Orchestrate coding agents", slug: "orchestrate-coding-agents" },
  {
    label: "Claude Code and Codex together",
    slug: "claude-code-and-codex-together",
  },
  { label: "Work from anywhere", slug: "work-from-anywhere" },
  { label: "Dev servers for every branch", slug: "remote-dev-servers" },
  { label: "Run an agent on a schedule", slug: "run-an-agent-on-a-schedule" },
  { label: "Let your agent use a browser", slug: "agent-browser" },
] as const;

export const READOUTS = {
  hero: "Daylight",
  scattered: "Scattered",
  gathering: "Gathering",
  partial: "Partial eclipse",
  totality: "One place",
  machines: "05 Your machines",
  more: "06 More ways",
  switch: "Switching over",
  dawn: "Light returns",
} as const;

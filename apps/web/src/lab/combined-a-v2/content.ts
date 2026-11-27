import type { MockView } from "../app-mock/app-mock";

export const STORY_LINES = [
  "Claude Code in one terminal.",
  "Codex in another.",
  "A dev server in a third.",
  "One of them is waiting on you.",
] as const;

export const WINDOWS: readonly {
  title: string;
  lines: readonly string[];
  wait?: string;
}[] = [
  {
    title: "claude — harbor-ledger",
    lines: [
      "› add a CSV export to invoices",
      "Reading InvoiceTable.tsx",
      "Editing export.ts…",
    ],
  },
  {
    title: "codex — review",
    lines: ["› review feat/csv-export"],
    wait: "Waiting for you · 18 min",
  },
  {
    title: "codex — harbor-ledger",
    lines: [
      "› cover European date formats",
      "Plan: 9 test cases",
      "✓ dd.mm.yyyy",
    ],
  },
  {
    title: "codex — atlas-notes",
    lines: ["› triage new issues", "Reading 23 issues…"],
  },
  {
    title: "npm run dev — harbor-ledger",
    lines: ["$ npm run dev", "Port 5174 is in use", "Trying another one…"],
  },
  {
    title: "git — harbor-ledger",
    lines: ["$ git status", "On branch feat/csv-export", "4 files changed"],
  },
  {
    title: "notes.md",
    lines: [
      "- which tab was the review?",
      "- restart the preview",
      "- triage before standup",
    ],
  },
];

export const BEATS = [
  {
    view: "overview",
    label: "Who needs you",
    problem: "An agent is waiting on you. You can't tell which.",
    title: "See who needs you.",
    detail:
      "Every Claude Code and Codex chat sits in one inbox, marked working, waiting or done. Open the one that needs you.",
  },
  {
    view: "split",
    label: "Side by side",
    problem: "Two agents means two terminals to watch.",
    title: "Run them side by side.",
    detail:
      "Claude Code builds the CSV export while Codex writes the date parser tests. Each chat can run in its own Git worktree, on its own branch.",
  },
  {
    view: "review",
    label: "Review",
    problem: "The agent says it's done. Nobody has checked.",
    title: "Get a second opinion.",
    detail:
      "A chat can start another chat on a different agent and hear back when it finishes. Codex reviews the export in its own thread, and you talk through what it found.",
  },
  {
    view: "preview",
    label: "Preview",
    problem: "To try a branch, you stop one dev server and start another.",
    title: "See it running.",
    detail:
      "Agents register each branch's dev server once. Restart it in one click, open the preview on any device, and let Claude click through it in a real browser.",
  },
  {
    view: "anywhere",
    label: "Away",
    problem: "You step away, and the agent stops to ask a question.",
    title: "Answer from anywhere.",
    detail:
      "Follow and steer your chats from your phone or any browser with Omnyo connect. Phone notifications wait until you step away from your desk.",
  },
  {
    view: "schedule",
    label: "Schedules",
    problem: "The same chores, every morning, by hand.",
    title: "Schedule the routine.",
    detail:
      "Codex triages new issues every weekday at 09:00, so the list is sorted before you sit down. For work that loops, draw a state machine.",
  },
] as const satisfies readonly {
  view: MockView;
  label: string;
  problem: string;
  title: string;
  detail: string;
}[];

export const BENTO_ORDER = [
  "usage-tracking",
  "stats",
  "glance",
  "notifications",
  "goals-and-waits",
  "keyboard",
  "state-machines",
  "canvas",
  "browser",
  "voice-coding",
  "integrations",
  "parallel-agents",
  "plugins",
  "storage-cleanup",
] as const;

export const SPEED = [
  {
    value: "85",
    prefix: "≤",
    unit: "ms",
    caption: "to draw a chat you opened recently, in all 20 switches we timed",
  },
  {
    value: "6",
    prefix: "",
    unit: "ms",
    caption: "for the local server to save a new chat (median)",
  },
  {
    value: "3",
    prefix: "",
    unit: "ms",
    caption: "for the server to search 1,000 chats (median)",
  },
  {
    value: "25",
    prefix: "",
    unit: "ms",
    caption: "for the server to reopen a chat with 15,000 events",
  },
] as const;

export const SPEED_NOTE =
  "Timed on an M4 Pro Mac, October 2026. Server times exclude rendering.";

export const IMPORTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    brand: "#D97757",
    brandText: "#C15F3C",
    chats: [
      "Add CSV export",
      "Fix invoice rounding",
      "Explain the sync worker",
    ],
  },
  {
    id: "codex",
    name: "Codex",
    brand: null,
    brandText: null,
    chats: ["Date parser tests", "Review feat/csv-export", "Triage new issues"],
  },
  {
    id: "pi",
    name: "Pi",
    brand: "#6D5DFB",
    brandText: "#5B4BF0",
    chats: [
      "Speed up note search",
      "Rename the tag model",
      "Draft the changelog",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    brand: null,
    brandText: null,
    chats: [
      "Tidy InvoiceTable props",
      "Dark mode for settings",
      "Fix the flaky login test",
    ],
  },
  {
    id: "opencode",
    name: "opencode",
    brand: "#2563EB",
    brandText: "#2563EB",
    chats: ["Move config to TOML", "Retry failed uploads", "Audit npm scripts"],
  },
  {
    id: "grok-build",
    name: "Grok Build",
    brand: null,
    brandText: null,
    chats: [
      "Profile the slow query",
      "Write the release notes",
      "Split the API client",
    ],
  },
  {
    id: "hermes-agent",
    name: "Hermes Agent",
    brand: null,
    brandText: null,
    chats: [
      "Summarise open PRs",
      "Plan the atlas-notes beta",
      "Prune stale branches",
    ],
  },
] as const satisfies readonly {
  id: string;
  name: string;
  brand: string | null;
  brandText: string | null;
  chats: readonly [string, string, string];
}[];

export const GUIDE_ONLY = [
  { label: "Cursor", slug: "switch-from-cursor" },
  { label: "Conductor", slug: "switch-from-conductor" },
  { label: "Superset", slug: "switch-from-superset" },
  { label: "T3 Code", slug: "switch-from-t3-code" },
  { label: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

export const QUESTIONS = [
  {
    question: "Is Omnyo free?",
    answer:
      "Yes. The app is free and there is no Omnyo subscription. Your agents use your own Claude Code and Codex sign-ins, and Omnyo sells no AI service.",
  },
  {
    question: "Does it replace Claude Code or Codex?",
    answer:
      "No. Omnyo drives the real Claude Code and Codex command-line tools on your machine, with the sign-in each of them already has. It gives them one window, an inbox and a way to work together.",
  },
  {
    question: "Which agents does it run?",
    answer:
      "Claude Code and Codex are built in. Pi, Cursor, opencode, Grok Build and Hermes Agent can be switched on, and each needs its own command-line tool installed.",
  },
  {
    question: "Where does my code go?",
    answer:
      "Prompts, code and files go to the Omnyo server you run, then to the AI provider you choose. Remote access is optional: Omnyo connect relays the connection to your server, and Tailscale keeps it on your own network instead.",
  },
  {
    question: "Do I need an account?",
    answer:
      "Not on your own machines. Remote access through Omnyo connect is optional and uses a free account.",
  },
  {
    question: "Which platforms does it run on?",
    answer:
      "Mac, Windows, iOS and the web. An Android app is coming. Phones and browsers are screens for the Omnyo server that runs on one of your computers.",
  },
  {
    question: "Can I bring my existing chats?",
    answer:
      "Yes. Omnyo imports your recent chats from Claude Code, Codex, Pi, Cursor, opencode, Grok Build and Hermes Agent in one click, and each one continues with the agent's full context. Your original history is not changed.",
  },
] as const;

import type { MockView } from "../app-mock/app-mock";

export const ACT_LABELS = [
  "All your coding agents",
  "Before Omnyo",
  "One window",
  "A Monday in Omnyo",
  "A Monday in Omnyo",
  "A Monday in Omnyo",
  "Yours",
  "Get Omnyo",
] as const;

export const WINDOWS = [
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
    lines: [
      "› review feat/csv-export",
      "Running the export",
      "2 findings. Waiting for you",
    ],
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
    lines: ["› triage new issues", "Waiting for your approval", ""],
  },
  {
    title: "npm run dev — harbor-ledger",
    lines: [
      "$ npm run dev",
      "ready in 388 ms",
      "➜ local  http://localhost:5174/",
    ],
  },
  {
    title: "git — harbor-ledger",
    lines: ["$ git status", "On branch feat/csv-export", "4 files changed"],
  },
  {
    title: "notes.md",
    lines: [
      "- send the export to review",
      "- restart the preview?",
      "- answer claude about de-DE",
    ],
  },
] as const;

export const BEATS = [
  {
    view: "overview",
    minute: 9 * 60,
    label: "Start",
    title: "Start a feature.",
    detail:
      "Ask Claude Code for a CSV export, then follow it from the first prompt to a reviewed branch.",
  },
  {
    view: "split",
    minute: 9 * 60 + 14,
    label: "Side by side",
    title: "Two agents at once.",
    detail:
      "Claude Code builds the export while Codex writes date parser tests. Each chat has its own thread.",
  },
  {
    view: "review",
    minute: 10 * 60 + 2,
    label: "Review",
    title: "A second opinion.",
    detail:
      "Hand the finished export to Codex. It reviews in its own thread, and you talk through what it found.",
  },
  {
    view: "preview",
    minute: 10 * 60 + 26,
    label: "Preview",
    title: "Click through it.",
    detail:
      "The branch runs its own dev server. Claude opens it in a real browser and shows you screenshots.",
  },
  {
    view: "anywhere",
    minute: 12 * 60 + 48,
    label: "Away",
    title: "Reply from anywhere.",
    detail:
      "Claude has a question while you are out. Answer it from your phone or any browser with Omnyo Connect.",
  },
  {
    view: "schedule",
    minute: 33 * 60,
    label: "Scheduled",
    title: "The routine runs itself.",
    detail:
      "Codex triages new issues every weekday at 09:00, so the list is sorted before you sit down.",
  },
] as const satisfies readonly {
  view: MockView;
  minute: number;
  label: string;
  title: string;
  detail: string;
}[];

const DAYS = ["Mon", "Tue"] as const;

export function clockLabel(minute: number) {
  const whole = Math.round(minute);
  const day = DAYS[Math.min(DAYS.length - 1, Math.floor(whole / 1440))];
  const hours = Math.floor((whole % 1440) / 60);
  const minutes = whole % 60;

  return `${day} ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export const FACTS = [
  { title: "Free", detail: "Download it and use it at no cost." },
  { title: "Open source", detail: "Read the code and build on it." },
  { title: "Plugins", detail: "Extend Omnyo when your workflow needs more." },
  {
    title: "No Omnyo account",
    detail: "Not needed to use it on your own machines.",
  },
] as const;

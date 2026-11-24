export { PLATFORMS, PLATFORM_LINE } from "../../landing/platforms";

export { SWITCH_GUIDES, TOPIC_GUIDES } from "../../landing/site-links";

export const ACTS = [
  "00 Intro",
  "01 Scattered",
  "02 Gathered",
  "03 Side by side",
  "04 Build, then review",
  "05 Also in Omnyo",
  "06 Yours",
  "07 One place",
] as const;

export const WINDOWS = [
  {
    title: "claude — harbor-api",
    lines: [
      "› fix the webhook retry backoff",
      "Reading src/webhooks/retry.ts",
      "Editing 2 files…",
    ],
  },
  {
    title: "claude — tidepool",
    lines: [
      "› why is the nightly export slow?",
      "Profiling export job",
      "Found 3 repeated queries",
    ],
  },
  {
    title: "codex — lumen-web",
    lines: [
      "› move settings to the new form kit",
      "Plan: 4 steps",
      "✓ 1. extract fields",
    ],
  },
  {
    title: "codex — kiln-cli",
    lines: ["› add a --dry-run flag", "Waiting for your approval", ""],
  },
  {
    title: "npm run dev — lumen-web",
    lines: [
      "$ npm run dev",
      "ready in 412 ms",
      "➜ local  http://localhost:5173/",
    ],
  },
  {
    title: "git — harbor-api",
    lines: ["$ git status", "On branch fix/webhook-retries", "2 files changed"],
  },
  {
    title: "notes.md",
    lines: [
      "- check codex on kiln",
      "- restart preview?",
      "- review export PR",
    ],
  },
] as const;

export const STORY_LINES = [
  "Claude Code in one terminal.",
  "Codex in another.",
  "A dev server in a third.",
  "You, in between.",
] as const;

export const THREADS = [
  {
    title: "Fix webhook retries",
    repo: "harbor-api",
    agent: "Claude Code",
    state: "running",
  },
  {
    title: "Settings on the form kit",
    repo: "lumen-web",
    agent: "Codex",
    state: "running",
  },
  {
    title: "Review: export limits",
    repo: "tidepool",
    agent: "Claude Code",
    state: "waiting",
  },
  {
    title: "Add --dry-run flag",
    repo: "kiln-cli",
    agent: "Codex",
    state: "done",
  },
  {
    title: "Weekday issue triage",
    repo: "harbor-api",
    agent: "Schedule",
    state: "scheduled",
  },
] as const;

import type { AgentState, Satellite } from "./orbit";

export const STATE_LABEL: Record<AgentState, string> = {
  running: "Running",
  review: "Reviewing",
  waiting: "Needs you",
  scheduled: "Scheduled",
  done: "Done",
};

export const SATELLITES: Satellite[] = [
  {
    id: "s1",
    agent: "Codex",
    detail: "fix/retry-backoff",
    state: "running",
    ring: 0,
    phase: 0.4,
    speed: 0.32,
  },
  {
    id: "s2",
    agent: "Claude Code",
    detail: "review · 2 notes",
    state: "review",
    ring: 1,
    phase: 2.7,
    speed: 0.24,
  },
  {
    id: "s3",
    agent: "Codex",
    detail: "needs you",
    state: "waiting",
    ring: 2,
    phase: 4.4,
    speed: 0.17,
  },
  {
    id: "s4",
    agent: "Claude Code",
    detail: "feat/invoice-export",
    state: "running",
    ring: 2,
    phase: 1.15,
    speed: 0.17,
  },
];

export interface Chat {
  id: string;
  state: AgentState;
  agent: string;
  title: string;
  repo: string;
  meta: string;
  startedSecondsAgo: number;
}

export const CHATS: Chat[] = [
  {
    id: "c1",
    state: "running",
    agent: "Codex",
    title: "Add jittered backoff to the retry client",
    repo: "harbor-api",
    meta: "fix/retry-backoff",
    startedSecondsAgo: 754,
  },
  {
    id: "c2",
    state: "review",
    agent: "Claude Code",
    title: "Review: retry backoff",
    repo: "harbor-api",
    meta: "2 notes for you",
    startedSecondsAgo: 211,
  },
  {
    id: "c3",
    state: "waiting",
    agent: "Codex",
    title: "Approve the lockfile update?",
    repo: "atlas-web",
    meta: "chore/deps-nov",
    startedSecondsAgo: 1938,
  },
  {
    id: "c4",
    state: "running",
    agent: "Claude Code",
    title: "Export invoices as CSV",
    repo: "atlas-web",
    meta: "preview :5174",
    startedSecondsAgo: 1287,
  },
  {
    id: "c5",
    state: "scheduled",
    agent: "Claude Code",
    title: "Weekday issue triage",
    repo: "automation",
    meta: "Mon–Fri 08:30",
    startedSecondsAgo: 0,
  },
  {
    id: "c6",
    state: "done",
    agent: "Codex",
    title: "Click through the settings page",
    repo: "ledgerline",
    meta: "3 screenshots",
    startedSecondsAgo: 0,
  },
  {
    id: "c7",
    state: "done",
    agent: "Claude Code",
    title: "Draft release notes for v2.4",
    repo: "harbor-api",
    meta: "ready to read",
    startedSecondsAgo: 0,
  },
];

export const EVENTS = [
  ["08:30:00", "automation", "Weekday issue triage started"],
  ["08:31:14", "codex", "harbor-api · opened fix/retry-backoff"],
  ["08:36:52", "dev server", "atlas-web · feat/invoice-export · preview ready"],
  ["08:40:09", "claude code", "review requested for fix/retry-backoff"],
  ["08:42:31", "browser", "ledgerline · 3 screenshots attached"],
  ["08:44:03", "connect", "travel-laptop · following 2 chats"],
  ["08:45:18", "codex", "atlas-web · waiting on you: approve lockfile update"],
  ["08:47:40", "claude code", "review · 2 notes on the timeout path"],
] as const;

export const FLIGHT_PLAN = [
  {
    code: "T+00",
    title: "Brief",
    body: "You describe the task in a new chat.",
    agent: "You",
    state: "done",
    log: "> Add CSV export to invoices",
  },
  {
    code: "T+01",
    title: "Build",
    body: "Codex works on its own branch, in its own thread.",
    agent: "Codex",
    state: "running",
    log: "feat/invoice-export · 6 files",
  },
  {
    code: "T+02",
    title: "Preview",
    body: "Run a dev server for the branch and open its live preview link.",
    agent: "Dev server",
    state: "running",
    log: "preview ↗ localhost:5174",
  },
  {
    code: "T+03",
    title: "Check",
    body: "The agent clicks through the change in a real browser and shows you screenshots.",
    agent: "Browser",
    state: "done",
    log: "3 screenshots attached",
  },
  {
    code: "T+04",
    title: "Review",
    body: "Claude Code reviews the change in a separate thread.",
    agent: "Claude Code",
    state: "review",
    log: "2 notes on empty states",
  },
  {
    code: "T+05",
    title: "Debrief",
    body: "You talk the notes through with the reviewer, then decide what happens next.",
    agent: "You",
    state: "waiting",
    log: "> Why skip the empty file?",
  },
] as const satisfies readonly {
  code: string;
  title: string;
  body: string;
  agent: string;
  state: AgentState;
  log: string;
}[];

export const SWITCH_GUIDES = [
  { from: "Claude Code", slug: "switch-from-claude-code" },
  { from: "Codex", slug: "switch-from-codex" },
  { from: "Conductor", slug: "switch-from-conductor" },
  { from: "Cursor", slug: "switch-from-cursor" },
  { from: "Superset", slug: "switch-from-superset" },
  { from: "T3 Code", slug: "switch-from-t3-code" },
  { from: "Vibe Kanban", slug: "switch-from-vibe-kanban" },
] as const;

export const FIELD_GUIDES = [
  { title: "Orchestrate coding agents", slug: "orchestrate-coding-agents" },
  {
    title: "Claude Code and Codex together",
    slug: "claude-code-and-codex-together",
  },
  { title: "Work from anywhere", slug: "work-from-anywhere" },
  { title: "Remote dev servers", slug: "remote-dev-servers" },
  { title: "Run an agent on a schedule", slug: "run-an-agent-on-a-schedule" },
  { title: "Let your agent use a browser", slug: "agent-browser" },
] as const;

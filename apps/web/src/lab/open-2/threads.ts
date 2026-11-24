export type Provider = "claude" | "codex";

export type ToolIcon = "read" | "edit" | "run" | "browser" | "list";

export type ThreadItem =
  | { kind: "user"; at: number; text: string }
  | { kind: "agent"; at: number; text: string }
  | { kind: "note"; at: number; text: string }
  | {
      kind: "tool";
      at: number;
      done: number;
      icon: ToolIcon;
      label: string;
      detail?: string;
      result?: string;
      tone?: "ok" | "bad";
    }
  | {
      kind: "shots";
      at: number;
      shots: readonly { label: string; size: "wide" | "tall" }[];
    };

export type PanelKind = "preview" | "terminal" | "diff" | "issues" | "browser";

export interface Thread {
  id: string;
  title: string;
  project: string;
  branch: string;
  provider: Provider;
  role: string;
  section: "running" | "needs" | "open";
  panel: PanelKind;
  panelLabel: string;
  doneAt: number;
  loop: number;
  offset: number;
  finalStatus: string;
  items: readonly ThreadItem[];
}

export const CHARS_PER_MS = 1 / 16;

export const PROVIDER_NAME: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const RAW_THREADS: readonly Omit<Thread, "doneAt">[] = [
  {
    id: "drafts",
    title: "Keep drafts when offline",
    project: "plover-web",
    branch: "offline-drafts",
    provider: "claude",
    role: "Builder",
    section: "running",
    panel: "preview",
    panelLabel: "Preview",
    loop: 34000,
    offset: 6400,
    finalStatus: "Ready for review",
    items: [
      {
        kind: "user",
        at: 0,
        text: "Notes written on the train vanish when the signal drops. Keep drafts on the device until sync comes back.",
      },
      {
        kind: "agent",
        at: 1100,
        text: "I'll keep drafts in IndexedDB while offline and upload them in order when the connection returns. Reading the editor and sync code first.",
      },
      {
        kind: "tool",
        at: 3600,
        done: 4400,
        icon: "read",
        label: "Read 4 files",
        detail: "src/editor · src/sync",
      },
      {
        kind: "tool",
        at: 5000,
        done: 6300,
        icon: "edit",
        label: "Edited draftStore.ts",
        result: "+38 −0",
      },
      {
        kind: "tool",
        at: 6800,
        done: 7700,
        icon: "edit",
        label: "Edited Draft.tsx",
        result: "+12 −4",
      },
      {
        kind: "tool",
        at: 8400,
        done: 11600,
        icon: "run",
        label: "pnpm test drafts",
        result: "14 passed",
        tone: "ok",
      },
      {
        kind: "agent",
        at: 12200,
        text: "Done. Drafts save on the device while offline and upload once you reconnect. The branch preview shows the new “Saved on this device” label. Ready for review.",
      },
    ],
  },
  {
    id: "review",
    title: "Review offline drafts",
    project: "plover-web",
    branch: "offline-drafts",
    provider: "codex",
    role: "Reviewer",
    section: "needs",
    panel: "diff",
    panelLabel: "Diff",
    loop: 30000,
    offset: 13800,
    finalStatus: "Waiting for you",
    items: [
      {
        kind: "note",
        at: 0,
        text: "Reviewing offline-drafts against main",
      },
      {
        kind: "tool",
        at: 300,
        done: 1300,
        icon: "read",
        label: "Read the diff",
        result: "3 files · +50 −4",
      },
      {
        kind: "agent",
        at: 1700,
        text: "One issue. If the app closes before the connection returns, queued drafts stay in IndexedDB, but nothing uploads them on the next launch.",
      },
      {
        kind: "user",
        at: 5600,
        text: "Is retrying on startup enough, or do we need background sync?",
      },
      {
        kind: "agent",
        at: 7600,
        text: "Retrying on startup covers it. Background sync isn't in every browser you support, so I'd call flushDrafts() once the store opens. One line, shown in the diff.",
      },
    ],
  },
  {
    id: "flaky",
    title: "Fix flaky sync test",
    project: "plover-api",
    branch: "fix-sync-retry",
    provider: "codex",
    role: "Builder",
    section: "running",
    panel: "terminal",
    panelLabel: "Terminal",
    loop: 32000,
    offset: 4200,
    finalStatus: "Fixed · 50 of 50 pass",
    items: [
      {
        kind: "user",
        at: 0,
        text: "sync.retry.test fails about one run in ten on CI. Find out why and fix it.",
      },
      {
        kind: "agent",
        at: 1200,
        text: "Running it 50 times to reproduce.",
      },
      {
        kind: "tool",
        at: 2400,
        done: 6000,
        icon: "run",
        label: "vitest sync.retry --repeat 50",
        result: "4 of 50 failed",
        tone: "bad",
      },
      {
        kind: "agent",
        at: 6600,
        text: "The retry timer uses real time, so on a slow runner it fires after the assertion. Switching the test to fake timers.",
      },
      {
        kind: "tool",
        at: 9600,
        done: 10300,
        icon: "edit",
        label: "Edited sync.retry.test.ts",
        result: "+9 −6",
      },
      {
        kind: "tool",
        at: 10900,
        done: 14400,
        icon: "run",
        label: "vitest sync.retry --repeat 50",
        result: "50 of 50 passed",
        tone: "ok",
      },
      {
        kind: "agent",
        at: 15000,
        text: "Fixed. The retry logic was fine; only the test depended on timing.",
      },
    ],
  },
  {
    id: "share",
    title: "Check the share sheet",
    project: "plover-web",
    branch: "share-sheet",
    provider: "claude",
    role: "Browser",
    section: "running",
    panel: "browser",
    panelLabel: "Browser",
    loop: 28000,
    offset: 2600,
    finalStatus: "2 screenshots",
    items: [
      {
        kind: "user",
        at: 0,
        text: "Click through the new share sheet at desktop and phone widths and show me screenshots.",
      },
      {
        kind: "tool",
        at: 1300,
        done: 2300,
        icon: "browser",
        label: "Opened /notes/42",
        detail: "localhost:5175",
      },
      {
        kind: "tool",
        at: 2900,
        done: 4500,
        icon: "browser",
        label: "Clicked Share, then Copy link",
      },
      {
        kind: "tool",
        at: 5200,
        done: 6100,
        icon: "browser",
        label: "Resized to 390 × 844",
      },
      {
        kind: "shots",
        at: 7000,
        shots: [
          { label: "Desktop", size: "wide" },
          { label: "Phone", size: "tall" },
        ],
      },
      {
        kind: "agent",
        at: 7900,
        text: "Both widths work. On a phone the sheet covers the note title, which looks intentional. Screenshots above.",
      },
    ],
  },
  {
    id: "triage",
    title: "Weekday issue triage",
    project: "plover-web",
    branch: "main",
    provider: "claude",
    role: "Automation",
    section: "open",
    panel: "issues",
    panelLabel: "Issues",
    loop: 26000,
    offset: 11000,
    finalStatus: "Weekdays at 09:00",
    items: [
      {
        kind: "note",
        at: 0,
        text: "Scheduled run · Weekdays at 09:00",
      },
      {
        kind: "user",
        at: 300,
        text: "Triage new issues: label them, link duplicates, flag anything urgent.",
      },
      {
        kind: "tool",
        at: 1500,
        done: 2400,
        icon: "list",
        label: "Listed new issues",
        result: "6 since yesterday",
      },
      {
        kind: "agent",
        at: 4200,
        text: "Labelled four bugs and two feature requests. #214 duplicates #198, so I linked them. #219 looks urgent: exports fail for notes with images.",
      },
    ],
  },
];

export const THREADS: readonly Thread[] = RAW_THREADS.map((thread) => ({
  ...thread,
  doneAt: Math.max(...thread.items.map(itemEnd)) + 500,
}));

export const AUTO_ORDER = ["drafts", "review", "flaky", "share", "triage"];

export function itemEnd(item: ThreadItem): number {
  if (item.kind === "agent") return item.at + item.text.length / CHARS_PER_MS;

  if (item.kind === "tool") return item.done;

  return item.at;
}

export function threadElapsed(thread: Thread, clock: number, frozen: boolean) {
  if (frozen) return thread.doneAt + 1;

  return (clock + thread.offset) % thread.loop;
}

export function threadActivity(thread: Thread, elapsed: number) {
  if (elapsed >= thread.doneAt)
    return { running: false, text: thread.finalStatus };

  const visible = thread.items.filter((item) => item.at <= elapsed);
  const last = visible[visible.length - 1];

  if (!last) return { running: true, text: "Starting" };

  if (last.kind === "tool") {
    if (elapsed < last.done) {
      const verb =
        last.icon === "run"
          ? "Running"
          : last.icon === "edit"
            ? "Editing"
            : last.icon === "browser"
              ? "Browsing"
              : "Reading";

      return {
        running: true,
        text: `${verb} ${last.label.replace(/^(Edited|Read|Opened|Listed) /, "")}`,
      };
    }

    return { running: true, text: "Thinking" };
  }

  if (last.kind === "agent" && elapsed < itemEnd(last)) {
    return { running: true, text: "Writing" };
  }

  return { running: true, text: "Thinking" };
}

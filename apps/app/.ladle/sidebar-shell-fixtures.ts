import {
  PERSONAL_PROJECT_ID,
  type Host,
  type ProjectSource,
} from "@omnyo/domain";
import type {
  ProjectWithThreadsResponse,
  SidebarBootstrapResponse,
} from "@omnyo/server-contract";
import { buildProjectFileContentUrl } from "../src/lib/file-content-urls";
import {
  HOST_IDS,
  HOST_NAMES,
  makeHost,
  makeProject,
  makeThreadListEntry,
} from "./story-fixtures";

const STORY_NOW = Date.now();

const MINUTE_MS = 60_000;

export const SHELL_STORY_OFFLINE_HOST_ID = "host_gpu_lab";

export const SHELL_STORY_HOSTS: Host[] = [
  makeHost({ id: HOST_IDS.local, name: HOST_NAMES.local }),
  makeHost({ id: HOST_IDS.remote, name: HOST_NAMES.remote }),
  makeHost({
    id: SHELL_STORY_OFFLINE_HOST_ID,
    name: "gpu-lab",
    status: "disconnected",
  }),
];

type ThreadOverrides = Parameters<typeof makeThreadListEntry>[0];

type ChatState =
  | "quiet"
  | "unread"
  | "running"
  | "queued"
  | "needs-you"
  | "failed-read"
  | "failed-unread";

const CHAT_STATE_OVERRIDES: Record<
  ChatState,
  (attentionAt: number) => ThreadOverrides
> = {
  quiet: (attentionAt) => ({ lastReadAt: attentionAt }),
  unread: (attentionAt) => ({ lastReadAt: attentionAt - 1 }),
  running: (attentionAt) => ({
    lastReadAt: attentionAt,
    status: "active",
    runtime: { displayStatus: "active" },
  }),
  queued: (attentionAt) => ({
    lastReadAt: attentionAt,
    queuedWork: "waiting",
  }),
  "needs-you": (attentionAt) => ({
    lastReadAt: attentionAt,
    hasPendingInteraction: true,
  }),
  "failed-read": (attentionAt) => ({
    lastReadAt: attentionAt,
    status: "error",
    runtime: { displayStatus: "error" },
  }),
  "failed-unread": (attentionAt) => ({
    lastReadAt: attentionAt - 1,
    status: "error",
    runtime: { displayStatus: "error" },
  }),
};

interface ChatSpec {
  id: string;
  title: string;
  minutesAgo: number;
  state: ChatState;
  parentThreadId?: string;
}

function chat(projectId: string, spec: ChatSpec) {
  const attentionAt = STORY_NOW - spec.minutesAgo * MINUTE_MS;

  return makeThreadListEntry({
    id: spec.id,
    projectId,
    title: spec.title,
    titleFallback: spec.title,
    parentThreadId: spec.parentThreadId ?? null,
    environmentId: null,
    sectionId: null,
    latestAttentionAt: attentionAt,
    lastMessageAt: attentionAt,
    createdAt: attentionAt - 90 * MINUTE_MS,
    updatedAt: attentionAt,
    ...CHAT_STATE_OVERRIDES[spec.state](attentionAt),
  });
}

interface StoryIconFile {
  path: string;
  svg: string;
}

interface ShellProjectSpec {
  id: string;
  name: string;
  hostId: string;
  root: string;
  icon: StoryIconFile | null;
  otherFiles: readonly string[];
  chats: readonly ChatSpec[];
}

function iconSvg(background: string, glyph: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${background}"/>${glyph}</svg>`;
}

const ICON_GLYPHS = {
  ring: '<circle cx="32" cy="32" r="15" fill="none" stroke="#fff" stroke-width="7"/>',
  bars: '<rect x="15" y="34" width="8" height="16" rx="2" fill="#fff"/><rect x="28" y="22" width="8" height="28" rx="2" fill="#fff"/><rect x="41" y="14" width="8" height="36" rx="2" fill="#fff"/>',
  peak: '<path d="M10 48 L26 22 L36 36 L42 28 L54 48 Z" fill="#fff"/>',
  envelope:
    '<rect x="13" y="19" width="38" height="26" rx="4" fill="#fff"/><path d="M14 21 L32 35 L50 21" fill="none" stroke="#1d4ed8" stroke-width="4"/>',
  ledger:
    '<rect x="18" y="12" width="28" height="40" rx="4" fill="#fff"/><path d="M24 24 H40 M24 32 H40 M24 40 H34" stroke="#0f766e" stroke-width="4"/>',
  play: '<circle cx="32" cy="32" r="20" fill="#fff"/><path d="M28 22 L42 32 L28 42 Z" fill="#b91c1c"/>',
  stack:
    '<path d="M32 12 L52 22 L32 32 L12 22 Z" fill="#fff"/><path d="M12 32 L32 42 L52 32" fill="none" stroke="#fff" stroke-width="5"/><path d="M12 42 L32 52 L52 42" fill="none" stroke="#fff" stroke-width="5"/>',
  wave: '<path d="M10 32 C18 14 24 14 32 32 S46 50 54 32" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>',
  chip: '<rect x="18" y="18" width="28" height="28" rx="5" fill="#fff"/><rect x="26" y="26" width="12" height="12" fill="#4c1d95"/>',
} as const;

const SHELL_PROJECT_SPECS: readonly ShellProjectSpec[] = [
  {
    id: "proj_omnyo_private",
    name: "omnyo-private",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/omnyo-private",
    icon: {
      path: "apps/app/public/app-icon.png",
      svg: iconSvg("#18181b", ICON_GLYPHS.ring),
    },
    otherFiles: [
      "apps/app/src/components/ui/icon.tsx",
      "packages/shared-ui/src/icons/index.ts",
    ],
    chats: [
      {
        id: "thr_op_topics",
        title: "Split the sidebar shell work",
        minutesAgo: 6,
        state: "quiet",
      },
      {
        id: "thr_op_topics_rail",
        title: "Rail tiles and badges",
        minutesAgo: 2,
        state: "running",
        parentThreadId: "thr_op_topics",
      },
      {
        id: "thr_op_topics_footer",
        title: "Global footer wiring",
        minutesAgo: 4,
        state: "failed-unread",
        parentThreadId: "thr_op_topics",
      },
      {
        id: "thr_op_topics_docs",
        title: "Plugin API docs touchpoints",
        minutesAgo: 9,
        state: "quiet",
        parentThreadId: "thr_op_topics",
      },
      {
        id: "thr_op_failed_read",
        title: "Fix the flaky sidebar benchmark",
        minutesAgo: 14,
        state: "failed-read",
      },
      {
        id: "thr_op_permission",
        title: "Approve the prediction fork migration",
        minutesAgo: 3,
        state: "needs-you",
      },
      {
        id: "thr_op_latency",
        title: "Profile composer typing latency",
        minutesAgo: 1,
        state: "running",
      },
      {
        id: "thr_op_receipt",
        title: "Review the web-only delivery receipt",
        minutesAgo: 22,
        state: "unread",
      },
      {
        id: "thr_op_storage",
        title: "Tidy release storage",
        minutesAgo: 180,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_omnyo_plugins",
    name: "omnyo-plugins",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/omnyo-plugins",
    icon: {
      path: "docs/favicon.svg",
      svg: iconSvg("#4338ca", ICON_GLYPHS.stack),
    },
    otherFiles: ["chat-topics/README.md"],
    chats: [
      {
        id: "thr_plugins_scope",
        title: "Chat Topics scope header",
        minutesAgo: 1,
        state: "running",
      },
      {
        id: "thr_plugins_usage",
        title: "Account usage footer gauges",
        minutesAgo: 35,
        state: "unread",
      },
      {
        id: "thr_plugins_picker",
        title: "Resources host picker",
        minutesAgo: 240,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_atlas",
    name: "atlas",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/atlas",
    icon: {
      path: "ios/Atlas/Assets.xcassets/AppIcon.appiconset/icon.png",
      svg: iconSvg("#0369a1", ICON_GLYPHS.peak),
    },
    otherFiles: ["web/public/favicon.ico"],
    chats: [
      {
        id: "thr_atlas_testflight",
        title: "Confirm the TestFlight group",
        minutesAgo: 8,
        state: "needs-you",
      },
      {
        id: "thr_atlas_onboarding",
        title: "Onboarding copy pass",
        minutesAgo: 600,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_atlas_web",
    name: "atlas-web",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/atlas-web",
    icon: null,
    otherFiles: ["src/components/IconButton.tsx"],
    chats: [
      {
        id: "thr_atlas_web_pricing",
        title: "Pricing page copy",
        minutesAgo: 44,
        state: "unread",
      },
    ],
  },
  {
    id: "proj_mailer",
    name: "mailer",
    hostId: HOST_IDS.remote,
    root: "/home/michael/mailer",
    icon: {
      path: "public/favicon.ico",
      svg: iconSvg("#1d4ed8", ICON_GLYPHS.envelope),
    },
    otherFiles: [],
    chats: [
      {
        id: "thr_mailer_suppression",
        title: "Sync the suppression list",
        minutesAgo: 5,
        state: "running",
      },
      {
        id: "thr_mailer_templates",
        title: "Template preview fixes",
        minutesAgo: 1_440,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_search_console",
    name: "search-console",
    hostId: HOST_IDS.remote,
    root: "/home/michael/search-console",
    icon: null,
    otherFiles: [],
    chats: [
      {
        id: "thr_search_crawl",
        title: "Nightly crawl import",
        minutesAgo: 52,
        state: "failed-unread",
      },
    ],
  },
  {
    id: "proj_ledger",
    name: "ledger",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/ledger",
    icon: {
      path: "assets/icon.svg",
      svg: iconSvg("#0f766e", ICON_GLYPHS.ledger),
    },
    otherFiles: [],
    chats: [
      {
        id: "thr_ledger_vat",
        title: "VAT export check",
        minutesAgo: 2_880,
        state: "quiet",
      },
      {
        id: "thr_ledger_receipts",
        title: "Receipt matching rules",
        minutesAgo: 4_320,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_design_system",
    name: "design-system",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/design-system",
    icon: null,
    otherFiles: ["src/icons/index.ts"],
    chats: [
      {
        id: "thr_design_tokens",
        title: "Token audit",
        minutesAgo: 5_760,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_game_catalog",
    name: "game-catalog",
    hostId: HOST_IDS.remote,
    root: "/home/michael/game-catalog",
    icon: {
      path: "web/static/favicon.svg",
      svg: iconSvg("#b91c1c", ICON_GLYPHS.play),
    },
    otherFiles: [],
    chats: [
      {
        id: "thr_games_guides",
        title: "Draft the weekly guides",
        minutesAgo: 3,
        state: "running",
      },
      {
        id: "thr_games_outreach",
        title: "Pick outreach targets",
        minutesAgo: 12,
        state: "needs-you",
      },
    ],
  },
  {
    id: "proj_analytics",
    name: "analytics",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/analytics",
    icon: null,
    otherFiles: [],
    chats: [
      {
        id: "thr_analytics_funnel",
        title: "Signup funnel report",
        minutesAgo: 7_200,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_playground",
    name: "playground",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/playground",
    icon: null,
    otherFiles: [],
    chats: [],
  },
  {
    id: "proj_gpu_lab",
    name: "gpu-lab",
    hostId: SHELL_STORY_OFFLINE_HOST_ID,
    root: "/home/michael/gpu-lab",
    icon: { path: "icon.svg", svg: iconSvg("#4c1d95", ICON_GLYPHS.chip) },
    otherFiles: [],
    chats: [
      {
        id: "thr_gpu_benchmarks",
        title: "Model benchmark sweep",
        minutesAgo: 10_080,
        state: "quiet",
      },
    ],
  },
  {
    id: "proj_infra",
    name: "infra",
    hostId: HOST_IDS.remote,
    root: "/home/michael/infra",
    icon: { path: "icon.png", svg: iconSvg("#334155", ICON_GLYPHS.bars) },
    otherFiles: [],
    chats: [],
  },
  {
    id: "proj_agent_docs",
    name: "agent-docs",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/agent-docs",
    icon: null,
    otherFiles: [],
    chats: [
      {
        id: "thr_agent_docs_storage",
        title: "Storage guide refresh",
        minutesAgo: 95,
        state: "unread",
      },
    ],
  },
  {
    id: "proj_voice_notes",
    name: "voice-notes",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/voice-notes",
    icon: {
      path: "macos/Resources/appicon.png",
      svg: iconSvg("#a16207", ICON_GLYPHS.wave),
    },
    otherFiles: [],
    chats: [
      {
        id: "thr_voice_release",
        title: "Prepare the release notes",
        minutesAgo: 2,
        state: "queued",
      },
    ],
  },
  {
    id: "proj_link_cards",
    name: "link-cards",
    hostId: HOST_IDS.local,
    root: "/Users/michael/Projects/link-cards",
    icon: null,
    otherFiles: [],
    chats: [
      {
        id: "thr_link_cards_video",
        title: "Loop video poster frame",
        minutesAgo: 14_400,
        state: "quiet",
      },
    ],
  },
];

const PERSONAL_CHATS: readonly ChatSpec[] = [
  {
    id: "thr_personal_week",
    title: "Plan the week",
    minutesAgo: 30,
    state: "unread",
  },
  {
    id: "thr_personal_reading",
    title: "Reading list",
    minutesAgo: 2_000,
    state: "quiet",
  },
];

function projectSource(spec: ShellProjectSpec): ProjectSource {
  return {
    id: `src_${spec.id}`,
    projectId: spec.id,
    type: "local_path",
    hostId: spec.hostId,
    path: spec.root,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  };
}

function shellProject(spec: ShellProjectSpec): ProjectWithThreadsResponse {
  return {
    ...makeProject({
      id: spec.id,
      name: spec.name,
      sources: [projectSource(spec)],
    }),
    defaultExecutionOptions: null,
    threads: spec.chats.map((chatSpec) => chat(spec.id, chatSpec)),
  };
}

export const SHELL_STORY_NAVIGATION: SidebarBootstrapResponse = {
  sections: [],
  groups: [],
  projects: SHELL_PROJECT_SPECS.map(shellProject),
  orderedProjectIds: [
    ...SHELL_PROJECT_SPECS.map((spec) => spec.id),
    PERSONAL_PROJECT_ID,
  ],
  personalProject: {
    ...makeProject({
      id: PERSONAL_PROJECT_ID,
      kind: "personal",
      name: "Personal",
      sources: [],
    }),
    defaultExecutionOptions: null,
    threads: PERSONAL_CHATS.map((chatSpec) =>
      chat(PERSONAL_PROJECT_ID, chatSpec),
    ),
  },
};

export const SHELL_STORY_PROJECT_IDS: readonly string[] = [
  ...SHELL_PROJECT_SPECS.map((spec) => spec.id),
  PERSONAL_PROJECT_ID,
];

export const SHELL_STORY_SCOPED_PROJECT_ID = "proj_omnyo_private";

export const SHELL_STORY_OPEN_THREAD_ID = "thr_op_topics";

export interface StoryHostFile {
  hostId: string;
  root: string;
  path: string;
}

export const SHELL_STORY_HOST_FILES: readonly StoryHostFile[] =
  SHELL_PROJECT_SPECS.flatMap((spec) =>
    [...(spec.icon === null ? [] : [spec.icon.path]), ...spec.otherFiles].map(
      (path) => ({ hostId: spec.hostId, root: spec.root, path }),
    ),
  );

export const SHELL_STORY_PROJECT_FILE_IMAGES: ReadonlyMap<string, string> =
  new Map(
    SHELL_PROJECT_SPECS.flatMap((spec) =>
      spec.icon === null
        ? []
        : [
            [
              buildProjectFileContentUrl(spec.id, spec.icon.path, {
                environmentId: null,
                hostId: spec.hostId,
              }),
              `data:image/svg+xml,${encodeURIComponent(spec.icon.svg)}`,
            ] as const,
          ],
    ),
  );

export interface ShellStoryNavPanel {
  pluginId: string;
  id: string;
  title: string;
  icon: string;
}

export const SHELL_STORY_NAV_PANELS: readonly ShellStoryNavPanel[] = [
  {
    pluginId: "resources",
    id: "resources",
    title: "Resources",
    icon: "Laptop",
  },
  {
    pluginId: "automations",
    id: "automations",
    title: "Automations",
    icon: "Repeat",
  },
  {
    pluginId: "workflows",
    id: "workflows",
    title: "Workflows",
    icon: "Workflow",
  },
  {
    pluginId: "github",
    id: "pulls",
    title: "Pull requests",
    icon: "GitPullRequest",
  },
  { pluginId: "docs", id: "docs", title: "Docs", icon: "FileText" },
  { pluginId: "tasks", id: "tasks", title: "Tasks", icon: "ListTodo" },
  {
    pluginId: "prompt-library",
    id: "prompts",
    title: "Prompts",
    icon: "Brain",
  },
  {
    pluginId: "browser-automation",
    id: "browser",
    title: "Browser",
    icon: "Browser",
  },
  {
    pluginId: "scheduled-send",
    id: "scheduled",
    title: "Scheduled",
    icon: "Calendar",
  },
  {
    pluginId: "storage-retention",
    id: "storage",
    title: "Storage",
    icon: "Archive",
  },
  { pluginId: "stats", id: "stats", title: "Stats", icon: "GridView" },
  {
    pluginId: "side-chat",
    id: "side-chat",
    title: "Side chat",
    icon: "SideChat",
  },
];

function weeklyBar(
  accountId: string,
  name: string,
  remainingPercent: number,
  serving: "serving" | "next" | "idle",
  resetInHours: number,
  now: number,
) {
  return {
    accountId,
    name,
    plan: "Max",
    remainingPercent,
    resetAt: now + resetInHours * 60 * MINUTE_MS,
    windowMinutes: 10_080,
    status: remainingPercent === 0 ? "exhausted" : "ready",
    serving,
    fiveHourWarning: null,
  };
}

function usageAccount(
  id: string,
  name: string,
  weeklyRemaining: number,
  serving: "serving" | "next" | "idle",
  now: number,
) {
  const exhausted = weeklyRemaining === 0;

  return {
    id,
    name,
    plan: "Max",
    enabled: true,
    canResetCredits: false,
    status: exhausted ? "exhausted" : "ready",
    statusLabel: exhausted ? "Weekly limit reached" : "Ready",
    serving,
    resetAt: null,
    lastUsedAt: now - 4 * MINUTE_MS,
    observedAt: now - MINUTE_MS,
    stale: false,
    error: null,
    cells: [
      {
        key: "weekly",
        percent: 100 - weeklyRemaining,
        tone: exhausted ? "blocked" : weeklyRemaining <= 20 ? "warn" : "ok",
        resetAt: null,
        gating: exhausted,
      },
    ],
  };
}

export function shellStoryUsageSnapshot(now: number) {
  return {
    fetchedAt: now,
    error: null,
    poolUnavailable: false,
    groups: [
      {
        providerId: "claude-code",
        poolProvider: "claude",
        routingEnabled: true,
        readyCount: 2,
        totalCount: 5,
        nextCapacityAt: now + 4 * 60 * MINUTE_MS,
        weeklyBars: [
          {
            ...weeklyBar("acct_claude_burst", "Burst", 100, "idle", 120, now),
            status: "held",
            fiveHourWarning: {
              remainingPercent: 0,
              exhausted: true,
              resetAt: now + 4 * 60 * MINUTE_MS,
            },
          },
          weeklyBar("acct_claude_work", "Work", 100, "serving", 140, now),
          weeklyBar("acct_claude_studio", "Studio", 0, "idle", 48, now),
          weeklyBar("acct_claude_team", "Team", 56, "next", 90, now),
          {
            ...weeklyBar("acct_claude_spare", "Spare", 0, "idle", 0, now),
            remainingPercent: null,
            resetAt: null,
            windowMinutes: null,
            status: "disabled",
          },
        ],
        columns: [{ key: "weekly", label: "7D" }],
        accounts: [
          usageAccount("acct_claude_burst", "Burst", 100, "idle", now),
          usageAccount("acct_claude_work", "Work", 100, "serving", now),
          usageAccount("acct_claude_studio", "Studio", 0, "idle", now),
          usageAccount("acct_claude_team", "Team", 56, "next", now),
          {
            ...usageAccount("acct_claude_spare", "Spare", 0, "idle", now),
            enabled: false,
            status: "disabled",
            statusLabel: "Disabled",
          },
        ],
      },
      {
        providerId: "codex",
        poolProvider: "codex",
        routingEnabled: true,
        readyCount: 2,
        totalCount: 2,
        nextCapacityAt: null,
        weeklyBars: [
          weeklyBar("acct_codex_work", "Work", 77, "serving", 52, now),
          weeklyBar("acct_codex_team", "Team", 25, "idle", 140, now),
        ],
        columns: [{ key: "weekly", label: "7D" }],
        accounts: [
          usageAccount("acct_codex_work", "Work", 77, "serving", now),
          usageAccount("acct_codex_team", "Team", 25, "idle", now),
        ],
      },
    ],
  };
}

export function shellStoryResourcesOverview(now: number) {
  return {
    machines: [
      {
        id: HOST_IDS.local,
        name: HOST_NAMES.local,
        connected: true,
        observedAt: now - 2_000,
        error: null,
        snapshot: {
          cpu: 12,
          paused: false,
          blocked: false,
          gpu: { state: "ready" },
          jobs: [
            { state: "running", cpu: 4, gpu: false },
            { state: "running", cpu: 2, gpu: true },
            { state: "queued", cpu: 2, gpu: false },
          ],
        },
      },
      {
        id: HOST_IDS.remote,
        name: HOST_NAMES.remote,
        connected: true,
        observedAt: now - 3_000,
        error: null,
        snapshot: {
          cpu: 32,
          paused: false,
          blocked: false,
          gpu: { state: "busy" },
          jobs: [{ state: "running", cpu: 16, gpu: true }],
        },
      },
    ],
  };
}

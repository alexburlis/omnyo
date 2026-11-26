import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const MINUTE_MS = 60_000;

const PROJECT_ID = "proj_demo00000001";

const PERSONAL_PROJECT_ID = "proj_personal";

const DATA_DIR = "/home/demo/.omnyo";

const DEMO_VERSION = "demo";

export const READ_ONLY_ERROR = {
  error: {
    code: "read_only_demo",
    message: "This is a read-only demo server, so it cannot do that.",
  },
};

const CWD = "/home/demo/demo-app";

const PLUGIN_DIR = new URL(
  "./public/demo-plugins/thread-list/",
  import.meta.url,
);

const THREADS = [
  {
    id: "thr_demo00000001",
    title: "Add a dark mode toggle",
    minutesAgo: 12,
    rows: [
      ["user", "Add a dark mode toggle to the settings screen."],
      [
        "command",
        "rg -n 'theme' src --type ts",
        [
          'src/settings/appearance.ts:14:export const THEME_KEY = "theme";',
          "src/settings/appearance.ts:22:  applyPalette(resolveTheme(stored));",
          "src/app/boot.ts:41:  applyPalette(readTheme());",
        ].join("\n"),
      ],
      [
        "assistant",
        [
          "I looked at how the theme is applied today.",
          "",
          "The palette is set once at startup from `settings.theme`, so a toggle needs",
          "two things: a stored preference, and a listener that re-applies the palette",
          "without a reload.",
          "",
          "## Plan",
          "",
          "1. Persist the choice next to the other user preferences.",
          "2. Re-apply the palette when the value changes.",
          "3. Follow the system setting when the user has not chosen.",
          "",
          "```ts",
          "export function useTheme() {",
          '  const [mode, setMode] = usePreference("theme", "system");',
          "  useEffect(() => applyPalette(resolve(mode)), [mode]);",
          "  return { mode, setMode };",
          "}",
          "```",
          "",
          "Want me to make the change?",
        ].join("\n"),
      ],
    ],
  },
  {
    id: "thr_demo00000002",
    title: "Fix the flaky checkout test",
    minutesAgo: 90,
    rows: [
      ["user", "The checkout test fails about one run in five. Find out why."],
      [
        "command",
        "pnpm test checkout --repeat 20",
        [
          "✓ checkout > applies a discount code (18 runs)",
          "✗ checkout > applies a discount code (2 runs)",
          "  expected 1 request, received 2",
        ].join("\n"),
      ],
      [
        "assistant",
        [
          "The test does not wait for the first request to settle, so a retry",
          "sometimes lands inside the assertion window.",
          "",
          "The fix is to await the pending request instead of a fixed delay.",
        ].join("\n"),
      ],
    ],
  },
  {
    id: "thr_demo00000003",
    title: "Speed up the search index",
    minutesAgo: 240,
    rows: [
      [
        "user",
        "Search takes about two seconds on the large fixture. Where does the time go?",
      ],
      [
        "command",
        "node --cpu-prof scripts/search-bench.mjs",
        ["query 'invoice' 1984ms", "  buildIndex 1912ms", "  rank 61ms"].join(
          "\n",
        ),
      ],
      [
        "assistant",
        [
          "Almost all of it is in `buildIndex`, which re-reads every document on",
          "each query. Caching the index and invalidating it on write brings a",
          "warm query under 50ms.",
        ].join("\n"),
      ],
    ],
  },
];

const ZERO_ACTIVITY = {
  activeWorkflowCount: 0,
  activeBackgroundAgentCount: 0,
  activeBackgroundCommandCount: 0,
  activePlanModeCount: 0,
  activeGoalCount: 0,
  activeSubagentCount: 0,
};

const EXECUTION_OPTIONS = {
  providers: [],
  permissionCeiling: "full",
  models: [],
  selectedOnlyModels: [],
  modelLoadError: null,
  modelNotice: null,
};

const THREAD_TABS = {
  revision: 1,
  tabs: [{ id: "thread-info:thread-info:none", kind: "thread-info" }],
};

const MAINTENANCE = {
  contractVersion: 1,
  runtime: {
    runtimeId: `demo-${randomUUID()}`,
    processId: process.pid,
    parentProcessId: Math.max(process.ppid, 1),
    launchId: null,
    dataDir: DATA_DIR,
    serverHostId: null,
    appVersion: DEMO_VERSION,
    protocolVersion: 1,
  },
  hold: null,
  activity: {
    runningThreads: 0,
    pendingInteractions: 0,
    hostRpcs: 0,
    provisioning: 0,
    queuedDispatches: 0,
    pluginLoads: 0,
    pluginInvocations: 0,
    hungServices: 0,
  },
};

const UI_PREFERENCE_DEFAULTS = {
  "sidebar.organizationMode": "chronological",
  "sidebar.threadGrouping.environment": "auto",
  "sidebar.chronologicalSort": "updated",
  "sidebar.sortDirection": "default",
  "sidebar.sectionOrder": ["pinned", "projects", "threads"],
  "sidebar.manualSectionOrder": ["pinned", "sections", "threads"],
  "sidebar.machineSectionOrder": ["pinned", "machines", "threads"],
  "sidebar.hiddenGroups": [],
  "sidebar.footerOrder": [],
  "sidebar.hiddenFooterItems": [],
  "sidebar.pluginPanelOrder": [],
  "sidebar.visiblePluginPanels": null,
  "sidebar.threadListProvider": "__automatic__",
  "infoPanel.collapsedSections": [],
  "modelPicker.favorites": [],
  "modelPicker.hiddenModels": {},
  "modelPicker.footerFavorites": true,
};

const UI_PREFERENCES = {
  preferences: Object.fromEntries(
    Object.entries(UI_PREFERENCE_DEFAULTS).map(([key, value]) => [
      key,
      { revision: 0, value },
    ]),
  ),
};

const USAGE_STATUS = {
  count: {
    choice: "unset",
    effective: false,
    reason: "disabled",
    noticeRequired: false,
    attemptedWeek: null,
  },
  product: {
    choice: "unset",
    effective: false,
    reason: "disabled",
    erasure: "none",
    rawRetentionDays: 30,
  },
};

const SUBMISSION_CONTRACT = { version: 1, storeId: "demo" };

const SERVER_MOVE = { move: null, lastMove: null };

const APP_UPDATE = {
  activity: { phase: "idle" },
  available: null,
  blocked: null,
  current: { commit: null, version: DEMO_VERSION },
  installsWhenIdle: false,
  lastResult: null,
  newTurnsPausedForUpdate: false,
  runningThreadCount: 0,
  support: { kind: "unsupported", reason: "unmanaged" },
};

const SYSTEM_VERSION = {
  currentCommit: null,
  installKind: null,
  currentVersion: DEMO_VERSION,
  latestVersion: null,
  source: "npm",
  updateAvailable: false,
  isDevelopment: false,
  upgradeCommand: "",
};

const EMPTY_INBOX_REVISION = createHash("sha256")
  .update("[]")
  .digest("hex")
  .slice(0, 16);

const BOOT_PART_PATHS = {
  systemConfig: "/system/config",
  uiPreferences: "/preferences/ui",
  serverMove: "/server/move",
  appUpdate: "/system/app-update",
  pluginInstallJobs: "/plugins/install-jobs",
  pluginUpdateJobs: "/plugins/update-jobs",
  hosts: "/hosts",
  sidebarBootstrap: "/sidebar-bootstrap",
  plugins: "/plugins",
  systemVersion: "/system/version",
  systemProviders: "/system/providers",
  pluginSafeMode: "/plugins/safe-mode",
  shelvedThreads: "/threads",
  threadAttention: "/thread-attention",
};

const BOOT_IDENTITY = createHash("sha256")
  .update(`omnyo-boot-identity-v1\u0000${DATA_DIR}\u0000`)
  .digest("hex");

const PLUGINS = { plugins: [threadListPlugin()] };

function threadListPlugin() {
  const meta = JSON.parse(
    readFileSync(new URL("app.meta.json", PLUGIN_DIR), "utf8"),
  );

  const js = readFileSync(new URL("app.js", PLUGIN_DIR));
  const css = readFileSync(new URL("app.css", PLUGIN_DIR));

  const hash = createHash("sha256")
    .update(js)
    .update(css)
    .update(meta.sdkVersion)
    .digest("hex")
    .slice(0, 16);

  return {
    id: "thread-list",
    source: "builtin:thread-list",
    rootDir: "/demo/plugins/thread-list",
    version: meta.pluginVersion,
    provenance: "builtin",
    isOrphanedBuiltin: false,
    removable: false,
    publisherLabel: "Omnyo Official",
    official: true,
    repositoryUrl: null,
    sourceDisplay: "Built-in demo frontend",
    updateState: {},
    enabled: true,
    description: "Omnyo's sidebar thread list.",
    name: "Thread list",
    shortName: null,
    screenshots: [],
    collections: [],
    icon: "ListView",
    iconUrl: null,
    status: "running",
    statusDetail: null,
    handlerStats: { count: 0, totalMs: 0, maxMs: 0, errorCount: 0 },
    services: [],
    schedules: [],
    cliCommand: null,
    capabilities: [],
    hasSettings: false,
    app: {
      hasApp: true,
      bundle: {
        jsUrl: `/demo-plugins/thread-list/app.js?h=${hash}`,
        cssUrl: `/demo-plugins/thread-list/app.css?h=${hash}`,
        jsBytes: js.byteLength,
        hash,
        sdkMajor: meta.sdkMajor,
        sdkVersion: meta.sdkVersion,
        compatible: true,
      },
    },
    logoUrl: null,
    logoDarkUrl: null,
    providerIds: [],
    icons: {},
  };
}

function systemConfig(serverUrl) {
  return {
    commandDefaultsByProvider: {},
    serverAccess: {
      providers: [
        {
          id: "direct",
          displayName: "Direct URL",
          description: "Connect machines directly to this server URL.",
          pluginId: null,
          availability: null,
        },
      ],
      defaultProviderId: "direct",
      effectiveUrl: serverUrl,
      urlSource: "setting",
    },
    generalSettings: {
      showKeyboardHints: true,
      autoUpdateProviderClisOnStartup: true,
      showGitChanges: true,
      steerActiveThreadOnEnter: true,
      confirmThreadArchive: true,
      showDiagnosticEvents: false,
      keepHistoryAfterContextClear: false,
      compactExpiredCache: true,
      providerOrder: [],
      defaultProviderId: null,
      defaultThreadMachineId: null,
      defaultPermissionMode: "auto",
      modelPermissionModes: {},
      providerCompletedTurnDisplay: {},
      streamerMode: false,
      allowFastServiceTier: true,
      providerAllowFastServiceTier: {},
      telemetryEnabled: false,
      usageConsent: {
        version: 1,
        count: "unset",
        product: "unset",
        countSource: "initial",
        productSource: "initial",
        noticeVersion: 0,
      },
      crashReportsEnabled: false,
      managedBranchPrefix: "omnyo/",
      machineServerUrl: null,
      machineGitCredentialsEnabled: true,
      defaultMachineAccess: null,
      onboardingCompletedAt: "2026-11-01T00:00:00.000Z",
    },
    keybindings: [],
    defaultKeybindings: [],
    keybindingOverrides: [],
    experiments: {
      serverMove: false,
      performanceDiagnostics: false,
      autoCompactBeforeCacheExpiry: true,
    },
    performanceDiagnosticsAvailable: false,
    appearance: {
      themeId: "default",
      customCss: null,
      faviconColor: "default",
      resolvedCodeTheme: {
        dark: "pierre-dark",
        light: "pierre-light",
        files: {},
      },
    },
    customThemes: [],
    pluginThemes: [],
    featureFlags: { placeholder: false, timelineWindowEventBudget: 1500 },
    hostDaemonPort: null,
    localHelperPorts: [],
    serverUrl,
    primaryHostId: null,
    primaryHostPlatform: null,
    voiceTranscriptionEnabled: false,
    dataDir: DATA_DIR,
  };
}

function threadTimes(thread, now) {
  const updatedAt = now - thread.minutesAgo * MINUTE_MS;

  return { createdAt: updatedAt - 2 * MINUTE_MS, updatedAt };
}

function threadFields(thread, now) {
  const { createdAt, updatedAt } = threadTimes(thread, now);

  return {
    id: thread.id,
    projectId: PROJECT_ID,
    environmentId: null,
    providerId: "demo",
    claudeProfileBinding: null,
    title: thread.title,
    titleFallback: thread.title,
    sectionId: null,
    groupId: null,
    status: "idle",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    pluginHome: false,
    quiet: false,
    archivedAt: null,
    pinnedAt: null,
    shelvedAt: null,
    deletedAt: null,
    lastReadAt: now,
    latestAttentionAt: updatedAt,
    lastMessageAt: updatedAt,
    createdAt,
    updatedAt,
    runtime: { displayStatus: "idle" },
    work: null,
  };
}

function threadListEntry(thread, now) {
  return {
    ...threadFields(thread, now),
    activity: ZERO_ACTIVITY,
    queuedWork: "none",
    pinSortKey: null,
    shelfSortKey: null,
    hasPendingInteraction: false,
    environmentHostId: null,
    environmentName: null,
    environmentBranchName: "main",
    environmentPath: null,
    environmentProviderId: null,
    environmentIsWorktree: null,
    environmentWorkspaceDisplayKind: "other",
  };
}

function threadResponse(thread, now) {
  return {
    ...threadFields(thread, now),
    activeBackgroundAgentCount: 0,
    canRestoreEnvironment: false,
    canSpawnChild: false,
    queuedMessageCount: 0,
  };
}

function project(id, name, threads, createdAt, updatedAt) {
  return {
    id,
    kind: "standard",
    name,
    gitRemoteUrl: null,
    createdAt,
    updatedAt,
    sources: [],
    threads,
    defaultExecutionOptions: null,
  };
}

function sidebarBootstrap(now) {
  const createdAt = now - 7 * 24 * 60 * MINUTE_MS;
  const threads = THREADS.map((thread) => threadListEntry(thread, now));

  const demo = project(
    PROJECT_ID,
    "demo-app",
    threads,
    createdAt,
    Math.max(...threads.map((thread) => thread.updatedAt)),
  );

  return {
    sections: [],
    groups: [],
    orderedProjectIds: [PROJECT_ID, PERSONAL_PROJECT_ID],
    projects: [demo],
    personalProject: project(
      PERSONAL_PROJECT_ID,
      "Personal",
      [],
      createdAt,
      createdAt,
    ),
  };
}

function timelineRow(thread, row, index, startedAt) {
  const [kind, text, output] = row;
  const seq = index + 1;
  const at = startedAt + index * 3_000;

  const base = {
    threadId: thread.id,
    turnId: `${thread.id}-turn-1`,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: at,
    createdAt: at,
  };

  if (kind === "command") {
    return {
      ...base,
      id: `${thread.id}:command:${seq}`,
      kind: "work",
      workKind: "command",
      status: "completed",
      callId: `${thread.id}-call-${seq}`,
      command: text,
      cwd: CWD,
      source: null,
      output,
      exitCode: 0,
      completedAt: at + 1_200,
      approvalStatus: null,
      activityIntents: [],
    };
  }

  const conversation = {
    ...base,
    id: `${thread.id}:conversation:${seq}`,
    kind: "conversation",
    messageSeq: seq,
    text,
    role: kind,
  };

  if (kind === "assistant") {
    return {
      ...conversation,
      attachments: null,
      turnRequest: null,
      turnGit: null,
    };
  }

  return {
    ...conversation,
    mentions: [],
    attachments: {
      webImages: 0,
      localImages: 0,
      localFiles: 0,
      imageUrls: [],
      localImagePaths: [],
      localFilePaths: [],
      localFileDetails: [],
    },
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      clientRequestId: null,
      isGrouped: false,
      kind: "message",
      status: "accepted",
    },
  };
}

function timeline(thread, now) {
  const { createdAt } = threadTimes(thread, now);

  return {
    rows: thread.rows.map((row, index) =>
      timelineRow(thread, row, index, createdAt),
    ),
    contextBoundarySeq: null,
    completedTurnDisplay: "flat",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    goal: null,
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    timelinePage: {
      kind: "latest",
      segmentLimit: 20,
      returnedSegmentCount: 1,
      hasOlderRows: false,
      olderCursor: null,
    },
    maxSeq: thread.rows.length,
  };
}

function conversationOutline(thread, now, role) {
  const rows = timeline(thread, now).rows.filter(
    (row) =>
      row.kind === "conversation" && (role === null || row.role === role),
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      role: row.role,
      preview: row.text.replace(/\s+/gu, " ").trim().slice(0, 200).trimEnd(),
      attachmentSummary: null,
    })),
    maxSeq: thread.rows.length,
  };
}

function apiError(code, message) {
  return { error: { code, message } };
}

function ok(body) {
  return { status: 200, body };
}

function inbox(now) {
  return {
    revision: EMPTY_INBOX_REVISION,
    generatedAt: now,
    inbox: [],
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      needsYou: 0,
      inbox: 0,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

const PROMPT_HISTORY_PATH = new RegExp(
  `^/api/v1/projects/(${PROJECT_ID}|${PERSONAL_PROJECT_ID})/prompt-history$`,
  "u",
);

const THREAD_VIEWS = [
  "timeline",
  "tabs",
  "default-execution-options",
  "conversation-outline",
  "waits",
  "interactions",
  "queued-messages",
  "prompt-history",
];

const THREAD_PATH = new RegExp(
  `^/api/v1/threads/(thr_[^/]+)(/(?:${THREAD_VIEWS.join("|")}))?$`,
  "u",
);

function boot(query, serverUrl) {
  const requested = query.get("parts");
  const known = Object.keys(BOOT_PART_PATHS);
  const names = requested === null ? known : requested.split(",");

  if (names.some((name) => !known.includes(name))) {
    return {
      status: 400,
      body: apiError(
        "invalid_request",
        "parts must list known boot parts separated by commas",
      ),
    };
  }

  const parts = Object.fromEntries(
    known
      .filter((name) => names.includes(name))
      .map((name) => [
        name,
        api({
          method: "GET",
          path: `/api/v1${BOOT_PART_PATHS[name]}`,
          query: new URLSearchParams(),
          serverUrl,
        }) ?? { status: 501, body: READ_ONLY_ERROR },
      ]),
  );

  return ok({ version: 1, serverIdentity: BOOT_IDENTITY, parts });
}

export function api({ method, path, query, serverUrl }) {
  const now = Date.now();
  const read = method === "GET" || method === "HEAD";

  if (read) {
    switch (path) {
      case "/api/v1/boot":
        return boot(query, serverUrl);
      case "/health":
        return ok({ ok: true });
      case "/api/v1/system/config":
        return ok(systemConfig(serverUrl));
      case "/api/v1/plugins":
        return ok(PLUGINS);
      case "/api/v1/sidebar-bootstrap":
        return ok(sidebarBootstrap(now));
      case "/api/v1/thread-attention":
        return ok({ questions: [], callbacks: [] });
      case "/api/v1/threads":
        return ok([]);
      case "/api/v1/system/execution-options":
        return ok(EXECUTION_OPTIONS);
      case "/api/v1/server/maintenance":
        return ok(MAINTENANCE);
      case "/api/v1/server/runtime":
        return ok({ runtimeId: MAINTENANCE.runtime.runtimeId });
      case "/api/v1/preferences/ui":
        return ok(UI_PREFERENCES);
      case "/api/v1/system/usage":
        return ok(USAGE_STATUS);
      case "/api/v1/submissions/contract":
        return ok(SUBMISSION_CONTRACT);
      case "/api/v1/server/move":
        return ok(SERVER_MOVE);
      case "/api/v1/system/app-update":
        return ok(APP_UPDATE);
      case "/api/v1/system/version":
        return ok(SYSTEM_VERSION);
      case "/api/v1/inbox":
        return ok(inbox(now));
      case "/api/v1/system/providers":
      case "/api/v1/system/providers/catalog":
      case "/api/v1/hosts":
        return ok([]);
      case "/api/v1/system/providers/state":
      case "/api/v1/system/environment-providers":
      case "/api/v1/system/machine-providers":
        return ok({ providers: [] });
      case "/api/v1/plugins/contributions":
        return ok({ cliCommands: [], mentionProviders: [] });
      case "/api/v1/plugins/install-jobs":
      case "/api/v1/plugins/update-jobs":
        return ok({ jobs: [] });
      case "/api/v1/plugins/safe-mode":
        return ok({ enabled: false });
    }
  }

  if (
    method === "POST" &&
    path === "/api/v1/plugins/thread-list/rpc/listPreferences"
  ) {
    return ok({ ok: true, result: { preferences: {} } });
  }

  if (read && PROMPT_HISTORY_PATH.test(path)) return ok([]);

  const match = THREAD_PATH.exec(path);

  if (!match) return null;
  const thread = THREADS.find((candidate) => candidate.id === match[1]);

  if (!thread) {
    return {
      status: 404,
      body: apiError("thread_not_found", "This thread does not exist."),
    };
  }

  const view = match[2] ?? "";

  if (read && view === "") return ok(threadResponse(thread, now));

  if (read && view === "/timeline") return ok(timeline(thread, now));

  if (read && view === "/tabs") return ok(THREAD_TABS);

  if (read && view === "/default-execution-options") return ok(null);

  if (read && view === "/conversation-outline")
    return ok(conversationOutline(thread, now, query.get("role")));

  if (read && view === "/waits") return ok({ waitingChatIds: [], waits: [] });

  if (
    read &&
    ["/interactions", "/queued-messages", "/prompt-history"].includes(view)
  )
    return ok([]);

  return null;
}

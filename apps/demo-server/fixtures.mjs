import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const MINUTE_MS = 60_000;

const PROJECT_ID = "proj_demo00000001";

const PERSONAL_PROJECT_ID = "proj_personal";

const DATA_DIR = "/home/demo/.omnyo";

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
    appVersion: "demo",
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
    sourceDisplay: "Built-in demo frontend",
    updateState: {},
    enabled: true,
    description: "Omnyo's sidebar thread list.",
    name: "Thread list",
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
      providerCompletedTurnDisplay: {},
      streamerMode: false,
      allowFastServiceTier: true,
      providerAllowFastServiceTier: {},
      telemetryEnabled: false,
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
    experiments: { serverMove: false, performanceDiagnostics: false },
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
    title: thread.title,
    titleFallback: thread.title,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
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

function apiError(code, message) {
  return { error: { code, message } };
}

function ok(body) {
  return { status: 200, body };
}

const THREAD_PATH = /^\/api\/v1\/threads\/(thr_[^/]+)(\/timeline|\/tabs)?$/u;

export function api({ method, path, serverUrl }) {
  const now = Date.now();
  const read = method === "GET" || method === "HEAD";

  if (read) {
    switch (path) {
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
    }
  }

  if (
    method === "POST" &&
    path === "/api/v1/plugins/thread-list/rpc/listPreferences"
  ) {
    return ok({ ok: true, result: { preferences: {} } });
  }

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

  return null;
}

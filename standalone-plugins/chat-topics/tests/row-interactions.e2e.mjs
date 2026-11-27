import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { chromium, webkit } from "playwright-core";
import { work } from "./work-fixtures.ts";
import {
  entry as inboxEntry,
  snapshot as inboxSnapshot,
  waiting as inboxWaiting,
} from "./inbox-fixtures.ts";

const origin = "https://chat-topics-row.test";

const require = createRequire(import.meta.url);

const reactPath = dirname(require.resolve("react/package.json"));

const reactDomPath = dirname(require.resolve("react-dom/package.json"));

const domRequire = createRequire(join(reactDomPath, "package.json"));

const schedulerPath = dirname(domRequire.resolve("scheduler/package.json"));

const moduleSources = Object.fromEntries(
  await Promise.all(
    [
      ["react", join(reactPath, "cjs/react.production.js")],
      ["react-dom", join(reactDomPath, "cjs/react-dom.production.js")],
      ["react-dom/client", join(reactDomPath, "cjs/react-dom-client.production.js")],
      ["react/jsx-runtime", join(reactPath, "cjs/react-jsx-runtime.production.js")],
      ["scheduler", join(schedulerPath, "cjs/scheduler.production.js")],
      ["sonner", require.resolve("sonner")],
    ].map(async ([name, path]) => [name, await readFile(path, "utf8")]),
  ),
);

const bundlePaths = process.argv.slice(2).filter((value) => !value.startsWith("--"));

const bundle = await readFile(resolve(bundlePaths[0] ?? "dist/app.js"), "utf8");

const css = await readFile(resolve(bundlePaths[1] ?? "dist/app.css"), "utf8");

const taskManagerOnly = process.argv.includes("--task-manager-only");

const shelfOnly = process.argv.includes("--shelf-only");

const summariesOnly = process.argv.includes("--summaries-only");

const descriptionAlignmentOnly = process.argv.includes("--description-alignment-only");

const waitingOnly = process.argv.includes("--waiting-only");

const runningTitleOnly = process.argv.includes("--running-title-only");

const inboxLoadingOnly = process.argv.includes("--inbox-loading-only");

const runningOnly = process.argv.includes("--running-only");

const projectAttentionOnly = process.argv.includes("--project-attention-only");

const headerOnly = runningOnly || projectAttentionOnly || process.argv.includes("--header-only");

const selectionOnly = process.argv.includes("--selection-only");

const groupsOnly = process.argv.includes("--groups-only");

const diagnosticsOnly = process.argv.includes("--diagnostics-only");

const capsuleOnly = process.argv.includes("--capsule-only");

const subagentsOnly = process.argv.includes("--subagents-only");

const childToggleOnly = process.argv.includes("--child-toggle-only");

const hoverStabilityOnly = process.argv.includes("--hover-stability-only");

const childFailureOnly = process.argv.includes("--inbox-child-failure-only");

const runningFamily = process.argv.includes("--inbox-running-family-only");

const restingFamily = process.argv.includes("--inbox-resting-family-only");

const waitingFamily = process.argv.includes("--inbox-waiting-family-only");

const inboxFamilyOnly =
  runningFamily || restingFamily || waitingFamily || process.argv.includes("--inbox-family-only");

const browserServer =
  (taskManagerOnly || childToggleOnly || subagentsOnly || inboxFamilyOnly) &&
  !process.argv.includes("--webkit")
    ? await chromium.launchServer({ channel: "chrome", headless: true, chromiumSandbox: true })
    : null;

const browser =
  browserServer !== null
    ? await chromium.connect(browserServer.wsEndpoint())
    : process.argv.includes("--webkit")
      ? await webkit.launch({ headless: true })
      : await chromium.launch({ channel: "chrome", headless: true });

const checks = [];

const motionEvidence = process.env.OMNYO_TEST_MOTION_EVIDENCE ?? null;

if (motionEvidence !== null) await mkdir(motionEvidence, { recursive: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  if (childToggleOnly || subagentsOnly || inboxLoadingOnly)
    await page.emulateMedia({ reducedMotion: "reduce" });

  if (capsuleOnly) page.on("pageerror", (error) => console.error(error.message));
  page.setDefaultTimeout(3000);

  const expandRunning = async () => {
    const toggle = page.locator('[data-feed-running][aria-expanded="false"]');

    if ((await toggle.count()) > 0) await toggle.click();
  };

  const needsYou = (id, title) =>
    inboxEntry(id, {
      title,
      card: { ...inboxEntry(id).card, kind: "question", questionMode: "required" },
    });

  const fixtureInbox = (change = {}) =>
    inboxSnapshot({
      inbox: [
        needsYou("human", "Needs input"),
        inboxEntry("error", { title: "Failed chat" }),
        inboxEntry("pinned", { title: "Pinned chat" }),
      ],
      running: [inboxEntry("active", { title: "Active chat", view: "running", card: null })],
      waiting: [inboxWaiting("callback", { group: "comes-back" })],
      ...change,
    });

  let suppliedInboxRevision = 0;

  const supplyInbox = async (change) => {
    suppliedInboxRevision += 1;
    const snapshot = { ...change, revision: `supplied-${suppliedInboxRevision}` };
    await page.waitForFunction(() =>
      globalThis.__rowInteractions.inboxRequests.some((request) => !request.settled),
    );
    await page.evaluate((snapshot) => {
      for (const request of globalThis.__rowInteractions.inboxRequests)
        if (!request.settled) request.resolve(snapshot);
    }, snapshot);
    await page.locator("[data-feed]").waitFor();
  };

  await page.route(`${origin}/**`, (route) =>
    route.request().url().endsWith("/__chat-topics-row-fixture.js")
      ? route.fulfill({ contentType: "text/javascript", body: bundle })
      : route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><html><head></head><body></body></html>",
        }),
  );
  await page.goto(origin);
  await page.evaluate(
    ([sources, groupsOnly]) => {
      const loaded = new Map();

      const load = (name) => {
        if (loaded.has(name)) return loaded.get(name).exports;
        const module = { exports: {} };
        loaded.set(name, module);
        new Function("module", "exports", "require", "process", sources[name])(
          module,
          module.exports,
          load,
          { env: { NODE_ENV: "production" } },
        );

        return module.exports;
      };

      const react = load("react");
      const MenuState = react.createContext(null);

      const contextMenu = groupsOnly
        ? {
            Root: ({ children }) => {
              const [open, setOpen] = react.useState(false);
              const closeFocus = react.useRef(null);

              return react.createElement(
                MenuState.Provider,
                { value: { open, setOpen, closeFocus } },
                children,
              );
            },
            Trigger: ({ children, disabled }) => {
              const menu = react.useContext(MenuState);

              return react.cloneElement(children, {
                onContextMenu: (event) => {
                  if (disabled) return;
                  event.preventDefault();
                  menu.setOpen(true);
                },
              });
            },
            Portal: ({ children }) => (react.useContext(MenuState).open ? children : null),
            Content: ({ children, className, onCloseAutoFocus, "aria-label": label }) => {
              react.useContext(MenuState).closeFocus.current = onCloseAutoFocus ?? null;

              return react.createElement(
                "div",
                { role: "menu", className, "aria-label": label },
                children,
              );
            },
            Item: ({ children, onSelect, ...props }) => {
              const menu = react.useContext(MenuState);

              return react.createElement(
                "div",
                {
                  ...props,
                  role: "menuitem",
                  onClick: () => {
                    onSelect?.(new Event("select"));
                    menu.setOpen(false);
                    menu.closeFocus.current?.({ preventDefault: () => {} });
                  },
                },
                children,
              );
            },
          }
        : {
            Root: ({ children }) => children,
            Trigger: ({ children }) => children,
            Portal: () => null,
          };

      globalThis.__omnyoPluginRuntime = {
        react,
        reactDom: load("react-dom"),
        reactDomClient: load("react-dom/client"),
        sonner: load("sonner"),
        jsxRuntime: load("react/jsx-runtime"),
        pluginSdkApp: {
          experimental_Icon: ({ name, className, ...props }) =>
            react.createElement(
              "svg",
              { ...props, className, "data-icon": name, viewBox: "0 0 24 24" },
              name === "ChevronRight"
                ? react.createElement("path", {
                    d: "M9 6L15 12L9 18",
                    fill: "none",
                    stroke: "currentColor",
                    strokeWidth: 1.5,
                  })
                : name === "MoreHorizontal"
                  ? [5, 12, 19].map((cx) =>
                      react.createElement("circle", {
                        key: cx,
                        cx,
                        cy: 12,
                        r: 1.5,
                        fill: "currentColor",
                      }),
                    )
                  : react.createElement("circle", { cx: 6, cy: 6, r: 5 }),
            ),
          experimental_ResponsiveDrawerShell: ({ open, srLabel, children }) =>
            open
              ? react.createElement("div", { role: "dialog", "aria-label": srLabel }, children)
              : null,
          experimental_ProjectIcon: () => null,
          experimental_ThreadAttention: () => null,
          experimental_THREAD_ACTION_GROUPS: { organize: "organize" },
        },
        radixContextMenu: contextMenu,
      };
    },
    [moduleSources, groupsOnly],
  );
  await page.addStyleTag({
    content: `
    .ctl-panel .size-3\\.5 { width: 0.875rem; height: 0.875rem; }
    *, ::before, ::after { box-sizing: border-box; }
    button, input { font: inherit; color: inherit; }
    button { border: 0; padding: 0; background: none; }
    a { color: inherit; text-decoration: none; }
    h3, p { margin: 0; }
    ${css}
  `,
  });
  await page.evaluate(async (capsuleOnly) => {
    const runtime = globalThis.__omnyoPluginRuntime;
    const react = runtime.react;

    const base = {
      projectId: "row-fixture-project",
      parentThreadId: null,
      lifecycleOwnerThreadId: null,
      sourceThreadId: null,
      sectionId: null,
      originKind: null,
      originPluginId: null,
      providerId: "row-fixture-provider",
      titleFallback: "Fixture chat",
      experimental_subtitle: "Existing draft subtitle",
      status: "active",
      runtimeStatus: "idle",
      queuedWork: "none",
      hasPendingInteraction: false,
      indicator: null,
      indicatorLabel: null,
      isUnread: false,
      isPinned: false,
      isArchived: false,
      archivedAt: null,
      pinnedAt: null,
      href: "#row-fixture",
      isHidden: false,
      environment: null,
      host: null,
      createdAt: 4,
      latestAttentionAt: 0,
      activity: { workflows: 0, backgroundAgents: 0, backgroundCommands: 0, planMode: 0, goals: 0 },
    };

    let state = {
      status: "ready",
      projects: [{ id: base.projectId, name: "Fixture project", isPersonal: false }],
      sections: [],
      experimental_groups: [],
      threads: [
        { ...base, id: "active", title: "Active chat", displayTitle: "Active chat" },
        {
          ...base,
          id: "callback",
          title: "Callback chat",
          displayTitle: "Callback chat",
          createdAt: 3,
          indicator: "callback-waiting",
        },
        {
          ...base,
          id: "human",
          title: "Needs input",
          displayTitle: "Needs input",
          createdAt: 2,
          hasPendingInteraction: true,
          indicator: "waiting-for-input",
          indicatorLabel: "Thread needs user input",
        },
        {
          ...base,
          id: "error",
          title: "Failed chat",
          displayTitle: "Failed chat",
          createdAt: 1,
          status: "error",
          indicator: "unread-error",
          indicatorLabel: "Unread thread failed",
        },
        {
          ...base,
          id: "pinned",
          title: "Pinned chat",
          displayTitle: "Pinned chat",
          createdAt: 5,
          status: "idle",
          isPinned: true,
          pinnedAt: 5,
        },
      ],
    };

    if (capsuleOnly)
      state.threads = state.threads.map((thread) => ({
        ...thread,
        experimental_work: {
          primary: {
            label:
              thread.id === "human"
                ? "needs-you"
                : thread.id === "error"
                  ? "blocked"
                  : ["active", "callback"].includes(thread.id)
                    ? "working"
                    : "open",
            reason: { code: "fixture", text: "Recorded work" },
          },
          activity: [],
          requiredInput: [],
          optionalInput: [],
          failures: [],
          waits: [],
          nextActors: [],
          archive: { eligible: false, recommended: false, reason: "Recorded work" },
          assessment: {
            availability: "available",
            reason: "Recorded assessment",
            sourceSeq: null,
            suggestion: "omitted",
            noSuggestionReason: null,
            waitingOn: null,
          },
        },
      }));

    const working = ["active", "starting"];
    let readyIds = new Set();

    const workOf = (thread) => {
      if (capsuleOnly) return thread;

      const label =
        thread.hasPendingInteraction || thread.indicator === "waiting-for-input"
          ? "needs-you"
          : thread.status === "error" ||
              thread.indicator === "unread-error" ||
              thread.queuedWork === "failed"
            ? "blocked"
            : working.includes(thread.status) || working.includes(thread.runtimeStatus)
              ? "working"
              : thread.indicator === "callback-waiting" || thread.queuedWork === "waiting"
                ? "waiting"
                : readyIds.has(thread.id)
                  ? "ready-to-archive"
                  : "open";

      return {
        ...thread,
        experimental_work: {
          primary: {
            label,
            reason: {
              code: "fixture",
              text:
                thread.indicatorLabel ?? (label === "working" ? "Thread working" : "Recorded work"),
            },
          },
          activity: [],
          requiredInput: [],
          optionalInput: [],
          failures: [],
          waits: [],
          nextActors: [],
          archive: { eligible: false, recommended: false, reason: "Recorded work" },
          assessment: {
            availability: "available",
            reason: "Recorded assessment",
            sourceSeq: null,
            suggestion: "omitted",
            noSuggestionReason: null,
            waitingOn: null,
          },
        },
      };
    };

    state = { ...state, threads: state.threads.map(workOf) };

    const listeners = new Set();
    const selectionListeners = new Set();

    function emitThreads() {
      for (const listener of listeners) listener();
      markInboxDirty();
    }

    const fixture = {
      usageCalls: 0,
      usageFailed: false,
      usage: {
        hosts: [
          {
            hostId: "host",
            hostName: "Build Mac",
            system: {
              cpuPercent: 26,
              gpuPercent: 18,
              memoryUsedBytes: 8589934592,
              memoryTotalBytes: 17179869184,
            },
            coverage: "partial",
            threads: [
              {
                threadId: "active",
                cpuPercent: 12.5,
                memoryBytes: 33554432,
                tasks: [
                  { pid: 104, name: "compile-fixture", cpuPercent: 12.5, memoryBytes: 33554432 },
                ],
              },
              {
                threadId: "callback",
                cpuPercent: null,
                memoryBytes: 1048576,
                tasks: [
                  { pid: 238, name: "watch-fixture", cpuPercent: null, memoryBytes: 1048576 },
                ],
              },
            ],
          },
          {
            hostId: "second-machine",
            hostName: "Build PC",
            coverage: "unsupported",
            system: {
              cpuPercent: 7,
              gpuPercent: null,
              memoryUsedBytes: 1073741824,
              memoryTotalBytes: 8589934592,
            },
            threads: [],
          },
        ],
      },
      requests: [],
      shelfMoves: [],
      diagnostics: [],
      mode: "success",
      release: null,
      active: "active",
      compact: false,
      tags: [],
      tagged: [],
      inboxRequests: [],
      inboxActions: [],
      nextInbox: null,
      deliverInbox(snapshot) {
        const pending = fixture.inboxRequests.filter((request) => !request.settled);

        if (pending.length === 0) fixture.nextInbox = snapshot;

        for (const request of pending) request.resolve(snapshot);
      },
      scope: { kind: "project", projectId: base.projectId },
      hostSelection: [],
      selectionWrites: [],
      groupCalls: [],
      setHostSelection(ids) {
        fixture.hostSelection = ids;

        for (const listener of selectionListeners) listener();
      },
      setGroups(groups) {
        state = { ...state, experimental_groups: groups };
        emitThreads();
      },
      patch(id, patch) {
        state = {
          ...state,
          threads: state.threads.map((thread) =>
            thread.id !== id
              ? thread
              : "experimental_work" in patch
                ? { ...thread, ...patch }
                : workOf({ ...thread, ...patch }),
          ),
        };

        emitThreads();
      },
      append(count) {
        state = {
          ...state,
          threads: [
            ...state.threads,
            ...Array.from({ length: count }, (_, index) =>
              workOf({
                ...base,
                id: `extra-${index}`,
                title: `Extra chat ${index}`,
                displayTitle: `Extra chat ${index}`,
                status: "idle",
                createdAt: -index,
              }),
            ),
          ],
        };

        emitThreads();
      },
      ready(ids) {
        readyIds = new Set(ids);
        state = { ...state, threads: state.threads.map(workOf) };

        emitThreads();
        window.dispatchEvent(
          new CustomEvent("omnyo-tidy:readiness", {
            detail: { threadIds: ids, revision: Date.now() },
          }),
        );
      },
    };

    const update = (input) => {
      fixture.requests.push(input);

      const finish = () => {
        state = {
          ...state,
          threads: state.threads.map((thread) =>
            thread.id === input.threadId
              ? { ...thread, title: input.title, displayTitle: input.title }
              : thread,
          ),
        };

        emitThreads();
      };

      if (fixture.mode === "failure") return Promise.reject(new Error("Fixture save refusal"));

      if (fixture.mode === "hold")
        return new Promise((done) => {
          fixture.release = () => {
            finish();
            done();
          };
        });
      finish();

      return Promise.resolve();
    };

    const sdk = {
      experimental_inbox: {
        act: async ({ request }) => {
          fixture.inboxActions.push(request);

          return { moveId: "fixture-move", entry: null };
        },
        snapshot: ({ signal } = {}) =>
          new Promise((resolve, reject) => {
            const request = {
              signal,
              settled: false,
              resolve: (value) => {
                request.settled = true;
                resolve(value);
              },
              reject: (reason) => {
                request.settled = true;
                reject(reason);
              },
            };

            fixture.inboxRequests.push(request);

            if (fixture.nextInbox !== null) {
              const next = fixture.nextInbox;
              fixture.nextInbox = null;
              request.resolve(next);
            }

            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      },
      threads: {
        update,
        experimental_reorderShelved: async (input) => {
          fixture.shelfMoves.push(input);
          fixture.patch(input.threadId, { experimental_shelfSortKey: "a0" });
        },
        experimental_listPluginMetadata: async ({ threadIds }) => ({
          threads: threadIds
            .filter((threadId) => fixture.tagged.includes(threadId))
            .map((threadId) => ({
              threadId,
              metadata: {
                tag: { v: 1, tagId: fixture.tags[0].id, source: "user", updatedAt: 1 },
              },
            })),
        }),
      },
      plugins: {
        callRpc: async ({ pluginId, method }) => {
          if (pluginId === "leftover-processes" && method === "usage") {
            fixture.usageCalls += 1;

            if (fixture.usageFailed) throw new Error("Usage unavailable");

            return fixture.usage;
          }

          return pluginId === "glance" ? { cards: [] } : { threadIds: [], revision: 1 };
        },
      },
      subscribe: () => () => {},
    };

    const marks = new Map();

    const groupActions = {
      group: async (threadIds) => {
        fixture.groupCalls.push(["group", [...threadIds]]);
        fixture.setHostSelection([]);

        return null;
      },
      rename: async (groupId, name) => {
        fixture.groupCalls.push(["rename", groupId, name]);
        fixture.setGroups(
          state.experimental_groups.map((group) =>
            group.id === groupId ? { ...group, name } : group,
          ),
        );
      },
      ungroup: async (groupId) => {
        fixture.groupCalls.push(["ungroup", groupId]);
        state = {
          ...state,
          experimental_groups: state.experimental_groups.filter((group) => group.id !== groupId),
          threads: state.threads.map((thread) =>
            thread.experimental_groupId === groupId
              ? { ...thread, experimental_groupId: null }
              : thread,
          ),
        };
        emitThreads();
      },
      move: async (threadId, groupId) => {
        fixture.groupCalls.push(["move", threadId, groupId]);
      },
    };

    const rpc = {
      call: async (method, input) => {
        if (method === "tags.list") return { tags: fixture.tags };

        if (method === "diagnostics.record") {
          fixture.diagnostics.push(structuredClone(input.trace));

          return { stored: true };
        }

        return null;
      },
    };

    const inboxListeners = new Set();
    let inboxStarted = false;
    let inboxFetching = false;
    let inboxDirtyTimer = null;
    let inboxRefetchAfterFetch = false;

    const publishInbox = (patch) => {
      inboxView = { ...inboxView, ...patch };

      for (const listener of inboxListeners) listener();
    };

    const fetchInbox = () => {
      inboxFetching = true;
      sdk.experimental_inbox.snapshot({ signal: new AbortController().signal }).then(
        (snapshot) => {
          inboxFetching = false;
          publishInbox({ snapshot, status: "ready", stale: false });
          finishInboxFetch();
        },
        () => {
          inboxFetching = false;
          publishInbox({ status: "error", stale: inboxView.snapshot !== null });
          finishInboxFetch();
        },
      );
    };

    const markInboxDirty = () => {
      if (inboxDirtyTimer !== null || inboxRefetchAfterFetch) return;
      inboxDirtyTimer = setTimeout(() => {
        inboxDirtyTimer = null;

        if (inboxFetching) {
          inboxRefetchAfterFetch = true;

          return;
        }

        fetchInbox();
      }, 250);
    };

    const finishInboxFetch = () => {
      if (!inboxRefetchAfterFetch) return;
      inboxRefetchAfterFetch = false;
      markInboxDirty();
    };

    let inboxView = {
      snapshot: null,
      status: "loading",
      stale: false,
      refresh: markInboxDirty,
    };

    const fakeSdk = {
      ...runtime.pluginSdkApp,
      experimental_useInboxSnapshot: () => {
        const view = react.useSyncExternalStore(
          (listener) => {
            inboxListeners.add(listener);

            return () => inboxListeners.delete(listener);
          },
          () => inboxView,
        );

        react.useEffect(() => {
          if (inboxStarted) return;
          inboxStarted = true;
          fetchInbox();
        }, []);

        return view;
      },
      experimental_useProjectSidebarItems: () => [],
      definePluginApp: (setup) => setup,
      experimental_threadIndicators: {
        strongest: (values) => values.find((value) => value !== null) ?? null,
      },
      useSdk: () => sdk,
      experimental_useAppNavigate: () => ({
        toThread: (id) => {
          fixture.active = id;
          fixture.render();
        },
        toProject: () => {},
      }),
      useRpc: () => rpc,
      useRealtime: () => {},
      experimental_useSidebarThreads: () =>
        react.useSyncExternalStore(
          (listener) => {
            listeners.add(listener);

            return () => listeners.delete(listener);
          },
          () => state,
        ),
      experimental_useChatSelection: () =>
        react.useSyncExternalStore(
          (listener) => {
            selectionListeners.add(listener);

            return () => selectionListeners.delete(listener);
          },
          () => fixture.hostSelection,
        ),
      experimental_setChatSelection: (threadIds) => {
        fixture.selectionWrites.push([...threadIds]);
        fixture.setHostSelection([...threadIds]);
      },
      experimental_useThreadGroupActions: () => groupActions,
      useSidebarThreadRowStatus: () => null,
      useSidebarThreadRowStatuses: () => marks,
      useSidebarThreadDraft: (threadId) => ({ hasUnsubmittedDraft: threadId === "pinned" }),
      useSidebarThreadShortcut: () => null,
      experimental_useSidebarThreadSplit: () => ({ splitProps: {} }),
      experimental_useThreadActions: () => [],
      experimental_ThreadActionsContextMenu: ({ children }) => children,
      experimental_ThreadActionsMenu: ({ trigger }) => {
        const [open, setOpen] = react.useState(false);

        return trigger({
          "aria-haspopup": "menu",
          "aria-expanded": open,
          "data-state": open ? "open" : "closed",
          onClick: () => setOpen((value) => !value),
        });
      },
    };

    globalThis.__omnyoPluginRuntime = { ...runtime, pluginSdkApp: fakeSdk };
    let plugin;

    try {
      plugin = await import("/__chat-topics-row-fixture.js");
    } finally {
      globalThis.__omnyoPluginRuntime = runtime;
    }

    let List;
    let Footer;
    let TaskFooter;
    plugin.default({
      composer: { customize: () => {} },
      slots: {
        settingsSection: () => {},
        experimental_threadList: ({ component }) => {
          List = component;
        },
        experimental_sidebarFooterCard: ({ id, component }) => {
          if (id === "live") Footer = component;

          if (id === "tag-filter") TaskFooter = component;
        },
      },
    });
    const host = document.createElement("main");
    host.dataset.omnyoPlugin = "chat-topics";
    host.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:#17191e;color:#f2f2f7;display:flex;width:420px;height:740px;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;--background:#17191e;--sidebar:#17191e;--foreground:#f2f2f7;--muted-foreground:#8e8e93;--success:#34c759;--attention:#ff9f0a;--destructive:#ff453a;--accent:#2c2c2e;--accent-foreground:#f2f2f7;--muted:#25262b;--border:#34353c;--ring:#0a84ff;--popover:#26272c;";

    let footerCenter = null;

    if (capsuleOnly) {
      host.style.zIndex = "auto";
      host.style.bottom = "30px";
      host.style.height = "auto";
      const footer = document.createElement("footer");
      footer.dataset.fixtureAppFooter = "";
      footer.style.cssText =
        "position:fixed;inset:auto 0 0 0;height:30px;display:flex;align-items:center;justify-content:center;background:#17191e;color:#f2f2f7;font:12px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;--background:#17191e;--foreground:#f2f2f7;--attention:#ff9f0a;--success:#34c759;";
      footerCenter = document.createElement("div");
      footerCenter.dataset.omnyoPluginRoot = "";
      footerCenter.dataset.omnyoPlugin = "chat-topics";
      footerCenter.style.display = "contents";
      footer.append(footerCenter);
      document.body.append(footer);
    }

    const mount = document.createElement("div");
    mount.style.cssText = "width:360px;height:700px;display:block;";
    const outside = document.createElement("button");
    outside.id = "row-fixture-outside";
    outside.textContent = "Outside";
    host.append(mount, outside);
    document.body.append(host);
    const root = runtime.reactDomClient.createRoot(mount);
    let taskFooterTarget = null;
    fixture.showList = true;
    fixture.mountTaskFooter = () => {
      taskFooterTarget = document.createElement("footer");
      taskFooterTarget.dataset.footerRegion = "sidebar";
      document.body.append(taskFooterTarget);
      fixture.render();
    };

    fixture.unmount = () => root.render(null);
    fixture.render = () =>
      root.render(
        react.createElement(
          react.Fragment,
          null,
          footerCenter === null
            ? null
            : runtime.reactDom.createPortal(
                react.createElement(Footer, { experimental_placement: "footer" }),
                footerCenter,
              ),
          taskFooterTarget === null
            ? null
            : runtime.reactDom.createPortal(
                react.createElement(TaskFooter, { experimental_placement: "footer" }),
                taskFooterTarget,
              ),
          fixture.showList
            ? react.createElement(List, {
                activeThreadId: fixture.active,
                activeProjectId: base.projectId,
                experimental_scope: fixture.scope,
                isCompactViewport: fixture.compact,
                searchQuery: "",
                onNavigate: () => {},
              })
            : null,
          capsuleOnly ? react.createElement(Footer, { experimental_placement: "sidebar" }) : null,
        ),
      );
    fixture.close = () => {
      root.unmount();
      host.remove();
      taskFooterTarget?.remove();
    };

    fixture.render();
    globalThis.__rowInteractions = fixture;
  }, capsuleOnly);

  if (taskManagerOnly) {
    const toggle = page.getByRole("switch", { name: "Task Manager" });
    await toggle.waitFor();
    const sidebar = page.locator('main[data-omnyo-plugin="chat-topics"]');
    await sidebar.evaluate((element) => {
      element.style.width = "300px";
    });
    const projectTitle = page.locator('[data-sidebar-thread-id="active"] .ct-row-title');

    const titleWidth = await projectTitle.evaluate(
      (element) => element.getBoundingClientRect().width,
    );

    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.locator("[data-thread-usage]").count(), 0);
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.usageCalls), 0);
    assert.equal(await page.getByRole("group", { name: "Filter by tag" }).count(), 0);
    const popup = page.getByRole("dialog", { name: "Task Manager overview" });
    const beforeHover = await projectTitle.boundingBox();
    await toggle.hover();
    await popup.waitFor();
    const search = popup.getByRole("searchbox", { name: "Find chats or processes" });
    const compile = popup.locator(".ct-task-process").filter({ hasText: "compile-fixture" });
    await popup.locator("summary").first().waitFor();
    assert.equal(await compile.isVisible(), false);
    await search.fill("104");
    await compile.waitFor();
    assert.equal(await popup.locator("summary").count(), 1);
    await search.fill("no-such-task");
    await popup.getByText("No matching chats or processes.").waitFor();
    await search.fill("");
    const chat = popup.locator("details").filter({ hasText: "compile-fixture" });
    await chat.locator("summary").press("Enter");
    assert.ok(await compile.isVisible());
    assert.deepEqual(await projectTitle.boundingBox(), beforeHover);
    const sidebarPreference = popup.getByRole("checkbox", { name: "Show usage in sidebar" });
    await sidebarPreference.check();
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    await sidebarPreference.uncheck();
    assert.equal(
      await popup.locator(".ct-task-process").filter({ hasText: "watch-fixture" }).count(),
      1,
    );
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    assert.equal(await page.locator("[data-thread-usage]").count(), 0);
    await popup.hover();
    assert.equal(await popup.isVisible(), true);
    const machine = popup.getByRole("combobox", { name: "Machine" });
    await machine.selectOption("second-machine");
    assert.equal(await popup.getByText("7%", { exact: true }).count(), 1);
    assert.equal(await popup.getByText("No chat-owned processes.", { exact: true }).count(), 0);
    assert.equal(
      await popup.locator(".ct-task-process").filter({ hasText: "compile-fixture" }).count(),
      0,
    );
    await machine.selectOption("host");
    await page.evaluate(() => {
      const system = globalThis.__rowInteractions.usage.hosts[0].system;
      system.cpuPercent = 42;
      system.gpuPercent = 28;
      system.memoryUsedBytes += 1073741824;
    });
    await page.waitForFunction(() => globalThis.__rowInteractions.usageCalls >= 2, null, {
      timeout: 7000,
    });

    assert.equal(await popup.locator("svg.ct-task-sparkline polyline").count(), 3);

    if (process.env.OMNYO_TEST_TASK_POPOVER)
      await popup.screenshot({ path: process.env.OMNYO_TEST_TASK_POPOVER });
    const callsBeforeClick = await page.evaluate(() => globalThis.__rowInteractions.usageCalls);
    await toggle.click();
    assert.deepEqual(
      await toggle.evaluate((element) => {
        const style = getComputedStyle(element);

        return { outline: style.outlineStyle, shadow: style.boxShadow };
      }),
      { outline: "none", shadow: "none" },
      "A pointer click selects Task Manager without drawing a line around the icon",
    );
    const activeUsage = page.locator('[data-thread-usage="active"]');
    await activeUsage.getByText("CPU 12.5%", { exact: true }).waitFor();
    assert.match(await activeUsage.textContent(), /RAM 32 MB/u);
    assert.equal(
      await projectTitle.evaluate((element) => element.getBoundingClientRect().width),
      titleWidth,
    );
    assert.doesNotMatch(await activeUsage.textContent(), /partial/u);
    assert.match(await activeUsage.getAttribute("title"), /Partial host measurement/u);
    assert.match(
      await page.locator('[data-thread-usage="human"]').getAttribute("aria-label"),
      /Usage unavailable/u,
    );
    await page.locator('[data-sidebar-thread-id="pinned"]').waitFor();
    assert.equal(await page.locator('[data-thread-usage="pinned"]').count(), 0);
    assert.equal(
      await page.evaluate(() => globalThis.__rowInteractions.usageCalls),
      callsBeforeClick,
    );
    await machine.focus();
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    assert.ok(await toggle.evaluate((el) => el === document.activeElement));
    assert.equal(await toggle.evaluate((el) => getComputedStyle(el).outlineStyle), "solid");
    assert.equal(
      await page.evaluate(() => localStorage.getItem("chat-topics:task-manager")),
      "true",
    );
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.append(60);
      fixture.compact = true;
      fixture.render();
    });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.ok(
      (await page.locator('[data-kind="chat"]').count()) < 60,
      "Project rows stay virtualized",
    );

    const layout = await page.locator(".ct-shell").evaluate((shell) => {
      const footer = shell.querySelector(".ct-task-footer");
      const list = shell.querySelector(".ct-list");
      const usage = shell.querySelector('[data-thread-usage="active"]');

      const title = usage.closest(".ct-row").querySelector(".ct-row-title").getBoundingClientRect();

      return {
        belowTitle: usage.getBoundingClientRect().top >= title.bottom - 1,
        aligned: Math.abs(usage.getBoundingClientRect().left - title.left) <= 1,
        nested: list.contains(footer),
        listBottom: list.getBoundingClientRect().bottom,
        footerTop: footer.getBoundingClientRect().top,
        usageRight: usage.getBoundingClientRect().right,
        listRight: list.getBoundingClientRect().right,
      };
    });

    assert.ok(layout.belowTitle && layout.aligned);
    assert.equal(layout.nested, false);
    assert.ok(layout.listBottom <= layout.footerTop + 1);
    assert.ok(layout.usageRight <= layout.listRight);
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(fixtureInbox());
    await page.locator('[data-feed-row="active"] [data-thread-usage="active"]').waitFor();

    const inboxGeometry = await page.locator('[data-feed-row="active"]').evaluate((row) => {
      const title = row.querySelector(".ctf-title").getBoundingClientRect();
      const usage = row.querySelector("[data-thread-usage] > span").getBoundingClientRect();

      return { below: usage.top >= title.bottom, aligned: Math.abs(usage.left - title.left) < 2 };
    });

    assert.ok(inboxGeometry.below && inboxGeometry.aligned);

    if (process.env.OMNYO_TEST_SCREENSHOT)
      await sidebar.screenshot({ path: process.env.OMNYO_TEST_SCREENSHOT });

    await page.evaluate(() => {
      globalThis.__rowInteractions.usage.hosts[0].threads = [];
    });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-thread-usage="active"]')?.getAttribute("data-coverage") ===
        "unknown",
      null,
      { timeout: 7000 },
    );
    assert.equal(await activeUsage.textContent(), "Unavailable");
    await page.evaluate(() => {
      globalThis.__rowInteractions.patch("active", { status: "idle" });
    });
    await page.locator('[data-feed-row="active"]').waitFor();
    await activeUsage.waitFor({ state: "detached" });
    await page.evaluate(() => {
      globalThis.__rowInteractions.patch("active", { status: "active" });
    });
    await activeUsage.getByText("Unavailable", { exact: true }).waitFor();
    await toggle.click();
    assert.equal(await page.locator("[data-thread-usage]").count(), 0);
    await page.keyboard.press("Escape");
    await page.mouse.move(380, 20);
    await popup.waitFor({ state: "hidden" });
    const stoppedAt = await page.evaluate(() => globalThis.__rowInteractions.usageCalls);
    await page.waitForTimeout(5200);
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.usageCalls), stoppedAt);
    await page.evaluate(() => {
      globalThis.__rowInteractions.usageFailed = true;
    });
    await toggle.click();
    await page.waitForFunction(() =>
      document
        .querySelector('[data-thread-usage="active"]')
        ?.getAttribute("aria-label")
        ?.startsWith("Usage unavailable"),
    );
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.usageCalls), stoppedAt + 1);
    await toggle.click();
    assert.equal(
      await page.evaluate(() => localStorage.getItem("chat-topics:task-manager")),
      "false",
    );
    await page.evaluate(() => globalThis.__rowInteractions.mountTaskFooter());
    await page.locator('[data-footer-region="sidebar"] [role="switch"]').waitFor();
    assert.equal(await page.getByRole("switch", { name: "Task Manager" }).count(), 1);
    assert.equal(await page.locator(".ct-task-footer").count(), 0);
    await toggle.dispatchEvent("pointerdown", { pointerType: "touch", pointerId: 1 });
    await popup.waitFor();
    await toggle.dispatchEvent("pointerup", { pointerType: "touch", pointerId: 1 });
    await toggle.dispatchEvent("click");
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 800 });
    await toggle.press("ArrowUp");
    await popup.waitFor();
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.showList = false;
      fixture.render();
    });
    await page.waitForFunction(() => document.querySelector('[role="switch"]') === null);
    checks.push(
      "Hover previews tasks without moving rows, machine selection changes the overview, clicking toggles persisted metrics, idle rows hide missing readings, and polling stops when both views close",
    );
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(JSON.stringify({ status: "passed", checks, productionWrites: 0 }));
    process.exit(0);
  }

  if (shelfOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;

      for (const [id, key] of [
        ["callback", "a1"],
        ["pinned", "a2"],
      ])
        fixture.patch(id, {
          status: "idle",
          runtimeStatus: "idle",
          isPinned: false,
          experimental_shelvedAt: 10,
          experimental_shelfSortKey: key,
        });
    });

    const shelf = page.locator('[data-section="shelf"]');

    if ((await shelf.getAttribute("aria-expanded")) === "false") await shelf.click();
    const rows = page.locator("[data-shelf-row]");
    const order = () => rows.evaluateAll((elements) => elements.map((row) => row.dataset.shelfRow));
    await rows.nth(1).waitFor({ timeout: 3000 });
    assert.deepEqual(await order(), ["callback", "pinned"]);
    const from = await rows.nth(1).boundingBox();
    const to = await rows.nth(0).boundingBox();
    assert.ok(from && to);
    await page.mouse.move(from.x + 45, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + 45, to.y + to.height / 4, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => globalThis.__rowInteractions.shelfMoves.length === 1);
    assert.deepEqual(await page.evaluate(() => globalThis.__rowInteractions.shelfMoves[0]), {
      threadId: "pinned",
      previousThreadId: null,
      nextThreadId: "callback",
    });
    assert.deepEqual(await order(), ["pinned", "callback"]);
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks: ["Dragging a Shelf row sends the expected neighbors and moves it above the target"],
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  if (childFailureOnly) {
    await page.evaluate(
      (failedWork) => {
        const fixture = globalThis.__rowInteractions;
        fixture.patch("callback", { parentThreadId: "active", experimental_work: failedWork });
        fixture.active = "pinned";
        fixture.scope = { kind: "inbox" };
        fixture.render();
      },
      work("failed", {
        failures: [{ code: "run-failed", text: "Child execution failed", sourceId: "callback" }],
      }),
    );
    await supplyInbox(
      inboxSnapshot({
        inbox: [
          inboxEntry("callback", {
            title: "Failed child",
            state: "failed",
            card: { ...inboxEntry("callback").card, kind: "problem" },
          }),
        ],
        running: [inboxEntry("active", { title: "Working parent", view: "running", card: null })],
        waiting: [],
      }),
    );
    await expandRunning();
    const parent = page.locator('[data-feed-row="active"]');
    await parent.waitFor();
    assert.equal(await parent.getAttribute("data-state"), "run");
    assert.equal(await parent.getAttribute("data-inbox-row"), "running");
    assert.equal(await parent.locator('[data-feed-row="callback"]').count(), 0);
    await parent.locator(":scope > .ctf-row-surface > .ctf-row-main .ct-kids").click();
    const child = parent.locator('[data-feed-row="callback"]');
    await child.waitFor();
    assert.equal(await child.getAttribute("data-state"), "failed");
    assert.equal(await parent.locator(":scope > .ctf-row-surface > .ctf-row-detail").count(), 0);
    assert.equal(await page.locator('[data-feed-section="failed"]').count(), 0);
    console.log(
      JSON.stringify({
        status: "passed",
        checks: [
          "The working parent owns the failed child; its failure is visible only inside the expanded branch",
        ],
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    process.exit(0);
  }

  if (inboxFamilyOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.patch("active", { originKind: "handoff", sourceThreadId: "callback" });
      fixture.append(2);
      fixture.patch("extra-0", { parentThreadId: "callback" });
      fixture.patch("extra-1", { parentThreadId: "extra-0" });
      fixture.active = "pinned";
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length > 0);
    await page.evaluate(
      (snapshot) => {
        globalThis.__rowInteractions.inboxRequests.at(-1).resolve(snapshot);
      },
      inboxSnapshot({
        inbox: runningFamily
          ? [
              inboxEntry("active", {
                title: "Mother chat",
                card: {
                  ...inboxEntry("active").card,
                  primary: { kind: "archive" },
                },
              }),
            ]
          : waitingFamily
            ? []
            : [inboxEntry("callback", { title: "Earlier chat" })],
        running: runningFamily
          ? ["callback", "pinned"].map((id) =>
              inboxEntry(id, { title: id, view: "running", card: null }),
            )
          : restingFamily || waitingFamily
            ? []
            : [inboxEntry("active", { title: "Mother chat", view: "running", card: null })],
        waiting: waitingFamily ? [inboxWaiting("callback", { group: "on-you" })] : [],
      }),
    );

    const parent = page.locator('[data-feed-row="active"]');
    await page
      .locator(
        runningFamily
          ? '[data-feed-section="run"]'
          : waitingFamily
            ? '[data-feed-section="waiting"]'
            : restingFamily
              ? '[data-feed-section="finished"]'
              : '[data-feed-section="run"]',
      )
      .waitFor();
    await expandRunning();
    assert.equal(
      await page
        .locator(
          '[data-feed-section] > [data-feed-row="callback"], [data-feed-section] > [data-chat-row-menu] > [data-feed-row="callback"]',
        )
        .count(),
      0,
      "an earlier chat never appears alone in an Inbox section",
    );
    assert.equal(
      await page
        .locator(
          '[data-feed-section] > [data-feed-row="active"], [data-feed-section] > [data-chat-row-menu] > [data-feed-row="active"]',
        )
        .count(),
      1,
      "the mother appears once even when its earlier chat needs attention",
    );
    assert.equal(
      await page.locator('[data-feed-row="callback"]').count(),
      0,
      "the earlier chat starts collapsed",
    );
    await parent.waitFor();

    if (waitingFamily)
      assert.equal(
        await parent.locator(":scope > .ctf-row-surface > .ctf-row-detail .ctf-row-act").count(),
        0,
        "a mother never offers its child’s wait action",
      );
    await parent.locator(":scope > .ctf-row-surface > .ctf-row-main .ct-kids").click();
    const earlier = parent.locator('[data-feed-row="callback"]');
    await earlier.waitFor();
    await earlier.hover();
    assert.equal(
      await parent.evaluate((row) => getComputedStyle(row).backgroundColor),
      "rgba(0, 0, 0, 0)",
      "hovering a subchat never highlights the entire parent branch",
    );
    assert.equal(
      await earlier.getByRole("img", { name: "Earlier chat" }).textContent(),
      "Earlier chat",
    );
    assert.equal(
      await parent.getAttribute("data-state"),
      runningFamily ? "done" : "run",
      "the continuation keeps its own status",
    );

    if (!runningFamily && !restingFamily && !waitingFamily) {
      assert.equal(await parent.getAttribute("data-inbox-row"), "running");
      assert.equal(await earlier.getAttribute("data-state"), "done");
    }

    assert.equal(
      await page
        .locator(
          '[data-feed-section] > [data-feed-row="callback"], [data-feed-section] > [data-chat-row-menu] > [data-feed-row="callback"]',
        )
        .count(),
      0,
      "expanding the mother never adds a separate child row to another section",
    );
    assert.equal(await page.locator('[data-feed-row="callback"]').count(), 1);
    await earlier.locator(":scope > .ctf-row-surface > .ctf-row-main .ct-kids").click();
    await parent.locator('[data-sidebar-thread-id="extra-0"]').waitFor();

    const nested = parent
      .locator(".ctf-kid-row")
      .filter({ has: page.locator('[data-sidebar-thread-id="extra-0"]') })
      .first();

    await nested.locator(":scope > .ct-rail .ct-kids").click();
    await parent.locator('[data-sidebar-thread-id="extra-1"]').waitFor();
    const rowTitles = parent.locator(".ctf-title, .ctf-kid-title");
    assert.ok((await rowTitles.count()) > 2);
    assert.ok(
      await rowTitles.evaluateAll((titles) =>
        titles.every((title) => getComputedStyle(title.closest("a")).userSelect === "none"),
      ),
      "Inbox parents and subchats suppress text selection on navigation targets",
    );
    checks.push(
      "Inbox nests earlier chats and multiple child generations under one expandable mother",
    );

    await parent
      .locator(':scope > .ctf-row-surface > .ctf-row-main [data-sidebar-thread-id="active"]')
      .click();
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.active), "active");
    const ownSurface = parent.locator(":scope > .ctf-row-surface");
    const activeSurface = await ownSurface.boundingBox();
    const childBounds = await earlier.boundingBox();
    assert.ok(activeSurface && childBounds);
    assert.ok(
      activeSurface.y + activeSurface.height <= childBounds.y,
      "the active parent surface ends before its expanded subchat",
    );
    assert.notEqual(
      await ownSurface.evaluate((row) => getComputedStyle(row).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    checks.push(
      "The active highlight ends above the subchats and child hover leaves the parent clear",
    );
    await earlier
      .locator(':scope > .ctf-row-surface > .ctf-row-main [data-sidebar-thread-id="callback"]')
      .click();

    if (!runningFamily && !waitingFamily) {
      await earlier
        .locator(':scope > .ctf-row-surface > .ctf-row-main [data-sidebar-thread-id="callback"]')
        .press("Enter");
      await page.waitForFunction(() => globalThis.__rowInteractions.inboxActions.length > 0);
      assert.equal(
        await page.evaluate(() => globalThis.__rowInteractions.inboxActions.at(-1).threadId),
        "callback",
        "a nested card keeps its original server action target",
      );
      checks.push(
        "Mother and child navigation stay separate; nested Inbox actions target the child",
      );
    }

    if (waitingFamily) {
      await page.evaluate(() => {
        const fixture = globalThis.__rowInteractions;
        fixture.active = "active";
        fixture.render();
      });
      await earlier
        .locator(":scope > .ctf-row-surface > .ctf-row-detail .ctf-row-detail-text")
        .click();
      await page.waitForFunction(() => globalThis.__rowInteractions.active === "callback");
      checks.push("The line under a title opens that chat, not its mother");

      await page.evaluate(() => {
        const fixture = globalThis.__rowInteractions;
        fixture.active = "active";
        fixture.render();
      });
      await earlier.locator(":scope > .ctf-row-surface > .ctf-row-detail .ctf-row-act").click();
      assert.equal(
        await page.evaluate(() => globalThis.__rowInteractions.active),
        "active",
        "a button on the line keeps its own action instead of opening the chat",
      );
      await page.waitForFunction(() => globalThis.__rowInteractions.inboxActions.length > 0);
      assert.equal(
        await page.evaluate(() => globalThis.__rowInteractions.inboxActions.at(-1).threadId),
        "callback",
        "a nested wait action keeps the child’s server target",
      );
      checks.push("Wait actions appear on the child and target its exact wait");
    }

    await page.evaluate(() => globalThis.__rowInteractions.close());
    console.log(
      JSON.stringify({
        status: "passed",
        checks,
        executedChecks: checks.length,
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );

    if (browserServer !== null) await browserServer.kill();
    else await browser.close();
    process.exit(0);
  }

  if (inboxLoadingOnly) {
    await page.evaluate(() => {
      globalThis.__rowInteractions.scope = { kind: "inbox" };
      globalThis.__rowInteractions.render();
    });
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length === 1);
    await page.clock.install();

    for (let index = 0; index < 3; index += 1) {
      await page.evaluate((index) => {
        globalThis.__rowInteractions.patch("active", { title: `Streaming ${index}` });
      }, index);
      await page.clock.runFor(300);
    }

    assert.deepEqual(
      await page.evaluate(() => ({
        requests: globalThis.__rowInteractions.inboxRequests.length,
        aborted: globalThis.__rowInteractions.inboxRequests[0].signal?.aborted ?? false,
      })),
      { requests: 1, aborted: false },
      "chat updates must not cancel or duplicate the initial Inbox request",
    );

    const snapshot = inboxSnapshot({
      inbox: [inboxEntry("active", { title: "Loaded Inbox chat" })],
    });

    await page.evaluate((snapshot) => {
      globalThis.__rowInteractions.inboxRequests[0].resolve(snapshot);
    }, snapshot);
    await page.getByText("Loaded Inbox chat", { exact: true }).waitFor();
    await page.clock.runFor(300);
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length === 2);
    await page.evaluate((snapshot) => {
      globalThis.__rowInteractions.inboxRequests[1].resolve(snapshot);
      globalThis.__rowInteractions.scope = { kind: "project", projectId: "row-fixture-project" };
      globalThis.__rowInteractions.render();
    }, snapshot);
    await page.clock.runFor(300);
    await page.evaluate(() => {
      globalThis.__rowInteractions.patch("active", { title: "Project update" });
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length === 3);
    await page.evaluate(() => {
      globalThis.__rowInteractions.scope = { kind: "inbox" };
      globalThis.__rowInteractions.render();
    });
    await page.clock.runFor(32);
    assert.equal(await page.getByRole("status", { name: "Loading the Inbox" }).count(), 0);
    assert.equal(await page.getByText("Loaded Inbox chat", { exact: true }).count(), 1);
    await page.evaluate(() => {
      globalThis.__rowInteractions.inboxRequests[2].reject(new Error("Snapshot unavailable"));
    });
    await page.clock.runFor(32);
    assert.equal(await page.getByText("Loaded Inbox chat", { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByText("Couldn’t refresh the Inbox. It shows the last update.", { exact: true })
        .count(),
      1,
    );
    await page.evaluate(() => {
      globalThis.__rowInteractions.patch("active", { title: "Another update" });
    });
    await page.clock.runFor(300);
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length === 4);
    await page.clock.runFor(1100);
    await page.locator('[data-inbox] [data-sidebar-thread-id="active"]').press("j");
    await page.locator('[data-inbox] [data-sidebar-thread-id="active"]').press("Enter");
    await page.clock.runFor(450);
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.inboxActions.length), 1);
    assert.equal(await page.getByText("Loaded Inbox chat", { exact: true }).count(), 0);
    await page.evaluate((snapshot) => {
      globalThis.__rowInteractions.inboxRequests[3].resolve(snapshot);
    }, snapshot);
    await page.clock.runFor(32);
    assert.equal(await page.getByText("Loaded Inbox chat", { exact: true }).count(), 0);
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks: [
          "streaming cannot starve Inbox loading",
          "project view prefetches Inbox updates",
          "reopening renders the retained snapshot immediately",
          "refresh failure retains Inbox contents",
          "an older snapshot cannot restore a handled card",
        ],
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  const row = (id) => page.locator(`[data-sidebar-thread-id="${id}"]`).locator("xpath=..");
  const input = page.getByRole("textbox", { name: "Chat title" });
  const requestCount = () => page.evaluate(() => globalThis.__rowInteractions.requests.length);

  const frame = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );

  const edit = async () => {
    await row("active").locator(".ct-row-title").dblclick();
    await input.waitFor();
  };

  await page.locator(".ct-list").waitFor({ state: "visible" });

  if (groupsOnly) {
    const folder = page.locator('.ct-group[data-chat-group="g-release"]');
    const folderButton = folder.locator(".ct-group-button");
    const fixtureState = (read) => page.evaluate(read);

    const listOrder = () =>
      page
        .locator(".ct-item")
        .evaluateAll((items) =>
          items
            .sort((a, b) => Number(a.dataset.index) - Number(b.dataset.index))
            .map((item) =>
              item.dataset.kind === "section"
                ? `section:${item.querySelector(".ct-section-name")?.textContent}`
                : item.dataset.kind === "group"
                  ? `group:${item.querySelector(".ct-group-name, input")?.textContent ?? ""}`
                  : item.dataset.kind === "chat"
                    ? `${item.querySelector(".ct-row")?.dataset.chatGroup ? "  " : ""}${item.querySelector("[data-sidebar-thread-id]")?.dataset.sidebarThreadId}`
                    : item.dataset.kind,
            ),
        );

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.setGroups([
        {
          id: "g-release",
          projectId: "row-fixture-project",
          name: "Release",
          createdAt: 1,
          updatedAt: 1,
        },
        { id: "g-foreign", projectId: "elsewhere", name: "Foreign", createdAt: 1, updatedAt: 1 },
      ]);

      for (const id of ["active", "callback", "human", "pinned"])
        fixture.patch(id, { experimental_groupId: "g-release" });
      fixture.patch("error", { experimental_groupId: "g-foreign" });
    });
    await folder.waitFor();

    assert.deepEqual(await listOrder(), [
      "section:Needs you",
      "group:Release",
      "  human",
      "  active",
      "  callback",
      "section:Pinned",
      "pinned",
      "section:Blocked",
      "error",
    ]);
    assert.equal(await folder.locator("[data-chat-selection-id]").count(), 0);
    assert.equal(await folderButton.getAttribute("aria-label"), "Release, 3 chats");
    assert.equal(
      await page.locator('.ct-row[data-chat-group="g-release"]').first().getAttribute("data-depth"),
      "1",
    );
    checks.push(
      "a group renders once in its most urgent member's section with members nested, pinned outside and foreign groups ignored",
    );

    await folderButton.click();
    assert.equal(await folderButton.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator('.ct-row[data-chat-group="g-release"]').count(), 0);
    assert.equal(await folder.locator('.ct-dot[data-dot="need"]').count(), 1);
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("chat-topics:folds"))["group:g-release"],
      ),
      true,
    );
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.unmount();
      fixture.render();
    });
    await folder.waitFor();
    assert.equal(await folderButton.getAttribute("aria-expanded"), "false");
    await folderButton.click();
    assert.equal(await folderButton.getAttribute("aria-expanded"), "true");
    checks.push("a collapsed group shows its most urgent dot and stays collapsed after a remount");

    const nameInput = page.getByRole("textbox", { name: "Group name" });
    await folder.locator(".ct-group-name").dblclick();
    await nameInput.waitFor();
    await nameInput.fill("Ignored");
    await nameInput.press("Escape");
    assert.equal(await nameInput.count(), 0);
    await folder.locator(".ct-group-name").dblclick();
    await nameInput.fill("Shipping");
    await nameInput.press("Enter");
    await folder.locator(".ct-group-name", { hasText: "Shipping" }).waitFor();
    await folder.click({ button: "right" });
    await page.locator('[data-group-action="rename"]').click();
    await nameInput.waitFor();
    await nameInput.press("Escape");
    assert.equal(await folderButton.getAttribute("aria-expanded"), "true");
    checks.push("double-click and the menu rename a group inline; Escape cancels");

    const link = (id) => page.locator(`a[data-sidebar-thread-id="${id}"]`);
    await link("callback").click({ modifiers: ["Meta"] });
    await link("human").click({ modifiers: ["Meta"] });
    assert.deepEqual(
      await fixtureState(() => globalThis.__rowInteractions.selectionWrites.at(-1)),
      ["human", "active", "callback"],
    );
    const writes = await fixtureState(() => globalThis.__rowInteractions.selectionWrites.length);
    await page.evaluate(() => globalThis.__rowInteractions.setHostSelection([]));
    await page.locator("[data-chat-selected]").first().waitFor({ state: "detached" });
    assert.equal(
      await fixtureState(() => globalThis.__rowInteractions.selectionWrites.length),
      writes,
      "adopting Omnyo's clear writes nothing back",
    );
    await link("human").focus();
    await link("human").press("Meta+a");
    assert.deepEqual(
      await fixtureState(() => globalThis.__rowInteractions.selectionWrites.at(-1)),
      ["human", "active", "callback", "pinned", "error"],
    );
    await page.evaluate(() => globalThis.__rowInteractions.unmount());
    await page.waitForFunction(
      () => globalThis.__rowInteractions.selectionWrites.at(-1)?.length === 0,
    );
    await page.evaluate(() => globalThis.__rowInteractions.render());
    await folder.waitFor();
    checks.push(
      "the selection reaches Omnyo in display order, skips group rows, adopts Omnyo's clear and empties on unmount",
    );

    await folder.click({ button: "right" });
    await page.locator('[data-group-action="ungroup"]').click();
    await folder.waitFor({ state: "detached" });
    assert.deepEqual(await fixtureState(() => globalThis.__rowInteractions.groupCalls), [
      ["rename", "g-release", "Shipping"],
      ["ungroup", "g-release"],
    ]);
    assert.deepEqual((await listOrder()).slice(0, 4), [
      "section:Needs you",
      "human",
      "section:Running",
      "active",
    ]);
    checks.push("Ungroup asks Omnyo to remove the group and its chats return to their sections");

    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks,
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  if (projectAttentionOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = null;
      fixture.render();
    });
    const project = page.locator('[data-project-id="row-fixture-project"]');
    const toggle = project.locator(".ct-project-button");
    await toggle.waitFor();
    assert.equal(await project.locator(".ct-count").textContent(), "5 chats");
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    const blocked = project.getByRole("button", { name: "Show 1 blocked chats" });
    await blocked.focus();
    await blocked.press("Enter");
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await row("error").waitFor({ state: "visible" });

    if (process.env.OMNYO_TEST_SCREENSHOT)
      await page.screenshot({ path: process.env.OMNYO_TEST_SCREENSHOT });
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks: [
          "Project attention badge names its count and reveals the represented blocked chat with keyboard input",
          "Project total labels top-level chats",
        ],
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  if (!headerOnly) {
    const working = page.locator('.ct-section[data-section="run"][aria-expanded="false"]');

    if (await working.count()) await working.click();
  }

  if (!headerOnly) await row("active").waitFor({ state: "visible" });

  if (descriptionAlignmentOnly) {
    await page.evaluate(() => {
      globalThis.__rowInteractions.scope = { kind: "inbox" };
      globalThis.__rowInteractions.render();
    });
    await supplyInbox(fixtureInbox());

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await frame();

      const offsets = await page.locator(".ctf-row:has(.ctf-row-detail-text)").evaluateAll((rows) =>
        rows.map((row) => {
          const title = row.querySelector(".ctf-title").getBoundingClientRect();
          const detail = row.querySelector(".ctf-row-detail-text").getBoundingClientRect();

          return Math.abs(title.left - detail.left);
        }),
      );

      assert.ok(offsets.length > 0, "The fixture must render Inbox descriptions");
      assert.ok(
        offsets.every((offset) => offset < 1),
        `${width}px Inbox descriptions align with titles: ${offsets.join(", ")}`,
      );
    }

    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks: ["Inbox descriptions align with titles at desktop and 390px"],
        productionWrites: 0,
      }),
    );
    process.exit(0);
  }

  if (summariesOnly) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await frame();
      const open = row("pinned");
      assert.equal(await open.locator(".ct-row-title").textContent(), "Pinned chat");
      assert.equal(await open.locator(".ct-row-summary").textContent(), "Existing draft subtitle");
      assert.equal(
        await row("active").locator(".ct-row-summary").count(),
        0,
        "a running chat shows only its title",
      );

      const geometry = await open.evaluate((element) => {
        const title = element.querySelector(".ct-row-title").getBoundingClientRect();
        const summary = element.querySelector(".ct-row-summary").getBoundingClientRect();

        return {
          below: summary.top >= title.bottom,
          contained: summary.right <= element.getBoundingClientRect().right,
        };
      });

      assert.deepEqual(geometry, { below: true, contained: true });
      assert.equal(
        await page.locator(".ct-sticky .ct-row-summary, .ctf-kid .ct-row-summary").count(),
        0,
      );
    }

    await page.setViewportSize({ width: 1280, height: 800 });
    await frame();

    const summaryMask = () =>
      row("pinned")
        .locator(".ct-row-summary")
        .evaluate((element) => getComputedStyle(element).maskImage);

    const restingMask = await summaryMask();
    await row("pinned").hover();
    await frame();
    const hoverMask = await summaryMask();
    assert.notEqual(hoverMask, restingMask, "hover fades the summary under the time and menu");
    assert.match(hoverMask, /linear-gradient/u);
    await page.mouse.move(0, 0);

    await page.evaluate(() =>
      globalThis.__rowInteractions.patch("pinned", {
        status: "idle",
        runtimeStatus: "idle",
        isPinned: false,
        experimental_shelvedAt: 10,
        experimental_shelfSortKey: "a1",
      }),
    );
    const shelf = page.locator('[data-section="shelf"]');

    if ((await shelf.getAttribute("aria-expanded")) === "false") await shelf.click();
    const shelved = page.locator('[data-shelf-row="pinned"]');
    await shelved.waitFor({ timeout: 3000 });
    assert.equal(await shelved.locator(".ct-row-title").textContent(), "Pinned chat");
    assert.equal(
      await shelved.locator(".ct-row-summary").count(),
      0,
      "Shelf rows show only titles",
    );
    await page.evaluate(() =>
      globalThis.__rowInteractions.patch("pinned", {
        isPinned: true,
        experimental_shelvedAt: null,
        experimental_shelfSortKey: null,
      }),
    );
    await row("pinned").waitFor({ timeout: 3000 });

    await page.evaluate(() =>
      globalThis.__rowInteractions.patch("pinned", {
        experimental_subtitle: "Pinned chat",
        experimental_work: null,
      }),
    );
    await frame();
    assert.equal(await row("pinned").locator(".ct-row-summary").count(), 0);
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks: [
          "desktop and narrow sidebar show title and current summary on separate lines",
          "a running chat shows only its title",
          "hover fades the summary under the time and menu",
          "Shelf rows show only titles",
          "repeated title is omitted",
          "compact rows do not inherit summary markup",
        ],
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  if (waitingOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(
      fixtureInbox({
        waiting: [
          inboxWaiting("callback", { group: "comes-back" }),
          inboxWaiting("pinned", { group: "on-you", waitId: "wait-2" }),
        ],
        inbox: [needsYou("human", "Needs input"), inboxEntry("error", { title: "Failed chat" })],
      }),
    );
    const waiting = page.locator('[data-feed-section="waiting"]');
    const toggle = waiting.getByRole("button", { name: /Waiting/ });
    assert.deepEqual(
      await page
        .locator("[data-feed-section]")
        .evaluateAll((items) => items.map((item) => item.dataset.feedSection)),
      ["inbox", "finished", "run", "waiting"],
      "Sections with chats show in order and the empty Ready to archive and Shelf stay out",
    );
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    await waiting.locator('[data-feed-row="callback"]').waitFor();
    await toggle.click();
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(await waiting.locator('[data-feed-row="callback"]').count(), 0);
    assert.equal(
      await waiting.locator('[data-feed-row="pinned"]').count(),
      0,
      "folding Waiting hides every waiting chat, including those waiting on the owner",
    );
    assert.match(
      (await toggle.getAttribute("aria-label")) ?? "",
      /^Waiting, 2 chats$/u,
      "a folded Waiting heading still counts every waiting chat",
    );
    await toggle.click();
    await waiting.locator('[data-feed-row="pinned"]').waitFor();
    await waiting.locator('[data-feed-row="callback"]').waitFor();

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;

      for (const id of ["human", "error"]) fixture.patch(id, { isArchived: true });
    });
    await supplyInbox(fixtureInbox({ inbox: [], running: [] }));
    await page.locator('[data-feed-section="inbox"]').waitFor({ state: "detached" });
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");

    await page.evaluate(() => {
      globalThis.__rowInteractions.patch("callback", {
        hasPendingInteraction: true,
        indicator: "waiting-for-input",
      });
    });
    await supplyInbox(
      fixtureInbox({ inbox: [needsYou("callback", "Callback chat")], running: [], waiting: [] }),
    );
    await page
      .locator('[data-feed-section="inbox"] [data-feed-row="callback"]')
      .waitFor({ timeout: 5000 });
    assert.equal(await waiting.locator("[data-feed-row]").count(), 0);
    checks.push(
      "Waiting sits above Shelf, folds whole on demand while its heading keeps the count, permits inbox zero, and moves a chat that needs input to Needs you",
    );

    if (process.env.OMNYO_TEST_SCREENSHOT)
      await page.screenshot({ path: process.env.OMNYO_TEST_SCREENSHOT });
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(JSON.stringify({ status: "passed", checks, productionWrites: 0 }));
    process.exit(0);
  }

  if (runningTitleOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(
      fixtureInbox({
        running: [
          inboxEntry("active", {
            title: "Active chat",
            view: "running",
            card: null,
            running: { label: "Running git status", progress: null },
            optionalQuestion: { id: "colour", label: "Pick a colour", threadId: "active" },
            pendingResults: 1,
          }),
        ],
        waiting: [
          {
            ...inboxWaiting("callback", { group: "comes-back", reason: "Deploy result" }),
            pendingResults: 1,
          },
        ],
      }),
    );
    await expandRunning();
    const running = page.locator('[data-feed-section="run"] [data-feed-row="active"]');
    await running.waitFor();
    assert.equal(await running.locator(".ctf-title").textContent(), "Active chat");
    assert.deepEqual(
      await running.locator(":scope > .ctf-row-surface > .ctf-row-detail").allTextContents(),
      [],
      "a running chat shows only its title, without its activity, optional question or pending results",
    );
    const waiting = page.locator('[data-feed-row="callback"]');
    assert.match(
      (await waiting.locator(":scope > .ctf-row-surface > .ctf-row-detail").allTextContents()).join(
        " | ",
      ),
      /Deploy result/u,
      "a waiting chat keeps what it waits for",
    );
    assert.equal(
      await waiting
        .locator(":scope > .ctf-row-surface > .ctf-row-main .ct-meta")
        .getAttribute("aria-label"),
      "1 new reply since you last wrote or acted on this chat",
      "a waiting chat names its new replies in a chip",
    );
    assert.equal(
      await page
        .locator(
          '[data-feed-row="human"] > .ctf-row-surface > .ctf-row-detail[data-inbox-reason="needs-you"]',
        )
        .count(),
      1,
      "a chat that needs you keeps its reason",
    );
    checks.push(
      "Running rows show only the chat title while Waiting and Needs you rows keep their second lines",
    );

    if (process.env.OMNYO_TEST_SCREENSHOT)
      await page.screenshot({ path: process.env.OMNYO_TEST_SCREENSHOT });
    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(
      JSON.stringify({
        status: "passed",
        checks,
        productionWrites: 0,
        bundleSha256: createHash("sha256").update(bundle).digest("hex"),
      }),
    );
    process.exit(0);
  }

  if (hoverStabilityOnly) {
    const geometry = (locator) =>
      locator.evaluate((element) => {
        const box = (selector) => {
          const node = element.querySelector(selector);

          if (node === null) return null;
          const rect = node.getBoundingClientRect();

          const hit = document.elementFromPoint(
            (rect.left + rect.right) / 2,
            (rect.top + rect.bottom) / 2,
          );

          return {
            left: rect.left,
            right: rect.right,
            shown: rect.width > 0 && Number(getComputedStyle(node).opacity) === 1,
            onTop: hit !== null && node.contains(hit),
          };
        };

        return {
          link: box(".ct-row-link, .ctf-row-link, .ctf-kid"),
          title: box(".ct-row-title, .ctf-title, .ctf-kid-title"),
          continuation: box(".ct-continuation"),
          kids: box(".ct-kids"),
          rail: box(":scope > .ct-rail"),
          age: box(".ct-age"),
          menu: box(".cg-row-menu"),
        };
      });

    const apart = (a, b) =>
      a === null || b === null || a.right <= b.left + 0.5 || b.right <= a.left + 0.5;

    const assertStill = async (view, rows) => {
      for (const [id, locator] of rows) {
        await page.mouse.move(700, 760);
        await page.locator("#row-fixture-outside").focus();
        await frame();
        const rest = await geometry(locator);
        assert.equal(rest.age?.shown, false, `${view} ${id}: age stays hidden at rest`);
        assert.equal(rest.menu?.shown, false, `${view} ${id}: actions stay hidden at rest`);

        if (motionEvidence !== null)
          await locator.screenshot({ path: `${motionEvidence}/hover-${view}-${id}-rest.png` });
        await locator.hover({ position: { x: 40, y: 10 } });
        await frame();
        const hot = await geometry(locator);

        if (motionEvidence !== null)
          await locator.screenshot({ path: `${motionEvidence}/hover-${view}-${id}-hover.png` });

        for (const part of ["link", "title", "continuation", "kids", "rail"])
          assert.deepEqual(
            hot[part] === null ? null : { left: hot[part].left, right: hot[part].right },
            rest[part] === null ? null : { left: rest[part].left, right: rest[part].right },
            `${view} ${id}: hover leaves the ${part} in place`,
          );
        assert.equal(hot.age.shown, true, `${view} ${id}: age appears on hover`);
        assert.equal(hot.menu.shown, true, `${view} ${id}: actions appear on hover`);
        assert.equal(hot.menu.onTop, true, `${view} ${id}: actions sit above the row link`);

        if (hot.kids !== null)
          assert.equal(hot.kids.onTop, true, `${view} ${id}: sub-chat toggle stays clickable`);

        for (const part of ["continuation", "kids", "menu"])
          assert.ok(
            apart(hot.age, hot[part]),
            `${view} ${id}: age clears the ${part}: ${JSON.stringify(hot)}`,
          );
        assert.ok(
          apart(hot.continuation, hot.menu),
          `${view} ${id}: actions clear the continuation mark`,
        );
        assert.ok(apart(hot.kids, hot.menu), `${view} ${id}: actions clear the sub-chat toggle`);
        assert.ok(hot.age.left >= hot.link.left, `${view} ${id}: age stays inside its row link`);
      }
    };

    await page.evaluate(async () => {
      const fixture = globalThis.__rowInteractions;
      fixture.patch("active", { originKind: "handoff", sourceThreadId: "callback" });
      fixture.append(2);
      fixture.patch("extra-0", { parentThreadId: "human" });
      fixture.patch("extra-1", { parentThreadId: "extra-0" });
      const title = "Sidebar rows keep every mark still while the actions menu appears";
      fixture.patch("error", { title, displayTitle: title });

      for (const [id, hours] of Object.entries({ active: 3, human: 30, pinned: 0.5, error: 120 }))
        fixture.patch(id, { createdAt: Date.now() - hours * 3_600_000 });
      fixture.unmount();
      await new Promise((done) => setTimeout(done, 50));
      fixture.render();
    });
    await row("human").locator(".ct-kids").waitFor();

    const projectRows = ["active", "human", "pinned", "error"].map((id) => [id, row(id)]);
    await assertStill("projects", projectRows);

    const measured = await Promise.all(projectRows.map(([, locator]) => geometry(locator)));
    assert.ok(
      measured.some((sample) => sample.continuation !== null) &&
        measured.some((sample) => sample.kids !== null) &&
        measured.some((sample) => sample.continuation === null && sample.kids === null),
      `projects fixture covers continuation, sub-chat and plain rows: ${JSON.stringify(measured)}`,
    );
    checks.push("Projects rows keep every mark, toggle and title edge still on hover");

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(
      inboxSnapshot({
        inbox: [needsYou("human", "Mother chat"), inboxEntry("pinned", { title: "Plain chat" })],
        running: [inboxEntry("active", { title: "Continued chat", view: "running", card: null })],
        waiting: [],
      }),
    );
    await expandRunning();
    const mother = page.locator('[data-feed-row="human"]');
    await mother.waitFor();
    await mother.locator(":scope > .ctf-row-surface > .ctf-row-main .ct-kids").click();

    const kid = mother
      .locator(".ctf-kid-row")
      .filter({ has: page.locator('[data-sidebar-thread-id="extra-0"]') })
      .first();

    await kid.waitFor();

    const question = mother.locator(":scope > .ctf-row-surface");
    const questionHeader = question.locator(".ctf-row-main");
    await page.mouse.move(1200, 700);
    const tint = await question.evaluate((row) => getComputedStyle(row).backgroundColor);
    assert.notEqual(tint, "rgba(0, 0, 0, 0)", "the parent keeps its question tint");
    await questionHeader.hover();
    assert.notEqual(await question.evaluate((row) => getComputedStyle(row).backgroundColor), tint);
    await kid.hover();
    assert.equal(
      await question.evaluate((row) => getComputedStyle(row).backgroundColor),
      tint,
      "hovering a child leaves the parent's question tint at rest",
    );
    assert.equal(
      await mother.evaluate((row) => getComputedStyle(row).backgroundColor),
      "rgba(0, 0, 0, 0)",
      "the question tint never fills the parent branch",
    );
    checks.push("An expanded question highlights only its own row when a child is hovered");

    await assertStill("inbox", [
      ["human", questionHeader],
      ["pinned", page.locator('[data-feed-row="pinned"] > .ctf-row-surface > .ctf-row-main')],
      ["active", page.locator('[data-feed-row="active"] > .ctf-row-surface > .ctf-row-main')],
      ["extra-0", kid],
    ]);
    checks.push("Inbox rows and nested sub-chat rows keep their layout still on hover");

    await page.evaluate(() => globalThis.__rowInteractions.close());
    await browser.close();
    console.log(JSON.stringify({ status: "passed", checks, productionWrites: 0 }));
    process.exit(0);
  }

  const leadingDot = (id) => row(id).locator(".ct-row-link > .ct-dot:first-child");

  if (capsuleOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(fixtureInbox());
    await page.locator("[data-feed]").waitFor({ state: "visible" });
    const pill = page.locator('[data-live-capsule][data-placement="footer"] button');
    const panel = page.getByRole("dialog", { name: "Live chats" });
    const panelBox = page.locator(".ctl-panel");
    const pillText = async () => (await pill.innerText()).replace(/\s+/g, " ").trim();

    const panelMotion = () =>
      page.evaluate(() => {
        const element = document.querySelector(".ctl-panel");

        return {
          state: element?.getAttribute("data-state") ?? null,
          transitions: (element?.getAnimations() ?? [])
            .map((animation) => [
              animation.transitionProperty,
              animation.effect.getTiming().duration,
            ])
            .sort(),
        };
      });

    const openByClick = () =>
      pill.evaluate(async (element) => {
        element.click();
        await new Promise((done) => requestAnimationFrame(() => done()));
      });

    const closeByEscape = () =>
      page.evaluate(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await new Promise((done) => requestAnimationFrame(() => done()));
      });

    assert.equal(await pillText(), "2 running 1 needs you");
    await openByClick();
    assert.deepEqual(await panelMotion(), {
      state: "open",
      transitions: [
        ["opacity", 150],
        ["transform", 220],
      ],
    });
    checks.push("footer list rises from the pill with a short spring and a quicker fade");
    await panel.waitFor({ state: "visible" });
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator("[data-live-row]").count(), 2);
    assert.deepEqual(await page.locator("[data-need-row] .ctl-row-title").allInnerTexts(), [
      "Needs input",
    ]);
    checks.push("footer pill opens its chat list while the Inbox is mounted");
    checks.push("footer popup lists the chat that needs you, matching the pill count");
    await page.waitForFunction(
      () => document.querySelector(".ctl-panel")?.getAnimations().length === 0,
    );
    const pillRect = await pill.boundingBox();
    const listRect = await panelBox.boundingBox();
    assert.ok(
      Math.abs(listRect.y + listRect.height + 8 - pillRect.y) < 1,
      "The list sits 8px above the footer pill",
    );
    assert.ok(
      Math.abs(listRect.x + listRect.width / 2 - (pillRect.x + pillRect.width / 2)) < 1,
      "The list is centred on the footer pill",
    );
    checks.push("footer list opens upward, centred on the pill");
    await closeByEscape();
    assert.deepEqual(await panelMotion(), {
      state: "closing",
      transitions: [
        ["opacity", 140],
        ["transform", 140],
      ],
    });
    await panelBox.waitFor({ state: "detached" });
    checks.push("footer list fades and settles down for 140ms, then leaves the page");
    await pill.click();
    await panel.waitFor({ state: "visible" });
    await panel.getByRole("link", { name: /Needs input/ }).click();
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.active), "human");
    await panelBox.waitFor({ state: "detached" });
    checks.push("footer popup needs-you row opens that chat");
    await pill.click();
    await panel.waitFor({ state: "visible" });
    await panel.getByRole("link", { name: "Callback chat" }).click();
    assert.equal(await page.evaluate(() => globalThis.__rowInteractions.active), "callback");
    await panelBox.waitFor({ state: "detached" });
    checks.push("footer popup row opens the selected chat");
    await pill.click();
    await panel.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await panelBox.waitFor({ state: "detached" });
    checks.push("footer popup closes with Escape and can reopen");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openByClick();
    assert.deepEqual(await panelMotion(), { state: "open", transitions: [["opacity", 150]] });
    await page.waitForFunction(
      () => document.querySelector(".ctl-panel")?.getAnimations().length === 0,
    );
    await closeByEscape();
    assert.deepEqual(await panelMotion(), { state: "closing", transitions: [["opacity", 150]] });
    await panelBox.waitFor({ state: "detached" });
    await page.emulateMedia({ reducedMotion: "no-preference" });
    checks.push("reduced motion opens and closes the footer list with a fade only");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator("#row-fixture-outside").hover();
    await page.evaluate(() => globalThis.__rowInteractions.append(60));
    await supplyInbox(
      fixtureInbox({
        inbox: [
          needsYou("human", "Needs input"),
          ...Array.from({ length: 60 }, (_, index) =>
            inboxEntry(`extra-${index}`, { title: `Extra chat ${index}` }),
          ),
        ],
      }),
    );
    await page.waitForFunction(() => {
      const list = document.querySelector(".ct-list");

      return list.scrollHeight > list.clientHeight + 600;
    });

    for (const state of ["collapsed", "expanded"]) {
      await page.locator(".ct-list").hover();
      await page.mouse.wheel(0, 900);
      await page.waitForFunction(() => document.querySelector(".ct-list").scrollTop > 300);
      await page.locator('[data-live-capsule][data-placement="sidebar"] button').click();
      await frame();
      await page.waitForFunction(() => {
        const list = document.querySelector(".ct-list").getBoundingClientRect();
        const heading = document.querySelector("[data-feed-running]").getBoundingClientRect();

        return heading.top >= list.top && heading.bottom <= list.bottom;
      });
      checks.push(`compact capsule reveals Running from a scrolled Inbox when ${state}`);
    }

    assert.equal(await page.locator("[data-feed-running]").getAttribute("aria-expanded"), "true");
    assert.equal(await page.locator('[data-feed-section="inbox"]').isVisible(), true);
    assert.equal(await panel.count(), 0);
    checks.push("compact sidebar capsule expands Running while preserving ordinary Inbox sections");
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "project", projectId: "row-fixture-project" };
      fixture.render();
    });
    await page.locator("[data-feed]").waitFor({ state: "hidden" });
    await pill.click();
    await panel.waitFor({ state: "visible" });
    await pill.click();
    await panelBox.waitFor({ state: "detached" });
    checks.push("footer pill toggles the same list outside the Inbox");

    const setWork = (id, label, text, patch = {}) =>
      page.evaluate(
        ({ id, label, text, patch }) =>
          globalThis.__rowInteractions.patch(id, {
            ...patch,
            experimental_work: {
              primary: { label, reason: { code: "fixture", text } },
              activity: patch.activity ?? [],
              experimental_ownState: patch.experimental_ownState,
              requiredInput: [],
              optionalInput: [],
              failures: [],
              waits: [],
              nextActors: [],
              archive: { eligible: false, recommended: false, reason: "Recorded work" },
              assessment: {
                availability: "available",
                reason: "Recorded assessment",
                sourceSeq: null,
                suggestion: "omitted",
                noSuggestionReason: null,
                waitingOn: null,
              },
            },
          }),
        { id, label, text, patch },
      );

    await setWork("extra-0", "needs-you", "Question for parent", {
      parentThreadId: "pinned",
      isUnread: true,
    });
    assert.equal(await pillText(), "2 running 1 needs you");
    assert.equal(await pill.locator(".ctl-alert").count(), 0);

    await setWork("extra-0", "working", "Child resumed");
    await setWork("pinned", "working", "Child activity in family work", {
      experimental_ownState: {
        primary: { label: "open", reason: { text: "Parent is open" } },
        hasActivity: false,
      },
    });
    assert.equal(await pillText(), "2 running 1 needs you");
    assert.equal(await pill.locator(".ctl-alert").count(), 0);
    checks.push("child questions and work leave Live counts and alerts alone");

    await setWork("human", "needs-you", "Which dock redesign should I build?", {
      activity: [{ id: "turn", label: "The agent is working." }],
    });
    assert.equal(await pillText(), "2 running 1 needs you");
    await pill.click();
    await panel.waitFor({ state: "visible" });
    assert.equal(await page.locator("[data-live-row]").count(), 2);
    assert.equal(await page.locator("[data-need-row]").count(), 1);
    assert.equal(
      await page.locator("[data-need-row] .ctl-row-reason").innerText(),
      "Which dock redesign should I build?",
    );
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    checks.push("an active chat that needs you is listed once, under Needs you");

    await setWork("active", "open", "Recorded work");
    await setWork("callback", "open", "Recorded work");
    assert.equal(await pillText(), "1 needs you");
    assert.deepEqual(
      await pill.evaluate((element) => ({
        animations: element.getAnimations({ subtree: true }).length,
        folds: element.querySelectorAll(".ctl-fold").length,
      })),
      { animations: 0, folds: 1 },
      "The footer pill drops the running count at once, without animating or keeping it",
    );
    checks.push("footer pill shows only the needs-you count when nothing runs");
    await setWork("active", "working", "Thread working");
    await setWork("callback", "working", "Thread working");
    assert.equal(await pillText(), "2 running 1 needs you");
    await page.setViewportSize({ width: 1000, height: 800 });
    assert.match(await pillText(), /^2\s*1$/);
    assert.match(await pill.getAttribute("aria-label"), /^2 chats running\. 1 needs you\./);
    await page.setViewportSize({ width: 1280, height: 800 });
    checks.push("a narrow window keeps the footer pill's counts and drops its words");

    const capsule = page.locator('[data-live-capsule][data-placement="footer"]');
    const alertTitle = capsule.locator(".ctl-alert b");
    const alertLine = capsule.locator(".ctl-alert span");

    const clipped = (locator) =>
      locator.evaluate((element) => element.scrollWidth > element.clientWidth + 0.5);

    const settled = () =>
      page.waitForFunction(() => {
        const element = document.querySelector(
          '[data-live-capsule][data-placement="footer"] button',
        );

        return element.getAnimations().every((animation) => animation.playState !== "running");
      });

    await setWork("active", "open", "The chat has changed since its completion assessment.", {
      displayTitle: "Inbox triage thread states",
      isUnread: true,
    });
    await alertTitle.waitFor();
    await settled();
    assert.equal(await alertTitle.innerText(), "Inbox triage thread states");
    assert.equal(await clipped(alertTitle), false, "A wide window shows the whole alert title");
    assert.equal(await clipped(alertLine), false, "A wide window shows the whole alert reason");
    assert.ok(
      (await pill.evaluate((element) => element.getBoundingClientRect().width)) > 420,
      "The footer alert grows past the old 420px cap when the window has room",
    );
    checks.push("footer alert uses free width instead of clipping at 420px");
    await page.setViewportSize({ width: 860, height: 800 });
    await settled();
    assert.equal(await clipped(alertTitle), false, "A narrow window keeps the alert title whole");
    assert.equal(await clipped(alertLine), true, "A narrow window truncates the reason first");
    checks.push("a narrow footer alert truncates its reason before the chat title");
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  if (diagnosticsOnly) {
    const storageKey = "chat-topics:layout-diagnostics:v1";

    const readTrace = () =>
      page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);

    await row("active").hover();
    await page.waitForFunction(
      (key) =>
        JSON.parse(localStorage.getItem(key) ?? "null")?.samples.some(
          (sample) => sample.reason === "hover" && sample.target !== null,
        ),
      storageKey,
    );
    const initial = await readTrace();
    const session = initial.session;
    checks.push("trusted hover automatically retains sidebar geometry");

    await page.mouse.move(1000, 600);
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.active = null;
      fixture.scope = { kind: "inbox" };
      fixture.append(24);
      fixture.patch("human", {
        title: "PRIVATE_DIAGNOSTIC_TITLE",
        displayTitle: "PRIVATE_DIAGNOSTIC_TITLE",
        href: "#private-diagnostic-url",
      });
      fixture.render();
    });
    await supplyInbox(
      fixtureInbox({
        inbox: [
          needsYou("human", "PRIVATE_DIAGNOSTIC_TITLE"),
          ...Array.from({ length: 24 }, (_, index) =>
            inboxEntry(`extra-${index}`, { title: `Extra chat ${index}` }),
          ),
        ],
      }),
    );
    await frame();
    await page.locator('[data-feed-row="human"]').hover();
    await page.waitForTimeout(300);

    const animation = await page.locator('[data-feed-row="human"]').evaluateHandle((element) => {
      const input = document.createElement("input");
      input.value = "PRIVATE_DIAGNOSTIC_INPUT";
      input.hidden = true;
      element.append(input);

      const motion = element.animate([{ translate: "0 -120px" }, { translate: "0 -120px" }], {
        duration: 2000,
        fill: "both",
      });

      motion.pause();
      motion.currentTime = 0;
      element.style.transform = "translateX(0.1px)";

      return motion;
    });

    await page.waitForFunction((key) => {
      const trace = JSON.parse(localStorage.getItem(key) ?? "null");

      return trace?.samples.some((sample) =>
        sample.rows.some(
          (entry) =>
            entry.translate[1] === -120 &&
            entry.animations.some((motion) => motion.state === "paused"),
        ),
      );
    }, storageKey);
    const overlapped = await readTrace();

    const badSample = overlapped.samples.find((sample) =>
      sample.rows.some((entry) => entry.translate[1] === -120),
    );

    assert.ok(
      badSample.rows.some((entry) => entry.top < 0),
      "The synthetic overlap is recorded above the list origin",
    );
    await animation.evaluate((motion) => motion.cancel());
    await page.mouse.move(1000, 600);
    await page.waitForFunction((key) => {
      const trace = JSON.parse(localStorage.getItem(key) ?? "null");

      return trace?.samples.some((sample) => sample.reason === "leave");
    }, storageKey);
    const retained = await readTrace();
    assert.equal(retained.session, session, "Renders keep the same diagnostic session");
    assert.ok(
      retained.samples.some((sample) => sample.rows.some((entry) => entry.translate[1] === -120)),
      "Moving away preserves the earlier overlap sample",
    );
    checks.push("an overlap and its animation state survive pointer movement");

    await page.waitForFunction(
      () =>
        globalThis.__rowInteractions.diagnostics.some((trace) =>
          trace.samples.some((sample) => sample.rows.some((entry) => entry.translate[1] === -120)),
        ),
      undefined,
      { timeout: 6000 },
    );
    const uploaded = await page.evaluate(() => globalThis.__rowInteractions.diagnostics);
    const serialized = JSON.stringify({ retained, uploaded });

    for (const forbidden of [
      "PRIVATE_DIAGNOSTIC_TITLE",
      "PRIVATE_DIAGNOSTIC_INPUT",
      "private-diagnostic-url",
      "row-fixture-project",
      "chat:human",
      '"human"',
      '"active"',
      '"callback"',
      "chat-topics-row.test",
    ])
      assert.ok(!serialized.includes(forbidden), `Diagnostic output excludes ${forbidden}`);

    for (const trace of [retained, ...uploaded]) {
      assert.ok(trace.samples.length <= 40, "Trace sample count is bounded");

      for (const sample of trace.samples) {
        assert.ok(sample.rows.length <= 12, "Captured row count is bounded");

        for (const entry of sample.rows)
          assert.ok(entry.animations.length <= 3, "Captured animation count is bounded");
      }
    }

    checks.push("automatic uploads retain bounded technical data without chat content");
    await page.waitForTimeout(1000);
    assert.equal(
      await page.evaluate(() => globalThis.__rowInteractions.diagnostics.length),
      uploaded.length,
      "Idle capture does not repeatedly upload",
    );
    checks.push("idle capture creates no upload loop");
    await page.evaluate(() => globalThis.__rowInteractions.unmount());
    await page.waitForFunction(() => document.querySelector("[data-feed]") === null);
    await page.evaluate(() => globalThis.__rowInteractions.render());
    await page.locator("[data-feed]").waitFor();
    await page.waitForFunction(
      (key) => localStorage.getItem(`${key}:previous`) !== null,
      storageKey,
    );

    const previous = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(`${key}:previous`)),
      storageKey,
    );

    assert.equal(previous.session, session);
    assert.ok(
      previous.samples.some((sample) => sample.rows.some((entry) => entry.translate[1] === -120)),
    );
    checks.push("remount retains the previous bounded capture locally");
  }

  if (!diagnosticsOnly && selectionOnly) {
    const humanTitle = row("human").locator(".ct-row-title");
    assert.equal(
      await humanTitle.evaluate((title) => getComputedStyle(title.closest("a")).userSelect),
      "none",
      "project navigation links disable accidental document selection",
    );
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.compact = true;
      fixture.render();
    });
    await frame();
    await humanTitle.dblclick({ position: { x: 10, y: 8 } });
    assert.equal(
      await page.evaluate(() => window.getSelection()?.toString()),
      "",
      "double-clicking a title that only navigates does not select page text",
    );
    assert.equal(await input.count(), 0);
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.compact = false;
      fixture.render();
    });
    await frame();
    await humanTitle.dblclick();
    await input.waitFor();
    assert.deepEqual(
      await input.evaluate((node) => [
        document.activeElement === node,
        node.selectionStart,
        node.selectionEnd,
        getComputedStyle(node).userSelect,
      ]),
      [true, 0, "Needs input".length, "text"],
      "the inline rename editor keeps its text selected and remains selectable",
    );
    await input.press("Escape");
    checks.push("static rows suppress accidental text selection and inline rename keeps selection");

    const categories = () =>
      page.locator(".ct-item").evaluateAll((items) => {
        let section = null;
        const result = {};

        for (const item of items.sort(
          (a, b) => Number(a.dataset.index) - Number(b.dataset.index),
        )) {
          if (item.dataset.kind === "section")
            section = item.querySelector(".ct-section-name")?.textContent ?? null;
          const link = item.querySelector("[data-sidebar-thread-id]");

          if (link !== null) result[link.dataset.sidebarThreadId] = section;
        }

        return result;
      });

    const expectCategories = async (human, error) => {
      await frame();
      const shown = await categories();
      assert.deepEqual({ human: shown.human, error: shown.error }, { human, error });
    };

    await row("human").hover();
    await frame();
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;

      const running = {
        status: "active",
        runtimeStatus: "active",
        hasPendingInteraction: false,
        indicator: null,
        indicatorLabel: null,
      };

      fixture.patch("human", running);
      fixture.patch("error", running);
    });
    await expectCategories("Running", "Running");

    await row("human").locator(".ct-row-link").click();
    await expectCategories("Running", "Running");
    await row("error").locator(".ct-row-link").click();
    await expectCategories("Running", "Running");
    await row("human").locator(".ct-row-link").click();
    await expectCategories("Running", "Running");
    checks.push("hovered rows take their new category at once and clicks never restore stale ones");

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.active = "error";
      fixture.render();
    });
    await expectCategories("Running", "Running");
    checks.push("route navigation keeps the previously opened chat in its current category");
  }

  if (!capsuleOnly && !diagnosticsOnly && headerOnly) {
    assert.equal(
      await page.locator('.ct-section[data-section="run"]').getAttribute("aria-expanded"),
      "true",
      "Project Running starts expanded",
    );
    await row("active").waitFor({ state: "visible" });
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.active = null;
      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await supplyInbox(fixtureInbox());
    const running = page.locator("[data-feed-running]");
    await running.waitFor({ state: "visible" });
    assert.equal(
      await running.getAttribute("aria-expanded"),
      "true",
      "Running starts open alongside the other sections",
    );
    const regular = page.locator('[data-feed-section="inbox"]');
    await regular.waitFor();
    assert.equal(await page.getByRole("button", { name: "Inbox", exact: true }).count(), 0);
    await page.locator('[data-feed-section="run"] [data-feed-row="active"]').waitFor();
    assert.equal(await regular.isVisible(), true, "Running opens alongside ordinary sections");
    await page.locator('[data-feed-section="inbox"] [data-feed-row="human"]').waitFor();

    const motionKeys = await page
      .locator("[data-feed] [data-chat-motion-key]")
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.chatMotionKey));

    assert.equal(
      new Set(motionKeys).size,
      motionKeys.length,
      "Every Inbox row and section has a distinct motion identity",
    );
    await running.click();
    assert.equal(await page.locator('[data-feed-section="run"] [data-feed-row]').count(), 0);
    await running.click();
    assert.equal(await running.getAttribute("aria-expanded"), "true");
    await page.locator('[data-feed-section="run"] [data-feed-row="active"]').waitFor();
    checks.push("Running starts open and can fold and open again alongside ordinary sections");

    if (runningOnly) {
      await page.evaluate(() => globalThis.__rowInteractions.close());
      await browser.close();
      console.log(JSON.stringify({ status: "passed", checks, productionWrites: 0 }));
      process.exit(0);
    }
  }

  if (
    !diagnosticsOnly &&
    !capsuleOnly &&
    !headerOnly &&
    !selectionOnly &&
    !subagentsOnly &&
    !childToggleOnly &&
    !process.argv.includes("--motion-only")
  ) {
    for (const id of ["active", "callback"]) {
      assert.equal(await leadingDot(id).getAttribute("data-dot"), "run");
      assert.equal(await leadingDot(id).getAttribute("role"), "img");
      assert.equal(await leadingDot(id).getAttribute("aria-label"), "Thread working");
      assert.notEqual(
        await leadingDot(id).evaluate((node) =>
          node
            .getAnimations({ subtree: true })
            .some((animation) => animation.playState === "running"),
        ),
        false,
      );
    }

    assert.equal(await row("active").getAttribute("data-active"), "true");
    assert.equal(await leadingDot("human").getAttribute("data-dot"), "need");
    assert.equal(await leadingDot("human").getAttribute("aria-label"), "Thread needs user input");
    assert.equal(await leadingDot("error").getAttribute("data-dot"), "blk");
    assert.equal(await leadingDot("error").getAttribute("aria-label"), "Unread thread failed");
    checks.push("working/selected/callback spinning dots and human/error priority");

    assert.deepEqual(
      await page
        .locator(".ct-section")
        .evaluateAll((sections) =>
          sections.map((section) => [
            section.querySelector(".ct-section-name")?.textContent ?? null,
            section.querySelector(".ct-count")?.textContent ?? null,
            section.getAttribute("aria-expanded"),
          ]),
        ),
      [
        ["Needs you", "1", "true"],
        ["Running", "2", "true"],
        ["Pinned", "1", "true"],
        ["Blocked", "1", "true"],
      ],
    );
    assert.deepEqual(
      await page
        .locator("[data-sidebar-thread-id]")
        .evaluateAll((links) => links.map((link) => link.dataset.sidebarThreadId)),
      ["human", "active", "callback", "pinned", "error"],
    );
    checks.push("state sections in order, newest created first inside each");

    assert.equal(await page.locator(".ct-row-meta, .ct-row-meta-text").count(), 0);

    for (const id of ["active", "callback"]) {
      const box = await row(id).boundingBox();

      assert.ok(box !== null && box.height <= 34, `${id}: one line per running chat`);
    }

    checks.push("one line per running chat without the subtitle");

    assert.equal(await leadingDot("pinned").getAttribute("data-dot"), "idle");
    assert.equal(await row("pinned").locator(".ct-pin").count(), 0);
    assert.equal(
      await row("pinned").locator(".ct-draft").getAttribute("aria-label"),
      "Unsent draft",
    );
    assert.equal(await row("active").locator(".ct-draft").count(), 0);
    checks.push("Pinned section drops the pin icon; an unsent draft keeps a trailing pencil");

    await edit();
    assert.deepEqual(
      await input.evaluate((node) => [
        document.activeElement === node,
        node.selectionStart,
        node.selectionEnd,
      ]),
      [true, 0, 11],
    );
    await page.evaluate(() => {
      globalThis.__rowInteractions.mode = "hold";
    });
    await input.fill("Renamed once");
    await input.press("Enter");
    await page.locator("#row-fixture-outside").click();
    assert.equal(await requestCount(), 1);
    await page.evaluate(() => {
      globalThis.__rowInteractions.release();
      globalThis.__rowInteractions.mode = "success";
    });
    await input.waitFor({ state: "detached" });
    assert.equal(await row("active").locator(".ct-row-title").textContent(), "Renamed once");
    checks.push("focused selected input; Enter plus blur saves exactly once");

    await edit();
    await input.fill("Blur saved");
    await page.locator("#row-fixture-outside").click();
    await input.waitFor({ state: "detached" });
    assert.equal(await requestCount(), 2);
    assert.equal(await row("active").locator(".ct-row-title").textContent(), "Blur saved");
    checks.push("outside blur saves once");

    await edit();
    await input.fill("Discard me");
    await input.press("Escape");
    await page.locator("#row-fixture-outside").click();
    await frame();
    assert.equal(await requestCount(), 2);
    assert.equal(await row("active").locator(".ct-row-title").textContent(), "Blur saved");
    checks.push("Escape discards without a later blur save");

    await edit();
    await input.press("Enter");
    await input.waitFor({ state: "detached" });
    assert.equal(await requestCount(), 2);
    checks.push("unchanged title is a no-op");

    await edit();
    await input.fill("   ");
    await input.press("Enter");
    assert.equal(await input.getAttribute("aria-invalid"), "true");
    assert.equal(
      await row("active").getByRole("alert").getAttribute("aria-label"),
      "Enter a chat title.",
    );
    assert.equal(await requestCount(), 2);
    await input.press("Escape");
    checks.push("blank title stays editable with visible validation");

    await edit();
    await page.evaluate(() => {
      globalThis.__rowInteractions.mode = "failure";
    });
    await input.fill("Retry title");
    await input.press("Enter");
    await input.waitFor({ state: "detached" });
    const failure = row("active").getByRole("alert");
    await failure.waitFor();
    assert.equal(await failure.getAttribute("aria-label"), "Could not rename the chat.");
    assert.equal(await row("active").locator(".ct-row-title").textContent(), "Blur saved");
    assert.equal(await requestCount(), 3);
    await page.evaluate(() => {
      globalThis.__rowInteractions.mode = "success";
    });
    await edit();
    assert.equal(await row("active").getByRole("alert").count(), 0);
    await input.fill("Retry title");
    await input.press("Enter");
    await input.waitFor({ state: "detached" });
    assert.equal(await requestCount(), 4);
    assert.equal(await row("active").locator(".ct-row-title").textContent(), "Retry title");
    checks.push(
      "a failed save closes the editor, keeps the previous title with a visible alert, and a retry saves",
    );

    await edit();
    await input.fill("Composing title");
    await input.dispatchEvent("keydown", { key: "Enter", isComposing: true, bubbles: true });
    await frame();
    assert.equal(await requestCount(), 4);
    assert.equal(await input.count(), 1);
    await input.press("Escape");
    assert.equal(await row("active").locator(".ct-row-meta-text").count(), 0);
    checks.push("composition Enter does not save; the row stays one line");
    const requests = await page.evaluate(() => globalThis.__rowInteractions.requests);
    assert.deepEqual(
      requests.map((entry) => entry.threadId),
      ["active", "active", "active", "active"],
    );
  }

  if (!capsuleOnly && !diagnosticsOnly && !headerOnly && process.argv.includes("--motion-only")) {
    await page.mouse.move(1000, 600);
    await frame();
    const motionSamples = [];

    const patch = (id, value) =>
      page.evaluate(([id, value]) => globalThis.__rowInteractions.patch(id, value), [id, value]);

    const idle = {
      status: "idle",
      runtimeStatus: "idle",
      hasPendingInteraction: false,
      indicator: null,
      indicatorLabel: null,
    };

    const needs = {
      ...idle,
      hasPendingInteraction: true,
      indicator: "waiting-for-input",
      indicatorLabel: "Thread needs user input",
    };

    const running = { ...idle, status: "active", runtimeStatus: "active" };

    const sampleMove = async (id, value, label) => {
      const samples = await page.evaluate(
        async ({ id, value }) => {
          const locate = () => document.querySelector(`[data-sidebar-thread-id="${id}"]`);
          const before = locate().getBoundingClientRect().top;
          const started = performance.now();
          globalThis.__rowInteractions.patch(id, value);
          const positions = [{ at: 0, y: before }];

          while (performance.now() - started < 380) {
            await new Promise(requestAnimationFrame);
            positions.push({
              at: performance.now() - started,
              y: locate().getBoundingClientRect().top,
              moving: locate()
                .closest(".ct-item, .ctf-row")
                .getAnimations()
                .some((animation) => animation.playState === "running"),
            });
          }

          return positions;
        },
        { id, value },
      );

      const start = samples[0].y;
      const end = samples.at(-1).y;
      assert.ok(Math.abs(end - start) > 8, `${label}: state change moves the visible row`);
      assert.ok(
        samples.slice(1).every(({ y }) => Math.abs(y - end) < 1),
        `${label}: row lands in its new place on the next frame`,
      );
      assert.ok(
        samples.every(({ moving }) => moving !== true),
        `${label}: browser runs no row movement animation`,
      );
      motionSamples.push({ label, samples });

      return samples;
    };

    if (motionEvidence !== null)
      await page
        .locator("[data-chat-topics]")
        .screenshot({ path: `${motionEvidence}/motion-before.png` });
    await page.evaluate(() => {
      const events = [];

      const record = (event) => {
        if (event.type === "dragstart") event.preventDefault();
        events.push({
          type: event.type,
          trusted: event.isTrusted,
          prevented: event.defaultPrevented,
        });
      };

      for (const type of ["pointerdown", "pointerup", "dragstart", "dragend"])
        window.addEventListener(type, record);
      globalThis.__rowInteractions.nativeEvents = events;
      globalThis.__rowInteractions.stopNativeCancel = () => {
        for (const type of ["pointerdown", "pointerup", "dragstart", "dragend"])
          window.removeEventListener(type, record);
      };
    });
    const nativeBox = await page.locator('[data-sidebar-thread-id="active"]').boundingBox();
    await page.mouse.move(nativeBox.x + 50, nativeBox.y + nativeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(nativeBox.x + 65, nativeBox.y + nativeBox.height / 2, { steps: 4 });
    await page.mouse.move(500, 600, { steps: 8 });
    await page.mouse.up();

    const nativeDrag = await page.evaluate(() => {
      globalThis.__rowInteractions.stopNativeCancel();

      return globalThis.__rowInteractions.nativeEvents;
    });

    assert.ok(
      nativeDrag.some(
        ({ type, trusted, prevented }) => type === "dragstart" && trusted && prevented,
      ),
      "The real native drag reaches the host cancellation listener",
    );
    assert.ok(
      nativeDrag.some(({ type, trusted }) => type === "pointerup" && trusted),
      "A canceled native drag finishes through the ordinary pointer release",
    );
    assert.equal(
      nativeDrag.some(({ type }) => type === "dragend"),
      false,
      "Canceled native drag never dispatches dragend",
    );
    await page.mouse.move(1000, 600);
    await sampleMove("active", needs, "Motion after trusted host-canceled drag");
    checks.push("a trusted host-canceled drag leaves automatic placement instant after pointerup");
    await sampleMove("active", running, "Return after native drag");
    await sampleMove("active", needs, "Project state regrouping");
    assert.equal(await row("active").getAttribute("data-state"), "need");
    checks.push("automatic project regrouping lands at once without intermediate positions");
    await sampleMove("active", running, "Project running regrouping");

    const motionInbox = (revision, entries) =>
      fixtureInbox({
        revision,
        inbox: entries,
        running: [],
        waiting: [inboxWaiting("callback", { group: "comes-back" })],
      });

    const human = needsYou("human", "Needs input");

    const finishedRows = [
      inboxEntry("error", { title: "Failed chat" }),
      inboxEntry("pinned", { title: "Pinned chat" }),
    ];

    await page.evaluate(() => {
      globalThis.__rowInteractions.active = null;
      globalThis.__rowInteractions.scope = { kind: "inbox" };
      globalThis.__rowInteractions.render();
    });
    await supplyInbox(
      motionInbox("motion-start", [needsYou("active", "Active chat"), human, ...finishedRows]),
    );
    await page.waitForFunction(() => document.querySelector('[data-feed-row="active"]'));
    await frame();

    const settling = await page.evaluate(
      async ({ value, snapshot }) => {
        const fixture = globalThis.__rowInteractions;
        const locate = () => document.querySelector('[data-sidebar-thread-id="active"]');
        const before = locate().getBoundingClientRect().top;
        const started = performance.now();
        const positions = [];
        let delivered = null;

        fixture.patch("active", value);

        while (performance.now() - started < 3000) {
          await new Promise(requestAnimationFrame);

          if (delivered === null && performance.now() - started >= 300) {
            delivered = performance.now() - started;
            fixture.deliverInbox(snapshot);
          }

          positions.push({
            at: performance.now() - started,
            y: locate().getBoundingClientRect().top,
            moving: locate()
              .closest(".ctf-row")
              .getAnimations()
              .some((animation) => animation.playState === "running"),
          });
        }

        return { before, delivered, positions };
      },
      {
        value: { ...idle, status: "error", indicator: "unread-error" },
        snapshot: motionInbox("motion-settled", [
          human,
          inboxEntry("active", { title: "Active chat" }),
          ...finishedRows,
        ]),
      },
    );

    const settledEnd = settling.positions.at(-1).y;

    assert.ok(
      settling.positions
        .filter(({ at }) => at < settling.delivered)
        .every(({ y }) => Math.abs(y - settling.before) < 1),
      "Inbox rows hold still until the new Inbox snapshot lands",
    );
    assert.ok(
      Math.abs(settledEnd - settling.before) > 8,
      "Inbox rows settle into their new section",
    );
    assert.ok(
      settling.positions.every(
        ({ y }) => Math.abs(y - settling.before) < 1 || Math.abs(y - settledEnd) < 1,
      ),
      "Inbox settling jumps straight to the new section without intermediate positions",
    );
    assert.ok(
      settling.positions.every(({ moving }) => moving !== true),
      "Inbox settling runs no row movement animation",
    );
    motionSamples.push({ label: "Inbox settle", samples: settling.positions });
    assert.equal(await page.locator('[data-feed-row="active"]').getAttribute("data-state"), "done");
    checks.push(
      "Inbox rows hold still until a new snapshot lands, then move across sections at once",
    );

    const resumed = await page.evaluate(
      async ({ value, snapshot }) => {
        const fixture = globalThis.__rowInteractions;
        const started = performance.now();
        const frames = [];

        fixture.patch("active", value);
        fixture.deliverInbox(snapshot);

        while (performance.now() - started < 4000) {
          await new Promise(requestAnimationFrame);
          frames.push({
            at: Math.round(performance.now() - started),
            section:
              document
                .querySelector('[data-feed-row="active"]')
                ?.closest("[data-feed-section]")
                ?.getAttribute("data-feed-section") ?? null,
          });
        }

        return frames;
      },
      {
        value: running,
        snapshot: {
          ...motionInbox("motion-resumed", [human, ...finishedRows]),
          running: [inboxEntry("active", { title: "Active chat", view: "running", card: null })],
        },
      },
    );

    const left = resumed.findIndex(({ section }) => section !== "finished");
    const returns = resumed.slice(left).filter(({ section }) => section === "finished");

    assert.ok(
      left >= 0 && resumed[left].at < 1500,
      "A resumed chat leaves Finished once it settles into open Running",
    );
    assert.equal(resumed.at(-1).section, "run", "A resumed chat ends in open Running");
    assert.deepEqual(
      returns.map(({ at }) => at),
      [],
      "A resumed chat never flashes back into Finished",
    );
    checks.push("a finished chat that resumes leaves Finished once and never flashes back");

    const withHuman = motionInbox("motion-with-human", [human, ...finishedRows]);

    const shifted = await page.evaluate(
      async ({ without, restored }) => {
        const fixture = globalThis.__rowInteractions;
        const feed = document.querySelector(".ctf");
        const rows = () => Array.from(feed.querySelectorAll("[data-feed-row]"));
        const notice = document.createElement("p");
        notice.className = "ct-notice";
        notice.style.height = "120px";
        notice.textContent = "Could not load tags. Chats keep their titles.";
        const frames = [];
        const started = performance.now();

        feed.before(notice);
        fixture.patch("human", { isArchived: true, archivedAt: 9 });
        fixture.deliverInbox(without);

        while (performance.now() - started < 1400) {
          await new Promise(requestAnimationFrame);
          const top = feed.getBoundingClientRect().top;
          frames.push(Math.min(...rows().map((row) => row.getBoundingClientRect().top - top)));
        }

        notice.remove();
        fixture.patch("human", { isArchived: false, archivedAt: null });
        fixture.deliverInbox(restored);

        return { rows: rows().length, frames };
      },
      {
        without: motionInbox("motion-shift", finishedRows),
        restored: withHuman,
      },
    );

    assert.ok(shifted.rows > 0, "The Inbox lists rows around the layout shift");
    assert.ok(
      shifted.frames.every((top) => top >= -1),
      `Rows never fly above the Inbox feed when content above it grows: ${Math.min(...shifted.frames)}px`,
    );
    checks.push("a notice above the Inbox in the same frame as a reorder never lifts rows over it");

    await page.locator('[data-feed-row="human"]').waitFor();
    await page.waitForTimeout(1300);

    const scrolling = await page.evaluate(
      async ({ without, restored }) => {
        const fixture = globalThis.__rowInteractions;
        const list = document.querySelector("[data-chat-topics]");
        const rows = () => Array.from(list.querySelectorAll("[data-chat-motion-key]"));
        const moving = [];
        const ghosts = [];
        const started = performance.now();

        list.dispatchEvent(new WheelEvent("wheel", { deltaY: 40, bubbles: true }));
        fixture.patch("human", { isArchived: true, archivedAt: 9 });
        fixture.deliverInbox(without);

        while (performance.now() - started < 600) {
          await new Promise(requestAnimationFrame);
          moving.push(rows().filter((row) => row.getAnimations().length > 0).length);
          ghosts.push(list.querySelectorAll("[data-chat-motion-ghost]").length);
        }

        const archived = document.querySelector('[data-feed-row="human"]') === null;
        fixture.patch("human", { isArchived: false, archivedAt: null });
        fixture.deliverInbox(restored);

        return { archived, moving, ghosts };
      },
      {
        without: motionInbox("motion-scroll", finishedRows),
        restored: motionInbox("motion-scroll-restored", [human, ...finishedRows]),
      },
    );

    assert.ok(scrolling.archived, "The reorder lands while the list is being scrolled");
    assert.deepEqual(
      [Math.max(...scrolling.moving), Math.max(...scrolling.ghosts)],
      [0, 0],
      "Rows take a reorder that lands mid-scroll directly, without slides or exit copies",
    );
    checks.push("a reorder that lands while the list scrolls starts no row animations");

    await page.evaluate(() => {
      globalThis.__rowInteractions.scope = { kind: "project", projectId: "row-fixture-project" };
      globalThis.__rowInteractions.render();
    });
    await page.locator(".ct-space").waitFor();
    await patch("active", running);
    await page.waitForTimeout(280);
    await row("active").hover();
    const hoveredY = (await row("active").boundingBox()).y;
    await patch("active", idle);
    await frame();
    const movedY = (await row("active").boundingBox()).y;
    assert.ok(Math.abs(movedY - hoveredY) > 1, "A hovered row moves to its new place at once");
    await page.waitForTimeout(240);
    assert.ok(
      Math.abs((await row("active").boundingBox()).y - movedY) < 1,
      "A hovered row lands in one frame, without easing",
    );
    checks.push("a hovered row moves to its new place at once");

    await patch("active", running);
    await page.waitForTimeout(280);

    const interrupt = await page.evaluate(
      async ({ needs, running }) => {
        const top = () =>
          document.querySelector('[data-sidebar-thread-id="active"]').getBoundingClientRect().top;

        const start = top();
        globalThis.__rowInteractions.patch("active", needs);
        await new Promise((done) => setTimeout(done, 90));
        const middle = top();
        globalThis.__rowInteractions.patch("active", running);
        await new Promise(requestAnimationFrame);

        return { start, middle, after: top() };
      },
      { needs, running },
    );

    assert.ok(
      Math.abs(interrupt.middle - interrupt.start) > 8,
      "The first rapid change has already placed the row",
    );
    assert.ok(
      Math.abs(interrupt.after - interrupt.start) < 1,
      "The second rapid change returns the row to its place on the next frame",
    );
    await page.waitForTimeout(280);
    checks.push("rapid state changes each land at once");

    const streaming = await page.evaluate(async (needs) => {
      const positions = [];
      const started = performance.now();

      const top = () =>
        document.querySelector('[data-sidebar-thread-id="active"]').getBoundingClientRect().top;

      globalThis.__rowInteractions.patch("active", needs);

      while (performance.now() - started < 360) {
        await new Promise(requestAnimationFrame);
        globalThis.__rowInteractions.patch("callback", {
          experimental_subtitle: String(performance.now()),
        });
        positions.push({ at: performance.now() - started, y: top() });
      }

      await new Promise((done) => setTimeout(done, 280));

      return { positions, final: top() };
    }, needs);

    assert.ok(
      streaming.positions.every(({ y }) => Math.abs(y - streaming.final) < 1),
      "The state change lands at once and streaming rerenders never move the row",
    );
    motionSamples.push({
      label: "Streaming updates",
      samples: streaming.positions,
      final: streaming.final,
    });
    checks.push("streaming rerenders keep an instantly placed row still");

    await page.evaluate(() => {
      globalThis.__rowInteractions.active = "human";
      globalThis.__rowInteractions.render();
    });
    await page.waitForTimeout(300);

    const archived = await page.evaluate(async () => {
      const fixture = globalThis.__rowInteractions;
      const ghosts = () => document.querySelectorAll("[data-chat-motion-ghost]").length;

      const order = Array.from(document.querySelectorAll("[data-sidebar-thread-id]")).map(
        (row) => row.dataset.sidebarThreadId,
      );

      const next = order[order.indexOf("human") + 1];

      const top = () =>
        document.querySelector(`[data-sidebar-thread-id="${next}"]`).getBoundingClientRect().top;

      const before = top();
      fixture.patch("human", { isArchived: true, archivedAt: 9 });
      fixture.active = next;
      fixture.render();
      await new Promise(requestAnimationFrame);

      const early = top();
      const started = ghosts();
      const gone = document.querySelector('[data-sidebar-thread-id="human"]') === null;
      await new Promise((done) => setTimeout(done, 300));

      return { before, early, final: top(), started, gone, remaining: ghosts() };
    });

    assert.equal(archived.gone, true, "An archived row leaves the list on the next frame");
    assert.deepEqual(
      [archived.started, archived.remaining],
      [0, 0],
      "Archiving leaves no fading exit copy behind",
    );
    assert.ok(
      Math.abs(archived.early - archived.final) < 1 &&
        Math.abs(archived.final - archived.before) > 8,
      "The next row takes the archived row's place on the next frame",
    );
    checks.push("archiving removes the row at once and the next row takes its place");

    const restored = await page.evaluate(async () => {
      globalThis.__rowInteractions.patch("human", { isArchived: false, archivedAt: null });
      await new Promise(requestAnimationFrame);
      const item = document.querySelector('[data-sidebar-thread-id="human"]').closest(".ct-item");

      return {
        opacity: Number(getComputedStyle(item).opacity),
        animations: item
          .getAnimations({ subtree: true })
          .filter(
            (animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
          ).length,
      };
    });

    assert.equal(restored.opacity, 1, "A restored row is fully visible on the next frame");
    assert.equal(restored.animations, 0, "A restored row appears without an entrance animation");
    checks.push("restored rows appear at once");
    await page.evaluate(() => {
      globalThis.__rowInteractions.active = "active";
      globalThis.__rowInteractions.render();
    });
    await page.waitForTimeout(300);
    await patch("active", running);
    await page.waitForTimeout(280);

    await page.evaluate(() => {
      const events = [];
      const record = (event) => events.push(event.type);

      for (const type of ["pointerdown", "pointercancel", "pointerup", "dragstart", "dragend"])
        document.addEventListener(type, record, true);
      globalThis.__rowInteractions.pointerEvents = events;
      globalThis.__rowInteractions.stopPointerEvents = () => {
        for (const type of ["pointerdown", "pointercancel", "pointerup", "dragstart", "dragend"])
          document.removeEventListener(type, record, true);
      };
    });
    const dragBox = await row("active").boundingBox();
    await page.mouse.move(dragBox.x + 50, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(1000, 600);
    await patch("active", needs);
    await frame();
    const pointerY = (await row("active").boundingBox()).y;
    await page.waitForTimeout(100);
    assert.ok(
      Math.abs(pointerY - (await row("active").boundingBox()).y) < 1,
      "A held pointer keeps placement direct",
    );
    await page.mouse.up();

    const pointerEvents = await page.evaluate(() => {
      globalThis.__rowInteractions.stopPointerEvents();

      return globalThis.__rowInteractions.pointerEvents;
    });

    assert.ok(
      pointerEvents.includes("pointerdown"),
      "Direct-input check uses actual browser pointer events",
    );
    checks.push("held pointer keeps placement direct");

    await patch("active", idle);
    await page.waitForTimeout(280);

    const stroke = await page.evaluate(async () => {
      globalThis.__rowInteractions.ready(["active"]);
      await new Promise(requestAnimationFrame);
      const dot = document.querySelector('[data-sidebar-thread-id="active"] .ct-dot');
      const path = dot.querySelector(".ct-dot-check path");

      return {
        dot: dot.dataset.dot,
        animations: dot
          .getAnimations({ subtree: true })
          .filter(
            (animation) => animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
          ).length,
        dasharray: getComputedStyle(path).strokeDasharray,
        opacity: getComputedStyle(dot.querySelector(".ct-dot-check")).opacity,
      };
    });

    assert.deepEqual(
      stroke,
      { dot: "done", animations: 0, dasharray: "none", opacity: "1" },
      "A completed check shows fully drawn on the next frame without animating",
    );
    checks.push("completion check appears fully drawn at once");

    const completedInbox = (revision) =>
      motionInbox(revision, [
        human,
        inboxEntry("active", { title: "Active chat" }),
        ...finishedRows,
      ]);

    await page.evaluate((snapshot) => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.render();
      fixture.deliverInbox(snapshot);
      fixture.patch("active", {});
    }, completedInbox("motion-completed"));
    await page.locator('[data-feed-row="active"]').waitFor();
    assert.equal(
      await page.locator('[data-feed-row="active"] :is(.ct-dot, .ctf-row-mark)').count(),
      0,
      "A completed Inbox row leads with its project icon alone",
    );
    await page.evaluate(
      ({ value, snapshot }) => {
        globalThis.__rowInteractions.patch("active", value);
        globalThis.__rowInteractions.deliverInbox(snapshot);
      },
      {
        value: needs,
        snapshot: motionInbox("motion-needs", [
          needsYou("active", "Active chat"),
          human,
          ...finishedRows,
        ]),
      },
    );
    await page.locator('[data-feed-row="active"][data-state="need"]').waitFor();

    const remounted = await page.evaluate(
      async ({ idle, snapshot }) => {
        const previous = document.querySelector('[data-feed-row="active"]');
        const started = performance.now();
        globalThis.__rowInteractions.patch("active", idle);
        globalThis.__rowInteractions.deliverInbox(snapshot);

        while (
          document.querySelector('[data-feed-row="active"]') === previous &&
          performance.now() - started < 2500
        )
          await new Promise(requestAnimationFrame);

        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const next = document.querySelector('[data-feed-row="active"]');

        return {
          remounted: next !== previous,
          marks: next.querySelectorAll(".ct-dot, .ctf-row-mark").length,
        };
      },
      { idle, snapshot: completedInbox("motion-completed-again") },
    );

    assert.equal(
      remounted.remounted,
      true,
      "Completion changes the Inbox section and remounts the row",
    );
    assert.equal(remounted.marks, 0, "A remounted completed row carries no state mark");
    checks.push("remounted completed Inbox row leads with its project icon alone");
    await page.evaluate(() => {
      globalThis.__rowInteractions.scope = { kind: "project", projectId: "row-fixture-project" };
      globalThis.__rowInteractions.render();
    });
    await page.locator(".ct-space").waitFor();

    if (motionEvidence !== null)
      await page
        .locator("[data-chat-topics]")
        .screenshot({ path: `${motionEvidence}/glyph-complete.png` });

    await page.evaluate(() => globalThis.__rowInteractions.append(80));
    await frame();
    await patch("active", running);
    await page.waitForTimeout(60);

    const scrolled = await page.evaluate(async () => {
      const list = document.querySelector(".ct-list");
      list.scrollTop = 1500;
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const rows = [...list.querySelectorAll(".ct-item")];

      return {
        count: rows.length,
        moving: rows.some((node) =>
          node.getAnimations().some((animation) => animation.playState === "running"),
        ),
      };
    });

    assert.ok(scrolled.count < 80, "Long list remains virtualized");
    assert.equal(scrolled.moving, false, "Newly realized rows never fly in while scrolling");
    checks.push("scroll realization remains immediate and virtualized");

    const failed = {
      ...idle,
      status: "error",
      indicator: "unread-error",
      indicatorLabel: "Unread thread failed",
    };

    await patch("error", idle);
    await page.evaluate(() => {
      document.querySelector(".ct-list").scrollTop = 600;
    });
    await page.waitForTimeout(400);

    const anchored = await page.evaluate(async (failed) => {
      const list = document.querySelector(".ct-list");

      const visible = () => {
        const view = list.getBoundingClientRect();
        const rows = new Map();

        for (const node of list.querySelectorAll(".ct-item[data-chat-motion-key]")) {
          const box = node.getBoundingClientRect();

          if (box.top >= view.top && box.bottom <= view.bottom)
            rows.set(node.dataset.chatMotionKey, box.top - view.top);
        }

        return rows;
      };

      const before = visible();
      const scrollTop = list.scrollTop;
      const started = performance.now();
      let drift = 0;
      globalThis.__rowInteractions.patch("extra-70", failed);

      while (performance.now() - started < 500) {
        await new Promise(requestAnimationFrame);

        for (const [key, top] of visible())
          if (before.has(key)) drift = Math.max(drift, Math.abs(top - before.get(key)));
      }

      return { rows: before.size, drift, scrolled: list.scrollTop - scrollTop };
    }, failed);

    assert.ok(anchored.rows > 5, "Rows are visible below the scrolled-away top of the list");
    assert.ok(anchored.scrolled > 30, "The list scrolls by the height of the new Blocked section");
    assert.ok(
      anchored.drift <= 1,
      `Visible rows hold still when a section opens above them: ${anchored.drift}px`,
    );
    checks.push("a section opening above the scrolled viewport keeps visible rows in place");
    await patch("extra-70", idle);
    await page.evaluate(() => {
      document.querySelector(".ct-list").scrollTop = 0;
    });
    await patch("pinned", { isPinned: false, pinnedAt: null });
    await patch("human", idle);

    for (const id of ["active", "callback"]) await patch(id, idle);
    await page.waitForTimeout(500);

    const revealed = await page.evaluate(async (failed) => {
      const space = document.querySelector(".ct-space");

      const tops = () =>
        new Map(
          Array.from(space.querySelectorAll(".ct-item[data-chat-motion-key]"), (node) => [
            node.dataset.chatMotionKey,
            node.getBoundingClientRect().top,
          ]),
        );

      const before = tops();
      const started = performance.now();
      const frames = [];
      globalThis.__rowInteractions.patch("extra-5", failed);

      while (performance.now() - started < 600) {
        await new Promise(requestAnimationFrame);
        const header = space.querySelector('[data-chat-motion-key$=":blk"]');

        if (header === null) continue;
        const box = header.getBoundingClientRect();
        const inset = getComputedStyle(header).clipPath.match(/-?[\d.]+px/g) ?? [];
        const hidden = Number.parseFloat(inset[2] ?? inset[0] ?? "0");
        frames.push({
          top: box.top,
          height: box.height,
          shown: box.height - hidden,
          now: tops(),
        });
      }

      const last = frames.at(-1);

      const below =
        last === undefined
          ? undefined
          : [...before]
              .filter(([key, top]) => key !== "extra-5" && top >= last.top - 0.5)
              .sort((a, b) => a[1] - b[1])[0]?.[0];

      const final = last?.now ?? new Map();

      const backtrack = Math.max(
        0,
        ...[...before]
          .filter(([key, top]) => key !== "extra-5" && (final.get(key) ?? top) > top + 1)
          .flatMap(([key, top]) => frames.map(({ now }) => top - (now.get(key) ?? top))),
      );

      return {
        frames: frames.length,
        first: space.querySelector(".ct-item[data-first]")?.dataset.chatMotionKey ?? null,
        backtrack,
        partial: frames.some(({ shown, height }) => shown > 1 && shown < height - 1),
        overlap: Math.max(
          ...frames.map(({ top, shown, now }) => top + shown - (now.get(below) ?? Infinity)),
        ),
      };
    }, failed);

    assert.ok(revealed.frames > 0, "A new Blocked section appears at the top of the list");
    assert.ok(
      revealed.first?.endsWith(":blk"),
      `The new Blocked section takes the first slot: ${revealed.first}`,
    );
    assert.equal(revealed.partial, false, "The new Blocked header appears whole at once");
    assert.ok(
      revealed.overlap <= 0.5,
      `The new Blocked header never covers the row below it: ${revealed.overlap}px`,
    );
    assert.ok(
      revealed.backtrack <= 1,
      `Rows below never hop back up when the first section changes: ${revealed.backtrack}px`,
    );
    checks.push("a new first section appears whole at once with the rows below it, without hops");
    await patch("extra-5", idle);
    await patch("human", needs);
    await patch("pinned", { isPinned: true, pinnedAt: 5 });
    await page.evaluate(() => {
      document.querySelector(".ct-list").scrollTop = 0;
    });
    await frame();

    if (motionEvidence !== null) {
      await writeFile(
        `${motionEvidence}/motion-samples.json`,
        JSON.stringify(
          { motionSamples, interrupt, scrolled, stroke, remounted, pointerEvents, nativeDrag },
          null,
          2,
        ) + "\n",
      );
      await page
        .locator("[data-chat-topics]")
        .screenshot({ path: `${motionEvidence}/motion-after.png` });
    }
  }

  if (subagentsOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;

      const agents = (count) => ({
        activity: {
          workflows: 0,
          backgroundAgents: 0,
          backgroundCommands: 0,
          planMode: 0,
          goals: 0,
          experimental_subagents: count,
        },
      });

      fixture.append(7);
      fixture.patch("active", agents(3));
      fixture.patch("callback", agents(12));
      fixture.patch("human", agents(2));
      fixture.patch("extra-0", { status: "active", isUnread: true, ...agents(1) });
      fixture.patch("extra-1", { status: "active", ...agents(0) });
      fixture.patch("extra-2", { status: "active", parentThreadId: "callback", ...agents(2) });

      for (const [id, parentThreadId] of [
        ["extra-3", "extra-0"],
        ["extra-4", "extra-3"],
        ["extra-5", "extra-1"],
        ["extra-6", "extra-2"],
      ])
        fixture.patch(id, {
          status: "idle",
          runtimeStatus: "idle",
          parentThreadId,
          ...agents(0),
        });
    });

    const rings = async (links) => {
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".ct-dot[data-agents] .ct-dot-ring")].every(
          (ring) => getComputedStyle(ring).width === "15px",
        ),
      );

      return page.locator(links).evaluateAll((elements) =>
        elements.map((link) => {
          const box = (element) => {
            const rect = element.getBoundingClientRect();

            return {
              left: rect.left,
              right: rect.right,
              x: (rect.left + rect.right) / 2,
              y: (rect.top + rect.bottom) / 2,
            };
          };

          const dot = link.querySelector(":scope > .ct-dot");
          const count = dot.querySelector(".ct-dot-count");
          const unread = link.querySelector(":scope > .ct-unread-dot");

          return {
            id: link.dataset.sidebarThreadId,
            label: dot.getAttribute("aria-label"),
            title: dot.getAttribute("title"),
            count: count?.textContent ?? null,
            dot: box(dot),
            ring: box(dot.querySelector(".ct-dot-ring")),
            digits: count === null ? null : box(count),
            unread: unread === null ? null : box(unread),
            neighbor: box(link.querySelector(":scope > .ct-dot ~ :not(.ct-unread-dot)")),
          };
        }),
      );
    };

    const counted = (rows) =>
      Object.fromEntries(rows.flatMap((row) => (row.count === null ? [] : [[row.id, row.count]])));

    const labelled = (rows) => Object.fromEntries(rows.map((row) => [row.id, row.label]));

    const assertGeometry = (rows) => {
      for (const row of rows) {
        assert.equal(row.title, row.label, `${row.id}: hover title matches the spoken label`);
        assert.ok(Math.abs(row.ring.x - row.dot.x) < 0.5, `${row.id}: ring stays centred`);
        assert.ok(Math.abs(row.ring.y - row.dot.y) < 0.5, `${row.id}: ring stays centred`);
        assert.equal(row.neighbor.left, rows[0].neighbor.left, `${row.id}: title keeps its column`);

        if (row.count === null) continue;
        assert.ok(row.dot.x + 7.5 + 2 <= row.neighbor.left, `${row.id}: ring clears the title`);
        assert.ok(Math.abs(row.digits.x - row.dot.x) < 1, `${row.id}: count sits in the ring`);
        assert.ok(Math.abs(row.digits.y - row.dot.y) < 1, `${row.id}: count sits in the ring`);

        if (row.unread !== null)
          assert.ok(row.unread.right <= row.dot.x - 7.5, `${row.id}: unread dot clears the ring`);
      }
    };

    await page.locator('.ct-row:has([data-sidebar-thread-id="callback"]) .ct-kids').first().click();
    await row("extra-2").waitFor();
    const projects = await rings('.ct-row-link[data-chat-depth="0"]');
    const nested = await rings('.ct-row-link[data-chat-depth="1"]');

    assert.deepEqual(counted([...projects, ...nested]), {
      active: "3",
      callback: "16",
      "extra-0": "3",
      "extra-1": "1",
      "extra-2": "3",
    });
    assert.deepEqual(
      { ...labelled(projects), ...labelled(nested) },
      {
        pinned: "Recorded work",
        error: "Unread thread failed",
        human: "Thread needs user input",
        active: "Thread working · 3 subchats and subagents",
        callback: "Thread working · 16 subchats and subagents",
        "extra-2": "Thread working · 3 subchats and subagents",
        "extra-0": "Thread working · 3 subchats and subagents",
        "extra-1": "Thread working · 1 subchat or subagent",
      },
    );
    assertGeometry(projects);
    assertGeometry(nested);
    assert.equal(
      await leadingDot("callback").locator(".ct-dot-count").getAttribute("data-wide"),
      "true",
    );
    checks.push("every working parent counts all nested chats and live subagents in its spinner");
    checks.push("a counted ring stays centred, clears the title and keeps every title column");

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;

      fixture.scope = { kind: "inbox" };
      fixture.render();
    });
    await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length > 0);
    await page.evaluate(
      (snapshot) => globalThis.__rowInteractions.inboxRequests.at(-1).resolve(snapshot),
      inboxSnapshot({
        inbox: ["human", "error", "pinned"].map((id) => inboxEntry(id, { title: id })),
        running: ["active", "callback", "extra-0", "extra-1"].map((id) =>
          inboxEntry(id, { title: id, view: "running", card: null }),
        ),
        waiting: [],
      }),
    );

    if ((await page.locator("[data-feed-running]").getAttribute("aria-expanded")) === "false")
      await page.locator("[data-feed-running]").dispatchEvent("click");

    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.active = null;
      fixture.render();
    });
    await frame();

    const callbackKids = page.locator(
      '[data-feed-row="callback"] > .ctf-row-surface > .ctf-row-main .ct-kids',
    );

    if ((await callbackKids.getAttribute("aria-expanded")) === "false") await callbackKids.click();
    await page.locator('.ctf-kid[data-sidebar-thread-id="extra-2"]').waitFor();
    const kids = await rings(".ctf-kid");

    for (const id of ["active", "callback", "extra-0", "extra-1"])
      assert.equal(
        await page
          .locator(
            `[data-feed-row="${id}"] > .ctf-row-surface > .ctf-row-main .ctf-row-mark[data-dot="run"]`,
          )
          .count(),
        1,
        `${id}: a working Inbox parent carries the running corner mark`,
      );
    assert.equal(
      await page.locator(".ctf-row-link .ct-dot-count").count(),
      0,
      "top-level Inbox rows lead with the project mark and carry no count",
    );
    assert.deepEqual(counted(kids), { "extra-2": "3" });
    assert.deepEqual(labelled(kids), {
      "extra-2": "Working: Thread working · 3 subchats and subagents",
    });
    assertGeometry(kids);
    checks.push(
      "Inbox parents carry the running corner mark; nested rows show the full count centred inside their spinner",
    );

    const kidCount = () =>
      page.evaluate(
        () =>
          document.querySelector('.ctf-kid[data-sidebar-thread-id="extra-2"] .ct-dot-count')
            ?.textContent ?? null,
      );

    await page.evaluate(() => globalThis.__rowInteractions.patch("extra-6", { isArchived: true }));
    await page.waitForFunction(
      () =>
        document.querySelector('.ctf-kid[data-sidebar-thread-id="extra-2"] .ct-dot-count')
          ?.textContent === "2",
    );
    await page.evaluate(() => globalThis.__rowInteractions.patch("extra-6", { isArchived: false }));
    await page.waitForFunction(
      () =>
        document.querySelector('.ctf-kid[data-sidebar-thread-id="extra-2"] .ct-dot-count')
          ?.textContent === "3",
    );
    assert.equal(await kidCount(), "3");
    checks.push("the spinner count follows subchats entering and leaving the sidebar tree");
    await page.evaluate(() =>
      globalThis.__rowInteractions.patch("extra-1", { experimental_shelvedAt: 1 }),
    );
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "project", projectId: "row-fixture-project" };
      fixture.render();
    });
    await page.locator('.ct-row-link[data-sidebar-thread-id="extra-1"] .ct-dot-count').waitFor();
    assert.equal(await leadingDot("extra-1").getAttribute("data-agents"), "1");
    checks.push("running shelved parents keep the count in their Projects spinner");
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.scope = { kind: "inbox" };
      fixture.active = null;
      fixture.patch("human", {
        isUnread: true,
        experimental_work: {
          primary: {
            label: "needs-you",
            reason: { code: "fixture", text: "Needs input while active" },
          },
          activity: [{ id: "turn", label: "The agent is working." }],
          requiredInput: [],
          optionalInput: [],
          failures: [],
          waits: [],
          nextActors: [],
          archive: { eligible: false, recommended: false, reason: "Recorded work" },
          assessment: {
            availability: "available",
            reason: "Recorded assessment",
            sourceSeq: null,
            suggestion: "omitted",
            noSuggestionReason: null,
            waitingOn: null,
          },
        },
      });
      fixture.render();
    });
    await supplyInbox(
      inboxSnapshot({
        inbox: [
          inboxEntry("callback", { title: "Callback chat" }),
          inboxEntry("pinned", { title: "Pinned chat" }),
        ],
        running: [inboxEntry("human", { title: "Needs input", view: "running", card: null })],
      }),
    );
    await expandRunning();
    await page.locator('[data-feed-row="human"] .ctf-row-mark[data-dot="run"]').waitFor();

    for (const width of [240, 320, 480]) {
      await page.locator('main[data-omnyo-plugin="chat-topics"]').evaluate((element, width) => {
        element.style.width = `${width}px`;
      }, width);

      const rows = await page.locator(".ctf-row-link").evaluateAll((links) =>
        links.map((link) => {
          const title = link.querySelector(".ctf-title").getBoundingClientRect();

          const indicators = [
            ...link.querySelectorAll(":scope > .ct-dot, :scope > .ctf-row-project"),
          ].map((element) => element.getBoundingClientRect());

          return {
            id: link.dataset.sidebarThreadId,
            width: title.width,
            aligned: indicators.every(
              (box) => Math.abs((box.top + box.bottom - title.top - title.bottom) / 2) < 1,
            ),
          };
        }),
      );

      for (const row of rows) {
        assert.ok(row.aligned, `${width}px ${row.id}: indicators and title stay on one line`);
        assert.ok(
          row.width > 40,
          `${width}px ${row.id}: title keeps readable space (${row.width}px)`,
        );
      }
    }

    checks.push(
      "Inbox titles stay readable beside working, attention and unread indicators at 240, 320 and 480px",
    );
  }

  if (childToggleOnly) {
    await page.evaluate(() => {
      const fixture = globalThis.__rowInteractions;
      fixture.append(4);

      for (const id of ["extra-0", "extra-1"])
        fixture.patch(id, {
          parentThreadId: "active",
          status: "active",
          runtimeStatus: "running",
        });
      fixture.patch("extra-2", {
        parentThreadId: "extra-0",
        status: "active",
        runtimeStatus: "running",
      });
      fixture.patch("extra-3", {
        parentThreadId: "active",
        status: "active",
        runtimeStatus: "running",
        isHidden: true,
      });
      fixture.active = "callback";
      fixture.render();
    });

    for (const surface of ["Projects", "Inbox"]) {
      if (surface === "Inbox") {
        await page.evaluate(() => {
          const fixture = globalThis.__rowInteractions;
          fixture.scope = { kind: "inbox" };
          fixture.active = "callback";
          fixture.render();
        });
        await page.waitForFunction(() => globalThis.__rowInteractions.inboxRequests.length > 0);
        await page.evaluate(
          (snapshot) => globalThis.__rowInteractions.inboxRequests.at(-1).resolve(snapshot),
          inboxSnapshot({
            inbox: [inboxEntry("callback", { title: "callback" })],
            running: [inboxEntry("active", { title: "active", view: "running", card: null })],
            waiting: [],
          }),
        );
        await page.locator("[data-feed]").waitFor();
        await expandRunning();
      }

      const link = (id) => page.locator(`[data-sidebar-thread-id="${id}"]`).first();

      const open = async (id) => {
        await link(id).click();
        await frame();
        assert.equal(
          await page.evaluate(() => globalThis.__rowInteractions.active),
          id,
          `${surface} opens the clicked chat`,
        );
      };

      const childCount = (id) => page.locator(`[data-sidebar-thread-id="${id}"]`).count();

      const toggle = (id) =>
        surface === "Projects"
          ? page.locator(`.ct-row:has([data-sidebar-thread-id="${id}"]) .ct-kids`).first()
          : page.locator(`[data-feed-row="${id}"] > .ctf-row-surface > .ctf-row-main .ct-kids`);

      assert.equal(await childCount("extra-0"), 0, `${surface} starts with children collapsed`);
      assert.equal(await toggle("active").getAttribute("aria-expanded"), "false");
      assert.match(await toggle("active").getAttribute("aria-label"), /^Show \d+ subchats? of /);
      await open("active");
      assert.equal(
        await childCount("extra-0"),
        0,
        `${surface} keeps children collapsed when the parent opens`,
      );
      await toggle("active").click();
      await link("extra-0").waitFor();
      await link("extra-1").waitFor();
      assert.equal(await toggle("active").getAttribute("aria-expanded"), "true");
      assert.equal(
        await page.evaluate(() => globalThis.__rowInteractions.active),
        "active",
        `${surface} toggles subchats without navigating`,
      );
      await open("extra-0");
      assert.equal(await childCount("extra-1"), 1, `${surface} keeps siblings visible`);
      await open("callback");
      assert.equal(
        await childCount("extra-0"),
        1,
        `${surface} keeps a chosen family open after leaving it`,
      );
      await toggle("active").click();
      await frame();
      assert.equal(await childCount("extra-0"), 0, `${surface} collapses the family on demand`);
      checks.push(
        `${surface} expands subchats only on demand, keeps the choice across navigation and collapses on demand`,
      );

      if (surface === "Projects") {
        await toggle("active").click();
        await link("extra-0").waitFor();
        assert.equal(await childCount("extra-2"), 0, "Nested branches start closed");
        await toggle("extra-0").click();
        await link("extra-2").waitFor();
        await toggle("extra-0").click();
        await frame();
        assert.equal(await childCount("extra-2"), 0, "A nested branch collapses on demand");
        await toggle("active").click();
        await frame();
        checks.push("Projects expands and collapses nested branches independently");
      }

      await page.evaluate(() => {
        const fixture = globalThis.__rowInteractions;
        fixture.active = "extra-1";
        fixture.render();
      });
      await link("extra-1").waitFor();
      assert.equal(await link("extra-1").getAttribute("aria-current"), "page");
      await open("callback");
      assert.equal(
        await childCount("extra-0"),
        0,
        `${surface} closes a revealed family after leaving it`,
      );
      checks.push(
        `${surface} reveals a directly routed subchat even after a manual collapse and closes it after leaving`,
      );

      await open("active");
      await page.evaluate(() => {
        const fixture = globalThis.__rowInteractions;
        fixture.active = "extra-3";
        fixture.render();
      });
      await frame();
      assert.equal(
        await childCount("extra-0"),
        0,
        `${surface} collapses the previous family while the destination is absent`,
      );
      await page.evaluate(() => globalThis.__rowInteractions.patch("extra-3", { isHidden: false }));
      await link("extra-3").waitFor();
      assert.equal(await link("extra-3").getAttribute("aria-current"), "page");
      assert.equal(
        await childCount("extra-0"),
        1,
        `${surface} reveals the family when the destination arrives`,
      );
      await open("callback");
      await page.evaluate(() => globalThis.__rowInteractions.patch("extra-3", { isHidden: true }));
      checks.push(
        `${surface} collapses for an absent destination and reveals it when the snapshot arrives`,
      );
    }

    await page
      .locator('[data-feed-row="active"] > .ctf-row-surface > .ctf-row-main .ct-kids')
      .click();
    await page.locator('.ctf-kid[data-sidebar-thread-id="extra-0"]').waitFor();
    assert.ok(
      Number(
        await page.locator('[data-feed-row="active"] .ct-dot').first().getAttribute("data-agents"),
      ) >= 1,
    );
    assert.equal(
      await page.locator("[data-feed-row] > .ctf-kids-list ~ .ctf-row-detail").count(),
      0,
      "the working line stays directly under its parent, above the subchats",
    );
    checks.push(
      "Working children stay counted in the parent's spinner beside the subchat toggle, under the working line",
    );
  }

  if (process.env.OMNYO_TEST_SCREENSHOT && !childToggleOnly)
    await (subagentsOnly ? page.locator('main[data-omnyo-plugin="chat-topics"]') : page).screenshot(
      {
        path: process.env.OMNYO_TEST_SCREENSHOT,
      },
    );
  await page.evaluate(() => globalThis.__rowInteractions.close());
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      executedChecks: checks.length,
      mockedSaves: await requestCount(),
      productionWrites: 0,
      bundleSha256: createHash("sha256").update(bundle).digest("hex"),
    }),
  );
} catch (error) {
  console.error(JSON.stringify({ status: "failed", checks, executedChecks: checks.length }));
  throw error;
} finally {
  if (browserServer !== null) await browserServer.kill();
  else await browser.close();
}

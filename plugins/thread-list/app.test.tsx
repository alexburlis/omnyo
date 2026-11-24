// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PluginSidebarScope,
  PluginSidebarThreadsState,
  PluginThreadListProps,
} from "@omnyo/plugin-sdk/app";
import {
  loadPluginApp,
  renderSlot,
  type RenderSlotOptions,
} from "@omnyo/plugin-sdk/testing/app";
import {
  makePluginProject,
  makeSidebarThread,
  withDisabledWorkflowsSdk,
} from "./app/model/fixtures.js";
import {
  flushPreferenceWritesForTest,
  resetPreferencesSyncForTest,
  setPreferencesMirrorStorageForTest,
} from "./app/preferences/preferences-sync.js";
import {
  defaultPreferences,
  preferencesChangedSignalSchema,
  type PreferenceValues,
} from "./shared/preferences.js";

const app = await loadPluginApp(() => import("./app"));

const registration = app.threadLists[0];

if (!registration) throw new Error("thread-list slot not registered");

const PERSONAL_PROJECT_ID = "proj_personal";

const PROJECTS = [
  makePluginProject({
    id: PERSONAL_PROJECT_ID,
    name: "Personal",
    isPersonal: true,
  }),
  makePluginProject({ id: "proj_app", name: "App" }),
  makePluginProject({ id: "proj_web", name: "Web" }),
];

const SECTIONS = [
  { id: "sec_later", name: "Later", createdAt: 1, updatedAt: 1 },
  { id: "sec_review", name: "Review", createdAt: 2, updatedAt: 2 },
];

const THREADS = [
  makeSidebarThread({
    id: "thr_pinned",
    projectId: "proj_app",
    title: "Pinned thread",
    isPinned: true,
    pinnedAt: 10,
    pinSortKey: "a",
    createdAt: 10,
    updatedAt: 10,
    latestAttentionAt: 10,
  }),
  makeSidebarThread({
    id: "thr_parent",
    projectId: "proj_app",
    title: "Parent thread",
    createdAt: 8,
    updatedAt: 8,
    latestAttentionAt: 8,
  }),
  makeSidebarThread({
    id: "thr_child",
    projectId: "proj_app",
    title: "Child thread",
    parentThreadId: "thr_parent",
    createdAt: 7,
    updatedAt: 7,
    latestAttentionAt: 7,
  }),
  makeSidebarThread({
    id: "thr_later",
    projectId: "proj_web",
    title: "Later thread",
    sectionId: "sec_later",
    createdAt: 6,
    updatedAt: 6,
    latestAttentionAt: 6,
    host: { id: "host_laptop", name: "Laptop" },
    environment: {
      id: "env_web",
      name: null,
      branchName: "main",
      path: null,
      providerId: null,
      isWorktree: false,
      workspaceDisplayKind: "other",
    },
  }),
  makeSidebarThread({
    id: "thr_personal",
    projectId: PERSONAL_PROJECT_ID,
    title: "Personal thread",
    createdAt: 5,
    updatedAt: 5,
    latestAttentionAt: 5,
  }),
];

function props(scope?: PluginSidebarScope): PluginThreadListProps {
  return {
    activeThreadId: null,
    activeProjectId: null,
    isCompactViewport: false,
    ...(scope === undefined ? {} : { experimental_scope: scope }),
    onNavigate: vi.fn(),
    searchQuery: "",
  };
}

function renderList(
  preferences: Partial<PreferenceValues>,
  options: RenderSlotOptions = {},
  scope?: PluginSidebarScope,
) {
  return renderSlot(registration, props(scope), {
    sidebarThreads: {
      projects: PROJECTS,
      sections: SECTIONS,
      threads: THREADS,
    },
    rpc: {
      listPreferences: () => ({
        preferences: { ...defaultPreferences(), ...preferences },
      }),
      setPreference: (input: unknown) => {
        const { key, value } = preferencesChangedSignalSchema.parse(input);

        return { key, value };
      },
    },
    ...options,
    sdk: withDisabledWorkflowsSdk(options.sdk),
  });
}

function sectionHeaders(): string[] {
  return Array.from(
    document.querySelectorAll('[data-sidebar-sticky-tier="label"] [title]'),
    (element) => element.getAttribute("title") ?? "",
  );
}

function threadIds(): string[] {
  return Array.from(
    document.querySelectorAll("[data-sidebar-thread-id]"),
    (element) => element.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

afterEach(() => {
  cleanup();
  resetPreferencesSyncForTest();
  setPreferencesMirrorStorageForTest(undefined);
});

function selectedThreadIds(): string[] {
  const selected = screen.queryAllByRole("link", { name: /, selected$/u });

  return selected.map(
    (link) => link.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

describe("sidebar chat selection", () => {
  it("toggles individual rows, selects a displayed range, and keeps the split shortcut available", async () => {
    setPreferencesMirrorStorageForTest(null);

    const { inspection } = renderList({
      organizationMode: "chronological",
      collapsedSections: [],
    });

    const pinned = await screen.findByRole("link", {
      name: "Open Pinned thread",
    });

    const later = screen.getByRole("link", { name: "Open Later thread" });
    const personal = screen.getByRole("link", { name: "Open Personal thread" });

    expect(fireEvent.click(pinned, { metaKey: true })).toBe(false);
    expect(fireEvent.click(personal, { ctrlKey: true })).toBe(false);
    expect(selectedThreadIds()).toEqual(["thr_pinned", "thr_personal"]);
    expect(fireEvent.click(pinned, { metaKey: true })).toBe(false);
    expect(selectedThreadIds()).toEqual(["thr_personal"]);

    expect(fireEvent.click(later, { shiftKey: true })).toBe(false);
    const order = threadIds();
    expect(selectedThreadIds()).toEqual(
      order.slice(order.indexOf("thr_pinned"), order.indexOf("thr_later") + 1),
    );
    expect(inspection.navigateCalls).toEqual([]);

    fireEvent.keyDown(later, { key: "a", metaKey: true });
    expect(selectedThreadIds()).toEqual(order);
    fireEvent.keyDown(later, { key: "Escape" });
    expect(selectedThreadIds()).toEqual([]);

    expect(fireEvent.click(personal, { metaKey: true, altKey: true })).toBe(
      false,
    );
    expect(inspection.navigateCalls).toEqual([
      {
        method: "toThread",
        threadId: "thr_personal",
        options: { split: true },
      },
    ]);
  });

  it("selects a swept range during Shift-drag and preserves it on release", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderList({ organizationMode: "chronological" });

    const pinned = await screen.findByRole("link", {
      name: "Open Pinned thread",
    });

    const later = screen.getByRole("link", { name: "Open Later thread" });
    const personal = screen.getByRole("link", { name: "Open Personal thread" });

    const pointer = {
      pointerId: 1,
      pointerType: "mouse",
      buttons: 1,
      shiftKey: true,
    };

    expect(fireEvent.pointerDown(later, pointer)).toBe(false);
    fireEvent.pointerMove(personal, pointer);
    expect(selectedThreadIds()).toEqual(
      threadIds().slice(threadIds().indexOf("thr_later")),
    );

    fireEvent.pointerMove(pinned, pointer);
    expect(selectedThreadIds()).toEqual(
      threadIds().slice(0, threadIds().indexOf("thr_later") + 1),
    );
    fireEvent.pointerUp(pinned, { ...pointer, buttons: 0 });
    expect(fireEvent.click(pinned, { detail: 1 })).toBe(false);
    expect(selectedThreadIds()).toEqual(
      threadIds().slice(0, threadIds().indexOf("thr_later") + 1),
    );
    expect(inspection.navigateCalls).toEqual([]);

    expect(fireEvent.click(personal)).toBe(true);
    expect(selectedThreadIds()).toEqual([]);
  });
});

describe("thread-list plugin", () => {
  it.each([
    ["empty", true],
    ["empty", false],
    ["hidden", false],
    ["pinned", false],
  ] as const)(
    "with only %s threads, shows the project group when showEmptyProjects is %s",
    async (kind, showEmptyProjects) => {
      setPreferencesMirrorStorageForTest(null);
      renderList(
        { organizationMode: "project", showEmptyProjects },
        {
          sidebarThreads: {
            projects: PROJECTS,
            sections: [],
            threads: [
              ...THREADS.filter((thread) => thread.projectId === "proj_app"),
              ...(kind === "empty"
                ? []
                : [
                    makeSidebarThread({
                      id: "thr_web_only",
                      projectId: "proj_web",
                      title: "Web only",
                      isHidden: kind === "hidden",
                      isPinned: kind === "pinned",
                      pinnedAt: kind === "pinned" ? 10 : null,
                    }),
                  ]),
            ],
          },
        },
      );
      await screen.findByText("Parent thread");
      expect(sectionHeaders()).toContain("App");
      expect(sectionHeaders().includes("Web")).toBe(showEmptyProjects);
    },
  );

  it("shows the navigation skeleton until preferences load", () => {
    setPreferencesMirrorStorageForTest(null);
    renderSlot(registration, props(), {
      sdk: withDisabledWorkflowsSdk(),
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: THREADS,
      },
      rpc: { listPreferences: () => new Promise(() => undefined) },
    });
    expect(screen.getByLabelText("Loading sidebar navigation")).not.toBeNull();
    expect(threadIds()).toEqual([]);
  });

  it("renders pinned, custom sections, and loose threads in chronological mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderList({ organizationMode: "chronological" });

    await screen.findByText("Pinned thread");
    expect(rpcCalls.map((call) => call.method)).toEqual(["listPreferences"]);
    expect(sectionHeaders()).toEqual(["Pinned", "Later", "Review", "Threads"]);
    expect(threadIds()).toEqual([
      "thr_pinned",
      "thr_later",
      "thr_parent",
      "thr_child",
      "thr_personal",
    ]);
    expect(
      screen.queryByRole("button", { name: "Collapse Parent thread threads" }),
    ).toBeNull();
  });

  it("groups pinned worktree roots when environment grouping is enabled", async () => {
    setPreferencesMirrorStorageForTest(null);

    const environment = {
      id: "env_review",
      name: "Reviewer worktree group",
      branchName: "review",
      path: null,
      providerId: null,
      isWorktree: true,
      workspaceDisplayKind: "managed-worktree" as const,
    };

    const pinnedWorktreeThreads = [
      makeSidebarThread({
        id: "thr_worktree_a",
        projectId: "proj_app",
        title: "Worktree root A",
        pinnedAt: 20,
        pinSortKey: "a",
        environment,
      }),
      makeSidebarThread({
        id: "thr_worktree_b",
        projectId: "proj_app",
        title: "Worktree root B",
        pinnedAt: 19,
        pinSortKey: "b",
        environment,
      }),
    ];

    renderList(
      {
        organizationMode: "chronological",
        environmentGrouping: true,
      },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: [...THREADS, ...pinnedWorktreeThreads],
        },
      },
    );

    const environmentGroup = (
      await screen.findByText("Reviewer worktree group")
    ).closest("[data-sidebar-sticky-group]");

    expect(environmentGroup).not.toBeNull();
    expect(
      within(environmentGroup as HTMLElement).getByText("Worktree root A"),
    ).not.toBeNull();
    expect(
      within(environmentGroup as HTMLElement).getByText("Worktree root B"),
    ).not.toBeNull();
  });

  it("groups threads by machine in machine mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "machine" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "Laptop", "No machine"]);

    const laptop = screen
      .getByTitle("Laptop")
      .closest("[data-sidebar-sticky-group]");

    expect(laptop).not.toBeNull();
    expect(
      within(laptop as HTMLElement).getByText("Later thread"),
    ).not.toBeNull();

    const noMachine = screen
      .getByTitle("No machine")
      .closest("[data-sidebar-sticky-group]");

    expect(
      within(noMachine as HTMLElement).getByText("Personal thread"),
    ).not.toBeNull();
  });

  it("opens the composer on the machine named by its section", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { inspection } = renderList({ organizationMode: "machine" });

    fireEvent.click(
      await screen.findByRole("button", { name: "New thread in Laptop" }),
    );

    expect(inspection.navigateCalls).toContainEqual({
      method: "toCompose",
      options: {
        projectId: PERSONAL_PROJECT_ID,
        hostId: "host_laptop",
        placement: { sectionId: null, pinned: false },
        focusPrompt: true,
      },
    });
  });

  it("shows a machine section before it has any threads", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList(
      { organizationMode: "machine" },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: THREADS,
          experimental_hosts: [
            { id: "host_laptop", name: "Laptop" },
            { id: "host_empty", name: "Studio Mac" },
          ],
        },
      },
    );

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual([
      "Pinned",
      "Laptop",
      "Studio Mac",
      "No machine",
    ]);
  });

  it("groups threads by project in project mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "project" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "App", "Web", "Threads"]);

    const appGroup = screen
      .getByTitle("App")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;

    expect(within(appGroup).getByText("Parent thread")).not.toBeNull();
    expect(within(appGroup).getByText("Child thread")).not.toBeNull();

    const webGroup = screen
      .getByTitle("Web")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;

    expect(within(webGroup).getByText("Later thread")).not.toBeNull();

    const threadsGroup = screen
      .getByTitle("Threads")
      .closest("[data-sidebar-sticky-group]") as HTMLElement;

    expect(within(threadsGroup).getByText("Personal thread")).not.toBeNull();
  });

  it.each(["project", "chronological", "machine"] as const)(
    "lists only the scoped project's chats in %s mode",
    async (organizationMode) => {
      setPreferencesMirrorStorageForTest(null);
      renderList(
        { organizationMode },
        {},
        {
          kind: "project",
          projectId: "proj_app",
        },
      );

      await screen.findByText("Pinned thread");
      expect(threadIds()).toEqual(["thr_pinned", "thr_parent", "thr_child"]);
      expect(screen.queryByText("Later thread")).toBeNull();
      expect(screen.queryByText("Personal thread")).toBeNull();
    },
  );

  it("shows only the scoped project's group in project mode", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList(
      { organizationMode: "project" },
      {},
      {
        kind: "project",
        projectId: "proj_web",
      },
    );

    await screen.findByText("Later thread");
    expect(sectionHeaders()).toEqual(["Web"]);
    expect(threadIds()).toEqual(["thr_later"]);
  });

  it("lists Personal chats under Threads when Personal is the scope", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList(
      { organizationMode: "project" },
      {},
      {
        kind: "project",
        projectId: PERSONAL_PROJECT_ID,
      },
    );

    await screen.findByText("Personal thread");
    expect(sectionHeaders()).toEqual(["Threads"]);
    expect(threadIds()).toEqual(["thr_personal"]);
  });

  it("lists every project in the inbox scope", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "project" }, {}, { kind: "inbox" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "App", "Web", "Threads"]);
    expect(threadIds()).toEqual([
      "thr_pinned",
      "thr_parent",
      "thr_child",
      "thr_later",
      "thr_personal",
    ]);
  });

  it("starts new chats from a scoped list in the scoped project", async () => {
    setPreferencesMirrorStorageForTest(null);

    const { inspection } = renderList(
      { organizationMode: "chronological" },
      {},
      { kind: "project", projectId: "proj_app" },
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "New thread in Threads" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "New thread in Later section",
      }),
    );

    expect(inspection.navigateCalls).toEqual([
      {
        method: "toCompose",
        options: {
          projectId: "proj_app",
          placement: { sectionId: null, pinned: false },
          focusPrompt: true,
        },
      },
      {
        method: "toCompose",
        options: {
          projectId: "proj_app",
          placement: { sectionId: "sec_later", pinned: false },
          focusPrompt: true,
        },
      },
    ]);
  });

  it("keys its slot and preferences mirror by its own plugin id", async () => {
    window.localStorage.clear();
    expect(registration.id).toBe("thread-list");
    renderList({ organizationMode: "machine" }, { pluginId: "thread-list" });

    await screen.findByText("Pinned thread");
    expect(
      JSON.parse(
        window.localStorage.getItem("omnyo.thread-list.preferences.v1") ?? "{}",
      ).organizationMode,
    ).toBe("machine");
    window.localStorage.clear();
  });

  it.each([true, false])(
    "renders personal rows once with standard projects: %s",
    async (includeStandardProjects) => {
      setPreferencesMirrorStorageForTest(null);
      renderList(
        { organizationMode: "project" },
        {
          sidebarThreads: {
            projects: includeStandardProjects
              ? PROJECTS
              : PROJECTS.filter((project) => project.isPersonal),
            sections: [],
            threads: THREADS.filter(
              (thread) => thread.projectId === PERSONAL_PROJECT_ID,
            ),
          },
        },
      );

      await screen.findByTitle("Threads");
      expect(threadIds()).toEqual(["thr_personal"]);
      expect(sectionHeaders()).toEqual(
        includeStandardProjects ? ["App", "Web", "Threads"] : ["Threads"],
      );
    },
  );

  it("calls onNavigate when a thread row is opened", async () => {
    setPreferencesMirrorStorageForTest(null);
    const listProps = props();
    renderSlot(registration, listProps, {
      sdk: withDisabledWorkflowsSdk(),
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: THREADS,
      },
      rpc: {
        listPreferences: () => ({
          preferences: {
            ...defaultPreferences(),
            organizationMode: "chronological",
          },
        }),
      },
    });

    const link = await screen.findByRole("link", {
      name: "Open Personal thread",
    });

    link.click();
    await waitFor(() => expect(listProps.onNavigate).toHaveBeenCalledOnce());
  });
});

const SHELVED_THREADS = [
  makeSidebarThread({
    id: "thr_shelf_pinned",
    projectId: "proj_app",
    title: "Shelved pinned thread",
    pinnedAt: 12,
    pinSortKey: "b",
    experimental_shelvedAt: 30,
  }),
  makeSidebarThread({
    id: "thr_shelf_child",
    projectId: "proj_app",
    title: "Shelved child thread",
    parentThreadId: "thr_shelf_pinned",
    experimental_shelvedAt: 30,
  }),
  makeSidebarThread({
    id: "thr_shelf_sectioned",
    projectId: "proj_web",
    title: "Shelved sectioned thread",
    sectionId: "sec_later",
    host: { id: "host_laptop", name: "Laptop" },
    experimental_shelvedAt: 20,
  }),
  makeSidebarThread({
    id: "thr_shelf_personal",
    projectId: PERSONAL_PROJECT_ID,
    title: "Shelved personal thread",
    experimental_shelvedAt: 10,
  }),
];

const SHELF_ORDER = [
  "thr_shelf_pinned",
  "thr_shelf_child",
  "thr_shelf_sectioned",
  "thr_shelf_personal",
];

type ShelvedPaging = NonNullable<
  PluginSidebarThreadsState["experimental_shelved"]
>;

function shelvedPaging(overrides: Partial<ShelvedPaging> = {}): ShelvedPaging {
  return {
    status: "ready",
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage: async () => undefined,
    ...overrides,
  };
}

function renderShelfList(
  preferences: Partial<PreferenceValues>,
  experimental_shelved = shelvedPaging(),
  scope?: PluginSidebarScope,
) {
  return renderList(
    preferences,
    {
      sidebarThreads: {
        projects: PROJECTS,
        sections: SECTIONS,
        threads: [...THREADS, ...SHELVED_THREADS],
        experimental_shelved,
      },
    },
    scope,
  );
}

function shelfSection(): HTMLElement {
  const section = screen
    .getByTitle("Shelf")
    .closest("[data-sidebar-sticky-group]");

  if (!(section instanceof HTMLElement)) throw new Error("Shelf not rendered");

  return section;
}

function threadIdsIn(element: HTMLElement): string[] {
  return Array.from(
    element.querySelectorAll("[data-sidebar-thread-id]"),
    (row) => row.getAttribute("data-sidebar-thread-id") ?? "",
  );
}

describe("thread-list Shelf section", () => {
  it("starts folded at the end with its top-level count, then opens newest shelved first", async () => {
    setPreferencesMirrorStorageForTest(null);
    const { rpcCalls } = renderShelfList({ organizationMode: "chronological" });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual([
      "Pinned",
      "Later",
      "Review",
      "Threads",
      "Shelf",
    ]);
    expect(
      within(
        shelfSection().querySelector(
          '[data-sidebar-sticky-tier="label"]',
        ) as HTMLElement,
      ).getByText("3"),
    ).not.toBeNull();
    expect(threadIdsIn(shelfSection())).toEqual([]);

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Shelf section" }),
    );

    expect(threadIdsIn(shelfSection())).toEqual(SHELF_ORDER);
    await flushPreferenceWritesForTest();
    expect(rpcCalls.filter((call) => call.method === "setPreference")).toEqual([
      {
        method: "setPreference",
        input: {
          key: "shelfExpanded",
          value: true,
          origin: expect.any(String),
        },
      },
    ]);
  });

  it("leaves the Shelf out until a shelved thread loads", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList({ organizationMode: "chronological", shelfExpanded: true });

    await screen.findByText("Pinned thread");
    expect(sectionHeaders()).toEqual(["Pinned", "Later", "Review", "Threads"]);
    expect(screen.queryByText("Couldn’t load shelved threads")).toBeNull();
  });

  it("says when shelved threads fail to load", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderList(
      { organizationMode: "chronological" },
      {
        sidebarThreads: {
          projects: PROJECTS,
          sections: SECTIONS,
          threads: THREADS,
          experimental_shelved: shelvedPaging({ status: "error" }),
        },
      },
    );

    expect(
      await screen.findByText("Couldn’t load shelved threads"),
    ).not.toBeNull();
    expect(sectionHeaders()).not.toContain("Shelf");
  });

  it("pages more shelved threads only from the open Shelf", async () => {
    setPreferencesMirrorStorageForTest(null);
    const fetchNextPage = vi.fn(async () => undefined);
    renderShelfList(
      { organizationMode: "chronological" },
      shelvedPaging({ hasNextPage: true, fetchNextPage }),
    );

    await screen.findByText("Pinned thread");
    expect(
      screen.queryByRole("button", { name: "Load more shelved threads" }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Shelf section" }),
    );
    fireEvent.click(
      within(shelfSection()).getByRole("button", {
        name: "Load more shelved threads",
      }),
    );

    expect(fetchNextPage).toHaveBeenCalledOnce();
  });

  it.each(["project", "chronological", "machine"] as const)(
    "lists shelved threads only in the Shelf in %s mode",
    async (organizationMode) => {
      setPreferencesMirrorStorageForTest(null);
      renderShelfList({ organizationMode, shelfExpanded: true });

      await screen.findByText("Pinned thread");
      expect(sectionHeaders().at(-1)).toBe("Shelf");
      expect(threadIdsIn(shelfSection())).toEqual(SHELF_ORDER);
      expect(threadIds().filter((id) => SHELF_ORDER.includes(id))).toEqual(
        SHELF_ORDER,
      );
    },
  );

  it("shows a Shelf parent's child at once while grouped by read status", async () => {
    setPreferencesMirrorStorageForTest(null);

    const view = renderShelfList({
      organizationMode: "chronological",
      groupByReadStatus: true,
      shelfExpanded: true,
    });

    await screen.findByText("Shelved pinned thread");
    const shelved = threadIdsIn(shelfSection());

    expect(shelved.indexOf("thr_shelf_pinned")).toBeGreaterThanOrEqual(0);
    expect(shelved.indexOf("thr_shelf_child")).toBeGreaterThan(
      shelved.indexOf("thr_shelf_pinned"),
    );

    view.rerender(
      <registration.component {...props()} activeThreadId="thr_shelf_pinned" />,
    );

    await waitFor(() =>
      expect(threadIdsIn(shelfSection())).toContain("thr_shelf_child"),
    );
  });

  it("keeps a scoped Shelf to the scoped project's shelved threads", async () => {
    setPreferencesMirrorStorageForTest(null);
    renderShelfList(
      { organizationMode: "chronological", shelfExpanded: true },
      shelvedPaging(),
      { kind: "project", projectId: "proj_app" },
    );

    await screen.findByText("Pinned thread");
    expect(threadIdsIn(shelfSection())).toEqual([
      "thr_shelf_pinned",
      "thr_shelf_child",
    ]);
  });
});

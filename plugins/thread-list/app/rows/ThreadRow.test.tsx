// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultStore } from "jotai";
import { DndContext, useDraggable } from "@dnd-kit/core";
import { CompactViewportOverrideProvider } from "@/components/ui/hooks/use-compact-viewport";
import { useSidebarReorderDnd } from "@/components/ui/use-sidebar-reorder-dnd";
import { SidebarTouchSensor } from "../dnd/sidebarTouchSensor.js";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarRenameProvider } from "./SidebarInlineRename.js";
import type {
  PluginSidebarProject,
  PluginSidebarSplitLayout,
  PluginSidebarThread,
  PluginSidebarThreadRowStatus,
  PluginProvidersState,
  PluginThreadActionEntry,
} from "@omnyo/plugin-sdk/app";
import {
  installTestPluginRuntime,
  renderSlot,
  type PluginSdkTestFakes,
  type RenderedSlot,
  type TestThreadActionsResolver,
} from "@omnyo/plugin-sdk/testing/app";
import { experimental_threadIndicatorCases } from "@omnyo/plugin-sdk/testing";
import {
  getCollapsedChildActivity,
  NO_COLLAPSED_CHILD_ACTIVITY,
} from "../model/thread-activity.js";
import {
  makeSidebarEnvironment,
  makeSidebarThread,
  makeSidebarWork,
} from "../model/fixtures.js";
import { sidebarShowProviderIconsAtom } from "../preferences/atoms.js";
import { SidebarProjectNamesContext } from "../model/use-sidebar-data.js";
import type { ThreadRowOptions } from "./ThreadRow.js";
import {
  preferenceValueAtom,
  resetPreferencesSyncForTest,
} from "../preferences/preferences-sync.js";
import {
  CustomizeRowActionsContext,
  ThreadRowActionsCustomizingContext,
} from "../list/customizeRowActionsContext.js";

installTestPluginRuntime();

const { SidebarDraftPresenceSync } =
  await import("../list/sidebarDraftPresence.js");

const { ThreadRowNavigationProvider } =
  await import("./threadRowNavigation.js");

const {
  resetSidebarTitleDoubleClickForTest,
  SidebarProvidersContext,
  ThreadRow,
} = await import("./ThreadRow.js");

const DEFAULT_OPTIONS: ThreadRowOptions = {
  kind: "default",
  depth: 1,
  isChild: false,
  isCompact: false,
};

function createThread(
  overrides: Partial<PluginSidebarThread> = {},
): PluginSidebarThread {
  return makeSidebarThread({
    experimental_work: makeSidebarWork(),
    ...overrides,
  });
}

function nestedActivity(
  ...works: NonNullable<PluginSidebarThread["experimental_work"]>[]
) {
  return getCollapsedChildActivity(
    works.map((work, index) =>
      createThread({
        id: `nested-${index}`,
        parentThreadId: "parent",
        experimental_work: work,
        isUnread: false,
      }),
    ),
  );
}

it.each([false, true])(
  "places the chat creation time in the right actions slot, archived=%s",
  (archived) => {
    const createdAt = Date.now() - 48 * 86_400_000;
    renderThreadRow({
      thread: createThread({
        createdAt,
        lastMessageAt: Date.now(),
        archivedAt: archived ? 1 : null,
        isArchived: archived,
      }),
    });
    const trailing = document.querySelector("[data-sidebar-thread-trailing]");
    const time = trailing?.querySelector("time[data-sidebar-thread-age]");
    expect(time?.getAttribute("datetime")).toBe(
      new Date(createdAt).toISOString(),
    );
    expect(time?.textContent).toBe("1mo");
    expect(
      time
        ?.closest("[data-sidebar-thread-morph]")
        ?.querySelector('[aria-label="Thread actions"]'),
    ).toBeTruthy();
  },
);

it("describes a row with its subtitle while preserving the link name and hides it on sticky parents", () => {
  const thread = createThread({
    title: "Release",
    experimental_subtitle: "Needs you: review",
  });

  const row = renderThreadRow({ thread });
  const link = screen.getByRole("link", { name: "Open Release" });
  const subtitle = screen.getByText("Needs you: review");
  expect(link.getAttribute("aria-describedby")).toBe(subtitle.id);
  expect(subtitle.getAttribute("data-sidebar-thread-subtitle")).toBe("");
  row.unmount();
  renderThreadRow({
    thread,
    options: {
      kind: "parent",
      depth: 0,
      isChild: false,
      isCompact: false,
      childCount: 1,
      childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
      stickyLevel: 0,
    },
  });
  expect(screen.queryByText("Needs you: review")).toBeNull();
  expect(
    screen
      .getByRole("link", { name: "Open Release" })
      .getAttribute("aria-describedby"),
  ).toBeNull();
});

interface HarnessProps {
  thread: PluginSidebarThread;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  isCompactViewport?: boolean;
  crossProjectId?: string | null;
  isActive?: boolean;
  options?: ThreadRowOptions;
  onRowEvent?: () => void;
  onCustomizeRowActions?: (threadId: string) => void;
  onFinishCustomizingRowActions?: (restoreFocus: boolean) => void;
}

function ThreadRowHarness({
  thread,
  projects = [],
  providers = [],
  isCompactViewport,
  crossProjectId = null,
  isActive = false,
  options = DEFAULT_OPTIONS,
  onRowEvent,
  onCustomizeRowActions,
  onFinishCustomizingRowActions,
}: HarnessProps) {
  const row = (
    <ThreadRow
      thread={thread}
      crossProjectId={crossProjectId}
      isActive={isActive}
      options={options}
    />
  );

  const content = (
    <SidebarProjectNamesContext.Provider
      value={new Map(projects.map((project) => [project.id, project.name]))}
    >
      <SidebarProvidersContext.Provider value={providers}>
        <TooltipProvider>
          <SidebarDraftPresenceSync />
          <ThreadRowNavigationProvider>
            <SidebarRenameProvider>
              <CustomizeRowActionsContext.Provider
                value={onCustomizeRowActions ?? null}
              >
                <ThreadRowActionsCustomizingContext.Provider
                  value={
                    onFinishCustomizingRowActions
                      ? {
                          threadId: thread.id,
                          onDone: onFinishCustomizingRowActions,
                        }
                      : null
                  }
                >
                  <div
                    onPointerDown={onRowEvent}
                    onKeyDown={onRowEvent}
                    onClick={onRowEvent}
                  >
                    {row}
                  </div>
                </ThreadRowActionsCustomizingContext.Provider>
              </CustomizeRowActionsContext.Provider>
            </SidebarRenameProvider>
          </ThreadRowNavigationProvider>
        </TooltipProvider>
      </SidebarProvidersContext.Provider>
    </SidebarProjectNamesContext.Provider>
  );

  return isCompactViewport === undefined ? (
    content
  ) : (
    <CompactViewportOverrideProvider isCompactViewport={isCompactViewport}>
      {content}
    </CompactViewportOverrideProvider>
  );
}

interface RenderThreadRowArgs extends Omit<HarnessProps, "thread"> {
  thread?: PluginSidebarThread;
  hasComposerDraft?: boolean;
  hiddenDraftThreadIds?: string[];
  shortcutKey?: string;
  pluginStatus?: PluginSidebarThreadRowStatus;
  splitLayout?: PluginSidebarSplitLayout;
  projects?: PluginSidebarProject[];
  providers?: PluginProvidersState["providers"];
  sdk?: PluginSdkTestFakes;
  threadActions?: TestThreadActionsResolver;
}

function renderThreadRow({
  thread = createThread(),
  hasComposerDraft = false,
  hiddenDraftThreadIds = [],
  shortcutKey,
  pluginStatus,
  splitLayout,
  projects = [],
  providers = [],
  sdk,
  threadActions = hostThreadActions(),
  ...harness
}: RenderThreadRowArgs = {}): RenderedSlot & {
  rerenderThreadRow(nextThread: PluginSidebarThread): void;
} {
  const slot = renderSlot(
    { component: ThreadRowHarness },
    { thread, projects, providers, ...harness },
    {
      sidebarThreads: { threads: [thread], projects },
      providers: { providers },
      sidebarDraftThreadIds: [
        ...(hasComposerDraft ? [thread.id] : []),
        ...hiddenDraftThreadIds,
      ],
      sidebarRowStatuses: pluginStatus ? { [thread.id]: pluginStatus } : {},
      sidebarShortcuts: shortcutKey
        ? {
            [thread.id]: {
              label: `⌘${shortcutKey}`,
              ariaKeyshortcuts: `Meta+${shortcutKey}`,
            },
          }
        : {},
      sidebarSplitLayout: splitLayout,
      sdk,
      threadActions,
    },
  );

  return Object.assign(slot, {
    rerenderThreadRow(nextThread: PluginSidebarThread) {
      slot.lifecycle.rerender(
        <ThreadRowHarness
          thread={nextThread}
          projects={projects}
          providers={providers}
          {...harness}
        />,
      );
    },
  });
}

function twoPaneLayout(threadId: string): PluginSidebarSplitLayout {
  return {
    panes: [
      {
        paneId: "pane-thread",
        rect: { x: 0, y: 0, width: 0.5, height: 1 },
        threadId,
        isFocused: true,
      },
      {
        paneId: "pane-compose",
        rect: { x: 0.5, y: 0, width: 0.5, height: 1 },
        threadId: null,
        isFocused: false,
      },
    ],
  };
}

function renderSplitThreadRow(args: RenderThreadRowArgs = {}) {
  const thread = args.thread ?? createThread();

  return renderThreadRow({
    ...args,
    thread,
    splitLayout: twoPaneLayout(thread.id),
  });
}

function renderedIndicators(): Array<string | null> {
  return Array.from(
    document.querySelectorAll("[data-thread-status-glyph]"),
    (glyph) => glyph.getAttribute("data-thread-status-glyph"),
  );
}

function statusGlyph(): HTMLElement {
  const glyph = document.querySelector<HTMLElement>(
    "[data-thread-status-glyph]",
  );

  if (!glyph) {
    throw new Error("Expected a thread status glyph");
  }

  return glyph;
}

function openActionsMenu() {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Thread actions" }),
    {
      button: 0,
    },
  );
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

interface RanThreadAction {
  key: string;
  threadId: string;
}

function hostThreadActions({
  ran = [],
  archiveRun,
}: {
  ran?: RanThreadAction[];
  archiveRun?: () => Promise<void>;
} = {}): TestThreadActionsResolver {
  return (thread, { requestRename }) => {
    const entry = (
      key: string,
      label: string,
      icon: string,
      run: () => Promise<void> = async () => {
        ran.push({ key, threadId: thread.id });
      },
    ): PluginThreadActionEntry => ({
      key,
      pluginId: key.split("/")[0] ?? "omnyo--core",
      group: "2_organize",
      action: {
        label,
        icon,
        run: () => run().catch(() => undefined),
      },
    });

    const isArchived = thread.archivedAt !== null;

    return [
      entry("omnyo--core/copyLink", "Copy thread link", "Copy"),
      entry(
        "omnyo--core/pin",
        thread.pinnedAt === null ? "Pin" : "Unpin",
        thread.pinnedAt === null ? "Pin" : "PinOff",
      ),
      ...(thread.parentThreadId === null && !isArchived
        ? [
            entry(
              "omnyo--core/shelve",
              thread.shelvedAt === null ? "Shelve" : "Unshelve",
              "Layers",
            ),
            entry("thread-list/move", "Move to section", "SectionMove"),
          ]
        : []),
      entry("omnyo--core/rename", "Rename", "Edit", async () => {
        requestRename(thread.id);
      }),
      entry(
        "omnyo--core/archive",
        isArchived ? "Unarchive" : "Archive",
        isArchived ? "ArchiveRestore" : "Archive",
        archiveRun,
      ),
    ];
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetSidebarTitleDoubleClickForTest();
  resetPreferencesSyncForTest();
});

describe("ThreadRow", () => {
  it("shows the registered provider icon by default and keeps it visible during inline rename", async () => {
    const provider: PluginProvidersState["providers"][number] = {
      id: "provider-test",
      pluginId: "provider-test",
      displayName: "Test Provider",
      logoUrl: "/provider-test.svg",
      available: true,
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsThreadArchive: true,
        supportsThreadRename: true,
        supportsServiceTier: false,
        supportsNativeUserQuestion: false,
        supportsFork: true,
        supportsSessionRewind: false,
        modelCatalogScope: "workspace",
        permissionModes: ["accept-edits", "auto", "full"],
      },
      composerActions: [],
      completedTurnDisplay: "collapse",
    };

    const slot = renderThreadRow({ providers: [provider] });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(
      slot.container.querySelector('[data-provider-logo="/provider-test.svg"]'),
    ).toBeTruthy();

    fireEvent.doubleClick(screen.getByText("Thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "Scratch name" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByRole("img", { name: "Test Provider" })).toBeTruthy();
    expect(slot.inspection.navigateCalls).toEqual([]);

    slot.rerenderThreadRow(createThread({ providerId: "missing" }));
    expect(screen.queryByRole("img", { name: "Test Provider" })).toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();

    slot.rerenderThreadRow(createThread());
    act(() => getDefaultStore().set(sidebarShowProviderIconsAtom, false));
    expect(
      slot.container.querySelector("[data-sidebar-thread-provider]"),
    ).toBeNull();
  });

  it("links the row to the thread href and leaves a plain click to the host", () => {
    const slot = renderThreadRow({
      thread: createThread({ href: "/projects/proj_test/threads/thr_test" }),
    });

    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link.getAttribute("href")).toBe(
      "/projects/proj_test/threads/thr_test",
    );
    expect(link.getAttribute("data-sidebar-thread-shortcut-target")).toBe("");
    expect(link.getAttribute("data-sidebar-thread-id")).toBe("thr_test");
    expect(link.getAttribute("data-sidebar-rename-anchor")).toBe("");
    expect(link.closest("[data-sidebar-rename-row]")).not.toBeNull();
    fireEvent.click(link);
    expect(slot.inspection.navigateCalls).toEqual([]);
  });

  it("prefetches only after sustained mouse or keyboard intent and cancels abandoned intent", () => {
    vi.useFakeTimers();

    try {
      const slot = renderThreadRow();
      const link = screen.getByRole("link", { name: "Open Thread" });

      const prefetchCall = {
        method: "experimental_prefetchThreadOpen",
        threadId: "thr_test",
      };

      const prefetchCalls = () =>
        slot.inspection.navigateCalls.filter(
          (call) => String(call.method) === prefetchCall.method,
        );

      fireEvent.pointerEnter(link, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(99));
      expect(prefetchCalls()).toEqual([]);
      fireEvent.pointerLeave(link, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(1));
      expect(prefetchCalls()).toEqual([]);

      fireEvent.focus(link);
      act(() => vi.advanceTimersByTime(100));
      expect(prefetchCalls()).toEqual([prefetchCall]);

      fireEvent.blur(link);
      fireEvent.pointerEnter(link, { pointerType: "touch" });
      act(() => vi.advanceTimersByTime(100));
      expect(prefetchCalls()).toEqual([prefetchCall]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels row prefetch intent when a press or row action begins", () => {
    vi.useFakeTimers();

    try {
      const slot = renderThreadRow({
        thread: createThread({ archivedAt: 1, isArchived: true }),
      });

      const link = screen.getByRole("link", { name: "Open Thread" });
      const restore = screen.getByRole("button", { name: "Unarchive" });

      const prefetchCalls = () =>
        slot.inspection.navigateCalls.filter(
          (call) => String(call.method) === "experimental_prefetchThreadOpen",
        );

      fireEvent.pointerEnter(link, { pointerType: "mouse" });
      fireEvent.pointerDown(link, { button: 0, pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(100));
      fireEvent.pointerEnter(restore, { pointerType: "mouse" });
      act(() => vi.advanceTimersByTime(100));
      expect(prefetchCalls()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["meta", { metaKey: true }],
    ["ctrl", { ctrlKey: true }],
  ])("opens the thread in a split on %s-click", (_label, modifier) => {
    const slot = renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const event = fireEvent.click(link, modifier);
    expect(event).toBe(false);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it("opens the thread in a split on meta-click of the explained status glyph", () => {
    const slot = renderThreadRow({
      thread: createThread({ experimental_work: makeSidebarWork("working") }),
    });

    const glyph = document.querySelector("[data-status-reason]");

    expect(glyph).not.toBeNull();

    if (glyph === null) return;
    fireEvent.click(glyph, { metaKey: true });
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it("keeps desktop restore available, hides it on mobile, and blocks row event propagation", async () => {
    const thread = createThread({ archivedAt: 1, isArchived: true });
    const rowEvent = vi.fn();
    const ran: RanThreadAction[] = [];
    renderThreadRow({
      thread,
      onRowEvent: rowEvent,
      threadActions: hostThreadActions({ ran }),
    });
    const restore = screen.getByRole("button", { name: "Unarchive" });
    expect(restore.querySelector('[data-icon="ArchiveRestore"]')).toBeTruthy();
    expect(restore.closest("[data-sidebar-hover-actions-open]")).toBeNull();
    expect(
      restore.closest(".\\[\\@media\\(hover\\:none\\)\\]\\:hidden"),
    ).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    fireEvent.pointerDown(restore, { pointerType: "touch", button: 0 });
    fireEvent.keyDown(restore, { key: "Enter" });
    fireEvent.click(restore);
    await waitFor(() =>
      expect(ran).toEqual([
        { key: "omnyo--core/archive", threadId: "thr_test" },
      ]),
    );
    expect(rowEvent).not.toHaveBeenCalled();
  });

  it.each([
    {
      lifecycle: "active",
      shelvedAt: null,
      quickActions: ["Pin", "Archive"],
      glyphs: ["open"],
      emphasized: true,
    },
    {
      lifecycle: "shelved",
      shelvedAt: 1,
      quickActions: ["Unshelve"],
      glyphs: [],
      emphasized: false,
    },
  ])(
    "gives an unread $lifecycle row its quick actions, status glyph, and title weight",
    ({ shelvedAt, quickActions, glyphs, emphasized }) => {
      getDefaultStore().set(preferenceValueAtom("rowActions"), [
        "omnyo--core/pin",
        "omnyo--core/archive",
      ]);

      const { container } = renderThreadRow({
        thread: createThread({ experimental_shelvedAt: shelvedAt }),
      });

      expect(
        Array.from(
          container.querySelectorAll("[data-sidebar-thread-trailing] button"),
          (button) => button.getAttribute("aria-label"),
        ).filter((label) => label !== "Thread actions"),
      ).toEqual(quickActions);
      expect(renderedIndicators()).toEqual(glyphs);
      expect(
        container
          .querySelector(".omnyo-thread-title")
          ?.classList.contains("font-semibold"),
      ).toBe(emphasized);
    },
  );

  it("runs the core shelve action from a shelved row's Unshelve", async () => {
    const ran: RanThreadAction[] = [];
    renderThreadRow({
      thread: createThread({ experimental_shelvedAt: 1 }),
      threadActions: hostThreadActions({ ran }),
    });
    fireEvent.click(screen.getByRole("button", { name: "Unshelve" }));
    await waitFor(() =>
      expect(ran).toEqual([
        { key: "omnyo--core/shelve", threadId: "thr_test" },
      ]),
    );
  });

  it("disables a row action button while its run is in flight and recovers when it fails", async () => {
    const pending = deferred();
    const archiveRun = vi.fn(() => pending.promise);
    renderThreadRow({
      thread: createThread({ archivedAt: 1, isArchived: true }),
      threadActions: hostThreadActions({ archiveRun }),
    });

    const restore = screen.getByRole<HTMLButtonElement>("button", {
      name: "Unarchive",
    });

    expect(restore.disabled).toBe(false);
    fireEvent.click(restore);
    await waitFor(() => expect(restore.disabled).toBe(true));
    fireEvent.click(restore);
    expect(archiveRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.reject(new Error("Unarchive failed"));
      await pending.promise.catch(() => undefined);
    });
    await waitFor(() => expect(restore.disabled).toBe(false));
  });

  it("shows the configured row actions in order and reserves their width", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "omnyo--core/pin",
      "omnyo--core/copyLink",
      "omnyo--core/archive",
    ]);
    const ran: RanThreadAction[] = [];
    renderThreadRow({ threadActions: hostThreadActions({ ran }) });
    const controls = document.querySelector("[data-sidebar-row-controls]");
    expect(
      Array.from(controls?.querySelectorAll("button") ?? []).map((button) =>
        button.getAttribute("aria-label"),
      ),
    ).toEqual(["Pin", "Copy thread link", "Archive", "Thread actions"]);
    expect(
      document
        .querySelector<HTMLElement>(".omnyo-sidebar-hover-actions-inset")
        ?.style.getPropertyValue("--omnyo-sidebar-hover-actions-inset"),
    ).toBe("calc(var(--spacing) * 22.5)");
    fireEvent.click(screen.getByRole("button", { name: "Pin" }));
    await waitFor(() =>
      expect(ran).toEqual([{ key: "omnyo--core/pin", threadId: "thr_test" }]),
    );
  });

  it("skips row action keys that have no action for the thread", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "thread-list/move",
      "plugin-gone/action",
      "omnyo--core/archive",
    ]);
    renderThreadRow({
      thread: createThread({ parentThreadId: "thr_parent" }),
    });
    expect(
      screen.queryByRole("button", { name: "Move to section" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(
      document
        .querySelector<HTMLElement>(".omnyo-sidebar-hover-actions-inset")
        ?.style.getPropertyValue("--omnyo-sidebar-hover-actions-inset"),
    ).toBe("calc(var(--spacing) * 7.5)");
  });

  it("shows only the actions menu when every row action is turned off", () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), []);
    renderThreadRow();
    expect(screen.queryByRole("button", { name: "Archive" })).toBeNull();
    expect(screen.getByRole("button", { name: "Thread actions" })).toBeTruthy();
    expect(
      document
        .querySelector<HTMLElement>(".omnyo-sidebar-hover-actions-inset")
        ?.style.getPropertyValue("--omnyo-sidebar-hover-actions-inset"),
    ).toBe("calc(var(--spacing) * 0)");
  });

  it.each([
    [[]],
    [["omnyo--core/pin", "omnyo--core/copyLink", "omnyo--core/archive"]],
  ] as const)(
    "reserves one action for an archived row whatever the row actions (%j)",
    (rowActions) => {
      getDefaultStore().set(preferenceValueAtom("rowActions"), [...rowActions]);
      renderThreadRow({
        thread: createThread({ archivedAt: 1, isArchived: true }),
      });
      expect(
        document
          .querySelector<HTMLElement>(".omnyo-sidebar-hover-actions-inset")
          ?.style.getPropertyValue("--omnyo-sidebar-hover-actions-inset"),
      ).toBe("calc(var(--spacing) * 7.5)");
    },
  );

  it("starts the inline rename directly from a Rename row action", async () => {
    getDefaultStore().set(preferenceValueAtom("rowActions"), [
      "omnyo--core/rename",
    ]);
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });

  it.each(["dropdown", "context"] as const)(
    "adds Customize row actions to the %s menu",
    async (surface) => {
      const customize = vi.fn();
      renderThreadRow({ onCustomizeRowActions: customize });

      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }

      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Customize row actions" }),
      );
      expect(customize).toHaveBeenCalledWith("thr_test");
    },
  );

  it("leaves Customize row actions out when the list cannot customize", async () => {
    renderThreadRow();
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    await screen.findByRole("menuitem", { name: "Rename" });
    expect(
      screen.queryByRole("menuitem", { name: "Customize row actions" }),
    ).toBeNull();
  });

  it("customizes row actions on the real row until Done", () => {
    const finish = vi.fn();
    renderThreadRow({ onFinishCustomizingRowActions: finish });
    expect(screen.getByRole("link", { name: "Open Thread" })).toBeTruthy();
    expect(
      document
        .querySelector("[data-sidebar-thread-trailing]")
        ?.classList.contains("hidden"),
    ).toBe(true);
    expect(screen.getByRole("group", { name: "Row actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(finish).toHaveBeenCalledWith(true);
  });

  it.each(["dropdown", "context"] as const)(
    "starts an inline rename once the %s menu has closed",
    async (surface) => {
      renderThreadRow();

      if (surface === "dropdown") {
        fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
      } else {
        fireEvent.contextMenu(
          screen.getByRole("link", { name: "Open Thread" }),
        );
      }

      fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
      const input = await screen.findByRole("textbox", { name: "Thread name" });
      expect(input).toHaveProperty("value", "Thread");
    },
  );

  it("suppresses the context menu while the title is being edited", async () => {
    renderThreadRow();
    fireEvent.doubleClick(screen.getByText("Thread"));
    await screen.findByRole("textbox", { name: "Thread name" });
    expect(
      screen
        .getByTestId("omnyo-thread-actions-context-menu")
        .getAttribute("data-disabled"),
    ).toBe("true");
  });

  const splitWorkingCases = [
    {
      label: "server Working",
      thread: createThread({ experimental_work: makeSidebarWork("working") }),
    },
    {
      label: "required input with independent work",
      thread: createThread({ experimental_work: makeSidebarWork("needs-you") }),
    },
    {
      label: "work continuing alongside an unread failure",
      thread: createThread({
        status: "error",
        experimental_work: makeSidebarWork("working"),
      }),
    },
  ];

  it.each(splitWorkingCases)(
    "shimmers the split map for $label",
    ({ thread }) => {
      const { container } = renderSplitThreadRow({ thread });

      const splitMap = screen.getByRole("img", { name: /open in split/ });
      expect(Array.from(splitMap.classList)).toContain("animate-shine-icon");
      expect(
        splitMap.closest("[data-sidebar-thread-trailing-indicator]"),
      ).not.toBeNull();
      expect(container.querySelector("[data-thread-status-glyph]")).toBeNull();
    },
  );

  it.each([
    ["idle", createThread()],
    ["unread error only", createThread({ status: "error" })],
  ])("keeps the split map static for %s", (_label, thread) => {
    renderSplitThreadRow({ thread });

    const splitMap = screen.getByRole("img", { name: /open in split/ });
    expect(Array.from(splitMap.classList)).not.toContain("animate-shine-icon");
  });

  it("marks the row as open in a split and omits the map when the thread is in no pane", () => {
    const { container, unmount } = renderSplitThreadRow();
    expect(
      container.querySelector(".omnyo-sidebar-open-in-split-row"),
    ).not.toBeNull();
    unmount();

    const other = renderThreadRow({ splitLayout: twoPaneLayout("thr_other") });
    expect(screen.queryByRole("img", { name: /open in split/ })).toBeNull();
    expect(
      other.container.querySelector(".omnyo-sidebar-open-in-split-row"),
    ).toBeNull();
  });

  it.each([
    {
      label: "pending input",
      expectedStatus: makeSidebarWork("needs-you").primary.reason.text,
      thread: createThread({
        hasPendingInteraction: true,
        experimental_work: makeSidebarWork("needs-you"),
      }),
    },
    {
      label: "unread error",
      expectedStatus: makeSidebarWork("blocked").primary.reason.text,
      thread: createThread({
        status: "error",
        experimental_work: makeSidebarWork("blocked"),
      }),
    },
    {
      label: "plugin status",
      expectedStatus: "Plugin improving draft",
      pluginStatus: {
        icon: "AiContentGenerator01" as const,
        label: "Plugin improving draft",
      },
      thread: createThread(),
    },
    {
      label: "child workflow",
      expectedStatus: makeSidebarWork("working").primary.reason.text,
      options: {
        kind: "parent" as const,
        depth: 1,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: nestedActivity(makeSidebarWork("working")),
      },
      thread: createThread({ lastReadAt: 1 }),
    },
  ])(
    "preserves the $label status in the split map accessible name",
    ({ expectedStatus, options, pluginStatus, thread }) => {
      renderSplitThreadRow({ options, pluginStatus, thread });

      expect(
        screen
          .getByRole("img", { name: /open in split/ })
          .getAttribute("aria-label"),
      ).toBe(`Thread — open in split; ${expectedStatus}`);
    },
  );

  it.each([
    ["unread success", createThread(), true],
    ["unread error", createThread({ status: "error" }), true],
    ["read", createThread({ lastReadAt: 1, latestAttentionAt: 1 }), false],
  ])("emphasizes the title only for %s rows", (_label, thread, emphasized) => {
    const { container } = renderThreadRow({ thread });

    const title = container.querySelector(".omnyo-thread-title");
    expect(title?.classList.contains("font-semibold")).toBe(emphasized);
  });

  it("puts the draft glyph in the trailing status slot", () => {
    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    const draftGlyph = statusGlyph();
    expect(draftGlyph.getAttribute("data-thread-status-glyph")).toBe("draft");
    expect(draftGlyph.hasAttribute("data-hide-idle-draft-label")).toBe(true);
    expect(
      draftGlyph.closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread (unsubmitted draft)" }),
    ).not.toBeNull();
  });

  it("passes a plugin status over the draft glyph and drops it without one", () => {
    const withStatus = renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });

    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    withStatus.unmount();

    renderThreadRow({
      hasComposerDraft: true,
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
    });
    expect(statusGlyph().getAttribute("data-thread-status-glyph")).toBe(
      "draft",
    );
    expect(statusGlyph().hasAttribute("data-row-status")).toBe(false);
  });

  it("replaces the working spinner with a static Stopping glyph while the turn stops", () => {
    renderThreadRow({
      thread: createThread({
        status: "stopping",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    expect(renderedIndicators()).toEqual(["none"]);
    expect(statusGlyph().getAttribute("data-row-status")).toBe("Stopping");
  });

  it("shows a keyboard shortcut in place of a plugin status", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      shortcutKey: "3",
    });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(renderedIndicators()).toEqual([]);
  });

  it("shows a keyboard shortcut in place of a split mini-map", () => {
    renderSplitThreadRow({ shortcutKey: "3" });

    expect(screen.getByText("⌘3")).not.toBeNull();
    expect(screen.queryByRole("img", { name: /open in split/ })).toBeNull();
  });

  it("passes the plugin status tone through to the status glyph", () => {
    renderThreadRow({
      hasComposerDraft: true,
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
        tone: "success",
      },
    });

    expect(statusGlyph().getAttribute("data-row-status")).toBe(
      "Plugin improving draft",
    );
    expect(statusGlyph().getAttribute("data-row-status-tone")).toBe("success");
  });

  it("passes the row thread's running subagents to its trailing glyph", () => {
    renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_work: makeSidebarWork("working"),
        activity: {
          workflows: 0,
          backgroundAgents: 1,
          backgroundCommands: 0,
          planMode: 0,
          goals: 0,
          experimental_subagents: 3,
        },
      }),
    });

    expect(statusGlyph().getAttribute("data-subagents")).toBe("3");
    expect(
      statusGlyph().closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
  });

  it("passes no subagents when the host omits the count", () => {
    renderThreadRow({
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    expect(statusGlyph().getAttribute("data-subagents")).toBe("0");
  });

  it("keeps the runtime indicator ahead of a plugin status", () => {
    renderThreadRow({
      pluginStatus: {
        icon: "AiContentGenerator01",
        label: "Plugin improving draft",
      },
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    expect(renderedIndicators()).toEqual(["runtime"]);
    expect(
      statusGlyph().closest("[data-sidebar-thread-trailing-indicator]"),
    ).not.toBeNull();
  });

  it.each([true, false] as const)(
    "keeps the working-draft indicator ahead of the runtime indicator when isActive=%s",
    (isActive) => {
      renderThreadRow({
        hasComposerDraft: true,
        isActive,
        thread: createThread({
          status: "active",
          runtimeStatus: "active",
          experimental_work: makeSidebarWork("working"),
        }),
      });

      expect(renderedIndicators()).toEqual(["working-draft"]);
    },
  );

  it("renders the host title component and labels the row with the resolved display title", () => {
    const { container } = renderThreadRow({
      thread: createThread({
        title: "Compare @thread:thr_mentioned in @project:proj_mentioned",
        titleFallback:
          "Compare @thread:thr_mentioned in @project:proj_mentioned",
        displayTitle: "Compare Mention target in Mention project",
      }),
    });

    expect(
      container.querySelector('[data-thread-title="thr_test"]')?.textContent,
    ).toBe("Compare Mention target in Mention project");
    expect(
      screen.getByRole("link", {
        name: "Open Compare Mention target in Mention project",
      }),
    ).not.toBeNull();
    expect(
      screen.getByTitle("Compare Mention target in Mention project"),
    ).not.toBeNull();
    expect(screen.queryByText(/@thread:thr_mentioned/)).toBeNull();
  });

  it("marks a child from another project with the project name", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      projects: [
        {
          id: "proj_other",
          name: "Web App",
          isPersonal: false,
          href: "/projects/proj_other",
          settingsHref: "/projects/proj_other/settings",
        },
      ],
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });

    const marker = container.querySelector(
      "[data-sidebar-thread-cross-project]",
    );

    expect(marker?.getAttribute("aria-label")).toBe("In project Web App");
    expect(marker?.querySelector('[data-icon="FolderExport"]')).not.toBeNull();
    expect(
      marker?.parentElement?.previousElementSibling?.querySelector(
        ".omnyo-thread-title",
      ),
    ).not.toBeNull();
    expect(
      marker?.closest("[data-sidebar-thread-trailing-indicator]"),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Open Thread" }).getAttribute("href"),
    ).toBe("/projects/proj_other/threads/thr_test");
  });

  it("falls back to a generic label when the other project is unknown", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_unknown",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_unknown",
      }),
    });

    expect(
      container
        .querySelector("[data-sidebar-thread-cross-project]")
        ?.getAttribute("aria-label"),
    ).toBe("In another project");
  });

  it("opens the thread when the cross-project marker is clicked", () => {
    const { container } = renderThreadRow({
      crossProjectId: "proj_other",
      thread: createThread({
        parentThreadId: "thr_parent",
        projectId: "proj_other",
      }),
    });

    const link = screen.getByRole("link", { name: "Open Thread" });
    const onLinkClick = vi.fn();
    link.addEventListener("click", onLinkClick);

    fireEvent.click(
      container.querySelector("[data-sidebar-thread-cross-project]")!,
    );

    expect(onLinkClick).toHaveBeenCalledTimes(1);
  });

  it("omits the cross-project marker for same-project rows", () => {
    const { container } = renderThreadRow({});
    expect(
      container.querySelector("[data-sidebar-thread-cross-project]"),
    ).toBeNull();
  });

  it("shows the needs-input indicator when the thread needs user input", () => {
    renderThreadRow({
      thread: createThread({
        hasPendingInteraction: true,
        experimental_work: makeSidebarWork("needs-you"),
      }),
    });

    expect(renderedIndicators()).toEqual(["waiting-for-input"]);
  });

  it.each([false, true])(
    "keeps a nested chat's required input off the parent row, own input: %s",
    (ownInput) => {
      renderThreadRow({
        thread: createThread({
          hasPendingInteraction: ownInput,
          experimental_work: makeSidebarWork(ownInput ? "needs-you" : "open"),
          lastReadAt: 1,
          latestAttentionAt: 1,
        }),
        options: {
          kind: "parent",
          depth: 1,
          isChild: false,
          isCompact: false,
          childCount: 1,
          childActivity: nestedActivity(makeSidebarWork("needs-you")),
        },
      });
      expect(renderedIndicators()).toEqual([
        ownInput ? "waiting-for-input" : "open",
      ]);
    },
  );

  it("clocks a thread with queued work, and drops the clock once it runs", () => {
    const { rerenderThreadRow } = renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    expect(renderedIndicators()).toEqual(["runtime"]);

    rerenderThreadRow(
      createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "waiting",
        experimental_work: makeSidebarWork("working"),
        runtimeStatus: "active",
      }),
    );
    expect(renderedIndicators()).toEqual(["runtime"]);
  });

  it("keeps queued work separate from unreadness", () => {
    renderThreadRow({
      thread: createThread({
        status: "idle",
        lastReadAt: 1_000,
        latestAttentionAt: 2_000,
        queuedWork: "waiting",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    expect(renderedIndicators()).toEqual(["runtime"]);
  });

  it("tells a failed queued row apart from a failed thread", () => {
    renderThreadRow({
      thread: createThread({
        lastReadAt: 1,
        latestAttentionAt: 1,
        queuedWork: "failed",
        experimental_work: makeSidebarWork("blocked"),
      }),
    });
    expect(renderedIndicators()).toEqual(["dependency-failed"]);

    cleanup();
    renderThreadRow({
      thread: createThread({
        status: "error",
        experimental_work: makeSidebarWork("blocked"),
        lastReadAt: 0,
        latestAttentionAt: 10,
      }),
    });
    expect(renderedIndicators()).toEqual(["dependency-failed"]);
  });

  it("routes a tap on the bare row through its navigation link", () => {
    renderThreadRow();
    const link = screen.getByRole("link", { name: "Open Thread" });
    const row = link.closest("[data-sidebar-rename-row]");
    expect(row).not.toBeNull();
    const clickLink = vi.spyOn(link, "click");

    fireEvent.click(row!);
    expect(clickLink).toHaveBeenCalledOnce();

    fireEvent.click(row!.querySelector("[data-sidebar-thread-trailing]")!);
    expect(clickLink).toHaveBeenCalledTimes(2);

    fireEvent.click(link);
    expect(clickLink).toHaveBeenCalledTimes(2);
  });

  it("does not route a suppressed drag click on the trailing area", () => {
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        consumeClickSuppression: vi.fn(() => true),
      },
    });
    const link = screen.getByRole("link", { name: "Open Thread" });
    const clickLink = vi.spyOn(link, "click");

    const trailing = link
      .closest("[data-sidebar-rename-row]")
      ?.querySelector("[data-sidebar-thread-trailing]");

    expect(trailing).not.toBeNull();

    fireEvent.click(trailing!);
    expect(clickLink).not.toHaveBeenCalled();
  });

  it("renders a sticky parent tier with its guide line", () => {
    const { container } = renderThreadRow({
      options: {
        kind: "parent",
        depth: 2,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: NO_COLLAPSED_CHILD_ACTIVITY,
        stickyLevel: 1,
      },
    });

    const tier = container.querySelector<HTMLElement>(
      '[data-sidebar-sticky-tier="parent"]',
    );

    expect(tier).not.toBeNull();
    expect(
      tier?.style.getPropertyValue("--omnyo-sidebar-sticky-parent-level"),
    ).toBe("1");
    expect(tier?.style.paddingLeft).toBe("56px");
    expect(tier?.querySelector('[aria-hidden="true"].w-px')).not.toBeNull();
  });

  it("shows its Command shortcut in place of an active indicator", () => {
    renderThreadRow({
      shortcutKey: "3",
      thread: createThread({
        status: "active",
        runtimeStatus: "active",
        experimental_work: makeSidebarWork("working"),
      }),
    });

    const shortcut = screen.getByText("⌘3");
    expect(shortcut.className).toContain("px-1.5");
    expect(shortcut.className).toContain("py-1");
    expect(shortcut.className).toContain("opacity-60");
    expect(renderedIndicators()).toEqual([]);
    expect(
      screen
        .getByRole("link", { name: "Open Thread" })
        .getAttribute("aria-keyshortcuts"),
    ).toBe("Meta+3");
  });

  it.each(experimental_threadIndicatorCases)(
    "renders row work: $name",
    ({ state, expected }) => {
      renderThreadRow({
        thread: createThread({ experimental_work: state.work }),
        hasComposerDraft: state.hasUnsubmittedDraft,
      });
      expect(renderedIndicators()).toEqual([expected]);
    },
  );

  it("shows a decision beside working activity and clears it after resolution", () => {
    const working = makeSidebarWork("working");

    const optionalInput = [
      { id: "decision", kind: "question" as const, label: "Choose a home" },
    ];

    const rendered = renderThreadRow({
      thread: createThread({
        experimental_work: { ...working, optionalInput },
      }),
    });

    expect(renderedIndicators()).toEqual(["runtime", "input-welcome"]);
    expect(
      document.querySelector(
        '[data-status-reason="Open decision; work is running"]',
      ),
    ).toBeTruthy();
    rendered.unmount();
    renderThreadRow({ thread: createThread({ experimental_work: working }) });
    expect(renderedIndicators()).toEqual(["runtime"]);
  });

  it.each([
    "working",
    "needs-you",
    "blocked",
    "waiting",
    "external",
    "ready-to-archive",
  ] as const)(
    "uses the shared %s label of nested chats except Needs you",
    (label) => {
      renderThreadRow({
        thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
        options: {
          kind: "parent",
          depth: 1,
          isChild: false,
          isCompact: false,
          childCount: 1,
          childActivity: nestedActivity(makeSidebarWork(label)),
        },
      });

      const expected =
        label === "ready-to-archive" ||
        label === "external" ||
        label === "needs-you"
          ? "open"
          : experimental_threadIndicatorCases.find(
              (entry) => entry.state.work?.primary.label === label,
            )?.expected;

      expect(renderedIndicators()).toEqual([expected]);
    },
  );

  it("suppresses unreadness beside Working for an active child", () => {
    renderThreadRow({
      thread: createThread({
        status: "active",
        parentThreadId: "parent",
        experimental_work: makeSidebarWork("working"),
        isUnread: true,
      }),
    });
    expect(renderedIndicators()).toEqual(["runtime"]);
    expect(screen.queryByLabelText("Unread")).toBeNull();
  });

  it("suppresses family unreadness while collapsed descendants work", () => {
    renderThreadRow({
      thread: createThread({ isUnread: true }),
      options: {
        kind: "parent",
        depth: 1,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: {
          ...nestedActivity(makeSidebarWork("working")),
          unread: true,
        },
      },
    });
    expect(renderedIndicators()).toEqual(["runtime"]);
    expect(screen.queryByLabelText("Unread")).toBeNull();
  });

  it("keeps the parent unread dot hidden while expanded descendants work", () => {
    renderThreadRow({
      thread: createThread({ isUnread: true }),
      options: {
        kind: "parent",
        depth: 1,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: nestedActivity(makeSidebarWork("working")),
      },
    });
    expect(screen.queryByLabelText("Unread")).toBeNull();
  });

  it("keeps child work visible in the parent spinner when expanded", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      options: {
        kind: "parent",
        depth: 1,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: nestedActivity(makeSidebarWork("working")),
      },
    });
    expect(renderedIndicators()).toEqual(["runtime"]);
  });

  it("keeps a nested chat's open decision off the parent row", () => {
    renderThreadRow({
      thread: createThread({ lastReadAt: 1, latestAttentionAt: 1 }),
      options: {
        kind: "parent",
        depth: 1,
        isChild: false,
        isCompact: false,
        childCount: 1,
        childActivity: nestedActivity({
          ...makeSidebarWork("open"),
          optionalInput: [
            { id: "decision", kind: "question", label: "Choose a home" },
          ],
        }),
      },
    });
    expect(renderedIndicators()).toEqual(["open"]);
  });

  it("restores unreadness when working finishes", () => {
    const thread = createThread({
      status: "active",
      runtimeStatus: "active",
      experimental_work: makeSidebarWork("working"),
      isUnread: true,
    });

    const { rerenderThreadRow } = renderThreadRow({ thread });
    expect(renderedIndicators()).toEqual(["runtime"]);
    expect(screen.queryByLabelText("Unread")).toBeNull();
    rerenderThreadRow({
      ...thread,
      status: "idle",
      runtimeStatus: "idle",
      experimental_work: makeSidebarWork("open"),
      isUnread: true,
    });
    expect(renderedIndicators()).toEqual(["open"]);
    expect(screen.getByLabelText("Unread")).not.toBeNull();
  });

  it.each([
    ["working", true],
    ["needs-you", false],
    ["waiting", false],
    ["external", false],
    ["blocked", false],
    ["open", false],
    ["ready-to-archive", false],
  ] as const)("dims a %s row: %s", (label, dimmed) => {
    renderThreadRow({
      thread: createThread({ experimental_work: makeSidebarWork(label) }),
    });

    const row = screen
      .getByRole("link", { name: /^Open / })
      .closest("[data-sidebar-rename-row]");

    expect(row?.classList.contains("opacity-70")).toBe(dimmed);
    expect(row?.classList.contains("omnyo-sidebar-working-row")).toBe(dimmed);
  });

  it("drops the subtitle while the chat is working and restores it after", () => {
    const thread = createThread({
      title: "Release",
      experimental_subtitle: "Latest reply preview",
      experimental_work: makeSidebarWork("working"),
    });

    const { rerenderThreadRow } = renderThreadRow({ thread });
    expect(screen.queryByText("Latest reply preview")).toBeNull();
    rerenderThreadRow({
      ...thread,
      experimental_work: makeSidebarWork("open"),
    });
    expect(screen.getByText("Latest reply preview")).not.toBeNull();
  });

  it("does not start a sortable drag while editing the title", async () => {
    const onPointerDown = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onPointerDown },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.doubleClick(screen.getByText("Thread"));
    fireEvent.pointerDown(
      await screen.findByRole("textbox", { name: "Thread name" }),
    );

    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("restores the row when a long press opens its menu and still allows deliberate dragging", async () => {
    const onDragStart = vi.fn();
    const thread = createThread();

    function DraggableThread() {
      const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: thread.id,
      });

      return (
        <ThreadRowHarness
          thread={thread}
          options={{
            ...DEFAULT_OPTIONS,
            dragBindings: {
              attributes,
              listeners,
              setActivatorNodeRef: setNodeRef,
              isDragging,
              disabled: false,
            },
          }}
        />
      );
    }

    function Harness() {
      const { dndContextProps } = useSidebarReorderDnd({
        onDragStart,
        onDragEnd: vi.fn(),
        touchSensor: SidebarTouchSensor,
      });

      return (
        <CompactViewportOverrideProvider isCompactViewport>
          <DndContext {...dndContextProps}>
            <DraggableThread />
          </DndContext>
        </CompactViewportOverrideProvider>
      );
    }

    const slot = renderSlot(
      { component: Harness },
      {},
      {
        sidebarThreads: { threads: [thread], projects: [] },
      },
    );

    const link = screen.getByRole("link", { name: "Open Thread" });
    expect(link).toHaveProperty("draggable", false);
    fireEvent.pointerDown(link, {
      pointerId: 1,
      pointerType: "touch",
      isPrimary: true,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.touchStart(link, { touches: [{ clientX: 10, clientY: 10 }] });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed=true]"),
    ).not.toBeNull();
    fireEvent.contextMenu(link);
    expect(await screen.findByRole("menu")).not.toBeNull();
    expect(
      slot.container.querySelector("[data-sidebar-touch-armed-chip]"),
    ).toBeNull();
    expect(onDragStart).not.toHaveBeenCalled();
    fireEvent.touchMove(link, { touches: [{ clientX: 26, clientY: 10 }] });
    await waitFor(() => expect(onDragStart).toHaveBeenCalledTimes(1));
    expect(
      screen
        .getByTestId("omnyo-thread-actions-context-menu")
        .getAttribute("data-dragging"),
    ).toBe("true");
    fireEvent.touchEnd(link, { touches: [] });
  });

  it("starts touch reordering from the thread row", () => {
    const onTouchStart = vi.fn();
    renderThreadRow({
      options: {
        ...DEFAULT_OPTIONS,
        dragBindings: {
          attributes: {
            role: "button",
            tabIndex: 0,
            "aria-disabled": false,
            "aria-pressed": undefined,
            "aria-roledescription": "sortable",
            "aria-describedby": "thread-sortable",
          },
          disabled: false,
          isDragging: false,
          listeners: { onTouchStart },
          setActivatorNodeRef: vi.fn(),
        },
      },
    });

    fireEvent.touchStart(screen.getByRole("link", { name: "Open Thread" }));
    expect(onTouchStart).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Reorder Thread" })).toBeNull();
  });

  it("suppresses the click that follows a drag and drops the suppression afterwards", () => {
    const consumeClickSuppression = vi
      .fn<() => boolean>()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const slot = renderThreadRow({
      options: { ...DEFAULT_OPTIONS, consumeClickSuppression },
    });

    const link = screen.getByRole("link", { name: "Open Thread" });

    expect(fireEvent.click(link)).toBe(false);
    expect(fireEvent.click(link, { metaKey: true })).toBe(false);
    expect(consumeClickSuppression).toHaveBeenCalledTimes(2);
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toThread", threadId: "thr_test", options: { split: true } },
    ]);
  });

  it("starts a rename from a second click after the row remounts", async () => {
    const thread = createThread();
    const { rerenderThreadRow } = renderThreadRow({ thread });
    const link = screen.getByRole("link", { name: "Open Thread" });

    fireEvent.click(link);
    rerenderThreadRow(thread);
    fireEvent.click(screen.getByRole("link", { name: "Open Thread" }));

    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Thread");
  });
});

// @vitest-environment jsdom

import {
  ActionHistoryProvider,
  useActionHistory,
} from "@/components/layout/ActionHistoryProvider";
import type { ActionHistory } from "@/lib/action-history";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createStore, Provider } from "jotai";
import { memo, type ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  experimental_THREAD_ACTION_GROUPS,
  type PluginThreadActionRegistration,
  type PluginThreadActionsInlineItem,
} from "@omnyo/plugin-sdk";
import {
  defaultAppSettings,
  appKeybindingOverridesSchema,
  applyAppKeybindingOverrides,
  type ThreadListEntry,
} from "@omnyo/domain";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { getThreadRoutePath } from "@/lib/route-paths";
import type { SplitLayout } from "@/lib/split-layout";
import { splitLayoutAtom } from "@/lib/split-layout/atoms";
import { CORE_THREAD_ACTIONS } from "@/lib/thread-actions/core-thread-actions";
import { getChatSelection, setChatSelection } from "@/lib/chat-selection";
import { parseStoredPreferenceValue } from "../../../../../plugins/thread-list/shared/preferences.js";
import { threadListEntryActionTarget } from "@/lib/thread-actions/thread-action-target";
import {
  ThreadActionCollectors,
  ThreadActionSurfaceVisibility,
  resetThreadActionRegistryForTest,
  useThreadActionEntries,
  useThreadActionRegistrationInfos,
} from "@/lib/thread-actions/thread-action-registry";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { usePublishThreadPanelOpener } from "@/components/plugin/plugin-thread-panel-navigation";
import {
  ThreadActionsContextMenu,
  ThreadActionsMenu,
} from "./ThreadActionsMenu";

const hostActions = vi.hoisted(() => ({
  archiveThreadAsync: vi.fn(async () => {}),
  requestArchive: vi.fn(),
  requestDelete: vi.fn(),
  requestShelve: vi.fn(),
}));

const sdkThreads = vi.hoisted(() => ({
  pin: vi.fn(),
  unpin: vi.fn(),
  markRead: vi.fn(),
  markUnread: vi.fn(),
  unarchive: vi.fn(),
  shelve: vi.fn(),
  unshelve: vi.fn(),
  update: vi.fn(),
  get: vi.fn(),
}));

const shortcutState = vi.hoisted(() => ({
  keybindings: [] as unknown[],
}));

const copyToClipboardWithToast = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@/lib/sdk", () => ({ sdk: { threads: sdkThreads } }));

vi.mock("@/lib/clipboard", () => ({ copyToClipboardWithToast }));

vi.mock("@/lib/thread-actions/thread-actions-context", () => ({
  useThreadActions: () => hostActions,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({
    data: {
      generalSettings: defaultAppSettings,
      keybindings: shortcutState.keybindings,
    },
  }),
}));

function commandBinding(
  command: "thread.archive" | "thread.copyLink" | "thread.shelve",
  key: string,
  modifier: "alt" | "shift",
): Parameters<typeof applyAppKeybindingOverrides>[0][number] {
  return {
    command,
    desktopOnly: false,
    shortcut: {
      key,
      mod: true,
      meta: false,
      control: false,
      alt: modifier === "alt",
      shift: modifier === "shift",
    },
    when: { all: ["mainSurface"], none: ["modalOpen"] },
  };
}

const moveRun = vi.fn();

const moveAction: PluginThreadActionRegistration = {
  id: "move",
  title: "Move to section",
  icon: "SectionMove",
  group: experimental_THREAD_ACTION_GROUPS.organize,
  order: 50,
  item: ({ thread }) =>
    thread.parentThreadId !== null || thread.archivedAt !== null
      ? null
      : {
          label: "Move to section",
          icon: "SectionMove",
          choices: {
            items: [
              { id: "sec_planning", label: "Planning", selected: true },
              { id: "sec_building", label: "Building" },
            ],
          },
          run: moveRun,
        },
};

const pluginGroupRun = vi.fn();

const pluginGroupAction: PluginThreadActionRegistration = {
  id: "notify",
  title: "Notifications",
  icon: "Notification",
  group: "5_plugin",
  item: () => ({
    label: "Notifications",
    icon: "Notification",
    run: pluginGroupRun,
  }),
};

const baseThread = makeThreadListEntry({
  id: "thr_target",
  projectId: "proj_a",
  sectionId: "sec_planning",
  pinnedAt: null,
  archivedAt: null,
  parentThreadId: null,
  lastReadAt: 10,
  latestAttentionAt: 5,
  environmentId: "env_a",
  environmentPath: "/repo",
});

interface SurfaceOptions {
  thread: ThreadListEntry;
  inline?: readonly PluginThreadActionsInlineItem[];
  requestRename?: (threadId: string) => void;
}

interface Surface {
  name: string;
  compact: boolean;
  render(options: SurfaceOptions): ReactElement;
  open(): Promise<void>;
}

const SURFACES: readonly Surface[] = [
  {
    name: "desktop dropdown",
    compact: false,
    render: ({ thread, inline, requestRename }) => (
      <ThreadActionsMenu
        thread={threadListEntryActionTarget(thread)}
        trigger={(props) => (
          <button {...props} type="button">
            Thread actions
          </button>
        )}
        inline={inline}
        requestRename={requestRename}
      />
    ),
    open: async () => {
      fireEvent.pointerDown(
        screen.getByRole("button", { name: "Thread actions" }),
        { button: 0 },
      );
    },
  },
  {
    name: "desktop context menu",
    compact: false,
    render: ({ thread, inline, requestRename }) => (
      <ThreadActionsContextMenu
        thread={threadListEntryActionTarget(thread)}
        inline={inline}
        requestRename={requestRename}
      >
        <div>Row</div>
      </ThreadActionsContextMenu>
    ),
    open: async () => {
      fireEvent.contextMenu(screen.getByText("Row"));
    },
  },
  {
    name: "compact drawer",
    compact: true,
    render: ({ thread, inline, requestRename }) => (
      <ThreadActionsMenu
        thread={threadListEntryActionTarget(thread)}
        trigger={(props) => (
          <button {...props} type="button">
            Thread actions
          </button>
        )}
        inline={inline}
        requestRename={requestRename}
      />
    ),
    open: async () => {
      fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    },
  },
  {
    name: "compact long press",
    compact: true,
    render: ({ thread, inline, requestRename }) => (
      <ThreadActionsContextMenu
        thread={threadListEntryActionTarget(thread)}
        inline={inline}
        requestRename={requestRename}
      >
        <div>Row</div>
      </ThreadActionsContextMenu>
    ),
    open: async () => {
      fireEvent.contextMenu(screen.getByText("Row"));
    },
  },
];

const defaultRequestRename = vi.fn();

function twoPaneLayout(focusedPaneId: string): SplitLayout {
  return {
    root: {
      type: "split",
      dir: "row",
      sizes: [0.5, 0.5],
      children: [
        {
          type: "pane",
          paneId: "pane_other",
          content: {
            kind: "thread",
            projectId: "proj_a",
            threadId: "thr_other",
          },
        },
        {
          type: "pane",
          paneId: "pane_target",
          content: {
            kind: "thread",
            projectId: baseThread.projectId,
            threadId: baseThread.id,
          },
        },
      ],
    },
    focusedPaneId,
  };
}

interface HostState {
  route?: string;
  layout?: SplitLayout | null;
  cached?: boolean;
  threadActions?: readonly PluginThreadActionRegistration[];
  commands?: boolean;
}

const historyProbe: { current: ActionHistory | null } = { current: null };

function HistoryProbe() {
  historyProbe.current = useActionHistory();

  return null;
}

function recordedHistory(): ActionHistory {
  if (historyProbe.current === null) throw new Error("Expected a history");

  return historyProbe.current;
}

function renderSurface(
  surface: Surface,
  options: SurfaceOptions,
  {
    route = "/",
    layout = null,
    cached = true,
    threadActions = [],
    commands = false,
  }: HostState = {},
) {
  const queryClient = new QueryClient();
  const store = createStore();

  if (layout !== null) store.set(splitLayoutAtom, layout);

  if (cached) {
    queryClient.setQueryData(threadQueryKey(options.thread.id), options.thread);
  }

  setPluginSlotRegistrations(
    "fixture",
    makePluginRegistrationSet({
      threadActions: [moveAction, pluginGroupAction, ...threadActions],
    }),
  );

  const surfaceTree = (
    <>
      <HistoryProbe />
      <ThreadActionCollectors
        coreRegistrations={CORE_THREAD_ACTIONS}
        requestRename={defaultRequestRename}
      />
      {surface.render(options)}
    </>
  );

  return render(
    <QueryClientProvider client={queryClient}>
      <ActionHistoryProvider>
        <Provider store={store}>
          <MemoryRouter initialEntries={[route]}>
            <CompactViewportOverrideProvider
              isCompactViewport={surface.compact}
            >
              {commands ? (
                <AppCommandProvider>{surfaceTree}</AppCommandProvider>
              ) : (
                surfaceTree
              )}
            </CompactViewportOverrideProvider>
          </MemoryRouter>
        </Provider>
      </ActionHistoryProvider>
    </QueryClientProvider>,
  );
}

async function openMenu(): Promise<HTMLElement> {
  return waitFor(() => {
    const menu = screen.queryByRole("menu") ?? screen.queryByRole("dialog");

    if (menu?.querySelector('[role="menuitem"]') == null) {
      throw new Error("no open menu");
    }

    return menu;
  });
}

async function menuRows(): Promise<string[]> {
  const menu = await openMenu();

  return Array.from(
    menu.querySelectorAll('[role="menuitem"], [role="separator"]'),
  )
    .filter(
      (element) =>
        element.parentElement?.closest('[role="menu"], [role="dialog"]') ===
        menu,
    )
    .map((element) =>
      element.getAttribute("role") === "separator"
        ? "---"
        : (element.textContent?.trim() ?? ""),
    );
}

async function choose(surface: Surface, actionLabel: string, choice: string) {
  const trigger = await screen.findByRole("menuitem", { name: actionLabel });

  if (surface.compact) fireEvent.click(trigger);
  else fireEvent.keyDown(trigger, { key: "ArrowRight" });
  fireEvent.click(await screen.findByRole("menuitem", { name: choice }));
}

afterEach(() => {
  cleanup();
  shortcutState.keybindings = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetPluginSlotStoreForTest();
  resetThreadActionRegistryForTest();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const CUSTOMIZE: PluginThreadActionsInlineItem = {
  key: "surface/customize",
  group: experimental_THREAD_ACTION_GROUPS.settings,
  action: {
    label: "Customize row actions",
    icon: "FilterHorizontal",
    run: vi.fn(),
  },
};

describe.each(SURFACES)("thread actions on the $name", (surface) => {
  it("keeps the page accessible while its action menu is open", async () => {
    const view = renderSurface(surface, { thread: baseThread });
    await surface.open();
    await openMenu();
    expect(view.container.closest('[aria-hidden="true"]')).toBeNull();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it.each([
    {
      state: "a top-level thread",
      thread: baseThread,
      route: "/",
      layout: null,
      desktop: [
        "Open in split",
        "New thread in environment",
        "Copy link",
        "---",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "---",
        "Customize row actions",
        "---",
        "Shelve",
        "Archive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "New thread in environment",
        "Copy link",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "Customize row actions",
        "Shelve",
        "Archive",
        "Delete",
        "Notifications",
      ],
    },
    {
      state: "a shelved top-level thread",
      thread: makeThreadListEntry({ ...baseThread, shelvedAt: 30 }),
      route: "/",
      layout: null,
      desktop: [
        "Open in split",
        "New thread in environment",
        "Copy link",
        "---",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "---",
        "Customize row actions",
        "---",
        "Unshelve",
        "Archive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "New thread in environment",
        "Copy link",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "Customize row actions",
        "Unshelve",
        "Archive",
        "Delete",
        "Notifications",
      ],
    },
    {
      state: "an archived, pinned, unread child thread",
      thread: makeThreadListEntry({
        ...baseThread,
        archivedAt: 20,
        pinnedAt: 3,
        parentThreadId: "thr_parent",
        lastReadAt: 1,
        latestAttentionAt: 5,
        environmentPath: null,
      }),
      route: "/",
      layout: null,
      desktop: [
        "Open in split",
        "Copy link",
        "---",
        "Rename",
        "Unpin",
        "Mark read",
        "---",
        "Customize row actions",
        "---",
        "Unarchive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "Copy link",
        "Rename",
        "Unpin",
        "Mark read",
        "Customize row actions",
        "Unarchive",
        "Delete",
        "Notifications",
      ],
    },
    {
      state: "the thread already in view",
      thread: baseThread,
      route: getThreadRoutePath({
        projectId: baseThread.projectId,
        threadId: baseThread.id,
      }),
      layout: null,
      desktop: [
        "New thread in environment",
        "Copy link",
        "---",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "---",
        "Customize row actions",
        "---",
        "Shelve",
        "Archive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "New thread in environment",
        "Copy link",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "Customize row actions",
        "Shelve",
        "Archive",
        "Delete",
        "Notifications",
      ],
    },
    {
      state: "a thread open in another split pane",
      thread: baseThread,
      route: getThreadRoutePath({ projectId: "proj_a", threadId: "thr_other" }),
      layout: twoPaneLayout("pane_other"),
      desktop: [
        "Focus split",
        "New thread in environment",
        "Copy link",
        "---",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "---",
        "Customize row actions",
        "---",
        "Shelve",
        "Archive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "New thread in environment",
        "Copy link",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "Customize row actions",
        "Shelve",
        "Archive",
        "Delete",
        "Notifications",
      ],
    },
    {
      state: "the thread in the focused split pane",
      thread: baseThread,
      route: getThreadRoutePath({
        projectId: baseThread.projectId,
        threadId: baseThread.id,
      }),
      layout: twoPaneLayout("pane_target"),
      desktop: [
        "New thread in environment",
        "Copy link",
        "---",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "---",
        "Customize row actions",
        "---",
        "Shelve",
        "Archive",
        "Delete",
        "---",
        "Notifications",
      ],
      compact: [
        "New thread in environment",
        "Copy link",
        "Rename",
        "Pin",
        "Mark unread",
        "Move to section",
        "Customize row actions",
        "Shelve",
        "Archive",
        "Delete",
        "Notifications",
      ],
    },
  ])(
    "lists the items for $state",
    async ({ thread, route, layout, desktop, compact }) => {
      renderSurface(
        surface,
        { thread, inline: [CUSTOMIZE] },
        { route, layout },
      );
      await surface.open();
      expect(await menuRows()).toEqual(surface.compact ? compact : desktop);
    },
  );

  it("runs each action's effect", async () => {
    sdkThreads.pin.mockResolvedValue({ ...baseThread, pinnedAt: 9 });
    sdkThreads.markUnread.mockResolvedValue({
      ...baseThread,
      lastReadAt: null,
    });
    const requestRename = vi.fn();
    renderSurface(surface, { thread: baseThread, requestRename });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() =>
      expect(sdkThreads.pin).toHaveBeenCalledWith({ threadId: baseThread.id }),
    );

    await surface.open();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Mark unread" }),
    );
    await waitFor(() =>
      expect(sdkThreads.markUnread).toHaveBeenCalledWith({
        threadId: baseThread.id,
      }),
    );

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(requestRename).toHaveBeenCalledWith(baseThread.id);
    expect(defaultRequestRename).not.toHaveBeenCalled();

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(hostActions.requestArchive).toHaveBeenCalledWith(
      expect.objectContaining({ id: baseThread.id }),
    );

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Shelve" }));
    expect(hostActions.requestShelve).toHaveBeenCalledWith(
      expect.objectContaining({ id: baseThread.id }),
    );

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() =>
      expect(hostActions.requestDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: baseThread.id }),
      ),
    );

    await surface.open();
    await choose(surface, "Move to section", "Building");
    expect(moveRun).toHaveBeenCalledWith(
      expect.objectContaining({ value: "sec_building" }),
    );

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy link" }));
    expect(copyToClipboardWithToast).toHaveBeenCalledWith(
      `${window.location.origin}/projects/proj_a/threads/thr_target`,
      {
        successMessage: "Thread link copied",
        errorMessage: "Failed to copy thread link",
      },
    );
  });

  it("unshelves a shelved thread in place", async () => {
    const shelved = makeThreadListEntry({ ...baseThread, shelvedAt: 30 });
    sdkThreads.unshelve.mockResolvedValue({ ...shelved, shelvedAt: null });
    renderSurface(surface, { thread: shelved });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unshelve" }));
    await waitFor(() =>
      expect(sdkThreads.unshelve).toHaveBeenCalledWith({
        threadId: shelved.id,
      }),
    );
    expect(hostActions.requestShelve).not.toHaveBeenCalled();
  });

  it("records Unshelve so undo shelves the thread and redo unshelves it again", async () => {
    const shelved = makeThreadListEntry({ ...baseThread, shelvedAt: 30 });
    sdkThreads.unshelve.mockResolvedValue({ ...shelved, shelvedAt: null });
    sdkThreads.shelve.mockResolvedValue(shelved);
    renderSurface(surface, { thread: shelved });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unshelve" }));
    await waitFor(() =>
      expect(recordedHistory().peek("undo")?.label).toMatch(/^Unshelve “/),
    );

    await act(() => recordedHistory().undo());
    expect(sdkThreads.shelve).toHaveBeenCalledWith({ threadId: shelved.id });

    await act(() => recordedHistory().redo());
    expect(sdkThreads.unshelve).toHaveBeenCalledTimes(2);
    expect(recordedHistory().canRedo).toBe(false);
  });

  it("records Pin before the request answers and forgets it when the request fails", async () => {
    let rejectPin!: () => void;
    sdkThreads.pin.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPin = () => reject(new Error("offline"));
        }),
    );
    renderSurface(surface, { thread: baseThread });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));
    await waitFor(() =>
      expect(recordedHistory().peek("undo")?.label).toMatch(/^Pin “/),
    );
    await waitFor(() => expect(sdkThreads.pin).toHaveBeenCalled());

    await act(async () => rejectPin());
    await waitFor(() => expect(recordedHistory().canUndo).toBe(false));
  });

  it("routes the undo of Unarchive through Omnyo's archive action", async () => {
    const archived = makeThreadListEntry({ ...baseThread, archivedAt: 20 });
    sdkThreads.unarchive.mockResolvedValue({ ok: true });
    renderSurface(surface, { thread: archived });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Unarchive" }));
    await waitFor(() =>
      expect(recordedHistory().peek("undo")?.label).toMatch(/^Unarchive “/),
    );
    await waitFor(() =>
      expect(sdkThreads.unarchive).toHaveBeenCalledWith({
        threadId: archived.id,
      }),
    );

    await act(() => recordedHistory().undo());
    expect(hostActions.archiveThreadAsync).toHaveBeenCalledWith(
      expect.objectContaining({ id: archived.id }),
    );
  });

  it("shows the effective shortcut beside core actions on desktop menus only", async () => {
    const persisted = appKeybindingOverridesSchema.parse([
      {
        command: "thread.shelve",
        shortcut: commandBinding("thread.shelve", "f", "shift").shortcut,
      },
      {
        command: "thread.archive",
        shortcut: commandBinding("thread.archive", "a", "alt").shortcut,
      },
    ]);

    shortcutState.keybindings = applyAppKeybindingOverrides(
      [
        commandBinding("thread.shelve", "x", "alt"),
        commandBinding("thread.archive", "y", "shift"),
        commandBinding("thread.copyLink", "c", "shift"),
      ],
      persisted,
    );
    renderSurface(surface, { thread: baseThread }, { commands: true });
    await surface.open();

    const shortcutBeside = async (name: string) =>
      (await screen.findByRole("menuitem", { name })).textContent?.slice(
        name.length,
      );

    expect(await shortcutBeside("Shelve")).toBe(
      surface.compact ? "" : "Ctrl + Shift + F",
    );
    expect(await shortcutBeside("Archive")).toBe(
      surface.compact ? "" : "Ctrl + Alt + A",
    );
    expect(await shortcutBeside("Copy link")).toBe(
      surface.compact ? "" : "Ctrl + Shift + C",
    );
    expect(await shortcutBeside("Rename")).toBe("");
    expect(await shortcutBeside("Pin")).toBe("");
  });

  it("falls back to Omnyo's rename dialog when the surface has no editor", async () => {
    renderSurface(surface, { thread: baseThread });
    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    expect(defaultRequestRename).toHaveBeenCalledWith(baseThread.id);
  });

  it("drops a registration whose item throws and keeps the rest", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setPluginSlotRegistrations(
      "broken",
      makePluginRegistrationSet({
        threadActions: [
          {
            id: "boom",
            title: "Boom",
            icon: "Zap",
            group: "2_organize",
            item: () => {
              throw new Error("boom");
            },
          },
        ],
      }),
    );
    renderSurface(surface, { thread: baseThread });
    await surface.open();
    const menu = await openMenu();
    expect(within(menu).getByRole("menuitem", { name: "Pin" })).not.toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Boom" })).toBeNull();
    expect(error).toHaveBeenCalled();
  });
});

describe("thread action run containment", () => {
  it("contains a rejected run so the menu keeps working", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    pluginGroupRun.mockRejectedValueOnce(new Error("nope"));
    const [surface] = SURFACES;

    if (surface === undefined) throw new Error("no surface");
    renderSurface(surface, { thread: baseThread });
    await surface.open();
    await act(async () => {
      fireEvent.click(
        await screen.findByRole("menuitem", { name: "Notifications" }),
      );
    });
    await waitFor(() => expect(error).toHaveBeenCalled());
    await surface.open();
    expect(await screen.findByRole("menuitem", { name: "Pin" })).not.toBeNull();
  });
});

describe("thread actions menu trigger", () => {
  it("reports a trigger that replaces the host's classes", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [surface] = SURFACES;

    if (surface === undefined) throw new Error("no surface");
    renderSurface(
      {
        ...surface,
        render: ({ thread }) => (
          <ThreadActionsMenu
            thread={threadListEntryActionTarget(thread)}
            trigger={(props) => (
              <button {...props} type="button" className="mine">
                Thread actions
              </button>
            )}
          />
        ),
      },
      { thread: baseThread },
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("dropped the host's classes (select-none)"),
    );
  });

  it("keeps the host's classes on a trigger that merges them", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [surface] = SURFACES;

    if (surface === undefined) throw new Error("no surface");
    renderSurface(surface, { thread: baseThread });
    expect(
      screen
        .getByRole("button", { name: "Thread actions" })
        .classList.contains("select-none"),
    ).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("reports a trigger that drops the props and ref it receives", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [surface] = SURFACES;

    if (surface === undefined) throw new Error("no surface");
    renderSurface(
      {
        ...surface,
        render: ({ thread }) => (
          <ThreadActionsMenu
            thread={threadListEntryActionTarget(thread)}
            trigger={() => <button type="button">Thread actions</button>}
          />
        ),
      },
      { thread: baseThread },
    );
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Thread actions" }),
      { button: 0 },
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("did not attach the ref"),
    );
  });
});

it("resolves migrated row preferences against the actual core registry and executes Pin", async () => {
  const input = ["core/pin", "core/copyLink", "omnyo--core/archive"];
  const original = [...input];
  sdkThreads.pin.mockResolvedValue({ ...baseThread, pinnedAt: 9 });
  const completion: { current: Promise<void> | null } = { current: null };
  const parsed = parseStoredPreferenceValue("rowActions", input);

  if (!parsed.success) throw new Error(parsed.message);
  const keys = parsed.value;

  function ImportedPreferenceActions({ thread }: { thread: ThreadListEntry }) {
    const entries = useThreadActionEntries(
      threadListEntryActionTarget(thread),
      { keys },
    );

    return (
      <div>
        {entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              completion.current = entry.action.run();
            }}
          >
            {entry.action.label}
          </button>
        ))}
      </div>
    );
  }

  const [surface] = SURFACES;

  if (surface === undefined) throw new Error("no surface");
  renderSurface(
    {
      ...surface,
      render: ({ thread }) => <ImportedPreferenceActions thread={thread} />,
    },
    { thread: baseThread },
  );
  const pin = await screen.findByRole("button", { name: "Pin" });
  expect(keys).toEqual([
    "omnyo--core/pin",
    "omnyo--core/copyLink",
    "omnyo--core/archive",
  ]);
  expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
  fireEvent.click(pin);
  const settled = completion.current;

  if (settled === null) throw new Error("Pin action did not run");
  await act(() => settled);
  await waitFor(() =>
    expect(sdkThreads.pin).toHaveBeenCalledWith({ threadId: baseThread.id }),
  );
  expect(recordedHistory().peek("undo")?.label).toMatch(/^Pin /);
  expect(input).toEqual(original);
});

describe("thread action registrations", () => {
  function RegistrationList() {
    return (
      <ol>
        {useThreadActionRegistrationInfos().map((info) => (
          <li key={info.key}>{info.key}</li>
        ))}
      </ol>
    );
  }

  it("lists every registration in menu order, independent of any thread", () => {
    const [surface] = SURFACES;

    if (surface === undefined) throw new Error("no surface");
    renderSurface(
      { ...surface, render: () => <RegistrationList /> },
      { thread: baseThread },
    );
    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "omnyo--core/split",
      "omnyo--core/newThreadInEnvironment",
      "omnyo--core/copyLink",
      "omnyo--core/rename",
      "omnyo--core/pin",
      "omnyo--core/read",
      "omnyo--core/moveToGroup",
      "fixture/move",
      "omnyo--core/shelve",
      "omnyo--core/archive",
      "omnyo--core/delete",
      "fixture/notify",
    ]);
  });
});

describe("chat selection in the context menu", () => {
  const surface = SURFACES.find(
    (candidate) => candidate.name === "desktop context menu",
  );

  if (surface === undefined) throw new Error("no desktop context menu");

  afterEach(() => setChatSelection([]));

  it("offers grouping when the chat is part of a multi-selection", async () => {
    setChatSelection([baseThread.id, "thr_other"]);
    renderSurface(surface, { thread: baseThread });

    await surface.open();
    const menu = await openMenu();

    expect(
      within(menu).getByRole("menuitem", { name: "Group 2 chats" }),
    ).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Rename" })).toBeNull();

    fireEvent.click(
      within(menu).getByRole("menuitem", { name: "Clear selection" }),
    );

    expect(getChatSelection()).toEqual([]);
  });

  it("keeps the chat's own menu when it is outside the selection", async () => {
    setChatSelection(["thr_a", "thr_b"]);
    renderSurface(surface, { thread: baseThread });

    await surface.open();
    const menu = await openMenu();

    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeTruthy();
    expect(
      within(menu).queryByRole("menuitem", { name: /^Group \d+ chats$/ }),
    ).toBeNull();
  });
});

describe("thread actions outside Omnyo's own surfaces", () => {
  const [surface] = SURFACES;

  if (surface === undefined) throw new Error("no surface");

  it("fetches a thread Omnyo has not cached before archiving or deleting it", async () => {
    sdkThreads.get.mockResolvedValue(baseThread);
    renderSurface(surface, { thread: baseThread }, { cached: false });

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    await waitFor(() =>
      expect(hostActions.requestArchive).toHaveBeenCalledWith(
        expect.objectContaining({ id: baseThread.id }),
      ),
    );

    await surface.open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    await waitFor(() =>
      expect(hostActions.requestDelete).toHaveBeenCalledWith(
        expect.objectContaining({ id: baseThread.id }),
      ),
    );
    expect(sdkThreads.get).toHaveBeenCalledWith({ threadId: baseThread.id });
  });

  it("opens a plugin's thread panel in the focused thread view", async () => {
    const opener = vi.fn(() => true);
    const opened = vi.fn();

    function FocusedThreadView() {
      usePublishThreadPanelOpener(opener, true);

      return null;
    }

    render(<FocusedThreadView />);
    renderSurface(
      surface,
      { thread: baseThread },
      {
        threadActions: [
          {
            id: "details",
            title: "Open details",
            icon: "Info",
            group: "5_plugin",
            item: ({ navigate }) => ({
              label: "Open details",
              icon: "Info",
              run: () => {
                opened(navigate.openThreadPanel({ actionId: "details" }));
              },
            }),
          },
        ],
      },
    );

    await surface.open();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Open details" }),
    );
    await waitFor(() => expect(opened).toHaveBeenCalledWith(true));
    expect(opener).toHaveBeenCalledWith({
      actionId: "details",
      pluginId: "fixture",
    });
  });
});

describe("thread action data input", () => {
  const rowRenders = { count: 0 };

  function Row({ id }: { id: string }) {
    rowRenders.count += 1;
    useThreadActionEntries(
      threadListEntryActionTarget({ ...baseThread, id }),
      {},
    );

    return null;
  }

  const MemoRow = memo(Row);

  function renderRecorder() {
    const seen: (readonly string[])[] = [];

    const recorder: PluginThreadActionRegistration<null> = {
      id: "recorder",
      title: "Recorder",
      icon: "Notification",
      group: "5_plugin",
      useData: ({ threadIds }) => {
        if (seen.at(-1) !== threadIds) seen.push(threadIds);

        return null;
      },
      item: () => null,
    };

    setPluginSlotRegistrations(
      "fixture",
      makePluginRegistrationSet({ threadActions: [recorder] }),
    );
    const queryClient = new QueryClient();

    function Surface({
      ids,
      visible = true,
    }: {
      ids: readonly string[];
      visible?: boolean;
    }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ActionHistoryProvider>
            <MemoryRouter>
              <ThreadActionCollectors
                coreRegistrations={[]}
                requestRename={defaultRequestRename}
              />
              <ThreadActionSurfaceVisibility visible={visible}>
                {ids.map((id, index) => (
                  <MemoRow key={`${id}-${index}`} id={id} />
                ))}
              </ThreadActionSurfaceVisibility>
            </MemoryRouter>
          </ActionHistoryProvider>
        </QueryClientProvider>
      );
    }

    return { seen, Surface };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  it("passes the union of subscribed thread ids and drops released ones", async () => {
    const { seen, Surface } = renderRecorder();
    const view = render(<Surface ids={["thr_b", "thr_a", "thr_c", "thr_a"]} />);
    await waitFor(() =>
      expect(seen.at(-1)).toEqual(["thr_a", "thr_b", "thr_c"]),
    );
    view.rerender(<Surface ids={["thr_b", "thr_a"]} />);
    await waitFor(() => expect(seen.at(-1)).toEqual(["thr_a", "thr_b"]));
    view.rerender(<Surface ids={["thr_a", "thr_b"]} />);
    await settle();
    expect(seen).toEqual([[], ["thr_a", "thr_b", "thr_c"], ["thr_a", "thr_b"]]);
  });

  it("coalesces rows that mount a moment apart into one change", async () => {
    const { seen, Surface } = renderRecorder();
    const view = render(<Surface ids={["thr_a", "thr_b"]} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    view.rerender(<Surface ids={["thr_a", "thr_b", "thr_c"]} />);
    await settle();
    expect(seen).toEqual([[], ["thr_a", "thr_b", "thr_c"]]);
  });

  it("releases and restores ids on a visibility change without re-rendering rows", async () => {
    const { seen, Surface } = renderRecorder();
    const ids = ["thr_a", "thr_b"];
    const view = render(<Surface ids={ids} />);
    await waitFor(() => expect(seen.at(-1)).toEqual(ids));
    await settle();
    const rendersBefore = rowRenders.count;
    view.rerender(<Surface ids={ids} visible={false} />);
    await waitFor(() => expect(seen.at(-1)).toEqual([]));
    view.rerender(<Surface ids={ids} visible />);
    await waitFor(() => expect(seen.at(-1)).toEqual(ids));
    expect(rowRenders.count).toBe(rendersBefore);
  });

  it("counts no ids from a hidden surface until it is shown", async () => {
    const { seen, Surface } = renderRecorder();
    const ids = Array.from({ length: 250 }, (_, index) => `thr_${index}`);
    const view = render(<Surface ids={ids} visible={false} />);
    await settle();
    expect(seen).toEqual([[]]);
    view.rerender(<Surface ids={ids.slice(0, 2)} visible />);
    await waitFor(() => expect(seen.at(-1)).toEqual(["thr_0", "thr_1"]));
  });
});

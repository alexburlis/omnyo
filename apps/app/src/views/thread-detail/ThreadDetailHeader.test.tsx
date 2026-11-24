// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode, Ref } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadDetailHeader } from "./ThreadDetailHeader";
import { PaneContext, type PaneContextValue } from "./PaneContext";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { sdk } from "@/lib/sdk";
import { createOmnyoDesktopApi } from "@/test/omnyo-desktop-test-utils";
import { AppCommandProvider } from "@/components/commands/AppCommandProvider";
import {
  ThreadActionCollectors,
  resetThreadActionRegistryForTest,
} from "@/lib/thread-actions/thread-action-registry";
import type { ThreadDetailHeaderActionsMenuArgs } from "./ThreadDetailHeader";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  environmentQueryKey,
  hostsQueryKey,
  sidebarNavigationQueryKey,
  threadQueryKey,
} from "@/hooks/queries/query-keys";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeEnvironment, makeHost } from "@omnyo/test-helpers/domain-fixtures";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import { WindowTitleBarSlotsContext } from "@/components/layout/window-title-bar-slots";
import { MemoryRouter } from "react-router-dom";
import { PluginThreadHeaderActions } from "@/components/plugin/PluginThreadHeaderActions";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";

const queryHarness = createQueryClientTestHarness();

function render(ui: ReactNode) {
  return renderComponent(ui, { wrapper: queryHarness.wrapper });
}

const mocks = vi.hoisted(() => ({
  copyToClipboardWithToast: vi.fn(async () => true),
  providers: [] as { id: string; displayName: string }[],
  renameThreadAsync: vi.fn(),
}));

vi.mock("@/lib/clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/clipboard")>()),
  copyToClipboardWithToast: mocks.copyToClipboardWithToast,
}));

vi.mock("@/lib/thread-actions/thread-actions-context", () => ({
  useThreadActions: () => ({
    renameThreadAsync: mocks.renameThreadAsync,
  }),
}));

vi.mock("@/components/layout/AppPageHeader", () => ({
  HEADER_ICON_BUTTON_CLASS: "header-icon-button",
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS: "header-pane-action-button",
  AppPageHeader: ({
    actions,
    center,
    className,
    headerRef,
  }: {
    actions?: ReactNode;
    center?: ReactNode;
    className?: string;
    headerRef?: Ref<HTMLElement>;
  }) => (
    <header ref={headerRef} className={className}>
      {center}
      {actions}
    </header>
  ),
}));

const viewportState = vi.hoisted(() => ({
  isCompactViewport: false,
  isPointerCoarse: false,
  isNarrowWindow: false,
  titleBarHostsChrome: false,
}));

vi.mock("@/components/layout/WindowRightPanelToggle", () => ({
  useWindowTitleBarHostsRightPanelToggle: () =>
    viewportState.titleBarHostsChrome,
}));

vi.mock("@omnyo/shared-ui/hooks/use-media-query", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@omnyo/shared-ui/hooks/use-media-query")
  >()),
  useMediaQuery: () => viewportState.isNarrowWindow,
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemProviders: () => ({ data: mocks.providers }),
  useSystemConfig: () => ({
    data: {
      keybindings: [
        {
          command: "thread.rename",
          desktopOnly: false,
          shortcut: {
            key: "r",
            mod: true,
            meta: false,
            control: false,
            alt: false,
            shift: true,
          },
          when: { all: ["mainSurface"], none: ["modalOpen"] },
        },
      ],
    },
  }),
}));

vi.mock("@omnyo/shared-ui/hooks/use-compact-viewport", () => ({
  useIsCompactViewport: () => viewportState.isCompactViewport,
}));

vi.mock("@omnyo/shared-ui/hooks/use-pointer-coarse", () => ({
  usePointerCoarse: () => viewportState.isPointerCoarse,
}));

const THREAD_ID = "thr_header";

const PANE_CONTEXT: PaneContextValue = {
  paneId: "main",
  isFocused: true,
  isSplitPane: false,
  secondaryPanelHost: null,
  reservesWindowPanelToggle: false,
  onRequestClose: null,
  isMaximized: false,
  onToggleMaximize: null,
  isBoundedPane: false,
  isTopRow: true,
  ownsWindowTopLeft: true,
  navigateInPane: vi.fn(),
};

afterEach(() => {
  cleanup();
  queryHarness.queryClient.clear();
  resetThreadActionRegistryForTest();
  viewportState.isCompactViewport = false;
  viewportState.isPointerCoarse = false;
  viewportState.isNarrowWindow = false;
  viewportState.titleBarHostsChrome = false;
  document.body.replaceChildren();
  mocks.renameThreadAsync.mockReset();
  mocks.copyToClipboardWithToast.mockClear();
  mocks.providers = [];
  vi.restoreAllMocks();
  window.localStorage.clear();
  delete window.omnyoDesktop;
});

describe("ThreadDetailHeader", () => {
  describe("meta line", () => {
    const branchCheckout: WorkspaceCheckoutDisplay = {
      copyErrorMessage: "Failed to copy branch name",
      copyLabel: "Copy branch name",
      copySuccessMessage: "Branch name copied",
      copyValue: "omnyo/footer-move",
      label: "omnyo/footer-move",
      rowLabel: "Branch",
      title: "Copy branch name: omnyo/footer-move",
    };

    function seedThread() {
      mocks.providers = [{ id: "codex", displayName: "Codex" }];
      queryHarness.queryClient.setQueryData(
        threadQueryKey(THREAD_ID),
        makeThreadResponse({
          id: THREAD_ID,
          projectId: "proj_meta",
          providerId: "codex",
          environmentId: "env_meta",
        }),
      );
      queryHarness.queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarBootstrapResponse({
          projects: [
            makeProjectWithThreadsResponse({ id: "proj_meta", name: "Omnyo" }),
          ],
        }),
      );
      queryHarness.queryClient.setQueryData(
        environmentQueryKey("env_meta"),
        makeEnvironment({ id: "env_meta", hostId: "host_meta" }),
      );
      queryHarness.queryClient.setQueryData(hostsQueryKey(), [
        makeHost({ id: "host_meta", name: "Mac Studio" }),
      ]);
    }

    function renderHeader({
      checkout,
      environmentLabel,
    }: {
      checkout?: WorkspaceCheckoutDisplay;
      environmentLabel?: string;
    }) {
      render(
        <TooltipProvider delayDuration={0}>
          <PaneContext.Provider value={PANE_CONTEXT}>
            <ThreadDetailHeader
              actionsMenu={null}
              checkout={checkout}
              environmentLabel={environmentLabel}
              isSecondaryPanelOpen={false}
              onToggleSecondaryPanel={vi.fn()}
              threadId={THREAD_ID}
              threadTitle="Meta line"
            />
          </PaneContext.Provider>
        </TooltipProvider>,
      );
    }

    it("lists the project, environment, branch, provider and creation time in order", () => {
      seedThread();
      renderHeader({ checkout: branchCheckout, environmentLabel: "Worktree" });

      const parts = screen
        .getByTestId("thread-header-meta")
        .textContent?.split(" · ");

      expect(parts?.slice(0, 4)).toEqual([
        "Omnyo",
        "Worktree",
        "omnyo/footer-move",
        "Codex",
      ]);
      expect(parts?.at(-1)).toMatch(/^Created /);
      expect(parts).toHaveLength(5);
    });

    it("names the machine when no environment label is known", () => {
      seedThread();
      renderHeader({});

      expect(screen.getByTestId("thread-header-meta").textContent).toMatch(
        /^Omnyo · Mac Studio · Codex · Created /,
      );
    });

    it("copies the branch name from the meta line", () => {
      seedThread();
      renderHeader({ checkout: branchCheckout, environmentLabel: "Worktree" });

      const branch = screen.getByRole("button", { name: "omnyo/footer-move" });
      expect(branch.querySelector('[data-icon="GitBranch"]')).not.toBeNull();
      fireEvent.click(branch);

      expect(mocks.copyToClipboardWithToast).toHaveBeenCalledExactlyOnceWith(
        "omnyo/footer-move",
        {
          successMessage: "Branch name copied",
          errorMessage: "Failed to copy branch name",
        },
      );
    });

    it("shows a checkout it cannot copy as plain text", () => {
      seedThread();
      renderHeader({
        checkout: {
          copyErrorMessage: null,
          copyLabel: null,
          copySuccessMessage: null,
          copyValue: null,
          label: "detached HEAD",
          rowLabel: "Checkout",
          title: "Detached HEAD",
        },
        environmentLabel: "Worktree",
      });

      expect(screen.getByTestId("thread-header-meta").textContent).toContain(
        "Worktree · detached HEAD · Codex",
      );
      expect(
        screen.queryByRole("button", { name: "detached HEAD" }),
      ).toBeNull();
      expect(screen.getByTitle("Detached HEAD").textContent).toBe(
        "detached HEAD",
      );
    });
  });

  it("marks the open thread with a Shelved badge only while it is shelved", async () => {
    queryHarness.queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({ id: THREAD_ID, shelvedAt: 5 }),
    );
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Shelved chat"
        />
      </PaneContext.Provider>,
    );

    expect(await screen.findByText("Shelved")).toBeTruthy();
    queryHarness.queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({ id: THREAD_ID, shelvedAt: null }),
    );
    await waitFor(() => expect(screen.queryByText("Shelved")).toBeNull());
  });

  it("leaves the open right-panel collapse control to the panel header", () => {
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Panel state"
        />
      </PaneContext.Provider>,
    );

    expect(
      screen.queryByRole("button", { name: "Hide right panel" }),
    ).toBeNull();
  });

  it("retains the compact trigger while the open shelf hides page actions", () => {
    viewportState.isCompactViewport = true;

    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Panel state"
        />
      </PaneContext.Provider>,
    );

    const trigger = screen.getByRole("button", {
      name: "Hide right panel",
    });

    expect(trigger.closest("[data-thread-header-pane-actions]")).not.toBeNull();
  });

  it.each([
    { expectedIcon: "PanelRight", isCompactViewport: true },
    { expectedIcon: "PanelRight", isCompactViewport: false },
  ])(
    "shows the $expectedIcon glyph on the right-panel trigger",
    ({ expectedIcon, isCompactViewport }) => {
      viewportState.isCompactViewport = isCompactViewport;

      render(
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            isSecondaryPanelOpen={false}
            onToggleSecondaryPanel={vi.fn()}
            threadId={THREAD_ID}
            threadTitle="Panel state"
          />
        </PaneContext.Provider>,
      );

      const showButton = screen.getByRole("button", {
        name: "Show right panel",
      });

      expect(
        showButton.querySelector(`[data-icon="${expectedIcon}"]`),
      ).not.toBeNull();
    },
  );

  it("keeps thread Full Screen in a split header while its panel is open", () => {
    render(
      <PaneContext.Provider
        value={{
          ...PANE_CONTEXT,
          isSplitPane: true,
          secondaryPanelHost: { clear: vi.fn(), publish: vi.fn() },
          onToggleMaximize: vi.fn(),
        }}
      >
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Split panel state"
        />
      </PaneContext.Provider>,
    );

    expect(
      screen.getByRole("button", { name: /Maximize pane/ }),
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "Hide right panel" }),
    ).toBeNull();
  });

  it("moves secondary controls into overflow for narrow split panes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 360,
      top: 0,
      width: 360,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const splitContext: PaneContextValue = {
      ...PANE_CONTEXT,
      isFocused: true,
      isSplitPane: true,
      beginPaneDrag: vi.fn(),
    };

    render(
      <PaneContext.Provider value={splitContext}>
        <ThreadDetailHeader
          actionsMenu={({ includeResponsiveActions }) => (
            <>
              <span>Thread menu</span>
              {includeResponsiveActions ? (
                <span>Responsive menu actions</span>
              ) : null}
            </>
          )}
          isSecondaryPanelOpen={false}
          onClosePane={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Narrow split"
          workspaceOpenButton={<button>Open workspace</button>}
        />
      </PaneContext.Provider>,
    );

    expect(screen.queryByText("Open workspace")).toBeNull();
    expect(screen.getByText("Thread menu")).not.toBeNull();
    expect(screen.getByText("Responsive menu actions")).not.toBeNull();
    const closePane = screen.getByRole("button", { name: "Close pane" });
    expect(closePane.classList).toContain("header-pane-action-button");
    const closeIcon = closePane.querySelector('[data-icon="CloseThreadPane"]');
    expect(closeIcon).not.toBeNull();
    expect(closeIcon?.querySelectorAll("path")).toHaveLength(1);
    expect(closeIcon?.querySelector("path")?.getAttribute("d")).toContain(
      "M18 6L6.00081 17.9992",
    );
  });

  it("keeps responsive controls inline and out of the menu for wide split panes", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 40,
      height: 40,
      left: 0,
      right: 720,
      top: 0,
      width: 720,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const splitContext: PaneContextValue = {
      ...PANE_CONTEXT,
      isFocused: true,
      isSplitPane: true,
      beginPaneDrag: vi.fn(),
    };

    render(
      <PaneContext.Provider value={splitContext}>
        <ThreadDetailHeader
          actionsMenu={({ includeResponsiveActions }) => (
            <>
              <span>Thread menu</span>
              {includeResponsiveActions ? (
                <span>Responsive menu actions</span>
              ) : null}
            </>
          )}
          isSecondaryPanelOpen={false}
          onClosePane={vi.fn()}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Wide split"
          workspaceOpenButton={<button>Open workspace</button>}
        />
      </PaneContext.Provider>,
    );

    expect(screen.getByText("Open workspace")).not.toBeNull();
    expect(screen.getByText("Thread menu")).not.toBeNull();
    expect(screen.queryByText("Responsive menu actions")).toBeNull();
  });

  it("renders serialized mentions in the thread title as pills", () => {
    const { container } = render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Review @docs/foo.test.ts with @thread:thr_worker"
        />
      </PaneContext.Provider>,
    );

    expect(screen.getByTitle("docs/foo.test.ts")).not.toBeNull();
    expect(screen.getByText("thr_worker")).not.toBeNull();
    expect(
      container.querySelectorAll('[data-prompt-mention="true"]'),
    ).toHaveLength(2);
    expect(screen.queryByText("@thread:thr_worker")).toBeNull();
  });

  it("renders a raw thread id in the title as an unlinked mention pill", () => {
    const mentionedThread = makeThreadListEntry({
      id: "thr_dcwivn5n8w",
      projectId: "proj_target",
      title: "Raw title target",
      titleFallback: "Raw title target",
    });

    render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map([[mentionedThread.id, mentionedThread]])}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            isSecondaryPanelOpen={false}
            onToggleSecondaryPanel={vi.fn()}
            threadId={THREAD_ID}
            threadTitle="Continue from thr_dcwivn5n8w docs/foo.ts"
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    const pill = screen.getByText("Raw title target");
    expect(pill.closest('[data-prompt-mention="true"]')).not.toBeNull();
    expect(pill.closest("a")).toBeNull();
    expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
    expect(screen.getByText(/docs\/foo\.ts/u)).not.toBeNull();
  });

  it.each([
    ["straight closing quote", 'Review "thr_dcwivn5n8w."'],
    ["curly closing quote", "Review “thr_dcwivn5n8w.”"],
  ])(
    "renders a sentence-final raw id before a %s in a title",
    (_label, title) => {
      const mentionedThread = makeThreadListEntry({
        id: "thr_dcwivn5n8w",
        projectId: "proj_target",
        title: "Quoted title target",
        titleFallback: "Quoted title target",
      });

      render(
        <ThreadTitleMentionResourcesProvider
          sectionNamesById={new Map()}
          projectNamesById={new Map()}
          threadById={new Map([[mentionedThread.id, mentionedThread]])}
        >
          <PaneContext.Provider value={PANE_CONTEXT}>
            <ThreadDetailHeader
              actionsMenu={null}
              isSecondaryPanelOpen={false}
              onToggleSecondaryPanel={vi.fn()}
              threadId={THREAD_ID}
              threadTitle={title}
            />
          </PaneContext.Provider>
        </ThreadTitleMentionResourcesProvider>,
      );

      const pill = screen.getByText("Quoted title target");
      expect(pill.closest('[data-prompt-mention="true"]')).not.toBeNull();
      expect(pill.closest("a")).toBeNull();
      expect(screen.queryByText("thr_dcwivn5n8w")).toBeNull();
    },
  );

  it("leaves raw-id path, extension, and overlong continuations literal in titles", () => {
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([]);

    const title = [
      "thr_dcwivn5n8w.md",
      "thr_dcwivn5n8w/path",
      "thr_dcwivn5n8w2",
      "/tmp/thr_dcwivn5n8w",
      "docs/thr_dcwivn5n8w",
      "C:\\tmp\\thr_dcwivn5n8w",
      "docs\\thr_dcwivn5n8w",
      "thr_dcwivn5n8w\\logs",
    ].join(" ");

    const mentionedThread = makeThreadListEntry({
      id: "thr_dcwivn5n8w",
      title: "Should not render",
      titleFallback: "Should not render",
    });

    const { container } = render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map([[mentionedThread.id, mentionedThread]])}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            isSecondaryPanelOpen={false}
            onToggleSecondaryPanel={vi.fn()}
            threadId={THREAD_ID}
            threadTitle={title}
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    expect(container.textContent).toContain(title);
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
    expect(resolveMentions).not.toHaveBeenCalled();
  });

  it("leaves an unresolvable raw thread id literal in a title", async () => {
    const resolveMentions = vi
      .spyOn(sdk.threads, "resolveMentions")
      .mockResolvedValue([]);

    const { container } = render(
      <ThreadTitleMentionResourcesProvider
        sectionNamesById={new Map()}
        projectNamesById={new Map()}
        threadById={new Map()}
      >
        <PaneContext.Provider value={PANE_CONTEXT}>
          <ThreadDetailHeader
            actionsMenu={null}
            isSecondaryPanelOpen={false}
            onToggleSecondaryPanel={vi.fn()}
            threadId={THREAD_ID}
            threadTitle="Unknown thr_2222222222"
          />
        </PaneContext.Provider>
      </ThreadTitleMentionResourcesProvider>,
    );

    await waitFor(() => expect(resolveMentions).toHaveBeenCalledTimes(1));
    expect(container.textContent).toContain("thr_2222222222");
    expect(container.querySelector('[data-prompt-mention="true"]')).toBeNull();
  });

  it("edits the title inline after a double click and commits on Enter", async () => {
    mocks.renameThreadAsync.mockResolvedValue(undefined);
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(input).toHaveProperty("value", "Focused thread");
    expect(screen.queryByText("Focused thread")).toBeNull();

    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(mocks.renameThreadAsync).toHaveBeenCalledWith(
        THREAD_ID,
        "Renamed thread",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull(),
    );
    expect(screen.getByText("Focused thread")).not.toBeNull();
  });

  it("discards an unsaved header draft when switching threads", async () => {
    const header = (threadId: string, threadTitle: string) => (
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={threadId}
          threadTitle={threadTitle}
        />
      </PaneContext.Provider>
    );

    const { rerender } = render(header(THREAD_ID, "Focused thread"));

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    fireEvent.change(input, { target: { value: "Unsaved draft" } });

    rerender(header("thr_other", "Other thread"));

    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    expect(screen.getByText("Other thread")).not.toBeNull();
    expect(mocks.renameThreadAsync).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByText("Other thread"));
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Other thread");
  });

  it("keeps the header title out of the macOS window-drag region so double click renames", async () => {
    window.omnyoDesktop = createOmnyoDesktopApi({
      lastCheckedAt: null,
      latestVersion: null,
      pendingVersion: null,
      platform: "macos",
      updateAvailable: false,
      updateDownloaded: false,
      version: "0.0.0-test",
    });
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    const title = screen.getByText("Focused thread").closest("p");
    expect(title?.className).toContain("[-webkit-app-region:no-drag]");

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    expect(input.closest("p")?.className).toContain(
      "[-webkit-app-region:no-drag]",
    );
  });

  it("does not start a pane drag while the header title is being edited", async () => {
    const beginPaneDrag = vi.fn();
    render(
      <PaneContext.Provider
        value={{
          ...PANE_CONTEXT,
          isSplitPane: true,
          beginPaneDrag,
        }}
      >
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Focused thread"
        />
      </PaneContext.Provider>,
    );

    fireEvent.doubleClick(screen.getByText("Focused thread"));
    const input = await screen.findByRole("textbox", { name: "Thread name" });
    fireEvent.pointerDown(input, { button: 0 });

    expect(beginPaneDrag).not.toHaveBeenCalled();
  });

  function renderWithMenuArgs(focused = true) {
    const menuArgs: { current: ThreadDetailHeaderActionsMenuArgs | null } = {
      current: null,
    };

    const requestRenameDialog = vi.fn();
    render(
      <AppCommandProvider>
        <ThreadActionCollectors
          coreRegistrations={[]}
          requestRename={requestRenameDialog}
        />
        <PaneContext.Provider value={{ ...PANE_CONTEXT, isFocused: focused }}>
          <ThreadDetailHeader
            actionsMenu={(args) => {
              menuArgs.current = args;

              return null;
            }}
            isSecondaryPanelOpen={false}
            onToggleSecondaryPanel={vi.fn()}
            threadId={THREAD_ID}
            threadTitle="Focused thread"
          />
        </PaneContext.Provider>
      </AppCommandProvider>,
    );

    return { menuArgs, requestRenameDialog };
  }

  it("renames inline from the actions menu once the menu has closed on desktop", async () => {
    const { menuArgs, requestRenameDialog } = renderWithMenuArgs();
    menuArgs.current?.requestRename(THREAD_ID);
    expect(screen.queryByRole("textbox", { name: "Thread name" })).toBeNull();
    const closeEvent = new Event("focusout", { cancelable: true });
    menuArgs.current?.onCloseAutoFocus(closeEvent);

    expect(closeEvent.defaultPrevented).toBe(true);
    expect(
      await screen.findByRole("textbox", { name: "Thread name" }),
    ).toHaveProperty("value", "Focused thread");
    expect(requestRenameDialog).not.toHaveBeenCalled();
  });

  it.each([
    { compact: false, coarse: false },
    { compact: true, coarse: false },
    { compact: false, coarse: true },
    { compact: true, coarse: true },
  ])(
    "chooses rename presentation for compact=$compact coarse=$coarse",
    async ({ compact, coarse }) => {
      viewportState.isCompactViewport = compact;
      viewportState.isPointerCoarse = coarse;
      const { menuArgs, requestRenameDialog } = renderWithMenuArgs();
      const expectsDialog = compact || coarse;
      menuArgs.current?.requestRename(THREAD_ID);
      menuArgs.current?.onCloseAutoFocus(
        new Event("focusout", { cancelable: true }),
      );

      if (expectsDialog) {
        expect(requestRenameDialog).toHaveBeenCalledWith(THREAD_ID);
        expect(
          screen.queryByRole("textbox", { name: "Thread name" }),
        ).toBeNull();
      } else {
        fireEvent.keyDown(
          await screen.findByRole("textbox", { name: "Thread name" }),
          { key: "Escape" },
        );
      }

      requestRenameDialog.mockClear();
      fireEvent.keyDown(window, {
        key: "R",
        code: "KeyR",
        ctrlKey: true,
        shiftKey: true,
      });

      if (expectsDialog) {
        expect(requestRenameDialog).toHaveBeenCalledWith(THREAD_ID);
        expect(
          screen.queryByRole("textbox", { name: "Thread name" }),
        ).toBeNull();
      } else {
        fireEvent.keyDown(
          await screen.findByRole("textbox", { name: "Thread name" }),
          { key: "Escape" },
        );
      }

      requestRenameDialog.mockClear();
      fireEvent.doubleClick(screen.getByText("Focused thread"));

      if (coarse) {
        expect(requestRenameDialog).toHaveBeenCalledWith(THREAD_ID);
        expect(
          screen.queryByRole("textbox", { name: "Thread name" }),
        ).toBeNull();
      } else {
        expect(
          await screen.findByRole("textbox", { name: "Thread name" }),
        ).toHaveProperty("value", "Focused thread");
        expect(requestRenameDialog).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    [true, true],
    [false, false],
  ])(
    "starts the inline rename from the rename command when focused=%s",
    async (focused, edits) => {
      renderWithMenuArgs(focused);
      fireEvent.keyDown(window, {
        key: "R",
        code: "KeyR",
        ctrlKey: true,
        shiftKey: true,
      });

      if (edits) {
        expect(
          await screen.findByRole("textbox", { name: "Thread name" }),
        ).not.toBeNull();
      } else {
        expect(
          screen.queryByRole("textbox", { name: "Thread name" }),
        ).toBeNull();
      }
    },
  );

  describe("in a single pane under the window title bar", () => {
    function renderInTitleBar({
      onClosePane,
      pane = PANE_CONTEXT,
      menuArgs,
    }: {
      onClosePane?: () => void;
      pane?: PaneContextValue;
      menuArgs?: { current: ThreadDetailHeaderActionsMenuArgs | null };
    } = {}) {
      viewportState.titleBarHostsChrome = true;
      const pageTitle = document.createElement("div");
      const pageActions = document.createElement("div");
      document.body.append(pageTitle, pageActions);

      const view = render(
        <WindowTitleBarSlotsContext.Provider
          value={{ pageTitle, pageActions, companionToolbar: null }}
        >
          <PaneContext.Provider value={pane}>
            <ThreadDetailHeader
              actionsMenu={(args) => {
                if (menuArgs) menuArgs.current = args;

                return <button type="button">Thread actions</button>;
              }}
              isSecondaryPanelOpen={false}
              onClosePane={onClosePane}
              onToggleSecondaryPanel={vi.fn()}
              pluginActions={<button type="button">Commit</button>}
              threadId={THREAD_ID}
              threadTitle="Focused thread"
              workspaceOpenButton={<button type="button">Open in</button>}
            />
          </PaneContext.Provider>
        </WindowTitleBarSlotsContext.Provider>,
      );

      return { pageActions, pageTitle, view };
    }

    it("puts the title, badge, and menu on the left and the actions on the right, with no pane row or close", async () => {
      queryHarness.queryClient.setQueryData(
        threadQueryKey(THREAD_ID),
        makeThreadResponse({ id: THREAD_ID, shelvedAt: 5 }),
      );
      const onClosePane = vi.fn();

      const { pageActions, pageTitle, view } = renderInTitleBar({
        onClosePane,
      });

      const left = within(pageTitle);
      expect(left.getByText("Focused thread")).not.toBeNull();
      expect(await left.findByText("Shelved")).not.toBeNull();
      expect(
        left.getByRole("button", { name: "Thread actions" }),
      ).not.toBeNull();

      const right = within(pageActions);
      expect(right.getByRole("button", { name: "Commit" })).not.toBeNull();
      expect(right.getByRole("button", { name: "Open in" })).not.toBeNull();

      expect(view.container.querySelector("header")).toBeNull();
      expect(screen.queryByRole("button", { name: "Close pane" })).toBeNull();
    });

    it("renames inline from a double click on the title bar title, which stays out of the drag region", async () => {
      mocks.renameThreadAsync.mockResolvedValue(undefined);
      const { pageTitle } = renderInTitleBar();

      const title = within(pageTitle).getByText("Focused thread");
      expect(title.closest("p")?.className).toContain(
        "[-webkit-app-region:no-drag]",
      );
      fireEvent.doubleClick(title);

      const input = await within(pageTitle).findByRole("textbox", {
        name: "Thread name",
      });

      fireEvent.change(input, { target: { value: "Renamed thread" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() =>
        expect(mocks.renameThreadAsync).toHaveBeenCalledWith(
          THREAD_ID,
          "Renamed thread",
        ),
      );
    });

    it("moves the open-in button into the menu on a narrow window", () => {
      viewportState.isNarrowWindow = true;

      const menuArgs: { current: ThreadDetailHeaderActionsMenuArgs | null } = {
        current: null,
      };

      const { pageActions } = renderInTitleBar({ menuArgs });

      expect(
        within(pageActions).queryByRole("button", { name: "Open in" }),
      ).toBeNull();
      expect(menuArgs.current?.includeResponsiveActions).toBe(true);
    });

    it("keeps each split pane's own header row and leaves the title bar empty", () => {
      const { pageActions, pageTitle, view } = renderInTitleBar({
        onClosePane: vi.fn(),
        pane: { ...PANE_CONTEXT, isSplitPane: true },
      });

      expect(pageTitle.childElementCount).toBe(0);
      expect(pageActions.childElementCount).toBe(0);
      const header = view.container.querySelector("header");
      expect(header).not.toBeNull();
      expect(
        within(header as HTMLElement).getByText("Focused thread"),
      ).not.toBeNull();
      expect(screen.getByRole("button", { name: "Close pane" })).not.toBeNull();
    });
  });
});

describe("compact thread header", () => {
  function seedCompactThread() {
    queryHarness.queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({
        id: THREAD_ID,
        serviceTier: "default",
        shelvedAt: 5,
      }),
    );
  }

  function renderCompactHeader({
    pane = PANE_CONTEXT,
    menuArgs,
  }: {
    pane?: PaneContextValue;
    menuArgs?: { current: ThreadDetailHeaderActionsMenuArgs | null };
  } = {}) {
    setPluginSlotRegistrations(
      "header-fixture",
      makePluginRegistrationSet({
        threadHeaderActions: [
          {
            id: "branch",
            title: "Branch",
            component: () => <button type="button">Plugin branch</button>,
          },
        ],
      }),
    );

    return render(
      <MemoryRouter>
        <PaneContext.Provider value={pane}>
          <ThreadDetailHeader
            actionsMenu={(args) => {
              if (menuArgs) menuArgs.current = args;

              return <button type="button">Thread actions</button>;
            }}
            isSecondaryPanelOpen={false}
            onClosePane={vi.fn()}
            onToggleSecondaryPanel={vi.fn()}
            pluginActions={
              <>
                <button type="button">Continued from parent</button>
                <PluginThreadHeaderActions
                  threadId={THREAD_ID}
                  projectId="proj_header"
                />
              </>
            }
            threadId={THREAD_ID}
            threadTitle="Paraspeech > Support > Daily triage"
            workspaceOpenButton={<button type="button">Open in</button>}
          />
        </PaneContext.Provider>
      </MemoryRouter>,
    );
  }

  afterEach(() => {
    resetPluginSlotStoreForTest();
  });

  it("keeps only the title, one thread menu and the panel toggle at phone width", async () => {
    viewportState.isCompactViewport = true;
    seedCompactThread();

    const menuArgs: { current: ThreadDetailHeaderActionsMenuArgs | null } = {
      current: null,
    };

    const { container } = renderCompactHeader({ menuArgs });
    const header = container.querySelector("header") as HTMLElement;

    await waitFor(() =>
      expect(
        queryHarness.queryClient.getQueryData(threadQueryKey(THREAD_ID)),
      ).toBeDefined(),
    );

    expect(
      within(header)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).toEqual(["Thread actions", "Show right panel"]);
    expect(
      within(header).getByText("Paraspeech > Support > Daily triage"),
    ).not.toBeNull();
    expect(screen.queryByText("Plugin branch")).toBeNull();
    expect(screen.queryByText("Shelved")).toBeNull();
    expect(screen.queryByText("Normal")).toBeNull();
    expect(screen.queryByLabelText("Session speed")).toBeNull();
    expect(menuArgs.current).toMatchObject({
      includeResponsiveActions: true,
      isCompactViewport: true,
    });
  });

  it("keeps Close pane in a real split at phone width", () => {
    viewportState.isCompactViewport = true;
    renderCompactHeader({ pane: { ...PANE_CONTEXT, isSplitPane: true } });

    expect(screen.getByRole("button", { name: "Close pane" })).not.toBeNull();
    expect(screen.queryByText("Plugin branch")).toBeNull();
  });

  it("mounts plugin header actions and Close pane inline on wider layouts", async () => {
    seedCompactThread();

    const menuArgs: { current: ThreadDetailHeaderActionsMenuArgs | null } = {
      current: null,
    };

    renderCompactHeader({ menuArgs });

    expect(await screen.findByText("Plugin branch")).not.toBeNull();
    expect(screen.getByText("Continued from parent")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Close pane" })).not.toBeNull();
    expect(await screen.findByText("Shelved")).not.toBeNull();
    expect(menuArgs.current?.isCompactViewport).toBe(false);
  });
});

it.each([false, true])(
  "never shows a session speed badge (compact=%s)",
  async (isCompactViewport) => {
    viewportState.isCompactViewport = isCompactViewport;
    queryHarness.queryClient.setQueryData(
      threadQueryKey(THREAD_ID),
      makeThreadResponse({ id: THREAD_ID, serviceTier: "fast", shelvedAt: 5 }),
    );
    render(
      <PaneContext.Provider value={PANE_CONTEXT}>
        <ThreadDetailHeader
          actionsMenu={null}
          isSecondaryPanelOpen={false}
          onToggleSecondaryPanel={vi.fn()}
          threadId={THREAD_ID}
          threadTitle="Speed test"
        />
      </PaneContext.Provider>,
    );

    if (!isCompactViewport)
      expect(await screen.findByText("Shelved")).not.toBeNull();
    expect(screen.queryByLabelText("Session speed")).toBeNull();
    expect(screen.queryByText("Fast")).toBeNull();
  },
);

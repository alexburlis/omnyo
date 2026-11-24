// @vitest-environment jsdom

import {
  useMemo,
  type ComponentProps,
  type ComponentType,
  type ReactNode,
} from "react";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { PluginThreadViewProps } from "@omnyo/plugin-sdk";
import { CompactViewportOverrideProvider } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { TooltipProvider } from "@omnyo/shared-ui/tooltip";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  usePluginComposerHost,
  usePluginComposerHostDraft,
  usePublishPluginComposerHost,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import {
  getPromptDraftAccessor,
  usePromptDraftStorage,
} from "@/hooks/usePromptDraftStorage";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import { makePluginRegistrationSet } from "@/test/fixtures/plugins";
import { ThreadDetailSecondaryContent } from "./ThreadDetailSecondaryContent";
import {
  DefaultPaneContextProvider,
  PaneContext,
  type PaneContextValue,
  type PaneSecondaryPanelViewModel,
} from "./PaneContext";

type ThreadDetailSecondaryContentProps = ComponentProps<
  typeof ThreadDetailSecondaryContent
>;

const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("@/components/ui/app-toast", () => ({ appToast: toast }));

const secondaryPanelMockState = vi.hoisted(() => ({
  renderActualPanel: false,
  renderBrowserDeck: undefined as
    | ((
        activeBrowserTabId: string,
        pane: {
          isFocused: boolean;
          onFocusPane: () => void;
        },
      ) => ReactNode)
    | undefined,
}));

vi.mock("@/lib/omnyo-desktop", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/omnyo-desktop")>()),
  DEFAULT_DESKTOP_WINDOW_STATE: { isFullScreen: false },
  getOmnyoDesktopInfo: () => null,
  shouldReserveMacosTrafficLights: () => false,
  shouldUseMacosDesktopChrome: () => false,
}));

vi.mock("@/components/ui/sidebar.js", () => ({
  useOptionalIsSidebarShowing: () => true,
  useSidebarKeepsCollapsedRail: () => false,
  useIsSidebarFramed: () => false,
}));

const { useThreadsMock } = vi.hoisted(() => ({
  useThreadsMock: vi.fn((..._args: unknown[]) => ({ data: [] })),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThreads: useThreadsMock,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();

  return {
    ...actual,
    useAtomValue: (atom: Parameters<typeof actual.useAtomValue>[0]) =>
      secondaryPanelMockState.renderActualPanel
        ? actual.useAtomValue(atom)
        : 50,
  };
});

vi.mock("react-resizable-panels", async () => {
  const React = await import("react");

  const PanelGroup = React.forwardRef<
    {
      getLayout: () => number[];
      setLayout: (layout: number[]) => void;
    },
    { children?: ReactNode }
  >(({ children }, ref) => {
    React.useImperativeHandle(
      ref,
      () => ({ getLayout: () => [50, 50], setLayout: () => {} }),
      [],
    );

    return React.createElement(
      "div",
      { "data-testid": "panel-group" },
      children,
    );
  });

  PanelGroup.displayName = "MockPanelGroup";

  const Panel = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", { "data-testid": "panel" }, children);

  const PanelResizeHandle = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);

  return { Panel, PanelGroup, PanelResizeHandle };
});

vi.mock(
  "@/components/secondary-panel/ThreadMetadataContent",
  async (importOriginal) => {
    const React = await import("react");

    const actual =
      await importOriginal<
        typeof import("@/components/secondary-panel/ThreadMetadataContent")
      >();

    return {
      ...actual,
      ThreadMetadataCard: ({
        children,
      }: ComponentProps<typeof actual.ThreadMetadataCard>) =>
        React.createElement(
          "div",
          { "data-testid": "metadata-card" },
          children,
        ),
      ThreadMetadataContent: (
        _props: ComponentProps<typeof actual.ThreadMetadataContent>,
      ) => React.createElement("div", { "data-testid": "metadata-content" }),
      hasAnyThreadMetadata: () => false,
    };
  },
);

vi.mock(
  "@/components/secondary-panel/ThreadSecondaryPanel",
  async (importOriginal) => {
    const React = await import("react");

    const actual =
      await importOriginal<
        typeof import("@/components/secondary-panel/ThreadSecondaryPanel")
      >();

    const ThreadSecondaryPanel = (
      props: ComponentProps<typeof actual.ThreadSecondaryPanel>,
    ) => {
      const { renderBrowserDeck, metadataContent, renderAsDrawer } = props;

      if (secondaryPanelMockState.renderActualPanel) {
        return React.createElement(actual.ThreadSecondaryPanel, props);
      }

      secondaryPanelMockState.renderBrowserDeck = renderBrowserDeck;

      return React.createElement(
        "section",
        {
          "data-testid": renderAsDrawer
            ? "drawer-secondary-panel"
            : "inline-secondary-panel",
        },
        metadataContent,
      );
    };

    return { ...actual, ThreadSecondaryPanel };
  },
);

const { timelinePaneRenders } = vi.hoisted(() => ({
  timelinePaneRenders: vi.fn(),
}));

vi.mock("./ThreadTimelinePane", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<typeof import("./ThreadTimelinePane")>();

  const ThreadTimelinePane = ({
    footer,
    threadId,
  }: ComponentProps<typeof actual.ThreadTimelinePane>) => {
    timelinePaneRenders();

    return React.createElement(
      "div",
      {
        "data-testid": "thread-timeline-pane",
        "data-thread-id": threadId,
      },
      footer,
    );
  };

  return { ...actual, ThreadTimelinePane };
});

const noop = () => {};

let publishedHostedPanel: PaneSecondaryPanelViewModel | null = null;

const hostedPaneRegistration = {
  clear: () => {
    publishedHostedPanel = null;
  },
  publish: (model: PaneSecondaryPanelViewModel) => {
    publishedHostedPanel = model;
  },
};

function FooterComposerHostPublisher({ threadId }: { threadId: string }) {
  const promptDraft = usePromptDraftStorage({
    kind: "thread",
    projectId: "proj-test",
    threadId,
  });

  const host = useMemo<PluginComposerHost>(
    () => ({
      scope: { kind: "thread", threadId },
      textEffectKey: promptDraft.storageKey,
      getCurrent: promptDraft.getCurrent,
      subscribeDraft: promptDraft.subscribe,
      setDraft: promptDraft.setDraft,
      focus: () => {},
    }),
    [
      promptDraft.getCurrent,
      promptDraft.setDraft,
      promptDraft.storageKey,
      promptDraft.subscribe,
      threadId,
    ],
  );

  usePublishPluginComposerHost(host);

  return <FooterComposerDraftProbe />;
}

function FooterComposerDraftProbe() {
  const draft = usePluginComposerHostDraft(usePluginComposerHost());

  return <div data-testid="footer-composer-draft">{draft?.text ?? ""}</div>;
}

function makeThread(): ThreadDetailSecondaryContentProps["metadata"]["thread"] {
  return {
    archivedAt: null,
    createdAt: 0,
    deletedAt: null,
    environmentId: null,
    id: "thread-1",
    lastReadAt: null,
    latestAttentionAt: 0,
    lastMessageAt: null,
    parentThreadId: null,
    pinnedAt: null,
    shelvedAt: null,
    projectId: "proj-test",
    providerId: "codex",
    claudeProfileBinding: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    pluginHome: false,
    quiet: false,
    status: "idle",
    stopRequestedAt: null,
    title: null,
    titleFallback: "Test thread",
    sectionId: null,
    groupId: null,
    updatedAt: 0,
  } as ThreadDetailSecondaryContentProps["metadata"]["thread"];
}

function createProps(
  isMetadataLoading = false,
  isConversationCollapsed = false,
): ThreadDetailSecondaryContentProps {
  return {
    footer: <div data-testid="footer" />,
    header: <div data-testid="header" />,
    isBoundedPane: false,
    isConversationCollapsed,
    isMetadataLoading,
    isSecondaryPanelOpen: true,
    metadata: {
      canAssignToParent: false,
      canTakeOverThread: false,
      environment: null,
      environmentProvisioningFailure: false,
      environmentDisplayHost: { locality: "local", identity: null },
      isLoadingMergeBaseBranchOptions: false,
      mergeBaseBranchOptions: undefined,
      onAssignParent: noop,
      onParentSelectorOpenChange: noop,
      onRetryParentThreads: noop,
      onMergeBaseBranchChange: noop,
      parentThreadProjectId: null,
      parentThreadDisplayName: null,
      parentThreads: [],
      isLoadingParentThreads: false,
      isParentThreadsError: false,
      projectId: "proj-test",
      pullRequest: null,
      selectedMergeBaseBranch: undefined,
      thread: makeThread(),
      threadSchedules: [],
      updateThreadPending: false,
      workspaceStatus: undefined,
      workspaceStatusError: null,
    } as ThreadDetailSecondaryContentProps["metadata"],
    onToggleConversationCollapse: noop,
    onToggleSecondaryPanel: noop,
    renderHostedPanel: (panel) => panel,
    secondaryPanel: {
      activeTab: null,
      canUseGitUi: false,
      tabs: [],
      fixedTabs: [],
      isOpen: true,
      onCollapse: noop,
      onClose: noop,
      onTabReorder: noop,
      onOpenNewTab: noop,
      onPanelFocus: noop,
      renderBrowserDeck: () => null,
    },
    timeline: {
      activeThinking: null,
      hasOlderTimelineRows: false,
      isLoadingOlderTimelineRows: false,
      isThreadTimelinePending: false,
      onLoadOlderRows: noop,
      resolveMentionLink: () => null,
      showOngoingIndicator: false,
      stopRequestedAt: null,
      threadId: "thread-1",
      threadRuntimeDisplayStatus: "idle",
      timelineError: false,
      timelineRows: [],
      unreadDividerAutoScroll: false,
      unreadDividerPlacement: null,
      workspaceRootPath: undefined,
    } as unknown as ThreadDetailSecondaryContentProps["timeline"],
  };
}

function renderThreadDetail(
  hosted: boolean,
  isMetadataLoading = false,
  isConversationCollapsed = false,
) {
  const content = (
    <CompactViewportOverrideProvider isCompactViewport={false}>
      <ThreadDetailSecondaryContent
        {...createProps(isMetadataLoading, isConversationCollapsed)}
      />
    </CompactViewportOverrideProvider>
  );

  if (!hosted) {
    return render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          {content}
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );
  }

  const value: PaneContextValue = {
    paneId: "pane-test",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: hostedPaneRegistration,
    reservesWindowPanelToggle: false,
    onRequestClose: noop,
    isMaximized: false,
    onToggleMaximize: noop,
    isBoundedPane: true,
    isTopRow: true,
    ownsWindowTopLeft: true,
    navigateInPane: noop,
  };

  return render(
    <PaneContext.Provider value={value}>{content}</PaneContext.Provider>,
  );
}

afterEach(() => {
  cleanup();
  publishedHostedPanel = null;
  secondaryPanelMockState.renderActualPanel = false;
  secondaryPanelMockState.renderBrowserDeck = undefined;
  timelinePaneRenders.mockClear();
  useThreadsMock.mockClear();
  window.localStorage.clear();
  resetPluginSlotStoreForTest();
  resetAllCrashedPluginSlotsForTest();
  toast.error.mockClear();
});

describe("ThreadDetailSecondaryContent", () => {
  it("publishes the hosted panel and keeps the header interactive while the main pane is collapsed", () => {
    renderThreadDetail(true, false, true);

    expect(screen.getByTestId("header").closest("[inert]")).toBeNull();
    expect(
      screen.getByTestId("thread-timeline-pane").closest("[inert]"),
    ).not.toBeNull();

    if (publishedHostedPanel === null) {
      throw new Error("Expected the focused pane to publish its panel model");
    }

    expect(publishedHostedPanel).toMatchObject({
      contentKey: "thread-1",
      isMainCollapsed: true,
    });
  });

  it("keeps the panel's own hide control for the inline thread panel", async () => {
    secondaryPanelMockState.renderActualPanel = true;
    const { wrapper: QueryWrapper } = createQueryClientTestHarness();
    render(
      <QueryWrapper>
        <TooltipProvider>
          <MemoryRouter>
            <DefaultPaneContextProvider
              onRequestClose={null}
              navigateInPane={noop}
            >
              <CompactViewportOverrideProvider isCompactViewport={false}>
                <ThreadDetailSecondaryContent {...createProps()} />
              </CompactViewportOverrideProvider>
            </DefaultPaneContextProvider>
          </MemoryRouter>
        </TooltipProvider>
      </QueryWrapper>,
    );

    expect(
      await screen.findByRole(
        "button",
        { name: "Hide right panel" },
        { timeout: 5_000 },
      ),
    ).not.toBeNull();
  });

  it("keeps the thread header inside the timeline column beside the panel", async () => {
    renderThreadDetail(false);

    const sidePanel = await screen.findByTestId(
      "inline-secondary-panel",
      {},
      { timeout: 5_000 },
    );

    const timelinePanel = screen.getByTestId("panel");
    const panelGroup = screen.getByTestId("panel-group");
    expect(timelinePanel.contains(screen.getByTestId("header"))).toBe(true);
    expect(timelinePanel.contains(sidePanel)).toBe(false);
    expect(panelGroup.contains(timelinePanel)).toBe(true);
    expect(panelGroup.contains(sidePanel)).toBe(true);
    expect(timelinePanel.contains(screen.getByTestId("footer"))).toBe(true);
    expect(sidePanel.textContent).toContain("No thread details available.");
  });

  it("keeps the thread metadata loading presentation in the panel", async () => {
    renderThreadDetail(false, true);

    expect(
      (await screen.findByTestId("inline-secondary-panel")).contains(
        screen.getByTestId("metadata-card"),
      ),
    ).toBe(true);
  });

  it("pins a split browser pane to its tab and gates native commands by pane focus", async () => {
    const renderBrowserDeck = vi.fn(() => null);
    const props = createProps();
    props.secondaryPanel.renderBrowserDeck = renderBrowserDeck;

    render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("inline-secondary-panel");
    const panelBrowserDeck = secondaryPanelMockState.renderBrowserDeck;
    expect(panelBrowserDeck).toBeDefined();

    if (panelBrowserDeck === undefined) return;

    const onFocusPane = vi.fn();
    panelBrowserDeck("browser-split", {
      isFocused: true,
      onFocusPane,
    });
    expect(renderBrowserDeck).toHaveBeenLastCalledWith({
      activeBrowserTabId: "browser-split",
      canHandleBrowserCommands: true,
      canShowNativeBrowserView: true,
      onNativeFocus: onFocusPane,
    });

    panelBrowserDeck("browser-split", {
      isFocused: false,
      onFocusPane,
    });
    expect(renderBrowserDeck).toHaveBeenLastCalledWith({
      activeBrowserTabId: "browser-split",
      canHandleBrowserCommands: false,
      canShowNativeBrowserView: true,
      onNativeFocus: onFocusPane,
    });
  });

  it("keeps the panel subtree mounted when navigating between threads", async () => {
    const props = createProps();

    const { rerender } = render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    const sidePanel = await screen.findByTestId(
      "inline-secondary-panel",
      {},
      { timeout: 5_000 },
    );

    const panelGroup = screen.getByTestId("panel-group");

    const nextProps = createProps();
    nextProps.timeline = {
      ...nextProps.timeline,
      threadId: "thread-2",
    } as ThreadDetailSecondaryContentProps["timeline"];
    rerender(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...nextProps} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId("panel-group")).toBe(panelGroup);
    expect(screen.getByTestId("inline-secondary-panel")).toBe(sidePanel);
    expect(
      screen.getByTestId("thread-timeline-pane").getAttribute("data-thread-id"),
    ).toBe("thread-2");
  });

  it("only requests the forks list while the secondary panel is open", () => {
    const props = createProps();

    const { rerender } = render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent
              {...props}
              isSecondaryPanelOpen={false}
            />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(useThreadsMock).toHaveBeenLastCalledWith(
      {
        projectId: "proj-test",
        sourceThreadId: "thread-1",
        originKind: "fork",
        archived: false,
      },
      { enabled: false },
    );

    rerender(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} isSecondaryPanelOpen />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    expect(useThreadsMock).toHaveBeenLastCalledWith(expect.anything(), {
      enabled: true,
    });
  });

  it("does not re-render the timeline pane while the composer draft changes", async () => {
    const props = createProps();
    props.footer = <FooterComposerHostPublisher threadId="thread-1" />;
    render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("inline-secondary-panel", {}, { timeout: 5_000 });
    expect(screen.getByTestId("footer-composer-draft").textContent).toBe("");
    const paneRendersAfterMount = timelinePaneRenders.mock.calls.length;

    const accessor = getPromptDraftAccessor({
      kind: "thread",
      projectId: "proj-test",
      threadId: "thread-1",
    });

    const typed = "why does typing hang";

    for (let index = 1; index <= typed.length; index += 1) {
      const text = typed.slice(0, index);
      act(() => {
        accessor.setDraft({ text, mentions: [], attachments: [] });
      });
      expect(screen.getByTestId("footer-composer-draft").textContent).toBe(
        text,
      );
    }

    expect(timelinePaneRenders.mock.calls.length).toBe(paneRendersAfterMount);
  });
});

function registerThreadView(
  pluginId: string,
  component: ComponentType<PluginThreadViewProps>,
) {
  setPluginSlotRegistrations(
    pluginId,
    makePluginRegistrationSet({
      threadViews: [{ id: "view", title: "Canvas", component }],
    }),
  );
}

describe("ThreadDetailSecondaryContent thread view slot", () => {
  it("renders the timeline pane with its composer when no plugin registers a view", () => {
    renderThreadDetail(false);

    const pane = screen.getByTestId("thread-timeline-pane");
    expect(within(pane).getByTestId("footer")).toBeTruthy();
    expect(screen.getAllByTestId("footer")).toHaveLength(1);
  });

  it("gives the registered view its thread and a default view that reproduces the core pane", () => {
    const received: PluginThreadViewProps[] = [];
    registerThreadView("canvas", (props) => {
      received.push(props);

      return <div data-testid="plugin-view">{props.defaultView}</div>;
    });

    renderThreadDetail(false);

    expect(received.at(-1)).toMatchObject({
      threadId: "thread-1",
      projectId: "proj-test",
      isCompactViewport: false,
    });

    const view = screen.getByTestId("plugin-view");
    const pane = within(view).getByTestId("thread-timeline-pane");
    expect(pane.getAttribute("data-thread-id")).toBe("thread-1");
    expect(within(pane).getByTestId("footer")).toBeTruthy();
    expect(screen.getAllByTestId("footer")).toHaveLength(1);
    expect(
      screen.getByTestId("panel").contains(screen.getByTestId("header")),
    ).toBe(true);
    expect(view.contains(screen.getByTestId("header"))).toBe(false);
  });

  it("renders the transcript without the composer and the composer on its own", () => {
    registerThreadView("canvas", ({ transcript, composer }) => (
      <div data-testid="plugin-view">
        <div data-testid="slot-transcript">{transcript}</div>
        <div data-testid="slot-composer">{composer}</div>
      </div>
    ));

    renderThreadDetail(false);

    const transcript = screen.getByTestId("slot-transcript");
    expect(within(transcript).getByTestId("thread-timeline-pane")).toBeTruthy();
    expect(within(transcript).queryByTestId("footer")).toBeNull();
    expect(
      within(screen.getByTestId("slot-composer")).getByTestId("footer"),
    ).toBeTruthy();
    expect(screen.getAllByTestId("footer")).toHaveLength(1);
  });

  it("keeps a standalone composer publishing its draft to the thread's composer host", async () => {
    registerThreadView("canvas", ({ composer }) => (
      <div data-testid="plugin-view">{composer}</div>
    ));

    const props = createProps();
    props.footer = <FooterComposerHostPublisher threadId="thread-1" />;
    render(
      <MemoryRouter>
        <DefaultPaneContextProvider onRequestClose={null} navigateInPane={noop}>
          <CompactViewportOverrideProvider isCompactViewport={false}>
            <ThreadDetailSecondaryContent {...props} />
          </CompactViewportOverrideProvider>
        </DefaultPaneContextProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId("inline-secondary-panel", {}, { timeout: 5_000 });

    act(() => {
      getPromptDraftAccessor({
        kind: "thread",
        projectId: "proj-test",
        threadId: "thread-1",
      }).setDraft({ text: "draw it", mentions: [], attachments: [] });
    });

    expect(
      within(screen.getByTestId("plugin-view")).getByTestId(
        "footer-composer-draft",
      ).textContent,
    ).toBe("draw it");
    expect(screen.queryByTestId("thread-timeline-pane")).toBeNull();
  });

  it("falls back to the default pane and reports the crash when the view throws", () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerThreadView("canvas", () => {
      throw new Error("canvas failed");
    });

    renderThreadDetail(false);

    const pane = screen.getByTestId("thread-timeline-pane");
    expect(within(pane).getByTestId("footer")).toBeTruthy();
    expect(toast.error).toHaveBeenCalledWith("Thread view plugin crashed", {
      description: "Canvas (canvas) stopped working.",
    });
    consoleError.mockRestore();
    consoleWarn.mockRestore();
  });

  it("activates only the first registered view in slot order", () => {
    registerThreadView("zeta", () => <div data-testid="zeta-view" />);
    registerThreadView("alpha", () => <div data-testid="alpha-view" />);

    renderThreadDetail(false);

    expect(screen.getByTestId("alpha-view")).toBeTruthy();
    expect(screen.queryByTestId("zeta-view")).toBeNull();
  });
});

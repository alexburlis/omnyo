import { useEffect, type ReactNode } from "react";
import type {
  OmnyoDesktopApi,
  OmnyoDesktopBrowserApi,
  OmnyoDesktopBrowserControlState,
  OmnyoDesktopBrowserState,
  OmnyoDesktopBrowserTarget,
  OmnyoDesktopInfo,
} from "@omnyo/desktop-contract";
import { getBrowserHistoryStorageKey } from "@/lib/browser-history";
import type { BrowserFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import { Icon } from "@omnyo/shared-ui/icon";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import { BrowserTabDeck } from "./BrowserTabDeck";
import {
  ThreadSecondaryPanel,
  type SecondaryPanelRenderableTab,
} from "./ThreadSecondaryPanel";

export default {
  title: "right-panel/Browser tab states",
};

const noop = () => {};

const STORY_THREAD_PREFIX = "thr_browser_states_story";

const STORY_DESKTOP_INFO: OmnyoDesktopInfo = {
  lastCheckedAt: null,
  latestVersion: null,
  pendingVersion: null,
  platform: "macos",
  updateAvailable: false,
  updateDownloaded: false,
  version: "0.0.0-story",
};

interface StoryBrowserSetup {
  states: readonly OmnyoDesktopBrowserState[];
  controls?: readonly OmnyoDesktopBrowserControlState[];
  windowTarget?: OmnyoDesktopBrowserTarget;
}

function createStoryBrowserApi(
  setup: StoryBrowserSetup,
): OmnyoDesktopBrowserApi {
  return {
    attach() {},
    detach() {},
    navigate() {},
    goBack() {},
    goForward() {},
    reload() {},
    stop() {},
    setBounds() {},
    setVisible() {},
    onState(listener) {
      let subscribed = true;
      queueMicrotask(() => {
        if (!subscribed) return;

        for (const state of setup.states) listener(state);
      });

      return () => {
        subscribed = false;
      };
    },
    onOpenTab() {
      return () => {};
    },
    async getControl(tabId) {
      return setup.controls?.find((control) => control.tabId === tabId) ?? null;
    },
    releaseControl() {},
    onControl() {
      return () => {};
    },
    ...(setup.windowTarget === undefined
      ? {}
      : {
          async getTarget() {
            return setup.windowTarget ?? null;
          },
        }),
  };
}

function installStoryDesktop(setup: StoryBrowserSetup | null): void {
  if (typeof window === "undefined") return;

  if (setup === null) {
    delete window.omnyoDesktop;

    return;
  }

  const api: OmnyoDesktopApi = {
    ...STORY_DESKTOP_INFO,
    browser: createStoryBrowserApi(setup),
    async checkForUpdates() {
      return STORY_DESKTOP_INFO;
    },
    async getInfo() {
      return STORY_DESKTOP_INFO;
    },
    async installUpdate() {},
    onChange() {
      return () => {};
    },
    setTheme() {},
    openExternalUrl() {},
  };

  window.omnyoDesktop = api;
}

function WithStoryDesktop({
  setup,
  children,
}: {
  setup: StoryBrowserSetup | null;
  children: ReactNode;
}) {
  installStoryDesktop(setup);
  useEffect(() => {
    return () => {
      if (typeof window !== "undefined") {
        delete window.omnyoDesktop;
      }
    };
  }, []);

  return <>{children}</>;
}

function makeTab(
  id: string,
  url: string,
  desktopTarget?: OmnyoDesktopBrowserTarget,
): BrowserFixedPanelTab {
  return {
    environmentId: null,
    id,
    kind: "browser",
    title: null,
    url,
    ...(desktopTarget === undefined ? {} : { desktopTarget }),
  };
}

function errorState(
  tab: BrowserFixedPanelTab,
  errorText: string,
): OmnyoDesktopBrowserState {
  return {
    tabId: tab.id,
    url: tab.url,
    title: null,
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    errorText,
  };
}

function BrowserStage({
  tab,
  height = 420,
}: {
  tab: BrowserFixedPanelTab;
  height?: number;
}) {
  const threadId = `${STORY_THREAD_PREFIX}_${tab.id}`;

  if (typeof window !== "undefined") {
    window.localStorage.removeItem(getBrowserHistoryStorageKey(threadId));
  }

  const panelTabs: SecondaryPanelRenderableTab[] = [
    {
      label: "Browser",
      leadingVisual: <Icon name="Globe" className="size-3.5" aria-hidden />,
      statusLabel: null,
      onSelect: noop,
      onClose: noop,
      renderContent: () => null,
      tab,
    },
  ];

  return (
    <div
      className="flex w-full max-w-[760px] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background"
      style={{ height }}
    >
      <ThreadSecondaryPanel
        activeTab={tab}
        canUseGitUi={false}
        requestedMergeBaseBranch="main"
        environmentId={undefined}
        tabs={panelTabs}
        fixedTabs={[]}
        renderBrowserDeck={(activeBrowserTabId) => (
          <BrowserTabDeck
            browserTabs={[tab]}
            activeBrowserTabId={activeBrowserTabId}
            canShowNativeBrowserView
            threadId={threadId}
            environmentId={null}
            onUpdate={noop}
          />
        )}
        isConversationCollapsed={false}
        isOpen
        metadataContent={null}
        onClose={noop}
        onCollapse={noop}
        onTabReorder={noop}
        onOpenNewTab={noop}
        onPanelFocus={noop}
        onToggleConversationCollapse={noop}
        renderAsDrawer
      />
    </div>
  );
}

const LOCAL_TAB = makeTab("browser:local", "http://localhost:5173/");

const DNS_TAB = makeTab("browser:dns", "https://docs.exmaple.com/start");

const OFFLINE_TAB = makeTab("browser:offline", "https://react.dev/learn");

const CERT_TAB = makeTab("browser:cert", "https://staging.internal.test/");

const TIMEOUT_TAB = makeTab("browser:timeout", "https://slow.example.com/");

const CRASH_TAB = makeTab("browser:crash", "https://example.com/heavy");

export function PageErrors() {
  return (
    <WithStoryDesktop
      setup={{
        states: [
          errorState(LOCAL_TAB, "ERR_CONNECTION_REFUSED"),
          errorState(DNS_TAB, "ERR_NAME_NOT_RESOLVED"),
          errorState(OFFLINE_TAB, "ERR_INTERNET_DISCONNECTED"),
          errorState(CERT_TAB, "ERR_CERT_AUTHORITY_INVALID"),
          errorState(TIMEOUT_TAB, "ERR_CONNECTION_TIMED_OUT"),
          errorState(CRASH_TAB, "The page renderer stopped repeatedly"),
        ],
      }}
    >
      <StoryCard>
        <StoryRow
          label="local server not running"
          hint="a localhost address refused the connection; Try again is the one primary action"
        >
          <BrowserStage tab={LOCAL_TAB} />
        </StoryRow>
        <StoryRow label="address not found" hint="ERR_NAME_NOT_RESOLVED">
          <BrowserStage tab={DNS_TAB} />
        </StoryRow>
        <StoryRow label="offline" hint="ERR_INTERNET_DISCONNECTED">
          <BrowserStage tab={OFFLINE_TAB} />
        </StoryRow>
        <StoryRow label="certificate problem" hint="ERR_CERT_*">
          <BrowserStage tab={CERT_TAB} />
        </StoryRow>
        <StoryRow label="timed out" hint="ERR_CONNECTION_TIMED_OUT">
          <BrowserStage tab={TIMEOUT_TAB} />
        </StoryRow>
        <StoryRow label="page crashed" hint="the renderer stopped repeatedly">
          <BrowserStage tab={CRASH_TAB} />
        </StoryRow>
      </StoryCard>
    </WithStoryDesktop>
  );
}

const CONTROLLED_TAB = makeTab("browser:controlled", "");

export function AgentControl() {
  return (
    <WithStoryDesktop
      setup={{
        states: [],
        controls: [
          {
            tabId: CONTROLLED_TAB.id,
            threadId: `${STORY_THREAD_PREFIX}_${CONTROLLED_TAB.id}`,
            control: {
              leaseId: "lease_story",
              controllerLabel: "Codex",
              expiresAt: Date.now() + 60 * 60 * 1000,
            },
          },
        ],
      }}
    >
      <StoryCard>
        <StoryRow
          label="agent is using the tab"
          hint="banner names the agent, explains the risk, and offers Take over (soft) and End control (ghost); hover either for what it does"
        >
          <BrowserStage tab={CONTROLLED_TAB} height={460} />
        </StoryRow>
      </StoryCard>
    </WithStoryDesktop>
  );
}

export function StartPage() {
  return (
    <WithStoryDesktop setup={{ states: [] }}>
      <StoryCard>
        <StoryRow
          label="new tab, no history"
          hint="a fresh tab explains what to do instead of showing an empty page"
        >
          <BrowserStage tab={makeTab("browser:start", "")} />
        </StoryRow>
      </StoryCard>
    </WithStoryDesktop>
  );
}

const OTHER_COMPUTER_TAB = makeTab(
  "browser:elsewhere",
  "https://github.com/omnyo/omnyo/pull/128",
  { hostId: "host_other", instanceId: "inst_other", generation: "1" },
);

export function OpenElsewhere() {
  return (
    <WithStoryDesktop
      setup={{
        states: [],
        windowTarget: {
          hostId: "host_this",
          instanceId: "inst_this",
          generation: "1",
        },
      }}
    >
      <StoryCard>
        <StoryRow
          label="open on another computer"
          hint="the tab belongs to another computer's desktop app; the link stays copyable"
        >
          <BrowserStage tab={OTHER_COMPUTER_TAB} />
        </StoryRow>
      </StoryCard>
    </WithStoryDesktop>
  );
}

export function DesktopRequired() {
  return (
    <WithStoryDesktop setup={null}>
      <StoryCard>
        <StoryRow
          label="web app"
          hint="browser tabs only run in the desktop app"
        >
          <BrowserStage tab={makeTab("browser:web", "")} height={340} />
        </StoryRow>
      </StoryCard>
    </WithStoryDesktop>
  );
}

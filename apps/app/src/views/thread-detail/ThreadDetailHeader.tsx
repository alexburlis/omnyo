import { preloadThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { useSidebarNavigation } from "@/hooks/queries/sidebar-navigation-query";
import { useSystemProviders } from "@/hooks/queries/system-queries";
import { useThread } from "@/hooks/queries/thread-queries";
import {
  Fragment,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Badge } from "@omnyo/shared-ui/badge";
import { Button } from "@omnyo/shared-ui/button";
import { useAtomValue } from "jotai";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import {
  getOmnyoDesktopInfo,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/omnyo-desktop";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { WorkspaceCheckoutDisplay } from "@/lib/workspace-checkout-display";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { appCommandTarget } from "@/lib/app-command-targets";
import { useSidebarRename } from "@/components/sidebar/SidebarInlineRename";
import { useThreadActions } from "@/lib/thread-actions/thread-actions-context";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import { useDefaultRequestRename } from "@/lib/thread-actions/thread-action-registry";
import { getThreadLifecycle } from "@/lib/thread-lifecycle";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import { RIGHT_PANEL_TOGGLE_ICON_NAME } from "@/components/secondary-panel/panelToggleControlState";
import { useWindowTitleBarHostsRightPanelToggle } from "@/components/layout/WindowRightPanelToggle";
import {
  usePageTitleBarSlots,
  WindowTitleBarChrome,
} from "@/components/layout/page-title-bar-chrome";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@omnyo/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { useMediaQuery } from "@omnyo/shared-ui/hooks/use-media-query";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@omnyo/shared-ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";

const NARROW_SPLIT_HEADER_MAX_WIDTH = 560;

const NARROW_TITLE_BAR_QUERY = "(max-width: 1023px)";

export interface ThreadDetailHeaderActionsMenuArgs {
  includeResponsiveActions: boolean;
  isCompactViewport: boolean;
  requestRename: (threadId: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}

interface ThreadDetailHeaderProps {
  actionsMenu: ((args: ThreadDetailHeaderActionsMenuArgs) => ReactNode) | null;
  checkout?: WorkspaceCheckoutDisplay;
  environmentLabel?: string;
  isSecondaryPanelOpen: boolean;
  onClosePane?: () => void;
  onToggleSecondaryPanel: () => void;
  pluginActions?: ReactNode;
  threadId: string;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
}

export function ThreadDetailHeader({
  actionsMenu,
  checkout,
  environmentLabel,
  isSecondaryPanelOpen,
  onClosePane,
  onToggleSecondaryPanel,
  pluginActions,
  threadId,
  threadTitle,
  workspaceOpenButton,
}: ThreadDetailHeaderProps) {
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const { renameThreadAsync } = useThreadActions();

  const handleRename = useCallback(
    (nextTitle: string) => renameThreadAsync(threadId, nextTitle),
    [renameThreadAsync, threadId],
  );

  const { editor, isEditing, startEditing } = useSidebarRename({
    kind: "thread",
    id: threadId,
    name: threadTitle,
    label: "Thread name",
    onSave: handleRename,
  });

  const requestRenameDialog = useDefaultRequestRename();
  const pendingMenuRename = useRef(false);

  const requestRename = (id: string) => {
    if (isCompactViewport || isPointerCoarse) requestRenameDialog(id);
    else startEditing();
  };

  const requestRenameFromMenu = (id: string) => {
    if (isCompactViewport || isPointerCoarse) requestRenameDialog(id);
    else pendingMenuRename.current = true;
  };

  const handleActionsMenuCloseAutoFocus = (event: Event) => {
    if (!pendingMenuRename.current) return;
    pendingMenuRename.current = false;
    event.preventDefault();
    startEditing();
  };

  const [desktopInfo] = useState(getOmnyoDesktopInfo);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const headerRef = useRef<HTMLElement>(null!);

  const {
    beginPaneDrag,
    isFocused,
    isSplitPane,
    isTopRow,
    ownsWindowTopLeft,
    reservesWindowPanelToggle,
    secondaryPanelHost,
  } = usePaneContext();

  const titleBarSlots = usePageTitleBarSlots();

  const titleBarHostsRightPanelToggle =
    useWindowTitleBarHostsRightPanelToggle();

  const isNarrowTitleBar = useMediaQuery(NARROW_TITLE_BAR_QUERY);

  const hostsChromeInTitleBar = titleBarSlots !== null;

  useAppCommandHandler("thread.rename", () => {
    if (!isFocused) return false;
    requestRename(threadId);

    return true;
  });

  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;

  const isSplitPaneHeader = beginPaneDrag !== undefined;
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState(0);

  const usesResponsiveActionOverflow =
    isCompactViewport ||
    (hostsChromeInTitleBar && isNarrowTitleBar) ||
    (isSplitPaneHeader &&
      measuredPaneWidth > 0 &&
      measuredPaneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH);

  useLayoutEffect(() => {
    if (!isSplitPaneHeader) {
      return;
    }

    const header = headerRef.current;
    const pane = header.closest<HTMLElement>("[data-split-pane-id]");
    const measuredElement = pane ?? header;

    const measure = () => {
      const width = measuredElement.getBoundingClientRect().width;

      if (width > 0) {
        setMeasuredPaneWidth(width);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measuredElement);

    return () => {
      observer.disconnect();
    };
  }, [isSplitPaneHeader]);

  const handleTitlePointerDown = (event: ReactPointerEvent) => {
    if (isEditing || !beginPaneDrag || event.button !== 0) {
      return;
    }

    beginPaneDrag(event, threadTitle);
  };

  const handleTitleDoubleClick = () => {
    if (isEditing) {
      return;
    }

    if (isPointerCoarse) requestRenameDialog(threadId);
    else startEditing();
  };

  const rightPanelLabel = isSecondaryPanelOpen
    ? "Hide right panel"
    : "Show right panel";

  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;

  const showRightPanelToggle =
    !titleBarHostsRightPanelToggle &&
    secondaryPanelHost === null &&
    (!isSecondaryPanelOpen || isCompactViewport);

  const menu =
    actionsMenu == null ? null : (
      <span
        className={cn(
          "flex items-center",
          (usesDesktopChrome || hostsChromeInTitleBar) &&
            MACOS_WINDOW_NO_DRAG_CLASS,
        )}
      >
        {actionsMenu({
          includeResponsiveActions: usesResponsiveActionOverflow,
          isCompactViewport,
          requestRename: requestRenameFromMenu,
          onCloseAutoFocus: handleActionsMenuCloseAutoFocus,
        })}
      </span>
    );

  const showsClosePane =
    onClosePane !== undefined && (!isCompactViewport || isSplitPane);

  const workflowActions = isCompactViewport ? null : (
    <div
      className={cn(
        "flex items-center gap-1.5",
        !hostsChromeInTitleBar && "-mx-1 min-w-0 shrink overflow-x-clip px-1",
      )}
      data-thread-header-workflow-actions=""
    >
      {pluginActions}
      {!usesResponsiveActionOverflow && workspaceOpenButton ? (
        <span className="inline-flex" data-thread-header-responsive-action="">
          {workspaceOpenButton}
        </span>
      ) : null}
    </div>
  );

  if (hostsChromeInTitleBar) {
    return (
      <WindowTitleBarChrome
        slots={titleBarSlots}
        title={
          <>
            <div className="flex min-w-0 flex-col justify-center">
              <p
                data-testid="thread-title-bar-title"
                className={cn(
                  "min-w-0 text-sm font-semibold text-sidebar-foreground",
                  isEditing ? "flex flex-1 overflow-visible" : "truncate",
                  MACOS_WINDOW_NO_DRAG_CLASS,
                )}
                onDoubleClick={handleTitleDoubleClick}
              >
                {isEditing ? editor : <ThreadTitle title={threadTitle} />}
              </p>
              <ThreadHeaderMeta
                checkout={checkout}
                environmentLabel={environmentLabel}
                placement="titleBar"
                threadId={threadId}
                usesDesktopChrome={usesDesktopChrome}
              />
            </div>
            <ThreadShelvedBadge threadId={threadId} />
            {menu}
          </>
        }
        actions={workflowActions}
      />
    );
  }

  const center = (
    <>
      <div
        data-pane-header-focus-tab={
          isSplitPaneHeader && isFocused ? "" : undefined
        }
        className={cn(
          "relative min-w-0",
          isSplitPaneHeader &&
            "-my-1 -ml-2 rounded-md px-2 py-1 transition-colors",
          isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
        )}
      >
        <p
          className={cn(
            "relative min-w-0 text-sm font-normal transition-colors",
            isEditing && "overflow-visible",
            isSplitPaneHeader &&
              !isFocused &&
              dimsInactiveSplits &&
              CONTEXT_INACTIVE_TEXT_CLASS,
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            beginPaneDrag && !isEditing && "cursor-grab touch-none select-none",
          )}
          onDoubleClick={handleTitleDoubleClick}
          onPointerDown={beginPaneDrag ? handleTitlePointerDown : undefined}
        >
          {isEditing ? editor : <ThreadTitle title={threadTitle} />}
        </p>
        {isSplitPaneHeader || isCompactViewport ? null : (
          <ThreadHeaderMeta
            checkout={checkout}
            environmentLabel={environmentLabel}
            placement="header"
            threadId={threadId}
            usesDesktopChrome={usesDesktopChrome}
          />
        )}
      </div>
      {isCompactViewport ? null : <ThreadShelvedBadge threadId={threadId} />}
      {menu}
    </>
  );

  const actions = (
    <>
      {workflowActions}
      <div
        className="ml-1 flex shrink-0 items-center gap-0.5"
        data-thread-header-pane-actions=""
      >
        <PaneMaximizeButton />
        {showsClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            )}
            aria-label="Close pane"
            onClick={onClosePane}
          >
            <Icon name="CloseThreadPane" />
          </Button>
        ) : null}
        {showRightPanelToggle ? (
          <span className="inline-flex items-center gap-1.5">
            <AppCommandShortcutHint shortcut={panelShortcut} />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                HEADER_ICON_BUTTON_CLASS,
                CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              )}
              {...appCommandTarget("panel.toggle")}
              aria-label={
                panelShortcut
                  ? `${rightPanelLabel} (${panelShortcut.label})`
                  : rightPanelLabel
              }
              aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
              aria-expanded={isSecondaryPanelOpen}
              onPointerEnter={preloadThreadSecondaryPanel}
              onFocus={preloadThreadSecondaryPanel}
              onPointerDown={preloadThreadSecondaryPanel}
              onClick={onToggleSecondaryPanel}
            >
              <Icon name={rightPanelIconName} />
            </Button>
          </span>
        ) : null}
        {reservesWindowPanelToggle &&
        !isWindowPanelOpen &&
        !titleBarHostsRightPanelToggle ? (
          <span aria-hidden className={HEADER_ICON_BUTTON_CLASS} />
        ) : null}
      </div>
    </>
  );

  return (
    <AppPageHeader
      headerRef={headerRef}
      center={center}
      actions={actions}
      isWindowDragRegion={isTopRow}
      ownsWindowTopLeft={ownsWindowTopLeft}
      className={beginPaneDrag ? "z-[21]" : undefined}
    />
  );
}

function ThreadShelvedBadge({ threadId }: { threadId: string }) {
  const { data: thread } = useThread(threadId);

  if (thread === undefined || getThreadLifecycle(thread) !== "shelved") {
    return null;
  }

  return (
    <Badge
      variant="outline"
      className="shrink-0 text-2xs font-normal text-muted-foreground"
    >
      Shelved
    </Badge>
  );
}

const CREATED_RECENT_FORMAT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const CREATED_OLDER_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});

const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;

export function formatThreadCreatedAt(createdAt: number, now: number): string {
  return now - createdAt < SIX_DAYS_MS
    ? CREATED_RECENT_FORMAT.format(createdAt)
    : CREATED_OLDER_FORMAT.format(createdAt);
}

interface ThreadHeaderMetaProps {
  checkout: WorkspaceCheckoutDisplay | undefined;
  environmentLabel: string | undefined;
  placement: "header" | "titleBar";
  threadId: string;
  usesDesktopChrome: boolean;
}

function ThreadHeaderMeta({
  checkout,
  environmentLabel,
  placement,
  threadId,
  usesDesktopChrome,
}: ThreadHeaderMetaProps) {
  const { data: thread } = useThread(threadId);
  const { data: navigation } = useSidebarNavigation();
  const { data: environment } = useEnvironment(thread?.environmentId);
  const { data: hosts } = useHosts();
  const { data: providers } = useSystemProviders();

  if (!thread) return null;

  const projectName = navigation?.projects.find(
    (project) => project.id === thread.projectId,
  )?.name;

  const providerName = providers?.find(
    (provider) => provider.id === thread.providerId,
  )?.displayName;

  const hostName = environment
    ? hosts?.find((host) => host.id === environment.hostId)?.name
    : undefined;

  const segments = [
    { key: "project", content: projectName },
    { key: "environment", content: environmentLabel ?? hostName },
    {
      key: "checkout",
      content: checkout ? (
        <ThreadHeaderCheckout
          checkout={checkout}
          usesDesktopChrome={usesDesktopChrome}
        />
      ) : null,
    },
    { key: "provider", content: providerName },
    {
      key: "created",
      content: `Created ${formatThreadCreatedAt(thread.createdAt, Date.now())}`,
    },
  ].filter((segment) => Boolean(segment.content));

  return (
    <p
      data-testid="thread-header-meta"
      className={cn(
        "truncate text-muted-foreground",
        placement === "header" ? "mt-0.5 text-xs" : "text-2xs leading-tight",
      )}
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index === 0 ? null : " · "}
          {segment.content}
        </Fragment>
      ))}
    </p>
  );
}

const THREAD_HEADER_CHECKOUT_CLASS =
  "inline-flex h-[1lh] max-w-full items-center gap-1 align-top";

function ThreadHeaderCheckout({
  checkout,
  usesDesktopChrome,
}: {
  checkout: WorkspaceCheckoutDisplay;
  usesDesktopChrome: boolean;
}) {
  const content = (
    <>
      <Icon name="GitBranch" className="size-[1.1em] shrink-0" aria-hidden />
      <span className="truncate">{checkout.label}</span>
    </>
  );

  const copyValue = checkout.copyValue;

  if (copyValue === null) {
    return (
      <span className={THREAD_HEADER_CHECKOUT_CLASS} title={checkout.title}>
        {content}
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            THREAD_HEADER_CHECKOUT_CLASS,
            "cursor-pointer rounded-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
          onClick={() => {
            void copyToClipboardWithToast(copyValue, {
              successMessage: checkout.copySuccessMessage ?? "Value copied",
              errorMessage: checkout.copyErrorMessage ?? "Failed to copy value",
            });
          }}
        >
          {content}
        </button>
      </TooltipTrigger>
      <TooltipContent>{checkout.title}</TooltipContent>
    </Tooltip>
  );
}

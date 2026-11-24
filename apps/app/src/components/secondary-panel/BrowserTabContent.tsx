import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type {
  OmnyoDesktopBrowserApi,
  OmnyoDesktopBrowserControl,
  OmnyoDesktopBrowserFindInPageRequest,
  OmnyoDesktopBrowserState,
  OmnyoDesktopBrowserTarget,
  OmnyoDesktopBrowserViewportBounds,
  OmnyoDesktopBrowserViewBounds,
} from "@omnyo/desktop-contract";
import {
  OMNYO_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH,
  clampOmnyoDesktopBrowserViewBounds,
} from "@omnyo/desktop-contract";
import {
  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
  COARSE_POINTER_TEXT_SM_CLASS,
} from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { getOmnyoDesktopInfo, getDesktopBrowserApi } from "@/lib/omnyo-desktop";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  getBrowserUrlSecurity,
  resolveBrowserAddressInput,
} from "@/lib/browser-url";
import { useBrowserHistory } from "@/lib/browser-history";
import { BROWSER_VIEW_BOUNDS_SYNC_EVENT } from "@/lib/browser-view-bounds-sync";
import { useIsBrowserDimmingModalOpen } from "@/hooks/useBrowserDimmingModal";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import {
  BrowserChromeIconButton,
  BrowserFindBar,
  type BrowserFindMatches,
} from "./BrowserFindBar";
import { BrowserNewTabScreen } from "./BrowserNewTabScreen";
import {
  BrowserStatePage,
  describeBrowserPageLoadError,
} from "./BrowserStatePage";
import {
  registerBrowserView,
  takeBrowserViewRecreation,
  type BrowserViewVisibilityCoordinator,
} from "./browserViewVisibilityCoordinator";
import { useIsBrowserViewOccluded } from "./useIsBrowserViewOccluded";
import { SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS } from "./panelChromeClasses";
import type { UpdateBrowserTabArgs } from "./useThreadFileTabs";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { appCommandTarget } from "@/lib/app-command-targets";
import type { AppShortcutPresentation } from "@/lib/app-keybindings";
import { PluginBrowserToolbarActions } from "@/components/plugin/PluginBrowserToolbarActions";

interface BrowserTabContentProps {
  tabId: string;
  desktopTarget?: OmnyoDesktopBrowserTarget;
  existingOnly?: true;
  initialUrl: string;
  addressFocusRequest: BrowserAddressFocusRequest | null;
  onAddressFocusRequestConsumed?: (request: BrowserAddressFocusRequest) => void;
  canShowNativeBrowserView: boolean;
  canHandleBrowserCommands?: boolean;
  onNativeFocus?: () => void;
  visibilityCoordinator: BrowserViewVisibilityCoordinator | null;
  environmentId: string | null;
  threadId: string;
  onUpdate: (args: UpdateBrowserTabArgs) => void;
}

export interface BrowserAddressFocusRequest {
  requestId: number;
  tabId: string;
}

interface BrowserChromeProps {
  addressDraft: string;
  isEditing: boolean;
  state: OmnyoDesktopBrowserState | null;
  currentUrl: string;
  addressInputRef: RefObject<HTMLInputElement | null>;
  onAddressChange: (value: string) => void;
  onAddressFocus: () => void;
  onAddressBlur: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onForward: () => void;
  onReloadOrStop: () => void;
  onOpenExternal: () => void;
  locationShortcut: AppShortcutPresentation | null;
  reloadShortcut: AppShortcutPresentation | null;
  pluginActions: ReactNode;
}

interface BrowserViewBoundsFromElementArgs {
  element: HTMLElement;
}

interface BrowserViewBoundsEqualArgs {
  a: OmnyoDesktopBrowserViewBounds;
  b: OmnyoDesktopBrowserViewBounds;
}

interface SyncBrowserViewPlacementArgs {
  force: boolean;
}

interface BrowserViewAttachIdentity {
  environmentId: string | null;
  tabId: string;
  threadId: string;
}

interface BrowserPageLoadErrorProps {
  errorText: string;
  onOpenExternal: () => void;
  onRetry: () => void;
  url: string;
}

const EMPTY_BROWSER_VIEW_BOUNDS: OmnyoDesktopBrowserViewBounds = {
  x: 0,
  y: 0,
  width: 0,
  height: 0,
};

function roundedBoundsFromRect(rect: DOMRect): OmnyoDesktopBrowserViewBounds {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function browserViewportBounds(): OmnyoDesktopBrowserViewportBounds {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function browserViewBoundsFromElement(
  args: BrowserViewBoundsFromElementArgs,
): OmnyoDesktopBrowserViewBounds {
  return clampOmnyoDesktopBrowserViewBounds({
    bounds: roundedBoundsFromRect(args.element.getBoundingClientRect()),
    viewport: browserViewportBounds(),
  });
}

function browserViewBoundsEqual(args: BrowserViewBoundsEqualArgs): boolean {
  return (
    args.a.x === args.b.x &&
    args.a.y === args.b.y &&
    args.a.width === args.b.width &&
    args.a.height === args.b.height
  );
}

function BrowserChrome({
  addressDraft,
  isEditing,
  state,
  currentUrl,
  addressInputRef,
  onAddressChange,
  onAddressFocus,
  onAddressBlur,
  onSubmit,
  onBack,
  onForward,
  onReloadOrStop,
  onOpenExternal,
  locationShortcut,
  reloadShortcut,
  pluginActions,
}: BrowserChromeProps) {
  const isLoading = state?.isLoading ?? false;
  const security = getBrowserUrlSecurity(currentUrl);
  const addressValue = isEditing ? addressDraft : currentUrl;

  return (
    <div
      role="region"
      aria-label="Browser navigation"
      tabIndex={-1}
      className={cn(
        "relative h-11 shrink-0 overflow-hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring max-md:pointer-coarse:h-[52px]",
        SECONDARY_PANEL_TOP_CHROME_BACKGROUND_CLASS,
      )}
    >
      <div className="absolute inset-x-0 top-0 flex h-11 items-center gap-1 py-1.5 pl-2 pr-4 max-md:pointer-coarse:h-[52px]">
        <BrowserChromeIconButton
          icon="ChevronLeft"
          label="Go back"
          disabled={!(state?.canGoBack ?? false)}
          onClick={onBack}
        />
        <BrowserChromeIconButton
          icon="ChevronRight"
          label="Go forward"
          disabled={!(state?.canGoForward ?? false)}
          onClick={onForward}
        />
        <BrowserChromeIconButton
          icon={isLoading ? "X" : "RotateCcw"}
          label={isLoading ? "Stop loading" : "Reload"}
          shortcut={isLoading ? null : reloadShortcut}
          command={isLoading ? undefined : "browser.reload"}
          onClick={onReloadOrStop}
        />
        <form onSubmit={onSubmit} className="min-w-0 flex-1">
          <div
            {...appCommandTarget("browser.focusLocation")}
            className="flex h-8 items-center gap-2 rounded-full border border-border/70 bg-background/70 px-3 max-md:pointer-coarse:h-10"
          >
            {security === "secure" ? (
              <Icon
                name="Lock"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-success",
                )}
                aria-label="Secure connection"
              />
            ) : security === "insecure" ? (
              <Icon
                name="AlertTriangle"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-warning",
                )}
                aria-label="Connection not secure"
              />
            ) : (
              <Icon
                name="Search"
                className={cn(
                  COARSE_POINTER_COMPACT_ICON_SIZE_SHRINK_CLASS,
                  "text-muted-foreground",
                )}
                aria-hidden
              />
            )}
            <input
              ref={addressInputRef}
              type="text"
              value={addressValue}
              onChange={(event) => onAddressChange(event.target.value)}
              onFocus={onAddressFocus}
              onBlur={onAddressBlur}
              placeholder="Enter a URL"
              aria-label={
                locationShortcut
                  ? `Address and search bar (${locationShortcut.label})`
                  : "Address and search bar"
              }
              aria-keyshortcuts={locationShortcut?.ariaKeyshortcuts}
              autoComplete="off"
              spellCheck={false}
              className={cn(
                "min-w-0 flex-1 bg-transparent font-mono text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground",
                COARSE_POINTER_TEXT_SM_CLASS,
              )}
            />
          </div>
        </form>
        {pluginActions}
        <BrowserChromeIconButton
          icon="ExternalLink"
          label="Open in external browser"
          disabled={currentUrl.length === 0}
          onClick={onOpenExternal}
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 bottom-0 h-0.5 overflow-hidden transition-opacity duration-(--motion-duration-fast)",
            isLoading ? "opacity-100" : "opacity-0",
          )}
        >
          <span
            className={cn(
              "block h-full w-1/3 animate-indeterminate-progress bg-ring/70",
              !isLoading && "[animation-play-state:paused]",
            )}
          />
        </span>
      </div>
    </div>
  );
}

function BrowserUnavailable() {
  return (
    <BrowserStatePage
      icon="Laptop"
      title="Browser tabs need the desktop app"
      description="The in-app browser runs in the Omnyo desktop app. Open this chat there to browse the web."
    />
  );
}

function BrowserPageLoadError({
  errorText,
  onOpenExternal,
  onRetry,
  url,
}: BrowserPageLoadErrorProps) {
  const copy = describeBrowserPageLoadError({ errorText, url });

  return (
    <div role="alert" className="h-full">
      <BrowserStatePage
        icon={copy.icon}
        tone="error"
        title={copy.title}
        description={copy.description}
        detailLabel="Error"
        detail={errorText}
        actions={
          <>
            <Button type="button" size="sm" onClick={onRetry}>
              <Icon name="RotateCcw" aria-hidden />
              Try again
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onOpenExternal}
            >
              <Icon name="ExternalLink" aria-hidden />
              Open in your browser
            </Button>
          </>
        }
      />
    </div>
  );
}

function BrowserControlBanner({
  controllerLabel,
  onStop,
  onTakeOver,
}: {
  controllerLabel: string;
  onStop: () => void;
  onTakeOver: () => void;
}) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2.5 border-b border-border bg-surface-recessed px-3 py-2"
    >
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-state-hover text-foreground">
        <Icon name="Bot" className="size-3.5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">
          {controllerLabel} is using this tab
        </p>
        <p className="truncate text-xs text-muted-foreground">
          Clicks and typing here could interrupt it.
        </p>
      </div>
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="xs" onClick={onStop}>
              End control
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Take this tab away from {controllerLabel}. The agent keeps running.
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="soft" size="xs" onClick={onTakeOver}>
              Take over
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            Take this tab away from {controllerLabel} and start using it.
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

export function BrowserTabContent({
  tabId,
  desktopTarget,
  existingOnly,
  initialUrl,
  addressFocusRequest,
  onAddressFocusRequestConsumed,
  canShowNativeBrowserView,
  canHandleBrowserCommands = canShowNativeBrowserView,
  onNativeFocus,
  visibilityCoordinator,
  environmentId,
  threadId,
  onUpdate,
}: BrowserTabContentProps) {
  const locationShortcut = useAppCommandShortcut("browser.focusLocation");
  const reloadShortcut = useAppCommandShortcut("browser.reload");
  const findShortcut = useAppCommandShortcut("browser.find");

  const desktopBrowser = useMemo<OmnyoDesktopBrowserApi | null>(
    () => getDesktopBrowserApi(),
    [],
  );

  const contentRef = useRef<HTMLDivElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const isPointerCoarse = usePointerCoarse();
  const isCompactViewport = useIsCompactViewport();

  const {
    entries: recent,
    recordVisit,
    clear: clearRecent,
  } = useBrowserHistory(threadId);

  const [state, setState] = useState<OmnyoDesktopBrowserState | null>(null);

  const [control, setControl] = useState<OmnyoDesktopBrowserControl | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    let receivedEvent = false;
    setControl(null);

    const accept = (next: {
      tabId: string;
      threadId: string;
      control: OmnyoDesktopBrowserControl | null;
    }) => {
      if (current && next.tabId === tabId && next.threadId === threadId)
        setControl(next.control);
    };

    const unsubscribe = desktopBrowser?.onControl?.((next) => {
      if (next.tabId !== tabId || next.threadId !== threadId) return;
      receivedEvent = true;
      accept(next);
    });

    void desktopBrowser
      ?.getControl?.(tabId)
      .then((next) => {
        if (next !== null && !receivedEvent) accept(next);
      })
      .catch(() => undefined);

    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [desktopBrowser, tabId, threadId]);
  const [currentUrl, setCurrentUrl] = useState(initialUrl);
  const [addressDraft, setAddressDraft] = useState(initialUrl);
  const [isEditing, setIsEditing] = useState(false);
  const [isPageFocusPending, setIsPageFocusPending] = useState(false);
  const [isFindOpen, setIsFindOpen] = useState(false);
  const isFindOpenRef = useRef(false);
  isFindOpenRef.current = isFindOpen;
  const [findQuery, setFindQuery] = useState("");

  const [findMatches, setFindMatches] = useState<BrowserFindMatches | null>(
    null,
  );

  const [resizeSnapshotUrl, setResizeSnapshotUrl] = useState<string | null>(
    null,
  );

  const onUpdateRef = useRef(onUpdate);
  const recordVisitRef = useRef(recordVisit);
  onUpdateRef.current = onUpdate;
  recordVisitRef.current = recordVisit;
  const initialUrlRef = useRef(initialUrl);
  const existingOnlyRef = useRef(existingOnly);
  const desktopTargetRef = useRef(desktopTarget);

  const [attachedBrowserViewIdentity, setAttachedBrowserViewIdentity] =
    useState<BrowserViewAttachIdentity | null>(null);

  const isBrowserViewAttached =
    attachedBrowserViewIdentity !== null &&
    attachedBrowserViewIdentity.environmentId === environmentId &&
    attachedBrowserViewIdentity.tabId === tabId &&
    attachedBrowserViewIdentity.threadId === threadId;

  const hasPage = currentUrl.length > 0;

  const supportsNativePaneFocus =
    desktopBrowser?.focus !== undefined &&
    desktopBrowser.onFocus !== undefined &&
    desktopBrowser.setVisibleWithoutFocus !== undefined;

  const pageLoadErrorText = state?.errorText ?? null;
  const hasPageLoadError = pageLoadErrorText !== null && hasPage;
  const isBrowserDimmingModalOpen = useIsBrowserDimmingModalOpen();

  const isBrowserViewOccluded = useIsBrowserViewOccluded(
    contentRef,
    desktopBrowser !== null && hasPage,
  );

  const lastSentBoundsRef = useRef<OmnyoDesktopBrowserViewBounds | null>(null);

  const readBounds = useCallback(() => {
    const element = contentRef.current;

    if (element === null) {
      return null;
    }

    return browserViewBoundsFromElement({ element });
  }, []);

  const sendBounds = useCallback(
    (bounds: OmnyoDesktopBrowserViewBounds) => {
      if (desktopBrowser === null) {
        return;
      }

      lastSentBoundsRef.current = bounds;
      desktopBrowser.setBounds({ tabId, bounds });
    },
    [desktopBrowser, tabId],
  );

  const syncPlacement = useCallback(
    ({ force }: SyncBrowserViewPlacementArgs) => {
      const bounds = readBounds();

      if (bounds === null) {
        return;
      }

      const lastSentBounds = lastSentBoundsRef.current;

      if (
        !force &&
        lastSentBounds !== null &&
        browserViewBoundsEqual({ a: lastSentBounds, b: bounds })
      ) {
        return;
      }

      sendBounds(bounds);
    },
    [readBounds, sendBounds],
  );

  const syncBounds = useCallback(() => {
    syncPlacement({ force: true });
  }, [syncPlacement]);

  const syncBoundsIfChanged = useCallback(() => {
    syncPlacement({ force: false });
  }, [syncPlacement]);

  const syncInitialBounds = useCallback(() => {
    const bounds = readBounds();
    lastSentBoundsRef.current = bounds;

    return bounds ?? EMPTY_BROWSER_VIEW_BOUNDS;
  }, [readBounds]);

  useEffect(() => {
    if (desktopBrowser === null) {
      return;
    }

    const initialBounds = syncInitialBounds();
    const mountUrl = initialUrlRef.current;
    registerBrowserView({ environmentId, tabId, threadId });
    const target = desktopTargetRef.current;

    const attachExistingOnly =
      existingOnlyRef.current === true &&
      (target === undefined || !takeBrowserViewRecreation(tabId, target));

    desktopBrowser.attach({
      tabId,
      threadId,
      ...(attachExistingOnly ? { existingOnly: true } : {}),
      url: mountUrl,
      bounds: initialBounds,
      visible: false,
    });
    setAttachedBrowserViewIdentity({ environmentId, tabId, threadId });

    let lastSeenState: OmnyoDesktopBrowserState | null = null;

    const unsubscribe = desktopBrowser.onState((nextState) => {
      if (nextState.tabId !== tabId) {
        return;
      }

      if (
        lastSeenState !== null &&
        (lastSeenState.url !== nextState.url ||
          (nextState.isLoading && !lastSeenState.isLoading))
      ) {
        setFindMatches(null);
      }

      lastSeenState = nextState;
      setState(nextState);
      setCurrentUrl(nextState.url);
      onUpdateRef.current({
        tabId,
        url: nextState.url,
        title: nextState.title,
      });

      if (!nextState.isLoading && nextState.url.length > 0) {
        recordVisitRef.current({
          url: nextState.url,
          title: nextState.title,
        });
      }
    });

    const unsubscribeSnapshot = desktopBrowser.onSnapshot?.((snapshot) => {
      if (snapshot.tabId !== tabId) {
        return;
      }

      setResizeSnapshotUrl(snapshot.dataUrl);
    });

    const unsubscribeFindResult = desktopBrowser.onFindResult?.((result) => {
      if (result.tabId !== tabId) {
        return;
      }

      setFindMatches({
        activeMatchOrdinal: result.activeMatchOrdinal,
        matches: result.matches,
      });
    });

    return () => {
      unsubscribe();
      unsubscribeSnapshot?.();
      unsubscribeFindResult?.();

      if (isFindOpenRef.current) {
        desktopBrowser.stopFindInPage?.({ tabId, action: "clearSelection" });
      }

      visibilityCoordinator?.release(tabId);
    };
  }, [
    desktopBrowser,
    environmentId,
    syncInitialBounds,
    visibilityCoordinator,
    tabId,
    threadId,
  ]);

  useEffect(() => {
    const element = contentRef.current;

    if (element === null || desktopBrowser === null) {
      return;
    }

    const observer = new ResizeObserver(() => {
      syncBoundsIfChanged();
    });

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [desktopBrowser, syncBoundsIfChanged]);

  useEffect(() => {
    if (desktopBrowser === null) {
      return;
    }

    window.addEventListener(
      BROWSER_VIEW_BOUNDS_SYNC_EVENT,
      syncBoundsIfChanged,
    );
    window.addEventListener("resize", syncBoundsIfChanged);

    return () => {
      window.removeEventListener(
        BROWSER_VIEW_BOUNDS_SYNC_EVENT,
        syncBoundsIfChanged,
      );
      window.removeEventListener("resize", syncBoundsIfChanged);
    };
  }, [desktopBrowser, syncBoundsIfChanged]);

  const isViewVisible =
    canShowNativeBrowserView &&
    (canHandleBrowserCommands || supportsNativePaneFocus) &&
    hasPage &&
    !hasPageLoadError &&
    isBrowserViewAttached &&
    !isBrowserDimmingModalOpen &&
    !isBrowserViewOccluded;

  useLayoutEffect(() => {
    if (visibilityCoordinator === null) {
      return;
    }

    if (isViewVisible) {
      visibilityCoordinator.show(tabId, syncBounds, {
        focus: false,
      });

      return () => {
        visibilityCoordinator.hide(tabId);
      };
    }

    visibilityCoordinator.hide(tabId);
  }, [visibilityCoordinator, tabId, isViewVisible, syncBounds]);

  useLayoutEffect(() => {
    if (!isPageFocusPending) return;

    if (
      !canShowNativeBrowserView ||
      !canHandleBrowserCommands ||
      hasPageLoadError ||
      isBrowserDimmingModalOpen
    ) {
      setIsPageFocusPending(false);

      return;
    }

    if (!isViewVisible) return;
    setIsPageFocusPending(false);
    desktopBrowser?.focus?.(tabId);
  }, [
    isPageFocusPending,
    canShowNativeBrowserView,
    canHandleBrowserCommands,
    hasPageLoadError,
    isBrowserDimmingModalOpen,
    isViewVisible,
    desktopBrowser,
    tabId,
  ]);

  useEffect(() => {
    if (desktopBrowser?.onFocus === undefined || onNativeFocus === undefined) {
      return;
    }

    return desktopBrowser.onFocus((focusedTabId) => {
      if (focusedTabId === tabId) onNativeFocus();
    });
  }, [desktopBrowser, onNativeFocus, tabId]);

  useEffect(() => {
    if (addressFocusRequest === null) {
      return;
    }

    if (addressFocusRequest.tabId !== tabId) {
      return;
    }

    if (isPointerCoarse) {
      onAddressFocusRequestConsumed?.(addressFocusRequest);

      return;
    }

    setAddressDraft(currentUrl);
    setIsEditing(true);
    addressInputRef.current?.focus({ preventScroll: true });

    const frame = requestAnimationFrame(() => {
      addressInputRef.current?.focus({ preventScroll: true });
      onAddressFocusRequestConsumed?.(addressFocusRequest);
    });

    return () => cancelAnimationFrame(frame);
  }, [
    addressFocusRequest,
    currentUrl,
    isPointerCoarse,
    onAddressFocusRequestConsumed,
    tabId,
  ]);

  const navigateToInput = useCallback(
    (rawInput: string) => {
      const url = resolveBrowserAddressInput(rawInput);

      if (url === null) {
        return;
      }

      setCurrentUrl(url);
      setIsEditing(false);
      addressInputRef.current?.blur();
      desktopBrowser?.navigate({ tabId, url });
      setIsPageFocusPending(true);
    },
    [desktopBrowser, tabId],
  );

  const handleAddressSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      navigateToInput(addressDraft);
    },
    [addressDraft, navigateToInput],
  );

  const handleAddressFocus = useCallback(() => {
    setAddressDraft(currentUrl);
    setIsEditing(true);
  }, [currentUrl]);

  const handleStartPromptFocusAddress = useCallback(() => {
    addressInputRef.current?.focus();
  }, []);

  const handleReloadOrStop = useCallback(() => {
    if (state?.isLoading ?? false) {
      desktopBrowser?.stop(tabId);

      return;
    }

    desktopBrowser?.reload(tabId);
  }, [desktopBrowser, state?.isLoading, tabId]);

  const handleFocusLocation = useCallback((): boolean => {
    if (!canHandleBrowserCommands || desktopBrowser === null) return false;
    setAddressDraft(currentUrl);
    setIsEditing(true);
    addressInputRef.current?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      addressInputRef.current?.focus({ preventScroll: true });
      addressInputRef.current?.select();
    });

    return true;
  }, [canHandleBrowserCommands, currentUrl, desktopBrowser]);

  useAppCommandHandler("browser.focusLocation", handleFocusLocation, 100);

  const canFindInPage =
    canShowNativeBrowserView &&
    desktopBrowser !== null &&
    desktopBrowser.findInPage !== undefined &&
    hasPage;

  const runFind = useCallback(
    (args: Omit<OmnyoDesktopBrowserFindInPageRequest, "tabId">) => {
      desktopBrowser?.findInPage?.({ tabId, ...args });
    },
    [desktopBrowser, tabId],
  );

  const clearFind = useCallback(() => {
    desktopBrowser?.stopFindInPage?.({ tabId, action: "clearSelection" });
    setFindMatches(null);
  }, [desktopBrowser, tabId]);

  const focusFindInput = useCallback(() => {
    findInputRef.current?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      findInputRef.current?.focus({ preventScroll: true });
      findInputRef.current?.select();
    });
  }, []);

  const handleFindQueryChange = useCallback(
    (rawQuery: string) => {
      const query = rawQuery.slice(
        0,
        OMNYO_DESKTOP_BROWSER_MAX_FIND_TEXT_LENGTH,
      );

      setFindQuery(query);

      if (query.length === 0) {
        clearFind();

        return;
      }

      runFind({ text: query, forward: true, newSession: true });
    },
    [clearFind, runFind],
  );

  const handleFindNext = useCallback(() => {
    if (findQuery.length === 0) return;
    runFind({ text: findQuery, forward: true, newSession: false });
  }, [findQuery, runFind]);

  const handleFindPrevious = useCallback(() => {
    if (findQuery.length === 0) return;
    runFind({ text: findQuery, forward: false, newSession: false });
  }, [findQuery, runFind]);

  const handleCloseFind = useCallback(() => {
    setIsFindOpen(false);
    clearFind();
  }, [clearFind]);

  const handleOpenFind = useCallback((): boolean => {
    if (!canFindInPage) return false;
    setIsFindOpen(true);

    if (findQuery.length > 0) {
      runFind({ text: findQuery, forward: true, newSession: true });
    }

    focusFindInput();

    return true;
  }, [canFindInPage, findQuery, focusFindInput, runFind]);

  useAppCommandHandler("browser.find", handleOpenFind, 100);

  useEffect(() => {
    if (isFindOpen && !canFindInPage) {
      setIsFindOpen(false);
      clearFind();
    }
  }, [canFindInPage, clearFind, isFindOpen]);
  useAppCommandHandler(
    "browser.reload",
    () => {
      if (!canHandleBrowserCommands || desktopBrowser === null || !hasPage) {
        return false;
      }

      desktopBrowser.reload(tabId);

      return true;
    },
    100,
  );

  const handleOpenExternal = useCallback(() => {
    getOmnyoDesktopInfo()?.openExternalUrl(currentUrl);
  }, [currentUrl]);

  const hasHostFocusRef = useRef(false);

  const handleHostFocus = useCallback(() => {
    hasHostFocusRef.current = true;
    desktopBrowser?.setHostFocus?.(tabId);
  }, [desktopBrowser, tabId]);

  const handleHostBlur = useCallback(
    (event: FocusEvent<HTMLDivElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }

      hasHostFocusRef.current = false;
      desktopBrowser?.setHostFocus?.(null);
    },
    [desktopBrowser],
  );

  useEffect(
    () => () => {
      if (hasHostFocusRef.current) {
        hasHostFocusRef.current = false;
        desktopBrowser?.setHostFocus?.(null);
      }
    },
    [desktopBrowser, tabId],
  );

  if (desktopBrowser === null) {
    return <BrowserUnavailable />;
  }

  return (
    <div
      data-app-browser
      className="flex h-full min-h-0 flex-col"
      onFocus={handleHostFocus}
      onBlur={handleHostBlur}
    >
      <BrowserChrome
        addressDraft={addressDraft}
        isEditing={isEditing}
        state={state}
        currentUrl={currentUrl}
        addressInputRef={addressInputRef}
        onAddressChange={setAddressDraft}
        onAddressFocus={handleAddressFocus}
        onAddressBlur={() => setIsEditing(false)}
        onSubmit={handleAddressSubmit}
        onBack={() => {
          desktopBrowser.goBack(tabId);
        }}
        onForward={() => {
          desktopBrowser.goForward(tabId);
        }}
        onReloadOrStop={handleReloadOrStop}
        onOpenExternal={handleOpenExternal}
        locationShortcut={locationShortcut}
        reloadShortcut={reloadShortcut}
        pluginActions={
          <PluginBrowserToolbarActions
            threadId={threadId}
            tabId={tabId}
            url={currentUrl}
            isCompactViewport={isCompactViewport}
          />
        }
      />
      {control !== null ? (
        <BrowserControlBanner
          controllerLabel={control.controllerLabel}
          onStop={() => desktopBrowser.releaseControl?.(tabId)}
          onTakeOver={() => {
            desktopBrowser.releaseControl?.(tabId);
            desktopBrowser.focus?.(tabId);
          }}
        />
      ) : null}
      {isFindOpen ? (
        <BrowserFindBar
          inputRef={findInputRef}
          query={findQuery}
          matches={findMatches}
          onQueryChange={handleFindQueryChange}
          onFindNext={handleFindNext}
          onFindPrevious={handleFindPrevious}
          onClose={handleCloseFind}
          shortcut={findShortcut}
        />
      ) : null}
      <div ref={contentRef} className="relative min-h-0 flex-1">
        {hasPageLoadError ? (
          <BrowserPageLoadError
            errorText={pageLoadErrorText}
            onOpenExternal={handleOpenExternal}
            onRetry={handleReloadOrStop}
            url={currentUrl}
          />
        ) : hasPage && !isBrowserDimmingModalOpen ? null : (
          <BrowserNewTabScreen
            onNavigateInput={navigateToInput}
            recent={recent}
            onClearRecent={clearRecent}
            onFocusAddress={handleStartPromptFocusAddress}
            showStartPrompt={!hasPage}
          />
        )}
        {hasPage && resizeSnapshotUrl !== null ? (
          <img
            src={resizeSnapshotUrl}
            alt=""
            draggable={false}
            className="absolute inset-0 size-full"
          />
        ) : null}
      </div>
    </div>
  );
}

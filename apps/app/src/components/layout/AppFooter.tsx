import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@omnyo/shared-ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import {
  PluginFooterCenterCards,
  PluginFooterSidebarCards,
  PluginSidebarFooterCards,
} from "@/components/plugin/PluginSidebarFooterCards";
import {
  APP_FOOTER_ACTION_CLASS,
  PluginSidebarFooterDisclosure,
  PluginSidebarFooterItems,
} from "@/components/plugin/PluginSidebarFooterItems";
import { AppFooterSettingsButton } from "@/components/layout/AppFooterSettingsButton";
import { LazySidebarFooterCustomize } from "@/components/sidebar/LazySidebarFooterCustomize";
import { NAV_RAIL_WIDTH_CLASS } from "@/components/sidebar/navRailWidth";
import {
  useSidebarFooterBuiltInActions,
  useSidebarFooterState,
} from "@/components/sidebar/SidebarFooterState";
import { SidebarPluginAttentionGlyph } from "@/components/sidebar/SidebarPluginAttentionGlyph";
import {
  toggleNotificationCenter,
  useUnseenNotificationCount,
} from "@/lib/notifications/notification-store";
import { SidebarUpdatesBadge } from "@/components/sidebar/SidebarUpdatesBadge";
import {
  SidebarMenu,
  useIsSidebarFramed,
  useSidebar,
  useSidebarWidth,
} from "@/components/ui/sidebar.js";
import { useServerConnectionStatus } from "@/hooks/useServerConnectionState";
import { appCommandTarget } from "@/lib/app-command-targets";
import type { WebSocketConnectionStatus } from "@/lib/ws";

const CONNECTION_PROBLEM_GRACE_MS = 1_000;

const OUTAGE_CLOCK_TICK_MS = 1_000;

interface ConnectionProblem {
  label: string;
  title: string;
  details: readonly string[];
}

function noop(): void {}

function formatOutageDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.floor(durationMs / 1_000));

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

function describeConnectionProblem(
  status: WebSocketConnectionStatus,
  since: number,
  now: number,
): ConnectionProblem {
  const server = status.host ?? "the server";
  const isFirstConnection = status.state === "connecting";
  const { failedAttempts } = status;

  const elapsed = `${isFirstConnection ? "Trying" : "Disconnected"} for ${formatOutageDuration(now - since)}`;

  if (failedAttempts > 0) {
    return {
      label: "Can't connect to the server",
      title: `Can't connect to ${server}`,
      details: [
        elapsed,
        `${failedAttempts} failed ${failedAttempts === 1 ? "attempt" : "attempts"} · retrying automatically`,
      ],
    };
  }

  return isFirstConnection
    ? {
        label: "Connecting…",
        title: `Connecting to ${server}`,
        details: [elapsed, "Waiting for the server to respond"],
      }
    : {
        label: "Reconnecting…",
        title: `Reconnecting to ${server}`,
        details: [elapsed, "Retrying automatically"],
      };
}

function useOutageClock(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (since === null) return;

    let timer = 0;

    const tick = () => {
      const current = Date.now();
      setNow(current);
      const untilGraceEnds = since + CONNECTION_PROBLEM_GRACE_MS - current;

      timer = window.setTimeout(
        tick,
        untilGraceEnds > 0 ? untilGraceEnds : OUTAGE_CLOCK_TICK_MS,
      );
    };

    tick();

    return () => window.clearTimeout(timer);
  }, [since]);

  return now;
}

function AppFooterConnection() {
  const status = useServerConnectionStatus();
  const since = status.state === "connected" ? null : status.since;
  const now = useOutageClock(since);
  const detailsId = useId();

  const problem =
    since !== null &&
    (status.failedAttempts > 0 || now - since >= CONNECTION_PROBLEM_GRACE_MS)
      ? describeConnectionProblem(status, since, now)
      : null;

  return (
    <>
      <span role="status" className="sr-only">
        {problem?.title ?? ""}
      </span>
      {problem === null ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              aria-label={problem.title}
              aria-describedby={detailsId}
              data-connection-state={status.state}
              className="flex h-6 shrink-0 items-center gap-1.5 font-medium text-warning-text"
            >
              <Icon
                name="AlertTriangle"
                aria-hidden="true"
                className="size-3"
              />
              {problem.label}
              <span id={detailsId} className="sr-only">
                {problem.details.join(". ")}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="end">
            <span className="block font-medium">{problem.title}</span>
            {problem.details.map((detail) => (
              <span key={detail} className="block">
                {detail}
              </span>
            ))}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

function isInside(container: HTMLElement | null, target: EventTarget | null) {
  return container !== null && target instanceof Node
    ? container.contains(target)
    : false;
}

const CENTER_CLEARANCE_PX = 16;

interface FooterRegions {
  bar: HTMLElement | null;
  start: HTMLElement | null;
  center: HTMLElement | null;
  end: HTMLElement | null;
}

function fitsBarCenter({ bar, start, center, end }: FooterRegions): boolean {
  if (bar === null || center === null) return false;

  const barRect = bar.getBoundingClientRect();
  const middle = barRect.left + barRect.width / 2;
  const half = center.getBoundingClientRect().width / 2;
  const startEnd = start?.getBoundingClientRect().right ?? barRect.left;
  const endStart = end?.getBoundingClientRect().left ?? barRect.right;

  return (
    startEnd + CENTER_CLEARANCE_PX <= middle - half &&
    middle + half + CENTER_CLEARANCE_PX <= endStart
  );
}

function useFitsBarCenter({ bar, start, center, end }: FooterRegions): boolean {
  const [fits, setFits] = useState(false);

  useLayoutEffect(() => {
    const measure = () => setFits(fitsBarCenter({ bar, start, center, end }));

    measure();

    const observer = new ResizeObserver(measure);

    for (const element of [bar, start, center, end]) {
      if (element !== null) observer.observe(element);
    }

    return () => observer.disconnect();
  }, [bar, start, center, end]);

  return fits;
}

export interface AppFooterProps {
  isSettingsActive: boolean;
  settingsToggleRoutePath: string;
}

export function AppFooter({
  isSettingsActive,
  settingsToggleRoutePath,
}: AppFooterProps) {
  const isCompactViewport = useIsCompactViewport();

  if (isCompactViewport) return null;

  return (
    <DesktopAppFooter
      isSettingsActive={isSettingsActive}
      settingsToggleRoutePath={settingsToggleRoutePath}
    />
  );
}

function DesktopAppFooter({
  isSettingsActive,
  settingsToggleRoutePath,
}: AppFooterProps) {
  const isFramed = useIsSidebarFramed();
  const { open: isSidebarOpen } = useSidebar();
  const sidebarWidth = useSidebarWidth();
  const footer = useSidebarFooterState();
  const builtInActions = useSidebarFooterBuiltInActions(noop);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  const [start, setStart] = useState<HTMLDivElement | null>(null);
  const [center, setCenter] = useState<HTMLDivElement | null>(null);
  const [end, setEnd] = useState<HTMLDivElement | null>(null);
  const [items, setItems] = useState<HTMLUListElement | null>(null);
  const centered = useFitsBarCenter({ bar, start, center, end });
  const focusContentOnOpenRef = useRef(false);
  const [isReordering, setIsReordering] = useState(false);

  const { disclosure, isCustomizing, finishCustomizing, closeCustomizing } =
    footer;

  const isPopoverOpen = isCustomizing || disclosure.activeItem !== null;
  const handleDisclosureCommand = disclosure.handleCommand;

  const handleUserDisclosureCommand = useCallback<
    typeof handleDisclosureCommand
  >(
    (itemKey, command, sequence) => {
      focusContentOnOpenRef.current = sequence === undefined;
      handleDisclosureCommand(itemKey, command, sequence);
    },
    [handleDisclosureCommand],
  );

  const handlePopoverOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;

      if (isCustomizing) {
        closeCustomizing();

        return;
      }

      disclosure.close();
    },
    [closeCustomizing, disclosure, isCustomizing],
  );

  return (
    <footer
      ref={setBar}
      data-app-footer=""
      data-testid="app-footer"
      className={cn(
        "@container/app-footer fixed inset-x-0 z-10 flex select-none items-stretch text-xs text-muted-foreground",
        "top-[calc(var(--omnyo-shell-height)_-_var(--omnyo-app-footer-height)_-_env(safe-area-inset-bottom))] h-[calc(var(--omnyo-app-footer-height)_+_env(safe-area-inset-bottom))]",
        "pr-[calc(var(--omnyo-window-frame-lip)_+_env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]",
        isFramed
          ? "bg-transparent"
          : "border-t-[0.5px] border-(--material-line) bg-(--material-chrome)",
      )}
    >
      <div
        ref={setStart}
        data-testid="app-footer-start"
        className="flex shrink-0 items-stretch"
        style={
          isSidebarOpen
            ? { width: `calc(${sidebarWidth} - env(safe-area-inset-left))` }
            : undefined
        }
      >
        <div
          data-testid="app-footer-settings-cell"
          className={cn(
            "flex shrink-0 items-center justify-center",
            NAV_RAIL_WIDTH_CLASS,
          )}
        >
          <AppFooterSettingsButton
            isSettingsActive={isSettingsActive}
            settingsToggleRoutePath={settingsToggleRoutePath}
          />
        </div>
        {isSidebarOpen ? (
          <div
            data-testid="app-footer-sidebar-cell"
            data-footer-region="sidebar"
            className="flex min-w-0 flex-1 items-center px-2"
          >
            <PluginFooterSidebarCards />
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3 pr-1 pl-2">
        <div
          ref={setCenter}
          data-footer-center={centered ? "centered" : "inline"}
          className={cn(
            "flex shrink-0 items-center gap-4 empty:hidden",
            centered
              ? "absolute top-0 bottom-[env(safe-area-inset-bottom)] left-1/2 z-[1] -translate-x-1/2"
              : "ml-1",
          )}
        >
          <PluginFooterCenterCards />
        </div>
        <div
          ref={setEnd}
          data-testid="app-footer-end"
          className="ml-auto flex h-full min-w-0 items-center gap-3"
        >
          <div className="-mx-2 flex h-full min-w-0 items-center overflow-hidden px-2">
            <PluginSidebarFooterCards placement="footer" />
          </div>
          <Popover open={isPopoverOpen} onOpenChange={handlePopoverOpenChange}>
            <PopoverAnchor asChild>
              <SidebarMenu
                ref={setItems}
                aria-label="Footer actions"
                className="w-auto min-w-6 shrink-0 flex-row items-center justify-end gap-1"
              >
                <PluginSidebarFooterItems
                  placement="footer"
                  onCustomize={footer.startCustomizing}
                  activeDisclosureKey={disclosure.activeKey}
                  onDisclosureCommand={handleUserDisclosureCommand}
                  builtInActions={builtInActions}
                />
                <SidebarPluginAttentionGlyph
                  className={APP_FOOTER_ACTION_CLASS}
                />
                <SidebarUpdatesBadge compact />
                <StatusBarNotificationBell />
              </SidebarMenu>
            </PopoverAnchor>
            <PopoverContent
              side="top"
              align="end"
              sideOffset={6}
              className={cn(
                "w-80 max-w-[calc(100vw_-_2rem)] bg-sidebar p-1 text-sidebar-foreground",
                isCustomizing && "max-h-[50svh] overflow-y-auto",
              )}
              onCloseAutoFocus={(event) => event.preventDefault()}
              onOpenAutoFocus={(event) => {
                if (isCustomizing || !focusContentOnOpenRef.current) {
                  event.preventDefault();
                }

                focusContentOnOpenRef.current = false;
              }}
              onEscapeKeyDown={(event) => {
                if (event.defaultPrevented) return;
                event.preventDefault();

                if (isCustomizing) {
                  if (!isReordering) finishCustomizing();

                  return;
                }

                disclosure.dismiss();
              }}
              onInteractOutside={(event) => {
                if (isInside(items, event.target)) {
                  event.preventDefault();
                }
              }}
            >
              {isCustomizing ? (
                <LazySidebarFooterCustomize
                  placement="footer"
                  onDone={finishCustomizing}
                  onReorderingChange={setIsReordering}
                />
              ) : (
                <PluginSidebarFooterDisclosure
                  placement="footer"
                  item={disclosure.activeItem}
                  onDismiss={disclosure.dismiss}
                />
              )}
            </PopoverContent>
          </Popover>
          <AppFooterConnection />
        </div>
      </div>
    </footer>
  );
}

function StatusBarNotificationBell() {
  const unseenCount = useUnseenNotificationCount();

  const label =
    unseenCount > 0 ? `Notifications, ${unseenCount} new` : "Notifications";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="status-bar-notifications"
          {...appCommandTarget("notifications.open")}
          aria-label={label}
          className={cn(APP_FOOTER_ACTION_CLASS, "relative")}
          onClick={() => toggleNotificationCenter()}
        >
          <Icon name="Bell" className="size-4" />
          {unseenCount > 0 ? (
            <span
              data-testid="status-bar-notifications-count"
              className="pointer-events-none absolute -top-1 -right-1 h-3.5 min-w-3.5 rounded-full bg-primary px-1 text-center text-2xs leading-3.5 font-bold text-primary-foreground tabular-nums"
            >
              {unseenCount > 9 ? "9+" : unseenCount}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

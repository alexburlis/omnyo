import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@omnyo/shared-ui/popover";
import { CopyButton } from "../../ui/copy-button.js";
import { Icon } from "@omnyo/shared-ui/icon";
import { usePointerCoarse } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { useMinuteNow } from "@omnyo/shared-ui/hooks/use-minute-now";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@omnyo/shared-ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import { MESSAGE_ACTION_SLOT_HEIGHT_CLASS } from "./UserMessageBubble.js";
import { useTimelineStepRail } from "./timeline-step-rail";
import {
  MessageActionIcon,
  MessageActionMenuItems,
  NO_MESSAGE_ACTIONS,
  type MessageAction,
} from "./message-actions.js";

interface MessageActionBarProps {
  timestamp: number;
  showTimestamp?: boolean;
  timestampAccessory?: ReactNode;
  alignment: "start" | "end";
  actions: readonly MessageAction[];
}

const DESKTOP_ACTION_WIDTH_PX = 20;

const ACTION_ROW_GAP_PX = 8;

const OVERFLOW_TRIGGER_GAP_PX = 4;

const OVERFLOW_TRIGGER_TIGHTEN_CLASS = "-ml-1";

interface MessageActionRowLayout {
  inlineCount: number;
  overflowCount: number;
}

export function computeMessageActionRowLayout({
  actionCount,
  availableWidth,
  actionWidth,
}: {
  actionCount: number;
  availableWidth: number | undefined;
  actionWidth: number;
}): MessageActionRowLayout {
  if (actionCount <= 0) {
    return { inlineCount: 0, overflowCount: 0 };
  }

  if (availableWidth === undefined) {
    return { inlineCount: actionCount, overflowCount: 0 };
  }

  const inlineCount = Math.max(
    0,
    Math.min(
      actionCount,
      Math.floor(
        (availableWidth -
          actionWidth -
          OVERFLOW_TRIGGER_GAP_PX +
          ACTION_ROW_GAP_PX) /
          (actionWidth + ACTION_ROW_GAP_PX),
      ),
    ),
  );

  return { inlineCount, overflowCount: actionCount - inlineCount };
}

export function useMeasuredWidth({
  enabled,
  resolveTarget,
}: {
  enabled: boolean;
  resolveTarget?: (node: HTMLElement) => Element | null;
}): {
  measureRef: (node: HTMLElement | null) => void;
  width: number | undefined;
} {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const observerRef = useRef<ResizeObserver | null>(null);

  const measureRef = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (!enabled || node === null || typeof ResizeObserver === "undefined") {
        return;
      }

      const target = resolveTarget ? resolveTarget(node) : node;

      if (target === null) {
        return;
      }

      const observer = new ResizeObserver(([entry]) => {
        const inlineSize =
          entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;

        setWidth(Math.floor(inlineSize));
      });

      observer.observe(target);
      observerRef.current = observer;
    },
    [enabled, resolveTarget],
  );

  return { measureRef, width };
}

export interface SharedMessageColumnWidth {
  width: number | undefined;
}

export const MessageColumnWidthContext =
  createContext<SharedMessageColumnWidth | null>(null);

const ACTION_BUTTON_CLASS = `inline-flex size-5 cursor-pointer items-center justify-center text-muted-foreground ${CONTROL_HOVER_TRANSITION} hover:text-foreground disabled:pointer-events-none disabled:[&_[data-icon-root]]:opacity-40`;

const HOVER_REVEAL_CLASS =
  "opacity-0 transition-[color,opacity] duration-(--motion-duration-fast) group-hover/message:opacity-100 group-has-[:focus-visible]/message:opacity-100";

const ACTION_TOOLTIP_SIDE = "bottom";

const MENU_CONTENT_WIDTH_CLASS = "max-w-[min(16rem,calc(100vw-1rem))]";

const MESSAGE_TIME_CLASS =
  "shrink-0 cursor-pointer select-none whitespace-nowrap text-2xs tabular-nums text-subtle-foreground opacity-80 transition-opacity group-hover/message:opacity-100";

const ACTION_ROW_CLASS =
  "absolute top-0 flex min-w-max max-w-full items-center gap-2 overflow-hidden data-[menu-open]:[&_button]:opacity-100";

const BUBBLE_ALIGN_INSET_CLASS = "pr-[13px] pointer-coarse:pr-[11px]";

const BUBBLE_ALIGN_OFFSET_CLASS = "right-[13px] pointer-coarse:right-[11px]";

const PROSE_ALIGN_INSET_CLASS = "-ml-1 pointer-coarse:-ml-1.5";

const STEP_SLOT_HEIGHT_CLASS = "h-0";

const STEP_ROW_ALIGN_CLASS = "z-20 left-auto right-0 ml-0";

const STEP_ROW_BACKDROP_INSET_PX = 16;

const STEP_ROW_BACKDROP_CLASS =
  "pl-4 [--message-action-backdrop:var(--background)] in-data-[surface-tone=sidebar]:[--message-action-backdrop:var(--sidebar)] group-hover/message:bg-[linear-gradient(to_right,transparent,var(--message-action-backdrop)_1rem)] group-has-[:focus-visible]/message:bg-[linear-gradient(to_right,transparent,var(--message-action-backdrop)_1rem)] data-[menu-open]:bg-[linear-gradient(to_right,transparent,var(--message-action-backdrop)_1rem)]";

export const PROSE_COLUMN_INSET_CLASS = "px-2";

export function findMessageActionTooltipCollisionBoundary(
  node: HTMLElement | null,
): HTMLElement | undefined {
  return node?.closest<HTMLElement>("[data-thread-window]") ?? undefined;
}

function DesktopMessageAction({
  action,
  className,
  collisionBoundary,
}: {
  action: MessageAction;
  className: string;
  collisionBoundary: HTMLElement | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {action.kind === "copy" ? (
          <CopyButton
            text={action.copyText ?? ""}
            imageUrl={action.copyImageUrl}
            label={action.label}
            className={className}
          />
        ) : (
          <button
            type="button"
            className={cn(ACTION_BUTTON_CLASS, className)}
            onClick={action.onSelect}
            disabled={action.disabled}
            aria-label={action.label}
          >
            <MessageActionIcon action={action} className="size-3" />
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent
        side={ACTION_TOOLTIP_SIDE}
        collisionBoundary={collisionBoundary}
      >
        {action.label}
      </TooltipContent>
    </Tooltip>
  );
}

function formatMessageDay(date: Date, now: Date): string {
  if (date.toDateString() === now.toDateString()) {
    return "Today";
  }

  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

export function formatShortMessageTime(timestamp: number, now: Date): string {
  const elapsed = Math.max(0, now.getTime() - timestamp);

  if (elapsed < 60_000) return "now";

  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;

  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;

  const date = new Date(timestamp);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  const day =
    date.toDateString() === yesterday.toDateString()
      ? "Yesterday"
      : formatMessageDay(date, now);

  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${day} - ${time}`;
}

export function MessageTimestamp({
  timestamp,
  alignment = "start",
  onMeasure,
}: {
  timestamp: number;
  alignment?: "start" | "end";
  onMeasure?: (width: number) => void;
}) {
  const now = useMinuteNow();
  const date = new Date(timestamp);
  const label = formatShortMessageTime(timestamp, new Date(now));
  const timeRef = useRef<HTMLTimeElement>(null);

  useLayoutEffect(() => {
    onMeasure?.(Math.ceil(timeRef.current?.getBoundingClientRect().width ?? 0));
  }, [label, onMeasure]);

  const exactTime = date.toLocaleString(undefined, {
    dateStyle: "full",
    timeStyle: "long",
  });

  return (
    <TooltipProvider delayDuration={0}>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`Sent ${exactTime}`}
                className="inline-flex shrink-0 cursor-pointer items-center leading-none"
              >
                <time
                  ref={timeRef}
                  dateTime={date.toISOString()}
                  className={cn(
                    MESSAGE_TIME_CLASS,
                    alignment === "start" ? "pl-1" : "pr-1",
                  )}
                  data-message-time=""
                >
                  {label}
                </time>
              </button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{exactTime}</TooltipContent>
        </Tooltip>
        <PopoverContent
          className="w-auto max-w-80 px-3 py-2 text-xs"
          side="top"
        >
          {exactTime}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

export function MessageActionBar({
  timestamp,
  showTimestamp = true,
  timestampAccessory,
  alignment,
  actions,
}: MessageActionBarProps) {
  const isPointerCoarse = usePointerCoarse();
  const rowActions = isPointerCoarse ? NO_MESSAGE_ACTIONS : actions;

  const [collisionBoundary, setCollisionBoundary] = useState<
    HTMLElement | undefined
  >();

  const stepRail = useTimelineStepRail();

  const isStepHeadWithWork =
    alignment === "start" && stepRail?.role === "head" && stepRail.hasWork;

  const floatsOverStepWork = !isPointerCoarse && isStepHeadWithWork;

  const sharedColumn = useContext(MessageColumnWidthContext);

  const { measureRef, width: measuredSlotWidth } = useMeasuredWidth({
    enabled: rowActions.length > 0,
  });

  const slotWidth = measuredSlotWidth ?? sharedColumn?.width;

  const [timeWidth, setTimeWidth] = useState(0);
  const hasTimestampAccessory = Boolean(timestampAccessory);

  const { measureRef: accessoryMeasureRef, width: accessoryWidth = 0 } =
    useMeasuredWidth({ enabled: hasTimestampAccessory });

  const availableWidth =
    slotWidth === undefined
      ? undefined
      : slotWidth -
        (floatsOverStepWork ? STEP_ROW_BACKDROP_INSET_PX : 0) -
        (showTimestamp && timeWidth > 0 ? timeWidth + ACTION_ROW_GAP_PX : 0) -
        (hasTimestampAccessory && accessoryWidth > 0
          ? accessoryWidth + ACTION_ROW_GAP_PX
          : 0);

  const [isMenuOpen, setIsMenuOpen] = useState(false);

  const slotRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node);
      setCollisionBoundary(findMessageActionTooltipCollisionBoundary(node));
    },
    [measureRef],
  );

  const { inlineCount } = computeMessageActionRowLayout({
    actionCount: rowActions.length,
    availableWidth,
    actionWidth: DESKTOP_ACTION_WIDTH_PX,
  });

  const menuActions = rowActions.slice(inlineCount);

  if (!showTimestamp && !hasTimestampAccessory && rowActions.length === 0) {
    if (!isPointerCoarse || isStepHeadWithWork) return null;

    return <div aria-hidden className={MESSAGE_ACTION_SLOT_HEIGHT_CLASS} />;
  }

  const rowClass = cn(
    ACTION_ROW_CLASS,
    alignment === "end"
      ? BUBBLE_ALIGN_OFFSET_CLASS
      : cn("left-0", PROSE_ALIGN_INSET_CLASS),
    floatsOverStepWork && cn(STEP_ROW_ALIGN_CLASS, STEP_ROW_BACKDROP_CLASS),
  );

  const messageTime = showTimestamp ? (
    <MessageTimestamp
      timestamp={timestamp}
      alignment={alignment}
      onMeasure={setTimeWidth}
    />
  ) : null;

  const accessory = hasTimestampAccessory ? (
    <span ref={accessoryMeasureRef} className="inline-flex shrink-0">
      {timestampAccessory}
    </span>
  ) : null;

  const timeLeads = alignment === "start" && !floatsOverStepWork;

  const slotClass = cn(
    "relative w-full",
    alignment === "end" && BUBBLE_ALIGN_INSET_CLASS,
  );

  return (
    <TooltipProvider delayDuration={300}>
      <div
        ref={slotRef}
        className={cn(
          slotClass,
          floatsOverStepWork
            ? STEP_SLOT_HEIGHT_CLASS
            : MESSAGE_ACTION_SLOT_HEIGHT_CLASS,
        )}
      >
        <div className={rowClass} data-menu-open={isMenuOpen ? "" : undefined}>
          {timeLeads ? messageTime : null}
          {timeLeads ? accessory : null}
          {rowActions.slice(0, inlineCount).map((action) => (
            <DesktopMessageAction
              key={action.key ?? action.label}
              action={action}
              className={HOVER_REVEAL_CLASS}
              collisionBoundary={collisionBoundary}
            />
          ))}
          {menuActions.length > 0 ? (
            <DropdownMenu onOpenChange={setIsMenuOpen}>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    ACTION_BUTTON_CLASS,
                    HOVER_REVEAL_CLASS,
                    inlineCount > 0 && OVERFLOW_TRIGGER_TIGHTEN_CLASS,
                    "data-[state=open]:text-foreground data-[state=open]:opacity-100",
                  )}
                  aria-label="Message actions"
                  data-no-sidebar-swipe=""
                >
                  <Icon name="MoreHorizontal" className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align={alignment === "end" ? "end" : "start"}
                mobileTitle="Message actions"
                className={MENU_CONTENT_WIDTH_CLASS}
              >
                <MessageActionMenuItems actions={menuActions} />
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {timeLeads ? null : accessory}
          {timeLeads ? null : messageTime}
        </div>
      </div>
    </TooltipProvider>
  );
}

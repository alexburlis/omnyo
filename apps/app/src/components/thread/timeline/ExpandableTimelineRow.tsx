import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { TimelineTitle } from "@omnyo/thread-view";
import {
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  ExpandablePanel,
  getCollapsibleHeaderToneClass,
  type ExpandablePanelIntentHandlers,
} from "../../ui/disclosure.js";
import type { IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { CONTROL_HOVER_TRANSITION } from "@omnyo/shared-ui/motion";
import {
  TIMELINE_LEDGER_BODY_INSET_CLASS_NAME,
  type TimelineRailInset,
} from "./timeline-nested-group-line.js";
import { useTimelineReasoningExpansion } from "./TimelineReasoningExpansion.js";
import {
  reservesStepHeadTime,
  STEP_HEAD_TIME_ROOM_CLASS_NAME,
  TimelineStepRailContext,
  useTimelineStepRail,
} from "./timeline-step-rail";
import { useLingeringAutoExpansion } from "./useLingeringAutoExpansion.js";
import {
  TIMELINE_LEDGER_ROW_CONTENT_CLASS_NAME,
  TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME,
  TimelineLeadingIcon,
  timelineRowHeaderClassName,
  timelineRowHorizontalPaddingClassName,
  type TimelineLeadingIconTone,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";

export interface ExpandableTimelineRowLedger {
  glyph: ReactNode;
  figure: ReactNode;
}

interface ExpandableTimelineRowProps {
  expansionKey?: string;
  chevronAlwaysVisible?: boolean;
  autoExpanded?: boolean;
  forceExpanded?: boolean;
  renderBody: () => ReactNode;
  title: TimelineTitle;
  titleContent?: ReactNode;
  result?: ReactNode;
  collapsedPreview?: ReactNode;
  expandable?: boolean;
  horizontalPadding?: TimelineRowHorizontalPadding;
  leadingIcon?: IconName;
  leadingIconFallback?: IconName;
  leadingIconUrl?: string;
  leadingIconStyle?: CSSProperties;
  leadingIconTone?: TimelineLeadingIconTone;
  headerClassName?: string;
  contentClassName?: string;
  ledger?: ExpandableTimelineRowLedger;
  summaryClassName?: string;
  onTitleAction?: TimelineTitleActionResolver;
  onIntent?: () => void;
}

type CollapsedPreviewClickEvent = MouseEvent<HTMLDivElement>;

type CollapsedPreviewFocusEvent = FocusEvent<HTMLDivElement>;

type CollapsedPreviewKeyboardEvent = KeyboardEvent<HTMLDivElement>;

interface InteractivePreviewTargetArgs {
  currentTarget: HTMLDivElement;
  target: EventTarget | null;
}

function headerToneClass(title: TimelineTitle, isExpanded: boolean): string {
  if (title.tone === "summary") {
    return `text-subtle-foreground ${CONTROL_HOVER_TRANSITION} hover:text-muted-foreground focus-visible:text-muted-foreground`;
  }

  return getCollapsibleHeaderToneClass(isExpanded);
}

function isInteractivePreviewTarget({
  currentTarget,
  target,
}: InteractivePreviewTargetArgs): boolean {
  if (!(target instanceof Element) || target === currentTarget) {
    return false;
  }

  return target.closest("a,button,input,select,textarea") !== null;
}

const HOVER_INTENT_DELAY_MS = 80;

function useRowIntentHandlers(
  onIntent: (() => void) | undefined,
): ExpandablePanelIntentHandlers | undefined {
  const hoverTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
    },
    [],
  );

  if (onIntent === undefined) {
    return undefined;
  }

  const cancelHover = (): void => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
  };

  return {
    onPointerEnter: (event) => {
      if (event.pointerType !== "mouse") {
        return;
      }

      cancelHover();
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        onIntent();
      }, HOVER_INTENT_DELAY_MS);
    },
    onPointerLeave: cancelHover,
    onPointerDown: () => {
      cancelHover();
      onIntent();
    },
    onFocus: onIntent,
  };
}

function railInset(
  horizontalPadding: TimelineRowHorizontalPadding,
): TimelineRailInset {
  return horizontalPadding === "flush" ? "flush" : "inset";
}

function ExpandableTimelineRowComponent({
  autoExpanded = false,
  chevronAlwaysVisible = false,
  collapsedPreview,
  contentClassName,
  expansionKey,
  expandable = true,
  forceExpanded = false,
  headerClassName,
  horizontalPadding = "default",
  ledger,
  onIntent,
  leadingIcon,
  leadingIconFallback,
  leadingIconUrl,
  leadingIconStyle,
  leadingIconTone,
  onTitleAction,
  renderBody,
  summaryClassName,
  title,
  titleContent,
  result,
}: ExpandableTimelineRowProps) {
  const [manualExpansionOverride, setManualExpansionOverride] =
    useTimelineReasoningExpansion(expansionKey);

  const [collapsedPreviewActive, setCollapsedPreviewActive] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const stepRail = useTimelineStepRail();
  const stepWork = stepRail?.role === "work" && ledger !== undefined;

  const renderStepBody = useCallback(
    (): ReactNode => (
      <TimelineStepRailContext.Provider value={null}>
        {renderBody()}
      </TimelineStepRailContext.Provider>
    ),
    [renderBody],
  );

  const lingering = useLingeringAutoExpansion(autoExpanded, rowRef);

  const isExpanded =
    expandable &&
    (forceExpanded || (manualExpansionOverride ?? (autoExpanded || lingering)));

  useEffect(() => {
    if (isExpanded) {
      setCollapsedPreviewActive(false);
    }
  }, [isExpanded]);
  const preloadIntentHandlers = useRowIntentHandlers(onIntent);

  const intentHandlers: ExpandablePanelIntentHandlers = {
    ...preloadIntentHandlers,
    onPointerDown: (event) => {
      preloadIntentHandlers?.onPointerDown?.(event);

      if (isExpanded && manualExpansionOverride === null)
        setManualExpansionOverride(true);
    },
    onFocus: (event) => {
      preloadIntentHandlers?.onFocus?.(event);

      if (isExpanded && manualExpansionOverride === null)
        setManualExpansionOverride(true);
    },
  };

  const horizontalPaddingClass =
    timelineRowHorizontalPaddingClassName(horizontalPadding);

  const handleToggle = useCallback((): void => {
    setManualExpansionOverride(!isExpanded);
  }, [isExpanded, setManualExpansionOverride]);

  const handleCollapsedPreviewClick = useCallback(
    (event: CollapsedPreviewClickEvent): void => {
      if (
        isInteractivePreviewTarget({
          currentTarget: event.currentTarget,
          target: event.target,
        })
      ) {
        return;
      }

      handleToggle();
    },
    [handleToggle],
  );

  const handleCollapsedPreviewKeyDown = useCallback(
    (event: CollapsedPreviewKeyboardEvent): void => {
      if (event.target !== event.currentTarget) {
        return;
      }

      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      handleToggle();
    },
    [handleToggle],
  );

  const handleCollapsedPreviewBlur = useCallback(
    (event: CollapsedPreviewFocusEvent): void => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }

      setCollapsedPreviewActive(false);
    },
    [],
  );

  const titleView = titleContent ?? (
    <TimelineTitleView title={title} onTitleAction={onTitleAction} />
  );

  const summaryContent =
    ledger === undefined ? (
      <span
        className={cn(
          "inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5",
          result === undefined ? summaryClassName : undefined,
        )}
      >
        <TimelineLeadingIcon
          icon={leadingIcon}
          fallback={leadingIconFallback}
          iconUrl={leadingIconUrl}
          style={leadingIconStyle}
          tone={leadingIconTone}
        />
        <span
          className={cn(
            "min-w-0 flex-1",
            result === undefined ? undefined : summaryClassName,
          )}
        >
          {titleView}
        </span>
        {result}
      </span>
    ) : (
      <span className={TIMELINE_LEDGER_ROW_CONTENT_CLASS_NAME}>
        {stepWork ? null : ledger.glyph}
        <span
          className={cn(
            "inline-flex min-w-0 max-w-full items-baseline gap-1.5",
            summaryClassName,
          )}
        >
          <span className="inline-flex min-w-0">{titleView}</span>
          {result}
          {stepWork ? ledger.figure : null}
        </span>
      </span>
    );

  return (
    <div ref={rowRef}>
      <ExpandablePanel
        intentHandlers={intentHandlers}
        isExpanded={isExpanded}
        onToggle={expandable ? handleToggle : undefined}
        headerToneClass={
          expandable
            ? headerToneClass(title, isExpanded)
            : COLLAPSIBLE_HEADER_STATIC_TONE_CLASS
        }
        collapsedContent={
          collapsedPreview ? (
            <div
              className={cn(
                horizontalPaddingClass,
                "pb-1 pt-0.5",
                expandable ? "cursor-pointer focus-visible:outline-none" : null,
              )}
              role={expandable ? "button" : undefined}
              tabIndex={expandable ? 0 : undefined}
              aria-expanded={expandable ? isExpanded : undefined}
              onClick={expandable ? handleCollapsedPreviewClick : undefined}
              onMouseEnter={
                expandable ? () => setCollapsedPreviewActive(true) : undefined
              }
              onMouseLeave={
                expandable ? () => setCollapsedPreviewActive(false) : undefined
              }
              onFocus={
                expandable ? () => setCollapsedPreviewActive(true) : undefined
              }
              onBlur={expandable ? handleCollapsedPreviewBlur : undefined}
              onKeyDown={expandable ? handleCollapsedPreviewKeyDown : undefined}
            >
              {collapsedPreview}
            </div>
          ) : null
        }
        summaryContent={summaryContent}
        summaryContentClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
        headerTrailingContent={stepWork ? undefined : ledger?.figure}
        forceHeaderChevronVisible={
          expandable &&
          !isExpanded &&
          (chevronAlwaysVisible || collapsedPreviewActive)
        }
        className="w-full"
        headerClassName={cn(
          timelineRowHeaderClassName(horizontalPadding),
          stepWork ? "min-h-6" : "min-h-7",
          stepWork &&
            reservesStepHeadTime(stepRail) &&
            STEP_HEAD_TIME_ROOM_CLASS_NAME,
          "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          ledger === undefined && "hover:bg-foreground/3",
          headerClassName,
        )}
        contentClassName={cn(
          ledger === undefined || stepWork
            ? horizontalPaddingClass
            : TIMELINE_LEDGER_BODY_INSET_CLASS_NAME[
                railInset(horizontalPadding)
              ],
          "pb-1 pt-0.5",
          contentClassName,
        )}
        renderBody={renderStepBody}
      />
    </div>
  );
}

export const ExpandableTimelineRow = memo(ExpandableTimelineRowComponent);

import { ThreadQuestionFormHost } from "../user-questions/ThreadQuestionFormHost";
import { useStickyFooterAvailableHeight } from "../user-questions/useStickyFooterAvailableHeight";
import {
  Activity,
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  getDisclosureDurationMs,
  getDisclosureRevealClass,
} from "@omnyo/shared-ui/motion";
import { ExpandableLine } from "@/components/ui/expandable-line.js";
import { useIsCompactViewport } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { ResponsiveDrawerShell } from "@omnyo/shared-ui/responsive-overlay";
import { useMobilePendingInteraction } from "./MobilePendingInteraction";

export interface PendingInteractionSourceThread {
  href: string;
  title: string;
}

interface PendingInteractionShellProps {
  label: string;
  title?: string;
  expandedByDefault: boolean;
  errorMessage?: string | null;
  headerActions?: ReactNode;
  headerBadge?: ReactNode;
  headerProgressRef?: Ref<HTMLDivElement>;
  footer?: ReactNode;
  children?: (isExpanded: boolean) => ReactNode;
  sourceThread?: PendingInteractionSourceThread;
  testId: string;
  interactionKey?: string;
}

export function PendingInteractionShell({
  label,
  title,
  expandedByDefault,
  errorMessage,
  headerActions,
  headerBadge,
  headerProgressRef,
  footer,
  children,
  sourceThread,
  testId,
  interactionKey,
}: PendingInteractionShellProps) {
  const [inlineExpanded, setInlineExpanded] = useState(expandedByDefault);
  const isCompactViewport = useIsCompactViewport();

  const mobile = useMobilePendingInteraction({
    enabled: isCompactViewport,
    expandedByDefault,
    interactionKey,
  });

  const isExpanded = isCompactViewport ? mobile.isOpen : inlineExpanded;

  const setIsExpanded = isCompactViewport ? mobile.setOpen : setInlineExpanded;

  const [previousExpandedByDefault, setPreviousExpandedByDefault] =
    useState(expandedByDefault);

  if (expandedByDefault !== previousExpandedByDefault) {
    setPreviousExpandedByDefault(expandedByDefault);

    if (expandedByDefault) setInlineExpanded(true);
  }

  const [previousExpanded, setPreviousExpanded] = useState(isExpanded);
  const [closing, setClosing] = useState(false);

  if (isExpanded !== previousExpanded) {
    setPreviousExpanded(isExpanded);
    setClosing(!isExpanded);
  }

  useEffect(() => {
    if (!closing) return;

    const timer = window.setTimeout(
      () => setClosing(false),
      getDisclosureDurationMs(false),
    );

    return () => window.clearTimeout(timer);
  }, [closing]);

  const rootRef = useRef<HTMLElement>(null);

  const liveAvailableHeight = useStickyFooterAvailableHeight(
    rootRef,
    isExpanded && !isCompactViewport,
  );

  const [heldAvailableHeight, setHeldAvailableHeight] = useState<number | null>(
    null,
  );

  if (
    liveAvailableHeight !== null &&
    liveAvailableHeight !== heldAvailableHeight
  ) {
    setHeldAvailableHeight(liveAvailableHeight);
  }

  const availableHeight = isExpanded
    ? liveAvailableHeight
    : closing
      ? heldAvailableHeight
      : null;

  const toggleRef = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  const errorId = useId();

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && isExpanded && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      setIsExpanded(false);
      toggleRef.current?.focus();
    }
  };

  const handleToggle = () => setIsExpanded(!isExpanded);

  const progress = headerProgressRef ? (
    <div ref={headerProgressRef} className="ml-auto shrink-0" />
  ) : null;

  const toggle = (
    <button
      ref={toggleRef}
      type="button"
      aria-controls={contentId}
      aria-expanded={isExpanded}
      aria-label={isExpanded ? "Hide details" : "Show details"}
      onClick={handleToggle}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        CONTROL_PRESS_TRANSITION,
        CONTROL_PRESS_FEEDBACK,
      )}
    >
      <Icon
        name="ChevronDown"
        className={cn(
          "size-3.5",
          DISCLOSURE_CHEVRON_TRANSITION,
          isExpanded ? "rotate-180" : undefined,
        )}
      />
    </button>
  );

  const errorNode = errorMessage ? (
    <div
      id={errorId}
      aria-live="polite"
      className={
        isExpanded
          ? "mx-3 mb-3 rounded-md border border-surface-destructive-border bg-surface-destructive px-2 py-1 text-xs text-destructive-text"
          : "sr-only"
      }
    >
      {errorMessage}
    </div>
  ) : null;

  const sourceThreadLink = sourceThread ? (
    <RouteAnchor
      href={sourceThread.href}
      title={sourceThread.title}
      className={cn(
        "min-w-0 shrink-[3] truncate text-xs text-subtle-foreground no-underline hover:underline",
        isCompactViewport ? "max-w-full" : "max-w-[40%]",
      )}
    >
      From {sourceThread.title}
    </RouteAnchor>
  ) : null;

  const content = (
    <Activity
      mode={
        isExpanded || (closing && !isCompactViewport) ? "visible" : "hidden"
      }
    >
      <ThreadQuestionFormHost active={isExpanded}>
        <div
          {...(isCompactViewport ? { id: contentId, hidden: !isExpanded } : {})}
          className={cn(
            "min-h-0 touch-pan-y overflow-y-auto overscroll-contain px-3 pb-2 pt-2",
            isCompactViewport
              ? "flex-1 pb-0 [&_[data-question-form-actions]]:sticky [&_[data-question-form-actions]]:bottom-0 [&_[data-question-form-actions]]:z-10 [&_[data-question-form-actions]]:border-t [&_[data-question-form-actions]]:border-border-hairline [&_[data-question-form-actions]]:bg-background [&_[data-question-form-actions]]:py-2"
              : "max-h-[min(32rem,50dvh)]",
          )}
        >
          {title ? (
            <h3 className="min-w-0 text-sm font-medium text-foreground">
              <ExpandableLine
                fullText={title}
                collapsedClassName="line-clamp-2"
              >
                {title}
              </ExpandableLine>
            </h3>
          ) : null}
          {children ? (
            <div className={title ? "mt-2" : undefined}>
              {children(isExpanded)}
            </div>
          ) : null}
          {footer && !isCompactViewport ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {footer}
            </div>
          ) : null}
        </div>
      </ThreadQuestionFormHost>
    </Activity>
  );

  if (isCompactViewport) {
    return (
      <>
        <section
          ref={rootRef}
          aria-label={label}
          data-testid={testId}
          data-expanded={isExpanded ? "" : undefined}
          className="@container min-w-0 max-w-full rounded-lg border border-border bg-surface-recessed text-xs text-muted-foreground"
        >
          <button
            ref={toggleRef}
            type="button"
            aria-controls={contentId}
            aria-expanded={isExpanded}
            aria-label={label}
            aria-describedby={errorMessage ? errorId : undefined}
            onClick={handleToggle}
            className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-lg px-3 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <AttentionDot hasError={Boolean(errorMessage)} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {label}
            </span>
            <Icon name="ChevronUp" className="size-4 shrink-0" />
          </button>
        </section>
        <ResponsiveDrawerShell
          open={isExpanded}
          onOpenChange={mobile.setOpen}
          onAfterCloseAutoFocus={() => toggleRef.current?.focus()}
          srLabel={label}
          contentClassName="@container mt-0 h-[calc(100dvh-var(--omnyo-drawer-keyboard-inset,0px))] max-h-[calc(100dvh-var(--omnyo-drawer-keyboard-inset,0px))] overflow-hidden rounded-none pt-[var(--omnyo-safe-area-top,env(safe-area-inset-top))]"
        >
          <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-border-hairline px-3 pb-2">
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-foreground">
              <AttentionDot hasError={Boolean(errorMessage)} />
              <span
                className={
                  headerBadge ? "min-w-0 truncate" : "min-w-0 break-words"
                }
              >
                {label}
              </span>
              {headerBadge}
            </span>
            {progress}
            {headerActions}
            <button
              type="button"
              onClick={() => mobile.setOpen(false)}
              className={cn(
                "flex min-h-10 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                CONTROL_PRESS_TRANSITION,
                CONTROL_PRESS_FEEDBACK,
              )}
            >
              <Icon name="ChevronDown" className="size-4" />
              <span className={headerBadge ? "sr-only" : undefined}>
                Minimize
              </span>
            </button>
            {sourceThread ? (
              <div className="w-full">{sourceThreadLink}</div>
            ) : null}
          </div>
          {content}
          {footer ? (
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border-hairline px-3 py-2">
              {footer}
            </div>
          ) : null}
          {errorNode}
        </ResponsiveDrawerShell>
      </>
    );
  }

  return (
    <section
      ref={rootRef}
      aria-label={label}
      data-testid={testId}
      data-expanded={isExpanded ? "" : undefined}
      onKeyDown={handleKeyDown}
      style={
        availableHeight === null
          ? undefined
          : { maxHeight: Math.max(160, availableHeight) }
      }
      className="@container mb-2 flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-recessed text-xs text-muted-foreground"
    >
      <div
        className={cn(
          "flex min-h-9 shrink-0 items-center gap-2 pl-3 pr-1.5",
          isExpanded ? "border-b border-border-hairline py-0.5" : "py-1",
        )}
      >
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={isExpanded}
          aria-label={label}
          aria-describedby={errorMessage ? errorId : undefined}
          onClick={handleToggle}
          className={cn(
            "flex min-h-7 min-w-0 items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            !headerBadge && "flex-1",
          )}
        >
          <span className="flex min-w-0 flex-1 items-start gap-2">
            <span className="flex h-[1lh] shrink-0 items-center text-sm">
              <AttentionDot hasError={Boolean(errorMessage)} />
            </span>
            <span
              title={label}
              className={cn(
                "min-w-0 text-sm text-foreground",
                headerBadge
                  ? "truncate font-semibold"
                  : isExpanded
                    ? "whitespace-normal font-semibold"
                    : cn(
                        "truncate font-medium",
                        title && "max-w-[55%] shrink-0",
                      ),
              )}
            >
              <BreakableLabel label={label} />
            </span>
            {title && !isExpanded ? (
              <span
                data-pending-interaction-summary=""
                className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
              >
                {title}
              </span>
            ) : null}
          </span>
        </button>
        {headerBadge}
        {isExpanded ? sourceThreadLink : null}
        {progress}
        {headerActions}
        {toggle}
      </div>
      <div
        id={contentId}
        aria-hidden={!isExpanded}
        inert={!isExpanded}
        className={cn("min-h-0", getDisclosureRevealClass(isExpanded))}
      >
        <div className="flex min-h-0 flex-col overflow-hidden">{content}</div>
      </div>
      {errorNode}
    </section>
  );
}

function BreakableLabel({ label }: { label: string }) {
  return label.split(/([/\\])/).map((part, index) => (
    <Fragment key={index}>
      {part}
      {part === "/" || part === "\\" ? <wbr /> : null}
    </Fragment>
  ));
}

function AttentionDot({ hasError }: { hasError: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2 shrink-0 rounded-full ring-[3px]",
        hasError
          ? "bg-destructive-text ring-surface-destructive"
          : "bg-attention ring-surface-attention",
      )}
    />
  );
}

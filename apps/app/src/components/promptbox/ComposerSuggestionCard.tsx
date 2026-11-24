import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { ExperimentalComposerSuggestion } from "@omnyo/plugin-sdk";
import { Button } from "@omnyo/shared-ui/button";
import { COARSE_POINTER_TEXT_BASE_CLASS } from "@omnyo/shared-ui/coarse-pointer-sizing";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  getDisclosureDurationMs,
} from "@omnyo/shared-ui/motion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { glidePromptBoxHeight } from "./prompt-box-height-glide";

export const COMPOSER_SUGGESTION_CARD_SELECTOR =
  "[data-composer-suggestion-card]";

export interface ComposerSuggestionCardSend {
  blockedReason: string | null;
  onSend: () => void;
}

const ARRIVAL_CLASS =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-duration-base) ease-out motion-reduce:slide-in-from-bottom-0";

const PILL_CLASS = "h-8 rounded-full px-4 text-sm pointer-coarse:h-10";

const BODY_TEXT_CLASS = cn(
  COARSE_POINTER_TEXT_BASE_CLASS,
  "block whitespace-pre-wrap break-words leading-relaxed",
);

export function ComposerSuggestionCard({
  suggestion,
  animate,
  send,
  onEdit,
}: {
  suggestion: ExperimentalComposerSuggestion;
  animate: boolean;
  send: ComposerSuggestionCardSend | null;
  onEdit: () => void;
}) {
  const dismiss = (
    <CardIconAction
      icon="X"
      label="Dismiss suggestion"
      onClick={() => suggestion.onDismiss()}
    />
  );

  return (
    <section
      aria-label="Suggested reply"
      data-composer-suggestion-card={suggestion.status}
      className="border-b border-border-hairline px-4 pb-2.5 pt-2"
    >
      <div
        key={suggestion.status}
        className={cn(
          "flex flex-col",
          animate && suggestion.status !== "failed" && ARRIVAL_CLASS,
        )}
      >
        {renderState()}
      </div>
    </section>
  );

  function renderState(): ReactNode {
    switch (suggestion.status) {
      case "ready":
        return (
          <>
            <CardHeader icon="Sparkles" title="Suggested reply">
              {suggestion.onRegenerate === undefined ? null : (
                <CardIconAction
                  icon="RotateCcw"
                  label="Suggest another reply"
                  onClick={() => suggestion.onRegenerate?.()}
                />
              )}
              {dismiss}
            </CardHeader>
            <SuggestionText key={suggestion.text} text={suggestion.text} />
            <ReadyActions send={send} onEdit={onEdit} />
          </>
        );

      case "loading":
        return (
          <>
            <CardHeader
              icon="Sparkles"
              iconClassName="animate-shine-icon"
              title={
                <span role="status" className="animate-shine">
                  Suggesting a reply…
                </span>
              }
            />
            <span
              aria-hidden="true"
              className={cn(
                BODY_TEXT_CLASS,
                "flex flex-col animate-shine-icon",
              )}
            >
              <span className="flex h-lh items-center">
                <span className="h-2 w-full rounded-full bg-state-active" />
              </span>
              <span className="flex h-lh items-center">
                <span className="h-2 w-3/5 rounded-full bg-state-active" />
              </span>
            </span>
            <CardActions>
              <CardPill
                variant="ghost"
                label="Stop suggesting a reply"
                onClick={() => suggestion.onDismiss()}
              >
                <Icon
                  name="Square"
                  className="size-2.5 fill-current [&_*]:stroke-0"
                />
                Stop
              </CardPill>
            </CardActions>
          </>
        );

      case "failed":
        return (
          <>
            <CardHeader icon="AlertCircle" title="Couldn’t suggest a reply">
              {dismiss}
            </CardHeader>
            <p role="alert" className="text-sm text-muted-foreground">
              {suggestion.message}
            </p>
            <CardActions>
              <CardPill
                variant="secondary"
                label="Retry"
                onClick={() => suggestion.onRetry()}
              >
                <Icon name="RotateCcw" />
                Retry
              </CardPill>
            </CardActions>
          </>
        );

      case "none":
        return (
          <>
            <CardHeader icon="Sparkles" title="No suggested reply">
              {dismiss}
            </CardHeader>
            <p className="text-sm text-muted-foreground">{suggestion.reason}</p>
            <CardActions>
              <CardPill
                variant="secondary"
                label="Suggest a reply anyway"
                onClick={() => suggestion.onRequest()}
              >
                <Icon name="Sparkles" />
                Suggest anyway
              </CardPill>
            </CardActions>
          </>
        );
    }
  }
}

function ReadyActions({
  send,
  onEdit,
}: {
  send: ComposerSuggestionCardSend | null;
  onEdit: () => void;
}) {
  const reasonId = useId();
  const blockedReason = send?.blockedReason ?? null;

  return (
    <CardActions
      leading={
        blockedReason === null ? null : (
          <span
            id={reasonId}
            className="line-clamp-2 min-w-0 text-xs text-subtle-foreground"
          >
            {blockedReason}
          </span>
        )
      }
    >
      <CardPill variant="secondary" label="Edit suggestion" onClick={onEdit}>
        Edit
      </CardPill>
      {send === null ? null : (
        <CardPill
          variant="default"
          label="Send suggestion"
          disabled={blockedReason !== null}
          describedBy={blockedReason === null ? undefined : reasonId}
          className="gap-1.5 pl-3 disabled:bg-surface-recessed disabled:text-subtle-foreground disabled:opacity-100"
          onClick={send.onSend}
        >
          <Icon name="ArrowUp" />
          Send
        </CardPill>
      )}
    </CardActions>
  );
}

function SuggestionText({ text }: { text: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const glideFromHeightRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    const element = textRef.current;

    if (element === null || expanded) return;

    const measure = () =>
      setClamped(element.scrollHeight > element.clientHeight + 1);

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [expanded]);

  useLayoutEffect(() => {
    const element = textRef.current;
    const fromHeight = glideFromHeightRef.current;
    glideFromHeightRef.current = null;

    if (element === null || fromHeight === null) return;

    return glidePromptBoxHeight(element, fromHeight, {
      durationMs: getDisclosureDurationMs(expanded),
    });
  }, [expanded]);

  const expandable = clamped || expanded;

  const toggle = () => {
    if (!expandable) return;
    glideFromHeightRef.current =
      textRef.current?.getBoundingClientRect().height ?? null;
    setExpanded((current) => !current);
  };

  return (
    <div
      role={expandable ? "button" : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? expanded : undefined}
      data-composer-suggestion-action={expandable ? "" : undefined}
      className={cn(
        "-mx-1.5 rounded-md px-1.5 py-0.5 text-left outline-none",
        expandable &&
          "cursor-pointer focus-visible:outline-2 focus-visible:outline-ring",
      )}
      onMouseDown={expandable ? preventFocusSteal : undefined}
      onClick={toggle}
      onKeyDown={(event) => {
        if (!expandable || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        toggle();
      }}
    >
      <span
        ref={textRef}
        data-composer-suggestion-text=""
        className={cn(
          BODY_TEXT_CLASS,
          "text-foreground",
          expanded
            ? "max-h-60 overflow-y-auto overscroll-contain"
            : "line-clamp-3",
        )}
      >
        {text}
      </span>
    </div>
  );
}

function CardHeader({
  icon,
  iconClassName,
  title,
  children,
}: {
  icon: IconName;
  iconClassName?: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-8 items-center gap-1.5 text-xs text-subtle-foreground">
      <Icon name={icon} className={cn("size-3.5 shrink-0", iconClassName)} />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      {children === undefined ? null : (
        <span className="-mr-2 flex shrink-0 items-center">{children}</span>
      )}
    </div>
  );
}

function CardActions({
  leading,
  children,
}: {
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 flex items-center justify-end gap-2">
      {leading === undefined || leading === null ? null : (
        <span className="mr-auto flex min-w-0 flex-1">{leading}</span>
      )}
      {children}
    </div>
  );
}

function CardPill({
  variant,
  label,
  disabled = false,
  describedBy,
  className,
  onClick,
  children,
}: {
  variant: "default" | "secondary" | "ghost";
  label: string;
  disabled?: boolean;
  describedBy?: string;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant={variant}
      data-composer-suggestion-action=""
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cn(PILL_CLASS, "shrink-0", className)}
      onMouseDown={preventFocusSteal}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function CardIconAction({
  icon,
  label,
  onClick,
}: {
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-composer-suggestion-action=""
          aria-label={label}
          className={cn(
            "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-subtle-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:-my-1 pointer-coarse:size-10",
            CONTROL_PRESS_TRANSITION,
            CONTROL_PRESS_FEEDBACK,
          )}
          onMouseDown={preventFocusSteal}
          onClick={onClick}
        >
          <Icon name={icon} className="size-3.5 shrink-0" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function preventFocusSteal(event: MouseEvent<HTMLElement>) {
  event.preventDefault();
}

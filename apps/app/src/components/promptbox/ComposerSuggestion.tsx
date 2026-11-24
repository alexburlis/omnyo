import type { ReactNode } from "react";
import type { ExperimentalComposerSuggestion } from "@omnyo/plugin-sdk";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { AppCommandShortcutPill } from "@/components/commands/AppCommandShortcutHint";

export const COMPOSER_SUGGESTION_ACTION_SELECTOR =
  "[data-composer-suggestion-action]";

const READY_TEXT_CLASS =
  "text-[color-mix(in_oklch,var(--ink)_64%,var(--canvas))]";

const SHADOW_TEXT_CLASS =
  "text-[color-mix(in_oklch,var(--ink)_46%,var(--canvas))]";

export function ComposerSuggestion({
  suggestion,
  engaged,
  touch,
  onInsert,
}: {
  suggestion: ExperimentalComposerSuggestion;
  engaged: boolean;
  touch: boolean;
  onInsert: () => void;
}) {
  const dismiss = (
    <SuggestionAction
      icon="X"
      label="Dismiss suggestion"
      touch={touch}
      onClick={() => suggestion.onDismiss()}
    />
  );

  switch (suggestion.status) {
    case "ready": {
      const actions = (
        <>
          <SuggestionAction
            icon={touch ? "CornerDownLeft" : undefined}
            label="Insert suggestion"
            touch={touch}
            onClick={onInsert}
          >
            {touch ? null : (
              <AppCommandShortcutPill
                shortcut={{ label: "Tab" }}
                className="py-0.5"
              />
            )}
          </SuggestionAction>
          {suggestion.onRegenerate === undefined ? null : (
            <SuggestionAction
              icon="RotateCcw"
              label="Suggest another reply"
              touch={touch}
              onClick={() => suggestion.onRegenerate?.()}
            />
          )}
          {dismiss}
        </>
      );

      return (
        <SuggestionBlock
          status={engaged ? "shadow" : "ready"}
          body={
            <p
              className={cn(
                "whitespace-pre-wrap break-words",
                CONTROL_HOVER_TRANSITION,
                engaged ? SHADOW_TEXT_CLASS : READY_TEXT_CLASS,
              )}
            >
              {suggestion.text}
            </p>
          }
          actions={actions}
        />
      );
    }

    case "loading": {
      const label = (
        <span role="status" className="animate-shine">
          Suggesting a reply…
        </span>
      );

      const stop = (
        <SuggestionAction
          icon="Square"
          iconClassName="size-2.5 fill-current [&_*]:stroke-0"
          label="Stop suggesting a reply"
          touch={touch}
          onClick={() => suggestion.onDismiss()}
        >
          Stop
        </SuggestionAction>
      );

      return (
        <SuggestionBlock
          status="loading"
          title={
            <>
              <Icon
                name="Sparkles"
                className="size-4 shrink-0 animate-shine-icon"
              />
              {label}
            </>
          }
          body={
            <span
              aria-hidden="true"
              className="flex flex-col gap-2 py-1.5 animate-shine-icon"
            >
              <span className="h-2 w-full rounded-full bg-state-active" />
            </span>
          }
          caption={
            <span
              aria-hidden="true"
              className="block h-2 w-3/5 rounded-full bg-state-active animate-shine-icon"
            />
          }
          actions={stop}
        />
      );
    }

    case "failed": {
      const actions = (
        <>
          <SuggestionAction
            icon="RotateCcw"
            label="Retry"
            touch={touch}
            onClick={() => suggestion.onRetry()}
          >
            Retry
          </SuggestionAction>
          {dismiss}
        </>
      );

      return (
        <SuggestionBlock
          status="failed"
          title={
            <>
              <Icon name="AlertCircle" className="size-4 shrink-0" />
              Couldn’t suggest a reply
            </>
          }
          caption={
            <span
              role="alert"
              className="block pl-6 text-xs text-subtle-foreground"
            >
              {suggestion.message}
            </span>
          }
          actions={actions}
        />
      );
    }

    case "none": {
      const actions = (
        <>
          <SuggestionAction
            icon="Sparkles"
            label="Suggest a reply anyway"
            touch={touch}
            onClick={() => suggestion.onRequest()}
          >
            Suggest anyway
          </SuggestionAction>
          {dismiss}
        </>
      );

      return (
        <SuggestionBlock
          status="none"
          title={
            <>
              <Icon name="Sparkles" className="size-4 shrink-0" />
              No suggested reply
            </>
          }
          caption={
            <span className="block pl-6 text-xs text-subtle-foreground">
              {suggestion.reason}
            </span>
          }
          actions={actions}
        />
      );
    }
  }
}

function SuggestionBlock({
  status,
  title,
  body,
  caption,
  actions,
}: {
  status: "ready" | "shadow" | "loading" | "failed" | "none";
  title?: ReactNode;
  body?: ReactNode;
  caption?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div
      data-composer-suggestion={status}
      className="pointer-events-none min-w-0 select-none"
    >
      {title === undefined ? null : (
        <div className="flex min-h-6 items-center gap-2 text-muted-foreground">
          {title}
        </div>
      )}
      {body}
      <div className="mt-1 flex min-h-6 items-center justify-end gap-2">
        {caption === undefined ? null : (
          <div className="flex min-w-0 flex-1 items-center">{caption}</div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
      </div>
    </div>
  );
}

function SuggestionAction({
  icon,
  iconClassName = "size-3.5",
  label,
  touch,
  onClick,
  children,
}: {
  icon?: IconName;
  iconClassName?: string;
  label: string;
  touch: boolean;
  onClick: () => void;
  children?: ReactNode;
}) {
  const action = (
    <button
      type="button"
      data-composer-suggestion-action=""
      aria-label={label}
      className={cn(
        "pointer-events-auto relative z-10 inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-xs text-subtle-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
        CONTROL_PRESS_TRANSITION,
        CONTROL_PRESS_FEEDBACK,
        touch ? "h-8 min-w-8 px-2" : "h-6 min-w-6 px-1.5",
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {icon === undefined ? null : (
        <Icon name={icon} className={cn("shrink-0", iconClassName)} />
      )}
      {children}
    </button>
  );

  if (children !== undefined) return action;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{action}</TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

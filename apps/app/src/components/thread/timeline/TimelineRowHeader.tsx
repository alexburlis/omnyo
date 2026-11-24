import type { CSSProperties, ReactNode } from "react";
import {
  COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS,
  COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS,
  COLLAPSIBLE_HEADER_STATIC_TONE_CLASS,
  CollapsibleHeader,
} from "../../ui/disclosure.js";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { PluginCompactIconMask } from "../../plugin/PluginIcon.js";
import {
  reservesStepHeadTime,
  STEP_HEAD_TIME_ROOM_CLASS_NAME,
  useTimelineStepRail,
} from "./timeline-step-rail";

export type TimelineRowHorizontalPadding = "default" | "flush";

export const TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME = "min-w-0 max-w-full";

const TIMELINE_ROW_HEADER_CONTROL_CLASS_NAME =
  "flex w-full max-w-full justify-start py-0 leading-5";

interface TimelineStaticRowHeaderProps {
  children: ReactNode;
  className?: string;
  horizontalPadding?: TimelineRowHorizontalPadding;
}

interface TimelineLeadingIconProps {
  icon: IconName | undefined;
  fallback?: IconName;
  iconUrl: string | undefined;
  style: CSSProperties | undefined;
  tone?: TimelineLeadingIconTone;
}

export type TimelineLeadingIconTone = "default" | "danger" | "warning";

const LEADING_ICON_TONE_CLASS: Record<TimelineLeadingIconTone, string> = {
  default: "text-muted-foreground",
  danger: "text-destructive-text",
  warning: "text-warning-text",
};

export function TimelineLeadingIcon({
  icon,
  fallback,
  iconUrl,
  style,
  tone = "default",
}: TimelineLeadingIconProps) {
  if (iconUrl !== undefined) {
    return (
      <PluginCompactIconMask
        url={iconUrl}
        className="size-3.5 text-muted-foreground"
        style={style}
      />
    );
  }

  if (icon) {
    return (
      <Icon
        name={icon}
        fallback={fallback}
        className={cn("size-3.5 shrink-0", LEADING_ICON_TONE_CLASS[tone])}
        style={tone === "default" ? style : undefined}
        aria-hidden
      />
    );
  }

  return null;
}

export type TimelineRowGlyphState = "idle" | "running" | "failed";

interface TimelineRowGlyphProps extends TimelineLeadingIconProps {
  state: TimelineRowGlyphState;
}

const TIMELINE_ROW_GLYPH_CLASS_NAME =
  "relative z-10 flex h-4 w-5 shrink-0 items-center justify-center bg-background";

export function TimelineRowDotGlyph({
  toneClassName,
}: {
  toneClassName: string;
}) {
  return (
    <span aria-hidden="true" className={TIMELINE_ROW_GLYPH_CLASS_NAME}>
      <span className={cn("size-1.5 rounded-full", toneClassName)} />
    </span>
  );
}

export function TimelineRowGlyph({
  fallback,
  icon,
  iconUrl,
  state,
  style,
}: TimelineRowGlyphProps) {
  const toneClassName =
    state === "failed" ? "text-destructive-text" : "text-timeline-meta";

  return (
    <span
      aria-hidden="true"
      data-timeline-row-glyph={state}
      className={TIMELINE_ROW_GLYPH_CLASS_NAME}
    >
      {state === "running" ? (
        <Icon
          name="Spinner"
          className="size-3.5 shrink-0 animate-spin text-subtle-foreground"
        />
      ) : iconUrl !== undefined ? (
        <PluginCompactIconMask
          url={iconUrl}
          className={cn("size-3.5", toneClassName)}
          style={state === "failed" ? undefined : style}
        />
      ) : icon ? (
        <Icon
          name={icon}
          fallback={fallback}
          className={cn("size-3.5 shrink-0", toneClassName)}
          style={state === "failed" ? undefined : style}
        />
      ) : null}
    </span>
  );
}

export const TIMELINE_LEDGER_ROW_CONTENT_CLASS_NAME =
  "inline-flex min-w-0 max-w-full items-center gap-3";

export function TimelineLedgerStaticRow({
  children,
  className,
  figure,
  glyph,
  horizontalPadding = "default",
}: {
  children: ReactNode;
  className?: string;
  figure?: ReactNode;
  glyph: ReactNode;
  horizontalPadding?: TimelineRowHorizontalPadding;
}) {
  const stepRail = useTimelineStepRail();
  const stepWork = stepRail?.role === "work";

  return (
    <div
      className={cn(
        "flex w-full max-w-full items-center text-sm leading-5 text-muted-foreground",
        stepWork ? "min-h-6" : "min-h-7",
        reservesStepHeadTime(stepRail) && STEP_HEAD_TIME_ROOM_CLASS_NAME,
        timelineRowHorizontalPaddingClassName(horizontalPadding),
        className,
      )}
    >
      <span className={TIMELINE_LEDGER_ROW_CONTENT_CLASS_NAME}>
        {stepWork ? null : glyph}
        <span className="inline-flex min-w-0 max-w-full items-baseline gap-1.5">
          {children}
          {stepWork ? figure : null}
        </span>
      </span>
      {stepWork ? null : figure}
    </div>
  );
}

export function timelineRowHorizontalPaddingClassName(
  horizontalPadding: TimelineRowHorizontalPadding,
): string {
  switch (horizontalPadding) {
    case "default":
      return "px-2";
    case "flush":
      return "px-0";
  }
}

export function timelineRowHeaderClassName(
  horizontalPadding: TimelineRowHorizontalPadding,
): string {
  return cn(
    timelineRowHorizontalPaddingClassName(horizontalPadding),
    TIMELINE_ROW_HEADER_CONTROL_CLASS_NAME,
  );
}

export function TimelineStaticRowHeader({
  children,
  className,
  horizontalPadding = "default",
}: TimelineStaticRowHeaderProps) {
  return (
    <div className={cn("w-full rounded-md text-muted-foreground", className)}>
      <CollapsibleHeader
        toneClassName={COLLAPSIBLE_HEADER_STATIC_TONE_CLASS}
        className={timelineRowHeaderClassName(horizontalPadding)}
        summaryClassName={TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME}
        summaryContent={children}
      />
    </div>
  );
}

interface TimelineActionRowHeaderProps {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
  summaryClassName: string;
}

export function TimelineActionRowHeader({
  children,
  disabled,
  onClick,
  summaryClassName,
}: TimelineActionRowHeaderProps) {
  return (
    <div className="w-full rounded-md">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          COLLAPSIBLE_HEADER_BUTTON_BASE_CLASS,
          timelineRowHeaderClassName("default"),
          disabled
            ? COLLAPSIBLE_HEADER_STATIC_TONE_CLASS
            : cn(COLLAPSIBLE_HEADER_COLLAPSED_TONE_CLASS, "cursor-pointer"),
        )}
      >
        <span
          className={cn(
            TIMELINE_ROW_HEADER_CONTENT_CLASS_NAME,
            summaryClassName,
          )}
        >
          {children}
        </span>
      </button>
    </div>
  );
}

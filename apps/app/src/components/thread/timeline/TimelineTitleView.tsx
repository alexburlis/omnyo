import { Fragment, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  assertNever,
  durationToCompactString,
  formatDiffStatsText,
  type TimelineTitle,
  type TimelineTitleAction,
  type TimelineTitleDecoration,
  type TimelineTitleSegment,
  type TimelineTitleSegmentAccent,
  type TimelineTitleTone,
} from "@omnyo/thread-view";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { Icon } from "@omnyo/shared-ui/icon";
import { DiffStatsTally } from "@/components/ui/diff-stats-tally.js";
import { RouteAnchor } from "@/components/ui/app-route-anchor.js";
import { LiveDurationText } from "./LiveDurationText.js";
import { useTimelineStepRail } from "./timeline-step-rail";
import {
  ThreadTitleMentions,
  useResolveThreadTitle,
  useThreadRoutePath,
} from "@/components/thread/ThreadTitleMentions";
import {
  ConversationMessageOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow.js";

export type TimelineTitleActionResolver = (
  action: TimelineTitleAction,
) => (() => void) | null;

export type TimelineTitleLedgerStyle = "row" | "sentence";

interface TimelineTitleViewProps {
  title: TimelineTitle;
  onTitleAction?: TimelineTitleActionResolver;
  wrap?: boolean;
  ledger?: TimelineTitleLedgerStyle;
  monoEmphasis?: boolean;
}

const LEDGER_VERB_CLASS_NAME =
  "text-subtle-foreground group-hover/toggle:text-muted-foreground";

const LEDGER_OBJECT_CLASS_NAME =
  "text-muted-foreground group-hover/toggle:text-foreground";

const LEDGER_RUNNING_OBJECT_CLASS_NAME = "text-foreground";

const LEDGER_META_CLASS_NAME = "text-xs text-timeline-meta";

function ledgerSegmentToneClass({
  index,
  ledger,
  running,
  segment,
}: {
  index: number;
  ledger: TimelineTitleLedgerStyle;
  running: boolean;
  segment: TimelineTitleSegment;
}): string {
  const isVerb = ledger === "row" && index === 0 && !segment.em;

  if (isVerb) return LEDGER_VERB_CLASS_NAME;

  return running ? LEDGER_RUNNING_OBJECT_CLASS_NAME : LEDGER_OBJECT_CLASS_NAME;
}

function splitFilePath(text: string): { name: string; directory: string } {
  const slash = text.lastIndexOf("/");

  if (slash <= 0 || slash === text.length - 1) {
    return { name: text, directory: "" };
  }

  return { name: text.slice(slash + 1), directory: text.slice(0, slash) };
}

function emToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "font-medium text-foreground opacity-70";
    case "summary":
      return "text-subtle-foreground";
    default:
      return assertNever(tone);
  }
}

function isParentheticalQualifier(text: string): boolean {
  return text.startsWith("(") && text.endsWith(")");
}

function accentToneClass(
  accent: TimelineTitleSegmentAccent,
  em: boolean,
): string {
  switch (accent) {
    case "muted":
      return "text-muted-foreground";
    case "subtle":
      return "text-subtle-foreground";
    case "file":
      return em ? "font-medium text-timeline-accent" : "text-timeline-accent";
    default:
      return assertNever(accent);
  }
}

function plainToneClass(tone: TimelineTitleTone): string {
  switch (tone) {
    case "default":
      return "text-muted-foreground";
    case "summary":
      return "text-subtle-foreground";
    default:
      return assertNever(tone);
  }
}

function badgeToneClass(tone: "neutral" | "destructive"): string {
  return tone === "destructive"
    ? "text-destructive-text"
    : "text-muted-foreground";
}

const STATUS_DECORATION_TONE_CLASS = "text-subtle-foreground";

const STATUS_DECORATION_TEXT_CLASS = cn(
  "font-mono text-xs font-normal leading-none",
  STATUS_DECORATION_TONE_CLASS,
);

function renderStatusDecorationText(
  text: string,
  className?: string,
): ReactNode {
  return (
    <span className={cn(STATUS_DECORATION_TEXT_CLASS, "ml-px", className)}>
      {text}
    </span>
  );
}

interface LedgerSegmentStyle {
  toneClassName: string;
  mono: boolean;
  splitPath: boolean;
}

function segmentContent(segment: TimelineTitleSegment): ReactNode {
  return segment.link?.kind === "thread" ? (
    <ThreadTitleMentions title={segment.text} />
  ) : (
    segment.text
  );
}

function renderSegment(
  segment: TimelineTitleSegment,
  index: number,
  tone: TimelineTitleTone,
  interactive: {
    onClick: (() => void) | null;
    linkHref: string | null;
  },
  wrap: boolean,
  ledgerStyle: LedgerSegmentStyle | null,
): ReactNode {
  const widthClass = wrap
    ? "whitespace-pre-wrap"
    : segment.truncate
      ? cn(
          "min-w-0 truncate whitespace-pre",
          isParentheticalQualifier(segment.text) && "shrink-[1000]",
        )
      : "shrink-0 whitespace-pre";

  const toneClass =
    ledgerStyle !== null
      ? ledgerStyle.toneClassName
      : segment.accent !== undefined
        ? accentToneClass(segment.accent, segment.em)
        : segment.em
          ? emToneClass(tone)
          : plainToneClass(tone);

  const baseClass = cn(
    widthClass,
    toneClass,
    ledgerStyle?.mono ? "font-mono text-xs" : null,
    segment.shimmer ? "animate-shine" : null,
  );

  if (
    ledgerStyle?.splitPath === true &&
    interactive.linkHref === null &&
    !wrap
  ) {
    const { directory, name } = splitFilePath(segment.text);

    if (directory.length > 0) {
      return (
        <span
          key={index}
          className="inline-flex min-w-0 items-baseline gap-1.5 overflow-hidden"
        >
          {renderSegment(
            { ...segment, text: name, truncate: true },
            index,
            tone,
            interactive,
            wrap,
            { ...ledgerStyle, splitPath: false },
          )}
          <span
            className={cn(
              "min-w-0 shrink-[1000] truncate whitespace-pre",
              LEDGER_META_CLASS_NAME,
            )}
          >
            {directory}
          </span>
        </span>
      );
    }
  }

  if (interactive.linkHref !== null) {
    const href = interactive.linkHref;

    return (
      <RouteAnchor
        key={index}
        href={href}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline underline-offset-2 focus-visible:outline-none",
        )}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.stopPropagation();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLAnchorElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
      >
        {segmentContent(segment)}
      </RouteAnchor>
    );
  }

  if (segment.em && interactive.onClick) {
    const onClick = interactive.onClick;

    return (
      <span
        key={index}
        role="link"
        tabIndex={0}
        className={cn(
          baseClass,
          "cursor-pointer text-left underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none",
        )}
        onClick={(event: MouseEvent<HTMLSpanElement>) => {
          event.stopPropagation();
          onClick();
        }}
        onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            onClick();
          }
        }}
      >
        {segmentContent(segment)}
      </span>
    );
  }

  return (
    <span key={index} className={baseClass}>
      {segmentContent(segment)}
    </span>
  );
}

function renderLedgerDecoration(
  decoration: TimelineTitleDecoration,
  index: number,
): ReactNode {
  switch (decoration.kind) {
    case "duration":
    case "summary-status":
      return null;
    case "status":
      return (
        <span
          key={index}
          className={cn(
            "shrink-0 whitespace-pre",
            decoration.status === "error"
              ? "text-xs text-destructive-text"
              : LEDGER_META_CLASS_NAME,
          )}
        >
          {decoration.status}
        </span>
      );
    case "diff-stats":
      return (
        <DiffStatsTally
          key={index}
          insertions={decoration.added}
          deletions={decoration.removed}
          hideZero
          className="shrink-0 text-xs tabular-nums"
        />
      );
    case "badge":
      return renderDecoration(decoration, index, "default");
    default:
      return assertNever(decoration);
  }
}

function renderDecoration(
  decoration: TimelineTitleDecoration,
  index: number,
  tone: TimelineTitleTone,
): ReactNode {
  const baseClass = cn("shrink-0 whitespace-pre", plainToneClass(tone));

  switch (decoration.kind) {
    case "duration": {
      const durationClass = decoration.em
        ? cn("shrink-0 whitespace-pre tabular-nums", emToneClass(tone))
        : cn(baseClass, "tabular-nums");

      return (
        <span key={index} className={durationClass}>
          {decoration.completedAt !== null ? (
            durationToCompactString(
              decoration.completedAt - decoration.startedAt,
            )
          ) : (
            <LiveDurationText startedAt={decoration.startedAt} />
          )}
        </span>
      );
    }

    case "status":
    case "summary-status": {
      if (decoration.kind === "status") {
        const durationText =
          decoration.durationMs === null
            ? null
            : durationToCompactString(decoration.durationMs);

        return (
          <span
            key={index}
            className={cn(
              "shrink-0 whitespace-pre",
              STATUS_DECORATION_TONE_CLASS,
              "inline-flex items-baseline gap-1",
            )}
          >
            {durationText ? (
              <span className="tabular-nums">{durationText}</span>
            ) : null}
            {renderStatusDecorationText(
              decoration.status,
              decoration.status === "error" && decoration.emphasis
                ? "text-destructive-text"
                : undefined,
            )}
          </span>
        );
      }

      const parts: string[] = [];

      if (decoration.errorCount > 0) {
        parts.push(
          `${decoration.errorCount} ${
            decoration.errorCount === 1 ? "error" : "errors"
          }`,
        );
      }

      if (decoration.interruptedCount > 0) {
        parts.push(`${decoration.interruptedCount} interrupted`);
      }

      const text = parts.join(", ");

      if (text.length === 0) return null;

      return (
        <span key={index} className="shrink-0 whitespace-pre">
          {renderStatusDecorationText(text)}
        </span>
      );
    }

    case "diff-stats": {
      if (tone === "summary") {
        const text = formatDiffStatsText({
          added: decoration.added,
          removed: decoration.removed,
          hideZero: true,
        });

        if (text.length === 0) return null;

        return (
          <span key={index} className={baseClass}>
            {text}
          </span>
        );
      }

      return (
        <DiffStatsTally
          key={index}
          insertions={decoration.added}
          deletions={decoration.removed}
          hideZero
          className="shrink-0"
        />
      );
    }

    case "badge": {
      const badgeClass = badgeToneClass(decoration.tone);

      return (
        <span
          key={index}
          className="inline-flex shrink-0 items-center self-center align-middle"
          title={decoration.hint}
        >
          <Icon
            name={decoration.glyph}
            className={cn("size-3.5", badgeClass)}
            aria-label={decoration.hint}
          />
        </span>
      );
    }

    default:
      return assertNever(decoration);
  }
}

export function TimelineTitleView({
  title,
  onTitleAction,
  wrap = false,
  ledger,
  monoEmphasis = false,
}: TimelineTitleViewProps) {
  const onClick =
    title.action && onTitleAction ? onTitleAction(title.action) : null;

  const resolveTitle = useResolveThreadTitle();
  const threadRoutePath = useThreadRoutePath();

  const plainTitle = title.segments.some((segment) => segment.link)
    ? resolveTitle(title.plain)
    : title.plain;

  const running = title.segments.some((segment) => segment.shimmer);
  const stepWork = useTimelineStepRail()?.role === "work";

  const ledgerStyle = (
    segment: TimelineTitleSegment,
    index: number,
  ): LedgerSegmentStyle | null =>
    ledger === undefined
      ? null
      : {
          toneClassName: ledgerSegmentToneClass({
            index,
            ledger,
            running,
            segment,
          }),
          mono: monoEmphasis && segment.em,
          splitPath: segment.accent === "file",
        };

  const decorations = title.decorations
    .map((decoration, index) =>
      ledger === undefined
        ? renderDecoration(decoration, index, title.tone)
        : renderLedgerDecoration(decoration, index),
    )
    .filter((node) => node !== null);

  return (
    <span
      className={cn(
        "min-w-0 max-w-full leading-5",
        ledger !== undefined && stepWork ? "text-xs" : "text-sm",
        wrap
          ? "whitespace-pre-wrap [overflow-wrap:anywhere]"
          : "inline-flex items-baseline gap-1 overflow-hidden whitespace-nowrap",
      )}
      title={plainTitle}
    >
      {title.segments.map((segment, index) => {
        const linkHref = segment.link
          ? threadRoutePath(segment.link.threadId, undefined, null)
          : null;

        return (
          <Fragment key={`segment-${index}`}>
            {index > 0 ? " " : null}
            {renderSegment(
              segment,
              index,
              title.tone,
              { onClick, linkHref },
              wrap,
              ledgerStyle(segment, index),
            )}
          </Fragment>
        );
      })}
      {decorations.map((decoration, index) => (
        <Fragment key={`decoration-${index}`}> {decoration}</Fragment>
      ))}
    </span>
  );
}

export function ExpandableTimelineTitle(props: TimelineTitleViewProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);

  const overflowing = useIsOverflowing({
    elementRef: ref,
    enabled: !expanded,
    measurementKey: props.title.plain,
  });

  return (
    <span className="block min-w-0 flex-1">
      <span
        ref={ref}
        className={cn("block text-sm leading-5", !expanded && "line-clamp-2")}
      >
        <TimelineTitleView {...props} wrap />
      </span>
      {expanded || overflowing ? (
        <ConversationMessageOverflowToggle
          expanded={expanded}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}
    </span>
  );
}

import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import type { ThreadListIndicatorKind } from "@omnyo/client-core";
import { threadIndicatorLabel } from "@/lib/thread-indicator-label";
import type {
  PluginComposerThreadRowStatus,
  PluginThreadStatusGlyphProps,
} from "@omnyo/plugin-sdk";
import { pluginIconName } from "@/components/plugin/PluginIcon";
import {
  SIDEBAR_STATUS_ICON_CLASS,
  SIDEBAR_SUCCESS_STATUS_COLOR_CLASS,
  SIDEBAR_SUCCESS_STATUS_DOT_CLASS,
} from "@omnyo/shared-ui/sidebar-row-classes";

const WAITING_ICONS = {
  "waiting-for-input": "CircleQuestion",
  "queued-waiting": "CircleDashed",
  "input-welcome": "MessageQuestion",
  "callback-waiting": "CircleDashed",
  "dependency-failed": "CircleAlert",
  external: "Sent",
} satisfies Partial<Record<ThreadListIndicatorKind, IconName>>;

function subagentCountLabel(count: number): string {
  return count === 1 ? "1 subagent" : `${count} subagents`;
}

function WorkingThreadIndicator({
  label,
  size,
  subagents,
}: {
  label: string | null;
  size: "default" | "compact";
  subagents: number;
}) {
  const sizeClass = size === "compact" ? "size-3.5" : SIDEBAR_STATUS_ICON_CLASS;

  if (subagents <= 0) {
    return (
      <span
        role="img"
        className={cn(
          "pointer-events-none inline-flex shrink-0 items-center justify-center",
          sizeClass,
        )}
        aria-label={label ?? undefined}
      >
        <span className="omnyo-working-orb omnyo-working-orb-fill">
          <span className="omnyo-working-orb-halo" />
          <span className="omnyo-working-orb-ring" />
          <span className="omnyo-working-orb-core" />
        </span>
      </span>
    );
  }

  const countLabel = subagentCountLabel(subagents);

  return (
    <span
      role="img"
      className={cn(
        "pointer-events-none relative inline-flex shrink-0 items-center justify-center text-timeline-accent",
        sizeClass,
      )}
      aria-label={label === null ? countLabel : `${label} · ${countLabel}`}
    >
      <span className="absolute inset-0 rounded-full border-[1.5px] border-current opacity-25" />
      <span className="absolute inset-0 animate-spin rounded-full border-[1.5px] border-current border-r-transparent border-b-transparent" />
      <span
        className={cn(
          "text-2xs font-semibold leading-none",
          subagents < 10 ? "tabular-nums" : "tracking-tighter",
        )}
      >
        {subagents}
      </span>
    </span>
  );
}

function PluginThreadRowStatusIndicator({
  status,
  size,
  subagents,
}: {
  status: PluginComposerThreadRowStatus;
  size: "default" | "compact";
  subagents: number;
}) {
  const iconSizeClass =
    size === "compact" ? "size-3.5" : SIDEBAR_STATUS_ICON_CLASS;

  if (status.tone === "running") {
    return (
      <WorkingThreadIndicator
        label={status.label}
        size={size}
        subagents={subagents}
      />
    );
  }

  return (
    <Icon
      name={pluginIconName(status.icon)}
      className={cn(
        "pointer-events-none shrink-0",
        iconSizeClass,
        status.tone === "success"
          ? SIDEBAR_SUCCESS_STATUS_COLOR_CLASS
          : status.tone === "error"
            ? "text-destructive"
            : "text-muted-foreground",
      )}
      aria-label={status.label}
    />
  );
}

interface ThreadStatusResolution {
  accessibleLabel: string | null;
  indicatorKind: ThreadListIndicatorKind | "archived";
  rowStatusIsVisible: boolean;
}

export function resolveThreadStatus(
  indicator: ThreadListIndicatorKind,
  rowStatus: PluginComposerThreadRowStatus | null = null,
  archived = false,
): ThreadStatusResolution {
  const indicatorKind = archived ? "archived" : indicator;

  const rowStatusIsVisible =
    !archived &&
    rowStatus !== null &&
    indicatorKind !== "runtime" &&
    indicatorKind !== "unread-error" &&
    indicatorKind !== "waiting-for-input" &&
    indicatorKind !== "input-welcome" &&
    indicatorKind !== "callback-waiting" &&
    indicatorKind !== "dependency-failed" &&
    indicatorKind !== "external";

  return {
    accessibleLabel: rowStatusIsVisible
      ? rowStatus.label
      : indicatorKind === "archived"
        ? "Archived thread"
        : threadIndicatorLabel(indicatorKind),
    indicatorKind,
    rowStatusIsVisible,
  };
}

export function ThreadStatusGlyph({
  indicator,
  archived = false,
  rowStatus = null,
  hideIdleDraftLabel = false,
  size = "default",
  experimental_subagents: subagents = 0,
}: PluginThreadStatusGlyphProps) {
  const iconSizeClass =
    size === "compact" ? "size-3.5" : SIDEBAR_STATUS_ICON_CLASS;

  const { indicatorKind: kind, rowStatusIsVisible } = resolveThreadStatus(
    indicator,
    rowStatus,
    archived,
  );

  if (rowStatusIsVisible && rowStatus) {
    return (
      <PluginThreadRowStatusIndicator
        status={rowStatus}
        size={size}
        subagents={subagents}
      />
    );
  }

  switch (kind) {
    case "archived":
      return (
        <Icon
          name="Archive"
          className={iconSizeClass}
          aria-label="Archived thread"
        />
      );
    case "unread-error":
    case "queued-failed":
      return (
        <Icon
          name="CircleX"
          className={cn("text-destructive", iconSizeClass)}
          aria-label={threadIndicatorLabel(kind) ?? undefined}
        />
      );
    case "waiting-for-input":
    case "input-welcome":
    case "callback-waiting":
    case "dependency-failed":
    case "queued-waiting":
    case "external":
      return (
        <Icon
          name={WAITING_ICONS[kind]}
          className={cn("text-muted-foreground/75", iconSizeClass)}
          aria-label={threadIndicatorLabel(kind) ?? undefined}
        />
      );
    case "working-draft":
    case "workflow":
    case "background-agent":
    case "background-command":
    case "plan-mode":
    case "goal":
    case "runtime":
      return (
        <WorkingThreadIndicator
          label={threadIndicatorLabel(kind)}
          size={size}
          subagents={subagents}
        />
      );
    case "draft":
      return (
        <Icon
          name="Edit"
          className={cn(
            "pointer-events-none shrink-0 text-muted-foreground",
            iconSizeClass,
          )}
          {...(hideIdleDraftLabel
            ? { "aria-hidden": true }
            : { "aria-label": threadIndicatorLabel(kind) ?? undefined })}
        />
      );
    case "ready-to-archive":
      return (
        <Icon
          name="CircleCheckSolid"
          className={cn(SIDEBAR_SUCCESS_STATUS_COLOR_CLASS, iconSizeClass)}
          aria-label={threadIndicatorLabel(kind) ?? undefined}
        />
      );
    case "open":
      return (
        <Icon
          name="CircleCheck"
          className={cn(SIDEBAR_SUCCESS_STATUS_COLOR_CLASS, iconSizeClass)}
          aria-label={threadIndicatorLabel(kind) ?? undefined}
        />
      );
    case "unread-success":
      return (
        <span
          className={SIDEBAR_SUCCESS_STATUS_DOT_CLASS}
          aria-label={threadIndicatorLabel(kind) ?? undefined}
        />
      );
    case "none":
      return null;
  }
}

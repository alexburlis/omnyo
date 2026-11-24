import type {
  PreviewStatus,
  TimelinePreviewActivityRef,
} from "@omnyo/server-contract";
import {
  previewActivityDisplayUrl,
  type TimelineActivitySystemRow,
  type TimelineTitle,
} from "@omnyo/thread-view";
import {
  freshManagedPreviewStatus,
  openManagedPreviewInApp,
  routeManagedPreviewHref,
  useManagedPreviewList,
  useManagedPreviewRefresh,
  useManagedPreviewStatus,
  useManagedPreviewVisibility,
} from "@/components/ui/managed-preview-link";
import { useHostDaemon } from "@/hooks/useHostDaemon";
import { useRewriteLocalhostLinksPreference } from "@/lib/localhost-link-rewrite-preference";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
} from "@omnyo/shared-ui/motion";
import {
  TimelineLedgerStaticRow,
  TimelineRowDotGlyph,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";
import type { ThreadTimelineLinkHandler } from "./types.js";

type PreviewState = PreviewStatus["state"];

export const PREVIEW_STATUS_LABELS: Record<PreviewState, string> = {
  online: "Running",
  stopped: "Stopped",
  starting: "Starting…",
  conflict: "Port in use",
  error: "Didn't start",
  unknown: "Status unknown",
  "host-offline": "Computer offline",
};

const DOT_TONE_CLASS_NAMES: Record<PreviewState | "removed", string> = {
  online: "bg-success",
  starting: "bg-warning",
  conflict: "bg-destructive-text",
  error: "bg-destructive-text",
  stopped: "bg-subtle-foreground",
  unknown: "bg-subtle-foreground",
  "host-offline": "bg-subtle-foreground",
  removed: "bg-subtle-foreground",
};

const UNOPENABLE_STATES: ReadonlySet<PreviewState> = new Set([
  "stopped",
  "conflict",
  "error",
  "host-offline",
]);

export function PreviewActivityRow({
  horizontalPadding,
  onOpenLink,
  onTitleAction,
  row,
  title,
}: {
  horizontalPadding: TimelineRowHorizontalPadding;
  onOpenLink: ThreadTimelineLinkHandler | undefined;
  onTitleAction: TimelineTitleActionResolver | undefined;
  row: TimelineActivitySystemRow<TimelinePreviewActivityRef>;
  title: TimelineTitle;
}) {
  const { previewId, url, hostName } = row.activityRef;
  const { localDaemonHostId } = useHostDaemon();
  const [rewriteLocalhostLinks] = useRewriteLocalhostLinksPreference();
  const { ref, visible } = useManagedPreviewVisibility<HTMLSpanElement>();
  const previews = useManagedPreviewList(row.threadId, visible);

  const binding = previews.data?.previews.find(
    (preview) => preview.id === previewId,
  );

  const removed = previews.isSuccess && binding === undefined;

  const observed = useManagedPreviewStatus(
    removed ? undefined : previewId,
    visible,
  );

  useManagedPreviewRefresh(row.threadId, removed ? undefined : previewId);

  const state = freshManagedPreviewStatus(observed)?.state ?? "unknown";
  const host = binding?.hostName ?? hostName;

  const meta = removed
    ? "Removed"
    : host.length > 0
      ? `${PREVIEW_STATUS_LABELS[state]} · ${host}`
      : PREVIEW_STATUS_LABELS[state];

  const routedHref =
    binding === undefined
      ? undefined
      : routeManagedPreviewHref({
          enabled: rewriteLocalhostLinks,
          href: binding.url,
          previewId: binding.id,
          sourceHostId: binding.hostId,
          viewerHostId: localDaemonHostId,
        });

  const openable =
    routedHref !== undefined && !removed && !UNOPENABLE_STATES.has(state);

  return (
    <TimelineLedgerStaticRow
      horizontalPadding={horizontalPadding}
      glyph={
        <TimelineRowDotGlyph
          toneClassName={DOT_TONE_CLASS_NAMES[removed ? "removed" : state]}
        />
      }
      figure={
        openable ? (
          <a
            href={routedHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${previewActivityDisplayUrl(url)}`}
            className={cn(
              "ml-auto -mr-1.5 shrink-0 rounded-md px-1.5 text-xs leading-5.5 text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              CONTROL_PRESS_TRANSITION,
              CONTROL_PRESS_FEEDBACK,
            )}
            onClick={(event) =>
              openManagedPreviewInApp(event, routedHref, onOpenLink)
            }
          >
            Open
          </a>
        ) : undefined
      }
    >
      <TimelineTitleView
        title={title}
        onTitleAction={onTitleAction}
        ledger="row"
      />
      <span
        ref={ref}
        data-preview-activity-state={removed ? "removed" : state}
        className="shrink-0 whitespace-nowrap text-xs text-timeline-meta"
      >
        {meta}
      </span>
    </TimelineLedgerStaticRow>
  );
}

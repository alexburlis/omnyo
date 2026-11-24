import { PreviewAnnouncementsProvider } from "@/components/ui/preview-announcements";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ActiveThinking, ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { Button } from "@omnyo/shared-ui/button";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import { HeightTransition } from "@/components/ui/height-transition.js";
import { Icon } from "@omnyo/shared-ui/icon";
import { isRouteLoadingSkeletonMounted } from "@/components/ui/route-loading-skeleton";
import { toUserAttachmentImageSrc } from "@/lib/user-attachment-images";
import {
  SHORT_LIVED_STATUS_DELAY_MS,
  useSustainedFlag,
} from "@/hooks/useSustainedFlag";
import { withoutCompactCommandRows } from "@/lib/compaction-queued-messages";
import {
  CompactionQueuedMessages,
  useQueuedMessagesAwaitingCompaction,
} from "./CompactionQueuedMessages.js";
import { ThreadTimelineLoadingSkeleton } from "./ThreadTimelineLoadingSkeleton.js";
import {
  ThreadTimelineRows,
  type ThreadTimelineRowsProps,
} from "./ThreadTimelineRows.js";
import { useAutoLoadOlderRows } from "./useAutoLoadOlderRows.js";
import { TimelineStatusIndicator } from "./TimelineStatusIndicator.js";
import type { TimelineTitleActionResolver } from "./TimelineTitleView.js";
import { TimelineReasoningExpansionProvider } from "./TimelineReasoningExpansion.js";
import { TimelineWorkingIndicator } from "./TimelineWorkingIndicator.js";
import { summarizeLiveActivity } from "./live-activity.js";
import type {
  ThreadTimelineForkMessageHandler,
  ThreadTimelineEditMessageHandler,
  ThreadTimelineInlineMessageEditor,
  ThreadTimelineAddToChatHandler,
  ThreadTimelineConsumerMessageAction,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineOpenPluginPanelHandler,
  ThreadTimelineUnreadDividerPlacement,
  UserAttachmentImageSrcResolver,
} from "./types.js";

export interface HostConnectionNotice {
  label: string;
}

export interface ThreadTimelineSurfaceProps {
  completion?: ThreadTimelineRowsProps["completion"];
  activeThinking: ActiveThinking | null;
  canSpawnChild?: boolean;
  contextBoundarySeq: number | null;
  hasPagedHistory?: boolean;
  hasOlderTimelineRows?: boolean;
  hostConnectionNotice?: HostConnectionNotice | null;
  isCatchingUpTimeline?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  isThreadTimelinePending: boolean;
  timelineError: boolean;
  loadingContent?: ReactNode;
  leadingContent?: ReactNode;
  onForkMessage?: ThreadTimelineForkMessageHandler;
  onEditMessage?: ThreadTimelineEditMessageHandler;
  inlineMessageEditor?: ThreadTimelineInlineMessageEditor;
  onMessageAddToChat?: ThreadTimelineAddToChatHandler;
  onSelectionAddToChat?: ThreadTimelineAddToChatHandler;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: ThreadTimelineOpenPluginPanelHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  showOngoingIndicator: boolean;
  ongoingIndicatorLabel?: string;
  ongoingIndicatorPlacement?: "timeline" | "composer";
  isStopping?: boolean;
  stoppingAnchorAt?: number;
  timelineErrorClassName?: string;
  timelineRows: TimelineRow[];
  threadId: string;
  threadRuntimeDisplayStatus?: ThreadRuntimeDisplayStatus;
  readOnly?: boolean;
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
  workspaceRootPath: string | undefined;
}

interface BuildStopRequestedTimelineRowArgs {
  stoppingAnchorAt: number;
  threadId: string;
}

interface UseTimelineRowsWithPendingStopArgs {
  rows: TimelineRow[];
  isStopping: boolean;
  stoppingAnchorAt: number;
  threadId: string;
}

function buildStopRequestedTimelineRow({
  stoppingAnchorAt,
  threadId,
}: BuildStopRequestedTimelineRowArgs): TimelineRow {
  return {
    id: `${threadId}:pending-stop`,
    threadId,
    turnId: null,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: stoppingAnchorAt,
    createdAt: stoppingAnchorAt,
    kind: "system",
    systemKind: "operation",
    operationKind: "thread-interrupted",
    title: "Stop requested",
    detail: null,
    status: "pending",
    completedAt: null,
  };
}

function hasConfirmedStopRow(rows: readonly TimelineRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "system" &&
      row.systemKind === "operation" &&
      row.operationKind === "thread-interrupted",
  );
}

function useTimelineRowsWithPendingStop({
  rows,
  isStopping,
  stoppingAnchorAt,
  threadId,
}: UseTimelineRowsWithPendingStopArgs): TimelineRow[] {
  return useMemo(() => {
    if (!isStopping || hasConfirmedStopRow(rows)) {
      return rows;
    }

    return [
      ...rows,
      buildStopRequestedTimelineRow({ stoppingAnchorAt, threadId }),
    ];
  }, [rows, isStopping, stoppingAnchorAt, threadId]);
}

export function ThreadTimelineSurface({
  completion,
  activeThinking,
  canSpawnChild,
  contextBoundarySeq,
  hasPagedHistory = false,
  hasOlderTimelineRows = false,
  hostConnectionNotice,
  isCatchingUpTimeline = false,
  isLoadingOlderTimelineRows = false,
  isThreadTimelinePending,
  timelineError,
  loadingContent,
  leadingContent,
  onForkMessage,
  onEditMessage,
  inlineMessageEditor,
  onMessageAddToChat,
  onSelectionAddToChat,
  consumerMessageActions,
  includePluginMessageActions,
  onLoadOlderRows,
  onOpenLink,
  onOpenLocalFileLink,
  onOpenPluginPanel,
  onTitleAction,
  projectId,
  resolveMentionLink,
  showOngoingIndicator,
  ongoingIndicatorLabel,
  ongoingIndicatorPlacement = "timeline",
  isStopping = false,
  stoppingAnchorAt = 0,
  timelineErrorClassName = "mt-6 text-destructive",
  timelineRows,
  readOnly = false,
  threadId,
  threadRuntimeDisplayStatus,
  unreadDividerAutoScroll,
  unreadDividerPlacement,
  workspaceRootPath,
}: ThreadTimelineSurfaceProps) {
  const resolveUserAttachmentImageSrc =
    useCallback<UserAttachmentImageSrcResolver>(
      (path, projectId, options) =>
        toUserAttachmentImageSrc(path, projectId, threadId, options),
      [threadId],
    );

  const showCatchUpIndicator =
    isCatchingUpTimeline &&
    !isThreadTimelinePending &&
    !timelineError &&
    !showOngoingIndicator;

  const liveActivity = useMemo(
    () =>
      summarizeLiveActivity({
        activeThinking,
        label: ongoingIndicatorLabel,
        rows: showOngoingIndicator ? timelineRows : [],
      }),
    [activeThinking, ongoingIndicatorLabel, showOngoingIndicator, timelineRows],
  );

  const showActiveThinking = liveActivity.isThinking;

  const activeThinkingText = activeThinking?.text.trim() ?? "";

  const activeThinkingDetails =
    showActiveThinking && activeThinkingText.length > 0
      ? activeThinking?.text
      : undefined;

  const ongoingIndicatorKey =
    showActiveThinking && activeThinking
      ? activeThinking.id
      : (ongoingIndicatorLabel ?? "working");

  const visibleTimelineRows = useMemo(
    () => withoutCompactCommandRows(timelineRows),
    [timelineRows],
  );

  const messagesAwaitingCompaction = useQueuedMessagesAwaitingCompaction();

  const showWorkingIndicator =
    showOngoingIndicator && messagesAwaitingCompaction.length === 0;

  const timelineRowsWithPendingStop = useTimelineRowsWithPendingStop({
    rows: visibleTimelineRows,
    isStopping,
    stoppingAnchorAt,
    threadId,
  });

  const isOngoingIndicatorSustained = useSustainedFlag(
    showWorkingIndicator,
    SHORT_LIVED_STATUS_DELAY_MS,
  );

  const statusInComposer = ongoingIndicatorPlacement === "composer";

  const isOngoingIndicatorVisible =
    showWorkingIndicator &&
    (!statusInComposer || activeThinkingDetails !== undefined) &&
    (timelineRowsWithPendingStop.length > 0 || isOngoingIndicatorSustained);

  const showLoadOlderRows =
    hasOlderTimelineRows &&
    onLoadOlderRows !== undefined &&
    !isThreadTimelinePending &&
    !timelineError;

  return (
    <TimelineReasoningExpansionProvider key={threadId} threadId={threadId}>
      <PreviewAnnouncementsProvider>
        <ConversationTimeline
          className={
            isOngoingIndicatorVisible ? "flex-1 timeline-working" : "flex-1"
          }
        >
          {leadingContent}
          {showLoadOlderRows ? (
            <LoadOlderMessages
              key={`context-boundary:${contextBoundarySeq}`}
              hasOlderTimelineRows={hasOlderTimelineRows}
              isLoadingOlderTimelineRows={isLoadingOlderTimelineRows}
              onLoadOlderRows={onLoadOlderRows}
            />
          ) : null}
          {isThreadTimelinePending ? (
            (loadingContent ?? <DelayedThreadLoadingIndicator />)
          ) : (
            <>
              {timelineError ? (
                <TimelineStatusIndicator
                  label="Failed to load timeline"
                  className={timelineErrorClassName}
                />
              ) : null}
              {timelineRowsWithPendingStop.length > 0 ? (
                <ThreadTimelineRows
                  completion={completion}
                  canSpawnChild={canSpawnChild}
                  onForkMessage={onForkMessage}
                  onEditMessage={onEditMessage}
                  inlineMessageEditor={inlineMessageEditor}
                  onMessageAddToChat={onMessageAddToChat}
                  onSelectionAddToChat={onSelectionAddToChat}
                  consumerMessageActions={consumerMessageActions}
                  includePluginMessageActions={includePluginMessageActions}
                  onOpenLink={onOpenLink}
                  onOpenLocalFileLink={onOpenLocalFileLink}
                  onOpenPluginPanel={onOpenPluginPanel}
                  onTitleAction={onTitleAction}
                  projectId={projectId}
                  resolveMentionLink={resolveMentionLink}
                  resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
                  hasPagedHistory={hasPagedHistory}
                  hasOlderTimelineRows={hasOlderTimelineRows}
                  isLoadingOlderTimelineRows={isLoadingOlderTimelineRows}
                  onLoadOlderRows={onLoadOlderRows}
                  timelineRows={timelineRowsWithPendingStop}
                  threadId={threadId}
                  threadRuntimeDisplayStatus={threadRuntimeDisplayStatus}
                  readOnly={readOnly}
                  unreadDividerAutoScroll={unreadDividerAutoScroll}
                  unreadDividerPlacement={unreadDividerPlacement}
                  workspaceRootPath={workspaceRootPath}
                />
              ) : null}
              <CompactionQueuedMessages
                messages={messagesAwaitingCompaction}
                resolveMentionLink={resolveMentionLink}
              />
            </>
          )}
          {hostConnectionNotice ? (
            <TimelineStatusIndicator
              label={hostConnectionNotice.label}
              className="mt-4 text-destructive"
            />
          ) : null}
          {showCatchUpIndicator ? <DelayedCatchUpIndicator /> : null}
          <HeightTransition visible={isOngoingIndicatorVisible}>
            <TimelineWorkingIndicator
              key={ongoingIndicatorKey}
              details={activeThinkingDetails}
              reasoningId={activeThinking?.id}
              isThinking={showActiveThinking}
              label={liveActivity.label}
              startedAt={statusInComposer ? undefined : liveActivity.startedAt}
              statusInComposer={statusInComposer}
            />
          </HeightTransition>
        </ConversationTimeline>
      </PreviewAnnouncementsProvider>
    </TimelineReasoningExpansionProvider>
  );
}

function LoadOlderMessages({
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
}: {
  hasOlderTimelineRows: boolean;
  isLoadingOlderTimelineRows: boolean;
  onLoadOlderRows: () => Promise<void> | void;
}) {
  const { isAutoLoadEnabled, loadOlderRows } = useAutoLoadOlderRows({
    hasOlderTimelineRows,
    isLoadingOlderTimelineRows,
    onLoadOlderRows,
  });

  return (
    <div className="flex justify-center pt-2 mb-3">
      {isAutoLoadEnabled ? (
        <span
          className="text-muted-foreground text-xs"
          aria-live="polite"
          role="status"
        >
          {isLoadingOlderTimelineRows ? "Loading older messages…" : " "}
        </span>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={loadOlderRows}
          disabled={isLoadingOlderTimelineRows}
        >
          <Icon name="ChevronUp" aria-hidden="true" />
          {isLoadingOlderTimelineRows
            ? "Loading older messages..."
            : "Load older messages"}
        </Button>
      )}
    </div>
  );
}

const LOADING_INDICATOR_REVEAL_DELAY_MS = 200;

const CATCH_UP_INDICATOR_LABEL = "Loading latest messages…";

const CATCH_UP_INDICATOR_REVEAL_DELAY_MS = 1_000;

function DelayedCatchUpIndicator() {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(
      () => setVisible(true),
      CATCH_UP_INDICATOR_REVEAL_DELAY_MS,
    );

    return () => window.clearTimeout(id);
  }, []);

  if (!visible) return null;

  return (
    <span role="status" className="sr-only">
      {CATCH_UP_INDICATOR_LABEL}
    </span>
  );
}

function DelayedThreadLoadingIndicator() {
  const [visible, setVisible] = useState(isRouteLoadingSkeletonMounted);
  useEffect(() => {
    if (visible) {
      return;
    }

    const id = window.setTimeout(
      () => setVisible(true),
      LOADING_INDICATOR_REVEAL_DELAY_MS,
    );

    return () => window.clearTimeout(id);
  }, [visible]);

  if (!visible) {
    return null;
  }

  return <ThreadTimelineLoadingSkeleton />;
}

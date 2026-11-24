import {
  conversationTimelineRows,
  type EmbeddedConversation,
} from "@/lib/embedded-conversation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { isRunningThreadRuntimeDisplayStatus } from "@omnyo/client-core";
import { EmptyStatePanel } from "@omnyo/shared-ui/empty-state";
import { ThreadTimelinePanelLoadingSkeleton } from "./ThreadChatLoading";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { ConversationTimeline } from "@/components/ui/conversation.js";
import { useThread } from "@/hooks/queries/thread-queries";
import { OmnyoHttpError } from "@/lib/sdk";
import {
  ThreadTimelineSurface,
  type ThreadTimelineSurfaceProps,
} from "./ThreadTimelineSurface.js";
import {
  useThreadTimelineController,
  type UseThreadTimelineControllerResult,
} from "./useThreadTimelineController.js";

interface ThreadTimelinePanelContentProps {
  isTurnSubmitting?: boolean;
  conversation?: Pick<EmbeddedConversation, "pluginId" | "itemId">;
  leadingContent?: ReactNode;
  onMessageAddToChat?: ThreadTimelineSurfaceProps["onMessageAddToChat"];
  onSelectionAddToChat?: ThreadTimelineSurfaceProps["onSelectionAddToChat"];
  consumerMessageActions?: ThreadTimelineSurfaceProps["consumerMessageActions"];
  includePluginMessageActions?: ThreadTimelineSurfaceProps["includePluginMessageActions"];
  onOpenLink?: ThreadTimelineSurfaceProps["onOpenLink"];
  onOpenLocalFileLink?: ThreadTimelineSurfaceProps["onOpenLocalFileLink"];
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  surfaceKey?: string;
  threadId: string;
  timeline?: UseThreadTimelineControllerResult;
  workspaceRootPath?: string;
}

export function ThreadTimelinePanelContent({
  isTurnSubmitting = false,
  conversation,
  leadingContent,
  onMessageAddToChat,
  onSelectionAddToChat,
  consumerMessageActions,
  includePluginMessageActions,
  onOpenLink,
  onOpenLocalFileLink,
  projectId,
  resolveMentionLink,
  surfaceKey,
  threadId,
  timeline,
  workspaceRootPath,
}: ThreadTimelinePanelContentProps) {
  const [conversationSearch, setConversationSearch] = useState({
    pages: 0,
    failed: false,
    loading: false,
  });

  const conversationSearchPending = useRef(false);
  const threadQuery = useThread(threadId);

  const ownedTimeline = useThreadTimelineController({
    enabled: timeline === undefined,
    surfaceKey,
    threadId,
  });

  const resolvedTimeline = timeline ?? ownedTimeline;
  const displayStatus = threadQuery.data?.runtime.displayStatus ?? "idle";

  const isProvisioningDisplayStatus =
    displayStatus === "provisioning" || displayStatus === "starting";

  const hasActiveBackgroundWork =
    resolvedTimeline.activeWorkflows.length > 0 ||
    resolvedTimeline.activeBackgroundCommands.length > 0 ||
    (threadQuery.data?.activeBackgroundAgentCount ?? 0) > 0;

  const backgroundOnlyIndicatorLabel =
    displayStatus === "idle" && hasActiveBackgroundWork
      ? "Background work running"
      : undefined;

  const ongoingIndicatorLabel = isProvisioningDisplayStatus
    ? "Provisioning thread..."
    : backgroundOnlyIndicatorLabel;

  const showOngoingIndicator =
    threadQuery.data?.status !== "stopping" &&
    (isProvisioningDisplayStatus ||
      (!resolvedTimeline.timelineLoading &&
        (isTurnSubmitting ||
          isRunningThreadRuntimeDisplayStatus(displayStatus) ||
          backgroundOnlyIndicatorLabel !== undefined)));

  const timelineRows = conversation
    ? conversationTimelineRows(resolvedTimeline.timelineRows, conversation)
    : resolvedTimeline.timelineRows;

  const loadOlderTimelineRows = resolvedTimeline.loadOlderTimelineRows;

  const canFindEarlierConversation =
    conversation !== undefined &&
    timelineRows.length === 0 &&
    resolvedTimeline.hasOlderTimelineRows;

  useEffect(() => {
    if (
      !canFindEarlierConversation ||
      conversationSearchPending.current ||
      conversationSearch.failed ||
      conversationSearch.pages >= 20 ||
      resolvedTimeline.isLoadingOlderTimelineRows
    )
      return;
    conversationSearchPending.current = true;
    setConversationSearch((current) => ({ ...current, loading: true }));

    void loadOlderTimelineRows()
      .then(
        () => {
          setConversationSearch((current) => ({
            pages: current.pages + 1,
            failed: false,
            loading: false,
          }));
        },
        () => {
          setConversationSearch((current) => ({
            ...current,
            failed: true,
            loading: false,
          }));
        },
      )
      .finally(() => {
        conversationSearchPending.current = false;
      });
  }, [
    canFindEarlierConversation,
    conversationSearch,
    loadOlderTimelineRows,
    resolvedTimeline.isLoadingOlderTimelineRows,
  ]);

  const scopedLeadingContent = (
    <>
      {leadingContent}
      {canFindEarlierConversation && conversationSearch.loading ? (
        <div role="status">Loading this conversation…</div>
      ) : null}
      {canFindEarlierConversation &&
      (conversationSearch.failed || conversationSearch.pages >= 20) ? (
        <div>
          {conversationSearch.failed ? (
            <div role="alert">Earlier messages could not load.</div>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setConversationSearch({
                pages: 0,
                failed: false,
                loading: false,
              });
            }}
          >
            Continue loading this conversation
          </Button>
        </div>
      ) : null}
    </>
  );

  const conversationActive =
    conversation === undefined ||
    (timelineRows.length > 0 &&
      timelineRows.at(-1)?.turnId ===
        resolvedTimeline.timelineRows.at(-1)?.turnId);

  const isChildThreadMissing =
    threadQuery.error instanceof OmnyoHttpError &&
    threadQuery.error.status === 404;

  if (isChildThreadMissing) {
    return (
      <ConversationTimeline className="flex-1">
        {leadingContent}
        <EmptyStatePanel className="mx-2 rounded-lg">
          This thread is no longer available.
        </EmptyStatePanel>
      </ConversationTimeline>
    );
  }

  return (
    <ThreadTimelineSurface
      readOnly={resolvedTimeline.isReadOnlyDisplay}
      activeThinking={
        conversationActive ? resolvedTimeline.activeThinking : null
      }
      contextBoundarySeq={resolvedTimeline.contextBoundarySeq}
      hasPagedHistory={resolvedTimeline.hasPagedHistory}
      hasOlderTimelineRows={resolvedTimeline.hasOlderTimelineRows}
      isCatchingUpTimeline={resolvedTimeline.isCatchingUpTimeline}
      isLoadingOlderTimelineRows={resolvedTimeline.isLoadingOlderTimelineRows}
      isThreadTimelinePending={
        resolvedTimeline.timelineLoading &&
        timelineRows.length === 0 &&
        !showOngoingIndicator
      }
      timelineError={
        Boolean(resolvedTimeline.timelineError) && timelineRows.length === 0
      }
      loadingContent={<ThreadTimelinePanelLoadingSkeleton />}
      leadingContent={scopedLeadingContent}
      onMessageAddToChat={onMessageAddToChat}
      onSelectionAddToChat={onSelectionAddToChat}
      consumerMessageActions={consumerMessageActions}
      includePluginMessageActions={includePluginMessageActions}
      onLoadOlderRows={resolvedTimeline.loadOlderTimelineRows}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      projectId={projectId}
      resolveMentionLink={resolveMentionLink}
      showOngoingIndicator={showOngoingIndicator && conversationActive}
      ongoingIndicatorLabel={ongoingIndicatorLabel}
      timelineErrorClassName="mx-2 mt-4 text-destructive"
      timelineRows={timelineRows}
      threadId={threadId}
      threadRuntimeDisplayStatus={displayStatus}
      workspaceRootPath={workspaceRootPath}
    />
  );
}

import type { ThreadWorkSummary } from "@omnyo/domain";
import { removeCompletionReportFromDisplay } from "../completion-report";
import { selectCompletionMessageId } from "./completion-message";
import { MarkdownTablesContainedContext } from "@/components/ui/markdown-preview";
import { markStartupChatRendered } from "@/lib/startup-settled";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { TimelineImageGallery } from "./TimelineImageGallery";
import { TimelineTurnActivityLine } from "./TimelineTurnActivityLine";
import {
  findUpdatePauseResumedAt,
  foldWarningsIntoFinishedTurns,
  formatUpdatePauseLabel,
  isFoldedTurnRow,
  isUpdatePauseRow,
} from "./timeline-turn-activity";
import { collectLiveTimelineExpansionRowIds } from "./timeline-live-expansion";
import {
  isFailedTimelineWork,
  timelineWorkSummaryNote,
} from "./timeline-work-summary-note";
import { timelineRowFigureTiming } from "./timeline-row-figure";
import { TimelineRowFigure } from "./TimelineRowFigure";
import {
  collectMaintenanceRunOutcomes,
  maintenanceRunOutcomeFallback,
  maintenanceRunTitleText,
  NO_MAINTENANCE_RUN_OUTCOMES,
  type MaintenanceRunOutcome,
} from "./maintenance-run-rows";
import {
  findReceiptedAnswerIds,
  timelineRowRhythm,
  timelineRowRhythmStyle,
  type TimelineRowRhythm,
} from "./timeline-turn-rhythm";
import type { PromptInput, ThreadRuntimeDisplayStatus } from "@omnyo/domain";
import type {
  TimelineParentChange,
  TimelineRow,
  TimelineSystemOperationKind,
} from "@omnyo/server-contract";
import type { ThreadChatMessageReference } from "@omnyo/plugin-sdk";
import {
  activityIntentTitleGlyph,
  assertNever,
  buildTimelineActivityIntentTitles,
  buildTimelineRowTitle,
  buildTimelineViewRows,
  createTimelineViewRowsCache,
  hasTimelineExplorationIntent,
  findActiveLatestBundleId,
  isHumanThreadInput,
  isChildActivityRow,
  isPreviewActivityRow,
  isTimelineActivityRow,
  parseSentThreadMessage,
  workRowGlyph,
  workRowPluginGlyph,
  workRowPresentation,
  type BuildTimelineRowTitleOptions,
  type ThreadTellCommand,
  type BuildTimelineViewRowsOptions,
  type ThreadTimelineViewRow,
  type TimelineActivityIntentTitle,
  type TimelineTitle,
  type TimelineViewDelegationWorkRow,
  type TimelineViewTurnRow,
  type TimelineViewWorkRow,
} from "@omnyo/thread-view";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  deferredTimelineContentItemId,
  isNonExpandableSummary,
  isRowExpandable,
  resolveDeferredTimelineContent,
} from "@omnyo/client-core";
import {
  getMessageLinkPath,
  isRunningThreadRuntimeDisplayStatus,
} from "@omnyo/client-core";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineEditMessageHandler,
  ThreadTimelineInlineMessageEditor,
  ThreadTimelineForkMessageHandler,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  ThreadTimelineOpenPluginPanelHandler,
  ThreadTimelineImageViewSrcResolver,
  ThreadTimelineConsumerMessageAction,
  ThreadTimelinePluginMessageAction,
  ThreadTimelineUnreadDividerPlacement,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import {
  MessageColumnWidthContext,
  useMeasuredWidth,
} from "./MessageActionBar.js";
import { TimelineSelectionMenu } from "./TimelineSelectionMenu.js";
import type { MessageProseSelection } from "./SelectableMessageProse.js";
import { TimelineReasoningDetail } from "./TimelineReasoningDetail.js";
import { ExpandableTimelineRow } from "./ExpandableTimelineRow.js";
import { TimelineWorkResult } from "./TimelineWorkResult.js";
import {
  timelineTitleLeadWords,
  timelineWorkResult,
  workResultRepeatsTitle,
} from "./timeline-work-result.js";
import {
  isActiveLatestBundleSummary,
  pastRowDimClassName,
  PAST_ROW_DIM_CLASS_NAME,
} from "./timeline-row-prominence.js";
import { TimelineRowBodyPlaceholder } from "./TimelineRowBodyPlaceholder.js";
import {
  timelineDetailIdentity,
  usePreloadTimelineRowBody,
  useTimelineRowBodyRenderersReady,
} from "./timeline-row-body-preload.js";
import {
  TimelineActionRowHeader,
  TimelineLeadingIcon,
  TimelineLedgerStaticRow,
  TimelineRowGlyph,
  TimelineStaticRowHeader,
  timelineRowHorizontalPaddingClassName,
  type TimelineRowGlyphState,
  type TimelineRowHorizontalPadding,
} from "./TimelineRowHeader.js";
import {
  ExpandableTimelineTitle,
  TimelineTitleView,
  type TimelineTitleActionResolver,
} from "./TimelineTitleView.js";
import { WorkRowBody } from "./TimelineRowDetails.js";
import { TimelineDetailScroll } from "./TimelineDetailScroll.js";
import { Button } from "@omnyo/shared-ui/button";
import { Icon, type IconName } from "@omnyo/shared-ui/icon";
import { WorkflowPhaseStrip } from "@omnyo/shared-ui/workflow-progress";
import { presentationTintStyle } from "./presentation-display.js";
import { usePluginIconUrl } from "@/lib/plugin-logos";
import {
  PluginTimelineRendererBody,
  isPluginRenderableWorkRow,
  usePluginTimelineRenderer,
} from "./PluginTimelineRendererBody.js";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body.js";
import {
  collectSearchedMessageAncestorRowIds,
  SearchMessageLocationProvider,
  useScrollToSearchedMessage,
  useSearchMessageLocation,
} from "./useScrollToSearchedMessage.js";
import {
  joinSignatureParts,
  timelineRowRenderSignature,
  timelineRowsSignature,
} from "@omnyo/client-core";
import {
  TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
  timelineRowContainmentStyle,
  useArmTopLevelTimelineRowContainment,
} from "./timeline-row-containment.js";
import {
  isTimelineLedgerRow,
  timelineRailClassName,
  timelineRailPositions,
  type TimelineRailPosition,
} from "./timeline-nested-group-line.js";
import {
  TimelineStepRailContext,
  timelineStepRailClassName,
  timelineStepRails,
  type TimelineStepLink,
  type TimelineStepRail,
} from "./timeline-step-rail";
import { GeneratedConversationMessage } from "./GeneratedConversationMessage.js";
import { ChildActivityRow } from "./ChildActivityRow.js";
import { PreviewActivityRow } from "./PreviewActivityRow.js";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { useThreadTimelineTurnSummaryDetails } from "@/hooks/queries/thread-queries";
import { type ThreadTimelineTurnSummaryDetailsQueryIdentity } from "@/hooks/queries/query-keys";
import { useSenderThreadMetadata } from "@/hooks/useSenderThreadMetadataById";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginMessageActionSlot,
} from "@/lib/plugin-slots.js";
import { runPluginMessageAction } from "@/lib/plugin-message-actions.js";
import {
  usePluginComposerHost,
  type PluginComposerHost,
} from "@/components/plugin/plugin-composer-host";
import { isPluginSideChatSenderThread } from "@/lib/side-chat-plugin.js";
import {
  buildMessageDirectiveRegistry,
  MessageDirectiveRegistryProvider,
} from "@/components/ui/markdown-message-directives.js";
import {
  buildCodeFenceRendererRegistry,
  CodeFenceRendererRegistryProvider,
} from "@/components/ui/markdown-code-fence-renderers.js";
import { InsideTimelineDetailScrollContext } from "./TimelineDetailScroll.js";
import {
  historyRowSpacerHeight,
  useHistoryRowWindow,
} from "./useHistoryRowWindow";
import { StickyUserMessage } from "./StickyUserMessage.js";
import { canonicalAppOrigin } from "@/lib/canonical-app-origin";

export interface ThreadTimelineRowsProps {
  completion?: ThreadWorkSummary;
  initialExpanded?: ReadonlySet<string>;
  canSpawnChild?: boolean;
  onForkMessage?: ThreadTimelineForkMessageHandler;
  onEditMessage?: ThreadTimelineEditMessageHandler;
  inlineMessageEditor?: ThreadTimelineInlineMessageEditor;
  onMessageAddToChat?: ThreadTimelineAddToChatHandler;
  onSelectionAddToChat?: ThreadTimelineAddToChatHandler;
  consumerMessageActions?: readonly ThreadTimelineConsumerMessageAction[];
  includePluginMessageActions?: boolean;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: ThreadTimelineOpenPluginPanelHandler;
  onTitleAction?: TimelineTitleActionResolver;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  resolveImageViewSrc?: ThreadTimelineImageViewSrcResolver;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  hasPagedHistory?: boolean;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  timelineRows: TimelineRow[];
  threadId?: string;
  threadRuntimeDisplayStatus?: ThreadRuntimeDisplayStatus;
  readOnly?: boolean;
  unreadDividerAutoScroll?: boolean;
  unreadDividerPlacement?: ThreadTimelineUnreadDividerPlacement | null;
  workspaceRootPath: string | undefined;
}

interface TimelineRendererStaticContextValue {
  completion: ThreadTimelineRowsProps["completion"];
  completionMessageId: string | null;
  canSpawnChild: boolean;
  getViewRows: GetTimelineViewRows;
  onForkMessage: ThreadTimelineForkMessageHandler | undefined;
  onEditMessage: ThreadTimelineEditMessageHandler | undefined;
  inlineMessageEditor: ThreadTimelineInlineMessageEditor | undefined;
  onMessageAddToChat: ThreadTimelineAddToChatHandler | undefined;
  onSelectionAddToChat: ThreadTimelineAddToChatHandler | undefined;
  pluginMessageActions: readonly PluginMessageActionSlot[];
  consumerMessageActions: readonly ThreadTimelineConsumerMessageAction[];
  reportProseSelection:
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined;
  onOpenLink: ThreadTimelineLinkHandler | undefined;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  onOpenPluginPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
  onTitleAction: TimelineTitleActionResolver | undefined;
  projectId: string | undefined;
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
  resolveUserAttachmentImageSrc: UserAttachmentImageSrcResolver | undefined;
  threadId: string | undefined;
  workspaceRootPath: string | undefined;
}

interface TimelineTurnStateContextValue {
  initialAutoExpandedRowIds: ReadonlySet<string>;
  liveAutoExpandedRowIds: ReadonlySet<string>;
}

interface TimelineRowsListProps {
  compactActivityIntents: boolean;
  hasPagedHistory?: boolean;
  hasOlderTimelineRows?: boolean;
  isLoadingOlderTimelineRows?: boolean;
  onLoadOlderRows?: () => Promise<void> | void;
  rows: readonly ThreadTimelineViewRow[];
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
  className?: string;
  unreadDividerAutoScroll: boolean;
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface TimelineUnreadDividerProps {
  autoScroll: boolean;
  placementKey: string;
}

interface TimelineRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  spacing: TimelineRowsListSpacing;
}

interface TimelineExpandableRowViewProps {
  activeLatestBundleId: string | null;
  compactActivityIntents: boolean;
  scopeActive: boolean;
  showAssistantMessageActions: boolean;
  title: TimelineTitle;
  horizontalPadding: TimelineRowHorizontalPadding;
  row: Exclude<ThreadTimelineViewRow, { kind: "conversation" }>;
}

interface TimelineExpandableBodyProps {
  activeLatestBundleId: string | null;
  scopeActive: boolean;
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  showAssistantMessageActions: boolean;
}

interface TurnRowBodyProps {
  scopeActive: boolean;
  compactActivityIntents: boolean;
  row: TimelineViewTurnRow;
  showAssistantMessageActions: boolean;
}

interface TimelineSystemDetailBlockProps {
  detail: string;
  streaming: boolean;
}

interface BuildTimelineRowsListItemsArgs {
  quietAnswerIds: ReadonlySet<string> | null;
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface FindUnreadDividerIndexArgs {
  rows: readonly ThreadTimelineViewRow[];
  unreadDividerPlacement: ThreadTimelineUnreadDividerPlacement | null;
}

interface IsUnreadDividerCandidateAfterCutoffArgs {
  cutoffAt: number;
  row: ThreadTimelineViewRow;
}

interface ActiveSummaryTreatmentArgs {
  activeLatestBundleId: string | null;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}

interface TimelineRowTitleRenderStateArgs extends ActiveSummaryTreatmentArgs {
  compactActivityIntents: boolean;
}

interface TimelineRowTitleRenderStateCache {
  key: string;
  state: TimelineRowTitleRenderState;
}

type TimelineConversationViewRow = Extract<
  ThreadTimelineViewRow,
  { kind: "conversation" }
>;

type TimelineRowTitleRenderState =
  | {
      kind: "compact-activity-intents";
      titles: readonly TimelineActivityIntentTitle[];
    }
  | {
      kind: "row-title";
      title: TimelineTitle;
    };

type TimelineRowsListSpacing = "top-level" | "nested" | "bundle";

type TimelineRawRows = readonly TimelineRow[];

type GetTimelineViewRows = (
  rows: TimelineRawRows,
  options?: BuildTimelineViewRowsOptions,
) => ThreadTimelineViewRow[];

type TimelineRowsListItem =
  | {
      kind: "row";
      row: ThreadTimelineViewRow;
      rhythm: TimelineRowRhythm | null;
    }
  | {
      kind: "unread-divider";
      id: "thread-unread-divider";
      placementKey: string;
      rhythm: TimelineRowRhythm | null;
    }
  | {
      kind: "update-pause";
      id: string;
      resumedAt: number | null;
      rhythm: TimelineRowRhythm | null;
    };

interface ConversationRowProps {
  row: TimelineConversationViewRow;
  showAssistantMessageActions: boolean;
}

interface ConversationRowContentProps extends ConversationRowProps {
  showTimestamp: boolean;
  streaming: boolean;
}

const TimelineRendererStaticContext =
  createContext<TimelineRendererStaticContextValue | null>(null);

const TimelineTurnStateContext =
  createContext<TimelineTurnStateContextValue | null>(null);

const StreamingAssistantMessageIdContext = createContext<string | null>(null);

const ActiveAssistantTurnIdContext = createContext<string | null>(null);

const EMPTY_ROW_ID_SET: ReadonlySet<string> = new Set<string>();

const ReceiptedAnswerIdsContext =
  createContext<ReadonlySet<string>>(EMPTY_ROW_ID_SET);

const MaintenanceRunOutcomesContext = createContext<
  ReadonlyMap<string, MaintenanceRunOutcome>
>(NO_MAINTENANCE_RUN_OUTCOMES);

const UNREAD_DIVIDER_RETRACT_DELAY_MS = 2_500;

const TimelineSearchExpansionContext =
  createContext<ReadonlySet<string>>(EMPTY_ROW_ID_SET);

function useTimelineRendererStaticContext(): TimelineRendererStaticContextValue {
  const context = useContext(TimelineRendererStaticContext);

  if (!context) {
    throw new Error("Thread timeline renderer context is missing");
  }

  return context;
}

function useTimelineTurnStateContext(): TimelineTurnStateContextValue {
  const context = useContext(TimelineTurnStateContext);

  if (!context) {
    throw new Error("Thread timeline turn-state context is missing");
  }

  return context;
}

function timelineRowTitleRenderStateKey({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
}: TimelineRowTitleRenderStateArgs): string {
  return joinSignatureParts([
    timelineRowRenderSignature(row),
    compactActivityIntents,
    scopeActive,
    activeLatestBundleId === row.id,
  ]);
}

function buildTimelineRowTitleRenderState({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
}: TimelineRowTitleRenderStateArgs): TimelineRowTitleRenderState {
  if (
    compactActivityIntents &&
    shouldRenderCompactActivityIntentRows(row) &&
    !scopeActive
  ) {
    const titles = buildTimelineActivityIntentTitles(row);

    if (titles.length > 0) {
      return {
        kind: "compact-activity-intents",
        titles,
      };
    }
  }

  const title = buildTimelineRowTitle(
    row,
    timelineRowTitleOptions({
      activeLatestBundleId,
      row,
      scopeActive,
    }),
  );

  return {
    kind: "row-title",
    title:
      row.kind === "system" && row.systemKind === "error"
        ? {
            ...title,
            decorations: title.decorations.filter(
              (decoration) => decoration.kind !== "status",
            ),
          }
        : title,
  };
}

function useTimelineRowTitleRenderState(
  args: TimelineRowTitleRenderStateArgs,
): TimelineRowTitleRenderState {
  const cacheRef = useRef<TimelineRowTitleRenderStateCache | null>(null);
  const key = timelineRowTitleRenderStateKey(args);
  const cached = cacheRef.current;

  if (cached?.key === key) {
    return cached.state;
  }

  const state = buildTimelineRowTitleRenderState(args);
  cacheRef.current = {
    key,
    state,
  };

  return state;
}

function areTimelineRowViewPropsEqual(
  previous: TimelineRowViewProps,
  next: TimelineRowViewProps,
): boolean {
  return (
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.scopeActive === next.scopeActive &&
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.spacing === next.spacing &&
    previous.activeLatestBundleId === next.activeLatestBundleId &&
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areTimelineExpandableRowViewPropsEqual(
  previous: TimelineExpandableRowViewProps,
  next: TimelineExpandableRowViewProps,
): boolean {
  return (
    previous.activeLatestBundleId === next.activeLatestBundleId &&
    previous.compactActivityIntents === next.compactActivityIntents &&
    previous.scopeActive === next.scopeActive &&
    previous.showAssistantMessageActions === next.showAssistantMessageActions &&
    previous.title === next.title &&
    previous.horizontalPadding === next.horizontalPadding &&
    (previous.row === next.row ||
      timelineRowRenderSignature(previous.row) ===
        timelineRowRenderSignature(next.row))
  );
}

function areReadonlySetsEqual(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left === right) return true;

  if (left.size !== right.size) return false;

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function useStableReadonlySet(
  values: ReadonlySet<string>,
): ReadonlySet<string> {
  const valuesRef = useRef(values);

  if (!areReadonlySetsEqual(valuesRef.current, values)) {
    valuesRef.current = values;
  }

  return valuesRef.current;
}

function useTimelineSearchExpansionRowIds(
  rows: readonly ThreadTimelineViewRow[],
): ReadonlySet<string> {
  const inheritedRowIds = useContext(TimelineSearchExpansionContext);
  const { threadId } = useTimelineRendererStaticContext();
  const { target } = useSearchMessageLocation();

  return useMemo(() => {
    if (target === null) {
      return inheritedRowIds;
    }

    if (
      threadId !== undefined &&
      target.threadId !== null &&
      target.threadId !== threadId
    ) {
      return inheritedRowIds;
    }

    const localRowIds = collectSearchedMessageAncestorRowIds(
      rows,
      target.seq,
      target.match,
    );

    if (localRowIds.size === 0) {
      return inheritedRowIds;
    }

    const combinedRowIds = new Set<string>(inheritedRowIds);

    for (const id of localRowIds) {
      combinedRowIds.add(id);
    }

    return combinedRowIds;
  }, [inheritedRowIds, rows, target, threadId]);
}

function useTimelineViewRowsCache(): GetTimelineViewRows {
  const cacheRef = useRef(createTimelineViewRowsCache());

  return useCallback<GetTimelineViewRows>(
    (rawRows, options) =>
      buildTimelineViewRows(rawRows, { ...options, cache: cacheRef.current }),
    [],
  );
}

function shouldRenderCompactActivityIntentRows(
  row: ThreadTimelineViewRow,
): row is Extract<TimelineViewWorkRow, { workKind: "command" }> {
  return (
    row.kind === "work" &&
    row.workKind === "command" &&
    row.approvalStatus === null
  );
}

function timelineRowTitleOptions({
  activeLatestBundleId,
  row,
  scopeActive,
}: ActiveSummaryTreatmentArgs): BuildTimelineRowTitleOptions {
  const useActiveBundleLabel = isActiveLatestBundleSummary({
    activeLatestBundleId,
    row,
    scopeActive,
  });

  return {
    summaryStyle: row.kind === "step-summary" ? "background" : "bundle",
    workStyle: row.kind === "work" && row.inClosedStep ? "summary" : "default",
    isActiveLatestBundle: useActiveBundleLabel,
  };
}

function timelineRowHorizontalPadding(
  spacing: TimelineRowsListSpacing,
): TimelineRowHorizontalPadding {
  switch (spacing) {
    case "top-level":
    case "nested":
      return "default";
    case "bundle":
      return "flush";
  }
}

function timelineRowsListGapClassName(
  spacing: TimelineRowsListSpacing,
): string {
  switch (spacing) {
    case "top-level":
      return "gap-0";
    case "nested":
      return "gap-0";
    case "bundle":
      return "gap-0";
  }
}

interface TimelineRowRail {
  position: TimelineRailPosition | null;
  joinsPrevious: boolean;
  className: string | undefined;
  step: TimelineStepRail | null;
}

const NO_RAIL: TimelineRowRail = {
  position: null,
  joinsPrevious: false,
  className: undefined,
  step: null,
};

const STEP_HEAD_SPACING_STEPS = 4;

export function findStreamingAssistantMessageId(
  rows: readonly ThreadTimelineViewRow[],
): string | null {
  let candidateRows: readonly ThreadTimelineViewRow[] = rows;

  for (;;) {
    const lastRow = candidateRows[candidateRows.length - 1];

    if (lastRow === undefined) {
      return null;
    }

    if (lastRow.kind === "conversation") {
      return lastRow.role === "assistant" ? lastRow.id : null;
    }

    if (
      lastRow.kind === "turn" &&
      lastRow.status === "pending" &&
      lastRow.children !== null
    ) {
      candidateRows = lastRow.children;
      continue;
    }

    if (
      lastRow.kind === "work" &&
      lastRow.workKind === "delegation" &&
      lastRow.status === "pending" &&
      lastRow.childRows !== null
    ) {
      candidateRows = lastRow.childRows;
      continue;
    }

    return null;
  }
}

const EMPTY_CONSUMER_MESSAGE_ACTIONS: readonly ThreadTimelineConsumerMessageAction[] =
  [];

function buildRowPluginMessageActions(args: {
  slots: readonly PluginMessageActionSlot[];
  timelineThreadId: string | undefined;
  message: ThreadChatMessageReference;
  selectedText?: string;
  openThreadPanel: ThreadTimelineOpenPluginPanelHandler | undefined;
  composerHost: PluginComposerHost | null;
}): readonly ThreadTimelinePluginMessageAction[] | undefined {
  const {
    slots,
    timelineThreadId,
    message,
    selectedText,
    openThreadPanel,
    composerHost,
  } = args;

  if (timelineThreadId === undefined || slots.length === 0) {
    return undefined;
  }

  return slots.map((slot) => ({
    key: `${slot.pluginId}/${slot.id}/${slot.generation}`,
    pluginId: slot.pluginId,
    icon: slot.icon ?? null,
    label: slot.title,
    onSelect: () =>
      runPluginMessageAction({
        slot,
        threadId: timelineThreadId,
        message,
        selectedText,
        openThreadPanel,
        composerHost,
      }),
  }));
}

function buildRowConsumerMessageActions(args: {
  actions: readonly ThreadTimelineConsumerMessageAction[];
  message: ThreadChatMessageReference;
}): readonly ThreadTimelinePluginMessageAction[] {
  const { actions, message } = args;

  return actions
    .filter(
      (action) =>
        action.roles === undefined || action.roles.includes(message.role),
    )
    .map((action) => ({
      key: `consumer/${action.id}`,
      pluginId: action.pluginId,
      icon: action.icon,
      label: action.label,
      onSelect: () => {
        const warn = (error: unknown) => {
          console.warn(
            `ThreadChat messageAction "${action.id}" failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        };

        try {
          const result = action.run(message);

          if (result instanceof Promise) {
            result.catch(warn);
          }
        } catch (error) {
          warn(error);
        }
      },
    }));
}

function ConversationRow({
  row,
  showAssistantMessageActions,
}: ConversationRowProps) {
  const streamingAssistantMessageId = useContext(
    StreamingAssistantMessageIdContext,
  );

  const activeTurnId = useContext(ActiveAssistantTurnIdContext);
  const receiptedAnswerIds = useContext(ReceiptedAnswerIdsContext);

  return (
    <ConversationRowContent
      row={row}
      showAssistantMessageActions={showAssistantMessageActions}
      showTimestamp={
        row.role === "user" ||
        (row.status !== "streaming" &&
          !receiptedAnswerIds.has(row.id) &&
          (activeTurnId === null || row.turnId !== activeTurnId))
      }
      streaming={
        row.role === "assistant" &&
        (row.status === undefined
          ? row.id === streamingAssistantMessageId
          : row.status === "streaming")
      }
    />
  );
}

function InlineMessageEditorHost({
  editor,
}: {
  editor: ThreadTimelineInlineMessageEditor;
}) {
  return (
    <div className="ml-auto w-full max-w-[70%] max-md:max-w-full">
      <div
        ref={editor.onHostElementChange}
        data-sent-message-inline-editor-host=""
      />
    </div>
  );
}

const ConversationRowContent = memo(function ConversationRowContent({
  row,
  showAssistantMessageActions,
  showTimestamp,
  streaming,
}: ConversationRowContentProps) {
  const composerHost = usePluginComposerHost();

  const { completion, completionMessageId } =
    useTimelineRendererStaticContext();

  const {
    canSpawnChild,
    inlineMessageEditor,
    onEditMessage,
    onForkMessage,
    onMessageAddToChat,
    onSelectionAddToChat,
    pluginMessageActions,
    consumerMessageActions,
    reportProseSelection,
    onOpenLink,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    onTitleAction,
    projectId,
    resolveMentionLink,
    resolveUserAttachmentImageSrc,
    threadId,
    workspaceRootPath,
  } = useTimelineRendererStaticContext();

  const senderThreadMetadata = useSenderThreadMetadata(
    row.role === "user" ? row.senderThreadId : null,
  );

  if (
    row.role === "user" &&
    inlineMessageEditor !== undefined &&
    inlineMessageEditor.messageId === row.id
  ) {
    return <InlineMessageEditorHost editor={inlineMessageEditor} />;
  }

  const messageReference: ThreadChatMessageReference = {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    text: row.text,
    sourceSeqEnd: row.sourceSeqEnd,
    experimental_messageSeq: row.messageSeq,
  };

  const rowSlotActions = buildRowPluginMessageActions({
    slots: pluginMessageActions,
    timelineThreadId: threadId,
    message: messageReference,
    openThreadPanel: onOpenPluginPanel,
    composerHost,
  });

  const rowConsumerActions =
    consumerMessageActions.length === 0
      ? []
      : buildRowConsumerMessageActions({
          actions: consumerMessageActions,
          message: messageReference,
        });

  const rowPluginActions =
    rowConsumerActions.length === 0
      ? rowSlotActions
      : [...(rowSlotActions ?? []), ...rowConsumerActions];

  const isSettledMessage =
    row.role === "user" ? row.turnRequest.status !== "pending" : !streaming;

  const onCopyLink =
    projectId === undefined || !isSettledMessage
      ? undefined
      : () => {
          void copyToClipboardWithToast(
            new URL(
              getMessageLinkPath({
                projectId,
                threadId: row.threadId,
                seq: row.messageSeq,
              }),
              canonicalAppOrigin(),
            ).toString(),
            {
              successMessage: "Message link copied",
              errorMessage: "Failed to copy message link",
            },
          );
        };

  if (row.role === "user") {
    const canEditMessage =
      onEditMessage !== undefined &&
      isHumanThreadInput(row) &&
      !row.turnRequest.isGrouped &&
      row.turnRequest.kind === "message" &&
      row.turnRequest.status === "accepted" &&
      (row.attachments?.imageUrls.length ?? 0) === 0;

    const onEdit = canEditMessage
      ? () => {
          const input: PromptInput[] = [];

          if (row.text.trim().length > 0) {
            input.push({
              type: "text",
              text: row.text,
              mentions: [...row.mentions],
            });
          }

          for (const path of row.attachments?.localImagePaths ?? []) {
            input.push({ type: "localImage", path });
          }

          for (const path of row.attachments?.localFilePaths ?? []) {
            const detail = row.attachments?.localFileDetails.find(
              (file) => file.path === path,
            );

            input.push({
              type: "localFile",
              path,
              ...(detail ? { name: detail.name } : {}),
              ...(detail?.sizeBytes == null
                ? {}
                : { sizeBytes: detail.sizeBytes }),
            });
          }

          onEditMessage({
            messageId: row.id,
            expectedRequestSequence: row.sourceSeqStart,
            input,
          });
        }
      : undefined;

    return (
      <ConversationMessageContent
        attachments={row.attachments}
        id={row.id}
        initiator={row.initiator}
        mentions={row.mentions}
        onAddToChat={onSelectionAddToChat}
        onCopyLink={onCopyLink}
        onEdit={onEdit}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        onOpenPluginPanel={onOpenPluginPanel}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
        role="user"
        onTitleAction={onTitleAction}
        senderThreadId={row.senderThreadId}
        senderThreadProjectId={senderThreadMetadata?.projectId}
        senderThreadTitle={senderThreadMetadata?.title ?? null}
        senderIsPluginSideChat={isPluginSideChatSenderThread(
          senderThreadMetadata,
        )}
        systemMessageKind={row.systemMessageKind}
        systemMessageSubject={row.systemMessageSubject}
        pluginActions={rowPluginActions}
        text={row.text}
        timestamp={row.startedAt}
        threadId={row.threadId}
        turnId={row.turnId}
        turnRequest={row.turnRequest}
        workspaceRootPath={workspaceRootPath}
      />
    );
  }

  const onFork =
    onForkMessage === undefined
      ? undefined
      : () => onForkMessage({ sourceSeqEnd: row.sourceSeqEnd });

  const onSelectProse =
    reportProseSelection === undefined
      ? undefined
      : (selection: MessageProseSelection | null) =>
          reportProseSelection(
            row.id,
            selection === null
              ? null
              : { ...selection, sourceSeqEnd: row.sourceSeqEnd },
            messageReference,
          );

  const messageCompletion =
    row.id === completionMessageId ? completion : undefined;

  return (
    <ConversationMessageContent
      attachments={row.attachments}
      id={row.id}
      onAddToChat={onMessageAddToChat}
      onCopyLink={onCopyLink}
      onFork={onFork}
      forkDisabled={!canSpawnChild}
      onSelectProse={onSelectProse}
      onOpenLink={onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onOpenPluginPanel={onOpenPluginPanel}
      pluginActions={rowPluginActions}
      projectId={projectId}
      resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
      role="assistant"
      showActions={showAssistantMessageActions}
      showTimestamp={showTimestamp}
      streaming={streaming}
      text={row.text}
      displayText={
        messageCompletion === undefined
          ? undefined
          : removeCompletionReportFromDisplay({
              text: row.text,
              assessmentReason: messageCompletion.assessment.reason,
            })
      }
      timestamp={row.createdAt}
      threadId={row.threadId}
      turnId={row.turnId}
      turnGit={row.turnGit}
      workspaceRootPath={workspaceRootPath}
    />
  );
});

function TimelineUnreadDivider({
  autoScroll,
  placementKey,
}: TimelineUnreadDividerProps) {
  const bottomAnchor = useBottomAnchoredScroll();
  const dividerRef = useRef<HTMLDivElement>(null);
  const hasScrolledRef = useRef(false);

  useEffect(() => {
    if (!autoScroll || !bottomAnchor || hasScrolledRef.current) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const divider = dividerRef.current;

      if (!divider) {
        return;
      }

      hasScrolledRef.current = true;
      bottomAnchor.scrollElementIntoViewClampedToMaxScroll({
        element: divider,
      });
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [autoScroll, bottomAnchor]);

  const [retractedPlacementKey, setRetractedPlacementKey] = useState<
    string | null
  >(null);

  const retracted = retractedPlacementKey === placementKey;
  const isAtBottom = bottomAnchor?.isAtBottom ?? false;

  useEffect(() => {
    if (retracted || !isAtBottom) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setRetractedPlacementKey(placementKey);
    }, UNREAD_DIVIDER_RETRACT_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [isAtBottom, placementKey, retracted]);

  return (
    <div
      ref={dividerRef}
      role="separator"
      aria-label="New messages"
      aria-hidden={retracted ? "true" : undefined}
      className="flex items-center gap-2 px-2 py-1 text-2xs font-medium text-timeline-accent"
      data-testid="thread-unread-divider"
      data-unread-divider=""
      data-retracted={retracted ? "" : undefined}
    >
      <span className="shrink-0" data-unread-divider-word="">
        New
      </span>
      <span
        className="h-px w-14 shrink-0 bg-linear-to-r from-timeline-accent to-transparent"
        data-unread-divider-rule=""
        aria-hidden
      />
    </div>
  );
}

function TimelineUpdatePauseDivider({
  resumedAt,
}: {
  resumedAt: number | null;
}) {
  return (
    <div
      role="separator"
      aria-label={formatUpdatePauseLabel(resumedAt)}
      className="flex items-center gap-2.5 px-2 py-1 text-2xs text-subtle-foreground"
      data-testid="thread-update-pause-divider"
    >
      <span className="h-px min-w-0 flex-1 bg-border-hairline" aria-hidden />
      <span className="shrink-0">{formatUpdatePauseLabel(resumedAt)}</span>
      <span className="h-px min-w-0 flex-1 bg-border-hairline" aria-hidden />
    </div>
  );
}

function TimelineSystemDetailBlock({
  detail,
  streaming,
}: TimelineSystemDetailBlockProps) {
  return (
    <TimelineDetailScroll
      size="base"
      streaming={streaming}
      contentKey={detail}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <pre className="whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-5 text-muted-foreground">
        {detail}
      </pre>
    </TimelineDetailScroll>
  );
}

function TimelineExpandableBody(props: TimelineExpandableBodyProps) {
  const { row } = props;
  const { threadId } = useTimelineRendererStaticContext();
  const itemId = deferredTimelineContentItemId(row);

  const [lastInlineRow, setLastInlineRow] = useState(
    itemId === null ? row : null,
  );

  if (itemId === null && row !== lastInlineRow) {
    setLastInlineRow(row);
  }

  const preloadBody = usePreloadTimelineRowBody(row, threadId);
  useEffect(() => {
    preloadBody();
  }, [preloadBody]);

  const deferred = useTimelineDetailRows(
    timelineDetailIdentity(row, threadId, itemId ?? ""),
    itemId !== null,
  );

  const resolved =
    itemId !== null && deferred.rows !== undefined
      ? resolveDeferredTimelineContent(row, deferred.rows)
      : null;

  const displayRow =
    itemId === null
      ? row
      : (resolved ??
        (lastInlineRow !== null && lastInlineRow.id === row.id
          ? lastInlineRow
          : null));

  const renderersReady = useTimelineRowBodyRenderersReady(row);

  if (displayRow !== null && renderersReady) {
    return <TimelineExpandableBodyContent {...props} row={displayRow} />;
  }

  if (
    displayRow === null &&
    (deferred.isError || deferred.rows !== undefined)
  ) {
    return (
      <TimelineDetailLoadError
        horizontalPadding="flush"
        label="Failed to load details."
        onRetry={deferred.retry}
      />
    );
  }

  return <TimelineRowBodyPlaceholder />;
}

function TimelineExpandableBodyContent({
  activeLatestBundleId,
  scopeActive,
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TimelineExpandableBodyProps) {
  const { workspaceRootPath, resolveImageViewSrc } =
    useTimelineRendererStaticContext();

  switch (row.kind) {
    case "bundle-summary":
    case "step-summary": {
      const list = (
        <TimelineRowsList
          rows={row.children}
          scopeActive={scopeActive}
          showAssistantMessageActions={showAssistantMessageActions}
          compactActivityIntents={true}
          spacing="bundle"
          unreadDividerAutoScroll={false}
          unreadDividerPlacement={null}
        />
      );

      if (!isNonExpandableSummary(row.children)) {
        return list;
      }

      const isFrontier =
        row.kind === "bundle-summary" && row.id === activeLatestBundleId;

      return (
        <TimelineDetailScroll
          size="summary"
          streaming={isFrontier}
          contentKey={timelineRowsSignature(row.children)}
        >
          {list}
        </TimelineDetailScroll>
      );
    }

    case "turn": {
      const body = (
        <TurnRowBody
          scopeActive={scopeActive && row.status === "pending"}
          row={row}
          compactActivityIntents={compactActivityIntents}
          showAssistantMessageActions={
            showAssistantMessageActions && row.status === "pending"
          }
        />
      );

      if (!isFoldedTurnRow(row)) return body;

      return (
        <div className="flex flex-col pt-0.5" data-turn-activity-details="">
          {row.absorbedRows !== undefined ? (
            <TimelineRowsList
              rows={row.absorbedRows}
              scopeActive={false}
              showAssistantMessageActions={false}
              compactActivityIntents={compactActivityIntents}
              spacing="nested"
              unreadDividerAutoScroll={false}
              unreadDividerPlacement={null}
            />
          ) : null}
          {body}
        </div>
      );
    }

    case "work":
      if (row.workKind === "delegation") {
        return <DelegationRowBody row={row} />;
      }

      return (
        <WorkRowBodyWithPluginRenderer
          row={row}
          resolveImageViewSrc={resolveImageViewSrc}
          workspaceRootPath={workspaceRootPath}
        />
      );
    case "system":
      if (row.systemKind === "operation" && row.operationKind === "reasoning") {
        return row.detail ? (
          <TimelineReasoningDetail text={row.detail} />
        ) : null;
      }

      return row.detail ? (
        <TimelineSystemDetailBlock
          detail={row.detail}
          streaming={row.status === "pending"}
        />
      ) : null;
    case "conversation":
      return null;
    default:
      return assertNever(row);
  }
}

function WorkRowBodyWithPluginRenderer({
  row,
  resolveImageViewSrc,
  workspaceRootPath,
}: {
  row: TimelineViewWorkRow;
  resolveImageViewSrc: ThreadTimelineImageViewSrcResolver | undefined;
  workspaceRootPath: string | undefined;
}) {
  const slot = usePluginTimelineRenderer(row);

  const original = useCallback(
    () => (
      <WorkRowBody
        row={row}
        resolveImageViewSrc={resolveImageViewSrc}
        workspaceRootPath={workspaceRootPath}
      />
    ),
    [resolveImageViewSrc, row, workspaceRootPath],
  );

  if (slot !== null && isPluginRenderableWorkRow(row)) {
    return (
      <PluginTimelineRendererBody row={row} slot={slot} original={original} />
    );
  }

  return original();
}

function TurnRowBody({
  scopeActive,
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TurnRowBodyProps) {
  return (
    <ActiveAssistantTurnIdContext.Provider
      value={row.status === "pending" ? row.turnId : null}
    >
      {row.children === null ? (
        <LazyTurnRowBody
          scopeActive={scopeActive}
          compactActivityIntents={compactActivityIntents}
          row={row}
          showAssistantMessageActions={showAssistantMessageActions}
        />
      ) : (
        <TimelineRowsList
          rows={row.children}
          scopeActive={scopeActive}
          showAssistantMessageActions={showAssistantMessageActions}
          compactActivityIntents={compactActivityIntents}
          spacing="nested"
          unreadDividerAutoScroll={false}
          unreadDividerPlacement={null}
        />
      )}
    </ActiveAssistantTurnIdContext.Provider>
  );
}

function useTimelineDetailRows(
  identity: ThreadTimelineTurnSummaryDetailsQueryIdentity,
  enabled: boolean,
) {
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetchingNextPage,
    refetch,
  } = useThreadTimelineTurnSummaryDetails(identity, { enabled });

  const retry = useCallback((): void => {
    void refetch();
  }, [refetch]);

  const loadEarlier = useCallback((): void => {
    void fetchNextPage();
  }, [fetchNextPage]);

  return {
    hasEarlierRows: hasNextPage,
    isError,
    isLoadingEarlierRows: isFetchingNextPage,
    loadEarlier,
    retry,
    rows: data,
  };
}

function TimelineDetailLoadError({
  horizontalPadding,
  label,
  onRetry,
}: {
  horizontalPadding: TimelineRowHorizontalPadding;
  label: string;
  onRetry: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-sm text-destructive-text",
        timelineRowHorizontalPaddingClassName(horizontalPadding),
      )}
    >
      <span>{label}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={onRetry}
        className="h-7 cursor-pointer border-destructive px-2 text-destructive hover:text-destructive"
      >
        <Icon name="RotateCcw" />
        Retry
      </Button>
    </div>
  );
}

function LoadEarlierTimelineDetailRow({
  isLoading,
  onClick,
}: {
  isLoading: boolean;
  onClick: () => void;
}) {
  return (
    <TimelineActionRowHeader
      disabled={isLoading}
      onClick={onClick}
      summaryClassName={PAST_ROW_DIM_CLASS_NAME}
    >
      {isLoading ? "Loading earlier activity..." : "Load earlier activity"}
    </TimelineActionRowHeader>
  );
}

function LazyTurnRowBody({
  scopeActive,
  compactActivityIntents,
  row,
  showAssistantMessageActions,
}: TurnRowBodyProps) {
  const { getViewRows, threadId } = useTimelineRendererStaticContext();

  const detail = useTimelineDetailRows(
    timelineDetailIdentity(row, threadId, null),
    true,
  );

  const rows = detail.rows
    ? getViewRows(detail.rows, { closedScope: !scopeActive })
    : null;

  return (
    <div className="flex flex-col gap-2">
      {rows ? (
        <>
          {detail.hasEarlierRows ? (
            <LoadEarlierTimelineDetailRow
              isLoading={detail.isLoadingEarlierRows}
              onClick={detail.loadEarlier}
            />
          ) : null}
          <TimelineRowsList
            rows={rows}
            scopeActive={scopeActive}
            showAssistantMessageActions={showAssistantMessageActions}
            compactActivityIntents={compactActivityIntents}
            spacing="nested"
            unreadDividerAutoScroll={false}
            unreadDividerPlacement={null}
          />
        </>
      ) : detail.isError ? (
        <TimelineDetailLoadError
          horizontalPadding="default"
          label="Failed to load turn details."
          onRetry={detail.retry}
        />
      ) : (
        <TimelineStaticRowHeader>
          <span className={PAST_ROW_DIM_CLASS_NAME}>
            Loading turn details...
          </span>
        </TimelineStaticRowHeader>
      )}
    </div>
  );
}

function findDelegationViewRow(
  rows: readonly ThreadTimelineViewRow[],
  callId: string,
): TimelineViewDelegationWorkRow | null {
  for (const row of rows) {
    if (
      row.kind === "work" &&
      row.workKind === "delegation" &&
      row.callId === callId
    ) {
      return row;
    }
  }

  return null;
}

function DeferredDelegationChildRows({
  fallbackRows,
  row,
}: {
  fallbackRows: readonly ThreadTimelineViewRow[] | null;
  row: TimelineViewDelegationWorkRow;
}) {
  const { getViewRows, threadId } = useTimelineRendererStaticContext();

  const detail = useTimelineDetailRows(
    timelineDetailIdentity(row, threadId, row.callId),
    true,
  );

  const loadedRows = detail.rows
    ? (findDelegationViewRow(
        getViewRows(detail.rows, { closedScope: true }),
        row.callId,
      )?.childRows ?? [])
    : null;

  const rows = loadedRows ?? fallbackRows;

  if (rows === null && detail.isError) {
    return (
      <TimelineDetailLoadError
        horizontalPadding="default"
        label="Failed to load subagent activity."
        onRetry={detail.retry}
      />
    );
  }

  if (rows === null) {
    return (
      <TimelineStaticRowHeader>
        <span className={PAST_ROW_DIM_CLASS_NAME}>
          Loading subagent activity...
        </span>
      </TimelineStaticRowHeader>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {loadedRows !== null && detail.hasEarlierRows ? (
        <LoadEarlierTimelineDetailRow
          isLoading={detail.isLoadingEarlierRows}
          onClick={detail.loadEarlier}
        />
      ) : null}
      {rows.length > 0 ? (
        <TimelineRowsList
          rows={rows}
          scopeActive={false}
          showAssistantMessageActions={false}
          compactActivityIntents={false}
          spacing="nested"
          unreadDividerAutoScroll={false}
          unreadDividerPlacement={null}
        />
      ) : null}
    </div>
  );
}

function DelegationRowBody({ row }: { row: TimelineViewDelegationWorkRow }) {
  const {
    onOpenLink,
    onOpenLocalFileLink,
    projectId,
    resolveUserAttachmentImageSrc,
    workspaceRootPath,
  } = useTimelineRendererStaticContext();

  const delegationActive = row.status === "pending";
  const [lastInlineChildRows, setLastInlineChildRows] = useState(row.childRows);

  if (row.childRows !== null && row.childRows !== lastInlineChildRows) {
    setLastInlineChildRows(row.childRows);
  }

  return (
    <TimelineDetailScroll
      size="delegation"
      streaming={delegationActive}
      contentKey={`${row.childRows === null ? "deferred" : timelineRowsSignature(row.childRows)}|${row.output.length}`}
    >
      <div className="flex flex-col gap-3">
        {row.childRows === null ? (
          <DeferredDelegationChildRows
            fallbackRows={lastInlineChildRows}
            row={row}
          />
        ) : row.childRows.length > 0 ? (
          <TimelineRowsList
            rows={row.childRows}
            scopeActive={delegationActive}
            showAssistantMessageActions={false}
            compactActivityIntents={false}
            spacing="nested"
            unreadDividerAutoScroll={false}
            unreadDividerPlacement={null}
          />
        ) : null}
        {row.output.trim().length > 0 ? (
          <ConversationMessageContent
            attachments={null}
            id={row.id}
            onOpenLink={onOpenLink}
            onOpenLocalFileLink={onOpenLocalFileLink}
            projectId={projectId}
            resolveUserAttachmentImageSrc={resolveUserAttachmentImageSrc}
            role="assistant"
            showActions={false}
            streaming={delegationActive}
            text={row.output}
            timestamp={row.startedAt}
            threadId={row.threadId}
            turnId={row.turnId}
            turnGit={null}
            workspaceRootPath={workspaceRootPath}
          />
        ) : null}
      </div>
    </TimelineDetailScroll>
  );
}

function leadingIconForWorkRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind !== "work") {
    return undefined;
  }

  return workRowGlyph(row, (glyph): glyph is string => glyph.length > 0);
}

function systemOperationLeadingIcon(
  operationKind: TimelineSystemOperationKind,
  parentChangeAction: TimelineParentChange["action"] | null,
): IconName | undefined {
  switch (operationKind) {
    case "reasoning":
      return "AiBrain01";
    case "parent-change":
      return parentChangeAction === "release" ? "UserRound" : "ChildThread";
    case "thread-provisioning":
      return "Terminal";
    case "thread-interrupted":
      return "AlertCircle";
    case "compaction":
      return "CircleArrowShrink";
    case "context-clear":
      return "Clean";
    case "generic":
    case "warning":
    case "deprecation":
    case "provider-unhandled":
      return undefined;
    default:
      return assertNever(operationKind);
  }
}

function leadingIconForSystemRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind === "system" && row.systemKind === "error") {
    return "AlertCircle";
  }

  if (row.kind !== "system" || row.systemKind !== "operation") {
    return undefined;
  }

  return systemOperationLeadingIcon(
    row.operationKind,
    row.operationKind === "parent-change" ? row.parentChange.action : null,
  );
}

function leadingIconForRow(row: ThreadTimelineViewRow): IconName | undefined {
  return leadingIconForWorkRow(row) ?? leadingIconForSystemRow(row);
}

function ledgerLeadingIconForRow(
  row: ThreadTimelineViewRow,
): IconName | undefined {
  if (row.kind === "bundle-summary" || row.kind === "step-summary") {
    return "Layers";
  }

  return leadingIconForRow(row);
}

function isAwaitingApproval(row: ThreadTimelineViewRow): boolean {
  return (
    "approvalStatus" in row && row.approvalStatus === "waiting_for_approval"
  );
}

function timelineRowGlyphState(
  row: ThreadTimelineViewRow,
): TimelineRowGlyphState {
  switch (row.kind) {
    case "conversation":
    case "turn":
      return "idle";
    case "bundle-summary":
    case "step-summary":
      if (row.status === "pending") return "running";

      return timelineWorkSummaryNote(row.children)?.tone === "negative"
        ? "failed"
        : "idle";
    case "system":
    case "work":
      if (row.status === "pending") {
        return isAwaitingApproval(row) ? "idle" : "running";
      }

      return row.status === "error" || isFailedTimelineWork(row)
        ? "failed"
        : "idle";
    default:
      return assertNever(row);
  }
}

function holdsFailedExpansion(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "work" &&
    (row.workKind === "command" || row.workKind === "tool") &&
    isFailedTimelineWork(row)
  );
}

function isTimelineRailRow(row: ThreadTimelineViewRow): boolean {
  if (!isTimelineLedgerRow(row)) return false;

  return !(
    row.kind === "work" &&
    row.workKind === "command" &&
    parseSentThreadMessage(row) !== null
  );
}

function rendersCompactActivityIntents({
  compactActivityIntents,
  row,
  scopeActive,
}: {
  compactActivityIntents: boolean;
  row: ThreadTimelineViewRow;
  scopeActive: boolean;
}): boolean {
  return (
    compactActivityIntents &&
    !scopeActive &&
    shouldRenderCompactActivityIntentRows(row) &&
    hasTimelineExplorationIntent(row)
  );
}

function leadingIconStyleForRow(
  row: ThreadTimelineViewRow,
): CSSProperties | undefined {
  if (row.kind !== "work") {
    return undefined;
  }

  return presentationTintStyle(workRowPresentation(row));
}

function useLeadingIconUrlForRow(
  row: ThreadTimelineViewRow,
): string | undefined {
  return usePluginIconUrl(
    row.kind === "work" ? workRowPluginGlyph(row) : undefined,
  );
}

type GeneratedMessageProps = ComponentProps<
  typeof GeneratedConversationMessage
>;

const NO_ATTACHMENTS: GeneratedMessageProps["attachmentItems"] = {
  filePaths: [],
  fileDetails: [],
  imageItems: [],
};

const NO_MENTIONS: GeneratedMessageProps["mentions"] = [];

const ACCEPTED_MESSAGE: GeneratedMessageProps["turnRequest"] = {
  clientRequestId: null,
  isGrouped: false,
  kind: "message",
  status: "accepted",
};

function SentThreadMessageRow({
  message,
  sentAt,
}: {
  message: ThreadTellCommand;
  sentAt: number;
}) {
  const context = useTimelineRendererStaticContext();
  const recipient = useSenderThreadMetadata(message.threadId);

  return (
    <GeneratedConversationMessage
      attachmentItems={NO_ATTACHMENTS}
      automationLink={null}
      mentions={NO_MENTIONS}
      onOpenLink={context.onOpenLink}
      onOpenLocalFileLink={context.onOpenLocalFileLink}
      onTitleAction={context.onTitleAction}
      projectId={context.projectId}
      resolveMentionLink={context.resolveMentionLink}
      sourceIsPluginSideChat={false}
      sourceKind="agent-recipient"
      sourceName={recipient?.title ?? "Agent"}
      sourceProjectId={recipient?.projectId ?? null}
      sourceThreadId={message.threadId}
      systemMessageKind="unlabeled"
      systemMessageSubject={null}
      text={message.message}
      threadId={context.threadId}
      timestamp={sentAt}
      turnRequest={ACCEPTED_MESSAGE}
      workspaceRootPath={context.workspaceRootPath}
    />
  );
}

function MaintenanceRunRow({
  horizontalPadding,
  row,
}: {
  horizontalPadding: TimelineRowHorizontalPadding;
  row: Extract<TimelineConversationViewRow, { role: "user" }>;
}) {
  const outcome =
    useContext(MaintenanceRunOutcomesContext).get(row.id) ??
    maintenanceRunOutcomeFallback(row);

  const text = maintenanceRunTitleText(outcome);

  const title = useMemo<TimelineTitle>(
    () => ({
      segments: [
        {
          text,
          em: false,
          shimmer: outcome.state === "running",
          truncate: false,
        },
      ],
      decorations: [],
      tone: "default",
      action: null,
      plain: text,
    }),
    [outcome.state, text],
  );

  return (
    <TimelineStaticRowHeader
      horizontalPadding={horizontalPadding}
      className={outcome.state === "done" ? PAST_ROW_DIM_CLASS_NAME : undefined}
    >
      <span
        className="inline-flex min-w-0 max-w-full items-center gap-1.5"
        data-maintenance-run-state={outcome.state}
      >
        <TimelineLeadingIcon
          icon="CircleArrowShrink"
          iconUrl={undefined}
          style={undefined}
        />
        <ExpandableTimelineTitle title={title} />
      </span>
    </TimelineStaticRowHeader>
  );
}

function TimelineRowView({
  activeLatestBundleId,
  compactActivityIntents,
  row,
  scopeActive,
  showAssistantMessageActions,
  spacing,
}: TimelineRowViewProps) {
  const horizontalPadding = timelineRowHorizontalPadding(spacing);
  const { onOpenLink, onTitleAction } = useTimelineRendererStaticContext();

  const titleState = useTimelineRowTitleRenderState({
    activeLatestBundleId,
    compactActivityIntents,
    row,
    scopeActive,
  });

  const pluginRendererSlot = usePluginTimelineRenderer(
    row.kind === "work" ? row : null,
  );

  const staticLeadingIconUrl = useLeadingIconUrlForRow(row);

  if (row.kind === "conversation") {
    if (row.role === "user" && row.maintenance === "auto-compaction") {
      return (
        <MaintenanceRunRow row={row} horizontalPadding={horizontalPadding} />
      );
    }

    return (
      <ConversationRow
        row={row}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    );
  }

  const sentThreadMessage =
    row.kind === "work" && row.workKind === "command"
      ? parseSentThreadMessage(row)
      : null;

  if (sentThreadMessage !== null) {
    return (
      <SentThreadMessageRow
        message={sentThreadMessage}
        sentAt={row.startedAt}
      />
    );
  }

  if (titleState.kind === "compact-activity-intents") {
    const glyphState = timelineRowGlyphState(row);
    const lastIndex = titleState.titles.length - 1;

    return (
      <>
        {titleState.titles.map((entry, index) => (
          <TimelineLedgerStaticRow
            key={entry.id}
            horizontalPadding={horizontalPadding}
            glyph={
              <TimelineRowGlyph
                icon={activityIntentTitleGlyph(entry)}
                iconUrl={undefined}
                style={undefined}
                state={
                  glyphState === "running" && index !== lastIndex
                    ? "idle"
                    : glyphState
                }
              />
            }
            figure={
              index === lastIndex ? (
                <TimelineRowFigure timing={timelineRowFigureTiming(row)} />
              ) : undefined
            }
          >
            <TimelineTitleView
              title={entry.title}
              onTitleAction={onTitleAction}
              ledger="row"
            />
          </TimelineLedgerStaticRow>
        ))}
      </>
    );
  }

  if (isTimelineActivityRow(row) && isChildActivityRow(row)) {
    return (
      <ChildActivityRow
        horizontalPadding={horizontalPadding}
        onTitleAction={onTitleAction}
        row={row}
        title={titleState.title}
      />
    );
  }

  if (isTimelineActivityRow(row) && isPreviewActivityRow(row)) {
    return (
      <PreviewActivityRow
        horizontalPadding={horizontalPadding}
        onOpenLink={onOpenLink}
        onTitleAction={onTitleAction}
        row={row}
        title={titleState.title}
      />
    );
  }

  if (
    !isRowExpandable(row) &&
    pluginRendererSlot === null &&
    isTimelineLedgerRow(row)
  ) {
    return (
      <TimelineLedgerStaticRow
        horizontalPadding={horizontalPadding}
        glyph={
          <TimelineRowGlyph
            icon={ledgerLeadingIconForRow(row)}
            fallback="ListTodo"
            iconUrl={staticLeadingIconUrl}
            style={leadingIconStyleForRow(row)}
            state={timelineRowGlyphState(row)}
          />
        }
        figure={<TimelineRowFigure timing={timelineRowFigureTiming(row)} />}
      >
        <TimelineTitleView
          title={titleState.title}
          onTitleAction={onTitleAction}
          ledger="row"
          monoEmphasis={row.kind === "work" && row.workKind === "command"}
        />
      </TimelineLedgerStaticRow>
    );
  }

  if (!isRowExpandable(row) && pluginRendererSlot === null) {
    const staticLeadingIcon = leadingIconForRow(row);
    const staticLeadingIconStyle = leadingIconStyleForRow(row);

    const TitleView =
      row.kind === "system" ? ExpandableTimelineTitle : TimelineTitleView;

    return (
      <TimelineStaticRowHeader
        horizontalPadding={horizontalPadding}
        className={pastRowDimClassName({
          activeLatestBundleId,
          row,
          scopeActive,
        })}
      >
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
          <TimelineLeadingIcon
            icon={staticLeadingIcon}
            iconUrl={staticLeadingIconUrl}
            style={staticLeadingIconStyle}
            tone={
              row.kind === "system" && row.systemKind === "error"
                ? "danger"
                : undefined
            }
          />
          <TitleView title={titleState.title} onTitleAction={onTitleAction} />
        </span>
      </TimelineStaticRowHeader>
    );
  }

  return (
    <MemoizedTimelineExpandableRowView
      activeLatestBundleId={activeLatestBundleId}
      row={row}
      scopeActive={scopeActive}
      showAssistantMessageActions={showAssistantMessageActions}
      title={titleState.title}
      horizontalPadding={horizontalPadding}
      compactActivityIntents={compactActivityIntents}
    />
  );
}

const MemoizedTimelineRowView = memo(
  TimelineRowView,
  areTimelineRowViewPropsEqual,
);

function TimelineExpandableRowView({
  activeLatestBundleId,
  compactActivityIntents,
  scopeActive,
  showAssistantMessageActions,
  title,
  horizontalPadding,
  row,
}: TimelineExpandableRowViewProps) {
  const { onTitleAction, threadId } = useTimelineRendererStaticContext();
  const preloadBody = usePreloadTimelineRowBody(row, threadId);

  const { initialAutoExpandedRowIds, liveAutoExpandedRowIds } =
    useTimelineTurnStateContext();

  const searchExpandedRowIds = useContext(TimelineSearchExpansionContext);

  const renderBody = useCallback(
    () => (
      <TimelineExpandableBody
        activeLatestBundleId={activeLatestBundleId}
        scopeActive={scopeActive && row.status === "pending"}
        row={row}
        compactActivityIntents={compactActivityIntents}
        showAssistantMessageActions={showAssistantMessageActions}
      />
    ),
    [
      activeLatestBundleId,
      compactActivityIntents,
      row,
      scopeActive,
      showAssistantMessageActions,
    ],
  );

  const leadingIcon = leadingIconForRow(row);
  const leadingIconUrl = useLeadingIconUrlForRow(row);
  const leadingIconStyle = leadingIconStyleForRow(row);

  const foldedTurn = isFoldedTurnRow(row) ? row : null;
  const ledgerRow = isTimelineLedgerRow(row);

  const isSummary =
    row.kind === "step-summary" || row.kind === "bundle-summary";

  const result = useMemo(() => timelineWorkResult(row), [row]);

  const summaryNote = useMemo(
    () =>
      (row.kind === "step-summary" || row.kind === "bundle-summary") &&
      row.status !== "pending"
        ? timelineWorkSummaryNote(row.children)
        : null,
    [row],
  );

  const displayTitle = useMemo(
    () =>
      result === null
        ? title
        : {
            ...title,
            decorations: title.decorations.filter(
              (decoration) => decoration.kind !== "status",
            ),
          },
    [result, title],
  );

  const visibleResult =
    result !== null &&
    workResultRepeatsTitle(result, timelineTitleLeadWords(title))
      ? null
      : result;

  const workflowProgress =
    row.kind === "work" && row.workKind === "workflow" ? row.workflow : null;

  const resultContent =
    visibleResult !== null ? (
      <TimelineWorkResult result={visibleResult} />
    ) : summaryNote !== null ? (
      <span
        data-timeline-work-summary-note={summaryNote.tone}
        className={cn(
          "shrink-0 whitespace-nowrap text-xs",
          summaryNote.tone === "negative"
            ? "text-destructive-text"
            : "text-timeline-meta",
        )}
      >
        {summaryNote.text}
      </span>
    ) : workflowProgress !== null &&
      workflowProgress.phases.length > 1 &&
      row.kind === "work" ? (
      <WorkflowPhaseStrip
        progress={workflowProgress}
        settled={row.status !== "pending"}
        className="w-16 shrink-0 self-center"
      />
    ) : undefined;

  return (
    <ExpandableTimelineRow
      expansionKey={
        foldedTurn !== null
          ? foldedTurn.id
          : row.kind === "system" &&
              row.systemKind === "operation" &&
              row.operationKind === "reasoning"
            ? (row.reasoningId ?? row.id)
            : row.id
      }
      title={displayTitle}
      chevronAlwaysVisible={foldedTurn !== null}
      result={resultContent}
      titleContent={
        foldedTurn !== null ? (
          <TimelineTurnActivityLine row={foldedTurn} />
        ) : ledgerRow ? (
          <TimelineTitleView
            title={displayTitle}
            onTitleAction={onTitleAction}
            ledger={isSummary ? "sentence" : "row"}
            monoEmphasis={row.kind === "work" && row.workKind === "command"}
          />
        ) : undefined
      }
      ledger={
        ledgerRow
          ? {
              glyph: (
                <TimelineRowGlyph
                  icon={ledgerLeadingIconForRow(row)}
                  fallback={
                    row.kind === "work"
                      ? workRowGlyph(row, (glyph): glyph is never => false)
                      : "ListTodo"
                  }
                  iconUrl={leadingIconUrl}
                  style={leadingIconStyle}
                  state={timelineRowGlyphState(row)}
                />
              ),
              figure: (
                <TimelineRowFigure timing={timelineRowFigureTiming(row)} />
              ),
            }
          : undefined
      }
      contentClassName={foldedTurn !== null ? "px-0" : undefined}
      summaryClassName={
        foldedTurn !== null || ledgerRow
          ? undefined
          : pastRowDimClassName({
              activeLatestBundleId,
              row,
              scopeActive,
            })
      }
      horizontalPadding={horizontalPadding}
      leadingIcon={leadingIcon}
      leadingIconFallback={
        row.kind === "work"
          ? workRowGlyph(row, (glyph): glyph is never => false)
          : undefined
      }
      leadingIconUrl={leadingIconUrl}
      leadingIconStyle={leadingIconStyle}
      leadingIconTone={
        row.kind === "system" && row.systemKind === "error"
          ? "danger"
          : undefined
      }
      autoExpanded={
        liveAutoExpandedRowIds.has(row.id) ||
        initialAutoExpandedRowIds.has(row.id) ||
        holdsFailedExpansion(row)
      }
      forceExpanded={searchExpandedRowIds.has(row.id)}
      onTitleAction={onTitleAction}
      onIntent={preloadBody}
      renderBody={renderBody}
    />
  );
}

const MemoizedTimelineExpandableRowView = memo(
  TimelineExpandableRowView,
  areTimelineExpandableRowViewPropsEqual,
);

function findUnreadDividerIndex({
  rows,
  unreadDividerPlacement,
}: FindUnreadDividerIndexArgs): number {
  if (unreadDividerPlacement === null) {
    return -1;
  }

  switch (unreadDividerPlacement.kind) {
    case "before-first":
      return rows.length > 0 ? 0 : -1;
    case "after-cutoff":
      return rows.findIndex((row) =>
        isUnreadDividerCandidateAfterCutoff({
          cutoffAt: unreadDividerPlacement.cutoffAt,
          row,
        }),
      );
    default:
      assertNever(unreadDividerPlacement);
  }
}

function isUserAuthoredConversationRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    isHumanThreadInput(row)
  );
}

function isUnreadDividerCandidateAfterCutoff({
  cutoffAt,
  row,
}: IsUnreadDividerCandidateAfterCutoffArgs): boolean {
  if (row.startedAt <= cutoffAt) {
    return false;
  }

  return !isUserAuthoredConversationRow(row);
}

function unreadDividerPlacementKey(
  placement: ThreadTimelineUnreadDividerPlacement | null,
): string {
  if (placement === null) {
    return "none";
  }

  switch (placement.kind) {
    case "before-first":
      return "before-first";
    case "after-cutoff":
      return `after-cutoff:${placement.cutoffAt}`;
    default:
      return assertNever(placement);
  }
}

function buildTimelineRowsListItems({
  quietAnswerIds,
  rows,
  unreadDividerPlacement,
}: BuildTimelineRowsListItemsArgs): TimelineRowsListItem[] {
  const items: TimelineRowsListItem[] = [];

  const dividerIndex = findUnreadDividerIndex({
    rows,
    unreadDividerPlacement,
  });

  for (const [index, row] of rows.entries()) {
    const rhythm =
      quietAnswerIds === null
        ? null
        : timelineRowRhythm({
            previous: rows[index - 1],
            quietAnswerIds,
            row,
          });

    let rowRhythm = rhythm;

    if (index === dividerIndex) {
      items.push({
        kind: "unread-divider",
        id: "thread-unread-divider",
        placementKey: unreadDividerPlacementKey(unreadDividerPlacement),
        rhythm,
      });
      rowRhythm = rhythm === null ? null : "within";
    }

    if (!isUpdatePauseRow(row)) {
      items.push({ kind: "row", row, rhythm: rowRhythm });
      continue;
    }

    if (items[items.length - 1]?.kind === "update-pause") continue;

    items.push({
      kind: "update-pause",
      id: row.id,
      resumedAt: findUpdatePauseResumedAt(rows, index),
      rhythm: rowRhythm,
    });
  }

  return items;
}

const SENT_USER_ROW_ENTRANCE_CLASS_NAME =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-duration-base) ease-out";

function rowArrivalKey(row: ThreadTimelineViewRow): string {
  return row.kind === "conversation" &&
    row.role === "user" &&
    row.turnRequest.clientRequestId !== null
    ? `request:${row.turnRequest.clientRequestId}`
    : row.id;
}

const LIVE_ROW_ENTRANCE_CLASS_NAME =
  "animate-in fade-in-0 slide-in-from-bottom-1 duration-(--motion-duration-base) ease-out [animation-fill-mode:backwards]";

const LIVE_ROW_ENTRANCE_STAGGER_MS = 45;

const LIVE_ROW_ENTRANCE_MAX_STAGGER_STEPS = 5;

interface RowArrival {
  kind: "sent" | "live";
  order: number;
}

const NO_ROW_ARRIVALS: ReadonlyMap<string, RowArrival> = new Map();

function latestSourceSeq(rows: readonly ThreadTimelineViewRow[]): number {
  return rows.reduce(
    (latest, row) => Math.max(latest, row.sourceSeqEnd),
    Number.NEGATIVE_INFINITY,
  );
}

function useArrivedRowIds(
  rows: readonly ThreadTimelineViewRow[],
  enabled: boolean,
  animateLiveRows: boolean,
): ReadonlyMap<string, RowArrival> {
  const [tracker, setTracker] = useState(() => ({
    known: new Set(rows.map(rowArrivalKey)),
    latestSeq: latestSourceSeq(rows),
    arrived: NO_ROW_ARRIVALS,
  }));

  if (enabled && rows.length > 0) {
    const unseen = rows.filter((row) => !tracker.known.has(rowArrivalKey(row)));

    if (unseen.length > 0) {
      let lastKnownIndex = -1;

      rows.forEach((row, index) => {
        if (tracker.known.has(rowArrivalKey(row))) lastKnownIndex = index;
      });

      const arrivals =
        tracker.known.size === 0
          ? []
          : unseen.flatMap((row): [string, RowArrival["kind"]][] => {
              if (rows.indexOf(row) <= lastKnownIndex) return [];

              if (isUserAuthoredConversationRow(row)) return [[row.id, "sent"]];

              return animateLiveRows && row.sourceSeqStart > tracker.latestSeq
                ? [[row.id, "live"]]
                : [];
            });

      const arrived: ReadonlyMap<string, RowArrival> =
        arrivals.length === 0
          ? tracker.arrived
          : new Map([
              ...tracker.arrived,
              ...arrivals.map(([id, kind], order): [string, RowArrival] => [
                id,
                { kind, order },
              ]),
            ]);

      setTracker({
        known: new Set([...tracker.known, ...unseen.map(rowArrivalKey)]),
        latestSeq: Math.max(tracker.latestSeq, latestSourceSeq(rows)),
        arrived,
      });
    }
  }

  return enabled ? tracker.arrived : NO_ROW_ARRIVALS;
}

function TimelineRowItemWrapper({
  children,
  entering,
  isFirst,
  rail,
  rhythm,
  row,
  spacing,
}: {
  children: ReactNode;
  entering: RowArrival | undefined;
  isFirst: boolean;
  rail: TimelineRowRail;
  rhythm: TimelineRowRhythm | null;
  row: ThreadTimelineViewRow;
  spacing: TimelineRowsListSpacing;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const isTopLevel = spacing === "top-level";
  const stepSpacingSteps = stepRailSpacingSteps(rail.step);
  useArmTopLevelTimelineRowContainment(wrapperRef, isTopLevel);

  return (
    <div
      ref={wrapperRef}
      data-timeline-row-id={row.id}
      data-timeline-row-kind={row.kind === "conversation" ? row.role : row.kind}
      data-timeline-rail={rail.position ?? undefined}
      data-timeline-step={rail.step?.role}
      className={cn(
        isTopLevel && TOP_LEVEL_TIMELINE_ROW_INTRINSIC_SIZE_CLASS_NAME,
        spacing === "nested" &&
          !isFirst &&
          !rail.joinsPrevious &&
          stepSpacingSteps === undefined &&
          "mt-2",
        rail.className,
        entering?.kind === "sent" && SENT_USER_ROW_ENTRANCE_CLASS_NAME,
        entering?.kind === "live" && LIVE_ROW_ENTRANCE_CLASS_NAME,
      )}
      style={{
        ...(isTopLevel ? timelineRowContainmentStyle(row) : undefined),
        ...(stepSpacingSteps !== undefined
          ? stepSpacingSteps === 0
            ? undefined
            : { marginTop: `calc(var(--spacing) * ${stepSpacingSteps})` }
          : isTopLevel
            ? timelineRowRhythmStyle(rail.joinsPrevious ? null : rhythm)
            : undefined),
        ...(entering?.kind === "live" && entering.order > 0
          ? {
              animationDelay: `${
                Math.min(entering.order, LIVE_ROW_ENTRANCE_MAX_STAGGER_STEPS) *
                LIVE_ROW_ENTRANCE_STAGGER_MS
              }ms`,
            }
          : undefined),
      }}
    >
      <TimelineStepRailContext.Provider value={rail.step}>
        {children}
      </TimelineStepRailContext.Provider>
    </div>
  );
}

function stepRailSpacingSteps(
  step: TimelineStepRail | null,
): number | undefined {
  if (step === null) return undefined;

  if (step.role === "work") return 0;

  return step.startsRun ? undefined : STEP_HEAD_SPACING_STEPS;
}

function timelineStepLink(
  row: ThreadTimelineViewRow,
  continuesTurn: boolean,
): TimelineStepLink {
  if (row.kind === "conversation") {
    return row.role === "assistant"
      ? { kind: "head", continuesTurn }
      : { kind: "other" };
  }

  if (!isTimelineRailRow(row)) return { kind: "other" };

  return { kind: "work", continuesTurn, state: timelineRowGlyphState(row) };
}

function TimelineRowsList({
  compactActivityIntents,
  hasPagedHistory,
  hasOlderTimelineRows,
  isLoadingOlderTimelineRows,
  onLoadOlderRows,
  rows,
  scopeActive,
  showAssistantMessageActions,
  spacing,
  className,
  unreadDividerAutoScroll,
  unreadDividerPlacement,
}: TimelineRowsListProps) {
  const { threadId } = useTimelineRendererStaticContext();
  const searchExpandedRowIds = useTimelineSearchExpansionRowIds(rows);
  const stableSearchExpandedRowIds = useStableReadonlySet(searchExpandedRowIds);

  const isInitialRevealPending = useScrollToSearchedMessage(rows, threadId, {
    hasOlderRows: hasOlderTimelineRows,
    isLoadingOlderRows: isLoadingOlderTimelineRows,
    onLoadOlderRows,
    reportsMissingTarget: spacing === "top-level",
  });

  const activeLatestBundleId = useMemo(
    () => findActiveLatestBundleId(rows),
    [rows],
  );

  const isTopLevelList = spacing === "top-level";

  const displayRows = useMemo(
    () => (isTopLevelList ? foldWarningsIntoFinishedTurns(rows) : rows),
    [isTopLevelList, rows],
  );

  const receiptedAnswerIds = useMemo(
    () =>
      isTopLevelList ? findReceiptedAnswerIds(displayRows) : EMPTY_ROW_ID_SET,
    [isTopLevelList, displayRows],
  );

  const stableReceiptedAnswerIds = useStableReadonlySet(receiptedAnswerIds);

  const arrivedRows = useArrivedRowIds(
    displayRows,
    isTopLevelList || scopeActive,
    scopeActive,
  );

  const items = useMemo(
    () =>
      buildTimelineRowsListItems({
        quietAnswerIds: isTopLevelList
          ? showAssistantMessageActions
            ? stableReceiptedAnswerIds
            : EMPTY_ROW_ID_SET
          : null,
        rows: displayRows,
        unreadDividerPlacement,
      }),
    [
      displayRows,
      isTopLevelList,
      showAssistantMessageActions,
      stableReceiptedAnswerIds,
      unreadDividerPlacement,
    ],
  );

  const rails = useMemo((): TimelineRowRail[] => {
    const continuesTurn = (rhythm: TimelineRowRhythm | null): boolean =>
      rhythm === null || rhythm === "within";

    const steps =
      spacing === "bundle"
        ? items.map(() => null)
        : timelineStepRails(
            items.map((item) =>
              item.kind === "row"
                ? timelineStepLink(item.row, continuesTurn(item.rhythm))
                : { kind: "other" },
            ),
          );

    const positions = timelineRailPositions(
      items.map((item, index) =>
        item.kind === "row"
          ? {
              eligible: steps[index] === null && isTimelineRailRow(item.row),
              continuesTurn: continuesTurn(item.rhythm),
            }
          : { eligible: false, continuesTurn: false },
      ),
    );

    return items.map((item, index) => {
      const step = steps[index] ?? null;

      if (step !== null) {
        return {
          position: null,
          joinsPrevious: false,
          className: timelineStepRailClassName(step),
          step,
        };
      }

      const position = positions[index] ?? null;

      if (position === null || item.kind !== "row") return NO_RAIL;

      return {
        position,
        joinsPrevious: position === "middle" || position === "last",
        className: timelineRailClassName({
          position,
          inset: spacing === "bundle" ? "flush" : "inset",
          end: rendersCompactActivityIntents({
            compactActivityIntents,
            row: item.row,
            scopeActive,
          })
            ? "last-line"
            : "first-line",
        }),
        step: null,
      };
    });
  }, [compactActivityIntents, items, scopeActive, spacing]);

  const listRef = useRef<HTMLDivElement>(null);

  const windowEnabled =
    hasPagedHistory === true && isTopLevelList && items.length >= 96;

  const observedHeights = useHistoryRowWindow(listRef, windowEnabled);

  const firstObservedIndex = observedHeights
    ? items.findIndex(
        (item) => item.kind === "row" && observedHeights.has(item.row.id),
      )
    : -1;

  const listItems = items.map((item, index) => {
    const height =
      observedHeights &&
      item.kind === "row" &&
      !stableSearchExpandedRowIds.has(item.row.id)
        ? historyRowSpacerHeight(
            item.row,
            index,
            firstObservedIndex,
            observedHeights,
          )
        : null;

    return item.kind === "unread-divider" ? (
      <div key={item.id} style={timelineRowRhythmStyle(item.rhythm)}>
        <TimelineUnreadDivider
          autoScroll={unreadDividerAutoScroll}
          placementKey={item.placementKey}
        />
      </div>
    ) : item.kind === "update-pause" ? (
      <div key={item.id} style={timelineRowRhythmStyle(item.rhythm)}>
        <TimelineUpdatePauseDivider resumedAt={item.resumedAt} />
      </div>
    ) : (
      <TimelineRowItemWrapper
        key={item.row.id}
        entering={arrivedRows.get(item.row.id)}
        isFirst={index === 0}
        rail={rails[index] ?? NO_RAIL}
        rhythm={item.rhythm}
        row={item.row}
        spacing={spacing}
      >
        {height !== null ? (
          <div aria-hidden="true" data-history-spacer="" style={{ height }} />
        ) : (
          <MemoizedTimelineRowView
            activeLatestBundleId={activeLatestBundleId}
            row={item.row}
            scopeActive={scopeActive}
            showAssistantMessageActions={showAssistantMessageActions}
            spacing={spacing}
            compactActivityIntents={compactActivityIntents}
          />
        )}
      </TimelineRowItemWrapper>
    );
  });

  const { measureRef: messageColumnWidthSourceRef, width: messageColumnWidth } =
    useMeasuredWidth({ enabled: isTopLevelList });

  const attachList = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node;
      messageColumnWidthSourceRef(node);
    },
    [messageColumnWidthSourceRef],
  );

  const messageColumnWidthValue = useMemo(
    () => ({ width: messageColumnWidth }),
    [messageColumnWidth],
  );

  return (
    <TimelineSearchExpansionContext.Provider value={stableSearchExpandedRowIds}>
      <MessageColumnWidthContext.Provider
        value={isTopLevelList ? messageColumnWidthValue : null}
      >
        <div
          ref={isTopLevelList ? attachList : undefined}
          className={cn(
            "flex min-w-0 flex-col [&_button:not(:disabled)]:cursor-pointer",
            timelineRowsListGapClassName(spacing),
            className,
          )}
          data-timeline-row-list={spacing}
          style={isInitialRevealPending ? { visibility: "hidden" } : undefined}
          aria-busy={isInitialRevealPending || undefined}
        >
          {isTopLevelList ? (
            <ReceiptedAnswerIdsContext.Provider
              value={stableReceiptedAnswerIds}
            >
              {listItems}
            </ReceiptedAnswerIdsContext.Provider>
          ) : (
            listItems
          )}
        </div>
      </MessageColumnWidthContext.Provider>
    </TimelineSearchExpansionContext.Provider>
  );
}

function ThreadTimelineRowsComponent(props: ThreadTimelineRowsProps) {
  const ownerKey = props.threadId ?? props.timelineRows[0]?.threadId ?? "";
  const hasRows = props.timelineRows.length > 0;

  useEffect(() => {
    if (hasRows) markStartupChatRendered();
  }, [hasRows]);

  return (
    <TimelineImageGallery key={ownerKey}>
      <ThreadTimelineRowsForTimelineView {...props} />
    </TimelineImageGallery>
  );
}

function ThreadTimelineRowsForTimelineView(props: ThreadTimelineRowsProps) {
  const getViewRows = useTimelineViewRowsCache();

  const rows = useMemo(
    () => getViewRows(props.timelineRows),
    [getViewRows, props.timelineRows],
  );

  const bottomAnchor = useBottomAnchoredScroll();
  const isInsideDetailScroll = useContext(InsideTimelineDetailScrollContext);
  const showStickyUserMessage = bottomAnchor !== null && !isInsideDetailScroll;

  const scopeActive =
    props.threadRuntimeDisplayStatus !== undefined &&
    isRunningThreadRuntimeDisplayStatus(props.threadRuntimeDisplayStatus);

  const maintenanceRunOutcomes = useMemo(
    () => collectMaintenanceRunOutcomes(props.timelineRows, scopeActive),
    [props.timelineRows, scopeActive],
  );

  const streamingAssistantMessageId = useMemo(
    () => (scopeActive ? findStreamingAssistantMessageId(rows) : null),
    [rows, scopeActive],
  );

  const computedAutoExpansionRowIds = useMemo(
    () => collectLiveTimelineExpansionRowIds({ rows, scopeActive }),
    [rows, scopeActive],
  );

  const liveAutoExpandedRowIds = useStableReadonlySet(
    computedAutoExpansionRowIds,
  );

  const initialAutoExpandedRowIds = useStableReadonlySet(
    props.initialExpanded ?? EMPTY_ROW_ID_SET,
  );

  const projectId = props.projectId;

  const messageDirectiveSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageDirectives,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageDirectives,
  );

  const codeFenceRendererSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().codeFenceRenderers,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.codeFenceRenderers,
  );

  const messageActionSlots = useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().messageActions,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions,
  );

  const messageDirectiveRegistry = useMemo(
    () => buildMessageDirectiveRegistry(messageDirectiveSlots),
    [messageDirectiveSlots],
  );

  const codeFenceRendererRegistry = useMemo(
    () => buildCodeFenceRendererRegistry(codeFenceRendererSlots),
    [codeFenceRendererSlots],
  );

  const onSelectionAddToChat = props.onSelectionAddToChat;
  const timelineThreadId = props.threadId;

  const hasPluginSelectionActions =
    timelineThreadId !== undefined &&
    props.includePluginMessageActions !== false &&
    !props.readOnly &&
    messageActionSlots.length > 0;

  const hasSelectionActions =
    onSelectionAddToChat !== undefined || hasPluginSelectionActions;

  const [activeSelection, setActiveSelection] = useState<{
    rowId: string;
    selection: MessageProseSelection;
    message: ThreadChatMessageReference;
  } | null>(null);

  const reportProseSelection = useMemo<
    | ((
        rowId: string,
        selection: MessageProseSelection | null,
        message: ThreadChatMessageReference,
      ) => void)
    | undefined
  >(
    () =>
      hasSelectionActions
        ? (rowId, selection, message) => {
            setActiveSelection((current) => {
              if (selection !== null) {
                return { rowId, selection, message };
              }

              return current?.rowId === rowId ? null : current;
            });
          }
        : undefined,
    [hasSelectionActions],
  );

  const dismissSelection = useCallback(() => {
    setActiveSelection(null);
  }, []);

  const handleSelectionAddToChat = useCallback<ThreadTimelineAddToChatHandler>(
    (...args) => {
      onSelectionAddToChat?.(...args);
      setActiveSelection(null);
    },
    [onSelectionAddToChat],
  );

  const selectionAddToChatHandler =
    onSelectionAddToChat === undefined ? undefined : handleSelectionAddToChat;

  const onOpenPluginPanel = props.onOpenPluginPanel;
  const composerHost = usePluginComposerHost();

  const selectionPluginActions = useMemo<
    readonly ThreadTimelinePluginMessageAction[]
  >(() => {
    if (activeSelection === null) {
      return [];
    }

    return (
      buildRowPluginMessageActions({
        slots:
          props.includePluginMessageActions === false || props.readOnly
            ? EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions
            : messageActionSlots,
        timelineThreadId,
        message: activeSelection.message,
        selectedText: activeSelection.selection.text,
        openThreadPanel: onOpenPluginPanel,
        composerHost,
      }) ?? []
    );
  }, [
    activeSelection,
    composerHost,
    messageActionSlots,
    props.includePluginMessageActions,
    props.readOnly,
    onOpenPluginPanel,
    timelineThreadId,
  ]);

  const completionMessageId = useMemo(
    () =>
      props.completion === undefined || scopeActive
        ? null
        : selectCompletionMessageId(props.timelineRows, props.completion),
    [props.completion, props.timelineRows, scopeActive],
  );

  const staticContextValue = useMemo<TimelineRendererStaticContextValue>(
    () => ({
      completion: props.completion,
      completionMessageId,
      canSpawnChild: !props.readOnly && (props.canSpawnChild ?? false),
      getViewRows,
      onForkMessage: props.readOnly ? undefined : props.onForkMessage,
      onEditMessage: props.readOnly ? undefined : props.onEditMessage,
      inlineMessageEditor: props.readOnly
        ? undefined
        : props.inlineMessageEditor,
      onMessageAddToChat: props.onMessageAddToChat,
      onSelectionAddToChat: selectionAddToChatHandler,
      pluginMessageActions:
        timelineThreadId === undefined ||
        props.readOnly ||
        props.includePluginMessageActions === false
          ? EMPTY_PLUGIN_SLOT_SNAPSHOT.messageActions
          : messageActionSlots,
      consumerMessageActions: props.readOnly
        ? EMPTY_CONSUMER_MESSAGE_ACTIONS
        : (props.consumerMessageActions ?? EMPTY_CONSUMER_MESSAGE_ACTIONS),
      reportProseSelection,
      onOpenLink: props.onOpenLink,
      onOpenLocalFileLink: props.onOpenLocalFileLink,
      onOpenPluginPanel: props.onOpenPluginPanel,
      onTitleAction: props.onTitleAction,
      projectId,
      resolveImageViewSrc: props.resolveImageViewSrc,
      resolveMentionLink: props.resolveMentionLink,
      resolveUserAttachmentImageSrc: props.resolveUserAttachmentImageSrc,
      threadId: props.threadId,
      workspaceRootPath: props.workspaceRootPath,
    }),
    [
      props.completion,
      completionMessageId,
      props.canSpawnChild,
      props.readOnly,
      getViewRows,
      props.onForkMessage,
      props.onEditMessage,
      props.inlineMessageEditor,
      props.onMessageAddToChat,
      selectionAddToChatHandler,
      messageActionSlots,
      props.includePluginMessageActions,
      props.consumerMessageActions,
      reportProseSelection,
      timelineThreadId,
      props.onOpenLink,
      props.onOpenLocalFileLink,
      props.onOpenPluginPanel,
      props.onTitleAction,
      projectId,
      props.resolveImageViewSrc,
      props.resolveMentionLink,
      props.resolveUserAttachmentImageSrc,
      props.threadId,
      props.workspaceRootPath,
    ],
  );

  const turnStateContextValue = useMemo<TimelineTurnStateContextValue>(
    () => ({
      initialAutoExpandedRowIds,
      liveAutoExpandedRowIds,
    }),
    [initialAutoExpandedRowIds, liveAutoExpandedRowIds],
  );

  return (
    <CodeFenceRendererRegistryProvider registry={codeFenceRendererRegistry}>
      <SearchMessageLocationProvider threadId={props.threadId}>
        <MessageDirectiveRegistryProvider registry={messageDirectiveRegistry}>
          <TimelineRendererStaticContext.Provider value={staticContextValue}>
            <ActiveAssistantTurnIdContext.Provider
              value={
                scopeActive ? (rows[rows.length - 1]?.turnId ?? null) : null
              }
            >
              <StreamingAssistantMessageIdContext.Provider
                value={streamingAssistantMessageId}
              >
                <TimelineTurnStateContext.Provider
                  value={turnStateContextValue}
                >
                  {showStickyUserMessage ? (
                    <StickyUserMessage rows={rows} />
                  ) : null}
                  <MarkdownTablesContainedContext.Provider value>
                    <MaintenanceRunOutcomesContext.Provider
                      value={maintenanceRunOutcomes}
                    >
                      <TimelineRowsList
                        hasPagedHistory={props.hasPagedHistory}
                        hasOlderTimelineRows={props.hasOlderTimelineRows}
                        isLoadingOlderTimelineRows={
                          props.isLoadingOlderTimelineRows
                        }
                        onLoadOlderRows={props.onLoadOlderRows}
                        rows={rows}
                        scopeActive={scopeActive}
                        showAssistantMessageActions={!props.readOnly}
                        compactActivityIntents={false}
                        spacing="top-level"
                        unreadDividerAutoScroll={
                          props.unreadDividerAutoScroll ?? false
                        }
                        unreadDividerPlacement={
                          props.unreadDividerPlacement ?? null
                        }
                      />
                    </MaintenanceRunOutcomesContext.Provider>
                  </MarkdownTablesContainedContext.Provider>
                  {hasSelectionActions ? (
                    <TimelineSelectionMenu
                      selection={activeSelection?.selection ?? null}
                      onAddToChat={selectionAddToChatHandler}
                      pluginActions={selectionPluginActions}
                      onDismiss={dismissSelection}
                    />
                  ) : null}
                </TimelineTurnStateContext.Provider>
              </StreamingAssistantMessageIdContext.Provider>
            </ActiveAssistantTurnIdContext.Provider>
          </TimelineRendererStaticContext.Provider>
        </MessageDirectiveRegistryProvider>
      </SearchMessageLocationProvider>
    </CodeFenceRendererRegistryProvider>
  );
}

export const ThreadTimelineRows = memo(ThreadTimelineRowsComponent);

ThreadTimelineRows.displayName = "ThreadTimelineRows";

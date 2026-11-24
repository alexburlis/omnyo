import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import { matchPath } from "react-router-dom";
import { RouteAnchor } from "@/components/ui/app-route-anchor";
import {
  PROJECTLESS_THREAD_DETAIL_ROUTE_PATH,
  THREAD_DETAIL_ROUTE_PATH,
  resolveRouteHref,
} from "@/lib/route-paths";
import { QueryClientContext } from "@tanstack/react-query";
import { queuedMessageRenderKey } from "@/hooks/cache-owners/queued-message-render-keys";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  useSenderThreadMetadataById,
  type SenderThreadMetadata,
} from "@/hooks/useSenderThreadMetadataById";
import { useSecondTick } from "@/hooks/useSecondTick";
import { usePluginDisplayName } from "@/lib/plugin-logos";
import { PluginIcon } from "@/components/plugin/PluginIcon";
import {
  describeQueuedMessageWait,
  formatQueuedMessageCountdown,
  isQueuedInboxNotice,
  isQueuedMessageSendNowAllowed,
  isQueuedWaitWakeUp,
  queuedMessageCountdownInstant,
  queuedMessageFallbackTitle,
  queuedMessageHasWaitLine,
  queuedMessageSystemTitle,
  queuedMessageWaitIcon,
} from "@/lib/queued-message-wait";
import type {
  QueuedMessageEditRequest,
  QueuedMessageGroupBoundaryRequest,
  QueuedMessageInlineEditor,
  QueuedMessageSendAction,
  QueuedMessagesListProps,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import { QueuedMessagesCountPill } from "@/components/promptbox/banner/QueuedMessagesCountPill";
import {
  getQueuedMessagesCollapsedHeight,
  getQueuedMessagesDrawerHeight,
  QUEUED_MESSAGES_COLLAPSED_HEIGHT,
  queuedMessagesEndOnGroupBoundary,
} from "@/components/promptbox/banner/queued-messages-layout";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type ClientRect,
  type Collision,
  type CollisionDetection,
  type DragEndEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  type SortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Transform } from "@dnd-kit/utilities";
import type {
  PromptInput,
  PromptTextMention,
  ThreadQueuedMessage,
} from "@omnyo/domain";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import {
  CONTROL_HOVER_TRANSITION,
  CONTROL_PRESS_FEEDBACK,
  CONTROL_PRESS_TRANSITION,
  DISCLOSURE_CHEVRON_TRANSITION,
  getSortableTransition,
  MOTION_DURATION_MS,
  resolveMotionEase,
  usePrefersReducedMotion,
} from "@omnyo/shared-ui/motion";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS } from "@/components/promptbox/banner/prompt-banner-actions";
import { QueuedMessageStartOnMenu } from "@/components/promptbox/banner/QueuedMessageStartOnMenu";
import { useScrollOverflowState } from "@/components/thread/timeline/useScrollOverflowState";
import { OverflowFade } from "@/components/ui/overflow-fade";
import { InlineMessageEditorFrame } from "@/components/promptbox/InlineMessageEditorFrame";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";
import {
  buildThreadMentionComponent,
  remarkThreadMentions,
} from "@/components/ui/markdown-thread-mentions";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@omnyo/shared-ui/tooltip";
import { cn } from "@omnyo/shared-ui/lib/utils";
import {
  countQueuedMessageAttachments,
  formatQueuedMessagePreview,
} from "@omnyo/client-core";
import {
  collectLeadQueuedMessageGroupIds,
  preserveLeadQueuedMessageGroupAfterReorder,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  PromptMentionPill,
  shiftMentionsToTextRange,
} from "@/components/thread/timeline/ConversationMessageMentions";
import {
  buildPromptMentionComponent,
  remarkPromptMentions,
  substitutePromptMentions,
} from "@/components/ui/markdown-prompt-mentions";
import { normalizePromptBlockquoteBoundaries } from "@/components/ui/markdown-prompt-blockquote-boundaries";
import {
  QueuedEditorTypeaheadLayoutContext,
  type QueuedEditorTypeaheadLayout,
} from "@/components/promptbox/queued-editor-typeahead-layout";

interface QueuedMessagePreviewText {
  mentions: PromptTextMention[];
  text: string;
}

interface QueuedMessageRowProps {
  senderLabel: string | null;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
  index: number;
  isProcessing: boolean;
  processingLabel: string;
  dragDisabled: boolean;
  sendAction: QueuedMessageSendAction;
  sendDisabled: boolean;
  actionDisabled: boolean;
  mobileActionsExpanded: boolean;
  onExpandMobileActions: (id: string) => void;
  onSend: (id: string) => void;
  onEdit: (request: QueuedMessageEditRequest) => void;
  onDelete: (id: string) => void;
  compact: boolean;
  isGroupBoundary: boolean;
  entering: boolean;
  startOnThreadId: string | null;
  toggleGutter: boolean;
  tuckedAway: boolean;
  soleVisible: boolean;
}

type QueueSurfacePresence = "appeared" | "entered" | "exiting";

const QUEUE_SURFACE_EXIT_KEYFRAME = {
  height: "0px",
  marginBottom: "0px",
  paddingBottom: "0px",
  opacity: 0,
};

const GROUP_DIVIDER_ID = "__queued_message_group_divider__";

const WORKSPACE_MIN_HEIGHT = 96;

const WORKSPACE_MAX_HEIGHT = 360;

const WORKSPACE_CHROME_HEIGHT = 56;

const WORKSPACE_ROW_HEIGHT = 40;

const TYPEAHEAD_MENU_GAP = 8;

type QueueSurfaceMode = "collapsed" | "drawer" | "workspace";

function getWorkspaceHeight({
  messageCount,
}: {
  messageCount: number;
}): number {
  const estimatedHeight =
    WORKSPACE_CHROME_HEIGHT + Math.max(1, messageCount) * WORKSPACE_ROW_HEIGHT;

  return clamp(estimatedHeight, WORKSPACE_MIN_HEIGHT, WORKSPACE_MAX_HEIGHT);
}

export function getInlineEditorSurfaceMaxHeight({
  containerHeight,
  surfaceHeight,
  viewportHeight,
}: {
  containerHeight: number;
  surfaceHeight: number;
  viewportHeight: number;
}): number {
  const occupiedHeightOutsideQueue = Math.max(
    0,
    containerHeight - surfaceHeight,
  );

  return Math.max(
    QUEUED_MESSAGES_COLLAPSED_HEIGHT,
    Math.floor(viewportHeight - occupiedHeightOutsideQueue),
  );
}

function queuedMarkdownPreviewClass(compact: boolean): string {
  return cn(
    "block min-w-0 truncate",
    compact ? "!text-xs !leading-4" : "!text-sm !leading-5",
  );
}

const QUEUED_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkPromptMentions,
  remarkThreadMentions,
];

function compactInline(children: ReactNode): ReactElement {
  return <span>{children} </span>;
}

const QUEUED_MARKDOWN_COMPONENTS: Components = {
  a: ({ children, href }) => {
    const route =
      href === undefined
        ? null
        : resolveRouteHref({
            currentOrigin: window.location.origin,
            href,
          });

    const pathname = route?.path.split(/[?#]/u, 1)[0];

    return route &&
      pathname &&
      (matchPath(THREAD_DETAIL_ROUTE_PATH, pathname) ||
        matchPath(PROJECTLESS_THREAD_DETAIL_ROUTE_PATH, pathname)) ? (
      <RouteAnchor className="underline decoration-dotted" href={route.path}>
        {children}
      </RouteAnchor>
    ) : (
      <span>{children}</span>
    );
  },
  blockquote: ({ children }) => (
    <span className="inline border-l-2 border-surface-selected-border pl-2 text-muted-foreground">
      {children}
    </span>
  ),
  br: () => " ",
  code: ({ children }) => (
    <code className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-xs">
      {children}
    </code>
  ),
  h1: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h2: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h3: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h4: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h5: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  h6: ({ children }) => (
    <span className="font-semibold text-foreground">{children} </span>
  ),
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  li: ({ children }) => <span>{children} </span>,
  ol: ({ children }) => <span>{children}</span>,
  p: ({ children }) => compactInline(children),
  pre: ({ children }) => <span>{children}</span>,
  table: ({ children }) => <span>{children}</span>,
  tbody: ({ children }) => <span>{children}</span>,
  td: ({ children }) => <span>{children} </span>,
  th: ({ children }) => <span>{children} </span>,
  thead: ({ children }) => <span>{children}</span>,
  tr: ({ children }) => <span>{children} </span>,
  ul: ({ children }) => <span>{children}</span>,
};

function CompactQueuedMarkdownPreview({
  compact,
  preview,
  resolveMentionLink,
}: {
  compact: boolean;
  preview: QueuedMessagePreviewText;
  resolveMentionLink?: PromptMentionLinkResolver;
}) {
  const promptMentionSubstitution = useMemo(
    () => substitutePromptMentions(preview.text, preview.mentions),
    [preview.mentions, preview.text],
  );

  const markdownContent = useMemo(
    () =>
      normalizePromptBlockquoteBoundaries(promptMentionSubstitution.content),
    [promptMentionSubstitution.content],
  );

  const components = useMemo<Components>(
    () => ({
      ...QUEUED_MARKDOWN_COMPONENTS,
      "omnyo-prompt-mention": buildPromptMentionComponent({
        mentions: promptMentionSubstitution.mentions,
        resolveMentionLink,
      }),
      "omnyo-thread-mention": buildThreadMentionComponent({
        mentions: preview.mentions,
      }),
    }),
    [preview.mentions, promptMentionSubstitution.mentions, resolveMentionLink],
  );

  return (
    <span className={queuedMarkdownPreviewClass(compact)}>
      <ReactMarkdown
        components={components}
        remarkPlugins={QUEUED_MARKDOWN_REMARK_PLUGINS}
      >
        {markdownContent}
      </ReactMarkdown>
    </span>
  );
}

export function resolveQueuedMessageDrag({
  activeId,
  combinedIds,
  orderedMessages,
  overId,
}: {
  activeId: string;
  combinedIds: readonly string[];
  orderedMessages: readonly ThreadQueuedMessage[];
  overId: string;
}):
  | {
      kind: "divider";
      orderedMessages: ThreadQueuedMessage[];
      request: QueuedMessageGroupBoundaryRequest;
    }
  | {
      kind: "row";
      request: QueuedMessageReorderRequest;
      orderedMessages: ThreadQueuedMessage[];
    }
  | null {
  if (activeId === overId) {
    return null;
  }

  const oldIndex = combinedIds.indexOf(activeId);
  const newIndex = combinedIds.indexOf(overId);

  if (oldIndex === -1 || newIndex === -1) {
    return null;
  }

  const movedIds = arrayMove([...combinedIds], oldIndex, newIndex);

  const byId = new Map(
    orderedMessages.map((queuedMessage) => [queuedMessage.id, queuedMessage]),
  );

  const dividerIndex = movedIds.indexOf(GROUP_DIVIDER_ID);

  const nextMessages = movedIds
    .filter((id) => id !== GROUP_DIVIDER_ID)
    .map((id) => byId.get(id))
    .filter(
      (queuedMessage): queuedMessage is ThreadQueuedMessage =>
        queuedMessage !== undefined,
    );

  if (activeId === GROUP_DIVIDER_ID) {
    const boundaryIndex = Math.max(dividerIndex - 1, 0);
    const groupBoundaryQueuedMessageId = nextMessages[boundaryIndex]?.id;

    if (!groupBoundaryQueuedMessageId) {
      return null;
    }

    return {
      kind: "divider",
      orderedMessages: nextMessages.map((queuedMessage, index) => ({
        ...queuedMessage,
        groupWithNext: index < boundaryIndex,
      })),
      request: {
        expectedGroupedPrefixQueuedMessageIds: nextMessages
          .slice(0, boundaryIndex + 1)
          .map((queuedMessage) => queuedMessage.id),
        groupBoundaryQueuedMessageId,
      },
    };
  }

  const messageIndex = nextMessages.findIndex(
    (queuedMessage) => queuedMessage.id === activeId,
  );

  if (messageIndex === -1) {
    return null;
  }

  return {
    kind: "row",
    orderedMessages: preserveLeadQueuedMessageGroupAfterReorder({
      queuedMessages: nextMessages,
      originalLeadGroupIds: collectLeadQueuedMessageGroupIds(orderedMessages),
    }),
    request: {
      queuedMessageId: activeId,
      previousQueuedMessageId: nextMessages[messageIndex - 1]?.id ?? null,
      nextQueuedMessageId: nextMessages[messageIndex + 1]?.id ?? null,
    },
  };
}

export function clampQueuedMessageDragTransform({
  draggingNodeRect,
  listRect,
  scrollRect,
  transform,
}: {
  draggingNodeRect: ClientRect | null;
  listRect: ClientRect | null;
  scrollRect: ClientRect | null;
  transform: Transform;
}): Transform {
  if (!draggingNodeRect || (!listRect && !scrollRect)) {
    return { ...transform, x: 0 };
  }

  const boundsTop = Math.max(
    listRect?.top ?? Number.NEGATIVE_INFINITY,
    scrollRect?.top ?? Number.NEGATIVE_INFINITY,
  );

  const boundsBottom = Math.min(
    listRect?.bottom ?? Number.POSITIVE_INFINITY,
    scrollRect?.bottom ?? Number.POSITIVE_INFINITY,
  );

  const minY = boundsTop - draggingNodeRect.top;
  const maxY = boundsBottom - draggingNodeRect.bottom;

  return {
    ...transform,
    x: 0,
    y: Math.min(Math.max(transform.y, minY), maxY),
  };
}

export function snapGroupBoundaryDragTransform({
  activeId,
  activeNodeRect,
  overId,
  overRect,
  transform,
}: {
  activeId: string | null;
  activeNodeRect: ClientRect | null;
  overId: string | null;
  overRect: ClientRect | null;
  transform: Transform;
}): Transform {
  if (activeId !== GROUP_DIVIDER_ID || !activeNodeRect) {
    return transform;
  }

  if (overId === GROUP_DIVIDER_ID || !overRect) {
    return { ...transform, x: 0 };
  }

  const activeCenterY = activeNodeRect.top + activeNodeRect.height / 2;

  return {
    ...transform,
    x: 0,
    y: overRect.bottom - activeCenterY,
  };
}

function collisionDistance(collision: Collision): number {
  const value = collision.data?.value;

  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}

export const queuedMessageCollisionDetection: CollisionDetection = (args) => {
  if (String(args.active.id) !== GROUP_DIVIDER_ID || !args.pointerCoordinates) {
    return closestCenter(args);
  }

  const collisions: Collision[] = [];

  for (const droppableContainer of args.droppableContainers) {
    if (String(droppableContainer.id) === GROUP_DIVIDER_ID) continue;
    const rect = args.droppableRects.get(droppableContainer.id);

    if (!rect) continue;
    collisions.push({
      id: droppableContainer.id,
      data: {
        droppableContainer,
        value: Math.abs(args.pointerCoordinates.y - rect.bottom),
      },
    });
  }

  return collisions.sort(
    (left, right) => collisionDistance(left) - collisionDistance(right),
  );
};

export function queuedMessageSortingStrategy(
  sortableIds: readonly string[],
  args: Parameters<SortingStrategy>[0],
): ReturnType<SortingStrategy> {
  const activeId = sortableIds[args.activeIndex];

  if (activeId === GROUP_DIVIDER_ID && args.index !== args.activeIndex) {
    return null;
  }

  return verticalListSortingStrategy(args);
}

function visibleQueuedMessageTextChunks(
  input: readonly PromptInput[],
): Extract<PromptInput, { type: "text" }>[] {
  return input.filter(
    (chunk): chunk is Extract<PromptInput, { type: "text" }> =>
      chunk.type === "text" && chunk.visibility !== "agent-only",
  );
}

function queuedMessageSenderLabel(
  queuedMessage: ThreadQueuedMessage,
  senderThreadMetadataById: ReadonlyMap<string, SenderThreadMetadata>,
): string | null {
  if (queuedMessage.senderThreadId !== null) {
    return (
      senderThreadMetadataById.get(queuedMessage.senderThreadId)?.title ??
      queuedMessage.senderThreadId
    );
  }

  if (queuedMessage.payload.kind !== "inline") return null;

  if (isQueuedWaitWakeUp(queuedMessage)) return null;

  if (isQueuedInboxNotice(queuedMessage)) return "Inbox";

  if (queuedMessage.messageSource?.kind === "script")
    return `Script ${queuedMessage.messageSource.label}`;

  if (queuedMessage.messageSource?.kind === "plugin")
    return `Plugin ${queuedMessage.messageSource.pluginId}`;

  if (queuedMessage.initiator === "system") return "System";

  return queuedMessage.initiator === "agent" ? "Agent" : null;
}

function shiftMentionsBy(
  mentions: readonly PromptTextMention[],
  offset: number,
): PromptTextMention[] {
  if (offset === 0) return [...mentions];

  return mentions.map((mention) => ({
    ...mention,
    start: mention.start + offset,
    end: mention.end + offset,
  }));
}

function trimQueuedMessagePreviewTextRange({
  mentions,
  rangeEnd,
  rangeStart,
  text,
}: {
  mentions: readonly PromptTextMention[];
  rangeEnd: number;
  rangeStart: number;
  text: string;
}): QueuedMessagePreviewText | null {
  const rawText = text.slice(rangeStart, rangeEnd);
  const leadingWhitespaceLength = rawText.length - rawText.trimStart().length;
  const trimmedRelativeEnd = rawText.trimEnd().length;

  if (trimmedRelativeEnd <= leadingWhitespaceLength) {
    return null;
  }

  const trimmedStart = rangeStart + leadingWhitespaceLength;
  const trimmedEnd = rangeStart + trimmedRelativeEnd;

  return {
    text: text.slice(trimmedStart, trimmedEnd),
    mentions: shiftMentionsToTextRange({
      mentions,
      rangeStart: trimmedStart,
      rangeEnd: trimmedEnd,
    }),
  };
}

function buildQueuedMessagePreviewText(
  input: readonly PromptInput[],
): QueuedMessagePreviewText {
  let text = "";
  const mentions: PromptTextMention[] = [];

  for (const chunk of visibleQueuedMessageTextChunks(input)) {
    const trimmedChunk = trimQueuedMessagePreviewTextRange({
      text: chunk.text,
      mentions: chunk.mentions,
      rangeStart: 0,
      rangeEnd: chunk.text.length,
    });

    if (!trimmedChunk) continue;

    const separator = text.length > 0 ? "\n\n" : "";
    const offset = text.length + separator.length;
    text += separator + trimmedChunk.text;
    mentions.push(...shiftMentionsBy(trimmedChunk.mentions, offset));
  }

  return { text, mentions };
}

function QueuedMessageFallbackTitle({
  compact,
  queuedMessage,
}: {
  compact: boolean;
  queuedMessage: ThreadQueuedMessage;
}) {
  const now = useSecondTick();

  const title = queuedMessageFallbackTitle({
    createdAt: queuedMessage.createdAt,
    now,
    payload: queuedMessage.payload,
  });

  return (
    <span className={queuedMarkdownPreviewClass(compact)} title={title}>
      {title}
    </span>
  );
}

function QueuedMessagePreview({
  compact,
  queuedMessage,
  resolveMentionLink,
}: {
  compact: boolean;
  queuedMessage: ThreadQueuedMessage;
  resolveMentionLink?: PromptMentionLinkResolver;
}) {
  const preview = useMemo(
    () =>
      formatQueuedMessagePreview(queuedMessage.content, {
        truncate: false,
      }),
    [queuedMessage.content],
  );

  const markdownPreview = useMemo(
    () => buildQueuedMessagePreviewText(queuedMessage.content),
    [queuedMessage.content],
  );

  if (queuedMessage.payload.kind === "retry") {
    return (
      <div className="min-w-0 flex-1 overflow-hidden text-foreground">
        <QueuedMessageFallbackTitle
          compact={compact}
          queuedMessage={queuedMessage}
        />
      </div>
    );
  }

  const systemTitle = queuedMessageSystemTitle(queuedMessage);

  if (systemTitle !== null) {
    return (
      <div
        className="min-w-0 flex-1 overflow-hidden text-foreground"
        title={systemTitle}
      >
        <span className={queuedMarkdownPreviewClass(compact)}>
          {systemTitle}
        </span>
      </div>
    );
  }

  return (
    <div
      className="min-w-0 flex-1 overflow-hidden text-foreground"
      title={preview}
    >
      {markdownPreview.text.length > 0 ? (
        <CompactQueuedMarkdownPreview
          compact={compact}
          preview={markdownPreview}
          resolveMentionLink={resolveMentionLink}
        />
      ) : (
        <span className={queuedMarkdownPreviewClass(compact)}>{preview}</span>
      )}
    </div>
  );
}

function QueuedMessageWaitLine({
  pluginDisplayName,
  queuedMessage,
}: {
  pluginDisplayName: string;
  queuedMessage: ThreadQueuedMessage;
}) {
  const now = useSecondTick();

  const label = describeQueuedMessageWait({
    failureReason: queuedMessage.failureReason,
    now,
    payload: queuedMessage.payload,
    pluginDisplayName,
    sendAt: queuedMessage.sendAt,
    waitingOn: queuedMessage.waitingOn,
  });

  if (label === null) return null;
  const failed = queuedMessage.failureReason !== null;
  const icon = queuedMessageWaitIcon(queuedMessage);
  const countdownInstant = queuedMessageCountdownInstant(queuedMessage);

  const countdown =
    countdownInstant === null
      ? null
      : formatQueuedMessageCountdown(countdownInstant - now);

  return (
    <span
      data-queued-message-wait=""
      data-queued-message-failed={failed ? "" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-1 text-2xs",
        failed ? "text-destructive-text" : "text-subtle-foreground",
      )}
    >
      {icon !== null ? (
        <Icon
          name={icon}
          className={cn(
            "size-3 shrink-0",
            icon === "Spinner" && "animate-spin",
          )}
          aria-hidden
        />
      ) : queuedMessage.waitingOn?.kind === "plugin" ? (
        <PluginIcon
          pluginId={queuedMessage.waitingOn.pluginId}
          icon={null}
          fallbackIcon={null}
          className="size-3"
        />
      ) : null}
      <span className="min-w-0 truncate">{label}</span>
      {countdown === null ? null : (
        <span className="shrink-0 tabular-nums">· {countdown}</span>
      )}
    </span>
  );
}

function useQueuedMessageArrivals(
  queuedMessages: readonly ThreadQueuedMessage[],
): number {
  const [tracker, setTracker] = useState(() => ({
    arrivals: 0,
    count: queuedMessages.length,
    seenIds: new Set(queuedMessages.map((queuedMessage) => queuedMessage.id)),
  }));

  const hasUnseen = queuedMessages.some(
    (queuedMessage) => !tracker.seenIds.has(queuedMessage.id),
  );

  if (hasUnseen || tracker.count !== queuedMessages.length) {
    setTracker({
      arrivals:
        hasUnseen && queuedMessages.length > tracker.count
          ? tracker.arrivals + 1
          : tracker.arrivals,
      count: queuedMessages.length,
      seenIds: hasUnseen
        ? new Set([
            ...tracker.seenIds,
            ...queuedMessages.map((queuedMessage) => queuedMessage.id),
          ])
        : tracker.seenIds,
    });
  }

  return tracker.arrivals;
}

function useEnteringRenderKeys(
  renderKeys: readonly string[],
): ReadonlySet<string> {
  const [tracker, setTracker] = useState(() => ({
    entering: new Set<string>(),
    known: new Set(renderKeys),
  }));

  const unseen = renderKeys.filter((key) => !tracker.known.has(key));

  if (unseen.length > 0) {
    setTracker({
      entering: new Set(unseen),
      known: new Set([...tracker.known, ...unseen]),
    });
  }

  return tracker.entering;
}

function QueuedMessageProcessingLine({ label }: { label: string }) {
  return (
    <div
      data-queued-message-processing=""
      className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
    >
      <Icon
        name="Spinner"
        className="size-3 shrink-0 animate-spin"
        aria-hidden
      />
      <span className="min-w-0 truncate">{label}</span>
    </div>
  );
}

const QueuedMessageRow = memo(function QueuedMessageRow({
  senderLabel,
  queuedMessage,
  resolveMentionLink,
  index,
  isProcessing,
  processingLabel,
  dragDisabled,
  sendAction,
  sendDisabled,
  actionDisabled,
  mobileActionsExpanded,
  onExpandMobileActions,
  onSend,
  onEdit,
  onDelete,
  compact,
  isGroupBoundary,
  entering,
  startOnThreadId,
  toggleGutter,
  tuckedAway,
  soleVisible,
}: QueuedMessageRowProps) {
  const actionsRef = useRef<HTMLDivElement>(null);
  const focusActionsOnExpandRef = useRef(false);
  useLayoutEffect(() => {
    if (!mobileActionsExpanded || !focusActionsOnExpandRef.current) return;
    focusActionsOnExpandRef.current = false;
    actionsRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus({ preventScroll: true });
  }, [mobileActionsExpanded]);

  const attachmentCount = useMemo(
    () => countQueuedMessageAttachments(queuedMessage.content),
    [queuedMessage.content],
  );

  const pluginDisplayName = usePluginDisplayName(
    queuedMessage.waitingOn?.kind === "plugin"
      ? queuedMessage.waitingOn.pluginId
      : "",
  );

  const hasWaitLine = queuedMessageHasWaitLine(queuedMessage);

  const sendAllowed =
    queuedMessage.waitingOn?.kind !== "server-update" &&
    (sendAction === "steer-when-ready" ||
      isQueuedMessageSendNowAllowed(queuedMessage));

  const sendAriaLabel =
    sendAction === "steer-when-ready"
      ? `Steer queued message ${index + 1} when ready`
      : `Send queued message ${index + 1} now`;

  const sendLabel =
    sendAction === "steer-when-ready" ? "Steer when ready" : "Send now";

  const prefersReducedMotion = usePrefersReducedMotion();

  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: queuedMessage.id,
    disabled: dragDisabled,
    transition: getSortableTransition(prefersReducedMotion),
  });

  const rowStyle = {
    transform: CSS.Translate.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={rowStyle}
      data-queued-message-row=""
      data-queued-message-id={queuedMessage.id}
      data-queued-message-group-boundary-row={isGroupBoundary ? "" : undefined}
      aria-hidden={tuckedAway ? true : undefined}
      inert={tuckedAway ? true : undefined}
      className={cn(
        "group/dispatch-row relative border-b border-border/35 py-0.5 pl-2.5",
        toggleGutter ? "pr-16" : "pr-2.5",
        !isGroupBoundary && "last:border-b-0",
        soleVisible && "border-b-transparent",
        entering && "omnyo-queue-row-enter",
        isDragging &&
          "z-20 rounded-lg border border-border bg-background opacity-90 shadow-lift",
      )}
    >
      <div className="flex items-center gap-1.5">
        <Button
          ref={setActivatorNodeRef}
          type="button"
          variant="ghost"
          className={cn(
            "relative -ml-2 flex h-7 w-5 shrink-0 touch-none items-center justify-center rounded-md px-0.5 text-muted-foreground disabled:opacity-100",
            !dragDisabled && "cursor-grab active:cursor-grabbing",
          )}
          disabled={dragDisabled}
          aria-label={`Reorder queued message ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          <span
            aria-hidden="true"
            data-queued-message-position=""
            className={cn(
              "absolute text-2xs tabular-nums text-subtle-foreground",
              !dragDisabled &&
                "group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0 [@media(hover:none)]:opacity-0",
              isDragging && "opacity-0",
            )}
          >
            {index + 1}
          </span>
          <Icon
            name="DragDropVertical"
            className={cn(
              "size-3.5 shrink-0 opacity-0",
              !dragDisabled &&
                "group-hover/dispatch-row:opacity-100 group-focus-within/dispatch-row:opacity-100 [@media(hover:none)]:opacity-100",
              isDragging && "opacity-100",
            )}
            aria-hidden="true"
          />
        </Button>
        <div
          className={cn(
            "min-w-0 flex-1 py-1",
            (senderLabel !== null || hasWaitLine || isProcessing) && "py-1.5",
          )}
        >
          <div className="flex min-w-0 items-center gap-1">
            <QueuedMessagePreview
              compact={compact}
              queuedMessage={queuedMessage}
              resolveMentionLink={resolveMentionLink}
            />
            {attachmentCount > 0 ? (
              <span
                data-queued-message-attachment=""
                className={cn(
                  "ml-auto inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle-foreground opacity-70",
                  !isProcessing &&
                    "group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0 [@media(hover:none)]:opacity-0",
                )}
                role="img"
                aria-label={
                  attachmentCount === 1
                    ? "1 attachment"
                    : `${attachmentCount} attachments`
                }
              >
                <Icon name="FileAttachment" className="size-3.5" aria-hidden />
                <span aria-hidden>{attachmentCount}</span>
              </span>
            ) : null}
          </div>
          {senderLabel !== null || isProcessing || hasWaitLine ? (
            <div
              data-queued-message-metadata=""
              className="mt-0.5 flex min-w-0 items-center gap-1 text-2xs text-subtle-foreground"
            >
              {senderLabel === null ? null : (
                <span
                  data-queued-message-sender=""
                  className={cn(
                    "inline-flex min-w-0 items-center gap-1",
                    (isProcessing || hasWaitLine) && "max-w-[40%] shrink-0",
                  )}
                  title={`From ${senderLabel}`}
                >
                  <span className="shrink-0">From</span>
                  {queuedMessage.senderThreadId !== null ? (
                    <span
                      className="flex min-w-0 [&>.prompt-mention-pill]:text-2xs"
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      <PromptMentionPill
                        interactive
                        resource={{
                          kind: "thread",
                          threadId: queuedMessage.senderThreadId,
                          label: senderLabel,
                        }}
                        serializedText={`@thread:${queuedMessage.senderThreadId}`}
                      />
                    </span>
                  ) : (
                    <span className="min-w-0 truncate">{senderLabel}</span>
                  )}
                </span>
              )}
              {senderLabel !== null && (isProcessing || hasWaitLine) ? (
                <span aria-hidden className="shrink-0">
                  ·
                </span>
              ) : null}
              {isProcessing ? (
                <QueuedMessageProcessingLine label={processingLabel} />
              ) : hasWaitLine ? (
                <QueuedMessageWaitLine
                  pluginDisplayName={pluginDisplayName}
                  queuedMessage={queuedMessage}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {isProcessing ? null : (
          <>
            <TooltipProvider delayDuration={300}>
              <div
                ref={actionsRef}
                data-queued-message-actions=""
                className={cn(
                  PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                  "pointer-events-none absolute top-1/2 -translate-y-1/2 items-center gap-0.5 rounded-md opacity-0 md:flex",
                  toggleGutter ? "right-16" : "right-2.5",
                  mobileActionsExpanded
                    ? "flex pointer-events-auto opacity-100"
                    : "max-md:hidden",
                  "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
                  "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
                )}
              >
                {startOnThreadId === null ? null : (
                  <QueuedMessageStartOnMenu
                    threadId={startOnThreadId}
                    compact={compact}
                    disabled={actionDisabled}
                  />
                )}
                {sendAllowed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          compact ? "size-7" : "size-8",
                        )}
                        disabled={actionDisabled || sendDisabled}
                        onClick={() => onSend(queuedMessage.id)}
                        aria-label={sendAriaLabel}
                      >
                        <Icon name="Sent" className="size-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-md:hidden">
                      {sendLabel}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                {queuedMessage.editable ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className={cn(
                          "shrink-0 text-muted-foreground",
                          compact ? "size-7" : "size-8",
                        )}
                        disabled={actionDisabled}
                        onClick={() =>
                          onEdit({
                            queuedMessageId: queuedMessage.id,
                            queuedMessageIndex: index,
                          })
                        }
                        aria-label={`Edit queued message ${index + 1}`}
                      >
                        <Icon name="Edit" className="size-4" aria-hidden />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent className="max-md:hidden">
                      Edit
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className={cn(
                        "shrink-0 text-muted-foreground hover:text-destructive max-md:text-destructive",
                        compact ? "size-7" : "size-8",
                      )}
                      disabled={actionDisabled}
                      onClick={() => onDelete(queuedMessage.id)}
                      aria-label={`Delete queued message ${index + 1}`}
                    >
                      <Icon name="Trash2" className="size-4" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent className="max-md:hidden">
                    Delete
                  </TooltipContent>
                </Tooltip>
              </div>
            </TooltipProvider>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className={cn(
                PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                "pointer-events-none absolute top-1/2 shrink-0 -translate-y-1/2 text-muted-foreground opacity-0 md:[@media(hover:hover)]:hidden",
                toggleGutter ? "right-16" : "right-2.5",
                "group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100",
                "group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100",
                "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
                compact ? "size-7" : "size-8",
                mobileActionsExpanded && "hidden",
              )}
              disabled={actionDisabled}
              aria-label={`Queued message ${index + 1} actions`}
              aria-expanded={mobileActionsExpanded}
              onClick={(event) => {
                focusActionsOnExpandRef.current = event.detail === 0;
                onExpandMobileActions(queuedMessage.id);
              }}
            >
              <Icon name="MoreHorizontal" className="size-4" aria-hidden />
            </Button>
          </>
        )}
      </div>
    </li>
  );
});

function SortableGroupBoundaryHandle({
  disabled,
  tuckedAway,
}: {
  disabled: boolean;
  tuckedAway: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();

  const {
    active,
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: GROUP_DIVIDER_ID,
    disabled,
    transition: getSortableTransition(prefersReducedMotion),
  });

  const anotherItemIsDragging =
    active !== null && active.id !== GROUP_DIVIDER_ID;

  return (
    <li
      ref={setNodeRef}
      data-queued-message-group-divider=""
      style={{
        transform: isDragging ? CSS.Translate.toString(transform) : undefined,
        transition: isDragging ? transition : undefined,
      }}
      aria-hidden={tuckedAway ? true : undefined}
      inert={tuckedAway ? true : undefined}
      className={cn(
        "pointer-events-none relative z-10 h-0 list-none",
        tuckedAway && "invisible",
      )}
    >
      <div className="absolute left-1/2 top-[-0.5px] -translate-x-1/2 -translate-y-1/2">
        <div className="pointer-events-none">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={setActivatorNodeRef}
                  type="button"
                  className={cn(
                    "pointer-events-auto flex size-6 shrink-0 touch-none select-none items-center justify-center rounded-full border border-transparent bg-transparent text-muted-foreground transition-[background-color,border-color,box-shadow,color] focus-visible:border-border focus-visible:bg-background focus-visible:shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring queue-boundary-row-hover:border-border queue-boundary-row-hover:bg-background queue-boundary-row-hover:shadow-sm queue-boundary-row-focus-within:border-border queue-boundary-row-focus-within:bg-background queue-boundary-row-focus-within:shadow-sm hover:border-border hover:bg-background hover:shadow-sm [@media(hover:none)]:border-border [@media(hover:none)]:bg-background [@media(hover:none)]:shadow-sm",
                    anotherItemIsDragging
                      ? "pointer-events-none opacity-0"
                      : "opacity-100",
                    !disabled && "cursor-grab active:cursor-grabbing",
                    isDragging &&
                      "pointer-events-auto cursor-grabbing border-border bg-background text-foreground opacity-100 shadow-sm",
                  )}
                  disabled={disabled}
                  aria-label="Messages above send together"
                  {...attributes}
                  {...listeners}
                >
                  <Icon
                    name="DragDropHorizontal"
                    className="size-3.5 opacity-55 transition-opacity queue-boundary-row-hover:opacity-100 queue-boundary-row-focus-within:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-md:hidden">
                Messages above send together
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </li>
  );
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function findInlineEditorNeighborhood(list: HTMLUListElement): {
  editorElement: HTMLElement;
  firstElement: HTMLElement;
  lastElement: HTMLElement;
} | null {
  const editorElement = list.querySelector<HTMLElement>(
    "[data-queued-message-inline-editor]",
  );

  if (!editorElement) return null;

  const items = Array.from(list.children);
  const editorIndex = items.indexOf(editorElement);

  const previousRow = items
    .slice(0, editorIndex)
    .reverse()
    .find((item) => item.hasAttribute("data-queued-message-row"));

  const followingRow = items
    .slice(editorIndex + 1)
    .find((item) => item.hasAttribute("data-queued-message-row"));

  return {
    editorElement,
    firstElement: (previousRow ?? editorElement) as HTMLElement,
    lastElement: (followingRow ?? editorElement) as HTMLElement,
  };
}

function QueuedMessageInlineEditorSlot({
  editor,
}: {
  editor: QueuedMessageInlineEditor;
}) {
  const [typeaheadLayout, setTypeaheadLayout] =
    useState<QueuedEditorTypeaheadLayout>({ height: 0, isOpen: false });

  const typeaheadReservation = typeaheadLayout.isOpen
    ? Math.ceil(typeaheadLayout.height) + TYPEAHEAD_MENU_GAP
    : 0;

  return (
    <li
      data-queued-message-inline-editor=""
      className="relative z-10 border-b border-border/35 px-2.5 py-1 last:border-b-0"
    >
      <OverflowFade placement="above" tone="surface-raised" className="z-10" />
      <InlineMessageEditorFrame
        cancelLabel="Stop editing queued message"
        label={`Editing queued message ${editor.queuedMessageIndex + 1}`}
        onCancel={editor.onDismiss}
      >
        <QueuedEditorTypeaheadLayoutContext.Provider value={setTypeaheadLayout}>
          <div
            data-queued-editor-typeahead-reservation=""
            style={{ paddingTop: typeaheadReservation }}
          >
            {editor.content}
          </div>
        </QueuedEditorTypeaheadLayoutContext.Provider>
      </InlineMessageEditorFrame>
      <OverflowFade placement="below" tone="surface-raised" className="z-10" />
    </li>
  );
}

function queuedMessageOrder(
  messages: readonly ThreadQueuedMessage[],
): Pick<ThreadQueuedMessage, "id" | "groupWithNext">[] {
  return messages.map(({ id, groupWithNext }) => ({ id, groupWithNext }));
}

type QueuePresence = QueueSurfacePresence | "hidden";

export function QueuedMessagesList(props: QueuedMessagesListProps) {
  const present =
    props.queuedMessages.length > 0 || props.inlineEditor !== undefined;

  const prefersReducedMotion = usePrefersReducedMotion();

  const [presence, setPresence] = useState<QueuePresence>(
    present ? "appeared" : "hidden",
  );

  const [retainedMessages, setRetainedMessages] = useState(
    props.queuedMessages,
  );

  if (
    props.queuedMessages.length > 0 &&
    props.queuedMessages !== retainedMessages
  ) {
    setRetainedMessages(props.queuedMessages);
  }

  if (present && presence === "hidden") {
    setPresence(prefersReducedMotion ? "appeared" : "entered");
  } else if (present && presence === "exiting") {
    setPresence("appeared");
  } else if (!present && (presence === "appeared" || presence === "entered")) {
    setPresence(prefersReducedMotion ? "hidden" : "exiting");
  }

  const handleExitComplete = useCallback(() => setPresence("hidden"), []);

  if (presence === "hidden") return null;

  return (
    <QueuedMessagesSurface
      {...props}
      queuedMessages={present ? props.queuedMessages : retainedMessages}
      presence={presence}
      onExitComplete={handleExitComplete}
    />
  );
}

function useQueueSurfaceExit(
  surfaceRef: RefObject<HTMLElement | null>,
  exiting: boolean,
  onExitComplete: () => void,
): void {
  useLayoutEffect(() => {
    const surface = surfaceRef.current;

    if (!exiting || surface === null) return;

    const easing = resolveMotionEase("smooth");

    if (easing === "") {
      onExitComplete();

      return;
    }

    const style = getComputedStyle(surface);

    const animation = surface.animate(
      [
        {
          height: style.height,
          marginBottom: style.marginBottom,
          paddingBottom: style.paddingBottom,
          opacity: 1,
        },
        QUEUE_SURFACE_EXIT_KEYFRAME,
      ],
      {
        duration: MOTION_DURATION_MS.base,
        easing,
        fill: "forwards",
      },
    );

    animation.finished.then(onExitComplete, () => {});

    return () => animation.cancel();
  }, [exiting, onExitComplete, surfaceRef]);
}

function QueuedMessagesSurface({
  attachedToComposer,
  queuedMessages,
  resolveMentionLink,
  sendAction,
  sendDisabled,
  actionDisabled,
  processingMessageId,
  processingAction,
  inlineEditor,
  onSend,
  onReorder,
  onSetGroupBoundary,
  onEdit,
  onDelete,
  expanded,
  onExpandedChange,
  waitingStartThreadId,
  presence,
  onExitComplete,
}: QueuedMessagesListProps & {
  presence: QueueSurfacePresence;
  onExitComplete: () => void;
}) {
  const senderThreadMetadataById = useSenderThreadMetadataById();
  const queryClient = useContext(QueryClientContext) ?? null;

  const processingLabel =
    processingAction === "edit"
      ? "Editing…"
      : processingAction === "delete"
        ? "Deleting…"
        : "Sending…";

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const mode: QueueSurfaceMode = inlineEditor
    ? "workspace"
    : expanded && queuedMessages.length > 1
      ? "drawer"
      : "collapsed";

  const arrivals = useQueuedMessageArrivals(queuedMessages);

  const [expandedMobileActionsId, setExpandedMobileActionsId] = useState<
    string | null
  >(null);

  const listId = useId();

  const [inlineEditorMaxHeight, setInlineEditorMaxHeight] = useState<
    number | null
  >(null);

  const [inlineEditorDesiredHeight, setInlineEditorDesiredHeight] = useState<
    number | null
  >(null);

  const inlineEditorActive = inlineEditor !== undefined;
  const getScrollElement = useBottomAnchoredScroll()?.getScrollElement;
  const surfaceRef = useRef<HTMLElement>(null);
  useQueueSurfaceExit(surfaceRef, presence === "exiting", onExitComplete);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (expandedMobileActionsId === null) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !surfaceRef.current?.contains(event.target)
      ) {
        setExpandedMobileActionsId(null);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [expandedMobileActionsId]);

  const {
    aboveOverflow,
    belowOverflow,
    bottomSentinelRef,
    scrollRef,
    topSentinelRef,
  } = useScrollOverflowState<HTMLDivElement>({
    measureOverflow: true,
  });

  const scrollInlineEditorNeighborhoodIntoView = useCallback(() => {
    const list = listRef.current;
    const scroll = scrollRef.current;
    const neighborhood = list ? findInlineEditorNeighborhood(list) : null;

    if (!scroll || !neighborhood) return;

    const { editorElement, firstElement, lastElement } = neighborhood;
    const viewportRect = scroll.getBoundingClientRect();
    const firstRect = firstElement.getBoundingClientRect();
    const lastRect = lastElement.getBoundingClientRect();
    const neighborhoodHeight = lastRect.bottom - firstRect.top;
    let delta = 0;

    if (neighborhoodHeight <= viewportRect.height) {
      if (firstRect.top < viewportRect.top) {
        delta = firstRect.top - viewportRect.top;
      } else if (lastRect.bottom > viewportRect.bottom) {
        delta = lastRect.bottom - viewportRect.bottom;
      }
    } else {
      const editorRect = editorElement.getBoundingClientRect();

      if (editorRect.height > viewportRect.height) {
        delta = editorRect.top - viewportRect.top;
      } else if (editorRect.top < viewportRect.top) {
        delta = editorRect.top - viewportRect.top;
      } else if (editorRect.bottom > viewportRect.bottom) {
        delta = editorRect.bottom - viewportRect.bottom;
      }
    }

    if (delta !== 0) {
      scroll.scrollTop += delta;
    }
  }, [scrollRef]);

  const measureInlineEditorMaxHeight = useCallback(() => {
    if (!inlineEditorActive) {
      setInlineEditorMaxHeight(null);
      setInlineEditorDesiredHeight(null);

      return;
    }

    const viewport = getScrollElement?.();
    const surface = surfaceRef.current;
    const composerShell = surface?.closest<HTMLElement>("[data-app-composer]");
    const container = composerShell?.parentElement;

    if (!viewport || !surface || !container) {
      setInlineEditorMaxHeight(null);

      return;
    }

    const nextHeight = getInlineEditorSurfaceMaxHeight({
      containerHeight: container.getBoundingClientRect().height,
      surfaceHeight: surface.getBoundingClientRect().height,
      viewportHeight: viewport.clientHeight,
    });

    setInlineEditorMaxHeight((currentHeight) =>
      currentHeight === nextHeight ? currentHeight : nextHeight,
    );

    const list = listRef.current;
    const scroll = scrollRef.current;
    const neighborhood = list ? findInlineEditorNeighborhood(list) : null;

    if (!scroll || !neighborhood) {
      setInlineEditorDesiredHeight(null);

      return;
    }

    const { firstElement, lastElement } = neighborhood;
    const surfaceRect = surface.getBoundingClientRect();
    const scrollRect = scroll.getBoundingClientRect();

    const contentHeight =
      lastElement.getBoundingClientRect().bottom -
      firstElement.getBoundingClientRect().top;

    const chromeHeight = Math.max(0, surfaceRect.height - scrollRect.height);

    const desiredHeight = Math.max(
      WORKSPACE_MIN_HEIGHT,
      Math.ceil(contentHeight + chromeHeight),
    );

    setInlineEditorDesiredHeight((currentHeight) =>
      currentHeight === desiredHeight ? currentHeight : desiredHeight,
    );
    scrollInlineEditorNeighborhoodIntoView();
  }, [
    getScrollElement,
    inlineEditorActive,
    scrollInlineEditorNeighborhoodIntoView,
    scrollRef,
  ]);

  useLayoutEffect(() => {
    measureInlineEditorMaxHeight();

    if (!inlineEditorActive) return;

    const viewport = getScrollElement?.();
    const surface = surfaceRef.current;
    const composerShell = surface?.closest<HTMLElement>("[data-app-composer]");
    const container = composerShell?.parentElement;

    const animationFrame = window.requestAnimationFrame(
      measureInlineEditorMaxHeight,
    );

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measureInlineEditorMaxHeight);

    if (viewport) resizeObserver?.observe(viewport);

    if (surface) resizeObserver?.observe(surface);

    if (listRef.current) resizeObserver?.observe(listRef.current);

    const editorElement = listRef.current?.querySelector<HTMLElement>(
      "[data-queued-message-inline-editor]",
    );

    if (editorElement) resizeObserver?.observe(editorElement);

    if (composerShell) resizeObserver?.observe(composerShell);

    if (container) resizeObserver?.observe(container);
    window.addEventListener("resize", measureInlineEditorMaxHeight);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measureInlineEditorMaxHeight);
    };
  }, [getScrollElement, inlineEditorActive, measureInlineEditorMaxHeight]);

  const [messageOrder, setMessageOrder] = useState(() =>
    queuedMessageOrder(queuedMessages),
  );

  const orderKey = queuedMessages
    .map(
      (queuedMessage) =>
        `${queuedMessage.id}:${queuedMessage.groupWithNext ? "1" : "0"}:${queuedMessage.updatedAt}`,
    )
    .join("|");

  const [syncedOrderKey, setSyncedOrderKey] = useState(orderKey);

  if (orderKey !== syncedOrderKey) {
    setSyncedOrderKey(orderKey);
    setMessageOrder(queuedMessageOrder(queuedMessages));
  }

  const orderedMessages = useMemo(() => {
    const messagesById = new Map(
      queuedMessages.map((message) => [message.id, message]),
    );

    return messageOrder.flatMap(({ id, groupWithNext }) => {
      const message = messagesById.get(id);

      if (message === undefined) return [];

      return [
        message.groupWithNext === groupWithNext
          ? message
          : { ...message, groupWithNext },
      ];
    });
  }, [messageOrder, queuedMessages]);

  const groupBoundaryIndex = useMemo(() => {
    const firstUngroupedIndex = orderedMessages.findIndex(
      (queuedMessage) => !queuedMessage.groupWithNext,
    );

    return firstUngroupedIndex === -1
      ? Math.max(0, orderedMessages.length - 1)
      : firstUngroupedIndex;
  }, [orderedMessages]);

  const combinedIds = useMemo(() => {
    const ids = orderedMessages.map((queuedMessage) => queuedMessage.id);

    if (ids.length < 2) return ids;

    return [
      ...ids.slice(0, groupBoundaryIndex + 1),
      GROUP_DIVIDER_ID,
      ...ids.slice(groupBoundaryIndex + 1),
    ];
  }, [groupBoundaryIndex, orderedMessages]);

  const sortingDisabled =
    actionDisabled || processingMessageId !== null || queuedMessages.length < 2;

  const sortableIds = useMemo(
    () =>
      inlineEditor
        ? combinedIds.filter((id) => id !== inlineEditor.queuedMessageId)
        : combinedIds,
    [combinedIds, inlineEditor],
  );

  const sortingStrategy = useCallback<SortingStrategy>(
    (args) => queuedMessageSortingStrategy(sortableIds, args),
    [sortableIds],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over) {
        return;
      }

      const dragResult = resolveQueuedMessageDrag({
        activeId: String(event.active.id),
        combinedIds,
        orderedMessages,
        overId: String(event.over.id),
      });

      if (!dragResult) return;

      const requestIds =
        dragResult.kind === "divider"
          ? [
              dragResult.request.groupBoundaryQueuedMessageId,
              ...dragResult.request.expectedGroupedPrefixQueuedMessageIds,
            ]
          : [
              dragResult.request.queuedMessageId,
              dragResult.request.previousQueuedMessageId,
              dragResult.request.nextQueuedMessageId,
              dragResult.request.groupBoundaryQueuedMessageId,
            ];

      if (requestIds.some((id) => id?.startsWith("optimistic-queued-"))) return;

      setMessageOrder(queuedMessageOrder(dragResult.orderedMessages));

      if (dragResult.kind === "divider") {
        onSetGroupBoundary(dragResult.request);

        return;
      }

      onReorder(dragResult.request);
    },
    [combinedIds, onReorder, onSetGroupBoundary, orderedMessages],
  );

  const restrictToListBounds = useCallback<Modifier>(
    ({ draggingNodeRect, transform }) => {
      return clampQueuedMessageDragTransform({
        draggingNodeRect,
        listRect: listRef.current?.getBoundingClientRect() ?? null,
        scrollRect: scrollRef.current?.getBoundingClientRect() ?? null,
        transform,
      });
    },
    [scrollRef],
  );

  const snapGroupBoundaryToRowStroke = useCallback<Modifier>(
    ({ active, activeNodeRect, over, transform }) =>
      snapGroupBoundaryDragTransform({
        activeId: active ? String(active.id) : null,
        activeNodeRect,
        overId: over ? String(over.id) : null,
        overRect: over?.rect ?? null,
        transform,
      }),
    [],
  );

  const collapseDrawer = useCallback(() => {
    setExpandedMobileActionsId(null);
    onExpandedChange(false);
    inlineEditor?.onDismiss();
  }, [inlineEditor, onExpandedChange]);

  const showDrawer = useCallback(() => {
    onExpandedChange(true);
  }, [onExpandedChange]);

  const isExpanded = mode !== "collapsed";

  const showToggle = inlineEditor === undefined && queuedMessages.length > 1;
  const showSummary = !isExpanded && queuedMessages.length > 1;

  const queueToggleHint = isExpanded
    ? `${queuedMessages.length} queued messages. Click to collapse the queue.`
    : `Show all ${queuedMessages.length} queued messages`;

  const boundaryClosesList =
    isExpanded && queuedMessagesEndOnGroupBoundary(orderedMessages);

  const hiddenFailure =
    !isExpanded &&
    orderedMessages.some(
      (queuedMessage) => queuedMessage.failureReason !== null,
    );

  useLayoutEffect(() => {
    if (isExpanded) return;
    const scroll = scrollRef.current;

    if (scroll) scroll.scrollTop = 0;
  }, [isExpanded, scrollRef]);

  const handleEdit = useCallback(
    (request: QueuedMessageEditRequest) => {
      setExpandedMobileActionsId(null);
      onEdit(request);
    },
    [onEdit],
  );

  const baseSurfaceHeight =
    inlineEditor || mode === "workspace"
      ? getWorkspaceHeight({
          messageCount: queuedMessages.length,
        })
      : mode === "drawer"
        ? getQueuedMessagesDrawerHeight({
            queuedMessages: orderedMessages,
            processingMessageId,
          })
        : getQueuedMessagesCollapsedHeight({
            queuedMessages: orderedMessages,
            processingMessageId,
          });

  const surfaceHeight =
    inlineEditor && inlineEditorMaxHeight !== null
      ? Math.min(
          inlineEditorDesiredHeight ?? baseSurfaceHeight,
          inlineEditorMaxHeight,
        )
      : baseSurfaceHeight;

  useLayoutEffect(() => {
    if (!inlineEditor) return;

    const animationFrame = window.requestAnimationFrame(() => {
      scrollInlineEditorNeighborhoodIntoView();
    });

    return () => window.cancelAnimationFrame(animationFrame);
  }, [inlineEditor, scrollInlineEditorNeighborhoodIntoView, surfaceHeight]);

  const enteringRenderKeys = useEnteringRenderKeys(
    orderedMessages.map((queuedMessage) =>
      queuedMessageRenderKey(queryClient, queuedMessage.id),
    ),
  );

  const queueItems: ReactNode[] = [];
  let messageIndex = 0;
  let inlineEditorInserted = false;

  for (const id of combinedIds) {
    if (id === GROUP_DIVIDER_ID) {
      queueItems.push(
        <SortableGroupBoundaryHandle
          key={GROUP_DIVIDER_ID}
          disabled={sortingDisabled || inlineEditor !== undefined}
          tuckedAway={!isExpanded}
        />,
      );
      continue;
    }

    const queuedMessage = orderedMessages.find((message) => message.id === id);

    if (!queuedMessage) continue;

    if (
      inlineEditor &&
      !inlineEditorInserted &&
      queuedMessage.id === inlineEditor.queuedMessageId
    ) {
      queueItems.push(
        <QueuedMessageInlineEditorSlot
          key={`inline-editor:${inlineEditor.queuedMessageId}`}
          editor={inlineEditor}
        />,
      );
      inlineEditorInserted = true;
    }

    if (queuedMessage.id !== inlineEditor?.queuedMessageId) {
      const renderKey = queuedMessageRenderKey(queryClient, queuedMessage.id);

      queueItems.push(
        <QueuedMessageRow
          key={renderKey}
          entering={enteringRenderKeys.has(renderKey)}
          queuedMessage={queuedMessage}
          senderLabel={queuedMessageSenderLabel(
            queuedMessage,
            senderThreadMetadataById,
          )}
          resolveMentionLink={resolveMentionLink}
          index={messageIndex}
          isProcessing={processingMessageId === queuedMessage.id}
          processingLabel={processingLabel}
          dragDisabled={
            sortingDisabled ||
            inlineEditor !== undefined ||
            queuedMessage.id.startsWith("optimistic-queued-")
          }
          sendAction={sendAction}
          sendDisabled={sendDisabled}
          actionDisabled={
            actionDisabled || queuedMessage.id.startsWith("optimistic-queued-")
          }
          mobileActionsExpanded={expandedMobileActionsId === queuedMessage.id}
          onExpandMobileActions={setExpandedMobileActionsId}
          compact={mode !== "workspace"}
          isGroupBoundary={messageIndex === groupBoundaryIndex}
          startOnThreadId={
            messageIndex === 0 ? (waitingStartThreadId ?? null) : null
          }
          toggleGutter={showToggle}
          tuckedAway={!isExpanded && messageIndex > 0}
          soleVisible={
            orderedMessages.length === 1 || (!isExpanded && messageIndex === 0)
          }
          onSend={onSend}
          onEdit={handleEdit}
          onDelete={onDelete}
        />,
      );
    }

    messageIndex += 1;
  }

  if (inlineEditor && !inlineEditorInserted) {
    queueItems.push(
      <QueuedMessageInlineEditorSlot
        key={`inline-editor:${inlineEditor.queuedMessageId}`}
        editor={inlineEditor}
      />,
    );
  }

  return (
    <PromptStackCard
      rootRef={surfaceRef}
      ariaLabel="Queued messages"
      attachedToComposer={attachedToComposer && !inlineEditor}
      style={
        showSummary
          ? { height: attachedToComposer ? 61 : 42 }
          : queuedMessages.length === 1 && !inlineEditor
            ? undefined
            : { height: surfaceHeight }
      }
      className={cn(
        "relative z-10 flex min-h-0 flex-col overflow-hidden bg-surface-raised-solid shadow-lift",
        inlineEditor || !attachedToComposer
          ? "mb-0 rounded-xl pb-4"
          : "rounded-xl rounded-b-none border-b-0 pb-3",
        "transition-[height,margin,border-radius,padding,opacity] ease-smooth motion-reduce:transition-none",
        showSummary && "pb-0",
        presence === "entered" && "omnyo-queue-card-enter",
        presence === "exiting" && "pointer-events-none",
        !inlineEditor && isExpanded
          ? "duration-(--motion-duration-slow)"
          : "duration-(--motion-duration-base)",
      )}
    >
      <header
        data-queued-messages-mode={mode}
        className={
          showSummary ? "relative z-30" : "absolute right-[13px] top-[5px] z-30"
        }
      >
        {showSummary || showToggle ? (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                {showSummary ? (
                  <button
                    type="button"
                    aria-label={`Show ${queuedMessages.length} queued messages`}
                    aria-expanded={false}
                    aria-controls={listId}
                    onClick={showDrawer}
                    className={cn(
                      "flex min-h-10 w-full items-center gap-2 px-3 text-left text-xs text-muted-foreground hover:bg-state-hover",
                      CONTROL_HOVER_TRANSITION,
                    )}
                  >
                    <Icon name="ListEnd" className="size-4" aria-hidden />
                    <span className="flex flex-1 items-center gap-1">
                      <QueuedMessagesCountPill
                        arrivals={arrivals}
                        count={queuedMessages.length}
                        prefix=""
                        tone={hiddenFailure ? "failed" : "neutral"}
                      />
                      <span>queued messages</span>
                    </span>
                    {hiddenFailure ? (
                      <Icon
                        name="AlertTriangle"
                        className="size-3.5 text-destructive-text"
                        aria-label="A queued message needs attention"
                      />
                    ) : null}
                    <Icon name="ChevronDown" className="size-3.5" aria-hidden />
                  </button>
                ) : (
                  <button
                    type="button"
                    aria-label="Toggle queued messages"
                    aria-expanded={isExpanded}
                    aria-controls={listId}
                    onClick={isExpanded ? collapseDrawer : showDrawer}
                    className={cn(
                      PROMPT_STACK_ROW_ACTION_TAKEOVER_CLASS,
                      "flex h-6 cursor-pointer items-center gap-0.5 rounded-full pl-1 pr-1.5 text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      CONTROL_PRESS_TRANSITION,
                      CONTROL_PRESS_FEEDBACK,
                    )}
                  >
                    <QueuedMessagesCountPill
                      arrivals={arrivals}
                      count={
                        isExpanded
                          ? queuedMessages.length
                          : queuedMessages.length - 1
                      }
                      prefix={isExpanded ? "" : "+"}
                      tone={hiddenFailure ? "failed" : "neutral"}
                    />
                    <Icon
                      name="ChevronDown"
                      className={cn(
                        "size-3 shrink-0",
                        DISCLOSURE_CHEVRON_TRANSITION,
                        isExpanded && "rotate-180",
                      )}
                      aria-hidden="true"
                    />
                  </button>
                )}
              </TooltipTrigger>
              {showSummary ? null : (
                <TooltipContent side="top">{queueToggleHint}</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        ) : null}
      </header>
      <div
        className="relative min-h-0 flex-1"
        id={listId}
        data-queued-messages-scroll-frame=""
        hidden={showSummary}
        inert={showSummary || undefined}
      >
        <div
          ref={scrollRef}
          data-queued-messages-scroll=""
          className={cn(
            "h-full min-w-0 overflow-x-hidden overscroll-contain",
            isExpanded ? "overflow-y-auto" : "overflow-y-hidden",
          )}
          tabIndex={isExpanded ? 0 : -1}
        >
          <div ref={topSentinelRef} aria-hidden className="h-px w-full" />
          <DndContext
            sensors={sensors}
            collisionDetection={queuedMessageCollisionDetection}
            modifiers={[restrictToListBounds, snapGroupBoundaryToRowStroke]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={sortableIds} strategy={sortingStrategy}>
              <ul
                ref={listRef}
                className={cn("group/queue", boundaryClosesList && "pb-3")}
              >
                {queueItems}
              </ul>
            </SortableContext>
          </DndContext>
          <div ref={bottomSentinelRef} aria-hidden className="h-px w-full" />
        </div>
        {aboveOverflow && isExpanded ? (
          <OverflowFade
            placement="above"
            tone="surface-raised"
            inset
            className="z-10"
          />
        ) : null}
        {belowOverflow && isExpanded ? (
          <OverflowFade
            placement="below"
            tone="surface-raised"
            inset
            className="z-10"
          />
        ) : null}
      </div>
    </PromptStackCard>
  );
}

import { useMemo, useRef, useState, type CSSProperties } from "react";
import type {
  TimelineConversationAttachments,
  TimelineRowBase,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";
import type { GitActivity, PromptTextMention } from "@omnyo/domain";
import { fileNameFromPath } from "@omnyo/thread-view";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { usePrefersReducedMotion } from "@omnyo/shared-ui/motion";
import {
  MarkdownPreview,
  type MarkdownThreadMentions,
} from "../../ui/markdown-preview.js";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import {
  parseLocalFileHref,
  resolveRelativeLocalFileHref,
} from "@/components/ui/markdown-local-file-link.js";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import {
  computeMutedPrefixLength,
  parseAutomationDueMessage,
} from "@omnyo/client-core";
import type { TimelineTitleActionResolver } from "./TimelineTitleView.js";
import type {
  ThreadTimelineAddToChatHandler,
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
  UserAttachmentImageSrcResolver,
} from "./types.js";
import {
  ConversationAttachments,
  buildAttachmentItems,
  type ConversationAttachmentItems,
} from "./ConversationAttachments.js";
import { useSentImageAnchorHighlight } from "./sent-image-anchors";
import {
  GeneratedConversationMessage,
  generatedConversationBodySlice,
} from "./GeneratedConversationMessage.js";
import {
  clipMentionTextToVisibleRange,
  shiftMentionsToTextRange,
} from "./ConversationMessageMentions.js";
import type { MarkdownPromptMentions } from "@/components/ui/markdown-prompt-mentions.js";
import {
  useMessageDirectiveRegistry,
  type MarkdownMessageDirectives,
} from "@/components/ui/markdown-message-directives.js";
import {
  CodeFenceRendererHost,
  useCodeFenceRendererRegistry,
} from "@/components/ui/markdown-code-fence-renderers.js";
import {
  boundedMarkdownPreview,
  closeUnterminatedMarkdownCodeSpan,
  USER_MESSAGE_CHAR_CAP,
} from "@omnyo/client-core";
import { turnRequestLabel } from "@omnyo/client-core";
import {
  repairStreamingMarkdownTail,
  createStreamingMarkdownSplitter,
} from "./streaming-markdown-split.js";
import { useStreamingBlockEntrance } from "./streaming-block-entrance.js";
import { useStreamingReplyTail } from "./streaming-reply-tail.js";
import { TurnRequestLabel } from "./TurnRequestLabel.js";
import { UserMessageBubble } from "./UserMessageBubble.js";
import {
  MessageActionBar,
  MessageTimestamp,
  PROSE_COLUMN_INSET_CLASS,
} from "./MessageActionBar.js";
import {
  buildMessageActions,
  MessageTouchActions,
  NO_MESSAGE_ACTIONS,
} from "./message-actions.js";
import {
  ConversationMessageOverflowToggle,
  useIsOverflowing,
} from "./conversation-message-overflow.js";
import {
  SelectableMessageProse,
  type MessageProseSelection,
} from "./SelectableMessageProse.js";
import type { ThreadTimelinePluginMessageAction } from "./types.js";
import { TurnGitPill } from "./TurnGitPill.js";
import type { PromptDraftAttachment } from "@omnyo/client-core";
import { buildMarkdownMessageLinkRouting } from "@/components/ui/markdown-message-link-routing";

type ConversationMessageRowIdentity = Pick<
  TimelineRowBase,
  "id" | "threadId" | "turnId"
>;

interface ConversationMessageContentBaseProps extends ConversationMessageRowIdentity {
  attachments: TimelineConversationAttachments | null;
  onCopyLink?: () => void;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: MarkdownMessageDirectives["openThreadPanel"];
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  projectId?: string;
  resolveUserAttachmentImageSrc?: UserAttachmentImageSrcResolver;
  text: string;
  timestamp: number;
  workspaceRootPath?: string;
}

interface ConversationMessageContentUserProps extends ConversationMessageContentBaseProps {
  role: "user";
  initiator: TimelineUserConversationRow["initiator"];
  mentions: readonly PromptTextMention[];
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onEdit?: () => void;
  resolveMentionLink?: PromptMentionLinkResolver;
  onOpenLink?: ThreadTimelineLinkHandler;
  onTitleAction?: TimelineTitleActionResolver;
  senderThreadId: TimelineUserConversationRow["senderThreadId"];
  senderThreadProjectId?: string;
  senderThreadTitle: string | null;
  senderIsPluginSideChat: boolean;
  systemMessageKind: TimelineUserConversationRow["systemMessageKind"];
  systemMessageSubject: TimelineUserConversationRow["systemMessageSubject"];
  turnRequest: TimelineUserConversationRow["turnRequest"];
}

const COLLAPSED_MESSAGE_FADE_STYLE: CSSProperties = {
  maskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
  WebkitMaskImage:
    "linear-gradient(to bottom, black calc(100% - 2.5rem), transparent)",
};

const ASSISTANT_THREAD_MENTIONS: MarkdownThreadMentions = {
  mentions: [],
  preserveSoftBreaks: false,
};

const STREAMING_SETTLED_MARKDOWN_CLASS_NAME = "[&>p:last-child]:mb-2";

const STREAMING_TAIL_MARKDOWN_CLASS_NAME =
  "[&>h1:first-child]:mt-4 [&>h2:first-child]:mt-4 [&>h3:first-child]:mt-3 [&>h4:first-child]:mt-3 [&>h5:first-child]:mt-2 [&>h6:first-child]:mt-2";

interface ConversationMessageContentAssistantProps extends ConversationMessageContentBaseProps {
  displayText?: string;
  role: "assistant";
  onOpenLink?: ThreadTimelineLinkHandler;
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onFork?: () => void;
  forkDisabled?: boolean;
  onSelectProse?: (selection: MessageProseSelection | null) => void;
  showActions: boolean;
  showTimestamp?: boolean;
  streaming: boolean;
  turnGit: GitActivity | null;
  workspaceRootPath?: string;
}

type ConversationMessageContentProps =
  | ConversationMessageContentUserProps
  | ConversationMessageContentAssistantProps;

interface UserConversationMessageProps {
  addToChatAttachments: readonly PromptDraftAttachment[];
  attachmentItems: ConversationAttachmentItems;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  initiator: TimelineUserConversationRow["initiator"];
  mentions: readonly PromptTextMention[];
  messageDirectives?: MarkdownMessageDirectives;
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onCopyLink?: () => void;
  onEdit?: () => void;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  projectId?: string;
  resolveMentionLink?: PromptMentionLinkResolver;
  onTitleAction?: TimelineTitleActionResolver;
  senderThreadId: TimelineUserConversationRow["senderThreadId"];
  senderThreadProjectId: string | null;
  senderThreadTitle: string | null;
  senderIsPluginSideChat: boolean;
  systemMessageKind: TimelineUserConversationRow["systemMessageKind"];
  systemMessageSubject: TimelineUserConversationRow["systemMessageSubject"];
  text: string;
  timestamp: number;
  threadId: ConversationMessageRowIdentity["threadId"];
  turnRequest: TimelineUserConversationRow["turnRequest"];
  workspaceRootPath?: string;
}

interface AssistantConversationMessageProps extends ConversationMessageRowIdentity {
  displayText?: string;
  addToChatAttachments: readonly PromptDraftAttachment[];
  attachmentItems: ConversationAttachmentItems;
  messageDirectives?: MarkdownMessageDirectives;
  pluginActions?: readonly ThreadTimelinePluginMessageAction[];
  onAddToChat?: ThreadTimelineAddToChatHandler;
  onCopyLink?: () => void;
  onFork?: () => void;
  forkDisabled?: boolean;
  onSelectProse?: (selection: MessageProseSelection | null) => void;
  onOpenLink?: ThreadTimelineLinkHandler;
  onOpenLocalFileLink?: ThreadTimelineLocalFileLinkHandler;
  onOpenPluginPanel?: MarkdownMessageDirectives["openThreadPanel"];
  projectId?: string;
  showActions: boolean;
  showTimestamp?: boolean;
  streaming: boolean;
  text: string;
  timestamp: number;
  turnGit: GitActivity | null;
  workspaceRootPath?: string;
}

function useConversationMessageDirectives({
  id,
  onOpenLocalFileLink,
  onOpenPluginPanel,
  projectId,
  threadId,
  turnId,
  workspaceRootPath,
}: Pick<
  ConversationMessageContentBaseProps,
  | "id"
  | "onOpenLocalFileLink"
  | "onOpenPluginPanel"
  | "projectId"
  | "threadId"
  | "turnId"
  | "workspaceRootPath"
>): MarkdownMessageDirectives | undefined {
  const messageDirectiveRegistry = useMessageDirectiveRegistry();

  const openDirectiveWorkspaceFile = useMemo<
    MarkdownMessageDirectives["openWorkspaceFile"]
  >(() => {
    if (onOpenLocalFileLink === undefined || workspaceRootPath === undefined) {
      return null;
    }

    return (path) => {
      const href = resolveRelativeLocalFileHref({
        baseDir: workspaceRootPath,
        href: path,
        rootPath: workspaceRootPath,
      });

      if (href === null) {
        return false;
      }

      const link = parseLocalFileHref({
        absoluteLinks: { kind: "contained", rootPath: workspaceRootPath },
        href,
      });

      return link === null ? false : onOpenLocalFileLink(link);
    };
  }, [onOpenLocalFileLink, workspaceRootPath]);

  const messageDirectives = useMemo<
    MarkdownMessageDirectives | undefined
  >(() => {
    if (
      messageDirectiveRegistry === null ||
      messageDirectiveRegistry.size === 0
    ) {
      return undefined;
    }

    return {
      registry: messageDirectiveRegistry,
      message: {
        id,
        threadId,
        turnId,
        projectId: projectId ?? null,
      },
      openWorkspaceFile: openDirectiveWorkspaceFile,
      openThreadPanel: onOpenPluginPanel ?? null,
    };
  }, [
    messageDirectiveRegistry,
    id,
    threadId,
    turnId,
    projectId,
    openDirectiveWorkspaceFile,
    onOpenPluginPanel,
  ]);

  return messageDirectives;
}

interface CollapsibleMessageTextProps {
  linkRouting?: MarkdownLinkRouting;
  messageDirectives?: MarkdownMessageDirectives;
  mentions: readonly PromptTextMention[];
  resolveMentionLink?: PromptMentionLinkResolver;
  text: string;
  mutePrefixLength?: number;
}

export function CollapsibleMessageText({
  linkRouting,
  messageDirectives,
  mentions,
  resolveMentionLink,
  text,
  mutePrefixLength,
}: CollapsibleMessageTextProps) {
  const showMutedPrefix =
    typeof mutePrefixLength === "number" &&
    mutePrefixLength > 0 &&
    mutePrefixLength < text.length;

  const prefixText = showMutedPrefix ? text.slice(0, mutePrefixLength) : null;
  const bodyText = showMutedPrefix ? text.slice(mutePrefixLength) : text;
  const bodyOffset = showMutedPrefix ? mutePrefixLength : 0;

  const [isExpanded, setIsExpanded] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const exceedsCollapsedRenderCap = bodyText.length > USER_MESSAGE_CHAR_CAP;

  const collapsedPreview =
    !isExpanded && exceedsCollapsedRenderCap
      ? boundedMarkdownPreview(bodyText, USER_MESSAGE_CHAR_CAP)
      : null;

  const renderedBodyText = collapsedPreview?.text ?? bodyText;

  const body = useMemo(
    () =>
      clipMentionTextToVisibleRange({
        mentions,
        rangeStart: bodyOffset,
        text: renderedBodyText,
      }),
    [mentions, bodyOffset, renderedBodyText],
  );

  const promptMentions = useMemo<MarkdownPromptMentions>(
    () => ({
      mentions: body.mentions,
      resolveMentionLink,
    }),
    [body.mentions, resolveMentionLink],
  );

  const rawThreadMentions = useMemo<MarkdownThreadMentions>(
    () => ({
      mentions: body.mentions,
      preserveSoftBreaks: true,
    }),
    [body.mentions],
  );

  const isOverflowing = useIsOverflowing({
    elementRef: bodyRef,
    enabled: !isExpanded,
    measurementKey: body.text,
  });

  const showToggle = isExpanded || exceedsCollapsedRenderCap || isOverflowing;

  return (
    <>
      {prefixText !== null ? (
        <span
          className="line-clamp-1 text-muted-foreground"
          title={prefixText.trimEnd()}
        >
          {prefixText}
        </span>
      ) : null}
      <div
        ref={bodyRef}
        data-image-gallery-clipped={!isExpanded ? "" : undefined}
        className={cn(
          "break-words",
          !isExpanded && "max-h-[15lh] overflow-hidden",
        )}
        style={
          !isExpanded && showToggle ? COLLAPSED_MESSAGE_FADE_STYLE : undefined
        }
      >
        {collapsedPreview?.parseAsMarkdown === false ? (
          <span>{body.text}</span>
        ) : (
          <MarkdownPreview
            content={
              collapsedPreview?.wasCapped === true
                ? closeUnterminatedMarkdownCodeSpan(body.text)
                : body.text
            }
            promptMentions={promptMentions}
            threadMentions={rawThreadMentions}
            linkRouting={linkRouting}
            messageDirectives={messageDirectives}
          />
        )}
      </div>
      {showToggle ? (
        <ConversationMessageOverflowToggle
          expanded={isExpanded}
          onToggle={() => setIsExpanded((prev) => !prev)}
        />
      ) : null}
    </>
  );
}

function buildAddToChatAttachments(
  attachments: TimelineConversationAttachments | null,
): PromptDraftAttachment[] {
  if (!attachments) {
    return [];
  }

  return [
    ...attachments.localImagePaths.map((path) => ({
      type: "localImage" as const,
      path,
      name: fileNameFromPath(path),
    })),
    ...attachments.localFilePaths.map((path) => {
      const detail = attachments.localFileDetails.find(
        (file) => file.path === path,
      );

      return {
        type: "localFile" as const,
        path,
        name: detail?.name ?? fileNameFromPath(path),
        ...(detail?.sizeBytes == null ? {} : { sizeBytes: detail.sizeBytes }),
      };
    }),
  ];
}

function UserConversationMessage({
  addToChatAttachments,
  attachmentItems,
  initiator,
  mentions,
  messageDirectives,
  onAddToChat,
  onCopyLink,
  onEdit,
  onOpenLink,
  onOpenLocalFileLink,
  pluginActions = [],
  projectId,
  resolveMentionLink,
  onTitleAction,
  senderThreadId,
  senderThreadProjectId,
  senderThreadTitle,
  senderIsPluginSideChat,
  systemMessageKind,
  systemMessageSubject,
  text,
  timestamp,
  threadId,
  turnRequest,
  workspaceRootPath,
}: UserConversationMessageProps) {
  const linkRouting = useMemo(
    () =>
      buildMarkdownMessageLinkRouting({
        onOpenLink,
        onOpenLocalFileLink,
        threadId,
        workspaceRootPath,
      }),
    [onOpenLink, onOpenLocalFileLink, threadId, workspaceRootPath],
  );

  const imageAnchorHighlight = useSentImageAnchorHighlight(
    attachmentItems.imageItems.some((item) => item.anchorLabel !== null),
  );

  const automationDue =
    initiator === "user" ? parseAutomationDueMessage(text) : null;

  const generatedSource =
    senderThreadId !== null || initiator === "agent"
      ? {
          sourceKind: "agent" as const,
          sourceName: senderThreadTitle ?? senderThreadId ?? "Agent",
          sourceProjectId: senderThreadProjectId,
          sourceThreadId: senderThreadId,
          sourceIsPluginSideChat: senderIsPluginSideChat,
        }
      : initiator === "system" || systemMessageKind === "external-message"
        ? {
            sourceKind: "system" as const,
            sourceName: "Omnyo",
            sourceProjectId: null,
            sourceThreadId: null,
            sourceIsPluginSideChat: false,
          }
        : automationDue !== null
          ? {
              sourceKind: "automation" as const,
              sourceName: "Automation",
              sourceProjectId: null,
              sourceThreadId: null,
              sourceIsPluginSideChat: false,
            }
          : null;

  if (generatedSource !== null) {
    const body =
      automationDue === null
        ? generatedConversationBodySlice({ initiator, text })
        : {
            startOffset: automationDue.bodyOffset,
            text: text.slice(automationDue.bodyOffset),
          };

    const bodyMentions = shiftMentionsToTextRange({
      mentions,
      rangeStart: body.startOffset,
      rangeEnd: body.startOffset + body.text.length,
    });

    return (
      <GeneratedConversationMessage
        {...generatedSource}
        attachmentItems={attachmentItems}
        automationLink={
          automationDue === null || projectId === undefined
            ? null
            : { projectId, automationId: automationDue.automationId }
        }
        mentions={bodyMentions}
        onOpenLink={onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={resolveMentionLink}
        onTitleAction={onTitleAction}
        systemMessageKind={systemMessageKind}
        systemMessageSubject={systemMessageSubject}
        text={body.text}
        threadId={threadId}
        timestamp={timestamp}
        turnRequest={turnRequest}
        workspaceRootPath={workspaceRootPath}
      />
    );
  }

  const mutePrefixLength = computeMutedPrefixLength(initiator, text);
  const unprefixedText = text.trimStart();
  const messageText = unprefixedText.trimEnd();
  const rangeStart = text.length - unprefixedText.length;

  const addToChatMentions =
    onAddToChat && mentions.length > 0
      ? shiftMentionsToTextRange({
          mentions,
          rangeStart,
          rangeEnd: rangeStart + messageText.length,
        })
      : undefined;

  const requestLabel = turnRequestLabel(turnRequest);

  const actions = buildMessageActions({
    messageText,
    addToChatAttachments,
    addToChatMentions,
    copyImageUrl: attachmentItems.imageItems[0]?.src,
    onAddToChat,
    onCopyLink,
    onEdit,
    pluginActions,
  });

  return (
    <UserMessageBubble
      label={
        requestLabel ? (
          <TurnRequestLabel turnRequest={turnRequest} icon="ArrowTurnForward" />
        ) : null
      }
      bubbleProps={{
        ref: imageAnchorHighlight.containerRef,
        ...imageAnchorHighlight.handlers,
      }}
      actions={
        <MessageActionBar
          timestamp={timestamp}
          showTimestamp={turnRequest.status === "accepted"}
          alignment="end"
          actions={actions}
        />
      }
      touchActions={{
        actions,
        timestamp,
        canSelectText: messageText.length > 0,
      }}
    >
      {messageText ? (
        <CollapsibleMessageText
          mentions={mentions}
          messageDirectives={messageDirectives}
          resolveMentionLink={resolveMentionLink}
          linkRouting={linkRouting}
          text={text}
          mutePrefixLength={mutePrefixLength || undefined}
        />
      ) : (
        <p className="text-muted-foreground">Sent attachments</p>
      )}
      <ConversationAttachments
        align="end"
        filePaths={attachmentItems.filePaths}
        fileDetails={attachmentItems.fileDetails}
        imageItems={attachmentItems.imageItems}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
      />
    </UserMessageBubble>
  );
}

function AssistantConversationMessage({
  displayText,
  addToChatAttachments,
  attachmentItems,
  messageDirectives,
  id,
  onAddToChat,
  onCopyLink,
  onFork,
  forkDisabled,
  onSelectProse,
  onOpenLink,
  onOpenLocalFileLink,
  onOpenPluginPanel,
  pluginActions,
  projectId,
  showActions,
  showTimestamp = true,
  streaming,
  text,
  timestamp,
  threadId,
  turnId,
  turnGit,
  workspaceRootPath,
}: AssistantConversationMessageProps) {
  const [splitStreamingMarkdown] = useState(createStreamingMarkdownSplitter);
  const columnRef = useRef<HTMLDivElement>(null);
  useStreamingBlockEntrance(columnRef, streaming);

  const renderedText = displayText ?? text;

  const streamingSplit = useMemo(
    () => (streaming ? splitStreamingMarkdown(renderedText) : null),
    [splitStreamingMarkdown, streaming, renderedText],
  );

  const reducedMotion = usePrefersReducedMotion();
  const streamingWords = streaming && !reducedMotion;

  useStreamingReplyTail(
    columnRef,
    streamingWords,
    String(streamingSplit?.settled.length ?? 0),
  );

  const liveMarkdown = useMemo(() => {
    const tail = streamingSplit?.tail ?? renderedText;

    return streaming ? repairStreamingMarkdownTail(tail) : tail;
  }, [streaming, streamingSplit, renderedText]);

  const linkRouting = useMemo(
    () =>
      buildMarkdownMessageLinkRouting({
        onOpenLink,
        onOpenLocalFileLink,
        threadId,
        workspaceRootPath,
      }),
    [onOpenLink, onOpenLocalFileLink, threadId, workspaceRootPath],
  );

  const codeFenceRendererRegistry = useCodeFenceRendererRegistry();

  const codeFenceMessage = useMemo(
    () => ({ id, threadId, turnId, projectId: projectId ?? null }),
    [id, threadId, turnId, projectId],
  );

  const timestampVisible = showTimestamp && !streaming;

  const actions = showActions
    ? buildMessageActions({
        messageText: text,
        addToChatAttachments,
        copyImageUrl: attachmentItems.imageItems[0]?.src,
        onAddToChat,
        onCopyLink,
        onFork,
        forkDisabled,
        pluginActions,
      })
    : NO_MESSAGE_ACTIONS;

  const gitPill =
    turnGit && !streaming ? (
      <TurnGitPill activity={turnGit} onOpenLink={onOpenLink} />
    ) : null;

  const markdown = (
    <>
      <MarkdownPreview
        allowHtml
        className={
          streamingSplit === null
            ? undefined
            : STREAMING_SETTLED_MARKDOWN_CLASS_NAME
        }
        content={
          streamingSplit === null ? liveMarkdown : streamingSplit.settled
        }
        incrementalBlocks
        streamingTail={streaming && streamingSplit === null}
        streamingTailOwner={`${threadId}:${id}:${turnId ?? ""}`}
        streamingWords={streamingWords && streamingSplit === null}
        linkRouting={linkRouting}
        messageDirectives={messageDirectives}
        threadMentions={ASSISTANT_THREAD_MENTIONS}
      />
      {streamingSplit === null ? null : (
        <MarkdownPreview
          allowHtml
          className={STREAMING_TAIL_MARKDOWN_CLASS_NAME}
          content={liveMarkdown}
          sourcePrefix={streamingSplit.settled}
          incrementalBlocks
          streamingTail={streaming}
          streamingTailOwner={`${threadId}:${id}:${turnId ?? ""}`}
          streamingWords={streamingWords}
          linkRouting={linkRouting}
          messageDirectives={messageDirectives}
          threadMentions={ASSISTANT_THREAD_MENTIONS}
        />
      )}
    </>
  );

  return (
    <MessageTouchActions
      actions={actions}
      timestamp={timestamp}
      canSelectText={text.length > 0}
    >
      <div
        ref={columnRef}
        className={cn(
          "group/message w-full text-sm font-normal leading-relaxed",
          PROSE_COLUMN_INSET_CLASS,
        )}
        data-message-column=""
      >
        <SelectableMessageProse onSelect={onSelectProse}>
          {codeFenceRendererRegistry === null ? (
            markdown
          ) : (
            <CodeFenceRendererHost
              registry={codeFenceRendererRegistry}
              message={codeFenceMessage}
              openThreadPanel={onOpenPluginPanel ?? null}
              streaming={streaming}
            >
              {markdown}
            </CodeFenceRendererHost>
          )}
        </SelectableMessageProse>
        <ConversationAttachments
          filePaths={attachmentItems.filePaths}
          fileDetails={attachmentItems.fileDetails}
          imageItems={attachmentItems.imageItems}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
        />
        {showActions ? (
          <MessageActionBar
            timestamp={timestamp}
            showTimestamp={timestampVisible}
            timestampAccessory={gitPill}
            alignment="start"
            actions={actions}
          />
        ) : gitPill ? (
          <div className="mt-1 flex items-center gap-2">
            {timestampVisible ? (
              <MessageTimestamp timestamp={timestamp} />
            ) : null}
            {gitPill}
          </div>
        ) : timestampVisible ? (
          <div className="mt-1">
            <MessageTimestamp timestamp={timestamp} />
          </div>
        ) : null}
      </div>
    </MessageTouchActions>
  );
}

const NO_MENTIONS: readonly PromptTextMention[] = [];

export function ConversationMessageContent(
  props: ConversationMessageContentProps,
) {
  const {
    attachments,
    onOpenLocalFileLink,
    onOpenPluginPanel,
    projectId,
    resolveUserAttachmentImageSrc,
    text,
  } = props;

  const messageDirectives = useConversationMessageDirectives(props);

  const mentions = props.role === "user" ? props.mentions : NO_MENTIONS;

  const attachmentItems = useMemo(
    () =>
      buildAttachmentItems({
        attachments,
        projectId,
        resolveUserAttachmentImageSrc,
        text,
        mentions,
      }),
    [attachments, projectId, resolveUserAttachmentImageSrc, text, mentions],
  );

  const addToChatAttachments = useMemo(
    () => buildAddToChatAttachments(attachments),
    [attachments],
  );

  if (props.role === "user") {
    return (
      <UserConversationMessage
        addToChatAttachments={addToChatAttachments}
        attachmentItems={attachmentItems}
        messageDirectives={messageDirectives}
        pluginActions={props.pluginActions}
        initiator={props.initiator}
        mentions={props.mentions}
        onAddToChat={props.onAddToChat}
        onCopyLink={props.onCopyLink}
        onEdit={props.onEdit}
        onOpenLink={props.onOpenLink}
        onOpenLocalFileLink={onOpenLocalFileLink}
        projectId={projectId}
        resolveMentionLink={props.resolveMentionLink}
        onTitleAction={props.onTitleAction}
        senderThreadId={props.senderThreadId}
        senderThreadProjectId={props.senderThreadProjectId ?? null}
        senderThreadTitle={props.senderThreadTitle}
        senderIsPluginSideChat={props.senderIsPluginSideChat}
        systemMessageKind={props.systemMessageKind}
        systemMessageSubject={props.systemMessageSubject}
        text={text}
        timestamp={props.timestamp}
        threadId={props.threadId}
        turnRequest={props.turnRequest}
        workspaceRootPath={props.workspaceRootPath}
      />
    );
  }

  return (
    <AssistantConversationMessage
      displayText={props.displayText}
      addToChatAttachments={addToChatAttachments}
      attachmentItems={attachmentItems}
      messageDirectives={messageDirectives}
      id={props.id}
      pluginActions={props.pluginActions}
      onAddToChat={props.onAddToChat}
      onCopyLink={props.onCopyLink}
      onFork={props.onFork}
      forkDisabled={props.forkDisabled}
      onSelectProse={props.onSelectProse}
      onOpenLink={props.onOpenLink}
      onOpenLocalFileLink={onOpenLocalFileLink}
      onOpenPluginPanel={onOpenPluginPanel}
      projectId={projectId}
      showActions={props.showActions}
      showTimestamp={props.showTimestamp}
      streaming={props.streaming}
      text={text}
      timestamp={props.timestamp}
      threadId={props.threadId}
      turnId={props.turnId}
      turnGit={props.turnGit}
      workspaceRootPath={props.workspaceRootPath}
    />
  );
}

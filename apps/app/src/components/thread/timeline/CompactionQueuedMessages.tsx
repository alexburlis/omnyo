import { createContext, useContext, useMemo, type ReactNode } from "react";
import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { promptInputToDraft } from "@omnyo/client-core";
import type { PromptMentionLinkResolver } from "@/components/promptbox/editor/prompt-mention-link";
import { useThreadQueuedMessages } from "@/hooks/queries/thread-queries";
import { selectQueuedMessagesAwaitingCompaction } from "@/lib/compaction-queued-messages";
import { CollapsibleMessageText } from "./ConversationMessageContent.js";
import {
  MESSAGE_ACTION_SLOT_HEIGHT_CLASS,
  UserMessageBubble,
} from "./UserMessageBubble.js";

const NO_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

const CompactionQueuedMessagesContext =
  createContext<readonly ThreadQueuedMessage[]>(NO_QUEUED_MESSAGES);

export function useQueuedMessagesAwaitingCompaction(): readonly ThreadQueuedMessage[] {
  return useContext(CompactionQueuedMessagesContext);
}

export function CompactionQueuedMessagesProvider({
  children,
  runtimeStatus,
  threadId,
  timelineRows,
}: {
  children: ReactNode;
  runtimeStatus: ThreadRuntimeDisplayStatus | undefined;
  threadId: string;
  timelineRows: readonly TimelineRow[];
}) {
  const { data: queuedMessages } = useThreadQueuedMessages(threadId);

  const awaiting = useMemo(
    () =>
      selectQueuedMessagesAwaitingCompaction({
        queuedMessages: queuedMessages ?? NO_QUEUED_MESSAGES,
        runtimeStatus,
        timelineRows,
      }),
    [queuedMessages, runtimeStatus, timelineRows],
  );

  return (
    <CompactionQueuedMessagesContext.Provider value={awaiting}>
      {children}
    </CompactionQueuedMessagesContext.Provider>
  );
}

function CompactionQueuedMessageBubble({
  message,
  resolveMentionLink,
}: {
  message: ThreadQueuedMessage;
  resolveMentionLink: PromptMentionLinkResolver | undefined;
}) {
  const draft = useMemo(
    () =>
      promptInputToDraft(
        message.content.filter((chunk) => chunk.visibility !== "agent-only"),
      ),
    [message.content],
  );

  return (
    <div className="mt-11" data-compaction-queued-message={message.id}>
      <UserMessageBubble
        label={null}
        actions={
          <div
            className={cn(
              "flex items-center justify-end gap-1 pr-[13px] text-2xs text-subtle-foreground max-md:pointer-coarse:pr-[11px]",
              MESSAGE_ACTION_SLOT_HEIGHT_CLASS,
            )}
          >
            <Icon name="CircleArrowShrink" className="size-3 shrink-0" />
            <span className="animate-shine whitespace-nowrap">
              Sends after compaction
            </span>
          </div>
        }
      >
        {draft.text.trim().length > 0 ? (
          <CollapsibleMessageText
            mentions={draft.mentions}
            resolveMentionLink={resolveMentionLink}
            text={draft.text}
          />
        ) : (
          <p className="text-muted-foreground">Sent attachments</p>
        )}
      </UserMessageBubble>
    </div>
  );
}

export function CompactionQueuedMessages({
  messages,
  resolveMentionLink,
}: {
  messages: readonly ThreadQueuedMessage[];
  resolveMentionLink: PromptMentionLinkResolver | undefined;
}) {
  return messages.map((message) => (
    <CompactionQueuedMessageBubble
      key={message.id}
      message={message}
      resolveMentionLink={resolveMentionLink}
    />
  ));
}

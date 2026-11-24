import { useWaitingToSendEntries } from "@/components/promptbox/banner/WaitingToSendCard";
import {
  useLayoutEffect,
  useRef,
  type FocusEvent,
  type RefObject,
} from "react";
import { usePageTitleBarSlots } from "@/components/layout/page-title-bar-chrome";
import { NewThreadComposer } from "@/components/promptbox/NewThreadComposer";
import type { PromptBoxHandle } from "@/components/promptbox/PromptBoxInternal";
import {
  TimelineStatusIndicator,
  TimelineWorkingStatus,
} from "@/components/thread/timeline/TimelineStatusIndicator";
import { UserMessageBubble } from "@/components/thread/timeline/UserMessageBubble";
import { ConversationTimeline } from "@/components/ui/conversation";
import {
  PageShell,
  THREAD_TIMELINE_SHELL_PROPS,
  threadPageFrameClassName,
} from "@/components/ui/page-shell";
import { CHROME_ROW_HEIGHT_CLASS } from "@/lib/omnyo-desktop";
import {
  submitPendingChatMessage,
  usePendingChat,
  type PendingChatMessage,
} from "@/lib/pending-chat-creations";
import { takeTypeAhead } from "@/lib/typed-ahead";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { arriveFromHomeSend } from "@/views/home-orientation/home-send-transition";
import { usePaneContext } from "./PaneContext";

const START_FAILED_MESSAGE =
  "The chat could not start. Your messages were kept.";

function insertTypeAheadOnEditorFocus(
  event: FocusEvent<HTMLElement>,
  promptBoxRef: RefObject<PromptBoxHandle | null>,
) {
  if (
    !(event.target instanceof HTMLElement) ||
    event.target.getAttribute("contenteditable") !== "true"
  ) {
    return;
  }

  const text = takeTypeAhead();

  if (text !== "") promptBoxRef.current?.insertTypedText(text);
}

export function PendingThreadChat({ pendingId }: { pendingId: string }) {
  const pending = usePendingChat(pendingId);

  const waitingToSend = useWaitingToSendEntries(pendingId).some(
    (entry) => entry.state.kind === "waiting",
  );

  const { isBoundedPane } = usePaneContext();
  const promptBoxRef = useRef<PromptBoxHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const reservesHeaderRow = usePageTitleBarSlots() === null;
  const request = pending?.request;

  useLayoutEffect(() => {
    arriveFromHomeSend(
      pendingId,
      rootRef.current?.querySelector<HTMLElement>("[data-promptbox-shell]") ??
        null,
    );
  }, [pendingId]);

  if (!pending || !request) return null;

  return (
    <div
      ref={rootRef}
      data-pending-thread-chat=""
      className={threadPageFrameClassName(isBoundedPane)}
      onFocus={(event) => insertTypeAheadOnEditorFocus(event, promptBoxRef)}
    >
      {reservesHeaderRow ? (
        <div aria-hidden className={cn(CHROME_ROW_HEIGHT_CLASS, "shrink-0")} />
      ) : null}
      <PageShell
        {...THREAD_TIMELINE_SHELL_PROPS}
        scrollBehavior="bottom-anchor"
        animateFollowLatest
        footer={
          <NewThreadComposer
            projectId={request.projectId}
            onProjectChange={() => {}}
            draftStorage={{
              kind: "thread",
              projectId: request.projectId,
              threadId: pendingId,
            }}
            selectionScope="component-local"
            resetKey={pendingId}
            seed={{
              providerId: request.providerId,
              model: request.model,
              reasoningLevel: request.reasoningLevel,
              serviceTier: request.serviceTier,
              permissionMode: request.permissionMode,
              environment: request.environment,
            }}
            onSubmit={(message) => submitPendingChatMessage(pendingId, message)}
          >
            {(composer) =>
              composer.renderPromptBox({
                mentionMenuPlacement: "top",
                placeholder: "Send another message…",
                autoFocus: true,
                promptBoxRef,
                locks: {
                  project: true,
                  environment: true,
                  provider: true,
                  execution: true,
                },
                ...(pending.status === "failed"
                  ? { blockedReason: START_FAILED_MESSAGE }
                  : {}),
              })
            }
          </NewThreadComposer>
        }
      >
        <ConversationTimeline className="flex-1">
          <div className="flex min-w-0 flex-col gap-2">
            {pending.messages.map((message) => (
              <PendingUserMessage key={message.id} message={message} />
            ))}
          </div>
          <div role="status">
            {pending.status === "failed" ? (
              <TimelineStatusIndicator
                label={START_FAILED_MESSAGE}
                className="mt-4 text-destructive"
              />
            ) : (
              <TimelineWorkingStatus
                label={waitingToSend ? "Waiting to send" : "Starting..."}
              />
            )}
          </div>
        </ConversationTimeline>
      </PageShell>
    </div>
  );
}

function PendingUserMessage({ message }: { message: PendingChatMessage }) {
  const text = message.input
    .flatMap((input) => (input.type === "text" ? [input.text.trim()] : []))
    .filter((part) => part.length > 0)
    .join("\n\n");

  return (
    <UserMessageBubble label={null} actions={null}>
      {text ? (
        <div className="max-h-[15lh] overflow-hidden whitespace-pre-wrap break-words">
          {text}
        </div>
      ) : null}
      {message.hasAttachments ? (
        <p className="text-muted-foreground">Attached files</p>
      ) : null}
    </UserMessageBubble>
  );
}

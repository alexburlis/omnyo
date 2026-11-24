import { useState } from "react";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { SIDEBAR_WORKING_STATUS_COLOR_CLASS } from "@omnyo/shared-ui/sidebar-row-classes";
import {
  usePendingChats,
  type PendingChatSnapshot,
} from "@/lib/pending-chat-creations";
import { usePaneContext } from "./thread-detail/PaneContext";

export function isStartingPendingChat(chat: PendingChatSnapshot): boolean {
  return chat.status === "creating" && chat.realThreadId === null;
}

function readPromptPreview(chat: PendingChatSnapshot): string {
  return (chat.request?.input ?? [])
    .flatMap((input) => (input.type === "text" ? [input.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export function RootComposeStartingChats({ projectId }: { projectId: string }) {
  const pending = usePendingChats();
  const { navigateInPane } = usePaneContext();

  const chats = pending.filter(
    (chat) => chat.projectId === projectId && isStartingPendingChat(chat),
  );

  const [initialChats, setInitialChats] = useState(() => ({
    projectId,
    ids: new Set(chats.map((chat) => chat.id)),
  }));

  if (initialChats.projectId !== projectId) {
    setInitialChats({ projectId, ids: new Set(chats.map((chat) => chat.id)) });
  }

  const mountedChatIds = initialChats.ids;

  if (chats.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-1 pb-3"
      aria-label="Starting chats"
      role="status"
    >
      {chats.map((chat) => {
        const preview = readPromptPreview(chat);

        return (
          <button
            type="button"
            key={chat.id}
            onClick={() => navigateInPane({ projectId, threadId: chat.id })}
            className={cn(
              "flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left text-sm hover:bg-state-hover",
              !mountedChatIds.has(chat.id) && "omnyo-queue-row-enter",
            )}
          >
            <Icon
              name="Loading"
              aria-hidden="true"
              className={cn(
                "size-3.5 shrink-0 animate-spin",
                SIDEBAR_WORKING_STATUS_COLOR_CLASS,
              )}
            />
            <span className="shrink-0 text-muted-foreground">
              Starting chat…
            </span>
            {preview.length > 0 ? (
              <span className="min-w-0 truncate">{preview}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

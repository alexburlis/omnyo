import { ActionHistoryProvider } from "@/components/layout/ActionHistoryProvider";
import type { ReactNode } from "react";
import { Button } from "@omnyo/shared-ui/button";
import { Icon } from "@omnyo/shared-ui/icon";
import { cn } from "@omnyo/shared-ui/lib/utils";
import { makeThreadListEntry } from "../../../.ladle/story-fixtures";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import type { ThreadListEntry } from "@omnyo/domain";
import { threadListEntryActionTarget } from "@/lib/thread-actions/thread-action-target";
import { ThreadActionsProvider } from "./ThreadActionsProvider";
import { ThreadActionsMenu } from "./ThreadActionsMenu";

export default {
  title: "thread/Thread actions menu",
};

function Stage({ children }: { children: ReactNode }) {
  return (
    <ActionHistoryProvider>
      <ThreadActionsProvider>
        <div className="flex w-fit items-center rounded-md bg-sidebar p-2 text-sidebar-foreground">
          {children}
        </div>
      </ThreadActionsProvider>
    </ActionHistoryProvider>
  );
}

function Menu({ thread }: { thread: ThreadListEntry }) {
  return (
    <ThreadActionsMenu
      thread={threadListEntryActionTarget(thread)}
      trigger={(props) => (
        <Button
          {...props}
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            props.className,
            "rounded-md p-0 data-[state=open]:bg-state-active data-[state=open]:text-foreground",
          )}
          aria-label="Thread actions"
        >
          <Icon name="MoreHorizontal" />
        </Button>
      )}
    />
  );
}

export function Overview() {
  const readThread = makeThreadListEntry({
    id: "thr_read",
    lastReadAt: 200,
    latestAttentionAt: 100,
  });

  const unreadPinnedThread = makeThreadListEntry({
    id: "thr_unread",
    lastReadAt: 100,
    latestAttentionAt: 200,
    pinnedAt: 150,
  });

  const archivedThread = makeThreadListEntry({
    id: "thr_archived",
    archivedAt: 150,
  });

  return (
    <StoryCard>
      <StoryRow
        label="read · unpinned"
        hint="Mark unread · Pin — Rename — Archive · Delete"
      >
        <Stage>
          <Menu thread={readThread} />
        </Stage>
      </StoryRow>
      <StoryRow
        label="unread · pinned"
        hint="read toggle flips to Mark read; Pin flips to Unpin"
      >
        <Stage>
          <Menu thread={unreadPinnedThread} />
        </Stage>
      </StoryRow>
      <StoryRow label="archived" hint="Archive flips to Unarchive">
        <Stage>
          <Menu thread={archivedThread} />
        </Stage>
      </StoryRow>
    </StoryCard>
  );
}

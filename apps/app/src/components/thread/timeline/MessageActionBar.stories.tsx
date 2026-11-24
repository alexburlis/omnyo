import type { ReactNode } from "react";
import { MessageActionBar } from "@/components/thread/timeline/MessageActionBar";
import { buildMessageActions } from "@/components/thread/timeline/message-actions";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";

export default {
  title: "thread/timeline/Message Action Bar",
};

const noop = () => undefined;

const STORY_TIMESTAMP = Date.UTC(2026, 8, 30, 16, 5);

function HoverRevealStage({ children }: { children: ReactNode }) {
  return (
    <div className="group/message w-full max-w-md [&_button]:opacity-100">
      {children}
    </div>
  );
}

function LiveHoverStage({ children }: { children: ReactNode }) {
  return (
    <div className="group/message w-full max-w-md rounded-md border border-border-hairline px-3 pt-2 pb-1">
      <p className="pb-1 text-sm text-foreground">
        Hover this message to reveal its actions.
      </p>
      {children}
    </div>
  );
}

export function Overview() {
  return (
    <>
      <StoryCard>
        <StoryRow label="main timeline" hint="Copy + Fork">
          <HoverRevealStage>
            <MessageActionBar
              timestamp={STORY_TIMESTAMP}
              alignment="end"
              actions={buildMessageActions({
                messageText: "An agent message you can fork or reply to.",
                onFork: noop,
              })}
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow label="user message" hint="Copy + Add to chat">
          <HoverRevealStage>
            <MessageActionBar
              timestamp={STORY_TIMESTAMP}
              alignment="end"
              actions={buildMessageActions({
                messageText: "A user message you can quote into the composer.",
                onAddToChat: noop,
              })}
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow label="disabled" hint="thread not forkable → greyed">
          <HoverRevealStage>
            <MessageActionBar
              timestamp={STORY_TIMESTAMP}
              alignment="end"
              actions={buildMessageActions({
                messageText: "Fork/Reply greyed when the thread can't fork.",
                onFork: noop,
                forkDisabled: true,
              })}
            />
          </HoverRevealStage>
        </StoryRow>
        <StoryRow
          label="hover reveal"
          hint="Actions fade in over the fast duration; icons tint on hover"
        >
          <LiveHoverStage>
            <MessageActionBar
              timestamp={STORY_TIMESTAMP}
              alignment="start"
              actions={buildMessageActions({
                messageText: "Hover this message to reveal its actions.",
                onFork: noop,
                onAddToChat: noop,
              })}
            />
          </LiveHoverStage>
        </StoryRow>
      </StoryCard>
    </>
  );
}

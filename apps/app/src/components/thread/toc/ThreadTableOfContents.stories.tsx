import type {
  TimelineConversationAttachments,
  TimelineRow,
} from "@omnyo/server-contract";
import { ThreadTimelineSurface } from "@/components/thread/timeline/ThreadTimelineSurface";
import { ThreadTableOfContents } from "@/components/thread/toc/ThreadTableOfContents";
import { BottomAnchoredScrollBody } from "@/components/ui/bottom-anchored-scroll-body";

export default {
  title: "thread/Table of Contents",
};

const now = 1_800_000_000_000;

function conversationRow({
  attachments = null,
  id,
  role,
  text,
  index,
}: {
  attachments?: TimelineConversationAttachments | null;
  id: string;
  role: "user" | "assistant";
  text: string;
  index: number;
}): TimelineRow {
  const base = {
    id,
    threadId: "thr_toc_story",
    turnId: `turn_${Math.floor(index / 2)}`,
    sourceSeqStart: index + 1,
    sourceSeqEnd: index + 1,
    messageSeq: index + 1,
    startedAt: now + index * 1_000,
    createdAt: now + index * 1_000,
    kind: "conversation" as const,
    text,
    attachments,
  };

  if (role === "user") {
    return {
      ...base,
      role: "user",
      initiator: "user",
      senderThreadId: null,
      systemMessageKind: "unlabeled",
      systemMessageSubject: null,
      turnRequest: {
        clientRequestId: null,
        isGrouped: false,
        kind: "message",
        status: "accepted",
      },
      mentions: [],
    };
  }

  return {
    ...base,
    role: "assistant",
    turnRequest: null,
    turnGit: null,
  };
}

const timelineRows: TimelineRow[] = Array.from(
  { length: 18 },
  (_, turnIndex) => [
    conversationRow({
      id: `row_user_${turnIndex + 1}`,
      role: "user",
      index: turnIndex * 2,
      text:
        turnIndex === 2
          ? ""
          : `User checkpoint ${turnIndex + 1}: review the chat position markers, message excerpts, and direct jumps for this section. The excerpt should stay beside its marker while the full message remains in the conversation.`,
      attachments:
        turnIndex === 2
          ? {
              webImages: 1,
              localImages: 0,
              localFiles: 0,
              imageUrls: ["/icon-192.png"],
              localImagePaths: [],
              localFilePaths: [],
              localFileDetails: [],
            }
          : null,
    }),
    conversationRow({
      id: `row_agent_${turnIndex + 1}`,
      role: "assistant",
      index: turnIndex * 2 + 1,
      text:
        turnIndex === 4
          ? Array.from(
              { length: 16 },
              (_, paragraph) =>
                `Response detail ${paragraph + 1}. The current marker stays on this message while you scroll through a long answer. Hover or focus another marker to read its excerpt, then select it to return to that part of the conversation.`,
            ).join("\n\n")
          : `Agent response ${turnIndex + 1}: the current marker follows the conversation as you scroll. Select a marker to jump to its message, or open the full outline for both your messages and agent replies.`,
    }),
  ],
).flat();

export function Default() {
  return (
    <div className="flex h-[640px] max-h-[calc(100dvh-2rem)] min-h-0 overflow-hidden rounded-lg border border-border bg-background">
      <BottomAnchoredScrollBody
        footer={null}
        maxWidthClassName="max-w-3xl"
        contentClassName="gap-2 pt-4"
        scrollOverlay={
          <ThreadTableOfContents
            contextBoundarySeq={null}
            threadId="thr_toc_story"
            timelineRows={timelineRows}
            hasOlderTimelineRows={false}
            loadOlderTimelineRows={() => {}}
          />
        }
      >
        <ThreadTimelineSurface
          activeThinking={null}
          contextBoundarySeq={null}
          isThreadTimelinePending={false}
          timelineError={false}
          showOngoingIndicator={false}
          timelineRows={timelineRows}
          threadId="thr_toc_story"
          threadRuntimeDisplayStatus="idle"
          workspaceRootPath={undefined}
        />
      </BottomAnchoredScrollBody>
    </div>
  );
}

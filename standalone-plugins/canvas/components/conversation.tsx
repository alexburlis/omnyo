import { nodeMentionItem } from "../contract";
import { ThreadChat } from "@omnyo/plugin-sdk/app";

export function CanvasConversation({ threadId, regionId }: { threadId: string; regionId: string }) {
  return (
    <section className="cnv-conversation" aria-label="Canvas conversation">
      <ThreadChat
        threadId={threadId}
        variant="compact"
        layout="document"
        experimental_conversation={{
          id: regionId,
          mention: {
            provider: "conversation",
            id: nodeMentionItem(threadId, regionId),
            label: "Canvas conversation",
          },
        }}
      />
    </section>
  );
}

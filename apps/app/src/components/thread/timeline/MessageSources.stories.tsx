import { useState } from "react";
import type { SystemMessageSubject } from "@omnyo/domain";
import type { TimelineConversationRow } from "@omnyo/server-contract";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { ConversationMessageContent } from "./ConversationMessageContent";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

export default { title: "thread/timeline/Message sources" };

const sentAt = Date.now() - 5 * 60_000;

const sources: readonly {
  id: string;
  subject: SystemMessageSubject;
  text: string;
}[] = [
  {
    id: "script",
    subject: {
      kind: "message-source",
      source: { kind: "script", label: "Release runner" },
    },
    text: "The release verification finished.",
  },
  {
    id: "plugin",
    subject: {
      kind: "message-source",
      source: { kind: "plugin", pluginId: "resources" },
    },
    text: "The requested job completed.",
  },
];

export function SourcesAndTimestamps() {
  const [working, setWorking] = useState(true);
  const [finishedAt, setFinishedAt] = useState(Date.now());

  const response: Extract<TimelineConversationRow, { role: "assistant" }> = {
    ...conversationRow({
      id: "source_timestamp_response",
      role: "assistant",
      text: working ? "I am checking the result." : "The result is verified.",
      turnId: "source_timestamp_turn",
      startedAt: sentAt,
      createdAt: finishedAt,
    }),
    role: "assistant",
    turnRequest: null,
    turnGit: null,
    status: working ? "streaming" : "completed",
  };

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 p-5">
      <button
        type="button"
        className="self-start rounded-md bg-secondary px-3 py-2 text-sm text-secondary-foreground"
        onClick={() => {
          setFinishedAt(Date.now());
          setWorking(!working);
        }}
      >
        {working ? "Finish response" : "Start response"}
      </button>
      <div className="flex flex-col gap-3" aria-label="Generated messages">
        <ConversationMessageContent
          role="user"
          id="message_source_1"
          threadId="thr_message_sources"
          turnId={null}
          initiator="agent"
          senderThreadId="thr_verification_source"
          senderThreadTitle="Worker checks"
          senderIsPluginSideChat={false}
          systemMessageKind="unlabeled"
          systemMessageSubject={null}
          text="The worker checks passed."
          timestamp={sentAt}
          attachments={null}
          mentions={[]}
          projectId="proj_demo"
          turnRequest={{
            clientRequestId: null,
            isGrouped: false,
            kind: "steer",
            status: "accepted",
          }}
        />
        {sources.map((source) => (
          <ConversationMessageContent
            key={source.id}
            role="user"
            id={source.id}
            threadId="thr_message_sources"
            turnId={null}
            initiator="user"
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            systemMessageKind="external-message"
            systemMessageSubject={source.subject}
            text={source.text}
            timestamp={sentAt}
            attachments={null}
            mentions={[]}
            projectId="proj_demo"
            turnRequest={{
              clientRequestId: null,
              isGrouped: false,
              kind: "message",
              status: "accepted",
            }}
          />
        ))}
      </div>
      <section aria-label="Assistant response">
        <ThreadTimelineRows
          timelineRows={[response]}
          threadRuntimeDisplayStatus={working ? "active" : "idle"}
          workspaceRootPath={undefined}
        />
      </section>
    </div>
  );
}

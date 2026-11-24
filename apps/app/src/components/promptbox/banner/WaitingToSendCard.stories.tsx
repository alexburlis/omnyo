import type { OutboxEntry } from "@/lib/send-outbox/send-outbox-entry";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { FauxComposer, ResponsiveStage } from "./banner-story-stages";
import { WaitingToSendCard } from "./WaitingToSendCard";

export default {
  title: "promptbox/banner/Waiting To Send",
};

function entry(
  submissionId: string,
  text: string,
  state: OutboxEntry["state"],
  files = 0,
): OutboxEntry {
  return {
    schema: 1,
    submissionId,
    storeId: "store-story",
    sequence: 1,
    createdAt: 1,
    action: {
      kind: "thread-message",
      projectId: "proj-story",
      target: { threadId: "thr-story" },
      message: {
        input: [
          { type: "text", text, mentions: [] },
          ...Array.from({ length: files }, (_, index) => ({
            type: "localFile" as const,
            path: `omnyo-outbox-attachment:${index}`,
            name: `file-${index}.txt`,
          })),
        ],
      },
    },
    attachments: [],
    state,
  };
}

const waiting = entry(
  "sub_00000000000000000000000000000001",
  "Fix the flaky timeline test and push the branch.",
  { kind: "waiting" },
  2,
);

const notSent = entry(
  "sub_00000000000000000000000000000002",
  "Summarise the changes for the release notes.",
  {
    kind: "paused",
    code: "thread_not_found",
    message: "This chat no longer exists on the server.",
  },
);

function Stack({ entries }: { entries: OutboxEntry[] }) {
  return (
    <div className="flex flex-col">
      <WaitingToSendCard entries={entries} />
      <FauxComposer />
    </div>
  );
}

export function States() {
  return (
    <StoryCard labelWidth="230px">
      <StoryRow
        label="waiting"
        hint="sending retries on its own; a spinner and a plain reason, no buttons that could send it twice"
      >
        <ResponsiveStage>
          <Stack entries={[waiting]} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="not sent"
        hint="the reason sits beside a red Not sent label; Try again is the soft row action and Discard stays secondary"
      >
        <ResponsiveStage>
          <Stack entries={[notSent]} />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="mixed"
        hint="several messages stack with hairline dividers"
      >
        <ResponsiveStage>
          <Stack entries={[waiting, notSent]} />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}

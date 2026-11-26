import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  inboxEntrySchema,
  type InboxEntry,
  type InboxSnapshot,
  type InboxWaitView,
} from "@omnyo/domain";
import { INBOX_SNAPSHOT_QUERY_KEY } from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import { ThreadInboxReason } from "./ThreadInboxReason";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "thread/Waits list",
};

const THREAD_ID = "thr_story_waits";

const GENERATED_AT = 1_780_000_000_000;

const MINUTE = 60_000;

function entry(overrides: Partial<InboxEntry>): InboxEntry {
  return inboxEntrySchema.parse({
    threadId: THREAD_ID,
    projectId: "project",
    title: "Release closeout",
    automationId: null,
    shelved: false,
    view: "waiting",
    card: null,
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: 0,
    latch: "latch",
    state: "waiting",
    reason: { kind: "wait", text: "Waiting", threadId: THREAD_ID },
    recap: null,
    archiveReady: false,
    optionalQuestion: null,
    pendingResults: 0,
    ...overrides,
  });
}

function wait(
  overrides: Partial<InboxWaitView> & Pick<InboxWaitView, "id" | "forText">,
): InboxWaitView {
  return {
    key: overrides.id,
    generation: 1,
    kind: "chat",
    status: "live",
    marker: "[wait]",
    deadline: null,
    nextCheckAt: null,
    checkCount: 0,
    createdBy: "agent",
    ownerAccepted: true,
    conditions: [],
    ...overrides,
  };
}

function seededClient(
  inboxEntry: InboxEntry,
  waits: readonly InboxWaitView[],
  waitingChatIds: readonly string[] = [],
): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });

  const snapshot: InboxSnapshot = {
    revision: "story",
    generatedAt: GENERATED_AT,
    inbox: inboxEntry.state === "needs-you" ? [inboxEntry] : [],
    waiting: inboxEntry.state === "waiting" ? [inboxEntry] : [],
    running: inboxEntry.state === "working" ? [inboxEntry] : [],
    shelf: [],
    counts: {
      inbox: 0,
      questions: 0,
      needsYou: 0,
      running: 0,
      waiting: 1,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };

  const future = { updatedAt: Date.now() + 365 * 24 * 60 * MINUTE };

  client.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, snapshot, future);
  client.setQueryData(
    ["inbox", "chat-waits", THREAD_ID, GENERATED_AT],
    { waits: [...waits], waitingChatIds: [...waitingChatIds] },
    future,
  );

  return client;
}

function Scenario({
  inboxEntry,
  waits,
  waitingChatIds,
}: {
  inboxEntry: InboxEntry;
  waits: readonly InboxWaitView[];
  waitingChatIds?: readonly string[];
}): ReactNode {
  const [client] = useState(() =>
    seededClient(inboxEntry, waits, waitingChatIds),
  );

  return (
    <QueryClientProvider client={client}>
      <div className="w-full max-w-[720px] rounded-xl bg-background">
        <ThreadInboxReason threadId={THREAD_ID} parentThreadId={null} />
      </div>
    </QueryClientProvider>
  );
}

const now = Date.now();

const releaseWaits: InboxWaitView[] = [
  wait({
    id: "release",
    forText: "Chief release version and updater offer",
    conditions: [
      {
        key: "chat:thr_story_release",
        kind: "chat",
        label: "Release 1.4.2 and updater offer",
        met: false,
      },
    ],
  }),
  wait({
    id: "distill",
    kind: "check",
    forText:
      "Loop: Run omnyo chief distill, then summarize any new Rule? proposals",
    nextCheckAt: now + 40 * MINUTE,
    checkCount: 3,
    conditions: [
      {
        key: "check",
        kind: "check",
        label: "omnyo chief distill",
        met: false,
      },
    ],
  }),
  wait({
    id: "apple",
    kind: "report",
    forText: "Apple’s review response for build 212",
    conditions: [
      {
        key: "report",
        kind: "report",
        label: "Apple’s review response for build 212",
        met: false,
      },
    ],
  }),
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="Waiting on several things"
        hint="A chat, a recurring check and something only the owner can confirm. Each row names what it waits for, its kind and when it checks again."
      >
        <Scenario
          inboxEntry={entry({
            reason: {
              kind: "wait",
              text: "Chief release version and updater offer",
              threadId: THREAD_ID,
            },
            waiting: {
              group: "comes-back",
              kind: "check",
              reason: "Chief release version and updater offer",
              waitId: "release",
              returnAt: now + 3 * 60 * MINUTE,
              checkAt: now + 40 * MINUTE,
              checkCount: 3,
              checking: false,
              guaranteed: true,
              behind: "Release 1.4.2 and updater offer",
              retry: null,
              questionId: null,
            },
          })}
          waits={releaseWaits}
        />
      </StoryRow>
      <StoryRow
        label="Needs you, with a wait running"
        hint="The ask stays on top; the open wait sits below it with its own action."
      >
        <Scenario
          inboxEntry={entry({
            state: "needs-you",
            view: "inbox",
            reason: {
              kind: "ask",
              text: "Approve the production migration plan",
              threadId: THREAD_ID,
            },
            recap: "The candidate passed every check on staging.",
          })}
          waits={[
            wait({
              id: "security",
              kind: "check",
              status: "evaluating",
              forText: "GamesLike security-table check",
              checkCount: 1,
            }),
          ]}
        />
      </StoryRow>
      <StoryRow
        label="Waiting for another chat"
        hint="One wait whose source chat has the same name: the name itself is the link."
      >
        <Scenario
          inboxEntry={entry({
            reason: {
              kind: "wait",
              text: "iOS acceptance and review",
              threadId: THREAD_ID,
            },
          })}
          waits={[
            wait({
              id: "ios",
              forText: "iOS acceptance and review",
              deadline: now + 26 * 60 * MINUTE,
              conditions: [
                {
                  key: "chat:thr_story_ios",
                  kind: "chat",
                  label: "iOS acceptance and review",
                  met: false,
                },
              ],
            }),
          ]}
        />
      </StoryRow>
      <StoryRow
        label="Other chats wait on this one"
        hint="Nothing to cancel here; the line explains who depends on this chat."
      >
        <Scenario
          inboxEntry={entry({
            reason: {
              kind: "deliver",
              text: "Release and Review are waiting on this chat",
              threadId: "thr_other_family",
            },
          })}
          waits={[]}
        />
      </StoryRow>
    </StoryCard>
  );
}

import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./send-outbox-entry";
import type { StagingFollowUp } from "./staging-follow-ups";
import {
  outboxEntryPlacement,
  pendingQueueFollowUps,
  pendingTimelineSubmissions,
  queuedMessageShowsInChat,
  queuedSubmissionIds,
} from "./timeline-submissions";

const threadId = "thr_busy";

const queuedFollowUp: ThreadQueuedMessage = {
  id: "qmsg_follow_up",
  origin: null,
  originPluginId: null,
  initiator: "user",
  senderThreadId: null,
  threadId,
  content: [
    {
      type: "text",
      text: "also explain this",
      mentions: [],
      submissionId: "sub_follow_up",
    },
  ],
  model: "model",
  reasoningLevel: "high",
  permissionMode: "auto",
  serviceTier: "default",
  groupWithNext: false,
  sendAt: null,
  waitingOn: { kind: "thread-busy" },
  failureReason: null,
  payload: { kind: "inline" },
  editable: true,
  createdAt: 1,
  updatedAt: 1,
};

const waitingOutboxEntry: OutboxEntry = {
  schema: 1,
  sequence: 1,
  state: { kind: "waiting" },
  storeId: "store",
  submissionId: "sub_outbox",
  createdAt: 2,
  attachments: [],
  action: {
    kind: "thread-message",
    target: { threadId },
    projectId: "project",
    message: {
      input: [
        {
          type: "text",
          text: "still in the outbox",
          mentions: [],
          submissionId: "sub_outbox",
        },
      ],
      messageSource: { kind: "user" },
    },
  },
};

const stagingFollowUp: StagingFollowUp = {
  submissionId: "sub_staging",
  threadId,
  input: [{ type: "text", text: "just clicked send", mentions: [] }],
  createdAt: 3,
};

function textOf(message: ThreadQueuedMessage): string | undefined {
  const part = message.content[0];

  return part?.type === "text" ? part.text : undefined;
}

const busyStatuses: ThreadRuntimeDisplayStatus[] = [
  "active",
  "provisioning",
  "starting",
  "stopping",
  "waiting-for-host",
];

describe("follow-up placement", () => {
  it.each(busyStatuses)(
    "keeps a queued follow-up in the queue, not the chat, while the thread is %s",
    (status) => {
      expect(
        pendingTimelineSubmissions(threadId, status, [], [], [queuedFollowUp]),
      ).toEqual([]);
      expect(queuedMessageShowsInChat(queuedFollowUp, status)).toBe(false);
      expect([
        ...queuedSubmissionIds(threadId, status, [], [], [queuedFollowUp]),
      ]).toEqual(["sub_follow_up"]);
    },
  );

  it("shows a queued follow-up in the chat, not the queue, once the thread is idle", () => {
    const rows = pendingTimelineSubmissions(
      threadId,
      "idle",
      [],
      [],
      [queuedFollowUp],
    );

    expect(rows.map((item) => item.row.text)).toEqual(["also explain this"]);
    expect(queuedMessageShowsInChat(queuedFollowUp, "idle")).toBe(true);
    expect(
      queuedSubmissionIds(threadId, "idle", [], [], [queuedFollowUp]).size,
    ).toBe(0);
  });

  it.each(busyStatuses)(
    "shows unsent follow-ups in the queue, not the chat or the waiting card, while the thread is %s",
    (status) => {
      expect(
        pendingTimelineSubmissions(
          threadId,
          status,
          [stagingFollowUp],
          [waitingOutboxEntry],
          [],
        ),
      ).toEqual([]);
      expect(outboxEntryPlacement(waitingOutboxEntry, threadId, status)).toBe(
        "queue",
      );

      const queued = pendingQueueFollowUps(
        threadId,
        status,
        [stagingFollowUp],
        [waitingOutboxEntry],
        [],
      );

      expect(queued.map(textOf)).toEqual([
        "still in the outbox",
        "just clicked send",
      ]);
      expect(queued.map((message) => message.id)).toEqual([
        "optimistic-queued-sub_outbox",
        "optimistic-queued-sub_staging",
      ]);
    },
  );

  it("shows unsent follow-ups in the chat, not the queue or the waiting card, while the thread is idle", () => {
    expect(
      pendingTimelineSubmissions(
        threadId,
        "idle",
        [stagingFollowUp],
        [waitingOutboxEntry],
        [],
      ).map((item) => item.row.text),
    ).toEqual(["still in the outbox", "just clicked send"]);
    expect(outboxEntryPlacement(waitingOutboxEntry, threadId, "idle")).toBe(
      "chat",
    );
    expect(
      pendingQueueFollowUps(
        threadId,
        "idle",
        [stagingFollowUp],
        [waitingOutboxEntry],
        [],
      ),
    ).toEqual([]);
  });

  it("replaces the queue placeholder once the server has queued the same follow-up", () => {
    const delivered = {
      ...queuedFollowUp,
      content: [{ ...queuedFollowUp.content[0]!, submissionId: "sub_outbox" }],
    } satisfies ThreadQueuedMessage;

    expect(
      pendingQueueFollowUps(
        threadId,
        "active",
        [],
        [waitingOutboxEntry],
        [delivered],
      ),
    ).toEqual([]);
  });

  it("keeps a paused follow-up in the waiting card whatever the thread is doing", () => {
    const paused: OutboxEntry = {
      ...waitingOutboxEntry,
      state: { kind: "paused", code: "denied", message: "Denied" },
    };

    for (const status of ["idle", ...busyStatuses] as const) {
      expect(outboxEntryPlacement(paused, threadId, status)).toBe("card");
      expect(pendingQueueFollowUps(threadId, status, [], [paused], [])).toEqual(
        [],
      );
      expect(
        pendingTimelineSubmissions(threadId, status, [], [paused], []),
      ).toEqual([]);
    }
  });
});

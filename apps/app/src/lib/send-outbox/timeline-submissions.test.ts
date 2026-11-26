import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import { describe, expect, it } from "vitest";
import type { OutboxEntry } from "./send-outbox-entry";
import {
  followUpShowsInChat,
  outboxEntryShowsInChat,
  pendingTimelineSubmissions,
  queuedMessageShowsInChat,
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

const busyStatuses: ThreadRuntimeDisplayStatus[] = [
  "active",
  "provisioning",
  "starting",
  "stopping",
  "waiting-for-host",
];

describe("follow-up placement", () => {
  it.each(busyStatuses)(
    "keeps a queued follow-up out of the chat while the thread is %s",
    (status) => {
      expect(
        pendingTimelineSubmissions(threadId, status, [], [queuedFollowUp]),
      ).toEqual([]);
      expect(queuedMessageShowsInChat(queuedFollowUp, status)).toBe(false);
    },
  );

  it("shows a queued follow-up in the chat, not the queue, once the thread is idle", () => {
    const rows = pendingTimelineSubmissions(
      threadId,
      "idle",
      [],
      [queuedFollowUp],
    );

    expect(rows.map((item) => item.row.text)).toEqual(["also explain this"]);
    expect(queuedMessageShowsInChat(queuedFollowUp, "idle")).toBe(true);
  });

  it.each(busyStatuses)(
    "keeps an unsent outbox follow-up in the waiting card while the thread is %s",
    (status) => {
      expect(followUpShowsInChat(status)).toBe(false);
      expect(
        pendingTimelineSubmissions(threadId, status, [waitingOutboxEntry], []),
      ).toEqual([]);
      expect(outboxEntryShowsInChat(waitingOutboxEntry, threadId, status)).toBe(
        false,
      );
    },
  );

  it("shows an unsent outbox follow-up in the chat, not the waiting card, while the thread is idle", () => {
    expect(followUpShowsInChat("idle")).toBe(true);
    expect(
      pendingTimelineSubmissions(
        threadId,
        "idle",
        [waitingOutboxEntry],
        [],
      ).map((item) => item.row.text),
    ).toEqual(["still in the outbox"]);
    expect(outboxEntryShowsInChat(waitingOutboxEntry, threadId, "idle")).toBe(
      true,
    );
  });
});

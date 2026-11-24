import { describe, expect, it } from "vitest";
import {
  createStandaloneBuiltinCompactCommandInput,
  type ThreadQueuedMessage,
} from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import { makeThreadQueuedMessage } from "@omnyo/test-helpers/domain-fixtures";
import {
  conversationRow,
  systemRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  selectQueuedMessagesAwaitingCompaction,
  withoutCompactCommandRows,
} from "./compaction-queued-messages";

const compactInput = createStandaloneBuiltinCompactCommandInput()[0]!;

function compactRequestRow(
  status: "pending" | "accepted" | "rejected" = "accepted",
): TimelineRow {
  const row = conversationRow({
    id: "compact_request",
    role: "user",
    text: compactInput.type === "text" ? compactInput.text : "",
    seq: 10,
    createdAt: 1_000,
    turnId: "turn_compact",
    turnRequest: {
      clientRequestId: null,
      isGrouped: false,
      kind: "message",
      status,
    },
  });

  return row.role === "user" && compactInput.type === "text"
    ? {
        ...row,
        mentions: compactInput.mentions,
        attachments: projectedAttachments(),
      }
    : row;
}

function projectedAttachments(webImages = 0) {
  return {
    webImages,
    localImages: 0,
    localFiles: 0,
    imageUrls: [],
    localImagePaths: [],
    localFilePaths: [],
    localFileDetails: [],
  };
}

function compactionRow(): TimelineRow {
  return systemRow({
    id: "compaction",
    operationKind: "compaction",
    title: "Compacting context",
    detail: null,
    status: "pending",
    seq: 11,
    turnId: "turn_compact",
  });
}

function queued(overrides: Partial<ThreadQueuedMessage> = {}) {
  return makeThreadQueuedMessage({
    id: "qmsg_follow_up",
    threadId: "thr_1",
    content: [
      { type: "text", text: "What should I check first?", mentions: [] },
    ],
    model: "claude",
    createdAt: 1_001,
    updatedAt: 1_001,
    waitingOn: { kind: "thread-busy" },
    ...overrides,
  });
}

describe("compaction queued messages", () => {
  it("treats a message queued behind a running /compact as sent", () => {
    const rows = [compactRequestRow(), compactionRow()];
    const message = queued();

    expect(
      selectQueuedMessagesAwaitingCompaction({
        queuedMessages: [message],
        runtimeStatus: "active",
        timelineRows: rows,
      }),
    ).toEqual([message]);
    expect(withoutCompactCommandRows(rows).map((row) => row.id)).toEqual([
      "compaction",
    ]);
  });

  it("returns the message to the queue once compaction has finished", () => {
    expect(
      selectQueuedMessagesAwaitingCompaction({
        queuedMessages: [queued()],
        runtimeStatus: "idle",
        timelineRows: [compactRequestRow(), compactionRow()],
      }),
    ).toEqual([]);
  });

  it("keeps a rejected /compact visible and does not hold messages", () => {
    const rows = [compactRequestRow("rejected")];

    expect(withoutCompactCommandRows(rows)).toBe(rows);
    expect(
      selectQueuedMessagesAwaitingCompaction({
        queuedMessages: [queued()],
        runtimeStatus: "active",
        timelineRows: rows,
      }),
    ).toEqual([]);
  });

  it.each([
    ["queued before the compaction", { createdAt: 999 }],
    ["scheduled", { sendAt: 5_000, waitingOn: { kind: "time" } as const }],
    ["failed", { failureReason: "Provider rejected the message" }],
    ["from another chat", { senderThreadId: "thr_sender" }],
  ])("leaves a message %s in the queue", (_name, overrides) => {
    expect(
      selectQueuedMessagesAwaitingCompaction({
        queuedMessages: [queued(overrides)],
        runtimeStatus: "active",
        timelineRows: [compactRequestRow(), compactionRow()],
      }),
    ).toEqual([]);
  });

  it("keeps a /compact sent with an image visible", () => {
    const row = compactRequestRow();

    const rows =
      row.kind === "conversation" && row.role === "user"
        ? [{ ...row, attachments: projectedAttachments(1) }]
        : [row];

    expect(withoutCompactCommandRows(rows)).toBe(rows);
  });

  it("keeps ordinary messages that only mention /compact in text", () => {
    const rows = [
      conversationRow({
        id: "plain",
        role: "user",
        text: "/compact",
        seq: 10,
      }),
    ];

    expect(withoutCompactCommandRows(rows)).toBe(rows);
  });
});

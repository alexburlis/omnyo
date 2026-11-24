import type { ClientTurnRequestId } from "@omnyo/domain";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import {
  acceptPendingSentMessage,
  addPendingSentMessage,
  beginPendingSentMessageRead,
  getPendingSentMessages,
  removePendingSentMessage,
  subscribePendingSentMessages,
  withPendingSentMessages,
} from "./pending-sent-messages";

const THREAD_ID = "thread-1";

function userRow(
  id: string,
  requestId: ClientTurnRequestId | null,
  seq: number,
  status: "pending" | "accepted" = "accepted",
): TimelineUserConversationRow {
  const row = conversationRow({
    id,
    role: "user",
    seq,
    text: "one message",
    threadId: THREAD_ID,
    turnRequest: {
      clientRequestId: requestId,
      isGrouped: false,
      kind: "message",
      status,
    },
  });

  if (row.role !== "user") throw new Error("Expected a user row");

  return row;
}

function pendingRow(
  id: string,
  requestId: ClientTurnRequestId | null,
): TimelineUserConversationRow {
  return userRow(id, requestId, 0, "pending");
}

function displayedIds(
  queryClient: QueryClient,
  rows: TimelineRow[],
  maxSeq: number,
): string[] {
  return withPendingSentMessages({
    maxSeq,
    pending: getPendingSentMessages(queryClient, THREAD_ID),
    rows,
    threadId: THREAD_ID,
  }).map((row) => row.id);
}

function read(
  queryClient: QueryClient,
  displayedMaxSeq: number,
): ReturnType<typeof beginPendingSentMessageRead> {
  return beginPendingSentMessageRead({
    displayedMaxSeq,
    queryClient,
    threadId: THREAD_ID,
  });
}

describe("pending sent messages", () => {
  it("shows a sent message once before, while and after the server confirms it", () => {
    const queryClient = new QueryClient();
    const earlier = userRow("earlier", null, 10);
    const pending = pendingRow("pending-a", "creq_2222222222");
    const sent = userRow("sent-a", "creq_2222222222", 12);

    addPendingSentMessage(queryClient, THREAD_ID, pending);
    expect(displayedIds(queryClient, [earlier], 11)).toEqual([
      "earlier",
      "pending-a",
    ]);

    read(queryClient, 11)({ maxSeq: 12, rows: [earlier, sent] });
    expect(displayedIds(queryClient, [earlier], 11)).toEqual([
      "earlier",
      "pending-a",
    ]);
    expect(displayedIds(queryClient, [earlier, sent], 12)).toEqual([
      "earlier",
      "sent-a",
    ]);

    acceptPendingSentMessage(queryClient, THREAD_ID, pending.id);
    expect(displayedIds(queryClient, [earlier, sent], 12)).toEqual([
      "earlier",
      "sent-a",
    ]);

    read(queryClient, 12);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toEqual([]);
  });

  it("hides a pending message whose server row is displayed inside a turn", () => {
    const queryClient = new QueryClient();
    const sent = userRow("sent-a", "creq_2222222222", 12);

    addPendingSentMessage(
      queryClient,
      THREAD_ID,
      pendingRow("pending-a", "creq_2222222222"),
    );

    expect(
      displayedIds(queryClient, [turnRow({ children: [sent] })], 12),
    ).toHaveLength(1);
  });

  it("hides every message of a grouped send once its request is displayed", () => {
    const queryClient = new QueryClient();

    for (const id of ["pending-a", "pending-b"])
      addPendingSentMessage(
        queryClient,
        THREAD_ID,
        pendingRow(id, "creq_2222222222"),
      );

    expect(displayedIds(queryClient, [], 1)).toEqual([
      "pending-a",
      "pending-b",
    ]);
    expect(
      displayedIds(
        queryClient,
        [
          userRow("sent-a", "creq_2222222222", 2),
          userRow("sent-b", "creq_2222222222", 2),
        ],
        2,
      ),
    ).toEqual(["sent-a", "sent-b"]);
  });

  it("keeps identical text from two sends as two messages", () => {
    const queryClient = new QueryClient();

    addPendingSentMessage(
      queryClient,
      THREAD_ID,
      pendingRow("pending-a", "creq_2222222222"),
    );
    addPendingSentMessage(
      queryClient,
      THREAD_ID,
      pendingRow("pending-b", "creq_3333333333"),
    );

    expect(
      displayedIds(queryClient, [userRow("sent-a", "creq_2222222222", 2)], 2),
    ).toEqual(["sent-a", "pending-b"]);
  });

  it("keeps an accepted message through a read that began before it was accepted", () => {
    const queryClient = new QueryClient();
    const pending = pendingRow("pending-a", null);

    addPendingSentMessage(queryClient, THREAD_ID, pending);
    const settleEarlierRead = read(queryClient, 5);
    acceptPendingSentMessage(queryClient, THREAD_ID, pending.id);
    settleEarlierRead({ maxSeq: 6, rows: [] });

    expect(displayedIds(queryClient, [], 6)).toEqual(["pending-a"]);
  });

  it("retires an accepted message the server never shows once a later read is displayed", () => {
    const queryClient = new QueryClient();
    const pending = pendingRow("pending-a", null);

    addPendingSentMessage(queryClient, THREAD_ID, pending);
    acceptPendingSentMessage(queryClient, THREAD_ID, pending.id);
    read(queryClient, 5)({ maxSeq: 7, rows: [] });

    expect(displayedIds(queryClient, [], 5)).toEqual(["pending-a"]);
    expect(displayedIds(queryClient, [], 7)).toEqual([]);

    read(queryClient, 5);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toHaveLength(1);
    read(queryClient, 7);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toEqual([]);
  });

  it("keeps an unaccepted message through any number of reads", () => {
    const queryClient = new QueryClient();

    addPendingSentMessage(
      queryClient,
      THREAD_ID,
      pendingRow("pending-a", "creq_2222222222"),
    );
    read(queryClient, 5)({ maxSeq: 6, rows: [] });
    read(queryClient, 6)({ maxSeq: 7, rows: [] });

    expect(displayedIds(queryClient, [], 7)).toEqual(["pending-a"]);
  });

  it("removes a failed send and reports whether it was still pending", () => {
    const queryClient = new QueryClient();
    const pending = pendingRow("pending-a", "creq_2222222222");

    addPendingSentMessage(queryClient, THREAD_ID, pending);

    expect(removePendingSentMessage(queryClient, THREAD_ID, pending.id)).toBe(
      true,
    );
    expect(removePendingSentMessage(queryClient, THREAD_ID, pending.id)).toBe(
      false,
    );
    expect(displayedIds(queryClient, [], 1)).toEqual([]);
  });

  it("notifies subscribers on change and keeps the snapshot stable otherwise", () => {
    const queryClient = new QueryClient();
    const listener = vi.fn();
    const unsubscribe = subscribePendingSentMessages(queryClient, listener);
    const empty = getPendingSentMessages(queryClient, THREAD_ID);
    const pending = pendingRow("pending-a", "creq_2222222222");

    addPendingSentMessage(queryClient, THREAD_ID, pending);
    expect(listener).toHaveBeenCalledTimes(1);
    const snapshot = getPendingSentMessages(queryClient, THREAD_ID);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toBe(snapshot);
    expect(getPendingSentMessages(queryClient, "thread-2")).toBe(empty);

    read(queryClient, 1)({ maxSeq: 1, rows: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toBe(snapshot);

    removePendingSentMessage(queryClient, THREAD_ID, pending.id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getPendingSentMessages(queryClient, THREAD_ID)).toBe(empty);
    unsubscribe();
    addPendingSentMessage(queryClient, THREAD_ID, pending);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("returns the server rows untouched when nothing is pending", () => {
    const queryClient = new QueryClient();
    const rows = [userRow("earlier", null, 10)];

    expect(
      withPendingSentMessages({
        maxSeq: 10,
        pending: getPendingSentMessages(queryClient, THREAD_ID),
        rows,
        threadId: THREAD_ID,
      }),
    ).toBe(rows);
  });
});

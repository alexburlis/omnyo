import { describe, expect, it } from "vitest";
import {
  chatNoticeReducer,
  EMPTY_CHAT_NOTICE_STACK,
  isDrawnChatNotice,
  SENT_MS,
  shownChatNotices,
  type ChatNoticeAction,
  type ChatNoticeContext,
  type ChatNoticeStack,
  type LiveChatNotice,
} from "./chat-notice-model.js";

function context(
  live: LiveChatNotice,
  openThreadId: string | null = null,
): ChatNoticeContext {
  return {
    live: new Map([["thr_a", live]]),
    openThreadId,
    capacity: 2,
    countdown: false,
  };
}

function run(
  steps: readonly [ChatNoticeAction, number][],
  stack: ChatNoticeStack = EMPTY_CHAT_NOTICE_STACK,
): ChatNoticeStack {
  return steps.reduce(
    (current, [action, now]) => chatNoticeReducer(current, { action, now }),
    stack,
  );
}

const receive: ChatNoticeAction = {
  type: "receive",
  notice: { id: "n1", threadId: "thr_a", title: "A", body: "Approve" },
};

function shown(stack: ChatNoticeStack) {
  return shownChatNotices(stack).map(({ notice, phase }) => [
    notice.threadId,
    phase.kind,
  ]);
}

function drawn(stack: ChatNoticeStack) {
  return shownChatNotices(stack).map((entry) => [
    entry.notice.threadId,
    isDrawnChatNotice(entry),
  ]);
}

function draw(noticeId: string): ChatNoticeAction {
  return { type: "hold", noticeId, source: "loading", held: false };
}

describe("chat notice stack", () => {
  it("drops a chat's card once that chat is the open chat", () => {
    const visible = run([
      [{ type: "sync", context: context("needs-you") }, 0],
      [receive, 0],
    ]);

    expect(shown(visible)).toEqual([["thr_a", "card"]]);
    expect(
      run(
        [[{ type: "sync", context: context("needs-you", "thr_a") }, 10]],
        visible,
      ).entries,
    ).toEqual([]);
  });

  it("keeps a sent confirmation after the chat stops needing you, then removes it", () => {
    const sent = run([
      [{ type: "sync", context: context("needs-you") }, 0],
      [receive, 0],
      [{ type: "send", noticeId: "n1" }, 100],
      [{ type: "sync", context: context("quiet") }, 150],
      [{ type: "sent", noticeId: "n1", detail: "Sent “Yes”" }, 200],
    ]);

    expect(shown(sent)).toEqual([["thr_a", "sent"]]);
    expect(shown(run([[{ type: "tick" }, 200 + SENT_MS - 1]], sent))).toEqual([
      ["thr_a", "sent"],
    ]);
    expect(run([[{ type: "tick" }, 200 + SENT_MS]], sent).entries).toEqual([]);
  });

  it("holds an overlay card's countdown until the card is drawn, then counts the full 8 seconds", () => {
    const overlay = { ...context("needs-you"), capacity: 1, countdown: true };

    const loading = run([
      [{ type: "sync", context: overlay }, 0],
      [receive, 0],
      [{ type: "tick" }, 60_000],
    ]);

    expect(drawn(loading)).toEqual([["thr_a", false]]);
    expect(shown(loading)).toEqual([["thr_a", "card"]]);

    const counting = run([[draw("n1"), 60_000]], loading);

    expect(drawn(counting)).toEqual([["thr_a", true]]);
    expect(shown(run([[{ type: "tick" }, 67_999]], counting))).toEqual([
      ["thr_a", "card"],
    ]);
    expect(shown(run([[{ type: "tick" }, 68_000]], counting))).toEqual([
      ["thr_a", "leaving"],
    ]);
  });

  it("makes a card that went off screen load again before it is drawn", () => {
    const twoChats: ChatNoticeContext = {
      live: new Map([
        ["thr_a", "needs-you"],
        ["thr_b", "needs-you"],
      ]),
      openThreadId: null,
      capacity: 1,
      countdown: true,
    };

    const first = run([
      [{ type: "sync", context: twoChats }, 0],
      [receive, 0],
      [
        {
          type: "receive",
          notice: { id: "n2", threadId: "thr_b", title: "B", body: "Approve" },
        },
        0,
      ],
      [draw("n1"), 10],
    ]);

    expect(drawn(first)).toEqual([["thr_a", true]]);

    const second = run([[{ type: "cycle" }, 20]], first);

    expect(drawn(second)).toEqual([["thr_b", false]]);
    expect(
      drawn(
        run(
          [
            [draw("n2"), 30],
            [{ type: "cycle" }, 40],
          ],
          second,
        ),
      ),
    ).toEqual([["thr_a", false]]);
  });

  it("keeps a drawn card drawn when a newer notice for its chat arrives", () => {
    const visible = run([
      [{ type: "sync", context: context("needs-you") }, 0],
      [receive, 0],
      [draw("n1"), 10],
      [
        {
          type: "receive",
          notice: { id: "n2", threadId: "thr_a", title: "A", body: "Answer" },
        },
        20,
      ],
    ]);

    expect(drawn(visible)).toEqual([["thr_a", true]]);
    expect(shownChatNotices(visible).map(({ notice }) => notice.id)).toEqual([
      "n2",
    ]);
  });
});

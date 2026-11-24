// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import type { TimelineRow } from "@omnyo/server-contract";
import {
  commandRow,
  conversationRow,
} from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";

const ENTRANCE_CLASS = "slide-in-from-bottom-1";

const historyRows: TimelineRow[] = [
  conversationRow({
    id: "user_history",
    role: "user",
    text: "Earlier question.",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    threadId: "thr_main",
  }),
  conversationRow({
    id: "assistant_history",
    role: "assistant",
    text: "Earlier answer.",
    sourceSeqStart: 2,
    sourceSeqEnd: 2,
    threadId: "thr_main",
  }),
];

function sentRow(id: string, status: "pending" | "accepted"): TimelineRow {
  return conversationRow({
    id,
    role: "user",
    text: "New question.",
    sourceSeqStart: 3,
    sourceSeqEnd: 3,
    threadId: "thr_main",
    turnRequest: {
      clientRequestId: "req_sent",
      isGrouped: false,
      kind: "message",
      status,
    },
  });
}

const LIVE_ENTRANCE_CLASS = "[animation-fill-mode:backwards]";

function timeline(
  queryClient: QueryClient,
  rows: TimelineRow[],
  status: "idle" | "active" = "idle",
) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ThreadTimelineRows
          threadId="thr_main"
          timelineRows={rows}
          threadRuntimeDisplayStatus={status}
          workspaceRootPath={undefined}
        />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function rowWrapper(container: HTMLElement, id: string): Element | null {
  return container.querySelector(`[data-timeline-row-id="${id}"]`);
}

afterEach(() => {
  cleanup();
});

describe("ThreadTimelineRows sent message arrival", () => {
  it("animates only a newly sent user row and not its confirmed replacement", () => {
    const queryClient = new QueryClient();
    const view = render(timeline(queryClient, historyRows));

    expect(
      rowWrapper(view.container, "user_history")?.classList.contains(
        ENTRANCE_CLASS,
      ),
    ).toBe(false);

    view.rerender(
      timeline(queryClient, [
        ...historyRows,
        sentRow("optimistic-user-1", "pending"),
      ]),
    );

    expect(
      rowWrapper(view.container, "optimistic-user-1")?.classList.contains(
        ENTRANCE_CLASS,
      ),
    ).toBe(true);

    view.rerender(
      timeline(queryClient, [
        ...historyRows,
        sentRow("user_confirmed", "accepted"),
      ]),
    );

    const confirmed = rowWrapper(view.container, "user_confirmed");
    expect(confirmed).not.toBeNull();
    expect(confirmed?.classList.contains(ENTRANCE_CLASS)).toBe(false);
  });

  it("does not animate older user rows prepended by history loading", () => {
    const queryClient = new QueryClient();
    const view = render(timeline(queryClient, historyRows));

    view.rerender(
      timeline(queryClient, [
        conversationRow({
          id: "user_older",
          role: "user",
          text: "Oldest question.",
          sourceSeqStart: 0,
          sourceSeqEnd: 0,
          threadId: "thr_main",
        }),
        ...historyRows,
      ]),
    );

    expect(
      rowWrapper(view.container, "user_older")?.classList.contains(
        ENTRANCE_CLASS,
      ),
    ).toBe(false);
  });

  it("rises new live rows into view without replaying a re-keyed row", () => {
    const queryClient = new QueryClient();

    const work = commandRow({
      id: "cmd_first",
      command: "ls",
      sourceSeqStart: 3,
      sourceSeqEnd: 3,
      threadId: "thr_main",
    });

    const reply = (id: string) =>
      conversationRow({
        id,
        role: "assistant",
        text: "Here is what I found.",
        sourceSeqStart: 4,
        sourceSeqEnd: 4,
        threadId: "thr_main",
      });

    const view = render(
      timeline(queryClient, [...historyRows, work], "active"),
    );

    view.rerender(
      timeline(
        queryClient,
        [...historyRows, work, reply("reply_live")],
        "active",
      ),
    );

    expect(
      rowWrapper(view.container, "reply_live")?.classList.contains(
        LIVE_ENTRANCE_CLASS,
      ),
    ).toBe(true);

    view.rerender(
      timeline(
        queryClient,
        [...historyRows, work, reply("reply_final")],
        "active",
      ),
    );

    expect(
      rowWrapper(view.container, "reply_final")?.classList.contains(
        LIVE_ENTRANCE_CLASS,
      ),
    ).toBe(false);
  });
});

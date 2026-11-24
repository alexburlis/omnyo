// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { TimelineConversationRow } from "@omnyo/server-contract";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { ThreadTimelineRows } from "./ThreadTimelineRows";
import { ConversationMessageContent } from "./ConversationMessageContent";

afterEach(cleanup);

function assistant(
  id: string,
  status: "streaming" | "completed",
): Extract<TimelineConversationRow, { role: "assistant" }> {
  return {
    ...conversationRow({
      id,
      role: "assistant",
      turnId: id,
      text: `Response ${id}`,
      startedAt: 1_000,
      createdAt: 10_000,
    }),
    role: "assistant",
    turnRequest: null,
    turnGit: null,
    status,
  };
}

describe("finalized message timestamps", () => {
  it.each(["pending", "accepted"] as const)(
    "dates human inputs only after acceptance: %s",
    (status) => {
      const result = render(
        <MemoryRouter>
          <ConversationMessageContent
            role="user"
            id="user_timestamp_1"
            threadId="thr_timestamps"
            turnId={null}
            attachments={null}
            initiator="user"
            mentions={[]}
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text="Follow-up request"
            timestamp={10_000}
            turnRequest={{
              clientRequestId: null,
              isGrouped: false,
              kind: "steer",
              status,
            }}
          />
        </MemoryRouter>,
      );

      expect(
        result.container.querySelectorAll("[data-message-time]"),
      ).toHaveLength(status === "accepted" ? 1 : 0);
    },
  );
  it("shows completed send time after the turn finishes and keeps older times during new work", () => {
    const client = new QueryClient();

    const rows = [
      assistant("earlier", "completed"),
      assistant("current", "completed"),
    ];

    const view = (active: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadTimelineRows
            timelineRows={rows}
            threadRuntimeDisplayStatus={active ? "active" : "idle"}
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const result = render(view(true));
    expect(
      result.container.querySelectorAll("[data-message-time]"),
    ).toHaveLength(1);
    result.rerender(view(false));
    const times = result.container.querySelectorAll("[data-message-time]");
    expect(times).toHaveLength(2);
    expect(times[1]?.getAttribute("datetime")).toBe(
      new Date(10_000).toISOString(),
    );
    client.clear();
  });

  it("never dates an unfinished response even when the runtime is idle", () => {
    const client = new QueryClient();

    const result = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadTimelineRows
            timelineRows={[assistant("unfinished", "streaming")]}
            threadRuntimeDisplayStatus="idle"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(result.container.querySelector("[data-message-time]")).toBeNull();
    client.clear();
  });

  it("keeps timestamps for completed history without showing its message actions", () => {
    const result = render(
      <MemoryRouter>
        <ConversationMessageContent
          role="assistant"
          turnGit={null}
          id="history"
          threadId="thread"
          turnId="turn"
          text="Completed history"
          attachments={null}
          showActions={false}
          streaming={false}
          timestamp={10_000}
        />
      </MemoryRouter>,
    );

    expect(
      result.container.querySelector("[data-message-time]"),
    ).not.toBeNull();
    expect(
      result.queryByRole("button", { name: "Message actions" }),
    ).toBeNull();
  });

  it("hides current-turn commentary timestamps inside an expanded working turn", () => {
    const client = new QueryClient();

    const result = render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ThreadTimelineRows
            initialExpanded={new Set(["working"])}
            timelineRows={[
              turnRow({
                id: "working",
                turnId: "commentary",
                status: "pending",
                children: [assistant("commentary", "completed")],
              }),
            ]}
            threadRuntimeDisplayStatus="active"
            workspaceRootPath={undefined}
          />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(result.getByText("Response commentary")).toBeTruthy();
    expect(result.container.querySelector("[data-message-time]")).toBeNull();
    client.clear();
  });
});

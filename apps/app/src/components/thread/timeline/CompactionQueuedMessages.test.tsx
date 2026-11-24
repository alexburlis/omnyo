// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createStandaloneBuiltinCompactCommandInput,
  type ThreadQueuedMessage,
  type ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type { TimelineRow } from "@omnyo/server-contract";
import { makeThreadQueuedMessage } from "@omnyo/test-helpers/domain-fixtures";
import {
  conversationRow,
  systemRow,
} from "@/test/fixtures/thread-timeline-rows";
import { CompactionQueuedMessagesProvider } from "./CompactionQueuedMessages";
import { ThreadTimelineSurface } from "./ThreadTimelineSurface";

const queuedMessages = vi.hoisted(() => ({
  current: [] as ThreadQueuedMessage[],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@/hooks/queries/thread-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/thread-queries")>()),
  useThreadQueuedMessages: () => ({ data: queuedMessages.current }),
}));

const compactInput = createStandaloneBuiltinCompactCommandInput()[0]!;

function timelineRows(): TimelineRow[] {
  const request = conversationRow({
    id: "compact_request",
    role: "user",
    text: "/compact",
    seq: 10,
    createdAt: 1_000,
    turnId: "turn_compact",
  });

  return [
    request.role === "user" && compactInput.type === "text"
      ? { ...request, mentions: compactInput.mentions }
      : request,
    systemRow({
      id: "compaction",
      operationKind: "compaction",
      title: "Compacting context",
      detail: null,
      status: "pending",
      seq: 11,
      turnId: "turn_compact",
    }),
  ];
}

function renderSurface(status: ThreadRuntimeDisplayStatus) {
  const rows = timelineRows();

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <CompactionQueuedMessagesProvider
          runtimeStatus={status}
          threadId="thr_1"
          timelineRows={rows}
        >
          <ThreadTimelineSurface
            activeThinking={null}
            contextBoundarySeq={null}
            isThreadTimelinePending={false}
            showOngoingIndicator
            threadId="thr_1"
            threadRuntimeDisplayStatus={status}
            timelineError={false}
            timelineRows={rows}
            workspaceRootPath={undefined}
          />
        </CompactionQueuedMessagesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", undefined);
  queuedMessages.current = [
    makeThreadQueuedMessage({
      id: "qmsg_follow_up",
      threadId: "thr_1",
      content: [
        { type: "text", text: "What should I check first?", mentions: [] },
      ],
      model: "claude",
      createdAt: 1_001,
      updatedAt: 1_001,
      waitingOn: { kind: "thread-busy" },
    }),
  ];
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("messages queued behind a compaction", () => {
  it("shows the message as sent below the compaction instead of a /compact bubble", () => {
    renderSurface("active");

    expect(screen.getByText("What should I check first?")).not.toBeNull();
    expect(screen.getByText("Sends after compaction")).not.toBeNull();
    expect(
      document.querySelector('[data-timeline-row-id="compact_request"]'),
    ).toBeNull();
    expect(
      screen.getByText("Working...").closest<HTMLElement>("[style*=opacity]")
        ?.style.opacity,
    ).toBe("0");
  });

  it("drops the inline message once the compaction turn has ended", () => {
    renderSurface("idle");

    expect(screen.queryByText("Sends after compaction")).toBeNull();
  });
});

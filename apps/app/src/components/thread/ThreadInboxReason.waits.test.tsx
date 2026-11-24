// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEntry, InboxSnapshot, InboxWaitView } from "@omnyo/domain";
import { ThreadInboxReason } from "./ThreadInboxReason";
import type { ComponentProps } from "react";

const mocks = vi.hoisted(() => ({
  snapshot: null as InboxSnapshot | null,
  ancestors: vi.fn(),
  waits: vi.fn(),
  actOnInbox: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/hooks/queries/use-inbox-snapshot", () => ({
  useInboxSnapshot: () => ({
    snapshot: mocks.snapshot,
    refresh: mocks.refresh,
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { experimental_listAncestors: mocks.ancestors },
    experimental_inbox: { waits: mocks.waits, act: mocks.actOnInbox },
  },
}));

vi.mock("@/components/ui/app-route-anchor", () => ({
  RouteAnchor: (props: ComponentProps<"a">) => <a {...props} />,
}));

vi.mock("./timeline/ConversationMessageMentions", () => ({
  PromptMentionPill: () => null,
}));

vi.mock("./ThreadTitleMentions", () => ({
  useRawThreadMentionResources: (ids: string[]) =>
    new Map(
      ids.map((id) => [
        id,
        {
          kind: "thread",
          threadId: id,
          projectId: "source-project",
          label: id === "thr_coordinator" ? "COORDINATOR PARASPEECH" : id,
        },
      ]),
    ),
  useThreadRoutePath: () => (threadId: string, projectId: string | undefined) =>
    `/projects/${projectId ?? "personal"}/threads/${threadId}`,
}));

function show(
  entry: InboxEntry,
  threadId = "root",
  parentThreadId: string | null = null,
) {
  mocks.snapshot = {
    revision: "one",
    generatedAt: 0,
    inbox: [entry],
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      inbox: 1,
      questions: 0,
      needsYou: 1,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };

  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ThreadInboxReason threadId={threadId} parentThreadId={parentThreadId} />
    </QueryClientProvider>,
  );
}

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    threadId: "root",
    projectId: "project",
    title: "Root",
    automationId: null,
    shelved: false,
    view: "inbox",
    card: null,
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: 0,
    latch: "latch",
    state: "needs-you",
    reason: { kind: "ask", text: "Approve the change", threadId: "root" },
    recap: "The candidate is verified.",
    archiveReady: false,
    optionalQuestion: null,
    pendingResults: 1,
    ...overrides,
  };
}

function chatWait(
  id: string,
  forText: string,
  conditions: InboxWaitView["conditions"],
): InboxWaitView {
  return {
    id,
    key: id,
    generation: 1,
    kind: "chat",
    status: "live",
    forText,
    marker: "[wait]",
    deadline: null,
    nextCheckAt: null,
    checkCount: 0,
    createdBy: "agent",
    ownerAccepted: false,
    conditions,
  };
}

beforeEach(() => {
  mocks.waits.mockResolvedValue({ waits: [] });
  mocks.ancestors.mockResolvedValue({
    threads: [{ threadId: "child", ancestorIds: ["parent", "root"] }],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ThreadInboxReason compact waits", () => {
  it("renders each chat and loop wait once with one trailing cancel action", async () => {
    const chief = chatWait("chief", "Chief release result", [
      { key: "chat:thr_chief", kind: "chat", label: "Chief", met: false },
    ]);

    const panel = chatWait("panel", "Question panel result", [
      {
        key: "chat:thr_panel",
        kind: "chat",
        label: "Question panel",
        met: false,
      },
    ]);

    const loop: InboxWaitView = {
      ...chatWait("loop", "Loop result", []),
      kind: "date",
      nextCheckAt: 1800000000000,
    };

    mocks.waits.mockResolvedValue({ waits: [chief, panel, loop, chief] });
    show(
      entry({
        state: "waiting",
        recap: null,
        reason: { kind: "wait", text: chief.forText, threadId: "root" },
      }),
    );

    await screen.findByRole("link", { name: "Chief" });
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(
      screen.getAllByRole("button", { name: /^Cancel wait:/u }),
    ).toHaveLength(3);

    for (const wait of [chief, panel, loop]) {
      expect(screen.getAllByText(wait.forText)).toHaveLength(1);

      const cancel = screen.getAllByRole("button", {
        name: `Cancel wait: ${wait.forText}`,
      });

      expect(cancel).toHaveLength(1);
      expect(cancel[0]?.textContent).toBe("Cancel");
    }

    expect(
      screen.getByRole("link", { name: "Question panel" }).getAttribute("href"),
    ).toBe("/projects/source-project/threads/thr_panel");
    expect(
      screen.getByText("Loop result").closest("li")?.querySelector("time")
        ?.dateTime,
    ).toBe(new Date(1800000000000).toISOString());
    mocks.actOnInbox.mockResolvedValue({ moveId: "move", entry: null });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel wait: Loop result" }),
    );
    await waitFor(() =>
      expect(mocks.actOnInbox).toHaveBeenCalledExactlyOnceWith({
        request: { action: "cancel-wait", threadId: "root", waitId: "loop" },
      }),
    );
  });
});

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
import {
  inboxEntrySchema,
  type InboxEntry,
  type InboxSnapshot,
  type InboxWaitView,
} from "@omnyo/domain";
import { ThreadInboxReason } from "./ThreadInboxReason";
import { MemoryRouter } from "react-router-dom";

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
      <MemoryRouter>
        <ThreadInboxReason
          threadId={threadId}
          parentThreadId={parentThreadId}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return inboxEntrySchema.parse({
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
  });
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

describe("ThreadInboxReason", () => {
  it("reports a live event wait through the owner action and refreshes it", async () => {
    const report: InboxWaitView = {
      ...chatWait("apple", "Apple responds", []),
      kind: "report",
      ownerAccepted: true,
    };

    mocks.waits.mockResolvedValue({ waits: [report] });
    mocks.actOnInbox.mockResolvedValue({ moveId: null, entry: null });
    show(entry());
    fireEvent.click(
      await screen.findByRole("button", {
        name: "It happened: Apple responds",
      }),
    );

    await waitFor(() =>
      expect(mocks.actOnInbox).toHaveBeenCalledExactlyOnceWith({
        request: {
          action: "happened",
          threadId: "root",
          waitId: "apple",
          note: null,
        },
      }),
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });

  it("names a single active wait next to its controls even when an owner question is shown", async () => {
    mocks.waits.mockResolvedValue({
      waits: [
        {
          ...chatWait("security", "GamesLike security-table check", []),
          kind: "check",
        },
      ],
    });
    show(entry());

    const cancel = await screen.findByRole("button", {
      name: "Cancel wait: GamesLike security-table check",
    });

    expect(screen.getByText("Approve the change")).toBeTruthy();

    const row = cancel.closest('[role="listitem"]');

    expect(row?.textContent).toContain("GamesLike security-table check");
    expect(row?.textContent).toContain("Scheduled check");
    expect(cancel.textContent).toBe("Cancel");
  });

  it("shows the scheduled check without the legacy archive decision", async () => {
    const nextCheckAt = 1800000000000;
    mocks.waits.mockResolvedValue({
      waits: [
        {
          ...chatWait("security", "GamesLike security-table check", []),
          kind: "check",
          nextCheckAt,
        },
      ],
    });
    show(
      entry({
        reason: { kind: "decision", text: "Archive?", threadId: "root" },
        card: {
          kind: "result",
          primary: {
            kind: "accept-proposal",
            proposalKind: "archive",
            label: "Archive?",
            waitId: "archive-proposal",
          },
          actions: [],
          causes: [],
          questionIds: [],
          questionMode: null,
          questionFrom: null,
          snoozedQuestionUntil: null,
          stillOnYou: null,
          notAssessed: null,
          failure: null,
          since: 0,
        },
      }),
    );

    const cancel = await screen.findByRole("button", {
      name: "Cancel wait: GamesLike security-table check",
    });

    expect(screen.queryByText("Archive?")).toBeNull();

    const row = cancel.closest('[role="listitem"]');

    expect(row?.textContent).toContain("GamesLike security-table check");
    expect(row?.querySelector("time")?.dateTime).toBe(
      new Date(nextCheckAt).toISOString(),
    );
  });

  it("cancels a child wait using its owning root and offers no report for a join", async () => {
    mocks.waits.mockResolvedValue({
      waits: [chatWait("build", "Build finishes", [])],
    });
    mocks.actOnInbox.mockResolvedValue({ moveId: "move", entry: null });
    show(entry(), "child", "parent");
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel wait: Build finishes",
      }),
    );

    await waitFor(() =>
      expect(mocks.actOnInbox).toHaveBeenCalledExactlyOnceWith({
        request: {
          action: "cancel-wait",
          threadId: "root",
          waitId: "build",
        },
      }),
    );
    expect(screen.queryByRole("button", { name: /It happened/u })).toBeNull();
  });

  it("shows the selected family wait and its known deadline in the root chat", async () => {
    mocks.waits.mockImplementation(
      async ({ threadId }: { threadId: string }) => ({
        waits:
          threadId === "child"
            ? [
                { ...chatWait("build", "Build finishes", []), kind: "date" },
                chatWait("different", "Unrelated child wait", []),
              ]
            : [],
      }),
    );
    mocks.actOnInbox.mockResolvedValue({ moveId: "move", entry: null });

    show(
      entry({
        state: "waiting",
        reason: { kind: "wait", text: "Build finishes", threadId: "root" },
        waiting: {
          group: "comes-back",
          reason: "Build finishes",
          waitId: "build",
          waitThreadId: "child",
          returnAt: 1800000000000,
          checkAt: null,
          checkCount: 0,
          checking: false,
          guaranteed: true,
          behind: null,
          retry: null,
          questionId: null,
        },
      }),
    );

    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(
      new Date(1800000000000).toISOString(),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Cancel wait: Build finishes",
      }),
    );
    await waitFor(() =>
      expect(mocks.actOnInbox).toHaveBeenCalledExactlyOnceWith({
        request: {
          action: "cancel-wait",
          threadId: "root",
          waitId: "build",
        },
      }),
    );
    expect(
      screen.queryByRole("button", {
        name: "Cancel wait: Unrelated child wait",
      }),
    ).toBeNull();
  });

  it("links each pending source to its project alongside the recorded reason while the family is working", async () => {
    mocks.waits.mockResolvedValue({
      waits: [
        chatWait("mac", "Mac source integration", [
          {
            key: "chat:thr_mac",
            kind: "chat",
            label: "Mac integration",
            met: false,
          },
        ]),
        chatWait("ios", "iOS acceptance and review", [
          {
            key: "chat:thr_ios",
            kind: "chat",
            label: "iOS acceptance",
            met: false,
          },
          { key: "chat:thr_review", kind: "chat", label: "Review", met: false },
          { key: "chat:thr_done", kind: "chat", label: "Done", met: true },
        ]),
        {
          ...chatWait("later", "Proposed follow-up", [
            {
              key: "chat:thr_review",
              kind: "chat",
              label: "Later",
              met: false,
            },
          ]),
          status: "proposed",
        },
      ],
    });
    show(entry({ state: "working" }));

    const mac = await screen.findByRole("link", { name: "Mac integration" });
    const ios = screen.getByRole("link", { name: "iOS acceptance" });
    const review = screen.getByRole("link", { name: "Review" });
    expect(mac.getAttribute("href")).toBe(
      "/projects/source-project/threads/thr_mac",
    );
    expect(ios.getAttribute("href")).toBe(
      "/projects/source-project/threads/thr_ios",
    );
    expect(review.getAttribute("href")).toBe(
      "/projects/source-project/threads/thr_review",
    );
    expect(mac.closest('[role="listitem"]')?.textContent).toContain(
      "Mac source integration",
    );
    expect(ios.closest('[role="listitem"]')?.textContent).toContain(
      "iOS acceptance and review",
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("Proposed follow-up")).toBeNull();
  });
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
      screen
        .getByText("Loop result")
        .closest('[role="listitem"]')
        ?.querySelector("time")?.dateTime,
    ).toBe(new Date(1800000000000).toISOString());
  });

  it("shows the external condition, dependency and next check for a waiting chat", () => {
    show(
      entry({
        state: "waiting",
        reason: {
          kind: "wait",
          text: "Apple's review response",
          threadId: "root",
        },
        waiting: {
          group: "comes-back",
          reason: "Apple's review response",
          waitId: "review",
          returnAt: null,
          checkAt: 1800000000000,
          checkCount: 0,
          checking: false,
          guaranteed: false,
          behind: "Review submission",
          retry: null,
          questionId: null,
        },
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Apple's review response",
    );
    expect(screen.getByText("Waiting for Review submission")).toBeDefined();
    expect(screen.getByRole("status").querySelector("time")?.dateTime).toBe(
      new Date(1800000000000).toISOString(),
    );
  });
  it("leaves current failures to the recovery card", () => {
    show(
      entry({
        state: "failed",
        reason: {
          kind: "failure",
          text: "Failed: Usage limit reached",
          threadId: "root",
        },
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("leaves the ready same-chat recap to the archive card", () => {
    const finished = entry({
      state: "finished",
      archiveReady: true,
      reason: { kind: "recap", text: "Verified change", threadId: "root" },
    });

    show(finished);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("leaves continuation provenance to its shared header control", () => {
    show(
      entry({
        state: "finished",
        reason: {
          kind: "recap",
          text: "Continued in Delivery closeout",
          threadId: "destination",
        },
        recap: null,
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("shows the ask and distinct recap", () => {
    show(entry());
    expect(screen.getByRole("status").textContent).toContain(
      "Needs you: Approve the change",
    );
    expect(screen.getByText("The candidate is verified.")).toBeTruthy();
    expect(mocks.ancestors).not.toHaveBeenCalled();
  });
  it("shows the chats waiting on this chat as calm linked chips", async () => {
    mocks.waits.mockResolvedValue({
      waitingChatIds: ["thr_coordinator"],
      waits: [],
    });
    show(
      entry({
        state: "waiting",
        reason: {
          kind: "deliver",
          text: "COORDINATOR PARASPEECH is waiting on this chat",
          threadId: "root",
        },
        recap: null,
      }),
    );

    const chip = await screen.findByRole("link", {
      name: "COORDINATOR PARASPEECH",
    });

    const row = chip.closest("p");

    expect(chip.getAttribute("href")).toBe(
      "/projects/source-project/threads/thr_coordinator",
    );
    expect(row?.textContent).toBe(
      "COORDINATOR PARASPEECH is waiting on this chat",
    );
    expect(row?.className).toContain("text-muted-foreground");
    expect(row?.className).not.toContain("text-warning-text");
    expect(screen.queryByText(/Needs you|Waiting:/u)).toBeNull();
  });

  it("names the waiting chats in plain text when they belong to another family member", async () => {
    show(
      entry({
        state: "waiting",
        reason: {
          kind: "deliver",
          text: "Release and Review are waiting on this chat",
          threadId: "root",
        },
        recap: null,
      }),
      "child",
      "parent",
    );

    expect((await screen.findByRole("status")).textContent).toBe(
      "Release and Review are waiting on this chat",
    );
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not repeat the opened chat's question", () => {
    show(
      entry({
        reason: { kind: "question", text: "Which option?", threadId: "root" },
      }),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("finds a child's family root regardless of ancestor order", async () => {
    show(entry(), "child", "parent");
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(mocks.ancestors).toHaveBeenCalledWith(
      expect.objectContaining({ threadIds: ["child", "parent"] }),
    );
  });
  it("shows a root question when a child is opened", async () => {
    show(
      entry({
        reason: { kind: "question", text: "Which option?", threadId: "root" },
      }),
      "child",
      "parent",
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "Which option?",
    );
  });
  it("finds a family root represented by a grouped run", async () => {
    const grouped = entry({
      threadId: "group",
      runs: [
        {
          threadId: "root",
          title: "Root",
          primary: { kind: "ok", thenWaits: null },
          causes: [],
          since: 0,
          latch: "member",
        },
      ],
    });

    show(grouped, "child", "parent");
    expect(await screen.findByRole("status")).toBeTruthy();
  });
  it("keeps stale completion assessments and working states out of the footer", () => {
    const view = show(
      entry({
        state: "finished",
        reason: {
          kind: "unassessed",
          text: "Finished, not assessed: the chat changed since its assessment",
          threadId: "root",
        },
      }),
    );

    expect(screen.queryByRole("status")).toBeNull();
    view.unmount();
    show(entry({ state: "working" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

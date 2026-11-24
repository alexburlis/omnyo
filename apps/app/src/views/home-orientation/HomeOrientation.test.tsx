// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxEntry, InboxSnapshot, ThreadListEntry } from "@omnyo/domain";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import { HomeGreeting, HomeStatusCards } from "./HomeOrientation";
import {
  homeCountsLine,
  homeGreetingText,
  homeInboxSummary,
  homeQuietCountsLine,
  ownerFirstName,
  type HomeInboxSummary,
} from "./home-orientation";

const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  callRpc: vi.fn(),
  setScope: vi.fn(),
  setOpen: vi.fn(),
  openThread: vi.fn(),
  catalog: { current: { entries: [] as unknown[] } },
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    experimental_inbox: { snapshot: mocks.snapshot },
    plugins: { callRpc: mocks.callRpc },
  },
}));

vi.mock("@/components/sidebar/project-rail-catalog", () => ({
  useProjectRailCatalog: () => mocks.catalog.current,
}));

vi.mock("@/components/sidebar/sidebarScope", () => ({
  INBOX_SIDEBAR_SCOPE: { kind: "inbox" },
  useSetSidebarScope: () => mocks.setScope,
}));

vi.mock("@/components/ui/sidebar", () => ({
  useSidebar: () => ({ setOpen: mocks.setOpen }),
}));

vi.mock("@omnyo/shared-ui/icon", () => ({ Icon: () => null }));

vi.mock("@/views/thread-detail/useOpenThreadInLayout", () => ({
  useOpenThreadInLayout: () => mocks.openThread,
}));

function entry(
  title: string,
  card: { kind: string; primary: string | Record<string, unknown> } | null,
  shelved = false,
  sortAt = 0,
  state: InboxEntry["state"] = card?.kind === "question"
    ? "needs-you"
    : card?.kind === "problem"
      ? "failed"
      : "finished",
): InboxEntry {
  return {
    threadId: title,
    projectId: "project-1",
    title,
    shelved,
    sortAt,
    view: "inbox",
    state,
    archiveReady:
      !shelved &&
      state === "finished" &&
      (card?.primary === "archive" ||
        (typeof card?.primary === "object" &&
          card.primary.kind === "archive-runs" &&
          card.primary.mode === "done")),
    card:
      card === null
        ? null
        : {
            kind: card.kind,
            primary:
              typeof card.primary === "string"
                ? { kind: card.primary }
                : card.primary,
          },
  } as unknown as InboxEntry;
}

const QUESTION = { kind: "question", primary: "answer" };

const RESULT_READY = { kind: "result", primary: "archive" };

function snapshot(inbox: InboxEntry[]): InboxSnapshot {
  return {
    revision: "1",
    generatedAt: 0,
    inbox,
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      inbox: inbox.length,
      needsYou: inbox.filter((entry) => entry.state === "needs-you").length,
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

function workingThread(id: string): ThreadListEntry {
  return makeThreadListEntry({
    id,
    work: makeThreadWorkSummary({
      primary: { label: "working", reason: { code: "turn", text: "Working" } },
    }),
  });
}

function setCatalogThreads(threads: ThreadListEntry[]): void {
  mocks.catalog.current = {
    entries: [{ project: { id: "project-1", name: "omnyo", threads } }],
  };
}

function renderWithClient(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(children, {
    wrapper: ({ children: tree }) => (
      <QueryClientProvider client={client}>{tree}</QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  mocks.snapshot.mockReset();
  mocks.snapshot.mockResolvedValue(snapshot([]));
  mocks.callRpc.mockResolvedValue({ account: null });
  setCatalogThreads([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("homeGreetingText", () => {
  it.each([
    [5, "Good morning"],
    [11, "Good morning"],
    [12, "Good afternoon"],
    [17, "Good afternoon"],
    [18, "Good evening"],
    [23, "Good evening"],
    [3, "Good evening"],
  ])("greets by the hour %i without a name", (hour, expected) => {
    expect(homeGreetingText(hour, null)).toBe(expected);
  });

  it("adds the first name when the owner is known", () => {
    expect(homeGreetingText(9, "Sawyer")).toBe("Good morning, Sawyer");
  });
});

describe("ownerFirstName", () => {
  const account = (
    name: string,
    githubLogin: string | null = null,
    handle: string | null = null,
  ) => ({ name, githubLogin, handle });

  it("takes the first word of a full name", () => {
    expect(ownerFirstName(account("Sawyer Hood", "sawyerhood"))).toBe("Sawyer");
  });

  it("returns null for an empty name", () => {
    expect(ownerFirstName(account("   "))).toBeNull();
  });

  it("returns null when the name is only the GitHub login", () => {
    expect(ownerFirstName(account("sawyerhood", "SawyerHood"))).toBeNull();
  });

  it("returns null when the name is only the handle", () => {
    expect(ownerFirstName(account("@sawyer", null, "sawyer"))).toBeNull();
  });

  it("returns null when the name is an email address", () => {
    expect(ownerFirstName(account("sawyer@example.com"))).toBeNull();
  });
});

describe("homeCountsLine", () => {
  it("names running chats and chats needing the owner", () => {
    expect(homeCountsLine({ running: 6, needs: 1 })).toBe(
      "6 chats running · 1 needs you",
    );
  });

  it("uses singular and plural wording", () => {
    expect(homeCountsLine({ running: 1, needs: 3 })).toBe(
      "1 chat running · 3 need you",
    );
  });

  it("omits zero parts", () => {
    expect(homeCountsLine({ running: 0, needs: 2 })).toBe("2 need you");
    expect(homeCountsLine({ running: 2, needs: 0 })).toBe("2 chats running");
  });

  it("returns null when every count is zero", () => {
    expect(homeCountsLine({ running: 0, needs: 0 })).toBeNull();
  });
});

describe("homeQuietCountsLine", () => {
  it("names running and ready chats", () => {
    expect(homeQuietCountsLine({ running: 19, ready: 1 })).toBe(
      "19 running · 1 ready to archive",
    );
  });

  it("returns null when neither is counted", () => {
    expect(homeQuietCountsLine({ running: 0, ready: 0 })).toBeNull();
  });
});

function brief(summary: HomeInboxSummary) {
  return {
    needs: summary.needs,
    titles: summary.needsRows.map((row) => row.title),
    ready: summary.ready,
  };
}

describe("homeInboxSummary", () => {
  it("keeps failed cards separate from questions", () => {
    const summary = homeInboxSummary(
      snapshot([
        entry("Answer me", QUESTION),
        entry("Usage limit", { kind: "problem", primary: "archive" }),
      ]),
    );

    expect(summary.needs).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failedRows.map((row) => row.title)).toEqual(["Usage limit"]);
  });
  it("splits server cards into needs-you and ready-to-archive", () => {
    expect(
      brief(
        homeInboxSummary(
          snapshot([
            entry("Answer me", QUESTION),
            entry("Done", RESULT_READY),
            entry("Failed", { kind: "problem", primary: "archive" }),
          ]),
        ),
      ),
    ).toEqual({ needs: 1, titles: ["Answer me"], ready: 1 });
  });

  it("keeps OK cards out of ready because their work continues", () => {
    expect(
      brief(
        homeInboxSummary(
          snapshot([
            entry("Waiting on Google", {
              kind: "result",
              primary: { kind: "ok", thenWaits: "Google's final data" },
            }),
            entry("Child still running", {
              kind: "result",
              primary: { kind: "ok", thenWaits: "Work continues" },
            }),
            entry("Answer me", QUESTION),
          ]),
        ),
      ),
    ).toEqual({
      needs: 1,
      titles: ["Answer me"],
      ready: 0,
    });
  });

  it("leaves shelved OK cards on the Shelf", () => {
    expect(
      brief(
        homeInboxSummary(
          snapshot([
            entry(
              "Shelved",
              { kind: "result", primary: { kind: "ok", thenWaits: null } },
              true,
            ),
            entry("Shelved question", QUESTION, true),
          ]),
        ),
      ),
    ).toEqual({ needs: 1, titles: ["Shelved question"], ready: 0 });
  });

  it("counts only done runs as ready, like the server", () => {
    expect(
      brief(
        homeInboxSummary(
          snapshot([
            entry("Older runs", {
              kind: "runs",
              primary: {
                kind: "archive-runs",
                mode: "older",
                threadIds: ["thr_a"],
              },
            }),
            entry("Done runs", {
              kind: "runs",
              primary: {
                kind: "archive-runs",
                mode: "done",
                threadIds: ["thr_b"],
              },
            }),
          ]),
        ),
      ),
    ).toEqual({ needs: 0, titles: [], ready: 1 });
  });

  it("keeps the first three chats with their thread, project, kind and time", () => {
    const summary = homeInboxSummary(
      snapshot([
        entry("One", QUESTION, false, 4),
        entry("Two", QUESTION, false, 3),
        entry("Three", QUESTION, false, 2),
        entry("Four", QUESTION, false, 1),
      ]),
    );

    expect(summary.needs).toBe(4);
    expect(summary.needsRows).toEqual([
      {
        threadId: "One",
        projectId: "project-1",
        title: "One",
        kind: "question",
        at: 4,
      },
      {
        threadId: "Two",
        projectId: "project-1",
        title: "Two",
        kind: "question",
        at: 3,
      },
      {
        threadId: "Three",
        projectId: "project-1",
        title: "Three",
        kind: "question",
        at: 2,
      },
    ]);
  });

  it("skips shelved ready chats like the Inbox feed", () => {
    expect(
      brief(homeInboxSummary(snapshot([entry("Shelved", RESULT_READY, true)]))),
    ).toEqual({ needs: 0, titles: [], ready: 0 });
  });
});

async function settledGreeting(): Promise<string | null> {
  const heading = screen.getByRole("heading", { level: 1 });
  await waitFor(() => expect(heading.className).not.toContain("invisible"));

  return heading.textContent;
}

describe("HomeGreeting", () => {
  it("greets the owner by first name when the account is known", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 9));
    mocks.callRpc.mockResolvedValue({
      account: { name: "Sawyer Hood", githubLogin: "sawyerhood", handle: null },
    });

    renderWithClient(<HomeGreeting layout="compact" />);

    expect(await screen.findByText("Good morning, Sawyer")).toBeTruthy();
  });

  it("greets without a name when the account name is only the GitHub login", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 9));
    mocks.callRpc.mockResolvedValue({
      account: { name: "sawyerhood", githubLogin: "sawyerhood", handle: null },
    });

    renderWithClient(<HomeGreeting layout="compact" />);

    expect(await settledGreeting()).toBe("Good morning");
  });

  it("greets without a name when the account plugin is unavailable", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 9));
    mocks.callRpc.mockRejectedValue(new Error("plugin not installed"));

    renderWithClient(<HomeGreeting layout="compact" />);

    expect(await settledGreeting()).toBe("Good morning");
  });

  it("greets without a name when no account is known", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 9, 15));

    renderWithClient(<HomeGreeting layout="compact" />);

    expect(await screen.findByText("Good afternoon")).toBeTruthy();
  });

  it("shows live counts from the Inbox and running chats", async () => {
    mocks.snapshot.mockResolvedValue(
      snapshot([
        entry("Answer", QUESTION),
        entry("one", null, false, 0, "working"),
        entry("two", null, false, 0, "working"),
      ]),
    );
    setCatalogThreads([workingThread("one"), workingThread("two")]);

    renderWithClient(<HomeGreeting layout="compact" />);

    expect(
      await screen.findByText("2 chats running · 1 needs you"),
    ).toBeTruthy();
  });

  it("leaves the counts line to the cards on the desktop stage", async () => {
    mocks.snapshot.mockResolvedValue(
      snapshot([
        entry("Answer", QUESTION),
        entry("one", null, false, 0, "working"),
        entry("two", null, false, 0, "working"),
      ]),
    );
    setCatalogThreads([workingThread("one"), workingThread("two")]);

    renderWithClient(<HomeGreeting layout="stage" />);

    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalled());
    expect(screen.getByRole("heading").className).toContain("text-display");
    expect(screen.queryByText(/running|need/)).toBeNull();
  });

  it("keeps the counts line empty when all counts are zero", async () => {
    renderWithClient(<HomeGreeting layout="compact" />);

    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalled());
    expect(screen.queryByText(/running|need/)).toBeNull();
  });
});

describe("Home count refresh", () => {
  it("shares one request across Home consumers", async () => {
    renderWithClient(
      <>
        <HomeGreeting layout="stage" />
        <HomeStatusCards />
      </>,
    );
    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(1));
  });
});

describe("HomeStatusCards", () => {
  it("shows failed chats separately in red without a Needs you count", async () => {
    mocks.snapshot.mockResolvedValue(
      snapshot([entry("Usage limit", { kind: "problem", primary: "archive" })]),
    );
    renderWithClient(<HomeStatusCards />);
    const row = await screen.findByRole("button", { name: "Open Usage limit" });
    expect(
      screen.getByRole("heading", { name: "Failed 1 chat" }).className,
    ).toContain("text-destructive-text");
    expect(row.textContent).toContain("FailedUsage limit");
    expect(screen.queryByRole("heading", { name: /^Needs you/ })).toBeNull();
  });
  it("hides the card when every count is zero", async () => {
    renderWithClient(<HomeStatusCards />);

    await waitFor(() => expect(mocks.snapshot).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId("home-status-cards")).toBeNull(),
    );
  });

  it("lists a chat that needs the owner with its kind, project and age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 13, 9));
    mocks.snapshot.mockResolvedValue(
      snapshot([entry("Relay", QUESTION, false, Date.now() - 12 * 60_000)]),
    );

    renderWithClient(<HomeStatusCards />);

    const row = await screen.findByRole("button", { name: "Open Relay" });

    expect(
      screen.getByRole("heading", { name: "Needs you 1 chat" }),
    ).toBeTruthy();
    expect(row.textContent).toBe("QuestionRelayomnyo · 12m ago");
  });

  it("opens the chat from its row", async () => {
    mocks.snapshot.mockResolvedValue(snapshot([entry("Relay", QUESTION)]));

    renderWithClient(<HomeStatusCards />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Relay" }));

    expect(mocks.openThread).toHaveBeenCalledWith(
      { projectId: "project-1", threadId: "Relay" },
      "replace",
    );
    expect(mocks.setScope).not.toHaveBeenCalled();
  });

  it("shows three chats and sends the rest to the Inbox", async () => {
    mocks.snapshot.mockResolvedValue(
      snapshot(["A", "B", "C", "D", "E"].map((t) => entry(t, QUESTION))),
    );

    renderWithClient(<HomeStatusCards />);

    await screen.findByRole("button", { name: "Open A" });

    expect(
      screen.getAllByRole("button", { name: /^Open [A-E]$/ }),
    ).toHaveLength(3);
    fireEvent.click(
      screen.getByRole("button", { name: "2 more need you, see all in Inbox" }),
    );

    expect(mocks.setScope).toHaveBeenCalledWith({ kind: "inbox" });
    expect(mocks.setOpen).toHaveBeenCalledWith(true);
  });

  it("keeps running and ready counts in the header when nothing needs the owner", async () => {
    mocks.snapshot.mockResolvedValue(
      snapshot([
        entry("Done", RESULT_READY),
        entry("one", null, false, 0, "working"),
      ]),
    );
    setCatalogThreads([workingThread("one")]);

    renderWithClient(<HomeStatusCards />);

    fireEvent.click(await screen.findByRole("button", { name: "Open Inbox" }));

    expect(
      screen.getByRole("heading", { name: "Nothing needs you" }),
    ).toBeTruthy();
    expect(screen.getByText("1 running · 1 ready to archive")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(mocks.setScope).toHaveBeenCalledWith({ kind: "inbox" });
  });

  it("offers the Inbox when only chats needing the owner are counted", async () => {
    mocks.snapshot.mockResolvedValue(snapshot([entry("Relay", QUESTION)]));

    renderWithClient(<HomeStatusCards />);

    expect(
      await screen.findByRole("button", { name: "Open Inbox" }),
    ).toBeTruthy();
  });
});

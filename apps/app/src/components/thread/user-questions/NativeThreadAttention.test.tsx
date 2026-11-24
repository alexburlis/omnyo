// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type {
  InboxSnapshot,
  ThreadCallback,
  ThreadQuestion,
} from "@omnyo/domain";
import type { SidebarBootstrapResponse } from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { sidebarNavigationQueryKey } from "@/hooks/queries/query-keys";
import { sdk } from "@/lib/sdk";
import { useThreadAttentionCache } from "@/hooks/queries/thread-attention";
import { threadAttentionQueryKey } from "@/hooks/cache-owners/thread-attention-cache-owner";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "@/hooks/cache-owners/inbox-snapshot-cache-owner";
import {
  installNativeShellForTest,
  removeNativeShellForTest,
} from "@/test/native-shell-test-utils";
import { NativeThreadAttention } from "./NativeThreadAttention";

vi.mock("@omnyo/shared-ui/icon", () => ({ Icon: () => null }));

vi.mock("@/lib/route-paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/route-paths")>()),
  getThreadRoutePath: ({ threadId }: { threadId: string }) =>
    `/threads/${threadId}`,
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    experimental_attention: { command: vi.fn(), snapshot: vi.fn() },
    threads: { get: vi.fn() },
  },
}));

vi.mock("@/lib/ws", () => ({
  wsManager: {
    onChanged: () => () => {},
    onConnected: () => () => {},
    onResumed: () => () => {},
  },
}));

vi.mock("../pending-interactions/PendingInteractionShell", () => ({
  PendingInteractionShell: ({
    children,
    errorMessage,
    headerActions,
    headerBadge,
    headerProgressRef,
    testId,
  }: ComponentProps<
    typeof import("../pending-interactions/PendingInteractionShell").PendingInteractionShell
  >) => (
    <div data-testid={testId}>
      {headerBadge}
      <div ref={headerProgressRef} />
      {headerActions}
      {children?.(true)}
      {errorMessage ? <div role="alert">{errorMessage}</div> : null}
    </div>
  ),
}));

const question: ThreadQuestion = {
  id: "question_one",
  threadId: "thr_one",
  revision: 1,
  state: "open",
  answer: null,
  queuedMessageId: null,
  answeredBy: null,
  createdAt: 1,
  updatedAt: 1,
  question: {
    key: null,
    prompt: "Choose a direction",
    context: null,
    shortLabel: "Question",
    mode: "required",
    multiSelect: false,
    allowFreeText: true,
    additiveNotes: true,
    delegable: false,
    options: [
      {
        value: "a",
        label: "Compact",
        description: null,
        preview: null,
        recommended: false,
      },
      {
        value: "b",
        label: "Detailed",
        description: null,
        preview: null,
        recommended: false,
      },
    ],
  },
};

const callback: ThreadCallback = {
  id: "wait_one",
  threadId: "thr_one",
  sourceThreadId: "thr_source",
  sourceTitle: "Resources review",
  reason: "Finish the installation after review",
  createdAt: 1,
  afterSeq: 1,
  matchText: "review-finished",
  sourceState: "needs-input",
};

function renderQuestionQueue(questions: ThreadQuestion[]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData(threadAttentionQueryKey, { questions, callbacks: [] });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );

  const view = (threadId = "thr_one") => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId={threadId} />
      </QueryClientProvider>
    </MemoryRouter>
  );

  return { client, view, ...render(view()) };
}

function pagerQuestion(id: string): ThreadQuestion {
  return {
    ...question,
    id,
    question: { ...question.question, prompt: `Choose ${id}` },
  };
}

it("updates the persisted wait age without sending work and keeps required input first", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T09:00:00Z"));

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const createdAt = Date.now() - 5 * 60_000;
  client.setQueryData(threadAttentionQueryKey, {
    questions: [question],
    callbacks: [{ ...callback, createdAt }],
  });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );

  const slot = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId="thr_one" />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  expect(screen.getByText("Started 5m ago")).toBeTruthy();
  expect(
    screen.getByText("The source chat is waiting for your answer."),
  ).toBeTruthy();
  const banner = screen.getByTestId("native-question-banner");
  const status = screen.getByRole("status");
  expect(
    banner.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  act(() => vi.advanceTimersByTime(60_000));
  expect(screen.getByText("Started 6m ago")).toHaveProperty(
    "dateTime",
    new Date(createdAt).toISOString(),
  );
  expect(sdk.experimental_attention.command).not.toHaveBeenCalled();
  slot.unmount();
  client.clear();
  vi.useRealTimers();
});

function pressed(name: string) {
  return screen.getByRole("radio", { name }).getAttribute("aria-checked");
}

function answeredResult(questions: ThreadQuestion[]) {
  return {
    questions: questions.map((entry) => ({
      ...entry,
      state: "answered" as const,
    })),
    callbacks: [],
    cleared: false,
    callbackMarker: null,
    routedToThreadId: null,
  };
}

it("collects every open question in one flow and sends them together once", async () => {
  const shell = installNativeShellForTest();
  const first = pagerQuestion("first");
  const second = { ...pagerQuestion("second"), revision: 2 };

  const third = {
    ...pagerQuestion("third"),
    question: { ...pagerQuestion("third").question, mode: "optional" as const },
  };

  const { client, unmount, view } = renderQuestionQueue([first, second, third]);

  const command = vi
    .spyOn(sdk.experimental_attention, "command")
    .mockResolvedValue(answeredResult([first, second]));

  expect(screen.getAllByTestId("native-question-banner")).toHaveLength(1);
  expect(screen.getByText("1 of 3")).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Choose first" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Add a note or your own answer" }),
  );
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "First note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.getByRole("radiogroup", { name: "Choose second" }),
  ).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(screen.getByRole("radiogroup", { name: "Choose third" })).toBeTruthy();
  expect(screen.getByText("3 · 1 optional")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Submit 1 answer" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("textbox")).toHaveProperty("value", "First note");
  expect(pressed("Compact")).toBe("true");
  unmount();
  render(view());
  expect(screen.getByRole("textbox")).toHaveProperty("value", "First note");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(pressed("Detailed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Submit 2 answers" }));
  await waitFor(() =>
    expect(screen.queryByTestId("native-question-banner")).toBeNull(),
  );
  expect(command).toHaveBeenCalledTimes(1);
  await waitFor(() =>
    expect(
      shell
        .messages()
        .filter(({ type }) => type === "haptic")
        .at(-1),
    ).toEqual({ type: "haptic", kind: "success" }),
  );
  expect(command.mock.calls[0]?.[0]).toEqual({
    threadId: "thr_one",
    command: {
      action: "answers",
      answers: [
        {
          id: "first",
          revision: 1,
          answer: { selected: ["a"], freeText: "First note" },
        },
        { id: "second", revision: 2, answer: { selected: ["b"] } },
        { id: "third", revision: 1, answer: null },
      ],
    },
  });
  client.clear();
});

it("skips every open question with one command", async () => {
  const first = pagerQuestion("first");
  const second = pagerQuestion("second");
  const { client } = renderQuestionQueue([first, second]);

  const command = vi
    .spyOn(sdk.experimental_attention, "command")
    .mockResolvedValue(answeredResult([]));

  fireEvent.click(screen.getByRole("button", { name: "Skip all" }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  expect(command.mock.calls[0]?.[0].command).toEqual({
    action: "answers",
    answers: [
      { id: "first", revision: 1, answer: null },
      { id: "second", revision: 1, answer: null },
    ],
  });
  client.clear();
});

it("keeps answers when questions arrive, are revised or are removed", async () => {
  const first = pagerQuestion("first");
  const second = pagerQuestion("second");
  const added = pagerQuestion("added");
  const other = { ...pagerQuestion("other"), threadId: "thr_other" };

  const { client, rerender, view } = renderQuestionQueue([
    first,
    second,
    other,
  ]);

  fireEvent.click(screen.getByRole("radio", { name: "Compact" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(screen.getByRole("radio", { name: "Detailed" }));
  rerender(view("thr_other"));
  expect(screen.getByRole("radiogroup", { name: "Choose other" })).toBeTruthy();
  expect(screen.getByText("1 of 1")).toBeTruthy();
  rerender(view());
  expect(
    screen.getByRole("radiogroup", { name: "Choose second" }),
  ).toBeTruthy();
  expect(pressed("Detailed")).toBe("true");
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [added, first, second, other],
      callbacks: [],
    }),
  );
  await waitFor(() => expect(screen.getByText("3 of 3")).toBeTruthy());
  expect(
    screen.getByRole("radiogroup", { name: "Choose second" }),
  ).toBeTruthy();
  expect(pressed("Detailed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(pressed("Compact")).toBe("true");
  const revised = { ...second, revision: 2 };
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [added, first, revised, other],
      callbacks: [],
    }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("radiogroup", { name: "Choose first" }),
    ).toBeTruthy(),
  );
  expect(pressed("Compact")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(
    screen.getByRole("radiogroup", { name: "Choose second" }),
  ).toBeTruthy();
  expect(pressed("Detailed")).toBe("false");
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [added, first, other],
      callbacks: [],
    }),
  );
  await waitFor(() => expect(screen.getByText("2 of 2")).toBeTruthy());
  expect(screen.getByRole("radiogroup", { name: "Choose first" })).toBeTruthy();
  expect(pressed("Compact")).toBe("true");
  expect(sdk.experimental_attention.command).not.toHaveBeenCalled();
  client.clear();
});

it("keeps dependency input in the source chat and lists its waiting chats until their callbacks clear", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const otherWait = {
    ...callback,
    id: "wait_other",
    threadId: "thr_other",
    reason: "Finish another delivery after review",
  };

  client.setQueryData(threadAttentionQueryKey, {
    questions: [{ ...question, threadId: "thr_source" }],
    callbacks: [callback, otherWait],
  });
  client.setQueryData(
    sidebarNavigationQueryKey(),
    makeSidebarBootstrapResponse({
      projects: [
        makeProjectWithThreadsResponse({
          threads: [
            makeThreadListEntry({ id: "thr_one", title: "Install Omnyo" }),
            makeThreadListEntry({ id: "thr_other", title: "Ship review" }),
          ],
        }),
      ],
    }),
  );
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );

  const view = (threadId: string) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId={threadId} />
      </QueryClientProvider>
    </MemoryRouter>
  );

  const slot = render(view("thr_one"));
  expect(screen.getByText("Waiting for another chat")).toBeTruthy();
  expect(screen.queryByTestId("native-question-banner")).toBeNull();
  slot.rerender(view("thr_source"));
  expect(screen.getByTestId("native-question-banner")).toBeTruthy();
  const waiting = screen.getByRole("region", { name: "Waiting on this chat" });
  expect(
    within(waiting)
      .getByRole("link", { name: "Install Omnyo" })
      .getAttribute("href"),
  ).toBe("/threads/thr_one");
  expect(
    within(waiting).getByRole("link", { name: "Ship review" }),
  ).toBeTruthy();
  expect(within(waiting).getByText(callback.reason)).toBeTruthy();
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [{ ...question, threadId: "thr_source" }],
      callbacks: [otherWait],
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("link", { name: "Install Omnyo" })).toBeNull(),
  );
  expect(screen.getByRole("link", { name: "Ship review" })).toBeTruthy();
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [{ ...question, threadId: "thr_source" }],
      callbacks: [],
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("region", { name: "Waiting on this chat" }),
    ).toBeNull(),
  );
  client.clear();
});

it("keeps an uncached waiting chat accessible and reports a navigation failure", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData(threadAttentionQueryKey, {
    questions: [],
    callbacks: [callback],
  });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );
  vi.spyOn(sdk.threads, "get").mockRejectedValue(new Error("Chat unavailable"));
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId="thr_source" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(screen.getByText(callback.reason)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open waiting chat" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "The chat could not be opened.",
  );
  expect(sdk.threads.get).toHaveBeenCalledWith({ threadId: "thr_one" });
  client.clear();
});

afterEach(() => {
  cleanup();
  removeNativeShellForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

it.each(["answer", "skip"] as const)(
  "removes a successfully %s question while the refresh is pending",
  async (action) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    client.setQueryData(threadAttentionQueryKey, {
      questions: [
        question,
        { ...question, id: "question_other", threadId: "thr_other" },
      ],
      callbacks: [],
    });
    vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
      () => new Promise(() => {}),
    );
    vi.spyOn(sdk.experimental_attention, "command").mockResolvedValue({
      questions: [
        { ...question, state: action === "answer" ? "answered" : "skipped" },
      ],
      callbacks: [],
      cleared: false,
      callbackMarker: null,
      routedToThreadId: null,
    });
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <NativeThreadAttention threadId="thr_one" />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId("native-question-banner")).toBeTruthy();

    if (action === "answer") {
      fireEvent.click(screen.getByText("Compact"));
      fireEvent.click(screen.getByRole("button", { name: /submit/i }));
    } else fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(screen.queryByTestId("native-question-banner")).toBeNull(),
    );
    expect(client.getQueryData(threadAttentionQueryKey)).toEqual({
      questions: [{ ...question, id: "question_other", threadId: "thr_other" }],
      callbacks: [],
    });
    client.clear();
  },
);

function AppShellAttention() {
  useThreadAttentionCache();

  return null;
}

it("shows a question on the first chat render once the app shell has loaded attention", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const snapshot = vi
    .spyOn(sdk.experimental_attention, "snapshot")
    .mockResolvedValue({ questions: [question], callbacks: [] });

  const shell = render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppShellAttention />
      </QueryClientProvider>
    </MemoryRouter>,
  );

  await waitFor(() =>
    expect(client.getQueryData(threadAttentionQueryKey)).toEqual({
      questions: [question],
      callbacks: [],
    }),
  );
  snapshot.mockImplementation(() => new Promise(() => {}));
  shell.rerender(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppShellAttention />
        <NativeThreadAttention threadId="thr_one" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(screen.getByTestId("native-question-banner")).toBeTruthy();
  client.clear();
});

it("keeps the question visible when submission fails", async () => {
  const shell = installNativeShellForTest();

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData(threadAttentionQueryKey, {
    questions: [question],
    callbacks: [],
  });
  vi.spyOn(sdk.experimental_attention, "command").mockRejectedValue(
    new Error("Submission failed"),
  );
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId="thr_one" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  await screen.findAllByText("Submission failed");
  await waitFor(() =>
    expect(shell.messages()).toEqual([{ type: "haptic", kind: "error" }]),
  );
  expect(screen.getByTestId("native-question-banner")).toBeTruthy();
  expect(client.getQueryData(threadAttentionQueryKey)).toEqual({
    questions: [question],
    callbacks: [],
  });
  client.clear();
});

it("keeps an answer pending across chat switches and applies success after unmount", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const otherQuestion = {
    ...question,
    id: "question_other",
    threadId: "thr_other",
  };

  client.setQueryData(threadAttentionQueryKey, {
    questions: [question, otherQuestion],
    callbacks: [],
  });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );

  let resolveCommand!: (
    result: Awaited<ReturnType<typeof sdk.experimental_attention.command>>,
  ) => void;

  const command = vi
    .spyOn(sdk.experimental_attention, "command")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );

  const view = (threadId: string) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId={threadId} />
      </QueryClientProvider>
    </MemoryRouter>
  );

  const slot = render(view("thr_one"));
  fireEvent.click(screen.getByText("Compact"));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  slot.rerender(view("thr_other"));
  slot.rerender(view("thr_one"));
  expect(screen.queryByTestId("native-question-banner")).toBeNull();
  expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
  expect(command).toHaveBeenCalledTimes(1);
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [question, otherQuestion],
      callbacks: [],
    }),
  );
  expect(screen.queryByTestId("native-question-banner")).toBeNull();
  slot.rerender(view("thr_other"));
  resolveCommand({
    questions: [{ ...question, state: "answered" }],
    callbacks: [],
    cleared: false,
    callbackMarker: null,
    routedToThreadId: null,
  });
  await waitFor(() =>
    expect(client.getQueryData(threadAttentionQueryKey)).toEqual({
      questions: [otherQuestion],
      callbacks: [],
    }),
  );
  expect(screen.getByRole("radio", { name: "Compact" })).toBeTruthy();
  client.clear();
});

it("restores the draft and submission error when returning after a failed answer", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData(threadAttentionQueryKey, {
    questions: [question],
    callbacks: [],
  });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );
  let rejectCommand!: (error: Error) => void;

  const command = vi
    .spyOn(sdk.experimental_attention, "command")
    .mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCommand = reject;
        }),
    );

  const view = (threadId: string) => (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId={threadId} />
      </QueryClientProvider>
    </MemoryRouter>
  );

  const slot = render(view("thr_one"));
  fireEvent.click(screen.getByText("Compact"));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  slot.rerender(view("thr_other"));
  await act(async () => rejectCommand(new Error("Answer delivery failed")));
  slot.rerender(view("thr_one"));
  expect(screen.getByText("Answer delivery failed")).toBeTruthy();
  expect(
    screen.getByRole("radio", { name: "Compact" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(screen.getByRole("button", { name: "Submit answer" })).toHaveProperty(
    "disabled",
    false,
  );
  expect(
    localStorage.getItem("omnyo.question-draft.v1:thr_one:native-questions"),
  ).not.toBeNull();
  client.clear();
});

it("does not lock or remove a newer question revision when an older answer completes", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  client.setQueryData(threadAttentionQueryKey, {
    questions: [question],
    callbacks: [],
  });
  vi.spyOn(sdk.experimental_attention, "snapshot").mockImplementation(
    () => new Promise(() => {}),
  );

  let resolveCommand!: (
    result: Awaited<ReturnType<typeof sdk.experimental_attention.command>>,
  ) => void;

  const command = vi
    .spyOn(sdk.experimental_attention, "command")
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCommand = resolve;
        }),
    );

  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NativeThreadAttention threadId="thr_one" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByText("Compact"));
  fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
  await waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  const nextQuestion = { ...question, revision: 2 };
  await act(async () =>
    client.setQueryData(threadAttentionQueryKey, {
      questions: [nextQuestion],
      callbacks: [],
    }),
  );
  fireEvent.click(await screen.findByText("Detailed"));
  expect(screen.getByRole("button", { name: "Submit answer" })).toHaveProperty(
    "disabled",
    false,
  );
  await act(async () =>
    resolveCommand({
      questions: [{ ...question, state: "answered" }],
      callbacks: [],
      cleared: false,
      callbackMarker: null,
      routedToThreadId: null,
    }),
  );
  expect(client.getQueryData(threadAttentionQueryKey)).toEqual({
    questions: [nextQuestion],
    callbacks: [],
  });
  expect(
    screen
      .getByRole("radio", { name: "Detailed" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  client.clear();
});

it.each(["answer", "skip"] as const)(
  "shows the %s at once in the sidebar and Inbox, and restores both when it fails",
  async (action) => {
    const { client } = renderQuestionQueue([question]);

    const waiting = makeThreadListEntry({
      id: "thr_one",
      status: "active",
      work: makeThreadWorkSummary({
        primary: {
          label: "needs-you",
          reason: { code: "required-input", text: "Choose a direction" },
        },
        requiredInput: [
          { id: "question_one", label: "Choose a direction", kind: "question" },
        ],
      }),
    });

    client.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarBootstrapResponse({
        projects: [makeProjectWithThreadsResponse({ threads: [waiting] })],
      }),
    );

    const inbox: InboxSnapshot = {
      revision: "rev",
      generatedAt: 1,
      inbox: [
        {
          threadId: "thr_one",
          projectId: "proj_1",
          title: "Install Omnyo",
          shelved: false,
          automationId: null,
          state: "needs-you",
          reason: { kind: "question", text: "Choose", threadId: "thr_one" },
          recap: null,
          archiveReady: false,
          optionalQuestion: null,
          pendingResults: 0,
          view: "inbox",
          card: {
            kind: "question",
            causes: [],
            primary: { kind: "answer" },
            actions: [],
            questionIds: ["question_one"],
            questionMode: "required",
            questionFrom: null,
            snoozedQuestionUntil: null,
            stillOnYou: null,
            notAssessed: null,
            failure: null,
            since: 1,
          },
          waiting: null,
          running: null,
          runs: null,
          incident: null,
          sortAt: 1,
          latch: "inbox",
        },
      ],
      waiting: [],
      running: [],
      shelf: [],
      counts: {
        needsYou: 1,
        inbox: 1,
        questions: 1,
        running: 0,
        waiting: 0,
        onYou: [],
        nextBackAt: null,
      },
      lastMove: null,
    };

    client.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, inbox);

    let rejectCommand!: (error: Error) => void;

    vi.spyOn(sdk.experimental_attention, "command").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectCommand = reject;
        }),
    );

    const sidebarThread = () =>
      client
        .getQueryData<SidebarBootstrapResponse>(sidebarNavigationQueryKey())
        ?.projects.flatMap((project) => project.threads)
        .find((thread) => thread.id === "thr_one");

    if (action === "answer") {
      fireEvent.click(screen.getByText("Compact"));
      fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    } else fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() =>
      expect(sidebarThread()?.work?.primary.label).toBe("working"),
    );
    expect(readPredictedInboxSnapshot(client)?.running).toMatchObject([
      { threadId: "thr_one", view: "running" },
    ]);
    expect(readPredictedInboxSnapshot(client)?.inbox).toEqual([]);

    await act(async () => rejectCommand(new Error("Answer delivery failed")));

    expect(sidebarThread()).toEqual(waiting);
    expect(readPredictedInboxSnapshot(client)).toBe(inbox);
    expect(screen.getByTestId("native-question-banner")).toBeTruthy();
    client.clear();
  },
);

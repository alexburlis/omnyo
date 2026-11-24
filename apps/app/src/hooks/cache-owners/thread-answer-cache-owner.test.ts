import { describe, expect, it } from "vitest";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import type {
  SidebarBootstrapResponse,
  ThreadPendingInteractionsResponse,
} from "@omnyo/server-contract";
import type {
  InboxCard,
  InboxEntry,
  InboxSnapshot,
  PendingInteraction,
  ThreadListEntry,
} from "@omnyo/domain";
import {
  sidebarNavigationQueryKey,
  threadPendingInteractionsQueryKey,
} from "../queries/query-keys";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  beginResolvedThreadInteractionTransaction,
  beginResolvedThreadQuestionTransaction,
  withResolvedThreadInteraction,
  withResolvedThreadQuestion,
} from "./thread-answer-cache-owner";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "./inbox-snapshot-cache-owner";

const answered = { questionId: "q_required", resolution: "answered" } as const;

function waitingThread(): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_waiting",
    work: makeThreadWorkSummary({
      primary: {
        label: "needs-you",
        reason: { code: "question", text: "A question needs your answer." },
      },
      requiredInput: [{ id: "q_required", label: "Pick", kind: "question" }],
      optionalInput: [{ id: "q_optional", label: "Maybe", kind: "question" }],
    }),
    attention: {
      kind: "required-answer",
      requiredCount: 1,
      optionalCount: 1,
      callback: null,
    },
  });
}

function navigation(thread: ThreadListEntry): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [makeProjectWithThreadsResponse({ threads: [thread] })],
  });
}

function cachedThread(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
): ThreadListEntry | undefined {
  return queryClient
    .getQueryData<SidebarBootstrapResponse>(sidebarNavigationQueryKey())
    ?.projects.flatMap((project) => project.threads)
    .find((thread) => thread.id === "thr_waiting");
}

describe("answered thread questions", () => {
  it("clears the answered required input and stops asking for the owner", () => {
    const thread = withResolvedThreadQuestion(waitingThread(), answered);

    expect(thread.work?.primary.label).toBe("working");
    expect(thread.work?.requiredInput).toEqual([]);
    expect(thread.work?.optionalInput).toHaveLength(1);
    expect(thread.attention).toMatchObject({
      kind: "optional-input",
      requiredCount: 0,
      optionalCount: 1,
    });
  });

  it("shows a skipped question's chat as open, not working", () => {
    const thread = withResolvedThreadQuestion(waitingThread(), {
      questionId: "q_required",
      resolution: "skipped",
    });

    expect(thread.work?.primary.label).toBe("open");
    expect(thread.work?.requiredInput).toEqual([]);
  });

  it("keeps the thread unchanged once the server no longer lists the input", () => {
    const thread = withResolvedThreadQuestion(waitingThread(), answered);

    expect(withResolvedThreadQuestion(thread, answered)).toBe(thread);
  });

  it("keeps needs-you while another required input remains", () => {
    const thread = waitingThread();

    const projected = withResolvedThreadQuestion(
      {
        ...thread,
        work:
          thread.work === null
            ? null
            : {
                ...thread.work,
                requiredInput: [
                  ...thread.work.requiredInput,
                  { id: "q_other", label: "Other", kind: "question" },
                ],
              },
      },
      answered,
    );

    expect(projected.work?.primary.label).toBe("needs-you");
    expect(projected.attention?.kind).toBe("required-answer");
  });

  it("re-applies to stale fetched sidebar data until released", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      navigation(waitingThread()),
    );

    const hold = await beginResolvedThreadQuestionTransaction(queryClient, {
      threadId: "thr_waiting",
      questionIds: ["q_required"],
      resolution: "answered",
    });

    expect(cachedThread(queryClient)?.work?.primary.label).toBe("working");

    await refetchNavigation(queryClient, waitingThread());
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("working");

    hold.release();
    await refetchNavigation(queryClient, waitingThread());
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("needs-you");
  });

  it("puts the chat back to needs-you when the answer fails, even after a stale refetch", async () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      navigation(waitingThread()),
    );

    const hold = await beginResolvedThreadQuestionTransaction(queryClient, {
      threadId: "thr_waiting",
      questionIds: ["q_required", "q_optional"],
      resolution: "answered",
    });

    expect(cachedThread(queryClient)?.work?.optionalInput).toEqual([]);
    await refetchNavigation(queryClient, waitingThread());
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("working");

    hold.rollback();
    expect(cachedThread(queryClient)).toEqual(waitingThread());

    await refetchNavigation(queryClient, waitingThread());
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("needs-you");
  });
});

function permissionThread(
  overrides: Partial<ThreadListEntry> = {},
): ThreadListEntry {
  return makeThreadListEntry({
    id: "thr_waiting",
    status: "active",
    hasPendingInteraction: true,
    work: makeThreadWorkSummary({
      primary: {
        label: "needs-you",
        reason: { code: "required-input", text: "Approve" },
      },
      requiredInput: [
        { id: "pint_1", label: "Approve", kind: "permission" },
        { id: "pint_2", label: "Approve", kind: "permission" },
      ],
    }),
    ...overrides,
  });
}

describe("resolved provider interactions", () => {
  it("keeps needs-you and the pending flag while another interaction waits", () => {
    const thread = withResolvedThreadInteraction(permissionThread(), {
      interactionId: "pint_1",
      lastInteraction: false,
    });

    expect(thread.work?.primary.label).toBe("needs-you");
    expect(thread.work?.requiredInput.map((input) => input.id)).toEqual([
      "pint_2",
    ]);
    expect(thread.hasPendingInteraction).toBe(true);
  });

  it("shows a running chat as working once its last interaction is answered", () => {
    const base = permissionThread();

    const thread = withResolvedThreadInteraction(
      {
        ...base,
        work: base.work && {
          ...base.work,
          requiredInput: base.work.requiredInput.slice(0, 1),
        },
      },
      { interactionId: "pint_1", lastInteraction: true },
    );

    expect(thread.work?.primary.label).toBe("working");
    expect(thread.work?.requiredInput).toEqual([]);
    expect(thread.hasPendingInteraction).toBe(false);
  });

  it("does not claim working for a chat whose turn is not running", () => {
    const base = permissionThread({ status: "idle" });

    const thread = withResolvedThreadInteraction(
      {
        ...base,
        work: base.work && {
          ...base.work,
          requiredInput: [
            {
              id: "interaction:thr_waiting",
              label: "Approve",
              kind: "permission",
            },
          ],
        },
      },
      { interactionId: "pint_1", lastInteraction: true },
    );

    expect(thread.work?.primary.label).toBe("open");
    expect(thread.hasPendingInteraction).toBe(false);
  });
});

function inboxCard(overrides: Partial<InboxCard> = {}): InboxCard {
  return {
    kind: "question",
    causes: [],
    primary: { kind: "answer" },
    actions: [],
    questionIds: ["q_1"],
    questionMode: "required",
    questionFrom: null,
    snoozedQuestionUntil: null,
    stillOnYou: null,
    notAssessed: null,
    failure: null,
    since: 1,
    ...overrides,
  };
}

function inboxEntry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    threadId: "thr_waiting",
    projectId: "proj_1",
    title: "Waiting",
    shelved: false,
    automationId: null,
    state: "needs-you",
    reason: { kind: "question", text: "Pick", threadId: "thr_waiting" },
    recap: null,
    archiveReady: false,
    optionalQuestion: null,
    pendingResults: 0,
    view: "inbox",
    card: inboxCard(),
    waiting: null,
    running: null,
    runs: null,
    incident: null,
    sortAt: 1,
    latch: "inbox",
    ...overrides,
  };
}

function inbox(entries: InboxEntry[]): InboxSnapshot {
  return {
    revision: "rev",
    generatedAt: 1,
    inbox: entries,
    waiting: [],
    running: [],
    shelf: [],
    counts: {
      needsYou: entries.length,
      inbox: entries.length,
      questions: entries.length,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

function interaction(id: string): PendingInteraction {
  return {
    id,
    threadId: "thr_waiting",
    turnId: "turn_1",
    providerId: "claude-code",
    providerThreadId: "pt_1",
    providerRequestId: `req_${id}`,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
    resolution: null,
    payload: {
      kind: "approval",
      reason: null,
      availableDecisions: ["allow_once", "deny"],
      subject: {
        kind: "plan",
        itemId: "plan-1",
        plan: "# Plan",
        planFilePath: null,
      },
    },
  };
}

function seedInteraction(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
) {
  const pending = interaction("pint_1");
  const base = permissionThread();

  const thread = {
    ...base,
    work: base.work && {
      ...base.work,
      requiredInput: base.work.requiredInput.slice(0, 1),
    },
  };

  queryClient.setQueryData(threadPendingInteractionsQueryKey("thr_waiting"), [
    pending,
  ]);
  queryClient.setQueryData(sidebarNavigationQueryKey(), navigation(thread));
  queryClient.setQueryData(
    INBOX_SNAPSHOT_QUERY_KEY,
    inbox([inboxEntry({ card: inboxCard({ questionIds: ["pint_1"] }) })]),
  );

  return { pending, thread };
}

function refetchPending(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  data: ThreadPendingInteractionsResponse,
) {
  return queryClient.fetchQuery({
    queryKey: threadPendingInteractionsQueryKey("thr_waiting"),
    queryFn: () => data,
    staleTime: 0,
  });
}

function cachedPending(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
) {
  return queryClient.getQueryData<ThreadPendingInteractionsResponse>(
    threadPendingInteractionsQueryKey("thr_waiting"),
  );
}

describe("resolving a provider interaction", () => {
  it("removes the card at once and keeps it hidden until the server finishes resolving", async () => {
    const { queryClient } = createQueryClientTestHarness();
    const { pending, thread } = seedInteraction(queryClient);

    const transaction = await beginResolvedThreadInteractionTransaction(
      queryClient,
      { threadId: "thr_waiting", interactionId: "pint_1" },
    );

    expect(cachedPending(queryClient)).toEqual([]);
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("working");
    expect(readPredictedInboxSnapshot(queryClient)?.running).toHaveLength(1);

    await refetchPending(queryClient, [pending]);
    await refetchNavigation(queryClient, thread);
    expect(cachedPending(queryClient)).toEqual([]);
    expect(cachedThread(queryClient)?.hasPendingInteraction).toBe(false);

    transaction.settle("resolving");
    await refetchPending(queryClient, [{ ...pending, status: "resolving" }]);
    await refetchNavigation(queryClient, thread);
    expect(cachedPending(queryClient)).toEqual([]);
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("working");

    await refetchPending(queryClient, []);
    await refetchNavigation(queryClient, thread);
    expect(cachedThread(queryClient)?.work?.primary.label).toBe("needs-you");
  });

  it("restores the card, the list entry and the Inbox when the answer fails", async () => {
    const { queryClient } = createQueryClientTestHarness();
    const { pending, thread } = seedInteraction(queryClient);

    const transaction = await beginResolvedThreadInteractionTransaction(
      queryClient,
      { threadId: "thr_waiting", interactionId: "pint_1" },
    );

    await refetchPending(queryClient, [pending]);
    transaction.rollback();

    expect(cachedPending(queryClient)).toEqual([pending]);
    expect(cachedThread(queryClient)).toEqual(thread);
    expect(readPredictedInboxSnapshot(queryClient)?.inbox).toHaveLength(1);
    expect(readPredictedInboxSnapshot(queryClient)?.running).toEqual([]);
  });
});

async function refetchNavigation(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  thread: ThreadListEntry,
) {
  await queryClient.fetchQuery({
    queryKey: sidebarNavigationQueryKey(),
    queryFn: () => navigation(thread),
    staleTime: 0,
  });
}

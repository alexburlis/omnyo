import { describe, expect, it } from "vitest";
import type { InboxSnapshot, ThreadListEntry } from "@omnyo/domain";
import type {
  SidebarBootstrapResponse,
  ThreadContinueState,
  ThreadResponse,
} from "@omnyo/server-contract";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import {
  sidebarNavigationQueryKey,
  systemAppUpdateQueryKey,
  threadQueryKey,
} from "../queries/query-keys";
import {
  INBOX_SNAPSHOT_QUERY_KEY,
  readPredictedInboxSnapshot,
} from "./inbox-snapshot-cache-owner";
import { readSidebarNavigation } from "./query-cache";
import {
  beginContinueThreadTransaction,
  rollbackContinueThreadTransaction,
  settleContinueThreadTransaction,
  threadContinuationQueryKey,
} from "./thread-continuation-cache-owner";

type QueryClient = ReturnType<
  typeof createQueryClientTestHarness
>["queryClient"];

const THREAD_ID = "thr_paused";

function pausedListEntry(): ThreadListEntry {
  return makeThreadListEntry({
    id: THREAD_ID,
    status: "error",
    work: makeThreadWorkSummary({
      failures: [
        { code: "turn-failed", text: "Model at capacity", sourceId: null },
      ],
    }),
  });
}

function navigation(thread: ThreadListEntry): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [makeProjectWithThreadsResponse({ threads: [thread] })],
  });
}

function pausedInbox(): InboxSnapshot {
  return {
    revision: "rev",
    generatedAt: 1,
    inbox: [
      {
        threadId: THREAD_ID,
        projectId: "proj_1",
        title: "Paused",
        shelved: false,
        automationId: null,
        state: "needs-you",
        reason: { kind: "failure", text: "Paused", threadId: THREAD_ID },
        recap: null,
        archiveReady: false,
        optionalQuestion: null,
        pendingResults: 0,
        view: "inbox",
        card: {
          kind: "problem",
          causes: [],
          primary: {
            kind: "resume",
            targetThreadId: THREAD_ID,
            targetTitle: null,
          },
          actions: [],
          questionIds: [],
          questionMode: null,
          questionFrom: null,
          snoozedQuestionUntil: null,
          stillOnYou: null,
          notAssessed: null,
          failure: {
            threadId: THREAD_ID,
            reason: "Model at capacity",
            queuedCount: 0,
            scheduledCount: 0,
          },
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
      questions: 0,
      running: 0,
      waiting: 0,
      onYou: [],
      nextBackAt: null,
    },
    lastMove: null,
  };
}

function seed(action: ThreadContinueState["action"]) {
  const { queryClient } = createQueryClientTestHarness();
  const thread = makeThreadResponse({ id: THREAD_ID, status: "error" });
  const listEntry = pausedListEntry();
  const inbox = pausedInbox();

  queryClient.setQueryData(threadQueryKey(THREAD_ID), thread);
  queryClient.setQueryData(sidebarNavigationQueryKey(), navigation(listEntry));
  queryClient.setQueryData(INBOX_SNAPSHOT_QUERY_KEY, inbox);
  queryClient.setQueryData<ThreadContinueState>(
    threadContinuationQueryKey(THREAD_ID),
    {
      threadId: THREAD_ID,
      available: true,
      pending: false,
      action,
      message: null,
      retryAt: null,
      retryAttempt: null,
      model: null,
      canRetryNow: false,
      cause: null,
      failureLabel: null,
      permissionMode: null,
    },
  );

  return { queryClient, thread, listEntry, inbox };
}

function sidebarThread(queryClient: QueryClient) {
  return queryClient
    .getQueryData<SidebarBootstrapResponse>(sidebarNavigationQueryKey())
    ?.projects.flatMap((project) => project.threads)
    .find((thread) => thread.id === THREAD_ID);
}

function detail(queryClient: QueryClient) {
  return queryClient.getQueryData<ThreadResponse>(threadQueryKey(THREAD_ID));
}

describe("continuing a paused chat", () => {
  it("shows the retried chat running everywhere and survives a stale sidebar read", async () => {
    const { queryClient, listEntry } = seed("retry");

    const transaction = await beginContinueThreadTransaction(
      queryClient,
      THREAD_ID,
    );

    expect(transaction).not.toBeNull();
    expect(detail(queryClient)?.status).toBe("active");
    expect(sidebarThread(queryClient)).toMatchObject({
      status: "active",
      work: { primary: { label: "working" }, failures: [] },
    });
    expect(readPredictedInboxSnapshot(queryClient)?.running).toMatchObject([
      { threadId: THREAD_ID, view: "running" },
    ]);

    await queryClient.fetchQuery({
      queryKey: sidebarNavigationQueryKey(),
      queryFn: () =>
        readSidebarNavigation(queryClient, async () => navigation(listEntry)),
      staleTime: 0,
    });
    expect(sidebarThread(queryClient)?.status).toBe("active");

    settleContinueThreadTransaction(queryClient, transaction, "sent");
    expect(detail(queryClient)?.status).toBe("active");
  });

  it.each(["blocked", "pending"] as const)(
    "puts the chat back to paused when the server answers %s",
    async (outcome) => {
      const { queryClient, thread, listEntry, inbox } = seed("continue");

      const transaction = await beginContinueThreadTransaction(
        queryClient,
        THREAD_ID,
      );

      settleContinueThreadTransaction(queryClient, transaction, outcome);

      expect(detail(queryClient)).toEqual(thread);
      expect(sidebarThread(queryClient)).toEqual(listEntry);
      expect(readPredictedInboxSnapshot(queryClient)).toBe(inbox);
    },
  );

  it("puts the chat back to paused when the request fails", async () => {
    const { queryClient, thread, listEntry, inbox } = seed("retry");

    const transaction = await beginContinueThreadTransaction(
      queryClient,
      THREAD_ID,
    );

    rollbackContinueThreadTransaction(queryClient, transaction);

    expect(detail(queryClient)).toEqual(thread);
    expect(sidebarThread(queryClient)).toEqual(listEntry);
    expect(readPredictedInboxSnapshot(queryClient)).toBe(inbox);
  });

  it("predicts nothing for a workspace restore or a held start", async () => {
    const restore = seed("restore-workspace");

    expect(
      await beginContinueThreadTransaction(restore.queryClient, THREAD_ID),
    ).toBeNull();
    expect(detail(restore.queryClient)?.status).toBe("error");

    const held = seed("retry");
    held.queryClient.setQueryData(systemAppUpdateQueryKey(), {
      newTurnsPausedForUpdate: true,
    });

    expect(
      await beginContinueThreadTransaction(held.queryClient, THREAD_ID),
    ).toBeNull();
    expect(sidebarThread(held.queryClient)).toEqual(held.listEntry);
  });
});

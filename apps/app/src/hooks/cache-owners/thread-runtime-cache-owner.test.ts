import type { ThreadListEntry, ThreadQueuedMessage } from "@omnyo/domain";
import type {
  SidebarBootstrapResponse,
  ThreadSearchResponse,
  ThreadTimelineResponse,
} from "@omnyo/server-contract";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  makeThreadListEntry as makeThreadListEntryFixture,
  makeThreadQueuedMessage as makeThreadQueuedMessageFixture,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  makeThreadResponse,
  makeThreadTimelineResponse as makeTimelineResponse,
} from "@/test/fixtures/thread-responses";
import { conversationRow, turnRow } from "@/test/fixtures/thread-timeline-rows";
import { displayedTimelineRows } from "@/test/displayed-timeline-rows";
import { mergePendingComposerQueuedMessages } from "./pending-composer-cache-owner";
import {
  beginPendingSentMessageRead,
  getPendingSentMessages,
  withPendingSentMessages,
} from "./pending-sent-messages";
import type { SendThreadMessageMutationRequest } from "../mutations/mutation-request-types";
import {
  sidebarNavigationQueryKey,
  threadListQueryKey,
  threadPluginBootstrapQueryKey,
  systemAppUpdateQueryKey,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadSearchQueryKey,
  threadTimelineQueryKey,
} from "../queries/query-keys";
import { threadDefaultExecutionOptionsQueryKey } from "../queries/thread-default-execution-options-query";
import {
  applyQueuedMessageCreateResult,
  applyQueuedMessageSendResult,
  applyQueuedMessageUpdateResult,
  applySendThreadMessageSuccess,
  applyThreadGoalClearResult,
  applyThreadPlanCancellationResult,
  beginCreateQueuedMessageTransaction,
  beginRemoveQueuedMessageTransaction,
  beginReorderQueuedMessageTransaction,
  beginSendQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  beginUpdateQueuedMessageTransaction,
  rollbackCreateQueuedMessageTransaction,
  rollbackRemoveQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackUpdateQueuedMessageTransaction,
} from "./thread-runtime-cache-owner";

function makeThreadListEntry(id = "thread-1"): ThreadListEntry {
  return makeThreadListEntryFixture({
    id,
    projectId: "project-1",
    environmentId: "env-1",
    status: "active",
    lastReadAt: null,
    latestAttentionAt: 50,
    createdAt: 1,
    updatedAt: 1,
    runtime: {
      displayStatus: "active",
    },
    activity: {
      activeWorkflowCount: 0,
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activePlanModeCount: 1,
      activeGoalCount: 1,
      activeSubagentCount: 0,
    },
    environmentHostId: "host-1",
    environmentName: "Environment",
    environmentBranchName: "main",
  });
}

function makeSidebarNavigation(
  threads: ThreadListEntry[],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "project-1",
        name: "Project",
        createdAt: 1,
        updatedAt: 1,
        threads,
      }),
    ],
  });
}

function makeSearchResponse(thread: ThreadListEntry): ThreadSearchResponse {
  return {
    active: {
      total: 1,
      results: [{ thread, matches: [] }],
    },
    archived: { total: 0, results: [] },
  };
}

function makeQueuedMessage(
  message: Partial<ThreadQueuedMessage> = {},
): ThreadQueuedMessage {
  return makeThreadQueuedMessageFixture({
    id: "qmsg-1",
    threadId: "thread-1",
    model: "codex-test",
    createdAt: 1,
    updatedAt: 1,
    ...message,
  });
}

function withScheduledWork(
  thread: ThreadListEntry,
  message: ThreadQueuedMessage,
): ThreadListEntry {
  return {
    ...thread,
    work: makeThreadWorkSummary({
      waits: [
        {
          id: message.id,
          reason: "Waiting for the scheduled message time.",
          actor: {
            kind: "external",
            id: message.id,
            label: "Scheduled dispatch",
          },
        },
      ],
    }),
  };
}

describe("thread runtime cache owner", () => {
  it.each(["top-level", "after-acknowledgment", "nested"] as const)(
    "shows each identical steer once while the server confirms them one at a time (%s)",
    async (echoKind) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      queryClient.setQueryData(
        threadQueryKey("thread-1"),
        makeThreadListEntry(),
      );
      const timelineKey = threadTimelineQueryKey("thread-1");
      const text = "Keep waiting";
      const firstRequestId = "creq_2222222222";
      const secondRequestId = "creq_3333333333";

      const request = (requestId: string) => ({
        id: "thread-1",
        mode: "steer" as const,
        requestId,
        input: [{ type: "text" as const, text, mentions: [] }],
      });

      const firstRequest = request(firstRequestId);
      const secondRequest = request(secondRequestId);

      const row = (id: string, requestId: string | null, seq: number) => {
        const turnRequest = {
          isGrouped: false,
          kind: "steer" as const,
          status: "accepted" as const,
          clientRequestId: requestId,
        };

        return conversationRow({ id, role: "user", text, seq, turnRequest });
      };

      const history = [
        row("historical", null, 1),
        row("another-client", "creq_4444444444", 2),
      ];

      const firstConfirmed = row("first-confirmed", firstRequestId, 3);
      const secondConfirmed = row("second-confirmed", secondRequestId, 4);
      const loaded = makeTimelineResponse({ rows: history, maxSeq: 2 });
      queryClient.setQueryData(timelineKey, loaded);

      const displayed = (timeline: ThreadTimelineResponse) =>
        withPendingSentMessages({
          maxSeq: timeline.maxSeq,
          pending: getPendingSentMessages(queryClient, "thread-1"),
          rows: timeline.rows,
          threadId: "thread-1",
        });

      const read = (
        timeline: ThreadTimelineResponse,
        displayedMaxSeq: number,
      ) =>
        beginPendingSentMessageRead({
          displayedMaxSeq,
          queryClient,
          threadId: "thread-1",
        })(timeline);

      const firstTransaction = await beginSendThreadMessageTransaction({
        queryClient,
        request: firstRequest,
      });

      await beginSendThreadMessageTransaction({
        queryClient,
        request: secondRequest,
      });

      expect(queryClient.getQueryData(timelineKey)).toBe(loaded);
      expect(displayed(loaded)).toHaveLength(4);

      if (echoKind === "after-acknowledgment")
        applySendThreadMessageSuccess({
          queryClient,
          realtimeConnected: true,
          request: firstRequest,
          result: { ok: true, delivery: "sent" },
          transaction: firstTransaction,
        });

      const firstEcho = makeTimelineResponse({
        maxSeq: 3,
        rows: [
          ...history,
          echoKind === "nested"
            ? turnRow({ children: [firstConfirmed] })
            : firstConfirmed,
        ],
      });

      read(firstEcho, loaded.maxSeq);
      expect(displayed(loaded)).toHaveLength(4);

      const whileSecondSendIsPending = displayed(firstEcho);

      expect(whileSecondSendIsPending).toHaveLength(4);
      expect(whileSecondSendIsPending.slice(0, 3)).toEqual(firstEcho.rows);
      expect(whileSecondSendIsPending[3]).toMatchObject({
        text,
        turnRequest: { clientRequestId: secondRequestId },
      });

      const bothConfirmed = makeTimelineResponse({
        maxSeq: 4,
        rows: [...history, firstConfirmed, secondConfirmed],
      });

      read(bothConfirmed, firstEcho.maxSeq);
      expect(displayed(bothConfirmed)).toEqual(bothConfirmed.rows);
      read(bothConfirmed, bothConfirmed.maxSeq);
      expect(getPendingSentMessages(queryClient, "thread-1")).toEqual([]);
      queryClient.clear();
    },
  );

  it("clears queued sidebar state when overlapping new sends both fail", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const thread = makeThreadListEntryFixture({
      id: "thread-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });

    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(systemAppUpdateQueryKey(), {
      newTurnsPausedForUpdate: true,
    });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([thread]),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey(thread.id), []);

    const requests = ["First message", "Second message"].map((text) => ({
      id: thread.id,
      mode: "auto" as const,
      input: [{ type: "text" as const, text, mentions: [] }],
    }));

    const first = await beginSendThreadMessageTransaction({
      queryClient,
      request: requests[0]!,
    });

    const second = await beginSendThreadMessageTransaction({
      queryClient,
      request: requests[1]!,
    });

    rollbackSendThreadMessageTransaction({
      queryClient,
      request: requests[0]!,
      transaction: first,
    });
    rollbackSendThreadMessageTransaction({
      queryClient,
      request: requests[1]!,
      transaction: second,
    });
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey(thread.id)),
    ).toEqual([]);
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.queuedWork,
    ).toBe("none");
    queryClient.clear();
  });

  it.each([false, true])(
    "settles overlapping optimistic starts that are both queued without losing real active state (realtime=%s)",
    async (realtime) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const thread = makeThreadListEntryFixture({
        id: "thread-1",
        status: "idle",
        runtime: { displayStatus: "idle" },
        updatedAt: 1,
      });

      queryClient.setQueryData(threadQueryKey(thread.id), thread);
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([thread]),
      );
      queryClient.setQueryData(
        threadTimelineQueryKey(thread.id),
        makeTimelineResponse(),
      );
      queryClient.setQueryData(threadQueuedMessagesQueryKey(thread.id), []);

      const requests: SendThreadMessageMutationRequest[] = [
        "First",
        "Second",
      ].map((text) => ({
        id: thread.id,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      }));

      const first = await beginSendThreadMessageTransaction({
        queryClient,
        request: requests[0]!,
      });

      const second = await beginSendThreadMessageTransaction({
        queryClient,
        request: requests[1]!,
      });

      expect(first.kind).toBe("accepted-turn");
      expect(second.kind).toBe("accepted-turn");

      if (realtime) {
        const active = {
          ...thread,
          status: "active",
          runtime: { displayStatus: "active" },
          updatedAt: 3,
        } satisfies ThreadListEntry;

        queryClient.setQueryData(threadQueryKey(thread.id), active);
        queryClient.setQueryData(
          sidebarNavigationQueryKey(),
          makeSidebarNavigation([active]),
        );
      }

      for (const [index, transaction] of [first, second].entries())
        applySendThreadMessageSuccess({
          queryClient,
          request: requests[index]!,
          transaction,
          realtimeConnected: true,
          result: {
            ok: true,
            delivery: "queued",
            queuedMessage: makeQueuedMessage({
              id: `qmsg-${index}`,
              content: requests[index]!.input,
              waitingOn: {
                kind: "plugin",
                pluginId: "test-admission",
                reason: "Slots filled",
              },
            }),
          },
        });
      expect(queryClient.getQueryData(threadQueryKey(thread.id))).toMatchObject(
        {
          status: realtime ? "active" : "idle",
          runtime: { displayStatus: realtime ? "active" : "idle" },
        },
      );
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(
          sidebarNavigationQueryKey(),
        )?.projects[0]?.threads[0],
      ).toMatchObject({
        status: realtime ? "active" : "idle",
        queuedWork: realtime ? "none" : "waiting",
      });
      expect(
        queryClient.getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey(thread.id),
        ),
      ).toHaveLength(2);
      expect(
        displayedTimelineRows(queryClient, threadTimelineQueryKey(thread.id)),
      ).toEqual([]);
      queryClient.clear();
    },
  );

  it.each(["send", "queue"] as const)(
    "publishes a %s without waiting for an older read to finish",
    async (action) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const timelineKey = threadTimelineQueryKey("thread-1");
      const queueKey = threadQueuedMessagesQueryKey("thread-1");
      queryClient.setQueryData(timelineKey, makeTimelineResponse());
      queryClient.setQueryData(queueKey, []);

      const loading = queryClient.fetchQuery({
        queryKey: action === "send" ? timelineKey : queueKey,
        queryFn: () => new Promise<never>(() => {}),
      });

      void loading.catch(() => {});

      const request = {
        id: "thread-1",
        input: [
          { type: "text" as const, text: "Instant feedback", mentions: [] },
        ],
      };

      await (action === "send"
        ? beginSendThreadMessageTransaction({
            queryClient,
            request: { ...request, mode: "auto" },
          })
        : beginCreateQueuedMessageTransaction({ queryClient, request }));

      try {
        if (action === "send") {
          expect(displayedTimelineRows(queryClient, timelineKey)).toMatchObject(
            [{ role: "user", text: "Instant feedback" }],
          );
          expect(queryClient.getQueryData(queueKey)).toEqual([]);
        } else {
          expect(
            queryClient.getQueryData<ThreadQueuedMessage[]>(queueKey),
          ).toMatchObject([{ content: request.input }]);
          expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([]);
        }
      } finally {
        queryClient.clear();
      }
    },
  );

  it.each([false, true])(
    "clears readiness across sidebar snapshots before Send settles and restores rejected sends (scheduled=%s)",
    async (scheduled) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const thread = makeThreadListEntryFixture({
        id: "thread-1",
        status: "idle",
        runtime: { displayStatus: "idle" },
      });

      queryClient.setQueryData(threadQueryKey(thread.id), thread);
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([thread]),
      );

      const listKey = threadListQueryKey({
        archived: false,
        projectId: thread.projectId,
      });

      queryClient.setQueryData(listKey, [thread]);

      const request = {
        id: thread.id,
        mode: "auto" as const,
        ...(scheduled ? { sendAt: Date.now() + 60_000 } : {}),
        input: [{ type: "text" as const, text: "Continue", mentions: [] }],
      };

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request,
      });

      const sidebar = queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0];

      const listed = queryClient.getQueryData<ThreadListEntry[]>(listKey)?.[0];
      expect(sidebar?.runtime.displayStatus).toBe(
        scheduled ? "idle" : "active",
      );
      expect(listed?.runtime.displayStatus).toBe(scheduled ? "idle" : "active");
      expect(sidebar?.queuedWork).toBe(scheduled ? "waiting" : "none");
      expect(listed?.queuedWork).toBe(scheduled ? "waiting" : "none");
      rollbackSendThreadMessageTransaction({
        queryClient,
        request,
        transaction,
      });
      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(
          sidebarNavigationQueryKey(),
        )?.projects[0]?.threads[0]?.runtime.displayStatus,
      ).toBe("idle");
      expect(
        queryClient.getQueryData<ThreadListEntry[]>(listKey)?.[0]?.runtime
          .displayStatus,
      ).toBe("idle");
      queryClient.clear();
    },
  );

  it("preserves newer authoritative sidebar state when a readiness-clearing send fails", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const thread = makeThreadListEntryFixture({
      id: "thread-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });

    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([thread]),
    );

    const request = {
      id: thread.id,
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Continue", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    const newer = {
      ...thread,
      title: "Newer server state",
      status: "error" as const,
      runtime: { ...thread.runtime, displayStatus: "error" as const },
      updatedAt: Date.now() + 1,
    };

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([newer]),
    );
    rollbackSendThreadMessageTransaction({ queryClient, request, transaction });
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0],
    ).toEqual(newer);
    queryClient.clear();
  });

  it.each([
    ["Plan", applyThreadPlanCancellationResult, "activePlanModeCount"],
    ["Goal", applyThreadGoalClearResult, "activeGoalCount"],
  ] as const)(
    "reconciles authoritative %s cancellation across banner caches while preserving independent state",
    (label, applyResult, clearedCount) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const thread = makeThreadListEntry();

      const listKey = threadListQueryKey({
        archived: false,
        projectId: "project-1",
      });

      const secondListKey = threadListQueryKey({
        archived: false,
        projectId: undefined,
      });

      const searchKey = threadSearchQueryKey({
        query: "work",
        limitPerGroup: 20,
      });

      queryClient.setQueryData(listKey, [thread]);
      queryClient.setQueryData(secondListKey, [thread]);
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([thread]),
      );
      queryClient.setQueryData(searchKey, makeSearchResponse(thread));
      queryClient.setQueryData(threadTimelineQueryKey("thread-1"), {
        ...makeTimelineResponse(),
        activePromptMode: {
          mode: "plan",
          providerId: "codex",
          prompt: "Plan the work",
        },
        goal: {
          sourceSeq: 1,
          updatedAt: 100,
          objective: "Finish the work",
          status: "active",
          tokenBudget: null,
          tokensUsed: 100,
          timeUsedSeconds: 10,
        },
      });

      applyResult({ queryClient, threadId: "thread-1" });

      const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      );

      if (label === "Plan") {
        expect(timeline?.activePromptMode).toBeNull();
        expect(timeline?.goal).toMatchObject({ objective: "Finish the work" });
      } else {
        expect(timeline?.activePromptMode).toMatchObject({ mode: "plan" });
        expect(timeline?.goal).toBeNull();
      }

      const listEntries = [listKey, secondListKey].map(
        (queryKey) =>
          queryClient.getQueryData<ThreadListEntry[]>(queryKey)?.[0],
      );

      const sidebarEntry = queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0];

      const searchEntry =
        queryClient.getQueryData<ThreadSearchResponse>(searchKey)?.active
          .results[0]?.thread;

      for (const entry of [...listEntries, sidebarEntry, searchEntry]) {
        expect(entry?.activity[clearedCount]).toBe(0);
        expect(
          entry?.activity[
            clearedCount === "activePlanModeCount"
              ? "activeGoalCount"
              : "activePlanModeCount"
          ],
        ).toBe(1);
      }
    },
  );

  it("omits agent-only text from optimistic user messages", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), makeThreadListEntry());
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        input: [
          {
            type: "text",
            text: "Hidden source context",
            mentions: [],
            visibility: "agent-only",
          },
          {
            type: "text",
            text: "Visible question",
            mentions: [],
          },
        ],
      },
    });

    const rows = displayedTimelineRows(
      queryClient,
      threadTimelineQueryKey("thread-1"),
    );

    expect(rows).toHaveLength(1);
    expect(rows?.[0]).toMatchObject({
      kind: "conversation",
      role: "user",
      text: "Visible question",
    });
  });

  it("optimistically appends queued messages and replaces them with the server row", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage({ id: "qmsg-existing" }),
    ]);
    queryClient.setQueryData(
      threadDefaultExecutionOptionsQueryKey("thread-1"),
      {
        model: "codex-default",
        reasoningLevel: "high",
        permissionMode: "accept-edits",
        serviceTier: "fast",
      },
    );
    queryClient.setQueryData(threadPromptHistoryQueryKey("thread-1"), []);

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    });

    const optimisticQueue = queryClient.getQueryData<ThreadQueuedMessage[]>(
      threadQueuedMessagesQueryKey("thread-1"),
    );

    expect(optimisticQueue).toHaveLength(2);
    expect(optimisticQueue?.[1]).toMatchObject({
      id: expect.stringMatching(/^optimistic-queued-/u),
      content: [{ type: "text", text: "Queue this", mentions: [] }],
      model: "codex-default",
      reasoningLevel: "high",
      permissionMode: "accept-edits",
      serviceTier: "fast",
    });

    const serverQueuedMessage = makeQueuedMessage({
      id: "qmsg-server",
      content: [{ type: "text", text: "Queue this", mentions: [] }],
      createdAt: 10,
      updatedAt: 10,
    });

    applyQueuedMessageCreateResult({
      queryClient,
      queuedMessage: serverQueuedMessage,
      threadId: "thread-1",
      transaction,
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-existing", "qmsg-server"]);
    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toEqual([
      {
        id: "queued-message:qmsg-server",
        createdAt: 10,
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    ]);
  });

  it("rolls back optimistic queued message creation", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [makeQueuedMessage({ id: "qmsg-existing" })];
    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
    });

    rollbackCreateQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("updates queued message content without changing its queue position", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-first" }),
      makeQueuedMessage({ id: "qmsg-edit", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-last" }),
    ];

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const request = {
      expectedUpdatedAt: 1,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: "qmsg-edit",
    };

    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => ({
          content: queuedMessage.content,
          groupWithNext: queuedMessage.groupWithNext,
          id: queuedMessage.id,
        })),
    ).toEqual([
      expect.objectContaining({ id: "qmsg-first" }),
      {
        content: [{ type: "text", text: "Edited", mentions: [] }],
        groupWithNext: true,
        id: "qmsg-edit",
      },
      expect.objectContaining({ id: "qmsg-last" }),
    ]);

    applyQueuedMessageUpdateResult({
      queryClient,
      queuedMessage: makeQueuedMessage({
        id: "qmsg-edit",
        content: [{ type: "text", text: "Edited", mentions: [] }],
        groupWithNext: true,
        updatedAt: 2,
      }),
      threadId: "thread-1",
    });
    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-first", "qmsg-edit", "qmsg-last"]);

    expect(transaction.previousQueuedMessage).toEqual(previousQueue[1]);
  });

  it("rolls back only edited fields while preserving concurrent queue changes", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const first = makeQueuedMessage({ id: "qmsg-first" });

    const edited = makeQueuedMessage({
      id: "qmsg-edit",
      content: [{ type: "text", text: "Original", mentions: [] }],
      groupWithNext: true,
      updatedAt: 5,
    });

    const last = makeQueuedMessage({ id: "qmsg-last" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      first,
      edited,
      last,
    ]);

    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: edited.id,
    };

    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });

    const added = makeQueuedMessage({ id: "qmsg-added" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      last,
      {
        ...edited,
        content: request.input,
        groupWithNext: false,
        updatedAt: transaction.optimisticUpdatedAt!,
      },
      added,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toEqual([last, { ...edited, groupWithNext: false }, added]);
  });

  it("does not roll back a newer update to the same queued message", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const edited = makeQueuedMessage({
      id: "qmsg-edit",
      content: [{ type: "text", text: "Original", mentions: [] }],
      updatedAt: 5,
    });

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      edited,
    ]);

    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "First edit", mentions: [] }],
      queuedMessageId: edited.id,
    };

    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });

    const newerQueuedMessage = {
      ...edited,
      content: [{ type: "text" as const, text: "Newer edit", mentions: [] }],
      updatedAt: transaction.optimisticUpdatedAt! + 1,
    };

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      newerQueuedMessage,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([newerQueuedMessage]);
  });

  it("does not resurrect an edited message removed before rollback", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const edited = makeQueuedMessage({ id: "qmsg-edit", updatedAt: 5 });
    const remaining = makeQueuedMessage({ id: "qmsg-remaining" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      edited,
      remaining,
    ]);

    const request = {
      expectedUpdatedAt: edited.updatedAt,
      id: "thread-1",
      input: [{ type: "text" as const, text: "Edited", mentions: [] }],
      queuedMessageId: edited.id,
    };

    const transaction = await beginUpdateQueuedMessageTransaction({
      queryClient,
      request,
    });

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      remaining,
    ]);

    rollbackUpdateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([remaining]);
  });

  it("optimistically queues queue-if-active sends", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), {
      status: "active",
    });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      {
        id: expect.stringMatching(/^optimistic-queued-/u),
        content: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
    ]);

    rollbackSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "queue-if-active",
        input: [{ type: "text", text: "Queue through send", mentions: [] }],
      },
      transaction,
    });
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([]);
  });

  it.each([
    { sendNow: false, kind: "queued-message" },
    { sendNow: true, kind: "accepted-turn" },
  ])(
    "predicts the server pausing an owner send behind a held automatic retry (sendNow $sendNow)",
    async ({ sendNow, kind }) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      queryClient.setQueryData(
        threadQueryKey("thread-1"),
        makeThreadResponse({ id: "thread-1", status: "error" }),
      );
      queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
        makeQueuedMessage({
          id: "qmsg-retry",
          sendAt: Date.now() + 3_600_000,
          waitingOn: { kind: "time" },
          payload: {
            kind: "retry",
            retryOfTurnRequestId: "creq_failed",
            attempt: 2,
            reason: "Rate limited",
          },
        }),
      ]);

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request: {
          id: "thread-1",
          mode: "queue-if-active",
          input: [{ type: "text", text: "Carry on", mentions: [] }],
          ...(sendNow ? { sendNow: true } : {}),
        },
      });

      expect(transaction.kind).toBe(kind);

      if (kind === "queued-message")
        expect(
          queryClient
            .getQueryData<ThreadQueuedMessage[]>(
              threadQueuedMessagesQueryKey("thread-1"),
            )
            ?.at(-1),
        ).toMatchObject({ waitingOn: { kind: "thread-busy" } });
    },
  );

  it("optimistically queues a scheduled send even when the cached thread is idle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const sendAt = Date.now() + 3_600_000;
    queryClient.setQueryData(threadQueryKey("thread-1"), { status: "idle" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Send later", mentions: [] }],
      sendAt,
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([{ sendAt, waitingOn: { kind: "time" } }]);

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          id: "qmsg-scheduled",
          content: request.input,
          sendAt,
          waitingOn: { kind: "time" },
        }),
      },
      transaction,
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-scheduled", sendAt, waitingOn: { kind: "time" } },
    ]);
  });

  it("queues a submission its plugin expects to hold instead of showing it as sent", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), { status: "idle" });
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Save for later", mentions: [] }],
        pluginSubmission: { pluginId: "drafts", data: { kind: "draft" } },
        expectedPluginWait: {
          kind: "plugin",
          pluginId: "drafts",
          reason: "Draft",
        },
      },
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<{ status: string }>(threadQueryKey("thread-1"))
        ?.status,
    ).toBe("idle");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { waitingOn: { kind: "plugin", pluginId: "drafts", reason: "Draft" } },
    ]);
  });

  it("clears optimistic group edges when deleting a grouped successor", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    const transaction = await beginRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-2",
      },
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-3", groupWithNext: false },
    ]);

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-2",
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
  });

  it("preserves grouping when optimistically reordering without a boundary", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );

    await beginReorderQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        queuedMessageId: "qmsg-3",
        previousQueuedMessageId: null,
        nextQueuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-3", groupWithNext: false },
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-2", groupWithNext: false },
    ]);
  });

  it.each(["failed", "queued", "sent"] as const)(
    "starts Send now on an idle thread at once and reconciles a %s outcome",
    async (outcome) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const thread = makeThreadListEntryFixture({
        id: "thread-1",
        projectId: "project-1",
        status: "idle",
        runtime: { displayStatus: "idle" },
        queuedWork: "waiting",
      });

      const queueKey = threadQueuedMessagesQueryKey(thread.id);
      const timelineKey = threadTimelineQueryKey(thread.id);

      const previousQueue = [
        makeQueuedMessage({
          id: "qmsg-1",
          groupWithNext: true,
          content: [{ type: "text", text: "First", mentions: [] }],
        }),
        makeQueuedMessage({
          id: "qmsg-2",
          content: [{ type: "text", text: "Second", mentions: [] }],
        }),
        makeQueuedMessage({ id: "qmsg-3" }),
      ];

      queryClient.setQueryData(threadQueryKey(thread.id), thread);
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([thread]),
      );
      queryClient.setQueryData(queueKey, previousQueue);
      queryClient.setQueryData(timelineKey, makeTimelineResponse());

      const request = {
        id: thread.id,
        mode: "auto" as const,
        queuedMessageId: "qmsg-1",
        requestId: "creq_5555555555",
      };

      const transaction = await beginSendQueuedMessageTransaction({
        queryClient,
        request,
      });

      const sidebarThread = () =>
        queryClient.getQueryData<SidebarBootstrapResponse>(
          sidebarNavigationQueryKey(),
        )?.projects[0]?.threads[0];

      expect(
        queryClient
          .getQueryData<ThreadQueuedMessage[]>(queueKey)
          ?.map((message) => message.id),
      ).toEqual(["qmsg-3"]);
      expect(displayedTimelineRows(queryClient, timelineKey)).toMatchObject([
        {
          role: "user",
          text: "First",
          turnRequest: { clientRequestId: request.requestId, isGrouped: true },
        },
        {
          role: "user",
          text: "Second",
          turnRequest: { clientRequestId: request.requestId, isGrouped: true },
        },
      ]);
      expect(queryClient.getQueryData(threadQueryKey(thread.id))).toMatchObject(
        { status: "active" },
      );
      expect(sidebarThread()).toMatchObject({
        status: "active",
        queuedWork: "waiting",
      });
      expect(
        mergePendingComposerQueuedMessages(
          queryClient,
          thread.id,
          previousQueue,
        ).map((message) => message.id),
      ).toEqual(["qmsg-3"]);

      if (outcome === "failed") {
        rollbackRemoveQueuedMessageTransaction({
          queryClient,
          request,
          transaction,
        });
        expect(queryClient.getQueryData(queueKey)).toEqual(previousQueue);
        expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([]);
        expect(queryClient.getQueryData(threadQueryKey(thread.id))).toEqual(
          thread,
        );
        expect(sidebarThread()).toMatchObject({ status: "idle" });
      } else if (outcome === "queued") {
        const stillQueued = makeQueuedMessage({
          id: "qmsg-1",
          groupWithNext: true,
          waitingOn: { kind: "provisioning" },
          updatedAt: 2,
        });

        applyQueuedMessageSendResult({
          queryClient,
          request,
          transaction,
          result: { ok: true, delivery: "queued", queuedMessage: stillQueued },
        });
        expect(
          queryClient
            .getQueryData<ThreadQueuedMessage[]>(queueKey)
            ?.map((message) => message.id),
        ).toEqual(["qmsg-1", "qmsg-2", "qmsg-3"]);
        expect(
          queryClient.getQueryData<ThreadQueuedMessage[]>(queueKey)?.[0],
        ).toEqual(stillQueued);
        expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([]);
        expect(queryClient.getQueryData(threadQueryKey(thread.id))).toEqual(
          thread,
        );
      } else {
        applyQueuedMessageSendResult({
          queryClient,
          request,
          transaction,
          result: { ok: true, delivery: "sent" },
        });
        expect(
          mergePendingComposerQueuedMessages(
            queryClient,
            thread.id,
            previousQueue,
          ).map((message) => message.id),
        ).toEqual(["qmsg-2", "qmsg-3"]);
        expect(
          mergePendingComposerQueuedMessages(queryClient, thread.id, [
            previousQueue[2]!,
          ]).map((message) => message.id),
        ).toEqual(["qmsg-3"]);
        expect(
          mergePendingComposerQueuedMessages(
            queryClient,
            thread.id,
            previousQueue,
          ).map((message) => message.id),
        ).toEqual(["qmsg-1", "qmsg-2", "qmsg-3"]);
      }

      queryClient.clear();
    },
  );

  it("removes a deleted scheduled message's wait from the sidebar at once and restores it on failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const scheduled = makeQueuedMessage({
      id: "qmsg-1",
      sendAt: 4_000_000_000_000,
      waitingOn: { kind: "time" },
    });

    const base = makeThreadListEntryFixture({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
      queuedWork: "waiting",
    });

    const thread = withScheduledWork(base, scheduled);

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([thread]),
    );
    queryClient.setQueryData(threadListQueryKey({ archived: false }), [thread]);
    queryClient.setQueryData(threadQueuedMessagesQueryKey(thread.id), [
      scheduled,
    ]);

    const request = { id: thread.id, queuedMessageId: scheduled.id };

    const transaction = await beginRemoveQueuedMessageTransaction({
      queryClient,
      request,
    });

    const listed = () =>
      queryClient.getQueryData<ThreadListEntry[]>(
        threadListQueryKey({ archived: false }),
      )?.[0];

    expect(listed()?.queuedWork).toBe("none");
    expect(listed()?.work).not.toBeNull();
    expect(listed()?.work?.waits).toEqual([]);
    expect(
      queryClient.getQueryData<SidebarBootstrapResponse>(
        sidebarNavigationQueryKey(),
      )?.projects[0]?.threads[0]?.queuedWork,
    ).toBe("none");

    rollbackRemoveQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    expect(listed()).toEqual(thread);
    queryClient.clear();
  });

  it("re-projects queued work instead of clearing it when a failed queued create rolls back", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const thread = makeThreadListEntryFixture({
      id: "thread-1",
      projectId: "project-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
      queuedWork: "none",
    });

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([thread]),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey(thread.id), []);

    const request = {
      id: thread.id,
      input: [{ type: "text" as const, text: "Later", mentions: [] }],
    };

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request,
    });

    queryClient.setQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
      (navigation) =>
        navigation && {
          ...navigation,
          projects: navigation.projects.map((project) => ({
            ...project,
            threads: project.threads.map((entry) => ({
              ...entry,
              title: "Renamed meanwhile",
            })),
          })),
        },
    );

    rollbackCreateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });

    const sidebarThread = queryClient.getQueryData<SidebarBootstrapResponse>(
      sidebarNavigationQueryKey(),
    )?.projects[0]?.threads[0];

    expect(sidebarThread?.queuedWork).toBe("none");
    expect(sidebarThread?.work).not.toBeNull();
    expect(sidebarThread?.work?.activity).toEqual([]);
    queryClient.clear();
  });

  it("keeps Send now in the queue until the server admits the message", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const queueKey = threadQueuedMessagesQueryKey("thread-1");
    const timelineKey = threadTimelineQueryKey("thread-1");
    const previousQueue = [makeQueuedMessage({ id: "qmsg-1" })];
    queryClient.setQueryData(queueKey, previousQueue);
    queryClient.setQueryData(timelineKey, makeTimelineResponse());

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      queuedMessageId: "qmsg-1",
    };

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request,
    });

    expect(queryClient.getQueryData(queueKey)).toEqual(previousQueue);
    expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([]);
    applyQueuedMessageSendResult({
      queryClient,
      request,
      transaction,
      result: { ok: true, delivery: "sent" },
    });
    expect(queryClient.getQueryData(queueKey)).toEqual([]);
    expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([]);
    expect(queryClient.getQueryState(timelineKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  it("updates the retained queue row when delivery remains queued", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({
        id: "qmsg-1",
        waitingOn: { kind: "thread-busy" },
      }),
    ];

    const previousThread = {
      id: "thread-1",
      status: "starting",
      updatedAt: 1,
      runtime: {
        displayStatus: "provisioning",
      },
    };

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const request = {
      id: "thread-1",
      mode: "steer" as const,
      queuedMessageId: "qmsg-1",
    };

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request,
    });

    applyQueuedMessageSendResult({
      queryClient,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          id: "qmsg-1",
          waitingOn: { kind: "provisioning" },
          updatedAt: 2,
        }),
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([
      makeQueuedMessage({
        id: "qmsg-1",
        waitingOn: { kind: "provisioning" },
        updatedAt: 2,
      }),
    ]);
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
      previousThread,
    );
  });

  it("does not duplicate a queued-row steer or overwrite newer thread state after realtime wins", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const queuedMessage = makeQueuedMessage({
      waitingOn: { kind: "thread-busy" },
    });

    const previousThread = {
      id: "thread-1",
      status: "starting",
      updatedAt: 1,
      runtime: {
        displayStatus: "provisioning",
      },
    };

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      queuedMessage,
    ]);
    queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const request = {
      id: "thread-1",
      mode: "steer" as const,
      queuedMessageId: queuedMessage.id,
    };

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request,
    });

    const authoritativeQueuedMessage = makeQueuedMessage({
      waitingOn: { kind: "provisioning" },
      updatedAt: 2,
    });

    const realtimeThread = {
      ...previousThread,
      title: "Realtime title",
      updatedAt: 2,
    };

    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      authoritativeQueuedMessage,
    ]);
    queryClient.setQueryData(threadQueryKey("thread-1"), realtimeThread);

    applyQueuedMessageSendResult({
      queryClient,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: authoritativeQueuedMessage,
      },
      transaction,
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([authoritativeQueuedMessage]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
      realtimeThread,
    );
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
  });

  it("repairs group edges only after sending a grouped successor", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({ id: "qmsg-2" }),
      makeQueuedMessage({ id: "qmsg-3" }),
    ];

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-2",
      },
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
    applyQueuedMessageSendResult({
      queryClient,
      request: { id: "thread-1", mode: "auto", queuedMessageId: "qmsg-2" },
      transaction,
      result: { ok: true, delivery: "sent" },
    });
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { id: "qmsg-1", groupWithNext: false },
      { id: "qmsg-3", groupWithNext: false },
    ]);

    queryClient.clear();
  });

  it("confirms only the acknowledged member of a client-side group", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const previousQueue = [
      makeQueuedMessage({ id: "qmsg-1", groupWithNext: true }),
      makeQueuedMessage({
        id: "qmsg-2",
        content: [{ type: "text", text: "Second", mentions: [] }],
      }),
      makeQueuedMessage({
        id: "qmsg-3",
        content: [{ type: "text", text: "Third", mentions: [] }],
      }),
    ];

    queryClient.setQueryData(
      threadQueuedMessagesQueryKey("thread-1"),
      previousQueue,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );

    const transaction = await beginSendQueuedMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-1",
      },
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual(previousQueue);
    applyQueuedMessageSendResult({
      queryClient,
      request: { id: "thread-1", mode: "auto", queuedMessageId: "qmsg-1" },
      transaction,
      result: { ok: true, delivery: "sent" },
    });
    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-2", "qmsg-3"]);

    expect(
      mergePendingComposerQueuedMessages(
        queryClient,
        "thread-1",
        previousQueue.slice(1),
      ).map((message) => message.id),
    ).toEqual(["qmsg-2", "qmsg-3"]);

    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);

    queryClient.clear();
  });

  it.each(["inline", "queued"] as const)(
    "preserves a confirmed timeline and newer idle state when %s admission is acknowledged late",
    async (kind) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const threadKey = threadQueryKey("thread-1");
      const timelineKey = threadTimelineQueryKey("thread-1");
      const queueKey = threadQueuedMessagesQueryKey("thread-1");

      const thread = makeThreadListEntryFixture({
        id: "thread-1",
        status: "idle",
        runtime: { displayStatus: "idle" },
        updatedAt: 1,
      });

      queryClient.setQueryData(threadKey, thread);
      queryClient.setQueryData(timelineKey, makeTimelineResponse());
      const queued = makeQueuedMessage();
      queryClient.setQueryData(queueKey, kind === "queued" ? [queued] : []);

      const request = {
        id: "thread-1",
        mode: "auto" as const,
        requestId: "creq_2222222222",
        input: queued.content,
      };

      const queuedRequest = { ...request, queuedMessageId: queued.id };

      const transaction =
        kind === "inline"
          ? await beginSendThreadMessageTransaction({ queryClient, request })
          : await beginSendQueuedMessageTransaction({
              queryClient,
              request: queuedRequest,
            });

      const confirmed = conversationRow({
        id: "confirmed",
        threadId: "thread-1",
        role: "user",
        text: "Queued message",
        turnRequest: {
          clientRequestId: request.requestId,
          isGrouped: false,
          kind: "message",
          status: "accepted",
        },
      });

      queryClient.setQueryData(
        timelineKey,
        makeTimelineResponse({ rows: [confirmed] }),
      );
      const completed = { ...thread, updatedAt: 3 };
      queryClient.setQueryData(threadKey, completed);

      if (kind === "inline" && "kind" in transaction)
        applySendThreadMessageSuccess({
          queryClient,
          request,
          transaction,
          realtimeConnected: true,
          result: { ok: true, delivery: "sent" },
        });
      else if (!("kind" in transaction))
        applyQueuedMessageSendResult({
          queryClient,
          request: queuedRequest,
          transaction,
          result: { ok: true, delivery: "sent" },
        });
      expect(displayedTimelineRows(queryClient, timelineKey)).toEqual([
        confirmed,
      ]);
      expect(queryClient.getQueryData(threadKey)).toEqual(completed);
      expect(queryClient.getQueryData(queueKey)).toEqual([]);
      queryClient.clear();
    },
  );

  it("immediately starts an idle send when cached readiness permits it", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const thread = makeThreadListEntryFixture({
      id: "thread-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });

    queryClient.setQueryData(threadQueryKey(thread.id), thread);
    queryClient.setQueryData(
      threadTimelineQueryKey(thread.id),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadPluginBootstrapQueryKey(thread.id), {
      ...thread,
      experimental_pluginData: [
        {
          pluginId: "test-admission",
          method: "readiness",
          dispatchReadiness: true,
          outcome: { ok: true, result: { action: "proceed" } },
        },
      ],
    });

    const request: SendThreadMessageMutationRequest = {
      id: thread.id,
      mode: "auto",
      input: [{ type: "text", text: "Start immediately", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("accepted-turn");
    expect(queryClient.getQueryData(threadQueryKey(thread.id))).toMatchObject({
      status: "active",
      runtime: { displayStatus: "active" },
    });
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey(thread.id)),
    ).toMatchObject([
      { kind: "conversation", role: "user", text: "Start immediately" },
    ]);
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey(thread.id),
      ) ?? [],
    ).toEqual([]);
    queryClient.clear();
  });

  it.each([
    "unknown",
    "wait",
    "legacy",
    "failed",
    "malformed",
    "paused",
    "steering",
    "starting",
    "invalidated",
  ])(
    "uses only an explicit current readiness wait for %s admission",
    async (scenario) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const status: ThreadListEntry["status"] =
        scenario === "steering"
          ? "active"
          : scenario === "starting"
            ? "starting"
            : "idle";

      const thread = makeThreadListEntryFixture({
        id: "thread-1",
        status,
        runtime: { displayStatus: status },
      });

      const bootstrapKey = threadPluginBootstrapQueryKey(thread.id);
      queryClient.setQueryData(threadQueryKey(thread.id), thread);
      queryClient.setQueryData(
        threadTimelineQueryKey(thread.id),
        makeTimelineResponse(),
      );

      if (scenario !== "unknown")
        queryClient.setQueryData(bootstrapKey, {
          ...thread,
          experimental_pluginData: [
            {
              pluginId: "test-admission",
              method: "readiness",
              ...(scenario === "legacy" ? {} : { dispatchReadiness: true }),
              outcome:
                scenario === "failed"
                  ? { ok: false, error: { message: "Preview unavailable" } }
                  : {
                      ok: true,
                      result: {
                        action: "wait",
                        reason:
                          scenario === "malformed" ? 5 : "All slots occupied",
                      },
                    },
            },
          ],
        });

      if (scenario === "invalidated")
        await queryClient.invalidateQueries({
          queryKey: bootstrapKey,
          refetchType: "none",
        });
      queryClient.setQueryData(systemAppUpdateQueryKey(), {
        newTurnsPausedForUpdate:
          scenario === "paused" ||
          scenario === "steering" ||
          scenario === "starting",
      });

      const request: SendThreadMessageMutationRequest = {
        id: thread.id,
        mode: scenario === "starting" ? "steer" : "auto",
        input: [{ type: "text", text: "Send", mentions: [] }],
      };

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request,
      });

      if (scenario === "wait" || scenario === "paused") {
        expect(transaction.kind).toBe("queued-message");
        expect(
          queryClient.getQueryData(threadQueryKey(thread.id)),
        ).toMatchObject({ status: "idle" });
        expect(
          queryClient.getQueryData<ThreadQueuedMessage[]>(
            threadQueuedMessagesQueryKey(thread.id),
          ),
        ).toMatchObject([
          {
            waitingOn:
              scenario === "paused"
                ? { kind: "server-update" }
                : {
                    kind: "plugin",
                    pluginId: "test-admission",
                    reason: "All slots occupied",
                  },
          },
        ]);
        expect(
          displayedTimelineRows(queryClient, threadTimelineQueryKey(thread.id)),
        ).toEqual([]);
      } else {
        expect(transaction.kind).toBe("accepted-turn");
        expect(
          displayedTimelineRows(queryClient, threadTimelineQueryKey(thread.id)),
        ).toMatchObject([
          {
            text: "Send",
            turnRequest: {
              kind:
                scenario === "steering" || scenario === "starting"
                  ? "steer"
                  : "message",
            },
          },
        ]);
      }

      queryClient.clear();
    },
  );

  it("keeps an idle send queued before the server confirms its hold", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), {
      id: "thread-1",
      status: "idle",
      updatedAt: 1,
      runtime: { displayStatus: "idle" },
    });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);
    queryClient.setQueryData(threadPluginBootstrapQueryKey("thread-1"), {
      experimental_pluginData: [
        {
          pluginId: "limiter",
          method: "readiness",
          dispatchReadiness: true,
          outcome: { ok: true, result: { action: "wait", reason: "busy" } },
        },
      ],
    });

    const request = {
      id: "thread-1",
      mode: "queue-if-active" as const,
      input: [{ type: "text" as const, text: "ship the notes", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("queued-message");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      { waitingOn: { kind: "plugin", pluginId: "limiter", reason: "busy" } },
    ]);

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: {
        ok: true,
        delivery: "queued",
        queuedMessage: makeQueuedMessage({
          content: request.input,
          waitingOn: { kind: "plugin", pluginId: "limiter", reason: "busy" },
        }),
      },
      transaction,
    });
    await Promise.resolve();

    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toMatchObject({
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(
      queryClient.getQueryState(threadQueuedMessagesQueryKey("thread-1"))
        ?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toMatchObject([
      {
        content: request.input,
        waitingOn: { kind: "plugin", pluginId: "limiter" },
      },
    ]);
  });

  it("sends a sendNow message past plugin and time holds instead of queuing it", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), {
      id: "thread-1",
      status: "idle",
      updatedAt: 1,
      runtime: { displayStatus: "idle" },
    });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);
    queryClient.setQueryData(threadPluginBootstrapQueryKey("thread-1"), {
      experimental_pluginData: [
        {
          pluginId: "concurrency-limit",
          method: "getDispatchReadiness",
          dispatchReadiness: true,
          outcome: {
            ok: true,
            result: { action: "wait", reason: "3 of 3 running on host Mac" },
          },
        },
      ],
    });

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request: {
        id: "thread-1",
        mode: "auto",
        sendNow: true,
        sendAt: Date.now() + 60_000,
        input: [{ type: "text", text: "start anyway", mentions: [] }],
      },
    });

    expect(transaction.kind).toBe("accepted-turn");
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toEqual([]);
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toMatchObject([{ role: "user", text: "start anyway" }]);
  });

  it.each([false, true])(
    "keeps newer realtime queue and thread state when it arrives before send success (pending row=%s)",
    async (pendingRow) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });

      const previousThread = {
        id: "thread-1",
        status: "idle",
        updatedAt: 1,
        runtime: { displayStatus: "idle" },
      };

      queryClient.setQueryData(threadQueryKey("thread-1"), previousThread);

      const initialSidebar = makeThreadListEntryFixture({
        id: "thread-1",
        status: "idle",
        runtime: { displayStatus: "idle" },
      });

      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([initialSidebar]),
      );
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeTimelineResponse(),
      );
      queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), []);

      const request = {
        id: "thread-1",
        mode: "auto" as const,
        input: [
          { type: "text" as const, text: "Wait for input", mentions: [] },
        ],
      };

      const transaction = await beginSendThreadMessageTransaction({
        queryClient,
        request,
      });

      const authoritativeQueuedMessage = makeQueuedMessage({
        id: "qmsg-realtime",
        content: request.input,
        waitingOn: { kind: "interaction" },
        updatedAt: 5,
      });

      const realtimeThread = {
        ...previousThread,
        status: "starting",
        updatedAt: 5,
        runtime: {
          displayStatus: "provisioning",
        },
      };

      queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
        authoritativeQueuedMessage,
      ]);

      if (!pendingRow)
        queryClient.setQueryData(
          threadTimelineQueryKey("thread-1"),
          makeTimelineResponse(),
        );
      queryClient.setQueryData(threadQueryKey("thread-1"), realtimeThread);

      const newerSidebar = makeThreadListEntryFixture({
        ...initialSidebar,
        status: "starting",
        runtime: { displayStatus: "provisioning" },
        queuedWork: "none",
        updatedAt: 5,
      });

      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([newerSidebar]),
      );

      applySendThreadMessageSuccess({
        queryClient,
        realtimeConnected: true,
        request,
        result: {
          ok: true,
          delivery: "queued",
          queuedMessage: authoritativeQueuedMessage,
        },
        transaction,
      });

      expect(
        queryClient.getQueryData<SidebarBootstrapResponse>(
          sidebarNavigationQueryKey(),
        )?.projects[0]?.threads[0],
      ).toEqual(newerSidebar);
      expect(
        queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
      ).toEqual([authoritativeQueuedMessage]);
      expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toEqual(
        realtimeThread,
      );
      expect(
        displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
      ).toEqual([]);
    },
  );

  it("keeps an accepted send local while realtime is connected: prompt history is prepended, not refetched, and default execution options only go stale", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    queryClient.setQueryData(threadQueryKey("thread-1"), {
      id: "thread-1",
      status: "idle",
      runtime: { displayStatus: "idle" },
    });
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    const promptHistoryQueryFn = vi.fn(async () => []);
    const defaultExecutionOptionsQueryFn = vi.fn(async () => null);

    const promptHistoryObserver = new QueryObserver(queryClient, {
      queryKey: threadPromptHistoryQueryKey("thread-1"),
      queryFn: promptHistoryQueryFn,
      staleTime: Infinity,
    });

    const defaultExecutionOptionsObserver = new QueryObserver(queryClient, {
      queryKey: threadDefaultExecutionOptionsQueryKey("thread-1"),
      queryFn: defaultExecutionOptionsQueryFn,
      staleTime: Infinity,
    });

    const unsubscribers = [
      promptHistoryObserver.subscribe(() => {}),
      defaultExecutionOptionsObserver.subscribe(() => {}),
    ];

    await vi.waitFor(() => {
      expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
      expect(defaultExecutionOptionsQueryFn).toHaveBeenCalledTimes(1);
    });

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Accepted prompt", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("accepted-turn");
    expect(queryClient.getQueryData(threadQueryKey("thread-1"))).toMatchObject({
      status: "active",
      runtime: { displayStatus: "active" },
    });
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toBeUndefined();
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toMatchObject([{ kind: "conversation", text: "Accepted prompt" }]);

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: { ok: true, delivery: "sent" },
      transaction,
    });
    await Promise.resolve();

    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryState(threadPromptHistoryQueryKey("thread-1"))
        ?.isInvalidated,
    ).toBe(false);
    expect(
      queryClient.getQueryState(
        threadDefaultExecutionOptionsQueryKey("thread-1"),
      )?.isInvalidated,
    ).toBe(true);
    expect(defaultExecutionOptionsQueryFn).toHaveBeenCalledTimes(1);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  it("refreshes authoritative history after a queued send is admitted", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const activeThread = {
      status: "active",
      updatedAt: 1,
      runtime: {
        displayStatus: "active",
      },
    };

    queryClient.setQueryData(threadQueryKey("thread-1"), activeThread);
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeTimelineResponse(),
    );
    const queuedMessagesQueryFn = vi.fn(async () => []);
    const promptHistoryQueryFn = vi.fn(async () => []);
    const threadQueryFn = vi.fn(async () => activeThread);

    const observers = [
      new QueryObserver(queryClient, {
        queryKey: threadQueuedMessagesQueryKey("thread-1"),
        queryFn: queuedMessagesQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: threadPromptHistoryQueryKey("thread-1"),
        queryFn: promptHistoryQueryFn,
        staleTime: Infinity,
      }),
      new QueryObserver(queryClient, {
        queryKey: threadQueryKey("thread-1"),
        queryFn: threadQueryFn,
        staleTime: Infinity,
      }),
    ];

    const unsubscribers = observers.map((observer) =>
      observer.subscribe(() => {}),
    );

    await vi.waitFor(() => {
      expect(queuedMessagesQueryFn).toHaveBeenCalledTimes(1);
      expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    });

    const request = {
      id: "thread-1",
      mode: "queue-if-active" as const,
      input: [{ type: "text" as const, text: "Queued prompt", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    expect(transaction.kind).toBe("queued-message");

    applySendThreadMessageSuccess({
      queryClient,
      realtimeConnected: true,
      request,
      result: { ok: true, delivery: "sent" },
      transaction,
    });
    await vi.waitFor(() => {
      expect(queuedMessagesQueryFn).toHaveBeenCalledTimes(2);
      expect(threadQueryFn).toHaveBeenCalledTimes(1);
      expect(
        queryClient.getQueryState(threadQueryKey("thread-1"))?.isInvalidated,
      ).toBe(false);
    });

    expect(
      queryClient.getQueryData(threadPromptHistoryQueryKey("thread-1")),
    ).toMatchObject([{ input: request.input }]);
    expect(promptHistoryQueryFn).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey("thread-1"),
      ),
    ).toEqual([]);
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
    expect(
      queryClient.getQueryState(threadTimelineQueryKey("thread-1"))
        ?.isInvalidated,
    ).toBe(true);

    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });
});

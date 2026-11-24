// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ThreadQueuedMessage } from "@omnyo/domain";
import type {
  ExistingThreadExecutionInputSources,
  PromptHistoryResponse,
  ThreadResponse,
  ThreadTimelineResponse,
} from "@omnyo/server-contract";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { makeThreadQueuedMessage as makeThreadQueuedMessageFixture } from "@omnyo/test-helpers/domain-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { subscribeComposerSubmitted } from "@/lib/composer-submissions";
import { wsManager } from "@/lib/ws";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import {
  makeThreadResponse as makeThreadResponseFixture,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import { displayedTimelineRows } from "@/test/displayed-timeline-rows";
import {
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadTimelineQueryKey,
  threadPromptHistoryQueryKey,
} from "../queries/query-keys";
import {
  useCancelThreadPlan,
  useClearThreadGoal,
  useCreateThread,
  useCreateThreadQueuedMessage,
  useDeleteThreadQueuedMessage,
  useEditThreadMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useSendThreadQueuedMessage,
  useSendThreadMessage,
} from "./thread-runtime-mutations";

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();

  return {
    ...actual,
    sdk: {
      threads: {
        cancelPlan: vi.fn(),
        clearGoal: vi.fn(),
        editMessage: vi.fn(),
        queuedMessages: {
          create: vi.fn(),
          delete: vi.fn(),
          list: vi.fn(),
          send: vi.fn(),
          setGroupBoundary: vi.fn(),
        },
        send: vi.fn(),
        spawn: vi.fn(),
      },
    },
  };
});

vi.mock("@/lib/ws", () => ({
  wsManager: {
    getConnectionState: vi.fn(() => "connected"),
  },
}));

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

function makeThreadResponse(
  thread: Partial<ThreadResponse> = {},
): ThreadResponse {
  return makeThreadResponseFixture({
    id: "thread-1",
    projectId: "project-1",
    createdAt: 1,
    status: "pending",
    updatedAt: 1,
    lastReadAt: null,
    latestAttentionAt: 1,
    environmentId: null,
    runtime: {
      displayStatus: "pending",
    },
    canSpawnChild: false,
    queuedMessageCount: 1,
    ...thread,
  });
}

function makeBannerTimeline(): ThreadTimelineResponse {
  return makeThreadTimelineResponse({
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
}

const executionInputSources = {
  model: "explicit",
  serviceTier: "client-preference",
  reasoningLevel: "explicit",
  permissionMode: "client-preference",
} satisfies ExistingThreadExecutionInputSources;

beforeEach(() => {
  vi.mocked(wsManager.getConnectionState).mockReturnValue("connected");
  vi.mocked(sdk.threads.cancelPlan).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.clearGoal).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.editMessage).mockResolvedValue({
    ok: true,
    operationId: "edit-op-1",
    requestSequence: 42,
  });
  vi.mocked(sdk.threads.send).mockResolvedValue({
    ok: true,
    delivery: "sent",
  });
  vi.mocked(sdk.threads.spawn).mockResolvedValue(makeThreadResponse());
  vi.mocked(sdk.threads.queuedMessages.create).mockResolvedValue(
    makeQueuedMessage(),
  );
  vi.mocked(sdk.threads.queuedMessages.delete).mockResolvedValue({ ok: true });
  vi.mocked(sdk.threads.queuedMessages.list).mockResolvedValue([
    makeQueuedMessage(),
  ]);
  vi.mocked(sdk.threads.queuedMessages.send).mockResolvedValue({
    ok: true,
    delivery: "sent",
  });
  vi.mocked(sdk.threads.queuedMessages.setGroupBoundary).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("thread runtime mutations", () => {
  it("prefetches queued message detail as soon as a queued thread is created", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useCreateThread(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        projectId: "project-1",
        environment: { type: "project-default" },
        input: [{ type: "text", text: "Queued work", mentions: [] }],
      });
    });

    await waitFor(() =>
      expect(sdk.threads.queuedMessages.list).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "thread-1" }),
      ),
    );
    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([makeQueuedMessage()]);
  });

  it("shows the edited text at once, keeps later rows and lets connected realtime own success", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const edit = createDeferredPromise<{
      ok: true;
      operationId: string;
      requestSequence: number;
    }>();

    vi.mocked(sdk.threads.editMessage).mockReturnValueOnce(edit.promise);

    const later = conversationRow({ id: "reply", text: "Old reply", seq: 2 });

    queryClient.setQueryData(threadTimelineQueryKey("thread-1"), {
      ...makeBannerTimeline(),
      rows: [
        conversationRow({
          id: "edited",
          role: "user",
          text: "Original",
          seq: 1,
        }),
        later,
      ],
    });

    const { result } = renderHook(() => useEditThreadMessage(), {
      wrapper,
    });

    let editPromise!: Promise<unknown>;
    act(() => {
      editPromise = result.current.mutateAsync({
        id: "thread-1",
        messageId: "edited",
        operationId: "edit-op-1",
        expectedRequestSequence: 41,
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      });
    });
    await waitFor(() => expect(sdk.threads.editMessage).toHaveBeenCalledOnce());
    expect(sdk.threads.editMessage).toHaveBeenCalledWith(
      expect.not.objectContaining({ messageId: expect.anything() }),
    );
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([
      expect.objectContaining({ id: "edited", text: "Replacement" }),
      later,
    ]);
    expect(invalidateQueries).not.toHaveBeenCalled();

    edit.resolve({
      ok: true,
      operationId: "edit-op-1",
      requestSequence: 42,
    });
    await act(async () => {
      await editPromise;
    });
    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it("invalidates rewritten history after edit success when realtime is disconnected", async () => {
    vi.mocked(wsManager.getConnectionState).mockReturnValue("reconnecting");
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useEditThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        messageId: "edited",
        operationId: "edit-op-disconnected",
        expectedRequestSequence: 41,
        input: [{ type: "text", text: "Replacement", mentions: [] }],
      });
    });

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: threadTimelineQueryKey("thread-1") }),
    );
  });

  it("starts the edited turn at once and restores the text and status when the edit fails", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const edit = createDeferredPromise<{
      ok: true;
      operationId: string;
      requestSequence: number;
    }>();

    vi.mocked(sdk.threads.editMessage).mockReturnValueOnce(edit.promise);

    const thread = makeThreadResponse({
      status: "idle",
      runtime: { displayStatus: "idle" },
    });

    const timeline = {
      ...makeBannerTimeline(),
      rows: [
        conversationRow({
          id: "edited",
          role: "user",
          text: "Original",
          seq: 1,
        }),
      ],
    };

    queryClient.setQueryData(threadQueryKey("thread-1"), thread);
    queryClient.setQueryData(threadTimelineQueryKey("thread-1"), timeline);

    const { result } = renderHook(() => useEditThreadMessage(), { wrapper });

    let editPromise!: Promise<unknown>;
    act(() => {
      editPromise = result.current
        .mutateAsync({
          id: "thread-1",
          messageId: "edited",
          operationId: "edit-op-failed",
          input: [{ type: "text", text: "Replacement", mentions: [] }],
        })
        .catch(() => undefined);
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData<ThreadResponse>(threadQueryKey("thread-1"))
          ?.status,
      ).toBe("active"),
    );
    expect(
      displayedTimelineRows(
        queryClient,
        threadTimelineQueryKey("thread-1"),
      )?.[0],
    ).toMatchObject({ text: "Replacement" });

    edit.reject(new Error("rewind failed"));
    await act(async () => {
      await editPromise;
    });

    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toEqual(timeline);
    expect(
      queryClient.getQueryData<ThreadResponse>(threadQueryKey("thread-1")),
    ).toMatchObject({ status: "idle", runtime: { displayStatus: "idle" } });
  });

  it.each([
    ["Plan", useCancelThreadPlan, () => sdk.threads.cancelPlan],
    ["Goal", useClearThreadGoal, () => sdk.threads.clearGoal],
  ] as const)(
    "invalidates persisted banner state only after successful %s cancellation",
    async (_label, useMutationHook, getSdkMethod) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();
      const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
      const cancellation = createDeferredPromise<{ ok: true }>();
      vi.mocked(getSdkMethod()).mockReturnValueOnce(cancellation.promise);
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeBannerTimeline(),
      );
      const { result } = renderHook(() => useMutationHook(), { wrapper });

      let cancellationPromise!: Promise<unknown>;
      act(() => {
        cancellationPromise = result.current.mutateAsync("thread-1");
      });
      await waitFor(() => expect(getSdkMethod()).toHaveBeenCalledOnce());
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toMatchObject({
        activePromptMode: { mode: "plan" },
        goal: { status: "active" },
      });

      cancellation.resolve({ ok: true });
      await act(async () => {
        await cancellationPromise;
      });
      expect(getSdkMethod()).toHaveBeenCalledWith({ threadId: "thread-1" });
      expect(invalidateQueries).toHaveBeenCalled();

      const timelineAfterSuccess =
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        );

      if (_label === "Plan") {
        expect(timelineAfterSuccess?.activePromptMode).toBeNull();
        expect(timelineAfterSuccess?.goal).toMatchObject({ status: "active" });
      } else {
        expect(timelineAfterSuccess?.activePromptMode).toMatchObject({
          mode: "plan",
        });
        expect(timelineAfterSuccess?.goal).toBeNull();
      }

      invalidateQueries.mockClear();
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeBannerTimeline(),
      );
      vi.mocked(getSdkMethod()).mockRejectedValueOnce(
        new Error("provider rejected cancellation"),
      );
      await act(async () => {
        await expect(result.current.mutateAsync("thread-1")).rejects.toThrow(
          "provider rejected cancellation",
        );
      });
      expect(invalidateQueries).not.toHaveBeenCalled();
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toMatchObject({
        activePromptMode: { mode: "plan" },
        goal: { status: "active" },
      });
    },
  );

  it("notifies composer submission only after the server accepts a message", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });
    const submitted = vi.fn();

    const dispose = subscribeComposerSubmitted(
      { kind: "thread", threadId: "thread-1" },
      submitted,
    );

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Run this", mentions: [] }],
    };

    try {
      vi.mocked(sdk.threads.send).mockRejectedValueOnce(new Error("offline"));
      await act(async () => {
        await expect(result.current.mutateAsync(request)).rejects.toThrow(
          "offline",
        );
      });
      expect(submitted).not.toHaveBeenCalled();
      await act(async () => {
        await result.current.mutateAsync(request);
      });
      expect(submitted).toHaveBeenCalledOnce();
    } finally {
      dispose();
    }
  });

  it("forwards execution input sources when sending a thread message", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Run this", mentions: [] }],
        executionInputSources,
      });
    });

    expect(sdk.threads.send).toHaveBeenCalledWith(
      expect.objectContaining({
        executionInputSources,
        threadId: "thread-1",
      }),
    );
  });

  it("accepts consecutive messages locally while transporting each thread in order", async () => {
    const firstSend = createDeferredPromise<{ ok: true; delivery: "sent" }>();
    vi.mocked(sdk.threads.send).mockImplementationOnce(() => firstSend.promise);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadQueryKey("thread-1"),
      makeThreadResponse({
        status: "idle",
        runtime: { displayStatus: "idle" },
      }),
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeBannerTimeline(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let first: Promise<unknown>;
    let second: Promise<unknown>;
    let otherThread: Promise<unknown>;
    await act(async () => {
      first = result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "First", mentions: [] }],
      });
    });
    await waitFor(() => expect(sdk.threads.send).toHaveBeenCalledTimes(1));
    await act(async () => {
      second = result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Second", mentions: [] }],
      });
      otherThread = result.current.mutateAsync({
        id: "thread-2",
        mode: "auto",
        input: [{ type: "text", text: "Independent", mentions: [] }],
      });
      await otherThread;
    });

    expect(
      vi.mocked(sdk.threads.send).mock.calls.map(([request]) => request.input),
    ).toEqual([
      [{ type: "text", text: "First", mentions: [] }],
      [{ type: "text", text: "Independent", mentions: [] }],
    ]);
    expect(
      displayedTimelineRows(
        queryClient,
        threadTimelineQueryKey("thread-1"),
      )?.map((row) => (row.kind === "conversation" ? row.text : null)),
    ).toEqual(["First", "Second"]);

    await act(async () => {
      firstSend.resolve({ ok: true, delivery: "sent" });
      await Promise.all([first!, second!]);
    });
    expect(vi.mocked(sdk.threads.send).mock.calls.at(-1)?.[0].input).toEqual([
      { type: "text", text: "Second", mentions: [] },
    ]);
  });

  it("publishes upload preparation immediately and sends only prepared input in order", async () => {
    const preparedInput =
      createDeferredPromise<{ type: "text"; text: string; mentions: [] }[]>();

    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeBannerTimeline(),
    );
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [
        { type: "text" as const, text: "Uploading report.pdf", mentions: [] },
      ],
      prepareInput: () => preparedInput.promise,
    };

    let upload: Promise<unknown>;
    let later: Promise<unknown>;
    await act(async () => {
      upload = result.current.mutateAsync(request);
      later = result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Later", mentions: [] }],
      });
      await result.current.mutateAsync({
        id: "thread-2",
        mode: "auto",
        input: [{ type: "text", text: "Independent", mentions: [] }],
      });
    });

    expect(
      displayedTimelineRows(
        queryClient,
        threadTimelineQueryKey("thread-1"),
      )?.map((row) => (row.kind === "conversation" ? row.text : null)),
    ).toEqual(["Uploading report.pdf", "Later"]);
    expect(
      vi.mocked(sdk.threads.send).mock.calls.map(([sent]) => sent.threadId),
    ).toEqual(["thread-2"]);

    await act(async () => {
      preparedInput.resolve([
        { type: "text", text: "Prepared attachment reference", mentions: [] },
      ]);
      await Promise.all([upload!, later!]);
    });

    expect(
      vi.mocked(sdk.threads.send).mock.calls.map(([sent]) => sent.input),
    ).toEqual([
      [{ type: "text", text: "Independent", mentions: [] }],
      [{ type: "text", text: "Prepared attachment reference", mentions: [] }],
      [{ type: "text", text: "Later", mentions: [] }],
    ]);
    expect(vi.mocked(sdk.threads.send).mock.calls[1]?.[0]).not.toHaveProperty(
      "prepareInput",
    );
    expect(
      queryClient.getQueryData<PromptHistoryResponse>(
        threadPromptHistoryQueryKey("thread-1"),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: [
            {
              type: "text",
              text: "Prepared attachment reference",
              mentions: [],
            },
          ],
        }),
      ]),
    );
    expect(request.input).toEqual([
      { type: "text", text: "Uploading report.pdf", mentions: [] },
    ]);
  });

  it.each(["submitted", "cancelled"] as const)(
    "keeps later text behind a voice submission until it is %s",
    async (outcome) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeBannerTimeline(),
      );
      const { result } = renderHook(() => useSendThreadMessage(), { wrapper });
      const voice = result.current.reserve("thread-1");
      let typed: Promise<unknown>;
      await act(async () => {
        typed = result.current.mutateAsync({
          id: "thread-1",
          mode: "auto",
          input: [{ type: "text", text: "Typed after voice", mentions: [] }],
        });
      });
      expect(sdk.threads.send).not.toHaveBeenCalled();
      expect(
        displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
      ).toMatchObject([{ text: "Typed after voice" }]);

      await act(async () => {
        if (outcome === "submitted") {
          await result.current.mutateAsync({
            id: "thread-1",
            mode: "auto",
            input: [{ type: "text", text: "Voice transcript", mentions: [] }],
            sendReservation: voice,
          });
        } else {
          voice.cancel();
        }

        await typed!;
      });
      expect(
        vi
          .mocked(sdk.threads.send)
          .mock.calls.map(([request]) => request.input),
      ).toEqual([
        ...(outcome === "submitted"
          ? [[{ type: "text", text: "Voice transcript", mentions: [] }]]
          : []),
        [{ type: "text", text: "Typed after voice", mentions: [] }],
      ]);
    },
  );

  it("keeps Send now behind an earlier accepted voice submission", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage(),
    ]);

    const { result } = renderHook(
      () => ({
        send: useSendThreadMessage(),
        queued: useSendThreadQueuedMessage(),
      }),
      { wrapper },
    );

    const voice = result.current.send.reserve("thread-1");
    let queued: Promise<unknown>;
    await act(async () => {
      queued = result.current.queued.mutateAsync({
        id: "thread-1",
        queuedMessageId: "qmsg-1",
        mode: "auto",
      });
    });
    expect(sdk.threads.queuedMessages.send).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.send.mutateAsync({
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "Voice transcript", mentions: [] }],
        sendReservation: voice,
      });
      await queued!;
    });
    expect(
      vi.mocked(sdk.threads.send).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(sdk.threads.queuedMessages.send).mock.invocationCallOrder[0]!,
    );
  });

  it("returns the server's delivery so a queued message is not treated as a started turn", async () => {
    vi.mocked(sdk.threads.send).mockResolvedValue({
      ok: true,
      delivery: "queued",
      queuedMessage: makeQueuedMessage({
        waitingOn: { kind: "interaction" },
      }),
    });
    const { wrapper } = createQueryClientTestHarness();
    const { result } = renderHook(() => useSendThreadMessage(), { wrapper });

    let sendResult: Awaited<ReturnType<typeof result.current.mutateAsync>> = {
      ok: true,
      delivery: "sent",
    };

    await act(async () => {
      sendResult = await result.current.mutateAsync({
        id: "thread-1",
        mode: "steer-if-active",
        input: [{ type: "text", text: "worker report", mentions: [] }],
      });
    });

    expect(sendResult).toEqual({
      ok: true,
      delivery: "queued",
      queuedMessage: makeQueuedMessage({
        waitingOn: { kind: "interaction" },
      }),
    });
  });

  it("restores a queued-row steer when provisioning keeps it queued", async () => {
    const queuedMessage = makeQueuedMessage({
      waitingOn: { kind: "thread-busy" },
    });

    const provisioningQueuedMessage = makeQueuedMessage({
      waitingOn: { kind: "provisioning" },
      updatedAt: 2,
    });

    vi.mocked(sdk.threads.queuedMessages.send).mockResolvedValue({
      ok: true,
      delivery: "queued",
      queuedMessage: provisioningQueuedMessage,
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      queuedMessage,
    ]);
    queryClient.setQueryData(
      threadQueryKey("thread-1"),
      makeThreadResponse({
        status: "starting",
        runtime: {
          displayStatus: "provisioning",
        },
      }),
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeBannerTimeline(),
    );

    const { result } = renderHook(() => useSendThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        mode: "steer",
        queuedMessageId: queuedMessage.id,
      });
    });

    expect(
      queryClient.getQueryData(threadQueuedMessagesQueryKey("thread-1")),
    ).toEqual([provisioningQueuedMessage]);
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
  });

  it("forwards execution input sources and sender thread when queueing a message", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useCreateThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        input: [{ type: "text", text: "Queue this", mentions: [] }],
        senderThreadId: "thread-source",
        executionInputSources,
      });
    });

    expect(sdk.threads.queuedMessages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        executionInputSources,
        senderThreadId: "thread-source",
        threadId: "thread-1",
      }),
    );
  });

  it("drops a queued message the server reports as already sent", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage({ id: "qmsg-1" }),
      makeQueuedMessage({ id: "qmsg-2" }),
    ]);
    queryClient.setQueryData(threadQueryKey("thread-1"), makeThreadResponse());
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeBannerTimeline(),
    );
    vi.mocked(sdk.threads.queuedMessages.send).mockResolvedValue({
      ok: true,
      delivery: "already-sent",
    });

    const { result } = renderHook(() => useSendThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        mode: "auto",
        queuedMessageId: "qmsg-1",
        requestId: "creq_7777777777",
      });
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-2"]);
    expect(
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1")),
    ).toEqual([]);
  });

  it("keeps an optimistically deleted queued message removed when the server says it is already gone", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(threadQueuedMessagesQueryKey("thread-1"), [
      makeQueuedMessage({ id: "qmsg-1" }),
      makeQueuedMessage({ id: "qmsg-2" }),
    ]);
    vi.mocked(sdk.threads.queuedMessages.delete).mockRejectedValue(
      new OmnyoHttpError({
        status: 404,
        code: "invalid_request",
        message: "Queued message not found",
        body: {
          code: "invalid_request",
          message: "Queued message not found",
        },
      }),
    );

    const { result } = renderHook(() => useDeleteThreadQueuedMessage(), {
      wrapper,
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          id: "thread-1",
          queuedMessageId: "qmsg-1",
        }),
      ).resolves.toBe("missing");
    });

    expect(
      queryClient
        .getQueryData<ThreadQueuedMessage[]>(
          threadQueuedMessagesQueryKey("thread-1"),
        )
        ?.map((queuedMessage) => queuedMessage.id),
    ).toEqual(["qmsg-2"]);
  });

  it("sets the queued-message group boundary through the API", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useSetThreadQueuedMessageGroupBoundary(),
      { wrapper },
    );

    await act(async () => {
      await result.current.mutateAsync({
        id: "thread-1",
        expectedGroupedPrefixQueuedMessageIds: ["qmsg-1", "qmsg-2"],
        groupBoundaryQueuedMessageId: "qmsg-2",
      });
    });

    expect(sdk.threads.queuedMessages.setGroupBoundary).toHaveBeenCalledWith({
      expectedGroupedPrefixQueuedMessageIds: ["qmsg-1", "qmsg-2"],
      groupBoundaryQueuedMessageId: "qmsg-2",
      threadId: "thread-1",
    });
  });
});

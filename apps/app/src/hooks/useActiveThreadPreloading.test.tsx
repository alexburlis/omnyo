// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ResolvedThreadExecutionOptions } from "@omnyo/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadTimelineResponse } from "@omnyo/server-contract";
import { makeThreadListEntry } from "@omnyo/test-helpers/domain-fixtures";
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import { COMPACT_VIEWPORT_QUERY } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { resetNativeShellForTests } from "@/lib/native-shell";
import { installNativeShellForTest } from "@/test/native-shell-test-utils";
import { sdk } from "@/lib/sdk";
import { LazyThreadDetailView } from "@/views/thread-detail/LazyThreadDetailView";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  conversationRow,
  commandRow,
} from "@/test/fixtures/thread-timeline-rows";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  threadDetailBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "./queries/query-keys";
import {
  useThreadDetailBootstrap,
  useThreadTimeline,
} from "./queries/thread-queries";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import * as retentionPolicy from "./cache-owners/thread-timeline-retention-policy";
import {
  getThreadTimelineRuntimeId,
  touchThreadOpenCache,
} from "./cache-owners/thread-open-cache-owner";
import { markThreadTimelineUnseenEvents } from "./cache-owners/thread-timeline-unseen-events";
import { useActiveThreadPreloading } from "./useActiveThreadPreloading";
import { useThreadTimelineController } from "@/components/thread/timeline/useThreadTimelineController";

const startup = vi.hoisted(() => ({
  settled: true,
  listeners: new Set<() => void>(),
}));

vi.mock("@/lib/startup-settled", () => ({
  isStartupSettled: () => startup.settled,
  markStartupChatRendered: () => {},
  subscribeStartupSettled: (listener: () => void) => {
    startup.listeners.add(listener);

    return () => {
      startup.listeners.delete(listener);
    };
  },
  useStartupSettled: () => startup.settled,
}));

const clients: QueryClient[] = [];

const disposers: (() => void)[] = [];

function timeline(sequence = 1): ThreadTimelineResponse {
  return {
    ...makeThreadTimelineResponse({ maxSeq: sequence }),
    runtimeId: "runtime-preload",
  };
}

function harness() {
  const result = createQueryClientTestHarness();
  clients.push(result.queryClient);

  return result;
}

const activeThreads = Array.from({ length: 53 }, (_, index) =>
  makeThreadListEntry({ id: `thread-${index}`, latestAttentionAt: 53 - index }),
);

beforeEach(() => {
  startup.settled = true;
  startup.listeners.clear();
  vi.spyOn(LazyThreadDetailView, "preload").mockResolvedValue(undefined);
  vi.spyOn(sdk.server, "runtimeIdentity").mockResolvedValue({
    runtimeId: "runtime-preload",
  });
  vi.spyOn(sdk.threads, "get").mockImplementation(async ({ threadId }) => ({
    ...makeThreadResponse({ id: threadId }),
    environment: null,
    host: null,
  }));
  vi.spyOn(sdk.threads, "timeline").mockResolvedValue(timeline());
  vi.spyOn(sdk.threads, "defaultExecutionOptions").mockResolvedValue({
    model: "gpt-5.6-sol",
    serviceTier: "default",
    reasoningLevel: "xhigh",
    permissionMode: "full",
    source: "client/turn/start",
  } satisfies ResolvedThreadExecutionOptions);
});

afterEach(() => {
  cleanup();

  for (const dispose of disposers.splice(0)) dispose();

  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("active chat message preloading", () => {
  it("retains complete initialized conversations beyond 32 MiB without loading messages again when switching or refreshing bootstrap", async () => {
    vi.useFakeTimers();
    const selectedThreads = activeThreads.slice(0, 12);
    const text = "x".repeat(3 * 1024 * 1024);
    vi.mocked(sdk.threads.timeline).mockImplementation(
      async ({ threadId }) => ({
        ...timeline(),
        contextBoundarySeq: 17,
        timelinePage: {
          ...timeline().timelinePage,
          historySnapshot: "retained-conversations",
        },
        rows: [
          conversationRow({ id: `${threadId}-answer`, threadId, text }),
          commandRow({
            id: `${threadId}-command`,
            threadId,
            command: "sample",
            output: "Complete tool output",
          }),
        ],
      }),
    );
    const { queryClient, wrapper } = harness();

    try {
      renderHook(() => useActiveThreadPreloading(selectedThreads), { wrapper });
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(
        selectedThreads.length,
      );

      for (const thread of selectedThreads) {
        const retained = queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(thread.id),
        );

        expect(retained?.rows.map((row) => row.id)).toEqual([
          `${thread.id}-answer`,
          `${thread.id}-command`,
        ]);
        expect(retained?.contextBoundarySeq).toBe(17);
      }

      await act(async () => vi.advanceTimersByTimeAsync(3_000));

      for (const thread of selectedThreads) {
        const view = renderHook(
          () => {
            useThreadDetailBootstrap(thread.id, { timelinePrefetch: true });

            return useThreadTimelineController({ threadId: thread.id });
          },
          { wrapper },
        );

        expect(view.result.current.timelineLoading).toBe(false);
        expect(view.result.current.isReadOnlyDisplay).toBe(false);
        expect(view.result.current.contextBoundarySeq).toBe(17);
        expect(view.result.current.timelineRows.map((row) => row.id)).toEqual([
          `${thread.id}-answer`,
          `${thread.id}-command`,
        ]);
        await act(async () => {
          await queryClient.invalidateQueries({
            queryKey: threadDetailBootstrapQueryKey(thread.id),
            exact: true,
          });
        });
        view.unmount();
      }

      expect(sdk.threads.timeline).toHaveBeenCalledTimes(
        selectedThreads.length,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { change: "events-appended", hidden: false },
    { change: "events-appended", hidden: true },
    { change: "status-changed", hidden: false },
    { change: "status-changed", hidden: true },
    { change: "interactions-changed", hidden: false },
    { change: "interactions-changed", hidden: true },
  ] as const)(
    "loads $change before opening a chat (hidden=$hidden)",
    async ({ change, hidden }) => {
      vi.useFakeTimers();
      let visible = true;
      vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
        visible ? "visible" : "hidden",
      );
      const { queryClient, wrapper } = harness();
      const realtime = createRealtimeCacheEffects({ queryClient });
      disposers.push(realtime.dispose);

      try {
        renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
          wrapper,
        });
        await act(async () => vi.advanceTimersByTimeAsync(100));
        expect(sdk.threads.timeline).toHaveBeenCalledOnce();

        const latest = {
          ...timeline(2),
          rows: [
            conversationRow({
              id: "latest-message",
              threadId: "thread-0",
              seq: 2,
              text: "The latest answer is ready",
            }),
          ],
        };

        vi.mocked(sdk.threads.timeline).mockResolvedValue(latest);
        visible = !hidden;
        act(() => {
          document.dispatchEvent(new Event("visibilitychange"));
          realtime.handleChanged({
            type: "changed",
            entity: "thread",
            id: "thread-0",
            changes: [change],
            metadata:
              change === "events-appended"
                ? { timelineSequence: 2, eventTypes: ["turn/completed"] }
                : change === "interactions-changed"
                  ? { hasPendingInteraction: true }
                  : undefined,
          });
        });
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey("thread-0"),
          )?.rows,
        ).toEqual(latest.rows);
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
        await act(async () => vi.advanceTimersByTimeAsync(60_000));
        visible = true;
        act(() => document.dispatchEvent(new Event("visibilitychange")));

        const opened = renderHook(() => useThreadTimeline("thread-0"), {
          wrapper,
        });

        expect(opened.result.current.data?.rows).toEqual(latest.rows);
        expect(opened.result.current.isFetching).toBe(false);
        await act(async () => vi.advanceTimersByTimeAsync(100));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("keeps attention received during a background read until a trailing read settles", async () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = harness();
    const realtime = createRealtimeCacheEffects({ queryClient });
    disposers.push(realtime.dispose);
    let release: (response: ThreadTimelineResponse) => void = () => {};

    try {
      renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
        wrapper,
      });
      await act(async () => vi.advanceTimersByTimeAsync(100));
      vi.mocked(sdk.threads.timeline)
        .mockImplementationOnce(
          () => new Promise((resolve) => (release = resolve)),
        )
        .mockResolvedValue(timeline(3));
      act(() =>
        realtime.handleChanged({
          type: "changed",
          entity: "thread",
          id: "thread-0",
          changes: ["events-appended"],
          metadata: { timelineSequence: 2 },
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      act(() =>
        realtime.handleChanged({
          type: "changed",
          entity: "thread",
          id: "thread-0",
          changes: ["interactions-changed"],
          metadata: { hasPendingInteraction: true },
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(100));
      await act(async () => release(timeline(2)));
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-0"),
        )?.maxSeq,
      ).toBe(3);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    "events-appended",
    "status-changed",
    "interactions-changed",
  ] as const)(
    "wakes a pressure-evicted chat on %s without a background reload loop",
    async (change) => {
      vi.useFakeTimers();
      const selectedThreads = activeThreads.slice(0, 16);
      const selectEvictions = retentionPolicy.selectTimelineCacheEvictions;
      let pressureApplied = false;
      vi.spyOn(
        retentionPolicy,
        "selectTimelineCacheEvictions",
      ).mockImplementation((candidates) => {
        if (!pressureApplied && candidates.length === selectedThreads.length) {
          pressureApplied = true;

          return [selectedThreads[0]!.id];
        }

        return selectEvictions(candidates);
      });
      vi.mocked(sdk.threads.timeline).mockImplementation(
        async ({ threadId }) => ({
          ...timeline(),
          rows: [
            conversationRow({
              id: `${threadId}-message`,
              threadId,
              seq: 1,
              text: "α".repeat(320_000),
            }),
          ],
        }),
      );
      const { queryClient, wrapper } = harness();

      try {
        renderHook(() => useActiveThreadPreloading(selectedThreads), {
          wrapper,
        });
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        const reads = vi.mocked(sdk.threads.timeline).mock.calls;
        expect(reads).toHaveLength(selectedThreads.length);
        expect(new Set(reads.map(([args]) => args.threadId)).size).toBe(
          selectedThreads.length,
        );

        const cold = selectedThreads.find(
          (thread) =>
            queryClient.getQueryData(threadTimelineQueryKey(thread.id)) ===
            undefined,
        );

        expect(cold).toBeDefined();

        if (!cold)
          throw new Error("The pressure decision must evict one timeline");
        const realtime = createRealtimeCacheEffects({ queryClient });
        disposers.push(realtime.dispose);
        act(() =>
          realtime.handleChanged({
            type: "changed",
            entity: "thread",
            id: cold.id,
            changes: [change],
            metadata:
              change === "events-appended"
                ? { timelineSequence: 2 }
                : undefined,
          }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(2_000));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(
          selectedThreads.length + 1,
        );
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(
          selectedThreads.length + 1,
        );

        const demand = renderHook(() => useThreadTimeline(cold.id), {
          wrapper,
        });

        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(demand.result.current.data?.rows[0]?.id).toBe(
          `${cold.id}-message`,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("promotes an in-flight background read for a visible observer and keeps the shared result", async () => {
    const { queryClient, wrapper } = harness();

    const requests: Array<{
      priority: string | undefined;
      aborted: boolean;
      release: () => void;
    }> = [];

    vi.mocked(sdk.threads.timeline).mockImplementation(
      (args) =>
        new Promise((resolve, reject) => {
          const request = {
            priority: args.priority,
            aborted: false,
            release: () => resolve(timeline(2)),
          };

          requests.push(request);
          args.signal?.addEventListener(
            "abort",
            () => {
              request.aborted = true;
              reject(new DOMException("Request aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
      wrapper,
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    const demand = renderHook(() => useThreadTimeline("thread-0"), { wrapper });
    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[0]?.priority).toBe("background");
    expect(requests[0]?.aborted).toBe(true);
    expect(requests[1]?.priority).toBeUndefined();
    await act(async () => requests[1]?.release());
    await waitFor(() => expect(demand.result.current.data?.maxSeq).toBe(2));
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
    ).toEqual(timeline(2));
    expect(requests).toHaveLength(2);
  });

  it.each([false, true])(
    "warms every eligible chat beyond the pointer cache cap (coarse=%s)",
    async (coarse) => {
      vi.useFakeTimers();

      try {
        vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
          matches: coarse && query === POINTER_COARSE_QUERY,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent: () => false,
        }));
        const { queryClient, wrapper } = harness();
        const find = vi.spyOn(queryClient.getQueryCache(), "find");

        const threads = [
          ...[...activeThreads].reverse(),
          makeThreadListEntry({ id: "archived", archivedAt: 1 }),
          makeThreadListEntry({ id: "deleted", deletedAt: 1 }),
          makeThreadListEntry({ id: "hidden", visibility: "hidden" }),
        ];

        renderHook(() => useActiveThreadPreloading(threads), { wrapper });

        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(53);
        expect(queryClient.isFetching()).toBe(0);
        expect(
          vi
            .mocked(sdk.threads.timeline)
            .mock.calls.map(([args]) => args.threadId),
        ).toEqual(activeThreads.map((thread) => thread.id));

        for (const thread of activeThreads) {
          expect(
            queryClient.getQueryData(threadTimelineQueryKey(thread.id)),
          ).toBeDefined();
          expect(
            queryClient.getQueryData(threadDetailBootstrapQueryKey(thread.id)),
          ).toBeDefined();
          expect(getThreadTimelineRuntimeId(queryClient, thread.id)).toBe(
            "runtime-preload",
          );
        }

        expect(sdk.threads.get).toHaveBeenCalledTimes(53);
        expect(
          find.mock.calls.filter(
            ([filters]) =>
              filters.exact &&
              filters.queryKey?.[0] === threadTimelineQueryKey("")[0],
          ),
        ).toHaveLength(0);
        expect(
          vi
            .mocked(sdk.threads.timeline)
            .mock.calls.every(
              ([args]) =>
                args.beforeAnchorSeq === undefined &&
                args.beforeAnchorId === undefined,
            ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds background reads while demand starts a queued chat immediately", async () => {
    const pending: (() => void)[] = [];
    vi.mocked(sdk.threads.timeline).mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(timeline()));
        }),
    );
    const { queryClient, wrapper } = harness();

    for (const thread of activeThreads.slice(2, -1))
      markThreadTimelineUnseenEvents(queryClient, thread.id, 2, true);

    const background = renderHook(
      () => useActiveThreadPreloading(activeThreads),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    const reads = vi.spyOn(queryClient, "getQueryData");
    act(() =>
      queryClient.setQueryData(threadTimelineQueryKey("thread-0"), timeline()),
    );
    reads.mockClear();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    expect(
      reads.mock.calls.filter(
        ([key]) =>
          key[0] === threadTimelineQueryKey("")[0] &&
          activeThreads.slice(2, -1).some((thread) => thread.id === key[1]),
      ),
    ).toHaveLength(0);

    const demand = renderHook(() => useThreadTimeline("thread-52"), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[2]?.[0].threadId).toBe(
      "thread-52",
    );

    background.unmount();
    await act(async () => {
      for (const release of pending) release();
    });
    await waitFor(() => {
      expect(demand.result.current.isSuccess).toBe(true);
      expect(queryClient.isFetching()).toBe(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
  });

  it("refreshes a non-open chat when its turn completes, not on every mid-turn event", async () => {
    const { queryClient, wrapper } = harness();
    renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
      wrapper,
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
      ).toBeDefined();
    });
    const realtime = createRealtimeCacheEffects({ queryClient });
    disposers.push(realtime.dispose);
    vi.mocked(sdk.threads.timeline).mockResolvedValue(timeline(3));
    const readsBeforeEvents = vi.mocked(sdk.threads.timeline).mock.calls.length;

    act(() =>
      realtime.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thread-0",
        changes: ["events-appended"],
        metadata: { timelineSequence: 2, eventTypes: ["item/completed"] },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(readsBeforeEvents);

    act(() =>
      realtime.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thread-0",
        changes: ["events-appended"],
        metadata: { timelineSequence: 3, eventTypes: ["turn/completed"] },
      }),
    );
    await waitFor(
      () =>
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(
          readsBeforeEvents + 1,
        ),
      { timeout: 2_500 },
    );
  });

  it("catches up a non-open chat when an event arrives during a read", async () => {
    const { queryClient, wrapper } = harness();
    renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
      wrapper,
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
      ).toBeDefined();
    });
    const realtime = createRealtimeCacheEffects({ queryClient });
    disposers.push(realtime.dispose);
    let releaseSecond: (value: ThreadTimelineResponse) => void = () => {};

    vi.mocked(sdk.threads.timeline)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          }),
      )
      .mockResolvedValue(timeline(3));

    const changed = (sequence: number) =>
      realtime.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thread-0",
        changes: ["events-appended"],
        metadata: { timelineSequence: sequence },
      });

    act(() => changed(2));
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
    });
    act(() => changed(3));
    await new Promise((resolve) => setTimeout(resolve, 250));
    await act(async () => releaseSecond(timeline(2)));
    await waitFor(
      () => {
        expect(
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey("thread-0"),
          )?.maxSeq,
        ).toBe(3);
      },
      { timeout: 2_500 },
    );
  });

  it.each([
    { leave: "before", catchUpSequence: 2, reopen: false },
    { leave: "after", catchUpSequence: 2, reopen: false },
    { leave: "before", catchUpSequence: 1, reopen: false },
    { leave: "before", catchUpSequence: 2, reopen: true },
  ])(
    "finishes a foreground read left $leave settlement with catch-up sequence $catchUpSequence (reopen=$reopen)",
    async ({ leave, catchUpSequence, reopen }) => {
      vi.useFakeTimers();
      const { queryClient, wrapper } = harness();

      try {
        renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 2)), {
          wrapper,
        });
        await act(async () => vi.advanceTimersByTimeAsync(100));

        const visible = renderHook(() => useThreadTimeline("thread-0"), {
          wrapper,
        });

        let finish: (value: ThreadTimelineResponse) => void = () => {};

        vi.mocked(sdk.threads.timeline)
          .mockImplementationOnce(
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          )
          .mockResolvedValue(timeline(catchUpSequence));

        act(() => {
          void queryClient.refetchQueries({
            queryKey: threadTimelineQueryKey("thread-0"),
            exact: true,
            type: "active",
          });
        });
        await act(async () => vi.advanceTimersByTimeAsync(100));
        const realtime = createRealtimeCacheEffects({ queryClient });
        disposers.push(realtime.dispose);
        act(() =>
          realtime.handleChanged({
            type: "changed",
            entity: "thread",
            id: "thread-0",
            changes: ["events-appended"],
            metadata: { timelineSequence: 2 },
          }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(250));

        if (leave === "before") visible.unmount();

        const returned = reopen
          ? renderHook(() => useThreadTimeline("thread-0"), { wrapper })
          : null;

        await act(async () => finish(timeline(1)));

        if (leave === "after") visible.unmount();
        await act(async () => vi.advanceTimersByTimeAsync(2_000));

        expect(
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey("thread-0"),
          )?.maxSeq,
        ).toBe(catchUpSequence);

        if (returned) expect(returned.result.current.data?.maxSeq).toBe(2);
        const reads = vi.mocked(sdk.threads.timeline).mock.calls.length;
        expect(reads).toBe(4);
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(reads);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "events-appended",
    "status-changed",
    "interactions-changed",
  ] as const)(
    "catches up %s before continuing untouched cold chats",
    async (change) => {
      vi.useFakeTimers();
      const { queryClient, wrapper } = harness();
      const pending: (() => void)[] = [];

      vi.mocked(sdk.threads.timeline).mockImplementation(
        ({ threadId }) =>
          new Promise((resolve) => {
            pending.push(() =>
              resolve(timeline(threadId === "thread-3" ? 2 : 1)),
            );
          }),
      );
      queryClient.setQueryData(threadTimelineQueryKey("thread-3"), timeline(1));

      try {
        renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 4)), {
          wrapper,
        });
        await act(async () => vi.advanceTimersByTimeAsync(100));
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
        const realtime = createRealtimeCacheEffects({ queryClient });
        disposers.push(realtime.dispose);
        act(() =>
          realtime.handleChanged({
            type: "changed",
            entity: "thread",
            id: "thread-3",
            changes: [change],
            metadata:
              change === "events-appended"
                ? { timelineSequence: 2 }
                : undefined,
          }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(250));
        await act(async () => pending.shift()?.());
        await act(async () => vi.advanceTimersByTimeAsync(100));
        expect(
          vi.mocked(sdk.threads.timeline).mock.calls[2]?.[0].threadId,
        ).toBe("thread-3");
        act(() =>
          realtime.handleChanged({
            type: "changed",
            entity: "thread",
            id: "thread-3",
            changes: ["events-appended"],
            metadata: { timelineSequence: 3 },
          }),
        );
        await act(async () => vi.advanceTimersByTimeAsync(1_100));
        await act(async () => pending.pop()?.());
        await act(async () => vi.advanceTimersByTimeAsync(100));
        expect(
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey("thread-3"),
          )?.maxSeq,
        ).toBe(2);
        expect(
          vi.mocked(sdk.threads.timeline).mock.calls[3]?.[0].threadId,
        ).toBe("thread-2");
        cleanup();
        await act(async () => {
          for (const finish of pending) finish();
        });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("reads other chats only after the focused chat has settled", async () => {
    vi.useFakeTimers();

    try {
      startup.settled = false;
      const { wrapper } = harness();

      renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 3)), {
        wrapper,
      });

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(sdk.threads.timeline).not.toHaveBeenCalled();
      expect(startup.listeners.size).toBe(1);

      startup.settled = true;

      act(() => {
        for (const listener of [...startup.listeners]) listener();
      });

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
      expect(startup.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      phone: "a compact viewport",
      install: () => {
        vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
          matches: query === COMPACT_VIEWPORT_QUERY,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }));

        return () => {};
      },
    },
    {
      phone: "the native phone app",
      install: () => {
        installNativeShellForTest();

        return () => {
          Reflect.deleteProperty(window, "omnyo");
          Reflect.deleteProperty(window, "ReactNativeWebView");
          resetNativeShellForTests();
        };
      },
    },
  ])(
    "does not read other chats in the background in $phone, but still loads the opened chat",
    async ({ install }) => {
      const uninstall = install();
      vi.useFakeTimers();

      try {
        const { wrapper } = harness();

        renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 3)), {
          wrapper,
        });

        await act(async () => vi.advanceTimersByTimeAsync(5_000));
        expect(sdk.threads.timeline).not.toHaveBeenCalled();
        expect(sdk.threads.get).not.toHaveBeenCalled();

        renderHook(() => useThreadTimeline("thread-1"), { wrapper });
        await act(async () => vi.advanceTimersByTimeAsync(1_000));
        expect(
          vi
            .mocked(sdk.threads.timeline)
            .mock.calls.map(([args]) => args.threadId),
        ).toEqual(["thread-1"]);
      } finally {
        vi.useRealTimers();
        uninstall();
      }
    },
  );

  it("stops warming removed targets and releases their retention", async () => {
    vi.useFakeTimers();

    try {
      const { queryClient, wrapper } = harness();

      const view = renderHook(
        ({ threads }) => useActiveThreadPreloading(threads),
        { initialProps: { threads: activeThreads }, wrapper },
      );

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(53);
      expect(queryClient.isFetching()).toBe(0);
      view.rerender({ threads: activeThreads.slice(1) });
      act(() => {
        void queryClient.invalidateQueries({
          queryKey: threadTimelineQueryKey("thread-0"),
        });

        for (let index = 0; index < 21; index += 1) {
          touchThreadOpenCache(queryClient, `archive-${index}`);
        }
      });
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(53);
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
      ).toBeUndefined();
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("warms latest messages while hidden and catches up before the document returns", async () => {
    let visible = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      visible ? "visible" : "hidden",
    );
    const { queryClient, wrapper } = harness();
    renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
      wrapper,
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
      ).toBeDefined();
    });
    expect(sdk.threads.timeline).toHaveBeenCalledOnce();
    visible = true;
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await waitFor(() => {
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-0")),
      ).toBeDefined();
    });
  });
  it("warms one older page per target after all latest pages, serially and without retaining its payload", async () => {
    const threads = activeThreads.slice(0, 4);
    const { queryClient, wrapper } = harness();
    const pending: (() => void)[] = [];
    const oldCalls: string[] = [];
    vi.mocked(sdk.threads.timeline).mockImplementation(async (args) => {
      if (args.beforeAnchorId !== undefined) {
        oldCalls.push(args.threadId);
        expect(args.priority).toBe("background");
        expect(
          vi
            .mocked(sdk.threads.timeline)
            .mock.calls.filter(([a]) => a.beforeAnchorId === undefined),
        ).toHaveLength(4);

        return new Promise((resolve) =>
          pending.push(() =>
            resolve({
              ...timeline(),
              rows: [
                conversationRow({
                  id: "older-only-content",
                  text: "older-only-content",
                }),
              ],
            }),
          ),
        );
      }

      return {
        ...timeline(),
        timelinePage: {
          ...timeline().timelinePage,
          hasOlderRows: true,
          olderCursor: { anchorSeq: 1, anchorId: `older-${args.threadId}` },
          historySnapshot: JSON.stringify({
            version: 5,
            threadId: args.threadId,
            maxSeq: 1,
            status: "active",
            surface: "test",
            historyEpoch: "a".repeat(32),
          }),
        },
      };
    });

    const preload = renderHook(() => useActiveThreadPreloading(threads), {
      wrapper,
    });

    for (let index = 0; index < threads.length; index += 1) {
      await waitFor(() => expect(oldCalls).toHaveLength(index + 1));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(oldCalls).toHaveLength(index + 1);
      await act(async () => pending.shift()?.());
    }

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(new Set(oldCalls).size).toBe(4);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain("older-only-content");
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .filter((q) => q.queryKey[0] === threadTimelineQueryKey("thread-0")[0]),
    ).toHaveLength(4);
    preload.unmount();
    renderHook(() => useActiveThreadPreloading(threads), { wrapper });

    for (let index = 0; index < threads.length; index += 1) {
      await waitFor(() =>
        expect(oldCalls).toHaveLength(threads.length + index + 1),
      );
      await act(async () => pending.shift()?.());
    }

    expect(
      vi
        .mocked(sdk.threads.timeline)
        .mock.calls.filter(([a]) => a.beforeAnchorId === undefined),
    ).toHaveLength(4);
  });

  it.each(["removed", "hidden", "runtime", "epoch"] as const)(
    "cancels an older prewarm on %s",
    async (change) => {
      const { queryClient, wrapper } = harness();
      let olderSignal: AbortSignal | undefined;

      const latest = {
        ...timeline(),
        timelinePage: {
          ...timeline().timelinePage,
          hasOlderRows: true,
          olderCursor: { anchorSeq: 1, anchorId: "older" },
          historySnapshot: JSON.stringify({
            version: 5,
            threadId: "thread-0",
            maxSeq: 1,
            status: "active",
            surface: "test",
            historyEpoch: "a".repeat(32),
          }),
        },
      };

      vi.mocked(sdk.threads.timeline).mockImplementation(async (args) => {
        if (!args.beforeAnchorId) return latest;
        olderSignal = args.signal;

        return new Promise((_resolve, reject) =>
          args.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true },
          ),
        );
      });

      const view = renderHook(
        ({ threads }) => useActiveThreadPreloading(threads),
        { wrapper, initialProps: { threads: activeThreads.slice(0, 1) } },
      );

      await waitFor(() => expect(olderSignal).toBeDefined());
      act(() => {
        if (change === "removed") view.rerender({ threads: [] });

        if (change === "hidden") {
          vi.spyOn(document, "visibilityState", "get").mockReturnValue(
            "hidden",
          );
          document.dispatchEvent(new Event("visibilitychange"));
        }

        if (change === "runtime")
          queryClient.setQueryData(
            threadOpenRuntimeIdentityQueryKey(),
            "other-runtime",
          );

        if (change === "epoch")
          queryClient.setQueryData(threadTimelineQueryKey("thread-0"), {
            ...latest,
            timelinePage: {
              ...latest.timelinePage,
              historySnapshot: latest.timelinePage.historySnapshot.replace(
                "a".repeat(32),
                "b".repeat(32),
              ),
            },
          });
      });
      await waitFor(() => expect(olderSignal?.aborted).toBe(true));
    },
  );

  it("keeps a stable older derivation through unrelated refreshes and never timer-retries its failure", async () => {
    vi.useFakeTimers();
    const { queryClient, wrapper } = harness();
    let olderSignal: AbortSignal | undefined;
    let fail: () => void = () => {};

    const latest = {
      ...timeline(),
      timelinePage: {
        ...timeline().timelinePage,
        hasOlderRows: true,
        olderCursor: { anchorSeq: 1, anchorId: "older" },
        historySnapshot: JSON.stringify({
          version: 5,
          threadId: "thread-0",
          maxSeq: 1,
          status: "active",
          surface: "test",
          historyEpoch: "a".repeat(32),
        }),
      },
    };

    vi.mocked(sdk.threads.timeline).mockImplementation(async (args) => {
      if (!args.beforeAnchorId) return latest;
      olderSignal = args.signal;

      return new Promise((_resolve, reject) => {
        fail = () => reject(new Error("inert older failure"));
      });
    });

    try {
      renderHook(() => useActiveThreadPreloading(activeThreads.slice(0, 1)), {
        wrapper,
      });
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(olderSignal).toBeDefined();
      act(() =>
        queryClient.setQueryData(threadTimelineQueryKey("thread-0"), {
          ...latest,
          maxSeq: 2,
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(100));
      expect(olderSignal?.aborted).toBe(false);
      await act(async () => fail());
      await act(async () => vi.advanceTimersByTimeAsync(30_000));
      expect(
        vi
          .mocked(sdk.threads.timeline)
          .mock.calls.filter(([a]) => a.beforeAnchorId !== undefined),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

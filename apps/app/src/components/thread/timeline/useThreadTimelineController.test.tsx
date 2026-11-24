// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import {
  Profiler,
  useLayoutEffect,
  type ProfilerOnRenderCallback,
  type ReactNode,
} from "react";
import { MemoryRouter } from "react-router-dom";
import { createStore, Provider as JotaiProvider } from "jotai";
import { QueryClientProvider } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  ServerRuntimeIdentity,
  ThreadTimelineResponse,
  TimelineRow,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";
import { mergeLatestTimelineRows } from "@omnyo/client-core";
import {
  createDeferredPromise,
  type DeferredPromise,
} from "@omnyo/test-helpers";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  BottomAnchorContext,
  type BottomAnchorContextValue,
} from "@/components/ui/bottom-anchored-scroll-body.js";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { appToast } from "@/components/ui/app-toast";
import {
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { removeThreadScopedQueries } from "@/hooks/cache-owners/mutation-cache-effects";
import {
  addPendingSentMessage,
  removePendingSentMessage,
} from "@/hooks/cache-owners/pending-sent-messages";
import {
  clearPersistedThreadTimelineDisplays,
  peekPersistedThreadTimelineDisplay,
  prewarmThreadOlderPage,
  purgeThreadOpenHistoryCache,
  readPersistedThreadTimelineDisplay,
  rememberThreadOpenRuntimeId,
  rememberThreadTimelineRuntimeId,
  schedulePersistedThreadTimelineDisplay,
  THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES,
} from "@/hooks/cache-owners/thread-open-cache-owner";
import {
  hasThreadTimelineUnseenEvents,
  markThreadTimelineUnseenEvents,
} from "@/hooks/cache-owners/thread-timeline-unseen-events";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  commandRow,
  systemRow,
  turnRow,
} from "@/test/fixtures/thread-timeline-rows";
import { useAutoLoadOlderRows } from "./useAutoLoadOlderRows";
import {
  SearchMessageLocationProvider,
  useScrollToSearchedMessage,
} from "./useScrollToSearchedMessage";
import {
  TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS,
  useThreadTimelineController,
  type UseThreadTimelineControllerResult,
} from "./useThreadTimelineController";
import { makeThreadTimelineResponse as makeUnstampedTimelineResponse } from "@/test/fixtures/thread-responses";
import { createQueryNotificationScheduler } from "@/test/queryNotificationScheduler";

const notifications = createQueryNotificationScheduler();

function makeTimelineResponse(
  args: Parameters<typeof makeUnstampedTimelineResponse>[0] = {},
) {
  return {
    runtimeId: "runtime-test-1",
    ...makeUnstampedTimelineResponse(args),
  };
}

const RUNTIME_IDENTITY = {
  runtimeId: "runtime-test-1",
} satisfies ServerRuntimeIdentity;

beforeEach(() => {
  notifications.install();
  vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue(RUNTIME_IDENTITY);
});

const readTimelineQueryResultKeys = vi.hoisted(() => new Set<PropertyKey>());

vi.mock("@/lib/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sdk")>();

  return {
    ...actual,
    sdk: {
      server: { runtimeIdentity: vi.fn() },
      threads: { timeline: vi.fn() },
    },
  };
});

vi.mock("@/hooks/queries/thread-queries", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/queries/thread-queries")>();

  return {
    ...actual,
    useThreadTimeline: (...args: Parameters<typeof actual.useThreadTimeline>) =>
      new Proxy(actual.useThreadTimeline(...args), {
        get(target, key, receiver) {
          readTimelineQueryResultKeys.add(key);

          return Reflect.get(target, key, receiver);
        },
      }),
  };
});

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

vi.mock("@/hooks/useServerConnectionState", () => ({
  useServerConnectionState: () => "connected",
}));

afterEach(() => {
  cleanup();
  clearPersistedThreadTimelineDisplays();
  notifications.restore();
  vi.mocked(sdk.threads.timeline).mockReset();
  vi.mocked(sdk.server.runtimeIdentity).mockReset();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  readTimelineQueryResultKeys.clear();
});

const TIMELINE_QUERY_KEY = threadTimelineQueryKey("thread-1");

function makeUserRow(
  id: string,
  sourceSeq: number,
): TimelineUserConversationRow {
  return {
    id,
    kind: "conversation",
    role: "user",
    threadId: "thread-1",
    turnId: null,
    sourceSeqStart: sourceSeq,
    sourceSeqEnd: sourceSeq,
    messageSeq: sourceSeq,
    startedAt: 1,
    createdAt: 1,
    text: "hello",
    mentions: [],
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      clientRequestId: null,
      isGrouped: false,
      kind: "message",
      status: "accepted",
    },
  };
}

const contextClearRow = systemRow({
  id: "context-clear-10",
  seq: 10,
  title: "Context cleared",
  detail: null,
});

const newestLoadedRow = makeUserRow("thread-1:user-seed:1", 1);

const olderPageRow = makeUserRow("thread-1:user-seed:0", 0);

const realtimeRow = makeUserRow("thread-1:user-seed:2", 2);

function rowIds(controller: UseThreadTimelineControllerResult): string[] {
  return controller.timelineRows.map((row) => row.id);
}

function makeServerError(): OmnyoHttpError {
  return new OmnyoHttpError({
    body: null,
    code: null,
    message: "Server error",
    status: 500,
  });
}

async function renderControllerWithPendingOlderPage() {
  const olderPage = createDeferredPromise<ThreadTimelineResponse>();
  vi.mocked(sdk.threads.timeline)
    .mockResolvedValueOnce(
      makeTimelineResponse({
        rows: [newestLoadedRow],
        maxSeq: 1,
        timelinePage: {
          historySnapshot: "snapshot-1",
          hasOlderRows: true,
          olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
        },
      }),
    )
    .mockReturnValueOnce(olderPage.promise);

  const { queryClient, wrapper } = createQueryClientTestHarness();

  const { result } = renderHook(
    () => useThreadTimelineController({ threadId: "thread-1" }),
    { wrapper },
  );

  await waitFor(() => {
    expect(result.current.hasOlderTimelineRows).toBe(true);
  });

  let olderRequest: Promise<void> = Promise.resolve();
  act(() => {
    olderRequest = result.current.loadOlderTimelineRows();
  });
  await waitFor(() => {
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
  });

  const settleOlderPage = async () => {
    olderPage.resolve(
      makeTimelineResponse({
        rows: [olderPageRow],
        maxSeq: 1,
        timelinePage: { kind: "older", historySnapshot: "snapshot-1" },
      }),
    );
    await act(async () => {
      await olderRequest;
    });
  };

  const failOlderPage = async (error: OmnyoHttpError) => {
    olderPage.reject(error);
    await act(async () => {
      await expect(olderRequest).rejects.toBe(error);
    });
  };

  const publishLatest = (response: ThreadTimelineResponse) => {
    act(() => {
      queryClient.setQueryData(TIMELINE_QUERY_KEY, response);
    });
  };

  return {
    failOlderPage,
    publishLatest,
    queryClient,
    result,
    settleOlderPage,
  };
}

function makeSameSnapshotRealtimeResponse(): ThreadTimelineResponse {
  return makeTimelineResponse({
    rows: [newestLoadedRow, realtimeRow],
    maxSeq: 2,
    timelinePage: {
      historySnapshot: "snapshot-1",
      hasOlderRows: true,
      olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
    },
  });
}

function installAutoLoadEnvironment({ overflowing = true } = {}) {
  const scrollElement = document.createElement("div");
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: 500,
  });
  Object.defineProperty(scrollElement, "scrollHeight", {
    configurable: true,
    value: overflowing ? 5_000 : 500,
  });
  scrollElement.scrollTop = overflowing ? 2_000 : 0;

  const anchor: BottomAnchorContextValue = {
    holdContentPosition: vi.fn(),
    getScrollElement: () => scrollElement,
    isAtBottom: false,
    scrollElementIntoView: vi.fn(),
    scrollElementIntoViewClampedToMaxScroll: vi.fn(),
    scrollToBottom: vi.fn(),
  };

  const scrollUpNearTop = () => {
    scrollElement.scrollTop = 2_000;
    scrollElement.dispatchEvent(new Event("scroll"));
    scrollElement.scrollTop = 100;
    scrollElement.dispatchEvent(new Event("scroll"));
  };

  return { anchor, scrollUpNearTop };
}

function renderControllerWithAutoLoad(anchor: BottomAnchorContextValue) {
  const { queryClient, wrapper: queryWrapper } = createQueryClientTestHarness();

  const wrapper = ({ children }: { children: ReactNode }) =>
    queryWrapper({
      children: (
        <BottomAnchorContext.Provider value={anchor}>
          {children}
        </BottomAnchorContext.Provider>
      ),
    });

  const { result } = renderHook(
    () => {
      const timeline = useThreadTimelineController({ threadId: "thread-1" });

      const autoLoad = useAutoLoadOlderRows({
        hasOlderTimelineRows: timeline.hasOlderTimelineRows,
        isLoadingOlderTimelineRows: timeline.isLoadingOlderTimelineRows,
        onLoadOlderRows: timeline.loadOlderTimelineRows,
      });

      return { autoLoad, timeline };
    },
    { wrapper },
  );

  return { queryClient, result };
}

async function withReactSchedulerOutsideAct(
  run: () => Promise<void>,
): Promise<void> {
  const previousActEnvironment: unknown = Reflect.get(
    globalThis,
    "IS_REACT_ACT_ENVIRONMENT",
  );

  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);

  try {
    await run();
  } finally {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousActEnvironment);
  }
}

interface ProfiledController {
  latest: () => UseThreadTimelineControllerResult;
  profilerCommitCount: () => number;
}

function renderProfiledController(
  wrapper: (props: { children: ReactNode }) => ReactNode,
): ProfiledController {
  const latestResult: { current: UseThreadTimelineControllerResult | null } = {
    current: null,
  };

  let profilerCommits = 0;

  const onRender: ProfilerOnRenderCallback = () => {
    profilerCommits += 1;
  };

  function ControllerHost() {
    const controller = useThreadTimelineController({ threadId: "thread-1" });
    useLayoutEffect(() => {
      latestResult.current = controller;
    });

    return null;
  }

  render(
    <Profiler id="timeline-controller" onRender={onRender}>
      <ControllerHost />
    </Profiler>,
    { wrapper },
  );

  return {
    latest: () => {
      if (latestResult.current === null) {
        throw new Error("The timeline controller has not committed yet");
      }

      return latestResult.current;
    },
    profilerCommitCount: () => profilerCommits,
  };
}

function flushQueryNotifications(): Promise<void> {
  return notifications.flush();
}

async function renderSettledController(
  wrapper: (props: { children: ReactNode }) => ReactNode,
  expectedRowIds: string[],
): Promise<ProfiledController> {
  const view = renderProfiledController(wrapper);
  await waitFor(() => {
    expect(view.latest().timelineLoading).toBe(false);
    expect(rowIds(view.latest())).toEqual(expectedRowIds);
  });
  await flushQueryNotifications();

  return view;
}

function startTimelineRefetch(queryClient: QueryClient): void {
  act(() => {
    void queryClient.refetchQueries({ queryKey: TIMELINE_QUERY_KEY });
  });
}

function markTimelineHasNewEvents(queryClient: QueryClient): void {
  markThreadTimelineUnseenEvents(queryClient, "thread-1", 2, true);
  void queryClient.invalidateQueries({
    queryKey: TIMELINE_QUERY_KEY,
    refetchType: "none",
  });
}

describe("mergeLatestTimelineRows", () => {
  it("still appends genuinely disjoint server rows to retained ones", () => {
    const older = makeUserRow("thread-1:user-seed:1", 1);
    const newer = makeUserRow("thread-1:user-seed:5", 5);

    const merged = mergeLatestTimelineRows({
      latestRows: [newer],
      latestWindowStartSequence: 5,
      loadedRows: [older],
    });

    expect(merged.rows.map((row) => row.id)).toEqual([older.id, newer.id]);
  });
});

describe("persisted display preparation", () => {
  const scope = {
    origin: window.location.origin,
    runtimeId: "runtime-test-1",
    threadId: "thread-1",
  };

  const idleWrites: Array<() => void> = [];

  function schedule(rows: ThreadTimelineResponse["rows"]) {
    schedulePersistedThreadTimelineDisplay({
      ...scope,
      surfaceKey: "thread-1",
      response: makeTimelineResponse({
        rows,
        timelinePage: { historySnapshot: "snapshot-display" },
      }),
    });
  }

  beforeEach(() => {
    clearPersistedThreadTimelineDisplays();
    idleWrites.length = 0;
    vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
      idleWrites.push(() =>
        callback({ didTimeout: true, timeRemaining: () => 0 }),
      );

      return idleWrites.length;
    });
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    readPersistedThreadTimelineDisplay(scope);
  });

  it.for([
    { name: "ASCII", text: "x".repeat(700) },
    { name: "Unicode and escapes", text: '🦊é漢"\\\n'.repeat(54) },
  ])(
    "bounds foreground serialization for $name previews",
    ({ name, text }, { task }) => {
      const rows = Array.from({ length: 96 }, (_, index) => ({
        ...makeUserRow(`display-${index}`, index),
        text,
      }));

      const encoder = new TextEncoder();
      const payloadBytes = encoder.encode(JSON.stringify(rows)).byteLength;
      expect(payloadBytes).toBeLessThan(
        THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES,
      );
      const originalEncode = TextEncoder.prototype.encode;
      let encodedBytes = 0;

      const encode = vi
        .spyOn(TextEncoder.prototype, "encode")
        .mockImplementation(function (this: TextEncoder, input) {
          const bytes = originalEncode.call(this, input);
          encodedBytes += bytes.byteLength;

          return bytes;
        });

      onTestFinished(() => encode.mockRestore());

      const startedAt = performance.now();
      schedule(rows);
      const scheduleMs = performance.now() - startedAt;
      const foregroundEncodedBytes = encodedBytes;
      expect(idleWrites).toHaveLength(1);
      idleWrites[0]?.();
      const idleEncodedBytes = encodedBytes - foregroundEncodedBytes;
      expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual(rows);

      const measurement = {
        fixture: name,
        rows: rows.length,
        payloadBytes,
        foregroundEncodedBytes,
        idleEncodedBytes,
        scheduleMs,
      };

      Object.assign(task.meta, { persistedDisplayPreparation: measurement });
      expect(
        foregroundEncodedBytes,
        JSON.stringify(measurement),
      ).toBeLessThanOrEqual(payloadBytes * 2);
    },
  );

  it.each([0, 1])(
    "retains the exact Unicode byte boundary with %i overflow bytes",
    (overflowBytes) => {
      const newest = makeUserRow("display-newest", 4);

      const boundary = {
        ...makeUserRow("display-boundary", 1),
        text: '🦊é漢"\\\n',
      };

      const bytes = new TextEncoder().encode(
        JSON.stringify([boundary, newest]),
      ).byteLength;

      boundary.text += "x".repeat(
        THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES - bytes + overflowBytes,
      );

      const deferred = {
        ...commandRow({ id: "display-deferred", seq: 3, command: "inert" }),
        contentDeferred: true as const,
      };

      const pending = {
        ...makeUserRow("display-pending", 2),
        turnRequest: {
          clientRequestId: null,
          isGrouped: false,
          kind: "message" as const,
          status: "pending" as const,
        },
      };

      schedule([
        makeUserRow("display-before-boundary", 0),
        boundary,
        pending,
        deferred,
        newest,
      ]);
      idleWrites[0]?.();
      const retained = readPersistedThreadTimelineDisplay(scope)?.rows;
      expect(retained).toEqual(
        overflowBytes === 0 ? [boundary, newest] : [newest],
      );
      expect(
        new TextEncoder().encode(JSON.stringify(retained)).byteLength,
      ).toBeLessThanOrEqual(THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES);
    },
  );

  it("keeps a valid pending preview through empty updates and rejects superseded idle callbacks", () => {
    const original = makeUserRow("display-original", 1);
    schedule([original]);

    const noPreviewRows: ThreadTimelineResponse["rows"][] = [
      [],
      [
        {
          ...makeUserRow("pending", 2),
          turnRequest: {
            clientRequestId: null,
            isGrouped: false,
            kind: "message",
            status: "pending",
          },
        },
      ],
      [
        {
          ...commandRow({ id: "deferred", command: "inert" }),
          contentDeferred: true,
        },
      ],
      [
        {
          ...makeUserRow("oversized", 3),
          text: "x".repeat(THREAD_TIMELINE_DISPLAY_CACHE_MAX_THREAD_BYTES),
        },
      ],
    ];

    for (const rows of noPreviewRows) schedule(rows);
    expect(idleWrites).toHaveLength(1);
    expect(window.cancelIdleCallback).not.toHaveBeenCalled();
    idleWrites[0]?.();
    expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual([original]);

    schedule([makeUserRow("superseded", 4)]);
    const newest = makeUserRow("display-current", 5);
    schedule([newest]);
    expect(window.cancelIdleCallback).toHaveBeenCalledTimes(1);
    idleWrites[1]?.();
    expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual([original]);
    idleWrites[2]?.();
    expect(readPersistedThreadTimelineDisplay(scope)?.rows).toEqual([newest]);
  });
});

describe("useThreadTimelineController", () => {
  it("shows a sent message once from send until the server row replaces it", async () => {
    const earlier = makeUserRow("thread-1:user-seed:10", 10);

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const timeline = (rows: TimelineUserConversationRow[], maxSeq: number) =>
      makeTimelineResponse({
        rows,
        maxSeq,
        timelinePage: { historySnapshot: "sent-once" },
      });

    queryClient.setQueryData(TIMELINE_QUERY_KEY, timeline([earlier], 11));

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    expect(rowIds(result.current)).toEqual([earlier.id]);

    const pending: TimelineUserConversationRow = {
      ...makeUserRow("optimistic-user-a1", 0),
      turnRequest: {
        clientRequestId: "creq_5e3ueuruab",
        isGrouped: false,
        kind: "message",
        status: "pending",
      },
    };

    act(() => {
      addPendingSentMessage(queryClient, "thread-1", pending);
    });
    expect(rowIds(result.current)).toEqual([earlier.id, pending.id]);
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(TIMELINE_QUERY_KEY)
        ?.rows,
    ).toEqual([earlier]);

    const sent: TimelineUserConversationRow = {
      ...makeUserRow("thread-1:user-seed:12", 12),
      turnRequest: { ...pending.turnRequest, status: "accepted" },
    };

    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        timeline([earlier, sent], 12),
      );
    });
    await waitFor(() =>
      expect(rowIds(result.current)).toEqual([earlier.id, sent.id]),
    );

    const reply = makeUserRow("thread-1:user-seed:14", 14);

    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        timeline([earlier, sent, reply], 14),
      );
    });
    await waitFor(() =>
      expect(rowIds(result.current)).toEqual([earlier.id, sent.id, reply.id]),
    );
  });

  it("removes a pending message from the chat when its send fails", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ rows: [], maxSeq: 1 }),
    );

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    const pending = makeUserRow("optimistic-user-a1", 0);

    act(() => {
      addPendingSentMessage(queryClient, "thread-1", pending);
    });
    expect(rowIds(result.current)).toEqual([pending.id]);

    act(() => {
      removePendingSentMessage(queryClient, "thread-1", pending.id);
    });
    expect(rowIds(result.current)).toEqual([]);
  });

  it.each(["unmount", "disabled", "thread", "surface"] as const)(
    "cancels an older request when its controller is %s",
    async (change) => {
      const olderPage = createDeferredPromise<ThreadTimelineResponse>();
      vi.mocked(sdk.threads.timeline).mockImplementation(({ signal }) => {
        signal?.addEventListener("abort", () => {
          olderPage.reject(new DOMException("Aborted", "AbortError"));
        });

        return olderPage.promise;
      });

      const latest = makeTimelineResponse({
        rows: [newestLoadedRow],
        maxSeq: 1,
        timelinePage: {
          hasOlderRows: true,
          olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
        },
      });

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      queryClient.setQueryData(TIMELINE_QUERY_KEY, latest);
      queryClient.setQueryData(threadTimelineQueryKey("thread-2"), latest);

      const { result, rerender, unmount } = renderHook(
        (props) => useThreadTimelineController(props),
        {
          initialProps: {
            enabled: true,
            surfaceKey: "pane-1",
            threadId: "thread-1",
          },
          wrapper,
        },
      );

      let olderRequest: Promise<void> = Promise.resolve();
      act(() => {
        olderRequest = result.current.loadOlderTimelineRows();
      });
      await waitFor(() =>
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(1),
      );
      const signal = vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0].signal;

      if (change === "unmount") {
        unmount();
      } else {
        rerender({
          enabled: change !== "disabled",
          surfaceKey: change === "surface" ? "pane-2" : "pane-1",
          threadId: change === "thread" ? "thread-2" : "thread-1",
        });
      }

      expect(signal?.aborted).toBe(true);
      await act(async () => olderRequest);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);

      if (change !== "unmount") {
        expect(result.current.isLoadingOlderTimelineRows).toBe(false);
        expect(rowIds(result.current)).toEqual([newestLoadedRow.id]);
      }
    },
  );

  it.each(["pagehide", "visibilitychange"] as const)(
    "pauses an older auto-load on %s and resumes on the next upward scroll without losing its cursor",
    async (event) => {
      const { anchor, scrollUpNearTop } = installAutoLoadEnvironment();

      const olderPage = createDeferredPromise<ThreadTimelineResponse>();
      const visibility = vi.spyOn(document, "visibilityState", "get");
      visibility.mockReturnValue("visible");
      onTestFinished(() => visibility.mockRestore());
      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [newestLoadedRow],
            maxSeq: 1,
            timelinePage: {
              hasOlderRows: true,
              olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
            },
          }),
        )
        .mockImplementationOnce(({ signal }) => {
          signal?.addEventListener("abort", () => {
            olderPage.reject(new DOMException("Aborted", "AbortError"));
          });

          return olderPage.promise;
        })
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [olderPageRow],
            maxSeq: 1,
            timelinePage: { kind: "older" },
          }),
        );
      const { result } = renderControllerWithAutoLoad(anchor);
      await waitFor(() => {
        expect(result.current.timeline.hasOlderTimelineRows).toBe(true);
      });
      act(scrollUpNearTop);
      await waitFor(() =>
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(2),
      );
      const signal = vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0].signal;

      await act(async () => {
        if (event === "pagehide") {
          window.dispatchEvent(new Event("pagehide"));
        } else {
          visibility.mockReturnValue("hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });

      expect(signal?.aborted).toBe(true);
      expect(result.current.timeline.isLoadingOlderTimelineRows).toBe(false);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      expect(rowIds(result.current.timeline)).toEqual([newestLoadedRow.id]);

      act(() => {
        visibility.mockReturnValue("visible");

        if (event === "pagehide") {
          window.dispatchEvent(new Event("pageshow"));
        } else {
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      act(scrollUpNearTop);
      await waitFor(() => {
        expect(rowIds(result.current.timeline)).toEqual([
          olderPageRow.id,
          newestLoadedRow.id,
        ]);
      });
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
      expect(vi.mocked(sdk.threads.timeline).mock.calls[2]?.[0]).toMatchObject({
        beforeAnchorId: newestLoadedRow.id,
        beforeAnchorSeq: "1",
      });
    },
  );

  it("shares an older request between load calls before the loading state renders", async () => {
    const olderPage = createDeferredPromise<ThreadTimelineResponse>();

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({
        rows: [newestLoadedRow],
        maxSeq: 1,
        timelinePage: {
          hasOlderRows: true,
          olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
        },
      }),
    );
    vi.mocked(sdk.threads.timeline).mockReturnValue(olderPage.promise);

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.loadOlderTimelineRows();
      second = result.current.loadOlderTimelineRows();
    });

    expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    olderPage.resolve(
      makeTimelineResponse({
        rows: [olderPageRow],
        maxSeq: 1,
        timelinePage: { kind: "older" },
      }),
    );
    await act(async () => Promise.all([first, second]));
    expect(rowIds(result.current)).toEqual([
      olderPageRow.id,
      newestLoadedRow.id,
    ]);
  });

  it.each([8, 20])(
    "prewarms and loads older pages with the latest page's content mode and segment limit %i",
    async (segmentLimit) => {
      const { queryClient, wrapper } = createQueryClientTestHarness();

      const latest = makeTimelineResponse({
        rows: [newestLoadedRow],
        maxSeq: 1,
        timelinePage: {
          segmentLimit,
          hasOlderRows: true,
          olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
        },
      });

      const older = makeTimelineResponse({
        rows: [olderPageRow],
        maxSeq: 1,
        timelinePage: { kind: "older", segmentLimit },
      });

      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(latest)
        .mockResolvedValue(older);

      const { result } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.hasOlderTimelineRows).toBe(true);
      });

      await prewarmThreadOlderPage(
        queryClient,
        "thread-1",
        latest,
        new AbortController().signal,
      );
      await act(async () => result.current.loadOlderTimelineRows());

      const [latestRequest, ...olderRequests] = vi
        .mocked(sdk.threads.timeline)
        .mock.calls.map(([request]) => request);

      expect(olderRequests).toMatchObject([
        {
          beforeAnchorId: newestLoadedRow.id,
          beforeAnchorSeq: "1",
          deferContent: latestRequest?.deferContent,
          segmentLimit: String(segmentLimit),
          priority: "background",
        },
        {
          beforeAnchorId: newestLoadedRow.id,
          beforeAnchorSeq: "1",
          deferContent: latestRequest?.deferContent,
          segmentLimit: String(segmentLimit),
        },
      ]);
      expect(rowIds(result.current)).toEqual([
        olderPageRow.id,
        newestLoadedRow.id,
      ]);
    },
  );

  it("replaces loaded rows when realtime data starts a new context epoch", async () => {
    const oldRow = makeUserRow("thread-1:user-seed:1", 1);
    vi.mocked(sdk.threads.timeline).mockResolvedValue(
      makeTimelineResponse({ rows: [oldRow], maxSeq: 1 }),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([oldRow.id]);
    });

    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          contextBoundarySeq: 10,
          maxSeq: 10,
          rows: [contextClearRow],
        }),
      );
    });

    await waitFor(() => {
      expect(result.current.contextBoundarySeq).toBe(10);
      expect(rowIds(result.current)).toEqual([contextClearRow.id]);
    });
  });

  it.each([{ nested: false }, { nested: true }])(
    "keeps every visited page mounted in order without evicting history (nested=$nested)",
    async ({ nested }) => {
      const pages = 40;

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      const snapshot = JSON.stringify({
        version: 5,
        threadId: "thread-1",
        maxSeq: 200,
        status: "active",
        surface: "default",
        historyEpoch: "a".repeat(32),
      });

      const page = (sequence: number, older = true) => {
        const row = {
          ...makeUserRow(`history-row-${sequence}`, sequence),
          text: "α".repeat(256_000),
        };

        return makeTimelineResponse({
          rows: nested
            ? [
                turnRow({
                  id: "history-parent",
                  threadId: "thread-1",
                  seq: 1,
                  sourceSeqEnd: 200,
                  children: [row],
                }),
              ]
            : [row],
          maxSeq: 200,
          timelinePage: {
            kind: older ? "older" : "latest",
            historySnapshot: snapshot,
            hasOlderRows: sequence > 1,
            olderCursor:
              sequence > 1
                ? { anchorId: `cursor-${sequence}`, anchorSeq: sequence }
                : null,
          },
        });
      };

      queryClient.setQueryData(TIMELINE_QUERY_KEY, page(200, false));
      vi.mocked(sdk.threads.timeline).mockImplementation(async (args) =>
        page(Number(args.beforeAnchorSeq) - 1),
      );

      const { result } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      for (let index = 0; index < pages; index += 1)
        await act(async () => result.current.loadOlderTimelineRows());

      const leafIds = (rows: readonly TimelineRow[]): string[] =>
        rows.flatMap((row) =>
          row.kind === "turn" ? leafIds(row.children ?? []) : [row.id],
        );

      expect(leafIds(result.current.timelineRows)).toEqual(
        Array.from(
          { length: pages + 1 },
          (_, index) => `history-row-${200 - pages + index}`,
        ),
      );
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(pages);
    },
  );

  it.each([
    [
      "a context reset changes the surface",
      {
        contextBoundarySeq: 10,
        timelinePage: { historySnapshot: "snapshot-1" },
      },
      false,
    ],
    [
      "history is explicitly purged before the latest snapshot changes",
      { timelinePage: { historySnapshot: "snapshot-2" } },
      true,
    ],
  ])(
    "discards an in-flight older page when %s",
    async (_label, latestOverrides, purgeHistory) => {
      const { publishLatest, queryClient, result, settleOlderPage } =
        await renderControllerWithPendingOlderPage();

      if (purgeHistory) {
        act(() => purgeThreadOpenHistoryCache(queryClient, "thread-1"));
      }

      publishLatest(
        makeTimelineResponse({
          ...latestOverrides,
          maxSeq: 10,
          rows: [contextClearRow],
        }),
      );
      await waitFor(() => {
        expect(rowIds(result.current)).toEqual([contextClearRow.id]);
      });
      await settleOlderPage();

      expect(rowIds(result.current)).toEqual([contextClearRow.id]);
    },
  );

  it("replaces loaded older rows when the finished turn display changes", async () => {
    const olderRow = makeUserRow("thread-1:user-seed:1", 1);
    const latestRow = makeUserRow("thread-1:user-seed:10", 10);
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          completedTurnDisplay: "flat",
          rows: [latestRow],
          maxSeq: 10,
          timelinePage: {
            historySnapshot: "snapshot-flat",
            hasOlderRows: true,
            olderCursor: { anchorId: "cursor-10", anchorSeq: 10 },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeTimelineResponse({
          completedTurnDisplay: "flat",
          rows: [olderRow],
          maxSeq: 10,
          timelinePage: { kind: "older", historySnapshot: "snapshot-flat" },
        }),
      );

    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.hasOlderTimelineRows).toBe(true);
    });
    await act(async () => {
      await result.current.loadOlderTimelineRows();
    });
    expect(rowIds(result.current)).toEqual([olderRow.id, latestRow.id]);

    act(() => {
      purgeThreadOpenHistoryCache(queryClient, "thread-1");
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          completedTurnDisplay: "collapse",
          rows: [latestRow],
          maxSeq: 10,
          timelinePage: {
            historySnapshot: "snapshot-collapse",
            olderRowsSourceSeqEnd: 1,
            hasOlderRows: true,
            olderCursor: { anchorId: "cursor-10-collapse", anchorSeq: 10 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([latestRow.id]);
    });
    expect(result.current.hasOlderTimelineRows).toBe(true);
  });

  it("keeps eight small mounted pages across a contiguous live append", async () => {
    const latestRow = makeUserRow("mounted-page-8", 8);

    const olderPages = [7, 6, 5, 4, 3, 2, 1].map((sequence) =>
      makeTimelineResponse({
        rows: [makeUserRow(`mounted-page-${sequence}`, sequence)],
        maxSeq: 8,
        timelinePage: {
          kind: "older",
          historySnapshot: "mounted-pages-before",
          hasOlderRows: sequence > 1,
          olderCursor:
            sequence > 1
              ? { anchorId: `mounted-page-${sequence}`, anchorSeq: sequence }
              : null,
        },
      }),
    );

    expect(
      new TextEncoder().encode(JSON.stringify(olderPages)).byteLength,
    ).toBeLessThan(64 * 1024);

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({
        rows: [latestRow],
        maxSeq: 8,
        timelinePage: {
          historySnapshot: "mounted-pages-before",
          hasOlderRows: true,
          olderCursor: { anchorId: latestRow.id, anchorSeq: 8 },
        },
      }),
    );

    for (const page of olderPages)
      vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(page);

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    for (const _page of olderPages)
      await act(async () => result.current.loadOlderTimelineRows());

    const expectedRows = Array.from(
      { length: 8 },
      (_, index) => `mounted-page-${index + 1}`,
    );

    expect(rowIds(result.current)).toEqual(expectedRows);

    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          rows: [makeUserRow("mounted-page-9", 9)],
          maxSeq: 9,
          timelinePage: {
            historySnapshot: "mounted-pages-after",
            hasOlderRows: true,
            olderCursor: { anchorId: "mounted-page-9", anchorSeq: 9 },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([
        ...expectedRows,
        "mounted-page-9",
      ]);
    });
    expect(result.current.hasOlderTimelineRows).toBe(false);
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(olderPages.length);
  });

  it.each([false, true])(
    "keeps loaded and in-flight older payload only within one v5 history epoch (changed=%s)",
    async (changedEpoch) => {
      const olderRow = makeUserRow("epoch-loaded-older", 1);
      const delayedRow = makeUserRow("epoch-delayed-older", 0);
      const latestRow = makeUserRow("epoch-latest", 10);
      const streamingRow = makeUserRow("epoch-streaming", 11);
      const olderPage = createDeferredPromise<ThreadTimelineResponse>();

      const snapshot = (epoch: string, maxSeq: number) =>
        JSON.stringify({
          version: 5,
          threadId: "thread-1",
          maxSeq,
          status: "active",
          surface: "default",
          historyEpoch: epoch.repeat(32),
        });

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          rows: [latestRow],
          maxSeq: 10,
          timelinePage: {
            historySnapshot: snapshot("a", 10),
            hasOlderRows: true,
            olderCursor: { anchorId: "epoch-cursor-10", anchorSeq: 10 },
          },
        }),
      );
      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [olderRow],
            maxSeq: 10,
            timelinePage: {
              kind: "older",
              historySnapshot: snapshot("a", 10),
              hasOlderRows: true,
              olderCursor: { anchorId: "epoch-cursor-1", anchorSeq: 1 },
            },
          }),
        )
        .mockReturnValueOnce(olderPage.promise);

      const { result } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await act(async () => result.current.loadOlderTimelineRows());
      expect(rowIds(result.current)).toEqual([olderRow.id, latestRow.id]);
      let olderRequest: Promise<void> = Promise.resolve();
      act(() => {
        olderRequest = result.current.loadOlderTimelineRows();
      });
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);

      act(() => {
        queryClient.setQueryData(
          TIMELINE_QUERY_KEY,
          makeTimelineResponse({
            rows: [latestRow, streamingRow],
            maxSeq: 11,
            timelinePage: {
              historySnapshot: snapshot(changedEpoch ? "b" : "a", 11),
              olderRowsSourceSeqEnd: null,
              hasOlderRows: true,
              olderCursor: { anchorId: "epoch-cursor-11", anchorSeq: 10 },
            },
          }),
        );
      });
      await waitFor(() => {
        expect(rowIds(result.current)).toContain(streamingRow.id);
      });
      const rowsAfterAppend = rowIds(result.current);

      olderPage.resolve(
        makeTimelineResponse({
          rows: [delayedRow],
          maxSeq: 10,
          timelinePage: { kind: "older", historySnapshot: snapshot("a", 10) },
        }),
      );
      await act(async () => olderRequest);

      expect(rowIds(result.current)).toEqual(
        changedEpoch
          ? [latestRow.id, streamingRow.id]
          : [delayedRow.id, olderRow.id, latestRow.id, streamingRow.id],
      );
      expect(rowsAfterAppend).toEqual(
        changedEpoch
          ? [latestRow.id, streamingRow.id]
          : [olderRow.id, latestRow.id, streamingRow.id],
      );
      expect(result.current.isLoadingOlderTimelineRows).toBe(false);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    "a noncontiguous latest window",
    "an obsolete older-row source boundary",
    "a changed common-row order",
    "a head larger than the inactive return budget",
  ] as const)(
    "reconciles same-epoch loaded and pending older pages through %s, restarting contiguous history when the newest page no longer connects",
    async (reset) => {
      const olderRow = makeUserRow("reset-loaded-older", 1);
      const delayedRow = makeUserRow("reset-delayed-older", 0);
      const firstHead = makeUserRow("reset-first-head", 10);
      const secondHead = makeUserRow("reset-second-head", 20);

      const nextSequence =
        reset === "a noncontiguous latest window" ? 2000 : 21;

      const newRow = {
        ...makeUserRow("reset-new-row", nextSequence),
        text:
          reset === "a head larger than the inactive return budget"
            ? "A large preserved message. ".repeat(24_000)
            : "New saved content",
      };

      const latestRows =
        reset === "a noncontiguous latest window"
          ? [newRow]
          : reset === "a changed common-row order"
            ? [secondHead, firstHead, newRow]
            : [firstHead, secondHead, newRow];

      const snapshot = (maxSeq: number) =>
        JSON.stringify({
          version: 5,
          threadId: "thread-1",
          maxSeq,
          status: "active",
          surface: "default",
          historyEpoch: "a".repeat(32),
        });

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          rows: [firstHead, secondHead],
          maxSeq: 20,
          timelinePage: {
            historySnapshot: snapshot(20),
            hasOlderRows: true,
            olderCursor: { anchorId: "reset-head-cursor", anchorSeq: 10 },
          },
        }),
      );
      const olderPage = createDeferredPromise<ThreadTimelineResponse>();
      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [olderRow],
            maxSeq: 20,
            timelinePage: {
              kind: "older",
              historySnapshot: snapshot(20),
              hasOlderRows: true,
              olderCursor: { anchorId: "reset-older-cursor", anchorSeq: 1 },
            },
          }),
        )
        .mockReturnValueOnce(olderPage.promise);

      const { result } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await act(async () => result.current.loadOlderTimelineRows());
      expect(rowIds(result.current)).toEqual([
        olderRow.id,
        firstHead.id,
        secondHead.id,
      ]);
      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = result.current.loadOlderTimelineRows();
      });
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      act(() => {
        queryClient.setQueryData(
          TIMELINE_QUERY_KEY,
          makeTimelineResponse({
            rows: latestRows,
            maxSeq: nextSequence,
            timelinePage: {
              historySnapshot: snapshot(nextSequence),
              olderRowsSourceSeqEnd:
                reset === "an obsolete older-row source boundary" ? 21 : null,
              olderRowUpdates: [],
              hasOlderRows: true,
              olderCursor: {
                anchorId: "reset-new-head-cursor",
                anchorSeq:
                  reset === "a noncontiguous latest window" ? 2000 : 10,
              },
            },
          }),
        );
      });
      await waitFor(() => expect(rowIds(result.current)).toContain(newRow.id));
      const retainedBeforeSettling = rowIds(result.current);
      olderPage.resolve(
        makeTimelineResponse({
          rows: [delayedRow],
          maxSeq: 20,
          timelinePage: { kind: "older", historySnapshot: snapshot(20) },
        }),
      );
      await act(async () => pending);

      if (reset === "a noncontiguous latest window") {
        expect(retainedBeforeSettling).toEqual([newRow.id]);
        expect(rowIds(result.current)).toEqual([newRow.id]);
        expect(result.current.hasOlderTimelineRows).toBe(true);

        return;
      }

      expect(retainedBeforeSettling).toContain(olderRow.id);
      expect(rowIds(result.current)).toContain(olderRow.id);
      expect(rowIds(result.current)).toContain(delayedRow.id);

      const expectedHeadOrder = latestRows.map((row) => row.id);

      expect(
        rowIds(result.current).filter((id) => expectedHeadOrder.includes(id)),
      ).toEqual(expectedHeadOrder);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps older rows and applies an in-flight older page while realtime refreshes advance the snapshot", async () => {
    const olderRow = makeUserRow("thread-1:user-seed:1", 1);
    const latestRow = makeUserRow("thread-1:user-seed:10", 10);
    const streamingRow = makeUserRow("thread-1:user-seed:11", 11);
    let resolveOlder: (value: ThreadTimelineResponse) => void = () => {};

    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [latestRow],
          maxSeq: 10,
          timelinePage: {
            historySnapshot: "snapshot-10",
            hasOlderRows: true,
            olderCursor: { anchorId: "cursor-10", anchorSeq: 10 },
          },
        }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<ThreadTimelineResponse>((resolve) => {
            resolveOlder = resolve;
          }),
      );

    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.hasOlderTimelineRows).toBe(true);
    });

    let olderRequest: Promise<void> = Promise.resolve();
    act(() => {
      olderRequest = result.current.loadOlderTimelineRows();
    });
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    act(() => {
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeTimelineResponse({
          rows: [latestRow, streamingRow],
          maxSeq: 11,
          timelinePage: {
            historySnapshot: "snapshot-11",
            olderRowsSourceSeqEnd: null,
            hasOlderRows: true,
            olderCursor: { anchorId: "cursor-11", anchorSeq: 10 },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        latestRow.id,
        streamingRow.id,
      ]);
    });

    resolveOlder(
      makeTimelineResponse({
        rows: [olderRow],
        maxSeq: 10,
        timelinePage: { kind: "older", historySnapshot: "snapshot-10" },
      }),
    );
    await act(async () => {
      await olderRequest;
    });

    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      olderRow.id,
      latestRow.id,
      streamingRow.id,
    ]);
    expect(result.current.hasOlderTimelineRows).toBe(false);

    act(() => {
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        makeTimelineResponse({
          rows: [latestRow, { ...streamingRow, sourceSeqEnd: 12 }],
          maxSeq: 12,
          timelinePage: {
            historySnapshot: "snapshot-12",
            olderRowsSourceSeqEnd: null,
            hasOlderRows: true,
            olderCursor: { anchorId: "cursor-12", anchorSeq: 10 },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.timelineRows[2]?.sourceSeqEnd).toBe(12);
    });
    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      olderRow.id,
      latestRow.id,
      streamingRow.id,
    ]);
  });

  it("keeps an initial timeline refetch in loading state instead of showing the previous error", async () => {
    const refetch = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockRejectedValueOnce(makeServerError())
      .mockReturnValueOnce(refetch.promise);

    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.timelineError).toBeInstanceOf(OmnyoHttpError);
    });

    startTimelineRefetch(queryClient);

    await waitFor(() => {
      expect(result.current.timelineLoading).toBe(true);
    });
    expect(result.current.timelineError).toBeNull();

    refetch.resolve(makeTimelineResponse());

    await waitFor(() => {
      expect(result.current.timelineLoading).toBe(false);
      expect(result.current.timelineError).toBeNull();
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
  });

  it.for(["populated", "empty"] as const)(
    "uses a current RAM timeline without foreground display writes with %s storage",
    async (storageState, { task }) => {
      const idleWrites: Array<() => void> = [];
      vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
        idleWrites.push(() =>
          callback({ didTimeout: true, timeRemaining: () => 0 }),
        );

        return idleWrites.length;
      });
      vi.stubGlobal("cancelIdleCallback", vi.fn());

      const rows = Array.from({ length: 96 }, (_, index) => ({
        ...makeUserRow(`ram-row-${index}`, index + 1),
        text: "A retained Unicode α🦊漢 preview. ".repeat(20),
      }));

      const response = makeTimelineResponse({
        rows,
        maxSeq: rows.length,
        timelinePage: { historySnapshot: "ram-display-snapshot" },
      });

      vi.mocked(sdk.threads.timeline).mockResolvedValue(response);

      const harness = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      const mount = () =>
        renderHook(
          () => useThreadTimelineController({ threadId: "thread-1" }),
          { wrapper: harness.wrapper },
        );

      const first = mount();
      await waitFor(() => {
        expect(rowIds(first.result.current)).toEqual(rows.map((row) => row.id));
        expect(idleWrites.length).toBeGreaterThan(0);
      });
      first.unmount();

      for (const callback of idleWrites.splice(0)) callback();

      if (storageState === "empty") clearPersistedThreadTimelineDisplays();
      else {
        for (let index = 0; index < 8; index += 1)
          schedulePersistedThreadTimelineDisplay({
            origin: window.location.origin,
            runtimeId: "runtime-test-1",
            threadId: `other-${index}`,
            surfaceKey: `other-${index}`,
            response,
          });

        for (const callback of idleWrites.splice(0)) callback();

        expect(
          readPersistedThreadTimelineDisplay({
            origin: window.location.origin,
            runtimeId: "runtime-test-1",
            threadId: "thread-1",
          })?.rows,
        ).toEqual(rows);
      }

      const key = "omnyo.threadTimelineDisplay.v1";
      const storedCharacters = localStorage.getItem(key)?.length ?? 0;
      const reads = vi.spyOn(Storage.prototype, "getItem");
      const writes = vi.spyOn(Storage.prototype, "setItem");
      onTestFinished(() => {
        reads.mockRestore();
        writes.mockRestore();
      });
      const started = performance.now();
      const second = mount();
      await waitFor(() => {
        expect(sdk.server.runtimeIdentity).toHaveBeenCalledTimes(2);
        expect(
          harness.queryClient.getQueryState(threadOpenRuntimeIdentityQueryKey())
            ?.fetchStatus,
        ).toBe("idle");
      });
      second.rerender();
      await waitFor(() => {
        expect(idleWrites.length).toBeGreaterThan(0);
        expect(rowIds(second.result.current)).toEqual(
          rows.map((row) => row.id),
        );
      });

      const foregroundWrites = writes.mock.calls.filter(
        ([name]) => name === key,
      );

      const measurement = {
        storageState,
        storedCharacters,
        reads: reads.mock.calls.filter(([name]) => name === key).length,
        writes: foregroundWrites.length,
        writtenCharacters: foregroundWrites.reduce(
          (total, [, value]) => total + value.length,
          0,
        ),
        mountMs: performance.now() - started,
      };

      Object.assign(task.meta, { ramDisplayStorage: measurement });
      expect(foregroundWrites, JSON.stringify(measurement)).toHaveLength(0);

      for (const callback of idleWrites.splice(0)) callback();

      expect(
        readPersistedThreadTimelineDisplay({
          origin: window.location.origin,
          runtimeId: "runtime-test-1",
          threadId: "thread-1",
        })?.rows,
      ).toEqual(rows);
      second.unmount();
      harness.queryClient.clear();
    },
  );

  it("shows scoped persisted display rows during a failed first live read without treating them as authoritative, including after a server restart", async () => {
    const persistedRow = makeUserRow("persisted-user-row", 1);

    const pendingRow = {
      ...makeUserRow("pending-user-row", 2),
      turnRequest: {
        clientRequestId: null,
        isGrouped: false,
        kind: "message" as const,
        status: "pending" as const,
      },
    };

    const completeTimeline = makeTimelineResponse({
      rows: [persistedRow, pendingRow],
      maxSeq: 2,
      revision: "rev-2",
      timelinePage: {
        historySnapshot: "snapshot-1",
        hasOlderRows: false,
        olderCursor: null,
      },
    });

    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(completeTimeline);
    vi.stubGlobal(
      "requestIdleCallback",
      (
        callback: (deadline: {
          didTimeout: boolean;
          timeRemaining: () => number;
        }) => void,
      ) =>
        window.setTimeout(
          () => callback({ didTimeout: true, timeRemaining: () => 0 }),
          0,
        ),
    );
    vi.stubGlobal("cancelIdleCallback", (id: number) =>
      window.clearTimeout(id),
    );

    const firstHarness = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const firstView = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper: firstHarness.wrapper },
    );

    await waitFor(() => {
      expect(rowIds(firstView.result.current)).toContain(persistedRow.id);
    });
    firstView.unmount();
    await act(
      async () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
    );

    const delayedLiveRead = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(
      delayedLiveRead.promise,
    );

    const secondHarness = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const secondView = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper: secondHarness.wrapper },
    );

    await waitFor(() => {
      expect(rowIds(secondView.result.current)).toEqual([]);
      expect(secondView.result.current.timelineLoading).toBe(true);
    });
    expect(rowIds(secondView.result.current)).not.toContain(pendingRow.id);
    expect(
      secondHarness.queryClient.getQueryData(TIMELINE_QUERY_KEY),
    ).toBeUndefined();

    const firstLiveRead = vi
      .mocked(sdk.threads.timeline)
      .mock.calls.at(-1)?.[0];

    expect(firstLiveRead).toMatchObject({
      deltaFormat: "assistant-text-append-v1",
      threadId: "thread-1",
    });
    expect(firstLiveRead).not.toHaveProperty("afterSequence");
    expect(firstLiveRead).not.toHaveProperty("afterRevision");

    await act(async () => {
      delayedLiveRead.reject(makeServerError());
      await delayedLiveRead.promise.catch(() => undefined);
    });
    await waitFor(() => {
      expect(secondView.result.current.timelineError).toBeInstanceOf(
        OmnyoHttpError,
      );
    });
    expect(rowIds(secondView.result.current)).toContain(persistedRow.id);
    expect(
      secondHarness.queryClient.getQueryData(TIMELINE_QUERY_KEY),
    ).toBeUndefined();
    secondView.unmount();

    vi.mocked(sdk.server.runtimeIdentity).mockResolvedValueOnce({
      runtimeId: "runtime-test-2",
    });
    vi.mocked(sdk.threads.timeline).mockRejectedValueOnce(makeServerError());

    const restartedHarness = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const restartedView = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper: restartedHarness.wrapper },
    );

    await waitFor(() => {
      expect(restartedView.result.current.timelineError).toBeInstanceOf(
        OmnyoHttpError,
      );
    });
    expect(rowIds(restartedView.result.current)).toContain(persistedRow.id);
    expect(rowIds(restartedView.result.current)).not.toContain(pendingRow.id);
    expect(
      restartedHarness.queryClient.getQueryData(TIMELINE_QUERY_KEY),
    ).toBeUndefined();
    restartedView.unmount();
  });

  it("clears old runtime display and waits for a full current-runtime read before persistence", async () => {
    clearPersistedThreadTimelineDisplays();
    onTestFinished(() => clearPersistedThreadTimelineDisplays());

    const oldRuntimeRow = systemRow({
      id: "old-runtime-row",
      seq: 1,
      title: "Old runtime row",
      detail: null,
    });

    const newRuntimeRow = systemRow({
      id: "new-runtime-row",
      seq: 1,
      title: "New runtime row",
      detail: null,
    });

    const pendingIdleWrites: Array<() => void> = [];
    vi.stubGlobal(
      "requestIdleCallback",
      (
        callback: (deadline: {
          didTimeout: boolean;
          timeRemaining: () => number;
        }) => void,
      ) => {
        pendingIdleWrites.push(() =>
          callback({ didTimeout: true, timeRemaining: () => 0 }),
        );

        return pendingIdleWrites.length;
      },
    );
    vi.stubGlobal("cancelIdleCallback", vi.fn());

    const currentRuntimeRead = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          activeThinking: {
            id: "old-runtime-thinking",
            startedAt: 1,
            updatedAt: 1,
            text: "Old runtime work",
          },
          maxSeq: 1,
          revision: "old-runtime-revision",
          rows: [oldRuntimeRow],
          timelinePage: {
            historySnapshot: "old-runtime-snapshot",
            hasOlderRows: false,
            olderCursor: null,
          },
        }),
      )
      .mockReturnValueOnce(currentRuntimeRead.promise);

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const { result, unmount } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([oldRuntimeRow.id]);
      expect(result.current.activeThinking?.id).toBe("old-runtime-thinking");
      expect(pendingIdleWrites).toHaveLength(1);
    });

    vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue({
      runtimeId: "runtime-test-2",
    });
    await queryClient.refetchQueries({
      exact: true,
      queryKey: threadOpenRuntimeIdentityQueryKey(),
    });

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      expect(rowIds(result.current)).toEqual([]);
      expect(result.current.activeThinking).toBeNull();
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0]).toMatchObject({
      deltaFormat: "assistant-text-append-v1",
      threadId: "thread-1",
    });
    expect(
      vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0],
    ).not.toHaveProperty("afterSequence");
    expect(
      vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0],
    ).not.toHaveProperty("afterRevision");

    pendingIdleWrites[0]?.();
    expect(
      readPersistedThreadTimelineDisplay({
        origin: window.location.origin,
        runtimeId: "runtime-test-2",
        threadId: "thread-1",
      }),
    ).toBeNull();

    await act(async () => {
      currentRuntimeRead.resolve(
        makeTimelineResponse({
          maxSeq: 1,
          revision: "new-runtime-revision",
          runtimeId: "runtime-test-2",
          rows: [newRuntimeRow],
          timelinePage: {
            historySnapshot: "new-runtime-snapshot",
            hasOlderRows: false,
            olderCursor: null,
          },
        }),
      );
      await currentRuntimeRead.promise;
    });
    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([newRuntimeRow.id]);
      expect(pendingIdleWrites).toHaveLength(2);
    });

    pendingIdleWrites[0]?.();
    pendingIdleWrites[1]?.();
    expect(
      readPersistedThreadTimelineDisplay({
        origin: window.location.origin,
        runtimeId: "runtime-test-2",
        threadId: "thread-1",
      })?.rows.map((row) => row.id),
    ).toEqual([newRuntimeRow.id]);

    unmount();
  });

  describe("opening with a display snapshot from an earlier runtime", () => {
    const origin = window.location.origin;
    const snapshotRow = makeUserRow("snapshot-row", 1);
    const liveRow = makeUserRow("live-row", 2);
    const idleWrites: Array<() => void> = [];

    function flushIdleWrites() {
      for (const write of idleWrites.splice(0)) write();
    }

    function persistEarlierRuntimeDisplay() {
      const scope = { origin, runtimeId: "runtime-old", threadId: "thread-1" };
      readPersistedThreadTimelineDisplay(scope);
      schedulePersistedThreadTimelineDisplay({
        ...scope,
        surfaceKey: "thread-1",
        response: makeTimelineResponse({
          runtimeId: "runtime-old",
          rows: [snapshotRow],
          maxSeq: 1,
          timelinePage: { historySnapshot: "snapshot-old-runtime" },
        }),
      });
      flushIdleWrites();
    }

    beforeEach(() => {
      idleWrites.length = 0;
      vi.stubGlobal("requestIdleCallback", (callback: IdleRequestCallback) => {
        idleWrites.push(() =>
          callback({ didTimeout: true, timeRemaining: () => 0 }),
        );

        return idleWrites.length;
      });
      vi.stubGlobal("cancelIdleCallback", vi.fn());
      persistEarlierRuntimeDisplay();
    });

    it("waits for one live snapshot before showing cached history", async () => {
      const identity = createDeferredPromise<ServerRuntimeIdentity>();
      const liveRead = createDeferredPromise<ThreadTimelineResponse>();
      vi.mocked(sdk.server.runtimeIdentity).mockReturnValue(identity.promise);
      vi.mocked(sdk.threads.timeline).mockReturnValueOnce(liveRead.promise);

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      const { result, unmount } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      expect(rowIds(result.current)).toEqual([]);
      expect(result.current.isReadOnlyDisplay).toBe(true);
      expect(result.current.timelineLoading).toBe(true);
      expect(queryClient.getQueryData(TIMELINE_QUERY_KEY)).toBeUndefined();

      await act(async () => {
        identity.resolve({ runtimeId: "runtime-test-2" });
        await identity.promise;
      });
      await waitFor(() => {
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
      });
      expect(rowIds(result.current)).toEqual([]);
      expect(result.current.isReadOnlyDisplay).toBe(true);
      expect(queryClient.getQueryData(TIMELINE_QUERY_KEY)).toBeUndefined();

      const liveReadArgs = vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0];
      expect(liveReadArgs).not.toHaveProperty("afterSequence");
      expect(liveReadArgs).not.toHaveProperty("afterRuntimeId");
      expect(liveReadArgs).not.toHaveProperty("afterRevision");

      await act(async () => {
        liveRead.resolve(
          makeTimelineResponse({
            runtimeId: "runtime-test-2",
            rows: [snapshotRow, liveRow],
            maxSeq: 2,
            timelinePage: {
              historySnapshot: "snapshot-new-runtime",
              hasOlderRows: false,
              olderCursor: null,
            },
          }),
        );
        await liveRead.promise;
      });
      await waitFor(() => {
        expect(rowIds(result.current)).toEqual([snapshotRow.id, liveRow.id]);
        expect(result.current.isReadOnlyDisplay).toBe(false);
        expect(result.current.timelineLoading).toBe(false);
      });

      flushIdleWrites();
      expect(
        readPersistedThreadTimelineDisplay({
          origin,
          runtimeId: "runtime-test-2",
          threadId: "thread-1",
        })?.rows.map((row) => row.id),
      ).toEqual([snapshotRow.id, liveRow.id]);
      unmount();
    });

    it("keeps the read-only snapshot with the failure indication when the server cannot be read", async () => {
      vi.mocked(sdk.server.runtimeIdentity).mockRejectedValue(
        makeServerError(),
      );
      vi.mocked(sdk.threads.timeline).mockRejectedValue(makeServerError());

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      const { result, unmount } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.timelineError).toBeInstanceOf(OmnyoHttpError);
      });
      expect(rowIds(result.current)).toEqual([snapshotRow.id]);
      expect(result.current.isReadOnlyDisplay).toBe(true);
      expect(result.current.timelineLoading).toBe(false);
      expect(queryClient.getQueryData(TIMELINE_QUERY_KEY)).toBeUndefined();
      unmount();
    });

    it("keeps the stored snapshot when this thread's cached timeline belongs to the previous runtime", async () => {
      const liveRead = createDeferredPromise<ThreadTimelineResponse>();
      vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue({
        runtimeId: "runtime-test-2",
      });
      vi.mocked(sdk.threads.timeline).mockReturnValue(liveRead.promise);

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      rememberThreadOpenRuntimeId(queryClient, "runtime-test-2");
      rememberThreadTimelineRuntimeId(queryClient, "thread-1", "runtime-old");

      const { result, unmount } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(sdk.threads.timeline).toHaveBeenCalled();
        expect(
          queryClient.getQueryState(threadOpenRuntimeIdentityQueryKey())
            ?.fetchStatus,
        ).toBe("idle");
      });
      expect(rowIds(result.current)).toEqual([]);
      expect(result.current.isReadOnlyDisplay).toBe(true);
      expect(
        readPersistedThreadTimelineDisplay({
          origin,
          runtimeId: "runtime-test-2",
          threadId: "thread-1",
        })?.rows.map((row) => row.id),
      ).toEqual([snapshotRow.id]);
      unmount();
    });

    it("drops the snapshot once the thread is confirmed deleted", async () => {
      vi.mocked(sdk.threads.timeline).mockRejectedValue(
        new OmnyoHttpError({
          body: null,
          code: null,
          message: "Not found",
          status: 404,
        }),
      );

      const { wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      const { result, unmount } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      expect(rowIds(result.current)).toEqual([]);
      await waitFor(() => {
        expect(result.current.threadNotFound).toBe(true);
      });
      expect(rowIds(result.current)).toEqual([]);
      expect(result.current.isReadOnlyDisplay).toBe(false);
      expect(
        peekPersistedThreadTimelineDisplay({ origin, threadId: "thread-1" }),
      ).toBeNull();
      unmount();
    });
  });

  it("does not let a delayed persistence write restore a deleted thread", async () => {
    type PendingDisplayWrite = { run: (() => void) | null };

    const idleWrite: PendingDisplayWrite = { run: null };
    vi.stubGlobal("cancelIdleCallback", vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      (
        callback: (deadline: {
          didTimeout: boolean;
          timeRemaining: () => number;
        }) => void,
      ) => {
        idleWrite.run = () =>
          callback({ didTimeout: true, timeRemaining: () => 0 });

        return 1;
      },
    );
    const completedRow = makeUserRow("deleted-thread-row", 1);
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeTimelineResponse({
        rows: [completedRow],
        maxSeq: 1,
        timelinePage: {
          historySnapshot: "snapshot-delete",
          hasOlderRows: false,
          olderCursor: null,
        },
      }),
    );

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { staleTime: Infinity },
    });

    const firstView = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(rowIds(firstView.result.current)).toContain(completedRow.id);
      expect(idleWrite.run).not.toBeNull();
    });
    firstView.unmount();

    removeThreadScopedQueries({ queryClient, threadId: "thread-1" });
    idleWrite.run?.();
    vi.mocked(sdk.threads.timeline).mockRejectedValueOnce(makeServerError());

    const reopened = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(reopened.result.current.timelineError).toBeInstanceOf(
        OmnyoHttpError,
      );
    });
    expect(rowIds(reopened.result.current)).not.toContain(completedRow.id);
    expect(queryClient.getQueryData(TIMELINE_QUERY_KEY)).toBeUndefined();
    reopened.unmount();
  });

  it.each(["mounted", "prefetched offscreen"] as const)(
    "restores visited older pages after an A-to-B-to-A switch with a %s append",
    async (arrival) => {
      const latestA = makeTimelineResponse({
        rows: [makeUserRow("page-row-5", 5)],
        maxSeq: 5,
        timelinePage: {
          historySnapshot: "snapshot-a",
          hasOlderRows: true,
          olderCursor: { anchorId: "page-row-5", anchorSeq: 5 },
        },
      });

      const latestB = makeTimelineResponse({
        rows: [makeUserRow("thread-b-row", 1)],
        maxSeq: 1,
        timelinePage: {
          historySnapshot: "snapshot-b",
          hasOlderRows: false,
          olderCursor: null,
        },
      });

      const retainedPageText = "x".repeat(120 * 1024);

      const olderPages = [4, 3, 2, 1, 0].map((sequence) => ({
        rows: [
          {
            ...makeUserRow(`page-row-${sequence}`, sequence),
            text: retainedPageText,
          },
        ],
        maxSeq: 5,
        timelinePage: {
          kind: "older" as const,
          historySnapshot: "snapshot-a",
          hasOlderRows: sequence > 0,
          olderCursor:
            sequence > 0
              ? { anchorId: `page-row-${sequence}`, anchorSeq: sequence }
              : null,
        },
      }));

      const { queryClient } = createQueryClientTestHarness({
        queries: { refetchOnMount: false, staleTime: Infinity },
      });

      const store = createStore();

      const wrapper = ({ children }: { children: ReactNode }) => (
        <JotaiProvider store={store}>
          <QueryClientProvider client={queryClient}>
            {children}
          </QueryClientProvider>
        </JotaiProvider>
      );

      queryClient.setQueryData(threadTimelineQueryKey("thread-1"), latestA);
      queryClient.setQueryData(threadTimelineQueryKey("thread-2"), latestB);

      for (const page of olderPages) {
        vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
          makeTimelineResponse(page),
        );
      }

      const firstA = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      for (let page = 0; page < olderPages.length; page += 1) {
        await act(async () => {
          await firstA.result.current.loadOlderTimelineRows();
        });
      }

      const expectedRows = [
        "page-row-0",
        "page-row-1",
        "page-row-2",
        "page-row-3",
        "page-row-4",
        "page-row-5",
      ];

      expect(rowIds(firstA.result.current)).toEqual(expectedRows);

      const appendedLatest = makeTimelineResponse({
        rows: [makeUserRow("page-row-6", 6)],
        maxSeq: 6,
        timelinePage: {
          historySnapshot: "snapshot-a-after-append",
          hasOlderRows: true,
          olderCursor: { anchorId: "page-row-6", anchorSeq: 6 },
        },
      });

      const expectedUpdatedRows = [
        "page-row-1",
        "page-row-2",
        "page-row-3",
        "page-row-4",
        "page-row-5",
        "page-row-6",
      ];

      if (arrival === "mounted") {
        act(() => {
          queryClient.setQueryData(
            threadTimelineQueryKey("thread-1"),
            appendedLatest,
          );
        });
        await waitFor(() => {
          expect(rowIds(firstA.result.current)).toEqual([
            ...expectedRows,
            "page-row-6",
          ]);
        });
      }

      firstA.unmount();

      const threadB = renderHook(
        () => useThreadTimelineController({ threadId: "thread-2" }),
        { wrapper },
      );

      if (arrival === "prefetched offscreen") {
        await act(async () => {
          await queryClient.prefetchQuery({
            queryKey: threadTimelineQueryKey("thread-1"),
            queryFn: async () => appendedLatest,
            staleTime: 0,
          });
        });
        expect(
          queryClient.getQueryData<ThreadTimelineResponse>(TIMELINE_QUERY_KEY)
            ?.maxSeq,
        ).toBe(6);
      }

      threadB.unmount();

      const returnedA = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      expect(rowIds(returnedA.result.current)).toEqual(expectedUpdatedRows);
      expect(returnedA.result.current.hasOlderTimelineRows).toBe(true);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(5);
      returnedA.unmount();

      const returnedAgainA = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      expect(rowIds(returnedAgainA.result.current)).toEqual(
        expectedUpdatedRows,
      );
      expect(returnedAgainA.result.current.hasOlderTimelineRows).toBe(true);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(5);
      vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
        makeTimelineResponse(olderPages[4]!),
      );
      await act(async () =>
        returnedAgainA.result.current.loadOlderTimelineRows(),
      );
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(6);
      expect(vi.mocked(sdk.threads.timeline).mock.calls[5]?.[0]).toMatchObject({
        beforeAnchorId: "page-row-1",
        beforeAnchorSeq: "1",
      });
      returnedAgainA.unmount();
    },
  );

  it.each(["unchanged", "offscreen append", "offscreen gap"] as const)(
    "reconciles visited history and its cursor after %s",
    async (arrival) => {
      const latest = makeTimelineResponse({
        rows: [makeUserRow("null-cursor-latest", 2)],
        maxSeq: 2,
        timelinePage: {
          historySnapshot: "null-cursor-snapshot",
          hasOlderRows: true,
          olderCursor: { anchorId: "null-cursor-latest", anchorSeq: 2 },
        },
      });

      vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [makeUserRow("null-cursor-older", 1)],
          maxSeq: 2,
          timelinePage: {
            kind: "older",
            historySnapshot: "null-cursor-snapshot",
            olderCursor: null,
          },
        }),
      );

      const { queryClient, wrapper } = createQueryClientTestHarness({
        queries: { staleTime: Infinity },
      });

      queryClient.setQueryData(TIMELINE_QUERY_KEY, latest);

      const firstView = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(firstView.result.current.hasOlderTimelineRows).toBe(true);
      });
      await act(async () => firstView.result.current.loadOlderTimelineRows());
      expect(firstView.result.current.hasOlderTimelineRows).toBe(false);
      firstView.unmount();

      const appendedSequence = arrival === "offscreen gap" ? 20 : 3;
      const appendedRow = makeUserRow("offscreen-latest", appendedSequence);

      if (arrival !== "unchanged") {
        await act(async () => {
          await queryClient.prefetchQuery({
            queryKey: TIMELINE_QUERY_KEY,
            queryFn: async () =>
              makeTimelineResponse({
                rows: [appendedRow],
                maxSeq: appendedSequence,
                timelinePage: {
                  historySnapshot: "null-cursor-after-offscreen-update",
                  hasOlderRows: true,
                  olderCursor: {
                    anchorId: appendedRow.id,
                    anchorSeq: appendedSequence,
                  },
                },
              }),
            staleTime: 0,
          });
        });
      }

      const expectedRows =
        arrival === "offscreen gap"
          ? [appendedRow.id]
          : [
              "null-cursor-older",
              "null-cursor-latest",
              ...(arrival === "offscreen append" ? [appendedRow.id] : []),
            ];

      const hasOlderRows = arrival === "offscreen gap";

      const returnedView = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(rowIds(returnedView.result.current)).toEqual(expectedRows);
      });
      expect(returnedView.result.current.hasOlderTimelineRows).toBe(
        hasOlderRows,
      );

      if (!hasOlderRows) {
        await act(async () =>
          returnedView.result.current.loadOlderTimelineRows(),
        );
      }

      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
      returnedView.unmount();

      const returnedAgainView = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      expect(rowIds(returnedAgainView.result.current)).toEqual(expectedRows);
      expect(returnedAgainView.result.current.hasOlderTimelineRows).toBe(
        hasOlderRows,
      );
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
      returnedAgainView.unmount();
    },
  );

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "keeps an older page that resolves %s a same-snapshot realtime update",
    async (_order, olderPageFirst) => {
      const { publishLatest, result, settleOlderPage } =
        await renderControllerWithPendingOlderPage();

      const publishRealtimeUpdate = async () => {
        publishLatest(makeSameSnapshotRealtimeResponse());
        await waitFor(() => {
          expect(rowIds(result.current)).toContain(realtimeRow.id);
        });
      };

      if (olderPageFirst) {
        await settleOlderPage();
        await publishRealtimeUpdate();
      } else {
        await publishRealtimeUpdate();
        await settleOlderPage();
      }

      expect(rowIds(result.current)).toEqual([
        olderPageRow.id,
        newestLoadedRow.id,
        realtimeRow.id,
      ]);
      expect(result.current.hasOlderTimelineRows).toBe(false);
    },
  );

  it("rejects a failed older page so the caller can offer a retry", async () => {
    const { failOlderPage, result } =
      await renderControllerWithPendingOlderPage();

    expect(result.current.isLoadingOlderTimelineRows).toBe(true);

    await failOlderPage(makeServerError());

    expect(result.current.isLoadingOlderTimelineRows).toBe(false);
    expect(result.current.hasOlderTimelineRows).toBe(true);
    expect(rowIds(result.current)).toEqual([newestLoadedRow.id]);
  });

  it("replaces an applied older page when a later realtime update changes the history snapshot", async () => {
    const { publishLatest, queryClient, result, settleOlderPage } =
      await renderControllerWithPendingOlderPage();

    await settleOlderPage();
    expect(rowIds(result.current)).toEqual([
      olderPageRow.id,
      newestLoadedRow.id,
    ]);
    purgeThreadOpenHistoryCache(queryClient, "thread-1");
    publishLatest(
      makeTimelineResponse({
        rows: [contextClearRow],
        maxSeq: 10,
        timelinePage: {
          historySnapshot: "snapshot-2",
          hasOlderRows: true,
          olderCursor: { anchorId: contextClearRow.id, anchorSeq: 10 },
        },
      }),
    );

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([contextClearRow.id]);
    });
    expect(result.current.hasOlderTimelineRows).toBe(true);
  });

  it.each(["legacy", "durable"])(
    "adopts the refetched latest cursor after a stale older-page cursor (%s)",
    async (snapshotKind) => {
      const snapshot = (maxSeq: number) =>
        snapshotKind === "legacy"
          ? "snapshot-1"
          : JSON.stringify({
              version: 5,
              threadId: "thread-1",
              maxSeq,
              status: "active",
              surface: "default",
              historyEpoch: "a".repeat(32),
            });

      const recoveredLatest = makeSameSnapshotRealtimeResponse();
      recoveredLatest.timelinePage.historySnapshot = snapshot(2);

      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [newestLoadedRow],
            maxSeq: 1,
            timelinePage: {
              historySnapshot: snapshot(1),
              hasOlderRows: true,
              olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
            },
          }),
        )
        .mockResolvedValueOnce(
          makeTimelineResponse({
            rows: [olderPageRow],
            maxSeq: 1,
            timelinePage: {
              kind: "older",
              historySnapshot: snapshot(1),
              hasOlderRows: true,
              olderCursor: { anchorId: olderPageRow.id, anchorSeq: 0 },
            },
          }),
        )
        .mockRejectedValueOnce(
          new OmnyoHttpError({
            body: null,
            code: "invalid_request",
            message: "Stale timeline cursor",
            status: 400,
          }),
        )
        .mockResolvedValueOnce(recoveredLatest)
        .mockReturnValueOnce(new Promise(() => {}));

      const { queryClient, wrapper } = createQueryClientTestHarness();

      const { result } = renderHook(
        () => useThreadTimelineController({ threadId: "thread-1" }),
        { wrapper },
      );

      await waitFor(() => {
        expect(result.current.hasOlderTimelineRows).toBe(true);
      });
      await act(async () => {
        await result.current.loadOlderTimelineRows();
      });
      expect(rowIds(result.current)).toEqual([
        olderPageRow.id,
        newestLoadedRow.id,
      ]);

      await act(async () => {
        await result.current.loadOlderTimelineRows();
      });

      await waitFor(() => {
        expect(rowIds(result.current)).toEqual([
          olderPageRow.id,
          newestLoadedRow.id,
          realtimeRow.id,
        ]);
      });
      const timelineRequests = vi.mocked(sdk.threads.timeline).mock.calls;
      expect(timelineRequests[2]?.[0]).toMatchObject({
        beforeAnchorId: olderPageRow.id,
        beforeAnchorSeq: "0",
      });
      expect(timelineRequests[3]?.[0]).toMatchObject({ afterSequence: "1" });
      expect(result.current.isLoadingOlderTimelineRows).toBe(false);
      expect(result.current.hasOlderTimelineRows).toBe(true);

      if (snapshotKind === "durable") {
        const appended = makeUserRow("recovered-live-append", 3);

        act(() => {
          queryClient.setQueryData(
            TIMELINE_QUERY_KEY,
            makeTimelineResponse({
              rows: [newestLoadedRow, realtimeRow, appended],
              maxSeq: 3,
              timelinePage: {
                historySnapshot: snapshot(3),
                hasOlderRows: true,
                olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
              },
            }),
          );
        });
        await waitFor(() => {
          expect(rowIds(result.current)).toEqual([
            olderPageRow.id,
            newestLoadedRow.id,
            realtimeRow.id,
            appended.id,
          ]);
        });
      }

      act(() => {
        void result.current.loadOlderTimelineRows();
      });
      await waitFor(() => {
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(5);
      });
      expect(vi.mocked(sdk.threads.timeline).mock.calls[4]?.[0]).toMatchObject({
        beforeAnchorId: newestLoadedRow.id,
        beforeAnchorSeq: "1",
      });
    },
  );

  it("keeps filling an unfilled viewport when an older page settles before its loading state renders", async () => {
    const { anchor } = installAutoLoadEnvironment({ overflowing: false });
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [realtimeRow],
          maxSeq: 2,
          timelinePage: {
            historySnapshot: "snapshot-1",
            hasOlderRows: true,
            olderCursor: { anchorId: realtimeRow.id, anchorSeq: 2 },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [newestLoadedRow],
          maxSeq: 2,
          timelinePage: {
            kind: "older",
            historySnapshot: "snapshot-1",
            hasOlderRows: true,
            olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [olderPageRow],
          maxSeq: 2,
          timelinePage: {
            kind: "older",
            historySnapshot: "snapshot-1",
            hasOlderRows: false,
            olderCursor: null,
          },
        }),
      );

    const { result } = renderControllerWithAutoLoad(anchor);
    await withReactSchedulerOutsideAct(async () => {
      await waitFor(() => {
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
        expect(result.current.timeline.hasOlderTimelineRows).toBe(false);
      });
    });

    expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    expect(rowIds(result.current.timeline)).toEqual([
      olderPageRow.id,
      newestLoadedRow.id,
      realtimeRow.id,
    ]);
  });

  it("loads older history for a message link and reports a removed message as not found", async () => {
    const toastSpy = vi.spyOn(appToast, "message").mockReturnValue("toast-1");
    onTestFinished(() => toastSpy.mockRestore());

    const adjacentMessageRow = {
      ...makeUserRow("thread-1:user-seed:5", 5),
      sourceSeqStart: 4,
    };

    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [makeUserRow("thread-1:user-seed:3", 3), adjacentMessageRow],
          maxSeq: 5,
          timelinePage: {
            historySnapshot: "snapshot-1",
            hasOlderRows: true,
            olderCursor: { anchorId: "thread-1:user-seed:3", anchorSeq: 3 },
          },
        }),
      )
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [newestLoadedRow],
          maxSeq: 5,
          timelinePage: {
            kind: "older",
            historySnapshot: "snapshot-1",
            hasOlderRows: false,
            olderCursor: null,
          },
        }),
      );
    const { wrapper: queryWrapper } = createQueryClientTestHarness();

    const wrapper = ({ children }: { children: ReactNode }) =>
      queryWrapper({
        children: (
          <MemoryRouter
            initialEntries={["/projects/proj-1/threads/thread-1#msg=4"]}
          >
            <SearchMessageLocationProvider threadId="thread-1">
              {children}
            </SearchMessageLocationProvider>
          </MemoryRouter>
        ),
      });

    const { result } = renderHook(
      () => {
        const timeline = useThreadTimelineController({ threadId: "thread-1" });
        useScrollToSearchedMessage(timeline.timelineRows, "thread-1", {
          hasOlderRows: timeline.hasOlderTimelineRows,
          isLoadingOlderRows: timeline.isLoadingOlderTimelineRows,
          onLoadOlderRows: timeline.loadOlderTimelineRows,
          reportsMissingTarget: true,
        });

        return timeline;
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        "Message not found",
        expect.anything(),
      );
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    expect(rowIds(result.current)).toEqual([
      newestLoadedRow.id,
      "thread-1:user-seed:3",
      adjacentMessageRow.id,
    ]);
    expect(toastSpy).toHaveBeenCalledTimes(1);
  });

  it("reveals an accepted steer from a link to its request seq", async () => {
    const toastSpy = vi.spyOn(appToast, "message").mockReturnValue("toast-1");
    onTestFinished(() => toastSpy.mockRestore());

    const steerRow: TimelineUserConversationRow = {
      ...makeUserRow("thread-1:user-seed:5", 7),
      messageSeq: 5,
      turnRequest: {
        clientRequestId: null,
        isGrouped: false,
        kind: "steer",
        status: "accepted",
      },
    };

    const { queryClient, wrapper: queryWrapper } = createQueryClientTestHarness(
      { queries: { staleTime: Infinity } },
    );

    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({
        rows: [makeUserRow("thread-1:user-seed:3", 3), steerRow],
        maxSeq: 8,
      }),
    );

    const wrapper = ({ children }: { children: ReactNode }) =>
      queryWrapper({
        children: (
          <MemoryRouter
            initialEntries={["/projects/proj-1/threads/thread-1#msg=5"]}
          >
            <SearchMessageLocationProvider threadId="thread-1">
              {children}
            </SearchMessageLocationProvider>
          </MemoryRouter>
        ),
      });

    const scrollIntoView = vi.fn();
    const renderedTarget = document.createElement("div");
    renderedTarget.setAttribute("data-timeline-row-id", steerRow.id);
    renderedTarget.scrollIntoView = scrollIntoView;
    document.body.appendChild(renderedTarget);
    onTestFinished(() => renderedTarget.remove());

    renderHook(
      () => {
        const timeline = useThreadTimelineController({ threadId: "thread-1" });
        useScrollToSearchedMessage(timeline.timelineRows, "thread-1", {
          hasOlderRows: timeline.hasOlderTimelineRows,
          isLoadingOlderRows: timeline.isLoadingOlderTimelineRows,
          onLoadOlderRows: timeline.loadOlderTimelineRows,
          reportsMissingTarget: true,
        });

        return timeline;
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: "start",
        inline: "nearest",
      });
    });
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("retries revealing a searched row when a realtime update changes only top-level fields", async () => {
    const { queryClient, wrapper: queryWrapper } = createQueryClientTestHarness(
      { queries: { staleTime: Infinity } },
    );

    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ rows: [newestLoadedRow], maxSeq: 1 }),
    );

    const wrapper = ({ children }: { children: ReactNode }) =>
      queryWrapper({
        children: (
          <MemoryRouter
            initialEntries={[
              {
                pathname: "/thread",
                state: { searchMessageSeq: 1, searchThreadId: "thread-1" },
              },
            ]}
          >
            <SearchMessageLocationProvider threadId="thread-1">
              {children}
            </SearchMessageLocationProvider>
          </MemoryRouter>
        ),
      });

    const { result } = renderHook(
      () => {
        const timeline = useThreadTimelineController({ threadId: "thread-1" });
        useScrollToSearchedMessage(timeline.timelineRows, "thread-1", {
          hasOlderRows: timeline.hasOlderTimelineRows,
          isLoadingOlderRows: timeline.isLoadingOlderTimelineRows,
          onLoadOlderRows: timeline.loadOlderTimelineRows,
        });

        return timeline;
      },
      { wrapper },
    );

    expect(rowIds(result.current)).toEqual([newestLoadedRow.id]);
    const scrollIntoView = vi.fn();
    const renderedTarget = document.createElement("div");
    renderedTarget.setAttribute("data-timeline-row-id", newestLoadedRow.id);
    renderedTarget.scrollIntoView = scrollIntoView;
    document.body.appendChild(renderedTarget);

    try {
      act(() => {
        queryClient.setQueryData(
          TIMELINE_QUERY_KEY,
          makeTimelineResponse({
            activeThinking: {
              id: "thinking-1",
              startedAt: 2,
              text: "Thinking",
              updatedAt: 2,
            },
            rows: [{ ...newestLoadedRow }],
            maxSeq: 2,
          }),
        );
      });

      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalledWith({
          block: "start",
          inline: "nearest",
        });
      });
      expect(result.current.activeThinking?.id).toBe("thinking-1");
    } finally {
      renderedTarget.remove();
    }
  });

  it("loads with the new cursor on the next upward scroll after a discarded older page settles", async () => {
    const { anchor, scrollUpNearTop } = installAutoLoadEnvironment();
    const discardedPage = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({
          rows: [newestLoadedRow],
          maxSeq: 1,
          timelinePage: {
            historySnapshot: "snapshot-1",
            hasOlderRows: true,
            olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
          },
        }),
      )
      .mockReturnValueOnce(discardedPage.promise)
      .mockReturnValueOnce(new Promise(() => {}));

    const { queryClient, result } = renderControllerWithAutoLoad(anchor);
    await waitFor(() => {
      expect(result.current.timeline.hasOlderTimelineRows).toBe(true);
    });
    act(scrollUpNearTop);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0]).toMatchObject({
      beforeAnchorId: newestLoadedRow.id,
      beforeAnchorSeq: "1",
    });

    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({
          rows: [contextClearRow],
          maxSeq: 10,
          timelinePage: {
            historySnapshot: "snapshot-2",
            hasOlderRows: true,
            olderCursor: { anchorId: contextClearRow.id, anchorSeq: 10 },
          },
        }),
      );
    });
    await waitFor(() => {
      expect(rowIds(result.current.timeline)).toEqual([contextClearRow.id]);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);

    await act(async () => {
      discardedPage.resolve(
        makeTimelineResponse({
          rows: [olderPageRow],
          maxSeq: 1,
          timelinePage: { kind: "older", historySnapshot: "snapshot-1" },
        }),
      );
    });

    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    act(scrollUpNearTop);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[2]?.[0]).toMatchObject({
      beforeAnchorId: contextClearRow.id,
      beforeAnchorSeq: "10",
      threadId: "thread-1",
    });
    expect(rowIds(result.current.timeline)).toEqual([contextClearRow.id]);
  });
});

describe("useThreadTimelineController commits", () => {
  it.each([
    {
      outcome: "structurally equal data",
      settle: (refetch: DeferredPromise<ThreadTimelineResponse>) =>
        refetch.resolve(
          makeTimelineResponse({ rows: [{ ...newestLoadedRow }], maxSeq: 1 }),
        ),
      commits: 0,
      expectedRowIds: [newestLoadedRow.id],
      activeThinkingId: undefined,
    },
    {
      outcome: "new rows and top-level fields",
      settle: (refetch: DeferredPromise<ThreadTimelineResponse>) =>
        refetch.resolve(
          makeTimelineResponse({
            activeThinking: {
              id: "thinking-1",
              startedAt: 2,
              text: "Considering the request",
              updatedAt: 2,
            },
            maxSeq: 2,
            rows: [newestLoadedRow, realtimeRow],
          }),
        ),
      commits: 1,
      expectedRowIds: [newestLoadedRow.id, realtimeRow.id],
      activeThinkingId: "thinking-1",
    },
    {
      outcome: "an error",
      settle: (refetch: DeferredPromise<ThreadTimelineResponse>) =>
        refetch.reject(makeServerError()),
      commits: 1,
      expectedRowIds: [newestLoadedRow.id],
      activeThinkingId: undefined,
    },
  ])(
    "commits only for changed data when a refetch of a timeline with rows settles with $outcome",
    async ({ activeThinkingId, commits, expectedRowIds, settle }) => {
      const refetch = createDeferredPromise<ThreadTimelineResponse>();
      vi.mocked(sdk.threads.timeline)
        .mockResolvedValueOnce(
          makeTimelineResponse({ rows: [newestLoadedRow], maxSeq: 1 }),
        )
        .mockReturnValueOnce(refetch.promise);
      const { queryClient, wrapper } = createQueryClientTestHarness();
      const view = await renderSettledController(wrapper, [newestLoadedRow.id]);
      const settledCommitCount = view.profilerCommitCount();

      startTimelineRefetch(queryClient);
      await waitFor(() => {
        expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
      });
      await flushQueryNotifications();
      expect(queryClient.isFetching({ queryKey: TIMELINE_QUERY_KEY })).toBe(1);
      expect(view.profilerCommitCount()).toBe(settledCommitCount);

      await act(async () => {
        settle(refetch);
      });
      await flushQueryNotifications();

      expect(queryClient.isFetching({ queryKey: TIMELINE_QUERY_KEY })).toBe(0);
      expect(view.profilerCommitCount() - settledCommitCount).toBe(commits);
      expect(rowIds(view.latest())).toEqual(expectedRowIds);
      expect(view.latest().activeThinking?.id).toBe(activeThinkingId);
    },
  );

  it("keeps a loaded empty timeline out of the loading state while it refetches", async () => {
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(makeTimelineResponse())
      .mockReturnValueOnce(new Promise(() => {}));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const view = await renderSettledController(wrapper, []);

    startTimelineRefetch(queryClient);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    await flushQueryNotifications();

    expect(queryClient.isFetching({ queryKey: TIMELINE_QUERY_KEY })).toBe(1);
    expect(view.latest().timelineLoading).toBe(false);
  });

  it("reads only query result properties covered by the notify lists", async () => {
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeTimelineResponse({ rows: [newestLoadedRow], maxSeq: 1 }),
    );
    const { wrapper } = createQueryClientTestHarness();
    await renderSettledController(wrapper, [newestLoadedRow.id]);

    const coveredKeys = new Set<PropertyKey>([
      ...TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS,
      "refetch",
    ]);

    expect(readTimelineQueryResultKeys.size).toBeGreaterThan(0);
    expect(
      [...readTimelineQueryResultKeys].filter((key) => !coveredKeys.has(key)),
    ).toEqual([]);
  });

  it("commits once on mount with a cached timeline and shows its rows and cursor", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({
        maxSeq: 1,
        rows: [newestLoadedRow],
        timelinePage: {
          hasOlderRows: true,
          olderCursor: { anchorId: newestLoadedRow.id, anchorSeq: 1 },
        },
      }),
    );

    const view = renderProfiledController(wrapper);
    await flushQueryNotifications();

    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(view.profilerCommitCount()).toBe(1);
    expect(rowIds(view.latest())).toEqual([newestLoadedRow.id]);
    expect(view.latest().hasOlderTimelineRows).toBe(true);
  });
  it("reports catching up while the mount refetch of a timeline with new events runs", async () => {
    const refetch = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(refetch.promise);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    markTimelineHasNewEvents(queryClient);

    const view = renderProfiledController(wrapper);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    expect(view.latest().isCatchingUpTimeline).toBe(true);
    expect(view.latest().timelineLoading).toBe(false);
    expect(rowIds(view.latest())).toEqual([newestLoadedRow.id]);

    await act(async () => {
      refetch.resolve(
        makeTimelineResponse({
          maxSeq: 2,
          rows: [newestLoadedRow, realtimeRow],
        }),
      );
    });
    await waitFor(() => {
      expect(view.latest().isCatchingUpTimeline).toBe(false);
    });
    expect(rowIds(view.latest())).toEqual([newestLoadedRow.id, realtimeRow.id]);

    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(new Promise(() => {}));
    startTimelineRefetch(queryClient);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    await flushQueryNotifications();
    expect(view.latest().isCatchingUpTimeline).toBe(false);
  });
  it("reports catching up when returning to a thread before another thread's fetch settles", async () => {
    const otherThreadFetch = createDeferredPromise<ThreadTimelineResponse>();
    const returnFetch = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(
        makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
      )
      .mockReturnValueOnce(otherThreadFetch.promise)
      .mockReturnValueOnce(returnFetch.promise);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useThreadTimelineController({ threadId }),
      { initialProps: { threadId: "thread-1" }, wrapper },
    );

    await waitFor(() => {
      expect(rowIds(result.current)).toEqual([newestLoadedRow.id]);
    });

    rerender({ threadId: "thread-2" });
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    act(() => {
      queryClient.setQueryData(
        TIMELINE_QUERY_KEY,
        makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
      );
      markTimelineHasNewEvents(queryClient);
    });

    rerender({ threadId: "thread-1" });
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    });
    expect(result.current.isCatchingUpTimeline).toBe(true);

    await act(async () => {
      returnFetch.resolve(
        makeTimelineResponse({
          maxSeq: 2,
          rows: [newestLoadedRow, realtimeRow],
        }),
      );
    });
    await waitFor(() => {
      expect(result.current.isCatchingUpTimeline).toBe(false);
    });
  });

  it("reports catching up when a hidden timeline with new events is enabled", async () => {
    const refetch = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(refetch.promise);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    markTimelineHasNewEvents(queryClient);

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useThreadTimelineController({ enabled, threadId: "thread-1" }),
      { initialProps: { enabled: false }, wrapper },
    );

    expect(result.current.isCatchingUpTimeline).toBe(false);

    rerender({ enabled: true });
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    expect(result.current.isCatchingUpTimeline).toBe(true);
  });
  it("opens an aged cached timeline without fetching or reporting catch-up", async () => {
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(new Promise(() => {}));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
      { updatedAt: 0 },
    );

    const view = renderProfiledController(wrapper);
    await flushQueryNotifications();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(view.latest().timelineRows).toEqual([newestLoadedRow]);
    expect(view.latest().isCatchingUpTimeline).toBe(false);
  });
  it("does not report catching up for a timeline invalidated without unseen events", async () => {
    vi.mocked(sdk.threads.timeline).mockReturnValueOnce(new Promise(() => {}));
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    void queryClient.invalidateQueries({
      queryKey: TIMELINE_QUERY_KEY,
      refetchType: "none",
    });

    const view = renderProfiledController(wrapper);
    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    await flushQueryNotifications();
    expect(view.latest().isCatchingUpTimeline).toBe(false);
  });

  it("keeps unseen events stale without reporting loading after a fetch finishes", async () => {
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    markTimelineHasNewEvents(queryClient);
    const view = renderProfiledController(wrapper);
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(view.latest().isCatchingUpTimeline).toBe(false);
    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(true);
  });

  it("shows a catch-up failure while preserving loaded messages", async () => {
    const failure = new OmnyoHttpError({
      body: null,
      code: "timeline_unavailable",
      message: "Chat could not load. Try again.",
      status: 400,
    });

    vi.mocked(sdk.threads.timeline).mockRejectedValueOnce(failure);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    markTimelineHasNewEvents(queryClient);
    const view = renderProfiledController(wrapper);
    await waitFor(() => {
      expect(view.latest().timelineError).toBe(failure);
    });
    expect(view.latest().isCatchingUpTimeline).toBe(false);
    expect(view.latest().timelineLoading).toBe(false);
    expect(rowIds(view.latest())).toEqual([newestLoadedRow.id]);
    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(true);

    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeTimelineResponse({
        maxSeq: 2,
        rows: [newestLoadedRow, realtimeRow],
      }),
    );
    startTimelineRefetch(queryClient);
    await waitFor(() => {
      expect(rowIds(view.latest())).toEqual([
        newestLoadedRow.id,
        realtimeRow.id,
      ]);
    });
    expect(view.latest().timelineError).toBeNull();
    expect(view.latest().isCatchingUpTimeline).toBe(false);
    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(false);
  });

  it("clears unseen events once the catch-up fetch succeeds", async () => {
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeTimelineResponse({
        maxSeq: 2,
        rows: [newestLoadedRow, realtimeRow],
      }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      TIMELINE_QUERY_KEY,
      makeTimelineResponse({ maxSeq: 1, rows: [newestLoadedRow] }),
    );
    markTimelineHasNewEvents(queryClient);

    const view = renderProfiledController(wrapper);
    await waitFor(() => {
      expect(rowIds(view.latest())).toEqual([
        newestLoadedRow.id,
        realtimeRow.id,
      ]);
    });
    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(false);
  });
});

// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import type { PendingInteraction, ThreadListEntry } from "@omnyo/domain";
import type {
  ServerRuntimeIdentity,
  SidebarBootstrapResponse,
  ThreadTimelineResponse,
  ThreadWithIncludesResponse,
} from "@omnyo/server-contract";
import { COMPACT_VIEWPORT_QUERY } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { POINTER_COARSE_QUERY } from "@omnyo/shared-ui/hooks/use-pointer-coarse";
import * as api from "@/lib/api";
import { sdk } from "@/lib/sdk";
import { MemoryRouter } from "react-router-dom";
import { useRouteState } from "../useRouteState";
import { PluginContext } from "@/components/plugin/plugin-context";
import { experimental_useThreadBootstrapData } from "@/lib/plugin-sdk-hooks";
import {
  makeHost,
  makeThreadListEntry,
} from "@omnyo/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { displayedTimelineRows } from "@/test/displayed-timeline-rows";
import { makeEnvironment } from "@omnyo/test-helpers/domain-fixtures";
import { ARCHIVED_THREADS_PAGE_SIZE } from "./archived-threads-page-size";
import {
  sidebarNavigationQueryKey,
  threadDetailBootstrapQueryKey,
  threadHostFilePreviewQueryKey,
  threadPendingInteractionsQueryKey,
  threadQueuedMessagesQueryKey,
  threadQueryKey,
  threadTimelineQueryKey,
  hostsQueryKey,
  hostQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  environmentWorkStatusQueryKey,
} from "./query-keys";
import { usePaletteRecentArchivedThreads } from "./palette-thread-queries";
import {
  COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT,
  didThreadDetailBootstrapRefreshAfterMount,
  prefetchThreadOpen,
  useArchivedThreads,
  useChildThreads,
  useThread,
  useThreadDetailBootstrap,
  useThreadHostFilePreview,
  useThreadMentionCandidates,
  useThreadPendingInteractions,
  useThreadQueuedMessages,
  useThreadStorageLocation,
  useThreadTimeline,
} from "./thread-queries";
import {
  COARSE_POINTER_THREAD_OPEN_CACHE_MAX_THREADS,
  THREAD_OPEN_CACHE_GC_MS,
  THREAD_OPEN_CACHE_MAX_THREADS,
  rememberThreadTimelineRuntimeId,
  getThreadTimelineRuntimeId,
  purgeThreadOpenHistoryCache,
  clearPersistedThreadTimelineDisplays,
  readPersistedThreadTimelineDisplay,
  rememberThreadOpenRuntimeId,
} from "../cache-owners/thread-open-cache-owner";
import { removeThreadScopedQueries } from "../cache-owners/mutation-cache-effects";
import { createRealtimeCacheEffects } from "../realtime-cache-effects";
import {
  beginCreateQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  rollbackCreateQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
} from "../cache-owners/thread-runtime-cache-owner";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import {
  makeThreadResponse,
  makeThreadTimelineResponse as makeUnstampedThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  hasThreadTimelineUnseenEvents,
  markThreadTimelineUnseenEvents,
} from "../cache-owners/thread-timeline-unseen-events";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return {
    ...actual,
    getThreadHostFilePreview: vi.fn(),
  };
});

vi.mock("@/lib/sdk", async () => ({
  OmnyoHttpError: (await import("@omnyo/sdk/browser")).OmnyoHttpError,
  sdk: {
    server: { runtimeIdentity: vi.fn() },
    threads: {
      defaultExecutionOptions: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
      search: vi.fn(),
      queuedMessages: { list: vi.fn() },
      interactions: { list: vi.fn() },
      storageLocation: vi.fn(),
      timeline: vi.fn(),
    },
    environments: { status: vi.fn() },
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
  useEnvironmentListRealtimeSubscription: vi.fn(),
  useHostListRealtimeSubscription: vi.fn(),
  useProjectListRealtimeSubscription: vi.fn(),
}));

const THREAD_WITH_INCLUDES = {
  ...makeThreadResponse({
    id: "thread-1",
    projectId: "project-1",
    environmentId: null,
    title: "Thread",
    titleFallback: "Thread",
    latestAttentionAt: 1,
    createdAt: 1,
    updatedAt: 1,
  }),
  environment: null,
  host: null,
} satisfies ThreadWithIncludesResponse;

const RUNTIME_IDENTITY = {
  runtimeId: "runtime-test-1",
} satisfies ServerRuntimeIdentity;

function makeThreadTimelineResponse(
  args: Parameters<typeof makeUnstampedThreadTimelineResponse>[0] = {},
) {
  return {
    ...makeUnstampedThreadTimelineResponse(args),
    runtimeId: RUNTIME_IDENTITY.runtimeId,
  };
}

function makeSidebarNavigation(
  projectThreads: ThreadListEntry[],
  personalThreads: ThreadListEntry[] = [],
): SidebarBootstrapResponse {
  return makeSidebarBootstrapResponse({
    projects: [
      makeProjectWithThreadsResponse({
        id: "project-1",
        name: "Project",
        createdAt: 1,
        updatedAt: 1,
        threads: projectThreads,
      }),
    ],
    personalProject: makeProjectWithThreadsResponse({
      id: "proj_personal",
      kind: "personal",
      name: "Personal",
      createdAt: 1,
      updatedAt: 1,
      threads: personalThreads,
    }),
  });
}

function mockMatchMedia(matching: readonly string[]) {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(sdk.threads.defaultExecutionOptions).mockResolvedValue(null);
  vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue(RUNTIME_IDENTITY);
  vi.mocked(sdk.threads.get).mockResolvedValue(THREAD_WITH_INCLUDES);
  vi.mocked(sdk.threads.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.queuedMessages.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.interactions.list).mockResolvedValue([]);
  vi.mocked(sdk.threads.storageLocation).mockResolvedValue({
    hostId: "host-1",
    storageRootPath: "/tmp/thread-storage/thread-1",
  });
  vi.mocked(sdk.threads.timeline).mockResolvedValue(
    makeThreadTimelineResponse({
      timelinePage: {
        kind: "latest",
        segmentLimit: 100,
        returnedSegmentCount: 0,
        hasOlderRows: false,
        olderCursor: null,
      },
    }),
  );
  vi.mocked(api.getThreadHostFilePreview).mockResolvedValue({
    kind: "text",
    path: "/tmp/log.txt",
    url: "/api/v1/threads/thread-1/host-files/tmp/log.txt",
    mimeType: "text/plain",
    content: "preview",
  });
});

describe("concurrent runtime and timeline reads", () => {
  it("keeps provisional chat prefetches local while creation is pending", async () => {
    const { queryClient } = createQueryClientTestHarness();
    await prefetchThreadOpen(queryClient, "pending_local-chat");
    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(sdk.threads.defaultExecutionOptions).not.toHaveBeenCalled();
    expect(sdk.server.runtimeIdentity).not.toHaveBeenCalled();
  });

  it("keeps a locally accepted message visible through a timeline refresh until its send settles", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data?.rows).toEqual([]));

    const request = {
      id: "thread-1",
      mode: "auto" as const,
      input: [{ type: "text" as const, text: "Pending send", mentions: [] }],
    };

    const transaction = await beginSendThreadMessageTransaction({
      queryClient,
      request,
    });

    const displayed = () =>
      displayedTimelineRows(queryClient, threadTimelineQueryKey("thread-1"));

    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data?.rows).toEqual([]);
    expect(displayed()).toMatchObject([
      { kind: "conversation", text: "Pending send" },
    ]);

    rollbackSendThreadMessageTransaction({ queryClient, request, transaction });
    await act(async () => {
      await result.current.refetch();
    });
    expect(displayed()).toEqual([]);
  });

  it("recovers a fresh cached runtime and active timeline after a server reconnect", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const effects = createRealtimeCacheEffects({ queryClient });
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });

    try {
      await waitFor(() => expect(result.result.current.isSuccess).toBe(true));
      const disconnectedAt = Date.now();
      queryClient.setQueryData(
        threadOpenRuntimeIdentityQueryKey(),
        RUNTIME_IDENTITY.runtimeId,
        { updatedAt: disconnectedAt - 1 },
      );
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        result.result.current.data,
        { updatedAt: disconnectedAt - 1 },
      );
      const runtimeId = "replacement-runtime";
      vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue({ runtimeId });
      vi.mocked(sdk.threads.timeline).mockResolvedValue({
        ...makeThreadTimelineResponse({ maxSeq: 2 }),
        runtimeId,
      });

      act(() => effects.handleConnected({ reconnected: true, disconnectedAt }));

      await waitFor(() =>
        expect(result.result.current.data?.runtimeId).toBe(runtimeId),
      );
      expect(result.result.current.isError).toBe(false);
      expect(sdk.server.runtimeIdentity).toHaveBeenCalledTimes(2);
      expect(getThreadTimelineRuntimeId(queryClient, "thread-1")).toBe(
        runtimeId,
      );
    } finally {
      result.unmount();
      effects.dispose();
      queryClient.clear();
    }
  });

  it("discards a speculative unstamped full read and starts the admitted legacy read after identity", async () => {
    let resolveIdentity: (status: ServerRuntimeIdentity) => void = () => {};

    const identity = new Promise<ServerRuntimeIdentity>((resolve) => {
      resolveIdentity = resolve;
    });

    const old = makeUnstampedThreadTimelineResponse({ maxSeq: 1 });
    const current = makeUnstampedThreadTimelineResponse({ maxSeq: 2 });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    vi.mocked(sdk.server.runtimeIdentity).mockReturnValue(identity);
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(old)
      .mockImplementationOnce(async (args) => {
        expect(
          queryClient.getQueryData(threadOpenRuntimeIdentityQueryKey()),
        ).toBe(RUNTIME_IDENTITY.runtimeId);
        expect(args.afterSequence).toBeUndefined();
        expect(args.afterRevision).toBeUndefined();
        expect(args.afterRuntimeId).toBeUndefined();

        return current;
      });
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });

    try {
      await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledOnce());
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
      ).toBeUndefined();
    } finally {
      await act(async () => resolveIdentity(RUNTIME_IDENTITY));
    }

    await waitFor(() => expect(result.result.current.data).toEqual(current));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
  });

  it("rejects a completed response when current runtime authority changes before admission", async () => {
    let resolveTimeline: (response: ThreadTimelineResponse) => void = () => {};

    const response = new Promise<ThreadTimelineResponse>((resolve) => {
      resolveTimeline = resolve;
    });

    vi.mocked(sdk.threads.timeline).mockReturnValue(response);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });
    await waitFor(() =>
      expect(
        queryClient.getQueryData(threadOpenRuntimeIdentityQueryKey()),
      ).toBe(RUNTIME_IDENTITY.runtimeId),
    );
    queryClient.setQueryData(
      threadOpenRuntimeIdentityQueryKey(),
      "runtime-replaced",
    );
    await act(async () => resolveTimeline(makeThreadTimelineResponse()));
    await waitFor(() => expect(result.result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toBeUndefined();
    expect(getThreadTimelineRuntimeId(queryClient, "thread-1")).toBeUndefined();
  });

  it("cannot repopulate purged history after timeline completes while identity is pending", async () => {
    let resolveIdentity: (status: ServerRuntimeIdentity) => void = () => {};

    vi.mocked(sdk.server.runtimeIdentity).mockReturnValue(
      new Promise((resolve) => {
        resolveIdentity = resolve;
      }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });

    try {
      await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledOnce());
      purgeThreadOpenHistoryCache(queryClient, "thread-1");
    } finally {
      await act(async () => resolveIdentity(RUNTIME_IDENTITY));
    }

    await waitFor(() => expect(result.result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toBeUndefined();
    expect(getThreadTimelineRuntimeId(queryClient, "thread-1")).toBeUndefined();
  });

  it("does not restore a deleted query when its ignored transport resolves late", async () => {
    let resolveTimeline: (response: ThreadTimelineResponse) => void = () => {};

    vi.mocked(sdk.threads.timeline).mockReturnValue(
      new Promise((resolve) => {
        resolveTimeline = resolve;
      }),
    );
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledOnce());
    const signal = vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0].signal;
    result.unmount();
    removeThreadScopedQueries({ queryClient, threadId: "thread-1" });
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveTimeline(makeThreadTimelineResponse()));
    expect(
      queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
    ).toBeUndefined();
    expect(getThreadTimelineRuntimeId(queryClient, "thread-1")).toBeUndefined();
  });

  it("starts timeline HTTP while fresh identity is pending and waits for identity before admission", async () => {
    let resolveIdentity: (status: ServerRuntimeIdentity) => void = () => {};

    const identity = new Promise<ServerRuntimeIdentity>((resolve) => {
      resolveIdentity = resolve;
    });

    vi.mocked(sdk.server.runtimeIdentity).mockReturnValue(identity);
    const { wrapper } = createQueryClientTestHarness();
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });

    try {
      await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledOnce());
      expect(result.result.current.isSuccess).toBe(false);
    } finally {
      await act(async () => resolveIdentity(RUNTIME_IDENTITY));
    }

    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));
  });

  it("rejects a response stamped by a different server runtime", async () => {
    const mismatched = {
      ...makeThreadTimelineResponse(),
      runtimeId: "different-runtime",
    };

    vi.mocked(sdk.threads.timeline).mockResolvedValue(mismatched);
    const { wrapper } = createQueryClientTestHarness();
    const result = renderHook(() => useThreadTimeline("thread-1"), { wrapper });
    await waitFor(() => expect(result.result.current.isError).toBe(true));
    expect(result.result.current.data).toBeUndefined();
  });

  it("reconciles an unstamped server delta with a full response instead of admitting the old base", async () => {
    const previous = makeThreadTimelineResponse({
      maxSeq: 7,
      revision: "rev-7",
    });

    const full = makeUnstampedThreadTimelineResponse({ maxSeq: 8 });
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce({ ...full, rows: [], delta: { upsertRows: [] } })
      .mockResolvedValueOnce(full);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    rememberThreadTimelineRuntimeId(
      queryClient,
      "thread-1",
      previous.runtimeId,
    );
    queryClient.setQueryData(threadTimelineQueryKey("thread-1"), previous, {
      updatedAt: 1,
    });
    await queryClient.invalidateQueries({
      queryKey: threadTimelineQueryKey("thread-1"),
    });

    const result = renderHook(
      () => {
        const query = useThreadTimeline("thread-1");

        return { isSuccess: query.isSuccess, data: query.data };
      },
      { wrapper },
    );

    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));
    await waitFor(() => expect(sdk.threads.timeline).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.result.current.data).toEqual(full));
    expect(
      vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0].afterSequence,
    ).toBeUndefined();
  });
});

describe("useThreadDetailBootstrap", () => {
  it("shares the current plugin result with the conversation without another request or cross-thread data", async () => {
    const payload: ThreadWithIncludesResponse = {
      ...THREAD_WITH_INCLUDES,
      experimental_pluginData: [
        {
          pluginId: "other",
          method: "read",
          outcome: { ok: true, result: "wrong plugin" },
        },
        {
          pluginId: "card",
          method: "read",
          outcome: { ok: true, result: { headline: "Current outcome" } },
        },
      ],
    };

    vi.mocked(sdk.threads.get).mockResolvedValue(payload);

    const { queryClient, wrapper: QueryWrapper } =
      createQueryClientTestHarness();

    const result = renderHook(
      ({ threadId }) => {
        const thread = useThreadDetailBootstrap(threadId);
        const card = experimental_useThreadBootstrapData(threadId, "read");

        return { thread, card };
      },
      {
        initialProps: { threadId: "thread-1" },
        wrapper: ({ children }) => (
          <QueryWrapper>
            <MemoryRouter initialEntries={["/threads/thread-1"]}>
              <PluginContext.Provider value="card">
                {children}
              </PluginContext.Provider>
            </MemoryRouter>
          </QueryWrapper>
        ),
      },
    );

    expect(result.result.current.card.status).toBe("pending");
    await waitFor(() =>
      expect(result.result.current.thread.isSuccess).toBe(true),
    );
    expect(result.result.current.card).toMatchObject({
      status: "ready",
      result: { headline: "Current outcome" },
    });
    expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    expect(sdk.threads.get).toHaveBeenCalledWith({
      threadId: "thread-1",
      include: "environment,host",
      signal: expect.any(AbortSignal),
    });
    act(() =>
      queryClient.setQueryData(threadDetailBootstrapQueryKey("thread-1"), {
        ...payload,
        experimental_pluginData: [
          {
            pluginId: "card",
            method: "read",
            outcome: { ok: true, result: null },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(result.result.current.card).toMatchObject({
        status: "ready",
        result: null,
      }),
    );
    act(() =>
      queryClient.setQueryData(threadDetailBootstrapQueryKey("thread-1"), {
        ...payload,
        experimental_pluginData: [
          {
            pluginId: "card",
            method: "read",
            outcome: { ok: false, error: { message: "Read failed" } },
          },
        ],
      }),
    );
    await waitFor(() =>
      expect(result.result.current.card).toMatchObject({
        status: "error",
        message: "Read failed",
      }),
    );
    vi.mocked(sdk.threads.get).mockImplementation(() => new Promise(() => {}));
    result.rerender({ threadId: "thread-2" });
    expect(result.result.current.card).toEqual({ status: "pending" });
    result.unmount();
    queryClient.clear();
  });

  it("gives a late plugin the current entry response without replaying pending", async () => {
    const payload: ThreadWithIncludesResponse = {
      ...THREAD_WITH_INCLUDES,
      experimental_pluginData: [
        {
          pluginId: "card",
          method: "read",
          outcome: { ok: true, result: null },
        },
      ],
    };

    vi.mocked(sdk.threads.get).mockResolvedValue(payload);

    const { queryClient, wrapper: QueryWrapper } =
      createQueryClientTestHarness();

    function Card() {
      const card = experimental_useThreadBootstrapData("thread-1", "read");

      return <output>{JSON.stringify(card)}</output>;
    }

    function Conversation({ mounted }: { mounted: boolean }) {
      useRouteState();
      const thread = useThreadDetailBootstrap("thread-1");

      return (
        <>
          {thread.isSuccess ? "Conversation ready" : "Loading"}
          {mounted ? <Card /> : null}
        </>
      );
    }

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryWrapper>
        <MemoryRouter initialEntries={["/threads/thread-1"]}>
          <PluginContext.Provider value="card">
            {children}
          </PluginContext.Provider>
        </MemoryRouter>
      </QueryWrapper>
    );

    const result = render(<Conversation mounted={false} />, { wrapper });
    await screen.findByText("Conversation ready");
    result.rerender(<Conversation mounted />);
    expect(
      JSON.parse(screen.getByRole("status").textContent ?? "null"),
    ).toMatchObject({ status: "ready", current: true, result: null });
    expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    result.unmount();
    queryClient.clear();
  });

  it("keeps a prior-entry bootstrap explicitly retained", () => {
    const consoleError = vi.spyOn(console, "error");

    const { queryClient, wrapper: QueryWrapper } =
      createQueryClientTestHarness();

    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thread-1"),
      {
        ...THREAD_WITH_INCLUDES,
        experimental_pluginData: [
          {
            pluginId: "card",
            method: "read",
            outcome: { ok: true, result: null },
          },
        ],
      },
      { updatedAt: 1 },
    );

    const result = renderHook(
      () => experimental_useThreadBootstrapData("thread-1", "read"),
      {
        wrapper: ({ children }) => (
          <QueryWrapper>
            <MemoryRouter initialEntries={["/threads/thread-1"]}>
              <PluginContext.Provider value="card">
                {children}
              </PluginContext.Provider>
            </MemoryRouter>
          </QueryWrapper>
        ),
      },
    );

    expect(result.result.current).toMatchObject({
      status: "ready",
      current: false,
    });
    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    result.unmount();
    queryClient.clear();
  });

  it("starts the workspace status read as soon as the chat bootstrap arrives", async () => {
    const environment = makeEnvironment({ id: "env_git" });
    vi.mocked(sdk.threads.get).mockResolvedValue({
      ...THREAD_WITH_INCLUDES,
      environmentId: environment.id,
      environment,
    });
    vi.mocked(sdk.environments.status).mockResolvedValue({
      outcome: "unavailable",
      failure: { kind: "host-offline", message: "Offline" },
    } as never);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const result = renderHook(() => useThreadDetailBootstrap("thread-1"), {
      wrapper,
    });

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          environmentWorkStatusQueryKey("env_git", "main"),
        ),
      ).toBeDefined(),
    );
    expect(sdk.environments.status).toHaveBeenCalledOnce();
    expect(sdk.environments.status).toHaveBeenCalledWith({
      environmentId: "env_git",
      mergeBaseBranch: "main",
      signal: expect.any(AbortSignal),
    });
    result.unmount();
    queryClient.clear();
  });

  it("keeps a cold host inventory unpopulated until a full machine list arrives", async () => {
    const host = makeHost({ id: "host-bootstrap" });
    vi.mocked(sdk.threads.get).mockResolvedValue({
      ...THREAD_WITH_INCLUDES,
      host,
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const result = renderHook(() => useThreadDetailBootstrap("thread-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(hostQueryKey(host.id))).toEqual(host);
    expect(queryClient.getQueryData(hostsQueryKey())).toBeUndefined();
  });

  it("starts the timeline request before the thread bootstrap settles", async () => {
    let resolveThread:
      | ((thread: ThreadWithIncludesResponse) => void)
      | undefined;

    const threadPromise = new Promise<ThreadWithIncludesResponse>((resolve) => {
      resolveThread = resolve;
    });

    vi.mocked(sdk.threads.get).mockReturnValue(threadPromise);
    const { wrapper } = createQueryClientTestHarness();

    const result = renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledWith(
      expect.objectContaining({ deferContent: "false" }),
    );
    expect(result.result.current.isPending).toBe(true);

    resolveThread?.(THREAD_WITH_INCLUDES);
    await waitFor(() => {
      expect(result.result.current.isSuccess).toBe(true);
    });
  });

  it("uses the cached timeline sequence and merges a prefetched delta", async () => {
    const previousTimeline = makeThreadTimelineResponse({
      rows: [
        {
          id: "row-1",
          kind: "system",
          threadId: "thread-1",
          turnId: null,
          sourceSeqStart: 7,
          sourceSeqEnd: 7,
          startedAt: 1,
          createdAt: 1,
          systemKind: "debug",
          title: "Existing row",
          detail: null,
          status: null,
        },
      ],
      timelinePage: {
        kind: "latest",
        segmentLimit: 100,
        returnedSegmentCount: 1,
        hasOlderRows: false,
        olderCursor: null,
      },
      maxSeq: 7,
      revision: "rev-7",
    });

    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce({
      ...previousTimeline,
      rows: [],
      maxSeq: 8,
      revision: "rev-8",
      delta: { baseRevision: "rev-7", upsertRows: [] },
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    rememberThreadTimelineRuntimeId(
      queryClient,
      "thread-1",
      RUNTIME_IDENTITY.runtimeId,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      previousTimeline,
      { updatedAt: 1 },
    );
    markThreadTimelineUnseenEvents(queryClient, "thread-1", 8, true);

    renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledWith({
        deferContent: "false",
        runtimeIdentity: "server-v1",
        deltaFormat: "assistant-text-append-v1",
        afterSequence: "7",
        afterRuntimeId: RUNTIME_IDENTITY.runtimeId,
        afterRevision: "rev-7",
        signal: expect.any(AbortSignal),
        threadId: "thread-1",
      });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey("thread-1"),
        ),
      ).toEqual({
        ...previousTimeline,
        maxSeq: 8,
        revision: "rev-8",
      });
    });
  });

  it("falls back to a full append-format read when the returned revision does not match", async () => {
    const priorRow = {
      id: "row-1",
      kind: "system" as const,
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 7,
      sourceSeqEnd: 7,
      startedAt: 1,
      createdAt: 1,
      systemKind: "debug" as const,
      title: "Existing row",
      detail: null,
      status: null,
    };

    const previousTimeline = makeThreadTimelineResponse({
      rows: [priorRow],
      maxSeq: 7,
      revision: "rev-7",
    });

    const fullTimeline = makeThreadTimelineResponse({
      rows: [
        priorRow,
        { ...priorRow, id: "row-2", sourceSeqStart: 8, sourceSeqEnd: 8 },
      ],
      maxSeq: 8,
      revision: "rev-full-8",
    });

    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce({
        ...previousTimeline,
        rows: [],
        maxSeq: 8,
        revision: "rev-8",
        delta: { baseRevision: "evicted-rev", upsertRows: [] },
      })
      .mockResolvedValueOnce(fullTimeline);
    const { queryClient, wrapper } = createQueryClientTestHarness();
    rememberThreadTimelineRuntimeId(
      queryClient,
      "thread-1",
      RUNTIME_IDENTITY.runtimeId,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      previousTimeline,
      { updatedAt: 1 },
    );
    markThreadTimelineUnseenEvents(queryClient, "thread-1", 8, true);

    renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    });
    expect(sdk.threads.timeline).toHaveBeenNthCalledWith(1, {
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      afterSequence: "7",
      afterRuntimeId: RUNTIME_IDENTITY.runtimeId,
      afterRevision: "rev-7",
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
    expect(sdk.threads.timeline).toHaveBeenNthCalledWith(2, {
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      ),
    ).toEqual(fullTimeline);
  });

  it("keeps whole-row deltas compatible when the server has no revision support", async () => {
    const priorRow = {
      id: "row-1",
      kind: "system" as const,
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 7,
      sourceSeqEnd: 7,
      startedAt: 1,
      createdAt: 1,
      systemKind: "debug" as const,
      title: "Existing row",
      detail: null,
      status: null,
    };

    const updatedRow = { ...priorRow, title: "Updated row", sourceSeqEnd: 8 };

    const previousTimeline = makeThreadTimelineResponse({
      rows: [priorRow],
      maxSeq: 7,
    });

    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce({
      ...previousTimeline,
      rows: [],
      maxSeq: 8,
      delta: { upsertRows: [updatedRow] },
    });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    rememberThreadTimelineRuntimeId(
      queryClient,
      "thread-1",
      RUNTIME_IDENTITY.runtimeId,
    );
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      previousTimeline,
      { updatedAt: 1 },
    );
    markThreadTimelineUnseenEvents(queryClient, "thread-1", 8, true);

    renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledWith({
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      afterSequence: "7",
      afterRuntimeId: RUNTIME_IDENTITY.runtimeId,
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
    expect(
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey("thread-1"),
      ),
    ).toMatchObject({ rows: [updatedRow], maxSeq: 8 });
  });

  it("opens a cached timeline without a read when no newer event arrived", async () => {
    const cached = makeThreadTimelineResponse({ maxSeq: 7, revision: "rev-7" });
    const { queryClient, wrapper } = createQueryClientTestHarness();
    rememberThreadTimelineRuntimeId(
      queryClient,
      "thread-1",
      RUNTIME_IDENTITY.runtimeId,
    );
    queryClient.setQueryData(threadTimelineQueryKey("thread-1"), cached, {
      updatedAt: 1,
    });

    renderHook(
      () =>
        useThreadDetailBootstrap("thread-1", {
          timelinePrefetch: true,
        }),
      { wrapper },
    );

    await waitFor(() => expect(sdk.threads.get).toHaveBeenCalled());
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(threadTimelineQueryKey("thread-1"))).toBe(
      cached,
    );
  });

  it("does not read the timeline cache without an unseen sequence", () => {
    const { queryClient } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadTimelineQueryKey("thread-1"),
      makeThreadTimelineResponse({ maxSeq: 8 }),
    );
    const reads = vi.spyOn(queryClient, "getQueryData");

    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(false);
    expect(reads).not.toHaveBeenCalled();
    queryClient.clear();
  });

  it("does not clear unseen events when a thread-open prefetch finishes", async () => {
    const { queryClient } = createQueryClientTestHarness();
    markThreadTimelineUnseenEvents(queryClient, "thread-1", 9, true);
    vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
      makeThreadTimelineResponse({ maxSeq: 8 }),
    );

    prefetchThreadOpen(queryClient, "thread-1");

    await waitFor(() => {
      expect(
        queryClient.getQueryData(threadDetailBootstrapQueryKey("thread-1")),
      ).toBeDefined();
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thread-1")),
      ).toBeDefined();
    });
    expect(hasThreadTimelineUnseenEvents(queryClient, "thread-1")).toBe(true);
  });

  it.each([false, true])(
    "completes background timeline reads without exact cache scans and persists only inactive queries (active=%s)",
    async (active) => {
      const { queryClient } = createQueryClientTestHarness({
        queries: {
          queryKeyHashFn: (key) => JSON.stringify(["global", key]),
        },
      });

      const queryKey = threadTimelineQueryKey("thread-1");

      if (active)
        queryClient.setQueryDefaults([queryKey[0]], {
          queryKeyHashFn: (key) => JSON.stringify(["timeline", key]),
        });
      const row = conversationRow({ text: "Saved background answer" });

      const response = makeThreadTimelineResponse({
        maxSeq: 1,
        rows: [row],
        timelinePage: { historySnapshot: "background-read" },
      });

      let complete!: (value: ThreadTimelineResponse) => void;
      vi.mocked(sdk.threads.timeline).mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      clearPersistedThreadTimelineDisplays();
      rememberThreadOpenRuntimeId(queryClient, RUNTIME_IDENTITY.runtimeId);

      const observer = new QueryObserver(queryClient, {
        queryKey,
        enabled: false,
        staleTime: Infinity,
      });

      const unsubscribe = observer.subscribe(() => {});
      const scan = vi.spyOn(queryClient.getQueryCache(), "find");

      try {
        const read = prefetchThreadOpen(
          queryClient,
          "thread-1",
          false,
          "background",
        );

        await waitFor(() =>
          expect(sdk.threads.timeline).toHaveBeenCalledOnce(),
        );
        observer.setOptions({ ...observer.options, enabled: active });
        complete(response);
        await read;
        await new Promise((resolve) => window.setTimeout(resolve, 0));

        expect(queryClient.getQueryData(queryKey)).toMatchObject({
          rows: [row],
          maxSeq: 1,
        });
        expect(sdk.threads.timeline).toHaveBeenCalledOnce();

        const display = readPersistedThreadTimelineDisplay({
          origin: window.location.origin,
          runtimeId: RUNTIME_IDENTITY.runtimeId,
          threadId: "thread-1",
        });

        if (active) expect(display).toBeNull();
        else expect(display?.rows).toEqual([row]);
        expect(scan).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        queryClient.clear();
        clearPersistedThreadTimelineDisplays();
      }
    },
  );

  it.each([
    ["a git workspace", makeEnvironment({ id: "env_git" }), null, 1],
    ["an archived chat", makeEnvironment({ id: "env_git" }), 5, 0],
    [
      "a plain folder",
      makeEnvironment({ id: "env_plain", isGitRepo: false }),
      null,
      0,
    ],
  ])(
    "prefetches workspace status with the chat bootstrap for %s",
    async (_name, environment, archivedAt, expectedReads) => {
      const { queryClient } = createQueryClientTestHarness();
      vi.mocked(sdk.threads.get).mockResolvedValueOnce({
        ...THREAD_WITH_INCLUDES,
        environmentId: environment.id,
        archivedAt,
        environment,
      });
      vi.mocked(sdk.threads.timeline).mockResolvedValueOnce(
        makeThreadTimelineResponse({ maxSeq: 1 }),
      );
      vi.mocked(sdk.environments.status).mockResolvedValue({
        outcome: "unavailable",
        failure: { kind: "host-offline", message: "Offline" },
      } as never);

      await prefetchThreadOpen(queryClient, "thread-1");
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));

      expect(sdk.environments.status).toHaveBeenCalledTimes(expectedReads);

      if (expectedReads === 1) {
        expect(sdk.environments.status).toHaveBeenCalledWith({
          environmentId: "env_git",
          mergeBaseBranch: "main",
          signal: expect.any(AbortSignal),
        });
        expect(
          queryClient.getQueryData(
            environmentWorkStatusQueryKey("env_git", "main"),
          ),
        ).toBeDefined();
      }

      queryClient.clear();
    },
  );

  it("warms distinct chat intents while another chat read is pending", async () => {
    const { queryClient } = createQueryClientTestHarness();
    let releaseFirst: (value: ThreadTimelineResponse) => void = () => {};

    const first = new Promise<ThreadTimelineResponse>((resolve) => {
      releaseFirst = resolve;
    });

    vi.mocked(sdk.threads.timeline).mockImplementation(({ threadId }) =>
      threadId === "thread-1"
        ? first
        : Promise.resolve(makeThreadTimelineResponse({ maxSeq: 2 })),
    );

    prefetchThreadOpen(queryClient, "thread-1");
    prefetchThreadOpen(queryClient, "thread-2");
    prefetchThreadOpen(queryClient, "thread-2");

    try {
      await waitFor(() => {
        expect(
          queryClient.getQueryData(threadTimelineQueryKey("thread-2")),
        ).toBeDefined();
      });
      expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    } finally {
      releaseFirst(makeThreadTimelineResponse({ maxSeq: 1 }));
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });
      queryClient.clear();
    }
  });

  it("only suppresses a thread refetch for a bootstrap fetched after mount", () => {
    expect(
      didThreadDetailBootstrapRefreshAfterMount({
        dataUpdatedAt: 0,
        isFetchedAfterMount: false,
        isSuccess: true,
      }),
    ).toBe(false);
    expect(
      didThreadDetailBootstrapRefreshAfterMount({
        dataUpdatedAt: 0,
        isFetchedAfterMount: true,
        isSuccess: true,
      }),
    ).toBe(true);
  });

  it("skips the duplicate thread read for a freshly cached bootstrap", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const updatedAt = Date.now();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thread-1"),
      THREAD_WITH_INCLUDES,
      { updatedAt },
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), THREAD_WITH_INCLUDES, {
      updatedAt,
    });

    const result = renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");

        return useThread("thread-1", {
          enabled: bootstrap.isSuccess,
          refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrap)
            ? false
            : "always",
        });
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(result.result.current.isSuccess).toBe(true);
    });
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("refreshes the thread read for an old cached bootstrap", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thread-1"),
      THREAD_WITH_INCLUDES,
      { updatedAt: 1 },
    );
    queryClient.setQueryData(threadQueryKey("thread-1"), THREAD_WITH_INCLUDES, {
      updatedAt: 1,
    });

    renderHook(
      () => {
        const bootstrap = useThreadDetailBootstrap("thread-1");

        return useThread("thread-1", {
          enabled: bootstrap.isSuccess,
          refetchOnMount: didThreadDetailBootstrapRefreshAfterMount(bootstrap)
            ? false
            : "always",
        });
      },
      { wrapper },
    );

    await waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    });
    expect(sdk.threads.get).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
  });
});

describe("useArchivedThreads", () => {
  it("fetches pages only while selected and continues from the loaded offset", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    vi.mocked(sdk.threads.list)
      .mockResolvedValueOnce(
        Array.from({ length: ARCHIVED_THREADS_PAGE_SIZE }, (_, index) =>
          makeThreadListEntry({
            id: `archived-${index}`,
            archivedAt: 1,
          }),
        ),
      )
      .mockResolvedValueOnce([]);

    const { result, rerender } = renderHook(
      ({ enabled }) => useArchivedThreads({}, { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );

    expect(sdk.threads.list).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[1]?.[0]?.offset).toBe(
      ARCHIVED_THREADS_PAGE_SIZE,
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    rerender({ enabled: false });
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    expect(sdk.threads.list).toHaveBeenCalledTimes(2);
  });

  it("loads archived threads across all projects when no scope is selected", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({}), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("maps the archived kind filter to the parent-thread query", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({ kind: "child" }), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      hasParent: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps project scope for project archived lists", async () => {
    const { wrapper } = createQueryClientTestHarness();

    renderHook(() => useArchivedThreads({ projectId: "proj_1" }), {
      wrapper,
    });

    await waitFor(() => {
      expect(sdk.threads.list).toHaveBeenCalled();
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: true,
      limit: ARCHIVED_THREADS_PAGE_SIZE,
      offset: 0,
      projectId: "proj_1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadQueuedMessages", () => {
  it("keeps a locally queued message through a queue refresh until creation settles", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadQueuedMessages("thread-1"), {
      wrapper,
    });

    await waitFor(() => expect(result.current.data).toEqual([]));

    const request = {
      id: "thread-1",
      input: [{ type: "text" as const, text: "Pending queue", mentions: [] }],
    };

    const transaction = await beginCreateQueuedMessageTransaction({
      queryClient,
      request,
    });

    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() =>
      expect(result.current.data).toMatchObject([{ content: request.input }]),
    );

    rollbackCreateQueuedMessageTransaction({
      queryClient,
      request,
      transaction,
    });
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toEqual([]));
  });

  it("refetches stale queue data on window focus", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(() => useThreadQueuedMessages("thread-1"), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.queuedMessages.list).toHaveBeenCalledTimes(1);
    });

    const query = queryClient.getQueryCache().find({
      queryKey: threadQueuedMessagesQueryKey("thread-1"),
    });

    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnMount: true,
        refetchOnWindowFocus: true,
      }),
    );
  });
});

describe("useThreadPendingInteractions", () => {
  it("reuses the first owner's fresh baseline when a second owner mounts", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    queryClient.setQueryData(
      threadPendingInteractionsQueryKey("thread-1"),
      [],
      { updatedAt: Date.now() - 1_000 },
    );

    renderHook(() => useThreadPendingInteractions("thread-1"), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });

    expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(1);
  });

  it("refreshes the baseline after every zero-owner interval", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    first.unmount();

    const pendingInteraction: PendingInteraction = {
      id: "pint-plan",
      threadId: "thread-1",
      turnId: "turn-1",
      providerId: "claude-code",
      providerThreadId: "provider-thread-1",
      providerRequestId: "request-1",
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
          plan: "Refresh the baseline",
          planFilePath: null,
        },
      },
    };

    vi.mocked(sdk.threads.interactions.list).mockResolvedValue([
      pendingInteraction,
    ]);

    const second = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(second.result.current.data).toEqual([pendingInteraction]);
    });
    expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(2);
  });

  it("refetches the interaction baseline when a stale owner remounts", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const first = renderHook(() => useThreadPendingInteractions("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    first.unmount();
    queryClient.setQueryData(
      threadPendingInteractionsQueryKey("thread-1"),
      [],
      { updatedAt: Date.now() - 2_500 },
    );

    renderHook(() => useThreadPendingInteractions("thread-1"), { wrapper });

    await waitFor(() => {
      expect(sdk.threads.interactions.list).toHaveBeenCalledTimes(2);
    });
  });
});

describe("useThreadHostFilePreview", () => {
  it("refetches stale host file previews on focus and reconnect", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    renderHook(
      () => useThreadHostFilePreview("thread-1", "env-1", "/tmp/log.txt"),
      { wrapper },
    );

    await waitFor(() => {
      expect(api.getThreadHostFilePreview).toHaveBeenCalledTimes(1);
    });

    const query = queryClient.getQueryCache().find({
      queryKey: threadHostFilePreviewQueryKey(
        "thread-1",
        "env-1",
        "/tmp/log.txt",
      ),
    });

    expect(query?.options).toEqual(
      expect.objectContaining({
        refetchOnReconnect: true,
        refetchOnWindowFocus: true,
      }),
    );
  });
});

describe("useChildThreads", () => {
  it("derives children from the sidebar cache across projects without a list request", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const projectChild = makeThreadListEntry({
      id: "child-1",
      projectId: "project-1",
      parentThreadId: "parent-1",
    });

    const personalChild = makeThreadListEntry({
      id: "child-2",
      projectId: "proj_personal",
      parentThreadId: "parent-1",
    });

    const hiddenChild = makeThreadListEntry({
      id: "child-hidden",
      parentThreadId: "parent-1",
      visibility: "hidden",
    });

    const otherChild = makeThreadListEntry({
      id: "child-other",
      parentThreadId: "parent-2",
    });

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation(
        [projectChild, hiddenChild, otherChild],
        [personalChild],
      ),
    );

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    expect(result.current.data?.map((thread) => thread.id)).toEqual([
      "child-1",
      "child-2",
    ]);
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();

    const newChild = makeThreadListEntry({
      id: "child-3",
      parentThreadId: "parent-1",
    });

    act(() => {
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([projectChild, newChild], [personalChild]),
      );
    });
    await waitFor(() => {
      expect(result.current.data?.map((thread) => thread.id)).toEqual([
        "child-1",
        "child-3",
        "child-2",
      ]);
    });
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("keeps child results unchanged when unrelated sidebar rows change", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });

    const unrelated = makeThreadListEntry({ id: "other", title: "Before" });
    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([child, unrelated]),
    );

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    const initialData = result.current.data;

    expect(initialData?.map((thread) => thread.id)).toEqual(["child-1"]);

    act(() => {
      queryClient.setQueryData(
        sidebarNavigationQueryKey(),
        makeSidebarNavigation([child, { ...unrelated, title: "After" }]),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.data).toEqual(initialData);
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("waits for an in-flight sidebar bootstrap instead of racing it with a list request", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });

    let resolveBootstrap: (value: SidebarBootstrapResponse) => void = () => {};

    const bootstrapFetch = queryClient.prefetchQuery({
      queryKey: sidebarNavigationQueryKey(),
      queryFn: () =>
        new Promise<SidebarBootstrapResponse>((resolve) => {
          resolveBootstrap = resolve;
        }),
    });

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    expect(sdk.threads.list).not.toHaveBeenCalled();

    await act(async () => {
      resolveBootstrap(makeSidebarNavigation([child]));
      await bootstrapFetch;
    });
    await waitFor(() => {
      expect(result.current.data).toEqual([child]);
    });
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("falls back to the parent-keyed list request without a sidebar cache", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const child = makeThreadListEntry({
      id: "child-1",
      parentThreadId: "parent-1",
    });

    vi.mocked(sdk.threads.list).mockResolvedValue([child]);

    const { result } = renderHook(
      () => useChildThreads({ enabled: true, parentThreadId: "parent-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([child]);
    });
    expect(sdk.threads.list).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: false,
      parentThreadId: "parent-1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadMentionCandidates", () => {
  it("serves candidates from the sidebar cache without a list request", () => {
    const { queryClient, wrapper } = createQueryClientTestHarness();
    const visible = makeThreadListEntry({ id: "thread-visible" });

    const hidden = makeThreadListEntry({
      id: "thread-hidden",
      visibility: "hidden",
    });

    const personal = makeThreadListEntry({
      id: "thread-personal",
      projectId: "proj_personal",
    });

    queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      makeSidebarNavigation([visible, hidden], [personal]),
    );

    const { result } = renderHook(
      () => useThreadMentionCandidates({ enabled: true }),
      { wrapper },
    );

    expect(result.current.data?.map((thread) => thread.id)).toEqual([
      "thread-visible",
      "thread-personal",
    ]);
    expect(result.current.isLoading).toBe(false);
    expect(sdk.threads.list).not.toHaveBeenCalled();
  });

  it("falls back to the capped list request without a sidebar cache", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const thread = makeThreadListEntry({ id: "thread-1" });
    vi.mocked(sdk.threads.list).mockResolvedValue([thread]);

    const { result } = renderHook(
      () => useThreadMentionCandidates({ enabled: true }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.data).toEqual([thread]);
    });
    expect(vi.mocked(sdk.threads.list).mock.calls[0]?.[0]).toEqual({
      archived: false,
      limit: 200,
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadStorageLocation", () => {
  it("requests only the storage location for the thread", async () => {
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadStorageLocation("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({
        hostId: "host-1",
        storageRootPath: "/tmp/thread-storage/thread-1",
      });
    });
    expect(sdk.threads.storageLocation).toHaveBeenCalledWith({
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("useThreadTimeline segment limit", () => {
  it("asks for the compact first window on compact viewports and keeps it for deltas", async () => {
    mockMatchMedia([COMPACT_VIEWPORT_QUERY]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0]).toEqual({
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      threadId: "thread-1",
      segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      signal: expect.any(AbortSignal),
    });

    await queryClient.refetchQueries({
      queryKey: threadTimelineQueryKey("thread-1"),
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0]).toEqual({
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      threadId: "thread-1",
      segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      afterSequence: "0",
      afterRuntimeId: RUNTIME_IDENTITY.runtimeId,
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps the server default window on wide viewports", async () => {
    mockMatchMedia([]);
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(vi.mocked(sdk.threads.timeline).mock.calls[0]?.[0]).toEqual({
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      threadId: "thread-1",
      signal: expect.any(AbortSignal),
    });
  });
});

describe("thread open cache retention", () => {
  function seedThreadOpenCache(
    queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
    threadId: string,
  ) {
    queryClient.setQueryData(threadDetailBootstrapQueryKey(threadId), {
      ...THREAD_WITH_INCLUDES,
      id: threadId,
    });
  }

  async function openTimelines(
    threadIds: readonly string[],
    wrapper: ReturnType<typeof createQueryClientTestHarness>["wrapper"],
  ) {
    const { result, rerender, unmount } = renderHook(
      ({ threadId }: { threadId: string }) => useThreadTimeline(threadId),
      { initialProps: { threadId: threadIds[0] ?? "" }, wrapper },
    );

    for (const threadId of threadIds) {
      rerender({ threadId });
      await waitFor(() => {
        expect(result.current.isFetchedAfterMount).toBe(true);
        expect(result.current.isFetching).toBe(false);
      });
    }

    unmount();
  }

  function hasTimeline(
    queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
    threadId: string,
  ): boolean {
    return (
      queryClient.getQueryData(threadTimelineQueryKey(threadId)) !== undefined
    );
  }

  function hasBootstrap(
    queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
    threadId: string,
  ): boolean {
    return (
      queryClient.getQueryData(threadDetailBootstrapQueryKey(threadId)) !==
      undefined
    );
  }

  it("keeps timeline and bootstrap queries for an hour", async () => {
    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { gcTime: 0 },
    });

    const { result } = renderHook(
      () => ({
        bootstrap: useThreadDetailBootstrap("thread-1"),
        timeline: useThreadTimeline("thread-1"),
      }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.bootstrap.isSuccess).toBe(true);
      expect(result.current.timeline.isSuccess).toBe(true);
    });

    const queryCache = queryClient.getQueryCache();
    expect(
      queryCache.find({ queryKey: threadTimelineQueryKey("thread-1") })?.gcTime,
    ).toBe(THREAD_OPEN_CACHE_GC_MS);
    expect(
      queryCache.find({ queryKey: threadDetailBootstrapQueryKey("thread-1") })
        ?.gcTime,
    ).toBe(THREAD_OPEN_CACHE_GC_MS);
  });

  it("reopens an invalidated retained timeline with a delta from its cached sequence", async () => {
    mockMatchMedia([]);

    const existingRow = {
      id: "row-1",
      kind: "system",
      threadId: "thread-1",
      turnId: null,
      sourceSeqStart: 7,
      sourceSeqEnd: 7,
      startedAt: 1,
      createdAt: 1,
      systemKind: "debug",
      title: "Existing row",
      detail: null,
      status: null,
    } satisfies ThreadTimelineResponse["rows"][number];

    const appendedRow = {
      ...existingRow,
      id: "row-2",
      sourceSeqStart: 9,
      sourceSeqEnd: 9,
      title: "Appended row",
    } satisfies ThreadTimelineResponse["rows"][number];

    const firstTimeline = makeThreadTimelineResponse({
      rows: [existingRow],
      timelinePage: {
        kind: "latest",
        segmentLimit: 100,
        returnedSegmentCount: 1,
        hasOlderRows: false,
        olderCursor: null,
      },
      maxSeq: 7,
    });

    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(firstTimeline)
      .mockResolvedValueOnce({
        ...firstTimeline,
        rows: [],
        maxSeq: 9,
        delta: {
          upsertRows: [appendedRow],
          rowOrder: ["row-1", "row-2"],
        },
      });

    const { queryClient, wrapper } = createQueryClientTestHarness({
      queries: { gcTime: 0, staleTime: 0 },
    });

    const first = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.isSuccess).toBe(true);
    });
    first.unmount();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hasTimeline(queryClient, "thread-1")).toBe(true);
    await queryClient.invalidateQueries({
      queryKey: threadTimelineQueryKey("thread-1"),
    });

    const reopened = renderHook(() => useThreadTimeline("thread-1"), {
      wrapper,
    });

    expect(reopened.result.current.data?.rows).toEqual([existingRow]);
    await waitFor(() => {
      expect(reopened.result.current.data?.maxSeq).toBe(9);
    });

    expect(vi.mocked(sdk.threads.timeline).mock.calls[1]?.[0]).toEqual({
      deferContent: "false",
      runtimeIdentity: "server-v1",
      deltaFormat: "assistant-text-append-v1",
      afterSequence: "7",
      afterRuntimeId: RUNTIME_IDENTITY.runtimeId,
      signal: expect.any(AbortSignal),
      threadId: "thread-1",
    });
    expect(reopened.result.current.data?.rows).toEqual([
      existingRow,
      appendedRow,
    ]);
  });

  it("evicts the least recently opened inactive thread past the cap", async () => {
    mockMatchMedia([]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const threadIds = Array.from(
      { length: THREAD_OPEN_CACHE_MAX_THREADS + 1 },
      (_, index) => `thread-${index}`,
    );

    for (const threadId of threadIds) {
      seedThreadOpenCache(queryClient, threadId);
    }

    await openTimelines(threadIds, wrapper);

    expect(hasTimeline(queryClient, "thread-0")).toBe(false);
    expect(hasBootstrap(queryClient, "thread-0")).toBe(false);

    for (const threadId of threadIds.slice(1)) {
      expect(hasTimeline(queryClient, threadId)).toBe(true);
      expect(hasBootstrap(queryClient, threadId)).toBe(true);
    }
  });

  it("frees a deleted thread's slot instead of evicting a retained thread", async () => {
    mockMatchMedia([]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const threadIds = Array.from(
      { length: THREAD_OPEN_CACHE_MAX_THREADS + 1 },
      (_, index) => `thread-${index}`,
    );

    for (const threadId of threadIds) {
      seedThreadOpenCache(queryClient, threadId);
    }

    const deletedThreadId = threadIds[THREAD_OPEN_CACHE_MAX_THREADS - 1];

    if (deletedThreadId === undefined) {
      throw new Error("Expected a thread to delete");
    }

    await openTimelines(threadIds.slice(0, -1), wrapper);
    removeThreadScopedQueries({ queryClient, threadId: deletedThreadId });
    await openTimelines(threadIds.slice(-1), wrapper);

    expect(hasTimeline(queryClient, deletedThreadId)).toBe(false);
    expect(hasBootstrap(queryClient, deletedThreadId)).toBe(false);

    for (const threadId of threadIds) {
      if (threadId === deletedThreadId) {
        continue;
      }

      expect(hasTimeline(queryClient, threadId)).toBe(true);
      expect(hasBootstrap(queryClient, threadId)).toBe(true);
    }
  });

  it("keeps a thread that is still open in another pane", async () => {
    mockMatchMedia([]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const threadIds = Array.from(
      { length: THREAD_OPEN_CACHE_MAX_THREADS + 1 },
      (_, index) => `thread-${index}`,
    );

    const pinned = renderHook(() => useThreadTimeline("thread-0"), {
      wrapper,
    });

    await waitFor(() => {
      expect(pinned.result.current.isSuccess).toBe(true);
    });

    await openTimelines(threadIds.slice(1), wrapper);

    expect(hasTimeline(queryClient, "thread-0")).toBe(true);
    expect(hasTimeline(queryClient, "thread-1")).toBe(false);
  });

  it("uses the smaller cap on coarse pointers", async () => {
    mockMatchMedia([POINTER_COARSE_QUERY]);
    const { queryClient, wrapper } = createQueryClientTestHarness();

    const threadIds = Array.from(
      { length: COARSE_POINTER_THREAD_OPEN_CACHE_MAX_THREADS + 1 },
      (_, index) => `thread-${index}`,
    );

    await openTimelines(threadIds, wrapper);

    expect(hasTimeline(queryClient, "thread-0")).toBe(false);
    expect(hasTimeline(queryClient, "thread-1")).toBe(true);
    expect(
      hasTimeline(
        queryClient,
        `thread-${COARSE_POINTER_THREAD_OPEN_CACHE_MAX_THREADS}`,
      ),
    ).toBe(true);
  });
});

describe("palette lifecycle queries", () => {
  it("loads bounded archived recents only while selected before typing", async () => {
    const { wrapper } = createQueryClientTestHarness();
    const archived = makeThreadListEntry({ id: "archived", archivedAt: 1 });
    vi.mocked(sdk.threads.list).mockResolvedValue([archived]);

    const { result, rerender } = renderHook(
      ({ recent, selected }) =>
        usePaletteRecentArchivedThreads({ enabled: recent && selected }),
      { wrapper, initialProps: { recent: true, selected: false } },
    );

    expect(sdk.threads.list).not.toHaveBeenCalled();
    rerender({ recent: false, selected: true });
    expect(sdk.threads.list).not.toHaveBeenCalled();
    rerender({ recent: true, selected: true });
    await waitFor(() => expect(result.current.data).toEqual([archived]));
    expect(sdk.threads.list).toHaveBeenCalledExactlyOnceWith({
      archived: true,
      limit: 20,
      signal: expect.any(AbortSignal),
    });
  });
});

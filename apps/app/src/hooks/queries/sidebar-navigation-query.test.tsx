// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useMutation } from "@tanstack/react-query";
import { threadQuestionSchema, type ThreadListEntry } from "@omnyo/domain";
import { createDeferredPromise } from "@omnyo/test-helpers";
import {
  sidebarBootstrapResponseSchema,
  type SidebarBootstrapResponse,
} from "@omnyo/server-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "@/lib/api";
import {
  MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
  SIDEBAR_BOOTSTRAP_CACHE_KEY,
  resetSidebarBootstrapCacheForTest,
} from "@/lib/sidebar-bootstrap-cache";
import {
  makeThreadListEntry,
  makeThreadWorkSummary,
} from "@omnyo/test-helpers/domain-fixtures";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { createQueryNotificationScheduler } from "@/test/queryNotificationScheduler";
import {
  useImmediateSidebarNavigation,
  useSidebarNavigation,
  useSidebarNavigationThreadSelection,
} from "./sidebar-navigation-query";
import { sidebarNavigationQueryKey } from "./query-keys";
import { nativeQuestionSubmissionKey } from "./native-question-submissions";
import { threadAttentionQueryKey } from "../cache-owners/thread-attention-cache-owner";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();

  return { ...actual, request: vi.fn() };
});

vi.mock("@/lib/api-server", () => ({
  apiClient: { "sidebar-bootstrap": { $get: vi.fn(() => ({})) } },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useEnvironmentListRealtimeSubscription: vi.fn(),
  useHostListRealtimeSubscription: vi.fn(),
  useProjectListRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
}));

const PERSONAL_PROJECT: SidebarBootstrapResponse["personalProject"] =
  makeProjectWithThreadsResponse({
    id: "proj_personal",
    kind: "personal",
    name: "Personal",
    createdAt: 1,
    updatedAt: 1,
  });

const BOOTSTRAP: SidebarBootstrapResponse = makeSidebarBootstrapResponse({
  projects: [
    makeProjectWithThreadsResponse({
      id: "proj_felt",
      kind: "standard",
      name: "Felt walk",
      createdAt: 1,
      updatedAt: 1,
    }),
  ],
  personalProject: PERSONAL_PROJECT,
});

const pendingForever = () => new Promise<never>(() => {});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  resetSidebarBootstrapCacheForTest();
});

describe("useSidebarNavigation", () => {
  it.each(["success", "error"] as const)(
    "keeps the server work summary during an answer and follows its %s result",
    async (outcome) => {
      const question = threadQuestionSchema.parse({
        id: "question_one",
        threadId: "thr_one",
        revision: 1,
        state: "open",
        answer: null,
        queuedMessageId: null,
        createdAt: 1,
        updatedAt: 1,
        question: { prompt: "Choose a direction", mode: "required" },
      });

      const work = makeThreadWorkSummary({
        primary: {
          label: "needs-you",
          reason: { code: "required-input", text: "Choose a direction" },
        },
        requiredInput: [
          {
            id: question.id,
            label: question.question.prompt,
            kind: "question",
          },
        ],
        archive: {
          eligible: false,
          recommended: false,
          reason: "The chat still has unresolved work.",
        },
      });

      const original = makeThreadListEntry({
        id: question.threadId,
        projectId: "proj_felt",
        work,
      });

      const untouched = makeThreadListEntry({
        id: "thr_other",
        projectId: "proj_felt",
      });

      const bootstrap = makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            id: "proj_felt",
            threads: [original, untouched],
          }),
        ],
      });

      const harness = createQueryClientTestHarness();
      harness.queryClient.setQueryData(sidebarNavigationQueryKey(), bootstrap);
      harness.queryClient.setQueryData(threadAttentionQueryKey, {
        questions: [question],
        callbacks: [],
      });
      const delivery = createDeferredPromise<void>();

      const { result } = renderHook(
        () => ({
          navigation: useSidebarNavigation({ enabled: false }),
          selection: useSidebarNavigationThreadSelection((threads) =>
            threads.find((thread) => thread.id === question.threadId),
          ),
          submission: useMutation({
            mutationKey: nativeQuestionSubmissionKey(question.threadId, [
              question,
            ]),
            mutationFn: (_answer: { selected: string[] }) => delivery.promise,
          }),
        }),
        { wrapper: harness.wrapper },
      );

      await act(async () =>
        result.current.submission.mutate({ selected: ["continue"] }),
      );
      await waitFor(() =>
        expect(result.current.submission.status).toBe("pending"),
      );
      expect(result.current.selection.data?.work?.primary.label).toBe(
        "needs-you",
      );
      expect(result.current.selection.data?.runtime.displayStatus).toBe("idle");
      expect(result.current.navigation.data).toBe(bootstrap);

      await act(async () => {
        if (outcome === "success") {
          harness.queryClient.setQueryData(threadAttentionQueryKey, {
            questions: [],
            callbacks: [],
          });
          delivery.resolve();
        } else delivery.reject(new Error("Delivery failed"));
      });
      await waitFor(() =>
        expect(result.current.submission.status).toBe(outcome),
      );
      expect(result.current.selection.data?.work).toEqual(work);

      if (outcome === "success") {
        const nextWork = makeThreadWorkSummary({
          primary: {
            label: "working",
            reason: { code: "owned-work", text: "The agent is continuing." },
          },
        });

        await act(async () => {
          harness.queryClient.setQueryData(sidebarNavigationQueryKey(), {
            ...bootstrap,
            projects: bootstrap.projects.map((project) => ({
              ...project,
              threads: project.threads.map((thread) =>
                thread.id === original.id
                  ? {
                      ...thread,
                      runtime: { displayStatus: "active" },
                      work: nextWork,
                    }
                  : thread,
              ),
            })),
          });
        });
        await waitFor(() =>
          expect(result.current.selection.data?.work?.primary.label).toBe(
            "working",
          ),
        );
        expect(result.current.selection.data?.runtime.displayStatus).toBe(
          "active",
        );
      }

      expect(result.current.selection.data).toEqual(
        result.current.navigation.data?.projects[0]?.threads[0],
      );
      expect(result.current.navigation.data?.projects[0]?.threads[1]).toBe(
        untouched,
      );
    },
  );

  it("replays the last bootstrap while the live one loads", async () => {
    sidebarBootstrapResponseSchema.parse(BOOTSTRAP);

    vi.mocked(request).mockResolvedValue(BOOTSTRAP);
    const warmHarness = createQueryClientTestHarness();

    const warm = renderHook(() => useSidebarNavigation(), {
      wrapper: warmHarness.wrapper,
    });

    await waitFor(() => expect(warm.result.current.data).toEqual(BOOTSTRAP));
    warm.unmount();

    vi.mocked(request).mockImplementation(pendingForever);
    const reloadHarness = createQueryClientTestHarness();

    const { result } = renderHook(() => useSidebarNavigation(), {
      wrapper: reloadHarness.wrapper,
    });

    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.projects[0]?.name).toBe("Felt walk");
    await waitFor(() => expect(request).toHaveBeenCalled());
  });

  it("keeps the cold-profile skeleton: no placeholder without a stored bootstrap", () => {
    vi.mocked(request).mockImplementation(pendingForever);
    const harness = createQueryClientTestHarness();

    const { result } = renderHook(() => useSidebarNavigation(), {
      wrapper: harness.wrapper,
    });

    expect(result.current.data).toBeUndefined();
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.isPending).toBe(true);
  });

  it("stores a bounded copy off the critical path and replays it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const manyThreads = Array.from(
        { length: MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT + 20 },
        (_, index) =>
          makeThreadListEntry({ id: `thr_${index}`, projectId: "proj_felt" }),
      );

      const large: SidebarBootstrapResponse = {
        ...BOOTSTRAP,
        orderedProjectIds: ["proj_personal", "proj_deleted", "proj_felt"],
        projects: [{ ...BOOTSTRAP.projects[0]!, threads: manyThreads }],
        personalProject: { ...PERSONAL_PROJECT, threads: manyThreads },
      };

      sidebarBootstrapResponseSchema.parse(large);

      vi.mocked(request).mockResolvedValue(large);
      const warmHarness = createQueryClientTestHarness();

      const warm = renderHook(() => useSidebarNavigation(), {
        wrapper: warmHarness.wrapper,
      });

      await waitFor(() => expect(warm.result.current.data).toEqual(large));
      expect(
        window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY),
      ).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });

      const stored = sidebarBootstrapResponseSchema.parse(
        JSON.parse(window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY)!),
      );

      expect(stored.orderedProjectIds).toEqual(["proj_personal", "proj_felt"]);
      expect(stored.projects[0]!.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
      expect(stored.projects[0]!.threads[0]!.id).toBe("thr_0");
      expect(stored.personalProject.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
      warm.unmount();

      resetSidebarBootstrapCacheForTest();
      vi.mocked(request).mockImplementation(pendingForever);
      const reloadHarness = createQueryClientTestHarness();

      const { result } = renderHook(() => useSidebarNavigation(), {
        wrapper: reloadHarness.wrapper,
      });

      expect(result.current.isPlaceholderData).toBe(true);
      expect(result.current.data?.orderedProjectIds).toEqual([
        "proj_personal",
        "proj_felt",
      ]);
      expect(result.current.data?.projects[0]?.threads).toHaveLength(
        MAX_CACHED_SIDEBAR_THREADS_PER_PROJECT,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail the fetch when storage rejects the write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("quota", "QuotaExceededError");
      });

    try {
      vi.mocked(request).mockResolvedValue(BOOTSTRAP);
      const harness = createQueryClientTestHarness();

      const { result } = renderHook(() => useSidebarNavigation(), {
        wrapper: harness.wrapper,
      });

      await waitFor(() => expect(result.current.data).toEqual(BOOTSTRAP));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(setItem).toHaveBeenCalled();
      expect(result.current.isError).toBe(false);
      expect(
        window.localStorage.getItem(SIDEBAR_BOOTSTRAP_CACHE_KEY),
      ).toBeNull();
    } finally {
      setItem.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("useImmediateSidebarNavigation", () => {
  it("renders a sidebar cache write before deferred query notifications run", () => {
    const idle = makeThreadListEntry({
      id: "thr_send",
      projectId: "proj_felt",
    });

    const working = makeThreadListEntry({
      id: "thr_send",
      projectId: "proj_felt",
      status: "active",
      work: makeThreadWorkSummary({
        primary: {
          label: "working",
          reason: { code: "runtime", text: "The agent is working." },
        },
      }),
    });

    const bootstrapWith = (thread: ThreadListEntry) =>
      makeSidebarBootstrapResponse({
        projects: [
          makeProjectWithThreadsResponse({
            id: "proj_felt",
            threads: [thread],
          }),
        ],
      });

    const harness = createQueryClientTestHarness();
    harness.queryClient.setQueryData(
      sidebarNavigationQueryKey(),
      bootstrapWith(idle),
    );
    const notifications = createQueryNotificationScheduler();
    notifications.install();

    try {
      const { result } = renderHook(
        () => useImmediateSidebarNavigation({ enabled: false }),
        { wrapper: harness.wrapper },
      );

      act(() => {
        harness.queryClient.setQueryData(
          sidebarNavigationQueryKey(),
          bootstrapWith(working),
        );
      });

      expect(
        result.current.data?.projects[0]?.threads[0]?.work?.primary.label,
      ).toBe("working");
    } finally {
      notifications.restore();
    }
  });
});

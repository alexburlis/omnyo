// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type {
  ServerRuntimeIdentity,
  ThreadTimelineResponse,
} from "@omnyo/server-contract";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { threadTimelineQueryKey } from "@/hooks/queries/query-keys";
import { clearPersistedThreadTimelineDisplays } from "@/hooks/cache-owners/thread-open-cache-owner";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { conversationRow } from "@/test/fixtures/thread-timeline-rows";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import { createQueryNotificationScheduler } from "@/test/queryNotificationScheduler";
import { useThreadTimelineController } from "./useThreadTimelineController";

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

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useThreadDetailRealtimeSubscription: vi.fn(),
}));

vi.mock("@/hooks/useServerConnectionState", () => ({
  useServerConnectionState: () => "connected",
}));

const notifications = createQueryNotificationScheduler();

const RUNTIME_IDENTITY = {
  runtimeId: "runtime-test-1",
} satisfies ServerRuntimeIdentity;

beforeEach(() => {
  notifications.install();
  vi.mocked(sdk.server.runtimeIdentity).mockResolvedValue(RUNTIME_IDENTITY);
});

afterEach(() => {
  cleanup();
  clearPersistedThreadTimelineDisplays();
  notifications.restore();
  vi.mocked(sdk.threads.timeline).mockReset();
  vi.mocked(sdk.server.runtimeIdentity).mockReset();
  vi.clearAllMocks();
});

const olderRow = conversationRow({
  id: "thread-1:user-seed:1",
  role: "user",
  seq: 1,
  text: "Run the daily triage",
  threadId: "thread-1",
});

const latestRow = conversationRow({
  id: "thread-1:assistant:10",
  seq: 10,
  text: "Checking the new case",
  threadId: "thread-1",
});

const streamingRow = conversationRow({
  id: "thread-1:assistant:11",
  seq: 11,
  text: "Still working",
  threadId: "thread-1",
});

function durableSnapshot(maxSeq: number): string {
  return JSON.stringify({
    version: 5,
    threadId: "thread-1",
    maxSeq,
    status: "active",
    surface: "default",
    historyEpoch: "a".repeat(32),
  });
}

function latestPage(
  rows: ThreadTimelineResponse["rows"],
  maxSeq: number,
): ThreadTimelineResponse {
  return {
    runtimeId: "runtime-test-1",
    ...makeThreadTimelineResponse({
      rows,
      maxSeq,
      timelinePage: {
        historySnapshot: durableSnapshot(maxSeq),
        hasOlderRows: true,
        olderCursor: { anchorId: `window-10@${maxSeq}`, anchorSeq: 10 },
      },
    }),
  };
}

describe("useThreadTimelineController realtime history", () => {
  it("recovers an invalidated timeline read without duplicate or missing rows", async () => {
    vi.mocked(sdk.threads.timeline)
      .mockRejectedValueOnce(
        new OmnyoHttpError({
          status: 503,
          code: "timeline_unavailable",
          message: "Chat could not load. Try again.",
          body: { code: "timeline_unavailable", retryable: true },
        }),
      )
      .mockResolvedValue(latestPage([olderRow, latestRow], 10));
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        olderRow.id,
        latestRow.id,
      ]);
    });
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(2);
    expect(result.current.timelineError).toBeNull();
    expect(result.current.timelineLoading).toBe(false);
  });

  it("exposes a final timeline error after repeated invalidation exhausts two retries", async () => {
    const error = new OmnyoHttpError({
      status: 503,
      code: "timeline_unavailable",
      message: "Chat could not load. Try again.",
      body: { code: "timeline_unavailable", retryable: true },
    });

    vi.mocked(sdk.threads.timeline).mockRejectedValue(error);
    const { wrapper } = createQueryClientTestHarness();

    const { result } = renderHook(
      () => useThreadTimelineController({ threadId: "thread-1" }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.timelineError).toBe(error));
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(3);
    expect(result.current.timelineLoading).toBe(false);
    expect(result.current.timelineRows).toEqual([]);
  });

  it("applies an in-flight older page after a realtime update rebinds the same cursor to a newer snapshot", async () => {
    const olderPage = createDeferredPromise<ThreadTimelineResponse>();
    vi.mocked(sdk.threads.timeline)
      .mockResolvedValueOnce(latestPage([latestRow], 10))
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

    act(() => {
      queryClient.setQueryData(
        threadTimelineQueryKey("thread-1"),
        latestPage([latestRow, streamingRow], 11),
      );
    });
    await waitFor(() => {
      expect(result.current.timelineRows.map((row) => row.id)).toEqual([
        latestRow.id,
        streamingRow.id,
      ]);
    });

    olderPage.resolve({
      runtimeId: "runtime-test-1",
      ...makeThreadTimelineResponse({
        rows: [olderRow],
        maxSeq: 10,
        timelinePage: {
          kind: "older",
          historySnapshot: durableSnapshot(10),
        },
      }),
    });
    await act(async () => {
      await olderRequest;
    });

    expect(result.current.timelineRows.map((row) => row.id)).toEqual([
      olderRow.id,
      latestRow.id,
      streamingRow.id,
    ]);
    expect(result.current.hasOlderTimelineRows).toBe(false);
  });
});

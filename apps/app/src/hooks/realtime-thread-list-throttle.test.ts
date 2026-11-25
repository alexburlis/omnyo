import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { ThreadChangeKind } from "@omnyo/domain";
import { afterEach, expect, it, vi } from "vitest";
import { createRealtimeCacheEffects } from "./realtime-cache-effects";
import {
  archivedThreadsListQueryKey,
  shelvedThreadsListQueryKey,
  sidebarNavigationQueryKey,
  threadListQueryKey,
} from "./queries/query-keys";

afterEach(() => {
  vi.useRealTimers();
});

it.each([
  "thread-created",
  "thread-deleted",
  "history-rewritten",
  "title-changed",
  "queue-changed",
  "archived-changed",
  "pin-state-changed",
  "parent-changed",
  "environment-changed",
  "shelf-state-changed",
  "events-appended",
] as const)(
  "coalesces %s list reads with a trailing refresh",
  async (change) => {
    vi.useFakeTimers();

    const queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });

    const effects = createRealtimeCacheEffects({ queryClient });
    let revision = 0;

    const keys = [
      threadListQueryKey({ archived: false }),
      threadListQueryKey({ archived: false, projectId: "project-1" }),
      threadListQueryKey({
        archived: false,
        projectId: "project-1",
        sourceThreadId: "thr_parent",
        originKind: "fork",
      }),
    ];

    const reads = keys.map(() => vi.fn(async () => revision));

    const observers = keys.map(
      (queryKey, index) =>
        new QueryObserver(queryClient, {
          queryKey,
          queryFn: reads[index],
          staleTime: Infinity,
        }),
    );

    const stops = observers.map((observer) => observer.subscribe(() => {}));

    const inactiveKey = threadListQueryKey({
      archived: false,
      projectId: "project-1",
      sourceThreadId: "thr_inactive",
    });

    queryClient.setQueryData(inactiveKey, 0);

    try {
      await vi.advanceTimersByTimeAsync(0);

      for (const read of reads) {
        read.mockClear();
      }

      for (revision = 1; revision <= 4; revision += 1) {
        effects.handleChanged({
          type: "changed",
          entity: "thread",
          id: "thr_child",
          changes: [change],
          metadata: { projectId: "project-1", backgroundActivityChanged: true },
        });
        await vi.advanceTimersByTimeAsync(200);
      }

      for (const read of reads) {
        expect(read).toHaveBeenCalledTimes(1);
      }

      expect(queryClient.getQueryState(inactiveKey)?.isInvalidated).toBe(true);
      await vi.advanceTimersByTimeAsync(300);

      for (const read of reads) {
        expect(read).toHaveBeenCalledTimes(2);
      }

      for (const observer of observers) {
        expect(observer.getCurrentResult().data).toBe(revision);
      }

      revision += 1;
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_child",
        changes: [change],
        metadata: { projectId: "project-1", backgroundActivityChanged: true },
      });
      await vi.advanceTimersByTimeAsync(200);
      effects.dispose();
      await vi.advanceTimersByTimeAsync(2_000);

      for (const read of reads) {
        expect(read).toHaveBeenCalledTimes(2);
      }
    } finally {
      for (const stop of stops) {
        stop();
      }

      effects.dispose();
      queryClient.clear();
    }
  },
);

it.each([
  {
    label: "mixed structural burst",
    changes: [
      "thread-created",
      "pin-state-changed",
      "shelf-state-changed",
      "parent-changed",
    ],
    expectedReads: 2,
  },
  { label: "read state", changes: ["read-state-changed"], expectedReads: 0 },
  {
    label: "active-only fallback",
    changes: ["title-changed"],
    expectedReads: 0,
  },
] satisfies {
  label: string;
  changes: ThreadChangeKind[];
  expectedReads: number;
}[])("preserves paged lists for $label", async ({ changes, expectedReads }) => {
  vi.useFakeTimers();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });

  const effects = createRealtimeCacheEffects({ queryClient });
  const keys = [archivedThreadsListQueryKey({}), shelvedThreadsListQueryKey()];
  const reads = keys.map(() => vi.fn(async () => []));

  const stops = keys.map((queryKey, index) =>
    new QueryObserver(queryClient, {
      queryKey,
      queryFn: reads[index],
      staleTime: Infinity,
    }).subscribe(() => {}),
  );

  try {
    await vi.advanceTimersByTimeAsync(0);
    reads.forEach((read) => read.mockClear());

    for (let index = 0; index < 4; index += 1) {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_child",
        changes: [changes[index % changes.length] ?? "thread-created"],
        metadata: { projectId: "project-1" },
      });
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(reads.map((read) => read.mock.calls.length)).toEqual(
      keys.map(() => (expectedReads === 0 ? 0 : 1)),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(reads.map((read) => read.mock.calls.length)).toEqual(
      keys.map(() => expectedReads),
    );

    for (const queryKey of keys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(
        expectedReads === 0,
      );
    }
  } finally {
    stops.forEach((stop) => stop());
    effects.dispose();
    queryClient.clear();
  }
});

it("shares one background list refresh interval across structural and active-only events", async () => {
  vi.useFakeTimers();

  const queryClient = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });

  const effects = createRealtimeCacheEffects({ queryClient });

  const keys = [threadListQueryKey({ archived: false })];

  const reads = keys.map(() => vi.fn(async () => []));

  const stops = keys.map((queryKey, index) =>
    new QueryObserver(queryClient, {
      queryKey,
      queryFn: reads[index],
      staleTime: Infinity,
    }).subscribe(() => {}),
  );

  try {
    await vi.advanceTimersByTimeAsync(0);
    reads.forEach((read) => read.mockClear());

    for (const change of [
      "thread-created",
      "title-changed",
      "events-appended",
      "shelf-state-changed",
    ] satisfies ThreadChangeKind[]) {
      effects.handleChanged({
        type: "changed",
        entity: "thread",
        id: "thr_child",
        changes: [change],
        metadata: { projectId: "project-1", backgroundActivityChanged: true },
      });
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(reads.map((read) => read.mock.calls.length)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(300);
    expect(reads.map((read) => read.mock.calls.length)).toEqual([2]);
  } finally {
    stops.forEach((stop) => stop());
    effects.dispose();
    queryClient.clear();
  }
});

it("refreshes visible membership on the next task even inside the background cooldown", async () => {
  vi.useFakeTimers();
  const queryClient = new QueryClient();
  const effects = createRealtimeCacheEffects({ queryClient });
  let revision = 0;
  const read = vi.fn(async () => revision);

  const observer = new QueryObserver(queryClient, {
    queryKey: sidebarNavigationQueryKey(),
    queryFn: read,
    staleTime: Infinity,
  });

  const stop = observer.subscribe(() => {});

  const change = (kind: ThreadChangeKind) =>
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_child",
      changes: [kind],
      metadata: { projectId: "project-1" },
    });

  try {
    await vi.advanceTimersByTimeAsync(0);
    change("title-changed");
    await vi.advanceTimersByTimeAsync(200);
    read.mockClear();
    revision++;
    change("archived-changed");
    change("shelf-state-changed");
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toBe(revision);
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    stop();
    effects.dispose();
    queryClient.clear();
  }
});

it("finishes the current sidebar read and catches up once after a burst of background membership changes", async () => {
  vi.useFakeTimers();
  const queryClient = new QueryClient();
  const effects = createRealtimeCacheEffects({ queryClient });
  let finish: (() => void) | undefined;

  const read = vi
    .fn(async () => 2)
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = () => resolve(1);
        }),
    );

  const observer = new QueryObserver(queryClient, {
    queryKey: sidebarNavigationQueryKey(),
    queryFn: read,
    staleTime: Infinity,
  });

  const stop = observer.subscribe(() => {});

  const move = () =>
    effects.handleChanged({
      type: "changed",
      entity: "thread",
      id: "thr_child",
      changes: ["pin-state-changed"],
    });

  try {
    for (let i = 0; i < 5; i++) move();
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(1);
    finish?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().data).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
    move();
    effects.dispose();
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    effects.dispose();
    queryClient.clear();
  }
});

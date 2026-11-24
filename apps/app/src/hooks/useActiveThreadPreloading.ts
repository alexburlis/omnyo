import {
  QueryObserver,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { ThreadListEntry } from "@omnyo/domain";
import { COMPACT_VIEWPORT_QUERY } from "@omnyo/shared-ui/hooks/use-compact-viewport";
import { getMediaQuerySnapshot } from "@omnyo/shared-ui/hooks/use-media-query";
import { isInsideNativeShell } from "@/lib/native-shell";
import {
  isDocumentVisible,
  subscribeToDocumentVisibility,
} from "@/lib/document-visibility";
import {
  isStartupSettled,
  subscribeStartupSettled,
} from "@/lib/startup-settled";
import { areTimelineHistorySnapshotsCompatible } from "@omnyo/client-core";
import type { ThreadTimelineResponse } from "@omnyo/server-contract";
import { prefetchThreadOpen } from "./queries/thread-queries";
import {
  threadDetailBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "./queries/query-keys";
import {
  prewarmThreadOlderPage,
  clearThreadOpenCachesForRuntimeChange,
  getThreadOpenRuntimeId,
  getThreadTimelineRuntimeId,
  rememberThreadOpenRuntimeId,
  retainThreadOpenPreloadTargets,
  subscribeThreadOpenBudget,
  isThreadOpenBudgetCold,
  activateThreadOpenCache,
  THREAD_OPEN_CACHE_GC_MS,
} from "./cache-owners/thread-open-cache-owner";

import {
  createThreadOpenSnapshotWriter,
  loadThreadOpenSnapshots,
  seedThreadOpenSnapshots,
} from "./cache-owners/thread-open-snapshots";
import {
  getThreadTimelineUnseenSequence,
  hasThreadTimelineUnseenEvents,
  subscribeThreadTimelineUnseenEvents,
} from "./cache-owners/thread-timeline-unseen-events";

const BACKGROUND_CONCURRENCY = 2;

const BACKGROUND_REFRESH_INTERVAL_MS = 1_000;

export function shouldPreloadOtherChats(): boolean {
  return (
    !isInsideNativeShell() && !getMediaQuerySnapshot(COMPACT_VIEWPORT_QUERY)
  );
}

function createActiveThreadPreloader(queryClient: QueryClient) {
  function isTimelineActive(threadId: string): boolean {
    return (
      queryClient
        .getQueryCache()
        .get(
          queryClient.defaultQueryOptions({
            queryKey: threadTimelineQueryKey(threadId),
          }).queryHash,
        )
        ?.isActive() === true
    );
  }

  let targets = new Set<string>();
  let seedGeneration = 0;
  void loadThreadOpenSnapshots();
  const snapshotWriter = createThreadOpenSnapshotWriter(queryClient);
  const retainedObservers = new Map<string, (() => void)[]>();

  const queryOwners = new Map<
    string,
    {
      threadId: string;
      refreshDetail: boolean;
      sequenceAtReadStart: number;
      reattach: () => void;
    }
  >();

  const queued = new Map<
    string,
    { refreshDetail: boolean; refreshTimeline: boolean }
  >();

  const running = new Set<string>();
  const lastStarted = new Map<string, number>();
  const olderQueued = new Set<string>();
  const olderAttempted = new Map<string, string>();
  let lastReadWasCatchUp = false;

  let olderFlight: {
    threadId: string;
    latest: ThreadTimelineResponse;
    controller: AbortController;
  } | null = null;

  const cancelOlder = (threadId?: string) => {
    if (
      olderFlight !== null &&
      (threadId === undefined || olderFlight.threadId === threadId)
    )
      olderFlight.controller.abort();
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerAt = 0;
  let disposed = false;
  let unsubscribeStartup: (() => void) | null = null;

  const schedule = (delay = 0) => {
    if (disposed || (queued.size === 0 && olderQueued.size === 0)) return;

    if (!isStartupSettled()) {
      unsubscribeStartup ??= subscribeStartupSettled(() => {
        unsubscribeStartup?.();
        unsubscribeStartup = null;
        schedule();
      });

      return;
    }

    const at = Date.now() + delay;

    if (timer !== null && timerAt <= at) return;

    if (timer !== null) clearTimeout(timer);
    timerAt = at;
    timer = setTimeout(drain, delay);
  };

  const enqueue = (
    threadId: string,
    refreshDetail = false,
    refreshTimeline = false,
  ) => {
    if (
      !shouldPreloadOtherChats() ||
      !targets.has(threadId) ||
      isThreadOpenBudgetCold(queryClient, threadId)
    )
      return;
    const previous = queued.get(threadId);
    queued.set(threadId, {
      refreshDetail: refreshDetail || previous?.refreshDetail === true,
      refreshTimeline: refreshTimeline || previous?.refreshTimeline === true,
    });
    schedule();
  };

  function drainOlder() {
    if (
      disposed ||
      !shouldPreloadOtherChats() ||
      !isDocumentVisible() ||
      queued.size > 0 ||
      running.size > 0 ||
      olderFlight !== null
    )
      return;

    for (const threadId of olderQueued) {
      olderQueued.delete(threadId);

      if (
        !targets.has(threadId) ||
        isThreadOpenBudgetCold(queryClient, threadId)
      )
        continue;

      const state = queryClient.getQueryState<ThreadTimelineResponse>(
        threadTimelineQueryKey(threadId),
      );

      const latest = state?.data;

      if (
        state?.status !== "success" ||
        latest?.runtimeId === undefined ||
        latest.runtimeId !==
          getThreadTimelineRuntimeId(queryClient, threadId) ||
        latest.timelinePage.olderCursor === null
      )
        continue;

      const identity = JSON.stringify([
        latest.runtimeId,
        latest.timelinePage.historySnapshot,
        latest.timelinePage.olderCursor,
      ]);

      if (olderAttempted.get(threadId) === identity) continue;
      olderAttempted.set(threadId, identity);
      const flight = { threadId, latest, controller: new AbortController() };
      olderFlight = flight;
      void prewarmThreadOlderPage(
        queryClient,
        threadId,
        latest,
        flight.controller.signal,
      ).finally(() => {
        if (olderFlight === flight) olderFlight = null;
        schedule();
      });
      break;
    }
  }

  function drain() {
    timer = null;

    if (disposed || running.size >= BACKGROUND_CONCURRENCY) return;
    let nextDelay = Infinity;

    const catchUpPriority = lastReadWasCatchUp ? -1 : 1;

    const pending = [...queued].sort(
      ([left, leftRefresh], [right, rightRefresh]) =>
        catchUpPriority *
        (Number(
          rightRefresh.refreshTimeline ||
            hasThreadTimelineUnseenEvents(queryClient, right),
        ) -
          Number(
            leftRefresh.refreshTimeline ||
              hasThreadTimelineUnseenEvents(queryClient, left),
          )),
    );

    for (const [threadId, { refreshDetail, refreshTimeline }] of pending) {
      if (running.size >= BACKGROUND_CONCURRENCY) break;

      if (running.has(threadId)) continue;

      if (isTimelineActive(threadId)) {
        queued.delete(threadId);

        continue;
      }

      const delay =
        (lastStarted.get(threadId) ?? -Infinity) +
        BACKGROUND_REFRESH_INTERVAL_MS -
        Date.now();

      if (delay > 0) {
        nextDelay = Math.min(nextDelay, delay);
        continue;
      }

      queued.delete(threadId);
      running.add(threadId);
      lastStarted.set(threadId, Date.now());
      lastReadWasCatchUp =
        refreshTimeline || hasThreadTimelineUnseenEvents(queryClient, threadId);

      void prefetchThreadOpen(
        queryClient,
        threadId,
        refreshDetail,
        "background",
        refreshTimeline,
      ).finally(() => {
        running.delete(threadId);
        olderQueued.add(threadId);
        schedule();
      });
    }

    if (nextDelay < Infinity && running.size < BACKGROUND_CONCURRENCY) {
      schedule(nextDelay);
    }

    drainOlder();
  }

  const retain = (threadId: string) => {
    if (retainedObservers.has(threadId)) return;
    retainedObservers.set(
      threadId,
      [
        threadTimelineQueryKey(threadId),
        threadDetailBootstrapQueryKey(threadId),
      ].map((queryKey) => {
        const observer = new QueryObserver(queryClient, {
          queryKey,
          enabled: false,
          gcTime: THREAD_OPEN_CACHE_GC_MS,
        });

        const queryHash = observer.getCurrentQuery().queryHash;
        queryOwners.set(queryHash, {
          threadId,
          refreshDetail:
            queryKey[0] === threadDetailBootstrapQueryKey(threadId)[0],
          sequenceAtReadStart:
            getThreadTimelineUnseenSequence(queryClient, threadId) ?? 0,
          reattach: () => observer.setOptions(observer.options),
        });
        const unsubscribe = observer.subscribe(() => {});

        return () => {
          queryOwners.delete(queryHash);
          unsubscribe();
        };
      }),
    );
  };

  const unsubscribeBudget = subscribeThreadOpenBudget(queryClient, (event) => {
    if (!targets.has(event.threadId)) return;

    if (event.kind === "cold") {
      queued.delete(event.threadId);
      olderQueued.delete(event.threadId);
      cancelOlder(event.threadId);

      for (const release of retainedObservers.get(event.threadId) ?? [])
        release();
      retainedObservers.delete(event.threadId);
    } else {
      retain(event.threadId);

      if (!isTimelineActive(event.threadId)) enqueue(event.threadId);
    }
  });

  const unsubscribeUnseen = subscribeThreadTimelineUnseenEvents(
    queryClient,
    (threadId, sequence, turnMayHaveCompleted) => {
      if (!targets.has(threadId)) return;
      activateThreadOpenCache(queryClient, threadId, sequence);

      if (turnMayHaveCompleted && !isTimelineActive(threadId))
        enqueue(threadId, false, true);
    },
  );

  const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
    const [kind] = event.query.queryKey;

    if (
      kind === threadOpenRuntimeIdentityQueryKey()[0] &&
      event.type === "updated" &&
      event.action.type === "success"
    ) {
      const runtimeId = queryClient.getQueryData<string>(
        threadOpenRuntimeIdentityQueryKey(),
      );

      const previousRuntimeId = getThreadOpenRuntimeId(queryClient);

      if (
        runtimeId !== undefined &&
        previousRuntimeId !== undefined &&
        runtimeId !== previousRuntimeId
      ) {
        cancelOlder();
        olderAttempted.clear();
        clearThreadOpenCachesForRuntimeChange(queryClient, runtimeId);
      } else if (runtimeId !== undefined) {
        rememberThreadOpenRuntimeId(queryClient, runtimeId);
      }

      return;
    }

    const owner = queryOwners.get(event.query.queryHash);

    if (!owner) return;

    if (!owner.refreshDetail) {
      if (event.type === "updated" && event.action.type === "fetch")
        owner.sequenceAtReadStart =
          getThreadTimelineUnseenSequence(queryClient, owner.threadId) ?? 0;

      if (
        (event.type === "observerRemoved" ||
          (event.type === "updated" && event.action.type === "success")) &&
        !event.query.isActive() &&
        event.query.state.status === "success" &&
        (getThreadTimelineUnseenSequence(queryClient, owner.threadId) ?? 0) >
          owner.sequenceAtReadStart &&
        hasThreadTimelineUnseenEvents(queryClient, owner.threadId)
      )
        enqueue(owner.threadId, false, true);
    }

    if (event.type === "removed") {
      if (!owner.refreshDetail) {
        cancelOlder(owner.threadId);
        olderQueued.delete(owner.threadId);
      }

      owner.reattach();
      enqueue(owner.threadId, owner.refreshDetail, !owner.refreshDetail);

      return;
    }

    if (
      !owner.refreshDetail &&
      event.type === "updated" &&
      event.action.type === "success"
    ) {
      const latest = queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey(owner.threadId),
      );

      if (
        olderFlight?.threadId === owner.threadId &&
        (!latest ||
          latest.runtimeId !== olderFlight.latest.runtimeId ||
          !areTimelineHistorySnapshotsCompatible(
            latest.timelinePage.historySnapshot,
            olderFlight.latest.timelinePage.historySnapshot,
          ))
      )
        cancelOlder(owner.threadId);
      olderQueued.add(owner.threadId);
      schedule();
    }

    if (event.query.isActive()) return;

    if (
      event.type === "updated" &&
      (event.action.type === "invalidate" ||
        (event.action.type === "setState" &&
          event.query.state.data === undefined))
    ) {
      enqueue(owner.threadId, owner.refreshDetail, !owner.refreshDetail);
    }
  });

  const unsubscribeVisibility = subscribeToDocumentVisibility(() => {
    if (!isDocumentVisible()) {
      if (olderFlight !== null) olderAttempted.delete(olderFlight.threadId);
      cancelOlder();

      return;
    }

    for (const threadId of targets) {
      olderQueued.add(threadId);
      const state = queryClient.getQueryState(threadTimelineQueryKey(threadId));

      if (
        state?.data === undefined ||
        state.isInvalidated ||
        state.status === "error"
      ) {
        activateThreadOpenCache(queryClient, threadId);
        enqueue(threadId);
      }
    }

    schedule();
  });

  return {
    update: (threads: readonly ThreadListEntry[]) => {
      const eligible = threads.filter(
        (thread) =>
          thread.archivedAt === null &&
          thread.deletedAt === null &&
          thread.visibility !== "hidden",
      );

      eligible.sort((a, b) => b.latestAttentionAt - a.latestAttentionAt);
      targets = new Set(eligible.map((thread) => thread.id));

      for (const threadId of olderAttempted.keys()) {
        if (!targets.has(threadId)) olderAttempted.delete(threadId);
      }

      retainThreadOpenPreloadTargets(queryClient, targets);

      for (const [threadId, unsubscribe] of retainedObservers) {
        if (targets.has(threadId)) continue;
        retainedObservers.delete(threadId);
        queued.delete(threadId);
        lastStarted.delete(threadId);
        olderQueued.delete(threadId);
        olderAttempted.delete(threadId);
        cancelOlder(threadId);

        for (const release of unsubscribe) release();
      }

      for (const threadId of targets) {
        if (
          retainedObservers.has(threadId) ||
          isThreadOpenBudgetCold(queryClient, threadId)
        )
          continue;
        retain(threadId);
        enqueue(threadId);
      }

      snapshotWriter.setTargets(targets);
      seedGeneration += 1;
      const generation = seedGeneration;
      void seedThreadOpenSnapshots(
        queryClient,
        eligible.map((thread) => thread.id),
        () => !disposed && generation === seedGeneration,
      );
    },
    dispose: () => {
      disposed = true;
      snapshotWriter.dispose();
      cancelOlder();

      if (timer !== null) clearTimeout(timer);
      unsubscribeStartup?.();
      unsubscribeCache();
      unsubscribeVisibility();
      unsubscribeBudget();
      unsubscribeUnseen();

      for (const unsubscribe of retainedObservers.values()) {
        for (const release of unsubscribe) release();
      }

      retainThreadOpenPreloadTargets(queryClient, new Set());
    },
  };
}

export function useActiveThreadPreloading(
  threads: readonly ThreadListEntry[],
): void {
  const queryClient = useQueryClient();

  const owner = useRef<ReturnType<typeof createActiveThreadPreloader> | null>(
    null,
  );

  useEffect(() => {
    const preloader = createActiveThreadPreloader(queryClient);
    owner.current = preloader;

    return () => preloader.dispose();
  }, [queryClient]);

  useEffect(() => {
    owner.current?.update(threads);
  }, [queryClient, threads]);
}

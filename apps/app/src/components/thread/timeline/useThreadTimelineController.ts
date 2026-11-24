import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  useQueryClient,
  type QueryObserverResult,
} from "@tanstack/react-query";
import type {
  ThreadTimelineResponse,
  TimelineRow,
} from "@omnyo/server-contract";
import {
  areTimelinePaginationCursorsEqual,
  buildLoadedTimelineState,
  mergeLoadedTimelineWithLatest,
  prependOlderTimelineRows,
  recoverLoadedTimelineAfterStaleCursor,
  resolveLoadedTimelineSurfaceKey,
  type LoadedTimelineState,
  areTimelineHistorySnapshotsCompatible,
  readTimelineHistoryIdentity,
} from "@omnyo/client-core";
import {
  getPendingSentMessages,
  subscribePendingSentMessages,
  withPendingSentMessages,
} from "@/hooks/cache-owners/pending-sent-messages";
import { hasThreadTimelineUnseenEvents } from "@/hooks/cache-owners/thread-timeline-unseen-events";
import { clearThreadTimelineUnseenEvents } from "@/hooks/cache-owners/thread-timeline-unseen-events";
import { useConnectionAwareQueryState } from "@/hooks/queries/connection-aware-query-state";
import {
  threadDetailBootstrapQueryKey,
  threadOpenRuntimeIdentityQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { isTransientReadError } from "@/hooks/queries/query-helpers";
import {
  useThreadOpenRuntimeIdentity,
  useThreadTimeline,
} from "@/hooks/queries/thread-queries";
import { OmnyoHttpError, sdk } from "@/lib/sdk";
import { useDocumentVisible } from "@/lib/document-visibility";
import { recordTimelineGapTrace } from "@/lib/timeline-gap-trace";
import {
  clearThreadOpenCachesForRuntimeChange,
  discardPersistedThreadTimelineDisplayIfChanged,
  getThreadTimelineHistoryGeneration,
  getThreadOpenRuntimeId,
  getThreadTimelineRuntimeId,
  isThreadTimelineForRuntimeCurrent,
  rememberThreadOpenRuntimeId,
  peekPersistedThreadTimelineDisplay,
  readPersistedThreadTimelineDisplay,
  rememberThreadTimelineVisitedPages,
  restoreThreadTimelineVisitedPages,
  schedulePersistedThreadTimelineDisplay,
  THREAD_TIMELINE_DEFER_CONTENT,
  type PersistedThreadTimelineDisplay,
  type ThreadTimelineHistoryGeneration,
  type ThreadTimelineVisitedPage,
  type ThreadTimelineVisitedPages,
  purgeThreadOpenHistoryCache,
} from "@/hooks/cache-owners/thread-open-cache-owner";
import {
  mountedRangeFromPage,
  prependMountedHistoryPage,
  reconcileMountedHistory,
  rowsFromMountedHistory,
  type MountedTimelineRange,
} from "./timeline-history-window";

type TimelineQueryResultProp =
  keyof QueryObserverResult<ThreadTimelineResponse>;

const TIMELINE_CONTROLLER_PROPS_WITH_ROWS: TimelineQueryResultProp[] = [
  "data",
  "error",
  "isFetchedAfterMount",
  "isLoading",
  "isLoadingError",
  "isSuccess",
];

const SLOW_TIMELINE_OPEN_TRACE_MS = 1_000;

const NO_TIMELINE_ROWS: TimelineRow[] = [];

export const TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS: TimelineQueryResultProp[] =
  [...TIMELINE_CONTROLLER_PROPS_WITH_ROWS, "isFetching"];

interface UseThreadTimelineControllerArgs {
  enabled?: boolean;
  notFound?: boolean;
  surfaceKey?: string;
  threadId: string;
}

export interface UseThreadTimelineControllerResult {
  activePromptMode: ThreadTimelineResponse["activePromptMode"];
  activeThinking: ThreadTimelineResponse["activeThinking"];
  activeWorkflows: ThreadTimelineResponse["activeWorkflows"];
  activeBackgroundCommands: ThreadTimelineResponse["activeBackgroundCommands"];
  contextBoundarySeq: ThreadTimelineResponse["contextBoundarySeq"];
  contextWindowUsage: ThreadTimelineResponse["contextWindowUsage"];
  goal: ThreadTimelineResponse["goal"];
  providerCommands: ThreadTimelineResponse["providerCommands"];
  sessionOptions: ThreadTimelineResponse["sessionOptions"];
  modelFallback: ThreadTimelineResponse["modelFallback"];
  hasPagedHistory: boolean;
  hasOlderTimelineRows: boolean;
  isCatchingUpTimeline: boolean;
  isLoadingOlderTimelineRows: boolean;
  loadOlderTimelineRows: () => Promise<void>;
  pendingTodos: ThreadTimelineResponse["pendingTodos"];
  timelineError: Error | null;
  timelineLoading: boolean;
  isReadOnlyDisplay: boolean;
  timelineRows: TimelineRow[];
  threadNotFound: boolean;
}

interface LoadedTimelineTracker {
  historyGeneration: ThreadTimelineHistoryGeneration;
  latestTimeline: ThreadTimelineResponse | undefined;
  loaded: LoadedTimelineState;
  pages: ThreadTimelineVisitedPage[];
  runtimeId: string | undefined;
  ranges: MountedTimelineRange[];
}

interface PendingOlderPageRequest {
  controller: AbortController;
  cursor: Exclude<LoadedTimelineState["olderCursor"], null>;
  historyGeneration: ThreadTimelineHistoryGeneration;
  runtimeId: string | undefined;
  surfaceKey: string;
  historySnapshot: string | undefined;
}

interface ReconcileLoadedTimelinePagesArgs {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse | undefined;
  pages: ThreadTimelineVisitedPage[];
  surfaceKey: string;
  ranges?: MountedTimelineRange[];
}

function isStaleTimelinePaginationCursorError(error: Error): boolean {
  return (
    error instanceof OmnyoHttpError &&
    error.status === 400 &&
    error.code === "invalid_request"
  );
}

function buildEmptyLoadedTimelineState(
  surfaceKey: string,
): LoadedTimelineState {
  return buildLoadedTimelineState({
    latestWindowEndSequence: null,
    latestRows: [],
    olderCursor: null,
    surfaceKey,
  });
}

function latestTimelinePage(
  timeline: ThreadTimelineResponse,
): ThreadTimelineVisitedPage {
  return {
    olderCursor: timeline.timelinePage.olderCursor,
    rows: timeline.rows,
  };
}

function loadedTimelineFromPages({
  historySnapshot,
  latestWindowEndSequence,
  pages,
  surfaceKey,
}: ThreadTimelineVisitedPages): LoadedTimelineState {
  let rows = [...(pages[0]?.rows ?? [])];

  for (const page of pages.slice(1)) {
    rows = prependOlderTimelineRows({
      loadedRows: rows,
      olderRows: page.rows,
    });
  }

  const finalPage = pages.at(-1);

  return buildLoadedTimelineState({
    historySnapshot,
    latestWindowEndSequence,
    latestRows: rows,
    olderCursor: finalPage?.olderCursor ?? null,
    surfaceKey,
  });
}

function reconcileLoadedTimelinePages({
  current,
  latestTimeline,
  pages,
  surfaceKey,
  ranges,
}: ReconcileLoadedTimelinePagesArgs): Pick<
  LoadedTimelineTracker,
  "loaded" | "pages" | "ranges"
> {
  if (!latestTimeline) {
    return {
      loaded: buildEmptyLoadedTimelineState(surfaceKey),
      pages: [],
      ranges: [],
    };
  }

  const sameDurableHistory =
    current.surfaceKey === surfaceKey &&
    readTimelineHistoryIdentity(current.historySnapshot) !== null &&
    areTimelineHistorySnapshotsCompatible(
      current.historySnapshot,
      latestTimeline.timelinePage.historySnapshot,
    );

  if (sameDurableHistory) {
    const retained =
      ranges ??
      pages
        .slice()
        .reverse()
        .map((page, index) =>
          mountedRangeFromPage(
            {
              ...latestTimeline,
              rows: page.rows,
              timelinePage: {
                ...latestTimeline.timelinePage,
                olderCursor: page.olderCursor,
                historySnapshot: current.historySnapshot,
              },
            },
            `restored:${index}`,
          ),
        );

    return loadedFromMountedRanges(
      reconcileMountedHistory(
        retained,
        latestTimeline,
        current.latestWindowEndSequence,
      ),
      latestTimeline,
      surfaceKey,
    );
  }

  const merged = mergeLoadedTimelineWithLatestAfterHeadAppend({
    current,
    latestTimeline,
    surfaceKey,
  });

  const mergedRowsById = new Map(merged.rows.map((row) => [row.id, row]));

  const olderPages = pages.slice(1).flatMap((page) => {
    const rows = page.rows.flatMap((row) => {
      const mergedRow = mergedRowsById.get(row.id);

      return mergedRow === undefined ? [] : [mergedRow];
    });

    return rows.length === 0 ? [] : [{ ...page, rows }];
  });

  const olderRowIds = new Set(
    olderPages.flatMap((page) => page.rows.map((row) => row.id)),
  );

  const previousHead = pages[0];

  const headPage = {
    olderCursor:
      olderPages.length === 0
        ? merged.olderCursor
        : previousHead === undefined
          ? latestTimeline.timelinePage.olderCursor
          : previousHead.olderCursor,
    rows: merged.rows.filter((row) => !olderRowIds.has(row.id)),
  };

  const reconciledPages = [headPage, ...olderPages];

  const mounted = reconciledPages
    .slice()
    .reverse()
    .map((page, index) =>
      mountedRangeFromPage(
        {
          ...latestTimeline,
          rows: page.rows,
          timelinePage: {
            ...latestTimeline.timelinePage,
            olderCursor: page.olderCursor,
          },
        },
        `restored:${index}`,
      ),
    );

  return loadedFromMountedRanges(mounted, latestTimeline, surfaceKey);
}

function loadedFromMountedRanges(
  ranges: MountedTimelineRange[],
  latest: ThreadTimelineResponse,
  surfaceKey: string,
  mergedRows = rowsFromMountedHistory(ranges),
): Pick<LoadedTimelineTracker, "loaded" | "pages" | "ranges"> {
  const pages = ranges
    .slice()
    .reverse()
    .map((range) => ({ rows: range.rows, olderCursor: range.olderCursor }));

  return {
    ranges,
    pages,
    loaded: buildLoadedTimelineState({
      historySnapshot: latest.timelinePage.historySnapshot,
      latestWindowEndSequence: latest.maxSeq,
      latestRows: mergedRows,
      olderCursor: ranges[0]
        ? ranges[0].olderCursor
        : latest.timelinePage.olderCursor,
      surfaceKey,
    }),
  };
}

function mergeLoadedTimelineWithLatestAfterHeadAppend({
  current,
  latestTimeline,
  surfaceKey,
}: {
  current: LoadedTimelineState;
  latestTimeline: ThreadTimelineResponse;
  surfaceKey: string;
}): LoadedTimelineState {
  const latestHistorySnapshot = latestTimeline.timelinePage.historySnapshot;

  const latestWindowStart =
    latestTimeline.timelinePage.olderCursor?.anchorSeq ?? 0;

  const isContiguousHeadAppend =
    current.surfaceKey === surfaceKey &&
    current.historySnapshot !== undefined &&
    current.historySnapshot !== latestHistorySnapshot &&
    areTimelineHistorySnapshotsCompatible(
      current.historySnapshot,
      latestHistorySnapshot,
    ) &&
    current.latestWindowEndSequence !== null &&
    latestTimeline.maxSeq > current.latestWindowEndSequence &&
    latestWindowStart <= current.latestWindowEndSequence + 1;

  if (!isContiguousHeadAppend) {
    return mergeLoadedTimelineWithLatest({
      current,
      latestTimeline,
      surfaceKey,
    });
  }

  const merged = mergeLoadedTimelineWithLatest({
    current,
    latestTimeline: {
      ...latestTimeline,
      timelinePage: {
        ...latestTimeline.timelinePage,
        historySnapshot: current.historySnapshot,
      },
    },
    surfaceKey,
  });

  return { ...merged, historySnapshot: latestHistorySnapshot };
}

export function useThreadTimelineController({
  enabled = true,
  notFound = false,
  surfaceKey: explicitSurfaceKey,
  threadId,
}: UseThreadTimelineControllerArgs): UseThreadTimelineControllerResult {
  const queryClient = useQueryClient();

  const pendingSentMessages = useSyncExternalStore(
    useCallback(
      (listener: () => void) =>
        subscribePendingSentMessages(queryClient, listener),
      [queryClient],
    ),
    () => getPendingSentMessages(queryClient, threadId),
  );

  const isDocumentVisible = useDocumentVisible();

  const runtimeIdentityKey = useMemo(
    () => threadOpenRuntimeIdentityQueryKey(),
    [],
  );

  const runtimeIdentity = useThreadOpenRuntimeIdentity(threadId, enabled);
  const runtimeId = runtimeIdentity.data;

  const verifiedRuntimeId =
    runtimeIdentity.isSuccess && runtimeIdentity.isFetchedAfterMount
      ? runtimeId
      : undefined;

  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const peekOpeningDisplay = (): PersistedThreadTimelineDisplay | null =>
    enabled &&
    !notFound &&
    origin !== "" &&
    queryClient.getQueryData(threadTimelineQueryKey(threadId)) === undefined
      ? peekPersistedThreadTimelineDisplay({ origin, threadId })
      : null;

  const [persistedDisplay, setPersistedDisplay] = useState<{
    threadId: string;
    display: PersistedThreadTimelineDisplay | null;
  }>(() => ({ threadId, display: peekOpeningDisplay() }));

  if (persistedDisplay.threadId !== threadId) {
    setPersistedDisplay({ threadId, display: peekOpeningDisplay() });
  }

  const [isPageHidden, setIsPageHidden] = useState(false);
  const pageHiddenRef = useRef(false);
  const olderPageRequestRef = useRef<PendingOlderPageRequest | null>(null);

  const [confirmedNotFoundThreadId, setConfirmedNotFoundThreadId] = useState<
    string | null
  >(null);

  if (
    confirmedNotFoundThreadId !== null &&
    confirmedNotFoundThreadId !== threadId
  ) {
    setConfirmedNotFoundThreadId(null);
  }

  const notifyOnChangeProps = useCallback((): TimelineQueryResultProp[] => {
    if (hasThreadTimelineUnseenEvents(queryClient, threadId)) {
      return TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS;
    }

    const cachedTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(threadId),
    );

    return cachedTimeline !== undefined && cachedTimeline.rows.length > 0
      ? TIMELINE_CONTROLLER_PROPS_WITH_ROWS
      : TIMELINE_CONTROLLER_PROPS_WITHOUT_ROWS;
  }, [queryClient, threadId]);

  const latestTimelineQuery = useThreadTimeline(threadId, {
    enabled: enabled && !notFound && confirmedNotFoundThreadId !== threadId,
    notifyOnChangeProps,
    refetchOnMount: true,
  });

  const timelineResponseNotFound =
    latestTimelineQuery.error instanceof OmnyoHttpError &&
    latestTimelineQuery.error.status === 404;

  const timelineNotFound =
    timelineResponseNotFound || confirmedNotFoundThreadId === threadId;

  const knownRuntimeId = getThreadOpenRuntimeId(queryClient);

  const cachedTimelineRuntimeId = getThreadTimelineRuntimeId(
    queryClient,
    threadId,
  );

  const runtimeChangePending =
    runtimeId !== undefined &&
    ((knownRuntimeId !== undefined && knownRuntimeId !== runtimeId) ||
      (cachedTimelineRuntimeId !== undefined &&
        cachedTimelineRuntimeId !== runtimeId));

  const latestTimeline =
    !timelineNotFound &&
    !runtimeChangePending &&
    isThreadTimelineForRuntimeCurrent(queryClient, threadId, runtimeId)
      ? latestTimelineQuery.data
      : undefined;

  const surfaceKey = resolveLoadedTimelineSurfaceKey(
    explicitSurfaceKey ?? threadId,
    latestTimeline,
  );

  useEffect(() => {
    if (verifiedRuntimeId === undefined) {
      return;
    }

    const previousRuntimeId = getThreadOpenRuntimeId(queryClient);
    const threadRuntimeId = getThreadTimelineRuntimeId(queryClient, threadId);

    const ownerRuntimeChanged =
      previousRuntimeId !== undefined &&
      previousRuntimeId !== verifiedRuntimeId;

    const threadRuntimeChanged =
      threadRuntimeId !== undefined && threadRuntimeId !== verifiedRuntimeId;

    if (
      ownerRuntimeChanged ||
      (previousRuntimeId === undefined && threadRuntimeChanged)
    ) {
      clearThreadOpenCachesForRuntimeChange(queryClient, verifiedRuntimeId);
    } else if (threadRuntimeChanged) {
      purgeThreadOpenHistoryCache(queryClient, threadId, {
        retainPersistedDisplay: true,
      });
      void queryClient.resetQueries({
        queryKey: threadTimelineQueryKey(threadId),
        exact: true,
      });
      void queryClient.resetQueries({
        queryKey: threadDetailBootstrapQueryKey(threadId),
        exact: true,
      });
    } else {
      rememberThreadOpenRuntimeId(queryClient, verifiedRuntimeId);
    }

    if (!enabled || !origin || notFound || timelineNotFound) {
      return;
    }

    const liveTimeline = queryClient.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(threadId),
    );

    const hasCurrentLiveTimeline =
      liveTimeline !== undefined &&
      isThreadTimelineForRuntimeCurrent(
        queryClient,
        threadId,
        verifiedRuntimeId,
      );

    const display = hasCurrentLiveTimeline
      ? null
      : readPersistedThreadTimelineDisplay({
          origin,
          runtimeId: verifiedRuntimeId,
          threadId,
        });

    // oxlint-disable-next-line react/set-state-in-effect -- Refresh external display storage after runtime verification.
    setPersistedDisplay({ threadId, display });
  }, [
    enabled,
    notFound,
    origin,
    queryClient,
    verifiedRuntimeId,
    threadId,
    timelineNotFound,
  ]);

  const historyGeneration = getThreadTimelineHistoryGeneration(
    queryClient,
    threadId,
  );

  const [loadedTimelineTracker, setLoadedTimelineTracker] =
    useState<LoadedTimelineTracker>(() => {
      const restored = latestTimeline
        ? restoreThreadTimelineVisitedPages(queryClient, threadId, {
            surfaceKey,
          })
        : null;

      const reconciled = reconcileLoadedTimelinePages({
        current: restored
          ? loadedTimelineFromPages(restored)
          : buildEmptyLoadedTimelineState(surfaceKey),
        latestTimeline,
        pages: restored?.pages ?? [],
        surfaceKey,
      });

      return {
        historyGeneration,
        latestTimeline,
        loaded: reconciled.loaded,
        pages: reconciled.pages,
        ranges: reconciled.ranges,
        runtimeId,
      };
    });

  let currentTracker = loadedTimelineTracker;
  let loadedTimeline = currentTracker.loaded;

  const runtimeChanged =
    currentTracker.runtimeId !== undefined &&
    runtimeId !== undefined &&
    currentTracker.runtimeId !== runtimeId;

  const historyChanged = currentTracker.historyGeneration !== historyGeneration;
  const surfaceChanged = currentTracker.loaded.surfaceKey !== surfaceKey;

  if (runtimeChanged || historyChanged || surfaceChanged) {
    const restored =
      !runtimeChanged && !historyChanged && latestTimeline
        ? restoreThreadTimelineVisitedPages(queryClient, threadId, {
            surfaceKey,
          })
        : null;

    const reconciled = reconcileLoadedTimelinePages({
      current: restored
        ? loadedTimelineFromPages(restored)
        : buildEmptyLoadedTimelineState(surfaceKey),
      latestTimeline,
      pages: restored?.pages ?? [],
      surfaceKey,
    });

    loadedTimeline = reconciled.loaded;
    currentTracker = {
      historyGeneration,
      latestTimeline,
      loaded: loadedTimeline,
      pages: reconciled.pages,
      ranges: reconciled.ranges,
      runtimeId,
    };
    setLoadedTimelineTracker(currentTracker);
  } else if (currentTracker.latestTimeline !== latestTimeline) {
    const restored =
      currentTracker.pages.length === 0 && latestTimeline
        ? restoreThreadTimelineVisitedPages(queryClient, threadId, {
            surfaceKey,
          })
        : null;

    const reconciled = reconcileLoadedTimelinePages({
      current: restored
        ? loadedTimelineFromPages(restored)
        : currentTracker.loaded,
      latestTimeline,
      pages: restored?.pages ?? currentTracker.pages,
      surfaceKey,
      ranges: restored ? undefined : currentTracker.ranges,
    });

    loadedTimeline = reconciled.loaded;

    currentTracker = {
      historyGeneration,
      latestTimeline,
      loaded: loadedTimeline,
      pages: reconciled.pages,
      ranges: reconciled.ranges,
      runtimeId,
    };
    setLoadedTimelineTracker(currentTracker);
  }

  const currentTrackerRef = useRef(currentTracker);
  currentTrackerRef.current = currentTracker;

  const openTraceRef = useRef<{
    threadId: string;
    startedAt: number;
    hadCachedRows: boolean;
    recorded: boolean;
  } | null>(null);

  useEffect(() => {
    openTraceRef.current = {
      threadId,
      startedAt: performance.now(),
      hadCachedRows: currentTrackerRef.current.loaded.rows.length > 0,
      recorded: false,
    };
  }, [threadId]);

  useEffect(() => {
    const trace = openTraceRef.current;

    if (
      !trace ||
      trace.threadId !== threadId ||
      trace.recorded ||
      !latestTimelineQuery.isFetchedAfterMount
    )
      return;
    trace.recorded = true;
    const durationMs = Math.round(performance.now() - trace.startedAt);

    if (durationMs < SLOW_TIMELINE_OPEN_TRACE_MS) return;

    recordTimelineGapTrace({
      kind: "open-fresh",
      threadId,
      durationMs,
      hadCachedRows: trace.hadCachedRows,
    });
  }, [latestTimelineQuery.isFetchedAfterMount, threadId]);

  const updateLoadedTimeline = useCallback(
    (update: (current: LoadedTimelineTracker) => LoadedTimelineTracker) => {
      const current = currentTrackerRef.current;
      const next = update(current);

      if (next === current) return;
      currentTrackerRef.current = next;
      setLoadedTimelineTracker(next);
    },
    [],
  );

  useEffect(() => {
    if (!latestTimeline || currentTracker.pages.length === 0) return;
    rememberThreadTimelineVisitedPages(queryClient, threadId, {
      historyGeneration,
      historySnapshot: currentTracker.loaded.historySnapshot,
      latestWindowEndSequence: currentTracker.loaded.latestWindowEndSequence,
      pages: currentTracker.pages,
      surfaceKey,
    });
  }, [
    currentTracker.loaded.historySnapshot,
    currentTracker.loaded.latestWindowEndSequence,
    currentTracker.pages,
    historyGeneration,
    latestTimeline,
    queryClient,
    surfaceKey,
    threadId,
  ]);

  const confirmedNotFound = notFound || timelineNotFound;
  const confirmedNotFoundKey = threadId;
  const purgedNotFoundRef = useRef<string | null>(null);

  useEffect(() => {
    if (!confirmedNotFound) {
      purgedNotFoundRef.current = null;

      return;
    }

    if (purgedNotFoundRef.current === confirmedNotFoundKey) return;
    purgedNotFoundRef.current = confirmedNotFoundKey;
    setConfirmedNotFoundThreadId(threadId);
    purgeThreadOpenHistoryCache(queryClient, threadId, {
      removeTimeline: true,
    });
    setPersistedDisplay({ threadId, display: null });
    setLoadedTimelineTracker({
      historyGeneration: getThreadTimelineHistoryGeneration(
        queryClient,
        threadId,
      ),
      latestTimeline: undefined,
      loaded: buildEmptyLoadedTimelineState(surfaceKey),
      pages: [],
      ranges: [],
      runtimeId,
    });
  }, [
    confirmedNotFound,
    confirmedNotFoundKey,
    timelineResponseNotFound,
    queryClient,
    runtimeId,
    surfaceKey,
    threadId,
  ]);

  useEffect(() => {
    if (
      !enabled ||
      !runtimeId ||
      !isDocumentVisible ||
      confirmedNotFound ||
      !latestTimeline
    ) {
      return;
    }

    clearThreadTimelineUnseenEvents(
      queryClient,
      threadId,
      latestTimeline.maxSeq,
    );
  }, [
    confirmedNotFound,
    enabled,
    isDocumentVisible,
    latestTimeline,
    queryClient,
    runtimeId,
    threadId,
  ]);

  useEffect(() => {
    if (
      !runtimeId ||
      verifiedRuntimeId !== runtimeId ||
      !origin ||
      notFound ||
      timelineNotFound ||
      !latestTimeline ||
      !latestTimelineQuery.isSuccess ||
      getThreadTimelineRuntimeId(queryClient, threadId) !== runtimeId
    ) {
      return;
    }

    discardPersistedThreadTimelineDisplayIfChanged({
      origin,
      response: latestTimeline,
      runtimeId,
      surfaceKey,
      threadId,
    });

    if (latestTimeline.delta === undefined) {
      schedulePersistedThreadTimelineDisplay({
        origin,
        response: latestTimeline,
        runtimeId,
        surfaceKey,
        threadId,
        queryClient,
      });
    }
  }, [
    latestTimeline,
    latestTimelineQuery.isSuccess,
    origin,
    queryClient,
    runtimeId,
    verifiedRuntimeId,
    surfaceKey,
    threadId,
    timelineNotFound,
    notFound,
  ]);

  const [isLoadingOlderTimelineRows, setIsLoadingOlderTimelineRows] =
    useState(false);

  const refetchLatestTimeline = latestTimelineQuery.refetch;

  useEffect(() => {
    const handlePageHide = () => {
      pageHiddenRef.current = true;
      setIsPageHidden(true);
      olderPageRequestRef.current?.controller.abort();
    };

    const handlePageShow = () => {
      pageHiddenRef.current = false;
      setIsPageHidden(false);
    };

    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);

    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
    };
  }, []);

  useEffect(
    () => () => {
      olderPageRequestRef.current?.controller.abort();
    },
    [enabled, historyGeneration, isDocumentVisible, surfaceKey, threadId],
  );

  const nextOlderCursor =
    loadedTimeline.surfaceKey === surfaceKey
      ? loadedTimeline.olderCursor
      : null;

  const hasOlderTimelineRows = nextOlderCursor !== null;

  const readOlderTimelinePage = useCallback(async (): Promise<void> => {
    const current = currentTrackerRef.current;
    const latestTimeline = current.latestTimeline;
    const nextOlderCursor = current.loaded.olderCursor;

    if (
      !enabled ||
      !isDocumentVisible ||
      isPageHidden ||
      pageHiddenRef.current ||
      olderPageRequestRef.current !== null ||
      !latestTimeline ||
      !nextOlderCursor ||
      !threadId
    ) {
      return;
    }

    const controller = new AbortController();

    const request: PendingOlderPageRequest = {
      controller,
      cursor: nextOlderCursor,
      historyGeneration: current.historyGeneration,
      runtimeId:
        verifiedRuntimeId ??
        runtimeId ??
        getThreadOpenRuntimeId(queryClient) ??
        getThreadTimelineRuntimeId(queryClient, threadId),
      surfaceKey,
      historySnapshot: current.loaded.historySnapshot,
    };

    olderPageRequestRef.current = request;
    setIsLoadingOlderTimelineRows(true);

    try {
      const currentRuntimeId =
        queryClient.getQueryData<string>(runtimeIdentityKey);

      if (
        controller.signal.aborted ||
        olderPageRequestRef.current !== request ||
        getThreadTimelineHistoryGeneration(queryClient, threadId) !==
          request.historyGeneration ||
        (request.runtimeId !== undefined &&
          currentRuntimeId !== undefined &&
          currentRuntimeId !== request.runtimeId)
      ) {
        return;
      }

      const response = await sdk.threads.timeline({
        beforeAnchorId: request.cursor.anchorId,
        beforeAnchorSeq: String(request.cursor.anchorSeq),
        deferContent: THREAD_TIMELINE_DEFER_CONTENT,
        segmentLimit: String(latestTimeline.timelinePage.segmentLimit),
        signal: controller.signal,
        threadId,
      });

      if (
        controller.signal.aborted ||
        olderPageRequestRef.current !== request ||
        getThreadTimelineHistoryGeneration(queryClient, threadId) !==
          request.historyGeneration ||
        (request.runtimeId !== undefined &&
          queryClient.getQueryData<string>(runtimeIdentityKey) !== undefined &&
          queryClient.getQueryData<string>(runtimeIdentityKey) !==
            request.runtimeId)
      ) {
        return;
      }

      updateLoadedTimeline((current) => {
        if (
          controller.signal.aborted ||
          (current.runtimeId !== undefined &&
            request.runtimeId !== undefined &&
            current.runtimeId !== request.runtimeId) ||
          current.historyGeneration !== request.historyGeneration ||
          current.loaded.surfaceKey !== request.surfaceKey ||
          !areTimelineHistorySnapshotsCompatible(
            current.loaded.historySnapshot,
            request.historySnapshot,
          ) ||
          !areTimelineHistorySnapshotsCompatible(
            current.loaded.historySnapshot,
            response.timelinePage.historySnapshot,
          ) ||
          !areTimelinePaginationCursorsEqual({
            left: current.loaded.olderCursor,
            right: request.cursor,
          }) ||
          getThreadTimelineHistoryGeneration(queryClient, threadId) !==
            request.historyGeneration
        ) {
          return current;
        }

        const ranges = prependMountedHistoryPage(
          current.ranges,
          mountedRangeFromPage(response, `older:${request.cursor.anchorId}`),
        );

        return {
          ...current,
          runtimeId: request.runtimeId ?? current.runtimeId,
          ...loadedFromMountedRanges(
            ranges,
            current.latestTimeline ?? latestTimeline,
            surfaceKey,
            prependOlderTimelineRows({
              olderRows: response.rows,
              loadedRows: current.loaded.rows,
            }),
          ),
        };
      });
    } catch (error) {
      if (
        controller.signal.aborted ||
        olderPageRequestRef.current !== request ||
        currentTrackerRef.current.historyGeneration !==
          request.historyGeneration ||
        getThreadTimelineHistoryGeneration(queryClient, threadId) !==
          request.historyGeneration
      ) {
        return;
      }

      if (
        !(error instanceof Error) ||
        !isStaleTimelinePaginationCursorError(error)
      ) {
        throw error;
      }

      const latestTimelineResult = await refetchLatestTimeline();

      if (
        controller.signal.aborted ||
        olderPageRequestRef.current !== request ||
        currentTrackerRef.current.historyGeneration !==
          request.historyGeneration ||
        getThreadTimelineHistoryGeneration(queryClient, threadId) !==
          request.historyGeneration
      ) {
        return;
      }

      const recoveredLatestTimeline =
        latestTimelineResult.data ?? latestTimeline;

      updateLoadedTimeline((current) => {
        if (
          controller.signal.aborted ||
          (current.runtimeId !== undefined &&
            request.runtimeId !== undefined &&
            current.runtimeId !== request.runtimeId) ||
          current.historyGeneration !== request.historyGeneration ||
          current.loaded.surfaceKey !== request.surfaceKey ||
          !areTimelinePaginationCursorsEqual({
            left: current.loaded.olderCursor,
            right: request.cursor,
          })
        ) {
          return current;
        }

        if (!recoveredLatestTimeline) {
          return {
            ...current,
            pages: [],
            ranges: [],
            loaded: { ...current.loaded, olderCursor: null },
          };
        }

        const loaded = recoverLoadedTimelineAfterStaleCursor({
          current: current.loaded,
          latestTimeline: recoveredLatestTimeline,
          surfaceKey: request.surfaceKey,
        });

        if (
          readTimelineHistoryIdentity(current.loaded.historySnapshot) !==
            null &&
          areTimelineHistorySnapshotsCompatible(
            current.loaded.historySnapshot,
            recoveredLatestTimeline.timelinePage.historySnapshot,
          )
        ) {
          const ranges = reconcileMountedHistory(
            current.ranges,
            recoveredLatestTimeline,
            current.loaded.latestWindowEndSequence,
          );

          const oldest = ranges[0];

          if (oldest)
            ranges[0] = { ...oldest, olderCursor: loaded.olderCursor };

          return {
            ...current,
            runtimeId: request.runtimeId ?? current.runtimeId,
            latestTimeline: recoveredLatestTimeline,
            ...loadedFromMountedRanges(
              ranges,
              recoveredLatestTimeline,
              request.surfaceKey,
            ),
          };
        }

        return {
          ...current,
          runtimeId: request.runtimeId ?? current.runtimeId,
          latestTimeline: recoveredLatestTimeline,
          loaded,
          pages: [latestTimelinePage(recoveredLatestTimeline)],
          ranges: [
            mountedRangeFromPage(
              recoveredLatestTimeline,
              `head:${recoveredLatestTimeline.maxSeq}`,
            ),
          ],
        };
      });
    } finally {
      if (olderPageRequestRef.current === request) {
        olderPageRequestRef.current = null;
        setIsLoadingOlderTimelineRows(false);
      }
    }
  }, [
    enabled,
    isDocumentVisible,
    isPageHidden,
    queryClient,
    runtimeIdentityKey,
    refetchLatestTimeline,
    runtimeId,
    verifiedRuntimeId,
    surfaceKey,
    threadId,
    updateLoadedTimeline,
  ]);

  const loadOlderTimelineRows = useCallback(
    () =>
      nextOlderCursor === null ? Promise.resolve() : readOlderTimelinePage(),
    [nextOlderCursor, readOlderTimelinePage],
  );

  const trackerRuntimeMatches =
    !runtimeChangePending &&
    (currentTracker.runtimeId === runtimeId ||
      (runtimeId === undefined &&
        currentTracker.runtimeId !== undefined &&
        currentTracker.runtimeId === knownRuntimeId) ||
      (currentTracker.runtimeId === undefined && runtimeId !== undefined));

  const cachedDisplay =
    !confirmedNotFound && persistedDisplay.threadId === threadId
      ? persistedDisplay.display
      : null;

  const timelineRows = confirmedNotFound
    ? NO_TIMELINE_ROWS
    : trackerRuntimeMatches &&
        loadedTimeline.surfaceKey === surfaceKey &&
        loadedTimeline.rows.length > 0
      ? loadedTimeline.rows
      : (latestTimeline?.rows ??
        (latestTimelineQuery.isLoadingError
          ? cachedDisplay?.rows
          : undefined) ??
        NO_TIMELINE_ROWS);

  const displayedMaxSeq = confirmedNotFound
    ? undefined
    : latestTimeline?.maxSeq;

  const displayedTimelineRows = useMemo(
    () =>
      displayedMaxSeq === undefined
        ? timelineRows
        : withPendingSentMessages({
            maxSeq: displayedMaxSeq,
            pending: pendingSentMessages,
            rows: timelineRows,
            threadId,
          }),
    [displayedMaxSeq, pendingSentMessages, threadId, timelineRows],
  );

  const hasDisplaySnapshot =
    !confirmedNotFound &&
    latestTimeline === undefined &&
    cachedDisplay !== null &&
    cachedDisplay.rows.length > 0;

  const hasResolvedTimeline = latestTimeline !== undefined;

  const timelineQueryState = useConnectionAwareQueryState({
    hasResolvedData: hasResolvedTimeline,
    isFetching: latestTimelineQuery.isFetching,
    isLoadingError: latestTimelineQuery.isLoadingError,
    isRecoverableLoadingError: isTransientReadError(latestTimelineQuery.error),
  });

  const failedFirstReadWithDisplay =
    hasDisplaySnapshot && latestTimelineQuery.isError && !timelineNotFound;

  const hasUnseenTimelineEvents = hasThreadTimelineUnseenEvents(
    queryClient,
    threadId,
  );

  const failedCatchUp =
    latestTimeline !== undefined &&
    hasUnseenTimelineEvents &&
    latestTimelineQuery.isError &&
    !latestTimelineQuery.isFetching;

  const timelineLoading =
    !confirmedNotFound &&
    !failedFirstReadWithDisplay &&
    (latestTimelineQuery.isLoading ||
      (!hasResolvedTimeline &&
        (timelineQueryState.status === "loading" ||
          latestTimelineQuery.isFetching)));

  const isCatchingUpTimeline =
    enabled &&
    latestTimelineQuery.isFetching &&
    !failedCatchUp &&
    ((hasUnseenTimelineEvents && latestTimeline !== undefined) ||
      hasDisplaySnapshot) &&
    displayedTimelineRows.length > 0;

  const timelineError = timelineNotFound
    ? latestTimelineQuery.error
    : failedFirstReadWithDisplay || failedCatchUp
      ? (latestTimelineQuery.error ?? null)
      : timelineLoading || timelineQueryState.status !== "unavailable"
        ? null
        : latestTimelineQuery.error;

  return {
    activePromptMode: latestTimeline?.activePromptMode ?? null,
    activeThinking: latestTimeline?.activeThinking ?? null,
    activeWorkflows: latestTimeline?.activeWorkflows ?? [],
    activeBackgroundCommands: latestTimeline?.activeBackgroundCommands ?? [],
    contextBoundarySeq:
      latestTimeline?.contextBoundarySeq ??
      cachedDisplay?.contextBoundarySeq ??
      null,
    contextWindowUsage: latestTimeline?.contextWindowUsage,
    goal: latestTimeline?.goal ?? null,
    providerCommands: latestTimeline?.providerCommands ?? null,
    sessionOptions: latestTimeline?.sessionOptions ?? null,
    modelFallback: latestTimeline?.modelFallback ?? null,
    hasPagedHistory: currentTracker.ranges[0]?.id.startsWith("older:") === true,
    hasOlderTimelineRows,
    isCatchingUpTimeline,
    isLoadingOlderTimelineRows,
    loadOlderTimelineRows,
    pendingTodos: latestTimeline?.pendingTodos ?? null,
    timelineError,
    timelineLoading,
    isReadOnlyDisplay: hasDisplaySnapshot,
    timelineRows: displayedTimelineRows,
    threadNotFound: confirmedNotFound,
  };
}

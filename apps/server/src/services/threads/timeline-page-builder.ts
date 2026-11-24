import { randomUUID } from "node:crypto";
import { captureProcessError } from "@omnyo/process-utils/error-reporting";
import type { Worker } from "node:worker_threads";
import {
  findThreadSearchMatches,
  getLatestThreadSequence,
  getThread,
  getThreadHistoryEpoch,
  type DbConnection,
  type ThreadSearchMatches,
} from "@omnyo/db";
import { ApiError } from "../../errors.js";
import {
  buildThreadTimelineWithProfile,
  buildTimelineTurnSummaryDetails,
  loadThreadConversationOutline,
  resolveConversationHistorySequenceStart,
  buildThreadConversationOutlineProjectionKey,
  threadTimelineBuildIdentity,
  type BuildThreadTimelineOptions,
  type BuildTimelineTurnSummaryDetailsOptions,
} from "./timeline.js";
import {
  timelineWorkerMessageSchema,
  type TimelineWorkerRequest,
  type TimelineWorkerResult,
  type OutlineWorkerResult,
  type OutlineBuildOptions,
  type TurnDetailsWorkerResult,
  type EventsBuildOptions,
  type EventsWorkerResult,
} from "./timeline-worker-contract.js";

import {
  ensureHistoryCache,
  persistHistoryCache,
  closeHistoryCacheWriter,
  startTimelineWorker,
} from "./history-cache-writer.js";
import {
  historyRedactionLimitError,
  redactThreadHistory,
  redactThreadHistoryEvent,
} from "./thread-history-redaction.js";
import { listThreadEventRows } from "./thread-data.js";
import { truncateTimelineResponseOutputs } from "./timeline-output-truncation.js";
import { previewTimelineResponseOutputs } from "./timeline-output-preview.js";

type BuildResult =
  | TimelineWorkerResult
  | OutlineWorkerResult
  | TurnDetailsWorkerResult
  | EventsWorkerResult
  | ThreadSearchMatches;

type Priority = "foreground" | "background";

type LaneName = Priority | "search";

interface Subscriber {
  resolve: (result: BuildResult) => void;
  reject: (error: Error) => void;
  dispose: () => void;
}

interface Job {
  queuedAt: number;
  startedAt: number | null;
  key: string;
  baseKey: string;
  lane: LaneName;
  request: TimelineWorkerRequest;
  subscribers: Set<Subscriber>;
}

interface WorkerSlot {
  lane: LaneName;
  worker: Worker | null;
  active: Job | null;
  activeTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  retiring: Promise<number> | null;
}

interface Lane {
  slots: WorkerSlot[];
  queue: Job[];
}

interface PageBuilder {
  build(args: BuildArgs): Promise<BuildResult>;
  search(args: FindThreadSearchMatchesArgs): Promise<BuildResult>;
  invalidate(threadId: string): void;
  close(): Promise<void>;
}

interface FindThreadSearchMatchesArgs {
  query: string;
  limitPerGroup: number;
  signal?: AbortSignal;
}

interface BuildThreadOutlineArgs {
  kind: "outline";
  threadId: string;
  options: OutlineBuildOptions;
  signal?: AbortSignal;
  priority?: Priority;
}

interface BuildTurnDetailsArgs {
  kind: "turn-details";
  threadId: string;
  options: BuildTimelineTurnSummaryDetailsOptions;
  signal?: AbortSignal;
  priority?: Priority;
}

interface BuildEventsArgs {
  kind: "events";
  threadId: string;
  options: EventsBuildOptions;
  signal?: AbortSignal;
  priority?: Priority;
}

type BuildArgs =
  | (BuildThreadTimelinePageArgs & { kind: "timeline" })
  | BuildThreadOutlineArgs
  | BuildTurnDetailsArgs
  | BuildEventsArgs;

interface BuildThreadTimelinePageArgs {
  threadId: string;
  options: BuildThreadTimelineOptions;
  signal?: AbortSignal;
  priority?: Priority;
}

const builders = new WeakMap<DbConnection, PageBuilder>();

const MAX_QUEUED_JOBS = 32;

const IDLE_MS = 30_000;

const ACTIVE_JOB_MS = 60_000;

function unavailable(): ApiError {
  return new ApiError(
    503,
    "timeline_unavailable",
    "Chat could not load. Try again.",
    true,
  );
}

function searchUnavailable(): ApiError {
  return new ApiError(
    503,
    "search_unavailable",
    "Search could not finish. Try again.",
    true,
  );
}

function requestThreadId(request: TimelineWorkerRequest): string | null {
  return request.kind === "search" ? null : request.threadId;
}

function workerError(
  status: 400 | 404 | 413 | 503,
  message?: string,
): ApiError {
  if (status === 400)
    return new ApiError(
      400,
      "invalid_request",
      message ??
        "Timeline pagination cursor is no longer available; reload the latest page",
    );

  if (status === 404)
    return new ApiError(404, "not_found", "Chat is unavailable");

  if (status === 413)
    return new ApiError(
      413,
      "timeline_too_large",
      "This chat page is too large to load",
    );

  return unavailable();
}

function createPageBuilder(db: DbConnection): PageBuilder {
  const jobs = new Map<string, Job>();

  const lane = (name: LaneName, capacity: number): Lane => ({
    slots: Array.from({ length: capacity }, () => ({
      lane: name,
      worker: null,
      active: null,
      activeTimer: null,
      idleTimer: null,
      retiring: null,
    })),
    queue: [],
  });

  const lanes: Record<LaneName, Lane> = {
    foreground: lane("foreground", 2),
    background: lane("background", 1),
    search: lane("search", 1),
  };

  let closed = false;

  function activeSlot(job: Job) {
    return lanes[job.lane].slots.find((slot) => slot.active === job);
  }

  function finish(job: Job, result: BuildResult | Error) {
    jobs.delete(job.key);

    if (
      !(result instanceof Error) &&
      "profile" in result &&
      job.startedAt !== null
    )
      result.profile.workerQueueWaitMs = Math.max(
        0,
        Math.round(job.startedAt - job.queuedAt),
      );

    for (const subscriber of job.subscribers) {
      subscriber.dispose();

      if (result instanceof Error) subscriber.reject(result);
      else subscriber.resolve(result);
    }

    job.subscribers.clear();
  }

  function retire(owner: WorkerSlot) {
    if (owner.activeTimer !== null) clearTimeout(owner.activeTimer);
    owner.activeTimer = null;

    if (owner.idleTimer !== null) clearTimeout(owner.idleTimer);
    owner.idleTimer = null;
    const worker = owner.worker;
    owner.worker = null;

    if (worker === null && owner.retiring !== null) return;
    owner.retiring = worker?.terminate() ?? Promise.resolve(0);
    void owner.retiring.finally(() => {
      owner.retiring = null;
      drain(lanes[owner.lane]);
    });
  }

  function fail(owner: WorkerSlot) {
    const active = owner.active;
    owner.active = null;

    if (active !== null) finish(active, unavailable());

    retire(owner);
  }

  function drain(queue: Lane) {
    for (const slot of queue.slots) drainSlot(slot, queue);
  }

  function drainSlot(owner: WorkerSlot, queue: Lane) {
    if (closed || owner.active !== null || owner.retiring !== null) return;

    if (owner.idleTimer !== null) clearTimeout(owner.idleTimer);
    owner.idleTimer = null;

    const next = queue.queue.findIndex((job) => {
      const threadId = requestThreadId(job.request);

      return (
        threadId === null ||
        queue.slots.every(
          (slot) =>
            slot.active === null ||
            requestThreadId(slot.active.request) !== threadId,
        )
      );
    });

    const job = next < 0 ? undefined : queue.queue.splice(next, 1)[0];

    if (job === undefined) {
      owner.worker?.unref();

      if (owner.worker !== null) {
        owner.idleTimer = setTimeout(() => retire(owner), IDLE_MS);
        owner.idleTimer.unref();
      }

      return;
    }

    owner.active = job;
    job.startedAt = performance.now();

    if (owner.worker === null) {
      let worker: Worker;

      try {
        worker = startTimelineWorker(db.$client.name, "read");
      } catch {
        fail(owner);

        return;
      }

      owner.worker = worker;
      worker.on("error", () => {
        if (owner.worker === worker) fail(owner);
      });
      worker.on("exit", () => {
        if (owner.worker === worker) fail(owner);
      });
      worker.on("message", async (message) => {
        if (owner.worker !== worker) return;
        const parsed = timelineWorkerMessageSchema.safeParse(message);
        const current = owner.active;

        if (
          !parsed.success ||
          current === null ||
          parsed.data.id !== current.request.id
        ) {
          fail(owner);

          return;
        }

        try {
          const cacheWrite =
            parsed.data.type === "result" ||
            parsed.data.type === "outline-result"
              ? parsed.data.cacheWrite
              : undefined;

          const cacheTouches =
            parsed.data.type === "result" ||
            parsed.data.type === "outline-result"
              ? parsed.data.cacheTouches
              : undefined;

          const cacheAdmissions =
            cacheWrite === undefined
              ? []
              : await persistHistoryCache(db, cacheWrite);

          if (owner.active !== current) return;

          if (owner.activeTimer !== null) clearTimeout(owner.activeTimer);
          owner.activeTimer = null;

          if (
            parsed.data.type === "error" &&
            parsed.data.projectionFailure !== undefined
          ) {
            const error = new Error(
              "Timeline projection is missing turn/started",
            );

            if (parsed.data.projectionFailure.stack !== undefined)
              error.stack = parsed.data.projectionFailure.stack;
            captureProcessError(error, {
              level: "error",
              stage: "request",
              diagnostic: parsed.data.projectionFailure.diagnostic,
            });
          }

          owner.active = null;
          finish(
            current,
            parsed.data.type === "error"
              ? current.request.kind === "events" && parsed.data.status === 413
                ? historyRedactionLimitError()
                : workerError(
                    parsed.data.status,
                    current.request.kind === "turn-details"
                      ? parsed.data.message
                      : undefined,
                  )
              : parsed.data.type === "search-result"
                ? parsed.data.result
                : {
                    ...parsed.data.result,
                    cacheAdmissions,
                    cacheTouches,
                  },
          );
          drain(queue);
        } catch {
          if (owner.active === current) fail(owner);
        }
      });
    }

    const worker = owner.worker;

    owner.activeTimer = setTimeout(() => {
      if (owner.worker === worker && owner.active === job) fail(owner);
    }, ACTIVE_JOB_MS);
    owner.activeTimer.unref();
    worker.ref();

    try {
      worker.postMessage(job.request);
    } catch {
      fail(owner);
    }
  }

  function cancel(job: Job, subscriber: Subscriber) {
    if (!job.subscribers.delete(subscriber)) return;
    subscriber.dispose();
    subscriber.reject(new DOMException("Loading canceled", "AbortError"));

    if (job.subscribers.size > 0) return;
    jobs.delete(job.key);
    const queue = lanes[job.lane];
    const owner = activeSlot(job);

    if (owner !== undefined) {
      if (job.request.kind === "search") return;
      owner.active = null;
      retire(owner);
    } else {
      queue.queue = queue.queue.filter((queued) => queued !== job);
    }
  }

  function subscribe(job: Job, signal?: AbortSignal): Promise<BuildResult> {
    return new Promise<BuildResult>((resolve, reject) => {
      const abort = () => cancel(job, subscriber);

      const subscriber: Subscriber = {
        resolve,
        reject,
        dispose: () => signal?.removeEventListener("abort", abort),
      };

      job.subscribers.add(subscriber);
      signal?.addEventListener("abort", abort, { once: true });

      if (signal?.aborted) abort();
      else drain(lanes[job.lane]);
    });
  }

  return {
    invalidate(threadId) {
      for (const job of [...jobs.values()]) {
        if (
          job.request.kind === "events" ||
          requestThreadId(job.request) !== threadId
        )
          continue;
        const queue = lanes[job.lane];
        const owner = activeSlot(job);

        if (owner !== undefined) {
          owner.active = null;
          retire(owner);
        } else queue.queue = queue.queue.filter((queued) => queued !== job);
        finish(job, unavailable());
      }
    },
    build(args) {
      if (closed) return Promise.reject(unavailable());

      if (args.signal?.aborted)
        return Promise.reject(
          new DOMException("Loading canceled", "AbortError"),
        );
      const thread = getThread(db, args.threadId);

      if (thread === null || thread.deletedAt !== null)
        return Promise.reject(workerError(404));

      const identity =
        args.kind === "timeline"
          ? threadTimelineBuildIdentity(db, thread, args.options)
          : args.kind === "outline"
            ? buildThreadConversationOutlineProjectionKey(
                thread,
                0,
                args.options,
              )
            : null;

      const baseKey = JSON.stringify([
        args.kind,
        args.threadId,
        identity,
        getThreadHistoryEpoch(db, args.threadId),
        { ...args.options, maxSeq: undefined },
      ]);

      const key = `${baseKey}|${getLatestThreadSequence(db, { threadId: args.threadId })}`;
      const priority = args.priority ?? "foreground";

      let job =
        jobs.get(key) ??
        [...jobs.values()].find(
          (candidate) =>
            candidate.baseKey === baseKey &&
            activeSlot(candidate) === undefined,
        );

      if (job === undefined) {
        if (lanes[priority].queue.length >= MAX_QUEUED_JOBS)
          return Promise.reject(unavailable());
        job = {
          key,
          baseKey,
          lane: priority,
          request:
            args.kind === "timeline"
              ? {
                  kind: "timeline",
                  id: randomUUID(),
                  threadId: args.threadId,
                  options: args.options,
                }
              : args.kind === "outline"
                ? {
                    kind: "outline",
                    id: randomUUID(),
                    threadId: args.threadId,
                    options: args.options,
                  }
                : args.kind === "turn-details"
                  ? {
                      kind: "turn-details",
                      id: randomUUID(),
                      threadId: args.threadId,
                      options: args.options,
                    }
                  : {
                      kind: "events",
                      id: randomUUID(),
                      threadId: args.threadId,
                      options: args.options,
                    },
          subscribers: new Set(),
          queuedAt: performance.now(),
          startedAt: null,
        };
        jobs.set(key, job);
        lanes[priority].queue.push(job);
      } else if (
        priority === "foreground" &&
        job.lane === "background" &&
        activeSlot(job) === undefined
      ) {
        if (lanes.foreground.queue.length >= MAX_QUEUED_JOBS)
          return Promise.reject(unavailable());

        lanes.background.queue = lanes.background.queue.filter(
          (queued) => queued !== job,
        );
        job.lane = "foreground";
        lanes.foreground.queue.unshift(job);
      }

      return subscribe(job, args.signal);
    },
    search(args) {
      if (closed) return Promise.reject(unavailable());

      if (args.signal?.aborted)
        return Promise.reject(
          new DOMException("Loading canceled", "AbortError"),
        );
      const key = JSON.stringify(["search", args.query, args.limitPerGroup]);
      let job = jobs.get(key);

      if (job === undefined) {
        if (lanes.search.queue.length >= MAX_QUEUED_JOBS)
          return Promise.reject(unavailable());
        job = {
          key,
          baseKey: key,
          lane: "search",
          request: {
            kind: "search",
            id: randomUUID(),
            query: args.query,
            limitPerGroup: args.limitPerGroup,
          },
          subscribers: new Set(),
          queuedAt: performance.now(),
          startedAt: null,
        };
        jobs.set(key, job);
        lanes.search.queue.push(job);
      }

      return subscribe(job, args.signal);
    },
    async close() {
      closed = true;

      for (const job of [...jobs.values()]) finish(job, unavailable());

      for (const queue of Object.values(lanes)) {
        queue.queue = [];

        for (const owner of queue.slots) {
          owner.active = null;
          retire(owner);
        }
      }

      await Promise.all(
        Object.values(lanes).flatMap((queue) =>
          queue.slots.map((owner) => owner.retiring),
        ),
      );
    },
  };
}

export async function buildThreadTimelinePage(
  db: DbConnection,
  args: BuildThreadTimelinePageArgs,
): Promise<TimelineWorkerResult> {
  if (args.signal?.aborted)
    throw new DOMException("Loading canceled", "AbortError");

  if (db.$client.memory) {
    return db.transaction(() => {
      const thread = getThread(db, args.threadId);

      if (thread === null || thread.deletedAt !== null) throw workerError(404);

      const options = {
        ...args.options,
        maxSeq:
          args.options.page.kind === "latest"
            ? getLatestThreadSequence(db, { threadId: thread.id })
            : args.options.maxSeq,
      };

      const { completedRootProjections: _projections, ...timeline } =
        buildThreadTimelineWithProfile(db, thread, options);

      const truncated =
        options.maxInlineOutputChars === null
          ? timeline.response
          : truncateTimelineResponseOutputs(
              timeline.response,
              options.maxInlineOutputChars,
            );

      const response = redactThreadHistory(
        db,
        thread.id,
        options.includeNestedRows
          ? truncated
          : previewTimelineResponseOutputs(truncated),
        { invalidJsonText: "withhold" },
      );

      return {
        ...timeline,
        response,
        completedRootRecords: [],
        threadIdentity: threadTimelineBuildIdentity(db, thread, options),
        historyEpoch: getThreadHistoryEpoch(db, thread.id),
        workerThreadId: null,
        fromCache: false,
      };
    });
  }

  let builder = builders.get(db);

  if (builder === undefined) {
    builder = createPageBuilder(db);
    builders.set(db, builder);
  }

  await ensureHistoryCache(db);
  const result = await builder.build({ ...args, kind: "timeline" });

  if (!("response" in result)) throw unavailable();

  return result;
}

export async function buildThreadConversationOutlinePage(
  db: DbConnection,
  args: Omit<BuildThreadOutlineArgs, "kind">,
): Promise<OutlineWorkerResult> {
  if (args.signal?.aborted)
    throw new DOMException("Loading canceled", "AbortError");

  if (db.$client.memory) {
    const thread = getThread(db, args.threadId);

    if (thread === null || thread.deletedAt !== null) throw workerError(404);

    const options = {
      ...args.options,
      maxSeq: getLatestThreadSequence(db, { threadId: thread.id }),
    };

    const response = loadThreadConversationOutline(db, thread, options);

    const sanitized = redactThreadHistory(db, thread.id, {
      ...response,
      items:
        options.role === undefined
          ? response.items
          : response.items.filter((item) => item.role === options.role),
    });

    return {
      body: JSON.stringify(sanitized),
      maxSeq: options.maxSeq,
      historySequenceStart: resolveConversationHistorySequenceStart(
        db,
        thread,
        options,
      ),
      historyEpoch: getThreadHistoryEpoch(db, thread.id),
      threadIdentity: buildThreadConversationOutlineProjectionKey(
        thread,
        0,
        options,
      ),
      workerThreadId: null,
    };
  }

  await ensureHistoryCache(db);
  let builder = builders.get(db);

  if (builder === undefined) {
    builder = createPageBuilder(db);
    builders.set(db, builder);
  }

  const result = await builder.build({ ...args, kind: "outline" });

  if (!("historySequenceStart" in result)) throw unavailable();

  return result;
}

export async function loadTimelineTurnSummaryDetails(
  db: DbConnection,
  args: {
    threadId: string;
    options: BuildTimelineTurnSummaryDetailsOptions;
    signal?: AbortSignal;
  },
): Promise<TurnDetailsWorkerResult> {
  if (args.signal?.aborted)
    throw new DOMException("Loading canceled", "AbortError");

  if (db.$client.memory) {
    const thread = getThread(db, args.threadId);

    if (thread === null || thread.deletedAt !== null) throw workerError(404);

    return {
      body: JSON.stringify(
        redactThreadHistory(
          db,
          thread.id,
          buildTimelineTurnSummaryDetails(db, thread, args.options),
          { invalidJsonText: "withhold" },
        ),
      ),
    };
  }

  await ensureHistoryCache(db);
  let builder = builders.get(db);

  if (builder === undefined) {
    builder = createPageBuilder(db);
    builders.set(db, builder);
  }

  const result = await builder.build({ ...args, kind: "turn-details" });

  if (!("body" in result)) throw unavailable();

  return result;
}

export async function loadThreadEventListBody(
  db: DbConnection,
  args: {
    threadId: string;
    options: EventsBuildOptions;
    signal?: AbortSignal;
  },
): Promise<EventsWorkerResult> {
  if (args.signal?.aborted)
    throw new DOMException("Loading canceled", "AbortError");

  if (db.$client.memory)
    return {
      body: JSON.stringify(
        redactThreadHistory(
          db,
          args.threadId,
          listThreadEventRows(db, {
            threadId: args.threadId,
            ...args.options,
          }).map(redactThreadHistoryEvent),
          { invalidJsonText: "withhold" },
        ),
      ),
    };

  await ensureHistoryCache(db);
  let builder = builders.get(db);

  if (builder === undefined) {
    builder = createPageBuilder(db);
    builders.set(db, builder);
  }

  const result = await builder.build({
    ...args,
    kind: "events",
    priority: "background",
  });

  if (!("body" in result)) throw unavailable();

  return result;
}

export async function findThreadSearchMatchesInWorker(
  db: DbConnection,
  args: FindThreadSearchMatchesArgs,
): Promise<ThreadSearchMatches> {
  if (args.signal?.aborted)
    throw new DOMException("Loading canceled", "AbortError");

  if (db.$client.memory)
    return findThreadSearchMatches(db, {
      query: args.query,
      limitPerGroup: args.limitPerGroup,
    });

  await ensureHistoryCache(db);
  let builder = builders.get(db);

  if (builder === undefined) {
    builder = createPageBuilder(db);
    builders.set(db, builder);
  }

  const result = await builder.search(args).catch((error: unknown) => {
    throw error instanceof ApiError && error.status === 503
      ? searchUnavailable()
      : error;
  });

  if (!("active" in result)) throw searchUnavailable();

  return result;
}

export async function closeThreadTimelinePageBuilders(
  db: DbConnection,
): Promise<void> {
  const builder = builders.get(db);
  builders.delete(db);
  await builder?.close();
  await closeHistoryCacheWriter(db);
}

export function invalidateThreadHistoryBuilders(
  db: DbConnection,
  threadId: string,
): void {
  builders.get(db)?.invalidate(threadId);
}

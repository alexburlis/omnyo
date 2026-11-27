import type { ThreadEvent } from "@omnyo/domain";
import type {
  HostDaemonEventBatchResponse,
  HostDaemonEventEnvelope,
  HostDaemonRejectedEvent,
} from "@omnyo/host-daemon-contract";
import { normalizeCaughtError, runtimeErrorLogFields } from "./error-utils.js";
import type { HostDaemonLogger } from "./logger.js";
import { ServerResponseError } from "./server-client.js";
import {
  waitForUpdateCheckpoint,
  type PendingDeliveryEvent,
} from "./update-delivery-checkpoint.js";

const DEFAULT_DEBOUNCE_MS = 100;

const INITIAL_RETRY_DELAY_MS = 1_000;

const MAX_RETRY_DELAY_MS = 30_000;

const QUEUE_DEPTH_WARN_THRESHOLD = 512;

const QUEUE_DEPTH_WARN_MIN_AGE_MS = 5_000;

const QUEUE_AGE_WARN_THRESHOLD_MS = 30_000;

const MAX_EVENTS_PER_POST = 100;

const SLOW_UPLOAD_WARN_THRESHOLD_MS = 1_000;

const SLOW_UPLOAD_WARN_INTERVAL_MS = 60_000;

export interface EventSinkInput {
  event: ThreadEvent;
  threadId: string;
}

export interface EventPostResult {
  acceptedEvents: HostDaemonEventBatchResponse["acceptedEvents"];
  rejectedEvents: HostDaemonEventBatchResponse["rejectedEvents"];
  duplicateEvents?: HostDaemonEventBatchResponse["duplicateEvents"];
  serverTiming?: string;
}

export interface EventPostBatch {
  events: HostDaemonEventEnvelope[];
  firstEventIndex: number;
  sourceInstanceId?: string;
}

export interface CreateEventSinkOptions {
  instanceId: string;
  initialEvents?: readonly PendingDeliveryEvent[];
  onAcknowledged?: (events: readonly PendingDeliveryEvent[]) => Promise<void>;
  onRejected?: (
    events: readonly PendingDeliveryEvent[],
  ) => Promise<readonly PendingDeliveryEvent[]>;
  isSessionOpen: () => boolean;
  logger: Pick<HostDaemonLogger, "debug" | "error" | "warn">;
  now?: () => number;
  postEvents: (
    batch: EventPostBatch,
    signal?: AbortSignal,
  ) => Promise<EventPostResult>;
}

export interface EventSink {
  emit(event: EventSinkInput): void;
  flush(): Promise<void>;
  markThrough(): number;
  pendingEvents(): PendingDeliveryEvent[];
  pauseForUpdate(signal: AbortSignal): Promise<void>;
  resume(): void;
  listUndeliveredThreadIds(): string[];
  dispose(): Promise<void>;
}

interface RejectedEventSummary {
  eventIndex: number;
  reason: HostDaemonRejectedEvent["reason"];
  threadId: string;
}

export class EventSinkDisposedError extends Error {
  constructor() {
    super("Cannot emit to disposed event sink");
    this.name = "EventSinkDisposedError";
  }
}

function isWaitingForApprovalItemEvent(event: ThreadEvent): boolean {
  if (event.type !== "item/started" && event.type !== "item/completed") {
    return false;
  }

  if (
    event.item.type !== "commandExecution" &&
    event.item.type !== "fileChange"
  ) {
    return false;
  }

  return event.item.approvalStatus === "waiting_for_approval";
}

function shouldFlushThreadEventImmediately(event: ThreadEvent): boolean {
  if (event.type === "turn/started" || event.type === "item/completed") {
    return true;
  }

  if (
    event.type === "turn/completed" ||
    event.type === "system/error" ||
    event.type === "system/thread/interrupted"
  ) {
    return true;
  }

  if (event.type === "provider/error") {
    return event.willRetry !== true;
  }

  return isWaitingForApprovalItemEvent(event);
}

function isPermanentPostRejection(error: Error): boolean {
  return (
    error instanceof ServerResponseError &&
    !error.retryable &&
    error.code === "invalid_request"
  );
}

function summarizeRejectedEvents(
  events: readonly HostDaemonRejectedEvent[],
): RejectedEventSummary[] {
  return events.map((event) => ({
    eventIndex: event.eventIndex,
    reason: event.reason,
    threadId: event.threadId,
  }));
}

function parseEventServerTiming(header: string | undefined) {
  if (header === undefined || header.length > 512) return null;

  let eventLock: number | undefined;
  let eventTx: number | undefined;
  let eventAfter: number | undefined;

  for (const metric of header.split(",")) {
    const match =
      /^\s*(event_lock|event_tx|event_after);dur=(\d+(?:\.\d+)?)\s*$/.exec(
        metric,
      );

    if (match === null) return null;
    const duration = Number(match[2]);

    if (!Number.isFinite(duration) || duration > 30_000) return null;

    switch (match[1]) {
      case "event_lock":
        if (eventLock !== undefined) return null;
        eventLock = duration;
        break;
      case "event_tx":
        if (eventTx !== undefined) return null;
        eventTx = duration;
        break;
      case "event_after":
        if (eventAfter !== undefined) return null;
        eventAfter = duration;
        break;
    }
  }

  return eventLock === undefined ||
    eventTx === undefined ||
    eventAfter === undefined
    ? null
    : { event_lock: eventLock, event_tx: eventTx, event_after: eventAfter };
}

export function createEventSink(options: CreateEventSinkOptions): EventSink {
  const now = options.now ?? (() => Date.now());

  const queue: PendingDeliveryEvent[] = (options.initialEvents ?? []).map(
    (event) => ({ ...event }),
  );

  const enqueuedAt = new WeakMap<PendingDeliveryEvent, number>();

  let lastEventIndex = queue.reduce(
    (last, event) =>
      event.instanceId === options.instanceId
        ? Math.max(last, event.index)
        : last,
    0,
  );

  let paused = false;
  let deliveryAbort: AbortController | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushPromise: Promise<void> | null = null;
  let disposed = false;
  let backedUpSinceMs: number | null = queue.length === 0 ? null : now();
  let backpressureLogged = false;
  let retryDelayMs = INITIAL_RETRY_DELAY_MS;
  let nextSlowUploadWarningAt = -Infinity;

  function maybeLogQueuePressure(): void {
    if (backpressureLogged || backedUpSinceMs === null) {
      return;
    }

    const queueDepth = queue.length;
    const queueAgeMs = now() - backedUpSinceMs;

    if (
      queueAgeMs < QUEUE_AGE_WARN_THRESHOLD_MS &&
      (queueDepth < QUEUE_DEPTH_WARN_THRESHOLD ||
        queueAgeMs < QUEUE_DEPTH_WARN_MIN_AGE_MS)
    ) {
      return;
    }

    backpressureLogged = true;
    options.logger.warn(
      {
        queueDepth,
        queueAgeMs,
        oldestEventAgeMs:
          queue[0] === undefined || !enqueuedAt.has(queue[0])
            ? null
            : Math.max(0, now() - enqueuedAt.get(queue[0])!),
      },
      "Daemon event queue is backing up; delivery may be stalled",
    );
  }

  function clearScheduledFlush(): void {
    if (flushTimer === null) {
      return;
    }

    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function scheduleFlush(delayMs: number): void {
    if (
      disposed ||
      paused ||
      flushPromise !== null ||
      !queue.some((entry) => entry.blockedReason === null)
    ) {
      return;
    }

    if (flushTimer !== null) {
      if (delayMs > 0 || retryDelayMs > INITIAL_RETRY_DELAY_MS) {
        return;
      }

      clearScheduledFlush();
    }

    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error) => {
        options.logger.error(
          runtimeErrorLogFields(normalizeCaughtError(error)),
          "Daemon event delivery failed",
        );
      });
    }, delayMs);
  }

  async function retainRejected(
    entries: readonly PendingDeliveryEvent[],
    reason: NonNullable<PendingDeliveryEvent["blockedReason"]>,
  ): Promise<number> {
    const rejected = entries.map((entry) => ({
      ...entry,
      blockedReason: reason,
    }));

    const retained = (await options.onRejected?.(rejected)) ?? [];

    const retainedKeys = new Set(
      retained.map((entry) => JSON.stringify([entry.instanceId, entry.index])),
    );

    const dropped: PendingDeliveryEvent[] = [];

    for (const entry of entries) {
      if (retainedKeys.has(JSON.stringify([entry.instanceId, entry.index]))) {
        entry.blockedReason = reason;
      } else {
        dropped.push(entry);
      }
    }

    await acknowledge(dropped);

    return entries.length - dropped.length;
  }

  async function acknowledge(
    entries: readonly PendingDeliveryEvent[],
  ): Promise<void> {
    if (entries.length === 0) return;
    await options.onAcknowledged?.(entries);
    const acknowledged = new Set(entries);

    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index];

      if (entry !== undefined && acknowledged.has(entry))
        queue.splice(index, 1);
    }
  }

  async function deliverBatch(
    batch: readonly PendingDeliveryEvent[],
  ): Promise<number> {
    const [first] = batch;

    if (first === undefined) return 0;
    let response: EventPostResult;
    const startedAt = performance.now();
    const firstEnqueuedAt = enqueuedAt.get(first);

    const oldestEventAgeMs =
      firstEnqueuedAt === undefined
        ? undefined
        : Math.max(0, now() - firstEnqueuedAt);

    try {
      response = await options.postEvents(
        {
          events: batch.map((entry) => entry.envelope),
          firstEventIndex: first.index,
          ...(first.instanceId === options.instanceId
            ? {}
            : { sourceInstanceId: first.instanceId }),
        },
        deliveryAbort?.signal,
      );
    } catch (error) {
      const normalized = normalizeCaughtError(error);

      if (!isPermanentPostRejection(normalized)) {
        options.logger.error(
          {
            ...runtimeErrorLogFields(normalized),
            batchSize: batch.length,
            elapsedMs: Math.max(0, performance.now() - startedAt),
          },
          "Failed to post daemon events; keeping events queued for retry",
        );

        return 0;
      }

      if (batch.length === 1) {
        const retained = await retainRejected(batch, "invalid_request");
        options.logger.error(
          {
            ...runtimeErrorLogFields(normalized),
            eventType: first.envelope.event.type,
            threadId: first.envelope.threadId,
          },
          retained === 0
            ? "Dropped a daemon event the server will never accept"
            : "Retained a checkpointed daemon event the server rejected",
        );

        return 1;
      }

      const midpoint = Math.floor(batch.length / 2);
      const processed = await deliverBatch(batch.slice(0, midpoint));

      if (processed < midpoint || paused) return processed;

      return midpoint + (await deliverBatch(batch.slice(midpoint)));
    }

    const postedAt = performance.now();
    const httpMs = postedAt - startedAt;

    const rejectedIndexes = new Set(
      response.rejectedEvents.map((entry) => entry.eventIndex),
    );

    if (response.rejectedEvents.length > 0) {
      const rejected = batch.filter((_, index) => rejectedIndexes.has(index));

      const retained = await retainRejected(
        rejected,
        "thread_not_owned_by_host",
      );

      options.logger.warn(
        {
          rejectedEvents: summarizeRejectedEvents(response.rejectedEvents),
          retainedCheckpointEvents: retained,
          droppedOrdinaryEvents: rejected.length - retained,
        },
        "Server rejected daemon events",
      );
    }

    await acknowledge(batch.filter((_, index) => !rejectedIndexes.has(index)));

    const acknowledgedAt = performance.now();
    const localAckMs = acknowledgedAt - postedAt;

    if (
      acknowledgedAt >= nextSlowUploadWarningAt &&
      ((oldestEventAgeMs !== undefined &&
        oldestEventAgeMs >= SLOW_UPLOAD_WARN_THRESHOLD_MS) ||
        httpMs >= SLOW_UPLOAD_WARN_THRESHOLD_MS ||
        localAckMs >= SLOW_UPLOAD_WARN_THRESHOLD_MS)
    ) {
      nextSlowUploadWarningAt = acknowledgedAt + SLOW_UPLOAD_WARN_INTERVAL_MS;
      const phases = parseEventServerTiming(response.serverTiming);
      options.logger.warn(
        {
          batchSize: batch.length,
          ...(oldestEventAgeMs === undefined ? {} : { oldestEventAgeMs }),
          httpMs,
          localAckMs,
          ...(phases === null ? {} : { phases }),
        },
        "Slow daemon event upload",
      );
    }

    return batch.length;
  }

  async function drainQueue(): Promise<void> {
    while (!disposed && !paused && options.isSessionOpen()) {
      const first = queue.find((entry) => entry.blockedReason === null);

      if (first === undefined) return;
      const batch: PendingDeliveryEvent[] = [];

      for (const entry of queue.slice(queue.indexOf(first))) {
        if (
          entry.blockedReason !== null ||
          entry.instanceId !== first.instanceId ||
          entry.index !== first.index + batch.length ||
          batch.length === MAX_EVENTS_PER_POST
        )
          break;
        batch.push(entry);
      }

      const processed = await deliverBatch(batch);

      if (queue.length === 0) {
        backedUpSinceMs = null;
        backpressureLogged = false;
        retryDelayMs = INITIAL_RETRY_DELAY_MS;
      }

      if (processed < batch.length) return;
    }
  }

  async function flush(): Promise<void> {
    clearScheduledFlush();

    if (paused || disposed) return;

    if (flushPromise !== null) {
      await flushPromise;

      return;
    }

    deliveryAbort = new AbortController();
    flushPromise = drainQueue();

    try {
      await flushPromise;
    } finally {
      flushPromise = null;
      deliveryAbort = null;

      if (
        !disposed &&
        !paused &&
        queue.some((entry) => entry.blockedReason === null) &&
        options.isSessionOpen()
      ) {
        const delayMs = Math.floor(retryDelayMs * (0.5 + Math.random() * 0.5));
        retryDelayMs = Math.min(retryDelayMs * 2, MAX_RETRY_DELAY_MS);
        scheduleFlush(delayMs);
      }
    }
  }

  return {
    emit(input): void {
      if (disposed) {
        throw new EventSinkDisposedError();
      }

      if (backedUpSinceMs === null) {
        backedUpSinceMs = now();
      }

      lastEventIndex += 1;

      const pending: PendingDeliveryEvent = {
        envelope: { threadId: input.threadId, event: input.event },
        instanceId: options.instanceId,
        index: lastEventIndex,
        blockedReason: null,
      };

      enqueuedAt.set(pending, now());
      queue.push(pending);
      maybeLogQueuePressure();
      scheduleFlush(
        shouldFlushThreadEventImmediately(input.event)
          ? 0
          : DEFAULT_DEBOUNCE_MS,
      );
    },
    flush,
    markThrough(): number {
      if (!disposed && queue.length > 0) {
        void flush().catch((error) => {
          options.logger.error(
            runtimeErrorLogFields(normalizeCaughtError(error)),
            "Daemon event delivery failed",
          );
        });
      }

      return lastEventIndex;
    },
    pendingEvents(): PendingDeliveryEvent[] {
      return queue.map((entry) => ({
        ...entry,
        envelope: { ...entry.envelope },
      }));
    },
    async pauseForUpdate(signal): Promise<void> {
      paused = true;
      clearScheduledFlush();
      deliveryAbort?.abort();
      await waitForUpdateCheckpoint(flushPromise ?? Promise.resolve(), signal);
    },
    resume(): void {
      paused = false;
      scheduleFlush(0);
    },
    listUndeliveredThreadIds(): string[] {
      return [...new Set(queue.map((entry) => entry.envelope.threadId))];
    },
    async dispose(): Promise<void> {
      disposed = true;
      clearScheduledFlush();

      if (flushPromise !== null) {
        await flushPromise.catch(() => undefined);
      }

      queue.length = 0;
    },
  };
}

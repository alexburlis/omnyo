import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadScope, turnScope } from "@omnyo/domain";
import { createDeferredPromise } from "@omnyo/test-helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEventSink,
  type CreateEventSinkOptions,
  type EventPostResult,
  type EventSink,
} from "./event-sink.js";
import { ServerResponseError } from "./server-client.js";
import {
  UpdateDeliveryCheckpoint,
  type PendingDeliveryEvent,
} from "./update-delivery-checkpoint.js";

function permanentRejection(bodyMessage: string): ServerResponseError {
  return new ServerResponseError({
    action: "post events",
    bodyMessage,
    code: "invalid_request",
    retryable: false,
    status: 409,
    statusText: "Conflict",
  });
}

function createLogger(): CreateEventSinkOptions["logger"] {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
}

function acceptingPostEvents() {
  return vi.fn<CreateEventSinkOptions["postEvents"]>(async ({ events }) => ({
    acceptedEvents: events.map((event, eventIndex) => ({
      eventIndex,
      sequence: eventIndex + 1,
      threadId: event.threadId,
    })),
    rejectedEvents: [],
  }));
}

function systemErrorEvent(threadId: string) {
  return {
    type: "system/error",
    threadId,
    scope: threadScope(),
    message: "boom",
  } as const;
}

describe("event sink", () => {
  it("drains successfully skipped diffs without requiring allocated sequences", async () => {
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [],
      }),
    );

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_1",
      event: {
        type: "turn/diff/updated",
        threadId: "thr_1",
        providerThreadId: "provider-1",
        scope: turnScope("turn-1"),
        diff: "discarded snapshot",
      },
    });
    await sink.flush();
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [{ threadId: "thr_1", event: systemErrorEvent("thr_1") }],
        firstEventIndex: 2,
      },
      expect.any(AbortSignal),
    );
  });

  it("holds events while the session is closed, reports their threads, and delivers them once it reopens", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(sink.listUndeliveredThreadIds()).toEqual(["thr_1", "thr_2"]);

    sessionOpen = true;
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(postEvents).toHaveBeenCalledWith(
      {
        events: [
          { threadId: "thr_1", event: systemErrorEvent("thr_1") },
          { threadId: "thr_2", event: systemErrorEvent("thr_2") },
          { threadId: "thr_1", event: systemErrorEvent("thr_1") },
        ],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
    expect(sink.listUndeliveredThreadIds()).toEqual([]);
  });

  it("delivers a backed-up queue in bounded posts, in order", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    for (let index = 0; index < 250; index += 1) {
      sink.emit({
        threadId: `thr_${index}`,
        event: systemErrorEvent(`thr_${index}`),
      });
    }

    sessionOpen = true;
    await sink.flush();

    expect(postEvents.mock.calls.map(([batch]) => batch.events.length)).toEqual(
      [100, 100, 50],
    );
    expect(
      postEvents.mock.calls.flatMap(([{ events }]) =>
        events.map((entry) => entry.threadId),
      ),
    ).toEqual(Array.from({ length: 250 }, (_, index) => `thr_${index}`));
    expect(sink.listUndeliveredThreadIds()).toEqual([]);
  });

  it("keeps events queued after a post failure and redelivers them on the next flush", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockImplementation(async ({ events }) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [{ threadId: "thr_1", event: systemErrorEvent("thr_1") }],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
  });

  it("drops ordinary rejected events without retrying them", async () => {
    const logger = createLogger();

    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async () => ({
        acceptedEvents: [],
        rejectedEvents: [
          {
            eventIndex: 0,
            reason: "thread_not_owned_by_host",
            threadId: "thr_1",
          },
        ],
      }),
    );

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(sink.pendingEvents()).toEqual([]);

    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
  });

  it("warns once when a large queue remains undelivered", () => {
    const logger = createLogger();
    let now = 0;

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    for (let index = 0; index < 511; index += 1) {
      sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    }

    expect(logger.warn).not.toHaveBeenCalled();

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).not.toHaveBeenCalled();

    now = 5_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queueAgeMs: 5_000,
        oldestEventAgeMs: 5_000,
        queueDepth: 513,
      }),
      expect.any(String),
    );
  });

  it("warns when even a small queue is stalled for thirty seconds", () => {
    const logger = createLogger();
    let now = 0;

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => false,
      logger,
      now: () => now,
      postEvents: acceptingPostEvents(),
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    now = 30_000;
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        queueAgeMs: 30_000,
        oldestEventAgeMs: 30_000,
        queueDepth: 2,
      }),
      expect.any(String),
    );
  });

  it("drops an ordinary permanently rejected event without retrying it forever", async () => {
    const logger = createLogger();

    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async ({ events }) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }

        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger,
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    await sink.flush();

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(sink.pendingEvents()).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      "Dropped a daemon event the server will never accept",
    );
  });

  it("delivers events queued behind a permanently rejected event", async () => {
    const delivered: string[] = [];

    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async ({ events }) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection(
            "Cannot append provider/unhandled for turn auto-compact-1 before turn/started is stored",
          );
        }

        delivered.push(...events.map((event) => event.threadId));

        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );

    let sessionOpen = false;

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({
      threadId: "thr_poison",
      event: systemErrorEvent("thr_poison"),
    });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });
    sink.emit({ threadId: "thr_b", event: systemErrorEvent("thr_b") });
    sink.emit({ threadId: "thr_a", event: systemErrorEvent("thr_a") });

    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();

    sessionOpen = true;
    await sink.flush();

    expect(delivered).toEqual(["thr_a", "thr_b", "thr_a"]);

    postEvents.mockClear();
    await sink.flush();
    expect(postEvents).not.toHaveBeenCalled();
  });

  it("keeps retrying a batch that fails for a retryable reason", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "database is locked",
          code: "internal_error",
          retryable: true,
          status: 500,
          statusText: "Internal Server Error",
        }),
      )
      .mockImplementation(async ({ events }) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    await sink.flush();
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [{ threadId: "thr_1", event: systemErrorEvent("thr_1") }],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
  });

  it("keeps events queued when the session, not the batch, is rejected", async () => {
    const postEvents = vi
      .fn<CreateEventSinkOptions["postEvents"]>()
      .mockRejectedValueOnce(
        new ServerResponseError({
          action: "post events",
          bodyMessage: "Session is not active",
          code: "inactive_session",
          retryable: false,
          status: 401,
          statusText: "Unauthorized",
        }),
      )
      .mockImplementation(async ({ events }) => ({
        acceptedEvents: events.map((event, eventIndex) => ({
          eventIndex,
          sequence: eventIndex + 1,
          threadId: event.threadId,
        })),
        rejectedEvents: [],
      }));

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();

    expect(postEvents).toHaveBeenCalledTimes(1);

    await sink.flush();
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [
          { threadId: "thr_1", event: systemErrorEvent("thr_1") },
          { threadId: "thr_2", event: systemErrorEvent("thr_2") },
        ],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
  });

  it("never throws from emit regardless of how many events queue up", () => {
    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => false,
      logger: createLogger(),
      postEvents: acceptingPostEvents(),
    });

    expect(() => {
      for (let index = 0; index < 1000; index += 1) {
        sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
      }
    }).not.toThrow();
  });
});

describe("event sink automatic retries", () => {
  let postEvents: ReturnType<typeof acceptingPostEvents>;
  let sink: EventSink;
  let sessionOpen: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    sessionOpen = true;
    postEvents = acceptingPostEvents();
    sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });
    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("delivers a completion queued during a failed upload without new activity", async () => {
    const request = createDeferredPromise<EventPostResult>();
    postEvents.mockImplementationOnce(() => request.promise);
    const flush = sink.flush();

    const completion = {
      type: "turn/completed",
      threadId: "thr_1",
      providerThreadId: "provider-1",
      scope: turnScope("turn-1"),
      status: "completed",
    } as const;

    sink.emit({ threadId: "thr_1", event: completion });
    request.reject(new TypeError("fetch failed"));
    await flush;

    await vi.advanceTimersByTimeAsync(1000);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [
          { threadId: "thr_1", event: systemErrorEvent("thr_1") },
          { threadId: "thr_1", event: completion },
        ],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off repeated failures up to a capped interval despite urgent arrivals", async () => {
    postEvents.mockRejectedValue(new Error("offline"));
    await sink.flush();
    let attempts = 1;

    for (const delay of [750, 1500, 3000, 6000, 12000, 22500, 22500]) {
      sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(postEvents).toHaveBeenCalledTimes(attempts);
      await vi.advanceTimersByTimeAsync(1);
      expect(postEvents).toHaveBeenCalledTimes(++attempts);
    }
  });

  it("stops retrying while disconnected and resumes on a session-open flush", async () => {
    postEvents.mockRejectedValueOnce(new Error("offline"));
    await sink.flush();
    sessionOpen = false;
    await vi.advanceTimersByTimeAsync(60000);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    sessionOpen = true;
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(2);
  });

  it("cancels a scheduled retry when disposed", async () => {
    postEvents.mockRejectedValue(new Error("offline"));
    await sink.flush();
    await sink.dispose();
    await vi.advanceTimersByTimeAsync(60000);
    expect(postEvents).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets backoff after the queue drains successfully", async () => {
    postEvents
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"));
    await sink.flush();
    await vi.advanceTimersByTimeAsync(2250);
    expect(postEvents).toHaveBeenCalledTimes(3);
    postEvents.mockRejectedValueOnce(new Error("offline again"));
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await sink.flush();
    await vi.advanceTimersByTimeAsync(750);
    expect(postEvents).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps retries serialized when more events and flushes arrive during an upload", async () => {
    const request = createDeferredPromise<EventPostResult>();
    postEvents
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => request.promise);
    await sink.flush();
    await vi.advanceTimersByTimeAsync(750);
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    const flush = sink.flush();
    await vi.advanceTimersByTimeAsync(60000);
    expect(postEvents).toHaveBeenCalledTimes(2);
    request.resolve({ acceptedEvents: [], rejectedEvents: [] });
    await flush;
    expect(postEvents).toHaveBeenCalledTimes(3);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [{ threadId: "thr_2", event: systemErrorEvent("thr_2") }],
        firstEventIndex: 2,
      },
      expect.any(AbortSignal),
    );
  });

  it("sends at once when a reply marks its events during a retry backoff", async () => {
    postEvents.mockRejectedValueOnce(new Error("offline"));
    await sink.flush();
    sink.emit({ threadId: "thr_2", event: systemErrorEvent("thr_2") });
    await vi.advanceTimersByTimeAsync(0);
    expect(postEvents).toHaveBeenCalledTimes(1);

    const eventsThrough = sink.markThrough();
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsThrough).toBe(2);
    expect(postEvents).toHaveBeenCalledTimes(2);
    expect(postEvents).toHaveBeenLastCalledWith(
      {
        events: [
          { threadId: "thr_1", event: systemErrorEvent("thr_1") },
          { threadId: "thr_2", event: systemErrorEvent("thr_2") },
        ],
        firstEventIndex: 1,
      },
      expect.any(AbortSignal),
    );
  });
});

describe("event sink indexes", () => {
  it("keeps each event's index when it splits a rejected batch", async () => {
    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async ({ events }) => {
        if (events.some((event) => event.threadId === "thr_poison")) {
          throw permanentRejection("poison");
        }

        return { acceptedEvents: [], rejectedEvents: [] };
      },
    );

    const sink = createEventSink({
      instanceId: "instance-current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    for (const threadId of ["thr_1", "thr_2", "thr_poison", "thr_4"]) {
      sink.emit({ threadId, event: systemErrorEvent(threadId) });
    }

    await sink.flush();

    expect(
      postEvents.mock.calls.map(([batch]) => [
        batch.firstEventIndex,
        batch.events.map((event) => event.threadId),
      ]),
    ).toEqual([
      [1, ["thr_1", "thr_2", "thr_poison", "thr_4"]],
      [1, ["thr_1", "thr_2"]],
      [3, ["thr_poison", "thr_4"]],
      [3, ["thr_poison"]],
      [4, ["thr_4"]],
    ]);
    expect(sink.markThrough()).toBe(4);
  });
});

describe("event sink retained delivery", () => {
  it("aborts an in-flight delivery before snapshot and resumes its original index", async () => {
    const started = createDeferredPromise<void>();
    let attempt = 0;

    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async ({ events }, signal) => {
        attempt += 1;

        if (attempt === 1) {
          started.resolve();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
        }

        return {
          acceptedEvents: events.map((event, eventIndex) => ({
            eventIndex,
            sequence: eventIndex + 1,
            threadId: event.threadId,
          })),
          rejectedEvents: [],
        };
      },
    );

    const sink = createEventSink({
      instanceId: "current",
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_1", event: systemErrorEvent("thr_1") });
    const flushing = sink.flush();
    await started.promise;
    await sink.pauseForUpdate(new AbortController().signal);
    await flushing;
    expect(sink.pendingEvents()).toMatchObject([
      { instanceId: "current", index: 1, blockedReason: null },
    ]);
    await sink.flush();
    expect(postEvents).toHaveBeenCalledTimes(1);
    sink.resume();
    await sink.flush();
    expect(postEvents.mock.calls.map(([batch]) => batch)).toEqual([
      {
        firstEventIndex: 1,
        events: [{ threadId: "thr_1", event: systemErrorEvent("thr_1") }],
      },
      {
        firstEventIndex: 1,
        events: [{ threadId: "thr_1", event: systemErrorEvent("thr_1") }],
      },
    ]);
    expect(sink.pendingEvents()).toEqual([]);
    await sink.dispose();
  });

  it("replays contiguous original ranges before fresh process indexes and keeps blocked bytes", async () => {
    let sessionOpen = false;
    const postEvents = acceptingPostEvents();

    const envelope = {
      threadId: "thr_old",
      event: systemErrorEvent("thr_old"),
    };

    const sink = createEventSink({
      instanceId: "current",
      initialEvents: [
        { instanceId: "old", index: 8, envelope, blockedReason: null },
        {
          instanceId: "old",
          index: 9,
          envelope,
          blockedReason: "invalid_request",
        },
        { instanceId: "old", index: 10, envelope, blockedReason: null },
        { instanceId: "older", index: 4, envelope, blockedReason: null },
      ],
      isSessionOpen: () => sessionOpen,
      logger: createLogger(),
      postEvents,
    });

    sink.emit({ threadId: "thr_new", event: systemErrorEvent("thr_new") });
    expect(sink.markThrough()).toBe(1);
    expect(sink.listUndeliveredThreadIds()).toEqual(["thr_old", "thr_new"]);
    await sink.flush();
    sessionOpen = true;
    await sink.flush();
    expect(
      postEvents.mock.calls.map(([batch]) => [
        batch.sourceInstanceId,
        batch.firstEventIndex,
        batch.events.length,
      ]),
    ).toEqual([
      ["old", 8, 1],
      ["old", 10, 1],
      ["older", 4, 1],
      [undefined, 1, 1],
    ]);
    expect(sink.pendingEvents()).toEqual([
      {
        instanceId: "old",
        index: 9,
        envelope,
        blockedReason: "invalid_request",
      },
    ]);
    expect(sink.markThrough()).toBe(1);
    await sink.dispose();
  });

  it("retains rejected checkpoint members and drops ordinary rejections", async () => {
    const root = await mkdtemp(join(tmpdir(), "omnyo-event-sink-checkpoint-"));
    let sink: EventSink | undefined;

    try {
      const retained: PendingDeliveryEvent = {
        instanceId: "old",
        index: 1,
        envelope: { threadId: "thr_old", event: systemErrorEvent("thr_old") },
        blockedReason: null,
      };

      const checkpoint = new UpdateDeliveryCheckpoint(root, "host-1");
      await checkpoint.capture({
        events: [retained],
        interrupts: [],
        signal: new AbortController().signal,
      });
      const logger = createLogger();

      const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
        async () => {
          throw permanentRejection("rejected");
        },
      );

      sink = createEventSink({
        instanceId: "current",
        initialEvents: checkpoint.events,
        isSessionOpen: () => true,
        logger,
        postEvents,
        onRejected: (events) => checkpoint.recordRejectedEvents(events),
        onAcknowledged: (events) => checkpoint.acknowledgeEvents(events),
      });
      sink.emit({
        threadId: "thr_ordinary",
        event: systemErrorEvent("thr_ordinary"),
      });
      await sink.flush();
      expect(sink.pendingEvents()).toEqual([
        { ...retained, blockedReason: "invalid_request" },
      ]);
      const restored = new UpdateDeliveryCheckpoint(root, "host-1");
      await restored.load();
      expect(restored.events).toEqual(sink.pendingEvents());
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(Object),
        "Retained a checkpointed daemon event the server rejected",
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.any(Object),
        "Dropped a daemon event the server will never accept",
      );
      await sink.flush();
      expect(postEvents).toHaveBeenCalledTimes(2);
    } finally {
      await sink?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops before a later index when rejection retention cannot be saved", async () => {
    const rejected = vi.fn<NonNullable<CreateEventSinkOptions["onRejected"]>>(
      async () => {
        throw new Error("checkpoint write failed");
      },
    );

    const postEvents = vi.fn<CreateEventSinkOptions["postEvents"]>(
      async ({ events }) => {
        if (events.some((event) => event.threadId === "thr_bad"))
          throw permanentRejection("rejected");

        return { acceptedEvents: [], rejectedEvents: [] };
      },
    );

    const sink = createEventSink({
      instanceId: "current",
      initialEvents: [
        {
          instanceId: "old",
          index: 1,
          envelope: { threadId: "thr_bad", event: systemErrorEvent("thr_bad") },
          blockedReason: null,
        },
        {
          instanceId: "old",
          index: 2,
          envelope: {
            threadId: "thr_good",
            event: systemErrorEvent("thr_good"),
          },
          blockedReason: null,
        },
      ],
      isSessionOpen: () => true,
      logger: createLogger(),
      postEvents,
      onRejected: rejected,
    });

    await expect(sink.flush()).rejects.toThrow("checkpoint write failed");
    expect(
      postEvents.mock.calls.map(([batch]) => batch.firstEventIndex),
    ).toEqual([1, 1]);
    expect(sink.pendingEvents()).toMatchObject([
      { index: 1, blockedReason: null },
      { index: 2, blockedReason: null },
    ]);
    await sink.dispose();
  });
});

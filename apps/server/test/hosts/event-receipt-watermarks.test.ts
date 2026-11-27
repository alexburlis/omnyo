import { Buffer } from "node:buffer";
import {
  createConnection,
  listEvents,
  migrate,
  noopNotifier,
  recordDaemonEventReceipt,
  upsertHost,
  type DbConnection,
} from "@omnyo/db";
import { threadScope } from "@omnyo/domain";
import {
  groupHostDaemonEvents,
  hostDaemonEventBatchResponseSchema,
} from "@omnyo/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceDaemonEventReceipt,
  EVENTS_THROUGH_WAIT_MS,
  forgetDaemonEventReceiptsForOtherInstances,
  waitForEventsThrough,
} from "../../src/services/hosts/event-receipt-watermarks.js";
import { setServerMoveSnapshotFence } from "../../src/services/server-move/freeze-state.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

const key = { hostId: "host-watermarks", instanceId: "instance-1" };

function createDatabase(): DbConnection {
  const db = createConnection(":memory:");
  migrate(db);
  upsertHost(db, noopNotifier, { id: key.hostId, name: "Watermark Host" });

  return db;
}

describe("daemon event receipt watermarks", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves at once when the stored mark already covers the stamp", async () => {
    const db = createDatabase();
    recordDaemonEventReceipt(db, { ...key, lastEventIndex: 4 });

    await expect(
      waitForEventsThrough(db, { eventsThrough: 4, key }),
    ).resolves.toBe("reached");
  });

  it("resolves a waiter once the applied index reaches its stamp", async () => {
    const db = createDatabase();
    const outcomes: string[] = [];

    const pending = waitForEventsThrough(db, { eventsThrough: 3, key }).then(
      (outcome) => {
        outcomes.push(outcome);

        return outcome;
      },
    );

    advanceDaemonEventReceipt(db, key, 2);
    await Promise.resolve();
    expect(outcomes).toEqual([]);

    advanceDaemonEventReceipt(db, key, 3);
    await expect(pending).resolves.toBe("reached");
  });

  it("returns write and post-commit timings with the indexed event receipt", () =>
    withTestHarness(async (harness) => {
      const { host, session, thread } = seedThreadFixture(harness);

      const receipt = waitForEventsThrough(harness.db, {
        eventsThrough: 1,
        key: { hostId: host.id, instanceId: session.instanceId },
      });

      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness, { hostId: host.id }),
        body: JSON.stringify({
          sessionId: session.id,
          firstEventIndex: 1,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "system/error",
                threadId: thread.id,
                scope: threadScope(),
                message: "Synthetic indexed event",
              },
            },
          ]),
        }),
      });

      expect(response.status).toBe(200);
      await expect(receipt).resolves.toBe("reached");
      const body = await response.text();
      expect(response.headers.get("content-length")).toBe(
        String(Buffer.byteLength(body)),
      );
      expect(
        hostDaemonEventBatchResponseSchema.parse(JSON.parse(body)),
      ).toEqual({
        acceptedEvents: [{ eventIndex: 0, sequence: 1, threadId: thread.id }],
        rejectedEvents: [],
        duplicateEvents: 0,
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([
        expect.objectContaining({ sequence: 1, type: "system/error" }),
      ]);
      expect(response.headers.get("server-timing")).toMatch(
        /^event_lock;dur=\d+(?:\.\d+)?, event_tx;dur=\d+(?:\.\d+)?, event_after;dur=\d+(?:\.\d+)?$/,
      );
    }));

  it("gives up once the deadline passes without the index", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const db = createDatabase();

    const pending = waitForEventsThrough(db, { eventsThrough: 1, key });

    await vi.advanceTimersByTimeAsync(EVENTS_THROUGH_WAIT_MS);
    await expect(pending).resolves.toBe("timed_out");
  });

  it("skips the wait while the server move fence is up", async () => {
    const db = createDatabase();
    setServerMoveSnapshotFence(db, true);

    await expect(
      waitForEventsThrough(db, { eventsThrough: 1, key }),
    ).resolves.toBe("frozen");
  });

  it("releases a replaced instance's waiters and keeps the current instance", async () => {
    const db = createDatabase();
    const replaced = { ...key, instanceId: "instance-0" };

    const stale = waitForEventsThrough(db, {
      eventsThrough: 1,
      key: replaced,
    });

    const current = waitForEventsThrough(db, { eventsThrough: 1, key });

    forgetDaemonEventReceiptsForOtherInstances(db, key);
    await expect(stale).resolves.toBe("timed_out");

    advanceDaemonEventReceipt(db, key, 1);
    await expect(current).resolves.toBe("reached");
  });
});

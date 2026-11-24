import {
  readDaemonEventReceiptIndex,
  type DaemonEventReceiptKey,
  type DbConnection,
} from "@omnyo/db";
import {
  isServerMoveFrozen,
  isServerMoveSnapshotFenced,
} from "../server-move/freeze-state.js";
import type { AppDeps } from "../../types.js";

export const EVENTS_THROUGH_WAIT_MS = 10_000;

export type EventsThroughWaitOutcome = "reached" | "timed_out" | "frozen";

interface EventsThroughWaiter {
  resolve: (outcome: EventsThroughWaitOutcome) => void;
  target: number;
  timeout: ReturnType<typeof setTimeout>;
}

interface DaemonEventReceiptMark {
  index: number;
  waiters: Set<EventsThroughWaiter>;
}

export interface WaitForEventsThroughArgs {
  eventsThrough: number;
  key: DaemonEventReceiptKey;
  timeoutMs?: number;
}

const marksByDatabase = new WeakMap<
  DbConnection,
  Map<string, DaemonEventReceiptMark>
>();

function markId(key: DaemonEventReceiptKey): string {
  return `${key.hostId}\u0000${key.instanceId}`;
}

function marksFor(db: DbConnection): Map<string, DaemonEventReceiptMark> {
  let marks = marksByDatabase.get(db);

  if (marks === undefined) {
    marks = new Map();
    marksByDatabase.set(db, marks);
  }

  return marks;
}

function markFor(
  db: DbConnection,
  key: DaemonEventReceiptKey,
): DaemonEventReceiptMark {
  const marks = marksFor(db);
  const id = markId(key);
  let mark = marks.get(id);

  if (mark === undefined) {
    mark = { index: readDaemonEventReceiptIndex(db, key), waiters: new Set() };
    marks.set(id, mark);
  }

  return mark;
}

export function advanceDaemonEventReceipt(
  db: DbConnection,
  key: DaemonEventReceiptKey,
  lastEventIndex: number,
): void {
  const mark = markFor(db, key);

  if (lastEventIndex > mark.index) {
    mark.index = lastEventIndex;
  }

  for (const waiter of mark.waiters) {
    if (mark.index >= waiter.target) {
      clearTimeout(waiter.timeout);
      mark.waiters.delete(waiter);
      waiter.resolve("reached");
    }
  }
}

export function waitForEventsThrough(
  db: DbConnection,
  args: WaitForEventsThroughArgs,
): Promise<EventsThroughWaitOutcome> {
  if (isServerMoveFrozen(db) || isServerMoveSnapshotFenced(db)) {
    return Promise.resolve("frozen");
  }

  const mark = markFor(db, args.key);

  if (mark.index >= args.eventsThrough) {
    return Promise.resolve("reached");
  }

  return new Promise((resolve) => {
    const waiter: EventsThroughWaiter = {
      resolve,
      target: args.eventsThrough,
      timeout: setTimeout(() => {
        mark.waiters.delete(waiter);
        resolve("timed_out");
      }, args.timeoutMs ?? EVENTS_THROUGH_WAIT_MS),
    };

    mark.waiters.add(waiter);
  });
}

export interface AwaitRequestEventsThroughArgs {
  eventsThrough: number | undefined;
  key: DaemonEventReceiptKey;
  request: string;
  threadId: string;
}

export async function awaitRequestEventsThrough(
  deps: Pick<AppDeps, "db" | "logger">,
  args: AwaitRequestEventsThroughArgs,
): Promise<void> {
  if (args.eventsThrough === undefined) {
    return;
  }

  const outcome = await waitForEventsThrough(deps.db, {
    eventsThrough: args.eventsThrough,
    key: args.key,
  });

  if (outcome === "timed_out") {
    deps.logger.warn(
      {
        eventsThrough: args.eventsThrough,
        hostId: args.key.hostId,
        request: args.request,
        threadId: args.threadId,
      },
      "Handling a daemon request before its events were applied",
    );
  }
}

export function forgetDaemonEventReceiptsForOtherInstances(
  db: DbConnection,
  key: DaemonEventReceiptKey,
): void {
  const marks = marksFor(db);

  for (const [id, mark] of marks) {
    if (!id.startsWith(`${key.hostId}\u0000`) || id === markId(key)) {
      continue;
    }

    for (const waiter of mark.waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve("timed_out");
    }

    marks.delete(id);
  }
}

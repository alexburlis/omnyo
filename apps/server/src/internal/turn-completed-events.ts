import { and, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  events as storedEvents,
  getThread,
  hasRootStoredTurnStarted,
} from "@omnyo/db";
import {
  requireThreadEventScopeTurnId,
  systemThreadInterruptedEventDataSchema,
  type ChildThreadOutcome,
  type ThreadEvent,
  type ThreadLifecycleEvent,
  type ThreadStatus,
} from "@omnyo/domain";
import type { AppDeps } from "../types.js";
import {
  pruneThreadEventHistoryBestEffort,
  resetActiveThreadEventPruningState,
} from "../services/system/event-pruning.js";
import {
  applyLoggedThreadLifecycleEvent,
  type InboxRunEndHint,
} from "../services/threads/lifecycle-outcome.js";
import { afterCommit } from "../services/lib/after-commit.js";
import { getActiveTurnId } from "../services/threads/thread-events.js";
import { rejectUnconfirmedSteersAfterTurnCompleted } from "../services/threads/unconfirmed-turn-requests.js";

type TurnCompletedEvent = Extract<ThreadEvent, { type: "turn/completed" }>;

type TurnCompletionDeps = Pick<
  AppDeps,
  "db" | "hub" | "logger" | "providerRegistry"
>;

interface ReadTurnCompletionResult {
  isRootTurnCompletion: boolean;
  thread: ReturnType<typeof getThread>;
}

export type TurnCompletedTransition =
  | { kind: "deferred" }
  | { kind: "settled"; nextStatus: ThreadStatus | null };

interface ApplyTurnCompletedEventArgs {
  afterIdle: (() => Promise<void>) | null;
  payload: TurnCompletedEvent;
}

interface TurnCompletion {
  inboxHint: InboxRunEndHint;
  lifecycleEvent: ThreadLifecycleEvent;
}

interface DeferredTurnCompletion extends TurnCompletion {
  afterIdle: (() => Promise<void>) | null;
}

const inFlightTurnRequestCountByThreadId = new Map<string, number>();

const deferredTurnCompletionByThreadId = new Map<
  string,
  DeferredTurnCompletion
>();

function lifecycleEventForTurnCompletion(
  status: TurnCompletedEvent["status"],
): ThreadLifecycleEvent {
  if (status === "failed") {
    return { type: "run.failed" };
  }

  if (status === "interrupted") {
    return { type: "stop.settled" };
  }

  return { type: "run.succeeded" };
}

export function readTurnCompletion(
  deps: Pick<AppDeps, "db">,
  payload: TurnCompletedEvent,
): ReadTurnCompletionResult {
  const thread = getThread(deps.db, payload.threadId);

  if (!thread) {
    return { isRootTurnCompletion: false, thread: null };
  }

  const turnId = requireThreadEventScopeTurnId({
    type: payload.type,
    scope: payload.scope,
  });

  return {
    isRootTurnCompletion: hasRootStoredTurnStarted(deps.db, {
      threadId: payload.threadId,
      turnId,
    }),
    thread,
  };
}

function applyTurnCompletion(
  deps: TurnCompletionDeps,
  threadId: string,
  completion: TurnCompletion,
): ThreadStatus | null {
  const outcome = applyLoggedThreadLifecycleEvent(
    deps,
    { event: completion.lifecycleEvent, threadId },
    completion.inboxHint,
  );

  const nextStatus = outcome.applied ? outcome.thread.status : null;

  if (nextStatus) {
    afterCommit(() => resetActiveThreadEventPruningState(threadId));
  }

  if (nextStatus === "idle") {
    afterCommit(() =>
      pruneThreadEventHistoryBestEffort(deps, { mode: "idle", threadId }),
    );
  }

  return nextStatus;
}

export function applyTurnCompletedEvent(
  deps: TurnCompletionDeps,
  { afterIdle, payload }: ApplyTurnCompletedEventArgs,
): TurnCompletedTransition {
  rejectUnconfirmedSteersAfterTurnCompleted(deps, payload.threadId);

  const completion: TurnCompletion = {
    inboxHint: inboxRunEndHint(
      deps,
      payload,
      requireThreadEventScopeTurnId({
        type: payload.type,
        scope: payload.scope,
      }),
    ),
    lifecycleEvent: lifecycleEventForTurnCompletion(payload.status),
  };

  if (inFlightTurnRequestCountByThreadId.has(payload.threadId)) {
    afterCommit(() =>
      deferredTurnCompletionByThreadId.set(payload.threadId, {
        ...completion,
        afterIdle,
      }),
    );

    return { kind: "deferred" };
  }

  return {
    kind: "settled",
    nextStatus: applyTurnCompletion(deps, payload.threadId, completion),
  };
}

export function trackInFlightTurnRequest(threadId: string): void {
  inFlightTurnRequestCountByThreadId.set(
    threadId,
    (inFlightTurnRequestCountByThreadId.get(threadId) ?? 0) + 1,
  );
}

export async function settleInFlightTurnRequest(
  deps: TurnCompletionDeps,
  threadId: string,
): Promise<void> {
  const count = inFlightTurnRequestCountByThreadId.get(threadId) ?? 0;

  if (count > 1) {
    inFlightTurnRequestCountByThreadId.set(threadId, count - 1);

    return;
  }

  inFlightTurnRequestCountByThreadId.delete(threadId);
  const completion = deferredTurnCompletionByThreadId.get(threadId);

  if (completion === undefined) {
    return;
  }

  deferredTurnCompletionByThreadId.delete(threadId);

  if (getActiveTurnId(deps, threadId) !== null) {
    return;
  }

  const nextStatus = applyTurnCompletion(deps, threadId, completion);

  if (nextStatus === "idle") {
    await completion.afterIdle?.();
  }
}

function inboxRunEndHint(
  deps: Pick<AppDeps, "db">,
  payload: TurnCompletedEvent,
  turnId: string,
): InboxRunEndHint {
  if (payload.status === "completed")
    return { outcome: "completed", reason: null, summary: null };

  if (payload.status === "failed")
    return {
      outcome: "failed",
      reason: payload.error?.message ?? null,
      summary: null,
    };

  const reason = getTurnInterruption(deps, {
    threadId: payload.threadId,
    turnId,
  })?.reason;

  if (reason === "manual-stop")
    return { outcome: "stopped", reason: null, summary: null };

  if (reason === "app-update")
    return { outcome: "suspended", reason: null, summary: null };

  return {
    outcome: "failed",
    reason: "The turn was interrupted.",
    summary: null,
  };
}

export function getTurnInterruption(
  deps: Pick<AppDeps, "db">,
  args: { threadId: string; turnId: string },
): ChildThreadOutcome["interruption"] {
  const turnStarted = deps.db
    .select({ sequence: storedEvents.sequence })
    .from(storedEvents)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();

  if (!turnStarted) {
    return undefined;
  }

  const turnCompleted = deps.db
    .select({ sequence: sql<number>`${storedEvents.sequence}` })
    .from(
      sql`${storedEvents} INDEXED BY events_thread_turn_type_item_sequence_idx`,
    )
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.turnId, args.turnId),
        eq(storedEvents.type, "turn/completed"),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();

  if (!turnCompleted) return undefined;

  const turnBoundary = deps.db
    .select({ sequence: sql<number>`${storedEvents.sequence}` })
    .from(sql`${storedEvents} INDEXED BY events_thread_type_sequence_idx`)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        inArray(storedEvents.type, ["client/turn/requested", "turn/completed"]),
        lt(storedEvents.sequence, turnStarted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();

  const interruption = deps.db
    .select({ data: sql<string>`${storedEvents.data}` })
    .from(sql`${storedEvents} INDEXED BY events_thread_type_sequence_idx`)
    .where(
      and(
        eq(storedEvents.threadId, args.threadId),
        eq(storedEvents.type, "system/thread/interrupted"),
        gt(
          storedEvents.sequence,
          turnBoundary?.sequence ?? turnStarted.sequence,
        ),
        lt(storedEvents.sequence, turnCompleted.sequence),
      ),
    )
    .orderBy(desc(storedEvents.sequence))
    .limit(1)
    .get();

  return interruption
    ? systemThreadInterruptedEventDataSchema.parse(
        JSON.parse(interruption.data),
      )
    : undefined;
}

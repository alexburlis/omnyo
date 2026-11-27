import { captureActionableProviderFailures } from "./provider-error-reporting.js";
import {
  applyThreadLifecycleEventInTransaction,
  getThread,
  installedPlugins,
  type ApplyThreadLifecycleEventArgs,
  type ApplyThreadLifecycleEventOutcome,
  type DbConnection,
  type DbNotifier,
  type DbTransaction,
} from "@omnyo/db";
import type { ServerLogger } from "../../types.js";
import type { NotificationHub } from "../../ws/hub.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { afterCommit } from "../lib/after-commit.js";
import {
  emitPluginThreadLifecycleOutcome,
  emitPluginThreadMaintenance,
  emitPluginTurnFailed,
} from "../plugins/plugin-thread-events.js";
import type { ProviderRegistryService } from "../providers/provider-registry.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";
import { eq } from "drizzle-orm";
import type { ClientTurnRequestId, ThreadStatus } from "@omnyo/domain";
import { applyInboxRunEnd, type InboxRunOutcome } from "../inbox/engine.js";
import { inboxRootOf } from "../inbox/family.js";
import {
  getOpenMaintenanceRequest,
  type AutoCompactionOutcomeState,
  type MaintenanceRequest,
} from "./maintenance-run.js";
import {
  maintenanceLifecycleEvent,
  recordMaintenanceRunEnd,
} from "./maintenance-silence.js";

export interface InboxRunEndHint {
  outcome: InboxRunOutcome;
  reason: string | null;
  summary: string | null;
  requestId?: ClientTurnRequestId;
}

export interface LifecycleInboxOptions {
  inbox: "record" | "silent";
}

const RECORD_INBOX: LifecycleInboxOptions = { inbox: "record" };

const RUNNING_STATUSES: ReadonlySet<ThreadStatus> = new Set([
  "starting",
  "active",
  "stopping",
]);

function derivedRunOutcome(
  event: ApplyThreadLifecycleEventArgs["event"],
): InboxRunOutcome | null {
  switch (event.type) {
    case "run.succeeded":
      return "completed";
    case "run.failed":
      return "failed";
    case "stop.settled":
      return "stopped";
    default:
      return null;
  }
}

function providerRetryDecides(db: DbTransaction): boolean {
  return (
    db
      .select({ enabled: installedPlugins.enabled })
      .from(installedPlugins)
      .where(eq(installedPlugins.id, "provider-retry"))
      .get()?.enabled === true
  );
}

function isRunEnd(
  before: ThreadStatus | null,
  outcome: ApplyThreadLifecycleEventOutcome,
): boolean {
  return (
    outcome.applied &&
    before !== null &&
    RUNNING_STATUSES.has(before) &&
    (outcome.thread.status === "idle" || outcome.thread.status === "error")
  );
}

function applyInboxLifecycle(
  db: DbTransaction,
  args: {
    before: ThreadStatus | null;
    event: ApplyThreadLifecycleEventArgs;
    outcome: ApplyThreadLifecycleEventOutcome;
    hint: InboxRunEndHint | undefined;
  },
): string[] {
  if (!isRunEnd(args.before, args.outcome)) return [];

  const outcome = args.hint?.outcome ?? derivedRunOutcome(args.event.event);

  if (outcome === null) return [];

  return applyInboxRunEnd(db, {
    threadId: args.event.threadId,
    outcome,
    reason: args.hint?.reason ?? null,
    summary: args.hint?.summary ?? null,
    requestId: args.hint?.requestId,
    retryDecider: outcome === "failed" && providerRetryDecides(db),
    now: Date.now(),
  }).changedThreadIds;
}

interface ClassifiedLifecycleTransition {
  before: ThreadStatus | null;
  maintenance: MaintenanceRequest | null;
  maintenanceState: AutoCompactionOutcomeState | null;
  outcome: ApplyThreadLifecycleEventOutcome;
  inboxChanged: string[];
}

function applyClassifiedLifecycleEventInTransaction(
  db: DbTransaction,
  notifier: DbNotifier,
  args: ApplyThreadLifecycleEventArgs,
  hint: InboxRunEndHint | undefined,
  options: LifecycleInboxOptions,
): ClassifiedLifecycleTransition {
  const before = getThread(db, args.threadId)?.status ?? null;
  const maintenance = getOpenMaintenanceRequest(db, args.threadId);

  const outcome = applyThreadLifecycleEventInTransaction(
    db,
    notifier,
    maintenance === null
      ? args
      : { ...args, event: maintenanceLifecycleEvent(args.event) },
  );

  const maintenanceState =
    maintenance !== null && isRunEnd(before, outcome)
      ? recordMaintenanceRunEnd(db, {
          threadId: args.threadId,
          request: maintenance,
          event: args.event,
          hint,
          now: Date.now(),
        }).state
      : null;

  const inboxChanged =
    maintenance === null && options.inbox === "record"
      ? applyInboxLifecycle(db, { before, event: args, outcome, hint })
      : [];

  if (outcome.applied && inboxChanged.length > 0) {
    const thread = getThread(db, args.threadId);

    if (thread === null)
      throw new Error("Thread disappeared while recording its run outcome");

    outcome.thread = thread;
  }

  return {
    before,
    maintenance,
    maintenanceState,
    outcome,
    inboxChanged,
  };
}

const MAINTENANCE_PLUGIN_OUTCOME = {
  done: "completed",
  failed: "failed",
  stopped: "stopped",
} as const;

function announceLifecycleTransition(
  args: ApplyThreadLifecycleEventArgs,
  transition: ClassifiedLifecycleTransition,
): void {
  const { outcome } = transition;

  if (transition.maintenance === null) {
    announceTurnFailed(args, outcome);
    emitPluginThreadLifecycleOutcome(outcome);

    return;
  }

  if (!outcome.applied) return;

  if (transition.maintenanceState !== null) {
    emitPluginThreadMaintenance(
      outcome.thread,
      "ended",
      MAINTENANCE_PLUGIN_OUTCOME[transition.maintenanceState],
    );

    return;
  }

  if (
    RUNNING_STATUSES.has(outcome.thread.status) &&
    (transition.before === null || !RUNNING_STATUSES.has(transition.before))
  )
    emitPluginThreadMaintenance(outcome.thread, "started", null);
}

function notifyInboxChanged(
  deps: { db: DbConnection | DbTransaction; hub: DbNotifier },
  args: { threadIds: readonly string[]; statusThreadId: string },
): void {
  const roots = new Set(
    args.threadIds.map((id) => inboxRootOf(deps.db, id)?.id ?? id),
  );

  roots.delete(args.statusThreadId);

  for (const id of roots) deps.hub.notifyThread(id, ["work-changed"]);
}

function announceTurnFailed(
  args: ApplyThreadLifecycleEventArgs,
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (!outcome.applied || args.event.type !== "run.failed") return;
  emitPluginTurnFailed(args.threadId);
}

interface ApplyLoggedThreadLifecycleEventDeps {
  db: DbConnection;
  hub: Pick<NotificationHub, "getDaemonSessionIdForHost"> & DbNotifier;
  logger: ServerLogger;
  providerRegistry: ProviderRegistryService;
}

interface ApplyLoggedThreadLifecycleEventTransactionDeps {
  db: DbTransaction;
  hub: DbNotifier;
  logger: ServerLogger;
}

function logUnappliedThreadLifecycleEvent(
  logger: ServerLogger,
  args: ApplyThreadLifecycleEventArgs,
  outcome: ApplyThreadLifecycleEventOutcome,
): void {
  if (outcome.applied) {
    return;
  }

  logger.info(
    {
      detail: outcome.detail,
      event: args.event.type,
      reason: outcome.reason,
      threadId: args.threadId,
    },
    "Thread lifecycle event not applied",
  );
}

export function applyLoggedThreadLifecycleEvent(
  deps: ApplyLoggedThreadLifecycleEventDeps,
  args: ApplyThreadLifecycleEventArgs,
  hint?: InboxRunEndHint,
): ApplyThreadLifecycleEventOutcome {
  const shelfChanges = new NotificationBuffer();

  const transition = deps.db.transaction(
    (tx) =>
      applyClassifiedLifecycleEventInTransaction(
        tx,
        shelfChanges,
        args,
        hint,
        RECORD_INBOX,
      ),
    { behavior: "immediate" },
  );

  const { outcome } = transition;

  if (outcome.applied) {
    deps.hub.notifyThread(
      args.threadId,
      ["status-changed"],
      buildThreadStatusChangeMetadata(deps, outcome.thread),
    );
  }

  shelfChanges.flushInto(deps.hub);
  notifyInboxChanged(deps, {
    threadIds: transition.inboxChanged,
    statusThreadId: args.threadId,
  });
  logUnappliedThreadLifecycleEvent(deps.logger, args, outcome);
  afterCommit(() => {
    announceLifecycleTransition(args, transition);
    captureActionableProviderFailures(deps.db, [args.threadId]);
  });

  return outcome;
}

export function applyLoggedThreadLifecycleEventInTransaction(
  deps: ApplyLoggedThreadLifecycleEventTransactionDeps,
  args: ApplyThreadLifecycleEventArgs,
  hint?: InboxRunEndHint,
  options: LifecycleInboxOptions = RECORD_INBOX,
): ApplyThreadLifecycleEventOutcome {
  const transition = applyClassifiedLifecycleEventInTransaction(
    deps.db,
    deps.hub,
    args,
    hint,
    options,
  );

  notifyInboxChanged(deps, {
    threadIds: transition.inboxChanged,
    statusThreadId: args.threadId,
  });

  logUnappliedThreadLifecycleEvent(deps.logger, args, transition.outcome);
  announceLifecycleTransition(args, transition);

  return transition.outcome;
}

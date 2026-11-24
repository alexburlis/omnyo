import {
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  restoreDeletedQueuedThreadMessage,
  type DbConnection,
  type DeletedQueuedThreadMessage,
} from "@omnyo/db";
import type { InboxActor } from "../inbox/actor.js";
import type { Thread, ThreadQueuedMessage } from "@omnyo/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { settleDeletedWakeWaits } from "../inbox/waits.js";
import {
  emitPluginMessageCancelled,
  emitPluginMessageQueued,
} from "../plugins/plugin-thread-events.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";
import { ensureThreadQueueIsWritable } from "./thread-send.js";

export const DELETED_QUEUED_MESSAGE_RESTORE_WINDOW_MS = 60 * 60 * 1000;

const DELETED_QUEUED_MESSAGE_LIMIT = 200;

interface RememberedDeletion {
  deletedAt: number;
  deletion: DeletedQueuedThreadMessage;
}

const deletedQueuedMessages = new WeakMap<
  DbConnection,
  Map<string, RememberedDeletion>
>();

function deletionStore(db: DbConnection): Map<string, RememberedDeletion> {
  const existing = deletedQueuedMessages.get(db);

  if (existing) return existing;
  const store = new Map<string, RememberedDeletion>();
  deletedQueuedMessages.set(db, store);

  return store;
}

function pruneDeletionStore(
  store: Map<string, RememberedDeletion>,
  now: number,
): void {
  for (const [id, remembered] of store) {
    if (now - remembered.deletedAt <= DELETED_QUEUED_MESSAGE_RESTORE_WINDOW_MS)
      break;
    store.delete(id);
  }

  while (store.size > DELETED_QUEUED_MESSAGE_LIMIT) {
    const oldest = store.keys().next();

    if (oldest.done === true) return;
    store.delete(oldest.value);
  }
}

export function deleteQueuedMessageForThread(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db" | "hub" | "logger">,
  args: { queuedMessageId: string; threadId: string; actor: InboxActor },
): void {
  const queuedMessage = getQueuedThreadMessage(deps.db, args.queuedMessageId);

  if (!queuedMessage || queuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const deletion = deleteQueuedThreadMessage(
    deps.db,
    deps.hub,
    args.queuedMessageId,
  );

  if (!deletion) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  if (queuedMessage.payloadKind === "retry") {
    deps.logger.info(
      {
        threadId: queuedMessage.threadId,
        queuedMessageId: queuedMessage.id,
        retryOfTurnRequestId: queuedMessage.retryOfTurnRequestId,
        retryAttempt: queuedMessage.retryAttempt,
        actorKind: args.actor.kind,
        reason: "cancelled",
      },
      "Queued retry removed",
    );
  }

  const now = Date.now();

  const settled = settleDeletedWakeWaits(deps.db, {
    queuedMessageId: deletion.row.id,
    now,
  });

  if (settled.length > 0)
    deps.hub.notifyThread(args.threadId, ["work-changed"]);

  const store = deletionStore(deps.db);
  store.delete(deletion.row.id);
  store.set(deletion.row.id, { deletedAt: now, deletion });
  pruneDeletionStore(store, now);
  emitPluginMessageCancelled(toThreadQueuedMessage(queuedMessage));
}

export function restoreQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { queuedMessageId: string; thread: Thread },
): ThreadQueuedMessage {
  ensureThreadQueueIsWritable(args.thread);

  const store = deletionStore(deps.db);
  pruneDeletionStore(store, Date.now());
  const remembered = store.get(args.queuedMessageId);

  if (!remembered || remembered.deletion.row.threadId !== args.thread.id) {
    throw new ApiError(
      404,
      "invalid_request",
      "Deleted queued message can no longer be restored",
    );
  }

  const result = restoreDeletedQueuedThreadMessage(
    deps.db,
    deps.hub,
    remembered.deletion,
  );

  store.delete(args.queuedMessageId);

  if (result.kind === "thread_not_found") {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }

  if (result.kind === "exists") {
    throw new ApiError(409, "invalid_request", "Queued message already exists");
  }

  const queuedMessage = toThreadQueuedMessage(result.queuedMessage);
  emitPluginMessageQueued(queuedMessage);
  requestQueuedMessageDispatch(deps, {
    kind: "restored",
    queuedMessageId: queuedMessage.id,
    threadId: args.thread.id,
  });

  return queuedMessage;
}

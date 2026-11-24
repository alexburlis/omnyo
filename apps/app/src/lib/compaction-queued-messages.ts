import {
  isStandaloneBuiltinCompactCommand,
  type QueuedMessageWaitingOn,
  type ThreadQueuedMessage,
  type ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type {
  TimelineRow,
  TimelineUserConversationRow,
} from "@omnyo/server-contract";

const NO_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

function hasAttachments({ attachments }: TimelineUserConversationRow): boolean {
  return (
    attachments !== null &&
    attachments.webImages + attachments.localImages + attachments.localFiles > 0
  );
}

function isCompactCommandRequest(row: TimelineUserConversationRow): boolean {
  return (
    row.maintenance === undefined &&
    !hasAttachments(row) &&
    isStandaloneBuiltinCompactCommand([
      { type: "text", text: row.text, mentions: row.mentions },
    ])
  );
}

function isCompactionRequest(row: TimelineUserConversationRow): boolean {
  return row.maintenance === "auto-compaction" || isCompactCommandRequest(row);
}

function isHiddenCompactCommandRow(row: TimelineRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.turnRequest.status !== "rejected" &&
    isCompactCommandRequest(row)
  );
}

export function withoutCompactCommandRows(rows: TimelineRow[]): TimelineRow[] {
  return rows.some(isHiddenCompactCommandRow)
    ? rows.filter((row) => !isHiddenCompactCommandRow(row))
    : rows;
}

function latestUserRow(
  rows: readonly TimelineRow[],
): TimelineUserConversationRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;

    if (row.kind === "conversation" && row.role === "user") return row;
  }

  return null;
}

function isCompactionRunning(status: ThreadRuntimeDisplayStatus): boolean {
  return (
    status === "active" || status === "starting" || status === "provisioning"
  );
}

function waitsOnlyForCompaction(waitingOn: QueuedMessageWaitingOn | null) {
  if (waitingOn === null) return true;

  switch (waitingOn.kind) {
    case "thread-busy":
    case "turn-starting":
    case "plugin":
      return true;
    case "time":
    case "stopping":
    case "provisioning":
    case "host-offline":
    case "host-away":
    case "interaction":
    case "server-update":
    case "superseded":
      return false;
  }
}

export function selectQueuedMessagesAwaitingCompaction({
  queuedMessages,
  runtimeStatus,
  timelineRows,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  runtimeStatus: ThreadRuntimeDisplayStatus | undefined;
  timelineRows: readonly TimelineRow[];
}): readonly ThreadQueuedMessage[] {
  if (
    queuedMessages.length === 0 ||
    runtimeStatus === undefined ||
    !isCompactionRunning(runtimeStatus)
  ) {
    return NO_QUEUED_MESSAGES;
  }

  const request = latestUserRow(timelineRows);

  if (
    request === null ||
    request.turnRequest.status === "rejected" ||
    !isCompactionRequest(request)
  ) {
    return NO_QUEUED_MESSAGES;
  }

  const awaiting = queuedMessages.filter(
    (message) =>
      message.initiator === "user" &&
      message.senderThreadId === null &&
      message.sendAt === null &&
      message.failureReason === null &&
      message.payload.kind === "inline" &&
      message.createdAt >= request.createdAt &&
      waitsOnlyForCompaction(message.waitingOn),
  );

  return awaiting.length === 0 ? NO_QUEUED_MESSAGES : awaiting;
}

export function withoutQueuedMessages(
  queuedMessages: readonly ThreadQueuedMessage[],
  removed: readonly ThreadQueuedMessage[],
): readonly ThreadQueuedMessage[] {
  if (removed.length === 0) return queuedMessages;
  const removedIds = new Set(removed.map((message) => message.id));

  return queuedMessages.filter((message) => !removedIds.has(message.id));
}

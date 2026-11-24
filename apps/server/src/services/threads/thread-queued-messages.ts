import { messageSourceFromNotice } from "./message-source.js";
import {
  promptInputSchema,
  queuedMessageSystemNoticeSchema,
  queuedMessageWaitingOnSchema,
  threadQueuedMessageSchema,
} from "@omnyo/domain";
import type {
  PermissionMode,
  PromptInput,
  QueuedMessagePayload,
  QueuedMessagePayloadKind,
  QueuedMessageSystemNotice,
  QueuedMessageWaitingOn,
  StartedOnBehalfOf,
  StartedOnBehalfOfInitiator,
  ThreadQueuedMessage,
  ThreadCreateOrigin,
} from "@omnyo/domain";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import { resolveDispatchAuthor } from "./dispatch-author.js";

interface StoredQueuedThreadMessageRow {
  origin: ThreadCreateOrigin | null;
  originPluginId: string | null;
  claimedAt: number | null;
  content: string;
  createdAt: number;
  failureReason: string | null;
  id: string;
  groupWithNext: boolean;
  model: string;
  payloadKind: QueuedMessagePayloadKind;
  reasoningLevel: string;
  retryAttempt: number | null;
  retryOfTurnRequestId: string | null;
  retryReason: string | null;
  permissionMode: PermissionMode;
  sendAt: number | null;
  serviceTier: string;
  senderThreadId: string | null;
  requestedByInitiator: StartedOnBehalfOfInitiator | null;
  requestedByThreadId: string | null;
  systemNotice: string | null;
  threadId: string;
  updatedAt: number;
  waitingOn: string | null;
}

function parseStoredQueuedThreadMessageContent(
  row: Pick<StoredQueuedThreadMessageRow, "content" | "id" | "threadId">,
): PromptInput[] {
  let content: unknown;

  try {
    content = JSON.parse(row.content);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is not valid JSON`,
    );
  }

  const parsed = z.array(promptInputSchema).safeParse(content);

  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is malformed`,
    );
  }

  return parsed.data;
}

export function parseStoredQueuedThreadMessageWaitingOn(
  row: Pick<StoredQueuedThreadMessageRow, "id" | "threadId" | "waitingOn">,
): QueuedMessageWaitingOn | null {
  if (row.waitingOn === null) return null;

  let waitingOn: unknown;

  try {
    waitingOn = JSON.parse(row.waitingOn);
  } catch {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has a malformed wait`,
    );
  }

  const parsed = queuedMessageWaitingOnSchema.safeParse(waitingOn);

  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has a malformed wait`,
    );
  }

  return parsed.data;
}

export function parseStoredQueuedThreadMessageSystemNotice(
  row: Pick<StoredQueuedThreadMessageRow, "id" | "systemNotice" | "threadId">,
): QueuedMessageSystemNotice | null {
  if (row.systemNotice === null) return null;
  let notice: unknown;

  try {
    notice = JSON.parse(row.systemNotice);
  } catch {
    notice = null;
  }

  const parsed = queuedMessageSystemNoticeSchema.safeParse(notice);

  if (!parsed.success) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has a malformed system notice`,
    );
  }

  return parsed.data;
}

export function storedQueuedThreadMessageRequestedBy(
  row: Pick<
    StoredQueuedThreadMessageRow,
    "id" | "threadId" | "requestedByInitiator" | "requestedByThreadId"
  >,
): StartedOnBehalfOf | null {
  if (row.requestedByInitiator === null && row.requestedByThreadId === null) {
    return null;
  }

  if (row.requestedByInitiator === null || row.requestedByThreadId === null) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} has half a requester`,
    );
  }

  return {
    initiator: row.requestedByInitiator,
    senderThreadId: row.requestedByThreadId,
  };
}

function toQueuedMessagePayload(
  row: StoredQueuedThreadMessageRow,
): QueuedMessagePayload {
  if (row.payloadKind === "inline") {
    return { kind: "inline" };
  }

  if (row.payloadKind === "continuation") {
    return { kind: "continuation" };
  }

  if (
    row.retryOfTurnRequestId === null ||
    row.retryAttempt === null ||
    row.retryReason === null
  ) {
    throw new ApiError(
      500,
      "internal_error",
      `Stored queued message ${row.id} for thread ${row.threadId} is a retry with no original request`,
    );
  }

  return {
    kind: "retry",
    retryOfTurnRequestId: row.retryOfTurnRequestId,
    attempt: row.retryAttempt,
    reason: row.retryReason,
  };
}

export function toThreadQueuedMessage(
  row: StoredQueuedThreadMessageRow,
): ThreadQueuedMessage {
  const systemNotice =
    row.systemNotice === null
      ? null
      : queuedMessageSystemNoticeSchema.parse(JSON.parse(row.systemNotice));

  const messageSource = messageSourceFromNotice(systemNotice);

  const author =
    systemNotice !== null && messageSource === undefined
      ? { initiator: "system" as const, senderThreadId: null }
      : resolveDispatchAuthor({
          systemNotice: false,
          retrying:
            row.payloadKind === "retry" || row.payloadKind === "continuation",
          senderThreadId: row.senderThreadId,
          startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(row),
        });

  return threadQueuedMessageSchema.parse({
    id: row.id,
    messageSource,
    origin: row.origin,
    originPluginId: row.originPluginId,
    initiator: author.initiator,
    senderThreadId: author.senderThreadId,
    threadId: row.threadId,
    content: parseStoredQueuedThreadMessageContent(row),
    model: row.model,
    reasoningLevel: row.reasoningLevel,
    permissionMode: row.permissionMode,
    serviceTier: row.serviceTier,
    groupWithNext: row.groupWithNext,
    sendAt: row.sendAt,
    waitingOn: parseStoredQueuedThreadMessageWaitingOn(row),
    failureReason: row.failureReason,
    payload: toQueuedMessagePayload(row),

    editable: row.payloadKind === "inline" && row.claimedAt === null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

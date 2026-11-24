import type { ThreadQueuedMessage } from "@omnyo/domain";
import { queuedMessageHasWaitLine } from "@/lib/queued-message-wait";

const TRAY_CHROME_HEIGHT = 1 + 12 + 2;

export const QUEUED_MESSAGES_ROW_HEIGHT = 33;

const TRAY_VISIBLE_ROWS = 4;

const TRAY_OVERFLOW_PEEK_HEIGHT = 16;

const TRAY_MAX_HEIGHT =
  TRAY_CHROME_HEIGHT +
  TRAY_VISIBLE_ROWS * QUEUED_MESSAGES_ROW_HEIGHT +
  TRAY_OVERFLOW_PEEK_HEIGHT;

const TRAILING_BOUNDARY_HEIGHT = 12;

const SECOND_LINE_HEIGHT = 16;

const SENDER_PILL_LINE_HEIGHT = 22;

export const QUEUED_MESSAGES_COLLAPSED_HEIGHT =
  TRAY_CHROME_HEIGHT + QUEUED_MESSAGES_ROW_HEIGHT;

function getQueuedMessageRowHeight(
  queuedMessage: ThreadQueuedMessage,
  processingMessageId: string | null,
): number {
  const hasSecondLine =
    queuedMessage.senderThreadId !== null ||
    queuedMessage.initiator !== "user" ||
    queuedMessageHasWaitLine(queuedMessage) ||
    queuedMessage.id === processingMessageId;

  if (!hasSecondLine) return QUEUED_MESSAGES_ROW_HEIGHT;

  return (
    QUEUED_MESSAGES_ROW_HEIGHT +
    (queuedMessage.senderThreadId !== null
      ? SENDER_PILL_LINE_HEIGHT
      : SECOND_LINE_HEIGHT)
  );
}

export function queuedMessagesEndOnGroupBoundary(
  queuedMessages: readonly ThreadQueuedMessage[],
): boolean {
  if (queuedMessages.length < 2) return false;

  const firstUngroupedIndex = queuedMessages.findIndex(
    (queuedMessage) => !queuedMessage.groupWithNext,
  );

  return (
    firstUngroupedIndex === -1 ||
    firstUngroupedIndex === queuedMessages.length - 1
  );
}

export function getQueuedMessagesCollapsedHeight({
  queuedMessages,
  processingMessageId,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  processingMessageId: string | null;
}): number {
  const nextMessage = queuedMessages[0];

  return nextMessage === undefined
    ? QUEUED_MESSAGES_COLLAPSED_HEIGHT
    : TRAY_CHROME_HEIGHT +
        getQueuedMessageRowHeight(nextMessage, processingMessageId);
}

export function getQueuedMessagesDrawerHeight({
  queuedMessages,
  processingMessageId,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  processingMessageId: string | null;
}): number {
  const rowsHeight =
    queuedMessages.length === 0
      ? QUEUED_MESSAGES_ROW_HEIGHT
      : queuedMessages.reduce(
          (total, queuedMessage) =>
            total +
            getQueuedMessageRowHeight(queuedMessage, processingMessageId),
          0,
        );

  return Math.min(
    TRAY_MAX_HEIGHT,
    TRAY_CHROME_HEIGHT +
      rowsHeight +
      (queuedMessagesEndOnGroupBoundary(queuedMessages)
        ? TRAILING_BOUNDARY_HEIGHT
        : 0),
  );
}

export function getPendingQueuedMessagesDrawerHeight(
  queuedMessageCount: number,
): number {
  return Math.min(
    TRAY_MAX_HEIGHT,
    TRAY_CHROME_HEIGHT +
      Math.max(1, queuedMessageCount) * QUEUED_MESSAGES_ROW_HEIGHT,
  );
}

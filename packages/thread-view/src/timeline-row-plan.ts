import type { CompletedTurnDisplay, GitActivity } from "@omnyo/domain";
import type { TimelineTurnRow } from "@omnyo/server-contract";
import { groupCompletedTurnMessages } from "./completed-turn-grouping.js";
import type {
  EventProjection,
  EventProjectionMessage,
  EventProjectionTurn,
} from "./event-projection-types.js";
import {
  findLastTerminalTimelineMessage,
  isTimelineUngroupableMessage,
} from "./timeline-message-helpers.js";
import { summarizeTurnActivity } from "./turn-activity.js";

interface TimelineMessagePlan {
  kind: "message";
  message: EventProjectionMessage;
  turnGit: GitActivity | null;
}

interface TimelineSummaryPlan {
  kind: "summary";
  row: TimelineTurnRow;
  messages: readonly EventProjectionMessage[];
}

export type TimelineRowPlan = TimelineMessagePlan | TimelineSummaryPlan;

function messagePlan(message: EventProjectionMessage): TimelineMessagePlan {
  return { kind: "message", message, turnGit: null };
}

function terminalMessagePlan(
  message: EventProjectionMessage,
  gitActivity: GitActivity | null,
): TimelineMessagePlan {
  return {
    kind: "message",
    message,
    turnGit: message.kind === "assistant-text" ? gitActivity : null,
  };
}

function planTurn(
  turn: EventProjectionTurn,
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
  workspaceRoot: string | null,
): TimelineRowPlan[] {
  const messages = turn.messages ?? [];

  if (turn.status === "pending" || turn.completedAt === null) {
    return messages.map(messagePlan);
  }

  if (completedTurnDisplay === "flat") {
    const terminalMessage = findLastTerminalTimelineMessage(messages);

    return messages.map((message) =>
      message === terminalMessage
        ? terminalMessagePlan(message, turn.gitActivity)
        : messagePlan(message),
    );
  }

  const { summaryItems, terminalMessages, trailingMessages } =
    groupCompletedTurnMessages(turn);

  const ungroupableSeqStarts = messages
    .filter(isTimelineUngroupableMessage)
    .map((message) => message.sourceSeqStart);

  const plan: TimelineRowPlan[] = [];

  for (const item of summaryItems) {
    if (item.kind === "ungrouped-message") {
      plan.push(messagePlan(item.message));
      continue;
    }

    if (item.summaryCount === 0 && item.sourceMessages.length === 0) continue;

    const useTurnBounds =
      item.segmentIndex === null || item.sourceMessages.length === 0;

    let sourceSeqStart = turn.sourceSeqStart;
    let sourceSeqEnd = turn.sourceSeqEnd;
    let createdAt = turn.createdAt;
    let completedAt = item.completedAt;

    if (!useTurnBounds) {
      sourceSeqStart = Infinity;
      sourceSeqEnd = -Infinity;
      createdAt = Infinity;
    }

    for (const message of item.sourceMessages) {
      if (!useTurnBounds) {
        sourceSeqStart = Math.min(sourceSeqStart, message.sourceSeqStart);
        sourceSeqEnd = Math.max(sourceSeqEnd, message.sourceSeqEnd);
        createdAt = Math.min(createdAt, message.createdAt);
      }

      if (item.completedAt === null) {
        completedAt = Math.max(completedAt ?? -Infinity, message.createdAt);
      }
    }

    const terminalMessage = terminalMessages[0];

    const foldsWorkAfterAnswer =
      terminalMessage !== undefined &&
      item.sourceMessages.some(
        (message) => message.sourceSeqStart > terminalMessage.sourceSeqEnd,
      );

    const spansUngroupableMessage = ungroupableSeqStarts.some(
      (seq) => seq > sourceSeqStart && seq < sourceSeqEnd,
    );

    if (foldsWorkAfterAnswer || spansUngroupableMessage) {
      sourceSeqEnd = Math.max(sourceSeqEnd, turn.sourceSeqEnd);
    }

    const suffix = item.segmentIndex === null ? "" : `:${item.segmentIndex}`;
    plan.push({
      kind: "summary",
      row: {
        id: `${rowIdPrefix}${turn.threadId}:${turn.turnId}:turn${suffix}`,
        threadId: turn.threadId,
        turnId: turn.turnId,
        sourceSeqStart,
        sourceSeqEnd,
        startedAt: item.startedAt,
        createdAt,
        kind: "turn",
        status: turn.status,
        summaryCount: item.summaryCount,
        activity: summarizeTurnActivity(item.sourceMessages, workspaceRoot),
        completedAt,
        children: null,
      },
      messages: item.sourceMessages,
    });
  }

  plan.push(
    ...terminalMessages.map((message, index) =>
      index === 0
        ? terminalMessagePlan(message, turn.gitActivity)
        : messagePlan(message),
    ),
    ...trailingMessages.map(messagePlan),
  );

  return plan;
}

export function planTimelineRows(
  projection: EventProjection,
  completedTurnDisplay: CompletedTurnDisplay,
  rowIdPrefix: string,
  workspaceRoot: string | null,
): TimelineRowPlan[] {
  return projection.entries.flatMap((entry) =>
    entry.kind === "projected-message"
      ? [messagePlan(entry.message)]
      : planTurn(entry.turn, completedTurnDisplay, rowIdPrefix, workspaceRoot),
  );
}

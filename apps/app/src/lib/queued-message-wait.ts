import {
  SERVER_UPDATE_WAIT_COPY,
  type QueuedMessagePayload,
  type QueuedMessageWaitingOn,
  type ThreadQueuedMessage,
  type ThreadStatus,
} from "@omnyo/domain";
import type { IconName } from "@omnyo/shared-ui/icon";
import { formatScheduledTime } from "@/lib/relative-time";

const MINUTE_MS = 60 * 1000;

const HOUR_MS = 60 * MINUTE_MS;

const DAY_MS = 24 * HOUR_MS;

export function projectQueuedMessagesForUpdate({
  queuedMessages,
  threadStatus,
  newTurnsPausedForUpdate,
}: {
  queuedMessages: readonly ThreadQueuedMessage[];
  threadStatus: ThreadStatus;
  newTurnsPausedForUpdate: boolean;
}): readonly ThreadQueuedMessage[] {
  if (
    !newTurnsPausedForUpdate ||
    (threadStatus !== "idle" &&
      threadStatus !== "pending" &&
      threadStatus !== "error")
  )
    return queuedMessages;

  return queuedMessages.map((message) =>
    message.waitingOn?.kind === "server-update"
      ? message
      : { ...message, waitingOn: { kind: "server-update" } },
  );
}

export function formatQueuedMessageCountdown(
  remainingMs: number,
): string | null {
  if (remainingMs <= 0) return null;

  if (remainingMs < MINUTE_MS) {
    return `in ${Math.ceil(remainingMs / 1000)}s`;
  }

  if (remainingMs < HOUR_MS) {
    return `in ${Math.floor(remainingMs / MINUTE_MS)}m`;
  }

  if (remainingMs < DAY_MS) {
    return `in ${Math.floor(remainingMs / HOUR_MS)}h`;
  }

  return `in ${Math.floor(remainingMs / DAY_MS)}d`;
}

export function isQueuedMessageSendNowAllowed({
  waitingOn,
  failureReason,
}: {
  waitingOn: QueuedMessageWaitingOn | null;
  failureReason: string | null;
}): boolean {
  if (waitingOn?.kind === "server-update") return false;

  if (failureReason !== null) return true;

  if (waitingOn === null) return true;

  switch (waitingOn.kind) {
    case "provisioning":
    case "host-offline":
    case "host-away":
    case "interaction":
    case "turn-starting":
      return false;
    case "stopping":
      return false;
    case "time":
    case "plugin":
    case "thread-busy":
    case "superseded":
      return true;
  }
}

export function queuedMessageHasWaitLine(args: {
  failureReason: string | null;
  payload: QueuedMessagePayload;
  waitingOn: QueuedMessageWaitingOn | null;
}): boolean {
  if (args.failureReason !== null) return true;

  if (args.payload.kind === "retry") return true;

  if (args.waitingOn === null) return false;

  return args.waitingOn.kind !== "thread-busy";
}

export function queuedMessageWaitIcon(args: {
  failureReason: string | null;
  payload: QueuedMessagePayload;
  waitingOn: QueuedMessageWaitingOn | null;
}): IconName | null {
  if (args.waitingOn?.kind === "server-update")
    return args.payload.kind === "continuation" ? "Spinner" : "Download";

  if (args.failureReason !== null) return "AlertCircle";

  if (args.waitingOn?.kind === "superseded") return "AlertCircle";

  if (args.payload.kind === "retry") return "RotateCcw";

  if (args.waitingOn === null) return null;

  switch (args.waitingOn.kind) {
    case "thread-busy":
      return null;
    case "stopping":
    case "turn-starting":
      return "TimeSchedule";
    case "time":
      return "TimeSchedule";
    case "provisioning":
      return "Folder";
    case "host-offline":
      return "CloudOff";
    case "host-away":
      return "Pause";
    case "interaction":
      return "CircleQuestion";
    case "plugin":
      return null;
  }
}

export interface DescribeQueuedMessageWaitArgs {
  failureReason: string | null;
  now: number;
  payload: QueuedMessagePayload;
  pluginDisplayName: string | null;
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}

export function queuedMessageFallbackTitle(args: {
  createdAt: number;
  now: number;
  payload: QueuedMessagePayload;
}): string {
  if (args.payload.kind !== "retry") return "Queued message";

  return `Retry failed turn from ${formatScheduledTime({
    now: args.now,
    timestamp: args.createdAt,
  })}`;
}

type QueuedMessageSourceFields = Pick<
  ThreadQueuedMessage,
  "initiator" | "messageSource"
>;

function isSystemScript(
  message: QueuedMessageSourceFields,
  label: string,
): boolean {
  return (
    message.initiator === "system" &&
    message.messageSource?.kind === "script" &&
    message.messageSource.label === label
  );
}

export function isQueuedWaitWakeUp(
  message: QueuedMessageSourceFields,
): boolean {
  return isSystemScript(message, "Wait");
}

export function isQueuedInboxNotice(
  message: QueuedMessageSourceFields,
): boolean {
  return isSystemScript(message, "Inbox");
}

export function queuedMessageSystemTitle(
  message: QueuedMessageSourceFields &
    Pick<ThreadQueuedMessage, "content" | "payload" | "waitingOn">,
): string | null {
  if (message.payload.kind === "retry") return null;

  if (message.payload.kind === "continuation")
    return message.waitingOn?.kind === "server-update"
      ? SERVER_UPDATE_WAIT_COPY.continuationTitle
      : "Continue this turn";

  if (isQueuedWaitWakeUp(message)) return "Wait check-in";

  return message.content.length > 0 &&
    message.content.every((chunk) => chunk.visibility === "agent-only")
    ? "Message for the agent"
    : null;
}

function normalizedReason(reason: string): string {
  return reason.trim().toLowerCase();
}

export function describeQueuedMessageWait(
  args: DescribeQueuedMessageWaitArgs,
): string | null {
  if (args.waitingOn?.kind === "server-update")
    return args.payload.kind === "continuation"
      ? SERVER_UPDATE_WAIT_COPY.continuationDetail
      : SERVER_UPDATE_WAIT_COPY.queuedDetail;

  if (args.failureReason !== null) return args.failureReason;

  if (args.waitingOn?.kind === "superseded")
    return "Not sent · a newer message was sent after it";

  if (args.payload.kind === "retry") {
    const parts: string[] = [args.payload.reason];

    if (args.waitingOn?.kind === "plugin") {
      const holdReason = args.waitingOn.reason;
      const retryReason = normalizedReason(args.payload.reason);
      const heldBecause = normalizedReason(holdReason);

      if (heldBecause.startsWith(retryReason) && heldBecause !== retryReason) {
        parts[0] = holdReason;
      }

      parts.push(
        `held by ${args.pluginDisplayName ?? args.waitingOn.pluginId}`,
      );

      if (
        !heldBecause.startsWith(retryReason) &&
        !retryReason.startsWith(heldBecause)
      ) {
        parts.push(holdReason);
      }
    }

    if (args.sendAt !== null) {
      parts.push(
        `retrying at ${formatScheduledTime({ now: args.now, timestamp: args.sendAt })}`,
      );
    }

    parts.push(`attempt ${args.payload.attempt}`);

    return parts.join(" · ");
  }

  if (!queuedMessageHasWaitLine(args)) return null;

  if (args.waitingOn === null) return null;

  switch (args.waitingOn.kind) {
    case "thread-busy":
      return null;
    case "turn-starting":
      return "Waiting for turn to start";
    case "stopping":
      return "Sending when the thread stops";
    case "time":
      return args.sendAt === null
        ? "Scheduled"
        : `Scheduled for ${formatScheduledTime({ now: args.now, timestamp: args.sendAt })}`;
    case "provisioning":
      return "Waiting for workspace";
    case "host-offline":
      return `Waiting for ${args.waitingOn.hostName} to be ready`;
    case "host-away":
      return `Waiting while ${args.waitingOn.hostName} is Away`;
    case "interaction":
      return "Waiting for your reply";
    case "plugin":
      return `Held by ${args.pluginDisplayName ?? args.waitingOn.pluginId} · ${args.waitingOn.reason}`;
  }
}

export function queuedMessageCountdownInstant(args: {
  payload: QueuedMessagePayload;
  sendAt: number | null;
  waitingOn: QueuedMessageWaitingOn | null;
}): number | null {
  if (args.payload.kind === "retry") return null;

  if (args.waitingOn === null || args.waitingOn.kind !== "time") return null;

  return args.sendAt;
}

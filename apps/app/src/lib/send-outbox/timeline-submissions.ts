import type {
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type { PendingSentMessage } from "@/hooks/cache-owners/pending-sent-messages";
import { buildOptimisticUserMessageRow } from "@/hooks/cache-owners/optimistic-user-message";
import type { OutboxEntry } from "./send-outbox-entry";

const EMPTY: readonly PendingSentMessage[] = [];

export function isBackgroundSend(
  message: ThreadQueuedMessage,
  status: ThreadRuntimeDisplayStatus,
) {
  return (
    status === "idle" &&
    message.failureReason === null &&
    message.sendAt === null &&
    (message.waitingOn === null || message.waitingOn.kind === "thread-busy") &&
    message.content.some((part) => part.submissionId !== undefined)
  );
}

export function pendingTimelineSubmissions(
  threadId: string,
  entries: readonly OutboxEntry[],
  queue: readonly ThreadQueuedMessage[],
): readonly PendingSentMessage[] {
  if (!entries.length && !queue.length) return EMPTY;
  const rows = new Map<string, PendingSentMessage>();

  function add(
    submissionId: string,
    createdAt: number,
    input: ThreadQueuedMessage["content"],
  ) {
    const row = buildOptimisticUserMessageRow({
      submissionId,
      createdAt,
      input,
      clientRequestId: null,
      mode: "auto",
      threadId,
      threadStatus: null,
    });

    rows.set(row.id, { row, accepted: false, supersededAtSeq: null });
  }

  for (const entry of entries) {
    if (
      entry.action.kind !== "thread-message" ||
      !("threadId" in entry.action.target) ||
      entry.action.target.threadId !== threadId ||
      entry.state.kind !== "waiting"
    )
      continue;
    const input = entry.action.message.input;

    if (!input.some((part) => part.submissionId === entry.submissionId))
      continue;

    const paths = new Map(
      entry.attachments.map((file) => [file.token, file.uploadedPath]),
    );

    add(
      entry.submissionId,
      entry.createdAt,
      input.map((part) => {
        if (part.type !== "localImage" && part.type !== "localFile")
          return part;

        return { ...part, path: paths.get(part.path) ?? part.path };
      }),
    );
  }

  for (const message of queue) {
    const id = message.content.find((part) => part.submissionId)?.submissionId;

    if (id && message.threadId === threadId && !message.failureReason)
      add(id, message.createdAt, message.content);
  }

  if (rows.size === 0) return EMPTY;

  return [...rows.values()].sort((a, b) => a.row.createdAt - b.row.createdAt);
}

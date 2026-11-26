import { shouldQueueFollowUpMessage } from "@omnyo/client-core";
import type {
  PromptInput,
  ThreadQueuedMessage,
  ThreadRuntimeDisplayStatus,
} from "@omnyo/domain";
import type { PendingSentMessage } from "@/hooks/cache-owners/pending-sent-messages";
import { buildOptimisticUserMessageRow } from "@/hooks/cache-owners/optimistic-user-message";
import type { OutboxEntry } from "./send-outbox-entry";
import type { StagingFollowUp } from "./staging-follow-ups";

const EMPTY: readonly PendingSentMessage[] = [];

const NO_QUEUED_MESSAGES: readonly ThreadQueuedMessage[] = [];

type ThreadMessageOutboxEntry = OutboxEntry & {
  action: Extract<OutboxEntry["action"], { kind: "thread-message" }>;
};

interface PendingFollowUp {
  submissionId: string;
  createdAt: number;
  input: PromptInput[];
  message: Partial<
    Pick<
      ThreadQueuedMessage,
      "model" | "reasoningLevel" | "permissionMode" | "serviceTier"
    >
  >;
}

export function followUpShowsInChat(
  status: ThreadRuntimeDisplayStatus | undefined,
): boolean {
  return status === undefined || !shouldQueueFollowUpMessage(status);
}

export function queuedMessageShowsInChat(
  message: ThreadQueuedMessage,
  status: ThreadRuntimeDisplayStatus | undefined,
): boolean {
  return (
    status === "idle" &&
    message.failureReason === null &&
    message.sendAt === null &&
    (message.waitingOn === null || message.waitingOn.kind === "thread-busy") &&
    message.content.some((part) => part.submissionId !== undefined)
  );
}

function isWaitingFollowUp(
  entry: OutboxEntry,
  threadId: string,
): entry is ThreadMessageOutboxEntry {
  return (
    entry.action.kind === "thread-message" &&
    "threadId" in entry.action.target &&
    entry.action.target.threadId === threadId &&
    entry.state.kind === "waiting" &&
    entry.action.message.input.some(
      (part) => part.submissionId === entry.submissionId,
    )
  );
}

export function outboxEntryPlacement(
  entry: OutboxEntry,
  threadId: string,
  status: ThreadRuntimeDisplayStatus | undefined,
): "chat" | "queue" | "card" {
  if (!isWaitingFollowUp(entry, threadId)) return "card";

  return followUpShowsInChat(status) ? "chat" : "queue";
}

function pendingFollowUps(
  threadId: string,
  staging: readonly StagingFollowUp[],
  entries: readonly OutboxEntry[],
): PendingFollowUp[] {
  const followUps = new Map<string, PendingFollowUp>();

  for (const item of staging)
    if (item.threadId === threadId)
      followUps.set(item.submissionId, {
        submissionId: item.submissionId,
        createdAt: item.createdAt,
        input: item.input,
        message: {},
      });

  for (const entry of entries) {
    if (!isWaitingFollowUp(entry, threadId)) continue;
    const { input, ...message } = entry.action.message;

    const paths = new Map(
      entry.attachments.map((file) => [file.token, file.uploadedPath]),
    );

    followUps.set(entry.submissionId, {
      submissionId: entry.submissionId,
      createdAt: entry.createdAt,
      input: input.map((part) => {
        if (part.type !== "localImage" && part.type !== "localFile")
          return part;

        return { ...part, path: paths.get(part.path) ?? part.path };
      }),
      message,
    });
  }

  return [...followUps.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function submissionIdOf(message: ThreadQueuedMessage): string | undefined {
  return message.content.find((part) => part.submissionId)?.submissionId;
}

export function pendingTimelineSubmissions(
  threadId: string,
  status: ThreadRuntimeDisplayStatus | undefined,
  staging: readonly StagingFollowUp[],
  entries: readonly OutboxEntry[],
  queue: readonly ThreadQueuedMessage[],
): readonly PendingSentMessage[] {
  if (!staging.length && !entries.length && !queue.length) return EMPTY;
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

  if (followUpShowsInChat(status))
    for (const followUp of pendingFollowUps(threadId, staging, entries))
      add(followUp.submissionId, followUp.createdAt, followUp.input);

  for (const message of queue) {
    const id = submissionIdOf(message);

    if (
      id &&
      message.threadId === threadId &&
      queuedMessageShowsInChat(message, status)
    )
      add(id, message.createdAt, message.content);
  }

  if (rows.size === 0) return EMPTY;

  return [...rows.values()].sort((a, b) => a.row.createdAt - b.row.createdAt);
}

export function pendingQueueFollowUps(
  threadId: string,
  status: ThreadRuntimeDisplayStatus | undefined,
  staging: readonly StagingFollowUp[],
  entries: readonly OutboxEntry[],
  queue: readonly ThreadQueuedMessage[],
): readonly ThreadQueuedMessage[] {
  if (followUpShowsInChat(status) || (!staging.length && !entries.length))
    return NO_QUEUED_MESSAGES;
  const queued = new Set(queue.map(submissionIdOf));

  const messages = pendingFollowUps(threadId, staging, entries)
    .filter((followUp) => !queued.has(followUp.submissionId))
    .map((followUp): ThreadQueuedMessage => ({
      id: `optimistic-queued-${followUp.submissionId}`,
      origin: null,
      originPluginId: null,
      initiator: "user",
      senderThreadId: null,
      threadId,
      content: followUp.input.map((part) => ({
        ...part,
        submissionId: followUp.submissionId,
      })),
      model: followUp.message.model ?? "pending",
      reasoningLevel: followUp.message.reasoningLevel ?? "medium",
      permissionMode: followUp.message.permissionMode ?? "auto",
      serviceTier: followUp.message.serviceTier ?? "default",
      groupWithNext: false,
      sendAt: null,
      waitingOn: { kind: "thread-busy" },
      failureReason: null,
      payload: { kind: "inline" },
      editable: false,
      createdAt: followUp.createdAt,
      updatedAt: followUp.createdAt,
    }));

  return messages.length === 0 ? NO_QUEUED_MESSAGES : messages;
}

export function queuedSubmissionIds(
  threadId: string,
  status: ThreadRuntimeDisplayStatus | undefined,
  staging: readonly StagingFollowUp[],
  entries: readonly OutboxEntry[],
  queue: readonly ThreadQueuedMessage[],
): ReadonlySet<string> {
  const ids = new Set<string>();

  for (const message of [
    ...queue.filter(
      (message) =>
        message.threadId === threadId &&
        !queuedMessageShowsInChat(message, status),
    ),
    ...pendingQueueFollowUps(threadId, status, staging, entries, queue),
  ]) {
    const id = submissionIdOf(message);

    if (id) ids.add(id);
  }

  return ids;
}

import type {
  QueuedMessageSystemNotice,
  ThreadMessageSource,
} from "@omnyo/domain";

export function messageSourceNotice(
  source: ThreadMessageSource | undefined,
  senderThreadId: string | null,
): QueuedMessageSystemNotice | null {
  if (source === undefined || source.kind === "user" || senderThreadId !== null)
    return null;

  return {
    kind: "external-message",
    subject: { kind: "message-source", source },
  };
}

export function messageSourceFromNotice(
  notice: QueuedMessageSystemNotice | null,
): ThreadMessageSource | undefined {
  return notice?.kind === "external-message" &&
    notice.subject?.kind === "message-source"
    ? notice.subject.source
    : undefined;
}
